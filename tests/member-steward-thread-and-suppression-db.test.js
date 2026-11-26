// @vitest-environment node
// Real authenticated RPCs against an owned disposable full application replay
// with the staged composition applied (appointment boundary, then the member
// steward roster draft). Assertions never install a repair.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';
const live = process.env.RUN_MEMBER_STEWARD_COMPOSITION_DB_TESTS === '1' ? it : it.skip;

async function fixture(c) {
  const org = randomUUID(), steward = randomUUID();
  const chapterA = `proof-a-${org}`, chapterB = `proof-b-${org}`;
  await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org, `proof-${org}`]);
  await c.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$3,9900),($2,$2,$2,'proof',$3,9901)", [chapterA, chapterB, org]);
  const member = async (chapter) => {
    const id = randomUUID(), session = randomUUID();
    await c.query('insert into auth.users(id,email) values ($1,$2)', [id, `${id}@example.invalid`]);
    await c.query('update public.member_profiles set chapter_id=$2 where id=$1', [id, chapter]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [org, id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict(user_id,chapter_id) do update set status='active'", [id, chapter]);
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, id]);
    return { id, session };
  };
  await c.query('insert into auth.users(id,email) values ($1,$2)', [steward, `${steward}@example.invalid`]);
  await c.query('update public.member_profiles set chapter_id=$2 where id=$1', [steward, chapterB]);
  await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [org, steward]);
  await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$3,'active'),($1,$2,'active') on conflict(user_id,chapter_id) do update set status='active'", [steward, chapterA, chapterB]);
  // The retained legacy row names chapter A; revocation from A keeps it while B remains.
  await c.query('alter table public.member_roles disable trigger member_roles_forbid_new_ownerless');
  await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'steward',$2) on conflict(user_id,role) do update set chapter_id=$2", [steward, chapterA]);
  await c.query('alter table public.member_roles enable trigger member_roles_forbid_new_ownerless');
  // 20261006030000 refuses a general ("Chapter steward") thread nobody could
  // read. The tenant read policy needs the chapter-scoped grant, so this
  // steward holds it for chapter A, where the members write.
  await c.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'steward',$2) on conflict do nothing", [steward, chapterA]);
  const stewardSession = randomUUID();
  await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), steward]);
  await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [stewardSession, steward]);
  const as = async (who, sql, args = []) => {
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: who.id, session_id: who.session, role: 'authenticated', aal: 'aal2' })]);
    await c.query('savepoint rpc');
    try {
      await c.query('set local role authenticated');
      const result = await c.query(sql, args);
      await c.query('reset role'); await c.query('release savepoint rpc');
      return result.rows[0].r;
    } catch (error) { await c.query('rollback to savepoint rpc'); await c.query('release savepoint rpc'); throw error; }
  };
  return { org, chapterA, chapterB, member, as, steward: { id: steward, session: stewardSession } };
}

const withClient = async (body) => {
  const c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  await c.connect(); await c.query('begin');
  try { await body(c); } finally { await c.query('rollback'); await c.end(); }
};

live('general and selected-steward threads coexist in both creation orders', () => withClient(async (c) => {
  const f = await fixture(c);
  const general = (m) => f.as(m, 'select public.start_member_conversation($1) r', ['Synthetic general thread']);
  const selected = (m) => f.as(m, 'select public.start_member_steward_conversation($1,$2) r', [f.steward.id, 'Synthetic selected thread']);
  const threads = async (m) => (await c.query('select steward_user_id from public.member_conversations where user_id=$1 order by steward_user_id nulls first', [m.id])).rows;

  const selectedFirst = await f.member(f.chapterA);
  expect(await selected(selectedFirst)).toMatchObject({ created: true, stewardUserId: f.steward.id });
  expect(await general(selectedFirst)).toHaveProperty('conversationId');
  expect(await threads(selectedFirst)).toEqual([{ steward_user_id: null }, { steward_user_id: f.steward.id }]);

  const generalFirst = await f.member(f.chapterA);
  expect(await general(generalFirst)).toHaveProperty('conversationId');
  expect(await selected(generalFirst)).toMatchObject({ created: true });
  expect(await threads(generalFirst)).toEqual([{ steward_user_id: null }, { steward_user_id: f.steward.id }]);

  // One general thread per member still holds; a repeat selected Contact reuses its thread.
  await expect(general(generalFirst)).rejects.toMatchObject({ code: '23505' });
  expect(await selected(generalFirst)).toMatchObject({ created: false });
  expect(await threads(generalFirst)).toHaveLength(2);

  // Deleting the steward's account detaches the binding; the member's threads survive.
  await f.as(f.steward, "select public.set_my_steward_contact_visibility(false,true,null,'+1 555 0100') r");
  await c.query("select set_config('request.jwt.claims','',true)");
  await c.query('delete from auth.users where id=$1', [f.steward.id]);
  expect(await threads(generalFirst)).toEqual([{ steward_user_id: null }, { steward_user_id: null }]);
  expect((await c.query('select count(*)::int n from public.steward_contact_preferences where steward_user_id=$1', [f.steward.id])).rows[0].n).toBe(0);
  for (const fn of ['account_lifecycle_unmanaged_restrictive_fks', 'account_lifecycle_unmanaged_export_fks', 'account_lifecycle_referential_action_trigger_issues']) {
    expect((await c.query(`select * from private.${fn}()`)).rows, fn).toEqual([]);
  }
}), 60000);

live('a detached selected-steward thread drops the departed steward identity and nothing else changes', () => withClient(async (c) => {
  const f = await fixture(c);
  const other = await fixture(c);
  await c.query('update public.member_profiles set full_name=$2 where id=$1', [f.steward.id, 'Rowan Detachtest']);
  await c.query('update public.member_profiles set full_name=$2 where id=$1', [other.steward.id, 'Mira Bystander']);
  const general = (fx, m) => fx.as(m, 'select public.start_member_conversation($1) r', ['Synthetic general thread']);
  const selected = (fx, m) => fx.as(m, 'select public.start_member_steward_conversation($1,$2) r', [fx.steward.id, 'Synthetic selected thread']);
  const rows = async (m) => (await c.query(
    `select id, steward_user_id, title, initials, to_jsonb(c) - 'title' - 'initials' - 'steward_user_id' rest
     from public.member_conversations c where user_id=$1 order by id`, [m.id])).rows;

  const onlySelected = await f.member(f.chapterA);
  const selectedOnlyId = (await selected(f, onlySelected)).conversationId;
  const both = await f.member(f.chapterA);
  await general(f, both);
  await selected(f, both);
  const bystander = await other.member(other.chapterA);
  await selected(other, bystander);

  // Original identity: the selected thread carries the chosen steward's name and initials.
  const before = { onlySelected: await rows(onlySelected), both: await rows(both), bystander: await rows(bystander) };
  expect(before.onlySelected.map(({ steward_user_id, title, initials }) => ({ steward_user_id, title, initials })))
    .toEqual([{ steward_user_id: f.steward.id, title: 'Rowan Detachtest', initials: 'RD' }]);
  // One transaction stamps both rows with the same created_at; compare them in title order.
  expect(before.both.map(({ steward_user_id, title, initials }) => ({ steward_user_id, title, initials }))
    .sort((x, y) => x.title.localeCompare(y.title))).toEqual([
    { steward_user_id: null, title: 'Chapter steward', initials: 'CS' },
    { steward_user_id: f.steward.id, title: 'Rowan Detachtest', initials: 'RD' },
  ]);
  expect(before.bystander.map(({ steward_user_id, title, initials }) => ({ steward_user_id, title, initials })))
    .toEqual([{ steward_user_id: other.steward.id, title: 'Mira Bystander', initials: 'MB' }]);

  await c.query("select set_config('request.jwt.claims','',true)");
  await c.query('delete from auth.users where id=$1', [f.steward.id]);

  // Detach: every formerly bound thread takes the general identity; ids and all other columns survive.
  const after = { onlySelected: await rows(onlySelected), both: await rows(both), bystander: await rows(bystander) };
  for (const key of ['onlySelected', 'both']) {
    expect(after[key].map(({ steward_user_id, title, initials }) => ({ steward_user_id, title, initials })))
      .toEqual(before[key].map(() => ({ steward_user_id: null, title: 'Chapter steward', initials: 'CS' })));
    expect(after[key].map(({ id, rest }) => ({ id, rest }))).toEqual(before[key].map(({ id, rest }) => ({ id, rest })));
  }
  // No cross-member change: another member's thread bound to a different steward is untouched.
  expect(after.bystander).toEqual(before.bystander);

  // General reuse: the detached thread is now the member's general thread, so a
  // second general thread is refused and the existing one keeps working.
  await expect(general(f, onlySelected)).rejects.toMatchObject({ code: '23505' });
  // 20261006030000: with the chapter's only steward gone nobody could read the
  // detached thread, so a message there is refused; once the organization has
  // a steward again the reused thread works.
  await expect(f.as(onlySelected, 'select public.send_member_message($1,$2) r', [selectedOnlyId, 'Synthetic reuse after detach']))
    .rejects.toMatchObject({ code: '22023', message: 'no steward assigned' });
  const reader = randomUUID();
  await c.query("select set_config('request.jwt.claims','',true)");
  await c.query('insert into auth.users(id,email) values ($1,$2)', [reader, `${reader}@example.invalid`]);
  await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [f.org, reader]);
  await c.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'steward')", [f.org, reader]);
  // The read policy takes the steward's organization from their own active
  // profile chapter and needs a staff second factor, so give them both.
  await c.query("update public.member_profiles set chapter_id=(select id from public.chapters where organization_id=$1 order by id limit 1) where id=$2", [f.org, reader]);
  await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) select id, chapter_id, 'active' from public.member_profiles where id=$1 on conflict do nothing", [reader]);
  await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values (gen_random_uuid(),$1,'totp','verified',now(),now())", [reader]);
  await f.as(onlySelected, 'select public.send_member_message($1,$2) r', [selectedOnlyId, 'Synthetic reuse after detach']);
  expect((await rows(onlySelected)).map(({ id, title, initials }) => ({ id, title, initials })))
    .toEqual([{ id: selectedOnlyId, title: 'Chapter steward', initials: 'CS' }]);

  // Only the bound -> null transition retitles: an unbound thread's own title
  // survives a later write of steward_user_id that leaves it null.
  await c.query("update public.member_conversations set title='Member renamed' where user_id=$1", [both.id]);
  await c.query('update public.member_conversations set steward_user_id=null where user_id=$1', [both.id]);
  expect((await rows(both)).map(({ title }) => title)).toEqual(['Member renamed', 'Member renamed']);

  for (const fn of ['account_lifecycle_unmanaged_restrictive_fks', 'account_lifecycle_unmanaged_export_fks', 'account_lifecycle_referential_action_trigger_issues']) {
    expect((await c.query(`select * from private.${fn}()`)).rows, fn).toEqual([]);
  }
}), 60000);

live('a steward without active membership of the chapter is suppressed and can still withdraw', () => withClient(async (c) => {
  const f = await fixture(c);
  const caller = await f.member(f.chapterA);
  const shared = 'synthetic-steward@example.invalid';
  expect(await f.as(f.steward, "select public.set_my_steward_contact_visibility(true,false,$1,null) r", [shared])).toMatchObject({ shareEmail: true, contactEmail: shared });
  const roster = async () => (await f.as(caller, 'select public.get_member_chapter_stewards() r')).map((s) => ({ id: s.id, email: s.contact.email }));
  const bind = () => f.as(caller, 'select public.start_member_steward_conversation($1,$2) r', [f.steward.id, 'Synthetic bind attempt']);
  expect(await roster()).toEqual([{ id: f.steward.id, email: shared }]);

  // Multi-chapter revocation: removed from A, still active in B (the profile chapter),
  // legacy role row still names A. Publication on A must stop.
  await c.query("update public.member_chapter_memberships set status='revoked', revoked_at=now() where user_id=$1 and chapter_id=$2", [f.steward.id, f.chapterA]);
  expect((await c.query("select chapter_id from public.member_roles where user_id=$1 and role='steward'", [f.steward.id])).rows).toEqual([{ chapter_id: f.chapterA }]);
  expect(await roster()).toEqual([]);
  await expect(bind()).rejects.toMatchObject({ code: '42501' });

  // Missing membership of A behaves the same as revoked.
  await c.query('delete from public.member_chapter_memberships where user_id=$1 and chapter_id=$2', [f.steward.id, f.chapterA]);
  expect(await roster()).toEqual([]);

  // Revoked from the profile chapter too: the steward can no longer publish,
  // but can read and withdraw their own row.
  await c.query("update public.member_chapter_memberships set status='revoked', revoked_at=now() where user_id=$1 and chapter_id=$2", [f.steward.id, f.chapterB]);
  await expect(f.as(f.steward, "select public.set_my_steward_contact_visibility(true,false,$1,null) r", [shared])).rejects.toMatchObject({ code: '42501' });
  expect(await f.as(f.steward, 'select public.get_my_steward_contact_visibility() r')).toMatchObject({ shareEmail: true, contactEmail: shared });
  expect(await f.as(f.steward, 'select public.set_my_steward_contact_visibility(false,false,null,null) r')).toEqual({ shareEmail: false, sharePhone: false, contactEmail: null, contactPhone: null });
  expect((await c.query('select share_email, share_phone, contact_email, contact_phone from public.steward_contact_preferences where steward_user_id=$1', [f.steward.id])).rows)
    .toEqual([{ share_email: false, share_phone: false, contact_email: null, contact_phone: null }]);

  // Withdrawal never creates a row for a caller who has none.
  const stranger = await f.member(f.chapterB);
  await c.query("update public.member_chapter_memberships set status='revoked', revoked_at=now() where user_id=$1", [stranger.id]);
  expect(await f.as(stranger, 'select public.set_my_steward_contact_visibility(false,false,null,null) r')).toEqual({ shareEmail: false, sharePhone: false, contactEmail: null, contactPhone: null });
  expect((await c.query('select count(*)::int n from public.steward_contact_preferences where steward_user_id=$1', [stranger.id])).rows[0].n).toBe(0);

  // Restoring A's membership republishes nothing: the withdrawn row stays withdrawn.
  await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict(user_id,chapter_id) do update set status='active', revoked_at=null", [f.steward.id, f.chapterA]);
  expect(await roster()).toEqual([{ id: f.steward.id, email: null }]);
}), 60000);

live('steward contact preferences carry the restrictive MFA floor', () => withClient(async (c) => {
  const f = await fixture(c);
  await f.as(f.steward, "select public.set_my_steward_contact_visibility(false,true,null,'+1 555 0100') r");
  // The table has no client grant; grant SELECT inside this rolled-back
  // transaction so the policies, not the missing grant, decide visibility.
  await c.query('grant select on public.steward_contact_preferences to authenticated');
  const ownRows = async (aal) => {
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.steward.id, session_id: f.steward.session, role: 'authenticated', aal })]);
    await c.query('set local role authenticated');
    const { rows } = await c.query('select steward_user_id from public.steward_contact_preferences');
    await c.query('reset role');
    return rows;
  };
  // A verified-TOTP steward on an aal1 session must not read even their own row.
  expect(await ownRows('aal1')).toEqual([]);
  expect(await ownRows('aal2')).toEqual([{ steward_user_id: f.steward.id }]);
}));
