import { ANALYTICS_SECTION_IDS } from "../features/analytics/contract.js";
import { COORDINATION_TABS } from "../features/coordination/contract.js";
import { MEMBER_SUPPORT_TABS } from "../features/memberSupport/contract.js";
import { STAFF_ROLE_NAVIGATION } from "./staffNavigation.js";

export const TAB_PAGE_GROUPS = Object.freeze({
  tasks: { view: "tasks", base: "/m/tasks", tabs: ["board", "list", "timeline", "calendar", "deadlines", "field_notes", "progress", "report"] },
  integrations: { view: "integrations", base: "/m/integrations", tabs: ["providers", "constant-contact", "jobs", "sms", "webhooks", "api-keys", "scim"] },
  evidence: { view: "admin", base: "/m/admin/evidence", sectionId: "admin-evidence-operations", tabs: ["notes", "actions"] },
  memberOperations: { view: "admin", base: "/m/admin/member-operations", sectionId: "admin-member-operations", tabs: ["directory", "welcome", "imports"] },
  automation: { view: "automations", base: "/m/automations", tabs: ["discover", "definitions", "recipes", "builder", "definition", "history", "run", "settings"] },
  adminAutomation: { view: "admin", base: "/m/admin/automations", sectionId: "admin-automation-control", tabs: ["definitions", "recipes", "builder", "definition", "history", "run", "settings"] },
  vpAutomation: { view: "vp", base: "/m/vp/automations", sectionId: "vp-automation-control", tabs: ["definitions", "recipes", "builder", "definition", "history", "run", "settings"] },
  coordinator: { view: "coordinator", base: "/m/coordinator/cases", sectionId: "coordinator-cases", tabs: ["queue", "timeline", "outreach", "dashboards"] },
  pay: { view: "pay", base: "/m/pay", tabs: ["calculator", "tables", "compare"] },
  hub: { view: "hub", base: "/m/organize", tabs: ["organize", "voice", "library", "record", "partners", "connections", "governance"], staffOnlyTabs: ["connections"] },
  voting: { view: "voting", base: "/m/voting", tabs: ["ballots", "past"] },
  // The member-support contract owns which of its tabs are staff-only, so the
  // routing half reads the same flag instead of restating the tab list here.
  support: { view: "memberSupport", base: "/m/support", tabs: MEMBER_SUPPORT_TABS.map((item) => item.id),
    staffOnlyTabs: MEMBER_SUPPORT_TABS.filter((item) => item.staffOnly).map((item) => item.id) },
  organizationMap: { view: "organizationMap", base: "/m/organization-map", tabs: ["charts", "relationships", "timeline", "connections"] },
  analytics: { view: "analytics", base: "/m/analytics", tabs: [...ANALYTICS_SECTION_IDS] },
  workload: { view: "workload", base: "/m/workload", tabs: ["submit", "history", "stats", "reminders"] },
  // The coordination contract owns its tab list and which tabs are staff-only
  // (coalitions, operations, mobilize); the routing half reads the same flag so
  // a staff-only tab's URL is refused to a member hat exactly like /m/support/handoffs
  // (TEST-UG-COORDINATION-MEMBER-COVERAGE-AND-STAFFONLY-TAB-ROUTES-20260919).
  coordination: { view: "coordination", base: "/m/coordination", tabs: COORDINATION_TABS.map((item) => item.id),
    staffOnlyTabs: COORDINATION_TABS.filter((item) => item.staffOnly).map((item) => item.id) },
  engagement: { view: "campaigns", base: "/m/campaigns/engagement", sectionId: "campaigns-engagement", tabs: ["surveys", "weekly", "polls", "pulse", "delivery", "channels"] },
  studio: { view: "campaigns", base: "/m/campaigns/studio", sectionId: "campaigns-studio", tabs: ["surveys", "operations", "weekly", "live", "insights"] },
});

// The appearance page holds only the most-used-places card since the five
// selectable themes were retired (#3844 removed `tasks.theme`), so its menu
// item carries that card's own title.
export const SETTINGS_PAGES = [
  ["profile", "workspace.profile", "settings.groupAccount"],
  ["security", "morehub.security", "settings.groupAccount"],
  ["sessions", "settings.sessionsTitle", "settings.groupAccount"],
  ["privacy", "workspace.privacy", "settings.groupAccount"],
  // REQ-UG-INVITATION-SUGGESTIONS-AND-ACCESS-REQUESTS-20261030.
  ["requests", "requests.title", "settings.groupAccount"],
  ["notifications", "setin.notifTitle", "settings.groupCommunication"],
  ["messages", "inbox.workflow.settingsTitle", "settings.groupCommunication"],
  ["language", "setin.langTitle", "settings.groupPreferences"],
  ["appearance", "navUsage.settingsTitle", "settings.groupPreferences"],
  ["shortcuts", "workspace.shortcuts", "settings.groupPreferences"],
  ["calendar", "settings.calendarHeading", "settings.groupConnections"],
].map(([key, labelKey, groupLabelKey]) => ({ key: `settings-${key}`, sectionId: `settings-${key}`, viewKey: "settings", path: `/m/settings/${key}`, labelKey, groupLabelKey }));

export function settingsPageGroups(pages) {
  const groups = new Map();
  for (const page of pages) {
    if (!groups.has(page.groupLabelKey)) groups.set(page.groupLabelKey, []);
    groups.get(page.groupLabelKey).push(page);
  }
  return [...groups].map(([labelKey, pages]) => ({ labelKey, pages }));
}

const NESTED_TAB_GROUP_BASE_LANDINGS = Object.freeze(["evidence", "memberOperations", "engagement", "studio"]);
const NESTED_TAB_GROUP_AUTOMATION_ALIASES = Object.freeze(["adminAutomation", "vpAutomation"]);

export const WORKSPACE_PAGES = Object.freeze([
  ...Object.values(STAFF_ROLE_NAVIGATION).flat().filter((item) => item.sectionId),
  ...SETTINGS_PAGES,
  ...Object.entries(TAB_PAGE_GROUPS).flatMap(([group, spec]) => {
    const pages = spec.tabs.map((tab) => ({
      key: `${group}-${tab}`, path: `${spec.base}/${tab}`, viewKey: spec.view,
      sectionId: spec.sectionId, group, tab,
    }));
    if (NESTED_TAB_GROUP_BASE_LANDINGS.includes(group)) {
      pages.push({
        key: `${group}-base`, path: spec.base, viewKey: spec.view,
        sectionId: spec.sectionId, group, tab: spec.tabs[0],
      });
    } else if (NESTED_TAB_GROUP_AUTOMATION_ALIASES.includes(group)) {
      pages.push({
        key: `${group}-base`, path: spec.base, viewKey: spec.view,
        sectionId: spec.sectionId, group, tab: null,
      });
    }
    return pages;
  }),
]);

export const NESTED_TAB_PAGE_GROUP_BASES = Object.freeze(
  Object.entries(TAB_PAGE_GROUPS)
    .filter(([group]) => NESTED_TAB_GROUP_BASE_LANDINGS.includes(group)
      || NESTED_TAB_GROUP_AUTOMATION_ALIASES.includes(group))
    .map(([group, spec]) => ({ group, ...spec })),
);

// Tab pages a member hat may not open. A staff-only tab is not merely hidden
// from the member's tab strip: its own URL is a staff destination, refused the
// same way a staff plane path is (see explicitHatAllowsView in src/App.jsx).
export const STAFF_ONLY_WORKSPACE_TAB_PATHS = Object.freeze(
  Object.values(TAB_PAGE_GROUPS)
    .flatMap((spec) => (spec.staffOnlyTabs || []).map((tab) => `${spec.base}/${tab}`)),
);

export function isStaffOnlyWorkspaceTabPath(pathname) {
  const path = String(pathname || "").replace(/\/+$/, "") || "/";
  return STAFF_ONLY_WORKSPACE_TAB_PATHS.includes(path);
}

export const WORKSPACE_PATH_VIEWS = Object.freeze(Object.fromEntries(WORKSPACE_PAGES.map((page) => [page.path, page.viewKey])));

export function workspacePageForLocation(pathname, hash = "") {
  const path = String(pathname || "").replace(/\/+$/, "");
  let legacy;
  try { legacy = decodeURIComponent(hash.replace(/^#/, "")); } catch { return null; }
  const hat = path.match(/^\/m\/(admin|steward|coordinator|advisor|vp)(?:\/|$)/)?.[1];
  // Never translate an anchor from another role into an identity change.
  const destination = hat && legacy ? STAFF_ROLE_NAVIGATION[hat].find((item) => item.sectionId === legacy) : null;
  if (destination) return destination;
  // Keep /m/network as a real network-tab location so members can stay on the
  // alias that distinguishes their hat. Do not rewrite this onto the staff tab URL.
  if (path === "/m/network") {
    return { key: "coordination-network-member", path: "/m/network", viewKey: "coordination", group: "coordination", tab: "network" };
  }
  return WORKSPACE_PAGES.find((item) => item.path === path) || null;
}
