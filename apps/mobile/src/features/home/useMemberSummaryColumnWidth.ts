import { useWindowDimensions } from 'react-native';

import { SUMMARY_COLUMN_WIDTH, summaryColumns, type SummaryColumnWidth } from '../../lib/homeSummaryLayout';
import { spacing } from '../../theme/tokens';

// The share of the live Home Member summary row each item takes at the current
// window width and text size: four, two or one column, whichever lets the
// longest label word fit, so no label breaks inside a word
// (BUG-UG-NATIVE-HOME-SUMMARY-LABELS-BREAK-MID-WORD-20261103). The
// row sits inside the screen's 16 pt inset and its own 8 pt padding, and each
// item pads its label by 8 pt on both sides (app/(tabs)/home.tsx).
export function useMemberSummaryColumnWidth(labels: readonly string[]): SummaryColumnWidth {
  const dimensions = useWindowDimensions();
  return SUMMARY_COLUMN_WIDTH[summaryColumns({
    labels,
    fontScale: dimensions.fontScale,
    rowWidth: dimensions.width - spacing.lg * 2 - spacing.sm * 2,
    columnPadding: spacing.sm * 2,
  })];
}
