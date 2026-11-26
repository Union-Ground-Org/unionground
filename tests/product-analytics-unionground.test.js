import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PORTAL_HOST, PORTAL_ORIGIN } from "./helpers/fictional-provider.js";

// OPS-UG-POSTHOG-ANALYTICS-ON-MEMBER-PRODUCT-AND-PUBLIC-PAGES-20261027
// (#6247): product analytics on unionground.net. The SDK is a stub that
// records init options, captures and sends; every event is run through the
// before_send the module installed, so these tests see exactly what would
// leave the page.
const sdk = vi.hoisted(() => ({ init: vi.fn(), setUser: vi.fn(), captureMessage: vi.fn(), makeFetchTransport: vi.fn() }));
const posthog = vi.hoisted(() => {
  const diagnostics = { captureException: vi.fn() };
  const client = {
    init: vi.fn((_token, _options, name) => (name ? diagnostics : client)),
    capture: vi.fn(),
    register: vi.fn(),
    reset: vi.fn(),
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
    _send_request: vi.fn(),
    requestQueue: { retriableRequest: vi.fn() },
  };
  return { default: client, diagnostics };
});
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
vi.mock("@sentry/react", () => sdk);
vi.mock("posthog-js", () => ({ default: posthog.default }));
vi.mock("posthog-js/dist/exception-autocapture.js", () => ({}));

const USER = "6f1c2a7e-0d3b-4c5e-9a8f-1b2c3d4e5f60";
const OTHER = "0a1b2c3d-4e5f-4061-8a7b-9c0d1e2f3a4b";
const ORG = "7d3e4f50-6a7b-4c8d-9e0f-a1b2c3d4e5f6";
// sha256 of "unionground-analytics:v1:" + each id, precomputed: the module under
// test computes them with Web Crypto.
const PSEUDONYMS = {
  [USER]: "8dc2142cc248163115bb8383dbe00ddad6946e7fd8335a330dc34de9634e10df",
  [OTHER]: "0c1a6d152975a31ce61eb639ed7fceef1492a5e24137f44577b5e5328f3b972f",
  [ORG]: "98c20800044a107ca97a1efeb9878f5e4d5f455d32c818e9fda93ece5bbb3c7e",
};
const hash = (value) => PSEUDONYMS[value];

function productOptions() {
  const call = posthog.default.init.mock.calls.find(([, , name]) => name === undefined);
  return call?.[1];
}

// What would leave the page: each capture rebuilt by the installed before_send.
function sentEvents() {
  const options = productOptions();
  return posthog.default.capture.mock.calls
    .map(([event, properties]) => options.before_send({ event, properties: { ...properties, token: "phc_fixture", $lib: "web", $lib_version: "1.438.19",
      $current_url: `${PORTAL_ORIGIN}/m/cases?case=42`, email: "taylor@example.org", distinct_id: "anon" } }))
    .filter(Boolean)
    // The consent-period marker is the module's own; the send gate strips it.
    .map(({ __sg_analytics_consent_period: period, ...event }) => (expect(typeof period).toBe("number"), event));
}

async function settle() {
  const { memberIdentitySettled } = await import("../src/lib/observability.js");
  await memberIdentitySettled();
}

describe("product analytics on unionground.net", () => {
  let observability;
  let location;

  async function start({ storage = window.localStorage, automated = false } = {}) {
    observability = await import("../src/lib/observability.js");
    observability.initObservability({ hostname: PORTAL_HOST, location, history: { state: null, replaceState: vi.fn() }, storage, automated });
  }

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // Each case gets an unwrapped SDK: the module installs its send gates here.
    posthog.default._send_request = vi.fn();
    posthog.default.requestQueue.retriableRequest = vi.fn();
    window.localStorage.clear();
    window.sessionStorage.clear();
    location = { href: `${PORTAL_ORIGIN}/`, origin: PORTAL_ORIGIN, pathname: "/" };
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_fixture");
    vi.stubEnv("VITE_POSTHOG_HOST", "https://e.unionground.net");
    vi.stubEnv("VITE_SENTRY_DSN", "");
    Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: null });
    Object.defineProperty(navigator, "globalPrivacyControl", { configurable: true, value: undefined });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("starts the analytics instance cookieless, in memory, with every automatic capture off", async () => {
    await start();
    expect(productOptions()).toMatchObject({
      api_host: "https://e.unionground.net", cookieless_mode: "always", persistence: "memory", disable_persistence: true, disable_cookie: true,
      autocapture: false, capture_pageview: false, capture_pageleave: false, capture_performance: false, capture_heatmaps: false,
      disable_session_recording: true, disable_surveys: true, advanced_disable_flags: true, opt_out_capturing_by_default: false, respect_dnt: true,
    });
    // The module's own gate is the consent record; the SDK never writes one.
    expect(posthog.default.opt_in_capturing).not.toHaveBeenCalled();
    expect(posthog.default.opt_out_capturing).not.toHaveBeenCalled();
  });

  it("reports a public page view cookieless with only its path, and never a member route or a view before session restore", async () => {
    await start();
    observability.syncObservabilityContext({ userId: null, view: "landing", authPending: true });
    expect(posthog.default.capture).not.toHaveBeenCalled();
    observability.syncObservabilityContext({ userId: null, view: "landing", authPending: false });
    location.pathname = "/m/cases";
    observability.syncObservabilityContext({ userId: null, view: "cases" });
    const sent = sentEvents();
    expect(sent).toHaveLength(1);
    const { release, ...properties } = sent[0].properties;
    if (release !== undefined) expect(release).toMatch(/^[a-f0-9]{40}$/);
    expect({ ...sent[0], properties }).toEqual({ event: "$pageview", distinct_id: "$posthog_cookieless", properties: {
      $process_person_profile: false, $geoip_disable: true, $cookieless_mode: true, app_surface: "public_site",
      $pathname: "/", $host: PORTAL_HOST, $current_url: `${PORTAL_ORIGIN}/`, distinct_id: "$posthog_cookieless",
      token: "phc_fixture", $lib: "web", $lib_version: "1.438.19", surface: "web", deployment_environment: "production",
    } });
  });

  it("sends a member action queued before the runtime loaded under the member's hashed identity", async () => {
    await start();
    // The page as main.jsx leaves it: App code talks to the deferred loader.
    const deferred = await import("../src/lib/deferredObservability.js");
    deferred.syncObservabilityContext({ userId: USER, organizationId: ORG, view: "forms", authPending: false });
    expect(deferred.captureProductAction("save")).toBe(false);
    expect(posthog.default.capture).not.toHaveBeenCalled();
    await deferred.startObservability();
    await settle();
    const sent = sentEvents();
    expect(sent.map((event) => [event.event, event.properties.view, event.properties.action])).toEqual([
      ["$pageview", "forms", undefined], ["product_action", "forms", "save"],
    ]);
    for (const event of sent) expect(event.distinct_id).toBe(hash(USER));
  });

  it("counts a member under one-way hashes of the user and organization, with view and allowlisted action labels only", async () => {
    await start();
    observability.syncObservabilityContext({ userId: USER, organizationId: ORG, view: "cases" });
    await settle();
    observability.syncObservabilityContext({ userId: USER, organizationId: ORG, view: "forms" });
    expect(observability.captureProductAction("save")).toBe(true);
    expect(observability.captureProductAction("delete_everything")).toBe(false);
    const sent = sentEvents();
    expect(sent.map((event) => [event.event, event.properties.view, event.properties.action])).toEqual([
      ["$pageview", "cases", undefined], ["$pageview", "forms", undefined], ["product_action", "forms", "save"],
    ]);
    for (const event of sent) {
      expect(event.distinct_id).toBe(hash(USER));
      expect(event.properties.distinct_id).toBe(hash(USER));
      expect(event.properties.$groups).toEqual({ organization: hash(ORG) });
      expect(event.properties.app_surface).toBe("member");
      // No identifier, URL, email or SDK free-form property survives.
      const text = JSON.stringify(event);
      for (const leaked of [USER, ORG, "taylor@example.org", "/m/cases", "case=42", "anon"]) expect(text).not.toContain(leaked);
    }
  });

  it("never counts a member under another account's identity when the session switches while the digest runs", async () => {
    await start();
    observability.syncObservabilityContext({ userId: USER, organizationId: ORG, view: "cases" });
    observability.syncObservabilityContext({ userId: OTHER, organizationId: ORG, view: "cases" });
    await settle();
    const sent = sentEvents();
    expect(sent).toHaveLength(1);
    expect(sent[0].distinct_id).toBe(hash(OTHER));
  });

  it("stops member capture at once, in this tab and from another tab, and keeps nothing in storage", async () => {
    const sendRequest = posthog.default._send_request;
    await start();
    observability.syncObservabilityContext({ userId: USER, organizationId: ORG, view: "cases" });
    await settle();
    const options = productOptions();
    observability.setDemoAnalyticsEnabled(false, { storage: window.localStorage });
    expect(observability.captureProductAction("save")).toBe(false);
    // Anything captured before the switch is dropped by the closed gate.
    expect(options.before_send({ event: "$pageview", properties: { view: "cases" } })).toBeNull();
    // The installed send gate refuses what is still queued.
    expect(posthog.default._send_request({ url: "https://e.unionground.net/e/", data: { event: "$pageview" } })).toBeUndefined();
    expect(sendRequest).not.toHaveBeenCalled();
    expect(Object.keys(window.localStorage).filter((key) => key !== "sg-demo-analytics-disabled")).toEqual([]);
    expect(Object.keys(window.sessionStorage)).toEqual([]);
    expect(document.cookie).toBe("");

    // Back on in this tab, then off from another tab (the storage event).
    observability.setDemoAnalyticsEnabled(true, { storage: window.localStorage });
    await settle();
    posthog.default.capture.mockClear();
    window.localStorage.setItem("sg-demo-analytics-disabled", "true");
    window.dispatchEvent(new StorageEvent("storage", { key: "sg-demo-analytics-disabled", newValue: "true" }));
    expect(observability.captureProductAction("save")).toBe(false);
    observability.syncObservabilityContext({ userId: USER, organizationId: ORG, view: "forms" });
    expect(posthog.default.capture).not.toHaveBeenCalled();
  });

  it("does not start for Do Not Track, Global Privacy Control, a switch already off, or an automated browser", async () => {
    Object.defineProperty(navigator, "globalPrivacyControl", { configurable: true, value: true });
    await start();
    expect(productOptions()).toBeUndefined();
    Object.defineProperty(navigator, "globalPrivacyControl", { configurable: true, value: undefined });

    vi.resetModules(); vi.clearAllMocks();
    Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: "1" });
    await start();
    expect(productOptions()).toBeUndefined();
    Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: null });

    vi.resetModules(); vi.clearAllMocks();
    window.localStorage.setItem("sg-demo-analytics-disabled", "true");
    await start();
    expect(productOptions()).toBeUndefined();
    window.localStorage.clear();

    vi.resetModules(); vi.clearAllMocks();
    await start({ automated: true });
    expect(productOptions()).toBeUndefined();
  });

  it("drops captures once Global Privacy Control appears mid-session", async () => {
    await start();
    observability.syncObservabilityContext({ userId: USER, organizationId: ORG, view: "cases" });
    await settle();
    Object.defineProperty(navigator, "globalPrivacyControl", { configurable: true, value: true });
    expect(productOptions().before_send({ event: "$pageview", properties: { view: "cases" } })).toBeNull();
    expect(observability.captureProductAction("save")).toBe(false);
  });

  it("leaves the demo host on its own instance and never starts product analytics in the fixture demo on unionground.net", async () => {
    await start();
    posthog.default.capture.mockClear();
    observability.syncObservabilityContext({ demoActive: true, view: "cases" });
    expect(observability.captureDemoAction("open_guide", "cases")).toBe(false);
    expect(observability.captureProductAction("save")).toBe(false);
    expect(posthog.default.capture).not.toHaveBeenCalled();
  });
});
