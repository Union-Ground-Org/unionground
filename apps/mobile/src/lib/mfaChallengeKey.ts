import { sessionIDFromAccessToken } from './sessionLineage';

// Identity of one MFA challenge: the signed-in user and Auth session. A token
// refresh keeps it; signing out, or signing in again, changes it, so the
// challenge screen remounts with an empty code, a closed recovery section and
// no previous message instead of carrying the last attempt's text.
export function mfaChallengeKey(session: { user: { id: string }; access_token: string } | null): string {
  if (!session) return 'signed-out';
  return `${session.user.id}:${sessionIDFromAccessToken(session.access_token) ?? 'unknown-session'}`;
}
