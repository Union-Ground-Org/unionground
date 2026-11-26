import { ACCOUNT_DELETION_CLIENT_TIMEOUT_MS } from "./accountLifecycleBudget.js";

export { ACCOUNT_DELETION_CLIENT_TIMEOUT_MS } from "./accountLifecycleBudget.js";

export function downloadMemberDataExport(exported, environment = {}) {
  const activeDocument = environment.document || document;
  const activeUrl = environment.URL || URL;
  const now = environment.now || new Date();
  const blob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
  const objectUrl = activeUrl.createObjectURL(blob);
  const anchor = activeDocument.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `union-base-data-${now.toISOString().slice(0, 10)}.json`;
  anchor.click();
  activeUrl.revokeObjectURL(objectUrl);
  return { downloaded: true };
}

function deletionOutcomeUnknown(error) {
  return error instanceof TypeError
    || error?.name === "TimeoutError"
    || error?.name === "AbortError"
    || error?.code === "ABORT_ERR";
}

function indeterminateDeletionError() {
  return Object.assign(new Error("account-delete-indeterminate"), {
    code: "account-delete-indeterminate",
    indeterminate: true,
    verifyAction: "sign-in",
  });
}

function definitiveDeletionError(code) {
  return Object.assign(new Error(code), { code });
}

const DEFINITIVE_ACCOUNT_DELETION_ERRORS = new Set([
  "not-configured",
  "unauthenticated",
  "invalid-confirmation",
  "not-permitted",
  "account-lifecycle-unavailable",
  "deletion-in-progress",
  "account-delete-failed",
  "reauth-failed",
  "try-later",
  "step-up-required",
]);

// `password` is the re-entry a member with no second factor gives in the
// deletion dialog; it is sent once, to this route only, and never stored.
export async function requestAccountDeletion(session, confirmation, fetchImpl = fetch, endpoint = "/api/account-lifecycle", { password = "" } = {}) {
  // Hermes versions without AbortSignal.timeout still get the same bounded
  // request. Keep the timer alive through JSON consumption, then release it.
  const controller = typeof AbortSignal.timeout === "function" ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), ACCOUNT_DELETION_CLIENT_TIMEOUT_MS) : null;
  const signal = controller?.signal || AbortSignal.timeout(ACCOUNT_DELETION_CLIENT_TIMEOUT_MS);
  try {
    return await performAccountDeletion(session, confirmation, password, fetchImpl, endpoint, signal);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function performAccountDeletion(session, confirmation, password, fetchImpl, endpoint, signal) {
  const accessToken = session?.access_token;
  if (!accessToken) throw definitiveDeletionError("unauthenticated");
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(password ? { confirmation, password } : { confirmation }),
      credentials: "omit",
      redirect: "error",
      signal,
    });
  } catch (error) {
    // The server may have crossed the irreversible Auth deletion boundary
    // before the browser deadline. Never convert that uncertainty into a
    // definitive "not deleted" message or encourage a blind retry.
    if (deletionOutcomeUnknown(error)) throw indeterminateDeletionError();
    throw error;
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    // A successful deletion can be followed by a truncated or non-JSON proxy
    // response. With no readable server contract, a retry is unsafe.
    throw indeterminateDeletionError();
  }
  const errorCode = typeof payload?.error === "string" ? payload.error : "";
  if (errorCode === "account-delete-indeterminate"
      || response.status === 504
      || (response.status >= 500 && !DEFINITIVE_ACCOUNT_DELETION_ERRORS.has(errorCode))) {
    throw indeterminateDeletionError();
  }
  if (response.ok && payload?.deleted !== true) {
    // A 2xx transport status does not prove that the irreversible operation
    // failed. Only the explicit server contract can confirm deletion.
    throw indeterminateDeletionError();
  }
  if (!response.ok) {
    throw definitiveDeletionError(
      typeof payload?.error === "string" ? payload.error : "account-delete-failed",
    );
  }
  return payload;
}
