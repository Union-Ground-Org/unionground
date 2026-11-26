// Organization calendar push (REQ-UG-ORG-CALENDAR-PUSH-SYNC-20261001, CR-090).
//
// Restores the old app/dashboard/events/actions.ts syncEventToCalendar (~259)
// push of chapter events to the organization's Google calendar, now through
// the organization's own OAuth grant (calendar.events scope) instead of a
// platform service account, and kept in sync by a scheduled job rather than a
// one-off click. The old one-way import of that calendar into Events is not
// restored here (see the operator guide).

import { createHash, randomBytes } from "node:crypto";
import { brandText } from "./brand.js";

export const ORG_CALENDAR_SCOPE = "openid email https://www.googleapis.com/auth/calendar.events";
export const ORG_CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars";
// Old createEvent default: an event without an end ran two hours
// (app/dashboard/events/actions.ts createEvent, end_date fallback).
const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;
const REVOKED_GRANT_ERRORS = new Set(["invalid_grant", "invalid_token"]);

function envKeys(surface) {
  const prefix = surface === "demo" ? "SAMPLE_" : "";
  return {
    clientId: `${prefix}GOOGLE_ORG_CALENDAR_CLIENT_ID`,
    clientSecret: `${prefix}GOOGLE_ORG_CALENDAR_CLIENT_SECRET`,
    redirectUri: `${prefix}GOOGLE_ORG_CALENDAR_REDIRECT_URI`,
  };
}

export function organizationCalendarEnvNames(surface) {
  return Object.values(envKeys(surface));
}

/** The operator's OAuth client for this surface, or null when the activation is unset. */
export function organizationCalendarConfig(surface, env = process.env) {
  const keys = envKeys(surface);
  const clientId = String(env?.[keys.clientId] || "").trim();
  const clientSecret = String(env?.[keys.clientSecret] || "").trim();
  const redirectUri = String(env?.[keys.redirectUri] || "").trim();
  if (!clientId || clientSecret.length < 16 || !/^https:\/\/[^\s]+$/.test(redirectUri)) return null;
  return { clientId, clientSecret, redirectUri };
}

export function buildOrganizationCalendarOauthMaterial() {
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(48).toString("base64url");
  return {
    state,
    stateHash: createHash("sha256").update(state).digest("hex"),
    codeVerifier,
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
  };
}

export function buildOrganizationCalendarAuthorizationUrl({ clientId, redirectUri, state, codeChallenge }) {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", ORG_CALENDAR_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function readJson(response) {
  const text = await response.text().catch(() => "");
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

export async function exchangeOrganizationCalendarCode({ fetchImpl = fetch, config, code, codeVerifier, redirectUri }) {
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(12_000),
  });
  const body = await readJson(response);
  if (!response.ok || !body?.access_token || !body?.refresh_token) throw new Error("code_exchange_failed");
  const scope = String(body.scope || "").slice(0, 2000);
  if (!scope.split(/\s+/).includes(ORG_CALENDAR_EVENTS_SCOPE)) throw new Error("scope_not_granted");
  return { refreshToken: String(body.refresh_token), scope, idToken: String(body.id_token || "") };
}

export async function refreshOrganizationCalendarToken({ fetchImpl = fetch, config, refreshToken, timeoutMs = 12_000 }) {
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await readJson(response);
  if (!response.ok || !body?.access_token) {
    const error = new Error("token_refresh_failed");
    error.code = REVOKED_GRANT_ERRORS.has(String(body?.error || "").toLowerCase()) ? "grant_revoked" : "token_refresh_failed";
    throw error;
  }
  return String(body.access_token);
}

function boundedText(value, max) {
  const text = String(value || "").trim();
  return text.length <= max ? text : text.slice(0, max);
}

/** The Google event body for one campaign meeting: title, time, place and summary only. */
export function googleEventBody(operation) {
  const event = operation?.event || {};
  const start = new Date(event.startsAt);
  if (!Number.isFinite(start.getTime())) throw new Error("invalid_event_time");
  // The RPC sends an ISO timestamp with an offset. Ignore values that would
  // make the end depend on the worker's local time zone.
  const explicitEnd = typeof event.endsAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/u.test(event.endsAt)
    ? Date.parse(event.endsAt) : NaN;
  const end = explicitEnd > start.getTime() ? explicitEnd : start.getTime() + DEFAULT_DURATION_MS;
  return {
    summary: boundedText(event.title, 300) || "Campaign meeting",
    description: [boundedText(event.summary, 4000), brandText("Shared from Union Ground.")].filter(Boolean).join("\n\n"),
    location: boundedText(event.location, 500),
    start: { dateTime: start.toISOString() },
    end: { dateTime: new Date(end).toISOString() },
    extendedProperties: { private: { unionGroundEventId: boundedText(operation.eventId, 200) } },
  };
}

function eventsUrl(calendarId, eventId = "") {
  const base = `${CALENDAR_API}/${encodeURIComponent(calendarId)}/events`;
  return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
}

function httpError(status) {
  const error = new Error("calendar_http");
  error.status = status;
  error.code = status === 401 || status === 403 ? "calendar_forbidden"
    : status === 404 || status === 410 ? "calendar_not_found"
      : status === 429 ? "calendar_rate_limited"
        : status >= 500 ? "calendar_unavailable" : "calendar_rejected";
  return error;
}

async function calendarRequest(fetchImpl, accessToken, url, method, body, timeoutMs) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { response, body: method === "DELETE" ? null : await readJson(response) };
}

/**
 * Apply one work item. Returns { outcome: "upserted", googleEventId } or
 * { outcome: "deleted" }; throws an error carrying a short `code` otherwise.
 * A copy removed in Google already counts as deleted; an update whose copy
 * vanished is re-created.
 */
export async function applyCalendarOperation({ fetchImpl = fetch, accessToken, operation, organizationId = "", timeoutMs = 10_000 }) {
  if (operation.op === "delete") {
    const { response } = await calendarRequest(fetchImpl, accessToken, eventsUrl(operation.calendarId, operation.googleEventId), "DELETE", null, timeoutMs);
    if (response.ok || response.status === 404 || response.status === 410) return { outcome: "deleted" };
    throw httpError(response.status);
  }
  const body = googleEventBody(operation);
  // A supplied Google ID makes an uncertain create retryable without another
  // visible copy. Hex is a subset of Google's base32hex event-ID alphabet.
  // Scope by tenant and calendar as source IDs can repeat across backends.
  const sourceKey = createHash("sha256").update(JSON.stringify([
    "unionground-org-calendar-v1", organizationId, operation.calendarId, operation.eventId,
  ])).digest("hex");
  body.extendedProperties.private.unionGroundPushKey = sourceKey;
  body.status = "confirmed";
  if (operation.googleEventId) {
    const updated = await calendarRequest(fetchImpl, accessToken, eventsUrl(operation.calendarId, operation.googleEventId), "PUT", body, timeoutMs);
    if (updated.response.ok && updated.body?.id) return { outcome: "upserted", googleEventId: String(updated.body.id) };
    if (updated.response.status !== 404 && updated.response.status !== 410) throw httpError(updated.response.status);
  }
  // A vanished, recorded copy gets a new deterministic generation: Google may
  // retain the deleted ID as a tombstone. A failed replacement result write
  // still carries the old mapping, so the next pass chooses this same ID.
  const id = operation.googleEventId
    ? createHash("sha256").update(JSON.stringify([sourceKey, operation.googleEventId])).digest("hex")
    : sourceKey;
  const created = await calendarRequest(fetchImpl, accessToken, eventsUrl(operation.calendarId), "POST", { ...body, id }, timeoutMs);
  if (created.response.ok && created.body?.id === id) {
    return { outcome: "upserted", googleEventId: id };
  }
  if (created.response.status === 409) {
    const existing = await calendarRequest(fetchImpl, accessToken, eventsUrl(operation.calendarId, id), "GET", null, timeoutMs);
    if (!existing.response.ok) throw httpError(existing.response.status);
    if (existing.body?.id !== id
        || existing.body?.extendedProperties?.private?.unionGroundEventId !== body.extendedProperties.private.unionGroundEventId
        || existing.body?.extendedProperties?.private?.unionGroundPushKey !== sourceKey) {
      throw httpError(409);
    }
    // The source may have changed since the uncertain create. Apply today's
    // body before recording today's content hash against the recovered ID.
    // An owned cancelled copy can also be restored after our delete cleared
    // its database mapping; an unmarked tombstone fails the ownership check.
    const recovered = await calendarRequest(fetchImpl, accessToken, eventsUrl(operation.calendarId, id), "PUT", body, timeoutMs);
    if (recovered.response.ok && recovered.body?.id === id) return { outcome: "upserted", googleEventId: id };
    throw httpError(recovered.response.ok ? 502 : recovered.response.status);
  }
  throw httpError(created.response.ok ? 502 : created.response.status);
}

/**
 * One scheduled pass. `service(name, args)` calls a service-role RPC. Stops
 * starting new work once the time budget is spent; the next tick continues.
 */
export async function runOrganizationCalendarPush({ service, config, fetchImpl = fetch, budgetMs = 45_000, now = () => Date.now() }) {
  const startedAt = now();
  const summary = { organizations: 0, upserted: 0, deleted: 0, failed: 0, tokenFailures: 0, skippedBudget: 0 };
  const work = await service("list_organization_calendar_push_work", { p_organization_limit: 10, p_operation_limit: 25 });
  const organizations = Array.isArray(work) ? work : [];
  for (const organization of organizations) {
    if (now() - startedAt > budgetMs) {
      summary.skippedBudget += 1;
      continue;
    }
    summary.organizations += 1;
    let accessToken;
    try {
      const credential = await service("read_organization_calendar_refresh_token", { p_organization_id: organization.organizationId });
      accessToken = await refreshOrganizationCalendarToken({ fetchImpl, config, refreshToken: credential?.refreshToken });
    } catch (error) {
      summary.tokenFailures += 1;
      await service("record_organization_calendar_push_run", {
        p_organization_id: organization.organizationId,
        p_status: "error",
        p_error_code: error?.code === "grant_revoked" ? "grant_revoked" : "token_refresh_failed",
      }).catch(() => {});
      continue;
    }
    let succeeded = 0;
    let failed = 0;
    for (const operation of Array.isArray(organization.operations) ? organization.operations : []) {
      if (now() - startedAt > budgetMs) break;
      try {
        const result = await applyCalendarOperation({ fetchImpl, accessToken, operation, organizationId: organization.organizationId });
        await service("record_organization_calendar_push_result", {
          p_organization_id: organization.organizationId,
          p_event_id: operation.eventId,
          p_outcome: result.outcome,
          p_google_event_id: result.googleEventId || null,
          p_calendar_id: result.outcome === "upserted" ? operation.calendarId : null,
          p_content_hash: result.outcome === "upserted" ? operation.contentHash : null,
          p_error_code: null,
        });
        succeeded += 1;
        if (result.outcome === "deleted") summary.deleted += 1;
        else summary.upserted += 1;
      } catch (error) {
        failed += 1;
        summary.failed += 1;
        const code = /^[a-z0-9_]{1,60}$/.test(String(error?.code || "")) ? error.code : "push_failed";
        await service("record_organization_calendar_push_result", {
          p_organization_id: organization.organizationId,
          p_event_id: operation.eventId,
          p_outcome: "failed",
          p_google_event_id: null,
          p_calendar_id: null,
          p_content_hash: null,
          p_error_code: code,
        }).catch(() => {});
      }
    }
    await service("record_organization_calendar_push_run", {
      p_organization_id: organization.organizationId,
      p_status: failed > 0 && succeeded === 0 ? "error" : "ok",
      p_error_code: failed > 0 && succeeded === 0 ? "push_failed" : null,
    }).catch(() => {});
  }
  return summary;
}
