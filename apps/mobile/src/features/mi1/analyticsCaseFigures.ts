// BUG-UG-COUNTS-AND-STATUSES-DISAGREE-BETWEEN-PAGES-20261122,
// phone: the Statistics tab printed "Open cases 0" when no group of cases had
// reached the privacy floor, while the website said the figures are not shown
// yet and Casework listed active cases. The shared overview
// (src/features/analytics/stats.js) says caseGroups 0 means "no group of cases
// reached the floor, not a known zero"; this applies the website's rule
// (src/features/analytics/ui/AnalyticsCoreDesk.jsx OverviewTiles) to the
// phone: such figures show no number and the website's reason instead.

// The website's wording for this state, so both surfaces say the same.
export const NO_CASE_GROUPS = 'No issue figures to show yet. Issue groups can appear only when they meet the organization\'s privacy minimum (at least 25 people).';
export const CASES_INCOMPLETE = 'Issue totals are hidden because some groups may be withheld to protect small groups.';
export const CASES_HIDDEN_SMALL_CHAPTER = 'Hidden while a campaign has fewer than 25 workers. Campaigns shows the rest.';

type Overview = {
  openCases?: number | null;
  resolvedCases?: number | null;
  resolutionRate?: number | null;
  caseGroups?: number | null;
  casesSuppressed?: boolean;
  publishedChapterTotalsIncomplete?: boolean;
  publishedChapterTotals?: { chapters: number; of: number; openCases: number; resolvedCases: number; resolutionRate: number | null } | null;
};

export type AnalyticsCaseFigures = {
  openCases: number | null;
  resolvedCases: number | null;
  resolutionRate: string | null;
  /** How many chapters published numbers come from, or null (the website's tile scope). */
  scope: { count: number; total: number } | null;
  /** The English catalogue key of the reason no number shows, or null. */
  missing: string | null;
};

export function analyticsCaseFigures(overview: Overview | null | undefined): AnalyticsCaseFigures {
  const o = overview ?? {};
  const scoped = o.openCases == null ? o.publishedChapterTotals ?? null : null;
  const noGroups = o.caseGroups === 0;
  const missing = noGroups ? NO_CASE_GROUPS
    : o.publishedChapterTotalsIncomplete ? CASES_INCOMPLETE
      : o.casesSuppressed ? CASES_HIDDEN_SMALL_CHAPTER : null;
  const value = <T,>(figure: T | null | undefined): T | null => (noGroups || figure === undefined ? null : figure);
  const rate = value(o.resolutionRate ?? scoped?.resolutionRate);
  const openCases = value(o.openCases ?? scoped?.openCases);
  // As the website's StatTile: a shown number carries its scope, and the
  // reason shows only when there is no number.
  const shown = openCases != null;
  return {
    openCases,
    resolvedCases: value(o.resolvedCases ?? scoped?.resolvedCases),
    resolutionRate: rate == null ? null : `${rate}%`,
    scope: shown && scoped ? { count: scoped.chapters, total: scoped.of } : null,
    missing: shown ? null : missing,
  };
}
