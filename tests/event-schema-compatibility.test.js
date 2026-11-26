// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
// tests/setup.js registers Spanish only for DOM files; this node file reads it.
import '../src/lib/i18n/allLanguages.js';
import { createAdminEvent, updateAdminEvent, fetchMemberEventsForChapter, loadAuthorizedCalendarEvent, setAdminEventAgenda, setAdminEventRsvpOpen } from '../src/lib/memberApi.js';
import { LEGACY_EVENT_COLUMNS } from '../src/lib/eventSchemaCompatibility.js';
import { t } from '../src/lib/i18n.js';
import { rpcErrorText } from '../src/lib/rpcErrorText.js';

const fields = { id: 'meeting', title: 'Meeting', startsAt: '2026-10-13T00:30:00Z', location: 'Hall', summary: 'Agenda' };

function backend(code, repeated = false) {
  const calls = [];
  const client = { from(table) {
    const call = { table, filters: [], orders: [] };
    calls.push(call);
    const query = {
      select(columns) { call.columns = columns; return query; },
      eq(...args) { call.filters.push(['eq', ...args]); return query; },
      neq(...args) { call.filters.push(['neq', ...args]); return query; },
      gte(...args) { call.filters.push(['gte', ...args]); return query; },
      or(...args) { call.filters.push(['or', ...args]); return query; },
      order(column) { call.orders.push(column); return query; },
      range() { return query; }, limit() { return query; }, maybeSingle() { call.single = true; return query; },
      then(resolve) {
        const legacy = call.columns === LEGACY_EVENT_COLUMNS;
        const error = table === 'member_events' && (!legacy || repeated) ? { code, message: 'column member_events.event_kind does not exist' } : null;
        const row = { id: 'meeting', title: 'Meeting', chapter_id: 'chapter', starts_at: fields.startsAt };
        return Promise.resolve({ error, data: error ? null : table !== 'member_events' ? null : call.single ? row : [row] }).then(resolve);
      },
    };
    return query;
  } };
  return { client, calls };
}

describe('event deploy compatibility', () => {
  it('uses legacy writes for a single plain meeting, including a start-only edit', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: 'meeting' }, error: null });
    await createAdminEvent({ rpc }, fields);
    await updateAdminEvent({ rpc }, 'meeting', { schedule: { kind: 'meeting', startsAt: fields.startsAt, endsAt: null, eventDate: null } });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['create_member_event', 'update_member_event']);
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('p_kind');
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_starts_at: fields.startsAt });
    expect(rpc.mock.calls[1][1]).not.toHaveProperty('p_schedule');
  });
  it.each([{ endsAt: '2026-10-13T01:00:00Z' }, { eventKind: 'deadline', eventDate: '2026-10-13' }, { occurrences: 3 }])('uses the model RPC for new fields %j', async (extra) => {
    const rpc = vi.fn().mockResolvedValue({ data: {}, error: null });
    await createAdminEvent({ rpc }, { ...fields, ...extra });
    expect(rpc).toHaveBeenCalledWith('create_member_event_model', expect.objectContaining({ p_kind: extra.eventKind ?? 'meeting' }));
  });
  it.each([{ code: 'PGRST202' }, { code: '42883' }, { status: 404 }])('explains missing model functions without retrying a lossy write: %j', async (failure) => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: failure.code, message: 'missing' }, status: failure.status });
    await expect(createAdminEvent({ rpc }, { ...fields, occurrences: 2 })).rejects.toThrow('This feature needs the database update');
    await expect(updateAdminEvent({ rpc }, 'meeting', { eventModelRequired: true, schedule: { kind: 'meeting', startsAt: fields.startsAt, endsAt: null, eventDate: null } })).rejects.toThrow('This feature needs the database update');
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['create_member_event_model', 'update_member_event_model']);
  });
  // REQ-UG-LEARNING-PERIOD-EVENTS-20261103: an edit carries the
  // version the editor opened, so the database can refuse a stale save.
  it('sends the expected version with an edit, on either update RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { updated: true }, error: null });
    await updateAdminEvent({ rpc }, 'meeting', { title: 'Renamed', expectedVersion: 4 });
    await updateAdminEvent({ rpc }, 'meeting', { eventModelRequired: true, title: 'Renamed', expectedVersion: 5 });
    await updateAdminEvent({ rpc }, 'meeting', { title: 'Renamed' });
    expect(rpc.mock.calls.map(([name, args]) => [name, args.p_expected_version])).toEqual([
      ['update_member_event', 4], ['update_member_event_model', 5], ['update_member_event', undefined],
    ]);
  });
  //: an edit is sent once, with its version; a missing function is a
  // failed edit, never a resend without the version as whoever is signed in.
  it.each([{ code: 'PGRST202' }, { code: '42883' }, { status: 404 }])('never resends an edit without its version: %j', async (failure) => {
    for (const fields of [{ title: 'Renamed', expectedVersion: 2 }, { title: 'Renamed', expectedVersion: 2, eventModelRequired: true }]) {
      const rpc = vi.fn()
        .mockResolvedValueOnce({ data: null, error: { code: failure.code, message: 'missing' }, status: failure.status })
        .mockResolvedValue({ data: { updated: true }, error: null });
      await expect(updateAdminEvent({ rpc }, 'meeting', fields)).rejects.toThrow();
      expect(rpc.mock.calls).toHaveLength(1);
      expect(rpc.mock.calls[0][1]).toMatchObject({ p_title: 'Renamed', p_expected_version: 2 });
    }
  });
  it.each(['en', 'es'])('explains a refused stale edit in %s catalogue copy', (lang) => {
    const text = rpcErrorText((key) => t(lang, key), { code: 'PT409', details: 'event_changed', message: 'this event changed; reload it before saving' });
    expect(text).toBe(t(lang, 'rpcError.event_changed'));
    expect(text).not.toBe('rpcError.event_changed');
    expect(text).not.toContain('reload it before saving');
  });
  it('does not retry a stale edit the database refused', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: 'PT409', details: 'event_changed', message: 'this event changed; reload it before saving' } });
    await expect(updateAdminEvent({ rpc }, 'meeting', { title: 'Renamed', expectedVersion: 2 })).rejects.toThrow();
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it.each(['42703', 'PGRST204'])('retries every scoped read once without new columns, filters or ordering: %s', async (code) => {
    const { client, calls } = backend(code);
    const result = await fetchMemberEventsForChapter(client, 'chapter');
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(1);
    const fallback = calls.filter((call) => call.columns === LEGACY_EVENT_COLUMNS);
    expect(fallback).toHaveLength(3);
    expect(fallback.map((call) => call.orders)).toEqual([['starts_at', 'id'], ['starts_at', 'id'], ['starts_at', 'id']]);
    expect(fallback[0].filters).toContainEqual(['eq', 'chapter_id', 'chapter']);
    expect(fallback[1].filters).toContainEqual(['eq', 'is_public_across_agencies', true]);
    expect(fallback[2].filters).toContainEqual(['eq', 'is_public_across_agencies', false]);
    expect(fallback[2].filters.some(([op]) => op === 'gte')).toBe(true);
    const event = await loadAuthorizedCalendarEvent(client, 'meeting', 'member');
    expect(event).toMatchObject({ eventKind: 'meeting', endsAt: null, eventDate: null, seriesId: null, checkInOffered: false });
  });
  it('does not retry access errors or retry a failed fallback again', async () => {
    const denied = backend('42501');
    await expect(loadAuthorizedCalendarEvent(denied.client, 'meeting', 'member')).rejects.toMatchObject({ code: '42501' });
    expect(denied.calls).toHaveLength(1);
    const missing = backend('42703', true);
    await expect(loadAuthorizedCalendarEvent(missing.client, 'meeting', 'member')).rejects.toMatchObject({ code: '42703' });
    expect(missing.calls).toHaveLength(2);
  });
  it('sorts by the local date, placing untimed entries after meetings on that date', () => {
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { compareEventSchedule } from './src/lib/eventModel.js';
      const events = [
        { id: 'next-day', event_date: '2026-10-13' },
        { id: 'same-day', event_date: '2026-10-12' },
        { id: 'late', starts_at: '2026-10-13T00:30:00Z' },
        { id: 'early', starts_at: '2026-10-12T15:00:00Z' },
      ];
      process.stdout.write(JSON.stringify([
        [...events].sort(compareEventSchedule).map(({ id }) => id),
        [...events].sort((a, b) => compareEventSchedule(a, b, -1)).map(({ id }) => id),
      ]));
    `], { cwd: process.cwd(), env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
    expect(JSON.parse(result)).toEqual([['early', 'late', 'same-day', 'next-day'], ['next-day', 'late', 'early', 'same-day']]);
  });
});

// UX-UG-WORDING-AND-SPANISH-GAPS-FROM-REVIEWS-20261117 (
// 386, from the  review): a bare HTTP 404 with no PostgREST code used to
// skip the service-busy code set, so the event editor, the RSVP switch and the
// agenda showed the driver's text. It now reads as the service-busy sentence in
// both languages, and each write is still sent once.
describe('a bare 404 on an event write', () => {
  it.each([
    ['event editor', (client) => updateAdminEvent(client, 'meeting', { title: 'Kept draft', expectedVersion: 3 })],
    ['event editor on the model RPC', (client) => updateAdminEvent(client, 'meeting', { eventModelRequired: true, title: 'Kept draft', expectedVersion: 3 })],
    ['RSVP switch', (client) => setAdminEventRsvpOpen(client, 'meeting', true, 3)],
    ['agenda', (client) => setAdminEventAgenda(client, 'meeting', 'Kept agenda', 3)],
  ])('reads as the service-busy sentence on the %s', async (_name, write) => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'raw driver missing-function text' }, status: 404 });
    const error = await write({ rpc }).catch((caught) => caught);
    expect(rpc).toHaveBeenCalledTimes(1);
    for (const lang of ['en', 'es']) {
      const text = rpcErrorText((key) => t(lang, key), error, 'toast.saveFailed');
      expect(text).toBe(t(lang, 'error.serviceBusy'));
      expect(text).not.toContain('raw driver');
    }
  });

  it('keeps a coded refusal and a 404 that carries its own code as they were', async () => {
    const stale = vi.fn().mockResolvedValue({ data: null, error: { code: 'PT409', message: 'changed', details: 'event_changed' }, status: 409 });
    const staleError = await updateAdminEvent({ rpc: stale }, 'meeting', { title: 'Kept', expectedVersion: 3 }).catch((caught) => caught);
    expect(staleError.code).toBe('PT409');
    const coded = vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST205', message: 'no table' }, status: 404 });
    const codedError = await setAdminEventAgenda({ rpc: coded }, 'meeting', 'Kept', 3).catch((caught) => caught);
    expect(codedError.code).toBe('PGRST205');
  });
});
