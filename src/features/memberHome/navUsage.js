// REQ-UG-USAGE-BASED-NAVIGATION-20261001.
//
// The old app ranked each member's navigation by what they actually used
// (de7df4b57c^:lib/dashboard/nav-usage.ts): visits in the last 30 days, a
// recency weight of 4 (<= 7 days), 2 (<= 14 days) or 1 (<= 30 days) times a
// per-destination base weight (cases 3, resources 1, everything else 2). The
// top four became a "Primary" group and the bottom navigation was reordered;
// pinned ("sticky") destinations always came first.
//
// The old ranking was computed from server page-view rows. This restoration
// keeps the ranking ON THE DEVICE ONLY: visits are counted per calendar day in
// local storage (web localStorage, native secure storage) under the member and
// organization, and nothing about them is ever sent to the server. Manual pins
// win, the member can reset the history, and the organization switch turns the
// whole behaviour off (and stops recording).
//
// Pure functions; native imports this module through a typed seam.

export const NAV_USAGE_SWITCH = "features.home.usage_based_navigation";
const NAV_USAGE_WINDOW_DAYS = 30;
const NAV_USAGE_PRIMARY_LIMIT = 4;
// Bounded storage: at most this many destinations, each with at most one entry
// per day inside the window.
const NAV_USAGE_MAX_DESTINATIONS = 40;

const DAY_MS = 86_400_000;
const KEY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/i;

// Old BASE_CLICK_WEIGHT (nav-usage.ts): grievance/case surfaces 3, resources 1,
// default 2. Current destination keys for the same surfaces.
const BASE_WEIGHT = Object.freeze({
  cases: 3,
  case: 3,
  rights: 1,
  resources: 1,
});
const DEFAULT_BASE_WEIGHT = 2;

export function navUsageStorageKey(userId, organizationId) {
  if (typeof userId !== "string" || !userId) return null;
  return `ug-nav-usage:v1:${userId}:${typeof organizationId === "string" && organizationId ? organizationId : "none"}`;
}

// Local calendar day number (days since the epoch in the member's zone).
export function navUsageDay(now = new Date()) {
  return Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / DAY_MS);
}

/** @typedef {{ version: 1, visits: Record<string, Record<string, number>> }} NavUsageState */
/** @typedef {{ key: string, weight: number }} NavUsageWeight */

/** @returns {NavUsageState} */
export function emptyNavUsage() {
  return { version: 1, visits: {} };
}

// Accepts whatever storage returned; anything malformed becomes empty rather
// than throwing at boot.
/**
 * @param {unknown} raw
 * @returns {NavUsageState}
 */
export function parseNavUsage(raw) {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return emptyNavUsage(); }
  }
  if (!value || typeof value !== "object" || value.version !== 1 || !value.visits || typeof value.visits !== "object") return emptyNavUsage();
  const visits = {};
  for (const [key, days] of Object.entries(value.visits)) {
    if (!KEY_PATTERN.test(key) || !days || typeof days !== "object") continue;
    const clean = {};
    for (const [day, count] of Object.entries(days)) {
      if (/^\d{1,6}$/.test(day) && Number.isInteger(count) && count > 0) clean[day] = Math.min(count, 1000);
    }
    if (Object.keys(clean).length) visits[key] = clean;
  }
  return { version: 1, visits };
}

function prune(visits, today, maxDestinations, maxDaysPerKey) {
  const floor = today - NAV_USAGE_WINDOW_DAYS - 1;
  const next = {};
  for (const [key, days] of Object.entries(visits)) {
    const kept = Object.entries(days)
      // A day "after" today (the device clock moved back) is kept and counts
      // as just used, like the old code's future-dated rows.
      .filter(([day]) => Number(day) > floor)
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .slice(0, maxDaysPerKey);
    if (kept.length) next[key] = Object.fromEntries(kept);
  }
  // Keep the most recently used destinations if the bound is ever reached.
  const keys = Object.keys(next);
  if (keys.length <= maxDestinations) return next;
  const latest = (key) => Math.max(...Object.keys(next[key]).map(Number));
  return Object.fromEntries(keys.sort((a, b) => latest(b) - latest(a)).slice(0, maxDestinations).map((key) => [key, next[key]]));
}

// Small stores (native secure storage) pass tighter bounds; the defaults keep
// every day inside the window.
/**
 * @param {unknown} usage
 * @param {string} key
 * @param {Date} [now]
 * @param {{ maxDestinations?: number, maxDaysPerKey?: number }} [bounds]
 * @returns {NavUsageState}
 */
export function recordNavVisit(usage, key, now = new Date(), { maxDestinations = NAV_USAGE_MAX_DESTINATIONS, maxDaysPerKey = NAV_USAGE_WINDOW_DAYS + 1 } = {}) {
  const state = parseNavUsage(usage);
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) return state;
  const today = navUsageDay(now);
  const days = { ...(state.visits[key] ?? {}) };
  days[today] = Math.min((days[today] ?? 0) + 1, 1000);
  return { version: 1, visits: prune({ ...state.visits, [key]: days }, today, maxDestinations, maxDaysPerKey) };
}

function recencyWeight(ageDays) {
  if (ageDays < 0) return 4; // clock skew: treat as just used, as the old code did
  if (ageDays > NAV_USAGE_WINDOW_DAYS) return 0;
  if (ageDays <= 7) return 4;
  if (ageDays <= 14) return 2;
  return 1;
}

// [{ key, weight }] highest first; ties break alphabetically like the old code.
/**
 * @param {unknown} usage
 * @param {Date} [now]
 * @returns {NavUsageWeight[]}
 */
export function computeNavWeights(usage, now = new Date()) {
  const state = parseNavUsage(usage);
  const today = navUsageDay(now);
  const rows = [];
  for (const [key, days] of Object.entries(state.visits)) {
    let score = 0;
    for (const [day, count] of Object.entries(days)) score += recencyWeight(today - Number(day)) * count;
    const weight = score * (BASE_WEIGHT[key] ?? DEFAULT_BASE_WEIGHT);
    if (weight > 0) rows.push({ key, weight });
  }
  return rows.sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
}

// The "Primary" group: the most-used destinations the member can reach, never
// one they pinned themselves (pins already have their own place and always
// win) and never Home (Home is always first).
/**
 * @param {ReadonlyArray<NavUsageWeight> | null | undefined} weights
 * @param {{ allowed?: ReadonlyArray<string> | null, pinned?: ReadonlyArray<string>, exclude?: ReadonlyArray<string>, limit?: number }} [options]
 * @returns {string[]}
 */
export function primaryNavKeys(weights, { allowed = null, pinned = [], exclude = ["today"], limit = NAV_USAGE_PRIMARY_LIMIT } = {}) {
  const skip = new Set([...(pinned ?? []), ...(exclude ?? [])]);
  const allow = allowed ? new Set(allowed) : null;
  const keys = [];
  for (const { key } of weights ?? []) {
    if (keys.length >= limit) break;
    if (skip.has(key) || (allow && !allow.has(key))) continue;
    keys.push(key);
  }
  return keys;
}

// A navigation strip's order (old personalizeBottomNavItems): pinned first,
// then by usage, then by original position. `keepFirst` holds the leading
// item (Home) in place so the way back never moves.
/**
 * @template T
 * @param {ReadonlyArray<T>} items
 * @param {ReadonlyArray<NavUsageWeight> | null | undefined} weights
 * @param {{ pinned?: ReadonlyArray<string>, keyOf?: (item: any) => string, keepFirst?: boolean }} [options]
 * @returns {T[]}
 */
export function personalizeNavOrder(items, weights, { pinned = [], keyOf = (item) => item.key, keepFirst = true } = {}) {
  if (!Array.isArray(items) || items.length < 2) return items;
  const weightOf = new Map((weights ?? []).map((row) => [row.key, row.weight]));
  const sticky = new Set(pinned ?? []);
  const head = keepFirst ? items.slice(0, 1) : [];
  const rest = keepFirst ? items.slice(1) : items;
  const ordered = rest
    .map((item, index) => ({ item, index, key: keyOf(item) }))
    .sort((a, b) => (
      Number(sticky.has(b.key)) - Number(sticky.has(a.key))
      || (weightOf.get(b.key) ?? 0) - (weightOf.get(a.key) ?? 0)
      || a.index - b.index
    ))
    .map((entry) => entry.item);
  return [...head, ...ordered];
}

// The old personalizeNavGroups: the top destinations MOVE into a leading
// "Primary" group (so every link keeps one accessible name), pinned
// destinations never move, and nothing changes until there is usage.
export function personalizeNavGroups(groups, weights, {
  pinned = [], exclude = ["today"], limit = NAV_USAGE_PRIMARY_LIMIT, keyOf = (item) => item.viewKey ?? item.key,
  primary = { key: "most-used", labelKey: "navUsage.groupTitle" },
} = {}) {
  if (!Array.isArray(groups)) return groups;
  const reachable = groups.flatMap((group) => (group.items ?? []).filter((item) => item && !item.action).map(keyOf));
  const keys = primaryNavKeys(weights, { allowed: reachable, pinned, exclude, limit });
  if (keys.length === 0) return groups;
  const chosen = new Set(keys);
  const items = [];
  for (const key of keys) {
    for (const group of groups) {
      const item = (group.items ?? []).find((entry) => entry && !entry.action && keyOf(entry) === key);
      if (item) { items.push(item); break; }
    }
  }
  const rest = groups
    .map((group) => ({ ...group, items: (group.items ?? []).filter((item) => !item || item.action || !chosen.has(keyOf(item))) }))
    .filter((group) => group.items.length > 0);
  return [{ ...primary, items }, ...rest];
}

// REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030 (finding 89): the
// member's own pins for the side menu. Stored exactly like the ranking (this
// device only, under the member and organization, never sent to the server),
// in a key of its own so "Reset most used" forgets the counts but not the
// pins. Pinned destinations lead the menu in the order they were pinned and
// never count against the most-used four.
export const NAV_PINS_MAX = 8;

export function navPinsStorageKey(userId, organizationId) {
  if (typeof userId !== "string" || !userId) return null;
  return `ug-nav-pins:v1:${userId}:${typeof organizationId === "string" && organizationId ? organizationId : "none"}`;
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseNavPins(raw) {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return []; }
  }
  const keys = value && typeof value === "object" && value.version === 1 && Array.isArray(value.pins) ? value.pins : [];
  return [...new Set(keys.filter((key) => typeof key === "string" && KEY_PATTERN.test(key) && key !== "today"))].slice(0, NAV_PINS_MAX);
}

export function serializeNavPins(pins) {
  return JSON.stringify({ version: 1, pins: parseNavPins({ version: 1, pins }) });
}

// Pin or unpin one destination. A new pin goes last; at the limit the pin is
// refused (the list comes back unchanged) rather than dropping an older one.
export function toggleNavPin(pins, key) {
  const current = parseNavPins({ version: 1, pins });
  if (typeof key !== "string" || !KEY_PATTERN.test(key) || key === "today") return current;
  if (current.includes(key)) return current.filter((entry) => entry !== key);
  if (current.length >= NAV_PINS_MAX) return current;
  return [...current, key];
}

// The pinned destinations, in pin order, from the menu's own items (an item
// is matched by viewKey ?? key, like the ranking). Unknown pins are skipped.
export function pinnedNavItems(items, pins, { keyOf = (item) => item.viewKey ?? item.key } = {}) {
  const list = (items ?? []).filter((item) => item && !item.action);
  const out = [];
  for (const pin of parseNavPins({ version: 1, pins })) {
    const item = list.find((entry) => entry.key === pin || keyOf(entry) === pin);
    if (item && !out.includes(item)) out.push(item);
  }
  return out;
}

// Every stored pin list for one account on this device, for sign-out only:
// "Reset most used" keeps pins (REQ-UG-NAVIGATION-PINNED-SHORTCUTS-20261030).
export function navPinsKeysForUser(storageKeys, userId) {
  if (typeof userId !== "string" || !userId) return [];
  const prefix = `ug-nav-pins:v1:${userId}:`;
  return (storageKeys ?? []).filter((key) => typeof key === "string" && key.startsWith(prefix));
}

// Every stored ranking for one account on this device, for sign-out and reset.
export function navUsageKeysForUser(storageKeys, userId) {
  if (typeof userId !== "string" || !userId) return [];
  const prefix = `ug-nav-usage:v1:${userId}:`;
  return (storageKeys ?? []).filter((key) => typeof key === "string" && key.startsWith(prefix));
}
