import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { featureActorIdentityKey } from "../src/lib/featureActorIdentity.js";

const actor = {
  userId: "user-a",
  organizationId: "org-a",
  selectedOrganizationId: "org-a",
  chapterId: "chapter-a",
  selectedHat: "admin",
  roles: ["admin"],
  organizationRoles: ["admin"],
  chapterRoles: [],
  membershipStatus: "active",
  mfaSatisfied: true,
};

describe("featureActorIdentityKey", () => {
  it("is stable for structurally equal actors and changes with authorization identity", () => {
    expect(featureActorIdentityKey({ ...actor, roles: [...actor.roles] }))
      .toBe(featureActorIdentityKey({ ...actor, organizationRoles: ["admin"] }));
    expect(featureActorIdentityKey({ ...actor, userId: "user-b" }))
      .not.toBe(featureActorIdentityKey(actor));
    expect(featureActorIdentityKey({ ...actor, selectedHat: "steward" }))
      .not.toBe(featureActorIdentityKey(actor));
    // The ambient organizationId only matters when no organization is selected.
    const { selectedOrganizationId: _unselected, ...ambient } = actor;
    expect(featureActorIdentityKey({ ...ambient, organizationId: "org-b" }))
      .not.toBe(featureActorIdentityKey(ambient));
  });

  it("follows the normalizer precedence for organization scope and role authority", () => {
    // The selected organization wins even when the ambient organizationId is unchanged.
    expect(featureActorIdentityKey({ ...actor, selectedOrganizationId: "org-b" }))
      .not.toBe(featureActorIdentityKey(actor));
    // organizationRoles is authoritative: a revocation hidden inside a stable roles list still reloads.
    expect(featureActorIdentityKey({ ...actor, organizationRoles: [] }))
      .not.toBe(featureActorIdentityKey(actor));
    expect(featureActorIdentityKey({ ...actor, organizationRoles: ["admin", "steward"] }))
      .not.toBe(featureActorIdentityKey(actor));
    // Without an organizationRoles list the flattened roles list is the fallback.
    const { organizationRoles: _omit, ...withoutOrganizationRoles } = actor;
    expect(featureActorIdentityKey({ ...withoutOrganizationRoles, roles: ["admin"] }))
      .not.toBe(featureActorIdentityKey({ ...withoutOrganizationRoles, roles: [] }));
    // Chapter roles are keyed on their own.
    expect(featureActorIdentityKey({ ...actor, chapterRoles: ["steward"] }))
      .not.toBe(featureActorIdentityKey(actor));
  });

  it("keys every identity field with its documented fallback", () => {
    // No actor at all is a stable, non-throwing key.
    expect(featureActorIdentityKey(undefined)).toBe(featureActorIdentityKey(null));
    // `id` stands in for userId; a non-array roles value counts as no roles.
    expect(featureActorIdentityKey({ id: "user-c", roles: "admin" }))
      .toBe(featureActorIdentityKey({ userId: "user-c" }));
    // The MFA booleans are keyed only when strictly true.
    expect(featureActorIdentityKey({ userId: "u", requireStaffMfa: "yes", hasSecondFactor: 1, mfaSatisfied: "true" }))
      .toBe(featureActorIdentityKey({ userId: "u" }));
    expect(featureActorIdentityKey({ userId: "u", requireStaffMfa: true }))
      .not.toBe(featureActorIdentityKey({ userId: "u" }));
    expect(featureActorIdentityKey({ userId: "u", hasSecondFactor: true }))
      .not.toBe(featureActorIdentityKey({ userId: "u" }));
    // Chapter and membership status participate when present.
    expect(featureActorIdentityKey({ userId: "u", chapterId: "c1" }))
      .not.toBe(featureActorIdentityKey({ userId: "u" }));
    expect(featureActorIdentityKey({ userId: "u", membershipStatus: "active" }))
      .not.toBe(featureActorIdentityKey({ userId: "u" }));
    // Role names are de-duplicated, stringified and sorted.
    expect(featureActorIdentityKey({ userId: "u", organizationRoles: ["b", "a", "a"] }))
      .toBe(featureActorIdentityKey({ userId: "u", organizationRoles: ["a", "b"] }));
  });

  it("App.jsx rebuilds mi1Actor only when featureActorIdentityKey changes", () => {
    const source = readFileSync("src/App.jsx", "utf8");
    expect(source).toMatch(/const mi1ActorKey = featureActorIdentityKey\(mi1ActorSource\)/);
    expect(source).toMatch(/if \(mi1ActorKeyRef\.current !== mi1ActorKey\)/);
    expect(source).toMatch(/mi1ActorRef\.current = buildMi1FeatureActor\(mi1ActorSource\)/);
    expect(source).toMatch(/const mi1Actor = mi1ActorRef\.current/);
  });
});
