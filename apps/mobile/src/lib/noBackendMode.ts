/**
 * Resolve the app state when no mobile backend has been configured.
 *
 * PREVIEW is entered only through the explicit signed-out control. The
 * bootstrap effect may settle after that tap, so it must retain that deliberate
 * in-memory session while every other state remains signed out.
 */
export function noBackendMode(currentMode: string): 'preview' | 'signedOut' {
  return currentMode === 'preview' ? 'preview' : 'signedOut';
}
