import { INTEGRATION_PROVIDER_CATALOG, isActivatableProvider } from "./catalog.js";
import { SCIM_GENERIC_PROVIDER_REASON } from "./scim.js";

const JOB_STATUSES = Object.freeze(["queued", "running", "success", "failed", "skipped", "dead"]);
export const JOB_KINDS = Object.freeze([
  "provider_health",
  "connection_probe",
  "webhook_deliver",
  "webhook_retry",
  "constant_contact_sync",
]);

export function planProviderJob({ provider, kind, settings = {}, credentialRef = null }) {
  if (!INTEGRATION_PROVIDER_CATALOG[provider]) return { ok: false, reason: "unknown_provider" };
  if (!JOB_KINDS.includes(kind)) return { ok: false, reason: "unknown_job_kind" };
  if (provider === "scim") return { ok: false, reason: SCIM_GENERIC_PROVIDER_REASON };
  if (!isActivatableProvider(provider) && kind !== "provider_health") {
    return { ok: false, reason: "provider_not_activatable" };
  }

  return {
    ok: true,
    plan: {
      provider,
      kind,
      settings: asPublicSettings(settings),
      credentialRefPresent: Boolean(credentialRef),
      liveNetwork: false,
    },
  };
}

export function transitionJob(job, nextStatus, { now, errorCode = null, processedCount = job.processedCount } = {}) {
  if (!JOB_STATUSES.includes(nextStatus)) return { ok: false, reason: "unknown_status" };
  const allowed = {
    queued: ["running", "skipped"],
    running: ["success", "failed", "skipped"],
    failed: ["queued", "dead"],
    success: [],
    skipped: [],
    dead: [],
  };
  if (!allowed[job.status]?.includes(nextStatus)) return { ok: false, reason: "illegal_transition" };

  return {
    ok: true,
    job: {
      ...job,
      status: nextStatus,
      errorCode,
      processedCount,
      startedAt: nextStatus === "running" ? now : job.startedAt,
      finishedAt: ["success", "failed", "skipped", "dead"].includes(nextStatus) ? now : null,
      attemptCount: nextStatus === "queued" ? job.attemptCount + 1 : job.attemptCount,
    },
  };
}

export function summarizeJobHealth(jobs) {
  const byProvider = {};
  for (const job of jobs) {
    const current = byProvider[job.provider] || { queued: 0, running: 0, success: 0, failed: 0, skipped: 0, dead: 0 };
    if (current[job.status] != null) current[job.status] += 1;
    byProvider[job.provider] = current;
  }
  return byProvider;
}

function asPublicSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};
  const publicSettings = {};
  for (const [key, value] of Object.entries(settings)) {
    if (/secret|token|password|credential/i.test(key)) continue;
    if (typeof value === "string" && value.length <= 80) publicSettings[key] = value;
    if (typeof value === "number" || typeof value === "boolean") publicSettings[key] = value;
  }
  return publicSettings;
}
