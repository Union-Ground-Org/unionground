// Organization Google activations: the setup status an administrator sees for
// the organization calendar connection, its OAuth round trip and its scheduled
// copy job (REQ-UG-ORG-CALENDAR-PUSH-SYNC-20261001). There is no Google
// Wallet pass: Union Ground has no membership card to save.
//
//   POST ?action=status          bearer: administrator status (no secrets)
//   POST ?action=calendar-start  bearer: begin the organization's Google OAuth
//   GET  ?action=calendar-callback        Google's redirect back
//   GET  (Vercel cron) or POST ?action=calendar-sync with the CRON_SECRET bearer
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { cronAuthorization, cronRefusalBody } from "./_lib/cronAuth.js";
import { bearerToken, json, methodGuard, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";
import { readGoogleDriveAccountEmail } from "./_lib/googleDrive.js";
import {
  buildOrganizationCalendarAuthorizationUrl,
  buildOrganizationCalendarOauthMaterial,
  exchangeOrganizationCalendarCode,
  organizationCalendarConfig,
  runOrganizationCalendarPush,
} from "./_lib/organizationCalendar.js";
import { portalOrigin } from "../src/lib/demoOrigin.js";
import {
  boundOAuthState,
  boundOAuthStateHash,
  newOAuthStateBinding,
  oauthStateBindingCookie,
  readOAuthStateBinding,
  startOnOtherSiteAddress,
} from "./_lib/oauthStateBinding.js";

const CALENDAR_BINDING_COOKIE = "org_calendar_oauth_binding";

function queryValue(request, key) {
  const direct = request?.query?.[key];
  if (Array.isArray(direct)) return String(direct[0] || "");
  if (direct != null) return String(direct);
  try { return new URL(request.url, "https://local.invalid").searchParams.get(key) || ""; } catch { return ""; }
}

function safeLog(kind, reason) {
  // Never log a user, organization, OAuth code/state, token or provider body.
  console.error("[google-activations]", { kind, reason });
}

function redirect(response, location) {
  response.status(302).setHeader("Location", location);
  response.setHeader("Cache-Control", "no-store");
  response.end();
}

function serviceCaller(backend) {
  return (name, args = {}) => supabaseRpc(backend.url, backend.serviceRoleKey, backend.serviceRoleKey, name, args, { timeoutMs: 8000 });
}

function refusal(error) {
  const status = Number(error?.status || 0);
  if (status === 401 || status === 403 || error?.code === "42501") return { status: 403, error: "not-authorized" };
  return { status: 503, error: "unavailable" };
}

async function calendarSync(response, backend) {
  if (!backend.url || !backend.serviceRoleKey) return json(response, 503, { ok: false, error: "not-configured" });
  const config = organizationCalendarConfig(backend.surface);
  if (!config) return json(response, 200, { ok: true, skipped: "activation_unset" });
  try {
    const summary = await runOrganizationCalendarPush({ service: serviceCaller(backend), config });
    return json(response, summary.failed > 0 || summary.tokenFailures > 0 ? 207 : 200, { ok: summary.failed === 0 && summary.tokenFailures === 0, ...summary });
  } catch {
    safeLog("sync_failed", "work_list_unavailable");
    return json(response, 502, { ok: false, error: "work-list-unavailable" });
  }
}

async function calendarCallback(request, response, backend) {
  const config = organizationCalendarConfig(backend.surface);
  const fallbackOrigin = portalOrigin(backend.surface);
  let origin = fallbackOrigin;
  try { if (config) origin = new URL(config.redirectUri).origin; } catch { origin = fallbackOrigin; }
  const destination = `${origin}/m/integrations?calendar_push=`;
  const code = queryValue(request, "code");
  const state = queryValue(request, "state");
  if (!config || !backend.url || !backend.serviceRoleKey) {
    safeLog("callback_refused", "activation_unset");
    return redirect(response, `${destination}unset`);
  }
  if (!code || !state || code.length > 2048 || state.length > 200) {
    safeLog("callback_refused", queryValue(request, "error") ? "provider_denied" : "invalid_callback");
    return redirect(response, `${destination}failed`);
  }
  const boundState = boundOAuthState(state, readOAuthStateBinding(request.headers, CALENDAR_BINDING_COOKIE));
  if (!boundState) {
    safeLog("callback_refused", "browser_binding_missing");
    return redirect(response, `${destination}failed`);
  }
  const service = serviceCaller(backend);
  let reason = "state_claim_failed";
  try {
    const claimed = await service("claim_organization_calendar_oauth_state", { p_state: boundState });
    // Only the return that claimed this browser's start spends its binding. A
    // refused or stray visit leaves it, so it cannot void a connect in progress.
    response.setHeader("Set-Cookie", oauthStateBindingCookie(CALENDAR_BINDING_COOKIE, "", config.redirectUri, { clear: true }));
    if (claimed?.redirectUri !== config.redirectUri) {
      reason = "redirect_mismatch";
      throw new Error(reason);
    }
    reason = "code_exchange_failed";
    const tokens = await exchangeOrganizationCalendarCode({
      config, code, codeVerifier: claimed.codeVerifier, redirectUri: claimed.redirectUri,
    });
    reason = "credential_store_failed";
    await service("complete_organization_calendar_oauth", {
      p_organization_id: claimed.organizationId,
      p_user_id: claimed.userId,
      p_refresh_token: tokens.refreshToken,
      p_scopes: tokens.scope,
      p_account_email: readGoogleDriveAccountEmail(tokens.idToken, { clientId: config.clientId }),
    });
    return redirect(response, `${destination}connected`);
  } catch (error) {
    safeLog("callback_refused", error?.message === "scope_not_granted" ? "scope_not_granted" : reason);
    return redirect(response, `${destination}failed`);
  }
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["GET", "POST"], () => json(response, 405, { error: "method-not-allowed" }))) return;
  const action = queryValue(request, "action");
  const backend = resolveSupabaseBackend(request);

  if (request.method === "GET") {
    if (action === "calendar-callback") return calendarCallback(request, response, backend);
    if (action) return json(response, 405, { error: "method-not-allowed" });
    // The scheduled GET is the Vercel cron tick: without the CRON_SECRET
    // bearer it is refused and calls nothing.
    const cron = cronAuthorization(request);
    if (!cron.ok) return json(response, cron.status, cronRefusalBody(cron));
    return calendarSync(response, backend);
  }

  if (action === "calendar-sync") {
    const cron = cronAuthorization(request);
    if (!cron.ok) return json(response, cron.status, cronRefusalBody(cron));
    return calendarSync(response, backend);
  }

  const token = bearerToken(request);
  if (!token) return json(response, 401, { error: "unauthorized" });
  if (!backend.url || !backend.publishableKey) return json(response, 503, { error: "not-configured" });
  const memberRpc = (name, args = {}) => supabaseRpc(backend.url, backend.publishableKey, token, name, args);
  const calendarConfig = organizationCalendarConfig(backend.surface);

  if (action === "status") {
    try {
      const calendar = await memberRpc("get_organization_calendar_push_status");
      return json(response, 200, {
        calendar: { configured: Boolean(calendarConfig), ...calendar },
      });
    } catch (error) {
      const failure = refusal(error);
      return json(response, failure.status, { error: failure.error });
    }
  }

  if (action === "calendar-start") {
    if (!calendarConfig) return json(response, 409, { error: "activation-unset" });
    const siteAddress = startOnOtherSiteAddress(request, calendarConfig.redirectUri);
    if (siteAddress) return json(response, 409, { error: "use-site-address", siteAddress });
    const material = buildOrganizationCalendarOauthMaterial();
    const binding = newOAuthStateBinding();
    try {
      await memberRpc("begin_organization_calendar_oauth", {
        p_state_hash: boundOAuthStateHash(material.state, binding),
        p_code_verifier: material.codeVerifier,
        p_redirect_uri: calendarConfig.redirectUri,
        p_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
    } catch (error) {
      const failure = refusal(error);
      return json(response, failure.status, { error: failure.error });
    }
    response.setHeader("Set-Cookie", oauthStateBindingCookie(CALENDAR_BINDING_COOKIE, binding, calendarConfig.redirectUri));
    return json(response, 200, {
      authorizationUrl: buildOrganizationCalendarAuthorizationUrl({
        clientId: calendarConfig.clientId,
        redirectUri: calendarConfig.redirectUri,
        state: material.state,
        codeChallenge: material.codeChallenge,
      }),
    });
  }

  return json(response, 404, { error: "unknown-action" });
}
