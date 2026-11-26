import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Explicit on purpose. A repo-wide scan would fight suites that pair fake
// timers inside a single case. These leaked because restore sat after the
// assertions, so a throw left the fake clock or stubbed global installed.
const GUARDED_FILES = Object.freeze([
  "tests/integration-coverage-libs.test.js",
  "tests/invitation-acceptance-view.test.jsx",
]);
// i18n-coverage was the third leaking file. Its only fake clock drove the
// membership card's as-of stamp, and Union Ground has no membership card,
// so it installs nothing today. It keeps the failure-safe module-scope
// teardown anyway, so a fake clock added there later is restored on a throw.
const TEARDOWN_RETAINED_FILES = Object.freeze([
  "tests/i18n-coverage.test.jsx",
]);

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

const REGEXP_KEYWORDS = new Set([
  "return", "case", "throw", "else", "do", "in", "of", "typeof", "void",
  "delete", "await", "yield", "new", "extends", "instanceof",
]);

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function previousNonSpace(source, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(source[i])) i -= 1;
  return i >= 0 ? source[i] : "";
}

function consumeRegexp(source, start) {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "\n") return start + 1;
    if (c === "[" && !inClass) {
      inClass = true;
      i += 1;
      continue;
    }
    if (c === "]" && inClass) {
      inClass = false;
      i += 1;
      continue;
    }
    if (c === "/" && !inClass) {
      i += 1;
      while (i < source.length && /[a-z]/i.test(source[i])) i += 1;
      return i;
    }
    i += 1;
  }
  return i;
}

function isCallStart(source, index) {
  let i = index;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  return source[i] === "(";
}

/**
 * Callback bodies of afterEach calls registered at module scope.
 * A hook nested in describe does not count: it cannot cover a later sibling
 * describe, which is how i18n-coverage kept leaking past its clock block.
 */
function moduleScopeAfterEachBodies(source) {
  const bodies = [];
  const frames = [{ depth: 0 }];
  let i = 0;
  let regexpAllowed = true;
  let capture = null;
  const n = source.length;

  const moduleScope = () => frames.length === 1 && frames[0].depth === 0;

  while (i < n) {
    const frame = frames[frames.length - 1];
    if (frame.template) {
      const c = source[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        frames.pop();
        i += 1;
        regexpAllowed = false;
        continue;
      }
      if (c === "$" && source[i + 1] === "{") {
        frames.push({ depth: 0 });
        i += 2;
        regexpAllowed = true;
        continue;
      }
      i += 1;
      continue;
    }

    const c = source[i];
    const next = source[i + 1];

    if (c === "/" && next === "/") {
      i += 2;
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i = Math.min(n, i + 2);
      continue;
    }
    if (c === "'" || c === "\"") {
      const quote = c;
      i += 1;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\") i += 1;
        if (source[i] === "\n") break;
        i += 1;
      }
      i += 1;
      regexpAllowed = false;
      continue;
    }
    if (c === "`") {
      frames.push({ template: true });
      i += 1;
      continue;
    }
    if (c === "/" && regexpAllowed && previousNonSpace(source, i) !== "<") {
      const after = consumeRegexp(source, i);
      if (after > i + 1) {
        i = after;
        regexpAllowed = false;
        continue;
      }
    }
    if (c === "{") {
      frame.depth += 1;
      if (capture?.phase === "seek-open") {
        capture = { phase: "body", start: i + 1, baseDepth: frame.depth };
      }
      i += 1;
      regexpAllowed = true;
      continue;
    }
    if (c === "}") {
      if (frame.depth === 0 && frames.length > 1) {
        frames.pop();
        i += 1;
        regexpAllowed = false;
        continue;
      }
      frame.depth -= 1;
      if (
        capture?.phase === "body"
        && frames.length === 1
        && frame.depth === capture.baseDepth - 1
      ) {
        bodies.push(source.slice(capture.start, i));
        capture = null;
      }
      i += 1;
      regexpAllowed = false;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      i += 1;
      while (i < n && /[A-Za-z0-9_$]/.test(source[i])) i += 1;
      const word = source.slice(start, i);
      if (!capture && moduleScope() && word === "afterEach" && isCallStart(source, i)) {
        capture = { phase: "seek-open" };
      }
      regexpAllowed = REGEXP_KEYWORDS.has(word);
      continue;
    }
    if (/[0-9]/.test(c)) {
      i += 1;
      while (i < n && /[0-9A-Za-z._]/.test(source[i])) i += 1;
      regexpAllowed = false;
      continue;
    }
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === ")" || c === "]" || c === ".") {
      regexpAllowed = false;
      i += 1;
      continue;
    }
    regexpAllowed = true;
    i += 1;
  }

  return bodies;
}

function installsFakeTimersOrStubbedGlobals(source) {
  const code = stripComments(source);
  return /\bvi\.useFakeTimers\s*\(/.test(code) || /\bvi\.stubGlobal\s*\(/.test(code);
}

function hasFailureSafeTeardown(source) {
  return moduleScopeAfterEachBodies(source).some((body) => {
    const code = stripComments(body);
    return /\bvi\.useRealTimers\s*\(/.test(code) && /\bvi\.unstubAllGlobals\s*\(/.test(code);
  });
}

describe("fake timer and global stub teardown guard", () => {
  it("keeps the guarded file list explicit", () => {
    expect([...GUARDED_FILES]).toEqual([
      "tests/integration-coverage-libs.test.js",
      "tests/invitation-acceptance-view.test.jsx",
    ]);
    expect([...TEARDOWN_RETAINED_FILES]).toEqual(["tests/i18n-coverage.test.jsx"]);
  });

  for (const path of TEARDOWN_RETAINED_FILES) {
    it(`${path} keeps restoring timers and globals from a module-scope afterEach`, () => {
      expect(hasFailureSafeTeardown(read(path)), path).toBe(true);
    });
  }

  for (const path of GUARDED_FILES) {
    it(`${path} restores timers and globals from a module-scope afterEach`, () => {
      const source = read(path);
      // These files are the ones that install the resources. A scanner
      // that cannot see the call would skip the teardown check and pass.
      expect(installsFakeTimersOrStubbedGlobals(source), path).toBe(true);
      expect(
        hasFailureSafeTeardown(source),
        `${path} calls vi.useFakeTimers or vi.stubGlobal without a module-scope afterEach that calls vi.useRealTimers() and vi.unstubAllGlobals()`,
      ).toBe(true);
    });
  }

  it("fails the shapes that leak when an assertion throws", () => {
    const inlineRestore = `
      it("membership card", async () => {
        vi.useFakeTimers({ now: new Date("2026-03-04T17:05:00Z") });
        expect(true).toBe(true);
        vi.useRealTimers();
      });
    `;
    const nestedHook = `
      describe("clock", () => {
        afterEach(() => {
          vi.useRealTimers();
          vi.unstubAllGlobals();
        });
        it("stamps", () => { vi.useFakeTimers(); });
      });
      describe("later", () => {
        it("runs afterwards", () => { vi.stubGlobal("fetch", () => {}); });
      });
    `;
    const commentedRestore = `
      afterEach(() => {
        // vi.useRealTimers();
        // vi.unstubAllGlobals();
      });
      it("stubs fetch", () => { vi.stubGlobal("fetch", () => {}); });
    `;
    const safe = `
      const pattern = /\\{ not a block \\}/;
      function view() { return <section></section>; }
      afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
      });
      it("stamps", () => {
        vi.useFakeTimers();
        vi.stubGlobal("fetch", () => {});
      });
    `;
    const commentOnly = `
      // vi.useFakeTimers()
      it("does not install a fake clock", () => { expect(1).toBe(1); });
    `;

    expect(installsFakeTimersOrStubbedGlobals(inlineRestore)).toBe(true);
    expect(hasFailureSafeTeardown(inlineRestore)).toBe(false);
    expect(installsFakeTimersOrStubbedGlobals(nestedHook)).toBe(true);
    expect(hasFailureSafeTeardown(nestedHook)).toBe(false);
    expect(hasFailureSafeTeardown(commentedRestore)).toBe(false);
    expect(installsFakeTimersOrStubbedGlobals(safe)).toBe(true);
    expect(hasFailureSafeTeardown(safe)).toBe(true);
    expect(installsFakeTimersOrStubbedGlobals(commentOnly)).toBe(false);
  });
});
