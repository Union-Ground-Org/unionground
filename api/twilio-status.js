import { resolveSupabaseBackend } from "./_lib/backend.js";
import { json, methodGuard, supabaseRpc } from "./_lib/http.js";
import {
  parseTwilioParams,
  providerReferenceDigest,
  requestHeader,
  resolveTwilioSignatureUrl,
  twilioRegistryForSurface,
  validateTwilioSignature,
} from "./_lib/twilioOperations.js";
import { usableSecret } from "./_lib/secretStrength.js";

const STATUSES = new Set(["queued", "accepted", "scheduled", "sending", "sent", "delivered", "undelivered", "failed", "canceled", "read"]);

export default async function handler(request, response) {
  if (methodGuard(request, ["POST"], () => json(response, 405, { error: "method_not_allowed" }))) return;
  const backend = resolveSupabaseBackend(request);
  const registry = twilioRegistryForSurface(process.env, backend.surface);
  const params = parseTwilioParams(request.body);
  const account = registry.ok && params ? registry.accounts.get(String(params.AccountSid || "")) : null;
  const salt = String(process.env.SMS_LEDGER_HASH_SALT || "").trim();
  if (!backend.url || !backend.serviceRoleKey || !account || !usableSecret(salt)) {
    json(response, 503, { error: "not_configured" });
    return;
  }
  if (!validateTwilioSignature({
    authToken: account.authToken,
    signature: requestHeader(request, "x-twilio-signature"),
    url: resolveTwilioSignatureUrl(request, account.webhookBaseUrl),
    params,
  })) {
    json(response, 403, { error: "signature_refused" });
    return;
  }
  const status = String(params.MessageStatus || "").trim().toLowerCase();
  const referenceDigest = providerReferenceDigest(account.accountSid, params.MessageSid, salt);
  if (!referenceDigest || !STATUSES.has(status)) {
    json(response, 400, { error: "invalid_callback" });
    return;
  }
  try {
    await supabaseRpc(
      backend.url,
      backend.serviceRoleKey,
      backend.serviceRoleKey,
      "record_twilio_status_callback",
      {
        p_organization_id: account.organizationId,
        p_provider_reference_digest: referenceDigest,
        p_provider_status: status,
        p_error_code: String(params.ErrorCode || "").trim() || null,
      },
    );
  } catch {
    json(response, 503, { error: "record_failed" });
    return;
  }
  json(response, 200, { ok: true });
}
