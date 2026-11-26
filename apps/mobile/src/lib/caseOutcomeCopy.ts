// The recorded case outcome on the native case screen (#7195). English only
// (native owner ruling), kept inside apps/mobile so the screen reaches no
// shared catalogue bytes; the web words live in src/lib/i18n/caseOutcome.js.
export const CASE_OUTCOME_TITLE = 'How your issue ended';

type OutcomeKind = 'upheld' | 'settled' | 'withdrawn' | 'denied' | 'other';
const OUTCOME_LABELS: Readonly<Record<OutcomeKind, string>> = Object.freeze({
  upheld: 'Upheld',
  settled: 'Settled',
  withdrawn: 'Withdrawn',
  denied: 'Denied',
  other: 'Other',
});

const OUTCOME_KINDS: readonly OutcomeKind[] = ['upheld', 'settled', 'withdrawn', 'denied', 'other'];

// An unknown value reads as Other rather than a raw key.
export function caseOutcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[OUTCOME_KINDS.find((kind) => kind === outcome) ?? 'other'];
}

export function caseOutcomeRecordedLine(date: string): string {
  return `Recorded ${date}`;
}

// Only a resolved case shows its outcome: reopening keeps the earlier outcome
// row, which is not how an active case ended.
export function shownCaseOutcome<T>(status: string, outcome: T | null | undefined): T | null {
  return status.toLowerCase() === 'resolved' && outcome ? outcome : null;
}
