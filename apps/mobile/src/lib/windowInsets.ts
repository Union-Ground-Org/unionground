import { useEffect, useSyncExternalStore } from 'react';
import { initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';

// The window's live bottom safe area, for modal sheets opened from a tab
// screen (BUG-UG-NATIVE-MESSAGES-ORGANIZE-SHEET-CUTS-OFF-BUTTONS-AND-HAS-NO-CLOSE-20261122).
// Inside a tab scene the safe-area hook also counts the tab bar the modal
// covers, a SafeAreaView inside the modal measures nothing, and the startup
// snapshot (initialWindowMetrics) can be missing or 0 and never updates
// (round 1 on PR #9638: r1s1, r2s1, r2g2). The root layout publishes the
// window's current inset here from the app's one root SafeAreaProvider, whose
// view is the whole window; until it has, the startup
// snapshot is the first fallback.

let liveBottomInset: number | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Called with the root provider's (window-level) bottom inset. */
export function publishWindowBottomInset(bottom: number): void {
  if (!Number.isFinite(bottom) || bottom === liveBottomInset) return;
  liveBottomInset = bottom;
  for (const listener of listeners) listener();
}

/**
 * The window's bottom inset: the live one once published, else the startup
 * snapshot, else 0. A published 0 while the startup snapshot is positive is
 * not trusted, so the last control never drops into the home indicator or
 * the gesture band.
 */
export function readWindowBottomInset(): number {
  const startup = initialWindowMetrics?.insets.bottom ?? 0;
  if (liveBottomInset === null || (liveBottomInset === 0 && startup > 0)) return startup;
  return liveBottomInset;
}

/**
 * Rendered once, as the first child of the root SafeAreaProvider in
 * app/_layout.tsx: that provider's view is the whole window, so its bottom
 * inset is the window's home indicator or navigation bar, never a tab bar.
 */
export function WindowBottomInsetPublisher(): null {
  const { bottom } = useSafeAreaInsets();
  useEffect(() => { publishWindowBottomInset(bottom); }, [bottom]);
  return null;
}

/** Re-renders when the published inset changes (navigation mode, split screen, a late first measurement). */
export function useWindowBottomInset(): number {
  return useSyncExternalStore(subscribe, readWindowBottomInset, readWindowBottomInset);
}

/** Test seam: forget the published inset. */
export function resetWindowBottomInsetForTests(): void {
  liveBottomInset = null;
  for (const listener of listeners) listener();
}
