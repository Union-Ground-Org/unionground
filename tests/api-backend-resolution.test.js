// @vitest-environment node
// BUG-UG-DEMO-SURFACE-PREVIEW-RESOLVES-PRODUCTION-BACKEND-20260908
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEMO_SURFACE_HOST_REFUSED,
  isSamplePreviewHost,
  isVercelCron,
  resolveSupabaseBackend,
  samplePreviewHosts,
} from "../api/_lib/backend.js";
import verifyChapterConnection from "../api/chapter-lifecycle-verification.js";
import calendarFeed from "../api/calendar.js";
import { PORTAL_HOST, SAMPLE_HOST, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";
import { SAMPLE_SUPABASE_ORIGIN } from "./helpers/b00-pinned-sample-backend.js";
import { unauthenticatedCronTickHeaders, vercelCronTickHeaders } from "./helpers/vercelCronTick.js";

// Union Ground trusts no portal and pins no SAMPLE project, so this suite
// substitutes the fictional trusted pair and a fictional pinned SAMPLE project.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
vi.mock("../src/lib/sampleBackend.js", async (importOriginal) =>
  (await import("./helpers/b00-pinned-sample-backend.js")).pinnedSampleBackendModule(await importOriginal()));

const PRODUCTION_URL = SUPABASE_ORIGIN;
const SAMPLE_URL = SAMPLE_SUPABASE_ORIGIN;
const PREVIEW_HOST = "unionground-fresh-20260720-git-feature-fictional-projects.vercel.app";

const production = {
  surface: "saas",
  url: PRODUCTION_URL,
  publishableKey: "production-public",
  serviceRoleKey: "production-service",
};
const sample = {
  surface: "demo",
  url: SAMPLE_URL,
  publishableKey: "sample-public",
  serviceRoleKey: "sample-service",
};
const baseEnv = {
  VITE_SUPABASE_URL: PRODUCTION_URL,
  UNIONGROUND_SUPABASE_PROJECT_REF: SUPABASE_REF,
  VITE_SUPABASE_PUBLISHABLE_KEY: production.publishableKey,
  SUPABASE_SERVICE_ROLE_KEY: production.serviceRoleKey,
  SAMPLE_SUPABASE_URL: SAMPLE_URL,
  SAMPLE_SUPABASE_PUBLISHABLE_KEY: sample.publishableKey,
  SAMPLE_SUPABASE_SERVICE_ROLE_KEY: sample.serviceRoleKey,
  CRON_SECRET: "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx",
};
const demoEnv = { ...baseEnv, VITE_APP_SURFACE: "demo" };
const saasEnv = { ...baseEnv, VITE_APP_SURFACE: "saas" };

const ordinary = (host) => ({ headers: { host } });
// A genuine tick is what Vercel documents: the CRON_SECRET bearer, no
// x-vercel-cron marker (BUG-UG-EIGHT-SCHEDULED-ROUTES-REFUSE-REAL-VERCEL-CRON-TICKS-20261117).
const cron = (host, bearer = baseEnv.CRON_SECRET) => ({
  headers: { host, ...vercelCronTickHeaders(bearer) },
});
const spoofedCron = (host) => ({ headers: { host, ...unauthenticatedCronTickHeaders() } });

function refused(hostname) {
  return {
    surface: "demo",
    url: "",
    publishableKey: "",
    serviceRoleKey: "",
    refused: DEMO_SURFACE_HOST_REFUSED,
    hostname,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("resolveSupabaseBackend on a demo-surface build", () => {
  it("refuses an ordinary request on an unlisted .vercel.app preview host instead of reaching production", () => {
    const backend = resolveSupabaseBackend(ordinary(PREVIEW_HOST), demoEnv);
    expect(backend).toEqual(refused(PREVIEW_HOST));
    expect(backend.url).toBe("");
    expect(backend.serviceRoleKey).toBe("");
    expect(backend.publishableKey).toBe("");
  });

  it("refuses ordinary requests on every other unrecognised host, including a missing Host header", () => {
    for (const request of [ordinary("preview.example.net"), ordinary(`${SAMPLE_HOST}.evil.example`), ordinary(""), { headers: {} }]) {
      const backend = resolveSupabaseBackend(request, demoEnv);
      expect(backend.refused).toBe(DEMO_SURFACE_HOST_REFUSED);
      expect(backend.url).toBe("");
      expect(backend.serviceRoleKey).toBe("");
    }
  });

  it("refuses a malformed Host authority instead of normalizing it onto the SaaS pin", () => {
    for (const host of [
      `${PREVIEW_HOST}@${PORTAL_HOST}`,
      `${PORTAL_HOST}/x`,
      `${PORTAL_HOST}?x=1`,
      `${PORTAL_HOST}#fragment`,
      `${PORTAL_HOST}\\@evil.example`,
      `user:pass@${PORTAL_HOST}`,
      `${SAMPLE_HOST}@${PORTAL_HOST}`,
      `${PORTAL_HOST}:443:443`,
      `a b.${PORTAL_HOST}`,
      `${PORTAL_HOST},unlisted.vercel.app`,
      `${PORTAL_HOST}..`,
      `${PORTAL_HOST}:443.`,
      ` ${PORTAL_HOST} `,
      "\u212a.vercel.app",
    ]) {
      const backend = resolveSupabaseBackend(ordinary(host), demoEnv);
      expect(backend.refused, host).toBe(DEMO_SURFACE_HOST_REFUSED);
      expect(backend.url, host).toBe("");
      expect(backend.serviceRoleKey, host).toBe("");
      expect(backend.hostname, host).toBe("");
    }
    // Multi-value array headers and a present-but-invalid Host with a SaaS X-Forwarded-Host are refused too.
    for (const headers of [
      { host: [PORTAL_HOST, "unlisted.vercel.app"] },
      { "x-forwarded-host": [PORTAL_HOST, "unlisted.vercel.app"] },
      { host: "bad host", "x-forwarded-host": PORTAL_HOST },
      { host: ["unlisted.vercel.app", PORTAL_HOST], "x-forwarded-host": PORTAL_HOST },
    ]) {
      const backend = resolveSupabaseBackend({ headers }, demoEnv);
      expect(backend.refused, JSON.stringify(headers)).toBe(DEMO_SURFACE_HOST_REFUSED);
      expect(backend.serviceRoleKey, JSON.stringify(headers)).toBe("");
    }
    expect(resolveSupabaseBackend({ headers: { host: [PORTAL_HOST] } }, demoEnv)).toEqual(production);
    // Valid authorities with casing, ports and a trailing dot keep resolving.
    expect(resolveSupabaseBackend(ordinary(`${PORTAL_HOST.toUpperCase()}.:443`), demoEnv)).toEqual(production);
    expect(resolveSupabaseBackend(ordinary(`${SAMPLE_HOST}.:443`), demoEnv)).toEqual(sample);
  });

  it("keeps an authenticated Vercel cron request on the preview host on production", () => {
    expect(resolveSupabaseBackend(cron(PREVIEW_HOST), demoEnv)).toEqual(production);
  });

  it("authorizes a cron tick on the CRON_SECRET bearer alone and never on a header", () => {
    expect(cron(PREVIEW_HOST).headers).not.toHaveProperty("x-vercel-cron");
    expect(isVercelCron(cron(PREVIEW_HOST), baseEnv)).toBe(true);
    expect(isVercelCron({ headers: { authorization: `Bearer ${baseEnv.CRON_SECRET}` } }, baseEnv)).toBe(true);
    expect(isVercelCron({ headers: { ...cron(PREVIEW_HOST).headers, "x-vercel-cron": "1" } }, baseEnv)).toBe(true);
    expect(isVercelCron(spoofedCron(PREVIEW_HOST), baseEnv)).toBe(false);
    expect(isVercelCron(cron(PREVIEW_HOST, "wrong"), baseEnv)).toBe(false);
    expect(isVercelCron({ headers: { "x-vercel-cron": "1", authorization: "Bearer " } }, { CRON_SECRET: "" })).toBe(false);
    expect(isVercelCron(cron(PREVIEW_HOST), { ...baseEnv, CRON_SECRET: "" })).toBe(false);
    // A configured secret with no request, no headers, or an empty or
    // non-bearer Authorization value still refuses.
    expect(isVercelCron(undefined, baseEnv)).toBe(false);
    expect(isVercelCron({}, baseEnv)).toBe(false);
    expect(isVercelCron({ headers: { authorization: [""] } }, baseEnv)).toBe(false);
    expect(isVercelCron({ headers: { authorization: baseEnv.CRON_SECRET } }, baseEnv)).toBe(false);
    // The raw header must equal `Bearer <CRON_SECRET>` exactly, as
    // api/account-deletion-reconcile.js requires: no doubled space, no
    // trailing or leading space, no other casing, never an array.
    for (const authorization of [
      `Bearer  ${baseEnv.CRON_SECRET}`,
      `Bearer ${baseEnv.CRON_SECRET} `,
      ` Bearer ${baseEnv.CRON_SECRET}`,
      `bearer ${baseEnv.CRON_SECRET}`,
      [`Bearer ${baseEnv.CRON_SECRET}`],
    ]) {
      expect(isVercelCron({ headers: { authorization } }, baseEnv)).toBe(false);
      expect(resolveSupabaseBackend({ headers: { host: PREVIEW_HOST, authorization } }, demoEnv)).toEqual(refused(PREVIEW_HOST));
    }
  });

  it("does not let a spoofed or wrongly authenticated cron header change the refusal", () => {
    expect(resolveSupabaseBackend(spoofedCron(PREVIEW_HOST), demoEnv)).toEqual(refused(PREVIEW_HOST));
    expect(resolveSupabaseBackend(cron(PREVIEW_HOST, "wrong"), demoEnv)).toEqual(refused(PREVIEW_HOST));
    expect(resolveSupabaseBackend(cron(PREVIEW_HOST), { ...demoEnv, CRON_SECRET: "" })).toEqual(refused(PREVIEW_HOST));
  });

  it("keeps the canonical demo host on SAMPLE for ordinary requests and on production for authenticated cron", () => {
    for (const host of [SAMPLE_HOST, `www.${SAMPLE_HOST}`, `${SAMPLE_HOST.toUpperCase()}.`]) {
      expect(resolveSupabaseBackend(ordinary(host), demoEnv)).toEqual(sample);
      expect(resolveSupabaseBackend(spoofedCron(host), demoEnv)).toEqual(sample);
      expect(resolveSupabaseBackend(cron(host), demoEnv)).toEqual(production);
    }
  });

  it("keeps the demo loopback on SAMPLE with and without an authenticated cron request", () => {
    for (const host of ["localhost", "localhost:5173", "127.0.0.1", "127.0.0.1:4173", "[::1]", "[::1]:4173"]) {
      expect(resolveSupabaseBackend(ordinary(host), demoEnv)).toEqual(sample);
      expect(resolveSupabaseBackend(cron(host), demoEnv)).toEqual(sample);
    }
  });

  it("keeps the SaaS host pinned to production regardless of the surface value", () => {
    for (const host of [PORTAL_HOST, PORTAL_HOST.toUpperCase()]) {
      expect(resolveSupabaseBackend(ordinary(host), demoEnv)).toEqual(production);
      expect(resolveSupabaseBackend(ordinary(host), saasEnv)).toEqual(production);
      expect(resolveSupabaseBackend(ordinary(host), baseEnv)).toEqual(production);
    }
  });

  it("refuses when the SAMPLE configuration itself is forbidden instead of falling back to production", () => {
    const backend = resolveSupabaseBackend(ordinary(SAMPLE_HOST), { ...demoEnv, SAMPLE_SUPABASE_URL: PRODUCTION_URL });
    expect(backend.surface).toBe("demo");
    expect(backend.url).toBe("");
    expect(backend.serviceRoleKey).toBe("");
  });
});

describe("optional SAMPLE preview allowlist", () => {
  const listed = { ...demoEnv, SAMPLE_PREVIEW_HOSTS: ` ${PREVIEW_HOST.toUpperCase()}. , other-preview.vercel.app,` };

  it("resolves an allowlisted .vercel.app preview host to SAMPLE for ordinary demo-surface requests only", () => {
    expect(resolveSupabaseBackend(ordinary(PREVIEW_HOST), listed)).toEqual(sample);
    expect(resolveSupabaseBackend(ordinary(`${PREVIEW_HOST}:443`), listed)).toEqual(sample);
    expect(resolveSupabaseBackend(cron(PREVIEW_HOST), listed)).toEqual(production);
    expect(resolveSupabaseBackend(spoofedCron(PREVIEW_HOST), listed)).toEqual(sample);
    expect(resolveSupabaseBackend(ordinary("unlisted-preview.vercel.app"), listed)).toEqual(refused("unlisted-preview.vercel.app"));
  });

  it("is inert on production-surface builds", () => {
    expect(resolveSupabaseBackend(ordinary(PREVIEW_HOST), { ...saasEnv, SAMPLE_PREVIEW_HOSTS: PREVIEW_HOST })).toEqual(production);
    expect(resolveSupabaseBackend(ordinary(PREVIEW_HOST), { ...baseEnv, SAMPLE_PREVIEW_HOSTS: PREVIEW_HOST })).toEqual(production);
  });

  it("never lets the allowlist override the SaaS pin, the canonical demo host, or non-Vercel names", () => {
    const hostile = {
      ...demoEnv,
      SAMPLE_PREVIEW_HOSTS: `${PORTAL_HOST},www.${PORTAL_HOST},${SAMPLE_HOST},evil.example,vercel.app,.vercel.app,sub.vercel.app.evil.example`,
    };
    expect(samplePreviewHosts(hostile)).toEqual([]);
    expect(resolveSupabaseBackend(ordinary(PORTAL_HOST), hostile)).toEqual(production);
    expect(resolveSupabaseBackend(ordinary(SAMPLE_HOST), hostile)).toEqual(sample);
    expect(resolveSupabaseBackend(ordinary("evil.example"), hostile)).toEqual(refused("evil.example"));
    expect(resolveSupabaseBackend(ordinary("vercel.app"), hostile)).toEqual(refused("vercel.app"));
    expect(isSamplePreviewHost("", { ...demoEnv, SAMPLE_PREVIEW_HOSTS: "," })).toBe(false);
  });

  it("matches exact hostnames only", () => {
    expect(isSamplePreviewHost(PREVIEW_HOST, listed)).toBe(true);
    expect(isSamplePreviewHost(`sub.${PREVIEW_HOST}`, listed)).toBe(false);
    expect(isSamplePreviewHost(PREVIEW_HOST.replace("fictional", "attacker"), listed)).toBe(false);
    expect(samplePreviewHosts(listed)).toEqual([PREVIEW_HOST, "other-preview.vercel.app"]);
  });
});

describe("api-origin handler on a demo-surface build", () => {
  function stubEnv(env) {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  }
  function response() {
    const res = { statusCode: 0, body: "", status(code) { this.statusCode = code; return this; }, setHeader() { return this; }, end(body) { this.body = body; return this; } };
    return res;
  }
  const memberRequest = (host) => ({
    method: "POST",
    // Only the trusted portal is an allowed browser Origin; every other host
    // reaches the backend resolver as a bearer-only machine request.
    headers: { host, ...(host === PORTAL_HOST ? { origin: `https://${host}` } : {}), authorization: "Bearer member-token" },
    // A well-formed campaign id, so the handler reaches the caller lookup.
    body: { chapterId: "harbor-campaign" },
  });

  it("never sends production credentials for an ordinary request on a non-SaaS host, while the SaaS host still receives production", async () => {
    // VERCEL_URL makes the preview's own Origin trusted so the request reaches the resolver instead of the Origin guard.
    stubEnv({ ...demoEnv, VERCEL_URL: PREVIEW_HOST });
    const fetcher = vi.fn(async (url) => ({ ok: false, status: 401, json: async () => ({}), url }));
    vi.stubGlobal("fetch", fetcher);

    const refusedResponse = response();
    await verifyChapterConnection(memberRequest(PREVIEW_HOST), refusedResponse);
    expect(refusedResponse.statusCode).toBe(503);
    expect(JSON.parse(refusedResponse.body)).toEqual({ error: "not-configured" });
    expect(fetcher).not.toHaveBeenCalled();

    const saasResponse = response();
    await verifyChapterConnection(memberRequest(PORTAL_HOST), saasResponse);
    expect(saasResponse.statusCode).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`${PRODUCTION_URL}/auth/v1/user`);
    expect(init.headers.apikey).toBe(production.publishableKey);
    for (const call of fetcher.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(SAMPLE_URL);
    }
  });

  // The calendar feed no longer routes by Host: it reads the one Union Ground
  // provider from the environment and fails closed unless the configured
  // Supabase URL is exactly the project named by UNIONGROUND_SUPABASE_PROJECT_REF.
  // A Host header, malformed or not, can therefore never choose the backend.
  it("sends the calendar feed RPC only to the pinned project, and never to an unpinned one, whatever the Host", async () => {
    stubEnv({ ...demoEnv, UNIONGROUND_SUPABASE_PROJECT_REF: "" });
    const fetcher = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" }));
    vi.stubGlobal("fetch", fetcher);
    const hosts = [`${PREVIEW_HOST}@${PORTAL_HOST}`, `${PORTAL_HOST},unlisted.vercel.app`, `${PORTAL_HOST}..`, ` ${PORTAL_HOST} `, [PORTAL_HOST, "unlisted.vercel.app"], SAMPLE_HOST];
    // No pinned project reference configured: refused before any network call.
    for (const host of hosts) {
      const refused = response();
      await calendarFeed({ method: "GET", headers: { host }, query: { token: "t".repeat(40) } }, refused);
      expect(refused.statusCode, JSON.stringify(host)).toBe(503);
    }
    expect(fetcher).not.toHaveBeenCalled();
    // The pinned project receives the service-role RPC for every Host, and the SAMPLE project never does.
    vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", SUPABASE_REF);
    for (const host of [PORTAL_HOST, ...hosts]) {
      fetcher.mockClear();
      const res = response();
      await calendarFeed({ method: "GET", headers: { host }, query: { token: "t".repeat(40) } }, res);
      expect(fetcher, JSON.stringify(host)).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][0].startsWith(PRODUCTION_URL), JSON.stringify(host)).toBe(true);
      expect(JSON.stringify(fetcher.mock.calls)).not.toContain(SAMPLE_URL);
    }
  });

  it("reaches SAMPLE, never production, for an ordinary request on the canonical demo host", async () => {
    // VERCEL_URL makes the preview's own Origin trusted so the request reaches the resolver instead of the Origin guard.
    stubEnv({ ...demoEnv, VERCEL_URL: PREVIEW_HOST });
    const fetcher = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetcher);
    const res = response();
    await verifyChapterConnection(memberRequest(SAMPLE_HOST), res);
    expect(res.statusCode).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(`${SAMPLE_URL}/auth/v1/user`);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain(production.publishableKey);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain(PRODUCTION_URL);
  });
});
