// Shared bits of the role-gated staff planes (admin, advisor, VP).
//
// The card surface and the role → catalogue-key map were copied byte-for-byte
// into all three views. Roles are the sharper of the two: a plane that misses a
// key falls through to the raw slug, so an admin sees "vp" where the roster next
// to it says "President". One map means adding a role updates every plane.
// E1 (review v5): moved to the .plane-card rule in styles.css. Distinct from
// the member .m-card by design — no border, 20px radius.
export const PLANE_CARD_CLASS = "plane-card";

export const ROLE_LABEL_KEYS = {
  steward: "demo.hatSteward",
  organizer: "demo.hatOrganizer",
  coordinator: "demo.hatCoordinator",
  advisor: "demo.hatAdvisor",
  admin: "demo.hatAdmin",
  vp: "demo.hatVp",
  secretary: "access.role.secretary",
  records: "access.role.records",
  treasurer: "access.role.treasurer",
};

// BUG-UG-HOME-AND-TOP-BAR-CALL-OFFICERS-MEMBER-20261006: Home and the
// top bar name the person's highest office beside the hat they wear, so a
// President is not just "Member" while the leadership list says President.
const OFFICE_ORDER = ["vp", "admin", "secretary", "treasurer", "records", "coordinator", "advisor", "steward"];
// `roles` is data.roles: the selected-or-first membership's roles, which still
// name the office when no membership row is flagged selected (PR #4084 round 1).
export function highestOfficeKey(member, roles = []) {
  const held = new Set([...(member?.chapterRoles || []), ...(member?.organizationRoles || []), ...(Array.isArray(roles) ? roles : [])]);
  const role = OFFICE_ORDER.find((item) => held.has(item));
  return role ? ROLE_LABEL_KEYS[role] : null;
}
