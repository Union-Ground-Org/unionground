export const PROVIDER_ACTIVATION_STATES = Object.freeze([
  "unset",
  "requested",
  "configured",
  "connected",
  "degraded",
  "revoked",
  "disabled",
]);

export const CHAPTER_OVERRIDE_STATES = Object.freeze(["inherit", "enabled", "disabled"]);
export const ACCOUNT_OWNERS = Object.freeze(["organization", "chapter"]);

// CBA ingest and Stripe dues entries are not offered: there is
// no collective bargaining agreement before a first contract (owner decision
// D5), and Union Ground leaves dues out. An inert database row for either,
// if any, is ignored because every surface lists only these ids.
export const INTEGRATION_PROVIDER_CATALOG = Object.freeze({
  twilio: {
    id: "twilio",
    label: "SMS (Twilio)",
    category: "communications",
    activation: "optional_unset",
    capabilities: Object.freeze(["sms:send", "sms:status", "sms:consent"]),
    chapterOverrideKeys: Object.freeze(["fromNumber"]),
    setupSummary: "Campaign SMS stays unset until a customer completes Twilio setup. Consent is unavailable while unset.",
  },
  google_calendar: {
    id: "google_calendar",
    label: "Google Calendar",
    category: "calendar",
    activation: "optional_unset",
    capabilities: Object.freeze(["calendar:oauth", "calendar:freebusy", "calendar:import"]),
    chapterOverrideKeys: Object.freeze(["calendarId"]),
    setupSummary: "Google OAuth is a customer activation. Free/busy and opaque event import stay unavailable until that organization connects its own provider.",
  },
  microsoft_calendar: {
    id: "microsoft_calendar",
    label: "Microsoft Calendar",
    category: "calendar",
    activation: "optional_unset",
    capabilities: Object.freeze(["calendar:oauth", "calendar:freebusy", "calendar:import"]),
    chapterOverrideKeys: Object.freeze(["calendarId"]),
    setupSummary: "Microsoft OAuth is a customer activation. Free/busy and opaque event import stay unavailable until that organization connects its own provider.",
  },
  constant_contact: {
    id: "constant_contact",
    label: "Constant Contact",
    category: "communications",
    activation: "optional_unset",
    capabilities: Object.freeze(["contacts:sync", "campaigns:analytics"]),
    chapterOverrideKeys: Object.freeze(["listId"]),
    setupSummary: "Connect the organization's own account to sync contacts and engagement analytics. No shared Union Ground account is implied.",
  },
  google_drive: {
    id: "google_drive",
    label: "Google Drive",
    category: "knowledge",
    activation: "optional_unset",
    capabilities: Object.freeze(["drive:oauth", "drive:list", "drive:upload", "drive:download"]),
    chapterOverrideKeys: Object.freeze([]),
    setupSummary: "Google Drive stays unset until an organization administrator connects that organization's own account from the Knowledge library.",
  },
  customer_webhooks: {
    id: "customer_webhooks",
    label: "Webhooks",
    category: "platform",
    activation: "optional_unset",
    capabilities: Object.freeze(["webhooks:outbound", "webhooks:history"]),
    chapterOverrideKeys: Object.freeze([]),
    setupSummary: "Webhooks send test events to HTTPS addresses this organization chooses. A signing secret is shown once, and a failed test delivery is tried again automatically.",
  },
  customer_api: {
    id: "customer_api",
    label: "API keys",
    category: "platform",
    activation: "optional_unset",
    capabilities: Object.freeze(["api:keys"]),
    chapterOverrideKeys: Object.freeze([]),
    setupSummary: "Organization API keys are hashed at rest and shown once. They never leave the issuing organization.",
  },
  scim: {
    id: "scim",
    label: "SCIM provisioning",
    category: "identity",
    activation: "scim_tab",
    capabilities: Object.freeze(["directory:users", "directory:groups", "directory:deactivate"]),
    chapterOverrideKeys: Object.freeze([]),
    setupSurface: "scim",
    setupSummary: "Your identity provider invites, updates and deprovisions workers over SCIM 2.0. An organization admin turns it on, picks a default campaign and issues a token on the SCIM tab.",
  },
});

export const INTEGRATION_PROVIDER_IDS = Object.freeze(Object.keys(INTEGRATION_PROVIDER_CATALOG));

export function isIntegrationProvider(provider) {
  return Boolean(INTEGRATION_PROVIDER_CATALOG[provider]);
}

export function isActivatableProvider(provider) {
  return INTEGRATION_PROVIDER_CATALOG[provider]?.activation === "optional_unset";
}

export function defaultProviderRecord(provider) {
  const entry = INTEGRATION_PROVIDER_CATALOG[provider];
  if (!entry) return null;
  return {
    provider,
    status: "unset",
    accountOwner: "organization",
    capabilities: [...entry.capabilities],
    allowChapterOverrides: false,
    allowChapterOwnedAccounts: false,
    allowedChapterOverrideKeys: [...entry.chapterOverrideKeys],
    defaultSettings: {},
    credentialRef: null,
    lastJobStatus: null,
    lastErrorCode: null,
  };
}
