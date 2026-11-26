// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemberConversationThread, MemberMessage, MessageHistoryCursor } from '../models/member';
import { StaleResponseError } from '../lib/requestGeneration';
import { createResponseQueue } from '../../../../tests/helpers/responseQueue.js';

// BUG-UG-NATIVE-DIRECT-THREAD-HIDES-OLDER-MESSAGES-20261109: the
// mounted conversation history hook against a stub server whose every read
// takes a fixed time, with the screen reading the newest page again every 30
// seconds. At every simulated second no earlier message, in the version shown
// (body and redaction), may be on screen 60 seconds (two reconciles) or more
// after the start of the last read that returned that version, measured on
// elapsed time. The newest page counts from the moment it arrives. Pages are
// 50 messages here to keep the runs short; the hook reads by cursor only.
// Fictional Tamarack exchanges only.

const RECONCILE_MS = 30_000;
const STALE_MS = 60_000;
const PAGE = 50;

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

import { useConversationHistory, type ConversationHistory, type EarlierMessagesPage } from './useConversationHistory';

const BASE = Date.parse('2026-11-02T14:00:00.000Z');

function exchange(number: number): MemberMessage {
  const label = String(number).padStart(3, '0');
  // Three exchanges share each minute, so equal times straddle page edges.
  const createdAt = new Date(BASE + Math.floor(number / 3) * 60_000).toISOString();
  return {
    id: `00000000-0000-4000-8000-000000000${label}`,
    conversationID: 'marcus-thread',
    senderKind: number % 2 ? 'member' : 'steward',
    senderName: number % 2 ? 'Marcus Greene' : 'Dylan Committee',
    body: `Exchange ${label}`,
    createdAt,
    readAt: null,
    reactions: [],
  };
}

function older(row: Pick<MemberMessage, 'createdAt' | 'id'>, cursor: MessageHistoryCursor): boolean {
  return row.createdAt < cursor.createdAt || (row.createdAt === cursor.createdAt && row.id < cursor.id);
}

function newestFirst(a: MemberMessage, b: MemberMessage): number {
  return a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt);
}

function version(row: MemberMessage): string {
  return `${row.id}|${row.body}|${row.redactedAt ?? ''}`;
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
  catalog: MemberMessage[];
  latency: number;
  failEarlier: boolean;
  /** Answer with the conversation as it was when the read started (a late, old answer). */
  snapshot: boolean;
  thread: MemberConversationThread | null;
  /** Start of the last read (or arrival of the last newest page) that returned each message version. */
  lastReturn: Map<string, number>;
  inFlight: number;
  maxInFlight: number;
  reads: number;
  deliveries: number;
  presses: number;
  next: number;
  violations: string[];
  /** The screen reads opened history again this often instead of reconciling (chapter channels). */
  revalidateMs?: number;
};

let root: Root;
let host: HTMLDivElement;
let world: World;
let latest: ConversationHistory | null = null;
let renders: MemberMessage[][] = [];

function order(): MemberMessage[] {
  return [...world.catalog].sort(newestFirst);
}

function newestPage(): MemberConversationThread {
  const page = order().slice(0, PAGE);
  const oldest = page[page.length - 1];
  return {
    conversation: { id: 'marcus-thread', title: 'Marcus Greene', initials: 'MG', unreadCount: 0, createdAt: exchange(1).createdAt, updatedAt: exchange(1).createdAt, latestMessage: null },
    messages: [...page].reverse(),
    earlierCursor: page.length >= PAGE && oldest ? { createdAt: oldest.createdAt, id: oldest.id } : null,
  };
}

function earlier(before: MessageHistoryCursor): Promise<EarlierMessagesPage> {
  const startedAt = performance.now();
  world.reads += 1;
  world.inFlight += 1;
  world.maxInFlight = Math.max(world.maxInFlight, world.inFlight);
  const atStart = world.snapshot ? order() : null;
  return new Promise((resolve, reject) => {
    const settle = () => {
      world.inFlight -= 1;
      if (world.failEarlier) {
        reject(new Error('Earlier messages did not load. Try again.'));
        return;
      }
      const page = (atStart ?? order()).filter((row) => older(row, before)).slice(0, PAGE);
      for (const row of page) world.lastReturn.set(version(row), Math.max(world.lastReturn.get(version(row)) ?? -Infinity, startedAt));
      const oldest = page[page.length - 1];
      resolve({ messages: [...page].reverse(), earlierCursor: page.length >= PAGE && oldest ? { createdAt: oldest.createdAt, id: oldest.id } : null });
    };
    if (world.latency === 0) queueMicrotask(settle);
    else setTimeout(settle, world.latency);
  });
}

function Harness({ thread, load = earlier }: { thread: MemberConversationThread | null; load?: typeof earlier }) {
  latest = useConversationHistory({ scopeKey: 'marcus-thread|marcus', thread, load, staleAfterMs: STALE_MS, revalidateMs: world.revalidateMs });
  renders.push(latest.messages);
  return null;
}

function rerender() {
  root.render(createElement(Harness, { thread: world.thread }));
}

// The screen's reconcile: a newest-page read every 30 seconds, one at a time.
function startReconcile(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = () => {
    if (stopped) return;
    const scheduled = Date.now();
    const deliver = () => {
      if (stopped) return;
      world.thread = newestPage();
      const now = performance.now();
      for (const row of world.thread.messages) world.lastReturn.set(version(row), now);
      world.deliveries += 1;
      rerender();
      timer = setTimeout(tick, Math.max(0, scheduled + RECONCILE_MS - Date.now()));
    };
    if (world.latency === 0) deliver();
    else timer = setTimeout(deliver, world.latency);
  };
  timer = setTimeout(tick, RECONCILE_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

function check(label: string) {
  const shown = latest?.messages ?? [];
  const ids = shown.map((row) => row.id);
  if (new Set(ids).size !== ids.length) world.violations.push(`${label}: duplicate messages`);
  const newest = new Set((world.thread?.messages ?? []).map(version));
  const now = performance.now();
  for (const row of shown) {
    if (newest.has(version(row))) continue;
    const returned = world.lastReturn.get(version(row));
    if (returned === undefined || now - returned >= STALE_MS) {
      world.violations.push(`${label}: ${row.body || 'removed message'} (${row.id.slice(-3)}) on screen ${returned === undefined ? 'never returned' : `${Math.round((now - returned) / 1000)} s after its last read`}`);
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

async function mount(count: number, latency: number) {
  world = {
    catalog: Array.from({ length: count }, (_, index) => exchange(index + 1)),
    latency,
    failEarlier: false,
    snapshot: false,
    thread: null,
    lastReturn: new Map(),
    inFlight: 0,
    maxInFlight: 0,
    reads: 0,
    deliveries: 0,
    presses: 0,
    next: count + 1,
    violations: [],
  };
  world.thread = newestPage();
  for (const row of world.thread.messages) world.lastReturn.set(version(row), performance.now());
  await act(async () => { rerender(); });
}

function press() {
  if (!latest) return;
  world.presses += 1;
  act(() => { latest!.loadEarlier(); });
}

async function openPages(total: number, label: string) {
  for (let page = 1; page < total; page += 1) {
    press();
    await settle(label);
  }
}

function edit(depth: number, change: 'remove' | 'redact' | 'edit') {
  const target = order()[depth];
  if (!target) return null;
  if (change === 'remove') world.catalog = world.catalog.filter((row) => row.id !== target.id);
  else world.catalog = world.catalog.map((row) => (row.id !== target.id ? row : change === 'redact'
    ? { ...row, body: '', redactedAt: new Date(Date.now()).toISOString(), redactionReason: 'staff_removed' }
    : { ...row, body: `${row.body} (edited)`, editedAt: new Date(Date.now()).toISOString() }));
  return target;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  vi.setSystemTime(BASE + 30 * 86_400_000);
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type HeldRead = ['redacted' | 'removed', 'the held answer lands first' | 'the newer message arrives first' | 'all at one clock reading'];
const heldReads: HeldRead[] = [
  ['redacted', 'the held answer lands first'],
  ['redacted', 'the newer message arrives first'],
  ['removed', 'the held answer lands first'],
  // Both clocks read the same when the read starts, the page confirms and the
  // message slides out: order alone decides.
  ['redacted', 'all at one clock reading'],
  ['removed', 'all at one clock reading'],
];

describe('Earlier messages never outlive their last read by two reconciles', () => {
  it.each([['removed', 'remove'], ['redacted', 'redact'], ['edited', 'edit']] as const)('150 of 250 open, the message at depth 100 is %s, 20 second reads, 30 second reconciles', async (_label, change) => {
    await mount(250, 20_000);
    const stop = startReconcile();
    await openPages(3, 'open');
    expect(latest?.messages).toHaveLength(150);
    const target = edit(100, change)!;
    const changedAt = performance.now();
    let goneAt: number | null = null;
    for (let step = 0; step < 240; step += 1) {
      await second(change);
      if (goneAt === null && !latest?.messages.some((row) => version(row) === version(target))) goneAt = performance.now();
    }
    stop();
    expect(world.violations).toEqual([]);
    expect(goneAt).not.toBeNull();
    expect(goneAt! - changedAt).toBeLessThanOrEqual(STALE_MS);
    expect(world.maxInFlight).toBe(1);
  });

  it('an edit on the newest page is what stays when newer messages slide it into the opened history', async () => {
    await mount(250, 0);
    const stop = startReconcile();
    await openPages(3, 'open');
    edit(10, 'edit');
    await second('edited', 90);
    // 60 newer messages slide it below the newest page; earlier reads fail, so
    // only what the hook already holds can show it.
    for (let count = 0; count < 60; count += 1) {
      world.catalog = [...world.catalog, { ...exchange(world.next), createdAt: new Date(Date.now() + count).toISOString() }];
      world.next += 1;
    }
    world.failEarlier = true;
    await second('slid out', 90);
    stop();
    expect(world.violations).toEqual([]);
  });

  it('a late answer from before a newest page that is the whole conversation never comes back with the next full page', async () => {
    await mount(250, 0);
    await openPages(3, 'open');
    expect(latest?.messages).toHaveLength(150);
    // A cycle starts and its answer is held; it will carry the old history.
    world.latency = 10_000;
    world.snapshot = true;
    world.thread = newestPage();
    await act(async () => { rerender(); });
    await second('held', 5);
    // Everything but the newest 40 messages is removed: the newest page is
    // the whole conversation.
    const removed = order().slice(40);
    world.catalog = order().slice(0, 40);
    world.thread = newestPage();
    await act(async () => { rerender(); });
    expect(latest?.messages).toHaveLength(40);
    await second('old answer lands', 5);
    expect(latest?.messages).toHaveLength(40);
    // Ten new messages arrive: the newest page is full again.
    world.snapshot = false;
    world.latency = 0;
    for (let count = 0; count < 10; count += 1) {
      world.catalog = [...world.catalog, { ...exchange(world.next), createdAt: new Date(Date.now() + count).toISOString() }];
      world.next += 1;
    }
    renders = [];
    world.thread = newestPage();
    await act(async () => { rerender(); });
    await second('full again', 30);
    const gone = new Set(removed.map((row) => row.id));
    for (const painted of renders) expect(painted.filter((row) => gone.has(row.id))).toEqual([]);
  });

  it('a newest page that is the whole conversation shows nothing kept, already on the render it arrives in', async () => {
    await mount(250, 0);
    await openPages(3, 'open');
    expect(latest?.messages).toHaveLength(150);
    world.catalog = order().slice(0, 40);
    world.thread = newestPage();
    renders = [];
    await act(async () => { rerender(); });
    expect(renders.length).toBeGreaterThan(0);
    for (const painted of renders) expect(painted).toHaveLength(40);
  });

  // A cycle's read is held while the newest page shows the message at the edge
  // of the opened history redacted or removed; a newer message then slides it
  // out of the newest page. The held answer, from before, never brings back
  // its body, whichever arrives first, even when every clock reading ties.
  it.each(heldReads)('a message the newest page showed %s never comes back from an older held read (%s)', async (change, arrival) => {
    await mount(101, 0);
    press();
    await settle('open');
    expect(latest?.messages).toHaveLength(100);
    const target = exchange(51);
    // A newest page starts a cycle whose read answers 15 seconds later with
    // the conversation as it was; every later read never answers.
    world.snapshot = true;
    world.latency = 15_000;
    world.thread = newestPage();
    await act(async () => { rerender(); });
    world.latency = 600_000;
    if (arrival !== 'all at one clock reading') await second('held', 5);
    // The newest message is removed, so the target joins the newest page, and
    // it is redacted there (or removed, so the page covers it without it).
    world.catalog = world.catalog.filter((row) => row.id !== exchange(101).id);
    if (change === 'redacted') {
      world.catalog = world.catalog.map((row) => (row.id !== target.id ? row
        : { ...row, body: '', redactedAt: new Date(Date.now()).toISOString(), redactionReason: 'staff_removed' }));
    } else {
      world.catalog = world.catalog.filter((row) => row.id !== target.id);
    }
    world.thread = newestPage();
    await act(async () => { rerender(); });
    const shownTarget = () => latest?.messages.find((row) => row.id === target.id);
    expect(shownTarget()?.body ?? '').toBe('');
    const slide = async () => {
      world.catalog = [...world.catalog, { ...exchange(world.next), createdAt: new Date(Date.now()).toISOString() }];
      world.next += 1;
      world.thread = newestPage();
      await act(async () => { rerender(); });
    };
    if (arrival !== 'the held answer lands first') await slide();
    await second('held answer lands', 10);
    if (arrival === 'the held answer lands first') await slide();
    await second('after', 5);
    expect(world.thread?.messages.some((row) => row.id === target.id)).toBe(false);
    expect(shownTarget()?.body ?? '').toBe('');
    if (change === 'removed') expect(shownTarget()).toBeUndefined();
  });

  // BUG-UG-NATIVE-CHANNEL-HIDES-POSTS-PAST-NEWEST-1000-20261110: a
  // chapter channel thread's newest page is its share of the chapter window,
  // so it can be empty while earlier posts exist, and the channel screen has
  // no reconcile: the hook reads opened history again on its own timer.
  it('offers the earlier history of a newest page that holds none of it', async () => {
    await mount(250, 0);
    world.thread = { ...newestPage(), messages: [] };
    await act(async () => { rerender(); });
    expect(latest?.messages).toEqual([]);
    expect(latest?.hasEarlier).toBe(true);
    press();
    await settle('open');
    expect(latest?.messages.map((row) => row.id)).toEqual(order().slice(PAGE, 2 * PAGE).reverse().map((row) => row.id));
  });

  it('with no reconcile, the timer keeps opened history past the bound and a removal still leaves within it', async () => {
    await mount(250, 0);
    world.revalidateMs = RECONCILE_MS;
    await act(async () => { rerender(); });
    await openPages(3, 'open');
    expect(latest?.messages).toHaveLength(150);
    await second('held open', 150);
    expect(latest?.messages).toHaveLength(150);
    const target = edit(100, 'remove')!;
    const removedAt = performance.now();
    let goneAt: number | null = null;
    for (let step = 0; step < 90 && goneAt === null; step += 1) {
      await second('removed');
      if (!latest?.messages.some((row) => row.id === target.id)) goneAt = performance.now();
    }
    expect(world.violations).toEqual([]);
    expect(goneAt).not.toBeNull();
    expect(goneAt! - removedAt).toBeLessThanOrEqual(STALE_MS);
    expect(world.maxInFlight).toBe(1);
  });

  // The rows the first earlier read took from the screen are the newest
  // page's own; with no reconcile nothing confirms them again, and their age
  // must not cut the earlier rows the timer keeps re-reading.
  it.each([0, 1_000])('with no reconcile, %i ms timer reads keep the re-read earlier range past the bound', async (latency) => {
    await mount(100, latency);
    world.revalidateMs = RECONCILE_MS;
    await act(async () => { rerender(); });
    press();
    await settle('open');
    expect(latest?.messages).toHaveLength(100);
    for (let step = 0; step < 150; step += 1) {
      await second('held open');
      expect(latest?.messages).toHaveLength(100);
    }
    expect(world.violations).toEqual([]);
  });

  it('with no reconcile and no timer, opened history leaves at the bound', async () => {
    await mount(250, 0);
    await openPages(3, 'open');
    expect(latest?.messages).toHaveLength(150);
    await second('aging', 61);
    expect(latest?.messages).toHaveLength(50);
    expect(world.violations).toEqual([]);
  });

  it('deeper reads that fail leave unconfirmed messages within the bound and show no error', async () => {
    await mount(250, 5_000);
    const stop = startReconcile();
    await openPages(4, 'open');
    edit(100, 'redact');
    world.failEarlier = true;
    for (let step = 0; step < 150; step += 1) {
      await second('failing');
      expect(latest?.status).not.toBe('error');
    }
    // The newest page, plus the opened base it still confirms.
    expect(latest?.messages).toHaveLength(PAGE);
    expect(latest?.hasEarlier).toBe(true);
    world.failEarlier = false;
    await second('recovered', 60);
    stop();
    expect(world.violations).toEqual([]);
    expect(latest?.messages.map(version)).toEqual(order().slice(0, 200).reverse().map(version));
  });

  it('keeps superseded page failures quiet and still reports and retries a current failure', async () => {
    await mount(250, 0);
    const responses = createResponseQueue<EarlierMessagesPage>();
    let next = 0;
    const load = () => responses.request(String(next++));
    await act(async () => { root.render(createElement(Harness, { thread: world.thread, load })); });
    const shown = latest!.messages;
    press();
    expect(responses.pending()).toEqual(['0']);
    await act(async () => { responses.reject('0', new StaleResponseError()); });
    expect(latest?.status).toBe('idle');
    expect(latest?.hasEarlier).toBe(true);
    expect(latest?.messages).toEqual(shown);
    press();
    await act(async () => { responses.reject('1', new Error('Current failure')); });
    expect(latest?.status).toBe('error');
    expect(latest?.messages).toEqual(shown);
    press();
    await act(async () => {
      responses.resolve('2', { messages: [exchange(200)], earlierCursor: { createdAt: exchange(200).createdAt, id: exchange(200).id } });
    });
    expect(latest?.status).toBe('idle');
    expect(latest?.messages).toEqual([exchange(200), ...shown]);
  });

  it('a completed cycle clears an earlier paging error, and Try again always asks', async () => {
    await mount(250, 5_000);
    const stop = startReconcile();
    await openPages(2, 'open');
    world.failEarlier = true;
    press();
    await settle('failing press');
    expect(latest?.status).toBe('error');
    let reads = world.reads;
    press();
    expect(latest?.status).toBe('loading');
    await settle('retry fails');
    expect(world.reads).toBeGreaterThan(reads);
    expect(latest?.status).toBe('error');
    world.failEarlier = false;
    await second('cycle', 40);
    expect(latest?.status).toBe('idle');
    world.failEarlier = true;
    press();
    await settle('failing again');
    expect(latest?.status).toBe('error');
    world.failEarlier = false;
    reads = world.reads;
    press();
    await settle('retry');
    expect(world.reads).toBeGreaterThan(reads);
    expect(latest?.status).toBe('idle');
    expect(latest?.messages).toHaveLength(150);
    stop();
    expect(world.violations).toEqual([]);
  });

  it('a cut timer that fires early because the two clocks drift still cuts on time', async () => {
    await mount(250, 0);
    await openPages(4, 'open');
    expect(latest?.messages).toHaveLength(200);
    // The monotonic clock reads 10 ms ahead and then stalls, so the timer is
    // set by it and fires 10 ms before the wall clock reaches the bound. With
    // no reconcile and no other render, the cut must still happen on time.
    const ahead = performance.now() + 10;
    vi.spyOn(performance, 'now').mockImplementation(() => ahead);
    await act(async () => { rerender(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(STALE_MS + 1_000); });
    expect(latest?.messages).toHaveLength(PAGE);
  });

  it('device time set back an hour: messages still leave within the bound of elapsed time', async () => {
    await mount(250, 5_000);
    const stop = startReconcile();
    await openPages(4, 'open');
    vi.setSystemTime(Date.now() - 3_600_000);
    edit(120, 'redact');
    world.failEarlier = true;
    await second('set back', 90);
    expect(latest?.messages).toHaveLength(PAGE);
    world.failEarlier = false;
    await second('set back, reads again', 60);
    stop();
    expect(world.violations).toEqual([]);
    expect(latest?.messages.map(version)).toEqual(order().slice(0, 200).reverse().map(version));
  });

  it('device time set forward a day: earlier messages leave at once and the next cycle reads them again', async () => {
    await mount(250, 5_000);
    const stop = startReconcile();
    await openPages(4, 'open');
    vi.setSystemTime(Date.now() + 86_400_000);
    await act(async () => { rerender(); });
    expect(latest?.messages).toHaveLength(PAGE);
    await second('set forward', 60);
    stop();
    expect(world.violations).toEqual([]);
    expect(latest?.messages.map(version)).toEqual(order().slice(0, 200).reverse().map(version));
  });

  it.each([
    ['the device slept (only the wall clock moved)', true, false],
    ['the clock was also set back (only the monotonic clock moved)', false, true],
  ])('back from the background after longer than the bound, when %s: no earlier message is painted', async (_label, wallMoves, monoMoves) => {
    await mount(250, 0);
    await openPages(4, 'open');
    expect(latest?.messages).toHaveLength(200);
    if (wallMoves) vi.setSystemTime(Date.now() + 600_000);
    if (monoMoves) {
      const mono = performance.now() + 600_000;
      vi.spyOn(performance, 'now').mockImplementation(() => mono);
    }
    renders = [];
    await act(async () => { rerender(); });
    await act(async () => { for (const listener of appState.listeners) listener('active'); });
    expect(renders.length).toBeGreaterThan(0);
    for (const painted of renders) expect(painted).toHaveLength(PAGE);
    expect(latest?.hasEarlier).toBe(true);
  });

  const latencies = [0, 5_000, 20_000, 45_000];
  const cases = latencies.flatMap((latency) => [1, 2, 3, 4].flatMap((pages) => [1, 2, 3, 4].map((seed) => ({ latency, pages, seed }))));

  it.each(cases)('$latency ms reads, $pages open pages, seed $seed: bounded, recovered, capped', async ({ latency, pages, seed }) => {
    const next = random(seed * 977 + pages * 31 + latency);
    await mount(260, latency);
    const stop = startReconcile();
    await openPages(pages, 'open');
    let opened = latest?.messages.length ?? 0;
    if (pages * latency < STALE_MS) expect(opened).toBe(pages * PAGE);
    expect(opened).toBeGreaterThanOrEqual(PAGE);

    // Six minutes of removals, redactions and edits at every page edge,
    // incoming messages that slide the newest page, presses at arbitrary
    // seconds, and a stretch where every earlier read fails.
    const edges = [0, 1, 48, 49, 50, 51, 99, 100, 101, 149, 150, 151, 199];
    const changes = ['remove', 'redact', 'edit'] as const;
    const failFrom = 60 + Math.floor(next() * 180);
    const failUntil = failFrom + 30 + Math.floor(next() * 90);
    for (let at = 0; at < 360; at += 1) {
      world.failEarlier = at >= failFrom && at < failUntil;
      const roll = next();
      if (roll < 0.06) {
        edit(edges[Math.floor(next() * edges.length)]!, changes[Math.floor(next() * changes.length)]!);
      } else if (roll < 0.08) {
        world.catalog = [...world.catalog, { ...exchange(world.next), createdAt: new Date(Date.now()).toISOString() }];
        world.next += 1;
      } else if (roll < 0.12) {
        press();
      }
      await second(`t+${at}`);
      opened = Math.max(opened, latest?.messages.length ?? 0);
    }

    // Reads succeed and are fast again: nothing still on the server is lost.
    world.failEarlier = false;
    world.latency = 0;
    await second('recover', 5 * 30);
    stop();

    expect(world.violations.slice(0, 5)).toEqual([]);
    const shown = latest!.messages.map(version);
    expect(shown).toEqual(order().slice(0, shown.length).reverse().map(version));
    expect(shown.length).toBeGreaterThanOrEqual(Math.min(Math.floor(opened / PAGE) * PAGE, world.catalog.length));
    expect(world.maxInFlight).toBeLessThanOrEqual(1);
    const deepest = Math.ceil(world.catalog.length / PAGE);
    expect(world.reads).toBeLessThanOrEqual(world.deliveries * (deepest + 2) + world.presses);
  });
});
