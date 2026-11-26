// Pure layout-chrome geometry. Dependency-free so vitest can execute the
// inset math directly (chromeGeometry.test.ts); chrome.ts re-exports these
// alongside the React hooks.

// NativeTabs owns the actual platform bar. The root quick-actions gesture
// layer still spans the window, so it needs the platform bar's occupied band
// to avoid stealing tab presses without importing a removed custom dock.
export const IOS_NATIVE_TAB_BAR_HEIGHT = 49;
export const ANDROID_NATIVE_TAB_BAR_HEIGHT = 64;

// Minimum gap between a level-1 surface and any level-2 floating control
// (visual-language brief §E).
export const CHROME_CLEARANCE = 12;

/**
 * Only Home's sibling drawer handles stop above the visible iOS tab band.
 * The feed keeps its full viewport, sharp to the bottom edge (no scroll-edge
 * band,). Android keeps its existing minimized-host treatment; hidden
 * tabs need no clip.
 */
export function homeHandleClipInset(safeAreaBottom: number, platform: string, tabsSuppressed: boolean): number {
  return platform === 'ios' && !tabsSuppressed
    ? safeAreaBottom + IOS_NATIVE_TAB_BAR_HEIGHT + CHROME_CLEARANCE
    : 0;
}

/**
 * How far below its row top a drawer handle reaches: the 48pt row, or more
 * when a larger text size makes the pill taller than the row it is centred on.
 */
export function homeHandleReach(rowHeight: number, pillHeight: number): number {
  return Math.max(rowHeight, (rowHeight + pillHeight) / 2);
}

/**
 * The scroll offset from which Home's drawer handles are drawn whole inside
 * their clip (UX-UG-NATIVE-HOME-BOTTOM-BAND-CUT-PILLS-AND-TOP-EDGE-20261122):
 * at any smaller offset, overscroll included, a handle would cross the clip's
 * bottom edge and be cut, so it is not drawn at all. null while the row or
 * the clip is unmeasured, and for a handle whole at rest: both are drawn as before.
 */
export function homeHandleWholeFromOffset(handleRowTop: number, handleReach: number, clipHeight: number): number | null {
  if (handleRowTop <= 0 || clipHeight <= 0) return null;
  // A handle already whole at rest is drawn from the start, as on Main
  // ( split, Sol answer 7).
  const wholeFrom = handleRowTop + handleReach - clipHeight;
  return wholeFrom <= 0 ? null : wholeFrom;
}

/** How far past the whole offset a handle fades in, in points. */
export const HOME_HANDLE_FADE = 0.5;

/**
 * Whether a handle is fully drawn at this scroll offset, its fade ended. Only
 * then does it take taps and reach VoiceOver and TalkBack ( split, Sol
 * P1-a), so no invisible or half-faded pill ever acts.
 */
export function homeHandleDrawn(scrollOffset: number, wholeFrom: number | null): boolean {
  return wholeFrom === null || scrollOffset >= wholeFrom + HOME_HANDLE_FADE;
}

// --- the top edge ---------------------------------------------------------
//
// No screen draws a band at its top edge (owner ruling, Nov 22-23, 2026,
// replacing the top ramp of docs/mobile/top-chrome-progressive-blur-spec-20261010.md):
// content scrolls up behind the clock. Every surface still starts its content
// on the same line, and the floating controls keep their own frosted capsule.

/** The content start line: the same distance from the safe-area top everywhere. */
export const CONTENT_START_OFFSET = 28;

/** Height of a floating control (hat pill, compact pill, back circle). */
export const FLOATING_CONTROL_SIZE = 26;

/**
 * How far a floating control's top edge sits above the safe-area line. The
 * fallback is used for all three controls together if the device check in the
 * record's verification shows the status bar taking taps on the overlap.
 */
export const FLOATING_CONTROL_LIFT = 8;
export const FLOATING_CONTROL_LIFT_FALLBACK = 4;

/** Inset of a floating control's painted edge from the screen edge. */
export const FLOATING_CONTROL_GUTTER = 12;

/** Width of a floating control's tap target. */
export const FLOATING_CONTROL_HIT_WIDTH = 48;

/**
 * Minimum height of a floating control's tap target: the repository's touch
 * minimum (`minimumTouchTarget` in theme/tokens.ts, which this module cannot
 * import and chromeGeometry.test.ts keeps in step). Set by
 * BUG-UG-NATIVE-TOUCH-TARGETS-UNDER-48PX-20261019, which closes the
 * spec's open question 4: the 36pt band measured on the iPhone 16e and the
 * Pixel 10a is replaced by a 48pt one.
 */
export const FLOATING_CONTROL_HIT_HEIGHT = 48;

/** Frosted capsule backing, shared by the pills and the back circle. */
export const FROSTED_BACKING_OPACITY = 0.74;
export const FROSTED_BACKING_BLUR = 14;

/** One slow sheen across the pill's keyline and fill; off under Reduce Motion. */
export const PILL_SHEEN_CYCLE_MS = 9000;

/**
 * The one content start line. Every surface pads to this — tab roots, pushed
 * screens, Pulse, Compass, the quick-actions drawer and the Home drawers — so
 * the first line of content never jumps between surfaces.
 */
export function contentStartInset(safeAreaTop: number): number {
  return safeAreaTop + CONTENT_START_OFFSET;
}

/**
 * The content start line under a native stack header that a route keeps
 * (auth/callback, whose invitation and reset-link screens put their heading
 * first). The root Stack draws that header transparent over the scene, so the
 * line moves down until the header's measured height, safe-area top included,
 * is cleared by CHROME_CLEARANCE. It never moves up past the one start line
 * (BUG-UG-NATIVE-INVITE-HEADING-UNDER-BACK-ARROW-20261102).
 */
export function nativeHeaderContentInset(contentStart: number, nativeHeaderHeight: number): number {
  return Math.max(contentStart, nativeHeaderHeight + CHROME_CLEARANCE);
}

/**
 * Top edge of a floating control: `lift` above the safe-area line, floored so a
 * device reporting no top inset still draws the control on screen.
 */
export function floatingControlTop(
  safeAreaTop: number,
  minimumTop: number,
  lift: number = FLOATING_CONTROL_LIFT,
): number {
  return Math.max(safeAreaTop - lift, minimumTop);
}

/**
 * Left edge of a `FLOATING_CONTROL_HIT_WIDTH` tap target centred on a control
 * painted `FLOATING_CONTROL_GUTTER` from the screen edge.
 */
export function floatingControlHitInset(): number {
  return Math.max(0, FLOATING_CONTROL_GUTTER - (FLOATING_CONTROL_HIT_WIDTH - FLOATING_CONTROL_SIZE) / 2);
}

/**
 * A floating control's tap target starts at its own top edge and runs down far
 * enough that `FLOATING_CONTROL_HIT_HEIGHT` of it sits below the safe-area
 * line, or to the content start line if that is further. The part of the band
 * above that line (the lift, 8pt) is counted as system-owned: the status-bar
 * frame takes the tap on both platforms, so it is added to the band rather
 * than counted toward the minimum (gate round 3 on  kept the top edge
 * for the same reason; Codex thread on  asked for the overlap to be
 * excluded). At the 8pt lift the band is 56pt and ends 20pt below the content
 * start line, which is the title line on a pushed surface and Home's greeting:
 * text, not an action, under every control column; Home's first buttons start
 * 24pt below that line (BUG-UG-NATIVE-TOUCH-TARGETS-UNDER-48PX-20261019).
 */
export function floatingControlHitHeight(safeAreaTop: number, controlTop: number): number {
  const systemOverlap = Math.max(0, safeAreaTop - controlTop);
  return Math.max(FLOATING_CONTROL_HIT_HEIGHT + systemOverlap, contentStartInset(safeAreaTop) - controlTop);
}

/**
 * The part of the band the app can actually receive: from the safe-area line
 * (or the control top, whichever is lower) to the band's bottom edge. This is
 * the number the record's acceptance measures, and it is 48pt everywhere.
 */
export function floatingControlDeliverableHitHeight(safeAreaTop: number, controlTop: number): number {
  return controlTop + floatingControlHitHeight(safeAreaTop, controlTop) - Math.max(controlTop, safeAreaTop);
}

/**
 * How far the tap band reaches past the content start line, for the layout
 * tests and the touch-target audit: 20pt on any phone with a status bar (the
 * band bottom is safe-area + 48, the content start safe-area + 28, at either
 * lift), up to 24pt on a device with no top inset at all.
 */
export function floatingControlHitOverrun(safeAreaTop: number, controlTop: number): number {
  return Math.max(0, controlTop + floatingControlHitHeight(safeAreaTop, controlTop) - contentStartInset(safeAreaTop));
}

// --- the pushed-screen title row ------------------------------------------
//
// UX-UG-NATIVE-TITLE-BESIDE-BACK-CONTROL-20261115, the owner's pick on
// the phone layout plan (Nov 15, 2026): a pushed screen's title sits on one row
// beside the back control (iPhone: the frosted circle, then the title; Android:
// the arrow, then the title) instead of being painted as a scrolled heading
// under a floating circle. The back control keeps its place and its 48pt tap
// band; the title is drawn to its right on the same row, the content starts
// below the row, and a canvas backing behind the row keeps scrolled text from
// reading through the title.

/** The page title scale (owner decision, October 10, 2026): 22/28. */
export const PINNED_TITLE_LINE_HEIGHT = 28;

/**
 * The row title stops growing at this text size, as fixed chrome does (the hat
 * pill stops at 1.4x): two lines of it at the cap still leave most of the
 * screen to the content. Its full words stay with the screen reader.
 */
export const PINNED_TITLE_TEXT_CAP = 1.6;

/** Gap between the back control's 48pt tap target and the title. */
export const PINNED_TITLE_CONTROL_GAP = 4;

/** Left edge of the title on a pushed screen with no back control: the page gutter. */
export const PINNED_TITLE_BARE_INSET = 16;

/** Gap between the title and the compact hat capsule's 48pt column. */
export const PINNED_TITLE_TRAILING_GAP = 8;

/** Gap between the bottom of the row and the first line of content. */
export const PINNED_ROW_CONTENT_GAP = 16;

/** How far the canvas backing runs below the row, into that gap. */
export const PINNED_ROW_BACKING_GAP = 8;

/**
 * Left edge of the title: just past the back control's tap target, so a tap on
 * the title never lands on Back and the title never runs under the circle.
 */
export function pinnedTitleLeft(hasBack: boolean): number {
  return hasBack
    ? floatingControlHitInset() + FLOATING_CONTROL_HIT_WIDTH + PINNED_TITLE_CONTROL_GAP
    : PINNED_TITLE_BARE_INSET;
}

/**
 * Right edge inset of the title. The compact hat capsule's 48pt column at the
 * right gutter is always kept clear, so a title never runs under it whether or
 * not this session shows one (live accounts never do).
 */
export function pinnedTitleRight(): number {
  return FLOATING_CONTROL_GUTTER + FLOATING_CONTROL_HIT_WIDTH + PINNED_TITLE_TRAILING_GAP;
}

/**
 * Top edge of the title: its first 28pt line centred on the 26pt back circle at
 * the default text size. Larger text grows the title downwards from here, never
 * up into the status bar.
 */
export function pinnedTitleTop(controlTop: number): number {
  return controlTop + (FLOATING_CONTROL_SIZE - PINNED_TITLE_LINE_HEIGHT) / 2;
}

/** The page title's font size at the default text size. */
export const PINNED_TITLE_FONT_SIZE = 22;

/**
 * The scale the row title is drawn at for a system text size: the text size
 * itself, up to the cap. The row applies it to the font size and the line
 * height together, because Android scaled the line height past
 * `maxFontSizeMultiplier` (at font scale 2.0 the lines spread apart and a
 * one-line title hung below the arrow).
 */
export function pinnedTitleScale(fontScale: number): number {
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  return Math.min(scale, PINNED_TITLE_TEXT_CAP);
}

/** One line of the title at a text size, before the row has measured it. */
export function pinnedTitleLineEstimate(fontScale: number): number {
  return PINNED_TITLE_LINE_HEIGHT * pinnedTitleScale(fontScale);
}

/**
 * Bottom edge of the row: the back control's tap band, or the title if it runs
 * lower (two lines, large text). `titleHeight` is 0 for a row with no title.
 */
export function pinnedRowBottom(safeAreaTop: number, minimumTop: number, titleHeight: number): number {
  const controlTop = floatingControlTop(safeAreaTop, minimumTop);
  const bandBottom = controlTop + floatingControlHitHeight(safeAreaTop, controlTop);
  return Math.max(bandBottom, titleHeight > 0 ? pinnedTitleTop(controlTop) + titleHeight : 0);
}

/**
 * A pushed screen's content start line: below the whole row, so neither the
 * title nor the back control's tap band ever covers the first line of content.
 * Never above the one start line tab roots use.
 */
export function pinnedRowContentInset(safeAreaTop: number, minimumTop: number, titleHeight: number): number {
  return Math.max(
    contentStartInset(safeAreaTop),
    pinnedRowBottom(safeAreaTop, minimumTop, titleHeight) + PINNED_ROW_CONTENT_GAP,
  );
}

/** Height of the canvas backing behind the row, from the top of the screen. */
export function pinnedRowBackingHeight(safeAreaTop: number, minimumTop: number, titleHeight: number): number {
  return pinnedRowBottom(safeAreaTop, minimumTop, titleHeight) + PINNED_ROW_BACKING_GAP;
}

// Hat switcher anatomy. The pill floats in place on every surface; its
// dropdown hangs HAT_MENU_GAP below it, HAT_MENU_WIDTH wide, with rows taller
// than the 48pt repository touch minimum.
export const HAT_MENU_GAP = 8;
export const HAT_MENU_WIDTH = 280;
export const HAT_MENU_ROW_HEIGHT = 52;

// The five dock roots. Pathnames come from expo-router, which strips the
// "(tabs)" group segment.
export const NATIVE_TAB_ROOT_PATHS: readonly string[] = ['/home', '/work', '/compass', '/campaign', '/account'];

// Dock roots without a pinned header (Home, Work) centre the labelled pill.
// Every surface with a PinnedHeader, including the Guide, Campaign and Account
// roots, puts the compact one-line form at the header's right gutter so the
// pill never sits on the screen name.
export const HAT_TAB_ROOT_PATHS: readonly string[] = ['/home', '/work'];

// 'floating': the labelled pill, centred.
// 'pinned-trailing': the compact one-line capsule at the right gutter of a
// pushed surface. It is never hidden: SAMPLE and PREVIEW keep switching on
// every screen (the native owner correction contract).
export type HatPillPlacement = 'floating' | 'pinned-trailing';

export function hatPillPlacementForPath(pathname: string | null | undefined): HatPillPlacement {
  if (!pathname) return 'floating';
  const path = pathname.replace(/\/+$/, '') || '/';
  return HAT_TAB_ROOT_PATHS.includes(path) ? 'floating' : 'pinned-trailing';
}

// Both demo modes float the switcher: PREVIEW (unlocked demo) and SAMPLE (a
// live session bound to a sample hat). A live account has no sample hat and
// never renders it.
export function hasFloatingHatChrome(mode: string, sampleHat: string | null | undefined): boolean {
  return mode === 'preview' || (mode === 'authenticated' && Boolean(sampleHat));
}

export function hatMenuTop(pillTop: number, pillHeight: number): number {
  return pillTop + pillHeight + HAT_MENU_GAP;
}

// A short or landscape window scrolls the menu within the available safe area.
export function hatMenuMaxHeight(
  windowHeight: number,
  menuTop: number,
  safeAreaBottom: number,
  bottomGap: number,
): number {
  return Math.max(0, windowHeight - menuTop - safeAreaBottom - bottomGap);
}

// On a tab screen the menu also stops above the platform tab bar; at the
// largest text sizes it otherwise ran down over the tabs (Nov 7, 2026).
export function hatMenuBottomInset(
  safeAreaBottom: number,
  platform: 'ios' | 'android' | 'other',
  tabHosted: boolean,
): number {
  return tabHosted ? safeAreaBottom + platformTabBarHeight(platform) : safeAreaBottom;
}

function platformTabBarHeight(platform: 'ios' | 'android' | 'other'): number {
  return platform === 'ios'
    ? IOS_NATIVE_TAB_BAR_HEIGHT
    : platform === 'android'
      ? ANDROID_NATIVE_TAB_BAR_HEIGHT
      : 56;
}

// Resting gap below the last line of a scroll surface (spacing.xxl).
export const SCREEN_BOTTOM_GAP = 32;

// Base resting rhythm for a NativeTabs scene. The React hook adds the runtime
// bottom safe-area inset because iOS can extend the scene beneath its native
// tab bar; keeping that device-dependent value out of this pure helper makes
// the geometry directly testable without recreating a second custom bar.
export function nativeTabContentInset(): number {
  return SCREEN_BOTTOM_GAP;
}

// Android Home opts out of the tab host's scene padding. Its scroll content
// must clear both the full tab bar and the higher minimized Home target;
// reserve their union without changing the full-height viewport itself.
export function homeContentBottomInset(
  safeAreaBottom: number,
  platform: string,
  minimizedBottom: number,
  minimizedHeight: number,
): number {
  if (platform === 'android') {
    return safeAreaBottom + Math.max(ANDROID_NATIVE_TAB_BAR_HEIGHT, minimizedBottom + minimizedHeight) + CHROME_CLEARANCE;
  }
  return safeAreaBottom + nativeTabContentInset();
}

// The hidden Android tab host can keep a full-width hit target in the band it
// occupied. Home's box owes that band, and the minimized Home control that
// sits in it, the same clearance the scroll inset already computes.
export function androidMinimizedHomeReserve(
  safeAreaBottom: number,
  minimizedBottom: number,
  minimizedHeight: number,
): number {
  return homeContentBottomInset(safeAreaBottom, 'android', minimizedBottom, minimizedHeight);
}

// Drawer handles ride their reserved row (HomeHandleRow) at translateY =
// -scrollOffset and nowhere else: the row is there so the handles never cover
// the next section. Pinning a row that had not scrolled above the bottom of
// the shortened Android box to that edge  drew the handles over the
// staff desk card and desk summary
// (BUG-UG-NATIVE-ANDROID-PINNED-HOME-HANDLES-COVER-DESK-CARDS-20261109).
// Home clips its own children instead, so the part of a handle still drawn is
// inside the box, above the band the hidden tab host can hit; a row wholly
// below the box draws nothing. Returns the drawn span in box coordinates, or
// null when nothing of the row is drawn. An unmeasured row or box is unclipped.
export function homeHandleDrawnSpan(
  scrollOffset: number,
  handleRowTop: number,
  boxHeight: number,
  handleHeight: number,
): { top: number; bottom: number } | null {
  const top = handleRowTop - Math.max(0, scrollOffset);
  const bottom = top + handleHeight;
  if (boxHeight <= 0 || handleRowTop <= 0) return { top, bottom };
  const drawnTop = Math.max(0, top);
  const drawnBottom = Math.min(boxHeight, bottom);
  return drawnBottom > drawnTop ? { top: drawnTop, bottom: drawnBottom } : null;
}

export function nativeTabGestureBandTop(
  viewportHeight: number,
  safeAreaBottom: number,
  platform: 'ios' | 'android' | 'other',
): number {
  return Math.max(0, viewportHeight - safeAreaBottom - platformTabBarHeight(platform));
}

export function quickActionsGestureBandTop(
  viewportHeight: number,
  safeAreaBottom: number,
  platform: 'ios' | 'android' | 'other',
  nativeTabHosted: boolean,
): number {
  return nativeTabHosted
    ? nativeTabGestureBandTop(viewportHeight, safeAreaBottom, platform)
    : Math.max(0, viewportHeight - safeAreaBottom);
}

// Keyboard frame coordinates are window-relative, while NativeTabs scenes end
// above the platform bar. Remove that already-occupied bottom band before
// lifting an anchored scene composer; full-window overlays report zero
// clearance and therefore keep the complete keyboard overlap.
export function keyboardOverlapWithinScene(windowOverlap: number, sceneBottomClearance: number): number {
  return Math.max(0, windowOverlap - sceneBottomClearance);
}

export function anchoredComposerLift(
  windowOverlap: number,
  sceneBottomClearance: number,
  unhostedSafeAreaBottom: number,
  restGap: number,
  keyboardGap: number,
): number {
  return Math.max(
    restGap + unhostedSafeAreaBottom,
    keyboardOverlapWithinScene(windowOverlap, sceneBottomClearance) + keyboardGap,
  );
}

// Bottom content inset for a surface with no floating dock. The home
// indicator's safe area is added to the resting gap, never merged into it, and
// a device that reports no bottom inset still gets the chrome clearance — the
// old fallback was `safeAreaBottom + gap`, which collapses to the page's own
// padding on a zero-inset device and drops the last line onto the physical
// edge (pass-4, pushed detail surfaces).
export function screenBottomInset(safeAreaBottom: number): number {
  return Math.max(safeAreaBottom, CHROME_CLEARANCE) + SCREEN_BOTTOM_GAP;
}

// The offset a native scroll view settles on once its content or viewport
// changes size: it never rests past the last screenful, or above the top.
// BUG-UG-NATIVE-HOME-HANDLES-VANISH-AFTER-TEXT-SIZE-CHANGE-20261103.
export function clampedScrollOffset(offset: number, contentHeight: number, viewportHeight: number): number {
  return Math.max(0, Math.min(offset, contentHeight - viewportHeight));
}
