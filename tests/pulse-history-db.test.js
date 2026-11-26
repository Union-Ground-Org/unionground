// @vitest-environment node
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
// Weeks touching October 2026 (Eastern, Monday starts). October has closed by
// the time this proof runs, so its weeks can be shown once all are stored.
const WEEK = '2026-10-05';
const OCTOBER_WEEKS = ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'];
const runAfter = (week) => `${new Date(Date.parse(`${week}T12:00:00Z`) + 8 * 86400000).toISOString().slice(0, 10)}T12:00:00-04:00`;
const RUN = runAfter(WEEK);
live('Pulse weekly history on an owned disposable database', () => {
  let db, org, otherOrg, chapter, otherChapter, admin, steward, member, foreign, users, meeting;
  const sessions = new Map();
  async function fixture(sql, values = []) {
    await db.query('savepoint fixture_write');
    await db.query('set local session_replication_role = replica');
    try { return await db.query(sql, values); }
    catch (error) { await db.query('rollback to savepoint fixture_write'); throw error; }
    finally { await db.query('set local session_replication_role = origin'); }
  }
  async function as(user, sql, values = []) {
    await db.query('savepoint request');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated', aal: 'aal2', session_id: sessions.get(user) })]);
      await db.query('set local role authenticated');
      const result = await db.query(sql, values);
      await db.query('reset role');
      await db.query('release savepoint request');
      return { code: '', value: result.rows[0]?.v };
    } catch (error) {
      await db.query('rollback to savepoint request');
      if (error.code === '42703') throw error;
      return { code: error.code, message: error.message };
    }
  }
  const history = (user, hat = 'member') => as(user, 'select public.get_pulse_history($1) v', [hat]);
  const snapshot = async (at = RUN) => (await db.query('select private.take_pulse_weekly_snapshots($1::timestamptz) v', [at])).rows[0].v;
  const october = async () => { for (const week of OCTOBER_WEEKS) await snapshot(runAfter(week)); };
  const stored = async (organization) => (await db.query(
    'select chapter_id, measure, value, withheld, privacy_floor from private.pulse_weekly_snapshots where organization_id = $1 order by week_start, chapter_id nulls last', [organization])).rows;
  async function addMeeting(startsAt, people, code) {
    const id = randomUUID();
    await fixture("insert into public.member_events(id,title,starts_at,location,summary,check_in_code,order_index,chapter_id,event_kind) values ($1,'Extra meeting',$3,'Union hall','Extra','SG-' || $4,180110 + floor(random() * 100000)::int,$2,'meeting')", [id, chapter, startsAt, code]);
    await fixture('insert into public.member_event_checkins(event_id,user_id) select $1,id from unnest($2::uuid[]) id', [id, people]);
    return id;
  }
  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: 'pulse-history-rollback-proof' });
    await db.connect(); await db.query('begin'); await db.query("set local statement_timeout = '30s'");
    org = randomUUID(); otherOrg = randomUUID(); chapter = `pulse-history-${org}`; otherChapter = `pulse-history-${otherOrg}`;
    users = Array.from({ length: 28 }, () => randomUUID());
    [admin, steward, member, foreign] = users; meeting = randomUUID();
    await db.query("insert into auth.users(id,email) select id,id::text || '@example.invalid' from unnest($1::uuid[]) id", [users]);
    await fixture("insert into public.organizations(id,slug,name) values ($1,$3,'Tamarack history proof'),($2,$4,'Tamarack isolated history proof')", [org, otherOrg, `pulse-history-${org}`, `pulse-history-${otherOrg}`]);
    await fixture("insert into public.chapters(id,name,slug,order_index,organization_id) values ($1,'History proof',$1,180101,$3),($2,'Isolated',$2,180102,$4)", [chapter, otherChapter, org, otherOrg]);
    await db.query('update public.member_profiles set chapter_id = case when id = $2 then $4 else $3 end where id = any($1::uuid[])', [users, foreign, chapter, otherChapter]);
    await fixture("insert into public.organization_memberships(organization_id,user_id,status) select case when id=$2 then $4::uuid else $3::uuid end,id,'active' from unnest($1::uuid[]) id on conflict do nothing", [users, foreign, org, otherOrg]);
    await fixture("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) select id,case when id=$2 then $4 else $3 end,'active',true,now() from unnest($1::uuid[]) id on conflict(user_id,chapter_id) do update set status='active',pinned=true,last_selected_at=now()", [users, foreign, chapter, otherChapter]);
    await fixture("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'admin',$2),($1,$3,'steward',$2)", [org, admin, steward]);
    for (const user of [admin, steward, member, foreign]) {
      const session = randomUUID(); sessions.set(user, session);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, user]);
    }
    // 27 distinct check-ins at one meeting in the recorded week: above the default floor of 25.
    await fixture("insert into public.member_events(id,title,starts_at,location,summary,check_in_code,order_index,chapter_id,event_kind) values ($1,'Chapter meeting',$3,'Union hall','Monthly meeting','SG-HIST1',180103,$2,'meeting')", [meeting, chapter, `${WEEK}T18:00:00-04:00`]);
    await fixture('insert into public.member_event_checkins(event_id,user_id) select $1,id from unnest($2::uuid[]) id', [meeting, users.filter((id) => id !== foreign)]);
  }, 30000);
  beforeEach(async () => { await db.query('savepoint scenario'); });
  afterEach(async () => { await db.query('reset role'); await db.query('rollback to savepoint scenario'); });
  afterAll(async () => { if (db) { await db.query('rollback'); await db.end(); } });

  it('records the last completed Eastern week once, with the floor applied before storage', async () => {
    expect(await snapshot()).toBeGreaterThan(0);
    const rows = await stored(org);
    expect(rows).toEqual([
      { chapter_id: chapter, measure: 'meeting_checkins', value: 27, withheld: false, privacy_floor: 25 },
      { chapter_id: null, measure: 'meeting_checkins', value: 27, withheld: false, privacy_floor: 25 },
    ]);
    expect((await db.query('select distinct week_start::text w from private.pulse_weekly_snapshots where organization_id = $1', [org])).rows).toEqual([{ w: WEEK }]);
    // A rerun in the same week never rewrites or tops up a recorded week.
    await fixture('insert into public.member_event_checkins(event_id,user_id) values ($1,$2)', [meeting, foreign]);
    await snapshot(runAfter('2026-10-07'));
    expect(await stored(org)).toEqual(rows);
    const later = `pulse-history-later-${org}`;
    await fixture("insert into public.chapters(id,name,slug,order_index,organization_id) values ($1,'Later chapter',$1,180104,$2)", [later, org]);
    await snapshot(runAfter('2026-10-08'));
    expect(await stored(org)).toEqual(rows);
    // No backfill: earlier weeks stay unrecorded.
    expect((await db.query('select count(*)::int n from private.pulse_weekly_snapshots where organization_id = $1 and week_start < $2::date', [org, WEEK])).rows[0].n).toBe(0);
  });

  it('withholds the whole week when one meeting in it is small', async () => {
    await addMeeting(`${WEEK}T19:00:00-04:00`, [member, steward], 'SMALL1');
    await snapshot();
    expect((await stored(org)).map((row) => [row.value, row.withheld])).toEqual([[null, true], [null, true]]);
  });

  it('waits until every meeting of the week has closed its check-in window', async () => {
    // Sunday Oct 11, 11 PM ET: check-in stays open until 3 AM Monday.
    await addMeeting('2026-10-11T23:00:00-04:00', [], 'LATE1');
    await snapshot('2026-10-12T01:00:00-04:00');
    expect(await stored(org)).toEqual([]);
    await snapshot('2026-10-12T04:00:00-04:00');
    expect((await stored(org)).map((row) => row.value)).toEqual([27, 27]);
  });

  it('shows a week only after its months close with every touching week stored and published', async () => {
    await snapshot();
    const early = await history(member);
    expect(early.code, early.message).toBe('');
    expect(early.value).toMatchObject({ locked: false, privacyFloor: 25, since: WEEK, complete: false, weeks: [WEEK] });
    // October still has unrecorded weeks, so nothing is shown yet.
    expect(early.value.series).toEqual([{ level: 'chapter', measure: 'meeting_checkins', direction: null,
      points: [{ week: WEEK, value: null, withheld: false, pending: true, recorded: true }] }]);
    await october();
    const mine = await history(member);
    expect(mine.value.weeks).toEqual(OCTOBER_WEEKS);
    const values = (row) => row.points.map((point) => point.value);
    // Sep 28 also touches September, whose earlier weeks were never recorded;
    // Oct 26 touches November, which is still open.
    expect(values(mine.value.series[0])).toEqual([null, 27, 0, 0, null]);
    expect(mine.value.series[0].points[0]).toMatchObject({ pending: true, withheld: false });
    expect(mine.value.series[0].points[4]).toMatchObject({ pending: true, withheld: false });
    expect(mine.value.series[0].direction).toBe('flat');
    // Meeting check-ins never leave the caller's own chapter, whatever the hat.
    const leader = await history(admin, 'admin');
    expect(leader.code, leader.message).toBe('');
    expect(leader.value.series.map((row) => `${row.level}:${row.measure}`)).toEqual(['chapter:meeting_checkins']);
    expect((await history(steward, 'steward')).code).toBe('');
    expect((await history(member, 'admin')).code).toBe('42501');
    const elsewhere = await history(foreign);
    expect(elsewhere.code, elsewhere.message).toBe('');
    expect(elsewhere.value.series.flatMap(values)).not.toContain(27);
    // Without the live event scope for this chapter, no meeting series is returned.
    await fixture('delete from public.member_chapter_memberships where user_id = $1', [admin]);
    const outside = await history(admin, 'admin');
    expect(['', '42501']).toContain(outside.code);
    if (outside.code === '') expect(outside.value.series).toEqual([]);
  });

  it('holds every week of a month that has a withheld week', async () => {
    await addMeeting(`${WEEK}T19:00:00-04:00`, [member, steward], 'SMALL2');
    await october();
    const read = await history(member);
    expect(read.value.series[0].points.map((point) => point.value)).toEqual([null, null, null, null, null]);
    expect(read.value.series[0].points[1]).toMatchObject({ withheld: true, pending: false });
    expect(read.value.series[0].points[2]).toMatchObject({ withheld: false, pending: true });
  });

  it('withholds a week stored under a lower floor than the current one', async () => {
    await october();
    await fixture("update private.pulse_weekly_snapshots set privacy_floor = 10 where organization_id = $1 and week_start = $2", [org, WEEK]);
    const read = await history(member);
    expect(read.code, read.message).toBe('');
    expect(read.value.series[0].points.map((point) => point.value)).toEqual([null, null, null, null, null]);
    expect(read.value.series[0].points[1]).toMatchObject({ withheld: true });
  });

  it('reports a direction only between two adjacent shown weeks', async () => {
    await fixture("update public.member_events set starts_at = '2026-10-21T18:00:00-04:00' where id = $1", [meeting]);
    await october();
    const read = await history(member);
    expect(read.value.series[0].points.map((point) => point.value)).toEqual([null, 0, 0, 27, null]);
    expect(read.value.series[0].direction).toBe('up');
  });

  it('keeps storage and the writer behind the read', async () => {
    expect((await as(member, 'select count(*)::int v from private.pulse_weekly_snapshots')).code).toBe('42501');
    expect((await as(member, 'select private.take_pulse_weekly_snapshots(now()) v')).code).toBe('42501');
    await db.query('savepoint anon_probe');
    let code = '';
    try { await db.query('set local role anon'); await db.query('select public.get_pulse_history($1)', ['member']); }
    catch (error) { code = error.code; }
    await db.query('rollback to savepoint anon_probe');
    expect(code).toBe('42501');
  });
});
