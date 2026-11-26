import { recordAccountMailFailure } from "./_lib/accountMailAlerts.js";
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { bearerToken, json, methodGuard, requireEnv, supabaseHeaders, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";
import { deliverAccountNotices } from "./_lib/recoveryCodeNotice.js";
import { emailFromAccessToken } from "../src/lib/exactSessionStorage.js";
import { isSamplePersonaEmail } from "../src/lib/sampleBackend.js";

// Consumes a one-time recovery code from an aal1 session, removes every TOTP
// factor through GoTrue's supported admin API, revokes all sessions, and then
// finalizes the one-time code. The member must sign in again and enroll a new
// authenticator; the recovery code never upgrades a JWT in place.
// claim_mfa_recovery_code leases a claimed code for two minutes.
const RECOVERY_LEASE_SECONDS = 120;

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["POST"], () => json(response, 405, { error: "method-not-allowed" }))) return;
  const { url, publishableKey, serviceRoleKey } = resolveSupabaseBackend(request);
  if (requireEnv([url, publishableKey, serviceRoleKey],
    () => json(response, 503, { error: "not-configured" }))) return;
  const token = bearerToken(request);
  if (!token) return json(response, 401, { error: "unauthenticated" });
  // A shared SAMPLE demo persona is every visitor's account: its factors are
  // never recovered away, and the refusal comes before the claim, so no
  // recovery lock is ever prepared for it (gate r3s1/r4s1 on #7375). The
  // database refuses its recovery codes too.
  if (isSamplePersonaEmail(emailFromAccessToken(token))) return json(response, 403, { error: "not-permitted" });
  const body = typeof request.body === "string" ? safeParse(request.body) : request.body;
  const code = String(body?.code || "").trim();
  if (code.length < 18 || code.length > 32) return json(response, 400, { error: "code-not-accepted" });

  let claim;
  try {
    claim = await supabaseRpc(url, publishableKey, token, "claim_mfa_recovery_code", { p_code: code });
  } catch {
    return json(response, 400, { error: "code-not-accepted" });
  }
  // A correct code still under an earlier attempt's claim lease is busy, not
  // wrong: the database counted no failed attempt, so answer "try again"
  // until the lease ends (BUG-UG-RECOVERY-CLAIM-LEASED-MATCH-BUSY-OUTCOME-20261022).
  if (claim?.busy === true) {
    const seconds = Number.isSafeInteger(claim.retryAfterSeconds) && claim.retryAfterSeconds > 0
      ? Math.min(claim.retryAfterSeconds, RECOVERY_LEASE_SECONDS) : RECOVERY_LEASE_SECONDS;
    response.setHeader("Retry-After", String(seconds));
    return json(response, 503, { error: "recovery-unavailable" });
  }
  if (claim?.accepted === false) return json(response, 400, { error: "code-not-accepted" });
  if (!UUID.test(claim?.userId)
      || !HEX_64.test(String(claim?.sessionHandle || ""))
      || !HEX_64.test(String(claim?.claimToken || ""))) {
    return json(response, 502, { error: "recovery-unavailable" });
  }

  let factors;
  try { factors = await listFactors(url, serviceRoleKey, claim.userId); }
  catch { return json(response, 502, { error: "recovery-unavailable" }); }

  let removed = 0;
  const totpFactors = factors.filter((entry) => entry.factor_type === "totp");
  if (totpFactors.some((entry) => !UUID.test(String(entry.id || "")))) {
    return json(response, 502, { error: "recovery-unavailable" });
  }

  // Recovery starts from AAL1, so it cannot call the ordinary AAL2 global
  // sign-out preparation RPC. Bind this service-only cleanup and MFA recovery
  // lock to the live, short-lived claim before any factor disappears. The
  // durable barriers prevent both protected-data access and push recreation in
  // the gap between factor deletion and GoTrue revocation.
  let pushCleanup;
  try {
    pushCleanup = await supabaseRpc(url, serviceRoleKey, serviceRoleKey,
      "prepare_mfa_recovery_signout", {
        p_user_id: claim.userId,
        p_session_handle: claim.sessionHandle,
        p_claim_token: claim.claimToken,
      });
  } catch {
    return json(response, 502, { error: "recovery-unavailable", removed });
  }
  if (pushCleanup?.serverCleanupComplete !== true) {
    return json(response, 502, { error: "recovery-unavailable", removed });
  }

  for (const factor of totpFactors) {
    try { await deleteFactor(url, serviceRoleKey, claim.userId, factor.id); removed += 1; }
    catch { return json(response, 502, { error: "partial-recovery", removed }); }
  }

  // Revoke every refresh token while the caller's still-valid AAL1 JWT can
  // authorize GoTrue's supported global logout route. Do this before consuming
  // the code: if logout is unavailable, the short claim lease expires and the
  // same one-time code remains retryable instead of reporting a half-recovery.
  let sessionsRevoked = false;
  try {
    const logout = await fetch(`${url}/auth/v1/logout?scope=global`, {
      method: "POST",
      headers: supabaseHeaders(publishableKey, token, { "User-Agent": "UnionGround-MFA-Recovery/1.0" }),
      signal: AbortSignal.timeout(8000),
    });
    sessionsRevoked = logout.ok;
  } catch { /* handled below */ }
  if (!sessionsRevoked) return json(response, 502, { error: "recovery-unavailable", removed });

  let finalized = false;
  let replyLost = false;
  try {
    finalized = await supabaseRpc(url, serviceRoleKey, serviceRoleKey,
      "finalize_mfa_recovery_code", { p_user_id: claim.userId, p_claim_token: claim.claimToken });
  } catch {
    // swallow-ok: answered 502 below; never claim a code was consumed when unknown.
    replyLost = true;
  }

  // #8491, #9036: finalize wrote the audit row, the in-app notice and the
  // queued email to the account's own address in the commit that consumed
  // the code, so a stolen code cannot be used unseen. Send that email now,
  // also when finalize's reply was lost (it may have committed: an empty
  // claim means it did not); the notification dispatcher's tick sends
  // whatever is still waiting. The recovery stands either way; a send that
  // cannot be made raises the private account-mail alert.
  if (finalized === true || replyLost) {
    const delivery = await deliverAccountNotices({
      url,
      serviceKey: serviceRoleKey,
      userId: claim.userId,
      resendKey: String(process.env.RESEND_API_KEY || "").trim(),
      from: String(process.env.NOTIFY_FROM_ADDRESS || "").trim(),
    });
    if (delivery.unavailable || delivery.failed > 0) recordAccountMailFailure("recovery_notice_send_failed");
  }
  if (finalized !== true) return json(response, 502, { error: "recovery-unavailable", removed });

  return json(response, 200, { recovered: true, removed, sessionsRevoked, signInAgain: true });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_64 = /^[a-f0-9]{64}$/;
function safeParse(text) { try { return JSON.parse(text); } catch { return null; } }
function adminHeaders(key) {
  return { ...supabaseHeaders(key), "Content-Type": "application/json", "User-Agent": "node" };
}
async function listFactors(url, key, userId) {
  const result = await fetch(`${url}/auth/v1/admin/users/${userId}/factors`, {
    headers: adminHeaders(key), signal: AbortSignal.timeout(8000),
  });
  if (!result.ok) throw new Error("list-factors-failed");
  const payload = await result.json();
  return Array.isArray(payload) ? payload : payload?.factors ?? [];
}
async function deleteFactor(url, key, userId, factorId) {
  const result = await fetch(`${url}/auth/v1/admin/users/${userId}/factors/${factorId}`, {
    method: "DELETE", headers: adminHeaders(key), signal: AbortSignal.timeout(8000),
  });
  if (!result.ok) throw new Error("delete-factor-failed");
}
