// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/calendar-oauth.js";
import { PORTAL_HOST, PORTAL_ORIGIN } from "./helpers/fictional-provider.js";
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://fixture.supabase.co"));

// Fictional protocol fixtures; only external HTTP is replaced.
function reply(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}
function recorder() {
  return {
    statusCode: 0, headers: {}, body: "",
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(value) { this.body = value || ""; },
  };
}
const saved = {
  provider: "google", codeVerifier: "fixture-verifier", stewardId: "fixture-steward",
  redirectUri: `${PORTAL_ORIGIN}/api/calendar-oauth`,
};
let fetcher;
async function invoke(overrides = {}) {
  const response = recorder();
  await handler({
    method: "POST", body: { provider: "google" },
    headers: { host: PORTAL_HOST, origin: PORTAL_ORIGIN, authorization: "Bearer fixture-member" },
    ...overrides,
  }, response);
  return response;
}
async function callback(query = { code: "fixture-code", state: "fixture-state" }, headers = {}) {
  return invoke({ method: "GET", query, headers: {
    host: PORTAL_HOST, cookie: `calendar_oauth_binding_google=${"b".repeat(43)}`, ...headers,
  } });
}
function expectRedirect(response, result = "error") {
  expect(response.statusCode).toBe(302);
  expect(response.headers.Location).toBe(`${PORTAL_ORIGIN}/m?calendar=${result}`);
  expect(response.headers["Cache-Control"]).toBe("no-store");
  expect(response.body).toBe("");
}
beforeEach(() => {
  for (const [key, value] of Object.entries({
    VITE_SUPABASE_URL: "https://fixture.supabase.co", UNIONGROUND_SUPABASE_PROJECT_REF: "fixture",
    VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_fixture",
    GOOGLE_CALENDAR_OAUTH_CLIENT_ID: "fixture.apps.googleusercontent.com",
    GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: "fixture-client-secret-long-enough",
    CALENDAR_OAUTH_TOKEN_WRAP_KEY: "fixture-wrap-key-longer-than-32-characters",
  })) vi.stubEnv(key, value);
  fetcher = vi.fn(() => { throw new Error("Unexpected external request"); });
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("calendar OAuth handler failure boundaries", () => {
  it("rejects foreign Origin before authentication or state writes", async () => {
    const response = await invoke({ headers: { host: PORTAL_HOST, origin: "https://foreign.example", authorization: "Bearer fixture-member" } });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: "untrusted-origin" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects unsupported methods without egress", async () => {
    const response = await invoke({ method: "OPTIONS" });
    expect(response.statusCode).toBe(405);
    expect(JSON.parse(response.body)).toEqual({ ok: false, error: "method_not_allowed" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses missing backend configuration before authentication", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const response = await invoke();
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).error).toBe("not_configured");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("requires a member token even with a trusted browser Origin", async () => {
    const response = await invoke({ headers: { host: PORTAL_HOST, origin: PORTAL_ORIGIN } });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ ok: false, error: "unauthorized" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["rejected", "network", "missing-id"])("does not create state after %s authentication", async (failure) => {
    if (failure === "network") fetcher.mockRejectedValueOnce(new Error("offline"));
    else fetcher.mockResolvedValueOnce(reply(failure === "missing-id" ? {} : { error: "invalid" }, failure === "rejected" ? 401 : 200));
    const response = await invoke();
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error).toBe("unauthorized");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain("/auth/v1/user");
  });
  it.each([undefined, "{broken", '{}', '{"provider":"unsupported"}'])("rejects invalid provider body %s after authentication", async (body) => {
    fetcher.mockResolvedValueOnce(reply({ id: "fixture-steward" }));
    const response = await invoke({ body });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ ok: false, error: "invalid_input" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([401, 500])("maps state persistence status %s without issuing a browser cookie", async (status) => {
    fetcher.mockResolvedValueOnce(reply({ id: "fixture-steward" }))
      .mockResolvedValueOnce(reply({ ok: true }))
      .mockResolvedValueOnce(reply({ error: "fixture-failure" }, status));
    const response = await invoke({ body: JSON.stringify({ provider: "google" }) });
    expect(response.statusCode).toBe(status === 401 ? 403 : 503);
    expect(JSON.parse(response.body)).toEqual({ ok: false, error: "unauthorized" });
    expect(response.headers["Set-Cookie"]).toBeUndefined();
    expect(String(fetcher.mock.calls[2][0])).toContain("save_calendar_oauth_state");
  });
  it.each([{ error: "access_denied" }, { code: "code" }, { state: "state" }])("redirects incomplete or denied callbacks without consuming state: %j", async (query) => {
    expectRedirect(await callback(query));
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses unknown browser-bound state without exchanging a token", async () => {
    fetcher.mockResolvedValueOnce(reply({ error: "state expired" }, 404));
    expectRedirect(await callback());
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain("consume_calendar_oauth_state");
  });
  it("tries the second provider binding when the first does not match", async () => {
    fetcher.mockResolvedValueOnce(reply({ error: "binding mismatch" }, 403))
      .mockResolvedValueOnce(reply(saved))
      .mockResolvedValueOnce(reply({ access_token: "fixture-access", refresh_token: "fixture-refresh" }))
      .mockResolvedValueOnce(reply({ ok: true }));
    const response = await callback(undefined, { cookie: `calendar_oauth_binding_microsoft=${"a".repeat(43)}; calendar_oauth_binding_google=${"b".repeat(43)}` });
    expectRedirect(response, "pending");
    const claims = fetcher.mock.calls.slice(0, 2).map(([, options]) => JSON.parse(options.body));
    expect(claims[0].p_state).toBe(claims[1].p_state);
    expect(claims[0].p_browser_binding_hash).not.toBe(claims[1].p_browser_binding_hash);
    expect(response.headers["Set-Cookie"]).toContain("calendar_oauth_binding_google=; Path=/api/calendar-oauth; Max-Age=0");
  });
  it("returns unset if provider credentials were removed after the start", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET", "");
    fetcher.mockResolvedValueOnce(reply(saved));
    expectRedirect(await callback(), "unset");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["http", "network", "malformed", "missing-refresh", "missing-wrap"])("refuses callback token %s failures without token storage", async (failure) => {
    if (failure === "missing-wrap") vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", "");
    fetcher.mockResolvedValueOnce(reply(saved));
    if (failure === "network") fetcher.mockRejectedValueOnce(new Error("offline"));
    else if (failure === "malformed") fetcher.mockResolvedValueOnce(new Response("not-json", { status: 200 }));
    else fetcher.mockResolvedValueOnce(reply({ access_token: "fixture-access", ...(failure === "missing-refresh" ? {} : { refresh_token: "fixture-refresh" }) }, failure === "http" ? 502 : 200));
    expectRedirect(await callback());
    expect(fetcher).toHaveBeenCalledTimes(2);
    const exchange = fetcher.mock.calls[1];
    expect(String(exchange[0])).toBe("https://oauth2.googleapis.com/token");
    expect(exchange[1].body.get("code_verifier")).toBe(saved.codeVerifier);
    expect(exchange[1].body.get("redirect_uri")).toBe(saved.redirectUri);
  });
});
