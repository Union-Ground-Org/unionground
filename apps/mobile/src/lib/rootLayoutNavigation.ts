import { useNavigationContainerRef, usePathname, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { appRouteFromRouterPath, isPublicAppRoute, routerPath, type AppRoute } from './routes';
import { useApp } from '../state/AppProvider';

type PendingRoute = { current: AppRoute | null };

/**
 * Expo Router throws "Attempted to navigate before mounting the Root Layout
 * component" when replace or push runs while navigationRef.isReady() is false.
 * A system font change can destroy the Android activity after this layout has
 * rendered and before that flag is set, so the signed-out redirect has to wait.
 */
export function rootNavigatorIsReady(navigationRef: { isReady?: () => boolean } | null | undefined): boolean {
  if (!navigationRef || typeof navigationRef.isReady !== 'function') return false;
  try {
    return navigationRef.isReady() === true;
  } catch {
    return false;
  }
}

export function useRootNavigatorReady(): boolean {
  const navigationRef = useNavigationContainerRef();
  const [ready, setReady] = useState(() => rootNavigatorIsReady(navigationRef));
  useEffect(() => {
    let cancelled = false;
    const mark = () => {
      if (!cancelled) setReady(rootNavigatorIsReady(navigationRef));
    };
    mark();
    const unsubscribeReady = navigationRef.addListener('ready', mark);
    const unsubscribeState = navigationRef.addListener('state', mark);
    return () => {
      cancelled = true;
      unsubscribeReady();
      unsubscribeState();
    };
  }, [navigationRef]);
  return ready;
}

export function useRootSessionNavigation(pendingRoute: PendingRoute, navigatorReady: boolean): void {
  const router = useRouter();
  const pathname = usePathname();
  const navigationRef = useNavigationContainerRef();
  const { mode, session } = useApp();
  const sessionUserID = session?.user.id ?? null;
  const previousModeRef = useRef(mode);
  const sessionUserIDRef = useRef(sessionUserID);

  useEffect(() => {
    if (mode === 'booting') {
      previousModeRef.current = mode;
      sessionUserIDRef.current = sessionUserID;
      return;
    }
    if (!navigatorReady || !rootNavigatorIsReady(navigationRef)) return;

    const previousMode = previousModeRef.current;
    const previousSessionUserID = sessionUserIDRef.current;
    previousModeRef.current = mode;
    sessionUserIDRef.current = sessionUserID;

    const currentRoute = appRouteFromRouterPath(pathname);
    const sessionEnded = mode === 'signedOut' && (
      previousSessionUserID !== null
      || (previousMode !== 'booting' && previousMode !== 'signedOut')
    );
    if (sessionEnded) pendingRoute.current = null;
    if ((mode === 'signedOut' || mode === 'mfaRequired') && currentRoute && !isPublicAppRoute(currentRoute)) {
      if (!sessionEnded) pendingRoute.current = currentRoute;
      router.replace(mode === 'mfaRequired' ? '/mfa-challenge' : '/sign-in');
      return;
    }

    if ((mode === 'authenticated' || mode === 'preview') && pendingRoute.current) {
      const path = routerPath(pendingRoute.current);
      pendingRoute.current = null;
      if (path) router.replace(path as never);
    }
  }, [mode, navigatorReady, navigationRef, pathname, pendingRoute, router, sessionUserID]);
}
