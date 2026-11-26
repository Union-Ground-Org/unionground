// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import oauthHandler from "../api/constant-contact-oauth.js";
import syncHandler from "../api/constant-contact-sync.js";
import { hashConstantContactSecret } from "../api/_lib/constantContact.js";
import { pinnedSampleSupabaseOrigin } from "../src/lib/sampleBackend.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SAMPLE_HOST, SAMPLE_ORIGIN } from "./helpers/fictional-provider.js";
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://fixture.supabase.co"));

// Fictional protocol fixtures; exercise the real handlers and provider adapters.
function reply(payload, status = 200) { return new Response(JSON.stringify(payload), { status }); }
function recorder() {
  return {
    statusCode: 0, headers: {}, body: "",
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(value) { this.body = value || ""; },
  };
}
const claimedState = {
  organizationId: "fixture-organization", requestedBy: "fixture-user", codeVerifier: "fixture-verifier",
  redirectUri: `${PORTAL_ORIGIN}/api/constant-contact-oauth`,
};
let fetcher;
async function invoke(handler, overrides = {}) {
  const response = recorder();
  await handler({ method: "POST", body: { action: handler === oauthHandler ? "start" : "sync" },
    headers: { host: PORTAL_HOST, origin: PORTAL_ORIGIN, authorization: "Bearer fixture-member" },
    ...overrides,
  }, response);
  return response;
}
function payload(response) { return JSON.parse(response.body); }
async function callback(query = { code: "fixture-code", state: "fixture-state" }, headers = {}) {
  return invoke(oauthHandler, { method: "GET", query, headers: {
    host: PORTAL_HOST, cookie: "constant_contact_oauth_binding=fixture-binding", ...headers,
  } });
}
function expectRedirect(response, result = "error", origin = PORTAL_ORIGIN) {
  expect(response.statusCode).toBe(302);
  expect(response.headers.Location).toBe(`${origin}/m/integrations?constant_contact=${result}`);
  expect(response.headers["Cache-Control"]).toBe("no-store");
  expect(response.headers["Set-Cookie"]).toContain("Max-Age=0; HttpOnly; Secure; SameSite=Lax");
  expect(response.body).toBe("");
}
function rpcBody(name) {
  const call = fetcher.mock.calls.find(([url]) => String(url).endsWith(`/rpc/${name}`));
  expect(call, `Expected ${name} RPC`).toBeDefined();
  return JSON.parse(call[1].body);
}
function queueJob() {
  fetcher.mockResolvedValueOnce(reply({ jobId: "fixture-job" }))
    .mockResolvedValueOnce(reply({ jobId: "fixture-job", refreshToken: "fixture-refresh" }));
}
beforeEach(() => {
  for (const [key, value] of Object.entries({
    VITE_SUPABASE_URL: "https://fixture.supabase.co", UNIONGROUND_SUPABASE_PROJECT_REF: "fixture", VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_fixture", CONSTANT_CONTACT_CLIENT_ID: "fixture-client",
    CONSTANT_CONTACT_CLIENT_SECRET: "fixture-client-secret-long-enough", CRON_SECRET: "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx",
  })) vi.stubEnv(key, value);
  fetcher = vi.fn(() => { throw new Error("Unexpected external request"); });
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe.each([["OAuth", oauthHandler], ["sync", syncHandler]])("Constant Contact %s request boundaries", (_name, handler) => {
  it("rejects a foreign Origin before external requests", async () => {
    const response = await invoke(handler, { headers: { host: PORTAL_HOST, origin: "https://foreign.example", authorization: "Bearer fixture-member" } });
    expect(response.statusCode).toBe(403);
    expect(payload(response)).toEqual({ error: "untrusted-origin" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects unsupported methods before external requests", async () => {
    const response = await invoke(handler, { method: "OPTIONS" });
    expect(response.statusCode).toBe(405);
    expect(payload(response)).toEqual({ ok: false, error: "method_not_allowed" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reports incomplete backend configuration", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const response = await invoke(handler);
    expect(response.statusCode).toBe(503);
    expect(payload(response)).toEqual({ ok: false, error: "not_configured" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("requires a member bearer token for trusted browser POSTs", async () => {
    const response = await invoke(handler, { headers: { host: PORTAL_HOST, origin: PORTAL_ORIGIN } });
    expect(response.statusCode).toBe(401);
    expect(payload(response)).toEqual({ ok: false, error: "unauthorized" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([undefined, "{broken", '{}', '{"action":"unknown"}'])("rejects invalid action body %s without writes", async (body) => {
    const response = await invoke(handler, { body });
    expect(response.statusCode).toBe(400);
    expect(payload(response)).toEqual({ ok: false, error: "invalid_input" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([401, 403, 500])("maps caller RPC status %s and performs no subsequent writes", async (status) => {
    fetcher.mockResolvedValueOnce(reply({ error: "denied" }, status));
    const response = await invoke(handler);
    expect(response.statusCode).toBe(status === 500 ? 503 : 403);
    expect(payload(response)).toEqual({ ok: false, error: status === 500 ? "unavailable" : "unauthorized" });
    expect(response.headers["Set-Cookie"]).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("Constant Contact OAuth callback lifecycle", () => {
  it.each(["credentials", "redirect"])("refuses a start with unavailable %s", async (missing) => {
    if (missing === "credentials") vi.stubEnv("CONSTANT_CONTACT_CLIENT_SECRET", "");
    const response = await invoke(oauthHandler, missing === "redirect" ? { headers: { host: "unknown.example", authorization: "Bearer fixture-member" } } : {});
    expect(response.statusCode).toBe(409);
    expect(payload(response)).toEqual({ ok: false, error: "activation_unset" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    [{ error: "access_denied" }, {}, "denied"],
    [{ code: "fixture-code" }, {}, "error"],
    [{ state: "fixture-state" }, {}, "error"],
    [{ code: "fixture-code", state: "fixture-state" }, { cookie: "" }, "error"],
  ])("clears the browser binding on invalid callbacks %j", async (query, headers, status) => {
    expectRedirect(await callback(query, headers), status);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("fails closed on denied SAMPLE callbacks because no sample project is pinned", async () => {
    // Union Ground pins no SAMPLE project, so the demo host never resolves a backend:
    // the callback is refused as not configured and nothing is fetched or redirected.
    vi.stubEnv("SAMPLE_SUPABASE_URL", pinnedSampleSupabaseOrigin());
    vi.stubEnv("SAMPLE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_sample_fixture");
    vi.stubEnv("SAMPLE_SUPABASE_SERVICE_ROLE_KEY", "sb_secret_sample_fixture");
    const response = await callback({ error: "access_denied" }, { host: SAMPLE_HOST });
    expect(response.statusCode).toBe(503);
    expect(payload(response)).toEqual({ ok: false, error: "not_configured" });
    expect(response.headers.Location).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("exchanges claimed PKCE state and stores credentials for only the claimed organization", async () => {
    fetcher.mockResolvedValueOnce(reply(claimedState))
      .mockResolvedValueOnce(reply({ access_token: "fixture-access", refresh_token: "fixture-new-refresh", scope: "contact_data" }))
      .mockResolvedValueOnce(reply({ organization_name: "Fixture Harborview Care United", contact_email: "owner@fixture.example" }))
      .mockResolvedValueOnce(reply({ ok: true }));
    expectRedirect(await callback(), "connected");
    expect(rpcBody("claim_constant_contact_oauth_state")).toEqual({
      p_state_hash: hashConstantContactSecret("fixture-state"),
      p_browser_binding_hash: hashConstantContactSecret("fixture-binding"),
    });
    const [, options] = fetcher.mock.calls[1];
    expect(options.body.get("code_verifier")).toBe(claimedState.codeVerifier);
    expect(options.body.get("redirect_uri")).toBe(claimedState.redirectUri);
    expect(options.body.get("grant_type")).toBe("authorization_code");
    expect(String(fetcher.mock.calls[2][0])).toBe("https://api.cc.email/v3/account/summary");
    expect(fetcher.mock.calls[2][1].headers.Authorization).toBe("Bearer fixture-access");
    expect(fetcher.mock.calls[2][1].redirect).toBe("error");
    expect(rpcBody("complete_constant_contact_oauth")).toEqual({
      p_organization_id: claimedState.organizationId, p_requested_by: claimedState.requestedBy,
      p_refresh_token: "fixture-new-refresh", p_scope: "contact_data", p_account_label: "Fixture Harborview Care United",
    });
    expect(fetcher.mock.calls[3][1].headers.apikey).toBe("sb_secret_fixture");
  });
  it.each(["network", "forbidden", "blank"])("falls back to the placeholder label after a %s account lookup", async (failure) => {
    fetcher.mockResolvedValueOnce(reply(claimedState))
      .mockResolvedValueOnce(reply({ access_token: "fixture-access", refresh_token: "fixture-new-refresh" }));
    if (failure === "network") fetcher.mockRejectedValueOnce(new Error("offline"));
    else fetcher.mockResolvedValueOnce(reply(failure === "forbidden" ? { error_key: "unauthorized" } : { organization_name: " \u0007 " },
      failure === "forbidden" ? 403 : 200));
    fetcher.mockResolvedValueOnce(reply({ ok: true }));
    expectRedirect(await callback(), "connected");
    expect(rpcBody("complete_constant_contact_oauth").p_account_label).toBe("Connected account");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it.each(["network", "rejected", "missing-refresh"])("does not store credentials after %s token exchange", async (failure) => {
    fetcher.mockResolvedValueOnce(reply(claimedState));
    if (failure === "network") fetcher.mockRejectedValueOnce(new Error("offline"));
    else fetcher.mockResolvedValueOnce(reply({ access_token: "fixture-access" }, failure === "rejected" ? 401 : 200));
    expectRedirect(await callback());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1][0])).toContain("authz.constantcontact.com");
  });
  it("reports token storage failure instead of claiming a connection", async () => {
    fetcher.mockResolvedValueOnce(reply(claimedState))
      .mockResolvedValueOnce(reply({ access_token: "fixture-access", refresh_token: "fixture-new-refresh" }))
      .mockResolvedValueOnce(reply({ organization_name: "Fixture Harborview Care United" }))
      .mockResolvedValueOnce(reply({ error: "removed organization" }, 400));
    expectRedirect(await callback());
    expect(rpcBody("complete_constant_contact_oauth").p_organization_id).toBe(claimedState.organizationId);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

describe("Constant Contact sync worker lifecycle", () => {
  it.each([undefined, "Bearer wrong", "Bearer fixture-croX"])("rejects unauthenticated cron authorization %s", async (authorization) => {
    const response = await invoke(syncHandler, { method: "GET", headers: { host: PORTAL_HOST, authorization } });
    expect(response.statusCode).toBe(401);
    expect(payload(response).error).toBe("unauthorized");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not authorize cron if the deployment secret is unset", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const response = await invoke(syncHandler, { method: "GET" });
    expect(response.statusCode).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reports a cron enqueue failure before claiming work", async () => {
    fetcher.mockResolvedValueOnce(reply({ error: "unavailable" }, 503));
    const response = await invoke(syncHandler, { method: "GET", headers: { host: PORTAL_HOST, authorization: "Bearer cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx" } });
    expect(response.statusCode).toBe(502);
    expect(payload(response)).toEqual({ ok: false, error: "worker_error" });
    expect(rpcBody("enqueue_due_constant_contact_sync")).toEqual({});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([{}, { "x-vercel-cron": "1" }])("returns an idle cron tick without token exchange %j", async (headers) => {
    fetcher.mockResolvedValueOnce(reply({})).mockResolvedValueOnce(reply(null));
    const response = await invoke(syncHandler, { method: "GET", headers: { host: PORTAL_HOST, authorization: "Bearer cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx", ...headers } });
    expect(response.statusCode).toBe(200);
    expect(payload(response)).toEqual({ ok: true, skipped: "no_queued_job" });
    expect(rpcBody("claim_constant_contact_sync_job")).toEqual({ p_job_id: null });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([[0, 25], [-9, 1], [100, 25], [2.9, 2]])("bounds requested limit %s to %s", async (limit, expected) => {
    fetcher.mockResolvedValueOnce(reply({})).mockResolvedValueOnce(reply(null));
    const response = await invoke(syncHandler, { body: JSON.stringify({ action: "sync", limit }) });
    expect(response.statusCode).toBe(200);
    expect(rpcBody("enqueue_constant_contact_sync")).toEqual({ p_limit_count: expected });
    expect(payload(response)).toEqual({ ok: true, skipped: "no_queued_job" });
  });
  it.each(["rejected", "network"])("finalizes a claim after %s token failure", async (failure) => {
    queueJob();
    if (failure === "network") fetcher.mockRejectedValueOnce(new Error("offline"));
    else fetcher.mockResolvedValueOnce(reply({ error: "invalid_grant" }, 400));
    fetcher.mockResolvedValueOnce(reply({ ok: false }));
    const response = await invoke(syncHandler);
    const reason = failure === "network" ? "provider_error" : "credential_rejected";
    expect(response.statusCode).toBe(207);
    expect(payload(response)).toEqual({ ok: false, jobId: "fixture-job", error: reason });
    expect(rpcBody("complete_constant_contact_sync_job")).toEqual({
      p_job_id: "fixture-job", p_processed_count: 0, p_matched_count: 0, p_not_found_count: 0,
      p_failed_count: 0, p_error_code: reason,
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("rotates a refresh token before listing and records matched and absent contacts", async () => {
    queueJob();
    fetcher.mockResolvedValueOnce(reply({ access_token: "fixture-access", refresh_token: "fixture-rotated", scope: "contact_data" }))
      .mockResolvedValueOnce(reply({ ok: true }))
      .mockResolvedValueOnce(reply([{ memberId: "fixture-member-1", email: "member1@example.test" }, { memberId: "fixture-member-2", email: "member2@example.test" }]))
      .mockResolvedValueOnce(reply({ contacts: [{ contact_id: "fixture-contact", list_memberships: ["list-1"], taggings: ["tag-1", "tag-2"] }] }))
      .mockResolvedValueOnce(reply({ tracking_activities: [{ tracking_activity_type: "em_opens", created_time: "2026-09-01T12:00:00Z" }] }))
      .mockResolvedValueOnce(reply({ ok: true }))
      .mockResolvedValueOnce(reply({ contacts: [] }))
      .mockResolvedValueOnce(reply({ ok: true }))
      .mockResolvedValueOnce(reply({ jobId: "fixture-job", status: "completed" }));
    const response = await invoke(syncHandler);
    expect(response.statusCode).toBe(200);
    expect(payload(response)).toEqual({ ok: true, jobId: "fixture-job", status: "completed" });
    expect(rpcBody("rotate_constant_contact_refresh_token")).toEqual({ p_job_id: "fixture-job", p_refresh_token: "fixture-rotated", p_scope: "contact_data" });
    const records = fetcher.mock.calls.filter(([url]) => String(url).endsWith("/rpc/record_constant_contact_sync_result")).map(([, options]) => JSON.parse(options.body));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ p_member_id: "fixture-member-1", p_provider_contact_id: "fixture-contact", p_list_count: 1, p_tag_count: 2, p_opens_count: 1, p_last_activity_at: "2026-09-01T12:00:00.000Z" });
    expect(records[1]).toMatchObject({ p_member_id: "fixture-member-2", p_provider_contact_id: null, p_contact_status: "not_found", p_opens_count: 0 });
    expect(rpcBody("complete_constant_contact_sync_job")).toEqual({ p_job_id: "fixture-job", p_processed_count: 2, p_matched_count: 1, p_not_found_count: 1, p_failed_count: 0, p_error_code: null });
  });
  it("continues after a failed member and finalizes accurate partial counts", async () => {
    queueJob();
    fetcher.mockResolvedValueOnce(reply({ access_token: "fixture-access" }))
      .mockResolvedValueOnce(reply([{ memberId: "fixture-member-1", email: "member1@example.test" }, { memberId: "fixture-member-2", email: "member2@example.test" }]))
      .mockResolvedValueOnce(reply({ error: "expired" }, 401))
      .mockResolvedValueOnce(reply({ contacts: [] }))
      .mockResolvedValueOnce(reply({ ok: true }))
      .mockResolvedValueOnce(reply({ jobId: "fixture-job" }));
    const response = await invoke(syncHandler);
    expect(response.statusCode).toBe(207);
    expect(payload(response)).toEqual({ ok: false, jobId: "fixture-job" });
    expect(rpcBody("complete_constant_contact_sync_job")).toEqual({ p_job_id: "fixture-job", p_processed_count: 2, p_matched_count: 0, p_not_found_count: 1, p_failed_count: 1, p_error_code: "partial_failure" });
    expect(rpcBody("record_constant_contact_sync_result").p_member_id).toBe("fixture-member-2");
  });
  it("handles an empty member result without provider contact requests", async () => {
    queueJob();
    fetcher.mockResolvedValueOnce(reply({ access_token: "fixture-access" }))
      .mockResolvedValueOnce(reply(null)).mockResolvedValueOnce(reply({ jobId: "fixture-job" }));
    const response = await invoke(syncHandler);
    expect(response.statusCode).toBe(200);
    expect(rpcBody("complete_constant_contact_sync_job").p_processed_count).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it("releases a claimed job after a worker RPC fails", async () => {
    queueJob();
    fetcher.mockResolvedValueOnce(reply({ access_token: "fixture-access" }))
      .mockResolvedValueOnce(reply({ error: "database unavailable" }, 503))
      .mockResolvedValueOnce(reply({ ok: true }));
    const response = await invoke(syncHandler);
    expect(response.statusCode).toBe(502);
    expect(payload(response)).toEqual({ ok: false, error: "worker_error" });
    expect(rpcBody("complete_constant_contact_sync_job").p_error_code).toBe("worker_error");
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
});
