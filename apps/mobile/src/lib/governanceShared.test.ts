import { describe, expect, it } from 'vitest';

import {
  leadershipCardState,
  leadershipFailureCopy,
  leadershipFailureReason,
  normalizeLeadershipRecovery,
  normalizeOfficerRemovalDetails,
  removalOutcomeLabel,
  removalRoleLabel,
} from './governanceShared';

const ELIGIBLE = {
  available: true, eligible: true, reason: 'eligible', chapterId: 'north', chapterName: 'North Campaign',
  inactivityMonths: 6, coolingOffHours: 72, mfaAssured: true, claim: null,
};

describe('campaign leadership recovery (native)', () => {
  it('shows the offer only when the server says the caller is eligible', () => {
    expect(leadershipCardState(normalizeLeadershipRecovery(ELIGIBLE))).toBe('offer');
    expect(leadershipCardState(normalizeLeadershipRecovery({ ...ELIGIBLE, eligible: false, reason: 'active_leader_present' }))).toBe('hidden');
    expect(leadershipCardState(normalizeLeadershipRecovery({ ...ELIGIBLE, available: false }))).toBe('hidden');
    expect(leadershipCardState(normalizeLeadershipRecovery(null))).toBe('hidden');
    expect(leadershipCardState(normalizeLeadershipRecovery('nope'))).toBe('hidden');
  });

  it('shows a pending claim and recent outcomes', () => {
    const pending = normalizeLeadershipRecovery({ ...ELIGIBLE, eligible: false, reason: 'claim_pending', claim: { id: 'c1', status: 'pending', effectiveAt: '2026-10-05T12:00:00Z' } });
    expect(leadershipCardState(pending)).toBe('pending');
    expect(pending?.claim).toEqual({ id: 'c1', status: 'pending', effectiveAt: '2026-10-05T12:00:00Z', decisionNote: null });
    const rejected = normalizeLeadershipRecovery({ ...ELIGIBLE, eligible: false, reason: 'recently_rejected', claim: { id: 'c1', status: 'rejected', decisionNote: 'Not yet.' } });
    expect(leadershipCardState(rejected)).toBe('outcome');
    expect(normalizeLeadershipRecovery({ ...ELIGIBLE, claim: { id: 'c1', status: 'bogus' } })?.claim).toBeNull();
  });

  it('maps refusals to honest copy', () => {
    expect(leadershipFailureReason({ message: 'leadership claim unavailable: claim_pending' })).toBe('claim_pending');
    expect(leadershipFailureReason({ message: 'two-step sign-in required' })).toBe('mfa_required');
    expect(leadershipFailureReason(null)).toBe('failed');
    expect(leadershipFailureCopy('claim_pending')).toBe('Someone already has a claim open for this campaign.');
    expect(leadershipFailureCopy('unknown')).toBe('The claim could not be made. Try again.');
  });
});

describe('officer removal votes (native)', () => {
  it('keeps only well-formed details', () => {
    const details = normalizeOfficerRemovalDetails({ items: [
      { ballotId: 'b1', targetName: 'Olivia Officer', targetRole: 'steward', reason: 'Missed every meeting.', outcome: 'removed' },
      { ballotId: 'b2' },
      null,
    ] });
    expect([...details.keys()]).toEqual(['b1']);
    expect(details.get('b1')).toEqual({ ballotId: 'b1', targetName: 'Olivia Officer', targetRole: 'steward', reason: 'Missed every meeting.', outcome: 'removed' });
    expect(normalizeOfficerRemovalDetails(undefined).size).toBe(0);
  });

  it('labels roles and recorded outcomes', () => {
    expect(removalRoleLabel('vp', 'north')).toBe('campaign lead');
    expect(removalRoleLabel('vp', null)).toBe('campaign chair');
    expect(removalRoleLabel('vp')).toBe('campaign chair');
    expect(removalRoleLabel('other')).toBe('campaign leader');
    expect(removalOutcomeLabel('retained')).toBe('Result recorded: retained');
    expect(removalOutcomeLabel(null)).toBeNull();
  });
});
