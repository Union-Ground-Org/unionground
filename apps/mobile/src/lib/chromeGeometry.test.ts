import { describe, expect, it } from 'vitest';

import {
  CHROME_CLEARANCE,
  CONTENT_START_OFFSET,
  FLOATING_CONTROL_GUTTER,
  FLOATING_CONTROL_HIT_HEIGHT,
  FLOATING_CONTROL_HIT_WIDTH,
  FLOATING_CONTROL_LIFT,
  FLOATING_CONTROL_LIFT_FALLBACK,
  FLOATING_CONTROL_SIZE,
  FROSTED_BACKING_BLUR,
  FROSTED_BACKING_OPACITY,
  HAT_MENU_GAP,
  HAT_MENU_ROW_HEIGHT,
  HAT_MENU_WIDTH,
  HAT_TAB_ROOT_PATHS,
  NATIVE_TAB_ROOT_PATHS,
  PILL_SHEEN_CYCLE_MS,
  SCREEN_BOTTOM_GAP,
  type HatPillPlacement,
  anchoredComposerLift,
  contentStartInset,
  floatingControlDeliverableHitHeight,
  floatingControlHitHeight,
  floatingControlHitInset,
  floatingControlHitOverrun,
  floatingControlTop,
  hasFloatingHatChrome,
  ANDROID_NATIVE_TAB_BAR_HEIGHT,
  IOS_NATIVE_TAB_BAR_HEIGHT,
  hatMenuBottomInset,
  hatMenuMaxHeight,
  hatMenuTop,
  hatPillPlacementForPath,
  androidMinimizedHomeReserve,
  homeHandleDrawnSpan,
  homeContentBottomInset,
  keyboardOverlapWithinScene,
  nativeHeaderContentInset,
  PINNED_ROW_BACKING_GAP,
  PINNED_ROW_CONTENT_GAP,
  PINNED_TITLE_LINE_HEIGHT,
  PINNED_TITLE_TEXT_CAP,
  PINNED_TITLE_FONT_SIZE,
  pinnedTitleScale,
  pinnedRowBackingHeight,
  pinnedRowBottom,
  pinnedRowContentInset,
  pinnedTitleLeft,
  pinnedTitleLineEstimate,
  pinnedTitleRight,
  pinnedTitleTop,
  nativeTabGestureBandTop,
  nativeTabContentInset,
  quickActionsGestureBandTop,
  screenBottomInset,
} from './chromeGeometry';
import { pinnedHeaderLayout } from './pinnedHeaderOrder';
import { minimumTouchTarget, spacing } from '../theme/tokens';

// Every floating control is the same height now (HatSwitcher.tsx's PILL_HEIGHT
// and PinnedHeader.tsx's back circle both take it from the shared constant).
const PILL_HEIGHT = FLOATING_CONTROL_SIZE;
// The 16e the October 9 captures came from, at Display Zoom "Larger Text".
const IPHONE_16E_SAFE_AREA_TOP = 47;

// Numeric contract for the shared chrome inset math (review finding: the
// source-string suite never executed these functions).
describe('chrome geometry', () => {
  it.each([
    { platform: 'android', inset: 0, want: 84 },
    { platform: 'android', inset: 24, want: 108 },
    { platform: 'android', inset: 48, want: 132 },
    { platform: 'ios', inset: 34, want: 66 },
  ])('clears Home controls at its finite end on $platform with inset $inset', ({ platform, inset, want }) => {
    // Android paints a 64pt tab bar or a 48pt Home control 24pt above the
    // system inset. Content owes the taller occupied band 12pt clearance.
    expect(homeContentBottomInset(inset, platform, 24, 48)).toBe(want);
  });

  it('reserves the full tab bar when it is taller than the minimized control', () => {
    expect(homeContentBottomInset(24, 'android', 0, 48)).toBe(100);
  });

  it('keeps minimized Android Home content above the tab host hit band', () => {
    expect(androidMinimizedHomeReserve(24, 24, 48)).toBe(homeContentBottomInset(24, 'android', 24, 48));
    expect(androidMinimizedHomeReserve(24, 24, 48)).toBeGreaterThan(24 + 64);
    expect(androidMinimizedHomeReserve(24, 24, 48)).toBeGreaterThan(24 + 24 + 48);
  });

  it('keeps the drawer handles on their reserved row and clips them to the shortened Home box', () => {
    // BUG-UG-NATIVE-ANDROID-PINNED-HOME-HANDLES-COVER-DESK-CARDS-20261109:
    // a row below the box is never lifted onto the card above it.
    const reserve = androidMinimizedHomeReserve(24, 24, 48);
    const box = 2000 - reserve;
    for (const offset of [0, 40, 400, 900, 1300]) {
      const span = homeHandleDrawnSpan(offset, 1900, box, 48);
      const rowTop = 1900 - offset;
      if (rowTop >= box) {
        expect(span).toBeNull();
      } else {
        expect(span?.top).toBe(Math.max(0, rowTop));
        expect(span?.bottom).toBe(Math.min(box, rowTop + 48));
      }
    }
    // A row straddling the box edge draws only its part inside the box, which
    // ends above the band the hidden tab host can still hit.
    expect(homeHandleDrawnSpan(1900 - box + 20, 1900, box, 48)).toEqual({ top: box - 20, bottom: box });
    // An unmeasured row or box is left on its row, unclipped.
    expect(homeHandleDrawnSpan(40, 0, 700, 48)).toEqual({ top: -40, bottom: 8 });
    expect(homeHandleDrawnSpan(40, 900, 0, 48)).toEqual({ top: 860, bottom: 908 });
  });

  it('does not reserve a second tab bar inside a native-tab scene', () => {
    expect(nativeTabContentInset()).toBe(SCREEN_BOTTOM_GAP);
  });

  it('reserves exactly the native platform tab band for root edge gestures', () => {
    expect(nativeTabGestureBandTop(844, 34, 'ios')).toBe(761);
    expect(nativeTabGestureBandTop(900, 24, 'android')).toBe(812);
    expect(nativeTabGestureBandTop(40, 34, 'ios')).toBe(0);
  });

  it('reserves only the system safe area outside native-tab scenes', () => {
    expect(quickActionsGestureBandTop(844, 34, 'ios', true)).toBe(761);
    expect(quickActionsGestureBandTop(844, 34, 'ios', false)).toBe(810);
    expect(quickActionsGestureBandTop(900, 24, 'android', false)).toBe(876);
  });

  it('removes scene chrome already below an anchored keyboard composer', () => {
    expect(keyboardOverlapWithinScene(336, 83)).toBe(253);
    expect(keyboardOverlapWithinScene(336, 0)).toBe(336);
    expect(keyboardOverlapWithinScene(20, 83)).toBe(0);
  });

  it('keeps an unhosted drawer composer above the home indicator at rest', () => {
    expect(anchoredComposerLift(0, 0, 34, 12, 8)).toBe(46);
    expect(anchoredComposerLift(336, 0, 34, 12, 8)).toBe(344);
    expect(anchoredComposerLift(336, 83, 0, 12, 8)).toBe(261);
  });

  it('starts content on one line on every device', () => {
    // One formula, not the seven the record inventoried: safe-area top + 28.
    // No ramp is drawn above it any more (owner ruling, Nov 22-23, 2026, #9607).
    for (const safeAreaTop of [0, 20, IPHONE_16E_SAFE_AREA_TOP, 59]) {
      expect(contentStartInset(safeAreaTop)).toBe(safeAreaTop + CONTENT_START_OFFSET);
    }
  });

  it('moves the start line below a retained native header, never above the one line', () => {
    // BUG-UG-NATIVE-INVITE-HEADING-UNDER-BACK-ARROW-20261102.
    const pixel7Top = 136 / (420 / 160);
    expect(nativeHeaderContentInset(contentStartInset(pixel7Top), 56 + pixel7Top)).toBe(56 + pixel7Top + CHROME_CLEARANCE);
    expect(nativeHeaderContentInset(contentStartInset(47), 44 + 47)).toBe(44 + 47 + CHROME_CLEARANCE);
    expect(nativeHeaderContentInset(contentStartInset(47), 0)).toBe(contentStartInset(47));
  });

  it('keeps the frosted capsule and the sheen on the recorded values', () => {
    expect(FROSTED_BACKING_OPACITY).toBeCloseTo(0.74);
    expect(FROSTED_BACKING_BLUR).toBe(14);
    expect(PILL_SHEEN_CYCLE_MS).toBe(9000);
  });

  it('never lets the non-dock bottom inset collapse onto the page padding', () => {
    // Home-indicator device: safe area plus the resting gap, unchanged.
    expect(screenBottomInset(34)).toBe(34 + SCREEN_BOTTOM_GAP);
    // The pass-4 case: a device reporting no bottom inset used to fall back to
    // the page's own 32px padding, putting the last line on the physical edge.
    expect(screenBottomInset(0)).toBe(CHROME_CLEARANCE + SCREEN_BOTTOM_GAP);
    expect(screenBottomInset(0)).toBeGreaterThan(SCREEN_BOTTOM_GAP);
    for (const bottom of [0, 8, 20, 34, 48]) {
      expect(screenBottomInset(bottom)).toBeGreaterThanOrEqual(bottom + CHROME_CLEARANCE);
    }
  });

  describe('hat switcher placement', () => {
    const placements: Array<[string | null | undefined, HatPillPlacement]> = [
      ['/home', 'floating'],
      ['/messages', 'pinned-trailing'],
      ['/pulse', 'pinned-trailing'],
      ['/campaign', 'pinned-trailing'],
      ['/work', 'floating'],
      ['/work/', 'floating'],
      ['/compass', 'pinned-trailing'],
      ['/campaign', 'pinned-trailing'],
      ['/account', 'pinned-trailing'],
      ['/account/', 'pinned-trailing'],
      ['/notifications', 'pinned-trailing'],
      ['/feature/dues', 'pinned-trailing'],
      ['/conversation/abc', 'pinned-trailing'],
      ['/public/chapters/harborview', 'pinned-trailing'],
      ['/legal/privacy', 'pinned-trailing'],
      // An unresolved router is a tab-root default, never a hidden switcher.
      [null, 'floating'],
      [undefined, 'floating'],
      ['', 'floating'],
    ];

    it.each(placements)('places the switcher for %s as %s', (path, want) => {
      expect(hatPillPlacementForPath(path)).toBe(want);
    });

    it('never hides the switcher: every route resolves to one of two placements', () => {
      for (const path of ['/', '/swipe', '/share-intake', '/channel/1', ...NATIVE_TAB_ROOT_PATHS]) {
        expect(['floating', 'pinned-trailing']).toContain(hatPillPlacementForPath(path));
      }
    });

    it.each([['preview', null], ['authenticated', 'member'], ['authenticated', 'steward']])(
      'keeps centered roots and compact pushed placement in %s with hat %s', (mode, hat) => {
        expect(hasFloatingHatChrome(mode, hat)).toBe(true);
        expect(NATIVE_TAB_ROOT_PATHS).toEqual(['/home', '/work', '/compass', '/campaign', '/account']);
        expect(HAT_TAB_ROOT_PATHS).toEqual(['/home', '/work']);
        for (const path of HAT_TAB_ROOT_PATHS) expect(hatPillPlacementForPath(path)).toBe('floating');
        for (const path of ['/compass', '/campaign', '/account', '/messages']) expect(hatPillPlacementForPath(path)).toBe('pinned-trailing');
      },
    );

    it('reserves the SAMPLE band exactly where a hat can be worn', () => {
      expect(hasFloatingHatChrome('preview', null)).toBe(true);
      expect(hasFloatingHatChrome('authenticated', 'steward')).toBe(true);
      // A live account has no sample hat and never gets the band or a switcher.
      expect(hasFloatingHatChrome('authenticated', null)).toBe(false);
      expect(hasFloatingHatChrome('authenticated', undefined)).toBe(false);
      expect(hasFloatingHatChrome('signedOut', 'steward')).toBe(false);
      expect(hasFloatingHatChrome('mfaRequired', 'steward')).toBe(false);
    });

    it('floats every control the same distance above the safe-area line', () => {
      for (const safeAreaTop of [IPHONE_16E_SAFE_AREA_TOP, 59]) {
        const top = floatingControlTop(safeAreaTop, spacing.xs);
        expect(top).toBe(safeAreaTop - FLOATING_CONTROL_LIFT);
        // It overlaps the status-bar frame by exactly the lift, hit area
        // included, and on the 16e (notch bottom near 34pt) clears the notch.
        expect(safeAreaTop - top).toBe(FLOATING_CONTROL_LIFT);
        // The capsule's bottom edge stays 10pt above the content start line.
        expect(contentStartInset(safeAreaTop) - (top + FLOATING_CONTROL_SIZE)).toBe(10);
        // The tap target starts at the control's own top edge, never above it.
        // The 8pt of it above the safe-area line belongs to the status bar,
        // which takes the tap on both platforms, so that overlap is added to
        // the band: 56pt from the control top, of which the 48pt touch
        // minimum sits below the safe-area line, ending 20pt past the content
        // start line over the title text
        // (BUG-UG-NATIVE-TOUCH-TARGETS-UNDER-48PX-20261019, measured
        // at 36pt / 36.2dp on the iPhone 16e and the Pixel 10a).
        const hit = floatingControlHitHeight(safeAreaTop, top);
        expect(hit).toBe(minimumTouchTarget + FLOATING_CONTROL_LIFT);
        expect(floatingControlDeliverableHitHeight(safeAreaTop, top)).toBe(minimumTouchTarget);
        expect(top + hit).toBe(safeAreaTop + minimumTouchTarget);
        expect(floatingControlHitOverrun(safeAreaTop, top)).toBe(minimumTouchTarget - CONTENT_START_OFFSET);
        expect(floatingControlHitOverrun(safeAreaTop, top)).toBe(20);
      }
      // The 4pt fallback, applied to all three controls together if the device
      // check shows the status bar taking taps on the overlap: the band is
      // 52pt, the deliverable part is still 48pt below the safe-area line, and
      // the bottom edge is the same safe-area + 48.
      const fallback = floatingControlTop(59, spacing.xs, FLOATING_CONTROL_LIFT_FALLBACK);
      expect(fallback).toBe(59 - FLOATING_CONTROL_LIFT_FALLBACK);
      expect(floatingControlHitHeight(59, fallback)).toBe(minimumTouchTarget + FLOATING_CONTROL_LIFT_FALLBACK);
      expect(floatingControlDeliverableHitHeight(59, fallback)).toBe(minimumTouchTarget);
      expect(floatingControlHitOverrun(59, fallback)).toBe(20);
      // A device with no top inset still leaves the control off the physical edge.
      expect(floatingControlTop(0, spacing.xs)).toBe(spacing.xs);
      expect(floatingControlTop(4, spacing.xs)).toBe(spacing.xs);
    });

    it('never lets a floating tap target measure under the 48pt touch minimum', () => {
      // The regression the record asks for: the hat pill (floating and
      // compact) and the pushed-screen Back control share this band, so one
      // sweep over every plausible top inset covers all three on both
      // platforms. The constant is the repository minimum, not a local one.
      expect(FLOATING_CONTROL_HIT_HEIGHT).toBe(minimumTouchTarget);
      expect(FLOATING_CONTROL_HIT_WIDTH).toBe(minimumTouchTarget);
      for (let safeAreaTop = 0; safeAreaTop <= 70; safeAreaTop += 1) {
        for (const lift of [FLOATING_CONTROL_LIFT, FLOATING_CONTROL_LIFT_FALLBACK]) {
          const top = floatingControlTop(safeAreaTop, spacing.xs, lift);
          const hit = floatingControlHitHeight(safeAreaTop, top);
          expect(hit).toBeGreaterThanOrEqual(minimumTouchTarget);
          // The measured answer to the status-bar overlap: whatever the lift,
          // the part of the band below the safe-area line, which is the only
          // part a tap can reach, is the full minimum.
          expect(floatingControlDeliverableHitHeight(safeAreaTop, top)).toBe(minimumTouchTarget);
          expect(top + hit).toBe(Math.max(safeAreaTop, top) + minimumTouchTarget);
          // Layout bounds and effective area are the same thing here: there is
          // no hitSlop, so the band the device tree reports is the tap area.
          expect(top).toBeGreaterThanOrEqual(spacing.xs);
          // The painted control stays inside its band, at the top.
          expect(hit).toBeGreaterThanOrEqual(FLOATING_CONTROL_SIZE);
          // The band never swallows the first actionable row: Home's buttons
          // start 24pt below the content start line and every pushed title is
          // text. The overrun is 20pt on any phone with a status bar, at either
          // lift; only a device with no top inset at all (the control floored
          // at 4pt) reaches 24.
          expect(floatingControlHitOverrun(safeAreaTop, top)).toBe(safeAreaTop >= spacing.xs ? 20 : 24 - safeAreaTop);
          expect(floatingControlHitOverrun(safeAreaTop, top)).toBeLessThan(24 + 1);
        }
      }
    });

    it('keeps every floating tap target 48pt wide and clear of the other gutter', () => {
      // The painted control sits FLOATING_CONTROL_GUTTER in; its 48pt target is
      // centred on it, so the target's own edge is 1pt from the screen edge.
      expect(floatingControlHitInset()).toBe(FLOATING_CONTROL_GUTTER - (FLOATING_CONTROL_HIT_WIDTH - FLOATING_CONTROL_SIZE) / 2);
      expect(floatingControlHitInset()).toBe(1);
      expect(pinnedHeaderLayout.hitInset).toBe(floatingControlHitInset());
      expect(pinnedHeaderLayout.edgeGutter).toBe(FLOATING_CONTROL_GUTTER);
      // Back circle at the left gutter, compact capsule at the right: at the
      // narrowest supported width they still cannot overlap.
      for (const width of [320, 393]) {
        const backRight = floatingControlHitInset() + FLOATING_CONTROL_HIT_WIDTH;
        const compactLeft = width - floatingControlHitInset() - FLOATING_CONTROL_HIT_WIDTH;
        expect(compactLeft).toBeGreaterThan(backRight);
      }
    });

    it('anchors the dropdown below the pill and never off the screen', () => {
      const top = floatingControlTop(59, spacing.xs);
      const menuTop = hatMenuTop(top, PILL_HEIGHT);
      expect(menuTop).toBe(top + PILL_HEIGHT + HAT_MENU_GAP);
      // Rows exceed the repository 48pt touch minimum.
      expect(HAT_MENU_ROW_HEIGHT).toBeGreaterThanOrEqual(minimumTouchTarget);
      // A 375pt phone leaves room for the fixed menu width plus margins.
      expect(HAT_MENU_WIDTH).toBeLessThanOrEqual(375 * 0.92);

      expect(hatMenuMaxHeight(844, menuTop, 34, spacing.xl)).toBe(844 - menuTop - 34 - spacing.xl);
      expect(menuTop + hatMenuMaxHeight(844, menuTop, 34, spacing.xl)).toBeLessThanOrEqual(844 - 34);
      // Reserving three rows would push the menu below this window's safe area.
      expect(hatMenuMaxHeight(280, menuTop, 34, spacing.xl)).toBe(280 - menuTop - 34 - spacing.xl);
      expect(hatMenuMaxHeight(60, menuTop, 34, spacing.xl)).toBe(0);
      // On a tab screen the menu stops above the tab bar, and only there.
      expect(hatMenuBottomInset(34, 'ios', true)).toBe(34 + IOS_NATIVE_TAB_BAR_HEIGHT);
      expect(hatMenuBottomInset(24, 'android', true)).toBe(24 + ANDROID_NATIVE_TAB_BAR_HEIGHT);
      expect(hatMenuBottomInset(34, 'ios', false)).toBe(34);
      expect(menuTop + hatMenuMaxHeight(844, menuTop, hatMenuBottomInset(34, 'ios', true), spacing.xl)).toBeLessThanOrEqual(nativeTabGestureBandTop(844, 34, 'ios'));
    });
  });

  // UX-UG-NATIVE-TITLE-BESIDE-BACK-CONTROL-20261115: the title on one
  // row beside the back control, on both phones.
  describe('pushed-screen title row', () => {
    // iPhone 17 (402pt, safe area 62) and Pixel 10 (412pt, status bar 24ish).
    const phones = [
      { name: 'iPhone 17', width: 402, safeTop: 62 },
      { name: 'iPhone 16e', width: 375, safeTop: IPHONE_16E_SAFE_AREA_TOP },
      { name: 'Pixel 10', width: 412, safeTop: 24 },
      { name: 'no inset', width: 320, safeTop: 0 },
    ];

    it('puts the title just past the back target and clear of the hat capsule column', () => {
      const backTargetRight = floatingControlHitInset() + FLOATING_CONTROL_HIT_WIDTH;
      expect(pinnedTitleLeft(true)).toBeGreaterThan(backTargetRight);
      expect(pinnedTitleLeft(true)).toBe(53);
      expect(pinnedTitleLeft(false)).toBe(16);
      expect(pinnedTitleRight()).toBe(68);
      for (const phone of phones) {
        // The compact capsule's 48pt column at the right gutter (HatSwitcher
        // `anchorTrailing`) is never under the title.
        const capsuleLeft = phone.width - pinnedHeaderLayout.trailingInset - FLOATING_CONTROL_HIT_WIDTH;
        expect(phone.width - pinnedTitleRight(), phone.name).toBeLessThan(capsuleLeft);
        // And there is still a title's worth of room between them.
        expect(phone.width - pinnedTitleRight() - pinnedTitleLeft(true), phone.name).toBeGreaterThanOrEqual(180);
      }
    });

    it('centres the first title line on the back circle at the default size and grows downwards', () => {
      for (const phone of phones) {
        const top = floatingControlTop(phone.safeTop, spacing.xs);
        const titleTop = pinnedTitleTop(top);
        expect(titleTop + PINNED_TITLE_LINE_HEIGHT / 2).toBe(top + FLOATING_CONTROL_SIZE / 2);
        // A taller title never moves the top edge: it grows down the row.
        expect(pinnedRowBottom(phone.safeTop, spacing.xs, PINNED_TITLE_LINE_HEIGHT * 2 * PINNED_TITLE_TEXT_CAP))
          .toBe(titleTop + PINNED_TITLE_LINE_HEIGHT * 2 * PINNED_TITLE_TEXT_CAP);
      }
    });

    it('scales the font and the line together, up to the cap', () => {
      // The cap and the page scale as written numbers, not read back.
      expect(PINNED_TITLE_TEXT_CAP).toBe(1.6);
      expect(PINNED_TITLE_FONT_SIZE).toBe(22);
      expect(PINNED_TITLE_LINE_HEIGHT).toBe(28);
      expect(PINNED_TITLE_FONT_SIZE * pinnedTitleScale(2)).toBeCloseTo(35.2, 5);
      expect(PINNED_TITLE_LINE_HEIGHT * pinnedTitleScale(2)).toBeCloseTo(44.8, 5);
      expect(pinnedTitleLineEstimate(2)).toBeCloseTo(44.8, 5);
      expect(pinnedTitleScale(1)).toBe(1);
      expect(pinnedTitleScale(1.35)).toBe(1.35);
      // Android's largest (2.0) and beyond stop at the cap, line height included.
      expect(pinnedTitleScale(2)).toBe(PINNED_TITLE_TEXT_CAP);
      expect(pinnedTitleScale(3.2)).toBe(PINNED_TITLE_TEXT_CAP);
      expect(pinnedTitleScale(Number.NaN)).toBe(1);
    });

    it('sizes one line by the text size, up to the cap', () => {
      expect(pinnedTitleLineEstimate(1)).toBe(28);
      expect(pinnedTitleLineEstimate(1.3)).toBeCloseTo(36.4);
      expect(pinnedTitleLineEstimate(3.1)).toBeCloseTo(28 * PINNED_TITLE_TEXT_CAP);
      expect(pinnedTitleLineEstimate(Number.NaN)).toBe(28);
      expect(pinnedTitleLineEstimate(0)).toBe(28);
    });

    it('starts the content below the whole row: the back band and the title', () => {
      for (const phone of phones) {
        const top = floatingControlTop(phone.safeTop, spacing.xs);
        const bandBottom = top + floatingControlHitHeight(phone.safeTop, top);
        // On a phone with a status bar, one or two lines at the default size
        // sit inside the back band; with no top inset at all a second line
        // runs below it and takes the row with it.
        if (phone.safeTop > 0) expect(pinnedTitleTop(top) + PINNED_TITLE_LINE_HEIGHT * 2).toBeLessThanOrEqual(bandBottom);
        for (const lines of [0, 1, 2]) {
          const titleHeight = PINNED_TITLE_LINE_HEIGHT * lines;
          const rowBottom = Math.max(bandBottom, lines ? pinnedTitleTop(top) + titleHeight : 0);
          expect(pinnedRowBottom(phone.safeTop, spacing.xs, titleHeight), phone.name).toBe(rowBottom);
          const inset = pinnedRowContentInset(phone.safeTop, spacing.xs, titleHeight);
          expect(inset, phone.name).toBe(rowBottom + PINNED_ROW_CONTENT_GAP);
          // The back target's tap band never reaches the first line of content.
          expect(inset).toBeGreaterThan(bandBottom);
          expect(inset).toBeGreaterThanOrEqual(contentStartInset(phone.safeTop));
        }
        // Two lines at the largest size push the content down with them.
        const tall = PINNED_TITLE_LINE_HEIGHT * 2 * PINNED_TITLE_TEXT_CAP;
        const titleBottom = pinnedTitleTop(top) + tall;
        expect(titleBottom).toBeGreaterThan(bandBottom);
        expect(pinnedRowContentInset(phone.safeTop, spacing.xs, tall)).toBe(titleBottom + PINNED_ROW_CONTENT_GAP);
        // The backing covers the row and ends above the content.
        const backing = pinnedRowBackingHeight(phone.safeTop, spacing.xs, tall);
        expect(backing).toBe(titleBottom + PINNED_ROW_BACKING_GAP);
        expect(backing).toBeLessThan(pinnedRowContentInset(phone.safeTop, spacing.xs, tall));
      }
      // The page's numbers on the iPhone 17: a 56pt row under the status bar,
      // then 8pt, so content starts 64pt below the safe-area line.
      expect(pinnedRowContentInset(62, spacing.xs, PINNED_TITLE_LINE_HEIGHT)).toBe(62 + 64);
      expect(pinnedRowBackingHeight(62, spacing.xs, PINNED_TITLE_LINE_HEIGHT)).toBe(62 + 56);
    });
  });
});
