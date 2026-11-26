// BUG-UG-NATIVE-COORDINATOR-ROLE-SHOWS-NO-CASE-QUEUE-20261118 (,
// part 2): a Grievance Coordinator assigns or changes a case's steward on the
// phone through the website's own reads and write (src/lib/memberApi.js
// loadCaseAssignmentCandidates and assignMemberCase; the updated_case
// access-history entry after it is the case screen's, through
// caseAccessHistory.recordCaseAccess). The server decides
// every rule: list_member_case_assignment_candidates and assign_member_case
// admit a coordinator or administrator, at chapter or organization scope, and
// assign_member_case refuses a steward outside the case's scope (23514).
import { getSupabaseClient, type MobileSessionWriter } from './supabase';

// assign_member_case's "leave this role unchanged" intent, as the website's
// bulk Assign panel sends it (ASSIGN_LEAVE_UNCHANGED): the phone changes the
// steward only, so the case's coordinator is carried over as it stands.
export const ASSIGN_LEAVE_UNCHANGED = '00000000-0000-0000-0000-000000000000';

export type CaseAssignmentCandidate = { userId: string; fullName: string | null; roles: string[] };

export type CaseAssignmentState = {
  caseID: string;
  subjectUserID: string;
  organizationID: string | null;
  stewardUserID: string | null;
  stewards: CaseAssignmentCandidate[];
};

// The server's known refusals, kept so the screen can
// say why: 42501 is the coordinator role or two-step verification missing (or
// the member outside the caller's scope), P0002 a case the caller can no
// longer see, 23514 a steward outside the case's scope. Anything else is
// 'failed'.
export type CaseAssignmentRefusal = 'not-allowed' | 'not-found' | 'out-of-scope' | 'failed';

export class CaseAssignmentError extends Error {
  constructor(readonly reason: CaseAssignmentRefusal) {
    super(`issue assignment refused: ${reason}`);
  }
}

export function caseAssignmentRefusal(error: unknown): CaseAssignmentRefusal {
  if (error instanceof CaseAssignmentError) return error.reason;
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return code === '42501' ? 'not-allowed' : code === 'P0002' ? 'not-found' : code === '23514' ? 'out-of-scope' : 'failed';
}

function client() {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  return supabase;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

function candidates(data: unknown): CaseAssignmentCandidate[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((row) => {
    const record = row as Record<string, unknown>;
    const userId = text(record.userId);
    const fullName = text(record.fullName);
    const roles = Array.isArray(record.roles) ? record.roles.filter((role): role is string => typeof role === 'string') : [];
    return userId ? [{ userId, fullName: fullName?.trim() ? fullName : null, roles }] : [];
  });
}

export async function loadCaseAssignment(caseID: string): Promise<CaseAssignmentState> {
  const supabase = client();
  const [caseResult, candidateResult] = await Promise.all([
    supabase.from('member_cases').select('id,user_id,organization_id,steward_user_id').eq('id', caseID).maybeSingle(),
    supabase.rpc('list_member_case_assignment_candidates', { p_case_id: caseID }),
  ]);
  if (caseResult.error) throw new CaseAssignmentError(caseAssignmentRefusal(caseResult.error));
  if (candidateResult.error) throw new CaseAssignmentError(caseAssignmentRefusal(candidateResult.error));
  const row = caseResult.data as Record<string, unknown> | null;
  const subjectUserID = text(row?.user_id);
  if (!row || text(row.id) !== caseID || !subjectUserID) throw new CaseAssignmentError('not-found');
  return {
    caseID,
    subjectUserID,
    organizationID: text(row.organization_id),
    stewardUserID: text(row.steward_user_id),
    stewards: candidates(candidateResult.data).filter((person) => person.roles.includes('steward')),
  };
}

// Writes the steward (null clears it) and leaves the coordinator as it is.
export async function assignCaseSteward(writer: MobileSessionWriter, caseID: string, stewardUserID: string | null): Promise<void> {
  const { error } = await (await writer.client()).rpc('assign_member_case', { p_case_id: caseID, p_steward: stewardUserID, p_coordinator: ASSIGN_LEAVE_UNCHANGED });
  if (!error) return;
  throw new CaseAssignmentError(caseAssignmentRefusal(error));
}
