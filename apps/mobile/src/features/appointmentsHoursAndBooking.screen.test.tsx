import { stubSessionWriter } from '../testing/stubSessionWriter';
// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exposedNames, getExposed, press, render, type, type Rendered } from '../testing/reactNativeStandIn';
import palette from '../theme/palette.json';
import { AppointmentBookingCard } from './AppointmentBookingCard';
import { AppointmentHoursCard } from './AppointmentHoursCard';
import { LiveAppointmentsFeature } from './LiveAppointmentsFeature';
import { slotSearchSpan } from '../lib/appointmentBooking';
import { nativeUiText } from '../lib/nativeUiCopy';
import type { MobileAppointmentHistory } from '../services/supabase';

// BUG-UG-NATIVE-IOS-APPOINTMENTS-NO-HOURS-OR-BOOKING-20261117:
// drives the phone's Appointments screen against a stand-in backend that
// answers the website's own RPCs: a steward saves a weekly window and sees it
// again after reopening the screen, and a member books an open time next week
// and sees the booked row in their list.

type Window = { weekday: number; startMinute: number; endMinute: number };

const backend = vi.hoisted(() => ({
  windows: [] as { weekday: number; startMinute: number; endMinute: number }[],
  accepting: true as boolean,
  appointments: [] as { id: string; startsAt: string; endsAt: string; status: 'confirmed'; appointmentType: string; stewardName?: string }[],
  historyItems: [] as MobileAppointmentHistory['items'],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  bookingError: null as null | { code: string; message: string },
  timezone: 'America/New_York' as string | null,
  refuseWindows: false,
  refuseAccepting: false,
  proof: 'current' as 'current' | 'unavailable',
  stewards: [{ id: 'steward-fixture-1', name: 'Rae Fixture' }] as { id: string; name: string }[],
  language: 'en' as 'en' | 'es',
  chapterRoles: [] as string[],
  stewardFailures: 0,
}));

function rpc(name: string, args: Record<string, unknown> = {}) {
  backend.calls.push({ name, args });
  if (name === 'set_appointment_windows') {
    if (backend.refuseWindows) return { data: null, error: { code: '42501', message: 'committee member role required' } };
    backend.windows = (args.p_windows as Window[]).map((window) => ({ ...window }));
    return { data: { windows: backend.windows.length }, error: null };
  }
  if (name === 'set_appointment_schedule') {
    if (backend.refuseAccepting) return { data: null, error: { code: '42501', message: 'settings changed' } };
    if (typeof args.p_accepting === 'boolean') backend.accepting = args.p_accepting;
    return { data: { accepting: backend.accepting }, error: null };
  }
  if (name === 'get_bookable_stewards') {
    if (backend.stewardFailures > 0) { backend.stewardFailures -= 1; return { data: null, error: { code: '08006', message: 'connection failure' } }; }
    return { data: backend.stewards, error: null };
  }
  if (name === 'get_appointment_slots') {
    return { data: { slots: [
      { startsAt: '2026-11-24T14:00:00Z', stewardCount: 1 },
      { startsAt: '2026-11-24T15:00:00Z', stewardCount: 1 },
      { startsAt: '2026-11-25T16:00:00Z', stewardCount: 1 },
    ] }, error: null };
  }
  if (name === 'book_appointment') {
    if (backend.bookingError) return { data: null, error: backend.bookingError };
    const startsAt = String(args.p_starts_at);
    backend.appointments.push({
      id: `booked-${backend.appointments.length + 1}`,
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + Number(args.p_duration) * 60_000).toISOString(),
      status: 'confirmed',
      appointmentType: String(args.p_type),
      stewardName: 'Rae Fixture',
    });
    return { data: { id: 'booked' }, error: null };
  }
  return { data: null, error: { code: 'PGRST202', message: `unexpected ${name}` } };
}

vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../components/ui', () => import('../testing/uiStandIn'));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../services/haptics', () => ({ haptics: { success: vi.fn(async () => undefined) } }));
vi.mock('../services/nativeCalendarExport', () => ({
  calendarExportWasSaved: () => false,
  exportToDeviceCalendar: vi.fn(),
  isCalendarExportAvailable: () => false,
}));
vi.mock('../state/AppProvider', () => ({
  useApp: () => ({
    mode: 'authenticated',
    dashboard: { member: { chapterID: 'chapter-fixture', language: backend.language } },
    authorizedRoles: backend.chapterRoles,
    chapterRoles: backend.chapterRoles,
    organizationRoles: [],
    captureAuthenticatedSessionGuard: () => () => true,
    sampleHat: null,
    liveSampleBackend: false,
  }),
}));
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: { user?: { id?: string } } | null) => ({ ...stubSessionWriter(() => ({ rpc: async (name: string, args?: Record<string, unknown>) => rpc(name, args) }), session?.user?.id ?? 'member-a'), check: async () => backend.proof }),
  getSupabaseClient: () => ({ rpc: async (name: string, args?: Record<string, unknown>) => rpc(name, args) }),
  loadMobileAppointments: async () => backend.appointments.map((item) => ({ ...item })),
  loadMobileSupervisedAppointments: async () => [],
  loadMobileAppointmentHistory: async () => ({ appointment: null, items: backend.historyItems, nextBefore: null, nextBeforeID: null }),
  prepareAuthorizedAppointmentCalendarExport: vi.fn(),
}));
// The steward desk read returns what set_appointment_windows stored, as
// get_steward_appointments does.
vi.mock('../services/livedIn', () => ({
  loadMobileStewardAppointmentsDesk: async () => ({
    upcoming: [], recent: [], outcomes: { completed30d: null, noShows30d: null }, connections: [],
    availability: {
      timezone: backend.timezone, accepting: backend.accepting, minNoticeMinutes: 240, blackouts: [],
      windows: backend.windows.map((window, index) => ({ id: `window-${index}`, ...window })),
    },
  }),
}));

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function text(view: Rendered): string {
  return view.container.textContent ?? '';
}

let view: Rendered | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-17T17:00:00Z'));
  backend.windows = [];
  backend.accepting = true;
  backend.appointments = [];
  backend.historyItems = [];
  backend.calls = [];
  backend.bookingError = null;
  backend.timezone = 'America/New_York';
  backend.refuseWindows = false;
  backend.refuseAccepting = false;
  backend.proof = 'current';
  backend.stewards = [{ id: 'steward-fixture-1', name: 'Rae Fixture' }];
  backend.language = 'en';
  backend.chapterRoles = [];
  backend.stewardFailures = 0;
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  vi.useRealTimers();
});

async function open(): Promise<Rendered> {
  view = await render(<LiveAppointmentsFeature />);
  await settle();
  return view;
}

describe('a committee member sets booking hours from One-on-ones', () => {
  it.each<'en' | 'es'>(['en', 'es'])('keeps partial failure and refresh information when Auth is unavailable (%s)', async (language) => {
    backend.language = language;
    backend.chapterRoles = ['steward'];
    backend.refuseAccepting = true;
    backend.proof = 'unavailable';
    const t = nativeUiText(language);
    const screen = await open();
    await press(getExposed(screen.container, t('Set booking hours')));
    await press(getExposed(screen.container, t('Add hours')));
    await press(getExposed(screen.container, t('Workers can book time with me')));
    await press(getExposed(screen.container, t('Save hours')));
    await settle();
    expect(backend.windows).toHaveLength(1);
    expect(backend.accepting).toBe(true);
    expect(text(screen)).toContain(t('Your hours were saved, but taking bookings could not be changed. Try again.'));
    expect(text(screen)).toContain(t('Reopen this screen to see it.'));
  });
  it('adds and changes a weekly window, saves it, and sees it again after reopening', async () => {
    backend.chapterRoles = ['steward'];
    let screen = await open();
    expect(text(screen)).toContain('No weekly hours yet');

    await press(getExposed(screen.container, 'Set booking hours'));
    await press(getExposed(screen.container, 'Add hours'));
    await press(getExposed(screen.container, 'End later: Monday 9:00 AM–12:00 PM'));
    await press(getExposed(screen.container, 'Later day: Monday 9:00 AM–12:15 PM'));
    await press(getExposed(screen.container, 'Save hours'));
    await settle();

    const saves = backend.calls.filter((call) => call.name === 'set_appointment_windows');
    expect(saves).toHaveLength(1);
    expect(saves[0]!.args).toEqual({ p_windows: [{ weekday: 2, startMinute: 540, endMinute: 735 }] });
    // Taking bookings did not change, so the schedule is left alone.
    expect(backend.calls.some((call) => call.name === 'set_appointment_schedule')).toBe(false);
    expect(text(screen)).toContain('Booking hours saved.');
    expect(text(screen)).toContain('Tuesday · 9:00 AM–12:15 PM');

    await screen.unmount();
    view = null;
    screen = await open();
    expect(text(screen)).toContain('Tuesday · 9:00 AM–12:15 PM');
    expect(text(screen)).not.toContain('No weekly hours yet');
  });

  it('pauses bookings through the schedule RPC without sending any other schedule field', async () => {
    backend.chapterRoles = ['steward'];
    backend.windows = [{ weekday: 1, startMinute: 540, endMinute: 720 }];
    const screen = await open();
    await press(getExposed(screen.container, 'Set booking hours'));
    await press(getExposed(screen.container, 'Workers can book time with me'));
    await press(getExposed(screen.container, 'Save hours'));
    await settle();
    expect(backend.calls.find((call) => call.name === 'set_appointment_schedule')?.args).toEqual({
      p_timezone: null, p_min_notice_minutes: null, p_buffer_before_minutes: null,
      p_buffer_after_minutes: null, p_max_per_day: null, p_accepting: false,
    });
    expect(text(screen)).toContain('Paused');
  });

  it('refuses overlapping hours on the phone before anything is sent', async () => {
    backend.chapterRoles = ['steward'];
    backend.windows = [{ weekday: 1, startMinute: 540, endMinute: 720 }];
    const screen = await open();
    await press(getExposed(screen.container, 'Set booking hours'));
    await press(getExposed(screen.container, 'Add hours'));
    await press(getExposed(screen.container, 'Earlier day: Tuesday 9:00 AM–12:00 PM'));
    await press(getExposed(screen.container, 'Save hours'));
    await settle();
    expect(text(screen)).toContain('Hours on the same day must not overlap.');
    expect(backend.calls.some((call) => call.name === 'set_appointment_windows')).toBe(false);
  });
});

describe('a worker books time with a committee member from One-on-ones', () => {
  it('picks a time next week, books it, and sees the booked row in the list', async () => {
    const screen = await open();
    expect(exposedNames(screen.container)).not.toContain('Set booking hours');
    expect(text(screen)).toContain('No one-on-ones');

    await press(getExposed(screen.container, 'Book a time'));
    await settle();
    await press(getExposed(screen.container, 'Office hours'));
    await settle();

    const span = slotSearchSpan(new Date());
    const search = backend.calls.find((call) => call.name === 'get_appointment_slots');
    expect(search?.args).toEqual({ p_type: 'office_hours', p_duration: 30, p_from: span.from, p_to: span.to, p_steward: null });

    await press(getExposed(screen.container, 'Tue, Nov 24'));
    await press(getExposed(screen.container, '10:00 AM ET'));
    await type(getExposed(screen.container, 'Location, room, or meeting link'), 'Union hall, Room 2');
    await press(getExposed(screen.container, 'Confirm booking'));
    await settle();

    expect(backend.calls.find((call) => call.name === 'book_appointment')?.args).toEqual({
      p_type: 'office_hours', p_duration: 30, p_starts_at: '2026-11-24T15:00:00Z',
      p_place: 'Union hall, Room 2', p_steward: null, p_reason: 'general',
    });
    expect(backend.appointments).toHaveLength(1);
    expect(text(screen)).toContain('Booked. Your one-on-one is in the list below.');
    expect(text(screen)).toContain('Upcoming');
    expect(text(screen)).toContain('office hours');
    expect(text(screen)).not.toContain('No one-on-ones');
  });

  it.each([
    ['en', 'Tue, Nov 24, 2026, 10:00 – 10:30 AM ET'],
    ['es', 'mar, 24 de nov de 2026, 10:00–10:30 a.m. ET'],
  ])('shows and speaks the full one-on-one range in %s', async (language, label) => {
    backend.language = language === 'es' ? 'es' : 'en';
    backend.appointments = [{
      id: 'range-fixture', startsAt: '2026-11-24T15:00:00Z', endsAt: '2026-11-24T15:30:00Z',
      status: 'confirmed', appointmentType: 'office_hours',
    }];
    const screen = await open();

    expect(text(screen)).toContain(label);
    expect(exposedNames(screen.container)).toContain(`office hours, confirmed, ${label}, One-on-one`);
  });

  it('books with a named committee member', async () => {
    const screen = await open();
    await press(getExposed(screen.container, 'Book a time'));
    await settle();
    await press(getExposed(screen.container, 'Contract questions'));
    await press(getExposed(screen.container, '45 min'));
    await press(getExposed(screen.container, 'Rae Fixture'));
    await settle();
    expect(backend.calls.filter((call) => call.name === 'get_appointment_slots').at(-1)?.args).toMatchObject({ p_type: 'contract_questions', p_duration: 45, p_steward: 'steward-fixture-1' });
    await press(getExposed(screen.container, '9:00 AM ET'));
    await type(getExposed(screen.container, 'Location, room, or meeting link'), 'Break room');
    await press(getExposed(screen.container, 'Confirm booking'));
    await settle();
    expect(backend.calls.find((call) => call.name === 'book_appointment')?.args).toMatchObject({ p_steward: 'steward-fixture-1', p_duration: 45, p_starts_at: '2026-11-24T14:00:00Z' });
  });

  it('needs a place before it books', async () => {
    const screen = await open();
    await press(getExposed(screen.container, 'Book a time'));
    await settle();
    await press(getExposed(screen.container, 'Onboarding'));
    await settle();
    await press(getExposed(screen.container, '9:00 AM ET'));
    await press(getExposed(screen.container, 'Confirm booking'));
    await settle();
    expect(text(screen)).toContain('Add where the one-on-one will happen.');
    expect(backend.calls.some((call) => call.name === 'book_appointment')).toBe(false);
  });

  it('reads the open times again when the server refuses the booking', async () => {
    // The server's own refusal when the time went while the member chose it.
    backend.bookingError = { code: '22023', message: 'that time is no longer available' };
    const screen = await open();
    await press(getExposed(screen.container, 'Book a time'));
    await settle();
    await press(getExposed(screen.container, 'Office hours'));
    await settle();
    await press(getExposed(screen.container, '9:00 AM ET'));
    await type(getExposed(screen.container, 'Location, room, or meeting link'), 'Union hall');
    await press(getExposed(screen.container, 'Confirm booking'));
    await settle();
    expect(text(screen)).toContain('That time could not be booked.');
    expect(backend.calls.filter((call) => call.name === 'get_appointment_slots')).toHaveLength(2);
    expect(backend.appointments).toHaveLength(0);
  });

  it('speaks Spanish when the worker reads the app in Spanish', async () => {
    backend.language = 'es';
    const screen = await open();
    await press(getExposed(screen.container, 'Reservar una hora'));
    await settle();
    expect(exposedNames(screen.container)).toContain('Horas de oficina');
    expect(text(screen)).toContain('¿De qué se trata?');
  });
});

describe('the two cards on their own', () => {
  const english = nativeUiText('en');

  it('says plainly when the server refuses the hours for this account, and keeps the saved hours', async () => {
    backend.refuseWindows = true;
    backend.windows = [{ weekday: 4, startMinute: 600, endMinute: 660 }];
    view = await render(<AppointmentHoursCard t={english} />);
    await settle();
    await press(getExposed(view.container, 'Set booking hours'));
    await press(getExposed(view.container, 'Remove these hours: Thursday 10:00 AM–11:00 AM'));
    await press(getExposed(view.container, 'Save hours'));
    await settle();
    expect(text(view)).toContain('This account cannot set booking hours.');
    expect(backend.windows).toEqual([{ weekday: 4, startMinute: 600, endMinute: 660 }]);
  });

  it('tells a worker when no committee member takes one-on-ones and asks for no open times', async () => {
    backend.stewards = [];
    const onBooked = vi.fn();
    view = await render(<AppointmentBookingCard t={english} locale="en-US" onBooked={onBooked} />);
    await press(getExposed(view.container, 'Book a time'));
    await settle();
    await press(getExposed(view.container, 'Office hours'));
    await settle();
    expect(text(view)).toContain('No committee members are taking one-on-ones right now.');
    expect(backend.calls.some((call) => call.name === 'get_appointment_slots')).toBe(false);
    expect(onBooked).not.toHaveBeenCalled();
  });
});

// BUG-UG-LOADING-NEVER-ENDS-AND-NO-RETRY-20261122: a
// steward list that failed to load used to offer no way to try again short of
// closing the form and opening it again.
describe('the steward list retries in place', () => {
  it.each<'en' | 'es'>(['en', 'es'])('says the committee members did not load and reads them again from Try again (%s)', async (language) => {
    backend.language = language;
    backend.stewardFailures = 1;
    const t = nativeUiText(language);
    view = await render(<AppointmentBookingCard t={t} locale={language === 'es' ? 'es-US' : 'en-US'} onBooked={vi.fn()} />);
    await press(getExposed(view.container, t('Book a time')));
    await settle();
    expect(text(view)).toContain(t('Committee members could not be read. Try again.'));
    expect(text(view)).not.toContain(t('No committee members are taking one-on-ones right now.'));
    await press(getExposed(view.container, t('Try again')));
    await settle();
    expect(backend.calls.filter((call) => call.name === 'get_bookable_stewards')).toHaveLength(2);
    expect(text(view)).not.toContain(t('Committee members could not be read. Try again.'));
    expect(exposedNames(view.container)).toContain('Rae Fixture');
    expect(exposedNames(view.container)).not.toContain(t('Try again'));
  });
});

// (both introduced by this change).
describe('repairs', () => {
  async function bookOneTime(screen: Rendered, labels: { book: string; type: string; time: string; place: string; confirm: string }) {
    await press(getExposed(screen.container, labels.book));
    await settle();
    await press(getExposed(screen.container, labels.type));
    await settle();
    await press(getExposed(screen.container, labels.time));
    await type(getExposed(screen.container, labels.place), 'Union hall');
    await press(getExposed(screen.container, labels.confirm));
    await settle();
  }

  it('explains the three-upcoming cap instead of sending the worker to another time', async () => {
    backend.bookingError = { code: '22023', message: 'you already have 3 upcoming one-on-ones' };
    const screen = await open();
    await bookOneTime(screen, { book: 'Book a time', type: 'Office hours', time: '9:00 AM ET', place: 'Location, room, or meeting link', confirm: 'Confirm booking' });
    expect(text(screen)).toContain('You already have three upcoming one-on-ones. One of them has to take place or be cancelled before you can book another.');
    expect(text(screen)).not.toContain('It may have just been taken');
    // Another time cannot fix the cap, so the times are not read again.
    expect(backend.calls.filter((call) => call.name === 'get_appointment_slots')).toHaveLength(1);
  });

  it('explains the cap in Spanish too', async () => {
    backend.language = 'es';
    backend.bookingError = { code: '22023', message: 'you already have 3 upcoming one-on-ones' };
    const screen = await open();
    await bookOneTime(screen, { book: 'Reservar una hora', type: 'Horas de oficina', time: '9:00 a.m. ET', place: 'Lugar, sala o enlace de la reunión', confirm: 'Confirmar reserva' });
    expect(text(screen)).toContain('Ya tiene tres citas próximas.');
  });

  it("names the schedule's saved zone, not the phone's, beside the hours and in the editor", async () => {
    backend.chapterRoles = ['steward'];
    backend.timezone = 'America/Los_Angeles';
    backend.windows = [{ weekday: 1, startMinute: 540, endMinute: 720 }];
    const screen = await open();
    expect(text(screen)).toContain('Monday · 9:00 AM–12:00 PM');
    expect(text(screen)).toContain('Hours are in Pacific time (America/Los_Angeles).');
    expect(text(screen)).not.toContain('in your timezone');
    await press(getExposed(screen.container, 'Set booking hours'));
    expect(text(screen)).toContain('Hours are in Pacific time (America/Los_Angeles).');
    // The phone never sends a zone, so saving keeps the saved one.
    await press(getExposed(screen.container, 'Save hours'));
    await settle();
    expect(backend.calls.some((call) => call.name === 'set_appointment_schedule')).toBe(false);
    expect(text(screen)).toContain('Hours are in Pacific time (America/Los_Angeles).');
  });

  it('says which zone a first save will use when no schedule exists yet, in Spanish too', async () => {
    backend.chapterRoles = ['steward'];
    backend.timezone = null;
    let screen = await open();
    expect(text(screen)).toContain('Your first save uses the time zone on your profile, or Eastern time if none is set.');
    await screen.unmount();
    view = null;
    backend.language = 'es';
    backend.timezone = 'America/Chicago';
    screen = await open();
    expect(text(screen)).toContain('Las horas están en la hora del Centro (America/Chicago).');
  });
});


it.each<{ language: 'en' | 'es'; historyDate: string }>([
  { language: 'en', historyDate: 'Fri, Jul 3, 2026, 10:15 PM ET' },
  { language: 'es', historyDate: 'vie, 3 de jul de 2026, 10:15 p.m. ET' },
])('uses the one-on-one clock for history in $language', async ({ language, historyDate }) => {
  vi.stubEnv('TZ', 'Asia/Tokyo');
  try {
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Asia/Tokyo');
    backend.language = language;
    backend.appointments = [{
      id: 'appointment-fixture', startsAt: '2026-11-24T14:00:00Z', endsAt: '2026-11-24T14:30:00Z',
      status: 'confirmed', appointmentType: 'check_in',
    }];
    backend.historyItems = [
      { id: 'event-1', action: 'booked', createdAt: '2026-07-04 02:15:00.123456+00', actorKind: 'member', detail: {} },
      { id: 'event-2', action: 'reminder_sent', createdAt: 'invalid', actorKind: 'system', detail: {} },
    ];
    const screen = await open();
    await press(getExposed(screen.container, /^check in, confirmed,/u));
    await settle();
    expect(text(screen)).toContain(`worker · ${historyDate}`);
    expect(text(screen)).toContain(`system · ${nativeUiText(language)('Time unavailable')}`);
  } finally {
    vi.unstubAllEnvs();
  }
});
