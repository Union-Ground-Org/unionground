import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deviceCalendarDay, deviceDateTime, deviceDayRange, deviceTimeZoneLabel, easternDateTime, easternShortDay, evidenceUpdatedMeta, parseDatabaseTimestamp } from './evidenceTimestamp';
import { nativeUiText } from './nativeUiCopy';

// BUG-UG-NATIVE-EVIDENCE-ROWS-RAW-UPDATED-TIMESTAMP-20261103.
describe('evidenceUpdatedMeta', () => {
  it('reads the reported Issue work value as an Eastern date and time', () => {
    expect(evidenceUpdatedMeta('2026-11-03T07:57:41.22431+00:00')).toBe('Updated Nov 3, 2026 · 2:57 AM ET');
  });

  it('follows daylight saving time', () => {
    expect(evidenceUpdatedMeta('2026-07-04T16:05:00Z')).toBe('Updated Jul 4, 2026 · 12:05 PM ET');
    expect(evidenceUpdatedMeta('2026-01-15T16:05:00Z')).toBe('Updated Jan 15, 2026 · 11:05 AM ET');
  });

  it('accepts the other shapes Postgres timestamps arrive in', () => {
    const expected = 'Updated Nov 3, 2026 · 2:57 AM ET';
    expect(evidenceUpdatedMeta('2026-11-03 07:57:41.22431+00')).toBe(expected);
    expect(evidenceUpdatedMeta('2026-11-03T07:57:41+00:00')).toBe(expected);
    expect(evidenceUpdatedMeta('2026-11-03T02:57:41.5-05:00')).toBe(expected);
    expect(evidenceUpdatedMeta(' 2026-11-03T07:57:41.224319Z ')).toBe(expected);
  });

  it('never prints a missing or unreadable value', () => {
    for (const value of [null, undefined, '', 'yesterday', '2026-11-03', '2026-13-40T99:99:00Z', 42, {}]) {
      expect(evidenceUpdatedMeta(value)).toBe('Update time unavailable');
    }
  });
});

describe('evidenceUpdatedMeta on engines with other Intl data', () => {
  const RealDateTimeFormat = Intl.DateTimeFormat;
  // A real formatter whose format() answers from the given function.
  function formatterReturning(format: () => string): Intl.DateTimeFormat {
    const formatter = new RealDateTimeFormat('en-US');
    Object.defineProperty(formatter, 'format', { value: format });
    return formatter;
  }
  afterEach(() => { vi.restoreAllMocks(); });

  it('falls back to the unavailable line when the Eastern formatter throws', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () { throw new RangeError('Invalid time zone specified: America/New_York'); });
    expect(evidenceUpdatedMeta('2026-11-03T07:57:41.22431+00:00')).toBe('Update time unavailable');
  });

  it('falls back when formatting itself throws', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () { return formatterReturning(() => { throw new RangeError('format'); }); });
    expect(evidenceUpdatedMeta('2026-11-03T07:57:41.22431+00:00')).toBe('Update time unavailable');
  });

  it('prints plain spaces where ICU emits a narrow or regular no-break space', () => {
    const outputs = ['Nov\u00A03, 2026', '2:57\u202FAM'];
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () { return formatterReturning(() => outputs.shift() ?? ''); });
    const meta = evidenceUpdatedMeta('2026-11-03T07:57:41.22431+00:00');
    expect(meta).toBe('Updated Nov 3, 2026 · 2:57 AM ET');
    expect(meta).not.toMatch(/[\u202F\u00A0]/);
  });
});

describe('parseDatabaseTimestamp', () => {
  it('keeps milliseconds and drops only the digits past them', () => {
    expect(parseDatabaseTimestamp('2026-11-03T07:57:41.22431+00:00')?.toISOString()).toBe('2026-11-03T07:57:41.224Z');
  });

  it('refuses values that are not timestamps', () => {
    expect(parseDatabaseTimestamp('not a date')).toBeNull();
    expect(parseDatabaseTimestamp(1730620661000)).toBeNull();
  });
});

// BUG-UG-NATIVE-CHAPTER-RECORD-DATE-WITHOUT-TIME-ZONE-20261103.
describe('easternDateTime', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('reads the reported campaign record as an Eastern date and time without seconds', () => {
    expect(easternDateTime('2026-11-02 22:00:00+00')).toBe('Nov 2, 2026 · 5:00 PM ET');
    expect(easternDateTime('2026-11-02T22:00:00.123456+00:00')).toBe('Nov 2, 2026 · 5:00 PM ET');
  });

  it('prints the same words whatever zone the phone is set to', () => {
    for (const zone of ['America/Los_Angeles', 'Asia/Tokyo', 'UTC']) {
      vi.stubEnv('TZ', zone);
      expect(new Date('2026-11-02T22:00:00Z').getTimezoneOffset()).not.toBe(300);
      expect(easternDateTime('2026-11-02T22:00:00Z')).toBe('Nov 2, 2026 · 5:00 PM ET');
    }
  });

  it('names the Spanish month and day period for Spanish readers', () => {
    expect(easternDateTime('2026-11-02T22:00:00Z', 'es-US')).toBe('2 nov 2026 · 5:00 p.m. ET');
  });

  it('returns null for a missing or unreadable value so callers show their fallback', () => {
    for (const value of [null, undefined, '', 'Invalid Date', 'yesterday', '2026-11-02', 42]) {
      expect(easternDateTime(value)).toBeNull();
    }
  });

  it('returns null when the Eastern formatter is unavailable', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () { throw new RangeError('Invalid time zone specified: America/New_York'); });
    expect(easternDateTime('2026-11-02T22:00:00Z')).toBeNull();
  });
});

// Gate round 2 on #6934 (r2g1): My chapter's briefing archive and the Home
// unread-broadcast card date the same published_at, so both take the Eastern day.
describe('easternShortDay', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  // 11:30 PM ET Nov 2 (8:30 PM on a Pacific phone, Nov 3 in UTC and Tokyo) and
  // 12:30 AM ET Nov 3 (still Nov 2, 9:30 PM, on a Pacific phone).
  const lateEvening = '2026-11-03 04:30:00.123456+00';
  const afterMidnight = '2026-11-03T05:30:00Z';
  const phoneDay = (value: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value));

  it('shows a briefing published at 11:30 PM ET on the same day on both screens on a Pacific phone', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(new Date('2026-11-03T04:30:00Z').getTimezoneOffset()).toBe(480);
    expect(easternShortDay(lateEvening)).toBe('Nov 2');
    expect(easternDateTime(lateEvening)).toBe('Nov 2, 2026 · 11:30 PM ET');
  });

  it('keeps the Eastern day where the phone calendar day used to differ', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(phoneDay(afterMidnight)).toBe('Nov 2');
    expect(easternShortDay(afterMidnight)).toBe('Nov 3');
    expect(easternDateTime(afterMidnight)).toBe('Nov 3, 2026 · 12:30 AM ET');
    vi.stubEnv('TZ', 'Asia/Tokyo');
    expect(phoneDay('2026-11-03T04:30:00Z')).toBe('Nov 3');
    expect(easternShortDay(lateEvening)).toBe('Nov 2');
  });

  it('agrees with the My campaign day for every phone zone', () => {
    for (const zone of ['America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu', 'UTC', 'Asia/Tokyo']) {
      vi.stubEnv('TZ', zone);
      for (const value of [lateEvening, afterMidnight, '2026-07-04T03:59:00Z', '2026-07-04T04:00:00Z']) {
        expect(easternDateTime(value)?.startsWith(`${easternShortDay(value)}, 2026 · `)).toBe(true);
      }
    }
  });

  it('names the Spanish month for Spanish readers', () => {
    expect(easternShortDay(lateEvening, 'es-US')).toBe('2 nov');
  });

  it('returns null for a missing or unreadable value or missing Eastern zone data', () => {
    for (const value of [null, undefined, '', 'Invalid Date', 'yesterday', '2026-11-02', 42]) {
      expect(easternShortDay(value)).toBeNull();
    }
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () { throw new RangeError('Invalid time zone specified: America/New_York'); });
    expect(easternShortDay(lateEvening)).toBeNull();
  });
});

describe('deviceDateTime', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('shows the local instant at minute precision with the reader’s language and zone', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const value = '2026-11-02 22:00:00.123456+00';
    expect(deviceDateTime(value, 'en-US')).toBe('Nov 2, 2026, 2:00 PM PST');
    expect(deviceDateTime(value, 'es-US')).toMatch(/^2 nov 2026, 2:00 (?:p\.?\s?m\.?) (?:PST|GMT-8)$/i);
  });

  it('returns null instead of the raw value or Invalid Date', () => {
    for (const value of [null, undefined, '', 'Invalid Date', 'yesterday', 42]) {
      expect(deviceDateTime(value)).toBeNull();
    }
  });

  it('shows a readable zone on reminders, including dates on either side of a clock change', () => {
    vi.stubEnv('TZ', 'America/New_York');
    expect(deviceTimeZoneLabel(new Date('2026-07-01T14:00:00Z'))).toBe('ET');
    expect(deviceTimeZoneLabel(new Date('2026-11-18T14:00:00Z'))).toBe('ET');
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(deviceTimeZoneLabel(new Date('2026-11-18T14:00:00Z'))).toBe('PT');
    expect(deviceTimeZoneLabel(new Date('bad'))).toBeNull();
  });

  it('can still label a reminder when native Intl only supplies short zone names', () => {
    const original = Intl.DateTimeFormat;
    const formatter = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locale, options) {
      if (options?.timeZoneName === 'shortGeneric') throw new RangeError('Generic time-zone name unsupported');
      return new original(locale, options);
    });
    try {
      expect(deviceTimeZoneLabel(new Date('2026-11-18T14:00:00Z'), 'America/New_York')).toBe('ET');
      expect(formatter).toHaveBeenCalledTimes(2);
    } finally {
      formatter.mockRestore();
    }
  });
});

describe('Worker record copy', () => {
  it('preserves the issue of time labels and meeting response acronyms', () => {
    const source = readFileSync(new URL('../features/LiveLivedInScreens.tsx', import.meta.url), 'utf8');
    expect(source).toContain('status={chapterDate(item.occurredAt, locale, t)} preserveStatusCase');
    expect(source).toContain("preserveStatusCase || status === 'No RSVP'");
    expect(source).toContain("pillSuppliedCase: { textTransform: 'none' }");
  });

  it('uses localized singular and plural wording for survey and reward counts', () => {
    const text = nativeUiText('es');
    expect(text('1 required question still needs an answer.')).toBe('Aún falta responder 1 pregunta obligatoria.');
    expect(text('{count} required questions still need an answer.', { count: 2 })).toBe('Aún faltan 2 preguntas obligatorias por responder.');
    expect(text('{count} action', { count: 1 })).toBe('1 acción');
    expect(text('{count} actions', { count: 2 })).toBe('2 acciones');
    expect(text('No RSVP')).toBe('Sin confirmación de asistencia');
  });
});

// BUG-UG-NATIVE-WORKLOAD-HISTORY-SHOWS-EACH-LOG-ONE-DAY-EARLY-20261118 (#9163).
describe('deviceDayRange', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  // The phone's own words for a calendar day, built from local fields so the
  // expectation never passes through UTC.
  const localDay = (year: number, month: number, date: number) => new Date(year, month - 1, date, 12)
    .toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  it('formats a day and range in the selected language without moving either endpoint', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(deviceCalendarDay('2026-11-02', 'en-US')).toBe('Nov 2, 2026');
    expect(deviceCalendarDay('2026-11-02', 'es-US')).toBe('2 nov 2026');
    expect(deviceCalendarDay('2026-02-30', 'es-US')).toBeNull();
    expect(deviceDayRange(['2026-11-02', '2026-11-10'], 'es-US')).toBe('2 nov 2026 – 10 nov 2026');
  });

  it('shows a workload log saved for Nov 18 as Nov 18 on a phone in Eastern time', () => {
    vi.stubEnv('TZ', 'America/New_York');
    const range = deviceDayRange(['2026-11-18', '2026-11-18']);
    expect(range).toBe(`${localDay(2026, 11, 18)} – ${localDay(2026, 11, 18)}`);
    expect(range).not.toContain('17');
  });

  it('keeps the logged day in every zone, behind or ahead of UTC', () => {
    for (const zone of ['America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu', 'UTC', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
      vi.stubEnv('TZ', zone);
      expect(deviceDayRange(['2026-11-18', '2026-03-08', '2026-11-01'])).toBe(`${localDay(2026, 3, 8)} – ${localDay(2026, 11, 18)}`);
    }
  });

  it('keeps a timestamp at its own instant and skips a day that does not exist', () => {
    vi.stubEnv('TZ', 'America/New_York');
    expect(deviceDayRange(['2026-11-18T03:30:00Z', '2026-11-18 15:00:00.123456+00'])).toBe(`${localDay(2026, 11, 17)} – ${localDay(2026, 11, 18)}`);
    expect(deviceDayRange(['2026-02-30', 'yesterday', ''])).toBe('');
    expect(deviceDayRange([])).toBe('');
  });

  it('skips a missing (null or undefined) endpoint instead of throwing', () => {
    vi.stubEnv('TZ', 'America/New_York');
    const start = `${localDay(2026, 11, 18)} – ${localDay(2026, 11, 18)}`;
    expect(deviceDayRange([null])).toBe('');
    expect(deviceDayRange([undefined])).toBe('');
    expect(deviceDayRange(['2026-11-18', null])).toBe(start);
    expect(deviceDayRange(['2026-11-18', undefined])).toBe(start);
  });

  it('heads the Workplace log history, the Reports cards and the Meetings summary', () => {
    const source = readFileSync(new URL('../features/LiveLivedInScreens.tsx', import.meta.url), 'utf8');
    expect(source).toContain('<Heading level={3}>{deviceDayRange(data.logs.map((item) => item.loggedOn), locale)}</Heading>');
    expect(source).toContain('<Body muted>{deviceDayRange(workload.logs.map((item) => item.loggedOn), locale)}</Body>');
    expect(source).toContain('deviceDayRange(events?.map((item) => item.eventDate ? `${item.eventDate}T12:00:00` : item.startsAt) ?? [], locale)');
    expect(source).not.toMatch(/function dateRange\(/);
  });
});

// Gate round 1 on #6934: Eastern only where the record put it, so no screen
// mixes zones; every other listed surface keeps the phone clock, null-safe.
describe('native date displays', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const deviceClockSurfaces = [
    '../features/FeatureScreen.tsx',
    '../components/MessageReplies.tsx',
    '../components/EventDiscussionReader.tsx',
    '../components/ChapterLeadershipCard.tsx',
    '../../app/task-conversation/[id].tsx',
    '../../app/peer-conversation/[id].tsx',
  ];

  it.each(deviceClockSurfaces)('%s keeps the phone clock and never prints an unreadable value', (path) => {
    const source = read(path);
    expect(source).toMatch(/deviceDateTime\(/);
    expect(source).not.toMatch(/easternDateTime/);
    expect(source).not.toMatch(/new Date\([^)]*\)\.toLocaleString\(/);
  });

  it('My campaign and the Updated lines read Eastern, rewards use the phone clock, and booked ranges use their own formatter', () => {
    const source = read('../features/LiveLivedInScreens.tsx');
    expect(source).toContain("const scheduleLabel = appointmentRangeLabel(appointment.startsAt, appointment.endsAt, locale) ?? t('Time unavailable');");
    expect(source).toContain("return easternDateTime(value, locale) ?? t('Time unavailable');");
    expect(source).toContain('status={chapterDate(item.occurredAt, locale, t)} preserveStatusCase />');
    expect(source).toContain('{chapterDate(broadcast.publishedAt, locale, t)}');
    expect(source).toContain('{evidenceUpdatedMeta(document.updatedAt)}');
    // Contributions has no points ledger here; its acknowledgements carry a phone-clock day.
    expect(source).toContain('dateLabel: formatDay(event.occurredAt)');
    expect(source).toContain('{scheduleLabel}{appointment.place ?');
    expect(source).not.toContain('Updated {formatDate(');
  });

  it('the Home unread-broadcast card dates a broadcast by the same Eastern day as My campaign', () => {
    const source = read('../features/home/HomeTakeoverCards.tsx');
    expect(source).toContain('easternShortDay(broadcast.publishedAt)');
    expect(source).not.toMatch(/shortDate\(broadcast\./);
    expect(read('../features/LiveLivedInScreens.tsx')).toContain('{chapterDate(broadcast.publishedAt, locale, t)}');
  });
});
