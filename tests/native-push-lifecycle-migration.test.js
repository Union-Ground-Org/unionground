// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const source = loadMigrationSql("native_push_installation_lifecycle");
const code = stripComments(source).replace(/\s+/g, " ").toLowerCase();
const g5Source = loadMigrationSql("g5_mobile_attachment_two_phase");
const leaseRepairSource = loadMigrationSql("notification_delivery_lease_epoch");
const leaseRepairCode = stripComments(leaseRepairSource).replace(/\s+/g, " ").toLowerCase();
const contract = JSON.parse(readFileSync(resolve(import.meta.dirname, "../scripts/db-contract.json"), "utf8"));
const appProvider = readFileSync(resolve(import.meta.dirname, "../apps/mobile/src/state/AppProvider.tsx"), "utf8");
const signOutService = readFileSync(resolve(import.meta.dirname, "../apps/mobile/src/services/sessionSignOut.ts"), "utf8");
const accountScreen = readFileSync(resolve(import.meta.dirname, "../apps/mobile/app/(tabs)/account.tsx"), "utf8");
const dashboardService = readFileSync(resolve(import.meta.dirname, "../apps/mobile/src/services/supabase.ts"), "utf8");
const homeScreen = readFileSync(resolve(import.meta.dirname, "../apps/mobile/app/(tabs)/home.tsx"), "utf8");
const liveSchemaProbe = readFileSync(resolve(import.meta.dirname, "../scripts/verify-notification-schema.sql"), "utf8");

function expectOrdered(haystack, first, second) {
  const firstIndex = haystack.indexOf(first);
  const secondIndex = haystack.indexOf(second);
  expect(firstIndex).toBeGreaterThan(-1);
  expect(secondIndex).toBeGreaterThan(-1);
  expect(firstIndex).toBeLessThan(secondIndex);
}

describe("indexOf ordering pins", () => {
  it("fails when either ordered string is absent or reversed", () => {
    expectOrdered("alpha then beta", "alpha", "beta");
    expect(() => expectOrdered("only beta", "alpha", "beta")).toThrow();
    expect(() => expectOrdered("only alpha", "alpha", "beta")).toThrow();
    expect(() => expectOrdered("beta then alpha", "alpha", "beta")).toThrow();
  });
});

describe("native push token storage boundary", () => {
  it("keeps raw tokens behind forced RLS and zero direct API grants", () => {
    expect(code).toContain("create table public.member_native_push_installations");
    expect(code).toContain("alter table public.member_native_push_installations enable row level security");
    expect(code).toContain("alter table public.member_native_push_installations force row level security");
    expect(code).toContain("revoke all on table public.member_native_push_installations from public, anon, authenticated, service_role");
    expect(code).not.toMatch(/grant\s+(select|insert|update|delete)[^;]*member_native_push_installations/);
    expect(code).toContain("create policy mfa_assurance on public.member_native_push_installations as restrictive");
    expect(code.match(/create policy[^;]*member_native_push_installations/g)).toHaveLength(1);
  });

  it("binds the approved app id and validates provider-specific token shapes", () => {
    expect(code).toContain("application_id = 'org.example.unionground'");
    expect(code).toContain("provider in ('apns', 'fcm')");
    expect(code).toContain("provider = 'apns' and environment in ('sandbox', 'production')");
    expect(code).toContain("provider = 'fcm' and environment = 'production'");
    expect(code).toContain("device_token ~ '^[0-9a-f]+$'");
    expect(code).toContain("char_length(device_token) between 32 and 512");
    expect(code).toContain("char_length(device_token) % 2 = 0");
    expect(code).toContain("char_length(device_token) between 20 and 4096");
    expect(code).toContain("unique (provider, token_hash)");
    expect(code).toContain("unique (user_id, installation_id)");
  });

  it("audits only one-way installation and token digests", () => {
    const body = fnBody(source, "private.audit_member_native_push_installation").toLowerCase();
    expect(body).toContain("extensions.digest");
    expect(body).toContain("next_row.user_id, prior_row.user_id");
    expect(body).toContain("next_row.installation_id, prior_row.installation_id");
    expect(body).toContain("prior_row.token_hash");
    expect(body).toContain("next_row.token_hash");
    expect(body).toContain("select 1 from auth.users u where u.id = audit_user_id");
    expect(body).toContain("then audit_user_id else null end");
    expect(body).not.toContain("device_token");
    expect(code).toContain("create table private.member_native_push_installation_audit");
    expect(code).toContain("user_id uuid references auth.users(id) on delete set null");
    expect(code).toContain("revoke all on table private.member_native_push_installation_audit from public, anon, authenticated, service_role");
    expect(code).toContain("revoke all on function private.audit_member_native_push_installation() from public, anon, authenticated, service_role");
  });
});

describe("authenticated native installation lifecycle", () => {
  it("registers only a live MFA-backed current session and derives its handle server-side", () => {
    const body = fnBody(g5Source, "register_my_native_push_installation").toLowerCase();
    expect(body).toContain("caller is null or not private.mfa_satisfied()");
    expect(body).toContain("private.current_member_session_id()");
    expect(body).toContain("private.member_session_handle(current_session)");
    expect(body).toContain("caller is distinct from p_expected_user_id");
    expect(body).toContain("current_handle is distinct from clean_expected_handle");
    expect(body).toContain("token_owner <> caller");
    expect(body).toMatch(/delete from public\.member_native_push_installations i\s+where i\.provider = clean_provider\s+and i\.token_hash = clean_hash/);
    expect(body).toContain("pg_advisory_xact_lock");
    expect(body).toContain("request_count > 30");
    expectOrdered(
      body,
      "insert into private.member_native_push_registration_limits",
      "p_installation_id is null",
    );
    expect(body).toContain("jsonb_build_object('registered', false, 'reason', 'unavailable')");
    expect(body).not.toContain("raise exception 'native push registration unavailable'");
    expect(body).toContain("'native-push-token:' || clean_provider || ':' || clean_hash");
    expect(body).not.toContain("'native-push-token:' || clean_provider || ':' || clean_environment");
    expect(body).toContain("offset 9");
    expect(body).not.toMatch(/p_session_id/);
  });

  it("uses the member-session lock as the outer registration lock and refuses closing or revoked sessions before mutation", () => {
    const body = fnBody(g5Source, "register_my_native_push_installation").toLowerCase();
    const memberLock = body.indexOf("pg_catalog.hashtext('member-sessions:'");
    const currentSession = body.indexOf("private.current_member_session_id()");
    const closingBarrier = body.indexOf("from private.member_session_closing_barriers b");
    const revocationLedger = body.indexOf("from private.member_session_revocations r");
    const memberRateLock = body.indexOf("pg_catalog.hashtext('native-push-member:'");
    const tokenLock = body.indexOf("pg_catalog.hashtext('native-push-token:'");
    const write = body.indexOf("insert into public.member_native_push_installations");

    expect(memberLock).toBeGreaterThan(-1);
    expect(currentSession).toBeGreaterThan(memberLock);
    expect(closingBarrier).toBeGreaterThan(currentSession);
    expect(revocationLedger).toBeGreaterThan(currentSession);
    expect(memberRateLock).toBeGreaterThan(closingBarrier);
    expect(memberRateLock).toBeGreaterThan(revocationLedger);
    expect(tokenLock).toBeGreaterThan(memberRateLock);
    expect(write).toBeGreaterThan(tokenLock);
    expect(body).toContain("b.session_handle = current_handle or b.scope = 'global'");
    expect(body).toContain("r.session_handle = current_handle");
  });

  it("prevents an older live same-user session from reclaiming a newer session's installation or token", () => {
    const body = fnBody(g5Source, "register_my_native_push_installation").toLowerCase();
    const tokenLock = body.indexOf("pg_catalog.hashtext('native-push-token:'");
    const lineageGuard = body.indexOf("into newer_live_session_owns_target");
    const tokenTransfer = body.indexOf("if token_owner is not null");

    expect(body).toContain("join auth.sessions existing_session");
    expect(body).toContain("private.member_session_handle(existing_session.id) = i.session_handle");
    expect(body).toContain("i.installation_id = p_installation_id");
    expect(body).toContain("i.provider = clean_provider and i.token_hash = clean_hash");
    expect(body).toContain("existing_session.created_at, existing_session.id::text");
    expect(body).toContain("current_session_created_at, current_session::text");
    expect(lineageGuard).toBeGreaterThan(tokenLock);
    expect(lineageGuard).toBeLessThan(tokenTransfer);
  });

  it("lists metadata for the caller only and never emits a raw token", () => {
    const body = fnBody(source, "list_my_native_push_installations").toLowerCase();
    expect(body).toContain("i.user_id = caller");
    expect(body).toContain("private.mfa_satisfied()");
    expect(body).toContain("private.current_member_session_id()");
    expect(body).toContain("'tokenfingerprint'");
    expect(body).not.toContain("device_token");
    expect(body).not.toMatch(/'token'\s*,/);
  });

  it("deletes by caller plus installation id without a foreign-row oracle", () => {
    const body = fnBody(g5Source, "delete_my_native_push_installation").toLowerCase();
    const contractEntry = contract.functions.find((entry) => entry.sig
      === "public.delete_my_native_push_installation(p_installation_id uuid, p_expected_user_id uuid, p_expected_session_handle text)");
    expect(contractEntry?.bodyContains).toContain("p_expected_user_id uuid default null");
    expect(body).toMatch(/p_expected_user_id\s+uuid\s+default\s+null/);
    expect(body).toMatch(/p_expected_session_handle\s+text\s+default\s+null/);
    expectOrdered(
      body,
      "caller is distinct from p_expected_user_id",
      "private.current_member_session_id()",
    );
    expect(body).toContain("i.user_id = caller");
    expect(body).toContain("i.installation_id = p_installation_id");
    expect(body).toContain("private.current_member_session_id()");
    expect(body).toContain("private.member_session_handle(current_session)");
    expect(body).toContain("i.session_handle = current_handle");
    expect(body).toContain("'deleted', removed = 1");
    expect(body).not.toMatch(/foreign|other member|token/);
  });
});

describe("native sign-out ordering", () => {
  it("wires Home pull-to-refresh to a user-refresh network refresh", () => {
    expect(homeScreen).toContain("onRefresh={() => { void refresh('user-refresh'); }}");
    expect(dashboardService).toContain("reason === 'user-refresh'");
  });

  it("drains registration, deletes the exact device binding, then performs session cleanup", () => {
    // Optional feedback arguments do not change the cleanup-order contract.
    const signOutStart = appProvider.indexOf("const signOut = useCallback(async (");
    const signOutEnd = appProvider.indexOf("const refresh = useCallback", signOutStart);
    const signOut = appProvider.slice(signOutStart, signOutEnd);
    // Local operations now carry explicit provenance; the awaited wrapper must
    // still preserve the same registration -> RPC -> local-clear ordering.
    const pause = signOut.indexOf("await runLocalSignOutStep(() => pauseNativePushRegistration())");
    const exactDelete = signOut.indexOf("await deleteNativePushInstallationForSignOut(");
    const sessionCleanup = signOut.indexOf("await prepareMySignOut(serverCleanupClient, scope, expectedUserID)");
    const localClear = signOut.indexOf("await runLocalSignOutStep(() => clearNativePushPreferenceForSignOut(");
    const authSignOut = signOut.indexOf("await runLocalSignOutStep(() => revokeAndClearCapturedMobileSession(revocationSession, scope))");
    expect(signOutStart).toBeGreaterThan(-1);
    expect(signOutEnd).toBeGreaterThan(signOutStart);
    expect(pause).toBeGreaterThan(-1);
    expect(exactDelete).toBeGreaterThan(pause);
    expect(sessionCleanup).toBeGreaterThan(exactDelete);
    expect(localClear).toBeGreaterThan(sessionCleanup);
    expect(authSignOut).toBeGreaterThan(localClear);
    expect(signOutService).toContain("client.rpc('prepare_my_signout'");
    expect(signOutService).toContain("p_scope: scope");
    expect(signOutService).toContain("p_expected_user_id: expectedUserID");
    expect(signOut).not.toContain("let active = true;\n    resumeNativePushRegistration();");
  });

  it("keeps the localized visible action and its accessibility context aligned", () => {
    // A11Y-UG-MOBILE-VOICEOVER-ACCOUNT-PUSH-OPTIN-STATE-20260913: the control is a
    // switch named by the row title whose on/off state is an accessibility state; the
    // localized action word stays the visible text.
    expect(accountScreen).toContain('accessibilityRole="switch"');
    expect(accountScreen).toContain("accessibilityLabel={notificationCopy.title}");
    expect(accountScreen).toContain("accessibilityState={{ checked: notificationsOn, busy, disabled: notificationDisabled }}");
    expect(accountScreen).not.toContain("accessibilityLabel={notificationAction}");
    expect(accountScreen).toContain("{notificationAction}");
  });

  it("does not guess English while a Spanish member's dashboard is partial", () => {
    expect(dashboardService).toContain("onMemberLanguage?.(member.language)");
    expect(appProvider).toContain("setMemberLanguage(language)");
    expect(accountScreen).toContain("dashboard?.member.language ?? memberLanguage");
    expect(accountScreen).toContain("notificationLanguage ? notificationCopyFor(notificationLanguage) : null");
    expect(accountScreen).toContain("{notificationCopy ? (");
  });
});

describe("server dispatch and cleanup boundary", () => {
  it("prunes a terminal token only by installation, provider, and exact digest", () => {
    const body = fnBody(source, "prune_native_push_installation").toLowerCase();
    expect(body).toContain("auth.jwt() ->> 'role'");
    expect(body).toContain("<> 'service_role'");
    expect(body).toContain("i.installation_id = p_installation_id");
    expect(body).toContain("i.provider = clean_provider");
    expect(body).toContain("i.environment = clean_environment");
    expect(body).toContain("i.token_hash = clean_hash");
    expect(body).not.toContain("device_token");
  });

  it("bounds stale pruning and refuses a recent or future cutoff", () => {
    const body = fnBody(source, "prune_stale_native_push_installations").toLowerCase();
    expect(body).toContain("auth.jwt() ->> 'role'");
    expect(body).toContain("p_before > pg_catalog.now() - interval '7 days'");
    expect(body).toContain("least(coalesce(p_limit, 100), 500)");
    expect(body).toContain("for update skip locked");
  });

  it("removes native rows before remote session deletion and on local/global sign-out", () => {
    const revoke = fnBody(g5Source, "revoke_my_session").toLowerCase();
    expectOrdered(
      revoke,
      "delete from public.member_native_push_installations",
      "delete from auth.sessions",
    );
    expect(revoke).toContain("session_handle = clean_handle");

    const signout = fnBody(g5Source, "prepare_my_signout").toLowerCase();
    expectOrdered(
      signout,
      "caller is distinct from p_expected_user_id",
      "private.current_member_session_id()",
    );
    expect(signout).toContain("if clean_scope = 'global'");
    expect(signout).toContain("delete from public.member_native_push_installations");
    expect(signout).toContain("session_handle = current_handle");
    expect(signout).toContain("session_handle = current_handle or session_handle is null");
    expect(signout).not.toContain("session_handle is null and mfa_ok");
    expect(signout).toContain("from auth.sessions s");
    expect(signout).toContain("insert into private.member_session_closing_barriers");
    expect(signout).toContain("'servercleanupcomplete', true");
  });

  it("emits raw tokens only through the service-role claim and never notification content", () => {
    const claim = fnBody(leaseRepairSource, "claim_notification_deliveries").toLowerCase();
    expect(claim).toContain("'nativeinstallations'");
    expect(claim).toContain("'token', i.device_token");
    expect(claim).toContain("'environment', i.environment");
    expect(claim).toContain("'tokenhash', i.token_hash");
    expect(claim).toContain("'targetkey', s.target_key");
    expect(claim).toContain("'targetkey', i.target_key");
    expect(claim).toContain("private.member_notification_push_target_receipts");
    expect(claim).not.toMatch(/n\.title|n\.body/);
    expect(leaseRepairCode).toContain("grant execute on function public.claim_notification_deliveries(text, integer) to service_role");
    expect(leaseRepairCode).toContain("revoke all on function public.claim_notification_deliveries(text, integer) from public, anon, authenticated, service_role");
  });

  it("records accepted targets atomically under a monotonic lease and defers without burning an attempt", () => {
    const record = fnBody(leaseRepairSource, "record_notification_delivery_results").toLowerCase();
    expect(code).toContain("create table private.member_notification_push_target_receipts");
    expect(code).toContain("revoke all on table private.member_notification_push_target_receipts from public, anon, authenticated, service_role");
    expect(leaseRepairCode).toContain("add column delivery_lease_epoch bigint not null default 0");
    expect(leaseRepairCode).toContain("delivery_lease_epoch = d.delivery_lease_epoch + 1");
    expect(record).toContain("coalesce(pg_catalog.jsonb_typeof(item -> 'leaseepoch'), '') <> 'number'");
    expect(record).toContain("coalesce(item ->> 'leaseepoch', '') !~ '^[1-9][0-9]{0,17}$'");
    expect(record).toContain("d.delivery_lease_epoch = v_lease_epoch");
    expect(record).toContain("v_status not in ('sent', 'failed', 'skipped', 'deferred')");
    expect(record).toContain("attempts = greatest(0, d.attempts - 1)");
    expect(record).toContain("min(r.delivered_at)");
    expect(record).toContain("case when v_first_delivered_at is null then 'skipped' else 'sent' end");
    expect(record).toContain("v_has_current_receipt := pg_catalog.jsonb_array_length");
    expect(record).toContain("v_first_delivered_at is not null or v_has_current_receipt");
    expect(record).toContain("coalesce(v_first_delivered_at, pg_catalog.now())");
    expect(record).toContain("d.channel = 'push'");
    expect(record).toContain("insert into private.member_notification_push_target_receipts");
    expect(record).toContain("on conflict (delivery_id, target_key) do nothing");
    expectOrdered(
      record,
      "get diagnostics v_rows = row_count",
      "insert into private.member_notification_push_target_receipts",
    );
  });

  it("probes a stale but structurally valid lease epoch in the live catalog verifier", () => {
    expect(liveSchemaProbe).toContain("v_stale_lease_epoch := v_true_lease_epoch + 7;");
    expect(liveSchemaProbe).not.toContain("v_stale_lease_epoch := greatest(0, v_true_lease_epoch - 1);");
  });

  it("keeps terminal delivery sweeps consistent with accepted target receipts", () => {
    const expire = fnBody(leaseRepairSource, "expire_notification_deliveries").toLowerCase();
    expect(expire).toContain("private.member_notification_push_target_receipts");
    expect(expire).toContain("min(r.delivered_at)");
    expect(expire).toContain("case when c.first_delivered_at is null then 'skipped' else 'sent' end");
    expect(expire).toContain("case when c.first_delivered_at is null then 'failed' else 'sent' end");
    expect(expire).toContain("coalesce(d.sent_at, c.first_delivered_at)");
    expect(expire).toContain("count(*) filter (where first_delivered_at is null)");
    expect(expire).toContain("'receiptpromoted', receipt_promoted");
  });

  it("indexes the bounded stale-installation sweep by its cutoff column", () => {
    expect(code).toContain("create index member_native_push_installations_last_seen_idx");
    expect(code).toContain("on public.member_native_push_installations (last_seen_at)");
  });
});

describe("native push database contract", () => {
  it("pins every callable function with its intended single role", () => {
    const entries = new Map(contract.functions.map((entry) => [entry.sig, entry]));
    for (const signature of [
      "public.register_my_native_push_installation(p_installation_id uuid, p_provider text, p_environment text, p_device_token text, p_expected_user_id uuid, p_expected_session_handle text)",
      "public.list_my_native_push_installations()",
      "public.delete_my_native_push_installation(p_installation_id uuid, p_expected_user_id uuid, p_expected_session_handle text)",
    ]) {
      expect(entries.get(signature)?.exec).toBe("authenticated");
    }
    const registration = entries.get(
      "public.register_my_native_push_installation(p_installation_id uuid, p_provider text, p_environment text, p_device_token text, p_expected_user_id uuid, p_expected_session_handle text)",
    );
    expect(registration?.bodyContains).toContain("private.member_session_closing_barriers");
    expect(registration?.bodyContains).toContain("private.member_session_revocations");
    expect(registration?.bodyContains).toContain("'member-sessions:' || caller::text");
    for (const signature of [
      "public.prune_native_push_installation(p_installation_id uuid, p_provider text, p_environment text, p_token_hash text)",
      "public.prune_stale_native_push_installations(p_before timestamp with time zone, p_limit integer)",
    ]) {
      expect(entries.get(signature)?.exec).toBe("service_role");
    }
    expect(entries.get("private.audit_member_native_push_installation()")?.exec).toBe("");
  });
});
