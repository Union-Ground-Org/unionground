import * as Sentry from '@sentry/react-native';
import { makeFetchTransport } from '@sentry/browser';
import { PostHog } from 'posthog-react-native';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { privateSentryOptions, privateSentryTransport } from '../../../../src/lib/sentryPrivacy.js';
import { ANALYTICS_PSEUDONYM_PREFIX, analyticsFlagsFromResponse, analyticsFlagsRequest, analyticsFlagValue, privatePostHogFetch } from '../../../../src/lib/posthogPrivacy.js';
import type { AnalyticsFlagKey, AnalyticsFlagValues } from '../../../../src/lib/posthogPrivacy.js';
import { productAnalyticsEnabledNow, productAnalyticsGeneration } from './analyticsPreference';
import { publishNativeFlags, setNativeFlagExposureReporter } from './nativeFeatureFlag';
import { PUBLIC_SITE_ORIGIN } from '../lib/publicSite';

let initialized = false;
let posthogClient: PostHog | null = null;
let posthogConfigured = false;

type PrivateFetch = ReturnType<typeof privatePostHogFetch>;
// Set before the client is constructed: the SDK may call `fetch` from its
// constructor, before a subclass field could exist. Until it is set, every
// request is answered locally and nothing leaves the app.
let diagnosticsFetch: PrivateFetch | null = null;
const localEmptyResponse = async () => ({ status: 200, ok: true, text: async () => '{}', json: async () => ({}) });

// OPS-UG-POSTHOG-ANALYTICS-ON-MEMBER-PRODUCT-AND-PUBLIC-PAGES-20261027
// (#6247): pseudonymous product analytics behind the Account switch. The
// identity is one-way hashes of the user and organization identifiers, held in
// memory only; the private fetch reads it at send time, so a screen captured
// before sign-out, a switch to another account or the switch turned off never
// leaves the phone under it.
type AnalyticsIdentity = { distinctId: string; organization: string | null; generation: string };
let analyticsMember: { userID: string; organizationID: string | null } | null = null;
let analyticsIdentity: Omit<AnalyticsIdentity, 'generation'> | null = null;
let analyticsRequest = 0;
// A screen opened while the identity digest is still running is held for that
// identity only, and dropped if the member changes first (#6432 round 3).
let pendingScreen: string | null = null;

// OPS-UG-POSTHOG-FLAGS-EXPERIMENTS-SURVEYS-HEATMAPS-20261027 (#6248):
// feature flags for the member, bootstrapped once per identity from PostHog's
// /flags endpoint with only the two hashes above and held in memory; every
// read is local. Until they arrive, while the switch is off and whenever the
// request fails, each flag reads as its default.
const FLAGS_TIMEOUT_MS = 3000;
let flagsEndpoint: { token: string; host: string } | null = null;
let nativeFlags: { distinctId: string; organization: string | null; values: AnalyticsFlagValues } | null = null;
let flagsRequest = 0;
const exposedFlags = new Set<string>();

const pseudonym = (value: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${ANALYTICS_PSEUDONYM_PREFIX}${value}`);

// The generation names the member request and the switch state together;
// every captured event carries it, and the private fetch drops an event whose
// generation is no longer current instead of sending it under a new identity.
export function currentNativeAnalyticsIdentity(): AnalyticsIdentity | null {
  if (!analyticsIdentity || !productAnalyticsEnabledNow()) return null;
  return { ...analyticsIdentity, generation: `${analyticsRequest}:${productAnalyticsGeneration()}` };
}

export async function setNativeAnalyticsMember(member: { userID: string; organizationID: string | null } | null): Promise<void> {
  const request = ++analyticsRequest;
  analyticsMember = member;
  analyticsIdentity = null;
  pendingScreen = null;
  clearNativeFlags();
  if (!member) return;
  try {
    const [distinctId, organization] = await Promise.all([pseudonym(member.userID), member.organizationID ? pseudonym(member.organizationID) : null]);
    if (request === analyticsRequest && analyticsMember === member) {
      analyticsIdentity = { distinctId: distinctId.toLowerCase(), organization: organization?.toLowerCase() ?? null };
      const held = pendingScreen;
      pendingScreen = null;
      if (held) captureNativeScreen(held);
      void loadNativeFlags(request);
    }
  } catch {
    // No digest, no analytics: the member is never counted under anything else.
  }
}

function clearNativeFlags(): void {
  flagsRequest += 1;
  exposedFlags.clear();
  if (!nativeFlags) return;
  nativeFlags = null;
  publishNativeFlags(null);
}

async function loadNativeFlags(memberRequest: number): Promise<void> {
  const request = ++flagsRequest;
  const identity = currentNativeAnalyticsIdentity();
  const body = flagsEndpoint ? analyticsFlagsRequest(flagsEndpoint.token, identity) : null;
  if (!flagsEndpoint || !identity || !body) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FLAGS_TIMEOUT_MS);
  try {
    // The relay refuses an event POST without a product Origin, which a
    // browser adds and this runtime does not (privatePostHogFetch does the same).
    const response = await fetch(`${flagsEndpoint.host}/flags/?v=2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: PUBLIC_SITE_ORIGIN ?? '' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload: unknown = response.ok ? await response.json() : null;
    const current = currentNativeAnalyticsIdentity();
    if (request !== flagsRequest || memberRequest !== analyticsRequest || !current || current.distinctId !== identity.distinctId || current.organization !== identity.organization) return;
    nativeFlags = { distinctId: identity.distinctId, organization: identity.organization, values: analyticsFlagsFromResponse(payload) };
    publishNativeFlags(nativeFlags.values);
  } catch {
    // Unreachable, slow or refused: the defaults stand.
  } finally {
    clearTimeout(timer);
  }
}

function nativeFlagValues(): AnalyticsFlagValues | null {
  const identity = currentNativeAnalyticsIdentity();
  if (!nativeFlags || !identity || nativeFlags.distinctId !== identity.distinctId || nativeFlags.organization !== identity.organization) return null;
  return nativeFlags.values;
}

// A member feature flag (#6248): the value PostHog served this member, or the
// flag's default. Reading never sends anything.
export function nativeFeatureFlag(key: AnalyticsFlagKey): string {
  return analyticsFlagValue(nativeFlagValues(), key);
}

// The experiment exposure, once per identity and flag, only for a value
// PostHog served; the private fetch rebuilds it from the shared allowlist.
export function reportNativeFlagExposure(key: AnalyticsFlagKey, view: string): boolean {
  const values = nativeFlagValues();
  const identity = currentNativeAnalyticsIdentity();
  if (!posthogClient || !values || !identity || !Object.prototype.hasOwnProperty.call(values, key) || exposedFlags.has(key)) return false;
  exposedFlags.add(key);
  try {
    posthogClient.capture('$feature_flag_called', { $feature_flag: key, $feature_flag_response: analyticsFlagValue(values, key), view,
      $ug_member: identity.distinctId, $ug_organization: identity.organization, $ug_generation: identity.generation });
    return true;
  } catch { return false; }
}

// One screen view with its feature label; nothing else about the screen. The
// page-view recorder hands over its page key (/native/<feature>); only the
// feature label leaves (#6247 round 1).
export function captureNativeScreen(page: string): boolean {
  if (!posthogClient) return false;
  const identity = currentNativeAnalyticsIdentity();
  if (!identity) {
    if (analyticsMember && productAnalyticsEnabledNow()) pendingScreen = page;
    return false;
  }
  const view = page.startsWith('/native/') ? page.slice('/native/'.length) : page;
  try {
    posthogClient.capture('$screen', { view, $ug_member: identity.distinctId, $ug_organization: identity.organization, $ug_generation: identity.generation });
    return true;
  } catch { return false; }
}

// PostHog error tracking beside Sentry (owner order, October 27, 2026; record
// OPS-UG-POSTHOG-ERROR-TRACKING-REPLACES-SENTRY-20261027). The React
// Native SDK sends through its own `fetch` method, not an option, so the
// diagnostics client overrides it with the private fetch: every request body
// is rebuilt around the scrubbed `$exception` events, every other endpoint is
// answered locally, and nothing but /batch/ leaves the app. Persistence stays
// in memory, so no identifier is written to the device; app lifecycle,
// flags, surveys, replay and compression are off.
class DiagnosticsPostHog extends PostHog {
  constructor(token: string, host: string) {
    super(token, {
      host,
      persistence: 'memory',
      flushAt: 1,
      flushInterval: 0,
      disableCompression: true,
      disableGeoip: true,
      captureAppLifecycleEvents: false,
      preloadFeatureFlags: false,
      sendFeatureFlagEvent: false,
      disableSurveys: true,
      enableSessionReplay: false,
      customAppProperties: () => ({}),
      // Unhandled rejections reach PostHog through the shared Hermes dispatcher below.
      errorTracking: { autocapture: { uncaughtExceptions: true, unhandledRejections: false, console: [] } },
    });
  }
  // The SDK's transport. The base class calls global fetch; this one only ever
  // sends what the private fetch rebuilt.
  fetch(url: string, options: Parameters<PostHog['fetch']>[1]): ReturnType<PostHog['fetch']> {
    return (diagnosticsFetch ?? localEmptyResponse)(url, options) as ReturnType<PostHog['fetch']>;
  }
}

// Hermes keeps one promise-rejection tracker: `enablePromiseRejectionTracker`
// replaces whatever was registered before, and both pinned SDKs would register
// one during initialization (PostHog's autocapture, Sentry's error-handlers
// integration), so the second SDK would silence the first. Both SDK
// registrations are switched off below and this module registers one
// dispatcher through Hermes' own method, which reports every unhandled
// rejection to each configured provider. The intrinsic is never changed:
// HermesInternal is non-extensible and its methods are non-writable and
// non-configurable, so an assignment would throw in strict mode. The
// registration is feature-detected through the property descriptor and
// wrapped, so startup never depends on it; without Hermes (JSC, web, tests)
// nothing is registered.
type RejectionTracker = { allRejections?: boolean; onUnhandled?: (id: number, error: unknown) => void; onHandled?: (id: number) => void };
type HermesInternalLike = { hasPromise?: () => boolean; enablePromiseRejectionTracker?: (options: RejectionTracker) => void };
let rejectionDispatcherInstalled = false;

// The pinned PostHog autocapture skips its own transport failures, so the
// shared dispatcher does too; the name check avoids importing the SDK's
// transitive core package.
const isPostHogFetchNetworkError = (error: unknown): boolean => error instanceof Error && error.name === 'PostHogFetchNetworkError';

function dispatchUnhandledRejection(id: number, error: unknown): void {
  // One SDK's failure never hides the rejection from the other.
  if (posthogClient && !isPostHogFetchNetworkError(error)) {
    try { posthogClient.captureException(error, {}, { mechanism: { type: 'onunhandledrejection', handled: false } }); } catch { /* monitoring never breaks the app */ }
  }
  if (initialized) {
    // The pinned Sentry integration marks these handled so they do not count
    // against the crash rate (getsentry/sentry-react-native#4141).
    try { Sentry.captureException(error, { data: { id }, originalException: error, mechanism: { type: 'onunhandledrejection', handled: true } }); } catch { /* monitoring never breaks the app */ }
  }
}

export function shareHermesRejectionTracker(): boolean {
  if (rejectionDispatcherInstalled) return true;
  try {
    const hermes = (globalThis as { HermesInternal?: HermesInternalLike }).HermesInternal;
    if (!hermes || typeof hermes !== 'object') return false;
    // Read as an own data property: `PropertyDescriptor.value` is `any`, so it
    // is narrowed to `unknown` before the function check.
    const descriptor = Object.getOwnPropertyDescriptor(hermes, 'enablePromiseRejectionTracker') as { value?: unknown } | undefined;
    const enable = descriptor?.value;
    if (typeof enable !== 'function') return false;
    if (typeof hermes.hasPromise === 'function' && !hermes.hasPromise()) return false;
    enable.call(hermes, { allRejections: true, onUnhandled: dispatchUnhandledRejection, onHandled: () => {} });
    rejectionDispatcherInstalled = true;
    return true;
  } catch {
    // Monitoring never breaks the app: a Hermes without a usable tracker
    // simply leaves unhandled rejections unreported.
    return false;
  }
}

export function initNativePosthog(): boolean {
  if (posthogConfigured) return posthogClient !== null;
  posthogConfigured = true;
  const token = process.env.EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN?.trim();
  const host = process.env.EXPO_PUBLIC_POSTHOG_HOST?.trim();
  // Product analytics need the deployment's own public site as the event
  // origin (lib/publicSite); a copy with none configured sends nothing.
  if (!token || !host || !PUBLIC_SITE_ORIGIN || !/^https:\/\/[a-z0-9.-]+$/.test(host)) return false;
  const surface = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : null;
  if (!surface) return false;
  const environment = __DEV__ ? 'development' : 'production';
  try {
    diagnosticsFetch = privatePostHogFetch((url, options) => fetch(url, options as RequestInit),
      { surface, environment, origin: PUBLIC_SITE_ORIGIN, analyticsIdentity: currentNativeAnalyticsIdentity });
    posthogClient = new DiagnosticsPostHog(token, host);
    flagsEndpoint = { token, host };
    setNativeFlagExposureReporter(reportNativeFlagExposure);
    shareHermesRejectionTracker();
    return true;
  } catch {
    // Monitoring never breaks the app; Sentry stays in place.
    posthogClient = null;
    return false;
  }
}

export function initNativeObservability(): boolean {
  // PostHog starts with or without a Sentry DSN; the two report independently,
  // through the one shared Hermes rejection dispatcher.
  initNativePosthog();
  if (initialized) return true;
  const dsn = Platform.OS === 'ios' ? process.env.EXPO_PUBLIC_SENTRY_DSN_IOS?.trim()
    : Platform.OS === 'android' ? process.env.EXPO_PUBLIC_SENTRY_DSN_ANDROID?.trim() : '';
  if (!dsn) return false;
  const environment = __DEV__ ? 'development' : 'production';
  Sentry.init({
    dsn,
    ...privateSentryOptions(),
    // Native crash envelopes bypass JavaScript beforeSend. Keep that layer
    // disabled until a separately verified Swift/Kotlin scrubber exists.
    enableNative: false,
    autoInitializeNativeSdk: false,
    enableNativeCrashHandling: false,
    enableAutoSessionTracking: false,
    enableAutoPerformanceTracing: false,
    attachScreenshot: false,
    attachViewHierarchy: false,
    defaultIntegrations: false,
    // Unhandled rejections reach Sentry through the shared Hermes dispatcher.
    integrations: [Sentry.reactNativeErrorHandlersIntegration({ onunhandledrejection: false })],
    transport: privateSentryTransport(makeFetchTransport, { environment, surface: Platform.OS }),
    transportOptions: { fetchOptions: { credentials: 'omit', referrerPolicy: 'no-referrer' } },
  });
  initialized = true;
  shareHermesRejectionTracker();
  return true;
}

// Expo Router's error boundary keeps the caught error away from the global
// handler, so the root boundary reports it here. The same private beforeSend
// applies, which keeps no caller tags; without a DSN this is a no-op and the
// recovery screen still draws.
export function reportNativeRenderError(error: unknown): boolean {
  let reported = false;
  if (initNativePosthog()) {
    try { posthogClient?.captureException(error); reported = true; } catch { /* monitoring never breaks the app */ }
  }
  if (!initialized) return reported;
  Sentry.captureException(error);
  return true;
}

export const nativePosthogClient = (): PostHog | null => posthogClient;
