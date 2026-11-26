import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DB_PROOF_WHOLE_PLAN_PATH_LIMIT,
  PIPELINE_PROOF_FILE,
  PRISTINE_DB_PROOFS,
  PRISTINE_DB_PROOF_FLOOR,
  REQUIRED_DB_PROOF_FLOOR,
  SAMPLE_LINEAGE_CARRIER,
  changedPathsForDbProofs,
  dbProofNeedles,
  relatedDbProofPlan,
  readRequiredDbProofPhaseReport,
  requiredDbProofPlan,
  requiredDbProofScope,
  runRequiredDbProofPhases,
} from "./run-required-db-proofs.mjs";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const SCANNER = { PRIVATE_FILE_PIPELINE_SCANNER_DIR: "/tmp/collection-only", PRIVATE_FILE_PIPELINE_CLAMD_PORT: "1" };
const fullPlan = requiredDbProofPlan(SCANNER);

const MIGRATION = "supabase/migrations/20261106120000_member_widget_gate.sql";
// A source module a DB proof names: the input related selection is for.
// Migrations, the contract and the proofs themselves plan every proof.
const MODULE = "src/lib/memberWidgetGate.js";
const MENTIONING = fullPlan.files.find((file) => !PRISTINE_DB_PROOFS.includes(file)
  && file !== PIPELINE_PROOF_FILE && file !== SAMPLE_LINEAGE_CARRIER);
const texts = { [MENTIONING]: `imports ${MODULE.split("/").at(-1)} and checks the gate` };
const readText = (file) => texts[file] ?? "";
const collect = (plan) => ({
  total: plan.files.length * 3,
  byFile: Object.fromEntries(plan.files.map((file) => [file, 3])),
});

test("full plan without an event, on merge_group and on push", () => {
  assert.deepEqual(requiredDbProofScope({}), { mode: "full" });
  for (const event of ["merge_group", "push"]) {
    const env = { REQUIRED_DB_PROOF_EVENT: event, GITHUB_EVENT_NAME: event, REQUIRED_DB_PROOF_BASE: BASE, REQUIRED_DB_PROOF_HEAD: HEAD };
    assert.deepEqual(requiredDbProofScope(env), { mode: "full", event });
  }
  assert.equal(fullPlan.floor, REQUIRED_DB_PROOF_FLOOR);
});

test("related plan only when GitHub itself reports pull_request", () => {
  const env = { REQUIRED_DB_PROOF_EVENT: "pull_request", GITHUB_EVENT_NAME: "pull_request", REQUIRED_DB_PROOF_BASE: BASE, REQUIRED_DB_PROOF_HEAD: HEAD };
  assert.deepEqual(requiredDbProofScope(env), { mode: "related", event: "pull_request", base: BASE, head: HEAD });
  assert.throws(() => requiredDbProofScope({ ...env, GITHUB_EVENT_NAME: "merge_group" }), /does not match GITHUB_EVENT_NAME/);
  assert.throws(() => requiredDbProofScope({ ...env, GITHUB_EVENT_NAME: undefined }), /does not match GITHUB_EVENT_NAME/);
  assert.throws(() => requiredDbProofScope({ ...env, REQUIRED_DB_PROOF_BASE: "" }), /full commit SHAs/);
  assert.throws(() => requiredDbProofScope({ ...env, REQUIRED_DB_PROOF_HEAD: "main" }), /full commit SHAs/);
});

test("changed paths are diffed from the merge base", () => {
  const calls = [];
  const runGit = (args) => {
    calls.push(args);
    return args[0] === "merge-base" ? `${"c".repeat(40)}\n` : `${MIGRATION}\0tests/x-db.test.js\0`;
  };
  assert.deepEqual(changedPathsForDbProofs(BASE, HEAD, runGit), [MIGRATION, "tests/x-db.test.js"]);
  assert.deepEqual(calls, [
    ["merge-base", BASE, HEAD],
    ["diff", "--name-only", "-z", "--no-renames", "c".repeat(40), HEAD, "--"],
  ]);
});

test("needles follow the root-tests job: path plus basenames of eight or more characters", () => {
  assert.deepEqual(dbProofNeedles(["src/a/index.js", "apps/x/package.json", "docs/README.md", "src/tiny.js", "src/longer-name.js"]),
    ["src/a/index.js", "apps/x/package.json", "docs/README.md", "src/tiny.js", "src/longer-name.js", "longer-name.js"]);
});

test("related plan keeps the pristine and pipeline proofs and the mentioning files, in plan order", () => {
  const plan = relatedDbProofPlan(fullPlan, [MODULE, "src/unrelated-module.js"], { readText, collect });
  const expected = fullPlan.files.filter((file) => PRISTINE_DB_PROOFS.includes(file)
    || [PIPELINE_PROOF_FILE, MENTIONING].includes(file));
  assert.equal(plan.scope, "related");
  assert.deepEqual(plan.files, expected);
  assert.equal(plan.floor, PRISTINE_DB_PROOF_FLOOR + 3 * (expected.length - PRISTINE_DB_PROOFS.length));
  assert.deepEqual(plan.deferred, []);
  assert.ok(plan.floor < REQUIRED_DB_PROOF_FLOOR);
});

test("the SAMPLE lineage carrier stays last when it is related", () => {
  const plan = relatedDbProofPlan(fullPlan, [SAMPLE_LINEAGE_CARRIER], { readText, collect });
  assert.equal(plan.files.at(-1), SAMPLE_LINEAGE_CARRIER);
});

test("an unrelated change still runs the pristine and pipeline proofs", () => {
  const plan = relatedDbProofPlan(fullPlan, ["src/unrelated-module.js"], { readText, collect });
  assert.deepEqual(new Set(plan.files), new Set([...PRISTINE_DB_PROOFS, PIPELINE_PROOF_FILE]));
});

test("the setup, lock and runner paths, migrations, the contract, DB proofs and wide changes plan every proof", () => {
  const changedProof = fullPlan.files.findLast((file) => file !== SAMPLE_LINEAGE_CARRIER && file !== MENTIONING
    && !PRISTINE_DB_PROOFS.includes(file) && file !== PIPELINE_PROOF_FILE);
  for (const path of [
    MIGRATION, "scripts/db-contract.json", changedProof,
    "scripts/run-required-db-proofs.mjs", "scripts/lib/required-db-proof-outcome.mjs",
    "scripts/lib/db-contract-tables.mjs", "supabase/config.toml", "tests/helpers/chapter-finance-proof.mjs",
    "tests/setup.js", "package.json", "package-lock.json", "vite.config.mjs", "vitest.workspace.mjs",
  ]) {
    const plan = relatedDbProofPlan(fullPlan, ["src/unrelated-module.js", path], { readText, collect: () => assert.fail("collected") });
    assert.equal(plan.scope, "full", path);
    assert.deepEqual(plan.files, fullPlan.files);
    assert.equal(plan.floor, REQUIRED_DB_PROOF_FLOOR);
  }
  const wide = Array.from({ length: DB_PROOF_WHOLE_PLAN_PATH_LIMIT + 1 }, (_, i) => `src/file-${i}.js`);
  assert.equal(relatedDbProofPlan(fullPlan, wide, { readText, collect }).scope, "full");
  assert.equal(relatedDbProofPlan(fullPlan, wide.slice(1), { readText, collect }).scope, "related");
});

test("a related file that collects no case fails the plan", () => {
  const skipping = (plan) => ({ total: 0, byFile: Object.fromEntries(plan.files.map((file) => [file, 0])) });
  assert.throws(() => relatedDbProofPlan(fullPlan, [MODULE], { readText, collect: skipping }), /collected no case/);
});

test("a deferred scanner proof leaves no shared phase and is refused rather than handing Vitest no files", () => {
  const deferredPlan = requiredDbProofPlan({});
  assert.throws(() => relatedDbProofPlan(deferredPlan, ["src/unrelated-module.js"], { readText, collect }), /no shared-fixture proof/);
});

test("the workflow step passes the event, base and head and keeps one worker", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const step = workflow.slice(workflow.indexOf("- name: Required DB repair behavior proofs"), workflow.indexOf("- name: Exact-head DB contract"));
  assert.match(step, /REQUIRED_DB_PROOF_EVENT: \$\{\{ github\.event_name \}\}/);
  assert.match(step, /REQUIRED_DB_PROOF_BASE: \$\{\{ env\.CI_BASE_SHA \}\}/);
  assert.match(step, /REQUIRED_DB_PROOF_HEAD: \$\{\{ env\.CI_HEAD_SHA \}\}/);
  assert.match(readFileSync(new URL("./run-required-db-proofs.mjs", import.meta.url), "utf8"), /"--maxWorkers=1"/);
});

function phaseReportFixture(t, report) {
  const directory = mkdtempSync(join(tmpdir(), "db-proof-failure-names-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "shared-fixtures.json");
  if (report !== undefined) writeFileSync(path, JSON.stringify(report));
  return path;
}

test("prints each failing file, full test name, first error line, duration and phase totals", t => {
  const report = {
    numTotalTests: 5, numPassedTests: 1, numFailedTests: 2, numPendingTests: 1, numTodoTests: 1,
    testResults: [
      { name: "tests/failed-db.test.js", status: "failed", startTime: 1000, endTime: 1150, assertionResults: [
        { fullName: "chapter scope rejects another chapter", status: "failed", duration: 12.5,
          failureMessages: ["\u001b[31mAssertionError: expected denial\u001b[0m\n    at proof.js:42", "second error"] },
        { ancestorTitles: ["chapter scope", "read"], title: "keeps the filter", status: "failed", duration: 0,
          failureMessages: [null, "", "Error: missing filter\r\n    at proof.js:80"] },
        { fullName: "passing retried assertion", status: "passed", failureMessages: ["old attempt"] },
        { fullName: "pending assertion", status: "pending" },
      ] },
      { name: "tests/hook-db.test.js", status: "failed", startTime: 2000, endTime: 2050,
        message: "Error: beforeAll failed\n    at setup.js:10", assertionResults: [] },
      { name: "tests/passing-db.test.js", status: "passed", assertionResults: [{ status: "passed" }] },
    ],
  };
  const path = phaseReportFixture(t, report);
  const lines = [];
  assert.deepEqual(readRequiredDbProofPhaseReport(path, 1, "shared-fixtures", line => lines.push(line)), report);
  assert.deepEqual(lines, [
    "DB PROOF (shared-fixtures) FAIL FILE: tests/failed-db.test.js | AssertionError: expected denial | duration: 150 ms\n",
    "DB PROOF (shared-fixtures) FAIL TEST: tests/failed-db.test.js | chapter scope rejects another chapter | AssertionError: expected denial | duration: 12.5 ms\n",
    "DB PROOF (shared-fixtures) FAIL TEST: tests/failed-db.test.js | chapter scope read keeps the filter | Error: missing filter | duration: 0 ms\n",
    "DB PROOF (shared-fixtures) FAIL FILE: tests/hook-db.test.js | Error: beforeAll failed | duration: 50 ms\n",
    "DB PROOF (shared-fixtures) TOTALS: 5 total, 1 passed, 2 failed, 1 pending, 1 todo\n",
  ]);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), report, "the original JSON report is preserved");
});

test("incomplete failure details use explicit fallbacks without hiding the process failure", t => {
  const path = phaseReportFixture(t, { testResults: [null, {
    status: "failed", startTime: 20, endTime: 10,
    assertionResults: [{ status: "failed", duration: -1, failureMessages: "invalid" }],
  }, { name: "tests/no-assertions-db.test.js", status: "failed", assertionResults: {} }] });
  const lines = [];
  readRequiredDbProofPhaseReport(path, null, "pristine-bootstrap", line => lines.push(line));
  assert.deepEqual(lines, [
    "DB PROOF (pristine-bootstrap) FAIL FILE: (unknown file) | No error message reported | duration: unknown\n",
    "DB PROOF (pristine-bootstrap) FAIL TEST: (unknown file) | (unnamed test) | No error message reported | duration: unknown\n",
    "DB PROOF (pristine-bootstrap) FAIL FILE: tests/no-assertions-db.test.js | No error message reported | duration: unknown\n",
    "DB PROOF (pristine-bootstrap) TOTALS: unknown total, unknown passed, unknown failed, unknown pending, unknown todo\n",
  ]);
});

for (const mode of ["valid", "missing", "malformed JSON", "malformed structure", "null", "unreadable"]) {
  test(`prints ${mode} report diagnostics before throwing the original phase process status`, t => {
    const fixture = { testResults: [{ name: "tests/fixture-db.test.js", status: "failed", message: "Error: fixture failed" }] };
    const path = phaseReportFixture(t, mode === "missing" || mode === "unreadable" ? undefined
      : mode === "malformed structure" ? { testResults: {} } : mode === "null" ? null : fixture);
    if (mode === "malformed JSON") writeFileSync(path, "{broken json");
    if (mode === "unreadable") mkdirSync(path);
    const lines = [];
    const phases = [];
    const observations = [];
    assert.throws(() => runRequiredDbProofPhases(fullPlan, phase => {
      phases.push(phase.name);
      return { status: 17, report: readRequiredDbProofPhaseReport(path, 17, phase.name, line => lines.push(line)) };
    }, observation => {
      assert.ok(lines.length >= 2, "diagnostics precede the phase failure observer and throw");
      observations.push(observation);
    }), /^Error: Required DB proof test process exited 17 \(pristine-bootstrap\)$/);
    assert.deepEqual(phases, ["pristine-bootstrap"], "failure still stops the shared phase");
    assert.equal(observations[0].result.status, 17);
    assert.equal(observations[0].accepted, false);
    if (mode === "valid") {
      assert.match(lines[0], /FAIL FILE: tests\/fixture-db.test.js \| Error: fixture failed/);
    } else {
      const problem = mode === "null" ? "malformed structure" : mode === "unreadable" ? "unreadable (EISDIR)" : mode;
      assert.equal(lines[0], `DB PROOF (pristine-bootstrap): ${problem} phase JSON report at ${path}\n`);
      assert.equal(lines[1], "DB PROOF (pristine-bootstrap) TOTALS: unavailable\n");
      assert.equal(observations[0].result.report, null);
    }
  });
}

test("successful phases keep their report without failure output and malformed JSON still fails", t => {
  const report = { numTotalTests: 1, numPassedTests: 1, testResults: [] };
  const path = phaseReportFixture(t, report);
  const write = () => assert.fail("success printed failure diagnostics");
  assert.deepEqual(readRequiredDbProofPhaseReport(path, 0, "shared-fixtures", write), report);
  writeFileSync(path, "{broken json");
  assert.throws(() => readRequiredDbProofPhaseReport(path, 0, "shared-fixtures", write), SyntaxError);
  const missing = phaseReportFixture(t);
  assert.equal(readRequiredDbProofPhaseReport(missing, 0, "shared-fixtures", write), null);
});
