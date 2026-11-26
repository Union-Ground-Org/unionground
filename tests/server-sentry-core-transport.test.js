// @vitest-environment node
// OPS-UG-SERVER-SENTRY-NODE-CORE-LIGHT-20261113: the server functions
// report through @sentry/core's server client instead of @sentry/node. This
// runs the real client, privacy options and private transport, with only the
// network call replaced, and checks what would reach Sentry's ingest.
import { afterEach, describe, expect, it, vi } from "vitest";
import { flush } from "@sentry/core";

const DSN = `https://${"a".repeat(32)}@o0.ingest.us.sentry.io/1`;
const RELEASE = "c".repeat(40);

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("server error reporting through the core client", () => {
  it("posts one scrubbed error envelope from a function failure to the DSN's ingest URL", async () => {
    vi.stubEnv("SENTRY_DSN", DSN);
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", RELEASE);
    vi.stubEnv("POSTHOG_PROJECT_TOKEN", "");
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const { captureServerFailure } = await import("../api/_lib/observability.js");

    expect(captureServerFailure(404)).toBe(false);
    expect(captureServerFailure(503)).toBe(true);
    await flush(2000);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(url).origin + new URL(url).pathname).toBe("https://o0.ingest.us.sentry.io/api/1/envelope/");
    expect(init.method).toBe("POST");
    const [header, itemHeader, event, ...rest] = String(init.body).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(rest).toEqual([]);
    const sdk = { name: "sentry.javascript.unionground-private-errors", version: "1.0.0", settings: { infer_ip: "never" } };
    // The SDK puts the DSN on the header only for a tunnel, which is not set.
    expect(header).toEqual({ event_id: event.event_id, sent_at: expect.any(String), sdk });
    expect(itemHeader).toMatchObject({ type: "event" });
    // Only the allowlisted fields: no server name, runtime, contexts, modules,
    // request, breadcrumbs or SDK integration list from the core client.
    expect(Object.keys(event).sort()).toEqual(["environment", "event_id", "exception", "level", "message", "platform", "release", "sdk", "tags", "timestamp", "user"]);
    expect(event).toMatchObject({ level: "error", message: "Application error", platform: "node", environment: "preview", release: RELEASE,
      tags: { surface: "api" }, user: { geo: { lookup: "disabled" } }, sdk });
    expect(event.exception.values).toHaveLength(1);
    expect(event.exception.values[0]).toMatchObject({ type: "Error", value: "Application error" });
    const frames = event.exception.values[0].stacktrace.frames;
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.filename).toBe("app:///application");
      expect(Object.keys(frame).every((key) => ["filename", "lineno", "colno", "in_app"].includes(key))).toBe(true);
    }
  });

  it("honours Sentry's rate limit headers and survives a response body that cannot be read", async () => {
    vi.stubEnv("SENTRY_DSN", DSN);
    const fetch = vi.fn(async () => ({
      status: 429,
      headers: new Headers({ "x-sentry-rate-limits": "60:error:organization", "retry-after": "60" }),
      arrayBuffer: () => Promise.reject(new Error("connection reset")),
    }));
    vi.stubGlobal("fetch", fetch);
    const { captureServerFailure } = await import("../api/_lib/observability.js");
    expect(captureServerFailure(500)).toBe(true);
    await flush(2000);
    expect(fetch).toHaveBeenCalledTimes(1);
    // The core transport read the limit from the returned headers and drops
    // the next error locally instead of sending it.
    expect(captureServerFailure(502)).toBe(true);
    await flush(2000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // Gate stage 203 (r2s2): the rate-limit headers reach the core transport
  // before the body is read, so a body that never finishes cannot hold the
  // backoff back; the body is cancelled, not waited for.
  it("applies Sentry's rate limit at once when the response body stalls, and cancels that body", async () => {
    vi.stubEnv("SENTRY_DSN", DSN);
    const cancel = vi.fn();
    const fetch = vi.fn(async () => new Response(new ReadableStream({ start() {}, cancel }), {
      status: 429,
      headers: { "x-sentry-rate-limits": "60:error:organization", "retry-after": "60" },
    }));
    vi.stubGlobal("fetch", fetch);
    // A fresh client: the test before this one left its own rate limit behind.
    vi.resetModules();
    const { captureServerFailure } = await import("../api/_lib/observability.js");
    expect(captureServerFailure(500)).toBe(true);
    expect(await flush(500)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(captureServerFailure(502)).toBe(true);
    expect(await flush(500)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
