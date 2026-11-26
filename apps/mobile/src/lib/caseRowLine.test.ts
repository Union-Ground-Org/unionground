import { describe, expect, it } from 'vitest';
import { CASE_ROW_ACCESSIBILITY_HINT, caseRowAccessibilityLabel, caseRowIDs, caseRowLine, caseRowTitleMap, loadCaseRowTitles } from './caseRowLine';

// REQ-UG-NEUTRAL-NOTIFICATION-AND-CASE-ROWS-SERVER-COPY-20261104 (#7015).
describe('caseRowLine', () => {
  it('names an issue by type and step, matching private.case_row_line', () => {
    expect(caseRowLine('Discipline', 'Step 2')).toBe('Discipline · Step 2');
    expect(caseRowLine(' Pay ', '')).toBe('Pay');
    expect(caseRowLine(null, 'Intake')).toBe('Issue · Intake');
    expect(caseRowLine(undefined, undefined)).toBe('Issue');
  });
});

// REQ-UG-LIST-ROW-DETAIL-TOGGLE-CHAPTER-AND-STEWARD-20261104 (#7043).
describe('server row names', () => {
  it('keeps only well-formed names by issue id', () => {
    expect([...caseRowTitleMap([
      { id: 'a', title: 'Overtime withheld', topicShown: true },
      { id: 'b', title: 'Discipline · Intake', topicShown: false },
      { id: 'c', title: '  ' }, { id: 7, title: 'x' }, null, 'row',
    ])]).toEqual([['a', 'Overtime withheld'], ['b', 'Discipline · Intake']]);
    expect(caseRowTitleMap({ id: 'a', title: 'x' }).size).toBe(0);
  });

  it('reads issue ids from rows and skips anything without one', () => {
    expect(caseRowIDs([{ id: 'a' }, { id: '' }, { id: 7 }, null, 'b', { id: 'c' }])).toEqual(['a', 'c']);
    expect(caseRowIDs(null)).toEqual([]);
  });

  it('asks once for at most 200 distinct ids and falls back to no names', async () => {
    const asked: string[][] = [];
    const request = async (ids: string[]) => { asked.push(ids); return { data: [{ id: 'a', title: 'Overtime withheld' }], error: null }; };
    const ids = ['a', 'a', '', ...Array.from({ length: 250 }, (_, index) => `id-${index}`)];
    const names = await loadCaseRowTitles(request, ids);
    expect(names.get('a')).toBe('Overtime withheld');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveLength(200);
    expect(asked[0]?.[0]).toBe('a');

    expect((await loadCaseRowTitles(request, [])).size).toBe(0);
    expect(asked).toHaveLength(1);
    expect((await loadCaseRowTitles(async () => ({ data: null, error: new Error('refused') }), ['a'])).size).toBe(0);
    expect((await loadCaseRowTitles(() => { throw new Error('offline'); }, ['a'])).size).toBe(0);
  });
});

// A11Y-UG-NATIVE-STAFF-CASE-QUEUE-ROWS-SPEAK-ONLY-THE-REFERENCE-20261109.
describe('caseRowAccessibilityLabel', () => {
  it('names a row by its visible parts, reference first, skipping blanks', () => {
    expect(caseRowAccessibilityLabel('GR-2026-81524', ['Active', 'Discipline · Arbitration', 'Updated Nov 9, 2026 · 8:05 AM ET']))
      .toBe('GR-2026-81524, Active, Discipline · Arbitration, Updated Nov 9, 2026 · 8:05 AM ET');
    expect(caseRowAccessibilityLabel(' GR-1 ', [undefined, '', ' Pay '])).toBe('GR-1, Pay');
    expect(CASE_ROW_ACCESSIBILITY_HINT).toBe('Opens the issue.');
  });
});
