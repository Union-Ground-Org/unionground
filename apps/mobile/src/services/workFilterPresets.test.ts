import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  values: new Map<string, string>(), getItemAsync: vi.fn(), setItemAsync: vi.fn(),
}));
vi.mock('expo-secure-store', () => ({ ...native, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only' }));
vi.mock('expo-crypto', () => ({ CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_algorithm: string, value: string) => createHash('sha256').update(value).digest('hex'),
}));
import { filterCurrentWorkTasks, WorkFilterPresets, workFilterScopeKey, type WorkFilterScope } from './workFilterPresets';

const scope: WorkFilterScope = { backend: 'https://test.example', account: 'test-account', organization: 'test-org', chapter: 'test-chapter' };
const key = workFilterScopeKey(scope);
const task = (id: string, status: string) => ({ id, identifier: id, title: `Task ${id}`, workstream: 'General', status });
const rows = [task('test-one', 'todo'), task('test-two', 'done')];

beforeEach(() => {
  native.values.clear();
  native.getItemAsync.mockReset().mockImplementation(async (name: string) => native.values.get(name) ?? null);
  native.setItemAsync.mockReset().mockImplementation(async (name: string, value: string) => { native.values.set(name, value); });
});

describe('personal chapter-work presets', () => {
  it('saves, reloads, applies, renames and deletes without persisting task rows or an active query', async () => {
    const first = new WorkFilterPresets(key);
    await first.load();
    expect(await first.change('save', 'Finished', 'done')).toBe(true);
    const reloaded = new WorkFilterPresets(key);
    await reloaded.load();
    const preset = reloaded.getSnapshot().presets[0]!;
    expect(filterCurrentWorkTasks(rows, preset.query)).toEqual([rows[1]]);
    expect(await reloaded.change('rename', 'Completed', '', 'Finished')).toBe(true);
    const renamed = new WorkFilterPresets(key);
    await renamed.load();
    expect(renamed.getSnapshot().presets).toEqual([{ name: 'Completed', query: 'done' }]);
    expect(JSON.parse([...native.values.values()][0]!)).toEqual({ version: 1, presets: [{ name: 'Completed', query: 'done' }] });
    expect(native.setItemAsync).toHaveBeenCalledWith(expect.stringMatching(/^union-ground\.work-filters\.v1\.[a-f0-9]{64}$/),
      expect.any(String), { keychainAccessible: 'device-only' });
    expect(await renamed.change('delete', 'Completed')).toBe(true);
    const deleted = new WorkFilterPresets(key);
    await deleted.load();
    expect(deleted.getSnapshot().presets).toEqual([]);
    expect(filterCurrentWorkTasks(rows, '')).toEqual(rows);
  });

  it('caps each scope at five and rejects blank names, queries and case-insensitive duplicates', async () => {
    const store = new WorkFilterPresets(key);
    await store.load();
    for (const [name, query] of [[' ', 'todo'], ['Useful', ' '], ['x'.repeat(33), 'todo'], ['Useful', 'x'.repeat(161)]]) {
      expect(await store.change('save', name!, query!)).toBe(false);
    }
    expect(await store.change('save', '  Open  ', '  todo  ')).toBe(true);
    expect(await store.change('save', 'OPEN', 'done')).toBe(false);
    expect(await store.change('save', 'Other', 'TODO')).toBe(false);
    for (let index = 1; index < 5; index += 1) expect(await store.change('save', `Preset ${index}`, `query ${index}`)).toBe(true);
    expect(await store.change('save', 'Sixth', 'six')).toBe(false);
    expect(store.getSnapshot().message).toContain('five');
    expect(store.getSnapshot().presets).toHaveLength(5);
    expect(await store.change('rename', 'PRESET 1', '', 'Open')).toBe(false);
    expect(await store.change('rename', ' ', '', 'Open')).toBe(false);
    expect(await store.change('rename', 'New', '', 'Missing')).toBe(false);
    expect(await store.change('delete', 'Missing')).toBe(false);
    expect(native.setItemAsync).toHaveBeenCalledTimes(5);
  });

  it.each(['backend', 'account', 'organization', 'chapter'] as const)('isolates %s without losing the original scope', async (field) => {
    const original = new WorkFilterPresets(key);
    await original.load(); await original.change('save', 'Open', 'todo');
    const other = new WorkFilterPresets(workFilterScopeKey({ ...scope, [field]: `${scope[field]}-other` }));
    await other.load();
    expect(other.getSnapshot().presets).toEqual([]);
    await other.change('save', 'Completed', 'done');
    const again = new WorkFilterPresets(key);
    await again.load();
    expect(again.getSnapshot().presets).toEqual([{ name: 'Open', query: 'todo' }]);
    expect(native.values.size).toBe(2);
  });

  it('refuses missing exact scope and distinguishes values that slugging would merge', () => {
    expect(() => workFilterScopeKey({ ...scope, account: '' })).toThrow('unavailable');
    expect(workFilterScopeKey({ ...scope, chapter: 'test:a' })).not.toBe(workFilterScopeKey({ ...scope, chapter: 'test_a' }));
  });

  it.each([
    'bad-json', 'null', '[]', '{}', JSON.stringify({ version: 2, presets: [] }),
    JSON.stringify({ version: 1, presets: Array.from({ length: 6 }, (_, n) => ({ name: `${n}`, query: `${n}` })) }),
    JSON.stringify({ version: 1, presets: [{ name: '', query: 'todo' }] }),
    JSON.stringify({ version: 1, presets: [{ name: 'Open', query: ' ' }] }),
    JSON.stringify({ version: 1, presets: [{ name: 'Open', query: '\n' }] }),
    JSON.stringify({ version: 1, presets: [{ name: 'x'.repeat(33), query: 'todo' }] }),
    JSON.stringify({ version: 1, presets: [{ name: 'Open', query: 'x'.repeat(161) }] }),
    JSON.stringify({ version: 1, presets: [{ name: 'Open', query: 'todo', tasks: rows }] }),
    JSON.stringify({ version: 1, presets: [], activeQuery: 'todo' }),
    JSON.stringify({ version: 1, presets: [{ name: 'Open', query: 'todo' }, { name: 'OPEN', query: 'done' }] }),
    JSON.stringify({ version: 1, presets: [{ name: 'Open', query: 'todo' }, { name: 'Other', query: 'TODO' }] }),
    'x'.repeat(1_801),
  ])('fails closed for invalid or obsolete storage %#', async (raw) => {
    native.getItemAsync.mockResolvedValue(raw);
    const store = new WorkFilterPresets(key);
    await store.load();
    expect(store.getSnapshot()).toMatchObject({ presets: [], ready: true, message: expect.stringContaining('No saved filter was applied') });
    expect(filterCurrentWorkTasks(rows, '')).toEqual(rows);
    expect(native.setItemAsync).not.toHaveBeenCalled();
  });

  it('ignores an obsolete preference read that completes after the latest read', async () => {
    const pending: Array<(value: string | null) => void> = [];
    const store = new WorkFilterPresets(key, { getItem: () => new Promise((resolve) => pending.push(resolve)), setItem: async () => undefined });
    const first = store.load();
    const second = store.load();
    pending[1]!(JSON.stringify({ version: 1, presets: [{ name: 'Open', query: 'todo' }] }));
    await second;
    pending[0]!(null); await first;
    expect(store.getSnapshot().presets).toHaveLength(1);
  });

  it('never widens authorized rows or hides a direct source target behind a filter', () => {
    expect(filterCurrentWorkTasks(rows, 'todo', 'test-two')).toEqual([rows[1]]);
    expect(filterCurrentWorkTasks([rows[0]!], 'done', 'test-two')).toEqual([]);
    expect(filterCurrentWorkTasks([rows[0]!], 'done')).toEqual([]);
  });

  it('reports native read/write failures and keeps the last durable presets usable', async () => {
    const store = new WorkFilterPresets(key);
    native.getItemAsync.mockRejectedValueOnce(new Error('locked'));
    await store.load();
    expect(store.getSnapshot().message).toContain('could not be restored');
    expect(store.getSnapshot().ready).toBe(false);
    expect(await store.change('save', 'Open', 'todo')).toBe(false);
    expect(native.setItemAsync).not.toHaveBeenCalled();
    await store.load();
    await store.change('save', 'Open', 'todo');
    native.setItemAsync.mockRejectedValueOnce(new Error('disk full'));
    expect(await store.change('save', 'Done', 'done')).toBe(false);
    expect(store.getSnapshot()).toMatchObject({ presets: [{ name: 'Open', query: 'todo' }], saving: false, message: expect.stringContaining('could not be updated') });
    expect(store.getSnapshot().message).not.toBe('Filter saved.');
  });

  it('preserves existing presets after a failed read until a successful retry authorizes edits', async () => {
    const seeded = new WorkFilterPresets(key);
    await seeded.load(); await seeded.change('save', 'Existing', 'todo');
    const original = [...native.values.values()][0];
    native.setItemAsync.mockClear();
    native.getItemAsync.mockRejectedValueOnce(new Error('device locked'));
    const store = new WorkFilterPresets(key);
    await store.load();
    expect(store.getSnapshot()).toMatchObject({ ready: false, presets: [] });
    const actions: Array<'save' | 'rename' | 'delete'> = ['save', 'rename', 'delete'];
    for (const action of actions) {
      expect(await store.change(action, 'New', 'done', 'Existing')).toBe(false);
    }
    expect(native.setItemAsync).not.toHaveBeenCalled();
    expect([...native.values.values()][0]).toBe(original);
    await store.load();
    expect(store.getSnapshot()).toMatchObject({ ready: true, presets: [{ name: 'Existing', query: 'todo' }] });
    expect(await store.change('save', 'New', 'done')).toBe(true);
    expect(JSON.parse([...native.values.values()][0]!)).toEqual({ version: 1,
      presets: [{ name: 'Existing', query: 'todo' }, { name: 'New', query: 'done' }] });
  });

  it('bounds UTF-8 bytes and rejects overlapping writes before they can lose a preset', async () => {
    const store = new WorkFilterPresets(key);
    expect(await store.change('save', 'Before load', 'todo')).toBe(false);
    await store.load();
    for (let index = 0; index < 2; index += 1) expect(await store.change('save', `${index}`, `${index}${'界'.repeat(159)}`)).toBe(true);
    expect(await store.change('save', 'Third', `3${'界'.repeat(159)}`)).toBe(true);
    expect(await store.change('save', 'Fourth', `4${'界'.repeat(159)}`)).toBe(false);
    expect(store.getSnapshot().message).toContain('Shorten');
    let release!: () => void;
    let started!: () => void;
    const writeStarted = new Promise<void>((resolve) => { started = resolve; });
    native.setItemAsync.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; started(); }));
    const pending = store.change('delete', '0');
    await writeStarted;
    expect(await store.change('delete', '1')).toBe(false);
    release(); expect(await pending).toBe(true);
  });
});
