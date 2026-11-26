// Small pieces the alternate shell's Help, Know your rights, Account and
// Alerts pages share (REQ-UG-ALT-PORT-MEMBER-PAGES-20261030): the
// prototype's breadcrumb trail (components.js C.crumbs) and its switch row
// (pages/alerts.js `.opt[role=switch]`). Both are presentational; every
// action is the owning view's own handler.
import { Fragment } from "react";
import { BusyButton } from "../../components/BusyControls.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";
import { Icon } from "../icons.jsx";

const plainClick = (event) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

// "Now" first (onOpenHome, or plain text when the shell gives no way home),
// then the trail; the last entry is the current page. A middle entry with
// onOpen is a real link to `href` that the view opens in place.
export function HelpCrumbs({ onOpenHome = null, trail = [] }) {
  const { t } = useLang();
  return (
    <nav className="ug-crumbs" aria-label={t("altShell.crumbs")}>
      {onOpenHome ? <a href="/m" onClick={(event) => { if (!plainClick(event)) return; event.preventDefault(); onOpenHome(); }}>{t("altShell.now")}</a> : <span>{t("altShell.now")}</span>}
      {trail.map((item, index) => (
        <Fragment key={item.label}>
          <Icon name="right" />
          {index === trail.length - 1
            ? <span aria-current="page">{item.label}</span>
            : item.onOpen
              ? <a href={item.href} onClick={(event) => { if (!plainClick(event)) return; event.preventDefault(); item.onOpen(); }}>{item.label}</a>
              : <span>{item.label}</span>}
        </Fragment>
      ))}
    </nav>
  );
}

// The prototype's switch row: the whole row is the switch, its label the
// bold line and its description the muted one.
export function HelpSwitchRow({ id, label, sub = null, checked, disabled = false, pending = false, busy = false, onToggle }) {
  return (
    <BusyButton
      type="button"
      className="ug-opt"
      role="switch"
      aria-checked={Boolean(checked)}
      aria-labelledby={`${id}-label`}
      aria-describedby={sub ? `${id}-sub` : undefined}
      aria-busy={busy || undefined}
      disabled={disabled}
      pending={pending || busy}
      onClick={onToggle}
    >
      <span className="ug-alt-help-grow"><b id={`${id}-label`}>{label}</b>{sub ? <span id={`${id}-sub`}>{sub}</span> : null}</span>
      <span className="ug-switch" aria-hidden="true" />
    </BusyButton>
  );
}
