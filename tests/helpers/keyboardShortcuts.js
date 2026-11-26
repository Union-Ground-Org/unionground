// REQ-UG-KEYBOARD-SHORTCUTS-OFF-BY-DEFAULT-20261103: keyboard
// shortcuts are off until the member turns them on in Settings. A suite that
// drives a shortcut turns the choice on, as that member would: a component
// rendered alone gets a stand-in member, and whichever member (or fixture
// demo) the app signs in afterwards finds the choice on too.
// tests/keyboard-shortcuts-preference.test.jsx pins the default-off behavior.
import { afterEach, beforeEach } from "vitest";
import {
  keyboardShortcutsAvailable, keyboardShortcutsEnabled, resetKeyboardShortcutsForTests,
  setKeyboardShortcutsEnabled, setKeyboardShortcutsScope, subscribeKeyboardShortcuts,
} from "../../src/lib/keyboardShortcuts.js";

export function turnOnKeyboardShortcuts() {
  setKeyboardShortcutsScope("keyboard-shortcuts-test-member");
  setKeyboardShortcutsEnabled(true);
  return subscribeKeyboardShortcuts(() => {
    if (keyboardShortcutsAvailable() && !keyboardShortcutsEnabled()) setKeyboardShortcutsEnabled(true);
  });
}

export function keepKeyboardShortcutsOn() {
  let stop = null;
  beforeEach(() => { stop = turnOnKeyboardShortcuts(); });
  afterEach(() => {
    stop?.();
    stop = null;
    resetKeyboardShortcutsForTests();
  });
}
