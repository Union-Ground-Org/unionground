// The one table of trusted Supabase-origin -> portal-origin pairs, shared by
// the web modules and the native app (apps/mobile/src/lib/trustedBackends.ts
// re-exports it). A portal listed here is the only origin that may receive a
// member access token issued by its paired backend.
//
// Union Ground has no provisioned backend yet, so the table is empty and
// every token-bearing request is refused. Add exactly one owner-approved pair
// (and pin the same origin in config/sample-backend.json) when a dedicated
// Union Ground project exists. Never add a sibling product's project or
// portal. Kept in its own module so suites can substitute fictional pairs
// without any switch in shipped code.
export const TRUSTED_BACKEND_PORTALS = Object.freeze({});

export function isTrustedPortalOrigin(origin) {
  return Object.values(TRUSTED_BACKEND_PORTALS).includes(origin);
}
