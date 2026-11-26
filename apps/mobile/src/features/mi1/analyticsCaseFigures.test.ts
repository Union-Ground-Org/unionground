import { describe, expect, it } from 'vitest';
import { nativeCatalogLabel } from '../../lib/nativeUiCopy';
import { analyticsCaseFigures, CASES_HIDDEN_SMALL_CHAPTER, CASES_INCOMPLETE, NO_CASE_GROUPS } from './analyticsCaseFigures';

// BUG-UG-COUNTS-AND-STATUSES-DISAGREE-BETWEEN-PAGES-20261122 (#9533),
// iOS demo walk of Nov 24, 2026: the Steward's Organization analytics >
// Statistics read "Open cases 0" while Casework listed 14 active cases and the
// website, for the same person, said no case figures are shown yet. The shared
// overview (src/features/analytics/stats.js) reports caseGroups 0 with a raw
// openCases of 0 when no group of cases reached the floor ("not a known
// zero"); the phone now applies the website's rule to it
// (src/features/analytics/ui/AnalyticsCoreDesk.jsx OverviewTiles).
describe('Statistics issue figures follow the website rule (#9533)', () => {
  it('shows no number and the reason when no group of issues reached the floor', () => {
    expect(analyticsCaseFigures({ caseGroups: 0, openCases: 0, resolvedCases: 0, resolutionRate: null, casesSuppressed: false }))
      .toEqual({ openCases: null, resolvedCases: null, resolutionRate: null, scope: null, missing: NO_CASE_GROUPS });
  });

  it('keeps the numbers when issue groups are published', () => {
    expect(analyticsCaseFigures({ caseGroups: 4, openCases: 31, resolvedCases: 9, resolutionRate: 23, casesSuppressed: false }))
      .toEqual({ openCases: 31, resolvedCases: 9, resolutionRate: '23%', scope: null, missing: null });
  });

  it('uses published campaign totals when the organization total is hidden, with the scope and no hidden-figure reason', () => {
    // As the website's StatTile: a shown number carries "In N of M chapters",
    // and the reason shows only when there is no number.
    expect(analyticsCaseFigures({ caseGroups: 3, openCases: null, resolvedCases: null, casesSuppressed: true, publishedChapterTotals: { chapters: 3, of: 6, openCases: 40, resolvedCases: 10, resolutionRate: 20 } }))
      .toEqual({ openCases: 40, resolvedCases: 10, resolutionRate: '20%', scope: { count: 3, total: 6 }, missing: null });
  });

  it('says why when the organization total is hidden and no campaign totals are published', () => {
    expect(analyticsCaseFigures({ caseGroups: 3, openCases: null, resolvedCases: null, casesSuppressed: true }))
      .toEqual({ openCases: null, resolvedCases: null, resolutionRate: null, scope: null, missing: CASES_HIDDEN_SMALL_CHAPTER });
    expect(analyticsCaseFigures({ caseGroups: 3, openCases: null, resolvedCases: null, casesSuppressed: true, publishedChapterTotalsIncomplete: true }).missing).toBe(CASES_INCOMPLETE);
  });

  it('answers no figures for a missing overview', () => {
    expect(analyticsCaseFigures(null)).toEqual({ openCases: null, resolvedCases: null, resolutionRate: null, scope: null, missing: null });
  });

  it('has each reason in Spanish, worded as the website says it', () => {
    // NO_CASE_GROUPS: the website's new words for this state (record #9813).
    expect(NO_CASE_GROUPS).toBe("No issue figures to show yet. Issue groups can appear only when they meet the organization's privacy minimum (at least 25 people).");
    expect(nativeCatalogLabel('es', NO_CASE_GROUPS)).toBe('Todavía no hay cifras de asuntos para mostrar. Los grupos de asuntos solo pueden mostrarse si alcanzan el mínimo de privacidad de la organización (al menos 25 personas).');
    expect(nativeCatalogLabel('es', CASES_INCOMPLETE)).toBe('Los totales de asuntos están ocultos porque algunos grupos pueden reservarse para proteger a grupos pequeños.');
    expect(nativeCatalogLabel('es', CASES_HIDDEN_SMALL_CHAPTER)).toBe('Oculto mientras una campaña tenga menos de 25 trabajadores. Campañas muestra el resto.');
    // The scope sentence, as the website's analytics.tileScope says it.
    expect(nativeCatalogLabel('es', 'In {count} of {total} campaigns')).toBe('En {count} de {total} campañas');
  });
});
