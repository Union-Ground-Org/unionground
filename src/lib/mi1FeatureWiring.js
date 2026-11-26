import { useEffect, useMemo, useState } from "react";
import {
  INTEGRATION_PROVIDER_CATALOG,
  INTEGRATION_PROVIDER_IDS,
  defaultProviderRecord,
  isActivatableProvider,
  isIntegrationProvider,
} from "../features/integrations/catalog.js";
import { resolveEffectiveIntegration } from "../features/integrations/controlPlane.js";
import { SCIM_GENERIC_PROVIDER_REASON, SCIM_MAPPABLE_ROLES, buildScimTokenCustody, getScimControlSurface } from "../features/integrations/scim.js";
import { canManageIntegrations } from "../features/integrations/authorization.js";
import { summarizeJobHealth } from "../features/integrations/jobs.js";
import {
  API_KEY_PREFIX,
  WEBHOOK_SECRET_PREFIX,
  displayPrefix,
  generateSecret,
  hashSecret,
  oneTimeSecretEnvelope,
} from "../features/integrations/secrets.js";
import { classifyWebhookUrl, parseWebhookEvents } from "../features/integrations/webhooks.js";
import { ORGANIZATION_ROLES } from "../features/tenancy/organizationScope.js";

export const MI1_FEATURE_WEB_DONOR = Object.freeze({
  baseline: "donor-baseline-20260721",
  webWiring: "ad2aef01af257be3d6fbbbe985b24f984cf8f222",
  disposition: "port_adapt",
  rejected: Object.freeze([
    "Next.js app router and server actions",
    "legacy service-role browser clients",
    "fictional live tenants or seeded CBA rates",
    "in-memory writes presented as persisted success",
    "QA, pay, analytics, operations, and public-directory wiring",
  ]),
});

export function isMissingRpcError(error) {
  const code = String(error?.code || error?.status || "");
  const message = String(error?.message || error || "");
  return code === "PGRST202" || code === "42883" || /could not find the function|does not exist/i.test(message);
}

function uniqueRoles(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((role) => ORGANIZATION_ROLES.includes(role)))];
}

export function buildMi1FeatureActor(input = {}) {
  const {
  userId = null,
  organizationId = null,
  chapterId = null,
  roles = [],
  organizationRoles,
  chapterRoles = [],
  membershipStatus = organizationId ? "active" : null,
  organizationStatus = organizationId ? "active" : null,
  mfaSatisfied = false,
  selectedHat = "member",
  } = input;
  const orgRoles = uniqueRoles(Array.isArray(organizationRoles) ? organizationRoles : roles);
  const chapterGrantRoles = uniqueRoles(chapterRoles);
  return Object.freeze({
    userId: userId || null,
    organizationId: organizationId || null,
    selectedOrganizationId: organizationId || null,
    chapterId: chapterId || null,
    roles: Object.freeze(uniqueRoles(roles)),
    organizationRoles: Object.freeze(orgRoles),
    chapterRoles: Object.freeze(chapterGrantRoles),
    membershipStatus: membershipStatus || (organizationId ? "active" : "inactive"),
    organizationStatus: organizationStatus || (organizationId ? "active" : null),
    mfaSatisfied: Boolean(mfaSatisfied),
    selectedHat: selectedHat || "member",
    authenticated: Boolean(userId),
    role: selectedHat === "member" ? (orgRoles[0] || null) : selectedHat,
  });
}

// An organization-only admin or VP holds an active organization membership and
// an organization role grant but no chapter membership, so the chapter
// projection is empty for them and the integrations plane would read as
// "unauthorized". get_my_mobile_staff_scope is the server-owned resolver that
// already admits that persona (selected chapter first, otherwise exactly one
// active organization membership, multiple organizations fail closed), so it
// answers for the chapterless case only. Anything short of an authorized
// organization projection leaves the chapter answer standing.
async function loadStaffOrganizationScope(client) {
  try {
    const { data, error } = await client.rpc("get_my_mobile_staff_scope");
    if (error || !data || typeof data !== "object" || Array.isArray(data)) return null;
    if (data.staffAuthorized !== true || typeof data.organizationId !== "string" || !data.organizationId) return null;
    return {
      organizationId: data.organizationId,
      chapterId: null,
      organizationRoles: uniqueRoles(data.roles),
      chapterRoles: uniqueRoles(data.chapterRoles),
      unavailable: false,
    };
  } catch {
    return null;
  }
}

export async function loadOrganizationSessionScope(client) {
  if (!client?.rpc) {
    return { organizationId: null, chapterId: null, organizationRoles: [], chapterRoles: [], unavailable: true };
  }
  try {
    const { data, error } = await client.rpc("get_my_chapter_memberships");
    if (error) {
      return { organizationId: null, chapterId: null, organizationRoles: [], chapterRoles: [], unavailable: true };
    }
    const memberships = Array.isArray(data) ? data : [];
    const selected = memberships.find((row) => row?.selected) || null;
    if (!selected) {
      const staffScope = await loadStaffOrganizationScope(client);
      if (staffScope) return staffScope;
    }
    return {
      organizationId: selected?.organizationId || null,
      chapterId: selected?.chapterId || null,
      organizationRoles: uniqueRoles(selected?.organizationRoles),
      chapterRoles: uniqueRoles(selected?.chapterRoles),
      unavailable: false,
    };
  } catch {
    return { organizationId: null, chapterId: null, organizationRoles: [], chapterRoles: [], unavailable: true };
  }
}

export function mergeMi1SessionScope(actor, scope = {}) {
  const authoritativeScope = scope?.unavailable === false;
  const organizationId = authoritativeScope
    ? scope.organizationId
    : actor?.organizationId || actor?.selectedOrganizationId || scope.organizationId;
  const discoveredMembership = authoritativeScope && Boolean(scope.organizationId);
  return buildMi1FeatureActor({
    ...actor,
    organizationId,
    roles: uniqueRoles([...(actor?.roles || []), ...(scope.organizationRoles || []), ...(scope.chapterRoles || [])]),
    organizationRoles: authoritativeScope ? scope.organizationRoles : actor?.organizationRoles,
    chapterId: authoritativeScope ? scope.chapterId : actor?.chapterId || scope.chapterId,
    chapterRoles: authoritativeScope ? scope.chapterRoles : actor?.chapterRoles,
    membershipStatus: authoritativeScope ? (discoveredMembership ? "active" : "inactive") : actor?.membershipStatus,
    organizationStatus: authoritativeScope ? (discoveredMembership ? "active" : null) : actor?.organizationStatus,
  });
}

export function useMi1ScopedActor(client, actor) {
  const rolesKey = JSON.stringify(uniqueRoles(actor?.roles));
  const organizationRolesKey = JSON.stringify(uniqueRoles(actor?.organizationRoles));
  const chapterRolesKey = JSON.stringify(uniqueRoles(actor?.chapterRoles));
  const stableActor = useMemo(() => buildMi1FeatureActor({
    userId: actor?.userId,
    organizationId: actor?.organizationId || actor?.selectedOrganizationId,
    chapterId: actor?.chapterId,
    roles: JSON.parse(rolesKey),
    organizationRoles: JSON.parse(organizationRolesKey),
    chapterRoles: JSON.parse(chapterRolesKey),
    membershipStatus: actor?.membershipStatus,
    organizationStatus: actor?.organizationStatus,
    mfaSatisfied: actor?.mfaSatisfied,
    selectedHat: actor?.selectedHat,
  }), [actor?.chapterId, actor?.membershipStatus, actor?.mfaSatisfied, actor?.organizationId, actor?.organizationStatus, actor?.selectedHat, actor?.selectedOrganizationId, actor?.userId, chapterRolesKey, organizationRolesKey, rolesKey]);
  // Preserve the trusted bootstrap actor until the membership RPC answers.
  // An empty result is authoritative only after that request succeeds.
  const [scoped, setScoped] = useState(() => mergeMi1SessionScope(stableActor));
  useEffect(() => {
    let active = true;
    setScoped(mergeMi1SessionScope(stableActor));
    loadOrganizationSessionScope(client).then((scope) => {
      if (!active) return;
      setScoped(mergeMi1SessionScope(stableActor, scope));
    });
    return () => {
      active = false;
    };
  }, [client, stableActor]);
  return scoped;
}

export function createUnsetIntegrationStore() {
  function snapshot(organizationId) {
    const providers = INTEGRATION_PROVIDER_IDS.map((provider) => {
      const row = { id: `unset:${provider}`, organizationId, ...defaultProviderRecord(provider) };
      return {
        ...row,
        effective: resolveEffectiveIntegration(row, null),
        catalog: INTEGRATION_PROVIDER_CATALOG[provider],
      };
    });
    return {
      organizationId,
      persistence: "unset",
      providers,
      jobs: [],
      jobHealth: [],
      webhooks: [],
      deliveries: [],
      deliveryCursor: null,
      apiKeys: [],
      constantContact: {
        available: false,
        connected: false,
        status: "unset",
        syncRuns: [],
        analytics: [],
      },
      scim: getScimControlSurface(),
      audit: [],
      capabilities: {
        jobsWrite: false,
        webhookDelivery: false,
        webhookSecretRotation: false,
        apiKeyRotation: false,
      },
    };
  }

  function deny(reason = "persistence_unset") {
    return { ok: false, reason };
  }

  return {
    persistenceKind: "unset",
    getSnapshot(actor) {
      if (!canManageIntegrations(actor)) return deny("unauthorized");
      return { ok: true, data: snapshot(actor.selectedOrganizationId) };
    },
    requestActivation: () => deny(),
    configureProvider: () => deny(),
    setProviderStatus: () => deny(),
    setChapterOverride: () => deny(),
    enqueueJob: () => deny(),
    runNextJob: () => deny(),
    retryJob: () => deny(),
    createWebhook: () => deny(),
    rotateWebhookSecret: () => deny(),
    toggleWebhook: () => deny(),
    deleteWebhook: () => deny(),
    enqueueWebhookDelivery: () => deny(),
    listWebhookDeliveries: () => deny(),
    issueApiKey: () => deny(),
    rotateApiKey: () => deny(),
    revokeApiKey: () => deny(),
    beginConstantContactOAuth: () => deny("activation_unset"),
    syncConstantContact: () => deny("activation_unset"),
    disconnectConstantContact: () => deny("activation_unset"),
    getScimControl: () => deny(),
    saveScimSettings: () => deny(),
    issueScimToken: () => deny(),
    revokeScimToken: () => deny(),
    setScimGroupRole: () => deny(),
  };
}

function integrationRpcReason(error) {
  const code = String(error?.code || error?.status || "");
  const message = String(error?.message || "");
  if (/mfa required/i.test(message)) return "mfa_required";
  if (/scim provisioning is switched off/i.test(message)) return "scim_switched_off";
  if (/scim default chapter required/i.test(message)) return "scim_no_default_chapter";
  if (/too many live scim tokens/i.test(message)) return "scim_token_limit";
  if (/chapter outside organization|invalid scim token|unsupported role/i.test(message)) return "invalid_input";
  if (code === "42501" || /not authorized/i.test(message)) return "unauthorized";
  if (code === "22023" || /invalid webhook url/i.test(message)) return "invalid_url";
  if (code === "P0002" || /not found/i.test(message)) return "not_found";
  return "persistence_unavailable";
}

export function createSupabaseIntegrationStore(client, { apiRequest = null } = {}) {
  async function call(name, args = undefined) {
    if (!client?.rpc) return { ok: false, reason: "persistence_unavailable" };
    try {
      const { data, error } = await client.rpc(name, args);
      if (error) return { ok: false, reason: integrationRpcReason(error) };
      return { ok: true, data };
    } catch {
      return { ok: false, reason: "persistence_unavailable" };
    }
  }

  async function mutate(name, args) {
    const result = await call(name, args);
    return result.ok ? { ok: true, data: result.data } : result;
  }

  async function requestApi(path, body) {
    if (apiRequest) return apiRequest(path, body);
    if (!client?.auth?.getSession || typeof fetch !== "function") {
      return { ok: false, reason: "persistence_unavailable" };
    }
    try {
      const { data, error } = await client.auth.getSession();
      const token = data?.session?.access_token;
      if (error || !token) return { ok: false, reason: "unauthorized" };
      const response = await fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const publicReason = ["activation_unset", "provider_not_connected", "unauthorized", "invalid_input"]
          .includes(payload?.error) ? payload.error : null;
        return {
          ok: false,
          reason: response.status === 401 || response.status === 403
            ? "unauthorized"
            : publicReason || "persistence_unavailable",
        };
      }
      return payload?.ok ? payload : { ok: false, reason: payload?.reason || "persistence_unavailable" };
    } catch {
      return { ok: false, reason: "persistence_unavailable" };
    }
  }

  return {
    persistenceKind: "supabase",

    async getSnapshot(actor) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      const [
        providersResult,
        overridesResult,
        jobsResult,
        webhooksResult,
        deliveriesResult,
        apiKeysResult,
        constantContactResult,
        constantContactRunsResult,
        constantContactAnalyticsResult,
      ] = await Promise.all([
        call("list_organization_integrations"),
        call("list_chapter_integration_overrides"),
        call("list_integration_job_page", {
          p_limit: 100,
          p_before_created_at: null,
          p_before_id: null,
        }),
        call("list_integration_webhooks"),
        call("list_integration_webhook_delivery_page", {
          p_limit: 25,
          p_before_created_at: null,
          p_before_id: null,
        }),
        call("list_integration_api_keys"),
        call("list_constant_contact_control"),
        call("list_constant_contact_sync_runs", { p_limit: 10 }),
        call("list_constant_contact_analytics", { p_limit: 25 }),
      ]);
      const failed = [providersResult, overridesResult, jobsResult, webhooksResult, deliveriesResult, apiKeysResult].find((result) => !result.ok);
      if (failed) return failed;

      const persistedProviders = Array.isArray(providersResult.data) ? providersResult.data : [];
      const overrides = Array.isArray(overridesResult.data) ? overridesResult.data : [];
      const jobsPage = jobsResult.data || {};
      const jobs = Array.isArray(jobsPage.items) ? jobsPage.items : [];
      const providers = INTEGRATION_PROVIDER_IDS.map((provider) => {
        const persisted = persistedProviders.find((row) => row?.provider === provider) || {};
        const row = {
          id: persisted.id || `unset:${provider}`,
          organizationId: persisted.organizationId || actor.selectedOrganizationId,
          ...defaultProviderRecord(provider),
          ...persisted,
        };
        const override = actor.chapterId
          ? overrides.find((item) => item?.organizationIntegrationId === row.id && item?.chapterId === actor.chapterId) || null
          : null;
        return {
          ...row,
          chapterOverride: override,
          effective: resolveEffectiveIntegration(row, override),
          catalog: INTEGRATION_PROVIDER_CATALOG[provider],
        };
      });
      return {
        ok: true,
        data: {
          organizationId: actor.selectedOrganizationId,
          persistence: "supabase",
          providers,
          aiConnectors: Array.isArray(providersResult.data) ? persistedProviders
            .filter((row) => ["ai_connector_gemini", "ai_connector_claude", "ai_connector_gpt", "ai_connector_fireworks"].includes(row?.provider))
            .map((row) => ({ provider: row.provider, status: row.status, model: String(row.defaultSettings?.model || "").slice(0, 105) })) : null,
          jobs: jobs.map((job) => ({ ...job, kind: job.kind || job.jobKind || "unknown" })),
          jobCursor: jobsPage.nextBeforeCreatedAt && jobsPage.nextBeforeId
            ? { beforeCreatedAt: jobsPage.nextBeforeCreatedAt, beforeId: jobsPage.nextBeforeId }
            : null,
          jobHealth: summarizeJobHealth(jobs),
          webhooks: Array.isArray(webhooksResult.data) ? webhooksResult.data : [],
          deliveries: Array.isArray(deliveriesResult.data?.items) ? deliveriesResult.data.items : [],
          deliveryCursor: deliveriesResult.data?.nextBeforeCreatedAt && deliveriesResult.data?.nextBeforeId
            ? {
              beforeCreatedAt: deliveriesResult.data.nextBeforeCreatedAt,
              beforeId: deliveriesResult.data.nextBeforeId,
            }
            : null,
          apiKeys: Array.isArray(apiKeysResult.data) ? apiKeysResult.data : [],
          constantContact: constantContactResult.ok ? {
            available: true,
            ...(constantContactResult.data || {}),
            syncRuns: constantContactRunsResult.ok && Array.isArray(constantContactRunsResult.data)
              ? constantContactRunsResult.data
              : [],
            analytics: constantContactAnalyticsResult.ok && Array.isArray(constantContactAnalyticsResult.data)
              ? constantContactAnalyticsResult.data
              : [],
          } : {
            available: false,
            connected: false,
            status: "unset",
            syncRuns: [],
            analytics: [],
          },
          scim: getScimControlSurface(),
          audit: [],
          capabilities: {
            jobsWrite: true,
            webhookDelivery: true,
            webhookSecretRotation: true,
            apiKeyRotation: true,
          },
        },
      };
    },

    getCompassPlatformAi() {
      return call("get_compass_platform_ai");
    },

    async enableFireworksConnector(_actor, { model, apiKey, termsAcknowledged } = {}) {
      if (termsAcknowledged !== true || !/^accounts\/fireworks\/models\/(?![a-z0-9.-]*contributor)[a-z0-9.-]{1,80}$/.test(String(model || ""))
        || typeof apiKey !== "string" || !/^[!-~]{16,512}$/.test(apiKey)) return { ok: false, reason: "invalid_input" };
      return mutate("configure_compass_platform_fireworks", { p_model: model, p_api_key: apiKey, p_terms_acknowledged: true });
    },

    disableFireworksConnector() {
      return mutate("disable_compass_platform_fireworks", {});
    },

    adoptFireworksConnector(actor, { termsAcknowledged } = {}) {
      if (!actor?.selectedOrganizationId || termsAcknowledged !== true) return { ok: false, reason: "invalid_input" };
      return mutate("adopt_compass_platform_fireworks", { p_organization_id: actor.selectedOrganizationId, p_terms_acknowledged: true });
    },

    // Extends the platform Fireworks attestation without touching the key.
    // The server re-checks operator authority, MFA, the 1-90 day term and that
    // failover is configured, and computes the expiry on its own clock: a
    // client instant drifted past the strict bound on a fast browser clock.
    // Both provider-control confirmations are the operator's explicit
    // acknowledgement on the card, never assumed here.
    renewFireworksAttestation(_actor, { days = 90, termsAcknowledged } = {}) {
      if (termsAcknowledged !== true || !Number.isInteger(days) || days < 1 || days > 90) return { ok: false, reason: "invalid_input" };
      return mutate("renew_compass_platform_fireworks_attestation",
        { p_days: days, p_confirm_zero_data_retention: true, p_confirm_disallow_prompt_training: true });
    },

    requestActivation(actor, { provider } = {}) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      if (!isActivatableProvider(provider)) {
        return { ok: false, reason: provider === "scim" ? SCIM_GENERIC_PROVIDER_REASON : "provider_not_activatable" };
      }
      return mutate("upsert_organization_integration", {
        p_provider: provider,
        p_status: "requested",
        p_account_owner: "organization",
        p_allow_chapter_overrides: false,
        p_allow_chapter_owned_accounts: false,
        p_allowed_chapter_override_keys: [],
        p_default_settings: {},
        p_credential_ref: null,
      });
    },

    configureProvider(actor, {
      provider,
      allowChapterOverrides = false,
      allowedChapterOverrideKeys = [],
    } = {}) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      if (!isIntegrationProvider(provider) || provider === "scim") {
        return { ok: false, reason: provider === "scim" ? SCIM_GENERIC_PROVIDER_REASON : "unknown_provider" };
      }
      return mutate("set_integration_chapter_controls", {
        p_provider: provider,
        p_enabled: Boolean(allowChapterOverrides),
        p_allowed_chapter_override_keys: allowedChapterOverrideKeys,
      });
    },

    // Inventory A1 (REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001): turn
    // a provider off or request it again without resending its credential
    // reference, chapter controls or settings. Activation stays operator-verified.
    setProviderStatus(actor, { provider, status } = {}) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      if (!isIntegrationProvider(provider) || !["disabled", "requested"].includes(status)) return { ok: false, reason: "invalid_input" };
      return mutate("set_organization_integration_status", { p_provider: provider, p_status: status });
    },

    setChapterOverride(actor, { provider, chapterId, status = "inherit", overrideSettings = {} } = {}) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      return mutate("upsert_chapter_integration_override", {
        p_provider: provider,
        p_chapter_id: chapterId,
        p_status: status,
        p_override_settings: overrideSettings,
        p_credential_ref: null,
      });
    },

    async createWebhook(actor, { url, events } = {}) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      const classified = classifyWebhookUrl(url);
      if (!classified.ok) return classified;
      const parsed = parseWebhookEvents(events);
      if (!parsed.ok) return parsed;
      const result = await mutate("create_integration_webhook", {
        p_url: classified.href,
        p_events: parsed.events,
      });
      const plaintext = result.data?.signingSecret;
      return result.ok && typeof plaintext === "string"
        ? { ok: true, signingSecret: oneTimeSecretEnvelope(plaintext, WEBHOOK_SECRET_PREFIX) }
        : result.ok ? { ok: false, reason: "persistence_unavailable" } : result;
    },

    async rotateWebhookSecret(actor, { webhookId } = {}) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      const result = await mutate("rotate_integration_webhook_secret", { p_webhook_id: webhookId });
      const plaintext = result.data?.signingSecret;
      return result.ok && typeof plaintext === "string"
        ? { ok: true, signingSecret: oneTimeSecretEnvelope(plaintext, WEBHOOK_SECRET_PREFIX) }
        : result.ok ? { ok: false, reason: "persistence_unavailable" } : result;
    },

    toggleWebhook(actor, { webhookId, active } = {}) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      return mutate("set_integration_webhook_active", { p_webhook_id: webhookId, p_active: Boolean(active) });
    },

    deleteWebhook(actor, { webhookId } = {}) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      return mutate("delete_integration_webhook", { p_webhook_id: webhookId });
    },

    async issueApiKey(actor, { name } = {}) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      const trimmed = String(name || "").trim();
      if (!trimmed || trimmed.length > 80) return { ok: false, reason: "name_required" };
      const plaintext = generateSecret(API_KEY_PREFIX);
      const result = await mutate("create_integration_api_key", {
        p_name: trimmed,
        p_key_hash: await hashSecret(plaintext),
        p_key_prefix: displayPrefix(plaintext, API_KEY_PREFIX),
      });
      return result.ok
        ? { ok: true, secret: oneTimeSecretEnvelope(plaintext, API_KEY_PREFIX) }
        : result;
    },

    revokeApiKey(actor, { keyId } = {}) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      return mutate("revoke_integration_api_key", { p_key_id: keyId });
    },

    async rotateApiKey(actor, { keyId } = {}) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      const plaintext = generateSecret(API_KEY_PREFIX);
      const result = await mutate("rotate_integration_api_key", {
        p_key_id: keyId,
        p_key_hash: await hashSecret(plaintext),
        p_key_prefix: displayPrefix(plaintext, API_KEY_PREFIX),
      });
      return result.ok ? { ok: true, secret: oneTimeSecretEnvelope(plaintext, API_KEY_PREFIX) } : result;
    },

    enqueueWebhookDelivery(actor, { webhookId, eventName } = {}) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      return requestApi("/api/integration-webhooks", { webhookId, eventName });
    },

    listWebhookDeliveries(actor, { beforeCreatedAt, beforeId, limit = 25 } = {}) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      return call("list_integration_webhook_delivery_page", {
        p_limit: limit,
        p_before_created_at: beforeCreatedAt || null,
        p_before_id: beforeId || null,
      });
    },

    listIntegrationJobs(actor, { beforeCreatedAt, beforeId, limit = 100 } = {}) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      return call("list_integration_job_page", {
        p_limit: limit,
        p_before_created_at: beforeCreatedAt || null,
        p_before_id: beforeId || null,
      });
    },

    searchSmsRecipients(actor, query) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      return call("search_twilio_sms_recipients", { p_query: String(query || "").trim() });
    },

    async enqueueJob(actor, { provider, kind, idempotencyKey = null } = {}) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      const result = await mutate("enqueue_integration_job", {
        p_provider: provider,
        p_job_kind: kind,
        p_idempotency_key: idempotencyKey,
      });
      // The catalog shows unset SMS before an organization integration exists.
      // The RPC requires that setup row; a missing row is not a hat refusal.
      return !result.ok && result.reason === "not_found" && provider === "twilio" && kind === "provider_health"
        ? { ok: false, reason: "readiness_setup_required" }
        : result;
    },

    sendSms(actor, { memberId, purpose, body, idempotencyKey } = {}) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      return requestApi("/api/twilio-send", { memberId, purpose, body, idempotencyKey });
    },

    runNextJob(actor) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      return mutate("run_next_integration_job");
    },

    retryJob(actor, { jobId } = {}) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      return mutate("retry_integration_job", { p_job_id: jobId });
    },
    async beginConstantContactOAuth(actor) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      const result = await requestApi("/api/constant-contact-oauth", { action: "start" });
      if (!result.ok) return result;
      return typeof result.authorizationUrl === "string" && result.authorizationUrl.startsWith("https://authz.constantcontact.com/")
        ? result
        : { ok: false, reason: "persistence_unavailable" };
    },
    syncConstantContact(actor, { limit = 25 } = {}) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      return requestApi("/api/constant-contact-sync", { action: "sync", limit });
    },
    disconnectConstantContact(actor) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      return mutate("disconnect_constant_contact");
    },
    // SCIM directory provisioning (REQ-UG-SCIM-PROVISIONING-20261001).
    // The database enforces the switch, the organization admin role and MFA;
    // the token is generated here and only its digest is sent.
    getScimControl(actor) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      return call("get_scim_control");
    },
    saveScimSettings(actor, { defaultChapterId } = {}) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      if (typeof defaultChapterId !== "string" || !defaultChapterId) return { ok: false, reason: "invalid_input" };
      return mutate("save_scim_settings", { p_default_chapter_id: defaultChapterId });
    },
    async issueScimToken(actor, { label } = {}) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      const trimmed = String(label || "").trim();
      if (!trimmed || trimmed.length > 80) return { ok: false, reason: "name_required" };
      const custody = await buildScimTokenCustody();
      const result = await mutate("issue_scim_token", {
        p_label: trimmed,
        p_token_hash: custody.storage.tokenHash,
        p_token_prefix: custody.storage.tokenPrefix,
        p_expires_in_days: custody.storage.expiresInDays,
      });
      return result.ok ? { ok: true, data: result.data, secret: custody.oneTime } : result;
    },
    revokeScimToken(actor, { tokenId } = {}) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      return mutate("revoke_scim_token", { p_token_id: tokenId });
    },
    setScimGroupRole(actor, { groupId, role = null } = {}) {
      if (!canManageIntegrations(actor)) return { ok: false, reason: "unauthorized" };
      if (role !== null && !SCIM_MAPPABLE_ROLES.includes(role)) return { ok: false, reason: "invalid_input" };
      return mutate("set_scim_group_role", { p_group_id: groupId, p_role: role });
    },
  };
}

export const MI1_DATABASE_DEPENDENCIES = Object.freeze({
  integrations: Object.freeze({
    owner: "X-DB",
    rpcs: Object.freeze([
      "list_organization_integrations",
      "upsert_organization_integration",
      "set_integration_chapter_controls",
      "list_chapter_integration_overrides",
      "upsert_chapter_integration_override",
      "list_integration_jobs",
      "list_integration_job_page",
      "search_twilio_sms_recipients",
      "enqueue_integration_job",
      "run_next_integration_job",
      "retry_integration_job",
      "list_integration_webhooks",
      "list_integration_webhook_deliveries",
      "list_integration_webhook_delivery_page",
      "enqueue_integration_webhook_test",
      "claim_integration_webhook_deliveries",
      "claim_integration_webhook_delivery",
      "record_integration_webhook_delivery",
      "create_integration_webhook",
      "rotate_integration_webhook_secret",
      "set_integration_webhook_active",
      "delete_integration_webhook",
      "list_integration_api_keys",
      "create_integration_api_key",
      "rotate_integration_api_key",
      "revoke_integration_api_key",
      "authenticate_integration_api_key",
      "get_scim_control",
      "save_scim_settings",
      "issue_scim_token",
      "revoke_scim_token",
      "set_scim_group_role",
      "list_constant_contact_control",
      "list_constant_contact_sync_runs",
      "list_constant_contact_analytics",
      "disconnect_constant_contact",
      "enqueue_constant_contact_sync",
    ]),
    tables: Object.freeze([
      "organization_integrations",
      "chapter_integration_overrides",
      "integration_jobs",
      "integration_webhooks",
      "integration_webhook_deliveries",
      "integration_api_keys",
      "scim_tokens",
      "scim_users",
      "scim_groups",
      "scim_group_members",
      "constant_contact_sync_requests",
      "constant_contact_member_analytics",
      "constant_contact_sync_runs",
    ]),
  }),
  sessionScope: Object.freeze({
    owner: "X-DB",
    rpcs: Object.freeze(["get_my_chapter_memberships", "get_my_mobile_staff_scope"]),
    tables: Object.freeze(["organization_memberships", "organization_role_grants"]),
  }),
});
