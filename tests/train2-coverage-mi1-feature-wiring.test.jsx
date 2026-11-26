// Coverage for src/lib/mi1FeatureWiring.js: actor and session-scope helpers,
// the unset store, the Supabase-backed store's authorization gates, argument
// checks, RPC-error mapping, snapshot assembly and the authenticated API
// boundary (requestApi and ssoAdmin).
import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MI1_DATABASE_DEPENDENCIES,
  buildMi1FeatureActor,
  createSupabaseIntegrationStore,
  createUnsetIntegrationStore,
  isMissingRpcError,
  loadOrganizationSessionScope,
  mergeMi1SessionScope,
  useMi1ScopedActor,
} from "../src/lib/mi1FeatureWiring.js";

const ORG = "11111111-1111-4111-8111-111111111111";

function adminActor(overrides = {}) {
  return buildMi1FeatureActor({ userId: "admin-a", organizationId: ORG, roles: ["admin"], mfaSatisfied: true, selectedHat: "admin", ...overrides });
}

const stewardHat = () => adminActor({ roles: ["admin", "steward"], selectedHat: "steward" });

function rpcClient(handler) {
  const calls = [];
  return {
    calls,
    rpc: vi.fn(async (name, args) => {
      calls.push({ name, args });
      return handler(name, args);
    }),
  };
}

const okClient = (data = []) => rpcClient(() => ({ data, error: null }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isMissingRpcError", () => {
  it("recognizes codes, statuses and messages, including bare strings and empty input", () => {
    expect(isMissingRpcError("Could not find the function public.x")).toBe(true);
    expect(isMissingRpcError("relation does not exist")).toBe(true);
    expect(isMissingRpcError({ code: "42883" })).toBe(true);
    expect(isMissingRpcError({ code: "other", status: "PGRST202" })).toBe(false);
    expect(isMissingRpcError(null)).toBe(false);
    expect(isMissingRpcError(undefined)).toBe(false);
    expect(isMissingRpcError({})).toBe(false);
  });
});

describe("buildMi1FeatureActor", () => {
  it("defaults an anonymous caller to no organization, inactive, member hat", () => {
    const actor = buildMi1FeatureActor();
    expect(actor).toMatchObject({
      userId: null, organizationId: null, selectedOrganizationId: null, chapterId: null,
      membershipStatus: "inactive", organizationStatus: null, mfaSatisfied: false,
      selectedHat: "member", authenticated: false, role: null,
    });
    expect(Object.isFrozen(actor)).toBe(true);
  });

  it("marks a caller with an organization active, and uses the hat as the role off the member hat", () => {
    const member = buildMi1FeatureActor({ userId: "u", organizationId: ORG, roles: ["steward", "bogus"] });
    expect(member).toMatchObject({ membershipStatus: "active", organizationStatus: "active", selectedHat: "member", role: "steward", roles: ["steward"], organizationRoles: ["steward"] });
    expect(buildMi1FeatureActor({ userId: "u", organizationId: ORG, roles: ["steward"], selectedHat: null })).toMatchObject({ selectedHat: "member" });
    const hatted = buildMi1FeatureActor({ userId: "u", organizationId: ORG, organizationRoles: ["admin"], chapterRoles: ["steward"], selectedHat: "admin", membershipStatus: "invited", organizationStatus: "paused", chapterId: "c1" });
    expect(hatted).toMatchObject({ role: "admin", organizationRoles: ["admin"], chapterRoles: ["steward"], roles: [], membershipStatus: "invited", organizationStatus: "paused", chapterId: "c1", authenticated: true });
    expect(buildMi1FeatureActor({ userId: "u", membershipStatus: "", organizationStatus: "" })).toMatchObject({ membershipStatus: "inactive", organizationStatus: null });
    expect(buildMi1FeatureActor({ userId: "u", organizationId: ORG, membershipStatus: "", organizationStatus: "" })).toMatchObject({ membershipStatus: "active", organizationStatus: "active" });
  });
});

describe("loadOrganizationSessionScope", () => {
  const unavailable = { organizationId: null, chapterId: null, organizationRoles: [], chapterRoles: [], unavailable: true };

  it("is unavailable without a client, with a failing memberships read, or when the read throws", async () => {
    expect(await loadOrganizationSessionScope(undefined)).toEqual(unavailable);
    expect(await loadOrganizationSessionScope({})).toEqual(unavailable);
    expect(await loadOrganizationSessionScope({ rpc: async () => ({ data: null, error: { code: "boom" } }) })).toEqual(unavailable);
    expect(await loadOrganizationSessionScope({ rpc: async () => { throw new Error("offline"); } })).toEqual(unavailable);
  });

  it("keeps the chapter answer when the staff scope is refused, malformed, or throws", async () => {
    const empty = { organizationId: null, chapterId: null, organizationRoles: [], chapterRoles: [], unavailable: false };
    const staffAnswers = [
      { data: null, error: { code: "x" } },
      { data: null, error: null },
      { data: "text", error: null },
      { data: [], error: null },
      { data: { staffAuthorized: false, organizationId: ORG }, error: null },
      { data: { staffAuthorized: true, organizationId: 7 }, error: null },
      { data: { staffAuthorized: true, organizationId: "" }, error: null },
    ];
    for (const answer of staffAnswers) {
      const client = { rpc: async (name) => (name === "get_my_chapter_memberships" ? { data: [], error: null } : answer) };
      expect(await loadOrganizationSessionScope(client)).toEqual(empty);
    }
    const throwing = { rpc: async (name) => { if (name === "get_my_chapter_memberships") return { data: "not-an-array", error: null }; throw new Error("staff down"); } };
    expect(await loadOrganizationSessionScope(throwing)).toEqual(empty);
  });

  it("does not consult the staff scope once a selected membership exists", async () => {
    const client = rpcClient(() => ({ data: [{ selected: true }], error: null }));
    expect(await loadOrganizationSessionScope(client)).toEqual({ organizationId: null, chapterId: null, organizationRoles: [], chapterRoles: [], unavailable: false });
    expect(client.calls.map((call) => call.name)).toEqual(["get_my_chapter_memberships"]);
  });

  it("reads staff role lists that are missing as empty", async () => {
    const client = { rpc: async (name) => (name === "get_my_chapter_memberships" ? { data: [], error: null } : { data: { staffAuthorized: true, organizationId: ORG }, error: null }) };
    expect(await loadOrganizationSessionScope(client)).toEqual({ organizationId: ORG, chapterId: null, organizationRoles: [], chapterRoles: [], unavailable: false });
  });
});

describe("mergeMi1SessionScope", () => {
  it("keeps the bootstrap actor while the scope is unavailable or absent", () => {
    const actor = { userId: "u", organizationId: ORG, chapterId: "c1", roles: ["admin"], organizationRoles: ["admin"], chapterRoles: [], membershipStatus: "active", organizationStatus: "active", mfaSatisfied: true, selectedHat: "admin" };
    expect(mergeMi1SessionScope(actor)).toMatchObject({ organizationId: ORG, chapterId: "c1", membershipStatus: "active" });
    expect(mergeMi1SessionScope(actor, undefined)).toMatchObject({ organizationId: ORG });
    expect(mergeMi1SessionScope({ userId: "u", selectedOrganizationId: ORG }, { unavailable: true })).toMatchObject({ organizationId: ORG });
    expect(mergeMi1SessionScope({ userId: "u" }, { unavailable: true, organizationId: ORG, chapterId: "c2" })).toMatchObject({ organizationId: ORG, chapterId: "c2" });
    expect(mergeMi1SessionScope(undefined, { unavailable: true })).toMatchObject({ organizationId: null, roles: [] });
  });

  it("makes an answered but empty scope authoritative", () => {
    const actor = { userId: "u", organizationId: ORG, roles: ["admin"], organizationRoles: ["admin"], membershipStatus: "active", organizationStatus: "active" };
    const merged = mergeMi1SessionScope(actor, { organizationId: null, chapterId: null, organizationRoles: [], chapterRoles: [], unavailable: false });
    expect(merged).toMatchObject({ organizationId: null, membershipStatus: "inactive", organizationStatus: null, organizationRoles: [], chapterRoles: [] });
    expect(merged.roles).toEqual(["admin"]);
  });
});

describe("useMi1ScopedActor", () => {
  it("starts from the bootstrap actor, then adopts the resolved scope", async () => {
    const client = { rpc: async () => ({ data: [{ selected: true, organizationId: ORG, chapterId: "c9", organizationRoles: ["admin"], chapterRoles: [] }], error: null }) };
    const actor = { userId: "u", organizationId: ORG, roles: [], mfaSatisfied: true, selectedHat: "admin" };
    const { result } = renderHook(() => useMi1ScopedActor(client, actor));
    expect(result.current).toMatchObject({ organizationId: ORG, authenticated: true });
    await waitFor(() => expect(result.current.chapterId).toBe("c9"));
    expect(result.current.organizationRoles).toEqual(["admin"]);
  });

  it("falls back to the selected organization id and ignores a scope that arrives after unmount", async () => {
    let release;
    const client = { rpc: () => new Promise((resolve) => { release = resolve; }) };
    const { result, unmount } = renderHook(() => useMi1ScopedActor(client, { userId: "u", selectedOrganizationId: ORG, roles: ["bogus", "admin"], organizationRoles: ["admin"], chapterRoles: ["steward"] }));
    expect(result.current).toMatchObject({ organizationId: ORG, roles: ["admin"] });
    unmount();
    await act(async () => { release({ data: [{ selected: true, organizationId: "late" }], error: null }); });
    expect(result.current.organizationId).toBe(ORG);
  });

  it("handles a missing actor", () => {
    const { result } = renderHook(() => useMi1ScopedActor(null, undefined));
    expect(result.current).toMatchObject({ userId: null, organizationId: null, authenticated: false });
  });
});

describe("createUnsetIntegrationStore", () => {
  it("serves an all-unset snapshot to an authorized admin and refuses everyone else", async () => {
    const store = createUnsetIntegrationStore();
    expect(store.persistenceKind).toBe("unset");
    expect(store.getSnapshot(buildMi1FeatureActor({ userId: "u" }))).toEqual({ ok: false, reason: "unauthorized" });
    const snap = store.getSnapshot(adminActor());
    expect(snap.data).toMatchObject({ organizationId: ORG, persistence: "unset", constantContact: { available: false, status: "unset" }, capabilities: { jobsWrite: false } });
    expect(snap.data.providers.every((row) => row.status === "unset" && row.id.startsWith("unset:"))).toBe(true);
  });

  it("denies every write with persistence_unset, and Constant Contact with activation_unset", () => {
    const store = createUnsetIntegrationStore();
    const writes = ["requestActivation", "configureProvider", "setProviderStatus", "setChapterOverride", "enqueueJob", "runNextJob", "retryJob",
      "createWebhook", "rotateWebhookSecret", "toggleWebhook", "deleteWebhook", "enqueueWebhookDelivery", "listWebhookDeliveries",
      "issueApiKey", "rotateApiKey", "revokeApiKey", "getScimControl", "saveScimSettings", "issueScimToken", "revokeScimToken",
      "setScimGroupRole"];
    for (const name of writes) expect(store[name](adminActor(), {})).toEqual({ ok: false, reason: "persistence_unset" });
    // Union Ground has no SSO sign-in: the unset store offers no SSO step.
    for (const name of ["getSsoControl", "saveSsoConnection", "addSsoDomain", "removeSsoDomain", "ssoAdmin"]) expect(store).not.toHaveProperty(name);
    for (const name of ["beginConstantContactOAuth", "syncConstantContact", "disconnectConstantContact"]) {
      expect(store[name](adminActor())).toEqual({ ok: false, reason: "activation_unset" });
    }
  });
});

describe("Supabase store authorization gates", () => {
  it("refuses every operation to a caller without an integration-manager hat", async () => {
    const client = okClient();
    const store = createSupabaseIntegrationStore(client);
    const actor = stewardHat();
    const calls = [
      () => store.getSnapshot(actor),
      () => store.requestActivation(actor, { provider: "twilio" }),
      () => store.configureProvider(actor, { provider: "twilio" }),
      () => store.setProviderStatus(actor, { provider: "twilio", status: "disabled" }),
      () => store.setChapterOverride(actor, { provider: "twilio", chapterId: "c" }),
      () => store.createWebhook(actor, { url: "https://hooks.example.com/a", events: ["case.opened"] }),
      () => store.rotateWebhookSecret(actor, { webhookId: "w" }),
      () => store.toggleWebhook(actor, { webhookId: "w" }),
      () => store.deleteWebhook(actor, { webhookId: "w" }),
      () => store.issueApiKey(actor, { name: "n" }),
      () => store.revokeApiKey(actor, { keyId: "k" }),
      () => store.rotateApiKey(actor, { keyId: "k" }),
      () => store.enqueueWebhookDelivery(actor, { webhookId: "w", eventName: "case.opened" }),
      () => store.listWebhookDeliveries(actor),
      () => store.listIntegrationJobs(actor),
      () => store.searchSmsRecipients(actor, "ana"),
      () => store.enqueueJob(actor, { provider: "twilio", kind: "provider_health" }),
      () => store.sendSms(actor, { memberId: "m", purpose: "p", body: "b", idempotencyKey: "i" }),
      () => store.runNextJob(actor),
      () => store.retryJob(actor, { jobId: "j" }),
      () => store.beginConstantContactOAuth(actor),
      () => store.syncConstantContact(actor),
      () => store.disconnectConstantContact(actor),
      () => store.getScimControl(actor),
      () => store.saveScimSettings(actor, { defaultChapterId: "c" }),
      () => store.issueScimToken(actor, { label: "l" }),
      () => store.revokeScimToken(actor, { tokenId: "t" }),
      () => store.setScimGroupRole(actor, { groupId: "g", role: null }),
    ];
    for (const call of calls) expect(await call()).toEqual({ ok: false, reason: "unauthorized" });
    expect(client.rpc).not.toHaveBeenCalled();
  });
});

describe("Supabase store RPC plumbing", () => {
  it("maps every database refusal message and code to a bounded reason", async () => {
    const cases = [
      [{ message: "MFA required for this action" }, "mfa_required"],
      [{ message: "SCIM provisioning is switched off" }, "scim_switched_off"],
      [{ message: "SCIM default chapter required" }, "scim_no_default_chapter"],
      [{ message: "Too many live SCIM tokens" }, "scim_token_limit"],
      [{ message: "chapter outside organization" }, "invalid_input"],
      [{ message: "invalid SCIM token" }, "invalid_input"],
      [{ message: "unsupported role" }, "invalid_input"],
      // No SSO surface: SSO refusals carry no SSO-specific reason.
      [{ message: "invalid SSO connection" }, "persistence_unavailable"],
      [{ message: "invalid SSO domain" }, "persistence_unavailable"],
      [{ message: "too many SSO domains" }, "persistence_unavailable"],
      [{ message: "SSO domain verified elsewhere" }, "persistence_unavailable"],
      [{ code: "42501" }, "unauthorized"],
      [{ status: 42501 }, "unauthorized"],
      [{ message: "not authorized" }, "unauthorized"],
      [{ code: "22023" }, "invalid_url"],
      [{ message: "invalid webhook url" }, "invalid_url"],
      [{ code: "P0002" }, "not_found"],
      [{ message: "row not found" }, "not_found"],
      [{ code: "XX000", message: "internal" }, "persistence_unavailable"],
      [{}, "persistence_unavailable"],
    ];
    for (const [error, reason] of cases) {
      const store = createSupabaseIntegrationStore(rpcClient(() => ({ data: null, error })));
      expect(await store.retryJob(adminActor(), { jobId: "j" })).toEqual({ ok: false, reason });
    }
  });

  it("reports persistence_unavailable without a client or when the call throws", async () => {
    expect(await createSupabaseIntegrationStore(undefined).getCompassPlatformAi()).toEqual({ ok: false, reason: "persistence_unavailable" });
    expect(await createSupabaseIntegrationStore({}).runNextJob(adminActor())).toEqual({ ok: false, reason: "persistence_unavailable" });
    const throwing = createSupabaseIntegrationStore({ rpc: async () => { throw new Error("offline"); } });
    expect(await throwing.getCompassPlatformAi()).toEqual({ ok: false, reason: "persistence_unavailable" });
    expect(throwing.persistenceKind).toBe("supabase");
  });

  it("passes the Compass platform AI read through unwrapped, and mutations as ok/data", async () => {
    const client = rpcClient((name) => ({ data: name === "get_compass_platform_ai" ? { model: "m" } : { done: true }, error: null }));
    const store = createSupabaseIntegrationStore(client);
    expect(await store.getCompassPlatformAi()).toEqual({ ok: true, data: { model: "m" } });
    expect(await store.runNextJob(adminActor())).toEqual({ ok: true, data: { done: true } });
  });
});

describe("Supabase store snapshot", () => {
  const ALL = {
    list_organization_integrations: [
      { id: "i-tw", organizationId: ORG, provider: "twilio", status: "configured", defaultSettings: { fromNumber: "org" } },
      { provider: "ai_connector_gemini", status: "connected", defaultSettings: { model: "m".repeat(200) } },
      { provider: "ai_connector_claude", status: "requested" },
      null,
    ],
    list_chapter_integration_overrides: [null, { organizationIntegrationId: "i-tw", chapterId: "other", status: "enabled" }],
    list_integration_job_page: { items: [{ id: "j1", provider: "twilio", kind: "provider_health", status: "success" }, { id: "j2", provider: "twilio", status: "failed" }], nextBeforeCreatedAt: "2026-08-23T00:00:00.000Z" },
    list_integration_webhooks: [{ id: "w1" }],
    list_integration_webhook_delivery_page: { items: [{ id: "d1" }], nextBeforeCreatedAt: "2026-08-24T00:00:00.000Z", nextBeforeId: "d1" },
    list_integration_api_keys: [{ id: "k1" }],
    list_constant_contact_control: { connected: true, status: "connected" },
    list_constant_contact_sync_runs: [{ id: "r1" }],
    list_constant_contact_analytics: [{ id: "a1" }],
  };

  it("assembles providers, AI connectors, cursors and Constant Contact detail", async () => {
    const client = rpcClient((name) => ({ data: ALL[name], error: null }));
    const store = createSupabaseIntegrationStore(client);
    const { data } = await store.getSnapshot(adminActor({ chapterId: "east" }));
    expect(data.providers.find((row) => row.provider === "twilio")).toMatchObject({ id: "i-tw", status: "configured", chapterOverride: null });
    expect(data.providers.find((row) => row.provider === "google_calendar").id).toBe("unset:google_calendar");
    expect(data.aiConnectors).toEqual([
      { provider: "ai_connector_gemini", status: "connected", model: "m".repeat(105) },
      { provider: "ai_connector_claude", status: "requested", model: "" },
    ]);
    expect(data.jobs.map((job) => job.kind)).toEqual(["provider_health", "unknown"]);
    expect(data.jobCursor).toBeNull();
    expect(data.deliveryCursor).toEqual({ beforeCreatedAt: "2026-08-24T00:00:00.000Z", beforeId: "d1" });
    expect(data.constantContact).toMatchObject({ available: true, connected: true, syncRuns: [{ id: "r1" }], analytics: [{ id: "a1" }] });
  });

  it("falls back to empty lists and an unavailable Constant Contact when optional reads fail or come back malformed", async () => {
    const client = rpcClient((name) => {
      if (name === "list_constant_contact_control") return { data: null, error: { code: "PGRST202" } };
      if (name === "list_organization_integrations") return { data: { not: "an array" }, error: null };
      if (name === "list_integration_job_page") return { data: null, error: null };
      if (name === "list_integration_webhook_delivery_page") return { data: null, error: null };
      return { data: { not: "an array" }, error: null };
    });
    const { data } = await createSupabaseIntegrationStore(client).getSnapshot(adminActor());
    expect(data).toMatchObject({ aiConnectors: null, jobs: [], webhooks: [], deliveries: [], deliveryCursor: null, apiKeys: [], jobCursor: null });
    expect(data.constantContact).toEqual({ available: false, connected: false, status: "unset", syncRuns: [], analytics: [] });
  });

  it("keeps Constant Contact detail lists empty when only the run and analytics reads fail", async () => {
    const client = rpcClient((name) => {
      if (name === "list_constant_contact_sync_runs") return { data: null, error: { code: "x" } };
      if (name === "list_constant_contact_analytics") return { data: "nope", error: null };
      if (name === "list_constant_contact_control") return { data: null, error: null };
      return { data: [], error: null };
    });
    const { data } = await createSupabaseIntegrationStore(client).getSnapshot(adminActor());
    expect(data.constantContact).toEqual({ available: true, syncRuns: [], analytics: [] });
  });

  it("returns the first failing required read", async () => {
    const client = rpcClient((name) => (name === "list_integration_api_keys" ? { data: null, error: { code: "42501" } } : { data: [], error: null }));
    expect(await createSupabaseIntegrationStore(client).getSnapshot(adminActor())).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("applies a chapter override only for the actor's chapter", async () => {
    const client = rpcClient((name) => ({ data: ALL[name], error: null }));
    const overrides = [{ organizationIntegrationId: "i-tw", chapterId: "east", status: "disabled" }];
    const store = createSupabaseIntegrationStore(rpcClient((name) => ({ data: name === "list_chapter_integration_overrides" ? overrides : ALL[name], error: null })));
    const east = (await store.getSnapshot(adminActor({ chapterId: "east" }))).data.providers.find((row) => row.provider === "twilio");
    expect(east.chapterOverride).toEqual(overrides[0]);
    const none = (await createSupabaseIntegrationStore(client).getSnapshot(adminActor())).data.providers.find((row) => row.provider === "twilio");
    expect(none.chapterOverride).toBeNull();
  });
});

describe("Supabase store Fireworks connector", () => {
  const validKey = "k".repeat(20);

  it("validates the terms, model name and key before calling the database", async () => {
    const client = okClient({});
    const store = createSupabaseIntegrationStore(client);
    const model = "accounts/fireworks/models/llama-v3";
    for (const input of [
      undefined,
      { model, apiKey: validKey },
      { model, apiKey: validKey, termsAcknowledged: "yes" },
      { model: "gpt-4", apiKey: validKey, termsAcknowledged: true },
      { model: undefined, apiKey: validKey, termsAcknowledged: true },
      { model, apiKey: 1234567890123456, termsAcknowledged: true },
      { model, apiKey: "short", termsAcknowledged: true },
      { model, apiKey: `${validKey} spaced`, termsAcknowledged: true },
    ]) {
      expect(await store.enableFireworksConnector(adminActor(), input)).toEqual({ ok: false, reason: "invalid_input" });
    }
    expect(client.rpc).not.toHaveBeenCalled();
    expect((await store.enableFireworksConnector(adminActor(), { model, apiKey: validKey, termsAcknowledged: true })).ok).toBe(true);
    expect(client.calls[0]).toEqual({ name: "configure_compass_platform_fireworks", args: { p_model: model, p_api_key: validKey, p_terms_acknowledged: true } });
  });

  it("disables the connector and adopts the platform one only with an organization and accepted terms", async () => {
    const client = okClient({});
    const store = createSupabaseIntegrationStore(client);
    expect((await store.disableFireworksConnector()).ok).toBe(true);
    expect(await store.adoptFireworksConnector(undefined, { termsAcknowledged: true })).toEqual({ ok: false, reason: "invalid_input" });
    expect(await store.adoptFireworksConnector(adminActor())).toEqual({ ok: false, reason: "invalid_input" });
    expect(await store.adoptFireworksConnector(adminActor(), { termsAcknowledged: false })).toEqual({ ok: false, reason: "invalid_input" });
    expect((await store.adoptFireworksConnector(adminActor(), { termsAcknowledged: true })).ok).toBe(true);
    expect(client.calls.map((call) => call.name)).toEqual(["disable_compass_platform_fireworks", "adopt_compass_platform_fireworks"]);
    expect(client.calls[1].args).toEqual({ p_organization_id: ORG, p_terms_acknowledged: true });
  });
});

describe("Supabase store provider, job and key operations", () => {
  it("requests, configures and sets status only through validated inputs", async () => {
    const client = okClient({});
    const store = createSupabaseIntegrationStore(client);
    const actor = adminActor();
    expect(await store.requestActivation(actor, { provider: "scim" })).toEqual({ ok: false, reason: "scim_setup_on_scim_tab" });
    expect(await store.requestActivation(actor)).toEqual({ ok: false, reason: "provider_not_activatable" });
    expect(await store.configureProvider(actor)).toEqual({ ok: false, reason: "unknown_provider" });
    expect((await store.configureProvider(actor, { provider: "twilio" })).ok).toBe(true);
    expect(client.calls.at(-1)).toEqual({ name: "set_integration_chapter_controls", args: { p_provider: "twilio", p_enabled: false, p_allowed_chapter_override_keys: [] } });
    expect(await store.setProviderStatus(actor)).toEqual({ ok: false, reason: "invalid_input" });
    expect(await store.setProviderStatus(actor, { provider: "nope", status: "disabled" })).toEqual({ ok: false, reason: "invalid_input" });
    expect(await store.setProviderStatus(actor, { provider: "twilio", status: "connected" })).toEqual({ ok: false, reason: "invalid_input" });
    expect((await store.setProviderStatus(actor, { provider: "twilio", status: "requested" })).ok).toBe(true);
    expect((await store.setChapterOverride(actor, { provider: "twilio", chapterId: "c" })).ok).toBe(true);
    expect(client.calls.at(-1).args).toMatchObject({ p_status: "inherit", p_override_settings: {}, p_credential_ref: null });
    expect((await store.setChapterOverride(actor)).ok).toBe(true);
  });

  it("returns webhook secrets once and refuses a database answer that lacks one", async () => {
    const actor = adminActor();
    const withSecret = createSupabaseIntegrationStore(okClient({ signingSecret: `whsec_${"c".repeat(48)}` }));
    expect((await withSecret.createWebhook(actor, { url: "https://hooks.example.com/a", events: "case.opened" })).signingSecret.shownOnce).toBe(true);
    const noSecret = createSupabaseIntegrationStore(okClient({}));
    expect(await noSecret.createWebhook(actor, { url: "https://hooks.example.com/a", events: ["case.opened"] })).toEqual({ ok: false, reason: "persistence_unavailable" });
    expect(await noSecret.rotateWebhookSecret(actor, { webhookId: "w" })).toEqual({ ok: false, reason: "persistence_unavailable" });
    expect(await noSecret.rotateWebhookSecret(actor)).toEqual({ ok: false, reason: "persistence_unavailable" });
    const failing = createSupabaseIntegrationStore(rpcClient(() => ({ data: null, error: { code: "42501" } })));
    expect(await failing.createWebhook(actor, { url: "https://hooks.example.com/a", events: ["case.opened"] })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await failing.rotateWebhookSecret(actor, { webhookId: "w" })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await withSecret.createWebhook(actor, { events: ["case.opened"] })).toMatchObject({ ok: false, reason: "invalid_url" });
    const rotated = await withSecret.rotateWebhookSecret(actor, { webhookId: "w" });
    expect(rotated.signingSecret.plaintext).toMatch(/^whsec_/);
  });

  it("toggles and deletes webhooks, and issues, rotates and revokes API keys without sending plaintext", async () => {
    const client = okClient({});
    const store = createSupabaseIntegrationStore(client);
    const actor = adminActor();
    await store.toggleWebhook(actor, { webhookId: "w", active: 1 });
    expect(client.calls.at(-1)).toEqual({ name: "set_integration_webhook_active", args: { p_webhook_id: "w", p_active: true } });
    await store.toggleWebhook(actor);
    expect(client.calls.at(-1).args).toEqual({ p_webhook_id: undefined, p_active: false });
    await store.deleteWebhook(actor);
    await store.revokeApiKey(actor);

    expect(await store.issueApiKey(actor)).toEqual({ ok: false, reason: "name_required" });
    expect(await store.issueApiKey(actor, { name: "  " })).toEqual({ ok: false, reason: "name_required" });
    const issued = await store.issueApiKey(actor, { name: "  Export  " });
    expect(issued.secret.plaintext).toMatch(/^ug_live_/);
    expect(client.calls.find((call) => call.name === "create_integration_api_key").args.p_name).toBe("Export");
    const rotated = await store.rotateApiKey(actor, { keyId: "k" });
    expect(rotated.secret.plaintext).toMatch(/^ug_live_/);
    expect(JSON.stringify(client.calls.find((call) => call.name === "rotate_integration_api_key").args)).not.toContain(rotated.secret.plaintext);

    const failing = createSupabaseIntegrationStore(rpcClient(() => ({ data: null, error: { code: "42501" } })));
    expect(await failing.issueApiKey(actor, { name: "Export" })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await failing.rotateApiKey(actor, { keyId: "k" })).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("pages deliveries and jobs, searches recipients, and enqueues jobs with defaults", async () => {
    const client = okClient({ items: [] });
    const store = createSupabaseIntegrationStore(client);
    const actor = adminActor();
    await store.listWebhookDeliveries(actor);
    expect(client.calls.at(-1)).toEqual({ name: "list_integration_webhook_delivery_page", args: { p_limit: 25, p_before_created_at: null, p_before_id: null } });
    await store.listWebhookDeliveries(actor, { beforeCreatedAt: "t", beforeId: "i", limit: 5 });
    expect(client.calls.at(-1).args).toEqual({ p_limit: 5, p_before_created_at: "t", p_before_id: "i" });
    await store.listIntegrationJobs(actor);
    expect(client.calls.at(-1)).toEqual({ name: "list_integration_job_page", args: { p_limit: 100, p_before_created_at: null, p_before_id: null } });
    await store.listIntegrationJobs(actor, { beforeCreatedAt: "t", beforeId: "i", limit: 9 });
    expect(client.calls.at(-1).args).toEqual({ p_limit: 9, p_before_created_at: "t", p_before_id: "i" });
    await store.searchSmsRecipients(actor, "  ana  ");
    expect(client.calls.at(-1)).toEqual({ name: "search_twilio_sms_recipients", args: { p_query: "ana" } });
    await store.searchSmsRecipients(actor);
    expect(client.calls.at(-1).args).toEqual({ p_query: "" });
    await store.enqueueJob(actor);
    expect(client.calls.at(-1)).toEqual({ name: "enqueue_integration_job", args: { p_provider: undefined, p_job_kind: undefined, p_idempotency_key: null } });
    await store.enqueueJob(actor, { provider: "twilio", kind: "provider_health", idempotencyKey: "k1" });
    expect(client.calls.at(-1).args.p_idempotency_key).toBe("k1");
    await store.retryJob(actor);
    expect(client.calls.at(-1).args).toEqual({ p_job_id: undefined });
  });
});

describe("Supabase store SCIM controls", () => {
  it("validates settings, labels and roles before the database is asked", async () => {
    const client = okClient({ id: "t1" });
    const store = createSupabaseIntegrationStore(client);
    const actor = adminActor();
    expect((await store.getScimControl(actor)).ok).toBe(true);
    expect(await store.saveScimSettings(actor)).toEqual({ ok: false, reason: "invalid_input" });
    expect(await store.saveScimSettings(actor, { defaultChapterId: "" })).toEqual({ ok: false, reason: "invalid_input" });
    expect(await store.saveScimSettings(actor, { defaultChapterId: 7 })).toEqual({ ok: false, reason: "invalid_input" });
    expect((await store.saveScimSettings(actor, { defaultChapterId: "c1" })).ok).toBe(true);

    expect(await store.issueScimToken(actor)).toEqual({ ok: false, reason: "name_required" });
    expect(await store.issueScimToken(actor, { label: "l".repeat(81) })).toEqual({ ok: false, reason: "name_required" });
    const issued = await store.issueScimToken(actor, { label: "Okta" });
    expect(issued).toMatchObject({ ok: true, data: { id: "t1" } });
    expect(issued.secret.plaintext).toBeTruthy();
    const issueCall = client.calls.find((call) => call.name === "issue_scim_token");
    expect(JSON.stringify(issueCall.args)).not.toContain(issued.secret.plaintext);

    const failing = createSupabaseIntegrationStore(rpcClient(() => ({ data: null, error: { message: "MFA required" } })));
    expect(await failing.issueScimToken(actor, { label: "Okta" })).toEqual({ ok: false, reason: "mfa_required" });

    expect((await store.revokeScimToken(actor, { tokenId: "t1" })).ok).toBe(true);
    expect(await store.setScimGroupRole(actor, { groupId: "g", role: "owner" })).toEqual({ ok: false, reason: "invalid_input" });
    // #7663: a steward needs a unit, which a directory group cannot supply.
    expect(await store.setScimGroupRole(actor, { groupId: "g", role: "steward" })).toEqual({ ok: false, reason: "invalid_input" });
    expect((await store.setScimGroupRole(actor, { groupId: "g", role: "coordinator" })).ok).toBe(true);
    expect((await store.setScimGroupRole(actor, { groupId: "g" })).ok).toBe(true);
    expect(client.calls.at(-1).args).toEqual({ p_group_id: "g", p_role: null });
  });
});

describe("Supabase store without SSO", () => {
  it("offers no SSO control, domain or admin step and calls no SSO RPC", async () => {
    const client = okClient({ enabled: true });
    const store = createSupabaseIntegrationStore(client);
    for (const name of ["getSsoControl", "saveSsoConnection", "addSsoDomain", "removeSsoDomain", "ssoAdmin"]) expect(store).not.toHaveProperty(name);
    expect(Object.keys(store).filter((name) => /sso/i.test(name))).toEqual([]);
    await store.getSnapshot(adminActor());
    expect(client.calls.filter((call) => /sso/i.test(call.name))).toEqual([]);
  });
});

describe("Supabase store authenticated API boundary", () => {
  function sessionClient(session) {
    return {
      rpc: async () => ({ data: [], error: null }),
      auth: { getSession: vi.fn(session) },
    };
  }

  function stubFetchResponse(response) {
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const SESSION = async () => ({ data: { session: { access_token: "session-token-value" } }, error: null });

  it("has no way to reach the API without a session reader or fetch", async () => {
    const actor = adminActor();
    expect(await createSupabaseIntegrationStore(okClient()).enqueueWebhookDelivery(actor, { webhookId: "w", eventName: "e" })).toEqual({ ok: false, reason: "persistence_unavailable" });
    expect(await createSupabaseIntegrationStore(okClient()).sendSms(actor, { memberId: "m" })).toEqual({ ok: false, reason: "persistence_unavailable" });
    vi.stubGlobal("fetch", undefined);
    const store = createSupabaseIntegrationStore(sessionClient(SESSION));
    expect(await store.enqueueWebhookDelivery(actor, { webhookId: "w", eventName: "e" })).toEqual({ ok: false, reason: "persistence_unavailable" });
    expect(await store.sendSms(actor, { memberId: "m" })).toEqual({ ok: false, reason: "persistence_unavailable" });
  });

  it("answers unauthorized when the session cannot be read or has no token", async () => {
    stubFetchResponse({ ok: true, status: 200, json: async () => ({ ok: true }) });
    const actor = adminActor();
    for (const session of [
      async () => ({ data: null, error: { message: "no session" } }),
      async () => ({ data: { session: null }, error: null }),
      async () => ({ data: { session: { access_token: "" } }, error: null }),
    ]) {
      const store = createSupabaseIntegrationStore(sessionClient(session));
      expect(await store.sendSms(actor, { memberId: "m" })).toEqual({ ok: false, reason: "unauthorized" });
      expect(await store.syncConstantContact(actor)).toEqual({ ok: false, reason: "unauthorized" });
    }
  });

  it("posts the bearer token and returns an ok payload as is", async () => {
    const fetchMock = stubFetchResponse({ ok: true, status: 200, json: async () => ({ ok: true, deliveryId: "d1" }) });
    const store = createSupabaseIntegrationStore(sessionClient(SESSION));
    const actor = adminActor();
    expect(await store.sendSms(actor, { memberId: "m", purpose: "p", body: "b", idempotencyKey: "i" })).toEqual({ ok: true, deliveryId: "d1" });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/twilio-send");
    expect(init.headers.Authorization).toBe("Bearer session-token-value");
    expect(JSON.parse(init.body)).toEqual({ memberId: "m", purpose: "p", body: "b", idempotencyKey: "i" });
    expect(await store.syncConstantContact(actor)).toEqual({ ok: true, deliveryId: "d1" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ action: "sync", limit: 25 });
  });

  it("maps API refusals to bounded reasons", async () => {
    const actor = adminActor();
    const answer = (status, payload, jsonFails = false) => stubFetchResponse({
      ok: status >= 200 && status < 300,
      status,
      json: jsonFails ? async () => { throw new Error("not json"); } : async () => payload,
    });
    const store = createSupabaseIntegrationStore(sessionClient(SESSION));
    const send = () => store.sendSms(actor, { memberId: "m" });

    answer(401, { error: "unauthorized" });
    expect(await send()).toEqual({ ok: false, reason: "unauthorized" });
    answer(403, null);
    expect(await send()).toEqual({ ok: false, reason: "unauthorized" });
    for (const publicReason of ["activation_unset", "provider_not_connected", "invalid_input"]) {
      answer(409, { error: publicReason });
      expect(await send()).toEqual({ ok: false, reason: publicReason });
    }
    answer(500, { error: "stack trace with secrets" });
    expect(await send()).toEqual({ ok: false, reason: "persistence_unavailable" });
    answer(500, null, true);
    expect(await send()).toEqual({ ok: false, reason: "persistence_unavailable" });
    answer(200, { ok: false, reason: "provider_not_connected" });
    expect(await send()).toEqual({ ok: false, reason: "provider_not_connected" });
    answer(200, null);
    expect(await send()).toEqual({ ok: false, reason: "persistence_unavailable" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await send()).toEqual({ ok: false, reason: "persistence_unavailable" });
    const throwingSession = createSupabaseIntegrationStore(sessionClient(async () => { throw new Error("session store down"); }));
    expect(await throwingSession.sendSms(actor, { memberId: "m" })).toEqual({ ok: false, reason: "persistence_unavailable" });
  });

  it("starts Constant Contact OAuth only with the provider's HTTPS authorization URL", async () => {
    const actor = adminActor();
    const answers = [
      [{ ok: false, reason: "activation_unset" }, { ok: false, reason: "activation_unset" }],
      [{ ok: true }, { ok: false, reason: "persistence_unavailable" }],
      [{ ok: true, authorizationUrl: "http://authz.constantcontact.com/x" }, { ok: false, reason: "persistence_unavailable" }],
      [{ ok: true, authorizationUrl: "https://authz.constantcontact.com/oauth2/authorize" }, { ok: true, authorizationUrl: "https://authz.constantcontact.com/oauth2/authorize" }],
    ];
    for (const [payload, expected] of answers) {
      const store = createSupabaseIntegrationStore(okClient(), { apiRequest: async () => payload });
      expect(await store.beginConstantContactOAuth(actor)).toEqual(expected);
    }
  });

  it("never posts to an SSO admin endpoint", async () => {
    const actor = adminActor();
    const store = createSupabaseIntegrationStore(sessionClient(SESSION));
    const fetchMock = stubFetchResponse({ ok: true, status: 200, json: async () => ({ ok: true }) });
    expect(store).not.toHaveProperty("ssoAdmin");
    await store.sendSms(actor, { memberId: "m", purpose: "p", body: "b", idempotencyKey: "i" });
    await store.syncConstantContact(actor);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/twilio-send", "/api/constant-contact-sync"]);
  });
});

describe("database dependency inventory", () => {
  it("lists the session-scope RPCs the helpers call", () => {
    expect(MI1_DATABASE_DEPENDENCIES.sessionScope.rpcs).toEqual(["get_my_chapter_memberships", "get_my_mobile_staff_scope"]);
  });
});
