// @vitest-environment node
//
// UX-UG-ROSTER-IMPORT-TAKES-DAYS-20261018
//
// A chapter administrator importing a roster from CSV gets roster-only limits
// (100 per administrator per hour, 500 per chapter per day by default) and
// 7-day links; ad-hoc invitations keep 10, 50 and 15 minutes. A roster limit
// refusal names the setting and when it opens again. Two fictional tenants
// (Harbor Workers Local 7, Ridge Transit Local 9); every row is rolled back.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261022171700_roster_invitation_import";
const ROSTER = "public.create_roster_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_locale text, p_token_hash text)";
const RESEND = "public.resend_member_invitation(p_invitation_id uuid, p_token_hash text)";
const RETRY = "private.member_invitation_limit_retry_at(p_scope_key text, p_operation text, p_window interval)";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const HASH = (pair) => pair.repeat(32);

describe("roster invitation import (static)", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));
  const roster = stripComments(fnBody(sql, ROSTER));
  const resend = stripComments(fnBody(sql, RESEND));

  it("is one atomic migration that leaves the ad-hoc create alone", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).not.toMatch(/function public\.create_member_invitation\(/);
    expect(sql).toContain("check (source in ('adhoc', 'roster'))");
    // The roster windows are new operations in the existing throttle table.
    expect(sql).toContain("check (operation in ('create-hour', 'chapter-day', 'resend-hour', 'invitation-resend-hour', 'roster-hour', 'roster-day', 'roster-lookup-hour'))");
  });

  it("names the default roster limits once, in the settings definitions", () => {
    expect(sql).toContain("('limits.security.invitation_roster_admin_hourly', 'integer'");
    expect(sql).toMatch(/'100'::jsonb, 1, 500, null, 2681, 'security', false/);
    expect(sql).toContain("('limits.security.invitation_roster_chapter_daily', 'integer'");
    expect(sql).toMatch(/'500'::jsonb, 1, 2500, null, 2682, 'security', false/);
    expect(sql).toContain("on conflict (key) do nothing;");
  });

  it("keeps roster import to chapter administrators behind the desk gate, counting before any lookup", () => {
    expect(roster).toMatch(/\$function\$\s*begin\s+perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\s*declare/);
    expect(roster).toContain("caller_chapter text := private.require_member_invitation_inviter_chapter();");
    expect(roster).toContain("not private.member_has_chapter_role(caller_chapter, array['admin'])");
    expect(roster).not.toContain("member_invitation_chapter_presided");
    expect(roster.indexOf("member_invitation_chapter_administrable(target_chapter)")).toBeLessThan(roster.indexOf("consume_member_invitation_admin_limit"));
    // Order (61021-2220, option b): charge the lookup throttle,
    // then answer existing accounts and live invitations, then charge the
    // sending allowance. Every searched position must exist (no vacuous -1).
    const at = (needle) => { const index = roster.indexOf(needle); expect(index, needle).toBeGreaterThanOrEqual(0); return index; };
    const lookupCharge = at("'roster-lookup-hour'");
    const accountNoOp = at("from auth.users u");
    const liveNoOp = at("i.status = 'accepting' or (i.status = 'pending' and i.expires_at > clock_timestamp())");
    const sendCharge = at("'roster-hour'");
    expect(lookupCharge).toBeLessThan(accountNoOp);
    // A malformed request is refused before the lookup charge and the account
    // probe, alike for every address.
    expect(at("raise exception 'invalid invitation request'")).toBeLessThan(lookupCharge);
    // The derived first name is validated with the other inputs (first_name is
    // capped at 80), and everything after the charge is one subtransaction
    // whose failure returns a refusal.
    expect(at("pg_catalog.char_length(coalesce(clean_first, '')) not between 1 and 80")).toBeLessThan(lookupCharge);
    const guarded = at("exception when others then");
    expect(accountNoOp).toBeLessThan(guarded);
    expect(roster.lastIndexOf("begin", accountNoOp)).toBeGreaterThan(lookupCharge);
    expect(roster).toContain("return pg_catalog.jsonb_build_object('accepted', false, 'send', false, 'unavailable', true);");
    expect(lookupCharge).toBeLessThan(liveNoOp);
    expect(accountNoOp).toBeLessThan(sendCharge);
    expect(liveNoOp).toBeLessThan(sendCharge);
    // An accepted invitation alone never skips: only an account that still
    // exists does (a deleted account can be invited again).
    expect(roster).not.toMatch(/status in \('accepting', 'accepted'\)/);
    expect(roster).toContain("'roster-hour'");
    expect(roster).toContain("'roster-day'");
    expect(roster).toContain("clock_timestamp() + interval '7 days', 'roster'");
    expect(roster).toContain("raise exception 'invitation rate limited' using errcode = 'P0001',");
    // The sending charges refuse inside their own subtransaction and return a
    // result, so the lookup charge before them is never rolled back
    const sendBlock = at("exception when sqlstate 'P0001' then");
    expect(sendCharge).toBeLessThan(sendBlock);
    expect(lookupCharge).toBeLessThan(roster.lastIndexOf("begin", sendCharge));
    expect(roster).toContain("'accepted', false, 'send', false, 'rateLimited', true,");
    expect(roster).toContain("if refused_operation = 'roster-hour' then");
    expect(sql).toMatch(/'1000'::jsonb, 1, 5000, null, 2683, 'security', false/);
    expect(sql).toContain("'roster-day', 'roster-lookup-hour'));");
    const list = stripComments(fnBody(sql, "public.get_member_invitations(p_limit integer default 50)"));
    expect(list).toContain("or (i.status = 'pending' and i.expires_at > clock_timestamp()))");
    expect(list).toContain("limit cap)");
    expect(sql).toContain("revoke all on function public.create_roster_member_invitation(text, text, text, text, text)\n  from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.create_roster_member_invitation(text, text, text, text, text)\n  to authenticated;");
    expect(sql).toContain("revoke all on function private.member_invitation_limit_retry_at(text, text, interval)\n  from public, anon, authenticated, service_role;");
  });

  it("keeps a resent roster invitation on 7 days and its source", () => {
    expect(resend).toContain("case when old_row.source = 'roster' then interval '7 days' else interval '15 minutes' end");
    expect(resend).toContain("replaces_id, expires_at, kind, source)");
    expect(resend).toContain("old_row.kind, old_row.source)");
  });

  it("pins the new functions, the resend lifetime and the source constraint in the database contract", () => {
    expect(contract.functions.find((row) => row.sig === ROSTER)).toMatchObject({ secdef: true, exec: "authenticated" });
    expect(contract.functions.find((row) => row.sig === RETRY)).toMatchObject({ secdef: true, exec: "" });
    expect(contract.functions.find((row) => row.sig === RESEND).bodyContains)
      .toContain("case when old_row.source = 'roster' then interval '7 days' else interval '15 minutes' end");
    expect(contract.constraints.find((row) => row.name === "member_invitations_source_check").defContains)
      // REQ-UG-MEMBER-SENT-INVITATIONS-20261111  adds the member source.
      .toEqual(["'adhoc'::text", "'roster'::text", "'member'::text"]);
    expect(contract.constraints.find((row) => row.name === "member_invitation_admin_limits_operation_check").defContains)
      .toEqual(expect.arrayContaining(["'roster-hour'::text", "'roster-day'::text", "'create-hour'::text", "'roster-lookup-hour'::text"]));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("roster invitation import on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "roster-invitation-import-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '10s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function tenants() {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const local = `hwl7-local-${orgA}`;
    const other = `rtl9-a-${orgB}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$3), ($4,$5,$6)",
      [orgA, `hwl7-${orgA}`, `Harbor Workers Local 7 ${orgA}`, orgB, `rtl9-${orgB}`, `Ridge Transit Local 9 ${orgB}`]);
    await client.query(
      `insert into public.chapters(id,name,slug,region,organization_id,order_index)
       values ($1,'Harbor Local',$1,'proof',$3,9971), ($2,'Ridge Chapter',$2,'proof',$4,9972)`,
      [local, other, orgA, orgB]);
    return { orgA, orgB, local, other };
  }

  async function holder(t, role, chapter) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [t.orgA, id]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, chapter]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
    return id;
  }

  async function actAs(userId) {
    const session = randomUUID();
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, userId]);
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: session })]);
    await client.query("set local role authenticated");
  }

  async function asOwner() {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims','',true)");
  }

  async function capture(statement, args) {
    await client.query("savepoint cell");
    try {
      const result = await client.query(statement, args);
      await client.query("release savepoint cell");
      return { ok: true, value: result.rows[0]?.v ?? null, code: "", message: "", detail: "" };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      return { ok: false, value: null, code: error.code || "", message: error.message || "", detail: error.detail || "" };
    }
  }

  const invitee = () => `roster-${randomUUID()}@example.invalid`;
  const rosterCreate = (chapter, hash, email = invitee()) => capture(
    "select public.create_roster_member_invitation($1,'Roster Invitee',$2,'en',$3) as v", [email, chapter, hash]);
  const adhocCreate = (chapter, hash, email = invitee()) => capture(
    "select public.create_member_invitation($1,'Ad Hoc Invitee',$2,null,'en',$3) as v", [email, chapter, hash]);
  const row = async (id) => (await client.query(
    "select source, initial_role, expires_at - created_at as lifetime from public.member_invitations where id=$1", [id])).rows[0];

  it("lets a chapter administrator create 7-day roster invitations and refuses a President and another organization", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const admin = await holder(t, "admin", t.local);
      const president = await holder(t, "vp", t.local);
      await actAs(admin);
      const created = await rosterCreate(t.local, HASH("c1"));
      const foreign = await rosterCreate(t.other, HASH("c2"));
      await asOwner();
      await actAs(president);
      const asPresident = await rosterCreate(t.local, HASH("c3"));
      const presidentAdhoc = await adhocCreate(t.local, HASH("c4"));
      await asOwner();

      expect(created.ok, created.message).toBe(true);
      expect(created.value).toMatchObject({ accepted: true, send: true, source: "roster" });
      expect(await row(created.value.invitationId)).toMatchObject({ source: "roster", initial_role: null });
      expect((await row(created.value.invitationId)).lifetime.days).toBe(7);
      expect(foreign).toMatchObject({ ok: false, code: "42501" });
      expect(asPresident).toMatchObject({ ok: false, code: "42501", message: "admin role required" });
      expect(presidentAdhoc.ok, presidentAdhoc.message).toBe(true);
      expect(await row(presidentAdhoc.value.invitationId)).toMatchObject({ source: "adhoc" });
    } finally {
      await client.query("rollback");
    }
  });

  it("refuses past the roster limit with the limit and retry time, while ad-hoc invitations keep their own count", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      await client.query(
        "insert into public.organization_setting_values(organization_id, setting_key, value) values ($1,$2,$3::jsonb) on conflict (organization_id, setting_key) do update set value=excluded.value",
        [t.orgA, "limits.security.invitation_roster_admin_hourly", "1"]);
      const admin = await holder(t, "admin", t.local);
      await actAs(admin);
      const first = await rosterCreate(t.local, HASH("d1"));
      const second = await rosterCreate(t.local, HASH("d2"));
      const adhoc = await adhocCreate(t.local, HASH("d3"));
      await asOwner();

      expect(first.ok, first.message).toBe(true);
      expect(second).toMatchObject({ ok: true, value: { accepted: false, send: false, rateLimited: true } });
      const detail = second.value;
      expect(detail.limit).toBe("limits.security.invitation_roster_admin_hourly");
      const retryAt = Date.parse(detail.retryAt);
      expect(retryAt).toBeGreaterThan(Date.now() + 55 * 60 * 1000);
      expect(retryAt).toBeLessThanOrEqual(Date.now() + 61 * 60 * 1000);
      expect(adhoc.ok, adhoc.message).toBe(true);
    } finally {
      await client.query("rollback");
    }
  });

  it("answers an address with a live invitation without spending the allowance, and reports the later reset when the day is spent too", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      for (const [key, value] of [["limits.security.invitation_roster_admin_hourly", "2"], ["limits.security.invitation_roster_chapter_daily", "2"]]) {
        await client.query(
          "insert into public.organization_setting_values(organization_id, setting_key, value) values ($1,$2,$3::jsonb) on conflict (organization_id, setting_key) do update set value=excluded.value",
          [t.orgA, key, value]);
      }
      const admin = await holder(t, "admin", t.local);
      const repeated = invitee();
      await actAs(admin);
      const first = await rosterCreate(t.local, HASH("f1"), repeated);
      const again = await rosterCreate(t.local, HASH("f2"), repeated);
      const againTwice = await rosterCreate(t.local, HASH("f3"), repeated);
      const second = await rosterCreate(t.local, HASH("f4"));
      const third = await rosterCreate(t.local, HASH("f5"));
      await asOwner();

      expect(first.ok, first.message).toBe(true);
      // Re-sending an address already invited spends nothing: two new
      // addresses still fit the limit of two.
      expect(again).toMatchObject({ ok: true, value: { accepted: true, send: false } });
      expect(againTwice).toMatchObject({ ok: true, value: { accepted: true, send: false } });
      expect(second.ok, second.message).toBe(true);
      // Both the hourly and the daily window are now spent: the refusal names
      // the daily limit and its later reset.
      expect(third).toMatchObject({ ok: true, value: { accepted: false, send: false, rateLimited: true } });
      const detail = third.value;
      expect(detail.limit).toBe("limits.security.invitation_roster_chapter_daily");
      expect(Date.parse(detail.retryAt)).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    } finally {
      await client.query("rollback");
    }
  });

  it("answers non-member accounts without spending the sending allowance, re-invites a deleted account, and stops at the lookup throttle", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      await client.query(
        "insert into public.organization_setting_values(organization_id, setting_key, value) values ($1,$2,$3::jsonb) on conflict (organization_id, setting_key) do update set value=excluded.value",
        [t.orgA, "limits.security.invitation_roster_admin_hourly", "1"]);
      const admin = await holder(t, "admin", t.local);
      // An account in no organization of this tenant.
      const outsider = randomUUID();
      const outsiderEmail = `${outsider}@example.invalid`;
      await client.query("insert into auth.users(id,email) values ($1,$2)", [outsider, outsiderEmail]);
      // A former member who accepted an invitation here, then deleted the account.
      const formerEmail = `former-${randomUUID()}@example.invalid`;
      await client.query(
        `insert into public.member_invitations (normalized_email, full_name, first_name, initials, chapter_id, locale, token_hash, status, delivery_version, invited_by, expires_at, accepted_at, source)
         values ($1, 'Former Member', 'Former', 'FM', $2, 'en', null, 'accepted', 1, $3, now() - interval '1 day', now() - interval '2 days', 'roster')`,
        [formerEmail, t.local, admin]);
      await actAs(admin);
      const nonMember = await rosterCreate(t.local, HASH("c5"), outsiderEmail);
      const nonMemberAgain = await rosterCreate(t.local, HASH("c6"), outsiderEmail);
      const reinvited = await rosterCreate(t.local, HASH("c7"), formerEmail);
      await asOwner();

      expect(nonMember).toMatchObject({ ok: true, value: { accepted: true, send: false } });
      expect(nonMemberAgain).toMatchObject({ ok: true, value: { accepted: true, send: false } });
      // The one-per-hour sending allowance was still free for the deleted
      // account's fresh invitation.
      expect(reinvited.ok, reinvited.message).toBe(true);
      expect(reinvited.value).toMatchObject({ send: true, source: "roster" });

      await client.query(
        "insert into public.organization_setting_values(organization_id, setting_key, value) values ($1,$2,$3::jsonb) on conflict (organization_id, setting_key) do update set value=excluded.value",
        [t.orgA, "limits.security.invitation_roster_lookup_hourly", "3"]);
      await actAs(admin);
      const overLookup = await rosterCreate(t.local, HASH("c8"), outsiderEmail);
      await asOwner();
      expect(overLookup).toMatchObject({ ok: false, code: "P0001" });
      expect(JSON.parse(overLookup.detail).limit).toBe("limits.security.invitation_roster_lookup_hourly");
    } finally {
      await client.query("rollback");
    }
  });

  it("keeps charging the lookup throttle once the sending allowance is spent, for unknown and existing addresses alike", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      for (const [key, value] of [["limits.security.invitation_roster_admin_hourly", "1"], ["limits.security.invitation_roster_lookup_hourly", "4"]]) {
        await client.query(
          "insert into public.organization_setting_values(organization_id, setting_key, value) values ($1,$2,$3::jsonb) on conflict (organization_id, setting_key) do update set value=excluded.value",
          [t.orgA, key, value]);
      }
      const admin = await holder(t, "admin", t.local);
      const existing = `${randomUUID()}@example.invalid`;
      await client.query("insert into auth.users(id,email) values ($1,$2)", [randomUUID(), existing]);
      const lookups = async () => (await client.query(
        "select coalesce(max(request_count), 0)::int n from private.member_invitation_admin_limits where scope_key = $1 and operation = 'roster-lookup-hour'",
        [`admin:${admin}`])).rows[0].n;
      await actAs(admin);
      const sent = await rosterCreate(t.local, HASH("e1"));
      const unknownPastCap = await rosterCreate(t.local, HASH("e2"));
      const existingPastCap = await rosterCreate(t.local, HASH("e3"), existing);
      const unknownAgain = await rosterCreate(t.local, HASH("e4"));
      const probe = await rosterCreate(t.local, HASH("e5"));
      await asOwner();

      expect(sent.ok, sent.message).toBe(true);
      // Past the one-per-hour sending allowance an unknown address is refused
      // as a result, and the lookup it cost stays charged, like an existing one.
      expect(unknownPastCap).toMatchObject({ ok: true, value: { accepted: false, send: false, rateLimited: true, limit: "limits.security.invitation_roster_admin_hourly" } });
      expect(existingPastCap).toMatchObject({ ok: true, value: { accepted: true, send: false } });
      expect(unknownAgain).toMatchObject({ ok: true, value: { rateLimited: true } });
      expect(await lookups()).toBe(4);
      // Probing stops at the lookup throttle whatever the address.
      expect(probe).toMatchObject({ ok: false, code: "P0001" });
      expect(JSON.parse(probe.detail).limit).toBe("limits.security.invitation_roster_lookup_hourly");
    } finally {
      await client.query("rollback");
    }
  });

  it("refuses a malformed request before any lookup, alike for existing and unknown addresses", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const admin = await holder(t, "admin", t.local);
      const existing = `${randomUUID()}@example.invalid`;
      await client.query("insert into auth.users(id,email) values ($1,$2)", [randomUUID(), existing]);
      const malformed = (email) => capture(
        "select public.create_roster_member_invitation($1,'X',$2,'en',$3) as v", [email, t.local, HASH("f0")]);
      await actAs(admin);
      const existingBad = await malformed(existing);
      const unknownBad = await malformed(invitee());
      await asOwner();
      expect(existingBad).toMatchObject({ ok: false, code: "22023" });
      expect(unknownBad).toMatchObject({ ok: false, code: "22023" });
      const charged = (await client.query(
        "select count(*)::int n from private.member_invitation_admin_limits where scope_key = $1 and operation = 'roster-lookup-hour'",
        [`admin:${admin}`])).rows[0].n;
      expect(charged).toBe(0);
    } finally {
      await client.query("rollback");
    }
  });

  it("refuses an overlong first name before any lookup, and keeps the lookup charge when a later step fails", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const admin = await holder(t, "admin", t.local);
      const lookups = async () => (await client.query(
        "select coalesce(max(request_count), 0)::int n from private.member_invitation_admin_limits where scope_key = $1 and operation = 'roster-lookup-hour'",
        [`admin:${admin}`])).rows[0].n;
      const longFirst = `${"A".repeat(81)} Member`;
      await actAs(admin);
      const overlong = await capture(
        "select public.create_roster_member_invitation($1,$2,$3,'en',$4) as v", [invitee(), longFirst, t.local, HASH("a8")]);
      await asOwner();
      expect(overlong).toMatchObject({ ok: false, code: "22023" });
      expect(await lookups()).toBe(0);

      await actAs(admin);
      const first = await rosterCreate(t.local, HASH("a9"));
      // A reused token hash fails the insert for an unknown address only; the
      // failure is a refusal and the lookup it cost stays charged.
      const reused = await rosterCreate(t.local, HASH("a9"));
      await asOwner();
      expect(first.ok, first.message).toBe(true);
      expect(reused).toMatchObject({ ok: true, value: { accepted: false, send: false, unavailable: true } });
      expect(await lookups()).toBe(2);
    } finally {
      await client.query("rollback");
    }
  });

  it("lists a 500-invitation roster beyond the history cap and resends and revokes later rows", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      await client.query(
        "insert into public.organization_setting_values(organization_id, setting_key, value) values ($1,$2,$3::jsonb) on conflict (organization_id, setting_key) do update set value=excluded.value",
        [t.orgA, "limits.security.invitation_roster_admin_hourly", "1"]);
      const admin = await holder(t, "admin", t.local);
      const member = await holder(t, "steward", t.local);
      const memberEmail = (await client.query("select email from auth.users where id=$1", [member])).rows[0].email;
      // A full day's roster must remain actionable beyond the history cap.
      await client.query(
        `insert into public.member_invitations (normalized_email, full_name, first_name, initials, chapter_id, locale, token_hash, status, delivery_version, invited_by, expires_at, source)
         select 'live-' || g || '-' || $3 || '@example.invalid', 'Live Invitee', 'Live', 'LI', $1, 'en', pg_catalog.lpad(pg_catalog.to_hex(g), 64, '0'), 'pending', 1, $2, now() + interval '7 days', 'roster'
         from pg_catalog.generate_series(1, 500) g`, [t.local, admin, t.orgA]);
      await actAs(admin);
      const existingMember = await rosterCreate(t.local, HASH("b1"), memberEmail);
      const fresh = await rosterCreate(t.local, HASH("b2"));
      const listed = await capture("select public.get_member_invitations(50) as v", []);
      await asOwner();

      // The current member spent nothing: the one-per-hour allowance still
      // admits a fresh address.
      expect(existingMember).toMatchObject({ ok: true, value: { accepted: true, send: false } });
      expect(fresh.ok, fresh.message).toBe(true);
      expect(listed.ok, listed.message).toBe(true);
      const live = listed.value.items.filter((item) => item.status === "pending" && item.chapterId === t.local);
      expect(live.length).toBe(501);
      expect(new Set(live.map((item) => item.id)).size).toBe(501);

      // Select by the returned order, so these really are beyond row 100 even
      // when fixture timestamps tie and the UUID tie-breaker decides ordering.
      const resendTarget = live[350];
      const revokeTarget = live[450];
      await actAs(admin);
      const resent = await capture("select public.resend_member_invitation($1,$2) as v", [resendTarget.id, HASH("b3")]);
      const revoked = await capture("select public.revoke_member_invitation($1) as v", [revokeTarget.id]);
      const refreshed = await capture("select public.get_member_invitations(50) as v", []);
      await asOwner();

      expect(resent.ok, resent.message).toBe(true);
      expect(resent.value).toMatchObject({ accepted: true, send: true, source: "roster" });
      expect((await row(resent.value.invitationId)).lifetime.days).toBe(7);
      expect(revoked.ok, revoked.message).toBe(true);
      expect(revoked.value).toMatchObject({ accepted: true, revoked: true });
      const retired = await client.query(
        "select id, status, token_hash from public.member_invitations where id = any($1::uuid[])",
        [[resendTarget.id, revokeTarget.id]]);
      expect(retired.rows).toEqual(expect.arrayContaining([
        { id: resendTarget.id, status: "superseded", token_hash: null },
        { id: revokeTarget.id, status: "revoked", token_hash: null },
      ]));
      expect(refreshed.ok, refreshed.message).toBe(true);
      const remaining = refreshed.value.items.filter((item) => item.status === "pending");
      expect(remaining).toHaveLength(500);
      expect(remaining.some((item) => item.id === resent.value.invitationId)).toBe(true);
      expect(remaining.some((item) => [resendTarget.id, revokeTarget.id].includes(item.id))).toBe(false);
    } finally {
      await client.query("rollback");
    }
  });

  it("keeps a resent roster invitation on 7 days and an ad-hoc one on 15 minutes", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const admin = await holder(t, "admin", t.local);
      await actAs(admin);
      const rosterRow = await rosterCreate(t.local, HASH("e1"));
      const adhocRow = await adhocCreate(t.local, HASH("e2"));
      const rosterResent = await capture("select public.resend_member_invitation($1,$2) as v", [rosterRow.value.invitationId, HASH("e3")]);
      const adhocResent = await capture("select public.resend_member_invitation($1,$2) as v", [adhocRow.value.invitationId, HASH("e4")]);
      await asOwner();

      expect(rosterResent.ok, rosterResent.message).toBe(true);
      expect(rosterResent.value).toMatchObject({ send: true, source: "roster" });
      const resentRoster = await row(rosterResent.value.invitationId);
      expect(resentRoster.source).toBe("roster");
      expect(resentRoster.lifetime.days).toBe(7);
      expect(adhocResent.ok, adhocResent.message).toBe(true);
      const resentAdhoc = await row(adhocResent.value.invitationId);
      expect(resentAdhoc.source).toBe("adhoc");
      expect(resentAdhoc.lifetime.days ?? 0).toBe(0);
      expect(resentAdhoc.lifetime.minutes).toBe(15);
    } finally {
      await client.query("rollback");
    }
  });
});
