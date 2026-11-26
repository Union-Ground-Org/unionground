import * as SecureStore from 'expo-secure-store';

import { accessTokensShareSessionLineage, sessionIDFromAccessToken } from './sessionLineage';

const chunkSize = 1_800;
const prefix = 'org.unionground.app.secure';

type Manifest = {
  version: 1;
  slot: 'a' | 'b';
  chunks: number;
  length: number;
  highWaterChunks: number;
};

function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
}

function manifestKey(key: string): string {
  return `${prefix}.${safeKey(key)}.manifest`;
}

function highWaterKey(key: string): string {
  return `${prefix}.${safeKey(key)}.highwater`;
}

function dataKey(key: string, slot: 'a' | 'b', index: number): string {
  return `${prefix}.${safeKey(key)}.${slot}.${index}`;
}

async function readHighWater(key: string): Promise<number> {
  const raw = await SecureStore.getItemAsync(highWaterKey(key));
  if (raw === null) return 0;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function readManifest(key: string): Promise<Manifest | null> {
  const raw = await SecureStore.getItemAsync(manifestKey(key));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Manifest>;
    if (parsed.version !== 1 || (parsed.slot !== 'a' && parsed.slot !== 'b')) return null;
    const chunks = parsed.chunks;
    const length = parsed.length;
    if (typeof chunks !== 'number' || !Number.isInteger(chunks) || chunks < 0
      || typeof length !== 'number' || !Number.isInteger(length) || length < 0) return null;
    const highWaterChunks = parsed.highWaterChunks ?? chunks;
    if (typeof highWaterChunks !== 'number'
      || !Number.isInteger(highWaterChunks)
      || highWaterChunks < chunks) return null;
    return { ...parsed, chunks, length, highWaterChunks } as Manifest;
  } catch {
    return null;
  }
}

type ChunkIOResult<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };

async function settleChunkIO<T>(operations: Array<() => Promise<T>>): Promise<T[]> {
  // A failed batch still owns its other native operations. Drain every one
  // before rollback or the next serialized operation can reuse these slots.
  const outcomes: ChunkIOResult<T>[] = await Promise.allSettled(operations.map((operation) => Promise.resolve().then(operation)));
  return outcomes.map((outcome) => {
    if (outcome.status === 'rejected') throw outcome.reason;
    return outcome.value;
  });
}

async function deleteSlot(key: string, slot: 'a' | 'b', chunks: number): Promise<void> {
  await settleChunkIO(
    Array.from({ length: chunks }, (_, index) => () => SecureStore.deleteItemAsync(dataKey(key, slot, index))),
  );
}

async function deleteSlotTail(
  key: string,
  slot: 'a' | 'b',
  from: number,
  to: number,
): Promise<void> {
  if (to <= from) return;
  await settleChunkIO(
    Array.from({ length: to - from }, (_, offset) => () => (
      SecureStore.deleteItemAsync(dataKey(key, slot, from + offset))
    )),
  );
}

export const secureSessionStorage = {
  async getItem(key: string): Promise<string | null> {
    const manifest = await readManifest(key);
    if (!manifest) return null;
    const chunks = await settleChunkIO(
      Array.from({ length: manifest.chunks }, (_, index) => () => SecureStore.getItemAsync(dataKey(key, manifest.slot, index))),
    );
    if (chunks.some((chunk) => chunk === null)) return null;
    const value = chunks.join('');
    return value.length === manifest.length ? value : null;
  },

  async setItem(key: string, value: string): Promise<void> {
    const previous = await readManifest(key);
    const nextSlot = previous?.slot === 'a' ? 'b' : 'a';
    const chunks = value.match(new RegExp(`.{1,${chunkSize}}`, 'gs')) ?? [''];
    const storedHighWater = await readHighWater(key);
    const highWaterChunks = Math.max(storedHighWater, previous?.highWaterChunks ?? 0, chunks.length);
    if (highWaterChunks > storedHighWater) {
      await SecureStore.setItemAsync(highWaterKey(key), String(highWaterChunks));
    }
    await deleteSlotTail(key, nextSlot, chunks.length, highWaterChunks);
    await settleChunkIO(
      chunks.map((chunk, index) => () => SecureStore.setItemAsync(dataKey(key, nextSlot, index), chunk)),
    );
    const manifest: Manifest = {
      version: 1,
      slot: nextSlot,
      chunks: chunks.length,
      length: value.length,
      highWaterChunks,
    };
    await SecureStore.setItemAsync(manifestKey(key), JSON.stringify(manifest));
    if (previous) await deleteSlot(key, previous.slot, previous.highWaterChunks);
  },

  async removeItem(key: string): Promise<void> {
    const previous = await readManifest(key);
    const storedHighWater = await readHighWater(key);
    const highWaterChunks = Math.max(storedHighWater, previous?.highWaterChunks ?? 0);
    await SecureStore.deleteItemAsync(manifestKey(key));
    await settleChunkIO([
      () => deleteSlot(key, 'a', highWaterChunks),
      () => deleteSlot(key, 'b', highWaterChunks),
    ]);
    await SecureStore.deleteItemAsync(highWaterKey(key));
  },
};

type ExpectedSessionTokens = {
  accessToken: string;
  refreshToken: string;
};

function storedSessionID(raw: string): string | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return typeof value.access_token === 'string'
      ? sessionIDFromAccessToken(value.access_token)
      : null;
  } catch {
    return null;
  }
}

function storedSessionMatches(raw: string | null, expected: ExpectedSessionTokens): boolean {
  if (!raw || !expected.accessToken || !expected.refreshToken) return false;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.access_token !== 'string') return false;
    return (value.access_token === expected.accessToken
        && value.refresh_token === expected.refreshToken)
      || accessTokensShareSessionLineage(value.access_token, expected.accessToken);
  } catch {
    return false;
  }
}

/**
 * Supabase persists access and refresh tokens under the configured storage key.
 * Store, preview, and development builds can replace one another while sharing
 * an application ID, so a backend change must invalidate the previous
 * backend's session before Supabase can read or refresh it.
 *
 * The marker is written only after the old session has been removed. A crash
 * between those operations therefore repeats the purge on the next launch
 * instead of exposing a token to a different origin.
 */
export function createBackendScopedSessionStorage(backendOrigin: string, canWriteSession: (raw: string) => boolean = () => true) {
  const preparedKeys = new Set<string>();
  const operationTails = new Map<string, Promise<void>>();
  const revokedSessionIDs = new Set<string>();
  const observedSessionIDs = new Map<string, string>();

  function operationGroup(key: string): string {
    return key.replace(/-(?:code-verifier|user)$/u, '');
  }

  function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const group = operationGroup(key);
    const previous = operationTails.get(group) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    operationTails.set(group, tail);
    void tail.then(() => {
      if (operationTails.get(group) === tail) operationTails.delete(group);
    });
    return result;
  }

  async function prepareUnlocked(key: string): Promise<void> {
    if (preparedKeys.has(key)) return;
    const markerKey = `${key}.backend-origin`;
    try {
      const previousOrigin = await secureSessionStorage.getItem(markerKey);
      if (previousOrigin !== backendOrigin) {
        await secureSessionStorage.removeItem(key);
        await secureSessionStorage.setItem(markerKey, backendOrigin);
      }
      preparedKeys.add(key);
    } catch (error) {
      preparedKeys.delete(key);
      throw error;
    }
  }

  return {
    async getItem(key: string): Promise<string | null> {
      return serialized(key, async () => {
        await prepareUnlocked(key);
        const stored = await secureSessionStorage.getItem(key);
        if (key === operationGroup(key)) {
          const sessionID = stored ? storedSessionID(stored) : null;
          if (sessionID) observedSessionIDs.set(key, sessionID);
          else observedSessionIDs.delete(key);
        }
        return stored;
      });
    },

    async setItem(key: string, value: string): Promise<void> {
      await serialized(key, async () => {
        await prepareUnlocked(key);
        let displacedSessionID: string | null = null;
        let displacedValue: string | null = null;
        if (key === operationGroup(key)) {
          if (!canWriteSession(value)) throw new Error('The sign-in request ended.');
          const sessionID = storedSessionID(value);
          if (sessionID && revokedSessionIDs.has(sessionID)) {
            throw new Error('A closed mobile session cannot replace secure session storage.');
          }
          const displaced = await secureSessionStorage.getItem(key);
          displacedValue = displaced;
          const currentSessionID = displaced ? storedSessionID(displaced) : null;
          if (sessionID && currentSessionID && currentSessionID !== sessionID) {
            displacedSessionID = currentSessionID;
          }
        }
        let writeFailure: { error: unknown } | undefined;
        try {
          await secureSessionStorage.setItem(key, value);
        } catch (error) {
          // The manifest can already be durable when old-slot cleanup fails.
          // Cancellation must still restore the displaced tuple in that case.
          writeFailure = { error };
        }
        if (key === operationGroup(key) && !canWriteSession(value)) {
          // Cancellation can happen while Keychain/Keystore is committing.
          // Stay inside the serializer and restore the previous tuple before
          // rejecting, so Auth never publishes this late SIGNED_IN event.
          if (displacedValue) await secureSessionStorage.setItem(key, displacedValue);
          else await secureSessionStorage.removeItem(key);
          throw new Error('The sign-in request ended.');
        }
        if (writeFailure) throw writeFailure.error;
        // The per-key serializer plus the auth-wide process lock keeps stale
        // work outside this commit boundary. Close the displaced lineage only
        // after the replacement tuple commits, so a failed Keychain write
        // leaves the still-current session usable.
        if (displacedSessionID) revokedSessionIDs.add(displacedSessionID);
      });
    },

    async removeItem(key: string): Promise<void> {
      await serialized(key, async () => {
        await prepareUnlocked(key);
        if (key !== operationGroup(key)) {
          await secureSessionStorage.removeItem(key);
          return;
        }

        const stored = await secureSessionStorage.getItem(key);
        const currentSessionID = stored ? storedSessionID(stored) : null;
        if (!currentSessionID) {
          await secureSessionStorage.removeItem(key);
          observedSessionIDs.delete(key);
          return;
        }

        const observedSessionID = observedSessionIDs.get(key);
        if (!observedSessionID || observedSessionID !== currentSessionID) {
          if (observedSessionID) revokedSessionIDs.add(observedSessionID);
          // Auth-js publishes SIGNED_OUT only after storage removal resolves.
          // Reject stale cleanup so the replacement tuple and UI both remain.
          throw new Error('A stale mobile auth operation cannot remove a newer session lineage.');
        }

        revokedSessionIDs.add(observedSessionID);
        await secureSessionStorage.removeItem(key);
        observedSessionIDs.delete(key);
      });
    },

    async removeSessionIfMatches(key: string, expected: ExpectedSessionTokens): Promise<boolean> {
      return serialized(key, async () => {
        await prepareUnlocked(key);
        const stored = await secureSessionStorage.getItem(key);
        const sessionID = sessionIDFromAccessToken(expected.accessToken);
        if (stored === null && sessionID && expected.refreshToken) {
          // Auth already removed the captured session (a definitive refresh
          // failure does this before the caller's own cleanup runs). A null read
          // can also be an interrupted write or a missing chunk, so delete any
          // residue under this serializer before reporting it cleared; a
          // storage failure throws and stays fail-closed. A late write of that
          // lineage is still refused.
          await secureSessionStorage.removeItem(key);
          revokedSessionIDs.add(sessionID);
          return true;
        }
        if (!storedSessionMatches(stored, expected)) return false;
        if (!sessionID) return false;
        revokedSessionIDs.add(sessionID);
        // Auxiliary PKCE/user slots are not part of the captured session value.
        // A newer login may have written them while A still occupied the main
        // slot, so deleting them here would consume B's in-flight verifier.
        await secureSessionStorage.removeItem(key);
        return true;
      });
    },
  };
}
