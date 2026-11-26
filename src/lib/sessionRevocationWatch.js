// BUG-UG-SIGN-OUT-EVERYWHERE-OTHER-DEVICE-STALE-20261103: after "Sign
// out everywhere" on another device, this device's session is gone on the
// server but its screen kept showing the workspace, and a reload stalled on
// "Member data is unavailable". The watcher asks the isolated verifier about
// the captured session when the session starts, when the tab comes back into
// view or focus, after a failed load, and every few minutes while visible.
// Only an explicit provider absence for that exact session (the same proof
// the sign-out path accepts) reports it revoked; a network or server failure
// proves nothing and leaves the session alone.
import { sameAuthSessionLineage } from "./exactSessionStorage.js";
import { provesSessionAbsent } from "./sessionManagement.js";

export const SESSION_REVOCATION_CHECK_INTERVAL_MS = 5 * 60_000;
// Focus and visibility events arrive in bursts; one check covers them all.
export const SESSION_REVOCATION_CHECK_MIN_GAP_MS = 30_000;
// A verifier that never answers proves nothing and must not block later checks.
export const SESSION_REVOCATION_VERIFY_TIMEOUT_MS = 10_000;

// Every captured session with a real access token is watched, SAMPLE included;
// only the in-memory fixture client, whose session has no token, is exempt.
export function sessionRevocationWatchApplies({ fixtureClient = false, session = null } = {}) {
  return !fixtureClient && typeof session?.access_token === "string" && session.access_token !== "";
}

// The verifier's answer, or undefined ("unknown") when it throws, rejects or
// runs past the timeout.
function boundedVerify(verify, session, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs, undefined); });
  let answer;
  try { answer = Promise.resolve(verify(session)).catch(() => undefined); } catch { answer = Promise.resolve(undefined); }
  return Promise.race([answer, timeout]).finally(() => clearTimeout(timer));
}

export function watchSessionRevocation({
  getSession,
  verify,
  onRevoked,
  target = globalThis.window,
  doc = globalThis.document,
  now = () => Date.now(),
  intervalMs = SESSION_REVOCATION_CHECK_INTERVAL_MS,
  minGapMs = SESSION_REVOCATION_CHECK_MIN_GAP_MS,
  verifyTimeoutMs = SESSION_REVOCATION_VERIFY_TIMEOUT_MS,
} = {}) {
  let stopped = false;
  let inFlight = null;
  let lastCheckAt = -Infinity;
  let deferredTimer = null;
  // A deferral asked for while a check runs; it waits for the gap after it.
  let deferAfterFlight = false;

  // `defer` (a failed load) must not be lost to the gap: it runs once the gap
  // ends, and a second deferral joins the one already waiting.
  function check({ force = false, defer = false } = {}) {
    if (stopped) return Promise.resolve(false);
    if (inFlight) {
      if (defer) deferAfterFlight = true;
      return inFlight;
    }
    const wait = minGapMs - (now() - lastCheckAt);
    if (!force && wait > 0) {
      if (defer && deferredTimer === null) {
        deferredTimer = setTimeout(() => { deferredTimer = null; void check(); }, wait);
      }
      return Promise.resolve(false);
    }
    const session = getSession();
    if (!session?.access_token) return Promise.resolve(false);
    lastCheckAt = now();
    inFlight = (async () => {
      try {
        const result = await boundedVerify(verify, session, verifyTimeoutMs);
        // A replacement sign-in or a stop during the request owns the screen now.
        if (stopped || !provesSessionAbsent(result?.error) || !sameAuthSessionLineage(getSession(), session)) return false;
        // The proof travels with the session, so sign-out need not ask again.
        await onRevoked(session, result);
        return true;
      } catch {
        return false;
      } finally {
        inFlight = null;
        if (deferAfterFlight && !stopped) {
          deferAfterFlight = false;
          void check({ defer: true });
        }
      }
    })();
    return inFlight;
  }

  const visible = () => !doc || doc.visibilityState !== "hidden";
  const onVisibility = () => { if (visible()) void check(); };
  const onFocus = () => { void check(); };
  target?.addEventListener?.("focus", onFocus);
  doc?.addEventListener?.("visibilitychange", onVisibility);
  const timer = setInterval(() => { if (visible()) void check(); }, intervalMs);
  void check({ force: true });

  return {
    check,
    stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(deferredTimer);
      deferredTimer = null;
      target?.removeEventListener?.("focus", onFocus);
      doc?.removeEventListener?.("visibilitychange", onVisibility);
    },
  };
}
