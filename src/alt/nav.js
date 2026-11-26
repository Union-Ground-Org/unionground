// The alternate shell's navigation model: the design's side-nav groups (Now,
// The record, Take part, Help) filled with the production app's member
// destinations, plus the groups the design did not have to think about
// (Your union, Account, the staff workspace) so that nothing a member or a
// staff hat can reach in the classic shell is unreachable in this one.
//
// Every item names the production VIEW it mounts (`viewKey`, defaulting to
// `key`) and the path App.navigate() takes, exactly as DesktopRail.jsx and
// BottomNav.jsx do; tests/nav-view-key-parity.test.js explains why a key that
// is not a view name is the defect this discipline exists to refuse. Labels
// reuse the production nav.* keys so they are already bilingual.
import { RAIL_EXTRA_ITEMS } from "../components/BottomNav.jsx";
import { STAFF_TOOLS, staffToolAllowsHat } from "../lib/staffPlanes.js";
import { STAFF_ROLE_NAVIGATION, visibleStaffNavigation } from "../lib/staffNavigation.js";

const extra = (key) => RAIL_EXTRA_ITEMS.find((item) => item.key === key);

const ICON_BY_KEY = {
  qa: "info",
  today: "home", messages: "msg", updates: "rss", events: "calendar", numbers: "chart", pay: "coins",
  voting: "ballot", actions: "flag", voice: "megaphone", rewards: "trophy",
  "member-support": "hand", rights: "shield", cases: "briefcase", forms: "edit", appointments: "clock", workload: "zap",
  hub: "users", "org-structure": "table", network: "link", search: "search",
  settings: "edit", accessHistory: "lock", "site-guide": "info", tasks: "briefcase",
};

// The design's "Now" is the member home; the other three groups are the
// design's own headings, the rest are production groupings.
export function memberNavGroups(t, badges = {}, { siteGuide = true } = {}) {
  return [
    { key: "now", label: null, items: [
      { key: "today", label: t("altShell.now"), path: "/m" },
    ] },
    { key: "record", label: t("altShell.groupRecord"), items: [
      { key: "messages", labelKey: "nav.messages", path: "/m/messages", badge: badges.messages ?? null },
      { key: "updates", label: t("altShell.allUpdates"), path: "/m/updates" },
      { key: "events", label: t("altShell.events"), path: "/m/events" },
      { key: "numbers", labelKey: "nav.myReports", path: "/m/numbers" },
      { key: "pay", labelKey: "nav.pay", path: "/m/pay" },
    ] },
    { key: "takePart", label: t("altShell.groupTakePart"), items: [
      { key: "voting", labelKey: "nav.voting", path: "/m/voting", badge: badges.voting ?? null },
      extra("actions"),
      { key: "voice", labelKey: "morehub.beHeard", path: "/m/voice" },
      extra("rewards"),
    ] },
    { key: "help", label: t("altShell.groupHelp"), items: [
      { key: "member-support", viewKey: "memberSupport", labelKey: "nav.memberSupport", path: "/m/support" },
      { key: "rights", labelKey: "nav.knowRights", path: "/m/rights" },
      { key: "qa", labelKey: "nav.qa", path: "/m/qa" },
      { key: "cases", labelKey: "nav.myCases", path: "/m/cases", badge: badges.cases ?? null },
      { ...extra("forms"), badge: badges.forms ?? null },
      extra("appointments"),
      extra("workload"),
    ] },
    { key: "union", label: t("altShell.groupUnion"), items: [
      { key: "hub", viewKey: "organize", labelKey: "nav.myChapter", path: "/m/organize" },
      { key: "org-structure", viewKey: "orgStructure", labelKey: "nav.orgStructure", path: "/m/org-structure" },
      { key: "network", viewKey: "coordination", labelKey: "nav.network", path: "/m/network" },
      { key: "search", labelKey: "nav.search", path: "/m/search" },
    ] },
    { key: "account", label: t("altShell.groupAccount"), items: [
      { key: "settings", labelKey: "nav.settings", path: "/m/settings" },
      { key: "accessHistory", labelKey: "nav.accessHistory", path: "/m/access-history" },
      // The organization's Site Guide switch removes the destination here as it
      // does in the classic rail, card nav and search.
      siteGuide ? { key: "site-guide", viewKey: "siteGuide", labelKey: "nav.siteGuide", path: "/m/guide" } : null,
    ] },
  ].map((group) => ({ ...group, items: group.items.filter(Boolean).map(withIcon) }));
}

// RAIL_EXTRA_ITEMS carry the classic rail's emoji icons; the alt shell draws
// its own stroke icons, keyed by item.
function withIcon(item) {
  return { ...item, icon: ICON_BY_KEY[item.key] ?? "right" };
}

// The worn staff hat's own destinations: the plane's page map (what the
// classic rail shows as that hat's tabs) and the shared staff tools the hat
// may open. A member hat gets none; the gate is the same staffToolAllowsHat
// App.jsx uses before mounting a tool.
export function staffNavGroups(t, activeHat, { demoNavigation = false } = {}) {
  if (!activeHat || activeHat === "member") return [];
  const planeItems = visibleStaffNavigation(STAFF_ROLE_NAVIGATION[activeHat] ?? [], demoNavigation)
    .map((item) => ({
      key: item.key, viewKey: item.viewKey ?? item.key, labelKey: item.labelKey, path: item.path,
      sectionId: item.sectionId ?? null, icon: ICON_BY_KEY[item.key] ?? "right",
    }));
  const toolItems = STAFF_TOOLS
    .filter((tool) => staffToolAllowsHat(tool.view, activeHat))
    .filter((tool) => !planeItems.some((item) => item.viewKey === tool.view))
    .map((tool) => ({ key: tool.key, viewKey: tool.view, labelKey: tool.labelKey, path: tool.path, icon: ICON_BY_KEY[tool.key] ?? "briefcase" }));
  const groups = [];
  if (planeItems.length) groups.push({ key: "plane", label: t("altShell.groupWorkspace"), lock: true, items: planeItems });
  if (toolItems.length) groups.push({ key: "tools", label: t("altShell.groupTools"), lock: true, items: toolItems });
  return groups;
}

// Which side-nav item is current for a view. A view shared by several items
// (civic tabs, the coordination alias) resolves to the first item that mounts
// it; a view no item mounts (a dialog-only route) highlights nothing.
export function currentNavKey(groups, view, path = "") {
  const pathname = String(path || "").split(/[?#]/)[0];
  let best = null;
  let bestLength = -1;
  let fallback = null;
  for (const group of groups) {
    for (const item of group.items) {
      if ((item.viewKey ?? item.key) !== view) continue;
      // Staff plane pages share one view; the longest entry path that
      // contains the current path (a nested tab included) is the current one.
      const itemPath = String(item.path || "").split(/[?#]/)[0];
      if (pathname && itemPath && (pathname === itemPath || pathname.startsWith(`${itemPath}/`)) && itemPath.length > bestLength) {
        best = item.key;
        bestLength = itemPath.length;
      }
      fallback ??= item.key;
    }
  }
  return best ?? fallback;
}

// REQ-UG-ALT-PORT-MEMBER-PAGES-20261030: the member destination's own
// label, for the prototype's page hero (AltPageHero). Null for a view no
// member item mounts (staff planes keep their own plane headers).
export function memberPageTitle(t, view) {
  for (const group of memberNavGroups(t)) {
    for (const item of group.items) {
      if ((item.viewKey ?? item.key) === view) return item.label ?? t(item.labelKey);
    }
  }
  return null;
}
