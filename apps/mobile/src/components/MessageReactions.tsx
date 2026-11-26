import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Text } from './Text';
import Svg, { Circle, Line, Path, Polygon, Rect } from 'react-native-svg';
import { REACTION_ARTWORK } from '../../../../src/features/messaging/reactionArtwork.js';
import { MESSAGE_REACTIONS, MESSAGE_REACTION_CHOICES, messageReactionLabel } from '../lib/messagingShared';
import { useReduceMotion } from '../lib/reduceMotion';
import { useNativeUi } from '../lib/useNativeUi';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { NumberFlow } from './NumberFlow';
import { CHIP_TEXT_CAP, chipHeight, chipTargetHeight } from './quietChip';

import { typeface } from '../theme/typeface';
function Shape({ tag, attrs }: { tag: string; attrs: Record<string, string> }) {
  switch (tag) {
    case 'path': return <Path {...attrs} />;
    case 'circle': return <Circle {...attrs} />;
    case 'line': return <Line {...attrs} />;
    case 'polygon': return <Polygon {...attrs} />;
    case 'rect': return <Rect {...attrs} />;
    default: return null;
  }
}

// In a chip, drawn artwork (a compact mark in its 52 box) and emoji glyphs are
// sized to read as the same optical size beside a 14 pt label, and grow with
// it up to the chip's text cap.
function MessageReactionIcon({ kind, glyph, chip = false, scale = 1 }: { kind: string; glyph?: string; chip?: boolean; scale?: number }) {
  const art = REACTION_ARTWORK[kind];
  const size = chip ? Math.round(22 * scale) : 28;
  if (!art) return <Text accessible={false} maxFontSizeMultiplier={chip ? CHIP_TEXT_CAP : undefined} style={chip ? styles.chipGlyph : styles.legacy}>{glyph}</Text>;
  return <Svg width={size} height={size} viewBox={art.viewBox} accessible={false}>
    {art.shapes.map(({ tag, attrs }, index) => <Shape key={index} tag={tag} attrs={{
      ...attrs,
      ...(attrs.fill ? { fill: art.palette[attrs.fill] ?? attrs.fill } : {}),
      ...(attrs.stroke ? { stroke: art.palette[attrs.stroke] ?? attrs.stroke } : {}),
    }} />)}
  </Svg>;
}

type Reaction = { kind: string; glyph?: string; emoji?: string; mine?: boolean; count?: number };

// Under a message, reactions are quiet chips in the reply count's system: a
// 36 pt pill with a hairline edge inside a full-height target, the secondary
// fill marking your own (App Store capture review, Nov 7, 2026). The picker
// keeps its larger choice buttons.
export function MessageReactionButton({ entry, disabled = false, onPress, showCount = false, chip = false }: {
  entry: Reaction; disabled?: boolean; onPress: () => void; showCount?: boolean; chip?: boolean;
}) {
  const theme = useTheme();
  const { language, t } = useNativeUi();
  const { fontScale } = useWindowDimensions();
  const textScale = Math.min(fontScale, CHIP_TEXT_CAP);
  const reducedMotion = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reducedMotion) { scale.stopAnimation(); scale.setValue(1); }
    return () => scale.stopAnimation();
  }, [reducedMotion, scale]);
  const label = messageReactionLabel(entry.kind, language);
  function press() {
    if (reducedMotion || disabled) return;
    scale.stopAnimation();
    Animated.timing(scale, { toValue: .85, duration: 80, useNativeDriver: true }).start();
  }
  function release() {
    scale.stopAnimation();
    if (reducedMotion || disabled) { scale.setValue(1); return; }
    Animated.sequence([
      Animated.timing(scale, { toValue: 1.15, duration: 108, useNativeDriver: true }),
      Animated.timing(scale, { toValue: 1, duration: 132, useNativeDriver: true }),
    ]).start();
  }
  return <Pressable accessibilityRole="button"
    accessibilityLabel={showCount ? `${label}: ${entry.count ?? 0}` : label}
    accessibilityHint={entry.mine ? t('Removes your reaction.') : t('Adds your reaction.')}
    accessibilityState={{ selected: Boolean(entry.mine), disabled }} disabled={disabled}
    onPressIn={press} onPressOut={release} onPress={onPress}
    style={chip ? [styles.chipTarget, { minHeight: chipTargetHeight(textScale) }] : [styles.button, { borderColor: entry.mine ? theme.primary : theme.border, backgroundColor: entry.mine ? theme.secondary : theme.card }]}>
    <Animated.View pointerEvents="none" style={[chip ? [styles.chip, entry.mine ? styles.chipMine : null, { minHeight: chipHeight(textScale), gap: Math.round(4 * textScale), paddingHorizontal: Math.round(8 * textScale), borderColor: entry.mine ? theme.primary : theme.border, backgroundColor: entry.mine ? theme.secondary : theme.card }] : styles.contents, { transform: [{ scale }] }]}>
      <MessageReactionIcon kind={entry.kind} glyph={entry.glyph ?? entry.emoji} chip={chip} scale={textScale} />
      <Text accessible={false} maxFontSizeMultiplier={chip ? CHIP_TEXT_CAP : undefined} style={[styles.label, chip ? styles.chipLabel : null, { color: entry.mine ? theme.secondaryForeground : theme.foreground }]}>{label}</Text>
      {showCount && chip ? <Text accessible={false} maxFontSizeMultiplier={CHIP_TEXT_CAP} style={[styles.chipCount, { color: entry.mine ? theme.secondaryForeground : theme.foreground }]}>{String(entry.count ?? 0)}</Text> : null}
      {showCount && !chip ? <NumberFlow decorative value={String(entry.count ?? 0)} style={{ color: entry.mine ? theme.secondaryForeground : theme.foreground }} /> : null}
    </Animated.View>
  </Pressable>;
}

// The add-reaction control as the same quiet chip: a "+" and a smile on the
// card fill (a close icon while the picker is open), so it neither outweighs
// the reactions beside it nor reads as one more reaction.
export function AddReactionChip({ accessibilityLabel, expanded, disabled = false, onPress }: {
  accessibilityLabel: string; expanded: boolean; disabled?: boolean; onPress: () => void;
}) {
  const theme = useTheme();
  const { t } = useNativeUi();
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, CHIP_TEXT_CAP);
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityHint={t('Opens the reaction choices.')}
    accessibilityState={{ expanded, disabled }} disabled={disabled} onPress={onPress} style={[styles.chipTarget, styles.addTarget, { minHeight: chipTargetHeight(scale) }]}>
    {({ pressed }) => <View style={[styles.chip, styles.addChip, expanded ? styles.chipMine : null, { width: Math.round(56 * scale), minHeight: chipHeight(scale), gap: Math.round(2 * scale), backgroundColor: pressed ? theme.muted : theme.card, borderColor: expanded ? theme.primary : theme.border }]}>
      {expanded ? <Ionicons name="close" size={Math.round(18 * scale)} color={theme.secondaryForeground} /> : <>
        <Ionicons name="add" size={Math.round(18 * scale)} color={theme.secondaryForeground} />
        <Ionicons name="happy-outline" size={Math.round(18 * scale)} color={theme.secondaryForeground} />
      </>}
    </View>}
  </Pressable>;
}

export function MessageReactionPicker({ mine = [], disabled = false, onReact }: {
  mine?: string[]; disabled?: boolean; onReact: (kind: string) => void;
}) {
  const { t } = useNativeUi();
  const legacy = MESSAGE_REACTIONS.filter((entry) => !REACTION_ARTWORK[entry.kind] && mine.includes(entry.kind));
  return <View>
  <View style={styles.choices} accessibilityLabel={t('Reaction choices')}>
    {MESSAGE_REACTION_CHOICES.map((choice) => <MessageReactionButton key={choice.kind}
      entry={{ ...choice, mine: mine.includes(choice.kind) }} disabled={disabled} onPress={() => onReact(choice.kind)} />)}
  </View>
  {legacy.length > 0 && <View style={styles.choices} accessibilityLabel={t('Your earlier reactions')}>
    {legacy.map((entry) => (
      <MessageReactionButton key={entry.kind} entry={{ ...entry, mine: true }} disabled={disabled} onPress={() => onReact(entry.kind)} />
    ))}
  </View>}
  </View>;
}

const styles = StyleSheet.create({
  button: { maxWidth: '100%', flexShrink: 1, minWidth: minimumTouchTarget, minHeight: minimumTouchTarget, justifyContent: 'center', padding: spacing.xs, borderWidth: 1, borderRadius: radii.md },
  contents: { maxWidth: '100%', flexShrink: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs },
  label: { flexShrink: 1 },
  chipTarget: { maxWidth: '100%', flexShrink: 1, minWidth: minimumTouchTarget, minHeight: minimumTouchTarget, justifyContent: 'center' },
  chip: { maxWidth: '100%', flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 36, paddingHorizontal: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.pill },
  // Your own reaction keeps a full 1 pt green edge, so it never reads as the
  // reply count's chip beside it.
  chipMine: { borderWidth: 1 },
  // One width for "+ smile" and the close icon (scaled with the text), so
  // neighbours never shift.
  addChip: { justifyContent: 'center', gap: 2, flexShrink: 0, paddingHorizontal: 0 },
  addTarget: { flexShrink: 0 },
  chipLabel: { fontSize: 14, lineHeight: 19, ...typeface.control },
  // The count steps back so the reaction's name leads.
  chipCount: { fontSize: 14, lineHeight: 19, ...typeface.body },
  chipGlyph: { fontSize: 15, lineHeight: 19 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  legacy: { fontSize: 22 },
});
