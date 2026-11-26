import { prepareMemberSignOut } from "./memberApi.js";
import { sameAuthSessionLineage } from "./exactSessionStorage.js";
import { isAuthSessionMissingError } from "@supabase/supabase-js";

const VALID_SCOPES = new Set(["local", "global"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function provesSessionAbsent(error) {
  // auth-js normalizes a server session_not_found response to this error.
  // These call sites always provide a bearer, so it cannot mean a missing
  // optional local session. Keep transport/server failures fail-closed.
  if (isAuthSessionMissingError(error) && error.status === 400) return true;
  return [401, 403, 404].includes(error?.status)
    && ["session_not_found", "user_not_found"].includes(error?.code);
}

function pendingSignOutError() {
  return Object.assign(new Error("The captured authenticated session could not be securely closed."), {
    code: "SIGN_OUT_PUSH_PAUSED",
  });
}

function requireCurrentIdentity(isCurrent) {
  if (typeof isCurrent !== "function" || !isCurrent()) {
    throw new Error("The authenticated account changed during sign-out.");
  }
}

// Browser Push API teardown is an independent privacy boundary. A lookup
// failure is UNKNOWN, not "no subscription": treating an unavailable worker
// as absence can leave a shared browser receiving the previous member's mail.
export async function inspectAndRemoveBrowserPush(serviceWorker, isCurrent = () => true) {
  requireCurrentIdentity(isCurrent);
  if (!serviceWorker?.getRegistration && !serviceWorker?.ready) {
    return { browserRemoved: false, noSubscription: true, browserVerified: true };
  }

  try {
    const registration = serviceWorker.getRegistration
      ? await serviceWorker.getRegistration()
      : await serviceWorker.ready;
    requireCurrentIdentity(isCurrent);
    const subscription = await registration?.pushManager?.getSubscription?.();
    requireCurrentIdentity(isCurrent);
    if (!subscription?.endpoint) {
      return { browserRemoved: false, noSubscription: true, browserVerified: true };
    }
    let browserRemoved = false;
    try { browserRemoved = (await subscription.unsubscribe()) === true; } catch { /* reported below */ }
    requireCurrentIdentity(isCurrent);
    return { browserRemoved, noSubscription: false, browserVerified: true };
  } catch {
    return { browserRemoved: false, noSubscription: false, browserVerified: false };
  }
}

export async function signOutSafely(client, {
  scope = "local",
  expectedUserID,
  capturedSession,
  capturedRpcClient,
  capturedRpcClientForSession,
  verifyCapturedSession,
  getCurrentSession = () => capturedSession,
  compareAndClearLocalSession,
  onLocalSessionCleared,
  isCurrent = () => true,
  // A session the caller already proved absent through an explicit provider
  // answer for its lineage (the revocation watcher, #6885). Nothing remains
  // on the server to prepare, so the unbounded prepare call is skipped.
  provenAbsentSession = null,
} = {}) {
  if (!VALID_SCOPES.has(scope)) throw new Error("Invalid sign-out scope.");
  if (typeof expectedUserID !== "string" || !UUID_PATTERN.test(expectedUserID)) {
    throw new Error("Authenticated account identity is unavailable.");
  }
  if (
    capturedSession?.user?.id !== expectedUserID
    || typeof capturedSession?.access_token !== "string"
    || !capturedSession.access_token
    || typeof capturedSession?.refresh_token !== "string"
    || !capturedSession.refresh_token
  ) {
    throw new Error("The captured authenticated session is unavailable.");
  }
  if (!capturedRpcClient?.rpc && typeof capturedRpcClientForSession !== "function") {
    throw new Error("The captured authenticated client is unavailable.");
  }
  if (typeof compareAndClearLocalSession !== "function" || typeof onLocalSessionCleared !== "function") {
    throw new Error("Exact local session cleanup is unavailable.");
  }
  requireCurrentIdentity(isCurrent);

  let latestOwnedSession = capturedSession;
  const adoptLatestOwnedSession = () => {
    const observed = getCurrentSession?.();
    if (observed === capturedSession || sameAuthSessionLineage(observed, capturedSession)) {
      latestOwnedSession = observed;
    }
    return latestOwnedSession;
  };

  let serverCleanupComplete = false;
  let sessionAlreadyAbsent = false;
  const cleanupSession = adoptLatestOwnedSession();
  if (provenAbsentSession && sameAuthSessionLineage(cleanupSession, provenAbsentSession)) {
    sessionAlreadyAbsent = true;
  } else {
    try {
      const cleanupClient = typeof capturedRpcClientForSession === "function"
        ? capturedRpcClientForSession(cleanupSession)
        : capturedRpcClient;
      const result = await prepareMemberSignOut(cleanupClient, scope, expectedUserID);
      serverCleanupComplete = result?.serverCleanupComplete === true;
    } catch (error) {
      if (error?.code === "42501") {
        // The same refusal covers both a live identity mismatch and an Auth
        // session revoked elsewhere. Only an explicit provider absence result
        // for this captured bearer permits the latter to clear its local CAS.
        // Never inspect the mutable client's current session or infer absence
        // from a generic 403, transport failure, or auth-shaped gateway error.
        try {
          if (typeof verifyCapturedSession !== "function") throw error;
          // auth-js getUser removes its client's session on server absence,
          // even with an explicit bearer. Use only the isolated verifier.
          const result = await verifyCapturedSession(adoptLatestOwnedSession());
          sessionAlreadyAbsent = provesSessionAbsent(result?.error);
        } catch { /* Unknown state retains the captured session. */ }
        if (!sessionAlreadyAbsent) throw error;
      }
    }
  }

  // The server transaction removes the captured session's push association.
  // Keep the browser subscription itself dormant so a replacement account can
  // safely reuse it. An async unsubscribe cannot be made atomic with an auth
  // transition and could otherwise tear down B after B becomes current.
  if (!serverCleanupComplete && !sessionAlreadyAbsent) {
    throw new Error(scope === "global"
      ? "Push cleanup could not be completed on every device. Try again."
      : "Push cleanup could not be verified. Try again.");
  }

  // The ordinary client sign-out method reads whichever session happens to occupy the client's
  // storage after its internal awaits. Revoke the newest token that still
  // belongs to the immutable user/session-id lineage captured at the click
  // boundary, then let the storage CAS clear only that lineage.
  const revocationSession = adoptLatestOwnedSession();
  if (!sessionAlreadyAbsent) {
    let revokeResult;
    try {
      revokeResult = await client.auth.admin.signOut(revocationSession.access_token, scope);
    } catch {
      throw pendingSignOutError();
    }
    if (revokeResult?.error) {
      sessionAlreadyAbsent = provesSessionAbsent(revokeResult.error);
      if (!sessionAlreadyAbsent) throw pendingSignOutError();
    }
  }

  const localCleared = await compareAndClearLocalSession(revocationSession);
  if (localCleared && isCurrent()) await onLocalSessionCleared(revocationSession);
  if (!localCleared && isCurrent()) {
    throw new Error("The authenticated account changed during local sign-out.");
  }
  if (scope === "global" && sessionAlreadyAbsent) {
    // Absence of this session proves nothing about the user's other devices.
    // Clear this device's stale tuple without returning a false global success.
    throw Object.assign(new Error("Sign-out on other devices could not be verified. Sign in to that account again to finish."), {
      code: "SIGN_OUT_OTHER_DEVICES_UNVERIFIED",
    });
  }
  return { error: null, localCleared };
}
