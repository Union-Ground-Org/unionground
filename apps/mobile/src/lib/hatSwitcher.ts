import { useCallback, useSyncExternalStore } from 'react';

// b06-17: every authorization gate told the member to use a "Switch hat"
// control that was not on the gate screen — the hat pill floats in the app
// chrome, and the sheet it opens is owned by HatSwitcher in the root layout.
// The gate and the switcher live in different navigator subtrees, so they
// coordinate through this module-level store, exactly as the dock and the Home
// drawers do in ./chrome.ts. The store carries a monotonic request count rather
// than an open/closed flag: the sheet owns its own visibility, and two gates in
// a row must each be able to open it.

let requests = 0;
const listeners = new Set<() => void>();

export function requestHatSwitcher(): void {
  requests += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function read(): number {
  return requests;
}

export function useHatSwitcherRequests(): number {
  const subscribeRequests = useCallback(subscribe, []);
  return useSyncExternalStore(subscribeRequests, read, read);
}
