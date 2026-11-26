import type { AppStateStatus } from 'react-native';

// Whether leaving the foreground should raise the full-screen privacy cover.
// iOS keeps an in-app provider sheet (Google's web authentication session) on
// screen while the app reports `inactive`. The cover is itself a full-screen
// modal, so presenting it then stacks over that sheet, blanks it and can stay
// stuck after it closes. While a native sign-in prompt is open, `inactive`
// therefore leaves the cover down; real backgrounding still raises it.
export function shouldCoverOnAppState(next: AppStateStatus, protectedSurface: boolean, nativeAuthPromptOpen: boolean): boolean {
  if (!protectedSurface) return false;
  if (next === 'background') return true;
  return next === 'inactive' && !nativeAuthPromptOpen;
}
