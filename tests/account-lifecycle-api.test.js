// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/account-lifecycle.js";
import {
  ACCOUNT_DELETION_CLIENT_TIMEOUT_MS,
  ACCOUNT_DELETION_DELETE_TIMEOUT_MS,
  ACCOUNT_DELETION_RPC_TIMEOUT_MS,
  ACCOUNT_DELETION_SERVER_TIMEOUT_MS,
} from "../src/lib/accountLifecycleBudget.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

function responseRecorder() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body; },
  };
}

function response(payload, status = 200) {
  const body = payload == null ? "" : JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) };
}

const accessToken = "member-access-token";
const userId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const deletionToken = "d".repeat(64);

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_service-role-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("account lifecycle deletion endpoint", () => {
  it("derives the target through caller authorization, claims once, hard-deletes, marks durability, and finalizes", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    global.fetch = vi.fn()
      .mockResolvedValueOnce(response({ requestId, deletionToken, userId }))
      .mockResolvedValueOnce(response({ claimed: true }))
      .mockResolvedValueOnce(response(null, 204))
      .mockResolvedValueOnce(response({ marked: true }))
      .mockResolvedValueOnce(response({ recorded: true }))
      .mockResolvedValueOnce(response({ audited: true }));
    const res = responseRecorder();
    await handler({
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
      body: { confirmation: "DELETE MY ACCOUNT", userId: "attacker-controlled" },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(JSON.parse(res.body)).toEqual({ deleted: true, audited: true });
    expect(global.fetch).toHaveBeenCalledTimes(6);
    expect(global.fetch.mock.calls[0][0]).toContain("/rpc/authorize_member_account_deletion");
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${accessToken}`);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ p_confirmation: "DELETE MY ACCOUNT" });
    expect(global.fetch.mock.calls[1][0]).toContain("/rpc/claim_member_account_deletion");
    expect(global.fetch.mock.calls[2][0]).toContain(`/auth/v1/admin/users/${userId}?should_soft_delete=false`);
    expect(global.fetch.mock.calls[2][1].method).toBe("DELETE");
    expect(global.fetch.mock.calls[2][1].headers.apikey).toBe("sb_secret_service-role-key");
    expect(global.fetch.mock.calls[2][1].headers.Authorization).toBeUndefined();
    expect(global.fetch.mock.calls[2][1].headers["User-Agent"]).toBe("node");
    expect(global.fetch.mock.calls[3][0]).toContain("/rpc/mark_member_account_deletion_auth_completed");
    expect(JSON.parse(global.fetch.mock.calls[3][1].body)).toEqual({ p_request_id: requestId });
    expect(global.fetch.mock.calls[4][0]).toContain("/rpc/finalize_member_account_deletion");
    expect(global.fetch.mock.calls[5][0]).toContain("/rpc/member_account_deletion_has_terminal_audit");
    expect(JSON.parse(global.fetch.mock.calls[5][1].body)).toEqual({ p_request_id: requestId });
    expect(timeout.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      ACCOUNT_DELETION_RPC_TIMEOUT_MS,
      ACCOUNT_DELETION_RPC_TIMEOUT_MS,
      ACCOUNT_DELETION_DELETE_TIMEOUT_MS,
      ACCOUNT_DELETION_RPC_TIMEOUT_MS,
      ACCOUNT_DELETION_RPC_TIMEOUT_MS,
      ACCOUNT_DELETION_RPC_TIMEOUT_MS,
    ]);
  });

  it("still finalizes even when the durability marker call itself fails, and never blocks the response on it", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(response({ requestId, deletionToken, userId }))
      .mockResolvedValueOnce(response({ claimed: true }))
      .mockResolvedValueOnce(response(null, 204))
      .mockRejectedValueOnce(new Error("durability marker transport failed"))
      .mockResolvedValueOnce(response({ recorded: true }))
      .mockResolvedValueOnce(response({ audited: true }));
    const res = responseRecorder();
    await handler({ method: "POST", headers: { authorization: `Bearer ${accessToken}` }, body: { confirmation: "DELETE MY ACCOUNT" } }, res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: true, audited: true });
    expect(global.fetch).toHaveBeenCalledTimes(6);
    expect(global.fetch.mock.calls[4][0]).toContain("/rpc/finalize_member_account_deletion");
    expect(global.fetch.mock.calls[5][0]).toContain("/rpc/member_account_deletion_has_terminal_audit");
  });

  it("BUG-UG-ACCOUNT-DELETION-FINALIZATION-20260831: still records durability when Auth deletion returns 204 but finalization returns 503", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(response({ requestId, deletionToken, userId }))
      .mockResolvedValueOnce(response({ claimed: true }))
      .mockResolvedValueOnce(response(null, 204))
      .mockResolvedValueOnce(response({ marked: true }))
      .mockResolvedValueOnce(response({ message: "sensitive provider body" }, 503))
      .mockResolvedValueOnce(response({ audited: false }));
    const res = responseRecorder();
    await handler({ method: "POST", headers: { authorization: `Bearer ${accessToken}` }, body: { confirmation: "DELETE MY ACCOUNT" } }, res);
    // The transport contract to the browser is unchanged: audited:false, never
    // reported as a definitive failure. The durable-retry proof lives
    // server-side (see the mark_member_account_deletion_auth_completed call
    // below and scripts/verify-account-deletion-finalization-local.mjs), and
    // src/App.jsx's handleDeleteAccount must not treat this as fully
    // reconciled -- see tests/account-deletion-finalization-client.test.js.
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: true, audited: false });
    expect(global.fetch).toHaveBeenCalledTimes(6);
    expect(global.fetch.mock.calls[3][0]).toContain("/rpc/mark_member_account_deletion_auth_completed");
    expect(JSON.parse(global.fetch.mock.calls[3][1].body)).toEqual({ p_request_id: requestId });
    expect(global.fetch.mock.calls[5][0]).toContain("/rpc/member_account_deletion_has_terminal_audit");
    expect(res.body).not.toContain("sensitive provider body");
  });

  it("returns an honest unaudited deletion when both post-delete RPCs fail", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(response({ requestId, deletionToken, userId }))
      .mockResolvedValueOnce(response({ claimed: true }))
      .mockResolvedValueOnce(response(null, 204))
      .mockRejectedValueOnce(new Error("durability marker unavailable"))
      .mockRejectedValueOnce(new Error("finalization unavailable"))
      .mockRejectedValueOnce(new Error("terminal audit proof unavailable"));
    const res = responseRecorder();
    await handler({ method: "POST", headers: { authorization: `Bearer ${accessToken}` }, body: { confirmation: "DELETE MY ACCOUNT" } }, res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: true, audited: false });
    expect(global.fetch).toHaveBeenCalledTimes(6);
    expect(res.body).not.toContain("durability marker unavailable");
    expect(res.body).not.toContain("finalization unavailable");
    expect(res.body).not.toContain("terminal audit proof unavailable");
  });

  it("BUG-UG-ACCOUNT-DELETION-FINALIZATION-20260831: reports audited when reconciliation wins the finalizer race", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(response({ requestId, deletionToken, userId }))
      .mockResolvedValueOnce(response({ claimed: true }))
      .mockResolvedValueOnce(response(null, 204))
      .mockResolvedValueOnce(response({ marked: false }))
      .mockResolvedValueOnce(response({ recorded: false }))
      .mockResolvedValueOnce(response({ audited: true }));
    const res = responseRecorder();
    await handler({ method: "POST", headers: { authorization: `Bearer ${accessToken}` }, body: { confirmation: "DELETE MY ACCOUNT" } }, res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: true, audited: true });
    expect(global.fetch).toHaveBeenCalledTimes(6);
    expect(global.fetch.mock.calls[4][0]).toContain("/rpc/finalize_member_account_deletion");
    expect(global.fetch.mock.calls[5][0]).toContain("/rpc/member_account_deletion_has_terminal_audit");
  });

  it("fails closed before the admin API when authorization or atomic claim fails", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(response({ error: "denied" }, 403));
    const denied = responseRecorder();
    await handler({ method: "POST", headers: { authorization: `Bearer ${accessToken}` }, body: { confirmation: "wrong" } }, denied);
    expect(denied.statusCode).toBe(403);
    expect(JSON.parse(denied.body)).toEqual({ error: "not-permitted" });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    global.fetch = vi.fn()
      .mockResolvedValueOnce(response({ requestId, deletionToken, userId }))
      .mockResolvedValueOnce(response({ claimed: false }));
    const raced = responseRecorder();
    await handler({ method: "POST", headers: { authorization: `Bearer ${accessToken}` }, body: { confirmation: "DELETE MY ACCOUNT" } }, raced);
    expect(raced.statusCode).toBe(409);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes("/auth/v1/admin/users/"))).toBe(false);
  });

  it("keeps the durable request processing and reports an indeterminate outcome when GoTrue returns 5xx", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(response({ requestId, deletionToken, userId }))
      .mockResolvedValueOnce(response({ claimed: true }))
      .mockResolvedValueOnce(response({ message: "sensitive provider body" }, 503));
    const res = responseRecorder();
    await handler({ method: "POST", headers: { authorization: `Bearer ${accessToken}` }, body: { confirmation: "DELETE MY ACCOUNT" } }, res);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: "account-delete-indeterminate" });
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes("/rpc/finalize_member_account_deletion"))).toBe(false);
    expect(res.body).not.toContain("sensitive provider body");
  });

  it("keeps the durable request processing after a network failure and never returns provider content", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(response({ requestId, deletionToken, userId }))
      .mockResolvedValueOnce(response({ claimed: true }))
      .mockRejectedValueOnce(new Error("socket included sensitive request body"));
    const res = responseRecorder();
    await handler({ method: "POST", headers: { authorization: `Bearer ${accessToken}` }, body: { confirmation: "DELETE MY ACCOUNT" } }, res);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: "account-delete-indeterminate" });
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes("/rpc/finalize_member_account_deletion"))).toBe(false);
    expect(res.body).not.toContain("socket included sensitive request body");
  });

  it("reports an explicit provider 4xx refusal as definitive while preserving the bounded audit code", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(response({ requestId, deletionToken, userId }))
      .mockResolvedValueOnce(response({ claimed: true }))
      .mockResolvedValueOnce(response({ message: "sensitive provider body" }, 422))
      .mockResolvedValueOnce(response({ recorded: true }));
    const res = responseRecorder();
    await handler({ method: "POST", headers: { authorization: `Bearer ${accessToken}` }, body: { confirmation: "DELETE MY ACCOUNT" } }, res);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: "account-delete-failed" });
    expect(JSON.parse(global.fetch.mock.calls[3][1].body)).toEqual({
      p_request_id: requestId,
      p_token: deletionToken,
      p_succeeded: false,
      p_failure_code: "auth-delete-refused",
    });
    expect(res.body).not.toContain("sensitive provider body");
  });

  it("fails closed on malformed authorization state before any service-role call", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(response({
      requestId: "not-a-uuid",
      deletionToken,
      userId,
    }));
    const res = responseRecorder();
    await handler({ method: "POST", headers: { authorization: `Bearer ${accessToken}` }, body: { confirmation: "DELETE MY ACCOUNT" } }, res);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: "account-lifecycle-unavailable" });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects missing auth, malformed bodies, unsupported methods, and missing config without network calls", async () => {
    global.fetch = vi.fn();
    for (const [request, status] of [
      [{ method: "GET", headers: {}, body: {} }, 405],
      [{ method: "POST", headers: {}, body: { confirmation: "DELETE MY ACCOUNT" } }, 403],
      [{ method: "POST", headers: { authorization: `Bearer ${accessToken}` }, body: { confirmation: "x".repeat(200) } }, 400],
    ]) {
      const res = responseRecorder();
      await handler(request, res);
      expect(res.statusCode).toBe(status);
    }
    expect(global.fetch).not.toHaveBeenCalled();

    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const unconfigured = responseRecorder();
    await handler({ method: "POST", headers: { authorization: `Bearer ${accessToken}` }, body: { confirmation: "DELETE MY ACCOUNT" } }, unconfigured);
    expect(unconfigured.statusCode).toBe(503);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("account lifecycle deployment budget", () => {
  it("keeps the browser beyond the composite server deadline and inside the function ceiling", () => {
    const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    const functionTimeoutMs = config.functions?.["api/account-lifecycle.js"]?.maxDuration * 1_000;
    expect(ACCOUNT_DELETION_CLIENT_TIMEOUT_MS).toBeGreaterThan(ACCOUNT_DELETION_SERVER_TIMEOUT_MS);
    expect(functionTimeoutMs).toBeGreaterThan(ACCOUNT_DELETION_CLIENT_TIMEOUT_MS);
  });
});
