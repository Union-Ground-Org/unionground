// @vitest-environment jsdom
import { act, createElement as h, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubSessionWriter } from '../testing/stubSessionWriter';
import { Alert, exposedNames, getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import {
  boot, harnessApp, leaveChapter, leaveOrganization, mfa, otherAccount, refuseRead, restore, signIn, signOut, unconfirmReads, type StaffKind,
} from '../testing/retainedDraftHarness';
import { HEALTH_DRIVER_FIELDS } from '../lib/chapterHealth';
import { noteResumeDraftReadFailure } from '../lib/resumeDraftHolder';
import { chapterLifecycleCopy } from '../lib/chapterLifecycleCopy';

//  pull request C (design R-9240D, row C): the campaign draft, Be heard,
// the partnership request and its organization search, and the chapter health
// coaching and measurement editors keep unsent work through a foreground
// session check on the shared draft hook (src/lib/retainedDraft.ts), as the
// learning editor  and the unit editors  do. The host unmounts
// each screen through the check, as FeatureScreen's dashboard gate does, so
// every return is a remount with fresh reads. Each case runs on iPhone and
// Android; the campaign draft and chapter health also run for a chapterless
// (organization) officer. The existing screen suites mock useApp without the
// draft holder, so the harness lives in this suite.

type Platform = 'ios' | 'android';
type Raw = Record<string, unknown>;
// A named move of the session check: the case label and the harness transition.
type Move = [string, () => void];
type Gate = { promise: Promise<void>; open: () => void };
type BeHeardModule = typeof import('../services/beHeard');
type CampaignRegistryModule = typeof import('../services/campaignRegistry');
type ReadDeadlineModule = typeof import('../lib/readDeadline');
const gates: Gate[] = [];
const gate = (): Gate => {
  let open!: () => void;
  const promise = new Promise<void>((done) => { open = done; });
  const made: Gate = { promise, open };
  gates.push(made);
  return made;
};

const server = vi.hoisted(() => ({
  readGate: null as Promise<void> | null,
  writeGate: null as Promise<void> | null,
  // The next read of the named kind is refused with 42501.
  refuse: null as null | 'campaigns' | 'reports' | 'partners' | 'health',
  failNext: null as unknown,
  writes: [] as { kind: string; args: Raw }[],
  attempts: 0,
  measuredOn: null as string | null,
  revisedAt: null as string | null,
  // A shorter write deadline for the timeout rows only.
  deadlineMs: null as number | null,
  // The writer refuses the next snapshot save before anything is sent, as
  // writer.client() does when the session changed: no network write is made.
  presend: null as unknown,
  // The portfolio also holds a second chapter, whose openers stay on screen
  // while the first chapter's form is open.
  secondChapter: false,
  healthReadError: null as Error | null,
  //: the next union organization search fails, and waits for searchHold.
  searchFail: false,
  searchHold: null as Promise<void> | null,
}));
const refreshWorkspace = vi.hoisted(() => vi.fn<() => Promise<void>>());
const refusal = () => Object.assign(new Error('permission denied'), { code: '42501' });
async function read(kind: NonNullable<typeof server.refuse>): Promise<void> {
  if (server.readGate) await server.readGate;
  if (server.refuse === kind) { server.refuse = null; throw refusal(); }
}
async function write(kind: string, args: Raw): Promise<void> {
  server.writes.push({ kind, args });
  if (server.writeGate) await server.writeGate;
  if (server.failNext) { const error = server.failNext; server.failNext = null; throw error; }
}
const writesOf = (kind: string) => server.writes.filter((entry) => entry.kind === kind);

vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../lib/readDeadline', async (original) => {
  const actual = await original<ReadDeadlineModule>();
  return { ...actual, withReadDeadline: <T,>(request: Promise<T>, ms?: number) => actual.withReadDeadline(request, server.deadlineMs ?? ms) };
});
vi.mock('react-native-svg', () => ({ default: () => null, Polyline: () => null }));
vi.mock('../components/ui', () => import('../testing/uiStandIn'));
vi.mock('../state/AppProvider', async () => {
  const { appProviderStandIn } = await import('../testing/retainedDraftHarness');
  return { useApp: () => ({ ...appProviderStandIn.useApp(), refresh: refreshWorkspace }) };
});
vi.mock('expo-router', () => ({ useIsFocused: () => true, useNavigation: () => ({ setOptions: () => {} }), useRouter: () => ({ push: vi.fn(), dismissTo: vi.fn() }), useLocalSearchParams: () => ({}), Redirect: () => null }));
// Attempt keys only need to differ from each other.
vi.mock('expo-crypto', () => ({ randomUUID: () => { server.attempts += 1; return `attempt-${server.attempts}`; } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined), deleteItemAsync: vi.fn(async () => undefined) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('../services/haptics', () => ({ haptics: { success: vi.fn(async () => undefined), select: vi.fn(), warning: vi.fn() } }));
vi.mock('../services/analyticsPreference', () => ({ gatePageViewRecorder: (fn: unknown) => fn, useProductAnalyticsEnabled: () => false }));
vi.mock('../services/observability', () => ({ captureNativeScreen: vi.fn() }));
vi.mock('../services/ssoRelease', () => ({ useSsoReleased: () => false }));
vi.mock('../services/scimRelease', () => ({ useScimReleased: () => false }));
vi.mock('../services/governance', () => ({ loadMobileOfficerRemovalDetails: async () => new Map() }));
vi.mock('../services/nativeCalendarExport', () => ({ calendarExportWasSaved: () => false, exportToDeviceCalendar: vi.fn(), isCalendarExportAvailable: () => false }));
//: the owner hook's queue, shared so a case can count what it announced.
const announced = vi.hoisted(() => vi.fn((_message: string) => () => undefined));
vi.mock('../lib/announce', () => ({ queueAccessibilityAnnouncement: vi.fn(), useAccessibilityAnnouncementQueue: () => announced }));
vi.mock('../lib/screenBack', () => ({ useScreenBackInterceptor: () => {} }));
vi.mock('../lib/useFeaturePageView', () => ({ useFeaturePageView: () => {} }));
vi.mock('../lib/mi1AnalyticsShared', () => ({ normalizeMemberReportCard: () => null }));
vi.mock('../lib/connectedWorkflows', () => ({ connectedWorkflowApi: () => null }));
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: ({ children }: { children?: unknown }) => children, useScreenNameAlreadySpoken: () => ({ hiddenProps: {} }) }));
vi.mock('../components/SupportLink', () => ({ SupportLink: () => null }));
vi.mock('../data/useChannels', () => ({ useChannelStore: () => ({ subscribe: () => () => {}, getVersion: () => 0, channels: () => [] }) }));
vi.mock('../components/AskCompassButton', () => ({ AskCompassButton: () => null }));
vi.mock('../components/ChapterVerificationControls', () => ({ ChapterConnectionVerification: () => null }));
vi.mock('../components/StaffRolePicker', () => ({ StaffRolePicker: () => null }));
vi.mock('../components/WorkflowActions', () => ({ WorkflowActions: () => null }));
vi.mock('../components/AttachmentPanel', () => ({ AttachmentPanel: () => null }));
vi.mock('../components/QuarterlySurveyGate', () => ({ QuarterlySurveyGate: () => null }));
vi.mock('./LiveAppointmentsFeature', () => ({ LiveAppointmentsFeature: () => null }));
vi.mock('./MemberSupportScreen', () => ({ MemberSupportScreen: () => null }));
vi.mock('./ChapterMembershipsScreen', () => ({ ChapterMembershipsScreen: () => null }));
vi.mock('./ChapterInvitationsScreen', () => ({ ChapterInvitationsScreen: () => null }));
vi.mock('./OrgStructureScreen', () => ({ OrgStructureScreen: () => null }));
vi.mock('./mi1/PayToolsScreen', () => ({ PayToolsRoute: () => null }));
vi.mock('./mi1/Mi1FeatureScreen', () => ({ Mi1FeatureScreen: () => null }));
vi.mock('./mi1/Mi1AnalyticsScreen', () => ({ Mi1AnalyticsScreen: () => null }));
vi.mock('./mi1/ConnectionSuggestionsPanel', () => ({ ConnectionSuggestionsPanel: () => null }));
vi.mock('./mi1/OrganizationIntelligenceScreens', () => ({ CollectiveActionsScreen: () => null, OrganizationIntelligenceScreen: () => null }));
vi.mock('./mi1/Mi1QaFeatureScreen', () => ({ Mi1QaFeatureScreen: () => null }));
vi.mock('./learning/LearningContentManager', () => ({ LearningContentManager: () => null }));
vi.mock('./learning/LearningLibrarySection', () => ({ LearningLibrarySection: () => null }));
vi.mock('./guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null, NativeCoachMark: () => null, NativeOrgStartGuide: () => null }));
vi.mock('./guideLayers/StaffGuides', () => ({ NativeStaffGuides: () => null }));
vi.mock('./StewardDeskSectionsScreen', () => ({ StewardDeskSectionsScreen: () => null }));
vi.mock('./ChapterNoticesScreen', () => ({ ChapterNoticesScreen: () => null }));
vi.mock('./LiveLivedInScreens', () => ({ LiveLivedInScreen: () => null, LiveSurveyHistory: () => null }));
vi.mock('./TaskDocumentHandoffProvider', () => ({ useTaskDocumentHandoff: () => ({ active: false, pending: null }) }));
vi.mock('./WorkFilterPresetsCard', () => ({ WorkFilterButton: () => null, WorkFilterPresetsCard: () => null }));
vi.mock('./ContextualPulseCard', () => ({ ContextualPulseCard: () => null, useNativeContextualPulse: () => null }));
vi.mock('./RightsResumeReading', () => ({ ContinueReadingCard: () => null, RightsReadingSections: () => null, rightsBookmarks: {}, useRightsBookmark: () => null, useRightsReadingScope: () => null }));
vi.mock('./CaseRowTopicCards', () => ({ ChapterCaseRowTopicCard: () => null }));

// The screens' reads and writes, answered as the server answers them: a
// campaign draft, a Be heard report and a coaching entry insert a new row with
// no key; a partnership request deduplicates by its idempotency key; a health
// snapshot replaces the chapter's snapshot for that date.
vi.mock('../services/supabase', () => ({
  captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => ({}), session?.user?.id ?? 'nobody'),
  getSupabaseClient: () => null,
  recordMobileFeaturePageView: vi.fn(async () => undefined),
  CHAPTER_BOUND_EVIDENCE_KEYS: new Set<string>(),
  loadMobileHandshakes: async () => { await read('partners'); return []; },
  loadMobileHandshakeTargets: async () => { await read('partners'); return [{ id: 'org-b', name: 'Pine Ridge Local', location: null }]; },
  loadMobileChapterBinding: async () => { await read('partners'); return null; },
  loadMobileHandshakeDocuments: async () => { await read('partners'); return []; },
  requestMobileHandshake: async (_writer: unknown, fields: Raw) => { await write('handshake', fields); },
  searchMobileUnionOrganizations: async () => {
    if (server.searchHold) await server.searchHold;
    if (server.searchFail) { server.searchFail = false; throw new Error('fixture search offline'); }
    return [];
  },
  requestMobileChapterBinding: async () => undefined,
  respondMobileHandshake: async () => undefined,
  countersignMobileHandshake: async () => undefined,
  closeMobileHandshake: async () => undefined,
  shareMobileHandshakeDocument: async () => undefined,
  loadMobileHealthPortfolio: async () => {
    await read('health');
    if (server.healthReadError) {
      const error = server.healthReadError;
      server.healthReadError = null;
      throw error;
    }
    const first = { chapterId: 'chapter-a', chapterName: 'Quillmere campaign', databaseDate: '2026-11-11', measuredOn: server.measuredOn, revisedAt: server.revisedAt,
      cohortProtected: false, memberCount: 40, score: null, drivers: server.measuredOn ? { participation: 50, caseTimeliness: 50, stewardCapacity: 50, trainingCoverage: 50, communicationReach: 50, governanceReadiness: 50 } : null,
      trend: [], coaching: [] };
    return server.secondChapter ? [first, { ...first, chapterId: 'chapter-b', chapterName: 'Larchmont campaign', measuredOn: null, revisedAt: null, drivers: null }] : [first];
  },
  addMobileHealthCoaching: async (_writer: unknown, chapterID: string, summary: string, nextAction: string, attentionLevel: string) => {
    await write('coaching', { chapterID, summary, nextAction, attentionLevel });
  },
  recordMobileHealthSnapshot: async (_writer: unknown, chapterID: string, measuredOn: string, drivers: Raw) => {
    if (server.presend) { const refused = server.presend; server.presend = null; throw refused; }
    await write('snapshot', { chapterID, measuredOn, drivers });
  },
}));
vi.mock('../services/beHeard', async (original) => ({
  ...await original<BeHeardModule>(),
  loadMyBeHeardReports: async () => { await read('reports'); return []; },
  sendBeHeardReport: async (_writer: unknown, draft: Raw) => { await write('report', draft); },
}));
vi.mock('../services/campaignRegistry', async (original) => {
  const harness = await import('../testing/retainedDraftHarness');
  return {
    ...await original<CampaignRegistryModule>(),
    loadCampaignRegistryPage: async () => {
      await read('campaigns');
      const chapter = harness.harnessApp().dashboard?.member.chapterID != null;
      return { campaigns: [], counts: { all: 0, draft: 0, open: 0, closed: 0 }, nextCursor: null, canManageChapter: chapter, canManageUnion: !chapter };
    },
    saveMobileCampaignDraft: async (_writer: unknown, args: Raw) => { await write('campaign', args); },
  };
});

const { LiveCampaignsScreen, LiveBeHeardScreen } = await import('./LiveFeatureScreens');
const { LivePartnersFeature, LiveHealthFeature } = await import('./FeatureScreen');
const { useApp } = await import('../state/AppProvider');

type Editor = 'campaign' | 'report' | 'partnership' | 'search' | 'coaching' | 'snapshot';
const SCREENS: Record<Editor, () => ReactElement> = {
  campaign: () => h(LiveCampaignsScreen),
  report: () => h(LiveBeHeardScreen),
  partnership: () => h(LivePartnersFeature),
  search: () => h(LivePartnersFeature),
  coaching: () => h(LiveHealthFeature, { title: 'Campaign health' }),
  snapshot: () => h(LiveHealthFeature, { title: 'Campaign health' }),
};
// The host shows the screen only while signed in with a dashboard, as
// FeatureScreen's dashboard gate does.
function Host({ editor }: { editor: Editor }) {
  const { mode, dashboard } = useApp();
  return mode === 'authenticated' && dashboard ? SCREENS[editor]() : null;
}

let screen: Rendered | null = null;
let editor: Editor = 'campaign';
const flush = async () => { await act(async () => { for (let turn = 0; turn < 12; turn += 1) await Promise.resolve(); }); };
async function open(next: Editor): Promise<Rendered> {
  editor = next;
  screen = await render(h(Host, { editor }));
  await flush();
  return screen;
}
async function rerender(): Promise<void> { await screen!.rerender(h(Host, { editor })); await flush(); }
const text = () => screen!.container.textContent ?? '';
const shows = (name: string) => exposedNames(screen!.container).includes(name);
const field = (label: string) => getExposed(screen!.container, label) as HTMLInputElement;
const tap = async (label: string) => { await press(getExposed(screen!.container, label)); await flush(); };
// Typed work is in input values, not in the page text: blank means the field
// is gone (the editor closed) or empty.
const blank = (spec: Spec) => !shows(spec.field) || field(spec.field).value === '';
// The session check: the host unmounts the screen, then the reads come back.
async function leave(): Promise<void> { boot(); await rerender(); }
async function resume(): Promise<void> { await leave(); restore(); await rerender(); }

// What each editor's typed work is, how it is typed, read back and sent.
type Spec = {
  label: string;
  // The field read back after the check, and the value typed into it.
  field: string;
  typed: string;
  fill: () => Promise<void>;
  // Opens the editor again on a remount when it has to be opened.
  reopen?: () => Promise<void>;
  send?: string;
  kind?: string;
  // A thrown error the screen cannot tell from a lost answer.
  lost?: () => unknown;
  // A refusal the server gave: nothing was saved.
  definite?: () => unknown;
  definiteCopy?: string;
  uncertainCopy?: string;
  again?: string;
  discard?: string;
  refuse: NonNullable<typeof server.refuse>;
  retry: string;
  // The composer waits for the screen's own read. Be heard's composer needs
  // no read of its own (a failed history read never hid it on Main), so only
  // the provider's reads conceal it.
  ownRead: boolean;
};
const CAMPAIGN_UNCERTAIN = 'We could not confirm this draft was saved. Check the campaign list first: saving it again may make a second draft.';
const REPORT_UNCERTAIN = 'We could not confirm your report was sent. Check What you sent first: sending it again may send it twice.';
const PARTNERSHIP_UNCERTAIN = 'We could not confirm this request was sent. Sending it again will not make a second request.';
const COACHING_UNCERTAIN = 'We could not confirm this coaching entry was saved. Check the campaign’s coaching notes first: saving it again may add it twice.';
const SNAPSHOT_STALE = 'This snapshot changed while you were away. Your measures are kept here; cancel to start from the new snapshot.';
const SNAPSHOT_UNCERTAIN = 'We could not confirm these measures were saved. Check the campaign’s latest snapshot first: saving again replaces the snapshot for that date.';
const SNAPSHOT_FAILED = 'The health snapshot was not confirmed. Check the date, measures, and your leadership access.';
// The writer refused before sending: the one failure that proves nothing was
// saved. Only the WriterSessionChanged object the writer itself throws counts.
const { WriterSessionChanged } = await import('../../../../src/lib/sessionBoundWriter.js');
const writerRefusal = () => new WriterSessionChanged();
// Ledger 714: an error that only copies the writer's marker (a server or
// gateway body can carry any details) proves nothing about the write.
const copiedMarker = () => Object.assign(new Error('The account changed before this was sent.'), { details: 'writer_session_changed' });
const RETRY_REFUSED = 'Save again was refused before it was sent. The first save is still unconfirmed, so the measures stay locked.';
async function fillDrivers(): Promise<void> {
  for (const driver of HEALTH_DRIVER_FIELDS) await type(field(`${driver.label}, 0 to 100`), '60');
}
const SPECS: Record<Editor, Spec> = {
  campaign: {
    label: 'campaign draft', field: 'Title in English', typed: 'Spring contract vote',
    fill: async () => {
      await tap('Write a draft');
      await type(field('Title in English'), 'Spring contract vote');
      await type(field('Choice 1'), 'Yes');
      await type(field('Choice 2'), 'No');
    },
    send: 'Save draft', kind: 'campaign',
    lost: () => new TypeError('Network request failed'),
    definite: () => Object.assign(new Error('not allowed'), { code: '42501' }),
    definiteCopy: 'This account cannot write a campaign for that audience.',
    uncertainCopy: CAMPAIGN_UNCERTAIN, again: 'Save again', discard: 'Cancel',
    refuse: 'campaigns', retry: 'Try again', ownRead: true,
  },
  report: {
    label: 'Be heard report', field: 'Title', typed: 'Broken heater in bay 3',
    fill: async () => {
      await tap('Safety');
      await type(field('Title'), 'Broken heater in bay 3');
      await type(field('Your message'), 'The heater in bay 3 has been out since Monday.');
    },
    send: 'Send to the campaign', kind: 'report',
    lost: () => new Error('Your report was not sent. Check your connection and try again.'),
    definite: () => new Error('Union Ground did not accept your report, so it was not sent. Try again later, or tell a committee member in person.'),
    definiteCopy: 'Union Ground did not accept your report, so it was not sent. Try again later, or tell a committee member in person.',
    uncertainCopy: REPORT_UNCERTAIN, again: 'Send again', discard: 'Discard this report',
    refuse: 'reports', retry: 'Try again', ownRead: false,
  },
  partnership: {
    label: 'partnership request', field: 'Agreement request title', typed: 'Shared grievance files',
    fill: async () => {
      await tap('Start agreement request');
      await type(field('Agreement request title'), 'Shared grievance files');
      await type(field('Agreement request purpose'), 'Coordinate the joint filing.');
    },
    send: 'Send two-sided request', kind: 'handshake',
    lost: () => new Error('The sister campaign is no longer verified or the request was not confirmed. Refresh and try again.'),
    uncertainCopy: PARTNERSHIP_UNCERTAIN, again: 'Send again', discard: 'Discard this request',
    refuse: 'partners', retry: 'Refresh', ownRead: true,
  },
  search: {
    label: 'partner organization search', field: 'Find the real union organization', typed: 'Pine Ridge',
    fill: async () => { await type(field('Find the real union organization'), 'Pine Ridge'); },
    refuse: 'partners', retry: 'Refresh', ownRead: true,
  },
  coaching: {
    label: 'coaching entry', field: 'Coaching summary', typed: 'Weekly committee member check-in held',
    fill: async () => {
      await tap('Add coaching entry');
      await type(field('Coaching summary'), 'Weekly committee member check-in held');
    },
    send: 'Save coaching entry', kind: 'coaching',
    lost: () => new Error('The coaching note was not confirmed. Refresh your authorization and try again.'),
    uncertainCopy: COACHING_UNCERTAIN, again: 'Save again', discard: 'Cancel',
    refuse: 'health', retry: 'Try again', ownRead: true,
  },
  snapshot: {
    // Measured on the database date, so no replace prompt opens.
    label: 'health measurement', field: 'Participation, 0 to 100', typed: '61',
    fill: async () => {
      await tap('Record snapshot');
      await fillDrivers();
      await type(field('Participation, 0 to 100'), '61');
    },
    send: 'Save snapshot', kind: 'snapshot',
    //  round 1: a server error the service cannot tell from a lost answer
    // locks the measures; only the writer's refusal returns them editable.
    lost: () => new Error('The health snapshot was not confirmed. Check the date, measures, and your leadership access.'),
    definite: writerRefusal, definiteCopy: SNAPSHOT_FAILED,
    uncertainCopy: SNAPSHOT_UNCERTAIN, again: 'Save again', discard: 'Discard',
    refuse: 'health', retry: 'Try again', ownRead: true,
  },
};
const EDITORS = Object.keys(SPECS) as Editor[];
const WRITERS = EDITORS.filter((name) => SPECS[name].send !== undefined);
const LOST = EDITORS.filter((name) => SPECS[name].lost !== undefined);
const DEFINITE = EDITORS.filter((name) => SPECS[name].definite !== undefined);

beforeEach(() => {
  signIn('chapter');
  server.healthReadError = null;
  server.searchFail = false;
  server.searchHold = null;
  Object.assign(server, { readGate: null, writeGate: null, refuse: null, failNext: null, writes: [], attempts: 0, measuredOn: null, revisedAt: null, deadlineMs: null, presend: null, secondChapter: false });
  // A correction replaces the latest snapshot, so it asks first: confirm it the
  // way the person would (its last button).
  vi.spyOn(Alert, 'alert').mockImplementation((...args: unknown[]) => {
    const buttons: unknown = args[2];
    if (!Array.isArray(buttons)) return;
    const last: unknown = buttons[buttons.length - 1];
    const onPress: unknown = typeof last === 'object' && last !== null ? Reflect.get(last, 'onPress') : null;
    if (typeof onPress === 'function') onPress();
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const held of gates.splice(0)) held.open();
  await screen?.unmount(); screen = null;
  setPlatform('ios');
});

describe('saved work checks in Partners and Campaign health', () => {
  const failureCopy = {
    en: 'Your saved work could not be checked. Check your connection and try again.',
    es: 'No se pudo comprobar tu trabajo guardado. Revisa tu conexión y vuelve a intentarlo.',
  };

  it.each<[Editor, keyof typeof failureCopy, string]>([
    ['partnership', 'en', 'Try again'],
    ['search', 'es', 'Reintentar'],
    ['coaching', 'en', 'Try again'],
    ['snapshot', 'es', 'Reintentar'],
  ])('offers a workspace retry for %s in %s and restores the draft', async (name, language, retry) => {
    const spec = SPECS[name];
    await open(name);
    await spec.fill();
    unconfirmReads();
    harnessApp().memberLanguage = language;
    await rerender();
    expect(shows(spec.field)).toBe(false);
    expect(shows(retry)).toBe(false);

    await act(async () => { noteResumeDraftReadFailure({ status: 0 }); });
    expect(text()).toContain(failureCopy[language]);
    expect(exposedNames(screen!.container).filter((label) => label === retry)).toHaveLength(1);
    if (name === 'coaching' || name === 'snapshot') {
      expect(shows('Add coaching entry')).toBe(false);
      expect(shows('Record snapshot')).toBe(false);
    }

    refreshWorkspace.mockReset().mockImplementation(async () => { restore(); });
    await tap(retry);
    expect(refreshWorkspace).toHaveBeenCalledExactlyOnceWith('user-refresh');
    await rerender();
    if (spec.reopen) await spec.reopen();
    expect(field(spec.field).value).toBe(spec.typed);
    expect(text()).not.toContain(failureCopy[language]);
    expect(shows(retry)).toBe(false);
  });

  it.each<[keyof typeof failureCopy, string]>([
    ['en', 'Check saved work again'],
    ['es', 'Volver a revisar el trabajo guardado'],
  ])('distinguishes the two Campaign health retries in %s', async (language, savedWorkRetry) => {
    await open('coaching');
    await SPECS.coaching.fill();
    server.healthReadError = new Error('Portfolio read failed');
    await tap('Save coaching entry');
    expect(text()).toContain('Showing the last confirmed portfolio.');

    unconfirmReads();
    harnessApp().memberLanguage = language;
    await rerender();
    await act(async () => { noteResumeDraftReadFailure({ status: 0 }); });
    expect(text()).toContain(failureCopy[language]);
    expect(exposedNames(screen!.container).filter((label) => label === 'Try again')).toHaveLength(1);
    expect(shows(savedWorkRetry)).toBe(true);

    refreshWorkspace.mockReset().mockImplementation(async () => { restore(); });
    await tap(savedWorkRetry);
    expect(refreshWorkspace).toHaveBeenCalledExactlyOnceWith('user-refresh');
    await rerender();
    expect(text()).not.toContain(failureCopy[language]);
    expect(text()).toContain('Showing the last confirmed portfolio.');
    await tap('Try again');
    expect(text()).not.toContain('Showing the last confirmed portfolio.');
    expect(refreshWorkspace).toHaveBeenCalledTimes(1);
  });
});

describe.each<Platform>(['ios', 'android'])('pull request C editors through a session check on %s', (os) => {
  beforeEach(() => { setPlatform(os); });

  describe.each<Editor>(EDITORS)('%s', (name) => {
    const spec = SPECS[name];

    it('1. the same person returns to the exact typed work', async () => {
      await open(name); await spec.fill();
      await resume();
      expect(field(spec.field).value).toBe(spec.typed);
    });

    it('2. nothing held shows while the provider reads are pending', async () => {
      await open(name); await spec.fill();
      await leave();
      unconfirmReads(); await rerender();
      expect(blank(spec)).toBe(true);
      expect(shows(spec.field)).toBe(false);
      restore(); await rerender();
      expect(field(spec.field).value).toBe(spec.typed);
    });

    it.runIf(spec.ownRead)("2b. nothing held shows while the screen's own read is pending", async () => {
      await open(name); await spec.fill();
      await leave();
      const held = gate(); server.readGate = held.promise;
      restore(); await rerender();
      expect(blank(spec)).toBe(true);
      expect(shows(spec.field)).toBe(false);
      held.open(); server.readGate = null; await flush();
      expect(field(spec.field).value).toBe(spec.typed);
    });

    it('3. another account starts blank', async () => {
      await open(name); await spec.fill();
      await leave(); otherAccount(); await rerender();
      expect(blank(spec)).toBe(true);
    });

    it.each<Move>([['a left campaign', leaveChapter], ['a left organization', leaveOrganization]])('4. %s starts blank', async (_move, move) => {
      await open(name); await spec.fill();
      await leave(); move(); await rerender();
      restore(); await rerender();
      expect(blank(spec)).toBe(true);
    });

    it("5. an authoritative refusal of the screen's own read retires the work", async () => {
      await open(name); await spec.fill();
      server.refuse = spec.refuse;
      await resume();
      await tap(spec.retry);
      expect(blank(spec)).toBe(true);
    });

    it("5b. the provider's own refusal retires the work", async () => {
      await open(name); await spec.fill();
      await leave(); refuseRead(); restore(); await rerender();
      expect(blank(spec)).toBe(true);
    });

    it.each<Move>([['sign-out', signOut], ['an MFA challenge', mfa]])('6. %s retires the work', async (_move, move) => {
      await open(name); await spec.fill();
      await leave(); move(); await rerender();
      restore(); await rerender();
      expect(blank(spec)).toBe(true);
    });
  });

  describe.each<Editor>(WRITERS)('%s write', (name) => {
    const spec = SPECS[name];
    const send = spec.send!;
    const kind = spec.kind!;

    it('7. a write in flight at the check that lands leaves the returning editor blank, written once', async () => {
      await open(name); await spec.fill();
      const held = gate(); server.writeGate = held.promise;
      await tap(send);
      await leave();
      held.open(); await flush();
      restore(); await rerender();
      expect(writesOf(kind)).toHaveLength(1);
      expect(blank(spec)).toBe(true);
      if (spec.uncertainCopy) expect(text()).not.toContain(spec.uncertainCopy);
    });

    it('7b. a write in flight cannot be sent again from the returning editor', async () => {
      await open(name); await spec.fill();
      const held = gate(); server.writeGate = held.promise;
      await tap(send);
      await resume();
      if (shows(send)) await tap(send);
      expect(writesOf(kind)).toHaveLength(1);
      held.open(); await flush();
      expect(writesOf(kind)).toHaveLength(1);
    });
  });

  describe.each<Editor>(DEFINITE)('%s definite failure', (name) => {
    const spec = SPECS[name];

    it('8. a definite refusal of a write in flight returns the work editable', async () => {
      await open(name); await spec.fill();
      const held = gate(); server.writeGate = held.promise; server.failNext = spec.definite!();
      await tap(spec.send!);
      await leave();
      held.open(); await flush();
      restore(); await rerender();
      expect(field(spec.field).value).toBe(spec.typed);
      expect(field(spec.field).disabled).toBe(false);
      expect(text()).toContain(spec.definiteCopy!);
    });
  });

  describe.each<Editor>(LOST)('%s lost answer', (name) => {
    const spec = SPECS[name];

    it('9. a lost answer is locked, offers Discard, and is sent again only on a deliberate tap', async () => {
      await open(name); await spec.fill();
      const held = gate(); server.writeGate = held.promise; server.failNext = spec.lost!();
      await tap(spec.send!);
      await leave();
      held.open(); await flush();
      server.writeGate = null;
      restore(); await rerender();
      expect(text()).toContain(spec.uncertainCopy!);
      expect(field(spec.field).value).toBe(spec.typed);
      expect(field(spec.field).disabled).toBe(true);
      expect(writesOf(spec.kind!)).toHaveLength(1);
      await tap(spec.again!);
      expect(writesOf(spec.kind!)).toHaveLength(2);
      if (spec.kind === 'handshake') expect(writesOf('handshake')[1]!.args.idempotencyKey).toBe(writesOf('handshake')[0]!.args.idempotencyKey);
      expect(blank(spec)).toBe(true);
    });

    it('10. Discard clears unconfirmed work and sends nothing', async () => {
      await open(name); await spec.fill();
      server.failNext = spec.lost!();
      await tap(spec.send!);
      await resume();
      expect(text()).toContain(spec.uncertainCopy!);
      await tap(spec.discard!);
      expect(blank(spec)).toBe(true);
      expect(text()).not.toContain(spec.uncertainCopy!);
      expect(writesOf(spec.kind!)).toHaveLength(1);
    });

    it('10b. an error that only copies the writer marker stays locked as unconfirmed (ledger 714)', async () => {
      await open(name); await spec.fill();
      server.failNext = copiedMarker();
      await tap(spec.send!);
      expect(text()).toContain(spec.uncertainCopy!);
      expect(field(spec.field).value).toBe(spec.typed);
      expect(field(spec.field).disabled).toBe(true);
      expect(shows(spec.again!)).toBe(true);
      expect(writesOf(spec.kind!)).toHaveLength(1);
    });
  });

  it('11. a correction typed against a snapshot that changed meanwhile is kept, says so, and saves nothing over it', async () => {
    server.measuredOn = '2026-11-01'; server.revisedAt = '2026-11-02T12:00:00Z';
    await open('snapshot');
    await tap('Correct latest snapshot');
    await type(field('Participation, 0 to 100'), '77');
    server.revisedAt = '2026-11-03T12:00:00Z';
    await resume();
    expect(field('Participation, 0 to 100').value).toBe('77');
    expect(text()).toContain(SNAPSHOT_STALE);
    await tap('Save correction');
    expect(writesOf('snapshot')).toHaveLength(0);
    await tap('Cancel');
    expect(shows('Participation, 0 to 100')).toBe(false);
    expect(text()).not.toContain(SNAPSHOT_STALE);
  });

  //  round 1: a measurement or correction save whose answer was
  // lost, or that ran past the deadline, may have saved. It stays locked with
  // Save again and Discard, through a session check too; no ordinary Save
  // unlocks it, and nothing is sent again without a deliberate tap.
  type Unknown = 'lost' | 'timeout';
  type Measure = 'snapshot' | 'correction';
  const MEASURES: [Measure, Unknown][] = [['snapshot', 'lost'], ['snapshot', 'timeout'], ['correction', 'lost'], ['correction', 'timeout']];
  async function unknownMeasureSave(measure: Measure, unknown: Unknown): Promise<string> {
    if (measure === 'correction') { server.measuredOn = '2026-11-11'; server.revisedAt = '2026-11-02T12:00:00Z'; }
    await open('snapshot');
    if (measure === 'snapshot') { await tap('Record snapshot'); await fillDrivers(); }
    else await tap('Correct latest snapshot');
    await type(field('Participation, 0 to 100'), '61');
    if (unknown === 'lost') server.failNext = SPECS.snapshot.lost!();
    else { server.deadlineMs = 5; server.writeGate = gate().promise; }
    const save = measure === 'snapshot' ? 'Save snapshot' : 'Save correction';
    await tap(save);
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
    await flush();
    server.deadlineMs = null; server.writeGate = null;
    return save;
  }
  function expectLocked(save: string): void {
    expect(text()).toContain(SNAPSHOT_UNCERTAIN);
    expect(field('Participation, 0 to 100').value).toBe('61');
    expect(field('Participation, 0 to 100').disabled).toBe(true);
    expect(shows('Save again')).toBe(true);
    expect(shows('Discard')).toBe(true);
    expect(shows(save)).toBe(false);
    expect(writesOf('snapshot')).toHaveLength(1);
  }

  it.each<[Measure, Unknown]>(MEASURES)('13. a %s save with a %s answer stays locked, through a session check, until Discard; written once', async (measure, unknown) => {
    const save = await unknownMeasureSave(measure, unknown);
    expectLocked(save);
    await resume();
    expectLocked(save);
    await tap('Discard');
    expect(shows('Participation, 0 to 100')).toBe(false);
    expect(text()).not.toContain(SNAPSHOT_UNCERTAIN);
    expect(writesOf('snapshot')).toHaveLength(1);
  });

  it.each<[Measure, Unknown]>(MEASURES)('14. a %s save with a %s answer is sent again only on a deliberate Save again, with the same measures', async (measure, unknown) => {
    const save = await unknownMeasureSave(measure, unknown);
    expectLocked(save);
    await resume();
    expectLocked(save);
    await tap('Save again');
    const sent = writesOf('snapshot');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.args).toEqual(sent[0]!.args);
    expect(shows('Participation, 0 to 100')).toBe(false);
    expect(writesOf('snapshot')).toHaveLength(2);
  });

  it('15. the writer refusing a correction before sending returns it editable', async () => {
    server.measuredOn = '2026-11-11'; server.revisedAt = '2026-11-02T12:00:00Z';
    await open('snapshot');
    await tap('Correct latest snapshot');
    await type(field('Participation, 0 to 100'), '61');
    // Refused before sending: no network write is made.
    server.presend = writerRefusal();
    await tap('Save correction');
    expect(text()).not.toContain(SNAPSHOT_UNCERTAIN);
    expect(field('Participation, 0 to 100').disabled).toBe(false);
    expect(shows('Save correction')).toBe(true);
    expect(writesOf('snapshot')).toHaveLength(0);
  });

  //  final (Sol): the first write timed out and may still commit. A Save
  // again that the writer refuses before sending proves nothing about it, so
  // the lock stays, with the refusal beside Save again and Discard, through a
  // session check too; only Discard (or a confirmed save) releases it.
  //  round 1: opening the other health form never discards a
  // save that may have committed. The opener is refused while a form holds an
  // unconfirmed save, and the text and its lock stay, with one write.
  it('17. a timed-out snapshot save keeps its text and lock when the coaching opener is tapped', async () => {
    server.secondChapter = true;
    const save = await unknownMeasureSave('snapshot', 'timeout');
    expectLocked(save);
    await tap('Add coaching entry');
    expectLocked(save);
    expect(shows('Coaching summary')).toBe(false);
    expect(server.writes).toHaveLength(1);
  });

  it('17b. a timed-out coaching save keeps its text and lock when the snapshot opener is tapped', async () => {
    await open('coaching'); await SPECS.coaching.fill();
    server.deadlineMs = 5; server.writeGate = gate().promise;
    await tap('Save coaching entry');
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
    await flush();
    server.deadlineMs = null; server.writeGate = null;
    const expectCoachingLocked = () => {
      expect(text()).toContain(COACHING_UNCERTAIN);
      expect(field('Coaching summary').value).toBe('Weekly committee member check-in held');
      expect(field('Coaching summary').disabled).toBe(true);
      expect(shows('Save again')).toBe(true);
      expect(shows('Cancel')).toBe(true);
      expect(writesOf('coaching')).toHaveLength(1);
    };
    expectCoachingLocked();
    await tap('Record snapshot');
    expectCoachingLocked();
    expect(shows('Participation, 0 to 100')).toBe(false);
    expect(server.writes).toHaveLength(1);
    await tap('Cancel');
    expect(shows('Coaching summary')).toBe(false);
    expect(server.writes).toHaveLength(1);
  });

  it.each<Measure>(['snapshot', 'correction'])('16. a refused Save again after an unconfirmed %s save keeps the lock until Discard; one network write', async (measure) => {
    const save = await unknownMeasureSave(measure, 'timeout');
    expectLocked(save);
    server.presend = writerRefusal();
    await tap('Save again');
    expectLocked(save);
    expect(text()).toContain(RETRY_REFUSED);
    await resume();
    expectLocked(save);
    expect(writesOf('snapshot')).toHaveLength(1);
    await tap('Discard');
    expect(shows('Participation, 0 to 100')).toBe(false);
    expect(text()).not.toContain(SNAPSHOT_UNCERTAIN);
    expect(text()).not.toContain(RETRY_REFUSED);
    expect(writesOf('snapshot')).toHaveLength(1);
  });

  it('12. a keyed partnership retry after a lost answer carries the same idempotency key', async () => {
    await open('partnership'); await SPECS.partnership.fill();
    server.failNext = SPECS.partnership.lost!();
    await tap('Send two-sided request');
    await tap('Send again');
    const sent = writesOf('handshake');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.args.idempotencyKey).toBe(sent[0]!.args.idempotencyKey);
  });

  describe.each<Editor>(['campaign', 'coaching', 'snapshot'])('%s for a chapterless officer', (name) => {
    const spec = SPECS[name];
    beforeEach(() => { signIn('chapterless' satisfies StaffKind); });

    it('1. the same person returns to the exact typed work', async () => {
      await open(name); await spec.fill();
      await resume();
      expect(field(spec.field).value).toBe(spec.typed);
    });

    it('3. another account starts blank', async () => {
      await open(name); await spec.fill();
      await leave(); otherAccount(); await rerender();
      expect(blank(spec)).toBe(true);
    });
  });
});

// BUG-UG-PHONE-PARTNERS-UNION-SEARCH-EMPTY-AND-FAILED-LOOK-ALIKE-20261125
//: on Chapter agreements, an admin's union
// search that matched nothing showed nothing at all, and a failed search showed
// the binding request's error. Each now says what happened, beside the search.
const SEARCH_LANGUAGES: Array<'en' | 'es'> = ['en', 'es'];
describe.each(SEARCH_LANGUAGES)('the union organization search on Campaign agreements, in %s', (language) => {
  const copy = chapterLifecycleCopy[language];
  const search = async () => {
    harnessApp().dashboard!.member.language = language;
    await open('search');
    await type(field(copy.bindingSearchLabel), 'Fictional Ridge');
    await tap(copy.bindingSearch);
  };

  it('says no union organization matched a search with no results, announced once', async () => {
    setPlatform('ios');
    announced.mockClear();
    await search();
    expect(text()).toContain(copy.bindingSearchEmpty);
    expect(announced.mock.calls.filter(([message]) => message === copy.bindingSearchEmpty)).toHaveLength(1);
    expect(text()).not.toContain(copy.bindingRequestError);
    // Typing again clears the answer until the next search.
    await type(field(copy.bindingSearchLabel), 'Fictional Ridge Local');
    expect(text()).not.toContain(copy.bindingSearchEmpty);
  });

  it('says the search could not be completed, not the binding request error', async () => {
    server.searchFail = true;
    await search();
    expect(text()).toContain(copy.bindingSearchFailed);
    expect(text()).not.toContain(copy.bindingRequestError);
    expect(text()).not.toContain(copy.bindingSearchEmpty);
    await tap(copy.bindingSearch);
    expect(text()).not.toContain(copy.bindingSearchFailed);
    expect(text()).toContain(copy.bindingSearchEmpty);
  });

  it.each([['no match', false], ['a failure', true]] as Array<[string, boolean]>)(
    'says nothing when the query changes before the answer (%s) lands', async (_answer, fail) => {
      harnessApp().dashboard!.member.language = language;
      await open('search');
      await type(field(copy.bindingSearchLabel), 'Fictional Ridge');
      let release = () => {};
      server.searchHold = new Promise<void>((resolve) => { release = resolve; });
      server.searchFail = fail;
      await tap(copy.bindingSearch);
      await type(field(copy.bindingSearchLabel), 'Fictional Ridge Local');
      server.searchHold = null;
      await act(async () => { release(); });
      await flush();
      expect(text()).not.toContain(copy.bindingSearchEmpty);
      expect(text()).not.toContain(copy.bindingSearchFailed);
    });
});
