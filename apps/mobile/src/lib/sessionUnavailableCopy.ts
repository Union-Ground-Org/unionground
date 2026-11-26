// Copy for the fail-closed screen shown when a saved session could not be
// confirmed. Offline, the member is told the phone has no connection
// (UX-UG-NATIVE-OFFLINE-START-SHOWN-AS-SECURITY-CHECK-20261018);
// every other reason keeps the security wording. The buttons and the locked
// protected data are the same in both cases; only the words change.
import type { SessionUnavailableReason } from '../services/sessionResume';

export const SESSION_UNAVAILABLE_ERROR: Readonly<Record<SessionUnavailableReason, string>> = Object.freeze({
  offline: "You're offline. Union Ground needs a connection to open your account. Try again when you're back online.",
  assurance: 'Union Ground could not confirm your session security. Try again or sign out.',
});

export type SessionUnavailableCopy = { title: string; body: string };

export function sessionUnavailableCopy(reason: SessionUnavailableReason | null): SessionUnavailableCopy {
  if (reason === 'offline') {
    return {
      title: "You're offline",
      body: "Union Ground needs a connection to open your account. Try again when you're back online. Protected worker data stays locked until then.",
    };
  }
  return {
    title: 'Confirming account security',
    body: 'Union Ground could not confirm that you completed two-step sign-in. Your private information stays locked.',
  };
}
