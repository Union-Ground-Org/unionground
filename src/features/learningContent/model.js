// Governed quotes and mini-lessons: the pure contract shared by the web client
// and the native iPhone/Android app (REQ-UG-QUOTES-MINI-LESSONS-20260928).
//
// This module holds no React, no DOM, no storage and no network. It must stay
// importable from Metro, so it never reaches src/lib/i18n.js or a Supabase
// client. The server (supabase/migrations/*_governed_learning_content.sql) is
// the authority; everything here mirrors its rules so a client refuses what
// the server would refuse and never shows what the server would not deliver.
//
// Lengths are Unicode code points, measured after String.prototype.trim(),
// which is also what buildLearningItemPayload sends. The server's
// learning_trim removes exactly the whitespace JavaScript's trim() removes.

export const LEARNING_KINDS = Object.freeze(["quote", "mini_lesson"]);
export const LEARNING_LOCALES = Object.freeze(["en", "es"]);
export const LEARNING_LOCALE_STATES = Object.freeze(["draft", "reviewed"]);
export const LEARNING_STATUSES = Object.freeze(["draft", "published", "scheduled", "withdrawn"]);
export const LEARNING_SCOPES = Object.freeze(["platform", "organization", "chapter"]);
export const LEARNING_AUDIENCES = Object.freeze(["all", "members", "staff"]);
export const LEARNING_TRANSITIONS = Object.freeze(["publish", "schedule", "withdraw"]);
// Audit actions get_learning_history reports for an item. recover_draft is
// the first revision of an item imported from recovered donor material.
// public_provenance: the platform explainer rows whose public source details were
// filled in (20261111103000; UX-UG-LEARNING-CONTENT-HISTORY-POLISH-BATCH-20261115).
export const LEARNING_HISTORY_ACTIONS = Object.freeze(["recover_draft", "save_draft", "publish", "schedule", "withdraw", "public_provenance"]);

export const LEARNING_LIMITS = Object.freeze({
  title: 100,
  body: Object.freeze({ quote: 500, mini_lesson: 2000 }),
  bulletCount: 5,
  bullet: 200,
  topicCount: 5,
  topic: 80,
  attribution: 200,
  source: 1000,
  rights_note: 1000,
  review_note: 1000,
  direction: 1000,
  tone: 100,
  learning_outcome: 500,
  priorityMin: 0,
  priorityMax: 100,
  // octet_length(payload::text) in the server's learning_payload_valid. The
  // field limits keep every valid payload well below it; it stays as a guard.
  payloadBytes: 64000,
  // save_learning_policy refuses a larger selection.
  selectedIds: 500,
});

// Home reads one bounded batch; Learn, the workspace and history page by 40.
export const LEARNING_PAGE_SIZE = Object.freeze({ home: 100, learn: 40, workspace: 40, history: 40 });
// The server refuses an offset beyond this.
export const LEARNING_MAX_OFFSET = 10000;
// Clients poll only the lightweight policy, never content.
export const LEARNING_POLICY_POLL_MS = 60000;
// The server's default when a save omits priority; new drafts start here too.
export const LEARNING_DEFAULT_PRIORITY = 0;

// Exactly the keys save_learning_content accepts in p_item (plus an optional
// id). Ownership, status, dates, revision and provenance are never editable.
export const LEARNING_EDITABLE_FIELDS = Object.freeze([
  "kind", "locale", "locale_state", "title", "body", "attribution", "source",
  "rights_note", "review_note", "bullets", "direction", "topics", "audience",
  "tone", "learning_outcome", "factual_claims", "priority", "is_default",
]);

// Optional plain-text fields and their limits, in editor order.
export const LEARNING_TEXT_LIMITS = Object.freeze({
  attribution: LEARNING_LIMITS.attribution,
  source: LEARNING_LIMITS.source,
  rights_note: LEARNING_LIMITS.rights_note,
  review_note: LEARNING_LIMITS.review_note,
  direction: LEARNING_LIMITS.direction,
  tone: LEARNING_LIMITS.tone,
  learning_outcome: LEARNING_LIMITS.learning_outcome,
});

const TEXT_FIELDS = Object.keys(LEARNING_TEXT_LIMITS);
const ITEM_STRING_FIELDS = ["title", "body", ...TEXT_FIELDS];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringOr(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function nullableId(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

// ---------------------------------------------------------------------------
// Lengths and limits
// ---------------------------------------------------------------------------

export function codePointLength(value) {
  if (typeof value !== "string") return 0;
  let count = 0;
  // for...of walks code points, so a surrogate pair counts once.
  for (const _codePoint of value) count += 1;
  return count;
}

export function learningBodyLimit(kind) {
  return LEARNING_LIMITS.body[kind] ?? null;
}

function utf8Length(text) {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0);
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}

// Byte length of the payload as PostgreSQL prints jsonb text: JSON with a
// space after every ":" and ",". The id is not part of the stored payload.
export function learningPayloadBytes(payload) {
  if (!isPlainObject(payload)) return 0;
  const { id: _id, ...stored } = payload;
  const compact = JSON.stringify(stored);
  if (typeof compact !== "string") return 0;
  let separators = 0;
  for (const value of Object.values(stored)) {
    if (Array.isArray(value) && value.length > 1) separators += value.length - 1;
  }
  const entries = Object.keys(stored).length;
  return utf8Length(compact) + entries + Math.max(0, entries - 1) + separators;
}

// ---------------------------------------------------------------------------
// Instants
// ---------------------------------------------------------------------------

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)$/i;

// A timestamptz as the server prints it ("2026-09-28T23:30:00.123456+00:00"),
// parsed identically on every JavaScript engine. A string without an explicit
// zone is ambiguous and fails closed (null).
export function parseLearningInstant(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value !== "string") return null;
  const match = ISO_INSTANT.exec(value.trim());
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = "0", fraction = "", zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCDate() !== day || calendar.getUTCMonth() !== month - 1) return null;
  let offsetMinutes = 0;
  if (zone.toUpperCase() !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    const offsetHours = Number(digits.slice(0, 2));
    const offsetRest = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
    if (offsetHours > 23 || offsetRest > 59) return null;
    offsetMinutes = (zone[0] === "-" ? -1 : 1) * (offsetHours * 60 + offsetRest);
  }
  const milliseconds = fraction ? Number(`${fraction}00`.slice(0, 3)) : 0;
  const instant = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds) - offsetMinutes * 60000;
  return Number.isFinite(instant) ? instant : null;
}

// ---------------------------------------------------------------------------
// Response normalization. Every reader fails closed: a malformed row is
// dropped, a malformed envelope returns null.
// ---------------------------------------------------------------------------

export function normalizeLearningItem(raw) {
  if (!isPlainObject(raw)) return null;
  const id = nullableId(raw.id);
  if (!id) return null;
  if (!LEARNING_SCOPES.includes(raw.scope)) return null;
  if (!LEARNING_KINDS.includes(raw.kind)) return null;
  if (!LEARNING_LOCALES.includes(raw.locale)) return null;
  if (!LEARNING_LOCALE_STATES.includes(raw.locale_state)) return null;
  if (!LEARNING_STATUSES.includes(raw.status)) return null;
  if (!LEARNING_AUDIENCES.includes(raw.audience)) return null;
  if (!Number.isInteger(raw.priority) || raw.priority < LEARNING_LIMITS.priorityMin || raw.priority > LEARNING_LIMITS.priorityMax) return null;
  if (!Number.isInteger(raw.revision) || raw.revision < 1) return null;
  if (raw.starts_at != null && typeof raw.starts_at !== "string") return null;
  if (raw.ends_at != null && typeof raw.ends_at !== "string") return null;
  const item = {
    id,
    scope: raw.scope,
    organization_id: nullableId(raw.organization_id),
    chapter_id: nullableId(raw.chapter_id),
    kind: raw.kind,
    locale: raw.locale,
    locale_state: raw.locale_state,
    audience: raw.audience,
    status: raw.status,
    // Delivery rows omit the editorial fields; they read as empty.
    ...Object.fromEntries(ITEM_STRING_FIELDS.map((field) => [field, stringOr(raw[field])])),
    bullets: Object.freeze(stringList(raw.bullets)),
    topics: Object.freeze(stringList(raw.topics)),
    factual_claims: typeof raw.factual_claims === "boolean" ? raw.factual_claims : raw.kind === "mini_lesson",
    priority: raw.priority,
    is_default: raw.is_default === true,
    starts_at: raw.starts_at ?? null,
    ends_at: raw.ends_at ?? null,
    revision: raw.revision,
    provenance: isPlainObject(raw.provenance) ? Object.freeze({ ...raw.provenance }) : null,
  };
  return Object.freeze(item);
}

function normalizeItemList(rawItems) {
  const items = [];
  const seen = new Set();
  let dropped = 0;
  for (const raw of rawItems) {
    const item = normalizeLearningItem(raw);
    if (!item || seen.has(item.id)) {
      dropped += 1;
      continue;
    }
    seen.add(item.id);
    items.push(item);
  }
  return { items, dropped };
}

export function normalizeLearningPolicy(raw) {
  if (!isPlainObject(raw)) return null;
  const flags = ["quotesEnabled", "lessonsEnabled", "homeHidden", "canManage", "isPlatformOwner"];
  if (flags.some((flag) => typeof raw[flag] !== "boolean")) return null;
  // Only a provisioned platform owner may hold a policy with no organization
  // (the platform library exists before any customer tenant does).
  const organizationId = nullableId(raw.organizationId);
  if (!organizationId && raw.isPlatformOwner !== true) return null;
  if (raw.organizationId != null && typeof raw.organizationId !== "string") return null;
  if (raw.chapterId != null && typeof raw.chapterId !== "string") return null;
  let version = "";
  if (typeof raw.version === "string") version = raw.version;
  else if (typeof raw.version === "number" && Number.isFinite(raw.version)) version = String(raw.version);
  else if (raw.version != null) return null;
  return Object.freeze({
    organizationId,
    chapterId: nullableId(raw.chapterId),
    quotesEnabled: raw.quotesEnabled,
    lessonsEnabled: raw.lessonsEnabled,
    homeHidden: raw.homeHidden,
    canManage: raw.canManage,
    isPlatformOwner: raw.isPlatformOwner,
    version,
  });
}

// The per-scope policy row from get_learning_workspace / save_learning_policy.
export function normalizeLearningScopePolicy(raw) {
  if (!isPlainObject(raw)) return null;
  const quotesEnabled = raw.quotes_enabled ?? raw.quotesEnabled;
  const lessonsEnabled = raw.lessons_enabled ?? raw.lessonsEnabled;
  if (typeof quotesEnabled !== "boolean" || typeof lessonsEnabled !== "boolean") return null;
  const rawSelection = raw.selected_ids !== undefined ? raw.selected_ids : raw.selectedIds;
  let selectedIds = null;
  if (rawSelection != null) {
    if (!Array.isArray(rawSelection) || rawSelection.some((id) => typeof id !== "string" || !id)) return null;
    selectedIds = Object.freeze([...new Set(rawSelection)]);
  }
  return Object.freeze({
    quotesEnabled,
    lessonsEnabled,
    selectedIds,
    revision: Number.isInteger(raw.revision) ? raw.revision : null,
  });
}

export function normalizeLearningPage(raw) {
  if (!isPlainObject(raw) || !Array.isArray(raw.items)) return null;
  const { items, dropped } = normalizeItemList(raw.items);
  return Object.freeze({ items: Object.freeze(items), hasMore: raw.hasMore === true, dropped });
}

export function normalizeLearningWorkspace(raw) {
  if (!isPlainObject(raw) || !Array.isArray(raw.items)) return null;
  const policy = normalizeLearningScopePolicy(raw.policy);
  if (!policy) return null;
  const { items, dropped } = normalizeItemList(raw.items);
  return Object.freeze({
    items: Object.freeze(items),
    hasMore: raw.hasMore === true,
    dropped,
    policy,
    canManage: raw.canManage === true,
    isPlatformOwner: raw.isPlatformOwner === true,
  });
}

export function normalizeLearningHistoryPage(raw) {
  if (!isPlainObject(raw) || !Array.isArray(raw.items)) return null;
  const items = [];
  let dropped = 0;
  for (const entry of raw.items) {
    if (!isPlainObject(entry) || !Number.isInteger(entry.revision) || typeof entry.action !== "string" || typeof entry.changed_at !== "string") {
      dropped += 1;
      continue;
    }
    items.push(Object.freeze({
      revision: entry.revision,
      action: entry.action,
      changedAt: entry.changed_at,
      changedBy: nullableId(entry.changed_by),
      snapshot: isPlainObject(entry.snapshot) ? Object.freeze({ ...entry.snapshot }) : null,
    }));
  }
  return Object.freeze({ items: Object.freeze(items), hasMore: raw.hasMore === true, dropped });
}

export function normalizeLearningHomeHidden(raw) {
  return isPlainObject(raw) && typeof raw.homeHidden === "boolean" ? raw.homeHidden : null;
}

// ---------------------------------------------------------------------------
// Drafts and payloads
// ---------------------------------------------------------------------------

export function emptyLearningDraft({ kind = "quote", locale = "en" } = {}) {
  const draftKind = LEARNING_KINDS.includes(kind) ? kind : "quote";
  return {
    id: null,
    kind: draftKind,
    locale: LEARNING_LOCALES.includes(locale) ? locale : "en",
    locale_state: "draft",
    title: "",
    body: "",
    attribution: "",
    source: "",
    rights_note: "",
    review_note: "",
    bullets: [],
    direction: "",
    topics: [],
    audience: "all",
    tone: "",
    learning_outcome: "",
    // A lesson makes factual claims until its editor says otherwise.
    factual_claims: draftKind === "mini_lesson",
    priority: LEARNING_DEFAULT_PRIORITY,
    is_default: false,
  };
}

function draftFields(source, fallback) {
  const draft = { ...fallback };
  if (!isPlainObject(source)) return draft;
  for (const field of ["kind", "locale", "locale_state", "audience"]) {
    if (typeof source[field] === "string") draft[field] = source[field];
  }
  for (const field of ITEM_STRING_FIELDS) {
    if (typeof source[field] === "string") draft[field] = source[field];
  }
  if (Array.isArray(source.bullets)) draft.bullets = stringList(source.bullets);
  if (Array.isArray(source.topics)) draft.topics = stringList(source.topics);
  if (typeof source.factual_claims === "boolean") draft.factual_claims = source.factual_claims;
  if (Number.isInteger(source.priority)) draft.priority = source.priority;
  if (typeof source.is_default === "boolean") draft.is_default = source.is_default;
  return draft;
}

export function learningDraftFromItem(item) {
  const fallback = emptyLearningDraft({ kind: item?.kind, locale: item?.locale });
  const draft = draftFields(item, fallback);
  draft.id = nullableId(item?.id);
  return draft;
}

// A history snapshot is the full item at audit time. Copying it into the
// editor keeps the current item's identity; saving it is a new revision.
export function learningDraftFromSnapshot(snapshot, currentItem) {
  const draft = draftFields(snapshot, learningDraftFromItem(currentItem));
  draft.id = nullableId(currentItem?.id);
  return draft;
}

function integerOrNaN(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value.trim());
  return Number.NaN;
}

// p_item for save_learning_content: exactly the editable keys, trimmed. The
// id is present only when updating an existing item.
export function buildLearningItemPayload(draft) {
  const source = isPlainObject(draft) ? draft : {};
  const text = (field) => stringOr(source[field]).trim();
  const list = (field) => (Array.isArray(source[field]) ? source[field].map((entry) => stringOr(entry).trim()) : []);
  const payload = {
    kind: stringOr(source.kind),
    locale: stringOr(source.locale),
    locale_state: stringOr(source.locale_state),
    title: text("title"),
    body: text("body"),
    attribution: text("attribution"),
    source: text("source"),
    rights_note: text("rights_note"),
    review_note: text("review_note"),
    bullets: list("bullets"),
    direction: text("direction"),
    topics: list("topics"),
    audience: stringOr(source.audience),
    tone: text("tone"),
    learning_outcome: text("learning_outcome"),
    factual_claims: source.factual_claims === true,
    priority: integerOrNaN(source.priority),
    is_default: source.is_default === true,
  };
  const id = nullableId(source.id);
  return id ? { id, ...payload } : payload;
}

export function learningPayloadsEqual(left, right) {
  return JSON.stringify(buildLearningItemPayload(left)) === JSON.stringify(buildLearningItemPayload(right));
}

// Source is required whenever the item is attributed or makes factual claims.
export function learningSourceRequired(input) {
  return stringOr(input?.attribution).trim() !== "" || input?.factual_claims === true;
}

// Issues for a draft or an item. mode "save" is what save_learning_content
// accepts; mode "publish" adds what publish/schedule require. scope, when
// given, refuses a default flag outside the platform scope.
export function validateLearningItem(input, { mode = "save", scope = null } = {}) {
  const payload = buildLearningItemPayload(input);
  const issues = [];
  const push = (field, code, extra = {}) => issues.push({ field, code, ...extra });

  if (!LEARNING_KINDS.includes(payload.kind)) push("kind", "invalid");
  if (!LEARNING_LOCALES.includes(payload.locale)) push("locale", "invalid");
  if (!LEARNING_LOCALE_STATES.includes(payload.locale_state)) push("locale_state", "invalid");
  if (!LEARNING_AUDIENCES.includes(payload.audience)) push("audience", "invalid");

  if (!payload.title) push("title", "required");
  else if (codePointLength(payload.title) > LEARNING_LIMITS.title) push("title", "too_long", { limit: LEARNING_LIMITS.title });

  const bodyLimit = learningBodyLimit(payload.kind);
  if (!payload.body) push("body", "required");
  else if (bodyLimit != null && codePointLength(payload.body) > bodyLimit) push("body", "too_long", { limit: bodyLimit });

  for (const field of TEXT_FIELDS) {
    if (codePointLength(payload[field]) > LEARNING_TEXT_LIMITS[field]) push(field, "too_long", { limit: LEARNING_TEXT_LIMITS[field] });
  }

  for (const [field, countLimit, entryLimit] of [
    ["bullets", LEARNING_LIMITS.bulletCount, LEARNING_LIMITS.bullet],
    ["topics", LEARNING_LIMITS.topicCount, LEARNING_LIMITS.topic],
  ]) {
    const entries = payload[field];
    if (entries.length > countLimit) push(field, "too_many", { limit: countLimit });
    entries.forEach((entry, index) => {
      if (!entry) push(field, "empty_entry", { index });
      else if (codePointLength(entry) > entryLimit) push(field, "entry_too_long", { index, limit: entryLimit });
    });
  }

  if (!Number.isInteger(payload.priority) || payload.priority < LEARNING_LIMITS.priorityMin || payload.priority > LEARNING_LIMITS.priorityMax) {
    push("priority", "out_of_range", { min: LEARNING_LIMITS.priorityMin, max: LEARNING_LIMITS.priorityMax });
  }
  if (payload.is_default && scope != null && scope !== "platform") push("is_default", "platform_only");

  if (mode === "publish") {
    if (payload.locale_state !== "reviewed") push("locale_state", "not_reviewed");
    if (!payload.rights_note) push("rights_note", "required");
    if (!payload.review_note) push("review_note", "required");
    if (learningSourceRequired(payload) && !payload.source) push("source", "required");
  }

  if (issues.length === 0 && learningPayloadBytes(payload) > LEARNING_LIMITS.payloadBytes) {
    push("payload", "too_large", { limit: LEARNING_LIMITS.payloadBytes });
  }
  return issues;
}

// What still blocks publish/schedule for a SAVED item.
export function learningPublicationIssues(item) {
  return validateLearningItem(item, { mode: "publish" });
}

// Which transitions to offer for an item's current status. The server
// accepts any action on any status; withdrawing something that is not
// visible, though, is never a useful offer.
export function learningTransitionsFor(status) {
  return status === "published" || status === "scheduled"
    ? ["publish", "schedule", "withdraw"]
    : ["publish", "schedule"];
}

// Publication window checks, mirroring transition_learning_content: publish
// starts now, schedule needs a future start, an end must be strictly after
// the start, and withdraw carries no dates.
export function validateLearningTransition({ action, startsAt = null, endsAt = null, nowMs }) {
  const issues = [];
  if (!LEARNING_TRANSITIONS.includes(action)) return [{ field: "action", code: "invalid" }];
  const start = startsAt == null || startsAt === "" ? null : parseLearningInstant(startsAt);
  const end = endsAt == null || endsAt === "" ? null : parseLearningInstant(endsAt);
  if (action === "withdraw") {
    if (start != null || end != null) issues.push({ field: "starts_at", code: "not_allowed" });
    return issues;
  }
  if (startsAt != null && startsAt !== "" && start == null) issues.push({ field: "starts_at", code: "invalid_date" });
  if (endsAt != null && endsAt !== "" && end == null) issues.push({ field: "ends_at", code: "invalid_date" });
  if (action === "publish" && start != null) issues.push({ field: "starts_at", code: "not_allowed" });
  if (action === "schedule") {
    if (start == null && !(startsAt != null && startsAt !== "")) issues.push({ field: "starts_at", code: "required" });
    else if (start != null && start <= nowMs) issues.push({ field: "starts_at", code: "not_future" });
  }
  const effectiveStart = action === "publish" ? nowMs : start;
  if (end != null && effectiveStart != null && end <= effectiveStart) issues.push({ field: "ends_at", code: "not_after_start" });
  return issues;
}

// ---------------------------------------------------------------------------
// Delivery: what a member may see right now
// ---------------------------------------------------------------------------

export function isLearningItemLive(item, nowMs) {
  if (!item || (item.status !== "published" && item.status !== "scheduled")) return false;
  if (item.locale_state !== "reviewed") return false;
  const start = parseLearningInstant(item.starts_at);
  if (start == null || start > nowMs) return false;
  if (item.ends_at != null) {
    const end = parseLearningInstant(item.ends_at);
    if (end == null || end <= nowMs) return false;
  }
  return true;
}

// Everything about delivery except the clock: published or scheduled and
// reviewed, in the requested locale (no fallback between languages), of an
// enabled kind, non-empty, and never another tenant's row. Clients order
// eligible items once and check the clock at render, Next and timers.
export function isLearningItemEligible(item, { locale, quotesEnabled, lessonsEnabled, organizationId, chapterId }) {
  if (!item || (item.status !== "published" && item.status !== "scheduled")) return false;
  if (item.locale_state !== "reviewed") return false;
  if (item.locale !== locale) return false;
  if (item.kind === "quote" ? quotesEnabled !== true : lessonsEnabled !== true) return false;
  if (!item.title.trim() || !item.body.trim()) return false;
  if (item.scope === "organization" && item.organization_id !== organizationId) return false;
  if (item.scope === "chapter" && (item.organization_id !== organizationId || item.chapter_id !== chapterId)) return false;
  return true;
}

export function isLearningItemDeliverable(item, context) {
  return isLearningItemEligible(item, context) && isLearningItemLive(item, context.nowMs);
}

// "draft" | "withdrawn" | "upcoming" | "live" | "expired"
export function learningPublicationState(item, nowMs) {
  if (!item) return "draft";
  if (item.status === "draft" || item.status === "withdrawn") return item.status;
  const start = parseLearningInstant(item.starts_at);
  const end = item.ends_at == null ? null : parseLearningInstant(item.ends_at);
  if (start == null) return "expired";
  if (start > nowMs) return "upcoming";
  if (item.ends_at != null && (end == null || end <= nowMs)) return "expired";
  return "live";
}

// The one Home read for a policy, or null when Home must not read content:
// no policy, hidden by the member, or both modules off. One enabled module
// is requested by kind so a disabled kind is never loaded.
export function learningHomeRequest(policy) {
  if (!policy || policy.homeHidden) return null;
  if (policy.quotesEnabled && policy.lessonsEnabled) return { kind: null, offset: 0, limit: LEARNING_PAGE_SIZE.home };
  if (policy.quotesEnabled) return { kind: "quote", offset: 0, limit: LEARNING_PAGE_SIZE.home };
  if (policy.lessonsEnabled) return { kind: "mini_lesson", offset: 0, limit: LEARNING_PAGE_SIZE.home };
  return null;
}

// A Learn library page, or null when lessons are off.
export function learningLibraryRequest(policy, offset = 0) {
  if (!policy || !policy.lessonsEnabled) return null;
  if (!Number.isInteger(offset) || offset < 0 || offset > LEARNING_MAX_OFFSET) return null;
  return { kind: "mini_lesson", offset, limit: LEARNING_PAGE_SIZE.learn };
}

// The earliest start or end still ahead of now among cached items, so a
// client can re-check delivery exactly when something begins or expires.
export function nextLearningBoundary(items, nowMs) {
  let next = null;
  for (const item of items || []) {
    for (const value of [item?.starts_at, item?.ends_at]) {
      const at = parseLearningInstant(value);
      if (at != null && at > nowMs && (next == null || at < next)) next = at;
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Daily rotation: stable for a day, a user, an organization, a chapter and a
// locale; "Next" advances locally and never asks the server.
// ---------------------------------------------------------------------------

export function learningDayKey(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return "";
  const pad = (number, width) => String(number).padStart(width, "0");
  return `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1, 2)}-${pad(value.getDate(), 2)}`;
}

export function learningRotationSeed({ day, userId, organizationId, chapterId, locale }) {
  return [day, userId, organizationId, chapterId, locale].map((part) => (part == null ? "" : String(part))).join("|");
}

// FNV-1a over UTF-16 code units: identical on V8, JavaScriptCore and Hermes.
export function stableLearningHash(text) {
  let hash = 0x811c9dc5;
  const value = String(text);
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// Higher priority first; within a priority, the seeded hash of the id; the
// id itself (code-unit order) breaks any remaining tie. Duplicate ids keep
// their first occurrence, so one item never fills two slots.
export function orderLearningItems(items, seed) {
  const seen = new Set();
  const keyed = [];
  for (const item of items || []) {
    if (!item || typeof item.id !== "string" || seen.has(item.id)) continue;
    seen.add(item.id);
    keyed.push({ item, key: stableLearningHash(`${seed}|${item.id}`) });
  }
  keyed.sort((left, right) => (
    (right.item.priority - left.item.priority)
    || (left.key - right.key)
    || (left.item.id < right.item.id ? -1 : left.item.id > right.item.id ? 1 : 0)
  ));
  return keyed.map((entry) => entry.item);
}

export function learningRotationStorageKey({ userId, organizationId, chapterId, locale }) {
  const parts = [userId, organizationId, chapterId, locale].map((part) => encodeURIComponent(part == null ? "" : String(part)));
  return `unionground.learning.rotation.v1:${parts.join(":")}`;
}

// The stored index for today, or 0 for another day or anything unreadable.
export function parseLearningRotationState(raw, day) {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return 0;
    }
  }
  if (!isPlainObject(value) || value.day !== day) return 0;
  return Number.isInteger(value.index) && value.index >= 0 && value.index <= 100000 ? value.index : 0;
}

export function serializeLearningRotationState(day, index) {
  const safe = Number.isInteger(index) && index >= 0 ? index : 0;
  return JSON.stringify({ day, index: safe });
}

// The first live item at or after index (wrapping), with its position.
export function pickLearningItem(ordered, index, nowMs) {
  const count = Array.isArray(ordered) ? ordered.length : 0;
  if (!count) return null;
  const start = Number.isInteger(index) ? ((index % count) + count) % count : 0;
  for (let step = 0; step < count; step += 1) {
    const position = (start + step) % count;
    if (isLearningItemLive(ordered[position], nowMs)) return { item: ordered[position], index: position };
  }
  return null;
}

// The position "Next" moves to: the following live item, wrapping; the same
// position when it is the only live item.
export function nextLearningIndex(ordered, index, nowMs) {
  const current = pickLearningItem(ordered, index, nowMs);
  if (!current) return 0;
  const following = pickLearningItem(ordered, current.index + 1, nowMs);
  return following ? following.index : current.index;
}

export function liveLearningCount(ordered, nowMs) {
  return (ordered || []).reduce((count, item) => count + (isLearningItemLive(item, nowMs) ? 1 : 0), 0);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// "conflict" | "forbidden" | "not_found" | "invalid" | "unavailable" | "network" | "unknown"
export function learningErrorKind(error) {
  if (!error) return "unknown";
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  if (code === "PGRST202" || code === "42883") return "unavailable";
  if (code === "PT409" || code === "40001" || /revision conflict/.test(message)) return "conflict";
  if (code === "42501" || code === "PGRST301") return "forbidden";
  if (code === "P0002" || code === "PGRST116") return "not_found";
  if (code.startsWith("22") || code.startsWith("23")) return "invalid";
  if (error.name === "TypeError" || /failed to fetch|network|timed? ?out/.test(message)) return "network";
  return "unknown";
}
