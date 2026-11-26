// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PORTAL_HOST, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

const userA = "00000000-0000-4000-8000-000000000102";
const userB = "00000000-0000-4000-8000-000000000103";
let app;

function session(userId, sessionId) {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const payload = Buffer.from(JSON.stringify({ sub: userId, session_id: sessionId, exp: expires })).toString("base64url");
  return { user: { id: userId }, access_token: `header.${payload}.signature`, refresh_token: `refresh-${sessionId}`, expires_at: expires };
}

describe("captured sign-out with the installed Supabase Auth SDK", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(async () => {
    await app?.appSupabase?.auth.dispose();
    app = null;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function harness({ replaceDuringPrepare = false, prepareOk = false, status = 403, code = "session_not_found" } = {}) {
    const url = SUPABASE_ORIGIN;
    const storageKey = `sb-${SUPABASE_REF}-auth-token`;
    const captured = session(userA, "00000000-0000-4000-8000-000000000301");
    const replacement = session(userB, "00000000-0000-4000-8000-000000000302");
    let current = captured;
    const values = new Map([[storageKey, JSON.stringify(captured)]]);
    const storage = {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => { values.set(key, value); }),
      removeItem: vi.fn((key) => { values.delete(key); }),
    };
    const request = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/rest/v1/rpc/prepare_my_signout") {
        if (replaceDuringPrepare) {
          current = replacement;
          storage.setItem(storageKey, JSON.stringify(replacement));
          // Make the mutable auth adapter observe B before A's probe returns.
          await app.appSupabase.auth.getSession();
        }
        return new Response(JSON.stringify(prepareOk ? { serverCleanupComplete: true } : { code: "42501", message: "captured session unavailable" }), {
          status: prepareOk ? 200 : 403, headers: { "content-type": "application/json" },
        });
      }
      if (path === "/auth/v1/user" || path === "/auth/v1/logout") {
        expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${captured.access_token}`);
        return new Response(JSON.stringify({ code, message: "Auth refusal" }), {
          status, headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
        });
      }
      throw new Error(`Unexpected SDK request: ${path}`);
    });
    vi.stubGlobal("fetch", request);
    vi.stubGlobal("window", { location: { hostname: PORTAL_HOST, search: "", pathname: "/m" } });
    vi.stubGlobal("localStorage", storage);
    vi.stubEnv("VITE_APP_SURFACE", "saas");
    vi.stubEnv("VITE_UNIONGROUND_SUPABASE_REF", SUPABASE_REF);
    vi.stubEnv("VITE_SUPABASE_URL", url);
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_localtestkey0123");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY", "");
    app = await import("../src/lib/supabase.js");
    await app.appSupabase.auth.initialize();
    const authEvents = [];
    app.appSupabase.auth.onAuthStateChange((event) => { authEvents.push(event); });
    const sharedProbe = vi.spyOn(app.appSupabase.auth, "getUser");
    const onLocalSessionCleared = vi.fn(() => { current = null; });
    const { signOutSafely } = await import("../src/lib/sessionManagement.js");
    return {
      run: () => signOutSafely(app.appSupabase, {
        expectedUserID: userA, capturedSession: captured,
        capturedRpcClientForSession: app.createCapturedAppSessionRpcClient,
        verifyCapturedSession: app.verifyCapturedAppSession,
        getCurrentSession: () => current,
        isCurrent: () => current === captured,
        compareAndClearLocalSession: app.clearCapturedAppSessionLocally,
        onLocalSessionCleared,
      }),
      captured, replacement, storageKey, storage, authEvents, sharedProbe, onLocalSessionCleared, request,
    };
  }

  it.each(["session_not_found", "user_not_found"])("clears only the captured local session after a real SDK %s response", async (code) => {
    const h = await harness({ code });
    await expect(h.run()).resolves.toMatchObject({ localCleared: true });
    expect(h.onLocalSessionCleared).toHaveBeenCalledWith(h.captured);
    expect(app.appAuthSessionIsClosed(h.captured)).toBe(true);
    expect(h.sharedProbe).not.toHaveBeenCalled();
    expect(h.authEvents).not.toContain("SIGNED_OUT");
  });

  it("cannot remove or publish sign-out for a replacement already observed by the mutable SDK", async () => {
    const h = await harness({ replaceDuringPrepare: true });
    await expect(h.run()).resolves.toMatchObject({ localCleared: false });
    expect(h.storage.getItem(h.storageKey)).toBe(JSON.stringify(h.replacement));
    expect(app.appAuthSessionIsClosed(h.replacement)).toBe(false);
    expect(h.onLocalSessionCleared).not.toHaveBeenCalled();
    expect(h.sharedProbe).not.toHaveBeenCalled();
    expect(h.authEvents).not.toContain("SIGNED_OUT");
  });

  it("recognizes missing-session errors returned by the real admin revocation API", async () => {
    const h = await harness({ prepareOk: true });
    await expect(h.run()).resolves.toMatchObject({ localCleared: true });
    expect(h.onLocalSessionCleared).toHaveBeenCalledWith(h.captured);
    expect(h.request.mock.calls.some(([url]) => String(url).includes("/auth/v1/user"))).toBe(false);
    expect(h.authEvents).not.toContain("SIGNED_OUT");
  });

  it.each([{ status: 403, code: "bad_jwt" }, { status: 503, code: "session_not_found" }])(
    "retains the captured session after an ambiguous SDK refusal %j", async (refusal) => {
      const h = await harness(refusal);
      await expect(h.run()).rejects.toMatchObject({ code: "42501" });
      expect(h.storage.getItem(h.storageKey)).toBe(JSON.stringify(h.captured));
      expect(app.appAuthSessionIsClosed(h.captured)).toBe(false);
      expect(h.onLocalSessionCleared).not.toHaveBeenCalled();
      expect(h.sharedProbe).not.toHaveBeenCalled();
    },
  );
});
