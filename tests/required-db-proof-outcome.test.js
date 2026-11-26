// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequiredDbProofOutcome, MAX_REQUIRED_PROOF_OUTCOME_BYTES } from "../scripts/lib/required-db-proof-outcome.mjs";
import { PRISTINE_DB_PROOF_FLOOR, PRISTINE_DB_PROOFS, PROOF_FILES, REQUIRED_DB_PROOF_FLOOR } from "../scripts/run-required-db-proofs.mjs";

// The fake producer reports exactly the configured floor (scanner lane
// provisioned) or the deferred floor (one proof fewer), so this retention
// test follows REQUIRED_DB_PROOF_FLOOR instead of pinning a stale number.
const FLOOR = REQUIRED_DB_PROOF_FLOOR;
// The pristine phase's floor: the proofs that must run before any fixture commits.
const PRISTINE_FLOOR = PRISTINE_DB_PROOF_FLOOR;

const scratch = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

// An isolated subprocess exercises the real runner's error and finally paths.
// Its fake Vitest producer never connects to a database; these artifacts test
// retention only and are not database acceptance evidence.
function runFixture(mode, extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "required-outcome-test-"));
  scratch.push(root);
  for (const file of ["scripts/run-required-db-proofs.mjs", "scripts/lib/required-db-proof-outcome.mjs"]) {
    const destination = join(root, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(new URL(`../${file}`, import.meta.url), destination);
  }
  // The runner discovers its proof files by name, so the fixture carries empty
  // stand-ins for every planned file; the fake Vitest below never reads them.
  for (const file of PROOF_FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  mkdirSync(join(root, "node_modules/vitest"), { recursive: true });
  writeFileSync(join(root, "node_modules/vitest/vitest.mjs"), `
    import { writeFileSync } from 'node:fs';
    const files = process.argv.filter(arg => arg.startsWith('tests/'));
    const path = process.argv.find(arg => arg.startsWith('--outputFile=')).slice(13);
    writeFileSync(process.env.PHASE_PATH_LOG, path);
    const bootstrap = files.includes(${JSON.stringify(PRISTINE_DB_PROOFS[0])});
    const mode = process.env.FIXTURE_MODE;
    const failed = mode === 'bootstrap-fail' || (!bootstrap && ['shared-fail', 'scanner-pending'].includes(mode));
    // Shared-phase total: the pristine phase already reported its own floor.
    const total = bootstrap ? ${PRISTINE_FLOOR} : process.env.PRIVATE_FILE_PIPELINE_SCANNER_DIR ? ${FLOOR - PRISTINE_FLOOR} : ${FLOOR - 1 - PRISTINE_FLOOR};
    const secret = 'postgresql://fixture_user:do-not-retain-this-password@127.0.0.1:55322/postgres';
    const pending = !bootstrap && mode === 'scanner-pending';
    const testResults = files.map((name, index) => {
      const amount = index === files.length - 1 ? total - files.length + 1 : 1;
      return { name, message: secret, assertionResults: Array.from({length: amount}, (_, assertionIndex) => ({
        title: secret, fullName: secret, ancestorTitles: [secret],
        status: pending && name.includes('private-file-pipeline-') ? 'pending' : failed && index === files.length - 1 && assertionIndex === 0 ? 'failed' : 'passed',
        duration: 12345.67, failureMessages: [secret], unknownCredential: secret,
      })) };
    });
    const report = { numTotalTests: total, numPassedTests: total - Number(failed) - Number(pending),
      numFailedTests: Number(failed), numPendingTests: Number(pending), numTodoTests: 0, testResults, secret };
    if (mode !== 'missing-report') writeFileSync(path, mode === 'malformed' ? secret : JSON.stringify(report));
    process.stdout.write(secret);
    process.stderr.write(secret);
    process.exit(failed ? 1 : 0);
  `);
  const statusPath = join(root, "status.json");
  writeFileSync(statusPath, JSON.stringify({ API_URL: "http://127.0.0.1:55321", ANON_KEY: "private-anon-key", SERVICE_ROLE_KEY: "private-service-role-key" }));
  const privateTmp = join(root, "private-tmp");
  mkdirSync(privateTmp);
  const env = {
    PATH: process.env.PATH,
    TMPDIR: privateTmp,
    RUNNER_TEMP: join(root, "runner-temp"),
    REQUIRE_DB_REPAIR_PROOFS: "1",
    SUPABASE_DB_URL: "postgresql://fixture_user:do-not-retain-this-password@127.0.0.1:55322/postgres",
    PRIVATE_FILE_STORAGE_STATUS_FILE: statusPath,
    PHASE_PATH_LOG: join(root, "phase-path"),
    FIXTURE_MODE: mode,
    CI_HEAD_SHA: "a".repeat(40), GITHUB_RUN_ID: "34506792941", GITHUB_RUN_ATTEMPT: "1",
    ...extraEnv,
  };
  const git = args => spawnSync("git", args, { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } });
  expect(git(["init", "--quiet"]).status).toBe(0);
  expect(git(["add", "scripts"]).status).toBe(0);
  expect(git(["-c", "user.name=Retention fixture", "-c", "user.email=retention@example.invalid", "commit", "--quiet", "-m", "Retention fixture source"]).status).toBe(0);
  const sourceSha = git(["rev-parse", "HEAD"]).stdout.trim();
  const result = spawnSync(process.execPath, [join(root, "scripts/run-required-db-proofs.mjs")], { cwd: root, env, encoding: "utf8" });
  const path = join(env.RUNNER_TEMP, "database-assurance/database-assurance.json");
  expect(existsSync(path)).toBe(true);
  const bytes = readFileSync(path, "utf8");
  expect(Buffer.byteLength(bytes)).toBeLessThan(MAX_REQUIRED_PROOF_OUTCOME_BYTES);
  expect(bytes).not.toMatch(/do-not-retain|fixture_user|private-anon-key|private-service-role-key|postgresql:|unknownCredential/);
  expect(readdirSync(privateTmp)).toEqual([]);
  if (existsSync(env.PHASE_PATH_LOG)) expect(existsSync(readFileSync(env.PHASE_PATH_LOG, "utf8"))).toBe(false);
  return { result, outcome: JSON.parse(bytes), sourceSha };
}

describe("sanitized required database proof retention", () => {
  it("retains a failed later phase after raw reports are deleted, with exact counts and source", () => {
    const { result, outcome, sourceSha } = runFixture("shared-fail");
    expect(result.status).not.toBe(0);
    expect(outcome).toMatchObject({ schema: 1, type: "required-db-proof-outcome", status: "failed",
      source: { git_head_sha: sourceSha, tracked_contents_match_head: true, declared_ci_head_sha: "a".repeat(40), github_run_id: "34506792941", github_run_attempt: "1" },
      required_proofs: { status: "failed", floor: FLOOR - 1, reported_counts: { numTotalTests: FLOOR - 1, numPassedTests: FLOOR - 2, numFailedTests: 1, numPendingTests: 0, numTodoTests: 0 } },
      scanner: { status: "deferred" }, subsequent_assurance: { status: "not_run", checks: { rls: "not_run", advisors: "not_run" } },
    });
    const [bootstrap, shared] = outcome.required_proofs.phases;
    expect(bootstrap.status).toBe("passed");
    expect(shared).toMatchObject({ status: "failed", exit_code: 1, report_present: true });
    const failed = shared.suites.find(suite => suite.status === "failed");
    expect(failed.file).toBe(PROOF_FILES.at(-1));
    expect(failed.assertions[0]).toEqual({ index: 0, status: "failed", duration_ms: 12345.67, failure_messages_omitted: 1 });
  });

  it("retains an early failure without claiming that shared fixtures or scanner ran", () => {
    const { result, outcome } = runFixture("bootstrap-fail", { PRIVATE_FILE_PIPELINE_SCANNER_DIR: "fixture", PRIVATE_FILE_PIPELINE_CLAMD_PORT: "3310", PRIVATE_FILE_SCANNER_PROOF_REQUIRED: "1" });
    expect(result.status).not.toBe(0);
    expect(outcome.required_proofs.phases[1]).toEqual({ name: "shared-fixtures", status: "not_run", reported_counts: null });
    expect(outcome.required_proofs.reported_counts.numTotalTests).toBe(PRISTINE_FLOOR);
    expect(outcome.scanner).toEqual({ demanded: true, status: "not_run" });
    expect(Object.values(outcome.subsequent_assurance.checks)).toEqual(Array(5).fill("not_run"));
  });

  it("does not treat scanner provisioning or pending scanner assertions as a passed pipeline proof", () => {
    const { result, outcome } = runFixture("scanner-pending", { PRIVATE_FILE_PIPELINE_SCANNER_DIR: "fixture", PRIVATE_FILE_PIPELINE_CLAMD_PORT: "3310", PRIVATE_FILE_SCANNER_PROOF_REQUIRED: "1" });
    expect(result.status).not.toBe(0);
    expect(outcome.scanner).toEqual({ demanded: true, status: "not_run" });
    expect(outcome.required_proofs.reported_counts.numPendingTests).toBe(1);
  });

  for (const mode of ["missing-report", "malformed"]) {
    it(`fails and retains truthful missing observations after a ${mode}`, () => {
      const { result, outcome } = runFixture(mode);
      expect(result.status).not.toBe(0);
      expect(outcome.status).toBe("failed");
      expect(outcome.required_proofs.phases[0]).toMatchObject({ status: "failed", report_present: false, reported_counts: null });
      expect(outcome.required_proofs.phases[1].status).toBe("not_run");
    });
  }

  it("retains a preflight failure when the required scanner lane is absent", () => {
    const { result, outcome } = runFixture("passed", { PRIVATE_FILE_SCANNER_PROOF_REQUIRED: "1" });
    expect(result.status).not.toBe(0);
    expect(outcome.required_proofs).toMatchObject({ status: "failed", phases: [], reported_counts: null });
    expect(outcome.scanner).toEqual({ demanded: true, status: "not_run" });
    expect(outcome.subsequent_assurance.status).toBe("not_run");
  });

  it("keeps a green behavior result distinct from subsequent assurance success", () => {
    const { result, outcome } = runFixture("passed", { PRIVATE_FILE_PIPELINE_SCANNER_DIR: "fixture", PRIVATE_FILE_PIPELINE_CLAMD_PORT: "3310", PRIVATE_FILE_SCANNER_PROOF_REQUIRED: "1" });
    expect(result.status).toBe(0);
    expect(outcome.status).toBe("incomplete");
    expect(outcome.required_proofs).toMatchObject({ status: "passed", floor: FLOOR, reported_counts: { numTotalTests: FLOOR, numPassedTests: FLOOR } });
    expect(outcome.scanner.status).toBe("passed");
    expect(outcome.subsequent_assurance.status).toBe("not_run");
  });

  it("bounds retained assertions while preserving exact totals and rejecting arbitrary output fields", () => {
    const root = mkdtempSync(join(tmpdir(), "required-outcome-bound-"));
    scratch.push(root);
    const recorder = createRequiredDbProofOutcome({ artifactDir: root, root, env: { CI_HEAD_SHA: "a secret", GITHUB_RUN_ID: "another secret" } });
    const file = "tests/private-file-pipeline-db.test.js";
    recorder.plan({ files: [file], floor: 120, deferred: [] });
    recorder.phase({ phase: { name: "shared-fixtures", files: [file], floor: 119 }, accepted: false,
      result: { status: 1, report: { numTotalTests: 1000, numPassedTests: 0, numFailedTests: 1000,
        testResults: [{ name: file, assertionResults: Array.from({ length: 1000 }, () => ({ status: "failed", title: "credential".repeat(10000), failureMessages: ["credential".repeat(10000)] })) }] } },
    });
    recorder.finish(false);
    const bytes = readFileSync(join(root, "database-assurance.json"), "utf8");
    const outcome = JSON.parse(bytes);
    expect(Buffer.byteLength(bytes)).toBeLessThan(MAX_REQUIRED_PROOF_OUTCOME_BYTES);
    expect(bytes).not.toMatch(/credential|a secret|another secret/);
    expect(outcome.source.declared_ci_head_sha).toBeNull();
    const suite = outcome.required_proofs.phases[1].suites[0];
    expect(suite.assertions).toHaveLength(128);
    expect(suite.assertions_omitted).toBe(872);
    expect(suite.assertion_counts.failed).toBe(1000);
    expect(outcome.required_proofs.reported_counts.numFailedTests).toBe(1000);
  });

  // TEST-UG-DB-PROOFS-PROMOTE-REMAINING-MANUAL-SUITES-20260925: the budget
  // used to be spent in plan order, so once more than 128 passing files
  // preceded it, a failing proof late in the plan kept no assertion at all.
  it("retains a late failure ahead of passing assertions once the plan outgrows the assertion budget", () => {
    const root = mkdtempSync(join(tmpdir(), "required-outcome-late-failure-"));
    scratch.push(root);
    const recorder = createRequiredDbProofOutcome({ artifactDir: root, root, env: {} });
    const files = Array.from({ length: 150 }, (_, index) => `tests/proof-${index}-db.test.js`);
    recorder.plan({ files, floor: 150, deferred: [] });
    // Skipped assertions compete for the detail budget; a clean pass does not.
    recorder.phase({ phase: { name: "shared-fixtures", files, floor: 150 }, accepted: false,
      result: { status: 1, report: { numTotalTests: 150, numPassedTests: 1, numFailedTests: 1, numPendingTests: 148,
        testResults: files.map((name, index) => ({ name, startTime: 1000, endTime: 1042,
          assertionResults: [{ status: index === 149 ? "failed" : index === 140 ? "passed" : "skipped", duration: index === 140 ? 40000 : 5 }] })) } },
    });
    recorder.finish(false);
    const suites = JSON.parse(readFileSync(join(root, "database-assurance.json"), "utf8")).required_proofs.phases[1].suites;
    expect(suites.at(-1)).toMatchObject({ status: "failed", assertions_omitted: 0,
      assertions: [{ index: 0, status: "failed", duration_ms: 5, failure_messages_omitted: 0 }] });
    expect(suites.reduce((sum, suite) => sum + suite.assertions.length, 0)).toBe(128);
    expect(suites.slice(0, 127).every(suite => suite.assertions.length === 1)).toBe(true);
    expect(suites.slice(127, 149).every(suite => suite.assertions.length === 0 && suite.assertions_omitted === 1)).toBe(true);
    // Slow passing files must remain measurable after the detail budget is
    // consumed. Otherwise fitting the runner requires another full DB replay.
    expect(suites[140]).toMatchObject({ duration_ms: 42, assertion_durations_ms: [40000], assertions: [] });
    expect(suites.every(suite => suite.duration_ms === 42 && suite.assertion_durations_ms.length === 1)).toBe(true);
  });

  it("marks absent or invalid timings as unknown without retaining arbitrary values", () => {
    const root = mkdtempSync(join(tmpdir(), "required-outcome-timings-"));
    scratch.push(root);
    const recorder = createRequiredDbProofOutcome({ artifactDir: root, root, env: {} });
    const files = ["tests/unknown-db.test.js", "tests/reversed-db.test.js", "tests/valid-db.test.js"];
    recorder.plan({ files, floor: 7, deferred: [] });
    recorder.phase({ phase: { name: "shared-fixtures", files, floor: 7 }, accepted: true,
      result: { status: 0, report: { testResults: [
        { name: files[0], startTime: "credential", endTime: 10, assertionResults:
          [undefined, -1, Infinity, "credential", 0].map(value => ({ status: "passed", duration: value })) },
        { name: files[1], startTime: 20, endTime: 10, assertionResults: [{ status: "passed" }] },
        { name: files[2], startTime: 10, endTime: 25, assertionResults: [{ status: "passed", duration: 2.5 }] },
      ] } },
    });
    const bytes = readFileSync(join(root, "database-assurance.json"), "utf8");
    const suites = JSON.parse(bytes).required_proofs.phases[1].suites;
    expect(suites.map(suite => suite.duration_ms)).toEqual([null, null, 15]);
    expect(suites.map(suite => suite.assertion_durations_ms)).toEqual([[null, null, null, null, 0], [null], [2.5]]);
    expect(bytes).not.toContain("credential");
  });

  // TEST-UG-REQUIRED-DB-PROOF-OUTCOME-CAP-20261107: on Nov 7, 2026 a full
  // plan of 343 files and 3,301 passing cases wrote 131,078 bytes, 6 over the
  // old 128 KiB bound, so the runner failed with every proof green. Size the
  // fixture at twice the current proof list, at least ten cases per file (the
  // full plan averaged 9.6) and full-width timings, so the bound fails here,
  // in root tests, long before a real full plan reaches it. It did so on
  // Nov 19, 2026 at 437 files (262,391 bytes against 256 KiB), and the bound
  // went to 512 KiB (REQ-UG-INTAKE-QUEUE-EMAIL-THE-OPT-IN-LIST-20261118).
  const doubledPlan = () => {
    const files = [...PROOF_FILES, ...PROOF_FILES.map(file => file.replace(/^tests\//, "tests/growth/"))];
    const perFile = Math.max(10, Math.ceil((2 * FLOOR) / files.length));
    return { files, perFile, cases: files.length * perFile };
  };
  const recordPlan = (root, files, statusFor) => {
    const recorder = createRequiredDbProofOutcome({ artifactDir: root, root, env: {} });
    recorder.plan({ files, floor: FLOOR, deferred: [] });
    const testResults = files.map((name, suiteIndex) => ({ name, startTime: 1000, endTime: 61000,
      assertionResults: statusFor(suiteIndex).map(status => ({ status, duration: 12345.678901234567,
        failureMessages: status === "failed" ? ["credential"] : [] })) }));
    const failed = testResults.some(suite => suite.assertionResults.some(item => item.status === "failed"));
    recorder.phase({ phase: { name: "shared-fixtures", files, floor: FLOOR }, accepted: !failed,
      result: { status: failed ? 1 : 0, report: { testResults } } });
    recorder.finish(!failed);
    const bytes = readFileSync(join(root, "database-assurance.json"), "utf8");
    return { bytes, suites: JSON.parse(bytes).required_proofs.phases[1].suites };
  };

  it("keeps a passing plan twice the current proof list inside the bound with every timing", () => {
    const root = mkdtempSync(join(tmpdir(), "required-outcome-timing-size-"));
    scratch.push(root);
    const { files, perFile, cases } = doubledPlan();
    const { bytes, suites } = recordPlan(root, files, () => Array(perFile).fill("passed"));
    expect(Buffer.byteLength(bytes)).toBeLessThan(MAX_REQUIRED_PROOF_OUTCOME_BYTES);
    expect(suites).toHaveLength(files.length);
    expect(suites.flatMap(suite => suite.assertion_durations_ms)).toEqual(Array(cases).fill(12345.679));
    // A clean pass is summarized by its count and timings, not per-case detail.
    expect(suites.every(suite => suite.status === "passed" && suite.duration_ms === 60000 && suite.assertions.length === 0
      && suite.assertions_omitted === perFile && JSON.stringify(suite.assertion_counts) === JSON.stringify({ passed: perFile }))).toBe(true);
  });

  it("keeps per-case detail for failing and skipped cases in a plan twice the current proof list", () => {
    const root = mkdtempSync(join(tmpdir(), "required-outcome-failure-detail-"));
    scratch.push(root);
    const { files, perFile } = doubledPlan();
    const last = files.length - 1;
    const { bytes, suites } = recordPlan(root, files, suiteIndex => Array.from({ length: perFile }, (_, index) =>
      suiteIndex === last && index < 2 ? "failed" : suiteIndex === last - 1 && index === 0 ? "skipped" : "passed"));
    expect(Buffer.byteLength(bytes)).toBeLessThan(MAX_REQUIRED_PROOF_OUTCOME_BYTES);
    expect(bytes).not.toContain("credential");
    expect(suites[last]).toMatchObject({ status: "failed", assertion_counts: { passed: perFile - 2, failed: 2 }, assertions_omitted: perFile - 2,
      assertions: [0, 1].map(index => ({ index, status: "failed", duration_ms: 12345.678901234567, failure_messages_omitted: 1 })) });
    expect(suites[last - 1]).toMatchObject({ status: "not_run", assertion_counts: { passed: perFile - 1, skipped: 1 },
      assertions: [{ index: 0, status: "skipped", duration_ms: 12345.678901234567, failure_messages_omitted: 0 }] });
    expect(suites.slice(0, -2).every(suite => suite.status === "passed" && suite.assertions.length === 0)).toBe(true);
  });

  it("keeps detail for a passing case that carried failure messages", () => {
    const root = mkdtempSync(join(tmpdir(), "required-outcome-retried-"));
    scratch.push(root);
    const recorder = createRequiredDbProofOutcome({ artifactDir: root, root, env: {} });
    const file = "tests/retried-db.test.js";
    recorder.plan({ files: [file], floor: 2, deferred: [] });
    recorder.phase({ phase: { name: "shared-fixtures", files: [file], floor: 2 }, accepted: true,
      result: { status: 0, report: { testResults: [{ name: file, assertionResults: [
        { status: "passed", duration: 3, failureMessages: ["first attempt timed out"] }, { status: "passed", duration: 4 }] }] } } });
    const suite = JSON.parse(readFileSync(join(root, "database-assurance.json"), "utf8")).required_proofs.phases[1].suites[0];
    expect(suite).toMatchObject({ status: "passed", assertions_omitted: 1,
      assertions: [{ index: 0, status: "passed", duration_ms: 3, failure_messages_omitted: 1 }] });
  });
});
