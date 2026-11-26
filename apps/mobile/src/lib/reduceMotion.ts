import { useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';

// Shared Reduce Motion probe. Motion primitives (pressed compression, dock
// fade, hat pulse) all read this so the accessibility setting is honored in
// exactly one place. Cards and buttons render in bulk, so the native listener
// is registered once for the whole tree rather than once per component.
// Unknown is conservative: a device with Reduce Motion already on must not
// animate during the first-paint window before isReduceMotionEnabled resolves.
let enabled = true;
let known = false;
let started = false;
const listeners = new Set<() => void>();

function publish(next: boolean) {
  known = true;
  if (enabled === next) return;
  enabled = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!started) {
    started = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(publish).catch(() => undefined);
    AccessibilityInfo.addEventListener('reduceMotionChanged', publish);
  }
  return () => { listeners.delete(listener); };
}

function read(): boolean {
  return enabled;
}

/**
 * Whether the device has answered yet. Until it has, useReduceMotion reports
 * true, and a one-time entrance (a chart's arrival) that cannot wait for the
 * answer draws itself finished rather than risk moving.
 */
export function reduceMotionKnown(): boolean {
  return known;
}

export function useReduceMotion(): boolean {
  return useSyncExternalStore(subscribe, read, read);
}
