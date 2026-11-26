// REQ-UG-PROGRESSIVE-DISCLOSURE-AND-FEATURE-DRIP-20261001 (native).
// Reads the caller's own onboarding guide whenever the hosting screen gains
// focus, only for a live authenticated session, and fails open (no guide, full
// destination list) on any error. PREVIEW never shows a guide: the switches
// belong to a real organization.
// BUG-UG-GUIDE-LOAD-FAILURE-HIDES-GUIDANCE-20261018: a failed read is
// never treated as finished onboarding. `loadFailed` turns on so Home and the
// Union screen show a "could not load, try again" card (unless this user's
// last good read already said no guide applies or onboarding is complete; the
// app has no organization switch list to check first), `retry` re-reads, and
// the app returning to the foreground re-reads at most
// GUIDE_FOREGROUND_RETRY_LIMIT times per failure streak.

import * as SecureStore from 'expo-secure-store';
import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { INACTIVE_ONBOARDING_GUIDE, normalizeOnboardingGuide, type OnboardingGuide } from '../../lib/onboardingGuide';
import { getSupabaseClient } from '../../services/supabase';
import { useApp } from '../../state/AppProvider';

// A view preference only (never sent anywhere), keyed by the signed-in user.
function showAllKey(userId: string): string {
  return `ug.onboardingGuide.showAll.${userId.replace(/[^A-Za-z0-9._-]/g, '')}`;
}

export async function loadNativeOnboardingGuide(): Promise<OnboardingGuide> {
  const client = getSupabaseClient();
  if (!client) return INACTIVE_ONBOARDING_GUIDE;
  const response: { data: unknown; error: unknown } = await client.rpc('get_member_onboarding_guide');
  if (response.error) throw response.error;
  return normalizeOnboardingGuide(response.data);
}

export const GUIDE_FOREGROUND_RETRY_LIMIT = 3;

// Home and the All features drawer can mount separate consumers. Share a
// successful read only within the exact session object supplied by AppProvider;
// a replacement session (even for the same user) never receives the old result.
// An older consumer's pending read must not undo a newer successful retry.
type GuideChannel = { readers: Set<(guide: OnboardingGuide) => void>; nextRequest: number; latestSuccess: number };
const sessionReaders = new WeakMap<object, GuideChannel>();

function channelFor(session: object): GuideChannel {
  let channel = sessionReaders.get(session);
  if (!channel) {
    channel = { readers: new Set(), nextRequest: 0, latestSuccess: 0 };
    sessionReaders.set(session, channel);
  }
  return channel;
}

export type OnboardingGuideState = {
  guide: OnboardingGuide;
  loadFailed: boolean;
  retry: () => void;
  showAll: boolean;
  setShowAll: (value: boolean) => void;
};

export function useOnboardingGuide(): OnboardingGuideState {
  const { mode, session } = useApp();
  const focused = useIsFocused();
  const userId = mode === 'authenticated' ? session?.user.id ?? null : null;
  const [loaded, setLoaded] = useState<{ session: typeof session; guide: OnboardingGuide; loadFailed: boolean } | null>(null);
  const [showAll, setShowAllState] = useState(false);
  const current = userId && loaded?.session === session ? loaded : null;
  const loadFailed = current?.loadFailed ?? false;
  const [tick, setTick] = useState(0);
  const foregroundRetries = useRef(0);
  const knownDone = useRef(false);

  useEffect(() => { knownDone.current = false; foregroundRetries.current = 0; }, [session]);

  useEffect(() => {
    if (!userId || !session) return undefined;
    const { readers } = channelFor(session);
    const receive = (next: OnboardingGuide) => {
      foregroundRetries.current = 0;
      if (next.ready) knownDone.current = !next.applies || next.onboardingComplete === true;
      setLoaded({ session, guide: next, loadFailed: false });
    };
    readers.add(receive);
    return () => { readers.delete(receive); };
  }, [session, userId]);

  useEffect(() => {
    if (!userId) { setShowAllState(false); return undefined; }
    let cancelled = false;
    SecureStore.getItemAsync(showAllKey(userId))
      .then((value) => { if (!cancelled) setShowAllState(value === 'true'); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [userId]);

  useEffect(() => {
    if (!loadFailed || !userId) return undefined;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || foregroundRetries.current >= GUIDE_FOREGROUND_RETRY_LIMIT) return;
      foregroundRetries.current += 1;
      setTick((value) => value + 1);
    });
    return () => subscription.remove();
  }, [loadFailed, userId]);

  useEffect(() => {
    if (!userId || !session || !focused) {
      if (!userId) setLoaded(null);
      return undefined;
    }
    let cancelled = false;
    const channel = channelFor(session);
    const request = ++channel.nextRequest;
    loadNativeOnboardingGuide()
      .then((next) => {
        if (cancelled || request < channel.latestSuccess) return;
        if (!next.ready) {
          // An unavailable read says nothing about another consumer's failure
          // or a pending recovery. Only a validated response is shared.
          setLoaded({ session, guide: next, loadFailed: false });
          return;
        }
        channel.latestSuccess = request;
        for (const receive of channel.readers) receive(next);
      })
      .catch(() => {
        if (cancelled || request < channel.latestSuccess) return;
        setLoaded({ session, guide: INACTIVE_ONBOARDING_GUIDE, loadFailed: !knownDone.current });
      });
    return () => { cancelled = true; };
  }, [focused, userId, session, tick]);

  const retry = useCallback(() => setTick((value) => value + 1), []);

  const setShowAll = useCallback((value: boolean) => {
    setShowAllState(value);
    if (!userId) return;
    const key = showAllKey(userId);
    void (value ? SecureStore.setItemAsync(key, 'true') : SecureStore.deleteItemAsync(key)).catch(() => undefined);
  }, [userId]);

  return { guide: current?.guide ?? INACTIVE_ONBOARDING_GUIDE, loadFailed, retry, showAll, setShowAll };
}
