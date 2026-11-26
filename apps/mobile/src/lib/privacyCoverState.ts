// What the privacy cover shows. In the background it stays blank so the app
// switcher snapshot carries nothing. In the foreground the cover only stays up
// while the session is being re-checked, so it says so (visibly and to screen
// readers) instead of looking like a blank, frozen app.
export type PrivacyCoverContent = 'blank' | 'checking';

export function privacyCoverContent(appActive: boolean): PrivacyCoverContent {
  return appActive ? 'checking' : 'blank';
}

export const PRIVACY_COVER_CHECKING_LABEL = 'Checking your secure session…';

// On the SAMPLE host every sign-in enters the demo, and the cover that rises
// over a signed-out screen stays up through the first load. It says so (lane
// L204, Nov 7, 2026). The mode turns booting in the same update that raises
// the cover, so the decision reads the mode from the last uncovered render. A
// cover that rises any other way, such as a cold restore or a return from the
// background, keeps the session-check words. Sign-out lowers the cover before
// it reaches signedOut.
export const PRIVACY_COVER_DEMO_LABEL = 'Opening the demo…';

export function coverOpensDemo(current: { covered: boolean; liveSample: boolean; modeBeforeCover: string }): boolean {
  return current.covered && current.liveSample && current.modeBeforeCover === 'signedOut';
}
