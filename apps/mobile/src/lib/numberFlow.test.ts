import { describe, expect, it } from 'vitest';

import {
  canFlowAtFontScale,
  digitOffset,
  digitTransition,
  fitScale,
  FLOW_MAX_FONT_SCALE,
  formatFlowCount,
  flowAlignment,
  flowColumns,
  flowParts,
  shouldFlow,
  splitFlowValue,
} from './numberFlow';

// Numeric contract for the rolling stat's value handling (owner request
// 2026-09-13). Stat primitives pass formatted strings, so the split decides
// what rolls and what stays a plain, wrappable line, and it must never change
// a character of what the caller formatted.
describe('number flow value', () => {
  it.each([
    { value: '12', want: { prefix: '', core: '12', suffix: '' } },
    { value: '38%', want: { prefix: '', core: '38', suffix: '%' } },
    { value: '1,204', want: { prefix: '', core: '1,204', suffix: '' } },
    { value: '$8.4k', want: { prefix: '$', core: '8.4', suffix: 'k' } },
    { value: '-3h', want: { prefix: '', core: '-3', suffix: 'h' } },
  ])('splits $value', ({ value, want }) => {
    expect(splitFlowValue(value)).toEqual(want);
  });

  it('returns null for a value with no number', () => {
    expect(splitFlowValue('Not available')).toBeNull();
    expect(splitFlowValue('')).toBeNull();
    expect(shouldFlow('Not available')).toBe(false);
  });

  it('rolls a stat and leaves prose alone', () => {
    expect(shouldFlow('1,204')).toBe(true);
    expect(shouldFlow('$8.4k')).toBe(true);
    expect(shouldFlow('Employer answer due in 14 days')).toBe(false);
  });

  it('rolls the number inside a short label and keeps the words as words', () => {
    // "Sep 12" is the dues "Next due" metric. Its day rolls like any other
    // digit; the month stays one Text node so the line can still wrap.
    expect(shouldFlow('Sep 12')).toBe(true);
    expect(flowParts('Sep 12')).toEqual({ prefix: 'Sep ', core: '12', suffix: '' });
  });

  it.each(['213/300', '2:45', '3 of 12', '1 234,5', '1.234,56', '12-14'])(
    'leaves %s as one plain string because a second number follows the first',
    (value) => {
      expect(flowParts(value)).toBeNull();
    },
  );

  it.each(['١٢٣', '１２３'])('does not roll non-ASCII digits (%s)', (value) => {
    expect(flowParts(value)).toBeNull();
  });

  it('never changes a rendered character: prefix, core and suffix rebuild the value', () => {
    for (const value of ['0', '12', '38%', '1,204', '$1,204.50', '€ 12', '1,5', '−3', '+3', '-3h', 'Sep 12', '3.', '9k+', '1.204']) {
      const parts = flowParts(value);
      expect(parts, value).not.toBeNull();
      if (!parts) continue;
      expect(parts.prefix + parts.core + parts.suffix, value).toBe(value);
      expect(flowColumns(parts.core).map((column) => column.char).join(''), value).toBe(parts.core);
    }
  });
});

describe('number flow columns', () => {
  it('keys columns from the right so the units digit keeps its roller', () => {
    expect(flowColumns('99').map((column) => column.key)).toEqual(['d1', 'd0']);
    expect(flowColumns('100').map((column) => column.key)).toEqual(['d2', 'd1', 'd0']);
  });

  it('keeps separators as fixed columns beside the digits', () => {
    expect(flowColumns('1,204')).toEqual([
      { char: '1', key: 'd4', digit: 1 },
      { char: ',', key: 'c3', digit: null },
      { char: '2', key: 'd2', digit: 2 },
      { char: '0', key: 'd1', digit: 0 },
      { char: '4', key: 'd0', digit: 4 },
    ]);
    expect(flowColumns('8.4').map((column) => column.digit)).toEqual([8, null, 4]);
  });

  it('parks each digit a whole cell up from the column top', () => {
    expect(digitOffset(0, 24)).toBe(-0);
    expect(digitOffset(7, 24)).toBe(-168);
    expect(digitOffset(9, 30.5)).toBe(-274.5);
  });
});

describe('number flow motion decisions', () => {
  it('does not animate an unchanged or never-settled digit', () => {
    expect(digitTransition(null, 4)).toBe('set');
    expect(digitTransition(4, 4)).toBe('set');
  });

  it('rolls only when the digit actually changes', () => {
    expect(digitTransition(4, 5)).toBe('roll');
    expect(digitTransition(9, 0)).toBe('roll');
  });

  it('stops rolling at accessibility text sizes', () => {
    expect(canFlowAtFontScale(1)).toBe(true);
    expect(canFlowAtFontScale(FLOW_MAX_FONT_SCALE)).toBe(true);
    expect(canFlowAtFontScale(1.36)).toBe(false);
    expect(canFlowAtFontScale(3.1)).toBe(false);
    expect(canFlowAtFontScale(Number.NaN)).toBe(false);
  });
});

describe('number flow fit', () => {
  it('leaves a row that fits, or is not yet measured, at full size', () => {
    expect(fitScale(80, 64)).toBe(1);
    expect(fitScale(80, 80.4)).toBe(1);
    expect(fitScale(0, 64)).toBe(1);
    expect(fitScale(80, 0)).toBe(1);
    expect(fitScale(Number.NaN, 64)).toBe(1);
  });

  it('shrinks an overflowing row to exactly the room it was given', () => {
    expect(fitScale(60, 90)).toBeCloseTo(2 / 3, 10);
    expect(fitScale(60, 90) * 90).toBeCloseTo(60, 10);
  });

  it('aligns the box with the text alignment the caller styled', () => {
    expect(flowAlignment('center')).toBe('center');
    expect(flowAlignment('right')).toBe('flex-end');
    expect(flowAlignment('left')).toBe('flex-start');
    expect(flowAlignment(undefined)).toBe('flex-start');
  });
});

// BUG-UG-MOBILE-NUMBERFLOW-UNIT-WRAPS-MID-WORD-IN-NARROW-TILES-20261010:
// the rewards tile hands over "1,840" rather than "1840 points", so the caller
// needs the separators the component itself will never add.
describe('number flow count formatting', () => {
  it('groups thousands so a reward total reads as a number', () => {
    expect(formatFlowCount(1840)).toBe('1,840');
    expect(formatFlowCount(27)).toBe('27');
    expect(formatFlowCount(0)).toBe('0');
    expect(formatFlowCount(1234567)).toBe('1,234,567');
  });

  it('still rolls what it formats', () => {
    expect(shouldFlow(formatFlowCount(1840))).toBe(true);
    expect(flowColumns(formatFlowCount(1840)).map((column) => column.char).join('')).toBe('1,840');
  });

  it('passes a value it cannot format through unchanged', () => {
    expect(formatFlowCount(Number.NaN)).toBe('NaN');
    expect(formatFlowCount(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });
});
