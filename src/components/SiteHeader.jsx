import { useId, useRef, useState } from "react";
import { SiteIcon } from "./SiteIcon.jsx";
import { BrandMark } from "./BrandMark.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { landingChrome } from "../lib/i18n/landingChromeCopy.js";
import { useSiteLanguageSwitch } from "../lib/siteLanguageSwitch.js";
import "./siteChrome.css";

// The one header of the signed-out site:
// the same brand, links and Sign in on Home, the information pages and the
// request page, on the site's one page edge. The
// sign-in page takes it without the Sign in button. The stylesheet paints it
// pine or paper by the look on the document (src/lib/siteLook.js).
const SITE_LINKS = [
  ["/about", "landing.about"],
  ["/contact", "landing.contact"],
];

// The header language toggle: its two halves in order, and for each
// language on screen the one a tap switches to, with the catalogue key of that
// language's own name.
const LANGUAGE_TOGGLE = ["en", "es"];
const LANGUAGE_SWITCH = {
  en: { to: "es", nameKey: "auth.langSpanish" },
  es: { to: "en", nameKey: "auth.langEnglish" },
};

// The mark is drawn twice and the stylesheet shows one: on its tile for the
// paper header, and with no tile (gold arrow, white bar) on pine, where a pine
// tile only shrinks the arrow. Both drawings are BrandMark.jsx's.
export function SiteMark({ size = 36 }) {
  return (
    <>
      <BrandMark size={size} className="site-mark site-mark--tile" />
      <BrandMark size={size} className="site-mark site-mark--on-dark" />
    </>
  );
}

export function SiteHeader({ current, lang, onLanguageChange, onSignIn, signInHref = "/auth", signIn = true, pageLinks = [] }) {
  const context = useLang();
  const { t } = context;
  // A page that passes no handler takes the switch of the signed-out page
  // shell around it (StandaloneLanguageShell), so every public page has the
  // same toggle in the same place ( C-1). The toggle marks the language
  // on screen, not only a language a page passed in.
  const siteSwitch = useSiteLanguageSwitch();
  const changeLanguage = onLanguageChange ?? siteSwitch?.change;
  const pageLang = lang ?? context.lang ?? "en";
  const chrome = landingChrome(pageLang);
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);
  const navId = useId();
  const shownLang = LANGUAGE_SWITCH[pageLang] ? pageLang : "en";
  const languageSwitch = LANGUAGE_SWITCH[shownLang];

  return (
    <header className="site-head" onKeyDown={(event) => {
      if (event.key === "Escape" && open) { setOpen(false); menuRef.current?.focus(); }
    }}>
      <div className="site-wrap site-head__row">
        <a className="site-head__brand" href="/" aria-label={t("landing.homeLabel")}>
          <SiteMark />
          <span className="site-head__name">{t("landing.wordmark")}</span>
        </a>
        {/* On a phone the links and the language toggle open under the header
            from the menu button; choosing a link closes them again. The button
            comes before them in the page, so Tab goes from it into the links. */}
        <button className="site-head__menu" type="button" ref={menuRef} aria-label={chrome.menu} aria-expanded={open} aria-controls={navId} onClick={() => setOpen((shown) => !shown)}>
          <SiteIcon name="menu" />
        </button>
        <nav className={open ? "site-head__nav is-open" : "site-head__nav"} id={navId} aria-label={chrome.siteNav}
          onClick={(event) => { if (event.target.closest?.("a")) setOpen(false); }}>
          {SITE_LINKS.map(([href, labelKey]) => (
            <a href={href} key={href} aria-current={current === href ? "page" : undefined}>{t(labelKey)}</a>
          ))}
          {pageLinks.map(({ href, label }) => <a className="site-head__jump" href={href} key={href}>{label}</a>)}
          {changeLanguage && (
            // One small toggle, not two pills . The filled half of the
            // track is the language on screen. The button's name starts with
            // the visible "EN ES" so voice control can say what it sees
            //, then names the language it switches to, in
            // that language.
            <button className="land-lang" type="button" title={t(languageSwitch.nameKey)} onClick={() => changeLanguage(languageSwitch.to)}>
              <span className="land-lang-track">
                {LANGUAGE_TOGGLE.map((code) => (
                  <span key={code} className="land-lang-option" data-current={code === shownLang ? "true" : undefined}>
                    {code.toUpperCase()}
                  </span>
                ))}
              </span>
              <span className="sr-only" lang={languageSwitch.to}> {t(languageSwitch.nameKey)}</span>
            </button>
          )}
        </nav>
        {signIn && (
          <div className="site-head__tools">
            {onSignIn
              ? <button className="site-head__signin" type="button" onClick={onSignIn}>{t("landing.signIn")}</button>
              : <a className="site-head__signin" href={signInHref}>{t("landing.signIn")}</a>}
          </div>
        )}
      </div>
    </header>
  );
}
