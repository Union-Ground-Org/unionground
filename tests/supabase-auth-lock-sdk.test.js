// @vitest-environment node
import { navigatorLock } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PORTAL_HOST } from "./helpers/fictional-provider.js";

// BUG-UG-WEB-CONSOLE-SUPABASE-LOCK-OPTION-DEPRECATED-20261106 .
// auth-js 2.118 logs a deprecation warning on every page whose client passes
// `lock`. The browser clients keep the cross-tab lock (dropping it let a late
// getUser cleanup delete a newer session,) and only hide that notice.
// These tests run the installed SDK through src/lib/supabase.js, two module
// loads standing in for two tabs over one shared localStorage and one shared
// Web Lock manager, against an auth server that, like Supabase Auth, answers a
// just-rotated parent refresh token with its active child. The harness comes
// from .

const USER_ID = "00000000-0000-4000-8000-000000000102";
const FIRST_SESSION_ID = "00000000-0000-4000-8000-000000000301";
const REPLACEMENT_SESSION_ID = "00000000-0000-4000-8000-000000000302";
const LOCK_DEPRECATION = /"lock" option is deprecated/;
const JWT_HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
let sequence = 0;
const tabs = [];

function accessToken(expiresAt, generation, sessionID) {
  const payload = Buffer.from(JSON.stringify({ sub: USER_ID, session_id: sessionID, exp: expiresAt, generation })).toString("base64url");
  return `${JWT_HEADER}.${payload}.c2lnbmF0dXJl`;
}

function sessionAt(generation, expiresAt, sessionID = FIRST_SESSION_ID) {
  return {
    access_token: accessToken(expiresAt, generation, sessionID),
    refresh_token: `refresh-${generation}`,
    token_type: "bearer",
    expires_in: Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
    expires_at: expiresAt,
    user: { id: USER_ID, aud: "authenticated", role: "authenticated" },
  };
}

function sessionIDOf(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).session_id;
}

function json(status, body) {
  // Supabase Auth's dated API header makes auth-js read the error `code`.
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
  });
}

// A shared exclusive LockManager, as every tab of one origin sees it.
function sharedLockManager() {
  const tails = new Map();
  return {
    request(name, options, callback) {
      const previous = tails.get(name) ?? Promise.resolve();
      let release;
      const done = new Promise((resolve) => { release = resolve; });
      tails.set(name, previous.then(() => done));
      return previous.then(async () => {
        try {
          return await callback({ name, mode: options?.mode ?? "exclusive" });
        } finally {
          release();
        }
      });
    },
  };
}

function authServer() {
  let generation = 0;
  let active = "refresh-0";
  const parents = new Map();
  const revoked = new Set();
  let userHold = null;
  const server = {
    refreshCalls: 0,
    rotations: 0,
    userCalls: [],
    revoke(sessionID) { revoked.add(sessionID); },
    // Delays /user answers for one session until the returned release runs.
    holdUser(sessionID) {
      let open;
      userHold = { sessionID, opened: new Promise((resolve) => { open = resolve; }) };
      return () => open();
    },
    current: () => active,
    fetch: vi.fn(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
        server.refreshCalls += 1;
        const { refresh_token: presented } = JSON.parse(init.body);
        // Let a concurrent tab's request reach the server before answering.
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (presented === active) {
          generation += 1;
          server.rotations += 1;
          const child = `refresh-${generation}`;
          parents.set(presented, child);
          active = child;
        } else if (parents.get(presented) !== active) {
          return json(400, { code: "refresh_token_already_used", message: "Invalid Refresh Token" });
        }
        return json(200, sessionAt(Number(active.slice("refresh-".length)), Math.floor(Date.now() / 1000) + 3600));
      }
      if (url.pathname === "/auth/v1/user") {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        const sessionID = sessionIDOf(authorization.replace(/^Bearer /, ""));
        server.userCalls.push(sessionID);
        if (userHold?.sessionID === sessionID) await userHold.opened;
        if (revoked.has(sessionID)) {
          return json(403, { code: "session_not_found", message: "Session from session_id claim in JWT does not exist" });
        }
        return json(200, { id: USER_ID, aud: "authenticated", role: "authenticated" });
      }
      throw new Error(`Unexpected SDK request: ${url.pathname}`);
    }),
  };
  return server;
}

async function openTab() {
  vi.resetModules();
  const tab = await import("../src/lib/supabase.js");
  const events = [];
  tab.appSupabase.auth.onAuthStateChange((event) => { events.push(event); });
  tabs.push(tab);
  return { tab, auth: tab.appSupabase.auth, events };
}

describe("browser Supabase clients keep the cross-tab auth lock without the deprecation notice", () => {
  let values;
  let server;
  let storageKey;
  let warn;

  beforeEach(() => {
    sequence += 1;
    values = new Map();
    server = authServer();
    const projectRef = `authlockfixture${sequence}`;
    const url = `https://${projectRef}.supabase.co`;
    storageKey = `sb-${projectRef}-auth-token`;
    const locks = sharedLockManager();
    warn = vi.spyOn(console, "warn");
    vi.stubGlobal("fetch", server.fetch);
    vi.stubGlobal("window", { location: { hostname: PORTAL_HOST, search: "", pathname: "/m" }, navigator: { locks } });
    vi.stubGlobal("navigator", { locks });
    vi.stubGlobal("localStorage", {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    });
    vi.stubEnv("VITE_APP_SURFACE", "saas");
    vi.stubEnv("VITE_SUPABASE_URL", url);
    vi.stubEnv("VITE_UNIONGROUND_SUPABASE_REF", projectRef);
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_localtestkey0123");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY", "");
  });

  afterEach(async () => {
    await Promise.all(tabs.splice(0).map((tab) => tab.appSupabase?.auth.dispose()));
    warn.mockRestore();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const stored = () => JSON.parse(values.get(storageKey) ?? "null");
  const seedExpiredSession = () => values.set(storageKey, JSON.stringify(sessionAt(0, Math.floor(Date.now() / 1000) - 10)));
  const lockWarnings = () => warn.mock.calls.filter((args) => args.some((arg) => LOCK_DEPRECATION.test(String(arg))));

  it("keeps the live rescheduling reader's ten-second Auth body deadline through the bound client", async () => {
    values.set(storageKey, JSON.stringify(sessionAt(0, Math.floor(Date.now() / 1000) + 3600)));
    const { tab, auth } = await openTab();
    const captured = (await auth.getSession()).data.session;
    const { createSessionBoundWriter } = await import("../src/lib/sessionBoundWriter.js");
    const { createSessionBoundDataClient } = await import("../src/lib/sessionBoundDataClient.js");
    const { getStewardRescheduleSlots } = await import("../src/lib/memberApi.js");
    const writer = createSessionBoundWriter({ sharedClient: tab.appSupabase, session: captured, createSessionClient: tab.createCapturedAppSessionRpcClient });
    const client = createSessionBoundDataClient(writer, tab.appSupabase, { verifySession: tab.verifyCapturedAppSession });
    let requested;
    const started = new Promise((resolve) => { requested = resolve; });
    let body;
    let signal;
    const transport = vi.fn(async (input, init) => {
      expect(new URL(String(input)).pathname).toBe("/auth/v1/user");
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${captured.access_token}`);
      signal = init.signal;
      const response = new Response(new ReadableStream({ start(controller) { body = controller; } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
      signal?.addEventListener("abort", () => body.error(signal.reason), { once: true });
      requested();
      return response; // Headers arrive; the body never finishes on its own.
    });
    vi.stubGlobal("fetch", transport);
    vi.useFakeTimers();
    let outcome = null;
    const pending = getStewardRescheduleSlots(client, { type: "consultation", duration: 30, from: "2026-11-22", to: "2026-11-23" })
      .then(() => { outcome = { ok: true }; }, (error) => { outcome = { ok: false, error }; });
    try {
      expect(tab.appBackendKind).toBe("live");
      await started;
      await vi.advanceTimersByTimeAsync(9_999);
      expect(outcome).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toMatchObject({ ok: false });
      expect(outcome.error.message).toMatch(/Open times/);
      expect(signal.aborted).toBe(true);
      expect(transport).toHaveBeenCalledOnce();
    } finally {
      if (!signal?.aborted) body?.error(new DOMException("Test cleanup", "AbortError"));
      await pending;
      vi.useRealTimers();
    }
  });

  // First in the file: auth-js warns once per module instance, so a later
  // construction could pass without proving anything.
  it("builds the member client on the real SDK with the Web Lock and logs no deprecation notice", async () => {
    const signedIn = sessionAt(0, Math.floor(Date.now() / 1000) + 3600);
    values.set(storageKey, JSON.stringify(signedIn));
    const { auth, events } = await openTab();
    await auth.initialize();

    expect(auth.lock).toBe(navigatorLock);
    expect(auth.lockAcquireTimeout).toBe(-1);
    expect(lockWarnings()).toEqual([]);
    expect(console.warn).toBe(warn);
    expect((await auth.getSession()).data.session.access_token).toBe(signedIn.access_token);
    expect(events).not.toContain("SIGNED_OUT");
  });

  it("refreshes an expired session once across two tabs that start at the same moment", async () => {
    seedExpiredSession();
    const first = await openTab();
    const second = await openTab();

    await Promise.all([first.auth.initialize(), second.auth.initialize()]);

    expect(server.refreshCalls).toBe(1);
    expect(server.rotations).toBe(1);
    expect(stored().refresh_token).toBe(server.current());
    for (const tab of [first, second]) {
      expect((await tab.auth.getSession()).data.session.refresh_token).toBe("refresh-1");
      expect(tab.events).not.toContain("SIGNED_OUT");
    }
    expect(first.tab.appAuthSessionIsClosed(stored())).toBe(false);
  });

  // The  gate finding (r1s1, r2s1): tab A's getUser for a session that is
  // signed out meanwhile answers late with session_not_found; tab B has
  // adopted a replacement session and tab A has read it. Auth-js removes the
  // stored session on that answer without checking which session it asked
  // about, so only the lock keeps the replacement from being deleted.
  it("keeps a replacement session adopted in another tab when a late getUser reports the old session gone", async () => {
    const first = sessionAt(0, Math.floor(Date.now() / 1000) + 3600, FIRST_SESSION_ID);
    const replacement = sessionAt(7, Math.floor(Date.now() / 1000) + 3600, REPLACEMENT_SESSION_ID);
    values.set(storageKey, JSON.stringify(first));
    const checking = await openTab();
    await checking.auth.initialize();
    const signingIn = await openTab();
    await signingIn.auth.initialize();
    const release = server.holdUser(FIRST_SESSION_ID);

    const userCheck = checking.auth.getUser();
    await vi.waitFor(() => expect(server.userCalls).toContain(FIRST_SESSION_ID));
    server.revoke(FIRST_SESSION_ID);
    await expect(signingIn.tab.clearCapturedAppSessionLocally(first, { explicitSignOut: true })).resolves.toBe(true);
    const adopt = signingIn.auth.setSession({ access_token: replacement.access_token, refresh_token: replacement.refresh_token });
    // Without the lock the replacement commits here and tab A reads it.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const read = checking.auth.getSession();
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();

    const [{ error: userError }, { error: adoptError }] = await Promise.all([userCheck, adopt, read]);

    expect(userError?.name).toBe("AuthSessionMissingError");
    expect(adoptError).toBeNull();
    expect(stored()?.access_token).toBe(replacement.access_token);
    expect(signingIn.tab.appAuthSessionIsClosed(replacement)).toBe(false);
    expect((await checking.auth.getSession()).data.session?.access_token).toBe(replacement.access_token);
    expect((await signingIn.auth.getSession()).data.session?.access_token).toBe(replacement.access_token);
  });
});
