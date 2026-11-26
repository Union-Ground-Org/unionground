import { FLOATING_CONTROL_GUTTER, FLOATING_CONTROL_HIT_WIDTH, floatingControlHitInset } from './chromeGeometry';

// The pinned header's accessibility geometry, and a model of the order a screen
// reader walks it in. The math lives here, outside the component (the
// chromeGeometry.ts pattern), so a test can execute the real numbers without
// React Native.
//
// A11Y-UG-MOBILE-VOICEOVER-PINNED-HEADER-FOCUS-ORDER-20260913 — what the
// 2026-09-18 iPhone captures actually prove, stated no more strongly than that:
//
//  1. **Tree order is not source order.** Build `7afda61a6` already rendered the
//     title slot before the back control in JSX (PR #2017), and the accessibility
//     hierarchy XCUITest reported for the header container is still
//     `leading, trailing, titleSlot`. The reorder changed nothing the device
//     reads. That alone keeps the record open.
//  2. **We are on UIKit's automatic path and cannot leave it.** Apple documents
//     exactly one ordering guarantee — `accessibilityElements`, whose array order
//     is the order VoiceOver reads. React Native's iOS renderer never sets that
//     array and exposes no prop for it, and this repo never sets it either. The
//     automatic order is *observed*, not specified, so the element's frame is the
//     only lever available.
//  3. **The rule that fits the retained evidence** is: band sibling elements by
//     their top edge, then read a band in ascending `minX`. It fits the header in
//     both retained captures — `leading(y=59, x=4)` and `trailing(y=59, x=341)`
//     band and sort 4 → 341, and `titleSlot(y=73, x=4)` is a later band — and it
//     also fits the two real-content sibling groups elsewhere in the 15 captures
//     that a naive global `(y, x)` sort does not explain. What the captures do
//     **not** settle is the horizontal rule: a *centre*-based rule is not
//     distinguishable from `minX` by them, because both reproduce
//     `leading, trailing, titleSlot` at every banding tolerance below 14pt. What
//     the captures refute is a tolerance of 14pt or more.
//
//     That leaves one honest gap, and it is worth naming: the new layout leads
//     under `minX` at **any** tolerance, but under a centre rule it leads only
//     below a **2pt** tolerance — between 2pt and 13pt a centre rule would band
//     the two slots and put the chevron's centre first. The Sunday capture is
//     the discriminator: heading-first confirms `minX` (or a sub-2pt tolerance);
//     Back-first with the 2pt margin in place means a centre rule with banding,
//     and the fix needs a different lever (inset the heading slot's `left` so it
//     no longer spans the chevron, and win on the top edge alone).
//
// Note the level the comparison happens at. The captures report the leading
// **slot** at `y=59` and its Back button child at `y=60/61`; iOS sorts the slot,
// not the button. So a heading that is only above the *button* has no margin at
// all. The 52pt bar supplied that margin for free: the heading slot filled the
// bar while the 48pt control slot was centred 2pt down inside it. The bar is
// gone (REQ-UG-MOBILE-TOP-CHROME-PROGRESSIVE-BLUR-FLOATING-PILL-20261010)
// and the band is now exactly the control's own tap target, so the margin is
// declared instead: the heading slot starts `headingSlotLift` above the band
// and spans the screen. The heading still leads on `minX` (0 vs the 48pt tap
// target's 1) *and* on the top edge, which is the only configuration that
// survives either banding tolerance.
//
// Physical `left`/`right` are used throughout, as everywhere else in this app —
// there is no `I18nManager` usage in the repo — so this module models an LTR
// layout and `voiceOverReadingOrder` sorts ascending `x` unconditionally.

export const pinnedHeaderLayout = {
  /** The painted edge of a floating control, inset from the screen edge. */
  edgeGutter: FLOATING_CONTROL_GUTTER,
  /** Left edge of the 48pt tap target centred on that control. */
  hitInset: floatingControlHitInset(),
  /**
   * The compact demo pill paints its whole 48pt width, so its column sits at
   * the painted gutter itself; at the round control's hit inset (1pt) the
   * capsule ran to the screen edge and its ring was cut off (live audit, Nov 8,
   * 2026).
   */
  trailingInset: FLOATING_CONTROL_GUTTER,
  /** The heading slot spans the band, so its frame origin is the band's origin. */
  titleSlotInset: 0,
  /**
   * The heading frame starts this far above the floating control band. The old
   * 52pt bar gave the heading its top-edge margin for free, because the 48pt
   * control slot was centred 2pt down inside it; the band is now only as tall
   * as the control's own tap target, so the margin has to be declared. The slot
   * takes no touches and paints nothing, so reaching 2pt further under the
   * status bar costs nothing.
   */
  headingSlotLift: 2,
} as const;

/**
 * The top inset of a control slot inside its band. The band is sized to the
 * control's tap target now, so this is 0 and the heading's top-edge margin
 * comes from `headingSlotLift`. Kept shared with `styles.leading` so the model
 * cannot drift from the stylesheet.
 */
export function controlSlotTop(bandHeight: number, backTarget: number): number {
  return (bandHeight - backTarget) / 2;
}

export type PinnedHeaderElementKey = 'title' | 'back' | 'trailing';

export type PinnedHeaderElement = {
  key: PinnedHeaderElementKey;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PinnedHeaderLayoutInput = {
  /** Top edge of the floating control band: `floatingControlTop(...)`. */
  bandTop: number;
  /**
   * Height of the band: `floatingControlHitHeight(...)`, which runs from a
   * control's top edge down to the content start line.
   */
  bandHeight: number;
  screenWidth: number;
  /** The control's own tap-target height — the band height today. */
  backTarget: number;
  hasHeading: boolean;
  hasBack: boolean;
  hasTrailing: boolean;
};

/**
 * The **slot** frames the floating controls put on screen, in absolute window
 * coordinates, mirroring `styles` in PinnedHeader.tsx. Slots, not their
 * controls: that is the level the captures show iOS comparing.
 */
export function pinnedHeaderElements(input: PinnedHeaderLayoutInput): PinnedHeaderElement[] {
  const { bandTop, bandHeight, screenWidth, backTarget, hasHeading, hasBack, hasTrailing } = input;
  const { hitInset, titleSlotInset, headingSlotLift } = pinnedHeaderLayout;
  const elements: PinnedHeaderElement[] = [];
  if (hasHeading) {
    elements.push({
      key: 'title',
      x: titleSlotInset,
      y: bandTop - headingSlotLift,
      width: screenWidth - titleSlotInset * 2,
      height: bandHeight + headingSlotLift,
    });
  }
  if (hasBack) {
    // `styles.leading`: the 48pt-wide tap target, bounded above by the circle's
    // own top edge and below by the content start line.
    elements.push({
      key: 'back',
      x: hitInset,
      y: bandTop + controlSlotTop(bandHeight, backTarget),
      width: FLOATING_CONTROL_HIT_WIDTH,
      height: backTarget,
    });
  }
  if (hasTrailing) {
    // `styles.trailing`: the compact pill's bounds, the back circle's width
    // and band, at the right painted gutter.
    elements.push({
      key: 'trailing',
      x: screenWidth - pinnedHeaderLayout.trailingInset - FLOATING_CONTROL_HIT_WIDTH,
      y: bandTop,
      width: FLOATING_CONTROL_HIT_WIDTH,
      height: bandHeight,
    });
  }
  return elements;
}

/**
 * The order the fitted rule produces for a set of frames: band by top edge, then
 * ascending `minX` inside the band. `rowTolerance` is how far two top edges may
 * differ and still band — 0 models no banding at all, and a tolerance of the
 * whole bar height models the most aggressive banding iOS could apply. An
 * element that leads under both leads under anything in between.
 */
export function voiceOverReadingOrder(
  elements: readonly PinnedHeaderElement[],
  rowTolerance = 0,
): PinnedHeaderElementKey[] {
  const byTop = [...elements].sort((left, right) => (left.y - right.y) || (left.x - right.x));
  const bands: PinnedHeaderElement[][] = [];
  for (const element of byTop) {
    const band = bands[bands.length - 1];
    const bandTop = band?.[0];
    if (band && bandTop && element.y - bandTop.y <= rowTolerance) band.push(element);
    else bands.push([element]);
  }
  return bands.flatMap((band) => [...band]
    .sort((left, right) => (left.x - right.x) || (left.y - right.y))
    .map((element) => element.key));
}

/**
 * True when a scene paints the same words the pinned bar already carries. The
 * bar names the surface for a screen reader on every pushed screen, so the
 * scene's own copy of that name has to leave the accessibility tree or the name
 * is announced twice and the rotor's Headings list gains a duplicate entry.
 * Pure, so the rule is testable without React Native.
 */
export function echoesScreenName(text: unknown, screenName: string | null | undefined): boolean {
  if (typeof text !== 'string' || typeof screenName !== 'string') return false;
  const painted = text.trim();
  return painted.length > 0 && painted === screenName.trim();
}
