// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRODUCT_JOBS } from "../src/features/operations/index.js";

const adapter = readFileSync(new URL("../src/features/operations/operationsAdapter.js", import.meta.url), "utf8");
const envelope = readFileSync(new URL("../src/features/operations/auditEnvelope.js", import.meta.url), "utf8");
const jobs = readFileSync(new URL("../src/features/operations/jobRegistry.js", import.meta.url), "utf8");

describe("CR-106/CR-107 donor rejections", () => {
  it("rejects the donor assumptions that conflict with current contracts", () => {
    expect(adapter).not.toContain("cron_runs");
    expect(envelope).not.toContain("ip_address");
    expect(jobs).not.toContain("compute-scores");
    expect(PRODUCT_JOBS.some((job) => job.jobName === "pgcron-health")).toBe(false);
  });
});
