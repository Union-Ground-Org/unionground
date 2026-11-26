import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { assertDisposableProofUrl } from '../../scripts/run-required-db-proofs.mjs';

// The local SQL contention harness the lifecycle DB proofs share.

// Each retry rejoins a shorter queue behind the gate; a writer still busy after
// this many attempts fails the scenario.
const RECOVERY_ATTEMPTS = 4;

export async function connectLocal(url, label) {
  const client = new pg.Client({
    connectionString: assertDisposableProofUrl(url),
    application_name: `local-lifecycle-${label}`,
    connectionTimeoutMillis: 5000,
    ssl: false,
  });
  await client.connect();
  await client.query("set statement_timeout='8s'");
  await client.query("set lock_timeout='0'");
  return client;
}

// This is a SQL contention proof, not a sign-in/HTTP capacity benchmark.
// Run only on an owned disposable stack: it commits isolated synthetic rows
// so independent transactions can see them, then deletes exactly those rows.
export async function runContentionScenario(url, { expectBound = true } = {}) {
  const setup = await connectLocal(url, 'fixture');
  const holder = await connectLocal(url, 'holder');
  const clients = [];
  const orgs = [randomUUID(), randomUUID()];
  const users = [randomUUID(), randomUUID()];
  const sessions = [randomUUID(), randomUUID()];
  const claims = users.map((sub, i) => JSON.stringify({ sub, session_id: sessions[i], role: 'authenticated', aal: 'aal2' }));
  const chapters = orgs.map(id => `lock-proof-${id}`);
  const tasks = Array.from({ length: 30 }, () => randomUUID());
  const report = { sessions: 30, organizations: 2, blocked: [], recovered: [], normal: [] };
  try {
    await setup.query('begin');
    for (let i = 0; i < orgs.length; i += 1) {
      await setup.query("select set_config('request.jwt.claims','{}',true)");
      await setup.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{\"full_name\":\"Local lock proof\"}')", [users[i], `${users[i]}@example.invalid`]);
      await setup.query('insert into public.organizations(id,slug,name) values($1,$2,$2)', [orgs[i], chapters[i]]);
      await setup.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values($1,$1,$1,'proof',$2,9900)", [chapters[i], orgs[i]]);
      await setup.query('update public.member_profiles set chapter_id=$2 where id=$1', [users[i], chapters[i]]);
      await setup.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [orgs[i], users[i]]);
      await setup.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [users[i], chapters[i]]);
      await setup.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'admin')", [orgs[i], users[i]]);
      await setup.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [sessions[i], users[i]]);
      await setup.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), users[i]]);
      await setup.query("select set_config('request.jwt.claims',$1,true)", [claims[i]]);
      await setup.query("insert into public.chapter_workstreams(chapter_id,name,created_by) values($1,'General',$2)", [chapters[i], users[i]]);
    }
    for (let i = 0; i < tasks.length; i += 1) {
      await setup.query("select set_config('request.jwt.claims',$1,true)", [claims[i % 2]]);
      await setup.query("insert into public.chapter_tasks(id,chapter_id,title,workstream) values($1,$2,'Before contention','General')", [tasks[i], chapters[i % 2]]);
    }
    await setup.query('commit');
    // Sequential connection setup avoids measuring connection establishment as
    // lock latency. Every write below starts from the same Promise.all barrier.
    for (let i = 0; i < tasks.length; i += 1) {
      const client = await connectLocal(url, `writer-${i}`);
      clients.push(client);
      await client.query("select set_config('request.jwt.claims',$1,false)", [claims[i % 2]]);
      await client.query('set role authenticated');
    }
    await holder.query('begin');
    await holder.query('select private.lock_case_graph(array[]::uuid[],array[]::uuid[])');
    const write = async (client, i, title) => {
      const start = performance.now();
      try {
        // Clients edit a task through this RPC since 20261103183000 revoked
        // the direct update; its first statement enters the same case-graph
        // gate the direct update's trigger did, so it is the call that waits.
        const result = await client.query("select id from public.update_chapter_task_fields($1, pg_catalog.jsonb_build_object('title', $2::text, 'due_date', current_date + 1, 'assignee_id', $3::uuid))", [tasks[i], title, users[i % 2]]);
        return { code: 'ok', rows: result.rowCount, ms: Math.round(performance.now() - start) };
      } catch (error) {
        return { code: error.code, ms: Math.round(performance.now() - start) };
      }
    };
    report.blocked = await Promise.all(clients.map((client, i) => write(client, i, 'Must not save')));
    await holder.query('rollback');
    const unchanged = await setup.query('select count(*)::int n from public.chapter_tasks where id=any($1::uuid[]) and title=$2 and due_date is null and assignee_id is null', [tasks, 'Before contention']);
    assert.equal(unchanged.rows[0].n, 30, 'blocked writes must leave every task unchanged');
    // Release admits every writer, but the gate stays global and exclusive: the
    // 30 writers pass it one at a time, each still under the three-second
    // admission bound. On a loaded runner the end of that queue can get the
    // bounded busy error before its turn (Main run 37804220361: 2 to 7 of 30),
    // which is the designed response, not a lost write. A writer therefore
    // tries again on 55P03 alone, at most RECOVERY_ATTEMPTS times; any other
    // error ends its attempts, and every write must still save.
    const recover = async (client, i) => {
      const attempts = [];
      do attempts.push(await write(client, i, 'Saved after release'));
      while (attempts.at(-1).code === '55P03' && attempts.length < RECOVERY_ATTEMPTS);
      return { ...attempts.at(-1), attempts: attempts.length, busy: attempts.slice(0, -1).map(row => row.ms) };
    };
    report.recovered = await Promise.all(clients.map(recover));
    assert(report.recovered.every(row => row.code === 'ok' && row.rows === 1), `all 30 writes must recover after release: ${JSON.stringify(report.recovered)}`);
    const saved = await setup.query('select count(*)::int n from public.chapter_tasks where id=any($1::uuid[]) and title=$2 and due_date=current_date+1 and assignee_id=created_by', [tasks, 'Saved after release']);
    assert.equal(saved.rows[0].n, 30, 'all recovered title and date changes must persist');
    // A simultaneous burst is not the normal-load single-edit latency target.
    // Retain every burst measurement, then check isolated edits on both tenants.
    for (let i = 0; i < clients.length; i += 1) report.normal.push(await write(clients[i], i, 'Normal load saved'));
    assert(report.normal.every(row => row.code === 'ok' && row.rows === 1), 'all normal-load edits must save');
    if (expectBound) {
      assert(report.blocked.every(row => row.code === '55P03' && row.ms >= 2500 && row.ms < 5000), 'all waiters must fail with bounded 55P03, never 57014');
      assert(report.recovered.every(row => row.busy.every(ms => ms >= 2500 && ms < 5000)), 'a recovery attempt may only fail with the bounded 55P03');
      assert(report.normal.every(row => row.ms < 1000), 'normal task writes must complete within one second');
    }
    return report;
  } finally {
    await holder.query('rollback').catch(() => {});
    await Promise.all(clients.map(client => client.end()));
    await holder.end();
    await setup.query('rollback');
    try {
      await setup.query('begin');
      await setup.query('delete from public.chapter_tasks where id=any($1::uuid[])', [tasks]);
      // Retire only the synthetic organizations before removing their last
      // admins; never disable the production last-admin deletion guard.
      await setup.query("update public.organizations set status='archived' where id=any($1::uuid[])", [orgs]);
      await setup.query('delete from auth.users where id=any($1::uuid[])', [users]);
      await setup.query('delete from public.chapter_workstreams where chapter_id=any($1::text[])', [chapters]);
      await setup.query('delete from private.chapter_task_number_counters where chapter_id=any($1::text[])', [chapters]);
      await setup.query('delete from private.dues_financial_identity_selections where organization_id=any($1::uuid[])', [orgs]);
      await setup.query('delete from public.dues_member_subjects where organization_id=any($1::uuid[])', [orgs]);
      await setup.query('delete from public.chapters where id=any($1::text[])', [chapters]);
      await setup.query('delete from public.organizations where id=any($1::uuid[])', [orgs]);
      await setup.query('commit');
    } finally { await setup.end(); }
  }
}
