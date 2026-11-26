import { useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';

// Shared VoiceOver/TalkBack probe, the same single-listener shape as
// reduceMotion.ts. Gesture observers use it to stand down while assistive
// navigation owns the touch stream.
let enabled = false;
// Whether the probe has answered: until it does, `enabled` is only a guess.
let known = false;
// A change event is newer than the first probe, so a probe that answers after
// one is stale and must not undo it.
let changed = false;
let started = false;
const listeners = new Set<() => void>();

function publish(next: boolean) {
  if (enabled === next && known) return;
  enabled = next;
  known = true;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!started) {
    started = true;
    void AccessibilityInfo.isScreenReaderEnabled().then((value) => { if (!changed) publish(value); }).catch(() => undefined);
    AccessibilityInfo.addEventListener('screenReaderChanged', (value: boolean) => { changed = true; publish(value); });
  }
  return () => { listeners.delete(listener); };
}

function read(): boolean {
  return enabled;
}

export function useScreenReader(): boolean {
  return useSyncExternalStore(subscribe, read, read);
}

function readKnownOff(): boolean {
  return known && !enabled;
}

// True only once the probe has answered that no screen reader runs: a layout
// that would merge accessibility frames waits for that answer, and a probe that
// never answers keeps it off.
export function useScreenReaderKnownOff(): boolean {
  return useSyncExternalStore(subscribe, readKnownOff, readKnownOff);
}
