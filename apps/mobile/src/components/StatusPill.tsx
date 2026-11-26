import { StyleSheet, View } from 'react-native';
import { Text } from './Text';

import { STATUS_ATTENTION_RING_TOKEN, statusRamp, statusStateForLabel, type StatusState } from '../theme/statusRamp';
import { radii, spacing } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';

import { typeface } from '../theme/typeface';
// The work-record status pill (visual-language brief §C): "22-24px tall capsule
// (full-capsule radius), sentence-case, optional 6px leading dot; the dot
// carries the status hue, the pill body stays tinted neutral. One saturated
// fill per row maximum."
//
// The saturated-fill rule is why the body is `theme.muted` for every state
// instead of a per-state fill: a gold "Steward review" pill and an aubergine
// "Resolved" pill put two competing fills in one board header, and neither the
// label nor the count could stay the loudest thing in the row.
export const STATUS_PILL_HEIGHT = 24;
export const STATUS_PILL_DOT = 6;
// Attention is the one state that has to survive a glance across a board, and
// at 6px it was carried by colour alone (wave-2b finding w2b-2). It — and only
// it — takes a larger dot with a 1px ring in the palette's ring step, so size
// and stroke restate the state where hue cannot. Every other state keeps the
// 6px dot; a second ringed state would flatten the difference again.
export const STATUS_PILL_ATTENTION_DOT = 8;
export const STATUS_PILL_ATTENTION_RING = 1;

/**
 * Sentence case, not title case. The pill inherited `textTransform:
 * 'capitalize'`, which renders "in progress" as "In Progress"; the brief asks
 * for sentence case, so only the first character is raised and the rest of the
 * label is left exactly as the record supplied it.
 */
export function sentenceCase(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function StatusPill({ label, state, dot = true }: {
  label: string;
  /** Omit to derive the state from the label (free-text record statuses). */
  state?: StatusState;
  /** The dot is optional per the brief; the label is always the primary cue. */
  dot?: boolean;
}) {
  const theme = useTheme();
  const resolved = state ?? statusStateForLabel(label);
  return (
    <View style={[styles.pill, { backgroundColor: theme.muted }]}>
      {/* Decorative: the hue only restates the label, so it is never the sole
          carrier of the state (brief §C — glyph/label differentiates first). */}
      {dot ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={[
            styles.dot,
            { backgroundColor: statusRamp(theme)[resolved] },
            // The ring's palette key is named once, in the ramp module beside
            // the four state hues, so the component and the contrast audit
            // cannot drift onto different tokens.
            resolved === 'attention' ? [styles.attentionDot, { borderColor: theme[STATUS_ATTENTION_RING_TOKEN] }] : null,
          ]}
        />
      ) : null}
      <Text style={[styles.pillText, { color: theme.foreground }]}>{sentenceCase(label)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    minHeight: STATUS_PILL_HEIGHT,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  dot: { width: STATUS_PILL_DOT, height: STATUS_PILL_DOT, borderRadius: STATUS_PILL_DOT / 2 },
  attentionDot: {
    width: STATUS_PILL_ATTENTION_DOT,
    height: STATUS_PILL_ATTENTION_DOT,
    borderRadius: STATUS_PILL_ATTENTION_DOT / 2,
    borderWidth: STATUS_PILL_ATTENTION_RING,
  },
  pillText: { fontSize: 12, lineHeight: 16, ...typeface.controlStrong },
});
