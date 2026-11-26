import { authorizeOrganizationWrite, boundedAuditEvent, canManageIntegrations } from "./authorization.js";
import {
  CHAPTER_OVERRIDE_STATES,
  INTEGRATION_PROVIDER_CATALOG,
  INTEGRATION_PROVIDER_IDS,
  defaultProviderRecord,
  isActivatableProvider,
  isIntegrationProvider,
} from "./catalog.js";
import { isChapterOverrideStatus, resolveEffectiveIntegration } from "./controlPlane.js";
import { JOB_KINDS, planProviderJob, summarizeJobHealth, transitionJob } from "./jobs.js";
import { evaluateScimMutation, getScimControlSurface } from "./scim.js";
import {
  API_KEY_PREFIX,
  WEBHOOK_SECRET_PREFIX,
  displayPrefix,
  generateSecret,
  hashSecret,
  hmacSha256Hex,
  oneTimeSecretEnvelope,
  sanitizeApiKeyRow,
  sanitizeWebhookRow,
} from "./secrets.js";
import {
  WEBHOOK_EVENTS,
  buildWebhookDeliveryPlan,
  classifyWebhookUrl,
  nextWebhookBackoffMs,
  parseWebhookEvents,
  pinWebhookDestination,
} from "./webhooks.js";

function randomId() {
  return crypto.randomUUID();
}

function clone(value) {
  return structuredClone(value);
}

export function createIntegrationControlStore({
  now = () => new Date().toISOString(),
  idFactory = randomId,
  deliveryTransport = null,
  resolveWebhookHost = null,
  chapterBelongsToOrganization = null,
} = {}) {
  const organizations = new Map();
  const vault = new Map();

  function bucket(organizationId) {
    if (!organizations.has(organizationId)) {
      organizations.set(organizationId, {
        providers: new Map(INTEGRATION_PROVIDER_IDS.map((provider) => [provider, {
          id: idFactory(),
          organizationId,
          ...defaultProviderRecord(provider),
        }])),
        chapterOverrides: [],
        jobs: [],
        webhooks: [],
        deliveries: [],
        apiKeys: [],
        constantContact: {
          available: true,
          connected: false,
          status: "unset",
          accountLabel: null,
          lastSyncAt: null,
          lastErrorCode: null,
          memberCount: 0,
          activeContactCount: 0,
          sendCount: 0,
          openCount: 0,
          clickCount: 0,
          syncRuns: [],
          analytics: [],
        },
        audit: [],
      });
    }
    return organizations.get(organizationId);
  }

  function fail(reason) {
    return { ok: false, reason };
  }

  function scoped(actor, requestedOrganizationId) {
    return authorizeOrganizationWrite(actor, requestedOrganizationId);
  }

  function audit(organizationId, actor, action, entityType, entityId, metadata) {
    const event = boundedAuditEvent({
      organizationId,
      actorId: actor.userId,
      action,
      entityType,
      entityId,
      metadata,
      occurredAt: now(),
    });
    bucket(organizationId).audit.push(event);
    return event;
  }

  function snapshot(organizationId, chapterId = null) {
    const data = bucket(organizationId);
    const providers = [...data.providers.values()].map((row) => {
      const override = chapterId
        ? data.chapterOverrides.find((item) => item.organizationIntegrationId === row.id && item.chapterId === chapterId) || null
        : null;
      return {
        ...row,
        chapterOverride: override ? clone(override) : null,
        effective: resolveEffectiveIntegration(row, override),
        catalog: INTEGRATION_PROVIDER_CATALOG[row.provider],
      };
    });
    return {
      organizationId,
      providers,
      jobs: data.jobs.map((job) => clone(job)),
      jobCursor: null,
      jobHealth: summarizeJobHealth(data.jobs),
      webhooks: data.webhooks.map(sanitizeWebhookRow),
      deliveries: data.deliveries.map((row) => clone(row)),
      apiKeys: data.apiKeys.map(sanitizeApiKeyRow),
      constantContact: clone(data.constantContact),
      scim: getScimControlSurface(),
      audit: data.audit.map((row) => clone(row)),
      capabilities: {
        jobsWrite: true,
        webhookDelivery: true,
        webhookSecretRotation: true,
        apiKeyRotation: true,
      },
    };
  }

  return {
    getSnapshot(actor) {
      if (!canManageIntegrations(actor)) return fail("unauthorized");
      return { ok: true, data: snapshot(actor.selectedOrganizationId, actor.chapterId) };
    },

    listIntegrationJobs(actor) {
      if (!canManageIntegrations(actor)) return fail("unauthorized");
      return { ok: true, data: { items: [], nextBeforeCreatedAt: null, nextBeforeId: null } };
    },

    searchSmsRecipients(actor) {
      if (!canManageIntegrations(actor)) return fail("unauthorized");
      return { ok: true, data: [] };
    },

    configureProvider(actor, { provider, allowChapterOverrides = false, allowedChapterOverrideKeys = [], defaultSettings = {} } = {}) {
      const gate = scoped(actor);
      if (!gate.ok) return gate;
      if (!isIntegrationProvider(provider)) return fail("unknown_provider");
      if (provider === "scim") return evaluateScimMutation(actor);
      const data = bucket(gate.organizationId);
      const current = data.providers.get(provider);
      if (current.status === "connected") return fail("already_connected");
      const next = {
        ...current,
        allowChapterOverrides: Boolean(allowChapterOverrides),
        allowedChapterOverrideKeys: [...allowedChapterOverrideKeys],
        defaultSettings: { ...defaultSettings },
        status: current.status === "unset" ? "requested" : current.status,
      };
      data.providers.set(provider, next);
      audit(gate.organizationId, actor, "integration.provider_configure", "organization_integration", next.id, { provider });
      return { ok: true, provider: next };
    },

    // Mirrors public.set_organization_integration_status: off or request again,
    // never an activation, and nothing else on the provider row changes.
    setProviderStatus(actor, { provider, status } = {}) {
      const gate = scoped(actor);
      if (!gate.ok) return gate;
      if (!isIntegrationProvider(provider)) return fail("unknown_provider");
      if (!["disabled", "requested"].includes(status)) return fail("invalid_input");
      if (provider === "scim" && status !== "disabled") return evaluateScimMutation(actor);
      const data = bucket(gate.organizationId);
      const current = data.providers.get(provider);
      if (!current || current.status === "unset") return fail("provider_not_set_up");
      const next = { ...current, status };
      data.providers.set(provider, next);
      audit(gate.organizationId, actor, "integration.provider_status", "organization_integration", next.id, { provider, status });
      return { ok: true, provider: next };
    },

    requestActivation(actor, { provider } = {}) {
      const gate = scoped(actor);
      if (!gate.ok) return gate;
      if (!isActivatableProvider(provider)) {
        return provider === "scim" ? evaluateScimMutation(actor) : fail("provider_not_activatable");
      }
      const data = bucket(gate.organizationId);
      const current = data.providers.get(provider);
      const next = { ...current, status: current.status === "unset" ? "requested" : current.status };
      data.providers.set(provider, next);
      audit(gate.organizationId, actor, "integration.provider_request", "organization_integration", next.id, { provider });
      return { ok: true, provider: next };
    },

    setChapterOverride(actor, { provider, chapterId, status = "inherit", overrideSettings = {} } = {}) {
      const gate = scoped(actor);
      if (!gate.ok) return gate;
      if (!isIntegrationProvider(provider) || provider === "scim") {
        return provider === "scim" ? evaluateScimMutation(actor) : fail("unknown_provider");
      }
      if (!chapterId) return fail("chapter_required");
      if (!isChapterOverrideStatus(status) || !CHAPTER_OVERRIDE_STATES.includes(status)) return fail("invalid_override");
      const data = bucket(gate.organizationId);
      const organizationIntegration = data.providers.get(provider);
      if (!organizationIntegration.allowChapterOverrides) return fail("chapter_overrides_disabled");
      if (!chapterBelongsToOrganization
        || chapterBelongsToOrganization(chapterId, gate.organizationId) !== true) {
        return fail("chapter_scope_denied");
      }
      let override = data.chapterOverrides.find((row) => row.organizationIntegrationId === organizationIntegration.id && row.chapterId === chapterId);
      if (!override) {
        override = {
          id: idFactory(),
          organizationIntegrationId: organizationIntegration.id,
          chapterId,
          status,
          accountOwner: "organization",
          overrideSettings: { ...overrideSettings },
          credentialRef: null,
        };
        data.chapterOverrides.push(override);
      } else {
        override.status = status;
        override.overrideSettings = { ...overrideSettings };
      }
      audit(gate.organizationId, actor, "integration.chapter_override", "chapter_integration_override", override.id, { provider, chapterId, status });
      return { ok: true, override, effective: resolveEffectiveIntegration(organizationIntegration, override) };
    },

    enqueueJob(actor, { provider, kind, idempotencyKey, chapterId = null } = {}) {
      const gate = scoped(actor);
      if (!gate.ok) return gate;
      const planned = planProviderJob({ provider, kind });
      if (!planned.ok) return planned;
      const data = bucket(gate.organizationId);
      if (idempotencyKey) {
        const existing = data.jobs.find((job) => job.idempotencyKey === idempotencyKey);
        if (existing) return { ok: true, job: existing, replayed: true };
      }
      const job = {
        id: idFactory(),
        organizationId: gate.organizationId,
        provider,
        kind,
        chapterId,
        status: "queued",
        source: "manual",
        idempotencyKey: idempotencyKey || null,
        attemptCount: 1,
        processedCount: 0,
        errorCode: null,
        createdAt: now(),
        startedAt: null,
        finishedAt: null,
        notBefore: null,
      };
      data.jobs.push(job);
      audit(gate.organizationId, actor, "integration.job_enqueue", "integration_job", job.id, { provider, kind });
      return { ok: true, job, plan: planned.plan };
    },

    async runNextJob(actor) {
      const gate = scoped(actor);
      if (!gate.ok) return gate;
      const data = bucket(gate.organizationId);
      const currentMs = Date.parse(now());
      const job = data.jobs.find((row) => row.status === "queued"
        && (!row.notBefore || Date.parse(row.notBefore) <= currentMs));
      if (!job) return fail("no_queued_job");
      const started = transitionJob(job, "running", { now: now() });
      Object.assign(job, started.job);
      if (job.kind.startsWith("webhook")) {
        return this.deliverDueWebhooks(actor, { jobId: job.id });
      }
      if (data.providers.get(job.provider).status === "unset") {
        Object.assign(job, transitionJob(job, "skipped", { now: now(), errorCode: "activation_unset" }).job);
        return { ok: true, job, skipped: true };
      }
      Object.assign(job, transitionJob(job, "success", { now: now(), processedCount: 1 }).job);
      data.providers.get(job.provider).lastJobStatus = job.status;
      return { ok: true, job };
    },

    retryJob(actor, { jobId } = {}) {
      const gate = scoped(actor);
      if (!gate.ok) return gate;
      const data = bucket(gate.organizationId);
      const job = data.jobs.find((row) => row.id === jobId);
      if (!job) return fail("job_not_found");
      if (job.attemptCount >= 5) {
        const exhausted = transitionJob(job, "dead", { now: now(), errorCode: "retry_exhausted" });
        if (!exhausted.ok) return exhausted;
        Object.assign(job, exhausted.job);
        audit(gate.organizationId, actor, "integration.job_dead", "integration_job", job.id, { provider: job.provider, kind: job.kind });
        return { ok: true, job };
      }
      const retried = transitionJob(job, "queued", { now: now() });
      if (!retried.ok) return retried;
      Object.assign(job, retried.job);
      job.notBefore = null;
      audit(gate.organizationId, actor, "integration.job_retry", "integration_job", job.id, { provider: job.provider, kind: job.kind });
      return { ok: true, job };
    },

    beginConstantContactOAuth(actor) {
      const gate = scoped(actor);
      if (!gate.ok) return gate;
      return fail("activation_unset");
    },

    syncConstantContact(actor) {
      const gate = scoped(actor);
      if (!gate.ok) return gate;
      return dataForConstantContact(gate.organizationId).connected
        ? { ok: true, processed: 0, matched: 0, notFound: 0, failed: 0 }
        : fail("provider_not_connected");
    },

    disconnectConstantContact(actor) {
      const gate = scoped(actor);
      if (!gate.ok) return gate;
      const control = dataForConstantContact(gate.organizationId);
      control.connected = false;
      control.status = "revoked";
      bucket(gate.organizationId).providers.get("constant_contact").status = "revoked";
      return { ok: true };
    },

    async createWebhook(actor, { url, events, description = "" } = {}) {
      const gate = scoped(actor);
      if (!gate.ok) return gate;
      const classified = classifyWebhookUrl(url);
      if (!classified.ok) return fail(classified.reason);
      const parsedEvents = parseWebhookEvents(events);
      if (!parsedEvents.ok) return fail(parsedEvents.reason);
      const plaintext = generateSecret(WEBHOOK_SECRET_PREFIX);
      const secretHash = await hashSecret(plaintext);
      const data = bucket(gate.organizationId);
      const webhook = {
        id: idFactory(),
        organizationId: gate.organizationId,
        url: classified.href,
        description: String(description || "").slice(0, 120),
        events: parsedEvents.events,
        secretHash,
        active: true,
        lastDeliveryAt: null,
        lastDeliveryStatus: null,
        createdAt: now(),
      };
      data.webhooks.push(webhook);
      vault.set(webhook.id, plaintext);
      data.providers.get("customer_webhooks").status = "configured";
      audit(gate.organizationId, actor, "integration.webhook_create", "integration_webhook", webhook.id, {
        host: classified.hostname,
        events: parsedEvents.events,
      });
      return {
        ok: true,
        webhook: sanitizeWebhookRow(webhook),
        signingSecret: oneTimeSecretEnvelope(plaintext, WEBHOOK_SECRET_PREFIX),
      };
    },

    async rotateWebhookSecret(actor, { webhookId } = {}) {
      const gate = scoped(actor);
      if (!gate.ok) return gate;
      const webhook = bucket(gate.organizationId).webhooks.find((row) => row.id === webhookId);
      if (!webhook) return fail("webhook_not_found");
      const plaintext = generateSecret(WEBHOOK_SECRET_PREFIX);
      webhook.secretHash = await hashSecret(plaintext);
      vault.set(webhook.id, plaintext);
      audit(gate.organizationId, actor, "integration.webhook_secret_rotate", "integration_webhook", webhook.id, {
        host: new URL(webhook.url).hostname,
      });
      return {
        ok: true,
        webhook: sanitizeWebhookRow(webhook),
        signingSecret: oneTimeSecretEnvelope(plaintext, WEBHOOK_SECRET_PREFIX),
      };
    },

    toggleWebhook(actor, { webhookId, active } = {}) {
      const gate = scoped(actor);
      if (!gate.ok) return gate;
      const webhook = bucket(gate.organizationId).webhooks.find((row) => row.id === webhookId);
      if (!webhook) return fail("webhook_not_found");
      webhook.active = Boolean(active);
      audit(gate.organizationId, actor, "integration.webhook_toggle", "integration_webhook", webhook.id, {
        active: webhook.active,
      });
      return { ok: true, webhook: sanitizeWebhookRow(webhook) };
    },

    deleteWebhook(actor, { webhookId } = {}) {
      const gate = scoped(actor);
      if (!gate.ok) return gate;
      const data = bucket(gate.organizationId);
      const index = data.webhooks.findIndex((row) => row.id === webhookId);
      if (index < 0) return fail("webhook_not_found");
      const [removed] = data.webhooks.splice(index, 1);
      vault.delete(removed.id);
      audit(gate.organizationId, actor, "integration.webhook_delete", "integration_webhook", removed.id, {});
      return { ok: true };
    },

    async enqueueWebhookDelivery(actor, { webhookId, eventName, idempotencyKey, eventId = idFactory() } = {}) {
      const gate = scoped(actor);
      if (!gate.ok) return gate;
      const data = bucket(gate.organizationId);
      const webhook = data.webhooks.find((row) => row.id === webhookId);
      if (!webhook) return fail("webhook_not_found");
      const planned = buildWebhookDeliveryPlan({
        webhook,
        eventName,
        occurredAt: now(),
        idempotencyKey: idempotencyKey || eventId,
      });
      if (!planned.ok) return planned;
      const existing = data.deliveries.find((row) => (
        row.webhookId === webhookId && row.idempotencyKey === planned.plan.idempotencyKey
      ));
      if (existing) return { ok: true, delivery: existing, replayed: true };
      const delivery = {
        id: idFactory(),
        organizationId: gate.organizationId,
        webhookId,
        eventName,
        eventId,
        idempotencyKey: planned.plan.idempotencyKey,
        status: "queued",
        attemptCount: 0,
        errorCode: null,
        createdAt: now(),
        deliveredAt: null,
        nextAttemptAt: null,
        destinationHost: planned.plan.destinationHost,
      };
      data.deliveries.push(delivery);
      return this.deliverDueWebhooks(actor);
    },

    async deliverDueWebhooks(actor, { jobId = null } = {}) {
      const gate = scoped(actor);
      if (!gate.ok) return gate;
      const data = bucket(gate.organizationId);
      const cycleStartedAt = now();
      const cycleStartedMs = Date.parse(cycleStartedAt);
      const due = data.deliveries.filter((row) => row.status === "queued" || (
        row.status === "failed"
        && (!row.nextAttemptAt || Date.parse(row.nextAttemptAt) <= cycleStartedMs)
      ));
      const results = [];
      for (const delivery of due) {
        if (delivery.attemptCount >= 5) {
          delivery.status = "dead";
          delivery.errorCode = "retry_exhausted";
          delivery.nextAttemptAt = null;
          results.push(delivery);
          continue;
        }
        const webhook = data.webhooks.find((row) => row.id === delivery.webhookId);
        if (!webhook?.active) {
          delivery.status = "skipped";
          delivery.errorCode = "webhook_inactive";
          delivery.nextAttemptAt = null;
          results.push(delivery);
          continue;
        }
        const classified = classifyWebhookUrl(webhook.url);
        if (!classified.ok) {
          delivery.status = "blocked";
          delivery.errorCode = classified.reason;
          delivery.nextAttemptAt = null;
          results.push(delivery);
          continue;
        }
        delivery.attemptCount += 1;
        const payload = JSON.stringify({
          id: delivery.eventId,
          type: delivery.eventName,
          created_at: now(),
          organization_id: gate.organizationId,
        });
        const secret = vault.get(webhook.id);
        const timestamp = String(Math.floor(cycleStartedMs / 1000));
        const signature = secret ? await hmacSha256Hex(secret, `${timestamp}.${payload}`) : null;
        let pinned;
        let outcome;
        if (deliveryTransport) {
          try {
            const resolved = resolveWebhookHost
              ? await resolveWebhookHost(classified.hostname)
              : [];
            pinned = pinWebhookDestination(classified.hostname, resolved);
          } catch {
            pinned = { ok: false, reason: "destination_resolution_failed" };
          }
          if (!pinned.ok) {
            outcome = { ok: false, errorCode: pinned.reason };
          } else {
            try {
              outcome = await deliveryTransport({
                protocol: "https:",
                serverName: classified.hostname,
                address: pinned.address,
                approvedAddresses: pinned.addresses,
                port: 443,
                path: classified.path,
                payload,
                signature,
                timestamp,
                followRedirects: false,
              });
            } catch {
              outcome = { ok: false, errorCode: "transport_error" };
            }
          }
        } else {
          outcome = await defaultLoopbackTransport({
            hostname: classified.hostname,
            payload,
            signature,
            timestamp,
            followRedirects: false,
          });
        }
        if (outcome.ok) {
          delivery.status = "ok";
          delivery.deliveredAt = now();
          delivery.errorCode = null;
          delivery.nextAttemptAt = null;
          webhook.lastDeliveryAt = delivery.deliveredAt;
          webhook.lastDeliveryStatus = "ok";
        } else {
          delivery.status = delivery.attemptCount >= 5 ? "dead" : "failed";
          delivery.errorCode = outcome.errorCode || "delivery_failed";
          const failedAt = now();
          delivery.nextAttemptAt = delivery.status === "failed"
            ? new Date(Date.parse(failedAt) + nextWebhookBackoffMs(delivery.attemptCount)).toISOString()
            : null;
          webhook.lastDeliveryAt = failedAt;
          webhook.lastDeliveryStatus = "failed";
        }
        results.push(delivery);
      }
      if (jobId) {
        const job = data.jobs.find((row) => row.id === jobId);
        if (job) {
          const pendingRetry = data.deliveries
            .filter((row) => row.status === "failed" && row.nextAttemptAt)
            .sort((left, right) => Date.parse(left.nextAttemptAt) - Date.parse(right.nextAttemptAt))[0];
          if (results.length === 0 && pendingRetry) {
            job.status = "queued";
            job.startedAt = null;
            job.finishedAt = null;
            job.errorCode = null;
            job.notBefore = pendingRetry.nextAttemptAt;
            return {
              ok: true,
              deliveries: results,
              job,
              scheduled: true,
              nextBackoffMs: Math.max(0, Date.parse(pendingRetry.nextAttemptAt) - cycleStartedMs),
            };
          }
          const failed = results.some((row) => row.status === "failed" || row.status === "dead" || row.status === "blocked");
          Object.assign(job, transitionJob(job, failed ? "failed" : "success", {
            now: now(),
            processedCount: results.length,
            errorCode: failed ? "delivery_failed" : null,
          }).job);
          job.notBefore = null;
        }
      }
      const nextDue = data.deliveries
        .filter((row) => row.status === "failed" && row.nextAttemptAt)
        .map((row) => Math.max(0, Date.parse(row.nextAttemptAt) - cycleStartedMs));
      return { ok: true, deliveries: results, nextBackoffMs: nextDue.length ? Math.min(...nextDue) : null };
    },

    async issueApiKey(actor, { name } = {}) {
      const gate = scoped(actor);
      if (!gate.ok) return gate;
      const trimmed = String(name || "").trim();
      if (trimmed.length < 1 || trimmed.length > 80) return fail("name_required");
      const plaintext = generateSecret(API_KEY_PREFIX);
      const keyHash = await hashSecret(plaintext);
      const data = bucket(gate.organizationId);
      const key = {
        id: idFactory(),
        organizationId: gate.organizationId,
        name: trimmed,
        keyHash,
        keyPrefix: displayPrefix(plaintext, API_KEY_PREFIX),
        createdAt: now(),
        lastRotatedAt: null,
        lastUsedAt: null,
        revokedAt: null,
      };
      data.apiKeys.push(key);
      data.providers.get("customer_api").status = "configured";
      audit(gate.organizationId, actor, "integration.api_key_issue", "integration_api_key", key.id, { name: trimmed });
      return { ok: true, apiKey: sanitizeApiKeyRow(key), secret: oneTimeSecretEnvelope(plaintext, API_KEY_PREFIX) };
    },

    async rotateApiKey(actor, { keyId } = {}) {
      const gate = scoped(actor);
      if (!gate.ok) return gate;
      const key = bucket(gate.organizationId).apiKeys.find((row) => row.id === keyId);
      if (!key || key.revokedAt) return fail("api_key_not_found");
      const plaintext = generateSecret(API_KEY_PREFIX);
      key.keyHash = await hashSecret(plaintext);
      key.keyPrefix = displayPrefix(plaintext, API_KEY_PREFIX);
      key.lastRotatedAt = now();
      audit(gate.organizationId, actor, "integration.api_key_rotate", "integration_api_key", key.id, {});
      return { ok: true, apiKey: sanitizeApiKeyRow(key), secret: oneTimeSecretEnvelope(plaintext, API_KEY_PREFIX) };
    },

    revokeApiKey(actor, { keyId } = {}) {
      const gate = scoped(actor);
      if (!gate.ok) return gate;
      const key = bucket(gate.organizationId).apiKeys.find((row) => row.id === keyId);
      if (!key) return fail("api_key_not_found");
      key.revokedAt = now();
      const data = bucket(gate.organizationId);
      if (!data.apiKeys.some((row) => !row.revokedAt)) {
        data.providers.get("customer_api").status = "unset";
      }
      audit(gate.organizationId, actor, "integration.api_key_revoke", "integration_api_key", key.id, {});
      return { ok: true, apiKey: sanitizeApiKeyRow(key) };
    },

    async authenticateApiKey(organizationId, plaintext) {
      const data = organizations.get(organizationId);
      if (!data) return fail("unauthorized");
      const digest = await hashSecret(plaintext);
      const key = data.apiKeys.find((row) => row.keyHash === digest && !row.revokedAt);
      if (!key) return fail("unauthorized");
      key.lastUsedAt = now();
      return { ok: true, apiKey: sanitizeApiKeyRow(key) };
    },

    // The harness has no SCIM directory: it reads as an organization that has
    // not turned SCIM on, and every SCIM write reports the missing backend.
    getScimControl(actor) {
      if (!canManageIntegrations(actor)) return fail("unauthorized");
      return {
        ok: true,
        data: {
          organizationId: actor.selectedOrganizationId,
          enabled: false,
          canManage: true,
          defaultChapterId: null,
          requestsPerMinute: 120,
          invitationsPerDay: 200,
          chapters: [],
          tokens: [],
          groups: [],
          users: { total: 0, invited: 0, active: 0, reactivationInvited: 0, needsAdmin: 0, deprovisioned: 0 },
          attention: [],
        },
      };
    },
    saveScimSettings: () => fail("persistence_unset"),
    issueScimToken: () => fail("persistence_unset"),
    revokeScimToken: () => fail("persistence_unset"),
    setScimGroupRole: () => fail("persistence_unset"),

    listWebhookEvents() {
      return [...WEBHOOK_EVENTS];
    },

    listJobKinds() {
      return [...JOB_KINDS];
    },
  };

  function dataForConstantContact(organizationId) {
    return bucket(organizationId).constantContact;
  }
}

async function defaultLoopbackTransport({ hostname, followRedirects }) {
  if (followRedirects) return { ok: false, errorCode: "redirects_forbidden" };
  if (hostname.endsWith(".example") || hostname === "hooks.example.com") {
    return { ok: true };
  }
  return { ok: false, errorCode: "live_egress_disabled" };
}
