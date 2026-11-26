// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const source = loadMigrationSql("member_device_sessions");
const lower = stripComments(source).replace(/\s+/g, " ").toLowerCase();
const repairSource = loadMigrationSql("g5_mobile_attachment_two_phase");
const repairLower = stripComments(repairSource).replace(/\s+/g, " ").toLowerCase();
const contract = JSON.parse(readFileSync(resolve(import.meta.dirname, "../scripts/db-contract.json"), "utf8"));

describe("member device-session privacy boundary", () => {
  it("replaces the earlier inventory RPC instead of failing the migration chain", () => {
    const earlier = readFileSync(resolve(import.meta.dirname, "../supabase/migrations/20260810180000_member_session_inventory.sql"), "utf8");
    expect(earlier).toMatch(/create function public\.list_my_sessions\(\)/i);
    expect(source).toMatch(/create or replace function public\.list_my_sessions\(\)/i);
  });

  it("returns only coarse metadata behind opaque digest handles", () => {
    const body = fnBody(source, "list_my_sessions").toLowerCase();
    const resolver = fnBody(source, "private.current_member_session_id").toLowerCase();
    expect(body).toContain("private.member_session_handle(s.id)");
    expect(body).toContain("s.user_id = caller");
    expect(body).toContain("private.current_member_session_id()");
    expect(resolver).toContain("auth.jwt() ->> 'session_id'");
    expect(resolver).toContain("s.user_id = caller");
    expect(body).toContain("private.mfa_satisfied()");
    expect(body).toContain("'devicelabel'");
    expect(body).toContain("'browserlabel'");
    expect(body).not.toMatch(/'ip'|'useragent'|'sessionid'|'refreshtoken'/);
  });

  it("keeps handle derivation private and validates exact 64-hex values", () => {
    const body = fnBody(source, "private.member_session_handle").toLowerCase();
    expect(body).toContain("extensions.digest(p_session_id::text, 'sha256')");
    expect(lower).toContain("session_handle text");
    expect(lower).toContain("session_handle ~ '^[0-9a-f]{64}$'");
    expect(lower).not.toMatch(/session_handle\s+uuid/);
  });

  it("keeps the idempotency ledger private from every API role", () => {
    expect(lower).toContain("create table private.member_session_revocations");
    expect(lower).toContain("revoke all on private.member_session_revocations from public, anon, authenticated, service_role");
  });

  it("keeps the durable session-closing barrier private and opaque", () => {
    expect(repairLower).toContain("create table private.member_session_closing_barriers");
    expect(repairLower).toContain("primary key (user_id, session_handle)");
    expect(repairLower).toContain("session_handle ~ '^[0-9a-f]{64}$'");
    expect(repairLower).toContain("scope in ('local', 'global')");
    expect(repairLower).toContain("revoke all on private.member_session_closing_barriers from public, anon, authenticated, service_role");
    expect(repairLower).not.toMatch(/member_session_closing_barriers[\s\S]*session_id\s+uuid/);
  });

  it("keeps the in-progress MFA recovery lock private and digest-only", () => {
    const table = repairLower.match(
      /create table private\.member_mfa_recovery_locks\s*\(([\s\S]*?)\);/,
    )?.[1] ?? "";
    expect(table).toContain("claim_token_hash text not null");
    expect(table).toContain("claim_token_hash ~ '^[0-9a-f]{64}$'");
    expect(repairLower).toContain("revoke all on private.member_mfa_recovery_locks from public, anon, authenticated, service_role");
    expect(table).not.toMatch(/\bclaim_token\s+text/);
  });
});

describe("selected remote session revoke", () => {
  it("is self+MFA scoped, serialized, and refuses the current session", () => {
    const body = fnBody(repairSource, "revoke_my_session").toLowerCase();
    const memberLock = body.indexOf("pg_catalog.hashtext('member-sessions:'");
    const currentSession = body.indexOf("private.current_member_session_id()");
    expect(body).toContain("caller is null or not private.mfa_satisfied()");
    expect(body).toContain("p_session_handle !~ '^[0-9a-f]{64}$'");
    expect(memberLock).toBeGreaterThan(-1);
    expect(currentSession).toBeGreaterThan(memberLock);
    expect(body).toContain("s.user_id = caller");
    expect(body).toContain("for update");
    expect(body).toContain("target_session::text = current_session");
    expect(body).toContain("cannot revoke the current session");
  });

  it("removes target and legacy push before the Auth session", () => {
    const body = fnBody(repairSource, "revoke_my_session").toLowerCase();
    const push = body.indexOf("delete from public.member_push_subscriptions");
    const session = body.indexOf("delete from auth.sessions");
    expect(push).toBeGreaterThan(-1);
    expect(session).toBeGreaterThan(push);
    expect(body).toContain("session_handle = clean_handle or session_handle is null");
    expect(body).toContain("private.member_session_revocations");
    expect(body).toContain("'alreadyrevoked', true");
  });

  it("uses one generic unknown/foreign outcome without mutation", () => {
    const body = fnBody(repairSource, "revoke_my_session").toLowerCase();
    expect(body).toContain("raise exception 'session unavailable'");
    expect(body).not.toMatch(/foreign session|unknown session|other member/);
  });
});

describe("shared-device push teardown", () => {
  it("derives the push/session binding from the JWT, never a client argument", () => {
    const body = fnBody(repairSource, "upsert_push_subscription").toLowerCase();
    expect(body).toContain("private.current_member_session_id()");
    expect(body).toContain("private.member_session_handle");
    expect(body).toContain("caller is null or not private.mfa_satisfied()");
    expect(body).toContain("session_handle = excluded.session_handle");
    expect(body).not.toMatch(/p_session(_id|_handle)/);
  });

  it("serializes web registration before session lookup and refuses closed or revoked handles before writing", () => {
    const body = fnBody(repairSource, "upsert_push_subscription").toLowerCase();
    const memberLock = body.indexOf("pg_catalog.hashtext('member-sessions:'");
    const currentSession = body.indexOf("private.current_member_session_id()");
    const closingBarrier = body.indexOf("from private.member_session_closing_barriers b");
    const revocationLedger = body.indexOf("from private.member_session_revocations r");
    const write = body.indexOf("insert into public.member_push_subscriptions");

    expect(memberLock).toBeGreaterThan(-1);
    expect(currentSession).toBeGreaterThan(memberLock);
    expect(closingBarrier).toBeGreaterThan(currentSession);
    expect(revocationLedger).toBeGreaterThan(currentSession);
    expect(write).toBeGreaterThan(closingBarrier);
    expect(write).toBeGreaterThan(revocationLedger);
    expect(body).toContain("b.session_handle = current_handle or b.scope = 'global'");
    expect(body).toContain("r.session_handle = current_handle");
  });

  it("prepares only local or global signout and requires server-wide global cleanup", () => {
    const body = fnBody(repairSource, "prepare_my_signout").toLowerCase();
    const contractEntry = contract.functions.find((entry) => entry.sig
      === "public.prepare_my_signout(p_scope text, p_expected_user_id uuid)");
    const identityRefusal = body.indexOf("caller is distinct from p_expected_user_id");
    expect(contractEntry?.bodyContains).toContain("p_expected_user_id uuid default null");
    expect(body).toMatch(/p_expected_user_id\s+uuid\s+default\s+null/);
    expect(body).toContain("caller is null or p_expected_user_id is null");
    expect(identityRefusal).toBeGreaterThan(-1);
    expect(identityRefusal).toBeLessThan(body.indexOf("private.current_member_session_id()"));
    expect(identityRefusal).toBeLessThan(body.indexOf("pg_catalog.pg_advisory_xact_lock"));
    expect(body).toContain("clean_scope not in ('local', 'global')");
    expect(body).toContain("if clean_scope = 'global' and not mfa_ok");
    expect(body).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(body).toContain("if clean_scope = 'global'");
    expect(body).toContain("where user_id = caller");
    expect(body).toContain("session_handle = current_handle");
  });

  it("writes local or all-session global barriers under the outer member lock before push deletion", () => {
    const body = fnBody(repairSource, "prepare_my_signout").toLowerCase();
    const memberLock = body.indexOf("pg_catalog.hashtext('member-sessions:'");
    const currentSession = body.indexOf("private.current_member_session_id()");
    const barrierWrite = body.indexOf("insert into private.member_session_closing_barriers");
    const pushDelete = body.indexOf("delete from public.member_push_subscriptions");

    expect(memberLock).toBeGreaterThan(-1);
    expect(currentSession).toBeGreaterThan(memberLock);
    expect(barrierWrite).toBeGreaterThan(currentSession);
    expect(pushDelete).toBeGreaterThan(barrierWrite);
    expect(body).toContain("values (caller, current_handle, 'local')");
    expect(body).toContain("from auth.sessions s");
    expect(body).toContain("where s.user_id = caller");
    expect(body).toContain("set scope = 'global'");
    expect(body).toContain("on conflict (user_id, session_handle) do nothing");
  });

  it("removes legacy unbound web push endpoints during local AAL1 signout", () => {
    const body = fnBody(repairSource, "prepare_my_signout").toLowerCase();
    const localBranch = body.slice(body.lastIndexOf("else"), body.indexOf("push_removed :="));
    const webDelete = localBranch.slice(
      localBranch.indexOf("delete from public.member_push_subscriptions"),
      localBranch.indexOf("get diagnostics web_push_removed"),
    );

    expect(webDelete).toContain("session_handle is null");
    expect(webDelete).not.toContain("mfa_ok");
  });

  it("prepares MFA recovery cleanup only for a live service-held claim before global Auth logout", () => {
    expect(repairLower).toContain("create function public.prepare_mfa_recovery_signout");
    expect(repairLower).toContain("alter table public.mfa_recovery_codes add column claim_session_handle text");
    const claim = fnBody(repairSource, "claim_mfa_recovery_code").toLowerCase();
    const body = fnBody(repairSource, "prepare_mfa_recovery_signout").toLowerCase();
    const claimMemberLock = claim.indexOf("pg_catalog.hashtext('member-sessions:'");
    const claimSession = claim.indexOf("private.current_member_session_id()");
    const memberLock = body.indexOf("pg_catalog.hashtext('member-sessions:'");
    const claimCheck = body.indexOf("from public.mfa_recovery_codes");
    const liveSessionCheck = body.indexOf("from auth.sessions s");
    const barrierWrite = body.indexOf("insert into private.member_session_closing_barriers");
    const webDelete = body.indexOf("delete from public.member_push_subscriptions");
    const nativeDelete = body.indexOf("delete from public.member_native_push_installations");

    expect(body).toContain("auth.role()) <> 'service_role'");
    expect(claimMemberLock).toBeGreaterThan(-1);
    expect(claimSession).toBeGreaterThan(claimMemberLock);
    expect(claim).toContain("for key share");
    expect(claim).toContain("claim_session_handle = current_handle");
    expect(claim).toContain("'sessionhandle', current_handle");
    expect(body).toContain("claim_expires_at > pg_catalog.now()");
    expect(body).toContain("claim_token_hash = pg_catalog.encode");
    expect(body).toContain("c.claim_session_handle = clean_session_handle");
    expect(memberLock).toBeGreaterThan(-1);
    expect(claimCheck).toBeGreaterThan(memberLock);
    expect(liveSessionCheck).toBeGreaterThan(claimCheck);
    expect(body.indexOf("for key share")).toBeGreaterThan(liveSessionCheck);
    const recoveryLock = body.indexOf("insert into private.member_mfa_recovery_locks");
    expect(recoveryLock).toBeGreaterThan(liveSessionCheck);
    expect(barrierWrite).toBeGreaterThan(recoveryLock);
    expect(webDelete).toBeGreaterThan(barrierWrite);
    expect(nativeDelete).toBeGreaterThan(barrierWrite);
    expect(body).toContain("from auth.sessions s");
    expect(body).toContain("where s.user_id = p_user_id");
    expect(body).toContain("select p_user_id, private.member_session_handle(s.id), 'global'");
    expect(repairLower).toContain("revoke all on function public.prepare_mfa_recovery_signout(uuid,text,text) from public, anon, authenticated, service_role");
    expect(repairLower).toContain("grant execute on function public.prepare_mfa_recovery_signout(uuid,text,text) to service_role");
  });

  it("releases the exact recovery lock only while atomically consuming its live claim", () => {
    const body = fnBody(repairSource, "finalize_mfa_recovery_code").toLowerCase();
    const memberLock = body.indexOf("pg_catalog.hashtext('member-sessions:'");
    const claimCheck = body.indexOf("from public.mfa_recovery_codes");
    const recoveryLockCheck = body.indexOf("from private.member_mfa_recovery_locks");
    const consume = body.indexOf("update public.mfa_recovery_codes");
    const release = body.indexOf("delete from private.member_mfa_recovery_locks");

    expect(body).toContain("auth.role()) <> 'service_role'");
    expect(memberLock).toBeGreaterThan(-1);
    expect(claimCheck).toBeGreaterThan(memberLock);
    expect(recoveryLockCheck).toBeGreaterThan(claimCheck);
    expect(consume).toBeGreaterThan(recoveryLockCheck);
    expect(release).toBeGreaterThan(consume);
    expect(body).toContain("l.claim_token_hash = expected_claim_hash");
    expect(body).toContain("c.claim_expires_at > pg_catalog.now()");
  });
});

describe("member device-session contract", () => {
  it("grants only the three public entry points to authenticated", () => {
    for (const [name, args] of [
      ["list_my_sessions", ""],
      ["revoke_my_session", "text"],
    ]) {
      const body = fnBody(source, name).toLowerCase();
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = ''");
      expect(lower).toContain(`revoke all on function public.${name}(${args}) from public, anon, authenticated`);
      expect(lower).toContain(`grant execute on function public.${name}(${args}) to authenticated`);
    }
    const signOutBody = fnBody(repairSource, "prepare_my_signout").toLowerCase();
    expect(signOutBody).toContain("security definer");
    expect(signOutBody).toContain("set search_path = ''");
    expect(repairLower).toContain("drop function public.prepare_my_signout(text)");
    expect(repairLower).toContain("revoke all on function public.prepare_my_signout(text,uuid) from public, anon, authenticated, service_role");
    expect(repairLower).toContain("grant execute on function public.prepare_my_signout(text,uuid) to authenticated");
    expect(lower).toContain("revoke all on function private.member_session_handle(uuid) from public, anon, authenticated, service_role");
  });

  it("pins live definitions, private exposure, constraint, and index", () => {
    const sigs = new Map(contract.functions.map((entry) => [entry.sig, entry]));
    expect(sigs.get("private.member_session_handle(p_session_id uuid)")?.exec).toBe("");
    expect(sigs.get("public.list_my_sessions()")?.exec).toBe("authenticated,service_role");
    const revoke = sigs.get("public.revoke_my_session(p_session_handle text)");
    const signout = sigs.get("public.prepare_my_signout(p_scope text, p_expected_user_id uuid)");
    const webRegistration = sigs.get("public.upsert_push_subscription(p_endpoint text, p_p256dh text, p_auth text)");
    const mfaRecoverySignout = sigs.get("public.prepare_mfa_recovery_signout(p_user_id uuid, p_session_handle text, p_claim_token text)");
    expect(revoke?.exec).toBe("authenticated");
    expect(revoke?.bodyContains).toContain("'member-sessions:' || caller::text");
    expect(signout?.exec).toBe("authenticated");
    expect(signout?.bodyContains).toContain("private.member_session_closing_barriers");
    expect(signout?.bodyContains).toContain("select caller, private.member_session_handle(s.id), 'global'");
    expect(webRegistration?.bodyContains).toContain("private.member_session_closing_barriers");
    expect(webRegistration?.bodyContains).toContain("private.member_session_revocations");
    expect(webRegistration?.bodyContains).toContain("'member-sessions:' || caller::text");
    expect(mfaRecoverySignout?.exec).toBe("service_role");
    expect(mfaRecoverySignout?.bodyContains).toContain("private.member_session_closing_barriers");
    expect(mfaRecoverySignout?.bodyContains).toContain("private.member_mfa_recovery_locks");
    expect(mfaRecoverySignout?.bodyContains).toContain("claim_token_hash = pg_catalog.encode");
    expect(mfaRecoverySignout?.bodyContains).toContain("claim_session_handle = clean_session_handle");
    const mfaRecoveryFinalize = sigs.get("public.finalize_mfa_recovery_code(p_user_id uuid, p_claim_token text)");
    expect(mfaRecoveryFinalize?.bodyContains).toContain("private.member_mfa_recovery_locks");
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(contract.tableGrants).toContainEqual(expect.objectContaining({
        table: "private.member_session_closing_barriers",
        role,
        privileges: "",
      }));
    }
    expect(contract.constraints).toContainEqual(expect.objectContaining({
      table: "private.member_session_closing_barriers",
      name: "member_session_closing_barriers_handle_check",
    }));
    expect(contract.constraints).toContainEqual(expect.objectContaining({
      table: "private.member_session_closing_barriers",
      name: "member_session_closing_barriers_scope_check",
    }));
    expect(contract.constraints).toContainEqual(expect.objectContaining({
      name: "member_push_subscriptions_session_handle_check",
    }));
    expect(contract.indexes).toContainEqual(expect.objectContaining({
      name: "member_push_subscriptions_session_handle_idx",
    }));
  });
});

describe("native Auth timeouts", () => {
  const config = readFileSync(resolve(import.meta.dirname, "../supabase/config.toml"), "utf8");

  it("uses the approved 8h idle and 7d absolute policy with the one-hour JWT", () => {
    expect(config).toMatch(/jwt_expiry\s*=\s*3600/);
    expect(config).toMatch(/\[auth\.sessions\][\s\S]*timebox\s*=\s*"168h"/);
    expect(config).toMatch(/\[auth\.sessions\][\s\S]*inactivity_timeout\s*=\s*"8h"/);
  });
});
