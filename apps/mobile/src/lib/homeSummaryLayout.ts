// BUG-UG-NATIVE-HOME-SUMMARY-LABELS-BREAK-MID-WORD-20261103: the four
// Member summary items on live Home sat in four equal columns at every text
// size. At the largest iPhone size each column held about two letters of its
// label, so the labels broke inside words ("Ope / n / case / s"). The row now
// takes as many columns as its longest label word fits in at the current text
// size, balancing the metric count before falling back to a stacked list.

// Matches the metric label style in app/(tabs)/home.tsx.
export const SUMMARY_LABEL_FONT_SIZE = 12;
// A generous average glyph advance for the semibold system font, in ems:
// "messages" measures about 4.65 em in SF Pro Semibold, under 8 x 0.6.
const AVERAGE_GLYPH_EM = 0.6;

export type SummaryLayoutInput = {
  labels: readonly string[];
  fontScale: number;
  // Width the row's columns share, inside the row's own padding.
  rowWidth: number;
  // Horizontal padding each column puts around its label.
  columnPadding: number;
};

export function longestWordLength(labels: readonly string[]): number {
  return labels.reduce((longest, label) => (
    label.trim().split(/\s+/).reduce((inner, word) => Math.max(inner, word.length), longest)
  ), 0);
}

export type SummaryColumnWidth = '100%' | '50%' | '33.333333%' | '25%';

export const SUMMARY_COLUMN_WIDTH: Readonly<Record<1 | 2 | 3 | 4, SummaryColumnWidth>> = { 1: '100%', 2: '50%', 3: '33.333333%', 4: '25%' };

export function summaryColumns({ labels, fontScale, rowWidth, columnPadding }: SummaryLayoutInput): 1 | 2 | 3 | 4 {
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  const wordWidth = longestWordLength(labels) * SUMMARY_LABEL_FONT_SIZE * scale * AVERAGE_GLYPH_EM;
  const needed = wordWidth + columnPadding;
  // Include every metric in the budget. Five metrics take 3+2 rather than
  // 4+1; three staff metrics take one row or a readable single-column list.
  const columnCounts: readonly (2 | 3 | 4)[] = [4, 3, 2];
  for (const columns of columnCounts) {
    if (labels.length > 0 && (columns > labels.length || labels.length % columns === 1)) continue;
    if (rowWidth / columns >= needed) return columns;
  }
  return 1;
}
