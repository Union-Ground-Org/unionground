import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  store: new Map<string, string>(),
  uuidCounter: 0,
  deletedFiles: [] as string[],
  failWrites: false,
  failVoiceDelete: false,
  failWriteSuffix: null as string | null,
  failDeleteSuffix: null as string | null,
}));
const { store } = mockState;

vi.mock('./optionalFileSystem', () => ({
  loadFileSystem: () => ({
    deleteAsync: async (uri: string) => { if (mockState.failVoiceDelete) throw new Error('voice delete refused'); mockState.deletedFiles.push(uri); },
  }),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => mockState.store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    if (mockState.failWrites) throw new Error('keychain unavailable');
    if (mockState.failWriteSuffix && key.endsWith(mockState.failWriteSuffix)) throw new Error('index write refused');
    mockState.store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    if (mockState.failDeleteSuffix && key.endsWith(mockState.failDeleteSuffix)) throw new Error('delete refused');
    mockState.store.delete(key);
  }),
}));

vi.mock('expo-crypto', () => ({
  randomUUID: vi.fn(() => `00000000-0000-4000-8000-${`${mockState.uuidCounter++}`.padStart(12, '0')}`),
}));

import {
  addQuickNote,
  bindQuickCaptureOrganization,
  createQuickTask,
  loadQuickNotes,
  loadPinnedDestinationKeys,
  loadQuickTasks,
  MAX_QUICK_NOTES,
  MAX_QUICK_TASKS,
  QUICK_NOTE_BODY_LIMIT,
  purgeQuickCaptureForUser,
  QuickCaptureFullError,
  QUICK_TASK_TITLE_LIMIT,
  removeQuickNote,
  saveQuickTasks,
} from './quickCapture';

describe('quick capture storage', () => {
  beforeEach(() => {
    store.clear();
    mockState.uuidCounter = 0;
    mockState.deletedFiles.length = 0;
    mockState.failWrites = false;
    mockState.failVoiceDelete = false;
    mockState.failWriteSuffix = null;
    mockState.failDeleteSuffix = null;
  });

  it('stores each note as its own SecureStore item behind an id index', async () => {
    await addQuickNote('preview.steward', { body: 'Call the unit about overtime', voiceUri: null, voiceDurationMs: null });
    const noteKeys = [...store.keys()].filter((key) => key.includes('.notes.') && !key.endsWith('.index'));
    expect(noteKeys).toHaveLength(1);
    expect(store.has('org.unionground.app.quickcapture.v1.preview.steward.notes.index')).toBe(true);
    const loaded = await loadQuickNotes('preview.steward');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.body).toBe('Call the unit about overtime');
  });

  it('reads the saved Home shortcut selection without changing its key or bytes', async () => {
    const key = 'org.unionground.app.deck.shortcuts.v1.preview.steward';
    store.set(key, '["tasks","messages"]');
    expect(await loadPinnedDestinationKeys('preview.steward')).toEqual(['tasks', 'messages']);
    expect(store.get(key)).toBe('["tasks","messages"]');
    expect(await loadPinnedDestinationKeys('preview.member')).toBeNull();
  });

  it('pins legacy authenticated scopes to one organization without re-keying captures', async () => {
    const scope = 'authenticated.user-a.none';
    const note = await addQuickNote(scope, { body: 'Before the move', voiceUri: 'file:///old.m4a', voiceDurationMs: 3000 });
    const task = createQuickTask('Before the move');
    await saveQuickTasks(scope, [task]);
    await bindQuickCaptureOrganization(scope, 'org-a');
    expect(await loadQuickNotes(scope)).toEqual(note);
    expect(await loadQuickTasks(scope)).toEqual([task]);
    await expect(bindQuickCaptureOrganization(scope, 'org-b')).rejects.toThrow('another organization');
    await expect(bindQuickCaptureOrganization('authenticated.user-b.none', null)).rejects.toThrow();
    await purgeQuickCaptureForUser('user-a');
    expect(store.has(`org.unionground.app.quickcapture.v1.${scope}.organization`)).toBe(false);
    expect(mockState.deletedFiles).toContain('file:///old.m4a');
  });

  // #9536: a 13th note is refused; nothing saved is deleted to make room.
  it('keeps notes newest-first and refuses a note past the cap without deleting any', async () => {
    for (let index = 0; index < MAX_QUICK_NOTES; index += 1) {
      await addQuickNote('preview.steward', { body: `note ${index}`, voiceUri: null, voiceDurationMs: null });
    }
    const before = await loadQuickNotes('preview.steward');
    expect(before).toHaveLength(MAX_QUICK_NOTES);
    expect(before[0]!.body).toBe(`note ${MAX_QUICK_NOTES - 1}`);
    const keysBefore = new Map(store);
    const refused = addQuickNote('preview.steward', { body: 'one too many', voiceUri: null, voiceDurationMs: null });
    await expect(refused).rejects.toBeInstanceOf(QuickCaptureFullError);
    await expect(refused).rejects.toMatchObject({ list: 'notes' });
    expect(await loadQuickNotes('preview.steward')).toEqual(before);
    // Not one key written or removed: no new item and no cleanup reservation.
    expect(new Map(store)).toEqual(keysBefore);
  });

  it('caps the note body length and preserves voice memo metadata', async () => {
    const next = await addQuickNote('preview.steward', {
      body: 'x'.repeat(QUICK_NOTE_BODY_LIMIT + 50),
      voiceUri: 'file:///memo.m4a',
      voiceDurationMs: 4200,
    });
    expect(next[0]!.body).toHaveLength(QUICK_NOTE_BODY_LIMIT);
    expect(next[0]!.voiceUri).toBe('file:///memo.m4a');
    expect(next[0]!.voiceDurationMs).toBe(4200);
  });

  it('removes a note and its stored item', async () => {
    const [note] = await addQuickNote('preview.admin', { body: 'drop me', voiceUri: null, voiceDurationMs: null });
    const next = await removeQuickNote('preview.admin', note!.id);
    expect(next).toHaveLength(0);
    const noteKeys = [...store.keys()].filter((key) => key.includes('.notes.') && !key.endsWith('.index'));
    expect(noteKeys).toHaveLength(0);
  });

  it('deletes the voice file when its note is removed', async () => {
    const [note] = await addQuickNote('preview.admin', { body: '', voiceUri: 'file:///memo-a.m4a', voiceDurationMs: 900 });
    await removeQuickNote('preview.admin', note!.id);
    expect(mockState.deletedFiles).toContain('file:///memo-a.m4a');
  });

  it('never deletes a saved voice note to make room for a new one', async () => {
    await addQuickNote('preview.admin', { body: '', voiceUri: 'file:///memo-oldest.m4a', voiceDurationMs: 900 });
    for (let index = 1; index < MAX_QUICK_NOTES; index += 1) {
      await addQuickNote('preview.admin', { body: `note ${index}`, voiceUri: null, voiceDurationMs: null });
    }
    await expect(addQuickNote('preview.admin', { body: '', voiceUri: 'file:///memo-new.m4a', voiceDurationMs: 700 }))
      .rejects.toBeInstanceOf(QuickCaptureFullError);
    expect(mockState.deletedFiles).toEqual([]);
    const kept = await loadQuickNotes('preview.admin');
    expect(kept).toHaveLength(MAX_QUICK_NOTES);
    expect(kept.at(-1)!.voiceUri).toBe('file:///memo-oldest.m4a');
  });

  it('serializes overlapping mutations so a double-tapped save cannot drop a capture', async () => {
    const [first, second] = await Promise.all([
      addQuickNote('preview.steward', { body: 'first tap', voiceUri: null, voiceDurationMs: null }),
      addQuickNote('preview.steward', { body: 'second tap', voiceUri: null, voiceDurationMs: null }),
    ]);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const loaded = await loadQuickNotes('preview.steward');
    expect(loaded.map((note) => note.body).sort()).toEqual(['first tap', 'second tap']);
  });

  it('isolates notes and tasks by identity scope', async () => {
    await addQuickNote('preview.steward', { body: 'committee member note', voiceUri: null, voiceDurationMs: null });
    await saveQuickTasks('preview.steward', [createQuickTask('committee member task')]);
    expect(await loadQuickNotes('preview.admin')).toHaveLength(0);
    expect(await loadQuickTasks('preview.admin')).toHaveLength(0);
    expect(await loadQuickNotes('preview.steward')).toHaveLength(1);
    expect(await loadQuickTasks('preview.steward')).toHaveLength(1);
  });

  it('recovers from corrupt stored payloads with an empty list', async () => {
    store.set('org.unionground.app.quickcapture.v1.preview.vp.notes.index', '{nope');
    store.set('org.unionground.app.quickcapture.v1.preview.vp.tasks.index', '["mixed", 4]');
    expect(await loadQuickNotes('preview.vp')).toEqual([]);
    expect(await loadQuickTasks('preview.vp')).toEqual([]);
  });

  it('stores each task as its own item so the list never outgrows a SecureStore value', async () => {
    await saveQuickTasks('preview.steward', [createQuickTask('first'), createQuickTask('second')]);
    const taskKeys = [...store.keys()].filter((key) => key.includes('.tasks.') && !key.endsWith('.index'));
    expect(taskKeys).toHaveLength(2);
    const loaded = await loadQuickTasks('preview.steward');
    expect(loaded.map((task) => task.title)).toEqual(['first', 'second']);
    await saveQuickTasks('preview.steward', loaded.slice(0, 1));
    const remaining = [...store.keys()].filter((key) => key.includes('.tasks.') && !key.endsWith('.index'));
    expect(remaining).toHaveLength(1);
  });

  it('propagates storage write failures so callers can surface and roll back', async () => {
    mockState.failWrites = true;
    await expect(saveQuickTasks('preview.steward', [createQuickTask('will fail')])).rejects.toThrow();
    await expect(addQuickNote('preview.steward', { body: 'will fail', voiceUri: null, voiceDurationMs: null })).rejects.toThrow();
    mockState.failWrites = false;
    mockState.failVoiceDelete = false;
    expect(await loadQuickTasks('preview.steward')).toEqual([]);
    expect(await loadQuickNotes('preview.steward')).toEqual([]);
  });

  it('trims titles, saves a full list of tasks and refuses a longer one whole', async () => {
    const task = createQuickTask(`  ${'t'.repeat(QUICK_TASK_TITLE_LIMIT + 10)}  `);
    expect(task.title).toHaveLength(QUICK_TASK_TITLE_LIMIT);
    expect(task.done).toBe(false);
    const full = Array.from({ length: MAX_QUICK_TASKS }, (_, index) => createQuickTask(`task ${index}`));
    await saveQuickTasks('preview.coordinator', full);
    expect(await loadQuickTasks('preview.coordinator')).toEqual(full);
    // #9536: the 21st task is refused; the saved 20 stay, oldest included.
    const refused = saveQuickTasks('preview.coordinator', [createQuickTask('one too many'), ...full]);
    await expect(refused).rejects.toBeInstanceOf(QuickCaptureFullError);
    await expect(refused).rejects.toMatchObject({ list: 'tasks' });
    expect(await loadQuickTasks('preview.coordinator')).toEqual(full);
  });
});

// SEC-UG-MOBILE-QUICK-CAPTURE-SURVIVES-SIGNOUT: sign-out cleared the
// attachment cache, pending shared uploads and the push registration, but
// member-authored captures had no removal path at all — SecureStore cannot
// enumerate its own keys and the drawer only ever holds the chapter scope
// selected at sign-out.
describe('quick capture sign-out purge', () => {
  const PREFIX = 'org.unionground.app.quickcapture.v1';

  beforeEach(() => {
    store.clear();
    mockState.uuidCounter = 0;
    mockState.deletedFiles.length = 0;
    mockState.failWrites = false;
    mockState.failVoiceDelete = false;
    mockState.failWriteSuffix = null;
    mockState.failDeleteSuffix = null;
  });

  async function captureUnder(scope: string, label: string) {
    await addQuickNote(scope, { body: `${label} note`, voiceUri: `file:///${label}.m4a`, voiceDurationMs: 1200 });
    await saveQuickTasks(scope, [createQuickTask(`${label} task`)]);
  }

  it('finds a rejected capture after its note-index write fails without changing prior notes', async () => {
    const scope = 'authenticated.user-a.wor';
    const prior = await addQuickNote(scope, { body: 'prior', voiceUri: 'file:///prior.m4a', voiceDurationMs: 100 });
    mockState.failWriteSuffix = '.notes.index';
    await expect(addQuickNote(scope, { body: 'rejected private note', voiceUri: 'file:///rejected.m4a', voiceDurationMs: 200 }))
      .rejects.toThrow('index write refused');
    expect(await loadQuickNotes(scope)).toEqual(prior);
    mockState.failWriteSuffix = null;

    await purgeQuickCaptureForUser('user-a');

    expect([...store.keys()].filter(key => key.includes('user-a'))).toEqual([]);
    expect(mockState.deletedFiles).toContain('file:///rejected.m4a');
    expect(mockState.deletedFiles).toContain('file:///prior.m4a');
  });

  it('retains a rejected capture for retry when its voice file cannot be purged', async () => {
    const scope = 'authenticated.user-a.wor';
    mockState.failWriteSuffix = '.notes.index';
    await expect(addQuickNote(scope, { body: 'rejected private note', voiceUri: 'file:///retry.m4a', voiceDurationMs: 200 }))
      .rejects.toThrow('index write refused');
    mockState.failWriteSuffix = null;
    mockState.failVoiceDelete = true;
    await expect(purgeQuickCaptureForUser('user-a')).rejects.toThrow('Voice-file cleanup is pending');
    expect([...store.values()].some(value => value.includes('rejected private note'))).toBe(true);
    mockState.failVoiceDelete = false;

    await purgeQuickCaptureForUser('user-a');

    expect([...store.keys()].filter(key => key.includes('user-a'))).toEqual([]);
    expect(mockState.deletedFiles).toContain('file:///retry.m4a');
  });

  it('keeps a rejected capture discoverable after a later successful save', async () => {
    const scope = 'authenticated.user-a.wor';
    mockState.failWriteSuffix = '.notes.index';
    await expect(addQuickNote(scope, { body: 'rejected', voiceUri: 'file:///rejected.m4a', voiceDurationMs: 200 })).rejects.toThrow();
    mockState.failWriteSuffix = null;
    await addQuickNote(scope, { body: 'saved', voiceUri: null, voiceDurationMs: null });
    expect((await loadQuickNotes(scope)).map(note => note.body)).toEqual(['saved']);

    await purgeQuickCaptureForUser('user-a');

    expect([...store.keys()].filter(key => key.includes('user-a'))).toEqual([]);
    expect(mockState.deletedFiles).toContain('file:///rejected.m4a');
  });

  it('retains the cleanup reservation when rejected-note deletion fails', async () => {
    const scope = 'authenticated.user-a.wor';
    mockState.failWriteSuffix = '.notes.index';
    await expect(addQuickNote(scope, { body: 'rejected', voiceUri: null, voiceDurationMs: null })).rejects.toThrow();
    mockState.failWriteSuffix = null;
    const itemKey = [...store.keys()].find(key => key.includes('.notes.') && !key.endsWith('.index'))!;
    mockState.failDeleteSuffix = itemKey;
    await expect(purgeQuickCaptureForUser('user-a')).rejects.toThrow('Quick-capture cleanup is pending');
    expect(store.has(`${PREFIX}.${scope}.notes.pending.index`)).toBe(true);
    expect(store.has(itemKey)).toBe(true);
    mockState.failDeleteSuffix = null;
    await purgeQuickCaptureForUser('user-a');
    expect([...store.keys()].filter(key => key.includes('user-a'))).toEqual([]);
  });

  it('refuses private content when its cleanup reservation cannot be saved', async () => {
    mockState.failWriteSuffix = '.notes.pending.index';
    await expect(addQuickNote('authenticated.user-a.wor', { body: 'must not persist', voiceUri: null, voiceDurationMs: null }))
      .rejects.toThrow('index write refused');
    expect([...store.values()].some(value => value.includes('must not persist'))).toBe(false);
  });

  it('does not overwrite an unreadable cleanup reservation', async () => {
    const key = `${PREFIX}.authenticated.user-a.wor.notes.pending.index`;
    store.set(key, '{unreadable');
    await expect(addQuickNote('authenticated.user-a.wor', { body: 'must not persist', voiceUri: null, voiceDurationMs: null }))
      .rejects.toThrow();
    expect(store.get(key)).toBe('{unreadable');
    expect([...store.values()].some(value => value.includes('must not persist'))).toBe(false);
  });

  it('keeps a successful note saved when redundant cleanup-index removal fails', async () => {
    const scope = 'authenticated.user-a.wor';
    mockState.failDeleteSuffix = '.notes.pending.index';
    await expect(addQuickNote(scope, { body: 'saved', voiceUri: null, voiceDurationMs: null })).resolves.toHaveLength(1);
    expect((await loadQuickNotes(scope))[0]?.body).toBe('saved');
    mockState.failDeleteSuffix = null;
    await purgeQuickCaptureForUser('user-a');
    expect([...store.keys()].filter(key => key.includes('user-a'))).toEqual([]);
  });

  it('removes notes, tasks and voice memos from every campaign scope the account captured under', async () => {
    await captureUnder('authenticated.user-a.hbv', 'harborview');
    await captureUnder('authenticated.user-a.spr', 'springfield');

    await purgeQuickCaptureForUser('user-a');

    expect(await loadQuickNotes('authenticated.user-a.hbv')).toEqual([]);
    expect(await loadQuickTasks('authenticated.user-a.hbv')).toEqual([]);
    expect(await loadQuickNotes('authenticated.user-a.spr')).toEqual([]);
    expect(await loadQuickTasks('authenticated.user-a.spr')).toEqual([]);
    // Nothing recoverable is left behind: no index, no item, no registry entry.
    expect([...store.keys()].filter((key) => key.includes('user-a'))).toEqual([]);
    expect(mockState.deletedFiles).toContain('file:///harborview.m4a');
    expect(mockState.deletedFiles).toContain('file:///springfield.m4a');
  });

  it('leaves another account on the same device and preview capture untouched', async () => {
    await captureUnder('authenticated.user-a.hbv', 'signed-out');
    await captureUnder('authenticated.user-b.hbv', 'other-account');
    await captureUnder('preview.steward', 'preview');

    await purgeQuickCaptureForUser('user-a');

    expect(await loadQuickNotes('authenticated.user-b.hbv')).toHaveLength(1);
    expect(await loadQuickTasks('authenticated.user-b.hbv')).toHaveLength(1);
    expect(await loadQuickNotes('preview.steward')).toHaveLength(1);
    expect(await loadQuickTasks('preview.steward')).toHaveLength(1);
    expect(mockState.deletedFiles).not.toContain('file:///other-account.m4a');
    expect(mockState.deletedFiles).not.toContain('file:///preview.m4a');
    // Preview capture carries no member identity, so it is never registered
    // against an account and no sign-out can reach it.
    expect(store.has(`${PREFIX}.scopes.steward`)).toBe(false);
  });

  it('ignores a registry entry that names a different account', async () => {
    await captureUnder('authenticated.user-b.hbv', 'other-account');
    store.set(`${PREFIX}.scopes.user-a`, JSON.stringify(['authenticated.user-b.hbv', 'preview.steward']));

    await purgeQuickCaptureForUser('user-a');

    expect(await loadQuickNotes('authenticated.user-b.hbv')).toHaveLength(1);
    expect(await loadQuickTasks('authenticated.user-b.hbv')).toHaveLength(1);
    expect(store.has(`${PREFIX}.scopes.user-a`)).toBe(false);
  });

  it('is a no-op for an account that never captured anything', async () => {
    await captureUnder('authenticated.user-b.hbv', 'other-account');
    const before = [...store.keys()].sort();

    await expect(purgeQuickCaptureForUser('user-a')).resolves.toBeUndefined();

    expect([...store.keys()].sort()).toEqual(before);
    expect(mockState.deletedFiles).toEqual([]);
  });

  it('keeps voice source records and scope indexes discoverable when file deletion fails', async () => {
    await captureUnder('authenticated.user-a.hbv', 'voice');
    mockState.failVoiceDelete = true;
    await expect(purgeQuickCaptureForUser('user-a')).rejects.toThrow('Voice-file cleanup is pending');
    expect(await loadQuickNotes('authenticated.user-a.hbv')).toHaveLength(1);
    expect(store.has(`${PREFIX}.scopes.user-a`)).toBe(true);
    mockState.failVoiceDelete = false;
    await purgeQuickCaptureForUser('user-a');
    expect([...store.keys()].filter((key) => key.includes('user-a'))).toEqual([]);
  });

  it('preserves captures if ownership changes while reading a purge index', async () => {
    await captureUnder('authenticated.user-a.hbv', 'replacement');
    let current = true;
    const secureStore = await import('expo-secure-store');
    vi.mocked(secureStore.getItemAsync).mockImplementationOnce(async (key) => { current = false; return store.get(key) ?? null; });
    await expect(purgeQuickCaptureForUser('user-a', () => current)).rejects.toThrow('Account changed');
    expect(await loadQuickNotes('authenticated.user-a.hbv')).toHaveLength(1);
    expect(mockState.deletedFiles).toEqual([]);
  });

  it('removes indexed items the readers reject as corrupt', async () => {
    await captureUnder('authenticated.user-a.hbv', 'harborview');
    const noteKey = [...store.keys()].find((key) => key.includes('.notes.') && !key.endsWith('.index'))!;
    const taskKey = [...store.keys()].find((key) => key.includes('.tasks.') && !key.endsWith('.index'))!;
    store.set(noteKey, '{truncated');
    store.set(taskKey, '{truncated');
    // The readers drop these, so a purge built on loaded content would skip
    // them and leave member text in the keychain. Purge works off the raw
    // index ids instead.
    expect(await loadQuickNotes('authenticated.user-a.hbv')).toEqual([]);

    await purgeQuickCaptureForUser('user-a');

    expect([...store.keys()].filter((key) => key.includes('user-a'))).toEqual([]);
  });
});
