// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fnBody, stripComments } from "./helpers/migration.js";
import { expectMi1OrganizationRlsContract } from "./helpers/mi1Contract.js";

const root = resolve(import.meta.dirname, "..");
const path = resolve(root, "supabase/migrations/20260812115000_member_signin_address_recovery.sql");
const source = readFileSync(path, "utf8");
const sql = stripComments(source).replace(/\s+/g, " ");
const lower = sql.toLowerCase();
const contract = JSON.parse(readFileSync(resolve(root, "scripts/db-contract.json"), "utf8"));

describe("sign-in address recovery storage", () => {
  it("keeps the operation ledger private and digest-only", () => {
    expect(lower).toContain("create table private.member_signin_recoveries");
    expect(lower).toContain("new_email_hash text not null check (new_email_hash ~ '^[0-9a-f]{64}$')");
    expect(lower).not.toMatch(/\b(new|old|current|proposed)_email\s+text/);
    expect(lower).not.toContain("identity_evidence");
    expect(lower).not.toContain("password");
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(lower).toContain(`revoke all on private.member_signin_recoveries from ${role}`);
    }
  });

  it("permits only one changing operation per target and persists rate counters", () => {
    expect(lower).toContain("create unique index member_signin_recoveries_one_changing_target_idx");
    expect(lower).toContain("on private.member_signin_recoveries (target_user)");
    expect(lower).toContain("where status = 'changing'");
    expect(lower).toContain("create table private.member_signin_recovery_limits");
    const rate = fnBody(source, "private.consume_member_signin_recovery_limit").toLowerCase();
    expect(rate).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(rate).toContain("current_row.request_count >= p_limit");
  });
});

describe("sign-in address recovery authorization", () => {
  it("searches by name only inside the admin's chapter", () => {
    const body = fnBody(source, "admin_search_recovery_members").toLowerCase();
    expect(body).toContain("public.member_has_role(array['admin'])");
    expect(body).toContain("p.chapter_id = caller_chapter");
    expect(body).toContain("p.full_name ilike");
    expect(body).toContain("limit 20");
    expect(body).not.toMatch(/auth\.users|\bu\.email\b|'email'/);
  });

  it("begins only for another member in the exact caller chapter", () => {
    const body = fnBody(source, "begin_member_signin_recovery").toLowerCase();
    expect(body).toContain("public.member_has_role(array['admin'])");
    expect(body).toContain("p_target_user = caller");
    expect(body).toContain("target_chapter is distinct from caller_chapter");
    expect(body).toContain("clean_hash !~ '^[0-9a-f]{64}$'");
    expect(body).toContain("clean_reason not in ('lost_inbox', 'address_retired')");
    expect(body).toContain("private.consume_member_signin_recovery_limit");
    expect(body).toContain("pg_catalog.pg_advisory_xact_lock");
  });

  it("returns the same changing operation only for an exact same-actor retry", () => {
    const body = fnBody(source, "begin_member_signin_recovery").toLowerCase();
    expect(body).toContain("status = 'changing'");
    expect(body).toContain("actor = caller");
    expect(body).toContain("new_email_hash = clean_hash");
    expect(body).toContain("reason = clean_reason");
    expect(body).toContain("'retry', true");
    expect(body).toContain("for update");
  });

  it("checks address occupancy inside Auth without returning an identity", () => {
    const body = fnBody(source, "begin_member_signin_recovery").toLowerCase();
    expect(body).toContain("from auth.users u");
    expect(body).toContain("extensions.digest(pg_catalog.lower(pg_catalog.btrim(u.email)), 'sha256')");
    expect(body).toContain("raise exception 'recovery unavailable'");
    expect(body).not.toMatch(/jsonb_build_object\([^;]{0,300}(email|new_email_hash)/);
  });
});

describe("sign-in address recovery completion", () => {
  it("finalizes only after exact Auth digest proof and session revocation", () => {
    const body = fnBody(source, "finalize_member_signin_recovery").toLowerCase();
    expect(body).toContain("public.member_has_role(array['admin'])");
    expect(body).toContain("operation_row.actor <> caller");
    expect(body).toContain("p_sessions_revoked is not true");
    expect(body).toContain("from auth.users u");
    expect(body).toContain("extensions.digest(pg_catalog.lower(pg_catalog.btrim(u.email)), 'sha256')");
    expect(body).toContain("status = 'completed'");
    expect(body).toContain("insert into public.member_admin_audit");
    expect(body).toContain("'recover_signin_address'");
    expect(body).not.toMatch(/jsonb_build_object\([^;]{0,300}(email|new_email_hash)/);
  });

  it("records only closed generic failure classes", () => {
    const body = fnBody(source, "fail_member_signin_recovery").toLowerCase();
    expect(body).toContain("clean_failure not in ('auth_unavailable', 'address_unavailable', 'auth_mismatch')");
    expect(body).toContain("status = 'failed'");
    expect(body).toContain("'recover_signin_address_failed'");
    expect(body).not.toMatch(/jsonb_build_object\([^;]{0,300}(email|new_email_hash|provider)/);
  });

  it("grants every caller function only to authenticated", () => {
    for (const [name, args] of [
      ["admin_search_recovery_members", "text"],
      ["begin_member_signin_recovery", "uuid, text, text"],
      ["finalize_member_signin_recovery", "uuid, boolean"],
      ["fail_member_signin_recovery", "uuid, text"],
    ]) {
      const body = fnBody(source, name).toLowerCase();
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = ''");
      expect(lower).toContain(`revoke all on function public.${name}(${args}) from public, anon, authenticated`);
      expect(lower).toContain(`grant execute on function public.${name}(${args}) to authenticated`);
    }
  });
});

describe("sign-in address recovery contract", () => {
  it("pins all functions and the widened audit action constraint", () => {
    const sigs = new Map(contract.functions.map((entry) => [entry.sig, entry]));
    for (const sig of [
      "private.consume_member_signin_recovery_limit(p_scope_key text, p_operation text, p_limit integer, p_window interval)",
      "public.admin_search_recovery_members(p_query text)",
      "public.begin_member_signin_recovery(p_target_user uuid, p_new_email_hash text, p_reason text)",
      "public.finalize_member_signin_recovery(p_operation_id uuid, p_sessions_revoked boolean)",
      "public.fail_member_signin_recovery(p_operation_id uuid, p_failure_code text)",
    ]) expect(sigs.has(sig), sig).toBe(true);
    expect(sigs.get("private.consume_member_signin_recovery_limit(p_scope_key text, p_operation text, p_limit integer, p_window interval)")?.exec).toBe("");
    for (const sig of [...sigs.keys()].filter((sig) => sig.includes("member_signin_recovery") || sig.includes("admin_search_recovery"))) {
      if (!sig.startsWith("private.")) expect(sigs.get(sig)?.exec).toBe("authenticated");
    }
    const action = contract.constraints.find((entry) => entry.name === "member_admin_audit_action_check");
    expect(action?.defContains).toContain("'recover_signin_address'");
    expect(action?.defContains).toContain("'recover_signin_address_failed'");
    expectMi1OrganizationRlsContract(contract);
  });
});
