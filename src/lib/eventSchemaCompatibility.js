// Retry only a missing-column response, once, rebuilding the complete query.
// Never retry an authorization, transport or other database failure.
export const LEGACY_EVENT_COLUMNS = 'id,title,starts_at,location,summary,order_index,chapter_id,is_public,is_public_across_agencies,cancelled_at,cancelled_reason';
function eventColumnsMissing(error) {
  return ['42703', 'PGRST204'].includes(error?.code)
    && /\b(?:ends_at|event_kind|event_date|series_id|sort_at)\b/.test([error?.message, error?.details, error?.hint].join(' '));
}
// The member session loader records every request; a probe this module answers
// with its own retry is withdrawn there so it is not reported as a failed read
// (visual assurance run 37900350268). A plain Supabase result has no withdraw.
/**
 * @template R
 * @param {{ withdraw?: () => void } | null | undefined} probe
 * @param {() => R} retry
 * @returns {R}
 */
export function retryAfterProbe(probe, retry) {
  probe?.withdraw?.();
  return retry();
}
/**
 * @template {{ error: { code?: string, message?: string, details?: string, hint?: string } | null }} T
 * @param {(legacy: boolean) => PromiseLike<T>} query
 * @returns {Promise<T>}
 */
export async function readEventSchema(query) {
  const result = await query(false);
  return eventColumnsMissing(result.error) ? retryAfterProbe(result, () => query(true)) : result;
}
