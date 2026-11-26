import { useRef, type PropsWithChildren } from 'react';
import { Keyboard, StyleSheet, View, type GestureResponderEvent, type ViewProps } from 'react-native';

import { useScreenReader } from '../lib/screenReader';
import { shouldDismissKeyboardFromSwipe } from './keyboardDismissGesture';

/**
 * Observes downward movement across app-owned surfaces without ever becoming
 * the responder. The original scroll, press, or drawer gesture therefore
 * continues normally after the keyboard is dismissed.
 */
export function SwipeDownKeyboardDismiss({ children }: PropsWithChildren) {
  const screenReader = useScreenReader();
  const screenReaderRef = useRef(screenReader);
  screenReaderRef.current = screenReader;
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const dismissedGesture = useRef(false);

  function resetGesture() {
    touchStart.current = null;
    dismissedGesture.current = false;
  }

  function onTouchStartCapture(event: GestureResponderEvent) {
    const touches = event.nativeEvent.touches;
    if (touches.length !== 1) {
      resetGesture();
      return;
    }
    const touch = touches[0];
    if (!touch) return;
    touchStart.current = { x: touch.pageX, y: touch.pageY };
    dismissedGesture.current = false;
  }

  function onTouchMoveCapture(event: GestureResponderEvent) {
    const start = touchStart.current;
    const touches = event.nativeEvent.touches;
    if (!start || dismissedGesture.current || screenReaderRef.current || touches.length !== 1) return;
    const touch = touches[0];
    if (!touch) return;
    if (
      Keyboard.isVisible()
      && shouldDismissKeyboardFromSwipe({
        dx: touch.pageX - start.x,
        dy: touch.pageY - start.y,
        touchCount: touches.length,
      })
    ) {
      dismissedGesture.current = true;
      Keyboard.dismiss();
    }
  }

  // React Native's native View config supports capture-phase raw touch props,
  // although its public TypeScript ViewProps surface does not declare them.
  const captureHandlers = {
    onTouchStartCapture,
    onTouchMoveCapture,
    onTouchEndCapture: resetGesture,
    onTouchCancelCapture: resetGesture,
  } as unknown as ViewProps;

  return (
    <View
      style={styles.fill}
      {...captureHandlers}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
