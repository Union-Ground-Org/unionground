import { resolveSupabaseBackend } from "./_lib/backend.js";
import {
  constantContactBindingCookie,
  constantContactPkce,
  constantContactPublicStatus,
  constantContactRedirectForRequest,
  constantContactSecrets,
  fetchConstantContactAccountLabel,
  hashConstantContactSecret,
  newConstantContactBrowserBinding,
  readConstantContactBinding,
  requestConstantContactToken,
} from "./_lib/constantContact.js";
import { bearerToken, json, methodGuard, requireEnv, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";
import { buildConstantContactAuthorizeUrl } from "../src/features/integrations/constantContact.js";
import { portalOrigin } from "../src/lib/demoOrigin.js";

function safeBody(body) {
  if (body && typeof body === "object") return body;
  try {
    return JSON.parse(String(body || "{}"));
  } catch {
    return {};
  }
}

function redirect(response, location) {
  response.status(302);
  response.setHeader("Location", location);
  response.setHeader("Cache-Control", "no-store");
  response.end();
}

function integrationsUrl(surface, status) {
  const origin = portalOrigin(surface);
  return `${origin}/m/integrations?constant_contact=${status}`;
}

function safeLog(kind, reason) {
  console.error("[constant-contact-oauth]", { kind, reason });
}

async function serviceRpc(backend, name, body) {
  return supabaseRpc(backend.url, backend.serviceRoleKey, backend.serviceRoleKey, name, body);
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["GET", "POST"], () => json(response, 405, { ok: false, error: "method_not_allowed" }))) return;
  const backend = resolveSupabaseBackend(request);
  if (requireEnv([backend.url, backend.publishableKey, backend.serviceRoleKey],
    () => json(response, 503, { ok: false, error: "not_configured" }))) return;

  const configured = constantContactPublicStatus(process.env, backend.surface);
  const redirectUri = constantContactRedirectForRequest(request);
  const secrets = constantContactSecrets(process.env, backend.surface);

  if (request.method === "GET" && (request.query?.code || request.query?.state || request.query?.error)) {
    const providerError = String(request.query?.error || "");
    const code = String(request.query?.code || "");
    const state = String(request.query?.state || "");
    const binding = readConstantContactBinding(request.headers);
    response.setHeader("Set-Cookie", constantContactBindingCookie("", { clear: true }));
    if (providerError || !code || !state || !binding || !configured.configured || !redirectUri) {
      safeLog("callback_refused", providerError ? "provider_denied" : "invalid_callback");
      redirect(response, integrationsUrl(backend.surface, providerError ? "denied" : "error"));
      return;
    }

    let claimed;
    try {
      claimed = await serviceRpc(backend, "claim_constant_contact_oauth_state", {
        p_state_hash: hashConstantContactSecret(state),
        p_browser_binding_hash: hashConstantContactSecret(binding),
      });
    } catch {
      safeLog("callback_refused", "state_unknown");
      redirect(response, integrationsUrl(backend.surface, "error"));
      return;
    }

    const token = await requestConstantContactToken({
      clientId: secrets.clientId,
      clientSecret: secrets.clientSecret,
      body: {
        grant_type: "authorization_code",
        code,
        code_verifier: claimed.codeVerifier,
        redirect_uri: claimed.redirectUri,
      },
    }).catch(() => ({ ok: false, reason: "provider_error" }));
    if (!token.ok) {
      safeLog("callback_refused", token.reason);
      redirect(response, integrationsUrl(backend.surface, "error"));
      return;
    }
    const accountLabel = await fetchConstantContactAccountLabel({ accessToken: token.accessToken });
    try {
      await serviceRpc(backend, "complete_constant_contact_oauth", {
        p_organization_id: claimed.organizationId,
        p_requested_by: claimed.requestedBy,
        p_refresh_token: token.refreshToken,
        p_scope: token.scope,
        p_account_label: accountLabel || "Connected account",
      });
    } catch {
      safeLog("callback_refused", "token_store_failed");
      redirect(response, integrationsUrl(backend.surface, "error"));
      return;
    }
    redirect(response, integrationsUrl(backend.surface, "connected"));
    return;
  }

  if (request.method === "GET") {
    json(response, 200, { ok: true, configured: configured.configured });
    return;
  }

  const token = bearerToken(request);
  if (!token) return json(response, 401, { ok: false, error: "unauthorized" });
  if (!configured.configured || !redirectUri) {
    json(response, 409, { ok: false, error: "activation_unset" });
    return;
  }
  const body = safeBody(request.body);
  if (body.action !== "start") {
    json(response, 400, { ok: false, error: "invalid_input" });
    return;
  }

  const pkce = constantContactPkce();
  const browserBinding = newConstantContactBrowserBinding();
  const authorization = buildConstantContactAuthorizeUrl({
    clientId: secrets.clientId,
    redirectUri,
    state: pkce.state,
    codeChallenge: pkce.challenge,
  });
  if (!authorization.ok) return json(response, 409, { ok: false, error: authorization.reason });
  try {
    await supabaseRpc(backend.url, backend.publishableKey, token, "begin_constant_contact_oauth", {
      p_state_hash: hashConstantContactSecret(pkce.state),
      p_code_verifier: pkce.verifier,
      p_redirect_uri: redirectUri,
      p_browser_binding_hash: hashConstantContactSecret(browserBinding),
      p_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
  } catch (error) {
    safeLog("start_refused", error?.status === 401 || error?.status === 403 ? "unauthorized" : "rpc_failed");
    return json(response, error?.status === 401 || error?.status === 403 ? 403 : 503, {
      ok: false,
      error: error?.status === 401 || error?.status === 403 ? "unauthorized" : "unavailable",
    });
  }
  response.setHeader("Set-Cookie", constantContactBindingCookie(browserBinding));
  json(response, 200, { ok: true, authorizationUrl: authorization.url });
}
