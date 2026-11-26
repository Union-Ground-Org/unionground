import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { stripComments } from "../scripts/lib/css-vars.mjs";

// src/motion.css already refuses to ship the handoff's D6 .sg-skeleton because
// nothing in src/ applies that class, so it would be dead on arrival. The D5
// ambient-life carriers were retired the same way — Compass sparkle with the
// Wave-2c guide2 sheet, sg-drift with .member-card — but @keyframes sg-pulse
// was left behind with no animation/animation-name consumer. A comment-only
// reservation is the honest form of "kept in reserve"; an unreferenced
// keyframe is the form that silently bloats the sheet. This gate is the
// tripwire for the next unused motion name.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const read = (rel) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

const ANIMATION_KEYWORDS = new Set([
  "alternate",
  "alternate-reverse",
  "backwards",
  "both",
  "ease",
  "ease-in",
  "ease-in-out",
  "ease-out",
  "forwards",
  "infinite",
  "inherit",
  "initial",
  "jump-both",
  "jump-end",
  "jump-none",
  "jump-start",
  "linear",
  "none",
  "normal",
  "paused",
  "revert",
  "revert-layer",
  "reverse",
  "running",
  "unset",
]);

function filesUnder(dir, ext, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return filesUnder(join(dir, entry.name), ext, rel);
    return entry.name.endsWith(ext) ? [rel] : [];
  });
}

function definedKeyframes(css) {
  return [...stripComments(css).matchAll(/@keyframes\s+([A-Za-z_][\w-]*)/g)].map((match) => match[1]);
}

function addIdentNames(value, into) {
  const ident = /(?<![-\w])([A-Za-z_][\w-]*)(\s*\()?/g;
  let match;
  while ((match = ident.exec(value)) !== null) {
    if (match[2]) continue;
    const name = match[1];
    if (!ANIMATION_KEYWORDS.has(name.toLowerCase())) into.add(name);
  }
}

function animationNamesInCss(css) {
  const names = new Set();
  const body = stripComments(css);
  for (const match of body.matchAll(/animation-name\s*:\s*([^;{}]+)/gi)) {
    addIdentNames(match[1], names);
  }
  for (const match of body.matchAll(/(?<![\w-])animation\s*:\s*([^;{}]+)/gi)) {
    addIdentNames(match[1], names);
  }
  return names;
}

function animationNamesInJs(source) {
  const names = new Set();
  const withoutLine = source.replace(/^\s*\/\/.*$/gm, "");
  const withoutBlock = withoutLine.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of withoutBlock.matchAll(/animation(?:Name)?\s*[:=]\s*(["'`])([^"'`]+)\1/g)) {
    addIdentNames(match[2], names);
  }
  return names;
}

describe("src/motion.css keyframes stay referenced", () => {
  const motionCss = read("src/motion.css");
  const keyframes = definedKeyframes(motionCss);
  const used = new Set();

  for (const file of filesUnder(srcDir, ".css")) {
    for (const name of animationNamesInCss(read(join("src", file)))) used.add(name);
  }
  for (const ext of [".js", ".jsx"]) {
    for (const file of filesUnder(srcDir, ext)) {
      for (const name of animationNamesInJs(read(join("src", file)))) used.add(name);
    }
  }

  it("defines at least one keyframe so an emptied sheet cannot pass vacuously", () => {
    expect(keyframes.length).toBeGreaterThan(0);
  });

  it("names every @keyframes from a src animation or animation-name", () => {
    const unused = keyframes.filter((name) => !used.has(name));
    expect(
      unused,
      "src/motion.css @keyframes with no animation/animation-name consumer in src/. " +
        "Retire the block (and name it in the D5 ambient-life comment if it lost its carrier), " +
        "or keep it only once a real carrier exists. Dead-on-arrival motion is the D6 covenant " +
        "the file header already states for .sg-skeleton.",
    ).toEqual([]);
  });
});
