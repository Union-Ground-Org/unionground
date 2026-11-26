import { describe, expect, it, vi } from "vitest";
import { PORTAL_HOST, SAMPLE_HOST } from "./helpers/fictional-provider.js";

// REQ-UG-VISIBLE-ANALYTICS-OPT-OUT-20261016: the opt-out relies on
// the send gate over PostHog's request funnel. An SDK build without that hook
// could not honor a later opt-out for queued events, so it is never started.
const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
  reset: vi.fn(),
  capture: vi.fn(),
  startSessionRecording: vi.fn(),
  stopSessionRecording: vi.fn(),
}));

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
vi.mock("posthog-js", () => ({ default: posthog }));
vi.mock("@sentry/react", () => ({ init: vi.fn(), setUser: vi.fn(), captureMessage: vi.fn(), makeFetchTransport: vi.fn() }));

describe("PostHog without the send hook", () => {
  it("never starts, even when the visitor turns analytics back on", async () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "public-test-token");
    vi.stubEnv("VITE_POSTHOG_HOST", "https://e.unionground.test");
    const observability = await import("../src/lib/observability.js");
    observability.initObservability({
      hostname: SAMPLE_HOST,
      location: { href: `https://${SAMPLE_HOST}/` },
      history: { state: null, replaceState: vi.fn() },
      storage: window.localStorage,
      automated: false,
    });
    observability.syncObservabilityContext({ demoActive: true, view: "cases" });
    expect(observability.setDemoAnalyticsEnabled(true)).toBe(true);
    expect(observability.captureDemoAction("open_case", "cases")).toBe(false);
    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("stays off when the SDK sends events past _send_request without a gateable retry queue", async () => {
    // posthog-js 1.438 sends captured events through its retry queue rather
    // than _send_request, so the _send_request hook alone is not enough.
    posthog._send_request = vi.fn();
    vi.resetModules();
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "public-test-token");
    vi.stubEnv("VITE_POSTHOG_HOST", "https://e.unionground.test");
    const observability = await import("../src/lib/observability.js");
    observability.initObservability({
      hostname: SAMPLE_HOST,
      location: { href: `https://${SAMPLE_HOST}/` },
      history: { state: null, replaceState: vi.fn() },
      storage: window.localStorage,
      automated: false,
    });
    observability.syncObservabilityContext({ demoActive: true, view: "cases" });
    observability.setDemoAnalyticsEnabled(true);
    expect(observability.captureDemoAction("open_case", "cases")).toBe(false);
    expect(posthog.opt_in_capturing).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
