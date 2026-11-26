import { describe, expect, it } from "vitest";
import { webNameFrom } from "../src/lib/webName.js";
import { eventIdFromTitle } from "../src/lib/eventFormLimits.js";

// The web name an event or chapter gets from the words the person typed.
// Fictional names only.
describe("webNameFrom", () => {
  it("gives an empty name for missing text", () => {
    expect(webNameFrom(undefined, 32)).toBe("");
    expect(webNameFrom(null, 32)).toBe("");
    expect(webNameFrom("   ", 32)).toBe("");
  });

  it("lowercases accented words and joins them with single hyphens", () => {
    expect(webNameFrom("  Tamarack Peña — North Depot!  ", 32)).toBe("tamarack-pena-north-depot");
  });

  it("cuts to the limit with no trailing hyphen", () => {
    expect(webNameFrom(`${"b".repeat(31)} c`, 32)).toBe("b".repeat(31));
    expect(webNameFrom("Larkspur Main Depot and Annex Workers", 32)).toBe("larkspur-main-depot-and-annex-wo");
  });

  it("gives a new event its web name at the 64-character event limit", () => {
    const title = "Tamarack Valley Human Services Union Quarterly All-Chapter Membership Meeting";
    expect(title.length).toBeGreaterThan(64);
    expect(eventIdFromTitle(title)).toBe("tamarack-valley-human-services-union-quarterly-all-chapter-membe");
  });
});
