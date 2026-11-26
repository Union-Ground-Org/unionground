// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubSessionWriter } from '../testing/stubSessionWriter';
import { stubPlainRequire } from '../testing/plainRequire';
import { exposedNames, getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import {
  boot, leaveChapter, leaveOrganization, mfa, otherAccount, refuseRead, restore, signIn, signOut, unconfirmReads, type StaffKind,
} from '../testing/retainedDraftHarness';

//  pull request D (design R-9240D, row D): the workload entry, the unit
// configuration editor and the survey answers keep unsent work through a
// foreground session check on the shared draft hook (src/lib/retainedDraft.ts),
// as the learning editor does (learning/learningEditorResume.screen.test.tsx).
// The host unmounts each screen through the check, as FeatureScreen's
// dashboard gate does, so every return is a remount with fresh reads. Each
// case runs on iPhone and Android; the organization's workload form and the
// survey also run for a chapterless officer.

type Raw = Record<string, unknown>;
type Platform = 'ios' | 'android';
// A named move of the session check: the case label and the harness transition.
type Move = [string, () => void];
type MemberSurveysModule = typeof import('../lib/memberSurveysShared');
type Gate = { promise: Promise<void>; open: () => void };
const gates: Gate[] = [];
const gate = (): Gate => {
  let open!: () => void;
  const promise = new Promise<void>((done) => { open = done; });
  const made: Gate = { promise, open };
  gates.push(made);
  return made;
};

const server = vi.hoisted(() => ({
  units: [] as { id: string; name: string }[],
  legacy: false,
  // The unit's form: its version and settings revision are the entry's basis.
  formVersion: 1,
  settingsRevision: 'revision-1',
  organizationVersion: 0,
  chapterVersion: 1,
  unitVersion: 1,
  chapterOverrides: {} as Raw,
  unitOverrides: {} as Raw,
  surveyAnswers: null as Raw | null,
  surveySubmitted: false,
  readGate: null as Promise<void> | null,
  writeGate: null as Promise<void> | null,
  refuseNextRead: false,
  // Only the organization form's read is refused, once.
  refuseForm: false,
  failNext: null as unknown,
  workloadWrites: [] as Raw[],
  settingsWrites: [] as Raw[],
  surveyWrites: [] as Raw[],
  attempts: 0,
}));

const refusal = () => Object.assign(new Error('permission denied'), { code: '42501' });
const read = async () => {
  if (server.readGate) await server.readGate;
  if (server.refuseNextRead) { server.refuseNextRead = false; throw refusal(); }
};
const write = async () => {
  if (server.writeGate) await server.writeGate;
  if (server.failNext) { const error = server.failNext; server.failNext = null; throw error; }
};

vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../components/ui', () => import('../testing/uiStandIn'));
vi.mock('../state/AppProvider', async () => (await import('../testing/retainedDraftHarness')).appProviderStandIn);
vi.mock('expo-router', () => ({ useIsFocused: () => true, useNavigation: () => ({ setOptions: () => {} }), useRouter: () => ({ push: vi.fn() }) }));
// Attempt keys only need to differ from each other.
vi.mock('expo-crypto', () => ({ randomUUID: () => { server.attempts += 1; return `attempt-${server.attempts}`; } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined), deleteItemAsync: vi.fn(async () => undefined) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('../lib/screenBack', () => ({ useScreenBackInterceptor: () => {} }));
vi.mock('./TaskDocumentHandoffProvider', () => ({ useTaskDocumentHandoff: () => ({ active: false, pending: null }) }));
vi.mock('./WorkFilterPresetsCard', () => ({ WorkFilterButton: () => null, WorkFilterPresetsCard: () => null }));
vi.mock('./guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null, NativeCoachMark: () => null, NativeOrgStartGuide: () => null }));
vi.mock('./RightsResumeReading', () => ({ ContinueReadingCard: () => null, RightsReadingSections: () => null, rightsBookmarks: {}, useRightsBookmark: () => null, useRightsReadingScope: () => null }));
vi.mock('../components/WorkflowActions', () => ({ WorkflowActions: () => null }));
vi.mock('../components/AskCompassButton', () => ({ AskCompassButton: () => null }));
vi.mock('../components/AttachmentPanel', () => ({ AttachmentPanel: () => null }));
vi.mock('../components/QuarterlySurveyGate', () => ({ QuarterlySurveyGate: () => null }));
vi.mock('./ContextualPulseCard', () => ({ ContextualPulseCard: () => null, useNativeContextualPulse: () => null }));
vi.mock('./learning/LearningContentManager', () => ({ LearningContentManager: () => null }));
vi.mock('./learning/LearningLibrarySection', () => ({ LearningLibrarySection: () => null }));
vi.mock('./CaseRowTopicCards', () => ({ ChapterCaseRowTopicCard: () => null }));
vi.mock('../lib/connectedWorkflows', () => ({ connectedWorkflowApi: () => null }));
vi.mock('../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => vi.fn(), queueAccessibilityAnnouncement: vi.fn() }));
vi.mock('../services/haptics', () => ({ haptics: { success: vi.fn(async () => undefined), select: vi.fn(), warning: vi.fn() } }));
vi.mock('../services/supabase', () => ({
  captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => ({}), session?.user?.id ?? 'nobody'),
  getSupabaseClient: () => null,
  loadMobileMemberReportCard: vi.fn(),
}));
vi.mock('../services/nativeCalendarExport', () => ({ calendarExportWasSaved: () => false, exportToDeviceCalendar: vi.fn(), isCalendarExportAvailable: () => false }));
// The Mobile CI job installs only apps/mobile; this report-card helper reaches
// root web modules and is not on these screens' path.
vi.mock('../lib/mi1AnalyticsShared', () => ({ normalizeMemberReportCard: () => null }));
vi.mock('../services/livedIn', () => ({}));

// The unit, organization and survey RPCs, answered as the server answers them:
// unit settings saves are version-guarded, a workload save inserts a new entry
// with no key, and a survey save replaces the person's own session.
vi.mock('../services/unitSettings', async () => {
  const harness = await import('../testing/retainedDraftHarness');
  const app = harness.harnessApp;
  const field = { key: 'cases', label: 'Issues', kind: 'category', type: 'number', visible: true, required: false, retired: false, summary: 'sum', unit: '', options: [] as string[] };
  const definition = (title: string) => ({ title, period: 'week', statuses: ['logged'], fields: [field] });
  const base = { workload: [{ key: 'cases', label: 'Issues', visible: true }], forms: ['grievance'], templates: [] as string[], capabilities: {} };
  const place = () => ({ actorId: app().dashboard?.member.id ?? 'nobody', chapterId: app().dashboard?.member.chapterID ?? null, organizationId: app().organizationID ?? 'none' });
  const context = (selected: string | null) => {
    const unitId = selected ?? (server.units.length === 1 ? server.units[0]!.id : null);
    return { ...place(), legacy: server.legacy, units: server.units, unitId, needsChoice: !unitId, canManage: true,
      effective: unitId ? { ...base, configuration: { ...place(), unitId, unitName: unitId, version: server.formVersion, settingsRevision: server.settingsRevision, definition: definition(`Workload for ${unitId}`) } } : null };
  };
  const workspace = (unitId: string | null) => ({ actorId: place().actorId, chapterId: place().chapterId, units: server.units, unitId, canSetChapter: true,
    defaults: base, organizationDefaults: base, chapterOverrides: server.chapterOverrides, effective: base, overrides: server.unitOverrides, allowed: { forms: true },
    chapterVersion: server.chapterVersion, unitVersion: server.unitVersion, formChoices: [{ key: 'grievance', labelEn: 'Grievance', labelEs: 'Queja' }], templateChoices: [], audit: [] });
  const conflict = () => Object.assign(new Error('version changed'), { code: '40001' });
  return {
    loadNativeUnitSettings: async (selected: string | null = null) => { await read(); return context(selected); },
    loadNativeUnitEditor: async (_chapter: string, unitId: string | null) => { await read(); return workspace(unitId); },
    loadNativeOrganizationWorkload: async () => {
      await read();
      if (server.refuseForm) { server.refuseForm = false; throw refusal(); }
      return { organizationId: app().organizationID, version: server.organizationVersion, definition: definition('Workplace log') }; },
    saveNativeUnitWorkload: async (_writer: unknown, unit: { unitId: string | null; effective: { configuration: { version: number; settingsRevision: string } } }, values: Raw, status: string) => {
      server.workloadWrites.push({ unit: unit.unitId, version: unit.effective.configuration.version, values, status });
      await write();
    },
    saveNativeOrganizationWorkload: async (_writer: unknown, form: { version: number }, values: Raw, status: string) => {
      server.workloadWrites.push({ unit: null, version: form.version, values, status });
      await write();
    },
    saveNativeChapterUnitSettings: async (_writer: unknown, current: { chapterVersion: number }, values: Raw, allowed: Raw) => {
      server.settingsWrites.push({ unit: null, expected: current.chapterVersion, values, allowed });
      await write();
      if (current.chapterVersion !== server.chapterVersion) throw conflict();
      server.chapterOverrides = values; server.chapterVersion += 1;
      return workspace(null);
    },
    saveNativeUnitOverrides: async (_writer: unknown, current: { unitId: string | null; unitVersion: number }, values: Raw) => {
      server.settingsWrites.push({ unit: current.unitId, expected: current.unitVersion, values });
      await write();
      if (current.unitVersion !== server.unitVersion) throw conflict();
      server.unitOverrides = values; server.unitVersion += 1;
      return workspace(current.unitId);
    },
  };
});
vi.mock('../services/memberSurveys', async () => {
  const { normalizeMemberSurveySnapshot } = await vi.importActual<MemberSurveysModule>('../lib/memberSurveysShared');
  const session = () => server.surveyAnswers === null ? null
    : { id: 'session-1', status: server.surveySubmitted ? 'submitted' : 'in_progress', updatedAt: null, submittedAt: null, answers: server.surveyAnswers };
  return {
    loadMobileMemberSurveys: async () => {
      await read();
      return normalizeMemberSurveySnapshot({ quarterlyGate: null, surveys: [{ id: 'survey-1', title: 'Shift survey', description: null, cadence: 'one_off', periodKey: null,
        opensAt: null, closesAt: null, session: session(), questions: [{ id: 'q1', sortIndex: 1, type: 'text', label: 'Your idea', required: false, options: [] }] }] });
    },
    saveMobileSurveySession: async (_writer: unknown, surveyID: string, answers: Raw) => {
      server.surveyWrites.push({ kind: 'save', surveyID, answers });
      await write();
      server.surveyAnswers = answers;
    },
    submitMobileSurveySession: async (_writer: unknown, surveyID: string, answers: Raw) => {
      server.surveyWrites.push({ kind: 'submit', surveyID, answers });
      await write();
      server.surveyAnswers = answers; server.surveySubmitted = true;
    },
  };
});

const { NativeUnitSettingsEditor, NativeUnitWorkloadEntry } = await import('./NativeUnitSettings');
const { attachBusinessRpcProvenance } = await import('../services/businessWriters');
const { WriterSessionChanged } = await import('../../../../src/lib/sessionBoundWriter.js');
// A refusal as businessRpc throws it: PostgREST's own body (code, message,
// details, hint) with the answer's HTTP status recorded beside it.
const postgrest = (status: number, code: string, message: string, details: string | null = null): unknown =>
  attachBusinessRpcProvenance({ code, message, details, hint: null }, status);
// Any other body, with the status the answer carried.
const answered = (status: number, body: Record<string, unknown>): unknown => attachBusinessRpcProvenance(body, status);
const { LiveSurveyHistory } = await import('./LiveLivedInScreens');
const { useApp } = await import('../state/AppProvider');
afterAll(stubPlainRequire({ '../lib/config': { mobileConfig: { supabaseUrl: '' } } }));

type View = 'workload' | 'editor' | 'survey';
// The host shows the screen only while signed in with a dashboard, as
// FeatureScreen's dashboard gate does.
function Host({ view }: { view: View }) {
  const { mode, dashboard } = useApp();
  if (mode !== 'authenticated' || !dashboard) return null;
  return view === 'workload' ? h(NativeUnitWorkloadEntry, {}) : view === 'editor' ? h(NativeUnitSettingsEditor, {}) : h(LiveSurveyHistory);
}

const UNCERTAIN = 'We could not confirm this entry was saved. Check your workload log before saving it again.';
const FORM_STALE = 'This form changed while you were away. Your entry is kept here; discard it to use the new form.';
const RELOAD = 'Your settings or access may have changed. Reload before saving again.';
const SETTINGS_STALE = 'These settings changed while you were away. Your changes are kept here, but they cannot be saved over the new settings.';
const SETTINGS_FAILED = 'Settings or access may have changed. Reload before saving again.';
const SURVEY_STALE = 'Your saved answers changed while you were away. Your unsaved answers are kept here.';
const SUBMITTED_ELSEWHERE = 'This survey was submitted elsewhere. Your unsaved answers are kept here until you discard them.';

let screen: Rendered | null = null;
let view: View = 'workload';
const flush = async () => { await act(async () => { for (let turn = 0; turn < 12; turn += 1) await Promise.resolve(); }); };
async function open(next: View): Promise<Rendered> {
  view = next;
  screen = await render(h(Host, { view }));
  await flush();
  return screen;
}
async function rerender(): Promise<void> { await screen!.rerender(h(Host, { view })); await flush(); }
const text = () => screen!.container.textContent ?? '';
const field = (label: string | RegExp) => getExposed(screen!.container, label) as HTMLInputElement;
const shows = (name: string) => exposedNames(screen!.container).includes(name);
// The session check: the host unmounts the screen, then the reads come back.
async function leave(): Promise<void> { boot(); await rerender(); }
async function resume(): Promise<void> { await leave(); restore(); await rerender(); }

beforeEach(() => {
  signIn('chapter');
  Object.assign(server, {
    units: [{ id: 'north', name: 'North' }], legacy: false, formVersion: 1, settingsRevision: 'revision-1', organizationVersion: 0,
    chapterVersion: 1, unitVersion: 1, chapterOverrides: {}, unitOverrides: {}, surveyAnswers: null, surveySubmitted: false,
    readGate: null, writeGate: null, refuseNextRead: false, refuseForm: false, failNext: null, workloadWrites: [], settingsWrites: [], surveyWrites: [], attempts: 0,
  });
});
afterEach(async () => {
  for (const held of gates.splice(0)) held.open();
  await screen?.unmount(); screen = null;
  setPlatform('ios');
});

describe.each<Platform>(['ios', 'android'])('workload entry for a unit through a session check on %s', (os) => {
  beforeEach(() => { setPlatform(os); });

  it('1. the same person returns to the exact typed entry', async () => {
    await open('workload');
    await type(field('Issues'), '7');
    await resume();
    expect(field('Issues').value).toBe('7');
  });

  it('2. nothing held shows while the reads are pending', async () => {
    await open('workload');
    await type(field('Issues'), '7');
    await leave();
    unconfirmReads(); await rerender();
    expect(text()).not.toContain('Workload for north');
    restore(); await rerender();
    expect(field('Issues').value).toBe('7');
  });

  it('3. another account starts blank', async () => {
    await open('workload');
    await type(field('Issues'), '7');
    await leave(); otherAccount(); await rerender();
    expect(field('Issues').value).toBe('');
  });

  it.each<Move>([['a left campaign', leaveChapter], ['a left organization', leaveOrganization]])('4. %s starts blank', async (_name, move) => {
    await open('workload');
    await type(field('Issues'), '7');
    await leave(); move(); await rerender();
    restore(); await rerender();
    expect(field('Issues').value).toBe('');
  });

  it('5. an authoritative refusal of the form read retires the entry', async () => {
    await open('workload');
    await type(field('Issues'), '7');
    server.refuseNextRead = true;
    await resume();
    expect(text()).toContain('Unit settings could not be loaded.');
    await press(getExposed(screen!.container, 'Retry unit settings')); await flush();
    expect(field('Issues').value).toBe('');
  });

  it("5b. the provider's own refusal retires the entry", async () => {
    await open('workload');
    await type(field('Issues'), '7');
    await leave(); refuseRead(); restore(); await rerender();
    expect(field('Issues').value).toBe('');
  });

  it.each<Move>([['sign-out', signOut], ['an MFA challenge', mfa]])('6. %s retires the entry', async (_name, move) => {
    await open('workload');
    await type(field('Issues'), '7');
    await leave(); move(); await rerender();
    restore(); await rerender();
    expect(field('Issues').value).toBe('');
  });

  it('7. a save in flight at the check that lands leaves the returning form blank, written once', async () => {
    await open('workload');
    await type(field('Issues'), '7');
    const held = gate(); server.writeGate = held.promise;
    await press(getExposed(screen!.container, 'Save workload'));
    await leave();
    held.open(); await flush();
    restore(); await rerender();
    expect(server.workloadWrites).toHaveLength(1);
    expect(server.workloadWrites[0]).toMatchObject({ unit: 'north', values: { cases: 7 } });
    expect(field('Issues').value).toBe('');
    expect(text()).not.toContain(UNCERTAIN);
  });

  it('8. a definite refusal of a save in flight returns the entry editable', async () => {
    await open('workload');
    await type(field('Issues'), '7');
    const held = gate(); server.writeGate = held.promise; server.failNext = postgrest(409, 'PT409', 'workload configuration changed; reload', 'workload_configuration_changed');
    await press(getExposed(screen!.container, 'Save workload'));
    await leave();
    held.open(); await flush();
    restore(); await rerender();
    expect(field('Issues').value).toBe('7');
    expect(field('Issues').disabled).toBe(false);
    expect(text()).toContain(RELOAD);
  });

  it('9. a lost answer is locked, offers Discard, and is sent again only on a deliberate tap', async () => {
    await open('workload');
    await type(field('Issues'), '7');
    const held = gate(); server.writeGate = held.promise; server.failNext = new TypeError('Network request failed');
    await press(getExposed(screen!.container, 'Save workload'));
    await leave();
    held.open(); await flush();
    server.writeGate = null;
    restore(); await rerender();
    expect(text()).toContain(UNCERTAIN);
    expect(field('Issues').value).toBe('7');
    expect(field('Issues').disabled).toBe(true);
    expect(server.workloadWrites).toHaveLength(1);
    await press(getExposed(screen!.container, 'Save workload again')); await flush();
    expect(server.workloadWrites).toHaveLength(2);
    expect(field('Issues').value).toBe('');
  });

  // rulings on  and D2: only the session writer's refusal before
  // sending, or a PostgREST-shaped 4xx answer with a code this save can
  // produce, proves no entry was inserted. A 5xx or missing status, a body
  // without PostgREST's shape, or any other code may follow a committed
  // insert, so the entry stays locked.
  it.each<[string, unknown]>([
    ['a gateway 502 carrying 42501', postgrest(502, '42501', 'Bad Gateway')],
    ['a gateway 503 carrying 42501', postgrest(503, '42501', 'Service Unavailable')],
    ['a gateway 504 carrying 42501', postgrest(504, '42501', 'Gateway Timeout')],
    ['a 403 carrying 42501 in a body without PostgREST\'s shape', answered(403, { code: '42501', message: 'Forbidden' })],
    ['42501 with no status recorded', { code: '42501', message: 'authentication required', details: null, hint: null }],
    ['a gateway-shaped five-character code', answered(504, { code: 'E5040', message: 'Gateway Timeout', details: 'upstream timed out after the request was sent' })],
    ['a well-formed SQLSTATE this save never raises', postgrest(400, 'P0001', 'raise_exception')],
    ['a gateway word as its code', answered(504, { code: 'upstream_timeout', message: 'The upstream server is timing out' })],
    ['a short numeric code', answered(504, { code: '504', message: 'Gateway Timeout' })],
    ['a gateway status and no code', answered(504, { message: 'Gateway Timeout' })],
    ['a 4xx status and no code', answered(429, { message: 'Too Many Requests' })],
    ['a transport failure', answered(0, { code: '', message: 'TypeError: Network request failed', details: '', hint: '' })],
    // The writer's marker in an answer proves nothing.
    ['a PostgREST-shaped 4xx body whose details name the writer refusal', postgrest(400, 'P0001', 'The account changed before this was sent.', 'writer_session_changed')],
    ['a gateway 403 body whose details name the writer refusal', answered(403, { message: 'Forbidden', details: 'writer_session_changed' })],
    ['an error carrying the writer marker that the writer did not make', Object.assign(new Error('The account changed before this was sent.'), { details: 'writer_session_changed' })],
    ['a writer refusal object that came back through an answer', attachBusinessRpcProvenance(new WriterSessionChanged(), 403)],
  ])('9b. a rejected save whose error carries %s stays locked with Save again and Discard', async (_name, error) => {
    await open('workload');
    await type(field('Issues'), '7');
    server.failNext = error;
    await press(getExposed(screen!.container, 'Save workload')); await flush();
    await resume();
    expect(text()).toContain(UNCERTAIN);
    expect(field('Issues').value).toBe('7');
    expect(field('Issues').disabled).toBe(true);
    expect(shows('Save workload again')).toBe(true);
    expect(shows('Discard this entry')).toBe(true);
    expect(server.workloadWrites).toHaveLength(1);
  });

  it.each<[string, unknown]>([
    ['the access refusal', postgrest(403, '42501', 'authentication required')],
    ['a changed form', postgrest(409, 'PT409', 'workload configuration changed; reload', 'workload_configuration_changed')],
    ['a refused value', postgrest(400, '22023', 'invalid workload value')],
    ['a check SQLSTATE', postgrest(400, '23514', 'violates check constraint')],
    ['a PostgREST code', postgrest(401, 'PGRST301', 'JWT expired')],
    ['the writer refusal before sending', new WriterSessionChanged()],
  ])('9c. a save refused with %s returns the entry editable', async (_name, error) => {
    await open('workload');
    await type(field('Issues'), '7');
    server.failNext = error;
    await press(getExposed(screen!.container, 'Save workload')); await flush();
    await resume();
    expect(text()).not.toContain(UNCERTAIN);
    expect(field('Issues').value).toBe('7');
    expect(field('Issues').disabled).toBe(false);
    expect(text()).toContain(RELOAD);
  });

  it('10. Discard clears an unconfirmed entry', async () => {
    await open('workload');
    await type(field('Issues'), '7');
    server.failNext = new TypeError('Network request failed');
    await press(getExposed(screen!.container, 'Save workload')); await flush();
    await resume();
    await press(getExposed(screen!.container, 'Discard this entry'));
    expect(field('Issues').value).toBe('');
    expect(server.workloadWrites).toHaveLength(1);
  });

  it('11. a form that changed meanwhile keeps the entry, says so, and saves nothing onto it', async () => {
    await open('workload');
    await type(field('Issues'), '7');
    server.settingsRevision = 'revision-2';
    await resume();
    expect(field('Issues').value).toBe('7');
    expect(text()).toContain(FORM_STALE);
    await press(getExposed(screen!.container, 'Save workload')); await flush();
    expect(server.workloadWrites).toHaveLength(0);
    expect(text()).toContain(RELOAD);
    await press(getExposed(screen!.container, 'Discard this entry'));
    expect(field('Issues').value).toBe('');
    expect(text()).not.toContain(FORM_STALE);
  });

  it('12. with several units it returns to the unit the entry was typed for', async () => {
    server.units = [{ id: 'north', name: 'North' }, { id: 'south', name: 'South' }];
    await open('workload');
    await press(getExposed(screen!.container, 'South')); await flush();
    await type(field('Issues'), '4');
    await resume();
    expect(text()).toContain('Workload for south');
    expect(field('Issues').value).toBe('4');
  });
});

describe.each<Platform>(['ios', 'android'])('organization workload form through a session check on %s', (os) => {
  describe.each<StaffKind>(['chapter', 'chapterless'])('for a %s officer', (staff) => {
    beforeEach(() => { setPlatform(os); signIn(staff); server.legacy = true; });

    it('1. the same person returns to the exact typed entry', async () => {
      await open('workload');
      await type(field('Issues'), '3');
      await resume();
      expect(field('Issues').value).toBe('3');
    });

    it('3. another account starts blank', async () => {
      await open('workload');
      await type(field('Issues'), '3');
      await leave(); otherAccount(); await rerender();
      expect(field('Issues').value).toBe('');
    });

    it('5. an authoritative refusal of the form read retires the entry', async () => {
      await open('workload');
      await type(field('Issues'), '3');
      server.refuseForm = true;
      await resume();
      expect(text()).toContain('The workload form could not be loaded.');
      await press(getExposed(screen!.container, 'Retry workload form')); await flush();
      expect(field('Issues').value).toBe('');
    });

    it('7. a save in flight at the check that lands leaves the returning form blank, written once', async () => {
      await open('workload');
      await type(field('Issues'), '3');
      const held = gate(); server.writeGate = held.promise;
      await press(getExposed(screen!.container, 'Save workload'));
      await leave();
      held.open(); await flush();
      restore(); await rerender();
      expect(server.workloadWrites).toHaveLength(1);
      expect(server.workloadWrites[0]).toMatchObject({ unit: null, values: { cases: 3 } });
      expect(field('Issues').value).toBe('');
    });
  });
});

describe.each<Platform>(['ios', 'android'])('unit configuration editor through a session check on %s', (os) => {
  beforeEach(() => { setPlatform(os); server.units = [{ id: 'north', name: 'North' }, { id: 'south', name: 'South' }]; });
  const categoryName = () => field(/category name$/);

  it('1. the same person returns to the exact typed change', async () => {
    await open('editor');
    await type(categoryName(), 'Grievances');
    await resume();
    expect(categoryName().value).toBe('Grievances');
  });

  it('2. nothing held shows while the reads are pending', async () => {
    await open('editor');
    await type(categoryName(), 'Grievances');
    await leave();
    unconfirmReads(); await rerender();
    expect(text()).not.toContain('Grievances');
    restore(); await rerender();
    expect(categoryName().value).toBe('Grievances');
  });

  it('3. another account starts from the server settings', async () => {
    await open('editor');
    await type(categoryName(), 'Grievances');
    await leave(); otherAccount(); await rerender();
    expect(categoryName().value).toBe('Issues');
  });

  it.each<Move>([['a left campaign', leaveChapter], ['a left organization', leaveOrganization]])('4. %s starts from the server settings', async (_name, move) => {
    await open('editor');
    await type(categoryName(), 'Grievances');
    await leave(); move(); await rerender();
    restore(); await rerender();
    expect(categoryName().value).toBe('Issues');
  });

  it("5. an authoritative refusal of the editor's read retires the change", async () => {
    await open('editor');
    await type(categoryName(), 'Grievances');
    server.refuseNextRead = true;
    await resume();
    expect(text()).not.toContain('Grievances');
    await leave(); restore(); await rerender();
    expect(categoryName().value).toBe('Issues');
  });

  it.each<Move>([['sign-out', signOut], ['an MFA challenge', mfa]])('6. %s retires the change', async (_name, move) => {
    await open('editor');
    await type(categoryName(), 'Grievances');
    await leave(); move(); await rerender();
    restore(); await rerender();
    expect(categoryName().value).toBe('Issues');
  });

  it('7. a save in flight at the check that lands is written once and the return shows the saved settings', async () => {
    await open('editor');
    await type(categoryName(), 'Grievances');
    const held = gate(); server.writeGate = held.promise;
    await press(getExposed(screen!.container, 'Save unit settings'));
    await leave();
    held.open(); await flush();
    restore(); await rerender();
    expect(server.settingsWrites).toHaveLength(1);
    expect(server.chapterVersion).toBe(2);
    expect(categoryName().value).toBe('Grievances');
    expect(text()).not.toContain(SETTINGS_STALE);
    expect(text()).not.toContain(SETTINGS_FAILED);
  });

  it('8. a definite failure of a save in flight returns the change editable', async () => {
    await open('editor');
    await type(categoryName(), 'Grievances');
    const held = gate(); server.writeGate = held.promise; server.failNext = new TypeError('Network request failed');
    await press(getExposed(screen!.container, 'Save unit settings'));
    await leave();
    held.open(); await flush();
    restore(); await rerender();
    expect(categoryName().value).toBe('Grievances');
    expect(categoryName().disabled).toBe(false);
    expect(text()).toContain(SETTINGS_FAILED);
    expect(server.settingsWrites).toHaveLength(1);
  });

  it('9. settings that changed meanwhile keep the change, say so, and the save is refused, never written over', async () => {
    await open('editor');
    await type(categoryName(), 'Grievances');
    server.chapterVersion = 5; server.chapterOverrides = { forms: [] };
    await resume();
    expect(categoryName().value).toBe('Grievances');
    expect(text()).toContain(SETTINGS_STALE);
    await press(getExposed(screen!.container, 'Save unit settings')); await flush();
    expect(server.settingsWrites).toEqual([expect.objectContaining({ expected: 1 })]);
    expect(server.chapterVersion).toBe(5);
    expect(server.chapterOverrides).toEqual({ forms: [] });
    expect(text()).toContain(SETTINGS_FAILED);
    await press(getExposed(screen!.container, 'Discard my changes'));
    expect(categoryName().value).toBe('Issues');
  });

  it('10. it returns to the unit last chosen, with that unit\'s change', async () => {
    await open('editor');
    await press(getExposed(screen!.container, 'South')); await flush();
    await press(getExposed(screen!.container, 'Use campaign settings for Forms: On')); await flush();
    expect(shows('Use campaign settings for Forms: Off')).toBe(true);
    await resume();
    expect(shows('Use campaign settings for Forms: Off')).toBe(true);
    await press(getExposed(screen!.container, 'Save unit settings')); await flush();
    expect(server.settingsWrites).toEqual([expect.objectContaining({ unit: 'south', expected: 1, values: { forms: ['grievance'] } })]);
  });
});

describe.each<Platform>(['ios', 'android'])('survey answers through a session check on %s', (os) => {
  describe.each<StaffKind>(['chapter', 'chapterless'])('for a %s officer', (staff) => {
    beforeEach(() => { setPlatform(os); signIn(staff); });
    const answer = () => field('Your idea');

    it('1. the same person returns to the exact unsaved answer', async () => {
      await open('survey');
      await type(answer(), 'Fair rotas');
      await resume();
      expect(answer().value).toBe('Fair rotas');
    });

    it('2. nothing held shows while the reads are pending', async () => {
      await open('survey');
      await type(answer(), 'Fair rotas');
      await leave();
      unconfirmReads(); await rerender();
      expect(text()).not.toContain('Fair rotas');
      expect(shows('Your idea')).toBe(false);
      restore(); await rerender();
      expect(answer().value).toBe('Fair rotas');
    });

    it('3. another account starts from its own saved answers', async () => {
      await open('survey');
      await type(answer(), 'Fair rotas');
      await leave(); otherAccount(); await rerender();
      expect(answer().value).toBe('');
    });

    it.each<Move>([['a left campaign', leaveChapter], ['a left organization', leaveOrganization]])('4. %s starts blank', async (_name, move) => {
      await open('survey');
      await type(answer(), 'Fair rotas');
      await leave(); move(); await rerender();
      restore(); await rerender();
      expect(answer().value).toBe('');
    });

    it("5. the provider's refusal retires the answers", async () => {
      await open('survey');
      await type(answer(), 'Fair rotas');
      await leave(); refuseRead(); restore(); await rerender();
      expect(answer().value).toBe('');
    });

    it.each<Move>([['sign-out', signOut], ['an MFA challenge', mfa]])('6. %s retires the answers', async (_name, move) => {
      await open('survey');
      await type(answer(), 'Fair rotas');
      await leave(); move(); await rerender();
      restore(); await rerender();
      expect(answer().value).toBe('');
    });

    it('7. a save in flight at the check that lands is written once and the return shows it saved', async () => {
      await open('survey');
      await type(answer(), 'Fair rotas');
      const held = gate(); server.writeGate = held.promise;
      await press(getExposed(screen!.container, 'Save for later'));
      await leave();
      held.open(); await flush();
      restore(); await rerender();
      expect(server.surveyWrites).toEqual([{ kind: 'save', surveyID: 'survey-1', answers: { q1: 'Fair rotas' } }]);
      expect(answer().value).toBe('Fair rotas');
      expect(text()).not.toContain(SURVEY_STALE);
    });

    it('8. a definite failure of a save in flight returns the answers editable with the failure', async () => {
      await open('survey');
      await type(answer(), 'Fair rotas');
      const held = gate(); server.writeGate = held.promise; server.failNext = { code: 'P0001', message: 'refused' };
      await press(getExposed(screen!.container, 'Save for later'));
      await leave();
      held.open(); await flush();
      restore(); await rerender();
      expect(answer().value).toBe('Fair rotas');
      expect(answer().disabled).toBe(false);
      expect(text()).toContain('Survey progress could not be saved.');
      expect(server.surveyWrites).toHaveLength(1);
    });

    it('9. a submit in flight at the check that lands closes the survey, submitted once', async () => {
      await open('survey');
      await type(answer(), 'Fair rotas');
      const held = gate(); server.writeGate = held.promise;
      await press(getExposed(screen!.container, 'Submit survey'));
      await leave();
      held.open(); await flush();
      restore(); await rerender();
      expect(server.surveyWrites).toEqual([{ kind: 'submit', surveyID: 'survey-1', answers: { q1: 'Fair rotas' } }]);
      expect(text()).toContain('Your response is complete.');
    });

    it('10. saved answers that changed meanwhile keep the unsaved ones, say so, and can be let go', async () => {
      server.surveyAnswers = { q1: 'Old idea' };
      await open('survey');
      await type(answer(), 'Fair rotas');
      server.surveyAnswers = { q1: 'Web idea' };
      await resume();
      expect(answer().value).toBe('Fair rotas');
      expect(text()).toContain(SURVEY_STALE);
      await press(getExposed(screen!.container, 'Use my saved answers'));
      expect(answer().value).toBe('Web idea');
    });

    it('11. a response submitted elsewhere keeps the unsaved answers, locked, until the person discards them', async () => {
      await open('survey');
      await type(answer(), 'Fair rotas');
      server.surveyAnswers = { q1: 'Web idea' }; server.surveySubmitted = true;
      await resume();
      // Kept, locked, with a notice; nothing offered to send them again.
      expect(text()).toContain(SUBMITTED_ELSEWHERE);
      expect(answer().value).toBe('Fair rotas');
      expect(answer().disabled).toBe(true);
      expect(shows('Save for later')).toBe(false);
      expect(shows('Submit survey')).toBe(false);
      // Still kept after another session check.
      await resume();
      expect(answer().value).toBe('Fair rotas');
      expect(server.surveyWrites).toEqual([]);
      // Only the person's Discard releases them.
      await press(getExposed(screen!.container, 'Discard my unsaved answers'));
      expect(text()).toContain('Your response is complete.');
      expect(shows('Your idea')).toBe(false);
      await resume();
      expect(text()).toContain('Your response is complete.');
      expect(text()).not.toContain(SUBMITTED_ELSEWHERE);
      expect(server.surveyWrites).toEqual([]);
    });

    it('11b. its own confirmed submit releases the answers with no notice', async () => {
      await open('survey');
      await type(answer(), 'Fair rotas');
      await press(getExposed(screen!.container, 'Submit survey')); await flush();
      await resume();
      expect(text()).toContain('Your response is complete.');
      expect(text()).not.toContain(SUBMITTED_ELSEWHERE);
      expect(server.surveyWrites).toHaveLength(1);
    });
  });
});
