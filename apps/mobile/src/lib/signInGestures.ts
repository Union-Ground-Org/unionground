// Touch rules for the native sign-in form (build c proof, Nov 6, 2026).

export type TouchPoint = { x: number; y: number };

// iOS and Android both treat a touch that moves about 10 pt as the start of a
// scroll rather than a tap.
export const TAP_SLOP = 10;

/**
 * True when a release lands farther than the tap slop from its touch-down, so
 * the gesture was a drag that began on the control. A press with no recorded
 * touch-down (an accessibility activation) is never a drag.
 */
export function releasedAsDrag(start: TouchPoint | null, end: TouchPoint): boolean {
  if (!start) return false;
  return Math.hypot(end.x - start.x, end.y - start.y) > TAP_SLOP;
}

/**
 * How far to scroll so an action's bottom edge, plus a margin, clears the top
 * of the keyboard. Zero when it is already in view. Both edges are in window
 * coordinates.
 */
export function keyboardLiftOffset({ actionBottom, keyboardTop, margin }: { actionBottom: number; keyboardTop: number; margin: number }): number {
  return Math.max(0, Math.ceil(actionBottom + margin - keyboardTop));
}
