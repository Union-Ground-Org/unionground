import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  calendarExportSessionIsLive,
  offersAppointmentCalendarExport,
  offersEventCalendarExport,
} from './calendarExportOffer';

// REQ-UNION-GROUND-MOBILE-NATIVE-CALENDAR-EXPORT-20260825 item 4 (fixture
// sessions never offer export into a real device calendar) and item 6
// (focused tests cover gating). Device windows 7c/7d and 9 (2026-09-27) saw
// "Add to calendar" on the SAMPLE Member's confirmed upcoming appointments.

const NOW = Date.parse('2026-09-27T06:00:00.000Z');
const later = '2026-10-01T13:00:00.000Z';
const earlier = '2026-09-20T13:00:00.000Z';
const live = { mode: 'authenticated', sampleHat: null, liveSampleBackend: false, calendarReady: true };

describe('calendarExportSessionIsLive', () => {
  it('accepts only an authenticated session outside SAMPLE and PREVIEW', () => {
    expect(calendarExportSessionIsLive(live)).toBe(true);
    expect(calendarExportSessionIsLive({ ...live, sampleHat: 'member' })).toBe(false);
    expect(calendarExportSessionIsLive({ ...live, liveSampleBackend: true })).toBe(false);
    expect(calendarExportSessionIsLive({ ...live, mode: 'preview' })).toBe(false);
    expect(calendarExportSessionIsLive({ ...live, mode: 'booting' })).toBe(false);
    expect(calendarExportSessionIsLive({ ...live, mode: 'signedOut' })).toBe(false);
  });
});

describe('offersAppointmentCalendarExport', () => {
  it('offers a confirmed upcoming one-on-one to a live session with a calendar handler', () => {
    expect(offersAppointmentCalendarExport(live, { status: 'confirmed', startsAt: later }, NOW)).toBe(true);
  });

  it('never offers the SAMPLE fixture session or PREVIEW', () => {
    const appointment = { status: 'confirmed', startsAt: later };
    expect(offersAppointmentCalendarExport({ ...live, sampleHat: 'member' }, appointment, NOW)).toBe(false);
    expect(offersAppointmentCalendarExport({ ...live, liveSampleBackend: true }, appointment, NOW)).toBe(false);
    expect(offersAppointmentCalendarExport({ ...live, mode: 'preview' }, appointment, NOW)).toBe(false);
  });

  it('keeps the record gates: cancelled, past, malformed, or no calendar handler', () => {
    expect(offersAppointmentCalendarExport(live, { status: 'cancelled', startsAt: later }, NOW)).toBe(false);
    expect(offersAppointmentCalendarExport(live, { status: 'confirmed', startsAt: earlier }, NOW)).toBe(false);
    expect(offersAppointmentCalendarExport(live, { status: 'confirmed', startsAt: 'not a date' }, NOW)).toBe(false);
    expect(offersAppointmentCalendarExport({ ...live, calendarReady: false }, { status: 'confirmed', startsAt: later }, NOW)).toBe(false);
  });
});

describe('offersEventCalendarExport', () => {
  it('offers an upcoming non-cancelled meeting to a live session only', () => {
    const event = { cancelled: false, startsAt: later };
    expect(offersEventCalendarExport(live, event, NOW)).toBe(true);
    expect(offersEventCalendarExport({ ...live, sampleHat: 'steward' }, event, NOW)).toBe(false);
    expect(offersEventCalendarExport({ ...live, liveSampleBackend: true }, event, NOW)).toBe(false);
    expect(offersEventCalendarExport({ ...live, mode: 'preview' }, event, NOW)).toBe(false);
    expect(offersEventCalendarExport(live, { cancelled: true, startsAt: later }, NOW)).toBe(false);
    expect(offersEventCalendarExport(live, { cancelled: false, startsAt: earlier }, NOW)).toBe(false);
    expect(offersEventCalendarExport({ ...live, calendarReady: false }, event, NOW)).toBe(false);
  });
});

describe('the screens and the session assertion use the gate', () => {
  const appointments = readFileSync(new URL('../features/LiveAppointmentsFeature.tsx', import.meta.url), 'utf8');
  const events = readFileSync(new URL('../features/LiveLivedInScreens.tsx', import.meta.url), 'utf8');
  const supabase = readFileSync(new URL('../services/supabase.ts', import.meta.url), 'utf8');
  const provider = readFileSync(new URL('../state/AppProvider.tsx', import.meta.url), 'utf8');

  it('renders "Add to calendar" only through the offer helper, fed by the live session facts from the provider', () => {
    expect(provider).toContain('  const liveSampleBackend = isLiveSampleBackend(mobileConfig);');
    for (const source of [appointments, events]) {
      expect(source).toContain('mode, sampleHat, liveSampleBackend, calendarReady,');
      expect(source).toContain(', mode, sampleHat, liveSampleBackend } = useApp();');
      expect(source.match(/label="Add to calendar"/g)).toHaveLength(1);
    }
    expect(appointments).toContain('{offersAppointmentCalendarExport(calendarOffer, item, Date.now()) ? <View style={styles.workChipRow}><Button label="Add to calendar"');
    expect(events).toContain('{offersEventCalendarExport(calendarOffer, event, Date.now()) ? <View style={styles.actions}><Button label="Add to calendar"');
  });

  it('refuses the press-time preparation on a SAMPLE build before any auth or data read', () => {
    const assertion = supabase.indexOf('export async function assertFreshMobileCalendarSession(): Promise<string> {');
    const refusal = supabase.indexOf("if (isLiveSampleBackend(mobileConfig)) throw new Error('Calendar export is not offered on SAMPLE.');");
    const firstRead = supabase.indexOf('const supabase = getSupabaseClient();', assertion);
    expect(assertion).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(assertion);
    expect(refusal).toBeLessThan(firstRead);
  });
});
