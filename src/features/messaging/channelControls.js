// Chapter channel controls, shared by responsive web and the Expo app
// (REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001, the "Messaging channel
// controls contract"). The database is the authority: every write goes through
// a SECURITY DEFINER RPC and notifications are produced server-side. This
// module only mirrors those rules so both clients show the same controls,
// highlights and explanations.
//
// Matching rules come from the old app (de7df4b57c^):
//   lib/messages/here-mention.ts       standalone @here token
//   lib/messages/keyword-highlight.ts  case-insensitive whole-word keywords

/** @typedef {"all" | "mentions" | "none"} ChannelNotificationLevel */
/** @typedef {"mention" | "here" | "keyword" | "post"} ChannelAlertReason */
/**
 * @typedef {{
 *   spaceId?: string,
 *   level?: ChannelNotificationLevel,
 *   muted?: boolean,
 *   mutedUntil?: string | null,
 *   muteActive?: boolean,
 *   keywords?: string[],
 * }} ChannelSetting
 */
/**
 * @typedef {{
 *   channelPinning: boolean,
 *   notificationLevels: boolean,
 *   channelMute: boolean,
 *   mentions: boolean,
 *   hereMentions: boolean,
 *   mentionSearch: boolean,
 *   keywordAlerts: boolean,
 * }} ChannelControlSwitches
 */
/**
 * @typedef {{
 *   available: boolean,
 *   organizationId: string | null,
 *   switches: ChannelControlSwitches,
 *   keywordLimit: number,
 *   keywordCount: number,
 *   canPin: boolean,
 *   spaces: Record<string, ChannelSetting>,
 * }} ChannelControls
 */

/** @type {ReadonlyArray<ChannelNotificationLevel>} */
export const CHANNEL_NOTIFICATION_LEVELS = Object.freeze(["all", "mentions", "none"]);
const DEFAULT_CHANNEL_LEVEL = "mentions";
const MAX_KEYWORDS_PER_CHANNEL = 20;
const KEYWORD_MIN_LENGTH = 2;
const KEYWORD_MAX_LENGTH = 48;
const MAX_MENTIONS_PER_POST = 20;

/** Mute lengths both clients offer. `null` hours = until the member unmutes. */
export const CHANNEL_MUTE_DURATIONS = Object.freeze([
  Object.freeze({ id: "1h", hours: 1 }),
  Object.freeze({ id: "8h", hours: 8 }),
  Object.freeze({ id: "24h", hours: 24 }),
  Object.freeze({ id: "7d", hours: 24 * 7 }),
  Object.freeze({ id: "forever", hours: null }),
]);

/** @type {ChannelControlSwitches} */
const ALL_OFF = Object.freeze({
  channelPinning: false,
  notificationLevels: false,
  channelMute: false,
  mentions: false,
  hereMentions: false,
  mentionSearch: false,
  keywordAlerts: false,
});

/** @type {ChannelControls} */
export const UNAVAILABLE_CHANNEL_CONTROLS = Object.freeze({
  available: false,
  organizationId: null,
  switches: ALL_OFF,
  keywordLimit: 0,
  keywordCount: 0,
  canPin: false,
  spaces: {},
});

/**
 * The server answer, defended: a missing or malformed field reads as "off".
 * @param {unknown} raw
 * @returns {ChannelControls}
 */
export function normalizeChannelControls(raw) {
  if (!raw || typeof raw !== "object") return UNAVAILABLE_CHANNEL_CONTROLS;
  const value = /** @type {Record<string, any>} */ (raw);
  const switches = /** @type {Record<string, unknown>} */ (value.switches && typeof value.switches === "object" ? value.switches : {});
  /** @type {ChannelControlSwitches} */
  const clean = { ...ALL_OFF };
  for (const key of /** @type {Array<keyof ChannelControlSwitches>} */ (Object.keys(ALL_OFF))) clean[key] = switches[key] === true;
  /** @type {Record<string, ChannelSetting>} */
  const spaces = {};
  if (value.spaces && typeof value.spaces === "object") {
    for (const [spaceId, setting] of Object.entries(value.spaces)) spaces[spaceId] = normalizeChannelSetting(setting, spaceId);
  }
  return {
    available: value.available === true,
    organizationId: typeof value.organizationId === "string" ? value.organizationId : null,
    switches: clean,
    keywordLimit: Number.isInteger(value.keywordLimit) ? value.keywordLimit : 0,
    keywordCount: Number.isInteger(value.keywordCount) ? value.keywordCount : 0,
    canPin: value.canPin === true,
    spaces,
  };
}

/**
 * @param {unknown} raw
 * @param {string} [spaceId]
 * @returns {Required<ChannelSetting>}
 */
export function normalizeChannelSetting(raw, spaceId = "") {
  const value = /** @type {Record<string, any>} */ (raw && typeof raw === "object" ? raw : {});
  const level = CHANNEL_NOTIFICATION_LEVELS.includes(value.level) ? value.level : DEFAULT_CHANNEL_LEVEL;
  const muted = value.muted === true;
  const mutedUntil = muted && typeof value.mutedUntil === "string" ? value.mutedUntil : null;
  return {
    spaceId: typeof value.spaceId === "string" ? value.spaceId : spaceId,
    level,
    muted,
    mutedUntil,
    muteActive: muted && value.muteActive !== false,
    keywords: Array.isArray(value.keywords) ? value.keywords.filter((keyword) => typeof keyword === "string") : [],
  };
}

/**
 * @param {ChannelControls} controls
 * @param {string} spaceId
 */
export function channelSettingFor(controls, spaceId) {
  return normalizeChannelSetting(controls?.spaces?.[spaceId], spaceId);
}

/**
 * @param {ChannelSetting | null | undefined} setting
 * @param {Date} [now]
 */
export function isMuteActive(setting, now = new Date()) {
  if (!setting?.muted) return false;
  if (!setting.mutedUntil) return true;
  const until = new Date(setting.mutedUntil).getTime();
  return Number.isFinite(until) && until > now.getTime();
}

/**
 * The instant a chosen mute length ends, or null for "until I unmute".
 * @param {string} durationId
 * @param {Date} [now]
 * @returns {string | null}
 */
export function muteUntilFor(durationId, now = new Date()) {
  const choice = CHANNEL_MUTE_DURATIONS.find((item) => item.id === durationId);
  if (!choice) throw new Error(`unknown mute duration ${durationId}`);
  if (choice.hours === null) return null;
  return new Date(now.getTime() + choice.hours * 3_600_000).toISOString();
}

// ---------------------------------------------------------------- matching

// (?<![A-Za-z0-9_@])@here(?![A-Za-z0-9_]) — the old pattern, case-insensitive.
const HERE_PATTERN = /(?<![A-Za-z0-9_@])@here(?![A-Za-z0-9_])/i;

/** @param {string | null | undefined} body */
export function containsHereMention(body) {
  return typeof body === "string" && HERE_PATTERN.test(body);
}

/** @param {string} value */
function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Trimmed, lowercase, de-duplicated, in the member's order. Blanks dropped.
 * @param {ReadonlyArray<unknown>} values
 * @returns {string[]}
 */
export function normalizeKeywords(values) {
  /** @type {string[]} */
  const out = [];
  for (const value of values || []) {
    if (typeof value !== "string") continue;
    const keyword = value.trim().toLowerCase();
    if (!keyword || out.includes(keyword)) continue;
    out.push(keyword);
  }
  return out;
}

/**
 * Why a keyword list cannot be saved, or null when it can.
 * @param {ReadonlyArray<string>} keywords normalized keywords
 * @param {{ elsewhere?: number, limit?: number }} [budget]
 * @returns {null | "length" | "per-channel" | "limit"}
 */
export function keywordListProblem(keywords, { elsewhere = 0, limit = Infinity } = {}) {
  if (keywords.some((keyword) => keyword.length < KEYWORD_MIN_LENGTH || keyword.length > KEYWORD_MAX_LENGTH || hasControlCharacter(keyword))) return "length";
  if (keywords.length > MAX_KEYWORDS_PER_CHANNEL) return "per-channel";
  if (elsewhere + keywords.length > limit) return "limit";
  return null;
}

/** @param {ReadonlyArray<string>} keywords */
function keywordPattern(keywords) {
  const cleaned = normalizeKeywords(keywords);
  if (cleaned.length === 0) return null;
  const alternation = [...cleaned].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  return new RegExp(`(?<![A-Za-z0-9_])(?:${alternation})(?![A-Za-z0-9_])`, "gi");
}

/**
 * The keywords that occur in `body` as whole words, in the caller's order.
 * @param {string} body
 * @param {ReadonlyArray<string>} keywords
 */
export function findKeywordMatches(body, keywords) {
  if (!body) return [];
  return normalizeKeywords(keywords).filter((keyword) => {
    const pattern = keywordPattern([keyword]);
    return pattern !== null && pattern.test(body);
  });
}

/** @typedef {{ text: string, highlight: null | "keyword" | "here" }} HighlightSegment */

/**
 * Splits a post body for rendering: keyword hits and a standalone @here are
 * marked; everything else is plain text. Never changes the text itself.
 * @param {string} text
 * @param {{ keywords?: ReadonlyArray<string>, here?: boolean }} [options]
 * @returns {HighlightSegment[]}
 */
export function segmentChannelText(text, { keywords = [], here = false } = {}) {
  if (!text) return [];
  const parts = [];
  const keywordRe = keywordPattern(keywords);
  if (keywordRe) parts.push(keywordRe.source);
  if (here) parts.push(`(?<![A-Za-z0-9_@])@here(?![A-Za-z0-9_])`);
  if (parts.length === 0) return [{ text, highlight: null }];
  const pattern = new RegExp(parts.map((source) => `(?:${source})`).join("|"), "gi");
  /** @type {HighlightSegment[]} */
  const segments = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ text: text.slice(last, index), highlight: null });
    segments.push({ text: match[0], highlight: match[0].toLowerCase() === "@here" && here ? "here" : "keyword" });
    last = index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), highlight: null });
  return segments;
}

// ---------------------------------------------------------------- precedence

/**
 * The deterministic precedence private.channel_alert_decision applies, in the
 * same order. Exported as data so the settings surfaces and the contract test
 * read one table.
 */
export const CHANNEL_ALERT_PRECEDENCE = Object.freeze([
  Object.freeze({ order: 1, check: "recipient can no longer read the channel", result: "dropped" }),
  Object.freeze({ order: 2, check: "the reason's organization switch is off", result: "switch_off" }),
  Object.freeze({ order: 3, check: "channel mute is active for a reason other than a direct mention", result: "muted" }),
  Object.freeze({ order: 4, check: "level is nothing", result: "level_none" }),
  Object.freeze({ order: 5, check: "level is mentions and the reason is a plain post", result: "level_mentions" }),
  Object.freeze({ order: 6, check: "otherwise", result: "deliver" }),
]);

/** Notices a channel setting can never silence. */
export const CHANNEL_MUTE_NEVER_SILENCES = Object.freeze(["direct", "task", "announcement", "urgent"]);

/**
 * Mirror of private.channel_alert_decision for one recipient who can read the
 * channel.
 * @param {{ switches: ChannelControlSwitches, setting?: ChannelSetting | null, reason: ChannelAlertReason, now?: Date }} input
 * @returns {"switch_off" | "muted" | "level_none" | "level_mentions" | "deliver"}
 */
export function channelAlertDecision({ switches, setting = null, reason, now = new Date() }) {
  const reasonOn = reason === "mention" ? switches.mentions
    : reason === "here" ? switches.hereMentions
      : reason === "keyword" ? switches.keywordAlerts
        : switches.notificationLevels;
  if (!reasonOn) return "switch_off";
  if (reason !== "mention" && switches.channelMute && isMuteActive(setting, now)) return "muted";
  const level = switches.notificationLevels ? (setting?.level || DEFAULT_CHANNEL_LEVEL) : DEFAULT_CHANNEL_LEVEL;
  if (level === "none") return "level_none";
  if (level === "mentions" && reason === "post") return "level_mentions";
  return "deliver";
}

// ---------------------------------------------------------------- pinning

/**
 * Pinned threads first (most recently pinned on top), then the existing
 * order. Stable for everything unpinned. Ignores pins when the switch is off.
 * @template {{ pinned_at?: string | null }} T
 * @param {ReadonlyArray<T>} threads
 * @param {boolean} [pinningOn]
 * @returns {T[]}
 */
export function orderThreadsForChannel(threads, pinningOn = true) {
  const list = [...(threads || [])];
  if (!pinningOn) return list;
  const pinned = list.filter((thread) => thread.pinned_at)
    .sort((a, b) => String(b.pinned_at).localeCompare(String(a.pinned_at)));
  return [...pinned, ...list.filter((thread) => !thread.pinned_at)];
}

/**
 * The "@Name " text a picked mention inserts into a draft.
 * @param {string} draft
 * @param {{ name: string }} person
 */
export function appendMentionText(draft, person) {
  const name = String(person?.name || "").trim();
  if (!name) return draft;
  const token = `@${name} `;
  if (!draft) return token;
  return /\s$/.test(draft) ? `${draft}${token}` : `${draft} ${token}`;
}

/**
 * Mentions to send: picked people whose @Name is still in the draft, at most
 * MAX_MENTIONS_PER_POST. The server sanitizes again.
 *
 * A name that prefixes a longer picked name ("Ana" and "Ana Diaz") must not
 * count when the only "@Ana" left is the front of "@Ana Diaz": names are
 * matched longest first and each matched token is consumed, so a shorter name
 * counts only if a separate token for it remains. Picked order decides which
 * mentions survive the cap, whatever order the tokens were written in.
 * @param {string} body
 * @param {ReadonlyArray<{ id: string, name: string }>} picked
 */
export function mentionIdsForBody(body, picked) {
  let text = String(body || "");
  const idsByName = new Map();
  for (const person of picked || []) {
    if (!person?.id) continue;
    const name = String(person.name || "").trim();
    if (!name) continue;
    if (!idsByName.has(name)) idsByName.set(name, new Set());
    idsByName.get(name).add(person.id);
  }
  const named = new Set();
  const longestFirst = [...idsByName.keys()].sort((a, b) => b.length - a.length);
  for (const name of longestFirst) {
    const token = new RegExp(`(?<![\\p{L}\\p{N}_@])@${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, "gu");
    let found = false;
    // Consume the matched token so a shorter name cannot match inside it. The
    // stand-in is a letter, so the boundaries around it read as they did before.
    text = text.replace(token, (match) => { found = true; return "a".repeat(match.length); });
    if (found) for (const id of idsByName.get(name)) named.add(id);
  }
  const ids = [];
  for (const person of picked || []) {
    if (!named.has(person?.id) || ids.includes(person.id)) continue;
    ids.push(person.id);
    if (ids.length === MAX_MENTIONS_PER_POST) break;
  }
  return ids;
}

/** @param {unknown} error */
export function isChannelControlDisabled(error) {
  const value = /** @type {Record<string, unknown> | null} */ (error && typeof error === "object" ? error : null);
  return Boolean(value && value.code === "42501" && value.details === "feature-disabled");
}

/** @param {unknown} error */
export function isKeywordLimitError(error) {
  const value = /** @type {Record<string, unknown> | null} */ (error && typeof error === "object" ? error : null);
  return Boolean(value && value.details === "keyword-limit");
}
