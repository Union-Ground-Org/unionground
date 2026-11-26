import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DEMO_HOST,
  DEFAULT_DEMO_ORIGIN,
  allowsAnonymousDemoEntry,
  hasDemoQuery,
  isBuildTimeDemoSurface,
  isDemoHost,
  isSaasHost,
  isTestHarness,
  liveBackendAllowed,
  namedDemoHost,
  namedDemoOrigin,
  resolveAppSurface,
  sampleTourHref,
  shouldEnterDemo,
  withDemoRider,
} from "../src/lib/demoOrigin.js";
import { PORTAL_HOST, SAMPLE_HOST, SAMPLE_ORIGIN } from "./helpers/fictional-provider.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

describe("demo origin contract", () => {
  it("loads in an unbundled Node serverless runtime without Vite metadata", () => {
    const moduleUrl = pathToFileURL(resolve("src/lib/demoOrigin.js")).href;
    // This child process has no mock: Union Ground ships no trusted SaaS
    // host, so no host is SaaS by name, and only the placeholder SAMPLE host
    // enters SAMPLE mode.
    const report = execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `const demoOrigin = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify({
        surface: demoOrigin.resolveAppSurface({ hostname: ${JSON.stringify(PORTAL_HOST)} }),
        saasHost: demoOrigin.isSaasHost(${JSON.stringify(PORTAL_HOST)}),
        demoHost: demoOrigin.isDemoHost(${JSON.stringify(SAMPLE_HOST)}),
        saasHosts: demoOrigin.SAAS_HOSTS,
      }));`,
    ], { encoding: "utf8" });
    expect(JSON.parse(report)).toEqual({ surface: "saas", saasHost: false, demoHost: true, saasHosts: [] });
  });

  it("defaults the SAMPLE origin to the reserved unionground.invalid placeholder", () => {
    expect(DEFAULT_DEMO_HOST).toBe("unionground.invalid");
    expect(DEFAULT_DEMO_ORIGIN).toBe("https://unionground.invalid");
    expect(DEFAULT_DEMO_HOST).toBe(SAMPLE_HOST);
    expect(DEFAULT_DEMO_ORIGIN).toBe(SAMPLE_ORIGIN);
    expect(namedDemoOrigin({})).toBe(DEFAULT_DEMO_ORIGIN);
    expect(namedDemoHost({})).toBe(DEFAULT_DEMO_HOST);
  });

  it("fails closed when obsolete environment values name another SAMPLE origin", () => {
    const obsoleteEnv = {
      VITE_DEMO_ORIGIN: "https://tour.example.org/",
      VITE_DEMO_HOST: "tour.example.org",
    };
    expect(namedDemoOrigin(obsoleteEnv)).toBe(DEFAULT_DEMO_ORIGIN);
    expect(namedDemoHost(obsoleteEnv)).toBe(DEFAULT_DEMO_HOST);
    expect(isDemoHost("tour.example.org", obsoleteEnv)).toBe(false);
    expect(isDemoHost(SAMPLE_HOST, obsoleteEnv)).toBe(true);
    expect(isDemoHost(`demo.${PORTAL_HOST}`, obsoleteEnv)).toBe(false);
    // A reserved .invalid origin is a placeholder, never a link: the tour stays
    // on the deployment's own /m?demo=1 route.
    expect(sampleTourHref(obsoleteEnv, PORTAL_HOST)).toBe("/m?demo=1");
  });

  it("never treats a trusted SaaS portal as the SAMPLE origin", () => {
    expect(isSaasHost(PORTAL_HOST)).toBe(true);
    expect(isSaasHost(SAMPLE_HOST)).toBe(false);
    expect(isDemoHost(PORTAL_HOST)).toBe(false);
    expect(shouldEnterDemo({
      hostname: PORTAL_HOST,
      search: "?demo=1",
      env: { VITE_APP_SURFACE: "demo" },
    })).toBe(false);
    expect(resolveAppSurface({
      hostname: PORTAL_HOST,
      search: "?demo=1",
      env: { VITE_APP_SURFACE: "demo" },
    })).toBe("saas");
    expect(shouldEnterDemo({
      hostname: PORTAL_HOST,
      search: "?demo=1",
      env: { MODE: "production", VITE_E2E_HARNESS: "1" },
    })).toBe(false);
    expect(allowsAnonymousDemoEntry({ hostname: PORTAL_HOST })).toBe(false);
    expect(liveBackendAllowed({ hostname: PORTAL_HOST })).toBe(true);
  });

  it("always enters SAMPLE mode on the named demo host", () => {
    expect(shouldEnterDemo({ hostname: SAMPLE_HOST, search: "" })).toBe(true);
    expect(shouldEnterDemo({ hostname: `www.${SAMPLE_HOST}`, search: "" })).toBe(true);
    expect(isDemoHost(`demo.${PORTAL_HOST}`)).toBe(false);
    expect(liveBackendAllowed({ hostname: SAMPLE_HOST })).toBe(false);
    expect(allowsAnonymousDemoEntry({ hostname: SAMPLE_HOST })).toBe(false);
  });

  it("honors VITE_APP_SURFACE when the host is not canonical", () => {
    expect(resolveAppSurface({
      hostname: "example-demo.vercel.app",
      search: "",
      env: { VITE_APP_SURFACE: "demo" },
    })).toBe("demo");
    expect(resolveAppSurface({
      hostname: "unionground-saas.vercel.app",
      search: "?demo=1",
      env: { VITE_APP_SURFACE: "saas" },
    })).toBe("saas");
    expect(isBuildTimeDemoSurface({ VITE_APP_SURFACE: "demo" })).toBe(true);
    expect(liveBackendAllowed({
      hostname: "example-demo.vercel.app",
      env: { VITE_APP_SURFACE: "demo" },
    })).toBe(false);
  });

  it("joins the demo rider to a path that already carries a query instead of doubling the ?", () => {
    // The staff workspace rider once produced /m/steward/caseload?shell=alt?demo=1,
    // which reads shell as "alt?demo=1" and loses demo on the next load.
    const joined = withDemoRider("/m/steward/caseload?shell=alt");
    expect(joined).toBe("/m/steward/caseload?shell=alt&demo=1");
    const params = new URL(joined, "https://example.test").searchParams;
    expect(params.get("shell")).toBe("alt");
    expect(params.get("demo")).toBe("1");
    expect(withDemoRider("/m/tasks")).toBe("/m/tasks?demo=1");
    expect(withDemoRider("/m/tasks?demo=1&shell=alt")).toBe("/m/tasks?demo=1&shell=alt");
    expect(withDemoRider("/m/settings#alerts")).toBe("/m/settings?demo=1#alerts");
    expect(withDemoRider("")).toBe("");
  });

  it("keeps ordinary localhost and Vercel previews on SaaS even with a demo query", () => {
    const browser = { MODE: "production" };
    expect(hasDemoQuery("?demo=1")).toBe(true);
    expect(shouldEnterDemo({ hostname: "localhost", search: "?demo=1", env: browser })).toBe(false);
    expect(shouldEnterDemo({ hostname: "127.0.0.1", search: "?demo=1", env: browser })).toBe(false);
    expect(shouldEnterDemo({ hostname: "feature-unionground.vercel.app", search: "?demo=1", env: browser })).toBe(false);
    expect(resolveAppSurface({ hostname: "localhost", search: "?demo=1", env: browser })).toBe("saas");
    expect(allowsAnonymousDemoEntry({ hostname: "localhost", env: browser })).toBe(false);
    expect(allowsAnonymousDemoEntry({ hostname: "127.0.0.1", env: browser })).toBe(false);
    expect(sampleTourHref({}, PORTAL_HOST)).toBe("/m?demo=1");
    expect(sampleTourHref(browser, "feature-unionground.vercel.app")).toBe("/m?demo=1");
  });

  it("lets the vitest harness select SAMPLE with ?demo=1", () => {
    expect(isTestHarness({ MODE: "test" })).toBe(true);
    expect(shouldEnterDemo({
      hostname: "localhost",
      search: "?demo=1",
      env: { MODE: "test" },
    })).toBe(true);
    expect(shouldEnterDemo({ hostname: "localhost", search: "", env: { MODE: "test" } })).toBe(false);
  });

  it("lets the Playwright assurance harness select SAMPLE with ?demo=1", () => {
    const harness = { MODE: "production", VITE_E2E_HARNESS: "1" };
    expect(isTestHarness(harness)).toBe(true);
    expect(shouldEnterDemo({
      hostname: "127.0.0.1",
      search: "?demo=1",
      env: harness,
    })).toBe(true);
    expect(shouldEnterDemo({
      hostname: "127.0.0.1",
      search: "",
      env: harness,
    })).toBe(false);
    expect(allowsAnonymousDemoEntry({ hostname: "127.0.0.1", env: harness })).toBe(true);
    expect(sampleTourHref(harness, "feature-unionground.vercel.app")).toBe("/m?demo=1");
  });

  it("lets the SAMPLE visual-audit host select fixtures without the e2e harness", () => {
    expect(isTestHarness({ VITE_VISUAL_AUDIT: "1" })).toBe(true);
    expect(isTestHarness({ MODE: "production" })).toBe(false);
    expect(shouldEnterDemo({
      hostname: "127.0.0.1",
      search: "",
      env: { MODE: "production", VITE_APP_SURFACE: "demo", VITE_VISUAL_AUDIT: "1" },
    })).toBe(true);
  });
});
