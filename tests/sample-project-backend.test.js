import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_BACKEND, isSampleSupabaseProject, pinnedSampleSupabaseOrigin } from "../src/lib/sampleBackend.js";

// BUG-UG-SAMPLE-ACCOUNTS-ASKED-TO-ACCEPT-TERMS-20261029. Owner ruling,
// October 29, 2026: "NO TERMS FOR SAMPLE. SAMPLE HAS NO REAL USERS". The rule
// is about the project, so the app decides by the project its active client
// connects to, not by which client (main or sample) is in use.

const mocks = vi.hoisted(() => ({
  createClient: vi.fn((url, key, options) => ({ url, key, options })),
  navigatorLock: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mocks.createClient,
  navigatorLock: mocks.navigatorLock,
}));

import { SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";

describe("isSampleSupabaseProject", () => {
  it("ships without a SAMPLE project and never recognizes a placeholder as one", () => {
    expect(SAMPLE_BACKEND.sampleSupabaseRef).toBe("");
    expect(pinnedSampleSupabaseOrigin()).toBe("");
    expect(isSampleSupabaseProject(SAMPLE_BACKEND.samplePortalOrigin)).toBe(false);
    expect(isSampleSupabaseProject("samplefixture")).toBe(false);
    expect(isSampleSupabaseProject("HTTPS://SAMPLEFIXTURE.SUPABASE.CO")).toBe(false);
  });

  it("is false for any other project, a lookalike host or no URL", () => {
    expect(isSampleSupabaseProject(SUPABASE_ORIGIN)).toBe(false);
    expect(isSampleSupabaseProject(`https://${SAMPLE_BACKEND.sampleSupabaseRef}.supabase.co.example.test`)).toBe(false);
    expect(isSampleSupabaseProject(`https://${SAMPLE_BACKEND.sampleSupabaseRef}x.supabase.co`)).toBe(false);
    for (const value of ["", null, undefined, "not a url"]) expect(isSampleSupabaseProject(value)).toBe(false);
  });
});

describe("the app backend's project", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createClient.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function mainClientAt(url) {
    vi.stubEnv("VITE_APP_SURFACE", "saas");
    vi.stubEnv("VITE_SUPABASE_URL", url);
    vi.stubEnv("VITE_UNIONGROUND_SUPABASE_REF", SUPABASE_REF);
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_localtestkey0123");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY", "");
    return import("../src/lib/supabase.js");
  }

  it("does not create a client or label it SAMPLE from an empty project setting", async () => {
    const mod = await mainClientAt(pinnedSampleSupabaseOrigin());
    expect(mod.appBackendKind).toBeNull();
    expect(mod.appBackendIsSampleProject).toBe(false);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("is not SAMPLE when the main client is configured with another project", async () => {
    const mod = await mainClientAt(SUPABASE_ORIGIN);
    expect(mod.appBackendKind).toBe("live");
    expect(mod.appBackendIsSampleProject).toBe(false);
  });
});
