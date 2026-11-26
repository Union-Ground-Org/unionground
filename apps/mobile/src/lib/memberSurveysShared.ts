// DEBT-UG-MOBILE-MEMBER-PULSES-AND-WEB-VOICE-SURVEYS-ARE-TWO-DISCONNECTED-DATA-MODELS-20260921
// ( THE NATIVE APP READS THE WEB SURVEYS). The native
// app renders the surveys the web engagement studio authors
// (organization_surveys) from the same member snapshot RPC the web Voice
// surface reads, and answers them through the same session RPCs. The answer
// decisions are the web's, imported from the shared model; this file adds the
// TypeScript shape of the snapshot and a tolerant normalizer.
import { nativeUiText } from './nativeUiCopy';

export {
  SURVEY_TEXT_LIMITS,
  isAnswerEmpty,
  missingRequiredQuestions,
  optionLabel,
  optionValue,
  pruneHiddenAnswers,
  surveyChoices,
  surveySessionStatus,
  toggleSelection,
  visibleQuestions,
  withAnswer,
} from '../../../../src/features/engagement/surveyModel.js';

export type SurveyAnswer = string | number | boolean | Array<string | number>;
export type SurveyAnswers = Record<string, SurveyAnswer>;

export type SurveyQuestion = {
  id: string;
  sortIndex: number;
  type: 'text' | 'paragraph' | 'radio' | 'dropdown' | 'checkbox' | 'yes_no' | 'scale' | 'rating' | string;
  label: string;
  required: boolean;
  options: unknown[];
  sectionKey: string | null;
  sectionTitle: string | null;
  branchParentId: string | null;
  branchValue: string | null;
  scaleMinLabel: string | null;
  scaleMaxLabel: string | null;
  maxSelections: number | null;
};

export type MemberSurvey = {
  id: string;
  title: string;
  description: string;
  cadence: string;
  periodKey: string | null;
  opensAt: string | null;
  closesAt: string | null;
  session: { id: string; status: string; updatedAt: string | null; submittedAt: string | null; answers: SurveyAnswers } | null;
  questions: SurveyQuestion[];
};

export type QuarterlyGate = {
  periodKey: string | null;
  surveyId: string | null;
  required: boolean;
  completed: boolean;
  unlocked: boolean;
};

export type MemberSurveySnapshot = { surveys: MemberSurvey[]; quarterlyGate: QuarterlyGate };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function nullableText(value: unknown): string | null {
  return value == null ? null : text(value);
}

function answers(value: unknown): SurveyAnswers {
  const out: SurveyAnswers = {};
  for (const [key, answer] of Object.entries(record(value))) {
    if (typeof answer === 'string' || typeof answer === 'number' || typeof answer === 'boolean') out[key] = answer;
    else if (Array.isArray(answer)) out[key] = answer.filter((item): item is string | number => typeof item === 'string' || typeof item === 'number');
  }
  return out;
}

function question(value: unknown): SurveyQuestion | null {
  const row = record(value);
  if (!row.id || !row.type) return null;
  return {
    id: text(row.id),
    sortIndex: typeof row.sortIndex === 'number' ? row.sortIndex : 0,
    type: text(row.type),
    label: text(row.label),
    required: row.required === true,
    options: Array.isArray(row.options) ? row.options : [],
    sectionKey: nullableText(row.sectionKey),
    sectionTitle: nullableText(row.sectionTitle),
    branchParentId: nullableText(row.branchParentId),
    branchValue: nullableText(row.branchValue),
    scaleMinLabel: nullableText(row.scaleMinLabel),
    scaleMaxLabel: nullableText(row.scaleMaxLabel),
    maxSelections: typeof row.maxSelections === 'number' ? row.maxSelections : null,
  };
}

function survey(value: unknown): MemberSurvey | null {
  const row = record(value);
  if (!row.id || !row.title) return null;
  const session = row.session ? record(row.session) : null;
  return {
    id: text(row.id),
    title: text(row.title),
    description: text(row.description),
    cadence: text(row.cadence || 'one_off'),
    periodKey: nullableText(row.periodKey),
    opensAt: nullableText(row.opensAt),
    closesAt: nullableText(row.closesAt),
    session: session && session.id ? {
      id: text(session.id),
      status: text(session.status || 'in_progress'),
      updatedAt: nullableText(session.updatedAt),
      submittedAt: nullableText(session.submittedAt),
      answers: answers(session.answers),
    } : null,
    questions: (Array.isArray(row.questions) ? row.questions : []).map(question).filter((item): item is SurveyQuestion => item !== null)
      .sort((a, b) => a.sortIndex - b.sortIndex),
  };
}

// The quarterly gate as get_quarterly_survey_gate() returns it, alone or inside
// the member engagement snapshot. Anything unreadable is unlocked: the gate
// fails open, as the server does.
export function normalizeQuarterlyGate(value: unknown): QuarterlyGate {
  const gate = record(value);
  return {
    periodKey: nullableText(gate.periodKey),
    surveyId: nullableText(gate.surveyId),
    required: gate.required === true,
    completed: gate.completed === true,
    unlocked: gate.unlocked !== false,
  };
}

// REQ-UG-QUARTERLY-SURVEY-GATE-ENFORCED-20261001 ("give to view"): the
// page dims only when the server says it is locked AND names the survey that
// unlocks it, so the banner always has somewhere to send the member.
export function gateLocksPage(gate: QuarterlyGate | null | undefined): boolean {
  return Boolean(gate && gate.unlocked === false && gate.surveyId);
}

// REQ-UG-QUARTERLY-SURVEY-GATE-SERVER-ENFORCED-20261002 (owner decision
// D6): the gate is hard. Only an explicit server unlock opens the page; an
// explicit lock that names the survey locks it; anything else (an empty or
// malformed answer) is a failed check, treated as locked with a retry.
export type QuarterlyGateStatus = 'open' | 'locked' | 'error';

export function classifyQuarterlyGate(value: unknown): { status: QuarterlyGateStatus; gate: QuarterlyGate | null } {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!raw) return { status: 'error', gate: null };
  const gate = normalizeQuarterlyGate(raw);
  if (raw.unlocked === true) return { status: 'open', gate };
  if (raw.unlocked === false && gate.surveyId) return { status: 'locked', gate };
  return { status: 'error', gate: null };
}

// A gate answer belongs to the context it was read for: the account, the
// selected organization and the screen visit. Each regained focus and each
// session-mode change is a new visit, so the screen re-reads the gate and
// shows its gated content only on an answer read for the current visit, never
// on an earlier organization's, account's or visit's answer.
export type QuarterlyGateVisit = { focused: boolean; mode: string; count: number };
export type QuarterlyGateCheck = { key: string; status: QuarterlyGateStatus; gate: QuarterlyGate | null };

export function nextQuarterlyGateVisit(visit: QuarterlyGateVisit, focused: boolean, mode: string): QuarterlyGateVisit {
  if (visit.focused === focused && visit.mode === mode) return visit;
  const newVisit = (focused && !visit.focused) || visit.mode !== mode;
  return { focused, mode, count: newVisit ? visit.count + 1 : visit.count };
}

export function quarterlyGateContextKey(userID: string | null | undefined, organizationID: string | null | undefined, visit: QuarterlyGateVisit): string {
  return JSON.stringify([userID ?? null, organizationID ?? null, visit.count]);
}

export function quarterlyGateStatusFor(check: QuarterlyGateCheck | null, key: string): QuarterlyGateStatus | 'checking' {
  return check && check.key === key ? check.status : 'checking';
}

export function quarterLabel(periodKey: string | null | undefined, t = nativeUiText('en')): string {
  const match = /^(\d{4})-Q([1-4])$/.exec(String(periodKey ?? ''));
  return match?.[1] && match[2] ? t('Q{quarter} {year}', { year: match[1], quarter: match[2] }) : '';
}

// Reads the member engagement snapshot the web Voice surface reads. Unknown
// shapes degrade to an empty list, never to a thrown render.
export function normalizeMemberSurveySnapshot(value: unknown): MemberSurveySnapshot {
  const snapshot = record(value);
  return {
    surveys: (Array.isArray(snapshot.surveys) ? snapshot.surveys : []).map(survey).filter((item): item is MemberSurvey => item !== null),
    quarterlyGate: normalizeQuarterlyGate(snapshot.quarterlyGate),
  };
}

export function surveyKicker(item: MemberSurvey): string {
  return item.cadence === 'quarterly' ? (item.periodKey || 'Quarterly survey') : 'Worker survey';
}
