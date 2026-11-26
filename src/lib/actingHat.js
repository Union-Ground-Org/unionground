import { STAFF_PLANES, STAFF_TOOL_ROLES } from "./staffPlanes.js";
import { CHAPTER_OFFICE_ROLES } from "./chapterOfficeRoles.js";

// REQ-UG-TYPED-ADDRESS-ROLE-DESK-BOUNCE-20261030: the hat a person
// last chose ("Act as … here", a desk entrance, the switcher) is kept for the
// browser tab's session, so a typed address or a reload opens in that hat
// instead of starting over as Member. The stored hat is only a preference:
// App still wears it only while the live role projection holds that role, and
// it is bound to the account that chose it.
export const ACTING_HAT_STORAGE_KEY = "ug.actingHat";

const HATS = new Set(["member", ...STAFF_TOOL_ROLES, ...CHAPTER_OFFICE_ROLES]);

function sessionStore() {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readActingHat(storage = sessionStore()) {
  try {
    const parsed = JSON.parse(storage?.getItem(ACTING_HAT_STORAGE_KEY) ?? "null");
    if (!parsed || typeof parsed.userId !== "string" || !parsed.userId || !HATS.has(parsed.hat)) return null;
    return { userId: parsed.userId, hat: parsed.hat };
  } catch {
    return null;
  }
}

export function writeActingHat(userId, hat, storage = sessionStore()) {
  if (typeof userId !== "string" || !userId || !HATS.has(hat)) return;
  try {
    storage?.setItem(ACTING_HAT_STORAGE_KEY, JSON.stringify({ userId, hat }));
  } catch {
    // Storage full or blocked: the hat still holds for this page.
  }
}

export function clearActingHat(storage = sessionStore()) {
  try {
    storage?.removeItem(ACTING_HAT_STORAGE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

// The hat a typed or reloaded address opens in when the worn hat cannot open
// it: Member when Member opens it (a member page is a request to wear Member),
// otherwise the desk plane's own role when the account holds it. Shared staff
// tools never choose a hat here: they open only under an explicitly worn
// staff hat (AGENTS.md, desktop rail contract). Null means the caller refuses.
export function entryHatForView(roles, view, allowsView) {
  if (allowsView("member")) return "member";
  const plane = STAFF_PLANES.find((entry) => entry.view === view);
  return plane && roles.includes(plane.key) && allowsView(plane.key) ? plane.key : null;
}
