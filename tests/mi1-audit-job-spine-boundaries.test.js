// @vitest-environment node
import { describe, expect, it } from "vitest";
import { forbiddenSupabaseRefsIn } from "../scripts/lib/sibling-deny-list.mjs";
import { readFileSync } from "node:fs";
import {
  OPERATIONS_RPCS,
  authorizeAuditQuery,
  authorizeJobQuery,
  authorizeJobRemediation,
  canClientInsertAudit,
  canReadJobHealth,
  canReadOrganizationAudit,
  canWriteOrganizationAudit,
  clientMayCallRecordAudit,
  clientMayCallRpc,
  createAuditEvent,
  filterAuditEventsForViewer,
  filterJobRunsForViewer,
  isOperationsRpc,
  shapeAuditListRequest,
  shapeJobHealthRequest,
  shapeJobRemediationRequest,
} from "../src/features/operations/index.js";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function adminSession(organizationId = ORG_A, overrides = {}) {
  return {
    authenticated: true,
    mfaSatisfied: true,
    membershipStatus: "active",
    organizationStatus: "active",
    selectedOrganizationId: organizationId,
    role: "admin",
    actorKind: "definer",
    ...overrides,
  };
}

function eventFor(organizationId) {
  return createAuditEvent({
    organizationId,
    domain: "casework",
    eventType: "case.status_changed",
    action: "update",
    actorUserId: ACTOR,
    entityType: "case",
    entityId: "case-1",
    occurredAt: "2026-08-22T12:00:00.000Z",
    idempotencyKey: KEY,
    metadata: { organizationId, fromStatus: "open", toStatus: "held" },
  });
}

describe("CR-106/CR-107 negative boundaries", () => {
  it("denies members, stewards, revoked membership, and inactive organizations", () => {
    const event = eventFor(ORG_A);
    expect(canReadOrganizationAudit(adminSession(ORG_A, { role: "member" }), event)).toBe(false);
    expect(canReadOrganizationAudit(adminSession(ORG_A, { role: "steward" }), event)).toBe(false);
    expect(canReadOrganizationAudit(adminSession(ORG_A, { membershipStatus: "revoked" }), event)).toBe(false);
    expect(canReadOrganizationAudit(adminSession(ORG_A, { organizationStatus: "suspended" }), event)).toBe(false);
    expect(canReadOrganizationAudit(adminSession(ORG_A, { mfaSatisfied: false }), event)).toBe(false);
    expect(canReadOrganizationAudit(adminSession(ORG_A, { authenticated: false }), event)).toBe(false);
    expect(canReadJobHealth(adminSession(ORG_A, { role: "coordinator" }))).toBe(false);
  });

  it("never treats a null or foreign organization as a wildcard", () => {
    const eventA = eventFor(ORG_A);
    const eventB = eventFor(ORG_B);
    expect(canReadOrganizationAudit(adminSession(ORG_A), eventB)).toBe(false);
    expect(canReadOrganizationAudit(adminSession(ORG_A, { selectedOrganizationId: null }), eventA)).toBe(false);
    expect(authorizeAuditQuery(adminSession(ORG_A), ORG_B)).toEqual({
      ok: false,
      reason: "organization_mismatch",
    });
    expect(authorizeJobQuery(adminSession(ORG_A), ORG_B).reason).toBe("organization_mismatch");
    expect(filterAuditEventsForViewer(adminSession(ORG_A), [eventA, eventB])).toEqual([eventA]);
    expect(filterJobRunsForViewer(adminSession(ORG_A), [
      { jobName: "deadline-notices-tick", organizationId: ORG_B },
      { jobName: "deadline-notices-tick", organizationId: ORG_A },
      { jobName: "member-messaging-dispatch" },
    ])).toEqual([
      { jobName: "deadline-notices-tick", organizationId: ORG_A },
      { jobName: "member-messaging-dispatch" },
    ]);
  });

  it("keeps audit writes on the definer path and blocks browser inserts", () => {
    const event = eventFor(ORG_A);
    expect(canClientInsertAudit({ actorKind: "browser" })).toBe(false);
    expect(clientMayCallRecordAudit()).toBe(false);
    expect(clientMayCallRpc(OPERATIONS_RPCS.recordAudit)).toBe(false);
    expect(clientMayCallRpc(OPERATIONS_RPCS.listAudit)).toBe(true);
    expect(isOperationsRpc(OPERATIONS_RPCS.recordAudit)).toBe(true);
    expect(isOperationsRpc("unregistered_operation")).toBe(false);
    expect(canWriteOrganizationAudit(adminSession(ORG_A, { actorKind: "browser" }), event)).toBe(false);
    expect(canWriteOrganizationAudit(adminSession(ORG_A), event)).toBe(true);
    expect(canWriteOrganizationAudit(adminSession(ORG_B), event)).toBe(false);
    expect(canWriteOrganizationAudit({
      actorKind: "service_bootstrap",
      bootstrapOrganizationId: ORG_A,
    }, event)).toBe(true);
    expect(canWriteOrganizationAudit({
      actorKind: "service_bootstrap",
      bootstrapOrganizationId: ORG_B,
    }, event)).toBe(false);
  });

  it("authorizes remediations for the selected tenant only and never executes the job", () => {
    const denied = authorizeJobRemediation(adminSession(ORG_A, { role: "member" }), {
      organizationId: ORG_A,
      jobName: "deadline-notices-tick",
      runId: "run-1",
      remediation: "acknowledge",
    });
    expect(denied.ok).toBe(false);
    expect(authorizeJobRemediation(adminSession(ORG_A), {
      organizationId: ORG_B,
      jobName: "deadline-notices-tick",
      runId: "run-1",
      remediation: "acknowledge",
    }).reason).toBe("organization_mismatch");
    expect(authorizeJobRemediation(adminSession(ORG_A), {
      organizationId: ORG_A,
      jobName: "donor-compute-scores",
      runId: "run-1",
      remediation: "request_retry",
    }).reason).toBe("unknown_job");
    const allowed = authorizeJobRemediation(adminSession(ORG_A), {
      organizationId: ORG_A,
      jobName: "deadline-notices-tick",
      runId: "run-1",
      remediation: "request_retry",
    });
    expect(allowed).toEqual({
      ok: true,
      organizationId: ORG_A,
      executesJob: false,
    });
    expect(shapeJobRemediationRequest(adminSession(ORG_A), {
      jobName: "deadline-notices-tick",
      runId: "run-1",
    }).organizationId).toBe(ORG_A);
    expect(shapeAuditListRequest(adminSession(ORG_A), { limit: 999 }).p_limit).toBe(200);
    expect(shapeAuditListRequest(adminSession(ORG_A), { limit: "invalid" }).p_limit).toBe(50);
    expect(shapeJobHealthRequest(adminSession(ORG_A))).toEqual({ organizationId: ORG_A });
  });

  it("does not ship service-role material, Next.js actions, or donor credentials", () => {
    const files = [
      "src/features/operations/auditEnvelope.js",
      "src/features/operations/auditAuthorization.js",
      "src/features/operations/auditProjection.js",
      "src/features/operations/jobRegistry.js",
      "src/features/operations/jobHealth.js",
      "src/features/operations/jobAuthorization.js",
      "src/features/operations/operationsAdapter.js",
      "src/features/operations/AuditLogPanel.jsx",
      "src/features/operations/JobHealthPanel.jsx",
      "src/features/operations/index.js",
    ];
    for (const file of files) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/service_role/i);
      expect(source, file).not.toMatch(/SUPABASE_SERVICE_ROLE/);
      expect(source, file).not.toMatch(/eyJ/);
      expect(source, file).not.toContain("createServiceClient");
      expect(source, file).not.toContain("next/headers");
      expect(forbiddenSupabaseRefsIn(source), file).toEqual([]);
    }
  });
});
