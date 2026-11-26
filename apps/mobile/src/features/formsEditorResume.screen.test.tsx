// @vitest-environment jsdom
import { stubSessionWriter } from '../testing/stubSessionWriter';
import { act, createElement as h, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import palette from '../theme/palette.json';

// BUG-UG-NATIVE-FORM-EDITOR-CLOSES-WHEN-THE-MEMBER-RETURNS-FROM-THE-FILE-PICKER-20261114
// (#8724), gate stage 172 r1s1 and r2s1: the whole return to the foreground
// through the feature route. The resume sets the app to booting and drops the
// dashboard, so FeatureScreen's gates unmount the Forms screen and a new one
// mounts when the dashboard is back. The open editor, and an attachment still
// being added, come back for the same member in the same scope; sign-out, a
// refused resume, another member and a real scope change leave no editor.
const port = vi.hoisted(() => ({
  push: vi.fn(), templates: vi.fn(), forms: vi.fn(), openDraft: vi.fn(), save: vi.fn(), openAnswers: vi.fn(), submit: vi.fn(), filed: vi.fn(), files: vi.fn(), addFile: vi.fn(), pick: vi.fn(), cosigning: vi.fn(), openFile: vi.fn(),
  app: {} as Record<string, unknown>,
  keeper: null as KeptFormEditor<FormEdit, FormOutcome> | null,
}));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
// The form signature pad (#8699) on the live Forms screen draws with react-native-svg.
vi.mock('react-native-svg', () => ({ default: () => null, Polyline: () => null }));
vi.mock('../components/ui', async () => {
  const ui = await import('../testing/uiStandIn');
  return { ...ui, StateMessage: ({ title, body, action }: { title: string; body?: string; action?: ReactNode }) => h('section', null, title, body, action) };
});
vi.mock('expo-router', () => ({ useIsFocused: () => true, useNavigation: () => ({}), useRouter: () => ({ push: port.push, dismissTo: vi.fn() }), useLocalSearchParams: () => ({}), Redirect: () => null }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'fixture-id' }));
vi.mock('../state/AppProvider', () => ({ useApp: () => port.app }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../services/supabase', async () => {
  const fixture = await (() => ({ getSupabaseClient: () => ({}), loadMobileConnectionReadiness: async () => [], readStepDeadlinePages: vi.fn() }))();
  return { ...fixture, captureSessionWriter: () => stubSessionWriter(() => fixture.getSupabaseClient()) };
});
vi.mock('../services/governance', async (original) => ({ ...(await original() as typeof import('../services/governance')), loadMobileOfficerRemovalDetails: async () => new Map() }));
vi.mock('../services/nativeCalendarExport', () => ({ isCalendarExportAvailable: () => false }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn() } }));
vi.mock('../services/analyticsPreference', () => ({ gatePageViewRecorder: (fn: unknown) => fn, useProductAnalyticsEnabled: () => false }));
vi.mock('../services/observability', () => ({ captureNativeScreen: vi.fn() }));
vi.mock('../services/ssoRelease', () => ({ useSsoReleased: () => false }));
vi.mock('../lib/announce', async (original) => ({ ...(await original() as typeof import('../lib/announce')), queueAccessibilityAnnouncement: vi.fn(), useAccessibilityAnnouncementQueue: () => vi.fn() }));
vi.mock('../lib/screenBack', async (original) => ({ ...(await original() as typeof import('../lib/screenBack')), useScreenBackInterceptor: () => {} }));
vi.mock('../lib/useFeaturePageView', async (original) => ({ ...(await original() as typeof import('../lib/useFeaturePageView')), useFeaturePageView: () => {} }));
vi.mock('../lib/mi1AnalyticsShared', () => ({ normalizeMemberReportCard: () => null }));
vi.mock('../lib/connectedWorkflows', async (original) => ({ ...(await original() as typeof import('../lib/connectedWorkflows')), connectedWorkflowApi: () => null }));
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: ({ children }: { children?: ReactNode }) => h('div', null, children), useScreenNameAlreadySpoken: () => ({ hiddenProps: {} }) }));
vi.mock('../components/SupportLink', () => ({ SupportLink: () => null }));
vi.mock('../data/useChannels', () => ({ useChannelStore: () => ({ subscribe: () => () => {}, getVersion: () => 0, channels: () => [] }) }));
vi.mock('../components/AskCompassButton', () => ({}));
vi.mock('../components/TransactionalAction', () => ({ useTransactionalAction: () => ({ done: false }) }));
// The steward desk's section rows press through PressableScale; its animation
// props have no stand-in meaning (the stand-in reads only the props it
// knows), so it renders as the stand-in Pressable.
vi.mock('../components/PressableScale', async () => {
  const native = await import('../testing/reactNativeStandIn');
  return { PressableScale: (props: Record<string, unknown>) => h(native.Pressable as never, props) };
});
vi.mock('../components/ChapterVerificationControls', () => ({}));
vi.mock('../components/NumberFlow', () => ({}));
vi.mock('../components/StaffRolePicker', () => ({ StaffRolePicker: () => null }));
vi.mock('../components/WorkflowActions', () => ({ WorkflowActions: () => null }));
vi.mock('../components/AttachmentPanel', () => ({}));
vi.mock('../components/QuarterlySurveyGate', () => ({}));
vi.mock('./LiveAppointmentsFeature', () => ({}));
vi.mock('./MemberSupportScreen', () => ({}));
vi.mock('./ChapterMembershipsScreen', () => ({}));
vi.mock('./OrgStructureScreen', () => ({}));
vi.mock('./mi1/PayToolsScreen', () => ({}));
vi.mock('./mi1/Mi1FeatureScreen', () => ({}));
vi.mock('./mi1/Mi1AnalyticsScreen', () => ({}));
vi.mock('./mi1/ConnectionSuggestionsPanel', () => ({}));
vi.mock('./mi1/OrganizationIntelligenceScreens', () => ({}));
vi.mock('./mi1/Mi1QaFeatureScreen', () => ({}));
vi.mock('./learning/LearningContentManager', () => ({}));
vi.mock('./learning/LearningLibrarySection', () => ({}));
vi.mock('./guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null, NativeOrgStartGuide: () => null }));
// The Work tab's own parts and the steward desk's reads.
vi.mock('./guideLayers/StaffGuides', () => ({ NativeStaffGuides: () => null }));
vi.mock('../components/StaffQuickCapture', () => ({ StaffQuickCapture: () => null }));
vi.mock('../components/WorkWidgets', () => ({ WorkWidgets: () => null }));
vi.mock('../services/memberSwitches', () => ({ useMemberSwitchRead: () => null }));
vi.mock('../lib/chrome', () => ({ screenBottomInset: () => 0, useNativeTabContentInset: () => 0 }));
vi.mock('../services/stewardDeskSections', () => ({ loadStewardCaseload: vi.fn(), loadStewardBroadcasts: vi.fn(), loadStewardFormsForReview: vi.fn(), loadStewardRequests: vi.fn(), reviewStewardForm: vi.fn(), sendChapterBroadcast: vi.fn(), triageStewardRequest: vi.fn() }));
vi.mock('../services/stewardFormReview', () => ({ formatFormSubmittedAt: () => '', loadStewardFormReviewDetail: vi.fn(), stewardFormApprovalBlock: () => null }));
vi.mock('./ContextualPulseCard', () => ({}));
vi.mock('./RightsResumeReading', () => ({}));
vi.mock('./TaskDocumentHandoffProvider', () => ({}));
vi.mock('./WorkFilterPresetsCard', () => ({}));
vi.mock('./CaseRowTopicCards', () => ({}));


vi.mock('../components/SignaturePad', () => ({ SignaturePad: () => null }));
vi.mock('../services/formFiles', async (original) => ({
  ...(await original() as typeof import('../services/formFiles')),
  listFormFiles: port.files, addFormFile: port.addFile, openFormFile: port.openFile,
}));
vi.mock('../services/attachments', () => ({ pickAuthorizedDocument: port.pick }));
vi.mock('../services/formCosigners', async (original) => ({ ...(await original() as typeof import('../services/formCosigners')), loadCosigning: port.cosigning }));
vi.mock('../services/privateFileAccess', () => ({ PrivateFileError: class extends Error {}, requestPrivateFileInspection: vi.fn(), downloadPrivateObjectToFile: vi.fn(), privateFileApiOrigin: () => 'https://sample.unionground.example' }));
// The real keeper, captured so a test can land a completion in the moment
// between a Forms screen's first render and its subscription.
vi.mock('./forms/keptFormEditor', async (original) => {
  const real = await original() as typeof import('./forms/keptFormEditor');
  return {
    ...real,
    useKeptFormEditor: (ownerID: string | null, mode: string, scope: string | null) => {
      const keeper = real.useKeptFormEditor<FormEdit, FormOutcome>(ownerID, mode, scope);
      port.keeper = keeper;
      return keeper;
    },
  };
});
vi.mock('../services/memberForms', async (original) => ({
  ...(await original() as typeof import('../services/memberForms')),
  loadFormTemplates: port.templates, loadMyForms: port.forms, loadMyOpenFormDraft: port.openDraft, saveMyFormDraft: port.save,
  openFormAnswers: port.openAnswers, submitMyForm: port.submit, myFormWasFiled: port.filed,
}));

import { FormActionError, formTemplateFromRow, type FormTemplate } from '../services/memberForms';
import { FeatureScreen } from './FeatureScreen';
import type { KeptFormEditor } from './forms/keptFormEditor';
import type { FormEdit, FormOutcome } from './LiveFeatureScreens';

const grievance = formTemplateFromRow({
  key: 'grievance', version: 1, label_en: 'Grievance', active: true, available_to_start: true, is_platform_seed: true, organization_id: null,
  field_schema: { steps: [{ title: 'What happened', fields: [{ key: 'summary', type: 'text', label: 'Summary', required: true }] }] },
}) as FormTemplate;
const fmlaFamily = formTemplateFromRow({
  key: 'fmla_family', version: 1, label_en: 'FMLA family care', active: true, available_to_start: true, is_platform_seed: true, organization_id: null,
  field_schema: { steps: [{ title: 'Leave', fields: [{ key: 'reason', type: 'text', label: 'Leave needed', required: true }] }] },
}) as FormTemplate;
const draft = { id: 'form-g', templateKey: 'grievance', templateVersion: 1, status: 'draft', answers: { summary: 'Overtime' }, step: 0, reviewNote: '', updatedAt: '2026-11-01T15:00:00Z', signed: false, signatureCurrent: false, sealedMarker: false, sealedPlaintext: false };
const attached = { id: 'file-1', formID: 'form-g', bucketID: 'b', objectName: 'o', filename: 'shift.pdf', mimeType: 'application/pdf', sizeBytes: 2048, confirmed: true, createdAt: '', scanCurrent: true };
const member = (id: string, chapterID = 'chapter-a') => ({
  mode: 'authenticated', session: { user: { id } }, memberLanguage: 'en', organizationID: 'org-a',
  authorizedRoles: ['member'], chapterRoles: ['member'], organizationRoles: [], staffRoleChoices: [],
  chapterMemberships: [{ chapterID, selected: true }], duesContext: null,
  dashboard: { member: { id, chapterID, language: 'en' }, cases: [] },
  captureAuthenticatedSessionGuard: () => () => true,
});
// What clearProtectedState leaves while the session is re-checked.
const booting = (id: string) => ({ ...member(id), mode: 'booting', dashboard: null, organizationID: null, chapterMemberships: [], authorizedRoles: [], chapterRoles: [] });

const PLATFORMS: ('ios' | 'android')[] = ['ios', 'android'];
let screen: Rendered | null = null;
async function settle() {
  await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
}
async function show(app: Record<string, unknown>) {
  port.app = app;
  await screen!.rerender(h(FeatureScreen, { featureKey: 'forms' }));
  await settle();
}
// Opens the saved grievance at its filing step and types into it on the way.
async function openAtFiling() {
  port.app = member('member-a');
  screen = await render(h(FeatureScreen, { featureKey: 'forms' }));
  await settle();
  await press(getExposed(screen.container, 'Continue Grievance'));
  await type(getExposed(screen.container, 'Summary'), 'Overtime on the 12th');
  await press(getExposed(screen.container, 'Review & submit'));
  await settle();
}
const disabled = (element: HTMLElement) => element.getAttribute('aria-disabled') === 'true';
const editorOpen = () => screen!.container.textContent?.includes('Attachments') ?? false;

beforeEach(() => {
  vi.clearAllMocks();
  port.templates.mockResolvedValue([grievance]);
  port.forms.mockResolvedValue([draft]);
  port.openDraft.mockResolvedValue(null);
  port.save.mockResolvedValue({ formID: 'form-g', dataVersion: null });
  port.files.mockResolvedValue([]);
  port.cosigning.mockResolvedValue({ cosigners: {}, requests: [] });
  port.filed.mockResolvedValue(false);
});
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); });

describe.each(PLATFORMS)('the open form across a return to the foreground on %s', (os) => {
  it('comes back with what was typed, and the file added from the picker appears once attached', async () => {
    setPlatform(os);
    await openAtFiling();
    let attach: () => void = () => {};
    port.pick.mockResolvedValue({ uri: 'file:///shift.pdf', name: 'shift.pdf', mimeType: 'application/pdf', size: 2048 });
    port.addFile.mockImplementation((_target: unknown, _candidate: unknown, report: (phase: string) => void) => {
      report('uploading');
      return new Promise<void>((resolve) => { attach = resolve; });
    });
    await press(getExposed(screen!.container, 'Add a file'));
    await settle();
    await show(booting('member-a'));
    expect(editorOpen()).toBe(false);
    await show(member('member-a'));
    expect(editorOpen()).toBe(true);
    expect(getExposed(screen!.container, 'Uploading…')).toBeTruthy();
    port.files.mockResolvedValue([attached]);
    await act(async () => { attach(); });
    await settle();
    expect(screen!.container.textContent).toContain('shift.pdf');
    await press(getExposed(screen!.container, 'Back'));
    expect((getExposed(screen!.container, 'Summary') as HTMLInputElement).value).toBe('Overtime on the 12th');
  });

  it('comes back after a share sheet, with Open available again once it closes', async () => {
    setPlatform(os);
    port.files.mockResolvedValue([attached]);
    await openAtFiling();
    let closed: () => void = () => {};
    port.openFile.mockImplementation(() => new Promise<void>((resolve) => { closed = resolve; }));
    await press(getExposed(screen!.container, 'Open shift.pdf'));
    await show(booting('member-a'));
    await show(member('member-a'));
    expect(editorOpen()).toBe(true);
    // The sheet the member came back from is still settling: no second Open.
    expect(disabled(getExposed(screen!.container, 'Open shift.pdf'))).toBe(true);
    await act(async () => { closed(); });
    await settle();
    expect(disabled(getExposed(screen!.container, 'Open shift.pdf'))).toBe(false);
  });

  it.each([
    ['sign-out, then the same worker signs in again', [{ ...booting('member-a'), mode: 'signedOut', session: null }, booting('member-a')], member('member-a')],
    ['a refused resume', [{ ...booting('member-a'), mode: 'mfaRequired', assuranceUnavailable: true }], member('member-a')],
    ['another worker', [booting('member-b')], member('member-b')],
    ['a real scope change', [booting('member-a')], member('member-a', 'chapter-b')],
  ] as const)('leaves no editor after %s', async (_case, between, after) => {
    setPlatform(os);
    await openAtFiling();
    for (const state of between) await show(state);
    await show(after);
    expect(editorOpen()).toBe(false);
    expect(screen!.container.textContent).not.toContain('Overtime on the 12th');
  });
});

// Gate stage 176 (r3s1, r4s1): a save still on its way when the return to the
// foreground unmounts Forms commits during the re-check. Its result (the
// form, the sealed version it stored) reaches the kept editor before another
// save can start, and a save that fails then is shown, not lost.
describe.each(PLATFORMS)('a save on its way across a return to the foreground on %s', (os) => {
  let answer: { resolve: (value: { formID: string; dataVersion: string | null }) => void; reject: (error: unknown) => void } = { resolve: () => {}, reject: () => {} };
  async function saveSealedThenLeave() {
    port.templates.mockResolvedValue([fmlaFamily]);
    port.forms.mockResolvedValue([{ ...draft, id: 'form-s', templateKey: 'fmla_family', answers: {}, sealedMarker: true }]);
    port.openAnswers.mockResolvedValue({ answers: { reason: 'Leave in March' }, dataVersion: 'v-1' });
    port.save.mockImplementationOnce(() => new Promise<{ formID: string; dataVersion: string | null }>((resolve, reject: (error: unknown) => void) => { answer = { resolve, reject }; }));
    port.app = member('member-a');
    screen = await render(h(FeatureScreen, { featureKey: 'forms' }));
    await settle();
    await press(getExposed(screen.container, 'Continue FMLA family care'));
    await settle();
    await type(getExposed(screen.container, 'Leave needed'), 'Leave in April');
    await press(getExposed(screen.container, 'Save'));
    expect(port.save).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'fmla_family' }), { reason: 'Leave in April' }, 0, expect.objectContaining({ formID: 'form-s', dataVersion: 'v-1' }));
    await show(booting('member-a'));
  }

  it('carries a save that stored a new version while Forms was away into the next save', async () => {
    setPlatform(os);
    await saveSealedThenLeave();
    await act(async () => { answer.resolve({ formID: 'form-s', dataVersion: 'v-2' }); });
    await settle();
    await show(member('member-a'));
    expect((getExposed(screen!.container, 'Leave needed') as HTMLInputElement).value).toBe('Leave in April');
    port.save.mockResolvedValue({ formID: 'form-s', dataVersion: 'v-3' });
    await type(getExposed(screen!.container, 'Leave needed'), 'Leave in May');
    await press(getExposed(screen!.container, 'Save'));
    await settle();
    expect(port.save).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'fmla_family' }), { reason: 'Leave in May' }, 0, expect.objectContaining({ formID: 'form-s', dataVersion: 'v-2' }));
  });

  it('starts no save until the one still on its way ends, then saves on its version', async () => {
    setPlatform(os);
    await saveSealedThenLeave();
    await show(member('member-a'));
    expect(disabled(getExposed(screen!.container, 'Saving…'))).toBe(true);
    await type(getExposed(screen!.container, 'Leave needed'), 'Leave in May');
    await act(async () => { answer.resolve({ formID: 'form-s', dataVersion: 'v-2' }); });
    await settle();
    expect(screen!.container.textContent).toContain('Saved.');
    port.save.mockResolvedValue({ formID: 'form-s', dataVersion: 'v-3' });
    await press(getExposed(screen!.container, 'Save'));
    await settle();
    expect(port.save).toHaveBeenCalledTimes(2);
    expect(port.save).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'fmla_family' }), { reason: 'Leave in May' }, 0, expect.objectContaining({ formID: 'form-s', dataVersion: 'v-2' }));
  });

  it('shows a save that failed while Forms was away, and keeps the answers unsaved', async () => {
    setPlatform(os);
    await saveSealedThenLeave();
    await act(async () => { answer.reject(new FormActionError('failed')); });
    await settle();
    await show(member('member-a'));
    expect(screen!.container.textContent).toContain('The form was not saved. Check your connection and try again.');
    expect((getExposed(screen!.container, 'Leave needed') as HTMLInputElement).value).toBe('Leave in April');
    port.save.mockResolvedValue({ formID: 'form-s', dataVersion: 'v-2' });
    await press(getExposed(screen!.container, 'Save'));
    await settle();
    expect(port.save).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'fmla_family' }), { reason: 'Leave in April' }, 0, expect.objectContaining({ formID: 'form-s', dataVersion: 'v-1' }));
  });

  it('lets a save from before a sign-out reach nothing in the next sign-in', async () => {
    setPlatform(os);
    await saveSealedThenLeave();
    await show({ ...booting('member-a'), mode: 'signedOut', session: null });
    await show(member('member-a'));
    port.openAnswers.mockResolvedValue({ answers: { reason: 'Leave in June' }, dataVersion: 'v-5' });
    await press(getExposed(screen!.container, 'Continue FMLA family care'));
    await settle();
    await act(async () => { answer.resolve({ formID: 'form-s', dataVersion: 'v-9' }); });
    await settle();
    expect(screen!.container.textContent).not.toContain('Saved.');
    port.save.mockResolvedValue({ formID: 'form-s', dataVersion: 'v-6' });
    await type(getExposed(screen!.container, 'Leave needed'), 'Leave in July');
    await press(getExposed(screen!.container, 'Save'));
    await settle();
    expect(port.save).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'fmla_family' }), { reason: 'Leave in July' }, 0, expect.objectContaining({ formID: 'form-s', dataVersion: 'v-5' }));
  });
});

// Gate stage 179: a submission that succeeds after Forms unmounted closes the
// kept editor (r5s2, r6s1), and work from before a change of the settled
// scope reaches no editor opened in the new scope (r5s1, r6s2).
describe.each(PLATFORMS)('work on its way across a return to the foreground, stage 179, on %s', (os) => {
  it('closes the kept editor when its submission succeeds while Forms is away', async () => {
    setPlatform(os);
    port.forms.mockResolvedValue([{ ...draft, signed: true, signatureCurrent: true }]);
    let filed: () => void = () => {};
    port.submit.mockImplementationOnce(() => new Promise<void>((resolve) => { filed = resolve; }));
    port.app = member('member-a');
    screen = await render(h(FeatureScreen, { featureKey: 'forms' }));
    await settle();
    await press(getExposed(screen.container, 'Continue Grievance'));
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    await press(getExposed(screen.container, 'Submit for committee member review'));
    await settle();
    expect(port.submit).toHaveBeenCalledTimes(1);
    await show(booting('member-a'));
    await act(async () => { filed(); });
    await settle();
    await show(member('member-a'));
    expect(editorOpen()).toBe(false);
    expect(screen!.container.textContent).toContain('Form submitted — in review');
  });

  it('lets a save from before a change of campaign reach no editor opened after it', async () => {
    setPlatform(os);
    let answer: (value: { formID: string; dataVersion: string | null }) => void = () => {};
    port.templates.mockResolvedValue([grievance, fmlaFamily]);
    port.forms.mockResolvedValue([draft, { ...draft, id: 'form-s', templateKey: 'fmla_family', answers: {}, sealedMarker: true }]);
    port.openAnswers.mockResolvedValue({ answers: { reason: 'Leave in March' }, dataVersion: 'v-1' });
    port.save.mockImplementationOnce(() => new Promise<{ formID: string; dataVersion: string | null }>((resolve) => { answer = resolve; }));
    port.app = member('member-a');
    screen = await render(h(FeatureScreen, { featureKey: 'forms' }));
    await settle();
    await press(getExposed(screen.container, 'Continue FMLA family care'));
    await settle();
    await type(getExposed(screen.container, 'Leave needed'), 'Leave in April');
    await press(getExposed(screen.container, 'Save'));
    await show(booting('member-a'));
    await show(member('member-a', 'chapter-b'));
    expect(editorOpen()).toBe(false);
    await press(getExposed(screen!.container, 'Continue Grievance'));
    await settle();
    await act(async () => { answer({ formID: 'form-s', dataVersion: 'v-2' }); });
    await settle();
    port.save.mockResolvedValue({ formID: 'form-g', dataVersion: null });
    await type(getExposed(screen!.container, 'Summary'), 'Overtime on the 14th');
    await press(getExposed(screen!.container, 'Save'));
    await settle();
    expect(port.save).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'grievance' }), { summary: 'Overtime on the 14th' }, 0, expect.objectContaining({ formID: 'form-g' }));
  });
});

// Gate stage 180: work that finishes between a Forms screen's first render and
// its subscription is taken, not written over (r8s1), and an older attachment
// list reply never replaces a newer one (r7s1). The attachment list of the
// restored editor reads first, in its own mount effect, before the Forms
// screen subscribes; that is where a completion lands here.
describe.each(PLATFORMS)('the moment between a Forms screen\'s first render and its subscription, stage 180, on %s', (os) => {
  async function openGrievanceReview() {
    port.app = member('member-a');
    screen = await render(h(FeatureScreen, { featureKey: 'forms' }));
    await settle();
    await press(getExposed(screen.container, 'Continue Grievance'));
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    await show(booting('member-a'));
  }
  const landBeforeSubscribe = (update: (editing: FormEdit | null) => FormEdit | null) => {
    port.files.mockImplementationOnce(() => {
      const keeper = port.keeper!;
      keeper.relay(keeper.lineage(), 'member-a', update);
      return Promise.resolve([]);
    });
  };

  it('takes a save that stored a new version in that moment, and saves on it', async () => {
    setPlatform(os);
    await openGrievanceReview();
    landBeforeSubscribe((editing) => (editing ? { ...editing, dataVersion: 'v-2', dirty: false } : editing));
    await show(member('member-a'));
    expect(editorOpen()).toBe(true);
    await press(getExposed(screen!.container, 'Back'));
    await type(getExposed(screen!.container, 'Summary'), 'Overtime on the 15th');
    await press(getExposed(screen!.container, 'Save'));
    await settle();
    expect(port.save).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'grievance' }), { summary: 'Overtime on the 15th' }, 0, expect.objectContaining({ formID: 'form-g', dataVersion: 'v-2' }));
  });

  it('keeps the editor closed when its submission succeeded in that moment', async () => {
    setPlatform(os);
    await openGrievanceReview();
    landBeforeSubscribe(() => null);
    await show(member('member-a'));
    expect(editorOpen()).toBe(false);
    await show(booting('member-a'));
    await show(member('member-a'));
    expect(editorOpen()).toBe(false);
  });

  it('never lets an older attachment list replace the one the restored editor shows', async () => {
    setPlatform(os);
    const second = { ...attached, id: 'file-2', filename: 'roster.pdf' };
    let older: (files: typeof attached[]) => void = () => {};
    port.files.mockImplementationOnce(() => new Promise((resolve) => { older = resolve; }));
    await openGrievanceReview();
    port.files.mockResolvedValue([attached, second]);
    await show(member('member-a'));
    expect(screen!.container.textContent).toContain('roster.pdf');
    await act(async () => { older([attached]); });
    await settle();
    expect(screen!.container.textContent).toContain('roster.pdf');
  });
});
