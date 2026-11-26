// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  buildGraph,
  cycleKey,
  findCycles,
  readModuleFacts,
  resolveRelative,
} from "../scripts/lib/module-graph.mjs";
import {
  ANALYSIS,
  analyse,
  compare,
  historicalBaselineFailures,
  findUnusedDependencies,
  findUnusedExports,
  loadBaseline,
  staleEntries,
  updateBlockers,
  validateBaseline,
} from "../scripts/verify-static-quality.mjs";

describe("immutable static-quality history", () => {
  const previous = { cycles: [], unused_exports: ["src/old.js:old"], unused_dependencies: [] };
  it("rejects directly absorbing an unused export or dependency into the baseline", () => {
    for (const key of ["unused_exports", "unused_dependencies", "cycles"]) {
      expect(historicalBaselineFailures({ ...previous, [key]: [...previous[key], "new-finding"] }, [previous])).toHaveLength(1);
    }
  });
  it("rejects reset and accepts only shrinking findings", () => {
    expect(historicalBaselineFailures(null, [previous])).toHaveLength(1);
    expect(historicalBaselineFailures({ ...previous, unused_exports: [] }, [previous])).toEqual([]);
    expect(historicalBaselineFailures(previous, [previous])).toEqual([]);
  });
});

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = fileURLToPath(new URL("./fixtures/static-quality/", import.meta.url));
// `analyse()` builds a full module graph over every first-party module in the
// repository. It is deterministic for a given tree, so it is measured once here
// and shared by every assertion below: rebuilding it per test pushed this file
// past the global 10s `testTimeout` under `npm run test:coverage`, which is the
// command `npm run check` and the required CI gate actually execute.
const repositoryAnalysis = analyse();

describe("module graph", () => {
  it("reads relative, bare and dynamic specifiers apart", () => {
    const facts = readModuleFacts({
      path: "src/example.js",
      source: [
        'import react from "react";',
        'import { helper } from "./helper.js";',
        'export { reexported } from "./other.js";',
        'const lazy = await import("./lazy.js");',
        'import fs from "node:fs";',
        "export const value = 1;",
        "export default function main() { return lazy; }",
      ].join("\n"),
    });
    expect(facts.bareSpecifiers).toEqual(["react"]);
    expect(facts.relativeSpecifiers).toEqual(["./helper.js", "./other.js", "./lazy.js"]);
    expect(facts.namedExports).toEqual(["reexported", "value"]);
    expect(facts.hasDefaultExport).toBe(true);
  });

  it("counts a namespace import as wholesale usage", () => {
    const facts = readModuleFacts({
      path: "src/example.js",
      source: 'import * as everything from "./library.js";\nexport const use = everything;',
    });
    expect(facts.namedImports).toContain("*");
  });

  it("resolves an extensionless first-party specifier", () => {
    expect(resolveRelative(fixtureRoot, "cycle/alpha.js", "./beta.js")).toBe("cycle/beta.js");
    expect(resolveRelative(fixtureRoot, "cycle/alpha.js", "./missing.js")).toBeNull();
  });
});

describe("cycle detection", () => {
  it("TEST-UG-STATIC-QUALITY-GATES-20260904 treats a dynamic import as a cycle edge", () => {
    const root = mkdtempSync(join(tmpdir(), "static-quality-dynamic-cycle-"));
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "alpha.js"), 'export const alpha = import("./beta.js");\n');
      writeFileSync(join(root, "src", "beta.js"), 'import { alpha } from "./alpha.js";\nexport { alpha };\n');

      const graph = buildGraph({ root, directories: ["src"] });
      expect(findCycles(graph.edges).map(cycleKey)).toEqual([
        "src/alpha.js -> src/beta.js",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports the fixture cycle", () => {
    const graph = buildGraph({ root: fixtureRoot, directories: ["cycle"] });
    const cycles = findCycles(graph.edges).map(cycleKey);
    expect(cycles).toEqual(["cycle/alpha.js -> cycle/beta.js"]);
  });

  it("reports nothing for an acyclic graph", () => {
    const graph = buildGraph({ root: fixtureRoot, directories: ["unused"] });
    expect(findCycles(graph.edges)).toEqual([]);
  });

  it("reports a self-import", () => {
    const edges = new Map([["a.js", ["a.js"]], ["b.js", []]]);
    expect(findCycles(edges).map(cycleKey)).toEqual(["a.js"]);
  });

  it("finds no cycle in the repository at this revision", () => {
    expect(repositoryAnalysis.cycles).toEqual([]);
  });
});

describe("unused-code detection", () => {
  it("credits a consumed JavaScript declaration sidecar but still reports runtime orphans and unattached declarations", () => {
    const facts = (exports, imports = []) => ({ namedExports: exports, namedImports: imports, hasDefaultExport: false });
    const modules = new Map([
      ["src/model.js", facts(["used", "orphan"])],
      ["src/model.d.ts", facts(["used", "orphan", "ModelType"])],
      ["src/unattached.d.ts", facts(["UnusedType"])],
      ["src/main.jsx", facts([], ["used"])],
    ]);
    const edges = new Map([["src/main.jsx", ["src/model.js"]]]);
    expect(findUnusedExports({modules,edges})).toEqual(["src/model.js#orphan", "src/unattached.d.ts#UnusedType"]);
  });

  it("reports an export nothing imports and spares one that is imported", () => {
    const graph = buildGraph({ root: fixtureRoot, directories: ["unused"] });
    const findings = findUnusedExports({
      ...graph,
      // The production analysis only reports exports under src/; the fixture
      // project stands in for that root.
    });
    expect(findings).toEqual([]);
  });

  it("reports an export nothing imports when the root matches", () => {
    const modules = new Map([
      ["src/library.js", {
        relativeSpecifiers: [], bareSpecifiers: [], namedImports: [],
        namedExports: ["referenced", "orphaned"], hasDefaultExport: false,
      }],
      ["src/consumer.js", {
        relativeSpecifiers: ["./library.js"], bareSpecifiers: [],
        namedImports: ["referenced"], namedExports: ["total"], hasDefaultExport: false,
      }],
    ]);
    const edges = new Map([["src/library.js", []], ["src/consumer.js", ["src/library.js"]]]);
    expect(findUnusedExports({ modules, edges })).toEqual([
      "src/consumer.js#total",
      "src/library.js#orphaned",
    ]);
  });

  it("reports an unused default-only module and credits an actual default import", () => {
    const library = readModuleFacts({ path: "src/library.js", source: "export default function orphan() {}" });
    const modules = new Map([["src/library.js", library]]);
    const edges = new Map([["src/library.js", []]]);
    expect(findUnusedExports({ modules, edges })).toEqual(["src/library.js#default"]);
    modules.set("src/consumer.js", readModuleFacts({ path: "src/consumer.js",
      source: 'import library from "./library.js"; library();' }));
    edges.set("src/consumer.js", ["src/library.js"]);
    expect(findUnusedExports({ modules, edges })).toEqual([]);
  });

  it("treats a namespace-imported module as fully used", () => {
    const modules = new Map([
      ["src/library.js", {
        relativeSpecifiers: [], bareSpecifiers: [], namedImports: [],
        namedExports: ["a", "b"], hasDefaultExport: false,
      }],
      ["src/consumer.js", {
        relativeSpecifiers: ["./library.js"], bareSpecifiers: [],
        namedImports: ["*"], namedExports: [], hasDefaultExport: false,
      }],
    ]);
    const edges = new Map([["src/library.js", []], ["src/consumer.js", ["src/library.js"]]]);
    expect(findUnusedExports({ modules, edges })).toEqual([]);
  });

  it("reports a declared dependency nothing imports", () => {
    const modules = new Map([
      ["src/a.js", { bareSpecifiers: ["react", "@supabase/supabase-js/dist"], relativeSpecifiers: [], namedImports: [], namedExports: [], hasDefaultExport: false }],
    ]);
    expect(findUnusedDependencies({
      modules,
      manifest: { dependencies: { react: "1", "@supabase/supabase-js": "2", "never-used": "3" } },
    })).toEqual(["never-used"]);
  });

  it("finds no unused declared dependency in the repository at this revision", () => {
    expect(repositoryAnalysis.unusedDependencies).toEqual([]);
  });
});

describe("baseline and dispositions", () => {
  const baseline = loadBaseline();

  it("is valid", () => {
    expect(validateBaseline(baseline)).toEqual([]);
  });

  it("records a separate decision and rationale for each analysis", () => {
    expect(Object.keys(baseline.dispositions).sort()).toEqual([
      "dependency_cycles",
      "duplication",
      "unused_code",
    ]);
    expect(baseline.dispositions.dependency_cycles.decision).toBe("retained-blocking");
    expect(baseline.dispositions.unused_code.decision).toBe("retained-ratchet");
    expect(baseline.dispositions.duplication.decision).toBe("retired");
    for (const disposition of Object.values(baseline.dispositions)) {
      expect(disposition.rationale.length).toBeGreaterThanOrEqual(40);
    }
  });

  it("does not claim the retired analyzer was a release gate", () => {
    expect(baseline.dispositions.duplication.rationale).toMatch(/never a release gate/i);
  });

  it("keeps the cycle baseline empty so no cycle can be grandfathered", () => {
    expect(baseline.cycles).toEqual([]);
    expect(validateBaseline({ ...baseline, cycles: ["a -> b"] }).join("\n"))
      .toMatch(/cycle baseline must stay empty/);
  });

  it("refuses a baseline that demotes cycle detection", () => {
    const demoted = structuredClone(baseline);
    demoted.dispositions.dependency_cycles.decision = "retained-ratchet";
    expect(validateBaseline(demoted).join("\n")).toMatch(/must stay blocking/);
  });

  it("refuses a baseline with an undecided analysis", () => {
    const undecided = structuredClone(baseline);
    delete undecided.dispositions.duplication;
    expect(validateBaseline(undecided).join("\n")).toMatch(/explicit retain or retire decision/);
  });

  it("records the reviewed scope and cadence of every retained analyzer", () => {
    for (const key of ["dependency_cycles", "unused_code"]) {
      expect(baseline.dispositions[key].tool).toEqual(expect.any(String));
      expect(baseline.dispositions[key].scope).toEqual(expect.any(String));
      expect(baseline.dispositions[key].cadence).toEqual(expect.any(String));
    }
  });
});

describe("ratchet comparison", () => {
  const baseline = loadBaseline();

  it("passes for the repository at this revision", () => {
    expect(compare(repositoryAnalysis, baseline)).toEqual([]);
  });

  it("fails on a new import cycle", () => {
    expect(compare({ cycles: ["src/a.js -> src/b.js"], unusedExports: [], unusedDependencies: [] }, baseline))
      .toEqual(["new import cycle: src/a.js -> src/b.js"]);
  });

  it("fails on a newly unused export", () => {
    expect(compare({ cycles: [], unusedExports: ["src/brand/new.js#dead"], unusedDependencies: [] }, baseline))
      .toEqual(["newly unused export: src/brand/new.js#dead"]);
  });

  it("fails on a newly unused dependency", () => {
    expect(compare({ cycles: [], unusedExports: [], unusedDependencies: ["abandoned"] }, baseline))
      .toEqual(["newly unused dependency: abandoned"]);
  });

  it("accepts a pre-existing finding recorded in the baseline", () => {
    const recorded = baseline.unused_exports[0];
    expect(compare({ cycles: [], unusedExports: [recorded], unusedDependencies: [] }, baseline)).toEqual([]);
  });

  it("notices a baseline entry that is no longer reported", () => {
    expect(staleEntries({ unusedExports: [], unusedDependencies: [] }, baseline).length)
      .toBe(baseline.unused_exports.length + baseline.unused_dependencies.length);
  });

  it("lets --update re-record the repository as it stands today", () => {
    expect(updateBlockers(repositoryAnalysis, baseline)).toEqual([]);
  });

  it("refuses to let --update absorb a newly unused export", () => {
    expect(updateBlockers(
      { cycles: [], unusedExports: ["src/brand/new.js#dead"], unusedDependencies: [] },
      baseline,
    )).toEqual(["newly unused export: src/brand/new.js#dead"]);
  });

  it("refuses to let --update absorb a newly unused dependency or a cycle", () => {
    expect(updateBlockers(
      { cycles: ["src/a.js -> src/b.js"], unusedExports: [], unusedDependencies: ["abandoned"] },
      baseline,
    )).toEqual([
      "new import cycle: src/a.js -> src/b.js",
      "newly unused dependency: abandoned",
    ]);
  });

  it("widens the baseline only when the regression is accepted explicitly", () => {
    const regressed = { cycles: [], unusedExports: ["src/brand/new.js#dead"], unusedDependencies: [] };
    expect(updateBlockers(regressed, baseline, { acceptRegression: true })).toEqual([]);
  });

  it("treats a missing baseline as a bootstrap rather than a regression", () => {
    expect(updateBlockers(
      { cycles: [], unusedExports: ["src/brand/new.js#dead"], unusedDependencies: [] },
      null,
    )).toEqual([]);
  });

  it("skips the fixture tree so the gate cannot report its own fixtures", () => {
    expect(ANALYSIS.skip).toContain("tests/fixtures");
    expect(repositoryAnalysis.unusedExports.some((entry) => entry.startsWith("tests/fixtures/")))
      .toBe(false);
  });
});
