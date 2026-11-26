import { authorizeCalendarFreeBusy } from "./authorization.js";
import { CALENDAR_FREEBUSY_PROVIDERS, resolveCalendarOAuthStatus } from "./config.js";
import { calendarFreeBusyFailure } from "./errors.js";

export const CALENDAR_FREEBUSY_PERSISTENCE_CONTRACT = Object.freeze({
  sessionOrganizationOnly: true,
  expectedOrganizationRequiredForWrites: true,
  migration: "20260828073000_mi1_calendar_freebusy_oauth.sql",
  rpcs: Object.freeze([
    "authorize_calendar_oauth_start",
    "save_calendar_oauth_state",
    "consume_calendar_oauth_state",
    "upsert_steward_calendar_oauth_token",
    "list_steward_calendar_oauth_tokens",
    "mark_steward_calendar_sync_attempt",
    "delete_steward_calendar_oauth_token",
    "mark_calendar_connection_error",
    "mark_calendar_connection_revoked",
    "replace_calendar_import_events",
    "mark_calendar_import_error",
    "get_my_calendar_import_status",
  ]),
  publicTablesRemainTokenFree: true,
});

export function createMemoryCalendarFreeBusy({
  env = {},
  surface = "saas",
  connections = [],
} = {}) {
  const status = resolveCalendarOAuthStatus(env, { surface });
  const rows = [...connections];

  return {
    persistenceKind: "memory",
    status,
    listConnections() {
      return rows.map((row) => ({ ...row }));
    },
    snapshot(actor, organizationId) {
      const auth = authorizeCalendarFreeBusy({ actor, organizationId, capability: "read" });
      if (!auth.ok) return auth;
      return {
        ok: true,
        organizationId,
        providers: CALENDAR_FREEBUSY_PROVIDERS.map((provider) => ({
          provider,
          configured: Boolean(status.providers[provider]?.configured),
          connection: rows.find((row) => row.provider === provider)?.status || "none",
        })),
      };
    },
    request(actor, organizationId, provider) {
      const auth = authorizeCalendarFreeBusy({ actor, organizationId, capability: "request" });
      if (!auth.ok) return auth;
      if (!CALENDAR_FREEBUSY_PROVIDERS.includes(provider)) {
        return calendarFreeBusyFailure("unknown_provider");
      }
      const existing = rows.find((row) => row.provider === provider);
      if (!existing) rows.push({ provider, status: "pending" });
      else if (existing.status === "revoked") existing.status = "pending";
      return {
        ok: true,
        provider,
        status: existing?.status || "pending",
        configured: Boolean(status.providers[provider]?.configured),
        reason: status.providers[provider]?.configured ? null : "activation_unset",
      };
    },
  };
}
