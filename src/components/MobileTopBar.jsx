import { Bell, Menu } from "lucide-react";
import { useLang } from "../lib/LanguageContext.jsx";
import { useOrganizationName } from "../lib/organizationName.js";
import { useHideOnScroll } from "../lib/useHideOnScroll.js";
import { BrandMark } from "./BrandMark.jsx";

// The product mark at top-bar size. It delegates to the single
// BrandMark SVG so the chrome and the pre-auth surfaces cannot drift;
// exported so the desktop rail reuses the exact same mark.
export function BrandLogoMark({ size = 28 }) {
  return <BrandMark size={size} />;
}

// Pixel-parity rebuild of the prototype's mobile top bar (.mtop): logo mark,
// uppercase role line, optional hat pill, bell with live dot, avatar circle.
// The prototype's fake iPhone status row (9:41 · ▂▄▆ 🛜 🔋) is device chrome
// simulation and is deliberately NOT reproduced — real phones bring their own.
//
// Purely presentational: every interactive affordance appears only when its
// callback (or data) is passed, so partial wiring renders honest chrome
// instead of dead buttons.
export function MobileTopBar({
  onHome = null, // logo tap goes home; without it the mark stays decorative
  onFeatures = null, // one activation opens the Home All features drawer
  roleLabel = null, // e.g. "Member" / "Steward"; defaults to the member label
  hatLabel = null, // visible label on the hat pill (falls back to roleLabel)
  officeLabel = null, // the person's highest office, named beside the member hat
  onHatToggle = null, // member ⇄ steward view switch; pill renders only when set
  hatOptions = null, // [{ key, label }] — every hat this account may wear
  activeHat = "member",
  onHatChange = null, // full hat selection; takes precedence over the pill
  onNotifications = null, // bell tap; bell renders only when set
  notifDot = false, // unread indicator on the bell
  notifCount = null, // unread count for the bell's accessible name (dot is visual-only)
  initials = null, // avatar initials; avatar renders only when set
  onProfile = null, // avatar tap; without it the avatar is decorative
  hatOnly = false, // member chrome (owner feedback, 2026-08-05): the hat switcher as a standalone pill, nothing else
}) {
  const { t } = useLang();
  const organizationName = useOrganizationName();
  // Scroll-down tucks the bar behind the top edge, scroll-up restores it —
  // the shared hook keeps this bar and the tab bar moving on the same signal.
  const hidden = useHideOnScroll();
  const role = roleLabel ?? t("topbar.member");
  const orgLineText = t("shell.orgLineRole", { organization: organizationName, role: roleLabel == null && officeLabel ? `${role} · ${officeLabel}` : role });
  const hatSelect = Array.isArray(hatOptions) && hatOptions.length > 1 && onHatChange ? (
    <label className="mobile-top__hat-select">
      <select aria-label={t("demo.hatsLabel")} value={activeHat} onChange={(event) => onHatChange(event.target.value)}>
        {hatOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
      </select>
    </label>
  ) : null;
  // Hat-only chrome: the standalone pill is the WHOLE header. An account with
  // a single hat has nothing to switch into, so it gets no header at all —
  // an empty floating strip would just push the feed down.
  if (hatOnly) {
    if (!hatSelect) return null;
    return (
      <header className={`mobile-top mobile-top--hat-only${hidden ? " mobile-top--tucked" : ""}`}>
        {hatSelect}
      </header>
    );
  }
  return (
    <header className={`mobile-top${onFeatures ? " mobile-top--with-menu" : ""}${hidden ? " mobile-top--tucked" : ""}`}>
      {onHome
        ? <button type="button" className="brand-home home-orb home-orb--inline" aria-label={t("nav.home")} onClick={onHome}><BrandLogoMark size={28} /></button>
        : <BrandLogoMark size={28} />}
      {onFeatures && (
        <button type="button" className="mobile-top__menu" onClick={onFeatures}>
          <Menu size={18} aria-hidden="true" />
          <span>{t("cardnav.features")}</span>
        </button>
      )}
      {/* The organization's union logo, when its catalog placement gives one,
          leads the org line as the organization's own mark. */}
      <div className="mobile-top__role">{orgLineText}</div>
      {/* Phones get the same complete hat selection the desktop rail offers:
          a native select renders as the OS picker sheet, so all six demo hats
          (or every role the account holds) stay reachable without the 1024px
          rail. Accounts with nothing to switch into render no control. */}
      {hatSelect ?? (onHatToggle && (
        <button type="button" className="mobile-top__hat" title={t("topbar.switchHat")} onClick={onHatToggle}>
          {hatLabel ?? role}
        </button>
      ))}
      {onNotifications && (
        <button
          type="button"
          className="mobile-top__bell"
          // The dot is aria-hidden, so the count has to live in the accessible
          // name — the per-view bells this bar replaced announced it too.
          aria-label={typeof notifCount === "number" ? t("header.notifications", { count: notifCount }) : t("topbar.notifications")}
          onClick={onNotifications}
        >
          {/* The line icon the desktop rail bell uses, not the emoji bell. */}
          <Bell size={20} aria-hidden="true" />
          {notifDot && <span className="mobile-top__dot" aria-hidden="true" />}
        </button>
      )}
      {initials && (onProfile ? (
        // The name starts with the visible initials so voice control can say
        // what it sees (#7550, WCAG 2.5.3 Label in Name).
        <button type="button" className="mobile-top__avatar" aria-label={`${initials} ${t("topbar.profile")}`} onClick={onProfile}>
          {initials}
        </button>
      ) : (
        <span className="mobile-top__avatar" aria-hidden="true">{initials}</span>
      ))}
    </header>
  );
}
