// CR-107 product job catalog. Names match current pg_cron / Vercel schedules.
// Platform jobs are visible to organization admins; they never become a
// second tenant key.

export const JOB_STATUSES = Object.freeze([
  "in_progress",
  "completed",
  "failed",
  "skipped",
]);

export const JOB_HEALTH_STATES = Object.freeze([
  "healthy",
  "running",
  "skipped",
  "stale",
  "failing",
  "never_run",
  "acknowledged",
]);

export const JOB_REMEDIATIONS = Object.freeze(["acknowledge", "request_retry"]);

export const PRODUCT_JOBS = Object.freeze([
  {
    jobName: "mi1-job-health-sync",
    title: "Scheduled job health sync",
    cadence: "* * * * *",
    owner: "operations",
    scope: "platform",
  },
  {
    jobName: "integration-webhooks-dispatch-tick",
    title: "Integration webhook dispatch",
    cadence: "2-57/5 * * * *",
    owner: "integrations",
    scope: "platform",
    backupSchedule: "15 12 * * *",
  },
  {
    jobName: "notifications-dispatch-tick",
    title: "Notification dispatch",
    cadence: "1-56/5 * * * *",
    owner: "communications",
    scope: "platform",
    backupSchedule: "0 12 * * *",
  },
  {
    jobName: "account-deletion-reconcile-tick",
    title: "Account deletion reconciliation",
    cadence: "*/10 * * * *",
    owner: "security",
    scope: "platform",
  },
  {
    jobName: "notifications-expiry-sweep",
    title: "Notification expiry sweep",
    cadence: "20 4 * * *",
    owner: "communications",
    scope: "platform",
  },
  {
    jobName: "deadline-notices-tick",
    title: "Issue deadline notices",
    cadence: "5 13 * * *",
    owner: "casework",
    scope: "platform",
  },
  {
    jobName: "ballot-notices-tick",
    title: "Vote notices",
    cadence: "4-49/15 * * * *",
    owner: "voice",
    scope: "platform",
  },
  {
    jobName: "event-notices-tick",
    title: "Meeting notices",
    cadence: "5-50/15 * * * *",
    owner: "community_events",
    scope: "platform",
  },
  {
    jobName: "appointment-reminders-tick",
    title: "One-on-one reminders",
    cadence: "4-54/10 * * * *",
    owner: "casework",
    scope: "platform",
  },
  {
    jobName: "member-messaging-dispatch",
    title: "Worker messaging dispatch",
    cadence: "* * * * *",
    owner: "communications",
    scope: "platform",
  },
  {
    jobName: "workload-reminders-tick",
    title: "Workplace log reminders",
    cadence: "9-59/10 * * * *",
    owner: "casework",
    scope: "platform",
  },
  {
    jobName: "ballot-choices-mix",
    title: "Vote-choice mixing",
    cadence: "43 4 * * *",
    owner: "voice",
    scope: "platform",
  },
  {
    jobName: "ballot-choices-mix-recent",
    title: "Recent vote-choice mixing",
    cadence: "3-58/5 * * * *",
    owner: "voice",
    scope: "platform",
  },
  {
    jobName: "task-files-reconcile-tick",
    title: "Task-file reconciliation",
    cadence: "37 4 * * *",
    owner: "knowledge",
    scope: "platform",
    backupSchedule: "30 12 * * *",
  },
  {
    jobName: "task-maintenance-daily",
    title: "Task maintenance",
    cadence: "17 4 * * *",
    owner: "operations",
    scope: "platform",
  },
  // OPS-UG-CRON-HEALTH-MIRROR-OMITS-SIX-JOBS-20260921: six jobs were
  // scheduled after this catalog was last touched, so their failures never
  // reached the desk. 20260925000100 mirrors them and admits them in the
  // job-name constraint; tests/cron-job-health-sync-migration.test.js derives
  // the scheduled set from the migrations and holds both lists to it.
  {
    jobName: "casework-alert-escalation-tick",
    title: "Issue alert escalation",
    cadence: "* * * * *",
    owner: "casework",
    scope: "platform",
  },
  {
    jobName: "casework-reminder-delivery-tick",
    title: "Issue reminder delivery",
    cadence: "* * * * *",
    owner: "casework",
    scope: "platform",
  },
  {
    jobName: "weekly-question-selection-tick",
    title: "Weekly question selection",
    cadence: "18 * * * *",
    owner: "voice",
    scope: "platform",
  },
  {
    // REQ-UG-LIVE-POLL-SCHEDULED-OPEN-CLOSE-20261001.
    jobName: "live-poll-schedule-tick",
    title: "Live poll scheduled open and close",
    cadence: "* * * * *",
    owner: "voice",
    scope: "platform",
  },
  {
    // REQ-UG-SURVEY-ESCALATION-AND-FOLLOWUP-TASKS-20261001.
    jobName: "survey-operations-sweep",
    title: "Survey follow-up and escalation sweep",
    cadence: "42 * * * *",
    owner: "voice",
    scope: "platform",
  },
  {
    // REQ-UG-MINUTES-PRE-EVENT-DISPATCH-20261001.
    jobName: "minutes-pre-event-notices-tick",
    title: "Pre-meeting minutes notices",
    cadence: "7 * * * *",
    owner: "communications",
    scope: "platform",
  },
  {
    // REQ-UG-TRUSTED-SOURCE-STALENESS-CHECK-20261001.
    jobName: "knowledge-source-health-tick",
    title: "Trusted source health check",
    cadence: "15 * * * *",
    owner: "knowledge",
    scope: "platform",
  },
  {
    jobName: "organization-automation-tick",
    title: "Organization automation",
    cadence: "11 * * * *",
    owner: "operations",
    scope: "platform",
  },
  {
    jobName: "mi1-analytics-receipt-retention",
    title: "Analytics save receipt retention purge",
    cadence: "23 4 * * *",
    owner: "operations",
    scope: "platform",
  },
  {
    jobName: "event-checkin-token-retention",
    title: "Meeting check-in token retention purge",
    cadence: "53 4 * * *",
    owner: "community_events",
    scope: "platform",
  },
  {
    jobName: "union-ground-organization-retention",
    title: "Organization retention engine",
    cadence: "47 3 * * *",
    owner: "security",
    scope: "platform",
  },
  {
    jobName: "mesh-agency-usage-aggregate-tick",
    title: "Mesh agency usage aggregation",
    cadence: "10 3 * * 1",
    owner: "operations",
    scope: "platform",
  },
  {
    jobName: "casework-retaliation-timing-tick",
    title: "Timing notes after organizing activity",
    cadence: "23 * * * *",
    owner: "casework",
    scope: "platform",
  },
  {
    jobName: "casework-deadline-reminder-tick",
    title: "Issue deadline reminders and missed marking",
    cadence: "* * * * *",
    owner: "casework",
    scope: "platform",
  },
  {
    // Mondays every ten minutes from 9 AM ET: bounded continuation batches.
    jobName: "issue-intelligence-weekly-digest",
    title: "Weekly issue digest",
    cadence: "8-58/10 13-23 * * 1",
    owner: "operations",
    scope: "platform",
  },
  {
    jobName: "analytics-usage-digest",
    title: "Weekly and monthly usage digest",
    cadence: "7-47/20 13-23 * * *",
    owner: "operations",
    scope: "platform",
  },
  {
    // #6940: learning period reminders, then close and the ended notice.
    jobName: "learning-period-end-tick",
    title: "Learning period end",
    cadence: "11 * * * *",
    owner: "operations",
    scope: "platform",
  },
  {
    // #6694: stores the last completed Eastern week of Pulse figures once.
    jobName: "pulse-weekly-snapshots",
    title: "Pulse weekly history snapshots",
    cadence: "23 10 * * *",
    owner: "operations",
    scope: "platform",
  },
  {
    // REQ-UG-CHAPTER-LEADERSHIP-RECOVERY-20261001: grants or lapses chapter
    // leadership claims whose cooling-off window has ended.
    jobName: "chapter-leadership-claims-tick",
    title: "Campaign leadership claim finalization",
    cadence: "10-55/15 * * * *",
    owner: "governance",
    scope: "platform",
  },
]);

export function getProductJob(jobName) {
  return PRODUCT_JOBS.find((job) => job.jobName === jobName) ?? null;
}

export function isProductJob(jobName) {
  return Boolean(getProductJob(jobName));
}

export function staleAfterMsForCadence(cadence) {
  if (typeof cadence !== "string") return 36 * 60 * 60 * 1000;
  if (cadence === "* * * * *") return 3 * 60 * 1000;
  const step = cadence.match(/^(?:\*|\d+-\d+)\/(\d+)\s/);
  if (step) return (Number(step[1]) * 2 + 2) * 60 * 1000;
  // Everything else is a fixed-minute schedule, and the daily default is wrong
  // in both directions for the cadences OPS-UG-CRON-HEALTH-MIRROR-OMITS-SIX
  // -JOBS-20260921 added: an hourly job would go a day and a half unnoticed,
  // and a weekly one would be reported stale five days before it is due.
  const [, hour, dayOfMonth, month, dayOfWeek] = cadence.trim().split(/\s+/);
  if (dayOfWeek && dayOfWeek !== "*" && dayOfMonth === "*") return 8 * 24 * 60 * 60 * 1000;
  if (hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return 3 * 60 * 60 * 1000;
  return 36 * 60 * 60 * 1000;
}

export function deriveJobRunId(jobName, bucketIso, resolution = "minute") {
  if (!isProductJob(jobName)) throw new Error("unknown product job");
  if (typeof bucketIso !== "string" || Number.isNaN(Date.parse(bucketIso))) {
    throw new Error("job run bucket must be an ISO timestamp");
  }
  const length = resolution === "day" ? 10 : resolution === "hour" ? 13 : 16;
  return `${jobName}:${bucketIso.slice(0, length)}`;
}

export function claimJobRun(existingRunIds, jobName, bucketIso, resolution = "minute") {
  const runId = deriveJobRunId(jobName, bucketIso, resolution);
  if (existingRunIds.has(runId)) {
    return { claimed: false, runId };
  }
  existingRunIds.add(runId);
  return { claimed: true, runId };
}
