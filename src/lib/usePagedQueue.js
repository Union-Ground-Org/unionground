import { useCallback, useLayoutEffect, useRef, useState } from "react";

// One paged desk queue (UB-DESK-01): the desk load carries page one (fetched
// with the DEFAULT params), and this hook takes over from there — server-side
// search/filter/sort refetches page one with the new params, "load more"
// appends the next keyset page, and a generation stamp keeps a stale response
// from appending rows or resurrecting a cursor after the desk reloaded or the
// params moved on (the CoordinatorView queueGen pattern).
//
// seed: { rows, cursor, total, error? } derived from the desk, or null while loading.
// fetcher: (params & { cursor }) => Promise<{ rows, nextCursor, total }>.
// defaults: the params the desk's own first page was fetched with.
//
// sol-review hardening (PR #734):
//   - Adoption runs in useLayoutEffect so the desk's rows land BEFORE paint —
//     a committed frame can never flash "no rows yet" between the desk
//     arriving and the seed being adopted (F4).
//   - A cursor is trimmed to null the moment the loaded rows cover the TRUE
//     total, so a page that ends exactly on the boundary never renders a
//     phantom "Load more" (F5).
//   - A failed "load more" keeps the rows and the cursor and sets moreError;
//     the pager retries by walking the same cursor again. Only a failed
//     page-one fetch blanks the list (F3 — retry used to re-adopt the seed
//     and silently throw away every loaded page).
//   - retry() forces a FRESH page-one fetch even under default params, so the
//     "list changed while you walked it" disclosure has a real refresh to
//     offer (keyset over a mutable sort key can strand rows mid-walk — F1).
function paramsEqual(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

function dedupeById(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

// The server's total is the honest end-of-walk signal: once the screen holds
// every matching row, a full-page cursor is a phantom, not a promise.
function trimCursor(cursor, rowCount, total) {
  if (!cursor) return null;
  if (total != null && rowCount >= total) return null;
  return cursor;
}

export function usePagedQueue(seed, fetcher, defaults) {
  const [params, setParams] = useState(defaults);
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState({ rows: [], cursor: null, total: 0, loading: false, firstPageLoading: false, error: false, moreError: false });
  const gen = useRef(0);
  // A failed seed is only this generation's answer until the hook has asked
  // the server itself. Once it has, a failed seed on default params (the same
  // one, or a later desk reload that soft-failed this section again) fetches
  // page one instead of blanking rows the hook already recovered. Only a
  // healthy seed resets this and is adopted as is.
  const seedRef = useRef(seed);
  const leftFailedSeed = useRef(false);

  useLayoutEffect(() => {
    const g = ++gen.current;
    if (seedRef.current !== seed) {
      seedRef.current = seed;
      if (!seed?.error) leftFailedSeed.current = false;
    }
    if (!seed) return;
    // Default params on the seed's own terms: page one is already in hand —
    // adopt it synchronously, no refetch. The desk reload path (post-action
    // reload()) re-enters here too, so a triage or reply always lands back on
    // fresh server rows. A retry (nonce > 0) skips adoption on purpose: the
    // caller asked for fresher rows than the seed.
    const adoptSeed = (paramsEqual(params, defaults) && nonce === 0) || !fetcher;
    if (adoptSeed && !(seed.error && leftFailedSeed.current)) {
      // A failed initial read belongs to this generation only. A later
      // filtered fetch or retry replaces it just like any other page.
      if (seed.error) {
        setState({ rows: [], cursor: null, total: null, loading: false, firstPageLoading: false, error: true, moreError: false });
        return;
      }
      const total = seed.total ?? seed.rows.length;
      setState({ rows: seed.rows, cursor: trimCursor(seed.cursor ?? null, seed.rows.length, total), total, loading: false, firstPageLoading: false, error: false, moreError: false });
      return;
    }
    leftFailedSeed.current = true;
    // Retained rows/total belong to the previous page-one parameters until
    // this response arrives. Consumers can hide their stale count separately
    // from a load-more fetch, whose current count still describes its set.
    setState((prev) => ({ ...prev, loading: true, firstPageLoading: true, error: false, moreError: false }));
    fetcher({ ...params, cursor: null }).then((page) => {
      if (gen.current !== g) return;
      const total = page.total ?? 0;
      setState({ rows: page.rows, cursor: trimCursor(page.nextCursor, page.rows.length, total), total, loading: false, firstPageLoading: false, error: false, moreError: false });
    }).catch(() => {
      if (gen.current !== g) return;
      // The rows on screen predate the failed request — drop them rather than
      // caption stale rows with the new filter's totals.
      setState({ rows: [], cursor: null, total: 0, loading: false, firstPageLoading: false, error: true, moreError: false });
    });
    // paramsEqual walks both objects, so params/defaults identity churn never
    // refires this — only real value changes, a new seed, or a retry do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, params, nonce]);

  const loadMore = useCallback(() => {
    if (!state.cursor || !fetcher || state.loading) return;
    const g = gen.current;
    setState((prev) => ({ ...prev, loading: true, moreError: false }));
    fetcher({ ...params, cursor: state.cursor }).then((page) => {
      if (gen.current !== g) return;
      setState((prev) => {
        const rows = dedupeById([...prev.rows, ...page.rows]);
        const total = page.total ?? prev.total;
        return { rows, cursor: trimCursor(page.nextCursor, rows.length, total), total, loading: false, firstPageLoading: false, error: false, moreError: false };
      });
    }).catch(() => {
      if (gen.current !== g) return;
      // Keep the rows AND the cursor: the retry is simply walking the same
      // keyset position again via the Load more button.
      setState((prev) => ({ ...prev, loading: false, moreError: true }));
    });
  }, [state.cursor, state.loading, fetcher, params]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  return { ...state, params, setParams, loadMore, retry };
}

// Offset paging for already loaded lists; shares Pager's one-based page contract.
export function usePagedList(rows, pageSize = 25) {
  const [requestedPage, setPage] = useState(1);
  const total = rows.length;
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total, setPage };
}
