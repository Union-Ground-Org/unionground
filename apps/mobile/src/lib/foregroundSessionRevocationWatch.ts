// BUG-UG-NATIVE-SIGN-OUT-EVERYWHERE-NOT-NOTICED-IN-FOREGROUND-20261103:
// after "Sign out everywhere" on another device, this device's session is gone
// on the server, but the app only asked Auth again on the next return to the
// foreground, so a phone left open kept its signed-in Home. While the app is
// active the watch asks about the exact captured session on a short cadence.
// Only a proven absence (the probe the sign-out path already trusts) reports
// it; a live session, a network or server failure, a probe that throws or one
// that never answers proves nothing and leaves the session alone. The owner
// stops the watch in the background, where the resume on return covers it.

// Under a minute from the revocation to sign-in, as on the web watch.
export const SESSION_REVOCATION_CHECK_INTERVAL_MS = 30_000;
// A probe that never answers proves nothing and must not block later checks.
export const SESSION_REVOCATION_CHECK_TIMEOUT_MS = 10_000;
// The web app's copy for the same event (auth.signedOutOnThisDevice).
export const SIGNED_OUT_ELSEWHERE_NOTICE = 'You were signed out on this device. Sign in again to continue.';

export type ForegroundSessionRevocationWatch = {
  start(): void;
  stop(): void;
  // One check now. Resolves true only when the session was proven gone and
  // `onRevoked` ran; a stopped watch or a check already in flight resolves false.
  check(): Promise<boolean>;
};

export type ForegroundSessionRevocationWatchOptions<S> = {
  isGone(session: S): Promise<boolean>;
  onRevoked(session: S): void;
  intervalMs?: number;
  timeoutMs?: number;
};

// The probe's answer, or false when it rejects, throws or outlasts the timeout.
function boundedProbe<S>(isGone: (session: S) => Promise<boolean>, session: S, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(resolve, timeoutMs, false); });
  let answer: Promise<boolean>;
  try {
    answer = Promise.resolve(isGone(session)).then((gone) => gone === true, () => false);
  } catch {
    answer = Promise.resolve(false);
  }
  return Promise.race([answer, timeout]).finally(() => clearTimeout(timer));
}

export function createForegroundSessionRevocationWatch<S>(
  session: S,
  options: ForegroundSessionRevocationWatchOptions<S>,
): ForegroundSessionRevocationWatch {
  const intervalMs = options.intervalMs ?? SESSION_REVOCATION_CHECK_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? SESSION_REVOCATION_CHECK_TIMEOUT_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  // stop() bumps the generation, so an answer that arrives after a background
  // or a session change cannot act: the resume on return owns that decision.
  let generation = 0;
  let inFlight = false;
  // One proof hands the session to its owner once; the watch is then done.
  let revoked = false;

  const stop = () => {
    generation += 1;
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const check = async (): Promise<boolean> => {
    if (timer === null || inFlight || revoked) return false;
    inFlight = true;
    const capturedGeneration = generation;
    try {
      const gone = await boundedProbe(options.isGone, session, timeoutMs);
      if (!gone || capturedGeneration !== generation || revoked) return false;
      revoked = true;
      stop();
      options.onRevoked(session);
      return true;
    } finally {
      inFlight = false;
    }
  };

  return {
    // The first check waits one interval: a return to the foreground already
    // runs the full resume, which answers the same question.
    start() {
      if (timer !== null || revoked) return;
      timer = setInterval(() => { void check(); }, intervalMs);
    },
    stop,
    check,
  };
}
