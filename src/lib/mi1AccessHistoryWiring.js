import {
  buildPayActor,
  payRolesForSelectedHat,
  usePayScopedActor,
} from "./mi1PayWiring.js";

export const ACCESS_WEB_DONOR = Object.freeze({
  baseline: "donor-baseline-20260721",
  disposition: "port_adapt",
  rejected: Object.freeze([
    "Next.js app router and server components",
    "member-own votes, RSVPs, and questions presented as staff access",
    "row-image audit payloads",
    "actor email addresses",
  ]),
});

export const ACCESS_DATABASE_DEPENDENCIES = Object.freeze({
  migration: "20260828021500_mi1_member_access_history.sql",
  tables: ["member_access_events"],
  rpcs: ["list_my_access_history", "record_member_access_event"],
});

export function buildAccessActor(input) {
  return buildPayActor(input);
}

export function accessRolesForSelectedHat(input) {
  return payRolesForSelectedHat(input);
}

export function useAccessScopedActor(client, actor) {
  return usePayScopedActor(client, actor);
}
