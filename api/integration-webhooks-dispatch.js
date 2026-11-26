import { resolveSupabaseBackend } from "./_lib/backend.js";
import { constantTimeEqual, cronAuthorization } from "./_lib/cronAuth.js";
import { json, methodGuard, requireEnv, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";
import { dispatchClaimedIntegrationWebhook } from "./_lib/integrationWebhooks.js";

const INVOCATION_BUDGET_MS = 230_000;
const RESULT_RESERVE_MS = 20_000;

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  const startedAt = Date.now();
  if (methodGuard(request, ["GET", "POST"], () => json(response, 405, { ok: false, error: "method_not_allowed" }))) return;
  const backend = resolveSupabaseBackend(request);
  const secretsCollide = Boolean(
    process.env.SAMPLE_INTEGRATION_DISPATCH_SECRET
    && process.env.INTEGRATION_DISPATCH_SECRET
    && constantTimeEqual(process.env.SAMPLE_INTEGRATION_DISPATCH_SECRET, process.env.INTEGRATION_DISPATCH_SECRET),
  );
  if (secretsCollide) {
    json(response, 503, { ok: false, error: "dispatch_secret_isolation_required" });
    return;
  }
  // Two ways in: the surface's dedicated dispatch bearer, or a genuine Vercel
  // cron tick. Both secrets follow the rule in api/_lib/cronAuth.js, so a
  // copied .env.example placeholder opens neither.
  const dispatchSecretName = backend.surface === "demo" ? "SAMPLE_INTEGRATION_DISPATCH_SECRET" : "INTEGRATION_DISPATCH_SECRET";
  const dedicated = cronAuthorization(request, { secretName: dispatchSecretName });
  if (!dedicated.ok) {
    const cron = cronAuthorization(request);
    if (!cron.ok) {
      if (dedicated.status === 503 && cron.status === 503) {
        json(response, 503, { ok: false, error: "cron_secret_not_configured", message: `${dedicated.message} ${cron.message}` });
        return;
      }
      json(response, 401, { ok: false, error: "unauthorized" });
      return;
    }
  }
  if (requireEnv([backend.url, backend.serviceRoleKey], () => json(response, 503, { ok: false, error: "not_configured" }))) return;

  const results = [];
  // Claim one row only after proving that this invocation can process and
  // record it. A bulk claim followed by a budget check burns attempts and
  // strands leased rows that were never sent.
  for (let index = 0; index < 10; index += 1) {
    if (Date.now() - startedAt >= INVOCATION_BUDGET_MS - RESULT_RESERVE_MS) {
      break;
    }
    let claims;
    try {
      claims = await supabaseRpc(
        backend.url,
        backend.serviceRoleKey,
        backend.serviceRoleKey,
        "claim_integration_webhook_deliveries",
        { p_limit: 1 },
      );
    } catch {
      if (results.length === 0) {
        json(response, 502, { ok: false, error: "claim_failed" });
        return;
      }
      break;
    }
    const claim = Array.isArray(claims) ? claims[0] : null;
    if (!claim) break;
    try {
      results.push(await dispatchClaimedIntegrationWebhook(claim, (args) => supabaseRpc(
        backend.url,
        backend.serviceRoleKey,
        backend.serviceRoleKey,
        "record_integration_webhook_delivery",
        args,
      )));
    } catch {
      results.push({ deliveryId: claim?.deliveryId || null, ok: false, status: "record_failed" });
    }
  }

  const failed = results.filter((result) => !result.ok).length;
  json(response, failed > 0 ? 207 : 200, {
    ok: failed === 0,
    claimed: results.length,
    delivered: results.length - failed,
    failed,
  });
}
