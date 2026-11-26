import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { PINNED_DESTINATIONS_STORE_PREFIX } from '../lib/quickActions';
import { loadFileSystem } from './optionalFileSystem';

export type QuickNote = {
  id: string;
  body: string;
  voiceUri: string | null;
  voiceDurationMs: number | null;
  createdAt: string;
};

export type QuickTask = {
  id: string;
  title: string;
  done: boolean;
  createdAt: string;
};

// SecureStore values are capped near 2 KB on iOS, so notes and tasks each
// live in their own item behind a small id index.
const STORE_PREFIX = 'org.unionground.app.quickcapture.v1';
export const MAX_QUICK_NOTES = 12;
export const MAX_QUICK_TASKS = 20;
export const QUICK_NOTE_BODY_LIMIT = 600;
export const QUICK_TASK_TITLE_LIMIT = 120;

// BUG-UG-QUICK-CAPTURE-FULL-LIST-DELETES-OLDEST-20261122 (#9536): a
// full list refuses the new capture instead of deleting the oldest saved one.
// The composer checks first and says so; this is the storage-side backstop.
export class QuickCaptureFullError extends Error {
  readonly list: 'notes' | 'tasks';
  constructor(list: 'notes' | 'tasks') {
    super(`Quick capture already holds the most ${list} it can keep.`);
    this.name = 'QuickCaptureFullError';
    this.list = list;
  }
}

function noteIndexKey(scope: string) {
  return `${STORE_PREFIX}.${scope}.notes.index`;
}

function pendingNoteIndexKey(scope: string) {
  return `${STORE_PREFIX}.${scope}.notes.pending.index`;
}

function noteKey(scope: string, id: string) {
  return `${STORE_PREFIX}.${scope}.notes.${id}`;
}

function taskIndexKey(scope: string) {
  return `${STORE_PREFIX}.${scope}.tasks.index`;
}

function taskKey(scope: string, id: string) {
  return `${STORE_PREFIX}.${scope}.tasks.${id}`;
}

// SecureStore cannot enumerate its own keys, and one member captures under a
// distinct scope per chapter, so sign-out has no way to discover what it must
// remove. Every authenticated scope is recorded under its account before any
// content is written to it: this registry is the only map from an account to
// the scopes holding its captures. Preview scopes carry no member identity and
// are deliberately never registered, so a sign-out can never reach them.
const AUTHENTICATED_SCOPE_PREFIX = 'authenticated.';

function scopeRegistryKey(userId: string) {
  return `${STORE_PREFIX}.scopes.${userId}`;
}

function accountForScope(scope: string): string | null {
  if (!scope.startsWith(AUTHENTICATED_SCOPE_PREFIX)) return null;
  return scope.slice(AUTHENTICATED_SCOPE_PREFIX.length).split('.')[0] || null;
}

export async function deleteVoiceRecording(uri: string | null): Promise<void> {
  if (!uri) return;
  await loadFileSystem()?.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
}

// Chapter scopes share an account-wide registry. Order authenticated capture
// mutations and the entire account purge together so neither can lose a
// chapter registration or delete it before that chapter finishes saving.
// Preview captures have no account and retain their independent scope queues.
const scopeQueues = new Map<string, Promise<unknown>>();
type CaptureCleanupOwner = { isCurrent: () => boolean };
const closingAccounts = new Map<string, Set<CaptureCleanupOwner>>();

function accountQueueKey(userId: string): string {
  return `account:${userId}`;
}

function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = scopeQueues.get(key) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  scopeQueues.set(key, next.then(() => undefined, () => undefined));
  return next;
}

function captureWritesBlocked(userId: string | null): boolean {
  if (!userId) return false;
  const closings = closingAccounts.get(userId);
  if (!closings) return false;
  for (const closing of closings) {
    if (!closing.isCurrent()) closings.delete(closing);
  }
  if (closings.size > 0) return true;
  closingAccounts.delete(userId);
  return false;
}

function serializedPerScope<T>(scope: string, operation: () => Promise<T>): Promise<T> {
  const userId = accountForScope(scope);
  if (captureWritesBlocked(userId)) return Promise.reject(new Error('Account changed during local cleanup.'));
  return serialized(userId ? accountQueueKey(userId) : `scope:${scope}`, () => {
    if (captureWritesBlocked(userId)) throw new Error('Account changed during local cleanup.');
    return operation();
  });
}

async function readJson(key: string): Promise<unknown> {
  try {
    const raw = await SecureStore.getItemAsync(key);
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    // Corrupt or unreadable entries fall back to empty state.
    return null;
  }
}

async function readStringArray(key: string): Promise<string[]> {
  const value = await readJson(key);
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => (typeof entry === 'string' ? [entry] : []));
}

// Read the pre-move selection without rewriting it; reconcile against the
// current authorized catalog in the caller so a stored key grants no access.
export async function loadPinnedDestinationKeys(shortcutScope: string): Promise<string[] | null> {
  const value = await readJson(`${PINNED_DESTINATIONS_STORE_PREFIX}.${shortcutScope}`);
  return Array.isArray(value) && value.every((key: unknown) => typeof key === 'string') ? value : null;
}

// Keep all v1 capture keys, including legacy chapter-less '.none' captures.
// Pin each authenticated scope to the verified current organization on first
// use and refuse a later organization change. This metadata contains no note,
// task or voice-file bytes; previously saved captures need no migration.
export function bindQuickCaptureOrganization(scope: string, organizationID: string | null): Promise<void> {
  return serializedPerScope(scope, async () => {
    if (!scope.startsWith(AUTHENTICATED_SCOPE_PREFIX)) return;
    if (!organizationID) throw new Error('Quick capture needs an organization.');
    const key = `${STORE_PREFIX}.${scope}.organization`;
    const bound = await SecureStore.getItemAsync(key);
    if (bound && bound !== organizationID) throw new Error('Quick capture belongs to another organization.');
    if (!bound) {
      await registerScope(scope);
      await SecureStore.setItemAsync(key, organizationID);
    }
  });
}

// Registration precedes the content write and propagates its failure: a scope
// whose registry entry could not be written must not receive captures that
// sign-out would then be unable to find.
async function registerScope(scope: string): Promise<void> {
  const userId = accountForScope(scope);
  if (!userId) return;
  const key = scopeRegistryKey(userId);
  const scopes = await readStringArray(key);
  if (scopes.includes(scope)) return;
  await SecureStore.setItemAsync(key, JSON.stringify([...scopes, scope]));
}

function isQuickNote(value: unknown): value is QuickNote {
  if (!value || typeof value !== 'object') return false;
  const note = value as Record<string, unknown>;
  return typeof note.id === 'string'
    && typeof note.body === 'string'
    && (note.voiceUri === null || typeof note.voiceUri === 'string')
    && (note.voiceDurationMs === null || typeof note.voiceDurationMs === 'number')
    && typeof note.createdAt === 'string';
}

function isQuickTask(value: unknown): value is QuickTask {
  if (!value || typeof value !== 'object') return false;
  const task = value as Record<string, unknown>;
  return typeof task.id === 'string'
    && typeof task.title === 'string'
    && typeof task.done === 'boolean'
    && typeof task.createdAt === 'string';
}

export async function loadQuickNotes(scope: string): Promise<QuickNote[]> {
  const ids = await readStringArray(noteIndexKey(scope));
  const entries = await Promise.all(ids.map((id) => readJson(noteKey(scope, id))));
  return entries.filter(isQuickNote);
}

export function addQuickNote(
  scope: string,
  input: { body: string; voiceUri: string | null; voiceDurationMs: number | null },
): Promise<QuickNote[]> {
  return serializedPerScope(scope, async () => {
    await registerScope(scope);
    const note: QuickNote = {
      id: Crypto.randomUUID(),
      body: input.body.trim().slice(0, QUICK_NOTE_BODY_LIMIT),
      voiceUri: input.voiceUri,
      voiceDurationMs: input.voiceDurationMs,
      createdAt: new Date().toISOString(),
    };
    const existing = await loadQuickNotes(scope);
    // Refuse before any write: nothing saved is ever deleted to make room.
    if (existing.length >= MAX_QUICK_NOTES) throw new QuickCaptureFullError('notes');
    const next = [note, ...existing];
    // Register cleanup before writing private bytes. A failed visible-index
    // write must leave the rejected capture discoverable without showing it
    // as a saved note. Read strictly so corrupt cleanup metadata is not lost.
    const pendingKey = pendingNoteIndexKey(scope);
    const pending = await readPurgeIndex(pendingKey);
    await SecureStore.setItemAsync(pendingKey, JSON.stringify([...pending, note.id]));
    await SecureStore.setItemAsync(noteKey(scope, note.id), JSON.stringify(note));
    await SecureStore.setItemAsync(noteIndexKey(scope), JSON.stringify(next.map((entry) => entry.id)));
    // The visible index now owns this note. Failure to remove its redundant
    // cleanup reference is harmless; sign-out deduplicates both indexes.
    await (pending.length
      ? SecureStore.setItemAsync(pendingKey, JSON.stringify(pending))
      : SecureStore.deleteItemAsync(pendingKey)).catch(() => undefined);
    return next;
  });
}

export function removeQuickNote(scope: string, id: string): Promise<QuickNote[]> {
  return serializedPerScope(scope, async () => {
    const existing = await loadQuickNotes(scope);
    const removed = existing.find((entry) => entry.id === id) ?? null;
    const next = existing.filter((entry) => entry.id !== id);
    await SecureStore.setItemAsync(noteIndexKey(scope), JSON.stringify(next.map((entry) => entry.id)));
    await SecureStore.deleteItemAsync(noteKey(scope, id)).catch(() => undefined);
    await deleteVoiceRecording(removed?.voiceUri ?? null);
    return next;
  });
}

export async function loadQuickTasks(scope: string): Promise<QuickTask[]> {
  const ids = await readStringArray(taskIndexKey(scope));
  const entries = await Promise.all(ids.map((id) => readJson(taskKey(scope, id))));
  return entries.filter(isQuickTask);
}

export function saveQuickTasks(scope: string, tasks: QuickTask[]): Promise<void> {
  return serializedPerScope(scope, async () => {
    // A list past the limit is refused whole, never trimmed from its end.
    if (tasks.length > MAX_QUICK_TASKS) throw new QuickCaptureFullError('tasks');
    await registerScope(scope);
    const next = tasks;
    const previous = await loadQuickTasks(scope);
    const previousById = new Map(previous.map((task) => [task.id, JSON.stringify(task)]));
    // Item and index writes propagate failures so callers can surface them;
    // only the cleanup of already-unreferenced items stays best-effort. On
    // failure, let every started write settle before restoring the prior
    // items: a late native write must never outlive rollback or the scope lock.
    const writes = next.map(async (task) => {
      const serialized = JSON.stringify(task);
      if (previousById.get(task.id) === serialized) return;
      await SecureStore.setItemAsync(taskKey(scope, task.id), serialized);
    });
    try {
      await Promise.all(writes);
      await SecureStore.setItemAsync(taskIndexKey(scope), JSON.stringify(next.map((task) => task.id)));
    } catch (error) {
      await Promise.allSettled(writes);
      await Promise.all(next.map((task) => {
        const before = previousById.get(task.id);
        const key = taskKey(scope, task.id);
        if (before === JSON.stringify(task)) return Promise.resolve();
        return (before === undefined
          ? SecureStore.deleteItemAsync(key)
          : SecureStore.setItemAsync(key, before)
        ).catch(() => undefined);
      }));
      throw error;
    }
    const removed = previous.filter((task) => !next.some((kept) => kept.id === task.id));
    await Promise.all(removed.map((task) => SecureStore.deleteItemAsync(taskKey(scope, task.id)).catch(() => undefined)));
  });
}

async function readPurgeIndex(key: string): Promise<string[]> {
  const raw = await SecureStore.getItemAsync(key);
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.some((entry: unknown) => typeof entry !== 'string')) {
    throw new Error('Quick-capture cleanup index is unreadable.');
  }
  return value;
}

async function purgeScope(scope: string, isCurrent: () => boolean): Promise<void> {
  const noteIds = [...new Set([
    ...await readPurgeIndex(noteIndexKey(scope)),
    ...await readPurgeIndex(pendingNoteIndexKey(scope)),
  ])];
  const taskIds = await readPurgeIndex(taskIndexKey(scope));
  const notes = await Promise.all(noteIds.map((id) => SecureStore.getItemAsync(noteKey(scope, id))));
  if (!isCurrent()) throw new Error('Account changed during local cleanup.');
  // Remove voice files first. Keep their source records/indexes if a file
  // cannot be removed, so the retry can still discover its exact URI.
  const files = notes.flatMap((raw) => {
    if (!raw) return [];
    try {
      const note: unknown = JSON.parse(raw);
      return isQuickNote(note) && note.voiceUri ? [note.voiceUri] : [];
    } catch { return []; }
  });
  const voiceResults = await Promise.allSettled(files.map(async (uri) => {
    const fs = loadFileSystem();
    if (!fs) throw new Error('Voice-file cleanup is unavailable.');
    await fs.deleteAsync(uri, { idempotent: true });
  }));
  if (voiceResults.some((result) => result.status === 'rejected')) throw new Error('Voice-file cleanup is pending.');
  if (!isCurrent()) throw new Error('Account changed during local cleanup.');
  const results = await Promise.allSettled([
    ...noteIds.map((id) => SecureStore.deleteItemAsync(noteKey(scope, id))),
    ...taskIds.map((id) => SecureStore.deleteItemAsync(taskKey(scope, id))),
  ]);
  if (results.some((result) => result.status === 'rejected')) throw new Error('Quick-capture cleanup is pending.');
  if (!isCurrent()) throw new Error('Account changed during local cleanup.');
  await SecureStore.deleteItemAsync(noteIndexKey(scope));
  await SecureStore.deleteItemAsync(pendingNoteIndexKey(scope));
  await SecureStore.deleteItemAsync(taskIndexKey(scope));
  await SecureStore.deleteItemAsync(`${STORE_PREFIX}.${scope}.organization`);
}

// The account lock and ownership checks protect a replacement session's writes.
// Keep the registry on any failed purge so every remaining item is retryable.
export async function purgeQuickCaptureForUser(userId: string, isCurrent?: () => boolean): Promise<void> {
  const closing = { isCurrent: isCurrent ?? (() => true) };
  if (!userId || !closing.isCurrent()) return;
  // Close admission before joining the queue, including through the caller's
  // post-purge sign-out awaits. A replacement session expires this boundary.
  let closings = closingAccounts.get(userId);
  if (!closings) {
    closings = new Set<CaptureCleanupOwner>();
    closingAccounts.set(userId, closings);
  }
  closings.add(closing);
  try {
    await serialized(accountQueueKey(userId), async () => {
      if (!closing.isCurrent()) throw new Error('Account changed during local cleanup.');
      const registryKey = scopeRegistryKey(userId);
      const scopes = await readPurgeIndex(registryKey);
      for (const scope of scopes) {
        if (accountForScope(scope) !== userId) continue;
        await purgeScope(scope, closing.isCurrent);
      }
      if (!closing.isCurrent()) throw new Error('Account changed during local cleanup.');
      await SecureStore.deleteItemAsync(registryKey);
    });
  } catch (error) {
    closings.delete(closing);
    throw error;
  } finally {
    // An ordinary purge supplies no session lease; its admission barrier lasts
    // for this operation only. Release only this call's barrier, preserving
    // every other still-current owner through its own post-purge awaits.
    if (!isCurrent) closings.delete(closing);
    if (closings.size === 0 && closingAccounts.get(userId) === closings) closingAccounts.delete(userId);
  }
}

export function createQuickTask(title: string): QuickTask {
  return {
    id: Crypto.randomUUID(),
    title: title.trim().slice(0, QUICK_TASK_TITLE_LIMIT),
    done: false,
    createdAt: new Date().toISOString(),
  };
}
