import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PORTAL_HOST, SAMPLE_HOST, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

// REQ-UG-FIND-YOUR-UNION-PUBLIC-REGISTRY-SEARCH-20260924: the signed-out
// registry read runs through a memory-only anonymous client that exists only
// where the live configuration does.

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
const PUBLIC_READ_STORAGE_KEY = "sg-public-read";

async function withLocation(hostname, run) {
  const previous = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...previous, hostname, search: "", pathname: "/unions" },
  });
  try {
    return await run();
  } finally {
    Object.defineProperty(window, "location", { configurable: true, value: previous });
  }
}

function publicReadClientCalls() {
  return mocks.createClient.mock.calls.filter(([, , options]) => options?.auth?.storageKey === PUBLIC_READ_STORAGE_KEY);
}

describe("public read client", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createClient.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("is null wherever no live configuration exists", async () => {
    vi.stubEnv("VITE_APP_SURFACE", "saas");
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY", "");

    await withLocation(PORTAL_HOST, async () => {
      const mod = await import("../src/lib/supabase.js");

      expect(mod.hasSupabaseConfig).toBe(false);
      expect(mod.createPublicReadClient()).toBeNull();
      expect(mod.createPublicReadClient()).toBeNull();
      expect(publicReadClientCalls()).toHaveLength(0);
    });
  });

  it("is null on the demo surface so the demo host never queries SAMPLE data", async () => {
    vi.stubEnv("VITE_APP_SURFACE", "demo");
    vi.stubEnv("VITE_UNIONGROUND_SUPABASE_REF", SUPABASE_REF);
    vi.stubEnv("VITE_SUPABASE_URL", LIVE_URL);
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", LIVE_KEY);
    vi.stubEnv("VITE_SAMPLE_SUPABASE_URL", "https://sample-project.supabase.co");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY", "sample-publishable-key");

    await withLocation(SAMPLE_HOST, async () => {
      const mod = await import("../src/lib/supabase.js");

      expect(mod.hasSupabaseConfig).toBe(false);
      expect(mod.createPublicReadClient()).toBeNull();
      expect(publicReadClientCalls()).toHaveLength(0);
    });
  });

  it("creates one memory-only anonymous client per page with the bounded fetch", async () => {
    vi.stubEnv("VITE_APP_SURFACE", "saas");
    vi.stubEnv("VITE_UNIONGROUND_SUPABASE_REF", SUPABASE_REF);
    vi.stubEnv("VITE_SUPABASE_URL", LIVE_URL);
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", LIVE_KEY);
    vi.stubEnv("VITE_SAMPLE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY", "");

    await withLocation(PORTAL_HOST, async () => {
      const mod = await import("../src/lib/supabase.js");
      // Imported after the same vi.resetModules() as the client module, so the
      // identity check compares the fetch the client actually received.
      const { boundedSampleFetch } = await import("../src/lib/sampleRequest.js");
      expect(mod.hasSupabaseConfig).toBe(true);
      expect(publicReadClientCalls()).toHaveLength(0);

      const first = mod.createPublicReadClient();
      const second = mod.createPublicReadClient();

      expect(first).not.toBeNull();
      expect(second).toBe(first);
      expect(publicReadClientCalls()).toHaveLength(1);
      expect(first.url).toBe(LIVE_URL);
      expect(first.key).toBe(LIVE_KEY);
      expect(first.options.auth).toEqual({
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: PUBLIC_READ_STORAGE_KEY,
      });
      expect(first.options.global).toEqual({
        fetch: boundedSampleFetch,
        headers: { "X-Client-Info": "unionground-public-read" },
      });
      expect(first.options.auth.storageKey).not.toBe(mod.supabase.options.auth.storageKey);
    });
  });
});
