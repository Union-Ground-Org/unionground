import { randomUUID } from "node:crypto";
import { recordAccountMailFailure } from "./_lib/accountMailAlerts.js";
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { serverBrandName } from "./_lib/brand.js";
import { authenticate, bearerToken, json, methodGuard, requireEnv, supabaseHeaders, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";
import { authAdminHeaders, PASSWORD_ISSUED_KEY } from "./_lib/memberInvitations.js";
import { authUserIsBanned, logoutAuthUser } from "./_lib/memberSigninRecovery.js";
import { requestNetworkBucket } from "./_lib/networkAddress.js";
import {
  normalizeResetEmail, openResetState, openResetTicket, RECOVERY_TOKEN, RESET_PASSWORD_MAX, RESET_PASSWORD_MIN,
  RESET_EMAIL_TIMEOUT_MS, resetAccountTag, resetLink, resetStateKey, resetTicketKey, sealResetState, sealResetTicket,
  sendPasswordResetEmail, UUID,
} from "./_lib/passwordReset.js";

// Self-service password reset (REQ-UG-SELF-SERVICE-PASSWORD-RESET-20261006).
// POST { action: "request", email, locale }
//   Always { accepted: true } for every address, known or not, once the
//   durable per-network and per-address limits allow it (a 429 there depends
//   only on how often this address and network asked, never on whether the
//   account exists). Only a known, unbanned account with a confirmed email
//   gets one email, to that address, with a 15-minute ticket this server
//   sealed around GoTrue's single-use recovery token (never the token itself).
// POST { action: "begin", token }
//   Opens the ticket and the recovery session server-side and answers { mode, state } where
//   mode is "challenge" (the account has a verified authenticator) or
//   "enroll" (it has none, so one is set up now; qr and secret are returned
//   for that). The session itself never reaches the browser.
// POST { action: "finish", state, code, password }
//   Verifies the authenticator code first (this also completes an enrolment),
//   then sets the password from the resulting AAL2 session, ends every
//   session of the account and writes the audit row. A member who lost the
//   authenticator may send a saved recovery code instead (see
//   finishWithRecoveryCode): a claim-bound lock precedes the password update;
//   factor/session cleanup follows it and confirmed finalization releases it.
// POST { action: "account" } with the member's own bearer token
//   { account }: the signed-in account's reset tag (resetAccountTag), so
//   Account offers a reset saved on this phone only to the account it changes
//   (BUG-UG-AUTHENTICATED-NATIVE-RESET-RESUME-20261021). Any token
//   GoTrue does not accept answers 401 and nothing else.
// Staff reissue (api/admin-password-reissue.js) stays the fallback for a
// member who has lost the inbox or the authenticator.
// The floor sits above the reset email's own send timeout, so a confirmed
// account (which waits on the send) answers no later than an unknown one.
// The account path is also cut off marginMs before the floor (its Auth and
// email calls are aborted and no longer awaited), so a slow Auth or mail
// provider cannot push a confirmed address past the floor either.
export const resetTiming = {
  floorMs: RESET_EMAIL_TIMEOUT_MS + 500,
  marginMs: 100,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
};

class Unavailable extends Error {}

function secureJson(response, status, payload) {
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
  return json(response, status, payload);
}

function safeParse(value) {
  if (typeof value === "object" && value !== null) return value;
  try { return JSON.parse(value); } catch { return null; }
}

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

async function consume(config, scope, key) {
  let allowed;
  try {
    allowed = await supabaseRpc(config.url, config.serviceKey, config.serviceKey,
      "consume_password_reset_attempt", { p_scope: scope, p_key: key });
  } catch {
    // A missing function (the migration not applied yet) or an unreachable
    // database fails closed: no reset email is ever sent unthrottled.
    throw new Unavailable();
  }
  if (typeof allowed !== "boolean") throw new Unavailable();
  return allowed;
}

function userHeaders(config, accessToken) {
  return supabaseHeaders(config.publishableKey, accessToken, {
    "Content-Type": "application/json",
    "User-Agent": "UnionGround-Password-Reset/1.0",
  });
}

async function auth(config, path, { method = "POST", headers, body, signal } = {}) {
  const timeout = AbortSignal.timeout(8000);
  return fetch(`${config.url}/auth/v1/${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
}

// --- request ---------------------------------------------------------------

async function mintAndSend(config, email, locale, signal) {
  let generated;
  try {
    generated = await auth(config, "admin/generate_link", {
      signal,
      headers: authAdminHeaders(config.serviceKey),
      // No redirect_to: the action link GoTrue would build is never used, only
      // its hashed_token, sealed into this route's own link below.
      body: { type: "recovery", email },
    });
  } catch { return; }
  // An unknown address and a provider refusal end here with the same answer.
  if (!generated.ok || signal.aborted) return;
  const payload = await readJson(generated);
  // GoTrue's wire response puts the user at the top level; auth-js moves it
  // under `user` and the link fields under `properties`. Accept either.
  const user = payload?.user ?? payload;
  const token = String(payload?.hashed_token ?? payload?.properties?.hashed_token ?? "");
  const type = payload?.verification_type ?? payload?.properties?.verification_type;
  if (!RECOVERY_TOKEN.test(token) || type !== "recovery") return;
  // Only the account's own confirmed address, and never an account that is
  // banned (suspended, or held under a staff reissue's recovery lock).
  if (!UUID.test(String(user?.id || "")) || normalizeResetEmail(user?.email) !== email
      || !user?.email_confirmed_at || authUserIsBanned(user)
      || user?.app_metadata?.union_ground_provisioning === "pending" || signal.aborted) return;
  const message = {
    resendKey: config.resendKey,
    from: config.from,
    to: email,
    locale,
    link: resetLink(config.appOrigin, sealResetTicket(resetTicketKey(config.serviceKey), token)),
    token,
    signal,
    // Resend requires the same payload as well as the same idempotency key.
    sentAt: new Date(),
    messageReference: randomUUID(),
  };
  let sent = false;
  let cutShort = false;
  for (let attempt = 0; attempt < 2 && !sent && !signal.aborted; attempt += 1) {
    sent = await sendPasswordResetEmail(message);
    // The deadline aborts a send in flight, and the provider may still have
    // taken it, so that outcome is unknown rather than failed.
    cutShort = !sent && signal.aborted;
  }
  if (sent) return;
  // Never log the address, token, link or provider response: the private
  // record carries only the failure kind and a count.
  recordAccountMailFailure(cutShort ? "reset_send_unconfirmed" : "reset_send_failed");
}

// Runs mintAndSend until deadlineAt at most. Past it the calls are aborted
// and the route answers without waiting for them.
async function mintAndSendBy(config, email, locale, deadlineAt) {
  const controller = new AbortController();
  const budget = Math.max(0, deadlineAt - resetTiming.now());
  let timer;
  const cutOff = new Promise((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(true); }, budget);
  });
  const finished = mintAndSend(config, email, locale, controller.signal).then(() => false, () => false);
  const late = await Promise.race([finished, cutOff]);
  clearTimeout(timer);
  // No address, token or link: only that the deadline cut the request short.
  if (late) console.warn(JSON.stringify({ event: "password-reset-request-deadline", budgetMs: budget }));
}

async function requestReset(config, request, body, deadlineAt) {
  const email = normalizeResetEmail(body.email);
  if (!email) return [200, { accepted: true }];
  if (!config.resendKey || !config.from || !config.appOrigin) return [503, { error: "reset-unavailable" }];
  try {
    // The network bucket first: a network already over its budget does not
    // also spend the address's budget.
    if (!await consume(config, "network", requestNetworkBucket(request) || "unknown")) return [429, { error: "try-later" }];
    if (!await consume(config, "email", email)) return [429, { error: "try-later" }];
  } catch {
    return [503, { error: "reset-unavailable" }];
  }
  await mintAndSendBy(config, email, body.locale === "es" ? "es" : "en", deadlineAt);
  return [200, { accepted: true }];
}

// --- begin -----------------------------------------------------------------

async function listFactors(config, userId) {
  const result = await auth(config, `admin/users/${userId}/factors`, {
    method: "GET", headers: authAdminHeaders(config.serviceKey),
  });
  if (!result.ok) throw new Unavailable();
  const payload = await readJson(result);
  const factors = Array.isArray(payload) ? payload : payload?.factors;
  if (!Array.isArray(factors)) throw new Unavailable();
  return factors;
}

async function beginReset(config, request, body) {
  // Malformed, tampered, sealed by another deployment, or past 15 minutes.
  const token = openResetTicket(resetTicketKey(config.serviceKey), body.token);
  if (!token) return [400, { error: "link-invalid" }];
  try {
    if (!await consume(config, "network", requestNetworkBucket(request) || "unknown")) return [429, { error: "try-later" }];
  } catch {
    return [503, { error: "reset-unavailable" }];
  }

  let verified;
  try {
    verified = await auth(config, "verify", {
      headers: supabaseHeaders(config.publishableKey, config.publishableKey, { "Content-Type": "application/json" }),
      body: { type: "recovery", token_hash: token },
    });
  } catch { return [503, { error: "reset-unavailable" }]; }
  if (verified.status === 429) return [429, { error: "try-later" }];
  // Used, expired, superseded by a newer link, or a banned account.
  if (!verified.ok) return [400, { error: "link-invalid" }];
  const session = await readJson(verified);
  const accessToken = String(session?.access_token || "");
  const userId = String(session?.user?.id || "");
  if (!accessToken || !UUID.test(userId)) return [502, { error: "reset-unavailable" }];

  let factors;
  try { factors = await listFactors(config, userId); } catch { return [502, { error: "reset-unavailable" }]; }
  const verifiedFactors = factors.filter((factor) => factor?.status === "verified");
  const totp = verifiedFactors.find((factor) => factor.factor_type === "totp" && UUID.test(String(factor.id || "")));
  const key = resetStateKey(config.serviceKey);
  // Names the account this begin read or changed, never its id.
  const account = resetAccountTag(config.serviceKey, userId);
  if (totp) {
    return [200, { mode: "challenge", account, state: sealResetState(key, { accessToken, userId, factorId: totp.id, mode: "challenge" }) }];
  }
  // A verified factor this flow cannot challenge (none is offered today)
  // must never be bypassed by enrolling a second one.
  if (verifiedFactors.length > 0) return [409, { error: "two-step-unavailable" }];

  // An abandoned earlier recovery or settings enrolment leaves an unverified
  // TOTP factor; clear it so the new enrolment cannot collide with it.
  let previousEnrollmentInvalidated = false;
  const beginFailure = (status, reason) => [status, previousEnrollmentInvalidated
    ? { error: "reset-invalidated", reason, account } : { error: reason }];
  for (const factor of factors) {
    if (factor?.factor_type !== "totp" || !UUID.test(String(factor.id || ""))) continue;
    try {
      // A lost response cannot establish that the deletion did not happen.
      const deleted = await auth(config, `admin/users/${userId}/factors/${factor.id}`, {
        method: "DELETE", headers: authAdminHeaders(config.serviceKey),
      });
      if (!deleted.ok) {
        // A rejected request did not delete the factor. A missing factor or a
        // server failure cannot establish that the prior enrollment is live.
        if (deleted.status === 404 || deleted.status >= 500) previousEnrollmentInvalidated = true;
        return deleted.status === 429 ? beginFailure(429, "try-later") : beginFailure(502, "reset-unavailable");
      }
      previousEnrollmentInvalidated = true;
    } catch {
      previousEnrollmentInvalidated = true;
      return beginFailure(503, "reset-unavailable");
    }
  }
  let enrolled;
  try {
    enrolled = await auth(config, "factors", {
      headers: userHeaders(config, accessToken),
      body: { factor_type: "totp", friendly_name: `${serverBrandName()} ${Date.now().toString(36)}`, issuer: serverBrandName() },
    });
  } catch { return beginFailure(503, "reset-unavailable"); }
  if (enrolled.status === 429) return beginFailure(429, "try-later");
  if (!enrolled.ok) {
    const failure = await readJson(enrolled);
    // Only an explicit TOTP refusal needs staff reissue. Temporary failures
    // use the page's new-link action: verify has already spent this token.
    if (enrolled.status < 500 && (failure?.error_code ?? failure?.code) === "mfa_totp_enroll_not_enabled") {
      return beginFailure(409, "two-step-unavailable");
    }
    return beginFailure(502, "reset-unavailable");
  }
  const factor = await readJson(enrolled);
  const factorId = String(factor?.id || "");
  const qr = String(factor?.totp?.qr_code || "").trim();
  const secret = String(factor?.totp?.secret || "");
  if (!UUID.test(factorId) || !secret) return beginFailure(502, "reset-unavailable");
  return [200, {
    mode: "enroll",
    account,
    state: sealResetState(key, { accessToken, userId, factorId, mode: "enroll" }),
    // GoTrue returns bare SVG; auth-js normally supplies the data URI, but
    // this server calls GoTrue directly. Keep SVG in an img, never inline HTML.
    qr: qr.startsWith("data:image/") ? qr
      : /^(?:<\?xml\s[\s\S]*?\?>\s*)?<svg(?:\s|>)/i.test(qr) ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr)}` : "",
    secret,
  }];
}

// --- finish ----------------------------------------------------------------

function authRefusal(status) {
  if (status === 401 || status === 403) return [400, { error: "link-invalid" }];
  if (status === 429) return [429, { error: "try-later" }];
  return null;
}

// The enrolled factor is gone (deleted by a newer begin or by staff): GoTrue
// answers the challenge or verify with 404 mfa_factor_not_found. That reset
// can never finish, so it answers link-invalid, which both clients already
// treat as terminal and clear, instead of a retryable reset-unavailable. A
// bare 404, a 5xx or a lost answer stays reset-unavailable.
async function missingFactor(response) {
  if (response.status !== 404) return false;
  const body = await readJson(response);
  return body?.error_code === "mfa_factor_not_found";
}

// The emailed-password stamp on a GoTrue user, or null when there is none.
function issuedStamp(user) {
  const stamp = user?.user_metadata?.[PASSWORD_ISSUED_KEY];
  return typeof stamp === "string" && stamp ? stamp : null;
}

const REISSUE_OPERATION_KEY = "union_ground_password_reissue_operation_id";

async function restoreReissueStamp(config, userId, observedOperation) {
  try {
    const read = await fetch(`${config.url}/auth/v1/admin/users/${userId}`, {
      headers: authAdminHeaders(config.serviceKey), signal: AbortSignal.timeout(8000),
    });
    const user = read.ok ? await readJson(read) : null;
    const operation = user?.app_metadata?.[REISSUE_OPERATION_KEY] ?? null;
    if (!user || operation === observedOperation || issuedStamp(user)) return;
    await fetch(`${config.url}/auth/v1/admin/users/${userId}`, {
      method: "PUT",
      headers: authAdminHeaders(config.serviceKey),
      body: JSON.stringify({ user_metadata: { [PASSWORD_ISSUED_KEY]: new Date().toISOString() } }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* the reissue email still asks the member to change the password */ }
}

// BUG-UG-RESET-REFUSES-RECOVERY-CODE-20261018. Same handling as
// api/mfa-recovery.js, ordered so that nothing irreversible happens until the
// password is known to be acceptable:
//   1. claim the code (the recovery-sign-in throttle and lockout live in that
//      RPC);
//   2. prepare the exact live-session claim lock, then set the password through the Auth admin API (the recovery session's own
//      token cannot: it is revoked below). A password GoTrue refuses is
//      reported as such only after releasing its unspent claim and lock;
//   3. from here the password has changed, so every later failure is reported
//      as unfinished, never as a clean completion: clean up push registrations,
//      remove every second factor, end every session, confirm by a fresh
//      listing that no factor remains, and only then spend the code, which
//      releases the lock.
// The old password is dead from step 2, and the lock is up before any factor
// goes and stays up until the end, so an unfinished reset leaves the member
// blocked from protected data (never let through with no second factor) until
// the code can be finished or staff reset their two-step.
const RECOVERY_CODE = /^[A-Za-z0-9-]{18,32}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
// Factor removal gets one aggregate budget, however many factors an account
// holds (up to ten) and however slow Auth is.
const RECOVERY_CLEANUP_MS = 20_000;
const RECOVERY_VERIFY_MS = 10_000;

async function removeFactors(config, userId, factors, signal) {
  for (const factor of factors) {
    try {
      const result = await auth(config, `admin/users/${userId}/factors/${factor.id}`, {
        method: "DELETE", headers: authAdminHeaders(config.serviceKey), signal,
      });
      if (!result.ok) return false;
    } catch { return false; }
  }
  return true;
}

async function endSessions(config, userId) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (await logoutAuthUser(config.url, config.serviceKey, userId)) return true;
    } catch { /* retried, then reported */ }
  }
  return false;
}

// Clears the emailed-password stamp a reset saw in its password update's
// answer (GoTrue answers the update with the user), and only while that stamp
// is still current; see step 2b of finishReset. Shared by both reset paths.
async function clearObservedStamp(config, userId, answer) {
  const observed = issuedStamp(answer);
  if (observed) {
    let attempted = false;
    try {
      const current = await auth(config, `admin/users/${userId}`, { method: "GET", headers: authAdminHeaders(config.serviceKey) });
      if (current.ok && issuedStamp(await readJson(current)) === observed) {
        attempted = true;
        await auth(config, `admin/users/${userId}`, {
          method: "PUT", headers: authAdminHeaders(config.serviceKey),
          body: { user_metadata: { [PASSWORD_ISSUED_KEY]: null } },
        });
      }
    } catch { /* the prompt stays until the next password change */ }
    // GoTrue has no compare-and-set, so a reissue that stamps while GoTrue is
    // still handling the clear can lose its stamp to it. The reissue records
    // its operation in app_metadata in the same update as the stamp, and the
    // clear writes only user_metadata: a different operation afterwards puts
    // the stamp back. This runs after every attempted clear, not only an
    // answered one: a clear that committed but lost its answer (a reset
    // connection or a timeout) can have erased a reissue's stamp too
    // (BUG-UG-RESET-STAMP-RESTORE-AFTER-UNKNOWN-CLEAR-20261022). The
    // restore writes only when the stamp is gone and the operation changed, so
    // a clear that never landed leaves everything as it was.
    if (attempted) await restoreReissueStamp(config, userId, answer?.app_metadata?.[REISSUE_OPERATION_KEY] ?? null);
  }
}

// BUG-UG-RESET-RECOVERY-CLAIM-TRANSPORT-CLASSIFICATION-20261021.
// A claim writes a two-minute lease on the code. While it lasts, the same code
// no longer matches, so a retry would be counted as a wrong code toward the
// recovery lockout. A live lease therefore answers "try again later" for its
// remaining time before any claim is attempted or the per-account code budget
// is charged (finishReset), and spends no attempt.
const RECOVERY_LEASE_RETRY_MAX_SECONDS = 120;
async function liveRecoveryLeaseSeconds(config, userId) {
  const result = await fetch(`${config.url}/rest/v1/mfa_recovery_codes?select=claim_expires_at&user_id=eq.${encodeURIComponent(userId)}`
    + "&used_at=is.null&claim_expires_at=not.is.null", {
    headers: supabaseHeaders(config.serviceKey, config.serviceKey), signal: AbortSignal.timeout(8000),
  });
  if (!result.ok) throw new Error("recovery-lease-read-failed");
  const rows = await result.json();
  if (!Array.isArray(rows)) throw new Error("recovery-lease-read-failed");
  let latest = 0;
  for (const row of rows) {
    const until = Date.parse(row?.claim_expires_at);
    if (!Number.isFinite(until)) throw new Error("recovery-lease-read-failed");
    latest = Math.max(latest, until);
  }
  const remaining = Math.ceil((latest - Date.now()) / 1000);
  return remaining > 0 ? Math.min(remaining, RECOVERY_LEASE_RETRY_MAX_SECONDS) : 0;
}

// The claim RPC either answers or raises. accepted:false and SQLSTATE 22023
// are a definite refusal of the code; 42501 means the reset's own session is
// gone. Any other error that carries a code was answered by PostgREST or
// Postgres, and its transaction rolled back, so no lease exists. Only a lost
// answer (an abort, a timeout, a network failure, or an error with no code
// such as a gateway timeout) leaves unknown whether the lease committed: it
// is never reported as a wrong code, and the member is asked to wait out the
// lease, which the check above then enforces.
function claimFailure(error) {
  if (error?.status === 401 || error?.status === 403 || error?.code === "42501") return [400, { error: "link-invalid" }];
  if (error?.code === "22023") return [400, { error: "code-not-accepted" }];
  if (typeof error?.code === "string" && error.code) return [503, { error: "reset-unavailable" }];
  return [503, { error: "reset-unavailable", retryAfterSeconds: RECOVERY_LEASE_RETRY_MAX_SECONDS }];
}

async function finishWithRecoveryCode(config, state, password, code) {
  // Only an account that has a verified authenticator has one to lose.
  if (state.mode !== "challenge") return [400, { error: "code-not-accepted" }];

  let claim;
  try {
    claim = await supabaseRpc(config.url, config.publishableKey, state.accessToken,
      "claim_mfa_recovery_code", { p_code: code });
  } catch (error) { return claimFailure(error); }
  // The code is correct but still under an earlier attempt's lease: the
  // earlier claim committed after this attempt's lease read. The database
  // counted no failed attempt, so this is "try again", never a wrong code
  // (BUG-UG-RECOVERY-CLAIM-LEASED-MATCH-BUSY-OUTCOME-20261022).
  if (claim?.busy === true) {
    const seconds = Number.isSafeInteger(claim.retryAfterSeconds) && claim.retryAfterSeconds > 0
      ? Math.min(claim.retryAfterSeconds, RECOVERY_LEASE_RETRY_MAX_SECONDS) : RECOVERY_LEASE_RETRY_MAX_SECONDS;
    return [503, { error: "reset-unavailable", retryAfterSeconds: seconds }];
  }
  if (claim?.accepted === false) return [400, { error: "code-not-accepted" }];
  if (claim?.userId !== state.userId
      || !HEX_64.test(String(claim?.sessionHandle || ""))
      || !HEX_64.test(String(claim?.claimToken || ""))) {
    return [502, { error: "reset-unavailable" }];
  }
  const claimParams = { p_user_id: state.userId, p_session_handle: claim.sessionHandle, p_claim_token: claim.claimToken };
  const cancelClaim = async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (await supabaseRpc(config.url, config.serviceKey, config.serviceKey,
          "cancel_password_reset_recovery", claimParams) === true) return true;
      } catch { /* retain the lock unless cancellation is confirmed */ }
    }
    return false;
  };
  const refuseBeforePassword = async () => [502, { error: await cancelClaim() ? "reset-unavailable" : "recovery-held" }];

  // Every factor goes, whatever its type: a verified phone or passkey left
  // behind would still raise the sign-in to a second step the app cannot
  // answer, stranding the member right after a "successful" recovery.
  let factors;
  try { factors = await listFactors(config, state.userId); } catch { return refuseBeforePassword(); }
  if (factors.some((factor) => !UUID.test(String(factor?.id || "")))) return refuseBeforePassword();

  // Auth's admin PUT removes the original session. Bind the lock while that
  // session is still live, without deleting factors, sessions or push data.
  try {
    const prepared = await supabaseRpc(config.url, config.serviceKey, config.serviceKey,
      "prepare_password_reset_recovery", claimParams);
    if (prepared?.prepared !== true) return refuseBeforePassword();
  } catch { return refuseBeforePassword(); }

  // 2. The password, before anything irreversible.
  let updated;
  try {
    updated = await auth(config, `admin/users/${state.userId}`, {
      method: "PUT", headers: authAdminHeaders(config.serviceKey), body: { password },
    });
    if (!updated.ok) {
      if (updated.status === 400 || updated.status === 422) {
        return await cancelClaim() ? [400, { error: "password-rejected" }] : [502, { error: "recovery-held" }];
      }
      return [502, { error: "recovery-held" }];
    }
  } catch { return [503, { error: "recovery-held" }]; }
  // The stamp this reset saw at its password update, cleared once it is final.
  const passwordAnswer = await readJson(updated);

  // 3. The rest. The password has changed, so none of it may be reported as a
  // clean finish unless every step is confirmed.
  const unfinished = (reason) => {
    console.warn(JSON.stringify({ event: "password-reset-recovery-unfinished", reason }));
    return [502, { error: "recovery-unfinished" }];
  };
  try {
    const cleanup = await supabaseRpc(config.url, config.serviceKey, config.serviceKey,
      "prepare_password_reset_recovery", { ...claimParams, p_cleanup: true });
    if (cleanup?.serverCleanupComplete !== true) return unfinished("prepare");
  } catch { return unfinished("prepare"); }

  if (!await removeFactors(config, state.userId, factors, AbortSignal.timeout(RECOVERY_CLEANUP_MS))) return unfinished("factors");
  if (!await endSessions(config, state.userId)) return unfinished("sessions");

  // With every session gone nothing can enrol again; a fresh listing proves
  // that nothing enrolled in the window survived.
  const verify = AbortSignal.timeout(RECOVERY_VERIFY_MS);
  try {
    const remaining = await listFactors(config, state.userId);
    if (remaining.some((factor) => !UUID.test(String(factor?.id || "")))) return unfinished("verify");
    if (!await removeFactors(config, state.userId, remaining, verify)) return unfinished("verify");
  } catch { return unfinished("verify"); }

  let spent = false;
  for (let attempt = 0; attempt < 2 && !spent; attempt += 1) {
    try {
      spent = (await supabaseRpc(config.url, config.serviceKey, config.serviceKey,
        "finalize_mfa_recovery_code", { p_user_id: state.userId, p_claim_token: claim.claimToken })) === true;
    } catch { /* retried, then reported */ }
  }
  if (!spent) return unfinished("finalize");

  // The emailed-password stamp, in its own call once the reset is final, with
  // the same compare-and-clear as step 2b of the authenticator path: a staff
  // reissue that stamped after this password update keeps its prompt
  // (BUG-UG-RECOVERY-RESET-MARKER-COMPARE-AND-CLEAR-20261021). A
  // failure only leaves the Home prompt up and never repeats the reset.
  await clearObservedStamp(config, state.userId, passwordAnswer);

  let audited = false;
  try {
    audited = (await supabaseRpc(config.url, config.serviceKey, config.serviceKey,
      "record_self_service_password_reset", { p_user_id: state.userId, p_enrolled_two_step: false })) === true;
  } catch { /* reported */ }
  if (!audited) console.warn(JSON.stringify({ event: "password-reset-completion-partial", sessionsEnded: true, audited }));
  return [200, { completed: true, sessionsEnded: true, audited, recoveryCodeUsed: true }];
}

async function finishReset(config, body) {
  const state = openResetState(resetStateKey(config.serviceKey), body.state);
  if (!state) return [400, { error: "link-invalid" }];
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < RESET_PASSWORD_MIN || password.length > RESET_PASSWORD_MAX) {
    return [400, { error: "password-rejected" }];
  }
  const code = String(body.code ?? "").replace(/\s+/g, "");
  const recoveryCode = RECOVERY_CODE.test(code) && !/^[0-9]{6}$/.test(code) ? code : "";
  if (!recoveryCode && !/^[0-9]{6}$/.test(code)) return [400, { error: "code-not-accepted" }];
  if (recoveryCode && state.mode === "challenge") {
    // A live claim lease answers before the per-account code budget is
    // charged, so the retries it holds cannot spend that budget and lock the
    // member out once the lease runs out.
    let leaseSeconds;
    try { leaseSeconds = await liveRecoveryLeaseSeconds(config, state.userId); } catch { return [503, { error: "reset-unavailable" }]; }
    if (leaseSeconds > 0) return [503, { error: "reset-unavailable", retryAfterSeconds: leaseSeconds }];
  }
  try {
    // Bounds code guessing per account across every reset state it holds.
    if (!await consume(config, "code", state.userId)) return [429, { error: "try-later" }];
  } catch {
    return [503, { error: "reset-unavailable" }];
  }
  if (recoveryCode) return finishWithRecoveryCode(config, state, password, recoveryCode);

  // 1. The second factor, before anything about the password changes.
  let challenge;
  try {
    challenge = await auth(config, `factors/${state.factorId}/challenge`, { headers: userHeaders(config, state.accessToken), body: {} });
  } catch { return [503, { error: "reset-unavailable" }]; }
  if (!challenge.ok) {
    if (await missingFactor(challenge)) return [400, { error: "link-invalid" }];
    return authRefusal(challenge.status) ?? [502, { error: "reset-unavailable" }];
  }
  const challengeId = String((await readJson(challenge))?.id || "");
  if (!UUID.test(challengeId)) return [502, { error: "reset-unavailable" }];
  let verified;
  try {
    verified = await auth(config, `factors/${state.factorId}/verify`, {
      headers: userHeaders(config, state.accessToken),
      body: { challenge_id: challengeId, code },
    });
  } catch { return [503, { error: "reset-unavailable" }]; }
  if (!verified.ok) {
    if (await missingFactor(verified)) return [400, { error: "link-invalid" }];
    return authRefusal(verified.status) ?? [400, { error: "code-not-accepted" }];
  }
  const elevated = await readJson(verified);
  const aal2Token = String(elevated?.access_token || "");
  if (!aal2Token) return [502, { error: "reset-unavailable" }];

  // 2. The password, from the AAL2 session. GoTrue itself refuses this call
  //    below AAL2 now that the account has a verified factor.
  let updated;
  try {
    updated = await auth(config, "user", { method: "PUT", headers: userHeaders(config, aal2Token), body: { password } });
  } catch { return [503, { error: "reset-unavailable" }]; }
  if (!updated.ok) {
    if (updated.status === 400 || updated.status === 422) return [400, { error: "password-rejected" }];
    return authRefusal(updated.status) ?? [502, { error: "reset-incomplete" }];
  }

  // 2b. Clear the emailed-password stamp in its own call, after the password is
  //     safe: writing user_metadata fires the case-graph bookkeeping lock (3 s
  //     bounded), which must never be able to roll the password back. A failure
  //     only leaves the Home prompt up until the member's next change. The
  //     clear goes through the service-role admin update, not the recovery
  //     bearer: GoTrue may revoke that session inside the password update, and
  //     a revoked bearer would leave the stamp behind a completed reset
  //     (GoTrue deletes a user_metadata key whose new value is null).
  //     Only the stamp this reset saw at its password update is cleared (GoTrue
  //     answers the update with the user): a staff reissue that lands after it
  //     writes a newer stamp for the password it emails, and that prompt stays.
  await clearObservedStamp(config, state.userId, await readJson(updated));

  // 3. Every session ends, the recovery session included; the member signs in
  //    again with the new password and the authenticator.
  //    The password has already changed, so a failure here cannot undo it:
  //    one retry covers a busy session lock, and a lasting failure is told to
  //    the member, who can still sign out everywhere from Settings.
  let sessionsEnded = false;
  for (let attempt = 0; attempt < 2 && !sessionsEnded; attempt += 1) {
    try { sessionsEnded = await logoutAuthUser(config.url, config.serviceKey, state.userId); } catch { /* retried, then reported */ }
  }

  // 4. The audit row other credential recoveries write (member_admin_audit).
  let audited = false;
  try {
    audited = (await supabaseRpc(config.url, config.serviceKey, config.serviceKey,
      "record_self_service_password_reset", {
        p_user_id: state.userId,
        p_enrolled_two_step: state.mode === "enroll",
      })) === true;
  } catch { /* reported */ }
  if (!sessionsEnded || !audited) {
    console.warn(JSON.stringify({ event: "password-reset-completion-partial", sessionsEnded, audited }));
  }
  return [200, { completed: true, sessionsEnded, audited }];
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["POST"], () => secureJson(response, 405, { error: "method-not-allowed" }))) return;
  const backend = resolveSupabaseBackend(request);
  // SAMPLE has no member mailboxes and ships TOTP off; reissue answers the
  // same way there.
  if (backend.surface === "demo") return secureJson(response, 404, { error: "not-available" });
  const config = {
    url: backend.url,
    publishableKey: backend.publishableKey,
    serviceKey: backend.serviceRoleKey,
    resendKey: process.env.RESEND_API_KEY,
    from: process.env.NOTIFY_FROM_ADDRESS,
    appOrigin: String(process.env.INVITATION_APP_ORIGIN || "").trim().replace(/\/$/, ""),
  };
  if (requireEnv([config.url, config.publishableKey, config.serviceKey],
    () => secureJson(response, 503, { error: "reset-unavailable" }))) return;
  const body = safeParse(request.body) || {};

  if (body.action === "request") {
    const startedAt = resetTiming.now();
    const [status, payload] = await requestReset(config, request, body,
      startedAt + resetTiming.floorMs - resetTiming.marginMs);
    // The no-account branch is held to the same floor as the send branch.
    const remaining = resetTiming.floorMs - (resetTiming.now() - startedAt);
    if (remaining > 0) await resetTiming.sleep(remaining);
    return secureJson(response, status, payload);
  }
  if (body.action === "begin") {
    const [status, payload] = await beginReset(config, request, body);
    return secureJson(response, status, payload);
  }
  if (body.action === "finish") {
    const [status, payload] = await finishReset(config, body);
    if (Number.isSafeInteger(payload.retryAfterSeconds)) response.setHeader("Retry-After", String(payload.retryAfterSeconds));
    return secureJson(response, status, payload);
  }
  if (body.action === "account") {
    const token = bearerToken(request);
    let user = null;
    if (token) {
      try { user = await authenticate(config.url, config.publishableKey, token); } catch { return secureJson(response, 503, { error: "reset-unavailable" }); }
    }
    const account = resetAccountTag(config.serviceKey, user?.id);
    return account ? secureJson(response, 200, { account }) : secureJson(response, 401, { error: "not-signed-in" });
  }
  return secureJson(response, 400, { error: "invalid-request" });
}
