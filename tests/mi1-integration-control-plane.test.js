// @vitest-environment node
import { describe, expect, it } from "vitest";
import { authorizeOrganizationWrite, canManageIntegrations, createActor } from "../src/features/integrations/authorization.js";
import { INTEGRATION_PROVIDER_CATALOG, defaultProviderRecord } from "../src/features/integrations/catalog.js";
import { resolveEffectiveIntegration } from "../src/features/integrations/controlPlane.js";
import { planProviderJob, summarizeJobHealth, transitionJob } from "../src/features/integrations/jobs.js";
import { createIntegrationControlStore } from "../src/features/integrations/store.js";

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

describe("CR-092 integration control plane", () => {
  it("starts every optional provider unset, SCIM included, and keeps SCIM on its own setup surface", () => {
    expect(defaultProviderRecord("twilio").status).toBe("unset");
    expect(defaultProviderRecord("google_calendar").status).toBe("unset");
    expect(defaultProviderRecord("twilio")).toMatchObject({
      status: "unset",
      capabilities: ["sms:send", "sms:status", "sms:consent"],
      allowChapterOwnedAccounts: false,
    });
    // Union Ground collects no dues: there is no Stripe dues provider and no
    // payments category to activate.
    expect(defaultProviderRecord("stripe_dues")).toBeNull();
    expect(INTEGRATION_PROVIDER_CATALOG).not.toHaveProperty("stripe_dues");
    expect(Object.values(INTEGRATION_PROVIDER_CATALOG).map((entry) => entry.category)).not.toContain("payments");
    expect(Object.values(INTEGRATION_PROVIDER_CATALOG).flatMap((entry) => entry.capabilities).filter((capability) => capability.startsWith("dues:"))).toEqual([]);
    expect(defaultProviderRecord("scim").status).toBe("unset");
    expect(INTEGRATION_PROVIDER_CATALOG.scim).toMatchObject({ activation: "scim_tab", setupSurface: "scim" });
  });

  it("does not promote explicitly chapter-only roles into organization integration authority", () => {
    expect(canManageIntegrations(createActor({
      userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      selectedOrganizationId: ORG_A,
      roles: ["admin"],
      organizationRoles: [],
      chapterRoles: ["admin"],
      selectedHat: "admin",
      membershipStatus: "active",
      mfaSatisfied: true,
    }))).toBe(false);
  });

  it("resolves chapter overrides only when the organization allows them", () => {
    const organization = {
      id: "int-1",
      organizationId: ORG_A,
      provider: "twilio",
      status: "configured",
      accountOwner: "organization",
      capabilities: ["sms:send"],
      allowChapterOverrides: true,
      allowChapterOwnedAccounts: false,
      allowedChapterOverrideKeys: ["fromNumber"],
      defaultSettings: { fromNumber: "org", statusCallback: true },
      credentialRef: "vault:org-twilio",
    };
    const chapter = {
      id: "ovr-1",
      organizationIntegrationId: "int-1",
      chapterId: "chapter-east",
      status: "enabled",
      accountOwner: "chapter",
      overrideSettings: { fromNumber: "chapter", statusCallback: false },
      credentialRef: "vault:chapter-twilio",
    };

    expect(resolveEffectiveIntegration(organization, null).settings).toEqual({
      fromNumber: "org",
      statusCallback: true,
    });
    expect(resolveEffectiveIntegration(organization, chapter).settings).toEqual({
      fromNumber: "chapter",
      statusCallback: true,
    });
    expect(resolveEffectiveIntegration(organization, { ...chapter, status: "disabled" }).enabled).toBe(false);
    expect(resolveEffectiveIntegration({ ...organization, allowChapterOverrides: false }, { ...chapter, status: "disabled" }).enabled).toBe(true);
    expect(resolveEffectiveIntegration(organization, chapter).accountOwner).toBe("organization");
    expect(resolveEffectiveIntegration({ ...organization, allowChapterOwnedAccounts: true }, chapter).credentialRef).toBe("vault:chapter-twilio");
  });

  it("refuses jobs for SCIM and unknown kinds, and skips unset providers", async () => {
    expect(planProviderJob({ provider: "scim", kind: "provider_health" }).reason).toBe("scim_setup_on_scim_tab");
    expect(planProviderJob({ provider: "twilio", kind: "stripe_charge" }).reason).toBe("unknown_job_kind");

    const store = createIntegrationControlStore();
    const actor = admin();
    const queued = store.enqueueJob(actor, { provider: "twilio", kind: "provider_health", idempotencyKey: "health-1" });
    expect(queued.ok).toBe(true);
    expect(queued.plan.liveNetwork).toBe(false);
    expect(queued.plan.credentialRefPresent).toBe(false);
    const replay = store.enqueueJob(actor, { provider: "twilio", kind: "provider_health", idempotencyKey: "health-1" });
    expect(replay.replayed).toBe(true);

    const ran = await store.runNextJob(actor);
    expect(ran.skipped).toBe(true);
    expect(ran.job.status).toBe("skipped");
    expect(ran.job.errorCode).toBe("activation_unset");
  });

  it("keeps job transitions and health organization-local", () => {
    const job = {
      status: "queued",
      attemptCount: 1,
      processedCount: 0,
      startedAt: null,
      provider: "twilio",
    };
    expect(transitionJob(job, "running", { now: "t1" }).job.status).toBe("running");
    expect(transitionJob({ ...job, status: "success" }, "queued").ok).toBe(false);
    expect(summarizeJobHealth([
      { provider: "twilio", status: "queued" },
      { provider: "twilio", status: "failed" },
    ]).twilio).toEqual({ queued: 1, running: 0, success: 0, failed: 1, skipped: 0, dead: 0 });
  });

  it("covers the complete bounded job plan and transition contract", () => {
    expect(planProviderJob({ provider: "unknown", kind: "provider_health" }).reason).toBe("unknown_provider");
    expect(planProviderJob({
      provider: "twilio",
      kind: "connection_probe",
      credentialRef: "vault:twilio",
      settings: {
        region: "us-east",
        timeout: 30,
        enabled: true,
        secretToken: "must-not-leak",
        nested: { ignored: true },
        oversized: "x".repeat(81),
      },
    }).plan).toEqual({
      provider: "twilio",
      kind: "connection_probe",
      settings: { region: "us-east", timeout: 30, enabled: true },
      credentialRefPresent: true,
      liveNetwork: false,
    });
    expect(planProviderJob({ provider: "twilio", kind: "provider_health", settings: [] }).plan.settings).toEqual({});

    const failed = {
      status: "failed",
      attemptCount: 1,
      processedCount: 0,
      startedAt: "t0",
      provider: "twilio",
    };
    expect(transitionJob(failed, "not-a-status").reason).toBe("unknown_status");
    expect(transitionJob(failed, "queued", { now: "t1" }).job.attemptCount).toBe(2);
    expect(transitionJob(failed, "dead", { now: "t2", errorCode: "retry_exhausted" }).job.finishedAt).toBe("t2");
    expect(transitionJob({ ...failed, status: "running" }, "success", { now: "t3", processedCount: 2 }).job).toMatchObject({
      status: "success",
      processedCount: 2,
      finishedAt: "t3",
    });
    expect(summarizeJobHealth([{ provider: "twilio", status: "skipped" }]).twilio).toEqual({
      queued: 0,
      running: 0,
      success: 0,
      failed: 0,
      skipped: 1,
      dead: 0,
    });
  });

  it("denies members, other organizations, and missing MFA", () => {
    const member = createActor({
      userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      selectedOrganizationId: ORG_A,
      roles: ["steward"],
      membershipStatus: "active",
      mfaSatisfied: true,
    });
    expect(canManageIntegrations(member)).toBe(false);

    const noMfa = createActor({
      userId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      selectedOrganizationId: ORG_A,
      roles: ["admin"],
      membershipStatus: "active",
      mfaSatisfied: false,
    });
    expect(canManageIntegrations(noMfa)).toBe(false);

    const multiRoleWrongHat = createActor({
      userId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      selectedOrganizationId: ORG_A,
      roles: ["steward", "admin"],
      selectedHat: "steward",
      membershipStatus: "active",
      mfaSatisfied: true,
    });
    expect(canManageIntegrations(multiRoleWrongHat)).toBe(false);
    expect(canManageIntegrations({ ...multiRoleWrongHat, selectedHat: "admin" })).toBe(true);

    const actor = admin(ORG_A);
    expect(authorizeOrganizationWrite(actor, ORG_B).reason).toBe("cross_organization_denied");

    const store = createIntegrationControlStore();
    expect(store.configureProvider(member, { provider: "twilio" }).reason).toBe("unauthorized");
    expect(store.getSnapshot(admin(ORG_B)).data.webhooks).toEqual([]);
    expect(store.requestActivation(actor, { provider: "twilio" }).ok).toBe(true);
    expect(store.getSnapshot(admin(ORG_B)).data.providers.find((row) => row.provider === "twilio").status).toBe("unset");
  });

  it("applies chapter overrides only after the organization opts in", () => {
    const store = createIntegrationControlStore({
      chapterBelongsToOrganization: (chapterId, organizationId) => chapterId === "east" && organizationId === ORG_A,
    });
    const actor = admin();
    expect(store.setChapterOverride(actor, { provider: "twilio", chapterId: "east", status: "disabled" }).reason).toBe("chapter_overrides_disabled");
    expect(store.configureProvider(actor, { provider: "twilio", allowChapterOverrides: true }).ok).toBe(true);
    expect(store.setChapterOverride(actor, { provider: "twilio", chapterId: "west", status: "disabled" }).reason).toBe("chapter_scope_denied");
    const override = store.setChapterOverride(actor, { provider: "twilio", chapterId: "east", status: "disabled" });
    expect(override.ok).toBe(true);
    expect(override.effective.chapterId).toBe("east");
    expect(override.effective.enabled).toBe(false);
    const updated = store.setChapterOverride(actor, {
      provider: "twilio",
      chapterId: "east",
      status: "enabled",
      overrideSettings: { fromNumber: "chapter" },
    });
    expect(updated.override).toMatchObject({ status: "enabled", overrideSettings: { fromNumber: "chapter" } });
  });

  it("returns a chapter's saved Twilio sending number in that chapter's snapshot", () => {
    const store = createIntegrationControlStore({
      chapterBelongsToOrganization: (chapterId, organizationId) => chapterId === "east" && organizationId === ORG_A,
    });
    const actor = admin();
    expect(store.configureProvider(actor, {
      provider: "twilio",
      allowChapterOverrides: true,
      allowedChapterOverrideKeys: ["fromNumber"],
      defaultSettings: { fromNumber: "+15550000000" },
    }).ok).toBe(true);
    expect(store.setChapterOverride(actor, {
      provider: "twilio",
      chapterId: "east",
      status: "enabled",
      overrideSettings: { fromNumber: "+15551230100" },
    }).ok).toBe(true);
    const east = store.getSnapshot({ ...actor, chapterId: "east" }).data.providers.find((row) => row.provider === "twilio");
    expect(east.chapterOverride).toMatchObject({ status: "enabled", overrideSettings: { fromNumber: "+15551230100" } });
    expect(east.effective.settings.fromNumber).toBe("+15551230100");
    const orgWide = store.getSnapshot(actor).data.providers.find((row) => row.provider === "twilio");
    expect(orgWide.chapterOverride).toBeNull();
    expect(orgWide.effective.settings.fromNumber).toBe("+15550000000");
  });

  it("runs configured provider jobs and exposes bounded catalogs", async () => {
    const store = createIntegrationControlStore();
    const actor = admin();
    expect((await store.runNextJob(actor)).reason).toBe("no_queued_job");
    expect(store.configureProvider(actor, { provider: "twilio" }).ok).toBe(true);
    const queued = store.enqueueJob(actor, { provider: "twilio", kind: "provider_health" });
    expect((await store.runNextJob(actor)).job).toMatchObject({ id: queued.job.id, status: "success", processedCount: 1 });
    expect(store.listWebhookEvents()).toContain("case.opened");
    expect(store.listJobKinds()).toContain("provider_health");
    expect(store.retryJob(actor, { jobId: "missing" }).reason).toBe("job_not_found");
    expect(store.retryJob(actor, { jobId: queued.job.id }).reason).toBe("illegal_transition");
  });
});
