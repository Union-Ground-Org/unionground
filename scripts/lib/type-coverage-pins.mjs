import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pinHash, pinName, readPins } from "./source-pins.mjs";

export const COVERAGE_PINS = "type-coverage-ratchets";
const KINDS = ["tsNoCheck", "tsIgnore", "tsExpectError", "explicitAny", "asAny", "doubleAssertion"];
const percent = n => Number.isFinite(n) && n >= 0 && n <= 100;

// Immutable, content-addressed deltas form a monotone join: max floors, min
// ceilings. Two independent raises commute without rewriting a shared file.
export function composeCoveragePins(baseline, rows, admissions = {}) {
  const result = structuredClone(baseline);
  for (const [key, row] of Object.entries(rows)) {
    if (!row || `sha256:${pinHash(JSON.stringify(row))}` !== key
      || Object.keys(row).sort().join(",") !== "files,maximum_suppressions,minimum_coverage_percent,schema"
      || row.schema !== 1 || !percent(row.minimum_coverage_percent)
      || !row.files || Array.isArray(row.files) || typeof row.files !== "object"
      || !Object.values(row.files).every(percent)
      || !row.maximum_suppressions || Object.keys(row.maximum_suppressions).sort().join(",") !== [...KINDS].sort().join(",")
      || !KINDS.every(kind => Number.isInteger(row.maximum_suppressions[kind]) && row.maximum_suppressions[kind] >= 0)) {
      throw new Error("TYPE_COVERAGE_FAIL: invalid coverage ratchet identity or value");
    }
    result.minimum_coverage_percent = Math.max(result.minimum_coverage_percent, row.minimum_coverage_percent);
    for (const kind of KINDS) result.maximum_suppressions[kind] = Math.min(result.maximum_suppressions[kind], row.maximum_suppressions[kind]);
    for (const [path, floor] of Object.entries(row.files)) {
      const admission = admissions[key] ?? baseline;
      if (!Object.hasOwn(admission.files, path) && floor < admission.new_file_minimum_percent) {
        throw new Error(`TYPE_COVERAGE_FAIL: ${path} below the new-file floor`);
      }
      Object.defineProperty(result.files, path, { value: Math.max(result.files[path] ?? 0, floor), enumerable: true, writable: true, configurable: true });
    }
  }
  return result;
}

// A receipt's hash authenticates its bytes, not its claimed admission policy.
// Resolve that policy from the commit which introduced it and that commit's
// first parent. Never trust a threshold supplied inside a candidate receipt.
function committedCoverageReader(repositoryPath, git) {
  const directory = `${dirname(repositoryPath)}/${COVERAGE_PINS}`;
  const cache = new Map();
  const pending = new Set();
  const blob = (sha, path) => {
    const entry = git("ls-tree", sha, "--", path);
    if (!entry) return null;
    if (!/^100644 blob [a-f0-9]{40}$/.test(entry.split("\t")[0]) || entry.split("\t")[1] !== path) {
      throw new Error("TYPE_COVERAGE_FAIL: historical coverage input is not a regular pin blob");
    }
    return JSON.parse(git("cat-file", "blob", `${sha}:${path}`));
  };
  const read = sha => {
    if (cache.has(sha)) return cache.get(sha);
    if (pending.has(sha) || cache.size + pending.size >= 512) {
      throw new Error("TYPE_COVERAGE_FAIL: coverage admission history exceeds its bound");
    }
    pending.add(sha);
    const baseline = blob(sha, repositoryPath);
    if (!baseline) {
      const absent = { baseline: null, rows: {}, admissions: {} };
      cache.set(sha, absent); pending.delete(sha);
      return absent;
    }
    if (baseline.schema !== 1 || !percent(baseline.minimum_coverage_percent)
      || !percent(baseline.new_file_minimum_percent) || !baseline.files || typeof baseline.files !== "object" || Array.isArray(baseline.files)
      || !Object.values(baseline.files).every(percent)
      || !KINDS.every(kind => Number.isInteger(baseline.maximum_suppressions?.[kind]) && baseline.maximum_suppressions[kind] >= 0)) {
      throw new Error("TYPE_COVERAGE_FAIL: invalid historical coverage baseline");
    }
    const rows = {};
    const admissions = {};
    const entries = git("ls-tree", "-r", sha, "--", directory);
    for (const entry of entries ? entries.split("\n") : []) {
      const path = entry.split("\t")[1];
      if (!path?.startsWith(`${directory}/`) || !/^[a-f0-9]{64}\.json$/.test(path.slice(directory.length + 1))) {
        throw new Error("TYPE_COVERAGE_FAIL: invalid historical coverage pin path");
      }
      const row = blob(sha, path);
      if (!row || typeof row.key !== "string" || path !== `${directory}/${pinName(row.key)}`
        || Object.keys(row).sort().join(",") !== "key,value" || Object.hasOwn(rows, row.key)) {
        throw new Error("TYPE_COVERAGE_FAIL: invalid historical ratchet identity");
      }
      rows[row.key] = row.value;
    }
    try {
      // No ancestry is needed when every receipt clears even today's policy.
      const result = { baseline: composeCoveragePins(baseline, rows), rows,
        admissions: Object.fromEntries(Object.keys(rows).map(key => [key, baseline])) };
      cache.set(sha, result); pending.delete(sha);
      return result;
    } catch (error) {
      if (!error.message.includes("below the new-file floor")) throw error;
    }
    for (const [key, value] of Object.entries(rows)) {
      const row = { key, value };
      const path = `${directory}/${pinName(key)}`;
      const additions = git("log", "--diff-filter=A", "--format=%H", sha, "--", path).split("\n");
      if (additions.length > 512 || !additions.every(commit => /^[a-f0-9]{40}$/.test(commit))) {
        throw new Error("TYPE_COVERAGE_FAIL: coverage admission commit is unavailable");
      }
      // Restoring identical receipt bytes must not erase their original
      // admission. A reused path alone, however, proves nothing about its value.
      const introduced = additions.reverse().find(commit => {
        const previous = blob(commit, path);
        return previous?.key === key && Object.keys(previous).sort().join(",") === "key,value"
          && JSON.stringify(previous.value) === JSON.stringify(value);
      });
      if (!introduced) throw new Error("TYPE_COVERAGE_FAIL: coverage admission receipt is unavailable");
      // Commit bytes preserve the parent even in a shallow clone. Missing
      // ancestry must fail closed, rather than masquerading as a root commit.
      const parent = git("cat-file", "-p", introduced).split("\n\n")[0].split("\n")
        .find(line => line.startsWith("parent "))?.slice(7);
      const previous = parent ? read(parent).baseline : null;
      if (parent && !previous) {
        throw new Error("TYPE_COVERAGE_FAIL: coverage admission policy is unavailable");
      }
      const policy = blob(introduced, repositoryPath);
      if (!policy || !percent(policy.new_file_minimum_percent)) {
        throw new Error("TYPE_COVERAGE_FAIL: coverage admission policy is unavailable");
      }
      admissions[row.key] = previous ? {
        files: previous.files,
        new_file_minimum_percent: Math.max(previous.new_file_minimum_percent, policy.new_file_minimum_percent),
      } : policy;
    }
    const result = { baseline: composeCoveragePins(baseline, rows, admissions), rows, admissions };
    cache.set(sha, result); pending.delete(sha);
    return result;
  };
  return read;
}

export function readCommittedCoveragePins(repositoryPath, sha, git) {
  return committedCoverageReader(repositoryPath, git)(sha).baseline;
}

export function loadCoveragePins(baselinePath) {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const directory = join(baselinePath, "..", COVERAGE_PINS);
  let present = true;
  try { lstatSync(directory); }
  catch (error) { if (error.code !== "ENOENT") throw error; present = false; }
  const rows = present ? readPins(directory) : {};
  try { return composeCoveragePins(baseline, rows); }
  catch (error) { if (!error.message.includes("below the new-file floor")) throw error; }
  let gitDirectory = dirname(baselinePath);
  const git = (...args) => execFileSync("git", args, { cwd: gitDirectory, encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
  let root;
  try { root = git("rev-parse", "--show-toplevel"); }
  catch { return composeCoveragePins(baseline, rows); } // Standalone fixture: no authenticated admissions.
  gitDirectory = root;
  const repositoryPath = relative(root, baselinePath).split("\\").join("/");
  const head = committedCoverageReader(repositoryPath, git)(git("rev-parse", "--verify", "HEAD^{commit}"));
  if (!head.baseline) return composeCoveragePins(baseline, rows);
  const currentAdmission = { files: head.baseline.files,
    new_file_minimum_percent: Math.max(baseline.new_file_minimum_percent, head.baseline.new_file_minimum_percent) };
  const admissions = Object.fromEntries(Object.keys(rows).map(key => [key,
    Object.hasOwn(head.rows, key) ? head.admissions[key] : currentAdmission]));
  return composeCoveragePins(baseline, rows, admissions);
}
export function appendCoveragePin(baselinePath, previous, next) {
  const files = Object.fromEntries(Object.entries(next.files).filter(([path, floor]) =>
    !Object.hasOwn(previous.files, path) || previous.files[path] !== floor).sort(([a], [b]) => a.localeCompare(b)));
  const row = { schema: 1, minimum_coverage_percent: next.minimum_coverage_percent,
    maximum_suppressions: next.maximum_suppressions, files };
  if (!Object.keys(files).length && next.minimum_coverage_percent === previous.minimum_coverage_percent
    && KINDS.every(kind => next.maximum_suppressions[kind] === previous.maximum_suppressions[kind])) return;
  const key = `sha256:${pinHash(JSON.stringify(row))}`;
  const directory = join(baselinePath, "..", COVERAGE_PINS);
  mkdirSync(directory, { recursive: true });
  // Validate preexisting entries before writing; never overwrite a receipt.
  readPins(directory);
  const path = join(directory, pinName(key));
  const text = `${JSON.stringify({ key, value: row }, null, 2)}\n`;
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== text) throw new Error("TYPE_COVERAGE_FAIL: ratchet receipt collision");
  } else writeFileSync(path, text, { flag: "wx" });
}
