// REQ-UG-QUOTES-MINI-LESSONS-20260928: how one quote or mini-lesson
// reads to a member. Home, Know your rights and the editor's preview all render
// through this component, so a preview shows exactly what publication would.

import { Platform, StyleSheet, View } from 'react-native';
import { Text } from '../../components/Text';

import type { LearningKind } from '../../lib/learningContentModel';
import type { LearningCopy } from '../../lib/learningContentCopy';
import { useTheme } from '../../theme/ThemeProvider';
import { spacing } from '../../theme/tokens';

import { typeface } from '../../theme/typeface';
const serifFamily = Platform.select({ ios: 'Georgia', default: 'serif' });

export function LearningItemView({ item, copy, compact, expanded }: {
  item: {
    kind: LearningKind;
    title: string;
    body: string;
    attribution: string;
    source: string;
    bullets: readonly string[];
    learning_outcome: string;
  };
  copy: LearningCopy;
  /** Home and the library index show a short excerpt until expanded. */
  compact: boolean;
  expanded: boolean;
}) {
  const theme = useTheme();
  const quote = item.kind === 'quote';
  const full = !compact || expanded;
  const bullets = item.bullets.map((entry) => entry.trim()).filter(Boolean);
  return (
    <View style={styles.stack}>
      <Text style={[styles.eyebrow, { color: theme.primary }]}>{copy.kindEyebrow[item.kind]}</Text>
      <Text accessibilityRole="header" style={[styles.title, { color: theme.cardForeground }]}>{item.title}</Text>
      {quote ? (
        <Text style={[styles.quote, { color: theme.cardForeground }]}>{`“${item.body}”`}</Text>
      ) : (
        <Text numberOfLines={full ? undefined : 4} style={[styles.body, { color: theme.cardForeground }]}>{item.body}</Text>
      )}
      {item.attribution.trim() ? <Text style={[styles.attribution, { color: theme.cardForeground }]}>{copy.attributionLine(item.attribution.trim())}</Text> : null}
      {full && !quote && bullets.length > 0 ? (
        <View style={styles.stack}>
          <Text style={[styles.subheading, { color: theme.cardForeground }]}>{copy.keyPoints}</Text>
          {bullets.map((entry, index) => (
            <View key={`${index}:${entry}`} style={styles.bulletRow}>
              <Text accessibilityElementsHidden importantForAccessibility="no" style={[styles.bulletMark, { color: theme.primary }]}>•</Text>
              <Text style={[styles.body, styles.flex, { color: theme.cardForeground }]}>{entry}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {full && !quote && item.learning_outcome.trim() ? (
        <View style={styles.stack}>
          <Text style={[styles.subheading, { color: theme.cardForeground }]}>{copy.outcome}</Text>
          <Text style={[styles.body, { color: theme.cardForeground }]}>{item.learning_outcome.trim()}</Text>
        </View>
      ) : null}
      {(quote || full) && item.source.trim() ? (
        <Text style={[styles.source, { color: theme.mutedForeground }]}>{copy.sourceLine(item.source.trim())}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  stack: { gap: spacing.xs },
  eyebrow: { fontSize: 12, lineHeight: 16, ...typeface.controlStrong, letterSpacing: 1.2 },
  title: { fontSize: 17, lineHeight: 23, ...typeface.heading },
  quote: { fontFamily: serifFamily, fontSize: 19, lineHeight: 27 },
  body: { fontSize: 16, lineHeight: 23 },
  attribution: { fontSize: 15, lineHeight: 21, ...typeface.control },
  subheading: { fontSize: 15, lineHeight: 20, ...typeface.heading, marginTop: spacing.xs },
  bulletRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  bulletMark: { fontSize: 16, lineHeight: 23, ...typeface.controlStrong },
  source: { fontSize: 14, lineHeight: 19 },
});
