// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Browser geometry and rendered colour proofs belong to the installed-browser
// assurance runner in e2e/assurance-smoke.spec.js, not default Vitest.
const styles = readFileSync("src/styles.css", "utf8");

describe("Events theme surface contract", () => {
  it("derives the raised card gradient from semantic surface tokens", () => {
    const rule = styles.match(/\.mevents-list-card,\s*\.mevents-card,\s*\.mevents-history__toggle\s*\{([^}]*)\}/)?.[1] ?? "";
    const background = rule.match(/\bbackground:\s*([^;]+);/)?.[1] ?? "";

    expect(background).toBe(
      "linear-gradient(180deg, color-mix(in srgb, var(--card) 99%, var(--card-foreground)), var(--card))",
    );
    expect(background).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});

describe("Calendar responsive source contract", () => {
  it("keeps calendar copy in the flexible column and actions in their own row", () => {
    const calendarGrid = styles.match(/\.mevents-calendar-card \.mevents-card__row\s*\{([^}]*)\}/)?.[1] ?? "";
    const calendarActions = [...styles.matchAll(/\.mevents-calendar-actions\s*\{([^}]*)\}/g)]
      .map((match) => match[1]).find((rule) => rule.includes("grid-column")) ?? "";
    expect(calendarGrid).toMatch(/display:\s*grid;/);
    expect(calendarGrid).toMatch(/grid-template-columns:\s*40px\s+minmax\(0,\s*1fr\);/);
    expect(calendarActions).toMatch(/grid-column:\s*1\s*\/\s*-1;/);
    expect(calendarActions).toMatch(/width:\s*100%;/);
  });
});

describe("Events interaction target contract", () => {
  it("keeps the secondary check-in action at the web touch-target floor", () => {
    const rule = styles.match(/\.mevents-linkbtn\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(rule).toMatch(/\bdisplay:\s*inline-flex\s*;/);
    expect(rule).toMatch(/\bmin-height:\s*44px\s*;/);
    expect(rule).toMatch(/\balign-items:\s*center\s*;/);
  });
});
