import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoSurveyReleaseFiles } from "./helpers/demo-survey-release.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SAMPLE_HOST, SAMPLE_ORIGIN } from "./helpers/fictional-provider.js";

// OPS-UG-POSTHOG-FLAGS-EXPERIMENTS-SURVEYS-HEATMAPS-20261027 (#6248):
// member feature flags and the experiment exposure on unionground.net,
// heatmaps on its public pages only, and the one public-demo survey. The SDK
// is a stub; every capture is run through the before_send the module
// installed, so these tests see exactly what would leave the page.
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
    startSessionRecording: vi.fn(),
    stopSessionRecording: vi.fn(),
    set_config: vi.fn(),
    getSurveys: vi.fn(),
    displaySurvey: vi.fn(),
    _send_request: vi.fn(),
    requestQueue: { retriableRequest: vi.fn() },
  };
  return { default: client, diagnostics };
});
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
vi.mock("@sentry/react", () => sdk);
vi.mock("posthog-js", () => ({ default: posthog.default }));
vi.mock("posthog-js/dist/exception-autocapture.js", () => ({}));
const legal = vi.hoisted(() => ({ files: null }));
vi.mock("../src/lib/legalReleaseBundle.js", async (original) => ({
  ...await original(), bundledLegalReleaseFiles: () => legal.files,
}));

const USER = "6f1c2a7e-0d3b-4c5e-9a8f-1b2c3d4e5f60";
const ORG = "7d3e4f50-6a7b-4c8d-9e0f-a1b2c3d4e5f6";
// sha256 of "unionground-analytics:v1:" + each id, precomputed.
const HASH = { [USER]: "8dc2142cc248163115bb8383dbe00ddad6946e7fd8335a330dc34de9634e10df", [ORG]: "98c20800044a107ca97a1efeb9878f5e4d5f455d32c818e9fda93ece5bbb3c7e" };
const SURVEY_ID = "0192f0d6-2d0f-7a4e-9b3c-1e2d3c4b5a69";

const productOptions = () => posthog.default.init.mock.calls.find(([, , name]) => name === undefined)?.[1];

function sent(event, properties) {
  const clean = productOptions().before_send({ event, properties: { ...properties, token: "phc_fixture", $lib: "web", $lib_version: "1.438.19",
    $current_url: `${PORTAL_ORIGIN}/m/cases?case=42`, email: "taylor@example.org", distinct_id: "anon" } });
  if (!clean) return null;
  const { __sg_analytics_consent_period: _period, ...event_ } = clean;
  return event_;
}

const waitForState = (assertion) => vi.waitFor(assertion, { timeout: 5000, interval: 10 });

const served = (variant) => ({ ok: true, json: async () => ({ flags: { "member-coach-mark": { key: "member-coach-mark", enabled: true, variant } } }) });

describe("PostHog flags, heatmaps and the demo survey", () => {
  let observability;
  let location;
  let fetchMock;

  async function start(hostname = PORTAL_HOST) {
    observability = await import("../src/lib/observability.js");
    observability.initObservability({ hostname, location, history: { state: null, replaceState: vi.fn() }, storage: window.localStorage, automated: false });
  }

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    posthog.default._send_request = vi.fn();
    posthog.default.requestQueue.retriableRequest = vi.fn();
    window.localStorage.clear();
    window.sessionStorage.clear();
    location = { href: `${PORTAL_ORIGIN}/`, origin: PORTAL_ORIGIN, pathname: "/" };
    legal.files = demoSurveyReleaseFiles();
    fetchMock = vi.fn(async (url) => url === "/api/legal-pack?publication=1"
      ? { ok: true, json: async () => legal.files.deployment } : served("test"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_fixture");
    vi.stubEnv("VITE_POSTHOG_HOST", "https://e.unionground.net");
    vi.stubEnv("VITE_SENTRY_DSN", "");
    Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: null });
    Object.defineProperty(navigator, "globalPrivacyControl", { configurable: true, value: undefined });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  describe("member feature flags", () => {
    it("bootstraps member-coach-mark once per identity with only the two hashes, and every read is local", async () => {
      await start();
      expect(observability.memberFeatureFlag("member-coach-mark")).toBe("control");
      observability.syncObservabilityContext({ userId: USER, organizationId: ORG, view: "today" });
      await waitForState(() => expect(observability.memberFeatureFlag("member-coach-mark")).toBe("test"));
      expect(observability.memberFeatureFlag("member-coach-mark")).toBe("test");
      expect(observability.memberFeatureFlag("member-coach-mark")).toBe("test");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://e.unionground.net/flags/?v=2");
      expect(init).toMatchObject({ method: "POST", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
      expect(JSON.parse(init.body)).toEqual({ token: "phc_fixture", distinct_id: HASH[USER], geoip_disable: true, flag_keys_to_evaluate: ["member-coach-mark", "member-default-view"], groups: { organization: HASH[ORG] } });
      expect(init.body).not.toMatch(new RegExp(`${USER}|${ORG}`));
    });

    it("records one exposure through the analytics allowlist, under the hashes only", async () => {
      await start();
      observability.syncObservabilityContext({ userId: USER, organizationId: ORG, view: "today" });
      await waitForState(() => expect(observability.memberFeatureFlag("member-coach-mark")).toBe("test"));
      posthog.default.capture.mockClear();
      expect(observability.reportMemberFlagExposure("member-coach-mark")).toBe(true);
      expect(observability.reportMemberFlagExposure("member-coach-mark")).toBe(false);
      expect(posthog.default.capture).toHaveBeenCalledTimes(1);
      const exposure = sent(...posthog.default.capture.mock.calls[0]);
      expect(exposure.distinct_id).toBe(HASH[USER]);
      expect(exposure.properties).toMatchObject({ $feature_flag: "member-coach-mark", $feature_flag_response: "test", "$feature/member-coach-mark": "test",
        view: "today", app_surface: "member", $groups: { organization: HASH[ORG] } });
      expect(JSON.stringify(exposure)).not.toMatch(/taylor|cases|anon/i);
    });

    it("fails closed to the default when PostHog is unreachable, serves an unknown variant, or analytics is off", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await start();
      observability.syncObservabilityContext({ userId: USER, organizationId: ORG, view: "today" });
      await observability.memberIdentitySettled();
      await waitForState(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await expect(fetchMock.mock.results[0].value).rejects.toThrow("Failed to fetch");
      expect(observability.memberFeatureFlag("member-coach-mark")).toBe("control");
      expect(observability.reportMemberFlagExposure("member-coach-mark")).toBe(false);

      fetchMock.mockResolvedValueOnce(served("Taylor"));
      const flagsChanged = vi.fn();
      const unsubscribe = observability.subscribeMemberFeatureFlags(flagsChanged);
      observability.syncObservabilityContext({ userId: null, view: "landing" });
      observability.syncObservabilityContext({ userId: USER, organizationId: ORG, view: "today" });
      await waitForState(() => expect(flagsChanged).toHaveBeenCalledOnce());
      unsubscribe();
      expect(observability.memberFeatureFlag("member-coach-mark")).toBe("control");

      observability.syncObservabilityContext({ userId: null, view: "landing" });
      observability.syncObservabilityContext({ userId: USER, organizationId: ORG, view: "today" });
      await waitForState(() => expect(observability.memberFeatureFlag("member-coach-mark")).toBe("test"));
      expect(observability.memberFeatureFlag("member-coach-mark")).toBe("test");
      // The switch off: the default again, with no exposure and no new request.
      observability.setDemoAnalyticsEnabled(false, { storage: window.localStorage });
      expect(observability.memberFeatureFlag("member-coach-mark")).toBe("control");
      expect(observability.reportMemberFlagExposure("member-coach-mark")).toBe(false);
      const requests = fetchMock.mock.calls.length;
      observability.syncObservabilityContext({ userId: USER, organizationId: ORG, view: "cases" });
      await observability.memberIdentitySettled();
      expect(fetchMock).toHaveBeenCalledTimes(requests);
    });

    it("asks nothing under Do Not Track and drops a response for a member who signed out meanwhile", async () => {
      Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: "1" });
      await start();
      observability.syncObservabilityContext({ userId: USER, organizationId: ORG, view: "today" });
      await observability.memberIdentitySettled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(observability.memberFeatureFlag("member-coach-mark")).toBe("control");

      Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: null });
      vi.resetModules();
      let answer;
      fetchMock.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
      await start();
      observability.syncObservabilityContext({ userId: USER, organizationId: ORG, view: "today" });
      await waitForState(() => expect(answer).toBeTypeOf("function"));
      observability.syncObservabilityContext({ userId: null, view: "landing" });
      const response = served("test");
      const readResponse = vi.fn(response.json);
      answer({ ...response, json: readResponse });
      await waitForState(() => expect(readResponse).toHaveBeenCalledOnce());
      await readResponse.mock.results[0].value;
      expect(observability.memberFeatureFlag("member-coach-mark")).toBe("control");
    });
  });

  it("useMemberFeatureFlag follows the served value and records the exposure only where the member meets the flagged experience", async () => {
    const { renderHook, waitFor } = await import("@testing-library/react");
    await start();
    // The hook reads through the deferred loader; load it as the shell would.
    await (await import("../src/lib/deferredObservability.js")).startObservability();
    const { useMemberFeatureFlag } = await import("../src/lib/useMemberFeatureFlag.js");
    const hidden = renderHook(() => useMemberFeatureFlag("member-coach-mark", { exposed: false }));
    const shown = renderHook(() => useMemberFeatureFlag("member-coach-mark", { exposed: true }));
    expect(shown.result.current).toBe("control");
    observability.syncObservabilityContext({ userId: USER, organizationId: ORG, view: "today" });
    await waitFor(() => expect(shown.result.current).toBe("test"));
    expect(hidden.result.current).toBe("test");
    const exposures = posthog.default.capture.mock.calls.filter(([event]) => event === "$feature_flag_called");
    expect(exposures).toHaveLength(1);
    hidden.unmount();
    shown.unmount();
  });

  it("useMemberFeatureFlag records a served value equal to the default once the flags arrive after the exposure", async () => {
    // REQ-UG-AB-MEMBER-DEFAULT-ALT-VIEW-20261030: a member served
    // "control" re-renders nothing when the flags land, yet the control arm
    // of the experiment still needs its exposure.
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ flags: { "member-default-view": { key: "member-default-view", enabled: true, variant: "control" } } }) }));
    const { renderHook } = await import("@testing-library/react");
    await start();
    await (await import("../src/lib/deferredObservability.js")).startObservability();
    const { useMemberFeatureFlag } = await import("../src/lib/useMemberFeatureFlag.js");
    const shown = renderHook(() => useMemberFeatureFlag("member-default-view", { exposed: true }));
    expect(shown.result.current).toBe("control");
    observability.syncObservabilityContext({ userId: USER, organizationId: ORG, view: "today" });
    await waitForState(() => expect(posthog.default.capture.mock.calls.filter(([event]) => event === "$feature_flag_called")).toHaveLength(1));
    observability.syncObservabilityContext({ userId: USER, organizationId: ORG, view: "messages" });
    expect(shown.result.current).toBe("control");
    const exposures = posthog.default.capture.mock.calls.filter(([event]) => event === "$feature_flag_called");
    expect(exposures).toHaveLength(1);
    expect(sent(...exposures[0]).properties).toMatchObject({ $feature_flag: "member-default-view", $feature_flag_response: "control", "$feature/member-default-view": "control" });
    shown.unmount();
  });

  describe("public-page heatmaps", () => {
    const heatmapsSet = () => posthog.default.set_config.mock.calls.filter(([config]) => "capture_heatmaps" in config).map(([config]) => config.capture_heatmaps);
    // The server switch (MAIN 121 ruling): on for these cases unless a case turns it off.
    beforeEach(() => { globalThis.__UNION_GROUND_RUNTIME_CONFIG__ = { schema: 1, surface: "saas", configured: true, publicHeatmaps: true }; });
    afterEach(() => { delete globalThis.__UNION_GROUND_RUNTIME_CONFIG__; });

    it("stay off, and drop any heatmap event, until the server switch is on", async () => {
      for (const config of [undefined, { schema: 1, surface: "saas", configured: true }, { schema: 1, surface: "demo", configured: true, publicHeatmaps: true }]) {
        vi.resetModules();
        posthog.default.set_config.mockClear();
        posthog.default.init.mockClear();
        if (config) globalThis.__UNION_GROUND_RUNTIME_CONFIG__ = config; else delete globalThis.__UNION_GROUND_RUNTIME_CONFIG__;
        await start();
        observability.syncObservabilityContext({ userId: null, view: "landing" });
        location.pathname = "/pricing";
        observability.syncObservabilityContext({ userId: null, view: "pricing" });
        expect(heatmapsSet()).toEqual([]);
        expect(sent("$$heatmap", { $heatmap_data: { [`${PORTAL_ORIGIN}/pricing`]: [{ x: 5, y: 9, type: "click" }] } })).toBeNull();
        // Page views are unaffected.
        expect(sent("$pageview", { $pathname: "/pricing" })).not.toBeNull();
        location.pathname = "/";
      }
    });

    it("start on a public page and stop on a member route, at sign-in and when analytics goes off", async () => {
      await start();
      expect(productOptions()).toMatchObject({ capture_heatmaps: false, mask_all_text: true, disable_surveys: true });
      observability.syncObservabilityContext({ userId: null, view: "landing", authPending: true });
      expect(heatmapsSet()).toEqual([]);
      observability.syncObservabilityContext({ userId: null, view: "landing" });
      expect(heatmapsSet()).toEqual([true]);
      location.pathname = "/m/cases";
      observability.syncObservabilityContext({ userId: null, view: "cases" });
      expect(heatmapsSet()).toEqual([true, false]);
      location.pathname = "/pricing";
      observability.syncObservabilityContext({ userId: null, view: "pricing" });
      expect(heatmapsSet()).toEqual([true, false, true]);
      observability.syncObservabilityContext({ userId: USER, organizationId: ORG, view: "today" });
      expect(heatmapsSet()).toEqual([true, false, true, false]);
      observability.syncObservabilityContext({ userId: null, view: "pricing" });
      expect(heatmapsSet()).toEqual([true, false, true, false, true]);
      observability.setDemoAnalyticsEnabled(false, { storage: window.localStorage });
      expect(heatmapsSet()).toEqual([true, false, true, false, true, false]);
    });

    it("send positions on public pages only, never a member route or a signed-in member's", async () => {
      await start();
      observability.syncObservabilityContext({ userId: null, view: "landing" });
      const data = { [`${PORTAL_ORIGIN}/pricing?ref=x`]: [{ x: 5, y: 9, target_fixed: false, type: "click" }], [`${PORTAL_ORIGIN}/m/cases`]: [{ x: 1, y: 1, type: "click" }] };
      const heatmap = sent("$$heatmap", { $heatmap_data: data, $viewport_width: 1280, $viewport_height: 720 });
      expect(heatmap).toMatchObject({ distinct_id: "$posthog_cookieless", properties: { $cookieless_mode: true, app_surface: "public_site",
        $heatmap_data: { [`${PORTAL_ORIGIN}/pricing`]: [{ x: 5, y: 9, target_fixed: false, type: "click" }] }, $viewport_width: 1280, $viewport_height: 720 } });
      expect(JSON.stringify(heatmap)).not.toMatch(/\/m\/|taylor|ref=/);
      observability.syncObservabilityContext({ userId: USER, organizationId: ORG, view: "today" });
      await observability.memberIdentitySettled();
      expect(sent("$$heatmap", { $heatmap_data: { [`${PORTAL_ORIGIN}/pricing`]: [{ x: 5, y: 9, type: "click" }] } })).toBeNull();
    });

    it("never run on the demo or for an automated browser", async () => {
      location = { href: `${SAMPLE_ORIGIN}/`, origin: SAMPLE_ORIGIN, pathname: "/" };
      await start(SAMPLE_HOST);
      observability.syncObservabilityContext({ userId: null, view: "landing" });
      expect(productOptions()).toMatchObject({ capture_heatmaps: false });
      expect(posthog.default.set_config.mock.calls.some(([config]) => config.capture_heatmaps === true)).toBe(false);
    });
  });

  describe("the public-demo survey", () => {
    const survey = (questions, extra = {}) => ({ id: SURVEY_ID, name: "Demo feedback", start_date: "2026-10-29T00:00:00Z", end_date: null, questions, ...extra });
    const rating = { id: "q-rating", type: "rating", scale: 5, question: "How useful was the demo?" };
    const choice = { id: "q-choice", type: "single_choice", choices: ["Grievances", "Elections", "Dues"], question: "What would you use first?" };

    // The shell names the page it shows on main (#9776); the offer stands on Home only.
    const visit = (view) => {
      const main = document.querySelector("main#main-content");
      if (main) main.dataset.view = view;
      observability.syncObservabilityContext({ demoActive: true, view });
    };

    async function demo() {
      document.body.innerHTML = '<main id="main-content" tabindex="-1"><article>Demo content</article></main>';
      location = { href: `${SAMPLE_ORIGIN}/`, origin: SAMPLE_ORIGIN, pathname: "/" };
      await start(SAMPLE_HOST);
      return productOptions();
    }

    it("is enabled on the demo only, never displayed automatically, and offered once after a few demo views", async () => {
      posthog.default.getSurveys.mockImplementation((callback) => callback([survey([{ id: "q-open", type: "open", question: "Anything else?" }]), survey([rating, choice])]));
      const options = await demo();
      expect(options).toMatchObject({ disable_surveys: false, disable_surveys_automatic_display: true });
      visit("cases");
      visit("tasks");
      expect(posthog.default.displaySurvey).not.toHaveBeenCalled();
      visit("voting");
      visit("today");
      expect(posthog.default.getSurveys).toHaveBeenCalledTimes(1);
      expect(posthog.default.displaySurvey).not.toHaveBeenCalled();
      await waitForState(() => expect(document.querySelector(".demo-survey-slot button")).not.toBeNull());
      // #9776 (demo walk of Nov 24, 2026): the offer stood above every page's
      // heading. It stands on Home only, and is back at the top of Home when
      // the visitor returns.
      visit("events");
      expect(document.querySelector(".demo-survey-slot")).toBeNull();
      visit("today");
      expect(document.querySelector("main").firstElementChild).toHaveClass("demo-survey-slot");
      expect(posthog.default.getSurveys).toHaveBeenCalledTimes(1);
      document.querySelector('.demo-survey-slot button').click();
      expect(posthog.default.displaySurvey).toHaveBeenCalledTimes(1);
      expect(posthog.default.displaySurvey).toHaveBeenCalledWith(SURVEY_ID, expect.objectContaining({ displayType: "inline", selector: "#ug-demo-survey-slot" }));
      // An opened survey left by leaving Home is kept, not re-rendered: on the
      // return the same open slot, with whatever the SDK drew in it, is back.
      const slot = document.getElementById("ug-demo-survey-slot");
      slot.append(Object.assign(document.createElement("div"), { className: "ph-survey", textContent: "rating in progress" }));
      visit("events");
      expect(document.getElementById("ug-demo-survey-slot")).toBeNull();
      visit("today");
      expect(document.getElementById("ug-demo-survey-slot")).toBe(slot);
      expect(slot.hidden).toBe(false);
      expect(slot).toHaveTextContent("rating in progress");
      expect(posthog.default.displaySurvey).toHaveBeenCalledTimes(1);
    });

    it("refuses a survey with an open question, an open choice or an out-of-range scale", async () => {
      const { allowedDemoSurvey } = await import("../src/lib/observability.js");
      expect(allowedDemoSurvey(survey([rating, choice]))).not.toBeNull();
      expect(allowedDemoSurvey(survey([{ id: "q", type: "open" }]))).toBeNull();
      expect(allowedDemoSurvey(survey([{ ...choice, hasOpenChoice: true }]))).toBeNull();
      expect(allowedDemoSurvey(survey([{ ...rating, scale: 100 }]))).toBeNull();
      expect(allowedDemoSurvey(survey([rating], { end_date: "2026-10-30T00:00:00Z" }))).toBeNull();
      expect(allowedDemoSurvey(survey([]))).toBeNull();
    });

    it("dismisses the voluntary offer with Escape and does not reopen it on later demo pages", async () => {
      posthog.default.getSurveys.mockImplementation((callback) => callback([survey([rating])]));
      await demo();
      for (const view of ["cases", "tasks", "today"]) visit(view);
      await waitForState(() => expect(document.querySelector(".demo-survey-close")).not.toBeNull());
      const close = document.querySelector(".demo-survey-close");
      close.focus();
      close.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(document.querySelector(".demo-survey-slot")).toBeNull();
      expect(posthog.default.capture).toHaveBeenCalledWith("survey dismissed", { $survey_id: SURVEY_ID, is_demo: true });
      visit("events");
      visit("today");
      expect(posthog.default.getSurveys).toHaveBeenCalledTimes(1);
      expect(posthog.default.displaySurvey).not.toHaveBeenCalled();
      expect(document.querySelector(".demo-survey-slot")).toBeNull();
    });

    it("sends only ratings within scale and the survey's own choices", async () => {
      const { allowedDemoSurvey, sanitizeDemoSurveyEvent } = await import("../src/lib/observability.js");
      const allowed = allowedDemoSurvey(survey([rating, choice, { id: "q-multi", type: "multiple_choice", choices: ["A", "B"] }]));
      const clean = sanitizeDemoSurveyEvent({ event: "survey sent", properties: {
        $survey_id: SURVEY_ID, $survey_name: "Demo feedback", $survey_iteration: 2, $survey_completed: true, $survey_submission_id: SURVEY_ID,
        "$survey_response_q-rating": 4, "$survey_response_q-choice": "My steward Taylor never answers", "$survey_response_q-multi": ["A", "B"],
        "$survey_response_q-open": "taylor@example.org", $survey_response: "free text", $survey_questions: [{ id: "q-rating", question: "?", response: 4 }],
        $set: { "$survey_responded/x": true }, $current_url: `${SAMPLE_ORIGIN}/demo/cases?x=1`, is_demo: true,
      } }, allowed);
      expect(clean.properties).toMatchObject({ $survey_id: SURVEY_ID, $survey_iteration: 2, $survey_completed: true, "$survey_response_q-rating": 4, "$survey_response_q-multi": ["A", "B"], is_demo: true });
      for (const key of ["$survey_response_q-choice", "$survey_response_q-open", "$survey_response", "$survey_questions", "$survey_name", "$set"]) expect(clean.properties).not.toHaveProperty(key);
      expect(JSON.stringify(clean)).not.toMatch(/taylor|free text/i);
      expect(sanitizeDemoSurveyEvent({ event: "survey sent", properties: { $survey_id: "another", "$survey_response_q-rating": 4 } }, allowed)).toBeNull();
      expect(sanitizeDemoSurveyEvent({ event: "survey sent", properties: { $survey_id: SURVEY_ID, "$survey_response_q-rating": 9 } }, allowed).properties).not.toHaveProperty("$survey_response_q-rating");
      expect(sanitizeDemoSurveyEvent({ event: "survey shown", properties: { $survey_id: SURVEY_ID } }, null)).toBeNull();
    });

    it("is stopped by the demo analytics switch: the popover is removed, surveys are disabled and nothing more is offered", async () => {
      posthog.default.getSurveys.mockImplementation((callback) => callback([survey([rating])]));
      await demo();
      for (const view of ["cases", "tasks", "today"]) visit(view);
      await waitForState(() => expect(document.querySelector(".demo-survey-slot")).not.toBeNull());
      const popover = document.createElement("div");
      popover.className = `PostHogSurvey-${SURVEY_ID}`;
      document.body.append(popover);
      observability.setDemoAnalyticsEnabled(false, { storage: window.localStorage });
      expect(document.querySelector(`.PostHogSurvey-${SURVEY_ID}`)).toBeNull();
      expect(posthog.default.set_config).toHaveBeenCalledWith({ disable_surveys: true });
      // A survey event captured after the switch went off never leaves.
      expect(productOptions().before_send({ event: "survey sent", properties: { $survey_id: SURVEY_ID, "$survey_response_q-rating": 4 } })).toBeNull();
    });

    it("drops legal publication proof that arrives after analytics is switched off", async () => {
      let answer;
      let offering;
      fetchMock.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
      posthog.default.getSurveys.mockImplementation((callback) => { offering = callback([survey([rating])]); });
      await demo();
      for (const view of ["cases", "tasks", "today"]) visit(view);
      await waitForState(() => expect(answer).toBeTypeOf("function"));
      observability.setDemoAnalyticsEnabled(false, { storage: window.localStorage });
      answer({ ok: true, json: async () => legal.files.deployment });
      await offering;
      expect(document.querySelector(".demo-survey-slot")).toBeNull();
      expect(sessionStorage.getItem("ug:demo-survey-offered:v1")).toBeNull();
      expect(posthog.default.displaySurvey).not.toHaveBeenCalled();
    });
  });
});
