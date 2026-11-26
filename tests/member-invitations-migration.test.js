// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fnBody, latestFnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { expectMi1OrganizationRlsContract } from "./helpers/mi1Contract.js";

const root = resolve(import.meta.dirname, "..");
const path = resolve(root, "supabase/migrations/20260812105000_member_invitation_provisioning.sql");
const source = readFileSync(path, "utf8");
const sql = stripComments(source).replace(/\s+/g, " ");
const lower = sql.toLowerCase();
const contract = JSON.parse(readFileSync(resolve(root, "scripts/db-contract.json"), "utf8"));
// TEST-UG-MIGRATION-TESTS-PIN-SUPERSEDED-RPC-DEFINITIONS-20260920: later
// migrations redefine most of these RPCs (the organization-scope foundation
// replaced the admin gate; the emailed-password finalize split activation out
// of finalization), so body assertions read the last definition in apply
// order. Table, grant and audit-vocabulary pins still read the origin file.
// #7663: the six-argument create is a wrapper that passes no unit; the caller
// boundary lives in the overload that takes the steward's unit, declared first
// in that migration.
const effective = (name) => name.replace(/^public\./, "") === "create_member_invitation"
  ? fnBody(stripComments(loadMigrationSql("stewards_require_unit_with_carry_over")), "public.create_member_invitation")
  : latestFnBody(name);
const effectiveLower = (name) => effective(name).toLowerCase();

describe("member invitation storage", () => {
  it("pins the live RPC-only tables and all invitation function grants", () => {
    const signatures = new Map(contract.functions.map((entry) => [entry.sig, entry.exec]));
    expectMi1OrganizationRlsContract(contract);
    for (const table of ["member_invitations", "member_invitation_audit"]) {
      expect(contract.policyCoverage.noPermissivePolicies).toContain(table);
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect(contract.tableGrants).toContainEqual(expect.objectContaining({
          table: `public.${table}`,
          role,
          privileges: "",
        }));
      }
    }
    expect(signatures.get("public.create_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_initial_role text, p_locale text, p_token_hash text)")).toBe("authenticated");
    expect(signatures.get("public.claim_member_invitation(p_token_hash text)")).toBe("service_role");
    expect(signatures.get("private.audit_member_invitation(p_invitation_id uuid, p_chapter_id text, p_actor uuid, p_action text, p_detail jsonb)")).toBe("");
  });

  it("stores a digest-only, short-lived, chapter-scoped lifecycle", () => {
    expect(lower).toContain("create table public.member_invitations");
    expect(lower).toContain("normalized_email text not null");
    expect(lower).toContain("token_hash text");
    expect(lower).toContain("check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$')");
    expect(lower).toContain("expires_at timestamptz not null");
    for (const state of ["pending", "accepting", "accepted", "revoked", "superseded", "delivery_failed", "expired"]) {
      expect(lower).toContain(`'${state}'`);
    }
    expect(lower).not.toMatch(/\b(token|secret)_(plain|plaintext|value)\b/);
    expect(lower).not.toContain("temporary_password");
  });

  it("permits one live normalized email and supports bounded admin reads", () => {
    expect(lower).toContain("create unique index member_invitations_one_live_email_idx");
    expect(lower).toContain("on public.member_invitations (normalized_email)");
    expect(lower).toContain("where status in ('pending', 'accepting')");
    expect(lower).toContain("create index member_invitations_chapter_created_idx");
    expect(lower).toContain("create unique index member_invitations_token_hash_idx");
    expect(lower).toContain("where token_hash is not null");
  });

  it("retains accepted history without blocking later Auth-user deletion", () => {
    expect(lower).toContain("auth_user_id uuid references auth.users(id) on delete set null");
    expect(lower).toContain("status = 'accepted' and token_hash is null and accepted_at is not null");
    expect(lower).not.toContain("status = 'accepted' and token_hash is null and accepted_at is not null and auth_user_id is not null");
  });

  it("keeps invitation and audit tables RPC-only for browser roles", () => {
    for (const table of ["member_invitations", "member_invitation_audit"]) {
      expect(lower).toContain(`alter table public.${table} enable row level security`);
      expect(lower).toContain(`revoke all on public.${table} from public, anon, authenticated`);
      expect(lower).not.toMatch(new RegExp(`grant\\s+(select|insert|update|delete|all)[^;]*public\\.${table}[^;]*authenticated`, "i"));
      expect(lower).toContain(`create policy mfa_assurance on public.${table}`);
      expect(lower).toContain(`on public.${table} as restrictive for all to authenticated`);
    }
  });
});

describe("member invitation caller boundary", () => {
  const callers = [
    ["create_member_invitation", "text, text, text, text, text, text"],
    ["resend_member_invitation", "uuid, text"],
    ["revoke_member_invitation", "uuid"],
    ["record_member_invitation_delivery", "uuid, integer, text"],
    ["get_member_invitations", "integer"],
  ];

  it("evaluates invitation administration from a later definition than the origin", () => {
    for (const [name] of callers) {
      expect(effective(name), name).not.toBe(fnBody(source, name));
    }
  });

  it.each(callers)("%s is an admin+MFA caller RPC with a narrow grant", (name, args) => {
    const body = effectiveLower(name);
    expect(body).toContain("security definer");
    expect(body).toMatch(/set search_path (?:=|to) ''/);
    // The effective gate is a chapter role in the caller's resolved chapter,
    // not the retired account-global admin check: the admin role, or (owner
    // decision October 4, 2026, BUG-UG-CHAPTER-PRESIDENT-CANNOT-INVITE-20261003)
    // the chapter-scoped President role, re-verified under the same locks.
    expect(body).toContain("caller_chapter text := private.require_member_invitation_inviter_chapter();");
    expect(body).toContain("or not (private.member_has_chapter_role(caller_chapter, array['admin'])\n             or private.member_invitation_chapter_presided(caller_chapter)) then");
    expect(body).not.toContain("public.member_has_role(array['admin'])");
    expect(body).toContain("errcode = '42501'");
    expect(lower).toContain(`revoke all on function public.${name}(${args}) from public, anon, authenticated`);
    expect(lower).toContain(`grant execute on function public.${name}(${args}) to authenticated`);
  });

  // BUG-UG-INVITE-CHAPTER-LOCKED-TO-CURRENT-CHAPTER-20261003 widened
  // "the caller's chapter" to "a chapter the caller administers in the
  // selected organization"; tests/invitation-target-chapter-admin-db.test.js
  // proves the boundary live.
  it("binds create to an administered chapter of the selected organization and the least-privilege role set", () => {
    const body = effectiveLower("create_member_invitation");
    expect(body).toContain("as_admin := private.member_invitation_chapter_administrable(target_chapter);");
    expect(body).toContain("if not as_admin and (clean_role is not null\n     or not private.member_invitation_chapter_presided(target_chapter)) then");
    expect(body).not.toContain("p_chapter_id is distinct from caller_chapter");
    // October 31 owner ruling: chapter Admin and the two records offices are
    // granted only when the invitee accepts an administered-chapter invitation.
    // This edition also invites organizers (20261015160000_unionground_organizer_invitations).
    expect(body).toContain("clean_role not in ('steward', 'organizer', 'coordinator', 'advisor', 'vp', 'admin', 'secretary', 'records', 'treasurer')");
    expect(body).toContain("coalesce(auth.jwt()->>'aal','')<>'aal2'");
    expect(body).toContain("not private.has_second_factor(caller)");
    expect(body).toContain("interval '15 minutes'");
    expect(body).toContain("pg_catalog.pg_advisory_xact_lock");
  });

  it("counts every create request before duplicate/existing-account no-ops", () => {
    const body = effectiveLower("create_member_invitation");
    const rate = body.indexOf("private.consume_member_invitation_admin_limit");
    const existing = body.indexOf("from auth.users");
    const duplicate = body.indexOf("from public.member_invitations");
    expect(rate).toBeGreaterThan(-1);
    expect(existing).toBeGreaterThan(rate);
    expect(duplicate).toBeGreaterThan(rate);
    expect(body).toContain("'accepted', true");
    expect(body).toContain("'send', false");
  });

  it("scopes list/resend/revoke independently to the chapters the caller administers", () => {
    for (const name of ["get_member_invitations", "resend_member_invitation", "revoke_member_invitation"]) {
      const body = effectiveLower(name);
      expect(body).toContain("caller_chapter");
      expect(body).toContain("private.member_invitation_chapter_administrable(");
      expect(body).not.toContain("chapter_id = caller_chapter");
    }
  });
});

describe("member invitation acceptance boundary", () => {
  const serviceOnly = [
    ["consume_member_invitation_accept_limit", "text"],
    ["claim_member_invitation", "text"],
    ["get_member_invitation_recovery_user", "uuid"],
    ["finalize_member_invitation", "uuid, uuid"],
    ["fail_member_invitation_accept", "uuid, text"],
  ];

  it.each(serviceOnly)("%s is service-role-only", (name, args) => {
    // #7663 re-emits finalize in pg_get_functiondef's canonical form.
    const body = effectiveLower(name);
    expect(body).toContain("security definer");
    expect(body).toMatch(/set search_path (?:=|to) ''/);
    expect(lower).toContain(`revoke all on function public.${name}(${args}) from public, anon, authenticated, service_role`);
    expect(lower).toContain(`grant execute on function public.${name}(${args}) to service_role`);
    expect(lower).not.toContain(`grant execute on function public.${name}(${args}) to authenticated`);
  });

  it("recovery identifies only the exact invitation-owned Auth user", () => {
    const body = effectiveLower("get_member_invitation_recovery_user");
    expect(body).toContain("status = 'accepting'");
    expect(body).toContain("raw_user_meta_data ->> 'union_base_invitation_id'");
    expect(body).toContain("pg_catalog.lower(u.email) = invitation_row.normalized_email");
    expect(body).toContain("'confirmed', user_row.email_confirmed_at is not null");
    expect(body).not.toContain("delete from auth.users");
  });

  it("atomically claims only one current digest and makes replay unavailable", () => {
    const body = effectiveLower("claim_member_invitation");
    expect(body).toContain("status = 'accepting'");
    expect(body).toContain("status = 'pending'");
    expect(body).toContain("expires_at <= clock_timestamp()");
    expect(body).toContain("for update");
    expect(body).toContain("'available', false");
  });

  it("distinguishes a recoverable active lease with a bounded retry delay", () => {
    const body = effectiveLower("claim_member_invitation");
    expect(body).toContain("create or replace function public.claim_member_invitation");
    expect(body).toContain("'cause', 'acceptance-in-progress'");
    expect(body).toContain("'retryafterseconds', retry_after");
    expect(body).toContain("greatest(");
    expect(body).toContain("least(");
    expect(body).toContain("120");
    expect(body).toContain("interval '2 minutes'");
    expect(body.indexOf("accept_attempts >= 3")).toBeLessThan(body.indexOf("'acceptance-in-progress'"));
  });

  it("hands an exhausted, lapsed lease back for release instead of leaving it accepting", () => {
    const body = effectiveLower("claim_member_invitation");
    const exhausted = body.slice(body.indexOf("accept_attempts >= 3"), body.indexOf("recovery := true"));
    // While the last attempt's lease is live the claim answers the bounded
    // in-progress wait, never a bare unavailable the page reads as terminal.
    const live = exhausted.slice(0, exhausted.indexOf("'acceptance-exhausted'"));
    expect(live).toContain("interval '2 minutes' > clock_timestamp()");
    expect(live).toContain("'cause', 'acceptance-in-progress'");
    expect(live).toContain("'retryafterseconds', retry_after");
    expect(live).not.toMatch(/return pg_catalog\.jsonb_build_object\('available', false\);/);
    // After it lapses the row is re-leased and its id returned, never claimed.
    expect(exhausted).toContain("set accepting_at = clock_timestamp()");
    expect(exhausted).toContain("'cause', 'acceptance-exhausted'");
    expect(exhausted).toContain("'invitationid', invitation_row.id");
    expect(exhausted).not.toContain("accept_attempts = accept_attempts + 1");
  });

  it("finalizes only the exact Auth identity and chapter-scoped optional role", () => {
    const body = effectiveLower("finalize_member_invitation");
    expect(body).toContain("from auth.users");
    expect(body).toContain("raw_user_meta_data ->> 'union_base_invitation_id'");
    expect(body).toContain("pg_catalog.lower(u.email) = invitation_row.normalized_email");
    expect(body).toContain("p.chapter_id = invitation_row.chapter_id");
    expect(body).toContain("insert into public.member_roles");
    expect(body).toContain("invitation_row.chapter_id");
  });

  it("keeps accepted status on activation, not on invitation finalization", () => {
    const finalize = effectiveLower("finalize_member_invitation");
    const activate = effectiveLower("complete_member_invitation_activation");
    const activateSql = stripComments(loadMigrationSql("emailed_password_invitation_finalize")).replace(/\s+/g, " ").toLowerCase();
    expect(finalize).not.toContain("status = 'accepted'");
    expect(activate).toContain("security definer");
    expect(activate).toContain("set search_path = ''");
    expect(activate).toContain("status = 'accepted'");
    expect(activate).toContain("auth_user_id = p_auth_user_id");
    expect(activateSql).toContain("revoke all on function public.complete_member_invitation_activation(uuid, uuid) from public, anon, authenticated, service_role");
    expect(activateSql).toContain("grant execute on function public.complete_member_invitation_activation(uuid, uuid) to service_role");
    expect(activateSql).not.toContain("grant execute on function public.complete_member_invitation_activation(uuid, uuid) to authenticated");
  });

  it("serializes revoke with acceptance and always clears a revoked digest", () => {
    const body = effectiveLower("revoke_member_invitation");
    expect(body).toContain("for update");
    expect(body).toContain("status not in ('pending', 'delivery_failed', 'expired')");
    expect(body).toContain("status = 'revoked'");
    expect(body).toContain("token_hash = null");
  });

  it("rate limits anonymous acceptance using only an opaque keyed bucket", () => {
    const body = effectiveLower("consume_member_invitation_accept_limit");
    expect(body).toContain("private.member_invitation_accept_limits");
    expect(body).toContain("p_scope_hash !~ '^[0-9a-f]{64}$'");
    expect(body).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(body).toContain("'allowed', false");
    expect(body).not.toMatch(/\b(ip|address|email)\b/);
  });

  it("prunes a bounded batch of closed acceptance windows before lookup", () => {
    const pruning = loadMigrationSql("member_invitation_accept_limit_pruning");
    const body = effectiveLower("consume_member_invitation_accept_limit");
    const scopeLockAt = body.indexOf("pg_catalog.pg_advisory_xact_lock");
    const pruneMutexAt = body.indexOf("pg_catalog.pg_try_advisory_xact_lock");
    const pruneAt = body.indexOf("delete from private.member_invitation_accept_limits");
    const lookupAt = body.indexOf("select * into current_row");

    expect(pruning.toLowerCase()).toContain("create index member_invitation_accept_limits_window_idx");
    expect(scopeLockAt).toBeGreaterThan(-1);
    expect(pruneMutexAt).toBeGreaterThan(scopeLockAt);
    expect(pruneAt).toBeGreaterThan(pruneMutexAt);
    expect(pruneAt).toBeGreaterThan(-1);
    expect(pruneAt).toBeLessThan(lookupAt);
    expect(body).toContain("window_started_at <= moment - interval '15 minutes'");
    expect(body).toMatch(/select candidate\.ctid[\s\S]*limit 200\s+for update skip locked/);
  });
});

describe("member invitation audit privacy", () => {
  it("uses a closed action set and excludes identity/token material from detail", () => {
    for (const action of [
      "invite_requested", "invite_sent", "invite_delivery_failed",
      "invite_resent", "invite_revoked", "invite_claimed", "invite_accepted",
      "invite_expired",
    ]) expect(lower).toContain(`'${action}'`);
    const audit = effectiveLower("private.audit_member_invitation");
    expect(audit).toContain("insert into public.member_invitation_audit");
    expect(audit).toContain("unsafe invitation audit detail");
    expect(audit).toContain("'email', 'normalizedemail', 'token', 'tokenhash', 'secret'");
    expect(lower).toContain("pg_catalog.jsonb_build_object('chapterid'");
  });
});
