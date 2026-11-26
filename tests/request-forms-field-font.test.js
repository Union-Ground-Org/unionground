import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// /join, /request-invite and /contribute wrap each field in its label, and the
// field rules use `font: inherit`, so typed text and chosen options took the
// label's 800-weight display face (presentation).

const css = readFileSync("src/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("public request form fields", () => {
  it("render entered text in the regular body face after the inheriting field rules", () => {
    const fix = css.match(/\.rqi-form input,\s*\.rqi-form select,\s*\.rqi-form textarea\s*\{([^}]*)\}/);
    expect(fix).not.toBeNull();
    expect(fix[1]).toMatch(/font-family:\s*var\(--sg-font-family-body\)/);
    expect(fix[1]).toMatch(/font-weight:\s*400/);
    // The override must come after every `font: inherit` field rule it corrects.
    const at = fix.index;
    for (const selector of [".rqi-form textarea { width: 100%", ".rqi-form select { width: 100%"]) {
      const inherit = css.indexOf(selector);
      expect(inherit, selector).toBeGreaterThan(-1);
      expect(inherit).toBeLessThan(at);
    }
  });

  it("keeps the labels in the bold display face", () => {
    expect(css).toMatch(/\.rqi-form label\s*\{[^}]*font-family:\s*var\(--display\);[^}]*font-weight:\s*800/);
  });
});
