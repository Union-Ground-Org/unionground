import { describe, expect, it } from 'vitest';

import { SESSION_UNAVAILABLE_ERROR, sessionUnavailableCopy } from './sessionUnavailableCopy';

// UX-UG-NATIVE-OFFLINE-START-SHOWN-AS-SECURITY-CHECK-20261018: an
// offline open says the phone is offline; every other failure keeps the
// security wording.
describe('session unavailable copy', () => {
  it('says the phone is offline, without security jargon, when there was no path to the backend', () => {
    const copy = sessionUnavailableCopy('offline');
    expect(copy.title).toBe("You're offline");
    expect(copy.body).toContain('needs a connection');
    expect(copy.body).toContain('stays locked');
    expect(`${copy.title} ${copy.body}`).not.toMatch(/authentication level|security|confirm/i);
    expect(SESSION_UNAVAILABLE_ERROR.offline).toBe("You're offline. Union Ground needs a connection to open your account. Try again when you're back online.");
  });

  it('keeps the security wording for an assurance failure while online, and when no reason is known', () => {
    for (const reason of ['assurance', null] as const) {
      const copy = sessionUnavailableCopy(reason);
      expect(copy.title).toBe('Confirming account security');
      expect(copy.body).toContain('could not confirm that you completed two-step sign-in');
      expect(copy.body).toContain('stays locked');
    }
    expect(SESSION_UNAVAILABLE_ERROR.assurance).toBe('Union Ground could not confirm your session security. Try again or sign out.');
  });
});
