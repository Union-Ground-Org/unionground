// Focus half of the native page-view producer (
// AUTHENTICATED PAGE-VIEW PRODUCER): one authenticated page view per feature
// screen focus through the same public.record_workspace_page_view RPC the web
// client calls on route changes. Focus-gated, not mount-gated: a screen left
// mounted under a pushed conversation records again only when it is focused
// again, and never more than once a minute for the same feature. A failed
// send is swallowed so analytics never interrupts the screen the member is
// using. The pure decisions live in featurePageViews.ts.
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';
import { featurePageHat, nextFeaturePageView, type FeaturePageViewRecorder } from './featurePageViews';

export function useFeaturePageView(
  featureKey: string,
  enabled: boolean,
  record: FeaturePageViewRecorder,
  now: () => number = Date.now,
): void {
  const last = useRef<{ key: string; at: number } | null>(null);
  useFocusEffect(useCallback(() => {
    if (!enabled) return;
    const next = nextFeaturePageView(last.current, featureKey, now());
    if (!next) return;
    last.current = next;
    record(next.key, featurePageHat(featureKey)).catch(() => undefined);
  }, [enabled, featureKey, now, record]));
}
