import { resolveSupabaseBackend } from "./_lib/backend.js";
import { cronAuthorization, cronRefusalBody } from "./_lib/cronAuth.js";
import { json, methodGuard, requireEnv, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";
import { postAnnouncementAlert } from "./_lib/announcementAlerts.js";

// One bounded RPC per tick: one job, at most 100 organization consents, no
// member enumeration. Database retries have a five-failure ceiling.
export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["GET", "POST"], () => json(response, 405, { ok: false }))) return;
  const cron = cronAuthorization(request);
  if (!cron.ok) return json(response, cron.status, cronRefusalBody(cron, { ok: false }));
  const backend = resolveSupabaseBackend(request);
  if (requireEnv([backend.url, backend.serviceRoleKey], () => json(response, 503, { ok: false }))) return;
  response.setHeader("Cache-Control", "no-store");
  let state;
  try {
    const result = await supabaseRpc(backend.url, backend.serviceRoleKey, backend.serviceRoleKey,
      "dispatch_platform_announcements", { p_batch_limit: 100 });
    state = ["idle", "complete", "pending", "retry", "failed"].includes(result?.state) ? result.state : "unavailable";
  } catch { state = "unavailable"; }
  const ok = ["idle", "complete", "pending"].includes(state);
  if (!ok) await postAnnouncementAlert(state);
  // Operational progress and failure details are never a product API response.
  return json(response, ok ? 200 : 502, { ok });
}
