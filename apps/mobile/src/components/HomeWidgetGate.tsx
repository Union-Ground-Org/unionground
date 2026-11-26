import { useEffect, useLayoutEffect, useMemo } from 'react';
import { AppState } from 'react-native';

import { sessionIDFromAccessToken } from '../lib/sessionLineage';
import { homeWidgets, readHomeWidgetSnapshot } from '../services/homeWidgets';
import { useApp } from '../state/AppProvider';

export function useHomeWidgetScope() {
  const { mode, session, organizationID, chapterMemberships, sessionRestricted } = useApp();
  const membership = chapterMemberships.find((entry) => entry.selected);
  const userID = session?.user.id;
  const sessionID = session ? sessionIDFromAccessToken(session.access_token) : null;
  const chapterID = membership?.organizationID === organizationID ? membership?.chapterID : null;
  return useMemo(() => mode === 'authenticated' && !sessionRestricted && userID && sessionID && organizationID && chapterID
    ? { userID, sessionID, organizationID, chapterID } : null,
  [mode, sessionRestricted, userID, sessionID, organizationID, chapterID]);
}

export function HomeWidgetGate() {
  const scope = useHomeWidgetScope();
  const { mode, error, refreshing, sessionRestrictionPending, session, locked, privacyCovered, signOutBusy } = useApp();
  useLayoutEffect(() => {
    // Protected rows disappear during ordinary resume, without ending the
    // session. Publication stays suspended until the exact scope is authorized.
    // establishSession commits authenticated mode before its dashboard read
    // finishes. That intermediate null scope is unresolved, not a revocation.
    const transition = error ? homeWidgets.setScope(null)
      : mode === 'booting' || sessionRestrictionPending || (mode === 'authenticated' && refreshing) ? homeWidgets.suspend()
        : homeWidgets.setScope(scope);
    void transition?.catch(() => undefined);
  }, [scope, mode, error, refreshing, sessionRestrictionPending]);
  useEffect(() => {
    const refresh = () => {
      if (!scope || !session || error || refreshing || sessionRestrictionPending || locked || privacyCovered || signOutBusy || AppState.currentState !== 'active') return;
      void homeWidgets.refresh(scope, () => readHomeWidgetSnapshot(session, scope)).catch(() => undefined);
    };
    refresh();
    const unsubscribe = homeWidgets.subscribe(refresh);
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') refresh(); });
    return () => { unsubscribe(); subscription.remove(); };
  }, [scope, session, error, refreshing, sessionRestrictionPending, locked, privacyCovered, signOutBusy]);
  return null;
}
