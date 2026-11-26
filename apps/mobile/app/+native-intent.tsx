import { HOME_TAB_PATH, isRefusedAuthCallbackLink, parseAppRoute, refusedAuthCallbackPath, routerPath, unresolvedCustomSchemeHomePath } from '../src/lib/routes';
import { recordLifecycleEvent } from '../src/services/lifecycleDiagnostics';
import { nativeQuickActionGatePathFromSystemPath } from '../src/services/nativeQuickActionRoutes';

// Unresolved custom-scheme hosts must return the Home tab path, not `/`.
// `/` is the index Redirect shell and has no content route, which is the
// chrome-only dump the G6 drill recorded. The inbound path is never logged:
// it is attacker-controlled and can carry an auth callback code.
// See BUG-UG-MOBILE-UNKNOWN-SCHEME-ROUTE-DEAD-END-20260905.
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
  const quickActionPath = nativeQuickActionGatePathFromSystemPath(path);
  if (quickActionPath) {
    recordLifecycleEvent({ scope: 'deep-link', step: 'redirect-system-path', outcome: 'quick-action', detail: { initial } });
    return quickActionPath;
  }
  const route = parseAppRoute(path);
  if (!route) {
    // A sign-in link the app will not use (a session in the fragment, extra
    // parameters) opens the callback screen with no code, which shows "Sign-in
    // link unavailable" and a way out. Nothing from the link is passed on: a
    // link carrying only the auth server's error parameters gets one fixed
    // query that says it was refused (refusedAuthCallbackPath), never its values.
    if (isRefusedAuthCallbackLink(path)) {
      recordLifecycleEvent({ scope: 'deep-link', step: 'redirect-system-path', outcome: 'refused-auth-callback', detail: { initial } });
      return refusedAuthCallbackPath(path);
    }
    const fallback = unresolvedCustomSchemeHomePath(path) ?? '/';
    recordLifecycleEvent({ scope: 'deep-link', step: 'redirect-system-path', outcome: 'home-fallback', detail: { initial } });
    return fallback;
  }
  if (route.kind === 'authCallback') {
    recordLifecycleEvent({ scope: 'deep-link', step: 'redirect-system-path', outcome: 'auth-callback', detail: { initial } });
    return `/auth/callback?code=${encodeURIComponent(route.code)}`;
  }
  if (route.kind === 'emailAuth') {
    recordLifecycleEvent({ scope: 'deep-link', step: 'redirect-system-path', outcome: 'auth-callback', detail: { initial } });
    const key = route.action === 'invitation' ? 'invite' : 'resetTicket';
    return `/auth/callback?${key}=${encodeURIComponent(route.token)}`;
  }
  const resolved = routerPath(route);
  recordLifecycleEvent({
    scope: 'deep-link',
    step: 'redirect-system-path',
    outcome: resolved ? 'app-route' : 'home-fallback',
    detail: { initial },
  });
  return resolved ?? HOME_TAB_PATH;
}
