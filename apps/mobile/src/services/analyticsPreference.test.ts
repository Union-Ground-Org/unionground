import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const values = new Map<string, string>();
const store = vi.hoisted(() => ({ failWrites: false, failReads: false, holdSet: null as null | Promise<void> }));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => {
    if (store.failReads) throw new Error('keychain unavailable');
    return values.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    if (store.holdSet) await store.holdSet;
    if (store.failWrites) throw new Error('keychain unavailable');
    values.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => { values.delete(key); }),
}));

import {
  ANALYTICS_DISABLED_KEY,
  gatePageViewRecorder,
  productAnalyticsEnabled,
  resetProductAnalyticsPreferenceForTests,
  setProductAnalyticsEnabled,
} from './analyticsPreference';

beforeEach(() => {
  values.clear();
  store.failWrites = false;
  store.failReads = false;
  store.holdSet = null;
  resetProductAnalyticsPreferenceForTests();
});

describe('REQ-UG-VISIBLE-ANALYTICS-OPT-OUT-20261016 native product analytics switch', () => {
  it('sends page views while on, and no request at all once the worker turns it off', async () => {
    const rpc = vi.fn(async () => null);
    const record = gatePageViewRecorder(rpc);
    await record('/native/cases', 'member');
    expect(rpc).toHaveBeenCalledTimes(1);

    await setProductAnalyticsEnabled(false);
    await record('/native/cases', 'member');
    await record('/native/steward', 'steward');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(values.get(ANALYTICS_DISABLED_KEY)).toBe('true');
  });

  it('keeps the choice across a relaunch and can turn back on', async () => {
    await setProductAnalyticsEnabled(false);
    resetProductAnalyticsPreferenceForTests();
    const rpc = vi.fn(async () => null);
    await gatePageViewRecorder(rpc)('/native/cases', 'member');
    expect(rpc).not.toHaveBeenCalled();
    expect(await productAnalyticsEnabled()).toBe(false);

    await setProductAnalyticsEnabled(true);
    expect(values.has(ANALYTICS_DISABLED_KEY)).toBe(false);
    await gatePageViewRecorder(rpc)('/native/cases', 'member');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('holds the gate for the session when the choice cannot be saved, and fails closed on an unreadable store', async () => {
    store.failWrites = true;
    expect(await setProductAnalyticsEnabled(false)).toBe(false);
    const rpc = vi.fn(async () => null);
    await gatePageViewRecorder(rpc)('/native/cases', 'member');
    expect(rpc).not.toHaveBeenCalled();

    resetProductAnalyticsPreferenceForTests();
    store.failReads = true;
    await gatePageViewRecorder(rpc)('/native/cases', 'member');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('stores the latest choice when the worker toggles faster than the keychain writes', async () => {
    let release = () => {};
    store.holdSet = new Promise<void>((resolve) => { release = resolve; });
    const off = setProductAnalyticsEnabled(false);
    const on = setProductAnalyticsEnabled(true);
    release();
    expect(await off).toBe(true);
    expect(await on).toBe(true);
    expect(values.has(ANALYTICS_DISABLED_KEY)).toBe(false);
    resetProductAnalyticsPreferenceForTests();
    expect(await productAnalyticsEnabled()).toBe(true);
  });

  it('aborts a page view still waiting on authentication when the switch is turned off', async () => {
    let release = () => {};
    const authentication = new Promise<void>((resolve) => { release = resolve; });
    const sent: string[] = [];
    const record = gatePageViewRecorder(async (page, _hat, signal) => {
      await authentication;
      if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      sent.push(page);
      return null;
    });
    const view = record('/native/cases', 'member').catch((error: unknown) => error);
    await Promise.resolve();
    await Promise.resolve();
    await setProductAnalyticsEnabled(false);
    release();
    expect(await view).toBeInstanceOf(DOMException);
    expect(sent).toEqual([]);

    await setProductAnalyticsEnabled(true);
    await record('/native/events', 'member');
    expect(sent).toEqual(['/native/events']);
  });

  it('gates the only native page-view producer and shows the switch on Account', () => {
    const supabase = readFileSync(join(__dirname, 'supabase.ts'), 'utf8');
    expect(supabase.match(/record_workspace_page_view/g)).toHaveLength(1);
    // FeatureScreen is the only caller: one import, one gated wrapper.
    const feature = readFileSync(join(__dirname, '../features/FeatureScreen.tsx'), 'utf8');
    // One gate covers the page view and the pseudonymous PostHog screen view (#6247).
    expect(feature).toContain('const writer = useBusinessWriter();\n  const recordFeaturePageView = useMemo(() => gatePageViewRecorder((page, hat, signal) => {\n    captureNativeScreen(page);\n    return recordMobileFeaturePageView(writer, page, hat, signal);\n  }), [writer]);');
    expect(feature).toContain("useFeaturePageView(featureKey, mode === 'authenticated' && productAnalytics === true, recordFeaturePageView);");
    expect(supabase).toContain("p_organization_id: null,\n  }, signal);");
    expect(supabase).toContain('const { data, error } = await (signal ? request.abortSignal(signal) : request);');
    expect(feature.match(/recordMobileFeaturePageView/g)).toHaveLength(2);
    const account = readFileSync(join(__dirname, '../../app/(tabs)/account.tsx'), 'utf8');
    expect(account).toContain('title={t("Product analytics")}');
    expect(account).toContain('onValueChange={(value) => { void toggleProductAnalytics(value); }}');
  });
});
