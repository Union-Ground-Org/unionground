import { resolveSupabaseBackend } from "./_lib/backend.js";
import {
  encryptRefreshToken,
  hashOAuthBrowserBinding,
  newOAuthBrowserBinding,
  oauthBrowserBindingCookie,
  pkcePair,
  publicOAuthStatus,
  readProviderSecrets,
  readOAuthBrowserBindings,
  redirectForRequest,
} from "./_lib/calendarOAuth.js";
import { authenticate, bearerToken, json, methodGuard, requireEnv, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";
import { buildAuthorizationUrl, parseTokenResponse, tokenEndpoint } from "../src/features/calendarFreeBusy/oauth.js";
import {
  CALENDAR_OAUTH_SCOPES,
  isCalendarProvider,
} from "../src/features/calendarFreeBusy/config.js";
import { portalOrigin } from "../src/lib/demoOrigin.js";

function safeParse(body) {
  if (body && typeof body === "object") return body;
  try {
    return JSON.parse(String(body || "{}"));
  } catch {
    return {};
  }
}

function logSafe(kind, extra = {}) {
  console.error("[calendar-oauth]", { kind, ...extra });
}

function isoNow() {
  return new Date().toISOString();
}

function isoExpiry(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

async function memberRpc(backend, token, name, body) {
  return supabaseRpc(backend.url, backend.publishableKey, token, name, body);
}

async function serviceRpc(backend, name, body) {
  return supabaseRpc(backend.url, backend.serviceRoleKey, backend.serviceRoleKey, name, body);
}

function htmlRedirect(response, location) {
  response.status(302);
  response.setHeader("Location", location);
  response.setHeader("Cache-Control", "no-store");
  response.end();
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["GET", "POST"], () => json(response, 405, { ok: false, error: "method_not_allowed" }))) {
    return;
  }

  const backend = resolveSupabaseBackend(request);
  if (requireEnv([backend.url, backend.publishableKey, backend.serviceRoleKey],
    () => json(response, 503, { ok: false, error: "not_configured" }))) return;

  const env = process.env;
  const status = publicOAuthStatus(env, backend.surface);
  const redirectUri = redirectForRequest(request);

  if (request.method === "GET" && (request.query?.code || request.query?.state || request.query?.error)) {
    const errorCode = String(request.query?.error || "");
    const state = String(request.query?.state || "");
    const code = String(request.query?.code || "");
    const fallback = `${portalOrigin(backend.surface)}/m`;
    if (errorCode || !state || !code) {
      logSafe("callback_refused", { reason: errorCode ? "provider_error" : "invalid_input" });
      htmlRedirect(response, `${fallback}?calendar=error`);
      return;
    }
    const browserBindings = readOAuthBrowserBindings(request.headers);
    if (!browserBindings.length) {
      logSafe("callback_refused", { reason: "browser_binding_missing" });
      htmlRedirect(response, `${fallback}?calendar=error`);
      return;
    }
    let saved = null;
    for (const binding of browserBindings) {
      try {
        saved = await serviceRpc(backend, "consume_calendar_oauth_state", {
          p_state: state,
          p_browser_binding_hash: hashOAuthBrowserBinding(binding.value),
        });
        break;
      } catch {
        // Another provider may have an independent pending start in this browser.
      }
    }
    if (!saved) {
      logSafe("callback_refused", { reason: "state_unknown" });
      htmlRedirect(response, `${fallback}?calendar=error`);
      return;
    }
    const provider = saved?.provider;
    response.setHeader("Set-Cookie", oauthBrowserBindingCookie(provider, "", { clear: true }));
    const secrets = readProviderSecrets(env, backend.surface, provider);
    const tokenUrl = tokenEndpoint(provider, secrets.tenant);
    if (!tokenUrl || !secrets.clientId || !secrets.clientSecret) {
      logSafe("callback_refused", { reason: "activation_unset", provider });
      htmlRedirect(response, `${fallback}?calendar=unset`);
      return;
    }
    let tokenPayload;
    try {
      const tokenResponse = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: secrets.clientId,
          client_secret: secrets.clientSecret,
          code,
          code_verifier: saved.codeVerifier,
          grant_type: "authorization_code",
          redirect_uri: saved.redirectUri,
        }),
        signal: AbortSignal.timeout(12_000),
      });
      tokenPayload = await tokenResponse.json().catch(() => null);
      if (!tokenResponse.ok) throw new Error("token_http");
    } catch {
      logSafe("callback_refused", { reason: "provider_error", provider });
      htmlRedirect(response, `${fallback}?calendar=error`);
      return;
    }
    const tokens = parseTokenResponse(tokenPayload);
    const ciphertext = tokens.ok ? encryptRefreshToken(env, backend.surface, tokens.refreshToken) : null;
    if (!tokens.ok || !ciphertext) {
      logSafe("callback_refused", { reason: tokens.ok ? "wrap_key_missing" : "provider_error", provider });
      htmlRedirect(response, `${fallback}?calendar=error`);
      return;
    }
    try {
      await serviceRpc(backend, "upsert_steward_calendar_oauth_token", {
        p_steward: saved.stewardId,
        p_provider: provider,
        p_refresh_token_ciphertext: ciphertext,
        p_scopes: tokens.scope || CALENDAR_OAUTH_SCOPES[provider],
      });
    } catch {
      logSafe("callback_refused", { reason: "token_store_failed", provider });
      htmlRedirect(response, `${fallback}?calendar=error`);
      return;
    }
    htmlRedirect(response, `${fallback}?calendar=pending`);
    return;
  }

  const token = bearerToken(request);
  if (!token) return json(response, 401, { ok: false, error: "unauthorized" });
  const user = await authenticate(backend.url, backend.publishableKey, token).catch(() => null);
  if (!user?.id) return json(response, 401, { ok: false, error: "unauthorized" });

  if (request.method === "GET") {
    json(response, 200, { ok: true, ...status });
    return;
  }

  const body = safeParse(request.body);
  const provider = String(body.provider || "");
  if (!isCalendarProvider(provider)) {
    json(response, 400, { ok: false, error: "invalid_input" });
    return;
  }
  if (!status.providers[provider].configured || !redirectUri) {
    json(response, 409, { ok: false, error: "activation_unset", provider });
    return;
  }

  const secrets = readProviderSecrets(env, backend.surface, provider);
  const pkce = pkcePair();
  const browserBinding = newOAuthBrowserBinding();
  const authorization = buildAuthorizationUrl({
    provider,
    clientId: secrets.clientId,
    redirectUri,
    state: pkce.state,
    codeChallenge: pkce.challenge,
    tenant: secrets.tenant,
  });
  if (!authorization.ok) {
    json(response, 409, { ok: false, error: authorization.reason });
    return;
  }
  try {
    // Request already records intent in the editor. A timed-out start may
    // reach this RPC after Remove, so it must never create a missing row.
    await memberRpc(backend, token, "authorize_calendar_oauth_start", { p_provider: provider });
    await serviceRpc(backend, "save_calendar_oauth_state", {
      p_state: pkce.state,
      p_steward: user.id,
      p_provider: provider,
      p_code_verifier: pkce.verifier,
      p_redirect_uri: redirectUri,
      p_browser_binding_hash: hashOAuthBrowserBinding(browserBinding),
      p_expires_at: isoExpiry(10),
    });
  } catch (error) {
    logSafe("start_refused", { reason: "rpc_failed", status: error?.status || null });
    json(response, error?.status === 401 || error?.status === 403 ? 403 : 503, { ok: false, error: "unauthorized" });
    return;
  }
  response.setHeader("Set-Cookie", oauthBrowserBindingCookie(provider, browserBinding));
  json(response, 200, { ok: true, provider, authorizationUrl: authorization.url, startedAt: isoNow() });
}
