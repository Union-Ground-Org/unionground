// REQ-UG-MEMBER-WHAT-MATTERS-NOW-20261001.
//
// The old member home's "What matters for you now" card and its action shelf
// (de7df4b57c^:lib/attention/rules.ts, lib/attention/member-queue.ts,
// components/home/lib/load-member-home.ts buildMemberAttention, and
// components/home/lib/action-shelf-resolver.ts): every Home visit surfaces ONE
// ranked next action. Rules, first match wins:
//
//   1. an issue deadline within 3 days (or overdue) on an active issue
//      (rules.ts:16 `filingDeadlineDays <= 3` -> deadline_risk)
//   2. an active issue in progress (buildFirstCaseAttention)
//   3. an open campaign task assigned to the person, overdue or due within
//      the seven-day lookahead
//   4. an open vote the worker has not cast (action-shelf-resolver.ts rule 3)
//   5. a meeting this week the worker has not answered (rule 4, RSVP intent)
//   6. an open survey the worker has not answered
//   7. an unread notice
//   8. caught up (buildCaughtUpAttention)
//
// ULP filing-deadline and retaliation-flag rules are left out:
// Union Ground has no unfair labor practice deadline (owner decision,
// 2026-10-13), and its issue summary carries neither field.
//
// Rules 6 and 7 keep "caught up" from sitting above a survey to answer or an
// unread notice that Home and Pulse list. A survey whose answer deadline has
// passed is no longer one to answer (surveysToAnswer). Rule 3 keeps "caught
// up" from sitting above an overdue or nearly due task assigned to the person.
// Callers pass only the person's own assignments (assignedTasksOf).
//
// Pure: no fetching, no clock reads except the `now` argument. Native imports
// this module through apps/mobile/src/lib/memberHomeShared.ts.
import { easternDay } from "../../lib/easternCalendar.js";
import { zoneDay } from "../../lib/zoneTime.js";

export const WHAT_MATTERS_SWITCH = "features.home.what_matters_now";
export const FILING_DEADLINE_RISK_DAYS = 3;
const RSVP_HORIZON_DAYS = 7;
// The same seven-day lookahead as events.
export const TASK_LOOKAHEAD_DAYS = RSVP_HORIZON_DAYS;

const DAY_MS = 86_400_000;

function isoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

// Whole calendar days to a YYYY-MM-DD deadline, counted in the zone the
// deadline was set in when one is given (#9446), else on the Eastern calendar.
// UTC midnights below are ordinal calendar dates, not the instants when days
// start: 0 = today, 1 = tomorrow, negative = past.
/** @param {string | null} [zone] the zone the deadline was set in */
export function calendarDaysUntil(dateValue, now = new Date(), zone = null) {
  const iso = isoDate(dateValue);
  const day = zone ? zoneDay(now, zone) : easternDay(now);
  if (!iso || !day) return null;
  const target = Date.parse(`${iso}T00:00:00Z`);
  const today = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(target)) return null;
  return (target - today) / DAY_MS;
}

function caseIsActive(item) {
  return String(item?.status ?? "").toLowerCase() === "active";
}

function caseDeadline(item) {
  return isoDate(item?.deadlineValue) ?? isoDate(item?.deadline);
}

// BUG-UG-CASE-DEADLINE-MEMBER-AND-STAFF-READ-DIFFERENT-DATES-20261110:
// the date the case runs to first. An open step deadline before the case's
// own deadline (src/lib/caseNextDeadline.js, the rule staff What to do next
// ranks on) replaces it, labeled; a case without one ranks exactly as before.
function firstDeadline(item) {
  const next = item?.nextDeadline;
  // Its days are counted on the zone that deadline was set in (timeZone).
  const timeZone = next?.timeZone ?? null;
  if (next?.kind === "step" && isoDate(next.dueOn)) {
    return { deadline: isoDate(next.dueOn), timeZone, step: { deadlineKind: "step", deadlineLabel: typeof next.label === "string" ? next.label : "" } };
  }
  return { deadline: caseDeadline(item), timeZone, step: null };
}

function caseSummary(item) {
  return {
    id: String(item.id),
    reference: typeof item.reference === "string" && item.reference ? item.reference : null,
    title: typeof item.title === "string" ? item.title : "",
    // No grievance step: this edition leaves grievance steps out.
  };
}

// The open surveys the member has not answered, closing soonest first. A
// survey past its answer deadline, closed, or already answered is left out, so
// a past deadline is never shown as one still to meet.
export function surveysToAnswer(surveys, now = new Date()) {
  const nowMs = now.getTime();
  return (Array.isArray(surveys) ? surveys : [])
    .filter((item) => {
      if (!item || item.id == null || item.closed || item.answered) return false;
      const closesAt = Date.parse(item.closesAt);
      return !Number.isFinite(closesAt) || closesAt > nowMs;
    })
    .sort((left, right) => (Date.parse(left.closesAt) || Infinity) - (Date.parse(right.closesAt) || Infinity));
}

// The open tasks assigned to one person, as the ranking reads them: the
// primary assignee or any co-assignee, never a done task.
export function assignedTasksOf(tasks, personId) {
  if (!personId || !Array.isArray(tasks)) return [];
  return tasks.flatMap((task) => {
    if (!task || task.id == null || task.status === "done") return [];
    const assignees = Array.isArray(task.assigneeIds) && task.assigneeIds.length ? task.assigneeIds : task.assigneeId ? [task.assigneeId] : [];
    return assignees.includes(personId) ? [{ id: String(task.id), title: String(task.title ?? ""), dueDate: task.dueDate ?? null }] : [];
  });
}

// Inputs:
//   cases:   the member's own case summaries
//            { id, reference, title, status, step, deadline | deadlineValue,
//              nextDeadline? }
//   ballots: { id, title, closed, voted, closesAt } (open + unvoted ranks)
//   events:  { id, title, startsAt, cancelled?, responded } upcoming events
//   surveys: { id, title, closesAt, closed?, answered } (surveysToAnswer ranks)
//   notices: { id, title, unread } the member's latest notices, newest first
//   tasks:   { id, title, dueDate, done? } open tasks assigned to the person
//   now:     Date
// Returns one item: { kind, urgency, ...facts, action } where action is one of
// open_case | open_task | vote | open_event | answer_survey |
// open_notices | null. The typed union for
// TypeScript callers lives in apps/mobile/src/lib/whatMattersShared.ts.
/**
 * @param {{ cases?: ReadonlyArray<any>, ballots?: ReadonlyArray<any>, events?: ReadonlyArray<any>, surveys?: ReadonlyArray<any>, notices?: ReadonlyArray<any>, tasks?: ReadonlyArray<any>, now?: Date }} [input]
 * @returns {any}
 */
export function rankWhatMattersNow({ cases = [], ballots = [], events = [], surveys = [], notices = [], tasks = [], now = new Date() } = {}) {
  const ownCases = (Array.isArray(cases) ? cases : []).filter((item) => item && item.id != null);

  // 1. Filing deadline within three days, soonest first. An open step
  // deadline that comes first counts, so "nothing is due" never hides it.
  const filing = ownCases
    .filter(caseIsActive)
    .map((item) => ({ item, first: firstDeadline(item) }))
    .map((entry) => ({ ...entry, days: calendarDaysUntil(entry.first.deadline, now, entry.first.timeZone) }))
    .filter(({ days }) => days !== null && days <= FILING_DEADLINE_RISK_DAYS)
    .sort((left, right) => left.days - right.days)[0];
  if (filing) {
    return {
      kind: "filing_deadline",
      urgency: filing.days <= 0 ? "critical" : "warning",
      case: caseSummary(filing.item),
      days: filing.days,
      deadline: filing.first.deadline,
      ...filing.first.step,
      action: { kind: "open_case", caseId: String(filing.item.id) },
    };
  }

  // 2. An issue in progress.
  const active = ownCases.find(caseIsActive);
  if (active) {
    const first = firstDeadline(active);
    return {
      kind: "case_in_progress",
      urgency: "info",
      case: caseSummary(active),
      deadline: first.deadline,
      ...first.step,
      action: { kind: "open_case", caseId: String(active.id) },
    };
  }

  // 3. An open task assigned to the person, overdue or due within the
  // lookahead, soonest first. An undated task has no deadline to meet here.
  const task = (Array.isArray(tasks) ? tasks : [])
    .filter((item) => item && item.id != null && item.done !== true)
    .map((item) => ({ item, deadline: isoDate(item.dueDate), days: calendarDaysUntil(item.dueDate, now) }))
    .filter(({ days }) => days !== null && days <= TASK_LOOKAHEAD_DAYS)
    .sort((left, right) => left.days - right.days)[0];
  if (task) {
    return {
      kind: "assigned_task",
      urgency: task.days < 0 ? "warning" : "info",
      task: { id: String(task.item.id), title: String(task.item.title ?? "") },
      days: task.days,
      deadline: task.deadline,
      action: { kind: "open_task", taskId: String(task.item.id) },
    };
  }

  // 4. An open vote the member has not cast, closing soonest first.
  const vote = (Array.isArray(ballots) ? ballots : [])
    .filter((item) => item && !item.closed && !item.voted)
    .sort((left, right) => (Date.parse(left.closesAt) || Infinity) - (Date.parse(right.closesAt) || Infinity))[0];
  if (vote) {
    return {
      kind: "open_vote",
      urgency: "info",
      ballot: { id: String(vote.id), title: String(vote.title ?? ""), closesAt: vote.closesAt ?? null },
      action: { kind: "vote", ballotId: String(vote.id) },
    };
  }

  // 5. A meeting in the next seven days the member has not answered.
  const nowMs = now.getTime();
  const event = (Array.isArray(events) ? events : [])
    .filter((item) => {
      const at = Date.parse(item?.startsAt);
      return item && !item.cancelled && !item.responded && Number.isFinite(at)
        && at >= nowMs && at <= nowMs + RSVP_HORIZON_DAYS * DAY_MS;
    })
    .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt))[0];
  if (event) {
    return {
      kind: "rsvp",
      urgency: "info",
      event: { id: String(event.id), title: String(event.title ?? ""), startsAt: event.startsAt },
      action: { kind: "open_event", eventId: String(event.id) },
    };
  }

  // 6. An open survey the member has not answered, closing soonest first.
  const survey = surveysToAnswer(surveys, now)[0];
  if (survey) {
    return {
      kind: "open_survey",
      urgency: "info",
      survey: { id: String(survey.id), title: String(survey.title ?? ""), closesAt: survey.closesAt ?? null },
      action: { kind: "answer_survey", surveyId: String(survey.id) },
    };
  }

  // 7. Unread notices, newest first.
  const unread = (Array.isArray(notices) ? notices : []).filter((item) => item && item.id != null && item.unread === true);
  if (unread.length) {
    return {
      kind: "unread_notice",
      urgency: "info",
      notice: { id: String(unread[0].id), title: String(unread[0].title ?? "") },
      unread: unread.length,
      action: { kind: "open_notices" },
    };
  }

  return { kind: "caught_up", urgency: "calm", action: null };
}
