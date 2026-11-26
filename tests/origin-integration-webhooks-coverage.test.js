// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import webhookHandler from "../api/integration-webhooks.js";
import dispatchHandler from "../api/integration-webhooks-dispatch.js";
import { pinnedSampleSupabaseOrigin } from "../src/lib/sampleBackend.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SAMPLE_HOST, SAMPLE_ORIGIN, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
import { unauthenticatedCronTickHeaders, vercelCronTickHeaders } from "./helpers/vercelCronTick.js";

const backendUrl = SUPABASE_ORIGIN;
const dispatchSecret = "fixture-dispatch-".repeat(3);
const sampleSecret = "fixture-sample-dispatch-".repeat(3);
const webhookId = "12345678-1234-1234-1234-123456789abc";
const body = { webhookId, eventName: "integration.test" };
// An IP literal ensures the real destination validator rejects before DNS or
// HTTPS; only the external Supabase fetch boundary is replaced in these tests.
const claim = { deliveryId: "fixture-delivery", attemptCount: 1, url: "https://127.0.0.1/private", eventId: "test:fixture", eventName: "integration.test" };
let fetcher;

function reply(value, status = 200) { return new Response(JSON.stringify(value), { status }); }

async function invoke(handler = webhookHandler, request = {}) {
  const response = {
    statusCode: 0, headers: {}, body: undefined,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(value) { this.body = JSON.parse(value); },
  };
  await handler({ method: "POST", body, ...request, headers: {
    host: PORTAL_HOST, origin: PORTAL_ORIGIN, authorization: "Bearer fixture-user", ...request.headers,
  } }, response);
  expect(response.headers["Cache-Control"]).toBe("no-store");
  return response;
}

function dispatch(request = {}) {
  return invoke(dispatchHandler, { ...request, headers: { authorization: `Bearer ${dispatchSecret}`, ...request.headers } });
}

function authenticated() { fetcher.mockResolvedValueOnce(reply({ id: "fixture-user" })); }
function queued() { authenticated(); fetcher.mockResolvedValueOnce(reply({ deliveryId: "fixture-delivery" })); }
function assertServiceCall(index, rpc, payload) {
  const [url, options] = fetcher.mock.calls[index];
  expect(url).toBe(`${backendUrl}/rest/v1/rpc/${rpc}`);
  expect(options.headers.apikey).toBe("sb_secret_fixture");
  expect(options.headers.Authorization).toBeUndefined();
  expect(JSON.parse(options.body)).toEqual(payload);
}

beforeEach(() => {
  for (const [key, value] of Object.entries({
    VITE_SUPABASE_URL: backendUrl, UNIONGROUND_SUPABASE_PROJECT_REF: SUPABASE_REF, VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_fixture", INTEGRATION_DISPATCH_SECRET: dispatchSecret,
    SAMPLE_INTEGRATION_DISPATCH_SECRET: sampleSecret, SAMPLE_SUPABASE_URL: pinnedSampleSupabaseOrigin(),
    SAMPLE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_sample_fixture", SAMPLE_SUPABASE_SERVICE_ROLE_KEY: "sb_secret_sample_fixture",
    CRON_SECRET: "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx",
  })) vi.stubEnv(key, value);
  fetcher = vi.fn(() => { throw new Error("Unexpected external request"); });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("webhook test endpoint behavior behind the Origin boundary", () => {
  it.each([
    [{ headers: { origin: "https://attacker.invalid" } }, 403, { error: "untrusted-origin" }],
    [{ method: "GET" }, 405, { ok: false }],
    [{ headers: { authorization: "" } }, 401, { ok: false }],
  ])("rejects invalid access before external work (%j)", async (request, status, payload) => {
    expect(await invoke(webhookHandler, request)).toMatchObject({ statusCode: status, body: payload });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires complete backend configuration", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(await invoke()).toMatchObject({ statusCode: 503, body: { ok: false } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not enqueue an invalid authentication token", async () => {
    fetcher.mockResolvedValueOnce(reply({ error: "invalid" }, 401));
    expect(await invoke()).toMatchObject({ statusCode: 401, body: { ok: false } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(`${backendUrl}/auth/v1/user`);
  });

  it.each([
    undefined, null, "null", "{broken", "true", "42", '"text"', "[]", [], true, 42,
    Object.assign([], body), { webhookId }, { webhookId: "wrong", eventName: "integration.test" },
  ].map((value) => [value]))("validates the body before enqueue (%j)", async (invalidBody) => {
    authenticated();
    expect(await invoke(webhookHandler, { body: invalidBody })).toMatchObject({ statusCode: 400, body: { ok: false, reason: "invalid_request" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([[400, 400], [401, 403], [403, 403], [408, 503], [422, 400], [429, 503], [500, 503], [503, 503]])("maps enqueue failure %i without attempting a claim", async (upstream, status) => {
    authenticated();
    fetcher.mockResolvedValueOnce(reply({ error: "private details" }, upstream));
    expect(await invoke()).toMatchObject({ statusCode: status, body: { ok: false, reason: "enqueue_failed" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    new TypeError("dependency connection failed"),
    new DOMException("dependency request timed out", "TimeoutError"),
    new SyntaxError("dependency response was unreadable"),
  ])("reports an unavailable enqueue dependency without retrying (%s)", async (error) => {
    authenticated();
    fetcher.mockRejectedValueOnce(error);
    expect(await invoke()).toMatchObject({ statusCode: 503, body: { ok: false, reason: "enqueue_failed" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0]).toBe(`${backendUrl}/rest/v1/rpc/enqueue_integration_webhook_test`);
  });

  it.each([body, JSON.stringify(body)])("enqueues object and JSON-text envelopes under the member token (%j)", async (validBody) => {
    queued();
    fetcher.mockResolvedValueOnce(reply(null));
    expect(await invoke(webhookHandler, { body: validBody })).toMatchObject({ statusCode: 202, body: { ok: true, deliveryId: "fixture-delivery", status: "queued" } });
    const [url, options] = fetcher.mock.calls[1];
    expect(url).toBe(`${backendUrl}/rest/v1/rpc/enqueue_integration_webhook_test`);
    expect(options.headers.Authorization).toBe("Bearer fixture-user");
    expect(options.headers.apikey).toBe("sb_publishable_fixture");
    expect(JSON.parse(options.body)).toEqual({ p_webhook_id: webhookId, p_event_name: "integration.test", p_event_id: expect.stringMatching(/^test:[0-9a-f-]{36}$/) });
    assertServiceCall(2, "claim_integration_webhook_delivery", { p_delivery_id: "fixture-delivery" });
  });

  it("records an unsafe destination as blocked using the claimed lease", async () => {
    queued();
    fetcher.mockResolvedValueOnce(reply(claim)).mockResolvedValueOnce(reply(true));
    expect(await invoke()).toMatchObject({ statusCode: 200, body: { ok: true, deliveryId: "fixture-delivery", status: "blocked" } });
    assertServiceCall(3, "record_integration_webhook_delivery", {
      p_delivery_id: claim.deliveryId, p_attempt_count: 1, p_status: "blocked", p_error_code: "unsafe_destination_resolution", p_destination_host: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each(["claim", "record"])("preserves committed queue state after %s failure without enqueueing twice", async (stage) => {
    queued();
    if (stage === "record") fetcher.mockResolvedValueOnce(reply(claim));
    fetcher.mockResolvedValueOnce(reply({ error: "private details" }, 500));
    expect(await invoke()).toMatchObject({ statusCode: 202, body: { ok: true, deliveryId: "fixture-delivery", status: "queued" } });
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("enqueue_integration_webhook_test"))).toHaveLength(1);
  });
});

describe("webhook dispatcher behavior behind the Origin boundary", () => {
  it.each([
    [{ headers: { origin: "https://attacker.invalid" } }, 403, "untrusted-origin"],
    [{ method: "DELETE" }, 405, "method_not_allowed"],
    [{ headers: { authorization: "Bearer wrong" } }, 401, "unauthorized"],
    [{ headers: { authorization: "", "x-vercel-cron": "1" } }, 401, "unauthorized"],
    [{ method: "GET", headers: { origin: undefined, authorization: "", ...unauthenticatedCronTickHeaders("15 12 * * *") } }, 401, "unauthorized"],
    [{ method: "GET", headers: { origin: undefined, ...vercelCronTickHeaders("not-the-cron-secret", "15 12 * * *"), "x-vercel-cron": "1" } }, 401, "unauthorized"],
  ])("rejects invalid dispatch access (%j)", async (request, status, error) => {
    expect(await dispatch(request)).toMatchObject({ statusCode: status, body: { error } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects colliding secrets even for a valid dispatcher token", async () => {
    vi.stubEnv("SAMPLE_INTEGRATION_DISPATCH_SECRET", dispatchSecret);
    expect(await dispatch()).toMatchObject({ statusCode: 503, body: { ok: false, error: "dispatch_secret_isolation_required" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects short or missing dispatch secrets", async () => {
    vi.stubEnv("INTEGRATION_DISPATCH_SECRET", "short");
    expect(await dispatch({ headers: { authorization: "Bearer short" } })).toMatchObject({ statusCode: 401, body: { error: "unauthorized" } });
    vi.stubEnv("INTEGRATION_DISPATCH_SECRET", "");
    expect(await dispatch({ headers: { authorization: "" } })).toMatchObject({ statusCode: 401, body: { error: "unauthorized" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires backend credentials after authenticating the dispatcher", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(await dispatch()).toMatchObject({ statusCode: 503, body: { ok: false, error: "not_configured" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses the sample host before any backend access because Union Ground trusts no sample portal", async () => {
    const headers = { host: SAMPLE_HOST, origin: SAMPLE_ORIGIN, authorization: `Bearer ${sampleSecret}` };
    expect(await dispatch({ headers })).toMatchObject({ statusCode: 403, body: { error: "untrusted-origin" } });
    expect(await dispatch({ headers: { ...headers, authorization: `Bearer ${dispatchSecret}` } })).toMatchObject({ statusCode: 403, body: { error: "untrusted-origin" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts the documented Vercel cron GET (the CRON_SECRET bearer, no x-vercel-cron marker) without browser Origin", async () => {
    fetcher.mockResolvedValueOnce(reply([]));
    expect(await dispatch({ method: "GET", headers: { origin: undefined, ...vercelCronTickHeaders("cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx", "15 12 * * *") } })).toMatchObject({ statusCode: 200, body: { ok: true, claimed: 0, delivered: 0, failed: 0 } });
    assertServiceCall(0, "claim_integration_webhook_deliveries", { p_limit: 1 });
  });

  it.each([[], null])("reports no delivery when the claim has no row", async (claims) => {
    fetcher.mockResolvedValueOnce(reply(claims));
    expect(await dispatch()).toMatchObject({ statusCode: 200, body: { ok: true, claimed: 0, delivered: 0, failed: 0 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports a claim failure before any row was delivered", async () => {
    fetcher.mockResolvedValueOnce(reply({ error: "private details" }, 500));
    expect(await dispatch()).toMatchObject({ statusCode: 502, body: { ok: false, error: "claim_failed" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("records a blocked destination before claiming the next row and reports partial failure", async () => {
    fetcher.mockResolvedValueOnce(reply([claim])).mockResolvedValueOnce(reply(true)).mockResolvedValueOnce(reply([]));
    expect(await dispatch()).toMatchObject({ statusCode: 207, body: { ok: false, claimed: 1, delivered: 0, failed: 1 } });
    assertServiceCall(0, "claim_integration_webhook_deliveries", { p_limit: 1 });
    assertServiceCall(1, "record_integration_webhook_delivery", {
      p_delivery_id: claim.deliveryId, p_attempt_count: claim.attemptCount, p_status: "blocked", p_error_code: "unsafe_destination_resolution", p_destination_host: null,
    });
    assertServiceCall(2, "claim_integration_webhook_deliveries", { p_limit: 1 });
  });

  it("retains completed outcomes when a later claim fails", async () => {
    fetcher.mockResolvedValueOnce(reply([claim])).mockResolvedValueOnce(reply(true)).mockResolvedValueOnce(reply({}, 500));
    expect(await dispatch()).toMatchObject({ statusCode: 207, body: { ok: false, claimed: 1, delivered: 0, failed: 1 } });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([false, { error: "record failure" }])("counts an unrecorded outcome as a failure", async (recorded) => {
    fetcher.mockResolvedValueOnce(reply([claim])).mockResolvedValueOnce(reply(recorded)).mockResolvedValueOnce(reply([]));
    expect(await dispatch()).toMatchObject({ statusCode: 207, body: { ok: false, claimed: 1, delivered: 0, failed: 1 } });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("caps an invocation at ten individually claimed and recorded deliveries", async () => {
    for (let i = 0; i < 10; i += 1) {
      fetcher.mockResolvedValueOnce(reply([{ ...claim, deliveryId: `fixture-delivery-${i}` }])).mockResolvedValueOnce(reply(true));
    }
    expect(await dispatch()).toMatchObject({ statusCode: 207, body: { ok: false, claimed: 10, delivered: 0, failed: 10 } });
    expect(fetcher).toHaveBeenCalledTimes(20);
    for (let i = 0; i < 10; i += 1) {
      expect(JSON.parse(fetcher.mock.calls[i * 2][1].body)).toEqual({ p_limit: 1 });
      expect(JSON.parse(fetcher.mock.calls[i * 2 + 1][1].body).p_delivery_id).toBe(`fixture-delivery-${i}`);
    }
  });

  it("stops claiming at the invocation reserve threshold before the ten-item cap", async () => {
    // Restated from api/integration-webhooks-dispatch.js:6-7. The cutoff is
    // independent of the ten-item loop bound; this case must fail if that
    // wall-clock check is deleted or inverted.
    const INVOCATION_BUDGET_MS = 230_000;
    const RESULT_RESERVE_MS = 20_000;
    const startedAt = 1_700_000_000_000;
    let now = startedAt;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      fetcher.mockResolvedValueOnce(reply([claim])).mockImplementationOnce(() => {
        now = startedAt + INVOCATION_BUDGET_MS - RESULT_RESERVE_MS;
        return reply(true);
      });
      expect(await dispatch()).toMatchObject({
        statusCode: 207,
        body: { ok: false, claimed: 1, delivered: 0, failed: 1 },
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
      assertServiceCall(0, "claim_integration_webhook_deliveries", { p_limit: 1 });
      assertServiceCall(1, "record_integration_webhook_delivery", {
        p_delivery_id: claim.deliveryId, p_attempt_count: claim.attemptCount, p_status: "blocked", p_error_code: "unsafe_destination_resolution", p_destination_host: null,
      });
      expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("claim_integration_webhook_deliveries"))).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });
});
