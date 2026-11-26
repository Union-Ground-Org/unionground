// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// BUG-UG-EVENTS-FORM-INVALID-PATTERN-ATTRIBUTE-20261003: browsers
// compile an input's pattern as `^(?:pattern)$` with the `v` flag, where a bare
// `-` at the end of a character class is a syntax error. The browser then logs
// the error and skips that field's validation entirely (the event form's id
// field in the October 3 pilot). Literal attributes are checked here. The
// event authoring and message-to-event suites check the generated attributes
// on the rendered inputs.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(jsx?|tsx?)$/.test(name) ? [path] : [];
  });
}

const patterns = sourceFiles(SRC).flatMap((file) => [...readFileSync(file, "utf8").matchAll(/\bpattern="([^"]*)"/g)]
  .map((match) => ({ file: relative(ROOT, file), pattern: match[1] })));

const compile = (pattern) => new RegExp(`^(?:${pattern})$`, "v");

describe("HTML pattern attributes", () => {
  it("finds the form patterns to check", () => {
    // Some literals have moved to generated attributes. The event and template
    // editor suites compile those patterns on the rendered inputs.
    expect(patterns.length).toBeGreaterThanOrEqual(15);
  });

  it("compiles every pattern the way the browser does", () => {
    const invalid = patterns.filter(({ pattern }) => {
      try { compile(pattern); return false; } catch { return true; }
    }).map(({ file, pattern }) => `${file}: ${pattern}`);
    expect(invalid).toEqual([]);
  });

  it("keeps the recovery code field accepting the issued code shape", () => {
    const recovery = patterns.find(({ file, pattern }) => file === "src/components/MfaSettings.jsx" && pattern.includes("{18,32}"));
    const re = compile(recovery.pattern);
    expect(re.test("PSG-2448-D592-435A-B401")).toBe(true);
    expect(re.test("PSG 2448")).toBe(false);
  });
});
