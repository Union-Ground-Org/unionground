// Every kan-* class a kanban view renders must exist in the stylesheets.
//
// This gate exists because the Phase 1 modal shipped with ~25 kan-modal__*
// classes that had no CSS at all — the stylesheet spoke kan-title/kan-field/
// kan-desc while the markup spoke kan-modal__title/kan-modal__field, jsdom
// checks no styling, and the divergence only surfaced in the production
// browser proof (an unstyled native title textarea whose intrinsic width also
// pinned the whole dialog at 620px on a 390px phone). A class token is cheap
// to typo and invisible to every behavioral test; matching it against the
// stylesheets is the one check that sees the seam.
//
// Dynamic template chunks (`kan-card--${status}`) contribute their static
// prefix: a token ending in "-" passes when ANY selector extends that prefix,
// so renaming a whole variant family away still fails the gate.
//
// Comments are not classes. A stylesheet note that names a rejected selector,
// or a view note that names a class while explaining layout, must not count.
// CSS block comments are removed with the same stripComments helper the
// input-zoom floor uses. JS and JSX comments are removed only outside strings
// and template literals, so a class literal and a URL stay intact.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "../scripts/lib/css-vars.mjs";

const root = resolve(__dirname, "..");
const VIEWS = ["src/views/KanbanBoard.jsx", "src/views/KanbanCalendar.jsx", "src/views/KanbanList.jsx", "src/views/TaskDeadlinesView.jsx", "src/views/TaskDesktopTimeline.jsx", "src/views/TaskFieldNotesView.jsx", "src/views/TaskModal.jsx", "src/views/TasksView.jsx"];
const css = ["src/styles.css", "src/motion.css"]
  .map((file) => stripComments(readFileSync(resolve(root, file), "utf8")))
  .join("\n");

// Drop /* */ and // comments that sit in code. Quoted text, template text,
// and the ${} expressions inside a template stay subject to the same rules,
// so a comment inside an expression is removed and a "//" inside a string is
// not. Replacing a comment with a space keeps adjacent tokens from gluing.
function stripJsComments(source) {
  let out = "";
  let i = 0;
  let mode = "code";
  const exprDepth = [];

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (mode === "squote" || mode === "dquote" || mode === "template") {
      if (c === "\\") {
        out += c;
        if (next !== undefined) out += next;
        i += next === undefined ? 1 : 2;
        continue;
      }
      if (mode === "template" && c === "$" && next === "{") {
        out += "${";
        exprDepth.push(1);
        mode = "code";
        i += 2;
        continue;
      }
      const closes = (mode === "squote" && c === "'")
        || (mode === "dquote" && c === '"')
        || (mode === "template" && c === "`");
      out += c;
      if (closes) mode = "code";
      i += 1;
      continue;
    }

    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      out += " ";
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i + 2);
      out += " ";
      i = end === -1 ? source.length : end;
      continue;
    }
    if (c === "'") mode = "squote";
    else if (c === '"') mode = "dquote";
    else if (c === "`") mode = "template";
    else if (c === "{" && exprDepth.length > 0) exprDepth[exprDepth.length - 1] += 1;
    else if (c === "}" && exprDepth.length > 0) {
      exprDepth[exprDepth.length - 1] -= 1;
      out += c;
      i += 1;
      if (exprDepth[exprDepth.length - 1] === 0) {
        exprDepth.pop();
        mode = "template";
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function kanTokens(source) {
  // Class tokens only: a leading word/hyphen (as in --kan-pill custom
  // properties) or a leading dot means it is not a markup class literal.
  const live = stripJsComments(source);
  const matches = live.match(/(?<![\w.-])kan-[a-z0-9_-]*/g) || [];
  return [...new Set(matches)].filter((token) => token !== "kan-");
}

function styled(token, sheet = css) {
  const live = stripComments(sheet);
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (token.endsWith("-")) {
    // Static prefix of a template literal: `kan-ws-${n}` → "kan-ws-".
    return new RegExp(`\\.${escaped}[a-z0-9_-]`).test(live);
  }
  return new RegExp(`\\.${escaped}(?![\\w-])`).test(live);
}

describe("kanban class parity", () => {
  for (const view of VIEWS) {
    it(`${view} renders no kan-* class the stylesheets do not define`, () => {
      const source = readFileSync(resolve(root, view), "utf8");
      const missing = kanTokens(source).filter((token) => !styled(token));
      expect(missing).toEqual([]);
    });
  }

  it("reports a class named only inside a CSS comment as not styled", () => {
    const sheet = "/* .kan-ghost { color: red; } */\n.kan-live { color: blue; }";
    expect(styled("kan-ghost", sheet)).toBe(false);
    expect(styled("kan-live", sheet)).toBe(true);
  });

  it("does not extract a kan-* token that appears only inside a JS or JSX comment", () => {
    const source = [
      "// kan-line",
      "/* kan-block */",
      "{/* kan-jsx */}",
      "const quoted = \"see // kan-quoted\";",
      "const blockInString = \"/* kan-block-string */\";",
      "const templated = `prefix // kan-template`;",
      "const expressed = `kan-expr ${/* kan-expr-comment */ \"\"}`;",
      "className=\"kan-live\" // kan-trailing",
    ].join("\n");
    const tokens = kanTokens(source);
    expect(tokens).not.toContain("kan-line");
    expect(tokens).not.toContain("kan-block");
    expect(tokens).not.toContain("kan-jsx");
    expect(tokens).not.toContain("kan-expr-comment");
    expect(tokens).not.toContain("kan-trailing");
    expect(tokens).toContain("kan-quoted");
    expect(tokens).toContain("kan-block-string");
    expect(tokens).toContain("kan-template");
    expect(tokens).toContain("kan-expr");
    expect(tokens).toContain("kan-live");
  });
});
