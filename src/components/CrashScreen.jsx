import { t } from "../lib/i18n.js";
import { preferredLanguage } from "../lib/preferredLanguage.js";

// UX-UG-TOP-LEVEL-CRASH-SCREEN-LANGUAGE-AND-RELOAD-20260920. The top-level
// error boundary in main.jsx renders outside LanguageProvider, so it reads the
// saved language (sg-lang, then the device) itself, and it offers the reload
// its copy asks for instead of leaving the member to find the browser control.
// main.jsx keeps the alert landmark around this content.
export function CrashScreenContent({ win = typeof window === "undefined" ? null : window }) {
  const lang = preferredLanguage(win);
  return (
    <>
      <h1 lang={lang}>{t(lang, "app.crashTitle")}</h1>
      <p lang={lang}>{t(lang, "app.crashBody")}</p>
      <button className="dialog-primary" type="button" lang={lang} onClick={() => win?.location?.reload()}>
        {t(lang, "app.crashReload")}
      </button>
    </>
  );
}
