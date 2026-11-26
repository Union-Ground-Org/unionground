import { vi } from "vitest";

// REQ-UG-SIGN-IN-PROVIDER-FIRST-LAYOUT-20261105: Apple and Google lead
// the sign-in card, so its provider readiness check (/api/auth-signin-options)
// runs as the card mounts, before any password, PIN or recovery request. A
// test that queues one-shot answers for those requests routes the readiness
// check here, and every other request reaches its own mock in order. Every
// sign-in control is released unless a test says otherwise
// (REQ-UG-RELEASE-HOLD-ON-ENTRY-SCREEN-CONTROLS-20261112). Auth has
// passkeys off unless a test turns them on, as a project does until passkeys
// are turned on in its own dashboard (#8525).
export function routeSignInOptions(other, providers = {}, released = { apple: true, google: true, sso: true }, passkeys = false) {
  return vi.fn((url, init) => (String(url) === "/api/auth-signin-options"
    ? Promise.resolve(new Response(JSON.stringify({ providers, released, passkeys })))
    : other(url, init)));
}
