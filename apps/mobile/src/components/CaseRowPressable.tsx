import { Pressable, type PressableProps } from 'react-native';

import { CASE_ROW_ACCESSIBILITY_HINT, caseRowAccessibilityLabel } from '../lib/caseRowLine';

// The one pressable for a row that opens a case. Its accessible name is the
// row's own visible text, reference first
// (A11Y-UG-NATIVE-STAFF-CASE-QUEUE-ROWS-SPEAK-ONLY-THE-REFERENCE-20261109).
export function CaseRowPressable({ reference, visible, ...pressableProps }: Omit<PressableProps, 'accessibilityRole' | 'accessibilityLabel' | 'accessibilityHint'> & {
  reference: string;
  /** The row's other visible parts, in reading order. */
  visible: readonly (string | null | undefined)[];
}) {
  return (
    <Pressable
      {...pressableProps}
      accessibilityRole="button"
      accessibilityLabel={caseRowAccessibilityLabel(reference, visible)}
      accessibilityHint={CASE_ROW_ACCESSIBILITY_HINT}
    />
  );
}
