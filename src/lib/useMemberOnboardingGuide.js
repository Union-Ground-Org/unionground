import { useCallback, useEffect, useRef, useState } from "react";
import {
  INACTIVE_GUIDE,
  ONBOARDING_GUIDE_REFRESH_EVENT,
  normalizeOnboardingGuide,
  readMemberOnboardingGuide,
  readGuideShowAll,
  readGuideShowAllChoice,
  writeGuideShowAll,
  writeGuideShowAllChoice,
} from "./onboardingGuide.js";

// REQ-UG-PROGRESSIVE-DISCLOSURE-AND-FEATURE-DRIP-20261001. The shell's one
// read of the onboarding guide. It runs only when `enabled` (a live session
// whose organization turned a guide switch on), re-reads on scope or navigation
// (`refreshKey`) and on ONBOARDING_GUIDE_REFRESH_EVENT. Errors clear server
// guidance; the shell may still apply its first-14-day guided navigation,
// with the member's Show everything escape hatch. A failed read is never treated as finished
// onboarding (BUG-UG-GUIDE-LOAD-FAILURE-HIDES-GUIDANCE-20261018):
// `loadFailed` turns on so the shell shows a "could not load, try again" card
// (unless this member's last good read already said no guide applies or
// onboarding is complete),
// `retry` re-reads, and coming back online re-reads at most
// GUIDE_RECONNECT_RETRY_LIMIT times per failure streak.
// `showAllByDefault` starts an account on the full navigation when it has made
// no choice on this device. The sample site's shared personas use it: their
// onboarding progress belongs to every visitor at once, so the guided view
// must not be what a first visit sees. "Show the guided view" still works, and
// that choice is remembered on the device like any other.
function storedShowAll(memberId, showAllByDefault) {
  return showAllByDefault ? readGuideShowAllChoice(memberId) ?? true : readGuideShowAll(memberId);
}

export const GUIDE_RECONNECT_RETRY_LIMIT = 3;

export function useMemberOnboardingGuide({ client, enabled, memberId, organizationId = null, chapterId = null, refreshKey, showAllByDefault = false }) {
  const scopeKey = JSON.stringify([memberId, organizationId, chapterId]);
  const [loadedGuide, setLoadedGuide] = useState(null);
  const [showAll, setShowAllState] = useState(() => storedShowAll(memberId, showAllByDefault));
  const [tick, setTick] = useState(0);
  const [failedScope, setFailedScope] = useState(null);
  const loadFailed = failedScope === scopeKey;
  const reconnectRetries = useRef(0);
  const knownDone = useRef(false);

  useEffect(() => { setShowAllState(storedShowAll(memberId, showAllByDefault)); }, [memberId, showAllByDefault]);
  useEffect(() => { knownDone.current = false; reconnectRetries.current = 0; }, [scopeKey]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onRefresh = () => setTick((value) => value + 1);
    window.addEventListener(ONBOARDING_GUIDE_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ONBOARDING_GUIDE_REFRESH_EVENT, onRefresh);
  }, []);

  useEffect(() => {
    if (!loadFailed || typeof window === "undefined") return undefined;
    const onOnline = () => {
      if (reconnectRetries.current >= GUIDE_RECONNECT_RETRY_LIMIT) return;
      reconnectRetries.current += 1;
      setTick((value) => value + 1);
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [loadFailed]);

  useEffect(() => {
    if (!enabled || !client || !memberId) {
      setLoadedGuide(null);
      setFailedScope(null);
      return undefined;
    }
    // Same-scope refreshes retain the current guide. A replacement scope must
    // have no old next step or disclosure policy while its request is pending.
    setLoadedGuide(current => current?.scopeKey === scopeKey ? current : null);
    let cancelled = false;
    readMemberOnboardingGuide(client)
      .then((payload) => {
        if (cancelled) return;
        const next = normalizeOnboardingGuide(payload);
        reconnectRetries.current = 0;
        if (next.ready) knownDone.current = !next.applies || next.onboardingComplete === true;
        setFailedScope(null);
        setLoadedGuide({ scopeKey, guide: next, payload });
      })
      .catch(() => {
        if (cancelled) return;
        setLoadedGuide(null);
        setFailedScope(knownDone.current ? null : scopeKey);
      });
    return () => { cancelled = true; };
  }, [client, enabled, memberId, scopeKey, refreshKey, tick]);

  const setShowAll = useCallback((value) => {
    if (showAllByDefault) writeGuideShowAllChoice(memberId, Boolean(value));
    else writeGuideShowAll(memberId, value);
    setShowAllState(Boolean(value));
  }, [memberId, showAllByDefault]);

  const retry = useCallback(() => setTick((value) => value + 1), []);

  // Match the current scope before effects run, so old guidance never flashes.
  const current = enabled && loadedGuide?.scopeKey === scopeKey ? loadedGuide : null;
  const guide = current ? current.guide : INACTIVE_GUIDE;
  // `payload` is the server's answer for this scope, for the guide engine.
  return { guide, payload: current ? current.payload : null, loadFailed: enabled && loadFailed, retry, showAll, setShowAll };
}
