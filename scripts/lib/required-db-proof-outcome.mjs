import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// The only consumer is CI's upload-artifact step, which has no size limit that
// matters here; the bound exists to catch a projection bug that starts copying
// free-form or per-case data, not to fit a reader. Each planned proof file adds
// one suite summary (about 180 bytes plus about 9 bytes per case timing), and
// at most 128 non-passing assertions are retained in detail per phase. 64 KiB
// was exhausted at 88 files and 128 KiB at 343 files and 3,301 cases with the
// older, wider projection. On Nov 19, 2026 the list reached 437 files: a
// full plan at ten cases per file writes about 128 KiB, and the root test's
// fixture at twice that list wrote 262,391 bytes, 247 over the old 256 KiB
// bound (REQ-UG-INTAKE-QUEUE-EMAIL-THE-OPT-IN-LIST-20261118). 512 KiB
// leaves room for the proof list to double again before that test fails.
export const MAX_REQUIRED_PROOF_OUTCOME_BYTES = 512 * 1024;
const COUNT_KEYS = ["numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests"];
const STATUSES = new Set(["passed", "failed", "pending", "skipped", "todo", "disabled"]);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const counts = report => report !== null && typeof report === "object" && !Array.isArray(report)
  ? Object.fromEntries(COUNT_KEYS.map(key => [key, count(report[key] ?? 0)])) : null;
const identifier = (value, pattern) => typeof value === "string" && pattern.test(value) ? value : null;
const duration = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
// Millisecond precision to three decimals is enough for budget diagnosis and
// prevents floating-point tails on every case from exhausting the artifact.
const compactDuration = value => duration(value) === null ? null : Number(value.toFixed(3));

// Diagnostic evidence only. In particular, this is NOT the version:1 RLS /
// Advisors report and can never assert that later CI steps passed. Project only
// allowlisted paths, numeric observations and fixed vocabulary: Vitest titles,
// errors, stdout, environment values and connection strings may contain secrets.
export function createRequiredDbProofOutcome({ artifactDir, root, env = process.env }) {
  const git = args => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  const head = git(["rev-parse", "HEAD"]);
  const sourceSha = identifier(head.stdout?.trim(), /^[a-f0-9]{40}$/);
  const outcome = {
    schema: 1,
    type: "required-db-proof-outcome",
    status: "incomplete",
    source: {
      git_head_sha: sourceSha,
      tracked_contents_match_head: sourceSha !== null && git(["diff", "--quiet", "HEAD", "--"]).status === 0,
      declared_ci_head_sha: identifier(env.CI_HEAD_SHA, /^[a-f0-9]{40}$/),
      github_run_id: identifier(env.GITHUB_RUN_ID, /^[0-9]{1,20}$/),
      github_run_attempt: identifier(env.GITHUB_RUN_ATTEMPT, /^[0-9]{1,10}$/),
    },
    started_at: new Date().toISOString(),
    observed_at: null,
    required_proofs: { status: "not_run", floor: null, phases: [], reported_counts: null },
    scanner: { demanded: env.PRIVATE_FILE_SCANNER_PROOF_REQUIRED === "1", status: "not_run" },
    subsequent_assurance: {
      status: "not_run", scope: "subsequent CI steps as of observed_at",
      checks: { database_contract: "not_run", migration_history: "not_run", rls: "not_run", advisors: "not_run", database_lint: "not_run" },
    },
    redaction: "Free-form assertion titles, messages, errors, stdout and stderr are omitted; assertion indexes are zero-based within each suite. assertion_counts lists only statuses with at least one assertion. Detailed assertions are retained only for non-passing assertions and passing ones that carried failure messages; every other passing assertion is represented by its count and timing. Suite duration_ms spans Vitest startTime to endTime; assertion_durations_ms retains all assertion timings in report order even when detailed assertions are omitted. These are not individual database query or concurrent wave timings.",
  };
  let plannedFiles = [];
  const write = () => {
    outcome.observed_at = new Date().toISOString();
    // Compact: one suite entry per required proof file, so indentation alone
    // pushed an 88-file inventory past the bound.
    const bytes = Buffer.from(`${JSON.stringify(outcome)}\n`);
    if (bytes.length > MAX_REQUIRED_PROOF_OUTCOME_BYTES) throw new Error(`Sanitized required-proof outcome exceeds its ${MAX_REQUIRED_PROOF_OUTCOME_BYTES / 1024} KiB bound`);
    mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
    const path = join(artifactDir, "database-assurance.json");
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, bytes, { mode: 0o600 });
    renameSync(temporary, path);
  };
  write();
  return {
    plan(plan, phaseNames = ["pristine-bootstrap", "shared-fixtures"]) {
      plannedFiles = plan.files;
      outcome.required_proofs.floor = plan.floor;
      outcome.required_proofs.deferred_files = plan.deferred;
      // One job's share of a sharded plan (scripts/run-required-db-proofs.mjs,
      // shardDbProofPlan): counts and the digest only, never a path or value.
      if (plan.shard) {
        const { index, count, planned_files, planned_floor, collected_cases, plan_digest } = plan.shard;
        outcome.required_proofs.shard = { index, count, planned_files, planned_floor, collected_cases, plan_digest: identifier(plan_digest, /^[a-f0-9]{64}$/) };
      }
      outcome.required_proofs.phases = phaseNames.map(name => ({ name, status: "not_run", reported_counts: null }));
      if (plan.deferred.length) outcome.scanner.status = "deferred";
      write();
    },
    phase({ phase, result, accepted }) {
      const target = outcome.required_proofs.phases.find(item => item.name === phase.name);
      if (!target) throw new Error("Unknown required-proof outcome phase");
      const report = result?.report;
      target.status = accepted ? "passed" : "failed";
      outcome.required_proofs.status = accepted ? "running" : "failed";
      outcome.status = accepted ? "incomplete" : "failed";
      target.exit_code = Number.isInteger(result?.status) ? result.status : null;
      target.report_present = report !== null && typeof report === "object" && !Array.isArray(report);
      target.reported_counts = counts(report) || null;
      target.floor = phase.floor;
      // Retain at most 128 assertions per phase. Failed and unrecognized
      // assertions are retained first across every suite, so a failure in a
      // late suite is never dropped once earlier suites have used the budget;
      // the remainder is filled in suite and index order. A clean pass adds
      // nothing that its count and assertion_durations_ms do not already say,
      // so only non-passing assertions and passes with failure messages (a
      // retried flake) qualify.
      const observed = phase.files.filter(file => plannedFiles.includes(file)).map(file => {
        const matches = (Array.isArray(report?.testResults) ? report.testResults : []).filter(suite => typeof suite?.name === "string" && resolve(root, suite.name) === resolve(root, file));
        if (matches.length !== 1) return { file, matching_reports: matches.length, assertions: null };
        const start = duration(matches[0].startTime);
        const end = duration(matches[0].endTime);
        return { file, matching_reports: 1,
          duration_ms: start !== null && end !== null && end >= start ? duration(end - start) : null,
          assertions: Array.isArray(matches[0].assertionResults) ? matches[0].assertionResults : [] };
      });
      const statusOf = assertion => STATUSES.has(assertion?.status) ? assertion.status : "unrecognized";
      const urgent = assertion => statusOf(assertion) === "failed" || statusOf(assertion) === "unrecognized";
      const failureCount = assertion => Array.isArray(assertion?.failureMessages) ? assertion.failureMessages.length : 0;
      const detailed = assertion => statusOf(assertion) !== "passed" || failureCount(assertion) > 0;
      let remaining = 128;
      const kept = observed.map(() => new Set());
      for (const wantUrgent of [true, false]) {
        observed.forEach((entry, suiteIndex) => {
          (entry.assertions ?? []).forEach((assertion, index) => {
            if (remaining > 0 && detailed(assertion) && urgent(assertion) === wantUrgent && !kept[suiteIndex].has(index)) { kept[suiteIndex].add(index); remaining -= 1; }
          });
        });
      }
      target.suites = observed.map((entry, suiteIndex) => {
        const { file, assertions } = entry;
        if (assertions === null) return { file, status: "unobserved", matching_reports: entry.matching_reports };
        const summary = Object.fromEntries([...STATUSES, "unrecognized"].map(status => [status, 0]));
        for (const assertion of assertions) summary[statusOf(assertion)] += 1;
        const retained = assertions.map((assertion, index) => ({
          index, status: statusOf(assertion),
          duration_ms: duration(assertion?.duration),
          failure_messages_omitted: failureCount(assertion),
        })).filter(item => kept[suiteIndex].has(item.index));
        const status = summary.failed ? "failed" : assertions.length && summary.passed === assertions.length ? "passed" : "not_run";
        if (file === "tests/private-file-pipeline-db.test.js") outcome.scanner.status = status;
        return { file, status, duration_ms: entry.duration_ms,
          assertion_durations_ms: assertions.map(assertion => compactDuration(assertion?.duration)),
          assertion_counts: Object.fromEntries(Object.entries(summary).filter(([, value]) => value > 0)), assertions: retained, assertions_omitted: assertions.length - retained.length };
      });
      const reported = outcome.required_proofs.phases.filter(item => item.reported_counts !== null);
      outcome.required_proofs.reported_counts = reported.length ? Object.fromEntries(COUNT_KEYS.map(key => [key,
        reported.some(item => item.reported_counts[key] === null) ? null : count(reported.reduce((sum, item) => sum + item.reported_counts[key], 0)),
      ])) : null;
      outcome.required_proofs.count_scope = "Only phases with a parsed report; not-run or missing-report phases contribute no observations";
      write();
    },
    finish(passed) {
      outcome.required_proofs.status = passed ? "passed" : "failed";
      outcome.status = passed ? "incomplete" : "failed";
      write();
    },
  };
}
