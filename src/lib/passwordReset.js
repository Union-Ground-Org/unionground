// Browser half of self-service password reset
// (REQ-UG-SELF-SERVICE-PASSWORD-RESET-20261006). Every call goes to
// api/password-reset.js; the recovery session stays on the server, so the
// only thing this page ever holds is the server's encrypted state.

export { NEW_PASSWORD_MIN as RESET_PASSWORD_MIN, NEW_PASSWORD_MAX as RESET_PASSWORD_MAX } from "./passwordPolicy.js";
const RESET_PATH = "/reset-password";

async function post(fetcher, body) {
  try {
    const response = await fetcher("/api/password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, payload: payload || {} };
  } catch {
    return { ok: false, status: 0, payload: {} };
  }
}

function failure(result) {
  // Status 0: no answer at all, so the connection, not the reset (#9461).
  if (result.status === 0) return "offline";
  if (result.payload?.error === "reset-invalidated") return "reset-invalidated";
  if (result.status === 429) return "rate-limited";
  const code = String(result.payload?.error || "");
  return ["link-invalid", "code-not-accepted", "password-rejected", "two-step-unavailable", "recovery-incomplete", "recovery-unfinished", "recovery-held"].includes(code)
    ? code
    : "unavailable";
}

// One answer for every address: "sent" whether or not it has an account.
export async function requestPasswordReset(fetcher, { email, locale }) {
  const result = await post(fetcher, { action: "request", email, locale: locale === "es" ? "es" : "en" });
  if (result.ok && result.payload.accepted === true) return { status: "sent" };
  return { status: failure(result) };
}

// One begin per ticket at a time: a second mount while the first request is
// in flight (a remount, a Strict Mode replay) shares its answer instead of
// spending the already-used link again.
const beginsInFlight = new Map();
let beginQueue = Promise.resolve();
export function beginPasswordResetOnce(fetcher, token) {
  const running = beginsInFlight.get(token);
  if (running) return running;
  const started = beginQueue.then(async () => {
    const pending = loadPendingReset();
    const startedAt = Date.now();
    const result = await beginPasswordReset(fetcher, token);
    if (result.status === "challenge" || result.status === "enroll") {
      savePendingReset({ ticket: token, startedAt, recovery: result });
    } else if (result.status === "reset-invalidated" && pending?.status === "enroll" && pending.ticket !== token
      && sameResetAccount(pending.account, result.account)) {
      // Only the account whose enrolment this begin changed loses its saved
      // reset; another account's live one, or a newer save, stays.
      clearPendingReset(window, pending.state);
    }
    return result;
  }).finally(() => { beginsInFlight.delete(token); });
  beginQueue = started.catch(() => undefined);
  beginsInFlight.set(token, started);
  return started;
}

// The server's opaque account tag (api/_lib/passwordReset.js resetAccountTag).
const RESET_ACCOUNT = /^a1\.[A-Za-z0-9_-]{22}$/;
function resetAccount(value) {
  return typeof value === "string" && RESET_ACCOUNT.test(value) ? value : null;
}
// An unknown account on either side (a record saved before the tag existed,
// or a response without one) never counts as the same account.
function sameResetAccount(saved, changed) {
  return resetAccount(saved) !== null && resetAccount(saved) === resetAccount(changed);
}

async function beginPasswordReset(fetcher, token) {
  const result = await post(fetcher, { action: "begin", token });
  const { mode, state } = result.payload;
  const account = resetAccount(result.payload.account);
  if (result.ok && ["challenge", "enroll"].includes(mode) && typeof state === "string" && state) {
    return {
      status: mode,
      ...(account ? { account } : {}),
      state,
      qr: typeof result.payload.qr === "string" && result.payload.qr.startsWith("data:image/") ? result.payload.qr : "",
      secret: typeof result.payload.secret === "string" ? result.payload.secret : "",
    };
  }
  const status = failure(result);
  return status === "reset-invalidated"
    ? { status, ...(account ? { account } : {}), reason: result.payload.reason === "two-step-unavailable" ? "two-step-unavailable" : "unavailable" }
    : { status };
}

export async function finishPasswordReset(fetcher, { state, code, password }) {
  const result = await post(fetcher, { action: "finish", state, code, password });
  // The password is changed either way; sessionsEnded says whether every
  // other session was also signed out.
  if (result.ok && result.payload.completed === true) {
    return {
      status: "completed", sessionsEnded: result.payload.sessionsEnded !== false,
      recoveryCodeUsed: result.payload.recoveryCodeUsed === true,
    };
  }
  return { status: failure(result) };
}

// Reads `#token=` and removes it from the address bar before anything else
// happens, so the link never lingers in history, a bookmark or a screenshot.
// The server tells a six-digit authenticator code from a saved recovery code by
// shape; the page only needs to know what a recovery code may look like.
export const RECOVERY_CODE_PATTERN = /^[A-Za-z0-9-]{18,32}$/;

export function takeResetToken(win = window) {
  const fragment = win.location.hash.startsWith("#") ? win.location.hash.slice(1) : "";
  // Scrub the fragment from the address bar and the current history entry
  // before anything reads it (replaceState, never a hash assignment, which
  // would push a new entry). If the browser refuses the scrub, the token is
  // not used: a credential that stays in history is never exchanged.
  if (fragment) {
    try {
      win.history.replaceState(win.history.state, "", RESET_PATH);
    } catch {
      return null;
    }
  }
  const token = new URLSearchParams(fragment).get("token") || "";
  // Only the server's sealed ticket; GoTrue's own token never travels by email.
  return /^t1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{24,512}$/.test(token) ? token : null;
}

// A reload or a discarded phone tab must not end a reset whose link is already
// spent (BUG-UG-RESET-LINK-SPENT-ON-PAGE-OPEN-20261018). The server's
// sealed state stays valid for 15 minutes (STATE_TTL_SECONDS in
// api/_lib/passwordReset.js), so the page keeps it, with the enrolment secret
// the server only sends once, in sessionStorage for no longer than that: gone
// with the tab, never in the address bar, never in localStorage.
export const RESET_STATE_LIFETIME_MS = 15 * 60 * 1000;
export const PENDING_RESET_KEY = "unionground.password-reset-pending";
// The same bounds the phone applies, so a record one client keeps the other
// can also resume.
const RESET_STATE_MAX = 16_384;
const RESET_SECRET_MAX = 256;
const RESET_QR_MAX = 100_000;

function sessionStore(win) {
  try {
    return win.sessionStorage || null;
  } catch {
    return null;
  }
}

export function clearPendingReset(win = window, expectedState) {
  if (expectedState !== undefined && loadPendingReset(win)?.state !== expectedState) return;
  try {
    sessionStore(win)?.removeItem(PENDING_RESET_KEY);
  } catch {
    // Storage may be disabled; the reset then simply cannot resume.
  }
}

// `startedAt` is read before the begin request, so this record can never
// outlive the server's state, which is sealed after the request arrives.
// `ticket` is the emailed link's sealed ticket, already spent by begin; it
// only tells a second tap of the same link from a newer one.
export function savePendingReset({ ticket, startedAt, recovery }, win = window) {
  if (recovery.state.length > RESET_STATE_MAX || recovery.qr.length > RESET_QR_MAX || recovery.secret.length > RESET_SECRET_MAX) return;
  try {
    sessionStore(win)?.setItem(PENDING_RESET_KEY, JSON.stringify({
      ticket, expiresAt: startedAt + RESET_STATE_LIFETIME_MS,
      status: recovery.status, state: recovery.state, qr: recovery.qr, secret: recovery.secret,
      ...(resetAccount(recovery.account) ? { account: recovery.account } : {}),
    }));
  } catch {
    // Quota or disabled storage: the reset works in memory as before.
  }
}

// The saved recovery, or null when there is none, it expired, or it is damaged
// (an unusable record is removed so it cannot hide a fresh request).
export function loadPendingReset(win = window, nowMs = Date.now()) {
  const store = sessionStore(win);
  if (!store) return null;
  try {
    const raw = store.getItem(PENDING_RESET_KEY);
    if (raw === null) return null;
    const saved = JSON.parse(raw);
    const valid = saved && typeof saved === "object"
      && ["challenge", "enroll"].includes(saved.status)
      && typeof saved.state === "string" && saved.state
      && typeof saved.ticket === "string" && typeof saved.qr === "string" && typeof saved.secret === "string"
      && saved.state.length <= RESET_STATE_MAX && saved.qr.length <= RESET_QR_MAX && saved.secret.length <= RESET_SECRET_MAX
      // Only the lapse is checked against the clock: a clock stepped backwards
      // must not make a live record look forged, and the server refuses a
      // lapsed state whatever this record says.
      && Number.isFinite(saved.expiresAt) && saved.expiresAt > nowMs;
    if (!valid) {
      store.removeItem(PENDING_RESET_KEY);
      return null;
    }
    const account = resetAccount(saved.account);
    return { ticket: saved.ticket, status: saved.status, state: saved.state, qr: saved.qr, secret: saved.secret,
      ...(account ? { account } : {}) };
  } catch {
    clearPendingReset(win);
    return null;
  }
}
