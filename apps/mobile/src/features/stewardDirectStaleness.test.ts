// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemberConversation } from '../models/member';

// BUG-UG-NATIVE-STEWARD-DIRECT-INBOX-STOPS-AT-100-20261109 (G6 r5/r6):
// the mounted hook against a stub server whose every read takes a fixed time,
// with the summary poll publishing a new first page every 30 seconds. At every
// simulated second no row beyond the first page may be on screen 60 seconds
// (two polls) or more after the start of the last read that returned it,
// measured on elapsed time (the monotonic clock here), so changing the device
// time cannot stretch it. A first page counts from the moment it arrives, the
// only time the hook sees. Fictional Tamarack rows only.

const POLL_MS = 30_000;
const STALE_MS = 60_000;
const PAGE = 100;

const server = vi.hoisted(() => ({
  load: (_options: { search?: string | null; after?: { updatedAt: string; id: string } | null }): Promise<unknown> => Promise.reject(new Error('unset')),
}));
vi.mock('../services/supabase', () => ({ loadStewardDirectPage: (options: never) => server.load(options) }));
const appState = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>() }));
vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appState.listeners.add(listener);
      return { remove: () => appState.listeners.delete(listener) };
    },
  },
}));

import { useStewardDirectPages, type StewardDirectPages } from './useStewardDirectPages';

type Row = MemberConversation;
const BASE = Date.parse('2026-11-09T15:00:00.000Z');

function row(number: number, minute = Math.floor(number / 7)): Row {
  const label = String(number).padStart(3, '0');
  const updatedAt = new Date(BASE - minute * 60_000).toISOString();
  return { id: `00000000-0000-4000-8000-000000000${label}`, title: `Tamarack Worker ${label}`, initials: 'TM', createdAt: updatedAt, updatedAt, unreadCount: 1, latestMessage: `Question ${label}` };
}

// A row as shown: a reply changes its time and its preview.
function version(item: Row): string {
  return `${item.id}|${item.updatedAt}|${item.latestMessage ?? ''}`;
}

function newerFirst(a: Row, b: Row): number {
  return a.updatedAt === b.updatedAt ? b.id.localeCompare(a.id) : b.updatedAt.localeCompare(a.updatedAt);
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

type World = {
  catalog: Row[];
  latency: number;
  failDeeper: boolean;
  firstPage: Row[];
  query: string;
  scope: string;
  /** Reads still to start that never settle. */
  hang: number;
  /** Answer with the catalog as it was when the read started (a late, old answer). */
  snapshot: boolean;
  /** Start of the last read (or arrival of the last first page) that returned each row. */
  lastReturn: Map<string, number>;
  inFlight: { browse: number; search: number };
  /** Most reads in flight at once that no query or scope change had dropped. */
  maxInFlight: { browse: number; search: number };
  live: { browse: number[]; search: number[] };
  dropped: { browse: number; search: number };
  reads: number;
  deliveries: number;
  presses: number;
  violations: string[];
};

let root: Root;
let host: HTMLDivElement;
let world: World;
let latest: StewardDirectPages | null = null;
let renders: MemberConversation[][] = [];

function order(): Row[] {
  return [...world.catalog].sort(newerFirst);
}

function Harness({ firstPage, query, scopeKey }: { firstPage: Row[]; query: string; scopeKey: string }) {
  latest = useStewardDirectPages({ enabled: true, scopeKey, firstPage, query, staleAfterMs: STALE_MS });
  renders.push(latest.conversations);
  return null;
}

function rerender() {
  root.render(createElement(Harness, { firstPage: world.firstPage, query: world.query, scopeKey: world.scope }));
}

function serve(options: { search?: string | null; after?: { updatedAt: string; id: string } | null }): Promise<unknown> {
  const kind = options.search ? 'search' : 'browse';
  const startedAt = performance.now();
  world.reads += 1;
  world.inFlight[kind] += 1;
  world.live[kind] = world.live[kind].filter((started) => started >= world.dropped[kind]);
  world.live[kind].push(startedAt);
  world.maxInFlight[kind] = Math.max(world.maxInFlight[kind], world.live[kind].length);
  if (world.hang > 0) {
    world.hang -= 1;
    return new Promise(() => undefined);
  }
  const atStart = world.snapshot ? order() : null;
  return new Promise((resolve, reject) => {
    const settle = () => {
      world.inFlight[kind] -= 1;
      world.live[kind] = world.live[kind].filter((started) => started !== startedAt);
      if (world.failDeeper && options.after) {
        reject(new Error('Worker conversations did not load. Try again.'));
        return;
      }
      const needle = options.search?.trim().toLowerCase() ?? null;
      const after = options.after;
      const rows = (atStart ?? order())
        .filter((item) => !needle || item.title.toLowerCase().includes(needle))
        .filter((item) => !after || item.updatedAt < after.updatedAt || (item.updatedAt === after.updatedAt && item.id < after.id))
        .slice(0, PAGE);
      for (const item of rows) world.lastReturn.set(version(item), Math.max(world.lastReturn.get(version(item)) ?? -Infinity, startedAt));
      const last = rows[rows.length - 1];
      resolve({ rows, next: rows.length === PAGE && last ? { updatedAt: last.updatedAt, id: last.id } : null, total: null });
    };
    if (world.latency === 0) queueMicrotask(settle);
    else setTimeout(settle, world.latency);
  });
}

// The summary poll: a first-page read every 30 seconds, never two at once.
function startPoller(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = () => {
    if (stopped) return;
    const scheduled = Date.now();
    const deliver = () => {
      if (stopped) return;
      world.firstPage = order().slice(0, PAGE);
      const now = performance.now();
      for (const item of world.firstPage) world.lastReturn.set(version(item), now);
      world.deliveries += 1;
      rerender();
      timer = setTimeout(tick, Math.max(0, scheduled + POLL_MS - Date.now()));
    };
    if (world.latency === 0) deliver();
    else timer = setTimeout(deliver, world.latency);
  };
  timer = setTimeout(tick, POLL_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

function check(label: string) {
  const conversations = latest?.conversations ?? [];
  const ids = conversations.map((item) => item.id);
  if (new Set(ids).size !== ids.length) world.violations.push(`${label}: duplicate rows`);
  const onFirstPage = new Set(world.firstPage.map(version));
  const now = performance.now();
  for (const item of conversations) {
    if (onFirstPage.has(version(item))) continue;
    const returned = world.lastReturn.get(version(item));
    if (returned === undefined || now - returned >= STALE_MS) {
      world.violations.push(`${label}: ${item.title} on screen ${returned === undefined ? 'never returned' : `${Math.round((now - returned) / 1000)} s after its last read`}`);
    }
  }
}

async function second(label: string, steps = 1) {
  for (let step = 0; step < steps; step += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    check(label);
  }
}

async function settle(label: string, limit = 400) {
  for (let step = 0; step < limit && latest?.status === 'loading'; step += 1) await second(label);
}

async function mount(catalog: Row[], latency: number) {
  world = {
    catalog,
    latency,
    failDeeper: false,
    firstPage: [],
    query: '',
    scope: 'steward-1|tamarack|north',
    hang: 0,
    snapshot: false,
    lastReturn: new Map(),
    inFlight: { browse: 0, search: 0 },
    maxInFlight: { browse: 0, search: 0 },
    live: { browse: [], search: [] },
    dropped: { browse: -Infinity, search: -Infinity },
    reads: 0,
    deliveries: 0,
    presses: 0,
    violations: [],
  };
  server.load = serve;
  world.firstPage = order().slice(0, PAGE);
  for (const item of world.firstPage) world.lastReturn.set(version(item), performance.now());
  await act(async () => { rerender(); });
}

function press(action: 'older' | 'more') {
  if (!latest) return;
  world.presses += 1;
  act(() => { (action === 'older' ? latest!.loadOlder : latest!.loadMore)(); });
}

async function openPages(total: number, label: string) {
  for (let page = 1; page < total; page += 1) {
    press('older');
    await settle(label);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  vi.setSystemTime(BASE + 3_600_000);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  latest = null;
  renders = [];
  appState.listeners.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('Committee Direct rows never outlive their last read by two polls', () => {
  it('Sol r5/r6: 300 of 350 loaded, depth 150 removed, 20 second reads, 30 second polls', async () => {
    await mount(Array.from({ length: 350 }, (_, index) => row(index + 1)), 20_000);
    const stop = startPoller();
    await openPages(3, 'open');
    expect(latest?.conversations).toHaveLength(300);
    const removed = order()[150]!;
    world.catalog = world.catalog.filter((item) => item.id !== removed.id);
    let goneAt: number | null = null;
    const removedAt = performance.now();
    for (let step = 0; step < 240; step += 1) {
      await second('sol');
      if (goneAt === null && !latest?.conversations.some((item) => item.id === removed.id)) goneAt = performance.now();
    }
    stop();
    expect(world.violations).toEqual([]);
    expect(goneAt).not.toBeNull();
    // Its last read began before the removal, so it left within the bound.
    expect(goneAt! - removedAt).toBeLessThanOrEqual(STALE_MS);
    expect(world.maxInFlight.browse).toBe(1);
  });

  it('Deeper reads that fail leave unconfirmed rows within the bound and show no error', async () => {
    await mount(Array.from({ length: 350 }, (_, index) => row(index + 1)), 5_000);
    const stop = startPoller();
    await openPages(3, 'open');
    const removed = order()[150]!;
    world.catalog = world.catalog.filter((item) => item.id !== removed.id);
    world.failDeeper = true;
    for (let step = 0; step < 150; step += 1) {
      await second('failing');
      expect(latest?.status).not.toBe('error');
    }
    // Nothing beyond the first page could be confirmed: the list is the first
    // page and offers Show older again.
    expect(latest?.conversations).toHaveLength(100);
    expect(latest?.hasMore).toBe(true);
    world.failDeeper = false;
    await second('recovered', 60);
    stop();
    expect(world.violations).toEqual([]);
    expect(latest?.conversations.map((item) => item.id)).toEqual(order().slice(0, 300).map((item) => item.id));
  });

  it('A completed cycle clears an earlier paging error, and Try again always asks', async () => {
    await mount(Array.from({ length: 350 }, (_, index) => row(index + 1)), 5_000);
    const stop = startPoller();
    await openPages(2, 'open');
    world.failDeeper = true;
    press('older');
    await settle('failing press');
    expect(latest?.status).toBe('error');
    let reads = world.reads;
    press('more');
    expect(latest?.status).toBe('loading');
    await settle('retry fails');
    expect(world.reads).toBeGreaterThan(reads);
    expect(latest?.status).toBe('error');
    world.failDeeper = false;
    // The next poll's cycle succeeds and clears the error.
    await second('cycle', 40);
    expect(latest?.status).toBe('idle');
    world.failDeeper = true;
    press('older');
    await settle('failing again');
    expect(latest?.status).toBe('error');
    world.failDeeper = false;
    reads = world.reads;
    press('more');
    await settle('retry');
    expect(world.reads).toBeGreaterThan(reads);
    expect(latest?.status).toBe('idle');
    expect(latest?.conversations).toHaveLength(300);
    stop();
    expect(world.violations).toEqual([]);
  });

  it('a reply on the first page is what stays when newer conversations push the row off it', async () => {
    await mount(Array.from({ length: 350 }, (_, index) => row(index + 1)), 0);
    const stop = startPoller();
    await openPages(3, 'open');
    const target = order()[50]!;
    const replied = new Date(Date.now()).toISOString();
    world.catalog = world.catalog.map((item) => (item.id === target.id ? { ...item, updatedAt: replied, createdAt: replied, latestMessage: 'Reply on the first page' } : item));
    await second('replied', 90);
    // 120 newer conversations push it below the first page; deeper reads fail,
    // so only what the hook already holds can show it.
    world.catalog = [...world.catalog, ...Array.from({ length: 120 }, (_, index) => {
      const at = new Date(Date.now() + (index + 1) * 1_000).toISOString();
      return { ...row(351 + index), id: `00000000-0000-4000-8000-000000001${String(index).padStart(3, '0')}`, updatedAt: at, createdAt: at };
    })];
    world.failDeeper = true;
    await second('pushed off', 90);
    stop();
    expect(world.violations).toEqual([]);
  });

  it('a cut timer that fires early because the two clocks drift still cuts on time', async () => {
    await mount(Array.from({ length: 350 }, (_, index) => row(index + 1)), 0);
    await openPages(3, 'open');
    expect(latest?.conversations).toHaveLength(300);
    // The monotonic clock reads 10 ms ahead and then stalls, so the timer is
    // set by it and fires 10 ms before the wall clock reaches the bound. With
    // no poll and no other render, the cut must still happen on time.
    const ahead = performance.now() + 10;
    vi.spyOn(performance, 'now').mockImplementation(() => ahead);
    await act(async () => { rerender(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(STALE_MS + 1_000); });
    expect(latest?.conversations).toHaveLength(100);
    vi.restoreAllMocks();
  });

  it('Sol r8: with exactly 100 conversations, a 101st authorized later appears without a press', async () => {
    await mount(Array.from({ length: 100 }, (_, index) => row(index + 1)), 0);
    const stop = startPoller();
    press('older');
    await settle('empty continuation');
    expect(latest?.ended).toBe(true);
    expect(latest?.olderHasMore).toBe(false);
    const gained = { ...row(101), updatedAt: new Date(BASE - 86_400_000).toISOString() };
    world.catalog = [...world.catalog, gained];
    const reads = world.reads;
    await second('gained', 3 * 30);
    stop();
    expect(latest?.conversations.map((item) => item.id)).toContain(gained.id);
    expect(latest?.conversations).toHaveLength(101);
    // One read per cycle for a stream that had ended with nothing more.
    expect(world.reads - reads).toBeLessThanOrEqual(3);
    expect(world.violations).toEqual([]);
  });

  it('Sol r8: a search that found nothing finds a match authorized later', async () => {
    await mount(Array.from({ length: 350 }, (_, index) => row(index + 1)), 0);
    const stop = startPoller();
    world.query = 'new search match';
    await act(async () => { rerender(); });
    await second('searching', 2);
    expect(latest?.searching).toBe(true);
    expect(latest?.ended).toBe(true);
    const target = order()[220]!;
    world.catalog = world.catalog.map((item) => (item.id === target.id ? { ...item, title: 'Tamarack new search match' } : item));
    await second('match authorized', 3 * 30);
    stop();
    expect(latest?.conversations.map((item) => item.id)).toContain(target.id);
    expect(world.violations).toEqual([]);
  });

  it('Sol r8: a cancelled search read that never settles does not hold up the next term', async () => {
    await mount(Array.from({ length: 350 }, (_, index) => row(index + 1)), 0);
    world.hang = 1;
    world.query = 'worker 150';
    await act(async () => { rerender(); });
    await second('hung search', 2);
    expect(latest?.status).toBe('loading');
    const reads = world.reads;
    world.query = 'worker 149';
    world.dropped.search = performance.now();
    await act(async () => { rerender(); });
    await second('next term', 2);
    expect(world.reads).toBe(reads + 1);
    expect(latest?.status).toBe('idle');
    expect(latest?.conversations.map((item) => item.title)).toContain('Tamarack Worker 149');
  });

  it('Sol r8: a cancelled read that never settles does not hold up the next account', async () => {
    await mount(Array.from({ length: 350 }, (_, index) => row(index + 1)), 0);
    world.hang = 1;
    press('older');
    await second('hung', 2);
    expect(latest?.olderStatus).toBe('loading');
    world.scope = 'steward-2|tamarack|north';
    world.dropped.browse = performance.now();
    await act(async () => { rerender(); });
    const reads = world.reads;
    press('older');
    await settle('next account');
    expect(world.reads).toBe(reads + 1);
    expect(latest?.conversations).toHaveLength(200);
  });

  it('Grok final4 P1: a parent render 90 seconds after the read, before the timer runs, shows no aged row', async () => {
    await mount(Array.from({ length: 350 }, (_, index) => row(index + 1)), 0);
    await openPages(2, 'open');
    expect(latest?.conversations).toHaveLength(200);
    // Both clocks move 90 seconds with no timer turn (the timer has time left).
    vi.setSystemTime(Date.now() + 90_000);
    const mono = performance.now() + 90_000;
    vi.spyOn(performance, 'now').mockImplementation(() => mono);
    renders = [];
    await act(async () => { rerender(); });
    expect(renders.length).toBeGreaterThan(0);
    for (const painted of renders) expect(painted).toHaveLength(100);
    vi.restoreAllMocks();
  });

  it('Grok final4 P2: after the device time is set back, the cut still runs with no other render', async () => {
    await mount(Array.from({ length: 350 }, (_, index) => row(index + 1)), 0);
    await openPages(2, 'open');
    vi.setSystemTime(Date.now() - 3_600_000);
    // No poll, no read landing, no press: only the cut timer can act.
    await act(async () => { await vi.advanceTimersByTimeAsync(STALE_MS + 1_000); });
    expect(latest?.conversations).toHaveLength(100);
    expect(latest?.hasMore).toBe(true);
  });

  it('Sol r8: with 45 second reads a page that ages out is refilled automatically at most once', async () => {
    await mount(Array.from({ length: 350 }, (_, index) => row(index + 1)), 45_000);
    const stop = startPoller();
    press('older');
    const sizes: number[] = [];
    for (let step = 0; step < 600; step += 1) {
      await second('slow reads');
      const size = latest?.conversations.length ?? 0;
      if (sizes[sizes.length - 1] !== size) sizes.push(size);
    }
    stop();
    expect(world.violations).toEqual([]);
    // Opened, aged out, refilled once, aged out again, then left short.
    expect(sizes.filter((size) => size === 200).length).toBeLessThanOrEqual(2);
    expect(sizes[sizes.length - 1]).toBe(100);
    expect(latest?.hasMore).toBe(true);
    const reads = world.reads;
    await second('parked', 120);
    expect(world.reads).toBe(reads);
  });

  it('scope ruling: the first page itself keeps the dashboard poll terms when polls stop', async () => {
    await mount(Array.from({ length: 350 }, (_, index) => row(index + 1)), 0);
    await openPages(3, 'open');
    // No poll arrives for five minutes: rows below the first page leave at T,
    // the first page stays as the dashboard holds it (as on Main).
    await second('no polls', 300);
    expect(latest?.conversations.map((item) => item.id)).toEqual(world.firstPage.map((item) => item.id));
    expect(latest?.hasMore).toBe(true);
  });

  function deliver() {
    world.firstPage = order().slice(0, PAGE);
    const now = performance.now();
    for (const item of world.firstPage) world.lastReturn.set(version(item), now);
    world.deliveries += 1;
    return act(async () => { rerender(); });
  }

  it('Sol final5 r9s1: a late answer from before a short first page never comes back with the next full one', async () => {
    await mount(Array.from({ length: 101 }, (_, index) => row(index + 1)), 0);
    await openPages(2, 'open');
    expect(latest?.conversations).toHaveLength(101);
    // A cycle starts and its answer is held; it will carry the old list.
    world.latency = 10_000;
    world.snapshot = true;
    await deliver();
    await second('held', 5);
    // Two members are revoked: the first page is the whole list of 99.
    const revoked = [order()[10]!, order()[100]!];
    world.catalog = world.catalog.filter((item) => !revoked.some((gone) => gone.id === item.id));
    await deliver();
    expect(latest?.conversations).toHaveLength(99);
    await second('old answer lands', 5);
    expect(latest?.conversations).toHaveLength(99);
    // Another conversation is authorized: the first page is full again.
    world.snapshot = false;
    world.latency = 0;
    const added = { ...row(102), updatedAt: new Date(Date.now()).toISOString(), createdAt: new Date(Date.now()).toISOString() };
    world.catalog = [...world.catalog, added];
    renders = [];
    await deliver();
    await second('full again', 30);
    for (const painted of renders) {
      for (const gone of revoked) {
        expect(painted.some((item) => item.id === gone.id), gone.title).toBe(false);
        expect(painted.some((item) => item.latestMessage === gone.latestMessage), gone.latestMessage ?? '').toBe(false);
      }
    }
    expect(latest?.conversations.map((item) => item.id)).toEqual(order().map((item) => item.id));
  });

  it('Sol final5 r10s1: a row a reply moved onto the first page never shows its old copy again', async () => {
    await mount(Array.from({ length: 350 }, (_, index) => row(index + 1)), 0);
    await openPages(3, 'open');
    const target = order()[150]!;
    // Deeper reads are held from here on, so only the first page confirms.
    world.hang = 1_000;
    const replied = new Date(Date.now()).toISOString();
    world.catalog = world.catalog.map((item) => (item.id === target.id ? { ...item, updatedAt: replied, createdAt: replied, latestMessage: 'Fresh reply', unreadCount: 7 } : item));
    await deliver();
    await second('moved up', 5);
    expect(latest?.conversations.find((item) => item.id === target.id)?.latestMessage).toBe('Fresh reply');
    // 120 newer conversations push it off the first page.
    world.catalog = [...world.catalog, ...Array.from({ length: 120 }, (_, index) => {
      const at = new Date(Date.now() + (index + 1) * 1_000).toISOString();
      return { ...row(351 + index), id: `00000000-0000-4000-8000-000000002${String(index).padStart(3, '0')}`, updatedAt: at, createdAt: at };
    })];
    renders = [];
    await deliver();
    await second('pushed off', 20);
    for (const painted of renders) {
      const shown = painted.find((item) => item.id === target.id);
      if (shown) expect(shown.latestMessage).toBe('Fresh reply');
    }
  });

  it('device time set back an hour: rows still leave within the bound of elapsed time', async () => {
    await mount(Array.from({ length: 350 }, (_, index) => row(index + 1)), 5_000);
    const stop = startPoller();
    await openPages(3, 'open');
    vi.setSystemTime(Date.now() - 3_600_000);
    const removed = order()[150]!;
    world.catalog = world.catalog.filter((item) => item.id !== removed.id);
    // Deeper reads fail, so nothing confirms the older rows after the change.
    world.failDeeper = true;
    await second('set back', 90);
    expect(latest?.conversations).toHaveLength(100);
    world.failDeeper = false;
    await second('set back, reads again', 60);
    stop();
    expect(world.violations).toEqual([]);
    expect(latest?.conversations.map((item) => item.id)).toEqual(order().slice(0, 300).map((item) => item.id));
  });

  it('device time set forward a day: older rows leave at once and the next cycle reads them again', async () => {
    await mount(Array.from({ length: 350 }, (_, index) => row(index + 1)), 5_000);
    const stop = startPoller();
    await openPages(3, 'open');
    vi.setSystemTime(Date.now() + 86_400_000);
    await act(async () => { rerender(); });
    expect(latest?.conversations).toHaveLength(100);
    await second('set forward', 60);
    stop();
    expect(world.violations).toEqual([]);
    expect(latest?.conversations.map((item) => item.id)).toEqual(order().slice(0, 300).map((item) => item.id));
  });

  it.each([
    ['the device slept (only the wall clock moved)', true, false],
    ['the clock was also set back (only the monotonic clock moved)', false, true],
  ])('back from the background after longer than the bound, when %s: no older row is painted', async (_label, wallMoves, monoMoves) => {
    await mount(Array.from({ length: 350 }, (_, index) => row(index + 1)), 0);
    await openPages(3, 'open');
    expect(latest?.conversations).toHaveLength(300);
    // Suspended for ten minutes: no timer ran and no poll arrived.
    const fakeNow = vi.getMockedSystemTime() as Date | null;
    if (wallMoves) vi.setSystemTime((fakeNow ? fakeNow.getTime() : Date.now()) + 600_000);
    if (monoMoves) {
      const mono = performance.now() + 600_000;
      vi.spyOn(performance, 'now').mockImplementation(() => mono);
    }
    renders = [];
    // Any render before the cut runs (here, an unrelated re-render) already
    // leaves the older rows out.
    await act(async () => { rerender(); });
    await act(async () => { for (const listener of appState.listeners) listener('active'); });
    expect(renders.length).toBeGreaterThan(0);
    for (const painted of renders) expect(painted).toHaveLength(100);
    expect(latest?.hasMore).toBe(true);
    vi.restoreAllMocks();
  });

  const latencies = [0, 5_000, 20_000, 45_000];
  const cases = latencies.flatMap((latency) => [1, 2, 3, 4].flatMap((pages) => [1, 2, 3, 4].map((seed) => ({ latency, pages, seed }))));

  it.each(cases)('$latency ms reads, $pages loaded pages, seed $seed: bounded, recovered, capped', async ({ latency, pages, seed }) => {
    const next = random(seed * 977 + pages * 31 + latency);
    await mount(Array.from({ length: 460 }, (_, index) => row(index + 1)), latency);
    const stop = startPoller();
    await openPages(pages, 'open');
    // A stream re-reads one page at a time, so n older pages stay fresh only
    // while (n + 1) reads fit in the bound; slower reads show a shorter list.
    let opened = latest?.conversations.length ?? 0;
    if ((pages * latency) < STALE_MS) expect(opened).toBe(pages * PAGE);
    expect(opened).toBeGreaterThanOrEqual(PAGE);

    // Six minutes of removals at every page edge and inside a search page,
    // replies that move a deep row up, presses at arbitrary seconds, and a
    // stretch where every deeper read fails.
    const edges = [0, 1, 98, 99, 100, 101, 199, 200, 201, 299, 300, 301, 399];
    const failFrom = 60 + Math.floor(next() * 180);
    const failUntil = failFrom + 30 + Math.floor(next() * 90);
    for (let at = 0; at < 360; at += 1) {
      world.failDeeper = at >= failFrom && at < failUntil;
      const roll = next();
      const current = order();
      if (roll < 0.04) {
        const depth = edges[Math.floor(next() * edges.length)]!;
        const target = current[Math.min(depth, current.length - 1)];
        if (target) world.catalog = world.catalog.filter((item) => item.id !== target.id);
      } else if (roll < 0.06 && world.query) {
        const matches = current.filter((item) => item.title.includes('1'));
        const target = matches[Math.floor(next() * matches.length)];
        if (target) world.catalog = world.catalog.filter((item) => item.id !== target.id);
      } else if (roll < 0.08) {
        const target = current[100 + Math.floor(next() * Math.max(1, current.length - 100))];
        const updatedAt = new Date(Date.now()).toISOString();
        if (target) world.catalog = world.catalog.map((item) => (item.id === target.id ? { ...item, updatedAt, createdAt: updatedAt, latestMessage: `Reply at ${updatedAt}` } : item));
      } else if (roll < 0.11) {
        press('older');
      } else if (roll < 0.13) {
        world.query = world.query ? '' : '1';
        // A changed term drops the search read in flight.
        world.dropped.search = performance.now();
        await act(async () => { rerender(); });
      } else if (roll < 0.16 && latest?.status === 'error') {
        press('more');
      } else if (roll < 0.18 && latest?.searching && latest.hasMore) {
        press('more');
      }
      await second(`t+${at}`);
      if (!latest?.searching) opened = Math.max(opened, latest?.conversations.length ?? 0);
    }

    // Reads succeed and are fast again: nothing still authorized is lost.
    world.failDeeper = false;
    world.latency = 0;
    world.query = '';
    await act(async () => { rerender(); });
    world.dropped.search = performance.now();
    // A depth parked while reads were too slow comes back when the steward
    // presses Show older.
    const target = Math.min(Math.floor(opened / PAGE) * PAGE, world.catalog.length);
    for (let round = 0; round < 5; round += 1) {
      if (latest && !latest.searching && latest.hasMore && latest.status !== 'loading' && latest.conversations.length < target) press('older');
      await second('recover', 30);
    }
    stop();

    expect(world.violations.slice(0, 5)).toEqual([]);
    const shown = latest!.conversations.map(version);
    const expected = order().slice(0, shown.length).map(version);
    expect(shown).toEqual(expected);
    // Every page the steward had open comes back (a row a reply pushed off
    // the first page can briefly show one past a page edge).
    expect(shown.length).toBeGreaterThanOrEqual(Math.min(Math.floor(opened / PAGE) * PAGE, world.catalog.length));
    // One read in flight per stream; a changed search term drops its read.
    expect(world.maxInFlight.browse).toBeLessThanOrEqual(1);
    expect(world.maxInFlight.search).toBeLessThanOrEqual(1);
    // No more than a cycle's cap (opened pages plus two, per stream) for each
    // first page, plus one read per press.
    const deepest = Math.ceil(world.catalog.length / PAGE);
    expect(world.reads).toBeLessThanOrEqual(world.deliveries * 2 * (deepest + 2) + world.presses);
  });
});
