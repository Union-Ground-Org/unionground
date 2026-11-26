import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, useWindowDimensions, View, type LayoutChangeEvent, type StyleProp, type TextStyle } from 'react-native';
import { Text } from './Text';

import {
  canFlowAtFontScale,
  digitOffset,
  digitTransition,
  fitScale,
  flowAlignment,
  flowColumns,
  flowParts,
  type FlowParts,
} from '../lib/numberFlow';
import { useReduceMotion } from '../lib/reduceMotion';

// Native counterpart of @number-flow/react (owner request 2026-09-13, after
// 21st.dev barvian/activity-with-number-flow): every digit of a stat is a
// column of 0–9 that rolls vertically to its new value, so a KPI that changes
// under the member's eyes reads as a live count rather than a flicker.
//
// The value is never reformatted: "$", "%", "k", "Sep " and the separators
// inside "1,204" render exactly as the caller wrote them. Only a value that is
// one number with a short unit (lib/numberFlow.ts) becomes digit columns;
// anything else — "Not available", "213/300", "2:45" — renders as an ordinary
// Text. The same plain Text is used under Reduce Motion and at accessibility
// text sizes, so those paths are fully static and keep wrapping, numberOfLines
// and shrink-to-fit. The wrapper carries the whole formatted value for
// VoiceOver; the digit columns are decorative.

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const ROLL_MS = 420;

export function NumberFlow({
  value,
  style,
  lineHeight,
  accessibilityLabel,
  numberOfLines,
  adjustsFontSizeToFit,
  decorative = false,
}: {
  /** Already formatted value, e.g. "12", "38%", "1,204", "3h". */
  value: string;
  style?: StyleProp<TextStyle>;
  /** Overrides the style's lineHeight for every glyph in the row. */
  lineHeight?: number;
  accessibilityLabel?: string;
  /** Plain-text paths only; a rolling stat is always one line. */
  numberOfLines?: number;
  /** Plain-text paths only; a rolling row shrinks itself to the width it is given. */
  adjustsFontSizeToFit?: boolean;
  /**
   * The value sits inside a parent that is already one labelled accessibility
   * element (a button, a tile) and speaks it. The value then stays out of the
   * accessibility tree so it is announced once.
   */
  decorative?: boolean;
}) {
  const reduceMotion = useReduceMotion();
  const { fontScale } = useWindowDimensions();
  const parts = useMemo(() => flowParts(value), [value]);
  if (!parts || reduceMotion || !canFlowAtFontScale(fontScale)) {
    return (
      <Text
        accessible={decorative ? false : undefined}
        accessibilityLabel={decorative ? undefined : accessibilityLabel}
        adjustsFontSizeToFit={adjustsFontSizeToFit}
        numberOfLines={numberOfLines}
        style={style}
      >
        {value}
      </Text>
    );
  }
  return <RollingValue parts={parts} value={value} style={style} lineHeight={lineHeight} accessibilityLabel={accessibilityLabel} decorative={decorative} />;
}

function RollingValue({
  parts,
  value,
  style,
  lineHeight,
  accessibilityLabel,
  decorative,
}: {
  parts: FlowParts;
  value: string;
  style?: StyleProp<TextStyle>;
  lineHeight?: number;
  accessibilityLabel?: string;
  decorative: boolean;
}) {
  const flat = StyleSheet.flatten(style) ?? {};
  const textStyle: StyleProp<TextStyle> = [style, styles.tabular, lineHeight === undefined ? null : { lineHeight }];
  // Digit columns cannot shrink like adjustsFontSizeToFit text, so the row
  // measures the room its parent gave it and the width its content wants, and
  // scales down to fit rather than spilling into the neighbouring cell. Nothing
  // shows until both are known, so the first frame cannot flash oversized.
  const [available, setAvailable] = useState(0);
  const [content, setContent] = useState(0);
  const scale = fitScale(available, content);
  const ready = available > 0 && content > 0;
  const onBox = useCallback((event: LayoutChangeEvent) => setAvailable(event.nativeEvent.layout.width), []);
  // The row's own width is clamped to its box when it overflows, so the last
  // piece's right edge is what reports the width the content really wants.
  const onEnd = useCallback((event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    setContent(x + width);
  }, []);
  const columns = flowColumns(parts.core);
  return (
    <View
      accessible={!decorative}
      accessibilityRole={decorative ? undefined : 'text'}
      accessibilityLabel={decorative ? undefined : accessibilityLabel ?? value}
      accessibilityElementsHidden={decorative}
      importantForAccessibility={decorative ? 'no-hide-descendants' : 'yes'}
      onLayout={onBox}
      style={[styles.box, { alignItems: flowAlignment(flat.textAlign), opacity: ready ? 1 : 0 }]}
    >
      <View style={[styles.row, scale < 1 ? { alignSelf: 'flex-start', transform: [{ scale }], transformOrigin: 'left center' } : null]}>
        {parts.prefix ? <Glyphs text={parts.prefix} style={textStyle} /> : null}
        {columns.map((column, index) => {
          const last = index === columns.length - 1 && !parts.suffix;
          return column.digit === null
            ? <Glyphs key={column.key} text={column.char} style={textStyle} onEnd={last ? onEnd : undefined} />
            : <Digit key={column.key} digit={column.digit} textStyle={textStyle} onEnd={last ? onEnd : undefined} />;
        })}
        {parts.suffix ? <Glyphs text={parts.suffix} style={textStyle} onEnd={onEnd} /> : null}
      </View>
    </View>
  );
}

// A fixed run of the value's own text: unit, currency sign, separator. It is
// one line always: a run that wrapped inside itself ("point" above "1840s" in a
// narrow rewards tile) both broke the value mid-word and reported a laid-out
// width that fitted the box, so the row's own shrink never engaged. Kept on one
// line, a run that fits the box measures its whole width and fitScale takes the
// whole row down instead. Text is still measured against the box, so a run
// wider than the entire box (a long unit in a tile too narrow for the unit
// alone) is clipped with an ellipsis rather than broken inside the word; such a
// caller should move the unit into its label, as the rewards tiles do
// (BUG-UG-MOBILE-NUMBERFLOW-UNIT-WRAPS-MID-WORD-IN-NARROW-TILES-20261010).
function Glyphs({ text, style, onEnd }: { text: string; style: StyleProp<TextStyle>; onEnd?: (event: LayoutChangeEvent) => void }) {
  return (
    <Text accessibilityElementsHidden importantForAccessibility="no" numberOfLines={1} onLayout={onEnd} style={style}>
      {text}
    </Text>
  );
}

function Digit({ digit, textStyle, onEnd }: { digit: number; textStyle: StyleProp<TextStyle>; onEnd?: (event: LayoutChangeEvent) => void }) {
  // The cell is the height the glyph really lays out at, read from the text
  // itself, so Dynamic Type, font fallback and lineHeight never clip a digit
  // the way a hard-coded row height would. Until it is known the digit paints
  // as ordinary text, so there is no empty first frame.
  const [cell, setCell] = useState<number | null>(null);
  const offset = useRef(new Animated.Value(0)).current;
  const settled = useRef<number | null>(null);
  const onSizer = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    setCell((current) => (current !== null && Math.abs(current - height) < 0.5 ? current : height));
  }, []);
  useEffect(() => {
    if (cell === null) return undefined;
    const toValue = digitOffset(digit, cell);
    const action = digitTransition(settled.current, digit);
    settled.current = digit;
    if (action === 'set') {
      offset.setValue(toValue);
      return undefined;
    }
    Animated.timing(offset, { toValue, duration: ROLL_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    return () => offset.stopAnimation();
  }, [cell, digit, offset]);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={onEnd}
      style={cell === null ? null : { height: cell, overflow: 'hidden' }}
    >
      {/* In flow: gives the cell its width and height. Hidden once the column
          paints; tabular figures keep every digit the same width. */}
      <Text onLayout={onSizer} style={[textStyle, cell === null ? null : styles.sizer]}>{cell === null ? digit : '0'}</Text>
      {cell === null ? null : (
        <Animated.View style={[styles.column, { transform: [{ translateY: offset }] }]}>
          {DIGITS.map((glyph) => (
            <Text key={glyph} style={[textStyle, styles.glyph, { height: cell }]}>{glyph}</Text>
          ))}
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { maxWidth: '100%' },
  row: { flexDirection: 'row', alignItems: 'flex-end', flexShrink: 0 },
  tabular: { fontVariant: ['tabular-nums'] },
  sizer: { opacity: 0 },
  column: { position: 'absolute', top: 0, left: 0, right: 0 },
  glyph: { textAlign: 'center' },
});
