// Typed seam over the shared "What matters for you now" ranking
// (REQ-UG-MEMBER-WHAT-MATTERS-NOW-20261001). The web module is the single
// implementation; native screens import it from here.
import {
  TASK_LOOKAHEAD_DAYS as SHARED_TASK_LOOKAHEAD_DAYS,
  WHAT_MATTERS_SWITCH as SHARED_SWITCH,
  assignedTasksOf as sharedAssignedTasksOf,
  calendarDaysUntil as sharedCalendarDaysUntil,
  rankWhatMattersNow as sharedRank,
  surveysToAnswer as sharedSurveysToAnswer,
} from '../../../../src/features/memberHome/whatMattersNow.js';
import {
  OPEN_STEP_DEADLINE_STATUSES as SHARED_OPEN_STEP_DEADLINE_STATUSES,
  caseDeadlinePhrase as sharedCaseDeadlinePhrase,
  withNextDeadlines as sharedWithNextDeadlines,
} from '../../../../src/lib/caseNextDeadline.js';
import { normalizeMemberSurveySnapshot } from './memberSurveysShared';

// BUG-UG-CASE-DEADLINE-MEMBER-AND-STAFF-READ-DIFFERENT-DATES-20261110:
// the deadline a case runs to first (src/lib/caseNextDeadline.js, the rule
// staff What to do next ranks on): an open step deadline before the case's own
// deadline, labeled, else the case's own deadline.
// Its days are counted on timeZone, the zone that deadline was set in (#9446).
export type CaseNextDeadline = { kind: 'step' | 'case'; label: string | null; dueOn: string; missed: boolean; timeZone: string };
export type StepDeadlineRow = { case_id: string; id: string; label: string; due_at: string; status: string; time_zone?: string | null };

export const OPEN_STEP_DEADLINE_STATUSES: readonly string[] = SHARED_OPEN_STEP_DEADLINE_STATUSES;

export function withNextDeadlines<T extends { id: string; deadline: string | null }>(cases: readonly T[], rows: readonly StepDeadlineRow[]): Array<T & { nextDeadline: CaseNextDeadline | null }> {
  const merged: Array<T & { nextDeadline: CaseNextDeadline | null }> = sharedWithNextDeadlines(cases, rows);
  return merged;
}

// The web catalogue's English caseSignals.deadline.* wording, so the native
// line reads exactly what staff What to do next shows. Native is English-only.
const DEADLINE_EN: Record<string, string> = {
  'caseSignals.deadline.step': '{label} deadline',
  'caseSignals.deadline.stepFallback': 'Step',
  'caseSignals.deadline.case': 'issue deadline',
  'caseSignals.deadline.phrase': '{name} {when} ({date})',
  'caseSignals.deadline.phraseUndated': '{name} ({date})',
  'caseSignals.deadline.passedOne': 'passed 1 day ago',
  'caseSignals.deadline.passed': 'passed {count} days ago',
  'caseSignals.deadline.today': 'today',
  'caseSignals.deadline.inOne': 'in 1 day',
  'caseSignals.deadline.inDays': 'in {count} days',
  'caseSignals.deadline.unnamed': 'deadline',
};
export const CASE_DEADLINE_COPY_EN: Readonly<Record<string, string>> = DEADLINE_EN;

function deadlineEn(key: string, vars: Record<string, unknown> = {}): string {
  return (DEADLINE_EN[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''));
}

export function caseDeadlinePhraseEn(input: { kind: 'step' | 'case'; label: string | null; days: number | null; dueOn: string }): string {
  const phrase: string = sharedCaseDeadlinePhrase(deadlineEn, input, 'en');
  return phrase;
}

export type WhatMattersCase = {
  id: string;
  reference?: string | null;
  title?: string | null;
  status?: string | null;
  step?: string | null;
  deadline?: string | null;
  // No ULP deadline or retaliation flag: Union Ground leaves legal
  // deadlines out, and the shared ranker no
  // longer has those rules.
  nextDeadline?: CaseNextDeadline | null;
};

export type WhatMattersBallot = { id: string; title: string; closed: boolean; voted: boolean; closesAt: string | null };
export type WhatMattersEvent = { id: string; title: string; startsAt: string; cancelled: boolean; responded: boolean };
export type WhatMattersSurvey = { id: string; title: string; closesAt: string | null; closed?: boolean; answered: boolean };
export type WhatMattersNotice = { id: string; title: string; unread: boolean };
// An open chapter task assigned to the person (primary or co-assignee).
export type WhatMattersTask = { id: string; title: string; dueDate: string | null; done?: boolean };

export type WhatMattersCaseSummary = { id: string; reference: string | null; title: string; step: string | null };

export type WhatMattersItem =
  | { kind: 'filing_deadline'; urgency: 'critical' | 'warning'; case: WhatMattersCaseSummary; days: number; deadline: string | null; deadlineKind?: 'step'; deadlineLabel?: string; action: { kind: 'open_case'; caseId: string } }
  | { kind: 'case_in_progress'; urgency: 'info'; case: WhatMattersCaseSummary; deadline: string | null; deadlineKind?: 'step'; deadlineLabel?: string; action: { kind: 'open_case'; caseId: string } }
  | { kind: 'assigned_task'; urgency: 'warning' | 'info'; task: { id: string; title: string }; days: number; deadline: string | null; action: { kind: 'open_task'; taskId: string } }
  | { kind: 'open_vote'; urgency: 'info'; ballot: { id: string; title: string; closesAt: string | null }; action: { kind: 'vote'; ballotId: string } }
  | { kind: 'rsvp'; urgency: 'info'; event: { id: string; title: string; startsAt: string }; action: { kind: 'open_event'; eventId: string } }
  | { kind: 'open_survey'; urgency: 'info'; survey: { id: string; title: string; closesAt: string | null }; action: { kind: 'answer_survey'; surveyId: string } }
  | { kind: 'unread_notice'; urgency: 'info'; notice: { id: string; title: string }; unread: number; action: { kind: 'open_notices' } }
  | { kind: 'caught_up'; urgency: 'calm'; action: null };

export const WHAT_MATTERS_SWITCH: string = SHARED_SWITCH;
export const TASK_LOOKAHEAD_DAYS: number = SHARED_TASK_LOOKAHEAD_DAYS;

// The open tasks assigned to one person, in the ranking's input shape.
export function assignedTasksOf(tasks: readonly { id: string; title: string; status: string; dueDate: string | null; assigneeId?: string | null; assigneeIds?: readonly string[] }[], personId: string | null): WhatMattersTask[] {
  const assigned: WhatMattersTask[] = sharedAssignedTasksOf(tasks, personId);
  return assigned;
}

export function rankWhatMattersNow(input: {
  cases: readonly WhatMattersCase[];
  ballots: readonly WhatMattersBallot[];
  events: readonly WhatMattersEvent[];
  surveys?: readonly WhatMattersSurvey[];
  notices?: readonly WhatMattersNotice[];
  tasks?: readonly WhatMattersTask[];
  now: Date;
}): WhatMattersItem {
  const item: WhatMattersItem = sharedRank(input);
  return item;
}

// The member engagement snapshot's surveys in the ranking's input shape.
export function whatMattersSurveys(snapshot: unknown): WhatMattersSurvey[] {
  return normalizeMemberSurveySnapshot(snapshot).surveys.map((row) => ({
    id: row.id, title: row.title, closesAt: row.closesAt, answered: row.session?.status === 'submitted',
  }));
}

// Open, unanswered surveys whose answer deadline has not passed, soonest first.
export function surveysToAnswer<T extends WhatMattersSurvey>(surveys: readonly T[], now: Date): T[] {
  const open: T[] = sharedSurveysToAnswer(surveys, now);
  return open;
}

// Whole calendar days to a YYYY-MM-DD date (0 today, negative past), counted
// in the zone the deadline was set in when one is given (#9446), else on the
// Eastern calendar.
export function calendarDaysUntil(dateValue: string | null | undefined, now: Date, zone: string | null = null): number | null {
  const days: number | null = sharedCalendarDaysUntil(dateValue, now, zone);
  return days;
}
