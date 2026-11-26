import { describe, expect, it } from 'vitest';

import { SUMMARY_COLUMN_WIDTH, SUMMARY_LABEL_FONT_SIZE, longestWordLength, summaryColumns } from './homeSummaryLayout';

// BUG-UG-NATIVE-HOME-SUMMARY-LABELS-BREAK-MID-WORD-20261103.
const LABELS = ['Open issues', 'Activity', 'Unread messages', 'This week'];
// The live row: 16 pt screen inset and 8 pt row padding on each side, 8 pt
// column padding on each side.
const row = (windowWidth: number) => windowWidth - 16 * 2 - 8 * 2;

describe('summaryColumns', () => {
  it('measures the longest single word, not the longest label', () => {
    expect(longestWordLength(LABELS)).toBe('messages'.length);
    expect(longestWordLength(['  spaced   out  '])).toBe(6);
    expect(longestWordLength([])).toBe(0);
  });

  it('keeps four columns at the default size on current iPhones', () => {
    for (const width of [375, 393, 402, 430]) {
      expect(summaryColumns({ labels: LABELS, fontScale: 1, rowWidth: row(width), columnPadding: 16 })).toBe(4);
    }
  });

  it('steps to two columns, then one, as the text size grows', () => {
    const at = (fontScale: number) => summaryColumns({ labels: LABELS, fontScale, rowWidth: row(402), columnPadding: 16 });
    expect(at(1.118)).toBe(4);
    // At the largest standard size "messages" (about 75 pt) no longer fits a quarter.
    expect(at(1.353)).toBe(2);
    expect(at(1.786)).toBe(2);
    expect(at(2.643)).toBe(2);
    expect(at(3.571)).toBe(1);
  });

  it('leaves each label column wider than the longest word at a generous glyph width', () => {
    for (const fontScale of [1, 1.353, 1.786, 2, 2.143, 2.643, 3.143, 3.571]) {
      const columns = summaryColumns({ labels: LABELS, fontScale, rowWidth: row(402), columnPadding: 16 });
      if (columns === 1) continue;
      // "messages" measures about 4.65 em in SF Pro Semibold.
      expect(row(402) / columns - 16).toBeGreaterThan(4.65 * SUMMARY_LABEL_FONT_SIZE * fontScale);
    }
  });

  it('falls back to the default size for an unusable font scale', () => {
    for (const fontScale of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      expect(summaryColumns({ labels: LABELS, fontScale, rowWidth: row(402), columnPadding: 16 })).toBe(4);
    }
  });

  it('names a row share for every column count', () => {
    expect(SUMMARY_COLUMN_WIDTH).toEqual({ 1: '100%', 2: '50%', 3: '33.333333%', 4: '25%' });
  });
});
