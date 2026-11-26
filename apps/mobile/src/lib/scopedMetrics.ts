// REQ-UG-LOVABLE-AUDIT-NATIVE-FIXES-BALLOT-FIRST-20261103 (audit
// MOB-STEWARD-05, MOB-ADVISOR-05, MOB-VP-05): My reports said "Your own numbers
// only" above figures that were chapter totals. Every figure now carries its
// own scope and period, so a personal count and a chapter count can sit on one
// screen without either one claiming to be the other.

export type ReportMetricScope = 'own' | 'chapter';

export const MY_REPORTS_SUMMARY = 'Each figure says whose activity it counts and over what period.';

const SCOPE_LABELS: Record<ReportMetricScope, string> = {
  own: 'Yours',
  chapter: 'Campaign total',
};

export function reportMetricScopeLabel(scope: ReportMetricScope, period: string): string {
  return `${SCOPE_LABELS[scope]} · ${period}`;
}

// The live report card, points ledger and workload log all read the signed-in
// member's own rows across everything the service retains.
export const OWN_RETAINED_HISTORY = reportMetricScopeLabel('own', 'all retained history');
