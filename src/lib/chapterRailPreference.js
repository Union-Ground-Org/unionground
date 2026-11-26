import { useCallback, useSyncExternalStore } from "react";

// REQ-UG-CHAPTER-RAIL-COLLAPSED-BY-DEFAULT-MENU-TOGGLE-20261103: the
// desktop chapter rail opens collapsed unless the member turned on "Keep the
// chapter rail expanded" in the profile menu. The choice is per member on this
// device; the demo keeps it for the browser session. The rail's own collapse
// button changes the current visit only and never writes here.
const DEMO_EXPANDED_KEY = "sg:demo:chapter-rail:expanded-by-default";
const CHANGE_EVENT = "sg:chapter-rail-expanded-by-default";

function preferenceStore({ memberId = null, demo = false } = {}) {
  let storage;
  try { storage = globalThis[demo ? "sessionStorage" : "localStorage"] ?? null; } catch { storage = null; }
  const key = demo ? DEMO_EXPANDED_KEY : memberId ? `sg:member:${memberId}:chapter-rail:expanded-by-default` : null;
  return { storage, key };
}

export function readChapterRailExpandedByDefault(owner) {
  const { storage, key } = preferenceStore(owner);
  if (!key) return false;
  try { return storage?.getItem(key) === "true"; } catch { return false; }
}

export function writeChapterRailExpandedByDefault(owner, expanded) {
  const { storage, key } = preferenceStore(owner);
  if (!key) return;
  try { storage?.setItem(key, String(expanded === true)); } catch { /* Storage may be unavailable. */ }
  // A mounted rail applies the new default at once (see ChapterRail).
  globalThis.dispatchEvent?.(new CustomEvent(CHANGE_EVENT, { detail: { key, expanded: expanded === true } }));
}

// Calls `listener(expanded)` when this owner's preference is written.
export function subscribeChapterRailExpandedByDefault(owner, listener) {
  const { key } = preferenceStore(owner);
  if (!key || !globalThis.addEventListener) return () => {};
  const onChange = (event) => { if (event.detail?.key === key) listener(event.detail.expanded === true); };
  globalThis.addEventListener(CHANGE_EVENT, onChange);
  return () => globalThis.removeEventListener(CHANGE_EVENT, onChange);
}

// [expanded, setExpanded, available] for the profile menu's switch.
// `available` is false when there is no member to keep the choice for.
export function useChapterRailExpandedByDefault({ memberId = null, demo = false } = {}) {
  const subscribe = useCallback((notify) => subscribeChapterRailExpandedByDefault({ memberId, demo }, notify), [demo, memberId]);
  const expanded = useSyncExternalStore(
    subscribe,
    () => readChapterRailExpandedByDefault({ memberId, demo }),
    () => false,
  );
  const setExpanded = useCallback((next) => writeChapterRailExpandedByDefault({ memberId, demo }, next), [demo, memberId]);
  return [expanded, setExpanded, Boolean(preferenceStore({ memberId, demo }).key)];
}
