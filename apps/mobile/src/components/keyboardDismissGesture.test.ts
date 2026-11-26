import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  KEYBOARD_DISMISS_DIRECTION_RATIO,
  KEYBOARD_DISMISS_DISTANCE,
  keyboardDismissModeFor,
  shouldDismissKeyboardFromSwipe,
} from './keyboardDismissGesture';

function read(relative: string) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

describe('swipe-down keyboard dismissal intent', () => {
  it('accepts a deliberate single-finger downward swipe', () => {
    expect(shouldDismissKeyboardFromSwipe({ dx: 0, dy: KEYBOARD_DISMISS_DISTANCE, touchCount: 1 })).toBe(true);
    expect(shouldDismissKeyboardFromSwipe({ dx: 8, dy: 24, touchCount: 1 })).toBe(true);
  });

  it('does not claim taps, jitter, upward drags, or horizontal drawers', () => {
    expect(shouldDismissKeyboardFromSwipe({ dx: 0, dy: KEYBOARD_DISMISS_DISTANCE - 0.1, touchCount: 1 })).toBe(false);
    expect(shouldDismissKeyboardFromSwipe({ dx: 0, dy: -40, touchCount: 1 })).toBe(false);
    expect(shouldDismissKeyboardFromSwipe({ dx: 30, dy: 15, touchCount: 1 })).toBe(false);
    expect(shouldDismissKeyboardFromSwipe({
      dx: 20,
      dy: 20 * KEYBOARD_DISMISS_DIRECTION_RATIO - 0.1,
      touchCount: 1,
    })).toBe(false);
  });

  it('stands down for multi-touch accessibility and system gestures', () => {
    expect(shouldDismissKeyboardFromSwipe({ dx: 0, dy: 40, touchCount: 0 })).toBe(false);
    expect(shouldDismissKeyboardFromSwipe({ dx: 0, dy: 40, touchCount: 2 })).toBe(false);
  });

  it('uses each platform native scroll dismissal mode', () => {
    expect(keyboardDismissModeFor('ios')).toBe('interactive');
    expect(keyboardDismissModeFor('android')).toBe('on-drag');
  });
});

describe('app-wide native keyboard dismissal contract', () => {
  const dismissSurface = read('./SwipeDownKeyboardDismiss.tsx');

  it('observes raw capture movement without taking the responder from app gestures', () => {
    expect(dismissSurface).toContain('onTouchStartCapture');
    expect(dismissSurface).toContain('onTouchMoveCapture');
    expect(dismissSurface).toContain('onTouchEndCapture');
    expect(dismissSurface).toContain('onTouchCancelCapture');
    expect(dismissSurface).toContain('Keyboard.isVisible()');
    expect(dismissSurface).toContain('Keyboard.dismiss()');
    expect(dismissSurface).toContain('dismissedGesture.current = true');
    expect(dismissSurface).not.toContain('PanResponder');
    expect(dismissSurface).not.toContain('onResponderMove');
  });

  it('stands down for screen readers and wraps both navigation and native modal input surfaces', () => {
    expect(dismissSurface).toContain('useScreenReader()');
    expect(read('../../app/_layout.tsx')).toContain('<SwipeDownKeyboardDismiss>');
    expect(read('./ChapterRail.tsx')).toContain('<SwipeDownKeyboardDismiss>');
  });

  it('keeps iOS interactive and Android on-drag behavior on input-bearing scroll surfaces', () => {
    for (const file of ['./ui.tsx', './CompassPanel.tsx', '../../app/conversation/[id].tsx']) {
      expect(read(file), file).toContain('keyboardDismissModeFor(Platform.OS)');
    }
  });
});
