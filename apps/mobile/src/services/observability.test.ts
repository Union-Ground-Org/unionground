import { ErrorTracking } from '@posthog/core';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { posthogExceptionSchemaErrors } from '../testing/posthogExceptionSchema';

// Ledger 395: root-only CI has a different core tree. Prove the native schema
// here against the actual phone dependency, with versions read from its lock.
const phonePackages = (JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')) as {
  packages: Record<string, { version: string }>;
}).packages;
const lockedVersion = (name: string) => {
  const version = phonePackages[`node_modules/${name}`]?.version;
  if (!version) throw new Error(`The mobile lockfile has no version for ${name}`);
  return version;
};
const phoneCoreVersion = lockedVersion('@posthog/core');
const phoneSdkVersion = lockedVersion('posthog-react-native');
const phoneRequire = createRequire(import.meta.url);
const installedVersion = (name: string) => (JSON.parse(readFileSync(
  new URL('../package.json', pathToFileURL(phoneRequire.resolve(name))), 'utf8',
)) as { version: string }).version;

it('uses the mobile lockfile core and SDK versions for the native exception contract', () => {
  expect(installedVersion('@posthog/core')).toBe(phoneCoreVersion);
  expect(installedVersion('posthog-react-native')).toBe(phoneSdkVersion);
});

const sdk = vi.hoisted(() => ({ init: vi.fn(), captureException: vi.fn(), reactNativeErrorHandlersIntegration: vi.fn((options?: Record<string, unknown>) => ({ name: 'ReactNativeErrorHandlers', options })) }));
const platform = vi.hoisted(() => ({ OS: 'ios' }));
vi.mock('@sentry/react-native', () => sdk);
vi.mock('@sentry/browser', () => ({ makeFetchTransport: vi.fn() }));
vi.mock('react-native', () => ({ Platform: platform }));
// This edition publishes no site, so analytics stay off; these cases run against a fictional one.
vi.mock('../lib/publicSite', () => ({ PUBLIC_SITE_ORIGIN: 'https://app.unionground.example' }));
// posthog-react-native: the base class records its options; the diagnostics
// subclass overrides `fetch`, which the test drives directly.
type Registration = { allRejections?: boolean; onUnhandled?: (id: number, error: unknown) => void; onHandled?: (id: number) => void };
type HermesStub = { hasPromise?: () => boolean; enablePromiseRejectionTracker?: (options: Registration) => void };
const hermes = () => (globalThis as { HermesInternal?: HermesStub }).HermesInternal;
// Like the real intrinsic (hermes/lib/VM/JSLib/HermesInternal.cpp): every
// method is non-writable, non-configurable and non-enumerable, and the object
// is non-extensible, so an assignment throws in strict mode.
function stubRealHermes(enablePromiseRejectionTracker: HermesStub['enablePromiseRejectionTracker'], hasPromise = () => true): HermesStub {
  const stub = {};
  for (const [name, value] of Object.entries({ hasPromise, enablePromiseRejectionTracker })) {
    Object.defineProperty(stub, name, { value, writable: false, configurable: false, enumerable: false });
  }
  Object.preventExtensions(stub);
  vi.stubGlobal('HermesInternal', stub);
  return stub;
}
const posthog = vi.hoisted(() => {
  type Transport = (url: string, init: { method: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number }>;
  const instances: Array<{ token: string; options: Record<string, unknown>; captureException: ReturnType<typeof vi.fn>; fetch: Transport }> = [];
  class PostHog {
    token: string; options: Record<string, unknown>; captureException = vi.fn(); capture = vi.fn();
    constructor(token: string, options: Record<string, unknown>) {
      this.token = token; this.options = options; instances.push(this as never);
      // Like the pinned SDK, autocapture registers a Hermes rejection tracker on
      // construction unless `unhandledRejections` is off.
      const autocapture = (options.errorTracking as { autocapture?: { unhandledRejections?: boolean } } | undefined)?.autocapture;
      if (autocapture?.unhandledRejections) {
        hermes()?.enablePromiseRejectionTracker?.({ allRejections: true, onUnhandled: (_id: number, error: unknown) => { this.captureException(error); }, onHandled: () => {} });
      }
    }
    fetch(url: string, options: unknown) { return globalThis.fetch(url, options as never); }
  }
  return { PostHog, instances };
});
vi.mock('posthog-react-native', () => ({ PostHog: posthog.PostHog }));
// The Account switch's store and the digest the analytics identity uses (#6247).
const secureStore = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => secureStore.value),
  setItemAsync: vi.fn(async (_key: string, value: string) => { secureStore.value = value; }),
  deleteItemAsync: vi.fn(async () => { secureStore.value = null; }),
}));
// sha256 of the prefixed ids, precomputed (uppercase, as expo-crypto may return it).
const DIGESTS = vi.hoisted((): Record<string, string> => ({
  'unionground-analytics:v1:6f1c2a7e-0d3b-4c5e-9a8f-1b2c3d4e5f60': '8DC2142CC248163115BB8383DBE00DDAD6946E7FD8335A330DC34DE9634E10DF',
  'unionground-analytics:v1:7d3e4f50-6a7b-4c8d-9e0f-a1b2c3d4e5f6': '98C20800044A107CA97A1EFEB9878F5E4D5F455D32C818E9FDA93ECE5BBB3C7E',
  'unionground-analytics:v1:other-member': '101D416DD5DD9AB0BF6980455BE199CED4548C0977F97D915C6178517ED96CE1',
}));
vi.mock('expo-crypto', () => ({ CryptoDigestAlgorithm: { SHA256: 'SHA-256' }, digestStringAsync: vi.fn(async (_algorithm: string, value: string) => DIGESTS[value] ?? '0'.repeat(64)) }));

// These cases reset and reimport diagnostics modules. Cold imports can exceed
// five seconds under host load, so each case below gets a 30-second budget.
describe('native error monitoring', { timeout: 30_000 }, () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); posthog.instances.length = 0; vi.stubGlobal('__DEV__', false); vi.stubEnv('EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN', ''); vi.stubEnv('EXPO_PUBLIC_POSTHOG_HOST', ''); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it.each(['ios', 'android'])('does nothing on %s without its own DSN', async os => {
    platform.OS = os;
    vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN_IOS', os === 'ios' ? '' : 'https://public@o0.ingest.us.sentry.io/1');
    vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN_ANDROID', os === 'android' ? '' : 'https://public@o0.ingest.us.sentry.io/2');
    const { initNativeObservability } = await import('./observability');
    expect(initNativeObservability()).toBe(false);
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it.each(['ios', 'android'])('uses the strict JS boundary on %s, without a native SDK bypass', async os => {
    platform.OS = os;
    vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN_IOS', 'https://public@o0.ingest.us.sentry.io/1');
    vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN_ANDROID', 'https://public@o0.ingest.us.sentry.io/2');
    const { initNativeObservability } = await import('./observability');
    expect(initNativeObservability()).toBe(true);
    expect(initNativeObservability()).toBe(true);
    expect(sdk.init).toHaveBeenCalledTimes(1);
    const config = sdk.init.mock.calls[0]?.[0] as { dsn: string; beforeSend: (event: unknown) => unknown; beforeBreadcrumb: (value: unknown) => unknown };
    expect(config).toMatchObject({
      dsn: `https://public@o0.ingest.us.sentry.io/${os === 'ios' ? 1 : 2}`,
      sendDefaultPii: false, enableNative: false, autoInitializeNativeSdk: false,
      enableNativeCrashHandling: false, attachScreenshot: false, attachViewHierarchy: false,
      tracesSampleRate: 0, replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 0,
    });
    const event = { user: { id: 'native-member-id', name: 'Taylor Example' }, message: 'private medical grievance', extra: { arbitrary: 'Taylor Example' } };
    const serialized = JSON.stringify(config.beforeSend(event));
    expect(serialized).not.toContain('native-member-id');
    expect(serialized).not.toContain('Taylor Example');
    expect(serialized).not.toContain('medical');
    expect(config.beforeBreadcrumb({ message: 'Taylor Example' })).toBeNull();
  });

  it('reports a caught render error only once monitoring is on', async () => {
    platform.OS = 'ios';
    vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN_IOS', '');
    const off = await import('./observability');
    off.initNativeObservability();
    expect(off.reportNativeRenderError(new Error('render failed'))).toBe(false);
    expect(sdk.captureException).not.toHaveBeenCalled();

    vi.resetModules();
    vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN_IOS', 'https://public@o0.ingest.us.sentry.io/1');
    const on = await import('./observability');
    on.initNativeObservability();
    const error = new Error('render failed');
    expect(on.reportNativeRenderError(error)).toBe(true);
    expect(sdk.captureException).toHaveBeenCalledWith(error);
  });
});

describe('native PostHog error tracking beside Sentry', { timeout: 30_000 }, () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); posthog.instances.length = 0; vi.stubGlobal('__DEV__', false); vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN_IOS', ''); vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN_ANDROID', ''); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('does nothing without the project token and an https relay host', async () => {
    vi.stubEnv('EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_fixture');
    vi.stubEnv('EXPO_PUBLIC_POSTHOG_HOST', 'http://e.unionground.example');
    const { initNativeObservability, initNativePosthog, reportNativeRenderError } = await import('./observability');
    expect(initNativePosthog()).toBe(false);
    expect(initNativeObservability()).toBe(false);
    expect(reportNativeRenderError(new Error('x'))).toBe(false);
    expect(posthog.instances).toHaveLength(0);
  });

  it.each(['ios', 'android'])('starts one memory-only diagnostics client on %s whose fetch sends only rebuilt batches, with or without a Sentry DSN', async os => {
    platform.OS = os;
    vi.stubEnv('EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_fixture');
    vi.stubEnv('EXPO_PUBLIC_POSTHOG_HOST', 'https://e.unionground.example');
    const { initNativeObservability, nativePosthogClient, reportNativeRenderError } = await import('./observability');
    expect(initNativeObservability()).toBe(false);
    expect(posthog.instances).toHaveLength(1);
    const client = posthog.instances[0] as (typeof posthog.instances)[number];
    expect(client.token).toBe('phc_fixture');
    expect(client.options).toMatchObject({ host: 'https://e.unionground.example', persistence: 'memory', flushAt: 1, flushInterval: 0, disableCompression: true, disableGeoip: true, captureAppLifecycleEvents: false, preloadFeatureFlags: false, sendFeatureFlagEvent: false, disableSurveys: true, enableSessionReplay: false, errorTracking: { autocapture: { uncaughtExceptions: true, unhandledRejections: false, console: [] } } });
    expect((client.options.customAppProperties as () => object)()).toEqual({});
    expect(nativePosthogClient()).toBe(client);
    // Render errors reach PostHog without a Sentry DSN.
    expect(reportNativeRenderError(new Error('Taylor Example'))).toBe(true);
    expect(client.captureException).toHaveBeenCalledTimes(1);
    expect(sdk.captureException).not.toHaveBeenCalled();
    // The overridden transport rebuilds the body and answers flags locally.
    const calls: Array<[string, RequestInit]> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push([url, init]); return { status: 200, ok: true, text: async () => '{}' }; }));
    const body = JSON.stringify({ api_key: 'phc_fixture', batch: [
      { event: '$exception', properties: { $exception_list: [{ type: 'Error', value: 'Taylor Example' }], $device_id: 'd-1', $app_version: '1.0', $screen_name: 'Workers' } },
      { event: 'Application Opened', properties: {} },
    ] });
    const response = await client.fetch('https://e.unionground.example/batch/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    const sentBody = String(calls[0]?.[1].body);
    const sent = JSON.parse(sentBody) as { batch: Array<{ properties: Record<string, unknown> }> };
    expect(sent.batch).toHaveLength(1);
    expect(sent.batch[0]?.properties).toMatchObject({ $exception_list: [{ type: 'Error', value: 'Application error' }], surface: os, deployment_environment: 'production', $geoip_disable: true, $process_person_profile: false });
    expect(sentBody).not.toContain('Taylor');
    expect(sentBody).not.toContain('Workers');
    const flags = await client.fetch('https://e.unionground.example/flags/?v=2', { method: 'POST', body });
    expect(flags.status).toBe(200);
    expect(calls).toHaveLength(1);
    // A second init keeps the one client.
    initNativeObservability();
    expect(posthog.instances).toHaveLength(1);
  });

  // #6826: PostHog processed none of the scrubbed exceptions because their
  // frames lacked the `function` field its schema requires.
  it.each<[string, ErrorTracking.Platform]>([['ios', 'hermes'], ['android', 'web:javascript']])('sends %s exceptions with %s frames PostHog can process, under fixed frame placeholders', async (os, frames) => {
    platform.OS = os;
    vi.stubEnv('EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_fixture');
    vi.stubEnv('EXPO_PUBLIC_POSTHOG_HOST', 'https://e.unionground.example');
    const { initNativePosthog } = await import('./observability');
    expect(initNativePosthog()).toBe(true);
    const client = posthog.instances[0] as (typeof posthog.instances)[number];
    // posthog-react-native's own exception builder (createErrorPropertiesBuilder).
    const builder = new ErrorTracking.ErrorPropertiesBuilder(
      [new ErrorTracking.ErrorCoercer(), new ErrorTracking.ObjectCoercer(), new ErrorTracking.StringCoercer(), new ErrorTracking.PrimitiveCoercer()],
      ErrorTracking.createStackParser(frames, ErrorTracking.chromeStackLineParser, ErrorTracking.geckoStackLineParser),
    );
    const error = new Error('Taylor Example');
    error.stack = 'Error: Taylor Example\n    at renderGrievance (address at index.android.bundle:1:234567)\n    at MembersScreen (/data/user/0/net.unionground/files/Taylor/index.bundle:9:3)';
    const properties = builder.buildFromUnknown(error, { mechanism: { type: 'onerror', handled: false } });
    const calls: Array<[string, RequestInit]> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push([url, init]); return { status: 200, ok: true, text: async () => '{}' }; }));
    const body = JSON.stringify({ api_key: 'phc_fixture', batch: [{ event: '$exception', properties: { ...properties, $lib: 'posthog-react-native', $lib_version: phoneSdkVersion, $screen_name: 'Workers' } }] });
    await client.fetch('https://e.unionground.example/batch/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    expect(calls).toHaveLength(1);
    const sent = JSON.parse(String(calls[0]?.[1].body)) as { batch: Array<{ properties: { $exception_list: Array<{ stacktrace?: { frames: unknown[] } }> } }> };
    expect(posthogExceptionSchemaErrors(sent.batch[0])).toEqual([]);
    const sentFrames = sent.batch[0]?.properties.$exception_list[0]?.stacktrace?.frames ?? [];
    expect(sentFrames).toHaveLength(2);
    for (const frame of sentFrames) expect(frame).toMatchObject({ platform: frames, function: '?', filename: 'app:///application' });
    expect(String(calls[0]?.[1].body)).not.toMatch(/Taylor|Members|renderGrievance|index\.bundle|net\.unionground/);
  });
});

describe('one shared Hermes promise-rejection dispatcher', { timeout: 30_000 }, () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); posthog.instances.length = 0; vi.stubGlobal('__DEV__', false); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  const configureBoth = () => {
    platform.OS = 'ios';
    vi.stubEnv('EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_fixture');
    vi.stubEnv('EXPO_PUBLIC_POSTHOG_HOST', 'https://e.unionground.example');
    vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN_IOS', 'https://public@o0.ingest.us.sentry.io/1');
    // Like the pinned SDK, Sentry's error-handlers integration registers during
    // init unless `onunhandledrejection` is off.
    sdk.init.mockImplementationOnce((options: { integrations?: Array<{ name: string; options?: Record<string, unknown> }> }) => {
      for (const integration of options.integrations ?? []) {
        if (integration.name === 'ReactNativeErrorHandlers' && integration.options?.onunhandledrejection !== false) {
          hermes()?.enablePromiseRejectionTracker?.({ allRejections: true, onUnhandled: () => {}, onHandled: () => {} });
        }
      }
    });
  };

  it('registers one dispatcher through the frozen Hermes intrinsic and reports each unhandled rejection to PostHog and Sentry', async () => {
    configureBoth();
    // Hermes keeps the last tracker it was given; the stub records every registration.
    const registrations: Registration[] = [];
    const enable = vi.fn((options: Registration) => { registrations.push(options); });
    const stub = stubRealHermes(enable);
    // The stub behaves like Hermes: assigning the method throws in strict mode.
    expect(() => { (stub as { enablePromiseRejectionTracker?: unknown }).enablePromiseRejectionTracker = () => {}; }).toThrow(TypeError);
    const { initNativeObservability, shareHermesRejectionTracker } = await import('./observability');
    expect(initNativeObservability()).toBe(true);
    expect(shareHermesRejectionTracker()).toBe(true);
    expect(posthog.instances).toHaveLength(1);
    // Each SDK's own registration is off, so Hermes was given exactly one tracker: the dispatcher.
    expect(posthog.instances[0]?.options).toMatchObject({ errorTracking: { autocapture: { unhandledRejections: false } } });
    expect(sdk.reactNativeErrorHandlersIntegration).toHaveBeenCalledWith({ onunhandledrejection: false });
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.allRejections).toBe(true);
    // The intrinsic is unchanged.
    expect((Object.getOwnPropertyDescriptor(stub, 'enablePromiseRejectionTracker') as { value?: unknown } | undefined)?.value).toBe(enable);
    const error = new TypeError('unhandled');
    registrations[0]?.onUnhandled?.(7, error);
    expect(posthog.instances[0]?.captureException).toHaveBeenCalledWith(error, {}, { mechanism: { type: 'onunhandledrejection', handled: false } });
    expect(sdk.captureException).toHaveBeenCalledWith(error, { data: { id: 7 }, originalException: error, mechanism: { type: 'onunhandledrejection', handled: true } });
    expect(() => registrations[0]?.onHandled?.(7)).not.toThrow();
    // One SDK failing never hides the rejection from the other.
    posthog.instances[0]?.captureException.mockImplementationOnce(() => { throw new Error('sdk failed'); });
    const second = new Error('second');
    registrations[0]?.onUnhandled?.(8, second);
    expect(sdk.captureException).toHaveBeenLastCalledWith(second, expect.objectContaining({ data: { id: 8 } }));
    // PostHog's own transport failures are not reported back to PostHog (as in
    // the pinned autocapture); Sentry still sees them.
    const transport = Object.assign(new Error('Network error while fetching PostHog'), { name: 'PostHogFetchNetworkError' });
    registrations[0]?.onUnhandled?.(9, transport);
    expect(posthog.instances[0]?.captureException).not.toHaveBeenCalledWith(transport, expect.anything(), expect.anything());
    expect(sdk.captureException).toHaveBeenLastCalledWith(transport, expect.objectContaining({ data: { id: 9 } }));
  });

  it('never lets startup depend on the tracker: a Hermes whose method throws or has no promises still starts both providers', async () => {
    configureBoth();
    stubRealHermes(() => { throw new TypeError('enablePromiseRejectionTracker is not available'); });
    let mod = await import('./observability');
    expect(mod.initNativeObservability()).toBe(true);
    expect(mod.shareHermesRejectionTracker()).toBe(false);
    expect(posthog.instances).toHaveLength(1);
    expect(sdk.init).toHaveBeenCalledTimes(1);

    vi.resetModules(); vi.clearAllMocks(); posthog.instances.length = 0;
    configureBoth();
    const enable = vi.fn();
    stubRealHermes(enable, () => false);
    mod = await import('./observability');
    expect(mod.initNativeObservability()).toBe(true);
    expect(enable).not.toHaveBeenCalled();
  });

  it('registers nothing while neither provider is configured', async () => {
    platform.OS = 'ios';
    vi.stubEnv('EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN', '');
    vi.stubEnv('EXPO_PUBLIC_POSTHOG_HOST', '');
    vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN_IOS', '');
    const enable = vi.fn();
    stubRealHermes(enable);
    const { initNativeObservability } = await import('./observability');
    expect(initNativeObservability()).toBe(false);
    expect(enable).not.toHaveBeenCalled();
  });

  it('changes nothing without Hermes', async () => {
    platform.OS = 'android';
    vi.stubEnv('EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_fixture');
    vi.stubEnv('EXPO_PUBLIC_POSTHOG_HOST', 'https://e.unionground.example');
    vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN_ANDROID', 'https://public@o0.ingest.us.sentry.io/2');
    const { initNativeObservability, shareHermesRejectionTracker } = await import('./observability');
    expect(initNativeObservability()).toBe(true);
    expect(shareHermesRejectionTracker()).toBe(false);
    expect(sdk.init).toHaveBeenCalledTimes(1);
  });
});

// OPS-UG-POSTHOG-ANALYTICS-ON-MEMBER-PRODUCT-AND-PUBLIC-PAGES-20261027 (#6247)
describe('native pseudonymous product analytics', { timeout: 30_000 }, () => {
  const USER = '6f1c2a7e-0d3b-4c5e-9a8f-1b2c3d4e5f60';
  const ORG = '7d3e4f50-6a7b-4c8d-9e0f-a1b2c3d4e5f6';
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); posthog.instances.length = 0; secureStore.value = null; platform.OS = 'android';
    vi.stubGlobal('__DEV__', false);
    vi.stubEnv('EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_fixture');
    vi.stubEnv('EXPO_PUBLIC_POSTHOG_HOST', 'https://e.unionground.example');
    // The flag bootstrap (#6248) never reaches the network in these tests.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('sends a screen view only under hashes of the worker and organization, and nothing once the Account switch is off or the worker signs out', async () => {
    const hash = (value: string) => (DIGESTS[`unionground-analytics:v1:${value}`] ?? '').toLowerCase();
    const observability = await import('./observability');
    const preference = await import('./analyticsPreference');
    observability.initNativePosthog();
    const client = posthog.instances[0] as (typeof posthog.instances)[number] & { capture: ReturnType<typeof vi.fn> };
    expect(observability.captureNativeScreen('cases')).toBe(false);
    await preference.productAnalyticsEnabled();
    await observability.setNativeAnalyticsMember({ userID: USER, organizationID: ORG });
    // The recorder hands over its page key; only the feature label is captured (#6247 round 1).
    expect(observability.captureNativeScreen('/native/cases')).toBe(true);
    // The capture is stamped with its identity and generation (#6432 round 3).
    const [, captured] = client.capture.mock.calls.at(-1) as [string, Record<string, unknown>];
    expect(captured).toEqual({ view: 'cases', $ug_member: hash(USER), $ug_organization: hash(ORG), $ug_generation: expect.stringMatching(/^\d+:\d+$/) });

    const calls: Array<[string, RequestInit]> = [];
    // Event sends only; the flag bootstrap of a later member (#6248) is not one.
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { if (!url.includes('/flags/')) calls.push([url, init]); return { status: 200, ok: true, text: async () => '{}' }; }));
    const body = JSON.stringify({ api_key: 'phc_fixture', batch: [{ event: '$screen', properties: { ...captured, $screen_name: 'Taylor grievance', $device_id: 'd-1', distinct_id: 'device-1' } }] });
    await client.fetch('https://e.unionground.example/batch/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    expect(calls).toHaveLength(1);
    const [event] = (JSON.parse(String(calls[0]?.[1].body)) as { batch: Array<{ distinct_id: string; properties: Record<string, unknown> }> }).batch;
    expect(event?.distinct_id).toBe(hash(USER));
    expect(event?.properties).toMatchObject({ app_surface: 'member', view: 'cases', $groups: { organization: hash(ORG) }, surface: 'android' });
    expect(JSON.stringify(event)).not.toMatch(new RegExp(`${USER}|${ORG}|Taylor|device-1|d-1`));

    // Off: a screen already queued leaves nothing.
    await preference.setProductAnalyticsEnabled(false);
    expect(observability.captureNativeScreen('cases')).toBe(false);
    await client.fetch('https://e.unionground.example/batch/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    expect(calls).toHaveLength(1);

    // Back on: the consent generation moved, so the earlier screen stays dropped.
    await preference.setProductAnalyticsEnabled(true);
    await client.fetch('https://e.unionground.example/batch/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    expect(calls).toHaveLength(1);
    // Another member signs in before a retry: the queued screen is never sent under them.
    await observability.setNativeAnalyticsMember({ userID: 'other-member', organizationID: null });
    await client.fetch('https://e.unionground.example/batch/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    expect(calls).toHaveLength(1);
    // Signed out: no identity, nothing sent.
    await observability.setNativeAnalyticsMember(null);
    expect(observability.captureNativeScreen('cases')).toBe(false);
    await client.fetch('https://e.unionground.example/batch/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    expect(calls).toHaveLength(1);
  });

  it('never keeps an identity from an earlier worker when the account changes while the digest runs', async () => {
    const observability = await import('./observability');
    const preference = await import('./analyticsPreference');
    await preference.productAnalyticsEnabled();
    const first = observability.setNativeAnalyticsMember({ userID: USER, organizationID: ORG });
    const second = observability.setNativeAnalyticsMember({ userID: 'other-member', organizationID: null });
    await Promise.all([first, second]);
    expect(observability.currentNativeAnalyticsIdentity()).toMatchObject({ distinctId: '101d416dd5dd9ab0bf6980455be199ced4548c0977f97d915c6178517ed96ce1', organization: null });
  });

  // #6432 round 3 (P2): a screen opened while the digest runs is sent once the
  // identity is ready, and dropped if the member changes first.
  it('holds a screen opened while the identity digest runs for that identity only', async () => {
    const observability = await import('./observability');
    const preference = await import('./analyticsPreference');
    observability.initNativePosthog();
    const client = posthog.instances[0] as (typeof posthog.instances)[number] & { capture: ReturnType<typeof vi.fn> };
    await preference.productAnalyticsEnabled();
    const ready = observability.setNativeAnalyticsMember({ userID: USER, organizationID: ORG });
    expect(observability.captureNativeScreen('/native/cases')).toBe(false);
    await ready;
    expect(client.capture).toHaveBeenCalledTimes(1);
    expect(client.capture.mock.calls[0]?.[1]).toMatchObject({ view: 'cases' });
    client.capture.mockClear();
    const first = observability.setNativeAnalyticsMember({ userID: USER, organizationID: ORG });
    expect(observability.captureNativeScreen('/native/forms')).toBe(false);
    const second = observability.setNativeAnalyticsMember({ userID: 'other-member', organizationID: null });
    await Promise.all([first, second]);
    expect(client.capture).not.toHaveBeenCalled();
  });
});

// OPS-UG-POSTHOG-FLAGS-EXPERIMENTS-SURVEYS-HEATMAPS-20261027 (#6248).
describe('native feature flags', { timeout: 30_000 }, () => {
  const USER = '6f1c2a7e-0d3b-4c5e-9a8f-1b2c3d4e5f60';
  const ORG = '7d3e4f50-6a7b-4c8d-9e0f-a1b2c3d4e5f6';
  const hash = (value: string) => (DIGESTS[`unionground-analytics:v1:${value}`] ?? '').toLowerCase();
  const served = (variant: string) => ({ ok: true, status: 200, json: async () => ({ flags: { 'member-coach-mark': { enabled: true, variant } } }) });
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); posthog.instances.length = 0; secureStore.value = null; platform.OS = 'ios';
    vi.stubGlobal('__DEV__', false);
    vi.stubEnv('EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_fixture');
    vi.stubEnv('EXPO_PUBLIC_POSTHOG_HOST', 'https://e.unionground.example');
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('bootstraps member-coach-mark once per identity with only the two hashes, and records the exposure through the shared allowlist', async () => {
    const calls: Array<[string, RequestInit]> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push([url, init]); return url.includes('/flags/') ? served('test') : { status: 200, ok: true, text: async () => '{}' }; }));
    const observability = await import('./observability');
    const preference = await import('./analyticsPreference');
    observability.initNativePosthog();
    const client = posthog.instances[0] as (typeof posthog.instances)[number] & { capture: ReturnType<typeof vi.fn> };
    expect(observability.nativeFeatureFlag('member-coach-mark')).toBe('control');
    await preference.productAnalyticsEnabled();
    await observability.setNativeAnalyticsMember({ userID: USER, organizationID: ORG });
    await vi.waitFor(() => expect(observability.nativeFeatureFlag('member-coach-mark')).toBe('test'));
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(url).toBe('https://e.unionground.example/flags/?v=2');
    expect(init.headers).toMatchObject({ Origin: 'https://app.unionground.example' });
    expect(JSON.parse(String(init.body))).toEqual({ token: 'phc_fixture', distinct_id: hash(USER), geoip_disable: true, flag_keys_to_evaluate: ['member-coach-mark', 'member-default-view'], groups: { organization: hash(ORG) } });
    expect(String(init.body)).not.toMatch(new RegExp(`${USER}|${ORG}`));

    // The exposure, once, and rebuilt by the private fetch from the shared allowlist.
    expect(observability.reportNativeFlagExposure('member-coach-mark', 'home')).toBe(true);
    expect(observability.reportNativeFlagExposure('member-coach-mark', 'home')).toBe(false);
    const [name, captured] = client.capture.mock.calls.at(-1) as [string, Record<string, unknown>];
    expect(name).toBe('$feature_flag_called');
    const body = JSON.stringify({ api_key: 'phc_fixture', batch: [{ event: name, properties: { ...captured, $feature_flag_payload: 'Taylor', $device_id: 'd-1' } }] });
    await client.fetch('https://e.unionground.example/batch/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const [event] = (JSON.parse(String(calls.at(-1)?.[1].body)) as { batch: Array<{ distinct_id: string; properties: Record<string, unknown> }> }).batch;
    expect(event?.distinct_id).toBe(hash(USER));
    expect(event?.properties).toMatchObject({ $feature_flag: 'member-coach-mark', $feature_flag_response: 'test', view: 'home', $groups: { organization: hash(ORG) } });
    expect(JSON.stringify(event)).not.toMatch(/Taylor|d-1|\$ug_/);

    // The Account switch off, or the member signing out: the default again, and no exposure.
    await preference.setProductAnalyticsEnabled(false);
    expect(observability.nativeFeatureFlag('member-coach-mark')).toBe('control');
    await preference.setProductAnalyticsEnabled(true);
    await observability.setNativeAnalyticsMember(null);
    expect(observability.nativeFeatureFlag('member-coach-mark')).toBe('control');
    expect(observability.reportNativeFlagExposure('member-coach-mark', 'home')).toBe(false);
  });

  it('fails closed to the default when PostHog is unreachable or answers an unknown variant, and asks nothing while the switch is off', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('Network request failed'); });
    vi.stubGlobal('fetch', fetchMock);
    const observability = await import('./observability');
    const preference = await import('./analyticsPreference');
    observability.initNativePosthog();
    await preference.productAnalyticsEnabled();
    await observability.setNativeAnalyticsMember({ userID: USER, organizationID: ORG });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(observability.nativeFeatureFlag('member-coach-mark')).toBe('control');
    expect(observability.reportNativeFlagExposure('member-coach-mark', 'home')).toBe(false);

    fetchMock.mockImplementation(async () => served('Taylor') as never);
    await observability.setNativeAnalyticsMember({ userID: USER, organizationID: ORG });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(observability.nativeFeatureFlag('member-coach-mark')).toBe('control');

    await preference.setProductAnalyticsEnabled(false);
    await observability.setNativeAnalyticsMember({ userID: USER, organizationID: ORG });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
