// The phone card-navigation contract (owner direction, 2026-08-05; revised
// 2026-08-07): three swipeable cards — All Features / Home / Work. The
// shortcut bubble is retired (owner spec, 2026-08-07): a persistent Home
// orb replaces its way-back-home job, and the Work card carries live
// widget panels instead of pinned links. This table is the single source
// for what those surfaces list, the same way staffNavigation.js is for the
// staff desks: every entry is a real backed destination that already
// exists in pathViews, or the Compass overlay. Nothing here invents a
// route.

import { RAIL_EXTRA_ITEMS } from "../components/BottomNav.jsx";
import { noStewardNamed } from "./stewardConversations.js";
export { WORK_WIDGET_KEYS } from "./navigationPreferences.js";

const rewards = RAIL_EXTRA_ITEMS.find((item) => item.key === "rewards");
const appointments = RAIL_EXTRA_ITEMS.find((item) => item.key === "appointments");
const forms = RAIL_EXTRA_ITEMS.find((item) => item.key === "forms");
const workload = RAIL_EXTRA_ITEMS.find((item) => item.key === "workload");

// Compass is an overlay, never a route (the standing rule from the tab bar
// it replaces): consumers must branch on `action` and open the Assistant.
export const COMPASS_ITEM = { key: "compass", labelKey: "nav.compass", icon: "🧭", action: "assistant" };

// REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030 (findings 85, 99):
// the menu entries members could not tell apart get a one-line explanation
// wherever the menu lists them (the desktop rail and the All features card).
export const NAV_HINT_KEYS = Object.freeze({
  compass: "nav.hint.compass",
  voice: "nav.hint.voice",
  "member-support": "nav.hint.memberSupport",
});

// #9595: the Be heard hint promises a steward one tap away; with no steward
// named for the reader (stewardPresence) it says only what the page is for.
export function navHintKey(key, stewardPresence = null) {
  if (key === "voice" && noStewardNamed(stewardPresence)) return "nav.hint.voiceNoSteward";
  return NAV_HINT_KEYS[key] ?? null;
}

// The real-account Site Guide ("How to use this site"), shared with the rail.
export const SITE_GUIDE_ITEM = { key: "site-guide", viewKey: "siteGuide", labelKey: "nav.siteGuide", path: "/m/guide", icon: "?" };

// The All Features card: the complete member directory, grouped the way the
// desktop rail groups it (Me / Union / Account) so both shells tell the same
// story about what exists. Home is deliberately absent — the card lives ON
// the home screen, one swipe from the feed it would link to.
export const FEATURE_GROUPS = [
  {
    key: "me",
    labelKey: "shell.groupMe",
    items: [
      { key: "voting", labelKey: "nav.voting", path: "/m/voting", icon: "🗳" },
      rewards,
      { key: "cases", labelKey: "nav.myCases", path: "/m/cases", icon: "🗂" },
      forms,
      workload,
      { key: "numbers", labelKey: "nav.myReports", path: "/m/numbers", icon: "📈" },
      { key: "pulse", labelKey: "nav.pulse", path: "/m/pulse", icon: "📊" },
      { key: "messages", labelKey: "nav.messages", path: "/m/messages", icon: "✉" },
      appointments,
      COMPASS_ITEM,
    ],
  },
  {
    key: "union",
    labelKey: "shell.groupUnion",
    items: [
      { key: "rights", labelKey: "nav.knowRights", path: "/m/rights", icon: "⚖" },
      { key: "member-support", viewKey: "memberSupport", labelKey: "nav.memberSupport", path: "/m/support", icon: "🤝" },
      { key: "org-structure", viewKey: "orgStructure", labelKey: "nav.orgStructure", path: "/m/org-structure", icon: "◍" },
      { key: "hub", labelKey: "nav.myChapter", path: "/m/organize/organize", icon: "⌂" },
      { key: "network", viewKey: "coordination", labelKey: "nav.network", path: "/m/network", icon: "◎" },
      { key: "voice", labelKey: "morehub.beHeard", path: "/m/voice", icon: "📣" },
      { key: "qa", labelKey: "nav.qa", path: "/m/qa", icon: "❓" },
      { key: "pay", labelKey: "nav.pay", path: "/m/pay", icon: "💲" },
      { key: "events", labelKey: "morehub.events", path: "/m/events", icon: "📅" },
      { key: "actions", labelKey: "nav.collectiveActions", path: "/m/actions", icon: "✊" },
      { key: "search", labelKey: "nav.search", path: "/m/search", icon: "🔍" },
    ],
  },
  {
    key: "account",
    labelKey: "shell.groupAccount",
    items: [
      // UX-UG-WEB-NAVIGATION-TOO-MANY-DESTINATIONS-20261018: the site
      // guide ("How to use this site") leads Account, where a new member looks
      // for help. REQ-UG-SITE-GUIDE-FOR-REAL-ACCOUNTS-20261001: hidden
      // when the organization turns features.guidance_onboarding.site_guide off.
      SITE_GUIDE_ITEM,
      // Notifications and profile are dialogs, not routes (action rows like
      // Compass): the stripped-down chrome (owner feedback, 2026-08-05 — hat
      // pill only) carries no bell or avatar, so the drawer is where these
      // live on phones now.
      { key: "notifications", labelKey: "topbar.notifications", icon: "🔔", action: "notifications" },
      { key: "profile", labelKey: "topbar.profile", icon: "👤", action: "profile" },
      { key: "accessHistory", labelKey: "nav.accessHistory", path: "/m/access-history", icon: "👁" },
      { key: "settings", labelKey: "nav.settings", path: "/m/settings", icon: "⚙" },
    ],
  },
];

// The Work card for an account with no staff role: the member's own work
// surfaces. Staff hats swap this list for STAFF_ROLE_NAVIGATION[hat], which
// stays the one backed contract for role desks.
export const MEMBER_WORK_ITEMS = [
  { key: "cases", labelKey: "nav.myCases", path: "/m/cases", icon: "🗂" },
  { key: "messages", labelKey: "nav.messages", path: "/m/messages", icon: "✉" },
  { key: "network", viewKey: "coordination", labelKey: "nav.network", path: "/m/network", icon: "◎" },
  forms,
  workload,
  appointments,
  { key: "actions", labelKey: "nav.collectiveActions", path: "/m/actions", icon: "✊" },
  { key: "member-support", viewKey: "memberSupport", labelKey: "nav.memberSupport", path: "/m/support", icon: "🤝" },
];


// The Work card's widget panels for the member (no staff hat) mode. Every
// key is both the widget identity and the destination its header opens —
// the same backed routes MEMBER_WORK_ITEMS pointed at, plus the reports
// desk. Order is the default layout; the member's own drag order persists
// per device below.
