import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// UB-UG-WEB-SIGNIN-QUIET-UNTIL-NEEDED-20261108: the live sign-in card
// showed "both required" before anyone typed, a language pill that was the
// largest shape on the card at 320px, and a demo button whose label left one
// word alone on its second line.
const css = readFileSync("src/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
};

describe("sign-in card stays quiet until it is needed", () => {
  it("keeps the requirements visible and associated with the public password form", () => {
    const requirements = rule(".sgauth-column .auth-card .auth-requirements");
    expect(requirements).toMatch(/color:\s*var\(--sec\)/);
    expect(requirements).toMatch(/line-height:\s*1.45/);
    expect(requirements).not.toMatch(/display:\s*none|visibility:\s*hidden|overflow:\s*hidden/);
    const auth = readFileSync("src/components/AuthScreen.jsx", "utf8");
    expect(auth).toContain('const submitRequirementsId = "auth-submit-requirements"');
    expect(auth).toMatch(/<p className="auth-requirements" id=\{submitRequirementsId\}/);
    expect(auth).toMatch(/<input name="password"[^>]*required minLength="10" aria-describedby=\{submitRequirementsId\}/);
    expect(auth).toMatch(/<button className="auth-submit"[^>]*aria-describedby=\{submitRequirementsId\}/);
  });

  it("draws the language switch as two words with 48px targets, the current one marked by a bar, not a link underline", () => {
    const track = rule(".sgauth-column .auth-language");
    expect(track).toMatch(/border:\s*0/);
    expect(track).toMatch(/background:\s*transparent/);
    const button = rule(".sgauth-column .auth-language button");
    expect(button).toMatch(/min-height:\s*48px/);
    expect(button).toMatch(/min-width:\s*48px/);
    const current = rule('.sgauth-column .auth-language button[aria-pressed="true"]');
    expect(current).not.toMatch(/text-decoration/);
    expect(current).toMatch(/color:\s*var\(--ink\)/);
    expect(rule('.sgauth-column .auth-language button[aria-pressed="true"]::after')).toMatch(/background:\s*var\(--green\)/);
    // Only the selection carries the bar; hover just darkens the other word.
    expect(css).not.toMatch(/aria-pressed="false"\]:hover::after/);
    // One weight for both words, so switching never shifts them.
    expect(button).toMatch(/font-weight:\s*700/);
    expect(current).not.toMatch(/font-weight/);
  });

  it("balances the demo button's label when it takes two lines", () => {
    const demo = rule(".sgauth-column .auth-demo");
    expect(demo).toMatch(/text-wrap:\s*balance/);
    expect(demo).toMatch(/text-align:\s*center/);
    expect(rule(".auth-demo")).toMatch(/border:\s*2px dashed var\(--green\)/);
  });
});
