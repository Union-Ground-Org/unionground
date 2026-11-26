// Transport-only error shared by web and native public readers.
export class MemberApiError extends Error {
  constructor(label, error) {
    super(`${label}: ${error.message}`);
    this.name = "MemberApiError";
    this.label = label;
    // Nullish rather than `|| null`: PostgREST codes are strings, but a "" or 0
    // arriving here is information about the server, not a reason to discard it.
    this.code = error.code ?? null;
    this.details = error.details ?? null;
    this.hint = error.hint ?? null;
  }
}

// Resolves a PostgREST call's own result, or a statement-timeout-shaped error
// result after `ms`, so one slow additive read cannot hold a loader's
// Promise.all (BUG-UG-PAGES-FAIL-HARD-ON-MISSING-OR-SLOW-FUNCTION-20261003).
// The request itself keeps running; only the wait is bounded.
export function withSoftRpcDeadline(request, ms) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ data: null, error: { code: "57014", message: "soft deadline exceeded" } }), ms);
  });
  return Promise.race([Promise.resolve(request), deadline]).finally(() => clearTimeout(timer));
}

// BUG-UG-STALE-EVENT-SAVE-LOCK-TIMEOUT-20261106: a refusal because
// the row changed since the caller read it. Those refusals raised SQLSTATE
// 40001 until migration 20261106220000, but PostgREST 14 retries a 40001
// transaction without limit, so on hosted the request spun until a lock
// timeout. They now raise PT409 (HTTP 409, never retried). Both codes mean
// "reload and try again"; the old one is still produced by client-side checks.
export const CONFLICT_REFUSAL_CODES = Object.freeze(["PT409", "40001"]);

export function isConflictRefusalCode(code) {
  return CONFLICT_REFUSAL_CODES.includes(code == null ? "" : String(code));
}
