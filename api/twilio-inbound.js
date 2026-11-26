import { resolveSupabaseBackend } from "./_lib/backend.js";
import { json, methodGuard, supabaseRpc } from "./_lib/http.js";
import {
  classifyTwilioConsent,
  parseTwilioParams,
  phoneDigest,
  providerReferenceDigest,
  requestHeader,
  resolveTwilioSignatureUrl,
  twilioRegistryForSurface,
  validE164,
  validateTwilioSignature,
} from "./_lib/twilioOperations.js";
import { usableSecret } from "./_lib/secretStrength.js";

const EMPTY_TWIML = "<Response></Response>";

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
  const signatureUrl = resolveTwilioSignatureUrl(request, account.webhookBaseUrl);
  if (!validateTwilioSignature({
    authToken: account.authToken,
    signature: requestHeader(request, "x-twilio-signature"),
    url: signatureUrl,
    params,
  })) {
    json(response, 403, { error: "signature_refused" });
    return;
  }
  const from = String(params.From || "").trim();
  const to = String(params.To || "").trim();
  const referenceDigest = providerReferenceDigest(account.accountSid, params.MessageSid, salt);
  const fromDigest = phoneDigest(from, salt);
  if (!validE164(from) || !account.allowedFromNumbers.has(to) || !referenceDigest || !fromDigest) {
    json(response, 400, { error: "invalid_callback" });
    return;
  }
  const consent = classifyTwilioConsent(params.Body, params.OptOutType);
  try {
    await supabaseRpc(
      backend.url,
      backend.serviceRoleKey,
      backend.serviceRoleKey,
      "record_twilio_inbound_consent",
      {
        p_organization_id: account.organizationId,
        p_provider_reference_digest: referenceDigest,
        p_from_e164: from,
        p_from_phone_digest: fromDigest,
        p_event_type: consent.eventType,
        p_keyword: consent.keyword,
      },
    );
  } catch {
    json(response, 503, { error: "record_failed" });
    return;
  }
  response.status(200).setHeader("Content-Type", "text/xml; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(EMPTY_TWIML);
}
