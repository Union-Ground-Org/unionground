import { useRef, useState } from 'react';
import { StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';

import {
  SIGNATURE_LIMIT,
  appendSignaturePoint,
  beginSignatureStroke,
  finishSignatureStroke,
  signaturePoint,
  type SignatureStrokes,
} from '../lib/signatureStrokes';
import { useTheme } from '../theme/ThemeProvider';
import { radii, spacing } from '../theme/tokens';
import { Body, Button } from './ui';

// REQ-UG-NATIVE-FORMS-FULL-PARITY-WITH-THE-WEBSITE-20261113 (#8699):
// the form signature, drawn with a finger. The page stops scrolling while a
// finger is down (onDrawingChange), and the strokes are kept in the server's
// 0-1000 grid (lib/signatureStrokes) whatever the pad's size on screen. With
// VoiceOver or TalkBack on, a double-tap and hold passes the finger through to
// the pad, which the instructions say in words.
export function SignaturePad({ value, onChange, onDrawingChange, disabled = false, label, instructions, clearLabel, capLabel }: {
  value: SignatureStrokes;
  onChange: (next: SignatureStrokes) => void;
  onDrawingChange?: (drawing: boolean) => void;
  disabled?: boolean;
  label: string;
  instructions: string;
  clearLabel: string;
  capLabel: string;
}) {
  const theme = useTheme();
  const size = useRef({ width: 1, height: 1 });
  const strokes = useRef(value);
  strokes.current = value;
  const [capped, setCapped] = useState(false);

  const pointOf = (event: GestureResponderEvent) => signaturePoint(event.nativeEvent.locationX, event.nativeEvent.locationY, size.current.width, size.current.height);
  const emit = (next: SignatureStrokes) => {
    strokes.current = next;
    onChange(next);
  };
  const end = () => {
    emit(finishSignatureStroke(strokes.current));
    onDrawingChange?.(false);
  };

  return (
    <View style={styles.wrap}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityHint={instructions}
        accessibilityState={{ disabled }}
        onLayout={(event: LayoutChangeEvent) => { size.current = { width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height }; }}
        onStartShouldSetResponder={() => !disabled}
        onMoveShouldSetResponder={() => !disabled}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(event) => {
          onDrawingChange?.(true);
          const change = beginSignatureStroke(strokes.current, pointOf(event));
          setCapped(change.capped);
          emit(change.strokes);
        }}
        onResponderMove={(event) => {
          const change = appendSignaturePoint(strokes.current, pointOf(event));
          if (change.capped) setCapped(true);
          else if (change.strokes !== strokes.current) emit(change.strokes);
        }}
        onResponderRelease={end}
        onResponderTerminate={end}
        style={[styles.pad, { borderColor: theme.border, backgroundColor: theme.input }]}
      >
        <Svg width="100%" height="100%" viewBox={`0 0 ${SIGNATURE_LIMIT} ${SIGNATURE_LIMIT}`} preserveAspectRatio="none" pointerEvents="none">
          {value.map((stroke, index) => (
            <Polyline key={index} points={stroke.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke={theme.foreground} strokeWidth={8} strokeLinecap="round" strokeLinejoin="round" />
          ))}
        </Svg>
      </View>
      <Body muted>{instructions}</Body>
      {capped ? <Body>{capLabel}</Body> : null}
      <Button label={clearLabel} variant="secondary" disabled={disabled || value.length === 0} onPress={() => { setCapped(false); emit([]); }} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  pad: { height: 180, borderWidth: 1, borderRadius: radii.md, overflow: 'hidden' },
});
