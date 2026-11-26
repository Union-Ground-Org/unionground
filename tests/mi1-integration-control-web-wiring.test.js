import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SPA_ROUTE_PATHS } from "../src/lib/appRoutes.js";
import {
  MI1_DATABASE_DEPENDENCIES,
  MI1_FEATURE_WEB_DONOR,
  buildMi1FeatureActor,
  createSupabaseIntegrationStore,
  createUnsetIntegrationStore,
  isMissingRpcError,
  loadOrganizationSessionScope,
  mergeMi1SessionScope,
} from "../src/lib/mi1FeatureWiring.js";
import { canManageIntegrations } from "../src/features/integrations/authorization.js";
import { STAFF_TOOLS } from "../src/lib/staffPlanes.js";
import { STAFF_ROLE_NAVIGATION } from "../src/lib/staffNavigation.js";

const ORG = "11111111-1111-4111-8111-111111111111";

describe("MI1 integration-control web wiring", () => {
  it("records integration-only provenance and rejected donor assumptions", () => {
    expect(MI1_FEATURE_WEB_DONOR.baseline).toBe("donor-baseline-20260721");
    expect(MI1_FEATURE_WEB_DONOR.webWiring).toBe("ad2aef01af257be3d6fbbbe985b24f984cf8f222");
    expect(MI1_FEATURE_WEB_DONOR.disposition).toBe("port_adapt");
    expect(MI1_FEATURE_WEB_DONOR.rejected).toEqual(expect.arrayContaining([
      "in-memory writes presented as persisted success",
      "QA, pay, analytics, operations, and public-directory wiring",
    ]));
  });

  it("registers integrations as an admin/president staff tool", () => {
    expect(STAFF_TOOLS.map((tool) => tool.view)).toContain("integrations");
    expect(STAFF_TOOLS.find((tool) => tool.view === "integrations")?.allowedHats).toEqual(["admin", "vp"]);
    expect(SPA_ROUTE_PATHS).toContain("/m/integrations");
    expect(STAFF_ROLE_NAVIGATION.admin.map((item) => item.key)).toContain("integrations");
    expect(STAFF_ROLE_NAVIGATION.vp.map((item) => item.key)).toContain("integrations");
    expect(STAFF_ROLE_NAVIGATION.steward.map((item) => item.key)).not.toContain("integrations");
    expect(STAFF_ROLE_NAVIGATION.coordinator.map((item) => item.key)).not.toContain("integrations");
  });

  it("maps missing RPCs and empty session scope without inventing an organization", async () => {
    expect(isMissingRpcError({ code: "PGRST202" })).toBe(true);
    expect(isMissingRpcError({ status: 42883 })).toBe(true);
    expect(isMissingRpcError(new Error("function does not exist"))).toBe(true);
    expect(isMissingRpcError({ code: "other", message: "timeout" })).toBe(false);
    expect(await loadOrganizationSessionScope(null)).toEqual({
      organizationId: null,
      chapterId: null,
      organizationRoles: [],
      chapterRoles: [],
      unavailable: true,
    });
    expect(buildMi1FeatureActor({ userId: "user-a" }).selectedOrganizationId).toBeNull();
  });

  it("loads, normalizes, and merges the selected organization session scope", async () => {
    const selected = await loadOrganizationSessionScope({
      rpc: async () => ({
        data: [
          { organizationId: "ignored", chapterId: "ignored", organizationRoles: [], chapterRoles: ["steward"] },
          { organizationId: ORG, chapterId: "chapter-a", organizationRoles: ["admin", "admin", "bogus"], chapterRoles: ["steward", "bogus"], selected: true },
        ],
        error: null,
      }),
    });
    expect(selected).toEqual({
      organizationId: ORG,
      chapterId: "chapter-a",
      organizationRoles: ["admin"],
      chapterRoles: ["steward"],
      unavailable: false,
    });
    expect(await loadOrganizationSessionScope({ rpc: async () => ({ data: null, error: { code: "offline" } }) })).toMatchObject({ unavailable: true });
    expect(await loadOrganizationSessionScope({ rpc: async () => { throw new Error("offline"); } })).toMatchObject({ unavailable: true });
    expect(await loadOrganizationSessionScope({
      rpc: async () => ({ data: [{ organizationId: "not-selected", organizationRoles: ["admin"] }], error: null }),
    })).toEqual({ organizationId: null, chapterId: null, organizationRoles: [], chapterRoles: [], unavailable: false });

    const actor = buildMi1FeatureActor({ userId: "admin-a", organizationRoles: ["admin", "bogus"], selectedHat: "member" });
    expect(actor.role).toBe("admin");
    const merged = mergeMi1SessionScope(actor, selected);
    expect(merged).toMatchObject({
      organizationId: ORG,
      selectedOrganizationId: ORG,
      chapterId: "chapter-a",
      organizationRoles: ["admin"],
      chapterRoles: ["steward"],
      roles: ["admin", "steward"],
      membershipStatus: "active",
    });
    expect(mergeMi1SessionScope({ ...merged, chapterId: "chapter-existing", chapterRoles: ["vp"] }, selected)).toMatchObject({
      chapterId: "chapter-a",
      chapterRoles: ["steward"],
    });
    expect(mergeMi1SessionScope(merged, {
      organizationId: ORG,
      chapterId: "chapter-a",
      organizationRoles: [],
      chapterRoles: [],
      unavailable: false,
    })).toMatchObject({ organizationRoles: [], chapterRoles: [] });
  });

  // BUG-UG-ORGANIZATION-CHAPTERLESS-ADMIN-VP-LOCKED-OUT-INTEGRATION-CONTROL-RPC-20260921
  it("resolves an organization-only admin through the staff scope and keeps multiple organizations closed", async () => {
    function client(memberships, staffScope) {
      const calls = [];
      return {
        calls,
        rpc: async (name) => {
          calls.push(name);
          if (name === "get_my_chapter_memberships") return { data: memberships, error: null };
          if (name === "get_my_mobile_staff_scope") {
            return staffScope instanceof Error ? { data: null, error: staffScope } : { data: staffScope, error: null };
          }
          return { data: null, error: { code: "PGRST202" } };
        },
      };
    }

    const chapterless = client([], { organizationId: ORG, roles: ["admin", "bogus"], chapterRoles: [], staffAuthorized: true });
    const scope = await loadOrganizationSessionScope(chapterless);
    expect(chapterless.calls).toEqual(["get_my_chapter_memberships", "get_my_mobile_staff_scope"]);
    expect(scope).toEqual({
      organizationId: ORG,
      chapterId: null,
      organizationRoles: ["admin"],
      chapterRoles: [],
      unavailable: false,
    });
    const admin = mergeMi1SessionScope(
      buildMi1FeatureActor({ userId: "admin-a", mfaSatisfied: true, selectedHat: "admin" }),
      scope,
    );
    expect(admin).toMatchObject({ organizationId: ORG, selectedOrganizationId: ORG, membershipStatus: "active" });
    expect(canManageIntegrations(admin)).toBe(true);

    // Two active organizations resolve to no organization server-side, and a
    // chapterless member with no organization hat is not staff.
    for (const closed of [
      { organizationId: null, roles: [], chapterRoles: [], staffAuthorized: false },
      { organizationId: ORG, roles: [], chapterRoles: [], staffAuthorized: false },
      new Error("offline"),
      null,
    ]) {
      const refused = await loadOrganizationSessionScope(client([], closed));
      expect(refused).toEqual({
        organizationId: null,
        chapterId: null,
        organizationRoles: [],
        chapterRoles: [],
        unavailable: false,
      });
      expect(canManageIntegrations(mergeMi1SessionScope(
        buildMi1FeatureActor({ userId: "admin-a", mfaSatisfied: true, selectedHat: "admin" }),
        refused,
      ))).toBe(false);
    }

    // A selected chapter still answers alone; the staff scope is never asked.
    const chaptered = client(
      [{ organizationId: ORG, chapterId: "chapter-a", organizationRoles: ["vp"], chapterRoles: [], selected: true }],
      { organizationId: "22222222-2222-4222-8222-222222222222", roles: ["admin"], chapterRoles: [], staffAuthorized: true },
    );
    expect(await loadOrganizationSessionScope(chaptered)).toMatchObject({ organizationId: ORG, chapterId: "chapter-a" });
    expect(chaptered.calls).toEqual(["get_my_chapter_memberships"]);
  });

  it("refuses integration writes while persistence is unset and keeps providers unset", () => {
    const store = createUnsetIntegrationStore();
    const actor = buildMi1FeatureActor({
      userId: "admin-a",
      organizationId: ORG,
      roles: ["admin"],
      mfaSatisfied: true,
      selectedHat: "admin",
    });
    const snapshot = store.getSnapshot(actor);
    expect(snapshot.ok).toBe(true);
    expect(snapshot.data.persistence).toBe("unset");
    expect(snapshot.data.providers.every((row) => row.status === "unset")).toBe(true);
    expect(snapshot.data.providers.find((row) => row.provider === "scim")?.status).toBe("unset");
    expect(snapshot.data.scim.switchKey).toBe("features.integrations.scim");
    expect(store.requestActivation(actor, { provider: "twilio" })).toEqual({
      ok: false,
      reason: "persistence_unset",
    });
    expect(store.issueApiKey(actor, { name: "desk" })).toEqual({
      ok: false,
      reason: "persistence_unset",
    });
    expect(store.issueScimToken(actor)).toEqual({
      ok: false,
      reason: "persistence_unset",
    });
    for (const method of [
      "configureProvider",
      "setChapterOverride",
      "enqueueJob",
      "runNextJob",
      "retryJob",
      "createWebhook",
      "rotateWebhookSecret",
      "toggleWebhook",
      "deleteWebhook",
      "enqueueWebhookDelivery",
      "rotateApiKey",
      "revokeApiKey",
    ]) {
      expect(store[method](actor)).toEqual({ ok: false, reason: "persistence_unset" });
    }
    expect(store.getSnapshot(buildMi1FeatureActor({ userId: "member-a", organizationId: ORG }))).toEqual({
      ok: false,
      reason: "unauthorized",
    });
  });

  it("lists exact reserved X-DB dependencies for integrations only", () => {
    expect(Object.keys(MI1_DATABASE_DEPENDENCIES)).toEqual(["integrations", "sessionScope"]);
    expect(MI1_DATABASE_DEPENDENCIES.integrations.rpcs).toEqual([
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
    ]);
    expect(MI1_DATABASE_DEPENDENCIES.integrations.tables).toEqual([
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
    ]);
    // Union Ground has no SSO sign-in: the web wiring reserves no SSO RPC or table.
    const reserved = [...MI1_DATABASE_DEPENDENCIES.integrations.rpcs, ...MI1_DATABASE_DEPENDENCIES.integrations.tables];
    expect(reserved.filter((name) => /(^|_)sso(_|$)/.test(name))).toEqual([]);
    expect(MI1_DATABASE_DEPENDENCIES.sessionScope.rpcs).toEqual([
      "get_my_chapter_memberships",
      "get_my_mobile_staff_scope",
    ]);
  });

  it("backs visible web setup controls with organization-scoped RPCs and one-time secrets", async () => {
    const calls = [];
    const client = {
      rpc: async (name, args) => {
        calls.push({ name, args });
        const rows = {
          list_organization_integrations: [{
            id: "integration-twilio",
            organizationId: ORG,
            provider: "twilio",
            status: "unset",
            allowChapterOverrides: false,
            allowedChapterOverrideKeys: [],
            defaultSettings: {},
          }],
          list_chapter_integration_overrides: [],
          list_integration_job_page: { items: [], nextBeforeCreatedAt: null, nextBeforeId: null },
          list_integration_webhooks: [],
          list_integration_webhook_delivery_page: { items: [], nextBeforeCreatedAt: null, nextBeforeId: null },
          list_integration_api_keys: [],
          create_integration_webhook: {
            id: "webhook-a",
            signingSecret: `whsec_${"a".repeat(48)}`,
          },
          rotate_integration_webhook_secret: {
            signingSecret: `whsec_${"b".repeat(48)}`,
          },
        };
        return { data: rows[name] ?? [], error: null };
      },
    };
    const actor = buildMi1FeatureActor({
      userId: "admin-a",
      organizationId: ORG,
      roles: ["admin"],
      mfaSatisfied: true,
      selectedHat: "admin",
    });
    const store = createSupabaseIntegrationStore(client);
    const snapshot = await store.getSnapshot(actor);
    expect(snapshot.ok).toBe(true);
    expect(snapshot.data.persistence).toBe("supabase");
    expect(snapshot.data.providers.find((row) => row.provider === "twilio").status).toBe("unset");
    expect(snapshot.data.capabilities).toEqual({ jobsWrite: true, webhookDelivery: true, webhookSecretRotation: true, apiKeyRotation: true });

    expect((await store.requestActivation(actor, { provider: "twilio" })).ok).toBe(true);
    const webhook = await store.createWebhook(actor, {
      url: "https://hooks.example.com/events",
      events: ["case.opened"],
    });
    expect(webhook.signingSecret.plaintext).toMatch(/^whsec_/);
    const webhookCall = calls.find((call) => call.name === "create_integration_webhook");
    expect(webhookCall.args).toEqual({
      p_url: "https://hooks.example.com/events",
      p_events: ["case.opened"],
    });
    const rotatedWebhook = await store.rotateWebhookSecret(actor, { webhookId: "webhook-a" });
    expect(rotatedWebhook.signingSecret.plaintext).toBe(`whsec_${"b".repeat(48)}`);
    expect(calls.find((call) => call.name === "rotate_integration_webhook_secret")?.args).toEqual({
      p_webhook_id: "webhook-a",
    });

    const key = await store.issueApiKey(actor, { name: "Operations" });
    expect(key.secret.plaintext).toMatch(/^ug_live_/);
    const keyCall = calls.find((call) => call.name === "create_integration_api_key");
    expect(keyCall.args.p_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(keyCall.args)).not.toContain(key.secret.plaintext);
  });

  it("covers persistent mutations, unavailable operations, and bounded RPC failures", async () => {
    const calls = [];
    const client = {
      rpc: async (name, args) => {
        calls.push({ name, args });
        const rows = {
          list_organization_integrations: [{
            id: "integration-twilio",
            organizationId: ORG,
            provider: "twilio",
            status: "configured",
            allowChapterOverrides: true,
            allowedChapterOverrideKeys: ["fromNumber"],
            defaultSettings: { fromNumber: "organization" },
          }],
          list_chapter_integration_overrides: [{
            id: "override-west",
            organizationIntegrationId: "integration-twilio",
            chapterId: "west",
            status: "enabled",
            overrideSettings: { fromNumber: "wrong-chapter" },
          }, {
            id: "override-east",
            organizationIntegrationId: "integration-twilio",
            chapterId: "east",
            status: "enabled",
            overrideSettings: { fromNumber: "chapter" },
          }],
          list_integration_job_page: {
            items: [{ id: "job-1", provider: "twilio", jobKind: "provider_health", status: "failed" }],
            nextBeforeCreatedAt: "2026-08-23T00:00:00.000Z",
            nextBeforeId: "job-1",
          },
          list_integration_webhooks: [{ id: "hook-1", url: "https://hooks.example.com/a", events: ["case.opened"], active: true }],
          list_integration_webhook_delivery_page: {
            items: [{ id: "delivery-1", eventName: "case.opened", status: "ok" }],
            nextBeforeCreatedAt: "2026-08-24T00:00:00.000Z",
            nextBeforeId: "delivery-1",
          },
          list_integration_api_keys: [{ id: "key-1", name: "Operations", keyPrefix: "ug_live_1234", revokedAt: null }],
        };
        return { data: rows[name] ?? [], error: null };
      },
    };
    const actor = buildMi1FeatureActor({
      userId: "admin-a",
      organizationId: ORG,
      chapterId: "east",
      roles: ["admin"],
      mfaSatisfied: true,
      selectedHat: "admin",
    });
    const store = createSupabaseIntegrationStore(client);
    const snapshot = await store.getSnapshot(actor);
    expect(snapshot.data.providers.find((row) => row.provider === "twilio").effective.settings.fromNumber).toBe("chapter");
    expect(snapshot.data.jobHealth.twilio.failed).toBe(1);
    expect(snapshot.data.jobs[0].kind).toBe("provider_health");
    expect(snapshot.data.jobCursor).toEqual({
      beforeCreatedAt: "2026-08-23T00:00:00.000Z",
      beforeId: "job-1",
    });
    expect(snapshot.data.webhooks).toHaveLength(1);
    expect(snapshot.data.deliveries).toHaveLength(1);
    expect(snapshot.data.deliveryCursor).toEqual({
      beforeCreatedAt: "2026-08-24T00:00:00.000Z",
      beforeId: "delivery-1",
    });
    expect(snapshot.data.apiKeys).toHaveLength(1);

    expect((await store.configureProvider(actor, {
      provider: "twilio",
      allowChapterOverrides: true,
      allowedChapterOverrideKeys: ["fromNumber"],
      defaultSettings: { fromNumber: "organization" },
    })).ok).toBe(true);
    expect((await store.setChapterOverride(actor, {
      provider: "twilio",
      chapterId: "east",
      status: "enabled",
      overrideSettings: { fromNumber: "chapter" },
    })).ok).toBe(true);
    expect((await store.toggleWebhook(actor, { webhookId: "hook-1", active: false })).ok).toBe(true);
    expect((await store.deleteWebhook(actor, { webhookId: "hook-1" })).ok).toBe(true);
    expect((await store.revokeApiKey(actor, { keyId: "key-1" })).ok).toBe(true);
    expect(calls.map((call) => call.name)).toEqual(expect.arrayContaining([
      "set_integration_chapter_controls",
      "upsert_chapter_integration_override",
      "set_integration_webhook_active",
      "delete_integration_webhook",
      "revoke_integration_api_key",
    ]));

    expect(await store.requestActivation(actor, { provider: "scim" })).toEqual({ ok: false, reason: "scim_setup_on_scim_tab" });
    expect(await store.requestActivation(actor, { provider: "unknown" })).toEqual({ ok: false, reason: "provider_not_activatable" });
    expect(await store.configureProvider(actor, { provider: "scim" })).toEqual({ ok: false, reason: "scim_setup_on_scim_tab" });
    expect(await store.configureProvider(actor, { provider: "unknown" })).toEqual({ ok: false, reason: "unknown_provider" });
    expect(await store.createWebhook(actor, { url: "http://unsafe.example", events: ["case.opened"] })).toMatchObject({ ok: false, reason: "https_required" });
    expect(await store.createWebhook(actor, { url: "https://hooks.example.com", events: [] })).toMatchObject({ ok: false, reason: "events_required" });
    expect(await store.issueApiKey(actor, { name: "" })).toEqual({ ok: false, reason: "name_required" });
    expect((await store.enqueueJob(actor, { provider: "twilio", kind: "provider_health" })).ok).toBe(true);
    expect((await store.runNextJob(actor)).ok).toBe(true);
    expect((await store.retryJob(actor, { jobId: "job-1" })).ok).toBe(true);
    expect((await store.listWebhookDeliveries(actor, snapshot.data.deliveryCursor)).ok).toBe(true);
    expect(calls.map((call) => call.name)).toEqual(expect.arrayContaining([
      "enqueue_integration_job",
      "run_next_integration_job",
      "retry_integration_job",
      "list_integration_webhook_delivery_page",
    ]));
    expect(await store.enqueueWebhookDelivery(actor, { webhookId: "hook-1", eventName: "case.opened" })).toEqual({ ok: false, reason: "persistence_unavailable" });
    expect((await store.rotateApiKey(actor, { keyId: "key-1" })).ok).toBe(true);
    expect(calls.map((call) => call.name)).toContain("rotate_integration_api_key");
    expect((await store.issueScimToken(actor, { label: "" })).reason).toBe("name_required");

    const wrongHat = buildMi1FeatureActor({
      userId: "admin-a",
      organizationId: ORG,
      roles: ["admin", "steward"],
      mfaSatisfied: true,
      selectedHat: "steward",
    });
    expect(await store.getSnapshot(wrongHat)).toEqual({ ok: false, reason: "unauthorized" });
    expect(await store.toggleWebhook(wrongHat, { webhookId: "hook-1", active: false })).toEqual({ ok: false, reason: "unauthorized" });

    const rpcFailureStore = createSupabaseIntegrationStore({
      rpc: async (name) => {
        if (name === "upsert_organization_integration") return { data: null, error: { code: "42501" } };
        if (name === "create_integration_webhook") return { data: null, error: { code: "22023" } };
        if (name === "delete_integration_webhook") return { data: null, error: { code: "P0002" } };
        throw new Error("offline");
      },
    });
    expect(await rpcFailureStore.requestActivation(actor, { provider: "twilio" })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await rpcFailureStore.createWebhook(actor, { url: "https://hooks.example.com", events: ["case.opened"] })).toEqual({ ok: false, reason: "invalid_url" });
    expect(await rpcFailureStore.deleteWebhook(actor, { webhookId: "missing" })).toEqual({ ok: false, reason: "not_found" });
    expect(await rpcFailureStore.getSnapshot(actor)).toEqual({ ok: false, reason: "persistence_unavailable" });
    expect(await createSupabaseIntegrationStore(null).getSnapshot(actor)).toEqual({ ok: false, reason: "persistence_unavailable" });
  });

  it("dispatches persisted webhook tests through the authenticated API boundary", async () => {
    const requests = [];
    const actor = buildMi1FeatureActor({
      userId: "admin-a",
      organizationId: ORG,
      roles: ["admin"],
      mfaSatisfied: true,
      selectedHat: "admin",
    });
    const store = createSupabaseIntegrationStore({ rpc: async () => ({ data: [], error: null }) }, {
      apiRequest: async (path, body) => {
        requests.push({ path, body });
        return { ok: true, deliveryId: "delivery-1", status: "ok" };
      },
    });
    await expect(store.enqueueWebhookDelivery(actor, { webhookId: "hook-1", eventName: "case.opened" })).resolves.toMatchObject({ ok: true, status: "ok" });
    expect(requests).toEqual([{
      path: "/api/integration-webhooks",
      body: { webhookId: "hook-1", eventName: "case.opened" },
    }]);
    expect(await store.issueApiKey(actor, { name: "x".repeat(81) })).toEqual({ ok: false, reason: "name_required" });
  });

  it("dispatches Constant Contact OAuth and bounded sync through the authenticated API boundary", async () => {
    const requests = [];
    const rpcCalls = [];
    const actor = buildMi1FeatureActor({
      userId: "admin-a",
      organizationId: ORG,
      roles: ["admin"],
      mfaSatisfied: true,
      selectedHat: "admin",
    });
    const client = {
      rpc: async (name, args) => {
        rpcCalls.push({ name, args });
        return { data: true, error: null };
      },
    };
    const store = createSupabaseIntegrationStore(client, {
      apiRequest: async (path, body) => {
        requests.push({ path, body });
        if (path === "/api/constant-contact-oauth") {
          return { ok: true, authorizationUrl: "https://authz.constantcontact.com/oauth2/default/v1/authorize?state=safe" };
        }
        return { ok: true, jobId: "job-1", status: "success" };
      },
    });

    await expect(store.beginConstantContactOAuth(actor)).resolves.toMatchObject({ ok: true });
    await expect(store.syncConstantContact(actor, { limit: 7 })).resolves.toMatchObject({ ok: true, jobId: "job-1" });
    await expect(store.disconnectConstantContact(actor)).resolves.toMatchObject({ ok: true });
    expect(requests).toEqual([{
      path: "/api/constant-contact-oauth",
      body: { action: "start" },
    }, {
      path: "/api/constant-contact-sync",
      body: { action: "sync", limit: 7 },
    }]);
    expect(rpcCalls).toContainEqual({ name: "disconnect_constant_contact", args: undefined });

    const malformedStore = createSupabaseIntegrationStore(client, {
      apiRequest: async () => ({ ok: true, authorizationUrl: "https://example.com/not-the-provider" }),
    });
    await expect(malformedStore.beginConstantContactOAuth(actor)).resolves.toEqual({
      ok: false,
      reason: "persistence_unavailable",
    });

    const wrongHat = buildMi1FeatureActor({
      userId: "admin-a",
      organizationId: ORG,
      roles: ["admin", "steward"],
      mfaSatisfied: true,
      selectedHat: "steward",
    });
    await expect(store.beginConstantContactOAuth(wrongHat)).resolves.toEqual({ ok: false, reason: "unauthorized" });
    expect(store.syncConstantContact(wrongHat)).toEqual({ ok: false, reason: "unauthorized" });
    expect(store.disconnectConstantContact(wrongHat)).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("keeps the integration wiring isolated from other MI1 domains and migrations", () => {
    const wiring = readFileSync("src/lib/mi1FeatureWiring.js", "utf8");
    const app = readFileSync("src/App.jsx", "utf8");
    const view = readFileSync("src/views/IntegrationsView.jsx", "utf8");
    expect(wiring).not.toMatch(/supabase\/migrations/);
    expect(wiring).not.toMatch(/features\/(qa|pay|analytics|operations|publicDirectory)/);
    expect(view).toContain("IntegrationControlPlane");
    expect(app).toContain("IntegrationsView");
  });
});
