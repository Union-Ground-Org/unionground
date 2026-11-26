// Leaving the secure email screen for sign-in
// (UX-UG-NATIVE-LINK-FAILURE-ASK-ADMINISTRATOR-20261018, gate rounds
// on #5036). A signed-in member who opened a link must be signed out first,
// and signOut() can return without signing out (a refused teardown, a boot
// still in progress). So the navigation never follows the promise: it
// follows the committed app mode. The exit is remembered; while the app is
// booting it waits; once a live session is seen it asks for sign-out; once
// the mode is `signedOut` it navigates; and only a sign-out that settled
// while the member is still signed in is a refusal, which keeps them here
// with the sign-out diagnosis. Every decision reads state committed by
// React, never a ref captured before the sign-out settled.
import { EMAIL_AUTH_SIGN_IN_PATH } from './emailAuth';

export type EmailAuthExit = { reset: boolean };
export type EmailAuthSignOutState = 'idle' | 'in-flight' | 'settled';
export type EmailAuthExitStep = 'none' | 'navigate' | 'wait' | 'start-sign-out' | 'refused';

export function emailAuthExitHref(exit: EmailAuthExit): string | { pathname: string; params: { reset: '1' } } {
  return exit.reset ? { pathname: EMAIL_AUTH_SIGN_IN_PATH, params: { reset: '1' } } : EMAIL_AUTH_SIGN_IN_PATH;
}

export function emailAuthExitStep(mode: string, exit: EmailAuthExit | null, signOut: EmailAuthSignOutState): EmailAuthExitStep {
  if (!exit) return 'none';
  // Signed out wins over everything else, including a sign-out whose promise
  // settled in the same commit as the signedOut mode.
  if (mode === 'signedOut') return 'navigate';
  if (mode === 'booting') return 'wait';
  if (signOut === 'idle') return 'start-sign-out';
  if (signOut === 'in-flight') return 'wait';
  return 'refused';
}
