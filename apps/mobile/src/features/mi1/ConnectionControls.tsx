import { View, StyleSheet } from 'react-native';
import { Text, TextInput } from '../../components/Text';
import { PressableScale } from '../../components/PressableScale';
import { Body } from '../../components/ui';
import { useAccessibilityAnnouncementQueue } from '../../lib/announce';
import { adjustConnectionDial } from '../../lib/connectionSuggestionsShared';
import { haptics } from '../../services/haptics';
import { elevation } from '../../theme/elevation';
import { minimumTouchTarget, radii, spacing } from '../../theme/tokens';
import { useTheme } from '../../theme/ThemeProvider';

import { typeface } from '../../theme/typeface';
export type ConnectionTranslator = (key: string) => string;

export function ConnectionToggle({ label, checked, disabled = false, onChange }: {
  label: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void;
}) {
  const theme = useTheme();
  return <PressableScale accessibilityRole="checkbox" accessibilityLabel={label}
    accessibilityState={{ checked, disabled }} disabled={disabled} resting={elevation.level0}
    onPress={() => { if (!disabled) { void haptics.select(); onChange(!checked); } }}
    style={[connectionStyles.choice, { backgroundColor: disabled ? theme.muted : checked ? theme.secondary : theme.card, borderColor: theme.border }]}>
    <Text accessible={false} style={[connectionStyles.check, { color: disabled ? theme.mutedForeground : theme.secondaryForeground }]}>{checked ? '✓' : '○'}</Text>
    <Text style={[connectionStyles.choiceText, { color: disabled ? theme.mutedForeground : checked ? theme.secondaryForeground : theme.cardForeground }]}>{label}</Text>
  </PressableScale>;
}

export function ConnectionChoices({ label, value, options, disabled = false, onChange }: {
  label: string; value: string; options: Array<{ key: string; label: string }>; disabled?: boolean; onChange: (value: string) => void;
}) {
  const theme = useTheme();
  return <View style={connectionStyles.group} accessibilityLabel={label}>
    <Body style={connectionStyles.label}>{label}</Body>
    <View style={connectionStyles.wrap}>{options.map((option) => <PressableScale key={option.key} resting={elevation.level0}
      accessibilityRole="button" accessibilityLabel={`${label}: ${option.label}`} accessibilityState={{ selected: value === option.key, disabled }}
      disabled={disabled} onPress={() => { if (!disabled) { void haptics.select(); onChange(option.key); } }}
      style={[connectionStyles.chip, { backgroundColor: disabled ? theme.muted : value === option.key ? theme.primary : theme.secondary }]}>
      <Text style={[connectionStyles.chipText, { color: disabled ? theme.mutedForeground : value === option.key ? theme.primaryForeground : theme.secondaryForeground }]}>{option.label}</Text>
    </PressableScale>)}</View>
  </View>;
}

// The adjustable native element supports VoiceOver/TalkBack increment and
// decrement. Named, touch-sized buttons also offer an explicit gesture-free path.
export function ConnectionDial({ label, help, value, onChange, tr }: {
  label: string; help: string; value: number; onChange: (value: number) => void; tr: ConnectionTranslator;
}) {
  const theme = useTheme();
  const announce = useAccessibilityAnnouncementQueue(`connection-dial:${label}`);
  const adjust = (direction: 'increment' | 'decrement', step = 1, announceValue = false) => {
    const next = adjustConnectionDial(value, direction, step);
    if (next !== value) { void haptics.select(); onChange(next); if (announceValue) announce(`${label}: ${next}`); }
  };
  return <View style={connectionStyles.group}>
    <View accessible accessibilityRole="adjustable" accessibilityLabel={label} accessibilityHint={tr('tuningHelp')}
      accessibilityValue={{ min: 0, max: 100, now: value }} accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={({ nativeEvent }) => { if (nativeEvent.actionName === 'increment' || nativeEvent.actionName === 'decrement') adjust(nativeEvent.actionName); }}
      style={connectionStyles.adjustable}>
      <Text style={[connectionStyles.label, { color: theme.cardForeground }]}>{label}</Text>
      <Text style={[connectionStyles.value, { color: theme.cardForeground }]}>{value}</Text>
    </View>
    <Body muted>{help}</Body>
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[connectionStyles.track, { backgroundColor: theme.secondary }]}>
      <View style={[connectionStyles.fill, { backgroundColor: theme.primary, width: `${value}%` }]} />
    </View>
    <View style={connectionStyles.wrap}>{(['decrement', 'increment'] as const).map((direction) => {
      const disabled = direction === 'decrement' ? value === 0 : value === 100;
      return <PressableScale key={direction} resting={elevation.level0} accessibilityRole="button"
        accessibilityLabel={`${tr(direction === 'increment' ? 'increase' : 'decrease')} ${label}: 5, ${value}/100`}
        accessibilityState={{ disabled }} disabled={disabled} onPress={() => { if (!disabled) adjust(direction, 5, true); }}
        style={[connectionStyles.step, { backgroundColor: disabled ? theme.muted : theme.secondary }]}>
        <Text style={[connectionStyles.stepText, { color: disabled ? theme.mutedForeground : theme.secondaryForeground }]}>{direction === 'increment' ? '+5' : '−5'}</Text>
      </PressableScale>;
    })}</View>
  </View>;
}

export function ConnectionField({ label, value, onChange, maxLength, multiline = false, disabled = false, autoCapitalize = 'none', hint }: {
  label: string; value: string; onChange: (value: string) => void; maxLength: number; multiline?: boolean; disabled?: boolean;
  autoCapitalize?: 'none' | 'characters' | 'sentences'; hint?: string;
}) {
  const theme = useTheme();
  return <View style={connectionStyles.group}><Body style={connectionStyles.label}>{label}</Body>
    <TextInput accessibilityLabel={label} accessibilityHint={hint} accessibilityState={{ disabled }} editable={!disabled}
      keyboardAppearance={theme.appearance} value={value} onChangeText={onChange} maxLength={maxLength}
      multiline={multiline} autoCapitalize={autoCapitalize} autoCorrect={false} autoComplete="off"
      importantForAutofill="no" textContentType="none" placeholderTextColor={theme.quietForeground}
      style={[connectionStyles.input, multiline && connectionStyles.multiline,
        { backgroundColor: theme.input, color: theme.foreground, borderColor: theme.border }]} />
  </View>;
}

export const connectionStyles = StyleSheet.create({
  group: { gap: spacing.sm },
  section: { gap: spacing.lg },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  label: { fontSize: 16, lineHeight: 23, ...typeface.controlStrong },
  value: { fontSize: 22, lineHeight: 30, ...typeface.controlStrong },
  adjustable: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  track: { height: 8, borderRadius: radii.pill, overflow: 'hidden' },
  fill: { height: 8, borderRadius: radii.pill },
  step: { minWidth: minimumTouchTarget, minHeight: minimumTouchTarget, paddingHorizontal: spacing.lg, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  stepText: { fontSize: 18, lineHeight: 24, ...typeface.controlStrong },
  choice: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.sm, padding: spacing.md },
  check: { fontSize: 20, lineHeight: 26 },
  choiceText: { flex: 1, fontSize: 16, lineHeight: 23 },
  chip: { minHeight: minimumTouchTarget, paddingHorizontal: spacing.md, paddingVertical: spacing.md, borderRadius: radii.pill, justifyContent: 'center' },
  chipText: { fontSize: 15, lineHeight: 22, ...typeface.control },
  input: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.sm, padding: spacing.md, fontSize: 16, lineHeight: 23 },
  multiline: { minHeight: 128, textAlignVertical: 'top' },
});
