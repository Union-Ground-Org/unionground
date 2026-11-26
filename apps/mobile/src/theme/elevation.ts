import type { ViewStyle } from 'react-native';

import palette from './palette.json';

// The single elevation system required by the "Native depth and
// responsiveness contract" and visual-language brief §A. Every shadow in the
// app comes from here; screens must not declare their own shadow constants.
//
// Hues are taken from the Union Ground palette, never invented. Elevation
// geometry stays stable while surface colors change.
const groundGreen = palette['union-ground'].primary;
const ink = palette['union-ground'].foreground;
const gold = palette['union-ground'].accent;

export type ElevationToken = Pick<
  ViewStyle,
  'shadowColor' | 'shadowOffset' | 'shadowOpacity' | 'shadowRadius' | 'elevation'
>;

// Level 0 — page canvas and grouped lists. Never shadowed.
export const level0: ElevationToken = {
  shadowColor: 'transparent',
  shadowOffset: { width: 0, height: 0 },
  shadowOpacity: 0,
  shadowRadius: 0,
  elevation: 0,
};

// Level 1 — standard cards and rows: contact shadow only, no ambient blur.
export const level1: ElevationToken = {
  shadowColor: groundGreen,
  shadowOffset: { width: 0, height: 1 },
  shadowOpacity: 0.05,
  shadowRadius: 2,
  elevation: 1,
};

// Level 1 hero — the single hero card on a surface adds one soft ambient pass.
export const level1Hero: ElevationToken = {
  shadowColor: groundGreen,
  shadowOffset: { width: 0, height: 8 },
  shadowOpacity: 0.06,
  shadowRadius: 24,
  elevation: 3,
};

// Level 2 — floating controls: composer, dock, filter pills, FAB, Tools.
export const level2: ElevationToken = {
  shadowColor: groundGreen,
  shadowOffset: { width: 0, height: 12 },
  shadowOpacity: 0.08,
  shadowRadius: 32,
  elevation: 6,
};

// Hero lift — the p1-wave2a P2 disposition on b02a-17. Pixel sampling found the
// briefed hero pass casting only 2-3 RGB steps of underside ramp above the
// contact rows beside it, so the hierarchy was being carried by scale and
// typography rather than by depth. The disposition offered "one blur step or a
// 1px top edge highlight"; a white card on porcelain has nothing lighter than
// its own fill to draw a highlight with, so the ladder's own answer is the blur
// step.
//
// Every value is still a ladder value: the hero keeps its own 8px offset and 6%
// opacity — the two numbers the brief §A pins — and takes only the next rung's
// blur radius. It therefore stays strictly quieter than a floating control
// (which is 12px down at 8%) while the falloff finally reads.
export const level1HeroLift: ElevationToken = {
  ...level1Hero,
  shadowRadius: level2.shadowRadius,
  // Android has no blur channel, so the depth cue there is the one step of
  // elevation between the hero (3) and a floating control (6).
  elevation: 4,
};

// The dock is the one level-2 surface that reads on a dark fill, so it carries
// the ink variant instead of the aubergine ambient pass.
export const dockShadow: ElevationToken = {
  shadowColor: ink,
  shadowOffset: { width: 0, height: 10 },
  shadowOpacity: 0.22,
  shadowRadius: 24,
  elevation: 8,
};

// Level 3 — Home overlay, drawers, bottom sheets, menus: wide soft shadow.
export const level3: ElevationToken = {
  shadowColor: ink,
  shadowOffset: { width: 0, height: 18 },
  shadowOpacity: 0.18,
  shadowRadius: 40,
  elevation: 12,
};

// Pressed = compress (scale + shadow soften). Selected/focused = slight lift.
export const pressedScale = 0.98;
export const selectionLift = { translateY: -2, scale: 1.01 } as const;

// The softened pass a pressed level-1 surface drops to.
export const pressedShadow: ElevationToken = {
  shadowColor: groundGreen,
  shadowOffset: { width: 0, height: 0 },
  shadowOpacity: 0.03,
  shadowRadius: 1,
  elevation: 0,
};

// The Compass FAB's deliberate gold glow — a colored level-2 accent, not an
// ambient elevation pass. Named here so no screen carries a one-off literal.
export const fabGlow: ElevationToken = {
  shadowColor: gold,
  shadowOpacity: 0.45,
  shadowRadius: 15,
  shadowOffset: { width: 0, height: 14 },
  elevation: 12,
};

// BUG-UG-NATIVE-HOME-DRAWER-FRAME-SEAMS-20261102: a level-3 surface
// that slides over another (the Home sheet over an open drawer) casts its
// shadow only as far as it has moved: none at rest, the full pass when open.
// A side reveal turns the token's drop sideways, toward the uncovered drawer,
// the rotation QuickActionsDrawer applies.
export function revealedShadow(token: ElevationToken, reveal: number, side?: 'left' | 'right'): ElevationToken {
  const bounded = Math.max(0, Math.min(1, Number.isFinite(reveal) ? reveal : 0));
  const drop = token.shadowOffset?.height ?? 0;
  const shadowOffset = side ? { width: side === 'left' ? -drop : drop, height: 0 } : token.shadowOffset;
  return { ...token, shadowOffset, shadowOpacity: Number(token.shadowOpacity ?? 0) * bounded, elevation: bounded > 0 ? token.elevation : 0 };
}

export const elevation = {
  level0,
  level1,
  level1Hero,
  level1HeroLift,
  level2,
  dockShadow,
  level3,
  pressedShadow,
  fabGlow,
} as const;
