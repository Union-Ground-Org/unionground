import { resolveSupabaseBackend } from "./_lib/backend.js";
import { cronAuthorization, cronRefusalBody } from "./_lib/cronAuth.js";
import {
  CONSTANT_CONTACT_FINALIZATION_RESERVE_MS,
  constantContactPublicStatus,
  constantContactSecrets,
  fetchConstantContactMember,
  requestConstantContactToken,
} from "./_lib/constantContact.js";
import { bearerToken, json, methodGuard, requireEnv, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";

const INVOCATION_BUDGET_MS = 50_000;

function safeBody(body) {
  if (body && typeof body === "object") return body;
  try {
    return JSON.parse(String(body || "{}"));
  } catch {
    return {};
  }
}

function safeLog(kind, extra = {}) {
  console.error("[constant-contact-sync]", { kind, ...extra });
}

async function serviceRpc(backend, name, body = {}) {
  return supabaseRpc(backend.url, backend.serviceRoleKey, backend.serviceRoleKey, name, body, { timeoutMs: 12_000 });
}

async function finish(backend, jobId, counters, errorCode = null) {
  return serviceRpc(backend, "complete_constant_contact_sync_job", {
    p_job_id: jobId,
    p_processed_count: counters.processed,
    p_matched_count: counters.matched,
    p_not_found_count: counters.notFound,
    p_failed_count: counters.failed,
    p_error_code: errorCode,
  });
}

async function processOneJob(backend, requestedJobId = null) {
  const deadlineMs = Date.now() + INVOCATION_BUDGET_MS;
  let claimed = null;
  const counters = { processed: 0, matched: 0, notFound: 0, failed: 0 };
  try {
    claimed = await serviceRpc(backend, "claim_constant_contact_sync_job", { p_job_id: requestedJobId });
    if (!claimed?.jobId) return { ok: true, skipped: "no_queued_job" };
    if (claimed.terminal) {
      return { ok: false, jobId: claimed.jobId, error: "credential_unavailable" };
    }
    const secrets = constantContactSecrets(process.env, backend.surface);
    const token = await requestConstantContactToken({
      clientId: secrets.clientId,
      clientSecret: secrets.clientSecret,
      body: { grant_type: "refresh_token", refresh_token: claimed.refreshToken },
      deadlineMs,
    }).catch((error) => ({ ok: false, reason: error?.message === "invocation_budget" ? "invocation_budget" : "provider_error" }));
    if (!token.ok) {
      await finish(backend, claimed.jobId, counters, token.reason);
      return { ok: false, jobId: claimed.jobId, error: token.reason };
    }
    if (token.refreshToken) {
      await serviceRpc(backend, "rotate_constant_contact_refresh_token", {
        p_job_id: claimed.jobId,
        p_refresh_token: token.refreshToken,
        p_scope: token.scope,
      });
    }

    const members = await serviceRpc(backend, "list_constant_contact_sync_members", { p_job_id: claimed.jobId });
    let budgetExhausted = false;
    for (const member of Array.isArray(members) ? members : []) {
      if (Date.now() >= deadlineMs - CONSTANT_CONTACT_FINALIZATION_RESERVE_MS) {
        budgetExhausted = true;
        break;
      }
      counters.processed += 1;
      try {
        const result = await fetchConstantContactMember({
          accessToken: token.accessToken,
          email: member.email,
          deadlineMs,
        });
        await serviceRpc(backend, "record_constant_contact_sync_result", {
          p_job_id: claimed.jobId,
          p_member_id: member.memberId,
          p_provider_contact_id: result.providerContactId,
          p_contact_status: result.contactStatus,
          p_list_count: result.listCount,
          p_tag_count: result.tagCount,
          p_sends_count: result.analytics.sendsCount,
          p_opens_count: result.analytics.opensCount,
          p_clicks_count: result.analytics.clicksCount,
          p_bounces_count: result.analytics.bouncesCount,
          p_optouts_count: result.analytics.optoutsCount,
          p_forwards_count: result.analytics.forwardsCount,
          p_last_activity_at: result.analytics.lastActivityAt,
        });
        if (result.providerContactId) counters.matched += 1;
        else counters.notFound += 1;
      } catch (error) {
        counters.failed += 1;
        if (error?.message === "invocation_budget") budgetExhausted = true;
        safeLog("member_failed", { reason: error?.status === 401 ? "provider_unauthorized" : "provider_error" });
        if (budgetExhausted) break;
      }
    }
    const errorCode = budgetExhausted ? "invocation_budget" : counters.failed > 0 ? "partial_failure" : null;
    const completed = await finish(backend, claimed.jobId, counters, errorCode);
    return { ...completed, ok: counters.failed === 0 && !budgetExhausted };
  } catch (error) {
    if (claimed?.jobId && !claimed.terminal) {
      await finish(backend, claimed.jobId, counters, "worker_error").catch(() => {});
    }
    throw error;
  }
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["GET", "POST"], () => json(response, 405, { ok: false, error: "method_not_allowed" }))) return;
  const backend = resolveSupabaseBackend(request);
  if (requireEnv([backend.url, backend.publishableKey, backend.serviceRoleKey],
    () => json(response, 503, { ok: false, error: "not_configured" }))) return;
  if (!constantContactPublicStatus(process.env, backend.surface).configured) {
    json(response, 200, { ok: true, skipped: "activation_unset" });
    return;
  }

  let requestedJobId;
  if (request.method === "GET") {
    const cron = cronAuthorization(request);
    if (!cron.ok) {
      json(response, cron.status, cronRefusalBody(cron, { ok: false }));
      return;
    }
    try {
      const queued = await serviceRpc(backend, "enqueue_due_constant_contact_sync");
      requestedJobId = queued?.jobId || null;
    } catch {
      safeLog("cron_enqueue_failed", { reason: "worker_error" });
      json(response, 502, { ok: false, error: "worker_error" });
      return;
    }
  } else {
    const token = bearerToken(request);
    if (!token) return json(response, 401, { ok: false, error: "unauthorized" });
    const body = safeBody(request.body);
    if (body?.action !== "sync") return json(response, 400, { ok: false, error: "invalid_input" });
    const limit = Math.min(25, Math.max(1, Math.trunc(Number(body.limit) || 25)));
    try {
      const queued = await supabaseRpc(backend.url, backend.publishableKey, token, "enqueue_constant_contact_sync", {
        p_limit_count: limit,
      });
      requestedJobId = queued?.jobId || null;
    } catch (error) {
      return json(response, error?.status === 401 || error?.status === 403 ? 403 : 503, {
        ok: false,
        error: error?.status === 401 || error?.status === 403 ? "unauthorized" : "unavailable",
      });
    }
  }

  try {
    const result = await processOneJob(backend, requestedJobId);
    json(response, result.ok ? 200 : 207, result);
  } catch {
    safeLog("job_failed", { reason: "worker_error" });
    json(response, 502, { ok: false, error: "worker_error" });
  }
}
