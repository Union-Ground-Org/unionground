// The two looks of the signed-out site:
// "pine", the dark green front door on every signed-out page, and "light", the
// same layout on the paper canvas. They run as a comparison.
//
// The site promises no tracking, and every browser write is listed on the
// telemetry disclosure page, so the look is chosen without one: no cookie, no
// stored value, no identifier. Every visitor sees the same look on a given
// Eastern calendar day and the two looks take alternate days. The comparison
// is read from join requests: the request page sends the look it was showing
// in the request's campaign code (joinCampaignCode below).
//
// `?look=pine` or `?look=light` shows one look on that page load, for review.
const SITE_LOOKS = Object.freeze(["pine", "light"]);

const DAY_MS = 86_400_000;
const EASTERN_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

/** Whole days from January 1, 1970 to the Eastern calendar date of `now`. */
function easternDayNumber(now = new Date()) {
  const [year, month, day] = EASTERN_DATE.format(now).split("-").map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

function siteLookForDay(now) {
  return SITE_LOOKS[easternDayNumber(now) % SITE_LOOKS.length];
}

function forcedSiteLook(search) {
  const value = new URLSearchParams(search).get("look");
  return SITE_LOOKS.includes(value) ? value : null;
}

/**
 * Marks the document with the look, for the stylesheets
 * (`:root[data-site-look="pine"]`), and returns it.
 */
export function applySiteLook({ root = globalThis.document?.documentElement, search = globalThis.location?.search ?? "", now = new Date() } = {}) {
  const look = forcedSiteLook(search) ?? siteLookForDay(now);
  if (root) root.dataset.siteLook = look;
  return look;
}

/** The look this page load is showing, or null when the document carries none. */
export function shownSiteLook(root = globalThis.document?.documentElement) {
  const look = root?.dataset?.siteLook;
  return SITE_LOOKS.includes(look) ? look : null;
}

// The campaign code a join request carries. A code a visitor arrived with from
// outside (a QR code, a link in a message) is sent as it came; the site's own
// "invite" link and a visit with no code name the look.
export function joinCampaignCode(code, look) {
  if (!SITE_LOOKS.includes(look)) return code;
  if (code === "") return `look-${look}`;
  if (code === "invite") return `invite-${look}`;
  return code;
}
