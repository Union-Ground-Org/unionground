// REQ-UG-ONBOARDING-AUTO-ASSIGN-AND-STEWARD-OVERSIGHT-20261001 (native):
// the shapes of the staff onboarding oversight payload, normalized by the
// shared web adapter, and the one rule the native roster applies to it.

export type NativeOversightMember = {
  planId: string;
  memberUserId: string;
  memberLabel: string;
  status: string;
  completedStepIds: string[];
  completedSteps: number;
  percentComplete: number;
  autoEnrolled: boolean;
  stalled: boolean;
};

export type NativeOversight = {
  state: string;
  stalledAfterDays: number;
  stalledBelowPercent: number;
  staffOverridesEnabled: boolean;
  totalSteps: number;
  steps: Array<{ id: string; title: string; position: number }>;
  members: NativeOversightMember[];
  memberCount: number;
};

/** The first active step the member has not finished, or null. */
export function nextOpenStep(oversight: NativeOversight, member: NativeOversightMember): { id: string; title: string; position: number } | null {
  const done = new Set(member.completedStepIds);
  return oversight.steps.find((step) => !done.has(step.id)) ?? null;
}

/** The server refuses a skip reason that is empty or longer than this. */
export const NATIVE_SKIP_REASON_MAX = 500;

/**
 * REQ-UG-ONBOARDING-ADMIN-SERVER-GAPS-20261104: a skip needs a
 * reason. The text the server would store (trimmed of all whitespace at both
 * ends), or null while it is empty or too long.
 */
export function nativeSkipReason(value: string): string | null {
  const reason = value.trim();
  return reason.length > 0 && reason.length <= NATIVE_SKIP_REASON_MAX ? reason : null;
}

/** A skip form opened for one step, with the reason typed so far. */
export type NativeSkipDraft = { stepId: string; text: string };

/**
 * #7022 gate r2s1: the skip form belongs to the step it was opened for. When
 * the member's next open step changes (another device finished it, or a
 * reload moved on), the form closes and its reason is dropped, so a reason
 * typed for one step is never sent with the next.
 */
export function nativeSkipDraftFor(draft: NativeSkipDraft | null, stepId: string | null | undefined): NativeSkipDraft | null {
  return draft && stepId && draft.stepId === stepId ? draft : null;
}
