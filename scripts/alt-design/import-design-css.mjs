#!/usr/bin/env node
// Import the stylesheet of a Union Ground design-alternate HTML export into the
// alternate web shell (src/alt). The export is a self-contained page whose
// <style> blocks carry the whole design system; this script turns them into a
// stylesheet that can live beside the production app without touching it:
//
//   - every class selector `.name` becomes `.ug-name`, so nothing in
//     src/styles.css can match the alternate shell's markup and nothing here
//     can match a production view mounted inside it;
//   - every custom property `--name` becomes `--ug-name`, declarations and
//     var() references alike, because thirteen of the design's names
//     (--green, --ink, --muted, --gold, ...) already exist in src/sg-tokens.css
//     and src/styles.css with different values;
//   - `:root`, `html` and `body` rules move onto the shell root `.ugalt`, and
//     bare element rules (a, button, h1...) are scoped under it, so the
//     alternate shell styles only what it renders;
//   - @keyframes names take the same `ug-` prefix as the classes;
//   - @font-face blocks are dropped: production already serves Archivo, Public
//     Sans and Spline Sans Mono from /assets (src/styles.css:1-24) and the
//     export inlines them as data URIs (2 MB of the 2.1 MB file).
//
// Usage: node scripts/alt-design/import-design-css.mjs <export.html> [out.css]
// The default output is src/alt/styles/design.css. Re-run it whenever the owner
// exports a newer revision; review the diff like any other stylesheet change.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";

export const SHELL_ROOT_CLASS = "ugalt";
// Production trees mounted inside the chrome (legacy views, the production
// home cards, the sign-in form) keep their own element styling: a scoped
// element rule is excluded from them at zero specificity.
export const PRODUCTION_TREES = ":where(:not(.ug-legacy *, .ug-legacy-cards *, .ug-signin *))";
export const CLASS_PREFIX = "ug-";
export const VAR_PREFIX = "ug-";

const ROOT_SELECTORS = new Set([":root", "html", "body"]);

// Rename custom properties in raw text: declarations (`--ink:`) and references
// (`var(--ink)`, `var(--ink, fallback)`). CSS has no other `--x` token, and the
// design never uses the prefix itself, so the replacement is total.
export function prefixCustomProperties(css) {
  return css.replace(/--(?=[a-zA-Z_])/g, `--${VAR_PREFIX}`);
}

// `.name` -> `.ug-name` inside one selector. Attribute-selector strings are the
// only place a dot could mean something else; the design has none, but the
// regex still skips anything inside [...] to stay honest about it.
export function prefixClassesInSelector(selector) {
  return selector.split(/(\[[^\]]*\])/).map((part, index) => (
    index % 2 === 1 ? part : part.replace(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g, `.${CLASS_PREFIX}$1`)
  )).join("");
}

// One compound selector (already class-prefixed) scoped to the shell root.
// `:root`, `html` and `body` become the root itself; `body.x` / `body:has()`
// keep their qualifiers on the root; everything else that starts with an
// element name or `*` is nested under `:where(.ugalt)` as a descendant and
// excluded from production trees (see excludeProductionTrees). Selectors that
// already start with a `.ug-` class, an id or a pseudo-class are left alone:
// the class prefix is what isolates them.
export function scopeSelector(selector) {
  const trimmed = selector.trim();
  if (!trimmed) return trimmed;
  const root = `.${SHELL_ROOT_CLASS}`;
  const head = trimmed.match(/^([a-zA-Z][a-zA-Z0-9-]*|\*|:root)/)?.[1] ?? null;
  if (head && ROOT_SELECTORS.has(head)) return root + trimmed.slice(head.length);
  // :where() keeps the rule at element specificity, so a scoped `button{}`
  // still loses to the design's own single-class rules as it did unscoped.
  if (head) return `:where(${root}) ${excludeProductionTrees(trimmed)}`;
  return trimmed;
}

// A selector whose subject is an element or `*` (no design class or id
// anywhere) gets the production-tree exclusion on its subject, before any
// pseudo-element.
export function excludeProductionTrees(selector) {
  if (/[.#]/.test(selector)) return selector;
  return selector.replace(/(::[a-zA-Z-]+(?:\([^)]*\))?)?$/, (match, pseudoElement) => `${PRODUCTION_TREES}${pseudoElement ?? ""}`);
}

export function transformSelectorList(selectorList) {
  return selectorList
    .split(/\s*,\s*/)
    .map((selector) => scopeSelector(prefixClassesInSelector(selector)))
    .join(", ");
}

export function extractStyleBlocks(html) {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1]);
}

export function transformCss(rawCss, { sourceName = "design export", sourceSha256 = "" } = {}) {
  const root = postcss.parse(prefixCustomProperties(rawCss));
  const keyframeNames = new Set();
  root.walkAtRules("font-face", (rule) => rule.remove());
  root.walkAtRules(/^(-webkit-)?keyframes$/, (rule) => {
    keyframeNames.add(rule.params.trim());
    rule.params = `${CLASS_PREFIX}${rule.params.trim()}`;
  });
  root.walkRules((rule) => {
    // Selectors inside @keyframes are percentages/from/to, not element names.
    if (rule.parent?.type === "atrule" && /keyframes$/.test(rule.parent.name)) return;
    rule.selector = transformSelectorList(rule.selector);
  });
  root.walkDecls(/^animation(-name)?$/, (decl) => {
    for (const name of keyframeNames) {
      decl.value = decl.value.replace(new RegExp(`(^|[\\s,])${name}(?=$|[\\s,])`, "g"), `$1${CLASS_PREFIX}${name}`);
    }
  });
  applyRepositoryFloors(root);
  const header = [
    "/* GENERATED by scripts/alt-design/import-design-css.mjs. Do not edit by hand:",
    `   re-run the script against the design export instead. Source: ${sourceName}`,
    sourceSha256 ? `   (sha256 ${sourceSha256}).` : "",
    "   Classes are prefixed ug-, custom properties --ug-, root rules live on .ugalt, element rules under :where(.ugalt). */",
  ].filter(Boolean).join("\n");
  return `${header}\n${root.toString().trim()}\n`;
}

// The repository's stylesheet floors, enforced by tests/density-floor.test.js,
// tests/input-zoom-floor.test.js and tests/reduced-motion-guard.test.js on every
// sheet under src/: nothing readable below 11px and no font-size: 0 (the
// design hid calendar-mark text that way; clipping takes over), every
// input/textarea/select at 16px or more so iOS does not zoom, and every hover
// or press transform reset under prefers-reduced-motion: reduce.
const READABLE_FLOOR_PX = 11;
const FOCUSABLE_FLOOR_PX = 16;
const FOCUSABLE_SELECTOR = /(?:^|[\s>+~,(])(?:input|textarea|select)(?![-\w])/;
const MOVING_PROPERTIES = ["transform", "scale", "translate", "rotate"];
const STATE_SELECTOR = /:(hover|active)\b/;
function pixels(value) {
  // A bare 0 is a length too (the design wrote font-size:0 without a unit).
  const match = /^([\d.]+)(px)?$/.exec(value.trim());
  if (!match || (match[2] !== "px" && Number(match[1]) !== 0)) return null;
  return Number(match[1]);
}
export function applyRepositoryFloors(root) {
  root.walkDecls("font-size", (decl) => {
    const size = pixels(decl.value);
    if (size == null) return;
    if (size === 0) {
      decl.replaceWith(postcss.decl({ prop: "overflow", value: "hidden" }));
      return;
    }
    if (size < READABLE_FLOOR_PX) decl.value = `${READABLE_FLOOR_PX}px`;
    if (size < FOCUSABLE_FLOOR_PX && FOCUSABLE_SELECTOR.test(decl.parent.selector)) decl.value = `${FOCUSABLE_FLOOR_PX}px`;
  });
  const movers = new Map();
  root.walkRules((rule) => {
    const parent = rule.parent;
    if (parent?.type === "atrule" && (/keyframes$/.test(parent.name) || /prefers-reduced-motion/.test(parent.params))) return;
    const stateSelectors = rule.selectors.filter((selector) => STATE_SELECTOR.test(selector));
    if (stateSelectors.length === 0) return;
    for (const property of MOVING_PROPERTIES) {
      if (!rule.some((node) => node.type === "decl" && node.prop === property)) continue;
      for (const selector of stateSelectors) movers.set(`${property} ${selector}`, { property, selector });
    }
  });
  if (movers.size === 0) return;
  const reduce = postcss.atRule({ name: "media", params: "(prefers-reduced-motion:reduce)" });
  for (const { property, selector } of movers.values()) {
    reduce.append(postcss.rule({ selector }).append(postcss.decl({ prop: property, value: "none" })));
  }
  root.append(reduce);
}

export function importDesignCss(htmlPath) {
  const html = readFileSync(htmlPath, "utf8");
  const blocks = extractStyleBlocks(html);
  if (blocks.length === 0) throw new Error(`${htmlPath}: no <style> block found`);
  const sha = createHash("sha256").update(html).digest("hex");
  return transformCss(blocks.join("\n"), { sourceName: basename(htmlPath), sourceSha256: sha });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , input, output = "src/alt/styles/design.css"] = process.argv;
  if (!input) {
    console.error("usage: node scripts/alt-design/import-design-css.mjs <export.html> [out.css]");
    process.exit(2);
  }
  const css = importDesignCss(resolve(input));
  writeFileSync(resolve(output), css);
  console.log(`wrote ${output} (${css.length} bytes)`);
}
