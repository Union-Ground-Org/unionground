import { resolveSupabaseBackend } from "./_lib/backend.js";
import { authenticateCaller, bearerToken, json, methodGuard, requireEnv, supabaseHeaders, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";
import { requestNetworkBucket } from "./_lib/networkAddress.js";
import { grantHeaders } from "./auth-password-signin.js";
import { emailFromAccessToken } from "../src/lib/exactSessionStorage.js";
import { isSamplePersonaEmail } from "../src/lib/sampleBackend.js";
import {
  ACCOUNT_DELETION_DELETE_TIMEOUT_MS,
  ACCOUNT_DELETION_REAUTH_TIMEOUT_MS,
  ACCOUNT_DELETION_RPC_TIMEOUT_MS,
} from "../src/lib/accountLifecycleBudget.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/;

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function finalizeQuietly(config, authorization, succeeded, failureCode) {
  try {
    await supabaseRpc(
      config.url,
      config.serviceKey,
      config.serviceKey,
      "finalize_member_account_deletion",
      {
        p_request_id: authorization.requestId,
        p_token: authorization.deletionToken,
        p_succeeded: succeeded,
        p_failure_code: failureCode,
      },
      { timeoutMs: ACCOUNT_DELETION_RPC_TIMEOUT_MS },
    );
  } catch {
    // The request may already be terminal because reconciliation completed it
    // between Auth deletion and this call. The request-specific audit proof
    // below remains authoritative even when finalization fails or is a no-op.
  }

  try {
    const result = await supabaseRpc(
      config.url,
      config.serviceKey,
      config.serviceKey,
      "member_account_deletion_has_terminal_audit",
      { p_request_id: authorization.requestId },
      { timeoutMs: ACCOUNT_DELETION_RPC_TIMEOUT_MS },
    );
    return result?.audited === true;
  } catch {
    return false;
  }
}

// The plaintext deletionToken lives only in this one invocation's memory; once
// it returns, nothing can ever call finalize_member_account_deletion again.
// This durability marker needs no token -- it only advances a request this
// same trust boundary already claimed -- so it survives to let a later,
// independent reconciliation job complete the record even when the finalize
// RPC below fails or this function is killed before reaching it.
async function markAuthDeletedQuietly(config, authorization) {
  try {
    await supabaseRpc(
      config.url,
      config.serviceKey,
      config.serviceKey,
      "mark_member_account_deletion_auth_completed",
      { p_request_id: authorization.requestId },
      { timeoutMs: ACCOUNT_DELETION_RPC_TIMEOUT_MS },
    );
  } catch {
    // Best-effort: a failure here still leaves the claimed 'processing' row
    // in place, which the ordinary finalize call immediately below can still
    // complete on its own.
  }
}

// BUG-UG-ACCOUNT-DELETION-REQUIRES-TWO-STEP-20261016: a member with
// no TOTP factor proves it is them by re-entering their password. The
// grant runs for the caller's own email only, is charged to the same durable
// throttle as sign-in, and must name the caller's own user. Its fresh session
// carries a password claim under ten minutes old, which is what
// authorize_member_account_deletion accepts from a member with no TOTP factor;
// a member with one still needs aal2, which a password grant never has.
// Union Ground signs in with email and password only, so a typed password
// that is refused or throttled ends the request: it never falls back to the
// caller's own session, which could otherwise delete the account after the
// confirmation it asked for failed. An empty field still sends that session.
async function reauthenticateWithPassword(backend, request, token, password) {
  if (password.length < 10 || password.length > 256) return { status: 403, error: "reauth-failed" };
  const caller = await authenticateCaller(backend.url, backend.publishableKey, token);
  if (caller.outcome === "unavailable") return { status: 502, error: "account-lifecycle-unavailable" };
  const email = String(caller.user?.email || "").trim().toLowerCase();
  if (caller.outcome !== "resolved" || !UUID.test(String(caller.user?.id || ""))) return { status: 401, error: "unauthenticated" };
  if (!email) return { status: 403, error: "not-permitted" };

  try {
    const allowed = await supabaseRpc(backend.url, backend.serviceRoleKey, backend.serviceRoleKey,
      "consume_password_signin_attempt",
      { p_email: email, p_network: requestNetworkBucket(request) || "unknown" },
      { timeoutMs: ACCOUNT_DELETION_REAUTH_TIMEOUT_MS });
    if (allowed !== true) return { status: 429, error: "try-later" };
  } catch {
    return { status: 502, error: "account-lifecycle-unavailable" };
  }

  let upstream;
  try {
    upstream = await fetch(`${backend.url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: grantHeaders(backend, request),
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(ACCOUNT_DELETION_RPC_TIMEOUT_MS),
    });
  } catch {
    return { status: 502, error: "account-lifecycle-unavailable" };
  }
  if (upstream.status === 429) return { status: 429, error: "try-later" };
  if (upstream.status >= 500 || upstream.status === 408) return { status: 502, error: "account-lifecycle-unavailable" };
  if (!upstream.ok) return { status: 403, error: "reauth-failed" };
  let payload;
  try { payload = await upstream.json(); } catch { payload = null; }
  if (!payload?.access_token) return { status: 502, error: "account-lifecycle-unavailable" };
  if (payload.user?.id !== caller.user.id) {
    await endSessionQuietly(backend, payload.access_token);
    return { status: 403, error: "not-permitted" };
  }
  return { accessToken: payload.access_token };
}

// The re-authentication session exists only to authorize this one request;
// nothing holds its refresh token. Deletion removes it with the account, and
// every other outcome ends it here.
async function endSessionQuietly(backend, accessToken) {
  try {
    await fetch(`${backend.url}/auth/v1/logout?scope=local`, {
      method: "POST",
      headers: supabaseHeaders(backend.publishableKey, accessToken),
      signal: AbortSignal.timeout(ACCOUNT_DELETION_REAUTH_TIMEOUT_MS),
    });
  } catch { /* best-effort: the session's refresh token was never released */ }
}

// GoTrue owns auth.users, so its Admin API is the supported deletion boundary.
// PostgreSQL still owns every authorization decision: this route receives no
// target from the browser, atomically claims the caller-derived capability,
// and records only bounded non-content outcome metadata.
export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["POST"], () => json(response, 405, { error: "method-not-allowed" }))) return;

  const backend = resolveSupabaseBackend(request);
  const config = {
    url: backend.url,
    publishableKey: backend.publishableKey,
    serviceKey: backend.serviceRoleKey,
  };
  if (requireEnv(Object.values(config), () => json(response, 503, { error: "not-configured" }))) return;

  const token = bearerToken(request);
  if (!token) {
    json(response, 401, { error: "unauthenticated" });
    return;
  }
  // The demo entry's persona accounts are shared by every SAMPLE visitor and
  // carry the permanent Tamarack history; no visitor may delete one
  // (UB-UG-DEMO-STRAIGHT-IN-ENTRY-RESTORED-20261107). Refused on the
  // token's own claim before any upstream call, on every surface.
  if (isSamplePersonaEmail(emailFromAccessToken(token))) {
    json(response, 403, { error: "not-permitted" });
    return;
  }

  const body = typeof request.body === "string" ? safeParse(request.body) : request.body;
  const confirmation = typeof body?.confirmation === "string" ? body.confirmation : "";
  if (!confirmation || confirmation.length > 64) {
    json(response, 400, { error: "invalid-confirmation" });
    return;
  }

  // Union Ground has no member PIN sign-in, so there is no restricted PIN
  // session to step up from; authorize_member_account_deletion still refuses one.

  let authorizationToken = token;
  let reauthenticated = false;
  if (body?.password !== undefined && body?.password !== null && body?.password !== "") {
    if (typeof body.password !== "string") {
      json(response, 400, { error: "invalid-confirmation" });
      return;
    }
    const reauth = await reauthenticateWithPassword(backend, request, token, body.password);
    if (!reauth.accessToken) {
      json(response, reauth.status, { error: reauth.error });
      return;
    }
    authorizationToken = reauth.accessToken;
    reauthenticated = true;
  }

  let authorization;
  try {
    authorization = await supabaseRpc(
      config.url,
      config.publishableKey,
      authorizationToken,
      "authorize_member_account_deletion",
      { p_confirmation: confirmation },
      { timeoutMs: ACCOUNT_DELETION_RPC_TIMEOUT_MS },
    );
  } catch {
    if (reauthenticated) await endSessionQuietly(backend, authorizationToken);
    // Flat on purpose: no hint about whether the member, session, second
    // factor, confirmation, or another active request caused the denial.
    json(response, 403, { error: "not-permitted" });
    return;
  }
  // The authorization row now carries the request; the one-use session has
  // done its only job.
  if (reauthenticated) await endSessionQuietly(backend, authorizationToken);

  if (!UUID.test(String(authorization?.requestId || ""))
      || !UUID.test(String(authorization?.userId || ""))
      || !TOKEN.test(String(authorization?.deletionToken || ""))) {
    json(response, 502, { error: "account-lifecycle-unavailable" });
    return;
  }

  let claim;
  try {
    claim = await supabaseRpc(
      config.url,
      config.serviceKey,
      config.serviceKey,
      "claim_member_account_deletion",
      {
        p_request_id: authorization.requestId,
        p_user_id: authorization.userId,
        p_token: authorization.deletionToken,
      },
      { timeoutMs: ACCOUNT_DELETION_RPC_TIMEOUT_MS },
    );
  } catch {
    json(response, 502, { error: "account-lifecycle-unavailable" });
    return;
  }
  if (claim?.claimed !== true) {
    json(response, 409, { error: "deletion-in-progress" });
    return;
  }

  let deleteFailureCode;
  try {
    const result = await fetch(
      `${config.url}/auth/v1/admin/users/${authorization.userId}?should_soft_delete=false`,
      {
        method: "DELETE",
        headers: {
          ...supabaseHeaders(config.serviceKey),
          "Content-Type": "application/json",
          "User-Agent": "node",
        },
        signal: AbortSignal.timeout(ACCOUNT_DELETION_DELETE_TIMEOUT_MS),
      },
    );
    if (!result.ok) {
      deleteFailureCode = result.status >= 500
        ? "auth-service-unavailable"
        : "auth-delete-refused";
    }
  } catch {
    // Do not turn transport uncertainty into a durable confirmed failure. The
    // processing row keeps the one-active-request guard in place while the
    // member follows the sign-in verification path.
    json(response, 502, { error: "account-delete-indeterminate" });
    return;
  }

  if (deleteFailureCode) {
    // A provider 4xx is an explicit refusal. A 5xx cannot prove that an
    // irreversible deletion did not complete before the provider failed, so
    // the browser must not offer a blind retry and the durable request must
    // remain processing for that outcome.
    if (deleteFailureCode === "auth-delete-refused") {
      await finalizeQuietly(config, authorization, false, deleteFailureCode);
    }
    json(response, 502, {
      error: deleteFailureCode === "auth-delete-refused"
        ? "account-delete-failed"
        : "account-delete-indeterminate",
    });
    return;
  }

  await markAuthDeletedQuietly(config, authorization);
  const audited = await finalizeQuietly(config, authorization, true, null);
  json(response, 200, { deleted: true, audited });
}
