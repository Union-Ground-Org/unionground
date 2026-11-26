import { utf8Bytes } from '../lib/publicLearning';

export const WORK_FILTER_LIMIT = 5;
export const WORK_FILTER_NAME_LIMIT = 32;
export const WORK_FILTER_QUERY_LIMIT = 160;
export type WorkFilterPreset = { name: string; query: string };
export type WorkFilterScope = { backend: string; account: string; organization: string; chapter: string };
type PreferenceStorage = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
type PresetState = { presets: WorkFilterPreset[]; ready: boolean; saving: boolean; message: string | null };

// Exact, ordered scope; no truncation, slugging or account identifiers in native keys.
export function workFilterScopeKey(scope: WorkFilterScope): string {
  if (Object.values(scope).some((value) => !value.trim())) throw new Error('Campaign scope is unavailable.');
  return JSON.stringify([scope.backend, scope.account, scope.organization, scope.chapter]);
}

async function nativeKey(scope: string): Promise<string> {
  const Crypto = await import('expo-crypto');
  return `union-ground.work-filters.v1.${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, scope)}`;
}

const protectedStorage: PreferenceStorage = {
  // Importing the shared task/events screen must not initialize native modules.
  getItem: async (scope) => {
    const SecureStore = await import('expo-secure-store');
    return SecureStore.getItemAsync(await nativeKey(scope));
  },
  setItem: async (scope, value) => {
    const SecureStore = await import('expo-secure-store');
    await SecureStore.setItemAsync(await nativeKey(scope), value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
};

function normalized(value: string): string { return value.trim().toLowerCase(); }
function validText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= limit
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function serialize(presets: WorkFilterPreset[]): string {
  const value = JSON.stringify({ version: 1, presets });
  // Keep each Keychain/Keystore value below the existing 1,800-byte chunk budget.
  const bytes = utf8Bytes(value);
  if (bytes > 1_800) throw new Error('Shorten a filter or name before saving another preset.');
  return value;
}

function parse(raw: string): WorkFilterPreset[] {
  if (raw.length > 1_800) throw new Error('Invalid presets');
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
    || !('presets' in value) || !Array.isArray(value.presets) || value.presets.length > WORK_FILTER_LIMIT
    || Object.keys(value).length !== 2) throw new Error('Invalid presets');
  const presets: WorkFilterPreset[] = [];
  for (const entry of value.presets as unknown[]) {
    if (!entry || typeof entry !== 'object' || !('name' in entry) || !('query' in entry)
      || Object.keys(entry).length !== 2 || !validText(entry.name, WORK_FILTER_NAME_LIMIT)
      || !validText(entry.query, WORK_FILTER_QUERY_LIMIT)
      || presets.some((preset) => normalized(preset.name) === normalized(entry.name as string)
        || normalized(preset.query) === normalized(entry.query as string))) throw new Error('Invalid presets');
    presets.push({ name: entry.name, query: entry.query });
  }
  serialize(presets);
  return presets;
}

/** Owns one authorized scope. Hydration never writes the member's active query. */
export class WorkFilterPresets {
  private state: PresetState = { presets: [], ready: false, saving: false, message: null };
  private listeners = new Set<() => void>();
  private loadRevision = 0;
  constructor(private scope: string, private storage: PreferenceStorage = protectedStorage) {}
  getSnapshot = (): PresetState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(next: PresetState): void {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }
  async load(): Promise<void> {
    if (this.state.saving) return;
    const revision = ++this.loadRevision;
    this.publish({ presets: [], ready: false, saving: false, message: null });
    let raw: string | null;
    try {
      raw = await this.storage.getItem(this.scope);
    } catch {
      // A failed read tells us nothing about the durable list. Mutations must
      // wait for a successful retry, rather than replacing it with an empty list.
      if (revision === this.loadRevision) this.publish({ presets: [], ready: false, saving: false,
        message: 'Saved filters could not be restored. Retry before changing saved filters; you can still filter campaign work.' });
      return;
    }
    if (revision !== this.loadRevision) return;
    try {
      const presets = raw === null ? [] : parse(raw);
      this.publish({ presets, ready: true, saving: false, message: null });
    } catch {
      if (revision === this.loadRevision) this.publish({ presets: [], ready: true, saving: false,
        message: 'Saved filters could not be restored. No saved filter was applied; you can still filter campaign work.' });
    }
  }
  async change(action: 'save' | 'rename' | 'delete', name: string, query = '', previousName = ''): Promise<boolean> {
    if (!this.state.ready || this.state.saving) return false;
    try {
      const nextName = name.trim();
      const nextQuery = query.trim();
      const previous = this.state.presets;
      if (action !== 'delete') {
        if (!validText(nextName, WORK_FILTER_NAME_LIMIT)) throw new Error('Enter a name of 1–32 characters.');
        if (previous.some((preset) => preset.name !== previousName && normalized(preset.name) === normalized(nextName))) {
          throw new Error('A saved filter already has that name.');
        }
      }
      let presets: WorkFilterPreset[];
      if (action === 'save') {
        if (previous.length >= WORK_FILTER_LIMIT) throw new Error('You can save up to five filters. Delete one first.');
        if (!validText(nextQuery, WORK_FILTER_QUERY_LIMIT)) throw new Error('Enter a filter of 1–160 characters.');
        if (previous.some((preset) => normalized(preset.query) === normalized(nextQuery))) throw new Error('That filter is already saved.');
        presets = [...previous, { name: nextName, query: nextQuery }];
      } else {
        const target = action === 'rename' ? previousName : name;
        if (!previous.some((preset) => preset.name === target)) throw new Error('That saved filter is unavailable.');
        presets = action === 'delete' ? previous.filter((preset) => preset.name !== target)
          : previous.map((preset) => preset.name === target ? { name: nextName, query: preset.query } : preset);
      }
      const value = serialize(presets);
      ++this.loadRevision;
      this.publish({ ...this.state, saving: true, message: null });
      try { await this.storage.setItem(this.scope, value); }
      catch { throw new Error('Saved filters could not be updated on this device. Your current filter is still available.'); }
      this.publish({ presets, ready: true, saving: false, message: action === 'delete' ? 'Filter deleted.' : 'Filter saved.' });
      return true;
    } catch (error) {
      this.publish({ ...this.state, saving: false, message: error instanceof Error ? error.message : 'Saved filters could not be updated.' });
      return false;
    }
  }
}

/** Only narrows the freshly authorized rows. Source links always keep their exact target. */
export function filterCurrentWorkTasks<T extends { id: string; identifier: string; title: string; workstream: string; status: string }>(
  tasks: T[], query: string, sourceID?: string,
): T[] {
  return tasks.filter((task) => sourceID ? task.id === sourceID
    : `${task.identifier} ${task.title} ${task.workstream} ${task.status}`.toLowerCase().includes(normalized(query)));
}
