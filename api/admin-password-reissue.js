import { adminRankChecked } from "./_lib/adminRank.js";
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { bearerToken, json, methodGuard, requireEnv, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";
import {
  activateStagedAuthUserPassword, generateMemberPassword, sendSignInPasswordEmail,
  stageAuthUserPassword, UUID,
} from "./_lib/memberInvitations.js";
import {
  authUserIsBanned, authUserRecoveryLock, getAuthUser, logoutAuthUser,
  normalizeRecoveryEmail, setAuthUserRecoveryBan,
} from "./_lib/memberSigninRecovery.js";

function safeParse(value) {
  if (typeof value === "object" && value !== null) return value;
  try { return JSON.parse(value); } catch { return null; }
}

async function recordFailure(config, token, operationId, failureCode) {
  try {
    await supabaseRpc(config.url, config.publishableKey, token,
      "fail_member_password_reissue", {
        p_operation_id: operationId,
        p_failure_code: failureCode,
      });
  } catch { /* the live operation remains retryable */ }
}

async function finalizeOperation(config, token, operationId) {
  const finalized = await supabaseRpc(config.url, config.publishableKey, token,
    "finalize_member_password_reissue", { p_operation_id: operationId });
  if (finalized?.completed !== true) throw new Error("unexpected-finalize-shape");
}

async function releaseUnstagedRecoveryBan(config, userId, operationId, originalUser, knownLockedUser = null) {
  // Never release a ban that predated this invocation, and never release the
  // exact operation after its replacement credential has been staged. Those
  // states require an authorized retry to preserve credential safety.
  if (authUserIsBanned(originalUser) || authUserRecoveryLock(originalUser) !== null
      || originalUser?.app_metadata?.union_ground_password_reissue_operation_id === operationId) return;

  let candidate = knownLockedUser;
  if (candidate?.id !== userId || authUserRecoveryLock(candidate) !== operationId) {
    try {
      const current = await getAuthUser(config.url, config.serviceKey, userId);
      candidate = current?.ok ? current.payload : null;
    } catch { return; }
  }
  if (candidate?.id !== userId || !authUserIsBanned(candidate)
      || authUserRecoveryLock(candidate) !== operationId
      || candidate.app_metadata?.union_ground_password_reissue_operation_id === operationId) return;

  try {
    await setAuthUserRecoveryBan(config.url, config.serviceKey, userId, operationId, false);
  } catch { /* best effort: a later authorized retry can recover the lease */ }
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["POST"], () => json(response, 405, { error: "method-not-allowed" }))) return;
  const token = bearerToken(request);
  if (!token) return json(response, 401, { error: "unauthenticated" });
  const backend = resolveSupabaseBackend(request);
  if (backend.surface === "demo") return json(response, 404, { error: "not-available" });
  const config = {
    url: backend.url,
    publishableKey: backend.publishableKey,
    serviceKey: backend.serviceRoleKey,
    resendKey: process.env.RESEND_API_KEY,
    from: process.env.NOTIFY_FROM_ADDRESS,
  };
  if (requireEnv(Object.values(config), () => json(response, 503, { error: "not-configured" }))) return;
  const body = safeParse(request.body);
  const userId = String(body?.userId || "");
  if (!UUID.test(userId) || body?.identityVerified !== true) {
    return json(response, 400, { error: "invalid-request" });
  }

  let operation;
  try {
    operation = await supabaseRpc(config.url, config.publishableKey, token,
      "begin_member_password_reissue", { p_target_user: userId });
  } catch (error) {
    const status = Number(error?.status || 0);
    return json(response, status === 401 || status === 403 ? 403 : 409,
      { error: status === 401 || status === 403 ? "not-permitted" : "reissue-unavailable" });
  }
  const operationId = String(operation?.operationId || "");
  if (operation?.accepted !== true || !UUID.test(operationId)) {
    return json(response, 502, { error: "reissue-incomplete" });
  }
  // The database refuses an administrator of equal or lower rank than the
  // target (api/_lib/adminRank.js). Without its marker this database predates
  // that guard, so stop before touching the account.
  if (!adminRankChecked(operation)) {
    await recordFailure(config, token, operationId, "auth_unavailable");
    return json(response, 503, { error: "service-unavailable" });
  }

  let current;
  try { current = await getAuthUser(config.url, config.serviceKey, userId); }
  catch {
    await recordFailure(config, token, operationId, "auth_unavailable");
    return json(response, 502, { error: "reissue-incomplete" });
  }
  const user = current?.payload;
  const email = normalizeRecoveryEmail(user?.email);
  if (!current?.ok || user?.id !== userId || !email) {
    await recordFailure(config, token, operationId, "auth_mismatch");
    return json(response, 502, { error: "reissue-incomplete" });
  }

  // A provider update can succeed even if the request loses the subsequent
  // ledger response. Finish that already-active operation idempotently instead
  // of rotating and emailing another credential.
  if (user.app_metadata?.union_ground_password_reissue_operation_id === operationId
      && user.app_metadata?.union_ground_provisioning === "active"
      && !authUserIsBanned(user) && authUserRecoveryLock(user) === null) {
    try { await finalizeOperation(config, token, operationId); }
    catch { return json(response, 502, { error: "reissue-incomplete" }); }
    return json(response, 200, { completed: true });
  }

  const password = generateMemberPassword();
  // Hold a provider-enforced ban before revoking old sessions and staging the
  // new credential. No new session can enter the recovery window.
  let locked;
  try { locked = await setAuthUserRecoveryBan(config.url, config.serviceKey, userId, operationId, true); }
  catch { /* the unchanged operation is retryable */ }
  if (!locked?.ok || locked.payload?.id !== userId || !authUserIsBanned(locked.payload)
      || authUserRecoveryLock(locked.payload) !== operationId) {
    await releaseUnstagedRecoveryBan(config, userId, operationId, user);
    await recordFailure(config, token, operationId, "auth_unavailable");
    return json(response, 502, { error: "reissue-incomplete" });
  }

  // Revoke every old session before staging the unsent password under the
  // existing recovery ban. A provider failure leaves the account safely
  // banned and the operation retryable; no password is returned.
  let revoked = false;
  try { revoked = await logoutAuthUser(config.url, config.serviceKey, userId); } catch { /* retryable */ }
  if (!revoked) {
    await releaseUnstagedRecoveryBan(config, userId, operationId, user, locked.payload);
    await recordFailure(config, token, operationId, "auth_unavailable");
    return json(response, 502, { error: "reissue-incomplete" });
  }
  let staged;
  try { staged = await stageAuthUserPassword(config.url, config.serviceKey, locked.payload, password, operationId); }
  catch { /* retryable */ }
  if (!staged || staged.id !== userId || !authUserIsBanned(staged)
      || authUserRecoveryLock(staged) !== operationId
      || staged.app_metadata?.union_ground_password_reissue_operation_id !== operationId
      || staged.app_metadata?.union_ground_provisioning !== "active") {
    await recordFailure(config, token, operationId, "auth_unavailable");
    return json(response, 502, { error: "reissue-incomplete" });
  }
  // The email's "Sent" time is the moment this credential was installed, so
  // it orders passwords by when each one replaced the last, not by delivery
  // latency. begin_member_password_reissue already serializes reissues per
  // member (advisory lock plus the 15-minute delivering lease).
  const stagedAt = new Date();

  // Delivery happens only after the exact credential is installed under the
  // ban. If delivery fails, the account stays safely banned and a later
  // authorized attempt can stage a fresh credential before sending it.
  let delivered = false;
  try {
    delivered = await sendSignInPasswordEmail({
      resendKey: config.resendKey,
      from: config.from,
      to: email,
      locale: user.user_metadata?.language === "es" ? "es" : "en",
      password,
      invitationId: operationId,
      reissuedAt: stagedAt,
    });
  } catch { /* recorded below */ }
  if (!delivered) {
    await recordFailure(config, token, operationId, "provider_unavailable");
    return json(response, 502, { error: "reissue-incomplete" });
  }

  let activated;
  try { activated = await activateStagedAuthUserPassword(config.url, config.serviceKey, staged, operationId); }
  catch { /* retryable; the staged credential remains provider-banned */ }
  if (!activated || activated.id !== userId || authUserIsBanned(activated)
      || authUserRecoveryLock(activated) !== null
      || activated.app_metadata?.union_ground_password_reissue_operation_id !== operationId
      || activated.app_metadata?.union_ground_provisioning !== "active") {
    // The provider may have committed the unban while its response was lost.
    // Re-read once and finalize that exact operation if it is already active;
    // otherwise record a retryable failure while the staged credential stays
    // under the recovery ban.
    let recovered;
    try { recovered = await getAuthUser(config.url, config.serviceKey, userId); } catch { /* preserve live lease */ }
    const recoveredUser = recovered?.payload;
    if (recovered?.ok && recoveredUser?.id === userId
        && !authUserIsBanned(recoveredUser) && authUserRecoveryLock(recoveredUser) === null
        && recoveredUser.app_metadata?.union_ground_password_reissue_operation_id === operationId
        && recoveredUser.app_metadata?.union_ground_provisioning === "active") {
      try { await finalizeOperation(config, token, operationId); }
      catch { return json(response, 502, { error: "reissue-incomplete" }); }
      return json(response, 200, { completed: true });
    }
    if (recovered?.ok) await recordFailure(config, token, operationId, "auth_unavailable");
    return json(response, 502, { error: "reissue-incomplete" });
  }

  try {
    await finalizeOperation(config, token, operationId);
  } catch {
    return json(response, 502, { error: "reissue-incomplete" });
  }
  return json(response, 200, { completed: true });
}
