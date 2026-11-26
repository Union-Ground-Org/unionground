#!/usr/bin/env node
// Static quality ratchets.
//
//   node scripts/verify-static-quality.mjs            # enforce
//   node scripts/verify-static-quality.mjs --report   # print, do not enforce
//   node scripts/verify-static-quality.mjs --update   # re-record the baseline
//   node scripts/verify-static-quality.mjs --update --accept-regression
//
// `--update` re-runs the gate's own comparison first and refuses to write a
// baseline that would absorb a new finding, so widening it is always deliberate.
//
// Two analyses, each with its own separately reasoned disposition, recorded in
//
//   * dependency cycles — RETAINED and blocking. The repository has none today,
//     so the honest baseline is zero and the gate costs nothing until someone
//     introduces one. Cycle detection is the analysis with real ongoing value
//     here, because the web shell's boot path is already densely coupled.
//
//   * server modules only tests import — RETAINED and blocking: such a module
//     runs in no deployment . There are none today.
//
//   * unused exports and unused declared dependencies — RETAINED as a
//     non-blocking ratchet. Existing findings are recorded in the baseline and
//     do not fail anything; a NEW finding does. That is the only honest way to
//     run this analysis, because a fully blocking version would demand a
//     dead-code sweep that has nothing to do with the change being reviewed.
//
// Copy-paste duplication analysis is RETIRED. It was never a blocking gate in
// the donor repository, a duplication percentage over a React codebase is
// dominated by view scaffolding that should stay duplicated, and no reviewer
// action follows from the number. Retiring it deliberately is recorded rather
// than left as a silent gap.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildGraph, cycleKey, findCycles } from "./lib/module-graph.mjs";
import { readHistoricalJson } from "./type-coverage-history.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(HERE, "..");
export const BASELINE_PATH = join(REPOSITORY_ROOT, "config/static-quality-baseline.json");

export function historicalBaselineFailures(candidate, historical) {
  if (!candidate) return historical.length ? ["cannot reset a recorded static-quality baseline"] : [];
  const failures = [];
  for (const previous of historical) {
    for (const key of ["cycles", "unused_exports", "unused_dependencies"]) {
      for (const entry of candidate[key] ?? []) {
        if (!previous[key].includes(entry)) failures.push(`${key} adds a finding absent from the historical baseline: ${entry}`);
      }
    }
  }
  return [...new Set(failures)];
}

/** Analysed roots, and the entry points that are imported by nothing on purpose. */
export const ANALYSIS = Object.freeze({
  cycleRoots: ["src", "api", "workers"],
  exportRoots: ["src"],
  serverModuleRoots: ["api"],
  // Imports from these trees do not make a server module used.
  testRoots: ["tests", "e2e"],
  dependencyRoots: ["src", "api", "workers", "scripts", "tests", "e2e"],
  skip: ["tests/fixtures"],
  entryPoints: [
    "src/main.jsx",
    "src/App.jsx",
  ],
  // Server modules started in a way the import graph cannot see (here worker
  // threads loaded with new URL("./x.js", import.meta.url)). A module loaded
  // by a dynamic path or another runtime convention is exempted by adding it here.
  serverWorkerEntryPoints: [
    "api/_lib/knowledgeExtractWorker.js",
    "api/_lib/privateFileInspectionWorker.js",
  ],
});

function isEntryPoint(path) {
  return ANALYSIS.entryPoints.includes(path)
    || /^api\/[^/]+\.js$/.test(path)
    || /^api\/public\/[^/]+\.js$/.test(path)
    || /^workers\/[^/]+\/index\.ts$/.test(path);
}

/**
 * Exports no first-party module imports.
 *
 * A module pulled in with a namespace import (`import * as x`) or re-exported
 * wholesale is treated as fully used, because the analysis cannot see which of
 * its names the consumer touches and a guess would produce false accusations.
 */
export function findUnusedExports({ modules, edges }) {
  const importedNames = new Map();
  const wholesale = new Set();
  for (const [path, facts] of modules) {
    const targets = edges.get(path) ?? [];
    for (const target of targets) {
      if (!importedNames.has(target)) importedNames.set(target, new Set());
    }
    // Names cannot be attributed to one specific target when a module imports
    // from several places, so every named import is credited to every
    // first-party target of that module. This deliberately over-credits: the
    // ratchet must not invent dead code.
    for (const target of targets) {
      const names = importedNames.get(target);
      for (const name of facts.namedImports) {
        if (name === "*") wholesale.add(target);
        else names.add(name);
      }
    }
  }

  const findings = [];
  for (const [path, facts] of modules) {
    if (!ANALYSIS.exportRoots.some((root) => path.startsWith(`${root}/`))) continue;
    if (isEntryPoint(path) || wholesale.has(path)) continue;

    // TypeScript resolves an import of model.js through model.d.ts without an
    // explicit graph edge to the sidecar. Credit that declaration contract
    // only when its actual JavaScript implementation has an observed consumer.
    // The implementation's own orphaned exports still go through this ratchet.
    if (path.endsWith(".d.ts") && ["js", "mjs", "cjs"].some((extension) => {
      const implementation = `${path.slice(0, -4)}${extension}`;
      return modules.has(implementation)
        && (wholesale.has(implementation) || importedNames.get(implementation)?.size > 0);
    })) continue;
    const used = importedNames.get(path) ?? new Set();
    for (const name of [...facts.namedExports, ...(facts.hasDefaultExport ? ["default"] : [])]) {
      if (!used.has(name)) findings.push(`${path}#${name}`);
    }
  }
  return findings.sort();
}

export const SERVER_MODULE_EXEMPTION = " (delete it or import it from deployed code; if it is loaded in a way the"
  + " import graph cannot see, such as a dynamic load or a route convention, list it in"
  + " ANALYSIS.serverWorkerEntryPoints in scripts/verify-static-quality.mjs)";

/** Modules in an api/_* folder that nothing outside the test trees imports.
 * Other api/ paths are Vercel functions, so entry points. */
export function findUnusedServerModules({ modules, edges }) {
  const testOnly = (path) => ANALYSIS.testRoots.some((root) => path.startsWith(`${root}/`));
  const used = new Set();
  for (const [path, targets] of edges) {
    if (testOnly(path)) continue;
    for (const target of targets) used.add(target);
  }
  return [...modules.keys()]
    .filter((path) => ANALYSIS.serverModuleRoots.some((root) => path.startsWith(`${root}/`)))
    .filter((path) => path.split("/").some((segment) => segment.startsWith("_")))
    .filter((path) => !ANALYSIS.serverWorkerEntryPoints.includes(path) && !used.has(path))
    .sort();
}

/**
 * Declared runtime dependencies that no first-party source imports.
 */
export function findUnusedDependencies({ modules, manifest }) {
  const used = new Set();
  for (const facts of modules.values()) {
    for (const specifier of facts.bareSpecifiers) {
      const parts = specifier.split("/");
      used.add(specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
    }
  }
  return Object.keys(manifest.dependencies ?? {})
    .filter((name) => !used.has(name))
    .sort();
}

export function analyse({ root = REPOSITORY_ROOT } = {}) {
  const cycleGraph = buildGraph({
    root,
    directories: ANALYSIS.cycleRoots,
    skip: ANALYSIS.skip,
  });
  const dependencyGraph = buildGraph({
    root,
    directories: ANALYSIS.dependencyRoots,
    skip: ANALYSIS.skip,
  });
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return {
    moduleCount: cycleGraph.modules.size,
    cycles: findCycles(cycleGraph.edges).map(cycleKey),
    // Usage is read from the wide graph, which includes tests and end-to-end
    // suites. A symbol a regression covers is used: the ratchet exists to catch
    // code nothing references at all, not to argue that tested code is dead.
    unusedExports: findUnusedExports(dependencyGraph),
    unusedServerModules: findUnusedServerModules(dependencyGraph),
    unusedDependencies: findUnusedDependencies({ modules: dependencyGraph.modules, manifest }),
  };
}

export function loadBaseline(path = BASELINE_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function validateBaseline(baseline) {
  const problems = [];
  if (!baseline || typeof baseline !== "object") return ["baseline must be an object"];
  if (baseline.schema !== 1) problems.push("baseline schema must be 1");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(baseline.measured_on ?? "")) {
    problems.push("measured_on must be an exact YYYY-MM-DD date");
  }
  for (const key of ["cycles", "unused_exports", "unused_dependencies"]) {
    if (!Array.isArray(baseline[key]) || baseline[key].some((entry) => typeof entry !== "string")) {
      problems.push(`${key} must be an array of exact finding identifiers`);
    }
  }
  const dispositions = baseline.dispositions;
  if (!dispositions || typeof dispositions !== "object") {
    problems.push("dispositions must record a separate decision per analysis");
  } else {
    for (const analysis of ["dependency_cycles", "unused_code", "duplication"]) {
      const disposition = dispositions[analysis];
      if (!disposition || !["retained-blocking", "retained-ratchet", "retired"].includes(disposition.decision)) {
        problems.push(`${analysis} needs an explicit retain or retire decision`);
      } else if (typeof disposition.rationale !== "string" || disposition.rationale.trim().length < 40) {
        problems.push(`${analysis} needs a recorded rationale`);
      }
    }
    if (dispositions.dependency_cycles?.decision !== "retained-blocking") {
      problems.push("dependency-cycle detection must stay blocking; the repository has no cycles to grandfather");
    }
  }
  if (Array.isArray(baseline.cycles) && baseline.cycles.length > 0) {
    problems.push("the cycle baseline must stay empty: a cycle is a defect to fix, never a number to grandfather");
  }
  return problems;
}

export function compare(analysis, baseline) {
  const failures = [];
  for (const cycle of analysis.cycles) {
    failures.push(`new import cycle: ${cycle}`);
  }
  for (const path of analysis.unusedServerModules ?? []) {
    failures.push(`server module only tests import: ${path}${SERVER_MODULE_EXEMPTION}`);
  }
  const recordedExports = new Set(baseline.unused_exports);
  for (const finding of analysis.unusedExports) {
    if (!recordedExports.has(finding)) failures.push(`newly unused export: ${finding}`);
  }
  const recordedDependencies = new Set(baseline.unused_dependencies);
  for (const finding of analysis.unusedDependencies) {
    if (!recordedDependencies.has(finding)) failures.push(`newly unused dependency: ${finding}`);
  }
  return failures;
}

/**
 * What stops `--update` from writing.
 *
 * A baseline records what was already there. Absorbing a NEW finding into it is
 * the one thing this file must never make easy, so the update path runs the
 * gate's own comparison and refuses anything it would have failed on, unless the
 * regression is accepted out loud on the command line — where it lands in the
 * reviewer's shell history and, because the baseline is committed, in the diff.
 *
 * A missing baseline is a bootstrap, not a regression, so it refuses nothing.
 */
export function updateBlockers(analysis, baseline, { acceptRegression = false } = {}) {
  if (!baseline || acceptRegression) return [];
  return compare(analysis, baseline);
}

export function staleEntries(analysis, baseline) {
  const currentExports = new Set(analysis.unusedExports);
  const currentDependencies = new Set(analysis.unusedDependencies);
  return [
    ...baseline.unused_exports.filter((entry) => !currentExports.has(entry))
      .map((entry) => `unused_exports: ${entry}`),
    ...baseline.unused_dependencies.filter((entry) => !currentDependencies.has(entry))
      .map((entry) => `unused_dependencies: ${entry}`),
  ];
}

function main() {
  const args = process.argv.slice(2);
  const report = args.includes("--report");
  const update = args.includes("--update");
  const acceptRegression = args.includes("--accept-regression");
  const analysis = analyse();
  console.log(
    `static quality: ${analysis.moduleCount} first-party modules, ${analysis.cycles.length} import cycle(s), `
      + `${analysis.unusedServerModules.length} server module(s) only tests import, `
      + `${analysis.unusedExports.length} unused export(s), ${analysis.unusedDependencies.length} unused dependency(ies)`,
  );
  if (report) {
    for (const cycle of analysis.cycles) console.log(`  cycle: ${cycle}`);
    for (const path of analysis.unusedServerModules) console.log(`  server module only tests import: ${path}`);
    for (const finding of analysis.unusedExports) console.log(`  unused export: ${finding}`);
    for (const finding of analysis.unusedDependencies) console.log(`  unused dependency: ${finding}`);
    return;
  }

  const historical = readHistoricalJson({
    repositoryRoot: REPOSITORY_ROOT,
    repositoryPath: "config/static-quality-baseline.json",
    validate: (value) => validateBaseline(value).length === 0,
  });
  let baseline;
  try {
    baseline = loadBaseline();
  } catch (error) {
    if (!update || error.code !== "ENOENT" || historical.length > 0) {
      console.error(`STATIC_QUALITY_FAIL: the baseline is unreadable: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    baseline = null;
  }

  if (update) {
    const refusals = [
      ...updateBlockers(analysis, baseline, { acceptRegression }),
      ...historicalBaselineFailures(baseline, historical),
      ...historical.flatMap((previous) => compare(analysis, previous)),
    ];
    if (refusals.length > 0) {
      console.error(
        "STATIC_QUALITY_FAIL: refusing to widen the baseline. Remove the cycle or the dead code, or pass --accept-regression with a recorded reason:",
      );
      for (const failure of refusals) console.error(`  - ${failure}`);
      process.exitCode = 1;
      return;
    }
    const next = {
      schema: 1,
      measured_on: new Date().toISOString().slice(0, 10),
      dispositions: baseline?.dispositions ?? {},
      cycles: analysis.cycles,
      unused_exports: analysis.unusedExports,
      unused_dependencies: analysis.unusedDependencies,
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log("static quality baseline updated");
    return;
  }

  const problems = validateBaseline(baseline);
  if (problems.length > 0) {
    console.error("STATIC_QUALITY_FAIL: the baseline is invalid");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  const failures = [
    ...compare(analysis, baseline),
    ...historicalBaselineFailures(baseline, historical),
  ];
  const stale = staleEntries(analysis, baseline);
  for (const entry of stale) {
    console.log(`::notice title=Static quality baseline shrank::${entry} is no longer reported; drop it on the next update`);
  }

  if (failures.length > 0) {
    console.error("STATIC_QUALITY_FAIL: static quality regressed against the recorded baseline");
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(
      "Remove the cycle or the dead code. Recording it in config/static-quality-baseline.json is for pre-existing findings only.",
    );
    process.exitCode = 1;
    return;
  }
  console.log("static quality ratchets hold.");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
