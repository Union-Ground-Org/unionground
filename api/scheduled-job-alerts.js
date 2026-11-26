
import { pinnedSampleSupabaseOrigin, sampleBackendContract, supabaseRefFromOrigin } from "../src/lib/sampleBackend.js";
import { productionBackendFromEnv } from "./_lib/backend.js";
import { json, methodGuard, supabaseRpc } from "./_lib/http.js";
import { constantTimeEqual as safeEqual, cronAuthorization, cronRefusalBody } from "./_lib/cronAuth.js";
import { runScheduledJobAlerts } from "./_lib/scheduledJobAlerts.js";

// Five-minute operator alerts for failing and stalled scheduled jobs
// (OPS-UG-SCHEDULED-JOB-FAILURES-RAISE-NO-OPERATOR-ALERT-20261115,).
// See api/_lib/scheduledJobAlerts.js and
//
// Vercel authenticates a cron call with the CRON_SECRET bearer only (it sends
// no documented x-vercel-cron header), so this route checks exactly that, as
// api/account-deletion-reconcile.js does. Requiring the header would refuse
// every real tick and no job failure would ever reach the operator.
//
// Production only: an authenticated cron tick always resolves the production
// backend, so the request host cannot choose the database, and a
// production backend that is, or shares a key with, the SAMPLE project is
// refused before any call, exactly as api/account-deletion-reconcile.js
// refuses it. The answer carries counts only, never a job's details.
const RPC_TIMEOUT_MS = 15_000;

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
  } catch { // swallow-ok: an unparseable origin is no origin, and the isolation check then refuses it
    return "";
  }
}

// The same predicate as api/account-deletion-reconcile.js.
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
  // The shared rule (./_lib/cronAuth.js): a missing, short or placeholder
  // CRON_SECRET authorizes nobody.
  const cron = cronAuthorization(request);
  if (!cron.ok) return json(response, cron.status, cronRefusalBody(cron, { ok: false }));
  const backend = productionBackendFromEnv(process.env);
  if (!isolatedProductionBackend(backend, process.env)) {
    return json(response, 503, { ok: false, error: "production_backend_isolation_required" });
  }
  const callRpc = (name, body) => supabaseRpc(backend.url, backend.serviceRoleKey, backend.serviceRoleKey, name, body, { timeoutMs: RPC_TIMEOUT_MS });
  const result = await runScheduledJobAlerts({ callRpc });
  if (result.outcome === "claim_failed") return json(response, 503, { ok: false, error: "job_health_unavailable" });
  // A failed post whose claim could not be released is not raised again, so
  // the tick answers as failed, after the CHECK FAILED notice was tried.
  if (result.outcome === "release_failed") return json(response, 503, { ok: false, error: "alert_release_failed" });
  const count = (delivery) => result.alerts.filter((alert) => alert.delivery === delivery).length;
  return json(response, 200, {
    ok: true,
    outcome: result.outcome,
    posted: count("posted"),
    undelivered: result.alerts.length - count("posted"),
  });
}
