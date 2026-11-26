// @vitest-environment node
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  blockingSemgrepRuleIds,
  uncoveredBlockingRules,
} from "../scripts/run-security-scan.mjs";
import { loadPolicy, REPOSITORY_ROOT } from "../scripts/lib/security-scanner-policy.mjs";

const EXPECTED_BLOCKING_RULES = [
  "unionground-eval-on-dynamic-input",
  "unionground-child-process-shell-interpolation",
  "unionground-tls-verification-disabled",
  "unionground-weak-hash-for-security",
  "unionground-math-random-for-credential",
  "unionground-non-constant-time-secret-comparison",
  "unionground-jwt-verify-without-algorithms",
  "unionground-sql-string-concatenation",
  "unionground-secret-written-to-logs",
  "unionground-permissive-cors-with-credentials",
];

function dockerAvailable() {
  try {
    execFileSync("docker", ["info"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function runSelfTest(scratch) {
  try {
    return {
      status: 0,
      output: execFileSync(process.execPath, [join(scratch, "scripts/run-security-scan.mjs"), "self-test"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 240_000,
      }),
    };
  } catch (error) {
    return {
      status: typeof error.status === "number" ? error.status : 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

describe("semgrep self-test blocking-rule fixture coverage", () => {
  it("derives exactly the ten ERROR-severity rule identifiers from the ruleset", () => {
    expect(blockingSemgrepRuleIds(loadPolicy())).toEqual(EXPECTED_BLOCKING_RULES);
  });

  it("fails closed when the ruleset cannot be read or carries no blocking rules", () => {
    expect(() => blockingSemgrepRuleIds({ scanners: { semgrep: { ruleset: "config/does-not-exist.yml" } } }))
      .toThrow("semgrep ruleset is unreadable");
    expect(() => blockingSemgrepRuleIds({ scanners: { semgrep: { ruleset: "config/security-scanner-policy.json" } } }))
      .toThrow("semgrep ruleset carries no rules list");
    expect(() => blockingSemgrepRuleIds({ scanners: { semgrep: {} } }))
      .toThrow("semgrep ruleset path is not configured");
  });

  it("fails closed when a rule carries no severity instead of skipping it", () => {
    const root = mkdtempSync(join(tmpdir(), "semgrep-ruleset-"));
    try {
      writeFileSync(join(root, "rules.yml"), "rules:\n  - id: unionground-a\n    severity: ERROR\n  - id: unionground-b\n    message: no severity\n");
      expect(() => blockingSemgrepRuleIds({ scanners: { semgrep: { ruleset: "rules.yml" } } }, { root }))
        .toThrow("semgrep ruleset rule unionground-b carries no severity");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the self-test runner free of package imports, since the security job runs it before npm ci", () => {
    for (const path of ["scripts/run-security-scan.mjs", "scripts/lib/security-scanner-policy.mjs"]) {
      const specifiers = [...readFileSync(resolve(REPOSITORY_ROOT, path), "utf8").matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gms)]
        .map((match) => match[1]);
      expect(specifiers.length).toBeGreaterThan(0);
      expect(specifiers.filter((specifier) => !specifier.startsWith("node:") && !specifier.startsWith("."))).toEqual([]);
    }
  });

  it("names each blocking rule that produced no unsafe-fixture finding", () => {
    const unsafeFindings = [
      { identifier: "unionground-eval-on-dynamic-input" },
      { identifier: "unionground-weak-hash-for-security" },
      { identifier: "unionground-jwt-verify-without-algorithms" },
    ];
    expect(uncoveredBlockingRules(EXPECTED_BLOCKING_RULES, unsafeFindings))
      .toEqual(EXPECTED_BLOCKING_RULES.filter((id) => !unsafeFindings.some((f) => f.identifier === id)));
    expect(uncoveredBlockingRules(EXPECTED_BLOCKING_RULES, unsafeFindings))
      .toEqual(expect.arrayContaining([
        "unionground-child-process-shell-interpolation",
        "unionground-tls-verification-disabled",
        "unionground-math-random-for-credential",
        "unionground-non-constant-time-secret-comparison",
        "unionground-sql-string-concatenation",
        "unionground-secret-written-to-logs",
        "unionground-permissive-cors-with-credentials",
      ]));
    expect(uncoveredBlockingRules(EXPECTED_BLOCKING_RULES, unsafeFindings))
      .not.toContain("unionground-eval-on-dynamic-input");
    expect(uncoveredBlockingRules(EXPECTED_BLOCKING_RULES, EXPECTED_BLOCKING_RULES.map((identifier) => ({ identifier })))).toEqual([]);
  });
});

describe("semgrep self-test fixture corpus proof", () => {
  // Runs the pinned scanner images through docker, so it is opt-in: the
  // security workflow's own `run-security-scan.mjs self-test` step enforces the
  // same per-rule coverage on every run, and the default suite stays hermetic.
  const run = process.env.RUN_SECURITY_SCANNER_SELF_TEST_CORPUS === "1" && dockerAvailable() ? it : it.skip;

  function copyCorpus(target) {
    for (const path of [
      "scripts/run-security-scan.mjs",
      "scripts/lib/security-scanner-policy.mjs",
      "config/semgrep-rules.yml",
      "config/security-scanner-policy.json",
      "tests/fixtures/security-scanners",
    ]) {
      cpSync(resolve(REPOSITORY_ROOT, path), join(target, path), { recursive: true });
    }
  }

  run("fails by rule identifier when one unsafe fixture is missing from the corpus", () => {
    const scratch = mkdtempSync(join(tmpdir(), "semgrep-self-test-"));
    copyCorpus(scratch);
    rmSync(join(scratch, "tests/fixtures/security-scanners/semgrep/unsafe/weak-hash.js"));
    try {
      const { status, output } = runSelfTest(scratch);
      expect(status).not.toBe(0);
      expect(output).toContain("unionground-weak-hash-for-security");
      expect(output).toContain("unsafe fixture");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 300_000);

  run("passes on the pristine corpus with every blocking rule covered and zero safe findings", () => {
    const pristine = mkdtempSync(join(tmpdir(), "semgrep-self-test-pristine-"));
    copyCorpus(pristine);
    try {
      const { status, output } = runSelfTest(pristine);
      expect(status).toBe(0);
      expect(output).toContain("covering 10/10 blocking rules");
      expect(output).toContain("0 safe");
    } finally {
      rmSync(pristine, { recursive: true, force: true });
    }
  }, 300_000);
});
