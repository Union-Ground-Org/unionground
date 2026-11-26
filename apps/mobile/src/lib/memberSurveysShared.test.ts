import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyQuarterlyGate, gateLocksPage, missingRequiredQuestions, nextQuarterlyGateVisit, normalizeMemberSurveySnapshot, normalizeQuarterlyGate, quarterLabel,
  quarterlyGateContextKey, quarterlyGateStatusFor, surveyChoices, surveyKicker, surveySessionStatus, visibleQuestions,
  type QuarterlyGateCheck, type QuarterlyGateVisit,
} from './memberSurveysShared';

// DEBT-UG-MOBILE-MEMBER-PULSES-AND-WEB-VOICE-SURVEYS-ARE-TWO-DISCONNECTED-DATA-MODELS-20260921
//: the native app reads organization_surveys through
// the web member snapshot and answers through the web session RPCs, on the
// web's own answer model.
const snapshot = {
  quarterlyGate: { periodKey: '2026-Q3', surveyId: 's-q', required: true, completed: false, unlocked: false },
  surveys: [
    {
      id: 's-q', title: 'Quarterly voice', description: 'Tell us what is working.', cadence: 'quarterly', periodKey: '2026-Q3',
      opensAt: null, closesAt: '2026-10-01T00:00:00Z', session: { id: 'sess', status: 'in_progress', updatedAt: null, submittedAt: null, answers: { q1: 'yes', q2: ['pay'], junk: { nested: true } } },
      questions: [
        { id: 'q2', sortIndex: 2, type: 'checkbox', label: 'Topics', required: false, options: ['pay', { value: 'safety', label: 'Safety' }], maxSelections: 2, branchParentId: 'q1', branchValue: 'yes' },
        { id: 'q1', sortIndex: 1, type: 'yes_no', label: 'Attend?', required: true, options: [] },
        { type: 'text' },
      ],
    },
    { id: 's-done', title: 'Completed survey', cadence: 'one_off', session: { id: 'd', status: 'submitted', answers: {} }, questions: [] },
    { title: 'no id' },
  ],
};

describe('native worker surveys share the web model', () => {
  it('normalizes the worker engagement snapshot tolerantly and sorts questions', () => {
    const value = normalizeMemberSurveySnapshot(snapshot);
    expect(value.quarterlyGate).toEqual({ periodKey: '2026-Q3', surveyId: 's-q', required: true, completed: false, unlocked: false });
    expect(value.surveys.map((item) => item.id)).toEqual(['s-q', 's-done']);
    const quarterly = value.surveys[0]!;
    expect(quarterly.questions.map((question) => question.id)).toEqual(['q1', 'q2']);
    expect(quarterly.session?.answers).toEqual({ q1: 'yes', q2: ['pay'] });
    expect(surveyKicker(quarterly)).toBe('2026-Q3');
    expect(surveyKicker(value.surveys[1]!)).toBe('Worker survey');
    expect(surveySessionStatus(quarterly)).toBe('in_progress');
    expect(surveySessionStatus(value.surveys[1]!)).toBe('submitted');
    expect(normalizeMemberSurveySnapshot(null)).toEqual({ surveys: [], quarterlyGate: { periodKey: null, surveyId: null, required: false, completed: false, unlocked: true } });
  });

  it('applies the web branch, choice and required rules', () => {
    const quarterly = normalizeMemberSurveySnapshot(snapshot).surveys[0]!;
    expect(visibleQuestions(quarterly, {}).map((question: { id: string }) => question.id)).toEqual(['q1']);
    expect(visibleQuestions(quarterly, { q1: 'yes' }).map((question: { id: string }) => question.id)).toEqual(['q1', 'q2']);
    expect(surveyChoices(quarterly.questions[0]!)).toEqual([{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]);
    expect(missingRequiredQuestions(quarterly, {}).map((question: { id: string }) => question.id)).toEqual(['q1']);
    expect(missingRequiredQuestions(quarterly, { q1: 'no' })).toEqual([]);
  });

  it('reads and answers organization_surveys through the web RPCs and retires the member_surveys pulse path', () => {
    const shared = readFileSync(new URL('./memberSurveysShared.ts', import.meta.url), 'utf8');
    const service = readFileSync(new URL('../services/memberSurveys.ts', import.meta.url), 'utf8');
    const livedIn = readFileSync(new URL('../services/livedIn.ts', import.meta.url), 'utf8');
    const screens = readFileSync(new URL('../features/LiveLivedInScreens.tsx', import.meta.url), 'utf8');
    const feature = readFileSync(new URL('../features/FeatureScreen.tsx', import.meta.url), 'utf8');
    expect(shared).toContain("from '../../../../src/features/engagement/surveyModel.js';");
    expect(service).toContain("snapshot: 'get_member_engagement_snapshot'");
    expect(service).toContain("save: 'save_organization_survey_session'");
    expect(service).toContain("submit: 'submit_organization_survey_session'");
    expect(service).not.toMatch(/service[_-]?role/i);
    for (const legacy of ['member_surveys', 'member_survey_options', 'member_survey_responses', 'submit_survey_response', 'LivedInSurvey', 'loadMobileSurveys', 'submitMobileSurveyResponse']) {
      expect(livedIn, legacy).not.toContain(legacy);
      expect(screens, legacy).not.toContain(legacy);
    }
    expect(screens).toContain('loadMobileMemberSurveys');
    expect(screens).toContain('<Heading level={2}>Your surveys</Heading>');
    // Review threads on: refreshes keep every card mounted, hidden
    // descendants are pruned before save/submit, and the quarterly notice
    // needs its survey to be open to this member.
    expect(screens).toContain('if (reload === 0) setSnapshot(null);');
    expect(screens).toContain('pruneHiddenAnswers(survey, answers) as SurveyAnswers');
    expect(screens).toContain('{gate?.required && !gate.completed && gateSurveyOpen ? <Card>');
    expect(screens).not.toContain('Worker pulses');
    expect(feature).toContain('<LiveSurveyHistory />');
  });
});

// REQ-UG-QUARTERLY-SURVEY-GATE-ENFORCED-20261001 (CR-002, "give to view").
describe('native quarterly survey gate', () => {
  it('normalizes the standalone gate and locks only on an explicit server lock naming the survey', () => {
    const locked = normalizeQuarterlyGate({ periodKey: '2026-Q4', surveyId: 's-q4', required: true, completed: false, unlocked: false, reason: 'incomplete' });
    expect(locked).toEqual({ periodKey: '2026-Q4', surveyId: 's-q4', required: true, completed: false, unlocked: false });
    expect(gateLocksPage(locked)).toBe(true);
    expect(gateLocksPage({ ...locked, unlocked: true })).toBe(false);
    expect(gateLocksPage({ ...locked, surveyId: null })).toBe(false);
    expect(gateLocksPage(normalizeQuarterlyGate(null))).toBe(false);
    expect(gateLocksPage(normalizeQuarterlyGate('garbage'))).toBe(false);
    expect(gateLocksPage(null)).toBe(false);
    expect(quarterLabel('2026-Q4')).toBe('Q4 2026');
    expect(quarterLabel('Q4')).toBe('');
  });

  it('reads the same server gate as the web and wraps reports, workload and analytics', () => {
    const service = readFileSync(new URL('../services/memberSurveys.ts', import.meta.url), 'utf8');
    const gate = readFileSync(new URL('../components/QuarterlySurveyGate.tsx', import.meta.url), 'utf8');
    const screens = readFileSync(new URL('../features/LiveLivedInScreens.tsx', import.meta.url), 'utf8');
    const analytics = readFileSync(new URL('../features/mi1/AnalyticsCoreScreen.tsx', import.meta.url), 'utf8');
    expect(service).toContain("quarterlyGate: 'get_quarterly_survey_gate'");
    expect(gate).toContain("if (mode !== 'authenticated' || !focused) return undefined;");
    expect(gate).toContain("label={t('Take the survey')} onPress={() => router.push('/feature/voting' as never)}");
    expect(screens.match(/<QuarterlySurveyGate>/g)).toHaveLength(2);
    expect(analytics).toContain('<QuarterlySurveyGate>');
  });

  // REQ-UG-QUARTERLY-SURVEY-GATE-SERVER-ENFORCED-20261002.
  it('opens only on an explicit unlock and treats an empty or malformed answer as a failed check', () => {
    const locked = { periodKey: '2026-Q4', surveyId: 's-q4', required: true, completed: false, unlocked: false, reason: 'incomplete' };
    expect(classifyQuarterlyGate(locked)).toMatchObject({ status: 'locked', gate: { surveyId: 's-q4' } });
    expect(classifyQuarterlyGate({ ...locked, unlocked: true, reason: 'completed' })).toMatchObject({ status: 'open' });
    expect(classifyQuarterlyGate({ periodKey: '2026-Q4', surveyId: null, unlocked: true, reason: 'no_survey' })).toMatchObject({ status: 'open' });
    for (const value of [null, 'garbage', [], {}, { unlocked: false }, { ...locked, unlocked: undefined }]) {
      expect(classifyQuarterlyGate(value), JSON.stringify(value)).toEqual({ status: 'error', gate: null });
    }
  });

  it('renders the gated content only when open, and offers a retry after a failed check', () => {
    const gate = readFileSync(new URL('../components/QuarterlySurveyGate.tsx', import.meta.url), 'utf8');
    const service = readFileSync(new URL('../services/memberSurveys.ts', import.meta.url), 'utf8');
    expect(service).toContain('return classifyQuarterlyGate(await rpc(MEMBER_SURVEY_RPC_NAMES.quarterlyGate));');
    expect(gate).toContain('void loadMobileQuarterlySurveyGateStatus()');
    expect(gate).toContain("if (mode !== 'authenticated' || status === 'open') {");
    expect(gate.match(/\{children\}/g)).toHaveLength(1);
    expect(gate).toContain("setCheck({ key, status: 'error', gate: null });");
    expect(gate).toContain("label={t('Try again')} variant=\"secondary\" onPress={() => setAttempt((count) => count + 1)}");
  });

  it('shows the content only on an answer read for the current account, organization and visit', () => {
    const start: QuarterlyGateVisit = { focused: true, mode: 'authenticated', count: 0 };
    const key = quarterlyGateContextKey('user-1', 'org-a', start);
    const open: QuarterlyGateCheck = { key, status: 'open', gate: null };
    expect(quarterlyGateStatusFor(open, key)).toBe('open');
    expect(quarterlyGateStatusFor({ ...open, status: 'locked' }, key)).toBe('locked');
    expect(quarterlyGateStatusFor(null, key)).toBe('checking');
    // Another organization or account: organization A's unlock does not carry.
    expect(quarterlyGateStatusFor(open, quarterlyGateContextKey('user-1', 'org-b', start))).toBe('checking');
    expect(quarterlyGateStatusFor(open, quarterlyGateContextKey('user-2', 'org-a', start))).toBe('checking');
    expect(quarterlyGateStatusFor(open, quarterlyGateContextKey(null, null, start))).toBe('checking');
    // Leaving the screen keeps the visit; coming back starts a new one, so the
    // first focused render is checking until the gate is read again.
    const blurred = nextQuarterlyGateVisit(start, false, 'authenticated');
    expect(blurred).toEqual({ focused: false, mode: 'authenticated', count: 0 });
    expect(quarterlyGateStatusFor(open, quarterlyGateContextKey('user-1', 'org-a', blurred))).toBe('open');
    const refocused = nextQuarterlyGateVisit(blurred, true, 'authenticated');
    expect(refocused.count).toBe(1);
    expect(quarterlyGateStatusFor(open, quarterlyGateContextKey('user-1', 'org-a', refocused))).toBe('checking');
    // A session-mode change is a new visit too; an unchanged one is the same object.
    expect(nextQuarterlyGateVisit(start, true, 'locked').count).toBe(1);
    expect(nextQuarterlyGateVisit(start, true, 'authenticated')).toBe(start);
  });

  it('keys every stored answer to its context and adjusts the visit during render', () => {
    const gate = readFileSync(new URL('../components/QuarterlySurveyGate.tsx', import.meta.url), 'utf8');
    expect(gate).toContain('if (nextVisit !== visit) setVisit(nextVisit);');
    expect(gate).toContain('const key = quarterlyGateContextKey(session?.user.id, organizationID, nextVisit);');
    expect(gate).toContain('setCheck({ key, status: next.status, gate: next.gate });');
    expect(gate).toContain('const status = quarterlyGateStatusFor(check, key);');
    expect(gate).toContain('}, [attempt, focused, key, mode]);');
    // No post-paint reset that leaves the previous answer on screen.
    expect(gate).not.toContain("setStatus('checking');");
  });
});
