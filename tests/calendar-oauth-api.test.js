// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/calendar-oauth.js";
import { decryptRefreshToken, hashOAuthBrowserBinding } from "../api/_lib/calendarOAuth.js";
import { tokenEndpoint } from "../src/features/calendarFreeBusy/oauth.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SUPABASE_ORIGIN } from "./helpers/fictional-provider.js";

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

function consumeCalls(fetcher = global.fetch) {
  return fetcher.mock.calls.filter((call) => String(call[0]).includes("consume_calendar_oauth_state"));
}

function consumeBody(call) {
  return JSON.parse(call[1].body);
}

function rpcResponse(payload, { status = 200, ok = true } = {}) {
  const body = JSON.stringify(payload);
  return { ok, status, text: async () => body, json: async () => JSON.parse(body) };
}

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_ORIGIN);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "psgfictionalproject");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("calendar OAuth API", () => {
  it("reports unset providers without leaking secrets", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "user-1" }),
    });
    const response = responseRecorder();
    await handler({
      method: "GET",
      headers: { authorization: "Bearer member-token", host: PORTAL_HOST },
      query: {},
    }, response);
    expect(response.statusCode).toBe(200);
    const body = jsonBody(response);
    expect(body.providers.google.configured).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/secret|sb_secret|wrap/i);
  });

  it("refuses to start OAuth when the organization app is unset", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "user-1" }),
    });
    const response = responseRecorder();
    await handler({
      method: "POST",
      headers: { authorization: "Bearer member-token", host: PORTAL_HOST },
      body: { provider: "google" },
    }, response);
    expect(response.statusCode).toBe(409);
    expect(jsonBody(response).error).toBe("activation_unset");
  });

  it("starts Google OAuth with an authorized existing intent when env config is present", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_ID", "chapter.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET", "chapter-secret-value-16");
    vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", "wrap-key-value-32-characters-long!");
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "user-1" }) })
      .mockResolvedValueOnce(rpcResponse({ id: "conn-1", provider: "google", status: "pending" }))
      .mockResolvedValueOnce(rpcResponse({ ok: true, provider: "google" }));
    const response = responseRecorder();
    await handler({
      method: "POST",
      headers: { authorization: "Bearer member-token", host: PORTAL_HOST },
      body: { provider: "google" },
    }, response);
    expect(response.statusCode).toBe(200);
    const body = jsonBody(response);
    expect(body.authorizationUrl).toContain("accounts.google.com");
    expect(body.authorizationUrl).toContain("chapter.apps.googleusercontent.com");
    expect(JSON.stringify(body)).not.toContain("chapter-secret-value-16");
    expect(global.fetch.mock.calls.some((call) => String(call[0]).includes("authorize_calendar_oauth_start"))).toBe(true);
    expect(global.fetch.mock.calls.some((call) => String(call[0]).includes("request_calendar_connection"))).toBe(false);
    expect(response.headers["Set-Cookie"]).toMatch(/^calendar_oauth_binding_google=[A-Za-z0-9_-]{43};/);
    expect(response.headers["Set-Cookie"]).toContain("HttpOnly; Secure; SameSite=Lax");
    const binding = response.headers["Set-Cookie"].match(/^calendar_oauth_binding_google=([^;]+)/)?.[1];
    const saveCall = global.fetch.mock.calls.find((call) => String(call[0]).includes("save_calendar_oauth_state"));
    const saved = JSON.parse(saveCall[1].body);
    expect(saved.p_browser_binding_hash).toBe(hashOAuthBrowserBinding(binding));
    expect(JSON.stringify(saved)).not.toContain(binding);
  });

  it("keeps Google and Microsoft starts independently bound in one browser", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_ID", "chapter.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET", "chapter-secret-value-16");
    vi.stubEnv("MICROSOFT_CALENDAR_OAUTH_CLIENT_ID", "microsoft-client-id");
    vi.stubEnv("MICROSOFT_CALENDAR_OAUTH_CLIENT_SECRET", "microsoft-client-secret-value");
    vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", "wrap-key-value-32-characters-long!");
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "user-1" }) })
      .mockResolvedValueOnce(rpcResponse({ id: "conn-google", status: "pending" }))
      .mockResolvedValueOnce(rpcResponse({ ok: true }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "user-1" }) })
      .mockResolvedValueOnce(rpcResponse({ id: "conn-microsoft", status: "pending" }))
      .mockResolvedValueOnce(rpcResponse({ ok: true }))
      .mockResolvedValueOnce(rpcResponse({
        provider: "google",
        codeVerifier: "pkce-verifier",
        redirectUri: `${PORTAL_ORIGIN}/api/calendar-oauth`,
        stewardId: "user-1",
      }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "short-lived-access-token",
          refresh_token: "provider-refresh-token",
        }),
      })
      .mockResolvedValueOnce(rpcResponse({ ok: true }));

    const googleResponse = responseRecorder();
    await handler({
      method: "POST",
      headers: { authorization: "Bearer member-token", host: PORTAL_HOST },
      body: { provider: "google" },
    }, googleResponse);
    const microsoftResponse = responseRecorder();
    await handler({
      method: "POST",
      headers: { authorization: "Bearer member-token", host: PORTAL_HOST },
      body: { provider: "microsoft" },
    }, microsoftResponse);
    expect(googleResponse.headers["Set-Cookie"]).toMatch(/^calendar_oauth_binding_google=/);
    expect(microsoftResponse.headers["Set-Cookie"]).toMatch(/^calendar_oauth_binding_microsoft=/);

    const callbackResponse = responseRecorder();
    await handler({
      method: "GET",
      headers: {
        host: PORTAL_HOST,
        cookie: [
          googleResponse.headers["Set-Cookie"].split(";")[0],
          microsoftResponse.headers["Set-Cookie"].split(";")[0],
        ].join("; "),
      },
      query: { code: "authorization-code", state: "google-state" },
    }, callbackResponse);
    expect(callbackResponse.headers.Location).toBe(`${PORTAL_ORIGIN}/m?calendar=pending`);
    expect(callbackResponse.headers["Set-Cookie"]).toMatch(/^calendar_oauth_binding_google=;/);
    const googleBinding = googleResponse.headers["Set-Cookie"].match(/^calendar_oauth_binding_google=([^;]+)/)?.[1];
    const microsoftBinding = microsoftResponse.headers["Set-Cookie"].match(/^calendar_oauth_binding_microsoft=([^;]+)/)?.[1];
    expect(googleBinding).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(microsoftBinding).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const consumes = consumeCalls();
    expect(consumes).toHaveLength(1);
    const consumed = consumeBody(consumes[0]);
    expect(consumed.p_state).toBe("google-state");
    expect(consumed.p_browser_binding_hash).toBe(hashOAuthBrowserBinding(googleBinding));
    expect(consumed.p_browser_binding_hash).not.toBe(hashOAuthBrowserBinding(microsoftBinding));
    expect(JSON.stringify(consumed)).not.toContain(googleBinding);
    expect(JSON.stringify(consumed)).not.toContain(microsoftBinding);
  });

  it.each([
    ["microsoft", "google"],
    ["google", "microsoft"],
  ])("consumes the %s binding hash when the %s cookie is refused first", async (matchingProvider, refusedProvider) => {
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_ID", "chapter.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET", "chapter-secret-value-16");
    vi.stubEnv("MICROSOFT_CALENDAR_OAUTH_CLIENT_ID", "microsoft-client-id");
    vi.stubEnv("MICROSOFT_CALENDAR_OAUTH_CLIENT_SECRET", "microsoft-client-secret-value");
    vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", "wrap-key-value-32-characters-long!");
    const bindings = {
      google: "g".repeat(43),
      microsoft: "m".repeat(43),
    };
    global.fetch = vi.fn()
      .mockResolvedValueOnce(rpcResponse({ error: "binding mismatch" }, { status: 403, ok: false }))
      .mockResolvedValueOnce(rpcResponse({
        provider: matchingProvider,
        codeVerifier: "pkce-verifier",
        redirectUri: `${PORTAL_ORIGIN}/api/calendar-oauth`,
        stewardId: "user-1",
      }))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "short-lived-access-token",
          refresh_token: "provider-refresh-token",
        }),
      })
      .mockResolvedValueOnce(rpcResponse({ ok: true }));
    const response = responseRecorder();
    await handler({
      method: "GET",
      headers: {
        host: PORTAL_HOST,
        cookie: [
          `calendar_oauth_binding_${refusedProvider}=${bindings[refusedProvider]}`,
          `calendar_oauth_binding_${matchingProvider}=${bindings[matchingProvider]}`,
        ].join("; "),
      },
      query: { code: "authorization-code", state: "ordered-state" },
    }, response);
    expect(response.statusCode).toBe(302);
    expect(response.headers.Location).toBe(`${PORTAL_ORIGIN}/m?calendar=pending`);
    expect(response.headers["Set-Cookie"]).toMatch(new RegExp(`^calendar_oauth_binding_${matchingProvider}=;`));
    expect(global.fetch).toHaveBeenCalledTimes(4);
    const consumes = consumeCalls();
    expect(consumes).toHaveLength(2);
    const refused = consumeBody(consumes[0]);
    const matched = consumeBody(consumes[1]);
    expect(refused.p_state).toBe("ordered-state");
    expect(matched.p_state).toBe("ordered-state");
    expect(refused.p_browser_binding_hash).toBe(hashOAuthBrowserBinding(bindings[refusedProvider]));
    expect(matched.p_browser_binding_hash).toBe(hashOAuthBrowserBinding(bindings[matchingProvider]));
    expect(refused.p_browser_binding_hash).not.toBe(matched.p_browser_binding_hash);
    expect(JSON.stringify(refused)).not.toContain(bindings[refusedProvider]);
    expect(JSON.stringify(matched)).not.toContain(bindings[matchingProvider]);
    expect(String(global.fetch.mock.calls[2][0])).toBe(tokenEndpoint(matchingProvider, ""));
    expect(global.fetch.mock.calls[2][1].body.get("code_verifier")).toBe("pkce-verifier");
    expect(JSON.parse(global.fetch.mock.calls[3][1].body).p_provider).toBe(matchingProvider);
  });

  it("redirects with state_unknown when every bound cookie is refused", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_ID", "chapter.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET", "chapter-secret-value-16");
    vi.stubEnv("MICROSOFT_CALENDAR_OAUTH_CLIENT_ID", "microsoft-client-id");
    vi.stubEnv("MICROSOFT_CALENDAR_OAUTH_CLIENT_SECRET", "microsoft-client-secret-value");
    vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", "wrap-key-value-32-characters-long!");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bindings = {
      microsoft: "m".repeat(43),
      google: "g".repeat(43),
    };
    global.fetch = vi.fn()
      .mockResolvedValueOnce(rpcResponse({ error: "binding mismatch" }, { status: 403, ok: false }))
      .mockResolvedValueOnce(rpcResponse({ error: "binding mismatch" }, { status: 403, ok: false }));
    const response = responseRecorder();
    await handler({
      method: "GET",
      headers: {
        host: PORTAL_HOST,
        cookie: `calendar_oauth_binding_microsoft=${bindings.microsoft}; calendar_oauth_binding_google=${bindings.google}`,
      },
      query: { code: "authorization-code", state: "refused-state" },
    }, response);
    expect(response.statusCode).toBe(302);
    expect(response.headers.Location).toBe(`${PORTAL_ORIGIN}/m?calendar=error`);
    expect(response.headers["Set-Cookie"]).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const consumes = consumeCalls();
    expect(consumes).toHaveLength(2);
    const first = consumeBody(consumes[0]);
    const second = consumeBody(consumes[1]);
    expect(first.p_state).toBe("refused-state");
    expect(second.p_state).toBe("refused-state");
    expect(first.p_browser_binding_hash).toBe(hashOAuthBrowserBinding(bindings.microsoft));
    expect(second.p_browser_binding_hash).toBe(hashOAuthBrowserBinding(bindings.google));
    expect(first.p_browser_binding_hash).not.toBe(second.p_browser_binding_hash);
    expect(JSON.stringify(first)).not.toContain(bindings.microsoft);
    expect(JSON.stringify(second)).not.toContain(bindings.google);
    expect(global.fetch.mock.calls.some((call) => (
      String(call[0]).includes("oauth2.googleapis.com") || String(call[0]).includes("login.microsoftonline.com")
    ))).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith("[calendar-oauth]", {
      kind: "callback_refused",
      reason: "state_unknown",
    });
  });

  it("does not mint OAuth state or a binding cookie when the member RPC denies the caller", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_ID", "chapter.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET", "chapter-secret-value-16");
    vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", "wrap-key-value-32-characters-long!");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "ordinary-member" }) })
      .mockResolvedValueOnce(rpcResponse({ error: "steward role required" }, { status: 403, ok: false }));
    const response = responseRecorder();
    await handler({
      method: "POST",
      headers: { authorization: "Bearer member-token", host: PORTAL_HOST },
      body: { provider: "google" },
    }, response);
    expect(response.statusCode).toBe(403);
    expect(response.headers["Set-Cookie"]).toBeUndefined();
    expect(global.fetch.mock.calls.some((call) => String(call[0]).includes("save_calendar_oauth_state"))).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith("[calendar-oauth]", expect.objectContaining({
      kind: "start_refused",
      status: 403,
    }));
  });

  it("does not treat a lookalike host as an allowed redirect", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_ID", "chapter.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET", "chapter-secret-value-16");
    vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", "wrap-key-value-32-characters-long!");
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "user-1" }),
    });
    const response = responseRecorder();
    await handler({
      method: "POST",
      headers: { authorization: "Bearer member-token", host: `${PORTAL_HOST}.evil.example` },
      body: { provider: "google" },
    }, response);
    expect(response.statusCode).toBe(409);
    expect(jsonBody(response).error).toBe("activation_unset");
  });

  it("consumes one callback state and stores only the wrapped refresh token", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_ID", "chapter.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET", "chapter-secret-value-16");
    const wrapKey = "wrap-key-value-32-characters-long!";
    vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", wrapKey);
    // A wrong-surface wrap must reach storage so the assertion checks its key.
    vi.stubEnv("SAMPLE_CALENDAR_OAUTH_TOKEN_WRAP_KEY", "sample-wrap-key-value-32-characters-long!");
    const browserBinding = "b".repeat(43);
    global.fetch = vi.fn()
      .mockResolvedValueOnce(rpcResponse({
        provider: "google",
        codeVerifier: "pkce-verifier",
        redirectUri: `${PORTAL_ORIGIN}/api/calendar-oauth`,
        stewardId: "user-1",
      }))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "short-lived-access-token",
          refresh_token: "provider-refresh-token",
          expires_in: 3600,
          scope: "calendar.freebusy",
        }),
      })
      .mockResolvedValueOnce(rpcResponse({ ok: true }));
    const response = responseRecorder();
    await handler({
      method: "GET",
      headers: { host: PORTAL_HOST, cookie: `calendar_oauth_binding_google=${browserBinding}` },
      query: { code: "authorization-code", state: "single-use-state" },
    }, response);
    expect(response.statusCode).toBe(302);
    expect(response.headers.Location).toBe(`${PORTAL_ORIGIN}/m?calendar=pending`);
    const storeCall = global.fetch.mock.calls.find((call) => String(call[0]).includes("upsert_steward_calendar_oauth_token"));
    const stored = JSON.parse(storeCall[1].body);
    expect(stored.p_refresh_token_ciphertext).toMatch(/^v1:/);
    expect(stored.p_refresh_token_ciphertext).not.toContain("provider-refresh-token");
    expect(decryptRefreshToken({ CALENDAR_OAUTH_TOKEN_WRAP_KEY: wrapKey }, "saas", stored.p_refresh_token_ciphertext))
      .toBe("provider-refresh-token");
    expect(JSON.stringify(global.fetch.mock.calls)).not.toContain("short-lived-access-token");
    const consumeCall = global.fetch.mock.calls.find((call) => String(call[0]).includes("consume_calendar_oauth_state"));
    expect(JSON.parse(consumeCall[1].body).p_browser_binding_hash).toBe(hashOAuthBrowserBinding(browserBinding));
    expect(response.headers["Set-Cookie"]).toContain("Max-Age=0");
  });

  it("fails closed when the connection is removed before the provider callback completes", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_ID", "chapter.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET", "chapter-secret-value-16");
    vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", "wrap-key-value-32-characters-long!");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const browserBinding = "r".repeat(43);
    global.fetch = vi.fn()
      .mockResolvedValueOnce(rpcResponse({
        provider: "google",
        codeVerifier: "pkce-verifier",
        redirectUri: `${PORTAL_ORIGIN}/api/calendar-oauth`,
        stewardId: "steward-removed-mid-flight",
      }))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "short-lived-access-token",
          refresh_token: "provider-refresh-token",
        }),
      })
      .mockResolvedValueOnce(rpcResponse(
        { message: "no connection for this steward and provider" },
        { status: 400, ok: false },
      ));
    const response = responseRecorder();
    await handler({
      method: "GET",
      headers: { host: PORTAL_HOST, cookie: `calendar_oauth_binding_google=${browserBinding}` },
      query: { code: "authorization-code", state: "single-use-state" },
    }, response);
    expect(response.statusCode).toBe(302);
    expect(response.headers.Location).toBe(`${PORTAL_ORIGIN}/m?calendar=error`);
    expect(errorSpy).toHaveBeenCalledWith("[calendar-oauth]", {
      kind: "callback_refused",
      reason: "token_store_failed",
      provider: "google",
    });
    expect(global.fetch.mock.calls.filter((call) => (
      String(call[0]).includes("upsert_steward_calendar_oauth_token")
    ))).toHaveLength(1);
  });

  it("refuses an OAuth callback that is not bound to the initiating browser", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_ID", "chapter.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET", "chapter-secret-value-16");
    vi.stubEnv("CALENDAR_OAUTH_TOKEN_WRAP_KEY", "wrap-key-value-32-characters-long!");
    global.fetch = vi.fn();
    const response = responseRecorder();
    await handler({
      method: "GET",
      headers: { host: PORTAL_HOST },
      query: { code: "authorization-code", state: "single-use-state" },
    }, response);
    expect(response.statusCode).toBe(302);
    expect(response.headers.Location).toBe(`${PORTAL_ORIGIN}/m?calendar=error`);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
