// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const entry = (key, pinned = false) => ({ key, pinned });
const spec = { version: 1, measure: 'my_actions', breakdown: 'month', period: '12m', form: 'bars' };

it('preserves the current account exporter byte for byte apart from the new owner-only layout projection', () => {
  const body = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')
    .match(/CREATE OR REPLACE FUNCTION private\.account_lifecycle_export_additional_domains\(p_caller uuid\)[\s\S]*?\$function\$;/)[0];
  const predecessor = body('20261113134500_referral_over_weekly_cap_waits_for_a_later_week.sql');
  const current = body('20261113148000_pulse_layout_store.sql');
  const projection = "'pulse_layouts', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('owner_id',l.owner_id,'organization_id',l.organization_id,'chapter_id',l.chapter_id,'entries',l.entries) order by l.chapter_id) from private.pulse_layouts l where l.owner_id=p_caller),'[]'::jsonb),\n    ";
  expect(current).toContain(projection);
  expect(current.replace(projection, '')).toBe(predecessor);
});

live('per-person Pulse layout on an owned disposable database (#8927 slice 1)', () => {
  let db, org, otherOrg, chapter, secondChapter, foreignChapter, member, peer, admin, president, foreign;
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
      return { code: error.code, message: error.message };
    }
  }
  const read = (user = member, hat = 'member', selected = chapter) => as(user, 'select public.get_pulse_layout($1,$2) v', [selected, hat]);
  const save = (entries, user = member, hat = 'member', selected = chapter) => as(user,
    'select public.save_pulse_layout($1,$2,$3) v', [selected, entries === null ? null : JSON.stringify(entries), hat]);
  async function chart(owner, chartSpec = spec, scope = 'personal', selected = chapter, deleted = false) {
    const id = randomUUID();
    await fixture(`insert into private.pulse_saved_charts(id,organization_id,chapter_id,owner_id,title,spec,scope,deleted_at)
      values($1,$2,$3,$4,'Tamarack layout proof',$5,$6,case when $7 then now() else null end)`,
    [id, selected === foreignChapter ? otherOrg : org, selected, owner, chartSpec, scope, deleted]);
    return `saved:${id}`;
  }
  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: 'pulse-layout-rollback-proof' });
    await db.connect(); await db.query('begin'); await db.query("set local statement_timeout = '15s'");
    org = randomUUID(); otherOrg = randomUUID();
    chapter = `layout-${org}`; secondChapter = `layout-second-${org}`; foreignChapter = `layout-${otherOrg}`;
    [member, peer, admin, president, foreign] = Array.from({ length: 5 }, () => randomUUID());
    const users = [member, peer, admin, president, foreign];
    await db.query("insert into auth.users(id,email) select id,id::text || '@example.invalid' from unnest($1::uuid[]) id", [users]);
    await fixture("insert into public.organizations(id,slug,name) values($1,$3,'Tamarack layout proof'),($2,$4,'Tamarack other layout proof')", [org, otherOrg, `layout-${org}`, `layout-${otherOrg}`]);
    await fixture("insert into public.chapters(id,name,slug,order_index,organization_id) values($1,'Layout',$1,187001,$4),($2,'Second layout',$2,187002,$4),($3,'Other layout',$3,187003,$5)", [chapter, secondChapter, foreignChapter, org, otherOrg]);
    await db.query('update public.member_profiles set chapter_id=case when id=$2 then $4 else $3 end where id=any($1::uuid[])', [users, foreign, chapter, foreignChapter]);
    await fixture("insert into public.organization_memberships(organization_id,user_id,status) select case when id=$2 then $4::uuid else $3::uuid end,id,'active' from unnest($1::uuid[]) id on conflict do nothing", [users, foreign, org, otherOrg]);
    await fixture("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) select id,case when id=$2 then $4 else $3 end,'active',true,now() from unnest($1::uuid[]) id on conflict(user_id,chapter_id) do update set status='active',pinned=true,last_selected_at=now()", [users, foreign, chapter, foreignChapter]);
    await fixture("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2),($1,$3,'vp',$2)", [org, admin, president]);
    for (const user of users) {
      const session = randomUUID(); sessions.set(user, session);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), user]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, user]);
    }
  }, 30000);
  beforeEach(async () => { await db.query('savepoint scenario'); });
  afterEach(async () => { await db.query('reset role'); await db.query('rollback to savepoint scenario'); });
  afterAll(async () => { if (db) { await db.query('rollback'); await db.end(); } });

  it('stores order and pins, replaces atomically, and distinguishes empty from standard', async () => {
    expect(await read()).toMatchObject({ code: '', value: { customized: false, entries: [] } });
    const entries = [entry('fixed:poll', true), entry('fixed:actions'), entry('fixed:outcomes', true)];
    expect((await save(entries)).code).toBe('');
    expect(await read()).toMatchObject({ code: '', value: { customized: true, entries } });
    expect((await save([...entries].reverse())).code).toBe('');
    expect((await read()).value.entries).toEqual([...entries].reverse());
    expect((await db.query('select count(*)::int n from private.pulse_layouts where owner_id=$1', [member])).rows[0].n).toBe(1);
    expect((await save([])).code).toBe('');
    expect((await read()).value).toMatchObject({ customized: true, entries: [] });
    expect((await save(null)).code).toBe('');
    expect((await read()).value).toMatchObject({ customized: false, entries: [] });
  });

  it('round trips the existing member week and meetings cards', async () => {
    const entries = [entry('fixed:week', true), entry('fixed:meetings')];
    expect((await save(entries)).code).toBe('');
    const result = await read();
    expect(result.value.entries).toEqual(entries);
    expect(result.value.options).toEqual(expect.arrayContaining(['fixed:week', 'fixed:meetings']));
  });

  it('keeps layouts private from peers, officers and admins; their writes affect only themselves', async () => {
    const entries = [entry('fixed:actions', true)];
    await save(entries);
    for (const [user, hat] of [[peer, 'member'], [president, 'vp'], [admin, 'admin']]) {
      expect(await read(user, hat)).toMatchObject({ code: '', value: { customized: false, entries: [] } });
      expect((await save([entry('fixed:poll')], user, hat)).code).toBe('');
      expect((await read()).value.entries).toEqual(entries);
    }
  });

  it('enforces owner RLS even with a temporary table grant, including reassignment and deletion', async () => {
    await save([entry('fixed:actions')]);
    await db.query('grant select,insert,update,delete on private.pulse_layouts to authenticated');
    await db.query('grant execute on function private.pulse_layout_entries_valid(jsonb) to authenticated');
    for (const user of [peer, president, admin, foreign]) {
      expect(await as(user, 'select count(*)::int v from private.pulse_layouts where owner_id=$1', [member])).toEqual({ code: '', value: 0 });
      expect(await as(user, 'with changed as (update private.pulse_layouts set entries=\'[]\' where owner_id=$1 returning 1) select count(*)::int v from changed', [member])).toEqual({ code: '', value: 0 });
      expect(await as(user, 'with changed as (delete from private.pulse_layouts where owner_id=$1 returning 1) select count(*)::int v from changed', [member])).toEqual({ code: '', value: 0 });
      expect((await as(user, 'insert into private.pulse_layouts(owner_id,organization_id,chapter_id,entries) values($1,$2,$3,\'[]\')', [member, org, chapter])).code).toBe('42501');
    }
    expect(await as(member, 'select count(*)::int v from private.pulse_layouts where owner_id=$1', [member])).toEqual({ code: '', value: 1 });
    expect((await as(member, 'update private.pulse_layouts set owner_id=$1 where owner_id=$2', [peer, member])).code).toBe('42501');
    expect((await as(member, 'update private.pulse_layouts set chapter_id=$1 where owner_id=$2', [secondChapter, member])).code).toBe('42501');
  });

  it('refuses foreign, other-chapter and missing layout targets identically', async () => {
    await save([entry('fixed:actions')]);
    await save([entry('fixed:poll')], foreign, 'member', foreignChapter);
    for (const selected of [secondChapter, foreignChapter, `missing-${randomUUID()}`, null]) {
      expect(await read(member, 'member', selected)).toEqual({ code: '42501', message: 'layout unavailable' });
      expect(await save([], member, 'member', selected)).toEqual({ code: '42501', message: 'layout unavailable' });
      expect(await save(null, member, 'member', selected)).toEqual({ code: '42501', message: 'layout unavailable' });
    }
    expect((await read()).value.entries).toEqual([entry('fixed:actions')]);
  });

  it('keeps a separate layout for each chapter when selection changes', async () => {
    const entries = [entry('fixed:actions', true)];
    await save(entries);
    await fixture("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [member, secondChapter]);
    await db.query('update public.member_profiles set chapter_id=$2 where id=$1', [member, secondChapter]);
    expect((await read(member, 'member', secondChapter)).value).toMatchObject({ customized: false, entries: [] });
    expect((await save([entry('fixed:poll')], member, 'member', secondChapter)).code).toBe('');
    await db.query('update public.member_profiles set chapter_id=$2 where id=$1', [member, chapter]);
    expect((await read()).value.entries).toEqual(entries);
  });

  it('allows only owned live built charts and refuses unknown or foreign keys uniformly', async () => {
    const mine = await chart(member);
    expect((await save([entry(mine, true)])).code).toBe('');
    expect((await read()).value.entries).toEqual([entry(mine, true)]);
    const denied = [await chart(peer, spec, 'chapter'), await chart(admin, spec, 'organization'),
      await chart(foreign, spec, 'personal', foreignChapter), await chart(member, spec, 'personal', secondChapter),
      await chart(member, spec, 'personal', chapter, true), `saved:${randomUUID()}`, 'fixed:unknown'];
    for (const key of denied) expect(await save([entry(key)])).toEqual({ code: '42501', message: 'layout unavailable' });
    expect((await read()).value.entries).toEqual([entry(mine, true)]);
  });

  it('rechecks current roles for both fixed and built options after an officer grant ends', async () => {
    const key = await chart(president, { ...spec, measure: 'visible_cases' });
    const entries = [entry('fixed:membership', true), entry(key, true), entry('fixed:poll')];
    expect((await save(entries, president, 'vp')).code).toBe('');
    expect((await read(president, 'vp')).value.entries).toEqual(entries);
    await fixture("delete from public.organization_role_grants where user_id=$1 and role='vp'", [president]);
    expect((await read(president, 'vp')).code).toBe('42501');
    const current = await read(president);
    expect(current.value.entries).toEqual([entry('fixed:poll')]);
    expect(current.value.options).not.toContain('fixed:membership');
    expect(current.value.options).not.toContain(key);
    expect((await save(entries, president)).code).toBe('42501');
    expect((await read(member, 'admin')).code).toBe('42501');
  });

  it('withdraws removed built charts at read time without changing their definitions', async () => {
    const key = await chart(member);
    await save([entry(key), entry('fixed:actions')]);
    await fixture('update private.pulse_saved_charts set deleted_at=now() where id=$1', [key.slice(6)]);
    const result = await read();
    expect(result.value.entries).toEqual([entry('fixed:actions')]);
    expect(result.value.options).not.toContain(key);
  });

  it('includes only the requested account owner in the private account export projection', async () => {
    const entries = [entry('fixed:actions', true)];
    await save(entries);
    await save([entry('fixed:poll')], peer);
    const result = await db.query("select private.account_lifecycle_export_additional_domains($1)->'pulse_layouts' v", [member]);
    expect(result.rows[0].v).toEqual([{ owner_id: member, organization_id: org, chapter_id: chapter, entries }]);
    const payout = `referral-${randomUUID()}`;
    await fixture('insert into private.member_referral_payouts_waiting(award_key,referrer_user_id) values($1,$2)', [payout,member]);
    const exported = (await db.query("select private.account_lifecycle_export_additional_domains($1)->'member_referral_payouts_waiting' v", [member])).rows[0].v;
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({award_key:payout,referrer_user_id:member});
    expect((await db.query("select private.account_lifecycle_export_additional_domains($1)->'member_referral_payouts_waiting' v", [peer])).rows[0].v).toEqual([]);
  });

  it('bounds keys and entries and rejects extra fields, duplicates and wrong JSON types atomically', async () => {
    const entries = [entry('fixed:actions')]; await save(entries);
    const invalid = [{}, null, 'x', [null], [{ key: 'fixed:poll' }], [{ ...entry('fixed:poll'), figures: [1] }],
      [entry('fixed:poll'), entry('fixed:poll', true)], [{ key: 3, pinned: true }], [{ key: 'fixed:poll', pinned: 'true' }],
      [entry('x'.repeat(81))], [entry('')], [entry('fixed:poll\n')], Array.from({ length: 65 }, (_, i) => entry(`fixed:k${i}`)),
      [entry('x'.repeat(17000))]];
    // SQL NULL is the intentional reset operation; JSON null is invalid.
    for (const value of invalid) {
      const result = await as(member, 'select public.save_pulse_layout($1,$2) v', [chapter, JSON.stringify(value)]);
      expect(result, JSON.stringify(value)?.slice(0, 100)).toEqual({ code: '22023', message: 'invalid layout' });
      expect((await read()).value.entries).toEqual(entries);
    }
    expect(await save([entry('x'.repeat(80))])).toEqual({ code: '42501', message: 'layout unavailable' });
  });

  it('requires assured sessions, current membership and no anonymous or service-role grants', async () => {
    expect((await as(member, 'select public.get_pulse_layout($1) v', [chapter], 'aal1')).code).toBe('42501');
    expect((await as(member, 'select public.save_pulse_layout($1,\'[]\') v', [chapter], 'aal1')).code).toBe('42501');
    for (const role of ['anon', 'service_role']) {
      const acl = await db.query("select has_function_privilege($1,'public.get_pulse_layout(text,text)','execute') r,has_function_privilege($1,'public.save_pulse_layout(text,jsonb,text)','execute') w,has_table_privilege($1,'private.pulse_layouts','select') t", [role]);
      expect(acl.rows[0]).toEqual({ r: false, w: false, t: false });
    }
    await fixture("update public.organization_memberships set status='revoked',revoked_at=now() where user_id=$1", [member]);
    expect((await read()).code).toBe('42501');
    expect((await save([])).code).toBe('42501');
  });
});
