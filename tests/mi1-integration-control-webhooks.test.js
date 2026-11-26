// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createActor } from "../src/features/integrations/authorization.js";
import {
  API_KEY_PREFIX,
  WEBHOOK_SECRET_PREFIX,
  displayPrefix,
  generateSecret,
  hashSecret,
  sanitizeApiKeyRow,
  sanitizeWebhookRow,
} from "../src/features/integrations/secrets.js";
import { createIntegrationControlStore } from "../src/features/integrations/store.js";
import {
  WEBHOOK_EVENTS,
  buildWebhookDeliveryPlan,
  classifyWebhookUrl,
  isSafeWebhookUrl,
  nextWebhookBackoffMs,
  parseWebhookEvents,
  pinWebhookDestination,
} from "../src/features/integrations/webhooks.js";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

function admin(organizationId = ORG_A) {
  return createActor({
    userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    selectedOrganizationId: organizationId,
    roles: ["admin"],
    membershipStatus: "active",
    mfaSatisfied: true,
  });
}

describe("CR-093 customer webhooks and API keys", () => {
  it("hashes secrets and strips them from admin rows", async () => {
    const key = generateSecret(API_KEY_PREFIX);
    const webhook = generateSecret(WEBHOOK_SECRET_PREFIX);
    expect(key).toMatch(/^ug_live_[0-9a-f]{48}$/);
    expect(webhook).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(key).not.toBe(generateSecret(API_KEY_PREFIX));

    const digest = await hashSecret(key);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(await hashSecret(key));
    expect(digest).not.toContain(key);
    expect(displayPrefix(key, API_KEY_PREFIX).length).toBeLessThanOrEqual(16);

    const sanitizedWebhook = sanitizeWebhookRow({
      id: "w1",
      organizationId: ORG_A,
      url: "https://hooks.example.com/a",
      events: ["case.opened"],
      secretHash: "a".repeat(64),
      active: true,
    });
    expect(sanitizedWebhook).not.toHaveProperty("secretHash");
    expect(sanitizedWebhook.secretPresent).toBe(true);
    expect(sanitizeApiKeyRow({
      id: "k1",
      organizationId: ORG_A,
      name: "Exports",
      keyHash: "b".repeat(64),
      keyPrefix: "ug_live_abcd",
    })).not.toHaveProperty("keyHash");

    const storeSource = readFileSync("src/features/integrations/store.js", "utf8");
    expect(storeSource.match(/vault\.set\(/g)).toHaveLength(2);
    expect(storeSource).not.toMatch(/vault\.set\(key\.id, plaintext\)/);
  });

  it("rejects unsafe webhook destinations", () => {
    expect(classifyWebhookUrl("https://hooks.example.com/union").ok).toBe(true);
    expect(classifyWebhookUrl("http://hooks.example.com/union").reason).toBe("https_required");
    expect(classifyWebhookUrl("https://user:pass@hooks.example.com/union").reason).toBe("credentials_forbidden");
    expect(classifyWebhookUrl("https://hooks.example.com:8443/union").reason).toBe("port_forbidden");
    expect(classifyWebhookUrl("https://localhost/hooks").reason).toBe("blocked_host");
    expect(classifyWebhookUrl("https://localhost./hooks").reason).toBe("blocked_host");
    expect(classifyWebhookUrl("https://hooks.example.com./union")).toMatchObject({
      ok: true,
      href: "https://hooks.example.com/union",
      hostname: "hooks.example.com",
    });
    expect(classifyWebhookUrl("https://127.0.0.1/hooks").reason).toBe("private_or_metadata_ip");
    expect(classifyWebhookUrl("https://10.1.2.3/hooks").reason).toBe("private_or_metadata_ip");
    expect(classifyWebhookUrl("https://192.168.1.9/hooks").reason).toBe("private_or_metadata_ip");
    expect(classifyWebhookUrl("https://169.254.169.254/latest/meta-data").reason).toBe("private_or_metadata_ip");
    expect(classifyWebhookUrl("https://metadata.google.internal/").reason).toBe("blocked_host");
    expect(classifyWebhookUrl("https://hooks.internal/union").reason).toBe("blocked_suffix");
    expect(classifyWebhookUrl("https://[::1]/hooks").reason).toBe("private_or_metadata_ip");
    expect(classifyWebhookUrl("not a url").reason).toBe("invalid_url");
    expect(classifyWebhookUrl("https://0.1.2.3/hooks").reason).toBe("private_or_metadata_ip");
    expect(classifyWebhookUrl("https://172.20.1.2/hooks").reason).toBe("private_or_metadata_ip");
    expect(classifyWebhookUrl("https://100.64.0.1/hooks").reason).toBe("private_or_metadata_ip");
    expect(classifyWebhookUrl("https://198.18.0.1/hooks").reason).toBe("private_or_metadata_ip");
    expect(classifyWebhookUrl("https://8.8.8.8/hooks")).toMatchObject({ ok: true, hostname: "8.8.8.8" });
    expect(classifyWebhookUrl("https://[fe80::1]/hooks").reason).toBe("private_or_metadata_ip");
    expect(classifyWebhookUrl("https://[fc00::1]/hooks").reason).toBe("private_or_metadata_ip");
    expect(isSafeWebhookUrl("https://hooks.example.com/union")).toBe(true);
    expect(isSafeWebhookUrl("http://hooks.example.com/union")).toBe(false);
    expect(pinWebhookDestination("hooks.example.com", ["127.0.0.1"]).reason).toBe("unsafe_destination_resolution");
    expect(pinWebhookDestination("hooks.example.com", ["169.254.169.254"]).reason).toBe("unsafe_destination_resolution");
    expect(pinWebhookDestination("hooks.example.com", ["8.8.8.8", "1.1.1.1"])).toMatchObject({ ok: true, address: "8.8.8.8" });
    expect(pinWebhookDestination("hooks.example.com", []).reason).toBe("destination_resolution_required");
  });

  it("parses the current event catalog and rejects unknown events", () => {
    expect(parseWebhookEvents("case.opened, broadcast.published")).toEqual({
      ok: true,
      events: ["case.opened", "broadcast.published"],
    });
    expect(parseWebhookEvents(["event.checkin", "event.checkin"]).events).toEqual(["event.checkin"]);
    expect(parseWebhookEvents("").reason).toBe("events_required");
    expect(parseWebhookEvents("grievance.created").ok).toBe(false);
    expect(WEBHOOK_EVENTS).not.toContain("grievance.created");
  });

  it("builds only active subscribed delivery plans with bounded backoff", () => {
    const webhook = {
      id: "hook-1",
      organizationId: ORG_A,
      url: "https://hooks.example.com/events?q=1",
      active: true,
      events: ["case.opened"],
    };
    expect(buildWebhookDeliveryPlan({
      webhook,
      eventName: "case.opened",
      occurredAt: "2026-08-24T00:00:00.000Z",
      idempotencyKey: "case-1",
    })).toMatchObject({
      ok: true,
      plan: { destinationHost: "hooks.example.com", followRedirects: false, maxAttempts: 5 },
    });
    expect(buildWebhookDeliveryPlan({
      webhook: { ...webhook, active: false },
      eventName: "case.opened",
      occurredAt: "2026-08-24T00:00:00.000Z",
      idempotencyKey: "case-inactive",
    }).reason).toBe("webhook_inactive");
    expect(buildWebhookDeliveryPlan({ webhook, eventName: "case.updated" }).reason).toBe("event_not_subscribed");
    expect(buildWebhookDeliveryPlan({ webhook: { ...webhook, url: "http://hooks.example.com" }, eventName: "case.opened" }).reason).toBe("https_required");
    expect(nextWebhookBackoffMs(0)).toBe(1000);
    expect(nextWebhookBackoffMs(3)).toBe(4000);
    expect(nextWebhookBackoffMs(20)).toBe(30000);
  });

  it("issues, rotates, and revokes organization-scoped API keys", async () => {
    const store = createIntegrationControlStore();
    const actor = admin(ORG_A);
    const issued = await store.issueApiKey(actor, { name: "Operations export" });
    expect(issued.ok).toBe(true);
    expect(issued.secret.plaintext.startsWith("ug_live_")).toBe(true);
    expect(issued.apiKey.keyPrefix.startsWith("ug_live_")).toBe(true);
    expect(issued.apiKey).not.toHaveProperty("keyHash");

    const snapshot = store.getSnapshot(actor).data;
    expect(JSON.stringify(snapshot.apiKeys)).not.toContain(issued.secret.plaintext);
    expect(snapshot.providers.find((row) => row.provider === "customer_api").status).toBe("configured");

    expect((await store.authenticateApiKey(ORG_A, issued.secret.plaintext)).ok).toBe(true);
    expect((await store.authenticateApiKey(ORG_B, issued.secret.plaintext)).ok).toBe(false);

    const rotated = await store.rotateApiKey(actor, { keyId: issued.apiKey.id });
    expect(rotated.secret.plaintext).not.toBe(issued.secret.plaintext);
    expect((await store.authenticateApiKey(ORG_A, issued.secret.plaintext)).ok).toBe(false);
    expect((await store.authenticateApiKey(ORG_A, rotated.secret.plaintext)).ok).toBe(true);

    expect(store.revokeApiKey(actor, { keyId: issued.apiKey.id }).ok).toBe(true);
    expect((await store.authenticateApiKey(ORG_A, rotated.secret.plaintext)).ok).toBe(false);
    expect(store.getSnapshot(actor).data.providers.find((row) => row.provider === "customer_api").status).toBe("unset");
    expect(store.getSnapshot(admin(ORG_B)).data.apiKeys).toEqual([]);
  });

  it("records webhook configuration and harness delivery history without live egress", async () => {
    const attempts = [];
    const store = createIntegrationControlStore({
      resolveWebhookHost: async () => ["8.8.8.8"],
      deliveryTransport: async (request) => {
        attempts.push(request);
        expect(request.followRedirects).toBe(false);
        expect(request).not.toHaveProperty("url");
        expect(request).toMatchObject({ address: "8.8.8.8", serverName: "hooks.example.com", path: "/union-ground" });
        expect(request.signature).toMatch(/^[0-9a-f]{64}$/);
        expect(request.timestamp).toMatch(/^\d+$/);
        return { ok: true };
      },
    });
    const actor = admin();
    const created = await store.createWebhook(actor, {
      url: "https://hooks.example.com/union-ground",
      events: ["case.opened", "broadcast.published"],
    });
    expect(created.ok).toBe(true);
    expect(created.signingSecret.shownOnce).toBe(true);
    expect(store.getSnapshot(actor).data.webhooks[0]).not.toHaveProperty("secretHash");

    const blocked = await store.createWebhook(actor, {
      url: "https://127.0.0.1/hooks",
      events: ["case.opened"],
    });
    expect(blocked.reason).toBe("private_or_metadata_ip");

    const delivered = await store.enqueueWebhookDelivery(actor, {
      webhookId: created.webhook.id,
      eventName: "case.opened",
      idempotencyKey: "case-1",
    });
    expect(delivered.ok).toBe(true);
    expect(delivered.deliveries[0].status).toBe("ok");
    expect(attempts).toHaveLength(1);
    const replay = await store.enqueueWebhookDelivery(actor, {
      webhookId: created.webhook.id,
      eventName: "case.opened",
      idempotencyKey: "case-1",
    });
    expect(replay.replayed).toBe(true);
    expect(attempts).toHaveLength(1);

    const history = store.getSnapshot(actor).data.deliveries;
    expect(history[0].destinationHost).toBe("hooks.example.com");
    expect(history[0].eventName).toBe("case.opened");
    expect(JSON.stringify(history)).not.toContain(created.signingSecret.plaintext);
  });

  it("dead-letters exhausted webhook retries and never follows redirects", async () => {
    let clock = Date.parse("2026-08-24T00:00:00.000Z");
    const store = createIntegrationControlStore({
      now: () => new Date(clock).toISOString(),
      resolveWebhookHost: async () => ["8.8.8.8"],
      deliveryTransport: async () => ({ ok: false, errorCode: "upstream_unavailable" }),
    });
    const actor = admin();
    const created = await store.createWebhook(actor, {
      url: "https://hooks.example.com/retry",
      events: ["event.checkin"],
    });
    await store.enqueueWebhookDelivery(actor, {
      webhookId: created.webhook.id,
      eventName: "event.checkin",
      idempotencyKey: "checkin-1",
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      clock += 30_000;
      await store.deliverDueWebhooks(actor);
    }
    const delivery = store.getSnapshot(actor).data.deliveries[0];
    expect(delivery.status).toBe("dead");
    expect(delivery.attemptCount).toBe(5);
    expect(["upstream_unavailable", "retry_exhausted"]).toContain(delivery.errorCode);
  });

  it("honors retry timing, contains transport exceptions, and scopes replay keys per endpoint", async () => {
    let clock = Date.parse("2026-08-24T00:00:00.000Z");
    let attempts = 0;
    const store = createIntegrationControlStore({
      now: () => new Date(clock).toISOString(),
      resolveWebhookHost: async () => ["8.8.8.8"],
      deliveryTransport: async () => {
        attempts += 1;
        throw new Error("socket reset");
      },
    });
    const actor = admin();
    const first = await store.createWebhook(actor, { url: "https://hooks.example.com/one", events: ["case.opened"] });
    const second = await store.createWebhook(actor, { url: "https://hooks.example.com/two", events: ["case.opened"] });

    const failed = await store.enqueueWebhookDelivery(actor, {
      webhookId: first.webhook.id,
      eventName: "case.opened",
      idempotencyKey: "event-1",
    });
    expect(failed.deliveries[0]).toMatchObject({ status: "failed", errorCode: "transport_error", attemptCount: 1 });
    expect(attempts).toBe(1);
    expect((await store.deliverDueWebhooks(actor)).deliveries).toEqual([]);
    expect(attempts).toBe(1);

    const secondDelivery = await store.enqueueWebhookDelivery(actor, {
      webhookId: second.webhook.id,
      eventName: "case.opened",
      idempotencyKey: "event-1",
    });
    expect(secondDelivery.replayed).not.toBe(true);
    expect(attempts).toBe(2);

    clock += 1_000;
    await store.deliverDueWebhooks(actor);
    expect(attempts).toBe(4);
  });

  it("turns a throwing webhook transport into a failed runnable job", async () => {
    let clock = Date.parse("2026-08-24T00:00:00.000Z");
    const store = createIntegrationControlStore({
      now: () => new Date(clock).toISOString(),
      resolveWebhookHost: async () => ["8.8.8.8"],
      deliveryTransport: async () => { throw new Error("tls failure"); },
    });
    const actor = admin();
    const webhook = await store.createWebhook(actor, {
      url: "https://hooks.example.com/jobs",
      events: ["case.opened"],
    });
    await store.enqueueWebhookDelivery(actor, {
      webhookId: webhook.webhook.id,
      eventName: "case.opened",
      idempotencyKey: "job-event",
    });
    clock += 1_000;
    const queued = store.enqueueJob(actor, { provider: "twilio", kind: "webhook_retry" });
    const result = await store.runNextJob(actor);
    expect(result.ok).toBe(true);
    expect(store.getSnapshot(actor).data.jobs.find((job) => job.id === queued.job.id)).toMatchObject({
      status: "failed",
      errorCode: "delivery_failed",
    });
  });

  it("keeps a webhook retry job scheduled until its delivery backoff is due", async () => {
    let clock = Date.parse("2026-08-24T00:00:00.000Z");
    const store = createIntegrationControlStore({
      now: () => new Date(clock).toISOString(),
      resolveWebhookHost: async () => ["8.8.8.8"],
      deliveryTransport: async () => ({ ok: false, errorCode: "upstream_unavailable" }),
    });
    const actor = admin();
    const webhook = await store.createWebhook(actor, {
      url: "https://hooks.example.com/scheduled",
      events: ["case.opened"],
    });
    await store.enqueueWebhookDelivery(actor, {
      webhookId: webhook.webhook.id,
      eventName: "case.opened",
      idempotencyKey: "scheduled-event",
    });
    const queued = store.enqueueJob(actor, { provider: "twilio", kind: "webhook_retry" });
    const early = await store.runNextJob(actor);
    expect(early).toMatchObject({ ok: true, scheduled: true, deliveries: [] });
    expect(store.getSnapshot(actor).data.jobs.find((job) => job.id === queued.job.id)).toMatchObject({
      status: "queued",
      notBefore: new Date(clock + 1_000).toISOString(),
    });
    expect(await store.runNextJob(actor)).toEqual({ ok: false, reason: "no_queued_job" });
    clock += 1_000;
    expect((await store.runNextJob(actor)).ok).toBe(true);
    expect(store.getSnapshot(actor).data.jobs.find((job) => job.id === queued.job.id).status).toBe("failed");
  });

  it("toggles, rejects, and removes webhook records within the organization", async () => {
    const store = createIntegrationControlStore();
    const actor = admin();
    expect((await store.createWebhook(actor, { url: "https://hooks.example.com/empty", events: [] })).reason).toBe("events_required");
    expect(store.toggleWebhook(actor, { webhookId: "missing", active: false }).reason).toBe("webhook_not_found");
    expect(store.deleteWebhook(actor, { webhookId: "missing" }).reason).toBe("webhook_not_found");
    expect((await store.enqueueWebhookDelivery(actor, { webhookId: "missing", eventName: "case.opened" })).reason).toBe("webhook_not_found");

    const created = await store.createWebhook(actor, {
      url: "https://hooks.example.com/manage",
      events: ["case.opened"],
      description: "managed endpoint",
    });
    expect(store.toggleWebhook(actor, { webhookId: created.webhook.id, active: false }).webhook.active).toBe(false);
    expect((await store.enqueueWebhookDelivery(actor, {
      webhookId: created.webhook.id,
      eventName: "case.opened",
    })).reason).toBe("webhook_inactive");
    expect(store.toggleWebhook(actor, { webhookId: created.webhook.id, active: true }).webhook.active).toBe(true);
    expect((await store.enqueueWebhookDelivery(actor, {
      webhookId: created.webhook.id,
      eventName: "case.updated",
    })).reason).toBe("event_not_subscribed");
    expect(store.deleteWebhook(actor, { webhookId: created.webhook.id }).ok).toBe(true);
    expect(store.getSnapshot(actor).data.webhooks).toEqual([]);
  });

  it("uses the default no-egress transport and validates API-key failures", async () => {
    const store = createIntegrationControlStore();
    const actor = admin();
    expect((await store.issueApiKey(actor, { name: "" })).reason).toBe("name_required");
    expect((await store.rotateApiKey(actor, { keyId: "missing" })).reason).toBe("api_key_not_found");
    expect(store.revokeApiKey(actor, { keyId: "missing" }).reason).toBe("api_key_not_found");

    const allowed = await store.createWebhook(actor, {
      url: "https://hooks.example.com/default",
      events: ["case.opened"],
    });
    expect((await store.enqueueWebhookDelivery(actor, {
      webhookId: allowed.webhook.id,
      eventName: "case.opened",
    })).deliveries[0].status).toBe("ok");

    const denied = await store.createWebhook(actor, {
      url: "https://public.example.net/default",
      events: ["case.opened"],
    });
    expect((await store.enqueueWebhookDelivery(actor, {
      webhookId: denied.webhook.id,
      eventName: "case.opened",
    })).deliveries[0]).toMatchObject({ status: "failed", errorCode: "live_egress_disabled" });
  });
});
