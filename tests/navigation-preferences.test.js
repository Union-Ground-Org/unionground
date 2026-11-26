import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultShortcutKeys,
  loadDemoNavigationPreferences,
  MAX_SHORTCUTS,
  normalizeShortcutKeys,
  normalizeWidgetOrder,
  saveDemoNavigationPreferences,
  SHORTCUT_CATALOG,
} from "../src/lib/navigationPreferences.js";

beforeEach(() => window.localStorage.clear());

describe("navigation preference contracts", () => {
  it("preserves the last shipped member and steward defaults", () => {
    // Find my steward became a member default on 2026-09-22 (owner order): the
    // member's most common action had no Home entry at all. It took the sixth
    // slot from "numbers", which is still a Home chip and a rail item. The
    // steward default is deliberately unchanged.
    expect(defaultShortcutKeys(false)).toEqual(["today", "find-steward", "voting", "rights", "compass", "settings"]);
    expect(defaultShortcutKeys(true)).toEqual(["today", "cases", "messages", "numbers", "compass", "settings"]);
  });

  it("keeps only distinct backed shortcuts in member order and caps at six", () => {
    expect(normalizeShortcutKeys([
      "cases", "cases", "not-a-route", "messages", "events", "rights", "forms", "search", "settings",
    ], false)).toEqual(["cases", "messages", "events", "rights", "forms", "search"]);
    expect(normalizeShortcutKeys(["cases"], false)).toEqual(["cases"]);
    expect(MAX_SHORTCUTS).toBe(6);
    for (const item of SHORTCUT_CATALOG) {
      if (item.action === "assistant") expect(item.key).toBe("compass");
      else expect(item.path).toMatch(/^\/m(?:\/|$)/);
    }
  });

  it("falls back to persona defaults when no valid shortcut survives", () => {
    expect(normalizeShortcutKeys([], false)).toEqual(defaultShortcutKeys(false));
    expect(normalizeShortcutKeys(["unknown", null], true)).toEqual(defaultShortcutKeys(true));
    expect(normalizeShortcutKeys("cases", false)).toEqual(defaultShortcutKeys(false));
  });

  it("keeps saved widget order and appends every missing canonical widget", () => {
    expect(normalizeWidgetOrder(["cases", "messages", "cases", "unknown"])).toEqual([
      "cases", "messages", "appointments", "forms", "workload", "numbers",
    ]);
    expect(normalizeWidgetOrder(null)).toEqual(["messages", "appointments", "cases", "forms", "workload", "numbers"]);
  });

  it("isolates demo preferences by member and drops the obsolete global widget key", () => {
    window.localStorage.setItem("sg-work-widgets", JSON.stringify(["cases"]));
    saveDemoNavigationPreferences("member-a", {
      shortcutKeys: ["cases"],
      workWidgetOrder: ["cases", "messages"],
    });

    expect(loadDemoNavigationPreferences("member-a")).toEqual({
      shortcutKeys: ["cases"],
      workWidgetOrder: ["cases", "messages", "appointments", "forms", "workload", "numbers"],
    });
    expect(loadDemoNavigationPreferences("member-b")).toBeNull();
    expect(window.localStorage.getItem("sg-work-widgets")).toBeNull();
  });

  it("treats malformed or empty demo records as absent", () => {
    window.localStorage.setItem("sg-navigation-preferences:bad-json", "{");
    window.localStorage.setItem("sg-navigation-preferences:bad-shape", JSON.stringify({ shortcutKeys: "cases" }));
    expect(loadDemoNavigationPreferences("bad-json")).toBeNull();
    expect(loadDemoNavigationPreferences("bad-shape")).toBeNull();
    expect(loadDemoNavigationPreferences("")).toBeNull();
  });
});
