import { STAFF_TOOL_ROLES } from "./staffPlanes.js";

// REQ-UG-ROLE-WORKSPACE-REFUSALS-20261030: integrations, the
// organization map and organization analytics are organization surfaces. The
// server admits only an organization-wide grant (organization_role_grants
// through private.has_organization_role), while an invitation gives a chapter
// role, so a chapter President or Coordinator could wear the hat and then meet
// "Select an authorized staff role", "Analytics isn't open to this role" or an
// integrations refusal whose "Try again" could never work. This mirrors each
// surface's own client check (features/*/authorization.js) and says, before
// the surface loads, which organization-wide role opens it and whether a
// role the account already holds can.
const WORKSPACES = Object.freeze({
  // canManageIntegrations: an Admin or President hat and either grant.
  integrations: Object.freeze({ roles: Object.freeze(["admin", "vp"]), sameGrant: false }),
  // authorizeOrganizationIntelligence: the worn hat must itself be granted.
  organizationMap: Object.freeze({ roles: STAFF_TOOL_ROLES, sameGrant: true }),
  // authorizeAnalyticsAccess: a staff hat and any staff grant.
  analytics: Object.freeze({ roles: STAFF_TOOL_ROLES, sameGrant: false }),
});

export const ORGANIZATION_WORKSPACE_VIEWS = Object.freeze(Object.keys(WORKSPACES));

// status "open": the surface may load under the worn hat.
// status "switch": another hat the account holds opens it; `hats` lists them.
// status "chapterOnly": the account holds a needed role for its chapter only.
// status "missing": the account holds none of the roles that open it.
export function organizationWorkspaceAccess(view, { hat, roles = [], organizationRoles = [] } = {}) {
  const workspace = WORKSPACES[view];
  if (!workspace) return { status: "open" };
  const allowed = workspace.roles;
  const granted = allowed.filter((role) => organizationRoles.includes(role));
  const opensUnder = (candidate) => allowed.includes(candidate)
    && (workspace.sameGrant ? organizationRoles.includes(candidate) : granted.length > 0);
  if (opensUnder(hat)) return { status: "open", allowed };
  // Only a role in data.roles can be worn (selectedStaffHatAuthorized).
  const hats = allowed.filter((role) => role !== hat && opensUnder(role) && roles.includes(role));
  if (hats.length) return { status: "switch", allowed, hats };
  const chapterOnly = allowed.filter((role) => roles.includes(role) && !organizationRoles.includes(role));
  return chapterOnly.length ? { status: "chapterOnly", allowed, chapterOnly } : { status: "missing", allowed };
}

// BUG-UG-CHAPTER-ADMIN-SEES-ORG-ADMIN-PAGES-THAT-FAIL-20261102: the
// Admin desk's feature switches, labels, staff two-step requirement, catalog
// verification and member operations read through
// private.has_organization_role(org, array['admin']), but an Admin hat can be
// a chapter role, and those pages then said "could not be read". The desk's
// own get_admin_org_structure read reports that same check as its scope, so
// it decides; while that read is missing, the selected membership's roles
// stand in. null means neither is known, and the pages keep their own states.
export const CHAPTER_ONLY_ADMIN_ACCESS = Object.freeze({
  status: "chapterOnly", allowed: Object.freeze(["admin"]), chapterOnly: Object.freeze(["admin"]),
});

export function adminDeskScope({ serverScope = null, organizationRoles = [], chapterRoles = [] } = {}) {
  if (serverScope === "organization" || serverScope === "chapter") return serverScope;
  if (Array.isArray(organizationRoles) && organizationRoles.includes("admin")) return "organization";
  if (Array.isArray(chapterRoles) && chapterRoles.includes("admin")) return "chapter";
  return null;
}
