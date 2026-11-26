import { useLayoutEffect } from "react";

// Multiple task layers can overlap (the delete confirmation sits above the
// task workspace). Reference counts keep each layer from undoing isolation
// still owned by another one, while the snapshot restores pre-existing DOM
// state exactly when the final owner leaves.
const isolatedElements = new WeakMap();
const activeModalLayers = new Map();
// Each live layer's reconcile function. A newer layer runs the older ones at
// once when it registers or leaves, so the branch it lives in is released
// before its own mount effects (initial focus) run, not a microtask later.
const layerSyncs = new Set();
let nextModalLayer = 0;
let bodyLockCount = 0;
let bodyOverflowBeforeLock = "";

function acquireIsolation(element) {
  const existing = isolatedElements.get(element);
  if (existing) {
    existing.owners += 1;
    return;
  }
  isolatedElements.set(element, {
    owners: 1,
    hadInert: element.hasAttribute("inert"),
    ariaHidden: element.getAttribute("aria-hidden"),
  });
  element.setAttribute("inert", "");
  element.setAttribute("aria-hidden", "true");
}

function releaseIsolation(element) {
  const record = isolatedElements.get(element);
  if (!record) return;
  record.owners -= 1;
  if (record.owners > 0) return;
  isolatedElements.delete(element);
  if (!record.hadInert) element.removeAttribute("inert");
  if (record.ariaHidden === null) element.removeAttribute("aria-hidden");
  else element.setAttribute("aria-hidden", record.ariaHidden);
}

function outsideSiblings(root, layer) {
  const siblings = new Set();
  let branch = root;
  while (branch?.parentElement && branch !== document.body) {
    const parent = branch.parentElement;
    for (const child of parent.children) {
      if (child === branch || ["SCRIPT", "STYLE", "LINK"].includes(child.tagName)) continue;
      // A later modal is above this one and must remain interactive. The later
      // layer will isolate this root in the opposite direction.
      const containsNewerLayer = [...activeModalLayers].some(([otherRoot, otherLayer]) =>
        otherLayer > layer && (child === otherRoot || child.contains(otherRoot)));
      if (!containsNewerLayer) siblings.add(child);
    }
    branch = parent;
  }
  return [...siblings];
}

function lockBodyScroll() {
  if (bodyLockCount === 0) {
    bodyOverflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  bodyLockCount += 1;
}

function unlockBodyScroll() {
  bodyLockCount = Math.max(0, bodyLockCount - 1);
  if (bodyLockCount === 0) document.body.style.overflow = bodyOverflowBeforeLock;
}

/** Isolate every branch outside a modal, not just its nearest siblings. */
export function useModalIsolation(rootRef, { active = true, lockScroll = true } = {}) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!active || !root) return undefined;
    const layer = ++nextModalLayer;
    activeModalLayers.set(root, layer);
    const owned = new Set();
    const syncIsolation = () => {
      const next = new Set(outsideSiblings(root, layer));
      for (const element of next) {
        if (owned.has(element)) continue;
        acquireIsolation(element);
        owned.add(element);
      }
      for (const element of [...owned]) {
        if (next.has(element)) continue;
        releaseIsolation(element);
        owned.delete(element);
      }
    };
    layerSyncs.forEach((sync) => sync());
    layerSyncs.add(syncIsolation);
    syncIsolation();
    // Alerts, toasts, and other shell branches may mount after the modal. Keep
    // the isolation boundary live instead of trusting a one-time DOM snapshot.
    const observer = typeof MutationObserver === "function"
      ? new MutationObserver(syncIsolation)
      : null;
    observer?.observe(document.body, { childList: true, subtree: true });
    if (lockScroll) lockBodyScroll();
    return () => {
      activeModalLayers.delete(root);
      layerSyncs.delete(syncIsolation);
      observer?.disconnect();
      owned.forEach(releaseIsolation);
      layerSyncs.forEach((sync) => sync());
      if (lockScroll) unlockBodyScroll();
    };
  }, [active, lockScroll, rootRef]);
}
