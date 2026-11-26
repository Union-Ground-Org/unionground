import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { stripComments } from "../scripts/lib/css-vars.mjs";

// iOS Safari zooms the page when a focusable control under 16px takes focus,
// and there is no viewport flag left that disables it without also disabling
// the member's own pinch zoom. The only honest fix is 16px on the control
// itself. This is the floor that keeps the fix from re-creeping one input at
// a time — the 2026-07 sweep found seventeen sub-16 declarations that each
// looked reasonable alone.
//
// The floor reads every stylesheet under src. A size counts in px, rem, em,
// or percentage, including the size token inside a `font` shorthand. rem and
// em resolve against a 16px root; 100% is that same root. inherit and unset
// are not a declared size. The FormsView pin reads the INPUT style object, so
// a fontSize: 16 literal elsewhere in that file cannot satisfy it.

const ROOT_PX = 16;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

// A selector list that can match a focusable text control. Checkboxes and
// radios render OS-drawn and never zoom; ::placeholder carries no size of its
// own and inherits whatever the input declares.
const FOCUSABLE = /(?:^|[\s>+~,(])(?:input|textarea|select)(?![-\w])/;
const EXEMPT = /\[type="(?:checkbox|radio)"\]|::placeholder/;
const NON_SIZE = new Set(["inherit", "unset", "initial", "revert", "revert-layer"]);
const SYSTEM_FONT = /^(?:caption|icon|menu|message-box|small-caption|status-bar)$/i;
const LENGTH = /^([\d.]+)(px|rem|em|%)$/i;

function listStylesheets(dirAbs) {
  const found = [];
  const walk = (abs) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith(".css")) {
        found.push(relative(root, child).split(sep).join("/"));
      }
    }
  };
  walk(dirAbs);
  return found.sort();
}

function lengthPx(token) {
  const match = LENGTH.exec(token);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2].toLowerCase();
  if (unit === "px") return amount;
  if (unit === "%") return (amount / 100) * ROOT_PX;
  return amount * ROOT_PX;
}

function bareValue(value) {
  return value.replace(/\s*!important\s*$/i, "").trim();
}

// The font shorthand's size is the first length or percentage. It may sit
// after style, variant, and weight, and it may be glued to a line-height
// (`700 16px/1.2 var(--utility)`). A keyword such as inherit has no size.
function shorthandSize(value) {
  const cleaned = bareValue(value);
  if (NON_SIZE.has(cleaned.toLowerCase()) || SYSTEM_FONT.test(cleaned)) return null;
  const tokens = cleaned.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,\s]+/g) ?? [];
  for (const token of tokens) {
    if (token.startsWith('"') || token.startsWith("'")) continue;
    const size = token.split("/")[0];
    if (LENGTH.test(size)) return size;
  }
  return null;
}

// Last declaration wins inside one rule. `font` resets the size, so a later
// shorthand replaces an earlier font-size, and the reverse is also true.
function declaredSize(body) {
  let current = null;
  for (const part of body.split(";")) {
    const decl = part.trim();
    if (!decl) continue;
    const match = /^(font-size|font)\s*:\s*([\s\S]+)$/i.exec(decl);
    if (!match) continue;
    const prop = match[1].toLowerCase();
    const raw = bareValue(match[2]);
    if (prop === "font-size") {
      if (NON_SIZE.has(raw.toLowerCase())) {
        current = null;
        continue;
      }
      const px = lengthPx(raw);
      current = px == null ? null : { px, raw };
      continue;
    }
    const token = shorthandSize(raw);
    if (token == null) {
      current = null;
      continue;
    }
    const px = lengthPx(token);
    current = px == null ? null : { px, raw: token };
  }
  return current;
}

function eachFocusableRule(css, visit) {
  const sheet = stripComments(css);
  for (const match of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].replace(/\s+/g, " ").trim();
    if (!selector || !FOCUSABLE.test(selector) || EXEMPT.test(selector)) continue;
    visit(selector, match[2]);
  }
}

function focusableFontOffenders(file, css) {
  const offenders = [];
  eachFocusableRule(css, (selector, body) => {
    const size = declaredSize(body);
    if (!size || size.px >= 16) return;
    offenders.push(`${file} | ${selector} | ${size.raw}`);
  });
  return offenders;
}

function inputStyleBlock(source) {
  const marker = "const INPUT = {";
  const start = source.indexOf(marker);
  if (start < 0) return null;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = start + marker.length - 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const newline = source.indexOf("\n", i);
      i = newline === -1 ? source.length : newline;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start + marker.length - 1, i + 1);
    }
  }
  return null;
}

function inputObjectFontSize(source) {
  const block = inputStyleBlock(source);
  if (block == null) return null;
  const code = block
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, "\"\"");
  const matches = [...code.matchAll(/\bfontSize\s*:\s*([\d.]+)/g)];
  if (matches.length === 0) return null;
  return Number(matches[matches.length - 1][1]);
}

describe("font-size syntax the floor can see", () => {
  const detected = [
    ["input { font-size: 15px }", "fixture.css | input | 15px"],
    ["textarea { font-size: 0.9rem }", "fixture.css | textarea | 0.9rem"],
    ["select { font-size: 0.9em }", "fixture.css | select | 0.9em"],
    ["input { font-size: 90% }", "fixture.css | input | 90%"],
    ["input { font: 400 14px/1.2 x }", "fixture.css | input | 14px"],
    ["input { font-size: 15px !important }", "fixture.css | input | 15px"],
    ["@media (max-width: 600px) {\n  input { font-size: 15px }\n}", "fixture.css | input | 15px"],
    ["input { font-size: 16px; font: 400 14px/1.2 x }", "fixture.css | input | 14px"],
  ];

  it("detects sub-16 px, rem, em, percentage, and font shorthand", () => {
    for (const [css, expected] of detected) {
      expect(focusableFontOffenders("fixture.css", css), css).toEqual([expected]);
    }
  });

  it("accepts 16px, 1rem, 1em, 100%, inherit, unset, and a 16px shorthand", () => {
    const clean = [
      "input { font-size: 16px }",
      "textarea { font-size: 1rem }",
      "select { font-size: 1em }",
      "input { font-size: 100% }",
      "input { font: inherit }",
      "textarea { font: unset }",
      "input { font: 700 16px/1.2 var(--utility) }",
      "input { font: 400 14px/1.2 x; font-size: 16px }",
      "input { /* font-size: 12px; */ font-size: 16px }",
      "/* input { font-size: 12px } */\ninput { font-size: 16px }",
      "label { font-size: 12px }",
      "button { font: 800 12px/1 var(--sg-font-family-body) }",
      'input[type="checkbox"] { font-size: 12px }',
      'input[type="radio"] { font-size: 10px }',
      "input::placeholder { font-size: 12px }",
    ];
    for (const css of clean) {
      expect(focusableFontOffenders("fixture.css", css), css).toEqual([]);
    }
  });
});

describe("no focusable control renders under 16px", () => {
  const sheets = listStylesheets(join(root, "src"));
  const audited = [];
  const offenders = [];
  for (const file of sheets) {
    const css = read(file);
    eachFocusableRule(css, (selector) => {
      audited.push({ file, selector });
    });
    offenders.push(...focusableFontOffenders(file, css));
  }

  it("enumerates every stylesheet under src", () => {
    expect(sheets.length).toBeGreaterThanOrEqual(17);
    expect(sheets).toEqual(expect.arrayContaining([
      "src/styles.css",
      "src/features/memberSupport/member-support.css",
      "src/features/coordination/ui/organizationCoordination.css",
      "src/features/analytics/analyticsCore.css",
    ]));
    // Union Ground collects no dues, so no dues stylesheet ships.
    expect(sheets.filter((file) => file.startsWith("src/features/dues/"))).toEqual([]);
  });

  it("finds the control rules it audits", () => {
    expect(audited.length).toBeGreaterThan(10);
    const files = new Set(audited.map((rule) => rule.file));
    expect(files.has("src/styles.css")).toBe(true);
    expect(files.has("src/features/memberSupport/member-support.css")).toBe(true);
    expect(files.size).toBeGreaterThan(1);
  });

  it("holds every input/textarea/select font-size at 16px or above", () => {
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("keeps the FormsView INPUT style object on the floor", () => {
    const size = inputObjectFontSize(read("src/views/FormsView.jsx"));
    expect(size).toBeGreaterThanOrEqual(16);
  });
});

describe("FormsView INPUT style object", () => {
  it("reads fontSize from that object, not from another literal in the file", () => {
    const source = [
      "const DECOY = { fontSize: 16 };",
      "const INPUT = {",
      "  font: \"fontSize: 16\",",
      "  // fontSize: 16",
      "  fontSize: 12,",
      "};",
      "const LATER = { fontSize: 16 };",
    ].join("\n");
    expect(source).toContain("fontSize: 16");
    expect(inputObjectFontSize(source)).toBe(12);
  });
});
