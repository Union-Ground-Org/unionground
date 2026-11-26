// Votes against a ballot's quorum target, kept honest past 100% (Lovable audit
// APP-ADVISOR-02, REQ-UG-LOVABLE-AUDIT-WEBAPP-FIXES-20261103): "828 of
// 602 needed for quorum" beside a full bar read as a count that contradicts
// itself. The share of quorum is reported as it is (138%), the bar alone is
// capped, and a reached quorum says so. No target means no share at all.
export function quorumProgress(totalVotes, quorumTarget) {
  const target = Number(quorumTarget);
  const votes = Math.max(0, Number(totalVotes) || 0);
  if (!Number.isFinite(target) || target <= 0) return null;
  const percent = Math.round((votes / target) * 100);
  return { votes, target, percent, bar: Math.min(100, percent), reached: votes >= target };
}

export function quorumProgressText(t, progress) {
  return t(progress.reached ? "vp.turnoutQuorumReached" : "vp.turnoutVotesOf", { votes: progress.votes, target: progress.target });
}
