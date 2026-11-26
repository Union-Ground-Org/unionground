import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { connectLocal } from './local-lifecycle-contention.mjs';

// Four independently authenticated SQL sessions, through the real Analytics
// RPC and its audit insert. Keep completed reads open: another reader must be
// admitted before those transactions end, while a graph writer must not be.
export async function runReaderScenario(url, { baseline = false, rpc = 'get_organization_analytics_workspace' } = {}) {
  assert(['get_organization_analytics_workspace', 'get_organization_analytics_snapshot', 'get_organization_coordination_extensions'].includes(rpc));
  const setup = await connectLocal(url, 'reader-fixture');
  const readers = [];
  const writer = await connectLocal(url, 'reader-writer');
  const organization = randomUUID();
  const users = Array.from({ length: 4 }, () => randomUUID());
  const sessions = users.map(() => randomUUID());
  const chapter = `readers-${organization}`;
  const claims = users.map((user, i) => JSON.stringify({ sub: user, session_id: sessions[i], role: 'authenticated', aal: 'aal2' }));
  const report = { workers: 4, rpc, reads: [] };
  try {
    await setup.query('begin');
    await setup.query('insert into public.organizations(id,slug,name) values($1,$2,$2)', [organization, chapter]);
    await setup.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values($1,$1,$1,'proof',$2,9900)", [chapter, organization]);
    for (const [i, user] of users.entries()) {
    await setup.query('insert into auth.users(id,email) values($1,$2)', [user, `${user}@example.invalid`]);
    await setup.query('update public.member_profiles set chapter_id=$2 where id=$1', [user, chapter]);
    await setup.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [organization, user]);
    await setup.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
    await setup.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'admin')", [organization, user]);
    await setup.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [sessions[i], user]);
    await setup.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), user]);
    }
    await setup.query('commit');
    for (let i = 0; i < 4; i += 1) {
      const reader = await connectLocal(url, `reader-${i}`);
      readers.push(reader);
      await reader.query('begin');
      await reader.query("select set_config('request.jwt.claims',$1,true)", [claims[i]]);
      await reader.query('set local role authenticated');
      await reader.query("set local lock_timeout='200ms'");
    }
    report.reads = await Promise.all(readers.map(async (reader, i) => {
      const start = performance.now();
      try {
        const result = await reader.query(`select public.${rpc}() as value`);
        assert.equal(result.rows[0].value.organizationId, organization);
        await reader.query('reset role');
        const locks = (await reader.query("select mode from pg_locks where pid=pg_backend_pid() and locktype='advisory' and granted order by mode")).rows.map(row => row.mode);
        if (!baseline) assert.deepEqual(locks, ['ShareLock', 'ShareLock'], 'no hidden exclusive gate in the reader call graph');
        if (rpc.startsWith('get_organization_analytics_')) {
          const audit = await reader.query('select count(*)::int n from public.organization_audit_events where organization_id=$1 and actor_user_id=$2', [organization, users[i]]);
          assert.equal(audit.rows[0].n, 1, 'each successful Analytics read must retain its audit insert');
        }
        return { code: 'ok', ms: Math.round(performance.now() - start), locks };
      } catch (error) {
        return { code: error.code ?? error.message, ms: Math.round(performance.now() - start) };
      }
    }));
    const successful = report.reads.filter(read => read.code === 'ok').length;
    assert.equal(successful, baseline ? 1 : 4, JSON.stringify(report));
    assert.equal(report.reads.filter(read => read.code === '55P03').length, baseline ? 3 : 0);
    // Successful read transactions remain open here, including their audit
    // records. Exclusive writers must still wait, not interleave mutations.
    await writer.query("set lock_timeout='200ms'");
    await assert.rejects(writer.query('delete from auth.users where id=$1', [users[0]]), { code: '55P03' });
    assert.equal((await setup.query('select count(*)::int n from auth.users where id=any($1::uuid[])', [users])).rows[0].n, 4);
    report.writerBlocked = true;
    await Promise.all(readers.map(reader => reader.query('rollback')));
    await writer.query('select private.lock_case_graph(array[]::uuid[],array[]::uuid[])');
    report.writerRecovered = true;
    return report;
  } finally {
    await Promise.all(readers.map(reader => reader.query('rollback').catch(() => {})));
    await writer.query('rollback');
    try {
      await setup.query('rollback');
      await setup.query("update public.organizations set status='archived' where id=$1", [organization]);
      await setup.query('delete from auth.users where id=any($1::uuid[])', [users]);
      await setup.query('delete from private.dues_financial_identity_selections where organization_id=$1', [organization]);
      await setup.query('delete from public.dues_member_subjects where organization_id=$1', [organization]);
      await setup.query('delete from public.chapters where id=$1', [chapter]);
      await setup.query('delete from public.organizations where id=$1', [organization]);
    } finally {
      await Promise.all([...readers, writer, setup].map(client => client.end()));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runReaderScenario(process.env.SUPABASE_DB_URL, {
    baseline: process.argv.includes('--baseline'),
  }), null, 2));
}
