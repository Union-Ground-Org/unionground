// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { databaseLaneSelected, isDatabaseInput } from "../scripts/ci-db-scope.mjs";
import { prepareTargets } from "../scripts/prepare-ci-disposable-db.mjs";
import { PROOF_FILES } from "../scripts/run-required-db-proofs.mjs";

// When ci.yml's db lane runs (docs/contracts/ci.md), and which lab it runs in.

describe("database lane scope", () => {
  it("selects the lane for every input of the replay and the proofs", () => {
    for (const path of [
      ".github/workflows/ci.yml",
      "supabase/config.toml",
      "supabase/migrations/20261018060200_example.sql",
      "scripts/db-contract.json",
      "config/database-assurance-baseline.json",
      "api/private-files.js",
      "api/_lib/privateFileScanner.js",
      "tests/helpers/sensitive-rollout-stack.mjs",
      "tests/a-new-proof-db.test.js",
      "scripts/run-required-db-proofs.mjs",
      "scripts/prepare-ci-disposable-db.mjs",
      "scripts/start-disposable-db-stack.mjs",
      "scripts/start-sensitive-proof-stack.mjs",
      "scripts/verify-db-contract.mjs",
      "scripts/verify-migration-history.mjs",
      "scripts/prepare-private-file-scanner-proof.mjs",
      "scripts/lib/assert-exact-target.mjs",
      // The baseline the lane restores, and its offline tests.
      "scripts/physical-db-baseline.mjs",
      "scripts/fetch-physical-db-baseline.mjs",
      "scripts/lib/physical-db-baseline.mjs",
      "tests/physical-db-baseline.test.js",
    ]) expect(isDatabaseInput(path), path).toBe(true);
  });

  it("selects it for every planned proof file", () => {
    for (const file of PROOF_FILES) expect(isDatabaseInput(file), file).toBe(true);
  });

  it("leaves it out for changes that cannot alter what it proves", () => {
    for (const path of ["src/App.jsx", "README.md", "package.json", "package-lock.json", "apps/mobile/app.json", "tests/ci-workflow.test.js", ".github/workflows/dependency-audit-daily.yml",
      // The snapshot producer proves its own changes in its pull-request run.
      ".github/workflows/disposable-db-baseline.yml", ".github/actions/physical-db-baseline/action.yml"]) {
      expect(isDatabaseInput(path), path).toBe(false);
    }
  });

  // The snapshot builder rebuilds on these; every one but the builder's own
  // workflow and action also changes what a pull request restores or proves,
  // so it runs the lane too (the builder's own pull-request run proves those).
  it("selects it for every input the snapshot builder rebuilds on, except the builder's workflow and action", () => {
    const producer = parse(readFileSync(new URL("../.github/workflows/disposable-db-baseline.yml", import.meta.url), "utf8"));
    const inputs = producer.on.push.paths.filter((path) => !path.startsWith(".github/"));
    expect(inputs).toEqual(expect.arrayContaining(["scripts/fetch-physical-db-baseline.mjs", "scripts/physical-db-baseline.mjs"]));
    for (const path of inputs) expect(isDatabaseInput(path.replace("/**", "/migrations/20261112000000_example.sql")), path).toBe(true);
  });

  it("reads git's NUL-separated list and selects the lane when there is none", () => {
    expect(databaseLaneSelected("src/App.jsx\0README.md\0")).toBe(false);
    expect(databaseLaneSelected("src/App.jsx\0supabase/migrations/x.sql\0")).toBe(true);
    expect(databaseLaneSelected("")).toBe(false);
    expect(databaseLaneSelected(null)).toBe(true);
  });
});

describe("disposable CI labs", () => {
  it("keeps a first push unresolved even if origin/main is available", async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-db-scope-"));
    vi.stubEnv("CI_BASE_SHA", "");
    try {
      const target = await prepareTargets({ tempRoot: root, runKey: "first-push" });
      expect(target.CI_DB_GRANT_PROBE).toBe("unresolved");
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("are unionground-lab-ci projects on distinct loopback port blocks", async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-db-scope-"));
    try {
      const targets = await prepareTargets({ tempRoot: root, runKey: "ci-db-scope-test", sensitiveProofTarget: true });
      for (const prefix of ["", "SENSITIVE_PROOF_"]) {
        const project = targets[`${prefix}CI_DB_PROJECT_ID`];
        expect(project).toMatch(/^unionground-lab-ci-[a-f0-9]{12}$/);
        // scripts/verify-unionground-db.mjs accepts only lab containers.
        expect(`supabase_db_${project}`).toMatch(/^supabase_db_unionground-lab-[a-z0-9-]+$/i);
        expect(targets[`${prefix}CI_DB_WORKDIR`].startsWith(join(root, "unionground-lab-ci-"))).toBe(true);
        const url = new URL(targets[`${prefix}SUPABASE_DB_URL`]);
        expect(url.hostname).toBe("127.0.0.1");
        expect(Number(url.port)).toBeGreaterThanOrEqual(55000);
        expect(Number(url.port)).toBeLessThanOrEqual(59999);
      }
      expect(targets.CI_DB_BASE_PORT).not.toBe(targets.SENSITIVE_PROOF_CI_DB_BASE_PORT);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
