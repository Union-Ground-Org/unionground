// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// BUG-UG-ADMIN-ATTENTION-LINKS-TARGET-SIZE-20261107: the Admin desk's
// "Needs your attention" links were 16px tall rows 4px apart (Axe target-size,
// WCAG 2.2 2.5.8). Each is now a full-width row at the shared 48px target.
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const rule = (selector) => {
  const match = styles.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`, "m"));
  expect(match, `${selector} rule`).not.toBeNull();
  return match[1];
};

describe("admin attention link targets", () => {
  it("keeps the shared target at 48px", () => {
    expect(styles).toMatch(/^\s*--target: 48px;/m);
  });

  it("gives each attention link and row the shared target height", () => {
    expect(rule(".admin-attention a")).toContain("min-height: var(--target)");
    expect(rule(".admin-attention a")).toContain("display: flex");
    expect(rule(".admin-attention li")).toContain("min-height: var(--target)");
    expect(rule(".admin-attention ul")).not.toMatch(/gap: 4px/);
  });

  it("keeps the chevron out of flow so the underline stops at the words", () => {
    expect(rule(".admin-attention a::after")).toContain("position: absolute");
    expect(rule(".admin-attention a::after")).toContain("var(--sg-color-sec)");
  });
});
