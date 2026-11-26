import { describe, expect, it, vi } from 'vitest';
import {
  clearPendingReset, loadPendingReset, PENDING_RESET_KEY, RESET_STATE_LIFETIME_MS, savePendingReset, shareBegin,
  type PendingResetStore,
} from './pendingPasswordReset';

vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));

const TICKET = `t1.${'A'.repeat(16)}.${'B'.repeat(64)}`;
const NOW = Date.parse('2026-10-20T15:00:00Z');

function memory(): PendingResetStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    removeItem: async (key) => { values.delete(key); },
  };
}

describe('pending native password reset', () => {
  it('returns the saved step until 15 minutes after begin was sent, then forgets it', async () => {
    const store = memory();
    await savePendingReset({ ticket: TICKET, startedAt: NOW, order: 1, recovery: { status: 'enroll', state: 'sealed', secret: 'JBSWY3DPEHPK3PXP' } }, store);
    expect(await loadPendingReset(store, NOW + RESET_STATE_LIFETIME_MS - 1))
      .toEqual({ ticket: TICKET, status: 'enroll', state: 'sealed', secret: 'JBSWY3DPEHPK3PXP' });
    expect(await loadPendingReset(store, NOW + RESET_STATE_LIFETIME_MS)).toBeNull();
    expect(store.values.has(PENDING_RESET_KEY)).toBe(false);
  });

  it('rejects and removes damaged, foreign or over-long records', async () => {
    const good = { ticket: TICKET, status: 'challenge', state: 'sealed', secret: '', expiresAt: NOW + 1000 };
    for (const bad of [
      'not json', 'null', '7', JSON.stringify({ ...good, status: 'completed' }), JSON.stringify({ ...good, state: '' }),
      JSON.stringify({ ...good, state: 'x'.repeat(16_385) }), JSON.stringify({ ...good, expiresAt: NOW }),
      JSON.stringify({ ...good, secret: 5 }),
      JSON.stringify({ ...good, ticket: undefined }),
    ]) {
      const store = memory();
      store.values.set(PENDING_RESET_KEY, bad);
      expect(await loadPendingReset(store, NOW)).toBeNull();
      expect(store.values.has(PENDING_RESET_KEY)).toBe(false);
    }
  });

  it('keeps a record whose clock was stepped backwards instead of treating it as forged', async () => {
    const store = memory();
    store.values.set(PENDING_RESET_KEY, JSON.stringify({ ticket: TICKET, status: 'challenge', state: 's', secret: '', expiresAt: NOW + RESET_STATE_LIFETIME_MS + 600_000 }));
    expect(await loadPendingReset(store, NOW)).toMatchObject({ state: 's' });
    expect(store.values.has(PENDING_RESET_KEY)).toBe(true);
  });

  it('shares one begin per ticket while it is in flight and starts a fresh one afterwards', async () => {
    let release: (value: string) => void = () => undefined;
    const run = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const first = shareBegin(TICKET, run);
    const second = shareBegin(TICKET, run);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    release('answer');
    expect(await first).toBe('answer');
    expect(await second).toBe('answer');
    run.mockResolvedValueOnce('later');
    expect(await shareBegin(TICKET, run)).toBe('later');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('clears on request and never throws when the keystore fails', async () => {
    const store = memory();
    const recovery = { status: 'challenge' as const, state: 's', secret: '' };
    await savePendingReset({ ticket: TICKET, startedAt: NOW, order: 1, recovery }, store);
    await clearPendingReset('s', store);
    expect(await loadPendingReset(store, NOW)).toBeNull();
    const broken: PendingResetStore = {
      getItem: async () => { throw new Error('locked'); }, setItem: async () => { throw new Error('locked'); },
      removeItem: async () => { throw new Error('locked'); },
    };
    await expect(savePendingReset({ ticket: TICKET, startedAt: NOW, order: 1, recovery }, broken)).resolves.toBeUndefined();
    await expect(loadPendingReset(broken, NOW)).resolves.toBeNull();
    await expect(clearPendingReset('s', broken)).resolves.toBeUndefined();
  });

  it('keeps the newer reset when an old finish clears its own sealed state', async () => {
    const store = memory();
    await savePendingReset({ ticket: TICKET, startedAt: NOW, order: 1, recovery: { status: 'challenge', state: 'old', secret: '' } }, store);
    await savePendingReset({ ticket: 'new-ticket', startedAt: NOW, order: 2, recovery: { status: 'enroll', state: 'new', secret: 'new-key' } }, store);
    await clearPendingReset('old', store);
    expect(await loadPendingReset(store, NOW)).toMatchObject({ ticket: 'new-ticket', state: 'new', secret: 'new-key' });
  });

  it('serializes a pending conditional delete with a later replacement', async () => {
    const store = memory();
    await savePendingReset({ ticket: TICKET, startedAt: NOW, order: 1, recovery: { status: 'challenge', state: 'old', secret: '' } }, store);
    let release: () => void = () => undefined;
    const removing = new Promise<void>((resolve) => { release = resolve; });
    store.removeItem = async (key) => { await removing; store.values.delete(key); };
    const cleared = clearPendingReset('old', store);
    const replacement = savePendingReset({ ticket: 'new-ticket', startedAt: NOW, order: 2, recovery: { status: 'challenge', state: 'new', secret: '' } }, store);
    release();
    await Promise.all([cleared, replacement]);
    expect(await loadPendingReset(store, NOW)).toMatchObject({ state: 'new' });
  });

  it('finishes the first keystore write before starting a later replacement', async () => {
    const store = memory();
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    const firstWrite = new Promise<void>((resolve) => { release = resolve; });
    const setItem = vi.fn(async (key: string, value: string) => {
      if (JSON.parse(value).state === 'old') { entered(); await firstWrite; }
      store.values.set(key, value);
    });
    store.setItem = setItem;
    const old = savePendingReset({ ticket: 'old', startedAt: NOW, order: 1, recovery: { status: 'challenge', state: 'old', secret: '' } }, store);
    await firstEntered;
    const newer = savePendingReset({ ticket: 'new', startedAt: NOW, order: 2, recovery: { status: 'challenge', state: 'new', secret: '' } }, store);
    await Promise.resolve();
    expect(setItem).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([old, newer]);
    expect(await loadPendingReset(store, NOW)).toMatchObject({ state: 'new' });
  });

  it('queues a newer begin until the earlier network response and save complete, even at the same clock time', async () => {
    const store = memory();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    let release: () => void = () => undefined;
    const reply = new Promise<void>((resolve) => { release = resolve; });
    try {
      const older = shareBegin('older-ticket', async (attempt) => {
        await reply;
        await savePendingReset({ ticket: 'older-ticket', ...attempt, recovery: { status: 'enroll', state: 'old', secret: 'old-key' } }, store);
      });
      const newerRun = vi.fn(async (attempt: { startedAt: number; order: number }) => {
        await savePendingReset({ ticket: 'newer-ticket', ...attempt, recovery: { status: 'enroll', state: 'new', secret: 'new-key' } }, store);
      });
      const newer = shareBegin('newer-ticket', newerRun);
      await Promise.resolve();
      expect(newerRun).not.toHaveBeenCalled();
      release();
      await Promise.all([older, newer]);
      expect(await loadPendingReset(store, NOW)).toMatchObject({ ticket: 'newer-ticket', state: 'new', secret: 'new-key' });
    } finally { clock.mockRestore(); }
  });

  it('continues the begin queue after an earlier request fails', async () => {
    const first = shareBegin('failed-ticket', async () => { throw new Error('request failed'); });
    const second = shareBegin('next-ticket', async () => 'next recovery');
    await expect(first).rejects.toThrow('request failed');
    await expect(second).resolves.toBe('next recovery');
  });

  it('does not resurrect an older reply after the newer reset was finished', async () => {
    const store = memory();
    await savePendingReset({ ticket: 'new', startedAt: NOW, order: 2, recovery: { status: 'challenge', state: 'new', secret: '' } }, store);
    await clearPendingReset('new', store);
    await savePendingReset({ ticket: 'old', startedAt: NOW, order: 1, recovery: { status: 'challenge', state: 'old', secret: '' } }, store);
    expect(await loadPendingReset(store, NOW)).toBeNull();
  });
});
