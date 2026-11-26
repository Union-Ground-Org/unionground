// @vitest-environment node
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';
import { migrateLegacyStewardFixtures } from './helpers/steward-unit-fixtures.js';

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === '1' ? describe : describe.skip;

async function fixture(work) {
  const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false });
  await client.connect();
  await client.query('begin');
  try {
    const org = randomUUID(), other = randomUUID();
    const chapter = `pulse-${org}`, away = `pulse-${other}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1::uuid,$1::text,'Fictional Pulse proof'),($2::uuid,$2::text,'Other fictional proof')", [org, other]);
    await client.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,'Home',$1,$3,9961),($2,'Away',$2,$4,9962)", [chapter, away, org, other]);
    async function person(name, { foreign = false, role = null } = {}) {
      const id = randomUUID(), session = randomUUID();
      await client.query('reset role');
      await client.query("select set_config('request.jwt.claims','',true)");
      await client.query('insert into auth.users(id,email) values ($1,$2)', [id, `${id}@example.invalid`]);
      await client.query('update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1', [id, foreign ? away : chapter, name]);
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [foreign ? other : org, id]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [id, foreign ? away : chapter]);
      await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, id]);
      await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
      if (role) {
        await client.query('insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3)', [id, role, foreign ? away : chapter]);
        await client.query('insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)', [id, role, foreign ? away : chapter]);
      }
      return { id, session };
    }
    async function as(user, aal = 'aal2') {
      await client.query('reset role');
      await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user.id, session_id: user.session, role: 'authenticated', aal })]);
      await client.query('set local role authenticated');
    }
    async function events(user, count = 3, type = 'authorized_contact') {
      await client.query('reset role');
      await client.query("select set_config('request.jwt.claims','',true)");
      await client.query("insert into public.organization_engagement_events(organization_id,user_id,chapter_id,event_type,source_id) select $1,$2,$3,$4,'pulse-proof-'||n from generate_series(1,$5::integer) n on conflict do nothing", [org, user.id, chapter, type, count]);
    }
    const steward = await person('Steward', { role: 'steward' });
    const member = await person('Member');
    const foreign = await person('Other tenant person', { foreign: true });
    const officer = await person('Officer', { role: 'vp' });
    const read = async (level = 'steward') => (await client.query('select public.get_steward_pulse_people($1) as value', [level])).rows[0].value;
    await work({ client, org, chapter, person, as, events, steward, member, foreign, officer, read });
  } finally {
    await client.query('rollback');
    await client.end();
  }
}

live('steward Pulse People server privacy', () => {
  it('scopes names to the steward, matches the self report-card formula, and never counts page views', async () => fixture(async ({ client, as, events, steward, member, foreign, read }) => {
    await events(member);
    await as(member);
    const self = (await client.query('select public.get_my_analytics_report_card() as value')).rows[0].value;
    await as(steward);
    const result = await read();
    expect(result.members.find((row) => row.id === member.id)).toMatchObject({ score: 63, scoreHidden: false });
    expect(result.members.find((row) => row.id === member.id).score).toBe(self.overall);
    expect(result.members.some((row) => row.id === foreign.id)).toBe(false);
    expect(result.members.some((row) => row.id === steward.id)).toBe(false);
    await events(member, 100, 'page_view');
    await as(steward);
    expect((await read()).members.find((row) => row.id === member.id).score).toBe(63);
  }));

  it('persists the default-on self preference, masks every steward score read, and refuses another member update', async () => fixture(async ({ client, org, as, events, member, steward, read }) => {
    await events(member);
    await client.query('insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,$3)', [org, steward.id, 'steward']);
    // #8589 round 1: committed data gives every steward grant its migration carry-over; the analytics roster follows it.
    await migrateLegacyStewardFixtures(client);
    const workspace = async () => (await client.query('select public.get_organization_analytics_workspace() as value')).rows[0].value;
    await as(steward);
    expect((await workspace()).members.find((row) => row.id.startsWith(member.id + ':'))).toMatchObject({ overallScore: 63 });
    await as(member);
    expect((await client.query('select pulse_score_visible from public.member_profiles where id=$1', [member.id])).rows[0].pulse_score_visible).toBe(true);
    await client.query('update public.member_profiles set pulse_score_visible=false where id=$1', [member.id]);
    await as(steward);
    expect((await read()).members.find((row) => row.id === member.id)).toMatchObject({ name: 'Member', score: null, scoreHidden: true, lastActivity: null });
    // #6774: the analytics roster keeps the row and withholds only activity-derived fields.
    const kept = (await workspace()).members.find((row) => row.id.startsWith(member.id + ':'));
    expect(kept).toMatchObject({ name: 'Member', scoreHidden: true, participationScore: null, profileReadiness: null, followThrough: null,
      overallScore: null, lastActivityAt: null, attention: null, activeCases: 0, overdueCases: 0 });
    const changed = await client.query('update public.member_profiles set pulse_score_visible=true where id=$1 returning id', [member.id]);
    expect(changed.rows).toEqual([]);
    await as(member);
    await client.query('update public.member_profiles set pulse_score_visible=true where id=$1', [member.id]);
    await as(steward);
    expect((await read()).members.find((row) => row.id === member.id).score).toBe(63);
    expect((await workspace()).members.find((row) => row.id.startsWith(member.id + ':'))).toMatchObject({ overallScore: 63, scoreHidden: false });
  }));

  it('returns no identities in aggregate views and applies the floor to the group and the scored population', async () => fixture(async ({ client, person, events, as, steward, read }) => {
    await as(steward);
    expect(await read('chapter')).toMatchObject({ members: [], groups: [{ count: null, score: null, withheld: true }] });
    const users = [];
    // 25 scored members (plus the unscored member and officer) clear the floor of 25 (#7010).
    for (let i = 0; i < 25; i++) { const user = await person(`Group member ${i}`); users.push(user); await events(user); }
    await as(steward);
    const chapter = await read('chapter');
    expect(chapter.members).toEqual([]);
    expect(chapter).toMatchObject({ floor: 25 });
    expect(chapter.groups[0]).toMatchObject({ count: 27, score: 63, withheld: false });
    expect(JSON.stringify(await read('local'))).not.toContain('Group member');
    await client.query('reset role');
    await client.query('update public.member_profiles set pulse_score_visible=false where id=$1', [users[0].id]);
    await as(steward);
    // 24 scored members are under the floor, so the group score goes too.
    expect((await read('chapter')).groups[0]).toMatchObject({ count: 27, score: null, withheld: false });
  }));

  it('refuses member and officer-only callers, an unassured steward, invalid levels and anonymous callers', async () => fixture(async ({ client, as, member, officer, steward, read }) => {
    async function rejected(action, code) {
      await client.query('savepoint denied');
      try { await action(); throw new Error('expected refusal'); }
      catch (error) { expect(error.code).toBe(code); }
      finally { await client.query('rollback to savepoint denied'); }
    }
    for (const user of [member, officer]) { await as(user); await rejected(() => read(), '42501'); }
    await as(steward, 'aal1'); await rejected(() => read(), '42501');
    await as(steward); await rejected(() => read('person-id'), '22023');
    await client.query('reset role'); await client.query('set local role anon');
    await rejected(() => read(), '42501');
  }));

  it('revalidates withdrawn organization membership before returning any person', async () => fixture(async ({ client, as, steward, org, read }) => {
    await client.query('delete from public.organization_memberships where organization_id=$1 and user_id=$2', [org, steward.id]);
    await as(steward);
    await client.query('savepoint revoked');
    await expect(read()).rejects.toMatchObject({ code: '42501' });
    await client.query('rollback to savepoint revoked');
  }));
});
