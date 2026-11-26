// A11Y-UG-REMEMBER-MEMBER-S-SHORTCUTS-OFF-CHOICE-ACROSS-TASKS-20261013:
// where the Tasks character-shortcut choice lives, and what happens when the
// browser refuses to keep it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  characterShortcutStorageKey, readCharacterShortcuts, resetUnsavedCharacterShortcutChoices, writeCharacterShortcuts,
} from "../src/lib/taskCharacterShortcuts.js";

const MEMBER = "11111111-1111-4111-8111-111111111111";

function fakeStorage() {
  const map = new Map();
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) };
}

describe("task character shortcut choice", () => {
  const originals = { localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"), sessionStorage: Object.getOwnPropertyDescriptor(globalThis, "sessionStorage") };
  beforeEach(() => resetUnsavedCharacterShortcutChoices());
  afterEach(() => {
    for (const [name, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
    resetUnsavedCharacterShortcutChoices();
  });

  it("keys a member's choice to the member and the demo's to one session key", () => {
    expect(characterShortcutStorageKey(MEMBER)).toBe(`sg:member:${MEMBER}:task-character-shortcuts`);
    expect(characterShortcutStorageKey(MEMBER, true)).toBe("sg:demo:task-character-shortcuts");
    expect(characterShortcutStorageKey(null)).toBeNull();
  });

  it("writes a member's choice to localStorage and the demo's to sessionStorage", () => {
    const local = fakeStorage(); const session = fakeStorage();
    Object.defineProperty(globalThis, "localStorage", { value: local, configurable: true });
    Object.defineProperty(globalThis, "sessionStorage", { value: session, configurable: true });
    writeCharacterShortcuts(characterShortcutStorageKey(MEMBER), false, true);
    writeCharacterShortcuts(characterShortcutStorageKey(MEMBER, true), true, true);
    expect(local.getItem(characterShortcutStorageKey(MEMBER))).toBe("true");
    expect(session.getItem("sg:demo:task-character-shortcuts")).toBe("true");
    expect(local.getItem("sg:demo:task-character-shortcuts")).toBeNull();
    expect(readCharacterShortcuts(characterShortcutStorageKey(MEMBER))).toBe(true);
    expect(readCharacterShortcuts(characterShortcutStorageKey(MEMBER, true), true)).toBe(true);
  });

  it("keeps the chosen value for the page load when the write is refused, over a stale saved value", () => {
    const local = fakeStorage();
    local.setItem(characterShortcutStorageKey(MEMBER), "true");
    local.setItem = () => { throw new Error("write denied"); };
    Object.defineProperty(globalThis, "localStorage", { value: local, configurable: true });
    writeCharacterShortcuts(characterShortcutStorageKey(MEMBER), false, false);
    expect(readCharacterShortcuts(characterShortcutStorageKey(MEMBER))).toBe(false);
    // Another member reads their own storage, never this member's unsaved choice.
    expect(readCharacterShortcuts(characterShortcutStorageKey("22222222-2222-4222-8222-222222222222"))).toBe(false);
  });

  it("treats a missing storage object as a refused write, not as a saved one", () => {
    Object.defineProperty(globalThis, "localStorage", { get() { throw new Error("storage disabled"); }, configurable: true });
    writeCharacterShortcuts(characterShortcutStorageKey(MEMBER), false, true);
    expect(readCharacterShortcuts(characterShortcutStorageKey(MEMBER))).toBe(true);
    delete globalThis.localStorage;
    writeCharacterShortcuts(characterShortcutStorageKey(MEMBER), false, false);
    expect(readCharacterShortcuts(characterShortcutStorageKey(MEMBER))).toBe(false);
  });
});
