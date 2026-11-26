import { SAAS_HOSTS } from "../../lib/demoOrigin.js";
export const CONSTANT_CONTACT_API_BASE_URL = "https://api.cc.email/v3";
const CONSTANT_CONTACT_AUTHORIZATION_URL = "https://authz.constantcontact.com/oauth2/default/v1/authorize";
export const CONSTANT_CONTACT_TOKEN_URL = "https://authz.constantcontact.com/oauth2/default/v1/token";
export const CONSTANT_CONTACT_SCOPES = Object.freeze(["account_read", "contact_data", "campaign_data", "offline_access"]);
export const CONSTANT_CONTACT_ACTIVITY_TYPES = Object.freeze([
  "em_sends",
  "em_opens",
  "em_clicks",
  "em_bounces",
  "em_optouts",
  "em_forwards",
]);

// OAuth may return only to a Union Ground portal host: the portals of the
// owner-approved backend pairs (src/lib/trustedBackends.js through
// SAAS_HOSTS). There are none yet, so every redirect URI is refused.
const ALLOWED_REDIRECT_HOSTS = SAAS_HOSTS;

const COUNT_FIELDS = Object.freeze({
  em_sends: "sendsCount",
  em_opens: "opensCount",
  em_clicks: "clicksCount",
  em_bounces: "bouncesCount",
  em_optouts: "optoutsCount",
  em_forwards: "forwardsCount",
});

const LAST_FIELDS = Object.freeze({
  em_sends: "lastSentAt",
  em_opens: "lastOpenedAt",
  em_clicks: "lastClickedAt",
  em_bounces: "lastBouncedAt",
  em_optouts: "lastOptedOutAt",
  em_forwards: "lastForwardedAt",
});

function asString(value) {
  return String(value || "").trim();
}

export function constantContactEnvKeys(surface = "saas") {
  const prefix = surface === "demo" ? "SAMPLE_" : "";
  return Object.freeze({
    clientId: `${prefix}CONSTANT_CONTACT_CLIENT_ID`,
    clientSecret: `${prefix}CONSTANT_CONTACT_CLIENT_SECRET`,
  });
}

export function resolveConstantContactActivation(env, surface = "saas") {
  const keys = constantContactEnvKeys(surface);
  const clientIdPresent = asString(env?.[keys.clientId]).length > 0;
  const clientSecretPresent = asString(env?.[keys.clientSecret]).length >= 16;
  return Object.freeze({
    configured: clientIdPresent && clientSecretPresent,
    clientIdPresent,
    clientSecretPresent,
    surface,
  });
}

export function constantContactRedirectUri(hostname) {
  const host = asString(hostname).toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
  if (!ALLOWED_REDIRECT_HOSTS.includes(host)) return null;
  const canonical = host.startsWith("www.") ? host.slice(4) : host;
  return `https://${canonical}/api/constant-contact-oauth`;
}

export function buildConstantContactAuthorizeUrl({ clientId, redirectUri, state, codeChallenge }) {
  if (![clientId, redirectUri, state, codeChallenge].every((value) => asString(value))) {
    return { ok: false, reason: "activation_unset" };
  }
  const url = new URL(CONSTANT_CONTACT_AUTHORIZATION_URL);
  url.searchParams.set("client_id", asString(clientId));
  url.searchParams.set("redirect_uri", asString(redirectUri));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", CONSTANT_CONTACT_SCOPES.join(" "));
  url.searchParams.set("state", asString(state));
  url.searchParams.set("code_challenge", asString(codeChallenge));
  url.searchParams.set("code_challenge_method", "S256");
  return { ok: true, url: url.toString() };
}

export function parseConstantContactToken(payload, { requireRefreshToken = false } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "provider_error" };
  }
  const accessToken = asString(payload.access_token);
  const refreshToken = asString(payload.refresh_token);
  if (!accessToken || (requireRefreshToken && !refreshToken)) {
    return { ok: false, reason: "provider_error" };
  }
  return {
    ok: true,
    accessToken,
    refreshToken,
    scope: asString(payload.scope),
    tokenType: asString(payload.token_type) || "Bearer",
  };
}

function normalizeConstantContactActivityType(activity) {
  const raw = asString(activity?.tracking_activity_type)
    || asString(activity?.tracking_activities_list).split(",")[0]?.trim()
    || "";
  return CONSTANT_CONTACT_ACTIVITY_TYPES.includes(raw) ? raw : null;
}

function normalizeConstantContactDate(value) {
  const timestamp = Date.parse(asString(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function summarizeConstantContactActivities(activities = []) {
  const summary = {
    sendsCount: 0,
    opensCount: 0,
    clicksCount: 0,
    bouncesCount: 0,
    optoutsCount: 0,
    forwardsCount: 0,
    lastSentAt: null,
    lastOpenedAt: null,
    lastClickedAt: null,
    lastBouncedAt: null,
    lastOptedOutAt: null,
    lastForwardedAt: null,
    lastActivityAt: null,
  };
  for (const activity of Array.isArray(activities) ? activities : []) {
    const type = normalizeConstantContactActivityType(activity);
    const occurredAt = normalizeConstantContactDate(activity?.created_time);
    if (!type || !occurredAt) continue;
    const countField = COUNT_FIELDS[type];
    const lastField = LAST_FIELDS[type];
    summary[countField] += 1;
    if (!summary[lastField] || occurredAt > summary[lastField]) summary[lastField] = occurredAt;
    if (!summary.lastActivityAt || occurredAt > summary.lastActivityAt) summary.lastActivityAt = occurredAt;
  }
  return summary;
}

export function constantContactStatus(contact) {
  if (!contact) return "not_found";
  if (contact.deleted_at) return "deleted";
  if (contact.email_address?.permission_to_send === "unsubscribed") return "unsubscribed";
  return contact.contact_id ? "active" : "unknown";
}

export function constantContactPaginationUrl(value) {
  const raw = typeof value === "string" ? value : value?.href;
  if (!asString(raw)) return null;
  try {
    const url = new URL(raw, CONSTANT_CONTACT_API_BASE_URL);
    if (url.protocol !== "https:" || url.hostname !== "api.cc.email" || !url.pathname.startsWith("/v3/")) return null;
    return url.toString();
  } catch {
    return null;
  }
}
