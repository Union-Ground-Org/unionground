// @vitest-environment node

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryFile = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url));

const BARE_REPORTS_GLOB = "(^|/)reports/";
const WINDOW_WILDCARD = "operator-acceptance/[^/]+/reports/";
const OPERATOR_ACCEPTANCE_REPORT_ROOT = "docs/operations/evidence/operator-acceptance/";
const TREE_SCAN_PREFIX = "/repo/";
const PERMITTED_FIXTURE_PATH =
  "tests/fixtures/security-scanners/gitleaks/unsafe/committed-key.js";
const ORDINARY_REPORT_PATH = "src/reports/summary.json";
// Synthetic paths exercise the allowlist against accidentally tracked reports.
const EVIDENCE_REPORT_PATH =
  "docs/operations/evidence/operator-acceptance/example-auth-check/reports/login-check.json";
const OUT_OF_SCOPE_REPORT_PATH =
  "docs/operations/evidence/operator-acceptance/sample-decisions/example-release/reports/release-check.json";
const UNREVIEWED_WINDOW_REPORT =
  "docs/operations/evidence/operator-acceptance/unreviewed/reports/secret.json";

function allowlistPaths(source) {
  expect(source, "config/gitleaks.toml must declare [allowlist] paths").toMatch(/\[allowlist\][\s\S]*paths\s*=\s*\[/);
  // Path entries are TOML literal strings. The description uses """ so every
  // '''...''' pair in this file is an allowlist path, including entries whose
  // regex contains ']'.
  const quoted = String.raw`'''`;
  return [...source.matchAll(new RegExp(`${quoted}([^']+)${quoted}`, "g"))].map((match) => match[1]);
}

function matchesAllowlist(path, entries) {
  return entries.some((entry) => new RegExp(entry).test(path));
}

describe("gitleaks path allowlist", () => {
  const source = readFileSync(repositoryFile("config/gitleaks.toml"), "utf8");
  const paths = allowlistPaths(source);

  it("does not restore the blanket reports glob", () => {
    expect(paths).not.toContain(BARE_REPORTS_GLOB);
  });

  it("does not exempt operator-acceptance report roots", () => {
    expect(paths.some((entry) => entry.includes(WINDOW_WILDCARD))).toBe(false);
    expect(paths.some((entry) => entry.includes(OPERATOR_ACCEPTANCE_REPORT_ROOT))).toBe(false);
  });

  it("compiles every allowlist path as a regular expression", () => {
    for (const entry of paths) {
      expect(() => new RegExp(entry), entry).not.toThrow();
    }
  });

  it("keeps the reviewed scanner fixture surface allowlisted", () => {
    expect(existsSync(repositoryFile(PERMITTED_FIXTURE_PATH))).toBe(true);
    expect(matchesAllowlist(PERMITTED_FIXTURE_PATH, paths)).toBe(true);
    expect(matchesAllowlist(`${TREE_SCAN_PREFIX}${PERMITTED_FIXTURE_PATH}`, paths)).toBe(true);
  });

  it("keeps ordinary and evidence report paths under the committed-secret scan", () => {
    expect(matchesAllowlist(ORDINARY_REPORT_PATH, paths)).toBe(false);
    expect(matchesAllowlist(`${TREE_SCAN_PREFIX}${ORDINARY_REPORT_PATH}`, paths)).toBe(false);
    expect(matchesAllowlist(EVIDENCE_REPORT_PATH, paths)).toBe(false);
    expect(matchesAllowlist(`${TREE_SCAN_PREFIX}${EVIDENCE_REPORT_PATH}`, paths)).toBe(false);
    expect(matchesAllowlist(OUT_OF_SCOPE_REPORT_PATH, paths)).toBe(false);
    expect(matchesAllowlist(`${TREE_SCAN_PREFIX}${OUT_OF_SCOPE_REPORT_PATH}`, paths)).toBe(false);
    expect(matchesAllowlist(UNREVIEWED_WINDOW_REPORT, paths)).toBe(false);
    expect(matchesAllowlist(`${TREE_SCAN_PREFIX}${UNREVIEWED_WINDOW_REPORT}`, paths)).toBe(false);
  });
});
