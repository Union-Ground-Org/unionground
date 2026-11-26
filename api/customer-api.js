import { createHash } from "node:crypto";
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { bearerToken, json, methodGuard, requireEnv, supabaseRpc } from "./_lib/http.js";

export default async function handler(request, response) {
  if (methodGuard(request, ["GET", "HEAD"], () => json(response, 405, { ok: false }))) return;
  const backend = resolveSupabaseBackend(request);
  if (requireEnv([backend.url, backend.serviceRoleKey], () => json(response, 503, { ok: false }))) return;
  const plaintext = bearerToken(request);
  if (!/^ug_live_[0-9a-f]{48}$/.test(plaintext)) {
    json(response, 401, { ok: false });
    return;
  }
  const keyHash = createHash("sha256").update(plaintext).digest("hex");
  try {
    const identity = await supabaseRpc(
      backend.url,
      backend.serviceRoleKey,
      backend.serviceRoleKey,
      "authenticate_integration_api_key",
      { p_key_hash: keyHash },
    );
    if (!identity?.organizationId) {
      json(response, 401, { ok: false });
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "HEAD") {
      response.status(204).end();
      return;
    }
    json(response, 200, {
      ok: true,
      organizationId: identity.organizationId,
      keyId: identity.keyId,
      capabilities: ["organization_identity"],
    });
  } catch {
    json(response, 503, { ok: false });
  }
}
