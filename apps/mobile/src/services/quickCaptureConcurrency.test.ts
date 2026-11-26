import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ store: new Map<string, string>(), uuid: 0, deletedFiles: [] as string[] }));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => state.store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => { state.store.set(key, value); }),
  deleteItemAsync: vi.fn(async (key: string) => { state.store.delete(key); }),
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => `capture-${state.uuid++}` }));
vi.mock('./optionalFileSystem', () => ({
  loadFileSystem: () => ({ deleteAsync: async (uri: string) => { state.deletedFiles.push(uri); } }),
}));

import * as SecureStore from 'expo-secure-store';
import {
  addQuickNote, bindQuickCaptureOrganization, createQuickTask, loadQuickNotes,
  loadQuickTasks, purgeQuickCaptureForUser, removeQuickNote, saveQuickTasks,
} from './quickCapture';

const PREFIX = 'org.unionground.app.quickcapture.v1';
const FIRST = 'authenticated.user-a.chapter-a';
const SECOND = 'authenticated.user-a.chapter-b';
const note = (label: string) => ({ body: label, voiceUri: `file:///${label}.m4a`, voiceDurationMs: 1000 });

beforeEach(() => {
  vi.clearAllMocks();
  state.store.clear();
  state.deletedFiles.length = 0;
  state.uuid = 0;
});

describe('account-wide quick-capture registry concurrency', () => {
  it('retains simultaneous campaign notes for complete purge and isolates other accounts and preview', async () => {
    await addQuickNote('authenticated.user-b.chapter-a', note('other-account'));
    await addQuickNote('preview.steward', note('preview'));
    await Promise.all([addQuickNote(FIRST, note('first')), addQuickNote(SECOND, note('second'))]);

    expect(await loadQuickNotes(FIRST)).toHaveLength(1);
    expect(await loadQuickNotes(SECOND)).toHaveLength(1);
    await purgeQuickCaptureForUser('user-a');

    expect([...state.store.keys()].filter((key) => key.includes('user-a'))).toEqual([]);
    expect(state.deletedFiles.sort()).toEqual(['file:///first.m4a', 'file:///second.m4a']);
    expect(await loadQuickNotes('authenticated.user-b.chapter-a')).toHaveLength(1);
    expect(await loadQuickNotes('preview.steward')).toHaveLength(1);
  });

  it('keeps both campaigns when a note and task list are first saved together', async () => {
    await Promise.all([addQuickNote(FIRST, note('first')), saveQuickTasks(SECOND, [createQuickTask('second')])]);
    expect(await loadQuickTasks(SECOND)).toHaveLength(1);

    await purgeQuickCaptureForUser('user-a');

    expect([...state.store.keys()]).toEqual([]);
    expect(state.deletedFiles).toEqual(['file:///first.m4a']);
  });

  it('tracks simultaneous organization bindings so account purge removes both', async () => {
    await Promise.all([
      bindQuickCaptureOrganization(FIRST, 'organization-a'),
      bindQuickCaptureOrganization(SECOND, 'organization-a'),
    ]);

    await purgeQuickCaptureForUser('user-a');

    expect([...state.store.keys()]).toEqual([]);
  });

  it('waits for a capture already being written before purging its account', async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
      state.store.set(key, value);
    }).mockImplementationOnce(async (key, value) => {
      entered();
      await held;
      state.store.set(key, value);
    });
    const saving = addQuickNote(FIRST, note('first'));
    await started;
    const purging = purgeQuickCaptureForUser('user-a');
    // Allow cleanup to run while the item write is held. A correct account
    // queue keeps it pending until the capture has its complete index.
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    release();
    await Promise.all([saving, purging]);

    expect([...state.store.keys()]).toEqual([]);
    expect(state.deletedFiles).toEqual(['file:///first.m4a']);
  });

  it('allows another account to save while one account write is pending', async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
      entered();
      await held;
      state.store.set(key, value);
    });
    const first = addQuickNote(FIRST, note('first'));
    await started;
    try {
      await addQuickNote('authenticated.user-b.chapter-a', note('other-account'));
      expect(await loadQuickNotes('authenticated.user-b.chapter-a')).toHaveLength(1);
    } finally {
      release();
      await first;
    }
  });

  it('does not poison later account mutations when registry storage refuses a write', async () => {
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(addQuickNote(FIRST, note('failed'))).rejects.toThrow('storage unavailable');

    await addQuickNote(SECOND, note('second'));
    await purgeQuickCaptureForUser('user-a');

    expect(state.store.has(`${PREFIX}.scopes.user-a`)).toBe(false);
    expect([...state.store.keys()]).toEqual([]);
    expect(state.deletedFiles).toEqual(['file:///second.m4a']);
  });

  it('refuses capture mutations admitted during and after a session-owned purge', async () => {
    const [saved] = await addQuickNote(FIRST, note('existing'));
    let current = true;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(async (key) => {
      entered();
      await held;
      return state.store.get(key) ?? null;
    });
    const purging = purgeQuickCaptureForUser('user-a', () => current);
    await started;
    try {
      const mutations: Array<() => Promise<unknown>> = [
        () => addQuickNote(SECOND, { body: 'late private note', voiceUri: null, voiceDurationMs: null }),
        () => saveQuickTasks(SECOND, [createQuickTask('late private task')]),
        () => bindQuickCaptureOrganization(SECOND, 'organization-a'),
        () => removeQuickNote(FIRST, saved!.id),
      ];
      const attempted = mutations.map((mutate) => mutate().then(() => false, () => true));
      release();
      await purging;
      const refused = await Promise.all(attempted);

      expect([...state.store.keys()]).toEqual([]);
      expect(state.deletedFiles).toEqual(['file:///existing.m4a']);
      expect(refused).toEqual([true, true, true, true]);
      // The sign-out coordinator still owns the session while it persists its
      // cleanup ledger and awaits other stores after this purge has returned.
      await expect(addQuickNote(SECOND, note('after-purge'))).rejects.toThrow();
      expect([...state.store.keys()]).toEqual([]);

      current = false;
      await addQuickNote(SECOND, note('new-session'));
      expect(await loadQuickNotes(SECOND)).toHaveLength(1);
    } finally {
      current = false;
      release();
    }
  });

  it('reopens capture writes after a refused purge so cleanup can be retried', async () => {
    await addQuickNote(FIRST, note('first'));
    let current = true;
    try {
      vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('keychain unavailable'));
      await expect(purgeQuickCaptureForUser('user-a', () => current)).rejects.toThrow('keychain unavailable');

      await addQuickNote(SECOND, note('second'));
      await purgeQuickCaptureForUser('user-a', () => current);
      expect([...state.store.keys()]).toEqual([]);
      expect(state.deletedFiles.sort()).toEqual(['file:///first.m4a', 'file:///second.m4a']);
    } finally { current = false; }
  });

  it('retains an earlier current owner when a queued purge loses its ownership', async () => {
    await addQuickNote(FIRST, note('first'));
    let firstCurrent = true;
    let secondCurrent = true;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(async (key) => {
      entered();
      await held;
      return state.store.get(key) ?? null;
    });
    const firstPurge = purgeQuickCaptureForUser('user-a', () => firstCurrent);
    await started;
    const secondPurge = purgeQuickCaptureForUser('user-a', () => secondCurrent);
    const refused = expect(secondPurge).rejects.toThrow('Account changed during local cleanup.');
    secondCurrent = false;
    release();
    try {
      await firstPurge;
      await refused;
      expect([...state.store.keys()]).toEqual([]);
      await expect(addQuickNote(SECOND, note('late'))).rejects.toThrow('Account changed during local cleanup.');
      expect([...state.store.keys()]).toEqual([]);
      firstCurrent = false;
      await addQuickNote(SECOND, note('new-session'));
      expect(await loadQuickNotes(SECOND)).toHaveLength(1);
    } finally {
      firstCurrent = false;
      release();
    }
  });

  it('keeps a session-owned barrier after a later ordinary purge completes', async () => {
    await addQuickNote(FIRST, note('first'));
    let current = true;
    try {
      await purgeQuickCaptureForUser('user-a', () => current);
      await purgeQuickCaptureForUser('user-a');
      await expect(saveQuickTasks(SECOND, [createQuickTask('late task')])).rejects.toThrow('Account changed during local cleanup.');
      expect([...state.store.keys()]).toEqual([]);
      current = false;
      await saveQuickTasks(SECOND, [createQuickTask('new-session')]);
      expect(await loadQuickTasks(SECOND)).toHaveLength(1);
    } finally { current = false; }
  });

  it('allows later captures after an ordinary purge with no session-owner callback', async () => {
    await addQuickNote(FIRST, note('first'));
    await purgeQuickCaptureForUser('user-a');
    await addQuickNote(SECOND, note('second'));
    expect(await loadQuickNotes(SECOND)).toHaveLength(1);
  });
});
