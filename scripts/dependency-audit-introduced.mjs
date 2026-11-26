#!/usr/bin/env node
// Upstream decision of November 9, 2026 (audit ids gap2-v1 and gap2-1): a pull
// request's dependency audit fails only for the production advisories its own
// lockfile change introduces. An advisory that is already on the merge base is
// printed as a warning and tracked by the daily audit of the default branch
// (dependency-audit-daily.yml); a newly published advisory
// no longer turns every open pull request red. When the merge base's lockfile
// cannot be read, the audit falls back to the October 10, 2026 rule: every
// production advisory at moderate or above blocks.
//
// Required CI runs manifestAuditCommand through the trusted base copy of
// scripts/dependency-audit-manifests.mjs in ci.yml's isolated
// dependency-audit job, which never checks out the candidate: it reads the
// candidate's and the fork point's package.json and package-lock.json as
// data. The checkout form below (introducedAuditCommand) runs in a project
// directory with CI_BASE_SHA set:
//   node scripts/dependency-audit-introduced.mjs
// apps/mobile/scripts/security-audit.mjs reuses mergeBaseFiles for the mobile
// lockfile. Node built-ins only: this runs before and without any install.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/u;
const GHSA = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/u;
export const BLOCKING_SEVERITIES = ['moderate', 'high', 'critical'];
export const AUDIT_ATTEMPTS = 3;
export const AUDIT_ARGS = ['audit', '--omit=dev', '--audit-level=moderate', '--json', '--fetch-retries=0', '--fetch-timeout=120000'];
// The two files the audit compares. npm prefers npm-shrinkwrap.json over
// package-lock.json for both audit and ci, so a present shrinkwrap would make
// an unchanged package-lock.json say nothing about the graph npm audits
// (review A6-S2 on #7942); it and every other package manager's lockfile are
// refused rather than compared.
export const MANIFEST_FILES = ['package.json', 'package-lock.json'];
export const OTHER_LOCKFILES = ['npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];

// Git with lazy fetching off: CI's clones are blob-filtered and drop their
// fetch credential before candidate code runs, so a missing base blob must
// fail at once (and fall back) rather than hang on a fetch that cannot work.
export function git(args, cwd) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' } });
  return { ok: run.status === 0, stdout: run.status === 0 ? run.stdout : '', stderr: String(run.stderr ?? '') };
}

// The merge base of `base` and HEAD, and each of `paths` (relative to `cwd`)
// as it is there: `unchanged` when the working file's blob is the merge
// base's, so the audit result cannot differ; otherwise the base text, read
// only from objects already in the clone. Any gap returns readable: false
// with the reason, and the caller keeps the pre-comparison behaviour, as it
// does when one of `absent` exists on the merge base.
export function mergeBaseFiles({ cwd = process.cwd(), base, paths, absent = [], run = git }) {
  if (!SHA.test(base ?? '')) return { readable: false, reason: 'no base commit was given (CI_BASE_SHA)' };
  const mergeBase = run(['merge-base', base, 'HEAD'], cwd);
  const mergeBaseSha = mergeBase.stdout.trim();
  if (!mergeBase.ok || !SHA.test(mergeBaseSha)) return { readable: false, reason: `the merge base of ${base.slice(0, 12)} and HEAD is not in this clone` };
  const short = mergeBaseSha.slice(0, 12);
  for (const path of absent) {
    if (SHA.test(run(['rev-parse', '--verify', '--quiet', `${mergeBaseSha}:./${path}`], cwd).stdout.trim())) {
      return { readable: false, reason: `${path} exists on the merge base ${short}` };
    }
  }
  const files = {};
  for (const path of paths) {
    const baseOid = run(['rev-parse', '--verify', '--quiet', `${mergeBaseSha}:./${path}`], cwd).stdout.trim();
    if (!SHA.test(baseOid)) return { readable: false, reason: `${path} does not exist on the merge base ${short}` };
    const headOid = run(['hash-object', '--', path], cwd).stdout.trim();
    if (headOid === baseOid) {
      files[path] = { unchanged: true, text: readFileSync(join(cwd, path), 'utf8') };
      continue;
    }
    const blob = run(['cat-file', 'blob', baseOid], cwd);
    if (!blob.ok) return { readable: false, reason: `${path} on the merge base ${short} (blob ${baseOid.slice(0, 12)}) is not in this blob-filtered clone` };
    files[path] = { unchanged: false, text: blob.stdout };
  }
  return { readable: true, mergeBase: mergeBaseSha, files };
}

// Writes the merge base's package.json and lockfile to a scratch directory so
// npm audit can read that graph without installing anything.
export function writeBaseProject(files, { parent = tmpdir() } = {}) {
  const dir = mkdtempSync(join(parent, 'dependency-audit-base-'));
  for (const [path, { text }] of Object.entries(files)) writeFileSync(join(dir, path), text);
  return dir;
}

// The production advisories at moderate or above behind an npm audit report,
// one per advisory and package. A report that counts such vulnerabilities but
// names no advisory behind them cannot be compared, so it yields an
// `unparsed-report` entry, which is never treated as pre-existing.
export function productionAdvisories(report) {
  const found = new Map();
  for (const entry of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of entry?.via ?? []) {
      if (!via || typeof via !== 'object' || !BLOCKING_SEVERITIES.includes(String(via.severity))) continue;
      const id = String(via.url ?? '').match(GHSA)?.[0] ?? `npm-${via.source}`;
      const key = `${id} ${via.name}`;
      if (!found.has(key)) found.set(key, { key, id, package: String(via.name), severity: String(via.severity), title: String(via.title ?? ''), url: String(via.url ?? '') });
    }
  }
  const counted = BLOCKING_SEVERITIES.reduce((sum, level) => sum + Number(report?.metadata?.vulnerabilities?.[level] ?? 0), 0);
  if (counted > 0 && found.size === 0) found.set('unparsed-report', { key: 'unparsed-report', id: 'unparsed-report', package: '*', severity: '', title: 'npm counted advisories but named none', url: '' });
  return [...found.values()];
}

// Splits the head's advisories into those this change introduces and those
// already on the merge base, and lists what the change fixes.
export function compareAdvisories(head, base) {
  const baseKeys = new Set(base.map((advisory) => advisory.key));
  const headKeys = new Set(head.map((advisory) => advisory.key));
  return {
    introduced: head.filter((advisory) => advisory.key === 'unparsed-report' || !baseKeys.has(advisory.key)),
    preexisting: head.filter((advisory) => advisory.key !== 'unparsed-report' && baseKeys.has(advisory.key)),
    fixed: base.filter((advisory) => !headKeys.has(advisory.key)),
  };
}

const validReport = (report) => report?.auditReportVersion === 2 && report.vulnerabilities && typeof report.vulnerabilities === 'object'
  && !Array.isArray(report.vulnerabilities) && report.metadata?.vulnerabilities && typeof report.metadata.vulnerabilities === 'object';

// npm audit exits 1 both for advisories at the level and when the registry's
// audit endpoint fails (SYS-UG-CI-NPM-AUDIT-STEP-TOLERATES-REGISTRY-
// ENDPOINT-FAILURES-20261021). Only a reply that is not an audit report is
// retried, three attempts with backoff; one that fails every attempt is
// unproven and returns { report: null }.
export function auditWithRetry({ cwd, label, log = console.log, spawn = spawnSync, args = AUDIT_ARGS, pauseSeconds = Number(process.env.NPM_AUDIT_RETRY_SECONDS ?? 20) }) {
  let reason = '';
  for (let attempt = 1; attempt <= AUDIT_ATTEMPTS; attempt += 1) {
    const run = spawn('npm', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let report = null;
    try { report = JSON.parse(run.stdout); } catch { report = null; }
    if (validReport(report)) {
      const counted = BLOCKING_SEVERITIES.reduce((sum, level) => sum + Number(report.metadata.vulnerabilities[level] ?? 0), 0);
      if (run.status === 0 || counted > 0) return { report, attempts: attempt };
    }
    reason = String(report?.message ?? report?.error?.summary ?? '').split('\n')[0] || 'no audit report';
    if (attempt === AUDIT_ATTEMPTS) break;
    log(`::warning::The npm audit endpoint failed on attempt ${attempt} of ${AUDIT_ATTEMPTS} for the ${label} (${reason}); retrying`);
    if (pauseSeconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseSeconds * attempt * 1000);
  }
  return { report: null, reason };
}

const describe = (advisory) => `${advisory.package} ${advisory.severity}: ${advisory.title || advisory.id} (${advisory.id})`;

// The decision shared by both forms, after the head audit: `advisories` are
// the head's, and `baseAudit()` returns the merge base's advisories and short
// commit, or the reason no comparison is possible, which keeps the October
// 10, 2026 rule (every production advisory at moderate or above blocks).
function decide({ advisories, baseAudit, log }) {
  if (advisories.length === 0) return 0;
  const base = baseAudit();
  if (base.reason) {
    log(`::warning::No merge-base comparison (${base.reason}); every production advisory at moderate or above blocks, as before`);
    for (const advisory of advisories) log(`::error::${describe(advisory)}`);
    log('::error::npm audit found production advisories at moderate or above');
    return 1;
  }
  const { introduced, preexisting, fixed } = compareAdvisories(advisories, base.advisories);
  for (const advisory of preexisting) log(`::warning::${describe(advisory)} is already on the merge base ${base.short}; not blocking, tracked by the daily Main audit`);
  for (const advisory of fixed) log(`This change fixes ${describe(advisory)}`);
  for (const advisory of introduced) log(`::error::${describe(advisory)}, introduced by this change`);
  if (introduced.length > 0) {
    log(`::error::This change introduces ${introduced.length} production advisor${introduced.length === 1 ? 'y' : 'ies'} at moderate or above`);
    return 1;
  }
  log(`No production advisory introduced by this change; ${preexisting.length} already on the merge base ${base.short}`);
  return 0;
}

function headAudit({ audit, log, ...options }) {
  const head = audit({ ...options, label: 'pull request head', log });
  if (!head.report) {
    log(`::error::The npm audit endpoint failed on all ${AUDIT_ATTEMPTS} attempts (${head.reason}); no advisory result was read, so the audit is unproven`);
    return null;
  }
  log('npm audit report: ' + Object.entries(head.report.metadata.vulnerabilities).map(([level, count]) => `${level} ${count}`).join(', '));
  return productionAdvisories(head.report);
}

// The checkout form: the project directory is a clone of the candidate with
// CI_BASE_SHA's history. A shrinkwrap or other lockfile in it is refused; one
// on the merge base, or no readable merge base, keeps the old rule.
export function introducedAuditCommand({ cwd = process.cwd(), base = process.env.CI_BASE_SHA, log = console.log, audit = auditWithRetry, files = mergeBaseFiles, scratch = tmpdir() } = {}) {
  const extra = OTHER_LOCKFILES.filter((name) => existsSync(join(cwd, name)));
  if (extra.length > 0 || !existsSync(join(cwd, 'package-lock.json'))) {
    log(`::error::The production audit reads package-lock.json only; ${extra.length > 0 ? `remove ${extra.join(', ')}` : 'package-lock.json is missing'}`);
    return 1;
  }
  const advisories = headAudit({ cwd, audit, log });
  if (!advisories) return 1;
  return decide({ advisories, log, baseAudit: () => {
    // The base package.json matters only for auditing a changed base lockfile.
    let baseFiles = files({ cwd, base, paths: ['package-lock.json'], absent: OTHER_LOCKFILES });
    if (baseFiles.readable && !baseFiles.files['package-lock.json'].unchanged) baseFiles = files({ cwd, base, paths: MANIFEST_FILES, absent: OTHER_LOCKFILES });
    if (!baseFiles.readable) return { reason: baseFiles.reason };
    const short = baseFiles.mergeBase.slice(0, 12);
    if (baseFiles.files['package-lock.json'].unchanged) return { advisories, short };
    const dir = writeBaseProject(baseFiles.files, { parent: scratch });
    try {
      const baseReport = audit({ cwd: dir, label: `merge base ${short}`, log });
      if (!baseReport.report) return { reason: `the merge base ${short} audit failed: ${baseReport.reason}` };
      return { advisories: productionAdvisories(baseReport.report), short };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } });
}

const holdsExactlyTheManifests = (dir) => {
  try {
    return readdirSync(dir).sort().join('\n') === [...MANIFEST_FILES].sort().join('\n');
  } catch {
    return false;
  }
};

// What keeps npm from building the whole production graph out of the two
// root manifests alone (review W1-S2 on #7954): a workspace declaration, a
// linked package, or a lockfile entry outside node_modules all make npm read
// another package.json from disk. Absent there, npm drops that package's
// edges, recalculates dependency flags and can mark its production
// dependencies dev, so `--omit=dev` would leave them out of the audit. Such a
// layout is refused, never audited partially. A file: tarball dependency is
// fine: its lockfile entry records its dependencies. Returns the problems
// found; ci.yml's manifest step applies the same rule with jq.
export function unsupportedLayout(packageText, lockText) {
  let manifest, lock;
  try {
    manifest = JSON.parse(packageText);
    lock = JSON.parse(lockText);
  } catch {
    return ['package.json or package-lock.json is not JSON'];
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['package.json is not an object'];
  const problems = [];
  if (Object.hasOwn(manifest, 'workspaces')) problems.push('package.json declares workspaces');
  if (![2, 3].includes(lock?.lockfileVersion) || !lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages) || !lock.packages['']) {
    return [...problems, 'package-lock.json is not a lockfileVersion 2 or 3 lockfile with a root package entry'];
  }
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '') continue;
    if (!key.startsWith('node_modules/')) problems.push(`package-lock.json has the local package ${key}`);
    else if (entry?.link === true) problems.push(`package-lock.json links ${key}`);
  }
  return problems;
}

// The isolated form required CI runs (ci.yml job dependency-audit): `headDir`
// and `baseDir` each hold only the candidate's or the fork point's
// package.json and package-lock.json, written there as data; no candidate
// file is ever executed or checked out. The shortcut that reuses the head's
// advisories for the base applies only when both files are byte-identical,
// so no other effective lockfile can be blessed as unchanged. A head
// directory holding anything else, or an unsupportedLayout, is refused; a
// missing or different base directory, or one with such a layout, keeps the
// old rule.
export function manifestAuditCommand({ headDir, baseDir, mergeBase = '', registry, log = console.log, audit = auditWithRetry } = {}) {
  if (!holdsExactlyTheManifests(headDir ?? '')) {
    log(`::error::The audit directory must hold exactly ${MANIFEST_FILES.join(' and ')}; refusing to audit ${headDir}`);
    return 1;
  }
  if (registry !== undefined && !/^https?:\/\/\S+\/$/u.test(registry)) {
    log(`::error::The audit registry must be a URL ending in a slash: ${registry}`);
    return 1;
  }
  const layout = (dir) => unsupportedLayout(readFileSync(join(dir, 'package.json'), 'utf8'), readFileSync(join(dir, 'package-lock.json'), 'utf8'));
  const headLayout = layout(headDir);
  if (headLayout.length > 0) {
    log(`::error::The production audit cannot see the whole dependency graph from the root package.json and package-lock.json: ${headLayout.join('; ')}`);
    return 1;
  }
  const args = [...AUDIT_ARGS, '--ignore-scripts', ...(registry ? [`--registry=${registry}`] : [])];
  const advisories = headAudit({ cwd: headDir, args, audit, log });
  if (!advisories) return 1;
  return decide({ advisories, log, baseAudit: () => {
    const short = SHA.test(mergeBase) ? mergeBase.slice(0, 12) : 'fork point';
    if (!holdsExactlyTheManifests(baseDir ?? '')) return { reason: `the fork point's ${MANIFEST_FILES.join(' and ')} were not provided` };
    const baseLayout = layout(baseDir);
    if (baseLayout.length > 0) return { reason: `the fork point's layout is not supported: ${baseLayout.join('; ')}` };
    const same = MANIFEST_FILES.every((name) => readFileSync(join(headDir, name)).equals(readFileSync(join(baseDir, name))));
    if (same) return { advisories, short };
    const baseReport = audit({ cwd: baseDir, args, label: `merge base ${short}`, log });
    if (!baseReport.report) return { reason: `the merge base ${short} audit failed: ${baseReport.reason}` };
    return { advisories: productionAdvisories(baseReport.report), short };
  } });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = introducedAuditCommand({ scratch: process.env.RUNNER_TEMP || tmpdir() });
}
