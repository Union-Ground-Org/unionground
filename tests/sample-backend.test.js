import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SAMPLE_BACKEND,
  isForbiddenSampleBackend,
  pinnedSampleSupabaseOrigin,
  sampleBackendContract,
  samplePortalOrigin,
  supabaseRefFromOrigin,
} from "../src/lib/sampleBackend.js";
import * as sampleBackendModule from "../src/lib/sampleBackend.js";
import { sampleBackendAllowed } from "../src/lib/demoOrigin.js";
import { resolveSupabaseBackend } from "../api/_lib/backend.js";
// The SaaS loopback case reaches the fixture project only as an approved backend
// (api/_lib/providerBoundary.js).
import { DENIED_SUPABASE_REFS } from "./helpers/denied-identity-fixtures.js";
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://psgfixtureproject.supabase.co"));

const contract = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../config/sample-backend.json"),
  "utf8",
));
const legacyContract = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), './fixtures/retired-pre-bot/config/sample-backend.json'), 'utf8'));
const publicContractSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/lib/sampleBackend.js"),
  "utf8",
);

describe("SAMPLE backend contract", () => {
  // Union Ground has no provisioned backend: the shared contract pins no
  // SAMPLE project, so every Supabase target is refused and the demo runs on
  // in-app fiction (src/lib/sampleBackend.js).
  it("keeps the JSON pin and the browser module in lockstep", () => {
    expect(samplePortalOrigin()).toBe("https://unionground.invalid");
    expect(contract.samplePortalOrigin).toBe(SAMPLE_BACKEND.samplePortalOrigin);
    expect(contract.sampleSupabaseOrigin).toBe("");
    expect(contract.sampleSupabaseRef).toBe("");
    expect(SAMPLE_BACKEND.sampleSupabaseOrigin).toBe(contract.sampleSupabaseOrigin);
    expect(SAMPLE_BACKEND.sampleSupabaseRef).toBe(contract.sampleSupabaseRef);
    expect(pinnedSampleSupabaseOrigin(contract)).toBe("");
    expect(SAMPLE_BACKEND).not.toHaveProperty("saasSupabaseOrigin");
    expect(SAMPLE_BACKEND).not.toHaveProperty("saasSupabaseRef");
    expect(SAMPLE_BACKEND).not.toHaveProperty("forbiddenSupabaseRefSha256");
    expect(contract.forbiddenSupabaseRefSha256.length).toBeGreaterThan(0);
    for (const forbiddenDigest of contract.forbiddenSupabaseRefSha256) {
      expect(publicContractSource).not.toContain(forbiddenDigest);
    }
    for (const forbiddenRef of DENIED_SUPABASE_REFS) expect(publicContractSource).not.toContain(forbiddenRef);
    // No persona credential is committed anywhere: neither the JSON contract
    // nor the browser mirror carries a password.
    expect(contract).not.toHaveProperty("samplePersonaPassword");
    expect(SAMPLE_BACKEND).not.toHaveProperty("samplePersonaPassword");
    // The preview personas are the hat switcher, so the JSON and the frozen
    // browser module must never disagree about who those accounts are. Compare
    // structurally: the module freezes the array, its rows and each `roles`.
    expect(contract.samplePersonas).toEqual(
      SAMPLE_BACKEND.samplePersonas.map((persona) => ({ ...persona, roles: [...persona.roles] })),
    );
    // One persona per organizing hat, each on a non-resolvable fictional address.
    expect(SAMPLE_BACKEND.samplePersonas.map((persona) => persona.hat))
      .toEqual(["member", "organize", "steward", "coordinator", "advisor", "admin", "vp"]);
    expect(SAMPLE_BACKEND.samplePersonas.every((persona) => persona.email.endsWith("@example.invalid"))).toBe(true);
  });

  it("exposes the frozen contract and only the SAMPLE portal origin", () => {
    expect(sampleBackendContract()).toBe(SAMPLE_BACKEND);
    expect(Object.isFrozen(sampleBackendContract())).toBe(true);
    // Union Ground has no product (SaaS) portal yet, so none is exported.
    expect(sampleBackendModule).not.toHaveProperty("saasPortalOrigin");
  });

  it("extracts Supabase refs only from real supabase.co origins", () => {
    expect(supabaseRefFromOrigin("https://psgfixtureproject.supabase.co")).toBe("psgfixtureproject");
    expect(supabaseRefFromOrigin("https://example.com")).toBe("");
    expect(supabaseRefFromOrigin("not a url")).toBe("");
    expect(supabaseRefFromOrigin("")).toBe("");
  });

  it("refuses every sibling-product and unknown project while none is pinned", () => {
    for (const ref of DENIED_SUPABASE_REFS) {
      expect(isForbiddenSampleBackend(ref)).toBe(true);
      expect(isForbiddenSampleBackend(`https://${ref}.supabase.co`)).toBe(true);
    }
    expect(isForbiddenSampleBackend("https://samplexxxx.supabase.co")).toBe(true);
    expect(isForbiddenSampleBackend("https://psgfixtureproject.supabase.co")).toBe(true);
    // An empty value is "no target", not a target, and stays unconfigured.
    expect(isForbiddenSampleBackend("")).toBe(false);
  });

  it("allows a SAMPLE backend only on the SAMPLE surface", () => {
    expect(sampleBackendAllowed({ hostname: "localhost", env: { VITE_APP_SURFACE: "demo" } })).toBe(true);
    expect(sampleBackendAllowed({ hostname: "localhost", env: { VITE_APP_SURFACE: "saas" } })).toBe(false);
    expect(sampleBackendAllowed({ hostname: "localhost", env: {} })).toBe(false);
    // The named SAMPLE host is the reserved placeholder from the contract: it
    // is the SAMPLE surface (whose unpinned backend refuses every project), and
    // an unrecognised preview host is not.
    expect(sampleBackendAllowed({ hostname: "unionground.invalid", env: {} })).toBe(true);
    expect(sampleBackendAllowed({ hostname: "psg-unlisted.vercel.app", env: {} })).toBe(false);
  });


  // A fixture ref only: Union Ground has no provisioned project.
  const LIVE_URL = "https://psgfixtureproject.supabase.co";

  async function importSupabaseOn(hostname) {
    const previousLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...previousLocation, hostname, search: "" },
    });
    try {
      return await import("../src/lib/supabase.js");
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: previousLocation });
    }
  }

  it("refuses production keys on the demo surface and builds no SAMPLE client without a pin", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_APP_SURFACE", "demo");
    vi.stubEnv("VITE_UNIONGROUND_SUPABASE_REF", "psgfixtureproject");
    vi.stubEnv("VITE_SUPABASE_URL", LIVE_URL);
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_fixturekey0001");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_URL", "https://psgfixturesample.supabase.co");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY", "sample-publishable-key");
    try {
      const mod = await importSupabaseOn("localhost");
      expect(mod.hasSupabaseConfig).toBe(false);
      expect(mod.supabase).toBeNull();
      expect(mod.hasSampleSupabaseConfig).toBe(false);
      expect(mod.sampleSupabase).toBeNull();
      expect(mod.appSupabase).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a SAMPLE client that points at any sibling-product project", async () => {
    for (const ref of DENIED_SUPABASE_REFS) {
      vi.resetModules();
      vi.stubEnv("VITE_APP_SURFACE", "demo");
      vi.stubEnv("VITE_SAMPLE_SUPABASE_URL", `https://${ref}.supabase.co`);
      vi.stubEnv("VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY", "sample-publishable-key");
      try {
        const mod = await importSupabaseOn("localhost");
        expect(mod.hasSampleSupabaseConfig, ref).toBe(false);
        expect(mod.sampleSupabase, ref).toBeNull();
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });

  it("routes demo-surface APIs to no SAMPLE target and keeps cron on production", () => {
    const sampleUrls = ["https://psgfixturesample.supabase.co", ...DENIED_SUPABASE_REFS.map((ref) => `https://${ref}.supabase.co`)];
    for (const sampleUrl of sampleUrls) {
      const env = {
        VITE_SUPABASE_URL: LIVE_URL,
        UNIONGROUND_SUPABASE_PROJECT_REF: "psgfixtureproject",
        VITE_SUPABASE_PUBLISHABLE_KEY: "prod-publishable",
        SUPABASE_SERVICE_ROLE_KEY: "prod-service",
        VITE_SAMPLE_SUPABASE_URL: sampleUrl,
        VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY: "sample-publishable",
        SAMPLE_SUPABASE_SERVICE_ROLE_KEY: "sample-service",
      };
      const demo = { ...env, VITE_APP_SURFACE: "demo" };
      // Loopback on a demo-surface build is SAMPLE, and with no pinned SAMPLE
      // project it resolves no target at all, never production.
      expect(resolveSupabaseBackend({ headers: { host: "localhost:5173" } }, demo)).toEqual({
        surface: "demo",
        url: "",
        publishableKey: "",
        serviceRoleKey: "",
      });
      // A spoofed x-vercel-cron header alone does not move it to production.
      expect(resolveSupabaseBackend({ headers: { host: "localhost:5173", "x-vercel-cron": "1" } }, demo).url).toBe("");
      // Loopback on a SaaS build is production.
      expect(resolveSupabaseBackend({ headers: { host: "localhost:5173" } }, env).url).toBe(LIVE_URL);
      // Any other host on a demo-surface build fails closed unless it is a
      // genuine cron tick bearing CRON_SECRET; a wrong bearer changes nothing.
      expect(resolveSupabaseBackend({ headers: { host: "psg-unlisted.vercel.app" } }, demo)).toMatchObject({ url: "", refused: "demo-surface-host-not-recognized" });
      expect(resolveSupabaseBackend({
        headers: { host: "psg-unlisted.vercel.app", "x-vercel-cron": "1", authorization: "Bearer wrong" },
      }, { ...demo, CRON_SECRET: "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx" }).url).toBe("");
      expect(resolveSupabaseBackend({
        headers: { host: "psg-unlisted.vercel.app", "x-vercel-cron": "1", authorization: "Bearer cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx" },
      }, { ...demo, CRON_SECRET: "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx" }).url).toBe(LIVE_URL);
      // The named SAMPLE host resolves the SAMPLE backend on any build, and with
      // no pinned SAMPLE project that is no target at all, never production.
      for (const build of [env, demo]) {
        expect(resolveSupabaseBackend({ headers: { host: "unionground.invalid" } }, build)).toEqual({
          surface: "demo",
          url: "",
          publishableKey: "",
          serviceRoleKey: "",
        });
        expect(resolveSupabaseBackend({
          headers: { host: "unionground.invalid", "x-vercel-cron": "1", authorization: "Bearer wrong" },
        }, { ...build, CRON_SECRET: "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx" }).url).toBe("");
      }
      // A genuine cron tick on the SAMPLE host is production work.
      expect(resolveSupabaseBackend({
        headers: { host: "unionground.invalid", "x-vercel-cron": "1", authorization: "Bearer cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx" },
      }, { ...env, CRON_SECRET: "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx" }).url).toBe(LIVE_URL);
    }
  });
});
