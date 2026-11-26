import { calendarFreeBusyFailure } from "./errors.js";
import {
  CALENDAR_OAUTH_AUTHORIZE_URLS,
  CALENDAR_OAUTH_SCOPES,
  CALENDAR_OAUTH_TOKEN_URLS,
  isCalendarProvider,
} from "./config.js";

function asString(value) {
  return String(value || "").trim();
}

export function microsoftTenant(value) {
  const tenant = asString(value) || "common";
  if (!/^[A-Za-z0-9._-]+$/.test(tenant)) return "common";
  return tenant;
}

export function buildAuthorizationUrl({
  provider,
  clientId,
  redirectUri,
  state,
  codeChallenge,
  tenant,
}) {
  if (!isCalendarProvider(provider)) return calendarFreeBusyFailure("unknown_provider");
  if (!asString(clientId) || !asString(redirectUri) || !asString(state) || !asString(codeChallenge)) {
    return calendarFreeBusyFailure("activation_unset");
  }
  const url = new URL(
    provider === "microsoft"
      ? CALENDAR_OAUTH_AUTHORIZE_URLS.microsoft.replace("{tenant}", microsoftTenant(tenant))
      : CALENDAR_OAUTH_AUTHORIZE_URLS.google,
  );
  url.searchParams.set("client_id", asString(clientId));
  url.searchParams.set("redirect_uri", asString(redirectUri));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", asString(state));
  url.searchParams.set("code_challenge", asString(codeChallenge));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", CALENDAR_OAUTH_SCOPES[provider]);
  if (provider === "google") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "false");
  }
  return { ok: true, url: url.toString(), provider };
}

export function tokenEndpoint(provider, tenant) {
  if (!isCalendarProvider(provider)) return null;
  if (provider === "microsoft") {
    return CALENDAR_OAUTH_TOKEN_URLS.microsoft.replace("{tenant}", microsoftTenant(tenant));
  }
  return CALENDAR_OAUTH_TOKEN_URLS.google;
}

export function parseTokenResponse(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return calendarFreeBusyFailure("provider_error");
  }
  const refreshToken = asString(payload.refresh_token);
  const accessToken = asString(payload.access_token);
  if (!refreshToken || !accessToken) return calendarFreeBusyFailure("provider_error");
  const expiresIn = Number(payload.expires_in);
  return {
    ok: true,
    refreshToken,
    accessToken,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? Math.min(expiresIn, 86_400) : 3600,
    scope: asString(payload.scope),
  };
}
