import { resolveSupabaseBackend } from "./_lib/backend.js";
import { json, methodGuard, requireEnv, supabaseRpc } from "./_lib/http.js";
import {
  publicInterestStopEmailScope,
  publicInterestStopScope,
} from "./_lib/publicInterest.js";
import {
  sendStopConfirmationEmail,
  stopConfirmationDigest,
  stopConfirmationToken,
  stopConfirmationUrl,
} from "./_lib/publicInterestStopConfirmation.js";
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

function validEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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
    // SEC-UG-PUBLIC-INTEREST-SUPPRESSION-CONFIRMATION-20260921 (owner
    // ruling 2026-09-25): the request only mails a single-use 24-hour
    // confirmation link, so the same transactional transport the invitation
    // flow uses is part of this endpoint's configuration.
    resendKey: process.env.RESEND_API_KEY,
    notifyFrom: process.env.NOTIFY_FROM_ADDRESS,
  };
  if (requireEnv(Object.values(config), () => safeJson(response, 503, { error: "stop-unavailable" }))) return;
  if (!usableSecret(config.rateKey)) return safeJson(response, 503, { error: "stop-unavailable" });
  if (String(request.url || "").includes("?")) return safeJson(response, 400, { error: "invalid-request" });
  if (String(request.headers?.origin || "") !== config.appOrigin) {
    return safeJson(response, 403, { error: "not-permitted" });
  }
  try {
    if (new URL(config.appOrigin).origin !== config.appOrigin
        || new URL(config.supabaseUrl).origin !== config.supabaseUrl) throw new Error("bad-origin");
  } catch {
    return safeJson(response, 503, { error: "stop-unavailable" });
  }

  const body = safeParse(request.body);
  if (body && String(body.website || "").trim()) {
    return safeJson(response, 200, { accepted: true });
  }
  const scopeHash = publicInterestStopScope(request, config.rateKey);
  const normalizedEmail = String(body?.email || "").trim().toLowerCase();
  if (!body || !scopeHash || !validEmail(normalizedEmail)) {
    return safeJson(response, 400, { error: "invalid-request" });
  }

  // The database records the pending request keyed by the token's SHA-256
  // digest and suppresses nothing; only the emailed link, used within 24
  // hours, does. The raw token exists in this invocation and the email alone.
  const token = stopConfirmationToken();
  const tokenHash = stopConfirmationDigest(token);
  let result;
  try {
    result = await supabaseRpc(
      config.supabaseUrl,
      config.serviceKey,
      config.serviceKey,
      "request_public_interest_stop",
      {
        p_email: normalizedEmail,
        p_locale: body.locale === "es" ? "es" : "en",
        p_source: "public-landing",
        p_website: String(body.website || "").trim(),
        p_scope_hash: scopeHash,
        p_email_scope_hash: publicInterestStopEmailScope(normalizedEmail, config.rateKey),
        p_token_hash: tokenHash,
      },
    );
  } catch {
    return safeJson(response, 503, { error: "stop-unavailable" });
  }

  if (result?.accepted !== true) return safeJson(response, 429, { error: "stop-unavailable" });
  if (result.pending === true) {
    let delivered = false;
    try {
      delivered = await sendStopConfirmationEmail({
        resendKey: config.resendKey,
        from: config.notifyFrom,
        to: normalizedEmail,
        locale: body.locale === "es" ? "es" : "en",
        link: stopConfirmationUrl(config.appOrigin, token),
        tokenHash,
      });
    } catch { /* an undelivered link is a retryable failure, never a suppression */ }
    // The pending row simply expires; the requester sees the same generic
    // failure a database outage produces and may ask again.
    if (!delivered) return safeJson(response, 503, { error: "stop-unavailable" });
  }
  return safeJson(response, 200, { accepted: true });
}
