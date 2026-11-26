// REQ-UG-KEYBOARD-SHORTCUTS-OFF-BY-DEFAULT-20261103. Owner order,
// November 3, 2026: keyboard shortcuts are off by default and a member turns
// them on in their own Settings. This module is the one switch every
// application shortcut reads: the rail's Control/Command+1..0, the palette's
// Control/Command+K, the bare "/" search keys of both shells, the palette's
// attention shortcuts and the Tasks board's chords and character keys. Tab,
// Enter, Space, arrows, Escape and browser combinations never read it.
//
// The choice lives where the board's character-key choice lives
// (src/lib/taskCharacterShortcuts.js):
// - a signed-in member: localStorage under their own member key;
// - the fixture demo: sessionStorage under one sg:demo: key, so a demo visit
//   never reads or writes the shared fixture member's persistent choice;
// - a refused write is kept in a session cache keyed the same way, so the
//   choice holds for this page load even though it could not be saved.
// Nothing stored, or no member at all, is off.
import { useSyncExternalStore } from "react";

const DEMO_KEYBOARD_SHORTCUTS_KEY = "sg:demo:keyboard-shortcuts";

const unsavedChoices = new Map();
const listeners = new Set();
// The member whose choice the window listeners read. MemberApp sets it.
let scope = { key: null, demo: false };

export function keyboardShortcutsStorageKey(memberId, demo = false) {
  if (demo) return DEMO_KEYBOARD_SHORTCUTS_KEY;
  return memberId ? `sg:member:${memberId}:keyboard-shortcuts` : null;
}

function storageFor(demo) {
  try {
    return demo ? globalThis.sessionStorage : globalThis.localStorage;
  } catch {
    return null;
  }
}

function notify() {
  for (const listener of [...listeners]) listener();
}

export function readKeyboardShortcuts(key, demo = false) {
  if (!key) return false;
  if (unsavedChoices.has(key)) return unsavedChoices.get(key);
  try { return storageFor(demo)?.getItem(key) === "true"; }
  catch { return false; }
}

// Returns whether the choice was saved; either way it holds for this visit.
export function writeKeyboardShortcuts(key, demo, enabled) {
  if (!key) return false;
  let saved = true;
  try {
    const store = storageFor(demo);
    if (!store) throw new Error("storage-unavailable");
    store.setItem(key, String(enabled));
    unsavedChoices.delete(key);
  } catch {
    unsavedChoices.set(key, enabled);
    saved = false;
  }
  notify();
  return saved;
}

export function setKeyboardShortcutsScope(memberId, demo = false) {
  const key = keyboardShortcutsStorageKey(memberId, demo);
  if (scope.key === key && scope.demo === Boolean(demo)) return;
  scope = { key, demo: Boolean(demo) };
  notify();
}

export function keyboardShortcutsEnabled() {
  return readKeyboardShortcuts(scope.key, scope.demo);
}

export function setKeyboardShortcutsEnabled(enabled) {
  return writeKeyboardShortcuts(scope.key, scope.demo, Boolean(enabled));
}

// Settings offers the switch only when there is a member to hold it.
export function keyboardShortcutsAvailable() {
  return Boolean(scope.key);
}

export function subscribeKeyboardShortcuts(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useKeyboardShortcutsEnabled() {
  return useSyncExternalStore(subscribeKeyboardShortcuts, keyboardShortcutsEnabled, () => false);
}

export function useKeyboardShortcutsAvailable() {
  return useSyncExternalStore(subscribeKeyboardShortcuts, keyboardShortcutsAvailable, () => false);
}

// Tests only: forget the scope and the unsaved choices between cases.
export function resetKeyboardShortcutsForTests() {
  unsavedChoices.clear();
  scope = { key: null, demo: false };
  notify();
}
