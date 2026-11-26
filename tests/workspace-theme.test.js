import { describe, expect, it } from "vitest";

import * as workspaceThemes from "../src/lib/workspaceTheme.js";

const { deriveWorkspaceTheme, HAT_WORKSPACE_THEMES, resolveRenderedWorkspaceTheme } = workspaceThemes;

// Behaviour coverage for the hat -> theme contract, rewritten in design Step 2
// (October 2 design direction, decision 2: "One identity for every role, on web
// and native ... The per-role palettes are retired").
//
// Superseded rule, quoted from this test until Step 2: "gives every hat its own
// distinct baseline theme" (owner feedback 2026-08-25, "all hats are using the
// same theme" — they must not), plus "a selected app theme is system-wide with
// the steward pin" and "selects Union Ground Evergreen only for the outer
// desktop shell". The owner's rulings of October 3, 2026 1:40 PM ET retire the
// five selectable palettes and fold Night Shift into dark mode; the owner's
// ruling of November 3, 2026 (Union green is the only theme and the default
// for every account) retires the steward's Harbor Ledger exception.
describe("deriveWorkspaceTheme", () => {
  it("gives every hat, the steward included, the one Union Ground identity", () => {
    for (const hat of ["member", "steward", "coordinator", "advisor", "admin", "vp"]) {
      expect(deriveWorkspaceTheme("today", hat, null), hat).toBe("union-ground");
    }
    expect(deriveWorkspaceTheme("steward", "steward", "member")).toBe("union-ground");
    expect(new Set(Object.values(HAT_WORKSPACE_THEMES))).toEqual(new Set(["union-ground"]));
    expect(Object.keys(HAT_WORKSPACE_THEMES).sort()).toEqual(["admin", "advisor", "coordinator", "member", "steward", "vp"]);
    expect(workspaceThemes).not.toHaveProperty("STEWARD_WORKSPACE_THEME");
  });

  it("keeps the arriving hat's shell on shared chapter work", () => {
    expect(deriveWorkspaceTheme("tasks", "coordinator", "member")).toBe("union-ground");
    expect(deriveWorkspaceTheme("tasks", "coordinator", "steward")).toBe("union-ground");
    expect(deriveWorkspaceTheme("campaigns", "coordinator", "steward")).toBe("union-ground");
    expect(deriveWorkspaceTheme("campaigns", "coordinator", "member")).toBe("union-ground");
  });

  it("falls back to the capability hat on a cold chapter-work entry", () => {
    expect(deriveWorkspaceTheme("tasks", "coordinator", null)).toBe("union-ground");
    expect(deriveWorkspaceTheme("tasks", "steward", null)).toBe("union-ground");
  });

  it("yields no theme for an unknown hat", () => {
    expect(deriveWorkspaceTheme("today", null, null)).toBe(null);
  });

  // A palette saved by the retired picker ("sg-app-theme") is ignored safely:
  // a fourth argument from an old caller changes nothing and never throws.
  it("ignores a retired palette selection", () => {
    expect(deriveWorkspaceTheme("today", "member", null, "night-shift")).toBe("union-ground");
    expect(deriveWorkspaceTheme("admin", "admin", null, "collected")).toBe("union-ground");
    expect(deriveWorkspaceTheme("steward", "steward", null, "cobalt-signal")).toBe("union-ground");
    expect(deriveWorkspaceTheme("steward", "steward", null, "harbor-ledger")).toBe("union-ground");
  });
});

describe("resolveRenderedWorkspaceTheme", () => {
  it("no longer forces Union Ground Evergreen on any shell", () => {
    expect(resolveRenderedWorkspaceTheme("union-ground", false)).toBe("union-ground");
    expect(resolveRenderedWorkspaceTheme(null, false)).toBe(null);
    expect(resolveRenderedWorkspaceTheme("union-ground")).toBe("union-ground");
  });

  it("never renders the identity's dark form, whatever an old caller passes", () => {
    // REQ-UG-DISABLE-DARK-MODE-WEB-AND-MOBILE-20261105: light only.
    expect(resolveRenderedWorkspaceTheme("union-ground", true)).toBe("union-ground");
    expect(resolveRenderedWorkspaceTheme(deriveWorkspaceTheme("today", "steward", null), true)).toBe("union-ground");
    expect(resolveRenderedWorkspaceTheme(null, true)).toBe(null);
  });
});
