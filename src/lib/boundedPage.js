// SILENT-TRUNCATION guard (owner decision, Nov 10, 2026: one shared guard per
// recurring bug class). A capped list read asks for one row past its cap, so
// it can tell "this is everything" from "more exists" instead of stopping at
// the cap without a word. Callers show at most `cap` rows and must surface
// `more` (an earlier-page control, a "more exist" note, a cursor).
// tests/helpers/silentTruncation.js checks a read against this contract.

// The most rows one API response carries: supabase/config.toml [api]
// max_rows = 1000. PostgREST cuts a longer answer to it with no error, so a
// cap whose probe row would pass it can never see that row (#8144, Grok G7).
export const POSTGREST_MAX_ROWS = 1000;

/** The row count to ask the server for: one past the cap, within the ceiling. */
export function cappedLimit(cap) {
  if (!Number.isInteger(cap) || cap < 1 || cap + 1 > POSTGREST_MAX_ROWS) {
    throw new RangeError(`A capped read shows at most ${POSTGREST_MAX_ROWS - 1} rows (cap ${cap} + 1 probe row passes max_rows ${POSTGREST_MAX_ROWS}).`);
  }
  return cap + 1;
}

/**
 * The rows to show from a read that asked for `cappedLimit(cap)` rows, in the
 * order the server returned them, and whether more exist past the cap.
 * @template Row
 * @param {Row[] | null | undefined} rows
 * @param {number} cap
 * @returns {{ rows: Row[], more: boolean }}
 */
export function boundedRows(rows, cap) {
  const list = Array.isArray(rows) ? rows : [];
  return { rows: list.slice(0, cap), more: list.length > cap };
}
