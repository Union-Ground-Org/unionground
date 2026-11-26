// REQ-UG-COMPASS-PAGE-AND-CASE-AWARE-HELP-20261001
//
// Shapes public.get_compass_case_context() output into the facts that may
// reach a provider: an enumerated status, day offsets, closed deadline and event vocabularies, and, only when the
// organization opted in, the case title and notes as the minimizer returns
// them. Anything else in the envelope is ignored. Union Ground issues have
// no grievance step and no legal filing, hearing or appeal deadline, so no
// step label, step event or such deadline kind reaches a provider.
import { minimizeCaseNarrative } from "./compassPrompts.js";

const STATUSES = new Set(["active", "resolved"]);
const DEADLINE_KINDS = new Set(["response", "follow_up"]);
const DEADLINE_STATUSES = new Set(["active", "met", "extended", "waived", "missed"]);
const EVENT_TYPES = new Set(["case_note", "outcome_recorded"]);

function days(value, minimum = -36_500, maximum = 36_500) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function buildCaseFacts(envelope) {
  const data = object(envelope?.data);
  if (!data || !STATUSES.has(data.status)) throw new Error("case-context-invalid");
  const facts = {
    status: data.status,
    openedDaysAgo: days(data.openedDaysAgo, 0),
    lastChangeDaysAgo: days(data.lastChangeDaysAgo, 0),
    caseDeadlineInDays: days(data.caseDeadlineInDays),
    deadlines: (Array.isArray(data.deadlines) ? data.deadlines : []).slice(0, 10).flatMap((row) => (
      object(row) && DEADLINE_KINDS.has(row.kind) && DEADLINE_STATUSES.has(row.status) && days(row.dueInDays) !== null
        ? [{ kind: row.kind, status: row.status, dueInDays: row.dueInDays }]
        : []
    )),
    timeline: (Array.isArray(data.timeline) ? data.timeline : []).slice(0, 12).flatMap((row) => (
      object(row) && EVENT_TYPES.has(row.type) && days(row.daysAgo, 0) !== null ? [{ type: row.type, daysAgo: row.daysAgo }] : []
    )),
  };
  if (envelope.includesNarrative === true) {
    const title = minimizeCaseNarrative(data.title);
    const notes = (Array.isArray(data.notes) ? data.notes : []).slice(0, 3).map(minimizeCaseNarrative).filter(Boolean);
    if (title) facts.title = title;
    if (notes.length) facts.recentNotes = notes;
  }
  return facts;
}
