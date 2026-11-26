import { describe, expect, it, vi } from 'vitest';
import {
  APPOINTMENT_DURATIONS,
  APPOINTMENT_TYPE_LABELS,
  APPOINTMENT_TYPES,
  appointmentRangeLabel,
  appointmentWindowsProblem,
  bookingPlaceProblem,
  bookingRefusal,
  easternDayKey,
  easternTimeLabel,
  minuteLabel,
  nextNewWindow,
  scheduleZoneName,
  slotSearchSpan,
  slotsByEasternDay,
  sortWindows,
  stepWeekday,
  stepWindow,
} from './appointmentBooking';
import { deviceDateTime } from './evidenceTimestamp';
import { nativeUiSpanish } from './nativeUiCopy';

// #9082: the phone's hours editor and booking flow keep the website's choices
// and the server's window rules.
describe('booking choices match the website', () => {
  it('offers the website booking wizard types and lengths', () => {
    expect(APPOINTMENT_TYPES).toEqual(['office_hours', 'grievance_followup', 'onboarding', 'contract_questions']);
    expect(APPOINTMENT_DURATIONS).toEqual([20, 30, 45]);
  });

  it('has Spanish for every type label', () => {
    for (const label of Object.values(APPOINTMENT_TYPE_LABELS)) expect(nativeUiSpanish[label]).toBeTruthy();
  });
});

describe('weekly window rules', () => {
  it('accepts a normal window and refuses what set_appointment_windows refuses', () => {
    expect(appointmentWindowsProblem([{ weekday: 1, startMinute: 540, endMinute: 720 }])).toBeNull();
    expect(appointmentWindowsProblem([])).toBeNull();
    expect(appointmentWindowsProblem([{ weekday: 1, startMinute: 540, endMinute: 555 }])).toBe('invalid');
    expect(appointmentWindowsProblem([{ weekday: 7, startMinute: 540, endMinute: 720 }])).toBe('invalid');
    expect(appointmentWindowsProblem([{ weekday: 1, startMinute: 720, endMinute: 540 }])).toBe('invalid');
    expect(appointmentWindowsProblem(Array.from({ length: 29 }, (_, index) => ({ weekday: index % 7, startMinute: index * 30, endMinute: index * 30 + 25 })))).toBe('invalid');
    expect(appointmentWindowsProblem([
      { weekday: 2, startMinute: 540, endMinute: 720 },
      { weekday: 2, startMinute: 660, endMinute: 780 },
    ])).toBe('overlap');
    expect(appointmentWindowsProblem([
      { weekday: 2, startMinute: 540, endMinute: 720 },
      { weekday: 3, startMinute: 540, endMinute: 720 },
    ])).toBeNull();
  });

  it('steps start and end by 15 minutes inside the server bounds', () => {
    const window = { weekday: 1, startMinute: 540, endMinute: 720 };
    expect(stepWindow(window, 'start', 1)).toEqual({ weekday: 1, startMinute: 555, endMinute: 720 });
    expect(stepWindow(window, 'end', -1)).toEqual({ weekday: 1, startMinute: 540, endMinute: 705 });
    expect(stepWindow({ weekday: 1, startMinute: 0, endMinute: 60 }, 'start', -1).startMinute).toBe(0);
    expect(stepWindow({ weekday: 1, startMinute: 1425, endMinute: 1440 }, 'start', 1).startMinute).toBe(1425);
    expect(stepWindow({ weekday: 1, startMinute: 0, endMinute: 1440 }, 'end', 1).endMinute).toBe(1440);
    expect(stepWindow({ weekday: 1, startMinute: 0, endMinute: 15 }, 'end', -1).endMinute).toBe(15);
  });

  it('wraps the weekday both ways', () => {
    expect(stepWeekday({ weekday: 6, startMinute: 0, endMinute: 60 }, 1).weekday).toBe(0);
    expect(stepWeekday({ weekday: 0, startMinute: 0, endMinute: 60 }, -1).weekday).toBe(6);
  });

  it('adds a new window on the first free weekday, Monday first', () => {
    expect(nextNewWindow([])).toEqual({ weekday: 1, startMinute: 540, endMinute: 720 });
    expect(nextNewWindow([{ weekday: 1, startMinute: 540, endMinute: 720 }]).weekday).toBe(2);
    expect(appointmentWindowsProblem([{ weekday: 1, startMinute: 540, endMinute: 720 }, nextNewWindow([{ weekday: 1, startMinute: 540, endMinute: 720 }])])).toBeNull();
  });

  it('sorts by weekday and start', () => {
    expect(sortWindows([
      { weekday: 3, startMinute: 600, endMinute: 660 },
      { weekday: 1, startMinute: 780, endMinute: 840 },
      { weekday: 1, startMinute: 540, endMinute: 600 },
    ]).map((window) => `${window.weekday}:${window.startMinute}`)).toEqual(['1:540', '1:780', '3:600']);
  });

  it('labels minutes on a 12-hour clock', () => {
    expect(minuteLabel(0)).toBe('12:00 AM');
    expect(minuteLabel(540)).toBe('9:00 AM');
    expect(minuteLabel(765)).toBe('12:45 PM');
    expect(minuteLabel(1440)).toBe('12:00 AM');
  });
});

describe('open times', () => {
  it('asks the server for the website two-week span from the device date', () => {
    expect(slotSearchSpan(new Date(2026, 10, 17, 21, 30))).toEqual({ from: '2026-11-17', to: '2026-11-30' });
    expect(slotSearchSpan(new Date(2026, 11, 25, 9))).toEqual({ from: '2026-12-25', to: '2027-01-07' });
  });

  it('groups open times by Eastern day and labels them in Eastern time', () => {
    const slots = [
      { startsAt: '2026-11-24T14:00:00Z', stewardCount: 1 },
      { startsAt: '2026-11-24T15:00:00Z', stewardCount: 2 },
      // 11:30 PM Eastern on the 24th, though the UTC date is the 25th.
      { startsAt: '2026-11-25T04:30:00Z', stewardCount: 1 },
      { startsAt: '2026-11-25T14:00:00Z', stewardCount: 1 },
    ];
    expect(easternDayKey('2026-11-25T04:30:00Z')).toBe('2026-11-24');
    expect(slotsByEasternDay(slots).map((day) => [day.key, day.slots.length])).toEqual([['2026-11-24', 3], ['2026-11-25', 1]]);
    expect(easternTimeLabel('2026-11-24T14:00:00Z', 'en-US')).toBe('9:00 AM ET');
  });
});

describe('booked one-on-one range fallbacks', () => {
  const start = '2026-11-24T15:00:00Z';
  const end = '2026-11-24T15:30:00Z';
  const locale = 'en-US';

  it('shows labelled device times when the group zone formatter throws', () => {
    const DateTimeFormat = Intl.DateTimeFormat;
    const formatter = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locales, options) {
      if (options?.timeZone) throw new RangeError('No group-zone data');
      return new DateTimeFormat(locales, options);
    });
    try {
      const startLabel = deviceDateTime(start, locale);
      const endLabel = deviceDateTime(end, locale);
      expect(appointmentRangeLabel(start, end, locale)).toBe(`${startLabel} – ${endLabel}`);
      expect(appointmentRangeLabel(start, null, locale)).toBe(startLabel);
    } finally {
      formatter.mockRestore();
    }
  });

  it('shows the date once when Intl has no formatRange method', () => {
    const prototype = Intl.DateTimeFormat.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'formatRange');
    Reflect.deleteProperty(prototype, 'formatRange');
    try {
      expect(appointmentRangeLabel(start, end, locale)).toBe('Tue, Nov 24, 2026, 10:00 AM – 10:30 AM ET');
    } finally {
      if (descriptor) Object.defineProperty(prototype, 'formatRange', descriptor);
    }
  });
});

describe('booking place', () => {
  it('needs a place of at most 300 characters, as book_appointment does', () => {
    expect(bookingPlaceProblem('  ')).toBe('missing');
    expect(bookingPlaceProblem('Union hall')).toBeNull();
    expect(bookingPlaceProblem('x'.repeat(301))).toBe('long');
  });
});

describe('booking refusals', () => {
  it("sorts book_appointment's refusals so only a vanished time asks for another time", () => {
    expect(bookingRefusal({ code: '22023', message: 'you already have 3 upcoming one-on-ones' })).toBe('cap');
    expect(bookingRefusal({ code: '22023', message: 'that time is no longer available' })).toBe('taken');
    expect(bookingRefusal({ code: '22023', message: 'one-on-one start is out of range' })).toBe('taken');
    expect(bookingRefusal({ code: '22023', message: 'one-on-one place must be 1 to 300 characters' })).toBe('place');
    expect(bookingRefusal({ code: '22023', message: 'worker campaign required' })).toBe('chapter');
    expect(bookingRefusal({ code: '42501', message: 'authentication required' })).toBe('signin');
    expect(bookingRefusal(new Error('network down'))).toBe('other');
    expect(bookingRefusal(null)).toBe('other');
  });
});

describe('schedule zone names', () => {
  it('names the US zones and has Spanish for each name', () => {
    expect(scheduleZoneName('America/Los_Angeles')).toBe('Pacific time');
    expect(scheduleZoneName('America/New_York')).toBe('Eastern time');
    expect(scheduleZoneName('Europe/Madrid')).toBeNull();
    for (const zone of ['America/New_York', 'America/Detroit', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu']) {
      const name = scheduleZoneName(zone);
      expect(name && nativeUiSpanish[name]).toBeTruthy();
    }
  });
});
