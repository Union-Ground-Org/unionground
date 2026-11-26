// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import handler, { deliveryOutcome, exportReadyEmail } from "../api/organization-exports.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://production-example.supabase.co"));
import { unauthenticatedCronTickHeaders, vercelCronTickHeaders } from "./helpers/vercelCronTick.js";

// The documented Vercel tick for this route: the bearer, no x-vercel-cron marker.
const CRON_TICK = vercelCronTickHeaders("cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx", "15 * * * *");

const ORIGINAL_ENV = { ...process.env };

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
    setHeader() {},
    end(value) { this.payload = value ? JSON.parse(value) : null; },
  };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("organization export schedule endpoint", () => {
  it("rejects calls without the authenticated Vercel cron boundary", async () => {
    process.env.CRON_SECRET = "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx";
    const res = response();
    await handler({ method: "GET", headers: { host: "app.unionground.invalid" } }, res);
    expect(res.statusCode).toBe(401);
  });

  // BUG-UG-EXPORT-API-TEST-ACCEPTS-UNAUTHENTICATED-CRON-20261020: the cron
  // marker is a client-suppliable header, so it never authenticates alone.
  // BUG-UG-EIGHT-SCHEDULED-ROUTES-REFUSE-REAL-VERCEL-CRON-TICKS-20261117:
  // Vercel sends no marker at all, so the configured bearer alone authenticates
  // (see the documented-tick test below). Every refusal must end in 401 before
  // any service-role RPC or provider call is attempted.
  it.each([
    ["marker with no bearer", { "x-vercel-cron": "1" }],
    ["marker with a wrong bearer", { "x-vercel-cron": "1", authorization: "Bearer not-the-secret" }],
    ["marker with a malformed bearer", { "x-vercel-cron": "1", authorization: "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx" }],
    ["marker with an empty bearer", { "x-vercel-cron": "1", authorization: "Bearer " }],
    ["the documented tick without the bearer", unauthenticatedCronTickHeaders("15 * * * *")],
    ["the documented tick with a wrong bearer", vercelCronTickHeaders("not-the-secret", "15 * * * *")],
  ])("refuses %s and does no network work", async (_label, headers) => {
    Object.assign(process.env, {
      CRON_SECRET: "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx",
      VITE_SUPABASE_URL: "https://production.example.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "publishable",
      SUPABASE_SERVICE_ROLE_KEY: "service-secret",
    });
    const fetchMock = vi.fn(async () => { throw new Error("no network work is allowed for a refused caller"); });
    vi.stubGlobal("fetch", fetchMock);
    const res = response();
    await handler({ method: "GET", headers: { host: "app.unionground.invalid", ...headers } }, res);
    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ ok: false, error: "unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a forged marker as a configuration fault (503) when no CRON_SECRET is configured at all", async () => {
    delete process.env.CRON_SECRET;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = response();
    await handler({ method: "GET", headers: { host: "app.unionground.invalid", "x-vercel-cron": "1", authorization: "Bearer " } }, res);
    expect(res.statusCode).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses production service credentials and the service-only runner for the documented Vercel tick (no x-vercel-cron marker)", async () => {
    Object.assign(process.env, {
      CRON_SECRET: "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx",
      VITE_SUPABASE_URL: "https://production-example.supabase.co",
      UNIONGROUND_SUPABASE_PROJECT_REF: "production-example",
      VITE_SUPABASE_PUBLISHABLE_KEY: "publishable",
      SUPABASE_SERVICE_ROLE_KEY: "service-secret",
      SAMPLE_SUPABASE_URL: "https://sample.example.supabase.co",
      SAMPLE_SUPABASE_SERVICE_ROLE_KEY: "sample-secret",
    });
    const fetchMock = vi.fn(async (url, options) => ({
      ok: true,
      status: 200,
      json: async () => ({ processed: 3 }),
      text: async () => JSON.stringify({ processed: 3 }),
      url,
      options,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const res = response();
    await handler({
      method: "GET",
      headers: {
        host: "app.unionground.invalid",
        ...CRON_TICK,
      },
    }, res);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ ok: true, processed: 3, deliveries: { delivered: 0, notConfigured: 0, failed: 0 } });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://production-example.supabase.co/rest/v1/rpc/run_due_organization_coordination_exports",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer service-secret",
          apikey: "service-secret",
        }),
      }),
    );
  });

  it("refuses a genuine cron tick when service credentials are not configured", async () => {
    Object.assign(process.env, {
      CRON_SECRET: "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx",
      VITE_SUPABASE_URL: "https://production-example.supabase.co",
      UNIONGROUND_SUPABASE_PROJECT_REF: "production-example",
      VITE_SUPABASE_PUBLISHABLE_KEY: "publishable",
      SUPABASE_SERVICE_ROLE_KEY: "",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = response();
    await handler({
      method: "GET",
      headers: {
        host: "app.unionground.invalid",
        ...CRON_TICK,
      },
    }, res);
    expect(res.statusCode).toBe(503);
    expect(res.payload).toEqual({ ok: false, error: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports the schedule runner unavailable when the export RPC fails", async () => {
    Object.assign(process.env, {
      CRON_SECRET: "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx",
      VITE_SUPABASE_URL: "https://production-example.supabase.co",
      UNIONGROUND_SUPABASE_PROJECT_REF: "production-example",
      VITE_SUPABASE_PUBLISHABLE_KEY: "publishable",
      SUPABASE_SERVICE_ROLE_KEY: "service-secret",
    });
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const res = response();
    await handler({
      method: "GET",
      headers: {
        host: "app.unionground.invalid",
        ...CRON_TICK,
      },
    }, res);
    expect(res.statusCode).toBe(503);
    expect(res.payload).toEqual({ ok: false, error: "schedule_runner_unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// REQ-UG-SCHEDULED-EXPORTS-PARITY-20261001: queued email and SFTP runs are
// settled every tick instead of staying queued.
describe("organization export delivery worker", () => {
  const CRON = { host: "app.unionground.invalid", ...CRON_TICK };
  const BASE_ENV = {
    CRON_SECRET: "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx",
    VITE_SUPABASE_URL: "https://production-example.supabase.co",
    UNIONGROUND_SUPABASE_PROJECT_REF: "production-example",
    VITE_SUPABASE_PUBLISHABLE_KEY: "publishable",
    SUPABASE_SERVICE_ROLE_KEY: "service-secret",
  };
  const claimed = [
    { runId: "run-email", dataset: "events", deliveryMode: "email_unset", organizationName: "Org A", expiresAt: "2026-10-03T12:00:00Z", recipient: { email: "owner@example.invalid", lang: "es" } },
    { runId: "run-sftp", dataset: "coordination_records", deliveryMode: "sftp_unset", organizationName: "Org A", expiresAt: "2026-10-03T12:00:00Z", recipient: { email: "owner@example.invalid", lang: "en" } },
    { runId: "run-nobody", dataset: "members_directory", deliveryMode: "email_unset", organizationName: "Org A", expiresAt: "2026-10-03T12:00:00Z", recipient: null },
  ];

  function reply(payload, status = 200) {
    return { ok: status < 400, status, json: async () => payload, text: async () => JSON.stringify(payload) };
  }

  function stubFetch({ resendOk = true, claimFails = false } = {}) {
    const calls = [];
    const queue = [...claimed];
    const fetchMock = vi.fn(async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : null;
      calls.push({ url, body, headers: options?.headers });
      if (url.endsWith("/rpc/run_due_organization_coordination_exports")) return reply({ processed: 1 });
      if (url.endsWith("/rpc/claim_organization_export_deliveries")) return claimFails ? reply({}, 500) : reply(queue.splice(0, body.p_limit));
      if (url.endsWith("/rpc/complete_organization_export_delivery")) return reply({ ok: true });
      if (url === "https://api.resend.com/emails") return reply({ id: "email-1" }, resendOk ? 200 : 502);
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return calls;
  }

  const completions = (calls) => calls
    .filter((call) => call.url.endsWith("/rpc/complete_organization_export_delivery"))
    .map((call) => call.body);

  // Keep the real handler, RPC transport, and email sender. Only external
  // replies and elapsed dependency time are simulated; claims consume the
  // requested number of queued rows, as the database does.
  function timedQueue({ schedulerMs, rpcMs, emailMs, emailConfigured = true, claimPauseMs = 0 }) {
    Object.assign(process.env, BASE_ENV, {
      RESEND_API_KEY: emailConfigured ? "re_test" : "",
      NOTIFY_FROM_ADDRESS: emailConfigured ? "no-reply@example.invalid" : "",
    });
    const start = Date.now();
    let clock = start;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const queue = Array.from({ length: 25 }, (_, index) => ({ ...claimed[0], runId: `run-${index}` }));
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body, atMs: clock - start });
      if (url.endsWith("/rpc/run_due_organization_coordination_exports")) {
        clock += schedulerMs;
        return reply({ processed: 25 });
      }
      if (url.endsWith("/rpc/claim_organization_export_deliveries")) {
        clock += rpcMs + claimPauseMs;
        return reply(queue.splice(0, body.p_limit));
      }
      if (url.endsWith("/rpc/complete_organization_export_delivery")) {
        clock += rpcMs;
        return reply({ ok: true });
      }
      if (url === "https://api.resend.com/emails") {
        clock += emailMs;
        return reply({ id: `email-${body.to[0]}` });
      }
      throw new Error(`unexpected ${url}`);
    }));
    return { queue, calls, elapsed: () => clock - start };
  }

  it.each([
    { schedulerMs: 1_000, rpcMs: 1_000, emailMs: 9_000 },
    { schedulerMs: 19_000, rpcMs: 7_999, emailMs: 9_999 },
  ])("answers inside 60 seconds and leaves unstarted notices queued with delays %j", async (delays) => {
    const timed = timedQueue(delays);
    const res = response();
    await handler({ method: "GET", headers: CRON }, res);
    expect(timed.elapsed()).toBeLessThan(60_000);
    expect(res.statusCode).toBe(200);
    expect(res.payload.processed).toBe(25);
    expect(res.payload.deliveries.delivered).toBeGreaterThan(0);
    expect(timed.queue.length).toBeGreaterThan(0);
    const settled = completions(timed.calls);
    const emails = timed.calls.filter((call) => call.url === "https://api.resend.com/emails");
    expect(settled).toHaveLength(emails.length);
    expect(res.payload.deliveries.delivered).toBe(settled.length);
    expect(timed.queue.length + settled.length).toBe(25);
    expect(settled.every((body) => body.p_status === "delivered")).toBe(true);
  });

  it("bounds settlement work even when email is not configured", async () => {
    const timed = timedQueue({ schedulerMs: 19_000, rpcMs: 7_999, emailMs: 0, emailConfigured: false });
    const res = response();
    await handler({ method: "GET", headers: CRON }, res);
    expect(timed.elapsed()).toBeLessThan(60_000);
    expect(timed.calls.some((call) => call.url === "https://api.resend.com/emails")).toBe(false);
    expect(res.payload.deliveries.notConfigured).toBeGreaterThan(0);
    expect(res.payload.deliveries.notConfigured).toBe(completions(timed.calls).length);
    expect(timed.queue.length + completions(timed.calls).length).toBe(25);
    expect(timed.queue.length).toBeGreaterThan(0);
  });

  it("delivers a full bounded batch when dependencies answer quickly", async () => {
    const timed = timedQueue({ schedulerMs: 1, rpcMs: 1, emailMs: 1 });
    const res = response();
    await handler({ method: "GET", headers: CRON }, res);
    expect(res.payload.deliveries).toEqual({ delivered: 25, notConfigured: 0, failed: 0 });
    expect(timed.queue).toEqual([]);
    expect(completions(timed.calls)).toHaveLength(25);
  });

  it("starts no send or settlement after a paused claim exhausts the invocation budget", async () => {
    // A delayed continuation can resume after the deadline even though the
    // claim was admitted with enough time. The claimed row keeps its lease.
    const timed = timedQueue({ schedulerMs: 1, rpcMs: 1, emailMs: 1, claimPauseMs: 55_000 });
    const res = response();
    await handler({ method: "GET", headers: CRON }, res);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ ok: true, processed: 25, deliveries: null, error: "delivery_worker_unavailable" });
    expect(timed.calls.map((call) => call.url)).toEqual([
      "https://production-example.supabase.co/rest/v1/rpc/run_due_organization_coordination_exports",
      "https://production-example.supabase.co/rest/v1/rpc/claim_organization_export_deliveries",
    ]);
    expect(timed.calls[1].body).toEqual({ p_limit: 1 });
    expect(timed.queue).toHaveLength(24);
    expect(timed.elapsed()).toBe(55_002);
  });

  it("emails the schedule owner a sign-in link, never the data, and settles SFTP as not configured", async () => {
    Object.assign(process.env, BASE_ENV, { RESEND_API_KEY: "re_test", NOTIFY_FROM_ADDRESS: "Union Ground <no-reply@example.invalid>" });
    const calls = stubFetch();
    const res = response();
    await handler({ method: "GET", headers: CRON }, res);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ ok: true, processed: 1, deliveries: { delivered: 1, notConfigured: 1, failed: 1 } });
    const emails = calls.filter((call) => call.url === "https://api.resend.com/emails");
    expect(emails).toHaveLength(1);
    expect(emails[0].headers["Idempotency-Key"]).toBe("organization-export-run-email");
    expect(emails[0].body.to).toEqual(["owner@example.invalid"]);
    expect(emails[0].body.subject).toContain("eventos");
    // The backend is used only as an approved pair (api/_lib/providerBoundary.js),
    // so the notice's one link is that pair's own portal sign-in page.
    expect(emails[0].body.text.match(/https?:\/\/\S+/g)).toEqual(["https://app.unionground.test/m/coordination"]);
    expect(emails[0].body.text).not.toContain("unionground.net");
    expect(emails[0].body.text).toContain("no contiene los datos exportados");
    expect(emails[0].body).not.toHaveProperty("attachments");
    expect(completions(calls)).toEqual([
      { p_run_id: "run-email", p_status: "delivered", p_note: null },
      { p_run_id: "run-sftp", p_status: "not_configured", p_note: "sftp_transport_unavailable" },
      { p_run_id: "run-nobody", p_status: "failed", p_note: "no_recipient" },
    ]);
  });

  it("records the honest not-configured state when the operator has not set up email", async () => {
    Object.assign(process.env, BASE_ENV, { RESEND_API_KEY: "", NOTIFY_FROM_ADDRESS: "" });
    const calls = stubFetch();
    await handler({ method: "GET", headers: CRON }, response());
    expect(calls.some((call) => call.url === "https://api.resend.com/emails")).toBe(false);
    expect(completions(calls).map((body) => [body.p_run_id, body.p_status, body.p_note])).toEqual([
      ["run-email", "not_configured", "email_transport_unset"],
      ["run-sftp", "not_configured", "sftp_transport_unavailable"],
      ["run-nobody", "not_configured", "email_transport_unset"],
    ]);
  });

  it("marks a refused email as failed", async () => {
    Object.assign(process.env, BASE_ENV, { RESEND_API_KEY: "re_test", NOTIFY_FROM_ADDRESS: "no-reply@example.invalid" });
    const calls = stubFetch({ resendOk: false });
    await handler({ method: "GET", headers: CRON }, response());
    expect(completions(calls)[0]).toEqual({ p_run_id: "run-email", p_status: "failed", p_note: "email_send_failed" });
  });

  it("still answers the tick when only the delivery worker is unavailable", async () => {
    Object.assign(process.env, BASE_ENV);
    stubFetch({ claimFails: true });
    const res = response();
    await handler({ method: "GET", headers: CRON }, res);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ ok: true, processed: 1, deliveries: null, error: "delivery_worker_unavailable" });
  });

  it("writes a notice that names the dataset and the deadline and carries no data", () => {
    const message = exportReadyEmail({ dataset: "members_directory", organizationName: "Org\nA", expiresAt: "2026-10-03T16:00:00Z", lang: "en" });
    expect(message.subject).toBe("Your scheduled members directory export is ready");
    expect(message.text).toContain("for Org A is ready");
    expect(message.text).toContain("12:00");
    expect(message.text).toContain("This email does not contain the exported data.");
    const fallback = exportReadyEmail({ dataset: "unknown", organizationName: "", expiresAt: "not-a-date", lang: "fr" });
    expect(fallback.subject).toContain("coordination records");
    expect(fallback.text).toContain("Sign in to download it.");
    expect(deliveryOutcome({ deliveryMode: "email_unset", recipient: { email: "a@example.invalid" } }, true)).toBeNull();
  });
});
