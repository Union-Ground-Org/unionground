// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  AUDIT_DOMAINS,
  AUDIT_EVENT_TYPES,
  AUDIT_METADATA_MAX_BYTES,
  assertAuditImmutable,
  catalogCoverage,
  createAuditEvent,
  looksLikeRowImage,
  projectMemberAdminAuditRow,
  projectOrganizationAuditEventRow,
  projectUnifiedAudit,
  sanitizeAuditMetadata,
} from "../src/features/operations/index.js";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function validEvent(overrides = {}) {
  return createAuditEvent({
    organizationId: ORG_A,
    domain: "membership",
    eventType: "role.granted",
    action: "grant",
    actorUserId: ACTOR,
    entityType: "role_grant",
    entityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    occurredAt: "2026-08-22T12:00:00.000Z",
    idempotencyKey: KEY,
    metadata: { organizationId: ORG_A, role: "steward" },
    ...overrides,
  });
}

describe("CR-106 audit envelope integrity", () => {
  it("covers every audited high-risk domain with a closed event catalog", () => {
    expect(AUDIT_DOMAINS).toEqual(expect.arrayContaining([
      "administration",
      "casework",
      "messages",
      "data_access",
      "community_events",
      "security",
    ]));
    const coverage = catalogCoverage();
    expect(coverage).toHaveLength(AUDIT_DOMAINS.length);
    for (const entry of coverage) {
      expect(entry.eventTypes.length).toBeGreaterThan(0);
      expect(AUDIT_EVENT_TYPES[entry.domain]).toEqual(entry.eventTypes);
    }
  });

  it("freezes a valid event and rejects later mutation", () => {
    const event = validEvent();
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.metadata)).toBe(true);
    expect(() => {
      event.action = "delete";
    }).toThrow();
    const guarded = assertAuditImmutable(event);
    expect(() => {
      guarded.domain = "messages";
    }).toThrow(/append-only/);
    expect(() => {
      delete guarded.metadata;
    }).toThrow(/append-only/);
  });

  it("rejects missing tenant, unknown types, and metadata that copies protected content", () => {
    expect(() => validEvent({ organizationId: null })).toThrow(/organization id/);
    expect(() => validEvent({ domain: "global" })).toThrow(/domain/);
    expect(() => validEvent({ eventType: "case.notes_dumped" })).toThrow(/event type/);
    expect(() => sanitizeAuditMetadata({ old: { email: "a@b.c" }, new: { email: "d@e.f" } })).toThrow(/row images/);
    expect(() => sanitizeAuditMetadata({ email: "a@b.c" })).toThrow(/protected key email/);
    expect(() => sanitizeAuditMetadata({ title: "Member grievance" })).toThrow(/protected key title/);
    expect(() => sanitizeAuditMetadata({ mystery: "x" })).toThrow(/unknown key/);
    expect(looksLikeRowImage({ before: {}, after: {} })).toBe(true);
  });

  it("rejects oversized metadata and mismatched tenant stamps", () => {
    expect(() => sanitizeAuditMetadata({ slug: "x".repeat(200) })).toThrow(/short string/);
    const bulky = "n".repeat(128);
    expect(() => sanitizeAuditMetadata({
      slug: bulky,
      name: bulky,
      role: bulky,
      status: bulky,
      fromStatus: bulky,
      toStatus: bulky,
      fromRole: bulky,
      toRole: bulky,
      reasonCode: bulky.slice(0, 64),
      runId: bulky,
      entityId: bulky,
      fieldsChanged: Array.from({ length: 24 }, (_, index) => `field_${String(index).padStart(2, "0")}_${"x".repeat(52)}`),
    })).toThrow(/2048-byte/);
    expect(() => validEvent({
      metadata: { organizationId: ORG_B, role: "admin" },
    })).toThrow(/must match the envelope/);
  });

  it("projects current admin and tenant audit rows without copying titles or row images", () => {
    const projected = projectMemberAdminAuditRow({
      id: KEY,
      organizationId: ORG_A,
      action: "create_event",
      actor: ACTOR,
      targetUser: null,
      createdAt: "2026-08-22T10:00:00.000Z",
      detail: { eventId: "evt-relief", title: "Caseload-relief rally", old: { secret: true } },
    });
    expect(projected.domain).toBe("community_events");
    expect(projected.entityId).toBe("evt-relief");
    expect(projected.metadata.title).toBeUndefined();
    expect(projected.metadata.old).toBeUndefined();
    expect(projected.source).toBe("member_admin_audit");

    const orgEvent = projectOrganizationAuditEventRow({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      organizationId: ORG_A,
      eventType: "staff_mfa_policy_changed",
      actorUserId: ACTOR,
      createdAt: "2026-08-22T11:00:00.000Z",
      idempotencyKey: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      metadata: { organizationId: ORG_A, requireStaffMfa: true },
    });
    expect(orgEvent.domain).toBe("security");
    expect(orgEvent.metadata.requireStaffMfa).toBe(true);
  });

  it("unifies current sources for one selected organization and drops orphans", () => {
    const events = projectUnifiedAudit({
      memberAdminAudit: [
        {
          id: "1",
          organizationId: ORG_A,
          action: "grant_role",
          actor: ACTOR,
          targetUser: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          createdAt: "2026-08-22T09:00:00.000Z",
          detail: { role: "steward" },
        },
        {
          id: "2",
          organizationId: ORG_B,
          action: "grant_role",
          actor: ACTOR,
          targetUser: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          createdAt: "2026-08-22T09:05:00.000Z",
          detail: { role: "admin" },
        },
        {
          id: "3",
          organizationId: null,
          action: "grant_role",
          actor: ACTOR,
          createdAt: "2026-08-01T00:00:00.000Z",
          detail: { role: "admin" },
        },
      ],
      organizationAuditEvents: [
        {
          id: "4",
          organizationId: ORG_A,
          eventType: "first_organization_bootstrap",
          createdAt: "2026-08-22T08:00:00.000Z",
          idempotencyKey: KEY,
          metadata: { organizationId: ORG_A, slug: "first" },
        },
      ],
    }, ORG_A);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.organizationId === ORG_A)).toBe(true);
    expect(events[0].eventType).toBe("role.granted");
    expect(events[1].eventType).toBe("organization.bootstrapped");
  });

  it("fails closed on malformed projection rows and preserves allowlisted metadata branches", () => {
    expect(projectMemberAdminAuditRow(null)).toBeNull();
    expect(projectMemberAdminAuditRow({ organizationId: "not-a-uuid", action: "grant_role" })).toBeNull();
    expect(projectMemberAdminAuditRow({ organizationId: ORG_A, action: "unknown" })).toBeNull();
    expect(projectOrganizationAuditEventRow(null)).toBeNull();
    expect(projectOrganizationAuditEventRow({ organizationId: ORG_A, eventType: "unknown" })).toBeNull();
    expect(projectUnifiedAudit({}, null)).toEqual([]);

    const member = projectMemberAdminAuditRow({
      id: "not-a-uuid",
      organizationId: ORG_A,
      action: "grant_role",
      actor: "not-a-uuid",
      targetUser: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      createdAt: "2026-08-22T10:00:00.000Z",
      detail: {
        role: "steward",
        status: "active",
        chapterId: "chapter-a",
        item: "bounded-reason",
      },
    });
    expect(member).toMatchObject({
      actorUserId: null,
      entityId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      metadata: {
        organizationId: ORG_A,
        userId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        role: "steward",
        status: "active",
        chapterId: "chapter-a",
        reasonCode: "bounded-reason",
      },
    });

    const organization = projectOrganizationAuditEventRow({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      organizationId: ORG_A,
      eventType: "organization_role_granted",
      actorUserId: "not-a-uuid",
      createdAt: "2026-08-22T10:00:00.000Z",
      metadata: {
        chapterId: "chapter-a",
        role: "admin",
        userId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        status: "active",
        requireStaffMfa: false,
      },
    });
    expect(organization).toMatchObject({
      actorUserId: null,
      entityId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      metadata: {
        chapterId: "chapter-a",
        role: "admin",
        userId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        status: "active",
        requireStaffMfa: false,
      },
    });

    const tied = projectUnifiedAudit({
      memberAdminAudit: [{
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        organizationId: ORG_A,
        action: "grant_role",
        createdAt: "2026-08-22T10:00:00.000Z",
      }],
      organizationAuditEvents: [{
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        organizationId: ORG_A,
        eventType: "first_organization_bootstrap",
        createdAt: "2026-08-22T10:00:00.000Z",
      }],
    }, ORG_A);
    expect(tied.map((event) => event.id)).toEqual([
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ]);
  });
});
