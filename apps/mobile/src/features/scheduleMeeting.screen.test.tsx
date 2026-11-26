import { stubSessionWriter } from '../testing/stubSessionWriter';
// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubPlainRequire } from '../testing/plainRequire';
import { exposedNames, getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import { defaultMeetingStart, stepMeetingDay } from '../lib/chapterMeeting';
import { nativeUiText, type NativeUiKey } from '../lib/nativeUiCopy';

// BUG-UG-NATIVE-OFFICERS-CANNOT-INVITE-SCHEDULE-OR-DRAFT-ON-THE-PHONE-20261118
// (#9099, part 1 of 4): working as Chapter Administrator, an officer opens the
// Events desk ("Events & check-in codes"), schedules a chapter meeting, and the
// saved row is in the desk's list. The stand-in backend answers
// create_member_event_model the way the RPC stores a row.

type EventRow = { id: string; chapterID?: string | null; title: string; summary: string; startsAt: string; endsAt: string | null; location: string; checkInOffered: boolean };

const backend = vi.hoisted(() => ({
  events: [] as EventRow[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  refuse: null as null | { code: string; message: string },
  // R-9216 R1: the RPC commits, then its answer is lost on the way back.
  loseNextReply: false,
  // Ledger 714: the RPC commits, then a gateway answers with a body that only
  // copies the session writer's marker.
  markerAfterCommit: false,
  // Each draw of random bytes differs, as on a phone.
  draws: 0,
  roles: ['admin'] as string[],
  chapterID: 'chapter-fixture' as string | null,
  language: 'en' as 'en' | 'es',
  proof: null as Promise<'current'> | null,
}));

function rpc(name: string, args: Record<string, unknown> = {}) {
  backend.calls.push({ name, args });
  if (name === 'create_member_event_model') {
    if (backend.refuse) return { data: null, error: backend.refuse };
    // create_member_event_model refuses an id that already exists.
    if (backend.events.some((event) => event.id === args.p_id)) return { data: null, error: { code: '22023', message: 'meeting id already exists' } };
    backend.events.push({
      id: String(args.p_id), title: String(args.p_title), summary: String(args.p_summary),
      startsAt: String(args.p_starts_at), endsAt: args.p_ends_at == null ? null : String(args.p_ends_at),
      location: String(args.p_location), checkInOffered: args.p_check_in_code != null,
    });
    if (backend.loseNextReply) { backend.loseNextReply = false; throw new TypeError('Network request failed'); }
    if (backend.markerAfterCommit) { backend.markerAfterCommit = false; return { data: null, error: { message: 'Bad gateway', details: 'writer_session_changed' } }; }
    return { data: { id: args.p_id }, error: null };
  }
  return { data: null, error: { code: 'PGRST202', message: `unexpected ${name}` } };
}

// The survey card and unit editors import the shared draft hook, whose attempt keys come from expo-crypto (#9240 pull request D).
vi.mock('expo-crypto', () => ({ randomUUID: () => 'attempt-key' }));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../components/ui', () => import('../testing/uiStandIn'));
vi.mock('expo-router', () => ({ useIsFocused: () => true, useNavigation: () => ({ setOptions: () => {} }) }));
vi.mock('../lib/screenBack', () => ({ useScreenBackInterceptor: () => {} }));
vi.mock('../state/AppProvider', () => ({
  useApp: () => ({
    session: null, mode: 'authenticated', organizationID: null, chapterMemberships: [], sessionRestricted: false,
    captureAuthenticatedSessionGuard: () => () => true, authorizedRoles: backend.roles, chapterRoles: backend.roles, organizationRoles: [],
    dashboard: { member: { chapterID: backend.chapterID, language: backend.language } }, memberLanguage: backend.language,
    sampleHat: null, liveSampleBackend: false,
  }),
}));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
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
vi.mock('../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => vi.fn() }));
vi.mock('../services/haptics', () => ({ haptics: { success: vi.fn(async () => undefined), select: vi.fn() } }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: { user?: { id?: string } } | null) => ({ ...stubSessionWriter(() => ({ rpc: async (name: string, args?: Record<string, unknown>) => rpc(name, args) }), session?.user?.id ?? 'member-a'), check: async () => backend.proof ? await backend.proof : 'current' }),
  getSupabaseClient: () => ({ rpc: async (name: string, args?: Record<string, unknown>) => rpc(name, args) }),
  loadMobileMemberReportCard: vi.fn(),
}));
vi.mock('../services/memberSurveys', () => ({ loadMobileMemberSurveys: vi.fn(), saveMobileSurveySession: vi.fn(), submitMobileSurveySession: vi.fn() }));
vi.mock('../services/nativeCalendarExport', () => ({ calendarExportWasSaved: () => false, exportToDeviceCalendar: vi.fn(), isCalendarExportAvailable: () => false }));
// The Mobile CI job installs only apps/mobile; this report-card helper reaches
// root web modules. It is not on the Events desk's path.
vi.mock('../lib/mi1AnalyticsShared', () => ({ normalizeMemberReportCard: () => null }));
// The desk reads member_events, which holds what the RPC stored.
vi.mock('../services/livedIn', () => ({
  loadMobileEventsHistory: async () => backend.events.map((event) => ({
    ...event, chapterID: event.chapterID === undefined ? 'chapter-fixture' : event.chapterID, eventKind: 'meeting', eventDate: null, cancelled: false, cancellationReason: null,
    rsvp: null, checkedInAt: null, rsvpOpen: true,
  })),
}));

import { LiveLivedInScreen } from './LiveLivedInScreens';
import { ScheduleMeetingCard } from './ScheduleMeetingCard';

// The card loads expo-crypto with a plain require when a meeting is saved.
afterAll(stubPlainRequire({
  '../lib/config': { mobileConfig: { supabaseUrl: '' } },
  'expo-crypto': { getRandomBytes: (count: number) => { const draw = backend.draws; backend.draws += 1; return Uint8Array.from({ length: count }, (_, index) => (index + 1 + draw * 16) % 256); } },
}));

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const text = (view: Rendered) => view.container.textContent ?? '';
const creates = () => backend.calls.filter((call) => call.name === 'create_member_event_model');

let view: Rendered | null = null;

async function openDesk(): Promise<Rendered> {
  view = await render(h(LiveLivedInScreen, { featureKey: 'events-desk' }));
  await settle();
  return view;
}

async function fill(screen: Rendered, fields: { title?: string; location?: string; summary?: string }) {
  if (fields.title !== undefined) await type(getExposed(screen.container, 'Meeting title'), fields.title);
  if (fields.location !== undefined) await type(getExposed(screen.container, 'Location, room, or meeting link'), fields.location);
  if (fields.summary !== undefined) await type(getExposed(screen.container, 'What the meeting is about'), fields.summary);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-18T16:00:00Z'));
  backend.events = [];
  backend.calls = [];
  backend.refuse = null;
  backend.loseNextReply = false;
  backend.markerAfterCommit = false;
  backend.draws = 0;
  backend.roles = ['admin'];
  backend.chapterID = 'chapter-fixture';
  backend.language = 'en';
  backend.proof = null;
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  vi.useRealTimers();
  setPlatform('ios');
});

describe('upcoming meetings for the open campaign', () => {
  function seedCalendar() {
    const scheduled = (title: string, chapterID: string | null, day: string): EventRow => ({
      id: title,
      title,
      chapterID,
      startsAt: `2026-11-${day}T17:00:00Z`,
      endsAt: null,
      summary: '',
      location: 'Meeting hall',
      checkInOffered: false,
    });
    backend.events = [
      scheduled('Next Eastgate briefing', 'other-chapter', '19'),
      scheduled('Alder Falls training', 'chapter-fixture', '25'),
      scheduled('Open organization meeting', null, '21'),
      scheduled('Alder Falls briefing', 'chapter-fixture', '23'),
      scheduled('Past Alder Falls meeting', 'chapter-fixture', '14'),
      scheduled('Recent Eastgate meeting', 'other-chapter', '16'),
    ];
  }

  async function readHeadings(featureKey: 'events' | 'events-desk') {
    view = await render(h(LiveLivedInScreen, { featureKey }));
    await settle();
    return [...view.container.querySelectorAll('[role="heading"]')].map((node) => node.textContent);
  }

  it.each<{ feature: 'events' | 'events-desk'; language: 'en' | 'es'; chapterLabel: string; otherLabel: string }>([
    { feature: 'events', language: 'en', chapterLabel: 'Meetings in this campaign', otherLabel: 'Other meetings' },
    { feature: 'events-desk', language: 'es', chapterLabel: 'Reuniones de esta campaña', otherLabel: 'Otras reuniones' },
  ])('labels both upcoming groups in $feature ($language)', async ({ feature, language, chapterLabel, otherLabel }) => {
    backend.roles = feature === 'events-desk' ? ['steward'] : [];
    backend.language = language;
    seedCalendar();

    const headings = await readHeadings(feature);
    expect(headings.slice(headings.indexOf('Upcoming · 4'))).toEqual([
      'Upcoming · 4', chapterLabel, 'Alder Falls briefing', 'Alder Falls training',
      otherLabel, 'Next Eastgate briefing', 'Open organization meeting',
      'Past · 2', 'Recent Eastgate meeting', 'Past Alder Falls meeting',
    ]);
  });

  it.each<'chapter' | 'other'>(['chapter', 'other'])('omits group labels when only %s meetings are upcoming', async (group) => {
    backend.roles = [];
    seedCalendar();
    backend.events = backend.events.filter((event) => (event.chapterID === backend.chapterID) === (group === 'chapter'));

    const headings = await readHeadings('events');
    const upcoming = group === 'chapter'
      ? ['Alder Falls briefing', 'Alder Falls training']
      : ['Next Eastgate briefing', 'Open organization meeting'];
    expect(headings.slice(headings.indexOf('Upcoming · 2'), headings.indexOf('Past · 1'))).toEqual(['Upcoming · 2', ...upcoming]);
  });

  it('keeps chronological order without an open campaign', async () => {
    backend.chapterID = null;
    backend.roles = [];
    seedCalendar();

    const headings = await readHeadings('events');
    expect(headings.slice(headings.indexOf('Upcoming · 4'), headings.indexOf('Past · 2'))).toEqual([
      'Upcoming · 4', 'Next Eastgate briefing', 'Open organization meeting', 'Alder Falls briefing', 'Alder Falls training',
    ]);
  });
});

describe.each(['ios', 'android'] as const)('scheduling a campaign meeting from the Meetings desk on %s', (os) => {
  it.each<'replace' | 'unmount'>(['replace', 'unmount'])('drops a late proof after the meeting owner lifetime ends (%s)', async (retirement) => {
    setPlatform(os);
    const onScheduled = vi.fn();
    view = await render(h(ScheduleMeetingCard, { onScheduled, resumeItemID: 'event-a' }));
    const screen = view;
    await press(getExposed(screen.container, 'Schedule a meeting'));
    await fill(screen, { title: 'Meeting A', location: 'Hall A', summary: 'Agenda A' });
    let release!: (value: 'current') => void;
    let releaseReplacement: ((value: 'current') => void) | undefined;
    backend.proof = new Promise<'current'>((resolve) => { release = resolve; });
    await press(getExposed(screen.container, 'Schedule meeting'));
    await settle();
    expect(creates()).toHaveLength(1);
    if (retirement === 'replace') {
      await screen.rerender(h(ScheduleMeetingCard, { onScheduled, resumeItemID: 'event-b' }));
      await press(getExposed(screen.container, 'Schedule a meeting'));
      expect(creates()).toHaveLength(1);
      expect(exposedNames(screen.container)).not.toContain('Meeting title');
    } else { await screen.unmount(); view = null; }
    await act(async () => { release('current'); });
    await settle();
    expect(onScheduled).not.toHaveBeenCalled();
    if (retirement === 'replace') {
      await press(getExposed(screen.container, 'Schedule a meeting'));
      await fill(screen, { title: 'Meeting B', location: 'Hall B', summary: 'Agenda B' });
      backend.proof = new Promise<'current'>(resolve => { releaseReplacement = resolve; });
      if (exposedNames(screen.container).includes('Schedule meeting')) await press(getExposed(screen.container, 'Schedule meeting'));
      expect(creates()).toHaveLength(2);
      await act(async () => { releaseReplacement?.('current'); });
      await settle();
      expect(onScheduled).toHaveBeenCalledOnce();
      expect(text(screen)).not.toContain('Meeting A');
    }
  });
  it('saves the meeting as Campaign Administrator and shows the saved row in the desk list', async () => {
    setPlatform(os);
    const screen = await openDesk();
    expect(text(screen)).toContain('No meetings');

    await press(getExposed(screen.container, 'Schedule a meeting'));
    await fill(screen, { title: 'Contract campaign kickoff', location: 'Union hall, Room 2', summary: 'Plan the first steps of the campaign.' });
    const laterDay = exposedNames(screen.container).find((name) => name.startsWith('Later day: '));
    expect(laterDay).toBeDefined();
    await press(getExposed(screen.container, laterDay!));
    await press(getExposed(screen.container, 'Schedule meeting'));
    await settle();

    const start = stepMeetingDay(defaultMeetingStart(new Date()), 1);
    expect(creates().map((call) => call.args)).toEqual([{
      p_id: expect.stringMatching(/^meeting-\d{8}-0102030405060708$/),
      p_title: 'Contract campaign kickoff',
      p_starts_at: start.toISOString(),
      p_location: 'Union hall, Room 2',
      p_summary: 'Plan the first steps of the campaign.',
      p_check_in_code: 'SG-TUVWXY',
      p_is_public: false,
      p_is_public_across_agencies: false,
      p_kind: 'meeting',
      p_event_date: null,
      p_ends_at: new Date(start.getTime() + 60 * 60_000).toISOString(),
      p_occurrences: 1,
      p_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }]);
    expect(backend.events).toHaveLength(1);
    expect(text(screen)).toContain('Meeting scheduled. It is in the list below. Check-in code: SG-TUVWXY');
    expect(text(screen)).toContain('Upcoming · 1');
    expect(text(screen)).toContain('Contract campaign kickoff');
    expect(text(screen)).not.toContain('No meetings');
  });

  it('names a missing title and sends nothing', async () => {
    setPlatform(os);
    const screen = await openDesk();
    await press(getExposed(screen.container, 'Schedule a meeting'));
    await fill(screen, { location: 'Union hall', summary: 'Agenda to follow.' });
    await press(getExposed(screen.container, 'Schedule meeting'));
    await settle();
    expect(text(screen)).toContain('Give the meeting a title of 3 to 120 characters.');
    expect(creates()).toHaveLength(0);
  });

  it('says plainly when the role cannot schedule, and keeps the form', async () => {
    setPlatform(os);
    backend.refuse = { code: '42501', message: 'staff role required' };
    const screen = await openDesk();
    await press(getExposed(screen.container, 'Schedule a meeting'));
    await fill(screen, { title: 'Committee training', location: 'Room 2', summary: 'Bring questions.' });
    await press(getExposed(screen.container, 'Schedule meeting'));
    await settle();
    expect(text(screen)).toContain('Your role cannot schedule meetings for this campaign.');
    expect(exposedNames(screen.container)).toContain('Schedule meeting');
    expect(backend.events).toHaveLength(0);
  });

  it('keeps a summary typed with Enter or pasted with control characters as one paragraph, and sends it', async () => {
    setPlatform(os);
    const screen = await openDesk();
    await press(getExposed(screen.container, 'Schedule a meeting'));
    await fill(screen, { title: 'Bargaining update', location: 'Union hall' });
    // Enter in the box, then a paste carrying a tab, a bell and a line break.
    await type(getExposed(screen.container, 'What the meeting is about'), 'First topic\nSecond topic');
    expect((getExposed(screen.container, 'What the meeting is about') as HTMLInputElement).value).toBe('First topic Second topic');
    await type(getExposed(screen.container, 'What the meeting is about'), 'First topic\t\u0007Second topic\r\nThird');
    await press(getExposed(screen.container, 'Schedule meeting'));
    await settle();
    expect(text(screen)).not.toContain('Add what the meeting is about, up to 500 characters.');
    expect(creates().map((call) => call.args.p_summary)).toEqual(['First topic Second topic Third']);
  });

  it('names a missing campaign apart from a role refusal', async () => {
    setPlatform(os);
    backend.refuse = { code: '42501', message: 'staff campaign required' };
    const screen = await openDesk();
    await press(getExposed(screen.container, 'Schedule a meeting'));
    await fill(screen, { title: 'Committee training', location: 'Room 2', summary: 'Bring questions.' });
    await press(getExposed(screen.container, 'Schedule meeting'));
    await settle();
    expect(text(screen)).toContain('This account is not in a campaign, so it cannot schedule a campaign meeting.');
    expect(text(screen)).not.toContain('Your role cannot schedule meetings for this campaign.');
  });

  it('does not create a second meeting when a saved meeting loses its answer and the officer retries', async () => {
    setPlatform(os);
    const screen = await openDesk();
    await press(getExposed(screen.container, 'Schedule a meeting'));
    await fill(screen, { title: 'Campaign strategy meeting', location: 'Room 2', summary: 'Plan next steps.' });
    backend.loseNextReply = true;
    await press(getExposed(screen.container, 'Schedule meeting'));
    await settle();
    expect(text(screen)).toContain('We could not confirm the meeting was saved. Try again with the same details, or cancel and check the list.');
    expect(backend.events).toHaveLength(1);
    await press(getExposed(screen.container, 'Schedule meeting'));
    await settle();
    // The retry reuses the same event id and check-in code; the RPC refuses
    // the id as existing, which the phone reads as saved.
    const ids = creates().map((call) => call.args.p_id);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
    expect(creates()[1]?.args.p_check_in_code).toBe(creates()[0]?.args.p_check_in_code);
    expect(backend.events).toHaveLength(1);
    expect(text(screen)).toContain('Meeting scheduled. It is in the list below.');
    expect(text(screen)).toContain('Campaign strategy meeting');
  });

  it('keeps a saved meeting unconfirmed when its answer only copies the writer marker, so a retry reads it as saved (ledger 714)', async () => {
    setPlatform(os);
    const screen = await openDesk();
    await press(getExposed(screen.container, 'Schedule a meeting'));
    await fill(screen, { title: 'Campaign strategy meeting', location: 'Room 2', summary: 'Plan next steps.' });
    backend.markerAfterCommit = true;
    await press(getExposed(screen.container, 'Schedule meeting'));
    await settle();
    expect(backend.events).toHaveLength(1);
    expect(text(screen)).toContain('We could not confirm the meeting was saved. Try again with the same details, or cancel and check the list.');
    expect(text(screen)).not.toContain('The meeting could not be scheduled. Try again.');
    await press(getExposed(screen.container, 'Schedule meeting'));
    await settle();
    expect(creates()[1]?.args.p_id).toBe(creates()[0]?.args.p_id);
    expect(backend.events).toHaveLength(1);
    expect(text(screen)).toContain('Meeting scheduled. It is in the list below.');
  });

  it('keeps the draft and its identity through a failure before saving, then saves once', async () => {
    setPlatform(os);
    backend.refuse = { code: '', message: 'Failed to fetch' };
    const screen = await openDesk();
    await press(getExposed(screen.container, 'Schedule a meeting'));
    await fill(screen, { title: 'Campaign strategy meeting', location: 'Room 2', summary: 'Plan next steps.' });
    await press(getExposed(screen.container, 'Schedule meeting'));
    await settle();
    expect(backend.events).toHaveLength(0);
    expect(text(screen)).toContain('We could not confirm the meeting was saved. Try again with the same details, or cancel and check the list.');
    expect((getExposed(screen.container, 'Meeting title') as HTMLInputElement).value).toBe('Campaign strategy meeting');
    backend.refuse = null;
    await press(getExposed(screen.container, 'Schedule meeting'));
    await settle();
    expect(backend.events).toHaveLength(1);
    const ids = creates().map((call) => call.args.p_id);
    expect(ids[1]).toBe(ids[0]);
  });

  // R-9216b R2: an edit made after the lost answer could be dropped while the
  // phone said "Meeting scheduled". The draft is now locked until the officer
  // tries again with the same details or cancels.
  it('locks the draft after a lost answer, so a retry saves exactly the content that was sent', async () => {
    setPlatform(os);
    const screen = await openDesk();
    await press(getExposed(screen.container, 'Schedule a meeting'));
    await fill(screen, { title: 'Campaign strategy meeting', location: 'Room 2', summary: 'Plan next steps.' });
    backend.loseNextReply = true;
    await press(getExposed(screen.container, 'Schedule meeting'));
    await settle();
    expect(text(screen)).toContain('We could not confirm the meeting was saved. Try again with the same details, or cancel and check the list.');
    // Every field and control of the draft refuses a change.
    for (const label of ['Meeting title', 'Location, room, or meeting link', 'What the meeting is about']) {
      expect((getExposed(screen.container, label) as HTMLInputElement).disabled).toBe(true);
    }
    await fill(screen, { title: 'Renamed meeting', location: 'Room 9', summary: 'Different agenda.' });
    const laterDay = exposedNames(screen.container).find((name) => name.startsWith('Later day: '));
    await press(getExposed(screen.container, laterDay!));
    // The locked switch is announced as unavailable until a retry or Cancel.
    await press(getExposed(screen.container, 'Workers check in with a code, Try again or cancel'));
    expect((getExposed(screen.container, 'Meeting title') as HTMLInputElement).value).toBe('Campaign strategy meeting');
    expect((getExposed(screen.container, 'Location, room, or meeting link') as HTMLInputElement).value).toBe('Room 2');
    // Cancel and Schedule meeting stay open.
    expect(getExposed(screen.container, 'Cancel').getAttribute('aria-disabled')).not.toBe('true');
    await press(getExposed(screen.container, 'Schedule meeting'));
    await settle();
    const [first, retry] = creates().map((call) => call.args);
    expect(retry).toEqual(first);
    expect(backend.events).toHaveLength(1);
    expect(backend.events[0]).toMatchObject({ title: 'Campaign strategy meeting', location: 'Room 2', summary: 'Plan next steps.' });
    expect(text(screen)).toContain('Meeting scheduled. It is in the list below.');
  });

  it('unlocks a fresh draft after Cancel', async () => {
    setPlatform(os);
    const screen = await openDesk();
    await press(getExposed(screen.container, 'Schedule a meeting'));
    await fill(screen, { title: 'Campaign strategy meeting', location: 'Room 2', summary: 'Plan next steps.' });
    backend.loseNextReply = true;
    await press(getExposed(screen.container, 'Schedule meeting'));
    await settle();
    await press(getExposed(screen.container, 'Cancel'));
    await press(getExposed(screen.container, 'Schedule a meeting'));
    expect((getExposed(screen.container, 'Meeting title') as HTMLInputElement).disabled).toBe(false);
    await fill(screen, { title: 'Another meeting', location: 'Room 3', summary: 'Agenda.' });
    expect((getExposed(screen.container, 'Meeting title') as HTMLInputElement).value).toBe('Another meeting');
  });

  it('starts a new identity for the next meeting after one is saved', async () => {
    setPlatform(os);
    const screen = await openDesk();
    for (const title of ['First meeting', 'Second meeting']) {
      await press(getExposed(screen.container, 'Schedule a meeting'));
      await fill(screen, { title, location: 'Room 2', summary: 'Agenda.' });
      await press(getExposed(screen.container, 'Schedule meeting'));
      await settle();
    }
    expect(backend.events.map((event) => event.title)).toEqual(['First meeting', 'Second meeting']);
    expect(new Set(backend.events.map((event) => event.id)).size).toBe(2);
  });

  it('keeps simultaneous Schedule presses to one call', async () => {
    setPlatform(os);
    const screen = await openDesk();
    await press(getExposed(screen.container, 'Schedule a meeting'));
    await fill(screen, { title: 'Campaign strategy meeting', location: 'Room 2', summary: 'Plan next steps.' });
    const submit = getExposed(screen.container, 'Schedule meeting');
    await act(async () => { submit.click(); submit.click(); });
    await settle();
    expect(creates()).toHaveLength(1);
    expect(backend.events).toHaveLength(1);
  });

  it('sends no check-in code when check-in is switched off', async () => {
    setPlatform(os);
    const screen = await openDesk();
    await press(getExposed(screen.container, 'Schedule a meeting'));
    await fill(screen, { title: 'Open office hours', location: 'Room 2', summary: 'Drop in.' });
    await press(getExposed(screen.container, 'Workers check in with a code'));
    await press(getExposed(screen.container, 'Schedule meeting'));
    await settle();
    expect(creates()[0]?.args.p_check_in_code).toBeNull();
    expect(text(screen)).toContain('Meeting scheduled. It is in the list below.');
    expect(text(screen)).not.toContain('Check-in code:');
  });
});

describe('the meeting form on its own', () => {
  it('schedules a meeting and tells its desk to reload', async () => {
    const onScheduled = vi.fn();
    view = await render(h(ScheduleMeetingCard, { onScheduled }));
    await settle();
    await press(getExposed(view.container, 'Schedule a meeting'));
    await fill(view, { title: 'New committee member orientation', location: 'Room 4', summary: 'Meet the committee members.' });
    await press(getExposed(view.container, 'Schedule meeting'));
    await settle();
    expect(onScheduled).toHaveBeenCalledTimes(1);
    expect(creates()).toHaveLength(1);
    expect(backend.events[0]?.title).toBe('New committee member orientation');
  });
});

describe('who sees the meeting form', () => {
  it('is not offered on the worker Meetings screen', async () => {
    backend.roles = ['member'];
    view = await render(h(LiveLivedInScreen, { featureKey: 'events' }));
    await settle();
    expect(exposedNames(view.container)).not.toContain('Schedule a meeting');
  });

  it('is offered to a campaign chair working as Campaign chair', async () => {
    backend.roles = ['vp'];
    const screen = await openDesk();
    expect(exposedNames(screen.container)).toContain('Schedule a meeting');
  });

  it('reads both refusals in Spanish', async () => {
    backend.language = 'es';
    const t = nativeUiText('es');
    const refusals: readonly (readonly [string, NativeUiKey])[] = [
      ['staff role required', 'Your role cannot schedule meetings for this campaign.'],
      ['staff campaign required', 'This account is not in a campaign, so it cannot schedule a campaign meeting. Ask a campaign administrator to add you to your campaign.'],
    ];
    for (const [message, english] of refusals) {
      backend.refuse = { code: '42501', message };
      const screen = await openDesk();
      await press(getExposed(screen.container, t('Schedule a meeting')));
      await type(getExposed(screen.container, t('Meeting title')), 'Reunión de la sección');
      await type(getExposed(screen.container, t('Location, room, or meeting link')), 'Sala 2');
      await type(getExposed(screen.container, t('What the meeting is about')), 'Agenda.');
      await press(getExposed(screen.container, t('Schedule meeting')));
      await settle();
      expect(t(english)).not.toBe(english);
      expect(text(screen)).toContain(t(english));
      await screen.unmount();
      view = null;
    }
  });

  it('reads in Spanish', async () => {
    backend.language = 'es';
    const screen = await openDesk();
    const t = nativeUiText('es');
    expect(screen.container.querySelector('[role="heading"]')?.textContent).toBe(t('Meetings desk'));
    expect(t('Schedule a meeting')).not.toBe('Schedule a meeting');
    await press(getExposed(screen.container, t('Schedule a meeting')));
    getExposed(screen.container, t('Meeting title'));
    getExposed(screen.container, t('Schedule meeting'));
  });
});
