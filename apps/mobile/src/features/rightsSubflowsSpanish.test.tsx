import { stubSessionWriter } from '../testing/stubSessionWriter';
// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubPlainRequire } from '../testing/plainRequire';
import { exposedNames, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import type { LivedInRights } from '../services/livedIn';

// UX-UG-NATIVE-RIGHTS-SUBFLOWS-POLISH-BATCH-20261111 (#8305): the
// rights screen's saved-place (bookmark) and steward-request subflows follow
// the saved member language on iPhone and Android. Chapter-published lesson
// titles, steps and scripts stay in their publication language.
const app = vi.hoisted(() => ({ language: 'es' as 'en' | 'es', epoch: 0 }));
const load = vi.hoisted(() => ({ rights: vi.fn(), request: vi.fn(), save: vi.fn(), clear: vi.fn(), progress: vi.fn() }));
const place = vi.hoisted(() => ({ bookmark: { lessonID: 'weingarten', anchor: 'steps' } as { lessonID: string; anchor: string } | null }));
// The survey card and unit editors import the shared draft hook, whose attempt keys come from expo-crypto (#9240 pull request D).
vi.mock('expo-crypto', () => ({ randomUUID: () => 'attempt-key' }));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../components/ui', () => import('../testing/uiStandIn'));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('expo-secure-store', () => ({}));
vi.mock('../lib/config', () => ({ mobileConfig: { supabaseUrl: '' } }));
vi.mock('expo-router', () => ({ useIsFocused: () => true, useNavigation: () => ({ setOptions: () => {} }) }));
vi.mock('../lib/screenBack', () => ({ useScreenBackInterceptor: () => {} }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({
  memberLanguage: app.language, mode: 'authenticated', session: { user: { id: 'member-a' }, access_token: 'fixture-a' }, organizationID: 'org-a',
  chapterMemberships: [{ chapterID: `chapter-${app.epoch}`, selected: true }],
  sessionRestricted: false, captureAuthenticatedSessionGuard: () => { const epoch = app.epoch; return () => epoch === app.epoch; }, authorizedRoles: ['member'],
  dashboard: { member: { chapterID: `chapter-${app.epoch}` } }, sampleHat: null, liveSampleBackend: false,
}) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('../components/PinnedHeader', () => ({ usePinnedHeaderChrome: () => null }));
// No explicit type argument on original(): Semgrep's TypeScript parser
// rejects `original<…>()` and the security scan fails on the parse error.
vi.mock('./RightsResumeReading', async (original) => ({
  ...(await original() as Record<string, unknown>),
  rightsBookmarks: {},
  useRightsReadingScope: () => ({ key: 'scope' }),
  useRightsBookmark: () => ({ available: true, bookmark: place.bookmark, readFailed: false, save: load.save, clear: load.clear, refresh: () => {} }),
}));
vi.mock('./TaskDocumentHandoffProvider', () => ({ useTaskDocumentHandoff: () => ({ active: false, pending: null }) }));
vi.mock('./WorkFilterPresetsCard', () => ({ WorkFilterButton: () => null, WorkFilterPresetsCard: () => null }));
vi.mock('./guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null, NativeCoachMark: () => null, NativeOrgStartGuide: () => null }));
vi.mock('../components/WorkflowActions', () => ({ WorkflowActions: () => null }));
vi.mock('../components/AskCompassButton', () => ({ AskCompassButton: () => null }));
vi.mock('../components/AttachmentPanel', () => ({ AttachmentPanel: () => null }));
vi.mock('../components/QuarterlySurveyGate', () => ({ QuarterlySurveyGate: () => null }));
vi.mock('./ContextualPulseCard', () => ({ ContextualPulseCard: () => null, useNativeContextualPulse: () => ({ onScrollProgress: undefined }) }));
vi.mock('./learning/LearningContentManager', () => ({ LearningContentManager: () => null }));
vi.mock('./learning/LearningLibrarySection', () => ({ LearningLibrarySection: () => null }));
vi.mock('./CaseRowTopicCards', () => ({ ChapterCaseRowTopicCard: () => null }));
vi.mock('../lib/connectedWorkflows', () => ({ connectedWorkflowApi: () => null }));
vi.mock('../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => vi.fn() }));
vi.mock('../services/haptics', () => ({ haptics: { success: vi.fn(), select: vi.fn(), warning: vi.fn() } }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => null, session?.user?.id ?? 'member-a'),  loadMobileMemberReportCard: vi.fn() }));
vi.mock('../services/memberSurveys', () => ({ loadMobileMemberSurveys: vi.fn(), saveMobileSurveySession: vi.fn(), submitMobileSurveySession: vi.fn() }));
vi.mock('../services/nativeCalendarExport', () => ({ calendarExportWasSaved: () => false, exportToDeviceCalendar: vi.fn(), isCalendarExportAvailable: () => false }));
vi.mock('../lib/mi1AnalyticsShared', () => ({ normalizeMemberReportCard: () => null }));
vi.mock('../services/livedIn', () => ({
  loadMobileRightsHistory: load.rights, requestMobileSteward: load.request, saveMobileRightsProgress: load.progress,
}));

import { LiveLivedInScreen } from './LiveLivedInScreens';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativeUiText } from '../lib/nativeUiCopy';

const rights = (requestStatus: string | null, steps = ['Ask for a committee member', 'Stay calm']): LivedInRights => ({
  lessons: [{
    id: 'weingarten', label: 'Weingarten', title: 'Weingarten rights', description: 'Ask for a committee member before an investigatory meeting.',
    steps, script: 'I request my committee member.', completedSteps: [0], requestStatus,
  }],
  articles: [],
});

afterAll(stubPlainRequire({ '../lib/config': { mobileConfig: { supabaseUrl: '' } } }));
let screen: Rendered | null = null;
beforeEach(() => { app.language = 'es'; app.epoch = 0; place.bookmark = { lessonID: 'weingarten', anchor: 'steps' }; load.rights.mockReset(); load.request.mockReset(); load.save.mockReset(); load.clear.mockReset(); load.progress.mockReset(); });
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); });
async function retireScope() {
  app.epoch += 1;
  await screen!.rerender(h(LiveLivedInScreen, { featureKey: 'rights' }));
}
const names = () => exposedNames(screen!.container);
const named = (name: string) => [...screen!.container.querySelectorAll('[aria-label]')].find((node) => node.getAttribute('aria-label') === name) as HTMLElement;
async function open(requestStatus: string | null = null, steps?: string[]) {
  load.rights.mockResolvedValue(rights(requestStatus, steps));
  screen = await render(h(LiveLivedInScreen, { featureKey: 'rights' }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe.each(['ios', 'android'] as const)('rights saved place and committee member request on %s', (os) => {
  it('reloads acknowledged progress while its composing scope remains current', async () => {
    setPlatform(os); app.language = 'en';
    await open();
    await press(named('Mark complete'));
    expect(load.progress).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'weingarten', [0, 1]);
    expect(load.rights).toHaveBeenCalledTimes(2);
  });

  it('does not reload an acknowledged save after its composing scope retires', async () => {
    setPlatform(os); app.language = 'en';
    await open();
    let finish!: () => void;
    load.progress.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    await press(named('Mark complete'));
    await retireScope();
    await act(async () => { finish(); });
    expect(load.progress).toHaveBeenCalledTimes(1);
    expect(load.rights).toHaveBeenCalledTimes(1);
  });

  it('does not apply a history read completed after its composing scope retires', async () => {
    setPlatform(os); app.language = 'en';
    await open();
    let finish!: (value: LivedInRights) => void;
    load.rights.mockReturnValueOnce(new Promise<LivedInRights>((resolve) => { finish = resolve; }));
    await press(named('Mark complete'));
    await retireScope();
    await act(async () => { finish(rights(null, ['Replacement account detail'])); });
    expect(load.rights).toHaveBeenCalledTimes(2);
    expect(screen!.container.textContent).not.toContain('Replacement account detail');
    expect(screen!.container.textContent).toContain('Stay calm');
  });

  it('does not reload an acknowledged committee member request after its composing scope retires', async () => {
    setPlatform(os); app.language = 'en';
    await open();
    let finish!: () => void;
    load.request.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    await press(named('Request a committee member'));
    await retireScope();
    await act(async () => { finish(); });
    expect(load.request).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'weingarten');
    expect(load.rights).toHaveBeenCalledTimes(1);
  });

  it('does not apply the steward-request reload after its composing scope retires', async () => {
    setPlatform(os); app.language = 'en';
    await open();
    let finish!: (value: LivedInRights) => void;
    load.rights.mockReturnValueOnce(new Promise<LivedInRights>((resolve) => { finish = resolve; }));
    await press(named('Request a committee member'));
    await retireScope();
    await act(async () => { finish(rights('requested', ['Replacement account detail'])); });
    expect(load.rights).toHaveBeenCalledTimes(2);
    expect(screen!.container.textContent).not.toContain('Replacement account detail');
    expect(screen!.container.textContent).toContain('Stay calm');
  });

  it('holds a committee member request until its own pending write settles after workspace retirement', async () => {
    setPlatform(os);app.language='en';await open();let finish!:()=>void;
    load.request.mockReturnValue(new Promise<void>(resolve=>{finish=resolve;}));
    await press(named('Request a committee member'));expect(load.request).toHaveBeenCalledTimes(1);
    await retireScope();await press(named('Request a committee member'));expect(load.request).toHaveBeenCalledTimes(1);
    await act(async()=>{finish();});
    expect(names()).not.toContain('Request a committee member');
    expect(screen!.container.textContent).toContain('Committee requested');
    expect(load.request).toHaveBeenCalledOnce();
  });

  it('speaks the saved Spanish on the saved-place card and the committee member request, keeping the lesson as published', async () => {
    setPlatform(os);
    await open('acknowledged');
    const text = screen!.container.textContent ?? '';
    expect(text).toContain('Continuar leyendo');
    expect(text).toContain('Su posición guardada en Weingarten rights.');
    expect(names()).toEqual(expect.arrayContaining(['Continuar leyendo', 'Borrar la posición guardada', 'Solicitud de integrante del comité recibida']));
    expect(text).toContain('1/2 pasos');
    // Chapter-published lesson content stays in its publication language.
    expect(text).toContain('Weingarten rights');
    expect(text).toContain('Ask for a committee member before an investigatory meeting.');
    expect(text).not.toContain('Committee acknowledged');
    expect(text).not.toContain('Clear saved place');
  });

  it('offers the committee member request in Spanish and keeps the request wired to the lesson', async () => {
    setPlatform(os);
    load.request.mockResolvedValue(undefined);
    await open(null);
    expect(names()).toContain('Solicitar un integrante del comité');
    load.rights.mockResolvedValue(rights('requested'));
    await press(named('Solicitar un integrante del comité'));
    await act(async () => { await Promise.resolve(); });
    expect(load.request).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'weingarten');
    expect(names()).toContain('Comité solicitado');
  });

  it('reports a saved place that could not be cleared in Spanish', async () => {
    setPlatform(os);
    load.clear.mockRejectedValue(new Error('storage'));
    await open(null);
    await press(named('Borrar la posición guardada'));
    await act(async () => { await Promise.resolve(); });
    expect(screen!.container.textContent).toContain('No se pudo borrar su posición guardada en este dispositivo. Inténtelo de nuevo.');
  });

  // Ledger 110: a one-step lesson counts in the singular, in both languages;
  // the two-step lesson above keeps '1/2 pasos'.
  it('counts a one-step lesson in the singular', async () => {
    setPlatform(os);
    await open(null, ['Ask for a committee member']);
    const text = screen!.container.textContent ?? '';
    expect(text).toContain('1/1 paso');
    expect(text).not.toContain('1/1 pasos');
  });

  it('counts a one-step lesson in the singular for an English profile too', async () => {
    setPlatform(os);
    app.language = 'en';
    await open(null, ['Ask for a committee member']);
    const text = screen!.container.textContent ?? '';
    expect(text).toContain('1/1 step');
    expect(text).not.toContain('1/1 steps');
  });

  it('words the saved-place step eyebrow in the singular for one step', () => {
    const es = nativeUiText('es');
    expect(es('{label} · {done}/{total} STEP', { label: 'WEINGARTEN', done: 1, total: 1 })).toBe('WEINGARTEN · 1/1 PASO');
    expect(es('{label} · {done}/{total} STEPS', { label: 'WEINGARTEN', done: 1, total: 2 })).toBe('WEINGARTEN · 1/2 PASOS');
    // The saved-place card picks the key by the lesson's step count.
    expect(readFileSync(join(__dirname, 'RightsResumeReading.tsx'), 'utf8'))
      .toContain("lesson.steps.length === 1 ? '{label} · {done}/{total} STEP' : '{label} · {done}/{total} STEPS'");
  });

  it('keeps English for an English profile', async () => {
    setPlatform(os);
    app.language = 'en';
    await open('requested');
    expect(names()).toEqual(expect.arrayContaining(['Continue reading', 'Clear saved place', 'Committee requested']));
    expect(screen!.container.textContent).toContain('1/2 steps');
  });
});
