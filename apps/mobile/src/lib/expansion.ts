import { LayoutAnimation } from 'react-native';

// The shared in-place expansion primitive (the "Implement through shared
// tokens and primitives … not one-off per-screen shadow or animation
// constants"). The Compass approved-sources block and the legal jump card both
// grow in place behind one row, so they take one duration and one curve from
// here instead of each filing its own `*_EXPAND_MS`.
//
// 280ms easeOut is the value b01-22 filed for the jump card; the sources block
// was matched to it by hand before this module existed.
export const EXPAND_MS = 280;

/**
 * Queues the next layout pass as an in-place expansion.
 *
 * Reduce Motion is a no-op, not a shorter animation: the rows still arrive,
 * they simply arrive without travel — the same branch every motion primitive in
 * the app takes off the shared `useReduceMotion` probe.
 */
export function configureExpansion(reduceMotion: boolean): void {
  if (reduceMotion) return;
  LayoutAnimation.configureNext({
    duration: EXPAND_MS,
    create: { type: LayoutAnimation.Types.easeOut, property: LayoutAnimation.Properties.opacity },
    update: { type: LayoutAnimation.Types.easeOut },
    delete: { type: LayoutAnimation.Types.easeOut, property: LayoutAnimation.Properties.opacity },
  });
}
