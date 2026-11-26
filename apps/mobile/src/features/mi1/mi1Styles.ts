import { StyleSheet } from 'react-native';

import { minimumTouchTarget, radii, spacing } from '../../theme/tokens';

import { typeface } from '../../theme/typeface';
export const mi1Styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minHeight: minimumTouchTarget,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
  },
  chipText: { fontSize: 14, lineHeight: 18, ...typeface.controlStrong },
  fieldLabel: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  input: {
    minHeight: minimumTouchTarget,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 16,
    lineHeight: 22,
  },
  multiline: { minHeight: 120, textAlignVertical: 'top' },
  noticeAction: { minHeight: minimumTouchTarget, justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
});
