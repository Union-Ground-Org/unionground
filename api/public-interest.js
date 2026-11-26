import { resolveSupabaseBackend } from "./_lib/backend.js";
import { json, methodGuard, requireEnv, supabaseRpc } from "./_lib/http.js";
import {
  publicInterestEmailScope,
  publicInterestScope,
} from "./_lib/publicInterest.js";
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
  // Public-interest capture is production-only. The SAMPLE surface is a demo
  // and must not run real lead capture (it would pair the SAMPLE project with
  // the production site origin). Refuse rather than half-operate.
  if (backend.surface === "demo") return safeJson(response, 404, { error: "not-available" });
  const config = {
    supabaseUrl: backend.url,
    serviceKey: backend.serviceRoleKey,
    appOrigin: String(process.env.PUBLIC_SITE_APP_ORIGIN || "").replace(/\/$/, ""),
    rateKey: process.env.PUBLIC_INTEREST_RATE_LIMIT_SECRET,
  };
  if (requireEnv(Object.values(config), () => safeJson(response, 503, { error: "submission-unavailable" }))) return;
  if (!usableSecret(config.rateKey)) return safeJson(response, 503, { error: "submission-unavailable" });
  if (String(request.url || "").includes("?")) return safeJson(response, 400, { error: "invalid-request" });
  if (String(request.headers?.origin || "") !== config.appOrigin) {
    return safeJson(response, 403, { error: "not-permitted" });
  }
  try {
    if (new URL(config.appOrigin).origin !== config.appOrigin
        || new URL(config.supabaseUrl).origin !== config.supabaseUrl) throw new Error("bad-origin");
  } catch {
    return safeJson(response, 503, { error: "submission-unavailable" });
  }

  const body = safeParse(request.body);
  if (body && String(body.website || "").trim()) {
    return safeJson(response, 200, { accepted: true });
  }
  const scopeHash = publicInterestScope(request, config.rateKey);
  if (!body || !scopeHash) return safeJson(response, 400, { error: "invalid-request" });
  const normalizedEmail = String(body.email || "").trim().toLowerCase();
  const normalizedInterest = String(body.interest || "chapter_updates");
  const emailScopeHash = publicInterestEmailScope(normalizedEmail, normalizedInterest, config.rateKey);
  const payload = {
    p_email: normalizedEmail,
    p_name: String(body.name || "").trim(),
    p_interest: normalizedInterest,
    p_locale: body.locale === "es" ? "es" : "en",
    p_source: "public-landing",
    p_website: String(body.website || "").trim(),
    p_scope_hash: scopeHash,
    p_email_scope_hash: emailScopeHash,
  };
  let result;
  try {
    // Keep the deployed eight-argument service seam. PostgreSQL derives the
    // durable, Vault-keyed suppression identifier itself, so browser and
    // server code never receive a stable address digest and rolling deploys
    // cannot fall through to a suppression-bypassing overload.
    result = await supabaseRpc(
      config.supabaseUrl,
      config.serviceKey,
      config.serviceKey,
      "submit_public_interest",
      payload,
    );
  } catch {
    return safeJson(response, 503, { error: "submission-unavailable" });
  }

  if (result?.accepted !== true) return safeJson(response, 503, { error: "submission-unavailable" });
  return safeJson(response, 200, { accepted: true });
}
