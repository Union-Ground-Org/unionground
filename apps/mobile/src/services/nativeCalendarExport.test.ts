import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../modules/native-calendar-export/src/NativeCalendarExportModule', () => ({ default: null }));

import type { LivedInEvent } from './livedIn';
import type { MobileAppointment } from './supabase';
import {
  APPOINTMENT_CALENDAR_TITLE,
  calendarExportPayloadForAppointment,
  calendarExportPayloadForEvent,
  exportToDeviceCalendar,
  isCalendarExportAvailable,
} from './nativeCalendarExport';

const mobileRoot = join(import.meta.dirname, '../..');
const swiftSource = readFileSync(
  join(mobileRoot, 'modules/native-calendar-export/ios/NativeCalendarExportModule.swift'),
  'utf8',
);
const kotlinSource = readFileSync(
  join(mobileRoot, 'modules/native-calendar-export/android/src/main/java/expo/modules/nativecalendarexport/NativeCalendarExportModule.kt'),
  'utf8',
);
const manifestSource = readFileSync(
  join(mobileRoot, 'modules/native-calendar-export/android/src/main/AndroidManifest.xml'),
  'utf8',
);

const NOW = Date.parse('2026-08-25T12:00:00.000Z');

function event(overrides: Partial<LivedInEvent> = {}): LivedInEvent {
  return {
    id: 'e1111111-1111-4111-8111-111111111111',
    chapterID: 'chapter-1',
    title: 'September campaign meeting',
    summary: 'Contract vote follow-up with the negotiating committee.',
    startsAt: '2026-09-02T22:30:00.000Z',
    location: 'Union hall, Room 2',
    cancelled: false,
    cancellationReason: null,
    rsvp: 'going',
    checkedInAt: null,
    checkInOffered: true,
    ...overrides,
  };
}

function appointment(overrides: Partial<MobileAppointment> = {}): MobileAppointment {
  return {
    id: 'a2222222-2222-4222-8222-222222222222',
    startsAt: '2026-09-01T15:00:00.000Z',
    endsAt: '2026-09-01T15:45:00.000Z',
    status: 'confirmed',
    appointmentType: 'steward_meeting',
    reasonCategory: 'discipline',
    ...overrides,
  };
}

describe('native device calendar export payloads', () => {
  it('exports an upcoming authorized meeting with title, time, bounded duration, and location only', () => {
    const payload = calendarExportPayloadForEvent(event(), NOW);
    expect(payload).toEqual({
      title: 'September campaign meeting',
      startMs: Date.parse('2026-09-02T22:30:00.000Z'),
      endMs: Date.parse('2026-09-02T22:30:00.000Z') + 60 * 60 * 1000,
      location: 'Union hall, Room 2',
    });
    // The record identifier and summary never enter the calendar payload.
    expect(JSON.stringify(payload)).not.toContain('e1111111');
    expect(JSON.stringify(payload)).not.toContain('negotiating');
  });

  it('refuses cancelled, past, malformed, and untitled meetings before the module is invoked', () => {
    expect(calendarExportPayloadForEvent(event({ cancelled: true }), NOW)).toBeNull();
    expect(calendarExportPayloadForEvent(event({ startsAt: '2026-08-25T11:00:00.000Z' }), NOW)).toBeNull();
    expect(calendarExportPayloadForEvent(event({ startsAt: 'not-a-date' }), NOW)).toBeNull();
    expect(calendarExportPayloadForEvent(event({ title: '   \n ' }), NOW)).toBeNull();
  });

  it('collapses control characters and clamps oversized text', () => {
    const payload = calendarExportPayloadForEvent(
      event({ title: `Rally\u0000\u001f\ttime ${'x'.repeat(400)}`, location: `Hall\u2028line ${'y'.repeat(200)}` }),
      NOW,
    );
    expect(payload?.title.startsWith('Rally time x')).toBe(true);
    expect(payload?.title.length).toBeLessThanOrEqual(120);
    expect(payload?.title).not.toMatch(/[\u0000-\u001f\u2028]/);
    expect(payload?.location?.startsWith('Hall line y')).toBe(true);
    expect(payload?.location?.length).toBeLessThanOrEqual(160);
  });

  it('treats a blank location as absent', () => {
    expect(calendarExportPayloadForEvent(event({ location: '  \u0000 ' }), NOW)?.location).toBeNull();
  });

  it('exports a confirmed upcoming one-on-one as a generic title with exact times and nothing else', () => {
    const payload = calendarExportPayloadForAppointment(appointment(), NOW);
    expect(payload).toEqual({
      title: APPOINTMENT_CALENDAR_TITLE,
      startMs: Date.parse('2026-09-01T15:00:00.000Z'),
      endMs: Date.parse('2026-09-01T15:45:00.000Z'),
      location: null,
    });
    // Appointment type, reason category, and identifier stay out of the
    // device calendar: synced calendars leave the app's privacy boundary.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('steward');
    expect(serialized).not.toContain('discipline');
    expect(serialized).not.toContain('a2222222');
  });

  it('refuses one-on-ones that are not confirmed or not upcoming', () => {
    expect(calendarExportPayloadForAppointment(appointment({ status: 'cancelled' }), NOW)).toBeNull();
    expect(calendarExportPayloadForAppointment(appointment({ status: 'completed' }), NOW)).toBeNull();
    expect(calendarExportPayloadForAppointment(appointment({ status: 'no_show' }), NOW)).toBeNull();
    expect(
      calendarExportPayloadForAppointment(
        appointment({ startsAt: '2026-08-25T11:59:00.000Z', endsAt: '2026-08-25T12:30:00.000Z' }),
        NOW,
      ),
    ).toBeNull();
  });

  it('falls back to a bounded duration when the recorded end is missing or absurd', () => {
    const start = Date.parse('2026-09-01T15:00:00.000Z');
    expect(
      calendarExportPayloadForAppointment(appointment({ endsAt: 'not-a-date' }), NOW)?.endMs,
    ).toBe(start + 30 * 60 * 1000);
    expect(
      calendarExportPayloadForAppointment(appointment({ endsAt: '2026-09-01T14:00:00.000Z' }), NOW)?.endMs,
    ).toBe(start + 30 * 60 * 1000);
    expect(
      calendarExportPayloadForAppointment(appointment({ endsAt: '2026-09-04T15:00:00.000Z' }), NOW)?.endMs,
    ).toBe(start + 30 * 60 * 1000);
  });

  it('degrades honestly when the native module is unavailable', async () => {
    expect(isCalendarExportAvailable()).toBe(false);
    await expect(
      exportToDeviceCalendar({ title: 'x', startMs: 1, endMs: 2, location: null }, () => true),
    ).resolves.toBe('unavailable');
  });

  it.each([
    ['stale', () => false],
    ['unreadable', () => { throw new Error('session state unavailable'); }],
  ])('refuses a %s session guard before checking the native handoff', async (_label, isCurrent) => {
    await expect(
      exportToDeviceCalendar({ title: 'x', startMs: 1, endMs: 2, location: null }, isCurrent),
    ).rejects.toThrow('Calendar export authorization changed.');
  });
});

describe('native device calendar export platform boundaries', () => {
  it('iOS presents only the out-of-process composer and never requests calendar access', () => {
    expect(swiftSource).toContain('EKEventEditViewController');
    expect(swiftSource).toContain('#available(iOS 17.0, *)');
    expect(swiftSource).not.toContain('requestAccess');
    expect(swiftSource).not.toContain('requestFullAccessToEvents');
    expect(swiftSource).not.toContain('requestWriteOnlyAccessToEvents');
    expect(swiftSource).not.toContain('save(');
    expect(swiftSource).not.toContain('URLSession');
  });

  it('Android hands the entry to the calendar editor intent and never touches the provider', () => {
    expect(kotlinSource).toContain('Intent.ACTION_INSERT');
    expect(kotlinSource).toContain('CalendarContract.Events.CONTENT_URI');
    expect(kotlinSource).not.toContain('contentResolver');
    expect(kotlinSource).not.toContain('query(');
    expect(kotlinSource).not.toContain('insert(');
  });

  it('adds no permission, no component, and nothing exported', () => {
    expect(manifestSource).toContain('<queries>');
    expect(manifestSource).not.toContain('<uses-permission');
    expect(manifestSource).not.toContain('<activity');
    expect(manifestSource).not.toContain('<receiver');
    expect(manifestSource).not.toContain('<service');
    expect(manifestSource).not.toContain('android:exported');
  });
});

it('exports an explicit meeting end and does not offer a dated item as timed', () => {
  const endsAt = '2026-09-03T02:30:00.000Z';
  expect(calendarExportPayloadForEvent(event({ endsAt }), NOW)?.endMs).toBe(Date.parse(endsAt));
  expect(calendarExportPayloadForEvent(event({ eventKind: 'deadline', eventDate: '2026-09-02', startsAt: '' }), NOW)).toBeNull();
});
