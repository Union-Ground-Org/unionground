// One backed navigation contract for every staff hat. Route items open real
// screens; former dashboard sections have focused page URLs. Legacy section
// IDs remain compatibility targets, not instructions to stack every panel.
// Desktop and mobile use this same table so neither drops a destination.

const tasks = { key: "tasks", viewKey: "tasks", labelKey: "staff.chapterWork", path: "/m/tasks", icon: "☑" };
const automations = { key: "automations", viewKey: "automations", labelKey: "workspace.automations", path: "/m/automations", icon: "⚙" };
// Organize is a shared chapter surface, but its authoring controls still read
// the explicitly selected hat in App. Listing it on every staff map preserves
// the backed staff workflow without leaking those controls into Member.
const organize = { key: "hub", viewKey: "hub", labelKey: "hub.title", path: "/m/organize/organize", icon: "⌂" };
// UB-EVT-06: the shared events desk. The admin plane keeps its in-plane
// admin-events section instead — the same card, already reachable there — so
// this row exists for the four hats that had no authoring entrance at all.
// Without it the desk is only reachable by typing the URL, which is not an
// authoring path any steward would ever find.
const eventsDesk = { key: "events-desk", viewKey: "eventsDesk", labelKey: "eventsDesk.navLabel", path: "/m/events-desk", icon: "📅" };
const campaigns = { key: "campaigns", viewKey: "campaigns", labelKey: "nav.campaigns", path: "/m/campaigns", icon: "C" };
const integrations = { key: "integrations", viewKey: "integrations", labelKey: "nav.integrations", path: "/m/integrations", icon: "🔌" };
const analytics = { key: "analytics", viewKey: "analytics", labelKey: "nav.analytics", path: "/m/analytics", icon: "📊" };
const organizationMap = { key: "organization-map", viewKey: "organizationMap", labelKey: "nav.organizationMap", path: "/m/organization-map", icon: "◎" };
const actions = { key: "actions", viewKey: "actions", labelKey: "nav.collectiveActions", path: "/m/actions", icon: "✊" };
const coordination = { key: "coordination", viewKey: "coordination", labelKey: "nav.coordination", path: "/m/coordination", icon: "◎" };
const memberSupport = { key: "member-support", viewKey: "memberSupport", labelKey: "nav.memberSupport", path: "/m/support", icon: "🤝" };
const qaQueue = { key: "qa-queue", viewKey: "qaQueue", labelKey: "nav.qaQueue", path: "/m/qa-queue", icon: "❓" };
// Pay tools for the three hats that may publish the pay catalog. The
// publisher inside /m/pay is gated on the advisor/admin/vp write roles of the
// selected hat (payRolesForSelectedHat), so those hats need the route too;
// without this row the shell refused /m/pay to every hat that could write and
// only Member, which carries no write role, could open it
// (UX-UG-WEB-PAY-CATALOG-PUBLISHER-UNREACHABLE-WRITE-HATS-CANNOT-OPEN-M-PAY-20260921).
// The RPCs still recheck the organization role and MFA.
const pay = { key: "pay", viewKey: "pay", labelKey: "nav.pay", path: "/m/pay", icon: "💲" };
// Messages is one shared authorized inbox whose presentation changes with the
// explicitly selected staff hat. It stays out of Member when a staff hat is
// worn, and it never changes the loader or permission boundary.
const messages = { key: "messages", viewKey: "messages", labelKey: "nav.inbox", path: "/m/messages", icon: "💬" };
// BUG-UG-INVITATION-SUGGESTIONS-HIDDEN-FROM-ADMIN-DESK-20261102: the
// request notifications say "Approve or decline it under Requests", so the
// people who decide (admins and Presidents) reach that page by that name.
const requests = { key: "requests", viewKey: "settings", labelKey: "requests.title", path: "/m/settings/requests", icon: "📨" };

const LEGACY_STAFF_ROLE_NAVIGATION = {
  steward: [
    { key: "steward", viewKey: "steward", labelKey: "nav.casework", path: "/m/steward", icon: "📁" },
    { key: "steward-caseload", viewKey: "steward", labelKey: "steward.caseloadTitle", path: "/m/steward", sectionId: "steward-caseload", icon: "⚖" },
    { key: "steward-requests", viewKey: "steward", labelKey: "steward.requestsTitle", path: "/m/steward", sectionId: "steward-requests", icon: "📨" },
    { key: "steward-appointments", viewKey: "steward", labelKey: "appt.deskTitle", path: "/m/steward", sectionId: "steward-appointments", icon: "📅" },
    { key: "steward-forms", viewKey: "steward", labelKey: "steward.formsTitle", path: "/m/steward", sectionId: "steward-forms", icon: "🖊" },
    { key: "steward-messages", viewKey: "steward", labelKey: "staffnav.stewardMessages", path: "/m/steward", sectionId: "steward-messages", icon: "💬" },
    { key: "steward-checkins", viewKey: "steward", labelKey: "steward.scanTitle", path: "/m/steward", sectionId: "steward-checkins", icon: "✓" },
    { key: "steward-broadcasts", viewKey: "steward", labelKey: "steward.broadcastsTitle", path: "/m/steward", sectionId: "steward-broadcasts", icon: "📣" },
    { key: "steward-qa", viewKey: "steward", labelKey: "staffnav.qaPreview", path: "/m/steward", sectionId: "steward-qa", icon: "❓" },
    messages,
    organize,
    eventsDesk,
    campaigns,
    coordination,
    memberSupport,
    analytics,
    organizationMap,
    actions,
    qaQueue,
    automations,
    tasks,
  ],
  coordinator: [
    { key: "coordinator", viewKey: "coordinator", labelKey: "coordinator.title", path: "/m/coordinator", icon: "📋" },
    { key: "coordinator-cases", viewKey: "coordinator", labelKey: "coordinator.casesTitle", path: "/m/coordinator", sectionId: "coordinator-cases", icon: "📁" },
    { key: "coordinator-deadlines", viewKey: "coordinator", labelKey: "coordinator.deadlinesTitle", path: "/m/coordinator", sectionId: "coordinator-deadlines", icon: "⏰" },
    messages,
    organize,
    eventsDesk,
    campaigns,
    coordination,
    memberSupport,
    analytics,
    organizationMap,
    actions,
    qaQueue,
    automations,
    tasks,
  ],
  advisor: [
    { key: "advisor", viewKey: "advisor", labelKey: "advisor.title", path: "/m/advisor", icon: "🧭" },
    { key: "advisor-workload", viewKey: "advisor", labelKey: "advisor.workloadTitle", path: "/m/advisor", sectionId: "advisor-workload", icon: "⏲" },
    { key: "advisor-turnout", viewKey: "advisor", labelKey: "advisor.turnoutTitle", path: "/m/advisor", sectionId: "advisor-turnout", icon: "🗳" },
    { key: "advisor-risks", viewKey: "advisor", labelKey: "advisor.atRiskTitle", path: "/m/advisor", sectionId: "advisor-risks", icon: "⚠" },
    { key: "advisor-leadership", viewKey: "advisor", labelKey: "vp.rosterTitle", path: "/m/advisor", sectionId: "advisor-leadership", icon: "👥" },
    messages,
    organize,
    eventsDesk,
    campaigns,
    coordination,
    memberSupport,
    analytics,
    organizationMap,
    actions,
    qaQueue,
    pay,
    automations,
    tasks,
  ],
  admin: [
    { key: "admin", viewKey: "admin", labelKey: "admin.title", path: "/m/admin", icon: "🛡" },
    { key: "admin-access", viewKey: "admin", labelKey: "admin.rolesTitle", path: "/m/admin", sectionId: "admin-access", icon: "👥" },
    { key: "admin-mfa", viewKey: "admin", labelKey: "admin.mfaTitle", path: "/m/admin", sectionId: "admin-mfa", icon: "🔐" },
    { key: "admin-events", viewKey: "admin", labelKey: "admin.eventsTitle", path: "/m/admin", sectionId: "admin-events", icon: "📅" },
    { key: "admin-form-templates", viewKey: "admin", labelKey: "admin.templates.title", path: "/m/admin", sectionId: "admin-form-templates", icon: "🧾" },
    { key: "admin-audit", viewKey: "admin", labelKey: "admin.auditTitle", path: "/m/admin", sectionId: "admin-audit", icon: "📋" },
    { key: "admin-organization-audit", viewKey: "admin", labelKey: "admin.organizationAuditTitle", path: "/m/admin", sectionId: "admin-organization-audit", icon: "📜" },
    { key: "admin-job-health", viewKey: "admin", labelKey: "admin.jobHealthTitle", path: "/m/admin", sectionId: "admin-job-health", icon: "⏱" },
    messages,
    requests,
    organize,
    campaigns,
    coordination,
    memberSupport,
    analytics,
    organizationMap,
    actions,
    qaQueue,
    integrations,
    pay,
    automations,
    tasks,
  ],
  vp: [
    { key: "vp", viewKey: "vp", labelKey: "vp.title", path: "/m/vp", icon: "🏛" },
    { key: "vp-trend", viewKey: "vp", labelKey: "vp.trendTitle", path: "/m/vp", sectionId: "vp-trend", icon: "📈" },
    { key: "vp-attention", viewKey: "vp", labelKey: "vp.attentionTitle", path: "/m/vp", sectionId: "vp-attention", icon: "⚖" },
    { key: "vp-leadership", viewKey: "vp", labelKey: "vp.rosterTitle", path: "/m/vp", sectionId: "vp-leadership", icon: "👥" },
    { key: "vp-priorities", viewKey: "vp", labelKey: "vp.prioritiesTitle", path: "/m/vp", sectionId: "vp-priorities", icon: "🎯" },
    { key: "vp-events", viewKey: "vp", labelKey: "vp.agendaTitle", path: "/m/vp", sectionId: "vp-events", icon: "📅" },
    messages,
    requests,
    organize,
    eventsDesk,
    campaigns,
    coordination,
    memberSupport,
    analytics,
    organizationMap,
    actions,
    qaQueue,
    integrations,
    pay,
    automations,
    tasks,
  ],
};

const additionalPages = {
  admin: [
    ["member-directory", "admin.command.directoryTitle"],
    ["organization", "admin.command.organizationTitle"],
    ["chapter-handshake", "admin.chapterLifecycle.title"],
    ["handshake-documents", "admin.chapterLifecycle.documentsTitle"],
    ["chapter-memberships", "admin.chapterLifecycle.membershipTitle"],
    ["configuration", "admin.config.title"], ["labels", "admin.labels.title"],
    ["failed-logins", "admin.loginInbox.title"], ["lifecycle", "admin.command.lifecycleTitle"],
    ["invitations", "admin.inviteTitle"],
    // Its own page so the rail, the Site guide and /m/roster can name it; it
    // used to sit only at the foot of the invitation form, where no officer in
    // the Oct 29-30 run found it (REQ-UG-OFFICER-MEMBER-ROSTER-AND-EXPORT-20261030).
    ["roster-import", "roster.importTitle"],
    ["signin-recovery", "admin.recoveryTitle"],
    ["governance", "workspace.dataRights"], ["compass-governance", "workspace.compassGovernance"],
    ["evidence-operations", "workspace.evidence", "evidence/notes"],
    ["member-operations", "workspace.memberOperations", "member-operations/directory"],
    ["retention-engine", "admin.retention.title"],
    ["leadership-reviews", "admin.leadershipReviewsTitle"],
    ["appointments", "appt.deskTitle"],
    ["setup-review", "unions.setup.pageTitle"],
    // The platform operator's intake queue: everyone who asked Union Ground for
    // updates, an invite or to join (REQ-UG-INTAKE-QUEUE-PEOPLE-WAITING-ADMIN-PAGE-20261118).
    // The route refuses anyone without intake_review.
    ["people-waiting", "admin.peopleWaitingTitle"],
  ],
  steward: [["email-intake", "workspace.emailIntake"], ["workload", "steward.workloadTitle"], ["casework-hub", "workspace.caseworkHub"]],
  coordinator: [["appointments", "appt.deskTitle"], ["macros", "coordinator.macrosTitle"], ["casework-hub", "workspace.caseworkHub"]],
  advisor: [["appointments", "appt.deskTitle"]],
  // REQ-UG-INVITE-RIGHTS-AND-ACCESS-REQUESTS-20261030: the
  // President's invitation card had no page of its own. The chapter's member
  // directory through the President's office
  // (REQ-UG-OFFICER-MEMBER-ROSTER-AND-EXPORT-20261030).
  vp: [["invitations", "admin.inviteTitle"], ["member-directory", "admin.command.directoryTitle"]],
};

// sectionId is retained only as a compatibility/rendering identity. Every
// entry now opens an independent page; it is never an anchor destination.
//
// Union Ground has no dues, contract articles, civic action, grievance
// procedure settings, reward economy or public union catalog, so no staff map
// lists them.

export const STAFF_ROLE_NAVIGATION = Object.fromEntries(
  Object.entries(LEGACY_STAFF_ROLE_NAVIGATION).map(([hat, entries]) => {
    const local = entries.filter((item) => item.viewKey === hat).map((item) => ({
      ...item,
      path: item.sectionId ? `/m/${hat}/${item.sectionId.slice(hat.length + 1)}` : item.path,
    }));
    const extra = (additionalPages[hat] || []).map(([slug, labelKey, path = slug]) => ({
      key: `${hat}-${slug}`, sectionId: `${hat}-${slug}`, viewKey: hat,
      labelKey, path: `/m/${hat}/${path}`, icon: "◦",
    }));
    return [hat, [...local, ...extra, ...entries.filter((item) => item.viewKey !== hat)]];
  }),
);

// The platform review page is unavailable in the demo.
const DEMO_UNAVAILABLE_ADMIN_PAGES = new Set([
  "admin-people-waiting",
]);

export function visibleStaffNavigation(items, demoNavigation) {
  return demoNavigation ? items.filter((item) => !DEMO_UNAVAILABLE_ADMIN_PAGES.has(item.key)) : items;
}

const WORKSPACE_ITEM_KEYS = new Set(["messages", "requests", "hub", "events-desk", "campaigns", "coordination", "member-support", "analytics", "organization-map", "actions", "qa-queue", "integrations", "pay", "automations", "tasks"]);

const STAFF_DESK_GROUP_LABEL = {
  steward: "shell.groupSteward",
  coordinator: "shell.groupCasework",
  advisor: "shell.groupField",
  admin: "shell.groupAdmin",
  vp: "shell.groupLeadership",
};

// The cross-plane destinations a staff plane links to — the same rows the rail
// groups under "shell.groupWorkspace". They carry no sectionId, so a plane's
// focused-page list deliberately excludes them; the plane overview still has to
// advertise them, because the rail is desktop-only and a top-level tool route
// (/m/campaigns, /m/coordination) has no parent to be discovered from other
// than its plane home.
export function staffWorkspaceDestinations(items = []) {
  return items.filter((item) => WORKSPACE_ITEM_KEYS.has(item.key));
}

export function staffRailGroups(hat, items) {
  const desk = [];
  const onThisPage = [];
  const workspace = [];
  for (const item of items) {
    if (WORKSPACE_ITEM_KEYS.has(item.key)) workspace.push(item);
    else if (item.sectionId) onThisPage.push(item);
    else desk.push(item);
  }
  return [
    { labelKey: STAFF_DESK_GROUP_LABEL[hat] ?? "shell.groupWork", items: desk },
    {
      labelKey: "workspace.pages",
      items: onThisPage,
    },
    { labelKey: "shell.groupWorkspace", items: workspace },
  ].filter((group) => group.items.length > 0);
}

// Staff tab pages that live inside a workspace page rather than on a desk of
// their own. Their page shows the tab only to a hat that may open it; command
// search names them for that same hat, because officers looked for them by
// name and found nothing (UX-UG-STAFF-PAGES-WITH-NO-MENU-OR-SEARCH-ENTRY-20261111).
// `parent` is the desk entry that opens the page.
export const STAFF_TAB_PAGES = Object.freeze([
  { key: "support-handoffs", parent: "member-support", viewKey: "memberSupport", path: "/m/support/handoffs", labelKey: "nav.supportHandoffs", keywords: ["handoffs", "handoff", "support"] },
  { key: "coordination-mobilize", parent: "coordination", viewKey: "coordination", path: "/m/coordination/mobilize", labelKey: "nav.coordinationMobilize", keywords: ["mobilize", "coordination"] },
  { key: "campaigns-polls", parent: "campaigns", viewKey: "campaigns", path: "/m/campaigns/engagement/polls", labelKey: "nav.campaignsPolls", keywords: ["polls", "poll", "campaigns"] },
].map((page) => Object.freeze({ ...page, keywords: Object.freeze(page.keywords) })));

/**
 * The tab pages a hat's command search offers: the hat's own desk entries link
 * the parent page, and `opens[key]` (the page's own authorization rule for the
 * worn hat) is not false.
 */
export function staffTabPagesFor(items = [], opens = {}) {
  const parents = new Set(items.map((item) => item.key));
  return STAFF_TAB_PAGES.filter((page) => parents.has(page.parent) && opens[page.key] !== false);
}

export const STAFF_ROLE_SECTION_IDS = new Set(
  Object.values(STAFF_ROLE_NAVIGATION).flat().map((item) => item.sectionId).filter(Boolean),
);

export function staffItemHref(item) {
  return item.path;
}

export function currentStaffSection() {
  if (typeof window === "undefined") return "";
  const path = window.location.pathname.replace(/\/+$/, "");
  const page = Object.values(STAFF_ROLE_NAVIGATION).flat().find((item) => {
    const base = item.path.replace(/\/(notes|directory)$/, "");
    return item.sectionId && (path === item.path || path.startsWith(`${base}/`));
  });
  if (page) return page.sectionId;
  try { return decodeURIComponent(window.location.hash.replace(/^#/, "")); } catch { return ""; }
}

export function focusStaffSection(sectionId, { updateHistory = false } = {}) {
  if (!sectionId || typeof document === "undefined") return false;
  const target = document.getElementById(sectionId);
  if (!target) return false;
  if (updateHistory && typeof window !== "undefined") {
    const url = new URL(window.location.href);
    url.hash = sectionId;
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }
  const reduceMotion = typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView?.({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  target.focus?.({ preventScroll: true });
  return true;
}
