import { useEffect, useSyncExternalStore } from 'react';
import { analyticsFlagValue } from '../../../../src/lib/posthogPrivacy.js';
import type { AnalyticsFlagKey, AnalyticsFlagValues } from '../../../../src/lib/posthogPrivacy.js';
import { useProductAnalyticsEnabled } from './analyticsPreference';

// OPS-UG-POSTHOG-FLAGS-EXPERIMENTS-SURVEYS-HEATMAPS-20261027 (#6248):
// the member's served flag values for screens. observability.ts fetches them
// once per identity, publishes them here and clears them when the identity
// changes; this module imports no SDK, so a screen that reads a flag does not
// pull the monitoring clients into its import graph.
let served: AnalyticsFlagValues | null = null;
let exposureReporter: ((key: AnalyticsFlagKey, view: string) => boolean) | null = null;
const listeners = new Set<() => void>();

export function publishNativeFlags(values: AnalyticsFlagValues | null): void {
  if (served === values) return;
  served = values;
  listeners.forEach((listener) => listener());
}

export function setNativeFlagExposureReporter(reporter: ((key: AnalyticsFlagKey, view: string) => boolean) | null): void {
  exposureReporter = reporter;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// A member feature flag for a screen. The default until PostHog has served
// this member a value, and whenever the Account switch is off; `exposed` says
// whether the member actually meets the flagged experience, and only then is
// the exposure recorded for the experiment.
export function useNativeFeatureFlag(key: AnalyticsFlagKey, { view, exposed = true }: { view: string; exposed?: boolean }): string {
  const analyticsOn = useProductAnalyticsEnabled() === true;
  const value = useSyncExternalStore(subscribe, () => analyticsFlagValue(analyticsOn ? served : null, key));
  useEffect(() => {
    if (exposed && analyticsOn) exposureReporter?.(key, view);
  }, [key, value, exposed, analyticsOn, view]);
  return value;
}
