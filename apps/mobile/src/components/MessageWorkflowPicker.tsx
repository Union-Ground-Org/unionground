import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';

import { messageWorkflowCopy, messageWorkflowOptions, type MessageWorkflow } from '../lib/messageWorkflow';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
export function MessageWorkflowPicker({ language, value, onChange, compact = false }: {
  language: 'en' | 'es';
  value: MessageWorkflow;
  onChange(workflow: MessageWorkflow): void;
  compact?: boolean;
}) {
  const theme = useTheme();
  const copy = messageWorkflowCopy[language];
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={copy.choiceLabel} style={styles.list}>
      {messageWorkflowOptions.map((option) => {
        const selected = value === option.key;
        const optionCopy = copy.workflow[option.key];
        return (
          <Pressable
            key={option.key}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={`${optionCopy.title}. ${optionCopy.summary}${option.recommended ? `. ${copy.defaultBadge}` : ''}`}
            onPress={() => onChange(option.key)}
            style={({ pressed }) => [styles.option, compact ? styles.optionCompact : null, {
              backgroundColor: pressed ? theme.muted : theme.card,
              borderColor: selected ? theme.primary : theme.border,
              borderWidth: selected ? 2 : StyleSheet.hairlineWidth,
            }]}
          >
            <View style={[styles.number, { backgroundColor: selected ? theme.primary : theme.secondary }]}>
              <Text style={[styles.numberText, { color: selected ? theme.primaryForeground : theme.secondaryForeground }]}>{option.number}</Text>
            </View>
            <View style={styles.copy}>
              <View style={styles.titleRow}>
                <Text style={[styles.title, { color: theme.foreground }]}>{optionCopy.title}</Text>
                {option.recommended ? <Text style={[styles.badge, { backgroundColor: theme.secondary, color: theme.secondaryForeground }]}>{copy.defaultBadge}</Text> : null}
              </View>
              <Text style={[styles.summary, { color: theme.mutedForeground }]}>{optionCopy.summary}</Text>
              {!compact ? <View style={styles.tradeoffs}>
                <Text style={[styles.tradeoff, { color: theme.mutedForeground }]}><Text style={[styles.tradeoffLabel, { color: theme.foreground }]}>{copy.proLabel}: </Text>{optionCopy.pro}</Text>
                <Text style={[styles.tradeoff, { color: theme.mutedForeground }]}><Text style={[styles.tradeoffLabel, { color: theme.foreground }]}>{copy.conLabel}: </Text>{optionCopy.con}</Text>
              </View> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.sm },
  option: { minHeight: 124, flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, borderRadius: radii.lg, padding: spacing.md },
  optionCompact: { minHeight: 86 },
  number: { width: minimumTouchTarget, height: minimumTouchTarget, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  numberText: { fontSize: 14, lineHeight: 19, ...typeface.controlStrong },
  copy: { flex: 1, gap: 3 },
  titleRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  title: { flexShrink: 1, fontSize: 16, lineHeight: 22, ...typeface.heading },
  badge: { overflow: 'hidden', borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 3, fontSize: 11, lineHeight: 15, ...typeface.controlStrong },
  summary: { fontSize: 13, lineHeight: 18 },
  tradeoffs: { gap: 2, marginTop: spacing.xs },
  tradeoff: { fontSize: 12, lineHeight: 17 },
  tradeoffLabel: { ...typeface.controlStrong },
});
