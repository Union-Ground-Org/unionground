import { useEffect, useSyncExternalStore } from "react";
import { memberFeatureFlag, reportMemberFlagExposure, subscribeMemberFeatureFlags } from "./deferredObservability.js";
import { analyticsFlagValue } from "./posthogPrivacy.js";

// OPS-UG-POSTHOG-FLAGS-EXPERIMENTS-SURVEYS-HEATMAPS-20261027 (#6248):
// a member feature flag for a component. The value is the flag's default
// until PostHog has served this member one; `exposed` says whether the member
// actually meets the flagged experience, and only then is the exposure
// recorded for the experiment.
export function useMemberFeatureFlag(key, { exposed = true } = {}) {
  const value = useSyncExternalStore(subscribeMemberFeatureFlags, () => memberFeatureFlag(key), () => analyticsFlagValue(null, key));
  // A served value equal to the default re-renders nothing, so an exposure
  // that was not yet recordable waits for the flags to arrive (it is still
  // recorded once per identity and flag).
  useEffect(() => {
    if (!exposed || reportMemberFlagExposure(key)) return undefined;
    return subscribeMemberFeatureFlags(() => { reportMemberFlagExposure(key); });
  }, [key, value, exposed]);
  return value;
}
