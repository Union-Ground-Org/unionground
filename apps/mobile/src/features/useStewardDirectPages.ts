import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CONVERSATION_UNREAD_POLL_INTERVAL_MS } from '../lib/conversationUnread';
import { freshCount, freshnessAge, freshnessNow, replaceKeptRange, useFreshnessCut, type FreshnessStamp, type Kept } from '../lib/freshRows';
import type { MemberConversation } from '../models/member';
import {
  mergeStewardDirectRows,
  pruneStewardDirectRows,
  STEWARD_DIRECT_PAGE,
  stewardDirectCursor,
} from '../services/stewardDirectInbox';
import { loadStewardDirectPage } from '../services/supabase';

// BUG-UG-NATIVE-STEWARD-DIRECT-INBOX-STOPS-AT-100-20261109: the
// dashboard holds only the first Steward Direct page. Messages keeps the later
// pages here, in server order, and asks the server to search when the list is
// not complete, so every conversation the server permits can be reached. The
// dashboard refresh replaces only the first page; the older pages a steward
// opened stay. A different account, organization, chapter, role or hat (the
// scope key) starts over with no rows and no cursor. Member reads never come
// here.
//
// A role the server no longer grants is not always visible in the scope key:
// the summary poll refreshes rows, not roles. So an explicit 42501 refusal on
// any page clears both streams and hides the first page the steward was
// looking at until the next server read replaces it, and an empty first page
// drops every older page with it. No cached row outlives either.
//
// The guarantee does not depend on how fast the server answers: no row this
// hook keeps stays on screen `staleAfterMs` (two summary poll intervals) or
// longer after the start of the last read that returned it. Each kept row
// carries that time (on two clocks, so a device time change cannot extend it:
// lib/freshRows); a row the dashboard's first page lists is confirmed when
// that page arrives. The screen shows kept rows only as an unbroken run from
// the first page down to the first row that is too old, and a timer cuts the
// kept list there, so an unconfirmed row leaves on time, nothing below it is
// shown out of place, and the list offers Show older again. No error is shown
// for this. Every render measures age itself, and the cut also runs when the
// app returns to the foreground, so a row that aged out while the app was
// suspended is never painted again.
//
// Each stream has one reader, so at most one read is in flight per stream. A new full
// first page asks for a cycle: the reader re-reads the deeper pages from the
// first page down (to the depth the steward opened, at most two pages more),
// and each page replaces the kept rows it covers as it lands, refreshing their
// time and dropping a row the server no longer returns. A new first page
// never cancels a cycle in flight; it leaves at most one more cycle waiting.
// Show older, more search results and Try again wait for the cycle in flight
// and never cancel it. A failed re-read shows no error; its rows simply age
// out unless the next cycle confirms them. A completed cycle clears an earlier
// paging error, and a cycle refills depth that aged out.

export type StewardDirectPagesStatus = 'idle' | 'loading' | 'error';

type Key = Pick<MemberConversation, 'id' | 'updatedAt'>;
type Kind = 'browse' | 'search';
const KINDS: readonly Kind[] = ['browse', 'search'];

type Stream = {
  scope: string;
  term: string;
  /** Rows in server order, each with the start time of the read that last returned it. */
  kept: Kept<MemberConversation>[];
  started: boolean;
  /** The server served its last page at the bottom of `kept`. */
  ended: boolean;
  status: StewardDirectPagesStatus;
  /** Pages the steward opened beyond the base, and the deepest row they reached: what a cycle reads again. */
  pages: number;
  deepest: Key | null;
  /**
   * Automatic refill after rows aged out: 'pending' once they did, 'done'
   * once a cycle read them again. If they age out again while 'done', that
   * depth is parked: kept short with Show older, not refilled in a loop.
   */
  refill: 'none' | 'pending' | 'done';
  refilledAt: FreshnessStamp | null;
  parked: { pages: number; deepest: Key | null } | null;
};

type Reader = { generation: number; running: number | null; cycle: boolean; more: boolean; flight: Promise<void> };

const SEARCH_DELAY_MS = 300;

/** Summary poll intervals a kept row may go without a read that returns it. */
export const STEWARD_DIRECT_STALE_POLLS = 2;

export function stewardDirectStaleAfterMs(pollIntervalMs: number = CONVERSATION_UNREAD_POLL_INTERVAL_MS): number {
  return STEWARD_DIRECT_STALE_POLLS * pollIntervalMs;
}

function emptyStream(scope: string, term = ''): Stream {
  return { scope, term, kept: [], started: false, ended: false, status: 'idle', pages: 0, deepest: null, refill: 'none', refilledAt: null, parked: null };
}

function sortsAbove(row: Key, other: Key): boolean {
  return row.updatedAt > other.updatedAt || (row.updatedAt === other.updatedAt && row.id > other.id);
}

function sameKey(row: Key, other: Key): boolean {
  return row.id === other.id && row.updatedAt === other.updatedAt;
}

// Cuts the kept list at its first row that is too old. When the depth ages
// out again right after an automatic refill, reads are too slow to keep it:
// the cycle stops reading it, and the list stays shorter with Show older until
// the steward asks or a cycle shows a refill would now stay fresh.
function expire(stream: Stream, now: FreshnessStamp, staleAfterMs: number): Stream {
  const keep = freshCount(stream.kept, now, staleAfterMs);
  if (keep === stream.kept.length) return stream;
  const kept = stream.kept.slice(0, keep);
  const cut = { ...stream, kept, ended: false };
  if (stream.refill !== 'done') return { ...cut, refill: 'pending' };
  const removed = stream.kept.length - keep;
  return {
    ...cut,
    refill: 'none',
    refilledAt: null,
    parked: stream.parked ?? { pages: stream.pages, deepest: stream.deepest },
    pages: Math.max(0, stream.pages - Math.ceil(removed / STEWARD_DIRECT_PAGE)),
    deepest: kept[kept.length - 1]?.row ?? null,
  };
}

export const stewardDirectPagesCopy = {
  showOlder: 'Show older conversations',
  showMoreResults: 'Show more matching conversations',
  loadingOlder: 'Loading older conversations',
  searching: 'Searching all worker conversations',
  failed: 'Older conversations did not load. The conversations shown stay here. Try again.',
  tryAgain: 'Try again',
  allShown: (count: number) => `All ${count.toLocaleString('en-US')} worker ${count === 1 ? 'conversation is' : 'conversations are'} shown.`,
  // The server search matches member names and conversation titles, not
  // message text, so it never claims more than that.
  allResults: 'Every conversation whose worker name matches is shown. Message text is searched only in the conversations shown, so show older conversations to include them.',
};

export type StewardDirectPages = {
  /** First page, then the older pages (and search matches) in server order. */
  conversations: MemberConversation[];
  status: StewardDirectPagesStatus;
  /** Another page can be asked for (older rows, or more search matches). */
  hasMore: boolean;
  /** The server has served its last page for the current list or search. */
  ended: boolean;
  /** A server search is active because the loaded list is not complete. */
  searching: boolean;
  loadMore: () => void;
  /** Older pages can still be opened while a search is active. */
  olderHasMore: boolean;
  olderStatus: StewardDirectPagesStatus;
  loadOlder: () => void;
};

export function useStewardDirectPages({ enabled, scopeKey, firstPage, query, staleAfterMs = stewardDirectStaleAfterMs() }: {
  enabled: boolean;
  scopeKey: string;
  firstPage: readonly MemberConversation[];
  query: string;
  /** How long a kept row may stay on screen after the read that last returned it. */
  staleAfterMs?: number;
}): StewardDirectPages {
  // The streams live in a ref so each reader sees the rows as they are now;
  // a version bump renders them.
  const [, setVersion] = useState(0);
  const streams = useRef<Record<Kind, Stream>>({ browse: emptyStream(scopeKey), search: emptyStream(scopeKey) });
  const readers = useRef<Record<Kind, Reader>>({
    browse: { generation: 0, running: null, cycle: false, more: false, flight: Promise.resolve() },
    search: { generation: 0, running: null, cycle: false, more: false, flight: Promise.resolve() },
  });
  // A stream from another account, organization, chapter or hat is never
  // shown, even for the one render before the reset below lands.
  const browse = streams.current.browse.scope === scopeKey ? streams.current.browse : emptyStream(scopeKey);
  const search = streams.current.search.scope === scopeKey ? streams.current.search : emptyStream(scopeKey);
  const firstPageRef = useRef(firstPage);
  firstPageRef.current = firstPage;
  const firstPageAt = useRef<FreshnessStamp>(freshnessNow());
  const staleRef = useRef(staleAfterMs);
  staleRef.current = staleAfterMs;
  // The first page in view when the server refused the role. It stays hidden
  // until a new first page arrives from the server for this scope.
  const [refusal, setRefusal] = useState<{ scope: string; firstPage: readonly MemberConversation[] } | null>(null);
  const refused = enabled && refusal !== null && refusal.scope === scopeKey && refusal.firstPage === firstPage;

  const commit = useCallback((kind: Kind, update: (previous: Stream) => Stream) => {
    const previous = streams.current[kind];
    const next = update(previous);
    if (next === previous) return;
    streams.current = { ...streams.current, [kind]: next };
    setVersion((value) => value + 1);
  }, []);

  // Cancels the reader: a read in flight is dropped when it lands, and the
  // slot is free at once, so a read that never settles cannot hold up the
  // next scope or search term.
  const cancel = useCallback((kind: Kind) => {
    const reader = readers.current[kind];
    reader.generation += 1;
    reader.cycle = false;
    reader.more = false;
    reader.running = null;
    reader.flight = Promise.resolve();
  }, []);

  useEffect(() => {
    for (const kind of KINDS) {
      cancel(kind);
      commit(kind, () => emptyStream(scopeKey));
    }
  }, [cancel, commit, scopeKey]);
  useEffect(() => () => {
    for (const kind of KINDS) cancel(kind);
  }, [cancel]);

  const applyRefusal = useCallback((scope: string) => {
    for (const kind of KINDS) {
      cancel(kind);
      // The search term is dropped too, so the same query is asked again once
      // the server sends a new first page (the refusal releases).
      commit(kind, (previous) => (previous.scope !== scope ? previous : emptyStream(scope)));
    }
    setRefusal({ scope, firstPage: firstPageRef.current });
  }, [cancel, commit]);

  // Show older, more search results or Try again: the page after the rows on
  // screen. It continues them only if they are unchanged when it lands.
  const extend = useCallback(async (kind: Kind, live: () => boolean) => {
    const staleAfter = staleRef.current;
    commit(kind, (previous) => expire(previous, freshnessNow(), staleAfter));
    const stream = streams.current[kind];
    const scope = stream.scope;
    const tail = stream.kept[stream.kept.length - 1]?.row;
    const base = firstPageRef.current;
    const after = tail ?? (kind === 'browse' ? base[base.length - 1] : undefined);
    if (kind === 'browse' && !after) {
      commit(kind, (previous) => ({ ...previous, status: 'idle' }));
      return;
    }
    const startedAt = freshnessNow();
    let page: Awaited<ReturnType<typeof loadStewardDirectPage>>;
    try {
      page = await loadStewardDirectPage({ search: kind === 'search' ? stream.term : null, after: stewardDirectCursor(after) });
    } catch {
      if (live()) commit(kind, (previous) => (previous.scope !== scope ? previous : { ...previous, status: 'error' }));
      return;
    }
    if (!live()) return;
    if (page.refused) {
      applyRefusal(scope);
      return;
    }
    commit(kind, (previous) => {
      if (previous.scope !== scope) return previous;
      const current = expire(previous, freshnessNow(), staleAfter);
      const currentTail = current.kept[current.kept.length - 1]?.row;
      // The rows on screen changed under the read (they aged out), so the
      // page no longer continues them; Show older is offered again.
      if (tail ? !currentTail || !sameKey(currentTail, tail) : currentTail) return { ...current, status: 'idle' };
      const last = page.rows[page.rows.length - 1];
      const deeper = Boolean(last && (!current.deepest || sortsAbove(current.deepest, last)));
      return {
        ...current,
        kept: [...current.kept, ...page.rows.map((row) => ({ row, seen: startedAt }))],
        started: true,
        ended: !page.next,
        status: 'idle',
        pages: deeper ? current.pages + 1 : current.pages,
        deepest: deeper && last ? last : current.deepest,
        // The steward asked: cycles read what is open now again.
        refill: 'none',
        refilledAt: null,
        parked: null,
      };
    });
  }, [applyRefusal, commit]);

  // One cycle: read the stream again from its start to the depth the steward
  // opened, publishing each page as it lands.
  const revalidate = useCallback(async (kind: Kind, live: () => boolean) => {
    const staleAfter = staleRef.current;
    const stream = streams.current[kind];
    // A stream that ended with nothing past its base is still read once per
    // cycle, so a conversation (or a search match) authorized later appears.
    if (!stream.started || (stream.pages === 0 && !stream.ended)) return;
    if (kind === 'search' && !stream.term) return;
    const scope = stream.scope;
    const base = firstPageRef.current;
    if (kind === 'browse' && base.length < STEWARD_DIRECT_PAGE) return;
    let after: Key | null = kind === 'browse' ? base[base.length - 1]! : null;
    const { pages, deepest, term } = stream;
    const parkedAtStart = stream.parked;
    let read = 0;
    let slowest = 0;
    for (;;) {
      const startedAt = freshnessNow();
      let page: Awaited<ReturnType<typeof loadStewardDirectPage>>;
      try {
        page = await loadStewardDirectPage({ search: kind === 'search' ? term : null, after: stewardDirectCursor(after ?? undefined) });
      } catch {
        return;
      }
      if (!live()) return;
      if (page.refused) {
        applyRefusal(scope);
        return;
      }
      read += 1;
      slowest = Math.max(slowest, freshnessAge(startedAt, freshnessNow()));
      const last = page.rows[page.rows.length - 1] ?? null;
      const covered = read >= pages && (!deepest || !last || !sortsAbove(last, deepest));
      const final = !page.next || !last || covered || read >= pages + 2;
      const from = after;
      let joined = true;
      commit(kind, (previous) => {
        if (previous.scope !== scope) return previous;
        const current = expire(previous, freshnessNow(), staleAfter);
        // A later page joins the rows above it only while the row it was read
        // after is still on screen; otherwise the next cycle starts again. A
        // cycle that began before its depth was parked (or changed by a press)
        // does not reopen it.
        if (current.parked !== parkedAtStart || (read > 1 && from && !current.kept.some((entry) => sameKey(entry.row, from)))) {
          joined = false;
          return current;
        }
        const kept = replaceKeptRange<MemberConversation, Key>(current.kept, {
          after: from,
          last: page.next ? last : null,
          rows: page.rows,
          seen: startedAt,
          final,
          before: sortsAbove,
        });
        if (!final) return { ...current, kept };
        const landed = freshnessNow();
        let { refill, refilledAt, parked } = current;
        let nextPages = read;
        let nextDeepest = last ?? current.deepest;
        if (refill === 'pending') {
          refill = 'done';
          refilledAt = landed;
        } else if (refill === 'done' && refilledAt && freshnessAge(refilledAt, landed) >= staleAfter) {
          refill = 'none';
          refilledAt = null;
        }
        // A parked depth comes back once reads are fast enough that each of
        // its pages would be read again before it ages out.
        if (parked && Math.max(staleAfter / 2, parked.pages * slowest) + slowest < staleAfter) {
          nextPages = Math.max(nextPages, parked.pages);
          if (parked.deepest && (!nextDeepest || sortsAbove(nextDeepest, parked.deepest))) nextDeepest = parked.deepest;
          parked = null;
        }
        return {
          ...current,
          kept,
          started: true,
          ended: !page.next,
          pages: nextPages,
          deepest: nextDeepest,
          status: current.status === 'error' ? 'idle' : current.status,
          refill,
          refilledAt,
          parked,
        };
      });
      if (!joined || final || !last) return;
      after = last;
    }
  }, [applyRefusal, commit]);

  // One reader per stream: Show older and the like first, then a waiting
  // cycle. Nothing here cancels a read; only `cancel` drops one. A new reader
  // starts only after a cancelled one's read lands, so a stream never has two
  // reads in flight.
  const pump = useCallback((kind: Kind) => {
    const reader = readers.current[kind];
    if (reader.running === reader.generation) return;
    const generation = reader.generation;
    reader.running = generation;
    const live = () => reader.generation === generation;
    reader.flight = reader.flight.then(async () => {
      try {
        while (live()) {
          if (reader.more) {
            reader.more = false;
            await extend(kind, live);
          } else if (reader.cycle) {
            reader.cycle = false;
            await revalidate(kind, live);
          } else {
            break;
          }
        }
      } finally {
        if (reader.running === generation) reader.running = null;
      }
    }).catch(() => undefined);
  }, [extend, revalidate]);

  // Each new first page confirms the kept rows it lists and prunes the ones it
  // covers and no longer lists. A first page shorter than a full page (empty
  // included) is the whole list: every older page and search page is dropped
  // and every read in flight is cancelled, so a late answer from before it
  // can never fill a cache that a later full page would show again.
  useEffect(() => {
    const now = freshnessNow();
    firstPageAt.current = now;
    if (firstPage.length < STEWARD_DIRECT_PAGE) {
      for (const kind of KINDS) {
        const previous = streams.current[kind];
        if (!previous.started && !previous.kept.length && readers.current[kind].running === null) continue;
        cancel(kind);
        commit(kind, () => emptyStream(previous.scope));
      }
      return;
    }
    const listed = new Map(firstPage.map((row) => [row.id, row]));
    const tail = firstPage[firstPage.length - 1]!;
    for (const kind of KINDS) {
      commit(kind, (previous) => {
        let changed = false;
        const kept: Kept<MemberConversation>[] = [];
        for (const entry of previous.kept) {
          const copy = listed.get(entry.row.id);
          if (copy) {
            // Listed now, wherever the kept copy sat: the first page's copy
            // replaces it (and confirms it) when the key is the same, and a
            // row that moved (a reply) is the first page's alone until a
            // cycle reads it below.
            if (sameKey(copy, entry.row)) kept.push({ row: copy, seen: now });
            changed = true;
          } else if (sortsAbove(tail, entry.row)) {
            kept.push(entry);
          } else {
            changed = true;
          }
        }
        return changed ? { ...previous, kept } : previous;
      });
    }
  }, [cancel, commit, firstPage]);

  // A new full first page asks each stream for one cycle.
  useEffect(() => {
    if (!enabled || refused || firstPage.length < STEWARD_DIRECT_PAGE) return;
    for (const kind of KINDS) {
      if (streams.current[kind].scope !== scopeKey) continue;
      readers.current[kind].cycle = true;
      pump(kind);
    }
  }, [enabled, firstPage, pump, refused, scopeKey]);

  // A kept row leaves the screen the moment it is too old.
  useFreshnessCut([browse.kept, search.kept], staleAfterMs, () => {
    const now = freshnessNow();
    for (const kind of KINDS) commit(kind, (previous) => expire(previous, now, staleAfterMs));
  });

  // A short first page is the whole list, whatever an older page said.
  const browseComplete = firstPage.length < STEWARD_DIRECT_PAGE || (browse.started && browse.ended);
  const term = query.trim();
  const searching = enabled && term.length > 0 && !browseComplete;

  // A search term the loaded list cannot answer goes to the server after a
  // short pause. Clearing the term returns to the loaded list unchanged.
  useEffect(() => {
    // Nothing is asked while refused; the search restarts when it releases.
    if (refused) return undefined;
    if (!searching) {
      if (search.term) {
        cancel('search');
        commit('search', () => emptyStream(scopeKey));
      }
      return undefined;
    }
    if (search.term === term) return undefined;
    const timer = setTimeout(() => {
      cancel('search');
      commit('search', () => ({ ...emptyStream(scopeKey, term), status: 'loading' }));
      readers.current.search.more = true;
      pump('search');
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [cancel, commit, pump, refused, scopeKey, search.term, searching, term]);

  const loadOlder = useCallback(() => {
    if (!enabled || refused) return;
    const current = streams.current.browse;
    if (current.scope !== scopeKey || current.status === 'loading') return;
    if (!current.started) {
      // The first page the steward is looking at becomes the base, so a
      // conversation that a refresh later pushes off the first page stays
      // until a cycle reads it again.
      const seen = firstPageAt.current;
      const base = firstPageRef.current.map((row) => ({ row, seen }));
      if (!base.length) return;
      commit('browse', () => ({ ...emptyStream(scopeKey), kept: base, started: true, status: 'loading' }));
    } else {
      if (current.ended) return;
      commit('browse', (previous) => ({ ...previous, status: 'loading' }));
    }
    readers.current.browse.more = true;
    pump('browse');
  }, [commit, enabled, pump, refused, scopeKey]);

  const loadMore = useCallback(() => {
    if (!enabled || refused) return;
    if (!searching) {
      loadOlder();
      return;
    }
    const current = streams.current.search;
    if (current.scope !== scopeKey || current.status === 'loading' || !current.term) return;
    if (current.started && current.ended) return;
    commit('search', (previous) => ({ ...previous, status: 'loading' }));
    readers.current.search.more = true;
    pump('search');
  }, [commit, enabled, loadOlder, pump, refused, scopeKey, searching]);

  // Age is measured on every render, not only when the cut runs.
  const renderedAt = freshnessNow();
  const browseFresh = freshCount(browse.kept, renderedAt, staleAfterMs);
  const searchFresh = freshCount(search.kept, renderedAt, staleAfterMs);
  const conversations = useMemo(() => {
    if (!enabled) return [...firstPage];
    if (refused || firstPage.length === 0) return [];
    const loaded = mergeStewardDirectRows(firstPage, pruneStewardDirectRows(browse.kept.slice(0, browseFresh).map((entry) => entry.row), firstPage));
    return searching ? mergeStewardDirectRows(loaded, pruneStewardDirectRows(search.kept.slice(0, searchFresh).map((entry) => entry.row), firstPage)) : loaded;
  }, [browse.kept, browseFresh, enabled, firstPage, refused, search.kept, searchFresh, searching]);

  const older = { olderHasMore: enabled && !refused && !browseComplete, olderStatus: browse.status, loadOlder };
  if (!enabled || refused) {
    return { conversations, status: 'idle', hasMore: false, ended: false, searching: false, loadMore, ...older };
  }
  if (searching) {
    const searchSettled = search.term === term && search.started;
    return {
      conversations,
      status: search.term === term ? search.status : 'loading',
      hasMore: searchSettled && !search.ended,
      ended: searchSettled && search.ended && search.status !== 'error',
      searching: true,
      loadMore,
      ...older,
    };
  }
  return {
    conversations,
    status: browse.status,
    hasMore: !browseComplete,
    ended: browseComplete && browse.status !== 'error',
    searching: false,
    loadMore,
    ...older,
  };
}
