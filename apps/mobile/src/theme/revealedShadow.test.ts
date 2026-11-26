// BUG-UG-NATIVE-HOME-DRAWER-FRAME-SEAMS-20261102 (owner ruling,
// November 3): the Home sheet over an open drawer is a rounded panel with the
// level-3 shadow, no hairline. The shadow grows with the reveal, and the
// panel's edge stays distinct from the drawer behind it in every scheme.
import { describe, expect, it } from 'vitest';

import { contrastRatio } from './contrast';
import { elevation, revealedShadow } from './elevation';
import { radii, resolveTheme, themeKeys, type ThemeKey } from './tokens';

describe('the Home panel shadow', () => {
  it('casts nothing at rest and the full level-3 pass once a drawer is open', () => {
    expect(revealedShadow(elevation.level3, 0)).toMatchObject({ shadowOpacity: 0, elevation: 0 });
    expect(revealedShadow(elevation.level3, 1)).toEqual(elevation.level3);
    const half = revealedShadow(elevation.level3, 0.5);
    expect(half.shadowOpacity).toBeCloseTo(0.09, 5);
    expect(half).toMatchObject({ shadowColor: elevation.level3.shadowColor, shadowRadius: 40, shadowOffset: { width: 0, height: 18 }, elevation: 12 });
  });

  // PR #6950 gate round 1: a side reveal casts toward the uncovered drawer,
  // as QuickActionsDrawer does, not straight down.
  it('turns the level-3 drop sideways toward the open drawer', () => {
    expect(revealedShadow(elevation.level3, 1, 'left').shadowOffset).toEqual({ width: -18, height: 0 });
    expect(revealedShadow(elevation.level3, 1, 'right').shadowOffset).toEqual({ width: 18, height: 0 });
    expect(revealedShadow(elevation.level3, 1).shadowOffset).toEqual({ width: 0, height: 18 });
  });

  it('bounds a reveal outside the gesture range', () => {
    expect(revealedShadow(elevation.level3, 1.4)).toEqual(elevation.level3);
    expect(revealedShadow(elevation.level3, -0.2)).toMatchObject({ shadowOpacity: 0, elevation: 0 });
    expect(revealedShadow(elevation.level3, Number.NaN)).toMatchObject({ shadowOpacity: 0, elevation: 0 });
    expect(revealedShadow(elevation.level0, 1).shadowOpacity).toBe(0);
  });

  it('takes the level-3 rung of the radius ladder', () => {
    expect(radii.sheetRadius).toBe(28);
    expect(radii.sheetRadius).toBeGreaterThan(radii.cardRadius);
  });

  // The panel is the page background; the drawer behind it is muted. With no
  // hairline, the edge reads by that fill step plus the shadow, so the step
  // must never vanish in either scheme.
  // Union Ground follows the device into its dark form (gate round 1 on PR
  // #6950); the golden-hour cosmetic pair is retired (Nov 3, 2026).
  it.each(themeKeys.flatMap((key): [ThemeKey, boolean][] => [[key, false], [key, true]]))('keeps the panel edge distinct from the drawer (%s, dark %s)', (key, dark) => {
    const theme = resolveTheme(key, dark);
    // This edition's light palette is public main's brand palette
    // (#F6F2E9 on #E2ECE7, about 1.08); its step stays above 1.05 and the
    // shadow carries the rest. Changing the brand colours is a design call.
    expect(contrastRatio(theme.background, theme.muted)).toBeGreaterThanOrEqual(dark ? 1.1 : 1.05);
  });
});
