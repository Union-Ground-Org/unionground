#!/usr/bin/env node
// Dependency audit for the `dependency-audit` CI lane and the daily report.
//
//   node scripts/ci-dependency-audit.mjs --base <sha>     pull request: fail on introduced advisories
//   node scripts/ci-dependency-audit.mjs [--report FILE]  report only (Main push, daily audit)
//
// Both installable trees (the web root and apps/mobile) are audited at the
// high level over their whole graph. A pull request fails only for a high or
// critical advisory that its own manifest or lockfile change introduces,
// compared with the same tree at the pull request's base commit. An advisory
// already on main is printed as a warning and reported by the daily audit
// (.github/workflows/dependency-audit-daily.yml), so an advisory published
// against main no longer blocks every unrelated merge, as it did from
// October 23 to November 9, 2026, and is still never hidden. This mirrors the
// sibling repository's f November 9, 2026.
//
// npm audit reads only the two manifests, copied into an empty directory: it
// installs nothing, runs no lifecycle script, and no .npmrc from the checkout
// can point it at another registry. An audit npm could not complete fails
// closed in every mode.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const AUDITED_TREES = [".", "apps/mobile"];
export const BLOCKING_SEVERITIES = new Set(["high", "critical"]);
const REGISTRY = "https://registry.npmjs.org/";
const MANIFESTS = ["package.json", "package-lock.json"];
const GHSA = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/u;

// The high and critical advisories behind an `npm audit --json` report. npm
// lists each advisory as an object in some package's `via`; string entries
// only point at other vulnerable packages.
export function blockingAdvisories(report) {
  if (!report || typeof report !== "object" || report.error || typeof report.vulnerabilities !== "object") {
    throw new Error("npm audit produced no readable report");
  }
  const found = new Map();
  for (const entry of Object.values(report.vulnerabilities)) {
    for (const via of entry?.via ?? []) {
      if (!via || typeof via !== "object" || !BLOCKING_SEVERITIES.has(via.severity)) continue;
      const id = String(via.url ?? "").match(GHSA)?.[0] ?? `npm-${via.source}`;
      const key = `${id} ${via.name}`;
      if (!found.has(key)) found.set(key, { key, id, package: String(via.name), severity: via.severity, range: String(via.range ?? ""), url: String(via.url ?? "") });
    }
  }
  return [...found.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// Advisories in `head` that `base` does not already carry.
export function introducedAdvisories(head, base) {
  const known = new Set(base.map((advisory) => advisory.key));
  return head.filter((advisory) => !known.has(advisory.key));
}

function readManifests(tree, commit, root) {
  const files = {};
  for (const name of MANIFESTS) {
    const path = tree === "." ? name : `${tree}/${name}`;
    try {
      files[name] = commit
        ? execFileSync("git", ["show", `${commit}:${path}`], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })
        : readFileSync(join(root, path), "utf8");
    } catch {
      // A tree the base does not have yet carries no advisory there.
      if (commit) return null;
      throw new Error(`${path} is missing`);
    }
  }
  return files;
}

function audit(files) {
  const directory = mkdtempSync(join(tmpdir(), "ci-dependency-audit-"));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
    const result = spawnSync("npm", ["audit", "--json", "--audit-level=high", `--registry=${REGISTRY}`, "--fetch-retries=3"], {
      cwd: directory, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
    let report;
    try { report = JSON.parse(result.stdout); } catch { report = null; }
    return blockingAdvisories(report);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const describe = (tree, advisory) =>
  `${tree === "." ? "web" : tree}: ${advisory.severity} ${advisory.id} in ${advisory.package} ${advisory.range} ${advisory.url}`.trim();

export function main(argv = process.argv.slice(2), { root = process.cwd() } = {}) {
  const base = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : "";
  const reportPath = argv.includes("--report") ? argv[argv.indexOf("--report") + 1] : "";
  if (argv.includes("--base") && !/^[0-9a-f]{40}$/u.test(base ?? "")) {
    console.error("ci-dependency-audit: --base needs an exact 40-character commit");
    return 1;
  }

  const present = [];
  const introduced = [];
  for (const tree of AUDITED_TREES) {
    const headFiles = readManifests(tree, "", root);
    const head = audit(headFiles);
    present.push(...head.map((advisory) => ({ tree, advisory })));
    if (!base) continue;
    const baseFiles = readManifests(tree, base, root);
    // Unchanged manifests cannot introduce an advisory; skip the second audit.
    const unchanged = baseFiles && MANIFESTS.every((name) => baseFiles[name] === headFiles[name]);
    if (unchanged) continue;
    const added = introducedAdvisories(head, baseFiles ? audit(baseFiles) : []);
    introduced.push(...added.map((advisory) => ({ tree, advisory })));
  }

  for (const { tree, advisory } of present) {
    console.log(`::warning title=Dependency advisory::${describe(tree, advisory)}`);
  }
  if (reportPath) {
    rmSync(reportPath, { force: true });
    if (present.length > 0) {
      const lines = present.map(({ tree, advisory }) => `- ${describe(tree, advisory)}`);
      writeFileSync(reportPath, `${present.length} high or critical advisories on main:\n\n${lines.join("\n")}\n`);
    }
  }
  if (introduced.length > 0) {
    console.error(`ci-dependency-audit: this change introduces ${introduced.length} high or critical advisories:`);
    for (const { tree, advisory } of introduced) console.error(`  - ${describe(tree, advisory)}`);
    return 1;
  }
  console.log(`ci-dependency-audit: ${present.length} high or critical advisories present; ${base ? "none introduced by this change" : "report only"}.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`ci-dependency-audit: ${error.message}`);
    process.exitCode = 1;
  }
}
