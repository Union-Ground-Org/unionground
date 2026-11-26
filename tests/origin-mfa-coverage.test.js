// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import adminReset from "../api/admin-mfa-reset.js";
import recovery from "../api/mfa-recovery.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

const USER = "10000000-0000-4000-8000-000000000001";
const FACTOR = "20000000-0000-4000-8000-000000000002";
const SECOND = "30000000-0000-4000-8000-000000000003";
const claim = { accepted: true, userId: USER, sessionHandle: "b".repeat(64), claimToken: "a".repeat(64) };
const reply = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status });
const headers = { host: PORTAL_HOST, origin: PORTAL_ORIGIN, authorization: "Bearer caller-token" };
async function run(handler, body, extra = {}) {
  const res = { status(code) { this.code = code; return this; }, setHeader() {}, end(value) { this.body = JSON.parse(value); } };
  await handler({ method: "POST", headers, body, ...extra }, res);
  return { status: res.code, body: res.body };
}
function upstream(overrides = {}) {
  const defaults = {
    user: { id: SECOND }, authorize_mfa_reset: { authorized: true, adminRank: "checked" }, begin_mfa_reset: {}, record_mfa_reset: true, notify_member_mfa_reset: { notified: true },
    queue_member_mfa_reset_notice: { userId: USER, pending: true }, drain_member_mfa_reset_notice: { userId: USER, drained: true, notified: true, pending: false },
    notify_member_mfa_reset_incomplete: { userId: USER, notified: true, duplicate: false },
    claim_mfa_recovery_code: claim, finalize_mfa_recovery_code: true,
    prepare_mfa_recovery_signout: { serverCleanupComplete: true },
    factors: [{ id: FACTOR, factor_type: "totp" }], logout: true, delete: true,
    // Admin reset ends the member's sessions through the service-role RPC
    // (BUG-UG-ADMIN-SESSION-REVOKE-ENDPOINT-20261003).
    end_member_auth_sessions: { ended: true },
  };
  const routes = { ...defaults, ...overrides };
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    const key = url.endsWith("/auth/v1/user") ? "user" : url.includes("/rpc/") ? url.split("/rpc/")[1]
      : init.method === "DELETE" ? "delete" : url.includes("logout") ? "logout" : "factors";
    calls.push({ key, url, init, body: init.body ? JSON.parse(init.body) : null });
    const result = typeof routes[key] === "function" ? routes[key](calls) : routes[key];
    if (result instanceof Error) throw result;
    return result instanceof Response ? result : reply(result);
  }));
  return calls;
}
beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_ORIGIN);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", SUPABASE_REF);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

for (const [name, handler, validBody, badBody, error] of [
  ["admin reset", adminReset, { userId: USER }, { userId: "../other" }, "invalid-user-id"],
  ["self recovery", recovery, { code: "ABCD-EFGH-IJKL-MNOP-QRST" }, { code: "tiny" }, "code-not-accepted"],
]) {
  describe(`${name} request gates`, () => {
    it.each([
      ["origin", { headers: { ...headers, origin: "https://attacker.test" } }, 403, "untrusted-origin"],
      ["method", { method: "GET" }, 405, "method-not-allowed"],
      ["authentication", { headers: { ...headers, authorization: "" } }, 401, "unauthenticated"],
      ["invalid body", { body: badBody }, 400, error],
      ["malformed JSON", { body: "{" }, 400, error],
    ])("rejects %s before any provider call", async (_, extra, status, message) => {
      upstream();
      expect(await run(handler, validBody, extra)).toEqual({ status, body: { error: message } });
      expect(fetch).not.toHaveBeenCalled();
    });
    it("requires configured server credentials", async () => {
      upstream(); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
      expect(await run(handler, validBody)).toEqual({ status: 503, body: { error: "not-configured" } });
      expect(fetch).not.toHaveBeenCalled();
    });
  });
}

describe("admin reset outcomes", () => {
  it("refuses failed authorization without touching factors", async () => {
    const calls = upstream({ begin_mfa_reset: reply({}, 403) });
    expect(await run(adminReset, { userId: USER })).toEqual({ status: 403, body: { error: "not-permitted" } });
    expect(calls.map(c => c.key)).toEqual(["user", "authorize_mfa_reset", "begin_mfa_reset"]);
  });
  it.each([reply({}, 403), { authorized: false }, null])("denies failed authorization-only checks before the boundary or provider", async authorization => {
    const calls = upstream({ authorize_mfa_reset: authorization });
    expect(await run(adminReset, { userId: USER })).toEqual({ status: 403, body: { error: "not-permitted" } });
    expect(calls.map(c => c.key)).toEqual(["user", "authorize_mfa_reset"]);
  });
  it("refuses the authenticated caller's own id even if authorization RPCs would succeed", async () => {
    const calls = upstream({ user: { id: USER } });
    expect(await run(adminReset, { userId: USER })).toEqual({ status: 403, body: { error: "not-permitted" } });
    expect(calls.map(c => c.key)).toEqual(["user"]);
  });
  it.each([{}, { factors: null }, [{ id: "../other" }]])("refuses malformed factor inventories before deletion", async factors => {
    const calls = upstream({ factors });
    expect(await run(adminReset, { userId: USER })).toEqual({ status: 502, body: {
      error: "auth-service-unavailable", removed: 0, staleSessionsBlocked: true, notified: true, pendingNotice: false,
    } });
    expect(calls.some(c => c.key === "delete")).toBe(false);
  });
  it("reports unavailable factor inventory", async () => {
    const calls = upstream({ factors: reply({}, 503) });
    expect(await run(adminReset, { userId: USER })).toEqual({ status: 502, body: {
      error: "auth-service-unavailable", removed: 0, staleSessionsBlocked: true, notified: true, pendingNotice: false,
    } });
    // BUG-UG-MFA-RESET-FOURTH-EXIT-NO-NOTICE-NO-DEBT-20260918: the member
    // gets the "did not finish" notice, never the removed-copy debt.
    expect(calls.map(c => c.key)).toEqual(["user", "authorize_mfa_reset", "begin_mfa_reset", "factors", "notify_member_mfa_reset_incomplete"]);
  });
  it.each([0, 1])("audits only the %i factors removed before a partial reset", async (count) => {
    const calls = upstream({ factors: { factors: [{ id: FACTOR }, { id: SECOND }] },
      delete: (seen) => seen.filter(c => c.key === "delete").length > count ? reply({}, 503) : true,
      record_mfa_reset: reply({}, 503),
    });
    expect(await run(adminReset, JSON.stringify({ userId: USER }))).toEqual({ status: 502, body: {
      error: "partial-reset", removed: count, total: 2, staleSessionsBlocked: true, notified: true, pendingNotice: false,
    } });
    expect(calls.filter(c => c.key === "record_mfa_reset").map(c => c.body)).toEqual(count ? [{ p_user_id: USER, p_factors: count }] : []);
    expect(calls.some(c => c.key === "end_member_auth_sessions")).toBe(false);
    // BUG-UG-MFA-RESET-PARTIAL-NO-MEMBER-NOTICE-20260917: a partial reset
    // owes the member a notice — their sessions and push targets are already
    // closed — and owes it durably, before it tries to deliver it.
    expect(calls.filter(c => c.key.startsWith("queue_") || c.key.startsWith("drain_")).map(c => [c.key, c.body]))
      .toEqual([["queue_member_mfa_reset_notice", { p_user_id: USER }], ["drain_member_mfa_reset_notice", { p_user_id: USER }]]);
  });
  it("reports a completed reset honestly when auditing fails, and tells the member through the drain", async () => {
    const calls = upstream({ factors: [], record_mfa_reset: reply({}, 503), end_member_auth_sessions: new Error("timeout") });
    expect(await run(adminReset, { userId: USER })).toEqual({ status: 200, body: {
      removed: 0, audited: false, notified: true, pendingNotice: false, revoked: false, staleSessionsBlocked: true,
    } });
    expect(calls.find(c => c.key === "record_mfa_reset").body.p_factors).toBe(0);
    // notify_member_mfa_reset is bound to the audit row that was NOT written,
    // so it is still never called here; the notice reaches the member through
    // the boundary-bound queue and drain instead
    // (BUG-UG-MFA-RESET-PARTIAL-NO-MEMBER-NOTICE-20260917).
    expect(calls.some(c => c.key === "notify_member_mfa_reset")).toBe(false);
    expect(calls.filter(c => c.key.startsWith("queue_") || c.key.startsWith("drain_")).map(c => c.key))
      .toEqual(["queue_member_mfa_reset_notice", "drain_member_mfa_reset_notice"]);
  });
  it("notifies the member as the caller once the audit row exists", async () => {
    const calls = upstream({ drain_member_mfa_reset_notice: { userId: USER, drained: false, notified: false, pending: false } });
    expect(await run(adminReset, { userId: USER })).toEqual({ status: 200, body: {
      removed: 1, audited: true, notified: true, pendingNotice: false, revoked: true, staleSessionsBlocked: true,
    } });
    // The reset that notified owes nothing, so no debt is marked; the drain
    // that follows is the retry for a debt an EARLIER reset left pending.
    expect(calls.map(c => c.key)).toEqual(["user", "authorize_mfa_reset", "begin_mfa_reset", "factors", "delete", "end_member_auth_sessions", "record_mfa_reset", "notify_member_mfa_reset", "drain_member_mfa_reset_notice"]);
    const notice = calls.find(c => c.key === "notify_member_mfa_reset");
    expect(notice.body).toEqual({ p_user_id: USER });
    expect(notice.init.headers.Authorization).toBe("Bearer caller-token");
    expect(notice.init.headers.apikey).toBe("sb_publishable_test");
  });
});

describe("member recovery boundaries", () => {
  const body = { code: "ABCD-EFGH-IJKL-MNOP-QRST" };
  it.each([reply({}, 403), { accepted: false }, { ...claim, userId: "bad" }, { ...claim, claimToken: "bad" }, { ...claim, sessionHandle: "bad" }])("rejects an invalid claim before factor access", async (result) => {
    const calls = upstream({ claim_mfa_recovery_code: result });
    const denied = result instanceof Response || result.accepted === false;
    expect(await run(recovery, body)).toEqual({ status: denied ? 400 : 502, body: { error: denied ? "code-not-accepted" : "recovery-unavailable" } });
    expect(calls).toHaveLength(1);
  });
  it.each([reply({}, 503), [{ factor_type: "totp", id: "../bad" }]])("refuses unusable factor lists", async factors => {
    const calls = upstream({ factors });
    expect(await run(recovery, body)).toEqual({ status: 502, body: { error: "recovery-unavailable" } });
    expect(calls.some(c => c.key === "delete" || c.key === "logout")).toBe(false);
  });
  it("deletes only TOTP and finalizes after global caller logout", async () => {
    const calls = upstream({ factors: { factors: [{ id: FACTOR, factor_type: "totp" }, { id: SECOND, factor_type: "phone" }] } });
    expect(await run(recovery, JSON.stringify(body))).toEqual({ status: 200, body: { recovered: true, removed: 1, sessionsRevoked: true, signInAgain: true } });
    expect(calls.map(c => c.key)).toEqual(["claim_mfa_recovery_code", "factors", "prepare_mfa_recovery_signout", "delete", "logout", "finalize_mfa_recovery_code"]);
    const cleanup = calls.find(c => c.key === "prepare_mfa_recovery_signout");
    expect(cleanup.body).toEqual({ p_user_id: USER, p_session_handle: claim.sessionHandle, p_claim_token: claim.claimToken });
    expect(cleanup.init.headers.apikey).toBe("sb_secret_test");
    const deletion = calls.find(c => c.key === "delete");
    expect(deletion.url).toContain(FACTOR);
    expect(deletion.init.headers).toMatchObject({ apikey: "sb_secret_test", "User-Agent": "node" });
    const logout = calls.find(c => c.key === "logout");
    expect(logout.url).toBe(`${SUPABASE_ORIGIN}/auth/v1/logout?scope=global`);
    expect(logout.init.headers.Authorization).toBe("Bearer caller-token");
    const finalization = calls.find(c => c.key === "finalize_mfa_recovery_code");
    expect(finalization.body).toEqual({ p_user_id: USER, p_claim_token: claim.claimToken });
    expect(finalization.init.headers.apikey).toBe("sb_secret_test");
  });
  it("stops partial recovery without consuming the code", async () => {
    const calls = upstream({ delete: reply({}, 503) });
    expect(await run(recovery, body)).toEqual({ status: 502, body: { error: "partial-recovery", removed: 0 } });
    expect(calls.map(c => c.key)).toEqual(["claim_mfa_recovery_code", "factors", "prepare_mfa_recovery_signout", "delete"]);
  });
  it.each([reply({}, 503), new Error("timeout")])("keeps the code retryable when logout fails", async logout => {
    const calls = upstream({ logout });
    expect(await run(recovery, body)).toEqual({ status: 502, body: { error: "recovery-unavailable", removed: 1 } });
    expect(calls.some(c => c.key === "finalize_mfa_recovery_code")).toBe(false);
  });
  it.each([false, new Error("lost response")])("does not claim success without durable finalization", async finalized => {
    upstream({ factors: {}, finalize_mfa_recovery_code: finalized });
    expect(await run(recovery, body)).toEqual({ status: 502, body: { error: "recovery-unavailable", removed: 0 } });
  });
});
