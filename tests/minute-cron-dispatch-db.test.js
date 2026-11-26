// @vitest-environment node
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.RUN_CRON_JOB_HEALTH_SYNC_DB_TESTS === "1" ? describe : describe.skip;
const tasks = ["member-messaging-dispatch", "casework-alert-escalation-tick", "casework-reminder-delivery-tick", "live-poll-schedule-tick", "casework-deadline-reminder-tick", "mi1-job-health-sync"];
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

live("one cron backend executes isolated minute tasks", () => {
  let client, blocker, jobs, command, originalLogger, originalMirror, began, testStarted, taskDefinitions;
  const signatures = ["private.dispatch_due_member_messaging(integer)", "private.casework_escalate_due_alerts(integer)", "private.casework_fire_due_reminders(integer)", "private.run_due_live_poll_transitions(integer)", "private.casework_sweep_deadline_reminders(integer)"];
  const logger = "private.record_minute_cron_task(text,text,timestamptz,text,text)";
  const mirror = "private.sync_organization_job_runs_from_cron_history()";
  const outcomes = async () => (await client.query(`select job_name, status, failure_code, redacted_summary, run_id from public.organization_job_runs where run_id like 'minute:%' and started_at >= $1 order by started_at`, [testStarted])).rows;
  const setBody = async (index, body) => {
    const { ddl, returns_void } = taskDefinitions[index];
    await client.query(ddl.replace(/AS (\$\w*\$)[\s\S]*\1/, `AS $proof$begin ${body}; ${returns_void ? "return;" : "return null;"} end;$proof$`));
  };
  const instrument = async () => {
    for (let i = 0; i < signatures.length; i++) await setBody(i, `insert into pg_temp.minute_probe values ('${tasks[i]}')`);
  };

  beforeAll(async () => {
    const connectionString = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString, ssl: false, application_name: "c69-minute-cron-proof" });
    blocker = new pg.Client({ connectionString, ssl: false, application_name: "c69-minute-cron-lock-proof" });
    await client.connect(); await blocker.connect();
    began = (await client.query("select clock_timestamp() as t")).rows[0].t;
    jobs = (await client.query("select jobname, command, active from cron.job where jobname = any($1::text[])", [tasks])).rows;
    command = jobs.find((j) => j.jobname === "mi1-job-health-sync").command;
    taskDefinitions = [];
    for (const signature of signatures) {
      taskDefinitions.push((await client.query("select pg_get_functiondef(oid) as ddl, prorettype = 'void'::regtype as returns_void from pg_proc where oid = $1::regprocedure", [signature])).rows[0]);
    }
    originalLogger = (await client.query("select pg_get_functiondef($1::regprocedure) as ddl", [logger])).rows[0].ddl;
    originalMirror = (await client.query("select pg_get_functiondef($1::regprocedure) as ddl", [mirror])).rows[0].ddl;
    await client.query("select cron.alter_job(jobid, active := false) from cron.job where jobname = any($1::text[])", [tasks]);
    await client.query("create temporary table minute_probe (step text)");
  });
  beforeEach(async () => {
    await client.query("truncate pg_temp.minute_probe");
    testStarted = (await client.query("select clock_timestamp() as t")).rows[0].t;
  });
  afterEach(async () => {
    if (!client || !jobs) return;
    await client.query("rollback");
    await blocker.query("select pg_advisory_unlock_all()");
    await client.query(originalLogger); await client.query(originalMirror);
    for (const fn of taskDefinitions) await client.query(fn.ddl);
    await client.query("delete from public.organization_job_runs where run_id like 'minute:%' and started_at >= $1", [began]);
  });
  afterAll(async () => {
    if (client && jobs) {
      for (const job of jobs) await client.query("select cron.alter_job(jobid, command := $2::text, active := $3::boolean) from cron.job where jobname=$1", [job.jobname, job.command, job.active]);
      await client.query("delete from public.organization_job_runs where run_id like 'minute:%' and started_at >= $1", [began]);
    }
    await blocker?.end(); await client?.end();
  });

  it("matches the deployed cron inventory including preserved inactive task definitions", async () => {
    const rows = (await client.query("select jobname, schedule, command, active from cron.job")).rows;
    for (const entry of contract.cron) {
      const row = rows.find((j) => j.jobname === entry.jobname);
      expect(row?.schedule).toBe(entry.schedule);
      for (const text of entry.commandContains ?? []) expect(row.command).toContain(text);
    }
    expect(jobs.filter((j) => j.active).map((j) => j.jobname)).toEqual(["mi1-job-health-sync"]);
    // Existing rows continue to join their historical outcomes even though
    // only the dispatcher opens a backend now.
    expect(jobs).toHaveLength(6);
    const matches = (field, n) => field === "*" || field.split(",").some((part) => {
      const [range, step = "1"] = part.split("/");
      const [start, end] = range === "*" ? [0, 59] : range.split("-").map(Number);
      return n >= start && (end === undefined ? n === start : n <= end && (n - start) % Number(step) === 0);
    });
    for (const j of rows) expect(j.schedule.split(" ").slice(2, 4)).toEqual(["*", "*"]);
    let peak = 0;
    for (let day = 0; day < 7; day++) for (let hour = 0; hour < 24; hour++) for (let minute = 0; minute < 60; minute++) {
      peak = Math.max(peak, rows.filter((j) => {
        const [m, h, , , dow] = j.schedule.split(" ");
        const active = jobs.find((old) => old.jobname === j.jobname)?.active ?? j.active;
        return active && matches(m, minute) && matches(h, hour) && matches(dow, day);
      }).length);
    }
    expect(peak).toBe(4);
    const adapter = (await client.query("select pg_get_functiondef('private.run_minute_cron_task(text)'::regprocedure) as ddl")).rows[0].ddl;
    for (const job of jobs.filter((j) => j.jobname !== "mi1-job-health-sync")) {
      const calls = [...job.command.matchAll(/select\s+(private\.[a-z_]+\([^;]*?\))/g)].map((m) => m[1]);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(adapter).toContain(`perform ${call};`);
    }
  });

  it("runs the real retained task commands and records all six original names", async () => {
    await client.query(command);
    const rows = await outcomes();
    expect(rows.map((r) => r.job_name)).toEqual(tasks);
    expect(rows.every((r) => r.status === "completed")).toBe(true);
    expect(rows.every((r) => r.run_id.startsWith("minute:"))).toBe(true);
    await client.query(`select private.sync_organization_job_runs_from_cron_history()`);
    expect(await outcomes()).toEqual(rows);
  });

  it("rolls back only the failed task, commits each successful task and tries all later ones", async () => {
    await instrument();
    await setBody(0, "insert into pg_temp.minute_probe values ('must roll back'); perform 1/0");
    await client.query(command);
    expect((await client.query("select step from pg_temp.minute_probe")).rows.map((r) => r.step)).toEqual(tasks.slice(1, -1));
    const rows = await outcomes();
    expect(rows.map((r) => r.status)).toEqual(["failed", "completed", "completed", "completed", "completed", "completed"]);
    expect(rows[0]).toMatchObject({ failure_code: "cron_failed", redacted_summary: "Scheduled command failed." });
    // The command commits, so a subsequent transaction rollback cannot undo
    // earlier successful tasks or their health records.
    await client.query("begin; rollback");
    expect(await outcomes()).toEqual(rows);
  });

  it("catches the configured eight-second statement timeout and starts fresh deadlines for later tasks", async () => {
    await instrument();
    await setBody(0, "perform pg_sleep(9)");
    await client.query(command);
    const rows = await outcomes();
    expect(rows.map((r) => r.job_name)).toEqual(tasks);
    expect(rows[0]).toMatchObject({ status: "failed", failure_code: "cron_timeout" });
    expect(rows.slice(1).every((r) => r.status === "completed")).toBe(true);
  }, 20_000);

  it("catches a task lock timeout and releases it before the next task", async () => {
    await instrument();
    await blocker.query("select pg_advisory_lock(690069, 69)");
    await setBody(0, "perform pg_advisory_xact_lock(690069, 69)");
    await client.query(command);
    const rows = await outcomes();
    expect(rows[0]).toMatchObject({ status: "failed", failure_code: "cron_failed" });
    expect(rows.slice(1).every((r) => r.status === "completed")).toBe(true);
  }, 15_000);

  it("continues task work if health recording fails without inventing completed runs", async () => {
    await instrument();
    await client.query(`create or replace function private.record_minute_cron_task(p_job_name text, p_run_id text, p_started_at timestamptz, p_status text, p_failure_code text) returns void language plpgsql set search_path = '' as $$begin raise exception 'private proof detail'; end$$`);
    await client.query(command);
    expect((await client.query("select step from pg_temp.minute_probe")).rows.map((r) => r.step)).toEqual(tasks.slice(0, -1));
    expect(await outcomes()).toEqual([]);
  });

  it("reports failure of the mirror itself under its own task name", async () => {
    await instrument();
    await client.query(`create or replace function private.sync_organization_job_runs_from_cron_history() returns integer language plpgsql security definer set search_path = '' set jit = off as $$begin raise exception 'private mirror detail'; end$$`);
    await client.query(command);
    const rows = await outcomes();
    expect(rows).toHaveLength(6);
    expect(rows.at(-1)).toMatchObject({ job_name: "mi1-job-health-sync", status: "failed", failure_code: "cron_failed", redacted_summary: "Scheduled command failed." });
    expect(rows.slice(0, -1).every((r) => r.status === "completed")).toBe(true);
  });

  it("refuses unknown tasks and gives no client role execution rights", async () => {
    await expect(client.query("select private.run_minute_cron_task('not-a-task')")).rejects.toMatchObject({ code: "22023" });
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const signature of [logger, "private.run_minute_cron_task(text)"]) {
        expect((await client.query("select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, signature])).rows[0].allowed).toBe(false);
      }
    }
  });
});
