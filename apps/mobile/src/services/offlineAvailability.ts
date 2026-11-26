// REQ-UG-NATIVE-LOW-DATA-OFFLINE-20260928, offline availability storage.
//
// Encrypted, bounded, per-account and per-organization personal learning
// notes. Public learning downloads use their separate account-free service.
// The schema and retention arithmetic live in
// `src/lib/offlineAvailability.ts`; this file owns the keychain, the
// serialization queue, and the lifecycle contract below.
//
// Storage model. Every value is written through Expo SecureStore with
// WHEN_UNLOCKED_THIS_DEVICE_ONLY on iOS (unlocked access, no migration to a
// different device). Android uses Keystore-backed encryption and the app
// suspends access on its protected-session lock boundary.
// There is no unencrypted fallback anywhere: where SecureStore is missing —
// web above all — every entry point fails with an `unavailable` error rather
// than writing plaintext.
//
// Durability. A record is chunked in conservative 1600-byte values and
// written to whichever of two slots is not live, verified by reading it back,
// and only then published by overwriting a small manifest. An interrupted
// write therefore leaves the previous record intact and readable: the manifest
// is the single commit point.
//
// Lifecycle contract for the caller:
//
//   activateOfflineScope(scope) on sign-in and on every account or
//   organization change. It invalidates synchronously — work already queued
//   for the previous scope fails with `stale` instead of landing after the
//   switch — and returns a promise for the asynchronous purge of the previous
//   scope's storage. Await it when the caller needs the purge to have
//   finished; its rejection means the previous scope's data may still exist.
//
//   suspendOfflineAvailability() the moment protected state is torn down. It
//   invalidates synchronously without deleting anything and without touching
//   the keychain, which makes it safe on a lock or a lost session.
//
//   purgeOfflineAvailability() on sign-out. It is global: every scope this
//   device has stored is removed, not just the active one.
//
// Activation is mandatory and follows a fresh RLS-scoped read. A cold start,
// suspended session or failed activation cannot read or write any private note.

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import {
  OFFLINE_LIMITS,
  OFFLINE_STORAGE_PREFIX,
  OfflineAvailabilityError,
  applyOfflineDraftDelete,
  applyOfflineDraftSave,
  asciiJSON,
  emptyOfflineRecord,
  emptyOfflineSnapshot,
  offlineScopeKey,
  offlineSnapshot,
  parseOfflineRecord,
  payloadChecksum,
  pruneOfflineRecord,
  sameOfflineScope,
  serializeOfflineRecord,
  validateOfflineScope,
  type OfflineAvailabilityErrorCode,
  type OfflineAvailabilitySnapshot,
  type OfflineDraft,
  type OfflineDraftInput,
  type OfflineScope,
  type PersistedOfflineRecord,
} from '../lib/offlineAvailability';

export {
  OFFLINE_LIMITS,
  OfflineAvailabilityError,
  type OfflineAvailabilityErrorCode,
  type OfflineAvailabilitySnapshot,
  type OfflineDraft,
  type OfflineDraftInput,
  type OfflineScope,
} from '../lib/offlineAvailability';

// ASCII payload characters per chunk. The library encodes the record as ASCII
// so one character is one stored byte, which keeps every value under the
// historical 2048-byte SecureStore value constraint on some platforms.
const CHUNK_CHARS = 1_600;
const MAX_CHUNKS = Math.ceil(OFFLINE_LIMITS.maxTotalBytes / CHUNK_CHARS) + 1;
// Scopes whose storage this device tracks, so sign-out can find and remove
// every one of them. SecureStore cannot enumerate its own keys.
const MAX_TRACKED_SCOPES = 4;
const AUTHORIZATION_KEY = `${OFFLINE_STORAGE_PREFIX}.authorization`;
const REGISTRY_KEY = `${OFFLINE_STORAGE_PREFIX}.scopes`;

type StorageSlot = 'a' | 'b';

type StoredManifest = {
  version: 1;
  slot: StorageSlot;
  chunks: number;
  length: number;
  checksum: string;
  // Monotonic: the largest chunk count this scope has ever written, so a
  // later, shorter record can clear the tail an earlier one left behind.
  highWaterChunks: number;
};

type ScopeRegistryEntry = {
  key: string;
  lastUsedAt: number;
};

type ScopeRegistry = {
  version: 1;
  scopes: ScopeRegistryEntry[];
};

type ScopedContext = {
  readonly scope: OfflineScope;
  readonly record: PersistedOfflineRecord;
  readonly storedRecord: PersistedOfflineRecord | null;
  readonly now: number;
  commit(next: PersistedOfflineRecord): Promise<void>;
  discard(): Promise<void>;
};

export type OfflineDraftSaveResult = {
  draft: OfflineDraft;
  snapshot: OfflineAvailabilitySnapshot;
};

function fail(code: OfflineAvailabilityErrorCode, message: string): never {
  throw new OfflineAvailabilityError(code, message);
}

// ---------------------------------------------------------------------------
// Process state: one queue, one generation counter, one activated scope.
// ---------------------------------------------------------------------------

let operationQueue: Promise<unknown> = Promise.resolve();
let generation = 0;
let activeScope: OfflineScope | null = null;
let activeAuthorization: string | null = null;
let storageConfirmed = false;

/**
 * Every entry point runs through here, so no two operations interleave their
 * read-modify-write against the same keychain records, and a purge queued
 * behind a write always observes that write's result rather than racing it.
 */
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Bumped synchronously by anything that invalidates outstanding work: a purge,
 * or a change of active scope. An operation captures the counter when it is
 * called and re-checks it after the queue wait and again after its write, so a
 * write begun before a purge cannot resurrect the record after it.
 */
function requireGeneration(captured: number): void {
  if (captured !== generation) {
    fail('stale', 'Signing out or changing account interrupted that. It was not kept on this phone.');
  }
}

function requireActiveScope(scope: OfflineScope): void {
  if (!activeScope || !sameOfflineScope(activeScope, scope)) {
    fail('scope', 'That account is no longer the one signed in on this phone.');
  }
}

function writeOptions(): SecureStore.SecureStoreOptions {
  return { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
}

async function secureStorageAvailable(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  if (storageConfirmed) return true;
  let available = false;
  try {
    available = await SecureStore.isAvailableAsync();
  } catch {
    available = false;
  }
  // Only a positive answer is cached: a device that reports unavailable once
  // may recover, and caching that would strand the feature for the session.
  if (available) storageConfirmed = true;
  return available;
}

/**
 * The refusal that keeps this feature honest on web and on any device without
 * encrypted storage. There is no plaintext path to fall back to.
 */
async function requireSecureStorage(): Promise<void> {
  if (!await secureStorageAvailable()) {
    fail(
      'unavailable',
      'Offline availability needs this phone’s encrypted storage, which is not available here.',
    );
  }
}

// ---------------------------------------------------------------------------
// Chunked, checksummed, two-slot record storage.
// ---------------------------------------------------------------------------

function manifestKey(base: string): string {
  return `${base}.manifest`;
}

function chunkKey(base: string, slot: StorageSlot, index: number): string {
  return `${base}.${slot}.${index}`;
}

function splitChunks(payload: string): string[] {
  if (payload.length === 0) return [''];
  const chunks: string[] = [];
  for (let offset = 0; offset < payload.length; offset += CHUNK_CHARS) {
    chunks.push(payload.slice(offset, offset + CHUNK_CHARS));
  }
  return chunks;
}

function boundedCount(value: unknown, limit: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= limit ? value : null;
}

async function readManifest(base: string): Promise<StoredManifest | null> {
  const raw = await SecureStore.getItemAsync(manifestKey(base));
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const manifest: Partial<StoredManifest> = parsed as Partial<StoredManifest>;
  if (manifest.version !== 1 || (manifest.slot !== 'a' && manifest.slot !== 'b')) return null;
  const chunks = boundedCount(manifest.chunks, MAX_CHUNKS);
  const length = boundedCount(manifest.length, OFFLINE_LIMITS.maxTotalBytes);
  const highWaterChunks = boundedCount(manifest.highWaterChunks, MAX_CHUNKS);
  if (chunks === null || length === null || highWaterChunks === null || highWaterChunks < chunks) return null;
  if (typeof manifest.checksum !== 'string' || manifest.checksum.length === 0) return null;
  return {
    version: 1,
    slot: manifest.slot,
    chunks,
    length,
    checksum: manifest.checksum,
    highWaterChunks,
  };
}

async function readChunks(base: string, slot: StorageSlot, count: number): Promise<string | null> {
  const parts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const chunk = await SecureStore.getItemAsync(chunkKey(base, slot, index));
    if (chunk === null) return null;
    parts.push(chunk);
  }
  return parts.join('');
}

/**
 * Reads the live record. Any inconsistency — a missing chunk, a length that
 * disagrees with the manifest, a checksum that does not match, an envelope for
 * a different scope — reads as "nothing stored" rather than as partial data.
 */
async function readStoredRecord(
  scope: OfflineScope,
  base: string,
): Promise<PersistedOfflineRecord | null> {
  const manifest = await readManifest(base);
  if (!manifest) return null;
  const payload = await readChunks(base, manifest.slot, manifest.chunks);
  if (payload === null) return null;
  if (payload.length !== manifest.length) return null;
  if (payloadChecksum(payload) !== manifest.checksum) return null;
  return parseOfflineRecord(payload, scope);
}

async function deleteChunkRange(
  base: string,
  slot: StorageSlot,
  from: number,
  to: number,
): Promise<void> {
  for (let index = from; index < to; index += 1) {
    await SecureStore.deleteItemAsync(chunkKey(base, slot, index));
  }
}

/**
 * Commits a record.
 *
 * The inactive slot is written and read back before the manifest is
 * overwritten, so the manifest flip is the only moment the visible record
 * changes. A failure before that point leaves the previous record live and is
 * reported as such; a failure while confirming the manifest itself is reported
 * without claiming the change was discarded, because at that point it may have
 * landed.
 */
async function writeStoredRecord(base: string, record: PersistedOfflineRecord): Promise<void> {
  const payload = serializeOfflineRecord(record);
  if (payload.length > OFFLINE_LIMITS.maxTotalBytes) {
    fail('limit', 'This phone has no room left for offline items.');
  }
  const chunks = splitChunks(payload);
  if (chunks.length > MAX_CHUNKS) {
    fail('limit', 'This phone has no room left for offline items.');
  }

  const previous = await readManifest(base);
  const slot: StorageSlot = previous?.slot === 'a' ? 'b' : 'a';
  const highWaterChunks = Math.min(
    MAX_CHUNKS,
    Math.max(previous?.highWaterChunks ?? 0, chunks.length),
  );
  const manifest: StoredManifest = {
    version: 1,
    slot,
    chunks: chunks.length,
    length: payload.length,
    checksum: payloadChecksum(payload),
    highWaterChunks,
  };
  const manifestPayload = asciiJSON(manifest);

  let published = false;
  try {
    // Clear anything a longer earlier record left in this slot first, so the
    // slot can never read back as a splice of two generations.
    await deleteChunkRange(base, slot, chunks.length, highWaterChunks);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? '';
      await SecureStore.setItemAsync(chunkKey(base, slot, index), chunk, writeOptions());
    }
    if (await readChunks(base, slot, chunks.length) !== payload) {
      throw new Error('offline record did not round-trip');
    }
    published = true;
    await SecureStore.setItemAsync(manifestKey(base), manifestPayload, writeOptions());
    if (await SecureStore.getItemAsync(manifestKey(base)) !== manifestPayload) {
      throw new Error('offline manifest did not round-trip');
    }
  } catch (error) {
    if (error instanceof OfflineAvailabilityError) throw error;
    fail(
      'storage',
      published
        ? 'This phone could not confirm that was saved. Check your offline items before relying on them.'
        : 'This phone could not save that securely. Nothing was changed.',
    );
  }

  if (previous && previous.slot !== slot) {
    // Best effort: the old slot is unreachable once the manifest points away
    // from it, and a later write or purge clears whatever survives here.
    try {
      await deleteChunkRange(base, previous.slot, 0, previous.highWaterChunks);
    } catch {
      // Intentionally ignored; see above.
    }
  }
}

/**
 * Removes a scope's storage. The manifest goes first, so an interruption
 * leaves unreadable residue rather than a readable record.
 */
async function deleteStoredScope(base: string): Promise<void> {
  // Failed longer writes can leave chunks beyond the published manifest.
  // Delete the entire fixed key range, including unpublished residue.
  await SecureStore.deleteItemAsync(manifestKey(base));
  await deleteChunkRange(base, 'a', 0, MAX_CHUNKS);
  await deleteChunkRange(base, 'b', 0, MAX_CHUNKS);
}

// ---------------------------------------------------------------------------
// Scope registry: the only way sign-out can find every scope on the device.
// ---------------------------------------------------------------------------

function emptyRegistry(): ScopeRegistry {
  return { version: 1, scopes: [] };
}

async function readRegistry(): Promise<ScopeRegistry> {
  let raw: string | null;
  try { raw = await SecureStore.getItemAsync(REGISTRY_KEY); }
  catch { fail('storage', 'This phone could not read the offline cleanup index. Try again after unlocking it.'); }
  if (raw === null) return emptyRegistry();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { fail('storage', 'The offline cleanup index is damaged. Offline notes remain locked.'); }
  if (!parsed || typeof parsed !== 'object') fail('storage', 'The offline cleanup index is damaged.');
  const registry = parsed as Partial<ScopeRegistry>;
  if (registry.version !== 1 || !Array.isArray(registry.scopes) || registry.scopes.length > MAX_TRACKED_SCOPES) {
    fail('storage', 'The offline cleanup index is damaged.');
  }
  const scopes: ScopeRegistryEntry[] = [];
  for (const candidate of registry.scopes as unknown[]) {
    if (!candidate || typeof candidate !== 'object') fail('storage', 'The offline cleanup index is damaged.');
    const entry = candidate as Record<string, unknown>;
    if (typeof entry.key !== 'string' || !entry.key.startsWith(`${OFFLINE_STORAGE_PREFIX}.`)
      || !/^a-[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.o-[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.key.slice(OFFLINE_STORAGE_PREFIX.length + 1))
      || typeof entry.lastUsedAt !== 'number' || !Number.isFinite(entry.lastUsedAt)) {
      fail('storage', 'The offline cleanup index is damaged.');
    }
    scopes.push({ key: entry.key, lastUsedAt: entry.lastUsedAt });
  }
  if (scopes.length !== registry.scopes.length || new Set(scopes.map((entry) => entry.key)).size !== scopes.length) {
    fail('storage', 'The offline cleanup index is damaged.');
  }
  return { version: 1, scopes };
}

async function writeRegistry(registry: ScopeRegistry): Promise<void> {
  if (registry.scopes.length === 0) {
    await SecureStore.deleteItemAsync(REGISTRY_KEY);
    return;
  }
  const payload = asciiJSON(registry);
  await SecureStore.setItemAsync(REGISTRY_KEY, payload, writeOptions());
  if (await SecureStore.getItemAsync(REGISTRY_KEY) !== payload) {
    fail('storage', 'This phone could not keep the offline cleanup index. Nothing was saved.');
  }
}

/**
 * Records that this scope has storage, before that storage is written, and
 * evicts the least recently used scope beyond the tracked maximum. The evicted
 * scope's data is deleted first: a crash between the two steps leaves the
 * registry naming an empty scope, which is harmless, rather than leaving data
 * nothing can find.
 */
async function registerScope(base: string, now: number): Promise<void> {
  const registry = await readRegistry();
  const ordered = [
    { key: base, lastUsedAt: now },
    ...registry.scopes.filter((entry) => entry.key !== base),
  ].sort((left, right) => right.lastUsedAt - left.lastUsedAt);
  const kept = ordered.slice(0, MAX_TRACKED_SCOPES);
  for (const entry of ordered.slice(MAX_TRACKED_SCOPES)) {
    await deleteStoredScope(entry.key);
  }
  await writeRegistry({ version: 1, scopes: kept });
}

async function deregisterScope(base: string): Promise<void> {
  const registry = await readRegistry();
  const scopes = registry.scopes.filter((entry) => entry.key !== base);
  if (scopes.length === registry.scopes.length) return;
  await writeRegistry({ version: 1, scopes });
}

// ---------------------------------------------------------------------------
// Entry points.
// ---------------------------------------------------------------------------

/**
 * Shared shape for every scoped operation: validate the scope, take the queue,
 * re-read and prune what is actually persisted, then run the caller's body
 * against that. Persisted state is never cached between operations, so an
 * expiry or an external change is observed on every call.
 */
function runScoped<T>(
  scope: OfflineScope,
  body: (context: ScopedContext) => Promise<T>,
): Promise<T> {
  // Scope validation and the generation capture happen before the queue wait,
  // but every entry point reports failure the same way: a rejected promise,
  // never a synchronous throw.
  let validated: OfflineScope;
  let captured: number;
  try {
    validated = validateOfflineScope(scope);
    requireActiveScope(validated);
    captured = generation;
  } catch (error) {
    return Promise.reject(error);
  }

  return serialize(async () => {
    requireGeneration(captured);
    await requireSecureStorage();
    requireGeneration(captured);

    const base = offlineScopeKey(validated);
    const storedRecord = await readStoredRecord(validated, base);
    requireGeneration(captured);
    requireActiveScope(validated);
    const now = Date.now();
    const record = pruneOfflineRecord(storedRecord ?? emptyOfflineRecord(validated), now);

    const result = await body({
      scope: validated,
      record,
      storedRecord,
      now,
      async commit(next: PersistedOfflineRecord): Promise<void> {
        requireGeneration(captured);
        await registerScope(base, now);
        await writeStoredRecord(base, next);
        if (captured === generation) return;

        // A purge, an account change, or a suspend began while this was
        // writing. The write is void, so put back exactly what was live
        // before it rather than leaving it as the visible record: a sign-out
        // purge would have cleaned up behind this, but a suspend does not
        // delete anything, and the guarantee has to hold for both.
        try {
          if (storedRecord) await writeStoredRecord(base, storedRecord);
          else {
            await deleteStoredScope(base);
            await deregisterScope(base);
          }
        } catch {
          fail(
            'stale',
            'Signing out or changing account interrupted that, and this phone could not undo it. Check your offline items.',
          );
        }
        requireGeneration(captured);
      },
      async discard(): Promise<void> {
        requireGeneration(captured);
        await deleteStoredScope(base);
        await deregisterScope(base);
      },
    });
    requireGeneration(captured);
    requireActiveScope(validated);
    return result;
  });
}

/**
 * Current offline state for a scope. Expired notes are removed
 * from storage here rather than merely hidden; if that removal fails the
 * pruned view is still returned and the next operation retries it.
 */
export function readOfflineAvailability(scope: OfflineScope): Promise<OfflineAvailabilitySnapshot> {
  return runScoped(scope, async ({ record, storedRecord, commit, discard }) => {
    if (storedRecord && serializeOfflineRecord(storedRecord) !== serializeOfflineRecord(record)) {
      const settle = record.enabled ? commit(record) : discard();
      await settle.catch(() => undefined);
    }
    return offlineSnapshot(record);
  });
}

/**
 * Offline availability is opt-in. Turning it off is a purge, not a pause: the
 * notes for that scope leave the phone immediately.
 */
export function setOfflineAvailability(
  scope: OfflineScope,
  enabled: boolean,
): Promise<OfflineAvailabilitySnapshot> {
  return runScoped(scope, async ({ record, commit, discard }) => {
    if (!enabled) {
      await discard();
      return emptyOfflineSnapshot();
    }
    const next: PersistedOfflineRecord = { ...record, enabled: true };
    await commit(next);
    return offlineSnapshot(next);
  });
}

/**
 * Creates or edits a personal learning note. Notes stay on this phone: nothing
 * here uploads, so another device holding the member's notes is independent
 * and no server record can be overwritten from here.
 */
export function saveOfflineLearningDraft(
  scope: OfflineScope,
  input: OfflineDraftInput,
): Promise<OfflineDraftSaveResult> {
  return runScoped(scope, async ({ record, now, commit }) => {
    const saved = applyOfflineDraftSave(record, input, now, () => Crypto.randomUUID());
    await commit(saved.record);
    return { draft: saved.draft, snapshot: offlineSnapshot(saved.record) };
  });
}

/** Idempotent: deleting a note that already expired or is already gone is not an error. */
export function deleteOfflineLearningDraft(
  scope: OfflineScope,
  id: string,
): Promise<OfflineAvailabilitySnapshot> {
  return runScoped(scope, async ({ record, commit }) => {
    if (!record.enabled) return emptyOfflineSnapshot();
    const next = applyOfflineDraftDelete(record, id);
    await commit(next);
    return offlineSnapshot(next);
  });
}

/**
 * Declares which scope the app is signed in to.
 *
 * Invalidation is synchronous: by the time this returns, every operation
 * already queued for the previous scope will fail with `stale` rather than
 * commit. The returned promise resolves once the previous scope's storage has
 * been purged; it rejects if that purge failed, which means the previous
 * account's notes may still be on the phone.
 *
 * Any change of account or of organization purges. Two organizations under one
 * account therefore do not keep separate offline sets across a switch; the
 * isolation is per scope, but the retention is not.
 *
 * Re-activating the scope that is already active does nothing and does not
 * disturb work in flight.
 */
export function activateOfflineScope(scope: OfflineScope | null, authorizationID?: string): Promise<void> {
  if (scope === null) {
    // An unavailable authorization result locks notes; it is not a deletion.
    suspendOfflineAvailability();
    return Promise.resolve();
  }
  if (typeof authorizationID !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(authorizationID)) {
    return Promise.reject(new OfflineAvailabilityError('scope', 'A fresh authorized session is required for notes.'));
  }
  let next: OfflineScope;
  try {
    next = validateOfflineScope(scope);
  } catch (error) {
    return Promise.reject(error);
  }
  if (sameOfflineScope(activeScope, next) && activeAuthorization === authorizationID) return Promise.resolve();

  const captured = ++generation;
  activeScope = null;
  return serialize(async () => {
    requireGeneration(captured);
    await requireSecureStorage();
    const retainedKey = offlineScopeKey(next);
    const registry = await readRegistry();
    const priorAuthorization = await SecureStore.getItemAsync(AUTHORIZATION_KEY);
    // A new server session must never recover notes whose sign-out purge failed.
    // Persist only the non-secret session ID, never its access or refresh token.
    // Inspect persisted scopes even after a cold launch or suspend. In-memory
    // scope state cannot prove that a previous account was successfully purged.
    for (const entry of registry.scopes) {
      if (entry.key !== retainedKey || priorAuthorization !== authorizationID) await deleteStoredScope(entry.key);
    }
    const retained = registry.scopes.filter((entry) => entry.key === retainedKey && priorAuthorization === authorizationID);
    if (retained.length !== registry.scopes.length) {
      await writeRegistry({ version: 1, scopes: retained });
    }
    await SecureStore.setItemAsync(AUTHORIZATION_KEY, authorizationID, writeOptions());
    if (await SecureStore.getItemAsync(AUTHORIZATION_KEY) !== authorizationID) fail('storage', 'This phone could not preserve its note authorization.');
    requireGeneration(captured);
    activeScope = next;
    activeAuthorization = authorizationID;
  });
}

/**
 * Synchronous invalidation with no purge and no I/O.
 *
 * Use it the moment protected state is torn down — a lock, a lost session, the
 * first step of signing out — so that anything already queued or mid-write
 * fails with `stale` instead of landing afterwards. It also clears the
 * activated scope, so the caller must call `activateOfflineScope` again before
 * offline work resumes.
 *
 * It deliberately leaves storage alone: suspending is not a decision to delete
 * the member's notes. Pair it with `purgeOfflineAvailability` on sign-out,
 * where the data really must go.
 */
export function suspendOfflineAvailability(): void {
  generation += 1;
  activeScope = null;
  activeAuthorization = null;
}

/**
 * Sign-out purge. Removes every scope this device has stored, not only the
 * active one, and clears the activated scope so nothing can write afterwards
 * without a fresh activation.
 *
 * Where encrypted storage does not exist — web — this resolves without error,
 * because nothing can have been written there.
 */
export function purgeOfflineAvailability(): Promise<void> {
  generation += 1;
  activeScope = null;

  return serialize(async () => {
    if (Platform.OS === 'web') return;
    await requireSecureStorage();
    try {
      const registry = await readRegistry();
      for (const entry of registry.scopes) {
        await deleteStoredScope(entry.key);
      }
      await SecureStore.deleteItemAsync(REGISTRY_KEY);
      await SecureStore.deleteItemAsync(AUTHORIZATION_KEY);
      activeAuthorization = null;
    } catch {
      fail('storage', 'Offline items could not be removed from this phone.');
    }
  });
}

/** Test seam: resets the process state this module keeps between operations. */
export function resetOfflineAvailabilityStateForTests(): void {
  operationQueue = Promise.resolve();
  generation = 0;
  activeScope = null;
  storageConfirmed = false;
  activeAuthorization = null;
}
