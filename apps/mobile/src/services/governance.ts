import { businessRpc } from './businessWriters';
import type { MobileSessionWriter } from './supabase';
// Governance RPCs for the native apps (REQ-UG-CHAPTER-LEADERSHIP-RECOVERY-20261001,
// REQ-UG-OFFICER-REMOVAL-BALLOTS-20261001): the same server authorities
// the web reads. The database enforces MFA, chapter scope and the switches.
import { getSupabaseClient } from './supabase';
import {
  normalizeLeadershipRecovery,
  normalizeOfficerRemovalDetails,
  type LeadershipRecovery,
  type OfficerRemovalDetail,
} from '../lib/governanceShared';

export const GOVERNANCE_RPC_NAMES = Object.freeze({
  recovery: 'get_chapter_leadership_recovery',
  claim: 'claim_chapter_leadership',
  withdraw: 'withdraw_chapter_leadership_claim',
  removalDetails: 'get_officer_removal_ballot_details',
});

async function rpc(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const client = getSupabaseClient();
  if (!client) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await client.rpc(name, args);
  if (error) throw error;
  return data;
}

export async function loadMobileLeadershipRecovery(): Promise<LeadershipRecovery | null> {
  return normalizeLeadershipRecovery(await rpc(GOVERNANCE_RPC_NAMES.recovery));
}

export async function claimMobileChapterLeadership(writer: MobileSessionWriter, chapterID: string): Promise<void> {
  await businessRpc(writer, GOVERNANCE_RPC_NAMES.claim, { p_chapter_id: chapterID });
}

export async function withdrawMobileLeadershipClaim(writer: MobileSessionWriter, claimID: string): Promise<void> {
  await businessRpc(writer, GOVERNANCE_RPC_NAMES.withdraw, { p_claim_id: claimID });
}

// Soft: without the governance migration, or on any refusal, ballots render
// exactly as before.
export async function loadMobileOfficerRemovalDetails(ballotIDs: string[]): Promise<Map<string, OfficerRemovalDetail>> {
  if (ballotIDs.length === 0) return new Map();
  try {
    return normalizeOfficerRemovalDetails(await rpc(GOVERNANCE_RPC_NAMES.removalDetails, { p_ballot_ids: ballotIDs.slice(0, 200) }));
  } catch {
    return new Map();
  }
}
