import { organizationSurveysFromSnapshot } from "./voiceAvailability.js";
import { eventModelFields, eventModelLabels, eventIsPast, compareEventSchedule } from "./eventModel.js";
import { LEGACY_EVENT_COLUMNS, readEventSchema, retryAfterProbe } from "./eventSchemaCompatibility.js";
import { uploadSensitiveCaseFile, downloadSensitiveCaseFile, downloadSensitiveFormFile, removeSensitiveFormFile, sensitiveContentRpc, uploadSensitiveFormFile } from "./sensitiveContentApi.js";
import { LEGAL_HOLD_REASONS, channelUnreadCount, projectMessagePreview } from "../features/messaging/index.js";
import { messageActionRequest } from "../features/messaging/actions.js";
import { normalizeChannelReminders } from "../features/messaging/remindHere.js";
import { callPeerMessageRpc } from "../features/messaging/peerMessageRpc.js";
import { channelWindow, channelWindowRead } from "../features/messaging/channelHistory.js";
import { PRIVATE_MESSAGE_WINDOW, conversationsWithOlderMessages, privateMessageWindow } from "../features/messaging/privateHistory.js";
import { loadChapterStandingWithRetry } from "./chapterStandingRead.js";
import { loadChapterLifecycleAdmin } from "./chapterLifecycleApi.js";
import { currentFormTemplateRows, resolveFormTemplates, templateFromDbRow } from "./formTemplates.js";
import { normalizeUploadFile } from "./heicNormalization.js";
import { validatePrivateUploadFile } from "./privateUploadValidation.js";
import { t as translate, dateTimeFormat, formatDateWithYear, localeFor } from "./i18n.js";
import {
  PrivateFileError,
  downloadPrivateFileBlob,
  requestPrivateFileInspection,
} from "./privateFileAccess.js";

// A PostgREST or RPC failure arrives as { message, code, details, hint }. Only
// `message` used to survive the throw, so `grep "error.code" src/` returned
// nothing repo-wide and no caller could tell a raised CHECK constraint from a
// dropped connection — every failure was one opaque string. The message is
// still built exactly as before, because tests/member-api.test.js:543 asserts
// the `label: message` shape across four call sites and a toast reads it; the
// machine-readable fields ride alongside it instead of replacing it.
export { MemberApiError } from "./memberApiError.js";
import { MemberApiError, withSoftRpcDeadline } from "./memberApiError.js";
import { requireRow } from "./apiResult.js";

import { RIGHTS_FALLBACK } from "./rightsFallback.js";
import { OPEN_STEP_DEADLINE_STATUSES, withNextDeadlines } from "./caseNextDeadline.js";
import { missingTimeZoneColumn, withoutTimeZoneColumn } from "./timeZoneColumn.js";
import { loadOfficerRemovalDetails } from "./governanceApi.js";
import { openMemberCase } from "../features/caseIntake/api.js";
import { carriesSpanishEdit, spanishValue } from "./bilingualContent.js";
import { UNSET_GROUP_TIME_ZONE, isTimeZone, zoneDay } from "./zoneTime.js";
import { withoutRowsBesideHeldSwitches } from "./heldSettingCompanions.js";
import { signatureRpcArgs } from "./typedSignature.js";
import { publishNoticeOnce } from "./noticePublishKey.js";
import { POSTGREST_MAX_ROWS } from "./boundedPage.js";

function requireData(result, label) {
  if (result.error) throw new MemberApiError(label, result.error);
  return result.data ?? [];
}

// Additive reads degrade to a safe default instead of blanking the surface, but
// "degraded silently" is how a broken policy or a missing RPC survives a whole
// release. Log the discarded error in dev only — a member's console must stay
// clean, and this is exactly the kind of noise that trains people to ignore it.
function softFailed(result, label) {
  if (!result.error) return false;
  if (import.meta.env.DEV) console.warn(`[memberApi] ${label} degraded:`, result.error.message);
  return true;
}

// The member's own referral code and recruited count, or null when the server
// gave neither (not a member, or an older deployment).
export function normalizeReferralSummary(value) {
  if (!value || typeof value !== "object") return null;
  const code = typeof value.code === "string" && /^[0-9A-F]{12}$/.test(value.code) ? value.code : null;
  const recruitedYtd = Number.isSafeInteger(value.recruitedYtd) && value.recruitedYtd >= 0 ? value.recruitedYtd : null;
  return code || recruitedYtd != null ? { code, recruitedYtd } : null;
}

function softData(result, label, fallback) {
  return softFailed(result, label) ? fallback : result.data ?? fallback;
}

export function mergeSelectedMembershipRoles(legacyRoles = [], memberships = []) {
  const rows = Array.isArray(memberships) ? memberships : [];
  const selected = rows.find((row) => row?.selected) ?? rows[0] ?? null;
  const selectedRoles = Array.isArray(selected?.roles) ? selected.roles : [];
  // Once a membership belongs to a tenant, its projected roles are the
  // authority. Legacy member_roles remain only for ownerless compatibility;
  // unioning them into a tenant-owned row would resurrect a revoked staff hat.
  const compatibleLegacyRoles = selected?.organizationId == null ? legacyRoles : [];
  return [...new Set([...compatibleLegacyRoles, ...selectedRoles]
    .filter((role) => typeof role === "string" && role.length > 0))];
}

// The template registry is read WHOLE, in deterministic (sort, key, version)
// order, by walking 500-row pages until a short one — a registry past 500
// versions used to truncate silently, and without an order-by the dropped
// rows were whichever 500 the planner felt like (sol  F8). Any page
// failing surfaces the error with no rows, so the callers' additive contract
// falls back to the static FORM_TEMPLATES array instead of rendering a
// partial registry that could miss a draft's pinned version.
const TEMPLATE_PAGE = 500;
async function fetchAllFormTemplates(client, columns, startableOnly = false) {
  const rows = [];
  for (let from = 0; ; from += TEMPLATE_PAGE) {
    let query = client.from("form_template_registry").select(`${columns},available_to_start`)
      .order("sort").order("key").order("version");
    if (startableOnly) query = query.eq("available_to_start", true);
    const { data, error } = await query.range(from, from + TEMPLATE_PAGE - 1);
    if (error) return { data: null, error };
    rows.push(...(data || []));
    if (!data || data.length < TEMPLATE_PAGE) return { data: rows, error: null };
  }
}

// These body-bearing rows sit on the critical member bootstrap path. Keep that
// path to one bounded request; the staff-only review picker loads the complete
// lifecycle collection through list_knowledge_review_articles_snapshot instead.
const MEMBER_KNOWLEDGE_LIMIT = 100;
const MEMBER_KNOWLEDGE_COLUMNS = "id,slug,chapter_id,kind,title,article_ref,body,keywords,order_index,status,is_sample,version,created_by,updated_by,verified_by,verified_at,created_at,updated_at";
// RLS intentionally exposes both the caller's own submissions and accepted
// alliance grievances they co-signed. Walk the deterministic result — newest
// updated_at first — but SOL-20260813-06: loadMemberApp awaits this during
// boot and FormsView renders the whole list with no pagination of its own, so
// an unbounded walk was not "more data available", it was a boot that never
// finished for a member with a real archive. MEMBER_FORM_MAX_PAGES bounds the
// walk to the member's most recently touched forms (order is already newest
// first, so capping the walk IS capping to recency) and mirrors the order of
// magnitude of the steward caseload window (200 active + 50 resolved) scaled
// up because this walk also covers every co-signed alliance grievance, not
// one desk's live queue.
export const MEMBER_FORM_PAGE = 200;
export const MEMBER_FORM_MAX_PAGES = 10;
// BUG-UG-CASE-DEADLINE-MEMBER-AND-STAFF-READ-DIFFERENT-DATES-20261110:
// every open step deadline on the given cases, in due order. PostgREST caps one
// response (supabase/config.toml max_rows), so the read pages until a short
// page; any failed page fails the whole read, and the caller then keeps each
// case on its own deadline rather than choosing from a partial set.
export const STEP_DEADLINE_PAGE = 1000;
const STEP_DEADLINE_MAX_PAGES = 20;
// Each step deadline's zone  rides along; before its migration
// applies the read runs once without it (src/lib/timeZoneColumn.js).
const STEP_DEADLINE_COLUMNS = "case_id,id,label,due_at,status,time_zone";
export async function readOpenStepDeadlines(client, caseIds) {
  if (!caseIds.length) return { data: [], error: null };
  const rows = [];
  let columns = STEP_DEADLINE_COLUMNS;
  for (let page = 0; page < STEP_DEADLINE_MAX_PAGES; page++) {
    const from = page * STEP_DEADLINE_PAGE;
    const read = () => client.from("casework_deadlines").select(columns)
      .in("case_id", caseIds).in("status", [...OPEN_STEP_DEADLINE_STATUSES])
      .order("due_at", { ascending: true }).order("id", { ascending: true })
      .range(from, from + STEP_DEADLINE_PAGE - 1);
    let result = await read();
    // A failed first read comes back as error; a failed refresh that kept earlier rows, as refreshFailure.
    if (missingTimeZoneColumn(result.error ?? result.refreshFailure) && columns !== withoutTimeZoneColumn(columns)) {
      columns = withoutTimeZoneColumn(columns);
      // The failed probe is withdrawn from the session loader first, so a recovered read is not a reload failure.
      result = await retryAfterProbe(result, read);
    }
    const { data, error } = result;
    if (error) return { data: null, error };
    const pageRows = Array.isArray(data) ? data : [];
    rows.push(...pageRows);
    if (pageRows.length < STEP_DEADLINE_PAGE) return { data: rows, error: null };
  }
  return { data: null, error: { message: "Too many open step deadlines to read" } };
}

async function fetchAllAccessibleMemberForms(client) {
  const rows = [];
  for (let page = 0; page < MEMBER_FORM_MAX_PAGES; page++) {
    const from = page * MEMBER_FORM_PAGE;
    // The final bounded request carries one sentinel row. That distinguishes
    // exactly 2,000 rows from 2,001+ without an eleventh round trip; only the
    // first 200 rows from this page enter the member-visible archive.
    const pageLimit = page === MEMBER_FORM_MAX_PAGES - 1
      ? MEMBER_FORM_PAGE + 1
      : MEMBER_FORM_PAGE;
    const columns = "id,user_id,template_key,template_version,status,answers,revision,step,review_note,submitted_at,updated_at,filer_signed_at,filer_signature_digest,content_digest,artifact_digest,artifact_approved_at,artifact_approved_by";
    const read = (fields) => client.from("member_forms")
      .select(fields)
      .order("updated_at", { ascending: false }).order("id", { ascending: false })
      .range(from, from + pageLimit - 1);
    let result = await read(`${columns},settings_scope`);
    if (["42703", "PGRST204"].includes(result.error?.code) && /\bsettings_scope\b/.test([result.error.message, result.error.details].join(" "))) {
      result = await retryAfterProbe(result, () => read(columns));
    }
    const { data, error } = result;
    if (error) {
      // Page zero failing has zero confirmed rows — that is a real read
      // error, and it still surfaces as one so the additive contract falls
      // back to [] instead of rendering an empty forms list that looks
      // identical to "this member has filed nothing" (softData/softFailed
      // below). A LATER page failing already has confirmed rows behind it;
      // discarding them to report the same error would turn one flaky page
      // into "you lost every filed and co-signed form", which is worse for
      // the member than an honest partial list. Logged in DEV only, same as
      // every other additive degrade in this file — a member's console must
      // stay clean.
      if (rows.length === 0) return { data: null, error, truncated: false };
      if (import.meta.env.DEV) console.warn("[memberApi] Forms degraded mid-walk:", error.message);
      return { data: rows, error: null, truncated: true };
    }
    const pageRows = data || [];
    if (page === MEMBER_FORM_MAX_PAGES - 1) {
      rows.push(...pageRows.slice(0, MEMBER_FORM_PAGE));
      return { data: rows, error: null, truncated: pageRows.length > MEMBER_FORM_PAGE };
    }
    rows.push(...pageRows);
    if (pageRows.length < MEMBER_FORM_PAGE) return { data: rows, error: null, truncated: false };
  }
  return { data: rows, error: null, truncated: false };
}

// A member's own chapter history and explicitly organization-wide events are
// archives, not upcoming-only windows. Walk deterministic pages so old
// attendance and Home activity cannot silently disappear at PostgREST's row
// cap. Other region-visible chapters are discovery only: downloading their
// complete history makes member boot time grow with the region and floods Home
// with activity that is not the member's chapter context.
const EVENT_PAGE = 500;
export const MEMBER_EVENT_DISCOVERY_LIMIT = 200;
// cancelled_at/cancelled_reason are selected so the web projection can mark
// cancelled events: without them a cancelled event renders as upcoming and the
// member only finds out when RSVP/check-in refuse server-side. The grant is
// authenticated-only (20260821015000_mobile_event_cancellation_visibility).
export const MEMBER_EVENT_COLUMNS = "id,title,starts_at,ends_at,event_kind,event_date,series_id,sort_at,check_in_offered,rsvp_open,location,summary,order_index,chapter_id,is_public,is_public_across_agencies,cancelled_at,cancelled_reason";

const LEGACY_MEMBER_EVENT_COLUMNS = MEMBER_EVENT_COLUMNS.split(",")
  .filter((column) => column !== "check_in_offered" && column !== "rsvp_open").join(",");
const PRE_RSVP_SWITCH_MEMBER_EVENT_COLUMNS = MEMBER_EVENT_COLUMNS.split(",")
  .filter((column) => column !== "rsvp_open").join(",");

// Code deploys before hosted migrations. Rebuild the same scoped read once
// without the newer column; legacy rows map to checkInOffered=false, and a row
// read before the RSVP switch exists maps to rsvpOpen=true (every event
// collected RSVPs before it).
async function readMemberEvents(query) {
  return readEventSchema(async (legacy) => {
    if (legacy) return query(LEGACY_EVENT_COLUMNS, true);
    const result = await query(MEMBER_EVENT_COLUMNS, false);
    const error = result.error;
    const missing = ["42703", "PGRST204"].includes(error?.code) ? [error.message, error.details, error.hint].join(" ") : "";
    if (/\bcheck_in_offered\b/.test(missing)) {
      return retryAfterProbe(result, () => query(LEGACY_MEMBER_EVENT_COLUMNS, false));
    }
    if (/\brsvp_open\b/.test(missing)) {
      return retryAfterProbe(result, () => query(PRE_RSVP_SWITCH_MEMBER_EVENT_COLUMNS, false));
    }
    return result;
  });
}


// Exact source navigation must not depend on the bounded discovery window.
// All three reads retain their ordinary RLS and the attendance reads are scoped
// to the signed-in member; an RSVP is never interpreted as contact permission.
// BUG-UG-COMPASS-ANSWER-ABOVE-QUESTION-20261107: one Compass exchange
// saves the question and its answer in a single insert, so both rows carry
// the same created_at and the newest-first read leaves their order to the
// database. Oldest first, and within one moment the question before the answer.
const GUIDE_ROLE_ORDER = { user: 0, assistant: 1 };
export function orderGuideMessages(rows) {
  return [...(rows ?? [])]
    .map((message, index) => ({ message, index, at: Date.parse(message?.created_at ?? "") || 0 }))
    .sort((a, b) => a.at - b.at
      || (GUIDE_ROLE_ORDER[a.message?.role] ?? 2) - (GUIDE_ROLE_ORDER[b.message?.role] ?? 2)
      || b.index - a.index)
    .map(({ message }) => message);
}

export async function loadAuthorizedCalendarEvent(client, eventId, userId, lang = "en") {
  const { data: row, error } = await readMemberEvents((columns) => client.from("member_events").select(columns).eq("id", eventId).maybeSingle());
  if (error) throw error;
  if (!row || !userId) throw new Error("Event unavailable");
  const [rsvp, checkin] = await Promise.all([
    client.from("member_event_rsvps").select("status").eq("event_id", eventId).eq("user_id", userId).maybeSingle(),
    client.from("member_event_checkins").select("event_id").eq("event_id", eventId).eq("user_id", userId).maybeSingle(),
  ]);
  if (rsvp.error || checkin.error) throw rsvp.error || checkin.error;
  return {
    id: row.id, title: row.title, startsAt: row.starts_at,
    ...eventModelFields(row), ...eventModelLabels({ ...eventModelFields(row), startsAt: row.starts_at }, lang),
    location: row.location, summary: row.summary, chapterId: row.chapter_id, chapterName: row.chapter_id,
    checkInOffered: row.check_in_offered === true,
    rsvpOpen: row.rsvp_open !== false,
    cancelledAt: row.cancelled_at ?? null, cancelledReason: row.cancelled_reason ?? null,
    isPublic: Boolean(row.is_public), isPublicAcrossAgencies: Boolean(row.is_public_across_agencies),
    rsvpStatus: rsvp.data?.status || null, checkedIn: Boolean(checkin.data),
    isPast: eventIsPast({ ...eventModelFields(row), startsAt: row.starts_at }),
  };
}

async function fetchChapterEventArchive(client, chapterId) {
  const rows = [];
  for (let from = 0; ; from += EVENT_PAGE) {
    const { data, error } = await readMemberEvents((columns, legacy) => client.from("member_events").select(columns)
      .eq("chapter_id", chapterId)
      .order(legacy ? "starts_at" : "sort_at").order("id")
      .range(from, from + EVENT_PAGE - 1));
    if (error) return { data: null, error };
    rows.push(...(data || []));
    if (!data || data.length < EVENT_PAGE) return { data: rows, error: null };
  }
}

async function fetchOrganizationWideEventArchive(client, chapterId) {
  const rows = [];
  for (let from = 0; ; from += EVENT_PAGE) {
    const { data, error } = await readMemberEvents((columns, legacy) => client.from("member_events").select(columns)
      .eq("is_public_across_agencies", true)
      .neq("chapter_id", chapterId)
      .order(legacy ? "starts_at" : "sort_at").order("id")
      .range(from, from + EVENT_PAGE - 1));
    if (error) return { data: null, error };
    rows.push(...(data || []));
    if (!data || data.length < EVENT_PAGE) return { data: rows, error: null };
  }
}

function eventRowOrder(a, b) {
  return compareEventSchedule(a, b);
}

export async function fetchMemberEventsForChapter(client, chapterId, activeFloor = Date.now() - 6 * 3600000) {
  const scope = String(chapterId || "").trim();
  if (!scope) return { data: [], error: null };

  // A date-only item remains current for its whole local calendar date, even
  // after its midnight sort key has crossed the timed meeting window.
  const floor = new Date(activeFloor);
  const dateFloor = `${floor.getFullYear()}-${String(floor.getMonth() + 1).padStart(2, "0")}-${String(floor.getDate()).padStart(2, "0")}`;
  const archiveRequest = fetchChapterEventArchive(client, scope);
  const organizationWideRequest = fetchOrganizationWideEventArchive(client, scope);
  const discoveryRequest = readMemberEvents((columns, legacy) => {
    let query = client.from("member_events").select(columns)
    .neq("chapter_id", scope)
    // Organization-wide history has its own complete, paged read above. Keep
    // this cap exclusively for upcoming region-public discovery.
    .eq("is_public_across_agencies", false)
    ;
    query = legacy ? query.gte("starts_at", floor.toISOString())
      : query.or(`and(event_kind.eq.meeting,sort_at.gte.${floor.toISOString()}),and(event_kind.neq.meeting,event_date.gte.${dateFloor})`);
    return query.order(legacy ? "starts_at" : "sort_at").order("id")
      .limit(MEMBER_EVENT_DISCOVERY_LIMIT);
  });
  const [archive, organizationWide, discovery] = await Promise.all([
    archiveRequest,
    organizationWideRequest,
    discoveryRequest,
  ]);
  if (archive.error) return archive;

  // Cross-chapter reads are additive. A transient failure must not erase
  // confirmed attendance history from the member's own chapter.
  if (organizationWide.error && import.meta.env.DEV) {
    console.warn("[memberApi] Organization-wide event history degraded:", organizationWide.error.message);
  }
  if (discovery.error && import.meta.env.DEV) {
    console.warn("[memberApi] Event discovery degraded:", discovery.error.message);
  }
  const byId = new Map();
  for (const row of [
    ...(archive.data || []),
    ...(organizationWide.error ? [] : organizationWide.data || []),
    ...(discovery.error ? [] : discovery.data || []),
  ]) {
    if (row?.id != null) byId.set(row.id, row);
  }
  return { data: [...byId.values()].sort(eventRowOrder), error: null };
}

// The pinned option sets. Constructing an Intl.DateTimeFormat is the expensive
// part (formatting through an existing one is cheap), and a coordinator load
// runs these helpers once per row — ~1000 constructions. Each option object is
// a module-scope singleton so formatterFor() can cache on its identity, giving
// at most (option sets x languages) formatters for the process.
//
// Locale and options are pinned deliberately: this app fixes en-US rather than
// following the host locale (an SSR passkey mismatch came from an unpinned
// one). Do not change a locale, timezone, or option here — the rendered labels
// are asserted byte-for-byte.
const DAY_OPTIONS = { month: "short", day: "numeric" };
const WEEKDAY_OPTIONS = { weekday: "short", month: "short", day: "numeric" };
const DAY_YEAR_OPTIONS = { month: "short", day: "numeric", year: "numeric" };
const TIME_OPTIONS = { hour: "numeric", minute: "2-digit" };

const formatterCache = new Map();

function formatterFor(options, lang) {
  let byLocale = formatterCache.get(options);
  if (!byLocale) {
    byLocale = new Map();
    formatterCache.set(options, byLocale);
  }
  const locale = localeFor(lang);
  let formatter = byLocale.get(locale);
  if (!formatter) {
    // TIME_OPTIONS renders a clock, so it has to come from the shared helper
    // the three date-only sets stay on the plain tag.
    formatter = options === TIME_OPTIONS
      ? dateTimeFormat(lang, options)
      : new Intl.DateTimeFormat(locale, options);
    byLocale.set(locale, formatter);
  }
  return formatter;
}

// Exported as the conversation-row label so App's demo/optimistic message
// appends produce the SAME string this loader produces — a second unpinned
// Intl formatter is exactly what the comment above forbids.
export function conversationDateLabel(value, lang = "en") {
  return formatterFor(DAY_OPTIONS, lang).format(new Date(value));
}

// Relative counterpart to conversationDateLabel; keep the shared locale policy.
export function relativeDateLabel(value, lang = "en", now = Date.now()) {
  const seconds = (new Date(value).getTime() - Number(now)) / 1000;
  if (!Number.isFinite(seconds)) return "";
  const [unit, divisor] = Math.abs(seconds) < 60 ? ["second", 1]
    : Math.abs(seconds) < 3600 ? ["minute", 60]
      : Math.abs(seconds) < 86400 ? ["hour", 3600] : ["day", 86400];
  return new Intl.RelativeTimeFormat(localeFor(lang), { numeric: "auto" }).format(Math.round(seconds / divisor), unit);
}

function dateLabel(value, lang = "en") {
  return conversationDateLabel(value, lang);
}

function closesLabel(value, lang = "en") {
  if (!value) return translate(lang, "date.open");
  const closes = new Date(value);
  const sameYear = closes.getFullYear() === new Date().getFullYear();
  const options = sameYear ? WEEKDAY_OPTIONS : DAY_YEAR_OPTIONS;
  return translate(lang, "date.closes", { date: formatterFor(options, lang).format(closes) });
}

export function deriveWeekDays(actions, now = new Date()) {
  const labels = ["M", "T", "W", "T", "F", "S", "S"];
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const activeDays = new Set(
    actions.map((item) => {
      const at = new Date(item.occurred_at);
      return `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
    }),
  );
  return labels.map((label, index) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + index);
    const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
    return {
      label,
      dayNumber: day.getDate(),
      active: activeDays.has(key),
      today: day.toDateString() === now.toDateString(),
    };
  });
}

export function deadlineLabel(value, lang = "en") {
  if (!value) return translate(lang, "date.notSet");
  return formatterFor(DAY_OPTIONS, lang).format(new Date(`${value}T12:00:00`));
}

// A case is overdue once its deadline DAY has fully passed — the deadline is a
// date-only column, so it expires at the end of that day, not at
// midnight-start. The day is the one in the zone the deadline was set in
// (member_cases.time_zone,), as Home and the database readers count it,
// and New York's for a row without one; never the browser's. Both loaders call
// this so the two planes can never disagree about the same case; the result
// is always a boolean, because the field is snapshotted offline and indexed
// for search, where a null and a false would count differently.
function isOverdue(item, now = new Date()) {
  if (item.status !== "active" || !item.deadline) return false;
  const zone = isTimeZone(item.time_zone) ? item.time_zone : UNSET_GROUP_TIME_ZONE;
  return String(item.deadline).slice(0, 10) < zoneDay(now, zone);
}

const MEMBER_CASE_COLUMNS = [
  "id", "user_id", "reference", "title", "deadline", "case_type", "articles", "step", "status",
  "created_at", "updated_at", "steward_name", "coordinator_name", "time_zone",
].join(",");

// occurred_on: the date a note is about, carried into the case packet
// (BUG-UG-CASE-NOTE-DATE-MISSING-FROM-EXPORTS-20261102).
const MEMBER_CASE_UPDATE_COLUMNS = ["id", "case_id", "user_id", "body", "occurred_on", "created_at"].join(",");

const CHAPTER_TASK_COLUMNS = [
  "id", "chapter_id", "task_number", "title", "description", "status", "priority",
  "task_type", "workstream", "assignee_id", "assignee_name", "start_date", "due_date", "progress",
  "blocked", "milestone", "order_index", "created_by", "updated_by", "done_at", "created_at", "updated_at",
].join(",");

// Keep the existing authorization, ordering and window during schema rollout.
async function readTaskSettings(query) {
  let result = await query(`${CHAPTER_TASK_COLUMNS},settings_scope`);
  if (["42703", "PGRST204"].includes(result.error?.code) && /\bsettings_scope\b/.test([result.error.message, result.error.details].join(" "))) {
    result = await retryAfterProbe(result, () => query(CHAPTER_TASK_COLUMNS));
  }
  return result;
}

const CHAPTER_TASK_TEMPLATE_DETAIL_COLUMNS = [
  "task_id", "chapter_id", "template_key", "flow_step", "scheduled_on", "starts_at", "ends_at", "venue_mode",
  "review_kind", "reviewer_id", "contact_method", "follow_up_on", "record_category", "record_source",
  "occurred_on", "incident_severity", "created_by", "updated_by", "created_at", "updated_at",
].join(",");

export const CHAPTER_TASK_DEPENDENCY_LIMIT = 4000;


// The chapter each of the member's broadcasts and own cases names, for the
// alternate shell's All updates chapter filter
// (REQ-UG-ALT-MEMBER-PAGES-SERVER-DATA-20261030). The cold-Home reads
// stay as get_member_home_bootstrap serves them; this pair runs only when the
// page opens, under the same RLS and bounds as those reads (the newest 50
// unretracted broadcasts, the member's own cases). A broadcast's chapter is
// where a chapter-audience broadcast went; an organization-audience one also
// stores its publisher's chapter, so the page places it by its audience.
export async function loadRecordChapters(client, userId) {
  const [broadcasts, cases] = await Promise.all([
    client.from("member_broadcasts").select("id,chapter_id").is("retracted_at", null).order("published_at", { ascending: false }).limit(50),
    userId
      ? client.from("member_cases").select("id,chapter_id").eq("user_id", userId).order("updated_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);
  const byId = (rows) => Object.fromEntries(rows.map((row) => [row.id, row.chapter_id ?? null]));
  return { broadcasts: byId(requireData(broadcasts, "Broadcast chapters")), cases: byId(requireData(cases, "Case chapters")) };
}

// The start of the current year in Eastern time, the boundary
// get_member_rewards_summary counts actionsYtd from. January 1 is always
// standard time in New York, so the offset is fixed.
export function easternYearStart(now = new Date()) {
  const year = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" }).format(now);
  return `${year}-01-01T00:00:00-05:00`;
}

// The member's point-earning actions this year, counted the way the rewards
// summary counts actionsYtd (member_point_events since the Eastern year
// start; RLS returns only the caller's rows). The alternate shell's Account
// figures read it when the summary carries no count
// (REQ-UG-ALT-MEMBER-PAGES-SERVER-DATA-20261030).
export async function countMemberActionsThisYear(client, now = new Date()) {
  const result = await client.from("member_point_events")
    .select("id", { count: "exact", head: true })
    .gte("occurred_at", easternYearStart(now));
  if (result.error) throw new MemberApiError("Actions this year", result.error);
  return Number.isInteger(result.count) ? result.count : 0;
}

const CHAPTER_TASK_SUBTASK_COLUMNS = [
  "id", "chapter_id", "parent_task_id", "subtask_id", "created_at",
].join(",");

// The chapter-wide assignment read's row bound.
const CHAPTER_TASK_ASSIGNMENT_LIMIT = 6000;
// #9125: the server returns at most POSTGREST_MAX_ROWS rows whatever the
// limit asks for, so the chapter-wide read is cut short once it returns that
// many (or the limit, if lower). Only then does Home read the member's own
// assignments as well.
const CHAPTER_TASK_ASSIGNMENT_CUT = Math.min(CHAPTER_TASK_ASSIGNMENT_LIMIT, POSTGREST_MAX_ROWS);

const CHAPTER_TASK_ASSIGNMENT_COLUMNS = [
  "id", "task_id", "chapter_id", "assignee_id", "position", "assigned_at",
].join(",");


const CHAPTER_TASK_MESSAGE_COLUMNS = [
  "id", "task_id", "chapter_id", "sender_id", "recipient_id", "body", "created_at",
].join(",");
const CHAPTER_TASK_COMMENT_COLUMNS = [
  "id", "task_id", "chapter_id", "author_id", "body", "mentioned_user_ids", "created_at",
].join(",");

export const TASK_COMMENT_LIMIT = 2000;
export const TASK_COMMENT_PAGE = 1000;

// Field notes are durable task history, not part of the board's 60-day Done
// window. Walk the chapter index newest-first with a two-column keyset and one
// sentinel row so a full 2,000-row result never masquerades as complete.
export async function loadRecentTaskComments(client, chapterId) {
  const scope = String(chapterId || "").trim();
  if (!scope) {
    return { data: [], error: new Error("chapter id unavailable"), truncated: false };
  }
  const rows = [];
  let cursor = null;
  for (let request = 0; request < 3; request += 1) {
    const requestLimit = Math.min(TASK_COMMENT_PAGE, TASK_COMMENT_LIMIT + 1 - rows.length);
    let query = client.from("chapter_task_comments")
      .select(CHAPTER_TASK_COMMENT_COLUMNS)
      .eq("chapter_id", scope)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    if (cursor) {
      query = query.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
      );
    }
    const result = await query.limit(requestLimit);
    if (result.error) {
      return { data: rows.slice(0, TASK_COMMENT_LIMIT), error: result.error, truncated: false };
    }
    const page = result.data ?? [];
    rows.push(...page);
    if (rows.length > TASK_COMMENT_LIMIT) {
      return { data: rows.slice(0, TASK_COMMENT_LIMIT), error: null, truncated: true };
    }
    if (page.length < requestLimit) {
      return { data: rows, error: null, truncated: false };
    }
    const last = page.at(-1);
    cursor = { createdAt: last.created_at, id: last.id };
  }
  throw new Error("task comment keyset walk ended without completeness or sentinel");
}
const CHAPTER_TASK_ATTACHMENT_COLUMNS = [
  "id", "task_id", "chapter_id", "label", "record_url", "created_by", "source_kind", "source_id", "created_at", "updated_at",
].join(",");
const CHAPTER_TASK_FILE_COLUMNS = [
  "id", "task_id", "chapter_id", "bucket_id", "object_name", "filename", "mime_type", "size_bytes", "uploaded_by", "created_at",
].join(",");
const MEMBER_CASE_FILE_COLUMNS = [
  "id", "case_id", "user_id", "bucket_id", "object_name", "filename", "mime_type", "size_bytes", "uploaded_by", "created_at",
].join(",");
const CASE_FILE_PAGE = 500;

async function fetchAllCaseFiles(queryPage) {
  const rows = [];
  for (let from = 0; ; from += CASE_FILE_PAGE) {
    const result = await queryPage(from, from + CASE_FILE_PAGE - 1);
    if (result.error) return { data: null, error: result.error };
    rows.push(...(result.data || []));
    if (!result.data || result.data.length < CASE_FILE_PAGE) return { data: rows, error: null };
  }
}
const MEMBER_FORM_FILE_COLUMNS = "id,form_id,bucket_id,object_name,filename,mime_type,size_bytes,confirmed_at,created_at";
const FORM_FILE_FORMS_PER_QUERY = 100;

// Chunks of form ids read at once): an account with
// many forms waits for a few round trips, not one per hundred forms in turn.
const FORM_FILE_PARALLEL_CHUNKS = 4;

// One chunk's attachment rows, paged to the end by (created_at, id): each page
// starts after the last row of the one before), so a
// row deleted between two pages cannot shift a later row past the cut the way
// an offset page did.
async function fetchFormFileChunk(client, formIds) {
  const rows = [];
  const seen = new Set();
  let after = null;
  for (;;) {
    let query = client.from("member_form_files").select(MEMBER_FORM_FILE_COLUMNS).in("form_id", formIds);
    if (after) query = query.or(`created_at.gt."${after.created_at}",and(created_at.eq."${after.created_at}",id.gt.${after.id})`);
    const result = await query.order("created_at", { ascending: true }).order("id", { ascending: true }).limit(CASE_FILE_PAGE);
    if (result.error) return { data: null, error: result.error };
    const page = result.data || [];
    // Each page must start past the last one's cursor.
    // A page that repeats a row already read (an answer that ignored the
    // keyset filter) would otherwise repeat forever, so the read fails
    // instead. Checked by id, never by comparing timestamp text.
    if (page.some((row) => seen.has(row.id))) return { data: null, error: { message: "Form attachment pages did not advance" } };
    for (const row of page) seen.add(row.id);
    rows.push(...page);
    if (page.length < CASE_FILE_PAGE) return { data: rows, error: null };
    after = page[page.length - 1];
  }
}

// The attachment rows of the given forms, all of them: 100 form ids per query,
// each paged to the end, a few chunks at a time. A failed page fails the read
// (it is soft at the call site, which then marks every form filesUnavailable),
// so a partial list never stands in for the whole. Rows come back in chunk
// order, each chunk by (created_at, id), as when the chunks were read in turn.
export async function fetchFormFilesFor(client, forms) {
  const ids = [...new Set((Array.isArray(forms) ? forms : []).map((form) => form?.id).filter(Boolean))];
  const chunks = [];
  for (let start = 0; start < ids.length; start += FORM_FILE_FORMS_PER_QUERY) chunks.push(ids.slice(start, start + FORM_FILE_FORMS_PER_QUERY));
  const results = new Array(chunks.length);
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && next < chunks.length) {
      const index = next++;
      try {
        results[index] = await fetchFormFileChunk(client, chunks[index]);
      } catch (error) {
        // A chunk that throws stops the other workers
        // taking new chunks, as a returned error does; the read still rejects.
        failure = { data: null, error };
        throw error;
      }
      if (results[index].error) failure = results[index];
    }
  };
  await Promise.all(Array.from({ length: Math.min(FORM_FILE_PARALLEL_CHUNKS, chunks.length) }, worker));
  if (failure) return { data: null, error: failure.error };
  return { data: results.flatMap((result) => result.data), error: null };
}
const CHAPTER_TASK_ACTIVITY_COLUMNS = [
  "id", "task_id", "chapter_id", "actor_id", "action", "from_value", "to_value", "created_at",
].join(",");

// Exported for the realtime board reducer in App.jsx: a broadcast payload
// carries the raw row, and mapping it here is what keeps a card that arrived
// over the socket identical in shape to one that arrived over the boot read.
export function chapterTaskFromRow(row) {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    unitId: row.settings_scope?.unitId ?? null,
    unitName: row.settings_scope?.unitName ?? null,
    // Server-assigned per-chapter number behind the card key (WOR-42). Null
    // only for a chapter the 20260801170000 backfill has not reached, and the
    // key helpers render nothing rather than "WOR-null" in that window.
    taskNumber: row.task_number ?? null,
    title: row.title,
    description: row.description || "",
    status: row.status,
    priority: row.priority,
    taskType: row.task_type || "general",
    workstream: row.workstream,
    assigneeId: row.assignee_id || null,
    assigneeName: row.assignee_name || "",
    startDate: row.start_date,
    dueDate: row.due_date,
    progress: row.progress,
    blocked: row.blocked,
    milestone: row.milestone,
    orderIndex: row.order_index,
    createdBy: row.created_by,
    // Server-stamped by prepare_chapter_task on every write; the modal's
    // history popover renders it next to created_by/created_at.
    updatedBy: row.updated_by || null,
    doneAt: row.done_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function taskTemplateDetailsFromRow(row) {
  return {
    taskId: row.task_id,
    chapterId: row.chapter_id,
    templateKey: row.template_key,
    flowStep: row.flow_step,
    scheduledOn: row.scheduled_on ?? null,
    startsAt: row.starts_at ?? null,
    endsAt: row.ends_at ?? null,
    venueMode: row.venue_mode ?? null,
    reviewKind: row.review_kind ?? null,
    reviewerId: row.reviewer_id ?? null,
    contactMethod: row.contact_method ?? null,
    followUpOn: row.follow_up_on ?? null,
    recordCategory: row.record_category ?? null,
    recordSource: row.record_source ?? null,
    occurredOn: row.occurred_on ?? null,
    incidentSeverity: row.incident_severity ?? null,
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

// Exported for the same reason as chapterTaskFromRow: dependency edges arrive
// over the board broadcast as raw rows, and one mapper keeps a socket edge
// identical in shape to a boot edge.
export function chapterTaskDependencyFromRow(row) {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    taskId: row.task_id,
    dependsOnId: row.depends_on_id,
    createdAt: row.created_at,
  };
}
export function chapterTaskSubtaskFromRow(row) {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    parentTaskId: row.parent_task_id,
    subtaskId: row.subtask_id,
    createdAt: row.created_at,
  };
}


// The member's own assignment rows (read when the chapter-wide read was cut
// short) are added where the chapter-wide rows missed them, on tasks the board has.
function withOwnTaskAssignments(chapterRows, ownRows, taskRows) {
  const rows = Array.isArray(chapterRows) ? chapterRows : [];
  if (!Array.isArray(ownRows) || !ownRows.length) return rows;
  const seen = new Set(rows.map((row) => row.id));
  const boardTasks = new Set((Array.isArray(taskRows) ? taskRows : []).map((row) => row.id));
  const missing = ownRows
    .filter((row) => !seen.has(row.id) && boardTasks.has(row.task_id))
    .map(({ chapter_tasks: _task, ...row }) => row);
  return missing.length ? [...rows, ...missing] : rows;
}

export function chapterTaskAssignmentFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    chapterId: row.chapter_id,
    assigneeId: row.assignee_id,
    position: row.position,
    assignedAt: row.assigned_at,
  };
}

export function withTaskAssignees(task, assignments = [], roster = []) {
  const rosterById = new Map(roster.map((person) => [person.id, person]));
  const ordered = assignments
    .filter((assignment) => assignment.taskId === task.id)
    .sort((a, b) => a.position - b.position);
  const assigneeIds = ordered.length
    ? ordered.map((assignment) => assignment.assigneeId)
    : task.assigneeId ? [task.assigneeId] : [];
  const assigneeNames = assigneeIds
    .map((id) => rosterById.get(id)?.fullName || (id === task.assigneeId ? task.assigneeName : ""))
    .filter(Boolean);
  return {
    ...task,
    assigneeIds,
    assigneeNames,
    assigneeId: assigneeIds[0] || null,
    assigneeName: assigneeNames[0] || "",
  };
}

function chapterTaskWatchFromRow(row) {
  return { taskId: row.task_id };
}


function chapterTaskMessageFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id ?? row.taskId,
    chapterId: row.chapter_id ?? row.chapterId,
    senderId: row.sender_id ?? row.senderId,
    recipientId: row.recipient_id ?? row.recipientId,
    body: row.body,
    createdAt: row.created_at ?? row.createdAt,
  };
}

export function chapterTaskCommentFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id ?? row.taskId,
    chapterId: row.chapter_id ?? row.chapterId,
    authorId: row.author_id ?? row.authorId,
    body: row.body,
    mentionedUserIds: row.mentioned_user_ids ?? row.mentionedUserIds ?? [],
    createdAt: row.created_at ?? row.createdAt,
  };
}

export function chapterTaskAttachmentFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id ?? row.taskId,
    chapterId: row.chapter_id ?? row.chapterId,
    label: row.label,
    recordUrl: row.record_url ?? row.recordUrl,
    createdBy: row.created_by ?? row.createdBy,
    sourceKind: row.source_kind ?? row.sourceKind ?? null,
    sourceId: row.source_id ?? row.sourceId ?? null,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt ?? row.created_at ?? row.createdAt,
  };
}

export function chapterTaskFileFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id ?? row.taskId,
    chapterId: row.chapter_id ?? row.chapterId,
    bucketId: row.bucket_id ?? row.bucketId,
    objectName: row.object_name ?? row.objectName,
    filename: row.filename,
    mimeType: row.mime_type ?? row.mimeType,
    sizeBytes: row.size_bytes ?? row.sizeBytes,
    uploadedBy: row.uploaded_by ?? row.uploadedBy,
    createdAt: row.created_at ?? row.createdAt,
  };
}

export function memberCaseFileFromRow(row) {
  return {
    id: row.id,
    caseId: row.case_id ?? row.caseId,
    userId: row.user_id ?? row.userId,
    bucketId: row.bucket_id ?? row.bucketId,
    objectName: row.object_name ?? row.objectName,
    filename: row.filename,
    mimeType: row.mime_type ?? row.mimeType,
    sizeBytes: row.size_bytes ?? row.sizeBytes,
    uploadedBy: row.uploaded_by ?? row.uploadedBy,
    createdAt: row.created_at ?? row.createdAt,
  };
}

export function memberFormFileFromRow(row) {
  return {
    id: row.id,
    formId: row.form_id ?? row.formId,
    bucketId: row.bucket_id ?? row.bucketId,
    objectName: row.object_name ?? row.objectName,
    filename: row.filename,
    mimeType: row.mime_type ?? row.mimeType,
    sizeBytes: row.size_bytes ?? row.sizeBytes,
    confirmedAt: row.confirmed_at ?? row.confirmedAt ?? null,
    createdAt: row.created_at ?? row.createdAt,
  };
}

export function chapterTaskActivityFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    chapterId: row.chapter_id,
    actorId: row.actor_id,
    action: row.action,
    fromValue: row.from_value,
    toValue: row.to_value,
    createdAt: row.created_at,
  };
}

export function chapterKnowledgeFromRow(row) {
  return {
    id: row.id,
    slug: row.slug,
    chapterId: row.chapter_id ?? row.chapterId ?? null,
    kind: row.kind,
    title: row.title,
    ref: row.article_ref ?? row.ref,
    body: row.body,
    keywords: row.keywords || [],
    orderIndex: row.order_index ?? row.orderIndex ?? 0,
    status: row.status,
    isSample: Boolean(row.is_sample ?? row.isSample),
    version: row.version ?? 1,
    createdBy: row.created_by ?? row.createdBy ?? null,
    updatedBy: row.updated_by ?? row.updatedBy ?? null,
    verifiedBy: row.verified_by ?? row.verifiedBy ?? null,
    verifiedAt: row.verified_at ?? row.verifiedAt ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null,
  };
}

function eventDateLabel(value, lang = "en") {
  return formatterFor(WEEKDAY_OPTIONS, lang).format(new Date(value));
}

function eventTimeLabel(value, lang = "en") {
  return formatterFor(TIME_OPTIONS, lang).format(new Date(value));
}

// The board read is a WINDOW, not an archive: computed per CALL (never at
// module scope, where a long-lived tab would freeze it) and labelled in the UI
// as tasks.window60. Anything older is a reporting question answered by the
// chapter_task_report RPC, never by a bigger select. A function rather than two
// hand-copied expressions, because loadChapterTaskBoard's realtime refetch has
// to see exactly the window the boot load saw — a board that gained rows on
// reconnect that a refresh then dropped is worse than no refetch at all.
function taskWindowFloor(nowMs = Date.now()) {
  return new Date(nowMs - 60 * 86400000).toISOString();
}

export async function loadSampleChapterCatalog(client) {
  const result = await client.rpc("get_sample_chapter_catalog");
  const catalog = softData(result, "SAMPLE chapter catalog", []);
  return Array.isArray(catalog) ? catalog : [];
}

// Trailing 12 ISO-ish weeks of case activity for the Numbers chart, bucketed
// from real rows rather than the hardcoded placeholder that used to sit here.
// A case counts in the week it was created; a case update counts in the week it
// landed, so a long-running grievance still shows the weeks it was worked.
// Index 0 is the oldest week, index 11 the current one — the order the chart
// reads left to right. Rows outside the window are ignored, not clamped into
// the edge buckets, which would invent activity that did not happen.
export function bucketCasesPerWeek(cases, caseUpdates, now = new Date()) {
  const weeks = new Array(12).fill(0);
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const windowStart = weekStart.getTime() - 11 * 7 * 86400000;
  const windowEnd = weekStart.getTime() + 7 * 86400000;
  const add = (value) => {
    const at = new Date(value || "").getTime();
    if (!Number.isFinite(at) || at < windowStart || at >= windowEnd) return;
    weeks[Math.floor((at - windowStart) / (7 * 86400000))] += 1;
  };
  for (const item of cases) add(item.created_at);
  for (const item of caseUpdates) add(item.created_at);
  return { weeks, peak: Math.max(...weeks) };
}

export async function loadMemberApp(client, user, { nowMs = Date.now(), queryNowMs = nowMs } = {}) {
  // Query windows belong to the session cache, while labels and closed/past
  // state belong to the instant this projection is rendered. Keeping those
  // clocks separate lets a warm route reuse the same transport keys without
  // freezing time-sensitive UI state.
  const TASK_DONE_FLOOR = taskWindowFloor(queryNowMs);
  const EVENT_QUERY_ACTIVE_FLOOR = queryNowMs - 6 * 3600000;
  const profileRequest = Promise.resolve(
    client.from("member_profiles").select("*").eq("id", user.id).single(),
  );
  // Start the additive self-only report-card RPC beside the large boot batch
  // without changing its stable numeric request indexes. A pre-migration
  // environment degrades to the honest empty report-card state.
  const reportCardRequest = Promise.resolve(client.rpc("get_my_analytics_report_card"));
  const engagementRequest = Promise.resolve(client.rpc("get_member_engagement_snapshot"));

  const taskCommentsRequest = profileRequest.then((result) => {
    if (result.error || !result.data?.chapter_id) {
      return {
        data: [],
        error: result.error || new Error("chapter id unavailable"),
        truncated: false,
      };
    }
    return loadRecentTaskComments(client, result.data.chapter_id);
  });
  const chapterScopedRequest = (request) => profileRequest.then((result) => {
    // A newly provisioned SaaS account deliberately has no tenant yet. These
    // two definer RPCs reject a missing chapter with 42501, which turns an
    // honest empty state into repeated browser-console 403s. Wait for the
    // already in-flight self profile and do not issue chapter-only requests
    // until onboarding has assigned one.
    if (result.error || !result.data?.chapter_id) return { data: [], error: result.error || null };
    return request();
  });
  const memberEventsRequest = profileRequest.then((result) => {
    if (result.error || !result.data?.chapter_id) {
      return { data: [], error: result.error || null };
    }
    return fetchMemberEventsForChapter(client, result.data.chapter_id, EVENT_QUERY_ACTIVE_FLOOR);
  });
  const chapterStandingRequest = profileRequest.then((result) => {
    // This additive aggregate was the one upstream 500 in the exact-SHA
    // multi-viewport SAMPLE audit. Do not add it to the initial anonymous
    // fanout before the already-running self-profile read confirms a chapter;
    // one bounded transient retry lives in the narrow read helper.
    if (result.error || !result.data?.chapter_id) {
      return { data: null, error: result.error || null };
    }
    return loadChapterStandingWithRetry(client);
  });
  const memberMessagesRequest = Promise.resolve(client.from("member_messages").select("*").eq("user_id", user.id)
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PRIVATE_MESSAGE_WINDOW)).then(privateMessageWindow);
  const channelPostsRequest = Promise.resolve(channelWindowRead(client)).then(channelWindow);
  const taskMessagesRequest = Promise.resolve(client.from("chapter_task_messages").select(CHAPTER_TASK_MESSAGE_COLUMNS)
    .gte("created_at", TASK_DONE_FLOOR).order("created_at").limit(1000));
  // Read reactions only for messages in the visible windows. The RPC
  // rechecks access to all three kinds of message.
  const messageReactionsRequest = Promise.all([memberMessagesRequest, channelPostsRequest, taskMessagesRequest])
    .then(([privateResult, channelResult, taskResult]) => {
      const ids = (result) => Array.isArray(result?.data) ? result.data.map((row) => row.id).filter(Boolean) : [];
      const args = {
        p_private_message_ids: ids(privateResult),
        p_channel_post_ids: ids(channelResult),
        p_task_message_ids: ids(taskResult),
      };
      if (!Object.values(args).some((list) => list.length)) return { data: [], error: null };
      return client.rpc("list_member_message_reactions", args);
    });
  // Every self-scoped read filters explicitly by the signed-in user even
  // though RLS also scopes it: steward-role accounts have permissive read
  // policies on profiles/conversations/messages/steward requests, and the
  // member surface must never widen with them.
  //
  // Every unbounded read also carries an explicit .limit(). PostgREST applies
  // its own max-rows cap silently, and a cap applied to an ASCENDING read hands
  // the member their OLDEST rows — a long-tenured member's newest messages and
  // case updates would simply vanish. So the two long histories are read
  // newest-first and reversed back to chronological at the destructure site.
  // Before the time_zone migration applies, the same self-scoped case read
  // without the column. The failed probe is withdrawn from the session
  // loader first, so a recovered read is not a reload failure; a failed
  // refresh that kept earlier rows reports it as refreshFailure.
  const memberCasesRequest = Promise.resolve(client.from("member_cases").select(MEMBER_CASE_COLUMNS).eq("user_id", user.id).order("updated_at", { ascending: false }).limit(200))
    .then((result) => (missingTimeZoneColumn(result?.error ?? result?.refreshFailure)
      ? retryAfterProbe(result, () => client.from("member_cases").select(withoutTimeZoneColumn(MEMBER_CASE_COLUMNS)).eq("user_id", user.id).order("updated_at", { ascending: false }).limit(200))
      : result));
  // The open step deadlines on the member's own active cases, so My cases and
  // Home show the date staff rank on. Scoped by the member's own case ids.
  // Soft: a failed read leaves each case on its own deadline.
  const stepDeadlinesRequest = memberCasesRequest.then((result) => readOpenStepDeadlines(client,
    (Array.isArray(result?.data) ? result.data : []).filter((row) => row?.status === "active").map((row) => row.id)))
    .catch((error) => ({ data: null, error }));
  const accessibleFormsRequest = fetchAllAccessibleMemberForms(client);
  const requests = await Promise.all([
    profileRequest,
    client.from("member_notifications").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(200),
    client.from("member_conversations").select("*").eq("user_id", user.id).order("updated_at", { ascending: false }).limit(100),
    memberMessagesRequest,
    // audience_scope rides along so the member surface can say which boundary
    // a broadcast was published against. RLS already decides whether the row
    // is visible at all; this is the row explaining itself, not a filter.
    client.from("member_broadcasts").select("id,sender,title,body,published_at,locale,audience_scope").is("retracted_at", null).order("published_at", { ascending: false }).limit(50),
    client.from("member_broadcast_receipts").select("broadcast_id,read_at").eq("user_id", user.id),
    // Explicit self-scope is load-bearing here, not belt-and-braces: the PR4a
    // coordinator policies make these two tables cross-member readable for
    // coordinator-role accounts, and a coordinator's OWN member Cases view
    // must never show other members' cases.
    // Explicit column lists, not `*`: 20260917102000 adds a stored generated
    // tsvector to both tables, and a boot snapshot has no use for a search
    // document it cannot query — `*` would ship one per case and per note.
    memberCasesRequest,
    client.from("member_case_updates").select(MEMBER_CASE_UPDATE_COLUMNS).eq("user_id", user.id).order("created_at", { ascending: false }).limit(1000),
    // Deliberately NOT filtered on closes_at: votability and visibility are
    // different things. The 20260725000000 RPCs refuse a closed ballot/pulse
    // server-side, and planItems marks closed rows so the UI disables the
    // action — but the row itself must keep rendering, because a member's
    // SG- receipt code and the quorum readout live nowhere else in the app,
    // and they matter MOST right after close.
    // Also not filtered on active since 20260809010000: a flag-closed ballot
    // is exactly the one whose published results must render (UB-VOTE-02) —
    // the old .eq("active", true) filter made results unreachable for every
    // explicitly-deactivated ballot ( finding 3). The
    // retention filter below still bounds what actually renders; RLS bounds
    // rows to the member's chapter + union-wide (UB-VOTE-03).
    // No per-ballot choice read here: since 20260808230000 choices live in
    // member_ballot_choices with no voter column, so there is no row a client
    // could self-read — the member's receipt (below) IS the voted state.
    client.from("member_ballots").select("id,title,title_es,body,body_es,closes_at,active,order_index,quorum_target,chapter_id,campaign_state,published_at,closed_at,member_ballot_options(id,ballot_id,label,label_es,order_index)").order("order_index"),
    client.from("member_surveys").select("id,title,title_es,body,body_es,closes_at,active,order_index,chapter_id,campaign_state,published_at,closed_at,member_survey_options(id,survey_id,label,label_es,order_index)").order("order_index"),
    client.from("member_survey_responses").select("survey_id,option_id").eq("user_id", user.id),
    client.from("member_rights_lessons").select("*").order("order_index"),
    client.from("member_rights_progress").select("lesson_id,completed_steps").eq("user_id", user.id),
    client.from("member_steward_requests").select("id,lesson_id,status,created_at").eq("user_id", user.id).order("created_at", { ascending: false }),
    client.from("member_guide_threads").select("id,title,created_at,updated_at").eq("user_id", user.id).order("updated_at", { ascending: false }).limit(30),
    client.from("member_guide_messages").select("id,thread_id,role,body,sources,created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(300),
    // Participation is derived only from verified lifecycle events. Filing a
    // case, voting, asking for help, messaging, or reporting harm is not an
    // engagement score and must never advance a member's recognition state
    // (20260724053134 retired client action-log writes and point minting).
    client.from("member_participation_events").select("activity_kind,rung,source_kind,source_id,occurred_at").eq("user_id", user.id).gte("occurred_at", new Date(queryNowMs - 7 * 86400000).toISOString()).order("occurred_at"),
    client.from("member_ballot_receipts").select("ballot_id,receipt_code,issued_at").eq("user_id", user.id),
    client.rpc("get_member_rewards_summary"),
    client.from("member_roles").select("role").eq("user_id", user.id),
    // Keep complete OWN-chapter and organization-wide histories for attendance
    // and Home, plus a bounded window of upcoming region-public discovery.
    // The requests wait for the already in-flight profile so none walks the
    // complete visible regional archive.
    memberEventsRequest,
    client.from("member_event_rsvps").select("event_id,status").eq("user_id", user.id),
    client.from("member_event_checkins").select("event_id").eq("user_id", user.id),
    client.from("member_workload_logs").select("id,priority,pending,unread_docs,todos,referrals,ce_activities,assistance_requests,aged_cases,weekly_assigned,employment,pt_hours,on_plan,ot_worked,ot_hours,leave_type,leave_timing,half_day,no_intake,note,receipt_code,created_at,sub_details,workload_configuration,workload_values,workload_status").eq("user_id", user.id).order("created_at", { ascending: false }).limit(100),
    client.rpc("get_workload_stats"),
    // RLS returns the caller's forms plus the narrow cross-member read already
    // granted to an accepted alliance-grievance co-signer. Keep user_id only
    // long enough to partition editable owner rows from read-only co-sign rows.
    accessibleFormsRequest,
    // Alliance co-signers (P4b). RLS returns rows on the caller's own forms
    // (filer status list) and rows where the caller is the invitee; both are
    // partitioned client-side. Additive — degrades to [] on error.
    client.from("member_form_cosigners").select("id,form_id,invited_email,cosigner_user_id,status,invited_at,responded_at,signed_at,signature_digest").order("invited_at", { ascending: false }).limit(200),
    // Chapter reference rows resolve the profile's chapter slug to a display
    // name. Additive — degrades to [] so the profile falls back to the slug.
    client.from("chapters").select("id,name").order("order_index"),
    // ALL form template versions from the registry (DB is authoritative; the
    // static FORM_TEMPLATES array is the fallback when this degrades to []).
    // Active rows feed the start tiles; the full version set lets in-flight
    // drafts render under their PINNED version — submit_form validates against
    // the pinned required keys, so rendering the current version instead could
    // ask for a different field set than the server will enforce.
    fetchAllFormTemplates(client, "key,version,label_en,label_es,blurb_en,blurb_es,icon,points,active,sort,field_schema"),
    // Compass knowledge rows are chapter-scoped by RLS. This critical boot
    // corpus is bounded for every hat; complete staff review is independently
    // keyset-paged by the Knowledge workspace. Only verified published rows
    // are admitted to the member Search/answer corpus below.
    client.from("member_kb_articles").select(MEMBER_KNOWLEDGE_COLUMNS)
      .order("order_index").order("id").limit(MEMBER_KNOWLEDGE_LIMIT),
    // Native coordination tasks. Chapter RLS supplies the scope; this remains
    // additive so a frontend/migration rollout cannot blank the member shell.
    // BOUNDED (60 days / 500 rows): open work always loads; done work only
    // while its done_at is inside the window. A chapter a year in would
    // otherwise ship its entire Done column on every boot. Realtime is
    // unaffected — it carries INSERTs, which are always inside the window.
    // status DESCENDING so truncation at the cap eats the least time-critical
    // column first: needs_review, in_progress, done (already windowed), then
    // backlog. Ascending loaded every backlog card before the active columns.
    client.from("chapter_tasks").select(CHAPTER_TASK_COLUMNS).or(`status.neq.done,done_at.gte.${TASK_DONE_FLOOR}`).order("status", { ascending: false }).order("order_index").order("created_at").limit(500),
    // The roster is an identity-safe RPC, not a profile-table read. Task
    // messages are participant-only under RLS. Both are rollout-safe additions.
    chapterScopedRequest(() => client.rpc("list_chapter_task_assignees")),
    taskMessagesRequest,
    // Full product completion surfaces. Each is additive so the existing
    // member shell remains usable while the migration rolls out.
    client.from("chapter_spaces").select("*").is("archived_at", null).order("updated_at", { ascending: false }),
    client.from("chapter_threads").select("*").order("updated_at", { ascending: false }).limit(200),
    // Keep the newest 1,000 replies globally, then restore chronological
    // order per thread below. Ascending + limit silently kept the oldest.
    channelPostsRequest,
    client.from("member_intake_reports").select("*").order("created_at", { ascending: false }).limit(200),
    client.from("chapter_documents").select("*").order("updated_at", { ascending: false }).limit(200),
    client.from("chapter_records").select("*").is("archived_at", null).order("occurred_at", { ascending: false }).limit(300),
    client.from("chapter_handshakes").select("*,union_orgs(name,city,state,affiliation)").order("updated_at", { ascending: false }).limit(100),
    client.from("chapter_governance_requests").select("*").order("created_at", { ascending: false }).limit(100),
    // A public registry entry is not a receiving tenant. Only operator-
    // verified chapter bindings can appear as two-sided handshake targets.
    client.from("chapter_union_org_bindings")
      .select("union_orgs(id,name,city,state,affiliation)")
      .eq("status", "verified")
      .limit(250),
    // Chapter standing for the desktop dashboard tile. The server ships a
    // K-floored BAND over a frozen quarter — the design's ordinal rank is
    // deliberately refused as a comparison oracle (20260728171500). Additive:
    // degrades to null and the dashboard renders without the standing tile.
    // APPEND ONLY: this array is destructured below by hand-written indices.
    chapterStandingRequest,
    // The chapter's own workstream vocabulary (per-chapter entity, staff
    // insertable). The Tasks editor and filter read this list so a chapter's
    // vocabulary is one thing in two places instead of whatever strings happen
    // to exist on cards. Additive: degrades to [] pre-migration, where the
    // view falls back to the strings on the loaded cards.
    client.from("chapter_workstreams").select("id,name").order("name"),
    // Steward appointments (REQ-UG-STEWARD-APPOINTMENTS-20260801). An RPC,
    // not a table read: the definer resolves steward display names without
    // widening member_profiles RLS. Additive — degrades to [] so a
    // pre-migration deploy still renders the member shell.
    client.rpc("get_my_appointments"),
    // The server spends this explicit ceiling only on edges whose endpoints
    // are both in the same 500-card task window, newest first when it binds.
    // Additive — degrades to [] so a pre-migration deploy still renders.
    client.rpc("list_chapter_task_dependencies", { p_limit: CHAPTER_TASK_DEPENDENCY_LIMIT }),
    // Full-task parent/child links and the signed-in member's private watch
    // preferences. The watcher SELECT privilege exposes task_id only, and RLS
    // narrows rows to auth.uid(); no watcher identity enters client state.
    client.from("chapter_task_subtasks").select(CHAPTER_TASK_SUBTASK_COLUMNS).order("created_at").limit(4000),
    client.from("chapter_task_watchers").select("task_id").limit(500),
    // Board-inherited task updates, authorized-record links, and immutable
    // activity. These stay separate from participant-only member Messages.
    taskCommentsRequest,
    client.from("chapter_task_attachments").select(CHAPTER_TASK_ATTACHMENT_COLUMNS).order("created_at").limit(2000),
    client.from("chapter_task_activity").select(CHAPTER_TASK_ACTIVITY_COLUMNS).order("created_at", { ascending: false }).limit(4000),
    // Ordered full assignee sets. The legacy assignee_id remains the primary
    // fallback while this additive table rolls out.
    // #9125: the exact count comes back in the same response (Content-Range),
    // so Home can tell a read the server cut short from a complete one.
    client.from("chapter_task_assignments").select(CHAPTER_TASK_ASSIGNMENT_COLUMNS, { count: "exact" }).order("position").limit(CHAPTER_TASK_ASSIGNMENT_LIMIT),
    // Device-file attachments (additive — degrades to [] pre-migration).
    client.from("chapter_task_files").select(CHAPTER_TASK_FILE_COLUMNS).order("created_at", { ascending: false }).limit(2000),
    // Staff two-step standing (UB-IDN-03 / UB-DESK-04). Self-scoped and
    // role-free by design: when the org policy is on and this member never
    // enrolled, member_has_role refuses them everywhere, so no staff surface
    // can explain the loss — this is the one call that still answers.
    // Additive: degrades to null pre-migration and the hats behave as before.
    client.rpc("get_staff_mfa_standing"),
    // Cross-device My Reports order/visibility/custom definitions. Additive:
    // pre-migration boots use the existing local defaults.
    client.rpc("get_my_report_preferences"),
    // Case attachments stay explicitly self-scoped because coordinator RLS
    // may expose chapter cases while this member surface must remain private.
    fetchAllCaseFiles((from, to) => client.from("member_case_files").select(MEMBER_CASE_FILE_COLUMNS).eq("user_id", user.id)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to)),
    chapterScopedRequest(() => client.rpc("list_weekly_questions")),
    // Official-form attachment metadata. Owner RLS includes every state;
    // signature strokes live in private and never join this browser load.
    // Every attachment of every form this load shows, read completely: the
    // signature names the confirmed attachments on screen, and an
    // oldest-first 1,000-row read missed a newer attachment.
    accessibleFormsRequest.then((forms) => fetchFormFilesFor(client, forms?.data)),
    // RPC-only self preference. Additive during rollout, but a failed read is
    // carried as unavailable so the fourth tab never presents defaults as a
    // successfully loaded schedule.
    client.rpc("get_workload_reminder_preferences"),
    // Unified messaging metadata is reference-only. These additive reads may
    // roll out before their migration; source RLS rechecks the underlying
    // private/channel/task row on every read.
    messageReactionsRequest,
    client.from("member_saved_messages").select("id,source_kind,private_message_id,channel_post_id,task_message_id,saved_at").eq("owner_id", user.id),
    client.from("member_scheduled_messages").select("id,conversation_id,sender_kind,body,scheduled_for,status,failure_reason,created_at").eq("actor_id", user.id).order("scheduled_for"),
    client.from("member_message_reminders").select("id,source_kind,private_message_id,channel_post_id,task_message_id,note,remind_at,status").eq("owner_id", user.id).order("remind_at"),
    client.from("member_message_resources").select("id,message_id,document_id,created_at"),
    client.rpc("list_member_message_activity"),
    // Specialized templates are server-authored and staff/MFA-gated. Preserve
    // these two slots for the hand-written indices below, but defer the RPCs
    // until this boot has resolved the caller's usable roles. Calling them for
    // every ordinary member creates guaranteed 42501 responses and leaks a
    // noisy authorization failure into an otherwise healthy member session.
    Promise.resolve({ data: [], error: null }),
    Promise.resolve({ data: [], error: null }),
    client.from("chapter_task_template_details").select(CHAPTER_TASK_TEMPLATE_DETAIL_COLUMNS),
    // `im-anyone` is a code-based, consent-first member contact workflow. One
    // server projection supplies only the caller's code, their request edges,
    // and accepted conversations; no member directory enters client state.
    client.rpc("list_reward_peer_contact"),
    // Authoritative organization-wide and chapter-scoped hats for the
    // selected membership. Keep this append-only because request indices
    // above are a hand-maintained compatibility contract.
    client.rpc("get_my_chapter_memberships"),
    // Member-safe organization controls: passkey enrollment and allowlisted
    // navigation labels only. No admin setting registry enters member state.
    client.rpc("get_member_organization_configuration"),
    client.from("chapter_space_reads").select("space_id,last_read_at").eq("user_id", user.id),
    // Find my steward: the caller's own chapter stewards with the contact
    // affordances each steward opted into. Soft — a chapter with no steward,
    // or a deployment before the roster RPC exists, renders the empty state
    // rather than failing the whole boot.
    client.rpc("get_member_chapter_stewards"),
    // REQ-UG-REMIND-HERE-20261001: /remind here reminders that reached the
    // caller as channel staff. Soft: Messages shows none if it fails.
    client.rpc("list_channel_here_reminders", { p_limit: 50 }),
    // Union Ground's safe recognition (20260724053134), APPENDED so the
    // hand-written indices above stay fixed: the summary, the five voluntary
    // capacity-building rules, and the member's own verified events. All
    // additive and read-only to the member; the browser has no write grant.
    client.rpc("get_member_recognition_summary"),
    client.from("member_recognition_rules").select("recognition_kind,label_en,label_es,description_en,description_es,weekly_cap").eq("active", true).order("recognition_kind"),
    client.from("member_recognition_events").select("id,recognition_kind,source_label,occurred_at,verified_at").eq("user_id", user.id).order("occurred_at", { ascending: false }).limit(100),
    client.rpc("get_organization_workload_categories"),
    client.rpc("get_organization_workload_configuration"),
  ]);
  const reportCard = softData(await reportCardRequest, "Member analytics report card", null);
  const organizationSurveys = organizationSurveysFromSnapshot(
    softData(await engagementRequest, "Member engagement", null),
  );


  // The profile is a single() read and the whole member identity hangs off it,
  // so a missing row is a failure, not an empty list.
  const profile = requireRow(requests[0], "Profile");
  const lang = profile.language === "es" ? "es" : "en";
  const notifications = requireData(requests[1], "Notifications");
  const conversations = requireData(requests[2], "Conversations");
  // Read newest-first under a cap (see above), restored to chronological here.
  const messages = requireData(requests[3], "Messages");
  const privateEarlier = requests[3].earlierBefore;
  const olderConversations = privateEarlier
    ? await conversationsWithOlderMessages(client, user.id, conversations.map((row) => row.id), privateEarlier)
    : new Set();
  const broadcasts = requireData(requests[4], "Broadcasts");
  const receipts = requireData(requests[5], "Broadcast receipts");
  const cases = requireData(requests[6], "Cases");
  const caseUpdates = [...requireData(requests[7], "Case updates")].reverse();
  const ballots = requireData(requests[8], "Ballots");
  const surveys = requireData(requests[9], "Surveys");
  const responses = requireData(requests[10], "Survey responses");
  const lessons = requireData(requests[11], "Rights lessons");
  const progress = requireData(requests[12], "Rights progress");
  const stewardRequests = requireData(requests[13], "Steward requests");
  const guideThreads = requireData(requests[14], "Guide threads");
  const guideMessages = [...requireData(requests[15], "Guide messages")].reverse();
  const actions = softData(requests[16], "Participation events", []);
  // Rewards, receipts, and roles are additive features: degrade to safe
  // defaults on error instead of blanking the whole member app.
  const ballotReceipts = softData(requests[17], "Ballot receipts", []);
  const rewards = softData(requests[18], "Rewards", {});
  // A roles read that FAILED is not a member with no roles. The degraded []
  // keeps every role-gated surface conservatively closed, but the staff
  // route gate must know the difference: bouncing a steward off their desk
  // over a transient read error is a redirect, not a safety.
  const legacyRolesUnknown = softFailed(requests[19], "Roles");
  const membershipRolesUnknown = softFailed(requests[69], "Organization roles");
  const rolesUnknown = legacyRolesUnknown || membershipRolesUnknown;
  const legacyRoles = legacyRolesUnknown ? [] : (requests[19].data ?? []).map((item) => item.role);
  const membershipRows = membershipRolesUnknown ? [] : requests[69].data ?? [];
  const organizationConfiguration = softData(requests[70], "Organization configuration", null);
  const selectedOrganizationMembership = Array.isArray(membershipRows)
    ? membershipRows.find((item) => item?.selected) ?? null
    : null;
  const grantedRoles = rolesUnknown ? [] : mergeSelectedMembershipRoles(legacyRoles, membershipRows);
  // UB-IDN-03 / UB-DESK-04. member_roles still holds the grant — the org policy
  // suspends what it BUYS, it does not revoke it — but with the policy on and no
  // enrolled factor the server refuses every staff RPC. Rendering the hats
  // anyway would offer a switch that leads only to "admin role required", so the
  // client mirrors the server: no usable role until the factor exists. The
  // explanation lives in Settings, where the fix also lives.
  const staffMfaStanding = softData(requests[53], "Staff two-step standing", null);
  const staffMfaBlocked = Boolean(staffMfaStanding?.blocked);
  const roles = staffMfaBlocked ? [] : grantedRoles;
  const eventRows = softData(requests[20], "Events", []);
  const eventRsvps = softData(requests[21], "Event RSVPs", []);
  const eventCheckins = softData(requests[22], "Event check-ins", []);
  const workloadRows = softData(requests[23], "Workload logs", []);
  const workloadStats = softData(requests[24], "Workload stats", {});
  const formRows = softData(requests[25], "Forms", []);
  // Disclosure for the bounded walk above (SOL-20260813-06): true when the
  // member's own + co-signed forms did not all fit in MEMBER_FORM_MAX_PAGES
  // pages OR a page failed after some were already confirmed. A read that
  // failed on page zero carries no rows and no truncation claim — softData
  // already degraded it to [] above, and "truncated" would falsely promise
  // more exists behind a read that produced nothing.
  const formsTruncated = Boolean(requests[25].truncated);
  const cosignerRows = softData(requests[26], "Form co-signers", []);
  const chapterRows = softData(requests[27], "Chapters", []);
  const chapterNameById = new Map(chapterRows.map((item) => [item.id, item.name]));
  const templateRows = softData(requests[28], "Form template registry", []);
  const kbArticleRows = softData(requests[29], "KB articles", []);
  const recognition = softData(requests[74], "Recognition summary", {}) ?? {};
  const recognitionRuleRows = softData(requests[75], "Recognition rules", []);
  const recognitionEventRows = softData(requests[76], "Recognition events", []);
  // A compromised/over-broad read must not revive the quarantined prototype
  // corpus client-side. Live management rows need a real chapter and may never
  // be samples; the member/search corpus is the verified published subset.
  const chapterKnowledge = kbArticleRows
    .map(chapterKnowledgeFromRow)
    .filter((article) => article.chapterId && !article.isSample);
  const publishedKnowledge = chapterKnowledge.filter((article) =>
    article.status === "published" && article.verifiedBy && article.verifiedAt);
  const chapterTaskRows = softData(requests[30], "Chapter tasks", []);
  const taskAssigneeRows = softData(requests[31], "Task assignees", []);
  const taskMessageRows = softData(requests[32], "Task messages", []);
  const spaceReads = requireData(requests[71], "Chapter read cursors");
  // Find my steward roster. Soft by construction: an empty array is a real
  // answer (a chapter with no steward) and renders the card's empty state.
  const chapterStewards = normalizeChapterStewards(softData(requests[72], "Chapter stewards", []));
  const spaceReadCursor = (id) => spaceReads.find((row) => row.space_id === id)?.last_read_at;
  const spaceRows = softData(requests[33], "Chapter spaces", []);
  const threadRows = softData(requests[34], "Chapter threads", []);
  const threadPostRows = softData(requests[35], "Chapter thread posts", []);
  const threadPostsEarlierBefore = requests[35]?.earlierBefore ?? null;
  const intakeRows = softData(requests[36], "Member intake", []);
  const documentRows = softData(requests[37], "Chapter documents", []);
  const recordRows = softData(requests[38], "Chapter record", []);
  const handshakeRows = softData(requests[39], "Chapter handshakes", []);
  const governanceRows = softData(requests[40], "Governance requests", []);
  const partnerOrgRows = softData(requests[41], "Partner organizations", [])
    .flatMap((row) => row?.union_orgs ? [row.union_orgs] : []);
  const chapterStanding = softData(requests[42], "Chapter standing", null);
  const workstreamRows = softData(requests[43], "Chapter workstreams", []);
  const appointmentRows = softData(requests[44], "Appointments", []);
  const taskDependencyRows = softData(requests[45], "Task dependencies", []);
  const taskSubtaskRows = softData(requests[46], "Task subtasks", []);
  const taskWatchRows = softData(requests[47], "Task watches", []);
  const taskCommentsUnavailable = softFailed(requests[48], "Task comments");
  const taskCommentRows = requests[48].data ?? [];
  const taskCommentsTruncated = !taskCommentsUnavailable && requests[48].truncated === true;
  const taskAttachmentRows = softData(requests[49], "Task authorized records", []);
  const taskActivityRows = softData(requests[50], "Task activity", []);
  const taskFileRows = softData(requests[52], "Task files", []);
  // The chapter-wide assignment read stops at CHAPTER_TASK_ASSIGNMENT_CUT rows
  // (the server's max_rows, #9125), so in a chapter that large it may leave out
  // the member's own assignment and drop the task from Home's "Assigned to you"
  // and the member from the task's assignees. Only then, read the member's own
  // assignments on tasks still open, bounded by the member. Soft: the
  // chapter-wide rows still apply if this read fails.
  const chapterAssignmentRows = softData(requests[51], "Task assignments", []);
  // Cut short when the server counted more rows than it returned. With no
  // count (an older server or a retained snapshot), fall back to the row cap.
  const chapterAssignmentTotal = Number.isInteger(requests[51]?.count) ? requests[51].count : null;
  const chapterAssignmentsCut = chapterAssignmentTotal === null
    ? chapterAssignmentRows.length >= CHAPTER_TASK_ASSIGNMENT_CUT
    : chapterAssignmentTotal > chapterAssignmentRows.length;
  const ownAssignmentRead = chapterAssignmentsCut
    ? await client.from("chapter_task_assignments")
      .select(`${CHAPTER_TASK_ASSIGNMENT_COLUMNS},chapter_tasks!inner(status)`)
      .eq("assignee_id", user.id).neq("chapter_tasks.status", "done")
      // Past 500 open assignments the oldest assigned, the likeliest to be
      // overdue, stay in.
      .order("assigned_at", { ascending: true }).order("id").limit(500)
    : null;
  // The chapter-wide rows still apply, so a failed own read (or a failed
  // refresh after an earlier good one, which carries refreshFailure) is
  // withdrawn from the session registry and raises no "reload failed" alert.
  if (ownAssignmentRead?.error || ownAssignmentRead?.refreshFailure) ownAssignmentRead.withdraw?.();
  const ownAssignmentRows = ownAssignmentRead ? softData(ownAssignmentRead, "Own task assignments", []) : [];
  const taskAssignmentRows = withOwnTaskAssignments(chapterAssignmentRows, ownAssignmentRows, chapterTaskRows);
  const reportPreferencesUnavailable = softFailed(requests[54], "Report preferences");
  const reportPreferences = reportPreferencesUnavailable ? null : requests[54].data ?? null;
  const caseFileRows = softData(requests[55], "Case files", []).map(memberCaseFileFromRow);
  const weeklyQuestionPayload = softData(requests[56], "Weekly questions", []);
  const weeklyQuestions = Array.isArray(weeklyQuestionPayload) ? weeklyQuestionPayload : [];
  const formFileRows = softData(requests[57], "Form files", []);
  const workloadRemindersUnavailable = softFailed(requests[58], "Workload reminders");
  const workloadReminders = workloadRemindersUnavailable
    ? { available: false, reason: "read_error" }
    : { available: true, ...(requests[58].data ?? {}) };
  const messageReactionRows = softData(requests[59], "Message reactions", []);
  const stepDeadlineRows = softData(await stepDeadlinesRequest, "Case step deadlines", []);
  const savedMessageRows = softData(requests[60], "Saved messages", []);
  const scheduledMessageRows = softData(requests[61], "Scheduled messages", []);
  const messageReminderRows = softData(requests[62], "Message reminders", []);
  const messageResourceRows = softData(requests[63], "Message resources", []);
  const messageActivity = softData(requests[64], "Message activity", null);
  const channelReminders = normalizeChannelReminders(softData(requests[73], "Channel reminders", []));
  const taskTemplateDetailRows = softData(requests[67], "Task template details", []);
  const peerContactUnavailable = softFailed(requests[68], "Reward peer contact");
  const peerContactPayload = peerContactUnavailable ? null : requests[68].data;
  const utilityIdField = (sourceKind) => sourceKind === "private" ? "private_message_id" : sourceKind === "channel" ? "channel_post_id" : "task_message_id";
  const utilitiesFor = (sourceKind, messageId) => ({
    reactions: messageReactionRows.filter((reaction) => reaction.source_kind === sourceKind && reaction[utilityIdField(sourceKind)] === messageId),
    saved: savedMessageRows.some((saved) => saved.source_kind === sourceKind && saved[utilityIdField(sourceKind)] === messageId),
    reminder: messageReminderRows.find((reminder) => reminder.source_kind === sourceKind && reminder.status === "pending" && reminder[utilityIdField(sourceKind)] === messageId) || null,
  });
  const mappedTaskMessages = taskMessageRows.map((row) => ({ ...chapterTaskMessageFromRow(row), ...utilitiesFor("task", row.id) }));
  // SEC-UG-MESSAGE-BODY-LIFECYCLE: a saved message or reminder must never
  // become the last place a removed body survives. The projection returns an
  // empty preview plus a translation key for a redacted source.
  const activitySource = (sourceKind, messageId) => {
    if (sourceKind === "private") {
      const row = messages.find((item) => item.id === messageId);
      if (!row) return null;
      const projected = projectMessagePreview(row);
      return { preview: projected.preview, redacted: projected.redacted, noticeKey: projected.noticeKey, targetId: row.conversation_id };
    }
    if (sourceKind === "channel") {
      const row = threadPostRows.find((item) => item.id === messageId);
      return row ? { preview: row.body, redacted: false, noticeKey: null, targetId: row.thread_id } : null;
    }
    const row = taskMessageRows.find((item) => item.id === messageId);
    return row ? { preview: row.body, redacted: false, noticeKey: null, targetId: row.task_id } : null;
  };
  const sourceMessageId = (row) => row.private_message_id || row.channel_post_id || row.task_message_id;
  const savedActivityRows = messageActivity?.saved || savedMessageRows.map((row) => ({ id: row.id, sourceKind: row.source_kind, messageId: sourceMessageId(row), available: true, savedAt: row.saved_at }));
  const reminderActivityRows = messageActivity?.reminders || messageReminderRows.filter((row) => row.status === "pending").map((row) => ({ id: row.id, sourceKind: row.source_kind, messageId: sourceMessageId(row), available: true, remindAt: row.remind_at }));
  const savedMessages = savedActivityRows.map((row) => {
    const fallbackSource = !messageActivity && row.available ? activitySource(row.sourceKind, row.messageId) : null;
    const targetId = messageActivity ? row.targetId : fallbackSource?.targetId;
    return { id: row.id, messageId: row.messageId, sourceKind: row.sourceKind, available: Boolean(row.available && targetId), preview: fallbackSource?.preview || "", redacted: Boolean(fallbackSource?.redacted), noticeKey: fallbackSource?.noticeKey || null, targetId: targetId || null, savedAt: row.savedAt };
  });
  const messagingReminders = reminderActivityRows.map((row) => {
    const fallbackSource = !messageActivity && row.available ? activitySource(row.sourceKind, row.messageId) : null;
    const targetId = messageActivity ? row.targetId : fallbackSource?.targetId;
    return { id: row.id, messageId: row.messageId, sourceKind: row.sourceKind, available: Boolean(row.available && targetId), preview: fallbackSource?.preview || "", redacted: Boolean(fallbackSource?.redacted), noticeKey: fallbackSource?.noticeKey || null, targetId: targetId || null, remindAt: row.remindAt };
  });
  const mappedTaskAssignees = taskAssigneeRows.map((row) => ({
    id: row.user_id,
    fullName: row.full_name,
    initials: row.initials || "",
  }));
  const mappedTaskAssignments = taskAssignmentRows.map(chapterTaskAssignmentFromRow);
  // Intake owners are not the full task-assignee roster: report details are
  // staff-scoped, so exposing every chapter member as an owner would create an
  // assignment the assignee cannot read. Resolve only authorized intake staff
  // after the caller's own roles are known, and do not fire a guaranteed 42501
  // for ordinary members.
  const intakeOwnerRows = roles.some((role) => ["steward", "coordinator"].includes(role))
    ? softData(await client.rpc("list_intake_triage_owners"), "Intake owners", [])
    : [];
  const intakeOwners = intakeOwnerRows.map((row) => ({
    id: row.user_id,
    fullName: row.full_name,
    initials: row.initials || "",
  }));
  // Steward rail badge counts: fetched AFTER the fan-out and only for steward
  // role holders — the RPC is role-gated server-side, so firing it for every
  // member boot would buy nothing but a guaranteed 42501 per session.
  const stewardBadges = roles.includes("steward")
    ? softData(await client.rpc("get_steward_badge_counts"), "Steward badges", null)
    : null;
  // The catalog functions intentionally reject ordinary members, staff whose
  // current session is not MFA-assured, and callers whose standing could not
  // be resolved. Fetch only after both role and assured-standing reads
  // succeeded so member boot never speculatively trips those boundaries.
  const canReadTaskTemplates = Boolean(staffMfaStanding?.assured)
    && roles.some((role) => ["steward", "coordinator", "advisor", "admin", "vp"].includes(role));
  const [taskTemplateResult, taskTemplateReviewerResult] = canReadTaskTemplates
    ? await Promise.all([
        client.rpc("list_chapter_task_templates"),
        client.rpc("list_chapter_task_template_reviewers"),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  const taskTemplates = softData(taskTemplateResult, "Task templates", []);
  const taskTemplateReviewerPayload = softData(taskTemplateReviewerResult, "Task template reviewers", []);
  const taskTemplateReviewers = (Array.isArray(taskTemplateReviewerPayload) ? taskTemplateReviewerPayload : [])
    .map((reviewer) => ({ id: reviewer?.id, fullName: reviewer?.fullName || reviewer?.full_name || "" }))
    .filter((reviewer) => reviewer.id && reviewer.fullName);
  const rsvpByEvent = new Map(eventRsvps.map((item) => [item.event_id, item.status]));
  const checkedInEvents = new Set(eventCheckins.map((item) => item.event_id));
  const receiptByBallot = new Map(ballotReceipts.map((item) => [item.ballot_id, item.receipt_code]));
  // Closed-item retention: a closed ballot/pulse
  // stays in the plan read-only when the member participated — their receipt
  // or answer is the artifact that must survive close — or while the close is
  // recent enough that the outcome is still news. An old closed item nobody
  // acted on would just accumulate forever (nothing flips active=false at
  // close), so it drops out. Filtering HERE, before the tally fan-out, also
  // bounds get_ballot_tally to rows that will actually render instead of
  // every historically-closed ballot.
  const isClosed = (closesAt) => Boolean(closesAt) && new Date(closesAt).getTime() <= nowMs;
  const CLOSE_GRACE_MS = 14 * 86400000;
  const closedRecently = (closesAt) => isClosed(closesAt) && nowMs - new Date(closesAt).getTime() <= CLOSE_GRACE_MS;
  const answeredSurveys = new Set(responses.map((item) => item.survey_id));
  // Ballot retention unified for both close paths (20260809010000): keep a
  // ballot while its scheduled close is open or within the 14-day grace, and
  // keep a participant's ballot forever (their receipt lives nowhere else).
  // A flag-closed ballot whose closes_at is still in the future stays in the
  // window too — it was closed early and its results are the news.
  const keptBallots = ballots.filter((item) => receiptByBallot.has(item.id) || nowMs - new Date(item.closed_at || item.closes_at).getTime() <= CLOSE_GRACE_MS);
  const keptSurveys = surveys.filter((item) => {
    const closed = item.active === false || item.campaign_state === "closed" || isClosed(item.closes_at);
    return !closed || answeredSurveys.has(item.id) || closedRecently(item.closed_at || item.closes_at);
  });
  const tallyByBallot = new Map();
  const tallies = await Promise.all(keptBallots.map((item) => client.rpc("get_ballot_tally", { p_ballot_id: item.id })));
  tallies.forEach((tallyResult) => {
    if (!tallyResult.error && tallyResult.data?.ballotId) tallyByBallot.set(tallyResult.data.ballotId, tallyResult.data);
  });
  // REQ-UG-OFFICER-REMOVAL-BALLOTS-20261001: the officer, reason and
  // recorded result of a published removal ballot. Soft and additive: no
  // details means the ballot renders as before.
  const removalByBallot = keptBallots.length > 0
    ? (await loadOfficerRemovalDetails(client, keptBallots.map((item) => item.id))).byId
    : new Map();

  // Alliance co-signers: split the RLS-returned rows into the filer's own
  // status lists (keyed by form id) and the caller's incoming invitations. The
  // invitee can never read the grievance pre-accept, so the one-line summary +
  // filer name come from the security-definer preview RPC, one bounded call per
  // invite (co-signer counts are tiny — capped at 10 per form).
  // Rows from older test/offline fixtures omit user_id and are necessarily the
  // caller's own. Real PostgREST rows always carry it from the select above.
  const ownedFormRows = formRows.filter((row) => row.user_id == null || row.user_id === user.id);
  const ownedFormAnswers = await hydrateSealedFormAnswers(client, ownedFormRows);
  const readableCosignedForms = new Map(
    formRows.filter((row) => row.user_id != null && row.user_id !== user.id).map((row) => [row.id, row]),
  );
  const myFormIds = new Set(ownedFormRows.map((row) => row.id));
  const myEmail = (user.email || "").toLowerCase();
  const cosignersByForm = new Map();
  for (const row of cosignerRows) {
    if (!myFormIds.has(row.form_id)) continue;
    if (!cosignersByForm.has(row.form_id)) cosignersByForm.set(row.form_id, []);
    cosignersByForm.get(row.form_id).push({
      id: row.id,
      email: row.invited_email,
      status: row.status,
      invitedAt: row.invited_at,
      respondedAt: row.responded_at,
      signedAt: row.signed_at,
      signatureDigest: row.signature_digest,
    });
  }
  const myInviteRows = cosignerRows.filter((row) =>
    !myFormIds.has(row.form_id)
    && (row.cosigner_user_id === user.id || (row.invited_email || "").toLowerCase() === myEmail)
    && ["invited", "reaffirm_needed", "accepted"].includes(row.status));
  // Through the exported wrapper, not a second inline copy of the same RPC
  // call: the wrapper is what the co-signer tests exercise, so a divergence
  // between the two would be invisible. The catch preserves the intentional
  // degrade — one unreadable preview must not blank the whole member app.
  const invitePreviews = await Promise.all(
    myInviteRows.map((row) => cosignInvitePreview(client, row.form_id).catch(() => ({}))),
  );
  const cosignRequests = myInviteRows.map((row, index) => {
    const preview = invitePreviews[index] || {};
    const readableGrievance = row.status === "accepted" ? readableCosignedForms.get(row.form_id) : null;
    return {
      formId: row.form_id,
      status: row.status,
      summary: preview.summary || "",
      filerName: preview.filerName || "",
      invitedAt: row.invited_at,
      grievance: readableGrievance ? {
        id: readableGrievance.id,
        templateKey: readableGrievance.template_key,
        templateVersion: readableGrievance.template_version ?? 1,
        status: readableGrievance.status,
        answers: readableGrievance.answers || {},
        reviewNote: readableGrievance.review_note || "",
        submittedAt: readableGrievance.submitted_at,
      } : null,
      signedAt: row.signed_at,
      signatureDigest: row.signature_digest,
    };
  });
  // Both platforms consume the server aggregate; the body response is capped.
  const summaryResult = conversations.length
    ? await client.from("member_conversation_summaries")
      .select("conversation_id,latest_message,unread_count")
      .in("conversation_id", conversations.map((row) => row.id))
    : { data: [], error: null };
  const summaries = new Map(requireData(summaryResult, "Conversation summaries")
    .map((row) => [row.conversation_id, row]));
  const latestByConversation = new Map();
  for (const message of messages) latestByConversation.set(message.conversation_id, message);
  const readBroadcasts = new Set(receipts.map((item) => item.broadcast_id));
  const surveyResponses = new Map(responses.map((item) => [item.survey_id, item.option_id]));
  const progressByLesson = new Map(progress.map((item) => [item.lesson_id, item.completed_steps || []]));
  // The member's lesson copy in the member's language (UB-RGT-04). Spanish
  // lives in sibling columns on the same row since 20260812120000, so it no
  // longer arrives only when the row is MISSING — which is what the
  // Section 7 fallback path below is, and why a Spanish reader used to get
  // English lesson bodies whenever the seeded rows were present, i.e. always.
  //
  // `??` per field, not `?? item` wholesale: during a rollout where the client
  // is ahead of the database the es columns are absent, and English copy the
  // member can at least act on beats a blank walkthrough. `label` is the
  // client-side join key and stays English by design — see the migration.
  const localizedLesson = (item) => (lang === "es"
    ? {
        title: item.title_es ?? item.title,
        description: item.description_es ?? item.description,
        steps: item.steps_es ?? item.steps,
        script: item.script_es ?? item.script,
      }
    : { title: item.title, description: item.description, steps: item.steps, script: item.script });
  const activeCases = cases.filter((item) => item.status === "active");
  const resolvedCases = cases.filter((item) => item.status === "resolved");
  const casesPerWeek = bucketCasesPerWeek(cases, caseUpdates);
  const actionDone = new Set(actions.map((item) => item.source_id).filter(Boolean));
  const planItems = [];
  // `closed` is derived at build time with the same boundary the server guard
  // uses (closes_at <= now refuses). A kept closed row renders read-only: the
  // receipt code and quorum line must survive close — that is the whole point
  // of the receipt submit_ballot_vote issues. No selectedOption on ballots:
  // choices are stored unlinkably (20260808230000), so the receipt is the
  // only voted state a ballot item can carry, and the UI must never claim to
  // know WHICH option was picked. The meta keeps the close DATE and appends
  // the state; members search by date and the search index reads this string.
  for (const ballot of keptBallots) {
    const tally = tallyByBallot.get(ballot.id) || null;
    // Closure truth prefers the server: an explicit active=false flag or a
    // tally that shipped the per-option array (the server emits it only for
    // closed ballots, on database time) closes the item even when this
    // device's clock lags; the local closes_at check covers the tally-error
    // path. A fast local clock can still mark the item closed early — the
    // server refuses the vote either way — but it cannot conjure results the
    // server has not published ( finding 4).
    const results = Array.isArray(tally?.options) ? tally.options.map((option) => ({
      ...option,
      label: lang === "es" ? (option.labelEs || option.label) : option.label,
    })) : null;
    const closed = ballot.active === false || Boolean(results) || isClosed(ballot.closes_at);
    planItems.push({
      id: ballot.id,
      kind: "ballot",
      title: lang === "es" ? (ballot.title_es || ballot.title) : ballot.title,
      body: lang === "es" ? (ballot.body_es || ballot.body || "") : (ballot.body || ""),
      meta: closed ? `${closesLabel(ballot.closes_at, lang)} · ${translate(lang, "data.closed")}` : closesLabel(ballot.closes_at, lang),
      // A voted-then-closed ballot keeps saying "Voted" — the member's own
      // state outranks the ballot's; "Closed" is for the row they never acted on.
      action: receiptByBallot.has(ballot.id)
        ? translate(lang, "data.voted")
        : closed ? translate(lang, "data.closed") : translate(lang, "data.vote"),
      closed,
      closesAt: ballot.closes_at,
      options: [...ballot.member_ballot_options].sort((a, b) => a.order_index - b.order_index).map((option) => ({
        ...option,
        label: lang === "es" ? (option.label_es || option.label) : option.label,
      })),
      receiptCode: receiptByBallot.get(ballot.id) || "",
      officerRemoval: removalByBallot.get(ballot.id) ?? null,
      quorum: tally
        ? { totalVotes: tally.totalVotes, quorumTarget: tally.quorumTarget }
        : null,
      // Per-option results exist only after close: get_ballot_tally emits the
      // options array the moment a vote can no longer be cast (inactive or
      // closes_at passed; 20260925030300) and never while voting is open, so
      // the server's emission IS the publication decision — no client clock
      // in the way.
      results,
    });
  }
  for (const survey of keptSurveys) {
    const closed = survey.active === false || survey.campaign_state === "closed" || isClosed(survey.closes_at);
    planItems.push({
      id: survey.id,
      kind: "pulse",
      title: lang === "es" ? (survey.title_es || survey.title) : survey.title,
      body: lang === "es" ? (survey.body_es || survey.body || "") : (survey.body || ""),
      meta: `${translate(lang, "data.pulseMeta")} · ${closesLabel(survey.closes_at, lang)}${closed ? ` · ${translate(lang, "data.closed")}` : ""}`,
      action: surveyResponses.has(survey.id)
        ? translate(lang, "data.answered")
        : closed ? translate(lang, "data.closed") : translate(lang, "data.answer"),
      closed,
      options: [...survey.member_survey_options].sort((a, b) => a.order_index - b.order_index).map((option) => ({
        ...option,
        label: lang === "es" ? (option.label_es || option.label) : option.label,
      })),
      selectedOption: surveyResponses.get(survey.id) || "",
    });
  }
  // Open items stay on top; closed read-only rows sink below them. Stable
  // sort, so relative order within each group is preserved.
  planItems.sort((a, b) => Number(Boolean(a.closed)) - Number(Boolean(b.closed)));
  // Organizing rights lead with NLRA Section 7, not Weingarten: most workers on
  // a campaign have no union representative to ask for yet. The member's own
  // language comes from the row's sibling columns; the Section 7 walkthrough is
  // the last resort when the campaign has no lesson row at all.
  const featuredLesson = lessons.find((item) => item.id === "section-7" || item.id === "weingarten") || lessons[0];
  const featuredLocalized = featuredLesson ? localizedLesson(featuredLesson) : {};
  const featuredText = {
    title: featuredLocalized.title ?? RIGHTS_FALLBACK.title,
    description: featuredLocalized.description ?? RIGHTS_FALLBACK.description,
    steps: featuredLocalized.steps ?? RIGHTS_FALLBACK.steps,
    script: featuredLocalized.script ?? RIGHTS_FALLBACK.script,
  };
  if (featuredLesson) {
    planItems.push({
      id: featuredLesson.id,
      kind: "lesson",
      title: translate(lang, "data.knowYourRights", { lesson: featuredLesson.label }),
      meta: featuredText.description,
      action: progressByLesson.get(featuredLesson.id)?.length ? translate(lang, "data.continue") : translate(lang, "data.start"),
    });
  }

  return {
    organizationConfiguration,
    member: {
      id: user.id,
      email: user.email,
      firstName: profile.first_name,
      fullName: profile.full_name,
      initials: profile.initials,
      roleLine: profile.role_line,
      sinceYear: profile.member_since,
      chapterId: profile.chapter_id || "",
      organizationId: selectedOrganizationMembership?.organizationId || null,
      organizationRoles: Array.isArray(selectedOrganizationMembership?.organizationRoles)
        ? selectedOrganizationMembership.organizationRoles
        : [],
      chapterRoles: Array.isArray(selectedOrganizationMembership?.chapterRoles)
        ? selectedOrganizationMembership.chapterRoles
        : [],
      membershipStatus: selectedOrganizationMembership ? "active" : null,
      chapterName: chapterNameById.get(profile.chapter_id) || profile.chapter_id || "", chapterMemberships: memberChapterMemberships(membershipRows),
      language: lang,
      notificationPrefs: profile.notification_prefs ?? DEFAULT_NOTIFICATION_PREFS,
      shortcutKeys: Array.isArray(profile.shortcut_keys) ? profile.shortcut_keys : [],
      workWidgetOrder: Array.isArray(profile.work_widget_order) ? profile.work_widget_order : [],
      dndEnabled: profile.dnd_enabled ?? false,
      quietHoursStart: profile.quiet_hours_start || "",
      quietHoursEnd: profile.quiet_hours_end || "",
      quietHoursTimezone: profile.quiet_hours_timezone || "America/New_York",
      urgentNotificationsEnabled: profile.urgent_notifications_enabled ?? true,
      notificationCount: notifications.filter((item) => !item.read_at).length,
    },
    notifications,
    weekly: { done: actions.length, goal: null, streakDays: 0 },
    weekDays: deriveWeekDays(actions),
    // Union Ground has no points economy. get_member_rewards_summary is
    // still the one source of the "actions this year" count My Reports and the
    // Work numbers widget show, so only that count crosses into the snapshot.
    // Null (not 0) when the server does not supply it: the dashboard then
    // falls back to the seven-day count, never renders "0 actions".
    rewards: {
      actionsYtd: rewards?.actionsYtd ?? null,
    },
    chapterStanding,
    stewardBadges,
    reportPreferences,
    reportPreferencesUnavailable,
    reportCard,
    recognition: {
      totalVerified: recognition.totalVerified ?? 0,
      recentVerified: recognition.recentVerified ?? 0,
      currentRung: recognition.currentRung ?? "learn",
      retiredPointsHidden: recognition.retiredPointsHidden ?? true,
    },
    recognitionCatalog: {
      rules: recognitionRuleRows.map((row) => ({
        recognitionKind: row.recognition_kind,
        label: lang === "es" ? row.label_es : row.label_en,
        description: lang === "es" ? row.description_es : row.description_en,
        weeklyCap: row.weekly_cap ?? null,
      })),
      events: recognitionEventRows.map((row) => ({
        id: row.id,
        recognitionKind: row.recognition_kind,
        sourceLabel: row.source_label,
        occurredAt: row.occurred_at,
        verifiedAt: row.verified_at,
      })),
    },
    weeklyQuestions: weeklyQuestions.map((question) => ({
      id: question.id,
      body: question.body,
      options: Array.isArray(question.options) ? question.options : [],
      editorialState: question.editorialState || "submitted",
      submittedByMe: Boolean(question.submittedByMe),
      boostedByMe: Boolean(question.boostedByMe),
      promotedByMe: Boolean(question.promotedByMe),
      promotionAvailable: Boolean(question.promotionAvailable),
      priority: Boolean(question.priority),
      score: Number(question.score) || 0,
      createdAt: question.createdAt,
    })),
    peerContact: peerContactPayload && typeof peerContactPayload === "object"
      ? peerContactPayload
      : { available: false, unavailable: peerContactUnavailable, canRequest: false, code: "", incoming: [], outgoing: [], conversations: [] },
    planItems,
    organizationSurveys,
    chapterStewards,
    conversations: conversations.map((item) => {
      const latest = latestByConversation.get(item.id);
      return {
        id: item.id,
        // member_conversations is the steward-only member boundary. Keep its
        // role provenance separate from the mutable/localized display title.
        counterpartRole: "steward",
        // Null for every thread opened outside a steward card, including every
        // row minted before the column existed. selectStewardConversation reads
        // it so a per-steward Contact control cannot land in another steward's
        // thread; null keeps the canonical-thread rule for the unscoped case.
        stewardUserId: item.steward_user_id ?? null,
        sender: item.title === "Chapter steward" ? translate(lang, "inbox.chapterSteward") : item.title,
        initials: item.initials,
        preview: summaries.get(item.id)?.latest_message ?? latest?.body ?? translate(lang, "data.startConversation"),
        dateLabel: latest ? dateLabel(latest.created_at, lang)
          : olderConversations.has(item.id) && item.updated_at ? dateLabel(item.updated_at, lang) : translate(lang, "data.now"),
        unread: summaries.get(item.id)?.unread_count ?? 0,
        messages: messages.filter((message) => message.conversation_id === item.id).map((message) => ({
          ...message,
          reactions: messageReactionRows.filter((reaction) => reaction.private_message_id === message.id),
          saved: savedMessageRows.some((saved) => saved.private_message_id === message.id),
          reminder: messageReminderRows.find((reminder) => reminder.private_message_id === message.id && reminder.status === "pending") || null,
          resource: (() => {
            const link = messageResourceRows.find((resource) => resource.message_id === message.id);
            if (!link) return null;
            const document = documentRows.find((entry) => entry.id === link.document_id);
            return document ? { id: link.id, documentId: link.document_id, title: document.title, documentType: document.document_type } : null;
          })(),
        })),
        scheduled: scheduledMessageRows.filter((scheduled) => scheduled.conversation_id === item.id && scheduled.status === "pending"),
        earlierCursor: olderConversations.has(item.id) ? privateEarlier : null,
      };
    }),
    broadcasts: broadcasts.map((item) => ({
      id: item.id,
      sender: item.sender,
      title: item.title,
      body: item.body,
      publishedAt: item.published_at,
      // Rows minted before the locale column (and the demo fixtures) are
      // English content, so "en" is the honest default, not a guess.
      locale: item.locale || "en",
      // Quarantined pre-MI1 rows carry no audience. They are not readable
      // through RLS either, so null here means "unknown", never "everyone".
      audience: item.audience_scope || null,
      unread: !readBroadcasts.has(item.id),
    })),
    metrics: {
      casesHandled: cases.length,
      tasksDone: actions.length,
      openCases: activeCases.length,
      resolvedCases: resolvedCases.length,
      caseTypes: [...new Set(cases.map((item) => item.case_type))].map((label) => ({ label, value: cases.filter((item) => item.case_type === label).length })),
      weeks: casesPerWeek.weeks,
      weeksPeak: casesPerWeek.peak,
    },
    // Union Ground leaves ULP and legal filing deadlines out (owner
    // decision, 2026-10-13): a campaign without a contract must never see an
    // "unfair labor practice" label or a countdown the product cannot source,
    // so the case summary carries no ULP or retaliation-flag fields and no
    // deadline RPC is called.
    cases: withNextDeadlines(cases, stepDeadlineRows).map((item) => ({
      id: item.id,
      reference: item.reference,
      title: item.title,
      deadline: deadlineLabel(item.deadline, lang),
      deadlineValue: item.deadline || "",
      nextDeadline: item.nextDeadline,
      type: item.case_type,
      articles: item.articles,
      step: item.step,
      status: item.status,
      overdue: isOverdue(item),
      // Server-stamped display names (assign_member_case): a member cannot
      // read other profiles, so the names ride on the row or nowhere.
      stewardName: item.steward_name || "",
      coordinatorName: item.coordinator_name || "",
      // Same assignee pair the coordinator loader ships (no ids are readable
      // from this shape), so the demo hat's queue facet keys the same way.
      assigneeName: item.steward_name || item.coordinator_name || "",
      updates: caseUpdates.filter((update) => update.case_id === item.id),
      files: caseFileRows.filter((file) => file.caseId === item.id),
    })),
    rights: {
      selected: featuredLesson?.label || RIGHTS_FALLBACK.label,
      lessons: lessons.map((item) => item.label),
      lessonRecords: lessons.map((item) => ({
        id: item.id,
        label: item.label,
        ...localizedLesson(item),
        completedSteps: progressByLesson.get(item.id) || [],
      })),
      eyebrow: translate(lang, "data.rightsEyebrow", { lesson: featuredLesson?.label || RIGHTS_FALLBACK.label }),
      // In the member's language when the row carries it. This is the sentence
      // they say out loud to a supervisor.
      title: featuredText.title,
      description: featuredText.description,
      steps: featuredText.steps,
      script: featuredText.script,
    },
    guideThreads: guideThreads.map((thread) => ({
      ...thread,
      messages: guideMessages.filter((message) => message.thread_id === thread.id),
    })),
    stewardRequests,
    actionKeys: [...actionDone],
    roles,
    // "Could not read who this member is" is a different fact from "this
    // member holds no roles" — the staff route gate branches on it.
    rolesUnknown,
    // Null pre-migration. `blocked` is the only field the shell acts on; the
    // rest let Settings say WHICH of the three conditions is unmet instead of
    // "something about two-step sign-in".
    staffMfa: staffMfaStanding === null ? null : {
      required: Boolean(staffMfaStanding.requireStaffMfa),
      holdsStaffRole: Boolean(staffMfaStanding.holdsStaffRole),
      enrolled: Boolean(staffMfaStanding.enrolled),
      blocked: staffMfaBlocked,
      // The roles the policy is currently withholding. Named so Settings can
      // say what will come back, and so nothing downstream has to reconstruct
      // it from a `roles` array this loader has already emptied.
      suspendedRoles: staffMfaBlocked ? grantedRoles : [],
    },
    events: eventRows.map((item) => ({
      id: item.id,
      title: item.title,
      startsAt: item.starts_at,
      ...eventModelFields(item),
      ...eventModelLabels({ ...eventModelFields(item), startsAt: item.starts_at }, lang),
      location: item.location,
      summary: item.summary,
      checkInOffered: item.check_in_offered === true,
      cancelledAt: item.cancelled_at ?? null,
      cancelledReason: item.cancelled_reason ?? null,
      chapterId: item.chapter_id,
      chapterName: chapterNameById.get(item.chapter_id) || item.chapter_id || "",
      isPublic: Boolean(item.is_public),
      isPublicAcrossAgencies: Boolean(item.is_public_across_agencies),
      rsvpStatus: rsvpByEvent.get(item.id) || null,
      checkedIn: checkedInEvents.has(item.id),
      isPast: eventIsPast({ ...eventModelFields(item), startsAt: item.starts_at }, nowMs),
    })),
    workload: {
      entries: workloadRows.map((item) => ({
        id: item.id,
        createdAt: item.created_at,
        configurationSnapshot: item.workload_configuration ?? null,
        values: item.workload_values ?? null,
        status: item.workload_status ?? null,
        receipt: item.receipt_code,
        counts: {
          priority: item.priority, pending: item.pending, unread_docs: item.unread_docs,
          todos: item.todos, referrals: item.referrals, ce_activities: item.ce_activities,
          assistance_requests: item.assistance_requests, aged_cases: item.aged_cases,
        },
        meta: [
          item.weekly_assigned != null ? translate(lang, "workload.metaNewThisWeek", { count: item.weekly_assigned }) : null,
          item.employment === "part_time"
            ? item.pt_hours == null ? translate(lang, "workload.partTime") : translate(lang, "workload.metaPartTime", { hours: item.pt_hours })
            : item.employment === "full_time" ? translate(lang, "workload.metaFullTime") : null,
          item.ot_worked && item.ot_hours != null ? translate(lang, "workload.metaOt", { hours: item.ot_hours }) : null,
          item.on_plan ? translate(lang, "workload.metaOnPlan") : null,
          item.half_day ? translate(lang, "workload.metaHalfDay") : null,
          item.no_intake ? translate(lang, "workload.metaNoIntake") : null,
          item.leave_type ? (item.leave_timing ? `${item.leave_type} · ${item.leave_timing}` : item.leave_type) : null,
        ].filter(Boolean).join(" · "),
        note: item.note || "",
        dateLabel: eventDateLabel(item.created_at, lang),
        workedOn: typeof item.sub_details?.workedOn === "string" ? item.sub_details.workedOn : null,
        hoursWorked: item.sub_details?.hoursWorked != null && Number.isFinite(Number(item.sub_details.hoursWorked))
          ? Number(item.sub_details.hoursWorked) : null,
      })),
      stats: workloadStats,
      reminders: workloadReminders,
      categories: softData(requests[77], "Workload categories", null),
      configuration: softData(requests[78], "Workload configuration", null),
    },
    formTemplates: resolveFormTemplates(currentFormTemplateRows(templateRows).filter((row) => row.active), lang, { loaded: !requests[28].error }),
    // Every version (resolved to the member's language) for pinned-version
    // rendering; [] means "fall back to the static template by key".
    formTemplateVersions: templateRows.map((row) => templateFromDbRow(row, lang)),
    kbArticles: publishedKnowledge,
    tasks: chapterTaskRows
      .map(chapterTaskFromRow)
      .map((task) => withTaskAssignees(task, mappedTaskAssignments, mappedTaskAssignees)),
    taskTemplates: Array.isArray(taskTemplates) ? taskTemplates : [],
    taskTemplateReviewers,
    taskTemplateDetails: taskTemplateDetailRows.map(taskTemplateDetailsFromRow),
    taskAssignees: mappedTaskAssignees,
    intakeOwners,
    taskAssignments: mappedTaskAssignments,
    taskMessages: mappedTaskMessages,
    savedMessages,
    messageReminders: messagingReminders,
    channelReminders,
    taskDependencies: taskDependencyRows.map(chapterTaskDependencyFromRow),
    workstreams: workstreamRows.map((row) => ({ id: row.id, name: row.name })),
    taskSubtasks: taskSubtaskRows.map(chapterTaskSubtaskFromRow),
    taskWatches: taskWatchRows.map(chapterTaskWatchFromRow),
    taskComments: taskCommentRows.map(chapterTaskCommentFromRow),
    taskCommentsUnavailable,
    taskCommentsTruncated,
    taskAttachments: taskAttachmentRows.map(chapterTaskAttachmentFromRow),
    taskActivity: taskActivityRows.map(chapterTaskActivityFromRow),
    taskFiles: taskFileRows.map(chapterTaskFileFromRow),
    product: {
      spaces: spaceRows.map((space) => ({
        ...space,
        threads: threadRows
          .filter((thread) => thread.space_id === space.id)
          .map((thread) => ({
            ...thread,
            unreadCount: channelUnreadCount(threadPostRows.filter((post) => post.thread_id === thread.id), spaceReadCursor(space.id), user.id),
            earlierCursor: threadPostsEarlierBefore,
            posts: threadPostRows.filter((post) => post.thread_id === thread.id).reverse()
              .map((post) => ({ ...post, ...utilitiesFor("channel", post.id) })),
          })),
      })),
      intake: intakeRows,
      documents: documentRows,
      records: recordRows,
      handshakes: handshakeRows,
      governance: governanceRows,
      governanceUnavailable: Boolean(requests[40].error || requests[40].refreshFailure),
      partnerOrgs: partnerOrgRows,
      compassKnowledge: chapterKnowledge,
    },
    forms: ownedFormRows.map((r) => ({
      id: r.id,
      templateKey: r.template_key,
      templateVersion: r.template_version ?? 1,
      status: r.status,
      ...ownedFormAnswers(r),
      revision: Number.isSafeInteger(r.revision) ? r.revision : null,
      step: r.step,
      reviewNote: r.review_note || "",
      submittedAt: r.submitted_at,
      filerSignedAt: r.filer_signed_at,
      filerSignatureDigest: r.filer_signature_digest,
      contentDigest: r.content_digest,
      artifactDigest: r.artifact_digest,
      artifactApprovedAt: r.artifact_approved_at,
      artifactApprovedBy: r.artifact_approved_by,
      cosigners: cosignersByForm.get(r.id) || [],
      files: formFileRows.filter((file) => file.form_id === r.id).map(memberFormFileFromRow),
    })),
    formsTruncated,
    cosignRequests,
    // Already camelCase off the RPC; the labels are the only client-side work.
    // Instants FORMAT in the member's own locale and device timezone — slot
    // arithmetic never happens here.
    appointments: appointmentRows.map((item) => ({
      ...item,
      dateLabel: eventDateLabel(item.startsAt, lang),
      timeLabel: eventTimeLabel(item.startsAt, lang),
      endTimeLabel: eventTimeLabel(item.endsAt, lang),
    })),
  };
}

// Unwrap a required PostgREST/RPC result: the label prefixes the thrown message
// so a toast says which call failed. Every non-degrading call goes through this
// — hand-rolled `if (result.error) throw` blocks drift (wrong label, a `return`
// that forgets `.data`) and hide which sites are deliberately fail-soft.
//
// That drift was not hypothetical: two push-subscription calls below had already
// hand-rolled their own throw, so a fix applied only to this helper and
// requireData would have left them discarding the code with every helper test
// green. tests/member-api-errors.test.js now reads src/ and fails on any throw
// that interpolates an error message without going through MemberApiError.
// An RPC answered with a bare HTTP 404 and no PostgREST
// code is a function this deployment does not have yet, the same answer as
// PGRST202, so it carries that code and reads as the service-busy sentence
// rather than the driver's text (UX-UG-WORDING-AND-SPANISH-GAPS-FROM-REVIEWS-20261117).
function errorWithMissingFunctionCode(result) {
  const error = result.error;
  return result.status === 404 && (error.code == null || error.code === "") ? { ...error, code: "PGRST202" } : error;
}

async function expectWrite(result, label) {
  if (result.error) throw new MemberApiError(label, errorWithMissingFunctionCode(result));
  return result.data;
}

function chapterTaskWriteFields(fields) {
  const keyMap = {
    title: "title",
    description: "description",
    status: "status",
    priority: "priority",
    taskType: "task_type",
    workstream: "workstream",
    assigneeId: "assignee_id",
    startDate: "start_date",
    dueDate: "due_date",
    progress: "progress",
    blocked: "blocked",
    milestone: "milestone",
    orderIndex: "order_index",
  };
  const row = {};
  for (const [clientKey, dbKey] of Object.entries(keyMap)) {
    if (Object.hasOwn(fields, clientKey)) {
      row[dbKey] = clientKey === "assigneeId" ? (fields[clientKey] || null) : fields[clientKey];
    }
  }
  return row;
}

// REQ-UG-LEARNING-PERIOD-TASKS-20261103: task rows are written only
// through journalled RPCs, so a practice action can always be undone.
export async function createChapterTask(client, fields) {
  const rows = await expectWrite(
    await client.rpc("create_chapter_task", { p_fields: chapterTaskWriteFields(fields) }),
    "Create task",
  );
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) throw new Error("Create task: no row returned");
  return chapterTaskFromRow(row);
}

// BUG-UG-TASK-TYPE-CHANGE-OPENS-TEMPLATE-CHOOSER-20261111: an
// existing General task becomes a specialized type, with that template's
// fields, in one server-checked write.
export async function convertChapterTaskToTemplate(client, conversion) {
  const data = await expectWrite(
    await client.rpc("convert_chapter_task_to_template", {
      p_task_id: conversion.taskId,
      p_template_key: conversion.templateKey,
      p_fields: conversion.fields || {},
    }),
    "Change task type",
  );
  return {
    task: chapterTaskFromRow(data.task),
    details: taskTemplateDetailsFromRow(data.details),
  };
}

export async function createChapterTaskFromTemplate(client, fields) {
  const args = {
    p_template_key: fields.templateKey,
    p_title: fields.title.trim(),
    p_workstream: fields.workstream,
    p_fields: fields.fields || {},
  };
  const data = await expectWrite(
    Object.hasOwn(fields, "unitId")
      ? await client.rpc("create_unit_task_from_template", { ...args, p_unit: fields.unitId, p_actor: fields.actorId, p_chapter: fields.chapterId, p_organization: fields.organizationId })
      : await client.rpc("create_chapter_task_from_template", args),
    "Create task from template",
  );
  return {
    task: chapterTaskFromRow(data.task),
    details: taskTemplateDetailsFromRow(data.details),
  };
}

export async function updateChapterTaskTemplateDetails(client, fields) {
  const data = await expectWrite(
    await client.rpc("update_chapter_task_template_details", {
      p_task_id: fields.taskId,
      p_fields: fields.fields || {},
      p_next_flow_step: fields.nextFlowStep || null,
      p_apply_recommended_status: Boolean(fields.applyRecommendedStatus),
    }),
    "Update task template",
  );
  return {
    task: chapterTaskFromRow(data.task),
    details: taskTemplateDetailsFromRow(data.details),
  };
}

export const CHAPTER_TASK_SOURCE_KINDS = Object.freeze([
  "message", "broadcast", "notification", "survey", "case",
]);

export async function createChapterTaskFromSource(client, sourceKind, sourceId) {
  const kind = String(sourceKind ?? "").trim().toLowerCase();
  const id = String(sourceId ?? "").trim();
  if (!CHAPTER_TASK_SOURCE_KINDS.includes(kind)) throw new Error("Unsupported task source");
  if (!id) throw new Error("Task source is required");
  const data = await expectWrite(
    await client.rpc("create_chapter_task_from_source", {
      p_source_kind: kind,
      p_source_id: id,
    }),
    "Create task from source",
  );
  return {
    task: chapterTaskFromRow(data.task),
    attachment: chapterTaskAttachmentFromRow(data.attachment),
    created: Boolean(data.created),
  };
}

// Source shortcuts can name tasks outside the board's first page or Done
// window. Resolve that exact row through the ordinary RLS boundary before
// opening it; cached attachment metadata is not permission to read a task.
// A missing or deleted row carries code task_unavailable, so every
// opener tells the person the task is gone instead of "try again".
const taskUnavailable = () => Object.assign(new Error('Task unavailable'), { code: 'task_unavailable' });
export async function loadAuthorizedChapterTask(client, taskId) {
  if (!taskId) throw taskUnavailable();
  const { data, error } = await readTaskSettings((columns) => client.from('chapter_tasks').select(columns)
    .eq('id', taskId).is('deleted_at', null).maybeSingle());
  if (error) throw error;
  if (!data) throw taskUnavailable();
  return chapterTaskFromRow(data);
}

export async function updateChapterTask(client, taskId, fields, expectedUpdatedAt = null) {
  const contentWrite = Object.hasOwn(fields, "title") || Object.hasOwn(fields, "description");
  if (contentWrite) {
    const unsupported = Object.keys(fields).filter((key) => !["title", "description"].includes(key));
    if (unsupported.length) throw new Error("Content updates must be committed separately");
    const rows = await expectWrite(
      await client.rpc("update_chapter_task_content", {
        p_task_id: taskId,
        p_expected_updated_at: expectedUpdatedAt,
        p_title: Object.hasOwn(fields, "title") ? fields.title : null,
        p_description: Object.hasOwn(fields, "description") ? fields.description : null,
      }),
      "Update task content",
    );
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) throw new Error("Update task content: no row returned");
    return chapterTaskFromRow(row);
  }
  const rows = await expectWrite(
    await client.rpc("update_chapter_task_fields", {
      p_task_id: taskId,
      p_fields: chapterTaskWriteFields(fields),
      p_expected_updated_at: expectedUpdatedAt,
    }),
    "Update task",
  );
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) throw new Error("Update task: no row returned");
  return chapterTaskFromRow(row);
}

export async function moveChapterTask(client, taskId, target, expectedUpdatedAt = null) {
  const rows = await expectWrite(
    await client.rpc("move_chapter_task", {
      p_task_id: taskId,
      p_workstream: target.workstream,
      p_status: target.status,
      p_before_id: target.beforeId || null,
      p_expected_updated_at: expectedUpdatedAt,
    }),
    "Move task",
  );
  return (Array.isArray(rows) ? rows : [rows]).filter(Boolean).map(chapterTaskFromRow);
}

// Delete is SOFT and definer-owned (20260727050000 series): the client's
// DELETE grant on chapter_tasks is revoked, the RPC stamps deleted_at/by and
// notifies the other participant, and the 90-day purge is the only cascade.
// restore_chapter_task is the Undo the soft delete exists to make possible.
export async function softDeleteChapterTask(client, taskId) {
  return expectWrite(await client.rpc("soft_delete_chapter_task", { p_task_id: taskId }), "Delete task");
}

export async function restoreChapterTask(client, taskId) {
  return expectWrite(await client.rpc("restore_chapter_task", { p_task_id: taskId }), "Restore task");
}

export async function addChapterTaskComment(client, taskId, body, mentionIds = []) {
  const data = await expectWrite(
    await client.rpc("add_chapter_task_comment", {
      p_task_id: taskId,
      p_body: body.trim(),
      p_mention_ids: mentionIds,
    }),
    "Add task comment",
  );
  return chapterTaskCommentFromRow(data);
}

export async function addChapterTaskAttachment(client, taskId, label, recordUrl) {
  const data = await expectWrite(
    await client.rpc("add_chapter_task_attachment", {
      p_task_id: taskId,
      p_label: label.trim(),
      p_record_url: recordUrl.trim(),
    }),
    "Add authorized record",
  );
  return chapterTaskAttachmentFromRow(data);
}

export async function removeChapterTaskAttachment(client, attachmentId) {
  return expectWrite(
    await client.rpc("remove_chapter_task_attachment", { p_attachment_id: attachmentId }),
    "Remove authorized record",
  );
}

// ---------------------------------------------------------------------------
// Private file uploads: begin → upload → inspect → confirm.
//
// `register_*` set `confirmed_at = now()` at registration, so a web upload
// became visible the instant the row existed — before anything had looked at
// the bytes. The two-phase RPCs mint the row invisible (`confirmed_at` null)
// and only `confirm_*` reveals it, which is where the inspection verdict has
// to sit. The ordering below is the whole point of this module:
//
//   nothing is ever confirmed except on an explicit `clean` verdict.
//
// A refusal aborts the pending row so the service reconciler removes the
// bytes; anything ambiguous — a scanner outage, a quota refusal, a lost
// response — leaves the row unconfirmed and invisible rather than guessing.
// The client never deletes bytes itself and never sends a path, a digest or a
// verdict: it sends `{kind, fileId}` and reads what the server decides.

// Stable tokens `rpcErrorText` translates, so a refusal reaches the member in
// their own language instead of as an English scanner sentence.
const PRIVATE_FILE_DETAIL = Object.freeze({
  rejected: "private_file_rejected",
  "pending-check": "private_file_pending_check",
  "rate-limited": "private_file_rate_limited",
  stale: "private_file_stale",
  unavailable: "private_file_unavailable",
});

// A quota refusal is a decision about this actor, not about these bytes: it is
// worth its own sentence so the member reads the real ceiling instead of
// "try again", which they already did.
function ambiguousCode(error) {
  return error instanceof PrivateFileError && error.code === "rate-limited"
    ? "rate-limited"
    : "pending-check";
}

function privateFileFailure(label, code, cause) {
  const error = new MemberApiError(label, {
    message: cause?.message || "The file check could not be completed.",
    code: cause?.code ?? null,
    details: PRIVATE_FILE_DETAIL[code] ?? PRIVATE_FILE_DETAIL.unavailable,
  });
  // The machine-readable half the views branch on: `rejected` is permanent and
  // offers no retry, `stale` offers a re-check, everything else is a plain
  // failure the member may retry by repeating the action.
  error.privateFileCode = code;
  return error;
}

function notifyPhase(onPhase, phase) {
  // A view's state update must never be able to fail an upload that already
  // put bytes in Storage.
  try { onPhase?.(phase); } catch { /* the caller's UI, not our transaction */ }
}

async function abortPendingUpload(client, rpc, fileId) {
  // PostgREST builders are PromiseLike, not Promises — .catch does not exist
  // on them; only await converts. The abort's own failure is swallowed because
  // the surfaced failure must stay the reason the upload was refused, and the
  // pending row stays cleanup-eligible either way.
  try {
    const result = await client.rpc(rpc, { p_file_id: fileId });
    return !result?.error && result?.data?.id === fileId
      && (result.data.deleted === true || result.data.absent === true);
  } catch { return false; }
}

// A LOST CONFIRMATION IS NOT A FAILED ONE.
//
// `confirm_*_file_upload` sets `confirmed_at = coalesce(confirmed_at, now())`
// and returns the row, so calling it twice for the same file id is the same
// attachment, never a second one. That matters because the transaction can
// commit and its HTTP response still be lost: reporting "nothing was attached"
// then leaves a live, visible row behind and invites the member to upload a
// duplicate. The native path already reconciles this way
// (reconcileAuthorizedAttachmentUpload in apps/mobile/src/services/
// attachments.ts); web now does too, by re-asking for the EXACT file id.
//
// The re-ask is bounded to one, and only for an ambiguous outcome. A refusal
// the server actually decided — the row is gone, or the bytes were never
// found — is final and is surfaced as it stands. Nothing here relaxes the
// contract: the row is confirmed only because the server said so and named
// this file id.
function confirmationIsDecided(error) {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "").toLowerCase();
  if (code === "42501") return true;
  return code === "22023"
    && (message.includes("uploaded file was not found")
      || message.includes("file unavailable")
      || message.includes("file inspection required"));
}

async function confirmUploadedFile(client, spec, fileId) {
  let failure = null;
  let failureIsDecided = false;
  // THE DECIDED ANSWER IS THE ONE THE MEMBER READS.
  //
  // An ambiguous first attempt — a dropped response, a statement timeout —
  // says nothing about why the upload did not attach. If the retry then comes
  // back with a refusal the server actually decided ("uploaded file was not
  // found", 42501 "file inspection required"), keeping the earlier transport
  // error would show a generic failure in place of the real reason. So the
  // first failure is held only as the fallback and a decided one replaces it;
  // a second ambiguous failure changes nothing.
  function record(error, decided) {
    if (failure && !(decided && !failureIsDecided)) return;
    failure = new MemberApiError(spec.label, error ?? {});
    failureIsDecided = decided;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let result;
    try {
      result = await client.rpc(spec.confirmRpc, { p_file_id: fileId });
    } catch (transportError) {
      // The response never arrived; the statement may well have committed.
      record(transportError, false);
      continue;
    }
    if (!result?.error) {
      const row = result.data;
      const id = row?.id ?? row?.fileId;
      // A 2xx that does not name this file is not this confirmation.
      if (id === fileId) return row;
      record({ message: "confirmation did not name this file" }, false);
      continue;
    }
    const decided = confirmationIsDecided(result.error);
    record(result.error, decided);
    if (decided) break;
  }
  throw failure;
}

// Retry capabilities are bound to the exact client, record and registered file.
// They only inspect/confirm; they never mint another ID or send bytes again.
const privateUploadRetries = new WeakMap();

function retryRegisteredUpload(retry, client, kind, recordId, onPhase) {
  const bound = privateUploadRetries.get(retry);
  if (!bound || bound.client !== client || bound.kind !== kind || bound.recordId !== recordId) {
    throw new MemberApiError("Attach file", { message: "Upload retry does not belong to this record." });
  }
  return retry(onPhase);
}

async function uploadInspectConfirm(client, spec, file, onPhase) {
  // Local validation runs AFTER any HEIC conversion and BEFORE the begin RPC:
  // a format or size refusal here has touched no network, minted no row, and
  // spent none of the caller's hourly inspection quota. The content
  // inspection below stays authoritative over the bytes themselves.
  const prepared = validatePrivateUploadFile(await normalizeUploadFile(file, { onPhase }));
  const fileId = mintClientUuid(spec.label, "upload");
  const begun = await expectWrite(
    await client.rpc(spec.beginRpc, spec.beginArgs(fileId, prepared)),
    spec.label,
  );
  const row = spec.fromRow(begun);

  const reconcile = async (onPhase) => {
    notifyPhase(onPhase, "checking");
    try {
      await requestPrivateFileInspection(client, spec.kind, fileId);
    } catch (error) {
      if (error instanceof PrivateFileError && error.code === "rejected") {
        // A decision about these bytes. Abort while the row is still pending —
        // after confirmation the only lawful route is the removal tombstone.
        await abortPendingUpload(client, spec.abortRpc, fileId);
        notifyPhase(onPhase, "rejected");
        throw privateFileFailure(spec.label, "rejected", error);
      }
      // Ambiguous. The bytes may well be fine, so they are not destroyed; the
      // row simply stays invisible until an inspection says otherwise.
      const code = ambiguousCode(error);
      notifyPhase(onPhase, code);
      throw privateFileFailure(spec.label, code, error);
    }

    notifyPhase(onPhase, "confirming");
    const confirmed = await confirmUploadedFile(client, spec, fileId);
    notifyPhase(onPhase, "done");
    // `confirmedAt` rides alongside the shared row shape rather than inside it:
    // the list mappers are used by reads that predate two-phase upload, and a
    // surface that shows "pending" needs the timestamp only on this path.
    return {
      ...spec.fromRow(confirmed),
      confirmedAt: confirmed?.confirmedAt ?? confirmed?.confirmed_at ?? null,
    };
  };
  privateUploadRetries.set(reconcile, { client, kind: spec.kind, recordId: spec.recordId });
  notifyPhase(onPhase, "uploading");
  // contentType is the server's declared MIME, never the browser's guess: the
  // inspector compares the stored object's metadata against the row the RPC
  // minted, and a guess that disagrees is a self-inflicted refusal.
  let upload;
  try {
    upload = spec.kind === "case"
      ? await uploadSensitiveCaseFile(client, fileId, prepared).catch(() => ({ error: { message: "Encrypted upload unavailable. Try again." } }))
      : await client.storage.from(row.bucketId).upload(row.objectName, prepared, {
        contentType: row.mimeType,
        upsert: false,
      });
  } catch (cause) {
    const error = new MemberApiError(spec.label, cause);
    error.retryUpload = reconcile;
    throw error;
  }
  if (upload.error) {
    const absent = await abortPendingUpload(client, spec.abortRpc, fileId);
    const error = new MemberApiError(spec.label, upload.error);
    if (!absent) error.retryUpload = reconcile;
    throw error;
  }

  try {
    return await reconcile(onPhase);
  } catch (error) {
    if (error?.privateFileCode !== "rejected") error.retryUpload = reconcile;
    throw error;
  }
}

async function privateFileBlob(client, fileRow, label) {
  try {
    return await downloadPrivateFileBlob(client, {
      bucketId: fileRow?.bucketId,
      objectName: fileRow?.objectName,
    });
  } catch (error) {
    // Storage answering 4xx for a caller who is otherwise authorized is the
    // quarantine policy saying the clean verdict aged out or was superseded.
    // That is recoverable by one re-inspection, and saying so is the whole
    // difference between "re-check this file" and an unexplained failure.
    const stale = error instanceof PrivateFileError && error.staleVerdict;
    throw privateFileFailure(label, stale ? "stale" : "unavailable", error);
  }
}

/**
 * Ask for a fresh inspection of a file whose verdict expired.
 *
 * Takes a feature row id and a kind — never a bucket, an object name or a
 * digest. An already-current verdict short-circuits server-side without
 * spending the caller's hourly quota.
 */
export async function recheckPrivateFile(client, kind, fileId) {
  try {
    await requestPrivateFileInspection(client, kind, fileId);
    return { fileId, status: "clean" };
  } catch (error) {
    const rejected = error instanceof PrivateFileError && error.code === "rejected";
    throw privateFileFailure("Check file", rejected ? "rejected" : ambiguousCode(error), error);
  }
}

export async function addChapterTaskFile(client, taskId, file, { onPhase, retryUpload } = {}) {
  if (typeof retryUpload === "function") return retryRegisteredUpload(retryUpload, client, "task", taskId, onPhase);
  return uploadInspectConfirm(client, {
    kind: "task",
    recordId: taskId,
    label: "Attach file",
    beginRpc: "begin_chapter_task_file_upload",
    beginArgs: (fileId, prepared) => ({
      p_file_id: fileId,
      p_task_id: taskId,
      p_filename: prepared.name,
      p_mime_type: prepared.type,
      p_size_bytes: prepared.size,
    }),
    confirmRpc: "confirm_chapter_task_file_upload",
    abortRpc: "abort_chapter_task_file_upload",
    fromRow: chapterTaskFileFromRow,
  }, file, onPhase);
}

const FILE_REMOVAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// One minting rule for both client-minted ids: the removal tombstone's replay
// key and the upload's file id. Both must be a real random UUID — a fallback
// counter would make a removal replay ambiguous and let two uploads collide on
// one storage path.
function mintClientUuid(label, purpose) {
  const id = globalThis.crypto?.randomUUID?.();
  if (!FILE_REMOVAL_UUID.test(id || "")) {
    throw new MemberApiError(label, { message: `secure ${purpose} id unavailable` });
  }
  return id;
}

function mintFileRemovalId(label) {
  return mintClientUuid(label, "removal");
}

function exactFileRemovalReceipt(value, fileRow, removalId) {
  return value && typeof value === "object" && !Array.isArray(value)
    && value.id === fileRow.id
    && (value.removalId ?? value.removal_id) === removalId
    && (value.deleted === true || value.absent === true);
}

function exactFileRemovalRequest(value, fileRow, removalId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const requestedAt = value.removalRequestedAt ?? value.removal_requested_at;
  return value.id === fileRow.id
    && (value.bucketId ?? value.bucket_id) === fileRow.bucketId
    && (value.objectName ?? value.object_name) === fileRow.objectName
    && (value.removalId ?? value.removal_id) === removalId
    && typeof requestedAt === "string"
    && Number.isFinite(Date.parse(requestedAt));
}

async function replayFileRemovalRpc(client, rpc, args, label, validate) {
  let lastError = { message: "server did not confirm the exact removal checkpoint" };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await client.rpc(rpc, args);
      if (result.error) {
        lastError = result.error;
        continue;
      }
      if (validate(result.data)) return result.data;
      lastError = { message: "server did not confirm the exact removal checkpoint" };
    } catch (error) {
      lastError = error instanceof Error ? { message: error.message } : { message: "removal response unavailable" };
    }
  }
  throw new MemberApiError(label, lastError);
}

async function removeFileWithTombstone(client, fileRow, kind) {
  const isCase = kind === "case";
  const label = isCase ? "Remove case file" : "Remove file";
  const requestRpc = isCase ? "request_member_case_file_removal" : "request_chapter_task_file_removal";
  const removalId = mintFileRemovalId(label);
  const args = { p_file_id: fileRow.id, p_removal_id: removalId };

  // The exact request is the durable completion point for the authenticated
  // client: it immediately hides the row and byte. The service-role
  // reconciler alone performs physical Storage deletion and row retirement.
  return replayFileRemovalRpc(client, requestRpc, args, label, (value) => (
    exactFileRemovalReceipt(value, fileRow, removalId)
    || exactFileRemovalRequest(value, fileRow, removalId)
  ));
}

export async function removeChapterTaskFile(client, fileRow) {
  return removeFileWithTombstone(client, fileRow, "task");
}

// Bytes come back through the caller's own JWT, so Storage re-evaluates the
// restrictive quarantine policy on every single read. A signed URL cannot do
// that: it is one decision honoured for its whole lifetime, which is exactly
// what a later quarantine has to be able to revoke.
export async function chapterTaskFileBlob(client, fileRow) {
  return privateFileBlob(client, fileRow, "Open file");
}

export async function addMemberCaseFile(client, caseId, file, { onPhase, retryUpload } = {}) {
  if (typeof retryUpload === "function") return retryRegisteredUpload(retryUpload, client, "case", caseId, onPhase);
  return uploadInspectConfirm(client, {
    kind: "case",
    recordId: caseId,
    label: "Attach case file",
    beginRpc: "begin_member_case_file_upload",
    beginArgs: (fileId, prepared) => ({
      p_file_id: fileId,
      p_case_id: caseId,
      p_filename: prepared.name,
      p_mime_type: prepared.type,
      p_size_bytes: prepared.size,
    }),
    confirmRpc: "confirm_member_case_file_upload",
    abortRpc: "abort_member_case_file_upload",
    fromRow: memberCaseFileFromRow,
  }, file, onPhase);
}

export async function removeMemberCaseFile(client, fileRow) {
  return removeFileWithTombstone(client, fileRow, "case");
}

export async function memberCaseFileBlob(client, fileRow) {
  try { return await downloadSensitiveCaseFile(client, fileRow.id); }
  catch (error) { throw privateFileFailure("Open case file", error?.staleVerdict ? "stale" : "unavailable", error); }
}

// All-time numbers without an all-time read: one staff-only RPC returning one
// JSON row of aggregates. Called by the Report view on demand — NEVER from
// loadMemberApp; the whole point is that reporting never joins the boot path.
export async function loadChapterTaskReport(client, from = null, to = null) {
  return expectWrite(await client.rpc("chapter_task_report", { p_from: from, p_to: to }), "Load report");
}

export async function saveMyReportPreferences(client, config) {
  return expectWrite(await client.rpc("save_my_report_preferences", { p_config: config }), "Report preferences");
}

// Case-list views are private presentation preferences. The RPCs derive both
// the user and active organization from the authenticated session; callers
// never send an identity or tenancy field that could be confused with access.
export async function listMemberSavedViews(client, plane) {
  return expectWrite(await client.rpc("list_member_saved_views", { p_plane: plane }), "Saved views");
}

export async function saveMemberSavedView(client, { id = null, plane, name, definition, isDefault = false }) {
  return expectWrite(await client.rpc("save_member_saved_view", {
    p_id: id, p_plane: plane, p_name: name, p_definition: definition, p_is_default: isDefault,
  }), "Save view");
}

export async function deleteMemberSavedView(client, id) {
  return expectWrite(await client.rpc("delete_member_saved_view", { p_id: id }), "Delete saved view");
}

// The board's own two reads, in the SAME shape the boot path uses — the
// windowed chapter_tasks select and the chapter's workstream vocabulary.
// Called when the realtime channel reaches SUBSCRIBED: rows changed between
// the boot snapshot and that moment are in neither source, and re-running the
// whole loadMemberApp for two tables would be disproportionate.
//
// Soft-degrading like every additive read above, but per PART and to null
// rather than []: an empty array here reads as "this chapter has no tasks" and
// would blank a board that is merely offline for one request. null means "keep
// what you have", and the caller merges only the parts that arrived.
export async function loadChapterTaskBoard(client) {
  const floor = taskWindowFloor();
  const [taskResult, workstreamResult, dependencyResult, subtaskResult, watchResult, assignmentResult] = await Promise.all([
    readTaskSettings((columns) => client.from("chapter_tasks").select(columns).or(`status.neq.done,done_at.gte.${floor}`).order("status", { ascending: false }).order("order_index").order("created_at").limit(500)),
    client.from("chapter_workstreams").select("id,name").order("name"),
    client.rpc("list_chapter_task_dependencies", { p_limit: CHAPTER_TASK_DEPENDENCY_LIMIT }),
    client.from("chapter_task_subtasks").select(CHAPTER_TASK_SUBTASK_COLUMNS).order("created_at").limit(4000),
    client.from("chapter_task_watchers").select("task_id").limit(500),
    client.from("chapter_task_assignments").select(CHAPTER_TASK_ASSIGNMENT_COLUMNS).order("position").limit(6000),
  ]);
  const taskRows = softData(taskResult, "Chapter task board", null);
  const workstreamRows = softData(workstreamResult, "Chapter workstreams", null);
  const subtaskRows = softData(subtaskResult, "Task subtasks", null);
  const watchRows = softData(watchResult, "Task watches", null);
  const dependencyRows = softData(dependencyResult, "Task dependencies", null);
  const assignmentRows = softData(assignmentResult, "Task assignments", null);
  const assignments = assignmentRows ? assignmentRows.map(chapterTaskAssignmentFromRow) : null;
  return {
    tasks: taskRows ? taskRows.map(chapterTaskFromRow).map((task) => withTaskAssignees(task, assignments || [])) : null,
    workstreams: workstreamRows ? workstreamRows.map((row) => ({ id: row.id, name: row.name })) : null,
    taskDependencies: dependencyRows ? dependencyRows.map(chapterTaskDependencyFromRow) : null,
    taskSubtasks: subtaskRows ? subtaskRows.map(chapterTaskSubtaskFromRow) : null,
    taskWatches: watchRows ? watchRows.map(chapterTaskWatchFromRow) : null,
    taskAssignments: assignments,
  };
}

// Close only the two gaps owned by the member notification channel. The
// channel subscribes before the initial snapshot necessarily settles, so rows
// committed between that snapshot and SUBSCRIBED need one reconciliation.
// Re-running the complete member projection here doubles authenticated boot
// traffic and can erase unrelated route/overlay state.
export async function loadMemberRealtimeGap(client, userId, { queryNowMs = Date.now() } = {}) {
  const floor = taskWindowFloor(queryNowMs);
  const [notificationResult, taskMessageResult] = await Promise.all([
    // Exactly the boot snapshot's notification query, limit included. The
    // session registry keys a read by its query shape, so a differently
    // bounded gap read would fetch the same rows twice per reconciliation.
    client.from("member_notifications").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(200),
    client.from("chapter_task_messages").select(CHAPTER_TASK_MESSAGE_COLUMNS).gte("created_at", floor).order("created_at").limit(1000),
  ]);
  const notificationRows = softData(notificationResult, "Notification reconciliation", null);
  const taskMessageRows = softData(taskMessageResult, "Task-message reconciliation", null);
  return {
    notifications: notificationRows,
    taskMessages: taskMessageRows?.map(chapterTaskMessageFromRow) ?? null,
  };
}

export async function setChapterTaskAssignees(client, taskId, assigneeIds) {
  return expectWrite(
    await client.rpc("set_chapter_task_assignees", {
      p_task_id: taskId,
      p_assignee_ids: [...new Set((assigneeIds || []).filter(Boolean))],
    }),
    "Set task assignees",
  );
}

// A chapter created after the July 28 seed has no workstream, and every task
// must name one (REQ-UG-TASKS-WORKSTREAM-ASSIGNEES-DUE-DATES-20261030).
// The server adds "General" only when the caller's chapter has none, and
// answers with the chapter's list either way.
export async function ensureChapterDefaultWorkstream(client) {
  const rows = await expectWrite(await client.rpc("ensure_chapter_default_workstream"), "Prepare workstreams");
  return (Array.isArray(rows) ? rows : []).map((row) => ({ id: row.id, name: row.name }));
}

export async function insertChapterWorkstream(client, chapterId, name) {
  // chapter_id is in the insert column grant and NOT stamped server-side for
  // this table, so the caller supplies their own chapter explicitly.
  return expectWrite(
    await client.from("chapter_workstreams").insert({ chapter_id: chapterId, name: name.trim() }).select("id,name").single(),
    "Add workstream",
  );
}

export async function renameChapterWorkstream(client, workstreamId, name) {
  // 23505 here is NOT an error to surface: the panel turns it into the merge
  // offer, which is the one moment someone has proven they want the merge.
  return expectWrite(
    await client.rpc("rename_chapter_workstream", { p_workstream_id: workstreamId, p_name: name.trim() }),
    "Rename workstream",
  );
}

export async function previewChapterWorkstreamMerge(client, sourceId, targetId) {
  return expectWrite(
    await client.rpc("preview_chapter_workstream_merge", { p_source_id: sourceId, p_target_id: targetId }),
    "Preview merge",
  );
}

export async function mergeChapterWorkstreams(client, sourceId, targetId, expectedMoving = null) {
  // expectedMoving is the preview's movingTasks, passed back as optimistic
  // concurrency: the server raises 40001 if the chapter changed under the
  // dialog, and the dialog re-reads rather than silently widening the merge.
  return expectWrite(
    await client.rpc("merge_chapter_workstreams", { p_source_id: sourceId, p_target_id: targetId, p_expected_moving: expectedMoving }),
    "Merge workstreams",
  );
}

// Edges are immutable rows: created and removed, never updated. The prepare
// trigger owns chapter scope, endpoint liveness and the cycle check; the
// client sends only the edge itself. 22023 comes back for a cycle-closing or
// cross-chapter edge, 23505 for a duplicate — the modal maps both to copy.
// REQ-UG-LEARNING-PERIOD-TASKS-20261103: edges, subtask links and
// watches are written through journalled RPCs, so a practice change can be
// undone. A remove answers { id } or null, as the direct delete did.
const firstRow = (rows) => (Array.isArray(rows) ? rows[0] : rows);

export async function createChapterTaskDependency(client, taskId, dependsOnId) {
  const data = await expectWrite(
    await client.rpc("add_chapter_task_dependency", { p_task_id: taskId, p_depends_on_id: dependsOnId }),
    "Add dependency",
  );
  return chapterTaskDependencyFromRow(firstRow(data));
}

export async function deleteChapterTaskDependency(client, dependencyId) {
  return expectWrite(
    await client.rpc("remove_chapter_task_dependency", { p_dependency_id: dependencyId }),
    "Remove dependency",
  );
}

export async function sendChapterTaskMessage(client, taskId, body) {
  return expectWrite(
    await client.rpc("send_chapter_task_message", { p_task_id: taskId, p_body: body }),
    "Send task message",
  );
}
export async function createChapterTaskSubtask(client, parentTaskId, subtaskId) {
  const data = await expectWrite(
    await client.rpc("add_chapter_task_subtask", { p_parent_task_id: parentTaskId, p_subtask_id: subtaskId }),
    "Add subtask",
  );
  return chapterTaskSubtaskFromRow(firstRow(data));
}

export async function deleteChapterTaskSubtask(client, subtaskLinkId) {
  return expectWrite(
    await client.rpc("remove_chapter_task_subtask", { p_subtask_link_id: subtaskLinkId }),
    "Remove subtask",
  );
}

export async function watchChapterTask(client, taskId) {
  const data = await expectWrite(
    await client.rpc("watch_chapter_task", { p_task_id: taskId }),
    "Watch task",
  );
  return chapterTaskWatchFromRow(data);
}

export async function unwatchChapterTask(client, taskId) {
  return expectWrite(
    await client.rpc("unwatch_chapter_task", { p_task_id: taskId }),
    "Unwatch task",
  );
}


// A Spanish name or description is sent only when one was typed, so the
// insert keeps its earlier shape otherwise (bilingualContent.js).
export async function createChapterSpace(client, fields) {
  const row = {
    name: fields.name.trim(),
    description: fields.description.trim(),
    visibility: fields.visibility,
  };
  const nameEs = spanishValue(fields.nameEs);
  const descriptionEs = spanishValue(fields.descriptionEs);
  if (nameEs) row.name_es = nameEs;
  if (descriptionEs) row.description_es = descriptionEs;
  return expectWrite(await client.from("chapter_spaces").insert(row).select("*").single(), "Create space");
}

// A Spanish edit (bilingualContent.js spanishSpaceEdit) rides in the same
// call, so the space and its Spanish version save together or not at all;
// an empty string clears it. Without one the call keeps its earlier shape
// and the server keeps the Spanish version as it is.
export async function updateChapterSpaceContent(client, id, fields, archive = false) {
  const args = { p_id: id, p_name: fields.name.trim(), p_description: fields.description.trim(), p_visibility: fields.visibility, p_archive: archive };
  if (!archive && carriesSpanishEdit(fields)) {
    args.p_name_es = spanishValue(fields.nameEs) ?? "";
    args.p_description_es = spanishValue(fields.descriptionEs) ?? "";
  }
  return expectWrite(await client.rpc("update_chapter_space_content", args), "Update space");
}

export async function listChapterSpaceMembers(client, spaceId) {
  return expectWrite(await client.rpc("list_chapter_space_members", { p_space_id: spaceId }), "Space members");
}

export async function searchChapterSpaceMembers(client, spaceId, query) {
  return expectWrite(await client.rpc("search_chapter_space_members", { p_space_id: spaceId, p_query: query.trim(), p_limit: 20 }), "Search space members");
}

export async function setChapterSpaceMember(client, spaceId, userId, add) {
  return expectWrite(await client.rpc("set_chapter_space_member", { p_space_id: spaceId, p_user_id: userId, p_add: add }), "Update space member");
}

export async function createChapterThread(client, fields) {
  return expectWrite(await client.from("chapter_threads").insert({
    space_id: fields.spaceId,
    title: fields.title.trim(),
    kind: fields.kind,
  }).select("*").single(), "Create thread");
}

// mentionIds: people picked in the composer. The database keeps only those who
// can read the channel (and none while the organization's mentions switch is
// off), so the list is a request, not an authority. An empty list is omitted
// so the insert stays the same shape as before mentions existed.
// bodyEs: the post's optional Spanish version, sent only when one was typed;
// like the body it can never change afterwards.
export async function sendChapterThreadPost(client, threadId, body, mentionIds = [], bodyEs = null) {
  const row = { thread_id: threadId, body: body.trim() };
  if (Array.isArray(mentionIds) && mentionIds.length > 0) row.mentioned_user_ids = mentionIds;
  const spanish = spanishValue(bodyEs);
  if (spanish) row.body_es = spanish;
  return expectWrite(await client.from("chapter_thread_posts").insert(row).select("*").single(), "Send thread reply");
}

export async function createMemberIntake(client, fields) {
  return expectWrite(await client.from("member_intake_reports").insert({
    category: fields.category,
    title: fields.title.trim(),
    details: fields.details.trim(),
  }).select("*").single(), "Create intake");
}

export async function triageMemberIntake(client, reportId, fields) {
  return expectWrite(await client.rpc("triage_member_intake_report", {
    p_report_id: reportId,
    p_status: fields.status,
    p_assigned_to: fields.assignedTo || null,
  }), "Triage intake");
}

export async function convertMemberIntake(client, reportId, target, spaceId = null) {
  return expectWrite(await client.rpc("convert_member_intake_report", {
    p_report_id: reportId,
    p_target: target,
    p_space_id: spaceId || null,
  }), "Convert intake");
}

export async function createChapterDocument(client, fields) {
  return expectWrite(await client.from("chapter_documents").insert({
    title: fields.title.trim(),
    document_type: fields.documentType,
    summary: fields.summary.trim(),
    body: fields.body.trim(),
    visibility: fields.visibility,
    status: fields.status,
    published_at: fields.status === "published" ? new Date().toISOString() : null,
  }).select("*").single(), "Save document");
}

export async function updateChapterDocumentContent(client, id, fields, action = "save") {
  return expectWrite(await client.rpc("update_chapter_document_content", {
    p_id: id,
    p_title: fields.title.trim(),
    p_document_type: fields.documentType,
    p_summary: fields.summary.trim(),
    p_body: fields.body.trim(),
    p_visibility: fields.visibility,
    p_action: action,
  }), "Update document");
}

export async function saveChapterKnowledgeArticle(client, fields) {
  const data = await expectWrite(await client.rpc("save_chapter_kb_article", {
    p_article_id: fields.articleId || null,
    p_kind: fields.kind,
    p_title: fields.title.trim(),
    p_article_ref: fields.articleRef.trim(),
    p_body: fields.body.trim(),
    p_keywords: (fields.keywords || []).map((keyword) => keyword.trim()).filter(Boolean),
    p_status: fields.status,
    p_confirm_verified: Boolean(fields.confirmVerified),
    p_chapter_id: fields.chapterId || null,
  }), "Save Guide source");
  return chapterKnowledgeFromRow(data);
}

export async function retireChapterKnowledgeArticle(client, articleId, chapterId = null) {
  const data = await expectWrite(
    await client.rpc("retire_chapter_kb_article", {
      p_article_id: articleId,
      p_chapter_id: chapterId || null,
    }),
    "Retire Guide source",
  );
  return chapterKnowledgeFromRow(data);
}

export async function createChapterRecord(client, fields) {
  return expectWrite(await client.from("chapter_records").insert({
    record_type: fields.recordType,
    title: fields.title.trim(),
    body: fields.body.trim(),
    occurred_at: fields.occurredAt,
  }).select("*").single(), "Save record");
}

export async function updateChapterRecordContent(client, id, fields, archive = false) {
  return expectWrite(await client.rpc("update_chapter_record_content", { p_id: id, p_record_type: fields.recordType, p_title: fields.title.trim(), p_body: fields.body.trim(), p_occurred_at: fields.occurredAt, p_archive: archive }), "Update record");
}

export async function createChapterHandshake(client, fields) {
  return expectWrite(await client.rpc("request_chapter_handshake", {
    p_partner_org_id: fields.partnerOrgId,
    p_title: fields.title.trim(),
    p_purpose: fields.purpose.trim(),
    p_data_scope: fields.dataScope,
    p_idempotency_key: crypto.randomUUID(),
  }), "Request handshake");
}

export async function updateChapterHandshakeStatus(client, id, status, extras = {}) {
  const next = String(status || "").trim();
  if (next === "requested") {
    throw new Error("Draft handshake requests must use createChapterHandshake");
  }
  const idempotencyKey = extras.idempotencyKey || crypto.randomUUID();
  if (next === "accepted" || next === "declined") {
    return expectWrite(await client.rpc("respond_chapter_handshake", {
      p_handshake_id: id,
      p_decision: next === "accepted" ? "accept" : "decline",
      p_idempotency_key: idempotencyKey,
    }), "Update handshake");
  }
  if (next === "active") {
    return expectWrite(await client.rpc("countersign_chapter_handshake", {
      p_handshake_id: id,
      p_idempotency_key: idempotencyKey,
    }), "Update handshake");
  }
  if (next === "closed") {
    return expectWrite(await client.rpc("close_chapter_handshake", {
      p_handshake_id: id,
      p_idempotency_key: idempotencyKey,
    }), "Update handshake");
  }
  throw new Error("Unknown handshake status");
}

export async function createGovernanceRequest(client, fields) {
  return expectWrite(await client.from("chapter_governance_requests").insert({
    request_type: fields.requestType,
    details: fields.details.trim(),
  }).select("*").single(), "Submit data request");
}

export async function generateMemberDataExport(client) {
  return openSealedExportForms(client, await expectWrite(await client.rpc("get_member_data_export"), "Data export"));
}

// REQ-UG-MEMBER-EXPORT-SEALED-FMLA-ANSWERS-20261022: the SQL
// export keeps only a sealed FMLA form's marker. The member's own answers are
// opened by /api/sensitive-content (caller JWT, own forms, current
// organization) and placed in the download, never stored. A form the API
// could not open, or one saved again after the SQL snapshot (its envelope's
// dataVersion differs from the marker's), is marked unavailable, never empty.
export async function openSealedExportForms(client, exported) {
  const forms = Array.isArray(exported?.forms) ? exported.forms : [];
  const isSealed = (form) => form?.answers?.sealed === true && SEALED_FORM_TEMPLATE_KEYS.has(form?.templateKey);
  if (!forms.some(isSealed)) return exported;
  const result = await sensitiveContentRpc(client, "get_my_sealed_form_answers");
  const opened = new Map((result.error ? [] : result.data || [])
    .filter((item) => !item?.contentError && typeof item?.id === "string").map((item) => [item.id, item]));
  return {
    ...exported,
    forms: forms.map((form) => {
      if (!isSealed(form)) return form;
      const item = opened.get(form.id);
      return item && item.dataVersion === form.answers.dataVersion
        ? { ...form, answers: item.answers || {}, sealed: true }
        : { ...form, answers: {}, sealed: true, answersUnavailable: true };
    }),
  };
}

export async function markNotificationsRead(client, userId, { asUser = null } = {}) {
  const pinned = asUser ? await pinnedSaveSession(client, asUser) : null;
  return expectWrite(await pinnedMemberRequest(client.from("member_notifications").update({ read_at: new Date().toISOString() }).eq("user_id", userId).is("read_at", null), pinned), "Mark notifications read");
}

// Profile and settings saves go through update_my_member_profile, which writes
// only the caller's own row and journals the change during a learning period
// so it can be undone (REQ-UG-LEARNING-PERIOD-MEMBERSHIP-ROLES-SETTINGS-20261103).
// userId is the account the form was opened for; the server refuses the save
// if the session now belongs to someone else, as the old .eq("id") did.
export async function updateMemberProfile(client, userId, fields, { asUser = null } = {}) {
  const pinned = asUser ? await pinnedSaveSession(client, asUser) : null;
  return expectWrite(await pinnedMemberRequest(client.rpc("update_my_member_profile", { p_expected_user_id: userId, p_fields: {
    full_name: fields.fullName.trim(),
    first_name: fields.firstName.trim(),
    initials: fields.initials.trim().slice(0, 3).toUpperCase(),
    role_line: fields.roleLine.trim(),
    member_since: fields.sinceYear == null || fields.sinceYear === "" ? null : Number(fields.sinceYear),
  } }), pinned), "Update profile");
}

// Member settings: language and in-app notification preferences. Only the
// known preference keys are written so the jsonb stays a bounded object that
// satisfies the column shape/size CHECK.
//
// This is the ONE canonical topic list. It must stay in lockstep with the
// `kind` CHECK on member_notifications and with the rows SettingsView renders:
// a key present in the UI but missing here is silently dropped on write, and
// because the enqueue trigger reads an absent key as "enabled", the member's
// switch springs back to on while the mail keeps sending. SettingsView imports
// this list rather than restating it, and a test pins the two together.
// 'tasks' is the sixth topic (20260727 series): assigned / un-assigned /
// message / deleted / restored notices become email and push while outbound
// is enabled. The BOARD is staff-only but the notices are not: the assignee
// roster has no role filter, so any chapter member can be handed a task and
// notified — which is why the Settings row renders for everyone.
// No 'dues' topic: Union Ground leaves dues out (owner decision, 2026-10-13)
// because a campaign still forming its union collects none.
export const NOTIFICATION_TOPIC_KEYS = ["deadlines", "cases", "forms", "votes", "events", "tasks", "appointments", "workload", "messages"];

// Engagement email choices (SEC-UG-ENGAGEMENT-EMAIL-OPT-OUT-UNSUBSCRIBE-20261001).
// They live in the same notification_prefs map but are not notification kinds:
// "announcements" governs broadcast email, "surveys" survey invitations and reminders,
// "welcome" welcome-sequence and first-sign-in email (unset follows announcements),
// and a one-click unsubscribe link turns one of them off. Unlike a topic, a key the caller did not send is
// NOT written: the database keeps the stored choice, so a write that predates
// these keys (or a topic toggle) can never silently re-subscribe a member who
// unsubscribed from an email.
export const ENGAGEMENT_EMAIL_PREFERENCE_KEYS = ["announcements", "surveys", "welcome"];

// REQ-UG-ONBOARDING-ADMIN-SERVER-GAPS-20261104: "onboarding" lets a
// member turn off the reminder onboarding staff can send them (at most one a
// day). It is not a notification kind either: like the email choices it is
// written only when the member flips it, and the database keeps a stored
// choice that a write omits.
export const REMINDER_PREFERENCE_KEYS = ["onboarding"];

// The shape a member row would carry if notification_prefs were ever absent.
// Derived, never restated: the standalone literal that used to sit at the
// loadMemberApp call site had already drifted off this list (it predated
// 'forms'), which is precisely the silent-drop the comment above warns about.
// The column is `not null default …`, so this is belt-and-braces today.
const DEFAULT_NOTIFICATION_PREFS = Object.fromEntries(NOTIFICATION_TOPIC_KEYS.map((key) => [key, true]));

export async function updateMemberSettings(client, userId, fields, { asUser = null } = {}) {
  const pinned = asUser ? await pinnedSaveSession(client, asUser) : null;
  const patch = {};
  if (fields.language === "en" || fields.language === "es") patch.language = fields.language;
  if (Array.isArray(fields.shortcutKeys)) patch.shortcut_keys = [...fields.shortcutKeys];
  if (Array.isArray(fields.workWidgetOrder)) patch.work_widget_order = [...fields.workWidgetOrder];
  if (fields.notificationPrefs) {
    patch.notification_prefs = NOTIFICATION_TOPIC_KEYS.reduce((acc, key) => {
      // A key the caller did not send writes TRUE, because absent-means-enabled
      // is the trigger's rule too. Coercing absent to false silently turned a
      // topic OFF for a member who never touched its switch — exactly what a
      // partial caller would have done to 'tasks' the day it was added.
      acc[key] = Object.hasOwn(fields.notificationPrefs, key) ? Boolean(fields.notificationPrefs[key]) : true;
      return acc;
    }, {});
    for (const key of [...ENGAGEMENT_EMAIL_PREFERENCE_KEYS, ...REMINDER_PREFERENCE_KEYS]) {
      if (Object.hasOwn(fields.notificationPrefs, key)) patch.notification_prefs[key] = Boolean(fields.notificationPrefs[key]);
    }
  }
  if (typeof fields.dndEnabled === "boolean") patch.dnd_enabled = fields.dndEnabled;
  if (Object.hasOwn(fields, "quietHoursStart")) patch.quiet_hours_start = fields.quietHoursStart || null;
  if (Object.hasOwn(fields, "quietHoursEnd")) patch.quiet_hours_end = fields.quietHoursEnd || null;
  if (fields.quietHoursTimezone) patch.quiet_hours_timezone = fields.quietHoursTimezone;
  if (typeof fields.urgentNotificationsEnabled === "boolean") {
    patch.urgent_notifications_enabled = fields.urgentNotificationsEnabled;
  }
  if (!Object.keys(patch).length) return null;
  return expectWrite(await pinnedMemberRequest(client.rpc("update_my_member_profile", { p_expected_user_id: userId, p_fields: patch }), pinned), "Update settings");
}

// Web-push subscription registry (PR5). An endpoint identifies a browser, not
// a person, so it is globally unique and enabling push REASSIGNS it to the
// caller — otherwise two members sharing a device would both hold a row and
// only the first would ever receive anything. Reassignment touches a row the
// caller does not own, which RLS forbids, so the write goes through a definer
// RPC rather than a direct upsert. No user agent is sent: nothing reads it,
// and it is device-fingerprinting material sitting next to a member id.
// No userId parameter: the RPC derives the owner from auth.uid() server-side.
// Accepting one here would imply the caller can choose whose row this becomes.
export async function subscribeToPush(client, subscription) {
  const keys = subscription?.keys || {};
  const { error } = await client.rpc("upsert_push_subscription", {
    p_endpoint: subscription.endpoint,
    p_p256dh: keys.p256dh,
    p_auth: keys.auth,
  });
  if (error) throw new MemberApiError("Save push subscription failed", error);
  return true;
}

export async function unsubscribeFromPush(client, userId, endpoint) {
  return expectWrite(await client.from("member_push_subscriptions").delete().eq("user_id", userId).eq("endpoint", endpoint), "Remove push subscription");
}

// "Is this browser's endpoint registered to THIS member?" RLS scopes the read
// to the caller's own rows, so a row belonging to a previous member of a
// shared device correctly reads as absent.
export async function hasPushSubscription(client, userId, endpoint) {
  const { data, error } = await client
    .from("member_push_subscriptions")
    .select("id")
    .eq("user_id", userId)
    .eq("endpoint", endpoint)
    .maybeSingle();
  if (error) throw new MemberApiError("Read push subscription failed", error);
  return Boolean(data);
}

export async function listMemberSessions(client) {
  return requireData(await client.rpc("list_my_sessions"), "Sessions");
}

// Session controls are opaque-handle-only. The server derives both the member
// and current Auth session from the JWT; the browser never chooses a raw
// vendor session id or another account's scope.
export async function revokeMemberSession(client, sessionHandle) {
  return requireData(await client.rpc("revoke_my_session", {
    p_session_handle: sessionHandle,
  }), "Sign out device");
}

export async function prepareMemberSignOut(client, scope, expectedUserID) {
  return requireData(await client.rpc("prepare_my_signout", {
    p_scope: scope,
    p_expected_user_id: expectedUserID,
  }), "Prepare sign-out");
}

// Realtime in-app feed (PR5): INSERTs on the member's own notifications and
// participant-only task messages. RLS scopes both streams server-side
// (Realtime checks the select policy per subscriber); the notification filter
// further narrows that table to the current member.
// onSubscribed fires when the channel is actually live — rows inserted between
// the initial query and that moment belong to neither source, so the caller
// uses it to close the gap with a single refetch.
// Returns an unsubscribe function for effect cleanup.
// The fifth argument is either the task-message handler or, for callers that
// only need the notification stream, the access token. A token (fifth or sixth
// argument) is handed to Realtime BEFORE the channel joins: after an MFA
// assurance change the socket must not subscribe with the stale aal1 token,
// and a failed setAuth never subscribes at all — the next auth event retries
// with its own token-bound effect.
export function subscribeToNotificationInserts(client, userId, onInsert, onSubscribed, onTaskMessageInsertOrToken, accessToken = "") {
  const onTaskMessageInsert = typeof onTaskMessageInsertOrToken === "function" ? onTaskMessageInsertOrToken : null;
  const token = typeof onTaskMessageInsertOrToken === "string" ? onTaskMessageInsertOrToken : accessToken;
  let active = true;
  let channel = null;

  function subscribe() {
    if (!active) return;
    let next = client
      .channel(`member-notifications-${userId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "member_notifications", filter: `user_id=eq.${userId}` },
        (payload) => onInsert(payload.new),
      );
    if (onTaskMessageInsert) {
      next = next.on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chapter_task_messages" },
        (payload) => onTaskMessageInsert(chapterTaskMessageFromRow(payload.new)),
      );
    }
    channel = next.subscribe((status) => {
      if (status === "SUBSCRIBED" && typeof onSubscribed === "function") onSubscribed();
    });
  }

  if (token && client.realtime?.setAuth) {
    Promise.resolve(client.realtime.setAuth(token)).then(subscribe).catch(() => {});
  } else {
    subscribe();
  }

  return () => {
    active = false;
    if (channel) client.removeChannel(channel);
  };
}

// Live board sync (REQ-UG-KANBAN-PHASE1-20260801). NOT postgres_changes:
// remote moves and reorders are UPDATEs, and the supabase_realtime publication
// is deliberately INSERT-only (20260728221416 pins that contract, because an
// UPDATE row broadcasts against RLS evaluated at insert time). The board rides
// a private per-chapter BROADCAST topic instead, fed by the AFTER triggers in
// 20260801170000, so the publication's shape is untouched.
//
// The payload realtime.broadcast_changes sends is
// {operation, table, schema, record, old_record}; it is normalised to camel
// case here so the App-side reducer never reads two spellings of one field.
// Table rows stay snake_case — chapterTaskFromRow is their mapper.
//
// onSubscribed marks the moment the channel is live, which is when the caller
// closes the query-to-subscription gap with loadChapterTaskBoard.
// Returns an unsubscribe function for effect cleanup.
export function subscribeToChapterTaskBoard(client, chapterId, onEvent, onSubscribed) {
  const emit = (payload) => {
    if (typeof onEvent !== "function") return;
    const body = payload || {};
    onEvent({
      operation: String(body.operation || "").toUpperCase(),
      table: body.table || "",
      record: body.record || null,
      oldRecord: body.old_record || null,
    });
  };
  const channel = client
    .channel(`chapter-tasks:${chapterId}`, { config: { private: true } })
    .on("broadcast", { event: "INSERT" }, (message) => emit(message?.payload))
    .on("broadcast", { event: "UPDATE" }, (message) => emit(message?.payload))
    .on("broadcast", { event: "DELETE" }, (message) => emit(message?.payload));
  // A private topic is authorized by the realtime.messages SELECT policy, which
  // needs the member's access token on the socket. Fire-and-forget on purpose:
  // awaiting it would make this function async, and the caller's effect cleanup
  // would then race the subscription it exists to tear down. A rejection is
  // swallowed rather than left unhandled — the socket re-auths on the next auth
  // event, and a board that misses live updates still refetches on view entry.
  try {
    const authed = client.realtime?.setAuth?.();
    if (authed && typeof authed.catch === "function") authed.catch(() => { /* the next auth event re-authorizes the socket */ });
  } catch { /* no realtime client (stubbed or offline) — subscribe still no-ops safely */ }
  channel.subscribe((status) => {
    if (status === "SUBSCRIBED" && typeof onSubscribed === "function") onSubscribed();
  });
  return () => client.removeChannel(channel);
}

// PushManager.subscribe needs the VAPID public key as a Uint8Array; the env
// var carries it base64url-encoded.
export function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

// The four member writes below each run as ONE security-definer transaction.
// What they replaced was two or three independent PostgREST calls, and every
// gap between them was a place a dropped connection left the write half-done —
// a message whose conversation was never touched (invisible to the steward
// desk, which orders by updated_at), a case that committed but whose retry
// minted a second reference, a vote counted behind a failure toast.
//
// No userId/user parameter on any of them: the RPC derives the owner from
// auth.uid() server-side. Accepting one here would imply the caller gets to
// choose whose message, case, or vote this becomes — and a definer function
// carries no RLS to catch that.
//
// No senderName either. sender_name used to be client-supplied and is rendered
// raw in the steward desk, so a member could sign a message 'Chapter steward';
// the server now derives it from the profile.
//
// Each function also re-states the MFA assurance check, because SECURITY
// DEFINER bypasses the restrictive mfa_assurance policy that guards every
// table. Deliberately NOT queued in the offline outbox: replaying
// create_member_case would mint duplicate cases, which is the exact defect the
// server-generated reference exists to prevent.
export async function sendMemberMessage(client, conversationId, body) {
  // The RPC returns {messageId, awardedPoints}; the caller uses messageId to
  // reconcile its optimistic bubble even when the follow-up reload fails.
  return expectWrite(await client.rpc("send_member_message", { p_conversation_id: conversationId, p_body: body }), "Send message");
}

export async function startMemberConversation(client, body) {
  return expectWrite(await client.rpc("start_member_conversation", { p_body: body }), "Start conversation");
}

// Reward-backed peer contact is deliberately separate from the steward DM
// tables. The browser can submit only an opaque share code or an already-
// authorized request/conversation id; it never supplies a target identity,
// chapter, display name, email address, or entitlement flag.
export async function listRewardPeerContact(client) {
  return expectWrite(await client.rpc("list_reward_peer_contact"), "Member contact");
}

export async function requestRewardPeerContact(client, contactCode) {
  return expectWrite(await client.rpc("request_reward_peer_contact", {
    p_contact_code: String(contactCode || "").trim().toUpperCase(),
  }), "Member contact");
}

export async function respondRewardPeerContact(client, requestId, accept) {
  return expectWrite(await client.rpc("respond_reward_peer_contact", {
    p_request_id: requestId,
    p_accept: Boolean(accept),
  }), "Member contact");
}

export async function sendRewardPeerMessage(client, conversationId, body, operationId) {
  return expectWrite(await callPeerMessageRpc((args) => client.rpc("send_reward_peer_message", args), "send_reward_peer_message", {
    p_conversation_id: conversationId,
    p_body: String(body || "").trim(),
  }, operationId), "Member contact message");
}

//: block or unblock the other person of one of the caller's own
// conversations; the server answers with the caller's state.
export async function setPeerConversationBlock(client, conversationId, blocked) {
  return expectWrite(await client.rpc("set_peer_conversation_block", {
    p_conversation_id: conversationId,
    p_blocked: Boolean(blocked),
  }), "Member contact block");
}

export async function toggleMemberMessageReaction(client, sourceKind, messageId, reaction) {
  if (sourceKind === "private" || sourceKind === "channel") return (await messageActionRequest(client, sourceKind, messageId, "react", reaction)).result;
  return expectWrite(await client.rpc("toggle_member_message_reaction", {
    p_source_kind: sourceKind,
    p_message_id: messageId,
    p_reaction: reaction,
  }), "React to message");
}

export async function toggleMemberSavedMessage(client, sourceKind, messageId) {
  if (sourceKind === "private" || sourceKind === "channel") return (await messageActionRequest(client, sourceKind, messageId, "save")).result;
  return expectWrite(await client.rpc("toggle_member_saved_message", {
    p_source_kind: sourceKind,
    p_message_id: messageId,
  }), "Save message");
}

export async function scheduleMemberMessage(client, conversationId, body, scheduledFor) {
  return expectWrite(await client.rpc("schedule_member_message", {
    p_conversation_id: conversationId,
    p_body: body.trim(),
    p_scheduled_for: scheduledFor,
  }), "Schedule message");
}

export async function cancelScheduledMemberMessage(client, scheduledMessageId) {
  return expectWrite(await client.rpc("cancel_scheduled_member_message", {
    p_scheduled_message_id: scheduledMessageId,
  }), "Cancel scheduled message");
}

export async function createMemberMessageReminder(client, sourceKind, messageId, remindAt, note = "") {
  if ((sourceKind === "private" || sourceKind === "channel") && !note.trim()) return (await messageActionRequest(client, sourceKind, messageId, "remind", remindAt)).result;
  return expectWrite(await client.rpc("create_member_message_reminder", {
    p_source_kind: sourceKind,
    p_message_id: messageId,
    p_remind_at: remindAt,
    p_note: note.trim(),
  }), "Create message reminder");
}

export async function cancelMemberMessageReminder(client, reminderId) {
  return expectWrite(await client.rpc("cancel_member_message_reminder", {
    p_reminder_id: reminderId,
  }), "Cancel message reminder");
}

export async function sendMemberResource(client, conversationId, documentId, body = "") {
  return expectWrite(await client.rpc("send_member_resource", {
    p_conversation_id: conversationId,
    p_document_id: documentId,
    p_body: body.trim() || null,
  }), "Share resource");
}

// SEC-UG-MESSAGE-BODY-LIFECYCLE. The RPC decides authority server-side:
// the member may remove only messages the member sent, chapter staff may remove
// content authored inside their own chapter, and a conversation under a
// preservation order refuses both. The client sends nothing but the message id.
export async function redactMemberMessage(client, messageId) {
  return expectWrite(await client.rpc("redact_member_message", { p_message_id: messageId }), "Remove message");
}

export async function markConversationRead(client, userId, conversationId, { asUser = null } = {}) {
  const pinned = asUser ? await pinnedSaveSession(client, asUser) : null;
  return expectWrite(await pinnedMemberRequest(client.from("member_messages").update({ read_at: new Date().toISOString() }).eq("user_id", userId).eq("conversation_id", conversationId).eq("sender_kind", "steward").is("read_at", null), pinned), "Mark conversation read");
}

export async function markBroadcastRead(client, userId, broadcastId, { asUser = null } = {}) {
  const pinned = asUser ? await pinnedSaveSession(client, asUser) : null;
  return expectWrite(await pinnedMemberRequest(client.from("member_broadcast_receipts").upsert(
    { user_id: userId, broadcast_id: broadcastId },
    { onConflict: "broadcast_id,user_id", ignoreDuplicates: true },
  ), pinned), "Mark broadcast read");
}

// No reference is sent: the server allocates it from a CSPRNG suffix inside the
// insert's retry loop. The old client-side `GR-<year>-<last 5 of Date.now()>`
// regenerated a DIFFERENT value on retry, which is how one incident became two
// grievances. Returns { caseId, reference, awardedPoints }.
// The member's own intake, now with its case details
// (REQ-UG-STEWARD-CASEWORK-GAPS-20261030): open_member_case, which
// falls back to create_member_case while the migration is not yet applied.
export async function createMemberCase(client, fields) {
  return openMemberCase(client, { ...fields, memberId: null });
}

// REQ-UG-LEARNING-PERIOD-CASE-RECORDS-20261103: the member's own case
// edit and note go through journalled RPCs; the server derives the owner, so
// userId is no longer sent.
export async function updateMemberCase(client, userId, caseId, fields) {
  // A case under an organization procedure carries no member step edit: the
  // step is a configured key advanced through casework_advance_step.
  const args = { p_case_id: caseId, p_status: fields.status, p_deadline: fields.deadline || null };
  if (fields.step !== undefined) args.p_step = fields.step;
  return expectWrite(await client.rpc("update_my_member_case", args), "Update case");
}

// occurredOn: the date the note is about (REQ-UG-STEWARD-CASE-NOTES-AND-STEP-DEADLINES-20261030).
export async function addCaseUpdate(client, userId, caseId, body, occurredOn = null) {
  const dated = /^\d{4}-\d{2}-\d{2}$/.test(String(occurredOn ?? "")) ? occurredOn : null;
  return expectWrite(await client.rpc("add_my_case_update", {
    p_case_id: caseId, p_body: body.trim(), p_occurred_on: dated,
  }), "Add case update");
}

// The receipt now comes back from inside the transaction that counted the vote,
// so a network failure can no longer show a failure toast over a recorded
// ballot. Always a string — "" and never null/undefined, because App.jsx gates
// the receipt toast on truthiness. Votes are FINAL (20260808230000): a second
// submission is refused server-side with 'your vote is already recorded',
// which App.jsx translates the same way it translates the closed refusal.
export async function submitBallot(client, ballotId, optionId) {
  const result = await expectWrite(await client.rpc("submit_ballot_vote", { p_ballot_id: ballotId, p_option_id: optionId }), "Submit ballot");
  return result?.receiptCode || "";
}

export async function verifyBallotReceipt(client, code) {
  return expectWrite(await client.rpc("verify_ballot_receipt", { p_code: code }), "Verify receipt");
}

export async function submitSurvey(client, surveyId, optionId) {
  return expectWrite(await client.rpc("submit_survey_response", { p_survey_id: surveyId, p_option_id: optionId }), "Submit survey");
}

export async function saveRightsProgress(client, userId, lessonId, completedSteps, { asUser = null } = {}) {
  const pinned = asUser ? await pinnedSaveSession(client, asUser) : null;
  await expectWrite(await pinnedMemberRequest(client.from("member_rights_progress").upsert({ lesson_id: lessonId, user_id: userId, completed_steps: completedSteps, updated_at: new Date().toISOString() }), pinned), "Save rights progress");
}

// No action-log or point write rides along with any member flow here:
// Union Ground's 20260724053134 revoked client writes to the action log
// and retired point minting, so asking for help never becomes a score.
export async function requestSteward(client, userId, lessonId) {
  await expectWrite(
    await client.from("member_steward_requests").insert({ user_id: userId, lesson_id: lessonId }).select("id").single(),
    "Request steward",
  );
}

export async function saveGuideExchange(client, userId, threadId, question, answer, sources = null) {
  if (!userId) throw new Error("Save guide exchange: member session required");
  return expectWrite(await client.rpc("save_member_guide_exchange", {
    p_thread_id: threadId,
    p_question: question,
    p_answer: answer,
    p_sources: Array.isArray(sources) && sources.length ? sources : null,
  }), "Save guide exchange");
}

// OPS-UG-ANALYTICS-READ-SIDE-SHIPPED-BUT-NOTHING-IN-PRODUCTION-WRITES-ORGANIZATION-ENGAGEMENT-EVENTS-20260921
//: one authenticated, rate-limited page view per
// workspace page change. The RPC derives the organization from the session
// (an explicit different organization is refused), records the hat only when
// the caller holds it, and answers recorded=false for a repeat inside the
// minute or for the per-minute bound instead of raising.
export async function recordWorkspacePageView(client, page, hat = "member", organizationId = null) {
  return expectWrite(await client.rpc("record_workspace_page_view", {
    p_page: page,
    p_hat: hat || "member",
    p_organization_id: organizationId || null,
  }), "Record page view");
}

// RSVP and check-in write only through security-definer RPCs: the RSVP RPC
// upserts the member's response atomically; the check-in RPC validates the
// per-event code (never exposed to the client) inside the event window before
// recording attendance. The recognition migration retires all
// point minting.
export async function submitEventRsvp(client, eventId, status, { asUser = null } = {}) {
  const pinned = asUser ? await pinnedSaveSession(client, asUser) : null;
  return expectWrite(await pinnedMemberRequest(client.rpc("rsvp_to_event", { p_event_id: eventId, p_status: status }), pinned), "RSVP");
}

export async function checkInToEvent(client, eventId, code) {
  const result = await expectWrite(await client.rpc("check_in_to_event", { p_event_id: eventId, p_code: code.trim() }), "Check in");
  // SEC-UG-EVENT-CHECKIN-CODE-UNBOUNDED-GUESSES-20260920: a refused code
  // (wrong, or the caller is locked out, which the owner ruled indistinguishable)
  // comes back as a payload so the attempt count survives the refusal. Surface
  // it exactly as the raised refusal was surfaced: a thrown failure, never a
  // successful check-in, and never retried here.
  if (result && typeof result === "object" && result.checkedIn === false) {
    // The payload's token is the translatable reason. There is one refusal
    // literal, so a payload from before the token existed means the same thing.
    throw new MemberApiError("Check in", { code: result.code ?? "22023", message: result.message ?? "invalid check-in code", details: result.token ?? "checkin_code_invalid" });
  }
  return result;
}

// Signed check-in: the member mints their own short-lived single-use code
// (plaintext returned once, only its hash is stored) and a steward redeems it.
// The token is not part of loadMemberApp's shape, so neither call refreshes
// the member data snapshot.
export async function requestEventCheckinToken(client, eventId) {
  // { token, expiresAt, ttlSeconds }
  return expectWrite(await client.rpc("request_event_checkin_token", { p_event_id: eventId }), "Check-in code");
}

export async function scanEventCheckin(client, eventId, token) {
  // { memberUserId, checkedIn, alreadyCheckedIn, memberAwardedPoints, scannerAwardedPoints }
  return expectWrite(await client.rpc("scan_event_checkin", { p_event_id: eventId, p_token: (token || "").trim() }), "Scan");
}

// Calendar subscribe feed: the RPC returns the plaintext link token exactly
// once; afterwards only rotate (new link) or revoke (no link) are possible.
export async function getCalendarFeedStatus(client) {
  return expectWrite(await client.rpc("get_calendar_feed_status"), "Calendar link status");
}

export async function rotateCalendarFeedToken(client) {
  // { token }
  return expectWrite(await client.rpc("rotate_calendar_feed_token"), "Calendar link");
}

export async function revokeCalendarFeedToken(client) {
  // { revoked }
  return expectWrite(await client.rpc("revoke_calendar_feed_token"), "Calendar link");
}

export async function submitWorkloadLog(client, f) {
  if (f.configurationVersion !== undefined) {
    const args = {
      p_entry_id: f.entryId || null, p_version: f.configurationVersion, p_values: f.values, p_status: f.status,
      p_organization_id: f.organizationId,
    };
    return expectWrite(Object.hasOwn(f, "unitId")
      ? await client.rpc("save_unit_workload_log", { ...args, p_unit: f.unitId, p_settings_revision: f.settingsRevision ?? null, p_actor: f.actorId, p_chapter: f.chapterId })
      : await client.rpc("save_configured_workload_log", args), "Workload");
  }
  return expectWrite(await client.rpc("submit_workload_log", {
    p_priority: f.priority, p_pending: f.pending, p_unread_docs: f.unread_docs, p_todos: f.todos,
    p_referrals: f.referrals, p_ce_activities: f.ce_activities,
    p_assistance_requests: f.assistance_requests, p_aged_cases: f.aged_cases,
    p_weekly_assigned: f.weeklyAssigned, p_employment: f.employment, p_pt_hours: f.ptHours ?? null,
    p_on_plan: f.onPlan, p_ot_worked: f.otWorked, p_ot_hours: f.otHours,
    p_leave_type: f.leaveType || null, p_leave_timing: f.leaveTiming || null,
    p_no_intake: f.noIntake, p_half_day: f.halfDay,
    p_note: f.note || null, p_sub_details: f.subDetails || {},
  }), "Workload");
}

export async function getWorkloadReminderPreferences(client) {
  return expectWrite(await client.rpc("get_workload_reminder_preferences"), "Workload reminders");
}

export async function setWorkloadReminderPreferences(client, fields) {
  return expectWrite(await client.rpc("set_workload_reminder_preferences", {
    p_enabled: Boolean(fields.enabled),
    p_cadence: fields.cadence,
    p_weekday: Number(fields.weekday),
    p_local_hour: Number(fields.localHour),
    p_timezone: fields.timezone,
  }), "Workload reminders");
}

// SEC-UG-FMLA-FORM-ANSWERS-ENCRYPTION-PARITY-20261022: FMLA
// answers are sealed by /api/sensitive-content (owner default D1); the list
// must match SEALED_FORM_TEMPLATES in api/_lib/sensitiveContent.js. Their rows
// carry only a marker, and these helpers open them through the API, 100 ids
// per call. A form whose answers cannot be opened is marked unavailable, never
// shown as empty, so no editor can autosave over it.
export const SEALED_FORM_TEMPLATE_KEYS = new Set(["fmla_self", "fmla_family"]);
const SEALED_SAVE_SESSION_CHANGED = { code: "SESSION_CHANGED", message: "You were signed out or switched accounts, so this form was not saved." };

async function sealedSaveSession(client) {
  const session = (await client.auth.getSession()).data?.session;
  return session?.access_token && session.user?.id ? { token: session.access_token, userId: session.user.id } : null;
}

// A write the caller pinned to the member it was started for (`asUser`: that
// member's id and access token, taken at the actor check). Reading the session
// waits on the cross-tab auth lock, and the shared client would send as
// whoever that read returns; so the write stops, sending nothing, unless the
// signed-in member is still the pinned one, and its requests carry that
// member's token from this check rather than the client's later read (
// held-commit review). The token is the one just read, not the pinned copy: a
// refresh while the write waited (an offline replay) leaves the pinned copy
// expired, and a write sent with it would be refused ( r9s1/r11s1/r12s2).
async function pinnedSaveSession(client, asUser) {
  if (!asUser?.userId || !asUser.accessToken) throw new MemberApiError("Form", SEALED_SAVE_SESSION_CHANGED);
  const current = await sealedSaveSession(client);
  if (current?.userId !== asUser.userId) throw new MemberApiError("Form", SEALED_SAVE_SESSION_CHANGED);
  return current;
}

function pinnedMemberRequest(request, pinned) {
  return pinned ? request.setHeader("Authorization", `Bearer ${pinned.token}`) : request;
}

export async function hydrateSealedFormAnswers(client, rows) {
  // answers.sealed is encryption metadata only on a sealed template; an ordinary
  // template may have a plain field named "sealed" .
  const isSealedRow = (row) => row?.answers?.sealed === true && SEALED_FORM_TEMPLATE_KEYS.has(row?.template_key);
  const sealed = rows.filter(isSealedRow);
  const opened = new Map();
  for (let offset = 0; offset < sealed.length; offset += 100) {
    const result = await sensitiveContentRpc(client, "get_sealed_forms", { formIds: sealed.slice(offset, offset + 100).map((row) => row.id) });
    for (const item of result.error ? [] : result.data || []) {
      if (!item.contentError) opened.set(item.id, { answers: item.answers || {}, dataVersion: typeof item.dataVersion === "string" ? item.dataVersion : null });
    }
  }
  return (row) => {
    // An FMLA row that still holds plaintext before the maintenance backfill is
    // shown as unavailable, never rendered or edited ( r1g4).
    if (row?.answers?.sealed !== true && SEALED_FORM_TEMPLATE_KEYS.has(row?.template_key)
      && Object.keys(row?.answers || {}).some((key) => key !== "seedSequence")) {
      return { answers: {}, sealed: true, answersUnavailable: true };
    }
    if (!isSealedRow(row)) return { answers: row?.answers || {} };
    // dataVersion is the stored envelope's version, the baseline a save of
    // these answers must name . It comes from the same read as the
    // answers, never from the earlier list query's marker, which another
    // device's save may have moved past in between .
    return opened.has(row.id) ? { ...opened.get(row.id), sealed: true } : { answers: {}, sealed: true, answersUnavailable: true };
  };
}

// Forms (P4b) write only through security-definer RPCs — the member_forms table
// grants SELECT only. save_form_draft upserts the caller's in-progress
// (draft|returned) row for a template and returns its id; submit_form flips the
// caller's own row to 'submitted' and logs the prefix-anchored +15 point action.
// A sealed save names the data version its answers were built from and
// resolves to { formId, dataVersion }, the version it stored . A caller
// that does not yet know its draft's id passes onFormId: the draft is prepared
// first and its id reported before any answers are sent ( round 2).
// Both sealed requests bear the session the save started under, and the
// answers are dropped if the signed-in member changes across either await, so
// an account switch mid-save can never send one member's medical answers into
// another member's draft ( round 3). A prepared save names its form, and
// the API refuses it if the draft it would write is a different one.
// The member's ordinary draft as it is stored now, with the revision of that
// write: the form a replayed save names, or else the member's newest open
// form of the template. A replayed save refused as saved elsewhere reads it to
// recognise its own lost reply . Null when there is none. Bound like a
// save (`asUser`): it reads nothing unless the pinned member is still signed
// in, and goes out with their token. It also reads the draft's unit (its
// settings scope) and organization, so the replay confirms a write only from
// the draft its entry was for ( round 1, r2s2).
export async function readStoredFormDraft(client, { userId, templateKey, formId = null }, { asUser = null } = {}) {
  if (!userId || !templateKey) return null;
  const pinned = asUser ? await pinnedSaveSession(client, asUser) : null;
  let query = client.from("member_forms").select("id,answers,revision,settings_scope,organization_id").eq("user_id", userId).eq("template_key", templateKey);
  query = formId ? query.eq("id", formId) : query.in("status", ["draft", "returned"]).order("updated_at", { ascending: false });
  const { data, error } = await pinnedMemberRequest(query.limit(1), pinned);
  if (error) throw new MemberApiError("Form", error);
  const [row] = Array.isArray(data) ? data : [];
  return row ? { id: row.id, answers: row.answers ?? {}, revision: Number.isSafeInteger(row.revision) ? row.revision : null,
    settingsScope: row.settings_scope && typeof row.settings_scope === "object" ? row.settings_scope : {}, organizationId: row.organization_id ?? null } : null;
}

export async function saveFormDraft(client, { templateKey, answers, step, expectedDataVersion = null, formId: laneFormId = null, onFormId = null, baseAnswers = null, baseRevision = undefined, unitId = undefined, actorId, chapterId, organizationId }, { asUser = null } = {}) {
  const pinned = asUser ? await pinnedSaveSession(client, asUser) : null;
  if (SEALED_FORM_TEMPLATE_KEYS.has(templateKey)) {
    const initiating = pinned || await sealedSaveSession(client);
    if (!initiating) throw new MemberApiError("Form", SEALED_SAVE_SESSION_CHANGED);
    const fence = async () => {
      if ((await sealedSaveSession(client))?.userId !== initiating.userId) throw new MemberApiError("Form", SEALED_SAVE_SESSION_CHANGED);
    };
    // The lane's known form rides on every save and retry, so the server
    // refuses one whose form was submitted meanwhile instead of writing into
    // a fresh draft; preparation runs only while the lane has none .
    let formId = typeof laneFormId === "string" && laneFormId ? laneFormId : undefined;
    if (!formId && typeof onFormId === "function") {
      const prepared = await expectWrite(await sensitiveContentRpc(client, "prepare_sealed_form", { templateKey, ...(unitId !== undefined ? { unitId, actorId, chapterId, organizationId } : {}) }, "", initiating.token), "Form");
      await fence();
      formId = prepared.formId;
      onFormId(formId);
    }
    const saved = await expectWrite(await sensitiveContentRpc(client, "save_sealed_form_draft",
      { templateKey, answers: answers || {}, step: step ?? 0, expectedDataVersion, ...(formId ? { formId } : {}), ...(unitId !== undefined ? { unitId, actorId, chapterId, organizationId } : {}) }, "", initiating.token), "Form");
    await fence();
    return saved;
  }
  // An ordinary save names the lane's form too: the server writes only
  // that form while it is still open, and refuses (PT409 form_not_editable)
  // rather than creating a second draft once it was submitted elsewhere.
  // It also names the answers it was based on, the ones last known to be
  // stored: a draft another session saved since refuses (PT409
  // form_saved_elsewhere) instead of being overwritten.
  const common = { p_template_key: templateKey, p_answers: answers || {}, p_step: step ?? 0 };
  // A save that names the revision it was based on  goes through
  // save_member_form_draft: the server refuses it (PT409 form_saved_elsewhere)
  // unless that revision is still the stored one, and answers with the
  // revision it wrote, {formId, revision}. A revision is a number for one
  // form only, so a base above 0 always names its form. Outbox entries queued
  // before revisions existed name none and are sent as they were queued,
  // checked against their base answers. This needs 20261120222533 on the
  // database first.
  if (Number.isSafeInteger(baseRevision)) {
    const revised = { ...common, p_expected_form_id: typeof laneFormId === "string" && laneFormId ? laneFormId : null, p_base_revision: baseRevision };
    if (unitId !== undefined) {
      const unit = { p_unit: unitId, p_actor: actorId, p_chapter: chapterId, p_organization: organizationId };
      return expectWrite(await pinnedMemberRequest(client.rpc("save_unit_member_form_draft", { ...revised, ...unit }), pinned), "Form");
    }
    return expectWrite(await pinnedMemberRequest(client.rpc("save_member_form_draft", revised), pinned), "Form");
  }
  const bound = typeof laneFormId === "string" && laneFormId ? { ...common, p_expected_form_id: laneFormId } : common;
  const based = baseAnswers && typeof baseAnswers === "object" && !Array.isArray(baseAnswers) ? { ...bound, p_base_answers: baseAnswers } : bound;
  // A save is sent once, with every argument it was built with, and is never
  // resent with fewer (BUG-UNIONGROUND-FORM-SAVE-RESENT-WITH-FEWER-ARGUMENTS-
  // UNDER-ANOTHER-ACCOUNT-20261115). A resend runs through the shared client as
  // whichever account is signed in by then, and one without the form id is an
  // unbound save that can create or overwrite that account's draft with these
  // answers. A missing function (PGRST202, 42883, 404) therefore reaches the
  // caller as a failed save with its code kept: the member reads the plain
  // "service busy" sentence (rpcErrorText) and the editor keeps every answer.
  // This needs 20261113134400 (and 20261113114500) on the database first.
  if (unitId !== undefined) {
    const unit = { p_unit: unitId, p_actor: actorId, p_chapter: chapterId, p_organization: organizationId };
    return expectWrite(await pinnedMemberRequest(client.rpc("save_unit_form_draft", { ...based, ...unit }), pinned), "Form");
  }
  return expectWrite(await pinnedMemberRequest(client.rpc("save_form_draft", based), pinned), "Form");
}

// `review` names what the submitter reviewed, built like a signature's
// (formSignatureExpectation below). submit_form compares it under the form
// lock and refuses with PT409 form_changed_since_review, filing nothing, when
// another session changed or re-signed the form in between .
export async function submitForm(client, formId, review = null) {
  const common = { p_form_id: formId };
  const expected = formSignatureExpectation(review);
  const versioned = expected ? { ...common, p_expected: expected } : common;
  let result = await client.rpc("submit_form", versioned);
  // Code deploys before hosted migrations: until 20261113115500 submit_form
  // takes no expectation, so the same submission goes once without it.
  if (versioned !== common && result.error && (result.status === 404 || ["PGRST202", "42883"].includes(result.error.code))) {
    result = await client.rpc("submit_form", common);
  }
  return expectWrite(result, "Form");
}

// REQ-UG-FORMS-RETIRE-RETAINED-LANE-AFTER-REMOTE-DISCARD-20261112
//: whether the member still has the form a retained save lane names,
// read now and directly (never through the session loader, so no cached or
// retained list can answer). True: the row exists. False: a successful read
// found no row of theirs with that id (discarded elsewhere). Throws on a
// failed read or when the signed-in member is not `memberId`, before or after
// the read; the caller then changes nothing.
export async function memberFormStillExists(client, formId, memberId) {
  const signedIn = async () => (await client.auth.getSession()).data?.session?.user?.id ?? null;
  const changed = { code: "SESSION_CHANGED", message: "You were signed out or switched accounts." };
  if (!memberId || (await signedIn()) !== memberId) throw new MemberApiError("Form", changed);
  const result = await client.from("member_forms").select("id").eq("id", formId).eq("user_id", memberId).limit(1);
  if (result.error) throw new MemberApiError("Form", result.error);
  if ((await signedIn()) !== memberId) throw new MemberApiError("Form", changed);
  return Array.isArray(result.data) && result.data.some((row) => row?.id === formId);
}

// REQ-UG-FORMS-DISCARD-DRAFT-AND-TEMPLATE-SIGNATURE-20261111: deletes
// the caller's own unsubmitted draft; anything else is refused as not found.
// Bound like a save (`asUser`): it sends nothing unless the pinned member is
// still signed in, and goes out with their token ( held-commit review).
export async function discardFormDraft(client, formId, { asUser = null } = {}) {
  const pinned = asUser ? await pinnedSaveSession(client, asUser) : null;
  const request = client.rpc("discard_form_draft", { p_form_id: formId });
  return expectWrite(await pinnedMemberRequest(request, pinned), "Form");
}

// What the signer reviewed, as sign_member_form compares it under the form
// lock (r3s2): a sealed form by the dataVersion its last checked save returned
// (its answers never travel in plaintext), an ordinary one by the answers that
// save sent, and either by the attachment ids on screen.
export function formSignatureExpectation(review) {
  if (!review || typeof review !== "object") return null;
  const attachments = Array.isArray(review.attachmentIds) ? { attachmentIds: review.attachmentIds } : {};
  return SEALED_FORM_TEMPLATE_KEYS.has(review.templateKey)
    ? { dataVersion: review.dataVersion ?? null, ...attachments }
    : { answers: review.answers ?? {}, ...attachments };
}

// A refusal (PT409 form_changed_since_review) means another session saved
// after review; nothing was signed. `signature` is a strokes array (drawn) or
// { kind: "typed", name } .
export async function signMemberForm(client, formId, signature, consent, review = null) {
  const common = { p_form_id: formId, ...signatureRpcArgs(signature), p_consent: consent === true };
  const expected = formSignatureExpectation(review);
  const versioned = expected ? { ...common, p_expected: expected } : common;
  let result = await client.rpc("sign_member_form", versioned);
  // Code deploys before hosted migrations: until 20261113114500 the signature
  // takes no expectation, so the same signature goes once without it.
  if (versioned !== common && result.error && (result.status === 404 || ["PGRST202", "42883"].includes(result.error.code))) {
    result = await client.rpc("sign_member_form", common);
  }
  return expectWrite(result, "Form signature");
}

// The refusal sign_member_form gives when the stored form moved after review.
export function isFormChangedSinceReview(error) {
  return typeof error?.details === "string" && error.details.trim() === "form_changed_since_review";
}

// The refusal save_form_draft gives when another session saved the draft after
// the answers this save was based on: nothing was written.
export function isFormSavedElsewhere(error) {
  return typeof error?.details === "string" && error.details.trim() === "form_saved_elsewhere";
}

// The final refusal save_form_draft gives when the form it names was submitted
// or closed elsewhere: nothing was written, and a retry is refused the same way.
export function isFormNotEditable(error) {
  return typeof error?.details === "string" && error.details.trim() === "form_not_editable";
}

export async function getFormFilingStatus(client, formId) {
  return expectWrite(await client.rpc("get_form_filing_status", { p_form_id: formId }), "Filing status");
}

export async function addMemberFormFile(client, formId, file, { onPhase, retryUpload } = {}) {
  if (typeof retryUpload === "function") return retryRegisteredUpload(retryUpload, client, "form", formId, onPhase);
  // Same contract as the case/task paths: convert, then refuse locally what
  // the server can never accept, before `register_member_form_file` runs.
  const prepared = validatePrivateUploadFile(await normalizeUploadFile(file, { onPhase }));
  const sealed = await formIsSealed(client, formId);
  const registered = await expectWrite(
    await client.rpc("register_member_form_file", {
      p_form_id: formId,
      p_filename: prepared.name,
      p_mime_type: prepared.type,
      p_size_bytes: prepared.size,
    }),
    "Attach form file",
  );
  const row = memberFormFileFromRow(registered);
  const reconcile = async (onPhase) => {
    notifyPhase(onPhase, "checking");
    try {
      await requestPrivateFileInspection(client, "form", row.id);
    } catch (error) {
      if (error instanceof PrivateFileError && error.code === "rejected") {
        // A refusal is final: remove the bytes through the existing tombstone
        // path rather than leaving a permanently unusable pending row.
        try { await removeMemberFormFile(client, row); } catch { /* tombstone remains retryable */ }
        notifyPhase(onPhase, "rejected");
        throw privateFileFailure("Attach form file", "rejected", error);
      }
      // Ambiguous: keep the bytes and the pending row, confirm nothing.
      const code = ambiguousCode(error);
      notifyPhase(onPhase, code);
      throw privateFileFailure("Attach form file", code, error);
    }

    // CONFIRMATION IS THE POINT OF NO RETURN FOR THESE BYTES.
    //
    // This path used to remove the row and the object whenever the confirmation
    // threw — including on an ambiguous failure (a dropped response, a statement
    // timeout) where the confirmation may well have COMMITTED. That destroys an
    // attachment the server had already accepted, and it is a decision taken on
    // no evidence. The case and task paths never do it: once confirmation has
    // begun they reconcile instead, retrying once and letting a decided refusal
    // replace an earlier transport error, and the row stays visible as "Upload
    // pending" until the member either retries or removes it deliberately
    // through the tombstone path. The form path now does exactly the same.
    notifyPhase(onPhase, "confirming");
    const confirmed = await confirmUploadedFile(
      client, { label: "Attach form file", confirmRpc: "confirm_member_form_file" }, row.id,
    );
    notifyPhase(onPhase, "done");
    return { ...row, confirmedAt: confirmed?.confirmedAt ?? confirmed?.confirmed_at ?? row.confirmedAt };
  };
  privateUploadRetries.set(reconcile, { client, kind: "form", recordId: formId });
  notifyPhase(onPhase, "uploading");
  let upload;
  try {
    // A sealed FMLA form's attachment  is encrypted by the server; the
    // browser never writes its bytes to Storage. A failed send is handled like
    // a refused Storage upload.
    upload = sealed
      ? await uploadSensitiveFormFile(client, row.id, prepared).catch((cause) => ({ error: cause }))
      : await client.storage.from(row.bucketId).upload(row.objectName, prepared, {
        contentType: row.mimeType,
        upsert: false,
      });
  } catch (cause) {
    const error = new MemberApiError("Attach form file", cause);
    error.retryUpload = reconcile;
    throw error;
  }
  if (upload.error) {
    let removed = false;
    try {
      const receipt = await removeMemberFormFile(client, row);
      removed = receipt?.id === row.id && receipt?.deleted === true;
    } catch { /* tombstone remains retryable */ }
    const error = new MemberApiError("Attach form file", upload.error);
    if (!removed) error.retryUpload = reconcile;
    throw error;
  }

  // `register_member_form_file` leaves the row unconfirmed, and the filing
  // surface already renders that as "Upload pending". Inspection therefore
  // sits between the bytes landing and the confirmation that makes the file
  // count towards a submission.

  try {
    return await reconcile(onPhase);
  } catch (error) {
    if (error?.privateFileCode !== "rejected") error.retryUpload = reconcile;
    throw error;
  }
}

//: the server marks, deletes and finalizes (api/sensitive-form-files.js),
// because row security hides an unconfirmed object from the member's own
// Storage delete. A failure leaves the removal mark, so trying again finishes it.
export async function removeMemberFormFile(client, fileRow) {
  try {
    return await removeSensitiveFormFile(client, fileRow.id);
  } catch (cause) {
    throw new MemberApiError("Remove form file", { message: cause?.message || "form-file-removal-unavailable" });
  }
}

export async function memberFormFileBlob(client, fileRow) {
  const sealed = fileRow?.sealed ?? await formIsSealed(client, fileRow?.formId);
  if (!sealed) return privateFileBlob(client, fileRow, "Open form file");
  try { return await downloadSensitiveFormFile(client, fileRow.id); }
  catch (error) { throw privateFileFailure("Open form file", error?.staleVerdict ? "stale" : "unavailable", error); }
}

// The form's template decides whether its attachments are sealed .
async function formIsSealed(client, formId) {
  const result = await client.from("member_forms").select("template_key").eq("id", formId).maybeSingle();
  if (result.error || !result.data) throw new MemberApiError("Form", result.error || { message: "form unavailable" });
  return SEALED_FORM_TEMPLATE_KEYS.has(result.data.template_key);
}

// Alliance co-signers (P4b) — every write goes through a security-definer RPC;
// member_form_cosigners grants SELECT only. invite_cosigner returns a uniform
// {status:'invited'} whether or not the email maps to a member (no membership
// oracle); respond_to_cosign accepts/declines; withdraw_cosign revokes an
// accepted co-signature. cosign_invite_preview is the pre-accept, summary-only
// read for an invitee (never the narrative/affected/remedy PII).
export async function inviteCosigner(client, formId, email) {
  return expectWrite(await client.rpc("invite_cosigner", { p_form_id: formId, p_email: (email || "").trim() }), "Co-signer");
}

// An accept names the preview it was shown (reviewDigest,); a refusal
// (PT409 cosign_changed_since_preview) means the filer changed the grievance
// after that preview and nothing was co-signed. A digest exists only when the
// server's own preview issued one, so the server has the migration that
// compares it: an issued digest is always sent and never dropped on a retry
// (a PGRST202 then means a stale schema cache, not a missing function; gate
// stage 173, r1s2 and r2s2). With no digest (a server before 20261113122700)
// the accept goes as before.
export async function respondToCosign(client, formId, accept, signature = null, consent = false, reviewDigest = null) {
  return expectWrite(await client.rpc("respond_to_cosign", {
    p_form_id: formId,
    p_accept: accept,
    ...(accept ? signatureRpcArgs(signature) : { p_strokes: null }),
    p_consent: accept ? consent === true : false,
    ...(accept && typeof reviewDigest === "string" && reviewDigest ? { p_expected_digest: reviewDigest } : {}),
  }), "Co-signer");
}

// The refusal respond_to_cosign gives when the grievance changed after the
// co-signer's preview.
export function isCosignChangedSincePreview(error) {
  return typeof error?.details === "string" && error.details.trim() === "cosign_changed_since_preview";
}

export async function withdrawCosign(client, formId) {
  return expectWrite(await client.rpc("withdraw_cosign", { p_form_id: formId }), "Co-signer");
}

export async function cosignInvitePreview(client, formId) {
  return expectWrite(await client.rpc("cosign_invite_preview", { p_form_id: formId }), "Co-signer");
}

// Steward desk reads run only for steward-role accounts, from the steward
// view itself — a failure here renders an inline error card and never blanks
// the member app. Queries never select read_at (no presence tracking) or
// handled_by/created_by identities.
//
// UB-DESK-01: every desk list is a server-side keyset page from the steward
// list_* RPCs — the coordinator plane's list_coordinator_cases treatment —
// with search/filter/sort evaluated in SQL so a match can never hide past a
// client cap, and the TRUE filtered total riding each page so the view says
// "showing N of M" instead of presenting a slice as the chapter. The old
// flat fetches capped at 200 requests / 100 conversations / 600 messages /
// 20 broadcasts / 100 forms are gone, and the KPI tiles now come from
// get_steward_desk_kpis over the same RLS the pages read through — they were
// previously counted off the capped slices themselves.
const STEWARD_REQUEST_PAGE = 100;
const STEWARD_THREAD_PAGE = 50;
const STEWARD_FORM_PAGE = 50;
const STEWARD_BROADCAST_PAGE = 20;
const STEWARD_MESSAGE_PAGE = 50;
const STEWARD_MESSAGE_CAP = 200;
// Appointments panel pages (sol  F9): the desk blob carries page one
// of each list plus the TRUE windowed total; list_steward_appointments walks
// the rest. Both clamps mirror the SQL caps.
const STEWARD_APPT_UPCOMING_PAGE = 50;
const STEWARD_APPT_RECENT_PAGE = 20;

// A short page ends the walk; a full page's cursor is the keyset position of
// its last RAW rpc row (same contract as coordinatorCursor below).
function stewardPageCursor(rows, pageSize, pick) {
  if (rows.length < pageSize) return null;
  return pick(rows[rows.length - 1]);
}

// total_count rides every row of a page. An empty FIRST page is honestly a
// zero-match total; an empty later page keeps the caller's running total
// (that only happens when the previous page ended exactly on the boundary).
function stewardPageTotal(rows, cursor = null) {
  if (rows.length) return Number(rows[0].total_count) || 0;
  return cursor ? null : 0;
}

function shapeStewardRequestRows(rows, lessonById) {
  return rows.map((item) => ({
    id: item.id,
    memberName: item.member_name || "Member",
    memberInitials: item.member_initials || "M",
    lessonLabel: item.lesson_id ? lessonById.get(item.lesson_id) || item.lesson_id : "",
    // The requesting member, so the detail can offer that member's open case.
    userId: item.user_id ?? null,
    status: item.status,
    createdAt: item.created_at,
  }));
}

function shapeStewardThreadRows(rows) {
  return rows.map((item) => ({
    id: item.id,
    memberName: item.member_name || "Member",
    memberInitials: item.member_initials || "M",
    preview: item.last_body || "No messages yet",
    updatedAt: item.updated_at,
    awaitingReply: item.last_sender_kind === "member",
    messageCount: Number(item.message_count) || 0,
  }));
}

function shapeStewardBroadcastRows(rows, readCountById) {
  return rows.map((item) => ({
    id: item.id,
    title: item.title,
    body: item.body,
    publishedAt: item.published_at,
    locale: item.locale || "en",
    // list_steward_broadcasts returns the audience the row was published
    // against so the desk shows the boundary rather than assuming one.
    audience: item.audience_scope || null,
    chapterId: item.chapter_id || null,
    retracted: Boolean(item.retracted_at),
    readCount: readCountById.get(item.id) ?? null,
  }));
}

// Read counts for exactly the broadcasts on this page (sol F7): the original
// get_broadcast_read_counts() is pinned to the newest 20 rows, so a paged or
// searched broadcast beyond that silently lost its count. Additive — a failed
// read renders "not counted" (null), never zero.
async function stewardBroadcastReadCounts(client, rows) {
  if (!rows.length) return new Map();
  const result = await client.rpc("get_broadcast_read_counts_for", { p_broadcast_ids: rows.map((item) => item.id) });
  const counts = softData(result, "Broadcast read counts", []);
  return new Map(counts.map((item) => [item.broadcastId, item.readCount]));
}

export async function getBroadcastReadCounts(client) {
  const rows = requireData(await client.rpc("get_broadcast_read_counts"), "Broadcast read counts");
  return Array.isArray(rows) ? rows : [];
}

// Accepted co-signers and their display names, scoped to exactly the forms on
// this page — the old desk fetched a global 200-cap co-signer list that could
// starve a form deep in a busy chapter. Both lookups stay additive ([] on
// error) like the co-signer read always was.
async function shapeStewardFormRows(client, rows, read = (request) => request) {
  const sealedAnswers = await hydrateSealedFormAnswers(client, rows);
  const formIds = rows.map((item) => item.id);
  // Hydrate only IDs the existing RLS-backed, paged inbox already admitted.
  // This does not filter or replace that inbox when unit metadata is offline.
  const [scopes, cosignerResult] = formIds.length
    ? await Promise.all([
      read(client.from("member_forms").select("id,settings_scope").in("id", formIds)),
      read(client.from("member_form_cosigners").select("id,form_id,cosigner_user_id,status").eq("status", "accepted").in("form_id", formIds)),
    ])
    : [null, { data: [], error: null }];
  const scopeById = new Map((scopes?.data || []).map((row) => [row.id, row.settings_scope]));
  const cosignerRows = softData(cosignerResult, "Form co-signers", []);
  const cosignerIds = [...new Set(cosignerRows.map((row) => row.cosigner_user_id).filter(Boolean))];
  const profilesResult = cosignerIds.length
    ? await read(client.from("member_profiles").select("id,full_name").in("id", cosignerIds))
    : { data: [], error: null };
  const profiles = softData(profilesResult, "Co-signer names", []);
  const nameById = new Map(profiles.map((item) => [item.id, item.full_name]));
  const cosignersByForm = new Map();
  for (const row of cosignerRows) {
    if (!cosignersByForm.has(row.form_id)) cosignersByForm.set(row.form_id, []);
    cosignersByForm.get(row.form_id).push({ id: row.id, name: nameById.get(row.cosigner_user_id) || "A member" });
  }
  return rows.map((item) => ({
    id: item.id,
    userId: item.user_id,
    memberName: item.member_name || "Member",
    memberInitials: item.member_initials || "M",
    templateKey: item.template_key,
    templateVersion: item.template_version ?? 1,
    unitName: scopeById.get(item.id)?.unitName ?? null,
    status: item.status,
    ...sealedAnswers(item),
    submittedAt: item.submitted_at,
    cosigners: cosignersByForm.get(item.id) || [],
  }));
}

// Shared President-review index for every staff casework surface (SOL-
// 20260813-07). Attribution is a name AND a date: a row missing either is
// dropped rather than rendered as "Reviewed by President  · ", because half a
// sentence on a casework surface is worse than no line at all. A failed read
// yields an empty index, so the detail omits the line instead of claiming the
// case was never reviewed.
function vpReviewsByCase(result, label) {
  const rows = softFailed(result, label) || !Array.isArray(result?.data) ? [] : result.data;
  const byCase = new Map();
  for (const row of rows) {
    if (!row?.caseId || !row.reviewerName || !row.reviewedAt) continue;
    byCase.set(row.caseId, { reviewerName: row.reviewerName, reviewedAt: row.reviewedAt });
  }
  return byCase;
}

function stewardDeskKpis(result, scopedMembers, estimated) {
  const exact = typeof scopedMembers === "number";
  const membersCovered = exact ? scopedMembers
    : softFailed(estimated, "Member head count") ? null : estimated.count ?? null;
  const coverage = {
    membersCovered,
    ...(!exact && membersCovered !== null ? { membersCoveredIsEstimate: true } : {}),
  };
  const row = softFailed(result, "Desk KPIs") ? null : (result.data ?? [])[0] || {};
  return row ? {
    openRequests: Number(row.open_requests) || 0,
    ...coverage,
    awaitingReply: Number(row.awaiting_reply) || 0,
    broadcasts30d: Number(row.broadcasts_30d) || 0,
  } : { openRequests: null, ...coverage, awaitingReply: null, broadcasts30d: null, unavailable: true };
}

export async function loadStewardDesk(client, { overviewOnly = false, requestsOnly = false } = {}) {
  // One budget for all read waves: a slow optional section must not exhaust
  // the shell's 10s deadline or turn the other queues into an empty desk.
  const deadline = Date.now() + 6_000;
  const read = (request) => withSoftRpcDeadline(
    Promise.resolve(request).catch((error) => ({ data: null, error })),
    Math.max(0, deadline - Date.now()),
  );
  const readValue = async (request, fallback) => softData(await read(
    Promise.resolve(request).then((data) => ({ data, error: null })),
  ), "Desk details", fallback);
  // Caseload scope (UB-CASE-05) needs the caller's uid before the fan-out.
  // getSession reads the local session — no extra round-trip. Optional-chained
  // so auth-less stub clients degrade to an empty caseload instead of throwing.
  const session = await read(client.auth?.getSession?.());
  if (session?.error) throw new MemberApiError("Steward session", session.error);
  const uid = session?.data?.session?.user?.id ?? null;
  // The overview shows summary tiles and links, not the queues behind those
  // links. Keep their fan-out off its critical path. Opening a desk page
  // performs the complete load below, including all queue enrichments.
  if (overviewOnly) {
    const [kpis, scoped] = await Promise.all([
      read(withSoftRpcDeadline(client.rpc("get_steward_desk_kpis"), 4_000)),
      read(client.rpc("get_steward_chapter_member_count")),
    ]);
    const scopedMembers = softFailed(scoped, "Chapter member count") ? null : scoped.data;
    const estimated = typeof scopedMembers === "number" ? null
      : await read(client.from("member_profiles").select("id", { count: "estimated", head: true }));
    return { queue: [], threads: [], broadcasts: [], formsInbox: [], caseload: [],
      kpis: stewardDeskKpis(kpis, scopedMembers, estimated) };
  }
  // Member requests still needs the caseload for its linked-case action.
  // Forms, conversations, broadcasts and workload only serve other pages.
  const otherQueue = (request) => requestsOnly ? { data: [], error: null } : request();
  const formsRequest = read(otherQueue(() => client.rpc("list_steward_forms", { p_status: "all", p_search: null, p_sort: "oldest", p_limit: STEWARD_FORM_PAGE })));
  // Start dependent reads as soon as the form page arrives, independently
  // of workload/KPI/case reads. The same deadline bounds each additive lookup:
  // missing co-signers or names must never discard an authorized form page.
  const formsInboxRequest = formsRequest.then((result) =>
    shapeStewardFormRows(client, result.error ? [] : result.data ?? [], read));
  // The same rule for every enrichment: each starts when its own source read
  // settles, so a slow optional read (workload intelligence) can never spend
  // the shared budget the caseload names and timelines, broadcast read counts
  // or legal holds still need.
  const threadsRequest = read(otherQueue(() => client.rpc("list_steward_conversations", { p_filter: "all", p_search: null, p_limit: STEWARD_THREAD_PAGE })));
  const broadcastsRequest = read(otherQueue(() => client.rpc("list_steward_broadcasts", { p_filter: "all", p_search: null, p_limit: STEWARD_BROADCAST_PAGE })));
  const caseSelect = "id,user_id,chapter_id,reference,title,deadline,case_type,articles,step,status,updated_at,assigned_at,coordinator_name";
  // Assignee-scoped caseload (UB-CASE-05): RLS widens steward reads to
  // exactly steward_user_id = auth.uid(); the .eq is the client half of the
  // same predicate, and .neq(user_id) keeps a self-assigned steward's OWN
  // member case out of the desk — it stays a member-surface case. Two
  // windows so each cap's server order matches the queue's display order
  //: active cases by soonest dated deadline then recency,
  // resolved cases by recency alone — a cap can only ever shed the least
  // urgent active tail or the oldest resolved tail.
  // The id is each window's final tiebreak, the order the alternate case
  // desk's later pages (src/lib/caseDeskApi.js) continue on.
  // Each window fetches ONE row past its cap: an overflow row PROVES
  // truncation ( — hitting the cap exactly must not claim more
  // cases exist), and the extra row is sliced off before rendering.
  const activeCasesRequest = read(uid
    ? client.from("member_cases").select(caseSelect).eq("steward_user_id", uid).neq("user_id", uid).eq("status", "active").order("deadline", { ascending: true, nullsFirst: false }).order("updated_at", { ascending: false }).order("id", { ascending: true }).limit(201)
    : Promise.resolve({ data: [], error: null }));
  const resolvedCasesRequest = read(uid
    ? client.from("member_cases").select(caseSelect).eq("steward_user_id", uid).neq("user_id", uid).eq("status", "resolved").order("updated_at", { ascending: false }).order("id", { ascending: true }).limit(51)
    : Promise.resolve({ data: [], error: null }));
  const caseWindowsRequest = Promise.all([activeCasesRequest, resolvedCasesRequest]).then(([active, resolved]) => {
    const unavailable = !uid
      || softFailed(active, "Steward caseload (active)")
      || softFailed(resolved, "Steward caseload (resolved)");
    const activeAll = unavailable ? [] : active.data ?? [];
    const resolvedAll = unavailable ? [] : resolved.data ?? [];
    return { unavailable, activeAll, resolvedAll, rows: [...activeAll.slice(0, 200), ...resolvedAll.slice(0, 50)] };
  });
  // Resolve names only for the members the caseload references — a bounded
  // primary-key lookup. The four paged queues carry member_name/initials in
  // their own rows now (the RPC join runs under the same profile RLS), so the
  // desk no longer fans out a second lookup for them.
  const caseProfilesRequest = caseWindowsRequest.then(({ rows }) => {
    const referencedIds = [...new Set(rows.map((item) => item.user_id))];
    return referencedIds.length
      ? read(client.from("member_profiles").select("id,full_name,initials,member_since").in("id", referencedIds))
      : { data: [], error: null };
  });
  // Case timelines for the detail view through the same invoker RPC the
  // coordinator desk uses: per-case newest-kept windows plus
  // the TRUE per-case total, so one busy case can never starve another's
  // history and an empty array genuinely means "never updated". RLS (the
  // new assignee policies) still decides row visibility. Batched at 40 ids
  // (40 × 20 = 800 rows) because PostgREST's max_rows = 1000 would silently
  // drop later cases' rows AND totals from one oversized call.
  const caseUpdatesRequest = caseWindowsRequest.then(({ rows }) => {
    const caseIds = rows.map((item) => item.id);
    return Promise.all(
      Array.from({ length: Math.ceil(caseIds.length / 40) }, (_, i) =>
        read(client.rpc("list_case_latest_updates", { p_case_ids: caseIds.slice(i * 40, i * 40 + 40), p_per_case: 20 }))),
    );
  });
  // Read counts for exactly the loaded broadcast page (sol F7).
  const readCountRequest = broadcastsRequest.then((result) =>
    readValue(stewardBroadcastReadCounts(client, softData(result, "Broadcasts", [])), new Map()));
  const legalHoldsRequest = threadsRequest.then((result) =>
    readValue(loadConversationLegalHolds(client, softData(result, "Member conversations", []).map((row) => row.id)), null));
  const requests = await Promise.all([
    client.rpc("list_steward_requests", { p_status: "all", p_search: null, p_sort: "newest", p_limit: STEWARD_REQUEST_PAGE }),
    threadsRequest,
    broadcastsRequest,
    withSoftRpcDeadline(client.rpc("get_steward_desk_kpis"), 4_000),
    client.from("member_rights_lessons").select("id,label"),
    // A separate visible-profile estimate in case the Steward scope read fails.
    client.from("member_profiles").select("id", { count: "estimated", head: true }),
    formsRequest,
    // Exact count across this caller’s Steward-visible scope.
    client.rpc("get_steward_chapter_member_count"),
    // All template versions (English columns only — steward surface is EN
    // until PR7) so the review dialog renders each form under the EXACT
    // schema version it was filed with. Additive — [] on error.
    otherQueue(() => fetchAllFormTemplates(client, "key,version,label_en,field_schema")),
    // Additive aggregate plane: a rollout/read error degrades this panel only,
    // never the load-bearing request, conversation, form, or case queues.
    otherQueue(() => client.rpc("get_steward_workload_intelligence", { p_weeks: 12 })),
    // President review attribution for the caseload dialog (SOL-20260813-07).
    // The RPC has always authorized stewards; only the President's own plane
    // read it. Additive — an error leaves every case's `review` null and the
    // dialog omits the line.
    client.rpc("list_vp_case_reviews"),
  ].map(read));
  // Refused authorization remains fatal. Transient per-queue errors are
  // explicit unavailable states, never fabricated empty lists or counts.
  for (const result of [requests[0], requests[1], requests[2], requests[6]]) {
    if (["42501", "28000", "28P01", "PGRST301", "PGRST302", "PGRST303"].includes(result.error?.code)) {
      throw new MemberApiError("Steward desk", result.error);
    }
  }
  const requestsUnavailable = softFailed(requests[0], "Steward requests");
  const threadsUnavailable = softFailed(requests[1], "Member conversations");
  const broadcastsUnavailable = softFailed(requests[2], "Broadcasts");
  const formsUnavailable = softFailed(requests[6], "Forms inbox");
  const requestRowsRaw = requestsUnavailable ? [] : requests[0].data ?? [];
  const threadRowsRaw = threadsUnavailable ? [] : requests[1].data ?? [];
  const broadcastRowsRaw = broadcastsUnavailable ? [] : requests[2].data ?? [];
  // Tiles never count off the first page (UB-DESK-01), but a failed KPI read, or
  // one slower than 4 s, no longer holds or fails the queues: the tiles read "—"
  // (BUG-UG-PAGES-FAIL-HARD-ON-MISSING-OR-SLOW-FUNCTION-20261003).
  const lessons = softData(requests[4], "Rights lessons", []);
  const formRowsRaw = formsUnavailable ? [] : requests[6].data ?? [];
  const scopedMembers = softFailed(requests[7], "Chapter member count") ? null : requests[7].data;
  const formTemplateVersions = softData(requests[8], "Form template registry", []);
  // Unavailable is rendered as an explicit notice, never as an empty caseload
  // — "no cases assigned" must not be the face of a failed read, and a
  // missing session (uid null: the scope predicate cannot even be stated) is
  // unavailable too, not a claim of zero assignments.
  const { unavailable: caseloadUnavailable, activeAll, resolvedAll } = await caseWindowsRequest;
  // The 201st/51st row proves overflow; it never renders. The disclosure
  // carries the REAL loaded counts, so "exactly 200 active" without overflow
  // stays an honest full list, not a false truncation claim.
  const activeCaseRows = activeAll.slice(0, 200);
  const resolvedCaseRows = resolvedAll.slice(0, 50);
  const caseRows = [...activeCaseRows, ...resolvedCaseRows];
  const caseloadTruncated = activeAll.length > 200 || resolvedAll.length > 50;
  const caseloadWindow = { active: activeCaseRows.length, resolved: resolvedCaseRows.length };
  const intelligenceResult = requests[9];
  const workloadIntelligence = softFailed(intelligenceResult, "Workload intelligence")
    || !intelligenceResult.data || Array.isArray(intelligenceResult.data)
    ? { available: false, reason: "read_error" }
    : intelligenceResult.data;
  const reviewByCase = vpReviewsByCase(requests[10], "President case reviews");

  const [profilesResult, caseUpdatesResult, readCountById] = await Promise.all([caseProfilesRequest, caseUpdatesRequest, readCountRequest]);
  // A failed name lookup is its own state, never the generic "Member" a
  // profile without a name gets.
  const caseNamesUnavailable = softFailed(profilesResult, "Member roster");
  const profiles = caseNamesUnavailable ? [] : profilesResult.data ?? [];
  // A failed timeline read must not masquerade as "no updates yet" — it
  // surfaces to the dialog as its own honest copy.
  const caseUpdatesUnavailable = caseUpdatesResult.some((batch) => softFailed(batch, "Caseload updates"));
  const caseUpdates = caseUpdatesUnavailable ? [] : caseUpdatesResult.flatMap((batch) => batch.data ?? []);

  const profileById = new Map(profiles.map((item) => [item.id, item]));
  const lessonById = new Map(lessons.map((item) => [item.id, item.label]));
  // The RPC returns each case's kept window chronologically plus its true
  // total; only the case owner can author updates, so attribution is the
  // member's, not the caller's.
  const updatesByCase = new Map();
  const updateTotalsByCase = new Map();
  for (const row of caseUpdates) {
    if (!updatesByCase.has(row.case_id)) updatesByCase.set(row.case_id, []);
    updatesByCase.get(row.case_id).push({ id: row.id, body: row.body, createdAt: row.created_at, mentions: row.mentions || [] });
    updateTotalsByCase.set(row.case_id, Number(row.total_count) || 0);
  }
  // Queue order: active before resolved; active by soonest deadline with
  // undated cases after dated ones; ties and resolved cases by recency.
  const caseloadRows = [...caseRows].sort((a, b) => {
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    if (a.status === "active" && a.deadline !== b.deadline) {
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      return a.deadline < b.deadline ? -1 : 1;
    }
    return new Date(b.updated_at) - new Date(a.updated_at);
  });
  // Each page's forms resolve their co-signers in the shared shaping helper,
  // scoped to exactly the page's form ids.
  const [formsInbox, legalHolds] = await Promise.all([
    formsInboxRequest,
    legalHoldsRequest,
  ]);

  return {
    caseload: caseloadRows.map((item) => ({
      id: item.id,
      subjectUserId: item.user_id,
      memberName: caseNamesUnavailable ? "Name unavailable" : profileById.get(item.user_id)?.full_name || "Member",
      memberInitials: caseNamesUnavailable ? "?" : profileById.get(item.user_id)?.initials || "M",
      memberNameUnavailable: caseNamesUnavailable,
      reference: item.reference,
      title: item.title,
      caseType: item.case_type,
      articles: item.articles,
      step: item.step,
      status: item.status,
      deadline: item.deadline,
      updatedAt: item.updated_at,
      assignedAt: item.assigned_at,
      coordinatorName: item.coordinator_name,
      // No assigneeId/assigneeName on purpose: this window is exactly
      // steward_user_id = auth.uid(), so every row has the same assignee (the
      // reader) and coordinator_name is the case's COORDINATOR, not its
      // assignee. The shared case list hides its assignee facet rather than
      // offer a filter that would name the wrong person.
      chapterId: item.chapter_id || "",
      updates: updatesByCase.get(item.id) || [],
      updatesTotal: updateTotalsByCase.get(item.id) ?? 0,
      // Raw timestamp: the steward dialog formats its own dates (shortDate),
      // unlike the coordinator loader which ships labels.
      review: reviewByCase.get(item.id) || null,
    })),
    caseloadUnavailable,
    caseloadTruncated,
    caseloadWindow,
    caseUpdatesUnavailable,
    workloadIntelligence,
    requestsUnavailable,
    threadsUnavailable,
    broadcastsUnavailable,
    formsUnavailable,
    queue: shapeStewardRequestRows(requestRowsRaw, lessonById),
    queueCursor: stewardPageCursor(requestRowsRaw, STEWARD_REQUEST_PAGE, (last) => ({ createdAt: last.created_at, id: last.id })),
    queueTotal: requestsUnavailable ? null : stewardPageTotal(requestRowsRaw),
    threads: shapeStewardThreadRows(threadRowsRaw).map((row) => ({ ...row, legalHold: legalHolds?.get(row.id)?.held ?? null })),
    threadsCursor: stewardPageCursor(threadRowsRaw, STEWARD_THREAD_PAGE, (last) => ({ updatedAt: last.updated_at, id: last.id })),
    threadsTotal: threadsUnavailable ? null : stewardPageTotal(threadRowsRaw),
    broadcasts: shapeStewardBroadcastRows(broadcastRowsRaw, readCountById),
    broadcastsCursor: stewardPageCursor(broadcastRowsRaw, STEWARD_BROADCAST_PAGE, (last) => ({ publishedAt: last.published_at, id: last.id })),
    broadcastsTotal: broadcastsUnavailable ? null : stewardPageTotal(broadcastRowsRaw),
    formsInbox,
    formsCursor: stewardPageCursor(formRowsRaw, STEWARD_FORM_PAGE, (last) => ({ submittedAt: last.submitted_at, id: last.id })),
    formsTotal: formsUnavailable ? null : stewardPageTotal(formRowsRaw),
    formTemplateVersions,
    kpis: stewardDeskKpis(requests[3], scopedMembers, requests[5]),
  };
}

// Server-filtered pages for the desk's four queues — the keyset walk plus the
// search/filter/sort UB-DESK-01 requires, every clamp mirroring its SQL cap
// so a full page can never look short and strand the rest of the chapter
// behind an unreachable boundary (the list_coordinator_cases lesson). Each
// pager returns { rows, nextCursor, total }: total is the TRUE filtered count
// (null only on an empty later page, where the caller already knows it).
export async function loadStewardRequests(client, { status = "all", search = "", sort = "newest", cursor = null, limit = STEWARD_REQUEST_PAGE } = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || STEWARD_REQUEST_PAGE, 1), STEWARD_REQUEST_PAGE);
  const [pageResult, lessonsResult] = await Promise.all([
    client.rpc("list_steward_requests", {
      p_status: status,
      p_search: search.trim() || null,
      p_sort: sort,
      p_after_created: cursor?.createdAt ?? null,
      p_after_id: cursor?.id ?? null,
      p_limit: pageSize,
    }),
    // Lesson labels resolve per page — the lessons table is a tiny bounded
    // catalogue, and a standalone pager must not depend on desk state.
    client.from("member_rights_lessons").select("id,label"),
  ]);
  const rows = requireData(pageResult, "Steward requests");
  const lessons = softData(lessonsResult, "Rights lessons", []);
  const lessonById = new Map(lessons.map((item) => [item.id, item.label]));
  return {
    rows: shapeStewardRequestRows(rows, lessonById),
    nextCursor: stewardPageCursor(rows, pageSize, (last) => ({ createdAt: last.created_at, id: last.id })),
    total: stewardPageTotal(rows, cursor),
  };
}

export async function loadStewardThreads(client, { filter = "all", search = "", cursor = null, limit = STEWARD_THREAD_PAGE } = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || STEWARD_THREAD_PAGE, 1), STEWARD_THREAD_PAGE);
  const result = await client.rpc("list_steward_conversations", {
    p_filter: filter,
    p_search: search.trim() || null,
    p_after_updated: cursor?.updatedAt ?? null,
    p_after_id: cursor?.id ?? null,
    p_limit: pageSize,
  });
  const rows = requireData(result, "Member conversations");
  // Preservation-order marker for exactly this page's rows. Additive: a
  // failed or missing status read leaves the flag null ("unknown"), which the
  // desk renders as no chip rather than as "not held".
  const holds = await loadConversationLegalHolds(client, rows.map((item) => item.id));
  return {
    rows: shapeStewardThreadRows(rows).map((row) => ({ ...row, legalHold: holds ? holds.get(row.id)?.held === true : null })),
    nextCursor: stewardPageCursor(rows, pageSize, (last) => ({ updatedAt: last.updated_at, id: last.id })),
    total: stewardPageTotal(rows, cursor),
  };
}

// ---------------------------------------------------------------------------
// Conversation legal holds (preservation orders).
// ---------------------------------------------------------------------------
// The database has enforced holds since SEC-UG-MESSAGE-BODY-LIFECYCLE:
// an unreleased public.member_message_legal_holds row refuses every redaction
// path, including retention. These are the first client callers
// (REQ-UG-DORMANT-62-ADMIN-MFA-RESET-LEGAL-HOLD-20260917). Authorization
// stays server-side: the status RPC discloses only what the caller may see
// (held yes/no for staff who can see the conversation; reason and date for an
// organization admin) and the two writers re-check the admin grant, the MFA
// assurance boundary and the tenant scope themselves.

function shapeLegalHoldRow(row) {
  return {
    conversationId: row.conversation_id,
    held: row.held === true,
    reasonCode: row.reason_code || null,
    placedAt: row.placed_at || null,
    canManage: row.can_manage === true,
  };
}

// Map of conversationId -> status for up to 100 ids, or null when the read
// failed (so a caller can tell "unknown" from "not held"). An empty id list
// makes no request.
export async function loadConversationLegalHolds(client, conversationIds) {
  const ids = [...new Set((conversationIds || []).filter(Boolean))].slice(0, 100);
  if (ids.length === 0) return new Map();
  let result;
  try {
    result = await client.rpc("get_member_conversation_legal_holds", { p_conversation_ids: ids });
  } catch (error) {
    result = { error };
  }
  if (!result || softFailed(result, "Legal hold status")) return null;
  return new Map((result.data || []).map((row) => [row.conversation_id, shapeLegalHoldRow(row)]));
}

// One conversation's status. Throws on a failed read (the dialog shows an
// explicit "could not load" line rather than a silent absence of the marker)
// and resolves null when the conversation is not visible to the caller.
export async function loadConversationLegalHold(client, conversationId) {
  const result = await client.rpc("get_member_conversation_legal_holds", { p_conversation_ids: [conversationId] });
  const rows = requireData(result, "Legal hold status");
  const row = rows.find((item) => item.conversation_id === conversationId);
  return row ? shapeLegalHoldRow(row) : null;
}

export async function placeConversationLegalHold(client, conversationId, reasonCode) {
  if (!LEGAL_HOLD_REASONS.includes(reasonCode)) throw new Error("invalid-legal-hold-reason");
  const data = await expectWrite(
    await client.rpc("place_member_message_legal_hold", { p_conversation_id: conversationId, p_reason_code: reasonCode }),
    "Place legal hold",
  );
  return { held: data?.held === true, reasonCode: data?.reasonCode || reasonCode };
}

export async function releaseConversationLegalHold(client, conversationId) {
  const data = await expectWrite(
    await client.rpc("release_member_message_legal_hold", { p_conversation_id: conversationId }),
    "Release legal hold",
  );
  // released:false is the RPC's honest "there was nothing to release" — an
  // already-released hold, or one in another tenant — not a failure.
  return { released: data?.released === true };
}

// The organization admin's list of active preservation orders.
export async function listLegalHoldConversations(client, { search = "", cursor = 0 } = {}) {
  const offset = Number(cursor) || 0;
  const rows = requireData(await client.rpc("list_legal_hold_conversations", { p_search: search, p_offset: offset }), "Legal hold conversations");
  return {
    rows: rows.slice(0, 25).map((row) => ({ id: row.conversation_id, title: row.conversation_title, memberName: row.member_name })),
    nextCursor: rows.length > 25 ? offset + 25 : null,
  };
}

export async function listOrganizationLegalHolds(client) {
  const rows = requireData(await client.rpc("list_member_message_legal_holds"), "Preservation orders");
  return rows.map((row) => ({
    conversationId: row.conversation_id,
    conversationTitle: row.conversation_title || "",
    memberName: row.member_name || "",
    memberInitials: row.member_initials || "—",
    reasonCode: row.reason_code,
    placedAt: row.placed_at,
  }));
}

export async function loadStewardForms(client, { status = "all", search = "", sort = "oldest", cursor = null, limit = STEWARD_FORM_PAGE } = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || STEWARD_FORM_PAGE, 1), STEWARD_FORM_PAGE);
  const result = await client.rpc("list_steward_forms", {
    p_status: status,
    p_search: search.trim() || null,
    p_sort: sort,
    p_after_submitted: cursor?.submittedAt ?? null,
    p_after_id: cursor?.id ?? null,
    p_limit: pageSize,
  });
  const rows = requireData(result, "Forms inbox");
  return {
    rows: await shapeStewardFormRows(client, rows),
    nextCursor: stewardPageCursor(rows, pageSize, (last) => ({ submittedAt: last.submitted_at, id: last.id })),
    total: stewardPageTotal(rows, cursor),
  };
}

export async function loadStewardBroadcasts(client, { filter = "all", search = "", cursor = null, limit = STEWARD_BROADCAST_PAGE } = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || STEWARD_BROADCAST_PAGE, 1), STEWARD_BROADCAST_PAGE);
  const pageResult = await client.rpc("list_steward_broadcasts", {
    p_filter: filter,
    p_search: search.trim() || null,
    p_after_published: cursor?.publishedAt ?? null,
    p_after_id: cursor?.id ?? null,
    p_limit: pageSize,
  });
  const rows = requireData(pageResult, "Broadcasts");
  // Counts follow the page's own ids (sol F7) — the newest-20 aggregate RPC
  // silently dropped counts for anything paged or searched past it.
  const readCountById = await stewardBroadcastReadCounts(client, rows);
  return {
    rows: shapeStewardBroadcastRows(rows, readCountById),
    nextCursor: stewardPageCursor(rows, pageSize, (last) => ({ publishedAt: last.published_at, id: last.id })),
    total: stewardPageTotal(rows, cursor),
  };
}

// One thread's messages: the newest window first, then "load earlier" walks
// backward. Rows arrive newest-first from the RPC; the dialog renders
// chronologically, so a reversed copy goes out. total is the thread's true
// size so a window is always disclosed as one.
export async function loadStewardThreadMessages(client, conversationId, { cursor = null, limit = STEWARD_MESSAGE_PAGE } = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || STEWARD_MESSAGE_PAGE, 1), STEWARD_MESSAGE_CAP);
  const result = await client.rpc("list_steward_thread_messages", {
    p_conversation_id: conversationId,
    p_before_created: cursor?.createdAt ?? null,
    p_before_id: cursor?.id ?? null,
    p_limit: pageSize,
  });
  const rows = requireData(result, "Thread messages");
  const total = rows.length ? Number(rows[0].total_count) || 0 : (cursor ? null : 0);
  // A first window that already covers the thread's true size never
  // advertises an earlier page (the exact-boundary phantom, sol F5); the
  // dialog applies the same trim while accumulating windows.
  const covered = !cursor && total != null && rows.length >= total;
  return {
    // The dialog reuses the member-side bubble renderer, which reads the
    // wire's snake_case fields — keep them.
    messages: [...rows].reverse().map((item) => ({
      id: item.id,
      sender_kind: item.sender_kind,
      sender_name: item.sender_name,
      body: item.body,
      created_at: item.created_at,
      reactions: item.reactions || [],
      saved: Boolean(item.saved),
      reminder: item.reminder || null,
      resource: item.resource || null,
    })),
    earlierCursor: covered ? null : stewardPageCursor(rows, pageSize, (last) => ({ createdAt: last.created_at, id: last.id })),
    total,
  };
}

// Coordinator plane (PR4a, completeness pass REQ-UNION-BASE-COORDINATOR-DATA-
// COMPLETENESS-20260804): case pages and per-case histories come from the two
// invoker RPCs so the server's focus predicates and per-case update totals are
// the single definition — the flat capped fetches (and their truncation
// disclosures) are gone. Read-only; names resolve through the same bounded
// primary-key lookup the steward desk uses.
const COORDINATOR_CASE_PAGE = 200;
const COORDINATOR_UPDATES_PER_CASE = 20;
const COORDINATOR_RECORD_PAGE = 500;

async function fetchAllCoordinatorRecords(client, table, columns, caseIds, orderColumn, tieColumn = "id") {
  const rows = [];
  for (let from = 0; ; from += COORDINATOR_RECORD_PAGE) {
    const { data, error } = await client.from(table).select(columns).in("case_id", caseIds)
      .order(orderColumn, { ascending: false }).order(tieColumn, { ascending: false })
      .range(from, from + COORDINATOR_RECORD_PAGE - 1);
    if (error) return { data: null, error };
    rows.push(...(data || []));
    if (!data || data.length < COORDINATOR_RECORD_PAGE) return { data: rows, error: null };
  }
}

// A full page implies more may exist; the cursor is the keyset position of the
// last row in (deadline nulls-last, id) order. A short page ends the walk.
function coordinatorCursor(caseRows, pageSize) {
  if (caseRows.length < pageSize) return null;
  const last = caseRows[caseRows.length - 1];
  return { deadline: last.deadline || null, id: last.id };
}

// Shared shaping for every coordinator case page: per-case recent histories
// with true totals via list_case_latest_updates, member names via the bounded
// primary-key profile lookup.
async function shapeCoordinatorCases(client, caseRows, lang) {
  const caseIds = caseRows.map((item) => item.id);
  const referencedIds = [...new Set(caseRows.map((item) => item.user_id))];
  const chapterIds = [...new Set(caseRows.map((item) => item.chapter_id).filter(Boolean))];
  const [updatesResult, profilesResult, contactsResult, outcomesResult, filesResult, reviewsResult, chaptersResult] = await Promise.all([
    caseIds.length
      ? client.rpc("list_case_latest_updates", { p_case_ids: caseIds, p_per_case: COORDINATOR_UPDATES_PER_CASE })
      : Promise.resolve({ data: [], error: null }),
    referencedIds.length
      ? client.from("member_profiles").select("id,full_name,initials").in("id", referencedIds)
      : Promise.resolve({ data: [], error: null }),
    caseIds.length
      ? fetchAllCoordinatorRecords(client, "member_case_contacts", "id,case_id,contact_type,direction,summary,contacted_at,created_at", caseIds, "contacted_at")
      : Promise.resolve({ data: [], error: null }),
    caseIds.length
      ? fetchAllCoordinatorRecords(client, "member_case_outcomes", "case_id,outcome,summary,recorded_at,updated_at", caseIds, "updated_at", "case_id")
      : Promise.resolve({ data: [], error: null }),
    caseIds.length
      ? fetchAllCaseFiles((from, to) => client.from("member_case_files").select(MEMBER_CASE_FILE_COLUMNS)
        .in("case_id", caseIds).order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to))
      : Promise.resolve({ data: [], error: null }),
    // SOL-20260813-07: list_vp_case_reviews already authorizes steward,
    // coordinator, advisor, admin and vp, but only the President's own plane
    // and the admin trail ever read it — so the desk where the casework
    // actually happens could not say a case had been reviewed. Additive: a
    // failed read leaves every case's `review` null and the detail simply
    // omits the line, which asserts nothing either way.
    caseIds.length
      ? client.rpc("list_vp_case_reviews")
      : Promise.resolve({ data: [], error: null }),
    // Chapter display names resolve the chapter facet to something a member
    // can read; ids are the fallback. Additive — degrades to [].
    chapterIds.length
      ? client.from("chapters").select("id,name").in("id", chapterIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const updateRows = requireData(updatesResult, "Case updates");
  const profiles = requireData(profilesResult, "Member roster");
  const contacts = requireData(contactsResult, "Case contacts");
  const outcomes = requireData(outcomesResult, "Case outcomes");
  const caseFiles = requireData(filesResult, "Case files").map(memberCaseFileFromRow);
  const profileById = new Map(profiles.map((item) => [item.id, item]));
  const reviewByCase = vpReviewsByCase(reviewsResult, "President case reviews");
  const chapterNameById = new Map((chaptersResult.data || []).map((item) => [item.id, item.name]));

  // Rows arrive chronological per case; total_count is the case's real history
  // size, so updates.length < totalUpdates means "recent slice", not "all".
  const updatesByCase = new Map();
  for (const update of updateRows) {
    if (!updatesByCase.has(update.case_id)) updatesByCase.set(update.case_id, { rows: [], total: 0 });
    const bucket = updatesByCase.get(update.case_id);
    bucket.total = Number(update.total_count) || bucket.rows.length + 1;
    bucket.rows.push({
      id: update.id,
      body: update.body,
      createdAt: dateLabel(update.created_at, lang),
      createdAtValue: update.created_at,
      mentions: update.mentions || [],
    });
  }

  return caseRows.map((item) => ({
    id: item.id,
    subjectUserId: item.user_id,
    reference: item.reference,
    title: item.title,
    caseType: item.case_type,
    articles: item.articles,
    step: item.step,
    status: item.status,
    deadline: item.deadline || "",
    deadlineLabel: item.deadline ? deadlineLabel(item.deadline, lang) : "",
    overdue: isOverdue(item),
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    stewardUserId: item.steward_user_id || "",
    stewardName: item.steward_name || "",
    coordinatorUserId: item.coordinator_user_id || "",
    coordinatorName: item.coordinator_name || "",
    // Who is handling the case, as one identity pair: the shared case list's
    // ?assignee= facet keys on the id (two people can share a display name)
    // and shows the server-stamped name. Steward first, the case's
    // coordinator only when no steward is assigned.
    assigneeId: item.steward_user_id || item.coordinator_user_id || "",
    assigneeName: item.steward_name || item.coordinator_name || "",
    chapterId: item.chapter_id || "",
    chapterName: chapterNameById.get(item.chapter_id) || "",
    assignedAt: item.assigned_at || "",
    memberName: profileById.get(item.user_id)?.full_name || "Member",
    memberInitials: profileById.get(item.user_id)?.initials || "M",
    updates: updatesByCase.get(item.id)?.rows || [],
    totalUpdates: updatesByCase.get(item.id)?.total || 0,
    contacts: contacts.filter((row) => row.case_id === item.id).map((row) => ({
      id: row.id,
      type: row.contact_type,
      direction: row.direction,
      summary: row.summary,
      contactedAt: dateLabel(row.contacted_at, lang),
      contactedAtValue: row.contacted_at,
    })),
    outcome: (() => {
      const row = outcomes.find((entry) => entry.case_id === item.id);
      return row ? {
        kind: row.outcome,
        summary: row.summary,
        recordedAt: dateLabel(row.recorded_at, lang),
        recordedAtValue: row.recorded_at,
        updatedAtValue: row.updated_at,
      } : null;
    })(),
    files: caseFiles.filter((file) => file.caseId === item.id),
    // Localized here like every other coordinator label; null means "no
    // attribution to show", never "not reviewed".
    review: (() => {
      const row = reviewByCase.get(item.id);
      return row ? { ...row, reviewedLabel: dateLabel(row.reviewedAt, lang) } : null;
    })(),
  }));
}

export async function coordinatorUpdateCase(client, caseId, fields) {
  const args = {
    p_case_id: caseId, p_step: null, p_reason: fields.reason,
  };
  if (fields.status !== undefined) args.p_status = fields.status;
  if (fields.deadline !== undefined) args.p_deadline = fields.deadline || null;
  if (fields.articles !== undefined) args.p_articles = fields.articles;
  return expectWrite(await client.rpc("coordinator_update_case", args), "Update coordinator case");
}

export async function coordinatorAddCaseNote(client, caseId, body) {
  return expectWrite(await client.rpc("coordinator_add_case_note", { p_case_id: caseId, p_body: body }), "Add coordinator case note");
}

export async function coordinatorLogCaseContact(client, caseId, fields) {
  return expectWrite(await client.rpc("coordinator_log_case_contact", {
    p_case_id: caseId, p_contact_type: fields.type, p_direction: fields.direction,
    p_summary: fields.summary, p_contacted_at: fields.contactedAt,
  }), "Log coordinator case contact");
}

export async function coordinatorRecordCaseOutcome(client, caseId, fields) {
  return expectWrite(await client.rpc("coordinator_record_case_outcome", {
    p_case_id: caseId, p_outcome: fields.outcome, p_summary: fields.summary,
  }), "Record coordinator case outcome");
}

export async function loadCoordinatorDesk(client, lang = "en", { kpisOnly = false } = {}) {
  const loadKpis = () => client.rpc("get_coordinator_kpis");
  if (kpisOnly) {
    return { kpis: requireData(await loadKpis(), "Coordinator KPIs"), cases: [], nextCursor: null };
  }
  // The case list can start its enrichment as soon as its own rows land.
  // The independent aggregate may still be running.
  const casePage = Promise.resolve(client.rpc("list_coordinator_cases", { p_focus: "all", p_limit: COORDINATOR_CASE_PAGE }))
    .then(async (result) => {
      const rows = requireData(result, "Case queue");
      const cases = await shapeCoordinatorCases(client, rows, lang);
      return { cases, nextCursor: coordinatorCursor(rows, COORDINATOR_CASE_PAGE) };
    });
  const [page, kpisResult] = await Promise.all([casePage, loadKpis()]);
  const kpis = softData(kpisResult, "Coordinator KPIs", {});
  return { kpis, ...page };
}

// Server-filtered pages for KPI drilldowns and the queue's keyset walk. The
// focus predicates live in list_coordinator_cases beside the KPI aggregate,
// so a tile's count and its drilldown page can no longer drift apart.
export async function loadCoordinatorCases(client, { focus = "all", cursor = null, limit = COORDINATOR_CASE_PAGE } = {}, lang = "en") {
  // Mirror the SQL clamp: asking for more than the server will serve would
  // make a full page look short, drop the cursor, and strand the rest of the
  // chapter behind an unreachable boundary.
  const pageSize = Math.min(Math.max(Number(limit) || COORDINATOR_CASE_PAGE, 1), COORDINATOR_CASE_PAGE);
  const casesResult = await client.rpc("list_coordinator_cases", {
    p_focus: focus,
    p_after_deadline: cursor?.deadline ?? null,
    p_after_id: cursor?.id ?? null,
    p_limit: pageSize,
  });
  const caseRows = requireData(casesResult, "Case queue");
  const cases = await shapeCoordinatorCases(client, caseRows, lang);
  return { cases, nextCursor: coordinatorCursor(caseRows, pageSize) };
}

export async function loadCaseAssignmentCandidates(client, caseId) {
  return requireData(
    await client.rpc("list_member_case_assignment_candidates", { p_case_id: caseId }),
    "Case assignment candidates",
  );
}

// The organization-scoped sibling of the read above. A case macro is
// organization property and has no case id to scope a candidate read with, so
// its assignee pickers read the organization's own staff list — the same
// read the leadership and advisor planes already use, gated on the same staff
// roles. The server still decides at apply time whether the chosen person is
// in the case's scope (assign_member_case raises 23514 if not); this read only
// makes the choice a choice
// (UX-UG-CASE-MACRO-EDITOR-RAW-IDS-AND-FREE-TEXT-STEP-20260917).
export async function loadStaffCandidates(client) {
  return requireData(await client.rpc("get_staff_roster"), "Staff roster");
}

// The nil uuid is assign_member_case's explicit "leave this role unchanged"
// intent (BUG-UG-CASE-BULK-ASSIGN-CLEARS-UNTOUCHED-ROLE-20260920): the
// bulk Assign panel passes it for every role the coordinator did not name,
// so an untouched role is carried over instead of cleared. null still means
// "clear" — the single-case editor's blank option is a deliberate choice.
export const ASSIGN_LEAVE_UNCHANGED = "00000000-0000-0000-0000-000000000000";

export async function assignMemberCase(client, caseId, { stewardId = null, coordinatorId = null } = {}) {
  // A user id writes the role, null clears it, ASSIGN_LEAVE_UNCHANGED leaves
  // the current holder in place. The sentinel is a uuid string, so the
  // `|| null` coercion leaves it untouched.
  requireData(await client.rpc("assign_member_case", {
    p_case_id: caseId,
    p_steward: stewardId || null,
    p_coordinator: coordinatorId || null,
  }), "Case assignment");
}

// Demo-hat mirror of the list_coordinator_cases focus predicates: due is seven
// days inclusive of today (0..6). The arbitration focus is not offered:
// Union Ground has no arbitration (owner decision, 2026-10-13). Deadlines
// parse at local noon like the view's deadlineValue so the date-only column
// never shifts a day across timezones.
export function filterCoordinatorFocus(cases, focus = "all") {
  const active = (cases || []).filter((item) => item.status === "active");
  if (focus === "due") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return active.filter((item) => {
      if (!item.deadline) return false;
      const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(item.deadline) ? `${item.deadline}T12:00:00` : item.deadline);
      if (!Number.isFinite(parsed)) return false;
      const day = new Date(parsed);
      day.setHours(0, 0, 0, 0);
      const days = Math.round((day.getTime() - today.getTime()) / 86400000);
      return days >= 0 && days <= 6;
    });
  }
  return active;
}

// The President's and the Advisor's Leadership team is the open chapter's,
// like the overview beside it: p_chapter_only narrows the roster an
// organization-wide grant would otherwise answer for the whole organization
// . The website deploys
// before the migration that adds the argument reaches the database, so a
// database without it answers PGRST202 (no function with that argument) and
// the desk asks once more without it, getting the organization list it shows
// today. Any other answer is handled as before.
async function loadChapterRoster(client) {
  const result = await client.rpc("get_staff_roster", { p_chapter_only: true });
  if (result?.error?.code === "PGRST202") return client.rpc("get_staff_roster");
  return result;
}

// VP / president plane (PR4a): chapter-level aggregates plus the staff
// roster. The overview is the plane, so it is required; the roster card
// degrades to empty. The Admin desk and the case macro editor keep the
// organization's full roster.
export async function loadVpOverview(client) {
  const requests = await Promise.all([
    client.rpc("get_vp_overview"),
    loadChapterRoster(client),
    client.rpc("list_vp_case_reviews"),
  ]);
  const overview = requireData(requests[0], "Leadership overview");
  const roster = softData(requests[1], "Staff roster", []);
  const reviews = softData(requests[2], "Leadership reviews", []);
  return { overview, roster, reviews };
}

export async function markVpCaseReviewed(client, caseId) {
  return expectWrite(await client.rpc("mark_vp_case_reviewed", { p_case_id: caseId }), "Leadership review");
}

// Advisor plane (PR4b): chapter-level analytics only — no advisor write
// surface is designed. The overview is the plane (required); the collective
// workload stats and staff roster degrade independently. The roster is the
// open chapter's, the chapter Chapter health counts .
export async function loadAdvisorDesk(client, { overviewOnly = false } = {}) {
  const overviewRequest = client.rpc("get_advisor_overview");
  if (overviewOnly) return { overview: requireData(await overviewRequest, "Advisor overview") };
  const [overviewResult, workloadResult, rosterResult] = await Promise.all([
    overviewRequest,
    client.rpc("get_workload_stats"),
    loadChapterRoster(client),
  ]);
  const overview = requireData(overviewResult, "Advisor overview");
  const workload = softData(workloadResult, "Collective workload stats", null);
  const roster = softData(rosterResult, "Staff roster", []);
  return { overview, workload, roster };
}

// Admin plane (PR4b): role management + event management + audit. Roster and
// events are the plane (required); the audit card and the MFA status card
// each degrade to a null sentinel so the view can say "unavailable" instead
// of falsely claiming the compliance trail is empty or that nobody has MFA on.
const COMPASS_GOVERNANCE_ROLES = ["member", "steward", "coordinator", "advisor", "admin", "vp"];

function compassGovernanceFromRow(value, lang) {
  if (!value
      || typeof value.enabled !== "boolean"
      || value.gateway !== "union-ground-mesh"
      || !/^union-ground\/compass-mesh:v[0-9]+$/.test(String(value.model))
      || value.requiredZeroDataRetention !== true
      || value.requiredDisallowPromptTraining !== true
      || typeof value.attestationReady !== "boolean"
      || !Array.isArray(value.roleLimits)
      || !Array.isArray(value.attestations)) return null;

  const limits = new Map();
  for (const row of value.roleLimits) {
    const limit = Number(row?.hourlyLimit);
    if (!COMPASS_GOVERNANCE_ROLES.includes(row?.role)
        || limits.has(row.role)
        || !Number.isSafeInteger(limit)
        || limit < 0
        || limit > 200) return null;
    limits.set(row.role, limit);
  }
  if (limits.size !== COMPASS_GOVERNANCE_ROLES.length) return null;

  const shapeAttestation = (row) => {
    if (!row || typeof row.id !== "string" || !["verified", "revoked"].includes(row.status)) return null;
    return {
      id: row.id,
      status: row.status,
      gateway: row.gateway || value.gateway,
      model: row.model || value.model,
      evidenceRef: String(row.evidenceRef || "").slice(0, 500),
      expiresAt: row.expiresAt || null,
      expiresLabel: row.expiresAt ? dateLabel(row.expiresAt, lang) : "",
      attestedBy: row.attestedBy || null,
      actorName: row.actorName || "",
      createdAt: row.createdAt || null,
      createdLabel: row.createdAt ? dateLabel(row.createdAt, lang) : "",
    };
  };
  const attestations = value.attestations.map(shapeAttestation);
  if (attestations.some((row) => row === null)) return null;
  const latestAttestation = value.latestAttestation === null ? null : shapeAttestation(value.latestAttestation);
  if (value.latestAttestation !== null && latestAttestation === null) return null;
  if (value.attestationReady && latestAttestation?.status !== "verified") return null;

  return {
    enabled: value.enabled,
    gateway: value.gateway,
    model: value.model,
    requiredZeroDataRetention: true,
    requiredDisallowPromptTraining: true,
    attestationReady: value.attestationReady,
    latestAttestation,
    roleLimits: COMPASS_GOVERNANCE_ROLES.map((role) => ({ role, hourlyLimit: limits.get(role) })),
    attestations,
  };
}

// Exactly the classes private.retention_data_class_config declares. The server
// added the last three in 20261003050000 and this list was not widened with
// them, so get_organization_retention_engine answered ten policies to a client
// that rejected any payload without exactly these seven — every admin past
// that migration, SAMPLE and Production included, got a null engine and the
// panel's unknown-state notice
// (BUG-UG-RETENTION-ENGINE-STATE-UNKNOWN-FOR-ADMIN-20261009).
// tests/mi1-retention-engine-client.test.js derives the expected set from the
// migration text, so the next added class fails that test instead of blanking
// the card.
const RETENTION_DATA_CLASSES = new Set([
  "organization_page_views",
  "organization_engagement_events",
  "integration_job_history",
  "public_event_rsvps",
  "deleted_chapter_tasks",
  "member_message_bodies",
  "casework_record_versions",
  "member_notifications",
  "ai_assistant_conversations",
  "ai_usage_counters",
]);

function retentionEngineFromRow(value) {
  if (!value || typeof value.organizationId !== "string"
      || typeof value.schedulerConfigured !== "boolean"
      || !Array.isArray(value.policies)
      || !Array.isArray(value.runs)) return null;

  const policies = value.policies.map((row) => {
    const retentionDays = Number(row?.retentionDays);
    const minimumDays = Number(row?.minimumDays);
    const maximumDays = Number(row?.maximumDays);
    const defaultDays = Number(row?.defaultDays);
    if (!RETENTION_DATA_CLASSES.has(row?.dataClass)
        || !Number.isSafeInteger(retentionDays)
        || !Number.isSafeInteger(minimumDays)
        || !Number.isSafeInteger(maximumDays)
        || !Number.isSafeInteger(defaultDays)
        || retentionDays < minimumDays
        || retentionDays > maximumDays
        || defaultDays < minimumDays
        || defaultDays > maximumDays
        || typeof row.executionEnabled !== "boolean"
        || typeof row.configured !== "boolean") return null;
    return {
      dataClass: row.dataClass,
      retentionDays,
      minimumDays,
      maximumDays,
      defaultDays,
      executionEnabled: row.executionEnabled,
      configured: row.configured,
      updatedAt: row.updatedAt || null,
    };
  });
  if (policies.length !== RETENTION_DATA_CLASSES.size
      || policies.some((row) => row === null)
      || new Set(policies.map((row) => row.dataClass)).size !== RETENTION_DATA_CLASSES.size) return null;

  const runs = value.runs.map((row) => {
    const retentionDays = Number(row?.retentionDays);
    const eligibleCount = Number(row?.eligibleCount);
    const deletedCount = Number(row?.deletedCount);
    const remainingCount = Number(row?.remainingCount);
    if (typeof row?.id !== "string"
        || !RETENTION_DATA_CLASSES.has(row.dataClass)
        || !["dry_run", "manual", "scheduled"].includes(row.mode)
        || !["previewed", "authorized", "running", "completed", "failed", "expired"].includes(row.status)
        || ![retentionDays, eligibleCount, deletedCount, remainingCount]
          .every((count) => Number.isSafeInteger(count) && count >= 0)) return null;
    return {
      id: row.id,
      dataClass: row.dataClass,
      retentionDays,
      mode: row.mode,
      status: row.status,
      eligibleCount,
      deletedCount,
      remainingCount,
      authorizationExpiresAt: row.authorizationExpiresAt || null,
      createdAt: row.createdAt || null,
      completedAt: row.completedAt || null,
      failureCode: row.failureCode || null,
      confirmationPhrase: row.confirmationPhrase || null,
    };
  });
  if (runs.some((row) => row === null)) return null;
  return {
    organizationId: value.organizationId,
    schedulerConfigured: value.schedulerConfigured,
    policies,
    runs,
  };
}

// Why retentionEngineFromRow produced nothing, from the read that fed it. The
// card withholds every deletion control for all four, which is the correct
// fail-closed behavior; the difference is what the admin should do next, and
// "unknown" told them nothing. PostgREST answers an absent function with
// PGRST202 (the migration is not applied on this stack) and the retention
// RPC's own guard raises 42501 for a caller who is not an MFA-verified
// organization admin: neither is a failed read. A payload that arrived and was
// rejected is a client/database version gap, which is the case the October 8
// bot swarm actually hit.
function retentionEngineUnavailableReason(result) {
  if (result.error) {
    const code = String(result.error.code ?? "");
    if (code === "PGRST202") return "missingConfiguration";
    if (code === "42501") return "notPermitted";
    return "readFailed";
  }
  if (result.data === null || result.data === undefined) return "missingConfiguration";
  return "unrecognizedPayload";
}

// One admin desk read, settled. A rejected promise (a dropped connection, a
// thrown fetch) becomes the same { data: null, error } envelope a refused RPC
// resolves with, so one panel's failure cannot reject every other panel.
function settledDeskRead(request) {
  return Promise.resolve(request).then(
    (result) => result ?? { data: null, error: { message: "empty response" } },
    (error) => ({ data: null, error: error && typeof error === "object" ? error : { message: "request failed" } }),
  );
}

// PostgREST answers a missing, expired or invalid JWT with these codes (HTTP
// 401). That is a lost session, not one unavailable panel.
const ADMIN_DESK_SESSION_ERROR_CODES = new Set(["PGRST301", "PGRST302", "PGRST303"]);

// Pending member requests for the admin attention panel. A refusal (42501:
// no second factor, or nothing this caller may decide) means there is nothing
// for this person to decide here; any other failure, or a malformed page, is
// unreadable (null), never "nothing waiting".
function adminDeskMemberRequests(result) {
  if (String(result?.error?.code ?? "") === "42501") return { items: [], hasMore: false };
  if (softFailed(result, "Member requests")) return null;
  const items = result.data?.items;
  if (!Array.isArray(items) || !items.every((item) => item && typeof item === "object")) return null;
  return { items, hasMore: result.data.hasMore === true };
}

function adminDeskSessionFailure(error) {
  return Boolean(error) && (ADMIN_DESK_SESSION_ERROR_CODES.has(String(error.code ?? "")) || error.status === 401);
}

// Roster and events used to go through requireData, so either failure threw
// and took every unrelated panel down with it. They now degrade per panel like
// the rest, but to null (never []) when unread or malformed: a lost read must
// not render as zero staff or no events. One malformed row makes the whole
// list unavailable; dropping it would understate counts or turn an unreadable
// list into a valid empty one.
function adminDeskRows(result, label) {
  if (softFailed(result, label)) return null;
  const rows = result.data;
  if (!Array.isArray(rows) || !rows.every((row) => row && typeof row === "object" && !Array.isArray(row))) return null;
  return rows;
}

// get_compass_ai_governance refuses (403) anyone who is not an MFA-verified
// Compass platform operator, which is every organization admin. Ask the
// member-callable get_compass_platform_ai first: its canManage is the same
// private.compass_platform_operator() predicate, so non-operators never send
// the refused read and get the card's operator-required note
// (BUG-UG-ADMIN-PAGES-FIRE-REFUSED-COMPASS-GOVERNANCE-READ-20261006).
// The server guard is unchanged; a failed probe passes its error through so a
// lost session still fails the desk.
async function loadCompassGovernanceForOperator(client, observe) {
  // Observe each RPC in its first settlement reaction, before the surrounding
  // async helper adds promise jobs that can trail the last sibling read.
  const read = async (invoke) => {
    try {
      const result = await invoke();
      observe(result);
      return result;
    } catch (error) {
      observe({ data: null, error });
      throw error;
    }
  };
  const platform = await read(() => client.rpc("get_compass_platform_ai"));
  if (platform?.error || platform?.status === 401) return platform;
  if (platform?.data?.canManage !== true) return { data: null, error: null };
  return read(() => client.rpc("get_compass_ai_governance"));
}

function adminEventRows(rows, lang) {
  return rows.map((item) => ({
    ...item,
    ...eventModelLabels(item, lang),
  }));
}

// The admin event list on its own, re-read after an event write so the saved
// event shows without waiting for every other admin panel
// (REQ-UG-STALE-OR-CONTRADICTORY-STATE-AFTER-SAVE-20261030). Same RPC
// and row checks as the desk read; anything unreadable throws.
export async function loadAdminEvents(client, lang = "en") {
  const rows = adminDeskRows(await settledDeskRead(client.rpc("get_admin_events")), "Event manager");
  if (rows === null) throw new MemberApiError("Event manager", { message: "events unavailable" });
  return adminEventRows(rows, lang);
}

export async function loadAdminDesk(client, lang = "en") {
  // Read events before the wide desk burst. On SAMPLE this read takes about
  // 100 ms alone but seconds alongside the roster, directory and policy reads.
  // Reuse its settled result below: the desk keeps the same data and failures.
  const eventsRead = await settledDeskRead(client.rpc("get_admin_events"));
  let readsPending = true;
  let compassSessionFailure = null;
  // The optional deadline bounds the wait, not the original request. Keep
  // observing session refusals until the sibling desk reads have settled.
  const observeCompass = (result) => {
    if (readsPending && (result?.status === 401 || adminDeskSessionFailure(result?.error))) {
      compassSessionFailure = result;
    }
  };
  const reads = await Promise.all([
    client.rpc("get_staff_roster"),
    eventsRead,
    client.rpc("get_admin_audit"),
    client.rpc("get_admin_mfa_status"),
    // Additive (UB-IDN-03): degrades to null so a pre-migration deploy renders
    // the existing MFA card without the policy control, rather than failing the
    // whole admin plane on a function that does not exist yet.
    client.rpc("get_staff_mfa_policy"),
    client.rpc("get_admin_governance_requests"),
    client.rpc("list_vp_case_reviews"),
    // Security control, so an additive failure is an explicit null rather
    // than an enabled-looking default or a reason to take down unrelated
    // admin work. One four-second budget covers both the operator probe and
    // governance read, leaving room inside the shell's ten-second deadline.
    withSoftRpcDeadline(loadCompassGovernanceForOperator(client, observeCompass), 4_000),
    // The listing's own ceiling; roster imports leave more live invitations.
    client.rpc("get_member_invitations", { p_limit: 100 }),
    client.rpc("get_admin_member_directory", {
      p_query: "", p_after_name: null, p_after_id: null, p_limit: 25,
    }),
    client.rpc("get_admin_org_structure"),
    client.rpc("get_admin_organization_configuration"),
    client.rpc("list_failed_login_operations_inbox", { p_status: null, p_limit: 50 }),
    client.rpc("get_organization_retention_engine"),
    loadChapterLifecycleAdmin(client).then((data) => ({ data, error: null })).catch((error) => ({ data: null, error })),
    // The launch checklist's welcome-checklist step: whether the organization
    // has written any onboarding steps (RLS: members of the organization read
    // them). A failed read is unknown, never "none".
    Promise.resolve().then(() => client.from("organization_onboarding_steps").select("id", { count: "exact", head: true }))
      .then(({ count, error }) => ({ data: error ? null : count, error })),
    // BUG-UG-INVITATION-SUGGESTIONS-HIDDEN-FROM-ADMIN-DESK-20261102:
    // the pending requests this admin may decide, for Needs your attention.
    // The server returns only requests the caller may decide.
    client.rpc("list_member_requests", { p_status: "pending", p_limit: 50 }),
    // BUG-UG-CHAPTER-ADMIN-CHECKLIST-TWO-STEP-COULD-NOT-CHECK-20261103:
    // the launch checklist's own two-step state. get_staff_mfa_policy refuses
    // an admin without an organization-wide grant, so a chapter-scoped admin
    // reads their own enrolment from this self-scoped, role-free call instead.
    client.rpc("get_staff_mfa_standing"),
  ].map(settledDeskRead)).finally(() => { readsPending = false; });
  const [
    rosterResult,
    eventsResult,
    auditResult,
    mfaResult,
    mfaPolicyResult,
    governanceResult,
    leadershipReviewsResult,
    compassGovernanceResult,
    invitationsResult,
    memberDirectoryResult,
    organizationResult,
    configurationResult,
    failedLoginResult,
    retentionResult,
    chapterLifecycleResult,
    onboardingStepsResult,
    memberRequestsResult,
    mfaStandingResult,
  ] = reads;
  // Per-panel degradation is only for a caller the server still treats as a
  // signed-in admin. A rejected session, both admin-gated reads refused
  // (42501: the admin role is gone), or nothing readable at all keeps the
  // whole-desk failure and its Try again, rather than a desk of empty panels.
  const sessionFailure = reads.find((result) => result.status === 401 || adminDeskSessionFailure(result.error)) ?? compassSessionFailure;
  if (sessionFailure) throw new MemberApiError("Admin desk", sessionFailure.error ?? { message: "Session unavailable" });
  if ([rosterResult, eventsResult].every((result) => String(result.error?.code ?? "") === "42501")
      || reads.every((result) => result.error)) {
    throw new MemberApiError("Staff roster", rosterResult.error ?? eventsResult.error);
  }
  const roster = adminDeskRows(rosterResult, "Staff roster");
  const events = adminDeskRows(eventsResult, "Event manager");
  // null (not []) on failure: an empty trail and an unreadable trail are
  // different facts on a compliance surface, so the fallback differs from the
  // empty-success value on purpose.
  const audit = softFailed(auditResult, "Admin audit") ? null : auditResult.data ?? [];
  const mfa = softData(mfaResult, "Admin MFA status", null);
  // Same null-vs-value distinction as the audit trail: "we could not read the policy" must
  // not render as a toggle sitting confidently in the Off position, which is an
  // invitation to press it and an assertion the client cannot make.
  const mfaPolicy = softData(mfaPolicyResult, "Staff MFA policy", null);
  const governanceData = softFailed(governanceResult, "Governance requests") ? null : governanceResult.data ?? [];
  const governance = governanceData === null ? null : Array.isArray(governanceData) ? governanceData : [];
  const leadershipReviews = softFailed(leadershipReviewsResult, "Leadership reviews") || !Array.isArray(leadershipReviewsResult.data)
    ? null
    : leadershipReviewsResult.data;
  const compassGovernanceRaw = softData(compassGovernanceResult, "Guide AI governance", null);
  const compassAiGovernance = compassGovernanceFromRow(compassGovernanceRaw, lang);
  // Invitation email is operator-visible PII. A failed reader must never
  // collapse to an empty list and tell the admin there is nothing pending.
  const invitationsData = softFailed(invitationsResult, "Member invitations")
    ? null : invitationsResult.data ?? { chapter: null, items: [] };
  // These two readers are additive during DB-first rollout. Explicit nulls
  // tell AdminView "unavailable"; [] would falsely assert that a chapter has
  // no members or that the organization has no chapters.
  const directoryData = softData(memberDirectoryResult, "Member directory", null);
  const organizationData = softData(organizationResult, "Organization structure", null);
  const configurationData = softData(configurationResult, "Organization configuration", null);
  const failedLoginData = softData(failedLoginResult, "Failed sign-in inbox", null);
  const retentionData = softData(retentionResult, "Retention engine", null);
  const retentionEngine = retentionEngineFromRow(retentionData);
  const chapterLifecycleData = softData(chapterLifecycleResult, "Chapter lifecycle", null);
  const onboardingStepCount = onboardingStepsResult.error || !Number.isInteger(onboardingStepsResult.data) ? null : onboardingStepsResult.data;
  const mfaStanding = softData(mfaStandingResult, "Staff two-step standing", null);
  return {
    onboardingStepCount,
    // null when the standing read failed: the checklist then falls back to the
    // policy read and shows "Could not check" only when both failed.
    callerTwoStepEnrolled: typeof mfaStanding?.enrolled === "boolean" ? mfaStanding.enrolled : null,
    memberRequests: adminDeskMemberRequests(memberRequestsResult),
    roster,
    events: events === null ? null : adminEventRows(events, lang),
    // Admin activity and President reviews carry the year (APP-ADMIN-02, -10).
    audit: audit === null ? null : audit.map((item) => ({ ...item, createdLabel: formatDateWithYear(item.createdAt, lang) })),
    mfa: mfa === null ? null : {
      enrolledMembers: Number(mfa.enrolledMembers) || 0,
      staff: (mfa.staff ?? []).map((row) => ({
        ...row,
        verifiedLabel: row.verifiedAt ? dateLabel(row.verifiedAt, lang) : "",
      })),
    },
    mfaPolicy: mfaPolicy === null ? null : {
      requireStaffMfa: Boolean(mfaPolicy.requireStaffMfa),
      requireMemberMfa: Boolean(mfaPolicy.requireMemberMfa),
      staffTotal: Number(mfaPolicy.staffTotal) || 0,
      staffEnrolled: Number(mfaPolicy.staffEnrolled) || 0,
      callerEnrolled: Boolean(mfaPolicy.callerEnrolled),
    },
    governance: governance === null ? null : governance.map((item) => ({
      ...item,
      createdLabel: dateLabel(item.createdAt, lang),
    })),
    leadershipReviews: leadershipReviews === null ? null : leadershipReviews.map((item) => ({
      ...item,
      reviewedLabel: formatDateWithYear(item.reviewedAt, lang),
    })),
    compassAiGovernance,
    invitations: invitationsData === null ? null : {
      chapter: invitationsData.chapter ?? null,
      // The chapters this admin may invite into. null (not []) before the
      // database returns the list: the desk then keeps the locked chapter.
      chapters: Array.isArray(invitationsData.chapters)
        ? invitationsData.chapters.filter((chapter) => chapter?.id && chapter?.name)
        : null,
      items: (invitationsData.items ?? []).map((item) => ({
        ...item,
        createdLabel: invitationMomentLabel(item.createdAt, lang),
        ...invitationLifecycleLabels(item, lang),
      })),
    },
    memberDirectory: directoryData && Array.isArray(directoryData.items)
      ? { items: directoryData.items, nextCursor: directoryData.nextCursor ?? null, context: directoryContext(directoryData.context) }
      : null,
    organization: organizationData && Array.isArray(organizationData.chapters)
      ? {
          scope: organizationData.scope === "organization" ? "organization" : "chapter",
          chapterId: organizationData.chapterId ?? null,
          canCreateChapter: organizationData.canCreateChapter === true,
          chapters: organizationData.chapters,
        }
      : null,
    chapterLifecycle: chapterLifecycleData,
    // A limit that acts only beside a held switch leaves the list with it .
    configuration: configurationData && Array.isArray(configurationData.settings)
      ? { ...configurationData, settings: withoutRowsBesideHeldSwitches(configurationData.settings) }
      : null,
    failedLoginInbox: failedLoginData && Array.isArray(failedLoginData.items)
      ? {
          ...failedLoginData,
          items: failedLoginData.items.map((item) => ({
            ...item,
            occurredLabel: dateLabel(item.occurredAt, lang),
            reviewedLabel: item.reviewedAt ? dateLabel(item.reviewedAt, lang) : "",
          })),
        }
      : null,
    retentionEngine,
    // One null engine, four different facts. Without this the card could only
    // say the state was unknown, so an admin could not tell a stack that never
    // got the CR-104 migration from a read that failed, and the October 8 bot
    // run could not say which it had hit
    // (BUG-UG-RETENTION-ENGINE-STATE-UNKNOWN-FOR-ADMIN-20261009).
    retentionEngineUnavailable: retentionEngine === null
      ? retentionEngineUnavailableReason(retentionResult)
      : null,
  };
}

export async function updateOrganizationSetting(client, key, value) {
  return expectWrite(await client.rpc("update_organization_setting", {
    p_key: key,
    p_value: value,
  }), "Update organization setting");
}

export async function updateOrganizationLabel(client, key, value) {
  return expectWrite(await client.rpc("update_organization_label", {
    p_key: key,
    p_value: value,
  }), "Update organization label");
}

// REQ-UG-WORKLOAD-CATEGORY-LABELS-VISIBILITY-ORDER-20261103: all
// eight categories in the new order, each shown or hidden.
export async function loadOrganizationWorkloadCategories(client) {
  return expectWrite(await client.rpc("get_organization_workload_categories"), "Load workload categories");
}

export async function loadOrganizationWorkloadConfiguration(client) {
  return expectWrite(await client.rpc("get_organization_workload_configuration"), "Load workload configuration");
}

export async function saveOrganizationWorkloadConfiguration(client, definition, version, organizationId) {
  return expectWrite(await client.rpc("save_organization_workload_configuration", {
    p_definition: definition, p_expected_version: version,
    p_expected_organization_id: organizationId,
  }), "Save workload configuration");
}

export async function saveOrganizationWorkloadCategories(client, categories) {
  return expectWrite(await client.rpc("save_organization_workload_categories", {
    p_categories: categories.map((item) => ({ key: item.key, visible: item.visible === true })),
  }), "Save workload categories");
}

export async function loadFailedLoginInbox(client, status = null) {
  return expectWrite(await client.rpc("list_failed_login_operations_inbox", {
    p_status: status,
    p_limit: 50,
  }), "Load failed sign-in inbox");
}

export async function dispositionFailedLoginAttempt(client, attemptId, status, note) {
  return expectWrite(await client.rpc("disposition_failed_login_attempt", {
    p_attempt_id: attemptId,
    p_status: status,
    p_note: note,
  }), "Review failed sign-in attempt");
}

export async function loadAdministrativeEvidence(client, page = 0) {
  return requireData(await client.rpc("get_administrative_evidence_desk", { p_page: page }), "Administrative evidence");
}

export async function addFieldNoteEvidence(client, fields) {
  return expectWrite(await client.rpc("add_field_note_evidence", {
    p_source_title: fields.sourceTitle.trim(),
    p_source_type: fields.sourceType,
    p_provenance: fields.provenance.trim(),
    p_issue_key: fields.issueKey.trim(),
    p_body: fields.body.trim(),
    p_annotation: fields.annotation?.trim() || "",
  }), "Add Field Notes evidence");
}

export async function draftFieldNotePacket(client, issueKey, title) {
  return expectWrite(await client.rpc("draft_field_note_packet", {
    p_issue_key: issueKey.trim(),
    p_title: title.trim(),
  }), "Draft evidence packet");
}

export async function executeAdministrativeObjectAction(client, fields) {
  return expectWrite(await client.rpc("execute_administrative_object_action", {
    p_target_kind: fields.targetKind,
    p_target_id: fields.targetId,
    p_action_key: fields.actionKey,
    p_note: fields.note?.trim() || "",
  }), "Execute object action");
}

export async function saveOrganizationRetentionPolicy(client, fields) {
  return expectWrite(await client.rpc("upsert_organization_retention_policy", {
    p_data_class: fields.dataClass,
    p_retention_days: fields.retentionDays,
    p_execution_enabled: fields.executionEnabled === true,
    p_confirmation: fields.confirmation || null,
  }), "Save retention policy");
}

export async function previewOrganizationRetentionRun(client, dataClass) {
  return expectWrite(await client.rpc("preview_organization_retention_run", {
    p_data_class: dataClass,
  }), "Preview retention run");
}

export async function authorizeOrganizationRetentionRun(client, runId, confirmation) {
  return expectWrite(await client.rpc("authorize_organization_retention_run", {
    p_run_id: runId,
    p_confirmation: confirmation,
  }), "Authorize retention run");
}

export async function executeOrganizationRetentionRun(client, runId) {
  return expectWrite(await client.rpc("execute_organization_retention_run", {
    p_run_id: runId,
  }), "Execute retention run");
}

export async function submitWeeklyQuestion(client, body, options) {
  return expectWrite(await client.rpc("submit_weekly_poll_question", {
    p_body: body,
    p_options: options,
  }), "Submit weekly question");
}

export async function boostWeeklyQuestion(client, questionId) {
  return expectWrite(await client.rpc("boost_weekly_question", { p_question_id: questionId }), "Boost weekly question");
}

export async function promoteWeeklyQuestion(client, questionId) {
  return expectWrite(await client.rpc("promote_weekly_question", { p_question_id: questionId }), "Promote weekly question");
}

export async function closeAdminGovernanceRequest(client, requestId, status, response) {
  return expectWrite(await client.rpc("close_admin_governance_request", {
    p_request_id: requestId,
    p_status: status,
    p_response: response,
  }), "Close governance request");
}

// Admin template registry. Reads use the same whole-registry pager as the
// member surfaces, but expose only the column-scoped authenticated grant —
// never updated_by. Every mutation goes through the role-gated definer RPCs;
// there is intentionally no direct client DML path for form_templates.
export async function loadAdminFormTemplates(client) {
  return expectWrite(
    await fetchAllFormTemplates(
      client,
      "key,version,label_en,label_es,blurb_en,blurb_es,icon,points,active,sort,field_schema,created_at,updated_at,organization_id,is_platform_seed",
      true,
    ),
    "Form templates",
  );
}

export async function upsertFormTemplate(client, fields) {
  return expectWrite(await client.rpc("upsert_form_template", {
    p_key: fields.key.trim(),
    p_label_en: fields.labelEn.trim(),
    p_label_es: fields.labelEs.trim(),
    p_blurb_en: fields.blurbEn.trim(),
    p_blurb_es: fields.blurbEs.trim(),
    p_icon: fields.icon.trim(),
    // The RPC still takes a points argument, but the safe-recognition
    // migration pins form_templates.points to 0: filing a form never earns.
    p_points: 0,
    p_sort: fields.sort,
    p_active: fields.active,
    p_field_schema: fields.fieldSchema,
  }), "Save form template");
}

export async function deactivateFormTemplate(client, key) {
  return expectWrite(
    await client.rpc("deactivate_form_template", { p_key: key.trim() }),
    "Deactivate form template",
  );
}

export async function reactivateFormTemplate(client, key) {
  return expectWrite(
    await client.rpc("reactivate_form_template", { p_key: key.trim() }),
    "Reactivate form template",
  );
}

// --- Steward appointments (REQ-UG-STEWARD-APPOINTMENTS-20260801) ---
// Every write is a definer RPC; the client never computes availability, only
// renders the UTC instants the server returns.

export const CHAPTER_APPOINTMENT_PAGE = 50;

function chapterAppointmentRow(item) {
  return {
    id: item.id,
    memberName: item.member_name ?? item.memberName ?? "Member",
    appointmentType: item.appointment_type ?? item.appointmentType,
    durationMinutes: item.duration_minutes ?? item.durationMinutes,
    startsAt: item.starts_at ?? item.startsAt,
    endsAt: item.ends_at ?? item.endsAt,
    status: item.status,
    stewardId: item.steward_id ?? item.stewardId,
    stewardName: item.steward_name ?? item.stewardName ?? "Committee member",
  };
}

export async function loadChapterAppointments(
  client,
  { cursor = null, limit = CHAPTER_APPOINTMENT_PAGE } = {},
) {
  const pageSize = Math.min(
    Math.max(Number(limit) || CHAPTER_APPOINTMENT_PAGE, 1),
    CHAPTER_APPOINTMENT_PAGE,
  );
  const result = await client.rpc("list_chapter_appointments", {
    p_after_starts: cursor?.startsAt ?? null,
    p_after_id: cursor?.id ?? null,
    p_limit: pageSize,
  });
  const rows = requireData(result, "Chapter appointments");
  const last = rows.at(-1);
  return {
    rows: rows.map(chapterAppointmentRow),
    nextCursor: rows.length === pageSize
      ? { startsAt: last.starts_at, id: last.id }
      : null,
    total: rows.length ? Number(rows[0].total_count) || 0 : (cursor ? null : 0),
  };
}

export async function loadChapterAppointmentCandidates(client, appointmentId) {
  const rows = requireData(
    await client.rpc("list_chapter_appointment_reassignment_candidates", {
      p_appointment_id: appointmentId,
    }),
    "Appointment candidates",
  );
  return rows.map((item) => ({ id: item.steward_id, name: item.steward_name }));
}

export async function reassignChapterAppointment(client, appointmentId, stewardId) {
  const row = await expectWrite(
    await client.rpc("reassign_chapter_appointment", {
      p_appointment_id: appointmentId,
      p_steward_id: stewardId,
    }),
    "Reassign appointment",
  );
  return chapterAppointmentRow(row);
}

export async function getBookableStewards(client) {
  return expectWrite(await client.rpc("get_bookable_stewards"), "Stewards");
}

// public.get_member_chapter_stewards() — the Find-my-steward roster. It is a
// sibling projection over the SAME private chapter-scoping helper the
// appointment roster uses, widened past the appointment-accepting subset so a
// member can still find a steward who takes no appointments (see
// The RPC returns
// null for every channel a steward has not published, and the in-app
// conversation is the only channel that is always offered.
export async function getMemberChapterStewards(client) {
  return normalizeChapterStewards(await expectWrite(await client.rpc("get_member_chapter_stewards"), "Chapter stewards"));
}

// public.get_member_steward_message_available(): whether anyone could
// read the caller's Chapter steward message, the send path's own rule. A
// steward whose role is paused does not count. null when unknown (a failed
// call, or a deployment before the RPC), which leaves the app as it was.
export async function getMemberStewardMessageAvailable(client) {
  try {
    const { data, error } = await client.rpc("get_member_steward_message_available");
    return !error && typeof data === "boolean" ? data : null;
  } catch {
    return null;
  }
}

// One shape for the live RPC, the demo fixture and the boot snapshot, so the
// card never has to ask which one it is rendering. An unknown channel value is
// dropped rather than rendered: a half-written preference must not become a
// contact affordance.
export function normalizeChapterStewards(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list
    .filter((row) => row && typeof row === "object" && row.id)
    .map((row) => ({
      id: row.id,
      name: typeof row.name === "string" && row.name.trim() ? row.name : null,
      roleLabel: typeof row.roleLabel === "string" ? row.roleLabel : "steward",
      chapterId: row.chapterId ?? null,
      chapterLabel: typeof row.chapterLabel === "string" && row.chapterLabel.trim() ? row.chapterLabel : null,
      acceptsAppointments: row.acceptsAppointments === true,
      contact: {
        conversation: row.contact?.conversation !== false,
        email: typeof row.contact?.email === "string" && row.contact.email.trim() ? row.contact.email.trim() : null,
        phone: typeof row.contact?.phone === "string" && row.contact.phone.trim() ? row.contact.phone.trim() : null,
      },
    }));
}

// A steward reads and writes their OWN contact visibility. The RPC never takes
// a steward id, so no caller can publish another steward's channels.
export async function getMyStewardContactVisibility(client) {
  const row = await expectWrite(await client.rpc("get_my_steward_contact_visibility"), "Contact visibility");
  return {
    shareEmail: row?.shareEmail === true,
    sharePhone: row?.sharePhone === true,
    contactEmail: row?.contactEmail ?? null,
    contactPhone: row?.contactPhone ?? null,
  };
}

export async function setMyStewardContactVisibility(client, { shareEmail, sharePhone, contactEmail, contactPhone }) {
  const row = await expectWrite(await client.rpc("set_my_steward_contact_visibility", {
    p_share_email: Boolean(shareEmail),
    p_share_phone: Boolean(sharePhone),
    p_contact_email: contactEmail ?? null,
    p_contact_phone: contactPhone ?? null,
  }), "Contact visibility");
  return {
    shareEmail: row?.shareEmail === true,
    sharePhone: row?.sharePhone === true,
    contactEmail: row?.contactEmail ?? null,
    contactPhone: row?.contactPhone ?? null,
  };
}

// Opening contact from a steward card. Conversation and first message are one
// transaction — the same no-empty-shell rule start_member_conversation keeps —
// and the new thread carries steward_user_id, which is what makes a second
// steward's Contact control reach a second thread.
export async function startMemberStewardConversation(client, stewardUserId, body) {
  return expectWrite(await client.rpc("start_member_steward_conversation", {
    p_steward_user_id: stewardUserId,
    p_body: body,
  }), "Start steward conversation");
}

// public.get_member_organization_structure() — the member-safe, read-only
// projection of the agency and union charts. Scoped to the caller's own
// organization AND chapter, reports_to edges only, participants already
// resolved to node ids server-side. The staff snapshot RPC is untouched.
export async function getMemberOrganizationStructure(client) {
  return normalizeOrganizationStructure(
    await expectWrite(await client.rpc("get_member_organization_structure"), "Organization structure"),
  );
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeOrganizationStructure(payload) {
  const charts = Array.isArray(payload?.charts) ? payload.charts : [];
  return {
    organizationId: payload?.organizationId ?? null,
    chapterId: payload?.chapterId ?? null,
    generatedAt: payload?.generatedAt ?? null,
    charts: charts
      .filter((chart) => chart && (chart.chartKind === "agency" || chart.chartKind === "union"))
      .map((chart) => ({
        chartKind: chart.chartKind,
        nodes: (Array.isArray(chart.nodes) ? chart.nodes : []).filter((node) => node?.id).map((node) => ({
          id: node.id,
          parentId: node.parentId ?? null,
          chapterId: node.chapterId ?? null,
          nodeKind: node.nodeKind ?? "role",
          label: typeof node.label === "string" ? node.label : "",
          subtitle: typeof node.subtitle === "string" && node.subtitle.trim() ? node.subtitle : null,
          positionX: Number.isFinite(node.positionX) ? node.positionX : 0,
          positionY: Number.isFinite(node.positionY) ? node.positionY : 0,
          sortOrder: Number.isFinite(node.sortOrder) ? node.sortOrder : 0,
          // Descriptive columns the import lane adds (API-CONTRACT.md 1.1).
          // Optional on purpose: this client runs against a database that may
          // not carry them yet, and a missing label is rendered as absent
          // rather than as an empty chip.
          badge: text(node.badge),
          roleClass: text(node.roleClass),
          vacant: node.vacant === true,
          reportsToLabel: text(node.reportsToLabel),
          chipLabel: text(node.chipLabel),
          sourceLabel: text(node.sourceLabel),
          sourceAsOf: text(node.sourceAsOf),
          // REQ-UG-TENANT-ORG-CHART-BASELINE-20261030. The server's
          // effective seat state. A database without the column sends none,
          // and an absent state reads unconfirmed, never confirmed.
          seatStatus: ["confirmed", "unconfirmed", "unknown", "stale"].includes(node.seatStatus) ? node.seatStatus : "unconfirmed",
          seatStatusReviewedOn: text(node.seatStatusReviewedOn),
          collapsedByDefault: node.collapsedByDefault === true,
        })),
        // The RPC already refuses every kind but reports_to and every edge
        // whose participants did not resolve to nodes of this chart. The
        // client repeats the node check only so a stale payload cannot draw a
        // line to a node it is not rendering.
        edges: (() => {
          const ids = new Set((Array.isArray(chart.nodes) ? chart.nodes : []).map((node) => node?.id).filter(Boolean));
          return (Array.isArray(chart.edges) ? chart.edges : [])
            .filter((edge) => edge?.id && edge.kind === "reports_to" && ids.has(edge.sourceId) && ids.has(edge.targetId))
            .map((edge) => ({ id: edge.id, sourceId: edge.sourceId, targetId: edge.targetId, kind: "reports_to" }));
        })(),
      })),
  };
}

export async function getAppointmentSlots(client, { type, duration, from, to, stewardId = null }) {
  return expectWrite(await client.rpc("get_appointment_slots", {
    p_type: type,
    p_duration: duration,
    p_from: from,
    p_to: to,
    p_steward: stewardId,
  }), "Open times");
}

export async function bookAppointment(client, { type, duration, startsAt, place, stewardId = null, reason = "general" }) {
  return expectWrite(await client.rpc("book_appointment", {
    p_type: type,
    p_duration: duration,
    p_starts_at: startsAt,
    p_place: place,
    p_steward: stewardId,
    p_reason: reason,
  }), "Book appointment");
}

export async function cancelAppointment(client, appointmentId) {
  return expectWrite(await client.rpc("cancel_appointment", { p_id: appointmentId }), "Cancel appointment");
}

export async function rescheduleAppointment(client, appointmentId, startsAt) {
  return expectWrite(await client.rpc("reschedule_appointment", { p_id: appointmentId, p_starts_at: startsAt }), "Reschedule");
}

// Steward-side slot lookup must pin p_steward to the authenticated caller.
// Passing null would aggregate every chapter steward and offer times the
// same-steward reschedule RPC must reject.
export async function getStewardRescheduleSlots(client, { type, duration, from, to }) {
  const authResult = await client.auth.getUser();
  if (authResult.error || !authResult.data?.user?.id) {
    throw new MemberApiError("Open times", authResult.error || { message: "authentication required" });
  }
  return getAppointmentSlots(client, {
    type, duration, from, to, stewardId: authResult.data.user.id,
  });
}

export async function markAppointmentOutcome(client, appointmentId, outcome) {
  return expectWrite(await client.rpc("mark_appointment_outcome", { p_id: appointmentId, p_outcome: outcome }), "Appointment outcome");
}

export async function loadStewardAppointments(client) {
  const desk = await expectWrite(await client.rpc("get_steward_appointments"), "Appointments desk");
  // Page-one cursors for the panel's two paged lists (sol  F9). The
  // blob's rows are camelCase jsonb — unlike the desk pagers above, the picks
  // read startsAt, not starts_at. Totals arrive from the RPC; the coalesce
  // keeps an older payload shape honest (rows.length, never more).
  const upcoming = desk?.upcoming || [];
  const recent = desk?.recent || [];
  return {
    ...desk,
    upcomingCursor: stewardPageCursor(upcoming, STEWARD_APPT_UPCOMING_PAGE, (last) => ({ startsAt: last.startsAt, id: last.id })),
    upcomingTotal: desk?.upcomingTotal ?? upcoming.length,
    recentCursor: stewardPageCursor(recent, STEWARD_APPT_RECENT_PAGE, (last) => ({ startsAt: last.startsAt, id: last.id })),
    recentTotal: desk?.recentTotal ?? recent.length,
  };
}

// Keyset pages for the appointments panel's two lists (sol  F9): no
// search or filter — p_scope picks the list and the walk direction (upcoming
// ascends so ended-but-unmarked rows surface first; recent descends).
export async function loadStewardAppointmentsPage(client, { scope = "upcoming", cursor = null, limit } = {}) {
  const cap = scope === "recent" ? STEWARD_APPT_RECENT_PAGE : STEWARD_APPT_UPCOMING_PAGE;
  const pageSize = Math.min(Math.max(Number(limit) || cap, 1), cap);
  const result = await client.rpc("list_steward_appointments", {
    p_scope: scope,
    p_after_starts: cursor?.startsAt ?? null,
    p_after_id: cursor?.id ?? null,
    p_limit: pageSize,
  });
  const rows = requireData(result, "Appointments desk");
  return {
    rows: rows.map((item) => ({
      id: item.id,
      memberName: item.member_name || "Member",
      type: item.appointment_type,
      durationMinutes: item.duration_minutes,
      startsAt: item.starts_at,
      endsAt: item.ends_at,
      place: item.place,
      status: item.status,
      reasonCategory: item.reason_category,
      routedVia: item.routed_via,
    })),
    nextCursor: stewardPageCursor(rows, pageSize, (last) => ({ startsAt: last.starts_at, id: last.id })),
    total: stewardPageTotal(rows, cursor),
  };
}

export async function setAppointmentSchedule(client, fields) {
  return expectWrite(await client.rpc("set_appointment_schedule", {
    p_timezone: fields.timezone ?? null,
    p_min_notice_minutes: fields.minNoticeMinutes ?? null,
    p_buffer_before_minutes: fields.bufferBeforeMinutes ?? null,
    p_buffer_after_minutes: fields.bufferAfterMinutes ?? null,
    p_max_per_day: fields.maxPerDay ?? null,
    p_accepting: fields.accepting ?? null,
  }), "Availability");
}

export async function setAppointmentWindows(client, windows) {
  return expectWrite(await client.rpc("set_appointment_windows", { p_windows: windows }), "Availability");
}

export async function addAppointmentBlackout(client, startDate, endDate) {
  return expectWrite(await client.rpc("add_appointment_blackout", { p_start_date: startDate, p_end_date: endDate }), "Blackout");
}

export async function removeAppointmentBlackout(client, blackoutId) {
  return expectWrite(await client.rpc("remove_appointment_blackout", { p_id: blackoutId }), "Blackout");
}

export async function requestCalendarConnection(client, provider) {
  return expectWrite(await client.rpc("request_calendar_connection", { p_provider: provider }), "Calendar connection");
}

export async function removeCalendarConnection(client, provider) {
  return expectWrite(await client.rpc("remove_calendar_connection", { p_provider: provider }), "Calendar connection");
}

export async function loadCalendarImportStatus(client) {
  const rows = await expectWrite(
    await client.rpc("get_my_calendar_import_status"),
    "Calendar import status",
  );
  return Array.isArray(rows) ? rows : [];
}

export async function loadAdminMemberDirectory(client, options = {}) {
  const after = options.after ?? null;
  const limit = Number.isSafeInteger(options.limit) ? Math.max(1, Math.min(options.limit, 50)) : 25;
  const data = requireData(await client.rpc("get_admin_member_directory", {
    p_query: String(options.query ?? "").trim(),
    p_after_name: after?.name ?? null,
    p_after_id: after?.id ?? null,
    p_limit: limit,
  }), "Member directory");
  if (!data || !Array.isArray(data.items)) throw new Error("Member directory: invalid response");
  return { items: data.items, nextCursor: data.nextCursor ?? null, context: directoryContext(data.context) };
}

// The organization and chapter a directory page was read under. The export
// binds to it, so a chapter switched in another tab cannot swap the file.
function directoryContext(value) {
  return typeof value?.organizationId === "string" && typeof value?.chapterId === "string"
    ? { organizationId: value.organizationId, chapterId: value.chapterId }
    : null;
}

// REQ-UG-OFFICER-MEMBER-ROSTER-AND-EXPORT-20261030: the server builds
// the CSV from the same scope and fields as the directory and logs the export;
// the browser only saves the file it is given. `context` is the displayed
// directory's own context; without it there is nothing to bind to.
export async function exportMemberDirectoryCsv(client, context, locale = "en") {
  const bound = directoryContext(context);
  if (!bound) throw new Error("Export member directory: no directory context");
  const data = requireData(await client.rpc("export_member_directory_csv", {
    p_expected_org: bound.organizationId,
    p_expected_chapter: bound.chapterId,
    p_locale: locale === "es" ? "es" : "en",
  }), "Export member directory");
  if (!data || typeof data.csv !== "string" || !Number.isSafeInteger(data.rowCount)) {
    throw new Error("Export member directory: invalid response");
  }
  return { csv: data.csv, rowCount: data.rowCount, scope: data.scope === "organization" ? "organization" : "chapter" };
}

// Whether the caller's administrator role or office reads the directory. An
// ordinary member gets { canRead: false } and no member data.
export async function loadMemberDirectoryAccess(client) {
  const data = requireData(await client.rpc("get_member_directory_access"), "Member directory access");
  return {
    canRead: data?.canRead === true,
    scope: data?.scope === "organization" ? "organization" : data?.scope === "chapter" ? "chapter" : null,
  };
}

// The caller's own recovery-code standing, for the admin's own row on the
// two-step status page (BUG-UG-SOLE-ADMIN-TWO-STEP-RESET-DEAD-END-20261103):
// no admin can reset their own second factor, so their codes are the way back.
export async function loadMfaRecoveryCodeStatus(client) {
  const data = requireData(await client.rpc("get_mfa_recovery_code_status"), "Recovery code status");
  if (!data || !Number.isInteger(data.unusedCount)) throw new Error("Recovery code status: invalid response");
  return { generation: Number(data.generation) || 0, unusedCount: data.unusedCount };
}

export async function loadAdminOrgStructure(client) {
  const data = requireData(await client.rpc("get_admin_org_structure"), "Organization structure");
  if (!data || !Array.isArray(data.chapters)) throw new Error("Organization structure: invalid response");
  return data;
}

export async function createAdminChapter(client, fields) {
  return expectWrite(await client.rpc("create_admin_chapter", {
    p_id: fields.id.trim().toLowerCase(),
    p_name: fields.name.trim(),
    p_region: fields.region.trim() || null,
    p_order_index: Number(fields.orderIndex),
  }), "Create chapter");
}

export async function updateAdminChapter(client, chapterId, fields) {
  return expectWrite(await client.rpc("update_admin_chapter", {
    p_chapter_id: chapterId,
    p_name: fields.name.trim(),
    p_region: fields.region.trim() || null,
    p_order_index: Number(fields.orderIndex),
  }), "Update chapter");
}

export async function grantMemberRole(client, userId, role, chapterId = null) {
  if (role === "steward") {
    const scope = chapterId && typeof chapterId === "object" ? chapterId : null;
    if (!scope?.chapterId || !scope?.unitId) throw new MemberApiError("Grant steward", { message: "Choose a chapter and unit", code: "22023" });
    const result = await expectWrite(await client.rpc("set_member_access_role", {
      p_user: userId, p_chapter: scope.chapterId, p_role: "steward", p_enabled: true,
      p_unit: scope.unitId, p_committee: null,
    }), "Grant steward");
    return { ...result, granted: result.updated === true };
  }
  // MI1 staff desks authorize against organization_role_grants. The admin
  // plane therefore uses the selected-organization role command instead of
  // the legacy chapter-role RPC. Keep the ignored argument for API
  // compatibility with older callers while they migrate.
  void chapterId;
  const result = await expectWrite(await client.rpc("set_member_organization_role", {
    p_user_id: userId,
    p_role: role,
    p_enabled: true,
  }), "Grant role");
  return { ...result, granted: result.changed };
}

export async function revokeMemberRole(client, userId, role) {
  const result = await expectWrite(await client.rpc("set_member_organization_role", {
    p_user_id: userId,
    p_role: role,
    p_enabled: false,
  }), "Revoke role");
  return { ...result, revoked: result.changed };
}

export async function adminSearchMembers(client, query) {
  return requireData(await client.rpc("admin_search_members", { p_query: query.trim() }), "Member search");
}

export async function adminSearchRecoveryMembers(client, query) {
  return requireData(await client.rpc("admin_search_recovery_members", { p_query: query.trim() }), "Recovery member search");
}

// Org staff-MFA policy (UB-IDN-03). expectWrite, not softData: an admin toggling
// a security control must never be told it worked when it did not, and the
// server refuses the enable outright when the calling admin has not enrolled —
// that refusal is the message the admin needs to read, verbatim.
export async function setStaffMfaPolicy(client, required) {
  return expectWrite(await client.rpc("set_staff_mfa_policy", { p_required: Boolean(required) }), "Staff two-step policy");
}

export async function setMemberMfaPolicy(client, required) {
  return requireData(await client.rpc("set_member_mfa_policy", {
    p_required: Boolean(required),
  }), "Member two-step policy");
}

export async function setCompassAiEnabled(client, enabled) {
  return expectWrite(await client.rpc("set_compass_ai_enabled", { p_enabled: Boolean(enabled) }), "Guide availability");
}

export async function setCompassAiRoleLimit(client, role, hourlyLimit) {
  return expectWrite(await client.rpc("set_compass_ai_role_limit", {
    p_role: role,
    p_hourly_limit: Number(hourlyLimit),
  }), "Guide role limit");
}

export async function attestCompassAiProvider(client, fields) {
  return expectWrite(await client.rpc("attest_compass_ai_provider", {
    p_evidence_ref: fields.evidenceRef.trim(),
    p_expires_at: fields.expiresAt || null,
    p_confirm_zero_data_retention: fields.confirmZeroDataRetention === true,
    p_confirm_disallow_prompt_training: fields.confirmDisallowPromptTraining === true,
    p_status: fields.status,
  }), "Guide provider attestation");
}

// The check-in code is optional: a deadline or reminder has none, and the
// database refuses every check-in for an event without one. On update, an
// omitted code (null) keeps the current one and removeCheckInCode sends the
// empty string, which removes it.
function expectEventWrite(result, useModel, label) {
  if (useModel && result.error && (result.status === 404 || ['PGRST202', '42883'].includes(result.error.code))) {
    throw new MemberApiError(label, { ...errorWithMissingFunctionCode(result), message: 'This feature needs the database update. Please try again after the update is complete.' });
  }
  return expectWrite(result, label);
}

export async function createAdminEvent(client, fields) {
  const useModel = (fields.eventKind ?? 'meeting') !== 'meeting' || Boolean(fields.endsAt) || Boolean(fields.eventDate)
    || Number(fields.occurrences ?? 1) !== 1;
  const common = {
    p_id: fields.id.trim(),
    p_title: fields.title.trim(),
    p_starts_at: fields.startsAt,
    p_location: fields.location.trim(),
    p_summary: fields.summary.trim(),
    p_check_in_code: fields.checkInCode?.trim().toUpperCase() || null,
    p_is_public: fields.isPublic === true,
    p_is_public_across_agencies: fields.isPublicAcrossAgencies === true,
  };
  const model = {
    p_kind: fields.eventKind ?? 'meeting',
    p_event_date: fields.eventDate || null,
    p_ends_at: fields.endsAt || null,
    p_occurrences: Number(fields.occurrences ?? 1),
    p_timezone: fields.timezone || 'America/New_York',
  };
  // RSVP collection off is set in the create's own transaction, so the event
  // is never visible open for RSVPs.
  if (fields.rsvpOpen === false) {
    return expectEventWrite(await client.rpc("create_member_event_with_rsvp", { ...common, ...model, p_rsvp_open: false }), true, 'Create event');
  }
  const result = useModel
    ? await client.rpc("create_member_event_model", { ...common, ...model })
    : await client.rpc("create_member_event", common);
  return expectEventWrite(result, useModel, 'Create event');
}

export async function updateAdminEvent(client, eventId, fields) {
  const schedule = fields.schedule;
  const useModel = fields.eventModelRequired === true || (schedule != null
    && (schedule.kind !== 'meeting' || Boolean(schedule.endsAt) || Boolean(schedule.eventDate)));
  const common = {
    p_id: eventId,
    p_title: fields.title?.trim() || null,
    p_starts_at: useModel ? fields.startsAt || null : schedule ? schedule.startsAt : fields.startsAt || null,
    p_location: fields.location?.trim() || null,
    p_summary: fields.summary?.trim() || null,
    p_check_in_code: fields.removeCheckInCode === true ? '' : fields.checkInCode?.trim().toUpperCase() || null,
    p_is_public: typeof fields.isPublic === 'boolean' ? fields.isPublic : null,
    p_is_public_across_agencies: typeof fields.isPublicAcrossAgencies === 'boolean' ? fields.isPublicAcrossAgencies : null,
  };
  // The version the editor opened (REQ-UG-LEARNING-PERIOD-EVENTS-20261103):
  // the database refuses the save if the event changed since, an undo
  // included, rather than putting back a value the undo took away.
  const versioned = Number.isInteger(fields.expectedVersion) ? { ...common, p_expected_version: fields.expectedVersion } : common;
  const send = (args) => (useModel
    ? client.rpc("update_member_event_model", { ...args, p_schedule: schedule ?? null })
    : client.rpc("update_member_event", args));
  // Sent once, with the version: a resend without it ran as whoever
  // was signed in by then and lost the stale-edit and undo protection. Both
  // updates take a version since 20261104110000.
  return expectEventWrite(await send(versioned), useModel, 'Update event');
}

// RSVP collection per event (REQ-UG-EVENTS-RSVP-CHECK-IN-AND-VISIBILITY-20261030),
// on its own RPC like the agenda so the create and update signatures stay.
export async function setAdminEventRsvpOpen(client, eventId, open, expectedVersion) {
  const common = { p_id: eventId, p_open: open === true };
  // Refused if the event changed since the update before it, an undo included.
  const versioned = Number.isInteger(expectedVersion) ? { ...common, p_expected_version: expectedVersion } : common;
  // Sent once, with the version; it takes one since 20261106120000.
  return expectWrite(await client.rpc("set_member_event_rsvp_open", versioned), "Set event RSVP collection");
}

// Staff-only event drafts live apart from member_events, so no member read can
// see one. Publishing is an ordinary createAdminEvent, then a delete.
export async function listAdminEventDrafts(client) {
  return requireData(await client.rpc("list_member_event_drafts"), "Event drafts");
}

export async function saveAdminEventDraft(client, draftId, fields) {
  return expectWrite(await client.rpc("save_member_event_draft", {
    p_draft_id: draftId || null,
    p_fields: fields,
  }), "Save event draft");
}

export async function deleteAdminEventDraft(client, draftId) {
  return expectWrite(await client.rpc("delete_member_event_draft", { p_draft_id: draftId }), "Delete event draft");
}

// The meeting agenda (owner decision, October 8, 2026): set or cleared on its
// own RPC so the eight-argument update_member_event signature is unchanged.
export async function setAdminEventAgenda(client, eventId, agenda, expectedVersion) {
  const common = { p_id: eventId, p_agenda: agenda?.trim() || null };
  // Refused if the event changed since the editor opened, an undo included.
  const versioned = Number.isInteger(expectedVersion) ? { ...common, p_expected_version: expectedVersion } : common;
  // Sent once, with the version; it takes one since 20261104110000.
  return expectWrite(await client.rpc("set_member_event_agenda", versioned), "Set event agenda");
}

// REQ-UG-MEETING-QUORUM-COUNTS-20261030: a meeting's optional quorum
// (staff, own chapter) and, for the meetings a caller can see, the checked-in
// count toward it. Only the two numbers ever come back.
export async function setMemberEventQuorum(client, eventId, quorum) {
  return expectWrite(await client.rpc("set_member_event_quorum", {
    p_id: eventId,
    p_quorum: Number.isInteger(quorum) ? quorum : null,
  }), "Set meeting quorum");
}

// The read takes at most 200 ids, so a longer list goes in batches of 200.
const MEMBER_EVENT_QUORUM_BATCH = 200;

export async function loadMemberEventQuorum(client, eventIds) {
  const ids = [...new Set((eventIds || []).filter((id) => typeof id === "string" && id))];
  const batches = [];
  for (let start = 0; start < ids.length; start += MEMBER_EVENT_QUORUM_BATCH) {
    batches.push(ids.slice(start, start + MEMBER_EVENT_QUORUM_BATCH));
  }
  const results = await Promise.all(batches.map(async (batch) =>
    requireData(await client.rpc("get_member_event_quorum", { p_event_ids: batch }), "Meeting quorum") ?? []));
  return new Map(results.flatMap((rows) => (Array.isArray(rows) ? rows : []))
    .filter((row) => typeof row?.eventId === "string" && Number.isInteger(row.quorum) && Number.isInteger(row.checkedIn))
    .map((row) => [row.eventId, { quorum: row.quorum, checkedIn: row.checkedIn }]));
}

export async function cancelAdminEvent(client, eventId, reason) {
  return expectWrite(await client.rpc("cancel_member_event", {
    p_id: eventId,
    p_reason: reason?.trim() || null,
  }), "Cancel event");
}

export async function restoreAdminEvent(client, eventId) {
  return expectWrite(await client.rpc("restore_member_event", { p_id: eventId }), "Restore event");
}

export async function deleteAdminEvent(client, eventId) {
  return expectWrite(await client.rpc("delete_member_event", { p_id: eventId }), "Delete event");
}

// UB-EVT-06: the events desk is a staff TOOL, so it must load for the four
// hats that cannot call the admin plane's roster/audit/MFA RPCs. This reads
// the one RPC they are now allowed — deliberately not loadAdminDesk, whose
// other four calls would 42501 for a steward and blank the whole desk.
export async function loadEventsDesk(client, lang = "en") {
  const events = requireData(await client.rpc("get_admin_events"), "Event manager");
  return {
    events: events.map((item) => ({
      ...item,
      ...eventModelLabels(item, lang),
    })),
  };
}

export async function triageStewardRequest(client, requestId, action) {
  return expectWrite(await client.rpc("triage_steward_request", { p_request_id: requestId, p_action: action }), "Triage request");
}

export async function sendStewardReply(client, conversationId, body) {
  return expectWrite(await client.rpc("send_steward_reply", { p_conversation_id: conversationId, p_body: body.trim() }), "Send steward reply");
}

export async function sendStewardResource(client, conversationId, documentId, body = "") {
  return expectWrite(await client.rpc("send_steward_resource", {
    p_conversation_id: conversationId,
    p_document_id: documentId,
    p_body: body.trim() || null,
  }), "Send steward resource");
}

export async function listScheduledMemberMessages(client, conversationId) {
  const result = await client.from("member_scheduled_messages")
    .select("id,conversation_id,sender_kind,body,scheduled_for,status,failure_reason,created_at")
    .eq("conversation_id", conversationId)
    .eq("status", "pending")
    .order("scheduled_for");
  return requireData(result, "Scheduled messages");
}

export async function listMemberContactNotes(client, conversationId) {
  return requireData(await client.rpc("list_member_contact_notes", {
    p_conversation_id: conversationId,
  }), "Contact notes");
}

export async function createMemberContactNote(client, conversationId, note, sourceMessageId = null) {
  return expectWrite(await client.rpc("create_member_contact_note", {
    p_conversation_id: conversationId,
    p_note: note.trim(),
    p_source_message_id: sourceMessageId,
  }), "Create contact note");
}

export async function listStewardEmailIntakes(client, status = "pending", limit = 50) {
  return requireData(await client.rpc("list_steward_email_intakes", {
    p_status: status,
    p_limit: limit,
  }), "Email intake");
}

export async function reviewStewardEmailIntake(client, intakeId, action) {
  return expectWrite(await client.rpc("review_steward_email_intake", {
    p_intake_id: intakeId,
    p_action: action,
  }), "Review email intake");
}

export async function createEventFromMemberMessage(client, messageId, fields) {
  return expectWrite(await client.rpc("create_event_from_member_message", {
    p_message_id: messageId,
    p_event_id: fields.id.trim(),
    p_title: fields.title.trim(),
    p_starts_at: fields.startsAt,
    p_location: fields.location.trim(),
    p_summary: fields.summary.trim(),
    p_check_in_code: fields.checkInCode.trim().toUpperCase(),
  }), "Create event from message");
}

// SEC-UG-BROADCASTS-CHAPTER-BOUNDARY-20260817: the audience a broadcast is
// published against is part of who is allowed to read it, so it travels
// explicitly instead of riding the RPC's default. "organization" means the
// publisher's own organization and never every tenant; the database refuses it
// outright unless the caller holds an organization-wide steward hat. An
// unrecognised value is rejected here rather than sent, because a typo that
// reached the RPC would surface as a generic 22023 with no audience in it.
export const BROADCAST_AUDIENCES = ["chapter", "organization"];

export async function publishMemberBroadcast(client, title, body, locale = "en", audienceScope = "chapter", operationKey) {
  const audience = typeof audienceScope === "string" ? audienceScope.trim().toLowerCase() : "";
  if (!BROADCAST_AUDIENCES.includes(audience)) {
    // MemberApiError, not a bare Error: every other failure this module raises
    // carries the same label/code shape, and a refusal the client made itself
    // should not be the one exception a caller has to special-case. `code`
    // stays null because no server rejected this — the call never left.
    throw new MemberApiError("Publish broadcast", {
      message: `audience must be ${BROADCAST_AUDIENCES.join(" or ")}`,
    });
  }
  // operationKey is the composer's draft key: every attempt of the draft
  // carries it, so a retry after a lost reply gets the published notice back
  // instead of a second one .
  const result = await publishNoticeOnce({
    p_title: title.trim(),
    p_body: body.trim(),
    p_locale: locale,
    p_audience_scope: audience,
  }, (sent) => client.rpc("publish_member_broadcast", sent), operationKey);
  return expectWrite(result, "Publish broadcast");
}

export async function retractMemberBroadcast(client, broadcastId) {
  return expectWrite(await client.rpc("retract_member_broadcast", { p_broadcast_id: broadcastId }), "Retract broadcast");
}

export async function stewardStartFormReview(client, formId) {
  return expectWrite(await client.rpc("steward_start_review", { p_form_id: formId }), "Start review");
}

// What a steward's review showed: the signature's fields (a sealed
// form by its stored version, never its answers; an ordinary one by its
// answers; the confirmed attachment ids) plus the accepted co-signers shown.
export function formApprovalExpectation(review) {
  const expected = formSignatureExpectation(review);
  return expected ? { ...expected, cosignerIds: Array.isArray(review.cosignerIds) ? review.cosignerIds : [] } : null;
}

// approve_form and approve_and_open_case compare `review` under the form lock
// and refuse with PT409 form_changed_since_review, approving nothing, when the
// filing changed after the steward's read. Sent once, with the expectation
//: a resend without it ran as whoever was signed in by then and
// approved content nobody reviewed. Both take it since 20261113123000.
async function approvalRpc(send, formId, note, review) {
  const common = { p_form_id: formId, p_note: note && note.trim() ? note.trim() : null };
  const expected = formApprovalExpectation(review);
  // The website never approves without naming what the steward saw (,
  // gate round 1 on): with nothing to compare the server would approve
  // whatever is stored.
  if (!expected) throw new Error("approval-review-required");
  return send({ ...common, p_expected: expected });
}

export async function approveForm(client, formId, note, review = null) {
  return expectWrite(await approvalRpc((args) => client.rpc("approve_form", args), formId, note, review), "Approve form");
}

export async function returnForm(client, formId, note) {
  return expectWrite(await client.rpc("return_form", { p_form_id: formId, p_note: note.trim() }), "Return form");
}

export async function openFormAsCase(client, formId) {
  return expectWrite(await client.rpc("open_form_as_case", { p_form_id: formId }), "Open form as case");
}

// One transaction server-side: a case-open failure rolls the approval back,
// so a grievance can never end up approved-but-caseless from this path.
export async function approveAndOpenFormCase(client, formId, note, review = null) {
  return expectWrite(await approvalRpc((args) => client.rpc("approve_and_open_case", args), formId, note, review), "Approve and open case");
}

export async function markChapterSpaceRead(client, spaceId) {
  return expectWrite(await client.rpc("mark_chapter_space_read", { p_space_id: spaceId }), "Mark channel read");
}

// REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001. Kept at the end of the
// module so line-pinned callers above do not move. expectedUpdatedAt is the
// setting's updatedAt from the admin read (null when it showed the default);
// a newer change by another admin is refused with 40001.
export async function setOrganizationSetting(client, key, value, expectedUpdatedAt = null) {
  return expectWrite(await client.rpc("set_organization_setting", {
    p_key: key,
    p_value: value,
    p_expected_updated_at: expectedUpdatedAt,
  }), "Save organization setting");
}

export async function resetOrganizationSetting(client, key, expectedUpdatedAt = null) {
  return expectWrite(await client.rpc("reset_organization_setting", {
    p_key: key,
    p_expected_updated_at: expectedUpdatedAt,
  }), "Reset organization setting");
}

export async function loadOrganizationConfigurationAudit(client, key = null, limit = 50) {
  const data = await expectWrite(await client.rpc("list_organization_configuration_audit", {
    p_setting_key: key,
    p_limit: limit,
  }), "Load configuration history");
  return Array.isArray(data?.items) ? data.items : [];
}

// REQ-UG-EVENT-AND-POLL-FOLLOW-UPS-20261001: draft announcements a new
// event prepares for its chapter's stewards. Appended at the end of the module
// so the pinned call-site lines above do not move.
// BUG-UG-STEWARD-SCREENS-CALL-READS-REFUSED-FOR-UNIT-STEWARDS-20261115
//: drafts are chapter-wide announcements, and since / a
// steward limited to a unit may not send chapter-wide notices, so the server
// refuses them the drafts read. With chapterNotices, ask the chapter office
// read first, as the chapter office panel does, and skip the call (no drafts)
// only when that read answers that the caller may not send to the whole
// chapter; when it fails or says nothing, the drafts read goes ahead and the
// server decides, as the panel's `unscopedNotices !== false` does.
export async function listAnnouncementDrafts(client, { chapterNotices = false } = {}) {
  if (chapterNotices) {
    const office = await client.rpc("get_chapter_office_access");
    if (!office?.error && office?.data?.unscopedNotices === false) return [];
  }
  const data = await expectWrite(await client.rpc("list_announcement_drafts"), "Load announcement drafts");
  return Array.isArray(data?.drafts) ? data.drafts.filter((draft) => draft && typeof draft.id === "string"
    && typeof draft.title === "string" && typeof draft.body === "string") : [];
}

export async function resolveAnnouncementDraft(client, draftId, state) {
  if (!["published", "dismissed"].includes(state)) throw new MemberApiError("Resolve announcement draft", { message: "invalid draft state" });
  return expectWrite(await client.rpc("resolve_announcement_draft", { p_draft_id: draftId, p_state: state }), "Resolve announcement draft");
}

// The invitation desk read shared by admins and chapter Presidents
// (BUG-UG-CHAPTER-PRESIDENT-CANNOT-INVITE-20261003), for planes that
// do not load the admin desk. Same RPC and mapping as loadAdminDesk's
// invitations; a refusal throws so the caller can hide the card.
// The admin desk passes its own listing ceiling (100) so a refresh after a send
// shows the same rows the desk read does.
export async function loadMemberInvitations(client, lang = "en", { limit = 50 } = {}) {
  const data = requireData(await client.rpc("get_member_invitations", { p_limit: limit }), "Member invitations") ?? {};
  return {
    chapter: data.chapter ?? null,
    chapters: Array.isArray(data.chapters) ? data.chapters.filter((chapter) => chapter?.id && chapter?.name) : null,
    items: (data.items ?? []).map((item) => ({
      ...item,
      createdLabel: invitationMomentLabel(item.createdAt, lang),
      ...invitationLifecycleLabels(item, lang),
    })),
  };
}

// Officer display title for a chapter membership
// (BUG-UG-INVITE-STARTING-ACCESS-NO-OFFICER-TITLES-20261003). Display
// only: access is still granted through roles. A blank title clears it.
export async function setMemberChapterDisplayTitle(client, userId, chapterId, title) {
  return expectWrite(await client.rpc("set_member_chapter_display_title", {
    p_user_id: userId, p_chapter_id: chapterId, p_title: String(title ?? ""),
  }), "Set display title");
}

// BUG-UG-CHAPTER-ROLES-HIDDEN-UNTIL-CHAPTER-SWITCH-20261003: the
// member's own chapter memberships (get_my_chapter_memberships), for the
// chapter rail and My chapter's switch. Defined at the end of the file so the
// line-pinned RPC call sites above (pr1815 read-rpc drift guard) do not move.
function memberChapterMemberships(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => typeof row?.chapterId === "string" && row.chapterId)
    .map((row) => ({ chapterId: row.chapterId, name: row.name || row.chapterId, selected: row.selected === true }));
}

// REQ-UG-PROFILE-WORKPLACE-JOB-PHONE-AND-PRONOUNS-20261006: the
// member's own pronouns, job, worksite and phone, and who may see them
// ("only_me" or "admins"). Both RPCs are self-scoped: neither takes a user id.
export const PROFILE_DETAIL_VISIBILITIES = ["only_me", "admins"];

function profileDetails(row) {
  const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const visibility = (value) => (PROFILE_DETAIL_VISIBILITIES.includes(value) ? value : "only_me");
  return {
    pronouns: text(row?.pronouns),
    jobTitle: text(row?.jobTitle),
    worksite: text(row?.worksite),
    ...(Object.hasOwn(row ?? {}, "shift") || Object.hasOwn(row ?? {}, "classification") ? { shift: text(row.shift), classification: text(row.classification), workplaceOptions: row.workplaceOptions ?? {} } : {}),
    phone: text(row?.phone),
    detailsVisibility: visibility(row?.detailsVisibility),
    phoneVisibility: visibility(row?.phoneVisibility),
  };
}

export async function getMyProfileDetails(client) {
  return profileDetails(await expectWrite(await client.rpc("get_my_profile_details"), "Profile details"));
}

export async function setMyProfileDetails(client, fields) {
  const next = profileDetails(fields);
  if (Object.hasOwn(next, "shift") || Object.hasOwn(fields ?? {}, "classification")) {
    const details = Object.fromEntries(["pronouns", "jobTitle", "worksite", "shift", "classification", "phone", "detailsVisibility", "phoneVisibility"].map((key) => [key, next[key] ?? null]));
    return profileDetails(await expectWrite(await client.rpc("set_my_profile_details_v2", { p_details: details }), "Profile details"));
  }
  return profileDetails(await expectWrite(await client.rpc("set_my_profile_details", {
    p_pronouns: next.pronouns,
    p_job_title: next.jobTitle,
    p_worksite: next.worksite,
    p_phone: next.phone,
    p_details_visibility: next.detailsVisibility,
    p_phone_visibility: next.phoneVisibility,
  }), "Profile details"));
}

// REQ-UG-WHO-RUNS-THIS-CHAPTER-AND-ONE-WORD-FOR-STAFF-20261006: the
// member's own chapter's officers (display titles), President and
// administrators, plus the organization's administrators. Name, title and
// those roles only; the RPC takes no chapter id.
export async function getChapterLeadership(client) {
  const data = await expectWrite(await client.rpc("get_chapter_leadership"), "Chapter leadership");
  const people = (Array.isArray(data?.people) ? data.people : [])
    .filter((row) => typeof row?.id === "string" && typeof row?.name === "string" && row.name.trim())
    .map((row) => ({
      id: row.id,
      name: row.name.trim(),
      title: typeof row.title === "string" && row.title.trim() ? row.title.trim() : null,
      president: row.president === true,
      treasurer: row.treasurer === true,
      administrator: row.administrator === true,
      organizationAdministrator: row.organizationAdministrator === true,
      // REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030: the
      // server decides who the caller may write to (the same set
      // start_officer_conversation accepts) and which channel an officer
      // shared with the members of their chapter.
      canMessage: row.canMessage === true,
      contact: {
        email: typeof row.contact?.email === "string" && row.contact.email.trim() ? row.contact.email.trim() : null,
        phone: typeof row.contact?.phone === "string" && row.contact.phone.trim() ? row.contact.phone.trim() : null,
      },
    }));
  return { chapterId: data?.chapterId ?? null, chapterName: data?.chapterName ?? null, people };
}

// REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030: a private
// two-person conversation with a listed officer or administrator of the
// caller's own chapter, opened (or reused) with its first message in one
// transaction. No contact code or reward; the server refuses anyone else
// (detail officer_unavailable). Returns { created, message, conversation } in
// the member-contact projection's shapes.
export async function startOfficerConversation(client, officerUserId, body, operationId) {
  return expectWrite(await callPeerMessageRpc((args) => client.rpc("start_officer_conversation", args), "start_officer_conversation", {
    p_officer_user_id: officerUserId,
    p_body: body,
  }, operationId), "Start officer conversation");
}

// REQ-UG-PEER-ROLE-CONTACT-ACROSS-CHAPTERS-20261109: one page
// of the holders of the caller's enabled access level on the organization's
// other chapters (name, display title and chapter only), the caller's own mute
// and the next page's offset (null on the last page). The server decides who
// is listed; nothing here widens it.
export function normalizeCrossChapterPeers(data) {
  const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : []);
  return {
    available: data?.available === true,
    levels: strings(data?.levels),
    muted: data?.muted === true,
    peers: (Array.isArray(data?.peers) ? data.peers : [])
      .filter((peer) => typeof peer?.id === "string" && typeof peer.name === "string")
      .map((peer) => ({
        id: peer.id,
        name: peer.name,
        title: typeof peer.title === "string" && peer.title.trim() ? peer.title.trim() : null,
        chapters: strings(peer.chapters),
        levels: strings(peer.levels),
      })),
    nextOffset: Number.isInteger(data?.nextOffset) && data.nextOffset > 0 ? data.nextOffset : null,
  };
}

export const CROSS_CHAPTER_PAGE = 50;

export async function listCrossChapterPeers(client, { query = "", offset = 0, limit = CROSS_CHAPTER_PAGE } = {}) {
  return normalizeCrossChapterPeers(await expectWrite(await client.rpc("list_cross_chapter_peers", {
    p_query: typeof query === "string" && query.trim() ? query.trim() : null,
    p_offset: offset,
    p_limit: limit,
  }), "Read leads in other chapters"));
}

// One message to 1-20 listed peers, each in its own two-person conversation
// (reused or opened). Any recipient the caller may not reach refuses the whole
// send (detail cross_chapter_peer_unavailable). Returns { created,
// conversations: [{ id, peerName, peerInitials, updatedAt, message }] }.
export async function sendCrossChapterPeerMessage(client, recipientIds, body) {
  return expectWrite(await client.rpc("send_cross_chapter_peer_message", {
    p_recipient_ids: recipientIds,
    p_body: body,
  }), "Send to leads in other chapters");
}

export async function setCrossChapterPeerMute(client, muted) {
  return expectWrite(await client.rpc("set_my_cross_chapter_peer_mute", { p_muted: muted === true }), "Mute contact from other chapters");
}

// Explicit scope protects in-flight budget requests during chapter switches.
function budgetScope(scope) {
  return { p_expected_org: scope.organizationId, p_expected_chapter: scope.chapterId };
}
export async function loadChapterBudgetAccess(client, scope, page = 0) {
  return expectWrite(await client.rpc("get_chapter_budget_access", { ...budgetScope(scope), p_page: page }), "Read budget access");
}
export async function loadChapterBudgets(client, scope, page = 0) {
  return expectWrite(await client.rpc("list_chapter_budgets", { ...budgetScope(scope), p_page: page }), "Read chapter budgets");
}
export async function setChapterBudgetOffice(client, scope, userId, office) {
  return expectWrite(await client.rpc("set_chapter_budget_office", { ...budgetScope(scope), p_user_id: userId, p_office: office || null }), "Set budget office");
}
export async function saveChapterBudget(client, scope, budget) {
  return expectWrite(await client.rpc("save_chapter_budget", {
    ...budgetScope(scope), p_id: budget.id || null, p_revision: budget.revision ?? 0,
    p_title: budget.title.trim(), p_period_start: budget.period_start, p_period_end: budget.period_end,
    p_notes: budget.notes || "", p_items: budget.items,
  }), "Save chapter budget");
}

// REQ-UG-INVITATION-SUGGESTIONS-AND-ACCESS-REQUESTS-20261030: a
// member's invitation suggestion or staff-role request, and the deciders' list
// with Approve and Decline. The server decides who may submit, see and decide.
export const MEMBER_REQUEST_ROLES = Object.freeze(["steward", "coordinator", "advisor"]);

function memberRequestRow(row) {
  if (!row || typeof row.id !== "string" || !["invitation_suggestion", "access_request"].includes(row.kind)) return null;
  return {
    id: row.id,
    kind: row.kind,
    chapterId: typeof row.chapterId === "string" ? row.chapterId : "",
    chapterName: typeof row.chapterName === "string" ? row.chapterName : "",
    requesterName: typeof row.requesterName === "string" ? row.requesterName : "",
    inviteeName: typeof row.inviteeName === "string" ? row.inviteeName : "",
    inviteeEmail: typeof row.inviteeEmail === "string" ? row.inviteeEmail : "",
    requestedRole: MEMBER_REQUEST_ROLES.includes(row.requestedRole) ? row.requestedRole : null,
    note: typeof row.note === "string" ? row.note : "",
    status: ["pending", "approved", "declined"].includes(row.status) ? row.status : "pending",
    createdAt: row.createdAt ?? null,
    // REQ-UG-INTAKE-QUEUE-SEND-INVITATION-FROM-ROW-20261118: passed
    // on by Union Ground from a person's invite request, not from a member.
    fromIntake: row.fromIntake === true,
  };
}

function memberRequestPage(data) {
  return {
    items: (Array.isArray(data?.items) ? data.items : []).map(memberRequestRow).filter(Boolean),
    hasMore: data?.hasMore === true,
  };
}

const requestCursor = (before) => (before && typeof before.createdAt === "string" && typeof before.id === "string" ? before : null);

export async function submitMemberRequest(client, { kind, inviteeName = null, inviteeEmail = null, requestedRole = null, note = null }) {
  return expectWrite(await client.rpc("submit_member_request", {
    p_kind: kind,
    p_invitee_name: inviteeName,
    p_invitee_email: inviteeEmail,
    p_requested_role: requestedRole,
    p_note: note,
  }), "Send request");
}

export async function listMyMemberRequests(client, before = null) {
  const cursor = requestCursor(before);
  return memberRequestPage(await expectWrite(await client.rpc("list_my_member_requests", {
    p_limit: 20, p_before_created: cursor ? cursor.createdAt : null, p_before_id: cursor ? cursor.id : null,
  }), "Load my requests"));
}

export async function listMemberRequests(client, status = "pending", before = null) {
  const cursor = requestCursor(before);
  return memberRequestPage(await expectWrite(await client.rpc("list_member_requests", {
    p_status: status === "decided" ? "decided" : "pending",
    p_limit: 20, p_before_created: cursor ? cursor.createdAt : null, p_before_id: cursor ? cursor.id : null,
  }), "Load requests"));
}

// Approving a suggestion goes through the invitation route instead (the
// server refuses it here), so its invitation is created with the approval.
export async function decideMemberRequest(client, requestId, decision, unitId = null) {
  if (!["approved", "declined"].includes(decision)) throw new MemberApiError("Decide request", { message: "invalid decision" });
  //: approving a Steward request carries the unit the decider chose.
  const args = { p_request_id: requestId, p_decision: decision };
  if (unitId) args.p_unit_id = unitId;
  return expectWrite(await client.rpc("decide_member_request", args), "Decide request");
}

// REQ-UG-OFFICER-NOTICES-WITH-READ-RECEIPTS-20261030: the notices the
// signed-in steward, admin or president posted, with read and audience counts,
// and who has read one of them. The server refuses anyone else and any notice
// the caller did not post.
function noticeCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : null;
}

// `before` is the last notice of the previous page ({ publishedAt, id }).
export async function listMyMemberNotices(client, before = null) {
  const cursor = before && typeof before.publishedAt === "string" && typeof before.id === "string" ? before : null;
  const data = await expectWrite(await client.rpc("list_my_member_notices", {
    p_limit: 20,
    p_before_published: cursor ? cursor.publishedAt : null,
    p_before_id: cursor ? cursor.id : null,
  }), "Load my notices");
  const notices = (Array.isArray(data?.notices) ? data.notices : [])
    .filter((notice) => notice && typeof notice.id === "string" && typeof notice.title === "string")
    .map((notice) => ({
      id: notice.id,
      title: notice.title,
      body: typeof notice.body === "string" ? notice.body : "",
      locale: notice.locale === "es" ? "es" : "en",
      audience: notice.audience === "organization" ? "organization" : "chapter",
      publishedAt: notice.publishedAt ?? null,
      retracted: Boolean(notice.retractedAt),
      readCount: noticeCount(notice.readCount),
      audienceCount: noticeCount(notice.audienceCount),
    }));
  return { notices, hasMore: data?.hasMore === true };
}

export async function getMemberNoticeReceipts(client, broadcastId) {
  const data = await expectWrite(await client.rpc("get_member_notice_receipts", { p_broadcast_id: broadcastId }), "Load notice receipts");
  return {
    readCount: noticeCount(data?.readCount),
    audienceCount: noticeCount(data?.audienceCount),
    readers: (Array.isArray(data?.readers) ? data.readers : [])
      .filter((reader) => reader && typeof reader.readAt === "string")
      .map((reader) => ({ name: typeof reader.name === "string" && reader.name.trim() ? reader.name.trim() : null, readAt: reader.readAt })),
  };
}

// BUG-UG-ACCEPTED-INVITATIONS-SHOW-EXPIRY-20261102: an invitation
// row's times, each naming the zone it is shown in. A time the read did not
// return stays "", so a row never shows a time it does not have. Defined at the
// end of the file so the line-pinned RPC call sites above do not move.
const INVITATION_TIME_OPTIONS = Object.freeze({ hour: "numeric", minute: "2-digit", timeZoneName: "short" });

function invitationMomentLabel(value, lang = "en") {
  const moment = value ? new Date(value) : null;
  if (!moment || Number.isNaN(moment.getTime())) return "";
  return `${eventDateLabel(moment, lang)} · ${dateTimeFormat(lang, INVITATION_TIME_OPTIONS).format(moment)}`;
}

function invitationLifecycleLabels(item, lang = "en") {
  return {
    expiresLabel: invitationMomentLabel(item.expiresAt, lang),
    acceptedLabel: invitationMomentLabel(item.acceptedAt, lang),
    revokedLabel: invitationMomentLabel(item.revokedAt, lang),
  };
}
