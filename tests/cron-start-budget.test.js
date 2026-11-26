// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reviewedPreGateRead } from "../scripts/account-case-graph-inventory.mjs";
import { sourceTransactionProblem } from "../scripts/hosted-migration-apply-runner.mjs";
import { PRODUCT_JOBS, staleAfterMsForCadence } from "../src/features/operations/jobRegistry.js";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("stagger_cron_starts_and_dispatch_minutes"));
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const minuteTasks = ["member-messaging-dispatch", "casework-alert-escalation-tick", "casework-reminder-delivery-tick", "live-poll-schedule-tick", "casework-deadline-reminder-tick", "mi1-job-health-sync"];
const oldSchedules = {
  "notifications-dispatch-tick": "*/5 * * * *", "integration-webhooks-dispatch-tick": "*/5 * * * *", "ballot-choices-mix-recent": "*/5 * * * *",
  "appointment-reminders-tick": "*/10 * * * *", "workload-reminders-tick": "*/10 * * * *", "sso-identity-link-sweep": "*/10 * * * *",
  "issue-intelligence-weekly-digest": "*/10 13-23 * * 1", "analytics-usage-digest": "*/20 13-23 * * *",
  "ballot-notices-tick": "*/15 * * * *", "event-notices-tick": "*/15 * * * *", "chapter-leadership-claims-tick": "*/15 * * * *",
  "weekly-question-selection-tick": "17 * * * *", "survey-operations-sweep": "41 * * * *",
};
const fieldMatches = (field, value) => field === "*" || field.split(",").some((part) => {
  const [range, step = "1"] = part.split("/");
  const [start, end] = range === "*" ? [0, 59] : range.split("-").map(Number);
  return value >= start && (end === undefined ? value === start : value <= end && (value - start) % Number(step) === 0);
});
const starts = (job, day, hour, minute) => {
  const [m, h, , , d] = job.schedule.split(" ");
  return job.active && fieldMatches(m, minute) && fieldMatches(h, hour) && fieldMatches(d, day);
};
const peak = (jobs) => {
  let max = 0;
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m++) {
    max = Math.max(max, jobs.filter((j) => starts(j, d, h, m)).length);
  }
  return max;
};

describe("cron connection start budget", () => {
  it("is accepted by the hosted apply transaction guard", () => {
    expect(sourceTransactionProblem(loadMigrationSql("stagger_cron_starts_and_dispatch_minutes"))).toBeNull();
  });

  it("admits only this exact adapter source before the delegated graph gates", () => {
    const raw = loadMigrationSql("stagger_cron_starts_and_dispatch_minutes");
    const declaration = raw.indexOf("create or replace function private.run_minute_cron_task(p_job_name text)");
    const start = raw.indexOf("as $function$", declaration) + "as $function$".length;
    const source = raw.slice(start, raw.indexOf("$function$;", start));
    const name = "private.run_minute_cron_task";
    expect(reviewedPreGateRead({ name, source })).toBe(true);
    expect(reviewedPreGateRead({ name, source: `${source} ` })).toBe(false);
    expect(reviewedPreGateRead({ name: "private.other_adapter", source })).toBe(false);
    expect(source).not.toMatch(/\b(?:insert\s+into|update|delete\s+from)\s+(?:public|private)\./i);
  });

  it("reduces the full-week maximum from seventeen starts to four and the minute jobs from six to one", () => {
    for (const job of contract.cron) expect(job.schedule.split(" ").slice(2, 4)).toEqual(["*", "*"]);
    const before = contract.cron.map((j) => ({ ...j, active: true, schedule: oldSchedules[j.jobname] ?? j.schedule }));
    expect(peak(before)).toBe(17);
    expect(peak(contract.cron)).toBe(4);
    expect(before.filter((j) => j.schedule === "* * * * *")).toHaveLength(6);
    expect(contract.cron.filter((j) => j.active && j.schedule === "* * * * *").map((j) => j.jobname)).toEqual(["mi1-job-health-sync"]);
  });

  it("keeps each staggered job's hourly frequency, hour/day eligibility and command", () => {
    for (const [name, old] of Object.entries(oldSchedules)) {
      const current = contract.cron.find((j) => j.jobname === name);
      expect(current.schedule.split(" ").slice(1)).toEqual(old.split(" ").slice(1));
      const minutes = (schedule) => Array.from({ length: 60 }, (_, m) => m).filter((m) => fieldMatches(schedule.split(" ")[0], m));
      expect(minutes(current.schedule)).toHaveLength(minutes(old).length);
      expect(minutes(current.schedule)).not.toContain(0);
      expect(sql).toContain(`schedule := '${current.schedule}') from cron.job j where j.jobname = '${name}'`);
      const productJob = PRODUCT_JOBS.find((j) => j.jobName === name);
      if (name === "sso-identity-link-sweep") expect(productJob).toBeUndefined();
      else expect(productJob, name).toMatchObject({ cadence: current.schedule });
    }
    expect(sql).not.toMatch(/(?:update|insert into|delete from) cron\./i);
    // Alter only schedule/active on the original jobs; the command that selects
    // each current time window stays on its original definition.
    expect(sql.match(/command :=/g)).toHaveLength(1);
  });

  it("gives each task its own top-level statement deadline and transaction", () => {
    const command = sql.split("$dispatch$")[1];
    const blocks = command.match(/begin; set local statement_timeout = '8s'; set local lock_timeout = '3s';\s*select private.run_minute_cron_task\('[^']+'\);[ \t]+commit;/g);
    expect(blocks).toHaveLength(6);
    expect(command).not.toMatch(/^[ \t]*(?:begin|commit);[ \t]*$/m);
    for (const task of minuteTasks) {
      expect(contract.cron.find((job) => job.jobname === "mi1-job-health-sync").commandContains)
        .toContain(`select private.run_minute_cron_task('${task}'); commit;`);
    }
    expect([...command.matchAll(/run_minute_cron_task\('([^']+)'\)/g)].map((m) => m[1])).toEqual(minuteTasks);
    for (const name of minuteTasks.slice(0, -1)) expect(sql).toContain(`active := false) from cron.job j where j.jobname = '${name}'`);
    expect(fnBody(sql, "private.run_minute_cron_task(p_job_name text)")).toContain("when query_canceled then");
    expect(sql).toContain("from public, anon, authenticated, service_role");
    expect(sql).not.toMatch(/alter system|use_background_workers|(?:delete|truncate).*cron\.job_run_details/i);
  });

  it("preserves the latest health reader apart from adding direct mirror-task outcomes", () => {
    const old = stripComments(loadMigrationSql("learning_period_engine"));
    const reader = "public.list_organization_job_health()";
    expect(fnBody(sql, reader).replace("'member-messaging-dispatch', 'mi1-job-health-sync',", "'member-messaging-dispatch',")).toBe(fnBody(old, reader));
    expect(sql).not.toContain("create or replace function private.sync_organization_job_runs_from_cron_history");
    expect(PRODUCT_JOBS.find((j) => j.jobName === "mi1-job-health-sync").cadence).toBe("* * * * *");
  });

  it.each([["1-56/5 * * * *", 12], ["4-54/10 * * * *", 22], ["4-49/15 * * * *", 32], ["7-47/20 13-23 * * *", 42]])("retains missing-run thresholds for staggered cadence %s", (cadence, minutes) => {
    expect(staleAfterMsForCadence(cadence)).toBe(minutes * 60_000);
  });
});
