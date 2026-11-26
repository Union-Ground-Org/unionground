import { ANNOUNCEMENT_LEASE_MS } from "./api.js";

const empty = { items: [], hidden: false, generation: null, loading: false, error: false, expired: false, busy: false, saveFailed: false };
// Only component-owned memory, bounded to one page. Each host remounts this hook
// for its tenant/user/session/chapter/hat/locale key. A generation is never merged.
/**
 * @param {Pick<typeof import('react'), 'useCallback' | 'useEffect' | 'useRef' | 'useState'>} hooks
 * @param {import('./api.js').AnnouncementApi} api
 * @param {string} locale
 * @param {boolean} [autoLoad]
 * @param {{ keepOnFailedSave?: boolean }} [options] keepOnFailedSave: the list stays while a hide saves,
 *   and a failed hide sets saveFailed (until a save succeeds) instead of the load error. Off by default.
 * @returns {{
 *   state: import('./api.js').Feed & { loading: boolean, busy: boolean, error: boolean, expired: boolean, saveFailed: boolean },
 *   refresh: (cursor?: import('./api.js').Announcement | null) => Promise<void>,
 *   clear: () => void,
 *   preference: (hidden: boolean) => Promise<void>
 * }}
 */
export function useAnnouncementFeedWith({ useCallback, useEffect, useRef, useState }, api, locale, autoLoad = true, { keepOnFailedSave = false } = {}) {
  const [state, setState] = useState(empty);
  const run = useRef(0);
  const busy = useRef(false);
  const clear = useCallback(() => { run.current += 1; setState(empty); }, []);
  const refresh = useCallback(async (cursor = null) => {
    const current = ++run.current;
    setState({ ...empty, loading: true });
    try {
      const result = await api.feed(locale, cursor);
      if (current === run.current) setState({ ...empty, ...result, receivedAt: Date.now() });
    } catch { if (current === run.current) setState({ ...empty, error: true }); }
  }, [api, locale]);
  useEffect(() => { if (autoLoad) void refresh(); return () => { run.current += 1; }; }, [refresh, autoLoad]);
  useEffect(() => {
    if (!state.items.length) return;
    const expiry = Math.min(state.receivedAt + ANNOUNCEMENT_LEASE_MS, ...state.items.map(row => Date.parse(row.expiresAt)));
    // The lease always clears the posts; with keepOnFailedSave a "not saved" notice outlives it.
    const expire = keepOnFailedSave ? previous => ({ ...empty, expired: true, saveFailed: previous.saveFailed }) : { ...empty, expired: true };
    const timer = setTimeout(() => { run.current += 1; setState(expire); }, Math.max(0, expiry - Date.now()));
    return () => clearTimeout(timer);
  }, [state.items, state.receivedAt, keepOnFailedSave]);
  const preference = useCallback(async hidden => {
    if (busy.current) return;
    busy.current = true;
    const current = ++run.current;
    // #9465 (W7-26): with keepOnFailedSave a failed save is not a failed read.
    setState(keepOnFailedSave ? previous => ({ ...previous, busy: true }) : { ...empty, busy: true });
    try {
      await api.preference(hidden);
      if (current === run.current) await refresh();
    } catch {
      if (current === run.current) setState(keepOnFailedSave ? previous => ({ ...previous, busy: false, saveFailed: true }) : { ...empty, error: true });
    }
    finally { busy.current = false; }
  }, [api, refresh, keepOnFailedSave]);
  return { state, refresh, clear, preference };
}
