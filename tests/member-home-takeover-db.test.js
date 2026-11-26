// @vitest-environment node
// REQ-UG-HOME-OVERRIDE-UNREAD-STEWARD-MESSAGE-20261001: live proof of
// public.get_member_home_takeover() on an owned disposable database. Every
// fixture rolls back with the outer transaction.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const SWITCH = "features.home.unread_message_takeover";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("member Home unread takeover on an owned disposable database", () => {
  let db;
  const ids = Object.fromEntries([
    "org", "foreignOrg", "member", "memberSession", "other", "otherSession", "outsider", "outsiderSession",
    "steward", "stewardSession", "conversation", "otherConversation",
  ].map((key) => [key, randomUUID()]));
  const chapter = `takeover-${ids.org}`;
  const sibling = `${chapter}-sibling`;
  const foreign = `${chapter}-foreign`;
  let actor = "member";
  let aal = "aal2";
  let order = 990000 + Math.floor(Math.random() * 9000);

  async function call() {
    await db.query("savepoint takeover_call");
    try {
      const sessionKey = `${actor}Session`;
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: ids[actor], role: "authenticated", session_id: ids[sessionKey], aal })]);
      await db.query("set local role authenticated");
      const result = await db.query("select public.get_member_home_takeover() data");
      await db.query("reset role");
      await db.query("release savepoint takeover_call");
      return { code: "", data: result.rows[0]?.data };
    } catch (error) {
      await db.query("rollback to savepoint takeover_call");
      await db.query("release savepoint takeover_call");
      return { code: error.code, message: error.message };
    }
  }

  async function message(conversation, userKey, patch = {}) {
    const row = {
      id: randomUUID(), sender_kind: "steward", sender_name: "Dana Whitfield", body: "Please call me about Step 2.",
      read_at: null, created_at: new Date(Date.now() - 60_000).toISOString(), ...patch,
    };
    await db.query(
      "insert into public.member_messages(id,conversation_id,user_id,sender_kind,sender_name,body,read_at,created_at) values($1,$2,$3,$4,$5,$6,$7,$8)",
      [row.id, conversation, ids[userKey], row.sender_kind, row.sender_name, row.body, row.read_at, row.created_at],
    );
    return row.id;
  }

  async function broadcast(patch = {}) {
    const row = {
      id: `takeover-${randomUUID()}`, title: "Contract vote opens", body: "Vote by Friday.", org: ids.org, chapter,
      scope: "organization", published_at: new Date(Date.now() - 30_000).toISOString(), retracted_at: null, ...patch,
    };
    order += 1;
    await db.query(
      `insert into public.member_broadcasts(id,sender,title,body,published_at,order_index,organization_id,chapter_id,audience_scope,retracted_at)
       values($1,'Chapter office',$2,$3,$4,$5,$6,$7,$8,$9)`,
      [row.id, row.title, row.body, row.published_at, order, row.org, row.chapter, row.scope, row.retracted_at],
    );
    return row.id;
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false });
    await db.connect();
    await db.query("begin");
    for (const [user, session] of [["member", "memberSession"], ["other", "otherSession"], ["outsider", "outsiderSession"], ["steward", "stewardSession"]]) {
      await db.query("insert into auth.users(id,email) values($1,$2)", [ids[user], `${ids[user]}@example.invalid`]);
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [ids[session], ids[user]]);
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Takeover proof','totp','verified',now(),now())", [randomUUID(), ids[user]]);
    }
    await db.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [ids.org, `takeover-${ids.org}`, ids.member]);
    await db.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [ids.foreignOrg, `takeover-${ids.foreignOrg}`, ids.outsider]);
    for (const [ch, org] of [[chapter, "org"], [sibling, "org"], [foreign, "foreignOrg"]]) {
      await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9960)", [ch, ids[org]]);
    }
    // The member joined an hour ago; history before that is not a takeover.
    for (const [user, org, ch] of [["member", "org", chapter], ["other", "org", chapter], ["outsider", "foreignOrg", foreign], ["steward", "org", chapter]]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status,created_at) values($1,$2,'active',now() - interval '1 hour')", [ids[org], ids[user]]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [ids[user], ch]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [ids[user], ch]);
    }
    // Conversations opened in the selected organization: the takeover only
    // shows a steward message from a conversation of that organization
    // (BUG-UG-HOME-TAKEOVER-ORG-SCOPE-20261002).
    await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'steward',$2) on conflict do nothing", [ids.steward, chapter]);
    for (const [conversation, user] of [["conversation", "member"], ["otherConversation", "other"]]) {
      await db.query("insert into public.member_conversations(id,user_id,title,initials,steward_user_id,organization_id) values($1,$2,'Chapter steward','CS',$3,$4)", [ids[conversation], ids[user], ids.steward, ids.org]);
    }
  }, 60000);

  beforeEach(async () => { actor = "member"; aal = "aal2"; await db.query("savepoint takeover_test"); });
  afterEach(async () => { await db.query("rollback to savepoint takeover_test"); });
  afterAll(async () => { await db?.query("rollback").catch(() => {}); await db?.end(); });

  it("registers a member-visible Home switch that defaults on", async () => {
    const { rows } = await db.query("select value_kind, default_value, category, member_visible from public.platform_setting_definitions where key=$1", [SWITCH]);
    expect(rows).toEqual([{ value_kind: "boolean", default_value: true, category: "home", member_visible: true }]);
  });

  it("returns the newest unread steward message and newest unread visible broadcast", async () => {
    await message(ids.conversation, "member", { body: "Older note", created_at: new Date(Date.now() - 600_000).toISOString() });
    const newest = await message(ids.conversation, "member", { body: "Your meeting is Thursday." });
    await message(ids.conversation, "member", { sender_kind: "member", sender_name: "Member", body: "My own reply", created_at: new Date().toISOString() });
    await message(ids.conversation, "member", { body: "Already read", read_at: new Date().toISOString(), created_at: new Date().toISOString() });
    await broadcast({ title: "Earlier notice", published_at: new Date(Date.now() - 900_000).toISOString() });
    const newestBroadcast = await broadcast({ title: "Vote opens Friday" });
    const result = await call();
    expect(result.code, result.message).toBe("");
    expect(result.data.enabled).toBe(true);
    expect(result.data.message).toMatchObject({ id: newest, conversationId: ids.conversation, senderName: "Dana Whitfield", body: "Your meeting is Thursday.", truncated: false });
    expect(result.data.broadcast).toMatchObject({ id: newestBroadcast, title: "Vote opens Friday", audience: "organization" });
  });

  it("bounds the message preview and says it was truncated", async () => {
    await message(ids.conversation, "member", { body: "x".repeat(900) });
    const { data } = await call();
    expect(data.message.body).toHaveLength(600);
    expect(data.message.truncated).toBe(true);
  });

  it("never returns another member's message", async () => {
    await message(ids.otherConversation, "other", { body: "Private to the other member" });
    const { data } = await call();
    expect(data.message).toBeNull();
    actor = "other";
    expect((await call()).data.message).toMatchObject({ body: "Private to the other member" });
  });

  it("skips read, retracted, scheduled, pre-membership, other-chapter and other-organization broadcasts", async () => {
    const read = await broadcast({ title: "Read" });
    await db.query("insert into public.member_broadcast_receipts(broadcast_id,user_id) values($1,$2)", [read, ids.member]);
    await broadcast({ title: "Retracted", retracted_at: new Date().toISOString() });
    await broadcast({ title: "Scheduled", published_at: new Date(Date.now() + 86_400_000).toISOString() });
    await broadcast({ title: "Before joining", published_at: new Date(Date.now() - 7_200_000).toISOString() });
    await broadcast({ title: "Sibling chapter only", chapter: sibling, scope: "chapter" });
    await broadcast({ title: "Foreign tenant", org: ids.foreignOrg, chapter: foreign });
    const { data } = await call();
    expect(data.broadcast).toBeNull();
    const own = await broadcast({ title: "My chapter", scope: "chapter" });
    expect((await call()).data.broadcast).toMatchObject({ id: own, audience: "chapter" });
  });

  it("never returns a removed message's tombstone", async () => {
    const id = await message(ids.conversation, "member", { body: "To be removed" });
    // The one redaction path the Message body lifecycle contract allows.
    const removed = await db.query("select private.redact_member_message_row($1,'staff_removed',null) ok", [id]);
    expect(removed.rows[0].ok).toBe(true);
    expect((await call()).data.message).toBeNull();
  });

  it("returns no content when the organization turns the switch off", async () => {
    await message(ids.conversation, "member");
    await broadcast();
    await db.query("insert into public.organization_setting_values(organization_id,setting_key,value,updated_by) values($1,$2,'false'::jsonb,$3)", [ids.org, SWITCH, ids.member]);
    expect((await call()).data).toEqual({ enabled: false, message: null, broadcast: null });
  });

  it("refuses callers without MFA assurance or an active organization", async () => {
    aal = "aal1";
    expect((await call()).code).toBe("42501");
    aal = "aal2";
    await db.query("update public.organization_memberships set status='revoked', revoked_at=now() where user_id=$1", [ids.member]);
    expect((await call()).code).toBe("42501");
  });

  it("is executable by signed-in members only", async () => {
    const { rows } = await db.query(`select
      has_function_privilege('anon','public.get_member_home_takeover()','EXECUTE') anon,
      has_function_privilege('authenticated','public.get_member_home_takeover()','EXECUTE') authed,
      has_function_privilege('service_role','public.get_member_home_takeover()','EXECUTE') service`);
    expect(rows[0]).toEqual({ anon: false, authed: true, service: false });
  });
});
