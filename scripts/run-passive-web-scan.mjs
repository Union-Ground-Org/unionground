#!/usr/bin/env node
// Calibrated passive web scan (OWASP ZAP baseline).
//
//   node scripts/run-passive-web-scan.mjs --target <https origin> --out <dir>
//
// This is deliberately a non-blocking, manually triggered lane. The donor
// repository ran ZAP as an optional security-baseline job, never as a blocking
// release gate, and `config/security-scanner-policy.json` records that instead
// of restating history as enforcement.
//
// Privacy and target policy, enforced here rather than described in prose:
//   * the target must be one of the origins enumerated in the reviewed policy,
//     so an operator cannot point the scanner at somebody else's site;
//   * passive rules only — no active attack, no fuzzing, no spider of an
//     authenticated surface;
//   * no credential is supplied, so no member record is ever reached;
//   * the retained artifact is a counts-and-rule-identifiers summary. Request
//     and response bodies, cookies and URLs beyond the origin never leave the
//     runner.

import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(HERE, "..");

export function loadZapPolicy(root = REPOSITORY_ROOT) {
  const policy = JSON.parse(readFileSync(join(root, "config/security-scanner-policy.json"), "utf8"));
  const zap = policy?.zap;
  if (!zap) throw new Error("PASSIVE_SCAN_FAIL: the reviewed policy has no ZAP section");
  return zap;
}

/**
 * Accept only an exact allowlisted origin. A target with a path, a query, a
 * different host or a non-https scheme is refused; there is no normalization
 * that could turn a near-miss into an accepted target.
 */
export function assertAllowedTarget(target, zap) {
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("PASSIVE_SCAN_FAIL: --target is required");
  }
  const allowed = Array.isArray(zap.allowed_targets) ? zap.allowed_targets : [];
  if (!allowed.includes(target)) {
    throw new Error("PASSIVE_SCAN_FAIL: target is not an allowlisted origin");
  }
  const url = new URL(target);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("PASSIVE_SCAN_FAIL: the target must be a bare https origin");
  }
  return target;
}

/**
 * Reduce a ZAP JSON report to counts and rule identifiers.
 * Nothing carrying page content, parameters or cookies survives.
 */
export function summarizeReport(report, { target }) {
  const sites = Array.isArray(report?.site) ? report.site : [];
  const alerts = [];
  for (const site of sites) {
    for (const alert of site.alerts ?? []) {
      alerts.push({
        pluginId: String(alert.pluginid ?? "unknown"),
        alertRef: String(alert.alertRef ?? alert.pluginid ?? "unknown"),
        riskcode: String(alert.riskcode ?? "0"),
        confidence: String(alert.confidence ?? "0"),
        instanceCount: Array.isArray(alert.instances) ? alert.instances.length : 0,
      });
    }
  }
  alerts.sort((left, right) => (left.alertRef < right.alertRef ? -1 : left.alertRef > right.alertRef ? 1 : 0));
  const byRisk = alerts.reduce((counts, alert) => {
    counts[alert.riskcode] = (counts[alert.riskcode] ?? 0) + 1;
    return counts;
  }, {});
  return {
    schema: 1,
    target,
    mode: "passive-baseline",
    blocking: false,
    alertCount: alerts.length,
    countsByRiskcode: byRisk,
    alerts,
  };
}

function executionFailure(error) {
  // Never interpolate Docker output, command text, paths, or JSON parser errors:
  // they can contain response bodies and cookies. Only fixed classifications
  // and a numeric process status cross the runner's logging boundary.
  const denied = /permission denied|accessdeniedexception/i.test(`${error?.stdout ?? ""}\n${error?.stderr ?? ""}`);
  return denied ? "permission-denied" : "scanner-execution";
}

function validateReport(report) {
  if (!Array.isArray(report?.site) || report.site.length === 0 || report.site.some((site) => (
    !site || !Array.isArray(site.alerts) || site.alerts.some((alert) => (
      !alert || !/^\d+$/.test(String(alert.pluginid ?? ""))
      || !/^\d+(?:-\d+)?$/.test(String(alert.alertRef ?? alert.pluginid ?? ""))
      || !/^[0-3]$/.test(String(alert.riskcode ?? ""))
      || !/^[0-4]$/.test(String(alert.confidence ?? ""))
      || !Array.isArray(alert.instances)
    ))
  ))) throw new Error("PASSIVE_SCAN_FAIL: incomplete scanner report");
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--target" || !args[1] || args[2] !== "--out" || !args[3]) {
    throw new Error("PASSIVE_SCAN_FAIL: expected --target <origin> --out <directory>");
  }
  const target = args[1];
  const outDirectory = resolve(args[3]);
  const zap = loadZapPolicy();
  assertAllowedTarget(target, zap);
  if (!zap.image || !zap.digest) {
    throw new Error("PASSIVE_SCAN_FAIL: the ZAP image must be pinned to an exact digest");
  }

  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid < 0) {
    throw new Error("PASSIVE_SCAN_FAIL: a non-root POSIX operator identity is required");
  }
  if (outDirectory.includes(",")) throw new Error("PASSIVE_SCAN_FAIL: unsupported output directory");
  mkdirSync(outDirectory, { recursive: true, mode: 0o700 });
  if (!lstatSync(outDirectory).isDirectory()) throw new Error("PASSIVE_SCAN_FAIL: output must be a directory");
  const summaryPath = join(outDirectory, "passive-web-summary.json");
  rmSync(summaryPath, { force: true });
  // A fresh private directory prevents an earlier attempt's report from being
  // mistaken for this run. Matching the caller's UID also makes generated files
  // readable and removable by the caller on runners whose UID is not 1000.
  const workspace = mkdtempSync(join(outDirectory, ".zap-passive-"));
  const reportName = "zap-report.json";
  let summary;
  try {
    mkdirSync(join(workspace, "home"), { mode: 0o700 });
    let diagnostic;
    try {
      const stdout = execFileSync("docker", [
        "run", "--rm",
        "--user", `${uid}:${gid}`,
        "--env", "HOME=/zap/wrk/home",
        "--mount", `type=bind,source=${workspace},target=/zap/wrk`,
        `${zap.image}@${zap.digest}`,
        "zap-baseline.py",
        "-t", target,
        "-J", reportName,
        "-z", "-dir /zap/wrk/home/zap",
        // Pinned ZAP's statuses 1 and 2 mean findings, not execution failure.
        // All three require a complete report; findings remain informational.
        "-I",
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
      diagnostic = { stdout };
    } catch (error) {
      diagnostic = error;
      if (![1, 2].includes(error.status) || error.signal || error.code) {
        const status = Number.isInteger(error.status) ? `; exit ${error.status}` : "";
        throw new Error(`PASSIVE_SCAN_FAIL: ${executionFailure(error)}${status}`, { cause: error });
      }
    }
    let raw;
    try {
      const reportPath = join(workspace, reportName);
      const stat = lstatSync(reportPath);
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) {
        throw new Error("invalid report file");
      }
      raw = readFileSync(reportPath, "utf8");
    } catch {
      throw new Error(`PASSIVE_SCAN_FAIL: missing or invalid report (${executionFailure(diagnostic)})`);
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch {
      throw new Error("PASSIVE_SCAN_FAIL: malformed scanner report");
    }
    validateReport(parsed);
    summary = summarizeReport(parsed, { target });
  } finally {
    // Remove raw bodies, generated plans, and scanner state on every outcome.
    // Only the validated redacted summary is written after cleanup succeeds.
    rmSync(workspace, { recursive: true, force: true });
  }
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  console.log(
    `passive web scan of ${target}: ${summary.alertCount} alert(s) recorded, non-blocking by policy.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(error.message?.startsWith("PASSIVE_SCAN_FAIL:") ? error.message : "PASSIVE_SCAN_FAIL: scanner workspace I/O failed");
    process.exitCode = 1;
  }
}
