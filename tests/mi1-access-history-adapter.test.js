// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { latestFnBody } from "./helpers/migration.js";
import {
  ACCESS_ACTIONS,
  ACCESS_ENTITY_TYPES,
  RECORDABLE_ACCESS_ACTIONS,
  RECORDABLE_ACCESS_ENTITY_TYPES,
  normalizeAccessEvent,
} from "../src/features/accessHistory/event.js";
import {
  ACCESS_FAILURE_REASONS,
  accessFailure,
  createAccessCatalogFromRpcPayload,
  createAccessHistory,
  createAccessRpcAdapter,
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

const valid = {
  organizationId: "org-a",
  subjectUserId: "member-a",
  actorUserId: "steward-1",
  actorRole: "steward",
  actorLabel: "Sam",
  action: "viewed_case",
  entityType: "case",
  entityId: "case-1",
  occurredAt: "2026-08-20T12:00:00.000Z",
};

describe("access history adapter, events, and errors", () => {
  it("rejects invalid normalizeAccessEvent inputs", () => {
    expect(normalizeAccessEvent(null)).toBeNull();
    expect(normalizeAccessEvent({ ...valid, action: "nope" })).toBeNull();
    expect(normalizeAccessEvent({ ...valid, entityType: "nope" })).toBeNull();
    expect(normalizeAccessEvent({ ...valid, organizationId: "" })).toBeNull();
    expect(normalizeAccessEvent({ ...valid, actorLabel: `Sam${String.fromCharCode(64)}example.org` })).toBeNull();
    expect(normalizeAccessEvent({ ...valid, subjectUserId: String.fromCharCode(7) })).toBeNull();
    expect(normalizeAccessEvent({
      ...valid,
      subjectUserId: "steward-1",
      actorUserId: "steward-1",
    })).toBeNull();
    const saved = normalizeAccessEvent({
      ...valid,
      id: " access-1 ",
      entityId: "",
      actorUserId: "",
    });
    expect(saved).toMatchObject({
      id: "access-1",
      actorUserId: "staff",
      entityId: null,
    });
  });

  it("exports failure reasons and catalog helpers", () => {
    expect(ACCESS_FAILURE_REASONS).toContain("catalog_unavailable");
    expect(accessFailure("invalid_input", { field: "event" })).toEqual({
      ok: false,
      reason: "invalid_input",
      details: { field: "event" },
    });
  });

  it("covers memory catalog list and record paths", () => {
    const catalog = createMemoryAccessCatalog([
      valid,
      { ...valid, id: "old-access", occurredAt: "2026-05-01T12:00:00.000Z" },
      { action: "invalid" },
    ]);
    const steward = actor({ userId: "steward-1", roles: ["steward"] });
    const listed = catalog.listOwn(actor());
    expect(listed.ok).toBe(true);
    expect(listed.events).toHaveLength(2);
    expect(catalog.listOwn(actor(), { rangeDays: 365, since: "2025-08-28T12:00:00.000Z" }).events).toHaveLength(2);
    expect(catalog.listOwn(actor(), { rangeDays: 30, since: "2026-07-29T12:00:00.000Z" }).events).toHaveLength(1);
    expect(catalog.listOwn(actor(), { since: "2026-08-21T00:00:00.000Z" }).events).toEqual([]);
    expect(catalog.record(steward, { title: "nope" }).reason).toBe("invalid_input");
    expect(catalog.record(actor(), valid).reason).toBe("unauthorized");
    expect(catalog.record(steward, {
      ...valid,
      subjectUserId: "member-b",
      action: "updated_profile",
      entityType: "member",
    }).ok).toBe(true);
    const tools = createAccessHistory({ actor: steward, catalog });
    expect(Object.keys(tools).sort()).toEqual(["catalog", "listOwn", "record"]);
    expect(tools.record({ ...valid, subjectUserId: "member-c" }).ok).toBe(true);
    expect(createAccessHistory({ actor: actor(), catalog }).record(valid).reason).toBe("unauthorized");
    catalog.clear();
    expect(catalog.listOwn(actor()).events).toEqual([]);
  });

  it("keeps valid RPC rows when a sibling row fails normalizeAccessEvent", () => {
    const validViewedCaseRow = { ...valid, id: "access-valid" };
    const mixed = createAccessCatalogFromRpcPayload([
      validViewedCaseRow,
      { ...validViewedCaseRow, id: "x", actorLabel: "Pat@union" },
    ]);
    expect(mixed.ok).toBe(true);
    expect(mixed.events).toHaveLength(1);
    expect(mixed.events[0].id).toBe(validViewedCaseRow.id);
    expect(mixed.catalog.listOwn(actor()).events).toEqual([
      expect.objectContaining({ id: validViewedCaseRow.id }),
    ]);

    const empty = createAccessCatalogFromRpcPayload([{ action: "bad" }]);
    expect(empty).toMatchObject({ ok: true, events: [] });
    expect(empty.events).toHaveLength(0);

    expect(createAccessCatalogFromRpcPayload(null)).toEqual({
      ok: false,
      reason: "catalog_unavailable",
    });
    expect(createAccessCatalogFromRpcPayload(undefined)).toEqual({
      ok: false,
      reason: "catalog_unavailable",
    });
  });

  it("builds catalogs from RPC payloads and talks to the RPC adapter", async () => {
    expect(createAccessCatalogFromRpcPayload(null).reason).toBe("catalog_unavailable");
    expect(createAccessCatalogFromRpcPayload([{ action: "bad" }])).toMatchObject({
      ok: true,
      events: [],
    });
    const loaded = createAccessCatalogFromRpcPayload([{ ...valid, id: "access-1" }]);
    expect(loaded.ok).toBe(true);
    expect(loaded.events).toHaveLength(1);

    const rpc = vi.fn(async (name) => {
      if (name === "list_my_access_history") return { data: [{ ...valid, id: "access-1" }], error: null };
      if (name === "record_member_access_event") return { data: { ok: true }, error: null };
      throw new Error("unknown");
    });
    const adapter = createAccessRpcAdapter({ rpc });
    expect((await adapter.listOwn(30)).ok).toBe(true);
    expect((await adapter.record(actor({ userId: "steward-1", roles: ["steward"] }), {
      subjectUserId: "member-a",
      action: "viewed_profile",
      entityType: "member",
    })).ok).toBe(true);

    const failing = createAccessRpcAdapter({ rpc: async () => ({ data: null, error: new Error("down") }) });
    expect((await failing.listOwn()).reason).toBe("catalog_unavailable");
    expect((await createAccessRpcAdapter({}).listOwn()).reason).toBe("catalog_unavailable");
    expect((await createAccessRpcAdapter({
      rpc: async () => { throw new Error("boom"); },
    }).listOwn()).reason).toBe("catalog_unavailable");
    expect((await adapter.record(actor(), valid)).reason).toBe("unauthorized");
  });

  it("keeps the RPC's 42501 MFA refusal under its own reason", async () => {
    // BUG-UG-ACCESS-HISTORY-MFA-ERROR-SHOWN-AS-RETRY-20260920
    const mfa = createAccessRpcAdapter({
      rpc: async () => ({ data: null, error: { code: "42501", message: "mfa required" } }),
    });
    expect(await mfa.listOwn(30)).toEqual({ ok: false, reason: "mfa_required" });
    expect(ACCESS_FAILURE_REASONS).toContain("mfa_required");
    const otherDenial = createAccessRpcAdapter({
      rpc: async () => ({ data: null, error: { code: "42501", message: "not authorized" } }),
    });
    expect((await otherDenial.listOwn()).reason).toBe("catalog_unavailable");
    const mfaWordingOtherCode = createAccessRpcAdapter({
      rpc: async () => ({ data: null, error: { code: "P0001", message: "mfa required" } }),
    });
    expect((await mfaWordingOtherCode.listOwn()).reason).toBe("catalog_unavailable");
  });

  it("refuses role-grant writes on both record paths while reads keep them", async () => {
    const steward = actor({ userId: "steward-1", roles: ["steward"] });
    const roleGrantWrites = [
      { action: "granted_role", entityType: "role_grant" },
      { action: "revoked_role", entityType: "role_grant" },
      { action: "granted_role", entityType: "member" },
      { action: "viewed_profile", entityType: "role_grant" },
    ];

    const catalog = createMemoryAccessCatalog();
    for (const write of roleGrantWrites) {
      expect(catalog.record(steward, { ...valid, subjectUserId: "member-b", ...write })).toEqual({
        ok: false,
        reason: "invalid_input",
        details: { field: "event" },
      });
    }
    expect(catalog.listOwn(actor({ userId: "member-b" })).events).toEqual([]);

    const rpc = vi.fn(async () => ({ data: { ok: true }, error: null }));
    const adapter = createAccessRpcAdapter({ rpc });
    for (const write of roleGrantWrites) {
      expect((await adapter.record(steward, { subjectUserId: "member-a", ...write })).reason).toBe("invalid_input");
    }
    expect(rpc).not.toHaveBeenCalled();

    const roleRows = createAccessCatalogFromRpcPayload([
      { ...valid, id: "grant-1", action: "granted_role", entityType: "role_grant", entityId: "grant-1" },
      { ...valid, id: "revoke-1", action: "revoked_role", entityType: "role_grant", entityId: "grant-1" },
    ]);
    expect(roleRows.events.map((row) => row.action)).toEqual(["granted_role", "revoked_role"]);
    expect(roleRows.catalog.listOwn(actor()).events).toHaveLength(2);
  });

  it("pins the client write vocabulary to record_member_access_event", () => {
    // The live definition, not the first one: the RPC has been redefined since.
    const body = latestFnBody("record_member_access_event");
    const literals = (pattern) => {
      const match = body.match(pattern);
      expect(match).not.toBeNull();
      return [...match[1].matchAll(/'([a-z_]+)'/g)].map((literal) => literal[1]);
    };
    expect(literals(/p_action not in \(([^)]*)\)/)).toEqual([...RECORDABLE_ACCESS_ACTIONS]);
    expect(literals(/p_entity_type not in \(([^)]*)\)/)).toEqual([...RECORDABLE_ACCESS_ENTITY_TYPES]);
    for (const action of RECORDABLE_ACCESS_ACTIONS) expect(ACCESS_ACTIONS).toContain(action);
    for (const entityType of RECORDABLE_ACCESS_ENTITY_TYPES) expect(ACCESS_ENTITY_TYPES).toContain(entityType);
  });
});
