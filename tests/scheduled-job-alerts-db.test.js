// @vitest-environment node
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { SCHEDULED_JOB_STALE_AFTER_SECONDS } from "../api/_lib/scheduledJobAlerts.js";

// OPS-UG-SCHEDULED-JOB-FAILURES-RAISE-NO-OPERATOR-ALERT-20261115 (#8881).
// public.claim_scheduled_job_alerts, confirm_scheduled_job_alert and
// release_scheduled_job_alert on a disposable database: who may call them, a
// failing run, the 30-minute limit with its count, one recovery notice, a
// missed interval, a held feature's job, a refused post's release, and a post
// whose delivery was never confirmed. Everything runs inside one transaction
// that rolls back. now() is fixed inside a transaction, so the passage of time
// is simulated by moving the alert state's timestamps back.
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

const FAILING = "union-ground-organization-retention";
const WEEKLY = "mesh-agency-usage-aggregate-tick";
const HELD = "issue-intelligence-weekly-digest";
const LONG_RUN = "ballot-choices-mix";
const SILENT = "task-maintenance-daily";
const JOBS = [FAILING, WEEKLY, HELD, LONG_RUN, SILENT];

live("scheduled job alerts claim, limit, recover, confirm and release", () => {
  let client;
  let runSeq = 0;

  const asService = async (sql, params = []) => {
    await client.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)");
    await client.query("set local role service_role");
    // On a refusal the transaction is aborted; the caller's rollback to its
    // savepoint undoes the role, so it is reset here only after success.
    const { rows } = await client.query(sql, params);
    await client.query("reset role");
    return rows;
  };
  // A claim whose posts were not delivered (yet): the claims stay pending.
  const claimOnly = async (thresholds = SCHEDULED_JOB_STALE_AFTER_SECONDS) => {
    const [{ value }] = await asService("select public.claim_scheduled_job_alerts($1::jsonb) as value", [JSON.stringify(thresholds)]);
    return value.filter((alert) => JOBS.includes(alert.jobName));
  };
  const confirm = async (claimId) => (await asService("select public.confirm_scheduled_job_alert($1::uuid) as value", [claimId]))[0].value;
  const release = async (claimId) => (await asService("select public.release_scheduled_job_alert($1::uuid) as value", [claimId]))[0].value;
  // A tick whose every post was delivered and confirmed, as the route does.
  const claim = async (thresholds) => {
    const alerts = await claimOnly(thresholds);
    for (const alert of alerts) expect(await confirm(alert.claimId)).toBe(true);
    return alerts;
  };
  const run = async (jobName, status, minutesAgo) => {
    runSeq += 1;
    await client.query(
      `insert into public.organization_job_runs (organization_id, job_name, run_id, status, started_at, finished_at, failure_code, redacted_summary)
       values (null, $1, $2, $3, now() - make_interval(secs => $4::double precision * 60),
               case when $3 = 'in_progress' then null else now() - make_interval(secs => $4::double precision * 60) end,
               case when $3 = 'failed' then 'proof_failure_code' end,
               case when $3 = 'failed' then 'Proof failure summary.' end)`,
      [jobName, `scheduled-job-alert-proof-${runSeq}`, status, minutesAgo],
    );
    return `scheduled-job-alert-proof-${runSeq}`;
  };
  // Simulates the given minutes passing since the last alert and the last
  // claim. Only those times move, so which runs fall inside the monitor's
  // watch does not change.
  const later = (minutes) => client.query(
    `update private.scheduled_job_alert_state set alerted_at = alerted_at - make_interval(mins => $1),
       claimed_at = claimed_at - make_interval(mins => $1)
     where job_name = any($2)`,
    [minutes, JOBS],
  );
  const state = async (jobName) => (await client.query(
    "select alerted_at is not null as alerted, open, alert_kind, claim_id, claim_pending from private.scheduled_job_alert_state where job_name = $1", [jobName],
  )).rows[0];

  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "scheduled-job-alerts-proof" });
    await client.connect();
    await client.query("begin");
    await client.query("delete from private.scheduled_job_alert_reported");
    await client.query("delete from private.scheduled_job_alert_state");
    await client.query("delete from public.organization_job_runs where job_name = any($1)", [JOBS]);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback");
    await client.end();
  });

  it("is executable by service_role only, and organizations cannot read its tables", async () => {
    const id = `${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`;
    for (const role of ["anon", "authenticated"]) {
      for (const sql of [
        "select public.claim_scheduled_job_alerts('{}'::jsonb)",
        `select public.confirm_scheduled_job_alert('${id}')`,
        `select public.release_scheduled_job_alert('${id}')`,
        `select private.undo_scheduled_job_alert_claim('${id}')`,
      ]) {
        await client.query("savepoint denied");
        await client.query(`set local role ${role}`);
        await expect(client.query(sql)).rejects.toMatchObject({ code: "42501" });
        await client.query("rollback to savepoint denied");
      }
      for (const table of ["private.scheduled_job_alert_state", "private.scheduled_job_alert_reported"]) {
        const [{ allowed }] = (await client.query("select has_table_privilege($1, $2, 'select') as allowed", [role, table])).rows;
        expect(allowed).toBe(false);
      }
    }
    const [{ allowed }] = (await client.query("select has_function_privilege('service_role', 'private.undo_scheduled_job_alert_claim(uuid)', 'execute') as allowed")).rows;
    expect(allowed).toBe(false);
    await client.query("savepoint missing_claim");
    await client.query("select set_config('request.jwt.claims','{}',true)");
    await expect(client.query("select public.claim_scheduled_job_alerts('{}'::jsonb)")).rejects.toMatchObject({ code: "42501" });
    await client.query("rollback to savepoint missing_claim");
  });

  it("refuses thresholds for an unknown job or outside 60 seconds to two weeks", async () => {
    for (const bad of [[], { "not-a-job": 600 }, { [FAILING]: 59 }, { [FAILING]: 1209601 }, { [FAILING]: 90.5 }, { [FAILING]: "600" }]) {
      await client.query("savepoint invalid");
      await expect(claimOnly(bad)).rejects.toMatchObject({ code: "22023" });
      await client.query("rollback to savepoint invalid");
    }
  });

  it("raises nothing for a job with no runs, even with a threshold", async () => {
    expect(await claim()).toEqual([]);
  });

  it("alerts a failing run once, with its count and times, and ignores failures from before the monitor watched", async () => {
    await run(FAILING, "failed", 45);
    await run(FAILING, "completed", 20);
    await run(FAILING, "failed", 5);
    const [alert, ...rest] = await claim();
    expect(rest).toEqual([]);
    expect(alert).toMatchObject({ jobName: FAILING, kind: "failed", failures: 1 });
    expect(alert.firstFailureAt).toBe(alert.lastFailureAt);
    expect(Object.keys(alert).sort()).toEqual(["claimId", "failures", "firstFailureAt", "jobName", "kind", "lastFailureAt", "lastStartedAt"]);
    expect(JSON.stringify(alert)).not.toMatch(/proof_failure_code|Proof failure summary/);
    expect(await state(FAILING)).toMatchObject({ alerted: true, open: true, alert_kind: "failed", claim_pending: false, claim_id: null });
  });

  it("holds further failures for 30 minutes, then alerts once with the count since the last alert", async () => {
    await run(FAILING, "failed", 3);
    await run(FAILING, "failed", 2);
    expect(await claim()).toEqual([]);
    await later(29);
    expect(await claim()).toEqual([]);
    await later(2);
    const [alert, ...rest] = await claim();
    expect(rest).toEqual([]);
    expect(alert).toMatchObject({ jobName: FAILING, kind: "failed", failures: 2 });
    expect(Date.parse(alert.firstFailureAt)).toBeLessThan(Date.parse(alert.lastFailureAt));
  });

  it("re-raises an alert whose post was refused, and a release only undoes its own pending claim", async () => {
    await later(31);
    await run(FAILING, "failed", 1);
    const [first] = await claimOnly();
    expect(first).toMatchObject({ kind: "failed", failures: 1 });
    expect(await release(first.claimId)).toBe(true);
    expect(await release(first.claimId)).toBe(false);
    expect(await confirm(first.claimId)).toBe(false);
    const [again] = await claimOnly();
    expect(again).toMatchObject({ kind: "failed", failures: 1, firstFailureAt: first.firstFailureAt });
    expect(again.claimId).not.toBe(first.claimId);
    expect(await release(first.claimId)).toBe(false);
    expect(await confirm(again.claimId)).toBe(true);
    // A confirmed alert can no longer be released.
    expect(await release(again.claimId)).toBe(false);
  });

  it("sends one recovery notice when the alerted job next completes", async () => {
    await later(10);
    // Newer than the failed run a minute ago, so it is the job's newest run.
    await run(FAILING, "completed", 0.5);
    const [notice, ...rest] = await claim();
    expect(rest).toEqual([]);
    expect(notice).toMatchObject({ jobName: FAILING, kind: "recovered", failures: 0 });
    expect(await state(FAILING)).toMatchObject({ open: false });
    await later(40);
    expect(await claim()).toEqual([]);
  });

  // Gate round 1 of #9024 (r1s3/r2s3): recovery compares when the run finished.
  // A run already in progress when the alert was raised, that then completes,
  // closes the alert; by start time it never could.
  it("closes an alert when a run that was already in progress at the alert completes", async () => {
    await run(LONG_RUN, "failed", 20);
    const inProgress = await run(LONG_RUN, "in_progress", 15);
    const [alert] = await claim();
    expect(alert).toMatchObject({ jobName: LONG_RUN, kind: "failed", failures: 1 });
    await later(10);
    // The run started 15 minutes ago, before the alert (10 minutes ago), and finishes now.
    expect(await claim()).toEqual([]);
    await client.query("update public.organization_job_runs set status = 'completed', finished_at = now() - interval '1 minute' where run_id = $1", [inProgress]);
    const [notice, ...rest] = await claim();
    expect(rest).toEqual([]);
    expect(notice).toMatchObject({ jobName: LONG_RUN, kind: "recovered" });
    expect(await state(LONG_RUN)).toMatchObject({ open: false });
  });

  it("alerts a missed interval once per stalled run, then recovers when the job runs again", async () => {
    await run(WEEKLY, "completed", 8 * 24 * 60);
    const [overdue, ...rest] = await claim();
    expect(rest).toEqual([]);
    expect(overdue).toMatchObject({ jobName: WEEKLY, kind: "overdue", failures: 0 });
    await later(31);
    expect(await claim()).toEqual([]);
    // Under its threshold the same stall is not overdue at all.
    await client.query("update private.scheduled_job_alert_state set overdue_for = null where job_name = $1", [WEEKLY]);
    expect(await claim({ ...SCHEDULED_JOB_STALE_AFTER_SECONDS, [WEEKLY]: 1209600 })).toEqual([]);
    await later(5);
    await run(WEEKLY, "completed", 1);
    const [notice] = await claim();
    expect(notice).toMatchObject({ jobName: WEEKLY, kind: "recovered" });
  });

  // Gate round 1 of #9024 (r1s2/r2s2): a post that timed out is never
  // confirmed. Its claim holds the job for 30 minutes and is then undone, so
  // the same stall, or the same failures, are offered again: not before, and
  // never silenced for good.
  it("offers an unconfirmed overdue alert again after 30 minutes, and not before", async () => {
    await run(SILENT, "completed", 3 * 24 * 60);
    const [overdue, ...rest] = await claimOnly();
    expect(rest).toEqual([]);
    expect(overdue).toMatchObject({ jobName: SILENT, kind: "overdue" });
    expect(await state(SILENT)).toMatchObject({ claim_pending: true });
    await later(29);
    expect(await claimOnly()).toEqual([]);
    await later(2);
    const [again, ...more] = await claimOnly();
    expect(more).toEqual([]);
    expect(again).toMatchObject({ jobName: SILENT, kind: "overdue", lastStartedAt: overdue.lastStartedAt });
    expect(again.claimId).not.toBe(overdue.claimId);
    expect(await confirm(overdue.claimId)).toBe(false);
    expect(await confirm(again.claimId)).toBe(true);
    // Once delivered, the same stall is not offered again.
    await later(40);
    expect(await claim()).toEqual([]);
  });

  it("offers unconfirmed failures again after 30 minutes with the same count, and not before", async () => {
    await run(SILENT, "failed", 2);
    await run(SILENT, "failed", 1);
    const [failed] = await claimOnly();
    expect(failed).toMatchObject({ jobName: SILENT, kind: "failed", failures: 2 });
    await later(29);
    await run(SILENT, "failed", 0.5);
    expect(await claimOnly()).toEqual([]);
    await later(2);
    const [again] = await claimOnly();
    expect(again).toMatchObject({ jobName: SILENT, kind: "failed", failures: 3, firstFailureAt: failed.firstFailureAt });
    expect(await confirm(again.claimId)).toBe(true);
  });

  it("alerts a held feature's job like any other", async () => {
    await run(HELD, "failed", 4);
    const [alert] = await claim();
    expect(alert).toMatchObject({ jobName: HELD, kind: "failed", failures: 1 });
  });

  it("counts a run that was recorded in progress and failed later, exactly once", async () => {
    const recorded = await run(HELD, "in_progress", 3);
    await later(31);
    expect(await claim()).toEqual([]);
    await client.query("update public.organization_job_runs set status = 'failed', finished_at = now() where run_id = $1", [recorded]);
    const [alert, ...rest] = await claim();
    expect(rest).toEqual([]);
    expect(alert).toMatchObject({ jobName: HELD, kind: "failed", failures: 1 });
    await later(31);
    expect(await claim()).toEqual([]);
  });

  it("leaves every run as it was", async () => {
    const [{ count }] = (await client.query("select count(*)::integer as count from public.organization_job_runs where run_id like 'scheduled-job-alert-proof-%'")).rows;
    expect(count).toBe(runSeq);
    const [{ failed }] = (await client.query("select count(*)::integer as failed from public.organization_job_runs where run_id like 'scheduled-job-alert-proof-%' and status = 'failed'")).rows;
    expect(failed).toBe(11);
  });
});
