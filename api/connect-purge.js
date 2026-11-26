import { cronAuthorization, cronRefusalBody } from "./_lib/cronAuth.js";
import { json, unionGroundProvider, supabaseRpc } from "./_lib/http.js";

export default async function handler(request, response) {
  if (request.method !== "GET") {
    json(response, 405, { error: "method-not-allowed" });
    return;
  }

  const cron = cronAuthorization(request);
  if (!cron.ok) {
    json(response, cron.status, cronRefusalBody(cron));
    return;
  }

  const provider = unionGroundProvider();
  const serviceRoleKey = String(provider.serviceRoleKey || "");
  if (!provider.ok || serviceRoleKey.length < 20) {
    // Reason to the log, opaque status to the caller — this endpoint is reachable
    // by anyone who can guess the path.
    console.error(`[connect-purge] not-configured: ${provider.reason || "SUPABASE_SERVICE_ROLE_KEY missing or too short"}`);
    json(response, 503, { error: "not-configured" });
    return;
  }
  const supabaseUrl = provider.supabaseUrl;

  try {
    const result = await supabaseRpc(
      supabaseUrl,
      serviceRoleKey,
      serviceRoleKey,
      "purge_expired_unionground_connect_requests",
      {},
    );
    if (
      !Number.isInteger(result?.requestsDeleted)
      || !Number.isInteger(result?.bucketsDeleted)
    ) {
      throw new Error("invalid purge receipt");
    }
    json(response, 200, {
      requestsDeleted: result.requestsDeleted,
      bucketsDeleted: result.bucketsDeleted,
    });
  } catch {
    json(response, 503, { error: "temporarily-unavailable" });
  }
}
