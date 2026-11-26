import { mobileConfig } from '../lib/config';
import { isUnionGroundBackend } from '../lib/configPolicy';
import { resetAccount } from '../lib/pendingPasswordReset';

export type EmailAuthFailure = 'link-invalid' | 'unavailable' | 'rate-limited' | 'in-progress'
  | 'code-not-accepted' | 'password-rejected' | 'two-step-unavailable' | 'terms-version-stale' | 'recovery-incomplete' | 'recovery-unfinished' | 'recovery-held'
  | 'email-domain-blocked'
  // Shown by the screen when a recovery code (not the server) was refused.
  | 'recovery-rejected' | 'reset-invalidated';
// `account` is the server's opaque tag for the account a password-reset begin
// read or changed (api/_lib/passwordReset.js resetAccountTag), or null.
export type EmailAuthError = { status: EmailAuthFailure; reason?: 'rate-limited' | 'unavailable' | 'two-step-unavailable'; account?: string };
export type EmailRecovery = { status: 'challenge' | 'enroll'; state: string; secret: string; account?: string };

type Reply = { ok: boolean; status: number; payload: Record<string, unknown> };

// Both APIs spend the one-time link early (the invitation claim, the recovery
// verify) and then make sequential calls each allowed 8 seconds: up to seven
// for an invitation, up to seven for a reset finish, four plus one per stale
// factor for a reset begin. A reset finish with a recovery code adds a bounded
// factor cleanup, a password update and a sweep, all inside the code's
// two-minute claim (api/password-reset.js). The phone outwaits that chain,
// because a reply dropped after the link or code is spent cannot be retried.
const EMAIL_AUTH_TIMEOUT_MS = 120_000;
// A reset request spends nothing, and the route holds every answer to a floor
// of a few seconds, so a stalled one gives up well before that budget.
const RESET_REQUEST_TIMEOUT_MS = 15_000;
// The route's own address check (normalizeResetEmail in api/_lib/passwordReset.js).
// It answers "accepted" for an address that fails it and sends nothing, so the
// app refuses that address before it asks.
const RESET_REQUEST_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function post(path: '/api/accept-invitation' | '/api/password-reset', body: Record<string, string | boolean | Record<string, string>>,
  timeoutMs = EMAIL_AUTH_TIMEOUT_MS, accessToken?: string): Promise<Reply> {
  // Email recovery must never send a credential to SAMPLE or a URL from the link.
  if (!isUnionGroundBackend(mobileConfig)) return { ok: false, status: 503, payload: {} };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${mobileConfig.portalBaseUrl}${path}`, {
      method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Origin: mobileConfig.portalBaseUrl,
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify(body), signal: controller.signal,
    });
    const value: unknown = await response.json();
    const payload = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : {};
    return { ok: response.ok, status: response.status, payload };
  } catch {
    return { ok: false, status: 503, payload: {} };
  } finally { clearTimeout(timeout); }
}

// The account tag is carried only when the server sent a well-formed one.
function withAccount(value: unknown): { account?: string } {
  const account = resetAccount(value);
  return account ? { account } : {};
}

function failure(reply: Reply): EmailAuthError {
  if (reply.payload.error === 'reset-invalidated') return { status: 'reset-invalidated', ...withAccount(reply.payload.account), reason:
    reply.payload.reason === 'two-step-unavailable' ? 'two-step-unavailable' : reply.status === 429 ? 'rate-limited' : 'unavailable' };
  if (reply.status === 429) return { status: 'rate-limited' };
  if (reply.status === 410) return { status: 'link-invalid' };
  const error = reply.payload.error;
  if (reply.status === 409 && error === 'acceptance-in-progress') return { status: 'in-progress' };
  if (reply.status === 409 && error === 'terms-version-stale') return { status: 'terms-version-stale' };
  if (error === 'link-invalid' || error === 'code-not-accepted' || error === 'password-rejected'
      || error === 'two-step-unavailable' || error === 'recovery-incomplete' || error === 'recovery-unfinished' || error === 'recovery-held'
      || error === 'email-domain-blocked') return { status: error };
  return { status: 'unavailable' };
}

// residenceState is the state the person chose and ageAttested their answer to
// the age attestation it selects; the
// route refuses a versioned acceptance without both. referralCode is the
// optional code of the member who brought this person in (, as the web
// page sends it for); an empty field sends none.
export async function acceptEmailInvitation(token: string, acceptedVersions: Record<string, string>, residenceState: string, ageAttested: true, referralCode = ''): Promise<{ status: 'accepted'; reactivated: boolean } | EmailAuthError> {
  const referral = referralCode.trim();
  const reply = await post('/api/accept-invitation', { token, acceptedVersions, residenceState, ageAttested, ...(referral ? { referralCode: referral } : {}) });
  return reply.ok && reply.payload.accepted === true
    ? { status: 'accepted', reactivated: reply.payload.reactivated === true } : failure(reply);
}

// Only a build pointed at Union Ground can send a reset email; SAMPLE has none.
export function passwordResetRequestAvailable(): boolean {
  return isUnionGroundBackend(mobileConfig);
}

export function resetRequestEmailValid(email: string): boolean {
  const value = email.trim().toLowerCase();
  return value.length <= 254 && RESET_REQUEST_EMAIL.test(value);
}

// The route answers the same way for every address, so 'sent' says only that
// the request was taken. The emailed link returns through the app's callback.
export async function requestEmailPasswordReset(email: string, locale: 'en' | 'es'): Promise<{ status: 'sent' } | EmailAuthError> {
  if (!resetRequestEmailValid(email)) return { status: 'unavailable' };
  const reply = await post('/api/password-reset', { action: 'request', email: email.trim(), locale }, RESET_REQUEST_TIMEOUT_MS);
  return reply.ok && reply.payload.accepted === true ? { status: 'sent' } : failure(reply);
}

export async function beginEmailPasswordReset(token: string): Promise<EmailRecovery | EmailAuthError> {
  const reply = await post('/api/password-reset', { action: 'begin', token });
  const { mode, state, secret } = reply.payload;
  if (reply.ok && (mode === 'challenge' || mode === 'enroll') && typeof state === 'string'
      && state.length > 0 && state.length <= 16_384
      && (mode !== 'enroll' || (typeof secret === 'string' && /^[A-Z2-7]{16,256}$/.test(secret)))) {
    return { status: mode, state, secret: typeof secret === 'string' ? secret : '', ...withAccount(reply.payload.account) };
  }
  return failure(reply);
}

export async function finishEmailPasswordReset(state: string, code: string, password: string): Promise<
  { status: 'completed'; sessionsEnded: boolean; recoveryCodeUsed: boolean } | EmailAuthError
> {
  const reply = await post('/api/password-reset', { action: 'finish', state, code, password });
  return reply.ok && reply.payload.completed === true
    ? { status: 'completed', sessionsEnded: reply.payload.sessionsEnded !== false, recoveryCodeUsed: reply.payload.recoveryCodeUsed === true }
    : failure(reply);
}

// The signed-in account's reset tag, or null when it cannot be read: Account
// then offers no saved reset, because it cannot show the reset is this
// account's (BUG-UG-AUTHENTICATED-NATIVE-RESET-RESUME-20261021).
export async function signedInResetAccount(accessToken: string): Promise<string | null> {
  if (!accessToken) return null;
  const reply = await post('/api/password-reset', { action: 'account' }, RESET_REQUEST_TIMEOUT_MS, accessToken);
  return reply.ok ? resetAccount(reply.payload.account) : null;
}
