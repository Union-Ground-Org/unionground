import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('./supabase', () => ({
  getSupabaseClient: () => backend,
  assertFreshMobileCalendarSession: vi.fn(async () => 'member'),
}));
vi.mock('../../modules/native-calendar-export/src/NativeCalendarExportModule', () => ({ default: null }));

import { loadMobileEventsHistory, prepareAuthorizedEventCalendarExport } from './livedIn';

const event = { id: 'event', title: 'Meeting', starts_at: '2026-10-09T12:00:00Z', cancelled_at: null, location: 'Hall' };
type Operation = [string, ...unknown[]];
type Response = { data: unknown; error: { code: string; message: string } | null };

function mockReads(respond: (operations: Operation[]) => Response) {
  const calls: Operation[][] = [];
  backend.from.mockImplementation((table: string) => {
    const operations: Operation[] = [];
    const query = new Proxy({}, {
      get(_target, name: string) {
        if (name === 'then') return (resolve: (result: Response) => void) => {
          if (table !== 'member_events') return resolve({ data: [], error: null });
          calls.push(operations);
          return resolve(respond(operations));
        };
        return (...args: unknown[]) => { operations.push([name, ...args]); return query; };
      },
    });
    return query;
  });
  return calls;
}

afterEach(() => vi.clearAllMocks());

describe('native meeting reads across the hosted schema cutover', () => {
  it('keeps the event-model fallback after the check-in-only retry', async () => {
    const calls = mockReads((operations) => {
      const columns = String(operations[0]?.[1]);
      if (columns.includes('check_in_offered')) return { data: null, error: { code: '42703', message: 'column member_events.check_in_offered does not exist' } };
      if (columns.includes('event_kind')) return { data: null, error: { code: '42703', message: 'column member_events.event_kind does not exist' } };
      return { data: [event], error: null };
    });
    await expect(loadMobileEventsHistory()).resolves.toMatchObject([{ id: event.id, checkInOffered: false }]);
    expect(calls).toHaveLength(3);
    expect(calls[2]).toContainEqual(['order', 'starts_at', { ascending: true }]);
    expect(calls[2]).toContainEqual(['range', 0, 499]);
  });

  it.each(['42703', 'PGRST204'])('retries each history page with the same scope for %s and disables check-in', async (code) => {
    const calls = mockReads((operations) => {
      if (String(operations[0]?.[1]).includes('check_in_offered')) return { data: null, error: { code, message: 'column member_events.check_in_offered does not exist' } };
      const from = operations.find(([name]) => name === 'range')?.[1];
      return { data: from === 0 ? Array.from({ length: 500 }, (_, i) => ({ ...event, id: String(i) })) : [event], error: null };
    });
    const events = await loadMobileEventsHistory();
    expect(events).toHaveLength(501);
    expect(events.every((item) => item.checkInOffered === false)).toBe(true);
    expect(calls).toHaveLength(4);
    for (const index of [0, 2]) {
      expect(String(calls[index + 1]?.[0]?.[1])).toBe(String(calls[index]?.[0]?.[1]).split(',').filter((column) => column !== 'check_in_offered' && column !== 'rsvp_open').join(','));
      expect(calls[index + 1]?.slice(1)).toEqual(calls[index]?.slice(1));
    }
  });

  it.each(['42703', 'PGRST204'])('retries the authorized calendar read for %s', async (code) => {
    const calls = mockReads((operations) => String(operations[0]?.[1]).includes('check_in_offered')
      ? { data: null, error: { code, message: 'column member_events.check_in_offered does not exist' } }
      : { data: event, error: null });
    await expect(prepareAuthorizedEventCalendarExport(event.id, Date.parse('2026-10-08T12:00:00Z'))).resolves.toMatchObject({ title: event.title });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.slice(1)).toEqual(calls[0]?.slice(1));
    expect(String(calls[1]?.[0]?.[1])).not.toContain('check_in_offered');
  });

  it.each([
    { code: '42501', message: 'permission denied' },
    { code: '42703', message: 'column member_events.unrelated does not exist' },
    { code: '500', message: 'check_in_offered service failure' },
  ])('throws unrelated history errors without retry: $code', async (error) => {
    const calls = mockReads(() => ({ data: null, error }));
    await expect(loadMobileEventsHistory()).rejects.toBe(error);
    expect(calls).toHaveLength(1);
  });

  it('does not retry success and preserves migrated check-in availability', async () => {
    const calls = mockReads(() => ({ data: [{ ...event, check_in_offered: true }], error: null }));
    await expect(loadMobileEventsHistory()).resolves.toMatchObject([{ checkInOffered: true }]);
    expect(calls).toHaveLength(1);
  });

  it.each(['42703', 'PGRST204'])('drops only the RSVP switch for %s and reads every meeting as open', async (code) => {
    const calls = mockReads((operations) => String(operations[0]?.[1]).includes('rsvp_open')
      ? { data: null, error: { code, message: 'column member_events.rsvp_open does not exist' } }
      : { data: [{ ...event, check_in_offered: true }], error: null });
    await expect(loadMobileEventsHistory()).resolves.toMatchObject([{ checkInOffered: true, rsvpOpen: true }]);
    expect(calls).toHaveLength(2);
    expect(String(calls[1]?.[0]?.[1])).toBe(String(calls[0]?.[0]?.[1]).split(',').filter((column) => column !== 'rsvp_open').join(','));
    expect(calls[1]?.slice(1)).toEqual(calls[0]?.slice(1));
  });

  it('drops the RSVP switch with check-in on a database that predates both', async () => {
    const calls = mockReads((operations) => String(operations[0]?.[1]).includes('check_in_offered')
      ? { data: null, error: { code: '42703', message: 'column member_events.check_in_offered does not exist' } }
      : { data: [event], error: null });
    await expect(loadMobileEventsHistory()).resolves.toMatchObject([{ checkInOffered: false, rsvpOpen: true }]);
    expect(calls).toHaveLength(2);
    expect(String(calls[1]?.[0]?.[1])).not.toContain('rsvp_open');
  });

  it('carries a closed RSVP switch through', async () => {
    mockReads(() => ({ data: [{ ...event, rsvp_open: false }, { ...event, id: 'open', rsvp_open: true }], error: null }));
    const events = await loadMobileEventsHistory();
    expect(Object.fromEntries(events.map((item) => [item.id, item.rsvpOpen]))).toEqual({ event: false, open: true });
  });

  it('stops after one failed retry', async () => {
    const error = { code: '42703', message: 'column member_events.check_in_offered does not exist' };
    const calls = mockReads(() => ({ data: null, error }));
    await expect(loadMobileEventsHistory()).rejects.toBe(error);
    expect(calls).toHaveLength(2);
  });
});
