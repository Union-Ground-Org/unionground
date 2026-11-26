import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { freshnessAge, freshnessNow, replaceKeptRange, useFreshnessCut, type FreshnessStamp, type Kept } from '../lib/freshRows';
import { isStaleResponse } from '../lib/requestGeneration';
import type { MemberMessage, MessageHistoryCursor } from '../models/member';

// BUG-UG-NATIVE-DIRECT-THREAD-HIDES-OLDER-MESSAGES-20261109: a thread
// read returns the newest bounded page. The earlier pages a reader opens live
// here, so a refresh of the newest page (an incoming message, a reconcile, a
// send) never drops them. The first earlier read takes the messages on screen
// as its base, so a message that a later refresh slides out of the newest
// page stays in place. A new conversation, message link, account, role, hat
// or reader scope (the scope key) starts over with nothing kept, and so does a
// read that returns no thread or an empty newest page: when the server shows
// nothing here, no earlier page outlives it.
//
// The guarantee does not depend on how fast the server answers: no earlier
// message this hook keeps stays on screen `staleAfterMs` (two thread
// reconciles) or longer after the start of the last read that returned it,
// so an edit, a redaction or a removal on an earlier page reaches the screen
// within that time. The same rules as the Steward Direct pages apply
// (useStewardDirectPages, lib/freshRows): kept messages carry that time on two
// clocks; a message the newest page lists is confirmed when that page
// arrives; the screen shows kept messages only as an unbroken run back from
// the newest page, and a timer (and the return to the foreground) cuts the
// rest, which then offers Show earlier again with no error.
//
// One reader, at most one read in flight. Each new newest page with earlier
// history asks for a cycle: the reader re-reads the earlier pages back from
// the newest page to the depth the reader opened (at most two pages more),
// and each page replaces the kept messages it covers as it lands. A new
// newest page never cancels a cycle in flight and leaves at most one more
// waiting. Show earlier and Try again wait for it. A failed re-read shows no
// error; a completed cycle clears an earlier paging error and refills depth
// that aged out.
//
// BUG-UG-NATIVE-CHANNEL-HIDES-POSTS-PAST-NEWEST-1000-20261110: chapter
// channel threads page back the same way. Their newest page is the part of the
// chapter's newest posts that falls in the thread, so it can be empty while
// earlier posts exist; only a missing thread or a missing cursor starts over.
// A screen with no reconcile of its own passes `revalidateMs`, so opened
// history is read again on that timer and stays within the bound.

export type ConversationHistoryStatus = 'idle' | 'loading' | 'error';

/** A message or post the history can order: by time, then by id. */
export type HistoryRow = { id: string; createdAt: string };

export type EarlierMessagesPage<Row extends HistoryRow = MemberMessage> = { messages: Row[]; earlierCursor: MessageHistoryCursor | null };

/** The newest page a screen shows, and where its earlier history starts. */
export type NewestHistoryPage<Row extends HistoryRow = MemberMessage> = { messages: readonly Row[]; earlierCursor?: MessageHistoryCursor | null };

/** The conversation screen reads the newest page again this often (its `setInterval(reconcile, 30000)`). */
export const CONVERSATION_RECONCILE_MS = 30_000;

/** Reconciles an earlier message may go without a read that returns it. */
export const CONVERSATION_HISTORY_STALE_RECONCILES = 2;

type Key = Pick<HistoryRow, 'createdAt' | 'id'>;

type History<Row extends HistoryRow> = {
  scope: string;
  started: boolean;
  /** Earlier messages, newest first, each with the start time of the read that last returned it. */
  kept: Kept<Row>[];
  /** The server served the first message of the conversation at the end of `kept`. */
  ended: boolean;
  status: ConversationHistoryStatus;
  lastLoaded: number;
  /** Earlier pages the reader opened beyond the base, and the oldest message they reached. */
  pages: number;
  deepest: Key | null;
};

type Reader = { generation: number; running: number | null; cycle: boolean; more: boolean; flight: Promise<void>; unsettled: number };

function emptyHistory<Row extends HistoryRow>(scope: string): History<Row> {
  return { scope, started: false, kept: [], ended: false, status: 'idle', lastLoaded: 0, pages: 0, deepest: null };
}

function compareMessages(left: Key, right: Key): number {
  const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (byTime) return byTime;
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** In the kept order (newest first), `row` comes before `other`. */
function newer(row: Key, other: Key): boolean {
  return compareMessages(row, other) > 0;
}

function sameKey(row: Key, other: Key): boolean {
  return row.id === other.id && row.createdAt === other.createdAt;
}

/**
 * What the newest pages said about a message: its copy, or null once a newest
 * page covered it and no longer listed it. `step` orders it among the
 * hook's events (clock readings can tie); `at` is when that page arrived, for
 * the bound.
 */
type Confirmed<Row extends HistoryRow> = { row: Row | null; step: number; at: FreshnessStamp };

// An earlier read keeps a message's copy only when it started after the last
// newest page that spoke about the message. Otherwise the newest page's copy
// stands in (a redaction or an edit it carried stays), or the message stays
// out (it was removed), whatever order the answers arrive in.
function settle<Row extends HistoryRow>(rows: readonly Row[], startedStep: number, confirmed: ReadonlyMap<string, Confirmed<Row>>): Row[] {
  return rows.flatMap((row) => {
    const said = confirmed.get(row.id);
    if (!said || said.step < startedStep) return [row];
    return said.row ? [said.row] : [];
  });
}

// How many kept messages, from the newest, stay: an unbroken run of fresh ones.
// A message the newest page lists shows that page's copy, never the kept one,
// so its age does not cut the history behind it (a screen with no reconcile
// does not confirm it again); every message shown from the kept copy is
// still held to the bound.
function freshLength<Row extends HistoryRow>(kept: readonly Kept<Row>[], now: FreshnessStamp, staleAfterMs: number, listed: ReadonlySet<string>): number {
  let count = 0;
  while (count < kept.length && (listed.has(kept[count]!.row.id) || freshnessAge(kept[count]!.seen, now) < staleAfterMs)) count += 1;
  return count;
}

function expire<Row extends HistoryRow>(history: History<Row>, now: FreshnessStamp, staleAfterMs: number, listed: ReadonlySet<string>): History<Row> {
  const keep = freshLength(history.kept, now, staleAfterMs, listed);
  return keep === history.kept.length ? history : { ...history, kept: history.kept.slice(0, keep), ended: false };
}

// Chronological, one copy per message; the newest read's copy wins, so an
// edit, redaction or reaction it carries replaces the kept copy.
export function mergeConversationHistory<Row extends HistoryRow>(kept: readonly Row[], newest: readonly Row[]): Row[] {
  const byID = new Map<string, Row>();
  for (const row of kept) byID.set(row.id, row);
  for (const row of newest) byID.set(row.id, row);
  return [...byID.values()].sort(compareMessages);
}

export const conversationHistoryCopy = {
  showEarlier: 'Show earlier messages',
  loadingEarlier: 'Loading earlier messages',
  failed: 'Earlier messages did not load. The messages shown stay here. Try again.',
  tryAgain: 'Try again',
  start: 'This is the start of the conversation.',
  loaded: (count: number) => `${count.toLocaleString('en-US')} earlier ${count === 1 ? 'message' : 'messages'} shown above.`,
};

export type ConversationHistory<Row extends HistoryRow = MemberMessage> = {
  messages: Row[];
  status: ConversationHistoryStatus;
  hasEarlier: boolean;
  /** At least one earlier page has been opened in this scope. */
  started: boolean;
  /** How many messages the last earlier page added, for the announcement. */
  lastLoaded: number;
  loadEarlier: () => void;
};

export function useConversationHistory<Row extends HistoryRow = MemberMessage>({ scopeKey, thread, load, staleAfterMs = CONVERSATION_HISTORY_STALE_RECONCILES * CONVERSATION_RECONCILE_MS, revalidateMs }: {
  scopeKey: string;
  thread: NewestHistoryPage<Row> | null;
  load: (before: MessageHistoryCursor) => Promise<EarlierMessagesPage<Row>>;
  /** How long a kept earlier message may stay on screen after the read that last returned it. */
  staleAfterMs?: number;
  /** Read the opened history again this often, for a screen with no reconcile of its own. */
  revalidateMs?: number;
}): ConversationHistory<Row> {
  // The history lives in a ref so the reader sees it as it is now; a version
  // bump renders it.
  const [, setVersion] = useState(0);
  const store = useRef<History<Row>>(emptyHistory(scopeKey));
  const reader = useRef<Reader>({ generation: 0, running: null, cycle: false, more: false, flight: Promise.resolve(), unsettled: 0 });
  const history = store.current.scope === scopeKey ? store.current : emptyHistory<Row>(scopeKey);
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const listed = useMemo(() => new Set((thread?.messages ?? []).map((row) => row.id)), [thread]);
  const listedRef = useRef(listed);
  listedRef.current = listed;
  const threadAt = useRef<FreshnessStamp>(freshnessNow());
  // Newest-page copies and removals in this scope, younger than the bound: a
  // read that started before an older one has already aged out.
  const confirmed = useRef<Map<string, Confirmed<Row>>>(new Map());
  // Read starts and newest pages, in the order they happen.
  const steps = useRef(0);
  const lastListed = useRef<readonly Row[]>([]);
  const loadRef = useRef(load);
  loadRef.current = load;
  const staleRef = useRef(staleAfterMs);
  staleRef.current = staleAfterMs;

  const commit = useCallback((update: (previous: History<Row>) => History<Row>) => {
    const previous = store.current;
    const next = update(previous);
    if (next === previous) return;
    store.current = next;
    setVersion((value) => value + 1);
  }, []);

  // Cancels the reader: a read in flight is dropped when it lands, and the
  // slot is free at once, so a read that never settles cannot hold up the next
  // scope.
  const cancel = useCallback(() => {
    reader.current.generation += 1;
    reader.current.cycle = false;
    reader.current.more = false;
    reader.current.running = null;
    reader.current.unsettled = 0;
    reader.current.flight = Promise.resolve();
    confirmed.current = new Map();
    lastListed.current = [];
  }, []);

  // A new scope keeps nothing.
  useEffect(() => {
    cancel();
    commit(() => emptyHistory<Row>(scopeKey));
  }, [cancel, commit, scopeKey]);
  useEffect(() => cancel, [cancel]);

  // Show earlier or Try again: the page before the messages on screen. It
  // continues them only if they are unchanged when it lands.
  const extend = useCallback(async (live: () => boolean) => {
    const staleAfter = staleRef.current;
    commit((previous) => expire(previous, freshnessNow(), staleAfter, listedRef.current));
    const current = store.current;
    const scope = current.scope;
    const tail = current.kept[current.kept.length - 1]?.row;
    const before = tail ?? threadRef.current?.earlierCursor ?? null;
    if (!before) {
      commit((previous) => ({ ...previous, status: 'idle' }));
      return;
    }
    const startedAt = freshnessNow();
    const startedStep = ++steps.current;
    let page: EarlierMessagesPage<Row>;
    try {
      page = await loadRef.current({ createdAt: before.createdAt, id: before.id });
    } catch (error) {
      if (live()) commit((previous) => (previous.scope !== scope ? previous : { ...previous, status: isStaleResponse(error) ? 'idle' : 'error' }));
      return;
    }
    if (!live()) return;
    commit((previous) => {
      if (previous.scope !== scope) return previous;
      const fresh = expire(previous, freshnessNow(), staleAfter, listedRef.current);
      const freshTail = fresh.kept[fresh.kept.length - 1]?.row;
      // The messages on screen changed under the read (they aged out), so the
      // page no longer continues them; Show earlier is offered again.
      if (tail ? !freshTail || !sameKey(freshTail, tail) : freshTail) return { ...fresh, status: 'idle' };
      const rows = [...page.messages].reverse();
      const oldest = rows[rows.length - 1];
      const deeper = Boolean(oldest && (!fresh.deepest || newer(fresh.deepest, oldest)));
      return {
        ...fresh,
        kept: [...fresh.kept, ...settle(rows, startedStep, confirmed.current).map((row) => ({ row, seen: startedAt }))],
        started: true,
        ended: !page.earlierCursor,
        status: 'idle',
        lastLoaded: page.messages.length,
        pages: deeper ? fresh.pages + 1 : fresh.pages,
        deepest: deeper && oldest ? oldest : fresh.deepest,
      };
    });
  }, [commit]);

  // One cycle: read the earlier pages again, back from the newest page to the
  // depth the reader opened, publishing each page as it lands.
  const revalidate = useCallback(async (live: () => boolean) => {
    const staleAfter = staleRef.current;
    const current = store.current;
    const start = threadRef.current?.earlierCursor ?? null;
    if (!current.started || current.pages === 0 || !start) return;
    const scope = current.scope;
    const { pages, deepest } = current;
    let after: Key = start;
    let read = 0;
    for (;;) {
      const startedAt = freshnessNow();
      const startedStep = ++steps.current;
      let page: EarlierMessagesPage<Row>;
      try {
        page = await loadRef.current({ createdAt: after.createdAt, id: after.id });
      } catch {
        return;
      }
      if (!live()) return;
      read += 1;
      const rows = [...page.messages].reverse();
      const oldest = rows[rows.length - 1] ?? null;
      const covered = read >= pages && (!deepest || !oldest || !newer(oldest, deepest));
      const final = !page.earlierCursor || !oldest || covered || read >= pages + 2;
      const from = after;
      let joined = true;
      commit((previous) => {
        if (previous.scope !== scope) return previous;
        const fresh = expire(previous, freshnessNow(), staleAfter, listedRef.current);
        // A later page joins the messages above it only while the message it
        // was read before is still on screen; otherwise the next cycle starts
        // again.
        if (read > 1 && !fresh.kept.some((entry) => sameKey(entry.row, from))) {
          joined = false;
          return fresh;
        }
        const kept = replaceKeptRange<Row, Key>(fresh.kept, {
          after: from,
          last: page.earlierCursor ? oldest : null,
          rows: settle(rows, startedStep, confirmed.current),
          seen: startedAt,
          final,
          before: newer,
        });
        if (!final) return { ...fresh, kept };
        return {
          ...fresh,
          kept,
          ended: !page.earlierCursor,
          pages: read,
          deepest: oldest ?? fresh.deepest,
          status: fresh.status === 'error' ? 'idle' : fresh.status,
        };
      });
      if (!joined || final || !oldest) return;
      after = oldest;
    }
  }, [commit]);

  // Show earlier first, then a waiting cycle. Nothing here cancels a read;
  // only `cancel` drops one. A new reader starts only after a cancelled one's
  // read lands, so there are never two reads in flight; with nothing pending
  // it starts at once, so a press asks in the same turn.
  const pump = useCallback(() => {
    const current = reader.current;
    if (current.running === current.generation) return;
    const generation = current.generation;
    current.running = generation;
    const live = () => current.generation === generation;
    const run = async () => {
      try {
        while (live()) {
          if (current.more) {
            current.more = false;
            await extend(live);
          } else if (current.cycle) {
            current.cycle = false;
            await revalidate(live);
          } else {
            break;
          }
        }
      } finally {
        if (current.running === generation) current.running = null;
        // A cancelled run no longer counts (cancel already freed the slot).
        if (current.generation === generation) current.unsettled -= 1;
      }
    };
    current.unsettled += 1;
    current.flight = (current.unsettled === 1 ? run() : current.flight.then(run)).catch(() => undefined);
  }, [extend, revalidate]);

  // A thread that is gone (access changed) or a newest page with no earlier
  // cursor (the whole conversation, an empty one included) keeps nothing, and
  // every read in flight is cancelled, so a late answer from before it cannot
  // fill a cache a later page would show again. Otherwise each newest page
  // confirms the kept messages it lists, drops the ones it covers and no
  // longer lists, and asks for one cycle.
  useEffect(() => {
    const now = freshnessNow();
    threadAt.current = now;
    const cursor = thread?.earlierCursor ?? null;
    if (!thread || !cursor) {
      lastListed.current = [];
      const previous = store.current;
      if (previous.started || previous.kept.length || reader.current.running !== null) {
        cancel();
        commit(() => emptyHistory<Row>(previous.scope));
      }
      return;
    }
    const listed = new Map(thread.messages.map((row) => [row.id, row]));
    // Remember what this page says until it ages out, so an earlier read that
    // started before it and lands later cannot undo it.
    const said = confirmed.current;
    for (const [id, entry] of said) if (freshnessAge(entry.at, now) >= staleRef.current) said.delete(id);
    const step = ++steps.current;
    for (const row of thread.messages) said.set(row.id, { row, step, at: now });
    const removed = (row: Row) => {
      if (!listed.has(row.id) && !newer(cursor, row)) said.set(row.id, { row: null, step, at: now });
    };
    lastListed.current.forEach(removed);
    lastListed.current = thread.messages;
    commit((previous) => {
      if (!previous.kept.length) return previous;
      let changed = false;
      const kept: Kept<Row>[] = [];
      for (const entry of previous.kept) {
        const copy = listed.get(entry.row.id);
        if (copy) {
          // Listed now, wherever the kept copy sat: the newest page's copy (an
          // edit or a redaction) replaces and confirms it, so it is what stays
          // once it slides out.
          kept.push({ row: copy, seen: now });
          changed = true;
        } else if (newer(cursor, entry.row)) {
          kept.push(entry);
        } else {
          removed(entry.row);
          changed = true;
        }
      }
      return changed ? { ...previous, kept } : previous;
    });
    if (store.current.scope !== scopeKey) return;
    reader.current.cycle = true;
    pump();
  }, [cancel, commit, pump, scopeKey, thread]);

  // A kept message leaves the screen the moment it is too old.
  useFreshnessCut([history.kept.filter((entry) => !listed.has(entry.row.id))], staleAfterMs, () => {
    const now = freshnessNow();
    commit((previous) => expire(previous, now, staleAfterMs, listedRef.current));
  });

  const hasEarlier = Boolean(thread?.earlierCursor) && (!history.started || !history.ended);

  // With no reconcile on the screen, the opened history is read again here.
  const opened = history.started && history.pages > 0;
  useEffect(() => {
    if (!revalidateMs || !opened) return undefined;
    const timer = setInterval(() => {
      reader.current.cycle = true;
      pump();
    }, revalidateMs);
    return () => clearInterval(timer);
  }, [opened, pump, revalidateMs]);

  const loadEarlier = useCallback(() => {
    const current = threadRef.current;
    const previous = store.current;
    if (!current || previous.scope !== scopeKey || previous.status === 'loading' || !current.earlierCursor) return;
    if (!previous.started) {
      // The messages on screen become the base, so a message that a later
      // refresh slides out of the newest page stays until a cycle reads it
      // again. A linked message older than the page is not part of it.
      const cursor = current.earlierCursor;
      const seen = threadAt.current;
      const base = [...current.messages].reverse().filter((row) => !newer(cursor, row)).map((row) => ({ row, seen }));
      commit(() => ({ ...emptyHistory<Row>(scopeKey), kept: base, started: true, status: 'loading' }));
    } else {
      if (previous.ended) return;
      commit((value) => ({ ...value, status: 'loading' }));
    }
    reader.current.more = true;
    pump();
  }, [commit, pump, scopeKey]);

  // Age is measured on every render, not only when the cut runs.
  const fresh = freshLength(history.kept, freshnessNow(), staleAfterMs, listed);
  const newest = thread?.messages;
  // The effect above applies a newest page after the render it arrives in, so
  // that render already follows it: a page with no earlier cursor (the whole
  // conversation) shows nothing kept, and a kept message the page covers shows
  // only through the page's own copy.
  const cursor = thread?.earlierCursor ?? null;
  const messages = useMemo(() => {
    if (!newest) return [];
    if (!history.started || !cursor) return [...newest];
    const kept = history.kept.slice(0, fresh).filter((entry) => newer(cursor, entry.row));
    return mergeConversationHistory(kept.map((entry) => entry.row), newest);
  }, [cursor, fresh, history.kept, history.started, newest]);

  return {
    messages,
    status: history.status,
    hasEarlier,
    started: history.started,
    lastLoaded: history.lastLoaded,
    loadEarlier,
  };
}
