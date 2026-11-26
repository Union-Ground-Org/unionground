// Governance shapes shared by the native leadership card and ballot cards
// (REQ-UG-CHAPTER-LEADERSHIP-RECOVERY-20261001,
// REQ-UG-OFFICER-REMOVAL-BALLOTS-20261001). The server decides every
// eligibility and scope question; these helpers only normalize what it returns
// and pick honest copy. Native copy is English only (owner ruling).

export type LeadershipClaimStatus = 'pending' | 'granted' | 'rejected' | 'withdrawn' | 'lapsed';

export type LeadershipClaim = {
  id: string;
  status: LeadershipClaimStatus;
  effectiveAt: string;
  decisionNote: string | null;
};

export type LeadershipRecovery = {
  available: boolean;
  eligible: boolean;
  reason: string;
  chapterId: string | null;
  chapterName: string | null;
  inactivityMonths: number;
  coolingOffHours: number;
  mfaAssured: boolean;
  claim: LeadershipClaim | null;
};

const CLAIM_STATUSES: readonly LeadershipClaimStatus[] = ['pending', 'granted', 'rejected', 'withdrawn', 'lapsed'];

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function normalizeLeadershipRecovery(raw: unknown): LeadershipRecovery | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const claimValue = value.claim && typeof value.claim === 'object' ? value.claim as Record<string, unknown> : null;
  const status = claimValue && CLAIM_STATUSES.includes(claimValue.status as LeadershipClaimStatus)
    ? claimValue.status as LeadershipClaimStatus
    : null;
  const claimID = claimValue ? text(claimValue.id) : null;
  return {
    available: value.available === true,
    eligible: value.eligible === true,
    reason: text(value.reason) ?? 'chapter_unavailable',
    chapterId: text(value.chapterId),
    chapterName: text(value.chapterName),
    inactivityMonths: count(value.inactivityMonths, 6),
    coolingOffHours: count(value.coolingOffHours, 72),
    mfaAssured: value.mfaAssured === true,
    claim: claimID && status
      ? { id: claimID, status, effectiveAt: text(claimValue?.effectiveAt) ?? '', decisionNote: text(claimValue?.decisionNote) }
      : null,
  };
}

export type LeadershipCardState = 'hidden' | 'offer' | 'pending' | 'outcome';

// The card shows the offer only when the server says the caller is eligible,
// a pending claim with its date, or the outcome of a recent claim. Anything
// else (feature off, a failed read, an active leader) shows nothing.
export function leadershipCardState(recovery: LeadershipRecovery | null): LeadershipCardState {
  if (!recovery || !recovery.available) return 'hidden';
  if (recovery.claim?.status === 'pending') return 'pending';
  if (recovery.eligible) return 'offer';
  if (recovery.claim) return 'outcome';
  return 'hidden';
}

export function leadershipFailureReason(error: unknown): string {
  const message = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '';
  const match = message.match(/leadership claim unavailable: ([a-z_]+)/);
  if (match?.[1]) return match[1];
  if (/two-step sign-in required/.test(message)) return 'mfa_required';
  if (/chapter unavailable/.test(message)) return 'chapter_unavailable';
  return 'failed';
}

const FAILED_COPY = 'The claim could not be made. Try again.';

const FAILURE_COPY: Record<string, string> = {
  active_leader_present: 'A campaign admin or committee member has been active recently, so the campaign cannot be claimed.',
  claim_pending: 'Someone already has a claim open for this campaign.',
  recently_rejected: 'Your last claim for this campaign was rejected less than 30 days ago.',
  mfa_required: 'Sign in with your second step to claim.',
  chapter_too_new: 'This campaign is too new to claim.',
  not_member: 'Only active workers in this campaign can claim it.',
  already_leader: 'You already lead this campaign.',
  disabled: 'Campaign leadership recovery is off for your organization.',
  chapter_unavailable: 'You can only claim your own campaign.',
  failed: FAILED_COPY,
};

export function leadershipFailureCopy(reason: string): string {
  return FAILURE_COPY[reason] ?? FAILED_COPY;
}

export const LEADERSHIP_OUTCOME_COPY: Record<Exclude<LeadershipClaimStatus, 'pending'>, { title: string; body: string | null }> = {
  granted: { title: 'Your campaign leadership claim took effect', body: 'You now hold the campaign admin role.' },
  rejected: { title: 'Your campaign leadership claim was not approved', body: 'An organization admin rejected it.' },
  lapsed: { title: 'Your campaign leadership claim closed', body: 'It did not take effect because the campaign no longer qualified.' },
  withdrawn: { title: 'You withdrew your campaign leadership claim', body: null },
};

export type OfficerRemovalDetail = {
  ballotId: string;
  targetName: string;
  targetRole: string;
  reason: string;
  outcome: 'removed' | 'retained' | null;
};

const ROLE_LABELS: Record<string, string> = {
  steward: 'committee member', coordinator: 'campaign lead', advisor: 'advisor', admin: 'admin', vp: 'campaign chair',
};

export function removalRoleLabel(role: string, chapterId?: string | null): string {
  if (role === 'vp' && chapterId) return 'campaign lead';
  return ROLE_LABELS[role] ?? 'campaign leader';
}

export function removalOutcomeLabel(outcome: OfficerRemovalDetail['outcome']): string | null {
  if (outcome === 'removed') return 'Result recorded: removed from the role';
  if (outcome === 'retained') return 'Result recorded: retained';
  return null;
}

export function normalizeOfficerRemovalDetails(raw: unknown): Map<string, OfficerRemovalDetail> {
  const details = new Map<string, OfficerRemovalDetail>();
  const items = raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)
    ? (raw as { items: unknown[] }).items
    : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    const ballotId = text(value.ballotId);
    const targetName = text(value.targetName);
    if (!ballotId || !targetName) continue;
    details.set(ballotId, {
      ballotId,
      targetName,
      targetRole: text(value.targetRole) ?? 'officer',
      reason: text(value.reason) ?? '',
      outcome: value.outcome === 'removed' || value.outcome === 'retained' ? value.outcome : null,
    });
  }
  return details;
}
