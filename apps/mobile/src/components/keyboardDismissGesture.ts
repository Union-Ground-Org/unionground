export const KEYBOARD_DISMISS_DISTANCE = 14;
export const KEYBOARD_DISMISS_DIRECTION_RATIO = 1.25;

export type KeyboardDismissGesture = {
  dx: number;
  dy: number;
  touchCount: number;
};

/**
 * Recognizes deliberate, single-finger downward intent without competing with
 * horizontal drawers, taps, input selection, or ordinary touch jitter.
 */
export function shouldDismissKeyboardFromSwipe({ dx, dy, touchCount }: KeyboardDismissGesture): boolean {
  if (touchCount !== 1 || dy < KEYBOARD_DISMISS_DISTANCE) return false;
  return dy >= Math.abs(dx) * KEYBOARD_DISMISS_DIRECTION_RATIO;
}

/** iOS follows the finger; Android's native ScrollView dismisses at drag start. */
export function keyboardDismissModeFor(platform: string): 'interactive' | 'on-drag' {
  return platform === 'ios' ? 'interactive' : 'on-drag';
}
