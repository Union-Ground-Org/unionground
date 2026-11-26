import { useEffect, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { useHideOnScroll } from "../lib/useHideOnScroll.js";
import { currentStaffSection, staffItemHref, STAFF_ROLE_NAVIGATION, visibleStaffNavigation } from "../lib/staffNavigation.js";

// Pixel-parity rebuild (wave 2a, 2026-07-28) of the Union Base prototype's
// mobile tab bar (.mtabbar, _tabDefs). Icons are the prototype's EMOJI glyphs,
// not lucide — that is the visual the design ships. Labels go through t() so
// EN/ES match the prototype's per-tab strings (Inicio/Informes/Voz/…).
//
// Two per-persona tab sets, mirroring the prototype exactly:
//   worker:  Home · Work · Issues · Meetings · Compass · More (Union Ground)
//   steward: Home · Cases · Inbox · Reports · Compass · More
// Compass is an overlay (onAsk), never a route; More is the settings hub.
//
// Tasks is deliberately NOT here: work
// coordination is a staff tool, entered from the coordinator/steward planes
// (and, for stewards, the rail's staff group). The route gate in App.jsx is
// the other half of that decision.

// Worker leading tabs (before Compass + More). Union Ground's organizing
// set: Home, the worker Work list, issues and meetings — never grievances or a
// contract that does not exist yet. Rights stays one tap away in More and the
// rail.
export const NAV_ITEMS = [
  { key: "today", labelKey: "nav.home", path: "/m", icon: "🏠" },
  { key: "work", labelKey: "nav.work", path: "/m/work", icon: "☑" },
  { key: "cases", labelKey: "nav.issues", path: "/m/cases", icon: "⚑" },
  { key: "events", labelKey: "nav.meetings", path: "/m/events", icon: "📅" },
];

// Steward leading tabs — the prototype swaps Voice/Learn for Cases/Inbox.
const STEWARD_TAB_ITEMS = [
  { key: "today", labelKey: "nav.home", path: "/m", icon: "🏠" },
  { key: "cases", labelKey: "nav.issues", path: "/m/cases", icon: "📁" },
  { key: "messages", labelKey: "nav.inbox", path: "/m/messages", icon: "💬" },
  { key: "numbers", labelKey: "nav.reports", path: "/m/numbers", icon: "📈" },
];

// The trailing More tab, shared by both personas.
const MORE_ITEM = { key: "settings", labelKey: "nav.more", path: "/m/settings", icon: "☰" };

// Rail-only destinations (consumed by DesktopRail): real screens the six-tab
// phone nav has no room for, present in the prototype's desktop sidebar.
export const RAIL_EXTRA_ITEMS = [
  { key: "rewards", labelKey: "nav.contributions", path: "/m/rewards", icon: "★" },
  { key: "appointments", labelKey: "nav.appointments", path: "/m/appointments", icon: "📅" },
  { key: "forms", labelKey: "nav.forms", path: "/m/forms", icon: "🖊" },
  { key: "workload", labelKey: "nav.workload", path: "/m/workload", icon: "⏲" },
  { key: "actions", labelKey: "nav.collectiveActions", path: "/m/actions", icon: "✊" },
];

// The rail's backed staff destinations. These are work surfaces, not hats:
// role/persona switching lives in DesktopRail's dedicated footer switcher.
// Keep the individual export for the task-gating contract and callers that
// only need the shared tool.
export const STAFF_WORK_RAIL_ITEM = { key: "tasks", labelKey: "staff.chapterWork", path: "/m/tasks", icon: "☑" };
export const STEWARD_RAIL_ITEM = { key: "steward", labelKey: "nav.committee", path: "/m/steward", icon: "📁" };

// All five role sets come from the backed navigation contract. Prototype-only
// fiction stays absent, while every implemented route/section is shared with
// the desktop green rail. The staff bar scrolls horizontally when the complete
// work map is wider than a phone; it never deletes tools to hit a tab count.
export const STAFF_PLANE_TABS = STAFF_ROLE_NAVIGATION;

function TabLink({ item, active, activeSection, onNavigate, onSection, t, home = false }) {
  const { key, viewKey = key, labelKey, path, icon, sectionId } = item;
  const on = sectionId ? active === viewKey && activeSection === sectionId : active === key && !activeSection;
  return (
    <a
      href={staffItemHref(item)}
      className={[home ? "bottom-nav__home" : "", on ? "active" : ""].filter(Boolean).join(" ")}
      aria-current={on ? "page" : undefined}
      aria-label={t(labelKey)}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onSection(sectionId || "");
        onNavigate(viewKey, path, sectionId);
      }}
    >
      <span className="bottom-nav__icon" aria-hidden="true">{icon}</span>
      <span className="bottom-nav__label">{t(labelKey)}</span>
    </a>
  );
}

// `tabs` overrides the leading set with a staff plane's complete work map.
// Compass stays in the desktop/shared shell rather than becoming a fake route.
export function BottomNav({ active, onNavigate, onAsk, steward = false, tabs = null, demoNavigation = false }) {
  const { t } = useLang();
  const [, setActiveSection] = useState(currentStaffSection);
  const activeSection = currentStaffSection();
  useEffect(() => setActiveSection(currentStaffSection()), [active, tabs]);
  const leading = tabs ? visibleStaffNavigation(tabs, demoNavigation) : (steward ? STEWARD_TAB_ITEMS : NAV_ITEMS);
  // Scrolling down no longer tucks the bar away (owner feedback, 2026-08-25):
  // it CONDENSES to just the Home tab — the first leading item, which is Home
  // for members/stewards and the plane dashboard for a staff hat — so the way
  // back is always one tap. Scrolling up (or keyboard focus landing anywhere
  // in the bar) restores the full tab set.
  const hidden = useHideOnScroll();
  return (
    <nav className={`bottom-nav${tabs ? " bottom-nav--staff" : ""}${hidden ? " bottom-nav--condensed" : ""}`} aria-label={t("nav.primary")}>
      <div className="bottom-nav__inner">
        {leading.map((item, index) => (
          <TabLink key={item.key} item={item} home={index === 0} active={active} activeSection={activeSection} onNavigate={onNavigate} onSection={setActiveSection} t={t} />
        ))}
        {/* Compass is an overlay, not a route: this entry opens the existing
            Assistant dialog rather than navigating, so it renders as a button
            (no aria-current, never "active") to keep the semantics honest. */}
        {!tabs && (
          <button type="button" aria-haspopup="dialog" aria-label={t("nav.compass")} onClick={onAsk}>
            <span className="bottom-nav__icon" aria-hidden="true">🧭</span>
            <span className="bottom-nav__label">{t("nav.compass")}</span>
          </button>
        )}
        <TabLink item={MORE_ITEM} active={active} activeSection={activeSection} onNavigate={onNavigate} onSection={setActiveSection} t={t} />
      </div>
    </nav>
  );
}
