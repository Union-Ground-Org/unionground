// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler, { MAX_CLOCK_SKEW_MS, assessCurrencyCanary, pingCurrencyHeartbeat } from "../api/private-upload-currency-canary.js";
import { PORTAL_HOST, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
import { unauthenticatedCronTickHeaders, vercelCronTickHeaders } from "./helpers/vercelCronTick.js";

const SECRET = "cron-secret-value-32-characters-min";
const NOW = Date.parse("2026-09-06T12:00:00Z");

function response() {
  return {
    code: 0, headers: {}, body: null,
    status(code) { this.code = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(body) { this.body = JSON.parse(body); },
  };
}

async function call({ method = "GET", headers = {} } = {}) {
  const res = response();
  await handler({
    method,
    // The documented Vercel tick: the bearer, no x-vercel-cron marker.
    headers: { host: PORTAL_HOST, ...vercelCronTickHeaders(SECRET, "20 * * * *"), ...headers },
  }, res);
  return res;
}

function rpcResult(overrides = {}) {
  return {
    checked: true,
    current: true,
    bucketId: "case-files",
    cleanUntil: new Date(NOW + 3 * 60 * 60 * 1000).toISOString(),
    signatureUpdatedAt: new Date(NOW - 6 * 60 * 60 * 1000).toISOString(),
    scannedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    liveCleanObjects: 12,
    expiredCleanObjects: 0,
    now: new Date(NOW).toISOString(),
    ...overrides,
  };
}

let payload;
beforeEach(() => {
  for (const [key, value] of Object.entries({
    VITE_SUPABASE_URL: SUPABASE_ORIGIN,
    UNIONGROUND_SUPABASE_PROJECT_REF: SUPABASE_REF,
    VITE_SUPABASE_PUBLISHABLE_KEY: "public-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    CRON_SECRET: SECRET,
    SAMPLE_SUPABASE_URL: "https://samplefictionalproj.supabase.co",
    SAMPLE_SUPABASE_SERVICE_ROLE_KEY: "sample-service-key",
  })) vi.stubEnv(key, value);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  payload = rpcResult();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) })));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("private upload currency canary — the §6.4 rule", () => {
  it("passes when the row closest to expiry still satisfies the predicate", () => {
    expect(assessCurrencyCanary(rpcResult(), NOW)).toEqual({
      status: 200,
      body: {
        ok: true, checked: true, skewMs: 0, liveCleanObjects: 12, expiredCleanObjects: 0,
        bucketId: "case-files",
        cleanUntil: new Date(NOW + 3 * 60 * 60 * 1000).toISOString(),
        signatureUpdatedAt: new Date(NOW - 6 * 60 * 60 * 1000).toISOString(),
      },
    });
  });

  // This is the whole point of the probe. The row says it is current by its own
  // clean_until; the predicate disagrees. That is a join, arithmetic or clock
  // fault, and it has no other witness anywhere in the system.
  it("fails when a row that claims currency does not satisfy the predicate", () => {
    const assessment = assessCurrencyCanary(rpcResult({ current: false }), NOW);
    expect(assessment.status).toBe(500);
    expect(assessment.body).toMatchObject({ ok: false, error: "private_upload_not_current", checked: true });
  });

  it.each([undefined, null, "false", 0, 1])("treats a non-true `current` (%p) as a failure", (current) => {
    expect(assessCurrencyCanary(rpcResult({ current }), NOW).status).toBe(500);
  });

  // A drifted clock makes the predicate answer correctly today and wrongly
  // tomorrow, so it has to alert first and independently — while everything
  // still looks healthy.
  it("fails on clock disagreement before it looks at the predicate at all", () => {
    const drifted = new Date(NOW + MAX_CLOCK_SKEW_MS + 1000).toISOString();
    const assessment = assessCurrencyCanary(rpcResult({ now: drifted, current: true }), NOW);
    expect(assessment.status).toBe(500);
    expect(assessment.body).toMatchObject({ ok: false, error: "currency_canary_clock_skew" });
    expect(assessment.body.skewMs).toBeGreaterThan(MAX_CLOCK_SKEW_MS);
    // Symmetric: behind is as bad as ahead.
    expect(assessCurrencyCanary(rpcResult({ now: new Date(NOW - MAX_CLOCK_SKEW_MS - 1000).toISOString() }), NOW).status)
      .toBe(500);
    // And a skew inside the bound is not an alert.
    expect(assessCurrencyCanary(rpcResult({ now: new Date(NOW + 5000).toISOString() }), NOW).status).toBe(200);
  });

  // Verdicts last at most 24 hours and are renewed when a file is opened, so a
  // quiet ledger whose every clean verdict expired is idle, not a fault. It
  // says so in the body rather than passing as a checked witness.
  it("reports an expired-only ledger as idle coverage, not a fault", () => {
    const assessment = assessCurrencyCanary(
      { checked: false, reason: "no-current-clean-object", liveCleanObjects: 0, expiredCleanObjects: 4, now: new Date(NOW).toISOString() },
      NOW,
    );
    expect(assessment).toEqual({
      status: 200,
      body: { ok: true, checked: false, coverage: "idle", skewMs: 0, liveCleanObjects: 0, expiredCleanObjects: 4 },
    });
  });

  it("still fails an idle ledger on clock disagreement", () => {
    const assessment = assessCurrencyCanary(
      { checked: false, liveCleanObjects: 0, expiredCleanObjects: 4, now: new Date(NOW + MAX_CLOCK_SKEW_MS + 1000).toISOString() },
      NOW,
    );
    expect(assessment.status).toBe(500);
    expect(assessment.body).toMatchObject({ ok: false, error: "currency_canary_clock_skew", checked: false });
  });

  it.each([null, undefined, "text", [], { now: "not-a-date" }, { checked: true }])(
    "refuses to decide from an unreadable answer (%p)", (result) => {
      const assessment = assessCurrencyCanary(result, NOW);
      expect(assessment.status).toBe(503);
      expect(assessment.body).toEqual({ ok: false, error: "currency_canary_unreadable" });
    },
  );
});

describe("private upload currency canary endpoint", () => {
  it("asks the service-role RPC, reports the ledger as agreeing, and still answers 503 because no SAMPLE project is pinned", async () => {
    const res = await call();
    // Union Ground pins no SAMPLE project, so the demo surface can never be
    // asked: the cron monitor sees 503 until one exists, never a silent green.
    expect(res.code).toBe(503);
    expect(res.body).toMatchObject({ ok: false, surfaces: { saas: { ok: true, checked: true, liveCleanObjects: 12 }, demo: { ok: false, error: "not_configured" } } });
    expect(res.headers["Cache-Control"]).toBe("no-store");
    const [url, init] = global.fetch.mock.calls[0];
    expect(String(url)).toBe(`${SUPABASE_ORIGIN}/rest/v1/rpc/private_upload_currency_canary`);
    expect(init.headers.Authorization).toBe("Bearer service-key");
    expect(JSON.parse(init.body)).toEqual({});
  });

  it("answers 500 so a cron monitor sees the fault", async () => {
    payload = rpcResult({ current: false });
    const res = await call();
    expect(res.code).toBe(500);
    expect(res.body).toMatchObject({ ok: false, surfaces: { saas: { error: "private_upload_not_current" } } });
  });

  it.each([
    ["the documented tick without the bearer, even with an x-vercel-cron marker", { ...unauthenticatedCronTickHeaders("20 * * * *"), authorization: "" }],
    ["a wrong secret with an x-vercel-cron marker", { "x-vercel-cron": "1", authorization: "Bearer wrong-secret-value-of-the-same-len" }],
    ["a wrong secret", { authorization: "Bearer wrong-secret-value-of-the-same-len" }],
    ["no bearer at all", { authorization: "" }],
  ])("refuses %s without asking the database", async (_label, headers) => {
    const res = await call({ headers });
    expect(res.code).toBe(401);
    expect(res.body).toEqual({ ok: false, error: "unauthorized" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fails closed with 503 for the operator when no CRON_SECRET is configured, so nobody is authorized", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call()).code).toBe(503);
    vi.stubEnv("CRON_SECRET", undefined);
    expect((await call({ headers: { authorization: "" } })).code).toBe(503);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects every method but GET before any work", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await call({ method });
      expect(res.code, method).toBe(405);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("answers 503, not a currency fault, when the database cannot be asked", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, text: async () => "" })));
    const res = await call();
    expect(res.code).toBe(503);
    // A deploy that runs ahead of the migration must not be reported as an
    // expired-verdict incident: it is retryable, and a page for it would train
    // the operator to ignore the real one.
    expect(res.body).toEqual({ ok: false, surfaces: { saas: { ok: false, error: "currency_canary_unavailable" }, demo: { ok: false, error: "not_configured" } } });
    expect(logged).toHaveBeenCalledWith("[private-upload-currency-canary]", { outcome: "currency_canary_unavailable" });
  });

  it("answers 503 when the backend is not configured", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const res = await call();
    expect(res.code).toBe(503);
    expect(res.body.surfaces.saas).toEqual({ ok: false, error: "not_configured" });
    expect(res.body.surfaces.demo).toEqual({ ok: false, error: "not_configured" });
    // Neither surface can be asked: no SAMPLE project is pinned and SaaS lost its key.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("never names an object, a file id or a path in its answer", async () => {
    payload = rpcResult({ current: false });
    const res = await call();
    expect(JSON.stringify(res.body)).not.toMatch(/objectName|fileId|storage|\//);
  });
});


describe("currency canary dual-backend coverage", () => {
  it("never queries SAMPLE credentials, even when a complete SAMPLE family is set on an authenticated SaaS cron", async () => {
    const res = await call();
    expect(res.code).toBe(503);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(String(url)).toBe(`${SUPABASE_ORIGIN}/rest/v1/rpc/private_upload_currency_canary`);
    expect(init.headers.Authorization).toBe("Bearer service-key");
    expect(res.body.surfaces.demo).toEqual({ ok: false, error: "not_configured" });
  });
  it("cannot surface a SAMPLE fault because the SAMPLE project is never asked", async () => {
    global.fetch.mockImplementation(async (url) => ({ ok: true, status: 200,
      text: async () => JSON.stringify(rpcResult({ current: !String(url).includes("samplefictionalproj") })) }));
    const res = await call();
    expect(res.code).toBe(503);
    expect(res.body.surfaces.saas.ok).toBe(true);
    expect(res.body.surfaces.demo).toEqual({ ok: false, error: "not_configured" });
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes("samplefictionalproj"))).toBe(false);
  });
  it.each(["", SUPABASE_ORIGIN])("never borrows production when SAMPLE URL is %p", async (url) => {
    vi.stubEnv("SAMPLE_SUPABASE_URL", url); vi.stubEnv("VITE_SAMPLE_SUPABASE_URL", "");
    const res = await call();
    expect(res.code).toBe(503);
    expect(res.body.surfaces.demo).toEqual({ ok: false, error: "not_configured" });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it("does not report an empty or deleted ledger as healthy coverage", () => {
    expect(assessCurrencyCanary(rpcResult({ checked: false, liveCleanObjects: 0 }), NOW))
      .toMatchObject({ status: 503, body: { ok: false, error: "currency_canary_no_witness" } });
  });
  it.each([{ checked: "false" }, { liveCleanObjects: -1 }, { expiredCleanObjects: "0" },
    { checked: false, liveCleanObjects: 1 }, { liveCleanObjects: 0 }])("refuses inconsistent projection %p", (change) => {
    expect(assessCurrencyCanary(rpcResult(change), NOW).status).toBe(503);
  });
});

// Union Ground pins no SAMPLE project, so no tick passes and no ping is sent;
// these cases hold the withholding side.
describe("currency canary heartbeat", () => {
  const HEARTBEAT = "https://uptime.betterstack.com/api/v1/heartbeat/AbCdEf0123456789wxyz";
  const heartbeatCalls = () => global.fetch.mock.calls.filter(([url]) => String(url).includes("betterstack"));

  it.each([
    ["a decided fault", () => { payload = rpcResult({ current: false }); }],
    ["an unreachable database", () => {
      vi.stubGlobal("fetch", vi.fn(async (url) => (String(url).includes("betterstack")
        ? { ok: true, status: 200 } : { ok: false, status: 404, text: async () => "" })));
    }],
    ["an empty ledger", () => { payload = { checked: false, liveCleanObjects: 0, expiredCleanObjects: 0, now: new Date(NOW).toISOString() }; }],
  ])("withholds the ping on %s, so the missed ping pages", async (_label, arrange) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("PRIVATE_UPLOAD_CURRENCY_HEARTBEAT_URL", HEARTBEAT);
    arrange();
    const res = await call();
    expect(res.code).not.toBe(200);
    expect(heartbeatCalls()).toHaveLength(0);
  });

  it("does nothing when the heartbeat is not configured", async () => {
    expect(await pingCurrencyHeartbeat({})).toBe("not_configured");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    "http://uptime.betterstack.com/api/v1/heartbeat/AbCdEf0123456789wxyz",
    "https://uptime.betterstack.com.evil.example/api/v1/heartbeat/AbCdEf0123456789wxyz",
    "https://uptime.betterstack.com/api/v1/heartbeat/AbCdEf0123456789wxyz?x=1",
    "https://uptime.betterstack.com/api/v1/heartbeat/short",
    "https://example.com/api/v1/heartbeat/AbCdEf0123456789wxyz",
  ])("refuses a URL that is not a Better Stack heartbeat (%s) without fetching or echoing it", async (url) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await pingCurrencyHeartbeat({ PRIVATE_UPLOAD_CURRENCY_HEARTBEAT_URL: url })).toBe("refused");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith("[private-upload-currency-canary]", { outcome: "heartbeat_url_refused" });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("heartbeat/");
  });

  it("reports a non-2xx heartbeat answer as a failed ping", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch.mockImplementation(async () => ({ ok: false, status: 404 }));
    expect(await pingCurrencyHeartbeat({ PRIVATE_UPLOAD_CURRENCY_HEARTBEAT_URL: HEARTBEAT })).toBe("failed");
  });
});
