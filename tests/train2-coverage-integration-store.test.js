// @vitest-environment node
// Coverage for the integration provider catalog and the in-memory integration
// control store: authorization refusals, provider status moves, job retry and
// dead-lettering, webhook delivery edge outcomes, and the harness stubs.
import { describe, expect, it } from "vitest";
import { createActor } from "../src/features/integrations/authorization.js";
import {
  INTEGRATION_PROVIDER_IDS,
  defaultProviderRecord,
  isActivatableProvider,
  isIntegrationProvider,
} from "../src/features/integrations/catalog.js";
import { SCIM_GENERIC_PROVIDER_REASON } from "../src/features/integrations/scim.js";
import { createIntegrationControlStore } from "../src/features/integrations/store.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const START = Date.parse("2026-08-24T00:00:00.000Z");

function admin(organizationId = ORG) {
  return createActor({
    userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    selectedOrganizationId: organizationId,
    roles: ["admin"],
    membershipStatus: "active",
    mfaSatisfied: true,
  });
}

function member() {
  return createActor({
    userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    selectedOrganizationId: ORG,
    roles: ["member"],
    membershipStatus: "active",
    mfaSatisfied: true,
  });
}

function clockedStore(options = {}) {
  const clock = { ms: START };
  const store = createIntegrationControlStore({ now: () => new Date(clock.ms).toISOString(), ...options });
  return { store, clock };
}

describe("integration provider catalog helpers", () => {
  it("returns no default record for a provider that is not in the catalog", () => {
    expect(defaultProviderRecord("not_a_provider")).toBeNull();
    expect(defaultProviderRecord(undefined)).toBeNull();
  });

  it("gives each known provider a fresh unset record that callers cannot share", () => {
    const first = defaultProviderRecord("twilio");
    const second = defaultProviderRecord("twilio");
    expect(first).toMatchObject({ provider: "twilio", status: "unset", accountOwner: "organization", credentialRef: null });
    first.capabilities.push("mutated");
    expect(second.capabilities).not.toContain("mutated");
  });

  it("separates known, activatable and SCIM providers", () => {
    expect(isIntegrationProvider("twilio")).toBe(true);
    expect(isIntegrationProvider("nope")).toBe(false);
    expect(isActivatableProvider("twilio")).toBe(true);
    expect(isActivatableProvider("scim")).toBe(false);
    expect(isActivatableProvider("nope")).toBe(false);
    expect(INTEGRATION_PROVIDER_IDS).toContain("customer_webhooks");
  });
});

describe("store refuses callers who cannot manage integrations", () => {
  it("answers unauthorized from every read and write", async () => {
    const store = createIntegrationControlStore();
    const actor = member();
    const calls = [
      () => store.getSnapshot(actor),
      () => store.listIntegrationJobs(actor),
      () => store.searchSmsRecipients(actor),
      () => store.configureProvider(actor, { provider: "twilio" }),
      () => store.setProviderStatus(actor, { provider: "twilio", status: "disabled" }),
      () => store.requestActivation(actor, { provider: "twilio" }),
      () => store.setChapterOverride(actor, { provider: "twilio", chapterId: "east" }),
      () => store.enqueueJob(actor, { provider: "twilio", kind: "provider_health" }),
      () => store.runNextJob(actor),
      () => store.retryJob(actor, { jobId: "x" }),
      () => store.beginConstantContactOAuth(actor),
      () => store.syncConstantContact(actor),
      () => store.disconnectConstantContact(actor),
      () => store.createWebhook(actor, { url: "https://hooks.example.com/a", events: ["case.opened"] }),
      () => store.rotateWebhookSecret(actor, { webhookId: "x" }),
      () => store.toggleWebhook(actor, { webhookId: "x", active: false }),
      () => store.deleteWebhook(actor, { webhookId: "x" }),
      () => store.enqueueWebhookDelivery(actor, { webhookId: "x", eventName: "case.opened" }),
      () => store.deliverDueWebhooks(actor),
      () => store.issueApiKey(actor, { name: "Export" }),
      () => store.rotateApiKey(actor, { keyId: "x" }),
      () => store.revokeApiKey(actor, { keyId: "x" }),
      () => store.getScimControl(actor),
    ];
    for (const call of calls) expect(await call()).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("serves empty job and recipient lists to an administrator", () => {
    const store = createIntegrationControlStore();
    expect(store.listIntegrationJobs(admin())).toEqual({ ok: true, data: { items: [], nextBeforeCreatedAt: null, nextBeforeId: null } });
    expect(store.searchSmsRecipients(admin())).toEqual({ ok: true, data: [] });
  });
});

describe("provider configuration and status", () => {
  it("rejects unknown providers and points SCIM at its own tab", () => {
    const store = createIntegrationControlStore();
    const actor = admin();
    expect(store.configureProvider(actor, { provider: "nope" }).reason).toBe("unknown_provider");
    expect(store.configureProvider(actor, { provider: "scim" }).reason).toBe(SCIM_GENERIC_PROVIDER_REASON);
    expect(store.configureProvider(actor).reason).toBe("unknown_provider");
  });

  it("keeps an already requested provider requested when it is configured again", () => {
    const store = createIntegrationControlStore();
    const actor = admin();
    expect(store.configureProvider(actor, { provider: "twilio", allowChapterOverrides: true, allowedChapterOverrideKeys: ["fromNumber"], defaultSettings: { region: "us" } }).provider.status).toBe("requested");
    const again = store.configureProvider(actor, { provider: "twilio" });
    expect(again.provider).toMatchObject({ status: "requested", allowChapterOverrides: false, allowedChapterOverrideKeys: [], defaultSettings: {} });
  });

  it("moves a provider off or back to requested, never to active", () => {
    const store = createIntegrationControlStore();
    const actor = admin();
    expect(store.setProviderStatus(actor, { provider: "nope", status: "disabled" }).reason).toBe("unknown_provider");
    expect(store.setProviderStatus(actor, { provider: "twilio", status: "connected" }).reason).toBe("invalid_input");
    expect(store.setProviderStatus(actor, { provider: "twilio" }).reason).toBe("invalid_input");
    expect(store.setProviderStatus(actor, { provider: "scim", status: "requested" }).reason).toBe(SCIM_GENERIC_PROVIDER_REASON);
    expect(store.setProviderStatus(actor, { provider: "twilio", status: "disabled" }).reason).toBe("provider_not_set_up");
    expect(store.setProviderStatus(actor, { provider: "scim", status: "disabled" }).reason).toBe("provider_not_set_up");

    store.requestActivation(actor, { provider: "twilio" });
    expect(store.setProviderStatus(actor, { provider: "twilio", status: "disabled" }).provider.status).toBe("disabled");
    expect(store.setProviderStatus(actor, { provider: "twilio", status: "requested" }).provider.status).toBe("requested");
    expect(store.getSnapshot(actor).data.audit.map((row) => row.action)).toContain("integration.provider_status");
  });

  it("requests activation only for optional providers and keeps a non-unset status", () => {
    const store = createIntegrationControlStore();
    const actor = admin();
    expect(store.requestActivation(actor, { provider: "scim" }).reason).toBe(SCIM_GENERIC_PROVIDER_REASON);
    expect(store.requestActivation(actor, { provider: "not_a_provider" }).reason).toBe("provider_not_activatable");
    expect(store.requestActivation(actor).reason).toBe("provider_not_activatable");
    expect(store.requestActivation(actor, { provider: "twilio" }).provider.status).toBe("requested");
    store.setProviderStatus(actor, { provider: "twilio", status: "disabled" });
    expect(store.requestActivation(actor, { provider: "twilio" }).provider.status).toBe("disabled");
  });

  it("validates chapter override input before touching state", () => {
    const store = createIntegrationControlStore({ chapterBelongsToOrganization: () => true });
    const actor = admin();
    expect(store.setChapterOverride(actor, { provider: "nope", chapterId: "east" }).reason).toBe("unknown_provider");
    expect(store.setChapterOverride(actor).reason).toBe("unknown_provider");
    expect(store.setChapterOverride(actor, { provider: "scim", chapterId: "east" }).reason).toBe(SCIM_GENERIC_PROVIDER_REASON);
    expect(store.setChapterOverride(actor, { provider: "twilio" }).reason).toBe("chapter_required");
    expect(store.setChapterOverride(actor, { provider: "twilio", chapterId: "east", status: "paused" }).reason).toBe("invalid_override");
  });

  it("defaults a chapter override to inherit once overrides are allowed", () => {
    const store = createIntegrationControlStore({ chapterBelongsToOrganization: (chapterId, organizationId) => chapterId === "east" && organizationId === ORG });
    const actor = admin();
    store.configureProvider(actor, { provider: "twilio", allowChapterOverrides: true });
    const created = store.setChapterOverride(actor, { provider: "twilio", chapterId: "east" });
    expect(created.override).toMatchObject({ status: "inherit", chapterId: "east", overrideSettings: {} });
  });
});

describe("jobs", () => {
  it("rejects a job the plan refuses and replays an idempotent one", () => {
    const store = createIntegrationControlStore();
    const actor = admin();
    expect(store.enqueueJob(actor, { provider: "nope", kind: "provider_health" }).reason).toBe("unknown_provider");
    expect(store.enqueueJob(actor).reason).toBe("unknown_provider");
    expect(store.enqueueJob(actor, { provider: "twilio", kind: "provider_health", chapterId: "east" }).job.chapterId).toBe("east");
  });

  it("skips a queued job for a provider that was never activated", async () => {
    const { store } = clockedStore();
    const actor = admin();
    const queued = store.enqueueJob(actor, { provider: "twilio", kind: "provider_health" });
    const ran = await store.runNextJob(actor);
    expect(ran).toMatchObject({ ok: true, skipped: true, job: { id: queued.job.id, status: "skipped", errorCode: "activation_unset" } });
  });

  it("leaves a scheduled job alone until its not-before time", async () => {
    const { store } = clockedStore({
      resolveWebhookHost: async () => ["8.8.8.8"],
      deliveryTransport: async () => ({ ok: false, errorCode: "upstream_unavailable" }),
    });
    const actor = admin();
    const hook = await store.createWebhook(actor, { url: "https://hooks.example.com/sched", events: ["case.opened"] });
    await store.enqueueWebhookDelivery(actor, { webhookId: hook.webhook.id, eventName: "case.opened", idempotencyKey: "e1" });
    store.enqueueJob(actor, { provider: "twilio", kind: "webhook_retry" });
    const scheduled = await store.runNextJob(actor);
    expect(scheduled).toMatchObject({ ok: true, scheduled: true });
    expect((await store.runNextJob(actor)).reason).toBe("no_queued_job");
  });

  it("retries a failed job, then dead-letters it once attempts are exhausted", async () => {
    const { store, clock } = clockedStore({
      resolveWebhookHost: async () => ["8.8.8.8"],
      deliveryTransport: async () => ({ ok: false }),
    });
    const actor = admin();
    const hook = await store.createWebhook(actor, { url: "https://hooks.example.com/dead", events: ["case.opened"] });
    const failFresh = (key) => store.enqueueWebhookDelivery(actor, { webhookId: hook.webhook.id, eventName: "case.opened", idempotencyKey: key });
    await failFresh("e0");
    const queued = store.enqueueJob(actor, { provider: "twilio", kind: "webhook_retry" });
    const findJob = () => store.getSnapshot(actor).data.jobs.find((job) => job.id === queued.job.id);

    for (let round = 0; round < 4; round += 1) {
      clock.ms += 60_000;
      await failFresh(`e${round + 1}`);
      clock.ms += 60_000;
      const ran = await store.runNextJob(actor);
      expect(ran.ok).toBe(true);
      expect(findJob().status).toBe("failed");
      const retried = store.retryJob(actor, { jobId: queued.job.id });
      expect(retried.ok).toBe(true);
      expect(retried.job).toMatchObject({ status: "queued", attemptCount: round + 2, notBefore: null });
    }
    clock.ms += 60_000;
    await failFresh("e5");
    clock.ms += 60_000;
    await store.runNextJob(actor);
    expect(findJob()).toMatchObject({ status: "failed", attemptCount: 5 });
    const dead = store.retryJob(actor, { jobId: queued.job.id });
    expect(dead.job).toMatchObject({ status: "dead", errorCode: "retry_exhausted" });
    const audit = store.getSnapshot(actor).data.audit.map((row) => row.action);
    expect(audit).toContain("integration.job_retry");
    expect(audit).toContain("integration.job_dead");
    expect(store.getSnapshot(actor).data.deliveries[0]).toMatchObject({ status: "dead", errorCode: "delivery_failed" });
  });

  it("refuses to retry a job that is not failed", async () => {
    const { store } = clockedStore();
    const actor = admin();
    const queued = store.enqueueJob(actor, { provider: "twilio", kind: "provider_health" });
    expect(store.retryJob(actor, { jobId: queued.job.id }).reason).toBe("illegal_transition");
    expect(store.retryJob(actor).reason).toBe("job_not_found");
  });
});

describe("Constant Contact harness controls", () => {
  it("reports the activation gate, an unconnected sync, and a revoked disconnect", () => {
    const store = createIntegrationControlStore();
    const actor = admin();
    expect(store.beginConstantContactOAuth(actor)).toEqual({ ok: false, reason: "activation_unset" });
    expect(store.syncConstantContact(actor)).toEqual({ ok: false, reason: "provider_not_connected" });
    expect(store.disconnectConstantContact(actor)).toEqual({ ok: true });
    const snapshot = store.getSnapshot(actor).data;
    expect(snapshot.constantContact).toMatchObject({ connected: false, status: "revoked" });
    expect(snapshot.providers.find((row) => row.provider === "constant_contact").status).toBe("revoked");
  });
});

describe("webhook management", () => {
  it("answers missing webhooks and rejects bad events", async () => {
    const store = createIntegrationControlStore();
    const actor = admin();
    expect((await store.createWebhook(actor, { url: "https://hooks.example.com/a", events: [] })).reason).toBe("events_required");
    expect((await store.createWebhook(actor, { url: "https://hooks.example.com/a", events: ["nope.event"] })).reason).toBe("unknown_events");
    expect((await store.createWebhook(actor)).reason).toBe("invalid_url");
    expect((await store.rotateWebhookSecret(actor, { webhookId: "missing" })).reason).toBe("webhook_not_found");
    expect((await store.rotateWebhookSecret(actor)).reason).toBe("webhook_not_found");
    expect(store.toggleWebhook(actor, { webhookId: "missing", active: true }).reason).toBe("webhook_not_found");
    expect(store.deleteWebhook(actor, { webhookId: "missing" }).reason).toBe("webhook_not_found");
    expect((await store.enqueueWebhookDelivery(actor, { webhookId: "missing", eventName: "case.opened" })).reason).toBe("webhook_not_found");
  });

  it("rotates a secret, toggles and deletes a webhook, and truncates the description", async () => {
    const store = createIntegrationControlStore();
    const actor = admin();
    const created = await store.createWebhook(actor, { url: "https://hooks.example.com/a", events: "case.opened", description: "d".repeat(300) });
    expect(created.webhook.description).toHaveLength(120);
    const rotated = await store.rotateWebhookSecret(actor, { webhookId: created.webhook.id });
    expect(rotated.signingSecret.plaintext).not.toBe(created.signingSecret.plaintext);
    expect(store.toggleWebhook(actor, { webhookId: created.webhook.id, active: false }).webhook.active).toBe(false);
    expect(store.toggleWebhook(actor, { webhookId: created.webhook.id }).webhook.active).toBe(false);
    expect(store.deleteWebhook(actor, { webhookId: created.webhook.id })).toEqual({ ok: true });
    expect(store.getSnapshot(actor).data.webhooks).toEqual([]);
  });

  it("refuses to plan a delivery for an inactive webhook", async () => {
    const store = createIntegrationControlStore();
    const actor = admin();
    const created = await store.createWebhook(actor, { url: "https://hooks.example.com/a", events: ["case.opened"] });
    store.toggleWebhook(actor, { webhookId: created.webhook.id, active: false });
    expect((await store.enqueueWebhookDelivery(actor, { webhookId: created.webhook.id, eventName: "case.opened" })).reason).toBe("webhook_inactive");
  });

  it("skips a retrying delivery whose webhook has since been switched off", async () => {
    const { store, clock } = clockedStore({
      resolveWebhookHost: async () => ["8.8.8.8"],
      deliveryTransport: async () => ({ ok: false, errorCode: "upstream_unavailable" }),
    });
    const actor = admin();
    const created = await store.createWebhook(actor, { url: "https://hooks.example.com/off", events: ["case.opened"] });
    await store.enqueueWebhookDelivery(actor, { webhookId: created.webhook.id, eventName: "case.opened" });
    store.toggleWebhook(actor, { webhookId: created.webhook.id, active: false });
    clock.ms += 60_000;
    const cycle = await store.deliverDueWebhooks(actor);
    expect(cycle.deliveries[0]).toMatchObject({ status: "skipped", errorCode: "webhook_inactive", nextAttemptAt: null });
    expect(cycle.nextBackoffMs).toBeNull();
  });

  it("blocks delivery when no destination resolver is configured, and when resolution throws", async () => {
    const noResolver = clockedStore({ deliveryTransport: async () => ({ ok: true }) });
    const actor = admin();
    const hook = await noResolver.store.createWebhook(actor, { url: "https://hooks.example.com/a", events: ["case.opened"] });
    const first = await noResolver.store.enqueueWebhookDelivery(actor, { webhookId: hook.webhook.id, eventName: "case.opened" });
    expect(first.deliveries[0]).toMatchObject({ status: "failed", errorCode: "destination_resolution_required" });

    const throwing = clockedStore({
      resolveWebhookHost: async () => { throw new Error("dns down"); },
      deliveryTransport: async () => ({ ok: true }),
    });
    const second = await throwing.store.createWebhook(actor, { url: "https://hooks.example.com/b", events: ["case.opened"] });
    const result = await throwing.store.enqueueWebhookDelivery(actor, { webhookId: second.webhook.id, eventName: "case.opened" });
    expect(result.deliveries[0]).toMatchObject({ status: "failed", errorCode: "destination_resolution_failed" });
  });

  it("delivers to a public literal IP without needing any resolved address", async () => {
    const seen = [];
    const { store } = clockedStore({
      resolveWebhookHost: async () => [],
      deliveryTransport: async (request) => { seen.push(request); return { ok: true }; },
    });
    const actor = admin();
    const hook = await store.createWebhook(actor, { url: "https://8.8.8.8/hook", events: ["case.opened"] });
    const result = await store.enqueueWebhookDelivery(actor, { webhookId: hook.webhook.id, eventName: "case.opened" });
    expect(result.deliveries[0].status).toBe("ok");
    expect(seen[0]).toMatchObject({ address: "8.8.8.8", approvedAddresses: ["8.8.8.8"] });
    expect(store.getSnapshot(actor).data.webhooks[0].lastDeliveryStatus).toBe("ok");
  });

  it("uses the loopback harness when no transport is configured", async () => {
    const { store } = clockedStore();
    const actor = admin();
    const sample = await store.createWebhook(actor, { url: "https://hooks.example.com/a", events: ["case.opened"] });
    const ok = await store.enqueueWebhookDelivery(actor, { webhookId: sample.webhook.id, eventName: "case.opened" });
    expect(ok.deliveries[0].status).toBe("ok");
    const live = await store.createWebhook(actor, { url: "https://customer.test-domain.net/a", events: ["case.opened"] });
    const refused = await store.enqueueWebhookDelivery(actor, { webhookId: live.webhook.id, eventName: "case.opened" });
    expect(refused.deliveries[0]).toMatchObject({ status: "failed", errorCode: "live_egress_disabled" });
  });

  it("completes a webhook job after a retried delivery finally succeeds, and ignores an unknown job id", async () => {
    let succeed = false;
    const { store, clock } = clockedStore({
      resolveWebhookHost: async () => ["8.8.8.8"],
      deliveryTransport: async () => (succeed ? { ok: true } : { ok: false, errorCode: "upstream_unavailable" }),
    });
    const actor = admin();
    const hook = await store.createWebhook(actor, { url: "https://hooks.example.com/ok", events: ["case.opened"] });
    await store.enqueueWebhookDelivery(actor, { webhookId: hook.webhook.id, eventName: "case.opened", idempotencyKey: "e1" });
    expect((await store.deliverDueWebhooks(actor, { jobId: "missing-job" })).deliveries).toEqual([]);

    succeed = true;
    clock.ms += 60_000;
    const queued = store.enqueueJob(actor, { provider: "twilio", kind: "webhook_deliver" });
    const ran = await store.runNextJob(actor);
    expect(ran.ok).toBe(true);
    expect(store.getSnapshot(actor).data.jobs.find((job) => job.id === queued.job.id)).toMatchObject({ status: "success", processedCount: 1, errorCode: null });
    expect(store.getSnapshot(actor).data.webhooks[0].lastDeliveryStatus).toBe("ok");
  });
});

describe("API keys", () => {
  it("validates the name and refuses missing, revoked or foreign keys", async () => {
    const store = createIntegrationControlStore();
    const actor = admin();
    expect((await store.issueApiKey(actor)).reason).toBe("name_required");
    expect((await store.issueApiKey(actor, { name: "   " })).reason).toBe("name_required");
    expect((await store.issueApiKey(actor, { name: "n".repeat(81) })).reason).toBe("name_required");
    expect((await store.rotateApiKey(actor, { keyId: "missing" })).reason).toBe("api_key_not_found");
    expect((await store.rotateApiKey(actor)).reason).toBe("api_key_not_found");
    expect(store.revokeApiKey(actor, { keyId: "missing" }).reason).toBe("api_key_not_found");

    const issued = await store.issueApiKey(actor, { name: "Export" });
    const second = await store.issueApiKey(actor, { name: "Backup" });
    expect(store.revokeApiKey(actor, { keyId: issued.apiKey.id }).ok).toBe(true);
    expect(store.getSnapshot(actor).data.providers.find((row) => row.provider === "customer_api").status).toBe("configured");
    expect((await store.rotateApiKey(actor, { keyId: issued.apiKey.id })).reason).toBe("api_key_not_found");
    expect((await store.authenticateApiKey("22222222-2222-4222-8222-222222222222", second.secret.plaintext)).reason).toBe("unauthorized");
    expect((await store.authenticateApiKey(ORG, "ug_live_" + "0".repeat(48))).reason).toBe("unauthorized");
    expect((await store.authenticateApiKey(ORG, second.secret.plaintext)).apiKey.lastUsedAt).not.toBeNull();
  });
});

describe("SCIM harness stubs and no SSO", () => {
  it("reads as an organization with SCIM off, refuses every write and offers no SSO control", () => {
    const store = createIntegrationControlStore();
    const actor = admin();
    expect(store.getScimControl(actor).data).toMatchObject({ organizationId: ORG, enabled: false, tokens: [] });
    for (const write of [store.saveScimSettings, store.issueScimToken, store.revokeScimToken, store.setScimGroupRole]) {
      expect(write(actor, {})).toEqual({ ok: false, reason: "persistence_unset" });
    }
    // Union Ground has no SSO sign-in: the store exposes no SSO read, write
    // or admin step.
    for (const name of ["getSsoControl", "saveSsoConnection", "addSsoDomain", "removeSsoDomain", "ssoAdmin"]) {
      expect(store).not.toHaveProperty(name);
    }
    expect(Object.keys(store).filter((name) => /sso/i.test(name))).toEqual([]);
  });
});

describe("sample defaults", () => {
  it("lists a copy of the webhook events and job kinds", () => {
    const store = createIntegrationControlStore({ idFactory: (() => { let n = 0; return () => `id-${++n}`; })() });
    const events = store.listWebhookEvents();
    events.push("tampered");
    expect(store.listWebhookEvents()).not.toContain("tampered");
    expect(store.listJobKinds()).toContain("webhook_deliver");
    expect(store.getSnapshot(admin()).data.providers[0].id).toBe("id-1");
  });
});
