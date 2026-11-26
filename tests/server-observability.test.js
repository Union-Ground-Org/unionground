import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { posthogExceptionSchemaErrors } from "./helpers/posthogExceptionSchema.mjs";
import { PORTAL_ORIGIN } from "./helpers/fictional-provider.js";

const sdk = vi.hoisted(() => ({ applySdkMetadata: vi.fn(), initAndBind: vi.fn(), captureException: vi.fn(), flush: vi.fn(async () => true), createTransport: vi.fn(), createStackParser: vi.fn() }));
const server = vi.hoisted(() => ({ ServerRuntimeClient: function ServerRuntimeClient() {}, nodeStackLineParser: vi.fn() }));
const waitUntil = vi.hoisted(() => vi.fn());
// posthog-node is observed through its constructor and client methods only.
const posthog = vi.hoisted(() => {
  const client = { captureException: vi.fn(), flush: vi.fn(async () => true) };
  const PostHog = vi.fn(function PostHogClient(token, options) { this.token = token; this.options = options; Object.assign(this, client); });
  return { PostHog, client };
});
vi.mock("@sentry/core", () => sdk);
vi.mock("@sentry/core/server", () => server);
vi.mock("posthog-node", () => ({ PostHog: posthog.PostHog }));
vi.mock("@vercel/functions", () => ({ waitUntil }));

describe("API monitoring", () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.stubEnv("POSTHOG_PROJECT_TOKEN", ""); vi.stubEnv("POSTHOG_HOST", ""); });
  afterEach(() => vi.unstubAllEnvs());

  it("is a no-op without the explicit server DSN and ignores the web DSN", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("VITE_SENTRY_DSN", "https://public@o0.ingest.us.sentry.io/1");
    const { captureServerFailure } = await import("../api/_lib/observability.js");
    expect(captureServerFailure(500)).toBe(false);
    expect(sdk.initAndBind).not.toHaveBeenCalled();
    expect(sdk.captureException).not.toHaveBeenCalled();
  });

  it("reports only 5xx failures, with no response payload, and retains the serverless flush", async () => {
    vi.stubEnv("SENTRY_DSN", "https://public@o0.ingest.us.sentry.io/1");
    const { json } = await import("../api/_lib/http.js");
    const response = { status: vi.fn().mockReturnThis(), setHeader: vi.fn().mockReturnThis(), end: vi.fn() };
    const payload = { memberId: "member-private-id", message: "Taylor Example medical grievance" };
    json(response, 503, payload);
    expect(response.end).toHaveBeenCalledWith(JSON.stringify(payload));
    expect(sdk.captureException).toHaveBeenCalledTimes(1);
    expect(sdk.captureException.mock.calls[0][0].message).toBe("Application error");
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
    // The core server client with no integrations, not @sentry/node and its OpenTelemetry stack.
    expect(sdk.initAndBind.mock.calls[0][0]).toBe(server.ServerRuntimeClient);
    expect(sdk.initAndBind.mock.calls[0][1]).toMatchObject({ sendDefaultPii: false, tracesSampleRate: 0, integrations: [], platform: "node" });
    json(response, 403, payload);
    expect(sdk.captureException).toHaveBeenCalledTimes(1);
  });

  it("keeps the response intact if monitoring initialization fails", async () => {
    vi.stubEnv("SENTRY_DSN", "https://public@o0.ingest.us.sentry.io/1");
    sdk.initAndBind.mockImplementationOnce(() => { throw new Error("monitoring unavailable"); });
    const { json } = await import("../api/_lib/http.js");
    const response = { status: vi.fn().mockReturnThis(), setHeader: vi.fn().mockReturnThis(), end: vi.fn() };
    expect(() => json(response, 500, { error: "unavailable" })).not.toThrow();
    expect(response.end).toHaveBeenCalledWith('{"error":"unavailable"}');
  });

  it("never serializes native Error objects in production responses", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { json } = await import("../api/_lib/http.js");
    const response = { status: vi.fn().mockReturnThis(), setHeader: vi.fn(), end: vi.fn() };
    let failure;
    try { throw new Error("private provider details"); } catch (error) { failure = error; }
    expect(failure.stack).toContain("private provider details");
    // A custom serializer and an enumerable stack must not bypass the boundary.
    Object.defineProperty(failure, "stack", { enumerable: true });
    failure.toJSON = () => ({ details: failure.stack });
    for (const payload of [failure, { error: failure }, {
      error: "unavailable", details: [failure],
    }]) {
      json(response, 502, payload);
      expect(response.end.mock.lastCall[0]).not.toMatch(/private|server-observability|frames|stack/);
    }
    expect(JSON.parse(response.end.mock.lastCall[0])).toEqual({ error: "unavailable", details: [{ error: "internal-server-error" }] });
    json(response, 502, { error: failure });
    expect(JSON.parse(response.end.mock.lastCall[0])).toEqual({ error: { error: "internal-server-error" } });
  });

  it.each([
    { stack: "answer", stacktrace: "another answer" },
    { answers: { stack: "answer", nested: [{ stacktrace: "nested answer" }] } },
    { name: "form field", stack: "answer" },
    { message: "form field", stack: "answer" },
    { name: "form field", message: "answer", stack: 42 },
    { name: 42, message: "answer", stack: "form field" },
    { name: "form field", message: 42, stack: "answer" },
    { name: "form field", message: "answer", stacktrace: "form field" },
    { name: "form field", message: "answer", stack: null },
    { name: "Error", message: "Member-supplied answer", stack: "Chosen equipment stack" },
    { name: "Error", message: "Member-supplied answer", stack: "Chosen equipment stack", stacktrace: "Another answer", notes: "Extra field" },
    { answers: [{ name: "Error", message: "Member-supplied answer", stack: "Chosen equipment stack" }] },
    { name: "Error", message: "Member-supplied answer", stack: "Chosen equipment stack", [Symbol.toStringTag]: "Error" },
  ])("preserves plain domain objects regardless of error-like keys or a spoofed tag %#", async (payload) => {
    const { json } = await import("../api/_lib/http.js");
    const response = { status: vi.fn().mockReturnThis(), setHeader: vi.fn(), end: vi.fn() };
    json(response, 200, payload);
    expect(response.end).toHaveBeenCalledWith(JSON.stringify(payload));
  });

  it("never invokes an Error serializer, including foreign-realm errors and errors inside arrays", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { json } = await import("../api/_lib/http.js");
    const { runInNewContext } = await import("node:vm");
    const failure = runInNewContext('new Error("private foreign provider details")');
    expect(failure).not.toBeInstanceOf(Error);
    failure.toJSON = vi.fn(() => { throw new Error("private serializer must never run"); });
    const response = { status: vi.fn().mockReturnThis(), setHeader: vi.fn(), end: vi.fn() };
    expect(() => json(response, 502, { failures: [failure] })).not.toThrow();
    expect(failure.toJSON).not.toHaveBeenCalled();
    expect(JSON.parse(response.end.mock.lastCall[0])).toEqual({ failures: [{ error: "internal-server-error" }] });
  });

  it("preserves ordinary JSON data, dates, repeated references, and array holes", async () => {
    const { json } = await import("../api/_lib/http.js");
    const response = { status: vi.fn().mockReturnThis(), setHeader: vi.fn(), end: vi.fn() };
    const shared = { id: "record-1", text: "ordinary content", optional: undefined };
    const payload = { records: [shared, shared], gaps: new Array(2), when: new Date("2026-11-05T12:00:00Z"), invalidDate: new Date("invalid"), count: 2, ok: true, empty: null };
    json(response, 200, payload);
    expect(response.end).toHaveBeenCalledWith(JSON.stringify(payload));
    expect(() => json(response, 200, { circular: (() => { const x = {}; x.self = x; return x; })() })).toThrow(TypeError);
  });

  it("preserves scalar and unsupported-value JSON semantics without executing serialization hooks", async () => {
    const { json } = await import("../api/_lib/http.js");
    const response = { status: vi.fn().mockReturnThis(), setHeader: vi.fn(), end: vi.fn() };
    for (const payload of [null, "text", 0, -0, 1.25, NaN, Infinity, -Infinity, true, false,
      undefined, Symbol("omitted"), () => "omitted"]) {
      json(response, 200, payload);
      expect(response.end.mock.lastCall[0]).toBe(JSON.stringify(payload));
    }
    expect(() => json(response, 200, 1n)).toThrow("Do not know how to serialize a BigInt");
    const toJSON = vi.fn(() => { throw new Error("a serialization hook must not execute"); });
    json(response, 200, {
      label: "visible", toJSON, callback: () => "omitted", optional: undefined,
      symbol: Symbol("omitted"), entries: [undefined, Symbol("omitted"), () => "omitted", false],
    });
    expect(toJSON).not.toHaveBeenCalled();
    expect(JSON.parse(response.end.mock.lastCall[0])).toEqual({ label: "visible", entries: [null, null, null, false] });
  });

  it("reuses initialization and settles a rejected serverless flush without changing the response", async () => {
    vi.stubEnv("SENTRY_DSN", "https://public@o0.ingest.us.sentry.io/1");
    vi.stubEnv("VERCEL_ENV", "preview");
    sdk.flush.mockRejectedValueOnce(new Error("transport unavailable"));
    const { captureServerFailure } = await import("../api/_lib/observability.js");
    expect(captureServerFailure(502)).toBe(true);
    await expect(waitUntil.mock.calls[0][0]).resolves.toBe(false);
    expect(captureServerFailure(503)).toBe(true);
    expect(sdk.initAndBind).toHaveBeenCalledTimes(1);
    expect(sdk.captureException).toHaveBeenCalledTimes(2);
    expect(sdk.flush).toHaveBeenCalledWith(2000);
    await expect(waitUntil.mock.calls[1][0]).resolves.toBe(true);
  });
});

describe("API monitoring through PostHog error tracking", () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.stubEnv("SENTRY_DSN", ""); });
  afterEach(() => vi.unstubAllEnvs());

  it("is a no-op without the server token and a relay host over https", async () => {
    vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_fixture");
    vi.stubEnv("POSTHOG_HOST", "http://e.unionground.net");
    const { captureServerFailure, initServerPosthog } = await import("../api/_lib/observability.js");
    expect(initServerPosthog()).toBe(false);
    expect(captureServerFailure(500)).toBe(false);
    expect(posthog.PostHog).not.toHaveBeenCalled();
  });

  it("reports a 5xx as the fixed error under the diagnostics identity, with the scrubber and the private fetch installed, independent of Sentry", async () => {
    vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_fixture");
    vi.stubEnv("POSTHOG_HOST", "https://e.unionground.net");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "b".repeat(40));
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    const { captureServerFailure } = await import("../api/_lib/observability.js");
    expect(captureServerFailure(503)).toBe(true);
    expect(captureServerFailure(404)).toBe(false);
    expect(posthog.PostHog).toHaveBeenCalledTimes(1);
    const [token, options] = posthog.PostHog.mock.calls[0];
    expect(token).toBe("phc_fixture");
    expect(options).toMatchObject({ host: "https://e.unionground.net", flushAt: 1, flushInterval: 0, disableCompression: true, disableGeoip: true, enableExceptionAutocapture: false, featureFlagsPollingInterval: 0 });
    expect(typeof options.fetch).toBe("function");
    expect(posthog.client.captureException).toHaveBeenCalledTimes(1);
    const [error, distinctId, properties] = posthog.client.captureException.mock.calls[0];
    expect(error.message).toBe("Application error");
    expect(distinctId).toBe("diagnostics");
    expect(properties).toEqual({ surface: "api" });
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
    expect(sdk.captureException).not.toHaveBeenCalled();
    // The scrubber leaves only the allowlisted properties, tagged for the API surface.
    const clean = options.before_send({ event: "$exception", distinct_id: "diagnostics", properties: { $exception_list: [{ type: "Error", value: "Application error: member 42" }], $lib: "posthog-node", $lib_version: "5.57.2", $ip: "203.0.113.9", $current_url: `${PORTAL_ORIGIN}/api/x`, surface: "api" } });
    expect(clean.properties).toEqual({ $exception_list: [{ type: "Error", value: "Application error" }], $exception_level: "error", $process_person_profile: false, $geoip_disable: true, distinct_id: "diagnostics", $lib: "posthog-node", $lib_version: "5.57.2", surface: "api", deployment_environment: "production", release: "b".repeat(40) });
    expect(options.before_send({ event: "$pageview", properties: {} })).toBeNull();
    // posthog-node's Node frames keep PostHog's required file and function
    // fields as fixed placeholders, so the event is processable (#6826).
    const framed = options.before_send({ event: "$exception", properties: { $exception_list: [{ type: "Error", value: "Application error", mechanism: { type: "generic", handled: true }, stacktrace: { type: "raw", frames: [
      { platform: "node:javascript", filename: "/var/task/api/_lib/members.js", function: "loadMember(Taylor)", module: "members", lineno: 12, colno: 5, in_app: true, context_line: "const name = 'Taylor';", pre_context: ["// Taylor"] },
      { platform: "node:javascript", filename: "node:internal/process/task_queues", function: "process.processTicksAndRejections", lineno: 95, colno: 5, in_app: false },
    ] } }] } });
    expect(posthogExceptionSchemaErrors(framed)).toEqual([]);
    expect(framed.properties.$exception_list[0].stacktrace.frames).toEqual([
      { lineno: 12, colno: 5, in_app: true, filename: "app:///application", function: "?", platform: "node:javascript" },
      { lineno: 95, colno: 5, in_app: false, filename: "app:///application", function: "?", platform: "node:javascript" },
    ]);
    expect(JSON.stringify(framed)).not.toMatch(/Taylor|members|task_queues|processTicks/);
    // The private fetch only ever posts a rebuilt batch to the relay.
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => { calls.push([url, init]); return { status: 200, ok: true, text: async () => "{}" }; });
    const { privatePostHogFetch } = await import("../src/lib/posthogPrivacy.js");
    const send = privatePostHogFetch(fetchImpl, { surface: "api", environment: "production" });
    await send("https://e.unionground.net/batch/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: "phc_fixture", batch: [{ event: "$exception", properties: { $exception_list: [{ type: "Error" }], $ip: "203.0.113.9" } }] }) });
    expect(calls).toHaveLength(1);
    expect(calls[0][1].body).not.toContain("203.0.113.9");
  });
});
