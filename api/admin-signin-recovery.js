import { adminRankChecked } from "./_lib/adminRank.js";
import { accountEmailDomainBlocked, EMAIL_DOMAIN_BLOCKED } from "./_lib/accountEmailDomains.js";
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { bearerToken, json, methodGuard, requireEnv, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";
import {
  authUserIsBanned, authUserRecoveryLock, getAuthUser, logoutAuthUser, normalizeRecoveryEmail,
  recoveryEmailDigest, RECOVERY_UUID, setAuthUserRecoveryBan, updateAuthEmail,
} from "./_lib/memberSigninRecovery.js";

const REASONS = new Set(["lost_inbox", "address_retired"]);

function safeParse(value) {
  if (typeof value === "object" && value !== null) return value;
  try { return JSON.parse(value); } catch { return null; }
}

function mapBeginFailure(error, response) {
  const status = Number(error?.status || 0);
  if (status === 401 || status === 403) return json(response, 403, { error: "not-permitted" });
  if (status === 400 || status === 409 || status === 422) {
    return json(response, 409, { error: "recovery-unavailable" });
  }
  return json(response, 503, { error: "service-unavailable" });
}

async function failDefinitively(config, token, operationId, failureCode) {
  try {
    await supabaseRpc(config.supabaseUrl, config.publishableKey, token,
      "fail_member_signin_recovery", {
        p_operation_id: operationId,
        p_failure_code: failureCode,
      });
    return true;
  } catch {
    return false;
  }
}

function exactUser(payload, userId, email) {
  return payload?.id === userId && normalizeRecoveryEmail(payload?.email) === email;
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["POST"], () => json(response, 405, { error: "method-not-allowed" }))) return;
  const token = bearerToken(request);
  if (!token) return json(response, 401, { error: "unauthenticated" });

  const backend = resolveSupabaseBackend(request);
  const config = {
    supabaseUrl: backend.url,
    publishableKey: backend.publishableKey,
    serviceRoleKey: backend.serviceRoleKey,
  };
  if (requireEnv([config.supabaseUrl, config.publishableKey, config.serviceRoleKey],
    () => json(response, 503, { error: "not-configured" }))) return;

  const body = safeParse(request.body);
  const userId = String(body?.userId || "").trim();
  const newEmail = normalizeRecoveryEmail(body?.newEmail);
  const reason = String(body?.reason || "").trim().toLowerCase();
  if (!RECOVERY_UUID.test(userId) || !newEmail || !REASONS.has(reason)
      || body?.identityVerified !== true) {
    return json(response, 400, { error: "invalid-request" });
  }
  if (accountEmailDomainBlocked(newEmail)) return json(response, 400, { error: EMAIL_DOMAIN_BLOCKED });

  let operation;
  try {
    operation = await supabaseRpc(config.supabaseUrl, config.publishableKey, token,
      "begin_member_signin_recovery", {
        p_target_user: userId,
        p_new_email_hash: recoveryEmailDigest(newEmail),
        p_reason: reason,
      });
  } catch (error) {
    return mapBeginFailure(error, response);
  }
  const operationId = String(operation?.operationId || "");
  if (operation?.accepted !== true || !RECOVERY_UUID.test(operationId)) {
    return json(response, 502, { error: "recovery-incomplete" });
  }
  // The database refuses an administrator of equal or lower rank than the
  // target (api/_lib/adminRank.js). Without its marker this database predates
  // that guard, so stop before touching the account.
  if (!adminRankChecked(operation)) {
    const recorded = await failDefinitively(config, token, operationId, "auth_unavailable");
    return recorded
      ? json(response, 503, { error: "service-unavailable" })
      : json(response, 502, { error: "recovery-incomplete" });
  }

  // A network break may happen after GoTrue commits the address. Always read
  // the exact target first; a matching address resumes at logout/finalize.
  let current;
  try {
    current = await getAuthUser(config.supabaseUrl, config.serviceRoleKey, userId);
  } catch {
    return json(response, 502, { error: "recovery-incomplete" });
  }
  if (!current.ok || current.payload?.id !== userId) {
    return json(response, 502, { error: "recovery-incomplete" });
  }

  let recoveryBanHeld = authUserIsBanned(current.payload);
  const recoveryLockOwner = authUserRecoveryLock(current.payload);
  if ((recoveryBanHeld || recoveryLockOwner) && recoveryLockOwner !== operationId) {
    const recorded = await failDefinitively(config, token, operationId, "auth_unavailable");
    return recorded
      ? json(response, 409, { error: "recovery-unavailable" })
      : json(response, 502, { error: "recovery-incomplete" });
  }

  if (normalizeRecoveryEmail(current.payload.email) !== newEmail) {
    // Hold a provider-enforced recovery ban before the first logout. This
    // prevents any new session from being issued between the two revocations.
    // A failed post-update revocation therefore leaves the account locked and
    // retryable instead of leaving an intervening session authorized.
    if (!recoveryBanHeld) {
      let locked;
      try {
        locked = await setAuthUserRecoveryBan(config.supabaseUrl, config.serviceRoleKey, userId, operationId, true);
      } catch { /* a partially applied provider write is resolved on retry */ }
      if (!locked?.ok || locked.payload?.id !== userId || !authUserIsBanned(locked.payload)
          || authUserRecoveryLock(locked.payload) !== operationId) {
        return json(response, 502, { error: "recovery-incomplete" });
      }
      recoveryBanHeld = true;
    }

    let oldSessionsRevoked = false;
    try {
      oldSessionsRevoked = await logoutAuthUser(config.supabaseUrl, config.serviceRoleKey, userId);
    } catch { /* the unchanged address and operation make this safely retryable */ }
    if (!oldSessionsRevoked) return json(response, 502, { error: "recovery-incomplete" });

    let updated;
    try {
      updated = await updateAuthEmail(config.supabaseUrl, config.serviceRoleKey, userId, newEmail);
    } catch {
      return json(response, 502, { error: "recovery-incomplete" });
    }
    if (!updated.ok) {
      if ([400, 409, 422].includes(updated.status)) {
        let released;
        try {
          released = await setAuthUserRecoveryBan(config.supabaseUrl, config.serviceRoleKey, userId, operationId, false);
        } catch { /* keep the safe lock for a later retry */ }
        if (!released?.ok || released.payload?.id !== userId || authUserIsBanned(released.payload)
            || authUserRecoveryLock(released.payload)) {
          return json(response, 502, { error: "recovery-incomplete" });
        }
        const recorded = await failDefinitively(config, token, operationId, "address_unavailable");
        return recorded
          ? json(response, 409, { error: "recovery-unavailable" })
          : json(response, 502, { error: "recovery-incomplete" });
      }
      return json(response, 502, { error: "recovery-incomplete" });
    }
    // Never trust a merely-2xx Admin response: bind both the exact target id
    // and normalized address before ending sessions or claiming success.
    if (!exactUser(updated.payload, userId, newEmail)) {
      return json(response, 502, { error: "recovery-incomplete" });
    }
  }

  let revoked = false;
  try {
    revoked = await logoutAuthUser(config.supabaseUrl, config.serviceRoleKey, userId);
  } catch { /* the unchanged operation makes this safely retryable */ }
  if (!revoked) return json(response, 502, { error: "recovery-incomplete" });

  if (recoveryBanHeld) {
    let released;
    try {
      released = await setAuthUserRecoveryBan(config.supabaseUrl, config.serviceRoleKey, userId, operationId, false);
    } catch { /* a successful revocation remains safe while the ban is held */ }
    if (!released?.ok || released.payload?.id !== userId || authUserIsBanned(released.payload)
        || authUserRecoveryLock(released.payload)) {
      return json(response, 502, { error: "recovery-incomplete" });
    }
  }

  try {
    const finalized = await supabaseRpc(config.supabaseUrl, config.publishableKey, token,
      "finalize_member_signin_recovery", {
        p_operation_id: operationId,
        p_sessions_revoked: true,
      });
    if (finalized?.completed !== true) throw new Error("unexpected-finalize-shape");
  } catch {
    return json(response, 502, { error: "recovery-incomplete" });
  }

  return json(response, 200, { completed: true });
}
