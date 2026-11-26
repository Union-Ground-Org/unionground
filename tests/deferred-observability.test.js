import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PORTAL_HOST } from "./helpers/fictional-provider.js";

// PERF-UG-FIRST-PAINT-OBSERVABILITY-DEFER-AND-CSS-SPLIT-20261028: Sentry
// and PostHog load through a dynamic import after the authenticated shell
// commits (or on idle for public pages), never from the entry chunk, and calls
// made before then are queued with a bound and replayed in order.

const sdk = vi.hoisted(() => ({ init: vi.fn(), setUser: vi.fn(), captureException: vi.fn(), captureMessage: vi.fn(), makeFetchTransport: vi.fn() }));
vi.mock("@sentry/react", () => sdk);
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
vi.mock("posthog-js", () => ({ default: {} }));

// Modules main.jsx reaches through static imports.
function staticGraph() {
  const seen = new Set();
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const code = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
    for (const match of code.matchAll(/(?:^|[\n;])\s*(?:import|export)\s(?:[^;'"]*?\sfrom\s*)?["']([^"']+)["']/g)) {
      if (!match[1].startsWith(".")) { seen.add(match[1]); continue; }
      const target = join(dirname(path), match[1]);
      const file = [target, `${target}.js`, `${target}.jsx`].find((candidate) => {
        try { return readFileSync(candidate) && !candidate.endsWith(".css"); } catch { return false; }
      });
      if (file) visit(file);
    }
  };
  visit(resolve("src/main.jsx"));
  return seen;
}

describe("the entry chunk", () => {
  it("reaches no observability SDK or runtime through a static import", () => {
    const graph = [...staticGraph()];
    expect(graph.some((path) => path.endsWith("/src/AppRouter.jsx"))).toBe(true);
    expect(graph.some((path) => path.endsWith("/src/App.jsx"))).toBe(false);
    expect(graph.some((path) => path.endsWith("/src/lib/deferredObservability.js"))).toBe(true);
    expect(graph.filter((path) => path.endsWith("/src/lib/observability.js"))).toEqual([]);
    expect(graph.filter((path) => /^(?:@sentry\/|posthog-js|@posthog\/)/.test(path))).toEqual([]);
  });

  it("imports the runtime only from the deferred loader, which the shell commit starts", () => {
    const loader = readFileSync("src/lib/deferredObservability.js", "utf8");
    expect(loader).toContain('import("./observability.js")');
    expect(loader).not.toMatch(/from "\.\/observability\.js"/);
    const app = readFileSync("src/App.jsx", "utf8");
    expect(app).toMatch(/function ObservabilityStart\(\) \{\n {2}useEffect\(\(\) => \{ startObservability\(\); \}, \[\]\);/);
    // Rendered by the authenticated shell itself, not by a loading screen.
    expect(app.indexOf("<ObservabilityStart />")).toBeGreaterThan(app.indexOf('<a className="skip-link" href="#main-content">'));
    const main = readFileSync("src/main.jsx", "utf8");
    expect(main).toContain("bootObservability();");
    expect(main).not.toMatch(/initObservability|@posthog\/react|Sentry\./);
  });
});

describe("the deferred loader", () => {
  let runtime;
  let idle;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    idle = [];
    window.requestIdleCallback = vi.fn((callback) => { idle.push(callback); return idle.length; });
    runtime = {
      initObservability: vi.fn(),
      syncObservabilityContext: vi.fn(),
      captureProductAction: vi.fn(() => true),
      captureDemoAction: vi.fn(() => true),
      captureSanitizedDiagnostic: vi.fn(() => true),
      captureViewError: vi.fn(() => true),
      setDemoAnalyticsEnabled: vi.fn((enabled) => Boolean(enabled)),
      memberFeatureFlag: vi.fn(() => "test"),
      subscribeMemberFeatureFlags: vi.fn(),
      reportMemberFlagExposure: vi.fn(() => true),
      memberIdentitySettled: vi.fn(() => Promise.resolve()),
    };
  });

  afterEach(() => {
    vi.doUnmock("../src/lib/observability.js");
    delete window.requestIdleCallback;
    window.localStorage.clear();
    vi.unstubAllEnvs();
  });

  async function loader() {
    vi.doMock("../src/lib/observability.js", () => runtime);
    return import("../src/lib/deferredObservability.js");
  }

  it("holds a member's calls until the shell starts it, then replays them in order after init", async () => {
    const observability = await loader();
    const order = [];
    for (const name of ["initObservability", "syncObservabilityContext", "captureProductAction", "captureDemoAction"]) runtime[name].mockImplementation((...args) => { order.push([name, ...args]); return true; });
    observability.syncObservabilityContext({ userId: "member-1", authPending: false, view: "home" });
    observability.captureProductAction("save");
    observability.syncObservabilityContext({ userId: "member-1", authPending: false, view: "cases" });
    observability.captureDemoAction("open_guide", "cases");
    // Nothing loads for a member before the shell commits.
    expect(idle).toEqual([]);
    expect(order).toEqual([]);
    await observability.startObservability();
    expect(order).toEqual([
      ["initObservability"],
      ["syncObservabilityContext", { userId: "member-1", authPending: false, view: "home" }],
      ["captureProductAction", "save"],
      ["syncObservabilityContext", { userId: "member-1", authPending: false, view: "cases" }],
      ["captureDemoAction", "open_guide", "cases"],
    ]);
    // Loaded: later calls go straight through.
    observability.captureProductAction("queued_offline");
    expect(order.at(-1)).toEqual(["captureProductAction", "queued_offline"]);
    expect(runtime.initObservability).toHaveBeenCalledTimes(1);
  });

  it("loads on idle for a public page, and once an error needs reporting", async () => {
    const observability = await loader();
    observability.syncObservabilityContext({ userId: null, authPending: true });
    expect(idle).toHaveLength(0);
    observability.syncObservabilityContext({ userId: null, authPending: false, view: "signin" });
    expect(idle).toHaveLength(1);
    expect(runtime.initObservability).not.toHaveBeenCalled();
    await idle[0]();
    await vi.waitFor(() => expect(runtime.syncObservabilityContext).toHaveBeenCalledTimes(2));
    expect(runtime.initObservability).toHaveBeenCalledTimes(1);

    vi.resetModules();
    idle = [];
    const fresh = await loader();
    fresh.captureSanitizedDiagnostic({ kind: "boot_failed" });
    expect(idle).toHaveLength(1);
  });

  it("keeps at most the bound, dropping the oldest captures but never a context", async () => {
    const observability = await loader();
    observability.syncObservabilityContext({ userId: "member-1", authPending: false, view: "home" });
    for (let index = 0; index < observability.OBSERVABILITY_QUEUE_LIMIT + 20; index += 1) {
      observability.captureSanitizedDiagnostic({ kind: `failure_${index}` });
    }
    await observability.startObservability();
    expect(runtime.syncObservabilityContext).toHaveBeenCalledTimes(1);
    const kinds = runtime.captureSanitizedDiagnostic.mock.calls.map(([diagnostic]) => diagnostic.kind);
    expect(kinds).toHaveLength(observability.OBSERVABILITY_QUEUE_LIMIT - 1);
    expect(kinds[0]).toBe("failure_21");
    expect(kinds.at(-1)).toBe(`failure_${observability.OBSERVABILITY_QUEUE_LIMIT + 19}`);
  });

  it("queues uncaught errors raised before the SDK installs its own handlers", async () => {
    const observability = await loader();
    observability.bootObservability();
    const error = new Error("boot crash");
    window.dispatchEvent(new ErrorEvent("error", { error }));
    const reason = new TypeError("rejected");
    const rejection = new Event("unhandledrejection");
    rejection.reason = reason;
    window.dispatchEvent(rejection);
    expect(idle).toHaveLength(1);
    const removed = vi.spyOn(window, "removeEventListener");
    await observability.startObservability();
    expect(runtime.captureViewError.mock.calls).toEqual([[error], [reason]]);
    // The SDK's handlers own uncaught errors from here on.
    expect(removed.mock.calls.map(([type]) => type).sort()).toEqual(["error", "storage", "unhandledrejection"]);
    removed.mockRestore();
  });

  it("drops queued analytics when the switch is turned off before the SDK loads", async () => {
    const observability = await loader();
    observability.syncObservabilityContext({ userId: "member-1", authPending: false, view: "home" });
    observability.captureProductAction("save");
    observability.syncObservabilityContext({ userId: "member-1", authPending: false, view: "cases" });
    observability.captureSanitizedDiagnostic({ kind: "write_failed" });
    const saved = vi.fn();
    expect(observability.setDemoAnalyticsEnabled(false, { onSaved: saved })).toBe(false);
    expect(saved).toHaveBeenCalledWith(true);
    expect(observability.isDemoAnalyticsEnabled()).toBe(false);
    expect(observability.productAnalyticsSignal().aborted).toBe(true);
    expect(observability.captureProductAction("save")).toBe(false);
    await observability.startObservability();
    expect(runtime.captureProductAction).not.toHaveBeenCalled();
    expect(runtime.syncObservabilityContext.mock.calls).toEqual([[{ userId: "member-1", authPending: false, view: "cases" }]]);
    expect(runtime.captureSanitizedDiagnostic).toHaveBeenCalledWith({ kind: "write_failed" });
    expect(runtime.setDemoAnalyticsEnabled).not.toHaveBeenCalled();
    observability.setDemoAnalyticsEnabled(true);
    expect(runtime.setDemoAnalyticsEnabled).toHaveBeenCalledWith(true, {});
  });

  it("serves flag defaults before load and relays the runtime's flag changes after", async () => {
    const observability = await loader();
    const listener = vi.fn();
    const stop = observability.subscribeMemberFeatureFlags(listener);
    expect(observability.memberFeatureFlag("member-coach-mark")).toBe("control");
    expect(observability.reportMemberFlagExposure("member-coach-mark")).toBe(false);
    await observability.startObservability();
    expect(observability.memberFeatureFlag("member-coach-mark")).toBe("test");
    expect(observability.reportMemberFlagExposure("member-coach-mark")).toBe(true);
    const [[relay]] = runtime.subscribeMemberFeatureFlags.mock.calls;
    relay();
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    relay();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("discards queued analytics when another tab changes the switch before the SDK loads", async () => {
    const observability = await loader();
    observability.bootObservability();
    const listener = vi.fn();
    const stop = observability.subscribeDemoAnalytics(listener);
    observability.syncObservabilityContext({ userId: "member-1", authPending: false, view: "home" });
    observability.captureDemoAction("open_guide", "home");
    observability.syncObservabilityContext({ userId: "member-1", authPending: false, view: "cases" });
    observability.captureSanitizedDiagnostic({ kind: "write_failed" });
    // Off and on again in another tab: the stored value ends where it began.
    window.localStorage.setItem("sg-demo-analytics-disabled", "true");
    window.dispatchEvent(new StorageEvent("storage", { key: "sg-demo-analytics-disabled", newValue: "true" }));
    expect(observability.productAnalyticsSignal().aborted).toBe(true);
    window.localStorage.removeItem("sg-demo-analytics-disabled");
    window.dispatchEvent(new StorageEvent("storage", { key: "sg-demo-analytics-disabled", newValue: null }));
    expect(observability.productAnalyticsSignal().aborted).toBe(false);
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated", newValue: "x" }));
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    await observability.startObservability();
    expect(runtime.captureDemoAction).not.toHaveBeenCalled();
    expect(runtime.syncObservabilityContext.mock.calls).toEqual([[{ userId: "member-1", authPending: false, view: "cases" }]]);
    expect(runtime.captureSanitizedDiagnostic).toHaveBeenCalledWith({ kind: "write_failed" });
  });

  it("keeps the queue and imports again when the runtime chunk failed to load", async () => {
    vi.doMock("../src/lib/observability.js", () => { throw new Error("Failed to fetch dynamically imported module"); });
    const observability = await import("../src/lib/deferredObservability.js");
    const error = new Error("kept");
    observability.captureViewError(error);
    await expect(observability.startObservability()).resolves.toBe(false);
    vi.doMock("../src/lib/observability.js", () => runtime);
    await expect(observability.startObservability()).resolves.toBe(true);
    expect(runtime.captureViewError.mock.calls).toEqual([[error]]);
  });
});

describe("queued diagnostics through the real runtime", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "");
    vi.stubEnv("VITE_SENTRY_PREVIEW_ENABLED", "0");
    vi.stubEnv("VITE_SENTRY_DSN", "https://public@o0.ingest.us.sentry.io/1");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("scrubs a diagnostic raised before load exactly as one sent at once", async () => {
    const diagnostic = {
      kind: "write_failed",
      resource: "member_cases",
      code: "23505",
      label: "Save for jane@example.org",
      details: "Key (member_id)=(5c8f6a3e-1b2c-4d5e-8f90-123456789abc) already exists. Failing row contains (5c8f6a3e, jane@example.org, 5551234567).",
      hint: "call 5551234567",
    };
    const runtime = await import("../src/lib/observability.js");
    runtime.initObservability({ hostname: PORTAL_HOST, automated: false });
    runtime.captureSanitizedDiagnostic(diagnostic);
    expect(sdk.captureMessage).toHaveBeenCalledTimes(1);
    const direct = sdk.captureMessage.mock.calls[0];
    expect(JSON.stringify(direct)).not.toMatch(/jane@example\.org|5c8f6a3e-1b2c|5551234567/);

    vi.resetModules();
    sdk.captureMessage.mockClear();
    const observability = await import("../src/lib/deferredObservability.js");
    observability.captureSanitizedDiagnostic(diagnostic);
    expect(sdk.captureMessage).not.toHaveBeenCalled();
    // The fresh runtime module initializes for this host, as main.jsx's page would.
    (await import("../src/lib/observability.js")).initObservability({ hostname: PORTAL_HOST, automated: false });
    await observability.startObservability();
    expect(sdk.captureMessage.mock.calls).toEqual([direct]);
  });
});
