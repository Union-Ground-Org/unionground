import Constants from 'expo-constants';

import { trustedPortalForBackend } from '../lib/configPolicy';

export const SHARE_RECOVERY_TEST_MAX_HOLD_MS = 120_000;
type Phase = 'armed' | 'uploading' | 'pending' | 'held' | 'released' | 'expired';
type Loss = 'not-requested' | 'pending' | 'complete' | 'failed';
export type ShareRecoveryTestBoundary = 'notifications' | 'prepare-signout' | 'session-loss-recovery';
type BoundaryControl = Readonly<{
  arm: (timeoutMs?: number) => number;
  status: () => Readonly<{ run: number; phase: Phase }> | null;
  release: (run: number) => void;
  reset: (run: number) => void;
}>;
export type ShareRecoveryTestControl = Readonly<{
  boundaries: Readonly<Record<ShareRecoveryTestBoundary, BoundaryControl>>;
  arm: (timeoutMs?: number) => number;
  status: () => Readonly<{ run: number; phase: Phase; sessionLoss: Loss }> | null;
  loseSession: (run: number) => Promise<void>;
  startCleanup: (run: number) => Promise<void>;
  release: (run: number) => void;
  reset: (run: number) => void;
}>;
type TimedHold = {
  run: number;
  phase: Phase;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  wait: Promise<void>;
  resolve: () => void;
};
type Hold = TimedHold & { sessionLoss: Loss; ownerID: string | null };

// A forged manifest cannot enable a Release bundle. A development build pointed
// at the real backend cannot enable it either. No URL, storage key or UI switch
// changes this decision, and the control exposes no session/file identifiers.
const extra = Constants.expoConfig?.extra;
const enabled = typeof __DEV__ !== 'undefined' && __DEV__
  && extra?.releaseEnvironment === 'development'
  && extra?.shareRecoveryTestHook === true
  && trustedPortalForBackend(extra?.supabaseUrl) !== null;
const host = globalThis as typeof globalThis & {
  __unionGroundShareRecoveryTest?: ShareRecoveryTestControl;
};
let active: Hold | null = null;
let sequence = 0;
const boundaryHolds = new Map<ShareRecoveryTestBoundary, TimedHold>();

function finish(hold: TimedHold, phase: 'released' | 'expired'): void {
  if (hold.phase === 'released' || hold.phase === 'expired') return;
  clearTimeout(hold.timer);
  hold.phase = phase;
  hold.resolve();
}

function createHold(timeoutMs = SHARE_RECOVERY_TEST_MAX_HOLD_MS): TimedHold {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > SHARE_RECOVERY_TEST_MAX_HOLD_MS) {
    throw new Error('Share-recovery hold must be between 1000 and 120000 ms.');
  }
  let resolve: () => void = () => undefined;
  const wait = new Promise<void>((done) => { resolve = done; });
  const hold: TimedHold = {
    run: ++sequence,
    phase: 'armed',
    deadline: Date.now() + timeoutMs,
    timer: setTimeout(() => finish(hold, 'expired'), timeoutMs),
    wait,
    resolve,
  };
  return hold;
}

function requireBoundaryRun(boundary: ShareRecoveryTestBoundary, run: number): TimedHold {
  const hold = boundaryHolds.get(boundary);
  if (!enabled || !hold || hold.run !== run) throw new Error('No matching boundary test run.');
  if (Date.now() >= hold.deadline) finish(hold, 'expired');
  return hold;
}

function boundaryControl(boundary: ShareRecoveryTestBoundary): BoundaryControl {
  return Object.freeze({
    arm(timeoutMs?: number) {
      if (boundaryHolds.has(boundary)) throw new Error('Reset the previous boundary test run first.');
      const hold = createHold(timeoutMs);
      boundaryHolds.set(boundary, hold);
      return hold.run;
    },
    status() {
      const hold = boundaryHolds.get(boundary);
      if (!hold) return null;
      const current = requireBoundaryRun(boundary, hold.run);
      return { run: current.run, phase: current.phase };
    },
    release(run: number) {
      const hold = requireBoundaryRun(boundary, run);
      if (hold.phase === 'expired') throw new Error('Boundary test hold expired; retain a failed run.');
      finish(hold, 'released');
    },
    reset(run: number) {
      const hold = requireBoundaryRun(boundary, run);
      finish(hold, 'released');
      boundaryHolds.delete(boundary);
    },
  });
}

function requireRun(run: number): Hold {
  if (!enabled || !active || active.run !== run) {
    throw new Error('No matching share-recovery test run.');
  }
  if (Date.now() >= active.deadline && active.phase !== 'released') finish(active, 'expired');
  return active;
}

export function installShareRecoveryTestHook(
  loseSession: (expectedUserID: string) => Promise<void>,
  capturedCleanup?: (pause: (ownerID: string) => Promise<void>) => Promise<void>,
): void {
  if (!enabled) return;
  const control: ShareRecoveryTestControl = Object.freeze({
    boundaries: Object.freeze({
      notifications: boundaryControl('notifications'),
      'prepare-signout': boundaryControl('prepare-signout'),
      'session-loss-recovery': boundaryControl('session-loss-recovery'),
    }),
    arm(timeoutMs = SHARE_RECOVERY_TEST_MAX_HOLD_MS) {
      if (active) throw new Error('Reset the previous share-recovery test run first.');
      const hold: Hold = Object.assign(createHold(timeoutMs), {
        sessionLoss: 'not-requested' as const,
        ownerID: null,
      });
      active = hold;
      return hold.run;
    },
    status() {
      if (!active) return null;
      const hold = requireRun(active.run);
      return { run: hold.run, phase: hold.phase, sessionLoss: hold.sessionLoss };
    },
    async loseSession(run) {
      const hold = requireRun(run);
      if (hold.phase !== 'held' || !hold.ownerID || hold.sessionLoss !== 'not-requested') {
        throw new Error('Session loss requires the exact held upload and may run only once.');
      }
      hold.sessionLoss = 'pending';
      try {
        await Promise.race([
          loseSession(hold.ownerID),
          hold.wait.then(() => { throw new Error('Test hold expired.'); }),
        ]);
        hold.sessionLoss = 'complete';
      } catch {
        hold.sessionLoss = 'failed';
        throw new Error('Share-recovery test session loss failed.');
      }
    },
    startCleanup(run) {
      const hold = requireRun(run);
      if (hold.phase !== 'armed' || !capturedCleanup) {
        throw new Error('Captured cleanup requires a fresh test hold.');
      }
      hold.phase = 'uploading';
      const task = capturedCleanup(async (ownerID) => {
        hold.ownerID = ownerID;
        if (hold.phase === 'uploading') hold.phase = 'held';
        await hold.wait;
      });
      // Observe failures even if the debugger is interrupted before awaiting
      // its saved task. The returned promise still retains the real failure.
      const bounded = Promise.race([
        task,
        hold.wait.then(() => {
          if (hold.phase === 'expired') throw new Error('Captured cleanup test expired.');
          return task;
        }),
      ]);
      void bounded.catch(() => undefined);
      return bounded;
    },
    release(run) {
      const hold = requireRun(run);
      if (hold.phase === 'expired') throw new Error('Share-recovery test hold expired; retain a failed run.');
      if (hold.sessionLoss === 'pending') throw new Error('Session loss has not completed.');
      finish(hold, 'released');
    },
    reset(run) {
      const hold = requireRun(run);
      if (hold.sessionLoss === 'pending') throw new Error('Session loss has not completed.');
      finish(hold, hold.phase === 'expired' ? 'expired' : 'released');
      active = null;
    },
  });
  Object.defineProperty(host, '__unionGroundShareRecoveryTest', {
    configurable: true,
    value: control,
  });
}

/** Capture only the next call at this service boundary; preserve its real result/error. */
export async function withShareRecoveryTestBoundary<T>(
  boundary: ShareRecoveryTestBoundary,
  operation: () => PromiseLike<T>,
): Promise<T> {
  const candidate = enabled ? boundaryHolds.get(boundary) : null;
  const hold = candidate?.phase === 'armed' ? requireBoundaryRun(boundary, candidate.run) : null;
  if (!hold || hold.phase !== 'armed') return operation();
  hold.phase = 'pending';
  try {
    return await operation();
  } finally {
    if (hold.phase === 'pending') hold.phase = 'held';
    await hold.wait;
  }
}

/** Pause after recovery captures its exact scope, before taking the storage lock. */
export function waitForShareRecoveryTestRecovery(): Promise<void> | null {
  if (!enabled || boundaryHolds.get('session-loss-recovery')?.phase !== 'armed') return null;
  return withShareRecoveryTestBoundary('session-loss-recovery', async () => undefined);
}

/** Hold one real transport completion before the existing exact-state guards. */
export async function withShareRecoveryTestHold<T>(
  ownerID: string,
  upload: () => Promise<T>,
): Promise<T> {
  const hold = enabled && active?.phase === 'armed' ? requireRun(active.run) : null;
  if (!hold || hold.phase !== 'armed') return upload();
  hold.ownerID = ownerID;
  hold.phase = 'uploading';
  try {
    return await upload();
  } finally {
    if (hold.phase === 'uploading') hold.phase = 'held';
    await hold.wait;
  }
}
