import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  auth: {
    getUser: vi.fn(),
    mfa: { getAuthenticatorAssuranceLevel: vi.fn() },
  },
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => backend, processLock: vi.fn() }));
vi.mock('../lib/config', () => ({
  mobileConfig: {
    backendConfigured: true,
    supabaseUrl: 'https://example.supabase.co',
    supabasePublishableKey: 'publishable-test-key',
  },
}));
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));
vi.mock('../../modules/native-calendar-export/src/NativeCalendarExportModule', () => ({ default: null }));

import * as livedInService from './livedIn';
import * as supabaseService from './supabase';
import { appointmentHistoryFailureText, calendarExportFailureText } from '../lib/calendarExportFailure';

type EventPreparer = (eventID: string, nowMs: number) => Promise<{
  title: string;
  startMs: number;
  endMs: number;
  location: string | null;
}>;

type AppointmentPreparer = (appointmentID: string, nowMs: number) => Promise<{
  title: string;
  startMs: number;
  endMs: number;
  location: string | null;
}>;

const prepareEvent = (livedInService as unknown as {
  prepareAuthorizedEventCalendarExport: EventPreparer;
}).prepareAuthorizedEventCalendarExport;
const prepareAppointment = (supabaseService as unknown as {
  prepareAuthorizedAppointmentCalendarExport: AppointmentPreparer;
}).prepareAuthorizedAppointmentCalendarExport;

const NOW = Date.parse('2026-09-03T12:00:00.000Z');
const EVENT_ID = 'event-current';
const APPOINTMENT_ID = 'a2222222-2222-4222-8222-222222222222';

function allowFreshSession() {
  backend.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-current' } }, error: null });
  backend.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({
    data: { currentLevel: 'aal2', nextLevel: 'aal2' },
    error: null,
  });
}

describe('press-time calendar export authorization', () => {
  beforeEach(() => {
    backend.auth.getUser.mockReset();
    backend.auth.mfa.getAuthenticatorAssuranceLevel.mockReset();
    backend.from.mockReset();
    backend.rpc.mockReset();
    allowFreshSession();
  });

  it('builds the meeting payload only from the newly authorized RLS row', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: EVENT_ID,
        title: ' Fresh\u0000 title ',
        starts_at: '2026-09-04T14:00:00.000Z',
        location: ' New room\n ',
        cancelled_at: null,
      },
      error: null,
    });
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    backend.from.mockReturnValue({ select });

    await expect(prepareEvent(EVENT_ID, NOW)).resolves.toEqual({
      title: 'Fresh title',
      startMs: Date.parse('2026-09-04T14:00:00.000Z'),
      endMs: Date.parse('2026-09-04T15:00:00.000Z'),
      location: 'New room',
    });
    expect(backend.auth.getUser).toHaveBeenCalledTimes(2);
    expect(backend.auth.mfa.getAuthenticatorAssuranceLevel).toHaveBeenCalledTimes(2);
    expect(backend.from).toHaveBeenCalledWith('member_events');
    expect(select).toHaveBeenCalledWith('id,title,starts_at,ends_at,event_kind,event_date,location,cancelled_at,check_in_offered');
    expect(eq).toHaveBeenCalledWith('id', EVENT_ID);
    expect(maybeSingle).toHaveBeenCalledOnce();
    expect(backend.auth.getUser.mock.invocationCallOrder[0])
      .toBeLessThan(maybeSingle.mock.invocationCallOrder[0] ?? 0);
    expect(maybeSingle.mock.invocationCallOrder[0])
      .toBeLessThan(backend.auth.getUser.mock.invocationCallOrder[1] ?? 0);
  });

  it.each(['42703', 'PGRST204'])('retries calendar export once with legacy columns: %s', async (code) => {
    const maybeSingle = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code, message: 'column member_events.event_kind does not exist' } })
      .mockResolvedValueOnce({ data: { id: EVENT_ID, title: 'Legacy meeting', starts_at: '2026-09-04T14:00:00Z', cancelled_at: null, location: 'Hall' }, error: null });
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn<(columns: string) => { eq: typeof eq }>(() => ({ eq }));
    backend.from.mockReturnValue({ select });
    await expect(prepareEvent(EVENT_ID, NOW)).resolves.toMatchObject({ title: 'Legacy meeting' });
    expect(maybeSingle).toHaveBeenCalledTimes(2);
    expect(select.mock.calls[1]?.[0]).not.toMatch(/ends_at|event_kind|event_date|series_id|sort_at|check_in_offered/);
    expect(eq.mock.calls).toEqual([['id', EVENT_ID], ['id', EVENT_ID]]);
    expect(backend.auth.getUser).toHaveBeenCalledTimes(2);
  });

  it('refuses meeting export after the exact RLS row is revoked', async () => {
    backend.from.mockReturnValue({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
    });

    await expect(prepareEvent(EVENT_ID, NOW)).rejects.toThrow('Meeting export is no longer authorized.');
  });

  it('refuses a meeting row whose cancellation state cannot be confirmed', async () => {
    backend.from.mockReturnValue({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: {
              id: EVENT_ID,
              title: 'Current meeting',
              starts_at: '2026-09-04T14:00:00.000Z',
              location: 'Current room',
            },
            error: null,
          }),
        }),
      }),
    });

    await expect(prepareEvent(EVENT_ID, NOW)).rejects.toThrow('Meeting export is no longer authorized.');
  });

  it('refuses a meeting payload when the authenticated user changes during the authorized read', async () => {
    backend.auth.getUser
      .mockResolvedValueOnce({ data: { user: { id: 'user-a' } }, error: null })
      .mockResolvedValueOnce({ data: { user: { id: 'user-b' } }, error: null });
    backend.from.mockReturnValue({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: {
              id: EVENT_ID,
              title: 'Current meeting',
              starts_at: '2026-09-04T14:00:00.000Z',
              location: 'Current room',
              cancelled_at: null,
            },
            error: null,
          }),
        }),
      }),
    });

    await expect(prepareEvent(EVENT_ID, NOW)).rejects.toThrow('Calendar export authorization changed.');
    expect(backend.auth.getUser).toHaveBeenCalledTimes(2);
    expect(backend.auth.mfa.getAuthenticatorAssuranceLevel).toHaveBeenCalledTimes(2);
  });

  it('refuses export when the fresh session is missing', async () => {
    backend.auth.getUser.mockResolvedValue({ data: { user: null }, error: null });

    await expect(prepareEvent(EVENT_ID, NOW)).rejects.toThrow('Calendar export requires a current session.');
    expect(backend.auth.mfa.getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
    expect(backend.from).not.toHaveBeenCalled();
  });

  it('refuses export when MFA is required or its assurance cannot be checked', async () => {
    backend.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValueOnce({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    });
    await expect(prepareEvent(EVENT_ID, NOW)).rejects.toThrow('Calendar export requires MFA revalidation.');

    backend.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValueOnce({
      data: null,
      error: new Error('assurance unavailable'),
    });
    await expect(prepareEvent(EVENT_ID, NOW)).rejects.toThrow('Calendar export assurance could not be confirmed.');
    expect(backend.from).not.toHaveBeenCalled();
  });

  it('builds the one-on-one payload only from the exact newly authorized RPC row', async () => {
    backend.rpc.mockResolvedValue({
      data: {
        appointment: {
          id: APPOINTMENT_ID,
          startsAt: '2026-09-05T16:00:00.000Z',
          endsAt: '2026-09-05T16:45:00.000Z',
          status: 'confirmed',
          appointmentType: 'protected-type',
          reasonCategory: 'protected-reason',
        },
        items: [],
        nextBefore: null,
        nextBeforeID: null,
      },
      error: null,
    });

    const payload = await prepareAppointment(APPOINTMENT_ID, NOW);
    expect(payload).toEqual({
      title: 'Union Ground one-on-one',
      startMs: Date.parse('2026-09-05T16:00:00.000Z'),
      endMs: Date.parse('2026-09-05T16:45:00.000Z'),
      location: null,
    });
    expect(JSON.stringify(payload)).not.toContain(APPOINTMENT_ID);
    expect(JSON.stringify(payload)).not.toContain('protected');
    expect(backend.rpc).toHaveBeenCalledWith('get_appointment_history', {
      p_appointment_id: APPOINTMENT_ID,
      p_before: null,
      p_before_id: null,
      p_limit: 1,
    });
    expect(backend.auth.getUser).toHaveBeenCalledTimes(2);
    expect(backend.auth.mfa.getAuthenticatorAssuranceLevel).toHaveBeenCalledTimes(2);
    expect(backend.auth.getUser.mock.invocationCallOrder[0])
      .toBeLessThan(backend.rpc.mock.invocationCallOrder[0] ?? 0);
    expect(backend.rpc.mock.invocationCallOrder[0])
      .toBeLessThan(backend.auth.getUser.mock.invocationCallOrder[1] ?? 0);
  });

  it('refuses a one-on-one payload when MFA assurance drops during the authorized read', async () => {
    backend.auth.mfa.getAuthenticatorAssuranceLevel
      .mockResolvedValueOnce({
        data: { currentLevel: 'aal2', nextLevel: 'aal2' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { currentLevel: 'aal1', nextLevel: 'aal2' },
        error: null,
      });
    backend.rpc.mockResolvedValue({
      data: {
        appointment: {
          id: APPOINTMENT_ID,
          startsAt: '2026-09-05T16:00:00.000Z',
          endsAt: '2026-09-05T16:45:00.000Z',
          status: 'confirmed',
        },
      },
      error: null,
    });

    await expect(prepareAppointment(APPOINTMENT_ID, NOW)).rejects.toThrow(
      'Calendar export requires MFA revalidation.',
    );
    expect(backend.rpc).toHaveBeenCalledOnce();
    expect(backend.auth.getUser).toHaveBeenCalledTimes(2);
    expect(backend.auth.mfa.getAuthenticatorAssuranceLevel).toHaveBeenCalledTimes(2);
  });

  it('refuses one-on-one export after exact authorization is revoked or malformed', async () => {
    backend.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'denied' } });
    await expect(prepareAppointment(APPOINTMENT_ID, NOW)).rejects.toThrow('One-on-one export is no longer authorized.');

    backend.rpc.mockResolvedValueOnce({ data: { appointment: null }, error: null });
    await expect(prepareAppointment(APPOINTMENT_ID, NOW)).rejects.toThrow('One-on-one export is no longer authorized.');
  });

  // #9462 (M2-11): only a read that found the record gone is told as gone.
  const failureText = async (run: Promise<unknown>, record: 'event' | 'appointment') => {
    const failure = await run.then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    return calendarExportFailureText(failure, record);
  };
  const eventRead = (answer: { data: unknown; error: unknown }) => backend.from.mockReturnValue({
    select: () => ({ eq: () => ({ maybeSingle: async () => answer }) }),
  });

  it('tells a gone meeting apart from a meeting read that failed', async () => {
    eventRead({ data: null, error: null });
    expect(await failureText(prepareEvent(EVENT_ID, NOW), 'event')).toBe('That meeting is no longer available.');
    eventRead({ data: { id: EVENT_ID, title: 'Called off', starts_at: '2026-09-04T14:00:00.000Z', location: 'Hall', cancelled_at: '2026-09-03T11:00:00.000Z' }, error: null });
    expect(await failureText(prepareEvent(EVENT_ID, NOW), 'event')).toBe('That meeting is no longer available.');
    eventRead({ data: null, error: { code: '', message: 'TypeError: Network request failed' } });
    expect(await failureText(prepareEvent(EVENT_ID, NOW), 'event')).toBe('The meeting could not be added to your calendar. Check your connection and try again.');
    eventRead({ data: null, error: { code: '42501', message: 'permission denied for table member_events' } });
    expect(await failureText(prepareEvent(EVENT_ID, NOW), 'event')).toBe('The meeting could not be added to your calendar. Check your connection and try again.');
    backend.auth.getUser.mockResolvedValueOnce({ data: { user: null }, error: { name: 'AuthRetryableFetchError', status: 0 } });
    expect(await failureText(prepareEvent(EVENT_ID, NOW), 'event')).toBe('The meeting could not be added to your calendar. Check your connection and try again.');
  });

  it('tells a gone one-on-one apart from a one-on-one read that failed', async () => {
    backend.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'history unavailable' } });
    expect(await failureText(prepareAppointment(APPOINTMENT_ID, NOW), 'appointment')).toBe('That one-on-one is no longer available.');
    backend.rpc.mockResolvedValueOnce({ data: { appointment: null }, error: null });
    expect(await failureText(prepareAppointment(APPOINTMENT_ID, NOW), 'appointment')).toBe('That one-on-one is no longer available.');
    backend.rpc.mockResolvedValueOnce({ data: { appointment: { id: APPOINTMENT_ID, startsAt: '2026-09-05T16:00:00.000Z', endsAt: '2026-09-05T16:45:00.000Z', status: 'cancelled' } }, error: null });
    expect(await failureText(prepareAppointment(APPOINTMENT_ID, NOW), 'appointment')).toBe('That one-on-one is no longer available.');
    backend.rpc.mockResolvedValueOnce({ data: null, error: { code: '', message: 'TypeError: Network request failed' } });
    expect(await failureText(prepareAppointment(APPOINTMENT_ID, NOW), 'appointment')).toBe('The one-on-one could not be added to your calendar. Check your connection and try again.');
    // 22023 is the RPC's answer for a session it cannot confirm (no user, MFA not met).
    backend.rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'history unavailable' } });
    expect(await failureText(prepareAppointment(APPOINTMENT_ID, NOW), 'appointment')).toBe('The one-on-one could not be added to your calendar. Check your connection and try again.');
  });

  // Gate round 1 (r1s1): staff can turn a meeting into a deadline or a date-only
  // event (update_member_event_model), whose start time is null.
  it.each(['date_only', 'deadline'])('tells a meeting turned into a %s meeting with no start time as gone', async (kind) => {
    eventRead({ data: { id: EVENT_ID, title: 'Filing deadline', starts_at: null, ends_at: null, event_kind: kind, event_date: '2026-12-01', location: null, cancelled_at: null }, error: null });
    expect(await failureText(prepareEvent(EVENT_ID, NOW), 'event')).toBe('That meeting is no longer available.');
  });

  it('does not tell a malformed readable row or changed refusal wording as gone', async () => {
    eventRead({ data: { id: EVENT_ID, title: 42, starts_at: '2026-09-04T14:00:00.000Z', event_kind: 'meeting', location: 'Hall', cancelled_at: null }, error: null });
    expect(await failureText(prepareEvent(EVENT_ID, NOW), 'event')).toBe('The meeting could not be added to your calendar. Check your connection and try again.');
    eventRead({ data: { id: 'another-event', title: 'Other', starts_at: null, event_kind: 'date_only', location: null, cancelled_at: null }, error: null });
    expect(await failureText(prepareEvent(EVENT_ID, NOW), 'event')).toBe('The meeting could not be added to your calendar. Check your connection and try again.');
    backend.rpc.mockResolvedValueOnce({ data: { appointment: { id: APPOINTMENT_ID, startsAt: 7, endsAt: '2026-09-05T16:45:00.000Z', status: 'confirmed' } }, error: null });
    expect(await failureText(prepareAppointment(APPOINTMENT_ID, NOW), 'appointment')).toBe('The one-on-one could not be added to your calendar. Check your connection and try again.');
    backend.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'permission denied for function get_appointment_history' } });
    expect(await failureText(prepareAppointment(APPOINTMENT_ID, NOW), 'appointment')).toBe('The one-on-one could not be added to your calendar. Check your connection and try again.');
  });

  // #9462 (wave 3): the history read tags gone only on 42501 "history unavailable".
  it('tells a gone one-on-one history apart from a history read that failed', async () => {
    const historyText = async () => appointmentHistoryFailureText(
      await supabaseService.loadMobileAppointmentHistory(APPOINTMENT_ID).then(() => null, (error: unknown) => error),
    );
    backend.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'history unavailable' } });
    expect(await historyText()).toBe('That one-on-one history is no longer available.');
    backend.rpc.mockResolvedValueOnce({ data: null, error: { code: '', message: 'TypeError: Network request failed' } });
    expect(await historyText()).toBe('That one-on-one history could not be loaded. Check your connection and try again.');
    backend.rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'history unavailable' } });
    expect(await historyText()).toBe('That one-on-one history could not be loaded. Check your connection and try again.');
    backend.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'permission denied for function get_appointment_history' } });
    expect(await historyText()).toBe('That one-on-one history could not be loaded. Check your connection and try again.');
    backend.rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await historyText()).toBe('That one-on-one history could not be loaded. Check your connection and try again.');
  });
});
