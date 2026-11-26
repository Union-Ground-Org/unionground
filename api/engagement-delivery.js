import { randomUUID } from "node:crypto";
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { cronAuthorization, cronRefusalBody } from "./_lib/cronAuth.js";
import { engagementEmailClass, UNSUBSCRIBE_TOKEN, unsubscribeHeaders, unsubscribeUrl } from "./_lib/engagementEmail.js";
import { authenticate, bearerToken, json, methodGuard, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";

// Vercel permits 300s. Leave headroom for the final response and a failed
// outcome write's retry; never lease rows merely to wait behind other mail.
const INVOCATION_BUDGET_MS = 280000;
const CLAIM_TIMEOUT_MS = 12000;
const PAYLOAD_TIMEOUT_MS = 8000;
const PROVIDER_TIMEOUT_MS = 12000;
const OUTCOME_TIMEOUT_MS = 8000;
const OUTCOME_RESERVE_MS = OUTCOME_TIMEOUT_MS * 2;
const DELIVERY_BUDGET_MS = PAYLOAD_TIMEOUT_MS + PROVIDER_TIMEOUT_MS + OUTCOME_RESERVE_MS;
const LEASE_SECONDS = 240;
const MAX_DELIVERIES = 50;
const fitsBudget = (deadline, required) => Date.now() + required <= deadline;
const exhaustedBudget = () => Object.assign(new Error("Delivery time budget exhausted."), { code: "delivery_time_budget_exhausted" });

function providerConfig(env = process.env) {
  const url = String(env.ENGAGEMENT_EMAIL_WEBHOOK_URL || "").trim();
  const token = String(env.ENGAGEMENT_EMAIL_WEBHOOK_TOKEN || "").trim();
  return {
    configured: /^https:\/\//.test(url) && Boolean(token),
    url,
    token,
  };
}

// public.authorize_engagement_staff refuses with SQLSTATE 42501 (PostgREST 403)
// or the session is rejected (401). Anything else, including the supabaseRpc
// timeout, is unavailability rather than a missing staff role.
function engagementStaffRefused(error) {
  return error?.code === "42501" || error?.status === 401 || error?.status === 403;
}

async function statusRequest(request, response, backend) {
  const token = bearerToken(request);
  if (!token) return json(response, 401, { error: "Sign in to view delivery status." });
  const user = await authenticate(backend.url, backend.publishableKey, token).catch(() => null);
  if (!user?.id) return json(response, 401, { error: "Your session expired. Sign in again." });
  try {
    await supabaseRpc(backend.url, backend.publishableKey, token, "authorize_engagement_staff");
  } catch (error) {
    if (!engagementStaffRefused(error)) return json(response, 503, { error: "Delivery status is unavailable right now. Try again shortly." });
    return json(response, 403, { error: "A staff role is required." });
  }
  return json(response, 200, {
    configured: providerConfig().configured,
    provider: providerConfig().configured ? "webhook" : null,
    required: ["ENGAGEMENT_EMAIL_WEBHOOK_URL", "ENGAGEMENT_EMAIL_WEBHOOK_TOKEN"],
  });
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["GET"], () => json(response, 405, { error: "Method not allowed." }))) return;
  const backend = resolveSupabaseBackend(request);
  if (request.query?.status === "1") return statusRequest(request, response, backend);
  const cron = cronAuthorization(request);
  if (!cron.ok) return json(response, cron.status, cron.status === 401 ? { error: "Unauthorized." } : cronRefusalBody(cron));
  if (!backend.url || !backend.serviceRoleKey) return json(response, 503, { error: "Delivery backend is not configured." });
  const provider = providerConfig();
  // Fail before leasing. An optional provider that is not activated must not
  // make recipient rows look attempted, failed, or sent.
  if (!provider.configured) return json(response, 503, { error: "Engagement email delivery is not activated." });

  const invocationDeadline = Date.now() + INVOCATION_BUDGET_MS;
  const leaseToken = randomUUID();
  const counts = { claimed: 0, sent: 0, failed: 0, suppressed: 0 };
  let budgetExhausted = false;
  for (let index = 0; index < MAX_DELIVERIES; index += 1) {
    if (!fitsBudget(invocationDeadline, CLAIM_TIMEOUT_MS + DELIVERY_BUDGET_MS)) {
      budgetExhausted = true;
      break;
    }
    const claimStartedAt = Date.now();
    let deliveries;
    try {
      deliveries = await supabaseRpc(
        backend.url,
        backend.serviceRoleKey,
        backend.serviceRoleKey,
        "claim_engagement_delivery_batch",
        { p_lease_token: leaseToken, p_limit: 1, p_lease_seconds: LEASE_SECONDS },
        { timeoutMs: CLAIM_TIMEOUT_MS },
      );
      if (!Array.isArray(deliveries) || deliveries.length > 1) throw new Error("invalid-claim-response");
    } catch {
      // Preserve the original first-claim error shape; later claim failures
      // also report work already completed during this invocation.
      return json(response, 503, {
        ...(counts.claimed ? counts : {}),
        error: "Delivery queue is unavailable.",
      });
    }
    if (!deliveries.length) break;

    const delivery = deliveries[0];
    counts.claimed += 1;
    // The database lease may have started before the claim response arrived.
    // Counting from request start is conservative about that unknown instant.
    const deliveryDeadline = Math.min(invocationDeadline, claimStartedAt + LEASE_SECONDS * 1000);
    let payload;
    try {
      if (!fitsBudget(deliveryDeadline, DELIVERY_BUDGET_MS)) throw exhaustedBudget();
      payload = await supabaseRpc(
        backend.url,
        backend.serviceRoleKey,
        backend.serviceRoleKey,
        "get_engagement_delivery_payload",
        { p_delivery_id: delivery.id, p_lease_token: leaseToken },
        { timeoutMs: PAYLOAD_TIMEOUT_MS },
      );
      // The member turned this email category off, or lost the membership or
      // audience, after the row was queued. The database re-checks the claim
      // and records it as terminal.
      if (payload?.suppressed === true) {
        const reason = payload.reason === "recipient_access_revoked" ? "recipient_access_revoked" : "recipient_opted_out";
        await supabaseRpc(
          backend.url,
          backend.serviceRoleKey,
          backend.serviceRoleKey,
          "complete_engagement_delivery",
          { p_delivery_id: delivery.id, p_lease_token: leaseToken, p_success: false, p_error_code: reason },
          { timeoutMs: OUTCOME_TIMEOUT_MS },
        );
        counts.suppressed += 1;
        continue;
      }
      if (payload?.available !== true) throw Object.assign(new Error("payload-unavailable"), { code: "payload_unavailable" });
      // Every engagement kind is optional mail. An unclassified kind, or a
      // message without a working one-click link, is never sent.
      const classification = engagementEmailClass(delivery.deliveryKind);
      if (!classification || classification.category !== payload.category) {
        throw Object.assign(new Error("unclassified-kind"), { code: "unclassified_kind" });
      }
      if (!UNSUBSCRIBE_TOKEN.test(String(payload.unsubscribeToken || ""))) {
        throw Object.assign(new Error("unsubscribe-unavailable"), { code: "unsubscribe_unavailable" });
      }
      const oneClick = unsubscribeUrl(payload.unsubscribeToken);
      if (!fitsBudget(deliveryDeadline, PROVIDER_TIMEOUT_MS + OUTCOME_RESERVE_MS)) throw exhaustedBudget();
      const providerResponse = await fetch(provider.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": delivery.id,
        },
        body: JSON.stringify({
          to: payload.email,
          locale: payload.locale,
          subject: payload.subject,
          text: payload.body,
          actionPath: payload.path,
          // The provider must put these on the message as-is (RFC 2369 /
          // RFC 8058) and show unsubscribeUrl in the footer.
          headers: unsubscribeHeaders(oneClick),
          unsubscribeUrl: oneClick,
          category: classification.category,
          metadata: { deliveryId: delivery.id, kind: delivery.deliveryKind },
          // #9507: the sending organization's own footer address ("" when it
          // has none on file), whenever the payload carries the key; a
          // database not yet migrated sends no key and the provider keeps
          // its deployment-wide line.
          ...(Object.hasOwn(payload, "postalAddress") ? { postalAddress: typeof payload.postalAddress === "string" ? payload.postalAddress : "" } : {}),
        }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      if (!providerResponse.ok) {
        throw Object.assign(new Error("provider-failed"), {
          code: providerResponse.status === 429 ? "provider_rate_limited" : `provider_${Math.floor(providerResponse.status / 100)}xx`,
        });
      }
      await supabaseRpc(
        backend.url,
        backend.serviceRoleKey,
        backend.serviceRoleKey,
        "complete_engagement_delivery",
        { p_delivery_id: delivery.id, p_lease_token: leaseToken, p_success: true },
        { timeoutMs: OUTCOME_TIMEOUT_MS },
      );
      counts.sent += 1;
    } catch (error) {
      const code = /^[a-z0-9._:-]{1,80}$/.test(String(error?.code || "")) ? error.code : "provider_unavailable";
      const outcome = await supabaseRpc(
        backend.url,
        backend.serviceRoleKey,
        backend.serviceRoleKey,
        "complete_engagement_delivery",
        {
          p_delivery_id: delivery.id,
          p_lease_token: leaseToken,
          p_success: false,
          p_error_code: code,
          p_retry_after_seconds: code === "provider_rate_limited" ? 900 : 300,
        },
        { timeoutMs: OUTCOME_TIMEOUT_MS },
      ).catch(() => null);
      // The database may end the row instead of scheduling a retry (a survey
      // email refused because the survey has closed): that is not a failure.
      if (outcome?.state === "suppressed") {
        counts.suppressed += 1;
        continue;
      }
      counts.failed += 1;
      if (code === "delivery_time_budget_exhausted") {
        budgetExhausted = true;
        break;
      }
    }
  }
  if (budgetExhausted) return json(response, 503, { ...counts, error: "delivery_time_budget_exhausted" });
  return json(response, counts.failed ? 503 : 200, counts);
}
