import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const tokensCss = readFileSync(join(srcDir, "sg-tokens.css"), "utf8");

// Pin of the token file, newline-normalized so autocrlf checkouts hash identically.
//
// Superseded rule (this comment until design Step 2): "Source of truth:
// the design-system repository's tokens.css @ ac4af41 (generated
// from tokens.json — regenerate there, re-verify there, then re-vendor here and update
// this hash; hand-editing src/sg-tokens.css is never correct)."
//
// New rule (owner ruling, October 3, 2026 1:40 PM ET: "src/sg-tokens.css is the canonical
// token source"): edit src/sg-tokens.css here, run `npm run contrast:audit`, and update
// this pin and the count below in the same pull request. The pin still makes every token
// change a deliberate, reviewed edit. REQ-UG-CHAPTER-NOTICE-GLOW-COLOURS-20261113
// (#8627) added the 24 notice glow tokens (six colours and their tile fills, light
// and dark): 311 + 24 = 335. UX-UG-WEBSITE-ONE-STANDARD-PAGE-WIDTH-20261116
// (#8993) added the page-width block (--ug-wrap and --ug-gutter, the alternate
// design's names, outside the --sg- count), so the count stays 335.
// UX-UG-THEME-CORNERS-HEADINGS-AND-LAYOUT-GAPS-FROM-NOV-15-SWEEPS-20261117 set
// four existing values to the promo package's tokens.json (card corners 16px in
// --sg-corner-card and --sg-radius-card, control corners 10px, line-strong #4f5a54 in
// --sg-color-border-strong); contrast:audit passes and no token was added, so 335 stays.
// a review note deleted the dormant dark form (owner order of November 5, 2026,
// REQ-UG-DISABLE-DARK-MODE-WEB-AND-MOBILE-20261105): its 64 --sg-dark-* roles and
// --sg-depth-1-dark, read by no rule any more: 335 - 65 = 270.
const PINNED_SHA256 = "b4b57769ee8836a8df199a66ff5f4cd0acf3d4c6f9895017fa899eda76272901";

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe("Union Base design tokens", () => {
  const defined = new Set([...tokensCss.matchAll(/(--sg-[\w-]+):/g)].map((m) => m[1]));

  it("keeps the canonical token file byte-identical to its pin", () => {
    const normalized = tokensCss.replace(/\r\n/g, "\n");
    expect(createHash("sha256").update(normalized).digest("hex")).toBe(PINNED_SHA256);
  });

  it("defines all 270 tokens", () => {
    expect(defined.size).toBe(270);
  });

  it("names itself the canonical token source, not a generated copy", () => {
    expect(tokensCss.split("\n")[0]).toMatch(/Canonical in this repository/);
    expect(tokensCss).not.toMatch(/Do not edit by hand/);
  });

  // October 2 design direction, decision 2 (one identity), built in design Step 2.
  // Superseded: "every role has a light and a dark value" (build-order section 2.1);
  // the site renders light only (owner order of November 5, 2026), so every role
  // has one light value and the dormant dark values are deleted.
  it("gives every identity role one light value and no dark value", () => {
    const light = new Set([...tokensCss.matchAll(/--sg-light-([\w-]+):/g)].map((m) => m[1]));
    expect(light.size).toBeGreaterThanOrEqual(40);
    expect(tokensCss).not.toMatch(/--sg-dark-[\w-]+:|--sg-depth-1-dark:/);
    for (const role of ["brand", "on-primary", "accent", "on-accent", "canvas", "card", "ink", "ink-2", "focus", "rail"]) {
      expect(light.has(role), role).toBe(true);
    }
    expect(tokensCss).toMatch(/--sg-light-brand: #0e4034;/);
    expect(tokensCss).toMatch(/--sg-light-accent: #efa738;/);
  });

  // build-order section 2.3: "Type: six sizes, nothing under 13px".
  it("carries the six-size type scale with nothing under 13px", () => {
    const sizes = [...tokensCss.matchAll(/--sg-type-size-([\w-]+):\s*(\d+(?:\.\d+)?)px;/g)].map((m) => [m[1], Number(m[2])]);
    expect(sizes.map(([, px]) => px).sort((a, b) => a - b)).toEqual([13, 15, 17, 21, 28, 44]);
    expect(sizes.every(([, px]) => px >= 13)).toBe(true);
  });

  it("every --sg-* reference anywhere in src resolves to a defined token", () => {
    const undefinedRefs = [];
    for (const file of walk(srcDir)) {
      if (file.endsWith("sg-tokens.css")) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/var\(\s*(--sg-[\w-]+)\s*[),]/g)) {
        if (!defined.has(m[1])) undefinedRefs.push(`${file}: ${m[1]}`);
      }
    }
    expect(undefinedRefs).toEqual([]);
  });

  it("keeps sg-tokens.css loaded before styles.css so app aliases can resolve", () => {
    const main = readFileSync(join(srcDir, "main.jsx"), "utf8");
    const sgAt = main.indexOf('import "./sg-tokens.css"');
    const stylesAt = main.indexOf('import "./styles.css"');
    expect(sgAt).toBeGreaterThan(-1);
    expect(stylesAt).toBeGreaterThan(-1);
    expect(sgAt).toBeLessThan(stylesAt);
  });
});
