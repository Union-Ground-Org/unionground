import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { stripComments } from "../scripts/lib/css-vars.mjs";

// A border-radius that reads an undefined custom property is not a soft miss.
// `border-radius: var(--radius)` with no --radius anywhere is INVALID AT
// COMPUTED-VALUE TIME, so the browser throws the whole declaration away and
// paints the 0 initial value — square corners, no console warning, no failing
// test. Four rules shipped that way (.case-files__upload input,
// .case-files__list li, .gq-write__form :is(input, select, textarea) and
// .procedure-settings fieldset), reading a --radius that only ever existed in
// unshipped design-source HTML.
//
// tests/sg-tokens.test.js already pins every `--sg-*` reference against the
// vendored token file. That guard could not see this one: --radius is not an
// --sg-* name, so an alias nothing defines slipped straight past it. This file
// closes the complement for the radius channel — every custom property a
// shipped stylesheet reads FOR A RADIUS must be defined by some shipped
// stylesheet.
//
// Three layers, the same shape tests/styles-token-aliases.test.js uses:
//   1. the readers, behaviourally, against hand-built sheets
//   2. the whole shipped stylesheet set
//   3. the four repaired call sites, by name

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/**
 * Every radius declaration in the sheet, as written.
 *
 * The leading `(?:^|[;{])` is load-bearing twice over: it keeps the match
 * anchored to the start of a declaration, and it is what stops
 * `--sg-border-radius`-shaped custom-property names from being read as the
 * property they are named after.
 */
const RADIUS_DECLARATION = /(?:^|[;{])\s*(border(?:-[a-z]+)*?-radius)\s*:\s*([^;}]*)/g;

/** Every `-radius:` property in the sheet, however it is written. */
const ANY_RADIUS_PROPERTY = /(?<![\w-])[a-z-]*-radius\s*:/g;

/**
 * A reference with NO fallback: `var(--x)`, not `var(--x, 10px)`.
 *
 * The fallback form is deliberately not reported. `var(--x, 10px)` computes to
 * 10px when --x is missing, which is a corner someone chose rather than the 0
 * the browser substitutes for a declaration it had to discard.
 */
const BARE_VAR_REFERENCE = /var\(\s*(--[\w-]+)\s*([,)])/g;

function radiusReferences(css) {
  const found = [];
  const text = stripComments(css);
  for (const declaration of text.matchAll(RADIUS_DECLARATION)) {
    for (const reference of declaration[2].matchAll(BARE_VAR_REFERENCE)) {
      if (reference[2] === ")") found.push({ property: declaration[1], name: reference[1] });
    }
  }
  return found;
}

/**
 * Custom properties the sheet DECLARES, at any scope.
 *
 * Scope is deliberately not modelled. The defect this guards is a name no
 * stylesheet defines at all, and a name that exists only under `.tasks-screen`
 * is a narrower question than "does this resolve anywhere" — one a scope-aware
 * reader would have to answer per element. Comments are stripped first, for the
 * reason scripts/lib/css-vars.mjs records: a commented-out declaration is more
 * text that matches, and letting it count would let a note disarm the check.
 */
function declaredProperties(css) {
  return new Set([...stripComments(css).matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
}

const stylesheets = walk(srcDir)
  .filter((file) => file.endsWith(".css"))
  .map((file) => ({ path: relative(root, file).replaceAll("\\", "/"), css: readFileSync(file, "utf8") }));

describe("radius custom-property readers", () => {
  it("reports a radius reference no sheet defines", () => {
    expect(radiusReferences(".a { border-radius: var(--radius); }"))
      .toEqual([{ property: "border-radius", name: "--radius" }]);
  });

  it("reads radius longhands, not only the shorthand", () => {
    expect(radiusReferences(".a { border-top-left-radius: var(--corner); }"))
      .toEqual([{ property: "border-top-left-radius", name: "--corner" }]);
  });

  it("reads every reference in a multi-value shorthand", () => {
    expect(radiusReferences(".a { border-radius: var(--one) var(--two); }").map((r) => r.name))
      .toEqual(["--one", "--two"]);
  });

  it("leaves a reference that carries a fallback alone", () => {
    expect(radiusReferences(".a { border-radius: var(--radius, 10px); }")).toEqual([]);
  });

  it("does not mistake a radius TOKEN NAME for a radius property", () => {
    expect(radiusReferences(":root { --sg-border-radius: var(--radius); }")).toEqual([]);
  });

  it("does not count a commented-out declaration as a definition", () => {
    expect(declaredProperties("/* rejected: --radius: 14px; */ .a { color: red; }").has("--radius"))
      .toBe(false);
  });

  it("collects definitions from scoped blocks, not only :root", () => {
    const declared = declaredProperties(":root { --a: 1px; } .scope { --b: 2px; }");
    expect([...declared].sort()).toEqual(["--a", "--b"]);
  });
});

describe("shipped stylesheets", () => {
  const declared = new Set(stylesheets.flatMap(({ css }) => [...declaredProperties(css)]));

  it("reads every radius declaration in the sheet, not only the ones it can parse", () => {
    // A reader that silently drops the declarations it cannot parse reports the
    // same clean result as one that verified them, so the count is pinned
    // against a naive scan rather than trusted.
    for (const { path, css } of stylesheets) {
      const text = stripComments(css);
      const parsed = [...text.matchAll(RADIUS_DECLARATION)].length;
      const naive = [...text.matchAll(ANY_RADIUS_PROPERTY)].length;
      expect(`${path}: ${parsed}`).toBe(`${path}: ${naive}`);
    }
  });

  it("never draws a corner radius from a custom property no stylesheet defines", () => {
    const unresolved = [];
    for (const { path, css } of stylesheets) {
      for (const { property, name } of radiusReferences(css)) {
        if (!declared.has(name)) unresolved.push(`${path}: ${property}: var(${name})`);
      }
    }
    expect(unresolved).toEqual([]);
  });
});

describe("the repaired rules", () => {
  const tokens = readFileSync(join(srcDir, "sg-tokens.css"), "utf8");
  const tokenValue = (name) => stripComments(tokens).match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1]?.trim();

  // selector -> the token its corner must come from. Named rather than derived,
  // because the point of the pin is that a future edit cannot quietly put these
  // back on an alias the token layer does not own.
  const SITES = {
    "src/styles.css": {
      ".case-files__upload input": "--sg-radius-sm",
      ".case-files__list li": "--sg-radius-lg",
      ".gq-write__form :is(input, select, textarea)": "--sg-radius-sm",
    },
  };

  // Union Ground left grievance procedures out, so the procedure editor's
  // stylesheet (the fourth repaired rule) must not come back.
  it("ships no procedure-settings stylesheet or rule", () => {
    expect(stylesheets.map(({ path }) => path)).not.toContain("src/components/caseworkProcedureEditor.css");
    const procedureRules = stylesheets.filter(({ css }) => /\.procedure-settings\b/.test(stripComments(css)));
    expect(procedureRules.map(({ path }) => path)).toEqual([]);
  });

  for (const [path, sites] of Object.entries(SITES)) {
    const css = readFileSync(join(root, path), "utf8");
    for (const [selector, token] of Object.entries(sites)) {
      it(`${path} — ${selector} reads ${token}`, () => {
        const rule = stripComments(css)
          .split("\n")
          .find((line) => line.trimStart().startsWith(`${selector} {`));
        expect(rule, `${selector} is no longer a single-line rule in ${path}`).toBeDefined();
        expect(radiusReferences(rule)).toEqual([{ property: "border-radius", name: token }]);
      });
    }
  }

  it("draws a non-zero corner from the token layer", () => {
    for (const token of new Set(Object.values(SITES).flatMap((sites) => Object.values(sites)))) {
      const value = tokenValue(token);
      expect(value, `${token} is not defined in src/sg-tokens.css`).toBeDefined();
      expect(Number.parseFloat(value)).toBeGreaterThan(0);
    }
  });
});
