import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUMMARY_PATH = "coverage/coverage-summary.json";
const BASELINE_PATH = "assurance/coverage-baseline.json";
const METRICS = ["lines", "functions", "branches", "statements"];
const NEW_FILE_MINIMUMS = { lines: 80, functions: 80, branches: 70, statements: 80 };
const EPSILON = 0.01;
// The totals move by about 0.01 points between two runs of one tree (Main
// runs 38249573319 and 38262426944 differed by that much on functions and
// lines), so a global backstop at the per-file epsilon would turn a raised
// total into a flaky gate. The per-file floors carry the ratchet; the global
// check tolerates ten times that noise and still catches a broad regression.
export const GLOBAL_EPSILON = 0.1;
// OPS-UG-CI-COVERAGE-NIGHTLY-ALL-FILES-AND-RETRY-IDENTITY-20261109: the
// nightly's all-files lane holds every tracked file with a recorded floor to
// it. A file's percentage moves between full runs of one suite: across Main
// merge groups 42732607343, 42731259039 and 42727291574 (Nov 9, 2026), 52 file
// metrics moved, by up to 6.51 points (src/views/StewardView.jsx branches).
// The floor keeps each file's best run, so the lane allows ten points: a file
// that falls to zero, or loses a large share, still fails.
export const ALL_FILES_EPSILON = 10;
const KNOWN_DEFICITS_PATH = "assurance/coverage-nightly-known-deficits.json";
const FLOAT_TOLERANCE = 1e-9;
const ELIGIBLE_SOURCE = /^(?:src\/.*\.(?:js|jsx)|workers\/.*\.(?:js|ts)|api\/.*\.js)$/;
const EXCLUDED_SOURCE = /(?:^src\/main\.jsx$|\.d\.ts$|\.(?:test|spec)\.(?:js|jsx|ts)$)/;
const EXACT_COMMIT_SHA = /^[0-9a-f]{40}$/;
const ZERO_COMMIT_SHA = /^0{40}$/;

function normalizeSlashes(value) {
  return value.replaceAll("\\", "/");
}

// A merged coverage summary produced on another runner slot carries that
// slot's absolute workspace root; the merged receipt records it as
// producer_root, so a file under that root is repository-relative too.
function normalizeFilePath(file, cwd, producerRoot) {
  const normalizedFile = normalizeSlashes(file);
  if (producerRoot && cwd !== producerRoot) {
    const normalizedProducer = normalizeSlashes(producerRoot).replace(/\/$/, "");
    const normalizedCwdPrefix = `${normalizeSlashes(cwd).replace(/\/$/, "")}/`;
    if (!normalizedFile.startsWith(normalizedCwdPrefix) && normalizedFile.startsWith(`${normalizedProducer}/`)) {
      return normalizedFile.slice(normalizedProducer.length + 1);
    }
  }
  const normalizedCwd = normalizeSlashes(cwd).replace(/\/$/, "");
  const fileComparison = /^[A-Za-z]:\//.test(normalizedFile)
    ? normalizedFile.toLowerCase()
    : normalizedFile;
  const cwdComparison = /^[A-Za-z]:\//.test(normalizedCwd)
    ? normalizedCwd.toLowerCase()
    : normalizedCwd;

  if (fileComparison.startsWith(`${cwdComparison}/`)) {
    return normalizedFile.slice(normalizedCwd.length + 1);
  }
  if (isAbsolute(normalizedFile)) {
    return normalizeSlashes(relative(normalizedCwd, normalizedFile));
  }
  return normalizedFile.replace(/^\.\//, "");
}

function normalizeMetrics(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Coverage summary ${label} must be an object`);
  }

  return Object.fromEntries(METRICS.map((metric) => {
    if (!value[metric] || !("pct" in value[metric])) {
      throw new TypeError(`Coverage summary ${label} is missing ${metric}.pct`);
    }
    const percentage = value[metric].pct;
    if (typeof percentage !== "number" || !Number.isFinite(percentage)) {
      throw new TypeError(`Coverage summary ${label} has invalid ${metric}.pct`);
    }
    return [metric, { pct: percentage }];
  }));
}

function validateCoverageData(coverage, label) {
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
    throw new TypeError(`${label} must be an object`);
  }
  if (!("total" in coverage)) {
    throw new TypeError(`${label} is missing total`);
  }
  if (!coverage.files || typeof coverage.files !== "object" || Array.isArray(coverage.files)) {
    throw new TypeError(`${label} is missing files`);
  }

  return {
    total: normalizeMetrics(coverage.total, `${label} total`),
    files: Object.fromEntries(Object.entries(coverage.files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([file, fileMetrics]) => [normalizeSlashes(file), normalizeMetrics(fileMetrics, `${label} ${file}`)])),
  };
}

export function normalizeCoverageSummary(summary, cwd = process.cwd(), producerRoot) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    throw new TypeError("Coverage summary must be an object");
  }
  if (!("total" in summary)) {
    throw new TypeError("Coverage summary is missing total");
  }

  const files = Object.entries(summary)
    .filter(([file]) => file !== "total")
    .map(([file, fileMetrics]) => [
      normalizeFilePath(file, cwd, producerRoot),
      normalizeMetrics(fileMetrics, file),
    ])
    .sort(([left], [right]) => left.localeCompare(right));

  return {
    total: normalizeMetrics(summary.total, "total"),
    files: Object.fromEntries(files),
  };
}

function regressed(actual, baseline, epsilon) {
  return actual + epsilon < baseline - FLOAT_TOLERANCE;
}

function regressionFinding(lane, metric, expected, actual, file) {
  return {
    lane,
    ...(file ? { file } : {}),
    metric,
    expected,
    actual,
  };
}

export function isCoverageEligible(file) {
  const normalized = normalizeSlashes(file);
  return ELIGIBLE_SOURCE.test(normalized) && !EXCLUDED_SOURCE.test(normalized);
}

// changedOnly applies the per-file lanes to a summary that instruments only
// the changed eligible files (the pull-request root tests): the totals and
// every unchanged file need the whole suite's map, so the global lane is
// skipped and only a changed eligible file may be missing.
export function compareCoverage({
  current,
  baseline,
  changedFiles,
  trackedFiles,
  changedOnly = false,
  allFiles = false,
  knownDeficits = {},
  epsilon = EPSILON,
  globalEpsilon = GLOBAL_EPSILON,
  allFilesEpsilon = ALL_FILES_EPSILON,
  newFileMinimums = NEW_FILE_MINIMUMS,
}) {
  const normalizedCurrent = validateCoverageData(current, "Current coverage");
  const normalizedBaseline = validateCoverageData(baseline, "Coverage baseline");
  const changed = new Set((changedFiles ?? []).map(normalizeSlashes));
  const tracked = new Set(changedOnly ? [] : (trackedFiles ?? []).map(normalizeSlashes));
  const findings = [];

  for (const metric of changedOnly ? [] : METRICS) {
    const actual = normalizedCurrent.total[metric].pct;
    const recorded = normalizedBaseline.total[metric].pct;
    if (regressed(actual, recorded, globalEpsilon)) {
      findings.push(regressionFinding("global", metric, recorded - globalEpsilon, actual));
    }
  }

  const eligibleSources = [...new Set([...tracked, ...changed])]
    .filter(isCoverageEligible)
    .sort((left, right) => left.localeCompare(right));
  for (const file of eligibleSources) {
    if (!normalizedCurrent.files[file]) {
      findings.push({ lane: "missing-coverage", file });
    }
  }

  for (const file of changed) {
    const currentFile = normalizedCurrent.files[file];
    if (!currentFile) continue;
    const baselineFile = normalizedBaseline.files[file];
    if (baselineFile) {
      for (const metric of METRICS) {
        const actual = currentFile[metric].pct;
        const recorded = baselineFile[metric].pct;
        const minimum = newFileMinimums[metric];
        if (file.startsWith("api/") && isCoverageEligible(file) && recorded < minimum && actual < minimum) {
          findings.push(regressionFinding("changed-api-floor", metric, minimum, actual, file));
          continue;
        }
        if (regressed(actual, recorded, epsilon)) {
          findings.push(regressionFinding("changed-file", metric, recorded - epsilon, actual, file));
        }
      }
      continue;
    }

    for (const metric of METRICS) {
      const actual = currentFile[metric].pct;
      const minimum = newFileMinimums[metric];
      if (actual < minimum) {
        findings.push(regressionFinding("new-file", metric, minimum, actual, file));
      }
    }
  }

  // allFiles: every unchanged tracked file with a recorded floor, which the
  // changed-file lane never reaches. A known deficit (a file already below
  // its floor on Main when the lane started) is held to its measured value
  // instead, so the lane reports new drops. A file without a floor has
  // nothing recorded to fall from; the new-file and API floors stay with the
  // change that touches it.
  for (const file of allFiles ? eligibleSources : []) {
    const currentFile = normalizedCurrent.files[file];
    const baselineFile = normalizedBaseline.files[file];
    if (changed.has(file) || !currentFile || !baselineFile) continue;
    for (const metric of METRICS) {
      const recorded = Math.min(baselineFile[metric].pct, knownDeficits[file]?.[metric] ?? Number.POSITIVE_INFINITY);
      const actual = currentFile[metric].pct;
      if (regressed(actual, recorded, allFilesEpsilon)) {
        findings.push(regressionFinding("all-files", metric, recorded - allFilesEpsilon, actual, file));
      }
    }
  }

  return findings;
}

// The known deficits: { "files": { "<path>": { "<metric>": pct } } }.
export function readKnownDeficits(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) || !value.files || typeof value.files !== "object" || Array.isArray(value.files)) {
    throw new TypeError(`${KNOWN_DEFICITS_PATH} must hold a files object`);
  }
  return Object.fromEntries(Object.entries(value.files).map(([file, metrics]) => {
    if (!isCoverageEligible(file) || !metrics || typeof metrics !== "object" || Array.isArray(metrics)) throw new TypeError(`${KNOWN_DEFICITS_PATH}: invalid entry ${file}`);
    for (const [metric, pct] of Object.entries(metrics)) {
      if (!METRICS.includes(metric) || typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) {
        throw new TypeError(`${KNOWN_DEFICITS_PATH}: invalid ${file} ${metric}`);
      }
    }
    return [file, metrics];
  }));
}

function higherMetrics(current, baseline) {
  return Object.fromEntries(METRICS.map((metric) => [
    metric,
    { pct: Math.max(current[metric].pct, baseline?.[metric]?.pct ?? Number.NEGATIVE_INFINITY) },
  ]));
}

// A recorded file that is absent from the current summary keeps its floor,
// unless it no longer exists: a deleted source's floor can never be measured
// again, so it is dropped (and reported) instead of riding along forever.
export function raiseBaseline({
  current, baseline, epsilon = EPSILON, globalEpsilon = GLOBAL_EPSILON, fileExists = () => true,
}) {
  const normalizedCurrent = validateCoverageData(current, "Current coverage");
  if (baseline === undefined) {
    return { baseline: normalizedCurrent, findings: [] };
  }

  const normalizedBaseline = validateCoverageData(baseline, "Coverage baseline");
  const findings = [];
  const compareRecordedMetrics = (currentMetrics, baselineMetrics, file, tolerance = epsilon) => {
    for (const metric of METRICS) {
      const actual = currentMetrics[metric].pct;
      const recorded = baselineMetrics[metric].pct;
      if (regressed(actual, recorded, tolerance)) {
        findings.push(regressionFinding("baseline-update", metric, recorded - tolerance, actual, file));
      }
    }
  };

  compareRecordedMetrics(normalizedCurrent.total, normalizedBaseline.total, undefined, globalEpsilon);
  for (const [file, baselineMetrics] of Object.entries(normalizedBaseline.files)) {
    if (normalizedCurrent.files[file]) {
      compareRecordedMetrics(normalizedCurrent.files[file], baselineMetrics, file);
    }
  }
  for (const [file, currentMetrics] of Object.entries(normalizedCurrent.files)) {
    if (normalizedBaseline.files[file]) continue;
    for (const metric of METRICS) {
      const actual = currentMetrics[metric].pct;
      const minimum = NEW_FILE_MINIMUMS[metric];
      if (actual < minimum) {
        findings.push(regressionFinding("new-file", metric, minimum, actual, file));
      }
    }
  }

  if (findings.length > 0) return { findings };

  const files = {};
  const dropped = [];
  for (const file of [...new Set([
    ...Object.keys(normalizedBaseline.files),
    ...Object.keys(normalizedCurrent.files),
  ])].sort((left, right) => left.localeCompare(right))) {
    const currentMetrics = normalizedCurrent.files[file];
    const baselineMetrics = normalizedBaseline.files[file];
    if (!currentMetrics && !fileExists(file)) {
      dropped.push(file);
      continue;
    }
    files[file] = currentMetrics && baselineMetrics
      ? higherMetrics(currentMetrics, baselineMetrics)
      : (currentMetrics ?? baselineMetrics);
  }

  return {
    baseline: {
      total: higherMetrics(normalizedCurrent.total, normalizedBaseline.total),
      files,
    },
    dropped,
    findings: [],
  };
}

export function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${path}: ${error.message}`, { cause: error });
  }
}

function exactCommitSha(label, value) {
  if (!EXACT_COMMIT_SHA.test(value ?? "") || ZERO_COMMIT_SHA.test(value)) {
    throw new Error(`${label} must be a nonzero exact 40-character lowercase commit SHA`);
  }
  return value;
}

function resolveExactCommit(label, value, execute) {
  const sha = exactCommitSha(label, value);
  let resolved;
  try {
    resolved = execute("git", ["rev-parse", "--verify", `${sha}^{commit}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(`${label} ${sha} is unavailable; fetch the exact event commit`);
  }
  if (resolved !== sha) throw new Error(`${label} ${sha} did not resolve to that exact commit`);
  return sha;
}

export function resolveCoverageRefs(baseRef, headRef, execute = execFileSync) {
  if (Boolean(baseRef) !== Boolean(headRef)) {
    throw new Error("ASSURANCE_BASE_REF and ASSURANCE_HEAD_REF must be provided together");
  }
  if (baseRef && headRef) {
    return {
      baseSha: resolveExactCommit("ASSURANCE_BASE_REF", baseRef, execute),
      headSha: resolveExactCommit("ASSURANCE_HEAD_REF", headRef, execute),
    };
  }

  const options = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  const localHead = execute("git", ["rev-parse", "--verify", "HEAD^{commit}"], options).trim();
  const localBase = execute("git", ["merge-base", "origin/Main", localHead], options).trim();
  return {
    baseSha: exactCommitSha("local coverage base", localBase),
    headSha: exactCommitSha("local coverage head", localHead),
  };
}

function nulPathOutput(output, label) {
  const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output);
  if (bytes.length > 0 && bytes.at(-1) !== 0) {
    throw new Error(`${label} is not NUL terminated`);
  }
  return bytes.length === 0
    ? []
    : bytes.subarray(0, -1).toString("utf8").split("\0").map(normalizeSlashes).filter(Boolean);
}

function gitPathOutput(args, label, execute) {
  return nulPathOutput(execute("git", args, {
    encoding: null,
    stdio: ["ignore", "pipe", "pipe"],
  }), label);
}

export function changedFiles(baseRef, headRef, execute = execFileSync) {
  const baseSha = exactCommitSha("coverage base", baseRef);
  const headSha = exactCommitSha("coverage head", headRef);
  return gitPathOutput([
    "diff", "--name-only", "-z", "--diff-filter=ACMR", `${baseSha}...${headSha}`, "--",
  ], "git diff --name-only output", execute);
}

export function localChangedFiles(baseRef, headRef, execute = execFileSync) {
  const paths = [
    ...changedFiles(baseRef, headRef, execute),
    ...gitPathOutput([
      "diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR", "--",
    ], "git diff --cached output", execute),
    ...gitPathOutput([
      "diff", "--name-only", "-z", "--diff-filter=ACMR", "--",
    ], "git diff working-tree output", execute),
    ...gitPathOutput([
      "ls-files", "--others", "--exclude-standard", "-z", "--",
    ], "git ls-files --others output", execute),
  ];
  return [...new Set(paths)];
}

export function trackedSourceFiles(cwd = process.cwd(), execute = execFileSync) {
  return execute("git", ["-C", cwd, "ls-files", "-z", "--", "src", "workers", "api"], { encoding: "utf8" })
    .split("\0")
    .map((file) => normalizeSlashes(file.trim()))
    .filter((file) => file && isCoverageEligible(file));
}

// A recorded floor is dropped only for a file the candidate no longer tracks.
// The index, not the working tree, decides: a sparse checkout or an unstaged
// deletion leaves a tracked file absent from disk, and its floor must stay.
export function trackedFileCheck(cwd = process.cwd(), execute = execFileSync) {
  // One path per query: listing the whole index would outgrow the default
  // subprocess buffer (about 1.4 MB of paths here), and this runs only for
  // the few recorded files missing from the coverage report.
  return (file) => {
    let listed;
    try {
      listed = execute("git", ["-C", cwd, "ls-files", "-z", "--", file], { encoding: "utf8" });
    } catch (error) {
      throw new Error("Cannot read the tracked files, so no recorded floor can be dropped", { cause: error });
    }
    return listed.split("\0").some((entry) => normalizeSlashes(entry) === normalizeSlashes(file));
  };
}

// OPS-UG-CI-QUEUE-COVERAGE-TRIAL-20261109 (upstream decision of November 9,
// 2026, item 8: a one-week trial). With CI_QUEUE_COVERAGE_MODE=trial, which
// ci.yml sets on merge groups only, the root coverage shards measure only the
// changed eligible sources between the exact event commits, and the ratchet
// compares only those files; coverage-nightly.yml applies the whole ratchet to
// Main every night. Unset, "full" or any other value is the full run. So is a
// trial with nothing measurable changed or an unreadable diff, and `reason`
// says why. The producer, the merge, the base commit's re-read and this
// ratchet each call this, so the base commit's copy decides what a trial
// receipt must contain (BUG-UG-COVERAGE-GATE-ISOLATE-FROM-CANDIDATE-CODE-20261021).
export const QUEUE_COVERAGE_MODE_ENV = "CI_QUEUE_COVERAGE_MODE";

export function queueCoverageScope(env = process.env, execute = execFileSync) {
  if (env[QUEUE_COVERAGE_MODE_ENV] !== "trial") return { mode: "full" };
  let sources;
  try {
    if (!env.ASSURANCE_BASE_REF || !env.ASSURANCE_HEAD_REF) throw new Error("ASSURANCE_BASE_REF and ASSURANCE_HEAD_REF are required");
    const { baseSha, headSha } = resolveCoverageRefs(env.ASSURANCE_BASE_REF, env.ASSURANCE_HEAD_REF, execute);
    sources = [...new Set(changedFiles(baseSha, headSha, execute).filter(isCoverageEligible))].sort();
  } catch (error) {
    return { mode: "full", requested: "trial", reason: `the changed-file list is unreadable (${error.message})` };
  }
  if (sources.length === 0) return { mode: "full", requested: "trial", reason: "no changed source file to measure" };
  // Vitest reads each --coverage.include value as a glob; a path it would
  // read as a pattern is measured by the full run instead.
  const pattern = sources.find(file => /[\][*?{}()!+@,\\]/u.test(file));
  if (pattern) return { mode: "full", requested: "trial", reason: `${pattern} reads as a glob pattern` };
  return { mode: "trial", sources };
}

// A merged receipt from the trial carries coverage_mode "trial". It is read
// only while the switch is on, and only per file: its totals and every
// unmeasured file wait for the nightly full run.
export function trialReceiptScope(receipt, env = process.env, execute = execFileSync) {
  if (!receipt || (!Object.hasOwn(receipt, "coverage_mode") && !Object.hasOwn(receipt, "measured_sources"))) return undefined;
  if (receipt.coverage_mode !== "trial") throw new Error(`Unknown merged coverage mode ${JSON.stringify(receipt.coverage_mode)}`);
  const scope = queueCoverageScope(env, execute);
  if (scope.mode !== "trial") {
    throw new Error(`A trial coverage receipt is read only with ${QUEUE_COVERAGE_MODE_ENV}=trial and a changed source file; this run is full${scope.reason ? `: ${scope.reason}` : ""}`);
  }
  return scope;
}

function formatFinding(finding) {
  if (finding.lane === "missing-coverage") {
    return `missing-coverage: ${finding.file} is absent from the coverage summary`;
  }
  const file = finding.file ?? "all files";
  return `${finding.lane}: ${file} ${finding.metric} expected ${finding.expected.toFixed(2)}%, actual ${finding.actual.toFixed(2)}%`;
}

function reportFindings(findings) {
  for (const finding of findings) console.error(formatFinding(finding));
  process.exitCode = 1;
}

function rangeChangedFiles() {
  const localMode = !process.env.ASSURANCE_BASE_REF && !process.env.ASSURANCE_HEAD_REF;
  const { baseSha, headSha } = resolveCoverageRefs(
    process.env.ASSURANCE_BASE_REF,
    process.env.ASSURANCE_HEAD_REF,
  );
  return localMode ? localChangedFiles(baseSha, headSha) : changedFiles(baseSha, headSha);
}

function runCli() {
  try {
    const cwd = process.cwd();
    // The pull-request root tests instrument exactly these files, NUL
    // separated, so their summary holds every file --changed-only checks.
    if (process.argv.includes("--list-changed")) {
      for (const file of rangeChangedFiles().filter(isCoverageEligible)) process.stdout.write(`${file}\0`);
      return;
    }
    const summaryPath = resolve(cwd, SUMMARY_PATH);
    const baselinePath = resolve(cwd, BASELINE_PATH);
    // A merged receipt beside the summary names the runner root that wrote it.
    const receiptPath = resolve(cwd, "coverage/merged-receipt.json");
    const receipt = existsSync(receiptPath)
      ? readJson(receiptPath, "merged coverage receipt")
      : undefined;
    const producerRoot = receipt?.producer_root;
    const current = normalizeCoverageSummary(readJson(summaryPath, "coverage summary"), cwd,
      typeof producerRoot === "string" && producerRoot ? producerRoot : undefined);
    const trial = trialReceiptScope(receipt);
    const changedOnly = trial !== undefined || process.argv.includes("--changed-only");
    // The nightly (coverage-nightly.yml) compares every file; never a partial map.
    const allFiles = process.argv.includes("--all-files");
    if (allFiles && changedOnly) throw new Error("--all-files needs a full coverage run; this one measured only the changed files");

    if (process.argv.includes("--update")) {
      if (trial) throw new Error("A trial coverage receipt measured only the changed files; raise the baseline from a full run");
      const baseline = existsSync(baselinePath)
        ? readJson(baselinePath, "coverage baseline")
        : undefined;
      const result = raiseBaseline({
        current,
        baseline,
        fileExists: trackedFileCheck(cwd),
      });
      if (result.findings.length > 0) {
        reportFindings(result.findings);
        return;
      }
      for (const file of result.dropped ?? []) {
        console.log(`Dropped the floor for deleted file ${file}`);
      }

      mkdirSync(dirname(baselinePath), { recursive: true });
      writeFileSync(baselinePath, `${JSON.stringify(result.baseline, null, 2)}\n`);
      console.log(`Coverage baseline ${baseline ? "raised" : "created"}: ${BASELINE_PATH}`);
      return;
    }

    if (!existsSync(baselinePath)) {
      throw new Error(`Coverage baseline does not exist at ${baselinePath}; run with --update to create it`);
    }
    const baseline = readJson(baselinePath, "coverage baseline");
    const findings = compareCoverage({
      current,
      baseline,
      changedFiles: rangeChangedFiles(),
      trackedFiles: changedOnly ? [] : trackedSourceFiles(cwd),
      changedOnly,
      allFiles,
      knownDeficits: allFiles && existsSync(resolve(cwd, KNOWN_DEFICITS_PATH))
        ? readKnownDeficits(readJson(resolve(cwd, KNOWN_DEFICITS_PATH), "known coverage deficits"))
        : {},
    });
    if (findings.length > 0) {
      reportFindings(findings);
      return;
    }
    console.log(trial
      ? `Trial coverage ratchet passed for ${trial.sources.length} changed source file(s) with zero regressions; coverage-nightly.yml applies the whole ratchet to Main.`
      : allFiles
      ? "All-files coverage ratchet passed: the totals and every tracked file with a recorded floor hold."
      : changedOnly
      ? "Changed-file coverage ratchet passed with zero regressions; the merge group still applies the whole ratchet."
      : "Coverage ratchet passed with zero regressions.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli();
}
