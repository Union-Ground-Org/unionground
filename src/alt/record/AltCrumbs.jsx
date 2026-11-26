// The prototype's C.crumbs for the record pages the alternate shell draws in
// full (Chapters, Bargaining, Sources; REQ-UG-ALT-PORT-MEMBER-PAGES-20261030):
// "Now" back to the member's home, then the page's own name.
import { useLang } from "../../lib/LanguageContext.jsx";
import { Icon } from "../icons.jsx";

const plainClick = (event) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

export default function AltCrumbs({ title, onOpenHome = null }) {
  const { t } = useLang();
  return (
    <nav className="ug-crumbs" aria-label={t("altShell.crumbs")}>
      {onOpenHome
        ? <a href="/m" onClick={(event) => { if (!plainClick(event)) return; event.preventDefault(); onOpenHome(); }}>{t("altShell.now")}</a>
        : <span>{t("altShell.now")}</span>}
      <Icon name="right" /><span aria-current="page">{title}</span>
    </nav>
  );
}
