import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SAMPLE_HOST } from "./helpers/fictional-provider.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

vi.mock("@sentry/react", () => ({ init: vi.fn(), setUser: vi.fn() }));

const HOST = "https://e.unionground.test";
const KEY = "sg-demo-analytics-disabled";
const requests = [];
let failNextEvent = true;

function eventsSince(index) {
  return requests.slice(index).filter(({ url }) => url.startsWith(HOST))
    .flatMap(({ data }) => Array.isArray(data) ? data : [data])
    .filter((data) => typeof data?.event === "string");
}

describe("PostHog consent periods with the pinned SDK", () => {
  let observability;
  let posthog;
  let sdkSend;
  let retrySend;
  let initial;
  let otherTab;

  beforeAll(async () => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "public-test-token");
    vi.stubEnv("VITE_POSTHOG_HOST", HOST);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : null;
      // The pinned SDK wraps both singleton and batch event payloads in a
      // wire-level batch envelope during encoding, after _send_request.
      const data = body?.batch ?? body;
      const isEvent = String(url).startsWith(HOST) && (Array.isArray(data) || typeof data?.event === "string");
      const status = isEvent && failNextEvent ? 503 : 200;
      if (isEvent) failNextEvent = false;
      requests.push({ url: String(url), data, status });
      return new Response("{}", { status, headers: { "Content-Type": "application/json" } });
    }));
    // Fail closed if the SDK changes transport: these tests must never use a
    // real endpoint, and a transport change must require updating the proof.
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => { throw new Error("Unexpected XHR transport"); });
    posthog = (await import("posthog-js")).default;
    sdkSend = vi.spyOn(posthog, "_send_request");
    // Since posthog-js 1.438 captured events leave through the retry queue's
    // retriableRequest, not _send_request; observe both SDK entry points.
    const init = posthog.init;
    vi.spyOn(posthog, "init").mockImplementationOnce(function (...args) {
      const instance = init.apply(this, args);
      const queue = Object.values(posthog).find((value) => typeof value?.retriableRequest === "function");
      retrySend = vi.spyOn(queue, "retriableRequest");
      return instance;
    });
    observability = await import("../src/lib/observability.js");
    posthog = observability.posthogClient;
    observability.initObservability({
      hostname: SAMPLE_HOST, location: { href: `https://${SAMPLE_HOST}/` },
      history: { state: null, replaceState: vi.fn() }, storage: localStorage, automated: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    // Vitest 5 clears spy histories before the first test. Retain the
    // initialization payload while this hook still owns that history.
    initial = [...sdkSend.mock.calls, ...retrySend.mock.calls]
      .find(([options]) => options.data?.event === "$pageview")?.[0].data;
  });

  afterAll(() => {
    observability?.setDemoAnalyticsEnabled(false);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("discards the initial singleton page-view 503 retry after off/on", async () => {
    const failed = requests.find(({ status }) => status === 503);
    expect(initial?.event).toBe("$pageview");
    expect(Array.isArray(initial)).toBe(false);
    expect(failed?.data[0].uuid).toBe(initial.uuid);
    const previousId = initial.properties.distinct_id;
    expect(previousId).toBeTruthy();

    observability.setDemoAnalyticsEnabled(false);
    observability.setDemoAnalyticsEnabled(true);
    const sentBefore = requests.length;
    posthog.capture("fresh_singleton", {}, { send_instantly: true });
    await vi.advanceTimersByTimeAsync(15_000);

    expect(eventsSince(sentBefore).some(({ properties }) => properties.distinct_id === previousId)).toBe(false);
    expect(eventsSince(sentBefore).map(({ event }) => event)).toContain("fresh_singleton");
    expect(eventsSince(0).filter(({ uuid }) => uuid === initial.uuid)).toHaveLength(1);
  });

  it("invalidates queued demo events on a delayed off notification even when shared storage is already on", async () => {
    observability.syncObservabilityContext({ demoActive: true, view: "cases" });
    observability.captureDemoAction("before_delayed_off", "cases");
    const previousId = posthog.get_distinct_id();
    const previousSignal = observability.productAnalyticsSignal();
    const sentBefore = requests.length;

    // Tab B has completed both writes before suspended tab A handles either.
    otherTab = posthog.init("public-test-token", {
      ...posthog.config, loaded: () => {}, before_send: undefined,
      api_host: "https://other-tab.invalid",
      capture_pageview: false, capture_pageleave: false, disable_session_recording: true,
    }, "other_consent_tab");
    localStorage.setItem(KEY, "true");
    otherTab.reset();
    otherTab.opt_out_capturing();
    localStorage.removeItem(KEY);
    otherTab.opt_in_capturing({ captureEventName: false });
    otherTab.persistence.flush();
    const restoredId = otherTab.get_distinct_id();
    expect(restoredId).not.toBe(previousId);
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "true" }));
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, oldValue: "true", newValue: null }));
    expect(previousSignal.aborted).toBe(true);
    expect(observability.isDemoAnalyticsEnabled()).toBe(true);
    expect(posthog.get_distinct_id()).not.toBe(previousId);
    expect(posthog.get_distinct_id()).toBe(restoredId);
    expect(JSON.parse(localStorage.getItem("ph_public-test-token_posthog")).distinct_id).toBe(restoredId);
    observability.captureDemoAction("after_delayed_off", "cases");
    await vi.advanceTimersByTimeAsync(5_000);

    const sent = eventsSince(sentBefore);
    expect(sent.map(({ properties }) => properties.action)).not.toContain("before_delayed_off");
    expect(sent.map(({ properties }) => properties.action)).toContain("after_delayed_off");
    expect(JSON.stringify(sent)).not.toContain(previousId);
    expect(JSON.stringify(sent)).not.toContain("__sg_analytics_consent_period");
  });

  it("preserves the other tab's restored identity when this tab had already opted out", () => {
    observability.setDemoAnalyticsEnabled(false);
    localStorage.removeItem(KEY);
    otherTab.reset();
    otherTab.opt_in_capturing({ captureEventName: false });
    otherTab.persistence.flush();
    const restoredId = otherTab.get_distinct_id();
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "true" }));
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "true" }));
    expect(posthog.get_distinct_id()).toBe(restoredId);
    expect(JSON.parse(localStorage.getItem("ph_public-test-token_posthog")).distinct_id).toBe(restoredId);
  });

  it("persists the replacement identity before publishing opt-in to other tabs", () => {
    const previousId = posthog.get_distinct_id();
    observability.setDemoAnalyticsEnabled(false);
    let publishedId;
    const remove = Storage.prototype.removeItem;
    const spy = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (key) {
      if (this === localStorage && key === KEY) {
        publishedId = JSON.parse(localStorage.getItem("ph_public-test-token_posthog"))?.distinct_id;
      }
      return remove.call(this, key);
    });
    try {
      observability.setDemoAnalyticsEnabled(true);
      expect(publishedId).toBeTruthy();
      expect(publishedId).toBe(posthog.get_distinct_id());
      expect(publishedId).not.toBe(previousId);
    } finally {
      spy.mockRestore();
    }
  });

  it("waits for an unflushed sibling identity before resuming capture", async () => {
    const previousId = posthog.get_distinct_id();
    localStorage.setItem(KEY, "true");
    otherTab.reset();
    otherTab.opt_out_capturing();
    otherTab.opt_in_capturing({ captureEventName: false });
    localStorage.removeItem(KEY);
    const restoredId = otherTab.get_distinct_id();
    expect(restoredId).not.toBe(previousId);
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "true" }));
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, oldValue: "true", newValue: null }));
    const sentBefore = requests.length;
    posthog.capture("while_identity_missing", {}, { send_instantly: true });
    expect(requests).toHaveLength(sentBefore);

    otherTab.persistence.flush();
    window.dispatchEvent(new StorageEvent("storage", { key: "ph_public-test-token_posthog" }));
    expect(posthog.get_distinct_id()).toBe(restoredId);
    posthog.capture("after_identity_restored", {}, { send_instantly: true });
    await vi.advanceTimersByTimeAsync(5_000);
    const sent = eventsSince(sentBefore);
    expect(sent.map(({ event }) => event)).not.toContain("while_identity_missing");
    expect(sent.map(({ event }) => event)).toContain("after_identity_restored");
    expect(JSON.stringify(sent)).not.toContain(previousId);
  });

  it.each([false, true])("discards a real recorder buffer across off/on with pending compression=%s", async (pendingCompression) => {
    const { LazyLoadedSessionRecording } = await import("../node_modules/posthog-js/lib/src/extensions/replay/external/lazy-loaded-session-recorder.js");
    const { SessionRecording } = await import("../node_modules/posthog-js/lib/src/extensions/replay/session-recording.js");
    const originalRecording = posthog.sessionRecording;
    const recording = new SessionRecording(posthog);
    const recorder = new LazyLoadedSessionRecording(posthog);
    // Model the server's active sampling decision without loading rrweb or
    // remote scripts. Buffering, teardown and capture use the pinned SDK.
    Object.defineProperty(recorder, "status", { value: "active" });
    recording._lazyLoadedSessionRecording = recorder;
    posthog.sessionRecording = recording;
    const buffer = (marker) => ({
      size: 80, sizes: [80], sessionId: recorder.sessionId, windowId: recorder._windowId,
      data: [{ type: 3, timestamp: Date.now(), data: { tag: marker, payload: {} } }],
    });
    let releaseCompression;
    try {
      const controlBefore = requests.length;
      recorder._buffer = buffer("control_snapshot");
      recorder._flushBuffer();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(JSON.stringify(eventsSince(controlBefore))).toContain("control_snapshot");
      const previousId = posthog.get_distinct_id();
      recorder._buffer = buffer("withdrawn_snapshot");
      if (pendingCompression) {
        recorder._queuedCompressionEvents = 1;
        recorder._compressionQueue = new Promise((resolve) => { releaseCompression = resolve; });
      }
      const sentBefore = requests.length;
      observability.setDemoAnalyticsEnabled(false);
      observability.setDemoAnalyticsEnabled(true);
      releaseCompression?.();
      posthog.capture("after_replay_opt_in", {}, { send_instantly: true });
      await vi.advanceTimersByTimeAsync(5_000);
      const sent = eventsSince(sentBefore);
      expect(JSON.stringify(sent)).not.toContain("withdrawn_snapshot");
      expect(JSON.stringify(sent)).not.toContain(previousId);
      expect(sent.map(({ event }) => event)).toContain("after_replay_opt_in");
    } finally {
      releaseCompression?.();
      recorder.discard();
      posthog.sessionRecording = originalRecording;
    }
  });

  it.each([false, true])("keeps fresh replay after repeated delayed withdrawals with pending compression=%s", async (pendingCompression) => {
    const { LazyLoadedSessionRecording } = await import("../node_modules/posthog-js/lib/src/extensions/replay/external/lazy-loaded-session-recorder.js");
    const { SessionRecording } = await import("../node_modules/posthog-js/lib/src/extensions/replay/session-recording.js");
    const originalRecording = posthog.sessionRecording;
    const recorders = [];
    const attachRecorder = (marker) => {
      const recording = new SessionRecording(posthog);
      const recorder = new LazyLoadedSessionRecording(posthog);
      Object.defineProperty(recorder, "status", { value: "active" });
      recording._lazyLoadedSessionRecording = recorder;
      posthog.sessionRecording = recording;
      recorder._buffer = {
        size: 80, sizes: [80], sessionId: recorder.sessionId, windowId: recorder._windowId,
        data: [{ type: 3, timestamp: Date.now(), data: { tag: marker, payload: {} } }],
      };
      recorders.push(recorder);
      return recorder;
    };
    let releaseCompression;
    try {
      // A sibling completes two off/on cycles while this tab is suspended.
      for (let cycle = 0; cycle < 2; cycle += 1) {
        otherTab.reset();
        otherTab.opt_out_capturing();
        otherTab.opt_in_capturing({ captureEventName: false });
      }
      otherTab.sessionManager.checkAndGetSessionAndWindowId();
      const sharedReplayConfig = { enabled: false, sampleRate: 0.75 };
      otherTab.register({
        $session_recording_remote_config: sharedReplayConfig,
      });
      otherTab.persistence.flush();
      localStorage.removeItem(KEY);
      const restoredId = otherTab.get_distinct_id();
      window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "true" }));
      window.dispatchEvent(new StorageEvent("storage", { key: KEY, oldValue: "true", newValue: null }));
      const withdrawn = attachRecorder("withdrawn_between_notifications");
      if (pendingCompression) {
        withdrawn._queuedCompressionEvents = 1;
        withdrawn._compressionQueue = new Promise((resolve) => { releaseCompression = resolve; });
      }
      const sentBefore = requests.length;
      window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "true" }));
      window.dispatchEvent(new StorageEvent("storage", { key: KEY, oldValue: "true", newValue: null }));
      expect(posthog.get_distinct_id()).toBe(restoredId);
      expect(posthog.get_property("$session_recording_remote_config")).toEqual(sharedReplayConfig);
      const fresh = attachRecorder("fresh_after_repeated_notifications");
      expect(fresh.sessionId).toBe(withdrawn.sessionId);
      releaseCompression?.();
      await vi.advanceTimersByTimeAsync(0);
      fresh._flushBuffer();
      await vi.advanceTimersByTimeAsync(5_000);
      const sent = eventsSince(sentBefore);
      expect(JSON.stringify(sent)).not.toContain("withdrawn_between_notifications");
      expect(JSON.stringify(sent)).toContain("fresh_after_repeated_notifications");
      expect(sent.some(({ event }) => event === "$snapshot")).toBe(true);
    } finally {
      releaseCompression?.();
      recorders.forEach((recorder) => recorder.discard());
      posthog.sessionRecording = originalRecording;
    }
  });

  it("filters stale entries out of a mixed batch while preserving fresh events", async () => {
    observability.captureDemoAction("stale_batch_action", "cases");
    const previousId = posthog.get_distinct_id();
    observability.setDemoAnalyticsEnabled(false);
    observability.setDemoAnalyticsEnabled(true);
    observability.captureDemoAction("fresh_batch_action", "cases");
    const sentBefore = requests.length;
    await vi.advanceTimersByTimeAsync(5_000);

    const sent = eventsSince(sentBefore);
    expect(sent.map(({ properties }) => properties.action)).toContain("fresh_batch_action");
    expect(sent.map(({ properties }) => properties.action)).not.toContain("stale_batch_action");
    expect(JSON.stringify(sent)).not.toContain(previousId);
    expect(requests.slice(sentBefore).some(({ data }) => Array.isArray(data))).toBe(true);
  });

  it("retains the original capture period on a batch retry", async () => {
    failNextEvent = true;
    observability.captureDemoAction("failed_batch_action", "cases");
    await vi.advanceTimersByTimeAsync(5_000);
    const failed = requests.findLast(({ status }) => status === 503);
    expect(Array.isArray(failed.data)).toBe(true);
    expect(failed.data.some(({ properties }) => properties.action === "failed_batch_action")).toBe(true);
    observability.setDemoAnalyticsEnabled(false);
    observability.setDemoAnalyticsEnabled(true);
    const sentBefore = requests.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(eventsSince(sentBefore).map(({ properties }) => properties.action)).not.toContain("failed_batch_action");
  });

  it("still delivers a fresh batch when the SDK retries it in the same capture period", async () => {
    failNextEvent = true;
    observability.captureDemoAction("fresh_retried_action", "cases");
    await vi.advanceTimersByTimeAsync(5_000);
    const failed = requests.findLast(({ status }) => status === 503);
    expect(failed.data.some(({ properties }) => properties.action === "fresh_retried_action")).toBe(true);
    const sentBefore = requests.length;
    await vi.advanceTimersByTimeAsync(15_000);
    const retried = eventsSince(sentBefore);
    expect(retried.map(({ properties }) => properties.action)).toContain("fresh_retried_action");
    expect(JSON.stringify(retried)).not.toContain("__sg_analytics_consent_period");
  });

  it("allows non-event configuration requests while analytics is on and blocks them while off", () => {
    const data = { token: "public-test-token", distinct_id: "configuration-request" };
    const sentBefore = requests.length;
    posthog._send_request({ url: `${HOST}/flags/?v=2`, method: "POST", data });
    expect(requests.slice(sentBefore).map(({ data: sent }) => sent)).toEqual([data]);
    posthog._send_request({ url: `${HOST}/array/public-test-token/config`, method: "GET" });
    expect(requests.at(-1)).toMatchObject({ data: null, status: 200 });
    observability.setDemoAnalyticsEnabled(false);
    posthog._send_request({ url: `${HOST}/flags/?v=2`, method: "POST", data });
    expect(requests).toHaveLength(sentBefore + 2);
  });
});
