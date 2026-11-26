import { SAAS_HOSTS } from "../../lib/demoOrigin.js";
export const CALENDAR_FREEBUSY_PROVIDERS = Object.freeze(["google", "microsoft"]);

export const CALENDAR_OAUTH_SCOPES = Object.freeze({
  google: "https://www.googleapis.com/auth/calendar.readonly",
  microsoft: "offline_access User.Read Calendars.ReadBasic",
});

export const CALENDAR_OAUTH_AUTHORIZE_URLS = Object.freeze({
  google: "https://accounts.google.com/o/oauth2/v2/auth",
  microsoft: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
});

export const CALENDAR_OAUTH_TOKEN_URLS = Object.freeze({
  google: "https://oauth2.googleapis.com/token",
  microsoft: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
});

export const CALENDAR_FREEBUSY_QUERY_URLS = Object.freeze({
  google: "https://www.googleapis.com/calendar/v3/freeBusy",
  microsoft: "https://graph.microsoft.com/v1.0/me/calendar/getSchedule",
});

export const CALENDAR_MICROSOFT_PROFILE_URL = "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName";

export const CALENDAR_IMPORT_URLS = Object.freeze({
  google: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
  microsoft: "https://graph.microsoft.com/v1.0/me/calendarView",
});

// OAuth may return only to a Union Ground portal host: the portals of the
// owner-approved backend pairs (src/lib/trustedBackends.js through
// SAAS_HOSTS). There are none yet, so every redirect URI is refused.
const ALLOWED_REDIRECT_HOSTS = SAAS_HOSTS;

export function isCalendarProvider(provider) {
  return CALENDAR_FREEBUSY_PROVIDERS.includes(provider);
}

export function providerEnvKeys(surface, provider) {
  const prefix = surface === "demo" ? "SAMPLE_" : "";
  if (provider === "google") {
    return Object.freeze({
      clientId: `${prefix}GOOGLE_CALENDAR_OAUTH_CLIENT_ID`,
      clientSecret: `${prefix}GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET`,
    });
  }
  return Object.freeze({
    clientId: `${prefix}MICROSOFT_CALENDAR_OAUTH_CLIENT_ID`,
    clientSecret: `${prefix}MICROSOFT_CALENDAR_OAUTH_CLIENT_SECRET`,
    tenant: `${prefix}MICROSOFT_CALENDAR_OAUTH_TENANT`,
  });
}

function envString(env, key) {
  return String(env?.[key] || "").trim();
}

export function wrapKeyName(surface) {
  return surface === "demo" ? "SAMPLE_CALENDAR_OAUTH_TOKEN_WRAP_KEY" : "CALENDAR_OAUTH_TOKEN_WRAP_KEY";
}

export function resolveCalendarOAuthStatus(env, { surface = "saas" } = {}) {
  const wrapKeyPresent = envString(env, wrapKeyName(surface)).length >= 32;
  const providers = {};
  for (const provider of CALENDAR_FREEBUSY_PROVIDERS) {
    const keys = providerEnvKeys(surface, provider);
    const clientIdPresent = envString(env, keys.clientId).length > 0;
    const clientSecretPresent = envString(env, keys.clientSecret).length >= 16;
    providers[provider] = {
      configured: wrapKeyPresent && clientIdPresent && clientSecretPresent,
      clientIdPresent,
      clientSecretPresent,
      wrapKeyPresent,
    };
  }
  return {
    surface,
    wrapKeyPresent,
    providers,
  };
}

export function isAllowedCalendarOAuthHost(hostname) {
  const host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  return ALLOWED_REDIRECT_HOSTS.includes(host);
}

export function calendarOAuthRedirectUri(hostname) {
  const host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  if (!isAllowedCalendarOAuthHost(host)) return null;
  const canonical = host.startsWith("www.") ? host.slice(4) : host;
  return `https://${canonical}/api/calendar-oauth`;
}
