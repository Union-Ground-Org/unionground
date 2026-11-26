// BUG-UG-NATIVE-STAFF-CASE-ACCESS-NEVER-RECORDED-IN-MEMBER-ACCESS-HISTORY-20261118
// (#9120): the entry a steward or coordinator leaves in a member's access
// history when they open or change that member's case on the phone. It is the
// website's write: record_member_access_event with the session's organization,
// the case's member as subject, entity type 'case' and the case id
// (src/features/accessHistory/adapter.js record; src/views/StewardView.jsx
// openCase and recordUpdate; src/views/CoordinatorView.jsx recordCaseEvent).
import type { NativeUiKey } from '../lib/nativeUiCopy';
import type { MobileSessionWriter } from './supabase';

export type CaseAccessAction = 'viewed_case' | 'updated_case';

// The website's words when an entry could not be written
// (accessHistory.recordFailed and accessHistory.updateRecordFailed). They are
// keys of the phone's catalogue, so a Spanish account reads them in Spanish
// (nativeUiSpanish.json); the screen shows them through useNativeUi's t().
export const CASE_VIEW_NOT_LOGGED = 'This record cannot open because its access could not be logged. Try again.' satisfies NativeUiKey;
export const CASE_UPDATE_NOT_LOGGED = 'The issue was saved, but its access-history entry could not be logged. Try again before making another change.' satisfies NativeUiKey;

/**
 * Who a viewed_case entry was written for: the signed-in person, their sign-in
 * (a token refresh keeps it; a new sign-in does not), and the organization and
 * chapter selected when they opened the case. An entry belongs to this scope
 * and one case; another person, sign-in or selection writes its own.
 */
export function caseAccessScope(scope: {
  userID: string | null | undefined;
  sessionID: string | null;
  organizationID: string | null | undefined;
  chapterID: string | null | undefined;
}): string {
  return JSON.stringify([scope.userID ?? null, scope.sessionID, scope.organizationID ?? null, scope.chapterID ?? null]);
}

export type CaseAccessTarget = {
  caseID: string;
  /** The member whose case it is. */
  subjectUserID: string | null | undefined;
  actorUserID: string;
  organizationID: string | null | undefined;
};

/**
 * Writes one access-history entry and says whether it is in place. A staff
 * member's own case is no access to another member: the server refuses
 * self-subject entries, so nothing is written and the answer is true, as on
 * the website.
 */
export async function recordCaseAccess(writer: MobileSessionWriter, action: CaseAccessAction, target: CaseAccessTarget): Promise<boolean> {
  const { caseID, subjectUserID, actorUserID, organizationID } = target;
  if (subjectUserID && subjectUserID === actorUserID) return true;
  if (!subjectUserID || !organizationID || !caseID) return false;
  if (writer.userId !== actorUserID) return false;
  try {
    const supabase = await writer.client();
    const { error } = await supabase.rpc('record_member_access_event', {
      p_expected_organization_id: organizationID,
      p_subject_user_id: subjectUserID,
      p_action: action,
      p_entity_type: 'case',
      p_entity_id: caseID,
    });
    return !error;
  } catch {
    return false; // swallow-ok: the case screen says the access-history entry could not be logged
  }
}
