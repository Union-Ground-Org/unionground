// SEC-UG-PUBLIC-INTEREST-SUPPRESSION-CONFIRMATION-20260921 (owner ruling
// 2026-09-25): the second half of the single-use email confirmation. The
// /stop-updates page reads the token from its URL fragment and posts it here;
// PostgreSQL sees only the SHA-256 digest. An unknown, expired or already-used
// token gets one identical refusal, and no response depends on whether the
// address behind the token is subscribed.
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { json, methodGuard, requireEnv, supabaseRpc } from "./_lib/http.js";
import { publicInterestStopScope } from "./_lib/publicInterest.js";
import { STOP_CONFIRMATION_TOKEN, stopConfirmationDigest } from "./_lib/publicInterestStopConfirmation.js";
import { usableSecret } from "./_lib/secretStrength.js";

function safeParse(value) {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeJson(response, status, payload) {
  response.setHeader("Referrer-Policy", "no-referrer");
  return json(response, status, payload);
}

export default async function handler(request, response) {
  if (methodGuard(request, ["POST"], () => safeJson(response, 405, { error: "method-not-allowed" }))) return;

  const backend = resolveSupabaseBackend(request);
  if (backend.surface === "demo") return safeJson(response, 404, { error: "not-available" });
  const config = {
    supabaseUrl: backend.url,
    serviceKey: backend.serviceRoleKey,
    appOrigin: String(process.env.PUBLIC_SITE_APP_ORIGIN || "").replace(/\/$/, ""),
    rateKey: process.env.PUBLIC_INTEREST_RATE_LIMIT_SECRET,
  };
  if (requireEnv(Object.values(config), () => safeJson(response, 503, { error: "confirmation-unavailable" }))) return;
  if (!usableSecret(config.rateKey)) return safeJson(response, 503, { error: "confirmation-unavailable" });
  if (String(request.url || "").includes("?")) return safeJson(response, 400, { error: "invalid-request" });
  if (String(request.headers?.origin || "") !== config.appOrigin) {
    return safeJson(response, 403, { error: "not-permitted" });
  }
  try {
    if (new URL(config.appOrigin).origin !== config.appOrigin
        || new URL(config.supabaseUrl).origin !== config.supabaseUrl) throw new Error("bad-origin");
  } catch {
    return safeJson(response, 503, { error: "confirmation-unavailable" });
  }

  const body = safeParse(request.body);
  const scopeHash = publicInterestStopScope(request, config.rateKey);
  if (!body || !scopeHash) return safeJson(response, 400, { error: "invalid-request" });
  const token = String(body.token || "");
  // A malformed token is refused exactly like an unknown one, before the database.
  if (!STOP_CONFIRMATION_TOKEN.test(token)) return safeJson(response, 410, { error: "confirmation-unavailable" });

  let result;
  try {
    result = await supabaseRpc(
      config.supabaseUrl,
      config.serviceKey,
      config.serviceKey,
      "confirm_public_interest_stop",
      { p_token_hash: stopConfirmationDigest(token), p_scope_hash: scopeHash },
    );
  } catch {
    return safeJson(response, 503, { error: "confirmation-unavailable" });
  }

  if (result?.confirmed === true) return safeJson(response, 200, { confirmed: true });
  if (result?.refusal === "rate-limited") return safeJson(response, 429, { error: "try-later" });
  return safeJson(response, 410, { error: "confirmation-unavailable" });
}
