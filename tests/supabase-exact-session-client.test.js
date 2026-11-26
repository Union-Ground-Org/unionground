import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PORTAL_HOST, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

const mocks = vi.hoisted(() => ({
  createClient: vi.fn((url, key, options) => ({ url, key, options })),
  navigatorLock: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mocks.createClient,
  navigatorLock: mocks.navigatorLock,
}));

const LIVE_URL = SUPABASE_ORIGIN;
const LIVE_KEY = "sb_publishable_testkey123456";
const USER_ID = "00000000-0000-4000-8000-000000000102";
const SESSION_ID = "00000000-0000-4000-8000-000000000301";

function session() {
  const payload = Buffer.from(JSON.stringify({ session_id: SESSION_ID })).toString("base64url");
  return {
    user: { id: USER_ID },
    access_token: `header.${payload}.signature`,
    refresh_token: "captured-refresh-token",
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => { values.set(key, value); }),
    removeItem: vi.fn((key) => { values.delete(key); }),
  };
}

async function withLocation(hostname, run) {
  const previous = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...previous, hostname, search: "", pathname: "/m" },
  });
  try {
    return await run();
  } finally {
    Object.defineProperty(window, "location", { configurable: true, value: previous });
  }
}

function configureLiveEnvironment() {
  vi.stubEnv("VITE_APP_SURFACE", "saas");
  vi.stubEnv("VITE_UNIONGROUND_SUPABASE_REF", SUPABASE_REF);
  vi.stubEnv("VITE_SUPABASE_URL", LIVE_URL);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", LIVE_KEY);
  vi.stubEnv("VITE_SAMPLE_SUPABASE_URL", "");
  vi.stubEnv("VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY", "");
}

describe("browser Supabase exact-session client", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createClient.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("fails closed when no configured browser auth store can bind captured cleanup", async () => {
    vi.stubEnv("VITE_APP_SURFACE", "saas");
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "");

    await withLocation(PORTAL_HOST, async () => {
      const mod = await import("../src/lib/supabase.js");
      const captured = session();

      expect(mod.appAuthSessionIsClosed(captured)).toBe(false);
      expect(() => mod.createCapturedAppSessionRpcClient(captured)).toThrow(/captured authenticated client/i);
      expect(() => mod.verifyCapturedAppSession(captured)).toThrow(/captured authenticated client/i);
      expect(() => mod.clearCapturedAppSessionLocally(captured)).toThrow(/exact browser session storage/i);
    });
  });

  it("marks readable-but-uninspectable durable auth storage unavailable", async () => {
    configureLiveEnvironment();
    const deniedStorage = {
      getItem: vi.fn(() => { throw new DOMException("denied", "SecurityError"); }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    vi.stubGlobal("localStorage", deniedStorage);

    await withLocation(PORTAL_HOST, async () => {
      const mod = await import("../src/lib/supabase.js");

      expect(mod.appAuthStorageUnavailable).toBe(true);
      expect(deniedStorage.getItem).toHaveBeenCalledWith(`sb-${SUPABASE_REF}-auth-token`);
    });
  });

  it("binds captured RPC and local cleanup to the exact durable session", async () => {
    configureLiveEnvironment();
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);

    await withLocation(PORTAL_HOST, async () => {
      const mod = await import("../src/lib/supabase.js");
      const captured = session();
      storage.setItem(mod.appAuthStorageKey, JSON.stringify(captured));

      expect(mod.appAuthStorageUnavailable).toBe(false);
      expect(mod.appAuthSessionIsClosed(captured)).toBe(false);

      const capturedClient = mod.createCapturedAppSessionRpcClient(captured);
      expect(capturedClient.url).toBe(LIVE_URL);
      expect(capturedClient.key).toBe(LIVE_KEY);
      expect(capturedClient.options.auth).toEqual({
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      });
      await expect(capturedClient.options.accessToken()).resolves.toBe(captured.access_token);
      expect(capturedClient.options.global.headers).toEqual({
        "X-Client-Info": "unionground-web-captured-session",
      });

      await expect(Promise.resolve(mod.clearCapturedAppSessionLocally(captured))).resolves.toBe(true);
      expect(mod.appAuthSessionIsClosed(captured)).toBe(true);
      expect(storage.values.get(mod.appAuthStorageKey)).toBe(JSON.stringify(captured));
    });
  });

  it("serializes complete auth operations when browser Web Locks are available", async () => {
    configureLiveEnvironment();
    vi.stubGlobal("navigator", { locks: { request: vi.fn() } });
    vi.stubGlobal("localStorage", memoryStorage());

    await withLocation(PORTAL_HOST, async () => {
      await import("../src/lib/supabase.js");
      const options = mocks.createClient.mock.calls[0][2];

      expect(options.auth.lock).toBe(mocks.navigatorLock);
      expect(options.auth.lockAcquireTimeout).toBe(-1);
    });
  });

  it("retains lineage-safe storage when browser lock inspection is denied", async () => {
    configureLiveEnvironment();
    vi.stubGlobal("localStorage", memoryStorage());
    const navigatorGetter = vi.spyOn(window, "navigator", "get")
      .mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });

    try {
      await withLocation(PORTAL_HOST, async () => {
        await import("../src/lib/supabase.js");
        const options = mocks.createClient.mock.calls[0][2];

        expect(options.auth.lock).toBeUndefined();
        expect(options.auth.storage).toBeDefined();
      });
    } finally {
      navigatorGetter.mockRestore();
    }
  });
});
