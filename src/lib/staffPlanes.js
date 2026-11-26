// The role-gated staff planes, in switcher order.
//
// One table, three consumers that used to keep their own copy: the isolated
// StaffSwitcher strip, the SAMPLE hat banner (which prepends the member hat),
// and App's "is this route a staff plane" check. Three copies is one copy per
// way to get it wrong — a plane added to the switcher but not to the view list
// renders its dashboard with the member bottom nav still on top of it.
//
// `key` is both the role name (App gates on data.roles) and the hat id, which
// is why the demo switcher and the real switcher can share it.
//
// Union Ground adds the organize plane, first after Worker: that is the desk
// this product exists for. Its key is the hat id and route, not a role row —
// organize is open to organizers and to the three staff roles that supervise
// them, so it alone carries a `roles` list (see planeRoles).
export const STAFF_PLANES = [
  { key: "organize", labelKey: "demo.hatOrganize", view: "organize", path: "/m/organize", roles: ["organizer", "coordinator", "advisor", "vp"] },
  { key: "steward", labelKey: "demo.hatSteward", view: "steward", path: "/m/steward" },
  { key: "coordinator", labelKey: "demo.hatCoordinator", view: "coordinator", path: "/m/coordinator" },
  { key: "advisor", labelKey: "demo.hatAdvisor", view: "advisor", path: "/m/advisor" },
  { key: "admin", labelKey: "demo.hatAdmin", view: "admin", path: "/m/admin" },
  { key: "vp", labelKey: "demo.hatVp", view: "vp", path: "/m/vp" },
];

// Staff TOOLS are not planes: they carry no hat and no role of their own, they
// are shared desks any staff plane can open. Tasks is the first one (owner
// decision, 2026-07-27: work coordination is staff-only). It behaves like a
// plane in the one way that matters to layout — desktop width, member bottom
// nav hidden — and unlike a plane in that it is entered from a plane rather
// than from the switcher.
export const STAFF_TOOLS = [
  { key: "tasks", labelKey: "nav.tasks", view: "tasks", path: "/m/tasks" },
  { key: "automations", labelKey: "workspace.automations", view: "automations", path: "/m/automations" },
  // UB-EVT-06: event authoring stopped being an
  // admin-only surface. It is a tool rather than a plane for the same reason
  // Tasks is — it carries no hat of its own, and all five staff roles open the
  // same desk.
  { key: "events-desk", labelKey: "eventsDesk.navLabel", view: "eventsDesk", path: "/m/events-desk" },
  { key: "campaigns", labelKey: "nav.campaigns", view: "campaigns", path: "/m/campaigns" },
  { key: "analytics", labelKey: "nav.analytics", view: "analytics", path: "/m/analytics" },
  { key: "organization-map", labelKey: "nav.organizationMap", view: "organizationMap", path: "/m/organization-map" },
  { key: "coordination", labelKey: "nav.coordination", view: "coordination", path: "/m/coordination" },
  { key: "qa-queue", labelKey: "nav.qaQueue", view: "qaQueue", path: "/m/qa-queue" },
  { key: "integrations", labelKey: "nav.integrations", view: "integrations", path: "/m/integrations", allowedHats: ["admin", "vp"] },
];

// Any of the five roles may open a staff tool. This is the list App checks
// before rendering one; a member with no role is redirected to /m.
// The organize plane is excluded: its key is a hat, not a role, and opening
// the shared staff tools to organizers is an owner decision not yet taken.
export const STAFF_TOOL_ROLES = STAFF_PLANES.filter((plane) => !plane.roles).map((plane) => plane.key);

export function staffToolAllowsHat(view, hat) {
  const tool = STAFF_TOOLS.find((entry) => entry.view === view);
  return Boolean(tool)
    && STAFF_TOOL_ROLES.includes(hat)
    && (!tool.allowedHats || tool.allowedHats.includes(hat));
}

// Route views that render a staff dashboard rather than a member screen.
export const STAFF_VIEWS = [
  ...STAFF_PLANES.map((plane) => plane.view),
  ...STAFF_TOOLS.map((tool) => tool.view),
];

// The roles that open a plane. Only organize differs from its own key.
export function planeRoles(plane) {
  return plane.roles ?? [plane.key];
}

export const ORGANIZE_ROLES = new Set(planeRoles(STAFF_PLANES.find((plane) => plane.key === "organize")));
