import { STAFF_TOOLS } from "./staffPlanes.js";
import { WORKSPACE_PATH_VIEWS } from "./workspacePages.js";
import { EMAIL_AUTH_PATHS } from "./emailedAuthLink.js";

// One browser-independent registry for every path Vercel serves through the SPA
// shell. App uses the same member/auth entries at runtime and the production
// build verifier compares this list with vercel.json, so adding a route on
// only one side fails before deployment.

export const MEMBER_PATH_VIEWS = Object.freeze({
  ...Object.fromEntries(Object.entries(WORKSPACE_PATH_VIEWS).filter(([, view]) => !STAFF_TOOLS.some(tool => tool.view === view))),
  "/": "today",
  "/m": "today",
  // Union Ground: the worker Work list.
  "/m/work": "work",
  "/m/messages": "messages",
  "/m/numbers": "numbers",
  "/m/pulse": "pulse",
  "/m/voting": "voting",
  "/m/voice": "voice",
  "/m/qa": "qa",
  "/m/pay": "pay",
  // REQ-UG-ALT-PORT-MEMBER-PAGES-20261030: the prototype's All
  // updates page. App mounts it only under the alternate shell; the classic
  // shell falls back to its home for this address.
  "/m/updates": "updates",
  "/m/cases": "cases",
  "/m/rights": "rights",
  "/m/org-structure": "orgStructure",
  "/m/support": "memberSupport",
  // REQ-UG-SITE-GUIDE-FOR-REAL-ACCOUNTS-20261001: "How to use this site".
  "/m/guide": "siteGuide",
  "/m/events": "events",
  "/m/actions": "actions",
  "/m/appointments": "appointments",
  "/m/settings": "settings",
  "/m/access-history": "accessHistory",
  "/m/workload": "workload",
  "/m/forms": "forms",
  "/m/rewards": "rewards",
  "/m/search": "search",
  // The bare address is the Organize plane (OrganizeView).
  // The campaign workspace hub keeps its tab pages under it
  // (/m/organize/organize, /m/organize/voice, ...; lib/workspacePages.js).
  "/m/organize": "organize",
  "/m/network": "coordination",
  "/m/steward": "steward",
  "/m/coordinator": "coordinator",
  "/m/advisor": "advisor",
  "/m/admin": "admin",
  "/m/vp": "vp",
});

// Union Ground's public front door beside "/" (which index.html serves).
export const UNIONGROUND_PUBLIC_SPA_PATHS = Object.freeze(["/learn", "/connect"]);

// Retired inherited trees. Every address under them reaches the SPA, which
// renders RetiredLegacyView, rather than a static file or a silent redirect.
export const RETIRED_LEGACY_SPA_PATHS = Object.freeze([
  "/contractsurvey",
  "/contractsurvey/:path*",
  "/design",
  "/design/:path*",
]);

export const AUTH_PATHS = new Set(["/auth", "/signin", "/sign-in", "/login"]);

// BUG-UG-M-HOME-AND-MEMBER-TOOLS-ADDRESSES-NOT-FOUND-20261006: the
// addresses people type from what a page is called. Each one redirects (in
// vercel.json, checked against this map) to the canonical page; none is an
// SPA route of its own, so the canonical address stays the only one shown.
export const APP_PATH_ALIASES = Object.freeze({
  "/m/home": "/m",
  // The "Member tools" label (workspace.shortcuts) opens the shortcuts page.
  "/m/settings/member-tools": "/m/settings/shortcuts",
  // REQ-UG-DEAD-IN-APP-LINKS-404-20261030: addresses the Oct 29-30
  // role-play run typed or followed from what a page is called.
  "/m/calendar": "/m/events",
  "/m/be-heard": "/m/voice",
  "/m/site-guide": "/m/guide",
  "/m/chapter": "/m/organize",
  "/m/announcements": "/m/messages?filter=announcement",
  // REQ-UG-OFFICER-NOTICES-WITH-READ-RECEIPTS-20261030: the other
  // addresses officers typed for notices; officers post from the same tab.
  "/m/broadcasts": "/m/messages?filter=announcement",
  "/m/admin/announcements": "/m/messages?filter=announcement",
  "/m/admin/broadcasts": "/m/messages?filter=announcement",
  // Compass is the assistant dialog, not a page; Know your rights carries
  // its entry ("The contract, searchable" opens it).
  "/m/compass": "/m/rights",
  "/m/settings/tools": "/m/settings/shortcuts",
  "/m/steward/cases": "/m/steward/caseload",
  "/m/manage": "/m/admin",
  "/m/admin/features": "/m/admin/configuration",
  "/m/members": "/m/admin/member-directory",
  "/m/roster": "/m/admin/member-operations",
  "/admin": "/m/admin",
  // BUG-UG-BARE-SETTINGS-ADDRESS-404-20261102: the bare address a
  // member typed for Settings, like /admin above.
  "/settings": "/m/settings",
});

export const STAFF_TOOL_PATH_VIEWS = Object.freeze(
  Object.fromEntries([
    ...STAFF_TOOLS.map((tool) => [tool.path, tool.view]),
    ...Object.entries(WORKSPACE_PATH_VIEWS).filter(([, view]) => STAFF_TOOLS.some(tool => tool.view === view)),
  ]),
);

// UB-UG-UNKNOWN-APP-ADDRESS-LEAVES-SHELL-20261106: every other
// address under /m (a mistyped or stale link) is still served the shell, which
// shows its own not-found page inside the rail and hat. It is the LAST rewrite
// in vercel.json, so the exact entries above win, and nothing outside /m
// reaches it: unknown public addresses keep the static 404.
export const APP_SHELL_FALLBACK_PATH = "/m/:path*";

export const SPA_ROUTE_PATHS = Object.freeze([
  ...AUTH_PATHS,
  "/invite",
  EMAIL_AUTH_PATHS.invitation,
  // Open signup, offered only while the owner's switch is on
  // (REQ-UG-PUBLIC-SIGNUP-OWNER-SWITCH-20261003; off by default).
  "/signup",
  "/signup/confirm",
  // Self-service password reset: the request form and the emailed link.
  "/reset-password",
  EMAIL_AUTH_PATHS.passwordReset,
  // Get Union Ground: the page the invitation emails' QR code opens.
  "/get-app",
  // Request an invite: the invitation-only front door for people without one.
  "/request-invite",
  "/stop-updates",
  ...Object.keys(MEMBER_PATH_VIEWS).filter((path) => path !== "/"),
  ...Object.keys(STAFF_TOOL_PATH_VIEWS),
  ...RETIRED_LEGACY_SPA_PATHS,
  ...UNIONGROUND_PUBLIC_SPA_PATHS,
  // No public chapter directory, public events or public union catalog:
  // worker activity stays off the public front door.
  APP_SHELL_FALLBACK_PATH,
]);

export function normalizeAppPath(pathname) {
  const path = String(pathname || "/");
  return path.replace(/\/+$/, "") || "/";
}

// Member-only coordination entry. Staff hats use /m/coordination/network;
// this alias is what initialHatFromPath uses to keep SAMPLE on Member.
export function memberCoordinationAliasPath(pathname) {
  const path = pathname ?? (typeof window === "undefined" ? "/" : window.location.pathname);
  return normalizeAppPath(path) === "/m/network";
}

export function appViewForPath(pathname) {
  const path = normalizeAppPath(pathname);
  return MEMBER_PATH_VIEWS[path] || STAFF_TOOL_PATH_VIEWS[path] || null;
}

// An address under /m that no member or staff page claims: the shell keeps
// the visitor and shows its not-found page (APP_SHELL_FALLBACK_PATH).
export function unknownAppPath(pathname) {
  const path = normalizeAppPath(pathname);
  return path.startsWith("/m/") && appViewForPath(path) === null;
}
