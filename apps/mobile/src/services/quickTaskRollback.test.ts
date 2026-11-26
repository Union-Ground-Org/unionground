import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  store: new Map<string, string>(),
  uuid: 0,
  beforeWrite: null as ((key: string, value: string) => Promise<void>) | null,
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => state.store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    await state.beforeWrite?.(key, value);
    state.store.set(key, value);
  },
  deleteItemAsync: async (key: string) => { state.store.delete(key); },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => `task-${state.uuid++}` }));
vi.mock('./optionalFileSystem', () => ({ loadFileSystem: () => null }));

import { createQuickTask, loadQuickTasks, saveQuickTasks, type QuickTask } from './quickCapture';

const SCOPE = 'authenticated.user-a.chapter-a';
const PREFIX = `org.unionground.app.quickcapture.v1.${SCOPE}.tasks.`;
const nextTurn = () => new Promise<void>((resolve) => { setImmediate(resolve); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function failFirstAndHoldSecond(first: QuickTask, second: QuickTask) {
  const entered = deferred();
  const held = deferred();
  const refusal = new Error('first task write refused');
  state.beforeWrite = async (key, value) => {
    if (key === `${PREFIX}${first.id}` && value === JSON.stringify({ ...first, done: true })) throw refusal;
    if (key === `${PREFIX}${second.id}` && value === JSON.stringify({ ...second, done: true })) {
      entered.resolve();
      await held.promise;
    }
  };
  return { entered: entered.promise, release: held.resolve, refusal };
}

beforeEach(() => {
  state.store.clear();
  state.uuid = 0;
  state.beforeWrite = null;
});

describe('quick-task failed batch settlement', () => {
  it('restores existing tasks after every pending write settles and preserves the original rejection', async () => {
    const first = createQuickTask('first');
    const second = createQuickTask('second');
    await saveQuickTasks(SCOPE, [first, second]);
    const gate = failFirstAndHoldSecond(first, second);
    const saving = saveQuickTasks(SCOPE, [{ ...first, done: true }, { ...second, done: true }])
      .then((): unknown => null, (error: unknown) => error);
    await gate.entered;
    await nextTurn();
    gate.release();
    expect(await saving).toBe(gate.refusal);
    await nextTurn();

    expect(await loadQuickTasks(SCOPE)).toEqual([first, second]);
  });

  it('does not leave an unindexed new task when its delayed write outlives another rejection', async () => {
    const first = createQuickTask('existing');
    const second = createQuickTask('new');
    await saveQuickTasks(SCOPE, [first]);
    const before = [...state.store.entries()].sort();
    const gate = failFirstAndHoldSecond(first, second);
    const saving = saveQuickTasks(SCOPE, [{ ...first, done: true }, { ...second, done: true }])
      .then((): unknown => null, (error: unknown) => error);
    await gate.entered;
    await nextTurn();
    gate.release();
    expect(await saving).toBe(gate.refusal);
    await nextTurn();

    expect([...state.store.entries()].sort()).toEqual(before);
    expect(await loadQuickTasks(SCOPE)).toEqual([first]);
  });

  it('keeps a queued newer save from being overwritten by an older rejected batch', async () => {
    const first = createQuickTask('first');
    const second = createQuickTask('second');
    await saveQuickTasks(SCOPE, [first, second]);
    const gate = failFirstAndHoldSecond(first, second);
    const failed = saveQuickTasks(SCOPE, [{ ...first, done: true }, { ...second, done: true }])
      .then((): unknown => null, (error: unknown) => error);
    await gate.entered;
    const newest = [{ ...first, title: 'newest first' }, { ...second, title: 'newest second' }];
    const succeeding = saveQuickTasks(SCOPE, newest);
    await nextTurn();
    gate.release();
    expect(await failed).toBe(gate.refusal);
    await succeeding;
    await nextTurn();

    expect(await loadQuickTasks(SCOPE)).toEqual(newest);
  });

  it('restores prior items and removes new ones when only the final index write rejects', async () => {
    const first = createQuickTask('existing');
    const second = createQuickTask('new');
    await saveQuickTasks(SCOPE, [first]);
    const before = [...state.store.entries()].sort();
    const refusal = new Error('index write refused');
    state.beforeWrite = async (key) => { if (key === `${PREFIX}index`) throw refusal; };

    await expect(saveQuickTasks(SCOPE, [{ ...first, done: true }, second])).rejects.toBe(refusal);
    expect([...state.store.entries()].sort()).toEqual(before);
    state.beforeWrite = null;
    await saveQuickTasks(SCOPE, [second]);
    expect(await loadQuickTasks(SCOPE)).toEqual([second]);
  });
});
