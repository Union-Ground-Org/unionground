// @vitest-environment node
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';
import { runnerTimeout } from '../scripts/lib/runner-timeout.mjs';
import { loadMigrationSql } from './helpers/migration.js';
import { legacySeedOrganization, retiredSeedFunctionDefinition } from './helpers/retired-seed-upgrade-fixture.mjs';

const manifest = JSON.parse(readFileSync(new URL('../config/retired-pre-bot-seeds.json', import.meta.url)));
const placeholders = JSON.parse(readFileSync(new URL('../config/retired-pre-bot-placeholders.json', import.meta.url)));
const migration = loadMigrationSql('retire_pre_bot_seed_functions');
const identity = (signature) => signature.replace(/\b(?:in\s+)?p_\w+\s+/g, '');
// Budgets are sized to the runner (scripts/lib/runner-timeout.mjs): three
// cases replay the whole retirement migration, its body and then the
// catalog-wide lifecycle inventory scan, and on GitHub's 2-vCPU ubuntu-24.04
// runner the body and scan together passed 90 s (merge group run 43149446680,
// shard 2). A timed-out case left its migration running on the shared client,
// which then failed the two concurrency cases after it.
const CASE_MS = runnerTimeout(90_000);
// How long a concurrency case waits for a session to show up as blocked.
const until = async (blocked, message, waitMs = runnerTimeout(2_000)) => {
  for (const deadline = Date.now() + waitMs; Date.now() < deadline;) {
    if (await blocked()) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (message) throw new Error(message);
  return false;
};

describe('pre-bot retirement contract', () => {
  it('keeps the complete inventory, explicit restrict drops and real security guards', () => {
    expect(manifest.functions).toHaveLength(144);
    expect(migration).not.toMatch(/drop\s+(?:function|table)[^;]*cascade/i);
    for (const signature of manifest.functions) expect(migration).toContain(`drop function if exists ${signature} restrict;`);
    expect(migration).toContain('private.account_lifecycle_is_nested_auth_detachment');
    expect(migration).toContain('private.casework_staff_can_access(old.id)');
    expect(migration).toContain('sensitive-data-encryption-required');
    expect(migration).toContain('sensitive-data-identity-immutable');
  });
});

// Every connection a case opens carries this name, and the case's teardown
// ends all of them through a separate connection: a
// Vitest time-out does not cancel an in-flight pg query, so a timed-out case's
// migration, open transaction or locks must not reach the next case.
const APPLICATION = 'pre-bot-retirement-proof';
const connection = async () => {
  const db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: APPLICATION });
  // A terminated backend reaches an idle client as an 'error' event.
  db.on('error', () => {});
  await db.connect();
  return db;
};
// Terminating a backend rolls back only its uncommitted work. A case that
// commits a fixture registers the exact statements that remove it, and they
// run here on the cleanup connection after the case's backends are gone, so a
// case that times out after its committed setup cannot leave the fixture
// behind. Each statement is idempotent; a case that
// finished normally has already run the same cleanup itself.
const endCaseConnections = async (caseClient, committedFixtures = []) => {
  const cleanup = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: `${APPLICATION}-cleanup` });
  await cleanup.connect();
  try {
    await cleanup.query('select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1 and pid <> pg_backend_pid()', [APPLICATION]);
    await until(async () => (await cleanup.query('select count(*)::integer as n from pg_stat_activity where application_name = $1', [APPLICATION])).rows[0].n === 0,
      'A case connection outlived its teardown', runnerTimeout(5_000));
    for (const [sql, params] of committedFixtures.splice(0)) await cleanup.query(sql, params);
  } finally {
    await cleanup.end();
  }
  await caseClient?.end().catch(() => {});
};

const database = process.env.SUPABASE_DB_URL ? describe : describe.skip;
database('pre-bot retirement on a fully replayed disposable database', () => {
  // One connection per case, ended with everything else the case opened.
  beforeEach(async (context) => { context.db = await connection(); context.committedFixtures = []; });
  afterEach(async (context) => { await endCaseConnections(context.db, context.committedFixtures); });

  it('ends a case connection, its leftover query and its locks before the next case starts', async ({ db: client }) => {
    // Stands in for a timed-out case: a second connection holding a lock and
    // still running a query when the case ends.
    const leftover = await connection();
    const pid = (await leftover.query('select pg_backend_pid() as pid')).rows[0].pid;
    await leftover.query('select pg_advisory_lock(509, 7099)');
    const running = leftover.query('select pg_sleep(600)').then(() => 'finished', () => 'ended');
    await until(async () => (await client.query("select count(*)::integer as n from pg_stat_activity where pid = $1 and state = 'active'", [pid])).rows[0].n === 1,
      'The leftover query did not start');
    await endCaseConnections(client);
    expect(await running).toBe('ended');
    const next = await connection();
    try {
      expect((await next.query('select count(*)::integer as n from pg_stat_activity where pid = $1', [pid])).rows[0].n).toBe(0);
      expect((await next.query('select pg_try_advisory_lock(509, 7099) as free')).rows[0].free).toBe(true);
    } finally {
      await next.end();
    }
  }, CASE_MS);

  it('removes a committed fixture whose case was ended while a query was still running', async ({ db: client, committedFixtures }) => {
    const user = randomUUID();
    // Registered before the first insert, so the shared teardown removes the
    // fixture even if this case fails before its own explicit teardown below.
    committedFixtures.push(['delete from auth.users where id=$1', [user]]);
    await client.query(`insert into auth.users(id,email,raw_app_meta_data) values ($1,'committed-fixture-cleanup@example.invalid','{}')`, [user]);
    await client.query('insert into auth.sessions(id,user_id) values($1,$2)', [randomUUID(), user]);
    // Stands in for a case that timed out after its committed setup: its own
    // connection is still running a query when the teardown ends it.
    const pid = (await client.query('select pg_backend_pid() as pid')).rows[0].pid;
    const running = client.query('select pg_sleep(600)').then(() => 'finished', () => 'ended');
    const next = await connection();
    try {
      await until(async () => (await next.query("select count(*)::integer as n from pg_stat_activity where pid = $1 and state = 'active'", [pid])).rows[0].n === 1,
        'The running query did not start');
      await endCaseConnections(client, committedFixtures);
      expect(await running).toBe('ended');
      expect(committedFixtures).toEqual([]);
    } finally {
      await next.end().catch(() => {});
    }
    const after = await connection();
    try {
      expect((await after.query('select count(*)::integer as n from auth.users where id=$1', [user])).rows[0].n).toBe(0);
      expect((await after.query('select count(*)::integer as n from auth.sessions where user_id=$1', [user])).rows[0].n).toBe(0);
    } finally {
      await after.end();
    }
  }, CASE_MS);

  it('has no retired overload, seed job or seed trigger after replay', async ({ db: client }) => {
    const signatures = manifest.functions.map(identity);
    const absent = await client.query('select sig from unnest($1::text[]) sig where to_regprocedure(sig) is not null', [signatures]);
    expect(absent.rows).toEqual([]);
    const names = manifest.functions.map((sig) => sig.split('(')[0]);
    const overloads = await client.query(`select n.nspname || '.' || p.proname as name
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname || '.' || p.proname = any($1::text[])`, [names]);
    expect(overloads.rows).toEqual([]);
    const remainingBodies = await client.query(`select n.nspname || '.' || p.proname as name, p.prosrc as body
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','private')`);
    const callers = remainingBodies.rows.flatMap(({ name, body }) =>
      [...new Set(names)].filter(retired => body.includes(`${retired}(`)).map(retired => ({ name, retired })));
    expect(callers).toEqual([]);
    const jobs = await client.query("select jobname from cron.job where jobname in ('demo-seed-voice-quarterly-refresh','demo-seed-analytics-health-rotate')");
    expect(jobs.rows).toEqual([]);
    const triggers = await client.query(`select t.tgname from pg_trigger t join pg_proc p on p.oid=t.tgfoid
      join pg_namespace n on n.oid=p.pronamespace where not t.tgisinternal
      and n.nspname || '.' || p.proname = any($1::text[])`, [manifest.triggerFunctions]);
    expect(triggers.rows).toEqual([]);
    expect((await client.query('select * from private.account_lifecycle_referential_action_trigger_issues()')).rows).toEqual([]);
    for (const row of placeholders) {
      // Predicates are reviewed, checked-in SQL, never user-supplied input.
      const result = await client.query(`select count(*)::integer as n from ${row.table} where ${row.predicate}`);
      expect(result.rows[0].n, `${row.table}/${row.row_id}`).toBe(0);
    }
    // The catalog-wide lifecycle inventory scan takes about 10 s; same budget as the other inventory cases.
  }, CASE_MS);

  it('refuses altered lifecycle review hashes rather than accepting unrelated drift', async ({ db: client }) => {
    await client.query('begin');
    try {
      await client.query(`update private.account_lifecycle_trigger_review set definition_hash=repeat('0',32)
        where kind='function' and schema_name='private' and table_name=''
          and object_name='guard_casework_restriction_update()'`);
      await expect(client.query(migration.replace(/\bbegin;\s*/i, '').replace(/commit;\s*$/i, '')))
        .rejects.toThrow('retained lifecycle review changed');
    } finally { await client.query('rollback'); }
  }, CASE_MS);

  it('does not erase an unrelated lifecycle review discrepancy', async ({ db: client }) => {
    await client.query('begin');
    try {
      await client.query(`insert into private.account_lifecycle_trigger_review
        (kind,schema_name,table_name,object_name,definition_hash)
        values ('function','private','','unrelated_retirement_probe()',repeat('0',32))`);
      await expect(client.query(migration.replace(/\bbegin;\s*/i, '').replace(/commit;\s*$/i, '')))
        .rejects.toThrow('unrelated lifecycle review drift');
    } finally { await client.query('rollback'); }
  }, CASE_MS);

  it('waits for the messaging gate before taking credential relation locks', async ({ db: client }) => {
    const locker = await connection();
    let pending;
    try {
      await client.query('begin');
      const targetPid = (await client.query('select pg_backend_pid() as pid')).rows[0].pid;
      await locker.query('begin; select private.lock_message_lifecycle()');
      const lockerPid = (await locker.query('select pg_backend_pid() as pid')).rows[0].pid;
      pending = client.query(migration.replace(/\bbegin;\s*/i, '').replace(/commit;\s*$/i, ''))
        .then(() => ({ passed: true }), error => ({ error }));
      const blocked = await until(async () =>
        (await locker.query('select $1::integer=any(pg_blocking_pids($2)) as blocked', [lockerPid, targetPid])).rows[0].blocked);
      expect(blocked, 'migration must first wait behind the messaging writer').toBe(true);
      await locker.query("set local statement_timeout='1s'");
      // A scheduler holding the gate must still be able to read credentials;
      // the old late acquisition deadlocked here against the migration's DDL.
      await locker.query('select count(*) from auth.users');
      await locker.query('commit');
      expect(await pending).toEqual({ passed: true });
    } finally {
      await locker.query('rollback');
      if (pending) await pending;
      await client.query('rollback');
      await locker.end();
    }
  }, CASE_MS);

  it('can reapply and remove an upgraded exact legacy fixture without touching a neighboring row', async ({ db: client }) => {
    await client.query('begin');
    try {
      const retired = randomUUID(), unrelated = randomUUID(), unmarked = randomUUID();
      const password = randomUUID();
      await client.query(`insert into auth.users(id,email,encrypted_password,raw_app_meta_data) values
        ($1,'darnell.foster@demo.example.com',extensions.crypt($4,extensions.gen_salt('bf',4)), '{"sample":true,"surface":"sample","sample_persona":"member"}'),
        ($2,'retirement-control@example.invalid',extensions.crypt($4,extensions.gen_salt('bf',4)), '{"sample":true,"surface":"sample","sample_persona":"member"}'),
        ($3,'sam.okafor@demo.example.com',extensions.crypt($4,extensions.gen_salt('bf',4)), '{}')`, [retired, unrelated, unmarked, password]);
      await client.query('insert into auth.sessions(id,user_id) values($1,$2),($3,$4)', [randomUUID(), retired, randomUUID(), unrelated]);
      await client.query('insert into auth.refresh_tokens(token,user_id) values($1,$2),($3,$4)', [randomUUID(), retired, randomUUID(), unrelated]);
      // This edition dropped every public.demo_* table (20261014010000).
      // The migration owns its transaction; remove only the outer delimiters
      // so this upgrade probe rolls back all of its deliberately staged rows.
      await client.query(migration.replace(/\bbegin;\s*/i, '').replace(/commit;\s*$/i, ''));
      const credentials = await client.query(`select id, encrypted_password = '' disabled, banned_until = 'infinity'::timestamptz banned,
        (select count(*)::int from auth.sessions s where s.user_id=u.id) sessions,
        (select count(*)::int from auth.refresh_tokens t where t.user_id=u.id::text) tokens
        from auth.users u where id=any($1::uuid[])`, [[retired, unrelated, unmarked]]);
      expect(credentials.rows.find(row => row.id === retired)).toMatchObject({ disabled: true, banned: true, sessions: 0, tokens: 0 });
      expect(credentials.rows.find(row => row.id === unrelated)).toMatchObject({ disabled: false, banned: null, sessions: 1, tokens: 1 });
      expect(credentials.rows.find(row => row.id === unmarked)).toMatchObject({ disabled: false, banned: null });
    } finally { await client.query('rollback'); }
  }, CASE_MS);

  it('retires credentials during a concurrent session refresh without an Auth lock upgrade deadlock', async ({ db: client, committedFixtures }) => {
    const [retiring, refreshing, barrier] = await Promise.all([connection(), connection(), connection()]);
    const user = randomUUID(), session = randomUUID();
    // Committed in autocommit below; registered first so the teardown removes
    // it even if this case times out before its finally block can.
    committedFixtures.push(
      ['drop trigger if exists retirement_refresh_pause on auth.sessions', []],
      ['delete from auth.users where id=$1', [user]],
    );
    let retirement, refresh;
    const blockedBy = (waiter, holder) => until(async () =>
      (await client.query('select $1::integer=any(pg_blocking_pids($2)) blocked', [holder, waiter])).rows[0].blocked,
    'The Auth concurrency fixture did not reach its controlled wait');
    try {
      await client.query(`insert into auth.users(id,email,raw_app_meta_data) values
        ($1,'taylor.morgan@demo.example.com','{"sample":true,"surface":"sample","sample_persona":"vp"}')`, [user]);
      await client.query('insert into auth.sessions(id,user_id) values($1,$2)', [session, user]);
      // Pause after deleting this session, before the subsequent account ban.
      // Both sources execute their actual statement/row triggers; only timing
      // is controlled, so the old shared-to-exclusive upgrade forms the cycle.
      await client.query(`create function pg_temp.retirement_refresh_pause() returns trigger language plpgsql as $$
        begin perform pg_advisory_xact_lock(509,7035); return old; end $$;
        create trigger retirement_refresh_pause after delete on auth.sessions
        for each row when (old.user_id='${user}'::uuid)
        execute function pg_temp.retirement_refresh_pause()`);
      // deadlock_timeout keeps a lock cycle failing at once; the statement
      // limit only stops a hang, so it is sized to the runner.
      const statementLimit = `set statement_timeout='${runnerTimeout(5_000)}ms'; set deadlock_timeout='100ms'`;
      await Promise.all([retiring.query(statementLimit), refreshing.query(statementLimit)]);
      const retiringPid = (await retiring.query('select pg_backend_pid() pid')).rows[0].pid;
      const refreshingPid = (await refreshing.query('select pg_backend_pid() pid')).rows[0].pid;
      const barrierPid = (await barrier.query('begin; select pg_advisory_xact_lock(509,7035); select pg_backend_pid() pid')).at(-1).rows[0].pid;
      // Run the credential phase verbatim, including its graph/Auth preamble.
      // Later catalogue DDL is already exercised by full replay/reapply cases.
      const phase = migration.slice(0, migration.indexOf('create or replace function private.guard_casework_restriction_update()'));
      expect(phase).toContain('$retired_shared_personas$;');
      retirement = retiring.query(`${phase} commit;`).then(() => ({ ok: true }), async error => {
        await retiring.query('rollback'); return { code: error.code };
      });
      await blockedBy(retiringPid, barrierPid);
      refresh = refreshing.query('update auth.sessions set refreshed_at=clock_timestamp() where id=$1', [session])
        .then(result => ({ ok: true, rows: result.rowCount }), error => ({ code: error.code }));
      await blockedBy(refreshingPid, retiringPid);
      await barrier.query('rollback');
      expect(await retirement).toEqual({ ok: true });
      expect(await refresh).toEqual({ ok: true, rows: 0 });
      expect((await client.query("select banned_until='infinity'::timestamptz banned from auth.users where id=$1", [user])).rows)
        .toEqual([{ banned: true }]);
    } finally {
      await barrier.query('rollback');
      if (retirement) await retirement;
      if (refresh) await refresh;
      await Promise.allSettled([retiring.end(), refreshing.end(), barrier.end()]);
      await client.query('drop trigger if exists retirement_refresh_pause on auth.sessions');
      await client.query('delete from auth.users where id=$1', [user]);
    }
  }, runnerTimeout(15_000));

  it('rejects the retired forged restriction and plaintext envelope channels', async ({ db: client }) => {
    await client.query('begin');
    try {
      const run = randomUUID(), organization = legacySeedOrganization(run);
      await client.query(`create temporary table retirement_restrictions (
        id uuid, organization_id uuid, is_restricted boolean, restriction_reason text, restricted_at timestamptz, restricted_by uuid);
        create trigger actual_restriction_guard before insert or update on retirement_restrictions
        for each row execute function private.guard_casework_restriction_update();
        insert into retirement_restrictions values ('f1000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000002',false,null,null,null);
        create temporary table member_accommodation_requests(id uuid,organization_id uuid,description text,staff_note text,status text,encrypted_content jsonb);
        create trigger actual_envelope_guard before insert or update on member_accommodation_requests
        for each row execute function private.require_sensitive_envelopes();
        select set_config('request.jwt.claims','{"role":"service_role"}',true);`);
      await client.query('update retirement_restrictions set organization_id=$1', [organization]);
      await client.query(`insert into private.uniondemo_runs
        (id,dataset_version,target_ref,member_count,steward_count,login_count,config_hash,state,protected_snapshot)
        values ($1,'retirement-control','disposable',100,60,0,repeat('0',64),'applied','{}')`, [run]);
      await client.query("select set_config('unionground.demo_seed_casework_scope',$1,true)",
        [JSON.stringify({ lane: 'uniondemo', runId: run, organizationId: organization })]);
      // The identical input must succeed with the retained predecessor. The
      // rollback restores the retired guard and the still-unrestricted row.
      await client.query('savepoint predecessor_restriction');
      await client.query(retiredSeedFunctionDefinition('private.member_stress_uuid(p_value text)'));
      await client.query(retiredSeedFunctionDefinition('private.guard_casework_restriction_update()'));
      expect((await client.query("update retirement_restrictions set is_restricted=true,restricted_by='f1000000-0000-4000-8000-000000000004' returning is_restricted")).rows)
        .toEqual([{ is_restricted: true }]);
      await client.query('rollback to savepoint predecessor_restriction');
      await client.query('savepoint denied_restriction');
      await expect(client.query("update retirement_restrictions set is_restricted=true,restricted_by='f1000000-0000-4000-8000-000000000004'"))
        .rejects.toMatchObject({ code: '42501' });
      await client.query('rollback to savepoint denied_restriction');
      await expect(client.query("insert into member_accommodation_requests values ('f1000000-0000-4000-8000-000000000005','f1000000-0000-4000-8000-000000000002','plaintext',null,'open','{}')"))
        .rejects.toMatchObject({ code: '22023' });
    } finally { await client.query('rollback'); }
  });
});
