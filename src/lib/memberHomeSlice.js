// RETIRED as a render source by
// BUG-UG-WEB-HOME-REPAINTS-PREVIOUS-CHAPTER-AFTER-SWITCH-20261111.
//
// Older builds kept the member's last Home projection, narrowed, in session
// storage and painted it on a cold Home load (PERF-UG-HOME-STALE-WHILE-
// REVALIDATE-20261028). A slice can belong to a chapter the member has since
// left, so Home now waits for fresh data and App only calls
// clearMemberHomeSlice() to erase what an older build left in this tab.
//
// The writer below is no longer called. It stays, unchanged, only because the
// storage disclosure and its source pins (config/telemetry-disclosure-sources.d)
// are published legal surfaces that change only in a legal release
// (content/legal/release-stamp.json); the next release drops this writer, its
// "home-slice" disclosure row and this file together.
//
// Privacy, unchanged: only the allowlisted keys below keep their values, every
// other key keeps only its empty shape, and the slice is bound to one member id.

export const MEMBER_HOME_SLICE_KEY = "ug-member-home-slice:v1";
export const MAX_MEMBER_HOME_SLICE_BYTES = 96 * 1024;

// Projection keys whose values are kept.
export const MEMBER_HOME_SLICE_VALUE_KEYS = Object.freeze(["roles", "rights", "events", "planItems", "rewardsCatalog"]);
// The Home-route keys the retired fill once took from the slice. Unused now;
// declared unchanged because it is part of this file's pinned key source until
// the next legal release removes the file.
export const MEMBER_HOME_SLICE_FILL_KEYS = Object.freeze(["rights", "events", "planItems", "rewardsCatalog"]);
// The member identity line: only these member fields keep their values.
export const MEMBER_HOME_SLICE_MEMBER_FIELDS = Object.freeze([
  "id", "firstName", "fullName", "initials", "roleLine", "sinceYear", "chapterId", "chapterName",
  "organizationId", "membershipStatus", "language", "organizationRoles", "chapterRoles",
]);
// Kept as null rather than an empty shape: an empty reward summary paints a
// real-looking "Tier 0 ·" card on a reloaded Home until the fresh read lands
// (REQ-UG-SINGLE-SIGHTING-DEFECTS-20261030, finding 71). Null hides
// the tier card and points chip until the summary arrives.
export const MEMBER_HOME_SLICE_ABSENT_KEYS = Object.freeze(["rewards"]);
// Never kept, whatever the allowlist above says. A test pins that none of
// these is a value key and that each one is stored empty.
export const MEMBER_HOME_SLICE_NEVER_KEYS = Object.freeze([
  "cases", "caseUpdates", "notifications", "broadcasts", "conversations", "messages", "taskMessages",
  "savedMessages", "messageReminders", "channelReminders", "guideThreads", "forms", "cosignRequests",
  "appointments", "stewardRequests", "peerContact",
]);

function emptyShape(value) {
  if (Array.isArray(value)) return [];
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return "";
  if (typeof value === "number") return 0;
  if (typeof value === "boolean") return false;
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, emptyShape(item)]));
  return null;
}

/**
 * The narrowed slice of one committed Home projection, or null when there is
 * nothing to keep.
 * @param {Record<string, any> | null | undefined} data
 */
export function memberHomeSliceFromProjection(data) {
  if (!data || typeof data !== "object" || typeof data.member?.id !== "string" || !data.member.id) return null;
  const projection = {};
  for (const [key, value] of Object.entries(data)) {
    projection[key] = MEMBER_HOME_SLICE_VALUE_KEYS.includes(key) ? value
      : MEMBER_HOME_SLICE_ABSENT_KEYS.includes(key) ? null
        : emptyShape(value);
  }
  const member = emptyShape(data.member);
  for (const field of MEMBER_HOME_SLICE_MEMBER_FIELDS) if (field in data.member) member[field] = data.member[field];
  projection.member = member;
  return { userId: data.member.id, projection };
}

function storageOrNull(storage) {
  if (storage !== undefined) return storage;
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

/**
 * Keep the slice of this projection. Returns true when it was written.
 * @param {Record<string, any>} data the committed Home projection
 * @param {{ storage?: Storage | null, now?: number }} [options]
 */
export function writeMemberHomeSlice(data, { storage, now = Date.now() } = {}) {
  const store = storageOrNull(storage);
  const slice = memberHomeSliceFromProjection(data);
  if (!store || !slice) return false;
  try {
    const text = JSON.stringify({ ...slice, savedAt: now });
    if (text.length > MAX_MEMBER_HOME_SLICE_BYTES) {
      store.removeItem(MEMBER_HOME_SLICE_KEY);
      return false;
    }
    store.setItem(MEMBER_HOME_SLICE_KEY, text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the slice when the identity changes or the session ends. Passing the
 * incoming member keeps a slice that already belongs to that member.
 * @param {{ storage?: Storage | null, keepUserId?: string | null }} [options]
 */
export function clearMemberHomeSlice({ storage, keepUserId = null } = {}) {
  const store = storageOrNull(storage);
  if (!store) return;
  try {
    if (keepUserId) {
      const slice = JSON.parse(store.getItem(MEMBER_HOME_SLICE_KEY) || "null");
      if (slice?.userId === keepUserId) return;
    }
    store.removeItem(MEMBER_HOME_SLICE_KEY);
  } catch {
    try { store.removeItem(MEMBER_HOME_SLICE_KEY); } catch { /* best-effort */ }
  }
}
