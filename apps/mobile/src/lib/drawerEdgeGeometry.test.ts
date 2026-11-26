import { describe, expect, it } from 'vitest';

import { continuousRadius, drawerFrame, interactiveDrawer, straightRailInsets, type OpenDrawer } from './drawerEdgeGeometry';

const SETTLED_SIDES: OpenDrawer[] = ['features', 'work'];
const VISIBLE_SIDES: OpenDrawer[] = ['features', 'work', null];


describe('atomic drawer render samples', () => {
  it('keeps translation, active side, opacity and the corner radius coherent through reversals', () => {
    for (const x of [300, 150, 1, 0.1, 0, -0.1, -1, -150, -300, -150, 0, 150, 300]) {
      const frame = drawerFrame(x, 300, 44);
      expect(frame.x).toBe(x);
      expect(frame.featuresProgress * frame.workProgress).toBe(0);
      expect(frame.reveal).toBe(Math.abs(x) / 300);
      expect(frame.radius).toBe(frame.reveal * 44);
      expect(frame.featureRadius + frame.workRadius).toBe(frame.radius);
      expect(frame.side).toBe(x > 0 ? 'features' : x < 0 ? 'work' : null);
    }
    expect(drawerFrame(150, 300, 44).radius).toBe(22);
    expect(drawerFrame(50, 0, 44)).toMatchObject({ x: 0, radius: 0, side: null });
  });

  it('never gives an invisible or moving drawer input or accessibility ownership', () => {
    for (const settled of SETTLED_SIDES) {
      for (const visible of VISIBLE_SIDES) {
        expect(interactiveDrawer(visible, settled, true)).toBeNull();
        expect(interactiveDrawer(visible, settled, false)).toBe(visible === settled ? settled : null);
      }
    }
    expect(interactiveDrawer(null, null, false)).toBeNull();
  });
});

describe('straight widget rail', () => {
  it('places square ends beyond both corner arcs rather than spanning the rounded clip', () => {
    for (const radius of [8, 12, 16, 24]) {
      const rail = straightRailInsets(radius);
      expect(rail.top).toBeGreaterThanOrEqual(radius);
      expect(rail.bottom).toBeGreaterThanOrEqual(radius);
      const cardHeight = 96;
      expect(cardHeight - rail.bottom).toBeLessThanOrEqual(cardHeight - radius);
      expect(cardHeight - rail.top - rail.bottom).toBeGreaterThan(0);
    }
  });
});

describe('continuousRadius', () => {
  it('tracks continuous progress without four-point rounding', () => {
    expect(continuousRadius(0, 44)).toBe(0);
    expect(continuousRadius(1, 44)).toBe(44);
    expect(continuousRadius(1.4, 44)).toBe(44);
    // Mid-drag radii must match the sheet, including non-integral values.
    expect(continuousRadius(0.45, 44)).toBeCloseTo(19.8);
    expect(continuousRadius(0.5, 44)).toBe(22);
    expect(continuousRadius(0.9, 44)).toBeCloseTo(39.6);
    expect(continuousRadius(Number.NaN, 44)).toBe(0);
  });
});
