const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function decodeBase64UrlAscii(value: string): string | null {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/').replace(/=+$/u, '');
  if (!normalized || /[^A-Za-z0-9+/]/u.test(normalized)) return null;
  let bits = 0;
  let bitCount = 0;
  let decoded = '';
  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index < 0) return null;
    bits = (bits << 6) | index;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      decoded += String.fromCharCode((bits >> bitCount) & 0xff);
      bits &= (1 << bitCount) - 1;
    }
  }
  return decoded;
}

export function sessionIDFromAccessToken(accessToken: string): string | null {
  const payload = accessToken.split('.')[1];
  if (!payload) return null;
  const decoded = decodeBase64UrlAscii(payload);
  if (!decoded) return null;
  try {
    const sessionID = (JSON.parse(decoded) as { session_id?: unknown }).session_id;
    return typeof sessionID === 'string' && SESSION_ID_PATTERN.test(sessionID)
      ? sessionID.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

export function accessTokensShareSessionLineage(left: string, right: string): boolean {
  const leftSessionID = sessionIDFromAccessToken(left);
  const rightSessionID = sessionIDFromAccessToken(right);
  return Boolean(leftSessionID && rightSessionID && leftSessionID === rightSessionID);
}

export type AuthenticatedLineage = { userID: string; sessionID: string | null };

// Whether an authenticated commit is a replacement login rather than the same
// session again. No earlier commit (a session loss in between), a different
// user, or the same user with a different readable session_id is a
// replacement. A token rotation keeps its session_id, and an unreadable
// session_id on either side counts as the same session, so an incomplete
// sign-out warning is never released on a guess
// (SEC-UG-SAME-ACCOUNT-REPLACEMENT-SESSION-INCOMPLETE-WARNING-20261020).
export function replacesAuthenticatedLineage(
  previous: AuthenticatedLineage | null,
  next: AuthenticatedLineage,
): boolean {
  if (!previous || previous.userID !== next.userID) return true;
  return Boolean(previous.sessionID && next.sessionID && previous.sessionID !== next.sessionID);
}
