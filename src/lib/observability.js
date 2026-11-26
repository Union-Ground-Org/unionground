import posthog from "posthog-js";
// Bundles the exception autocapture runtime, which the SDK otherwise lazy-loads
// from its asset host; the diagnostics instance disables that loading.
import "posthog-js/dist/exception-autocapture.js";
import * as Sentry from "@sentry/react";
import {
  redactSensitiveText,
  sanitizePostHogEvent,
} from "./observabilityPrivacy.js";
import { isDemoHost, isSaasHost } from "./demoOrigin.js";
import {
  applyDemoAnalyticsPreferenceFromUrl,
  DEMO_ANALYTICS_PREFERENCE_KEY,
  defaultBrowserStorage,
  isDemoAnalyticsEnabled,
  notifyDemoAnalyticsListeners,
  recordAnalyticsChoice,
  setProductAnalyticsSignal,
} from "./analyticsPreference.js";
import { privateSentryOptions, privateSentryTransport } from "./sentryPrivacy.js";
import { ANALYTICS_ACTIONS, ANALYTICS_PSEUDONYM_PREFIX, analyticsFlagsFromResponse, analyticsFlagsRequest, analyticsFlagValue, sanitizePostHogAnalyticsEvent, sanitizePostHogExceptionEvent } from "./posthogPrivacy.js";
import { loadDemoSurveyPresentation } from "./demoSurveyPresentation.js";

// The release is the build sha the page's own document carries (index.html's
// union-ground-build-sha marker, written by the build), read at run time. No
// hashed chunk holds it, so a build of unchanged sources keeps every chunk name
// and returning visitors keep their cached scripts.
export function documentBuildRelease(doc = globalThis.document) {
  const sha = doc?.querySelector?.('meta[name="union-ground-build-sha"]')?.getAttribute("content") ?? "";
  return /^[a-f0-9]{40}$/.test(sha) ? sha : "development";
}
const release = documentBuildRelease();
function isProductionObservabilityHost(hostname) {
  return isSaasHost(hostname) || isDemoHost(hostname);
}

let posthogEnabled = false;
let posthogInitialized = false;
let posthogConfiguration = null;
let sentryEnabled = false;
// PostHog error tracking (owner order, October 27, 2026): a second, named
// posthog-js instance that runs wherever Sentry runs, including the member
// product, and carries nothing but scrubbed $exception events. It shares no
// persistence, consent state or send gate with the demo analytics instance:
// diagnostics are the separate reliability monitoring the disclosure names,
// not product analytics, so the analytics switch and Do Not Track govern the
// analytics instance only, as they govern Sentry today.
let diagnosticsClient = null;
let diagnosticsEnabled = false;
let desiredContext = { userId: null, organizationId: null, demoActive: false, view: null, authPending: false };
let appliedContext = { mode: null, userId: null, organizationId: null, view: null };
// OPS-UG-POSTHOG-ANALYTICS-ON-MEMBER-PRODUCT-AND-PUBLIC-PAGES-20261027
// (#6247): on the public site the same analytics instance runs in cookieless
// mode with memory persistence. Signed-in members are counted under a one-way
// hash of their user identifier, grouped by a one-way hash of their
// organization identifier, with view labels and allowlisted action labels
// only; public pages report cookieless page views. The Product analytics
// switch, Do Not Track and Global Privacy Control gate both, and nothing is
// written to cookies or storage.
let memberIdentity = null;
let memberIdentityRequest = 0;
// Settles once the member identity last requested is known (or abandoned).
let memberIdentityPending = Promise.resolve();
let analyticsLocation = null;
// No public page view is reported before App has said whether a session exists.
let contextSynced = false;
let demoStartedAt = 0;
let demoViews = new Set();
let demoActionCount = 0;
let lifecycleInstalled = false;
let storageListenerInstalled = false;
let analyticsStorage;
let analyticsConsentPeriod = 0;
let awaitingSharedIdentity = false;
const CONSENT_PERIOD_KEY = "__sg_analytics_consent_period";
// OPS-UG-POSTHOG-FLAGS-EXPERIMENTS-SURVEYS-HEATMAPS-20261027 (#6248):
// member feature flags are bootstrapped once per identity from PostHog's
// /flags endpoint with only the two hashes the analytics events already
// carry, and every read is local. Until they arrive, while analytics is off
// and whenever the request fails, each flag reads as its default.
const FLAGS_TIMEOUT_MS = 3000;
let memberFlags = { identity: null, values: null };
let memberFlagsRequest = 0;
const exposedFlags = new Set();
const flagListeners = new Set();
// Public-page heatmaps (#6248): on only while a visitor without a session is
// on a public page of the public site with analytics allowed, and only once
// the server's POSTHOG_PUBLIC_HEATMAPS switch says so (MAIN 121 ruling: off
// until the privacy text that describes them is published).
let publicHeatmapsOn = false;

function publicHeatmapsSwitchOn() {
  const config = globalThis.__UNION_GROUND_RUNTIME_CONFIG__;
  return config?.surface === "saas" && config.publicHeatmaps === true;
}
// The one demo survey (#6248): offered once per page after a few demo views,
// and only a survey whose every question is a rating or a closed choice.
const DEMO_SURVEY_AFTER_VIEWS = 3;
const DEMO_SURVEY_QUESTION_TYPES = new Set(["rating", "single_choice", "multiple_choice"]);
let demoSurveyOffered = false;
let demoSurvey = null;
let demoSurveyPresentation = null;

function currentAnalyticsStorage() {
  return analyticsStorage === undefined ? defaultBrowserStorage() : analyticsStorage;
}

const SAFE_TELEMETRY_LABEL = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function safeTelemetryLabel(value) {
  const label = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SAFE_TELEMETRY_LABEL.test(label) ? label : null;
}

function deploymentEnvironment(hostname = typeof window === "undefined" ? "" : window.location.hostname) {
  const host = String(hostname || "").toLowerCase();
  if (isProductionObservabilityHost(host)) return "production";
  if (host.endsWith(".vercel.app")) return "preview";
  return import.meta.env.PROD ? "production" : "development";
}

export function isAutomatedBrowser(navigatorLike = typeof navigator === "undefined" ? null : navigator) {
  if (!navigatorLike) return false;
  const userAgent = String(navigatorLike.userAgent || "");
  return navigatorLike.webdriver === true || /(?:HeadlessChrome|Playwright|Puppeteer)/i.test(userAgent);
}

function defaultAutomationSignal() {
  return isAutomatedBrowser();
}

export function shouldCaptureDemoAnalytics({
  hostname = typeof window === "undefined" ? "" : window.location.hostname,
  storage = defaultBrowserStorage(),
  command = null,
  automated = defaultAutomationSignal(),
} = {}) {
  if (!isDemoHost(hostname) || automated || command === "off") return false;
  if (command === "on") return true;
  return isDemoAnalyticsEnabled({ storage });
}

// Do Not Track or Global Privacy Control turns product analytics off on
// the public site, whatever the switch says.
export function browserPrivacySignal(navigatorLike = typeof navigator === "undefined" ? null : navigator,
  windowLike = typeof window === "undefined" ? null : window) {
  const dnt = String(navigatorLike?.doNotTrack ?? windowLike?.doNotTrack ?? navigatorLike?.msDoNotTrack ?? "");
  return dnt === "1" || dnt === "yes" || navigatorLike?.globalPrivacyControl === true;
}

export function shouldCaptureProductAnalytics({
  hostname = typeof window === "undefined" ? "" : window.location.hostname,
  storage = defaultBrowserStorage(),
  automated = defaultAutomationSignal(),
  privacySignal = browserPrivacySignal(),
} = {}) {
  if (!isSaasHost(hostname) || automated || privacySignal) return false;
  return isDemoAnalyticsEnabled({ storage });
}

function productAnalyticsSurface() {
  return posthogConfiguration?.surface === "product";
}

function productCaptureAllowed() {
  return posthogEnabled && isDemoAnalyticsEnabled({ storage: currentAnalyticsStorage() }) && !browserPrivacySignal();
}

export function shouldEnableSentry({
  hostname = typeof window === "undefined" ? "" : window.location.hostname,
  automated = defaultAutomationSignal(),
  previewEnabled = import.meta.env.VITE_SENTRY_PREVIEW_ENABLED === "1",
} = {}) {
  return !automated && (isProductionObservabilityHost(hostname)
    || (previewEnabled && String(hostname).endsWith(".vercel.app")));
}

function finishDemoSession({ transport } = {}) {
  if (!posthogEnabled || !demoStartedAt) return;
  const durationSeconds = Math.max(1, Math.round((Date.now() - demoStartedAt) / 1000));
  posthog.capture("demo_ended", {
    is_demo: true,
    duration_seconds: durationSeconds,
    views_seen: demoViews.size,
    actions_count: demoActionCount,
  }, transport ? { transport } : undefined);
  posthog.stopSessionRecording();
  demoStartedAt = 0;
  demoViews = new Set();
  demoActionCount = 0;
}

function captureDemoView(view) {
  demoSurveyPresentation?.place();
  const safeView = safeTelemetryLabel(view);
  if (!posthogEnabled || !demoStartedAt || !safeView || demoViews.has(safeView)) return;
  demoViews.add(safeView);
  posthog.capture("demo_viewed", {
    is_demo: true,
    view: safeView,
    view_number: demoViews.size,
  });
  if (demoViews.size >= DEMO_SURVEY_AFTER_VIEWS) offerDemoSurvey();
}

// A survey PostHog may show on the demo: running, and asking only ratings and
// closed choices without an open "other" answer. Its answers are recorded
// against this definition and nothing else leaves (demoSurveyBeforeSend).
export function allowedDemoSurvey(survey) {
  if (!survey || typeof survey.id !== "string" || !Array.isArray(survey.questions) || !survey.questions.length || survey.questions.length > 5) return null;
  if (!survey.start_date || survey.end_date) return null;
  const questions = new Map();
  for (const question of survey.questions) {
    if (!question || typeof question.id !== "string" || !DEMO_SURVEY_QUESTION_TYPES.has(question.type)) return null;
    if (question.type === "rating") {
      const scale = Number(question.scale);
      if (!Number.isInteger(scale) || scale < 2 || scale > 10) return null;
      questions.set(question.id, { type: "rating", scale });
    } else {
      if (question.hasOpenChoice || !Array.isArray(question.choices) || !question.choices.every((choice) => typeof choice === "string")) return null;
      questions.set(question.id, { type: question.type, choices: new Set(question.choices) });
    }
  }
  return { id: survey.id, questions };
}

function surveyAlreadySeen(surveyId) {
  try {
    const store = window.localStorage;
    return Object.keys(store).some((key) => key === `seenSurvey_${surveyId}` || key.startsWith(`seenSurvey_${surveyId}_`));
  } catch {
    return true;
  }
}

function offerDemoSurvey() {
  if (demoSurveyOffered || typeof posthog.getSurveys !== "function" || typeof posthog.displaySurvey !== "function") return;
  demoSurveyOffered = true;
  try {
    posthog.getSurveys(async (surveys) => {
      if (!posthogEnabled || appliedContext.mode !== "demo" || !isDemoAnalyticsEnabled({ storage: currentAnalyticsStorage() })) return;
      const survey = (Array.isArray(surveys) ? surveys : []).map(allowedDemoSurvey).find(Boolean);
      if (!survey || surveyAlreadySeen(survey.id)) return;
      demoSurvey = survey;
      const isEnabled = () => demoSurvey === survey && posthogEnabled && appliedContext.mode === "demo" && isDemoAnalyticsEnabled({ storage: currentAnalyticsStorage() });
      const presentation = await loadDemoSurveyPresentation({
        isEnabled,
        display: (selector) => {
          if (isEnabled()) {
            posthog.displaySurvey(survey.id, { displayType: "inline", selector, ignoreConditions: true, ignoreDelay: true });
          }
        },
        onDismiss: () => {
          posthog.capture("survey dismissed", { $survey_id: survey.id, is_demo: true });
          demoSurveyPresentation = null;
        },
      });
      if (isEnabled()) demoSurveyPresentation = presentation;
      else presentation?.remove();
    });
  } catch {
    // A survey never breaks the demo.
  }
}

const SURVEY_EVENTS = new Set(["survey shown", "survey sent", "survey dismissed"]);
const SURVEY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function surveyAnswer(question, value) {
  if (question.type === "rating") return Number.isInteger(value) && value >= 0 && value <= question.scale ? value : undefined;
  if (question.type === "single_choice") return typeof value === "string" && question.choices.has(value) ? value : undefined;
  return Array.isArray(value) && value.length && value.length <= question.choices.size && value.every((choice) => question.choices.has(choice)) ? [...value] : undefined;
}

// The demo's survey events, rebuilt: the survey identity and, on "survey
// sent", each answer that is a rating within its scale or one of the
// survey's own choices. Free text, an answer to another survey or question,
// and every other survey property are dropped.
export function sanitizeDemoSurveyEvent(event, survey = demoSurvey) {
  if (!SURVEY_EVENTS.has(event?.event)) return event;
  const source = event.properties ?? {};
  if (!survey || source.$survey_id !== survey.id) return null;
  const base = sanitizePostHogEvent({ ...event, properties: Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith("$survey") && !key.startsWith("$set"))) });
  const properties = { ...base.properties, $survey_id: survey.id };
  if (Number.isInteger(source.$survey_iteration)) properties.$survey_iteration = source.$survey_iteration;
  if (typeof source.$survey_submission_id === "string" && SURVEY_UUID.test(source.$survey_submission_id)) properties.$survey_submission_id = source.$survey_submission_id;
  if (event.event === "survey sent") {
    if (typeof source.$survey_completed === "boolean") properties.$survey_completed = source.$survey_completed;
    for (const [id, question] of survey.questions) {
      const answer = surveyAnswer(question, source[`$survey_response_${id}`]);
      if (answer !== undefined) properties[`$survey_response_${id}`] = answer;
    }
  }
  return { ...base, properties };
}

// The switch going off removes a survey already on screen; the SDK renders
// one only while capturing, so none appears again until it is back on.
function removeDemoSurvey() {
  demoSurveyPresentation?.remove();
  demoSurveyPresentation = null;
  demoSurvey = null;
  try { posthog.set_config?.({ disable_surveys: true }); } catch { /* a survey never breaks the demo */ }
  if (typeof document === "undefined") return;
  try {
    document.querySelectorAll('[class^="PostHogSurvey-"], [class*=" PostHogSurvey-"]').forEach((node) => node.remove());
  } catch {
    // Nothing on screen to remove.
  }
}

function startDemoSession(view) {
  demoStartedAt = Date.now();
  demoViews = new Set();
  demoActionCount = 0;
  posthog.startSessionRecording({ sampling: true, linked_flag: true });
  posthog.capture("demo_started", {
    is_demo: true,
    entry_view: safeTelemetryLabel(view) || "unknown",
  });
  captureDemoView(view);
}

function observabilityMode() {
  if (desiredContext.demoActive) return "demo";
  return desiredContext.userId ? "authenticated" : "demo_site";
}

async function pseudonym(value) {
  const bytes = new TextEncoder().encode(`${ANALYTICS_PSEUDONYM_PREFIX}${value}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The identity is computed after the context changes, so a member signed out,
// switched or turned off while the digest runs is never counted.
function requestMemberIdentity() {
  memberIdentity = null;
  clearMemberFlags();
  const request = ++memberIdentityRequest;
  const { userId, organizationId } = desiredContext;
  if (!userId || !globalThis.crypto?.subtle) return;
  memberIdentityPending = Promise.all([pseudonym(userId), organizationId ? pseudonym(organizationId) : null]).then(([distinctId, organization]) => {
    if (request !== memberIdentityRequest || !posthogEnabled || desiredContext.userId !== userId
      || desiredContext.organizationId !== organizationId || observabilityMode() !== "authenticated") return;
    memberIdentity = { userId, organizationId, distinctId, organization };
    captureMemberView();
    loadMemberFlags(memberIdentity);
  }, () => {});
}

function notifyFlagListeners() {
  flagListeners.forEach((listener) => listener());
}

function loadMemberFlags(identity) {
  const request = ++memberFlagsRequest;
  const body = analyticsFlagsRequest(posthogConfiguration?.token, identity);
  if (!body || typeof fetch !== "function" || !productCaptureAllowed()) return;
  let signal;
  try { signal = AbortSignal.timeout(FLAGS_TIMEOUT_MS); } catch { signal = undefined; }
  Promise.resolve().then(() => fetch(`${posthogConfiguration.host}/flags/?v=2`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    signal,
  })).then((response) => (response?.ok ? response.json() : null)).then((payload) => {
    if (request !== memberFlagsRequest || memberIdentity !== identity || !productCaptureAllowed()) return;
    memberFlags = { identity, values: analyticsFlagsFromResponse(payload) };
    notifyFlagListeners();
  }).catch(() => {});
}

function clearMemberFlags() {
  memberFlagsRequest += 1;
  exposedFlags.clear();
  if (memberFlags.values === null) return;
  memberFlags = { identity: null, values: null };
  notifyFlagListeners();
}

function memberFlagValues() {
  return memberIdentity && memberFlags.identity === memberIdentity && productCaptureAllowed() ? memberFlags.values : null;
}

// A member feature flag (#6248): the value PostHog served this member, or the
// flag's default. Reading never sends anything.
export function memberFeatureFlag(key) {
  return analyticsFlagValue(memberFlagValues(), key);
}

export function subscribeMemberFeatureFlags(listener) {
  flagListeners.add(listener);
  return () => { flagListeners.delete(listener); };
}

// The experiment exposure, once per identity and flag, only for a value
// PostHog served; productBeforeSend rebuilds it from the allowlist.
export function reportMemberFlagExposure(key) {
  const values = memberFlagValues();
  if (!values || !Object.prototype.hasOwnProperty.call(values, key) || exposedFlags.has(key)) return false;
  exposedFlags.add(key);
  posthog.capture("$feature_flag_called", { $feature_flag: key, $feature_flag_response: analyticsFlagValue(values, key), view: desiredContext.view || "unknown" });
  return true;
}

function publicHeatmapsAllowed() {
  const path = analyticsLocation?.pathname;
  return publicHeatmapsSwitchOn() && posthogInitialized && productAnalyticsSurface() && productCaptureAllowed() && contextSynced && !desiredContext.authPending
    && observabilityMode() === "demo_site" && typeof path === "string" && path !== "/m" && !path.startsWith("/m/");
}

// Heatmaps follow the context: started on a public page, stopped (and their
// buffer discarded) on a member route, at sign-in or when analytics goes off.
function syncPublicHeatmaps() {
  const next = publicHeatmapsAllowed();
  if (next === publicHeatmapsOn) return;
  publicHeatmapsOn = next;
  try { posthog.set_config({ capture_heatmaps: next }); } catch { /* analytics never breaks the page */ }
}

function captureMemberView() {
  if (!memberIdentity || !productCaptureAllowed()) return;
  posthog.capture("$pageview", { view: desiredContext.view || "unknown" });
}

function capturePublicView() {
  const path = analyticsLocation?.pathname;
  if (!contextSynced || !productCaptureAllowed() || desiredContext.authPending || typeof path !== "string") return;
  // A member route seen before the session is restored is never a public page.
  if (path === "/m" || path.startsWith("/m/")) return;
  posthog.capture("$pageview", { $pathname: path });
}

function applyProductContext(nextMode, { modeChanged, userChanged }) {
  const organizationChanged = desiredContext.organizationId !== appliedContext.organizationId;
  const viewChanged = desiredContext.view !== appliedContext.view;
  if (nextMode === "authenticated") {
    if (modeChanged || userChanged || organizationChanged) requestMemberIdentity();
    else if (viewChanged) captureMemberView();
    return;
  }
  memberIdentityRequest += 1;
  memberIdentity = null;
  clearMemberFlags();
  if (nextMode === "demo_site" && (modeChanged || viewChanged || appliedContext.authPending)) capturePublicView();
}

// before_send for the public site: the event is rebuilt from the allowlist
// under the identity of the context it was captured in, or dropped.
function productBeforeSend(event) {
  if (!productCaptureAllowed() || (event?.event === "$$heatmap" && !publicHeatmapsSwitchOn())) return null;
  const metadata = { surface: "web", environment: posthogConfiguration?.environment, release,
    origin: analyticsLocation?.origin };
  const mode = observabilityMode();
  const clean = mode === "authenticated" && memberIdentity && memberIdentity.userId === desiredContext.userId
    ? sanitizePostHogAnalyticsEvent(event, { ...metadata, identity: memberIdentity })
    : mode === "demo_site" ? sanitizePostHogAnalyticsEvent(event, { ...metadata, identity: null, cookieless: true }) : null;
  return clean ? { ...clean, [CONSENT_PERIOD_KEY]: analyticsConsentPeriod } : null;
}

function applyObservabilityContext() {
  const nextMode = observabilityMode();
  const nextUserId = desiredContext.userId;
  const modeChanged = nextMode !== appliedContext.mode;
  const userChanged = nextUserId !== appliedContext.userId;

  if (sentryEnabled && (modeChanged || userChanged)) {
    Sentry.setUser(null);
  }
  if (!posthogEnabled) {
    appliedContext = { mode: nextMode, userId: nextUserId, organizationId: desiredContext.organizationId, view: desiredContext.view, authPending: desiredContext.authPending };
    return;
  }
  if (productAnalyticsSurface()) {
    applyProductContext(nextMode, { modeChanged, userChanged });
    syncPublicHeatmaps();
    appliedContext = { mode: nextMode, userId: nextUserId, organizationId: desiredContext.organizationId, view: desiredContext.view, authPending: desiredContext.authPending };
    return;
  }

  if (appliedContext.mode === "demo" && nextMode !== "demo") finishDemoSession();

  if (modeChanged) {
    if (nextMode === "authenticated") {
      posthog.reset();
      posthog.opt_out_capturing();
    } else {
      if (appliedContext.mode === "authenticated") posthog.reset();
      posthog.opt_in_capturing({ captureEventName: false });
      posthog.capture("$pageview", {
        app_surface: nextMode === "demo" ? "demo" : "demo_site",
      });
    }
  }

  if (nextMode === "demo") {
    if (appliedContext.mode !== "demo") startDemoSession(desiredContext.view);
    else if (desiredContext.view !== appliedContext.view) captureDemoView(desiredContext.view);
  }

  appliedContext = { mode: nextMode, userId: nextUserId, organizationId: desiredContext.organizationId, view: desiredContext.view };
}

function handlePageHide(event) {
  if (!event?.persisted && appliedContext.mode === "demo") {
    finishDemoSession({ transport: "sendBeacon" });
  }
}

// PostHog's batch and retry queues do not re-check consent before sending, so
// events captured just before an opt-out would still leave on the next flush
// or at pagehide. Direct SDK requests pass through _send_request, and since
// posthog-js 1.438 batched and retried events go through the retry queue's
// retriableRequest instead; both are gated, and once the Product analytics
// switch is off, here or in another tab, the request is dropped
// (REQ-UG-VISIBLE-ANALYTICS-OPT-OUT-20261016). An SDK without both
// hooks is never started. Compression is off (see init) so nothing runs
// between these gates and the transport.
const strippedConsentPeriods = new WeakMap();

function consentPeriodOf(event) {
  return event?.[CONSENT_PERIOD_KEY] ?? strippedConsentPeriods.get(event);
}

function gatePosthogRequest(options) {
  if (!posthogEnabled || !isDemoAnalyticsEnabled({ storage: currentAnalyticsStorage() })) return undefined;
  if (productAnalyticsSurface() && browserPrivacySignal()) return undefined;
  let data = options.data;
  if (Array.isArray(data)) {
    data = data.filter((event) => consentPeriodOf(event) === analyticsConsentPeriod)
      .map(withoutConsentPeriod);
    if (data.length === 0) return undefined;
  } else if (typeof data?.event === "string") {
    // The initial page view and send_instantly captures are singleton
    // objects, including when the SDK retries a failed request.
    if (consentPeriodOf(data) !== analyticsConsentPeriod) return undefined;
    data = withoutConsentPeriod(data);
  }
  // Non-event requests (remote configuration, flags) do not carry a capture
  // period. The retry queue re-sends the data it was given, so stripped events
  // keep their period in strippedConsentPeriods for the next attempt.
  return { ...options, data };
}

function installPosthogSendGate() {
  const send = posthog._send_request;
  if (typeof send !== "function") return false;
  posthog._send_request = function gatedSend(options) {
    const gated = gatePosthogRequest(options);
    return gated ? send.call(this, gated) : undefined;
  };
  return true;
}

function installPosthogRetryGate() {
  const queue = Object.values(posthog).find((value) => typeof value?.retriableRequest === "function");
  if (!queue) return false;
  const retriableRequest = queue.retriableRequest;
  queue.retriableRequest = function gatedRetriableRequest(options, transport) {
    const gated = gatePosthogRequest(options);
    return gated ? retriableRequest.call(this, gated, transport) : undefined;
  };
  return true;
}

function withoutConsentPeriod(event) {
  const copy = { ...event };
  const period = consentPeriodOf(event);
  delete copy[CONSENT_PERIOD_KEY];
  if (period !== undefined) strippedConsentPeriods.set(copy, period);
  return copy;
}

function initializePosthog() {
  if (posthogInitialized || !posthogConfiguration) return;
  if (!installPosthogSendGate()) {
    posthogConfiguration = null;
    return;
  }
  const { token, host, environment } = posthogConfiguration;
  if (productAnalyticsSurface()) {
    try {
      posthog.init(token, { api_host: host, ...productPosthogOptions({ environment }) });
    } catch {
      // Analytics never breaks the member product.
      posthogConfiguration = null;
      return;
    }
  } else posthog.init(token, {
    api_host: host,
    ui_host: "https://us.posthog.com",
    defaults: "2026-06-25",
    autocapture: false,
    capture_pageview: "history_change",
    capture_pageleave: true,
    capture_dead_clicks: false,
    capture_exceptions: false,
    capture_heatmaps: false,
    capture_performance: {
      network_timing: false,
      web_vitals: true,
      web_vitals_attribution: false,
    },
    disable_session_recording: true,
    // Gzip runs asynchronously after the send gate; an opt-out during it would
    // still reach the network.
    disable_compression: true,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "*",
      collectFonts: false,
      recordCrossOriginIframes: false,
    },
    enable_recording_console_log: false,
    // One survey (#6248), shown only by offerDemoSurvey and only while the
    // demo analytics switch is on; its answers are rebuilt in before_send.
    disable_surveys: false,
    disable_surveys_automatic_display: true,
    // Replay settings arrive through PostHog remote config. Disable only
    // feature-flag evaluation; advanced_disable_flags would block replay too.
    advanced_disable_feature_flags: true,
    advanced_disable_feature_flags_on_first_load: true,
    person_profiles: "identified_only",
    persistence: "localStorage",
    opt_out_capturing_by_default: true,
    opt_out_persistence_by_default: true,
    opt_out_capturing_persistence_type: "localStorage",
    respect_dnt: true,
    save_referrer: false,
    disable_capture_url_hashes: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    strict_script_versioning: true,
    property_denylist: [
      "email", "full_name", "first_name", "last_name", "phone", "address",
      "message", "body", "content", "answers", "query", "response",
      "access_token", "refresh_token", "authorization", "password",
    ],
    before_send: (event) => {
      if (!posthogEnabled || !isDemoAnalyticsEnabled({ storage: currentAnalyticsStorage() })) return null;
      const clean = SURVEY_EVENTS.has(event?.event) ? sanitizeDemoSurveyEvent(event) : sanitizePostHogEvent(event);
      return clean ? { ...clean, [CONSENT_PERIOD_KEY]: analyticsConsentPeriod } : null;
    },
    loaded: (client) => client.register({
      analytics_scope: "external_demo",
      deployment_environment: environment,
      release,
    }),
  });
  // Capture starts opted out (opt_out_capturing_by_default), so nothing has
  // been sent yet when the retry queue gate is installed.
  if (!installPosthogRetryGate()) {
    // On the public site nothing was captured yet and the module's own gate
    // stays closed; the SDK's opt-out would write a consent record to storage.
    if (!productAnalyticsSurface()) posthog.opt_out_capturing();
    posthogConfiguration = null;
    return;
  }
  posthogInitialized = true;
}

function enablePosthog() {
  if (!posthogConfiguration || awaitingSharedIdentity) return false;
  posthogEnabled = true;
  initializePosthog();
  if (!posthogInitialized) {
    posthogEnabled = false;
    return false;
  }
  appliedContext = { mode: null, userId: null, view: null };
  if (!productAnalyticsSurface()) {
    try { posthog.set_config?.({ disable_surveys: false }); } catch { /* a survey never breaks the demo */ }
  }
  if (typeof window !== "undefined" && !lifecycleInstalled) {
    window.addEventListener("pagehide", handlePageHide);
    lifecycleInstalled = true;
  }
  applyObservabilityContext();
  return true;
}

// PostHog keeps its window identifier in sessionStorage, outside the
// persistence that opting out clears.
function clearPosthogSessionKeys() {
  try {
    const store = window.sessionStorage;
    Object.keys(store).filter((key) => key.startsWith("ph_")).forEach((key) => store.removeItem(key));
  } catch {
    // A session store the browser will not open holds nothing to clear.
  }
}

function discardPosthogRecording() {
  const recording = posthog.sessionRecording;
  if (!recording) return;
  if (typeof recording.onRemoteConfig !== "function") {
    // An incompatible SDK must not resume capture of an undiscarded buffer.
    posthogConfiguration = null;
    return;
  }
  // The SDK's public extension callback discards instead of flushing. Apply
  // the disabled config only for this call, without changing shared remote
  // settings or sampling decisions that a sibling tab may still be using.
  const persistence = posthog.persistence;
  const props = persistence?.props;
  const save = persistence?.save;
  try {
    if (persistence) {
      persistence.props = { ...props };
      persistence.save = () => {};
    }
    recording.onRemoteConfig({ ok: true, config: { sessionRecording: false } });
  } finally {
    if (persistence) {
      persistence.props = props;
      persistence.save = save;
    }
  }
}

function stopPosthog({ preserveSharedIdentity = false } = {}) {
  // Flip the in-memory gate before touching the SDK so no lifecycle callback
  // can emit a final event after the visitor has withdrawn permission.
  posthogEnabled = false;
  analyticsConsentPeriod += 1;
  demoStartedAt = 0;
  demoViews = new Set();
  demoActionCount = 0;
  awaitingSharedIdentity = false;
  memberIdentityRequest += 1;
  memberIdentity = null;
  clearMemberFlags();
  if (posthogInitialized && productAnalyticsSurface()) {
    syncPublicHeatmaps();
    // Memory persistence holds the only identifiers; the closed gate and the
    // new consent period drop anything still queued, in this tab and, through
    // the storage event, in every other one.
    clearPosthogSessionKeys();
  } else if (posthogInitialized) {
    // stopSessionRecording() flushes, including after pending compression.
    // The pinned SDK's discard path clears that buffer and invalidates its
    // compression generation. A shared session ID can then safely be reused
    // by a fresh recorder after delayed off/on notifications.
    discardPosthogRecording();
    removeDemoSurvey();
    if (preserveSharedIdentity && posthog.persistence) {
      // The pinned SDK skips load() while disabled. Re-enable its local
      // reader without letting set_disabled(false) save cached properties
      // over the sibling's restored identity. The gate stays closed here.
      const persistence = posthog.persistence;
      const save = persistence.save;
      try {
        persistence.save = () => {};
        persistence.set_disabled(false);
        // load() retains cached properties when no entry exists. A sibling
        // may still be preparing its replacement; never reuse our old ID.
        persistence.props = {};
        persistence.load();
        awaitingSharedIdentity = !posthog.get_distinct_id();
      } finally {
        persistence.save = save;
      }
    }
    posthog.stopSessionRecording();
    if (preserveSharedIdentity) {
      posthog.sessionPersistence?.clear();
    } else {
      posthog.reset();
      posthog.opt_out_capturing();
    }
    clearPosthogSessionKeys();
  }
  appliedContext = { mode: null, userId: null, view: null };
}

function applyAnalyticsChoice(enabled, { preserveSharedIdentity = false } = {}) {
  setProductAnalyticsSignal(enabled);
  if (enabled) enablePosthog();
  else stopPosthog({ preserveSharedIdentity });
  notifyDemoAnalyticsListeners();
}

// Returns the new switch state. A choice the browser cannot save still holds
// for this page; `saved` reports whether it will survive a reload.
export function setDemoAnalyticsEnabled(enabled, { storage = defaultBrowserStorage(), onSaved = null } = {}) {
  if (enabled && posthogConfiguration && !productAnalyticsSurface()) {
    // Publish opt-in only after the replacement identity is available to
    // other tabs. The SDK normally debounces this write by 250 ms.
    initializePosthog();
    if (posthogInitialized) {
      if (awaitingSharedIdentity) posthog.reset();
      posthog.opt_in_capturing({ captureEventName: false });
      posthog.persistence?.flush();
      awaitingSharedIdentity = false;
    }
  }
  const saved = recordAnalyticsChoice(storage, !enabled);
  onSaved?.(saved);
  applyAnalyticsChoice(enabled);
  return Boolean(enabled);
}

// Another tab changed the switch: follow it here at once.
function handleAnalyticsStorageEvent(event) {
  const identityArrived = awaitingSharedIdentity && event.key?.startsWith("ph_");
  if (event.key !== null && event.key !== DEMO_ANALYTICS_PREFERENCE_KEY && !identityArrived) return;
  // A suspended tab can receive off/on notifications after storage is already
  // on again. Honor the recorded withdrawal before restoring current consent.
  const enabled = isDemoAnalyticsEnabled({ storage: currentAnalyticsStorage() });
  if (identityArrived && !enabled) return;
  if (event.newValue === "true" || awaitingSharedIdentity) applyAnalyticsChoice(false, { preserveSharedIdentity: enabled });
  if ((event.newValue !== "true" || enabled) && !awaitingSharedIdentity) applyAnalyticsChoice(enabled);
}

export function initObservability({
  hostname = typeof window === "undefined" ? "" : window.location.hostname,
  location = typeof window === "undefined" ? null : window.location,
  history = typeof window === "undefined" ? null : window.history,
  storage = defaultBrowserStorage(),
  automated = defaultAutomationSignal(),
} = {}) {
  const environment = deploymentEnvironment(hostname);
  const posthogToken = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN?.trim();
  const posthogHost = import.meta.env.VITE_POSTHOG_HOST?.trim();
  const sentryDsn = import.meta.env.VITE_SENTRY_DSN?.trim();
  analyticsStorage = storage;
  const analyticsCommand = applyDemoAnalyticsPreferenceFromUrl({ location, history, storage, hostname });
  if (typeof window !== "undefined" && !storageListenerInstalled) {
    window.addEventListener("storage", handleAnalyticsStorageEvent);
    storageListenerInstalled = true;
  }
  const captureDemoAnalytics = shouldCaptureDemoAnalytics({
    hostname,
    storage,
    command: analyticsCommand,
    automated,
  });
  const captureSentry = shouldEnableSentry({ hostname, automated });

  if (posthogToken && posthogHost && isDemoHost(hostname) && !automated) {
    posthogConfiguration = { token: posthogToken, host: posthogHost, environment, surface: "demo" };
    if (captureDemoAnalytics) enablePosthog();
  } else if (posthogToken && posthogHost && isSaasHost(hostname) && !automated) {
    posthogConfiguration = { token: posthogToken, host: posthogHost, environment, surface: "product" };
    analyticsLocation = location;
    if (shouldCaptureProductAnalytics({ hostname, storage, automated })) enablePosthog();
  }

  if (posthogToken && posthogHost && captureSentry && !diagnosticsEnabled) {
    initDiagnosticsPosthog({ token: posthogToken, host: posthogHost, environment });
  }

  if (sentryDsn && captureSentry && !sentryEnabled) {
    Sentry.init({
      dsn: sentryDsn,
      release,
      environment,
      ...privateSentryOptions(),
      // urlQueryParams below only covers the SDK's Node request data; browser
      // span and breadcrumb attributes are scrubbed by the beforeSend* hooks.
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: { request: false, response: false },
        httpBodies: [],
        urlQueryParams: false,
        graphQL: { document: false, variables: false },
        genAI: { inputs: false, outputs: false },
        databaseQueryData: false,
        stackFrameVariables: false,
      },
      integrations: (defaults) => defaults.filter((integration) =>
        ["GlobalHandlers", "BrowserApiErrors", "EventFilters", "Dedupe"].includes(integration.name)),
      transport: privateSentryTransport(Sentry.makeFetchTransport, { release, environment, surface: "web" }),
      transportOptions: { fetchOptions: { credentials: "omit", referrerPolicy: "no-referrer" } },
    });
    sentryEnabled = true;
  }

  applyObservabilityContext();
}

// the public site (#6247): cookieless mode, memory persistence and every
// automatic capture off. Page views and actions are captured explicitly and
// rebuilt by productBeforeSend; consent is the module's own gate, so the SDK
// never writes an opt-in record to storage.
export function productPosthogOptions({ environment } = {}) {
  return {
    ui_host: "https://us.posthog.com",
    defaults: "2026-06-25",
    cookieless_mode: "always",
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_dead_clicks: false,
    capture_exceptions: false,
    capture_heatmaps: false,
    capture_performance: false,
    disable_session_recording: true,
    disable_compression: true,
    disable_surveys: true,
    disable_web_experiments: true,
    disable_external_dependency_loading: true,
    disable_scroll_properties: true,
    advanced_disable_flags: true,
    advanced_disable_feature_flags: true,
    advanced_disable_feature_flags_on_first_load: true,
    person_profiles: "identified_only",
    persistence: "memory",
    disable_persistence: true,
    disable_cookie: true,
    opt_out_capturing_by_default: false,
    respect_dnt: true,
    save_referrer: false,
    save_campaign_params: false,
    disable_capture_url_hashes: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    strict_script_versioning: true,
    before_send: productBeforeSend,
    loaded: (client) => client.register({ deployment_environment: environment, release }),
  };
}

// Every capture option that could carry a page, person, session, device or
// flag is off; before_send rebuilds the one event type that may leave. No
// cookie or storage is written (memory persistence), no script is loaded
// beyond the bundle, and the relay sees only /batch/ and /e/ requests.
export function diagnosticsPosthogOptions({ environment }) {
  return {
    ui_host: "https://us.posthog.com",
    defaults: "2026-06-25",
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_dead_clicks: false,
    capture_exceptions: true,
    capture_heatmaps: false,
    capture_performance: false,
    disable_session_recording: true,
    disable_compression: true,
    disable_surveys: true,
    disable_web_experiments: true,
    disable_external_dependency_loading: true,
    disable_scroll_properties: true,
    advanced_disable_flags: true,
    advanced_disable_feature_flags: true,
    advanced_disable_feature_flags_on_first_load: true,
    person_profiles: "identified_only",
    persistence: "memory",
    disable_persistence: true,
    disable_cookie: true,
    opt_out_capturing_by_default: false,
    opt_out_persistence_by_default: true,
    // A consent namespace of its own: the SDK keys opt-out state by token, so
    // the analytics switch would otherwise silence diagnostics too.
    opt_out_capturing_cookie_prefix: "__ph_diagnostics_opt_in_out_",
    save_referrer: false,
    save_campaign_params: false,
    disable_capture_url_hashes: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    strict_script_versioning: true,
    before_send: (event) => sanitizePostHogExceptionEvent(event, { surface: "web", environment, release }),
  };
}

function initDiagnosticsPosthog({ token, host, environment }) {
  try {
    // The same SDK-build check as the analytics instance: a posthog-js
    // without the _send_request funnel is a build this module has not
    // verified, so neither instance starts on it (tests/analytics-opt-out-
    // sdk-hook.test.js); Sentry keeps the page covered.
    if (typeof posthog.init !== "function" || typeof posthog._send_request !== "function") return false;
    const client = posthog.init(token, { api_host: host, ...diagnosticsPosthogOptions({ environment }) }, "diagnostics");
    if (!client || typeof client.captureException !== "function") return false;
    diagnosticsClient = client;
    diagnosticsEnabled = true;
    return true;
  } catch {
    // Monitoring never breaks the page; a failed init leaves Sentry in place.
    return false;
  }
}

// src/lib/deferredObservability.js waits on this before replaying a member
// action queued before the runtime loaded, so it carries the hashed identity.
export function memberIdentitySettled() {
  return memberIdentityPending;
}

export function syncObservabilityContext({ userId, organizationId = null, demoActive = false, view = null, authPending = false } = {}) {
  desiredContext = {
    userId: userId ? String(userId) : null,
    organizationId: userId && organizationId ? String(organizationId) : null,
    demoActive: Boolean(demoActive),
    view: safeTelemetryLabel(view),
    authPending: Boolean(authPending),
  };
  contextSynced = true;
  applyObservabilityContext();
}

// An allowlisted member action on the public site (#6247); anything else, or
// any action while the switch, Do Not Track or GPC says no, is dropped.
export function captureProductAction(action) {
  if (!productAnalyticsSurface() || !memberIdentity || !ANALYTICS_ACTIONS.includes(action) || !productCaptureAllowed()) return false;
  posthog.capture("product_action", { action, view: desiredContext.view || "unknown" });
  return true;
}

export function captureDemoAction(action, view = null) {
  const safeAction = safeTelemetryLabel(action);
  const safeView = safeTelemetryLabel(view || desiredContext.view);
  if (!posthogEnabled || appliedContext.mode !== "demo" || !demoStartedAt || !safeAction) return false;
  demoActionCount += 1;
  posthog.capture("demo_action", {
    is_demo: true,
    action: safeAction,
    view: safeView || "unknown",
    action_number: demoActionCount,
  });
  return true;
}

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// Postgres details/hints can echo row data ("Failing row contains (...)",
// "Key (col)=(value)"). Keep the structure an operator needs and drop the
// values, ids, and long digit runs.
function redactDatabaseText(value) {
  return redactSensitiveText(value)
    .replace(/(Failing row contains )\(.*\)/gis, "$1([redacted-row])")
    .replace(/(Key \([^)]*\))=\((?:[^()]|\([^()]*\))*\)/g, "$1=([redacted])")
    .replace(UUID_PATTERN, "[redacted-id]")
    .replace(/\d{4,}/g, "[redacted-number]");
}

function boundedRedactedText(value, maxLength, redact = redactSensitiveText) {
  if (typeof value !== "string" || value === "") return null;
  return redact(value).slice(0, maxLength);
}

// Privacy-filtered diagnostic for handled client failures. Never include
// request bodies or member content. Optional write-failure fields (label,
// details, hint) are redacted and length-bounded before they reach Sentry;
// details and hint also lose database row values and identifiers.
export function captureSanitizedDiagnostic({
  kind,
  resource = null,
  code = null,
  name = null,
  label = null,
  details = null,
  hint = null,
} = {}) {
  const safeKind = safeTelemetryLabel(kind);
  if (!safeKind) return false;
  const diagnostic = {
    kind: safeKind,
    resource: typeof resource === "string" ? resource.slice(0, 80) : null,
    code: code == null || code === "" ? null : String(code).slice(0, 32),
    name: typeof name === "string" ? name.slice(0, 64) : null,
  };
  const safeLabel = boundedRedactedText(label, 80);
  const safeDetails = boundedRedactedText(details, 160, redactDatabaseText);
  const safeHint = boundedRedactedText(hint, 160, redactDatabaseText);
  if (safeLabel) diagnostic.label = safeLabel;
  if (safeDetails) diagnostic.details = safeDetails;
  if (safeHint) diagnostic.hint = safeHint;
  if (sentryEnabled) {
    Sentry.captureMessage(safeKind, { level: "error", extra: { diagnostic } });
  }
  if (diagnosticsEnabled) {
    // The scrubber reduces this to the error class and coarse frames, as it
    // does the Sentry message; the diagnostic fields never leave the page.
    try { diagnosticsClient.captureException(new Error(safeKind)); } catch { /* monitoring never breaks the page */ }
  }
  return sentryEnabled || diagnosticsEnabled || true;
}

// A render error a view boundary caught (ChunkBoundary). React hands caught
// errors to console.error, not to the global handlers, so without this call
// they never reach Sentry. sanitizeSentryEvent still strips the event down to
// the exception type, value and frames.
export function captureViewError(error) {
  if (diagnosticsEnabled) {
    try { diagnosticsClient.captureException(error); } catch { /* monitoring never breaks the page */ }
  }
  if (!sentryEnabled) return diagnosticsEnabled;
  Sentry.captureException(error);
  return true;
}

export const diagnosticsPosthogClient = () => diagnosticsClient;

export {
  applyDemoAnalyticsPreferenceFromUrl,
  isDemoAnalyticsEnabled,
  productAnalyticsSignal,
  subscribeDemoAnalytics,
} from "./analyticsPreference.js";
// The Sentry namespace stays private so the bundler can drop the parts of
// @sentry/react this module never calls.
export { posthog as posthogClient };
