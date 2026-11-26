#!/usr/bin/env node
// Blocking gate: secret-like environment reads must fail closed.
//
// Scope is the production-capable surface named by
// SEC-UG-SECRET-FALLBACK-BAN: root web code, api/, workers/, the scripts
// used for deployment and verification, GitHub Actions workflows, and the
// native build configuration. Tests and fixtures are excluded because a
// fixture's whole purpose is to carry the unsafe shape.
//
// The gate prints locations, variable names and a classification. It never
// prints the rejected value.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyAllowlist,
  formatFinding,
  scanFile,
  validateAllowlist,
} from "./lib/env-fallback-scan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(HERE, "..");
export const ALLOWLIST_PATH = "config/env-fallback-allowlist.json";

/**
 * Exact, reviewed scan scope. Each entry is a repository-relative prefix or
 * exact path plus the extensions that are analysed there.
 */
export const SCAN_SCOPE = Object.freeze([
  { prefix: "src/", extensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"] },
  { prefix: "api/", extensions: [".js", ".mjs", ".cjs", ".ts"] },
  { prefix: "workers/", extensions: [".ts", ".js", ".mjs"] },
  { prefix: "scripts/", extensions: [".mjs", ".js", ".cjs"] },
  { prefix: ".github/workflows/", extensions: [".yml", ".yaml"] },
  { prefix: "apps/mobile/scripts/", extensions: [".mjs", ".js", ".ts"] },
  { path: "apps/mobile/app.config.ts" },
  { path: "apps/mobile/metro.config.js" },
  { path: "apps/mobile/eas.json" },
  { path: "apps/mobile/app.json" },
  { path: "vite.config.mjs" },
  { path: "vercel.json" },
  { path: "wrangler.integration-router.jsonc" },
  { path: "wrangler.posthog.jsonc" },
]);

/**
 * Paths excluded from the production scan. Every exclusion is exact and
 * justified; there is no regex-wide skip list.
 */
export const SCAN_EXCLUSIONS = Object.freeze([
  // Fixtures deliberately contain the banned shapes so the gate can be proven.
  "tests/fixtures/",
  // The scanner and its own library describe the banned shapes in comments and
  // in string form; scanning them would report the gate against itself.
  "scripts/lib/env-fallback-scan.mjs",
  "scripts/verify-env-fallback-ban.mjs",
]);

export function isInScope(path) {
  if (SCAN_EXCLUSIONS.some((exclusion) => path === exclusion || path.startsWith(exclusion))) {
    return false;
  }
  return SCAN_SCOPE.some((entry) => {
    if (entry.path) return entry.path === path;
    if (!path.startsWith(entry.prefix)) return false;
    return entry.extensions.some((extension) => path.endsWith(extension));
  });
}

function trackedFiles(root) {
  const output = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split("\0").filter((entry) => entry.length > 0);
}

export function scanRepository({ root = REPOSITORY_ROOT, files = null } = {}) {
  const candidates = (files ?? trackedFiles(root)).filter(isInScope).sort();
  const findings = [];
  for (const path of candidates) {
    const source = readFileSync(join(root, path), "utf8");
    findings.push(...scanFile({ path, source }));
  }
  return { scannedFileCount: candidates.length, findings };
}

export function loadAllowlist(root = REPOSITORY_ROOT) {
  return JSON.parse(readFileSync(join(root, ALLOWLIST_PATH), "utf8"));
}

function main() {
  const root = REPOSITORY_ROOT;
  let allowlist;
  try {
    allowlist = loadAllowlist(root);
  } catch (error) {
    console.error(`ENV_FALLBACK_BAN_FAIL: ${ALLOWLIST_PATH} is unreadable: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const allowlistProblems = validateAllowlist(allowlist);
  if (allowlistProblems.length > 0) {
    console.error("ENV_FALLBACK_BAN_FAIL: the reviewed allowlist is invalid");
    for (const problem of allowlistProblems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  const { scannedFileCount, findings } = scanRepository({ root });
  const { remaining, unused } = applyAllowlist(findings, allowlist);

  if (unused.length > 0) {
    console.error(
      "ENV_FALLBACK_BAN_FAIL: the reviewed allowlist contains entries that no longer match anything.",
    );
    console.error("Remove them rather than leaving a widened exclusion in place:");
    for (const entry of unused) {
      console.error(`  - ${entry.path} ${entry.variable} [${entry.kind}]`);
    }
    process.exitCode = 1;
    return;
  }

  if (remaining.length > 0) {
    console.error(
      `ENV_FALLBACK_BAN_FAIL: ${remaining.length} secret-like environment read(s) carry a banned fallback.`,
    );
    for (const finding of remaining) console.error(`  - ${formatFinding(finding)}`);
    console.error(
      "Fail closed instead: validate the variable and throw when it is absent, or add a narrow reviewed entry to "
        + `${ALLOWLIST_PATH} when the default is provably not a secret.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `env-fallback ban: ${scannedFileCount} in-scope files scanned, `
      + `${allowlist.entries.length} reviewed allowlist entr${allowlist.entries.length === 1 ? "y" : "ies"}, no banned fallbacks.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
