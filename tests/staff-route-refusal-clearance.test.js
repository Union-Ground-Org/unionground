import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { stripComments } from "../scripts/lib/css-vars.mjs";

// The Home refusal card carries both .view-error and .staff-route-refusal--home.
// main.jsx imports App.jsx (and so StaffRouteRefusal.css) before styles.css, so
// a clearance rule no more specific than `.view-error { margin: 16px }` is reset
// by that later shorthand and the fixed desk row covers the explanation.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = path => stripComments(readFileSync(join(root, path), "utf8"));
const rules = css => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
const classCount = selector => (selector.match(/\.[\w-]+/g) || []).length;

describe("staff-route refusal Home clearance", () => {
  const card = rules(read("src/components/StaffRouteRefusal.css"));
  const viewError = rules(read("src/styles.css")).find(rule => rule.selector === ".view-error");

  it("still faces a later .view-error margin shorthand", () => {
    expect(viewError.body).toMatch(/margin:\s*16px/);
    const main = readFileSync(join(root, "src/main.jsx"), "utf8");
    expect(main.indexOf('from "./App.jsx"')).toBeLessThan(main.indexOf('"./styles.css"'));
  });

  it("outranks that shorthand for both the clearance and the nudge reset", () => {
    const clearance = card.find(rule => /calc\(64px/.test(rule.body));
    const afterNudge = card.find(rule => rule.selector.startsWith(".native-app-nudge +"));
    expect(classCount(clearance.selector)).toBeGreaterThan(classCount(viewError.selector));
    expect(clearance.selector).toContain(".view-error");
    expect(classCount(afterNudge.selector)).toBeGreaterThan(classCount(clearance.selector));
  });
});
