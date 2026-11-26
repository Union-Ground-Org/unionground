// The prototype's page hero for every member page the alternate shell mounts
// (REQ-UG-ALT-PORT-MEMBER-PAGES-20261030): crumbs back to Now, the
// page title and, for the prototype's own pages (Updates, Votes, Chapters,
// Bargaining, Calendar, Statistics, Help, Account, Alerts, Sources, Campaign),
// its lede. The production page under it keeps every feature and its own h1,
// which stays the page's one heading for assistive technology: the hero draws
// the title large for sight only (aria-hidden), and styles/pages.css keeps the
// production h1 for screen readers while the hero shows it.
import { useLang } from "../lib/LanguageContext.jsx";
import { Icon } from "./icons.jsx";

const plainClick = (event) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

// Production view → the prototype page it stands for (its lede key).
export const PAGE_LEDES = {
  events: "altShell.pageLede_calendar",
  voting: "altShell.pageLede_votes",
  numbers: "altShell.pageLede_stats",
  pay: "altShell.pageLede_bargaining",
  memberSupport: "altShell.pageLede_help",
  rights: "altShell.pageLede_rights",
  hub: "altShell.pageLede_chapters",
  settings: "altShell.pageLede_account",
  actions: "altShell.pageLede_campaign",
  clauses: "altShell.pageLede_sources",
};

export default function AltPageHero({ title, view, onOpenHome = null }) {
  const { t } = useLang();
  const ledeKey = PAGE_LEDES[view];
  if (!title) return null;
  return (
    <section className="ug-page-hero ug-alt-page-hero">
      <div className="ug-wrap">
        <nav className="ug-crumbs" aria-label={t("altShell.crumbs")}>
          {onOpenHome ? <a href="/m" onClick={(event) => { if (!plainClick(event)) return; event.preventDefault(); onOpenHome(); }}>{t("altShell.now")}</a> : <span>{t("altShell.now")}</span>}
          <Icon name="right" /><span aria-current="page">{title}</span>
        </nav>
        <p className="ug-alt-hero-title" aria-hidden="true">{title}</p>
        {ledeKey ? <p className="ug-lede">{t(ledeKey)}</p> : null}
      </div>
    </section>
  );
}
