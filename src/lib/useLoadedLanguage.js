import { useEffect, useState } from "react";
import { languageLoaded, loadLanguage } from "./i18n.js";

const FALLBACK_LANGUAGE = "en";

// The language a screen can render right now, given the one it was asked for
// (PERF-UG-WEB-SHELL-AND-PER-LANGUAGE-BUNDLES-20261011).
//
// A requested language whose catalogue is already registered renders at once.
// One that is still loading keeps the language already on screen, so a switch
// is a single repaint from one whole language to the other, never a mix of
// translated copy and English fallback. The newest request always wins: a
// request that is no longer current when its load settles changes nothing, so
// a slow Spanish chunk landing after the member switched back to English
// cannot repaint the screen in Spanish. A load that fails (after the one retry
// inside loadLanguage) settles on English; asking for the language again
// retries: a new `attempt` (the shell advances it on every language selection,
// including a repeat of the failed one) starts a fresh load. `pending` is true
// only while the requested catalogue is in flight.
export function useLoadedLanguage(requested, load = loadLanguage, attempt = 0) {
  const [shown, setShown] = useState(() => (languageLoaded(requested) ? requested : FALLBACK_LANGUAGE));
  const [failed, setFailed] = useState(null);
  const ready = languageLoaded(requested);
  useEffect(() => {
    if (ready) return undefined;
    let current = true;
    load(requested).then((ok) => {
      if (!current) return;
      setFailed(ok ? null : { requested, attempt, load });
      setShown(ok ? requested : FALLBACK_LANGUAGE);
    });
    return () => { current = false; };
  }, [ready, requested, load, attempt]);
  if (ready) return { lang: requested, pending: false };
  return { lang: shown, pending: !(failed?.requested === requested && failed.attempt === attempt && failed.load === load) };
}
