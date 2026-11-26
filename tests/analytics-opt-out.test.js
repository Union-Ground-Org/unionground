import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PORTAL_HOST, SAMPLE_HOST, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";
import { readFileSync } from "node:fs";
import { setTimeout as realSleep } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import { recordWorkspacePageView } from "../src/lib/memberApi.js";

// REQ-UG-VISIBLE-ANALYTICS-OPT-OUT-20261016: the visible Product
// analytics switch stops collection for real. The PostHog half runs the real
// SDK (not a mock) against an intercepted network, so "no request leaves the
// client" is measured at fetch, XMLHttpRequest, sendBeacon and script loads.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
vi.mock("@sentry/react", () => ({
  init: vi.fn(),
  setUser: vi.fn(),
  captureMessage: vi.fn(),
  makeFetchTransport: vi.fn(),
}));

const HOST = "https://e.unionground.test";
const requests = [];

function intercept() {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    requests.push(String(url));
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  const open = XMLHttpRequest.prototype.open;
  vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(function (method, url, ...rest) {
    requests.push(String(url));
    return open.call(this, method, "data:,", ...rest);
  });
  vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {});
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: vi.fn((url) => { requests.push(String(url)); return true; }),
  });
}

function scriptSources() {
  return [...document.querySelectorAll("script[src]")].map((script) => script.src);
}

function storedPostHogValues() {
  return Object.keys(window.localStorage)
    .filter((key) => key.startsWith("ph_"))
    .map((key) => window.localStorage.getItem(key));
}

describe("visible product analytics opt-out", () => {
  let observability;
  let posthog;

  beforeAll(async () => {
    window.localStorage.clear();
    intercept();
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "public-test-token");
    vi.stubEnv("VITE_POSTHOG_HOST", HOST);
    observability = await import("../src/lib/observability.js");
    posthog = observability.posthogClient;
    observability.initObservability({
      hostname: SAMPLE_HOST,
      location: { href: `https://${SAMPLE_HOST}/` },
      history: { state: null, replaceState: vi.fn() },
      storage: window.localStorage,
      automated: false,
    });
  });

  afterAll(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("sends demo analytics while on, then no request and no stored identifier after the switch is turned off", async () => {
    observability.syncObservabilityContext({ demoActive: true, view: "cases" });
    observability.captureDemoAction("open_case", "cases");
    await vi.advanceTimersByTimeAsync(10_000);
    // The SDK gzips a batch asynchronously; let the batch released while
    // analytics was on reach the network before the switch is turned off.
    await vi.waitFor(() => expect(requests.filter((url) => url.startsWith(HOST)).length).toBeGreaterThanOrEqual(2));
    const distinctId = posthog.get_distinct_id();
    expect(distinctId).toBeTruthy();
    expect(storedPostHogValues().join("")).toContain(distinctId);
    expect(Object.keys(window.sessionStorage).some((key) => key.startsWith("ph_"))).toBe(true);

    // This event waits in PostHog's batch queue, which does not re-check
    // consent; without the send gate it would leave on the next flush.
    observability.captureDemoAction("open_case_detail", "cases");
    const sentBefore = requests.length;
    const scriptsBefore = scriptSources().length;
    expect(observability.setDemoAnalyticsEnabled(false)).toBe(false);

    // Teardown is immediate: PostHog's persisted identifiers are gone in the
    // same session; only the browser-level opt-out marker remains.
    expect(storedPostHogValues()).toEqual([]);
    expect(Object.values(window.localStorage).join("")).not.toContain(distinctId);
    // The window identifier PostHog keeps in sessionStorage goes too.
    expect(Object.keys(window.sessionStorage).filter((key) => key.startsWith("ph_"))).toEqual([]);
    expect(posthog.has_opted_out_capturing()).toBe(true);

    observability.syncObservabilityContext({ demoActive: true, view: "tasks" });
    observability.captureDemoAction("open_task", "tasks");
    observability.syncObservabilityContext({ demoActive: false, view: null });
    posthog.capture("direct_call_after_opt_out");
    window.history.pushState({}, "", "/m/tasks");
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(60_000);
    await realSleep(200);

    expect(requests.slice(sentBefore)).toEqual([]);
    expect(scriptSources()).toHaveLength(scriptsBefore);
    expect(window.localStorage.getItem("sg-demo-analytics-disabled")).toBe("true");
  });

  it("stops member workspace page views at once, including a view decided before the switch", async () => {
    const { createWorkspacePageViewRecorder } = await import("../src/lib/workspacePageViews.js");
    observability.setDemoAnalyticsEnabled(true);
    const record = vi.fn(async () => null);
    const recorder = createWorkspacePageViewRecorder({ record, enabled: () => observability.isDemoAnalyticsEnabled() });

    expect(recorder.view("/m/cases", {})).toBe(true);
    observability.setDemoAnalyticsEnabled(false);
    await Promise.resolve();
    expect(recorder.view("/m/tasks", {})).toBe(false);
    await Promise.resolve();
    expect(record).not.toHaveBeenCalled();

    observability.setDemoAnalyticsEnabled(true);
    expect(recorder.view("/m/events", {})).toBe(true);
    await Promise.resolve();
    expect(record.mock.calls.map(([page]) => page)).toEqual(["/m/events"]);
  });

  it("keeps the choice for the next page load, which starts no analytics at all", async () => {
    observability.setDemoAnalyticsEnabled(false);
    vi.resetModules();
    const reloaded = await import("../src/lib/observability.js");
    const sentBefore = requests.length;
    reloaded.initObservability({
      hostname: SAMPLE_HOST,
      location: { href: `https://${SAMPLE_HOST}/` },
      history: { state: null, replaceState: vi.fn() },
      storage: window.localStorage,
      automated: false,
    });
    reloaded.syncObservabilityContext({ demoActive: true, view: "cases" });
    expect(reloaded.captureDemoAction("open_case", "cases")).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await realSleep(100);
    expect(requests.slice(sentBefore)).toEqual([]);
    expect(reloaded.isDemoAnalyticsEnabled()).toBe(false);
  });

  it("stops a queued batch when another tab turns analytics off, then tears this tab down", async () => {
    expect(observability.setDemoAnalyticsEnabled(true)).toBe(true);
    observability.syncObservabilityContext({ demoActive: true, view: "cases" });
    observability.captureDemoAction("open_case_other_tab", "cases");
    const sentBefore = requests.length;

    // Another tab writes the shared key; this tab has not seen an event yet.
    window.localStorage.setItem("sg-demo-analytics-disabled", "true");
    await vi.advanceTimersByTimeAsync(10_000);
    await realSleep(100);
    expect(requests.slice(sentBefore)).toEqual([]);

    const listener = vi.fn();
    const unsubscribe = observability.subscribeDemoAnalytics(listener);
    window.dispatchEvent(new StorageEvent("storage", { key: "sg-demo-analytics-disabled", newValue: "true" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated-key", newValue: "x" }));
    // An open Settings page hears the change once and re-reads the switch.
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(posthog.has_opted_out_capturing()).toBe(true);
    expect(observability.productAnalyticsSignal().aborted).toBe(true);
    expect(storedPostHogValues()).toEqual([]);
  });

  it("sends with no asynchronous step between the send gate and the transport", () => {
    expect(posthog.config.disable_compression).toBe(true);
    expect(observability.setDemoAnalyticsEnabled(true)).toBe(true);
    observability.syncObservabilityContext({ demoActive: true, view: "tasks" });
    observability.captureDemoAction("open_task_sync", "tasks");
    const sentBefore = requests.length;
    // Synchronous timer advance: no microtask runs, so the request must start
    // inside the flush that passed the gate.
    vi.advanceTimersByTime(5_000);
    expect(requests.length).toBeGreaterThan(sentBefore);
  });

  it("aborts a member page view that is still waiting on authentication when analytics is turned off", async () => {
    observability.setDemoAnalyticsEnabled(true);
    const sent = [];
    let releaseToken;
    const token = new Promise((resolve) => { releaseToken = resolve; });
    const client = createClient("https://project.supabase.co", "public-anon-key", {
      accessToken: () => token,
      global: {
        // A browser fetch with an aborted signal rejects without a request.
        fetch: async (url, init) => {
          if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
          sent.push(String(url));
          return new Response("{\"recorded\":true}", { status: 200, headers: { "Content-Type": "application/json" } });
        },
      },
    });
    const { abortableRpcClient } = await import("../src/lib/workspacePageViews.js");
    const gated = abortableRpcClient(client, observability.productAnalyticsSignal);

    const first = recordWorkspacePageView(gated, "/m/cases", "member", null).catch((error) => error);
    observability.setDemoAnalyticsEnabled(false);
    releaseToken("member-jwt");
    await first;
    expect(sent).toEqual([]);

    observability.setDemoAnalyticsEnabled(true);
    await recordWorkspacePageView(gated, "/m/events", "member", null);
    expect(sent).toEqual(["https://project.supabase.co/rest/v1/rpc/record_workspace_page_view"]);
  });

  it("sends no member page view once another tab has saved the opt-out, before this tab hears of it", async () => {
    observability.setDemoAnalyticsEnabled(true);
    // The module registry was reset by the reload test; take the guard from
    // the same instance the recorder module uses.
    const { guardedFetch } = await import("../src/lib/transportGuard.js");
    const sent = [];
    let releaseToken;
    const token = new Promise((resolve) => { releaseToken = resolve; });
    const client = createClient("https://project.supabase.co", "public-anon-key", {
      accessToken: () => token,
      global: {
        fetch: guardedFetch(async (url) => {
          sent.push(String(url));
          return new Response("{\"recorded\":true}", { status: 200, headers: { "Content-Type": "application/json" } });
        }),
      },
    });
    const { abortableRpcClient } = await import("../src/lib/workspacePageViews.js");
    const gated = abortableRpcClient(client, observability.productAnalyticsSignal, observability.isDemoAnalyticsEnabled);

    const first = recordWorkspacePageView(gated, "/m/cases", "member", null).catch((error) => error);
    // Another tab saves the opt-out; this tab's storage event has not run, so
    // the abort signal is still live when authentication completes.
    window.localStorage.setItem("sg-demo-analytics-disabled", "true");
    expect(observability.productAnalyticsSignal().aborted).toBe(false);
    releaseToken("member-jwt");
    await first;
    expect(sent).toEqual([]);

    window.localStorage.removeItem("sg-demo-analytics-disabled");
    await recordWorkspacePageView(gated, "/m/events", "member", null);
    expect(sent).toEqual(["https://project.supabase.co/rest/v1/rpc/record_workspace_page_view"]);
    // Requests without a guarded signal, such as the member's own data, pass.
    await client.rpc("member_snapshot");
    expect(sent).toHaveLength(2);
  });

  it("holds an opt-out the browser refused to save, and says it was not saved", () => {
    const refusing = {
      getItem: () => null,
      setItem() { throw new DOMException("quota", "QuotaExceededError"); },
      removeItem() {},
    };
    const onSaved = vi.fn();
    // A browser that also refuses the session store still tears down cleanly.
    const blockedSession = vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(observability.setDemoAnalyticsEnabled(false, { storage: refusing, onSaved })).toBe(false);
    blockedSession.mockRestore();
    expect(onSaved).toHaveBeenCalledWith(false);
    expect(observability.isDemoAnalyticsEnabled({ storage: refusing })).toBe(false);
    expect(observability.productAnalyticsSignal().aborted).toBe(true);
  });

  it("ignores the demo URL command on the member product", () => {
    const storage = window.localStorage;
    storage.setItem("sg-demo-analytics-disabled", "true");
    const history = { state: null, replaceState: vi.fn() };
    expect(observability.applyDemoAnalyticsPreferenceFromUrl({
      location: { href: `https://${PORTAL_HOST}/m/cases?sg_analytics=on` },
      history,
      storage,
      hostname: PORTAL_HOST,
    })).toBeNull();
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/m/cases");
    expect(storage.getItem("sg-demo-analytics-disabled")).toBe("true");
  });

  it("wires the switch into the only web page-view producer", () => {
    const app = readFileSync("src/App.jsx", "utf8");
    expect(app).toContain("enabled: () => isDemoAnalyticsEnabled(),");
    expect(app).toContain("record: (page, context) => recordWorkspacePageView(abortableRpcClient(sessionDataClient, productAnalyticsSignal, isDemoAnalyticsEnabled), page, context.hat, context.organizationId),");
    expect(app.match(/recordWorkspacePageView\(/g)).toHaveLength(1);
    // postgrest-js swaps the request's abort signal for its own only when a
    // db.timeout is set; the transport guard keys on the caller's signal, so
    // the member clients must not set one.
    const clients = readFileSync("src/lib/supabase.js", "utf8");
    expect(clients).not.toMatch(/\btimeout\b/);
    expect(clients.match(/fetch: guardedFetch\(/g)).toHaveLength(3);
  });
});


it("the checked writer transport rereads cross-tab opt-out after its Auth wait", async () => {
  vi.resetModules();
  const encode = (value) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const token = `${encode({ alg: "HS256" })}.${encode({ sub: "analytics-person", session_id: "analytics-session", exp: 9999999999 })}.sig0`;
  const sent = [];
  vi.stubEnv("VITE_APP_SURFACE", "saas");
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_ORIGIN);
  // This edition's browser client needs its own project ref and a publishable-shaped key.
  vi.stubEnv("VITE_UNIONGROUND_SUPABASE_REF", SUPABASE_REF);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_testkeyxxxxxxxx");
  vi.stubEnv("VITE_SAMPLE_SUPABASE_URL", ""); vi.stubEnv("VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY", "");
  vi.stubGlobal("fetch", async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/user")) return new Response(JSON.stringify({ id: "analytics-person" }), { headers: { "Content-Type": "application/json" } });
    sent.push(url.pathname); return new Response("{}", { headers: { "Content-Type": "application/json" } });
  });
  const mod = await import("../src/lib/supabase.js");
  const { createSessionBoundWriter } = await import("../src/lib/sessionBoundWriter.js");
  const { createSessionBoundDataClient } = await import("../src/lib/sessionBoundDataClient.js");
  const { abortableRpcClient } = await import("../src/lib/workspacePageViews.js");
  try {
    await mod.appSupabase.auth.setSession({ access_token: token, refresh_token: "test-refresh" });
    const session = (await mod.appSupabase.auth.getSession()).data.session;
    const writer = createSessionBoundWriter({ session, sharedClient: mod.appSupabase, createSessionClient: (current) => mod.createCapturedAppSessionRpcClient(current, { boundedTransport: true }) });
    const client = createSessionBoundDataClient(writer, mod.appSupabase);
    const signal = new AbortController().signal;
    const guarded = abortableRpcClient(client, () => signal, () => localStorage.getItem("sg-demo-analytics-disabled") !== "true");
    const original = mod.appSupabase.auth.getSession.bind(mod.appSupabase.auth);
    const spy = vi.spyOn(mod.appSupabase.auth, "getSession").mockImplementation(async () => {
      localStorage.setItem("sg-demo-analytics-disabled", "true");
      return original();
    });
    await recordWorkspacePageView(guarded, "/m/cases", "member", null).catch(() => undefined);
    spy.mockRestore();
    expect(signal.aborted).toBe(false); expect(sent).toEqual([]);
    localStorage.removeItem("sg-demo-analytics-disabled");
    await recordWorkspacePageView(guarded, "/m/cases", "member", null);
    expect(sent).toEqual(["/rest/v1/rpc/record_workspace_page_view"]);
  } finally { await mod.appSupabase.auth.dispose(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); localStorage.clear(); }
});
