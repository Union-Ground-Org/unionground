// The prototype's page hero (`.page-hero`: crumbs, the h1 with its accent
// span, the lede) for the alternate shell's Votes, Statistics and Campaign
// pages (REQ-UG-ALT-PORT-MEMBER-PAGES-20261030). App draws the
// dotted grid behind the page, so the hero carries no dots of its own. This
// is the page's only h1.
import { useLang } from "../../lib/LanguageContext.jsx";
import { Icon } from "../icons.jsx";

const plainClick = (event) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

export function TakePartHero({ crumb, lead, accent, tail = "", lede, onOpenHome = null, children = null }) {
  const { t } = useLang();
  return (
    <section className="ug-page-hero ug-ta-hero">
      <div className="ug-wrap">
        <nav className="ug-crumbs" aria-label={t("altShell.crumbs")}>
          {onOpenHome
            ? <a href="/m" onClick={(event) => { if (!plainClick(event)) return; event.preventDefault(); onOpenHome(); }}>{t("altShell.now")}</a>
            : <span>{t("altShell.now")}</span>}
          <Icon name="right" /><span aria-current="page">{crumb}</span>
        </nav>
        <h1>{lead}<span className="ug-accent">{accent}</span>{tail}</h1>
        <p className="ug-lede">{lede}</p>
        {children}
      </div>
    </section>
  );
}
