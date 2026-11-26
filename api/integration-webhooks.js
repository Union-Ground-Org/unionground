import { randomUUID } from "node:crypto";
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { authenticate, bearerToken, json, methodGuard, requireEnv, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";
import { dispatchClaimedIntegrationWebhook } from "./_lib/integrationWebhooks.js";

function bodyOf(request) {
  let body = request.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return {}; }
  }
  return body && typeof body === "object" && !Array.isArray(body) ? body : {};
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["POST"], () => json(response, 405, { ok: false }))) return;
  const backend = resolveSupabaseBackend(request);
  if (requireEnv([backend.url, backend.publishableKey, backend.serviceRoleKey], () => json(response, 503, { ok: false }))) return;
  const token = bearerToken(request);
  if (!token || !(await authenticate(backend.url, backend.publishableKey, token))) {
    json(response, 401, { ok: false });
    return;
  }
  const body = bodyOf(request);
  if (!/^[0-9a-f-]{36}$/i.test(String(body.webhookId || "")) || typeof body.eventName !== "string") {
    json(response, 400, { ok: false, reason: "invalid_request" });
    return;
  }
  let queued;
  try {
    queued = await supabaseRpc(
      backend.url,
      backend.publishableKey,
      token,
      "enqueue_integration_webhook_test",
      { p_webhook_id: body.webhookId, p_event_name: body.eventName, p_event_id: `test:${randomUUID()}` },
    );
  } catch (error) {
    const status = error?.status;
    if (!Number.isInteger(status) || status < 400 || status >= 500 || status === 408 || status === 429) {
      // The dependency did not answer an input refusal. Report the outage,
      // without replaying an enqueue whose commit state may be unknown.
      json(response, 503, { ok: false, reason: "enqueue_failed" });
      return;
    }
    json(response, error?.status === 401 || error?.status === 403 ? 403 : 400, { ok: false, reason: "enqueue_failed" });
    return;
  }
  try {
    const claim = await supabaseRpc(
      backend.url,
      backend.serviceRoleKey,
      backend.serviceRoleKey,
      "claim_integration_webhook_delivery",
      { p_delivery_id: queued.deliveryId },
    );
    if (!claim) {
      json(response, 202, { ok: true, deliveryId: queued.deliveryId, status: "queued" });
      return;
    }
    const result = await dispatchClaimedIntegrationWebhook(claim, (args) => supabaseRpc(
      backend.url,
      backend.serviceRoleKey,
      backend.serviceRoleKey,
      "record_integration_webhook_delivery",
      args,
    ));
    json(response, 200, { ok: true, deliveryId: queued.deliveryId, status: result.status });
  } catch {
    // Enqueue already committed. Report that honest state; a later dispatcher
    // invocation can claim the leased/due row without duplicating it.
    json(response, 202, { ok: true, deliveryId: queued.deliveryId, status: "queued" });
  }
}
