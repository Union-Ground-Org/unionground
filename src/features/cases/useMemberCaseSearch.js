import { useEffect, useMemo, useState } from "react";
import { fetchMemberCaseRows } from "./caseSearchApi.js";
import { serverCaseEntries } from "../../lib/searchIndex.js";

const EMPTY_ENTRIES = Object.freeze([]);

// Typing is not a query. The debounce keeps one keystroke from becoming one
// round trip, and the AbortController releases the answer to a query the
// member has already typed past — otherwise a slow early request can land on
// top of a fast later one and show results for a prefix.
const CASE_SEARCH_DEBOUNCE_MS = 250;

export function useMemberCaseSearch({
  client = null,
  query = "",
  enabled = true,
  limit,
  formatDeadline,
  t,
  debounceMs = CASE_SEARCH_DEBOUNCE_MS,
} = {}) {
  const trimmed = String(query ?? "").trim();
  const shouldLoad = Boolean(client && enabled && trimmed);
  const [remote, setRemote] = useState(null);
  // The raw rows stay in state and the display entries are derived from them
  // with the formatter of the current render, so a language switch relabels the
  // loaded deadlines without a second search and an inline formatter cannot
  // loop (it is not state and not an effect dependency).
  const entries = useMemo(
    () => (remote && remote.phase === "ready" ? serverCaseEntries(remote.rows, { ...(formatDeadline ? { formatDeadline } : {}), ...(t ? { t } : {}) }) : EMPTY_ENTRIES),
    [remote, formatDeadline, t],
  );

  useEffect(() => {
    if (!shouldLoad) {
      setRemote(null);
      return undefined;
    }
    let current = true;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchMemberCaseRows(client, trimmed, { limit, signal: controller.signal }).then(
        (rows) => { if (current) setRemote({ client, query: trimmed, rows, phase: "ready", error: null }); },
        (error) => {
          if (current && !controller.signal.aborted) {
            setRemote({ client, query: trimmed, rows: EMPTY_ENTRIES, phase: "error", error });
          }
        },
      );
    }, debounceMs);
    return () => {
      current = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, debounceMs, enabled, limit, shouldLoad, trimmed]);

  if (!shouldLoad) return { entries: EMPTY_ENTRIES, phase: "idle", error: null };
  // The render-time identity check keeps the previous query's rows off screen
  // for the frame between a keystroke and the effect that supersedes them.
  if (!remote || remote.client !== client || remote.query !== trimmed) {
    return { entries: EMPTY_ENTRIES, phase: "loading", error: null };
  }
  return { entries, phase: remote.phase, error: remote.error };
}
