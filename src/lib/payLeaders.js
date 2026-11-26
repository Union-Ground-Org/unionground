// Who sees the Pay page's leader tabs. Like the other staff-only tabs, the
// selected hat must be a leader role the actor holds; the coordinator hat has
// no Pay destination (src/lib/staffNavigation.js), so it is not a leader here.
// The confirmed organization roles decide when present; flattened roles also
// carry chapter grants.
export const PAY_LEADER_ROLES = Object.freeze(["advisor", "admin", "vp"]);

const roles = (actor) => new Set(Array.isArray(actor?.organizationRoles) ? actor.organizationRoles : (actor?.roles ?? []));

export const canLead = (actor) => PAY_LEADER_ROLES.includes(actor?.selectedHat) && roles(actor).has(actor.selectedHat);
