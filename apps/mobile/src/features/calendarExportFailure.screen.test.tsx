import { stubSessionWriter } from '../testing/stubSessionWriter';
// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exposedNames, getExposed, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import { calendarRecordGone } from '../lib/calendarExportFailure';
import type * as LivedInService from '../services/livedIn';

// #9462 (M2-11 and its appointment twin): a failed "Add to calendar" said the
// event or appointment was gone for every failure, a lost connection included.
// Now only a read that found the record gone says so; any other failure says it
// could not be added. Both screens run on the shared React Native stand-in.

const backend = vi.hoisted(() => ({
  language: 'en' as 'en' | 'es',
  eventFailure: null as unknown,
  appointmentFailure: null as unknown,
  // When set, the real event read runs against this row.
  eventRow: null as Record<string, unknown> | null,
  historyFailure: null as unknown,
  cancelled: [] as string[],
  secondAppointment: false,
  announced: [] as string[],
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'attempt-key' }));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../components/ui', () => import('../testing/uiStandIn'));
vi.mock('expo-router', () => ({ useIsFocused: () => true, useNavigation: () => ({ setOptions: () => {} }) }));
vi.mock('../lib/screenBack', () => ({ useScreenBackInterceptor: () => {} }));
vi.mock('../state/AppProvider', () => ({
  useApp: () => ({
    session: null, mode: 'authenticated', organizationID: null, chapterMemberships: [], sessionRestricted: false,
    captureAuthenticatedSessionGuard: () => () => true, authorizedRoles: ['member'], chapterRoles: [], organizationRoles: [],
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
vi.mock('./AppointmentBookingCard', () => ({ AppointmentBookingCard: () => null }));
vi.mock('./AppointmentHoursCard', () => ({ AppointmentHoursCard: () => null }));
vi.mock('../lib/connectedWorkflows', () => ({ connectedWorkflowApi: () => null }));
vi.mock('../lib/mi1AnalyticsShared', () => ({ normalizeMemberReportCard: () => null }));
vi.mock('../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => (message: string) => { backend.announced.push(message); return () => { backend.cancelled.push(message); }; } }));
vi.mock('../services/haptics', () => ({ haptics: { success: vi.fn(async () => undefined), select: vi.fn() } }));
vi.mock('../services/memberSurveys', () => ({ loadMobileMemberSurveys: vi.fn(), saveMobileSurveySession: vi.fn(), submitMobileSurveySession: vi.fn() }));
vi.mock('../services/nativeCalendarExport', () => ({ calendarExportWasSaved: () => false, exportToDeviceCalendar: vi.fn(async () => 'saved'), isCalendarExportAvailable: () => true }));
const future = () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1_000).toISOString();
vi.mock('../services/supabase', () => ({
  captureSessionWriter: (session: { user?: { id?: string } } | null) => ({ ...stubSessionWriter(() => null, session?.user?.id ?? 'member-a'), check: async () => 'current' }),
  getSupabaseClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: backend.eventRow, error: null }) }) }) }) }),
  assertFreshMobileCalendarSession: async () => 'member-a',
  loadMobileMemberReportCard: vi.fn(),
  loadMobileAppointments: async () => [
    { id: 'appointment-1', startsAt: future(), endsAt: future(), status: 'confirmed', appointmentType: 'check_in' },
    ...backend.secondAppointment ? [{ id: 'appointment-2', startsAt: future(), endsAt: future(), status: 'confirmed', appointmentType: 'grievance' }] : [],
  ],
  loadMobileSupervisedAppointments: async () => [],
  // A pending promise holds the read open; anything else is the failure.
  loadMobileAppointmentHistory: async () => { if (backend.historyFailure instanceof Promise) return backend.historyFailure; throw backend.historyFailure; },
  prepareAuthorizedAppointmentCalendarExport: async () => { throw backend.appointmentFailure; },
}));
vi.mock('../services/livedIn', async (importOriginal) => {
  const real: typeof LivedInService = await importOriginal();
  return {
    loadMobileEventsHistory: async () => [{
      id: 'event-1', chapterID: 'chapter-fixture', title: 'Campaign meeting', summary: '', startsAt: future(), endsAt: null, location: 'Hall',
      eventKind: 'meeting', eventDate: null, cancelled: false, cancellationReason: null, rsvp: null, checkedInAt: null, checkInOffered: false, rsvpOpen: true,
    }],
    prepareAuthorizedEventCalendarExport: async (id: string, now: number) => {
      if (backend.eventRow) return real.prepareAuthorizedEventCalendarExport(id, now);
      throw backend.eventFailure;
    },
  };
});

import { LiveLivedInScreen } from './LiveLivedInScreens';
import { LiveAppointmentsFeature } from './LiveAppointmentsFeature';

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
const text = (screen: Rendered) => screen.container.textContent ?? '';

let view: Rendered | null = null;
async function addToCalendar(screen: 'events' | 'appointments'): Promise<string> {
  view = await render(screen === 'events' ? h(LiveLivedInScreen, { featureKey: 'events' }) : h(LiveAppointmentsFeature));
  await settle();
  await press(getExposed(view.container, 'Add to calendar'));
  await settle();
  return text(view);
}

// What the services throw: the tagged "gone" error, or a failure the code
// cannot tell apart (a lost connection, a session it could not confirm).
const gone = () => calendarRecordGone('Meeting export is no longer authorized.');
const offline = () => new TypeError('Network request failed');
const noSession = () => new Error('Calendar export requires a current session.');

beforeEach(() => { backend.language = 'en'; backend.announced = []; backend.eventFailure = null; backend.appointmentFailure = null; backend.eventRow = null; backend.historyFailure = null; backend.cancelled = []; backend.secondAppointment = false; });
afterEach(async () => { await view?.unmount(); view = null; setPlatform('ios'); });

const PLATFORMS = ['ios', 'android'] as const;

describe.each(PLATFORMS)('a failed Add to calendar on %s', (os) => {
  it.each([['offline', offline], ['session not confirmed', noSession]])('says a meeting could not be added when the failure is %s, not that it is gone', async (_label, failure) => {
    setPlatform(os);
    backend.eventFailure = failure();
    const shown = await addToCalendar('events');
    expect(shown).toContain('The meeting could not be added to your calendar. Check your connection and try again.');
    expect(shown).not.toContain('That meeting is no longer available.');
    // TalkBack hears the polite error region; VoiceOver hears the queue.
    expect(backend.announced).toEqual(os === 'ios' ? ['The meeting could not be added to your calendar. Check your connection and try again.'] : []);
  });

  it('says a meeting is no longer available only when the read found it gone', async () => {
    setPlatform(os);
    backend.eventFailure = gone();
    expect(await addToCalendar('events')).toContain('That meeting is no longer available.');
  });

  it('says a meeting staff turned into a date-only meeting (no start time) is no longer available, through the real read', async () => {
    setPlatform(os);
    backend.eventRow = { id: 'event-1', title: 'Campaign meeting', starts_at: null, ends_at: null, event_kind: 'date_only', event_date: '2026-12-01', location: null, cancelled_at: null };
    const shown = await addToCalendar('events');
    expect(shown).toContain('That meeting is no longer available.');
    expect(shown).not.toContain('Check your connection');
  });

  it.each([['offline', offline], ['session not confirmed', noSession]])('says a one-on-one could not be added when the failure is %s, and speaks it', async (_label, failure) => {
    setPlatform(os);
    backend.appointmentFailure = failure();
    const shown = await addToCalendar('appointments');
    expect(shown).toContain('The one-on-one could not be added to your calendar. Check your connection and try again.');
    expect(shown).not.toContain('That one-on-one is no longer available.');
    expect(backend.announced).toEqual(['The one-on-one could not be added to your calendar. Check your connection and try again.']);
  });

  it('says a one-on-one is no longer available only when the read found it gone', async () => {
    setPlatform(os);
    backend.appointmentFailure = calendarRecordGone('One-on-one export is no longer authorized.');
    expect(await addToCalendar('appointments')).toContain('That one-on-one is no longer available.');
  });
});

describe('a failed Add to calendar in Spanish', () => {
  it('tells both causes in Spanish on both screens', async () => {
    backend.language = 'es';
    backend.eventFailure = offline();
    expect(await addToCalendar('events')).toContain('No se pudo agregar la reunión a su calendario. Revise su conexión y vuelva a intentarlo.');
    await view?.unmount();
    backend.appointmentFailure = calendarRecordGone('One-on-one export is no longer authorized.');
    expect(await addToCalendar('appointments')).toContain('Esa cita ya no está disponible.');
    await view?.unmount();
    backend.appointmentFailure = offline();
    expect(await addToCalendar('appointments')).toContain('No se pudo agregar la cita a su calendario. Revise su conexión y vuelva a intentarlo.');
    await view?.unmount();
    backend.eventFailure = gone();
    expect(await addToCalendar('events')).toContain('Esa reunión ya no está disponible.');
  });
});

// #9462 (wave 3, LiveAppointmentsFeature history): opening an appointment's
// history said "That appointment history is no longer available." for every
// failure. Only the read's "gone" answer says that now.
describe.each(PLATFORMS)('a failed one-on-one history on %s', (os) => {
  async function openHistory(): Promise<string> {
    view = await render(h(LiveAppointmentsFeature));
    await settle();
    const card = exposedNames(view.container).find((name) => name.startsWith('check in, confirmed'));
    if (!card) throw new Error(`No one-on-one card among: ${exposedNames(view.container).join(' | ')}`);
    await press(getExposed(view.container, card));
    await settle();
    return text(view);
  }

  it.each([['offline', offline], ['session not confirmed', noSession]])('says the history could not be loaded when the failure is %s, and speaks it', async (_label, failure) => {
    setPlatform(os);
    backend.historyFailure = failure();
    const shown = await openHistory();
    expect(shown).toContain('That one-on-one history could not be loaded. Check your connection and try again.');
    expect(shown).not.toContain('That one-on-one history is no longer available.');
    expect(backend.announced).toEqual(['That one-on-one history could not be loaded. Check your connection and try again.']);
  });

  it('says the history is no longer available only when the read found it gone', async () => {
    setPlatform(os);
    backend.historyFailure = calendarRecordGone('One-on-one history could not be loaded.');
    expect(await openHistory()).toContain('That one-on-one history is no longer available.');
  });

  it('tells both in Spanish', async () => {
    setPlatform(os);
    backend.language = 'es';
    backend.historyFailure = offline();
    expect(await openHistory()).toContain('No se pudo cargar el historial de esa cita. Revise su conexión y vuelva a intentarlo.');
    await view?.unmount();
    backend.historyFailure = calendarRecordGone('One-on-one history could not be loaded.');
    expect(await openHistory()).toContain('El historial de esa cita ya no está disponible.');
  });

  // The failure line for one appointment's history must not be
  // spoken after the person has opened another one.
  it('cancels a pending history failure line when another one-on-one is opened', async () => {
    setPlatform(os);
    backend.secondAppointment = true;
    backend.historyFailure = offline();
    view = await render(h(LiveAppointmentsFeature));
    await settle();
    const names = exposedNames(view.container);
    const first = names.find((name) => name.startsWith('check in, confirmed'));
    const second = names.find((name) => name.startsWith('grievance, confirmed'));
    if (!first || !second) throw new Error(`Missing one-on-one cards among: ${names.join(' | ')}`);
    await press(getExposed(view.container, first));
    await settle();
    const line = 'That one-on-one history could not be loaded. Check your connection and try again.';
    expect(backend.announced).toEqual([line]);
    expect(backend.cancelled).toEqual([]);
    backend.historyFailure = new Promise(() => {});
    await press(getExposed(view.container, second));
    await settle();
    expect(backend.cancelled).toEqual([line]);
  });
});
