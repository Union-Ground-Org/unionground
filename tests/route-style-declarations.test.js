import postcss from "postcss";
import { describe, expect, it } from "vitest";
import { splitRouteStyles } from "../scripts/lib/route-styles.mjs";

function declarations(css) {
  const result = [];
  postcss.parse(css).walkDecls((decl) => {
    const wrappers = [];
    for (let node = decl.parent.parent; node?.type === "atrule"; node = node.parent) wrappers.unshift([node.name, node.params]);
    result.push(JSON.stringify([wrappers, decl.parent.selector, decl.prop, decl.value, Boolean(decl.important)]));
  });
  return result.sort();
}

describe("route declaration partitions", () => {
  it("keeps the conflicting color while deferring independent declarations of the same rule", () => {
    const source = ".kan-card { color: red; display: grid; padding: 8px; }\n.outside { color: blue; }";
    const split = splitRouteStyles(source, { sources: ['"kan-card outside"'] });
    expect(split.critical).toContain("color: red;");
    expect(split.critical).not.toContain("display: grid;");
    expect(split.critical).not.toContain("padding: 8px;");
    expect(split.kan).toContain("display: grid;");
    expect(split.kan).toContain("padding: 8px;");
    expect(Object.values(split).flatMap(declarations).sort()).toEqual(declarations(source));
    expect(postcss.parse(split.kan).nodes).toHaveLength(1);
  });

  it("preserves shorthand, fallback and logical-side declaration order while moving an independent background", () => {
    const source = ".tasks-card { font: 12px sans-serif; line-height: 1.5; margin-inline: 1px; margin-left: 2px; background: red; }\n.outside { line-height: 2; margin: 3px; }";
    const split = splitRouteStyles(source, { sources: ['"tasks-card outside"'] });
    expect(split.critical).toContain("font: 12px sans-serif; line-height: 1.5; margin-inline: 1px; margin-left: 2px;");
    expect(split.tasks).toContain("background: red;");
    expect(Object.values(split).flatMap(declarations).sort()).toEqual(declarations(source));
  });

  it("retains repeated fallback values in their original order in the lazy fragment", () => {
    const source = ".tasks-card { display: -webkit-box; display: flex; color: red; }\n.outside { color: blue; }";
    const split = splitRouteStyles(source, { sources: ['"tasks-card outside"'] });
    expect(split.tasks).toContain("display: -webkit-box; display: flex;");
    expect(split.critical).toContain("color: red;");
    expect(Object.values(split).flatMap(declarations).sort()).toEqual(declarations(source));
  });

  it.each(["media (min-width: 700px)", "supports (display: grid)", "container board (min-width: 500px)"])("keeps the original @%s wrapper on both fragments", (wrapper) => {
    const source = `@${wrapper} { .kan-card { color: red; display: grid; } }\n.outside { color: blue; }`;
    const split = splitRouteStyles(source, { sources: ['"kan-card outside"'] });
    expect(split.critical).toContain(`@${wrapper}`);
    expect(split.kan).toContain(`@${wrapper}`);
    expect(split.kan).toContain("display: grid;");
    expect(Object.values(split).flatMap(declarations).sort()).toEqual(declarations(source));
  });

  it("keeps dimensions, grid and gap declarations critical when partially moving a rule", () => {
    const source = ".tasks-card { inline-size: 100%; width: 40px; grid-template-columns: 1fr 1fr; gap: 4px; color: red; display: grid; }\n.outside { color: blue; }";
    const split = splitRouteStyles(source, { sources: ['"tasks-card outside"'] });
    for (const property of ["inline-size", "width", "grid-template-columns", "gap"]) {
      expect(split.critical).toContain(`${property}:`);
      expect(split.tasks).not.toContain(`${property}:`);
    }
    expect(split.tasks).toContain("display: grid;");
    expect(Object.values(split).flatMap(declarations).sort()).toEqual(declarations(source));
  });

  it("keeps a conflicting rule whole when its descendant subject has no class", () => {
    const source = ".kan-card p { color: red; padding: 8px; }\n.outside p { color: blue; }";
    const split = splitRouteStyles(source, { sources: ['"kan-card outside"'] });
    expect(split.critical).toContain(".kan-card p { color: red; padding: 8px; }");
    expect(split.kan).toBe("");
  });

  it.each(["", " !important"])("recognizes all as a rival for every declaration family (%s)", (priority) => {
    const source = `.kan-card { color: red${priority}; padding: 8px${priority}; }\n.outside { all: initial${priority}; }`;
    const split = splitRouteStyles(source, { sources: ['"kan-card outside"'] });
    expect(split.kan).toBe("");
    expect(declarations(split.critical)).toEqual(declarations(source));
  });

  it("leaves custom-property rules, layers and keyframes together", () => {
    const source = ".tasks-card { --task-ink: red; color: var(--task-ink); padding: 8px; }\n.outside { color: blue; }\n@layer shared { .kan-card { display: grid; padding: 8px; } }\n@keyframes pulse { to { opacity: 0; } }";
    const split = splitRouteStyles(source, { sources: ['"tasks-card outside"'] });
    expect(split.critical).toContain("--task-ink: red; color: var(--task-ink); padding: 8px;");
    expect(split.critical).toContain("@layer shared { .kan-card { display: grid; padding: 8px; } }");
    expect(split.critical).toContain("@keyframes pulse { to { opacity: 0; } }");
    expect(Object.values(split).flatMap(declarations).sort()).toEqual(declarations(source));
  });
});
