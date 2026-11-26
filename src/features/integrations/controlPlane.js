import { ACCOUNT_OWNERS, CHAPTER_OVERRIDE_STATES, INTEGRATION_PROVIDER_CATALOG } from "./catalog.js";

const ENABLED_ORG_STATUSES = new Set(["configured", "connected"]);

export function resolveEffectiveIntegration(organizationIntegration, chapterOverride) {
  const orgEnabled = ENABLED_ORG_STATUSES.has(organizationIntegration.status);
  const chapterOverridesAllowed = Boolean(organizationIntegration.allowChapterOverrides);
  const chapterStatus = chapterOverridesAllowed ? chapterOverride?.status : undefined;
  const settings = mergeAllowedChapterSettings(organizationIntegration, chapterOverride);
  const accountOwner = resolveAccountOwner(organizationIntegration, chapterOverride);

  return {
    organizationIntegrationId: organizationIntegration.id,
    chapterOverrideId: chapterOverride?.id ?? null,
    organizationId: organizationIntegration.organizationId,
    chapterId: chapterOverride?.chapterId ?? null,
    provider: organizationIntegration.provider,
    enabled: orgEnabled && chapterStatus !== "disabled",
    accountOwner,
    credentialRef: resolveCredentialRef(organizationIntegration, chapterOverride, accountOwner),
    capabilities: resolveCapabilities(organizationIntegration),
    settings,
    status: organizationIntegration.status,
  };
}

function resolveCredentialRef(organizationIntegration, chapterOverride, accountOwner) {
  if (accountOwner === "chapter") return chapterOverride?.credentialRef ?? null;
  return organizationIntegration.credentialRef ?? null;
}

function resolveCapabilities(organizationIntegration) {
  if (organizationIntegration.capabilities?.length) return [...organizationIntegration.capabilities];
  return [...(INTEGRATION_PROVIDER_CATALOG[organizationIntegration.provider]?.capabilities || [])];
}

function resolveAccountOwner(organizationIntegration, chapterOverride) {
  if (
    organizationIntegration.allowChapterOwnedAccounts
    && chapterOverride?.accountOwner === "chapter"
    && chapterOverride.status !== "disabled"
  ) {
    return "chapter";
  }
  return ACCOUNT_OWNERS.includes(organizationIntegration.accountOwner)
    ? organizationIntegration.accountOwner
    : "organization";
}

function mergeAllowedChapterSettings(organizationIntegration, chapterOverride) {
  const base = asSettingsObject(organizationIntegration.defaultSettings);
  if (!organizationIntegration.allowChapterOverrides || !chapterOverride || chapterOverride.status === "inherit") {
    return base;
  }
  const allowedKeys = organizationIntegration.allowedChapterOverrideKeys ?? [];
  if (allowedKeys.length === 0) return base;

  const overrideSettings = asSettingsObject(chapterOverride.overrideSettings);
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrideSettings)) {
    if (allowedKeys.includes(key)) merged[key] = value;
  }
  return merged;
}

function asSettingsObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...value };
}

export function isChapterOverrideStatus(status) {
  return CHAPTER_OVERRIDE_STATES.includes(status);
}
