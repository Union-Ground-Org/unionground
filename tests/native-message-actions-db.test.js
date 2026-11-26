// @vitest-environment node
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
const live = process.env.RUN_NATIVE_MESSAGE_ACTIONS_DB_TESTS === '1' ? it : it.skip;

live('native actions enforce ownership, latest eligibility, source boundaries and metadata-only audit', async () => {
  const url = new URL(process.env.SUPABASE_DB_URL);
  expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
  expect(Number(url.port)).toBeGreaterThanOrEqual(55000);
  expect(Number(url.port)).toBeLessThanOrEqual(59999);
  const c = new pg.Client({ connectionString: url.toString() });
  await c.connect(); await c.query('begin');
  try {
    const user = randomUUID(), org = randomUUID(), conversation = randomUUID(), session = randomUUID(), other = randomUUID();
    const chapter = `actions-${org}`;
    await c.query('insert into auth.users(id,email) values ($1,$2)', [user, `${user}@example.invalid`]);
    await c.query('insert into public.organizations(id,slug,name) values ($1,$2,$2)', [org, chapter]);
    await c.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9900)", [chapter, org]);
    await c.query('update public.member_profiles set chapter_id=$2 where id=$1', [user, chapter]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [org, user]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [user, chapter]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, user]);
    // 20261006030000 refuses a member message nobody could read; an
    // organization-wide steward in the fixture organization reads these.
    const reader = randomUUID();
    await c.query('insert into auth.users(id,email) values ($1,$2)', [reader, `${reader}@example.invalid`]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org, reader]);
    await c.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'steward')", [org, reader]);
    // The read policy takes the steward's organization from their own active
    // profile chapter and needs a staff second factor, so give them both.
    await c.query("update public.member_profiles set chapter_id=(select id from public.chapters where organization_id=$1 order by id limit 1) where id=$2", [org, reader]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) select id, chapter_id, 'active' from public.member_profiles where id=$1 on conflict do nothing", [reader]);
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values (gen_random_uuid(),$1,'totp','verified',now(),now())", [reader]);
    await c.query("insert into public.member_conversations(id,user_id,title) values ($1,$2,'Actions proof'),($3,$2,'Other thread')", [conversation, user, other]);
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated', aal: 'aal2', session_id: session })]);
    await c.query('set local role authenticated');
    const first = (await c.query('select public.send_member_message($1,$2) v', [conversation, 'original'])).rows[0].v.messageId;
    const state = async () => (await c.query("select public.get_member_message_actions('private',$1) v", [first])).rows[0].v;
    expect((await state()).canEdit).toBe(true);
    const edited = (await c.query('select public.edit_member_message($1,$2) v', [first, 'corrected'])).rows[0].v;
    expect(edited.body).toBe('corrected'); expect(edited.edited_at).toBeTruthy();
    expect((await c.query("select public.act_on_member_message('private',$1,'save') v", [first])).rows[0].v.state.saved).toBe(true);
    expect((await c.query("select public.act_on_member_message('private',$1,'save') v", [first])).rows[0].v.state.saved).toBe(false);
    expect((await c.query("select public.act_on_member_message('private',$1,'remind',$2) v", [first, new Date(Date.now() + 86400000).toISOString()])).rows[0].v.state.reminders).toHaveLength(1);
    expect((await c.query("select public.act_on_member_message('private',$1,'unremind') v", [first])).rows[0].v.state.reminders).toHaveLength(0);
    const reply = (await c.query("select public.reply_to_member_message('private',$1,'reply') v", [first])).rows[0].v;
    expect(reply.parent_message_id).toBe(first); expect(reply.conversation_id).toBe(conversation);
    expect((await state()).canEdit).toBe(false);
    await c.query('savepoint denied');
    // Each case names the refusal it expects, as observed against a disposable
    // stack: the four RPC refusals raise 42501 'message unavailable', and the
    // direct write hits the missing UPDATE grant. The message is asserted
    // because 42501 alone also matches a missing EXECUTE grant, and a bare
    // rejection also passes on a dropped function (42883) or a cast error.
    const unavailable = { code: '42501', message: 'message unavailable' };
    for (const [sql, args, refusal] of [
      ['select public.edit_member_message($1,$2)', [first, 'not latest'], unavailable],
      ["select public.get_member_message_actions('task',$1)", [first], unavailable],
      ["select public.get_member_message_actions('announcement',$1)", [first], unavailable],
      ["select public.get_member_message_actions('channel',$1)", [first], unavailable],
      ["update public.member_messages set body='bypass' where id=$1", [first], { code: '42501', message: 'permission denied for table member_messages' }],
    ]) {
      await expect(c.query(sql, args)).rejects.toMatchObject(refusal); await c.query('rollback to denied');
    }
    await c.query('reset role');
    await expect(c.query("insert into public.member_messages(conversation_id,user_id,sender_kind,sender_name,body,parent_message_id) values ($1,$2,'member','Proof','wrong parent',$3)", [other, user, first])).rejects.toMatchObject({ code: '42501' });
    await c.query('rollback to denied'); await c.query('reset role');
    const space = randomUUID(), thread = randomUUID();
    await c.query('insert into public.chapter_spaces(id,name) values ($1,$2)', [space, 'Actions proof']);
    await c.query('insert into public.chapter_threads(id,space_id,title) values ($1,$2,$3)', [thread, space, 'Actions proof']);
    const post = (await c.query("insert into public.chapter_thread_posts(thread_id,body) values ($1,'chapter parent') returning id", [thread])).rows[0].id;
    await c.query('set local role authenticated');
    const chapterReply = (await c.query("select public.reply_to_member_message('channel',$1,'chapter reply') v", [post])).rows[0].v;
    expect(chapterReply.parent_post_id).toBe(post); expect(chapterReply.thread_id).toBe(thread);
    expect((await c.query("select public.get_member_message_actions('channel',$1) v", [post])).rows[0].v.canEdit).toBe(false);
    expect((await c.query("select public.act_on_member_message('channel',$1,'react','like') v", [post])).rows[0].v.state.reactions).toContain('like');
    expect((await c.query("select public.act_on_member_message('channel',$1,'save') v", [post])).rows[0].v.state.saved).toBe(true);
    for (const [kind, parent, target, parentField] of [['private', first, conversation, 'parent_message_id'], ['channel', post, space, 'parent_post_id']]) {
      for (let index = 0; index < 52; index += 1) {
        const row = (await c.query('select public.reply_to_member_message($1,$2,$3) v', [kind, parent, `page reply ${index}`])).rows[0].v;
        expect(row[parentField]).toBe(parent);
      }
      const count = (await c.query('select public.get_member_message_reply_counts($1,$2::uuid[]) v', [kind, [parent]])).rows[0].v;
      expect(count[parent]).toBe(53);
      const firstPage = (await c.query('select public.get_member_message_replies($1,$2,$3) v', [kind, parent, target])).rows[0].v;
      expect(firstPage.parent.id).toBe(parent); expect(firstPage.count).toBe(53);
      expect(firstPage.replies).toHaveLength(50); expect(firstPage.hasMore).toBe(true);
      const cursor = firstPage.replies.at(-1);
      const lastPage = (await c.query('select public.get_member_message_replies($1,$2,$3,$4,$5) v', [kind, parent, target, cursor.created_at, cursor.id])).rows[0].v;
      expect(lastPage.replies).toHaveLength(3); expect(lastPage.hasMore).toBe(false);
      expect(new Set([...firstPage.replies, ...lastPage.replies].map((row) => row.id)).size).toBe(53);
      await c.query('savepoint navigation_denied');
      for (const [sql, args] of [
        ['select public.get_member_message_replies($1,$2,$3)', [kind, parent, other]],
        ['select public.get_member_message_replies($1,$2,$3)', ['task', parent, target]],
        ['select public.get_member_message_replies($1,$2,$3)', ['announcement', parent, target]],
        ['select public.get_member_message_reply_counts($1,$2::uuid[])', [kind, [randomUUID()]]],
        ['select public.get_member_message_replies($1,$2,$3,$4,$5)', [kind, parent, target, cursor.created_at, null]],
      ]) {
        await expect(c.query(sql, args)).rejects.toMatchObject({ code: '42501' });
        await c.query('rollback to navigation_denied');
      }
    }
    await c.query('reset role');
    const audit = (await c.query("select metadata from public.organization_audit_ledger where organization_id=$1 and event_type='message.edited'", [org])).rows;
    expect(audit).toHaveLength(1); expect(JSON.stringify(audit)).not.toMatch(/original|corrected/);
  } finally { await c.query('rollback'); await c.end(); }
});

// BUG-UG-STEWARD-MESSAGE-REPLY-DISCLOSES-PERSONAL-NAME-20260921: the
// per-message Reply and the thread composer must attribute a steward the same
// way, whatever the steward's profile name is.
for (const stewardName of ['Personal Steward Name', '']) live(`steward reply paths share the Chapter steward pseudonym: profile name ${JSON.stringify(stewardName)}`, async () => {
  const url = new URL(process.env.SUPABASE_DB_URL);
  expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
  expect(Number(url.port)).toBeGreaterThanOrEqual(55000);
  expect(Number(url.port)).toBeLessThanOrEqual(59999);
  const c = new pg.Client({ connectionString: url.toString() });
  await c.connect(); await c.query('begin');
  try {
    const member = randomUUID(), steward = randomUUID(), org = randomUUID(), conversation = randomUUID();
    const sessions = { [member]: randomUUID(), [steward]: randomUUID() };
    const chapter = `steward-reply-${org}`;
    await c.query('insert into public.organizations(id,slug,name) values ($1,$2,$2)', [org, chapter]);
    await c.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9900)", [chapter, org]);
    for (const user of [member, steward]) {
      await c.query('insert into auth.users(id,email) values ($1,$2)', [user, `${user}@example.invalid`]);
      await c.query('update public.member_profiles set chapter_id=$2 where id=$1', [user, chapter]);
      await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [org, user]);
      await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [user, chapter]);
      await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [sessions[user], user]);
    }
    await c.query('update public.member_profiles set full_name=$2 where id=$1', [steward, stewardName]);
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), steward]);
    await c.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'steward')", [org, steward]);
    await c.query("insert into public.member_conversations(id,user_id,title) values ($1,$2,'Chapter steward')", [conversation, member]);
    // Preserve this existing broad reply grant.
    await migrateLegacyStewardFixtures(c);
    const as = async (user) => {
      await c.query('reset role');
      await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated', aal: 'aal2', session_id: sessions[user] })]);
      await c.query('set local role authenticated');
    };
    await as(member);
    const question = (await c.query('select public.send_member_message($1,$2) v', [conversation, 'question'])).rows[0].v.messageId;
    await as(steward);
    await c.query('select public.send_steward_reply($1,$2)', [conversation, 'composer answer']);
    const reply = (await c.query("select public.reply_to_member_message('private',$1,'per-message answer') v", [question])).rows[0].v;
    expect(reply.parent_message_id).toBe(question);
    await c.query('reset role');
    const rows = (await c.query("select body,sender_kind,sender_name from public.member_messages where conversation_id=$1 and body in ('composer answer','per-message answer') order by body", [conversation])).rows;
    expect(rows).toEqual([
      { body: 'composer answer', sender_kind: 'steward', sender_name: 'Chapter steward' },
      { body: 'per-message answer', sender_kind: 'steward', sender_name: 'Chapter steward' },
    ]);
  } finally { await c.query('rollback'); await c.end(); }
});
