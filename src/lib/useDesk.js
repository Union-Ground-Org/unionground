import { useCallback, useEffect, useRef, useState } from "react";
import { useLang } from "./LanguageContext.jsx";
import { SHELL_LOAD_DEADLINE_MS, withLoadDeadline } from "./loadDeadline.js";

// The load/error/retry triple every role-gated staff plane needs.
//
// All five planes (steward, coordinator, advisor, admin, VP) had their own copy
// of this, and the copies had already drifted: the coordinator and VP desks
// reported a raw English "Load failed" while the others used t("app.loadFailed"),
// so a Spanish-speaking coordinator hit an untranslated error on the one screen
// that was already going wrong. One hook, one translated fallback.
//
// `errorKey` exists for the steward desk, which says "Steward desk unavailable"
// rather than the generic line; everything else takes the default.
//
// `pageKey` is the desk page on screen (the workspace section). One desk read
// serves every page of a plane, so a single failed read used to leave the same
// failure card on every page the visitor opened next until they found Try
// again. Opening another page of a desk that is in error reads it again, the
// way a person would expect a new page to load.
//
// `pending` is true while a read is in flight, including a refresh or retry
// that still shows the previous desk, so a panel whose content depends on the
// read being current can hold back until it lands
// (BUG-UG-SMALL-LOCAL-GUIDE-NAMES-HELD-SWITCHES-20261112).
export function useDesk(api, errorKey = "app.loadFailed", pageKey = null, deadlineMs = SHELL_LOAD_DEADLINE_MS) {
  const { t } = useLang();
  const [desk, setDesk] = useState(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(true);
  const loadGeneration = useRef(0);
  const errorRef = useRef("");
  errorRef.current = error;
  const shownPage = useRef(pageKey);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    // Cleared up front, like every original did: the retry button must not
    // leave the failure card on screen while the second attempt is in flight.
    setError("");
    setPending(true);
    try {
      const nextDesk = await withLoadDeadline(api.loadDesk(), deadlineMs);
      if (generation === loadGeneration.current) { setDesk(nextDesk); setPending(false); }
    } catch {
      if (generation === loadGeneration.current) { setError(t(errorKey)); setPending(false); }
    }
  }, [api, t, errorKey, deadlineMs]);

  useEffect(() => {
    load();
    // A changed API or an unmounted desk must also retire its pending read.
    return () => { loadGeneration.current += 1; };
  }, [load]);

  useEffect(() => {
    if (shownPage.current === pageKey) return;
    shownPage.current = pageKey;
    if (errorRef.current) load();
  }, [pageKey, load]);

  // One panel's fresh read, applied to the desk already shown, so a saved
  // change shows without waiting for every other panel's reload
  // (REQ-UG-STALE-OR-CONTRADICTORY-STATE-AFTER-SAVE-20261030).
  const patch = useCallback((updater) => {
    setDesk((current) => (current ? updater(current) : current));
  }, []);

  return { desk, error, pending, load, patch };
}
