import { PRODUCT_JOBS } from "../../src/features/operations/jobRegistry.js";
import { ALERT_WEBHOOK_ENV_VAR, assertMetadataOnlyAlert, parseAlertWebhookUrl } from "./platformAlerts.js";

// Operator alerts for failing and stalled scheduled jobs
// (OPS-UG-SCHEDULED-JOB-FAILURES-RAISE-NO-OPERATOR-ALERT-20261115, #8881).
//
// api/scheduled-job-alerts.js runs this every five minutes. The database
// (public.claim_scheduled_job_alerts, migration 20261117091100) decides which
// monitored jobs need an alert and claims them: a failed run, a job past its
// expected interval, or a recovery after an alert. At most one failure or
// overdue alert per job per 30 minutes, carrying the count of failed runs
// since the last alert. This module posts each claimed alert to the private
// ug-alerts Slack channel, confirms the claim of a delivered post, and
// releases the claim when the post is refused or never sent, so the next tick
// tries again. A post that timed out is left pending: the database undoes an
// unconfirmed claim after 30 minutes and offers the same alert again then,
// and not before. Silence is the failure this refuses.
//
// Boundaries:
//   * Operator only. Nothing here is visible to an organization; the admin
//     Job health list and the held-job filtering of #8860 are unchanged.
//   * Metadata only. The text is the job name (a closed vocabulary), the alert
//     kind, an integer and timestamps, checked by assertMetadataOnlyAlert. Never
//     an error text, failure code, summary, organization, member data or any
//     secret.
//   * The jobs themselves are never touched: a refused or failed post neither
//     stops nor retries a job.
//   * Off without UG_ALERTS_SLACK_WEBHOOK_URL: nothing is claimed, so turning
//     the channel on later still reports what is unreported.

export const SCHEDULED_JOB_ALERT_KINDS = Object.freeze(["failed", "overdue", "recovered"]);
export const MONITOR_FAILURE_WINDOW_MS = 30 * 60_000;
const POST_TIMEOUT_MS = 5_000;
const MINUTES_PER_WEEK = 7 * 24 * 60;
const JOB_NAMES = new Set(PRODUCT_JOBS.map((job) => job.jobName));

function cronField(field, min, max) {
  const values = new Set();
  for (const part of String(field).split(",")) {
    const match = /^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`unsupported cron field ${field}`);
    let [low, high] = [min, max];
    if (match[1] !== "*") {
      const [from, to] = match[1].split("-").map(Number);
      [low, high] = [from, to ?? (match[2] ? max : from)];
    }
    const step = match[2] ? Number(match[2]) : 1;
    if (low < min || high > max || low > high || step < 1) throw new Error(`unsupported cron field ${field}`);
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return values;
}

// The longest wait, in minutes, between two consecutive firings of a
// five-field cron schedule (UTC, as pg_cron and Vercel run them), over a week.
// Day-of-month and month must be "*": every monitored job's schedule is.
export function maxCronGapMinutes(cadence) {
  const fields = String(cadence ?? "").trim().split(/\s+/);
  if (fields.length !== 5 || fields[2] !== "*" || fields[3] !== "*") throw new Error(`unsupported cron schedule ${cadence}`);
  const minutes = cronField(fields[0], 0, 59);
  const hours = cronField(fields[1], 0, 23);
  const days = cronField(fields[4], 0, 7);
  if (days.has(7)) days.add(0);
  const firings = [];
  for (let day = 0; day < 7; day += 1) {
    if (!days.has(day)) continue;
    for (const hour of [...hours].sort((a, b) => a - b)) {
      for (const minute of [...minutes].sort((a, b) => a - b)) firings.push(day * 1440 + hour * 60 + minute);
    }
  }
  if (!firings.length) throw new Error(`cron schedule never fires: ${cadence}`);
  let gap = firings[0] + MINUTES_PER_WEEK - firings[firings.length - 1];
  for (let index = 1; index < firings.length; index += 1) gap = Math.max(gap, firings[index] - firings[index - 1]);
  return gap;
}

// A job is overdue when its newest run started longer ago than its longest
// scheduled gap plus a margin of half that gap, at least 15 minutes and at
// most two hours: 16 minutes for a minute job, 90 for an hourly one, 26 hours
// for a daily one.
export function staleAfterSeconds(cadence) {
  const gap = maxCronGapMinutes(cadence);
  const margin = Math.min(120, Math.max(15, Math.ceil(gap / 2)));
  return (gap + margin) * 60;
}

export const SCHEDULED_JOB_STALE_AFTER_SECONDS = Object.freeze(Object.fromEntries(
  PRODUCT_JOBS.map((job) => [job.jobName, staleAfterSeconds(job.cadence)]),
));

function cadenceOf(jobName) {
  return PRODUCT_JOBS.find((job) => job.jobName === jobName)?.cadence;
}

function instant(value) {
  const parsed = new Date(String(value ?? ""));
  if (value == null || Number.isNaN(parsed.getTime())) throw new Error("scheduled job alert needs a valid time");
  return parsed;
}

function easternTime(moment) {
  return `${moment.toLocaleString("en-US", { timeZone: "America/New_York", hour12: true })} ET (${moment.toISOString()})`;
}

function environmentLabel(environment) {
  return environment === "production" ? "production" : "preview";
}

function duration(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes} minutes`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} hours`;
  return `${Math.round(minutes / 1440)} days`;
}

export function buildScheduledJobAlertText(alert, environment) {
  const jobName = alert?.jobName;
  const kind = alert?.kind;
  if (!JOB_NAMES.has(jobName)) throw new Error("unknown scheduled job");
  if (!SCHEDULED_JOB_ALERT_KINDS.includes(kind)) throw new Error("unknown scheduled job alert kind");
  const lines = [];
  if (kind === "failed") {
    const failures = alert.failures;
    if (!Number.isSafeInteger(failures) || failures < 1) throw new Error("a failure alert needs a failure count");
    lines.push(
      `Union Ground scheduled job — FAILED (${environmentLabel(environment)})`,
      `job: ${jobName}`,
      `failed runs since the last alert: ${failures}`,
      `first failure: ${easternTime(instant(alert.firstFailureAt))}`,
      `last failure: ${easternTime(instant(alert.lastFailureAt))}`,
    );
  } else if (kind === "overdue") {
    lines.push(
      `Union Ground scheduled job — OVERDUE (${environmentLabel(environment)})`,
      `job: ${jobName}`,
      `newest run started: ${easternTime(instant(alert.lastStartedAt))}`,
      `expected a run within: ${duration(SCHEDULED_JOB_STALE_AFTER_SECONDS[jobName])} (schedule ${cadenceOf(jobName)} UTC)`,
    );
  } else {
    lines.push(
      `Union Ground scheduled job — RECOVERED (${environmentLabel(environment)})`,
      `job: ${jobName}`,
      `completed a run that started: ${easternTime(instant(alert.lastStartedAt))}`,
    );
  }
  lines.push("Check Background job health and the corresponding job logs for the latest run.");
  return assertMetadataOnlyAlert(lines.join("\n"));
}

// The check's own failure, by reason: job health could not be read, or a
// failed post's claim could not be released, so that alert waits 30 minutes.
const MONITOR_FAILURE_LINES = Object.freeze({
  claim: "The five-minute check could not read job health, so failing jobs are not being alerted.",
  release: "An alert could not be posted and its claim could not be released, so it is held back for 30 minutes before it is offered again. Read Background job health now.",
});

export function buildMonitorFailureText(environment, now, reason = "claim") {
  return assertMetadataOnlyAlert([
    `Union Ground scheduled job alerts — CHECK FAILED (${environmentLabel(environment)})`,
    MONITOR_FAILURE_LINES[reason] ?? MONITOR_FAILURE_LINES.claim,
    `observed: ${easternTime(now)}`,
    "Check Background job health and the corresponding job logs for the latest run.",
  ].join("\n"));
}

// posted, rejected (Slack answered with an error), failed (the request never
// completed) or timed_out. A timeout is an unknown outcome: Slack may have
// received the post, so its claim is neither confirmed nor released. It stays
// pending, and the database offers the same alert again 30 minutes later.
async function postText(webhook, text, fetchImpl) {
  try {
    const response = await fetchImpl(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      redirect: "manual",
      credentials: "omit",
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    return response?.ok ? "posted" : "rejected";
  } catch (error) {
    return error?.name === "TimeoutError" || error?.name === "AbortError" ? "timed_out" : "failed";
  }
}

// The deliveries whose claim is released so the next tick raises the alert
// again: Slack refused it, it never left, or its text was refused here.
const RELEASED_DELIVERIES = new Set(["rejected", "failed", "refused_payload"]);

// The check's own failure: at most one notice per warm instance per 30
// minutes. It is not a job run, so the admin Job health list does not change.
let monitorFailureNotedAt = null;

export function resetScheduledJobAlerts() {
  monitorFailureNotedAt = null;
}

async function reportMonitorFailure(webhook, { env, fetchImpl, now, reason }) {
  if (Number.isFinite(monitorFailureNotedAt) && now.getTime() - monitorFailureNotedAt < MONITOR_FAILURE_WINDOW_MS) return "throttled";
  monitorFailureNotedAt = now.getTime();
  const outcome = await postText(webhook, buildMonitorFailureText(env.VERCEL_ENV, now, reason), fetchImpl);
  if (outcome !== "posted") monitorFailureNotedAt = null;
  return outcome;
}

function note(event, fields) {
  try { console.warn(JSON.stringify({ event, ...fields })); } catch { /* logging never fails the tick */ }
}

// One tick. callRpc(name, body) calls the service-role RPC and throws on any
// failure. Returns what happened: outcome (disabled, claim_failed,
// release_failed, done) and, per claimed alert, its job, kind and delivery
// (posted, rejected, failed, timed_out, refused_payload), whether a delivered
// post's claim was confirmed, and whether a refused delivery's claim was
// released. An unconfirmed delivered post may repeat once, 30 minutes later.
// A release that throws holds that alert back for 30 minutes, so the tick
// posts CHECK FAILED and reports release_failed.
export async function runScheduledJobAlerts({ callRpc, env = process.env, fetchImpl = fetch, now = new Date() }) {
  const webhook = parseAlertWebhookUrl(env[ALERT_WEBHOOK_ENV_VAR]);
  if (!webhook) return { outcome: "disabled", alerts: [] };
  let claimed;
  try {
    claimed = await callRpc("claim_scheduled_job_alerts", { p_stale_after_seconds: SCHEDULED_JOB_STALE_AFTER_SECONDS });
    if (!Array.isArray(claimed)) throw new Error("unreadable claim");
  } catch {
    const monitor = await reportMonitorFailure(webhook, { env, fetchImpl, now, reason: "claim" });
    note("scheduled-job-alerts", { outcome: "claim_failed", monitor });
    return { outcome: "claim_failed", monitor, alerts: [] };
  }
  const alerts = [];
  let releaseFailed = false;
  for (const alert of claimed) {
    let delivery;
    try {
      delivery = await postText(webhook, buildScheduledJobAlertText(alert, env.VERCEL_ENV), fetchImpl);
    } catch {
      delivery = "refused_payload";
    }
    let released = false;
    let confirmed = false;
    if (delivery === "posted" && typeof alert?.claimId === "string") {
      try {
        confirmed = (await callRpc("confirm_scheduled_job_alert", { p_claim_id: alert.claimId })) === true;
      } catch {
        confirmed = false;
      }
    }
    if (RELEASED_DELIVERIES.has(delivery) && typeof alert?.claimId === "string") {
      try {
        released = (await callRpc("release_scheduled_job_alert", { p_claim_id: alert.claimId })) === true;
      } catch {
        releaseFailed = true;
      }
    }
    const jobName = JOB_NAMES.has(alert?.jobName) ? alert.jobName : "unknown";
    const kind = SCHEDULED_JOB_ALERT_KINDS.includes(alert?.kind) ? alert.kind : "unknown";
    alerts.push({ jobName, kind, delivery, confirmed, released });
  }
  const summary = alerts.map(({ jobName, kind, delivery, confirmed, released }) => `${jobName}:${kind}:${delivery}${confirmed ? ":confirmed" : ""}${released ? ":released" : ""}`);
  if (releaseFailed) {
    const monitor = await reportMonitorFailure(webhook, { env, fetchImpl, now, reason: "release" });
    note("scheduled-job-alerts", { outcome: "release_failed", monitor, alerts: summary });
    return { outcome: "release_failed", monitor, alerts };
  }
  note("scheduled-job-alerts", { outcome: "done", alerts: summary });
  return { outcome: "done", alerts };
}
