// BUG-UG-CASE-DEADLINE-MEMBER-AND-STAFF-READ-DIFFERENT-DATES-20261110:
// the date a case runs to first, and which deadline it is. Staff What to do
// next ranks on private.case_next_deadline and get_case_queue_next_actions
// names that date (dueKind, dueLabel); the member's My cases card and Home, on
// web and native, pick it here from the member's own casework_deadlines rows
// by the same rule, so both sides show one date with one label:
//   - an open step deadline is a row whose status is active, extended or
//     missed (a missed one stays until staff record it met or waived), dated by
//     its calendar day in the zone it was set in (its time_zone,);
//   - the earliest open step deadline (by due_at to the microsecond, then id,
//     as the SQL orders them) is shown when it has fewer days left, each
//     counted on its own zone, than the case's own deadline (counted on the
//     case's time_zone), or the case has none (private.case_next_deadline);
//   - otherwise the case's own deadline is shown, exactly as before.
// The result carries the zone its days are counted on (timeZone).
// Pure and catalogue-free: the native app imports it.
import { UNSET_GROUP_TIME_ZONE, isTimeZone, zoneDay } from "./zoneTime.js";
import { localeFor } from "./i18n/format.js";

export const OPEN_STEP_DEADLINE_STATUSES = Object.freeze(["active", "extended", "missed"]);
const OPEN = new Set(OPEN_STEP_DEADLINE_STATUSES);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// A stored zone, or the value every group reads until its own is delivered.
function zoneOf(value) {
  return isTimeZone(value) ? value : UNSET_GROUP_TIME_ZONE;
}

// Date-only values name a calendar day, never midnight in a zone.
function stepDay(dueAt, zone) {
  if (typeof dueAt !== "string" || !dueAt) return null;
  return DATE_ONLY.test(dueAt) ? dueAt : zoneDay(dueAt, zone);
}

// Whole calendar days from today in the zone to a YYYY-MM-DD day.
function daysLeft(day, zone, now) {
  const today = zoneDay(now, zone);
  if (!today) return null;
  return (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
}

function order(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Postgres keeps microseconds and Date.parse keeps milliseconds, so the
// sub-millisecond digits break what would otherwise read as a tie.
function instant(dueAt) {
  const micros = /T\d{2}:\d{2}:\d{2}\.(\d+)/.exec(dueAt)?.[1] ?? "";
  return { ms: Date.parse(dueAt), sub: Number(micros.padEnd(6, "0").slice(3, 6)) };
}

/**
 * @param {string | null | undefined} caseDeadline the case's own YYYY-MM-DD deadline
 * @param {ReadonlyArray<{ id?: string, label?: string, due_at?: string, status?: string, time_zone?: string }>} [stepDeadlines]
 * @param {{ caseTimeZone?: string | null, now?: Date }} [options] the case's stored zone, and the moment "today" is read at
 * @returns {{ kind: "step" | "case", label: string | null, dueOn: string, missed: boolean, timeZone: string } | null}
 */
export function caseNextDeadline(caseDeadline, stepDeadlines = [], { caseTimeZone = null, now = new Date() } = {}) {
  const own = typeof caseDeadline === "string" && DATE_ONLY.test(caseDeadline) ? caseDeadline : null;
  const ownZone = zoneOf(caseTimeZone);
  const step = (Array.isArray(stepDeadlines) ? stepDeadlines : [])
    .filter((row) => row && OPEN.has(row.status) && stepDay(row.due_at, zoneOf(row.time_zone)))
    .map((row) => ({ row, zone: zoneOf(row.time_zone), day: stepDay(row.due_at, zoneOf(row.time_zone)), at: instant(row.due_at) }))
    .sort((left, right) => (left.at.ms - right.at.ms) || (left.at.sub - right.at.sub)
      || order(String(left.row.id ?? "").toLowerCase(), String(right.row.id ?? "").toLowerCase()))[0];
  if (step && (!own || daysLeft(step.day, step.zone, now) < daysLeft(own, ownZone, now))) {
    return { kind: "step", label: typeof step.row.label === "string" ? step.row.label : "", dueOn: step.day, missed: step.row.status === "missed", timeZone: step.zone };
  }
  return own ? { kind: "case", label: null, dueOn: own, missed: false, timeZone: ownZone } : null;
}

// Each case with the deadline it runs to first, from the open step deadlines
// read for those cases (rows carry case_id).
export function withNextDeadlines(cases, stepDeadlines, caseDeadlineOf = (item) => item.deadline,
  caseTimeZoneOf = (item) => item.time_zone ?? item.timeZone ?? null, now = new Date()) {
  const byCase = new Map();
  for (const row of Array.isArray(stepDeadlines) ? stepDeadlines : []) {
    if (!row || row.case_id == null) continue;
    const key = String(row.case_id);
    byCase.set(key, [...(byCase.get(key) || []), row]);
  }
  return cases.map((item) => ({ ...item, nextDeadline: caseNextDeadline(caseDeadlineOf(item), byCase.get(String(item.id)) || [], { caseTimeZone: caseTimeZoneOf(item), now }) }));
}

// "Nov 8" / "8 nov" for a YYYY-MM-DD day.
export function deadlineDayText(day, lang = "en") {
  if (typeof day !== "string" || !DATE_ONLY.test(day)) return "";
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(localeFor(lang), { month: "short", day: "numeric", timeZone: "UTC" }).format(date) : "";
}

// The one wording staff and members both read: "Step 1 deadline passed 1 day
// ago (Nov 8)", "case deadline in 3 days (Nov 12)". `tr` is the caller's
// translate function over the caseSignals.deadline.* keys. Any other kind is a
// deadline the server did not name ("deadline in 4 days").
export function caseDeadlinePhrase(tr, { kind, label, days, dueOn }, lang = "en") {
  const name = kind === "step" ? tr("caseSignals.deadline.step", { label: label || tr("caseSignals.deadline.stepFallback") })
    : kind === "case" ? tr("caseSignals.deadline.case") : tr("caseSignals.deadline.unnamed");
  const date = deadlineDayText(dueOn, lang);
  if (!Number.isInteger(days)) return tr("caseSignals.deadline.phraseUndated", { name, date });
  const when = days < 0
    ? tr(days === -1 ? "caseSignals.deadline.passedOne" : "caseSignals.deadline.passed", { count: Math.abs(days) })
    : days === 0 ? tr("caseSignals.deadline.today")
      : tr(days === 1 ? "caseSignals.deadline.inOne" : "caseSignals.deadline.inDays", { count: days });
  return tr("caseSignals.deadline.phrase", { name, when, date });
}

export function sentenceStart(text) {
  return typeof text === "string" && text ? text.charAt(0).toLocaleUpperCase() + text.slice(1) : text;
}
