import { useCallback, useSyncExternalStore } from 'react';
import { Animated, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { minimumTouchTarget, spacing } from '../theme/tokens';

// Shared layout-chrome geometry. Every floating surface (dock, hat pill,
// pinned header) measures against these constants so a screen can never
// disagree with the chrome that paints over it. The pure math lives in
// chromeGeometry.ts so tests can execute it without React Native.

export {
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
  contentStartInset,
  floatingControlDeliverableHitHeight,
  floatingControlHitHeight,
  floatingControlHitInset,
  floatingControlHitOverrun,
  floatingControlTop,
  hasFloatingHatChrome,
  hatMenuBottomInset,
  hatMenuMaxHeight,
  hatMenuTop,
  hatPillPlacementForPath,
  nativeHeaderContentInset,
  nativeTabContentInset,
  nativeTabGestureBandTop,
  quickActionsGestureBandTop,
  keyboardOverlapWithinScene,
  anchoredComposerLift,
  screenBottomInset,
} from './chromeGeometry';
export type { HatPillPlacement } from './chromeGeometry';
import { clampedScrollOffset, homeContentBottomInset, nativeTabContentInset } from './chromeGeometry';

// Home is the one tab root whose complete app-owned chrome travels with the
// feed. The ScrollView and root-level PREVIEW hat switcher live in separate
// trees, so they share one animation value instead of duplicating scroll state
// through React renders on every frame.
export const homeScrollOffset = new Animated.Value(0);
// One point absorbs elastic-scroll noise while keeping the full navigation a
// true top-of-page state rather than a direction-based approximation.
const HOME_CHROME_SCROLL_THRESHOLD = 1;
let homeAwayFromTop = false;
const homeScrollListeners = new Set<() => void>();
let homeScrollToTopRequests = 0;
const homeScrollToTopListeners = new Set<() => void>();

// The feed's last known offset and size, for syncHomeScrollBounds.
let homeScrollPosition = 0;
let homeViewportHeight = 0;
let homeContentHeight = 0;

export function readHomeScrollPosition(): number {
  return homeScrollPosition;
}

export function syncHomeAwayFromTop(offset: number): void {
  const boundedOffset = Math.max(0, offset);
  homeScrollPosition = boundedOffset;
  const nextAwayFromTop = boundedOffset > HOME_CHROME_SCROLL_THRESHOLD;
  if (homeAwayFromTop === nextAwayFromTop) return;
  homeAwayFromTop = nextAwayFromTop;
  for (const listener of homeScrollListeners) listener();
}

export function resetHomeScrollOffset(): void {
  homeScrollOffset.setValue(0);
  homeViewportHeight = 0;
  homeContentHeight = 0;
  syncHomeAwayFromTop(0);
}

// BUG-UG-NATIVE-HOME-HANDLES-VANISH-AFTER-TEXT-SIZE-CHANGE-20261103:
// when the feed shrinks (a text-size change remounts it) or its viewport
// changes, the native scroll view clamps its offset without a scroll event.
// The shared offset kept the old value and carried the handle row off screen
// until the next scroll, so Home reports each size change here and the shared
// offset follows the clamp.
export function syncHomeScrollBounds(bounds: { viewportHeight?: number; contentHeight?: number }): void {
  homeViewportHeight = bounds.viewportHeight ?? homeViewportHeight;
  homeContentHeight = bounds.contentHeight ?? homeContentHeight;
  if (homeViewportHeight <= 0) return;
  const clamped = clampedScrollOffset(homeScrollPosition, homeContentHeight, homeViewportHeight);
  if (clamped === homeScrollPosition) return;
  homeScrollOffset.setValue(clamped);
  syncHomeAwayFromTop(clamped);
}

function subscribeHomeScroll(listener: () => void): () => void {
  homeScrollListeners.add(listener);
  return () => { homeScrollListeners.delete(listener); };
}

function readHomeAwayFromTop(): boolean {
  return homeAwayFromTop;
}

export function useHomeAwayFromTop(): boolean {
  const subscribe = useCallback(subscribeHomeScroll, []);
  return useSyncExternalStore(subscribe, readHomeAwayFromTop, readHomeAwayFromTop);
}

export function requestHomeScrollToTop(): void {
  homeScrollToTopRequests += 1;
  for (const listener of homeScrollToTopListeners) listener();
}

function subscribeHomeScrollToTop(listener: () => void): () => void {
  homeScrollToTopListeners.add(listener);
  return () => { homeScrollToTopListeners.delete(listener); };
}

function readHomeScrollToTopRequests(): number {
  return homeScrollToTopRequests;
}

export function useHomeScrollToTopRequests(): number {
  const subscribe = useCallback(subscribeHomeScrollToTop, []);
  return useSyncExternalStore(subscribe, readHomeScrollToTopRequests, readHomeScrollToTopRequests);
}

// Home's over/under drawers publish their reveal (0 = Home at rest, 1 = a
// drawer fully open) so the root-level PREVIEW hat pill stands down with the
// moving sheet instead of floating over the open drawer.
export const homeDrawerReveal = new Animated.Value(0);

export function syncHomeDrawerReveal(progress: number): void {
  homeDrawerReveal.setValue(Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0)));
}

export function useNativeTabContentInset(fullHeightHome = false): number {
  const insets = useSafeAreaInsets();
  if (fullHeightHome) {
    return homeContentBottomInset(insets.bottom, Platform.OS, spacing.xl, minimumTouchTarget);
  }
  return nativeTabContentInset() + insets.bottom;
}

// The settled Home drawer is a level-3 layer, so the dock must not paint over
// it. The drawer shell and the dock live in different navigator subtrees, so
// they coordinate through this module-level store rather than a shared parent.
let dockSuppressed = false;
const dockListeners = new Set<() => void>();

export function setDockSuppressed(next: boolean): void {
  if (dockSuppressed === next) return;
  dockSuppressed = next;
  for (const listener of dockListeners) listener();
}

function subscribeDock(listener: () => void): () => void {
  dockListeners.add(listener);
  return () => { dockListeners.delete(listener); };
}

function readDockSuppressed(): boolean {
  return dockSuppressed;
}

export function useDockSuppressed(): boolean {
  const subscribe = useCallback(subscribeDock, []);
  return useSyncExternalStore(subscribe, readDockSuppressed, readDockSuppressed);
}

// Home publishes the bottom of its stat band so the two drawer open handles
// sit on their own row below it instead of over its rounded corners (the
// October 9 capture, item 5 of
// docs/mobile/top-chrome-progressive-blur-spec-20261010.md). The feed and the
// carousel shell are different subtrees, so they coordinate through this
// module-level store rather than a shared parent, exactly as the drawer reveal
// above does.
let homeHandleRowTop = 0;
const homeHandleRowListeners = new Set<() => void>();

export function syncHomeHandleRowTop(top: number): void {
  const next = Number.isFinite(top) ? Math.max(0, top) : 0;
  if (homeHandleRowTop === next) return;
  homeHandleRowTop = next;
  for (const listener of homeHandleRowListeners) listener();
}

// BUG-UG-NATIVE-HOME-HANDLES-STAY-AT-UNSCROLLED-POSITION-AFTER-TEXT-SIZE-CHANGE-IOS-20261103:
// a text-size change remounts the feed, so one row unmounts and its successor
// mounts in the same commit. Clearing the row at once dropped the handles'
// scroll transform for a render; live Home has no other reader of
// homeScrollOffset, so React Native dropped its native node and rebuilt it
// from the JS-side value, which native scroll events never update. The handles
// then sat at the unscrolled position on a scrolled page until the next
// scroll. A row now holds a claim, and the release clears the row a microtask
// later only if no successor has claimed it.
let homeHandleRowClaims = 0;

export function claimHomeHandleRow(): () => void {
  homeHandleRowClaims += 1;
  return () => {
    homeHandleRowClaims -= 1;
    queueMicrotask(() => { if (homeHandleRowClaims === 0) syncHomeHandleRowTop(0); });
  };
}

function subscribeHomeHandleRow(listener: () => void): () => void {
  homeHandleRowListeners.add(listener);
  return () => { homeHandleRowListeners.delete(listener); };
}

function readHomeHandleRowTop(): number {
  return homeHandleRowTop;
}

export function useHomeHandleRowTop(): number {
  const subscribe = useCallback(subscribeHomeHandleRow, []);
  return useSyncExternalStore(subscribe, readHomeHandleRowTop, readHomeHandleRowTop);
}
