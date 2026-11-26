#!/usr/bin/env node
// Type-coverage ratchet for the Expo application.
//
//   node scripts/type-coverage-ratchet.mjs              # enforce the baseline
//   node scripts/type-coverage-ratchet.mjs --report     # print, do not enforce
//   node scripts/type-coverage-ratchet.mjs --update     # move the baseline up
//   node scripts/type-coverage-ratchet.mjs --baseline P # read/record P instead
//
// `--baseline` is a diagnostic and test-only override. CI never passes it: the
// `type-coverage` npm script is the bare invocation above, and
// `typeCoverageRatchet.test.ts` pins both that script and its place inside
// `npm run check`, so the committed baseline is the one the lane enforces.
//
// `tsc --noEmit` proves the code compiles. It does not prove the code is typed:
// an `any` boundary around a Supabase response or a native module compiles
// perfectly while erasing every guarantee behind it. This ratchet measures how
// much of the maintained source actually carries a type, counts the explicit
// escapes, and refuses a change that makes either worse.
//
// All four rules — the aggregate floor, the suppression ceilings, the per-file
// additive rule and the new-file floor — run on the bare invocation above, which
// is the one `apps/mobile` `npm run check` (and therefore the CI mobile job)
// executes. Historical floors additionally bind the exact CI event base; local
// checks bind committed HEAD and the available origin/Main merge base.
//
// The measurement is the honest one: every identifier in the maintained program
// is resolved through the real type checker, and nothing is excluded except
// generated Expo declarations and ambient third-party typings, which the
// application does not author and cannot fix.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { baselineHistoryFailures, readBaselineHistory } from "../../../scripts/type-coverage-history.mjs";
import { appendCoveragePin, loadCoveragePins } from "../../../scripts/lib/type-coverage-pins.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MOBILE_ROOT = resolve(HERE, "..");
export const BASELINE_PATH = join(MOBILE_ROOT, "type-coverage-baseline.json");

/**
 * Documented exclusions. Each one is generated or third-party: the application
 * neither authors nor can repair these declarations, so counting them would
 * make the number dishonest in either direction.
 */
export const EXCLUDED_PATTERNS = Object.freeze([
  /(^|\/)node_modules\//,
  /(^|\/)\.expo\//,
  /(^|\/)expo-env\.d\.ts$/,
  /\.d\.[cm]?ts$/,
]);

/** Maintained source roots. The fixture project passes its own. */
export const MEASURED_ROOTS = Object.freeze(["app", "src", "scripts"]);

export function isMeasured(relativePath, roots = MEASURED_ROOTS) {
  if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(relativePath))) return false;
  if (!/\.[cm]?[jt]sx?$/.test(relativePath)) return false;
  return roots.some((root) => relativePath.startsWith(`${root}/`));
}

/**
 * A new file must clear this floor. It sits above the current fifth percentile
 * of maintained files and below the aggregate, so a genuinely new module has to
 * be well typed while one or two unavoidable native-module escapes do not block
 * a change. The validator refuses a baseline that drops it, so the floor cannot
 * be quietly lowered to nothing.
 */
export const MINIMUM_NEW_FILE_FLOOR = 90;
export const DEFAULT_NEW_FILE_FLOOR = 95;

export const SUPPRESSION_KINDS = Object.freeze([
  "tsNoCheck",
  "tsIgnore",
  "tsExpectError",
  "explicitAny",
  "asAny",
  "doubleAssertion",
]);

function loadProgram(projectRoot) {
  const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error("TYPE_COVERAGE_FAIL: apps/mobile has no tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(`TYPE_COVERAGE_FAIL: tsconfig.json is unreadable: ${configFile.error.messageText}`);
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(configPath), undefined, configPath);
  const host = ts.createCompilerHost(parsed.options);
  host.getCurrentDirectory = () => resolve(projectRoot);
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, host });
}

function countSuppressions(sourceFile) {
  const counts = Object.fromEntries(SUPPRESSION_KINDS.map((kind) => [kind, 0]));
  const text = sourceFile.getFullText();
  counts.tsNoCheck = (text.match(/^\s*(?:\/\/|\/\*)\s*@ts-nocheck\b/gm) ?? []).length;
  // The scanner is the authority for error directives. Re-parsing the source
  // with a line-start regex disagrees with TypeScript for trailing comments,
  // triple-slash comments and directives on the final line of a block comment;
  // searching raw text also turns prose and strings into false suppressions.
  // `commentDirectives` is the exact record consumed when TypeScript filters
  // semantic diagnostics, so the ratchet now counts the same lexical surface
  // as the compiler it protects.
  for (const directive of sourceFile.commentDirectives ?? []) {
    if (directive.type === ts.CommentDirectiveType.Ignore) counts.tsIgnore += 1;
    if (directive.type === ts.CommentDirectiveType.ExpectError) counts.tsExpectError += 1;
  }

  const visit = (node) => {
    if (ts.isTypeReferenceNode(node) || node.kind === ts.SyntaxKind.AnyKeyword) {
      if (node.kind === ts.SyntaxKind.AnyKeyword) counts.explicitAny += 1;
    }
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression?.(node)) {
      if (node.type?.kind === ts.SyntaxKind.AnyKeyword) counts.asAny += 1;
      const inner = node.expression;
      if ((ts.isAsExpression(inner) || ts.isTypeAssertionExpression?.(inner))
        && inner.type?.kind === ts.SyntaxKind.UnknownKeyword) {
        counts.doubleAssertion += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return counts;
}

/**
 * Measure the maintained Expo program.
 * @param {{ projectRoot?: string }} [options]
 */
export function measure({ projectRoot = MOBILE_ROOT, roots = MEASURED_ROOTS } = {}) {
  const program = loadProgram(projectRoot);
  const checker = program.getTypeChecker();
  const files = [];
  let totalIdentifiers = 0;
  let anyIdentifiers = 0;
  const suppressions = Object.fromEntries(SUPPRESSION_KINDS.map((kind) => [kind, 0]));

  for (const sourceFile of program.getSourceFiles()) {
    const relativePath = relative(projectRoot, sourceFile.fileName).replace(/\\/g, "/");
    if (!isMeasured(relativePath, roots)) continue;

    let fileTotal = 0;
    let fileAny = 0;
    const visit = (node) => {
      if (ts.isIdentifier(node)) {
        // Property names in object literals and import/export specifiers carry
        // no independent type, so counting them would inflate the denominator.
        const parent = node.parent;
        const isDeclarationName = parent
          && (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)
            || ts.isPropertyAssignment(parent) && parent.name === node
            || ts.isPropertySignature(parent) && parent.name === node
            || ts.isMethodSignature(parent) && parent.name === node
            || ts.isQualifiedName(parent));
        if (!isDeclarationName) {
          const type = checker.getTypeAtLocation(node);
          fileTotal += 1;
          if (type && (type.flags & ts.TypeFlags.Any) !== 0) fileAny += 1;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    const fileSuppressions = countSuppressions(sourceFile);
    for (const kind of SUPPRESSION_KINDS) suppressions[kind] += fileSuppressions[kind];

    totalIdentifiers += fileTotal;
    anyIdentifiers += fileAny;
    files.push({
      path: relativePath,
      identifiers: fileTotal,
      any: fileAny,
      coveragePercent: fileTotal === 0 ? 100 : round((fileTotal - fileAny) / fileTotal * 100),
      suppressions: fileSuppressions,
    });
  }

  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    fileCount: files.length,
    totalIdentifiers,
    anyIdentifiers,
    coveragePercent: totalIdentifiers === 0 ? 100 : round((totalIdentifiers - anyIdentifiers) / totalIdentifiers * 100),
    suppressions,
    files,
  };
}

function round(value) {
  return Math.floor(value * 100) / 100;
}

export function loadBaseline(path = BASELINE_PATH) {
  return loadCoveragePins(path);
}

export function validateBaseline(baseline) {
  const problems = [];
  if (!baseline || typeof baseline !== "object") return ["baseline must be an object"];
  if (baseline.schema !== 1) problems.push("baseline schema must be 1");
  if (typeof baseline.minimum_coverage_percent !== "number"
    || baseline.minimum_coverage_percent <= 0
    || baseline.minimum_coverage_percent > 100) {
    problems.push("minimum_coverage_percent must be a percentage above zero");
  }
  if (typeof baseline.new_file_minimum_percent !== "number"
    || baseline.new_file_minimum_percent < MINIMUM_NEW_FILE_FLOOR
    || baseline.new_file_minimum_percent > 100) {
    problems.push(
      `new_file_minimum_percent must be between ${MINIMUM_NEW_FILE_FLOOR} and 100`,
    );
  }
  if (!baseline.files || typeof baseline.files !== "object" || Array.isArray(baseline.files)) {
    problems.push("files must be a per-file coverage map");
  } else if (Object.entries(baseline.files).some(([path, percent]) =>
    !isMeasured(path) || typeof percent !== "number" || percent < 0 || percent > 100)) {
    problems.push("every per-file baseline entry must be a measured path and a percentage");
  }
  const maximums = baseline.maximum_suppressions;
  if (!maximums || typeof maximums !== "object") {
    problems.push("maximum_suppressions must be an object");
  } else {
    for (const kind of SUPPRESSION_KINDS) {
      if (!Number.isInteger(maximums[kind]) || maximums[kind] < 0) {
        problems.push(`maximum_suppressions.${kind} must be a non-negative integer`);
      }
    }
  }
  if (typeof baseline.measured_on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(baseline.measured_on)) {
    problems.push("measured_on must be an exact YYYY-MM-DD date");
  }
  return problems;
}

/**
 * Compare a measurement with the baseline.
 *
 * The aggregate floor is the comparison base's own measured coverage when the
 * run could measure it (`aggregateFloor`), and the committed
 * `minimum_coverage_percent` only when it could not. Owner ruling of October
 * 28, 2026, 6:49 PM ET (pipeline loosening, wave 5): a committed aggregate
 * that every update raised failed queued branches whenever Main's coverage
 * moved, while the question that matters is whether this change lowered the
 * coverage of the commit it starts from. The committed number stays as a
 * fixed backstop and `--update` no longer raises it.
 * @param {{ aggregateFloor?: { percent: number, source: string } | null }} [options]
 * @returns {string[]} failures; empty means the ratchet holds
 */
export function compare(measurement, baseline, { aggregateFloor = null } = {}) {
  const failures = [];
  const floor = aggregateFloor?.percent ?? baseline.minimum_coverage_percent;
  if (measurement.coveragePercent < floor) {
    failures.push(
      `aggregate type coverage fell to ${measurement.coveragePercent}% from the ${floor}% floor`
        + (aggregateFloor ? ` measured at ${aggregateFloor.source}` : ""),
    );
  }
  for (const kind of SUPPRESSION_KINDS) {
    const limit = baseline.maximum_suppressions[kind];
    if (measurement.suppressions[kind] > limit) {
      failures.push(`${kind} suppressions rose to ${measurement.suppressions[kind]}, above the ${limit} ceiling`);
    }
  }
  return failures;
}

/**
 * Per-file additive-only rule, applied to every measured file.
 *
 * A file the baseline already knows may not fall below its own recorded
 * coverage — that is the additive part, and it is stricter and fairer than one
 * repository-wide number, because a file that is 100% typed today cannot
 * quietly slide toward the aggregate average. A file the baseline does not know
 * is new, and must clear the reviewed new-file floor.
 *
 * The rule is deliberately evaluated over the whole measured program rather
 * than over a git diff. A changed file is a subset of the measured files, so
 * this is strictly stronger, and it needs no base ref, no second checkout and
 * no fetch depth — which is what lets it run in the mobile CI lane from
 * candidate code instead of only on a developer's machine.
 */
export function perFileFailures(measurement, baseline, { requireRecorded = true } = {}) {
  const recorded = baseline.files ?? {};
  const failures = [];
  for (const file of measurement.files) {
    if (file.identifiers === 0) continue;
    if (Object.hasOwn(recorded, file.path)) {
      if (file.coveragePercent < recorded[file.path]) {
        failures.push(
          `${file.path} fell to ${file.coveragePercent}% typed from its recorded ${recorded[file.path]}%`,
        );
      }
      continue;
    }
    if (requireRecorded) {
      failures.push(`${file.path} is missing its required per-file baseline entry; record a passing new file with --update`);
    }
    if (file.coveragePercent < baseline.new_file_minimum_percent) {
      failures.push(
        `${file.path} is ${file.coveragePercent}% typed, below the ${baseline.new_file_minimum_percent}% floor for new files`,
      );
    }
  }
  return failures;
}

/**
 * The complete enforced rule set, in the exact composition `npm run
 * type-coverage` applies. Every caller that decides pass or fail — the enforce
 * path and the `--update` regression guard — goes through this function, so a
 * rule cannot be enforced in one place and silently dropped in the other.
 */
export function evaluate(measurement, baseline, options = {}) {
  return [...compare(measurement, baseline, options), ...perFileFailures(measurement, baseline, options)];
}

/**
 * Repository paths outside apps/mobile that the mobile program loads.
 * src/ is one: the phone app re-exports src/lib/shared-core, and a tree
 * without it would measure those imports as any, below the working tree.
 */
export const BASE_TREE_PATHS = Object.freeze(["apps/mobile", "api", "packages", "src", "scripts", "tests/fixtures", "tests/helpers"]);

/**
 * The commit whose measured coverage is the aggregate floor, or null when this
 * run uses the committed backstop. `TYPE_COVERAGE_BASE_SHA` names it (or
 * `none`); otherwise a local run uses the merge base with origin/Main. A CI run
 * measures a base only when the workflow names one, because the mobile lane's
 * blob-filtered clone holds no base source until the workflow fetches it.
 */
export function aggregateBaseCommit({ repositoryRoot = resolve(MOBILE_ROOT, "../.."), env = process.env } = {}) {
  const named = (env.TYPE_COVERAGE_BASE_SHA ?? "").trim();
  if (named === "none") return null;
  if (named) {
    if (!/^[0-9a-f]{40}$/.test(named)) throw new Error("TYPE_COVERAGE_FAIL: TYPE_COVERAGE_BASE_SHA must be an exact commit or none");
    return named;
  }
  if (env.GITHUB_ACTIONS === "true") return null;
  try {
    const base = execFileSync("git", ["merge-base", "HEAD", "refs/remotes/origin/Main"], {
      cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40}$/.test(base) ? base : null;
  } catch {
    return null;
  }
}

/**
 * Measure the mobile program as it stood at `commit`, from a temporary export
 * of the paths it loads with this checkout's installed dependencies. Returns
 * null when the commit's source is not available locally; the caller then uses
 * the committed backstop and says so.
 */
export function measureAtCommit(commit, { repositoryRoot = resolve(MOBILE_ROOT, "../..") } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "type-coverage-base-"));
  try {
    const env = { ...process.env, GIT_NO_LAZY_FETCH: "1" };
    const present = execFileSync("git", ["ls-tree", "--name-only", commit, "--", ...BASE_TREE_PATHS], {
      cwd: repositoryRoot, encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"],
    }).split("\n").filter(Boolean);
    if (!present.includes("apps/mobile")) return null;
    const archive = execFileSync("git", ["archive", "--format=tar", commit, "--", ...present], {
      cwd: repositoryRoot, env, maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    });
    execFileSync("tar", ["-x", "-C", scratch], { input: archive, stdio: ["pipe", "ignore", "ignore"] });
    symlinkSync(join(repositoryRoot, "node_modules"), join(scratch, "node_modules"), "junction");
    symlinkSync(join(MOBILE_ROOT, "node_modules"), join(scratch, "apps/mobile/node_modules"), "junction");
    return measure({ projectRoot: join(scratch, "apps/mobile") });
  } catch {
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function aggregateFloorForRun() {
  const commit = aggregateBaseCommit();
  if (!commit) return null;
  const base = measureAtCommit(commit);
  if (!base) {
    console.log(`type coverage: could not measure the comparison base ${commit.slice(0, 12)}; using the committed aggregate floor.`);
    return null;
  }
  console.log(`type coverage at the comparison base ${commit.slice(0, 12)}: ${base.coveragePercent}% (the aggregate floor for this run)`);
  return { percent: base.coveragePercent, source: `the comparison base ${commit.slice(0, 12)}` };
}

/**
 * Parse the command line. `--baseline <path>` selects which recorded baseline a
 * run reads (and, under `--update`, records into). It exists so a regression
 * test can drive the real CLI against a doctored baseline without mutating the
 * working tree; the enforced rule set is identical either way.
 */
export function parseArguments(args) {
  const index = args.indexOf("--baseline");
  if (index !== -1) {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("TYPE_COVERAGE_FAIL: --baseline needs a path");
    }
  }
  return {
    report: args.includes("--report"),
    update: args.includes("--update"),
    acceptRegression: args.includes("--accept-regression"),
    baselinePath: index === -1 ? BASELINE_PATH : resolve(args[index + 1]),
  };
}

function main() {
  const { report, update, acceptRegression, baselinePath } = parseArguments(process.argv.slice(2));

  const measurement = measure();
  console.log(
    `type coverage: ${measurement.coveragePercent}% over ${measurement.fileCount} maintained files `
      + `(${measurement.anyIdentifiers} of ${measurement.totalIdentifiers} identifiers are any); `
      + `suppressions ${JSON.stringify(measurement.suppressions)}`,
  );
  if (report) return;

  // CI checks immutable baseline history in the separate security job, which
  // fetches the exact event base. Mobile measurement needs only candidate code.
  // Local updates still guard HEAD and Main even with --accept-regression.
  if (update && process.env.GITHUB_ACTIONS === "true") {
    throw new Error("TYPE_COVERAGE_FAIL: baseline updates are local-only");
  }
  // Excluded declarations still affect inferred types in maintained files.
  // An update must see the same ambient types as a clean CI install.
  if (update && (existsSync(join(MOBILE_ROOT, ".expo/types/router.d.ts"))
    || existsSync(join(MOBILE_ROOT, "expo-env.d.ts")))) {
    throw new Error(
      "TYPE_COVERAGE_FAIL: refusing to update the baseline while generated Expo declarations exist. "
      + "Remove apps/mobile/.expo/types/router.d.ts and apps/mobile/expo-env.d.ts, "
      + "then rerun npm run type-coverage:update to match a clean CI install.",
    );
  }
  const historical = process.env.GITHUB_ACTIONS === "true" ? []
    : readBaselineHistory({ repositoryRoot: resolve(MOBILE_ROOT, "../..") });

  if (update) {
    let baseline;
    try {
      baseline = loadBaseline(baselinePath);
    } catch (error) {
      if (error.code !== "ENOENT" || historical.length > 0) {
        throw new Error("TYPE_COVERAGE_FAIL: refusing to reset an unreadable baseline", { cause: error });
      }
      baseline = null;
    }
    const historyFailures = baseline ? baselineHistoryFailures(baseline, historical) : [];
    for (const previous of historical) {
      historyFailures.push(...evaluate(measurement, previous, { requireRecorded: false }));
    }
    if (historyFailures.length > 0) {
      console.error("TYPE_COVERAGE_FAIL: refusing to lower historical baseline floors:");
      for (const failure of historyFailures) console.error(`  - ${failure}`);
      process.exitCode = 1;
      return;
    }
    if (baseline && !acceptRegression) {
      const regressions = evaluate(measurement, baseline, { requireRecorded: false });
      if (regressions.length > 0) {
        console.error("TYPE_COVERAGE_FAIL: refusing to lower the baseline. Fix the regression, or pass --accept-regression with a recorded reason:");
        for (const failure of regressions) console.error(`  - ${failure}`);
        process.exitCode = 1;
        return;
      }
    }
    const next = {
      schema: 1,
      measured_on: new Date().toISOString().slice(0, 10),
      // A fixed backstop: the aggregate floor is measured at the base in-run.
      minimum_coverage_percent: baseline?.minimum_coverage_percent ?? measurement.coveragePercent,
      new_file_minimum_percent: baseline?.new_file_minimum_percent ?? DEFAULT_NEW_FILE_FLOOR,
      maximum_suppressions: { ...measurement.suppressions },
      measured_file_count: measurement.fileCount,
      exclusions: EXCLUDED_PATTERNS.map(String),
      // Keep retired paths so deleting then reintroducing source cannot reset a floor.
      files: {
        ...baseline?.files,
        ...Object.fromEntries(measurement.files
          .filter((file) => file.identifiers > 0)
          .map((file) => [file.path, file.coveragePercent])),
      },
    };
    if (baseline) appendCoveragePin(baselinePath, baseline, next);
    else writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`baseline updated to ${next.minimum_coverage_percent}%`);
    return;
  }

  let baseline;
  try {
    baseline = loadBaseline(baselinePath);
  } catch (error) {
    console.error(`TYPE_COVERAGE_FAIL: the baseline is unreadable: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const baselineProblems = validateBaseline(baseline);
  if (baselineProblems.length > 0) {
    console.error("TYPE_COVERAGE_FAIL: the baseline is invalid");
    for (const problem of baselineProblems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  const aggregateFloor = aggregateFloorForRun();
  const failures = [
    ...evaluate(measurement, baseline, { aggregateFloor }),
    ...baselineHistoryFailures(baseline, historical),
    ...historical.flatMap((previous) => evaluate(measurement, previous, { requireRecorded: false, aggregateFloor })),
  ];

  if (failures.length > 0) {
    console.error("TYPE_COVERAGE_FAIL: type safety regressed");
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(
      "Type the new boundary, or raise the baseline deliberately with `npm run type-coverage:update`.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`type-coverage ratchet holds against the ${aggregateFloor?.percent ?? baseline.minimum_coverage_percent}% `
    + `${aggregateFloor ? "aggregate measured at the comparison base" : "baseline"}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
