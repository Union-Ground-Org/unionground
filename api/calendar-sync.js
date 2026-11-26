import { createHash } from "node:crypto";
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { cronAuthorization, cronRefusalBody } from "./_lib/cronAuth.js";
import {
  decryptRefreshToken,
  encryptRefreshToken,
  publicOAuthStatus,
  readProviderSecrets,
} from "./_lib/calendarOAuth.js";
import { json, methodGuard, requireEnv, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";
import {
  CALENDAR_FREEBUSY_QUERY_URLS,
  CALENDAR_IMPORT_URLS,
  CALENDAR_MICROSOFT_PROFILE_URL,
} from "../src/features/calendarFreeBusy/config.js";
import { parseFreeBusyResponse } from "../src/features/calendarFreeBusy/freebusy.js";
import { normalizeProviderEvents, providerSupportsEventImport } from "../src/features/calendarFreeBusy/imports.js";
import { tokenEndpoint } from "../src/features/calendarFreeBusy/oauth.js";

const INVOCATION_BUDGET_MS = 50_000;
const CLEANUP_RESERVE_MS = 5_000;
// Google and Microsoft answer a refresh for a grant the steward (or their
// admin) removed with one of these OAuth error codes. They are terminal: no
// later run can succeed until the steward reconnects, so retrying only spends
// provider quota and wipes the busy cache again on every cron tick.
const REVOKED_GRANT_ERRORS = new Set(["invalid_grant", "invalid_token"]);

function remainingRequestMs(deadlineAt, cap = 12_000) {
  const remaining = deadlineAt - Date.now();
  if (remaining < 500) throw new Error("invocation_budget");
  return Math.max(250, Math.min(cap, remaining));
}

function isInvocationBudgetError(error, deadlineAt) {
  return error?.message === "invocation_budget"
    || ((error?.name === "TimeoutError" || error?.name === "AbortError")
      && Date.now() >= deadlineAt - 250);
}

function isRevokedGrantError(error) {
  return REVOKED_GRANT_ERRORS.has(String(error?.providerError || ""));
}

function isoNow() {
  return new Date().toISOString();
}

function isoPlusDays(days, baseIso) {
  const baseMs = Date.parse(baseIso);
  if (!Number.isFinite(baseMs)) throw new Error("invalid_time");
  return new Date(baseMs + days * 86_400_000).toISOString();
}

function logSafe(kind, extra = {}) {
  console.error("[calendar-sync]", { kind, ...extra });
}

async function refreshAccessToken(env, surface, provider, refreshToken, deadlineAt) {
  const secrets = readProviderSecrets(env, surface, provider);
  const url = tokenEndpoint(provider, secrets.tenant);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: secrets.clientId,
      client_secret: secrets.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(remainingRequestMs(deadlineAt)),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token) {
    const failure = new Error("refresh_failed");
    // The provider's own error code is the only thing that separates a
    // permanently revoked grant from a transient refresh failure.
    failure.providerError = String(payload?.error || "").trim().toLowerCase();
    throw failure;
  }
  return {
    accessToken: String(payload.access_token),
    refreshToken: String(payload.refresh_token || "").trim(),
    scopes: String(payload.scope || "").trim(),
  };
}

function syncAttemptTime(row) {
  if (row?.lastSyncAttemptAt == null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(row.lastSyncAttemptAt);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function orderRowsForSyncFairness(rows) {
  if (!Array.isArray(rows)) return [];
  return [...rows].sort((left, right) => {
    const leftAttempt = syncAttemptTime(left);
    const rightAttempt = syncAttemptTime(right);
    if (leftAttempt !== rightAttempt) return leftAttempt < rightAttempt ? -1 : 1;
    const leftKey = `${String(left?.stewardId || "")}:${String(left?.provider || "")}`;
    const rightKey = `${String(right?.stewardId || "")}:${String(right?.provider || "")}`;
    return leftKey.localeCompare(rightKey);
  });
}

function hasPersistentFairnessCursor(rows) {
  return rows.every((row) => (
    Object.hasOwn(row || {}, "lastSyncAttemptAt")
    && (row.lastSyncAttemptAt == null || Number.isFinite(Date.parse(row.lastSyncAttemptAt)))
  ));
}

async function markSyncAttempt(backend, row, deadlineAt) {
  await supabaseRpc(
    backend.url,
    backend.serviceRoleKey,
    backend.serviceRoleKey,
    "mark_steward_calendar_sync_attempt",
    { p_steward: row.stewardId, p_provider: row.provider },
    { timeoutMs: remainingRequestMs(deadlineAt, 4_000) },
  );
}

async function markConnectionError(backend, row) {
  await supabaseRpc(
    backend.url,
    backend.serviceRoleKey,
    backend.serviceRoleKey,
    "mark_calendar_connection_error",
    { p_steward: row.stewardId, p_provider: row.provider },
  );
}

async function markConnectionRevoked(backend, row) {
  await supabaseRpc(
    backend.url,
    backend.serviceRoleKey,
    backend.serviceRoleKey,
    "mark_calendar_connection_revoked",
    { p_steward: row.stewardId, p_provider: row.provider },
  );
}

async function markEventImportError(backend, row, deadlineAt) {
  await supabaseRpc(
    backend.url,
    backend.serviceRoleKey,
    backend.serviceRoleKey,
    "mark_calendar_import_error",
    { p_steward: row.stewardId, p_provider: row.provider },
    { timeoutMs: remainingRequestMs(deadlineAt) },
  );
}

async function fetchMicrosoftMailbox(accessToken, deadlineAt) {
  const response = await fetch(CALENDAR_MICROSOFT_PROFILE_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(remainingRequestMs(deadlineAt)),
  });
  const payload = await response.json().catch(() => null);
  const mailbox = String(payload?.mail || payload?.userPrincipalName || "").trim();
  if (!response.ok || !mailbox || mailbox.length > 320) throw new Error("profile_http");
  return mailbox;
}

async function fetchFreeBusy(provider, accessToken, nowIso, deadlineAt) {
  const endIso = isoPlusDays(60, nowIso);
  if (provider === "google") {
    const response = await fetch(CALENDAR_FREEBUSY_QUERY_URLS.google, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        timeMin: nowIso,
        timeMax: endIso,
        items: [{ id: "primary" }],
      }),
      signal: AbortSignal.timeout(remainingRequestMs(deadlineAt)),
    });
    if (!response.ok) throw new Error("freebusy_http");
    return response.json();
  }
  const mailbox = await fetchMicrosoftMailbox(accessToken, deadlineAt);
  const response = await fetch(CALENDAR_FREEBUSY_QUERY_URLS.microsoft, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      schedules: [mailbox],
      startTime: { dateTime: nowIso.replace("Z", ""), timeZone: "UTC" },
      endTime: { dateTime: endIso.replace("Z", ""), timeZone: "UTC" },
      availabilityViewInterval: 30,
    }),
    signal: AbortSignal.timeout(remainingRequestMs(deadlineAt)),
  });
  if (!response.ok) throw new Error("freebusy_http");
  return response.json();
}

function opaqueEventKey(provider, rawId) {
  return createHash("sha256").update(`${provider}:${rawId}`).digest("hex");
}

async function fetchCalendarEvents(provider, accessToken, nowIso, deadlineAt) {
  const endIso = isoPlusDays(60, nowIso);
  const url = new URL(CALENDAR_IMPORT_URLS[provider]);
  if (provider === "google") {
    url.searchParams.set("timeMin", nowIso);
    url.searchParams.set("timeMax", endIso);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("showDeleted", "false");
    url.searchParams.set("maxResults", "200");
    url.searchParams.set("fields", "items(id,status,start,end,updated),nextPageToken");
  } else {
    url.searchParams.set("startDateTime", nowIso);
    url.searchParams.set("endDateTime", endIso);
    url.searchParams.set("$select", "id,start,end,isAllDay,isCancelled,lastModifiedDateTime");
    url.searchParams.set("$top", "200");
  }
  const events = [];
  const visited = new Set();
  let pageUrl = url;
  for (let page = 0; page < 4; page += 1) {
    const signature = pageUrl.toString();
    if (visited.has(signature)) throw new Error("calendar_import_pagination");
    visited.add(signature);
    const response = await fetch(pageUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(provider === "microsoft" ? { Prefer: 'outlook.timezone="UTC"' } : {}),
      },
      signal: AbortSignal.timeout(remainingRequestMs(deadlineAt)),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error("calendar_import_http");
    const pageEvents = normalizeProviderEvents(
      provider, payload, (rawId) => opaqueEventKey(provider, rawId),
    );
    if (events.length + pageEvents.length > 500) {
      return { events: [], truncated: true };
    }
    events.push(...pageEvents);

    if (provider === "google") {
      const token = String(payload?.nextPageToken || "").trim();
      if (!token) return { events, truncated: false };
      if (token.length > 2048 || events.length === 500) return { events: [], truncated: true };
      pageUrl = new URL(url);
      pageUrl.searchParams.set("pageToken", token);
      continue;
    }
    const nextLink = String(payload?.["@odata.nextLink"] || "").trim();
    if (!nextLink) return { events, truncated: false };
    if (events.length === 500) return { events: [], truncated: true };
    const nextUrl = new URL(nextLink);
    const allowed = new URL(CALENDAR_IMPORT_URLS.microsoft);
    if (nextUrl.protocol !== allowed.protocol || nextUrl.origin !== allowed.origin
       || nextUrl.pathname !== allowed.pathname) {
      throw new Error("calendar_import_pagination");
    }
    pageUrl = nextUrl;
  }
  return { events: [], truncated: true };
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  const startedAt = Date.now();
  // Keep enough of Vercel's 60-second envelope to record an honest result or
  // error. Every provider request consumes this one deadline instead of
  // receiving a fresh timeout on every page.
  const requestDeadlineAt = startedAt + INVOCATION_BUDGET_MS - CLEANUP_RESERVE_MS;
  const cleanupDeadlineAt = startedAt + INVOCATION_BUDGET_MS;
  const runNowIso = isoNow();
  if (methodGuard(request, ["GET", "POST"], () => json(response, 405, { ok: false, error: "method_not_allowed" }))) {
    return;
  }
  const backend = resolveSupabaseBackend(request);
  const cron = cronAuthorization(request);
  if (!cron.ok) {
    json(response, cron.status, cronRefusalBody(cron, { ok: false }));
    return;
  }
  if (requireEnv([backend.url, backend.serviceRoleKey], () => json(response, 503, { ok: false, error: "not_configured" }))) {
    return;
  }

  const env = process.env;
  const status = publicOAuthStatus(env, backend.surface);
  const anyConfigured = status.providers.google.configured || status.providers.microsoft.configured;
  if (!anyConfigured) {
    json(response, 200, { ok: true, synced: 0, skipped: "activation_unset" });
    return;
  }

  let tokens;
  try {
    tokens = await supabaseRpc(
      backend.url,
      backend.serviceRoleKey,
      backend.serviceRoleKey,
      "list_steward_calendar_oauth_tokens",
      {},
    );
  } catch {
    logSafe("list_failed");
    json(response, 502, { ok: false, error: "list_failed" });
    return;
  }

  const rows = Array.isArray(tokens) ? tokens : [];
  // Older deployments returned no persisted attempt cursor. One row is safe,
  // but processing a larger legacy inventory in key order could starve every
  // later connection. Fail closed until the forward migration is applied.
  if (rows.length > 1 && !hasPersistentFairnessCursor(rows)) {
    logSafe("fairness_cursor_unavailable", { rows: rows.length });
    json(response, 503, { ok: false, error: "fairness_cursor_unavailable" });
    return;
  }
  const orderedRows = orderRowsForSyncFairness(rows);
  let synced = 0;
  let failed = 0;
  let revoked = 0;
  let eventImportFailed = 0;
  let skippedUnset = 0;
  let skippedRevoked = 0;
  let skippedBudget = 0;
  for (let index = 0; index < orderedRows.length; index += 1) {
    if (Date.now() - startedAt > INVOCATION_BUDGET_MS) {
      skippedBudget = orderedRows.length - index;
      logSafe("budget_exhausted", { processed: index, remaining: skippedBudget });
      break;
    }
    const row = orderedRows[index];
    // A connection the database already recorded as revoked has no live grant
    // behind it. Only a steward reconnect can restore one, so never spend a
    // provider call on it.
    if (row.status === "revoked") {
      skippedRevoked += 1;
      continue;
    }
    if (!status.providers[row.provider]?.configured) {
      skippedUnset += 1;
      continue;
    }
    const refreshToken = decryptRefreshToken(env, backend.surface, row.refreshTokenCiphertext);
    if (!refreshToken) {
      logSafe("row_failed", { provider: row.provider, reason: "unwrap_failed" });
      try {
        await markConnectionError(backend, row);
      } catch {
        logSafe("error_state_failed", { provider: row.provider });
      }
      failed += 1;
      continue;
    }
    try {
      const refreshed = await refreshAccessToken(
        env, backend.surface, row.provider, refreshToken, requestDeadlineAt,
      );
      if (refreshed.refreshToken && refreshed.refreshToken !== refreshToken) {
        const nextCiphertext = encryptRefreshToken(env, backend.surface, refreshed.refreshToken);
        if (!nextCiphertext) throw new Error("refresh_wrap_failed");
        await supabaseRpc(
          backend.url,
          backend.serviceRoleKey,
          backend.serviceRoleKey,
          "upsert_steward_calendar_oauth_token",
          {
            p_steward: row.stewardId,
            p_provider: row.provider,
            p_refresh_token_ciphertext: nextCiphertext,
            p_scopes: refreshed.scopes || row.scopes || "",
          },
        );
      }
      const payload = await fetchFreeBusy(
        row.provider, refreshed.accessToken, runNowIso, requestDeadlineAt,
      );
      const parsed = parseFreeBusyResponse(row.provider, payload, runNowIso);
      if (!parsed.ok) throw new Error("parse_failed");
      await supabaseRpc(
        backend.url,
        backend.serviceRoleKey,
        backend.serviceRoleKey,
        "set_calendar_busy",
        { p_steward: row.stewardId, p_provider: row.provider, p_windows: parsed.windows },
      );
      // Import only when the originally consented token envelope records an
      // event-read scope. A refresh response must not silently broaden an
      // older free/busy-only connection.
      let eventImportExhaustedBudget = false;
      if (providerSupportsEventImport(row.provider, row.scopes)) {
        try {
          const imported = await fetchCalendarEvents(
            row.provider, refreshed.accessToken, runNowIso, requestDeadlineAt,
          );
          if (imported.truncated) {
            await supabaseRpc(
              backend.url,
              backend.serviceRoleKey,
              backend.serviceRoleKey,
              "clear_calendar_import_events",
              { p_steward: row.stewardId, p_provider: row.provider },
            );
            logSafe("event_import_capacity_exceeded", { provider: row.provider });
          } else {
            await supabaseRpc(
              backend.url,
              backend.serviceRoleKey,
              backend.serviceRoleKey,
              "replace_calendar_import_events",
              {
                p_steward: row.stewardId,
                p_provider: row.provider,
                p_window_start: runNowIso,
                p_window_end: isoPlusDays(60, runNowIso),
                p_events: imported.events,
              },
            );
          }
        } catch (error) {
          // Event import is a secondary view over a successfully refreshed
          // free/busy calendar. A provider page or import-RPC failure must not
          // mark the OAuth connection invalid or erase the busy windows that
          // were just committed. Keep the last opaque event rows, record the
          // separate import failure, and let the next fair rotation retry it.
          if (isInvocationBudgetError(error, requestDeadlineAt)) {
            skippedBudget = orderedRows.length - index - 1;
            eventImportExhaustedBudget = true;
            logSafe("budget_exhausted", { processed: index + 1, remaining: skippedBudget });
          } else {
            try {
              await markEventImportError(backend, row, requestDeadlineAt);
            } catch {
              logSafe("event_import_error_state_failed", { provider: row.provider });
            }
            eventImportFailed += 1;
            logSafe("event_import_failed", {
              provider: row.provider,
              reason: error?.message || "calendar_import_failed",
            });
          }
        }
      }
      synced += 1;
      if (eventImportExhaustedBudget) break;
    } catch (error) {
      if (isInvocationBudgetError(error, requestDeadlineAt)) {
        // Successful and ordinary failed rows already advance connection
        // updated_at through set_calendar_busy/mark_calendar_connection_error.
        // A provider request that consumes the budget needs this cleanup write
        // so the next run starts with the rows it did not reach.
        try {
          await markSyncAttempt(backend, row, cleanupDeadlineAt);
        } catch {
          logSafe("fairness_cursor_update_failed", { provider: row.provider });
        }
        skippedBudget = orderedRows.length - index;
        logSafe("budget_exhausted", { processed: index, remaining: skippedBudget });
        break;
      }
      // A revoked grant is terminal, not a transient sync failure: record the
      // status the schema already defines, drop the dead token, and leave the
      // steward a reconnect instead of an error that repeats forever. Anything
      // the revocation write cannot complete falls through to the retryable
      // error path below.
      if (isRevokedGrantError(error)) {
        logSafe("row_revoked", { provider: row.provider, reason: error.providerError });
        try {
          await markConnectionRevoked(backend, row);
          revoked += 1;
          continue;
        } catch {
          logSafe("revoked_state_failed", { provider: row.provider });
        }
      }
      logSafe("row_failed", { provider: row.provider, reason: error?.message || "sync_failed" });
      try {
        await markConnectionError(backend, row);
      } catch {
        logSafe("error_state_failed", { provider: row.provider });
      }
      failed += 1;
    }
  }

  json(response, (failed > 0 && synced === 0) || eventImportFailed > 0 ? 207 : 200, {
    ok: failed === 0 && eventImportFailed === 0,
    synced,
    failed,
    ...(revoked ? { revoked } : {}),
    ...(eventImportFailed ? { event_import_failed: eventImportFailed } : {}),
    skipped_unset: skippedUnset,
    ...(skippedRevoked ? { skipped_revoked: skippedRevoked } : {}),
    skipped_budget: skippedBudget,
  });
}
