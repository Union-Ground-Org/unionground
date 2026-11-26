import { resolveSupabaseBackend } from "./_lib/backend.js";
import { bearerToken, json, methodGuard, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";
import { readOperationKey } from "./_lib/operationKey.js";
import {
  bodyDigest,
  persistTwilioResult,
  providerReferenceDigest,
  sendTwilioMessage,
  twilioRegistryForSurface,
} from "./_lib/twilioOperations.js";
import { usableSecret } from "./_lib/secretStrength.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PURPOSES = new Set(["urgent_alert", "policy_notice", "onboarding"]);

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["POST"], () => json(response, 405, { ok: false, error: "method_not_allowed" }))) return;
  const backend = resolveSupabaseBackend(request);
  if (backend.surface === "demo") {
    json(response, 409, { ok: false, error: "sample_egress_suppressed" });
    return;
  }
  const token = bearerToken(request);
  const memberId = String(request.body?.memberId || "").trim();
  const idempotencyKey = readOperationKey(request, { uuid: true });
  const purpose = String(request.body?.purpose || "").trim();
  const body = String(request.body?.body || "").trim();
  const ledgerSalt = String(process.env.SMS_LEDGER_HASH_SALT || "").trim();
  if (!backend.url || !backend.publishableKey || !backend.serviceRoleKey || !token
      || !UUID.test(memberId) || !idempotencyKey || !PURPOSES.has(purpose)
      || body.length < 1 || body.length > 1_600) {
    json(response, 400, { ok: false, error: "invalid_request" });
    return;
  }
  if (!usableSecret(ledgerSalt)) {
    json(response, 503, { ok: false, error: "activation_incomplete" });
    return;
  }
  let prepared;
  try {
    prepared = await supabaseRpc(
      backend.url,
      backend.publishableKey,
      token,
      "prepare_twilio_sms_send",
      {
        p_member_id: memberId,
        p_purpose: purpose,
        p_body_digest: bodyDigest(body, ledgerSalt),
        p_idempotency_key: idempotencyKey,
      },
    );
  } catch (error) {
    json(response, error?.status === 401 || error?.status === 403 ? 403 : 409, { ok: false, error: "send_refused" });
    return;
  }
  const registry = twilioRegistryForSurface(process.env, backend.surface);
  const preparedAccount = registry.ok ? registry.accounts.get(String(prepared?.accountSid || "")) : null;
  if (!preparedAccount || preparedAccount.organizationId !== prepared?.organizationId
      || !preparedAccount.allowedFromNumbers.has(prepared?.fromNumber)) {
    json(response, 503, { ok: false, error: "activation_incomplete" });
    return;
  }
  let claimed;
  try {
    claimed = await supabaseRpc(
      backend.url,
      backend.serviceRoleKey,
      backend.serviceRoleKey,
      "claim_twilio_sms_send",
      { p_job_id: prepared.jobId },
    );
  } catch {
    json(response, 503, { ok: false, error: "claim_failed" });
    return;
  }
  if (!claimed?.claimed) {
    if (claimed?.reason === "rate_limited") {
      const retryAfterSeconds = Number(claimed.retryAfterSeconds) || 3600;
      if (typeof response?.setHeader === "function") response.setHeader("Retry-After", String(retryAfterSeconds));
      json(response, 429, {
        ok: false,
        error: "rate_limited",
        scope: claimed.scope,
        retryAfterSeconds,
      });
      return;
    }
    json(response, 409, { ok: false, error: "already_processed" });
    return;
  }
  const account = registry.accounts.get(String(claimed.accountSid || ""));
  if (!account || account.organizationId !== claimed.organizationId
      || !account.allowedFromNumbers.has(claimed.fromNumber)) {
    try {
      await persistTwilioResult(() => supabaseRpc(backend.url, backend.serviceRoleKey, backend.serviceRoleKey, "record_twilio_sms_send_result", {
        p_job_id: prepared.jobId,
        p_success: false,
        p_provider_reference_digest: null,
        p_provider_status: null,
        p_error_code: "registry_context_changed",
      }));
    } catch {
      json(response, 503, { ok: false, error: "result_record_failed" });
      return;
    }
    json(response, 503, { ok: false, error: "activation_incomplete" });
    return;
  }
  const effectiveAccount = { ...account, fromNumber: claimed.fromNumber };
  const callbackUrl = `${account.webhookBaseUrl}/api/twilio-status`;
  const sent = await sendTwilioMessage({ account: effectiveAccount, to: claimed.toPhone, body, statusCallbackUrl: callbackUrl });
  const referenceDigest = sent.ok ? providerReferenceDigest(account.accountSid, sent.messageSid, ledgerSalt) : null;
  try {
    await persistTwilioResult(() => supabaseRpc(
      backend.url,
      backend.serviceRoleKey,
      backend.serviceRoleKey,
      "record_twilio_sms_send_result",
      {
        p_job_id: prepared.jobId,
        p_success: sent.ok,
        p_provider_reference_digest: referenceDigest,
        p_provider_status: sent.ok ? sent.status : null,
        p_error_code: sent.ok ? null : sent.reason,
      },
    ));
  } catch {
    json(response, 503, { ok: false, error: "result_record_failed" });
    return;
  }
  if (!sent.ok) {
    json(response, 502, { ok: false, error: "provider_failed" });
    return;
  }
  json(response, 202, { ok: true, deliveryId: prepared.jobId, status: sent.status });
}
