import { describe, expect, it, vi } from "vitest";
import { requiresBackendConfig } from "../src/lib/appMode.js";
import { DENIED_APP_HOST } from "./helpers/denied-identity-fixtures.js";

describe("backend configuration gate", () => {
  it("lets an explicit demo boot without Supabase credentials", () => {
    expect(requiresBackendConfig({ hasConfig: false, testPreview: false, demoActive: true })).toBe(false);
  });

  it("still requires credentials for an ordinary production boot", () => {
    expect(requiresBackendConfig({ hasConfig: false, testPreview: false, demoActive: false })).toBe(true);
    expect(requiresBackendConfig({ hasConfig: true, testPreview: false, demoActive: false })).toBe(false);
  });

  it("refuses baked Supabase keys on a SAMPLE-surface build", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_APP_SURFACE", "demo");
    vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
    try {
      const mod = await import("../src/lib/supabase.js");
      expect(mod.hasSupabaseConfig).toBe(false);
      expect(mod.supabase).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses baked Supabase keys when the current host is the SAMPLE origin", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_APP_SURFACE", "saas");
    vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
    const previousLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...previousLocation, hostname: DENIED_APP_HOST, search: "" },
    });
    try {
      const mod = await import("../src/lib/supabase.js");
      expect(mod.hasSupabaseConfig).toBe(false);
      expect(mod.supabase).toBeNull();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: previousLocation,
      });
      vi.unstubAllEnvs();
    }
  });
});
