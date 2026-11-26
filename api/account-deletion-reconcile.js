import { randomUUID, timingSafeEqual } from "node:crypto";

import { pinnedSampleSupabaseOrigin, sampleBackendContract, supabaseRefFromOrigin } from "../src/lib/sampleBackend.js";
import { productionBackendFromEnv } from "./_lib/backend.js";
import { cronAuthorization, cronRefusalBody } from "./_lib/cronAuth.js";
import { json, methodGuard, supabaseRpc } from "./_lib/http.js";

const BATCH_LIMIT = 25;
const MONITOR_TIMEOUT_MS = 12_000;
const RECONCILE_TIMEOUT_MS = 20_000;

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ""));
  const right = Buffer.from(String(rightValue || ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizedOrigin(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:"
        || parsed.username
        || parsed.password
        || parsed.port
        || parsed.pathname !== "/"
        || parsed.search
        || parsed.hash) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function isolatedProductionBackend(backend, env = process.env) {
  const productionOrigin = normalizedOrigin(backend.url);
  const productionRef = supabaseRefFromOrigin(productionOrigin);
  const pinnedSampleOrigin = normalizedOrigin(pinnedSampleSupabaseOrigin());
  const pinnedSampleRef = sampleBackendContract().sampleSupabaseRef;
  const configuredSampleValue = String(
    env.SAMPLE_SUPABASE_URL || env.VITE_SAMPLE_SUPABASE_URL || "",
  ).trim();
  const configuredSampleOrigin = normalizedOrigin(configuredSampleValue);
  const configuredSampleKey = String(env.SAMPLE_SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const productionKey = String(backend.serviceRoleKey || "");

  return Boolean(
    productionOrigin
      && productionRef
      && productionKey
      && productionRef !== pinnedSampleRef
      && productionOrigin !== pinnedSampleOrigin
      && (!configuredSampleValue || configuredSampleOrigin)
      && (!configuredSampleOrigin || productionOrigin !== configuredSampleOrigin)
      && (!configuredSampleKey || !safeEqual(productionKey, configuredSampleKey)),
  );
}

export default async function handler(request, response) {
  if (methodGuard(request, ["GET"], () => json(response, 405, { ok: false, error: "method_not_allowed" }))) return;
  const cron = cronAuthorization(request);
  if (!cron.ok) return json(response, cron.status, cronRefusalBody(cron, { ok: false }));

  // This job always targets the production backend directly. Host-derived
  // routing would let a scheduled request delivered through the SAMPLE origin
  // reconcile the wrong database.
  const backend = productionBackendFromEnv(process.env);
  if (!isolatedProductionBackend(backend, process.env)) {
    return json(response, 503, { ok: false, error: "production_backend_isolation_required" });
  }

  const runId = `account-deletion-${randomUUID()}`;
  const callRpc = (name, body, timeoutMs) => supabaseRpc(
    backend.url,
    backend.serviceRoleKey,
    backend.serviceRoleKey,
    name,
    body,
    { timeoutMs },
  );
  const recordRun = (status, failureClass = null) => callRpc(
    "record_account_deletion_reconcile_job_run",
    { p_run_id: runId, p_status: status, p_failure_class: failureClass },
    MONITOR_TIMEOUT_MS,
  );

  try {
    await recordRun("in_progress");
  } catch {
    return json(response, 503, { ok: false, error: "monitoring_unavailable" });
  }

  let reconciled;
  try {
    reconciled = await callRpc(
      "reconcile_pending_account_deletions",
      { p_limit: BATCH_LIMIT },
      RECONCILE_TIMEOUT_MS,
    );
  } catch {
    await recordRun("failed", "reconcile_unavailable").catch(() => null);
    return json(response, 503, { ok: false, error: "reconciliation_unavailable" });
  }

  if (!Number.isInteger(reconciled) || reconciled < 0 || reconciled > BATCH_LIMIT) {
    await recordRun("failed", "contract_drift").catch(() => null);
    return json(response, 502, { ok: false, error: "reconciliation_contract_drift" });
  }

  try {
    await recordRun("completed");
  } catch {
    return json(response, 503, { ok: false, error: "monitoring_unavailable" });
  }

  return json(response, 200, { ok: true, reconciled, limit: BATCH_LIMIT });
}
