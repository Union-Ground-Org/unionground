// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const migration = readFileSync(new URL("../supabase/migrations/20261007012625_staff_peer_contact_without_reward.sql", import.meta.url), "utf8");

describe("staff contact migration boundary", () => {
  it("retains predecessor guards, uniform refusals, request limits and recipient consent", () => {
    expect(migration).toContain("unreviewed request_reward_peer_contact predecessor");
    expect(migration).toContain("request_row.staff_authorized");
    expect(migration).toContain("r.recipient_id = caller");
    expect(migration).toContain("interval '14 days'");
    expect(migration).not.toMatch(/\b(create|alter|drop)\s+policy\b/i);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("staff contact on a disposable database", () => {
  let db;
  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
    await db.connect();
    await db.query("set statement_timeout='10s'");
  });
  afterAll(async () => { await db?.end(); });

  async function world() {
    const org = randomUUID();
    const chapter = `staff-contact-${org}`;
    await db.query("insert into public.organizations(id,slug,name) values ($1,$2,$3)", [org, chapter, `Fictional staff contact proof ${org}`]);
    await db.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,'Fictional chapter',$1,'proof',$2,9975)", [chapter, org]);
    return { org, chapter };
  }
  async function person(w, role = "steward") {
    const id = randomUUID();
    const session = randomUUID();
    await db.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await db.query("update public.member_profiles set chapter_id=$2, full_name='Fictional proof person' where id=$1", [id, w.chapter]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [w.org, id]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, w.chapter]);
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, id]);
    if (role) {
      await db.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [id, role, w.chapter]);
      await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, w.chapter]);
    }
    return { id, session };
  }
  async function call(user, name, args = [], extraClaims = {}) {
    await db.query("savepoint caller");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user.id, role: "authenticated", aal: "aal2", session_id: user.session, ...extraClaims })]);
      await db.query("set local role authenticated");
      const placeholders = args.map((_, i) => `$${i + 1}`).join(",");
      const value = (await db.query(`select public.${name}(${placeholders}) as value`, args)).rows[0].value;
      await db.query("reset role");
      await db.query("release savepoint caller");
      return value;
    } catch (error) {
      await db.query("rollback to savepoint caller");
      throw error;
    }
  }
  async function fixture(run) {
    await db.query("begin");
    try {
      const w = await world();
      const sender = await person(w, "coordinator");
      const receiver = await person(w, "steward");
      await run({ w, sender, receiver });
    } finally { await db.query("rollback"); }
  }
  async function request(sender, receiver) {
    const recipient = await call(receiver, "list_reward_peer_contact");
    return call(sender, "request_reward_peer_contact", [recipient.code]);
  }

  it("lets current same-chapter staff request without a reward and creates a conversation only after consent", async () => {
    await fixture(async ({ w, sender, receiver }) => {
      expect((await call(sender, "list_reward_peer_contact")).canRequest).toBe(true);
      expect((await db.query("select private.member_reward_effect_enabled($1,'im-anyone') as granted", [sender.id])).rows[0].granted).toBe(false);
      expect(await request(sender, receiver)).toMatchObject({ requested: true });
      const pending = (await db.query("select id,staff_authorized from public.member_peer_contact_requests where requester_id=$1", [sender.id])).rows[0];
      expect(pending.staff_authorized).toBe(true);
      expect(Number((await db.query("select count(*) from public.member_peer_conversations where user_low=$1 or user_high=$1", [sender.id])).rows[0].count)).toBe(0);
      const accepted = await call(receiver, "respond_reward_peer_contact", [pending.id, true]);
      expect(accepted).toMatchObject({ accepted: true });
      expect(await call(sender, "send_reward_peer_message", [accepted.conversation.id, "Fictional staff proof message"])).toMatchObject({ message: { body: "Fictional staff proof message" } });
      const inbox = await call(receiver, "list_reward_peer_contact");
      expect(inbox.conversations.find((c) => c.id === accepted.conversation.id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ body: "Fictional staff proof message", sentByMe: false })]));
      const outsider = await person(w);
      expect((await call(outsider, "list_reward_peer_contact")).conversations).toEqual([]);
      await expect(call(outsider, "send_reward_peer_message", [accepted.conversation.id, "Forbidden outsider message"])).rejects.toMatchObject({ code: "22023" });
    });
  });

  it("does not open requests from an ordinary member without a reward", async () => {
    await fixture(async ({ w, receiver }) => {
      const member = await person(w, null);
      expect((await call(member, "list_reward_peer_contact")).canRequest).toBe(false);
      expect(await request(member, receiver)).toMatchObject({ requested: false, reason: "contact request unavailable" });
      expect(Number((await db.query("select count(*) from public.member_peer_contact_requests where requester_id=$1", [member.id])).rows[0].count)).toBe(0);
    });
  });

  it("does not let a staff exemption contact a non-staff member", async () => {
    await fixture(async ({ w, sender }) => {
      const member = await person(w, null);
      expect(await request(sender, member)).toMatchObject({ requested: false, reason: "contact request unavailable" });
    });
  });

  it("refuses another organization or chapter using the same generic response", async () => {
    await fixture(async ({ sender }) => {
      const other = await world();
      const receiver = await person(other);
      expect(await request(sender, receiver)).toMatchObject({ requested: false, reason: "contact request unavailable" });
      const wrong = await call(sender, "request_reward_peer_contact", ["PSG-00000000000000000000"]);
      expect(wrong).toMatchObject({ requested: false, reason: "contact request unavailable" });
    });
  });

  it.each(["sender", "receiver"])("revalidates a revoked %s staff grant before acceptance", async (which) => {
    await fixture(async ({ sender, receiver }) => {
      await request(sender, receiver);
      const pending = (await db.query("select id from public.member_peer_contact_requests where requester_id=$1", [sender.id])).rows[0];
      await db.query("delete from public.member_role_chapters where user_id=$1", [which === "sender" ? sender.id : receiver.id]);
      expect(await call(receiver, "respond_reward_peer_contact", [pending.id, true])).toMatchObject({ accepted: false, reason: "contact request unavailable" });
      expect(Number((await db.query("select count(*) from public.member_peer_conversations where created_from_request=$1", [pending.id])).rows[0].count)).toBe(0);
    });
  });

  it("revalidates organization membership and preserves a decline after staff revocation", async () => {
    await fixture(async ({ w, sender, receiver }) => {
      await request(sender, receiver);
      const pending = (await db.query("select id from public.member_peer_contact_requests where requester_id=$1", [sender.id])).rows[0];
      await db.query("update public.organization_memberships set status='revoked', revoked_at=now() where user_id=$1 and organization_id=$2", [sender.id, w.org]);
      expect(await call(receiver, "respond_reward_peer_contact", [pending.id, true])).toMatchObject({ accepted: false });
      expect(await call(receiver, "respond_reward_peer_contact", [pending.id, false])).toMatchObject({ accepted: false, declined: true });
    });
  });

  it("preserves ordinary reward requests and their consent after the reward expires", async () => {
    await fixture(async ({ w }) => {
      const sender = await person(w, null);
      const receiver = await person(w, null);
      await db.query("insert into public.member_reward_grants(user_id,item_key,status,source,organization_id) values ($1,'im-anyone','granted','admin_grant',$2)", [sender.id, w.org]);
      expect((await call(sender, "list_reward_peer_contact")).canRequest).toBe(true);
      expect(await request(sender, receiver)).toMatchObject({ requested: true });
      const pending = (await db.query("select id,staff_authorized from public.member_peer_contact_requests where requester_id=$1", [sender.id])).rows[0];
      expect(pending.staff_authorized).toBe(false);
      await db.query("update public.member_reward_grants set status='revoked',revoked_at=now() where user_id=$1", [sender.id]);
      expect(await call(receiver, "respond_reward_peer_contact", [pending.id, true])).toMatchObject({ accepted: true });
    });
  });

  it("refuses staff in another chapter of the same organization", async () => {
    await fixture(async ({ w, sender }) => {
      const other = { org: w.org, chapter: `other-${randomUUID()}` };
      await db.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,'Other proof chapter',$1,'proof',$2,9976)", [other.chapter, w.org]);
      expect(await request(sender, await person(other))).toMatchObject({ requested: false });
    });
  });

  it("refuses acceptance by anyone except the recipient and preserves both code limits", async () => {
    await fixture(async ({ w, sender, receiver }) => {
      expect(await request(sender, receiver)).toMatchObject({ requested: true });
      const pending = (await db.query("select id from public.member_peer_contact_requests where requester_id=$1", [sender.id])).rows[0];
      expect(await call(sender, "respond_reward_peer_contact", [pending.id, true])).toMatchObject({ accepted: false });
      expect(await request(receiver, sender)).toMatchObject({ requested: false });
      expect(await request(sender, await person(w))).toMatchObject({ requested: true });
      expect(await request(sender, await person(w))).toMatchObject({ requested: true });
      expect(await request(sender, await person(w))).toMatchObject({ requested: false });
      expect(Number((await db.query("select count(*) from public.member_peer_contact_requests where requester_id=$1", [sender.id])).rows[0].count)).toBe(3);
    });
  });

  it("accepts an organization staff grant only with active chapter membership", async () => {
    await fixture(async ({ w, receiver }) => {
      const sender = await person(w, null);
      await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')", [w.org, sender.id]);
      expect(await request(sender, receiver)).toMatchObject({ requested: true });
      const pending = (await db.query("select id from public.member_peer_contact_requests where requester_id=$1", [sender.id])).rows[0];
      await db.query("update public.member_chapter_memberships set status='revoked',revoked_at=now() where user_id=$1", [sender.id]);
      expect(await call(receiver, "respond_reward_peer_contact", [pending.id, true])).toMatchObject({ accepted: false });
    });
  });

  it("fails closed for an AAL1 caller rather than treating a staff grant as MFA", async () => {
    await fixture(async ({ sender }) => {
      await db.query("update auth.sessions set aal='aal1' where id=$1", [sender.session]);
      await db.query("savepoint restricted_caller");
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: sender.id, role: "authenticated", aal: "aal1", session_id: sender.session })]);
      await db.query("set local role authenticated");
      await expect(db.query("select public.request_reward_peer_contact('PSG-00000000000000000000')")).rejects.toMatchObject({ code: "42501" });
      await db.query("rollback to savepoint restricted_caller");
    });
  });

  async function keyOnly(user) {
    await db.query("delete from auth.mfa_factors where user_id=$1", [user.id]);
    await db.query("update private.verified_key_policy set enabled=true where singleton");
    // Factor removal installs a reset boundary. Create a real post-reset
    // native AAL1 key session; only its current JWT gains verified-key AAL2.
    user.session = randomUUID();
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal1',clock_timestamp(),clock_timestamp())", [user.session, user.id]);
    await db.query("insert into auth.mfa_amr_claims(id,session_id,authentication_method,created_at,updated_at) values ($1,$2,'passkey',now(),now())", [randomUUID(), user.session]);
    await db.query("insert into private.verified_key_sessions(session_id,user_id,challenge_sha256,assertion_sha256,backup_eligible,backed_up) values ($1,$2,$3,$4,false,false)", [user.session, user.id, randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''), randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')]);
  }

  it("does not borrow another key session's MFA for a password caller's request or consent", async () => {
    await fixture(async ({ sender, receiver }) => {
      await keyOnly(sender);
      const validKeyClaims = { ug_key_uv: true };
      const receiverCode = (await call(receiver, "list_reward_peer_contact")).code;
      const passwordSession = randomUUID();
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal1',clock_timestamp(),clock_timestamp())", [passwordSession, sender.id]);
      const passwordClaims = { aal: "aal1", session_id: passwordSession };
      expect((await call(sender, "list_reward_peer_contact", [], passwordClaims)).canRequest).toBe(false);
      expect(await call(sender, "request_reward_peer_contact", [receiverCode], passwordClaims)).toMatchObject({ requested: false });
      const senderCode = (await call(sender, "list_reward_peer_contact", [], validKeyClaims)).code;
      expect(await call(receiver, "request_reward_peer_contact", [senderCode])).toMatchObject({ requested: true });
      const pending = (await db.query("select id from public.member_peer_contact_requests where requester_id=$1", [receiver.id])).rows[0];
      expect(await call(sender, "respond_reward_peer_contact", [pending.id, true], passwordClaims)).toMatchObject({ accepted: false });
      expect(await call(sender, "respond_reward_peer_contact", [pending.id, true], validKeyClaims)).toMatchObject({ accepted: true });
    });
  });

  it("allows a current key caller and a peer's own valid key assurance", async () => {
    await fixture(async ({ sender, receiver }) => {
      await keyOnly(sender);
      await keyOnly(receiver);
      const claims = { ug_key_uv: true };
      expect((await call(sender, "list_reward_peer_contact", [], claims)).canRequest).toBe(true);
      const code = (await call(receiver, "list_reward_peer_contact", [], claims)).code;
      expect(await call(sender, "request_reward_peer_contact", [code], claims)).toMatchObject({ requested: true });
      const pending = (await db.query("select id from public.member_peer_contact_requests where requester_id=$1", [sender.id])).rows[0];
      expect(await call(receiver, "respond_reward_peer_contact", [pending.id, true], claims)).toMatchObject({ accepted: true });
    });
  });

  it("keeps the private eligibility helper inaccessible to every API role", async () => {
    const roles = ["anon", "authenticated", "service_role"];
    for (const role of roles) {
      expect((await db.query("select has_function_privilege($1,'private.member_peer_staff_eligible(uuid,text)','execute') as allowed", [role])).rows[0].allowed).toBe(false);
    }
  });

  it.each(["ban", "factor removal"])("refuses consent after the requester's %s", async (change) => {
    await fixture(async ({ sender, receiver }) => {
      await request(sender, receiver);
      const pending = (await db.query("select id from public.member_peer_contact_requests where requester_id=$1", [sender.id])).rows[0];
      if (change === "ban") await db.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1", [sender.id]);
      else await db.query("delete from auth.mfa_factors where user_id=$1", [sender.id]);
      expect(await call(receiver, "respond_reward_peer_contact", [pending.id, true])).toMatchObject({ accepted: false });
    });
  });
});
