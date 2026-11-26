import { describe, expect, it } from 'vitest';
import { CASE_OUTCOME_TITLE, caseOutcomeLabel, caseOutcomeRecordedLine, shownCaseOutcome } from './caseOutcomeCopy';

describe('native issue outcome copy (#7195)', () => {
  it('labels every stored outcome and reads an unknown value as Other', () => {
    expect(CASE_OUTCOME_TITLE).toBe('How your issue ended');
    expect(['upheld', 'settled', 'withdrawn', 'denied', 'other'].map(caseOutcomeLabel))
      .toEqual(['Upheld', 'Settled', 'Withdrawn', 'Denied', 'Other']);
    for (const unknown of ['dismissed', '__proto__', 'toString', '']) expect(caseOutcomeLabel(unknown)).toBe('Other');
    expect(caseOutcomeRecordedLine('Nov 6, 2026')).toBe('Recorded Nov 6, 2026');
  });
  it('shows the outcome only while the issue is resolved, never on a reopened issue', () => {
    const outcome = { outcome: 'denied', summary: 'Denied at step 2.' };
    expect(shownCaseOutcome('resolved', outcome)).toBe(outcome);
    expect(shownCaseOutcome('Resolved', outcome)).toBe(outcome);
    expect(shownCaseOutcome('active', outcome)).toBeNull();
    expect(shownCaseOutcome('resolved', null)).toBeNull();
    expect(shownCaseOutcome('resolved', undefined)).toBeNull();
  });
});
