import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  commandMatches,
  isEditableShortcutTarget,
  railShortcutIndex,
  shortcutModifierLabel,
} from "../src/lib/commandPalette.js";

describe("command palette keyboard contracts", () => {
  it("maps Cmd/Ctrl+1-0 to the first ten visible rail positions", () => {
    expect(railShortcutIndex({ key: "1", metaKey: true })).toBe(0);
    expect(railShortcutIndex({ key: "2", ctrlKey: true })).toBe(1);
    expect(railShortcutIndex({ key: "0", metaKey: true })).toBe(9);
    expect(railShortcutIndex({ key: "3" })).toBe(-1);
    expect(railShortcutIndex({ key: "x", ctrlKey: true })).toBe(-1);
  });

  it("rejects Alt and Shift digit chords, including the zero slot", () => {
    const plain = { altKey: false, shiftKey: false };
    expect(railShortcutIndex({ key: "1", metaKey: true, ctrlKey: false, ...plain })).toBe(0);
    expect(railShortcutIndex({ key: "9", ctrlKey: true, metaKey: false, ...plain })).toBe(8);
    expect(railShortcutIndex({ key: "0", ctrlKey: true, metaKey: false, ...plain })).toBe(9);

    const modified = [
      { altKey: true },
      { shiftKey: true },
      { altKey: true, shiftKey: true },
      { metaKey: true, altKey: true },
      { ctrlKey: true, altKey: true },
      { metaKey: true, shiftKey: true },
      { ctrlKey: true, shiftKey: true },
      { metaKey: true, ctrlKey: true, altKey: true },
      { metaKey: true, ctrlKey: true, shiftKey: true },
      { metaKey: true, altKey: true, shiftKey: true },
      { ctrlKey: true, altKey: true, shiftKey: true },
    ];
    for (const key of ["1", "9", "0"]) {
      for (const chord of modified) {
        expect(railShortcutIndex({ key, ...chord })).toBe(-1);
      }
    }
  });

  it("does not treat an empty, blank or multi-character key as a rail digit", () => {
    for (const key of ["", " ", "10", "11", "F1", "Digit1"]) {
      expect(railShortcutIndex({ key, metaKey: true, altKey: false, shiftKey: false })).toBe(-1);
      expect(railShortcutIndex({ key, ctrlKey: true, altKey: false, shiftKey: false })).toBe(-1);
    }
  });

  it("suppresses navigation shortcuts from editable descendants", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(isEditableShortcutTarget({ tagName, isContentEditable: false, closest: () => null })).toBe(true);
    }
    expect(isEditableShortcutTarget({ tagName: "DIV", isContentEditable: true, closest: () => null })).toBe(true);
    expect(isEditableShortcutTarget({ tagName: "SPAN", isContentEditable: false, closest: (selector) => selector === "[contenteditable='true']" ? {} : null })).toBe(true);
    expect(isEditableShortcutTarget({ tagName: "BUTTON", isContentEditable: false, closest: () => null })).toBe(false);
  });

  it("filters labels and keywords case- and accent-insensitively", () => {
    const command = { label: "Recompensas", keywords: ["benefícios", "rewards"] };
    expect(commandMatches(command, "RECOMP")).toBe(true);
    expect(commandMatches(command, "beneficios")).toBe(true);
    expect(commandMatches(command, "cases")).toBe(false);
  });

  it("does not show a Mac glyph on Windows rail hints", () => {
    expect(shortcutModifierLabel("MacIntel")).toBe("⌘");
    expect(shortcutModifierLabel("Win32")).toBe("Ctrl");
    expect(shortcutModifierLabel("Linux x86_64")).toBe("Ctrl");
  });
});

describe("command palette listbox structure", () => {
  // The listbox is the accessibility tree the combobox points at with
  // aria-controls: a paragraph parked between the options is an unlabelled
  // child of a role="listbox", and screen readers count it as one more row.
  it("keeps the results listbox free of non-option children", () => {
    const source = readFileSync("src/components/CommandPalette.jsx", "utf8");
    const start = source.indexOf('<div id="command-palette-list"');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("</div>", start);
    expect(end).toBeGreaterThan(start);
    const listbox = source.slice(start, end);
    // The slice stops at the first closing tag, so it is the whole listbox
    // only while nothing nested opens another one.
    expect(listbox.match(/<div[\s>]/g)).toHaveLength(1);

    expect([...listbox.matchAll(/\brole="([^"]+)"/g)].map((match) => match[1])).toEqual(["listbox", "option"]);
    expect(listbox).not.toContain('t("command.empty")');
    expect(source).toContain('t("command.empty")');
  });
});
