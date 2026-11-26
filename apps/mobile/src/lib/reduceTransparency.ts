import { useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';

// Shared Reduce Transparency probe, the sibling of ./reduceMotion. The one
// see-through control in the app (the transparent hat pill) reads it so a
// member who asked iOS for opaque chrome gets an opaque pill.
// Unknown is conservative, as it is for Reduce Motion: until the platform
// answers, the pill draws opaque rather than showing the canvas through it.
// Android has no such setting and resolves false immediately.
let enabled = true;
let subscription: ReturnType<typeof AccessibilityInfo.addEventListener> | null = null;
const listeners = new Set<() => void>();

function publish(next: boolean) {
  if (enabled === next) return;
  enabled = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!subscription) {
    subscription = AccessibilityInfo.addEventListener('reduceTransparencyChanged', publish);
    void AccessibilityInfo.isReduceTransparencyEnabled().then(publish).catch(() => undefined);
  }
  return () => {
    listeners.delete(listener);
    // The native listener lives exactly as long as something reads the value,
    // so an unmounted tree never leaves a subscription behind.
    if (listeners.size === 0 && subscription) {
      subscription.remove();
      subscription = null;
    }
  };
}

function read(): boolean {
  return enabled;
}

export function useReduceTransparency(): boolean {
  return useSyncExternalStore(subscribe, read, read);
}
