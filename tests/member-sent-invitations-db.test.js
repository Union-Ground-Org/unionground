// @vitest-environment node
//
// REQ-UG-MEMBER-SENT-INVITATIONS-20261111 (#8171), owner option A: a
// member invites someone into their own home chapter when the organization's
// switch is on. Two fictional tenants (Harbor Workers Local 7, Ridge Transit
// Local 9). Every test runs in one transaction that is rolled back.
import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { releaseCalendarHolds } from "./helpers/release-calendar-holds.js";

const MIGRATION = readdirSync(new URL("../supabase/migrations/", import.meta.url))
  .find((name) => name.endsWith("_member_sent_invitations.sql")).replace(/\.sql$/u, "");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const SWITCH = "features.member_invitations.enabled";

describe("member-sent invitations (static)", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));

  it("is one atomic migration that leaves open signup alone", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).not.toMatch(/open_signup/u);
  });

  // Opus gate round 1, P1-1: the member never chooses the link's secret.
  it("keeps the creating and delivery functions server-only and the session check member-only", () => {
    expect(sql).toContain("grant execute on function public.create_member_sent_invitation(uuid, text, text, text, text) to service_role;");
    expect(sql).toContain("grant execute on function public.record_member_sent_invitation_delivery(uuid, uuid, integer, text) to service_role;");
    expect(sql).toContain("grant execute on function public.member_sent_invitation_session() to authenticated;");
    expect(sql).not.toMatch(/grant execute on function public\.(create_member_sent_invitation|record_member_sent_invitation_delivery)\([^)]*\) to authenticated/u);
    const session = stripComments(fnBody(sql, "public.member_sent_invitation_session()"));
    expect(session).toContain("private.mfa_satisfied()");
    expect(session).not.toMatch(/insert|update|delete/iu);
  });

  it("takes no chapter or role from the caller and checks the switch, membership and account age before charging", () => {
    const create = stripComments(fnBody(sql, "public.create_member_sent_invitation(p_actor uuid, p_email text, p_full_name text, p_locale text, p_token_hash text)"));
    expect(create).toMatch(/begin\s+perform private\.lock_case_graph\(array\[p_actor\], array\[\]::uuid\[\]\);/u);
    expect(create).toContain("coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'");
    expect(create).toContain("where p.id = caller and c.organization_id = caller_org");
    expect(create).toContain(`private.organization_feature_enabled(caller_org, '${SWITCH}')`);
    expect(create).toContain("u.created_at <= pg_catalog.clock_timestamp() - interval '7 days'");
    const firstCharge = create.indexOf("consume_member_invitation_admin_limit");
    expect(create.indexOf(SWITCH)).toBeLessThan(firstCharge);
    // Charged before the existing-account and duplicate answers, never after.
    expect(firstCharge).toBeLessThan(create.indexOf("from auth.users u\n    where pg_catalog.lower"));
    expect(create).toContain("clock_timestamp() + interval '15 minutes', 'provision', 'member'");
    expect(create).not.toMatch(/p_chapter|p_initial_role|member_requests/u);
  });
});

// REQ-UG-MEMBER-SENT-INVITATIONS-LEARNING-JOURNAL-20261111 (#8395):
// the member's own invitation is journalled for the member the route verified.
// #8767: one entry for every member send, before the branch on the address.
describe("member send history the same for every address (static)", () => {
  const sql = stripComments(loadMigrationSql("_member_send_history_same_for_every_address"));
  const flat = (text) => text.replace(/\s+/gu, " ");
  const create = flat(stripComments(fnBody(sql, "public.create_member_sent_invitation(p_actor uuid, p_email text, p_full_name text, p_locale text, p_token_hash text)")));

  it("journals once, before the address branch, with a target that names no row", () => {
    const journal = create.indexOf("perform private.learning_actor_journal('invitation_send', 'public.member_invitations', extensions.gen_random_uuid()::text, caller, caller_org);");
    expect(journal).toBeGreaterThan(create.indexOf("'member-invitation-email:' || clean_email"));
    expect(journal).toBeLessThan(create.indexOf("where pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))) = clean_email"));
    expect(create.split("private.learning_actor_journal(")).toHaveLength(2);
    expect(create).not.toContain("invitation_row.id::text, caller, caller_org");
  });

  it("deletes no history: it counts the member-path entries the old code wrote and refuses the apply if there is any", () => {
    expect(flat(sql)).not.toMatch(/\bdelete\s+from\b/iu);
    expect(flat(sql)).toContain("from private.learning_action_journal j join public.member_invitations i on j.target_id = i.id::text where j.action_kind = 'invitation_send' and j.target_table = 'public.member_invitations' and i.source = 'member' and i.invited_by = j.actor_user_id;");
    expect(flat(sql)).toContain("if found_entries <> 0 then raise exception");
  });
});

describe("member-sent invitation learning journal (static)", () => {
  const sql = stripComments(loadMigrationSql("_member_sent_invitation_learning_journal"));

  it("is one atomic migration whose actor journal is service-role only, metadata-only and closed to every API role", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    const journal = stripComments(fnBody(sql, "private.learning_actor_journal"));
    expect(journal).toMatch(/as \$function\$\s*begin\s+perform private\.lock_case_graph\(array\[p_actor\], array\[\]::uuid\[\]\);/u);
    expect(journal).toContain("coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'");
    expect(journal).toContain("if kind.disposition <> 'permanent' then");
    expect(journal).toContain("m.user_id = p_actor and m.status = 'active'");
    expect(sql).toContain("revoke all on function private.learning_actor_journal(text, text, text, uuid, uuid) from public, anon, authenticated, service_role;");
    expect(sql).not.toMatch(/grant execute on function private\.learning_actor_journal/u);
  });

  it("journals the invitation right after it is created, for the verified sender in their organization", () => {
    const create = stripComments(fnBody(sql, "public.create_member_sent_invitation(p_actor uuid, p_email text, p_full_name text, p_locale text, p_token_hash text)"));
    const insert = create.indexOf("returning * into invitation_row;");
    const journal = create.indexOf("perform private.learning_actor_journal('invitation_send', 'public.member_invitations', invitation_row.id::text, caller, caller_org);");
    expect(insert).toBeGreaterThan(0);
    expect(journal).toBeGreaterThan(insert);
    expect(journal).toBeLessThan(create.indexOf("'invite_requested'"));
  });
});

// BUG-UG-REFERRAL-EDGES-REJOIN-BACKFILL-AND-INVITE-CAP-20261117 (#9046):
// member sends are counted in a chapter bucket of their own, so they can never
// use up the administrators' daily invitation allowance.
describe("member invitations have their own chapter allowance (static)", () => {
  const sql = stripComments(loadMigrationSql("_member_invitations_own_chapter_allowance"));
  const flat = (text) => text.replace(/\s+/gu, " ");
  const create = flat(stripComments(fnBody(sql, "public.create_member_sent_invitation(p_actor uuid, p_email text, p_full_name text, p_locale text, p_token_hash text)")));

  it("charges and refuses from the member chapter bucket, never the administrators' one", () => {
    expect(create).toContain("private.consume_member_invitation_admin_limit('member-chapter:' || home_chapter, 'chapter-day', private.organization_limit(caller_org, 'limits.security.invitation_chapter_daily'), interval '1 day')");
    expect(create).toContain("private.member_invitation_limit_refusal('member-chapter:' || home_chapter, 'chapter-day', 'limits.security.invitation_chapter_daily', interval '1 day')");
    expect(create).not.toContain("'chapter:' || home_chapter");
  });

  it("writes only the function, behind a predecessor guard: no table, row or grant change", () => {
    expect(sql.match(/create or replace function/giu)).toHaveLength(1);
    const guard = /do \$member_send_predecessor\$[\s\S]*?\$member_send_predecessor\$;/iu;
    expect(flat(sql.match(guard)[0])).toMatch(/is distinct from '[0-9a-f]{32}' then raise exception 'unreviewed predecessor: public\.create_member_sent_invitation' using errcode = '55000';/u);
    const outside = flat(sql.replace(guard, "").replace(/create or replace function[\s\S]*?\$function\$;/iu, "")).trim();
    expect(outside).toBe("begin; set local lock_timeout = '5s'; set local statement_timeout = '60s'; notify pgrst, 'reload schema'; commit;");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("member-sent invitations on a disposable database", () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false,
      application_name: "member-sent-invitations-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '20s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function inTransaction(body) {
    await client.query("begin");
    await releaseCalendarHolds(client);
    try {
      return await body();
    } finally {
      await client.query("rollback");
    }
  }

  async function tenant(label, { enabled = true, daily = null } = {}) {
    const org = randomUUID();
    const chapter = `${label}-a-${org}`;
    const second = `${label}-b-${org}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$3)", [org, `${label}-${org}`, `${label} ${org}`]);
    await client.query(
      "insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,'Home chapter',$1,'proof',$3,9961), ($2,'Second chapter',$2,'proof',$3,9962)",
      [chapter, second, org]);
    const setting = (key, value) => client.query(
      "insert into public.organization_setting_values(organization_id, setting_key, value) values ($1,$2,$3::jsonb) on conflict (organization_id, setting_key) do update set value=excluded.value",
      [org, key, JSON.stringify(value)]);
    if (enabled) await setting(SWITCH, true);
    if (daily !== null) await setting("limits.security.invitation_member_daily", daily);
    return { org, chapter, second };
  }

  async function person(t, { chapter = t.chapter, ageDays = 30, status = "active" } = {}) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email,created_at) values ($1,$2,now() - make_interval(days => $3))",
      [id, `${id}@example.invalid`, ageDays]);
    await client.query("update public.member_profiles set chapter_id=$2, full_name='Proof Sender' where id=$1", [id, chapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status,revoked_at) values ($1,$2,$3,case when $3 = 'revoked' then now() end) on conflict do nothing", [t.org, id, status]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, chapter]);
    return id;
  }

  async function admin(t) {
    const id = await person(t);
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'admin',$2)", [id, t.chapter]);
    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'admin',$2)", [id, t.chapter]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    return id;
  }

  // One statement as the given account (or the service role), inside a
  // savepoint so a refusal leaves the transaction usable.
  async function as(userId, statement, args = []) {
    await client.query("savepoint cell");
    try {
      if (userId === "service_role") {
        await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "service_role" })]);
        await client.query("set local role service_role");
      } else {
        const session = randomUUID();
        await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, userId]);
        await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: session })]);
        await client.query("set local role authenticated");
      }
      const result = await client.query(statement, args);
      await client.query("reset role");
      await client.query("release savepoint cell");
      return { ok: true, value: result.rows[0]?.v ?? null };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      await client.query("reset role");
      return { ok: false, code: error.code || "", message: error.message || "", detail: error.detail || "" };
    }
  }

  // As api/admin-invitations.js does it: the member's own session passes the
  // step-up check and names them, then the service role creates the
  // invitation for that member with a secret the server made.
  async function send(sender, secret = randomUUID(), email = `invitee-${randomUUID()}@example.invalid`) {
    const session = await as(sender, "select public.member_sent_invitation_session() as v");
    if (!session.ok) return { ...session, secret, email };
    expect(session.value).toBe(sender);
    const result = await as("service_role", "select public.create_member_sent_invitation($1,$2,'Proof Invitee','en',$3) as v", [sender, email, sha256(secret)]);
    return { ...result, secret, email };
  }
  const recordDelivery = (sender, invitationId) => as("service_role",
    "select public.record_member_sent_invitation_delivery($1,$2,1,'sent') as v", [sender, invitationId]);
  const invitation = async (id) => (await client.query(
    "select chapter_id, source, kind, initial_role, invited_by, status, normalized_email from public.member_invitations where id=$1", [id])).rows[0];

  // The acceptance endpoint's database steps for a new account
  // (api/accept-invitation.js): claim, the invitation-owned identity, finalize,
  // activation.
  async function accept(secret, { beforeComplete = async () => {} } = {}) {
    const claim = await as("service_role", "select public.claim_member_invitation($1) as v", [sha256(secret)]);
    expect(claim.ok, claim.message).toBe(true);
    expect(claim.value).toMatchObject({ available: true, kind: "provision" });
    const row = (await client.query("select * from public.member_invitations where id=$1", [claim.value.invitationId])).rows[0];
    const user = randomUUID();
    await client.query(
      `insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data,raw_app_meta_data,banned_until)
       values ($1,$2,now(),$3,$4,now() + interval '100 years')`,
      [user, row.normalized_email,
        JSON.stringify({ full_name: row.full_name, first_name: row.first_name, initials: row.initials,
          chapter_id: row.chapter_id, union_base_invitation_id: row.id }),
        JSON.stringify({ union_ground_provisioning: "pending" })]);
    const finalized = await as("service_role", "select public.finalize_member_invitation($1,$2) as v", [row.id, user]);
    expect(finalized.ok, finalized.message).toBe(true);
    await client.query(`update auth.users set raw_app_meta_data='{"union_ground_provisioning":"active"}', banned_until=null where id=$1`, [user]);
    // The account is usable from here, before the invitation is marked accepted.
    await beforeComplete(user);
    const completed = await as("service_role", "select public.complete_member_invitation_activation($1,$2) as v", [row.id, user]);
    expect(completed.ok, completed.message).toBe(true);
    return { user, invitationId: row.id };
  }

  it("creates exactly one account, in the sender's home chapter, and credits the sender", () => inTransaction(async () => {
    const t = await tenant("hwl7");
    // The sender also belongs to a second chapter; the invitation still goes to the home chapter.
    const sender = await person(t);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [sender, t.second]);
    const before = (await client.query("select count(*)::int as n from auth.users")).rows[0].n;
    const sent = await send(sender);
    expect(sent.ok, sent.message).toBe(true);
    expect(sent.value).toMatchObject({ accepted: true, send: true, deliveryVersion: 1 });
    expect(await invitation(sent.value.invitationId)).toMatchObject({
      chapter_id: t.chapter, source: "member", kind: "provision", initial_role: null, invited_by: sender, status: "pending" });
    const recorded = await recordDelivery(sender, sent.value.invitationId);
    expect(recorded).toEqual({ ok: true, value: { recorded: true } });

    const { user, invitationId } = await accept(sent.secret);
    expect(invitationId).toBe(sent.value.invitationId);
    expect((await client.query("select count(*)::int as n from auth.users")).rows[0].n).toBe(before + 1);
    expect((await client.query("select chapter_id from public.member_profiles where id=$1", [user])).rows).toEqual([{ chapter_id: t.chapter }]);
    expect((await client.query("select chapter_id from public.member_chapter_memberships where user_id=$1 and status='active'", [user])).rows)
      .toEqual([{ chapter_id: t.chapter }]);
    expect((await client.query("select status from public.member_invitations where id=$1", [invitationId])).rows[0].status).toBe("accepted");
    const referral = (await client.query("select referrer_user_id, organization_id, code from private.member_referrals where referred_user_id=$1", [user])).rows;
    const code = (await client.query("select private.member_referral_code($1) as c", [sender])).rows[0].c;
    expect(referral).toEqual([{ referrer_user_id: sender, organization_id: t.org, code }]);
    // A code typed at acceptance cannot move the credit, forged or not.
    const other = await person(t);
    const otherCode = (await client.query("select private.member_referral_code($1) as c", [other])).rows[0].c;
    const typed = await as("service_role", "select public.record_member_referral($1,$2) as v", [invitationId, otherCode]);
    expect(typed).toEqual({ ok: true, value: { recorded: false } });
    const forged = await as("service_role", "select public.record_member_referral($1,'ZZZZ') as v", [invitationId]);
    expect(forged.value).toMatchObject({ recorded: false, reason: "invalid-code" });
    expect((await client.query("select count(*)::int as n from private.member_referrals where referred_user_id=$1", [user])).rows[0].n).toBe(1);
    // No suggestion row and no other copy of the invitee's address.
    expect((await client.query("select count(*)::int as n from public.member_requests where requester_user_id=$1", [sender])).rows[0].n).toBe(0);
  }));

  // Sol gate round 1, r1s2: the route activates the account before it
  // completes the invitation, so a check-in can land in between; the referral
  // recorded at completion pays for it at once.

  it("refuses with the switch off, a removed or new account, and keeps each organization's invitations in it", () => inTransaction(async () => {
    const off = await tenant("rtl9", { enabled: false });
    const offSender = await person(off);
    expect(await send(offSender)).toMatchObject({ ok: false, code: "42501", message: "member invitations not permitted" });

    const t = await tenant("hwl7");
    const fresh = await person(t, { ageDays: 2 });
    expect(await send(fresh)).toMatchObject({ ok: false, code: "42501" });
    const removed = await person(t, { status: "revoked" });
    expect(await send(removed)).toMatchObject({ ok: false, code: "42501" });
    // A member of the other organization, with its switch on, invites only into their own chapter there.
    const other = await tenant("rtl9");
    const outsider = await person(other);
    const sent = await send(outsider);
    expect(sent.ok, sent.message).toBe(true);
    expect((await invitation(sent.value.invitationId)).chapter_id).toBe(other.chapter);
    // Control: an eligible member of the first organization sends.
    const control = await send(await person(t));
    expect(control.ok, control.message).toBe(true);
    // The other member cannot record delivery for someone else's invitation.
    const foreign = await recordDelivery(outsider, control.value.invitationId);
    expect(foreign).toEqual({ ok: true, value: { recorded: false } });
  }));

  it("holds the per-member daily limit, charged before the duplicate answer", () => inTransaction(async () => {
    const t = await tenant("hwl7", { daily: 2 });
    const sender = await person(t);
    const email = `repeat-${randomUUID()}@example.invalid`;
    const first = await send(sender, randomUUID(), email);
    expect(first.value).toMatchObject({ send: true });
    // The same address again answers accepted and sends nothing, but still counts.
    const duplicate = await send(sender, randomUUID(), email);
    expect(duplicate.value).toEqual({ accepted: true, send: false });
    const third = await send(sender);
    expect(third).toMatchObject({ ok: false, code: "P0001", message: "invitation rate limited" });
    expect(JSON.parse(third.detail)).toMatchObject({ limit: "limits.security.invitation_member_daily" });
    expect(Number.isFinite(Date.parse(JSON.parse(third.detail).retryAt))).toBe(true);
    // Another member of the same chapter still has their own allowance.
    expect((await send(await person(t))).ok).toBe(true);
  }));

  it("lets an administrator see, resend and revoke a member-sent invitation, and keeps the credit with the sender", () => inTransaction(async () => {
    const t = await tenant("hwl7");
    const sender = await person(t);
    const chief = await admin(t);
    const sent = await send(sender);
    expect(sent.ok, sent.message).toBe(true);
    const listed = await as(chief, "select public.get_member_invitations(50) as v");
    expect(listed.ok, listed.message).toBe(true);
    expect(listed.value.items.find((item) => item.id === sent.value.invitationId))
      .toMatchObject({ source: "member", sentByMemberName: "Proof Sender", chapterId: t.chapter });

    const secret = randomUUID();
    const resent = await as(chief, "select public.resend_member_invitation($1,$2) as v", [sent.value.invitationId, sha256(secret)]);
    expect(resent.ok, resent.message).toBe(true);
    const resentRow = await invitation(resent.value.invitationId);
    expect(resentRow).toMatchObject({ source: "member", invited_by: chief });
    expect((await client.query("select private.member_sent_invitation_sender($1) as s", [resent.value.invitationId])).rows[0].s).toBe(sender);
    const { user } = await accept(secret);
    expect((await client.query("select referrer_user_id from private.member_referrals where referred_user_id=$1", [user])).rows)
      .toEqual([{ referrer_user_id: sender }]);

    const pending = await send(sender);
    const revoked = await as(chief, "select public.revoke_member_invitation($1) as v", [pending.value.invitationId]);
    expect(revoked.ok, revoked.message).toBe(true);
    expect((await invitation(pending.value.invitationId)).status).toBe("revoked");
    const claim = await as("service_role", "select public.claim_member_invitation($1) as v", [sha256(pending.secret)]);
    expect(claim.value).toMatchObject({ available: false });
  }));

  // Opus gate round 1, P1-1: a member cannot create an invitation with a
  // secret they chose, record its delivery, or claim with that secret.
  it("refuses a member's direct call with a secret they chose, so no link they hold can ever be claimed", () => inTransaction(async () => {
    const t = await tenant("hwl7");
    const sender = await person(t);
    const chosen = randomUUID();
    const email = `stranger-${randomUUID()}@example.invalid`;
    const direct = await as(sender, "select public.create_member_sent_invitation($1,$2,'Some Stranger','en',$3) as v", [sender, email, sha256(chosen)]);
    expect(direct).toMatchObject({ ok: false, code: "42501" });
    expect(direct.message).toMatch(/permission denied/u);
    // Another member's id passed by a member makes no difference.
    const other = await person(t);
    expect(await as(sender, "select public.create_member_sent_invitation($1,$2,'Some Stranger','en',$3) as v", [other, email, sha256(chosen)]))
      .toMatchObject({ ok: false, code: "42501" });
    expect((await client.query("select count(*)::int as n from public.member_invitations where normalized_email=$1", [email])).rows[0].n).toBe(0);
    const claim = await as("service_role", "select public.claim_member_invitation($1) as v", [sha256(chosen)]);
    expect(claim.value).toMatchObject({ available: false });
    // The delivery recorder is closed to members too, even for their own invitation.
    const sent = await send(sender);
    expect(sent.ok, sent.message).toBe(true);
    expect(await as(sender, "select public.record_member_sent_invitation_delivery($1,$2,1,'sent') as v", [sender, sent.value.invitationId]))
      .toMatchObject({ ok: false, code: "42501" });
    // A member cannot learn whether an address has an account: no answer
    // reaches them.
    expect(await as(sender, "select public.create_member_sent_invitation($1,$2,'Some Stranger','en',$3) as v", [sender, `${sender}@example.invalid`, sha256(randomUUID())]))
      .toMatchObject({ ok: false, code: "42501" });
    // The session check refuses a session that has not passed its step-up, and a call with no session.
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), sender]);
    await client.query("savepoint aal1");
    const session = randomUUID();
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal1',now(),now())", [session, sender]);
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: sender, role: "authenticated", aal: "aal1", session_id: session })]);
    await client.query("set local role authenticated");
    await expect(client.query("select public.member_sent_invitation_session()")).rejects.toMatchObject({ code: "42501" });
    await client.query("rollback to savepoint aal1");
    await client.query("reset role");
    // Each member's session check names only that member.
    expect(await as(other, "select public.member_sent_invitation_session() as v")).toEqual({ ok: true, value: other });
  }));

  // Sol final r3s1: the same input gets the same answer whatever the address
  // holds. A first word over the table's 80-character first_name used to pass
  // for an existing account or live invitation and fail only for an unused one.
  it("refuses a first name over 80 characters identically for an unused address, an existing account and a live invitation", () => inTransaction(async () => {
    const t = await tenant("hwl7");
    const sender = await person(t);
    const existing = await person(t);
    const live = await send(sender);
    expect(live.ok, live.message).toBe(true);
    const tooLong = `${"A".repeat(81)} Invitee`;
    const create = (email, name) => as("service_role",
      "select public.create_member_sent_invitation($1,$2,$3,'en',$4) as v", [sender, email, name, sha256(randomUUID())]);
    const answers = [];
    for (const email of [`unused-${randomUUID()}@example.invalid`, `${existing}@example.invalid`, live.email]) {
      answers.push(await create(email, tooLong));
    }
    for (const answer of answers) expect(answer).toMatchObject({ ok: false, code: "22023", message: "invalid invitation request" });
    expect(new Set(answers.map((answer) => `${answer.code}:${answer.message}`)).size).toBe(1);
    // The 80-character boundary is accepted, so the refusal is the length and nothing else.
    const boundary = await create(`boundary-${randomUUID()}@example.invalid`, `${"A".repeat(80)} Invitee`);
    expect(boundary.ok, boundary.message).toBe(true);
    expect(boundary.value).toMatchObject({ send: true });
  }));

  // Sol final r5s1: an organization that has not cleared the signup boundary
  // may hold 20 invitations in 24 hours and 200 in all. At either cap an
  // unused address used to reach the boundary trigger and be refused while an
  // existing account or a live invitation was accepted.
  it.each([
    ["the 24-hour cap of 20", { recent: 20, older: 0 }],
    ["the cap of 200 in all", { recent: 1, older: 199 }],
  ])("at %s, refuses an unused address, an existing account and a live invitation identically", (_, seed) => inTransaction(async () => {
    const t = await tenant("hwl7");
    await client.query("update public.organizations set self_serve_created_at = now() - interval '30 days', verified_at = null where id = $1", [t.org]);
    const sender = await person(t);
    const existing = await person(t);
    const live = await send(sender);
    expect(live.ok, live.message).toBe(true);
    // The live invitation is one recent row; the rest fill the cap.
    const fill = (count, age) => client.query(
      `insert into public.member_invitations(normalized_email,full_name,first_name,initials,chapter_id,locale,status,delivery_version,invited_by,expires_at,created_at)
       select 'cap-' || g || '-' || $1::text || '@example.invalid', 'Cap Invitee', 'Cap', 'CI', $2, 'en', 'expired', 1, $3,
              now() - $4::interval + interval '15 minutes', now() - $4::interval
         from pg_catalog.generate_series(1, $5::int) g`, [randomUUID(), t.chapter, sender, age, count]);
    if (seed.recent > 1) await fill(seed.recent - 1, "1 hour");
    if (seed.older) await fill(seed.older, "3 days");
    const create = (email) => as("service_role",
      "select public.create_member_sent_invitation($1,$2,'Proof Invitee','en',$3) as v", [sender, email, sha256(randomUUID())]);
    const answers = [];
    for (const email of [`unused-${randomUUID()}@example.invalid`, `${existing}@example.invalid`, live.email]) answers.push(await create(email));
    for (const answer of answers) expect(answer).toMatchObject({ ok: false, code: "P0001", message: "invitation rate limited", detail: "" });
    // Below the cap the same organization still accepts.
    await client.query("delete from public.member_invitations where normalized_email like 'cap-%' and chapter_id = $1", [t.chapter]);
    expect((await create(`unused-${randomUUID()}@example.invalid`)).ok).toBe(true);
  }));

  it("refuses a member-sent row that grants access, and keeps client roles off the new functions", () => inTransaction(async () => {
    const t = await tenant("hwl7");
    const sender = await person(t);
    await client.query("savepoint s");
    await expect(client.query(
      `insert into public.member_invitations(normalized_email,full_name,first_name,initials,chapter_id,initial_role,locale,token_hash,status,delivery_version,invited_by,expires_at,source)
       values ($1,'Proof Invitee','Proof','PI',$2,'steward','en',$3,'pending',1,$4,now() + interval '15 minutes','member')`,
      [`role-${randomUUID()}@example.invalid`, t.chapter, sha256(randomUUID()), sender])).rejects.toMatchObject({ code: "23514" });
    await client.query("rollback to savepoint s");
    const privileges = (await client.query(`
      select p.proname, r.rolname, has_function_privilege(r.rolname, p.oid, 'execute') as can
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
       where (n.nspname, p.proname) in (('public','create_member_sent_invitation'), ('public','record_member_sent_invitation_delivery'),
         ('private','member_sent_invitation_sender'), ('private','record_member_sent_invitation_referral'), ('private','member_invitation_limit_refusal'),
         ('public','member_sent_invitation_session'))
       order by 1, 2`)).rows;
    const allowed = privileges.filter((row) => row.can).map((row) => `${row.proname}:${row.rolname}`);
    expect(allowed).toEqual(["create_member_sent_invitation:service_role", "member_sent_invitation_session:authenticated",
      "record_member_sent_invitation_delivery:service_role"]);
  }));

  // #8395: the sending member's practice history.
  const journalled = async (invitationId) => (await client.query(
    "select organization_id, actor_user_id, action_kind, state, kept_at is not null as kept from private.learning_action_journal where target_table = 'public.member_invitations' and target_id = $1",
    [String(invitationId)])).rows;
  // ends_at must be exactly starts_at plus length_days (organization_learning_periods_ends).
  const startPeriod = (t) => client.query(
    `insert into private.organization_learning_periods(organization_id, length_days, starts_at, ends_at)
     select $1, 14, s.at, s.at + make_interval(hours => 14 * 24) from (select now() - interval '1 minute' as at) s`, [t.org]);

  // #8767: the entry is the same for every address, so the member's own
  // history never tells an address with an account from a new one.
  it("journals the same entry for a new address, an address with an account and a live invitation, and the history shows them alike (#8767)", () => inTransaction(async () => {
    const t = await tenant("hwl7", { daily: 10 });
    const sender = await person(t);
    const holder = await person(t);
    await startPeriod(t);
    const fresh = await send(sender);
    expect(fresh).toMatchObject({ ok: true, value: { accepted: true, send: true } });
    const taken = await send(sender, randomUUID(), `${holder}@example.invalid`);
    expect(taken).toMatchObject({ ok: true, value: { accepted: true, send: false } });
    const live = await send(sender, randomUUID(), fresh.email);
    expect(live).toMatchObject({ ok: true, value: { accepted: true, send: false } });

    const rows = (await client.query(
      `select organization_id, actor_user_id, action_kind, target_table, target_id, state, kept_at is not null as kept
         from private.learning_action_journal where actor_user_id = $1 order by created_at, id`, [sender])).rows;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect({ ...row, target_id: undefined }).toEqual({ organization_id: t.org, actor_user_id: sender, action_kind: "invitation_send",
        target_table: "public.member_invitations", target_id: undefined, state: "kept", kept: true });
      // A fresh id that names no invitation, never the one created.
      expect(row.target_id).toMatch(/^[0-9a-f-]{36}$/u);
      expect((await client.query("select count(*)::int as n from public.member_invitations where id::text = $1", [row.target_id])).rows[0].n).toBe(0);
    }
    expect(new Set(rows.map((row) => row.target_id)).size).toBe(3);
    expect(await journalled(fresh.value.invitationId)).toEqual([]);

    const history = await as(sender, "select public.list_my_learning_history() as v");
    expect(history.ok, history.message).toBe(true);
    const shape = (entry) => ({ ...entry, id: undefined, targetId: undefined, createdAt: undefined, keptAt: undefined });
    expect(history.value.entries).toHaveLength(3);
    expect(new Set(history.value.entries.map((entry) => JSON.stringify(shape(entry)))).size).toBe(1);
    expect(shape(history.value.entries[0])).toMatchObject({ actionKind: "invitation_send", targetTable: "public.member_invitations", state: "kept", sent: true });
  }));

  // #8767: the migration's own guard, run as written. Zero old member-path
  // entries pass; one makes the apply refuse with nothing written.
  const GUARD = /do \$member_path_entries_guard\$[\s\S]*?\$member_path_entries_guard\$;/u
    .exec(loadMigrationSql("_member_send_history_same_for_every_address"))[0];
  it("refuses the apply while an old member-path history entry exists, and passes with none (#8767)", () => inTransaction(async () => {
    const t = await tenant("hwl7");
    const sender = await person(t);
    await client.query("savepoint guard");
    await client.query(GUARD);
    await client.query("release savepoint guard");
    // An entry the old code wrote: its target is the member's own sent invitation.
    const sent = await send(sender);
    expect(sent.ok, sent.message).toBe(true);
    await startPeriod(t);
    const period = (await client.query("select id from private.organization_learning_periods where organization_id = $1", [t.org])).rows[0].id;
    await client.query(
      `insert into private.learning_action_journal (organization_id, period_id, actor_user_id, action_kind, target_table, target_id, state, kept_at)
       values ($1, $2, $3, 'invitation_send', 'public.member_invitations', $4, 'kept', clock_timestamp())`,
      [t.org, period, sender, sent.value.invitationId]);
    await client.query("savepoint guard");
    await expect(client.query(GUARD)).rejects.toMatchObject({ code: "55000", message: expect.stringContaining("found 1 member-sent invitation_send learning history entries") });
    await client.query("rollback to savepoint guard");
    expect((await client.query("select count(*)::int as n from private.learning_action_journal where actor_user_id = $1", [sender])).rows[0].n).toBe(1);
  }));

  it("journals nothing outside a learning period, and keeps the actor journal off every API role", () => inTransaction(async () => {
    const t = await tenant("hwl7");
    const sent = await send(await person(t));
    expect(sent.ok, sent.message).toBe(true);
    expect(await journalled(sent.value.invitationId)).toEqual([]);
    const roles = (await client.query(`
      select r.rolname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
       where n.nspname = 'private' and p.proname = 'learning_actor_journal' and has_function_privilege(r.rolname, p.oid, 'execute')`)).rows;
    expect(roles).toEqual([]);
    const direct = await as("service_role",
      "select private.learning_actor_journal('invitation_send', 'public.member_invitations', 'x', $1, $2) as v", [randomUUID(), t.org]);
    expect(direct).toMatchObject({ ok: false, code: "42501" });
  }));

  // #9046: members share one daily chapter allowance of their own; the
  // administrators' chapter bucket is never charged by a member send and a
  // full administrators' bucket never refuses a member.
  it("keeps the members' chapter allowance apart from the administrators'", () => inTransaction(async () => {
    const t = await tenant("hwl7");
    await client.query(
      "insert into public.organization_setting_values(organization_id, setting_key, value) values ($1,'limits.security.invitation_chapter_daily','2'::jsonb)",
      [t.org]);
    const adminBucket = async () => (await client.query(
      "select request_count from private.member_invitation_admin_limits where scope_key=$1 and operation='chapter-day'",
      [`chapter:${t.chapter}`])).rows[0]?.request_count ?? 0;
    expect((await send(await person(t))).ok).toBe(true);
    expect((await send(await person(t))).ok).toBe(true);
    const third = await send(await person(t));
    expect(third).toMatchObject({ ok: false, code: "P0001", message: "invitation rate limited" });
    expect(JSON.parse(third.detail)).toMatchObject({ limit: "limits.security.invitation_chapter_daily" });
    expect(Number.isFinite(Date.parse(JSON.parse(third.detail).retryAt))).toBe(true);
    // The members used up their own allowance; the administrators' is untouched.
    expect(await adminBucket()).toBe(0);
    const adminCharge = await client.query(
      "select private.consume_member_invitation_admin_limit($1, 'chapter-day', 2, interval '1 day') as v", [`chapter:${t.chapter}`]);
    expect(adminCharge.rows[0].v).toBe(true);

    // The other way round: a full administrators' bucket refuses no member.
    const other = await tenant("rtl9");
    await client.query(
      "insert into public.organization_setting_values(organization_id, setting_key, value) values ($1,'limits.security.invitation_chapter_daily','2'::jsonb)",
      [other.org]);
    await client.query(
      "insert into private.member_invitation_admin_limits(scope_key, operation, window_started_at, request_count) values ($1,'chapter-day',clock_timestamp(),2)",
      [`chapter:${other.chapter}`]);
    expect((await send(await person(other))).ok).toBe(true);
  }));
});
