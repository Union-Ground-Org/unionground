// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pg from "pg";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";
import {
  MANUAL_ONLY_DB_GATES,
  MANUAL_ONLY_DB_PROOF_FILES,
  PROOF_FILES,
  NAMED_PROOF_FILES,
  PIPELINE_PROOF_CASES,
  PIPELINE_PROOF_FILE,
  PRISTINE_DB_PROOF_FLOOR,
  REQUIRED_DB_PROOF_FILE_FLOOR,
  REQUIRED_DB_PROOF_FLOOR,
  discoverRequiredDbProofFiles,
  assertDisposableProofUrl,
  assertDisposableStorageStatus,
  assessRequiredDbProofReport,
  collectRequiredDbProofCases,
  requiredDbProofFlagEnv,
  requiredDbProofPlan,
  relatedDbProofPlan,
  requiredDbProofVitestArgs,
  PRISTINE_DB_PROOFS,
  runRequiredDbProofPhases,
  DB_PROOF_SHARDS_FOR_WHOLE_PLAN,
  DB_PROOF_HOME_SHARDS,
  DB_PROOF_SHARD_WEIGHT_SECONDS,
  dbProofChangeNeedsWholePlan,
  dbProofShardCount,
  dbProofShardOf,
  partitionDbProofFiles,
  requiredDbProofPhases,
  requiredDbProofShard,
  shardDbProofPlan,
} from "../scripts/run-required-db-proofs.mjs";
import { dbProofShardMatrix } from "../scripts/db-proof-shard-count.mjs";

const runnerSource = readFileSync(
  new URL("../scripts/run-required-db-proofs.mjs", import.meta.url),
  "utf8",
);

describe("schema-wide DB proof selection", () => {
  const provisioned = { PRIVATE_FILE_PIPELINE_SCANNER_DIR: "/tmp/collection-only", PRIVATE_FILE_PIPELINE_CLAMD_PORT: "1" };
  const unrelated = {
    readText: () => "",
    collect: ({ files }) => ({ total: files.length, byFile: Object.fromEntries(files.map(file => [file, 1])) }),
  };

  it.each([
    "supabase/migrations/20990101000000_schema_change.sql",
    "scripts/db-contract.json",
  ])("keeps the whole plan and both schema invariants for a change only to %s", (file) => {
    for (const env of [{}, provisioned]) {
      const plan = requiredDbProofPlan(env);
      const selected = relatedDbProofPlan(plan, [file], unrelated);
      expect(selected.files).toContain("tests/account-lifecycle-manifest-db.test.js");
      expect(selected.files).toContain("tests/native-push-dispatch-session-db.test.js");
      expect(selected).toEqual({ ...plan, scope: "full", changed: 1 });
    }
  });

  it("keeps the whole plan for every discovered, named, manual-only or new DB proof", () => {
    const plan = requiredDbProofPlan(provisioned);
    for (const file of [...PROOF_FILES, ...Object.keys(MANUAL_ONLY_DB_PROOF_FILES), "tests/new-proof-db.test.js", "tests/new-proof-db.test.jsx"]) {
      expect(relatedDbProofPlan(plan, [file], unrelated), file).toEqual({ ...plan, scope: "full", changed: 1 });
    }
  });

  it("still selects related proofs for other changes", () => {
    const plan = requiredDbProofPlan(provisioned);
    const selected = relatedDbProofPlan(plan, ["scripts/unrelated.mjs"], unrelated);
    expect(selected.scope).toBe("related");
    expect(selected.files).toEqual(plan.files.filter(file => PRISTINE_DB_PROOFS.includes(file) || file === PIPELINE_PROOF_FILE));
    expect(selected.floor).toBe(PRISTINE_DB_PROOF_FLOOR + 1);
  });
});

describe("required disposable DB proof runner", () => {
  // (pipeline loosening, wave 5):
  // the proof files are discovered by name, and two fixed floors measured that
  // day keep a proof from disappearing: 274 files and 2,581 cases.
  it("discovers every -db proof file by name and keeps the fixed floors", () => {
    const allFiles = requiredDbProofPlan({ PRIVATE_FILE_PIPELINE_SCANNER_DIR: "/tmp/collection-only", PRIVATE_FILE_PIPELINE_CLAMD_PORT: "1" }).files;
    expect(allFiles).toEqual([...PROOF_FILES]);
    expect(new Set(allFiles).size).toBe(allFiles.length);
    expect(allFiles.length).toBeGreaterThanOrEqual(REQUIRED_DB_PROOF_FILE_FLOOR);
    expect(REQUIRED_DB_PROOF_FILE_FLOOR).toBe(276);
    expect(REQUIRED_DB_PROOF_FLOOR).toBe(2600);
    expect(allFiles).toEqual([...allFiles].sort());
    for (const file of NAMED_PROOF_FILES) expect(allFiles).toContain(file);
    for (const file of Object.keys(MANUAL_ONLY_DB_PROOF_FILES)) expect(allFiles).not.toContain(file);
    expect(() => requiredDbProofPlan({}, allFiles.slice(0, REQUIRED_DB_PROOF_FILE_FLOOR - 1))).toThrow(new RegExp(`at least ${REQUIRED_DB_PROOF_FILE_FLOOR} required DB proof files, discovered ${REQUIRED_DB_PROOF_FILE_FLOOR - 1}`));
    expect(discoverRequiredDbProofFiles("/nonexistent-repository-root")).toEqual([...NAMED_PROOF_FILES].sort());
    expect(() => assessRequiredDbProofReport({
      numTotalTests: REQUIRED_DB_PROOF_FLOOR - 10,
      numPassedTests: REQUIRED_DB_PROOF_FLOOR - 10,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
    })).toThrow(new RegExp(`expected at least ${REQUIRED_DB_PROOF_FLOOR}`, "i"));
  });

  it("serializes proof files that mutate one shared disposable schema", () => {
    expect(runnerSource).toContain('"--maxWorkers=1"');
  });

  it("accepts a complete green run with no skipped proofs", () => {
    expect(assessRequiredDbProofReport({
      numTotalTests: REQUIRED_DB_PROOF_FLOOR,
      numPassedTests: REQUIRED_DB_PROOF_FLOOR,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
    })).toEqual({ passed: REQUIRED_DB_PROOF_FLOOR, total: REQUIRED_DB_PROOF_FLOOR });
  });

  it("rejects skipped, missing, or failed proofs", () => {
    expect(() => assessRequiredDbProofReport({
      numTotalTests: REQUIRED_DB_PROOF_FLOOR,
      numPassedTests: REQUIRED_DB_PROOF_FLOOR - 1,
      numFailedTests: 0,
      numPendingTests: 1,
      numTodoTests: 0,
    })).toThrow(/skipped or pending/i);
    expect(() => assessRequiredDbProofReport({
      numTotalTests: REQUIRED_DB_PROOF_FLOOR - 1,
      numPassedTests: REQUIRED_DB_PROOF_FLOOR - 1,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
    })).toThrow(new RegExp(`expected at least ${REQUIRED_DB_PROOF_FLOOR}`, "i"));
    expect(() => assessRequiredDbProofReport({
      numTotalTests: REQUIRED_DB_PROOF_FLOOR,
      numPassedTests: REQUIRED_DB_PROOF_FLOOR - 1,
      numFailedTests: 1,
      numPendingTests: 0,
      numTodoTests: 0,
    })).toThrow(/failed/i);
  });

  it("serializes outer proof files while preserving in-file concurrency", () => {
    const args = requiredDbProofVitestArgs("/tmp/required-db-proof.json");
    expect(args).toContain("--maxWorkers=1");
    expect(args).toContain("tests/cba-ingestion-reconciliation-db.test.js");
    expect(args).toContain("tests/db-boundary-tenancy-db.test.js");
    expect(args).toContain("tests/g5-attachment-removal-oracle-db.test.js");
    expect(args).toContain("tests/g5-native-push-session-lineage-db.test.js");
    expect(args).toContain("tests/database-assurance-db.test.js");
    expect(args).toContain("tests/private-file-authorization-db.test.js");
    expect(args).toContain("tests/private-file-workflow-gates-db.test.js");
    expect(args).toContain("tests/private-file-quarantine-db.test.js");
    expect(args).toContain("tests/private-file-storage-operations-db.test.js");
    expect(args).toContain("tests/private-file-pipeline-db.test.js");
    expect(args).toContain("tests/chapter-post-referential-maintenance-db.test.js");
    expect(args).toContain("tests/private-space-membership-db.test.js");
    expect(args).toContain("tests/message-preservation-db.test.js");
    expect(args).toContain("tests/member-invitation-rate-limit-db.test.js");
    expect(args).toContain("tests/sensitive-content-db.test.js");
    expect(args).toContain("tests/sensitive-rollout-db.test.js");
    expect(args).toContain("tests/cron-job-health-sync-db.test.js");
    expect(args).toContain("tests/steward-desk-scale-latency-db.test.js");
    expect(args).toContain("tests/connected-automation-v2-db.test.js");
    expect(args).toContain("tests/pg-net-tick-request-id-db.test.js");
    expect(args).toContain("tests/case-attachment-lifecycle-restriction-gate-db.test.js");
    expect(args).toContain("tests/case-child-row-restriction-gate-db.test.js");
    expect(args).toContain("tests/coordinator-case-write-restriction-gate-db.test.js");
    expect(args).toContain("tests/chapter-verification-identity-db.test.js");
    expect(args).toContain("tests/case-history-db.test.js");
    expect(runnerSource).toContain('RUN_CASE_HISTORY_DB_TESTS: "1"');
    // TEST-UG-REQUIRED-DB-PROOF-RUNNER-OMITS-CASE-PROOFS-20260920: both
    // case proofs are planned, and the bulk-step gate is opened for collection
    // and execution alike (they share requiredDbProofFlagEnv).
    expect(args).toContain("tests/case-bulk-step-db.test.js");
    expect(args).toContain("tests/case-dashboard-aggregates-db.test.js");
    expect(requiredDbProofFlagEnv(requiredDbProofPlan({})).RUN_CASE_BULK_STEP_DB_TESTS).toBe("1");
    expect(args).toContain("tests/casework-audit-reader-kinds-db.test.js");
    expect(args).toContain("tests/survey-publish-atomicity-db.test.js");
    expect(runnerSource).toContain('RUN_SURVEY_PUBLISH_ATOMICITY_DB_TESTS: "1"');
    expect(args).toContain("tests/membership-card-single-use-db.test.js");
    expect(runnerSource).toContain('RUN_PRIVATE_FILE_AUTHORIZATION_DB_TESTS: "1"');
    expect(runnerSource).toContain('RUN_PRIVATE_FILE_WORKFLOW_GATE_DB_TESTS: "1"');
    expect(runnerSource).toContain('RUN_PRIVATE_FILE_STORAGE_DB_TESTS: "1"');
    expect(runnerSource).toContain('RUN_PRIVATE_FILE_PIPELINE_DB_TESTS: "1"');
    expect(runnerSource).toContain('RUN_CHAPTER_VERIFICATION_IDENTITY_DB_TESTS: "1"');
    expect(runnerSource).toContain('PRIVATE_FILE_PIPELINE_DISPOSABLE_CONFIRM: "reset-after-proof"');
    expect(runnerSource).toContain("PRIVATE_FILE_STORAGE_STATUS_FILE: storageStatusFile");
    expect(runnerSource).toContain('RUN_DATABASE_ASSURANCE_DB_TESTS: "1"');
    expect(runnerSource).toContain('RUN_CHAPTER_POST_REFERENTIAL_DB_TESTS: "1"');
    expect(runnerSource).toContain('RUN_PRIVATE_SPACE_MEMBERSHIP_DB_TESTS: "1"');
    expect(runnerSource).toContain('RUN_MEMBER_INVITATION_RATE_LIMIT_DB_TESTS: "1"');
    expect(runnerSource).toContain('RUN_CRON_JOB_HEALTH_SYNC_DB_TESTS: "1"');
    expect(runnerSource).toContain('RUN_STEWARD_DESK_SCALE_DB_TESTS: "1"');
    expect(runnerSource).toContain('RUN_MEMBERSHIP_CARD_NONCE_DB_TESTS: "1"');
    expect(args).toContain("tests/admin-mfa-reset-legal-hold-db.test.js");
    expect(runnerSource).toContain('RUN_ADMIN_MFA_LEGAL_HOLD_DB_TESTS: "1"');
    expect(args).toContain("tests/mfa-reset-pending-notice-db.test.js");
    expect(runnerSource).toContain('RUN_MFA_RESET_PENDING_NOTICE_DB_TESTS: "1"');
    expect(args).toContain("tests/dues-oauth-recovery-row-shape-db.test.js");
    expect(args).toContain("tests/dues-oauth-recovery-account-check-db.test.js");
    expect(args.at(-1)).toBe("--outputFile=/tmp/required-db-proof.json");
  });

  it("refuses a Storage status file that is not the owned disposable stack", () => {
    const databaseUrl = "postgresql://postgres:postgres@127.0.0.1:57312/postgres";
    const valid = { API_URL: "http://127.0.0.1:57311", ANON_KEY: "anon", SERVICE_ROLE_KEY: "service" };
    expect(assertDisposableStorageStatus(valid, databaseUrl)).toEqual(valid);
    expect(() => assertDisposableStorageStatus(
      { ...valid, API_URL: "https://project.supabase.co" }, databaseUrl,
    )).toThrow(/disposable loopback/i);
    expect(() => assertDisposableStorageStatus(
      { ...valid, API_URL: "http://127.0.0.1:54321" }, databaseUrl,
    )).toThrow(/disposable loopback/i);
    expect(() => assertDisposableStorageStatus(
      { API_URL: valid.API_URL, ANON_KEY: "anon" }, databaseUrl,
    )).toThrow(/SERVICE_ROLE_KEY/);
  });

  it("rejects URL routing overrides before a pg client can connect", () => {
    const safe = "postgresql://postgres:postgres@127.0.0.1:55362/postgres";
    expect(assertDisposableProofUrl(safe)).toBe(safe);
    const overriddenHost = `${safe}?host=not-local.example.invalid&port=5432`;
    const overriddenPort = `${safe}?port=54422`;
    // This examines node-postgres' effective parameters only; no connect is
    // attempted. It preserves the regression's actual remote/shared targets.
    expect(new pg.Client({ connectionString: overriddenHost }).connectionParameters)
      .toMatchObject({ host: "not-local.example.invalid", port: 5432 });
    expect(new pg.Client({ connectionString: overriddenPort }).connectionParameters)
      .toMatchObject({ host: "127.0.0.1", port: 54422 });
    for (const unsafe of [
      overriddenHost,
      overriddenPort,
      `${safe}?hostaddr=127.0.0.1`,
      "postgresql://postgres:postgres@%2Ftmp:55362/postgres",
    ]) expect(() => assertDisposableProofUrl(unsafe)).toThrow(/routing overrides|owned disposable loopback/i);
  });
});

describe("scanner-lane deferral", () => {
  const provisioned = { PRIVATE_FILE_PIPELINE_SCANNER_DIR: "/tmp/unionground-upload-adapter-proof-x", PRIVATE_FILE_PIPELINE_CLAMD_PORT: "64771" };

  it("requires the pipeline proof whenever the scanner lane is provisioned", () => {
    const plan = requiredDbProofPlan(provisioned);
    expect(plan.files).toContain(PIPELINE_PROOF_FILE);
    expect(plan.floor).toBe(REQUIRED_DB_PROOF_FLOOR);
    expect(plan.deferred).toEqual([]);
    expect(requiredDbProofVitestArgs("/tmp/r.json", plan.files)).toContain(PIPELINE_PROOF_FILE);
  });

  it("refuses to defer when the workflow revision demands the proof but the lane is missing", () => {
    expect(() => requiredDbProofPlan({ PRIVATE_FILE_SCANNER_PROOF_REQUIRED: "1" })).toThrow(/refusing to defer/i);
  });

  it("defers exactly the pipeline proof, loudly, only under a workflow revision that neither provisions nor demands it", () => {
    const plan = requiredDbProofPlan({});
    expect(plan.deferred).toEqual([PIPELINE_PROOF_FILE]);
    expect(plan.files).not.toContain(PIPELINE_PROOF_FILE);
    expect(plan.files.length).toBe(requiredDbProofPlan(provisioned).files.length - 1);
    expect(plan.floor).toBe(REQUIRED_DB_PROOF_FLOOR - PIPELINE_PROOF_CASES);
    expect(() => assessRequiredDbProofReport({ numTotalTests: plan.floor, numPassedTests: plan.floor, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 }, plan.floor)).not.toThrow();
    expect(() => assessRequiredDbProofReport({ numTotalTests: plan.floor - 1, numPassedTests: plan.floor - 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 }, plan.floor)).toThrow(/expected at least/i);
  });
});

// SYS-UG-DB-PROOF-FLOOR-RATCHET-LAG-20260919 required every file to
// collect exactly its hand-listed floor.
// (pipeline loosening, wave 5) replaced that per-file ratchet with a fixed
// minimum: cases above REQUIRED_DB_PROOF_FLOOR are allowed, and every planned
// file must collect at least one. `vitest list` runs no case and no hook, so
// this needs no database.

// One `vitest list` collection over all 245 planned proof files backs both
// bounds below. Measured October 21, 2026: about 70 s alone on the DGX Spark
// (20 cores) on both main 7882a262d and PR #15 41d6697bb, with vitest 4.1.11
// and 4.1.12 alike, so neither the code nor the vitest bump changes the work.
// On GitHub's 2-vCPU runner it shares the CPU with the full root suite: 87 s
// on main, 128 s and 139 s on PR #15, whose ports add 33 root test files and
// grow 44 more in that parallel load. The budget is headroom for that
// contention, not more collection work.
const PROOF_COLLECTION_TIMEOUT_MS = 240_000;

describe("executed proof-case count against the floor", () => {
  const configuredPlan = requiredDbProofPlan({ PRIVATE_FILE_PIPELINE_SCANNER_DIR: "/tmp/collection-only", PRIVATE_FILE_PIPELINE_CLAMD_PORT: "1" });
  const executedPlan = requiredDbProofPlan({});

  it("opens the scanner gate only for a plan that does not defer the pipeline proof", () => {
    expect(requiredDbProofFlagEnv(configuredPlan).RUN_PRIVATE_FILE_PIPELINE_DB_TESTS).toBe("1");
    expect(requiredDbProofFlagEnv(executedPlan)).not.toHaveProperty("RUN_PRIVATE_FILE_PIPELINE_DB_TESTS");
  });

  // A gate the runner forgets to open only empties a file whose every case is
  // gated. A file that mixes offline pins with gated live cases still collects
  // its pins, so the count alone would read low and look like a measurement.
  it("opens every RUN_*_DB_TESTS gate a planned proof file reads", () => {
    const open = requiredDbProofFlagEnv(configuredPlan);
    const unopened = configuredPlan.files.flatMap(file =>
      [...readFileSync(new URL(`../${file}`, import.meta.url), "utf8").matchAll(/process\.env\.(RUN_[A-Z0-9_]+_DB_TESTS)/g)]
        .filter(([, gate]) => open[gate] !== "1").map(([, gate]) => `${gate} <- ${file}`));
    expect([...new Set(unopened)], "requiredDbProofFlagEnv in scripts/run-required-db-proofs.mjs does not open these gates, so the collected count below is short").toEqual([]);
  });

  // One collection serves both bounds. Each bound prints its own instruction:
  // the measured numbers are something to copy only when cases were added.
  let measurement;
  const measure = () => {
    if (!measurement) {
      const collected = collectRequiredDbProofCases(configuredPlan);
      const configured = collected.total;
      const executed = configured - collected.byFile[PIPELINE_PROOF_FILE];
      measurement = {
        collected,
        configured,
        executed,
        report: instruction => [
          `measured at this head: ${configured} configured / ${executed} executed across ${executedPlan.files.length} files (scanner proof deferred: ${collected.byFile[PIPELINE_PROOF_FILE]} case in ${PIPELINE_PROOF_FILE})`,
          `floor constants: ${REQUIRED_DB_PROOF_FLOOR} configured / ${executedPlan.floor} executed`,
          instruction,
          `per file: ${Object.entries(collected.byFile).map(([file, count]) => `${count} ${file}`).join(", ")}`,
        ].join("\n"),
      };
    }
    return measurement;
  };

  // A collection below the floor is never a reason to lower the floor; the live
  // run refuses it too.
  it("collects every proof case the floor demands", () => {
    const { collected, configured, executed, report } = measure();
    const missing = report(`${Math.max(REQUIRED_DB_PROOF_FLOOR - configured, executedPlan.floor - executed)} case(s) are missing against the floor: a proof case disappeared (removed, or its RUN_* gate is closed). Restore it or open a reviewed record; do not lower REQUIRED_DB_PROOF_FLOOR to the measured number`);

    expect(Object.entries(collected.byFile).filter(([, count]) => count === 0).map(([file]) => file), missing).toEqual([]);
    expect(collected.byFile[PIPELINE_PROOF_FILE], missing).toBe(PIPELINE_PROOF_CASES);
    expect(executed - executedPlan.floor, missing).toBeGreaterThanOrEqual(0);
    expect(configured - REQUIRED_DB_PROOF_FLOOR, missing).toBeGreaterThanOrEqual(0);
  }, runnerTimeout(120_000));
});

// TEST-UG-RUN-DB-TEST-GATE-INVENTORY-GAP-20260920. The assertion above only
// sees the gates PROOF_FILES reads. A live suite the runner never plans can read
// a gate nothing opens and skip in every run forever, so this derives the whole
// inventory from the test tree -- never from a second hand-written list -- and
// requires each gate to be either opened by the runner or dispositioned in
// MANUAL_ONLY_DB_GATES. A new test reading an unknown gate fails here, and so
// does deleting a disposition for a gate that is still read.
describe("RUN_*_DB_TESTS gate inventory across the whole test tree", () => {
  const testsDir = new URL("./", import.meta.url);
  const readers = new Map();
  for (const name of readdirSync(testsDir).filter(entry => /\.test\.jsx?$/.test(entry))) {
    const source = readFileSync(new URL(name, testsDir), "utf8");
    for (const [, gate] of source.matchAll(/process\.env\.(RUN_[A-Z0-9_]+_DB_TESTS)/g)) {
      if (!readers.has(gate)) readers.set(gate, new Set());
      readers.get(gate).add(`tests/${name}`);
    }
  }
  const opened = requiredDbProofFlagEnv(requiredDbProofPlan({
    PRIVATE_FILE_PIPELINE_SCANNER_DIR: "/tmp/inventory-only", PRIVATE_FILE_PIPELINE_CLAMD_PORT: "1",
  }));

  it("reads at least the gates the required lane opens", () => {
    expect(readers.size).toBeGreaterThanOrEqual(Object.keys(opened).length);
  });

  it("gives every gate a test file reads either a runner lane or a documented manual-only disposition", () => {
    const undisposed = [...readers]
      .filter(([gate]) => opened[gate] !== "1" && !MANUAL_ONLY_DB_GATES[gate])
      .map(([gate, files]) => `${gate} <- ${[...files].sort().join(", ")}`);
    expect(undisposed.sort(),
      "these RUN_*_DB_TESTS gates are read by a test file but neither opened by requiredDbProofFlagEnv nor dispositioned in MANUAL_ONLY_DB_GATES (scripts/run-required-db-proofs.mjs); every case behind them is permanently skipped. Promote the file into PROOF_FILES and open its gate, or add a MANUAL_ONLY_DB_GATES entry stating why it stays manual and how it is run")
      .toEqual([]);
  });

  it("keeps every manual-only disposition live, reasoned, and out of the runner", () => {
    for (const [gate, reason] of Object.entries(MANUAL_ONLY_DB_GATES)) {
      expect(readers.has(gate), `MANUAL_ONLY_DB_GATES documents ${gate}, which no tests/*.test.js(x) file reads any more; delete the entry`).toBe(true);
      expect(opened[gate], `${gate} is both opened by requiredDbProofFlagEnv and dispositioned as manual-only; drop the MANUAL_ONLY_DB_GATES entry`).not.toBe("1");
      expect(reason.length, `MANUAL_ONLY_DB_GATES.${gate} needs a reason stating why the gate stays out of the required lane and how the suite is run instead`).toBeGreaterThan(40);
    }
  });
});

// TEST-UG-DB-PROOFS-UNWIRED-OR-UNDECLARED-20260920. The gate inventory
// above cannot see a proof gated only on SUPABASE_DB_URL or
// REQUIRE_DB_REPAIR_PROOFS, so the -db files themselves are inventoried too.
describe("database proof file inventory", () => {
  const dbFiles = readdirSync(new URL("./", import.meta.url))
    .filter(entry => /-db\.test\.jsx?$/.test(entry)).map(entry => `tests/${entry}`).sort();

  it("requires the real member invitation PostgREST case in the inventoried shared-fixture phase", () => {
    const file = "tests/member-invitation-postgrest-db.test.js";
    expect(dbFiles).toContain(file);
    expect(requiredDbProofPlan({}).files).toContain(file);
    expect(PRISTINE_DB_PROOFS).not.toContain(file);
    expect(MANUAL_ONLY_DB_PROOF_FILES).not.toHaveProperty(file);
  });

  it("plans every tests/*-db.test.js file or declares why it stays manual", () => {
    expect(dbFiles.filter(file => !PROOF_FILES.includes(file) && !MANUAL_ONLY_DB_PROOF_FILES[file]),
      "these -db proof files are neither planned by name discovery nor declared in MANUAL_ONLY_DB_PROOF_FILES (scripts/run-required-db-proofs.mjs), so they skip in every required lane").toEqual([]);
  });

  it("keeps every manual-only file declaration live, reasoned, and out of the plan", () => {
    for (const [file, reason] of Object.entries(MANUAL_ONLY_DB_PROOF_FILES)) {
      expect(dbFiles, `MANUAL_ONLY_DB_PROOF_FILES declares ${file}, which no longer exists; delete the entry`).toContain(file);
      expect(PROOF_FILES, `${file} is both planned and declared manual-only; delete the declaration`).not.toContain(file);
      expect(reason.length, `MANUAL_ONLY_DB_PROOF_FILES["${file}"] needs a reason and how it is run instead`).toBeGreaterThan(40);
    }
  });

  it("plans the case macro/mention and casework procedure proofs with their gates open", () => {
    expect(PROOF_FILES).toContain("tests/case-macros-mentions-db.test.js");
    expect(PROOF_FILES).toContain("tests/casework-procedures-db.test.js");
    expect(requiredDbProofFlagEnv(requiredDbProofPlan({})).RUN_CASE_MACRO_DB_TESTS).toBe("1");
    expect(MANUAL_ONLY_DB_GATES).not.toHaveProperty("RUN_CASE_MACRO_DB_TESTS");
  });

  // TEST-UG-DB-PROOFS-PROMOTE-REMAINING-MANUAL-SUITES-20260925: the three
  // -db files and two gated live halves the parent record's acceptance 4 left
  // manual are planned, their gates are opened, and none is still declared.
  it("plans the promoted audit-sink, dues OAuth audit, saved-view, export audit and live-poll scope proofs with their gates open", () => {
    const open = requiredDbProofFlagEnv(requiredDbProofPlan({}));
    for (const file of [
      "tests/audit-sinks-surfaced-db.test.js",
      "tests/dues-oauth-ready-connection-audit-db.test.js",
      "tests/member-saved-views-db.test.js",
      "tests/institutional-records.test.js",
      "tests/member-engagement-completion-migration.test.js",
    ]) {
      expect(PROOF_FILES).toContain(file);
      expect(MANUAL_ONLY_DB_PROOF_FILES).not.toHaveProperty(file);
    }
    for (const gate of ["RUN_MEMBER_SAVED_VIEWS_DB_TESTS", "RUN_INSTITUTIONAL_EXPORT_AUDIT_DB_TESTS", "RUN_LIVE_POLL_CHAPTER_SCOPE_DB_TESTS"]) {
      expect(open[gate]).toBe("1");
      expect(MANUAL_ONLY_DB_GATES).not.toHaveProperty(gate);
    }
  });

  // OPS-UG-RESTORE-THREE-HELD-MIGRATIONS-20261113: the proofs of
  // the three migrations restored from 4cf35d31b run in the required lane.
  it("plans the survey ancestor, sign-in refund and calendar cancellation proofs", () => {
    for (const file of [
      "tests/organization-survey-ancestor-postgres.test.js",
      "tests/password-signin-success-refund-postgres.test.js",
      "tests/calendar-feed-cancellation-db.test.js",
    ]) {
      expect(PROOF_FILES).toContain(file);
      expect(MANUAL_ONLY_DB_PROOF_FILES).not.toHaveProperty(file);
    }
    expect(requiredDbProofFlagEnv(requiredDbProofPlan({})).RUN_CALENDAR_FEED_CANCELLATION_DB_TESTS).toBe("1");
  });
});

describe("pristine bootstrap proof sequencing", () => {
  const plan = requiredDbProofPlan({});
  const pristine = ["tests/connected-automation-v2-db.test.js", "tests/case-dashboard-aggregates-db.test.js", "tests/physical-db-baseline-retirement-window-db.test.js"];
  const reportFor = (phase) => ({
    numTotalTests: phase.floor, numPassedTests: phase.floor,
    numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    testResults: phase.files.map(name => ({ name })),
  });

  it("finishes the pristine proof before committed fixture suites and retains the entire inventory", () => {
    let organizations = 0;
    const seen = [];
    const result = runRequiredDbProofPhases(plan, phase => {
      if (seen.length === 0) {
        expect(organizations).toBe(0);
        // Bootstrap needs no organizations; the retirement-window verifier
        // needs no documents left by earlier committed fixture suites.
        expect(PRISTINE_DB_PROOFS).toEqual(pristine);
        expect(phase.files).toEqual(pristine);
        expect(phase.floor).toBe(PRISTINE_DB_PROOF_FLOOR);
        expect(PRISTINE_DB_PROOF_FLOOR).toBe(8);
      } else {
        expect(seen).toEqual(pristine);
        organizations += 1; // Later concurrency proofs commit their fixtures.
        for (const file of pristine) expect(phase.files).not.toContain(file);
      }
      seen.push(...phase.files);
      return { status: 0, report: reportFor(phase) };
    });
    expect([...seen].sort()).toEqual([...plan.files].sort());
    expect(seen).toHaveLength(plan.files.length);
    expect(result).toEqual({ passed: plan.floor, total: plan.floor });
  });

  for (const failure of ["exit", "missing-report", "skip", "missing-test", "duplicate-file", "missing-file"]) {
    it(`stops before fixture suites after a pristine phase ${failure}`, () => {
      let calls = 0;
      expect(() => runRequiredDbProofPhases(plan, phase => {
        calls += 1;
        const report = reportFor(phase);
        if (failure === "skip") report.numPendingTests = 1;
        if (failure === "missing-test") report.numTotalTests = report.numPassedTests = 0;
        if (failure === "duplicate-file") report.testResults.push(report.testResults[0]);
        if (failure === "missing-file") report.testResults = [];
        return { status: failure === "exit" ? 1 : 0, report: failure === "missing-report" ? null : report };
      })).toThrow();
      expect(calls).toBe(1);
    });
  }

  it("rejects failure in the later phase even after bootstrap succeeds", () => {
    let calls = 0;
    expect(() => runRequiredDbProofPhases(plan, phase => {
      calls += 1;
      return { status: calls === 2 ? 1 : 0, report: reportFor(phase) };
    })).toThrow(/process exited 1/);
    expect(calls).toBe(2);
  });
});

describe("required DB proofs split across parallel jobs", () => {
  const plan = requiredDbProofPlan({ PRIVATE_FILE_PIPELINE_SCANNER_DIR: "/tmp/collection-only", PRIVATE_FILE_PIPELINE_CLAMD_PORT: "1" });
  const casesPerFile = Math.ceil(REQUIRED_DB_PROOF_FLOOR / plan.files.length);
  const collect = ({ files }) => ({ total: files.length * casesPerFile, byFile: Object.fromEntries(files.map(file => [file, casesPerFile])) });
  const reportFor = (phase) => ({
    numTotalTests: phase.files.length * casesPerFile, numPassedTests: phase.files.length * casesPerFile,
    numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    testResults: phase.files.map(name => ({ name })),
  });

  it("keeps one unsharded job unless the workflow names a shard", () => {
    expect(requiredDbProofShard({})).toEqual({ index: 0, count: 1 });
    expect(requiredDbProofShard({ REQUIRED_DB_PROOF_SHARD: "2", REQUIRED_DB_PROOF_SHARDS: "4" })).toEqual({ index: 2, count: 4 });
    for (const env of [
      { REQUIRED_DB_PROOF_SHARD: "4", REQUIRED_DB_PROOF_SHARDS: "4" },
      { REQUIRED_DB_PROOF_SHARD: "0" },
      { REQUIRED_DB_PROOF_SHARDS: "4" },
      { REQUIRED_DB_PROOF_SHARD: "-1", REQUIRED_DB_PROOF_SHARDS: "4" },
      { REQUIRED_DB_PROOF_SHARD: "0", REQUIRED_DB_PROOF_SHARDS: "9" },
      { REQUIRED_DB_PROOF_SHARD: "0", REQUIRED_DB_PROOF_SHARDS: "0" },
    ]) expect(() => requiredDbProofShard(env)).toThrow(/must name shard/);
    expect(shardDbProofPlan(plan, { index: 0, count: 1 }, () => { throw new Error("no collection for one job"); })).toBe(plan);
  });

  it.each([2, 3, 4, 8])("places every planned file in exactly one of %i shards, deterministically", (count) => {
    const shards = partitionDbProofFiles(plan.files, count);
    expect(shards).toHaveLength(count);
    expect(shards.flat().sort()).toEqual([...plan.files].sort());
    expect(new Set(shards.flat()).size).toBe(plan.files.length);
    for (const shard of shards) {
      expect(shard.length).toBeGreaterThan(0);
      expect(shard).toEqual(plan.files.filter(file => shard.includes(file)));
    }
    expect(partitionDbProofFiles([...plan.files], count)).toEqual(shards);
    for (const file of [...PRISTINE_DB_PROOFS, PIPELINE_PROOF_FILE]) expect(shards[0]).toContain(file);
    for (const shard of shards.slice(1)) for (const file of PRISTINE_DB_PROOFS) expect(shard).not.toContain(file);
  });

  // A database proof job runs only its share of the files, so a proof cannot
  // borrow a tenant row some earlier proof happened to commit: run 42960360403
  // put tests/notification-copy-key-db.test.js, which read "the first chapter",
  // in a job with no committed chapter (OPS-UG-DB-PROOF-SHARD-HIDDEN-CHAPTER-DEPENDENCY-20261111).
  // A proof creates its own organization, chapter, profile or user, or
  // scopes the read to rows it created.
  it("lets no planned proof read an arbitrary existing tenant row it did not create", () => {
    const unscoped = /from\s+(public\.(?:chapters|organizations|member_profiles|organization_memberships)|auth\.users)\b([^"'`;]*?)\blimit\s+1\b/gi;
    const offenders = plan.files.flatMap((file) => [...readFileSync(new URL(`../${file}`, import.meta.url), "utf8").matchAll(unscoped)]
      .filter((match) => !/\bwhere\b/i.test(match[2]))
      .map((match) => `${file}: ${match[0]}`));
    expect(offenders).toEqual([]);
    expect([..."select id from public.chapters order by id limit 1".matchAll(unscoped)].filter((match) => !/\bwhere\b/i.test(match[2]))).toHaveLength(1);
  });

  it("weights only files that are planned, and spreads the heaviest ones apart", () => {
    for (const file of Object.keys(DB_PROOF_SHARD_WEIGHT_SECONDS)) expect(plan.files).toContain(file);
    expect(Object.keys(DB_PROOF_HOME_SHARDS).sort()).toEqual(Object.keys(DB_PROOF_SHARD_WEIGHT_SECONDS).sort());
    const shards = partitionDbProofFiles(plan.files, DB_PROOF_SHARDS_FOR_WHOLE_PLAN);
    const heaviest = Object.entries(DB_PROOF_SHARD_WEIGHT_SECONDS).sort(([, a], [, b]) => b - a).slice(0, 3).map(([file]) => file);
    expect(new Set(heaviest.map(file => shards.findIndex(shard => shard.includes(file)))).size).toBe(3);
    // Homes are shards one to three on the whole-plan matrix, never shard
    // zero, which runs the pristine phase and the assurance steps.
    for (const [file, home] of Object.entries(DB_PROOF_HOME_SHARDS)) {
      expect(home).toBeGreaterThanOrEqual(1);
      expect(home).toBeLessThan(DB_PROOF_SHARDS_FOR_WHOLE_PLAN);
      expect(shards[home]).toContain(file);
    }
  });

  // OPS-UG-DB-PROOF-SHARD-STABLE-PLACEMENT-20261113 (G109): the greedy
  // placement moved existing proofs whenever one was added, so a hidden
  // dependency between two proofs  could surface on an unrelated pull
  // request. A file's shard now depends on that file alone.
  it.each([2, 3, 4, 8])("moves no planned file when a proof is added or removed among %i shards", (count) => {
    const shardOfAll = (files) => new Map(partitionDbProofFiles(files, count).flatMap((shard, index) => shard.map(file => [file, index])));
    const before = shardOfAll(plan.files);
    for (const added of ["tests/aaa-first-new-proof-db.test.js", "tests/mmm-new-proof-db.test.js", "tests/zzz-last-new-proof-db.test.js"]) {
      for (const at of [0, Math.floor(plan.files.length / 2), plan.files.length]) {
        const after = shardOfAll([...plan.files.slice(0, at), added, ...plan.files.slice(at)]);
        for (const file of plan.files) expect(after.get(file), `${added}@${at}: ${file}`).toBe(before.get(file));
        expect(after.get(added)).toBe(dbProofShardOf(added, count));
      }
    }
    for (const removed of plan.files.filter(file => !PRISTINE_DB_PROOFS.includes(file)).slice(0, 5)) {
      const after = shardOfAll(plan.files.filter(file => file !== removed));
      for (const file of plan.files) if (file !== removed) expect(after.get(file), `-${removed}: ${file}`).toBe(before.get(file));
    }
    // One file alone decides its shard; one job keeps everything.
    for (const file of plan.files) {
      expect(dbProofShardOf(file, count)).toBe(before.get(file));
      expect(dbProofShardOf(file, 1)).toBe(0);
    }
  });

  it("checks the fixed floor on the whole plan and gives each shard the cases its files collect", () => {
    const parts = Array.from({ length: 4 }, (_, index) => shardDbProofPlan(plan, { index, count: 4 }, collect));
    expect(parts.flatMap(part => part.files).sort()).toEqual([...plan.files].sort());
    expect(parts.reduce((sum, part) => sum + part.floor, 0)).toBeGreaterThanOrEqual(REQUIRED_DB_PROOF_FLOOR);
    expect(new Set(parts.map(part => part.shard.plan_digest)).size).toBe(1);
    for (const part of parts) {
      expect(part.floor).toBe(part.files.length * casesPerFile);
      expect(part.shard).toMatchObject({ count: 4, planned_files: plan.files.length, planned_floor: plan.floor });
    }
    expect(() => shardDbProofPlan(plan, { index: 1, count: 4 }, ({ files }) => ({ total: files.length, byFile: Object.fromEntries(files.map(file => [file, 1])) })))
      .toThrow(/across every shard/);
    expect(() => shardDbProofPlan(plan, { index: 1, count: 4 }, ({ files }) => ({ ...collect({ files }), byFile: { ...collect({ files }).byFile, [files[5]]: 0 } })))
      .toThrow(/collected no case/);
  });

  it("runs the pristine phase only on shard 0 and every shard's files exactly once", () => {
    const seen = [];
    for (let index = 0; index < 4; index += 1) {
      const part = shardDbProofPlan(plan, { index, count: 4 }, collect);
      expect(requiredDbProofPhases(part).map(phase => phase.name)).toEqual(index === 0 ? ["pristine-bootstrap", "shared-fixtures"] : ["shared-fixtures"]);
      const result = runRequiredDbProofPhases(part, phase => {
        seen.push(...phase.files);
        return { status: 0, report: reportFor(phase) };
      });
      expect(result.total).toBeGreaterThanOrEqual(part.floor);
    }
    expect(seen.sort()).toEqual([...plan.files].sort());
    const later = shardDbProofPlan(plan, { index: 1, count: 4 }, collect);
    expect(() => runRequiredDbProofPhases({ ...later, files: [...later.files, PRISTINE_DB_PROOFS[0]] }, () => ({ status: 0, report: null })))
      .toThrow(/exactly once/);
    expect(() => runRequiredDbProofPhases({ ...later, files: later.files.slice(1) }, phase => ({ status: 0, report: reportFor({ ...phase, files: later.files }) })))
      .toThrow(/inventory mismatch/);
    expect(runRequiredDbProofPhases({ ...later, files: [], floor: 0 }, () => { throw new Error("no phase for an empty shard"); }))
      .toEqual({ passed: 0, total: 0 });
  });

  it("sizes a whole plan at four jobs and a related pull-request plan at one", () => {
    expect(dbProofShardCount("merge_group", [])).toBe(4);
    expect(dbProofShardCount("push", ["src/App.jsx"])).toBe(4);
    expect(dbProofShardCount("pull_request", ["supabase/migrations/20261110000000_x.sql"])).toBe(4);
    expect(dbProofShardCount("pull_request", ["scripts/run-required-db-proofs.mjs"])).toBe(4);
    expect(dbProofShardCount("pull_request", ["src/App.jsx"])).toBe(1);
  });

  it("gives every whole plan four jobs and a related pull-request plan one", () => {
    // A change to the sizing script plans every proof (rollout stage 2's canary run).
    expect(dbProofChangeNeedsWholePlan(["scripts/db-proof-shard-count.mjs"])).toBe(true);
    for (const [event, changed] of [
      ["merge_group", []],
      ["push", ["src/App.jsx"]],
      ["pull_request", ["scripts/db-proof-shard-count.mjs"]],
      ["pull_request", ["supabase/migrations/20261110000000_x.sql"]],
    ]) expect(dbProofShardMatrix(event, changed), `${event} ${changed.join(",")}`).toBe("[0,1,2,3]");
    expect(dbProofShardMatrix("pull_request", ["src/App.jsx"])).toBe("[0]");
  });
});
