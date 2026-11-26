import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FEATURE_PAGE_VIEW_WINDOW_MS, featurePageHat, featurePageKey, nextFeaturePageView } from './featurePageViews';

// OPS-UG-ANALYTICS-READ-SIDE-SHIPPED-BUT-NOTHING-IN-PRODUCTION-WRITES-ORGANIZATION-ENGAGEMENT-EVENTS-20260921
//: the native app records a page view on feature
// screen focus through the same RPC as the web client. The hook itself
// imports expo-router, so this file imports only the pure half and reads the
// hook as text.
describe('feature page views', () => {
  it('keys a native view under /native by feature key and records a hat only for desk features', () => {
    expect(featurePageKey('voting')).toBe('/native/voting');
    expect(featurePageKey('events-desk')).toBe('/native/events-desk');
    expect(featurePageKey('Bad Key')).toBeNull();
    expect(featurePageKey('')).toBeNull();
    expect(featurePageHat('steward')).toBe('steward');
    expect(featurePageHat('voting')).toBe('member');
    expect(FEATURE_PAGE_VIEW_WINDOW_MS).toBe(60_000);
  });

  it('sends the same feature once a minute and a changed feature at once', () => {
    const first = nextFeaturePageView(null, 'voting', 1_000);
    expect(first).toEqual({ key: '/native/voting', at: 1_000 });
    expect(nextFeaturePageView(first, 'voting', 30_000)).toBeNull();
    expect(nextFeaturePageView(first, 'events', 30_000)).toEqual({ key: '/native/events', at: 30_000 });
    expect(nextFeaturePageView(first, 'voting', 61_001)).toEqual({ key: '/native/voting', at: 61_001 });
    expect(nextFeaturePageView(first, 'Bad Key', 61_001)).toBeNull();
  });

  it('is focus-gated on live sessions only and calls the shared RPC without naming an organization', () => {
    const hook = readFileSync(new URL('./useFeaturePageView.ts', import.meta.url), 'utf8');
    const feature = readFileSync(new URL('../features/FeatureScreen.tsx', import.meta.url), 'utf8');
    const service = readFileSync(new URL('../services/supabase.ts', import.meta.url), 'utf8');
    expect(hook).toContain("import { useFocusEffect } from 'expo-router';");
    expect(hook).toContain('if (!enabled) return;');
    expect(hook).toContain('const next = nextFeaturePageView(last.current, featureKey, now());');
    expect(hook).toContain('record(next.key, featurePageHat(featureKey)).catch(() => undefined);');
    expect(feature).toContain("useFeaturePageView(featureKey, mode === 'authenticated' && productAnalytics === true, recordFeaturePageView);");
    expect(service).toContain("return businessRpc(writer, 'record_workspace_page_view', {");
    expect(service).toContain('p_organization_id: null,');
  });
});
