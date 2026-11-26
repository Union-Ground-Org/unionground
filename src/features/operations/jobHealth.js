// Last-run health, redaction, and organization-scoped remediations.

import { isUuid } from "./auditEnvelope.js";
import {
  JOB_REMEDIATIONS,
  JOB_STATUSES,
  PRODUCT_JOBS,
  getProductJob,
  staleAfterMsForCadence,
} from "./jobRegistry.js";

export const JOB_FAILURE_CODES = Object.freeze([
  "timeout",
  "provider_unset",
  "provider_rejected",
  "authorization",
  "transient",
  "invariant",
  "cron_failed",
  "unknown",
]);

const SECRETISH = /(bearer\s+[a-z0-9._~+/-]+=*|eyj[a-z0-9._-]+|sk-[a-z0-9]+)/i;
const EMAILISH = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const URLISH = /https?:\/\/\S+/i;

export function redactJobFailure(message) {
  if (message == null || message === "") return { failureCode: null, failureSummary: null };
  const text = String(message);
  if (SECRETISH.test(text) || EMAILISH.test(text) || URLISH.test(text) || text.length > 180) {
    return { failureCode: classifyFailure(text), failureSummary: null };
  }
  return { failureCode: classifyFailure(text), failureSummary: text.slice(0, 80) };
}

function classifyFailure(text) {
  const lower = text.toLowerCase();
  if (lower.includes("timeout") || lower.includes("timed out")) return "timeout";
  if (lower.includes("unset") || lower.includes("not configured")) return "provider_unset";
  if (lower.includes("401") || lower.includes("403") || lower.includes("denied")) return "authorization";
  if (lower.includes("429") || lower.includes("temporar") || lower.includes("econnreset")) return "transient";
  if (lower.includes("invariant") || lower.includes("check constraint")) return "invariant";
  if (lower.includes("reject") || lower.includes("invalid")) return "provider_rejected";
  return "unknown";
}

function normalizeJobRun(row) {
  if (!row || !getProductJob(row.jobName)) return null;
  if (row.status && !JOB_STATUSES.includes(row.status)) return null;
  const redacted = redactJobFailure(row.errorMessage);
  const inferredFailureCode = row.status === "failed" ? redacted.failureCode : null;
  const failureCode = JOB_FAILURE_CODES.includes(row.failureCode)
    ? row.failureCode
    : inferredFailureCode || (row.failureCode ? "unknown" : null);
  return Object.freeze({
    jobName: row.jobName,
    runId: typeof row.runId === "string" ? row.runId : null,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    status: row.status ?? null,
    durationMs: Number.isSafeInteger(row.durationMs) ? row.durationMs : null,
    failureCode,
    failureSummary: redacted.failureSummary,
    organizationId: isUuid(row.organizationId) ? row.organizationId : null,
  });
}

export function normalizePersistedJobHealthRows(rows, selectedOrganizationId) {
  if (!isUuid(selectedOrganizationId) || !Array.isArray(rows)) {
    return { runs: [], acknowledgements: [] };
  }
  const selectedRows = rows.filter((row) => (
    row
    && row.organizationId === selectedOrganizationId
    && getProductJob(row.jobName)
  ));
  return {
    runs: selectedRows.flatMap((row) => (
      typeof row.lastRunId === "string" && row.lastRunId
        ? [{
          jobName: row.jobName,
          runId: row.lastRunId,
          status: row.lastStatus,
          startedAt: row.lastStartedAt,
          completedAt: row.lastFinishedAt,
          failureCode: row.failureCode,
          errorMessage: row.redactedSummary,
          durationMs: Number.isSafeInteger(row.durationMs) ? row.durationMs : null,
          organizationId: selectedOrganizationId,
        }]
        : []
    )),
    acknowledgements: selectedRows.flatMap((row) => (
      row.acknowledged === true
      && typeof row.lastRunId === "string"
      && row.lastRunId
        ? [{
          organizationId: selectedOrganizationId,
          jobName: row.jobName,
          runId: row.lastRunId,
          remediation: row.remediation,
        }]
        : []
    )),
  };
}

function acknowledgementFor(job, organizationId, acknowledgements = []) {
  return acknowledgements.find((entry) => (
    entry.jobName === job.jobName
    && entry.organizationId === organizationId
    && entry.runId === job.lastRun?.runId
  )) ?? null;
}

export function scoreJobHealth(job, nowMs = Date.now()) {
  if (!job.lastRun) return "never_run";
  if (!JOB_STATUSES.includes(job.lastRun.status)) return "never_run";
  const acknowledged = job.acknowledgement?.remediation === "acknowledge";
  if (job.lastRun.status === "failed") {
    return acknowledged ? "acknowledged" : "failing";
  }
  if (job.lastRun.status === "skipped") {
    const skippedAt = Date.parse(job.lastRun.completedAt || job.lastRun.startedAt);
    if (Number.isFinite(skippedAt) && nowMs - skippedAt > staleAfterMsForCadence(job.cadence)) {
      return acknowledged ? "acknowledged" : "stale";
    }
    return "skipped";
  }
  if (job.lastRun.status === "in_progress") {
    const started = Date.parse(job.lastRun.startedAt);
    if (!Number.isFinite(started)) return "never_run";
    return nowMs - started > staleAfterMsForCadence(job.cadence)
      ? (acknowledged ? "acknowledged" : "stale")
      : "running";
  }
  const completed = job.lastRun.completedAt ? Date.parse(job.lastRun.completedAt) : Date.parse(job.lastRun.startedAt);
  if (!Number.isFinite(completed)) return "never_run";
  if (nowMs - completed > staleAfterMsForCadence(job.cadence)) {
    return acknowledged ? "acknowledged" : "stale";
  }
  return "healthy";
}

/**
 * @param {{
 *   runs?: Array<{
 *     jobName: string,
 *     runId?: string | null,
 *     startedAt?: string | null,
 *     completedAt?: string | null,
 *     status?: string | null,
 *     durationMs?: number | null,
 *     failureCode?: string | null,
 *     errorMessage?: string | null,
 *     organizationId?: string | null
 *   }>,
 *   acknowledgements?: Array<{
 *     jobName: string,
 *     runId: string,
 *     organizationId: string,
 *     remediation?: string | null
 *   }>,
 *   selectedOrganizationId?: string | null,
 *   nowMs?: number
 * }} options
 */
export function buildJobHealthDesk({
  runs = [],
  acknowledgements = [],
  selectedOrganizationId,
  nowMs = Date.now(),
} = {}) {
  if (!isUuid(selectedOrganizationId)) return [];
  const latestByJob = new Map();
  for (const raw of runs) {
    const run = normalizeJobRun(raw);
    if (!run) continue;
    if (run.organizationId && run.organizationId !== selectedOrganizationId) continue;
    const current = latestByJob.get(run.jobName);
    if (!current || Date.parse(run.startedAt || 0) > Date.parse(current.startedAt || 0)) {
      latestByJob.set(run.jobName, run);
    }
  }

  return PRODUCT_JOBS.map((catalog) => {
    const lastRun = latestByJob.get(catalog.jobName) ?? null;
    const job = {
      ...catalog,
      lastRun,
      acknowledgement: null,
    };
    job.acknowledgement = acknowledgementFor(job, selectedOrganizationId, acknowledgements);
    const health = scoreJobHealth(job, nowMs);
    return Object.freeze({
      ...catalog,
      lastRun,
      health,
      acknowledgement: job.acknowledgement,
      remediations: health === "failing" || health === "stale" ? JOB_REMEDIATIONS : [],
    });
  });
}

export function createJobAcknowledgement({
  organizationId,
  actorUserId,
  jobName,
  runId,
  acknowledgedAt,
}) {
  if (!isUuid(organizationId)) throw new Error("job acknowledgement requires an organization");
  if (!isUuid(actorUserId)) throw new Error("job acknowledgement requires an actor");
  if (!getProductJob(jobName)) throw new Error("unknown product job");
  if (typeof runId !== "string" || runId.length > 160) throw new Error("job run id is required");
  return Object.freeze({
    organizationId,
    actorUserId,
    jobName,
    runId,
    acknowledgedAt: acknowledgedAt ?? new Date().toISOString(),
    remediation: "acknowledge",
  });
}

export function createJobRetryRequest({
  organizationId,
  actorUserId,
  jobName,
  runId,
  requestedAt,
}) {
  createJobAcknowledgement({
    organizationId,
    actorUserId,
    jobName,
    runId,
    acknowledgedAt: requestedAt,
  });
  return Object.freeze({
    organizationId,
    actorUserId,
    jobName,
    runId,
    requestedAt: requestedAt ?? new Date().toISOString(),
    remediation: "request_retry",
    executesJob: false,
  });
}
