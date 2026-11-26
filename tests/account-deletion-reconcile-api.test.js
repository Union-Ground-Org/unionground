// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DENIED_SAMPLE_REF, deniedSupabaseOrigin } from "./helpers/denied-identity-fixtures.js";
// The job reaches production only as an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://productionfixture.supabase.co"));

const PRODUCTION_URL = "https://productionfixture.supabase.co";
const SAMPLE_URL = deniedSupabaseOrigin(DENIED_SAMPLE_REF);
const CRON_SECRET = "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx";
const SERVICE_KEY = "sb_secret_production_account_lifecycle";

function request(overrides = {}) {
  return {
    method: "GET",
    headers: {
      host: "app.example.org",
      authorization: `Bearer ${CRON_SECRET}`,
      ...overrides,
    },
  };
}

function responseRecorder() {
  const out = { status: 0, headers: {}, body: null };
  return {
    out,
    status(code) { out.status = code; return this; },
    setHeader(name, value) { out.headers[name] = value; },
    end(value) { out.body = value ? JSON.parse(value) : null; },
  };
}

function upstream(value, status = 200) {
  const body = status === 204 ? "" : JSON.stringify(value);
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

async function loadHandler() {
  return (await import("../api/account-deletion-reconcile.js")).default;
}

async function run(req = request()) {
  const res = responseRecorder();
  const handler = await loadHandler();
  await handler(req, res);
  return res.out;
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  vi.stubEnv("VITE_SUPABASE_URL", PRODUCTION_URL);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "productionfixture");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
  vi.stubEnv("SAMPLE_SUPABASE_URL", SAMPLE_URL);
  vi.stubEnv("SAMPLE_SUPABASE_SERVICE_ROLE_KEY", "sb_secret_sample_account_lifecycle");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("account-deletion reconciliation cron", () => {
  it("requires GET plus the exact cron bearer before any database access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await run({ ...request(), method: "POST" })).status).toBe(405);
    expect((await run(request({ authorization: undefined }))).status).toBe(401);
    expect((await run(request({ authorization: "Bearer wrong" }))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await run()).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses SAMPLE targets and credential collisions before any RPC", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    vi.stubEnv("VITE_SUPABASE_URL", SAMPLE_URL);
    expect((await run()).body).toEqual({ ok: false, error: "production_backend_isolation_required" });

    vi.stubEnv("VITE_SUPABASE_URL", PRODUCTION_URL);
    vi.stubEnv("SAMPLE_SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
    expect((await run()).body).toEqual({ ok: false, error: "production_backend_isolation_required" });

    vi.stubEnv("SAMPLE_SUPABASE_SERVICE_ROLE_KEY", `  ${SERVICE_KEY}  `);
    expect((await run()).body).toEqual({ ok: false, error: "production_backend_isolation_required" });

    vi.stubEnv("SAMPLE_SUPABASE_SERVICE_ROLE_KEY", "sb_secret_sample_account_lifecycle");
    vi.stubEnv("VITE_SUPABASE_URL", "http://productionfixture.supabase.co/path");
    expect((await run()).body).toEqual({ ok: false, error: "production_backend_isolation_required" });

    vi.stubEnv("VITE_SUPABASE_URL", "://not-an-origin");
    expect((await run()).body).toEqual({ ok: false, error: "production_backend_isolation_required" });

    vi.stubEnv("VITE_SUPABASE_URL", "https://embedded@productionfixture.supabase.co");
    expect((await run()).body).toEqual({ ok: false, error: "production_backend_isolation_required" });

    vi.stubEnv("VITE_SUPABASE_URL", PRODUCTION_URL);
    vi.stubEnv("SAMPLE_SUPABASE_URL", PRODUCTION_URL);
    expect((await run()).body).toEqual({ ok: false, error: "production_backend_isolation_required" });

    vi.stubEnv("SAMPLE_SUPABASE_URL", "://misconfigured-sample-origin");
    expect((await run()).body).toEqual({ ok: false, error: "production_backend_isolation_required" });

    vi.stubEnv("SAMPLE_SUPABASE_URL", SAMPLE_URL);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect((await run()).body).toEqual({ ok: false, error: "production_backend_isolation_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses only production credentials even when Vercel delivers the cron at the SAMPLE host", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      if (String(url).includes("record_account_deletion_reconcile_job_run")) return upstream(null, 204);
      if (String(url).includes("reconcile_pending_account_deletions")) return upstream(2);
      throw new Error("unexpected RPC");
    }));

    const out = await run(request({ host: "sample.example.org" }));
    expect(out).toEqual({
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: { ok: true, reconciled: 2, limit: 25 },
    });
    expect(calls.map((call) => call.url)).toEqual([
      `${PRODUCTION_URL}/rest/v1/rpc/record_account_deletion_reconcile_job_run`,
      `${PRODUCTION_URL}/rest/v1/rpc/reconcile_pending_account_deletions`,
      `${PRODUCTION_URL}/rest/v1/rpc/record_account_deletion_reconcile_job_run`,
    ]);
    expect(calls.every((call) => call.headers.apikey === SERVICE_KEY)).toBe(true);
    expect(calls[1].body).toEqual({ p_limit: 25 });
    expect(calls[0].body).toMatchObject({ p_status: "in_progress", p_failure_class: null });
    expect(calls[2].body).toMatchObject({ p_status: "completed", p_failure_class: null });
    expect(calls[2].body.p_run_id).toBe(calls[0].body.p_run_id);
    expect(request().headers).not.toHaveProperty("x-vercel-cron");
  });

  it("makes empty duplicate invocations safe and independently monitored", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      if (String(url).includes("reconcile_pending_account_deletions")) return upstream(0);
      return upstream(null, 204);
    }));

    const [first, duplicate] = await Promise.all([run(), run()]);
    expect(first).toMatchObject({ status: 200, body: { ok: true, reconciled: 0, limit: 25 } });
    expect(duplicate).toMatchObject({ status: 200, body: { ok: true, reconciled: 0, limit: 25 } });
    const starts = calls.filter((call) => call.body.p_status === "in_progress");
    expect(starts).toHaveLength(2);
    expect(new Set(starts.map((call) => call.body.p_run_id)).size).toBe(2);
    expect(calls.filter((call) => call.url.includes("reconcile_pending_account_deletions"))).toHaveLength(2);
  });

  it("fails closed when monitoring cannot start and never reconciles an unmonitored run", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      calls.push(String(url));
      return upstream({ internal: "private-content" }, 503);
    }));
    expect(await run()).toMatchObject({ status: 503, body: { ok: false, error: "monitoring_unavailable" } });
    expect(calls).toHaveLength(1);
  });

  it("records stable failure classes and never logs or returns upstream content or credentials", async () => {
    const sensitive = `member body ${SERVICE_KEY} ${CRON_SECRET}`;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      call += 1;
      if (call === 1) return upstream(null, 204);
      if (String(url).includes("reconcile_pending_account_deletions")) return upstream({ message: sensitive }, 503);
      return upstream(null, 204);
    }));
    const out = await run();
    expect(out).toMatchObject({ status: 503, body: { ok: false, error: "reconciliation_unavailable" } });
    expect(JSON.stringify(out)).not.toContain(sensitive);
    expect(JSON.stringify(out)).not.toContain(SERVICE_KEY);
    expect(JSON.stringify(out)).not.toContain(CRON_SECRET);
    expect(logged).not.toHaveBeenCalled();
  });

  it("sanitizes thrown reconciliation failures and attempts a terminal monitor record", async () => {
    const bodies = [];
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      call += 1;
      bodies.push(JSON.parse(init.body));
      if (call === 2) throw new Error(`sensitive ${SERVICE_KEY}`);
      return upstream(null, 204);
    }));
    expect(await run()).toMatchObject({
      status: 503,
      body: { ok: false, error: "reconciliation_unavailable" },
    });
    expect(bodies.at(-1)).toMatchObject({ p_status: "failed", p_failure_class: "reconcile_unavailable" });
    expect(JSON.stringify(bodies.at(-1))).not.toContain(SERVICE_KEY);
  });

  it("keeps a partial failure sanitized when the terminal monitor write also throws", async () => {
    const sensitive = `member-content ${SERVICE_KEY} ${CRON_SECRET}`;
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      if (call === 1) return upstream(null, 204);
      if (call === 2) return upstream({ message: sensitive }, 503);
      throw new Error(sensitive);
    }));

    const out = await run();
    expect(call).toBe(3);
    expect(out).toMatchObject({
      status: 503,
      body: { ok: false, error: "reconciliation_unavailable" },
    });
    expect(JSON.stringify(out)).not.toContain(SERVICE_KEY);
    expect(JSON.stringify(out)).not.toContain(CRON_SECRET);
  });

  it("reports monitoring failure when work commits but terminal health recording fails", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      call += 1;
      if (call === 1) return upstream(null, 204);
      if (String(url).includes("reconcile_pending_account_deletions")) return upstream(1);
      return upstream({ private: "not returned" }, 503);
    }));
    expect(await run()).toMatchObject({
      status: 503,
      body: { ok: false, error: "monitoring_unavailable" },
    });
  });

  it("rejects an out-of-contract count and records contract drift", async () => {
    const bodies = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      bodies.push(JSON.parse(init.body));
      if (String(url).includes("reconcile_pending_account_deletions")) return upstream(26);
      return upstream(null, 204);
    }));
    const out = await run();
    expect(out).toMatchObject({ status: 502, body: { ok: false, error: "reconciliation_contract_drift" } });
    expect(bodies.at(-1)).toMatchObject({ p_status: "failed", p_failure_class: "contract_drift" });
  });

  it.each([-1, 1.5, null])("rejects non-bounded reconciliation result %s", async (result) => {
    vi.stubGlobal("fetch", vi.fn(async (url) => (
      String(url).includes("reconcile_pending_account_deletions")
        ? upstream(result)
        : upstream(null, 204)
    )));
    expect(await run()).toMatchObject({
      status: 502,
      body: { ok: false, error: "reconciliation_contract_drift" },
    });
  });

  it("registers the ten-minute schedule and serverless duration", async () => {
    const config = (await import("../vercel.json", { with: { type: "json" } })).default;
    expect(config.crons).toContainEqual({ path: "/api/account-deletion-reconcile", schedule: "*/10 * * * *" });
    expect(config.functions["api/account-deletion-reconcile.js"].maxDuration).toBe(60);
  });
});
