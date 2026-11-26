import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createForegroundSessionRevocationWatch,
  SESSION_REVOCATION_CHECK_INTERVAL_MS,
  SESSION_REVOCATION_CHECK_TIMEOUT_MS,
  SIGNED_OUT_ELSEWHERE_NOTICE,
} from './foregroundSessionRevocationWatch';

// BUG-UG-NATIVE-SIGN-OUT-EVERYWHERE-NOT-NOTICED-IN-FOREGROUND-20261103.
const session = { id: 'captured-session' };

function watchWith(isGone: (captured: typeof session) => Promise<boolean>) {
  const probe = vi.fn(isGone);
  const onRevoked = vi.fn();
  const watch = createForegroundSessionRevocationWatch(session, { isGone: probe, onRevoked });
  return { watch, probe, onRevoked };
}

describe('foreground session revocation watch', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('checks the exact session every interval only while started, and hands a proven absence over once', async () => {
    let gone = false;
    const { watch, probe, onRevoked } = watchWith(async () => gone);
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS * 3);
    expect(probe).not.toHaveBeenCalled();

    watch.start();
    // A return to the foreground already runs the full resume: no check at once.
    expect(probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenLastCalledWith(session);
    expect(onRevoked).not.toHaveBeenCalled();

    gone = true;
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(onRevoked).toHaveBeenCalledWith(session);

    // The watch is done: neither the timer nor a restart asks again.
    watch.start();
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS * 4);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(onRevoked).toHaveBeenCalledTimes(1);
    await expect(watch.check()).resolves.toBe(false);
  });

  it('notices a revocation within one interval of it', async () => {
    let gone = false;
    const { watch, onRevoked } = watchWith(async () => gone);
    watch.start();
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS + 1_000);
    gone = true;
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS - 1_000);
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(SESSION_REVOCATION_CHECK_INTERVAL_MS + SESSION_REVOCATION_CHECK_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it('pauses in the background and resumes its cadence on return', async () => {
    const { watch, probe } = watchWith(async () => false);
    watch.start();
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(1);
    watch.stop();
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS * 5);
    expect(probe).toHaveBeenCalledTimes(1);
    await expect(watch.check()).resolves.toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
    watch.start();
    watch.start();
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a live session', async () => false],
    ['a probe that rejects', async () => { throw new Error('network'); }],
    ['a probe that throws', (): Promise<boolean> => { throw new Error('sync'); }],
  ])('leaves the session alone on %s', async (_label, isGone) => {
    const { watch, probe, onRevoked } = watchWith(isGone);
    watch.start();
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS * 3);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('gives up on a probe that never answers and keeps checking', async () => {
    const answers: Array<(gone: boolean) => void> = [];
    const { watch, probe, onRevoked } = watchWith(() => new Promise<boolean>((resolve) => { answers.push(resolve); }));
    watch.start();
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(1);
    // One check at a time: a tick while the probe is pending starts none.
    await expect(watch.check()).resolves.toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    // The abandoned probe's late proof is not acted on.
    answers[0]!(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('drops a proof that arrives after a background or session change', async () => {
    let answer: ((gone: boolean) => void) | null = null;
    const { watch, onRevoked } = watchWith(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    watch.start();
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS);
    watch.stop();
    answer!(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('uses the web app copy for the notice', () => {
    expect(SIGNED_OUT_ELSEWHERE_NOTICE).toBe('You were signed out on this device. Sign in again to continue.');
  });
});
