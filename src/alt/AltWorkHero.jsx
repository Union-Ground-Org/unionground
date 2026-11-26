// The Work page's hero (REQ-UG-ALT-PORT-WORK-20261030), ported from
// the prototype's pages/ws-data.js W.hero and pages/ws-work.js: crumbs, the
// title and lede and the Private mark. The prototype's Work-only dark mode
// switch is gone: the site renders light only
// (REQ-UG-DISABLE-DARK-MODE-WEB-AND-MOBILE-20261105). The views, board,
// list, timeline, calendar, deadlines, tasks and field notes under it are the
// production Tasks tool.
import { useLang } from "../lib/LanguageContext.jsx";
import { Icon } from "./icons.jsx";

const plainClick = (event) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

export default function AltWorkHero({ onOpenHome = null }) {
  const { t } = useLang();
  return (
    <section className="ug-page-hero ug-ws-hero ug-work-hero">
      <div className="ug-wrap">
        <nav className="ug-crumbs" aria-label={t("altShell.crumbs")}>
          {onOpenHome ? <a href="/m" onClick={(event) => { if (!plainClick(event)) return; event.preventDefault(); onOpenHome(); }}>{t("altShell.now")}</a> : <span>{t("altShell.now")}</span>}
          <Icon name="right" /><span aria-current="page">{t("altShell.work")}</span>
        </nav>
        <div className="ug-ws-top">
          <div>
            <h1>{t("altShell.work")}</h1>
            <p className="ug-ws-lede">{t("altShell.workLede")}</p>
          </div>
          <div className="ug-ws-tools">
            <span className="ug-ws-private"><Icon name="lock" />{t("altShell.privateTag")}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
