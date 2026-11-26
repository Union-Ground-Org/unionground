import { createHash, randomBytes } from "node:crypto";
import { requestHost } from "./http.js";
import {
  CONSTANT_CONTACT_ACTIVITY_TYPES,
  CONSTANT_CONTACT_API_BASE_URL,
  CONSTANT_CONTACT_TOKEN_URL,
  constantContactPaginationUrl,
  constantContactRedirectUri,
  constantContactStatus,
  parseConstantContactToken,
  resolveConstantContactActivation,
  summarizeConstantContactActivities,
} from "../../src/features/integrations/constantContact.js";

const BINDING_COOKIE = "constant_contact_oauth_binding";
export const CONSTANT_CONTACT_FINALIZATION_RESERVE_MS = 12_000;

function envString(env, key) {
  return String(env?.[key] || "").trim();
}

export function constantContactSecrets(env, surface) {
  const prefix = surface === "demo" ? "SAMPLE_" : "";
  return Object.freeze({
    clientId: envString(env, `${prefix}CONSTANT_CONTACT_CLIENT_ID`),
    clientSecret: envString(env, `${prefix}CONSTANT_CONTACT_CLIENT_SECRET`),
  });
}

export function constantContactPublicStatus(env, surface) {
  const status = resolveConstantContactActivation(env, surface);
  return { configured: status.configured };
}

export function constantContactPkce() {
  const verifier = randomBytes(32).toString("base64url");
  return Object.freeze({
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(32).toString("base64url"),
  });
}

export function newConstantContactBrowserBinding() {
  return randomBytes(32).toString("base64url");
}

export function hashConstantContactSecret(value) {
  const normalized = String(value || "");
  return normalized ? createHash("sha256").update(normalized).digest("hex") : "";
}

export function constantContactBindingCookie(value, { clear = false } = {}) {
  const encoded = clear ? "" : String(value || "");
  return `${BINDING_COOKIE}=${encoded}; Path=/api/constant-contact-oauth; Max-Age=${clear ? 0 : 600}; HttpOnly; Secure; SameSite=Lax`;
}

export function readConstantContactBinding(headers) {
  const cookieHeader = String(headers?.cookie || "");
  for (const part of cookieHeader.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === BINDING_COOKIE) return value.join("=");
  }
  return "";
}

export function constantContactRedirectForRequest(request) {
  return constantContactRedirectUri(requestHost(request));
}

function providerTimeout(deadlineMs) {
  if (!Number.isFinite(deadlineMs)) return 12_000;
  const remaining = Math.trunc(deadlineMs - Date.now() - CONSTANT_CONTACT_FINALIZATION_RESERVE_MS);
  if (remaining <= 0) throw new Error("invocation_budget");
  return Math.min(12_000, remaining);
}

export async function requestConstantContactToken({ clientId, clientSecret, body, fetcher = fetch, deadlineMs }) {
  const response = await fetcher(CONSTANT_CONTACT_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams(body),
    redirect: "error",
    signal: AbortSignal.timeout(providerTimeout(deadlineMs)),
  });
  const payload = await response.json().catch(() => null);
  const oauthError = typeof payload?.error === "string" ? payload.error.slice(0, 64) : "";
  if (!response.ok) {
    return {
      ok: false,
      reason: response.status === 401 || oauthError === "invalid_grant" || oauthError === "invalid_client"
        ? "credential_rejected"
        : "provider_error",
    };
  }
  return parseConstantContactToken(payload, { requireRefreshToken: body.grant_type === "authorization_code" });
}

async function constantContactGet(path, accessToken, fetcher, deadlineMs) {
  const url = constantContactPaginationUrl(path.startsWith("https://") ? path : `${CONSTANT_CONTACT_API_BASE_URL}${path}`);
  if (!url) throw new Error("provider_url_rejected");
  const response = await fetcher(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(providerTimeout(deadlineMs)),
  });
  if (!response.ok) throw Object.assign(new Error("provider_request_failed"), { status: response.status });
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("provider_payload_invalid");
  return payload;
}

const ACCOUNT_LABEL_MAX_CHARS = 120;

export function constantContactAccountLabel(summary) {
  const clean = (value) => Array.from(typeof value === "string" ? value : "", (char) => {
    const code = char.codePointAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : char;
  }).join("").replace(/\s+/g, " ").trim();
  const label = clean(summary?.organization_name) || clean(summary?.contact_email);
  return Array.from(label).slice(0, ACCOUNT_LABEL_MAX_CHARS).join("").trim();
}

export async function fetchConstantContactAccountLabel({ accessToken, fetcher = fetch, deadlineMs }) {
  try {
    return constantContactAccountLabel(await constantContactGet("/account/summary", accessToken, fetcher, deadlineMs));
  } catch {
    return "";
  }
}

export async function fetchConstantContactMember({ accessToken, email, fetcher = fetch, deadlineMs }) {
  const query = new URLSearchParams({
    email: String(email || "").toLowerCase().trim(),
    status: "all",
    include: "list_memberships,taggings",
    limit: "1",
  });
  const contactPayload = await constantContactGet(`/contacts?${query}`, accessToken, fetcher, deadlineMs);
  const contact = Array.isArray(contactPayload.contacts) ? contactPayload.contacts[0] || null : null;
  if (!contact?.contact_id) {
    return {
      providerContactId: null,
      contactStatus: constantContactStatus(contact),
      listCount: 0,
      tagCount: 0,
      analytics: summarizeConstantContactActivities([]),
    };
  }

  const activities = [];
  let next = `/reports/contact_reports/${encodeURIComponent(contact.contact_id)}/activity_details?${new URLSearchParams({
    tracking_activities_list: CONSTANT_CONTACT_ACTIVITY_TYPES.join(","),
    include_campaign_activity_names: "false",
    limit: "100",
  })}`;
  for (let page = 0; next && page < 3 && activities.length < 300; page += 1) {
    const activityPayload = await constantContactGet(next, accessToken, fetcher, deadlineMs);
    activities.push(...(Array.isArray(activityPayload.tracking_activities) ? activityPayload.tracking_activities : []));
    next = constantContactPaginationUrl(activityPayload?._links?.next);
  }
  return {
    providerContactId: String(contact.contact_id),
    contactStatus: constantContactStatus(contact),
    listCount: Array.isArray(contact.list_memberships) ? contact.list_memberships.length : 0,
    tagCount: Array.isArray(contact.taggings) ? contact.taggings.length : 0,
    analytics: summarizeConstantContactActivities(activities.slice(0, 300)),
  };
}
