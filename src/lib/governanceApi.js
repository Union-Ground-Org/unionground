// Governance RPCs restored by the restore-everything
// (REQ-UG-CHAPTER-LEADERSHIP-RECOVERY-20261001,
// REQ-UG-OFFICER-REMOVAL-BALLOTS-20261001). The database decides every
// eligibility, scope and switch question; these wrappers only shape the calls
// and turn the server's refusal into a stable reason code for the copy.
import { MemberApiError } from "./memberApiError.js";

function resultOrThrow(result, label) {
  if (result?.error) throw new MemberApiError(label, result.error);
  return result?.data;
}

// "leadership claim unavailable: <reason>" -> "<reason>"; the two-step and
// chapter refusals get their own codes. Anything else is "failed".
export function leadershipFailureReason(error) {
  const message = String(error?.message ?? "");
  const match = message.match(/leadership claim unavailable: ([a-z_]+)/);
  if (match) return match[1];
  if (/two-step sign-in required/.test(message)) return "mfa_required";
  if (/chapter unavailable/.test(message)) return "chapter_unavailable";
  return "failed";
}

export async function loadChapterLeadershipRecovery(client) {
  return resultOrThrow(await client.rpc("get_chapter_leadership_recovery"), "Chapter leadership");
}

export async function claimChapterLeadership(client, chapterId) {
  return resultOrThrow(await client.rpc("claim_chapter_leadership", { p_chapter_id: chapterId }), "Claim chapter leadership");
}

export async function withdrawChapterLeadershipClaim(client, claimId) {
  return resultOrThrow(await client.rpc("withdraw_chapter_leadership_claim", { p_claim_id: claimId }), "Withdraw leadership claim");
}

export async function listChapterLeadershipClaims(client) {
  return resultOrThrow(await client.rpc("list_chapter_leadership_claims", { p_limit: 50 }), "Leadership claims");
}

export async function rejectChapterLeadershipClaim(client, claimId, note) {
  const trimmed = String(note ?? "").trim();
  return resultOrThrow(await client.rpc("reject_chapter_leadership_claim", {
    p_claim_id: claimId,
    p_note: trimmed || null,
  }), "Reject leadership claim");
}

export async function listOfficerRemovalTargets(client, scope) {
  return resultOrThrow(await client.rpc("list_officer_removal_targets", { p_scope: scope }), "Officer removal targets");
}

export async function saveOfficerRemovalDraft(client, fields) {
  return resultOrThrow(await client.rpc("save_officer_removal_ballot_draft", {
    p_campaign_id: fields.id?.trim() || null,
    p_scope: fields.scope,
    p_target_user_id: fields.targetUserId,
    p_reason: String(fields.reason ?? "").trim(),
    p_title_en: fields.titleEn.trim(),
    p_title_es: fields.titleEs.trim(),
    p_body_en: String(fields.bodyEn ?? "").trim(),
    p_body_es: String(fields.bodyEs ?? "").trim(),
    p_closes_at: fields.closesAt,
    p_quorum_target: Number(fields.quorumTarget),
  }), "Save officer removal ballot");
}

export async function recordOfficerRemovalOutcome(client, campaignId, outcome) {
  return resultOrThrow(await client.rpc("record_officer_removal_outcome", {
    p_campaign_id: campaignId,
    p_outcome: outcome,
  }), "Record officer removal outcome");
}

// Removal details for the given ballot ids, as a Map keyed by ballot id plus
// the organization switch. Soft: a database without the governance migration
// (or any refusal) yields no details, so ballots render exactly as before.
export async function loadOfficerRemovalDetails(client, ballotIds) {
  const ids = [...new Set((ballotIds ?? []).filter((id) => typeof id === "string" && id))].slice(0, 200);
  try {
    const result = await client.rpc("get_officer_removal_ballot_details", { p_ballot_ids: ids });
    if (result?.error || !result?.data || !Array.isArray(result.data.items)) return { enabled: false, byId: new Map() };
    return {
      enabled: result.data.enabled === true,
      byId: new Map(result.data.items.filter((item) => typeof item?.ballotId === "string").map((item) => [item.ballotId, item])),
    };
  } catch {
    return { enabled: false, byId: new Map() };
  }
}
