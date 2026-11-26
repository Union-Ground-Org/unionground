import { createContext, useContext } from "react";

// UX-UG-PUBLIC-SITE-HEADER-FOOTER-AND-LANGUAGE-SWITCH-DIFFER-PAGE-TO-PAGE-20261122
// (C-1): the signed-out page's own language and the way to change it, offered
// by StandaloneLanguageShell to the site header inside it. Null outside that
// shell (Home and the sign-in page pass their own handler; signed-in screens
// have none), so a header there shows no switch it could not honour.
export const SiteLanguageSwitchContext = createContext(null);

export function useSiteLanguageSwitch() {
  return useContext(SiteLanguageSwitchContext);
}
