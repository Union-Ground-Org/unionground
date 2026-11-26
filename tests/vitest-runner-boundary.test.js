import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

describe("Vitest runner boundary", () => {
  it("does not collect tests owned by separate runners", () => {
    const vitest = resolve("node_modules/vitest/vitest.mjs");
    const files = execFileSync(
      process.execPath,
      [vitest, "list", "--filesOnly", "--config", "vite.config.mjs"],
      { encoding: "utf8" },
    ).trim().split("\n");

    expect(files).toContain("tests/vitest-runner-boundary.test.js");
    expect(files).not.toContain("e2e/assurance-smoke.spec.js");
    expect(files).not.toContain("apps/mobile/src/lib/routes.test.ts");
  });

  it("keeps approved-runner concurrency and async UI timeouts explicitly bounded", () => {
    const config = readFileSync(resolve("vite.config.mjs"), "utf8");

    // The 8-vCPU assurance runner is capped at four workers (2026-09-22: eight starved jsdom renders).
    expect(config).toMatch(/minWorkers:\s*1/);
    // Local runs keep the tight 10 s budget; CI (hosted 8-worker Root check) gets 30 s.
    expect(config).toMatch(/testTimeout:\s*runnerTimeout\(process\.env\.CI \? 30_000 : 10_000\)/);
  });

  // A host in Pacific/Kiritimati (UTC+14) formatted this instant as Aug 3 and
  // failed tests/case-dashboards.test.jsx for an environmental reason.
  it.skipIf(process.env.VITEST_KEEP_TZ)("runs every worker in UTC whatever the host zone", () => {
    const instant = new Date("2026-08-02T12:00:00Z");

    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toMatch(/^(UTC|Etc\/UTC)$/);
    expect(instant.getTimezoneOffset()).toBe(0);
    expect(new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(instant)).toBe("Aug 2, 2026");
    expect(new Date(2026, 7, 2).toISOString()).toBe("2026-08-02T00:00:00.000Z");
  });

  it("bounds only the two cold demo Committee readiness queries", () => {
    const source = readFileSync(resolve("tests/demo-actions.test.jsx"), "utf8");
    const queries = [...source.matchAll(/screen\.findByText\("Committee review inbox"([^\n;]*)/g)];

    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query[1]).toBe(", {}, { timeout: 8_000 })");
    }
  });
});
