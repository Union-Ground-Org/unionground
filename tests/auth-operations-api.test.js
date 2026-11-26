// @vitest-environment node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import passwordHandler from "../api/auth-password-signin.js";
import recoveryHandler from "../api/mfa-recovery.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

const SUPABASE = "https://project.supabase.co";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_HANDLE = "b".repeat(64);
const FACTOR_ID = "20000000-0000-4000-8000-000000000002";
const CLAIM_TOKEN = "a".repeat(64);

function upstream(payload, status = 200) {
  const body = payload === null ? "" : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

function recorder() {
  const out = { status: 0, headers: {}, body: null };
  return {
    out,
    status(code) { out.status = code; return this; },
    setHeader(name, value) { out.headers[name] = value; },
    end(body) { out.body = JSON.parse(body); },
  };
}

async function run(handler, { body = {}, token = "", host = "localhost:5173", method = "POST", origin = `http://${host}` } = {}) {
  const response = recorder();
  await handler({
    method,
    headers: {
      host,
      ...(origin ? { origin } : {}),
      "user-agent": "Test Browser/1.0",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
  }, response);
  return response.out;
}

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-secret-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("password sign-in operations seam", () => {
  it("returns only the session tokens after a successful provider grant", async () => {
    const fetchMock = vi.fn(async (url) => (String(url).endsWith("/rpc/reserve_password_signin_attempt")
      ? upstream({ allowed: true, reservation: USER_ID })
      : String(url).endsWith("/rpc/refund_password_signin_attempt") ? upstream(true)
      : upstream({
        access_token: "access-token",
        refresh_token: "refresh-token",
        user: { id: USER_ID, email: "member@example.com" },
      })));
    vi.stubGlobal("fetch", fetchMock);

    const out = await run(passwordHandler, {
      body: { email: " Member@Example.com ", password: "long-password" },
    });

    expect(out).toMatchObject({
      status: 200,
      body: { accessToken: "access-token", refreshToken: "refresh-token" },
    });
    // The reservation precedes the grant; success refunds it.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe(`${SUPABASE}/rest/v1/rpc/reserve_password_signin_attempt`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${SUPABASE}/auth/v1/token?grant_type=password`);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      email: "member@example.com",
      password: "long-password",
    });
    expect(JSON.stringify(out)).not.toContain("member@example.com");
  });

  it("keeps invalid and provider-rejected credentials flat while recording only through the service RPC", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
      if (String(url).endsWith("/rpc/reserve_password_signin_attempt")) return upstream({ allowed: true, reservation: USER_ID });
      if (String(url).includes("grant_type=password")) return upstream({ error: "invalid_grant" }, 400);
      if (String(url).includes("record_failed_login_attempt")) return upstream(null);
      throw new Error(`unexpected ${url}`);
    }));

    const rejected = await run(passwordHandler, {
      body: { email: "member@example.com", password: "wrong-password" },
    });
    const malformed = await run(passwordHandler, {
      body: { email: "not-an-email", password: "wrong-password" },
    });

    expect(rejected).toMatchObject({ status: 401, body: { error: "sign-in-failed" } });
    expect(malformed).toMatchObject({ status: 401, body: { error: "sign-in-failed" } });
    // A malformed request never reaches the throttle, the provider or telemetry.
    expect(calls).toHaveLength(3);
    expect(calls[2].url).toBe(`${SUPABASE}/rest/v1/rpc/record_failed_login_attempt`);
    expect(calls[2].body).toEqual({
      p_email: "member@example.com",
      p_method: "password",
      p_source: "web-saas",
      p_user_agent: "Test Browser/1.0",
    });
    expect(calls[2].headers.apikey).toBe("server-secret-key");
  });
});

describe("native password sign-in through the proxy", () => {
  function telemetryFetch(calls) {
    return vi.fn(async (url, init = {}) => {
      if (String(url).endsWith("/rpc/reserve_password_signin_attempt")) return upstream({ allowed: true, reservation: USER_ID });
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
      if (String(url).includes("grant_type=password")) return upstream({ error: "invalid_grant" }, 400);
      if (String(url).includes("record_failed_login_attempt")) return upstream(null);
      throw new Error(`unexpected ${url}`);
    });
  }

  it("records a refused native attempt under the platform the app names, with the same flat reply", async () => {
    for (const [client, source] of [["ios", "native-ios"], ["android", "native-android"]]) {
      const calls = [];
      vi.stubGlobal("fetch", telemetryFetch(calls));
      // The native app sends no browser Origin.
      const out = await run(passwordHandler, {
        origin: "",
        body: { email: "member@example.com", password: "wrong-password", client },
      });
      expect(out).toMatchObject({ status: 401, body: { error: "sign-in-failed" } });
      expect(calls[0].body).toEqual({ email: "member@example.com", password: "wrong-password" });
      expect(calls[1].body).toMatchObject({ p_email: "member@example.com", p_method: "password", p_source: source });
    }
  });

  it("falls back to the web source for an unknown or inherited client name", async () => {
    for (const client of ["web", "toString", "__proto__", 7]) {
      const calls = [];
      vi.stubGlobal("fetch", telemetryFetch(calls));
      await run(passwordHandler, { body: { email: "member@example.com", password: "wrong-password", client } });
      expect(calls[1].body.p_source).toBe("web-saas");
    }
  });
});

// Union Ground left out passkey, security-key, SSO, store-account and PIN
// sign-in. Provisioned email and password is the only sign-in, so none of the
// removed proxies may come back as a reachable route.
describe("removed alternative sign-in routes", () => {
  it.each([
    "auth-passkey-signin",
    "auth-pin-signin",
    "auth-signin-options",
    "sso-signin",
    "sso-admin",
  ])("has no api/%s.js handler", (endpoint) => {
    expect(existsSync(fileURLToPath(new URL(`../api/${endpoint}.js`, import.meta.url)))).toBe(false);
  });
});

describe("one-time MFA recovery seam", () => {
  it("maps a persisted failed-attempt result to the same public refusal and stops", async () => {
    const fetchMock = vi.fn().mockResolvedValue(upstream({ accepted: false }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(recoveryHandler, {
      token: "aal1-member-token",
      body: { code: "RC-1234-5678-90AB-CDEF" },
    });
    expect(out).toMatchObject({ status: 400, body: { error: "code-not-accepted" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("claims, removes TOTP factors, closes push registration, globally revokes sessions, then finalizes the code", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      const call = { url: String(url), method: init.method || "GET", headers: init.headers, body: init.body ? JSON.parse(init.body) : null };
      calls.push(call);
      if (call.url.endsWith("/rpc/claim_mfa_recovery_code")) {
        return upstream({ userId: USER_ID, sessionHandle: SESSION_HANDLE, claimToken: CLAIM_TOKEN });
      }
      if (call.url.endsWith(`/admin/users/${USER_ID}/factors`) && call.method === "GET") {
        return upstream([{ id: FACTOR_ID, factor_type: "totp" }, { id: "passkey", factor_type: "webauthn" }]);
      }
      if (call.url.endsWith(`/admin/users/${USER_ID}/factors/${FACTOR_ID}`)) return upstream(null, 204);
      if (call.url.endsWith("/rpc/prepare_mfa_recovery_signout")) {
        return upstream({ serverCleanupComplete: true });
      }
      if (call.url.endsWith("/auth/v1/logout?scope=global")) return upstream(null, 204);
      if (call.url.endsWith("/rpc/finalize_mfa_recovery_code")) return upstream(true);
      throw new Error(`unexpected ${call.method} ${call.url}`);
    }));

    const out = await run(recoveryHandler, {
      token: "aal1-member-token",
      body: { code: "RC-1234-5678-90AB-CDEF" },
    });

    expect(out).toMatchObject({
      status: 200,
      body: { recovered: true, removed: 1, sessionsRevoked: true, signInAgain: true },
    });
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", `${SUPABASE}/rest/v1/rpc/claim_mfa_recovery_code`],
      ["GET", `${SUPABASE}/auth/v1/admin/users/${USER_ID}/factors`],
      ["POST", `${SUPABASE}/rest/v1/rpc/prepare_mfa_recovery_signout`],
      ["DELETE", `${SUPABASE}/auth/v1/admin/users/${USER_ID}/factors/${FACTOR_ID}`],
      ["POST", `${SUPABASE}/auth/v1/logout?scope=global`],
      ["POST", `${SUPABASE}/rest/v1/rpc/finalize_mfa_recovery_code`],
    ]);
    expect(calls[2].body).toEqual({
      p_user_id: USER_ID,
      p_session_handle: SESSION_HANDLE,
      p_claim_token: CLAIM_TOKEN,
    });
    expect(calls[2].headers.apikey).toBe("server-secret-key");
    expect(calls[4].headers.Authorization).toBe("Bearer aal1-member-token");
    expect(calls[5].headers.apikey).toBe("server-secret-key");
  });

  it("does not revoke Auth sessions when service-side push cleanup cannot be confirmed", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      calls.push(String(url));
      if (String(url).endsWith("/rpc/claim_mfa_recovery_code")) {
        return upstream({ userId: USER_ID, sessionHandle: SESSION_HANDLE, claimToken: CLAIM_TOKEN });
      }
      if (String(url).endsWith(`/admin/users/${USER_ID}/factors`) && (init.method || "GET") === "GET") {
        return upstream([{ id: FACTOR_ID, factor_type: "totp" }]);
      }
      if (String(url).endsWith("/rpc/prepare_mfa_recovery_signout")) {
        return upstream({ error: "down" }, 503);
      }
      throw new Error(`unexpected ${init.method || "GET"} ${url}`);
    }));

    const out = await run(recoveryHandler, {
      token: "aal1-member-token",
      body: { code: "RC-1234-5678-90AB-CDEF" },
    });

    expect(out).toMatchObject({ status: 502, body: { error: "recovery-unavailable", removed: 0 } });
    expect(calls.some((url) => url.endsWith(`/factors/${FACTOR_ID}`))).toBe(false);
    expect(calls.some((url) => url.endsWith("/auth/v1/logout?scope=global"))).toBe(false);
    expect(calls.some((url) => url.endsWith("/rpc/finalize_mfa_recovery_code"))).toBe(false);
  });

  it("does not consume the code when global session revocation fails", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      calls.push(String(url));
      if (String(url).endsWith("/rpc/claim_mfa_recovery_code")) {
        return upstream({ userId: USER_ID, sessionHandle: SESSION_HANDLE, claimToken: CLAIM_TOKEN });
      }
      if (String(url).endsWith(`/admin/users/${USER_ID}/factors`)) return upstream([]);
      if (String(url).endsWith("/rpc/prepare_mfa_recovery_signout")) {
        return upstream({ serverCleanupComplete: true });
      }
      if (String(url).endsWith("/auth/v1/logout?scope=global")) return upstream({ error: "down" }, 503);
      throw new Error(`unexpected ${init.method || "GET"} ${url}`);
    }));

    const out = await run(recoveryHandler, {
      token: "aal1-member-token",
      body: { code: "RC-1234-5678-90AB-CDEF" },
    });
    expect(out).toMatchObject({ status: 502, body: { error: "recovery-unavailable", removed: 0 } });
    expect(calls.some((url) => url.endsWith("/rpc/finalize_mfa_recovery_code"))).toBe(false);
  });

  it("rejects malformed provider factor identifiers before destructive calls", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/rpc/claim_mfa_recovery_code")) {
        return upstream({ userId: USER_ID, sessionHandle: SESSION_HANDLE, claimToken: CLAIM_TOKEN });
      }
      if (String(url).endsWith(`/admin/users/${USER_ID}/factors`)) return upstream([{ id: "../bad", factor_type: "totp" }]);
      throw new Error(`unexpected ${url}`);
    }));

    const out = await run(recoveryHandler, {
      token: "aal1-member-token",
      body: { code: "RC-1234-5678-90AB-CDEF" },
    });
    expect(out).toMatchObject({ status: 502, body: { error: "recovery-unavailable" } });
    expect(calls).toHaveLength(2);
  });

  it("refuses an unbound claim before any service-role factor lookup", async () => {
    const fetchMock = vi.fn().mockResolvedValue(upstream({
      userId: USER_ID,
      sessionHandle: "revoked-or-missing-session",
      claimToken: CLAIM_TOKEN,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await run(recoveryHandler, {
      token: "aal1-member-token",
      body: { code: "RC-1234-5678-90AB-CDEF" },
    });

    expect(out).toMatchObject({ status: 502, body: { error: "recovery-unavailable" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed at every request boundary before attempting recovery", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect((await run(recoveryHandler, { method: "GET" }))).toMatchObject({
      status: 405,
      body: { error: "method-not-allowed" },
    });

    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined);
    expect((await run(recoveryHandler, { token: "aal1-member-token" }))).toMatchObject({
      status: 503,
      body: { error: "not-configured" },
    });
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-secret-key");

    expect((await run(recoveryHandler)).status).toBe(401);
    expect((await run(recoveryHandler, {
      token: "aal1-member-token",
      body: JSON.stringify({ code: "short" }),
    })).status).toBe(400);
    expect((await run(recoveryHandler, {
      token: "aal1-member-token",
      body: "{",
    })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps an unavailable claim indistinguishable from a rejected code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("claim unavailable")));

    const out = await run(recoveryHandler, {
      token: "aal1-member-token",
      body: { code: "RC-1234-5678-90AB-CDEF" },
    });

    expect(out).toMatchObject({ status: 400, body: { error: "code-not-accepted" } });
  });

  it("stops when the factor inventory cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).endsWith("/rpc/claim_mfa_recovery_code")) {
        return upstream({ userId: USER_ID, sessionHandle: SESSION_HANDLE, claimToken: CLAIM_TOKEN });
      }
      if (String(url).endsWith(`/admin/users/${USER_ID}/factors`)) {
        return upstream({ error: "down" }, 503);
      }
      throw new Error(`unexpected ${url}`);
    }));

    const out = await run(recoveryHandler, {
      token: "aal1-member-token",
      body: { code: "RC-1234-5678-90AB-CDEF" },
    });

    expect(out).toMatchObject({ status: 502, body: { error: "recovery-unavailable" } });
  });

  it("requires the cleanup RPC's affirmative receipt before factor deletion", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).endsWith("/rpc/claim_mfa_recovery_code")) {
        return upstream({ userId: USER_ID, sessionHandle: SESSION_HANDLE, claimToken: CLAIM_TOKEN });
      }
      if (String(url).endsWith(`/admin/users/${USER_ID}/factors`)) {
        return upstream({ factors: [{ id: FACTOR_ID, factor_type: "totp" }] });
      }
      if (String(url).endsWith("/rpc/prepare_mfa_recovery_signout")) {
        return upstream({ serverCleanupComplete: false });
      }
      throw new Error(`unexpected ${url}`);
    }));

    const out = await run(recoveryHandler, {
      token: "aal1-member-token",
      body: { code: "RC-1234-5678-90AB-CDEF" },
    });

    expect(out).toMatchObject({ status: 502, body: { error: "recovery-unavailable", removed: 0 } });
  });

  it("reports partial recovery when the provider refuses factor deletion", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      if (String(url).endsWith("/rpc/claim_mfa_recovery_code")) {
        return upstream({ userId: USER_ID, sessionHandle: SESSION_HANDLE, claimToken: CLAIM_TOKEN });
      }
      if (String(url).endsWith(`/admin/users/${USER_ID}/factors`) && (init.method || "GET") === "GET") {
        return upstream({ factors: [{ id: FACTOR_ID, factor_type: "totp" }] });
      }
      if (String(url).endsWith("/rpc/prepare_mfa_recovery_signout")) {
        return upstream({ serverCleanupComplete: true });
      }
      if (String(url).endsWith(`/factors/${FACTOR_ID}`)) return upstream({ error: "down" }, 503);
      throw new Error(`unexpected ${url}`);
    }));

    const out = await run(recoveryHandler, {
      token: "aal1-member-token",
      body: { code: "RC-1234-5678-90AB-CDEF" },
    });

    expect(out).toMatchObject({ status: 502, body: { error: "partial-recovery", removed: 0 } });
  });

  it("fails closed when global logout throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).endsWith("/rpc/claim_mfa_recovery_code")) {
        return upstream({ userId: USER_ID, sessionHandle: SESSION_HANDLE, claimToken: CLAIM_TOKEN });
      }
      if (String(url).endsWith(`/admin/users/${USER_ID}/factors`)) return upstream({ factors: [] });
      if (String(url).endsWith("/rpc/prepare_mfa_recovery_signout")) {
        return upstream({ serverCleanupComplete: true });
      }
      if (String(url).endsWith("/auth/v1/logout?scope=global")) throw new Error("logout unavailable");
      throw new Error(`unexpected ${url}`);
    }));

    const out = await run(recoveryHandler, {
      token: "aal1-member-token",
      body: { code: "RC-1234-5678-90AB-CDEF" },
    });

    expect(out).toMatchObject({ status: 502, body: { error: "recovery-unavailable", removed: 0 } });
  });

  it("does not report success when finalization remains unconfirmed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).endsWith("/rpc/claim_mfa_recovery_code")) {
        return upstream({ userId: USER_ID, sessionHandle: SESSION_HANDLE, claimToken: CLAIM_TOKEN });
      }
      if (String(url).endsWith(`/admin/users/${USER_ID}/factors`)) return upstream({});
      if (String(url).endsWith("/rpc/prepare_mfa_recovery_signout")) {
        return upstream({ serverCleanupComplete: true });
      }
      if (String(url).endsWith("/auth/v1/logout?scope=global")) return upstream(null, 204);
      if (String(url).endsWith("/rpc/finalize_mfa_recovery_code")) throw new Error("unknown commit");
      throw new Error(`unexpected ${url}`);
    }));

    const out = await run(recoveryHandler, {
      token: "aal1-member-token",
      body: { code: "RC-1234-5678-90AB-CDEF" },
    });

    expect(out).toMatchObject({ status: 502, body: { error: "recovery-unavailable", removed: 0 } });
  });
});
