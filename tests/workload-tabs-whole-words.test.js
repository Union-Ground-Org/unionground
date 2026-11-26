// @vitest-environment node
//
// BUG-UG-WORKLOAD-TRACKER-TABS-BREAK-MID-WORD-AT-320-20261103 (#6922):
// at 320 CSS px the Workload tracker tabs (and the Pay tools tabs, which share
// the classes) split inside a word ("Subm / it"). A tab may no longer shrink
// below its label or split a word; the row wraps instead. jsdom has no layout,
// so this pins the CSS contract; the 320 px measurement lives in the lane proof.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
const declarations = (body) => Object.fromEntries(body.split(";").map((item) => item.split(":")).filter((pair) => pair.length >= 2)
  .map(([name, ...value]) => [name.trim(), value.join(":").trim()]));
const targeting = (className) => rules.filter((rule) => rule.selector.split(",").some((part) => new RegExp(`\\.${className}(?![\\w-])`).test(part)));
// The first rule for the selector is the base one; the desktop query repeats it.
const base = (selector) => {
  const found = rules.filter((rule) => rule.selector === selector);
  expect(found.length, selector).toBeGreaterThanOrEqual(1);
  return declarations(found[0].body);
};

describe("tab rows built on .mwl-tabs keep every word whole", () => {
  it("lets the row wrap and keeps a pill corner for one row", () => {
    const row = base(".mwl-tabs");
    expect(row.display).toBe("flex");
    expect(row["flex-wrap"]).toBe("wrap");
    // Half of one row's height (a 44px tab plus 3px padding on each side).
    expect(row["border-radius"]).toBe("25px");
  });

  it("never shrinks a tab below its label or splits a word inside it", () => {
    const tab = base(".mwl-tab");
    expect(tab.flex).toBe("1 0 auto");
    expect(tab["max-width"]).toBe("100%");
    expect(tab["overflow-wrap"]).toBe("normal");
    expect(tab["word-break"]).toBe("normal");
    expect(tab["min-width"]).toBeUndefined();
    expect(tab["min-height"]).toBe("44px");
    for (const rule of targeting("mwl-tab")) {
      const values = declarations(rule.body);
      expect(values["overflow-wrap"] ?? "normal", rule.selector).toBe("normal");
      expect(values["word-break"] ?? "normal", rule.selector).toBe("normal");
      expect(values["min-width"], rule.selector).toBeUndefined();
      expect(values.flex ?? "1 0 auto", rule.selector).toMatch(/^\d+ 0 auto$/);
    }
  });

  it("covers both tab rows that use the classes", () => {
    for (const view of ["WorkloadView.jsx", "PayToolsView.jsx"]) {
      const source = readFileSync(new URL(`../src/views/${view}`, import.meta.url), "utf8");
      expect(source, view).toMatch(/"mwl-tabs"/);
      expect(source, view).toMatch(/"mwl-tab"/);
    }
  });
});
