// @vitest-environment node
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';
import { runnerTimeout } from '../scripts/lib/runner-timeout.mjs';
import { buildIcsCalendar } from '../src/lib/ics.js';
import { fnBody, loadMigrationSql } from './helpers/migration.js';
import { verifyHistoricalEventModelReplay } from './helpers/event-model-replay.js';

// BUG-UG-CALENDAR-CANCELLATION-POSTGRES-FIXTURE-20261112: the calendar-feed cancellation proof, moved from a docker-only Node
// test into the disposable-database set CI runs. It keeps every assertion of
// the earlier tests/calendar-feed-cancellation-postgres.node-test.mjs, on the
// fully migrated schema with its real roles, MFA and tenant checks instead of
// stubs. Each fixture case runs in one transaction that it rolls back.

const migration = loadMigrationSql('calendar_feed_cancelled_events');
const transactionalMigration = migration.replace(/^begin;\s*$/m, '').replace(/^commit;\s*$/m, '');
const predecessor = fnBody(loadMigrationSql('20261009002000_event_model'), 'public.get_calendar_feed_events(');
const token = 'a'.repeat(48);
const CASE_MS = runnerTimeout(60_000);

const until = async (done, message, waitMs = runnerTimeout(2_000)) => {
  for (const deadline = Date.now() + waitMs; Date.now() < deadline;) {
    if (await done()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
};

// Every connection a case opens carries this name; the teardown ends them
// through a separate connection, so a timed-out case's open transaction cannot
// reach the next case, and runs the case's registered committed-fixture
// cleanup (none of these cases commit, so the list stays empty).
const APPLICATION = 'calendar-feed-cancellation-proof';
const connection = async () => {
  const db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: APPLICATION });
  db.on('error', () => {});
  await db.connect();
  return db;
};
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

// Two organizations; a member of chapter A going to four meetings, one of
// them in organization B and one declined; and chapter A's admin, who cancels
// and restores. All inside the caller's open transaction.
async function seed(db) {
  const ids = Object.fromEntries(['orgA', 'orgB', 'member', 'memberSession', 'admin', 'adminSession'].map(key => [key, randomUUID()]));
  const tag = ids.orgA.slice(0, 8);
  ids.chapterA = `calendar-cancel-a-${tag}`;
  ids.chapterB = `calendar-cancel-b-${tag}`;
  ids.event = (name) => `calendar-cancel-${name}-${tag}`;
  for (const [user, session] of [[ids.member, ids.memberSession], [ids.admin, ids.adminSession]]) {
    await db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@calendar-cancel.invalid`]);
    await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
    await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic calendar factor','totp','verified',now(),now())", [randomUUID(), user]);
  }
  await db.query('insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3),($4,$5,$5,$3)',
    [ids.orgA, `calendar-cancel-a-${ids.orgA}`, ids.admin, ids.orgB, `calendar-cancel-b-${ids.orgB}`]);
  await db.query(`insert into public.chapters(id,name,slug,region,organization_id,is_default,order_index) values
    ($1,$1,$1,'east',$3,false,9961),($2,$2,$2,'east',$4,false,9962)`, [ids.chapterA, ids.chapterB, ids.orgA, ids.orgB]);
  for (const user of [ids.member, ids.admin]) {
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.orgA, user]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, ids.chapterA]);
    await db.query('update public.member_profiles set chapter_id=$2 where id=$1', [user, ids.chapterA]);
  }
  await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)", [ids.orgA, ids.admin]);
  await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'admin',$2) on conflict do nothing", [ids.admin, ids.chapterA]);
  await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'admin',$2) on conflict do nothing", [ids.admin, ids.chapterA]);
  await db.query('insert into public.member_calendar_feed_tokens(user_id,token_hash) values($1,private.calendar_feed_token_hash($2))', [ids.member, token]);
  const events = [
    ['cancel-me', 'Cancelled meeting', 1, ids.chapterA, false, false],
    ['keep-me', 'Active meeting', 2, ids.chapterA, false, false],
    ['foreign', 'Foreign meeting', 3, ids.chapterB, true, true],
    ['not-going', 'Declined meeting', 4, ids.chapterA, false, false],
  ];
  for (const [name, title, days, chapter, isPublic, acrossAgencies] of events) {
    await db.query(`insert into public.member_events(id,title,starts_at,event_kind,location,summary,check_in_code,order_index,chapter_id,is_public,is_public_across_agencies)
      values($1,$2,now()+make_interval(days => $3),'meeting','A',$4,$5,$6,$7,$8,$9)`,
    [ids.event(name), title, days, `${title} fixture`, `SG-${tag.toUpperCase()}${days}`, 9960 + days, chapter, isPublic, acrossAgencies]);
    await db.query('insert into public.member_event_rsvps(event_id,user_id,status) values($1,$2,$3)', [ids.event(name), ids.member, name === 'not-going' ? 'not_going' : 'going']);
  }
  return ids;
}

const as = async (db, claims, role) => {
  await db.query('reset role');
  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
  if (role) await db.query(`set local role ${role}`);
};
const asAdmin = (db, ids) => as(db, { role: 'authenticated', sub: ids.admin, session_id: ids.adminSession, aal: 'aal2' }, 'authenticated');
const feed = async (db, value = token) => {
  await as(db, { role: 'service_role' }, 'service_role');
  try { return (await db.query('select public.get_calendar_feed_events($1) result', [value])).rows[0].result; }
  finally { await db.query('reset role'); }
};
const feedIds = async (db, ids) => {
  const names = new Map(['cancel-me', 'keep-me', 'foreign', 'not-going'].map(name => [ids.event(name), name]));
  return (await feed(db)).events.map(row => names.get(row.id) ?? row.id);
};
const metadata = async (db) => (await db.query("select proacl::text,proowner,prosecdef,proconfig,prosrc from pg_proc where oid='public.get_calendar_feed_events(text)'::regprocedure")).rows[0];

const database = process.env.SUPABASE_DB_URL ? describe : describe.skip;
database('calendar subscriptions follow cancellation without losing RSVPs or tenant isolation', () => {
  beforeEach(async (context) => { context.db = await connection(); context.committedFixtures = []; });
  afterEach(async (context) => { await endCaseConnections(context.db, context.committedFixtures); });

  it('reproduces the defect on the predecessor, and the repair only adds cancellation filtering with the same privileges and attributes', async ({ db }) => {
    await db.query('begin');
    try {
      const ids = await seed(db);
      await db.query(predecessor);
      const before = await metadata(db);
      await asAdmin(db, ids);
      expect((await db.query('select public.cancel_member_event($1,$2) result', [ids.event('cancel-me'), 'Cancelled'])).rows[0].result.cancelled).toBe(true);
      expect(await feedIds(db, ids), 'the predecessor reproduces the reported defect').toEqual(['cancel-me', 'keep-me']);
      await db.query('reset role');
      await db.query(transactionalMigration);
      const after = await metadata(db);
      expect({ ...after, prosrc: '' }).toEqual({ ...before, prosrc: '' });
      expect(after.prosrc).toBe(before.prosrc.replace("where r.user_id = target and r.status = 'going'", "where r.user_id = target and r.status = 'going'\n        and e.cancelled_at is null"));
      // Reviewed in #5333 (fa9a0d3c504:scripts/db-contract.json); later
      // personal-reminder changes are absent from this repair.
      expect((await db.query("select md5(pg_get_functiondef('public.get_calendar_feed_events(text)'::regprocedure)) digest")).rows[0].digest).toBe('d3d362b9c0e4fe565c5785a9c11b68db');
      expect(await feedIds(db, ids)).toEqual(['keep-me']);
    } finally {
      await db.query('rollback');
    }
  }, CASE_MS);

  it('omits a cancelled meeting from the installed resolver and the real calendar formatter, keeps its RSVPs, and includes it again when restored', async ({ db }) => {
    await db.query('begin');
    try {
      const ids = await seed(db);
      await asAdmin(db, ids);
      expect((await db.query('select public.cancel_member_event($1,$2) result', [ids.event('cancel-me'), 'Cancelled'])).rows[0].result.cancelled).toBe(true);
      const result = await feed(db);
      expect(await feedIds(db, ids)).toEqual(['keep-me']);
      const ics = buildIcsCalendar(result.events);
      expect(ics).toMatch(/SUMMARY:Active meeting/);
      expect(ics).not.toMatch(/SUMMARY:Cancelled meeting|SUMMARY:Foreign meeting|SUMMARY:Declined meeting/);
      expect((await db.query('select status from public.member_event_rsvps where event_id=$1', [ids.event('cancel-me')])).rows[0].status).toBe('going');
      // Restoring needs no new RSVP.
      await asAdmin(db, ids);
      expect((await db.query('select public.restore_member_event($1) result', [ids.event('cancel-me')])).rows[0].result.cancelled).toBe(false);
      expect(await feedIds(db, ids)).toEqual(['cancel-me', 'keep-me']);
    } finally {
      await db.query('rollback');
    }
  }, CASE_MS);

  it('returns no calendar for unknown, short and revoked tokens', async ({ db }) => {
    await db.query('begin');
    try {
      await seed(db);
      for (const value of [null, 'short', 'b'.repeat(48)]) expect(await feed(db, value)).toEqual({ valid: false });
      await db.query('delete from public.member_calendar_feed_tokens where token_hash = private.calendar_feed_token_hash($1)', [token]);
      expect(await feed(db)).toEqual({ valid: false });
    } finally {
      await db.query('rollback');
    }
  }, CASE_MS);

  it('lets neither anonymous nor signed-in callers execute the service resolver', async ({ db }) => {
    await db.query('begin');
    try {
      const ids = await seed(db);
      for (const role of ['anon', 'authenticated']) {
        await db.query('savepoint caller');
        await as(db, { role, sub: ids.member, session_id: ids.memberSession, aal: 'aal2' }, role);
        await expect(db.query('select public.get_calendar_feed_events($1)', [token])).rejects.toMatchObject({ code: '42501' });
        await db.query('rollback to savepoint caller');
      }
    } finally {
      await db.query('rollback');
    }
  }, CASE_MS);

  it('rolls back a historical event-model replay, whose guard still refuses the later cancellation repair, and the feed still omits a cancelled meeting', async ({ db }) => {
    await db.query('begin');
    try {
      const ids = await seed(db);
      await asAdmin(db, ids);
      expect((await db.query('select public.cancel_member_event($1,$2) result', [ids.event('cancel-me'), 'Cancelled'])).rows[0].result.cancelled).toBe(true);
      await db.query('reset role');
      // Its original guard must keep rejecting later, unreviewed bodies. The
      // other guarded bodies stay at their reviewed historical revision so the
      // rejection is specifically about the calendar resolver.
      await db.query('savepoint guard');
      const model = loadMigrationSql('20261009002000_event_model').replace(/^begin;\s*$/m, '').replace(/^commit;\s*$/m, '');
      for (const name of ['public.get_admin_events(', 'public.rsvp_to_event(']) await db.query(fnBody(model, name));
      await expect(db.query(model)).rejects.toMatchObject({ code: '55000', message: expect.stringMatching(/unreviewed public\.get_calendar_feed_events\(text\) body/) });
      await db.query('rollback to savepoint guard');
      await verifyHistoricalEventModelReplay(db, { insideTransaction: true });
      expect((await db.query("select prosrc from pg_proc where oid='public.get_calendar_feed_events(text)'::regprocedure")).rows[0].prosrc).toContain('e.cancelled_at is null');
      expect(await feedIds(db, ids), 'after the replay, the feed holds only the active meeting').toEqual(['keep-me']);
    } finally {
      await db.query('rollback');
    }
  }, CASE_MS);
});
