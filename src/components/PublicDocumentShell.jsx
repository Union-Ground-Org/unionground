import { useEffect, useSyncExternalStore } from "react";
import { IdentityThemeScope } from "./IdentityThemeScope.jsx";
import { SiteFooter } from "./SiteFooter.jsx";
import { SiteHeader } from "./SiteHeader.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { scrollToFragment } from "../lib/scrollToFragment.js";
import "./publicDocumentShell.css";

const DOCUMENT_LINKS = [
  ["/about", "landing.about"],
  ["/contact", "landing.contact"],
  ["/operator", "operator.link"],
  ["/privacy", "hub.privacy"],
  ["/terms", "hub.terms"],
  ["/accessibility", "hub.accessibility"],
  ["/ai-disclosure", "hub.aiDisclosure"],
  ["/retention", "hub.retention"],
];

// One published contact line: the address when Union Ground publishes one
// (src/lib/publicContact.js), and the plain "none published yet" sentence
// otherwise. No page invents a mailbox while none exists.
export function PublicContactLine({ body, contact }) {
  const { t } = useLang();
  const lead = body ? `${body} ` : "";
  return contact
    ? <p>{lead}<a href={contact.href}>{contact.email}</a></p>
    : <p>{lead}{t("legal.contact.none")}</p>;
}

// REQ-UG-LOVABLE-PUBLIC-SITE-BATCH-B-PORT-20261103 (WEB-PUB-04, -15,
// -24): on a phone the long contents list sat above the text as a crowded
// two-column block. At the width where the layout stacks (styles.css, 760px)
// it becomes one closed "On this page · N sections" control listing every
// section in one column; it closes again when a section is chosen. jsdom and
// wide screens keep the open side index.
const PHONE_CONTENTS = "(max-width: 760px)";

function subscribePhoneContents(onChange) {
  const query = globalThis.matchMedia?.(PHONE_CONTENTS);
  query?.addEventListener?.("change", onChange);
  return () => query?.removeEventListener?.("change", onChange);
}

const phoneContents = () => globalThis.matchMedia?.(PHONE_CONTENTS).matches === true;

export function PublicDocumentShell({ className, eyebrow, title, intro, notice, sections, indexSections = sections, children }) {
  const { t } = useLang();
  const phone = useSyncExternalStore(subscribePhoneContents, phoneContents, () => false);
  // A link to a section (Home's walkthrough link to /press#video, a shared
  // /about#about-team) arrives before this lazily loaded page has drawn the
  // section, so the browser's own jump finds nothing. Jump once it is drawn.
  useEffect(() => {
    scrollToFragment(window.location.hash, document);
  }, []);
  const index = <nav aria-label={t("legal.contents")}>
    {indexSections.map((section) => <a href={`#${section.id}`} key={section.id}>{section.heading}</a>)}
  </nav>;

  return (
    <IdentityThemeScope>
      {/* The site's shared header and footer (
          2026); the header marks this page's own link. */}
      <div className={className ? `public-document-shell site-page ${className}` : "public-document-shell site-page"}>
        <SiteHeader current={window.location.pathname} />
        <div className="public-document-layout">
          {/* The index name belongs to the nav alone. Naming the aside too put
              the same name on two nested landmarks back to back. */}
          {phone ? (
            <details className="public-document-index public-document-contents"
              onClick={(event) => { if (event.target.closest?.("a")) event.currentTarget.open = false; }}>
              <summary>{t(indexSections.length === 1 ? "publicDocument.contentsCountOne" : "publicDocument.contentsCount", { count: indexSections.length })}</summary>
              {index}
            </details>
          ) : (
            <aside className="public-document-index">
              <strong>{t("legal.contents")}</strong>
              {index}
            </aside>
          )}
          <main className="legal-page">
            <p className="eyebrow">{eyebrow}</p>
            <h1>{title}</h1>
            <p className="legal-page__intro">{intro}</p>
            {notice && <p className="legal-page__notice">{notice}</p>}
            {children}
            <nav className="legal-page__links" aria-label={t("legal.navigation")}>
              {DOCUMENT_LINKS.map(([href, labelKey]) => <a href={href} key={href}>{t(labelKey)}</a>)}
            </nav>
          </main>
        </div>
        <SiteFooter />
      </div>
    </IdentityThemeScope>
  );
}
