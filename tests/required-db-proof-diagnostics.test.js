// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeHookErrors } from "../scripts/lib/required-db-proof-json-reporter.mjs";
import { readRequiredDbProofPhaseReport, requiredDbProofVitestArgs } from "../scripts/run-required-db-proofs.mjs";

describe("required database proof hook diagnostics", () => {
  it("retains a nested afterAll failure even when every assertion passed", () => {
    // Vitest 5 leaves a thrown hook in state run, not fail.
    const suiteErrors = describeHookErrors({ name: "outer", tasks: [{
      type: "suite", name: "owned database", result: {
        hooks: { beforeAll: "pass", afterAll: "run" },
        errors: [{ message: "teardown timed out", stack: "Error: teardown timed out\n at fixture:12" }],
      },
    }, { type: "test", name: "assertion", result: { state: "pass" } }] });
    expect(suiteErrors).toEqual([{ suite: "outer > owned database", hook: "afterAll", message: "Error: teardown timed out\n at fixture:12" }]);
    const report = { numTotalTests: 1, numPassedTests: 1, numFailedTests: 0,
      numPendingTests: 0, numTodoTests: 0, testResults: [{
        name: "tests/owned-db.test.js", status: "failed", message: "", suiteErrors,
        assertionResults: [{ status: "passed", title: "assertion" }],
      }] };
    const directory = mkdtempSync(join(tmpdir(), "db-hook-report-"));
    try {
      const path = join(directory, "report.json");
      writeFileSync(path, JSON.stringify(report));
      const lines = [];
      expect(readRequiredDbProofPhaseReport(path, 1, "shared", line => lines.push(line))).toEqual(report);
      expect(lines.join("")).toContain("FAIL HOOK: tests/owned-db.test.js | outer > owned database | afterAll | Error: teardown timed out");
      expect(lines.join("")).toContain("1 total, 1 passed, 0 failed");
      expect(lines.join("")).not.toContain("No error message reported");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("uses the hook-aware JSON reporter for the real proof process", () => {
    expect(requiredDbProofVitestArgs("/owned/report.json")).toContain("--reporter=./scripts/lib/required-db-proof-json-reporter.mjs");
  });

  it("keeps the existing assertion diagnostic when there is no suite-hook extension", () => {
    expect(describeHookErrors({ name: "green", result: { state: "pass" } })).toEqual([]);
    const directory = mkdtempSync(join(tmpdir(), "db-assertion-report-"));
    try {
      const path = join(directory, "report.json");
      writeFileSync(path, JSON.stringify({ testResults: [{ name: "legacy", status: "failed",
        assertionResults: [{ status: "failed", title: "rejects", failureMessages: ["Error: assertion failed"] }],
      }] }));
      const lines = [];
      readRequiredDbProofPhaseReport(path, 1, "legacy", line => lines.push(line));
      expect(lines.join("")).toContain("FAIL TEST: legacy | rejects | Error: assertion failed");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
