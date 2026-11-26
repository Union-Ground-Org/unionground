// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  authorizeAccessHistory,
  createAccessHistory,
  createMemoryAccessCatalog,
} from "../src/features/accessHistory/index.js";

function actor(overrides = {}) {
  return {
    userId: "member-a",
    selectedOrganizationId: "org-a",
    membershipStatus: "active",
    roles: [],
    ...overrides,
  };
}

describe("member access history isolation", () => {
  it("lets a member read only their own events", () => {
    const catalog = createMemoryAccessCatalog();
    const steward = actor({ userId: "steward-1", roles: ["steward"] });
    catalog.record(steward, {
      organizationId: "org-a",
      subjectUserId: "member-a",
      actorLabel: "Sam",
      actorRole: "steward",
      action: "viewed_case",
      entityType: "case",
      entityId: "case-1",
      occurredAt: "2026-08-20T12:00:00.000Z",
    });
    catalog.record(steward, {
      organizationId: "org-a",
      subjectUserId: "member-b",
      actorLabel: "Sam",
      actorRole: "steward",
      action: "viewed_profile",
      entityType: "member",
      occurredAt: "2026-08-20T13:00:00.000Z",
    });

    const own = createAccessHistory({ actor: actor(), catalog }).listOwn();
    expect(own.ok).toBe(true);
    expect(own.events).toHaveLength(1);
    expect(own.events[0].subjectUserId).toBe("member-a");
    expect(own.events[0].action).toBe("viewed_case");

    const otherOrg = createAccessHistory({
      actor: actor({ selectedOrganizationId: "org-b" }),
      catalog,
    }).listOwn();
    expect(otherOrg.ok).toBe(true);
    expect(otherOrg.events).toEqual([]);
    expect(authorizeAccessHistory({
      actor: actor({ selectedOrganizationId: "org-b" }),
      organizationId: "org-a",
      capability: "read_own",
    }).reason).toBe("wrong_organization");
  });

  it("forbids members from recording and forbids self-access rows", () => {
    const catalog = createMemoryAccessCatalog();
    expect(createAccessHistory({ actor: actor(), catalog }).record({
      subjectUserId: "member-b",
      action: "viewed_profile",
      entityType: "member",
      occurredAt: "2026-08-20T12:00:00.000Z",
    }).reason).toBe("unauthorized");

    expect(authorizeAccessHistory({
      actor: actor({ userId: "steward-1", roles: ["steward"] }),
      organizationId: "org-a",
      capability: "record",
      subjectUserId: "steward-1",
    }).reason).toBe("invalid_input");
  });
});
