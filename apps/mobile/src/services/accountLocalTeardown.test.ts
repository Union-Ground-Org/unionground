import { describe, expect, it, vi } from 'vitest';
import { createAccountLocalTeardown } from './accountLocalTeardown';

function fixture() {
  let ledger: string | null = null;
  const clearPush = vi.fn(async () => undefined);
  const purgeCaptures = vi.fn(async () => undefined);
  const dependencies = { readPending: async () => ledger, writePending: async (value: string) => { ledger = value; }, clearPush, purgeCaptures };
  return { dependencies, clearPush, purgeCaptures, ledger: () => ledger };
}

describe('account-local teardown and retained retries', () => {
  it('clears both account stores and consumes its retry marker', async () => {
    const f = fixture();
    expect(await createAccountLocalTeardown(f.dependencies).request('departing', () => true)).toBe(true);
    expect(f.clearPush).toHaveBeenCalledWith('departing', expect.any(Function));
    expect(f.purgeCaptures).toHaveBeenCalledWith('departing', expect.any(Function));
    expect(f.ledger()).toBe('[]');
  });
  it('retains a failed account across campaign lead restart and retries both stores', async () => {
    const f = fixture();
    f.purgeCaptures.mockRejectedValueOnce(new Error('keychain unavailable'));
    expect(await createAccountLocalTeardown(f.dependencies).request('departing', () => true)).toBe(false);
    expect(JSON.parse(f.ledger()!)).toEqual(['departing']);
    expect(await createAccountLocalTeardown(f.dependencies).retry(() => true)).toBe(true);
    expect(f.clearPush).toHaveBeenCalledTimes(2);
    expect(f.purgeCaptures).toHaveBeenCalledTimes(2);
    expect(f.ledger()).toBe('[]');
  });
  it('tries captures even when push cleanup fails, without crediting success', async () => {
    const f = fixture(); f.clearPush.mockRejectedValueOnce(new Error('push owner read failed'));
    expect(await createAccountLocalTeardown(f.dependencies).request('departing', () => true)).toBe(false);
    expect(f.purgeCaptures).toHaveBeenCalledOnce();
    expect(JSON.parse(f.ledger()!)).toEqual(['departing']);
  });
  it('does not touch replacement captures after ownership changes mid-push cleanup', async () => {
    const f = fixture(); let current = true;
    f.clearPush.mockImplementation(async () => { current = false; });
    expect(await createAccountLocalTeardown(f.dependencies).request('departing', () => current)).toBe(false);
    expect(f.purgeCaptures).not.toHaveBeenCalled();
    expect(await createAccountLocalTeardown(f.dependencies).retry(() => false)).toBe(false);
    expect(f.clearPush).toHaveBeenCalledOnce();
  });
  it('does not clear either store if the session changed while the ledger was read', async () => {
    const f = fixture(); let current = true;
    f.dependencies.readPending = async () => { current = false; return null; };
    expect(await createAccountLocalTeardown(f.dependencies).request('departing', () => current)).toBe(false);
    expect(f.clearPush).not.toHaveBeenCalled(); expect(f.purgeCaptures).not.toHaveBeenCalled();
  });
  it('does not call a completed precommit push step twice on explicit sign-out', async () => {
    const f = fixture();
    expect(await createAccountLocalTeardown(f.dependencies).request('departing', () => true, { pushAlreadyCleared: true })).toBe(true);
    expect(f.clearPush).not.toHaveBeenCalled(); expect(f.purgeCaptures).toHaveBeenCalledOnce();
  });
  it('refuses a corrupt retry ledger rather than purging an inferred account', async () => {
    const f = fixture(); f.dependencies.readPending = async () => '{broken';
    expect(await createAccountLocalTeardown(f.dependencies).retry(() => true)).toBe(false);
    expect(f.clearPush).not.toHaveBeenCalled(); expect(f.purgeCaptures).not.toHaveBeenCalled();
  });
  it('keeps unreadable retained bytes intact while trying only the known departing account', async () => {
    const f = fixture();
    const write = vi.fn(async () => undefined);
    f.dependencies.readPending = async () => '{unreadable'; f.dependencies.writePending = write;
    expect(await createAccountLocalTeardown(f.dependencies).request('departing', () => true)).toBe(false);
    expect(f.purgeCaptures).toHaveBeenCalledWith('departing', expect.any(Function));
    expect(write).not.toHaveBeenCalled();
  });

});
