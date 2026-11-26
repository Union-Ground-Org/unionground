import { describe, expect, it } from 'vitest';

import { keyboardLiftOffset, releasedAsDrag, TAP_SLOP } from './signInGestures';

describe('sign-in touch rules (build c proof, Nov 6, 2026)', () => {
  it('reads a release within the tap slop as a tap, and a longer move as a drag', () => {
    expect(releasedAsDrag({ x: 100, y: 600 }, { x: 103, y: 606 })).toBe(false);
    expect(releasedAsDrag({ x: 100, y: 600 }, { x: 100, y: 600 + TAP_SLOP })).toBe(false);
    expect(releasedAsDrag({ x: 100, y: 600 }, { x: 100, y: 600 + TAP_SLOP + 1 })).toBe(true);
    expect(releasedAsDrag({ x: 100, y: 600 }, { x: 100, y: 560 })).toBe(true);
  });

  it('never treats a press with no touch-down, such as a screen reader activation, as a drag', () => {
    expect(releasedAsDrag(null, { x: 0, y: 0 })).toBe(false);
  });

  it('lifts an action just far enough to clear the keyboard with its margin', () => {
    expect(keyboardLiftOffset({ actionBottom: 630, keyboardTop: 600, margin: 16 })).toBe(46);
    expect(keyboardLiftOffset({ actionBottom: 584, keyboardTop: 600, margin: 16 })).toBe(0);
    expect(keyboardLiftOffset({ actionBottom: 350, keyboardTop: 600, margin: 16 })).toBe(0);
    expect(keyboardLiftOffset({ actionBottom: 600.4, keyboardTop: 600, margin: 16 })).toBe(17);
  });
});
