import type { MobileSessionWriter } from './supabase';
import { getSupabaseClient } from './supabase';
import { isAuthoritativeReadRefusal } from '../lib/readRefusal';

// BUG-UG-NATIVE-IOS-STEWARD-CANNOT-WORK-AN-ASSIGNED-CASE-20261117
//, part 1: the case's own steward adds a case note on the phone through
// the same routine the website's steward case dialog uses
// (src/features/caseNotes/api.js, addStewardCaseNote). The routine checks the
// steward hat, MFA and that the case is assigned to the caller, writes the
// note to the case history (member_case_updates) and audits it as note_added.
// The phone sends no date, so the server dates the note today on the Eastern
// calendar, as the website's form does by default.
export const STEWARD_CASE_NOTE_MAX = 4000;

// Every refusal the routine raises gets its own reason:
//   42501 'steward role and MFA required' -> stewardRole
//   42501 'case not found or not yours'   -> notYours
//   42501 'step-up required' (PIN session) -> stepUp
//   any other 42501                        -> refused
//   22023 (note length or date)            -> invalid
//   anything else                          -> failed
export type StewardCaseNoteFailure = 'stewardRole' | 'notYours' | 'stepUp' | 'refused' | 'invalid' | 'failed';

export function stewardCaseNoteFailure(error: { code?: string; message?: string }): StewardCaseNoteFailure {
  const message = String(error.message ?? '');
  if (error.code === '42501') {
    if (message.includes('committee member role and MFA required')) return 'stewardRole';
    if (message.includes('issue not found or not yours')) return 'notYours';
    if (message.includes('step-up required')) return 'stepUp';
    return 'refused';
  }
  return error.code === '22023' ? 'invalid' : 'failed';
}

export class StewardCaseNoteError extends Error {
  constructor(readonly reason: StewardCaseNoteFailure) {
    super(`Issue note not saved (${reason}).`);
  }
}

// Whether the case is assigned to this steward: the website draws the note form
// only in the steward's own case dialog, so the phone asks the same question
// before drawing it. member_cases row security still decides what the caller
// can read; any failure answers no, and the routine checks again on save.
export async function isAssignedStewardCase(caseID: string, stewardID: string): Promise<boolean> {
  return await stewardCaseAssignment(caseID, stewardID) === 'assigned';
}

// The same read with its answer kept apart from a failure ( pull request
// E): 'unassigned' is the server's answer that this steward cannot read the
// case as theirs, which retires the steward's held case drafts; 'unknown' (no
// client, a transport or server error) only hides the case tools, as before.
export type StewardCaseAssignment = 'assigned' | 'unassigned' | 'unknown';
export async function stewardCaseAssignment(caseID: string, stewardID: string): Promise<StewardCaseAssignment> {
  const supabase = getSupabaseClient();
  if (!supabase) return 'unknown';
  const { data, error } = await supabase.from('member_cases')
    .select('id')
    .eq('id', caseID)
    .eq('steward_user_id', stewardID)
    .maybeSingle();
  if (error) return isAuthoritativeReadRefusal(error) ? 'unassigned' : 'unknown';
  return data !== null ? 'assigned' : 'unassigned';
}

// Answers the saved note's id (the routine returns the new row), or null when
// the reply carries none.
// The check made before anything is sent ( successor): the card runs it
// before it begins an attempt, so a refusal from here never reaches a write.
export function stewardCaseNoteProblem(body: string): StewardCaseNoteFailure | null {
  const note = body.trim();
  return !note || note.length > STEWARD_CASE_NOTE_MAX ? 'invalid' : null;
}

export async function addStewardCaseNote(writer: MobileSessionWriter, caseID: string, body: string): Promise<string | null> {
  const note = body.trim();
  const problem = stewardCaseNoteProblem(body);
  if (problem) throw new StewardCaseNoteError(problem);
  const supabase = await writer.client();
  if (!supabase) throw new StewardCaseNoteError('failed');
  const reply: { data: unknown; error: unknown } = await supabase.rpc('steward_add_case_note', {
    p_case_id: caseID,
    p_body: note,
    p_occurred_on: null,
  });
  const { error } = reply;
  if (!error) {
    const id: unknown = reply.data !== null && typeof reply.data === 'object' ? Reflect.get(reply.data, 'id') : null;
    return typeof id === 'string' && id ? id : null;
  }
  throw new StewardCaseNoteError(stewardCaseNoteFailure(error as { code?: string; message?: string }));
}
