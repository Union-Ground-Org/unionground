import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCoveragePins, readCommittedCoveragePins } from "./lib/type-coverage-pins.mjs";

const BASELINE = "apps/mobile/type-coverage-baseline.json";
const SHA = /^[0-9a-f]{40}$/;
const KINDS = ["tsNoCheck", "tsIgnore", "tsExpectError", "explicitAny", "asAny", "doubleAssertion"];

function validBaseline(value) {
  const percent = (n) => Number.isFinite(n) && n >= 0 && n <= 100;
  return value?.schema === 1 && percent(value.minimum_coverage_percent)
    && percent(value.new_file_minimum_percent)
    && value.files && typeof value.files === "object" && !Array.isArray(value.files)
    && Object.values(value.files).every(percent)
    && KINDS.every((kind) => Number.isInteger(value.maximum_suppressions?.[kind]) && value.maximum_suppressions[kind] >= 0);
}

/** Read immutable blobs, never a mutable ref's working-tree baseline. */
export function readBaselineHistory({ repositoryRoot, env = process.env }) {
  return readHistoricalJson({ repositoryRoot, env, repositoryPath: BASELINE, validate: validBaseline,
    transform: (_baseline, sha, git) => readCommittedCoveragePins(BASELINE, sha, git) });
}

/** Shared exact-event Git reader for versioned ratchet baselines. */
export function readHistoricalJson({ repositoryRoot, env = process.env, repositoryPath, validate, transform = value => value }) {
  const git = (...args) => {
    try {
      return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch {
      // Child errors may contain arbitrary repository content. Keep diagnostics bounded.
      throw new Error("TYPE_COVERAGE_FAIL: required Git history is unavailable");
    }
  };
  // The pull request fork point: GitHub fills base.sha with the Main tip when
  // the run is created, so a floor that landed on Main after the branch forked
  // would fail every open branch until it merged Main again. The merge_group
  // run still compares against the group base before anything merges. A
  // checkout without the shared history keeps the stricter tip.
  const forkPoint = (base, head) => {
    git("rev-parse", "--verify", `${base}^{commit}`);
    let fork = "";
    try {
      fork = execFileSync("git", ["merge-base", base, head], { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch { /* No common commit is present in a shallow checkout. */ }
    if (SHA.test(fork)) return fork;
    console.warn(`Historical baseline: no merge base of ${base} and ${head} in this checkout; comparing against the event base.`);
    return base;
  };
  const head = git("rev-parse", "--verify", "HEAD^{commit}");
  let sources;
  if (env.GITHUB_ACTIONS === "true") {
    let event;
    try { event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")); }
    catch { throw new Error("TYPE_COVERAGE_FAIL: authenticated CI event is unreadable"); }
    let base; let expectedHead;
    if (env.GITHUB_EVENT_NAME === "pull_request") {
      base = event.pull_request?.base?.sha; expectedHead = event.pull_request?.head?.sha;
    } else if (env.GITHUB_EVENT_NAME === "push") {
      base = event.before; expectedHead = event.after;
    } else if (env.GITHUB_EVENT_NAME === "merge_group") {
      base = event.merge_group?.base_sha; expectedHead = event.merge_group?.head_sha;
    } else if (env.GITHUB_EVENT_NAME === "workflow_dispatch") {
      // ci.yml's runner rehearsal of Main (record #8478) has no event base:
      // the dispatched commit is its own base, so its floors hold against
      // themselves and every other check still reads the exact commit.
      base = env.GITHUB_SHA; expectedHead = env.GITHUB_SHA;
    } else {
      throw new Error("TYPE_COVERAGE_FAIL: unsupported CI event for baseline history");
    }
    if (!SHA.test(base ?? "") || !SHA.test(expectedHead ?? "")
      || (env.CI_BASE_SHA && env.CI_BASE_SHA !== base)
      || (env.CI_HEAD_SHA && env.CI_HEAD_SHA !== expectedHead)
      || (env.GITHUB_EVENT_NAME !== "pull_request" && env.GITHUB_SHA !== expectedHead)) {
      throw new Error("TYPE_COVERAGE_FAIL: CI event coordinates disagree");
    }
    if (head !== expectedHead) throw new Error("TYPE_COVERAGE_FAIL: checkout differs from CI event head");
    sources = [env.GITHUB_EVENT_NAME === "pull_request" ? forkPoint(base, head) : base];
  } else {
    sources = [head];
    // Protect against a locally committed baseline edit too. The exact selected
    // merge base is frozen before any blob read; absence of origin/Main is valid
    // for a new local repository, but a missing referenced object is not.
    const main = git("for-each-ref", "--format=%(objectname)", "refs/remotes/origin/Main");
    if (main) sources.push(git("merge-base", main, head));
  }
  const result = [];
  for (const sha of new Set(sources)) {
    const entry = git("ls-tree", sha, "--", repositoryPath);
    if (!entry) continue; // Successful exact tree read proves first-delivery bootstrap.
    if (!/^100644 blob [0-9a-f]{40}$/.test(entry.split("\t")[0]) || entry.split("\t")[1] !== repositoryPath) {
      throw new Error("TYPE_COVERAGE_FAIL: historical baseline is not a regular Git blob");
    }
    let value;
    try { value = JSON.parse(git("cat-file", "blob", `${sha}:${repositoryPath}`)); }
    catch { throw new Error("TYPE_COVERAGE_FAIL: historical baseline is unreadable"); }
    if (!validate(value)) throw new Error("TYPE_COVERAGE_FAIL: invalid historical baseline");
    value = transform(value, sha, git);
    if (!validate(value)) throw new Error("TYPE_COVERAGE_FAIL: invalid historical baseline");
    result.push(value);
  }
  return result;
}

/** Floors survive even a removed source path, so reintroduction cannot reset it. */
export function baselineHistoryFailures(candidate, historical) {
  const failures = [];
  if (!validBaseline(candidate)) return ["candidate baseline is invalid"];
  for (const old of historical) {
    for (const key of ["minimum_coverage_percent", "new_file_minimum_percent"]) {
      if (candidate[key] < old[key]) failures.push(`${key} lowered below historical ${old[key]}%`);
    }
    for (const kind of KINDS) {
      if (candidate.maximum_suppressions[kind] > old.maximum_suppressions[kind]) {
        failures.push(`${kind} ceiling exceeds historical ${old.maximum_suppressions[kind]}`);
      }
    }
    for (const [path, floor] of Object.entries(old.files)) {
      if (!Object.hasOwn(candidate.files, path)) failures.push(`${path} is missing its historical ${floor}% floor`);
      else if (candidate.files[path] < floor) failures.push(`${path} baseline lowered below historical ${floor}% floor`);
    }
    for (const [path, floor] of Object.entries(candidate.files)) {
      if (!Object.hasOwn(old.files, path) && floor < old.new_file_minimum_percent) {
        failures.push(`${path} newly recorded floor is below historical new-file minimum ${old.new_file_minimum_percent}%`);
      }
    }
  }
  return [...new Set(failures)];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const candidate = loadCoveragePins(resolve(repositoryRoot, BASELINE));
    const historical = readBaselineHistory({ repositoryRoot });
    const failures = baselineHistoryFailures(candidate, historical);
    if (failures.length) throw new Error(`TYPE_COVERAGE_FAIL: ${failures.join("; ")}`);
    console.log(`Historical type-coverage floors hold against ${historical.length} exact baseline(s).`);
  } catch (error) {
    console.error(error.message.startsWith("TYPE_COVERAGE_FAIL:") ? error.message : "TYPE_COVERAGE_FAIL: baseline history verification failed");
    process.exitCode = 1;
  }
}
