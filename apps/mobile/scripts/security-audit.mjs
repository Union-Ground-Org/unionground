#!/usr/bin/env node
// Runs npm audit on the full and production dependency graphs and fails on any
// production advisory that security-audit-exceptions.json does not tolerate. An
// exception names one advisory in one package and expires; nothing else is ever
// excused. Owner decision, October 10, 2026: dev-only advisories are printed
// here and reported weekly (dependency-audit-report.yml) but do not fail a
// check; SECURITY_AUDIT_BLOCK_FULL=1 makes the full graph blocking again.
// An advisory listed under
// build_tool_advisories is a build-tool advisory, not an exception. It never
// blocks and never expires, but only while it reads exactly as listed and the
// lockfile positively proves every route to the package, from the root's
// production and dev dependencies alike, passes through a registry install of
// a named build tool; otherwise it fails or reports like any other.
// In required CI (CI_BASE_SHA set) a
// blocking finding fails only when the merge base does not have it too; one
// already on the merge base is a warning tracked by the daily Main audit
// (dependency-audit-daily.yml). Without a readable merge base, every blocking
// finding fails as before.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { mergeBaseFiles, writeBaseProject } from '../../../scripts/dependency-audit-introduced.mjs';

const GHSA = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/u;

// The advisories behind a report: npm lists each one as an object in some
// package's `via`; the string entries only point at other vulnerable packages.
export function reportAdvisories(report) {
  const found = new Map();
  for (const entry of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of entry?.via ?? []) {
      if (!via || typeof via !== 'object') continue;
      const id = String(via.url ?? '').match(GHSA)?.[0] ?? `npm-${via.source}`;
      const key = `${id} ${via.name}`;
      if (!found.has(key)) found.set(key, { id, package: String(via.name), severity: String(via.severity ?? ''), range: String(via.range ?? ''), url: String(via.url ?? '') });
    }
  }
  return [...found.values()];
}

// Resolves a dependency the way Node does from a lockfile package key: every
// ancestor directory's node_modules, nearest first (Node skips directories
// that are themselves named node_modules).
function resolveLockPackage(packages, from, name) {
  const parts = from ? from.split('/') : [];
  for (let end = parts.length; end >= 0; end -= 1) {
    if (end > 0 && parts[end - 1] === 'node_modules') continue;
    const key = [...parts.slice(0, end), 'node_modules', name].join('/');
    if (packages[key]) return key;
  }
  return null;
}

// True when the lockfile entry at `key` is one of the `blocked` build tools as
// the npm registry installed it: under its own name in a node_modules folder,
// not a link, not an alias (no differing lockfile name), and resolved from the
// registry tarball for exactly that name and version. A file:, link:, git or
// aliased entry that merely carries the name is not the build tool, so its
// dependencies stay in the production graph.
function registryBuildTool(entry, installedAs, blocked) {
  if (!blocked.includes(installedAs) || entry.link || (entry.name !== undefined && entry.name !== installedAs)) return false;
  const base = installedAs.slice(installedAs.lastIndexOf('/') + 1);
  return typeof entry.version === 'string' && entry.resolved === `https://registry.npmjs.org/${installedAs}/-/${base}-${entry.version}.tgz`;
}

// True when `target` is installed for production (the root's dependencies,
// optionalDependencies and peerDependencies, followed transitively) without
// passing through any package named in `blocked`; `includeDev` also follows
// the root's devDependencies, the full install. A package is identified by
// its lockfile name when it has one (npm aliases, link targets), so
// `alias: npm:target@x` still counts as the target. A blocked build tool is cut
// only as its registry install (see registryBuildTool); anything else that
// merely carries its name is followed.
export function reachableInProduction(lock, target, blocked = [], { includeDev = false } = {}) {
  const packages = lock?.packages;
  if (!packages || typeof packages !== 'object' || !packages['']) throw new Error('package-lock.json has no packages map');
  const seen = new Set();
  const queue = [];
  const follow = (from) => {
    const entry = packages[from];
    const fields = [['dependencies', true], ['optionalDependencies', false], ['peerDependencies', false]];
    // Only the root's devDependencies are installed; a dependency's are not.
    if (includeDev && from === '') fields.push(['devDependencies', true]);
    for (const [field, required] of fields) {
      for (const dependency of Object.keys(entry?.[field] || {})) {
        const key = resolveLockPackage(packages, from, dependency);
        // An installed dependency that cannot be located cannot be proven absent.
        if (!key && required) throw new Error(`lockfile ${from || 'root'} dependency ${dependency} does not resolve`);
        if (key) queue.push(key);
      }
    }
  };
  // npm links workspaces without listing them in the root's dependency fields,
  // so a workspace lockfile cannot be proven here; it fails closed.
  if (packages[''].workspaces !== undefined) throw new Error('lockfile declares workspaces; build-tool reachability cannot be proven');
  follow('');
  while (queue.length) {
    const key = queue.shift();
    if (seen.has(key)) continue;
    seen.add(key);
    // A link entry carries no metadata; its dependencies live at the target
    // entry and resolve from the target's path. A dangling link fails closed.
    const home = packages[key].link ? packages[key].resolved : key;
    if (typeof home !== 'string' || !packages[home]) throw new Error(`lockfile link ${key} has no target entry`);
    const installedAs = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const identity = packages[home].name ?? installedAs;
    if (identity === target || installedAs === target) return true;
    if (registryBuildTool(packages[key], installedAs, blocked)) continue;
    follow(home);
  }
  return false;
}

// Positive proof that `target` is a build-tool package:
// the full install (production and dev) reaches it, and cutting the registry
// installs of `buildTools` leaves no route, so every route passes through one.
// A package reached by any other route, dev or production, or by none at all,
// is not proven.
export function buildToolPathProven(lock, target, buildTools) {
  return reachableInProduction(lock, target, [], { includeDev: true })
    && !reachableInProduction(lock, target, buildTools, { includeDev: true });
}

export function evaluateAudit(report, exceptions, today, { buildTool = [], lock = null } = {}) {
  const all = reportAdvisories(report);
  const buildToolEntry = (advisory) => buildTool.find((entry) => entry.id === advisory.id && entry.package === advisory.package
    && entry.severity === advisory.severity && entry.range === advisory.range
    && lock !== null && buildToolPathProven(lock, entry.package, entry.reached_only_through));
  const buildToolAdvisories = all.filter(buildToolEntry);
  const advisories = all.filter((advisory) => !buildToolEntry(advisory));
  const live = exceptions.filter((entry) => entry.expires >= today);
  // The advisory must still read exactly as approved: a raised severity or a
  // widened affected range is a new risk and fails like any other advisory.
  const tolerated = (advisory) => live.some((entry) => entry.id === advisory.id && entry.package === advisory.package
    && entry.severity === advisory.severity && entry.range === advisory.range);
  const total = Number(report?.metadata?.vulnerabilities?.total ?? 0);
  const failures = advisories.filter((advisory) => !tolerated(advisory));
  // A vulnerable package with no advisory behind it cannot be vetted, so it fails.
  if (total > 0 && all.length === 0) failures.push({ id: 'unparsed-report', package: '*', severity: '', range: '', url: '' });
  return {
    failures,
    tolerated: advisories.filter(tolerated),
    expired: exceptions.filter((entry) => entry.expires < today),
    unused: live.filter((entry) => !advisories.some((advisory) => advisory.id === entry.id && advisory.package === entry.package)),
    buildTool: buildToolAdvisories,
    unusedBuildTool: buildTool.filter((entry) => !buildToolAdvisories.some((advisory) => advisory.id === entry.id && advisory.package === entry.package)),
  };
}

// npm audit exits 0 (clean) or 1 (advisories found) with a report; it can also
// print JSON for a registry or network error. Only a real report may be
// evaluated: an error response read as "no advisories" would let the full
// audit mislabel a production advisory as dev-only.
export function validatedAuditReport(report, status, label = 'audit') {
  if (status !== 0 && status !== 1) throw new Error(`npm audit (${label}) failed with exit ${status}`);
  if (!report || typeof report !== 'object' || Array.isArray(report) || 'error' in report
      || !report.vulnerabilities || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)
      || !report.metadata?.vulnerabilities || typeof report.metadata.vulnerabilities !== 'object') {
    throw new Error(`npm audit (${label}) returned no audit report`);
  }
  return report;
}

// A registry or network error reply (npm prints JSON for it) is retried a
// bounded number of times before it fails the lane: the mobile check on
//  (run 40422614256) died on one such reply from the hosted runner.
export const AUDIT_ATTEMPTS = 3;
function audit(args, cwd = process.cwd()) {
  const env = { ...process.env };
  delete env.npm_config_allow_scripts;
  const label = args.join(' ') || 'full';
  const pauseMs = Number(process.env.SECURITY_AUDIT_RETRY_MS ?? 2000);
  let failure;
  for (let attempt = 1; attempt <= AUDIT_ATTEMPTS; attempt += 1) {
    const run = spawnSync('npm', ['audit', '--json', ...args], { cwd, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    try {
      let report;
      try { report = JSON.parse(run.stdout); } catch { throw new Error(`npm audit ${label} returned no JSON report (exit ${run.status})`); }
      return validatedAuditReport(report, run.status, label);
    } catch (error) {
      failure = error;
      if (attempt === AUDIT_ATTEMPTS) break;
      console.error(`security audit (${label}): ${error.message}; retry ${attempt} of ${AUDIT_ATTEMPTS - 1}`);
      if (pauseMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseMs * attempt);
    }
  }
  throw failure;
}

function validExceptions(document) {
  const list = document?.schema === 1 && Array.isArray(document.exceptions) ? document.exceptions : null;
  if (!list) throw new Error('security-audit-exceptions.json must be schema 1 with an exceptions array');
  for (const entry of list) {
    if (!GHSA.test(entry?.id ?? '') || typeof entry.package !== 'string' || !entry.package
        || typeof entry.severity !== 'string' || !entry.severity || typeof entry.range !== 'string' || !entry.range
        || typeof entry.reason !== 'string' || !entry.reason || typeof entry.approved !== 'string' || !entry.approved
        || !/^\d{4}-\d{2}-\d{2}$/u.test(entry.expires ?? '')) {
      throw new Error(`invalid audit exception: ${JSON.stringify(entry)}`);
    }
  }
  return list;
}

function validBuildToolAdvisories(document) {
  const list = document.build_tool_advisories ?? [];
  if (!Array.isArray(list)) throw new Error('build_tool_advisories must be an array');
  for (const entry of list) {
    if (!GHSA.test(entry?.id ?? '') || typeof entry.package !== 'string' || !entry.package
        || typeof entry.severity !== 'string' || !entry.severity || typeof entry.range !== 'string' || !entry.range
        || !Array.isArray(entry.reached_only_through) || entry.reached_only_through.length === 0
        || entry.reached_only_through.some((name) => typeof name !== 'string' || !name || name === entry.package)
        || typeof entry.reason !== 'string' || !entry.reason || typeof entry.approved !== 'string' || !entry.approved
        || 'expires' in entry) {
      throw new Error(`invalid build-tool advisory: ${JSON.stringify(entry)}`);
    }
  }
  return list;
}

// The whole command decision, with npm, output and the job summary injected so
// tests can drive dev-only, expired and unparsed reports.
export function auditCommand({ document, lock, today, runAudit, blockFull = false, out = console.log, err = console.error, summary = null }) {
  const exceptions = validExceptions(document);
  const buildTool = validBuildToolAdvisories(document);
  let failed = false;
  let full = null;
  const key = (advisory) => `${advisory.id} ${advisory.package}`;
  let productionFailures = new Set();
  let productionBuildTool = new Set();
  // Non-blocking lines also go to the job summary, so the weekly report shows
  // which advisories it found even when the run succeeds.
  const reportLines = [];
  // Every finding printed without blocking is counted, so the final line can
  // never call a run clean while it reports dev-only or build-tool findings.
  const reported = { 'dev-only': new Set(), 'build-tool': new Set(), tolerated: new Set() };
  for (const [label, args] of [['production', ['--omit=dev']], ['full', []]]) {
    const result = evaluateAudit(runAudit(args), exceptions, today, { buildTool, lock });
    if (label === 'full') full = result;
    // Every build-tool classification is printed, including one only the full
    // (dev-inclusive) audit finds, so an ordinary pull-request run shows it.
    for (const advisory of result.buildTool) {
      if (label === 'full' && !blockFull && productionBuildTool.has(key(advisory))) continue;
      const line = `security audit (${label}): REPORT build-tool advisory, not blocking: ${advisory.id} in ${advisory.package} ${advisory.severity} ${advisory.range} ${advisory.url}`;
      out(line);
      reportLines.push(line);
      reported['build-tool'].add(key(advisory));
    }
    for (const advisory of result.tolerated) {
      out(`security audit (${label}): tolerated ${advisory.id} in ${advisory.package} until its exception expires`);
      reported.tolerated.add(key(advisory));
    }
    for (const advisory of result.failures) {
      if (label === 'full' && productionFailures.has(key(advisory))) continue;
      const blocking = label === 'production' || blockFull;
      const line = `security audit (${label}): ${blocking ? 'FAIL' : 'REPORT dev-only, not blocking:'} ${advisory.id} in ${advisory.package} ${advisory.severity} ${advisory.range} ${advisory.url}`;
      if (blocking) { err(line); failed = true; } else { out(line); reported['dev-only'].add(key(advisory)); }
      reportLines.push(line);
    }
    if (label === 'production') {
      productionFailures = new Set(result.failures.map(key));
      productionBuildTool = new Set(result.buildTool.map(key));
    }
  }
  // An expired exception blocks: renewing it is a new review, and removing it
  // lets the advisory fail or report on its own.
  for (const entry of full.expired) {
    const line = `security audit: FAIL exception ${entry.id} (${entry.package}) expired on ${entry.expires}; renew it with a new review or remove it`;
    err(line);
    reportLines.push(line);
    failed = true;
  }
  for (const entry of full.unused) out(`security audit: exception ${entry.id} (${entry.package}) is no longer needed; remove it`);
  // A stale build-tool entry fails, as an unused Trivy allowlist entry does
  // (run-security-scan.mjs), so a permanent classification cannot linger.
  for (const entry of full.unusedBuildTool) {
    err(`security audit: FAIL build-tool advisory ${entry.id} (${entry.package}) is no longer reported as a build-tool advisory; remove it`);
    failed = true;
  }
  if (summary && reportLines.length > 0) summary(['', '### Mobile audit findings', '', ...reportLines.map((line) => `- ${line}`), ''].join('\n'));
  if (failed) return 1;
  const counts = Object.entries(reported).map(([kind, keys]) => [kind, keys.size]).filter(([, count]) => count > 0);
  const total = counts.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) out('security audit: clean; both audits report zero findings');
  else out(`security audit: no blocking advisories; ${total} reported finding${total === 1 ? '' : 's'} not blocking (${counts.map(([kind, count]) => `${count} ${kind}`).join(', ')})`);
  return 0;
}

// Runs auditCommand on the head, and only when it blocks, again on the merge
// base (its own exceptions document and lockfile, the same day). A blocking
// line the merge base prints too is already on Main, so it is reported, not
// failed; any other blocking line fails. `loadBase` returns
// { readable: false, reason } or { readable: true, mergeBase, document, lock,
// runAudit, cleanup? }; it is called only when the head blocks.
export function introducedAuditCommand({ loadBase, out = console.log, err = console.error, ...options }) {
  const headErr = [];
  const code = auditCommand({ ...options, out, err: (line) => headErr.push(line) });
  if (code === 0) return 0;
  const fallback = (reason) => {
    out(`security audit: no merge-base comparison (${reason}); every blocking finding fails, as before`);
    for (const line of headErr) err(line);
    return code;
  };
  let base;
  try { base = loadBase ? loadBase() : { readable: false, reason: 'no base commit was given (CI_BASE_SHA)' }; } catch (error) { return fallback(`the merge base could not be read: ${error.message}`); }
  if (!base.readable) return fallback(base.reason);
  const baseErr = new Set();
  try {
    auditCommand({ document: base.document, lock: base.lock, today: options.today, runAudit: base.runAudit, blockFull: options.blockFull,
      out: () => {}, err: (line) => baseErr.add(line) });
  } catch (error) {
    return fallback(`the merge base ${base.mergeBase.slice(0, 12)} audit failed: ${error.message}`);
  } finally {
    base.cleanup?.();
  }
  const short = base.mergeBase.slice(0, 12);
  const introduced = headErr.filter((line) => !baseErr.has(line));
  for (const line of headErr.filter((line) => baseErr.has(line))) {
    out(`security audit: WARN already on the merge base ${short}, not blocking, tracked by the daily Main audit: ${line}`);
  }
  for (const line of introduced) err(line);
  if (introduced.length > 0) return 1;
  out(`security audit: no blocking finding introduced by this change; ${headErr.length} already on the merge base ${short}`);
  return 0;
}

// The merge base's exceptions document, lockfile and audit runner. An
// unchanged lockfile reuses the head's npm reports (same graph, same day);
// a changed one is audited from a scratch copy of the base's package files.
export function mergeBaseAudit({ cwd, base, headAudit, scratch, files = mergeBaseFiles }) {
  let found = files({ cwd, base, paths: ['package-lock.json', 'security-audit-exceptions.json'] });
  if (!found.readable) return found;
  const document = JSON.parse(found.files['security-audit-exceptions.json'].text);
  const lock = JSON.parse(found.files['package-lock.json'].text);
  if (found.files['package-lock.json'].unchanged) return { readable: true, mergeBase: found.mergeBase, document, lock, runAudit: headAudit };
  // The base package.json matters only for auditing a changed base lockfile.
  found = files({ cwd, base, paths: ['package.json', 'package-lock.json'] });
  if (!found.readable) return found;
  const dir = writeBaseProject(found.files, { parent: scratch });
  return { readable: true, mergeBase: found.mergeBase, document, lock, runAudit: (args) => audit(args, dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const projectDir = fileURLToPath(new URL('..', import.meta.url));
  const reports = new Map();
  const headAudit = (args) => {
    const key = args.join(' ');
    if (!reports.has(key)) reports.set(key, audit(args, projectDir));
    return reports.get(key);
  };
  const code = introducedAuditCommand({
    document: JSON.parse(readFileSync(new URL('../security-audit-exceptions.json', import.meta.url), 'utf8')),
    lock: JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')),
    today: new Date().toISOString().slice(0, 10),
    runAudit: headAudit,
    blockFull: process.env.SECURITY_AUDIT_BLOCK_FULL === '1',
    summary: process.env.GITHUB_STEP_SUMMARY ? (text) => appendFileSync(process.env.GITHUB_STEP_SUMMARY, text) : null,
    // The weekly and daily reports audit Main as it is, with no comparison.
    loadBase: process.env.SECURITY_AUDIT_NO_BASE === '1' ? null
      : () => mergeBaseAudit({ cwd: projectDir, base: process.env.CI_BASE_SHA, headAudit, scratch: process.env.RUNNER_TEMP || undefined }),
  });
  if (code !== 0) process.exit(code);
}
