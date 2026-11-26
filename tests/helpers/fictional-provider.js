// A fictional Union Ground provider for suites that exercise host- or
// backend-keyed code. Union Ground ships with no trusted backend pair, no
// emailed-link host and no public site (src/lib/trustedBackends.js,
// src/lib/emailLinkHosts.js, src/lib/publicContact.js), so production code
// refuses every host. A suite that needs a configured product substitutes these
// fictional values with vi.mock; shipped code never sees them.
//
//   vi.mock("../src/lib/trustedBackends.js", async () =>
//     (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
//   vi.mock("../src/lib/emailLinkHosts.js", async () =>
//     (await import("./helpers/fictional-provider.js")).emailLinkHostsModule());
//
// The SAMPLE (demo) host needs no mock: it is the reserved placeholder from
// config/sample-backend.json, SAMPLE_HOST below.
export const PORTAL_HOST = "app.unionground.test";
export const PORTAL_ORIGIN = `https://${PORTAL_HOST}`;
export const SUPABASE_REF = "psgfictionalproject";
export const SUPABASE_ORIGIN = `https://${SUPABASE_REF}.supabase.co`;
export const SAMPLE_HOST = "unionground.invalid";
export const SAMPLE_ORIGIN = `https://${SAMPLE_HOST}`;
export const SUPPORT_EMAIL = "support@unionground.test";

// The API uses a production backend only when its origin is an approved pair
// here AND UNIONGROUND_SUPABASE_PROJECT_REF names its project
// (api/_lib/providerBoundary.js). A suite whose fixture backend is another
// fictional https://<ref>.supabase.co origin approves it by passing it here and
// stubs that <ref>.
export function trustedBackendsModule(...fixtureOrigins) {
  const TRUSTED_BACKEND_PORTALS = Object.freeze(Object.fromEntries(
    [SUPABASE_ORIGIN, ...fixtureOrigins].map((origin) => [origin, PORTAL_ORIGIN]),
  ));
  return {
    TRUSTED_BACKEND_PORTALS,
    isTrustedPortalOrigin: (origin) => Object.values(TRUSTED_BACKEND_PORTALS).includes(origin),
  };
}

export function emailLinkHostsModule() {
  return { EMAIL_LINK_HOSTS: Object.freeze([PORTAL_HOST]) };
}

// A published support mailbox for suites that render or send to one.
export function publicContactModule() {
  const support = Object.freeze({ email: SUPPORT_EMAIL, href: `mailto:${SUPPORT_EMAIL}` });
  const PUBLIC_CONTACTS = Object.freeze({ support });
  return {
    PUBLIC_CONTACTS,
    PUBLIC_POSTAL_ADDRESS: null,
    publicContact: (role) => (Object.hasOwn(PUBLIC_CONTACTS, role) ? PUBLIC_CONTACTS[role] : null),
  };
}
