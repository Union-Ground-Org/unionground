// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { runnerTimeout, runnerTimeoutMultiplier } from "../scripts/lib/runner-timeout.mjs";

// Run 43068498609 (November 11, 2026): GitHub's standard 2-vCPU runner gets
// three times every written budget; every other machine keeps it as written.
it("triples a budget on a GitHub-hosted runner and nowhere else", () => {
  expect(runnerTimeout(60_000, { RUNNER_ENVIRONMENT: "github-hosted" })).toBe(180_000);
  expect(runnerTimeout(60_000, { RUNNER_ENVIRONMENT: "self-hosted" })).toBe(60_000);
  expect(runnerTimeout(60_000, {})).toBe(60_000);
  expect(runnerTimeoutMultiplier({ RUNNER_ENVIRONMENT: "constructor" })).toBe(1);
});

// The budgets that failed on the standard runner go through the helper, so a
// later edit cannot quietly return them to a fixed number.
it("routes the suite timeouts and the coordinator KPI budget through the helper", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const config = read("vite.config.mjs");
  expect(config).toContain("testTimeout: runnerTimeout(process.env.CI ? 30_000 : 10_000)");
  expect(config).toContain("hookTimeout: runnerTimeout(10_000)");
  expect(read("tests/coordinator-kpis-restriction-gate-db.test.js")).toContain("budgetMs: runnerTimeout(4000)");
});

// Run 43131067684 (pull request #84): two more database proofs failed on a
// slow runner, one on a wall-clock bound and one on a fixture's statement
// limit. Every database proof that measures time takes its budget from the
// helper, as in the sibling repository.
it("routes the database proofs' wall-clock and statement budgets through the helper", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  for (const [path, uses] of [
    ["tests/analytics-workspace-case-visibility-db.test.js", ["statementTimeout(60)", "statementTimeout(120)", "runnerTimeoutMultiplier() === 1 ? 180000 : 900000"]],
    ["tests/auth-bookkeeping-lock-scope-db.test.js", ["runnerTimeout(2500)", "runnerTimeout(1400)"]],
    ["tests/coordination-snapshot-latency-db.test.js", ["runnerTimeout(2000)"]],
    ["tests/message-lifecycle-bounded-wait-db.test.js", ["runnerTimeout(1500)"]],
    ["tests/steward-desk-scale-latency-db.test.js", ["loadScaledBudget(client, 4_000", "process.env.CI ? 2 : 8"]],
  ]) {
    const source = read(path);
    for (const use of uses) expect(source, `${path}: ${use}`).toContain(use);
  }
});
