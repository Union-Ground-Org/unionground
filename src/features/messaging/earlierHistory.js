// BUG-UG-WEB-CHANNEL-HIDES-POSTS-PAST-NEWEST-1000-20261110: the web
// form of the native app's earlier-history hook
// (apps/mobile/src/features/useConversationHistory.ts, #7917 and #8077), so a
// web channel thread pages back under the same rules. It is that hook and its
// freshness helpers (apps/mobile/src/lib/freshRows.ts) compiled to JavaScript,
// with the page's visibility in place of the app's foreground state; change
// both together.
//
// A screen's newest page is `thread` ({ messages, earlierCursor }); rows order
// by (createdAt, id). The earlier pages a reader opens live here and survive
// every refresh of the newest page. A new scope key, a missing thread or a
// newest page with no cursor keeps nothing. No earlier row stays on screen two
// reconciles (60 s) or longer after the start of the last read that returned
// it; a row the newest page lists shows that page's copy. One reader, at most
// one read in flight; a read that started before a newest page spoke about a
// row never brings back its old copy. A screen with no reconcile of its own
// passes `revalidateMs`, so opened history is read again on that timer.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Freshness helpers (apps/mobile/src/lib/freshRows.ts).
function monotonicNow() {
    const clock = globalThis.performance;
    return clock && typeof clock.now === 'function' ? clock.now() : Date.now();
}
function freshnessNow() {
    return { wall: Date.now(), mono: monotonicNow() };
}
function freshnessAge(seen, now) {
    return Math.max(now.wall - seen.wall, now.mono - seen.mono);
}
/**
 * One page read again replaces the kept rows in the range it covers: strictly
 * after `after` (the start when null) through `last` (the end when null), in
 * the list's order, where `before(a, b)` means a comes first. The last page of
 * a re-read also drops what lies past it.
 */
function replaceKeptRange(kept, range) {
    const { after, last, rows, seen, final, before } = range;
    const head = after ? kept.filter((entry) => !before(after, entry.row)) : [];
    const tail = last && !final ? kept.filter((entry) => before(last, entry.row)) : [];
    return [...head, ...rows.map((row) => ({ row, seen })), ...tail];
}
/**
 * Calls `cut` the moment the oldest kept row reaches the bound, and again when
 * the page becomes visible again: timers are throttled while it is hidden,
 * so a row that aged out meanwhile is cut before the page shows again. Nothing is subscribed while
 * no row is kept.
 */
function useFreshnessCut(lists, staleAfterMs, cut) {
    const cutRef = useRef(cut);
    cutRef.current = cut;
    const [, setWoken] = useState(0);
    let soonest = Infinity;
    const now = freshnessNow();
    for (const kept of lists) {
        for (const entry of kept)
            soonest = Math.min(soonest, staleAfterMs - freshnessAge(entry.seen, now));
    }
    const holding = soonest !== Infinity;
    // Rescheduled on each render from the clocks read above, so the timer
    // always waits the time left. It also renders again, so a timer that fires
    // a little early (the two clocks drift) measures again and reschedules
    // instead of leaving the row for the next unrelated render.
    useEffect(() => {
        if (!holding)
            return undefined;
        const timer = setTimeout(() => {
            cutRef.current();
            setWoken((value) => value + 1);
        }, Math.max(0, soonest));
        return () => clearTimeout(timer);
    }, [holding, soonest]);
    useEffect(() => {
        if (!holding || typeof document === 'undefined')
            return undefined;
        const onVisible = () => {
            if (document.visibilityState === 'visible')
                cutRef.current();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [holding]);
}

// The history (apps/mobile/src/features/useConversationHistory.ts).
/** The conversation screen reads the newest page again this often (its `setInterval(reconcile, 30000)`). */
export const EARLIER_HISTORY_RECONCILE_MS = 30_000;
/** Reconciles an earlier message may go without a read that returns it. */
const CONVERSATION_HISTORY_STALE_RECONCILES = 2;
function emptyHistory(scope) {
    return { scope, started: false, kept: [], ended: false, status: 'idle', lastLoaded: 0, pages: 0, deepest: null };
}
function compareMessages(left, right) {
    const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    if (byTime)
        return byTime;
    if (left.createdAt !== right.createdAt)
        return left.createdAt < right.createdAt ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
/** In the kept order (newest first), `row` comes before `other`. */
function newer(row, other) {
    return compareMessages(row, other) > 0;
}
function sameKey(row, other) {
    return row.id === other.id && row.createdAt === other.createdAt;
}
// An earlier read keeps a message's copy only when it started after the last
// newest page that spoke about the message. Otherwise the newest page's copy
// stands in (a redaction or an edit it carried stays), or the message stays
// out (it was removed), whatever order the answers arrive in.
function settle(rows, startedStep, confirmed) {
    return rows.flatMap((row) => {
        const said = confirmed.get(row.id);
        if (!said || said.step < startedStep)
            return [row];
        return said.row ? [said.row] : [];
    });
}
// How many kept messages, from the newest, stay: an unbroken run of fresh ones.
// A message the newest page lists shows that page's copy, never the kept one,
// so its age does not cut the history behind it (a screen with no reconcile
// does not confirm it again); every message shown from the kept copy is
// still held to the bound.
function freshLength(kept, now, staleAfterMs, listed) {
    let count = 0;
    while (count < kept.length && (listed.has(kept[count].row.id) || freshnessAge(kept[count].seen, now) < staleAfterMs))
        count += 1;
    return count;
}
function expire(history, now, staleAfterMs, listed) {
    const keep = freshLength(history.kept, now, staleAfterMs, listed);
    return keep === history.kept.length ? history : { ...history, kept: history.kept.slice(0, keep), ended: false };
}
// Chronological, one copy per message; the newest read's copy wins, so an
// edit, redaction or reaction it carries replaces the kept copy.
function mergeConversationHistory(kept, newest) {
    const byID = new Map();
    for (const row of kept)
        byID.set(row.id, row);
    for (const row of newest)
        byID.set(row.id, row);
    return [...byID.values()].sort(compareMessages);
}
export function useEarlierHistory({ scopeKey, thread, load, staleAfterMs = CONVERSATION_HISTORY_STALE_RECONCILES * EARLIER_HISTORY_RECONCILE_MS, revalidateMs }) {
    // The history lives in a ref so the reader sees it as it is now; a version
    // bump renders it.
    const [, setVersion] = useState(0);
    const store = useRef(emptyHistory(scopeKey));
    const reader = useRef({ generation: 0, running: null, cycle: false, more: false, flight: Promise.resolve(), unsettled: 0 });
    const history = store.current.scope === scopeKey ? store.current : emptyHistory(scopeKey);
    const threadRef = useRef(thread);
    threadRef.current = thread;
    const listed = useMemo(() => new Set((thread?.messages ?? []).map((row) => row.id)), [thread]);
    const listedRef = useRef(listed);
    listedRef.current = listed;
    const threadAt = useRef(freshnessNow());
    // Newest-page copies and removals in this scope, younger than the bound: a
    // read that started before an older one has already aged out.
    const confirmed = useRef(new Map());
    // Read starts and newest pages, in the order they happen.
    const steps = useRef(0);
    const lastListed = useRef([]);
    const loadRef = useRef(load);
    loadRef.current = load;
    const staleRef = useRef(staleAfterMs);
    staleRef.current = staleAfterMs;
    const commit = useCallback((update) => {
        const previous = store.current;
        const next = update(previous);
        if (next === previous)
            return;
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
        commit(() => emptyHistory(scopeKey));
    }, [cancel, commit, scopeKey]);
    useEffect(() => cancel, [cancel]);
    // Show earlier or Try again: the page before the messages on screen. It
    // continues them only if they are unchanged when it lands.
    const extend = useCallback(async (live) => {
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
        let page;
        try {
            page = await loadRef.current({ createdAt: before.createdAt, id: before.id });
        }
        catch {
            if (live())
                commit((previous) => (previous.scope !== scope ? previous : { ...previous, status: 'error' }));
            return;
        }
        if (!live())
            return;
        commit((previous) => {
            if (previous.scope !== scope)
                return previous;
            const fresh = expire(previous, freshnessNow(), staleAfter, listedRef.current);
            const freshTail = fresh.kept[fresh.kept.length - 1]?.row;
            // The messages on screen changed under the read (they aged out), so the
            // page no longer continues them; Show earlier is offered again.
            if (tail ? !freshTail || !sameKey(freshTail, tail) : freshTail)
                return { ...fresh, status: 'idle' };
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
    const revalidate = useCallback(async (live) => {
        const staleAfter = staleRef.current;
        const current = store.current;
        const start = threadRef.current?.earlierCursor ?? null;
        if (!current.started || current.pages === 0 || !start)
            return;
        const scope = current.scope;
        const { pages, deepest } = current;
        let after = start;
        let read = 0;
        for (;;) {
            const startedAt = freshnessNow();
            const startedStep = ++steps.current;
            let page;
            try {
                page = await loadRef.current({ createdAt: after.createdAt, id: after.id });
            }
            catch {
                return;
            }
            if (!live())
                return;
            read += 1;
            const rows = [...page.messages].reverse();
            const oldest = rows[rows.length - 1] ?? null;
            const covered = read >= pages && (!deepest || !oldest || !newer(oldest, deepest));
            const final = !page.earlierCursor || !oldest || covered || read >= pages + 2;
            const from = after;
            let joined = true;
            commit((previous) => {
                if (previous.scope !== scope)
                    return previous;
                const fresh = expire(previous, freshnessNow(), staleAfter, listedRef.current);
                // A later page joins the messages above it only while the message it
                // was read before is still on screen; otherwise the next cycle starts
                // again.
                if (read > 1 && !fresh.kept.some((entry) => sameKey(entry.row, from))) {
                    joined = false;
                    return fresh;
                }
                const kept = replaceKeptRange(fresh.kept, {
                    after: from,
                    last: page.earlierCursor ? oldest : null,
                    rows: settle(rows, startedStep, confirmed.current),
                    seen: startedAt,
                    final,
                    before: newer,
                });
                if (!final)
                    return { ...fresh, kept };
                return {
                    ...fresh,
                    kept,
                    ended: !page.earlierCursor,
                    pages: read,
                    deepest: oldest ?? fresh.deepest,
                    status: fresh.status === 'error' ? 'idle' : fresh.status,
                };
            });
            if (!joined || final || !oldest)
                return;
            after = oldest;
        }
    }, [commit]);
    // Show earlier first, then a waiting cycle. Nothing here cancels a read;
    // only `cancel` drops one. A new reader starts only after a cancelled one's
    // read lands, so there are never two reads in flight; with nothing pending
    // it starts at once, so a press asks in the same turn.
    const pump = useCallback(() => {
        const current = reader.current;
        if (current.running === current.generation)
            return;
        const generation = current.generation;
        current.running = generation;
        const live = () => current.generation === generation;
        const run = async () => {
            try {
                while (live()) {
                    if (current.more) {
                        current.more = false;
                        await extend(live);
                    }
                    else if (current.cycle) {
                        current.cycle = false;
                        await revalidate(live);
                    }
                    else {
                        break;
                    }
                }
            }
            finally {
                if (current.running === generation)
                    current.running = null;
                // A cancelled run no longer counts (cancel already freed the slot).
                if (current.generation === generation)
                    current.unsettled -= 1;
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
                commit(() => emptyHistory(previous.scope));
            }
            return;
        }
        const listed = new Map(thread.messages.map((row) => [row.id, row]));
        // Remember what this page says until it ages out, so an earlier read that
        // started before it and lands later cannot undo it.
        const said = confirmed.current;
        for (const [id, entry] of said)
            if (freshnessAge(entry.at, now) >= staleRef.current)
                said.delete(id);
        const step = ++steps.current;
        for (const row of thread.messages)
            said.set(row.id, { row, step, at: now });
        const removed = (row) => {
            if (!listed.has(row.id) && !newer(cursor, row))
                said.set(row.id, { row: null, step, at: now });
        };
        lastListed.current.forEach(removed);
        lastListed.current = thread.messages;
        commit((previous) => {
            if (!previous.kept.length)
                return previous;
            let changed = false;
            const kept = [];
            for (const entry of previous.kept) {
                const copy = listed.get(entry.row.id);
                if (copy) {
                    // Listed now, wherever the kept copy sat: the newest page's copy (an
                    // edit or a redaction) replaces and confirms it, so it is what stays
                    // once it slides out.
                    kept.push({ row: copy, seen: now });
                    changed = true;
                }
                else if (newer(cursor, entry.row)) {
                    kept.push(entry);
                }
                else {
                    removed(entry.row);
                    changed = true;
                }
            }
            return changed ? { ...previous, kept } : previous;
        });
        if (store.current.scope !== scopeKey)
            return;
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
        if (!revalidateMs || !opened)
            return undefined;
        const timer = setInterval(() => {
            reader.current.cycle = true;
            pump();
        }, revalidateMs);
        return () => clearInterval(timer);
    }, [opened, pump, revalidateMs]);
    const loadEarlier = useCallback(() => {
        const current = threadRef.current;
        const previous = store.current;
        if (!current || previous.scope !== scopeKey || previous.status === 'loading' || !current.earlierCursor)
            return;
        if (!previous.started) {
            // The messages on screen become the base, so a message that a later
            // refresh slides out of the newest page stays until a cycle reads it
            // again. A linked message older than the page is not part of it.
            const cursor = current.earlierCursor;
            const seen = threadAt.current;
            const base = [...current.messages].reverse().filter((row) => !newer(cursor, row)).map((row) => ({ row, seen }));
            commit(() => ({ ...emptyHistory(scopeKey), kept: base, started: true, status: 'loading' }));
        }
        else {
            if (previous.ended)
                return;
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
        if (!newest)
            return [];
        if (!history.started || !cursor)
            return [...newest];
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
