// @vitest-environment node
// SEC-UG-MESSAGE-ACTION-WRITE-BOUNDS-20260921: message action and reply
// writes are bounded per actor, a retried reply or reminder persists once, and
// an over-bound call writes nothing.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';

const live = process.env.RUN_NATIVE_MESSAGE_ACTIONS_DB_TESTS === '1' ? describe : describe.skip;

live('message action write bounds', () => {
  let c;
  let ids;
  beforeAll(async () => {
    const url = new URL(process.env.SUPABASE_DB_URL);
    expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
    expect(Number(url.port)).toBeGreaterThanOrEqual(55000);
    expect(Number(url.port)).toBeLessThanOrEqual(59999);
    c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
  });
  afterAll(async () => { await c?.end(); });

  beforeEach(async () => {
    await c.query('begin');
    const user = randomUUID(), other = randomUUID(), org = randomUUID(), conversation = randomUUID();
    const space = randomUUID(), thread = randomUUID();
    const sessions = { [user]: randomUUID(), [other]: randomUUID() };
    const chapter = `bounds-${org}`;
    await c.query('insert into public.organizations(id,slug,name) values ($1,$2,$2)', [org, chapter]);
    await c.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9900)", [chapter, org]);
    for (const id of [user, other]) {
      await c.query('insert into auth.users(id,email) values ($1,$2)', [id, `${id}@example.invalid`]);
      await c.query('update public.member_profiles set chapter_id=$2 where id=$1', [id, chapter]);
      await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [org, id]);
      await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, chapter]);
      await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [sessions[id], id]);
    }
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
    await c.query("insert into public.member_conversations(id,user_id,title) values ($1,$2,'Bounds proof')", [conversation, user]);
    // The channel rows take their chapter and author from the caller's claims.
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated', aal: 'aal2', session_id: sessions[user] })]);
    await c.query('insert into public.chapter_spaces(id,name) values ($1,$2)', [space, 'Bounds proof']);
    await c.query('insert into public.chapter_threads(id,space_id,title) values ($1,$2,$3)', [thread, space, 'Bounds proof']);
    const post = (await c.query("insert into public.chapter_thread_posts(thread_id,body) values ($1,'chapter parent') returning id", [thread])).rows[0].id;
    ids = { user, other, org, conversation, post, sessions };
    await as(user);
    ids.message = (await c.query('select public.send_member_message($1,$2) v', [conversation, 'parent'])).rows[0].v.messageId;
    await c.query('reset role');
  });
  afterEach(async () => { await c.query('rollback'); });

  async function as(id) {
    await c.query('reset role');
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated', aal: 'aal2', session_id: ids.sessions[id] })]);
    await c.query('set local role authenticated');
  }
  async function auditCount(actor) {
    await c.query('reset role');
    const { rows } = await c.query("select count(*)::int n from public.organization_audit_ledger where actor_user_id=$1 and event_type like 'message.%'", [actor]);
    return rows[0].n;
  }
  async function seedAudit(actor, count, age) {
    await c.query('reset role');
    await c.query(`insert into public.organization_audit_ledger(organization_id,domain,event_type,action,actor_user_id,entity_type,entity_id,idempotency_key,metadata,occurred_at)
      select $1,'privacy','message.react','settings_change',$2,'message',$3,extensions.gen_random_uuid(),'{}'::jsonb,now() - $5::interval
      from generate_series(1,$4)`, [ids.org, actor, ids.message, count, age]);
  }
  async function expectCode(sql, args, code) {
    await c.query('savepoint refused');
    await expect(c.query(sql, args)).rejects.toMatchObject({ code });
    await c.query('rollback to refused');
  }

  it('a retried private reply returns the first reply and audits once', async () => {
    await as(ids.user);
    const first = (await c.query("select public.reply_to_member_message('private',$1,' same reply ') v", [ids.message])).rows[0].v;
    const retry = (await c.query("select public.reply_to_member_message('private',$1,'same reply') v", [ids.message])).rows[0].v;
    expect(retry.id).toBe(first.id);
    const distinct = (await c.query("select public.reply_to_member_message('private',$1,'another reply') v", [ids.message])).rows[0].v;
    expect(distinct.id).not.toBe(first.id);
    await c.query('reset role');
    expect((await c.query('select count(*)::int n from public.member_messages where parent_message_id=$1', [ids.message])).rows[0].n).toBe(2);
    expect(await auditCount(ids.user)).toBe(2);
  });

  it('a retried channel reply returns the first reply and audits once', async () => {
    await as(ids.user);
    const first = (await c.query("select public.reply_to_member_message('channel',$1,'channel reply') v", [ids.post])).rows[0].v;
    const retry = (await c.query("select public.reply_to_member_message('channel',$1,'channel reply') v", [ids.post])).rows[0].v;
    expect(retry.id).toBe(first.id);
    await c.query('reset role');
    expect((await c.query('select count(*)::int n from public.chapter_thread_posts where parent_post_id=$1', [ids.post])).rows[0].n).toBe(1);
    expect(await auditCount(ids.user)).toBe(1);
  });

  it('an equivalent reminder coalesces and a no-op unremind writes no audit', async () => {
    const at = new Date(Date.now() + 86400000).toISOString();
    await as(ids.user);
    const first = (await c.query("select public.act_on_member_message('private',$1,'remind',$2) v", [ids.message, at])).rows[0].v;
    const retry = (await c.query("select public.act_on_member_message('private',$1,'remind',$2) v", [ids.message, at])).rows[0].v;
    expect(retry.result.coalesced).toBe(true);
    expect(retry.result.id).toBe(first.result.id);
    expect(retry.state.reminders).toHaveLength(1);
    const direct = (await c.query("select public.create_member_message_reminder('private',$1,$2::timestamptz,'') v", [ids.message, at])).rows[0].v;
    expect(direct.id).toBe(first.result.id);
    expect((await c.query("select public.act_on_member_message('private',$1,'unremind') v", [ids.message])).rows[0].v.state.reminders).toHaveLength(0);
    expect((await c.query("select public.act_on_member_message('private',$1,'unremind') v", [ids.message])).rows[0].v.result.cancelled).toBe(true);
    await c.query('reset role');
    const events = (await c.query("select event_type from public.organization_audit_ledger where actor_user_id=$1 and event_type like 'message.%' order by occurred_at", [ids.user])).rows.map((row) => row.event_type);
    expect(events.sort()).toEqual(['message.remind', 'message.unremind']);
  });

  it('refuses a twenty-first pending reminder on one message', async () => {
    await as(ids.user);
    for (let index = 1; index <= 20; index += 1) {
      await c.query("select public.create_member_message_reminder('private',$1,now() + make_interval(hours => $2::int),'')", [ids.message, index]);
    }
    await expectCode("select public.create_member_message_reminder('private',$1,now() + interval '30 hours','')", [ids.message], '54000');
    await c.query('reset role');
    expect((await c.query("select count(*)::int n from public.member_message_reminders where owner_id=$1 and status='pending'", [ids.user])).rows[0].n).toBe(20);
  });

  it('refuses act and reply at 150 writes in 5 minutes and writes nothing', async () => {
    await seedAudit(ids.user, 149, '1 minute');
    await as(ids.user);
    await c.query("select public.act_on_member_message('private',$1,'save')", [ids.message]);
    await expectCode("select public.act_on_member_message('private',$1,'react','like')", [ids.message], '54000');
    await expectCode("select public.reply_to_member_message('private',$1,'over the bound')", [ids.message], '54000');
    await expectCode("select public.reply_to_member_message('channel',$1,'over the bound')", [ids.post], '54000');
    await c.query('reset role');
    expect(await auditCount(ids.user)).toBe(150);
    expect((await c.query('select count(*)::int n from public.member_message_reactions where actor_id=$1', [ids.user])).rows[0].n).toBe(0);
    expect((await c.query('select count(*)::int n from public.member_messages where parent_message_id=$1', [ids.message])).rows[0].n).toBe(0);
    expect((await c.query('select count(*)::int n from public.chapter_thread_posts where parent_post_id=$1', [ids.post])).rows[0].n).toBe(0);
  });

  it('counts only the rolling window and only the caller', async () => {
    await seedAudit(ids.user, 150, '6 minutes');
    await seedAudit(ids.other, 150, '1 minute');
    await as(ids.user);
    expect((await c.query("select public.act_on_member_message('private',$1,'save') v", [ids.message])).rows[0].v.state.saved).toBe(true);
    await as(ids.other);
    await expectCode("select public.act_on_member_message('channel',$1,'save')", [ids.post], '54000');
  });
});
