// BUG-UG-NATIVE-SIGN-IN-SILENT-DROP-20261104: a sign-in that set a
// session and then lost it, or a session revalidation refused, used to return
// to the sign-in form with nothing said. The provider asks this tracker which
// notice the signed-out form owes the member.
import type { SessionResumeAuth } from '../services/sessionResume';
import { sessionIDFromAccessToken } from './sessionLineage';

export const SIGN_IN_DID_NOT_COMPLETE_NOTICE = 'Sign-in did not complete because Union Ground could not keep your session. Sign in again. If this keeps happening, contact support below.';
export const SESSION_NOT_CONFIRMED_NOTICE = 'Union Ground could not confirm your session, so this device signed out. Sign in again to continue.';

export function createSignInCompletion() {
  // True from a sign-in submission until the member reaches the signed-in
  // surface, the attempt is refused (the form shows that refusal itself), or
  // the member signs out on purpose.
  let pending = false;
  // A sign-out the member chose (an MFA recovery's local clear) is running;
  // the loss it causes is theirs, not a refusal (#7021 round 2).
  let intentional = 0;
  return {
    begin() { pending = true; },
    settle() { pending = false; },
    isPending() { return pending; },
    async intentionalExit<T>(exit: () => Promise<T>): Promise<T> {
      pending = false;
      intentional += 1;
      try { return await exit(); } finally { intentional -= 1; }
    },
    // Auth reported no session. Only a pending sign-in is owed a notice; any
    // other loss keeps its existing copy (signed out elsewhere, cleanup).
    sessionLost(): string | null {
      const owed = pending && intentional === 0;
      pending = false;
      return owed ? SIGN_IN_DID_NOT_COMPLETE_NOTICE : null;
    },
    // Revalidation refused the session and this device signed out.
    sessionRefused(): string | null {
      const owed = pending;
      pending = false;
      if (intentional > 0) return null;
      return owed ? SIGN_IN_DID_NOT_COMPLETE_NOTICE : SESSION_NOT_CONFIRMED_NOTICE;
    },
  };
}

export const signInCompletion = createSignInCompletion();

// A resume's Auth calls outlive its deadline: Auth still answers them, and a
// refusal then arrives as SIGNED_OUT after the resume has finished, so the
// listener no longer sees an interrupted resume (#7021 rounds 2 and 3). The
// provenance lasts while any of the check's Auth calls (refresh, user lookup,
// assurance) is awaiting an answer, and belongs to the session lineage (user
// and session id) it checks, never a replacement. Past the deadline the
// resume starts no further stage, so these calls are the whole check.
type Lineage = { userID: string; accessToken: string };

export function createResumeRefreshProvenance() {
  const outstanding = new Map<string, number>();
  const key = (lineage: Lineage) => `${lineage.userID}:${sessionIDFromAccessToken(lineage.accessToken) ?? 'invalid'}`;
  return {
    track(auth: SessionResumeAuth, lineage: Lineage): SessionResumeAuth {
      const id = key(lineage);
      const tracked = <T,>(call: () => Promise<T>): Promise<T> => {
        outstanding.set(id, (outstanding.get(id) ?? 0) + 1);
        const release = () => {
          const left = (outstanding.get(id) ?? 1) - 1;
          if (left > 0) outstanding.set(id, left);
          else outstanding.delete(id);
        };
        let answer: Promise<T>;
        try { answer = call(); } catch (error) { release(); throw error; }
        answer.then(release, release);
        return answer;
      };
      return {
        refreshSession: () => tracked(() => auth.refreshSession()),
        getUser: () => tracked(() => auth.getUser()),
        mfa: { getAuthenticatorAssuranceLevel: () => tracked(() => auth.mfa.getAuthenticatorAssuranceLevel()) },
      };
    },
    covers(lineage: Lineage | null): boolean {
      return Boolean(lineage?.accessToken && outstanding.has(key(lineage)));
    },
  };
}

export const resumeRefreshProvenance = createResumeRefreshProvenance();
