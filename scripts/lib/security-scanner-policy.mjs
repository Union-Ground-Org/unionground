// Reviewed policy for the continuous security lane.
//
// The scanners themselves are untrusted reporters: they emit JSON, and this
// module decides what blocks. Keeping the decision here — rather than in a
// scanner's own baseline file or in a `--severity` flag buried in a workflow —
// is what makes "cannot silently downgrade failures" checkable, because the
// policy is one reviewed artifact with a test asserting its floors.
//
// Nothing in this module prints a secret. Gitleaks findings are matched by the
// SHA-256 of the detected value so an exception is bound to the exact benign
// literal, and the value itself is never stored, logged or compared in clear.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(HERE, "..", "..");
export const POLICY_PATH = "config/security-scanner-policy.json";

/**
 * The floors this policy may never fall below. A change that removes a
 * severity from a blocking set has to change this table too, in the same
 * reviewed commit, and `tests/security-scanner-policy.test.js` asserts both
 * sides agree.
 */
export const REQUIRED_BLOCKING = Object.freeze({
  semgrep: Object.freeze(["ERROR"]),
  trivy: Object.freeze(["CRITICAL", "HIGH"]),
});

export const SCANNER_IDS = Object.freeze(["semgrep", "gitleaks", "trivy"]);

/**
 * Lanes an exception can apply to. `tree` is the per-change scan of the
 * checked-out candidate; `history` is the scheduled bounded walk of repository
 * history. An entry with no `lanes` applies to both. An entry that names only
 * `history` covers a finding in a blob that is no longer in the tree — the
 * clean-room event left several — and is deliberately invisible to the
 * per-change lane, so it cannot widen it.
 */
export const LANES = Object.freeze(["tree", "history"]);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// This edition keeps no retained operator evidence in the repository, so no
// gitleaks finding is ever classified below the blocking floor: a digest
// that looks like a key blocks unless an exact allowlist entry covers it.

export function loadPolicy(root = REPOSITORY_ROOT) {
  return JSON.parse(readFileSync(join(root, POLICY_PATH), "utf8"));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function daysBetween(fromIso, toIso) {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return Number.NaN;
  return Math.round((to - from) / 86_400_000);
}

/**
 * Structural and floor validation for the reviewed policy.
 * @returns {string[]} problems; empty means valid
 */
export function validatePolicy(policy) {
  const problems = [];
  if (!isPlainObject(policy)) return ["policy must be a JSON object"];
  if (policy.schema !== 1) problems.push("policy schema must be 1");
  if (!DATE_PATTERN.test(policy.reviewed_on ?? "")) {
    problems.push("policy reviewed_on must be an exact YYYY-MM-DD date");
  }
  if (typeof policy.reviewed_by !== "string" || policy.reviewed_by.trim().length === 0) {
    problems.push("policy reviewed_by must name the reviewing session or person");
  }

  const scanners = policy.scanners;
  if (!isPlainObject(scanners)) {
    problems.push("policy scanners must be an object");
  } else {
    for (const id of SCANNER_IDS) {
      const scanner = scanners[id];
      if (!isPlainObject(scanner)) {
        problems.push(`scanner ${id} is missing`);
        continue;
      }
      if (typeof scanner.image !== "string" || scanner.image.length === 0) {
        problems.push(`scanner ${id} must name an image`);
      }
      if (typeof scanner.tag !== "string" || scanner.tag.length === 0) {
        problems.push(`scanner ${id} must record the human-readable tag it was pinned from`);
      }
      if (!DIGEST_PATTERN.test(scanner.digest ?? "")) {
        problems.push(`scanner ${id} must be pinned to an exact sha256 image digest`);
      }
      const required = REQUIRED_BLOCKING[id];
      if (required) {
        const blocking = Array.isArray(scanner.blocking_severities)
          ? scanner.blocking_severities
          : [];
        for (const severity of required) {
          if (!blocking.includes(severity)) {
            problems.push(`scanner ${id} must block on ${severity}`);
          }
        }
        const overlap = (scanner.recorded_severities ?? []).filter((severity) =>
          blocking.includes(severity));
        if (overlap.length > 0) {
          problems.push(`scanner ${id} lists ${overlap.join(", ")} as both blocking and recorded`);
        }
      } else if (scanner.blocking !== true) {
        problems.push(`scanner ${id} must be blocking`);
      }
    }
  }

  // Semgrep reads 0 as "no timeout", so the per-rule bound must be a real,
  // bounded number of seconds rather than absent or unlimited.
  const ruleTimeout = scanners?.semgrep?.rule_timeout_seconds;
  if (!Number.isInteger(ruleTimeout) || ruleTimeout <= 0 || ruleTimeout > 300) {
    problems.push("scanner semgrep rule_timeout_seconds must be a positive integer of at most 300");
  }

  if (!isPlainObject(policy.sbom) || policy.sbom.fail_closed !== true) {
    problems.push("the SBOM policy must exist and fail closed");
  }
  if (!isPlainObject(policy.registry_signatures) || policy.registry_signatures.blocking !== true) {
    problems.push("registry signature verification must exist and be blocking");
  }
  if (!isPlainObject(policy.zap)) {
    problems.push("the ZAP policy must be recorded");
  } else {
    if (policy.zap.blocking !== false) {
      problems.push("ZAP must stay a non-blocking, separately calibrated passive gate");
    }
    if (typeof policy.zap.historical_status !== "string"
      || !/never a blocking release gate/i.test(policy.zap.historical_status)) {
      problems.push("the ZAP policy must record its true historical optional status");
    }
    const targets = policy.zap.allowed_targets;
    if (!Array.isArray(targets) || targets.length === 0
      || !targets.every((target) => typeof target === "string" && target.startsWith("https://"))) {
      problems.push("the ZAP policy must enumerate explicit https targets");
    }
  }

  const allowlistPolicy = policy.allowlist_policy;
  if (!isPlainObject(allowlistPolicy)) {
    problems.push("allowlist_policy must be recorded");
  }
  const maxEntries = allowlistPolicy?.max_entries ?? 0;
  const maxLifetime = allowlistPolicy?.max_lifetime_days ?? 0;
  if (!Number.isInteger(maxEntries) || maxEntries <= 0 || maxEntries > 65) {
    problems.push("allowlist_policy.max_entries must be a positive integer of at most 65");
  }
  if (!Number.isInteger(maxLifetime) || maxLifetime <= 0 || maxLifetime > 365) {
    problems.push("allowlist_policy.max_lifetime_days must be a positive integer of at most 365");
  }

  const allowlist = policy.allowlist;
  if (!Array.isArray(allowlist)) {
    return [...problems, "allowlist must be an array"];
  }
  if (allowlist.length > maxEntries) {
    problems.push(`allowlist holds ${allowlist.length} entries, above the reviewed cap of ${maxEntries}`);
  }
  const seen = new Set();
  allowlist.forEach((entry, index) => {
    const label = `allowlist entry ${index}`;
    if (!isPlainObject(entry)) {
      problems.push(`${label} must be an object`);
      return;
    }
    if (!SCANNER_IDS.includes(entry.scanner)) {
      problems.push(`${label} scanner must be one of ${SCANNER_IDS.join(", ")}`);
    }
    if (typeof entry.identifier !== "string" || entry.identifier.length === 0
      || /[*?]/.test(entry.identifier)) {
      problems.push(`${label} identifier must be one exact rule or vulnerability id`);
    }
    if (typeof entry.path !== "string" || entry.path.length === 0
      || /[*?[\]]/.test(entry.path) || entry.path.includes("..")) {
      problems.push(`${label} path must be one exact repository path without patterns`);
    }
    if (entry.scanner === "semgrep" && entry.max_occurrences !== 1) {
      problems.push(`${label} must bind exactly one Semgrep occurrence`);
    }
    if (entry.scanner === "gitleaks" && !SHA256_PATTERN.test(entry.match_sha256 ?? "")) {
      problems.push(`${label} must bind the exact detected value by sha256 digest`);
    }
    if (entry.scanner !== "gitleaks" && entry.match_sha256 !== undefined) {
      problems.push(`${label} may only bind a value digest for gitleaks findings`);
    }
    // Upstream decision 21 A (October 11, 2026): a Trivy finding in a package
    // reached only through named build tools is classified, not excepted. It
    // is recorded below the blocking floor with no expiry, but only while the
    // advisory, package, installed version and severity read exactly as bound.
    const buildTool = entry.classification === "build-tool";
    if (entry.classification !== undefined && !(buildTool && entry.scanner === "trivy")) {
      problems.push(`${label} classification "build-tool" applies only to Trivy findings`);
    }
    if (buildTool && (!Array.isArray(entry.reached_only_through) || entry.reached_only_through.length === 0
      || entry.reached_only_through.some((name) => typeof name !== "string" || !name || name === entry.package))) {
      problems.push(`${label} build-tool classification must name the build tools that reach the package`);
    } else if (!buildTool && entry.reached_only_through !== undefined) {
      problems.push(`${label} may only name build tools under the build-tool classification`);
    }
    if (entry.scanner === "trivy") {
      if (typeof entry.package !== "string" || !/^[a-z0-9@/._-]+$/.test(entry.package)
        || typeof entry.installed_version !== "string" || !/^\d+\.\d+\.\d+$/.test(entry.installed_version)
        || entry.affected_range !== `<=${entry.installed_version}`
        || !REQUIRED_BLOCKING.trivy.includes(entry.severity)) {
        problems.push(`${label} must bind an exact Trivy package, installed version, affected range and blocking severity`);
      }
      if (buildTool) {
        if (entry.expiry_enforcement !== undefined || entry.expires_on !== undefined) {
          problems.push(`${label} build-tool classification carries no expiry`);
        }
      } else if (entry.expiry_enforcement !== "fail-closed") {
        problems.push(`${label} Trivy expiry must fail closed in every scan`);
      }
      if (!Array.isArray(entry.alternate_identifiers) || entry.alternate_identifiers.length !== 1
        || !/^CVE-\d{4}-\d+$/.test(entry.identifier)
        || !/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(entry.alternate_identifiers[0])) {
        problems.push(`${label} must bind one CVE and its exact GHSA identifier`);
      }
    } else if (entry.alternate_identifiers !== undefined || entry.expiry_enforcement !== undefined
      || entry.package !== undefined || entry.installed_version !== undefined || entry.affected_range !== undefined
      || entry.severity !== undefined) {
      problems.push(`${label} may only bind package/advisory aliases and strict expiry for Trivy`);
    }
    if (entry.lanes !== undefined) {
      if (!Array.isArray(entry.lanes) || entry.lanes.length === 0
        || entry.lanes.some((lane) => !LANES.includes(lane))) {
        problems.push(`${label} lanes must be a non-empty subset of ${LANES.join(", ")}`);
      } else if (entry.lanes.includes("history") && !entry.lanes.includes("tree")
        && entry.scanner !== "gitleaks") {
        problems.push(`${label} may only be history-scoped for gitleaks findings`);
      }
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 40) {
      problems.push(`${label} reason must explain why the finding is accepted`);
    }
    if (typeof entry.reviewed_by !== "string" || entry.reviewed_by.trim().length === 0) {
      problems.push(`${label} reviewed_by must name the reviewing session or person`);
    }
    if (!DATE_PATTERN.test(entry.reviewed_on ?? "")) {
      problems.push(`${label} reviewed_on must be an exact YYYY-MM-DD date`);
    }
    if (buildTool) {
      // No expiry: validated above.
    } else if (!DATE_PATTERN.test(entry.expires_on ?? "")) {
      problems.push(`${label} expires_on must be an exact YYYY-MM-DD date`);
    } else if (DATE_PATTERN.test(entry.reviewed_on ?? "")) {
      const lifetime = daysBetween(entry.reviewed_on, entry.expires_on);
      if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > maxLifetime) {
        problems.push(
          `${label} must expire within ${maxLifetime} days of its review, not ${lifetime}`,
        );
      }
    }
    const key = allowlistKey(entry);
    if (seen.has(key)) problems.push(`${label} duplicates an earlier allowlist entry`);
    seen.add(key);
    for (const identifier of Array.isArray(entry.alternate_identifiers) ? entry.alternate_identifiers : []) {
      const alternateKey = allowlistKey({ ...entry, identifier });
      if (seen.has(alternateKey)) problems.push(`${label} duplicates an earlier advisory alias`);
      seen.add(alternateKey);
    }
  });

  return problems;
}

// A Trivy entry binds one installed version, so one advisory in one lockfile
// that holds several vulnerable copies (picomatch 2.3.2, 4.0.5 and 4.0.7 in
// apps/mobile,) takes one entry per version. The version is part
// of the key on both sides; other scanners carry none.
export function allowlistKey(entry) {
  return [entry.scanner, entry.identifier, entry.path, entry.match_sha256 ?? "", entry.installed_version ?? ""].join("\u0000");
}

/**
 * Normalized finding shape used across scanners.
 * @typedef {{scanner: string, identifier: string, path: string, line: number,
 *   severity: string, title: string, valueDigest?: string,
 *   package?: string, installed_version?: string}} SecurityFinding
 */

/**
 * Whether a reviewed exception is in force for a given lane. An entry with no
 * `lanes` applies to both.
 */
export function entryAppliesToLane(entry, lane) {
  const lanes = Array.isArray(entry.lanes) ? entry.lanes : LANES;
  return lanes.includes(lane);
}

export function findingKey(finding) {
  return [finding.scanner, finding.identifier, finding.path, finding.valueDigest ?? "", finding.installed_version ?? ""].join("\u0000");
}

export function digestOf(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function isBlocking(policy, finding) {
  const scanner = policy.scanners?.[finding.scanner];
  if (!scanner) return true;
  if (Array.isArray(scanner.blocking_severities)) {
    return scanner.blocking_severities.includes(String(finding.severity).toUpperCase());
  }
  return scanner.blocking === true;
}

/**
 * Split a finding set against the reviewed allowlist.
 *
 * @param {SecurityFinding[]} findings
 * @param {object} policy
 * @param {{ today?: string, scanners?: string[], lane?: string }} [options]
 *   `scanners` limits the unused-entry report to the scanners that actually
 *   ran, so a Semgrep-only invocation does not declare every Gitleaks exception
 *   stale. `lane` selects which exceptions are in force at all: a
 *   history-scoped entry is invisible to the per-change lane.
 */
// Resolves a dependency the way Node does from a lockfile package key: every
// ancestor directory's node_modules, nearest first (Node skips directories
// that are themselves named node_modules).
function resolveLockfilePackage(packages, from, name) {
  const parts = from ? from.split("/") : [];
  for (let end = parts.length; end >= 0; end -= 1) {
    if (end > 0 && parts[end - 1] === "node_modules") continue;
    const key = [...parts.slice(0, end), "node_modules", name].join("/");
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
  const base = installedAs.slice(installedAs.lastIndexOf("/") + 1);
  return typeof entry.version === "string" && entry.resolved === `https://registry.npmjs.org/${installedAs}/-/${base}-${entry.version}.tgz`;
}

// True when `target` is installed for production (the root's dependencies,
// optionalDependencies and peerDependencies, followed transitively) without
// passing through any package named in `blocked`; `includeDev` also follows
// the root's devDependencies, the full install. A package is identified by
// its lockfile name when it has one (npm aliases, link targets), so
// `alias: npm:target@x` still counts as the target. A blocked build tool is cut
// only as its registry install (see registryBuildTool); anything else that
// merely carries its name is followed.
export function lockfileReachableInProduction(lock, target, blocked = [], { includeDev = false } = {}) {
  const packages = lock?.packages;
  if (!packages || typeof packages !== "object" || !packages[""]) throw new Error("lockfile has no packages map");
  const seen = new Set();
  const queue = [];
  const follow = (from) => {
    const entry = packages[from];
    const fields = [["dependencies", true], ["optionalDependencies", false], ["peerDependencies", false]];
    // Only the root's devDependencies are installed; a dependency's are not.
    if (includeDev && from === "") fields.push(["devDependencies", true]);
    for (const [field, required] of fields) {
      for (const dependency of Object.keys(entry?.[field] || {})) {
        const key = resolveLockfilePackage(packages, from, dependency);
        // An installed dependency that cannot be located cannot be proven absent.
        if (!key && required) throw new Error(`lockfile ${from || "root"} dependency ${dependency} does not resolve`);
        if (key) queue.push(key);
      }
    }
  };
  // npm links workspaces without listing them in the root's dependency fields,
  // so a workspace lockfile cannot be proven here; it fails closed.
  if (packages[""].workspaces !== undefined) throw new Error("lockfile declares workspaces; build-tool reachability cannot be proven");
  follow("");
  while (queue.length) {
    const key = queue.shift();
    if (seen.has(key)) continue;
    seen.add(key);
    // A link entry carries no metadata; its dependencies live at the target
    // entry and resolve from the target's path. A dangling link fails closed.
    const home = packages[key].link ? packages[key].resolved : key;
    if (typeof home !== "string" || !packages[home]) throw new Error(`lockfile link ${key} has no target entry`);
    const installedAs = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
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
export function lockfileBuildToolPathProven(lock, target, buildTools) {
  return lockfileReachableInProduction(lock, target, [], { includeDev: true })
    && !lockfileReachableInProduction(lock, target, buildTools, { includeDev: true });
}

/**
 * readLockfile(path) returns the parsed lockfile a build-tool classification
 * names. Without it, or unless the lockfile positively proves every route to
 * the package passes through the named build tools, the classification does
 * not apply and the finding is handled like any other.
 */
export function applyPolicy(findings, policy, { today = null, scanners = null, lane = "tree", readLockfile = null } = {}) {
  const scope = scanners ? new Set(scanners) : null;
  const allEntries = Array.isArray(policy.allowlist) ? policy.allowlist : [];
  const entries = allEntries
    .filter((entry) => (!scope || scope.has(entry.scanner)) && entryAppliesToLane(entry, lane));
  const reference = today ?? new Date().toISOString().slice(0, 10);
  const index = new Map(entries.flatMap((entry) =>
    entry.expiry_enforcement === "fail-closed" && entry.expires_on <= reference ? []
      : [entry.identifier, ...(entry.alternate_identifiers ?? [])]
        .map(identifier => [allowlistKey({ ...entry, identifier }), entry])));
  const proofs = new Map();
  const buildToolProven = (entry) => {
    if (!proofs.has(entry)) {
      let proven;
      try {
        const lock = readLockfile ? readLockfile(entry.path) : null;
        proven = Boolean(lock) && lockfileBuildToolPathProven(lock, entry.package, entry.reached_only_through);
      } catch {
        proven = false;
      }
      proofs.set(entry, proven);
    }
    return proofs.get(entry);
  };
  const used = new Set();
  const counts = new Map();
  const blocking = [];
  const recorded = [];
  const accepted = [];

  for (const finding of findings) {
    const entry = index.get(findingKey(finding));
    const key = entry ? allowlistKey(entry) : findingKey(finding);
    const exactPackage = entry?.scanner !== "trivy" || (entry.package === finding.package
      && entry.installed_version === finding.installed_version && entry.severity === finding.severity);
    if (entry && exactPackage && entry.classification === "build-tool" && buildToolProven(entry)) {
      used.add(key);
      recorded.push(finding);
      continue;
    }
    if (entry && exactPackage && entry.classification !== "build-tool" && (entry.scanner !== "semgrep" || (counts.get(key) ?? 0) < entry.max_occurrences)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      used.add(key);
      accepted.push({ finding, entry });
      continue;
    }
    if (isBlocking(policy, finding)) blocking.push(finding);
    else recorded.push(finding);
  }

  const unused = entries.filter((entry) => !used.has(allowlistKey(entry)));
  const expiryEntries = lane === "history" ? allEntries
    : allEntries.filter(entry => entries.includes(entry) || entry.expiry_enforcement === "fail-closed");
  const expired = expiryEntries.filter((entry) => entry.expires_on !== undefined && entry.expires_on <= reference);
  return { blocking, recorded, accepted, unused, expired };
}

/** Human-readable finding line. It never contains the detected value. */
export function formatFinding(finding) {
  const location = finding.line > 0 ? `${finding.path}:${finding.line}` : finding.path;
  return `[${finding.scanner}] ${finding.severity} ${finding.identifier} ${location}`;
}

/* ---------------------------------------------------------------------- */
/* Scanner report normalizers. Each takes the scanner's own JSON and       */
/* returns SecurityFinding[], so the policy sees one vocabulary.           */
/* ---------------------------------------------------------------------- */

function repositoryRelative(path) {
  const normalized = String(path ?? "").replace(/\\/g, "/");
  const trimmed = normalized.replace(/^\/repo\//, "").replace(/^\/src\//, "").replace(/^\.\//, "");
  return trimmed.replace(/^\//, "");
}

export function normalizeSemgrepReport(report) {
  if (!Array.isArray(report?.results)
    || (report.errors !== undefined && (!Array.isArray(report.errors) || report.errors.length > 0))) {
    throw new Error("semgrep report is incomplete or contains scan errors");
  }
  const results = report.results;
  return results.map((result) => ({
    scanner: "semgrep",
    identifier: String(result.check_id ?? "").split(".").at(-1),
    path: repositoryRelative(result.path),
    line: Number(result.start?.line ?? 0),
    severity: String(result.extra?.severity ?? "ERROR").toUpperCase(),
    title: String(result.extra?.message ?? "").split("\n")[0].trim(),
  }));
}

export function normalizeGitleaksReport(report) {
  if (!Array.isArray(report)) throw new Error("gitleaks report is incomplete");
  const findings = report;
  return findings.map((finding) => ({
    scanner: "gitleaks",
    identifier: String(finding.RuleID ?? "unknown"),
    path: repositoryRelative(finding.File),
    line: Number(finding.StartLine ?? 0),
    severity: "HIGH",
    title: String(finding.Description ?? "committed secret").split("\n")[0].trim(),
    valueDigest: digestOf(finding.Secret ?? ""),
  }));
}

export function normalizeTrivyReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)
    || (report.Results !== undefined && !Array.isArray(report.Results))
    || (report.Results === undefined && report.SchemaVersion !== 2)) {
    throw new Error("trivy report is incomplete");
  }
  const results = report.Results ?? [];
  const findings = [];
  for (const result of results) {
    const target = repositoryRelative(result.Target);
    for (const vulnerability of result.Vulnerabilities ?? []) {
      findings.push({
        scanner: "trivy",
        identifier: String(vulnerability.VulnerabilityID ?? "unknown"),
        package: String(vulnerability.PkgName ?? ""),
        installed_version: String(vulnerability.InstalledVersion ?? ""),
        path: target,
        line: 0,
        severity: String(vulnerability.Severity ?? "UNKNOWN").toUpperCase(),
        title: `${vulnerability.PkgName ?? "package"} ${vulnerability.InstalledVersion ?? ""}`.trim(),
      });
    }
    for (const misconfiguration of result.Misconfigurations ?? []) {
      findings.push({
        scanner: "trivy",
        identifier: String(misconfiguration.ID ?? "unknown"),
        path: target,
        line: Number(misconfiguration.CauseMetadata?.StartLine ?? 0),
        severity: String(misconfiguration.Severity ?? "UNKNOWN").toUpperCase(),
        title: String(misconfiguration.Title ?? "misconfiguration"),
      });
    }
    for (const secret of result.Secrets ?? []) {
      findings.push({
        scanner: "trivy",
        identifier: String(secret.RuleID ?? "unknown"),
        path: target,
        line: Number(secret.StartLine ?? 0),
        severity: String(secret.Severity ?? "UNKNOWN").toUpperCase(),
        title: String(secret.Title ?? "embedded secret"),
      });
    }
  }
  return findings;
}

export const NORMALIZERS = Object.freeze({
  semgrep: normalizeSemgrepReport,
  gitleaks: normalizeGitleaksReport,
  trivy: normalizeTrivyReport,
});
