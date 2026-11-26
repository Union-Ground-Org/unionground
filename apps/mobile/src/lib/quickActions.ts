import { NATIVE_TAB_ROOT_PATHS } from './chromeGeometry';

export const PINNED_DESTINATIONS_STORE_PREFIX = 'org.unionground.app.deck.shortcuts.v1';

// Route and identity gating for the right-edge quick-actions drawer.
// Home keeps its own carousel drawers, pre-session screens stay clean, and
// every hat opens the same Guide panel ( made for Union
// Ground and carried here).

export function quickActionsPathEligible(pathname: string): boolean {
  // routes.ts guards against a surviving '(tabs)' group segment; mirror it.
  const path = pathname.replace(/^\/\(tabs\)/, '') || '/';
  if (path === '/' || path === '/home' || path === '/sign-in' || path === '/mfa-challenge') return false;
  if (path.startsWith('/auth')) return false;
  if (path === '/compass') return false;
  return true;
}

export function nativeTabPath(pathname: string): boolean {
  const path = pathname.replace(/^\/\(tabs\)/, '') || '/';
  return NATIVE_TAB_ROOT_PATHS.includes(path);
}

// Shared by HomeCarousel's FunctionDeck and Work's pinned destinations so
// per-identity SecureStore keys never drift. Deck shortcuts are
// feature keys, not member content, so a role-shaped scope is acceptable.
export function quickActionsScope(
  mode: string,
  previewHat: string | null,
  authorizedRoles: string[],
): string {
  return mode === 'preview'
    ? `preview.${previewHat ?? 'member'}`
    : `authenticated.${authorizedRoles.join('.') || 'member'}`;
}

// Captured notes and tasks ARE member content: the authenticated scope must
// pin the stable account id (and chapter) so a different sign-in on the same
// device can never resolve to the same SecureStore keys.
export function quickCaptureScope(
  mode: string,
  previewHat: string | null,
  userId: string | null,
  chapterId: string | null,
): string {
  return mode === 'preview'
    ? `preview.${previewHat ?? 'member'}`
    : `authenticated.${userId ?? 'unknown'}.${chapterId ?? 'none'}`;
}
