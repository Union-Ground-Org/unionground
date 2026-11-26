import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PORTAL_HOST, SAMPLE_HOST } from "./helpers/fictional-provider.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

// These cases follow one SDK session initialized in beforeAll. Vitest 5
// clears call history between cases by default; retain this session's history
// so the initialization and opt-out/restart assertions keep their meaning.
vi.setConfig({ clearMocks: false });

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  capture: vi.fn(),
  startSessionRecording: vi.fn(),
  stopSessionRecording: vi.fn(),
  _send_request: vi.fn(),
  _retryQueue: { retriableRequest: vi.fn() },
}));

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  setUser: vi.fn(),
  captureMessage: vi.fn(),
  makeFetchTransport: vi.fn(),
  breadcrumbsIntegration: vi.fn(() => ({ name: "Breadcrumbs" })),
  browserTracingIntegration: vi.fn(() => ({ name: "BrowserTracing" })),
}));

vi.mock("posthog-js", () => ({ default: posthog }));
vi.mock("@sentry/react", () => sentry);

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

describe("observability session policy", () => {
  let observability;

  beforeAll(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T00:00:00Z"));
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "public-test-token");
    vi.stubEnv("VITE_POSTHOG_HOST", "https://e.unionground.test");
    vi.stubEnv("VITE_SENTRY_DSN", "https://public@example.ingest.sentry.io/1");
    observability = await import("../src/lib/observability.js");
    observability.initObservability({
      hostname: SAMPLE_HOST,
      location: { href: `https://${SAMPLE_HOST}/` },
      history: { state: null, replaceState: vi.fn() },
      storage: memoryStorage(),
      automated: false,
    });
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("captures anonymous visits and records only masked demo sessions", () => {
    const config = posthog.init.mock.calls[0][1];
    expect(config).toMatchObject({
      autocapture: false,
      person_profiles: "identified_only",
      respect_dnt: true,
      disable_session_recording: true,
      enable_recording_console_log: false,
      advanced_disable_feature_flags: true,
      advanced_disable_feature_flags_on_first_load: true,
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: "*",
        collectFonts: false,
        recordCrossOriginIframes: false,
      },
    });
    expect(config.advanced_disable_flags).toBeUndefined();
    const register = vi.fn();
    config.loaded({ register });
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      analytics_scope: "external_demo",
      deployment_environment: "production",
    }));
    expect(posthog.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: false });
    expect(posthog.capture).toHaveBeenCalledWith("$pageview", { app_surface: "demo_site" });

    observability.syncObservabilityContext({ demoActive: true, view: "today" });
    expect(posthog.startSessionRecording).toHaveBeenCalledWith({ sampling: true, linked_flag: true });
    expect(posthog.capture).toHaveBeenCalledWith("demo_started", {
      is_demo: true,
      entry_view: "today",
    });
    expect(posthog.capture).toHaveBeenCalledWith("demo_viewed", {
      is_demo: true,
      view: "today",
      view_number: 1,
    });

    observability.syncObservabilityContext({ demoActive: true, view: "cases" });
    expect(posthog.capture).toHaveBeenCalledWith("demo_viewed", {
      is_demo: true,
      view: "cases",
      view_number: 2,
    });
    expect(observability.captureDemoAction("private member message", "cases")).toBe(false);
    expect(observability.captureDemoAction("demo_mutation", "cases")).toBe(true);

    vi.advanceTimersByTime(12_000);
    const pagehide = new Event("pagehide");
    Object.defineProperty(pagehide, "persisted", { value: false });
    window.dispatchEvent(pagehide);
    expect(posthog.capture).toHaveBeenCalledWith("demo_ended", {
      is_demo: true,
      duration_seconds: 12,
      views_seen: 2,
      actions_count: 1,
    }, { transport: "sendBeacon" });
    expect(posthog.stopSessionRecording).toHaveBeenCalledOnce();
  });

  it("tears down SAMPLE analytics immediately without emitting after opt-out and can restart explicitly", () => {
    const storage = memoryStorage();
    const capturesBefore = posthog.capture.mock.calls.length;
    const endedBefore = posthog.capture.mock.calls.filter(([event]) => event === "demo_ended").length;
    const stopsBefore = posthog.stopSessionRecording.mock.calls.length;
    const resetsBefore = posthog.reset.mock.calls.length;
    const optOutsBefore = posthog.opt_out_capturing.mock.calls.length;

    expect(observability.setDemoAnalyticsEnabled(false, { storage })).toBe(false);
    expect(observability.isDemoAnalyticsEnabled({ storage })).toBe(false);
    expect(posthog.stopSessionRecording).toHaveBeenCalledTimes(stopsBefore + 1);
    expect(posthog.reset).toHaveBeenCalledTimes(resetsBefore + 1);
    expect(posthog.opt_out_capturing).toHaveBeenCalledTimes(optOutsBefore + 1);
    expect(posthog.capture.mock.calls.length).toBe(capturesBefore);
    expect(posthog.capture.mock.calls.filter(([event]) => event === "demo_ended")).toHaveLength(endedBefore);
    expect(observability.captureDemoAction("demo_mutation", "cases")).toBe(false);

    const startsBefore = posthog.startSessionRecording.mock.calls.length;
    const optInsBefore = posthog.opt_in_capturing.mock.calls.length;
    expect(observability.setDemoAnalyticsEnabled(true, { storage })).toBe(true);
    expect(observability.isDemoAnalyticsEnabled({ storage })).toBe(true);
    expect(posthog.opt_in_capturing).toHaveBeenCalledTimes(optInsBefore + 2);
    expect(posthog.startSessionRecording).toHaveBeenCalledTimes(startsBefore + 1);
  });

  it("captures only the SAMPLE tour host and honors a persistent browser exclusion", () => {
    const storage = memoryStorage();
    const history = { state: { source: "test" }, replaceState: vi.fn() };

    expect(observability.shouldCaptureDemoAnalytics({ hostname: SAMPLE_HOST, storage })).toBe(true);
    expect(observability.shouldCaptureDemoAnalytics({ hostname: `www.${SAMPLE_HOST}`, storage })).toBe(true);
    expect(observability.shouldCaptureDemoAnalytics({ hostname: PORTAL_HOST, storage })).toBe(false);
    expect(observability.shouldCaptureDemoAnalytics({ hostname: `www.${PORTAL_HOST}`, storage })).toBe(false);
    expect(observability.shouldCaptureDemoAnalytics({ hostname: `demo.${PORTAL_HOST}`, storage })).toBe(false);
    expect(observability.shouldCaptureDemoAnalytics({ hostname: `www.demo.${PORTAL_HOST}`, storage })).toBe(false);
    expect(observability.shouldCaptureDemoAnalytics({ hostname: "branch.vercel.app", storage })).toBe(false);
    expect(observability.shouldCaptureDemoAnalytics({ hostname: "localhost", storage })).toBe(false);
    expect(observability.shouldCaptureDemoAnalytics({
      hostname: SAMPLE_HOST,
      storage,
      automated: true,
    })).toBe(false);

    const off = observability.applyDemoAnalyticsPreferenceFromUrl({
      location: { href: `https://${SAMPLE_HOST}/?sg_analytics=off&source=qa#demo` },
      history,
      storage,
    });
    expect(off).toBe("off");
    expect(history.replaceState).toHaveBeenLastCalledWith(
      { source: "test" },
      "",
      "/?source=qa#demo",
    );
    expect(observability.shouldCaptureDemoAnalytics({ hostname: SAMPLE_HOST, storage })).toBe(false);

    const on = observability.applyDemoAnalyticsPreferenceFromUrl({
      location: { href: `https://${SAMPLE_HOST}/?sg_analytics=on` },
      history,
      storage,
    });
    expect(on).toBe("on");
    expect(observability.shouldCaptureDemoAnalytics({ hostname: SAMPLE_HOST, storage })).toBe(true);
  });

  it("treats unreadable storage as analytics off and survives an unusable URL", () => {
    // REQ-UG-VISIBLE-ANALYTICS-OPT-OUT-20261016: a browser that will
    // not let us read the opt-out cannot prove the visitor has not opted out.
    const throwingStorage = {
      getItem() { throw new Error("storage blocked"); },
      setItem() { throw new Error("storage blocked"); },
      removeItem() { throw new Error("storage blocked"); },
    };
    expect(observability.shouldCaptureDemoAnalytics({
      hostname: SAMPLE_HOST,
      storage: throwingStorage,
    })).toBe(false);
    expect(observability.shouldCaptureDemoAnalytics({
      hostname: SAMPLE_HOST,
      storage: throwingStorage,
      command: "on",
    })).toBe(true);
    expect(observability.applyDemoAnalyticsPreferenceFromUrl({
      location: { href: "not a url" },
      history: { state: null, replaceState: vi.fn() },
      storage: throwingStorage,
    })).toBeNull();
  });

  it("initializes Sentry for production SaaS and SAMPLE hosts", () => {
    expect(observability.shouldEnableSentry({ hostname: PORTAL_HOST, automated: false })).toBe(true);
    expect(observability.shouldEnableSentry({ hostname: `www.${PORTAL_HOST}`, automated: false })).toBe(false);
    expect(observability.shouldEnableSentry({ hostname: SAMPLE_HOST, automated: false })).toBe(true);
    expect(observability.shouldEnableSentry({ hostname: `www.${SAMPLE_HOST}`, automated: false })).toBe(true);
    expect(observability.shouldEnableSentry({ hostname: `demo.${PORTAL_HOST}`, automated: false })).toBe(false);
    expect(observability.shouldEnableSentry({ hostname: "branch.vercel.app", automated: false })).toBe(false);
    expect(observability.shouldEnableSentry({ hostname: "localhost", automated: false })).toBe(false);
    expect(observability.shouldEnableSentry({ hostname: PORTAL_HOST, automated: true })).toBe(false);
    expect(sentry.init).toHaveBeenCalledOnce();
  });

  it("sends a sanitized diagnostic without driver text", () => {
    sentry.captureMessage.mockClear();
    expect(observability.captureSanitizedDiagnostic({
      kind: "member_session_resource_failure",
      resource: "table:member_conversations",
      code: "57014",
      name: "Error",
      message: "offline permission denied",
    })).toBe(true);
    expect(sentry.captureMessage).toHaveBeenCalledWith("member_session_resource_failure", {
      level: "error",
      extra: {
        diagnostic: {
          kind: "member_session_resource_failure",
          resource: "table:member_conversations",
          code: "57014",
          name: "Error",
        },
      },
    });
    expect(JSON.stringify(sentry.captureMessage.mock.calls)).not.toContain("offline");
    expect(observability.captureSanitizedDiagnostic({ kind: "Not A Valid Kind" })).toBe(false);
  });

  it("forwards privacy-filtered write-failure label, details, and hint to Sentry", () => {
    sentry.captureMessage.mockClear();
    expect(observability.captureSanitizedDiagnostic({
      kind: "vp_mark_reviewed_failure",
      code: "42501",
      name: "MemberApiError",
      label: "Leadership review",
      details: "RPC mark_vp_case_reviewed refused for steward@example.com",
      hint: "Bearer abcdef.ghijkl.mnopqr then check grants",
      message: "Leadership review: permission denied",
    })).toBe(true);
    expect(sentry.captureMessage).toHaveBeenCalledWith("vp_mark_reviewed_failure", {
      level: "error",
      extra: {
        diagnostic: {
          kind: "vp_mark_reviewed_failure",
          resource: null,
          code: "42501",
          name: "MemberApiError",
          label: "Leadership review",
          details: "RPC mark_vp_case_reviewed refused for [redacted-email]",
          hint: "Bearer [redacted] then check grants",
        },
      },
    });
    const logged = JSON.stringify(sentry.captureMessage.mock.calls);
    expect(logged).not.toContain("permission denied");
    expect(logged).not.toContain("steward@example.com");
    expect(logged).not.toContain("abcdef.ghijkl.mnopqr");
    expect(observability.captureSanitizedDiagnostic({
      kind: "vp_mark_reviewed_failure",
      label: "",
      details: "",
      hint: "",
    })).toBe(true);
  });

  it("strips database row values and identifiers from write-failure details and hint", () => {
    sentry.captureMessage.mockClear();
    const caseId = "3f2b8c1e-9a4d-4e21-8b7f-0c6d5e4a3b21";
    const reviewerId = "a1b2c3d4-e5f6-4789-8abc-def012345678";
    expect(observability.captureSanitizedDiagnostic({
      kind: "vp_mark_reviewed_failure",
      code: "23505",
      name: "MemberApiError",
      label: "Leadership review",
      details: `Failing row contains (${caseId}, ${reviewerId}, Jordan Member, 5551234567).`,
      hint: `Key (case_id, reviewer_id)=(${caseId}, ${reviewerId}) already exists; case ${caseId}`,
    })).toBe(true);
    const { diagnostic } = sentry.captureMessage.mock.calls[0][1].extra;
    expect(diagnostic.details).toBe("Failing row contains ([redacted-row]).");
    expect(diagnostic.hint).toBe("Key (case_id, reviewer_id)=([redacted]) already exists; case [redacted-id]");
    const logged = JSON.stringify(sentry.captureMessage.mock.calls);
    for (const leaked of [caseId, reviewerId, "Jordan Member", "5551234567"]) {
      expect(logged).not.toContain(leaked);
    }
  });

  it("rejects headless automation even when webdriver is hidden", () => {
    expect(observability.isAutomatedBrowser({
      webdriver: false,
      userAgent: "Mozilla/5.0 HeadlessChrome/150.0.0.0 Safari/537.36",
    })).toBe(true);
    expect(observability.isAutomatedBrowser({
      webdriver: false,
      userAgent: "Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36",
    })).toBe(false);
  });

  it("keeps authenticated product sessions out of PostHog without attaching Sentry account identity", () => {
    const optOutsBefore = posthog.opt_out_capturing.mock.calls.length;
    const resetsBefore = posthog.reset.mock.calls.length;
    observability.syncObservabilityContext({ userId: "member-internal-id", view: "today" });
    expect(posthog.identify).not.toHaveBeenCalled();
    expect(posthog.opt_out_capturing).toHaveBeenCalledTimes(optOutsBefore + 1);
    expect(sentry.setUser).toHaveBeenLastCalledWith(null);

    observability.syncObservabilityContext({ view: "today" });
    expect(posthog.reset).toHaveBeenCalledTimes(resetsBefore + 2);
    expect(posthog.capture).toHaveBeenLastCalledWith("$pageview", { app_surface: "demo_site" });
    expect(sentry.setUser).toHaveBeenLastCalledWith(null);
  });
});
