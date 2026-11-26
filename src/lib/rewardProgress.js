// The server preserves attained tiers when administrators raise thresholds.
// Keep that tier; use the catalog to fill sparse next-tier metadata.
export function rewardProgress(summary, tiers = []) {
  const validLadder = Array.isArray(tiers) && tiers.every((row) => row && Number.isFinite(row.tier)
    && Number.isFinite(row.minPoints) && typeof row.name === "string" && row.name.trim());
  const ladder = validLadder ? [...tiers].sort((a, b) => a.tier - b.tier) : [];
  const total = summary?.totalPoints;
  const current = Number.isFinite(total) ? ladder.find((row) => row.tier === summary.tierNumber) : null;
  const summaryHasProgress = typeof summary?.nextTierName === "string" && summary.nextTierName.trim()
    && Number.isFinite(summary.pointsToGo) && summary.pointsToGo >= 0;
  const summaryIsMaxTier = !summaryHasProgress && summary?.isMaxTier === true;
  const next = !summaryIsMaxTier && current ? ladder.find((row) => row.tier > current.tier) : null;
  // Prefer explicit server progress, including a confirmed maximum, over a
  // missing or stale ladder. Sparse summaries still use the catalog fallback.
  const isMaxTier = !summaryHasProgress && (summaryIsMaxTier || Boolean(current && !next));
  const nextThreshold = summaryHasProgress ? total + summary.pointsToGo : next?.minPoints;
  return {
    rewards: !summaryHasProgress && current ? {
      ...summary,
      tierNumber: current.tier,
      tierName: typeof summary.tierName === "string" && summary.tierName.trim() ? summary.tierName : current.name,
      nextTierName: next?.name ?? null,
      pointsToGo: next ? Math.max(0, next.minPoints - total) : null,
    } : summary,
    isMaxTier,
    hasProgress: Boolean(next || summaryHasProgress),
    percent: current && nextThreshold > current.minPoints ? Math.min(100, Math.max(4, Math.round(100 * (total - current.minPoints) / (nextThreshold - current.minPoints)))) : isMaxTier ? 100 : 0,
  };
}
