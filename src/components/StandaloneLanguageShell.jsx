import { useCallback, useMemo, useState } from "react";
import { LanguageProvider, useLang } from "../lib/LanguageContext.jsx";
import { bootLanguage } from "../lib/bootLanguage.js";
import { languageLoaded } from "../lib/i18n.js";
import { SiteLanguageSwitchContext } from "../lib/siteLanguageSwitch.js";
import { useLoadedLanguage } from "../lib/useLoadedLanguage.js";

// UX-UG-STANDALONE-PAGES-NO-LANGUAGE-SWITCH-20261018: the standalone
// pages reached from an email or a link (invitation, password reset, request
// an invite, get the app) rendered in the browser's language with no way to
// change it, while the sign-in card offers English/Español. This shell owns
// the language for one standalone page: it starts from the same boot guess the
// shell uses, keeps the language already on screen until the other catalogue
// has loaded (useLoadedLanguage), and remembers a choice in sg-lang exactly as
// the sign-in card does, so the next page and the member shell follow it.
// UX-UG-PUBLIC-SITE-HEADER-FOOTER-AND-LANGUAGE-SWITCH-DIFFER-PAGE-TO-PAGE-20261122
// (C-1, C-3): every page under this shell offers the change to the site
// header inside it, so the information pages, the legal pages, the chapter
// directory, the join page, Free pilot and Ask your union carry Home's EN ES
// toggle in the one header bar; a visitor who chose Spanish on Home can switch
// back on each of them. The bar below sits above the pages that have no site
// header yet (invitation, reset, request-invite, get-app) and only those.
export const LANGUAGE_SWITCH_STANDALONE_PATHS = Object.freeze([
  "/invite", "/app/invite", "/reset-password", "/app/reset-password", "/get-app", "/request-invite",
]);

// The pages that start from the boot guess even when its catalogue is not
// registered yet, and fetch it on first paint: the bar pages. Every other page
// keeps its first paint from before #9539.
export const BOOT_LANGUAGE_STANDALONE_PATHS = Object.freeze([
  ...LANGUAGE_SWITCH_STANDALONE_PATHS,
]);

function rememberLanguageChoice(next) {
  try { window.localStorage.setItem("sg-lang", next); } catch { /* storage may be unavailable */ }
}

export function StandaloneLanguageShell({ children, languageSwitch = false, loadBootLanguage = languageSwitch }) {
  // A page that does not load the boot language keeps the shell's
  // long-standing first paint: the boot language only if main.jsx already
  // settled its catalogue, else English throughout, with no late fetch and
  // repaint (tests/web-shell-lazy-directory). Only a visitor's own choice in
  // its header fetches the other catalogue there.
  const [chosen, setChosen] = useState(() => {
    const boot = bootLanguage();
    return loadBootLanguage || languageLoaded(boot) ? boot : "en";
  });
  // Advanced on every selection so a catalogue that failed to load is fetched
  // again when the visitor asks for that language once more.
  const [attempt, setAttempt] = useState(0);
  const { lang } = useLoadedLanguage(chosen, undefined, attempt);
  const change = useCallback((next) => {
    setChosen(next);
    setAttempt((count) => count + 1);
    rememberLanguageChoice(next);
  }, []);
  const siteSwitch = useMemo(() => ({ lang, change }), [lang, change]);
  return (
    <LanguageProvider lang={lang}>
      <SiteLanguageSwitchContext.Provider value={siteSwitch}>
        {languageSwitch ? (
          <div className="standalone-shell">
            <StandaloneLanguageBar lang={lang} onChange={change} />
            {children}
          </div>
        ) : children}
      </SiteLanguageSwitchContext.Provider>
    </LanguageProvider>
  );
}

// Same control as the sign-in card: aria-pressed buttons in a named group,
// labelled in the language on screen.
function StandaloneLanguageBar({ lang, onChange }) {
  const { t } = useLang();
  return (
    <header className="standalone-language-bar">
      <div className="segment auth-language" role="group" aria-label={t("auth.language")}>
        <button type="button" lang="en" aria-pressed={lang === "en"} onClick={() => onChange("en")}>{t("auth.langEnglish")}</button>
        <button type="button" lang="es" aria-pressed={lang === "es"} onClick={() => onChange("es")}>{t("auth.langSpanish")}</button>
      </div>
    </header>
  );
}
