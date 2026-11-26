import { createContext, useContext } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { noStewardCopy } from "../lib/stewardConversations.js";

// #9595: the reader's stewardPresence, computed once in App, for shell rows
// that sit outside any one page (the Be heard rail hint).
const StewardPresenceContext = createContext(null);
export const StewardPresenceProvider = StewardPresenceContext.Provider;
export function useStewardPresence() {
  return useContext(StewardPresenceContext);
}

// #9595: said where a member page would otherwise promise a steward, when no
// steward is named for the reader: who is missing and who can name one.
// Renders nothing in every other state.
export function NoStewardNote({ presence, className }) {
  const { t } = useLang();
  const copy = noStewardCopy(presence);
  if (!copy) return null;
  return <p className={className} data-no-steward={presence}><strong>{t(copy.title)}</strong> {t(copy.who)}</p>;
}
