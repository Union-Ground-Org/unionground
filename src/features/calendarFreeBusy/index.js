import { createMemoryCalendarFreeBusy } from "./adapter.js";
import { authorizeCalendarFreeBusy } from "./authorization.js";
import { presentCalendarFreeBusy, presentLoading, presentRetry } from "./presenters.js";

export {
  CALENDAR_FREEBUSY_AUDIT_METADATA_KEYS,
  CALENDAR_FREEBUSY_CAPABILITIES,
  CALENDAR_FREEBUSY_MANAGE_ROLES,
  CALENDAR_FREEBUSY_REQUEST_ROLES,
  authorizeCalendarFreeBusy,
} from "./authorization.js";
export {
  CALENDAR_FREEBUSY_PERSISTENCE_CONTRACT,
  createMemoryCalendarFreeBusy,
} from "./adapter.js";
export {
  CALENDAR_FREEBUSY_PROVIDERS,
  CALENDAR_OAUTH_SCOPES,
  calendarOAuthRedirectUri,
  isAllowedCalendarOAuthHost,
  isCalendarProvider,
  providerEnvKeys,
  resolveCalendarOAuthStatus,
  wrapKeyName,
} from "./config.js";
export {
  CALENDAR_FREEBUSY_FAILURE_REASONS,
  calendarFreeBusyFailure,
  isCalendarFreeBusyFailureReason,
} from "./errors.js";
export {
  parseFreeBusyResponse,
  parseGoogleFreeBusy,
  parseMicrosoftSchedule,
  presentBusyConflicts,
  slotConflictsWithBusy,
} from "./freebusy.js";
export { buildAuthorizationUrl, microsoftTenant, parseTokenResponse, tokenEndpoint } from "./oauth.js";
export { normalizeProviderEvents, providerSupportsEventImport } from "./imports.js";
export {
  CALENDAR_FREEBUSY_VIEW_STATES,
  presentCalendarFreeBusy,
  presentLoading,
  presentRetry,
} from "./presenters.js";
export { CALENDAR_FREEBUSY_DONOR_BASELINE, CALENDAR_FREEBUSY_DONOR_UNITS } from "./provenance.js";

export function createCalendarFreeBusy({
  actor,
  store = createMemoryCalendarFreeBusy(),
} = {}) {
  const organizationId = actor?.selectedOrganizationId ?? null;

  return {
    store,
    snapshot() {
      return store.snapshot(actor, organizationId);
    },
    present() {
      return presentCalendarFreeBusy(store.snapshot(actor, organizationId));
    },
    presentLoading,
    presentRetry,
    request(provider) {
      return store.request(actor, organizationId, provider);
    },
    canRequest() {
      return authorizeCalendarFreeBusy({ actor, organizationId, capability: "request" }).ok;
    },
  };
}
