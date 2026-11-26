// A11Y-UG-REMEMBER-MEMBER-S-SHORTCUTS-OFF-CHOICE-ACROSS-TASKS-20261013.
// WCAG 2.1.4: the bare /, ? and c keys on Tasks are an opt-in, per member and
// per device. This module owns where that choice lives, outside TasksView, so
// the view can remount (another route and back) without losing it:
// - a signed-in member: localStorage under their own member key;
// - the fixture demo: sessionStorage under one sg:demo: key (the DesktopRail
//   pattern), so a demo visit never reads or writes the shared fixture
//   member's persistent preference and a new browser session starts off;
// - when the storage write is refused (quota, privacy mode, policy), the
//   chosen value is kept in a session cache keyed the same way, so the choice
//   survives navigation for this page load even though it could not be saved.
const DEMO_TASK_CHARACTER_SHORTCUTS_KEY = "sg:demo:task-character-shortcuts";

// Choices whose storage write was refused, by storage key. Read before the
// storage so a stale saved "true" cannot turn the keys back on after the
// member switched them off and the browser refused to record it.
const unsavedChoices = new Map();

export function characterShortcutStorageKey(memberId, demo = false) {
  if (demo) return DEMO_TASK_CHARACTER_SHORTCUTS_KEY;
  return memberId ? `sg:member:${memberId}:task-character-shortcuts` : null;
}

function storageFor(demo) {
  try {
    return demo ? globalThis.sessionStorage : globalThis.localStorage;
  } catch {
    return null;
  }
}

export function readCharacterShortcuts(key, demo = false) {
  if (!key) return false;
  if (unsavedChoices.has(key)) return unsavedChoices.get(key);
  try { return storageFor(demo)?.getItem(key) === "true"; }
  catch { return false; }
}

export function writeCharacterShortcuts(key, demo, enabled) {
  if (!key) return;
  try {
    const store = storageFor(demo);
    // No storage object at all (a locked-down or sandboxed page) is a failed
    // write like any other: the choice is kept for this page load.
    if (!store) throw new Error("storage-unavailable");
    store.setItem(key, String(enabled));
    unsavedChoices.delete(key);
  } catch {
    // The switch still works for this visit, and for the next Tasks mount
    // in this page load, when storage is unavailable.
    unsavedChoices.set(key, enabled);
  }
}

// Tests only: forget the unsaved choices between cases.
export function resetUnsavedCharacterShortcutChoices() {
  unsavedChoices.clear();
}
