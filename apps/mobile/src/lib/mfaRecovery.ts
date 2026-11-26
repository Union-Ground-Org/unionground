// The phone's MFA challenge accepted a 6-8 digit authenticator code and nothing
// else, so a member holding their saved one-time codes had no way through and
// the only advice on the screen was to ask an administrator. The web challenge
// already redeems the same codes at /api/mfa-recovery from its aal1 session;
// this is that exchange, kept out of the screen so the order that matters — the
// stored session is cleared only after the server accepted the code — is
// testable without a renderer.

export type MfaRecoveryOutcome = 'recovered' | 'rejected' | 'unavailable' | 'cleanup-required';

// Matches the web challenge's field and the server's 18-32 character bound.
// The codes are whatever public.generate_mfa_recovery_codes() issues — today
// a fixed prefix and four groups of four hex digits, PSG-XXXX-XXXX-XXXX-XXXX
// (supabase/migrations/20261014013000_unionground_organizing_seed_copy.sql).
// The prefix is the database's to choose; nothing here depends on it. The
// claim RPC uppercases and drops the separators itself, so a worker may type
// them either way.
export const MFA_RECOVERY_CODE_PATTERN = /^[A-Za-z0-9-]{18,32}$/;

export function normalizeMfaRecoveryCode(raw: string): string {
  return raw.replace(/\s+/g, '');
}

export function mfaRecoveryCodeAccepted(raw: string): boolean {
  return MFA_RECOVERY_CODE_PATTERN.test(normalizeMfaRecoveryCode(raw));
}

export function mfaRecoveryMessage(outcome: MfaRecoveryOutcome): string {
  if (outcome === 'cleanup-required') {
    return 'Recovery code accepted. Finish signing out on this device; the code will not be sent again.';
  }
  if (outcome === 'recovered') {
    return 'Recovery code accepted. The authenticator was removed and every session signed out. Sign in again to set up a new one.';
  }
  if (outcome === 'rejected') {
    return 'That recovery code was not accepted. Check the code you saved, or try another one.';
  }
  return 'Recovery could not be completed. Try again, or ask your campaign administrator to reset your two-step sign-in.';
}

// Narrower than `fetch` on purpose: the one call this module makes, in the one
// shape the portal accepts. The global fetch satisfies it, and a test double can
// implement it without asserting its way through the DOM signature.
export type MfaRecoveryRequest = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<MfaRecoveryResponse>;

// `json` is read only on an accepted answer, to see the server's own
// statement that every session was revoked.
export type MfaRecoveryResponse = { ok: boolean; status: number; json?: () => Promise<unknown> };

export type MfaRecoveryDependencies = {
  // `resolveMfaRecoveryApiOrigin`, passed in rather than imported: the trusted-origin
  // check reads the Expo manifest, and this module stays free of the native
  // runtime so its outcomes can be proved in plain Node.
  apiOrigin: () => string;
  accessToken: () => Promise<string | null>;
  signOutLocally: () => Promise<void | boolean>;
  // Runs before `signOutLocally`, and only when the server's 200 body states
  // `sessionsRevoked: true`: the provider releases an incomplete global
  // sign-out warning for this account, which the global logout just finished.
  confirmGlobalSignOut?: () => void;
  request?: MfaRecoveryRequest;
};

export async function redeemMfaRecoveryCode(
  rawCode: string,
  dependencies: MfaRecoveryDependencies,
): Promise<MfaRecoveryOutcome> {
  const code = normalizeMfaRecoveryCode(rawCode);
  // A code of the wrong shape never leaves the device. The server counts five
  // refusals before locking the set for fifteen minutes, and a typo the field
  // can see is not worth one of those attempts.
  if (!MFA_RECOVERY_CODE_PATTERN.test(code)) return 'rejected';

  let origin: string;
  try { origin = dependencies.apiOrigin(); } catch { return 'unavailable'; }

  const send: MfaRecoveryRequest = dependencies.request ?? fetch;
  let response: MfaRecoveryResponse;
  try {
    const token = await dependencies.accessToken();
    if (!token) return 'unavailable';
    response = await send(`${origin}/api/mfa-recovery`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  } catch {
    return 'unavailable';
  }

  // Only an accepted code has revoked the sessions server-side. A refused or
  // unavailable answer leaves the member on the challenge with the session they
  // still have, so the stored session is cleared on that answer alone.
  if (!response.ok) return response.status === 400 ? 'rejected' : 'unavailable';
  if (await globalLogoutConfirmed(response)) dependencies.confirmGlobalSignOut?.();
  try {
    if (await dependencies.signOutLocally() === false) return 'cleanup-required';
  } catch { return 'cleanup-required'; }
  return 'recovered';
}

// The route answers 200 only after GoTrue's global logout succeeded, and says
// so in `sessionsRevoked`. Anything less (no body, an unreadable one, or a
// body without that statement) leaves the incomplete-sign-out warning as it is.
async function globalLogoutConfirmed(response: MfaRecoveryResponse): Promise<boolean> {
  if (!response.json) return false;
  try {
    const body = await response.json();
    return typeof body === 'object' && body !== null
      && (body as { recovered?: unknown }).recovered === true
      && (body as { sessionsRevoked?: unknown }).sessionsRevoked === true;
  } catch {
    return false;
  }
}
