// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import oauthHandler from "../api/constant-contact-oauth.js";
import syncHandler from "../api/constant-contact-sync.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

function responseRecorder() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(body) { this.body = body || ""; },
  };
}

function jsonBody(response) {
  return JSON.parse(response.body || "{}");
}

function rpcResponse(payload, status = 200) {
  const body = JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

function providerResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_ORIGIN);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", SUPABASE_REF);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Constant Contact server APIs", () => {
  it("reports the provider as unset without network egress", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = responseRecorder();
    await oauthHandler({ method: "GET", headers: { host: PORTAL_HOST }, query: {} }, response);
    expect(response.statusCode).toBe(200);
    expect(jsonBody(response)).toEqual({ ok: true, configured: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("stores only hashed browser state before returning the provider URL", async () => {
    vi.stubEnv("CONSTANT_CONTACT_CLIENT_ID", "customer-client-id");
    vi.stubEnv("CONSTANT_CONTACT_CLIENT_SECRET", "customer-client-secret-value");
    const fetcher = vi.fn().mockResolvedValueOnce(rpcResponse({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    const response = responseRecorder();
    await oauthHandler({
      method: "POST",
      headers: { host: PORTAL_HOST, authorization: "Bearer member-token" },
      body: { action: "start" },
    }, response);
    expect(response.statusCode).toBe(200);
    expect(jsonBody(response).authorizationUrl).toContain("authz.constantcontact.com");
    expect(response.headers["Set-Cookie"]).toMatch(/^constant_contact_oauth_binding=[A-Za-z0-9_-]{43};/);
    const rpcBody = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(rpcBody.p_state_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(rpcBody.p_browser_binding_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rpcBody)).not.toContain("customer-client-secret-value");
  });

  it("rejects an unknown callback state before token exchange", async () => {
    vi.stubEnv("CONSTANT_CONTACT_CLIENT_ID", "customer-client-id");
    vi.stubEnv("CONSTANT_CONTACT_CLIENT_SECRET", "customer-client-secret-value");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = vi.fn().mockResolvedValueOnce(rpcResponse({ error: "unknown" }, 404));
    vi.stubGlobal("fetch", fetcher);
    const response = responseRecorder();
    await oauthHandler({
      method: "GET",
      headers: { host: PORTAL_HOST, cookie: "constant_contact_oauth_binding=binding-value" },
      query: { code: "authorization-code", state: "unknown-state" },
    }, response);
    expect(response.statusCode).toBe(302);
    expect(response.headers.Location).toBe(`${PORTAL_ORIGIN}/m/integrations?constant_contact=error`);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain("claim_constant_contact_oauth_state");
    expect(errorSpy).toHaveBeenCalledWith("[constant-contact-oauth]", {
      kind: "callback_refused",
      reason: "state_unknown",
    });
  });

  it("returns a healthy unset sync without database or provider egress", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = responseRecorder();
    await syncHandler({ method: "POST", headers: { host: PORTAL_HOST, origin: PORTAL_ORIGIN }, body: { action: "sync" } }, response);
    expect(response.statusCode).toBe(200);
    expect(jsonBody(response)).toEqual({ ok: true, skipped: "activation_unset" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns invalid_input for a null JSON-text sync request without enqueueing", async () => {
    vi.stubEnv("CONSTANT_CONTACT_CLIENT_ID", "customer-client-id");
    vi.stubEnv("CONSTANT_CONTACT_CLIENT_SECRET", "customer-client-secret-value");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = responseRecorder();
    await syncHandler({
      method: "POST",
      headers: { host: "app.unionground.test", origin: "https://app.unionground.test", authorization: "Bearer member-token" },
      body: "null",
    }, response);
    expect(response.statusCode).toBe(400);
    expect(jsonBody(response)).toEqual({ ok: false, error: "invalid_input" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["object", "JSON text"])("does not exchange a token for a terminal credential claim using a %s body", async (format) => {
    vi.stubEnv("CONSTANT_CONTACT_CLIENT_ID", "customer-client-id");
    vi.stubEnv("CONSTANT_CONTACT_CLIENT_SECRET", "customer-client-secret-value");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(rpcResponse({ jobId: "job-1" }))
      .mockResolvedValueOnce(rpcResponse({ jobId: "job-1", terminal: true }));
    vi.stubGlobal("fetch", fetcher);
    const response = responseRecorder();
    await syncHandler({
      method: "POST",
      headers: { host: PORTAL_HOST, authorization: "Bearer member-token" },
      body: format === "JSON text" ? JSON.stringify({ action: "sync", limit: 25.9 }) : { action: "sync", limit: 25.9 },
    }, response);
    expect(response.statusCode).toBe(207);
    expect(jsonBody(response)).toEqual({ ok: false, jobId: "job-1", error: "credential_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[0][1].body).p_limit_count).toBe(25);
  });

  it("enqueues one due connected organization before a scheduled claim", async () => {
    vi.stubEnv("CONSTANT_CONTACT_CLIENT_ID", "customer-client-id");
    vi.stubEnv("CONSTANT_CONTACT_CLIENT_SECRET", "customer-client-secret-value");
    vi.stubEnv("CRON_SECRET", "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(rpcResponse({ ok: true, skipped: "no_due_connection" }))
      .mockResolvedValueOnce(rpcResponse(null));
    vi.stubGlobal("fetch", fetcher);
    const response = responseRecorder();
    await syncHandler({
      method: "GET",
      headers: { host: PORTAL_HOST, authorization: "Bearer cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx" },
    }, response);
    expect(response.statusCode).toBe(200);
    expect(jsonBody(response)).toEqual({ ok: true, skipped: "no_queued_job" });
    expect(String(fetcher.mock.calls[0][0])).toContain("enqueue_due_constant_contact_sync");
    expect(String(fetcher.mock.calls[1][0])).toContain("claim_constant_contact_sync_job");
  });

  it("keeps a partial provider failure non-successful after database completion", async () => {
    vi.stubEnv("CONSTANT_CONTACT_CLIENT_ID", "customer-client-id");
    vi.stubEnv("CONSTANT_CONTACT_CLIENT_SECRET", "customer-client-secret-value");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = vi.fn()
      .mockResolvedValueOnce(rpcResponse({ jobId: "job-1" }))
      .mockResolvedValueOnce(rpcResponse({ jobId: "job-1", terminal: false, refreshToken: "vault-refresh-token" }))
      .mockResolvedValueOnce(providerResponse({ access_token: "short-lived-access", token_type: "Bearer" }))
      .mockResolvedValueOnce(rpcResponse([{ memberId: "member-1", email: "member@example.com" }]))
      .mockResolvedValueOnce(providerResponse({}, 500))
      .mockResolvedValueOnce(rpcResponse({ ok: true, jobId: "job-1", status: "warning", processed: 1, matched: 0, notFound: 0, failed: 1, errorCode: "partial_failure" }));
    vi.stubGlobal("fetch", fetcher);
    const response = responseRecorder();
    await syncHandler({
      method: "POST",
      headers: { host: PORTAL_HOST, authorization: "Bearer member-token" },
      body: { action: "sync", limit: 1 },
    }, response);
    expect(response.statusCode).toBe(207);
    expect(jsonBody(response)).toEqual(expect.objectContaining({ ok: false, status: "warning", failed: 1 }));
  });

  it("attempts to terminally finish a claimed job after a worker exception", async () => {
    vi.stubEnv("CONSTANT_CONTACT_CLIENT_ID", "customer-client-id");
    vi.stubEnv("CONSTANT_CONTACT_CLIENT_SECRET", "customer-client-secret-value");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = vi.fn()
      .mockResolvedValueOnce(rpcResponse({ jobId: "job-1" }))
      .mockResolvedValueOnce(rpcResponse({ jobId: "job-1", terminal: false, refreshToken: "vault-refresh-token" }))
      .mockResolvedValueOnce(providerResponse({ access_token: "short-lived-access", token_type: "Bearer" }))
      .mockResolvedValueOnce(rpcResponse({ error: "down" }, 503))
      .mockResolvedValueOnce(rpcResponse({ ok: false, jobId: "job-1", status: "failed" }));
    vi.stubGlobal("fetch", fetcher);
    const response = responseRecorder();
    await syncHandler({
      method: "POST",
      headers: { host: PORTAL_HOST, authorization: "Bearer member-token" },
      body: { action: "sync", limit: 1 },
    }, response);
    expect(response.statusCode).toBe(502);
    expect(String(fetcher.mock.calls.at(-1)[0])).toContain("complete_constant_contact_sync_job");
    expect(JSON.parse(fetcher.mock.calls.at(-1)[1].body).p_error_code).toBe("worker_error");
  });

  it("completes one bounded member sync without returning or logging sensitive fields", async () => {
    vi.stubEnv("CONSTANT_CONTACT_CLIENT_ID", "customer-client-id");
    vi.stubEnv("CONSTANT_CONTACT_CLIENT_SECRET", "customer-client-secret-value");
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = vi.fn()
      .mockResolvedValueOnce(rpcResponse({ jobId: "job-1" }))
      .mockResolvedValueOnce(rpcResponse({ jobId: "job-1", terminal: false, refreshToken: "vault-refresh-token" }))
      .mockResolvedValueOnce(providerResponse({ access_token: "short-lived-access", token_type: "Bearer" }))
      .mockResolvedValueOnce(rpcResponse([{ memberId: "member-1", email: "member@example.com" }]))
      .mockResolvedValueOnce(providerResponse({ contacts: [{ contact_id: "contact-1", email_address: { permission_to_send: "implicit" } }] }))
      .mockResolvedValueOnce(providerResponse({ tracking_activities: [] }))
      .mockResolvedValueOnce({ ok: true, status: 204, text: async () => "" })
      .mockResolvedValueOnce(rpcResponse({ ok: true, jobId: "job-1", status: "success", processed: 1, matched: 1, notFound: 0, failed: 0, errorCode: null }));
    vi.stubGlobal("fetch", fetcher);
    const response = responseRecorder();
    await syncHandler({
      method: "POST",
      headers: { host: PORTAL_HOST, authorization: "Bearer member-token" },
      body: { action: "sync", limit: 1 },
    }, response);
    expect(response.statusCode).toBe(200);
    expect(jsonBody(response)).toEqual(expect.objectContaining({ ok: true, processed: 1, matched: 1 }));
    expect(response.body).not.toContain("member@example.com");
    expect(response.body).not.toContain("short-lived-access");
    expect(logSpy).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("authz.constantcontact.com"))).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("api.cc.email"))).toHaveLength(2);
  });
});
