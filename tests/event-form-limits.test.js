import { describe, expect, it } from "vitest";
import { EVENT_FORM_LIMITS, eventIdFromTitle } from "../src/lib/eventFormLimits.js";

// UX-UG-NEW-EVENT-ASKS-FOR-A-LOWERCASE-SLUG-FIRST-20261125 (#9985):
// the web name a new event gets from its title. Fictional titles only.
describe("eventIdFromTitle", () => {
  const idPattern = new RegExp(`^(?:${EVENT_FORM_LIMITS.id.pattern})$`);

  it("gives an empty name for a missing title", () => {
    expect(eventIdFromTitle(undefined)).toBe("");
    expect(eventIdFromTitle(null)).toBe("");
    expect(eventIdFromTitle("")).toBe("");
  });

  it("lowercases an accented title and joins its words with single hyphens", () => {
    expect(eventIdFromTitle("  Mañana: Tamarack Rally, 2026!  ")).toBe("manana-tamarack-rally-2026");
    expect(eventIdFromTitle("Café — Steward Q&A")).toBe("cafe-steward-q-a");
    expect(idPattern.test(eventIdFromTitle("Mañana: Tamarack Rally, 2026!"))).toBe(true);
  });

  it("cuts a long title to the limit with no trailing hyphen", () => {
    const title = `${"a".repeat(63)} b and more words after the limit`;
    const id = eventIdFromTitle(title);
    expect(id).toBe("a".repeat(63));
    expect(id.length).toBeLessThanOrEqual(EVENT_FORM_LIMITS.id.max);
    expect(id.endsWith("-")).toBe(false);
    expect(idPattern.test(id)).toBe(true);
  });
});
