import { stubSessionWriter } from '../testing/stubSessionWriter';
// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubPlainRequire } from '../testing/plainRequire';
import { getExposed, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import { nativeUiText } from '../lib/nativeUiCopy';
import type { LivedInStewardAppointment } from '../services/livedIn';

// BUG-UG-NATIVE-STEWARD-DESK-APPOINTMENTS-HAS-NO-HOURS-EDITOR-20261118
// (#9100): the steward desk's Appointments (Work > Casework > Appointments)
// showed Availability "Not Set" with no way to set hours; #9089 had added the
// editor only to the general Appointments screen. A steward opens the desk,
// saves a weekly window, reads it back after reopening, and the general
// Appointments card shows the same saved window.

type Window = { weekday: number; startMinute: number; endMinute: number };

const backend = vi.hoisted(() => ({
  windows: [] as { weekday: number; startMinute: number; endMinute: number }[],
  accepting: null as boolean | null,
  calls: [] as { name: string; args: Record<string, unknown> }[],
  deskReads: 0,
  upcoming: [] as LivedInStewardAppointment[],
  language: 'en' as 'en' | 'es',
}));

function rpc(name: string, args: Record<string, unknown> = {}) {
  backend.calls.push({ name, args });
  if (name === 'set_appointment_windows') {
    backend.windows = (args.p_windows as Window[]).map((window) => ({ ...window }));
    // set_appointment_windows creates a missing schedule, and
    // member_appointment_schedules.accepting defaults to true.
    if (backend.accepting === null) backend.accepting = true;
    return { data: { windows: backend.windows.length }, error: null };
  }
  if (name === 'set_appointment_schedule') {
    if (typeof args.p_accepting === 'boolean') backend.accepting = args.p_accepting;
    return { data: { accepting: backend.accepting }, error: null };
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
    captureAuthenticatedSessionGuard: () => () => true, authorizedRoles: ['steward'], chapterRoles: ['steward'], organizationRoles: [],
    dashboard: { member: { chapterID: 'chapter-fixture', language: backend.language } }, memberLanguage: backend.language,
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
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => ({ rpc: async (name: string, args?: Record<string, unknown>) => rpc(name, args) }), session?.user?.id ?? 'member-a'),
  getSupabaseClient: () => ({ rpc: async (name: string, args?: Record<string, unknown>) => rpc(name, args) }),
  loadMobileMemberReportCard: vi.fn(),
}));
vi.mock('../services/memberSurveys', () => ({ loadMobileMemberSurveys: vi.fn(), saveMobileSurveySession: vi.fn(), submitMobileSurveySession: vi.fn() }));
vi.mock('../services/nativeCalendarExport', () => ({ calendarExportWasSaved: () => false, exportToDeviceCalendar: vi.fn(), isCalendarExportAvailable: () => false }));
// The Mobile CI job installs only apps/mobile; this report-card helper reaches
// root web modules. It is not on the steward desk's path.
vi.mock('../lib/mi1AnalyticsShared', () => ({ normalizeMemberReportCard: () => null }));
// The desk read returns what set_appointment_windows stored, as
// get_steward_appointments does.
vi.mock('../services/livedIn', () => ({
  loadMobileStewardAppointmentsDesk: async () => {
    backend.deskReads += 1;
    return {
      upcoming: backend.upcoming, recent: [], outcomes: { completed30d: null, noShows30d: null }, connections: [],
      availability: {
        timezone: null, accepting: backend.accepting, minNoticeMinutes: null, blackouts: [],
        windows: backend.windows.map((window, index) => ({ id: `window-${index}`, ...window })),
      },
    };
  },
}));

import { LiveLivedInScreen } from './LiveLivedInScreens';
import { AppointmentHoursCard } from './AppointmentHoursCard';

afterAll(stubPlainRequire({ '../lib/config': { mobileConfig: { supabaseUrl: '' } } }));

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const text = (view: Rendered) => view.container.textContent ?? '';

let view: Rendered | null = null;

async function openDesk(): Promise<Rendered> {
  view = await render(h(LiveLivedInScreen, { featureKey: 'steward-appointments' }));
  await settle();
  return view;
}

beforeEach(() => {
  backend.windows = [];
  backend.accepting = null;
  backend.calls = [];
  backend.deskReads = 0;
  backend.upcoming = [];
  backend.language = 'en';
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  setPlatform('ios');
});

describe.each(['ios', 'android'] as const)('the committee member desk One-on-ones on %s', (os) => {
  it('saves a weekly window and turns bookings on, then reads it back on both One-on-ones screens', async () => {
    setPlatform(os);
    let screen = await openDesk();
    expect(text(screen)).toContain('One-on-one desk');
    expect(text(screen)).toContain('No weekly hours yet');
    // The editor is seeded from the desk's own read, not a second one.
    expect(backend.deskReads).toBe(1);

    await press(getExposed(screen.container, 'Set booking hours'));
    await press(getExposed(screen.container, 'Add hours'));
    await press(getExposed(screen.container, 'End later: Monday 9:00 AM–12:00 PM'));
    await press(getExposed(screen.container, 'Save hours'));
    await settle();

    expect(backend.calls.filter((call) => call.name === 'set_appointment_windows').map((call) => call.args))
      .toEqual([{ p_windows: [{ weekday: 1, startMinute: 540, endMinute: 735 }] }]);
    // No schedule yet: the first save creates it taking bookings, so the
    // switch left on sends no separate schedule call.
    expect(backend.calls.some((call) => call.name === 'set_appointment_schedule')).toBe(false);
    expect(backend.accepting).toBe(true);
    expect(text(screen)).toContain('Booking hours saved.');
    expect(text(screen)).toContain('Monday · 9:00 AM–12:15 PM');
    expect(text(screen)).toContain('Taking bookings');

    await screen.unmount();
    view = null;
    screen = await openDesk();
    expect(text(screen)).toContain('Monday · 9:00 AM–12:15 PM');
    expect(text(screen)).not.toContain('No weekly hours yet');
    await screen.unmount();

    // The general Appointments screen's card reads the same saved windows.
    view = await render(h(AppointmentHoursCard, { t: nativeUiText('en') }));
    await settle();
    expect(text(view)).toContain('Monday · 9:00 AM–12:15 PM');
  });

  it('turns bookings back on from the desk', async () => {
    setPlatform(os);
    backend.windows = [{ weekday: 1, startMinute: 540, endMinute: 720 }];
    backend.accepting = false;
    const screen = await openDesk();
    expect(text(screen)).toContain('Paused');
    await press(getExposed(screen.container, 'Set booking hours'));
    await press(getExposed(screen.container, 'Workers can book time with me'));
    await press(getExposed(screen.container, 'Save hours'));
    await settle();
    expect(backend.calls.find((call) => call.name === 'set_appointment_schedule')?.args).toMatchObject({ p_accepting: true });
    expect(backend.accepting).toBe(true);
    expect(text(screen)).toContain('Taking bookings');
  });

  it('removes a saved window from the desk', async () => {
    setPlatform(os);
    backend.windows = [{ weekday: 2, startMinute: 600, endMinute: 660 }];
    backend.accepting = true;
    const screen = await openDesk();
    expect(text(screen)).toContain('Tuesday · 10:00 AM–11:00 AM');
    await press(getExposed(screen.container, 'Set booking hours'));
    await press(getExposed(screen.container, 'Remove these hours: Tuesday 10:00 AM–11:00 AM'));
    await press(getExposed(screen.container, 'Save hours'));
    await settle();
    expect(backend.windows).toEqual([]);
    expect(text(screen)).toContain('No weekly hours yet');
  });
});

describe('the committee member desk One-on-ones in Spanish', () => {
  it('shows the editor in Spanish', async () => {
    backend.language = 'es';
    const screen = await openDesk();
    const t = nativeUiText('es');
    expect(text(screen)).toContain(t('Your booking hours'));
    expect(t('Your booking hours')).not.toBe('Your booking hours');
    getExposed(screen.container, t('Set booking hours'));
  });
});

it.each<[string, string | null, string]>([
  ['2026-11-24T15:00:00Z', '2026-11-24T15:30:00Z', 'Tue, Nov 24, 2026, 10:00 – 10:30 AM ET'],
  ['2026-11-24T15:00:00Z', null, 'Tue, Nov 24, 2026, 10:00 AM ET'],
  ['2026-11-25T04:45:00Z', '2026-11-25T05:15:00Z', 'Tue, Nov 24, 2026, 11:45 PM ET – Wed, Nov 25, 2026, 12:15 AM ET'],
  ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z', 'Sun, Nov 1, 2026, 1:30 AM EDT – Sun, Nov 1, 2026, 1:30 AM EST'],
])('shows the correct range for endpoints %s and %s on the Committee desk', async (startsAt, endsAt, label) => {
  backend.upcoming = [{
    id: 'range-fixture', memberName: 'Rae Fixture', type: 'office_hours', durationMinutes: 30, startsAt, endsAt,
    place: 'Room 2', status: 'confirmed', reasonCategory: null, routedVia: null,
  }];
  const screen = await openDesk();

  expect(text(screen)).toContain(`${label} · Room 2`);
});
