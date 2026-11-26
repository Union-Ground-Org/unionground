import { describe, expect, it } from 'vitest';
import {
  createMeetingArgs,
  defaultMeetingStart,
  emptyMeetingDraft,
  MEETING_MAX_LENGTH,
  MEETING_MIN_LENGTH,
  meetingCheckInCode,
  meetingDraftProblem,
  meetingEventId,
  stepMeetingDay,
  stepMeetingLength,
  stepMeetingTime,
} from './chapterMeeting';

// #9099 part 1: the phone's meeting form sends what create_member_event_model
// accepts (src/lib/memberApi.js createAdminEvent is the website's twin).
const now = new Date(2026, 10, 18, 11, 0, 0);

describe('campaign meeting draft', () => {
  it('starts tomorrow at 6:00 PM on the phone clock, one hour long, with a check-in code', () => {
    const draft = emptyMeetingDraft(now);
    expect(draft.startsAt).toEqual(new Date(2026, 10, 19, 18, 0, 0));
    expect(draft.lengthMinutes).toBe(60);
    expect(draft.checkIn).toBe(true);
    expect(defaultMeetingStart(new Date(2026, 11, 31, 23, 30))).toEqual(new Date(2027, 0, 1, 18, 0, 0));
  });

  it('steps the day, the start in 15 minutes and the length within 15 minutes to 12 hours', () => {
    const start = new Date(2026, 10, 19, 18, 0, 0);
    expect(stepMeetingDay(start, -1)).toEqual(new Date(2026, 10, 18, 18, 0, 0));
    expect(stepMeetingTime(start, 1)).toEqual(new Date(2026, 10, 19, 18, 15, 0));
    expect(stepMeetingTime(start, -2)).toEqual(new Date(2026, 10, 19, 17, 30, 0));
    expect(stepMeetingLength(60, 1)).toBe(75);
    expect(stepMeetingLength(MEETING_MIN_LENGTH, -1)).toBe(MEETING_MIN_LENGTH);
    expect(stepMeetingLength(MEETING_MAX_LENGTH, 1)).toBe(MEETING_MAX_LENGTH);
  });

  it('names the first field the server would refuse', () => {
    const ready = { ...emptyMeetingDraft(now), title: 'Contract campaign kickoff', location: 'Union hall', summary: 'Plan the first steps.' };
    expect(meetingDraftProblem(ready, now)).toBeNull();
    expect(meetingDraftProblem({ ...ready, title: ' ab ' }, now)).toBe('title');
    expect(meetingDraftProblem({ ...ready, title: 'x'.repeat(121) }, now)).toBe('title');
    expect(meetingDraftProblem({ ...ready, title: 'Line\nbreak' }, now)).toBe('title');
    expect(meetingDraftProblem({ ...ready, startsAt: new Date(now.getTime() - 60_000) }, now)).toBe('past');
    expect(meetingDraftProblem({ ...ready, location: '   ' }, now)).toBe('location');
    expect(meetingDraftProblem({ ...ready, summary: '' }, now)).toBe('summary');
    expect(meetingDraftProblem({ ...ready, summary: 'x'.repeat(501) }, now)).toBe('summary');
  });

  it('takes a summary with line breaks or pasted control characters as one paragraph', () => {
    const ready = { ...emptyMeetingDraft(now), title: 'Contract campaign kickoff', location: 'Union hall', summary: 'First topic\nSecond topic\t\u0007 Third\r\n' };
    expect(meetingDraftProblem(ready, now)).toBeNull();
    expect(createMeetingArgs(ready, 'meeting-x1', null, '').p_summary).toBe('First topic Second topic Third');
    expect(meetingDraftProblem({ ...ready, summary: '\n\t ' }, now)).toBe('summary');
  });

  it('makes an id and a check-in code the RPC accepts', () => {
    const bytes = Uint8Array.from([0, 1, 31, 32, 255, 200, 7, 8]);
    expect(meetingCheckInCode(bytes)).toBe('SG-AB9A9J');
    expect(meetingCheckInCode(bytes)).toMatch(/^SG-[0-9A-Z]{3,12}$/);
    const id = meetingEventId(new Date(2026, 10, 19, 18, 0, 0), bytes);
    expect(id).toBe('meeting-20261119-00011f20ffc80708');
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]{2,63}$/);
  });

  it('sends a one-time chapter-only meeting with its end time, trimmed text and the code only when check-in is on', () => {
    const draft = { ...emptyMeetingDraft(now), title: '  Committee training ', location: ' Room 2 ', summary: ' Bring questions. ', lengthMinutes: 90 };
    const args = createMeetingArgs(draft, 'meeting-20261119-aa', 'SG-ABCDEF', 'America/Chicago');
    expect(args).toEqual({
      p_id: 'meeting-20261119-aa',
      p_title: 'Committee training',
      p_starts_at: draft.startsAt.toISOString(),
      p_location: 'Room 2',
      p_summary: 'Bring questions.',
      p_check_in_code: 'SG-ABCDEF',
      p_is_public: false,
      p_is_public_across_agencies: false,
      p_kind: 'meeting',
      p_event_date: null,
      p_ends_at: new Date(draft.startsAt.getTime() + 90 * 60_000).toISOString(),
      p_occurrences: 1,
      p_timezone: 'America/Chicago',
    });
    expect(createMeetingArgs({ ...draft, checkIn: false }, 'meeting-x1', 'SG-ABCDEF', '').p_check_in_code).toBeNull();
    expect(createMeetingArgs(draft, 'meeting-x1', null, '').p_timezone).toBe('America/New_York');
  });
});
