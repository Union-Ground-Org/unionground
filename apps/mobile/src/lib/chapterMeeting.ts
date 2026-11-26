// BUG-UG-NATIVE-OFFICERS-CANNOT-INVITE-SCHEDULE-OR-DRAFT-ON-THE-PHONE-20261118
// (#9099, part 1 of 4): a chapter officer schedules a chapter meeting from the
// phone's Events desk through the RPC the website's event form calls
// (src/lib/memberApi.js createAdminEvent -> create_member_event_model). The
// limits below are that RPC's own; the server checks them again with the role.
import { oneParagraph } from '../../../../src/lib/eventSummary.js';

export type MeetingDraft = {
  title: string;
  startsAt: Date;
  lengthMinutes: number;
  location: string;
  summary: string;
  checkIn: boolean;
};

export type MeetingProblem = 'title' | 'location' | 'summary' | 'past' | null;

export const MEETING_STEP_MINUTES = 15;
export const MEETING_MIN_LENGTH = 15;
export const MEETING_MAX_LENGTH = 12 * 60;
const CONTROL = /[\u0000-\u001f\u007f]/;
// The website's check-in code alphabet (src/components/EventAuthoringCard.jsx).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Tomorrow at 6:00 PM on the phone's clock, the usual time for a chapter meeting. */
export function defaultMeetingStart(now: Date): Date {
  const start = new Date(now.getTime());
  start.setDate(start.getDate() + 1);
  start.setHours(18, 0, 0, 0);
  return start;
}

export function emptyMeetingDraft(now: Date): MeetingDraft {
  return { title: '', startsAt: defaultMeetingStart(now), lengthMinutes: 60, location: '', summary: '', checkIn: true };
}

/** Moves the day and keeps the wall-clock time, across a daylight-saving change too. */
export function stepMeetingDay(start: Date, days: number): Date {
  const next = new Date(start.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

export function stepMeetingTime(start: Date, steps: number): Date {
  const next = new Date(start.getTime());
  next.setMinutes(next.getMinutes() + steps * MEETING_STEP_MINUTES);
  return next;
}

export function stepMeetingLength(minutes: number, steps: number): number {
  return Math.min(MEETING_MAX_LENGTH, Math.max(MEETING_MIN_LENGTH, minutes + steps * MEETING_STEP_MINUTES));
}

function textFits(value: string, min: number, max: number): boolean {
  const text = value.trim();
  return text.length >= min && text.length <= max && !CONTROL.test(text);
}

/** The first field the server would refuse, so the phone names it before sending. */
export function meetingDraftProblem(draft: MeetingDraft, now: Date): MeetingProblem {
  if (!textFits(draft.title, 3, 120)) return 'title';
  if (draft.startsAt.getTime() <= now.getTime()) return 'past';
  if (!textFits(draft.location, 1, 120)) return 'location';
  // A summary is one paragraph, as on the website (src/lib/eventSummary.js):
  // line breaks and pasted control characters become one space.
  if (!textFits(oneParagraph(draft.summary), 1, 500)) return 'summary';
  return null;
}

/** `SG-` and six characters, as the website generates (the RPC takes SG-[0-9A-Z]{3,12}). */
export function meetingCheckInCode(bytes: Uint8Array): string {
  return `SG-${Array.from(bytes.slice(0, 6), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('')}`;
}

/** An event id the RPC accepts (^[a-z0-9][a-z0-9-]{2,63}$): the meeting's day plus random letters. */
export function meetingEventId(start: Date, bytes: Uint8Array): string {
  const day = `${start.getFullYear()}${String(start.getMonth() + 1).padStart(2, '0')}${String(start.getDate()).padStart(2, '0')}`;
  const suffix = Array.from(bytes.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `meeting-${day}-${suffix}`;
}

export type CreateMeetingArgs = {
  p_id: string;
  p_title: string;
  p_starts_at: string;
  p_location: string;
  p_summary: string;
  p_check_in_code: string | null;
  p_is_public: false;
  p_is_public_across_agencies: false;
  p_kind: 'meeting';
  p_event_date: null;
  p_ends_at: string;
  p_occurrences: 1;
  p_timezone: string;
};

/** A one-time chapter meeting, visible to the chapter only, as the website's form defaults. */
export function createMeetingArgs(draft: MeetingDraft, id: string, checkInCode: string | null, timezone: string): CreateMeetingArgs {
  return {
    p_id: id,
    p_title: draft.title.trim(),
    p_starts_at: draft.startsAt.toISOString(),
    p_location: draft.location.trim(),
    p_summary: oneParagraph(draft.summary).trim(),
    p_check_in_code: draft.checkIn ? checkInCode : null,
    p_is_public: false,
    p_is_public_across_agencies: false,
    p_kind: 'meeting',
    p_event_date: null,
    p_ends_at: new Date(draft.startsAt.getTime() + draft.lengthMinutes * 60_000).toISOString(),
    p_occurrences: 1,
    p_timezone: timezone || 'America/New_York',
  };
}
