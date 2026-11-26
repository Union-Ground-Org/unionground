import { describe, expect, it } from "vitest";
import { memberNavGroups, staffNavGroups } from "../src/alt/nav.js";
import { MEMBER_PATH_VIEWS, STAFF_TOOL_PATH_VIEWS, appViewForPath } from "../src/lib/appRoutes.js";
import { FEATURE_GROUPS, MEMBER_WORK_ITEMS, SITE_GUIDE_ITEM } from "../src/lib/mobileNav.js";
import { SHORTCUT_CATALOG } from "../src/lib/navigationPreferences.js";
import { buildSiteGuide } from "../src/lib/siteGuide.js";
import { STAFF_ROLE_NAVIGATION, STAFF_TAB_PAGES } from "../src/lib/staffNavigation.js";
import { STAFF_PLANES, STAFF_TOOLS, STAFF_VIEWS } from "../src/lib/staffPlanes.js";
import {
  SETTINGS_PAGES, STAFF_ONLY_WORKSPACE_TAB_PATHS, TAB_PAGE_GROUPS, WORKSPACE_PAGES, workspacePageForLocation,
} from "../src/lib/workspacePages.js";

// TEST-UG-CONTRACT-CHECKS-A-FALLBACK-CANNOT-SATISFY-20261111 (#8324):
// in-app-link-inventory.test.js passes when the app serves an address, so a
// link that lands on Home or on a parent page passed, and the #8219 test walks
// four hand-written pages. These checks read the route table instead.

const t = (key) => key;
const pathOnly = (path) => String(path).split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";

function linkItems(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const own = typeof value.path === "string" && value.path.startsWith("/") ? [value] : [];
  return [...own, ...Object.values(value).flatMap((child) => linkItems(child, seen))];
}

// Every staff page the router serves: the desks and tools, and each workspace
// page that opens in a staff view or is a staff-only tab.
function staffPages(pages = WORKSPACE_PAGES) {
  return [...new Set([
    ...STAFF_PLANES.map((plane) => plane.path),
    ...STAFF_TOOLS.map((tool) => tool.path),
    ...pages.filter((page) => STAFF_VIEWS.includes(page.viewKey) || STAFF_ONLY_WORKSPACE_TAB_PATHS.includes(page.path))
      .map((page) => page.path),
  ])];
}

// A menu entry (a staff desk's rows, the desk and tool switcher, the alternate
// staff navigation) or a command search entry (desk rows and STAFF_TAB_PAGES).
const ENTRY_PATHS = new Set([
  ...linkItems(STAFF_ROLE_NAVIGATION), ...linkItems(STAFF_TAB_PAGES), ...linkItems(STAFF_PLANES), ...linkItems(STAFF_TOOLS),
  ...STAFF_PLANES.flatMap((plane) => linkItems(staffNavGroups(t, plane.key))),
].map((item) => pathOnly(item.path)));

function pagesWithoutEntry(pages, entries = ENTRY_PATHS) {
  return pages.filter((path) => !entries.has(path)).sort();
}

// Staff pages with no entry of their own on Nov 11, 2026, by tab group ("" is
// the group's own landing address). They are tabs of a page that has one. The
// list can only shrink: a page that gains an entry leaves it, and a new staff
// page needs an entry.
const WITHOUT_ENTRY = {
  tasks: ["board", "list", "timeline", "calendar", "deadlines", "field_notes", "progress", "report"],
  integrations: ["providers", "constant-contact", "jobs", "sms", "webhooks", "api-keys", "scim"],
  evidence: ["actions", ""],
  memberOperations: ["welcome", "imports", ""],
  automation: ["discover", "definitions", "recipes", "builder", "definition", "history", "run", "settings"],
  adminAutomation: ["definitions", "recipes", "builder", "definition", "history", "run", "settings", ""],
  vpAutomation: ["definitions", "recipes", "builder", "definition", "history", "run", "settings", ""],
  coordinator: ["queue", "timeline", "outreach", "dashboards"],
  hub: ["connections"],
  organizationMap: ["charts", "relationships", "timeline", "connections"],
  analytics: ["stats", "activity", "patterns", "charts"],
  coordination: ["missions", "network", "coalitions", "operations", "chapter"],
  engagement: ["surveys", "weekly", "pulse", "delivery", "channels", ""],
  studio: ["surveys", "operations", "weekly", "live", "insights", ""],
};
const LISTED = Object.entries(WITHOUT_ENTRY)
  .flatMap(([group, tabs]) => tabs.map((tab) => (tab ? `${TAB_PAGE_GROUPS[group].base}/${tab}` : TAB_PAGE_GROUPS[group].base)))
  .sort();

// The link registries a person can open by name, including the Site guide as
// built for a person holding every staff role.
const REGISTRIES = {
  FEATURE_GROUPS, MEMBER_WORK_ITEMS, SITE_GUIDE_ITEM, SHORTCUT_CATALOG, STAFF_PLANES, STAFF_TOOLS,
  STAFF_ROLE_NAVIGATION, STAFF_TAB_PAGES, SETTINGS_PAGES,
  altMember: memberNavGroups(t, {}, { siteGuide: true }),
  altStaff: STAFF_PLANES.map((plane) => staffNavGroups(t, plane.key)),
  siteGuide: buildSiteGuide({ t, roles: STAFF_PLANES.map((plane) => plane.key) }),
};

const KNOWN_VIEWS = new Set([...Object.values(MEMBER_PATH_VIEWS), ...Object.values(STAFF_TOOL_PATH_VIEWS), ...STAFF_VIEWS]);
const TAB_PAGE_KEYS = new Set(WORKSPACE_PAGES.filter((page) => page.tab).map((page) => page.key));
// Links named for a tab page under another key: the staff tab page
// campaigns-polls is the workspace's engagement-polls tab (#8628).
const TAB_KEY_ALIASES = { "campaigns-polls": "engagement-polls" };
const tabKeyOf = (key) => TAB_KEY_ALIASES[key] ?? key;

// Why a named link does not open the page it names, or null when it does. The
// router decides: the view its address opens, and the workspace page (section)
// it lands on.
function misdirection(item) {
  const path = pathOnly(item.path);
  const view = appViewForPath(path);
  if (view === null) return "the app does not serve it";
  if (view === "today" && !["today", "home"].includes(item.viewKey ?? item.key)) return "it opens Home";
  // The view a link names: its viewKey, a staff tool's view, or else its key
  // when that key is itself a view (a shortcut such as "events").
  const named = item.viewKey ?? item.view ?? (KNOWN_VIEWS.has(item.key) ? item.key : null);
  // A link that names no view cannot be checked, so it fails rather than
  // passing unread (#8628).
  if (!named) return "it names no view";
  if (named !== view) return `it opens ${view}, not ${named}`;
  const page = workspacePageForLocation(path);
  if (item.sectionId && page?.sectionId !== item.sectionId) return `it opens the ${view} page, not its ${item.sectionId} section`;
  // A link named for one tab page (its key is that page's key) must land on
  // that tab, not a sibling tab of the same view.
  const tab = tabKeyOf(item.key);
  if (TAB_PAGE_KEYS.has(tab) && page?.key !== tab) return `it opens ${page?.key ?? view}, not the ${tab} tab`;
  return null;
}

function misdirectedLinks(registries) {
  return Object.entries(registries).flatMap(([name, registry]) => linkItems(registry)
    .map((item) => [item, misdirection(item)])
    .filter(([, why]) => why)
    .map(([item, why]) => `${name} ${item.key ?? item.labelKey} ${item.path}: ${why}`));
}

describe("every staff page has a menu or search entry (read from the route table)", () => {
  it("finds the staff pages in the route table", () => {
    expect(staffPages().length).toBeGreaterThan(100);
    for (const page of STAFF_TAB_PAGES) expect(staffPages()).toContain(page.path);
  });

  it("gives every staff page an entry, apart from the listed ones", () => {
    expect(pagesWithoutEntry(staffPages()).filter((path) => !LISTED.includes(path))).toEqual([]);
  });

  it("lists only staff pages that still have no entry, so the list can only shrink", () => {
    expect(LISTED.filter((path) => !staffPages().includes(path))).toEqual([]);
    expect(LISTED.filter((path) => ENTRY_PATHS.has(path))).toEqual([]);
    // Nov 11, 2026: 76. The list may only shrink.
    expect(LISTED.length).toBeLessThanOrEqual(76);
  });

  it("fails on a seeded violation: a new staff tab page with no entry", () => {
    const seeded = [...WORKSPACE_PAGES, { key: "seeded", path: "/m/admin/seeded-page", viewKey: "admin" }];
    expect(pagesWithoutEntry(staffPages(seeded)).filter((path) => !LISTED.includes(path))).toEqual(["/m/admin/seeded-page"]);
    // Removing a retained tab's entry must still expose the missing link.
    const handoffs = "/m/support/handoffs";
    expect(pagesWithoutEntry(staffPages(), new Set([...ENTRY_PATHS].filter((path) => path !== handoffs))))
      .toContain(handoffs);
  });
});

describe("every named in-app link opens the page it names", () => {
  it("opens the named page, not Home and not a parent page, in every registry", () => {
    for (const [name, registry] of Object.entries(REGISTRIES)) expect(linkItems(registry).length, name).toBeGreaterThan(0);
    expect(misdirectedLinks(REGISTRIES)).toEqual([]);
  });

  it("checks every staff tab page as the workspace tab it names, under its own key or an alias", () => {
    for (const page of STAFF_TAB_PAGES) expect(TAB_PAGE_KEYS.has(tabKeyOf(page.key)), page.key).toBe(true);
    for (const target of Object.values(TAB_KEY_ALIASES)) expect(TAB_PAGE_KEYS.has(target), target).toBe(true);
  });

  it("fails on seeded violations: a link to Home, to a parent page, and to another page", () => {
    const seeded = {
      seeded: [
        { key: "seeded-home", labelKey: "nav.events", viewKey: "events", path: "/m" },
        { key: "seeded-parent", labelKey: "admin.handshake", viewKey: "admin", sectionId: "admin-handshake", path: "/m/admin" },
        { key: "seeded-other", labelKey: "nav.events", viewKey: "events", path: "/m/organize" },
        { key: "seeded-unknown", labelKey: "nav.events", path: "/m/seeded-nowhere" },
        // A shortcut whose key is its view, with no viewKey (SHORTCUT_CATALOG).
        { key: "events", labelKey: "nav.events", path: "/m/pay" },
        // A named tab link that opens a sibling tab of the same view.
        { key: "pay-tables", labelKey: "pay.tables", viewKey: "pay", path: "/m/pay/calculator" },
        // An alias key with no viewKey that is not a view.
        { key: "seeded-alias", labelKey: "nav.events", path: "/m/events" },
        // The campaigns-polls tab link landing on a sibling engagement tab.
        { key: "campaigns-polls", labelKey: "nav.campaignsPolls", viewKey: "campaigns", path: "/m/campaigns/engagement/surveys" },
      ],
    };
    expect(misdirectedLinks(seeded)).toEqual([
      "seeded seeded-home /m: it opens Home",
      "seeded seeded-parent /m/admin: it opens the admin page, not its admin-handshake section",
      "seeded seeded-other /m/organize: it opens organize, not events",
      "seeded seeded-unknown /m/seeded-nowhere: the app does not serve it",
      "seeded events /m/pay: it opens pay, not events",
      "seeded pay-tables /m/pay/calculator: it opens pay-calculator, not the pay-tables tab",
      "seeded seeded-alias /m/events: it names no view",
      "seeded campaigns-polls /m/campaigns/engagement/surveys: it opens engagement-surveys, not the engagement-polls tab",
    ]);
  });
});
