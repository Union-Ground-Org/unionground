// OPS-UG-ANALYTICS-READ-SIDE-SHIPPED-BUT-NOTHING-IN-PRODUCTION-WRITES-ORGANIZATION-ENGAGEMENT-EVENTS-20260921
// ( AUTHENTICATED PAGE-VIEW PRODUCER): the pure half
// of the native page-view producer. The page key is the feature key under
// /native so web paths and native screens stay distinguishable in
// organization_page_views; a hat is recorded only for desk features (the RPC
// still verifies the caller holds it). Kept free of expo-router so it can be
// unit-tested; the focus hook lives in useFeaturePageView.ts.
export const FEATURE_PAGE_VIEW_WINDOW_MS = 60_000;
const FEATURE_KEY = /^[a-z0-9-]{1,60}$/;
const HAT_FEATURE_KEYS = new Set(['steward', 'coordinator', 'advisor', 'admin', 'vp']);

export function featurePageKey(featureKey: string): string | null {
  return FEATURE_KEY.test(featureKey) ? `/native/${featureKey}` : null;
}

export function featurePageHat(featureKey: string): string {
  return HAT_FEATURE_KEYS.has(featureKey) ? featureKey : 'member';
}

export type FeaturePageViewRecorder = (page: string, hat: string) => Promise<unknown>;

// Decides whether a focus should send a view: the same feature is not re-sent
// inside the server's one-minute idempotency window. Returns the page key to
// send, or null.
export function nextFeaturePageView(
  last: { key: string; at: number } | null,
  featureKey: string,
  at: number,
): { key: string; at: number } | null {
  const key = featurePageKey(featureKey);
  if (!key) return null;
  if (last && last.key === key && at - last.at < FEATURE_PAGE_VIEW_WINDOW_MS) return null;
  return { key, at };
}
