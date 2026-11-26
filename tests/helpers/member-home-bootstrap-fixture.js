import { MEMBER_HOME_BOOTSTRAP_RESOURCES } from "../../src/lib/memberHomeBootstrap.js";

// Mirrors public.get_member_home_bootstrap for deterministic test backends: one
// array per requested resource from the same per-table response the backend
// would give, or one failed call when any covered read would fail (a failing
// sub-select fails the whole function, and the loader then reads each table
// itself, so the fixtures exercise the same fallback).
export function composeMemberHomeBootstrap(respond, userId, resources = MEMBER_HOME_BOOTSTRAP_RESOURCES) {
  const payload = { user_id: userId };
  for (const resource of resources) {
    const result = respond(resource);
    if (result?.error) return { data: null, error: result.error };
    payload[resource.slice("table:".length)] = result?.data ?? [];
  }
  return { data: payload, error: null };
}
