// @vitest-environment node
//
// CR-094 SCIM custody, restored as live directory provisioning by
// REQ-UG-SCIM-PROVISIONING-20261001. The
// enterprise-later ship gate became the organization switch
// features.integrations.scim (default off), enforced by the database.
import { describe, expect, it, vi } from "vitest";
import { createActor } from "../src/features/integrations/authorization.js";
import {
  SCIM_GENERIC_PROVIDER_REASON,
  SCIM_PROTOCOL_VERSION,
  SCIM_SWITCH_KEY,
  SCIM_TOKEN_LIFETIME_DAYS,
  buildScimTokenCustody,
  evaluateScimMutation,
  getScimControlSurface,
  matchScimBearer,
  scimEndpointUrl,
  scimSetupSteps,
} from "../src/features/integrations/scim.js";
import { createIntegrationControlStore } from "../src/features/integrations/store.js";
import { createSupabaseIntegrationStore, createUnsetIntegrationStore } from "../src/lib/mi1FeatureWiring.js";

const ORG_A = "11111111-1111-4111-8111-111111111111";

function admin() {
  return createActor({
    userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    selectedOrganizationId: ORG_A,
    roles: ["admin"],
    membershipStatus: "active",
    mfaSatisfied: true,
  });
}

describe("SCIM directory provisioning control surface", () => {
  it("names the organization switch and the invitation-only protocol", () => {
    const surface = getScimControlSurface();
    expect(surface.switchKey).toBe(SCIM_SWITCH_KEY);
    expect(SCIM_SWITCH_KEY).toBe("features.integrations.scim");
    expect(surface.protocol.version).toBe(SCIM_PROTOCOL_VERSION);
    expect(surface.protocol.resources).toEqual(["Users", "Groups"]);
    expect(surface.protocol.provisioning).toContain("invitation");
    expect(surface.protocol.deprovision).toContain("never deleted");
    expect(scimEndpointUrl("https://example.org/")).toBe("https://example.org/scim/v2");
  });

  it("keeps SCIM out of the generic provider controls", () => {
    expect(evaluateScimMutation().reason).toBe(SCIM_GENERIC_PROVIDER_REASON);
    const store = createIntegrationControlStore();
    const actor = admin();
    expect(store.requestActivation(actor, { provider: "scim" }).reason).toBe(SCIM_GENERIC_PROVIDER_REASON);
    expect(store.enqueueJob(actor, { provider: "scim", kind: "provider_health" }).reason).toBe(SCIM_GENERIC_PROVIDER_REASON);
    expect(store.getSnapshot(actor).data.providers.find((row) => row.provider === "scim").status).toBe("unset");
  });

  it("proves hashed one-time token custody with the old 90-day lifetime", async () => {
    const custody = await buildScimTokenCustody();
    expect(custody.oneTime.plaintext).toMatch(/^ug_scim_[0-9a-f]{48}$/);
    expect(custody.storage.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(custody.storage.tokenPrefix).toMatch(/^ug_scim_[0-9a-f]{4}$/);
    expect(custody.storage.expiresInDays).toBe(SCIM_TOKEN_LIFETIME_DAYS);
    expect(SCIM_TOKEN_LIFETIME_DAYS).toBe(90);
    expect(JSON.stringify(custody.storage)).not.toContain(custody.oneTime.plaintext);
    expect(await matchScimBearer(custody.oneTime.plaintext, custody.storage.tokenHash)).toBe(true);
    expect(await matchScimBearer("ug_scim_deadbeef", custody.storage.tokenHash)).toBe(false);
  });

  it("marks setup steps done only from server state", () => {
    expect(scimSetupSteps(null).map((step) => step.done)).toEqual([false, false, false, false, false]);
    const steps = scimSetupSteps({
      enabled: true,
      defaultChapterId: "ewl1-a",
      tokens: [{ id: "t", revokedAt: null, expiresAt: "2999-01-01T00:00:00Z" }, { id: "r", revokedAt: "2026-01-01T00:00:00Z" }],
      groups: [{ id: "g", mappedRole: "steward" }],
      users: { total: 3 },
    });
    expect(steps.map((step) => [step.id, step.done])).toEqual([["switch", true], ["chapter", true], ["token", true], ["provider", true], ["roles", true]]);
    expect(scimSetupSteps({ tokens: [{ revokedAt: null, expiresAt: "2000-01-01T00:00:00Z" }] })[2].done).toBe(false);
  });
});

describe("SCIM store wiring", () => {
  it("issues a token by sending only its digest and returns the plaintext once", async () => {
    const rpc = vi.fn(async () => ({ data: { enabled: true, tokens: [] }, error: null }));
    const store = createSupabaseIntegrationStore({ rpc });
    const result = await store.issueScimToken(admin(), { label: " Okta production " });
    expect(result.ok).toBe(true);
    expect(result.secret.plaintext).toMatch(/^ug_scim_[0-9a-f]{48}$/);
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe("issue_scim_token");
    expect(args).toMatchObject({ p_label: "Okta production", p_expires_in_days: 90 });
    expect(args.p_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(args)).not.toContain(result.secret.plaintext);
  });

  it("maps the database refusals to SCIM reasons and validates roles locally", async () => {
    const refusal = (message, code = "P0001") => vi.fn(async () => ({ data: null, error: { message, code } }));
    expect((await createSupabaseIntegrationStore({ rpc: refusal("scim provisioning is switched off") }).issueScimToken(admin(), { label: "x" })).reason).toBe("scim_switched_off");
    expect((await createSupabaseIntegrationStore({ rpc: refusal("scim default chapter required") }).issueScimToken(admin(), { label: "x" })).reason).toBe("scim_no_default_chapter");
    expect((await createSupabaseIntegrationStore({ rpc: refusal("too many live scim tokens") }).issueScimToken(admin(), { label: "x" })).reason).toBe("scim_token_limit");
    expect((await createSupabaseIntegrationStore({ rpc: refusal("mfa required", "42501") }).getScimControl(admin())).reason).toBe("mfa_required");
    const rpc = vi.fn();
    const store = createSupabaseIntegrationStore({ rpc });
    expect(store.setScimGroupRole(admin(), { groupId: "g", role: "admin" }).reason).toBe("invalid_input");
    expect(store.saveScimSettings(admin(), {}).reason).toBe("invalid_input");
    expect((await store.issueScimToken(admin(), { label: "  " })).reason).toBe("name_required");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("denies every SCIM action without a live backend", () => {
    const unset = createUnsetIntegrationStore();
    for (const action of ["getScimControl", "saveScimSettings", "issueScimToken", "revokeScimToken", "setScimGroupRole"]) {
      expect(unset[action]().ok).toBe(false);
    }
  });
});
