import { emailFromAccessToken } from "./exactSessionStorage.js";
// Union Ground has no provisioned backend. The pinned SAMPLE project is
// empty, so isForbiddenSampleBackend() refuses every Supabase target and the
// demo runs on in-app fiction. Sibling-product projects are listed in
// config/sample-backend.json as forbidden; none is named here.
export const SAMPLE_BACKEND = Object.freeze({
  samplePortalOrigin: "https://unionground.invalid",
  sampleSupabaseOrigin: "",
  sampleSupabaseRef: "",
  // Fictional organizing personas for the preview hat switcher. Internal hat
  // ids stay on the shared role names (member, steward, coordinator, ...) so
  // role rows and gates keep working; the labels are organizing identities:
  // Worker, Organizer, Committee, Campaign lead, Advisor, Admin, Campaign chair.
  // Each hat id is its plane key (src/lib/staffPlanes.js), so the Organizer
  // persona wears the organize plane while holding the organizer role row.
  samplePersonas: Object.freeze([
    Object.freeze({ hat: "member", email: "darnell.foster@example.invalid", firstName: "Darnell", fullName: "Darnell Foster", roles: Object.freeze([]) }),
    Object.freeze({ hat: "organize", email: "elena.cruz@example.invalid", firstName: "Elena", fullName: "Elena Cruz", roles: Object.freeze(["organizer"]) }),
    Object.freeze({ hat: "steward", email: "maya.thompson@example.invalid", firstName: "Maya", fullName: "Maya Thompson", roles: Object.freeze(["steward"]) }),
    Object.freeze({ hat: "coordinator", email: "andre.lewis@example.invalid", firstName: "Andre", fullName: "Andre Lewis", roles: Object.freeze(["coordinator"]) }),
    Object.freeze({ hat: "advisor", email: "priya.shah@example.invalid", firstName: "Priya", fullName: "Priya Shah", roles: Object.freeze(["advisor"]) }),
    Object.freeze({ hat: "admin", email: "rosa.martinez@example.invalid", firstName: "Rosa", fullName: "Rosa Martinez", roles: Object.freeze(["admin"]) }),
    Object.freeze({ hat: "vp", email: "jordan.kim@example.invalid", firstName: "Jordan", fullName: "Jordan Kim", roles: Object.freeze(["vp"]) }),
  ]),
  // The fictional SAMPLE organizations' account domains, mirrored from
  // config/sample-backend.json (sampleAccountEmailDomains), which in turn must
  // equal every emailDomain the bot seed configs name (stress/
  // tamarack-config.json); tests/sample-prod-parity.test.jsx pins all three.
  // Exact domains only, never a wildcard. Signing in as these accounts stays
  // open below the demo entry.
  sampleAccountEmailDomains: Object.freeze(["loadtest.demo.example.com"]),
});

export function sampleBackendContract() {
  return SAMPLE_BACKEND;
}

export function supabaseRefFromOrigin(origin) {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    const match = host.match(/^([a-z0-9]+)\.supabase\.co$/);
    return match?.[1] ?? "";
  } catch {
    return "";
  }
}

export function isForbiddenSampleBackend(originOrRef) {
  const value = String(originOrRef || "").trim().toLowerCase();
  if (!value) return false;
  const pinnedRef = String(SAMPLE_BACKEND.sampleSupabaseRef || "").trim().toLowerCase();
  // With no pinned project every target is refused.
  if (!pinnedRef) return true;
  if (value === pinnedRef) return false;
  const ref = supabaseRefFromOrigin(value);
  // A SAMPLE surface accepts exactly its pinned project. This fail-closed
  // allowlist rejects production, retired, malformed, and unknown targets
  // without embedding any of those project identifiers in the public bundle.
  return ref !== pinnedRef;
}

// Whether an origin (or bare project ref) is the pinned SAMPLE project
// itself, whichever client points at it: a main client configured with the
// SAMPLE URL (the bots' loopback host) is still SAMPLE.
export function isSampleSupabaseProject(originOrRef) {
  const pinnedRef = String(SAMPLE_BACKEND.sampleSupabaseRef || "").trim().toLowerCase();
  if (!pinnedRef) return false;
  const value = String(originOrRef || "").trim().toLowerCase();
  return value === pinnedRef || supabaseRefFromOrigin(value) === pinnedRef;
}

export function pinnedSampleSupabaseOrigin(contract = SAMPLE_BACKEND) {
  const origin = String(contract.sampleSupabaseOrigin || "").trim();
  if (origin) return origin;
  const ref = String(contract.sampleSupabaseRef || "").trim();
  return ref ? `https://${ref}.supabase.co` : "";
}

export function samplePersonas() {
  return SAMPLE_BACKEND.samplePersonas;
}

// The native app names the Organizer hat "organizer" (apps/mobile PreviewHatKey)
// where the web names its plane "organize"; both resolve to the same persona.
const NATIVE_HAT_ALIASES = Object.freeze({ organizer: "organize" });

// Whether a session email belongs to one of the seeded personas. The retired
// preview host loads only those; any other restored session is refused there
// (BUG-UG-REMOVE-RETIRED-PREVIEW-INVITATION-20261020).
export function isSamplePersonaEmail(email) {
  return typeof email === "string" && samplePersonas().some((persona) => persona.email === email);
}

// Whether an email belongs to a fictional SAMPLE organization account. Only
// the exact domain counts: no subdomain, no look-alike suffix.
export function isSampleAccountEmail(email) {
  if (typeof email !== "string") return false;
  const at = email.lastIndexOf("@");
  if (at <= 0) return false;
  return SAMPLE_BACKEND.sampleAccountEmailDomains.includes(email.slice(at + 1));
}

// On the retired preview host a session restored from that host's storage is
// adopted only when it belongs to a seeded persona or a fictional SAMPLE
// organization account; any other session is cleared locally and never
// reaches React state, so no session-keyed effect (shell load, MFA assurance,
// realtime, push, retry timers) can use it
// (BUG-UG-REMOVE-RETIRED-PREVIEW-INVITATION-20261020;
// BUG-UG-DEMO-HOST-SIGNED-OUT-DEAD-END-20261106).
// The named demo host, read the way src/lib/demoOrigin.js's isDemoHost reads
// it (the pinned sample portal and its www. form). Kept here so this module
// does not import demoOrigin.js, which imports SAMPLE_BACKEND from this one:
// that cycle left SAMPLE_BACKEND undefined whenever this module loaded first.
function isNamedDemoHost(hostname) {
  let demoHost;
  try {
    demoHost = new URL(SAMPLE_BACKEND.samplePortalOrigin).hostname.toLowerCase();
  } catch {
    return false; // swallow-ok: no parsable sample portal means no named demo host
  }
  const host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  if (!host || !demoHost) return false;
  return host === demoHost || host === `www.${demoHost}`;
}

export function retiredHostRefusesSession(session, hostname) {
  if (!isNamedDemoHost(hostname) || !session?.user) return false;
  // Decide on the credential, never on the editable user object stored beside
  // it: the access token's own email claim must name a seeded persona or a
  // SAMPLE organization account and equal the stored email. A hand-set token
  // with no readable claim beside an allowed email is refused, so storage
  // alone can never mint a session on this host.
  const claimed = emailFromAccessToken(session.access_token);
  const stored = typeof session.user.email === "string" ? session.user.email.toLowerCase() : null;
  return !claimed || claimed !== stored || !(isSamplePersonaEmail(claimed) || isSampleAccountEmail(claimed));
}

export function samplePersonaForHat(hat) {
  const key = Object.hasOwn(NATIVE_HAT_ALIASES, hat) ? NATIVE_HAT_ALIASES[hat] : hat;
  return SAMPLE_BACKEND.samplePersonas.find((persona) => persona.hat === key) ?? null;
}

// The in-memory harness tour's hat and the demo root's hat before a session
// arrives. The live SAMPLE entry, `Explore the demo`, wears Member instead
// .
export const DEFAULT_SAMPLE_HAT = "member";

export function defaultSamplePersona() {
  return samplePersonaForHat(DEFAULT_SAMPLE_HAT) ?? SAMPLE_BACKEND.samplePersonas[0];
}

export function samplePortalOrigin() {
  return SAMPLE_BACKEND.samplePortalOrigin;
}


// Clears a refused session from the server and this browser without ever
// reading whichever session occupies the client's storage after an await
// (the mutable client sign-out does exactly that, and would revoke a newer
// persona session another tab persisted meanwhile; sessionManagement.js
// documents the hazard). Every step is bound to the refused session: the
// server teardown of its push association runs through a client that carries
// its bearer, the revocation names its own token, and the local clear is the
// lineage compare-and-swap, so a slot that holds another session is left to
// its owner. The refusal already happened in React state, so each step is
// best-effort and a failure never skips the next (gate round 2 on #5285,
// ).
// The result says what actually happened: a revocation that resolves with an
// error (the SDK's admin sign-out reports refusals that way) counts as not
// revoked, and never skips the local clear or reaches for the mutable
// client sign-out.
export async function retireRefusedSession(refused, { prepareSignOut, revokeToken, clearLocally, afterCleared }) {
  try { await prepareSignOut(refused); } catch { /* best effort */ }
  let revoked;
  try { revoked = !(await revokeToken(refused.access_token))?.error; } catch { revoked = false; }
  let cleared;
  try { cleared = (await clearLocally(refused)) === true; } catch { cleared = false; }
  try { await afterCleared(cleared); } catch { /* best effort */ }
  return { cleared, revoked };
}
