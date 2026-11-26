import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeLearningItem,
  parseLearningRotationState,
  type LearningItem,
  type LearningKindFilter,
  type LearningLocale,
  type LearningPolicy,
} from '../../lib/learningContentModel';
import type { LearningContentApi, LearningListQuery } from '../../services/learningContent';
import {
  createLearningHomeController,
  createLearningLibraryController,
  createMemoryLearningNextStore,
  learningAdministrationAllowed,
  readLearningAdministration,
  type LearningNextStore,
  type LearningScopeContext,
} from './learningControllers';

const NOW = new Date(2026, 8, 29, 10, 0, 0).getTime();

function lesson(index: number, patch: Record<string, unknown> = {}): LearningItem {
  const item = normalizeLearningItem({
    id: `a1b2c3d4-0000-4000-8000-${String(index).padStart(12, '0')}`,
    scope: 'organization', organization_id: 'org-a', chapter_id: null, kind: index % 2 ? 'quote' : 'mini_lesson', locale: 'en',
    locale_state: 'reviewed', title: `Item ${index}`, body: `Body ${index}`, attribution: '', source: 'Campaign guide', bullets: [],
    topics: [], audience: 'all', tone: '', learning_outcome: '', factual_claims: false, priority: 0, is_default: false,
    status: 'published', starts_at: '2026-09-01T00:00:00Z', ends_at: null, revision: 2, ...patch,
  });
  if (!item) throw new Error('fixture did not normalize');
  return item;
}

function policy(patch: Partial<LearningPolicy> = {}): LearningPolicy {
  return { organizationId: 'org-a', chapterId: 'chapter-a', quotesEnabled: true, lessonsEnabled: true, homeHidden: false, canManage: false, isPlatformOwner: false, version: 'v1', ...patch };
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fakeApi(options: { policy?: () => LearningPolicy | Promise<LearningPolicy>; items?: (query: LearningListQuery) => LearningItem[] | Promise<LearningItem[]>; hasMore?: boolean } = {}) {
  const getPolicy = vi.fn(async (_chapterId: string | null) => (options.policy ? options.policy() : policy()));
  const listContent = vi.fn(async (query: LearningListQuery) => ({ items: await (options.items ? options.items(query) : []), hasMore: options.hasMore ?? false, dropped: 0 }));
  const setHomeHidden = vi.fn(async ({ hidden }: { chapterId: string | null; hidden: boolean }) => hidden);
  const unused = vi.fn(async () => { throw new Error('not used by the worker controllers'); });
  const api: LearningContentApi = {
    getPolicy, listContent, setHomeHidden,
    listChoices: unused, getWorkspace: unused, savePolicy: unused, saveContent: unused, transition: unused, getHistory: unused,
  };
  return { api, getPolicy, listContent, setHomeHidden, unused };
}

function context(api: LearningContentApi, patch: Partial<LearningScopeContext> = {}, nextStore: LearningNextStore = createMemoryLearningNextStore()): LearningScopeContext {
  return {
    scopeKey: 'live|1|user-a|org-a|chapter-a|en|', source: 'live', userId: 'user-a', organizationId: 'org-a', chapterId: 'chapter-a',
    locale: 'en', api, nextStore, captureGuard: () => () => true, clock: () => Date.now(), ...patch,
  };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Home: policy first, content only for enabled kinds', () => {
  it.each<[string, Partial<LearningPolicy>, LearningKindFilter | 'none']>([
    ['both modules', {}, null],
    ['quotes only', { lessonsEnabled: false }, 'quote'],
    ['lessons only', { quotesEnabled: false }, 'mini_lesson'],
    ['both off', { quotesEnabled: false, lessonsEnabled: false }, 'none'],
    ['hidden Home', { homeHidden: true }, 'none'],
  ])('%s', async (_label, patch, expected) => {
    const fake = fakeApi({ policy: () => policy(patch) });
    const home = createLearningHomeController(context(fake.api));
    await home.refreshPolicy();
    expect(fake.getPolicy).toHaveBeenCalledWith('chapter-a');
    if (expected === 'none') expect(fake.listContent).not.toHaveBeenCalled();
    else expect(fake.listContent).toHaveBeenCalledWith({ chapterId: 'chapter-a', locale: 'en', kind: expected, offset: 0, limit: 100 });
    home.dispose();
  });

  it('polls only the policy, once a minute while active, and refreshes on focus or foreground', async () => {
    const fake = fakeApi({ items: () => [lesson(1)] });
    const home = createLearningHomeController(context(fake.api));
    home.setActive(true);
    await settle();
    expect(fake.getPolicy).toHaveBeenCalledTimes(1);
    expect(fake.listContent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.getPolicy).toHaveBeenCalledTimes(2);
    // An unchanged version keeps the cached batch: the poll reads no content.
    expect(fake.listContent).toHaveBeenCalledTimes(1);
    home.setActive(false);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fake.getPolicy).toHaveBeenCalledTimes(2);
    home.setActive(true);
    await settle();
    expect(fake.getPolicy).toHaveBeenCalledTimes(3);
    home.dispose();
  });

  it('invalidates the cache when the policy version changes', async () => {
    let version = 'v1';
    const second = deferred<LearningItem[]>();
    const fake = fakeApi({ policy: () => policy({ version }), items: () => (version === 'v1' ? [lesson(1)] : second.promise) });
    const home = createLearningHomeController(context(fake.api));
    await home.refreshPolicy();
    expect(home.getSnapshot().items).toHaveLength(1);
    version = 'v2';
    const reload = home.refreshPolicy();
    await settle();
    // The new version clears the old batch before the new one arrives.
    expect(home.getSnapshot()).toMatchObject({ status: 'loading', items: [], loaded: false });
    expect(home.view(NOW).current).toBeNull();
    second.resolve([lesson(3)]);
    await reload;
    expect(fake.listContent).toHaveBeenCalledTimes(2);
    expect(home.getSnapshot()).toMatchObject({ status: 'ready', itemsVersion: 'v2' });
    home.dispose();
  });

  it('fails closed: a policy error clears cached content', async () => {
    let fail = false;
    const fake = fakeApi({ policy: () => (fail ? Promise.reject(new Error('offline')) : policy()), items: () => [lesson(1)] });
    const home = createLearningHomeController(context(fake.api));
    await home.refreshPolicy();
    expect(home.view(NOW).current?.title).toBe('Item 1');
    fail = true;
    await home.refreshPolicy();
    expect(home.getSnapshot()).toMatchObject({ status: 'unavailable', policy: null, items: [] });
    expect(home.view(NOW).current).toBeNull();
    home.dispose();
  });

  it('drops answers that arrive after the scope changed or the session moved on', async () => {
    const pending = deferred<LearningItem[]>();
    const fake = fakeApi({ items: () => pending.promise });
    const disposed = createLearningHomeController(context(fake.api));
    const load = disposed.refreshPolicy();
    await settle();
    disposed.dispose();
    pending.resolve([lesson(1)]);
    await load;
    expect(disposed.getSnapshot().items).toEqual([]);

    let current = true;
    const guarded = createLearningHomeController(context(fakeApi({ items: () => [lesson(2)] }).api, { captureGuard: () => () => current }));
    const refresh = guarded.refreshPolicy();
    current = false;
    await refresh;
    expect(guarded.getSnapshot().policy).toBeNull();
    guarded.dispose();
  });
});

describe('Home: delivery at render, Next and timers', () => {
  it('never shows another locale, a disabled kind, or an expired item', async () => {
    const items = [
      lesson(1, { locale: 'es' }),
      lesson(2, { kind: 'quote' }),
      lesson(3, { kind: 'mini_lesson', ends_at: new Date(NOW + 60_000).toISOString() }),
    ];
    const fake = fakeApi({ policy: () => policy({ quotesEnabled: false }), items: () => items });
    const home = createLearningHomeController(context(fake.api));
    await home.refreshPolicy();
    expect(home.view(NOW)).toMatchObject({ total: 1, current: { title: 'Item 3' } });
    expect(home.view(NOW + 61_000).current).toBeNull();
    home.dispose();
  });

  it('re-renders when a cached item expires', async () => {
    const fake = fakeApi({ items: () => [lesson(1, { ends_at: new Date(NOW + 5_000).toISOString() }), lesson(2)] });
    const home = createLearningHomeController(context(fake.api));
    await home.refreshPolicy();
    const listener = vi.fn();
    home.subscribe(listener);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listener).toHaveBeenCalled();
    expect(home.view().total).toBe(1);
    home.dispose();
  });

  it('shows a Spanish reader only Spanish content, with no English fallback', async () => {
    const fake = fakeApi({ items: (query) => [lesson(1, { locale: query.locale }), lesson(2, { locale: 'en' })] });
    const home = createLearningHomeController(context(fake.api, { locale: 'es' as LearningLocale }));
    await home.refreshPolicy();
    expect(fake.listContent.mock.calls[0]?.[0]).toMatchObject({ locale: 'es' });
    expect(home.view(NOW)).toMatchObject({ total: 1, current: { locale: 'es' } });
    home.dispose();
  });

  it('advances Next locally, persists the day and position, and wraps', async () => {
    const store = createMemoryLearningNextStore();
    const write = vi.spyOn(store, 'write');
    const fake = fakeApi({ items: () => [lesson(1), lesson(2), lesson(3)] });
    const home = createLearningHomeController(context(fake.api, {}, store));
    await home.refreshPolicy();
    const calls = fake.getPolicy.mock.calls.length + fake.listContent.mock.calls.length;
    const seen = [home.view(NOW).current?.id];
    for (let step = 0; step < 3; step += 1) {
      home.next();
      seen.push(home.view(NOW).current?.id);
    }
    expect(fake.getPolicy.mock.calls.length + fake.listContent.mock.calls.length).toBe(calls);
    expect(new Set(seen.slice(0, 3)).size).toBe(3);
    expect(seen[3]).toBe(seen[0]);
    const stored = write.mock.calls.at(-1)?.[1] ?? null;
    expect(parseLearningRotationState(stored, '2026-09-29')).toBe(home.view(NOW).index);
    expect(home.view(NOW).position).toBe(1);
    home.dispose();
  });

  it('keeps the same order all day and restores a stored position only for today', async () => {
    const items = [lesson(1), lesson(2), lesson(3), lesson(4)];
    const store = createMemoryLearningNextStore();
    const first = createLearningHomeController(context(fakeApi({ items: () => items }).api, {}, store));
    await first.refreshPolicy();
    first.next();
    const chosen = first.view(NOW).current?.id;
    first.dispose();
    const second = createLearningHomeController(context(fakeApi({ items: () => [...items].reverse() }).api, {}, store));
    second.start();
    await second.refreshPolicy();
    await settle();
    expect(second.view(NOW).current?.id).toBe(chosen);
    const tomorrow = new Date(2026, 8, 30, 10, 0, 0).getTime();
    expect(second.view(tomorrow).position).toBe(1);
    second.dispose();
  });

  it('hides Home through the durable preference and then reads nothing', async () => {
    const fake = fakeApi({ items: () => [lesson(1)] });
    const home = createLearningHomeController(context(fake.api));
    await home.refreshPolicy();
    await home.hide();
    expect(fake.setHomeHidden).toHaveBeenCalledWith({ chapterId: 'chapter-a', hidden: true });
    expect(home.getSnapshot()).toMatchObject({ status: 'hidden', hiddenJustNow: true, items: [] });
    expect(home.view(NOW).current).toBeNull();
    home.dispose();
  });

  it('keeps the card when hiding fails', async () => {
    const fake = fakeApi({ items: () => [lesson(1)] });
    fake.setHomeHidden.mockRejectedValueOnce(new Error('offline'));
    const home = createLearningHomeController(context(fake.api));
    await home.refreshPolicy();
    await home.hide();
    expect(home.getSnapshot()).toMatchObject({ hideError: true, status: 'ready' });
    home.dispose();
  });
});

describe('Learn library', () => {
  it('reads mini-lessons forty at a time and pages by offset', async () => {
    const fake = fakeApi({ items: (query) => [lesson(query.offset + 2)], hasMore: true });
    const library = createLearningLibraryController(context(fake.api));
    await library.refreshPolicy();
    await library.loadMore();
    expect(fake.listContent.mock.calls.map((call) => call[0])).toEqual([
      { chapterId: 'chapter-a', locale: 'en', kind: 'mini_lesson', offset: 0, limit: 40 },
      { chapterId: 'chapter-a', locale: 'en', kind: 'mini_lesson', offset: 40, limit: 40 },
    ]);
    expect(library.lessons(NOW).map((item) => item.title)).toEqual(['Item 2', 'Item 42']);
    library.dispose();
  });

  it('reads nothing while lessons are off and drops what it had', async () => {
    let lessonsEnabled = true;
    const fake = fakeApi({ policy: () => policy({ lessonsEnabled, version: lessonsEnabled ? 'v1' : 'v2' }), items: () => [lesson(2)] });
    const library = createLearningLibraryController(context(fake.api));
    await library.refreshPolicy();
    expect(library.lessons(NOW)).toHaveLength(1);
    lessonsEnabled = false;
    await library.refreshPolicy();
    expect(library.getSnapshot()).toMatchObject({ status: 'disabled', items: [] });
    expect(fake.listContent).toHaveBeenCalledTimes(1);
    library.dispose();
  });

  it('restores Home through the durable preference', async () => {
    const fake = fakeApi({ policy: () => policy({ homeHidden: true }), items: () => [lesson(2)] });
    const library = createLearningLibraryController(context(fake.api));
    await library.refreshPolicy();
    await library.restoreHome();
    expect(fake.setHomeHidden).toHaveBeenCalledWith({ chapterId: 'chapter-a', hidden: false });
    expect(library.getSnapshot()).toMatchObject({ restoredJustNow: true, policy: { homeHidden: false } });
    library.dispose();
  });
});

describe('Account administration entrance', () => {
  it.each<[string, Partial<LearningPolicy>, boolean]>([
    ['member', {}, false],
    ['campaign or organization manager', { canManage: true }, true],
    ['platform owner', { isPlatformOwner: true }, true],
    ['platform owner without a tenant', { isPlatformOwner: true, organizationId: null, chapterId: null }, true],
  ])('%s', async (_label, patch, allowed) => {
    const fake = fakeApi({ policy: () => policy(patch) });
    const result = await readLearningAdministration({ api: fake.api, chapterId: patch.chapterId === undefined ? 'chapter-a' : patch.chapterId });
    expect(result !== null).toBe(allowed);
    expect(learningAdministrationAllowed(result)).toBe(allowed);
    // One policy-only read: no content, workspace, choices or history.
    expect(fake.getPolicy).toHaveBeenCalledTimes(1);
    expect(fake.listContent).not.toHaveBeenCalled();
    expect(fake.unused).not.toHaveBeenCalled();
  });

  it('stays hidden when the policy cannot be confirmed', async () => {
    const fake = fakeApi({ policy: () => Promise.reject(new Error('forbidden')) });
    await expect(readLearningAdministration({ api: fake.api, chapterId: 'chapter-a' })).resolves.toBeNull();
    expect(learningAdministrationAllowed(null)).toBe(false);
  });
});
