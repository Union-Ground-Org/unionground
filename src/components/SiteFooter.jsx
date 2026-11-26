import { SiteMark } from "./SiteHeader.jsx";
import { OperatorLink, SourceAttribution } from "./ServiceIdentity.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { landingChrome } from "../lib/i18n/landingChromeCopy.js";
import "./siteChrome.css";

// The one footer of the signed-out site. FOOTER_LINKS is the one list of
// footer pages; each group names hrefs from it. The request and sign-in pages
// take the short form: the brand and four links, with no columns. Union
// Ground's footer names the operator of this deployment and links its source
// (AGPL-3.0); it carries no store badges, company mailboxes or social
// accounts, because no operator has published any.
const FOOTER_LINKS = [
  { href: "/about", labelKey: "landing.about" },
  { href: "/contact", labelKey: "landing.contact" },
  { href: "/privacy", labelKey: "landing.privacy" },
  { href: "/terms", labelKey: "landing.terms" },
  { href: "/accessibility", labelKey: "landing.accessibility" },
  { href: "/ai-disclosure", labelKey: "landing.aiDisclosure" },
  { href: "/retention", labelKey: "landing.retention" },
  { href: "/verify", labelKey: "landing.verify" },
  { href: "/unions", labelKey: "unions.footerLink" },
];
const FOOTER_GROUPS = [
  { id: "company", labelKey: "footerCompany", hrefs: ["/about", "/contact"] },
  { id: "product", labelKey: "footerProduct", hrefs: ["/unions", "/verify"] },
  { id: "legal", labelKey: "footerLegal", hrefs: ["/privacy", "/terms", "/accessibility", "/ai-disclosure", "/retention"] },
];
const SHORT_LINKS = ["/privacy", "/terms", "/accessibility", "/contact"];
const footerLink = (href) => FOOTER_LINKS.find((link) => link.href === href);

// `legalLink` is one more entry at the end of the Privacy and legal group
// (Home's Stop public updates); `children` sit under the columns (the form
// that link opens). `independence` adds the independent-company sentence to
// the closing line, on pages whose own text does not already say it. The
// landing page passes its own language (it renders outside the member
// language state); the other pages read the provider's.
export function SiteFooter({ short = false, badges = false, lang, independence = false, legalLink = null, children = null }) {
  const context = useLang();
  const { t } = context;
  const chrome = landingChrome(lang ?? context.lang ?? "en");

  return (
    <footer className={short ? (badges ? "site-foot site-foot--short site-foot--badges" : "site-foot site-foot--short") : "site-foot"}>
      <div className="site-wrap">
        <div className="site-foot__grid">
          <div className="site-foot__brand">
            {/* The header's brand is the one link home; this one is a label. */}
            <p className="site-foot__home">
              <SiteMark />
              <span className="site-foot__name">{t("landing.wordmark")}</span>
            </p>
            {!short && <p className="site-foot__about">{t("landing.companyBody")}</p>}
          </div>
          {short ? (
            <nav className="site-foot__short" aria-label={t("landing.footerNavLabel")}>
              {SHORT_LINKS.map(footerLink).map((link) => <a href={link.href} key={link.href}>{t(link.labelKey)}</a>)}
            </nav>
          ) : (
            <nav className="site-foot__links" aria-label={t("landing.footerNavLabel")}>
              {FOOTER_GROUPS.map((group) => (
                <div className={`site-foot__group site-foot__group--${group.id}`} role="group" aria-labelledby={`site-foot-${group.id}`} key={group.id}>
                  <p className="site-foot__heading" id={`site-foot-${group.id}`}>{chrome[group.labelKey]}</p>
                  {group.hrefs.map(footerLink).map((link) => <a href={link.href} key={link.href}>{t(link.labelKey)}</a>)}
                  {group.id === "legal" && legalLink}
                </div>
              ))}
              <div className="site-foot__group site-foot__group--contact" role="group" aria-labelledby="site-foot-contact">
                <p className="site-foot__heading" id="site-foot-contact">{chrome.footerContact}</p>
                <OperatorLink />
                <SourceAttribution />
              </div>
            </nav>
          )}
        </div>
        {children}
        <div className="site-foot__legal">
          {independence && <p>{t("landing.companyIndependence")}</p>}
          <p>{t("landing.footerLine")}</p>
        </div>
      </div>
    </footer>
  );
}
