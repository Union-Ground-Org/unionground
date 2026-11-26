// @vitest-environment node
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const base = { version: 1, measure: 'published_actions', breakdown: 'month', period: '12m', form: 'bars' };
const includesCount = (value) => expect.arrayContaining([expect.objectContaining({ value })]);
live('portable Pulse charts on an owned disposable database', () => {
  let db, org, otherOrg, chapter, otherChapter, admin, member, peer, foreign, action, unit;
  const sessions = new Map();
  async function fixture(sql, values = []) {
    await db.query('savepoint fixture_write');
    await db.query('set local session_replication_role = replica');
    try { return await db.query(sql, values); }
    catch (error) { await db.query('rollback to savepoint fixture_write'); throw error; }
    finally { await db.query('set local session_replication_role = origin'); }
  }
  async function as(user, sql, values = [], aal = 'aal2') {
    await db.query('savepoint request');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated', aal, session_id: sessions.get(user) })]);
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
  const preview = (user, spec = base, hat = 'member') => as(user, 'select public.preview_pulse_chart($1,$2) v', [spec, hat]);
  const save = (user, spec = base, scope = 'personal', hat = 'member', id = null, pinned = false, home = false) => as(user,
    'select public.save_pulse_chart($1,$2,$3,$4,$5,$6,$7) v', [id, 'Recorded sign-ups', spec, scope, pinned, home, hat]);
  const read = (user, id, hat = 'member', picture = false) => as(user, 'select public.read_pulse_chart($1,$2,$3) v', [id, hat, picture]);
  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: 'pulse-saved-charts-rollback-proof' });
    await db.connect(); await db.query('begin'); await db.query("set local statement_timeout = '15s'");
    org = randomUUID(); otherOrg = randomUUID(); chapter = `pulse-${org}`; otherChapter = `pulse-${otherOrg}`;
    const users = Array.from({ length: 28 }, () => randomUUID());
    [admin, member, peer, foreign] = users; action = randomUUID(); unit = randomUUID();
    await db.query("insert into auth.users(id,email) select id,id::text || '@example.invalid' from unnest($1::uuid[]) id", [users]);
    await fixture("insert into public.organizations(id,slug,name) values ($1,$3,'Tamarack chart proof'),($2,$4,'Tamarack isolated chart proof')", [org, otherOrg, `pulse-${org}`, `pulse-${otherOrg}`]);
    await fixture("insert into public.chapters(id,name,slug,order_index,organization_id) values ($1,'Chart proof',$1,180001,$3),($2,'Isolated',$2,180002,$4)", [chapter, otherChapter, org, otherOrg]);
    await db.query('update public.member_profiles set chapter_id = case when id = $2 then $4 else $3 end where id = any($1::uuid[])', [users, foreign, chapter, otherChapter]);
    await fixture("insert into public.organization_memberships(organization_id,user_id,status) select case when id=$2 then $4::uuid else $3::uuid end,id,'active' from unnest($1::uuid[]) id on conflict do nothing", [users, foreign, org, otherOrg]);
    await fixture("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) select id,case when id=$2 then $4 else $3 end,'active',true,now() from unnest($1::uuid[]) id on conflict(user_id,chapter_id) do update set status='active',pinned=true,last_selected_at=now()", [users, foreign, chapter, otherChapter]);
    await fixture("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'admin',$2)", [org, admin]);
    for (const user of [admin, member, peer, foreign]) {
      const session = randomUUID(); sessions.set(user, session);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, user]);
    }
    await fixture("insert into public.digital_actions(id,organization_id,chapter_id,action_kind,title,summary,status,published_at,created_by,updated_by) values($1,$2,$3,'petition','Recorded action','Recorded action proof','published',now(),$4,$4)", [action, org, chapter, admin]);
    await fixture("insert into public.digital_action_participants(organization_id,action_id,user_id,participation_kind,joined_at) select $1,$2,id,'signature',now() from unnest($3::uuid[]) id", [org, action, users.filter((id) => id !== foreign)]);
    await fixture("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$2,$3,'North')", [unit, org, chapter]);
  }, 30000);
  beforeEach(async () => { await db.query('savepoint scenario'); });
  afterEach(async () => { await db.query('reset role'); await db.query('rollback to savepoint scenario'); });
  afterAll(async () => { if (db) { await db.query('rollback'); await db.end(); } });

  it('previews recorded aggregates and personal sign-ups without invented values', async () => {
    expect(await preview(member)).toMatchObject({ code: '', value: { withheld: false, rows: includesCount(27), privacyFloor: 25, person: false } });
    expect(await preview(member, { ...base, measure: 'my_actions' })).toMatchObject({ code: '', value: { person: true, rows: includesCount(1) } });
    for (const months of [3, 6, 12]) {
      const result = await preview(member, { ...base, period: `${months}m` });
      expect(result.code, result.message).toBe(''); expect(result.value.rows).toHaveLength(months);
      expect(result.value.rows.filter((row) => row.value !== 0)).toEqual([expect.objectContaining({ value: 27 })]);
    }
  });
  it('withholds every view when any canonical cell falls below the floor, before filters', async () => {
    await fixture("update public.digital_action_participants set joined_at = date_trunc('month',now()) - interval '1 day' where action_id=$1 and user_id=$2", [action, member]);
    for (const period of ['3m', '6m', '12m']) expect(await preview(peer, { ...base, period })).toMatchObject({ code: '', value: { withheld: true, rows: [] } });
    expect(await preview(admin, { ...base, unitID: unit }, 'admin')).toMatchObject({ code: '', value: { withheld: true, rows: [] } });
  });
  it('stores one neutral spec, edits it, and scopes personal/chapter/organization reads', async () => {
    const personal = await save(member); expect(personal.code, personal.message).toBe('');
    expect((await read(peer, personal.value)).code).toBe('42501');
    const shared = await save(member, base, 'chapter', 'member', personal.value, true, true); expect(shared.code, shared.message).toBe('');
    expect(await read(peer, personal.value)).toMatchObject({ code: '', value: { scope: 'chapter', pinned: true, home: true, owned: false } });
    expect((await read(foreign, personal.value)).code).toBe('42501');
    const staff = await save(admin, base, 'organization', 'admin'); expect(staff.code, staff.message).toBe('');
    expect((await read(member, staff.value)).code).toBe('42501');
    expect(await read(admin, staff.value, 'admin')).toMatchObject({ code: '', value: { scope: 'organization' } });
    expect((await save(member, base, 'organization')).code).toBe('42501');
    expect((await save(peer, base, 'chapter', 'member', personal.value)).code).toBe('42501');
  });
  it('enforces personal/chapter/staff row policies even with a temporary read grant, and rejects unknown spec grammar', async () => {
    const mine = (await save(member)).value, chapterChart = (await save(peer, base, 'chapter')).value;
    await save(admin, base, 'organization', 'admin');
    await db.query('grant select, insert, update, delete on private.pulse_saved_charts to authenticated');
    const visible = await as(member, 'select coalesce(jsonb_agg(id order by id),\'[]\'::jsonb) v from private.pulse_saved_charts');
    expect(visible.code, visible.message).toBe(''); expect(visible.value.sort()).toEqual([mine, chapterChart].sort());
    expect(await as(foreign, "select coalesce(jsonb_agg(id),'[]'::jsonb) v from private.pulse_saved_charts")).toMatchObject({ code: '', value: [] });
    expect(await as(member, 'update private.pulse_saved_charts set title=\'My updated chart\' where id=$1 returning id v', [mine])).toMatchObject({ code: '', value: mine });
    expect(await as(member, 'with changed as (update private.pulse_saved_charts set title=\'Forbidden\' where id=$1 returning id) select count(*)::int v from changed', [chapterChart])).toMatchObject({ code: '', value: 0 });
    expect((await as(member, 'insert into private.pulse_saved_charts(organization_id,chapter_id,owner_id,title,spec) values($1,$2,$3,\'Forbidden\',$4) returning id v', [org, chapter, peer, base])).code).toBe('42501');
    expect(await as(member, 'with removed as (delete from private.pulse_saved_charts where id=$1 returning id) select count(*)::int v from removed', [chapterChart])).toMatchObject({ code: '', value: 0 });
    expect(await as(member, 'delete from private.pulse_saved_charts where id=$1 returning id v', [mine])).toMatchObject({ code: '', value: mine });
    for (const invalid of [null, [], { ...base, version: '1' }, { ...base, breakdown: 'person' }, { ...base, period: '2026-01-01' }, { ...base, form: 'sql' }, { ...base, expression: 'select name' }, { ...base, measure: null }]) {
      expect((await preview(member, invalid)).code).toBe('22023');
    }
  });
  it('unpin reverses both pins, and remove/undo is owner-only and time-bounded', async () => {
    const chart = (await save(member, base, 'personal', 'member', null, true, true)).value;
    expect((await save(member, base, 'personal', 'member', chart, false, true)).code).toBe('');
    expect(await read(member, chart)).toMatchObject({ code: '', value: { pinned: false, home: false } });
    expect((await as(peer, 'select public.remove_pulse_chart($1,false) v', [chart])).code).toBe('42501');
    expect((await as(member, 'select public.remove_pulse_chart($1,false) v', [chart])).code).toBe('');
    expect((await read(member, chart)).code).toBe('42501');
    expect((await as(member, 'select public.remove_pulse_chart($1,true) v', [chart])).code).toBe('');
    await as(member, 'select public.remove_pulse_chart($1,false) v', [chart]);
    await db.query("update private.pulse_saved_charts set deleted_at = now() - interval '31 seconds' where id=$1", [chart]);
    expect((await as(member, 'select public.remove_pulse_chart($1,true) v', [chart])).code).toBe('42501');
  });
  it('refuses person-measure sharing and export on every server path, including forged specs', async () => {
    const spec = { ...base, measure: 'my_actions' };
    const chart = (await save(member, spec)).value;
    expect((await save(member, spec, 'chapter')).code).toBe('42501');
    expect((await read(member, chart, 'member', true)).code).toBe('42501');
    for (const kind of ['chapter', 'message']) expect((await as(member, 'select public.share_pulse_chart($1,$2,$3,$4) v', [chart, 'member', kind, randomUUID()])).code).toBe('42501');
    expect((await preview(member, { ...base, personID: peer })).code).toBe('22023');
  });
  it('posts only a chart reference to an authorized space or DM and rejects foreign destinations', async () => {
    const chart = (await save(member, base, 'chapter')).value;
    const space = randomUUID(), thread = randomUUID(), dm = randomUUID();
    await fixture("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$2)", [org, admin]);
    await fixture("insert into public.chapter_spaces(id,chapter_id,name,created_by) values($1,$2,'Chart space',$3)", [space, chapter, admin]);
    await fixture("insert into public.chapter_threads(id,space_id,chapter_id,title,created_by) values($1,$2,$3,'Chart discussion',$4)", [thread, space, chapter, admin]);
    await fixture("insert into public.member_conversations(id,user_id,steward_user_id,title) values($1,$2,$3,'Chart conversation')", [dm, member, admin]);
    for (const [kind, target] of [['chapter', thread], ['message', dm]]) {
      const result = await as(member, 'select public.share_pulse_chart($1,$2,$3,$4) v', [chart, 'member', kind, target]);
      expect(result.code, result.message).toBe('');
    }
    const post = (await db.query('select body from public.chapter_thread_posts where thread_id=$1', [thread])).rows;
    const message = (await db.query('select body from public.member_messages where conversation_id=$1', [dm])).rows;
    expect(post).toEqual([{ body: `[pulse-chart:${chart}]` }]); expect(message).toEqual([{ body: `[pulse-chart:${chart}]` }]);
    expect(await read(peer, chart)).toMatchObject({ code: '', value: { figures: { rows: includesCount(27) } } });
    expect((await as(foreign, 'select public.share_pulse_chart($1,$2,$3,$4) v', [chart, 'member', 'chapter', thread])).code).toBe('42501');
    expect((await as(member, 'select public.share_pulse_chart($1,$2,$3,$4) v', [chart, 'member', 'chapter', randomUUID()])).code).toBe('42501');
  });
  it('limits charts per listed chapter and keeps a chart out of another chapter\'s threads (#6755)', async () => {
    const second = `pulse-b-${org}`;
    await fixture("insert into public.chapters(id,name,slug,order_index,organization_id) values($1,'Second chart chapter',$1,180006,$2)", [second, org]);
    await fixture("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [member, second]);
    const shared = (await save(member, base, 'chapter')).value;
    await fixture("insert into private.pulse_saved_charts(organization_id,chapter_id,owner_id,title,spec,scope) select $1,$2,$3,'Filler '||n,$4::jsonb,'personal' from generate_series(1,29) n", [org, chapter, member, base]);
    expect((await save(member)).message).toMatch(/chart limit reached/);
    // In the second chapter none of these charts is listed, so none counts.
    await db.query('update public.member_profiles set chapter_id=$2 where id=$1', [member, second]);
    expect(await as(member, "select public.list_pulse_charts('member') v")).toMatchObject({ code: '', value: [] });
    expect((await save(member)).code).toBe('');
    // A first-chapter chart cannot be posted into a second-chapter thread.
    const space = randomUUID(), thread = randomUUID();
    await fixture("insert into public.chapter_spaces(id,chapter_id,name,created_by) values($1,$2,'Second space',$3)", [space, second, admin]);
    await fixture("insert into public.chapter_threads(id,space_id,chapter_id,title,created_by) values($1,$2,$3,'Second discussion',$4)", [thread, space, second, admin]);
    expect((await as(member, 'select public.share_pulse_chart($1,$2,$3,$4) v', [shared, 'member', 'chapter', thread])).code).toBe('42501');
    expect((await db.query('select count(*)::int n from public.chapter_thread_posts where thread_id=$1', [thread])).rows[0].n).toBe(0);
    // Back in the first chapter the limit still holds, and undo counts the chart's own chapter.
    await db.query('update public.member_profiles set chapter_id=$2 where id=$1', [member, chapter]);
    expect((await save(member)).message).toMatch(/chart limit reached/);
    // 29 live charts in A and one in B: undo counts only A, so it succeeds.
    expect((await as(member, 'select public.remove_pulse_chart($1,false) v', [shared])).code).toBe('');
    expect((await as(member, 'select public.remove_pulse_chart($1,true) v', [shared])).code).toBe('');
    expect((await as(member, 'select public.remove_pulse_chart($1,false) v', [shared])).code).toBe('');
    expect((await save(member)).code).toBe('');
    expect((await as(member, 'select public.remove_pulse_chart($1,true) v', [shared])).message).toMatch(/chart limit reached/);
  });
  it('counts only authorized recorded meetings/cases, and a revoked staff hat loses saved figures', async () => {
    const users = (await db.query('select user_id from public.organization_memberships where organization_id=$1', [org])).rows.map((row) => row.user_id);
    const event = `pulse-event-${randomUUID()}`;
    await fixture("insert into public.member_events(id,title,starts_at,location,summary,check_in_code,order_index,chapter_id,event_kind) values($1,'Recorded meeting',now(),'Proof room','Recorded check-ins','SG-PULSETEST',180003,$2,'meeting')", [event, chapter]);
    await fixture('insert into public.member_event_checkins(event_id,user_id) select $1,id from unnest($2::uuid[]) id', [event, users]);
    const meetings = await preview(member, { ...base, measure: 'meeting_turnout', breakdown: 'meeting' });
    expect(meetings).toMatchObject({ code: '', value: { rows: includesCount(27), withheld: false } });
    // #6744: a meeting bar is labelled with its Eastern start and title, never the event id,
    // and a second meeting with the same title and start keeps its own bar.
    const label = (await db.query("select to_char(starts_at at time zone 'America/New_York','YYYY-MM-DD HH24:MI') || ' · ' || title l from public.member_events where id=$1", [event])).rows[0].l;
    expect(meetings.value.rows).toEqual([{ label, value: 27 }]);
    expect(JSON.stringify(meetings.value)).not.toContain(event);
    const twin = `pulse-event-${randomUUID()}`;
    await fixture("insert into public.member_events(id,title,starts_at,location,summary,check_in_code,order_index,chapter_id,event_kind) select $1,title,starts_at,location,summary,'SG-PULSETWIN',180004,chapter_id,event_kind from public.member_events where id=$2", [twin, event]);
    await fixture('insert into public.member_event_checkins(event_id,user_id) select $1,id from unnest($2::uuid[]) id', [twin, users]);
    const both = await preview(member, { ...base, measure: 'meeting_turnout', breakdown: 'meeting' });
    expect(both).toMatchObject({ code: '', value: { withheld: false } });
    expect(both.value.rows).toEqual([{ label, value: 27 }, { label, value: 27 }]);
    expect(JSON.stringify(both.value)).not.toContain(twin);
    await fixture("insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,status,step) select gen_random_uuid(),id,'PULSE-'||id::text,'Recorded filing','Safety',$1,$2,'active','Intake' from unnest($3::uuid[]) id", [org, chapter, users]);
    const spec = { ...base, measure: 'visible_cases' };
    expect(await preview(admin, spec, 'admin')).toMatchObject({ code: '', value: { rows: includesCount(27), withheld: false } });
    const chart = (await save(admin, spec, 'organization', 'admin')).value;
    await fixture("delete from public.organization_role_grants where organization_id=$1 and user_id=$2 and role='admin'", [org, admin]);
    expect((await read(admin, chart, 'admin')).code).toBe('42501');
    const listing = await as(admin, "select public.list_pulse_charts('member') v");
    expect(listing).toMatchObject({ code: '', value: [expect.objectContaining({ id: chart, unavailable: true })] });
    expect(listing.value[0]).not.toHaveProperty('figures');
  });
  it('rechecks roles, full session, survey gate and tenant membership for saved and shared reads', async () => {
    expect((await preview(member, { ...base, measure: 'visible_cases' })).code).toBe('42501');
    expect((await preview(member, base, 'admin')).code).toBe('42501');
    expect((await as(admin, 'select public.preview_pulse_chart($1,$2) v', [base, 'admin'], 'aal1')).code).toBe('42501');
    const chart = (await save(member, base, 'chapter')).value;
    const period = (await db.query("select to_char(now() at time zone 'America/New_York','YYYY') || '-Q' || extract(quarter from now() at time zone 'America/New_York')::text p")).rows[0].p;
    await fixture("insert into public.organization_surveys(id,organization_id,title,status,cadence,period_key,created_by) values($1,$2,'Quarterly check-in','open','quarterly',$3,$4)", [randomUUID(), org, period, admin]);
    expect(await read(peer, chart)).toMatchObject({ code: '', value: { figures: { locked: true, rows: [] } } });
    expect(await preview(member, { ...base, measure: 'my_actions' })).toMatchObject({ code: '', value: { person: true, rows: includesCount(1) } });
    await fixture("update public.organization_memberships set status='revoked',revoked_at=now() where organization_id=$1 and user_id=$2", [org, peer]);
    expect((await read(peer, chart)).code).toBe('42501');
  });
  it('keeps unit narrowing with administrators and only uses workplace details shared with admins', async () => {
    expect((await preview(member, { ...base, unitID: unit })).code).toBe('42501');
    expect((await preview(admin, { ...base, unitID: randomUUID() }, 'admin')).code).toBe('42501');
    await fixture("insert into public.member_profile_details(user_id,worksite,details_visibility) values($1,'North','only_me')", [member]);
    const result = await preview(admin, { ...base, breakdown: 'unit' }, 'admin');
    expect(result).toMatchObject({ code: '', value: { withheld: false, rows: [{ label: 'Unassigned unit', value: 27 }] } });
    await fixture("update public.member_profile_details set details_visibility='admins' where user_id=$1", [member]);
    expect(await preview(admin, { ...base, breakdown: 'unit' }, 'admin')).toMatchObject({ code: '', value: { withheld: true, rows: [] } });
  });
  it('exports authored specs and lets account deletion cascade without retaining figures', async () => {
    const chart = (await save(member)).value;
    const exported = (await db.query('select private.account_lifecycle_export_additional_domains($1) v', [member])).rows[0].v;
    expect(exported.pulse_saved_charts).toEqual([expect.objectContaining({ id: chart, spec: base })]);
    expect(exported.pulse_saved_charts[0]).not.toHaveProperty('figures');
    expect((await as(member, 'select * from private.pulse_saved_charts')).code).toBe('42501');
    await db.query('delete from auth.users where id=$1', [member]);
    expect((await db.query('select count(*)::int n from private.pulse_saved_charts where id=$1', [chart])).rows[0].n).toBe(0);
  });
  it('keeps a former admin’s unit chart unavailable without losing the other charts or remove controls', async () => {
    const unitChart = (await save(admin, { ...base, breakdown: 'unit' }, 'personal', 'admin')).value;
    const normal = (await save(admin, base, 'personal', 'admin')).value;
    const own = (await save(admin, { ...base, measure: 'my_actions' }, 'personal', 'admin')).value;
    await fixture("delete from public.organization_role_grants where organization_id=$1 and user_id=$2 and role='admin'", [org, admin]);
    const list = await as(admin, "select public.list_pulse_charts('member') v");
    expect(list.code, list.message).toBe(''); expect(list.value).toHaveLength(3);
    expect(list.value.find((row) => row.id === unitChart)).toMatchObject({ unavailable: true });
    expect(list.value.find((row) => row.id === normal).figures.rows).toHaveLength(12);
    expect(list.value.find((row) => row.id === own).figures.rows).toHaveLength(12);
    expect((await as(admin, 'select public.remove_pulse_chart($1,false) v', [unitChart])).code).toBe('');
  });
  it('allows local aggregates only for organization staff and protects the chapter complement before filtering', async () => {
    const localSpec = { ...base, level: 'local' };
    expect((await preview(member, localSpec)).code).toBe('42501');
    expect(await preview(admin, localSpec, 'admin')).toMatchObject({ code: '', value: { rows: includesCount(27), withheld: false } });
    const smallChapter = `pulse-small-${randomUUID()}`, smallAction = randomUUID(), smallMember = randomUUID();
    await fixture("insert into public.chapters(id,name,slug,order_index,organization_id) values($1,'Small chapter',$1,180004,$2)", [smallChapter, org]);
    await db.query("insert into auth.users(id,email) values($1,$2)", [smallMember, `${smallMember}@example.invalid`]);
    await fixture("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, smallMember]);
    await fixture("insert into public.digital_actions(id,organization_id,chapter_id,action_kind,title,summary,status,published_at,created_by,updated_by) values($1,$2,$3,'petition','Small recorded action','Small recorded action proof','published',now(),$4,$4)", [smallAction, org, smallChapter, admin]);
    await fixture("insert into public.digital_action_participants(organization_id,action_id,user_id,participation_kind) values($1,$2,$3,'signature')", [org, smallAction, smallMember]);
    expect(await preview(admin, localSpec, 'admin')).toMatchObject({ code: '', value: { withheld: true, rows: [] } });
    expect(await preview(admin, { ...localSpec, unitID: unit }, 'admin')).toMatchObject({ code: '', value: { withheld: true, rows: [] } });
    expect(await preview(member)).toMatchObject({ code: '', value: { rows: includesCount(27) } });
    const second = (await save(admin, localSpec, 'organization', 'admin')).value;
    expect((await read(peer, second)).code).toBe('42501');
    expect(await as(member, "select public.pulse_chart_options('member') v")).toMatchObject({ code: '', value: { levels: ['chapter'] } });
  });
});
