// @vitest-environment node
// BUG-UG-ACCOUNT-DELETION-REQUIRES-TWO-STEP-20261016: a member with no
// second factor re-enters their password; the route authorizes the deletion
// with a fresh password session for the caller's own account only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/account-lifecycle.js";
import { readFileSync } from "node:fs";
import { requestAccountDeletion } from "../src/lib/accountLifecycleApi.js";
import { ACCOUNT_DELETION_CLIENT_TIMEOUT_MS, ACCOUNT_DELETION_SERVER_TIMEOUT_MS } from "../src/lib/accountLifecycleBudget.js";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";
import { hasVerifiedSecondFactor } from "../src/App.jsx";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

function responseRecorder() {
  return {
    statusCode: 0, headers: {}, body: "",
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body; },
  };
}
function reply(payload, status = 200) {
  const body = payload == null ? "" : JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) };
}

const accessToken = "member-access-token";
const freshToken = "fresh-password-session-token";
const userId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const deletionToken = "d".repeat(64);
const password = "correct horse battery";
const caller = reply({ id: userId, email: "Member@Example.test" });
const request = (body) => ({ method: "POST", headers: { authorization: `Bearer ${accessToken}` }, body: { confirmation: "DELETE MY ACCOUNT", ...body } });
const urls = () => global.fetch.mock.calls.map(([url]) => String(url));

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_service-role-key");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("account deletion with password re-entry", () => {
  it("authorizes with a fresh password session for the caller's own email, ends it, then deletes", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(caller)
      .mockResolvedValueOnce(reply(true))
      .mockResolvedValueOnce(reply({ access_token: freshToken, refresh_token: "r", user: { id: userId } }))
      .mockResolvedValueOnce(reply({ requestId, deletionToken, userId }))
      .mockResolvedValueOnce(reply(null, 204))
      .mockResolvedValueOnce(reply({ claimed: true }))
      .mockResolvedValueOnce(reply(null, 204))
      .mockResolvedValueOnce(reply({ marked: true }))
      .mockResolvedValueOnce(reply({ recorded: true }))
      .mockResolvedValueOnce(reply({ audited: true }));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const res = responseRecorder();
    await handler(request({ password, email: "attacker@example.test" }), res);
    // Every sequential call on the password path fits the shared budget,
    // and the browser and function ceiling both wait beyond it.
    const spent = timeout.mock.calls.reduce((sum, [milliseconds]) => sum + milliseconds, 0);
    expect(timeout).toHaveBeenCalledTimes(10);
    expect(spent).toBeLessThanOrEqual(ACCOUNT_DELETION_SERVER_TIMEOUT_MS);
    expect(ACCOUNT_DELETION_CLIENT_TIMEOUT_MS).toBeGreaterThan(ACCOUNT_DELETION_SERVER_TIMEOUT_MS);
    const ceiling = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")).functions["api/account-lifecycle.js"].maxDuration * 1_000;
    expect(ceiling).toBeGreaterThan(ACCOUNT_DELETION_CLIENT_TIMEOUT_MS);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: true, audited: true });
    expect(urls()[0]).toBe("https://project.supabase.co/auth/v1/user");
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${accessToken}`);
    expect(urls()[1]).toContain("/rpc/consume_password_signin_attempt");
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toMatchObject({ p_email: "member@example.test" });
    expect(urls()[2]).toContain("/auth/v1/token?grant_type=password");
    expect(JSON.parse(global.fetch.mock.calls[2][1].body)).toEqual({ email: "member@example.test", password });
    expect(urls()[3]).toContain("/rpc/authorize_member_account_deletion");
    expect(global.fetch.mock.calls[3][1].headers.Authorization).toBe(`Bearer ${freshToken}`);
    expect(urls()[4]).toContain("/auth/v1/logout?scope=local");
    expect(global.fetch.mock.calls[4][1].headers.Authorization).toBe(`Bearer ${freshToken}`);
    expect(urls()[5]).toContain("/rpc/claim_member_account_deletion");
    expect(urls()[6]).toContain(`/auth/v1/admin/users/${userId}`);
  });

  // Union Ground signs in with email and password only (Codex P1 on #12):
  // a refused password ends the request and never falls back to the caller's
  // own session, even a fresh one the database would accept.
  it("answers a wrong password with reauth-failed and never tries the current session", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(caller)
      .mockResolvedValueOnce(reply(true))
      .mockResolvedValueOnce(reply({ error_code: "invalid_credentials" }, 400))
      .mockResolvedValueOnce(reply({ requestId, deletionToken, userId }));
    const res = responseRecorder();
    await handler(request({ password: "wrong password" }), res);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "reauth-failed" });
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(urls().some((url) => url.includes("authorize_member_account_deletion"))).toBe(false);
  });

  it.each([503, 500, 408])("treats a password grant answering %i as unavailable, not a wrong password", async (status) => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(caller)
      .mockResolvedValueOnce(reply(true))
      .mockResolvedValueOnce(reply({}, status));
    const res = responseRecorder();
    await handler(request({ password }), res);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: "account-lifecycle-unavailable" });
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["the shared sign-in throttle", [caller, reply(false)]],
    ["a rate-limited password grant", [caller, reply(true), reply({}, 429)]],
  ])("answers try-later at %s without trying the current session", async (_label, replies) => {
    global.fetch = vi.fn();
    for (const next of [...replies, reply({ requestId, deletionToken, userId })]) global.fetch.mockResolvedValueOnce(next);
    const res = responseRecorder();
    await handler(request({ password }), res);
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body)).toEqual({ error: "try-later" });
    expect(global.fetch).toHaveBeenCalledTimes(replies.length);
    expect(urls().some((url) => url.includes("authorize_member_account_deletion"))).toBe(false);
  });

  // Union Ground has no PIN sessions, so the route makes no restriction
  // lookup; every remaining stage still counts at its own ceiling.
  it("budgets every stage of a password re-entry deletion inside the server timeout", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(caller)
      .mockResolvedValueOnce(reply(true))
      .mockResolvedValueOnce(reply({ access_token: freshToken, user: { id: userId } }))
      .mockResolvedValueOnce(reply({ requestId, deletionToken, userId }))
      .mockResolvedValueOnce(reply(null, 204))
      .mockResolvedValueOnce(reply({ claimed: true }))
      .mockResolvedValueOnce(reply(null, 204))
      .mockResolvedValueOnce(reply({ marked: true }))
      .mockResolvedValueOnce(reply({ recorded: true }))
      .mockResolvedValueOnce(reply({ audited: true }));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const res = responseRecorder();
    await handler(request({ password }), res);
    expect(res.statusCode).toBe(200);
    expect(urls().some((url) => url.includes("get_my_session_restriction"))).toBe(false);
    expect(timeout).toHaveBeenCalledTimes(10);
    const spent = timeout.mock.calls.reduce((sum, [milliseconds]) => sum + milliseconds, 0);
    expect(spent).toBe(ACCOUNT_DELETION_SERVER_TIMEOUT_MS);
    expect(ACCOUNT_DELETION_CLIENT_TIMEOUT_MS).toBeGreaterThan(spent);
  });

  it("refuses a grant that names another user and ends that session", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(caller)
      .mockResolvedValueOnce(reply(true))
      .mockResolvedValueOnce(reply({ access_token: freshToken, user: { id: "33333333-3333-4333-8333-333333333333" } }))
      .mockResolvedValueOnce(reply(null, 204));
    const res = responseRecorder();
    await handler(request({ password }), res);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "not-permitted" });
    expect(urls()[3]).toContain("/auth/v1/logout?scope=local");
    expect(urls().some((url) => url.includes("authorize_member_account_deletion"))).toBe(false);
  });

  it("ends the fresh session when the database still refuses (a member with a second factor)", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(caller)
      .mockResolvedValueOnce(reply(true))
      .mockResolvedValueOnce(reply({ access_token: freshToken, user: { id: userId } }))
      .mockResolvedValueOnce(reply({ code: "42501" }, 403))
      .mockResolvedValueOnce(reply(null, 204));
    const res = responseRecorder();
    await handler(request({ password }), res);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "not-permitted" });
    expect(urls()[4]).toContain("/auth/v1/logout?scope=local");
    expect(urls().some((url) => url.includes("claim_member_account_deletion"))).toBe(false);
  });

  it.each([
    ["a password that is not text", { password: 1234567890 }, [], 400, "invalid-confirmation"],
    ["an unavailable auth server", { password }, [reply(null, 503)], 502, "account-lifecycle-unavailable"],
    ["a rejected access token", { password }, [reply({ msg: "bad jwt" }, 401)], 401, "unauthenticated"],
    ["an account with no email", { password }, [reply({ id: userId, email: "" })], 403, "not-permitted"],
    ["an unreachable throttle", { password }, [caller, new Error("network")], 502, "account-lifecycle-unavailable"],
    ["an unreachable password grant", { password }, [caller, reply(true), new Error("network")], 502, "account-lifecycle-unavailable"],
    ["a grant with no session", { password }, [caller, reply(true), reply({ user: { id: userId } })], 502, "account-lifecycle-unavailable"],
    ["a grant whose body is unreadable", { password }, [caller, reply(true), { ok: true, status: 200, text: async () => "", json: async () => { throw new SyntaxError("x"); } }], 502, "account-lifecycle-unavailable"],
  ])("refuses %s before authorizing", async (_label, body, replies, status, error) => {
    global.fetch = vi.fn();
    for (const next of replies) {
      if (next instanceof Error) global.fetch.mockRejectedValueOnce(next);
      else global.fetch.mockResolvedValueOnce(next);
    }
    const res = responseRecorder();
    await handler(request(body), res);
    expect(res.statusCode).toBe(status);
    expect(JSON.parse(res.body)).toEqual({ error });
    expect(global.fetch).toHaveBeenCalledTimes(replies.length);
    expect(urls().some((url) => url.includes("authorize_member_account_deletion"))).toBe(false);
  });

  it.each([["too short", "short"], ["too long", "x".repeat(257)]])("refuses a password %s to be one without any network call", async (_label, typed) => {
    global.fetch = vi.fn();
    const res = responseRecorder();
    await handler(request({ password: typed }), res);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "reauth-failed" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("still answers when ending the fresh session fails", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(caller)
      .mockResolvedValueOnce(reply(true))
      .mockResolvedValueOnce(reply({ access_token: freshToken, user: { id: "33333333-3333-4333-8333-333333333333" } }))
      .mockRejectedValueOnce(new Error("network"));
    const res = responseRecorder();
    await handler(request({ password }), res);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "not-permitted" });
  });

  it("keeps the session-only path unchanged when no password is given", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(reply({ code: "42501" }, 403));
    const res = responseRecorder();
    await handler(request({}), res);
    expect(res.statusCode).toBe(403);
    expect(urls()).toEqual([expect.stringContaining("/rpc/authorize_member_account_deletion")]);
  });

  it("client sends the password once and treats the new refusals as definite, never indeterminate", async () => {
    const fetchImpl = vi.fn(async () => reply({ error: "reauth-failed" }, 403));
    await expect(requestAccountDeletion({ access_token: "t" }, "DELETE MY ACCOUNT", fetchImpl, "/api/account-lifecycle", { password }))
      .rejects.toMatchObject({ code: "reauth-failed" });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ confirmation: "DELETE MY ACCOUNT", password });
    fetchImpl.mockResolvedValueOnce(reply({ error: "try-later" }, 429));
    await expect(requestAccountDeletion({ access_token: "t" }, "DELETE MY ACCOUNT", fetchImpl)).rejects.toMatchObject({ code: "try-later" });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ confirmation: "DELETE MY ACCOUNT" });
  });
});

describe("authorize_member_account_deletion step-up (20261017155000)", () => {
  const body = fnBody(loadMigrationSql("account_deletion_password_reauth"), "public.authorize_member_account_deletion(p_confirmation text)");
  const [factorBranch, noFactorBranch] = body.split(/\n\s*else\n/);
  it("keeps the aal2 TOTP/WebAuthn rule for a member with a verified factor", () => {
    expect(factorBranch).toContain("factor.status = 'verified'");
    // Codex P1 on #4620: only a TOTP factor selects the aal2 branch. The app
    // can challenge no other type, so a phone- or WebAuthn-only member who
    // landed here could never delete; they take the password branch instead.
    expect(factorBranch).toMatch(/factor\.status = 'verified'\s+and factor\.factor_type = 'totp'/);
    expect(factorBranch).toContain("is distinct from 'aal2'");
    expect(factorBranch).toContain("s.aal = 'aal2'");
    expect(factorBranch).toContain("amr.authentication_method in ('totp', 'webauthn')");
  });
  it("accepts a recent password or provider sign-in for a member with none, or anything the factor rule accepts, never a PIN session", () => {
    expect(noFactorBranch).toContain("not private.mfa_satisfied()");
    expect(noFactorBranch).toContain("amr.authentication_method in ('password', 'oauth', 'passkey', 'sso/saml')");
    expect(noFactorBranch).toContain("or (s.aal = 'aal2' and amr.authentication_method in ('totp', 'webauthn'))");
    expect(noFactorBranch).toContain("now() - interval '10 minutes'");
    expect(noFactorBranch).not.toMatch(/'otp'|'magiclink'/);
  });
  it("offers web password re-entry to every member without a challengeable TOTP factor", () => {
    const factor = (factor_type, status = "verified") => ({ factor_type, status });
    expect(hasVerifiedSecondFactor({ factors: [factor("totp")] })).toBe(true);
    expect(hasVerifiedSecondFactor({ factors: [factor("phone"), factor("totp")] })).toBe(true);
    expect(hasVerifiedSecondFactor({ factors: [factor("phone")] })).toBe(false);
    expect(hasVerifiedSecondFactor({ factors: [factor("webauthn")] })).toBe(false);
    expect(hasVerifiedSecondFactor({ factors: [factor("totp", "unverified")] })).toBe(false);
    expect(hasVerifiedSecondFactor({ factors: [] })).toBe(false);
    expect(hasVerifiedSecondFactor({})).toBe(false);
  });
});
