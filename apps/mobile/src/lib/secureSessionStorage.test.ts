import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as SecureStore from 'expo-secure-store';

const records = new Map<string, string>();

async function defaultSetItem(key: string, value: string): Promise<void> {
  records.set(key, value);
}

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => records.get(key) ?? null),
  setItemAsync: vi.fn(defaultSetItem),
  deleteItemAsync: vi.fn(async (key: string) => { records.delete(key); }),
}));

import { createBackendScopedSessionStorage, secureSessionStorage } from './secureSessionStorage';

function accessToken(sessionID: string, nonce = 'initial'): string {
  const payload = Buffer.from(JSON.stringify({ session_id: sessionID, nonce })).toString('base64url');
  return `header.${payload}.signature`;
}

describe('secureSessionStorage', () => {
  beforeEach(() => {
    records.clear();
    vi.mocked(SecureStore.setItemAsync).mockImplementation(defaultSetItem);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => { records.delete(key); });
  });

  it('restores a cancelled replacement when cleanup rejects after the manifest commits', async () => {
    let accepted = true;
    const storage = createBackendScopedSessionStorage('https://native.example', () => accepted);
    const previous = JSON.stringify({ access_token: accessToken('11111111-1111-4111-8111-111111111111'), refresh_token: 'old' });
    const cancelled = JSON.stringify({ access_token: accessToken('22222222-2222-4222-8222-222222222222'), refresh_token: 'cancelled' });
    await storage.setItem('auth', previous);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      records.set(key, value);
      if (key.endsWith('.auth.manifest')) accepted = false;
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key.endsWith('.auth.a.0')) throw new Error('previous-slot cleanup failed');
      records.delete(key);
    });

    await expect(storage.setItem('auth', cancelled)).rejects.toThrow();

    // A fresh adapter must not recover the cancelled credentials on relaunch.
    const relaunched = createBackendScopedSessionStorage('https://native.example');
    expect(await relaunched.getItem('auth')).toBe(previous);
    expect([...records.values()]).not.toContain(cancelled);
  });

  it('drains sibling deletes before rewriting the rollback slot', async () => {
    let accepted = true;
    const storage = createBackendScopedSessionStorage('https://native.example', () => accepted);
    const previous = JSON.stringify({ access_token: accessToken('11111111-1111-4111-8111-111111111111'), refresh_token: 'old', pad: 'x'.repeat(2_000) });
    const cancelled = JSON.stringify({ access_token: accessToken('22222222-2222-4222-8222-222222222222'), refresh_token: 'cancelled' });
    await storage.setItem('auth', previous);
    let release!: () => void;
    let began!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { began = resolve; });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      records.set(key, value);
      if (key.endsWith('.auth.manifest')) accepted = false;
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key.endsWith('.auth.a.0')) throw new Error('first delete failed');
      if (key.endsWith('.auth.a.1')) { began(); await pending; }
      records.delete(key);
    });
    let finished = false;
    const result = storage.setItem('auth', cancelled).then(
      () => { finished = true; return null; },
      (error: unknown) => { finished = true; return error; },
    );
    await started;
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    const finishedBeforeDrain = finished;
    release();
    expect(await result).toBeInstanceOf(Error);
    expect(finishedBeforeDrain).toBe(false);
    const relaunched = createBackendScopedSessionStorage('https://native.example');
    expect(await relaunched.getItem('auth')).toBe(previous);
  });

  it('drains sibling writes before rollback reuses their slot', async () => {
    let accepted = true;
    const storage = createBackendScopedSessionStorage('https://native.example', () => accepted);
    const token = accessToken('11111111-1111-4111-8111-111111111111');
    const previous = JSON.stringify({ access_token: token, refresh_token: 'old', pad: 'x'.repeat(2_000) });
    const cancelled = JSON.stringify({ access_token: token, refresh_token: 'new', pad: 'y'.repeat(2_000) });
    await storage.setItem('auth', previous);
    let release!: () => void;
    let began!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { began = resolve; });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key.endsWith('.auth.b.0') && value.includes('"new"')) {
        accepted = false;
        throw new Error('first write failed');
      }
      if (key.endsWith('.auth.b.1') && value.includes('y')) { began(); await pending; }
      records.set(key, value);
    });
    let finished = false;
    const result = storage.setItem('auth', cancelled).then(
      () => { finished = true; return null; },
      (error: unknown) => { finished = true; return error; },
    );
    await started;
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    const finishedBeforeDrain = finished;
    release();
    expect(await result).toBeInstanceOf(Error);
    expect(finishedBeforeDrain).toBe(false);
    const relaunched = createBackendScopedSessionStorage('https://native.example');
    expect(await relaunched.getItem('auth')).toBe(previous);
  });

  it('removes a cancelled first session when the native manifest write commits then rejects', async () => {
    let accepted = true;
    const storage = createBackendScopedSessionStorage('https://native.example', () => accepted);
    await storage.getItem('auth');
    const cancelled = JSON.stringify({ access_token: accessToken('11111111-1111-4111-8111-111111111111'), refresh_token: 'cancelled' });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      records.set(key, value);
      if (key.endsWith('.auth.manifest')) {
        accepted = false;
        throw new Error('native write acknowledgement failed');
      }
    });

    await expect(storage.setItem('auth', cancelled)).rejects.toThrow();

    const relaunched = createBackendScopedSessionStorage('https://native.example');
    expect(await relaunched.getItem('auth')).toBeNull();
    expect([...records.values()]).not.toContain(cancelled);
  });

  it('restores the previous secure tuple if native cancellation races with a storage commit', async () => {
    let accepted = true;
    const storage = createBackendScopedSessionStorage('https://native.example', () => accepted);
    const oldValue = JSON.stringify({ access_token: accessToken('11111111-1111-4111-8111-111111111111'), refresh_token: 'old' });
    const candidate = JSON.stringify({ access_token: accessToken('22222222-2222-4222-8222-222222222222'), refresh_token: 'new' });
    await storage.setItem('auth', oldValue);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      records.set(key, value);
      if (key.endsWith('.manifest') && value.includes('"slot":"b"')) accepted = false;
    });
    await expect(storage.setItem('auth', candidate)).rejects.toThrow('request ended');
    expect(await storage.getItem('auth')).toBe(oldValue);
    accepted = true;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(defaultSetItem);
    await storage.setItem('auth', oldValue);
    expect(await storage.getItem('auth')).toBe(oldValue);
  });

  it('preserves the current tuple and original error for an uncancelled write failure', async () => {
    const storage = createBackendScopedSessionStorage('https://native.example');
    const previous = JSON.stringify({ access_token: accessToken('11111111-1111-4111-8111-111111111111'), refresh_token: 'old' });
    const next = JSON.stringify({ access_token: accessToken('22222222-2222-4222-8222-222222222222'), refresh_token: 'new' });
    await storage.setItem('auth', previous);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key.endsWith('.auth.b.0')) throw new Error('native chunk write failed');
      records.set(key, value);
    });
    await expect(storage.setItem('auth', next)).rejects.toThrow('native chunk write failed');
    expect(await storage.getItem('auth')).toBe(previous);

    vi.mocked(SecureStore.setItemAsync).mockImplementation(defaultSetItem);
    await storage.setItem('auth', next);
    expect(await storage.getItem('auth')).toBe(next);
  });

  it('round-trips a session larger than a single Keychain-safe chunk', async () => {
    const value = 'member-session:'.padEnd(5_400, 'x');
    await secureSessionStorage.setItem('auth/session', value);

    expect(await secureSessionStorage.getItem('auth/session')).toBe(value);
    expect([...records.keys()].filter((key) => key.includes('.a.')).length).toBe(3);
  });

  it('atomically swaps slots and deletes the previous chunks', async () => {
    await secureSessionStorage.setItem('auth/session', 'a'.repeat(4_000));
    await secureSessionStorage.setItem('auth/session', 'new-session');

    expect(await secureSessionStorage.getItem('auth/session')).toBe('new-session');
    expect([...records.keys()].some((key) => key.includes('.a.'))).toBe(false);
    expect([...records.keys()].filter((key) => key.includes('.b.')).length).toBe(1);
  });

  it('fails closed when a committed chunk is missing', async () => {
    await secureSessionStorage.setItem('auth/session', 's'.repeat(2_000));
    records.delete([...records.keys()].find((key) => key.endsWith('.a.1'))!);

    expect(await secureSessionStorage.getItem('auth/session')).toBeNull();
  });

  it('removes the manifest and all committed chunks', async () => {
    await secureSessionStorage.setItem('auth/session', 's'.repeat(4_000));
    await secureSessionStorage.removeItem('auth/session');

    expect(records.size).toBe(0);
    expect(await secureSessionStorage.getItem('auth/session')).toBeNull();
  });

  it('cleans a larger interrupted rewrite after a shorter rewrite and removal', async () => {
    await secureSessionStorage.setItem('auth/session', 'a'.repeat(2_000));
    const manifestKey = [...records.keys()].find((key) => key.endsWith('.manifest'));
    expect(manifestKey).toBeDefined();
    expect(JSON.parse(records.get(manifestKey!) ?? '{}')).toMatchObject({ highWaterChunks: 2 });

    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key: string, value: string) => {
      if (key.endsWith('.manifest')) throw new Error('manifest commit interrupted');
      records.set(key, value);
    });
    await expect(secureSessionStorage.setItem('auth/session', 'b'.repeat(9_000))).rejects.toThrow(
      'manifest commit interrupted',
    );
    expect(await secureSessionStorage.getItem('auth/session')).toBe('a'.repeat(2_000));
    vi.mocked(SecureStore.setItemAsync).mockImplementation(defaultSetItem);

    await secureSessionStorage.setItem('auth/session', 'short');
    expect([...records.keys()].filter((key) => /\.[ab]\.[1-9]\d*$/.test(key))).toEqual([]);

    await secureSessionStorage.removeItem('auth/session');
    expect(records.size).toBe(0);
  });

  it('cleans a larger interrupted first write from a fresh store', async () => {
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key: string, value: string) => {
      if (key.endsWith('.manifest')) throw new Error('manifest commit interrupted');
      records.set(key, value);
    });
    await expect(secureSessionStorage.setItem('auth/session', 'b'.repeat(9_000))).rejects.toThrow(
      'manifest commit interrupted',
    );

    expect(await secureSessionStorage.getItem('auth/session')).toBeNull();
    vi.mocked(SecureStore.setItemAsync).mockImplementation(defaultSetItem);
    await secureSessionStorage.setItem('auth/session', 'short');
    await secureSessionStorage.removeItem('auth/session');

    expect(records.size).toBe(0);
  });

  it('removes a larger interrupted rewrite immediately', async () => {
    await secureSessionStorage.setItem('auth/session', 'a'.repeat(2_000));
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key: string, value: string) => {
      if (key.endsWith('.manifest')) throw new Error('manifest commit interrupted');
      records.set(key, value);
    });
    await expect(secureSessionStorage.setItem('auth/session', 'b'.repeat(9_000))).rejects.toThrow(
      'manifest commit interrupted',
    );

    expect(await secureSessionStorage.getItem('auth/session')).toBe('a'.repeat(2_000));
    await secureSessionStorage.removeItem('auth/session');

    expect(records.size).toBe(0);
  });

  it('purges a legacy unscoped session before the configured backend can read it', async () => {
    await secureSessionStorage.setItem('auth/session', 'legacy-session');
    const scopedStorage = createBackendScopedSessionStorage('https://staging.example');

    expect(await scopedStorage.getItem('auth/session')).toBeNull();
    expect(await secureSessionStorage.getItem('auth/session.backend-origin')).toBe('https://staging.example');
  });

  it('invalidates a session before switching to a different backend origin', async () => {
    const stagingStorage = createBackendScopedSessionStorage('https://staging.example');
    await stagingStorage.setItem('auth/session', 'staging-session');
    expect(await stagingStorage.getItem('auth/session')).toBe('staging-session');

    const productionStorage = createBackendScopedSessionStorage('https://production.example');
    expect(await productionStorage.getItem('auth/session')).toBeNull();
    expect(await secureSessionStorage.getItem('auth/session.backend-origin')).toBe('https://production.example');
  });

  it('does not purge a session when the backend origin is unchanged', async () => {
    const firstLaunch = createBackendScopedSessionStorage('https://production.example');
    await firstLaunch.setItem('auth/session', 'production-session');

    const upgradedLaunch = createBackendScopedSessionStorage('https://production.example');
    expect(await upgradedLaunch.getItem('auth/session')).toBe('production-session');
  });

  it('compare-and-clears only the exact captured session', async () => {
    const storage = createBackendScopedSessionStorage('https://production.example');
    const accessA = accessToken('11111111-1111-4111-8111-111111111111');
    const accessB = accessToken('22222222-2222-4222-8222-222222222222');
    const sessionA = JSON.stringify({ access_token: accessA, refresh_token: 'refresh-a' });
    const sessionB = JSON.stringify({ access_token: accessB, refresh_token: 'refresh-b' });
    await storage.setItem('auth/session', sessionA);

    await expect(storage.removeSessionIfMatches('auth/session', {
      accessToken: accessB,
      refreshToken: 'refresh-b',
    })).resolves.toBe(false);
    expect(await storage.getItem('auth/session')).toBe(sessionA);

    await storage.setItem('auth/session', sessionB);
    await expect(storage.removeSessionIfMatches('auth/session', {
      accessToken: accessA,
      refreshToken: 'refresh-a',
    })).resolves.toBe(false);
    expect(await storage.getItem('auth/session')).toBe(sessionB);

    await expect(storage.removeSessionIfMatches('auth/session', {
      accessToken: accessB,
      refreshToken: 'refresh-b',
    })).resolves.toBe(true);
    expect(await storage.getItem('auth/session')).toBeNull();
  });

  it('reports an already-removed captured session as cleared and refuses its late rewrite (BUG-UG-MOBILE-REVOKED-SESSION-STUCK-20261002)', async () => {
    // Auth removes the persisted session itself after a definitive refresh
    // failure (refresh_token_not_found), before the app's own compare-and-clear.
    const storage = createBackendScopedSessionStorage('https://production.example');
    const accessA = accessToken('11111111-1111-4111-8111-111111111111');
    expect(await storage.getItem('auth/session')).toBeNull();

    await expect(storage.removeSessionIfMatches('auth/session', {
      accessToken: accessA,
      refreshToken: 'refresh-a',
    })).resolves.toBe(true);
    await expect(storage.setItem('auth/session', JSON.stringify({
      access_token: accessToken('11111111-1111-4111-8111-111111111111', 'late'),
      refresh_token: 'refresh-late',
    }))).rejects.toThrow('closed mobile session');
    expect(await storage.getItem('auth/session')).toBeNull();

    await expect(storage.removeSessionIfMatches('auth/session', { accessToken: 'not-a-jwt', refreshToken: 'refresh-a' })).resolves.toBe(false);
  });

  it('deletes interrupted-write residue before reporting a null read as cleared', async () => {
    // A null read is not proof of absence: a write whose manifest never
    // committed leaves its chunks behind. The clear must remove them.
    const storage = createBackendScopedSessionStorage('https://production.example');
    const accessA = accessToken('11111111-1111-4111-8111-111111111111');
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key: string, value: string) => {
      if (key.endsWith('.manifest') && !key.includes('backend-origin')) {
        throw new Error('manifest commit interrupted');
      }
      records.set(key, value);
    });
    await expect(storage.setItem('auth/session', JSON.stringify({ access_token: accessA, refresh_token: 'refresh-a', pad: 'x'.repeat(9_000) })))
      .rejects.toThrow('manifest commit interrupted');
    vi.mocked(SecureStore.setItemAsync).mockImplementation(defaultSetItem);
    const sessionResidue = () => [...records.keys()].filter((key) => !key.includes('backend-origin') && /\.(a|b)\.\d+$|\.highwater$/.test(key));
    expect(await storage.getItem('auth/session')).toBeNull();
    expect(sessionResidue().length).toBeGreaterThan(0);

    await expect(storage.removeSessionIfMatches('auth/session', {
      accessToken: accessA,
      refreshToken: 'refresh-a',
    })).resolves.toBe(true);
    expect(sessionResidue()).toEqual([]);
  });

  it('stays fail-closed when the residue cannot be deleted', async () => {
    const storage = createBackendScopedSessionStorage('https://production.example');
    const accessA = accessToken('11111111-1111-4111-8111-111111111111');
    expect(await storage.getItem('auth/session')).toBeNull();
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error('keychain locked'));
    await expect(storage.removeSessionIfMatches('auth/session', {
      accessToken: accessA,
      refreshToken: 'refresh-a',
    })).rejects.toThrow('keychain locked');
  });

  it('serializes an exact clear before a later replacement session write', async () => {
    const storage = createBackendScopedSessionStorage('https://production.example');
    const accessA = accessToken('11111111-1111-4111-8111-111111111111');
    const accessB = accessToken('22222222-2222-4222-8222-222222222222');
    const sessionA = JSON.stringify({ access_token: accessA, refresh_token: 'refresh-a' });
    const sessionB = JSON.stringify({ access_token: accessB, refresh_token: 'refresh-b' });
    await storage.setItem('auth/session', sessionA);

    const clearA = storage.removeSessionIfMatches('auth/session', {
      accessToken: accessA,
      refreshToken: 'refresh-a',
    });
    const writeB = storage.setItem('auth/session', sessionB);

    await expect(Promise.all([clearA, writeB])).resolves.toEqual([true, undefined]);
    expect(await storage.getItem('auth/session')).toBe(sessionB);
  });

  it('rejects a late refresh write from the session that was exactly cleared', async () => {
    const storage = createBackendScopedSessionStorage('https://production.example');
    const sessionID = '11111111-1111-4111-8111-111111111111';
    const accessA = accessToken(sessionID);
    const refreshedA = accessToken(sessionID, 'refreshed');
    await storage.setItem('auth/session', JSON.stringify({
      access_token: accessA,
      refresh_token: 'refresh-a',
    }));

    await expect(storage.removeSessionIfMatches('auth/session', {
      accessToken: accessA,
      refreshToken: 'refresh-a',
    })).resolves.toBe(true);
    await expect(storage.setItem('auth/session', JSON.stringify({
      access_token: refreshedA,
      refresh_token: 'refresh-a-rotated',
    }))).rejects.toThrow('closed mobile session');
    expect(await storage.getItem('auth/session')).toBeNull();
  });

  it('clears a rotated tuple from the captured session lineage and preserves a new login', async () => {
    const storage = createBackendScopedSessionStorage('https://production.example');
    const userSessionID = '11111111-1111-4111-8111-111111111111';
    const capturedAccess = accessToken(userSessionID, 'captured');
    const rotatedAccess = accessToken(userSessionID, 'rotated');
    const newLoginAccess = accessToken('22222222-2222-4222-8222-222222222222', 'new-login');
    await storage.setItem('auth/session', JSON.stringify({
      access_token: rotatedAccess,
      refresh_token: 'refresh-rotated',
    }));

    await expect(storage.removeSessionIfMatches('auth/session', {
      accessToken: capturedAccess,
      refreshToken: 'refresh-captured',
    })).resolves.toBe(true);
    expect(await storage.getItem('auth/session')).toBeNull();

    await storage.setItem('auth/session', JSON.stringify({
      access_token: newLoginAccess,
      refresh_token: 'refresh-new-login',
    }));
    await expect(storage.removeSessionIfMatches('auth/session', {
      accessToken: capturedAccess,
      refreshToken: 'refresh-captured',
    })).resolves.toBe(false);
    expect(await storage.getItem('auth/session')).toContain('refresh-new-login');
  });

  it('preserves a newer PKCE verifier while clearing the captured main session', async () => {
    const storage = createBackendScopedSessionStorage('https://production.example');
    const accessA = accessToken('11111111-1111-4111-8111-111111111111');
    await storage.setItem('auth/session', JSON.stringify({
      access_token: accessA,
      refresh_token: 'refresh-a',
    }));
    await storage.setItem('auth/session-code-verifier', 'verifier-b');

    await expect(storage.removeSessionIfMatches('auth/session', {
      accessToken: accessA,
      refreshToken: 'refresh-a',
    })).resolves.toBe(true);
    expect(await storage.getItem('auth/session-code-verifier')).toBe('verifier-b');
  });

  it('preserves a replacement when stale auth-js removal resumes', async () => {
    const storage = createBackendScopedSessionStorage('https://production.example');
    const firstSessionID = '11111111-1111-4111-8111-111111111111';
    const firstAccess = accessToken(firstSessionID, 'first');
    const replacementAccess = accessToken(
      '22222222-2222-4222-8222-222222222222',
      'replacement',
    );
    const first = JSON.stringify({
      access_token: firstAccess,
      refresh_token: 'refresh-first',
    });
    const replacement = JSON.stringify({
      access_token: replacementAccess,
      refresh_token: 'refresh-replacement',
    });

    await storage.setItem('auth/session', first);
    expect(await storage.getItem('auth/session')).toBe(first);
    await storage.setItem('auth/session', replacement);

    await expect(storage.removeItem('auth/session'))
      .rejects.toThrow('stale mobile auth operation');

    expect(await storage.getItem('auth/session')).toBe(replacement);
    await expect(storage.setItem('auth/session', JSON.stringify({
      access_token: accessToken(firstSessionID, 'late-refresh'),
      refresh_token: 'refresh-late',
    }))).rejects.toThrow('closed mobile session');
    expect(await storage.getItem('auth/session')).toBe(replacement);
  });

  it('removes the same lineage observed by auth-js', async () => {
    const storage = createBackendScopedSessionStorage('https://production.example');
    const current = JSON.stringify({
      access_token: accessToken('11111111-1111-4111-8111-111111111111'),
      refresh_token: 'refresh-current',
    });

    await storage.setItem('auth/session', current);
    expect(await storage.getItem('auth/session')).toBe(current);
    await storage.removeItem('auth/session');

    expect(await storage.getItem('auth/session')).toBeNull();
  });
});
