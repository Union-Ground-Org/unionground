// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROOF_FILES } from "../scripts/run-required-db-proofs.mjs";
import { reviewedPreGateRead } from "../scripts/account-case-graph-inventory.mjs";
import { PRODUCT_JOBS, getProductJob, staleAfterMsForCadence } from "../src/features/operations/index.js";
import { findMigrationName, fnBody, loadMigrationSql, migrationFiles, migrationNames, stripComments } from "./helpers/migration.js";

// BUG-UG-CRON-JOB-HEALTH-SYNC-LOCK-STALL-20260908: the per-minute mirror of
// pg_cron history into public.organization_job_runs must stay incremental. The
// live behaviour is proved by tests/cron-job-health-sync-db.test.js in the
// required DB proof lane; these pins keep the reviewed text from drifting.

const migrationName = "20260908170000_cron_job_health_sync_incremental.sql";
const sql = loadMigrationSql("cron_job_health_sync_incremental");
const executable = stripComments(sql);
const body = fnBody(executable, "private.sync_organization_job_runs_from_cron_history()");
const dbContract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const previousSql = stripComments(loadMigrationSql("20260826157000_mi1_fable_review_repairs"));

const allowlistedJobs = [
  "integration-webhooks-dispatch-tick",
  "notifications-dispatch-tick",
  "notifications-expiry-sweep",
  "deadline-notices-tick",
  "ballot-notices-tick",
  "event-notices-tick",
  "appointment-reminders-tick",
  "member-messaging-dispatch",
  "workload-reminders-tick",
  "ballot-choices-mix",
  "ballot-choices-mix-recent",
  "task-files-reconcile-tick",
  "task-maintenance-daily",
];

describe("cron job-health sync incremental migration", () => {
  it("applies after the lifecycle lock-order migrations that pinned and wrapped the previous body", () => {
    const names = migrationNames();
    const index = names.indexOf(migrationName);
    expect(index).toBeGreaterThan(-1);
    for (const earlier of [
      "20260907150000_account_lifecycle_manifest.sql",
      "20260907151000_account_deletion_finalization_reconciliation.sql",
      "20260907152000_sensitive_content_lock_order.sql",
      "20260907153000_member_invitation_accept_limit_pruning.sql",
    ]) {
      expect(names.indexOf(earlier)).toBeGreaterThan(-1);
      expect(names.indexOf(earlier)).toBeLessThan(index);
    }
  });

  it("replaces the routine as a top-level statement and keeps every role revoked", () => {
    expect(executable).toContain("create or replace function private.sync_organization_job_runs_from_cron_history()");
    expect(executable).not.toMatch(/\bdo\s+\$/i);
    expect(executable).not.toContain("execute $ddl$");
    expect(executable.indexOf("revoke all on function private.sync_organization_job_runs_from_cron_history()"))
      .toBeGreaterThan(executable.indexOf("$function$;"));
    expect(executable).toContain("from public, anon, authenticated, service_role");
  });

  it("keeps the reviewed lock-order preamble, security-definer boundary and empty search path", () => {
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    const preamble = "perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);";
    expect(body).toContain(preamble);
    // The preamble must be the first executable statement of the body, ahead
    // of the window computation and the upsert.
    const firstStatement = body.slice(body.indexOf("\nbegin\n") + "\nbegin\n".length).trimStart();
    expect(firstStatement.startsWith(preamble)).toBe(true);
    expect(body.indexOf(preamble)).toBeLessThan(body.indexOf("into window_start"));
  });

  it("resumes from the newest mirrored cron start with a two-hour look-back and a fourteen-day floor", () => {
    expect(body).toContain("pg_catalog.max(mirrored.started_at)");
    expect(body).toContain("where mirrored.organization_id is null");
    expect(body).toContain("and mirrored.run_id like 'cron:%'");
    expect(body).toContain("- interval '2 hours'");
    expect(body).toContain("pg_catalog.now() - interval '14 days')");
    expect(body).toContain("into window_start");
    expect(body).toContain("and (d.start_time >= window_start or d.runid = any(open_runs))");
    expect(body).not.toContain("d.start_time >= pg_catalog.now() - interval '14 days'");
  });

  it("always re-reads runs the mirror still shows as in progress so a late completion lands", () => {
    expect(body).toContain("open_runs bigint[];");
    expect(body).toContain("and open_run.status = 'in_progress'");
    expect(body).toContain("and open_run.run_id like 'cron:%'");
    expect(body).toContain("pg_catalog.substr(open_run.run_id, 6)::bigint");
  });

  it("filters candidates whose mirrored outcome already matches before the insert, so the row trigger sees only new or changed runs", () => {
    expect(body).toContain("with candidate as (");
    expect(body).toContain("left join public.organization_job_runs mirrored");
    expect(body).toContain("and mirrored.organization_id is null");
    expect(body).toContain("where mirrored.id is null");
    for (const column of ["status", "finished_at", "failure_code", "redacted_summary"]) {
      expect(body).toContain(`or mirrored.${column} is distinct from c.${column}`);
    }
    expect(body.indexOf("left join public.organization_job_runs mirrored"))
      .toBeLessThan(body.indexOf("on conflict (job_name, run_id, organization_id) do update"));
  });

  it("updates a conflicting mirror row only when its outcome actually changed", () => {
    expect(body).toContain("on conflict (job_name, run_id, organization_id) do update");
    for (const column of ["status", "finished_at", "failure_code", "redacted_summary"]) {
      expect(body).toContain(`organization_job_runs.${column} is distinct from excluded.${column}`);
    }
    expect(body).toContain("get diagnostics changed_count = row_count;");
  });

  it("keeps the thirteen-job allowlist, status mapping and outcome columns of the previous definition", () => {
    for (const job of allowlistedJobs) {
      expect(body).toContain(`'${job}'`);
      expect(previousSql).toContain(`'${job}'`);
    }
    expect(body).toContain("case d.status when 'succeeded' then 'completed' when 'failed' then 'failed' else 'in_progress' end");
    expect(body).toContain("case when d.status = 'failed' then 'cron_failed' end");
    expect(body).toContain("case when d.status = 'failed' then 'Scheduled command failed.' end");
    expect(body).toContain("from cron.job_run_details d join cron.job j on j.jobid = d.jobid");
  });

  it("keeps eighteen live cases in the required proof lane and the floor counts every one of them", () => {
    const liveProof = readFileSync(new URL("./cron-job-health-sync-db.test.js", import.meta.url), "utf8");
    const runner = readFileSync(new URL("../scripts/run-required-db-proofs.mjs", import.meta.url), "utf8");
    const cases = (liveProof.match(/^\s{2}it\(/gm) || []).length;
    expect(cases).toBe(18);
    expect(liveProof).not.toMatch(/\b(it|describe)\.(skip|only|todo)\(/);
    expect(PROOF_FILES).toContain("tests/cron-job-health-sync-db.test.js");
    expect(runner).toContain('RUN_CRON_JOB_HEALTH_SYNC_DB_TESTS: "1"');
    // 99 proofs before these deliveries, the scanner currency projection, all
    // six cron cases, twelve Steward scale cases in two tenant distributions,
    // and five membership-card nonce cases.
    expect(PROOF_FILES).toContain("tests/private-upload-currency-canary-db.test.js");
    // The private-upload currency and hosted ACL regressions each add one, and
    // the Steward scale suite now contributes twelve required cases.
    // Connected automation v2 and shared automation intelligence v3 each add
    // one required, executable client/database proof.
    expect(PROOF_FILES).toContain("tests/connected-automation-v2-db.test.js");
    expect(PROOF_FILES).toContain("tests/automation-shared-intelligence-v3-db.test.js");
    // The membership-card single-use nonce proof adds five required cases: the
    // fourth is its anon-only exposure proof and the fifth the live-row
    // allocation ceiling the Codex review of PR #1871 required.
    expect(PROOF_FILES).toContain("tests/membership-card-single-use-db.test.js");
    // BUG-UG-AUTH-BOOKKEEPING-CASE-GRAPH-LOCK-20260908 adds 15 live cases.
    expect(PROOF_FILES).toContain("tests/auth-bookkeeping-lock-scope-db.test.js");
    expect(PROOF_FILES).toContain("tests/pg-net-tick-request-id-db.test.js");
    expect(PROOF_FILES).toContain("tests/case-attachment-lifecycle-restriction-gate-db.test.js");
    expect(PROOF_FILES).toContain("tests/case-child-row-restriction-gate-db.test.js");
    expect(PROOF_FILES).toContain("tests/coordinator-case-write-restriction-gate-db.test.js");
    expect(PROOF_FILES).toContain("tests/chapter-verification-identity-db.test.js");
    expect(PROOF_FILES).toContain("tests/case-history-db.test.js");
    expect(PROOF_FILES).toContain("tests/coordinator-queue-tenant-scope-db.test.js");
    expect(PROOF_FILES).toContain("tests/casework-audit-reader-kinds-db.test.js");
    expect(PROOF_FILES).toContain("tests/dues-oauth-recovery-account-check-db.test.js");
    expect(PROOF_FILES).toContain("tests/public-chapter-microsite-direct-dml-db.test.js");
    expect(PROOF_FILES).toContain("tests/casework-reminders-direct-dml-db.test.js");
    expect(PROOF_FILES).toContain("tests/public-site-chapter-parent-delete-db.test.js");
    expect(PROOF_FILES).toContain("tests/vote-campaign-authority-db.test.js");
    expect(PROOF_FILES).toContain("tests/chapter-task-report-window-db.test.js");
    expect(PROOF_FILES).toContain("tests/live-poll-roster-eligibility-db.test.js");
    expect(PROOF_FILES).toContain("tests/survey-publish-atomicity-db.test.js");
    // The runner discovers tests/*-db.test.js files by name; pin that this
    // proof is planned.
    expect(PROOF_FILES).toContain("tests/cron-job-health-sync-db.test.js");
  });

  it("pins the command of every db-contract cron job, not just its name and schedule", () => {
    // DEBT-UG-DB-CONTRACT-RETENTION-CRON-COMMANDS-UNPINNED-20260921:
    // verify:db only checks a command through commandContains, so an entry
    // without it passes whatever the job runs.
    const unpinned = dbContract.cron
      .filter((job) => !(job.commandContains || []).length)
      .map((job) => job.jobname);
    expect(unpinned).toEqual([]);
    const pins = Object.fromEntries(dbContract.cron.map((job) => [job.jobname, job.commandContains]));
    expect(pins["notifications-expiry-sweep"]).toContain("public.expire_notification_deliveries()");
    expect(pins["task-maintenance-daily"]).toContain("private.run_task_maintenance()");
    expect(pins["appointment-reminders-tick"]).toContain("private.appointment_reminder_sweep()");
  });

  it("still satisfies every db-contract body pin for the routine", () => {
    const entry = dbContract.functions.find((fn) => fn.sig === "private.sync_organization_job_runs_from_cron_history()");
    expect(entry).toBeDefined();
    expect(entry.secdef).toBe(true);
    expect(entry.bodyContains.length).toBeGreaterThan(0);
    for (const pin of entry.bodyContains) expect(currentMirrorBody).toContain(pin);
  });
});

// OPS-UG-CRON-HEALTH-MIRROR-OMITS-SIX-JOBS-20260921: the set of jobs the
// health desk watches is written out by hand in four places — the mirror's
// jobname allowlist, the organization_job_runs_job_name_check constraint, the
// public.list_organization_job_health() catalog and PRODUCT_JOBS — and none of
// them is derived from the schedules. Six production jobs were scheduled after
// the last time those copies were touched, so a failing
// casework-alert-escalation-tick, weekly-question-selection-tick,
// mesh-agency-usage-aggregate-tick, mi1-public-rsvp-retention,
// organization-automation-tick or union-ground-organization-retention left the
// Admin Job Health page green. These pins derive the scheduled set from the
// migrations and hold the four copies to it, so the next job scheduled without
// its monitoring fails here instead of on call.
// SEC-UG-ANALYTICS-LAYOUT-CREATION-RETRY-BOUNDS-20260921 scheduled
// mi1-analytics-receipt-retention and re-emitted the mirror, the constraint and
// the admin catalog unchanged apart from that name; then
// OPS-UG-EVENT-CHECKIN-TOKENS-NO-RETENTION-20260921 scheduled
// event-checkin-token-retention and re-emitted them again with that name
// added; then SEC-UG-UNION-CATALOG-CLAIM-ANTI-TAKEOVER-20260925 scheduled
// organization-claim-retention and re-emitted them once more with that name
// added; then REQ-UG-LIVE-POLL-SCHEDULED-OPEN-CLOSE-20261001 scheduled
// live-poll-schedule-tick and re-emitted them with that name added; then
// REQ-UG-SURVEY-ESCALATION-AND-FOLLOWUP-TASKS-20261001 scheduled
// survey-operations-sweep and re-emitted them with both of those names.
// Restore train 2 re-emits them four more times, each cumulative over every
// earlier copy: REQ-UG-ULP-FILING-DEADLINE-20261001 adds
// casework-ulp-deadline-tick, REQ-UG-RETALIATION-TIMING-DETECTOR-20261001
// casework-retaliation-timing-tick, BUG-UG-CASEWORK-DEADLINE-REMINDER-AT-
// NEVER-FIRES-20261001 casework-deadline-reminder-tick, and
// REQ-UG-SSO-SIGNIN-20261001 sso-identity-link-sweep together with
// issue-intelligence-weekly-digest, which
// REQ-UG-ISSUE-INTELLIGENCE-WEEKLY-DIGEST-20261001 schedules without
// re-emitting the copies. The usage digest re-emitted them with
// analytics-usage-digest, and REQ-UG-PULSE-HISTORY-READ-20261031 with
// pulse-weekly-snapshots, and REQ-UG-LEARNING-PERIOD-ENGINE-20261103
// with learning-period-end-tick; the learning period migration now carries the latest
// registries, and the bounded-lookup migration still owns the historical index
// assertions.
const coverageMigrationName = "20261103163000_learning_period_engine.sql";
const coverageSql = stripComments(loadMigrationSql("20261103163000_learning_period_engine"));
const mirrorSignature = "private.sync_organization_job_runs_from_cron_history()";
const lookupSql = stripComments(loadMigrationSql("cron_job_health_bounded_lookup"));
// BUG-UG-SAMPLE-STAFF-TWO-STEP-VERIFY-500-LOCK-TIMEOUT-20261106 (#7299) replaced the
// mirror alone, so it now owns the live body while the learning period
// migration keeps the constraint and the health catalog.
// BUG-UG-CRON-MIRROR-READS-WHOLE-CRON-HISTORY-EVERY-MINUTE-20261108 (#7513) then
// bounded the history read by run id, so it owns the live body now.
const gateSql = stripComments(loadMigrationSql("20261106227000_cron_mirror_reads_before_lifecycle_gate"));
const boundMigrationName = "20261108051800_cron_mirror_scan_bounded_by_runid.sql";
const boundSql = stripComments(loadMigrationSql("20261108051800_cron_mirror_scan_bounded_by_runid"));
const boundMirrorBody = fnBody(boundSql, mirrorSignature);
// BUG-UG-CRON-MIRROR-HOURLY-FULL-READ-REPEATS-WHOLE-HISTORY-COST-20261108 (#7562) then
// replaced the hourly whole-history read with a probe of the run ids no run
// held, so it owns the live body now.
const reconcileMigrationName = findMigrationName("cron_mirror_reconciles_free_run_ids");
const reconcileSql = stripComments(loadMigrationSql("cron_mirror_reconciles_free_run_ids"));
const currentMirrorBody = fnBody(reconcileSql, mirrorSignature);
const dispatcherMigrationName = findMigrationName("stagger_cron_starts_and_dispatch_minutes");
const dispatcherSql = stripComments(loadMigrationSql("stagger_cron_starts_and_dispatch_minutes"));
const currentHealthBody = fnBody(dispatcherSql, "public.list_organization_job_health()");

// The one job a migration schedules at HEAD that the health desk deliberately
// does not mirror. The name must still be scheduled, so the exclusion cannot
// outlive its job.
const mirrorExclusions = new Map([
  [
    "mi1-job-health-sync",
    "The cron entry aggregates six isolated tasks. Individual outcomes are recorded"
    + " directly, including the mirror itself. Mirroring the aggregate success"
    + " could conceal a task failure, so its cron history remains excluded.",
  ],
]);

// Names a migration only ever schedules from inside a routine a demo seed
// calls, and drops again when the seed is removed. They are not part of the
// baseline schedule, so the mirror does not carry them.
const demandScheduledJobs = ["demo-seed-analytics-health-rotate", "demo-seed-voice-quarterly-refresh"];

// The six jobs this record names, pinned so a later edit cannot quietly drop one
// back out of the mirror.
const newlyCoveredJobs = [
  "casework-alert-escalation-tick",
  "mesh-agency-usage-aggregate-tick",
  "mi1-public-rsvp-retention",
  "organization-automation-tick",
  "union-ground-organization-retention",
  "weekly-question-selection-tick",
];

// Every jobname a migration still schedules at HEAD: the last cron.schedule wins,
// and a name whose last mention is a cron.unschedule has left the schedule.
function scheduledJobNames() {
  const scheduled = new Map();
  const retired = new Map();
  for (const { name: file, sql: migrationSql } of migrationFiles()) {
    const text = stripComments(migrationSql);
    for (const match of text.matchAll(/cron\.schedule\(\s*'([^']+)'/g)) {
      scheduled.set(match[1], { file, at: match.index });
    }
    for (const match of text.matchAll(/cron\.unschedule\([^)]*\)[\s\S]{0,300}?jobname\s*=\s*'([^']+)'/g)) {
      retired.set(match[1], { file, at: match.index });
    }
  }
  return [...scheduled.entries()]
    .filter(([jobName, last]) => {
      const drop = retired.get(jobName);
      return !drop || drop.file < last.file || (drop.file === last.file && drop.at < last.at);
    })
    .map(([jobName]) => jobName)
    .sort();
}

// The quoted names of one SQL list literal, e.g. `in (` ... `)`.
function quotedList(text, opener, closer) {
  const at = text.indexOf(opener);
  if (at === -1) throw new Error(`"${opener}" is not present`);
  const end = text.indexOf(closer, at + opener.length);
  if (end === -1) throw new Error(`"${opener}" does not terminate`);
  return [...text.slice(at + opener.length, end).matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
}

// The last migration whose executable SQL contains `needle`.
function lastMigrationContaining(needle) {
  const matches = migrationFiles().filter((entry) => stripComments(entry.sql).includes(needle));
  if (matches.length === 0) throw new Error(`no migration contains "${needle}"`);
  return matches[matches.length - 1].name;
}

const allMigrationSql = migrationFiles().map((entry) => entry.sql).join("\n");
const mirrorAllowlist = quotedList(currentMirrorBody, "where j.jobname in (", ")");
const checkConstraintJobs = quotedList(dispatcherSql, "check (job_name in (", ")");
const healthCatalogJobs = quotedList(currentHealthBody, "pg_catalog.unnest(array[", "]");

describe("cron health mirror covers every scheduled production job", () => {
  it.each([
    "automation_minutes_exports_retention_sources",
    "governance_leadership_recovery_and_officer_removal",
  ])("keeps each train 3 re-emission cumulative over its predecessor: %s", (fragment) => {
    const files = migrationFiles();
    const index = files.findIndex((entry) => entry.name.includes(fragment));
    expect(index).toBeGreaterThan(0);
    const candidate = stripComments(files[index].sql);
    const prior = files.slice(0, index).reverse()
      .find((entry) => stripComments(entry.sql).includes("add constraint organization_job_runs_job_name_check"));
    expect(prior).toBeDefined();
    const predecessor = stripComments(prior.sql);
    for (const [before, after] of [
      [quotedList(predecessor, "check (job_name in (", ")"), quotedList(candidate, "check (job_name in (", ")")],
      [quotedList(fnBody(predecessor, mirrorSignature), "where j.jobname in (", ")"), quotedList(fnBody(candidate, mirrorSignature), "where j.jobname in (", ")")],
      [quotedList(fnBody(predecessor, "public.list_organization_job_health()"), "pg_catalog.unnest(array[", "]"), quotedList(fnBody(candidate, "public.list_organization_job_health()"), "pg_catalog.unnest(array[", "]")],
    ]) expect(after).toEqual(expect.arrayContaining(before));
  });

  it("is the last definition of the mirror, the constraint and the admin catalog", () => {
    expect(lastMigrationContaining(`create or replace function ${mirrorSignature}`)).toBe(reconcileMigrationName);
    expect(quotedList(fnBody(coverageSql, mirrorSignature), "where j.jobname in (", ")")).toEqual(mirrorAllowlist);
    expect(lastMigrationContaining("add constraint organization_job_runs_job_name_check")).toBe(dispatcherMigrationName);
    expect(lastMigrationContaining("create or replace function public.list_organization_job_health()"))
      .toBe(dispatcherMigrationName);
  });

  it("bounds mirror reads while retaining the same lock and immutable cron history", () => {
    expect(lookupSql).toContain("on public.organization_job_runs (started_at desc)");
    expect(lookupSql).toContain("where organization_id is null and run_id like 'cron:%'");
    expect(lookupSql).toContain("on public.organization_job_runs (run_id)");
    expect(lookupSql).toContain("status = 'in_progress' and run_id like 'cron:%'");
    expect(currentMirrorBody).toContain("set jit = off");
    expect(currentMirrorBody).toContain("left join lateral (");
    expect(currentMirrorBody).toContain("existing.job_name = c.job_name");
    expect(currentMirrorBody).toContain("existing.run_id = c.run_id");
    expect(currentMirrorBody).toContain("existing.organization_id is null");
    expect(currentMirrorBody).toContain("limit 1");
    expect(lookupSql).not.toMatch(/(?:create|alter|drop)\s+(?:table|index|trigger)[^;]*\bcron\./i);
    expect(lookupSql).not.toMatch(/(?:create|alter|drop)\s+trigger/i);
    expect(lookupSql).not.toMatch(/grant\s+execute/i);
    expect(lookupSql).toContain("from public, anon, authenticated, service_role");
  });

  it("bounds the cumulative SHARE lock its index builds hold against the per-minute lifecycle tick", () => {
    // A transactional CREATE INDEX blocks the tick's INSERT while the tick
    // holds the lifecycle gate. CONCURRENTLY cannot run in a migration, so the
    // function is replaced first, and the explicit SHARE lock plus both builds
    // run as one DO statement, so one statement_timeout caps the whole wait
    // and hold. lock_timeout caps a queued SHARE request. Commit follows the block.
    const lockAt = lookupSql.indexOf("lock table public.organization_job_runs in share mode;");
    const doAt = lookupSql.indexOf("do $$");
    const blockEnd = lookupSql.indexOf("end\n$$;", doAt);
    const block = lookupSql.slice(doAt, blockEnd);
    expect(lookupSql).not.toMatch(/\bconcurrently\b/i);
    expect(lookupSql.indexOf("create or replace function private.sync_organization_job_runs_from_cron_history()")).toBeLessThan(doAt);
    expect(lookupSql.indexOf("set local lock_timeout = '1s';")).toBeGreaterThan(-1);
    expect(lookupSql.indexOf("set local lock_timeout = '1s';")).toBeLessThan(doAt);
    expect(lookupSql.indexOf("set local statement_timeout = '3s';")).toBeGreaterThan(-1);
    expect(lookupSql.indexOf("set local statement_timeout = '3s';")).toBeLessThan(doAt);
    expect(lockAt).toBeGreaterThan(doAt);
    expect(block.match(/create index /g)).toHaveLength(2);
    expect(block.indexOf("lock table")).toBeLessThan(block.indexOf("create index"));
    expect((lookupSql.match(/create index /g) || []).length).toBe(2);
    expect(lookupSql.slice(blockEnd + "end\n$$;".length).trim()).toBe("commit;");
  });

  it("mirrors at most 2,000 pending runs per tick, oldest start first, in one statement", () => {
    // A cold mirror wrote fourteen days of history in one transaction under the
    // lifecycle gate. One bounded batch per call, ordered so the newest-start
    // watermark never passes a run left pending; no loop inside the routine.
    expect(currentMirrorBody).toContain("), pending as (");
    expect(currentMirrorBody).toContain("order by c.started_at, c.cron_runid");
    expect(currentMirrorBody).toContain("limit 2000");
    expect(currentMirrorBody).toContain("from pending p");
    expect(currentMirrorBody).not.toMatch(/\b(loop|while|for\s+\w+\s+in)\b/i);
    expect(currentMirrorBody).toContain("into pending_rows");
    expect(currentMirrorBody).toContain("from pg_catalog.jsonb_to_recordset(pending_rows) as p(");
  });

  it("pins the routine's jit setting, bounded lookup and indexes in the database contract", () => {
    const entry = dbContract.functions.find((f) => f.sig === mirrorSignature);
    expect(entry.config).toEqual(["jit=off"]);
    expect(entry.bodyContains).toEqual(expect.arrayContaining(["left join lateral (", "existing.organization_id is null"]));
    const names = dbContract.indexes.filter((i) => i.table === "organization_job_runs").map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(["organization_job_runs_cron_latest_idx", "organization_job_runs_cron_open_idx"]));
  });

  it("mirrors every jobname a migration schedules, minus the documented exclusion", () => {
    const scheduled = scheduledJobNames();
    for (const [jobName, reason] of mirrorExclusions) {
      expect(scheduled).toContain(jobName);
      expect(reason.trim().length).toBeGreaterThan(40);
      expect(mirrorAllowlist).not.toContain(jobName);
    }
    for (const jobName of demandScheduledJobs) {
      expect(scheduled).not.toContain(jobName);
      expect(mirrorAllowlist).not.toContain(jobName);
      expect(allMigrationSql).toMatch(new RegExp(`cron\\.schedule\\(\\s*'${jobName}'`));
    }
    expect(mirrorAllowlist).toEqual(scheduled.filter((jobName) => !mirrorExclusions.has(jobName)));
    expect(mirrorAllowlist).toEqual(expect.arrayContaining(allowlistedJobs));
    expect(mirrorAllowlist).toEqual(expect.arrayContaining(newlyCoveredJobs));
  });

  it("admits every mirrored jobname in the constraint, the admin catalog and PRODUCT_JOBS", () => {
    const registered = PRODUCT_JOBS.map((job) => job.jobName).sort();
    expect(checkConstraintJobs).toEqual(healthCatalogJobs);
    // Dues, the public event RSVP, union catalog claims, ULP deadlines and SSO
    // are left out of Union Ground. Their schema (and these jobs) stay in
    // the database, inert, but the web operations panel registers none of
    // them, so PRODUCT_JOBS is the catalog minus exactly these jobs.
    const leftOutJobs = [
      "dues-reminders-dispatch-tick",
      "dues-stripe-reconcile-tick",
      "mi1-public-rsvp-retention",
      "organization-claim-retention",
      "casework-ulp-deadline-tick",
      "sso-identity-link-sweep",
    ];
    for (const jobName of leftOutJobs) {
      expect(healthCatalogJobs).toContain(jobName);
      expect(registered).not.toContain(jobName);
    }
    expect(registered).toEqual(healthCatalogJobs.filter((jobName) => !leftOutJobs.includes(jobName)));
    for (const jobName of mirrorAllowlist) expect(checkConstraintJobs).toContain(jobName);
  });

  it("gives each newly covered job a cadence that matches its schedule", () => {
    const cadences = new Map([
      ["casework-alert-escalation-tick", "* * * * *"],
      ["mesh-agency-usage-aggregate-tick", "10 3 * * 1"],
      ["event-checkin-token-retention", "53 4 * * *"],
      ["live-poll-schedule-tick", "* * * * *"],
      ["survey-operations-sweep", "42 * * * *"],
      ["minutes-pre-event-notices-tick", "7 * * * *"],
      ["knowledge-source-health-tick", "15 * * * *"],
      ["organization-automation-tick", "11 * * * *"],
      ["union-ground-organization-retention", "47 3 * * *"],
      ["weekly-question-selection-tick", "18 * * * *"],
      ["chapter-leadership-claims-tick", "10-55/15 * * * *"],
    ]);
    for (const [jobName, cadence] of cadences) {
      expect(getProductJob(jobName)?.cadence).toBe(cadence);
    }
    // The left-out features' jobs are covered by the database mirror but not
    // registered on the web panel, so they have no product cadence to read.
    for (const jobName of ["organization-claim-retention", "mi1-public-rsvp-retention"]) {
      expect(getProductJob(jobName)).toBeFalsy();
    }
    // A weekly job must not be called stale a day and a half after it ran, and
    // an hourly job must not wait a day and a half to be called stale.
    expect(staleAfterMsForCadence("10 3 * * 1")).toBe(8 * 24 * 60 * 60 * 1000);
    expect(staleAfterMsForCadence("11 * * * *")).toBe(3 * 60 * 60 * 1000);
    expect(staleAfterMsForCadence("47 3 * * *")).toBe(36 * 60 * 60 * 1000);
  });

  it("scans cron history before the lifecycle gate and takes the gate only for the upsert", () => {
    // #7299: holding the global gate through the cron-history scan cancelled
    // GoTrue's auth.mfa_factors writes at the gate's 3 s lock_timeout. The
    // reads come first, an idle tick returns before the gate, and the reviewed
    // preamble still precedes the only statement that locks a mirror tuple.
    const preamble = "perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);";
    const firstStatement = currentMirrorBody
      .slice(currentMirrorBody.indexOf("\nbegin\n") + "\nbegin\n".length).trimStart();
    expect(firstStatement.startsWith(preamble)).toBe(false);
    expect(currentMirrorBody.split(preamble)).toHaveLength(2);
    const gateAt = currentMirrorBody.indexOf(preamble);
    const scanAt = currentMirrorBody.indexOf("from cron.job_run_details d");
    const idleAt = currentMirrorBody.indexOf("if pg_catalog.jsonb_array_length(pending_rows) = 0 then");
    const insertAt = currentMirrorBody.indexOf("insert into public.organization_job_runs (");
    expect(currentMirrorBody.indexOf("into window_start")).toBeLessThan(gateAt);
    expect(currentMirrorBody.indexOf("into open_runs")).toBeLessThan(gateAt);
    expect(scanAt).toBeGreaterThan(-1);
    expect(scanAt).toBeLessThan(idleAt);
    expect(idleAt).toBeLessThan(gateAt);
    expect(currentMirrorBody.slice(idleAt, gateAt)).toContain("return 0;");
    expect(currentMirrorBody.slice(gateAt + preamble.length, insertAt).trim()).toBe("");
    expect(currentMirrorBody.slice(gateAt)).not.toContain("cron.job_run_details");
    expect(currentMirrorBody.slice(0, gateAt)).not.toMatch(/\b(insert|update|delete)\s+(into\s+|from\s+)?public\./i);
    // The only writes before the gate are to the mirror's one-row accounting
    // state, made only after the candidates are staged, when the read drained.
    for (const write of ["insert into private.cron_job_health_mirror_state", "update private.cron_job_health_mirror_state"]) {
      expect(currentMirrorBody.indexOf(write)).toBeGreaterThan(currentMirrorBody.indexOf("into pending_rows"));
      expect(currentMirrorBody.indexOf(write)).toBeLessThan(idleAt);
    }
    expect([...currentMirrorBody.slice(0, gateAt).matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+([a-z_]+\.[a-z_]+)/gi)]
      .map((match) => match[1])).toEqual(["private.cron_job_health_mirror_state", "private.cron_job_health_mirror_state"]);
    expect(currentMirrorBody.slice(0, gateAt)).not.toMatch(/\bfor\s+(update|share|no key update|key share)\b/i);
    // #7513 adds one private table, the mirror's hourly full-read marker, and
    // nothing else; no index or trigger anywhere.
    const markerDdl = /(?:create|alter) table private\.cron_job_health_mirror_state\b/g;
    expect(boundSql.match(markerDdl)).toHaveLength(3);
    // #7562 only adds columns to that row's table.
    expect(reconcileSql.match(markerDdl)).toHaveLength(1);
    for (const migration of [gateSql, boundSql.replace(markerDdl, ""), reconcileSql.replace(markerDdl, "")]) {
      expect(migration).not.toMatch(/(?:create|alter|drop)\s+(?:table|index|trigger)/i);
      expect(migration).not.toMatch(/\bgrant\b/i);
      expect(migration).not.toMatch(/\bauth\.(?!uid\(\))/i);
      expect(migration.indexOf(`revoke all on function ${mirrorSignature}`)).toBeGreaterThan(migration.indexOf("$function$;"));
      expect(migration).toContain("from public, anon, authenticated, service_role");
    }
  });

  it("bounds the history scan by a run id it verifies against the history, and deletes no history", () => {
    // #7513: start_time has no index on cron.job_run_details, so the window
    // alone read every retained row. The bound comes from the newest mirrored
    // run six hours before the window, counts only while the history still
    // holds that exact run, and leaves the open-run branch unbounded.
    // tests/cron-job-health-sync-db.test.js replays the previous routine
    // against the live one on the same history. These pins keep #7521's body;
    // #7562 replaced its hourly full read (pinned below).
    const floorAt = boundMirrorBody.indexOf("into runid_floor, floor_started_at");
    const scanAt = boundMirrorBody.indexOf("from cron.job_run_details d");
    expect(floorAt).toBeGreaterThan(boundMirrorBody.indexOf("into window_start"));
    expect(floorAt).toBeLessThan(scanAt);
    for (const pin of [
      "and anchor.started_at < window_start - interval '6 hours'",
      "order by anchor.started_at desc",
      "where floor_run.runid = runid_floor and floor_run.start_time = floor_started_at",
      ") or coalesce(private.cron_run_id_high_water(), 0) < (",
      "select coalesce(pg_catalog.max(newest.runid), 0) from cron.job_run_details newest",
      ") or full_read_at is null or full_read_at < pg_catalog.now() - interval '60 minutes' then",
      "from private.cron_job_health_mirror_state state",
      "on conflict (singleton) do update set last_full_read_at = excluded.last_full_read_at;",
      "if runid_floor = 0 and pg_catalog.jsonb_array_length(pending_rows) < 2000 then",
      "runid_floor := 0;",
      "and ((d.runid > runid_floor and d.runid <= 9223372036854775807 and d.start_time >= window_start)\n      or d.runid = any(open_runs))",
    ]) expect(boundMirrorBody).toContain(pin);
    // A sequence restarted below any retained run hands new runs ids among or
    // under the retained ones; the bound is dropped until the sequence has
    // passed the highest retained id.
    // It only reads the sequence, returns null when it cannot, and no role
    // may call it.
    const highWater = fnBody(boundSql, "private.cron_run_id_high_water()");
    expect(highWater).toContain("stable");
    expect(highWater).toContain("set search_path = ''");
    expect(highWater).not.toContain("security definer");
    expect(highWater).toContain("from pg_catalog.pg_sequences s");
    expect(highWater).toContain("where s.schemaname = 'cron' and s.sequencename = 'runid_seq'");
    expect(highWater).not.toMatch(/\b(?:nextval|setval)\b/i);
    expect(boundSql.indexOf("revoke all on function private.cron_run_id_high_water()"))
      .toBeGreaterThan(boundSql.indexOf("create or replace function private.cron_run_id_high_water()"));
    expect(boundSql.indexOf("create or replace function private.cron_run_id_high_water()"))
      .toBeLessThan(boundSql.indexOf(`create or replace function ${mirrorSignature}`));
    // The hourly full read: the marker is one locked-down row, and the bound
    // is dropped whenever it is missing or an hour old.
    expect(boundSql).toContain("constraint cron_job_health_mirror_state_singleton_check check (singleton)");
    expect(boundSql).toContain("alter table private.cron_job_health_mirror_state force row level security;");
    expect(boundSql).toContain("revoke all on table private.cron_job_health_mirror_state from public, anon, authenticated, service_role;");
    expect(boundSql).not.toMatch(/create policy[^;]*cron_job_health_mirror_state/i);
    expect(boundSql).not.toMatch(/\b(?:delete|truncate)\b[^;]*\bcron\./i);
    expect(boundSql).not.toMatch(/\bcron\.(?:schedule|unschedule|alter_job)\b/i);
    expect(boundSql).not.toMatch(/\bset\s+plan_cache_mode\b/i);
    // Everything the previous body did outside the bound is unchanged.
    const unbounded = fnBody(gateSql, mirrorSignature);
    const withoutBound = boundMirrorBody
      .replace(/ {2}runid_floor bigint;\n {2}floor_started_at timestamptz;\n {2}full_read_at timestamptz;\n/, "")
      .replace(/ {2}select pg_catalog\.substr\(anchor\.run_id[\s\S]*?end if;\n\n/, "")
      .replace(/ {2}if runid_floor = 0 and pg_catalog\.jsonb_array_length\(pending_rows\) < 2000 then[\s\S]*?end if;\n\n/, "")
      .replace("and ((d.runid > runid_floor and d.runid <= 9223372036854775807 and d.start_time >= window_start)\n      or d.runid = any(open_runs))",
        "and (d.start_time >= window_start or d.runid = any(open_runs))");
    const lines = (text) => text.split("\n").filter((line) => line.trim());
    expect(lines(withoutBound)).toEqual(lines(unbounded));
  });

  it("reconciles hourly by probing the run ids no run held instead of reading the whole history", () => {
    // #7562: the hourly whole-history read of #7521 cost 5 to 10 s and grew
    // with the history. A restarted sequence can only log runs at ids no
    // retained run holds, so the state lists those ids up to a checked
    // watermark and the hourly reconciliation probes only them through the
    // primary key. Anything found there, deleted history, or any #7521 check
    // still makes the tick read everything until a read drains.
    for (const pin of [
      "add column checked_through bigint",
      "add column free_runids pg_catalog.int8multirange not null default '{}'::pg_catalog.int8multirange",
      "add column reconciled_at timestamptz",
      "add column deleted_baseline bigint",
      "add column lowest_baseline bigint",
    ]) expect(reconcileSql).toContain(pin);
    for (const pin of [
      "where floor_run.runid = runid_floor and floor_run.start_time = floor_started_at",
      ") or coalesce(private.cron_run_id_high_water(), 0) < (",
      ") or mirror_state.checked_through is null;",
      "or mirror_state.reconciled_at < pg_catalog.now() - interval '60 minutes');",
      "deleted_now is null",
      "or deleted_now is distinct from mirror_state.deleted_baseline",
      "or lowest_now is distinct from mirror_state.lowest_baseline",
      "from pg_catalog.unnest(mirror_state.free_runids) as free(ids)",
      "cross join lateral (",
      "where refilled.runid >= pg_catalog.lower(free.ids) and refilled.runid < pg_catalog.upper(free.ids)",
      // A held run leaves the list only once it is mirrored or started before
      // the window; the probe flags a listed run once it started inside the
      // window (#7622 r1s1/r2s1 and the Muse comparison).
      "and refilled.start_time >= window_start",
      "filter (where held.start_time < window_start or exists (",
      "where held_mirror.job_name = held_job.jobname",
      "and held_mirror.run_id = 'cron:' || held.runid::text",
      "left join cron.job held_job on held_job.jobid = held.jobid",
      "lower_runid := 0;",
      "lower_runid := least(runid_floor, mirror_state.checked_through);",
      "if reconcile and runid_floor > mirror_state.checked_through then",
      "greatest(mirror_state.checked_through, lowest_now - 1), runid_floor, '(]'))",
      "where held.runid > greatest(mirror_state.checked_through, lowest_now - 1) and held.runid <= runid_floor;",
      "if pg_catalog.jsonb_array_length(pending_rows) < 2000 then",
      "values (true, pg_catalog.now(), 0, '{}'::pg_catalog.int8multirange, null, deleted_now, lowest_now)",
      "set checked_through = next_checked, free_runids = next_free, reconciled_at = pg_catalog.now()",
    ]) expect(currentMirrorBody).toContain(pin);
    expect(currentMirrorBody).not.toContain("interval '60 minutes' then");
    // The probe and the watermark extension come before the candidate read.
    const scanAt = currentMirrorBody.indexOf("from cron.job_run_details d");
    expect(currentMirrorBody.indexOf("from cron.job_run_details refilled")).toBeLessThan(scanAt);
    expect(currentMirrorBody.indexOf("from cron.job_run_details held")).toBeLessThan(scanAt);
    expect(reconcileSql).not.toMatch(/\b(?:delete|truncate)\b[^;]*\bcron\./i);
    expect(reconcileSql).not.toMatch(/\bcron\.(?:schedule|unschedule|alter_job)\b/i);
    expect(reconcileSql).not.toMatch(/create policy|\bgrant\b|create table/i);
    expect(reconcileSql).not.toMatch(/\bset\s+plan_cache_mode\b/i);
    // The helper and the row's locked-down table are #7521's, unchanged.
    expect(reconcileSql).not.toContain("private.cron_run_id_high_water() returns");
    expect(reconcileSql).not.toMatch(/row level security/i);
  });

  it("admits the reads before the gate only for this exact installed source", () => {
    // The installed-catalogue inventory requires every graph writer to take the
    // gate first unless its exact source is a reviewed pre-gate read.
    const raw = loadMigrationSql("cron_mirror_reconciles_free_run_ids");
    const declared = raw.indexOf(`create or replace function ${mirrorSignature}`);
    expect(declared).toBeGreaterThan(-1);
    const start = raw.indexOf("as $function$", declared) + "as $function$".length;
    const source = raw.slice(start, raw.indexOf("$function$;", start));
    const name = "private.sync_organization_job_runs_from_cron_history";
    expect(reviewedPreGateRead({ name, source })).toBe(true);
    for (const changed of [
      source.replace("  return 0;\n", "  return 1;\n"),
      source.replace("limit 2000", "limit 20000"),
      `${source} `,
    ]) expect(reviewedPreGateRead({ name, source: changed })).toBe(false);
    expect(reviewedPreGateRead({ name: "private.other_writer", source })).toBe(false);
  });

  it("keeps the reviewed boundary and the incremental contract", () => {
    expect(currentMirrorBody).toContain("security definer");
    expect(currentMirrorBody).toContain("set search_path = ''");
    for (const pin of [
      "pg_catalog.max(mirrored.started_at)",
      "- interval '2 hours'",
      "(d.runid > lower_runid and d.runid <= 9223372036854775807 and d.start_time >= window_start)",
      "or d.runid = any(open_runs))",
      "open_runs bigint[];",
      "where mirrored.id is null",
      "on conflict (job_name, run_id, organization_id) do update",
    ]) {
      expect(currentMirrorBody).toContain(pin);
    }
    expect(coverageSql.indexOf(`revoke all on function ${mirrorSignature}`))
      .toBeGreaterThan(coverageSql.indexOf("$function$;"));
    expect(currentHealthBody).toContain("private.mfa_satisfied()");
    expect(currentHealthBody).toContain("private.has_organization_role(org, array['admin'])");
  });

  it("still satisfies every db-contract pin for the live mirror and constraint", () => {
    const entry = dbContract.functions.find((fn) => fn.sig === mirrorSignature);
    for (const pin of entry.bodyContains) expect(currentMirrorBody).toContain(pin);
    const constraint = dbContract.constraints.find((c) => c.name === "organization_job_runs_job_name_check");
    for (const pin of constraint.defContains) expect(checkConstraintJobs).toContain(pin);
    const contractCron = new Set(dbContract.cron.map((job) => job.jobname));
    for (const jobName of mirrorAllowlist) expect(contractCron).toContain(jobName);
  });
});
