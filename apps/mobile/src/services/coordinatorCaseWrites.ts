import type { MobileSessionWriter } from './supabase';

// BUG-UG-NATIVE-IOS-STEWARD-CANNOT-WORK-AN-ASSIGNED-CASE-20261117
// (#9091), part 4: the coordinator's case writes on the phone through the
// routines the website's coordinator case panel uses (src/lib/memberApi.js
// coordinatorAddCaseNote, coordinatorLogCaseContact, coordinatorUpdateCase):
// a case note, a logged contact (with the employer or anyone else) and a
// later case deadline with a reason. Each needs the coordinator role, two-step
// verification and a case the coordinator can see. After each write the
// website records the updated_case access-history entry; the screen does the
// same through its acknowledgement callback and recordCaseAccess.
export type ContactType = 'phone' | 'email' | 'meeting' | 'letter' | 'other';
export const CONTACT_TYPES: readonly ContactType[] = ['phone', 'email', 'meeting', 'letter', 'other'];
export type ContactDirection = 'outbound' | 'inbound' | 'internal';
export const CONTACT_DIRECTIONS: readonly ContactDirection[] = ['outbound', 'inbound', 'internal'];
export const COORDINATOR_NOTE_MAX = 4000;
export const CONTACT_SUMMARY_MAX = 2000;
export const CHANGE_REASON_MAX = 1000;

// Every refusal the three routines raise gets its own reason:
//   42501 'coordinator role required'          -> coordinatorRole
//   42501 'case unavailable', and P0002        -> unavailable
//   42501 'mfa required'                       -> mfa
//   42501 'step-up required' (PIN session)     -> stepUp
//   any other 42501                            -> refused
//   22023 'note must be 1-4000 characters'     -> noteInvalid
//   22023 'invalid contact type', 'invalid contact direction' or
//         'summary must be 1-2000 characters'  -> contactInvalid
//   22023 'invalid contact time'               -> contactTime
//   22023 'deadline may only be extended'      -> deadlineEarlier
//   22023 'reason must be 1-1000 characters'   -> reasonInvalid
//   any other 22023 ('invalid status', a step change, articles too long),
//   which this screen never sends             -> invalid
//   anything else                              -> failed
export type CoordinatorWriteFailure = 'coordinatorRole' | 'unavailable' | 'mfa' | 'stepUp' | 'refused' | 'noteInvalid'
  | 'contactInvalid' | 'contactTime' | 'deadlineEarlier' | 'reasonInvalid' | 'invalid' | 'failed';

export class CoordinatorWriteError extends Error {
  constructor(readonly reason: CoordinatorWriteFailure) {
    super(`Issue not saved (${reason}).`);
  }
}

export function coordinatorWriteFailure(error: { code?: string; message?: string }): CoordinatorWriteFailure {
  const message = String(error.message ?? '');
  switch (error.code) {
    case '42501':
      if (message.includes('campaign lead role required')) return 'coordinatorRole';
      if (message.includes('issue unavailable')) return 'unavailable';
      if (message.includes('mfa required')) return 'mfa';
      if (message.includes('step-up required')) return 'stepUp';
      return 'refused';
    case 'P0002': return 'unavailable';
    case '22023':
      if (message.includes('note must be')) return 'noteInvalid';
      if (message.includes('invalid contact type') || message.includes('invalid contact direction') || message.includes('summary must be')) return 'contactInvalid';
      if (message.includes('invalid contact time')) return 'contactTime';
      if (message.includes('deadline may only be extended')) return 'deadlineEarlier';
      if (message.includes('reason must be')) return 'reasonInvalid';
      return 'invalid';
    default: return 'failed';
  }
}

async function call(writer: MobileSessionWriter, name: string, args: Record<string, unknown>): Promise<void> {
  const supabase = await writer.client();
  const { error } = await supabase.rpc(name, args);
  if (error) throw new CoordinatorWriteError(coordinatorWriteFailure(error as { code?: string; message?: string }));
}

// The checks made before anything is sent (#9440 successor): the card runs
// them before it begins an attempt, so a refusal from here never reaches a
// write.
export function coordinatorNoteProblem(body: string): CoordinatorWriteFailure | null {
  const note = body.trim();
  return !note || note.length > COORDINATOR_NOTE_MAX ? 'noteInvalid' : null;
}
export function coordinatorContactProblem(input: { summary: string; contactedAt: Date }): CoordinatorWriteFailure | null {
  const summary = input.summary.trim();
  if (!summary || summary.length > CONTACT_SUMMARY_MAX) return 'contactInvalid';
  // The server takes a time up to five minutes ahead (clock drift), not later.
  return input.contactedAt.getTime() > Date.now() + 5 * 60_000 ? 'contactTime' : null;
}
export function caseDeadlineChangeProblem(input: { currentDeadline: string | null; deadline: Date; reason: string }): CoordinatorWriteFailure | null {
  const reason = input.reason.trim();
  if (!reason || reason.length > CHANGE_REASON_MAX) return 'reasonInvalid';
  return input.currentDeadline && calendarDay(input.deadline) < input.currentDeadline ? 'deadlineEarlier' : null;
}

export async function addCoordinatorCaseNote(writer: MobileSessionWriter, caseID: string, body: string): Promise<void> {
  const note = body.trim();
  const problem = coordinatorNoteProblem(body);
  if (problem) throw new CoordinatorWriteError(problem);
  await call(writer, 'coordinator_add_case_note', { p_case_id: caseID, p_body: note });
}

export async function logCoordinatorCaseContact(writer: MobileSessionWriter, input: {
  caseID: string; type: ContactType; direction: ContactDirection; summary: string; contactedAt: Date;
}): Promise<void> {
  const summary = input.summary.trim();
  const problem = coordinatorContactProblem(input);
  if (problem) throw new CoordinatorWriteError(problem);
  await call(writer, 'coordinator_log_case_contact', {
    p_case_id: input.caseID,
    p_contact_type: input.type,
    p_direction: input.direction,
    p_summary: summary,
    p_contacted_at: input.contactedAt.toISOString(),
  });
}

// The calendar day the coordinator picked, as the case's date column holds it.
export function calendarDay(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

// Only the deadline and its reason are sent; the server keeps the status,
// step and contract articles as they are when they are left out.
export async function extendCaseDeadline(writer: MobileSessionWriter, input: { caseID: string; currentDeadline: string | null; deadline: Date; reason: string }): Promise<void> {
  const reason = input.reason.trim();
  const problem = caseDeadlineChangeProblem(input);
  if (problem) throw new CoordinatorWriteError(problem);
  const day = calendarDay(input.deadline);
  await call(writer, 'coordinator_update_case', { p_case_id: input.caseID, p_deadline: day, p_reason: reason });
}
