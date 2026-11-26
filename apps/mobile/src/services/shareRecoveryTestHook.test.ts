import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShareRecoveryTestBoundary, ShareRecoveryTestControl } from './shareRecoveryTestHook';
import { createClient, PostgrestError, type PostgrestSingleResponse } from '@supabase/supabase-js';

const configuration = vi.hoisted(() => ({
  extra: {
    releaseEnvironment: 'development',
    shareRecoveryTestHook: true,
    supabaseUrl: 'https://unionground-sample.supabase.co',
  },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: configuration } }));
const host = globalThis as typeof globalThis & { __unionGroundShareRecoveryTest?: ShareRecoveryTestControl };

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('__DEV__', true);
  configuration.extra = {
    releaseEnvironment: 'development',
    shareRecoveryTestHook: true,
    supabaseUrl: 'https://unionground-sample.supabase.co',
  };
  delete host.__unionGroundShareRecoveryTest;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete host.__unionGroundShareRecoveryTest;
});

async function install() {
  const module = await import('./shareRecoveryTestHook');
  const loseSession = vi.fn(async () => undefined);
  module.installShareRecoveryTestHook(loseSession);
  return { ...module, loseSession, control: host.__unionGroundShareRecoveryTest! };
}

describe('bounded flow-66 test control', () => {
  it.each(['release-bundle', 'production', 'preview', 'production-backend', 'flag-off'])(
    'cannot enable the control with %s', async (mode) => {
      if (mode === 'release-bundle') vi.stubGlobal('__DEV__', false);
      if (mode === 'production' || mode === 'preview') configuration.extra.releaseEnvironment = mode;
      if (mode === 'production-backend') configuration.extra.supabaseUrl = 'https://unapproved.supabase.co';
      if (mode === 'flag-off') configuration.extra.shareRecoveryTestHook = false;
      const { withShareRecoveryTestHold, loseSession } = await install();
      expect(host.__unionGroundShareRecoveryTest).toBeUndefined();
      await expect(withShareRecoveryTestHold('owner-a', async () => 'real-result')).resolves.toBe('real-result');
      expect(loseSession).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('holds only one completion, reports ordering without private values, and releases the real result', async () => {
    const { control, loseSession, withShareRecoveryTestHold } = await install();
    const run = control.arm();
    let settled = false;
    const result = withShareRecoveryTestHold('owner-a-private', async () => 'attachment-private')
      .then((value) => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(control.status()).toEqual({ run, phase: 'held', sessionLoss: 'not-requested' });
    expect(JSON.stringify(control.status())).not.toMatch(/owner|attachment/);
    await expect(withShareRecoveryTestHold('owner-b', async () => 'new-result')).resolves.toBe('new-result');
    await control.loseSession(run);
    expect(loseSession).toHaveBeenCalledExactlyOnceWith('owner-a-private');
    await expect(control.loseSession(run)).rejects.toThrow(/only once/);
    expect(() => control.release(run + 1)).toThrow(/matching/);
    control.release(run);
    await expect(result).resolves.toBe('attachment-private');
    control.reset(run);
    expect(control.status()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires a held completion and refuses to report a successful release', async () => {
    const { control, withShareRecoveryTestHold } = await install();
    const run = control.arm(1_000);
    const result = withShareRecoveryTestHold('owner-a', async () => 'real-result');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBe('real-result');
    expect(control.status()?.phase).toBe('expired');
    expect(() => control.release(run)).toThrow(/expired/);
    await expect(control.loseSession(run)).rejects.toThrow(/held upload/);
    control.reset(run);
    expect(control.status()).toBeNull();
  });

  it('bounds a stalled session-loss control and permits cleanup after expiry', async () => {
    const module = await import('./shareRecoveryTestHook');
    module.installShareRecoveryTestHook(() => new Promise(() => undefined));
    const control = host.__unionGroundShareRecoveryTest!;
    const run = control.arm(1_000);
    const result = module.withShareRecoveryTestHold('owner-a', async () => 'real-result');
    await Promise.resolve();
    const loss = control.loseSession(run);
    const rejected = expect(loss).rejects.toThrow(/session loss failed/);
    expect(() => control.reset(run)).toThrow(/not completed/);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    await expect(result).resolves.toBe('real-result');
    expect(control.status()).toMatchObject({ phase: 'expired', sessionLoss: 'failed' });
    control.reset(run);
  });

  it('retains the original transport error when reset releases a held failure', async () => {
    const { control, withShareRecoveryTestHold } = await install();
    const run = control.arm();
    const failure = new Error('original failure');
    const result = withShareRecoveryTestHold('owner-a', async () => { throw failure; });
    const rejected = expect(result).rejects.toBe(failure);
    await Promise.resolve();
    control.reset(run);
    await rejected;
  });

  it('refuses unbounded holds, overlapping arms, and session loss before an upload is held', async () => {
    const { control } = await install();
    for (const timeout of [0, 999, 120_001, Infinity, NaN, 1_000.5]) {
      expect(() => control.arm(timeout)).toThrow(/between/);
    }
    const run = control.arm();
    expect(() => control.arm()).toThrow(/previous/);
    await expect(control.loseSession(run)).rejects.toThrow(/held upload/);
    control.reset(run);
    expect(() => control.release(run)).toThrow(/matching/);
  });

  it.each(['release', 'expiry'])(
    'retains captured cleanup until %s and preserves the same expiry discipline', async (ending) => {
      const module = await import('./shareRecoveryTestHook');
      let cleaned = false;
      module.installShareRecoveryTestHook(async () => undefined, async (pause) => {
        await pause('captured-owner');
        cleaned = true;
      });
      const control = host.__unionGroundShareRecoveryTest!;
      const run = control.arm(1_000);
      const cleanup = control.startCleanup(run);
      // The expiry path can reject before cleanup's continuation completes.
      const outcome = cleanup.then(() => 'complete', () => 'expired');
      expect(control.status()).toEqual({ run, phase: 'held', sessionLoss: 'not-requested' });
      expect(cleaned).toBe(false);
      if (ending === 'release') control.release(run);
      else await vi.advanceTimersByTimeAsync(1_000);
      await outcome;
      expect(cleaned).toBe(true);
      expect(control.status()?.phase).toBe(ending === 'release' ? 'released' : 'expired');
      control.reset(run);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

const boundaries: ShareRecoveryTestBoundary[] = ['notifications', 'prepare-signout', 'session-loss-recovery'];

describe.each(boundaries)('bounded %s service control', (boundary) => {
  it('holds exactly the next operation and releases its unchanged private result', async () => {
    const { control, withShareRecoveryTestBoundary } = await install();
    const point = control.boundaries[boundary];
    const run = point.arm();
    let finishRequest: (value: object) => void = () => undefined;
    const response = { privateValue: 'never-in-status' };
    let settled = false;
    const pending = withShareRecoveryTestBoundary(boundary, () => new Promise<object>((resolve) => {
      finishRequest = resolve;
    })).then((value) => { settled = true; return value; });
    expect(point.status()).toEqual({ run, phase: 'pending' });
    await expect(withShareRecoveryTestBoundary(boundary, async () => 'second')).resolves.toBe('second');
    finishRequest(response);
    await Promise.resolve();
    expect(point.status()).toEqual({ run, phase: 'held' });
    expect(settled).toBe(false);
    expect(JSON.stringify(point.status())).not.toContain('never-in-status');
    expect(() => point.release(run + 1)).toThrow(/matching/);
    point.release(run);
    await expect(pending).resolves.toBe(response);
    point.reset(run);
    expect(point.status()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires automatically without turning late completion into a successful run', async () => {
    const { control, withShareRecoveryTestBoundary } = await install();
    const point = control.boundaries[boundary];
    const run = point.arm(1_000);
    const pending = withShareRecoveryTestBoundary(boundary, async () => 'real');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe('real');
    expect(point.status()).toEqual({ run, phase: 'expired' });
    expect(() => point.release(run)).toThrow(/expired/);
    point.reset(run);
    const nextRun = point.arm(1_000);
    let finishRequest: () => void = () => undefined;
    const late = withShareRecoveryTestBoundary(boundary, () => new Promise<void>((resolve) => {
      finishRequest = resolve;
    }));
    await vi.advanceTimersByTimeAsync(1_000);
    finishRequest();
    await late;
    expect(point.status()).toEqual({ run: nextRun, phase: 'expired' });
    point.reset(nextRun);
  });

  it('reset preserves the exact error and a new run cannot be released by the old handle', async () => {
    const { control, withShareRecoveryTestBoundary } = await install();
    const point = control.boundaries[boundary];
    const run = point.arm();
    const failure = new Error('private transport error');
    const pending = withShareRecoveryTestBoundary(boundary, async () => { throw failure; });
    const rejection = expect(pending).rejects.toBe(failure);
    await Promise.resolve();
    point.reset(run);
    await rejection;
    const nextRun = point.arm();
    expect(() => point.release(run)).toThrow(/matching/);
    expect(() => point.arm()).toThrow(/previous/);
    point.reset(nextRun);
    for (const duration of [0, 999, 120_001, Infinity, NaN, 1_000.5]) {
      expect(() => point.arm(duration)).toThrow(/between/);
    }
  });

  it.each(['release', 'production', 'preview', 'real-backend', 'flag-off'])(
    'is disabled in %s configuration', async (mode) => {
      if (mode === 'release') vi.stubGlobal('__DEV__', false);
      if (mode === 'production' || mode === 'preview') configuration.extra.releaseEnvironment = mode;
      if (mode === 'real-backend') configuration.extra.supabaseUrl = 'https://example.test';
      if (mode === 'flag-off') configuration.extra.shareRecoveryTestHook = false;
      const { withShareRecoveryTestBoundary } = await install();
      expect(host.__unionGroundShareRecoveryTest).toBeUndefined();
      await expect(withShareRecoveryTestBoundary(boundary, async () => 'unchanged')).resolves.toBe('unchanged');
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

it('holds the captured sign-out RPC response without dropping status or changing arguments', async () => {
  const { control } = await install();
  const { prepareMySignOut } = await import('./sessionSignOut');
  const client = createClient('https://example.test', 'fictional-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const response: PostgrestSingleResponse<null> = {
    data: null, error: new PostgrestError({ message: 'Bad Gateway', code: '', details: '', hint: '' }),
    count: null, status: 502, statusText: 'Bad Gateway', success: false,
  };
  const rpc = vi.spyOn(client, 'rpc').mockResolvedValue(response);
  const point = control.boundaries['prepare-signout'];
  const run = point.arm();
  const pending = prepareMySignOut(client, 'global', 'captured-user');
  await Promise.resolve();
  expect(rpc).toHaveBeenCalledExactlyOnceWith('prepare_my_signout', {
    p_scope: 'global', p_expected_user_id: 'captured-user',
  });
  expect(point.status()?.phase).toBe('held');
  point.release(run);
  await expect(pending).resolves.toBe(response);
  point.reset(run);
});
