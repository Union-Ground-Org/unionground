import { describe, expect, it } from "vitest";

import {
  AUTOMATION_APPROVER_ROLES,
  AUTOMATION_AUTHOR_ROLES,
  automationAccess,
} from "../src/features/automation/access.js";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000509";

function activeSession(role) {
  return {
    authenticated: true,
    selectedOrganizationId: ORGANIZATION_ID,
    membershipStatus: "active",
    organizationStatus: "active",
    mfaSatisfied: true,
    role,
    selectedHat: role,
  };
}

describe("automationAccess", () => {
  it.each(["steward", "coordinator", "advisor"])(
    "lets an active %s author drafts without granting approval or execution",
    (role) => {
      expect(automationAccess(activeSession(role))).toEqual({
        connected: true,
        canAuthor: true,
        canApprove: false,
        canOperate: false,
        reason: null,
        organizationId: ORGANIZATION_ID,
      });
    },
  );

  it.each(["admin", "vp"])(
    "lets an active %s author, approve, and operate",
    (role) => {
      expect(automationAccess(activeSession(role))).toEqual({
        connected: true,
        canAuthor: true,
        canApprove: true,
        canOperate: true,
        reason: null,
        organizationId: ORGANIZATION_ID,
      });
    },
  );

  it("denies members before connected automation data is exposed", () => {
    expect(automationAccess(activeSession("member"))).toMatchObject({
      connected: false,
      canAuthor: false,
      canApprove: false,
      canOperate: false,
      reason: "role_denied",
    });
  });

  it("explains that MFA is required for an otherwise active staff session", () => {
    expect(automationAccess({ ...activeSession("advisor"), mfaSatisfied: false })).toMatchObject({
      connected: false,
      reason: "mfa_required",
      organizationId: ORGANIZATION_ID,
    });
  });

  it("rejects a stale selected hat instead of borrowing authority from another role", () => {
    expect(automationAccess({ ...activeSession("admin"), selectedHat: "steward" })).toMatchObject({
      connected: false,
      reason: "role_denied",
    });
  });

  it("accepts a server-resolved active role when the optional UI hat is absent", () => {
    const { selectedHat: _selectedHat, ...serverSession } = activeSession("admin");
    expect(automationAccess(serverSession)).toMatchObject({
      connected: true,
      canApprove: true,
      canOperate: true,
      organizationId: ORGANIZATION_ID,
    });
  });

  it.each([
    [{ ...activeSession("steward"), authenticated: false }, null],
    [{ ...activeSession("steward"), membershipStatus: "inactive" }, null],
    [{ ...activeSession("steward"), organizationStatus: "inactive" }, null],
    [{ ...activeSession("steward"), selectedOrganizationId: "not-an-id" }, null],
  ])("keeps an inactive session disconnected", (session, organizationId) => {
    expect(automationAccess(session)).toMatchObject({
      connected: false,
      reason: "session_inactive",
      organizationId,
    });
  });

  it("publishes stable author and approver role sets", () => {
    expect(AUTOMATION_AUTHOR_ROLES).toEqual(["steward", "coordinator", "advisor", "admin", "vp"]);
    expect(AUTOMATION_APPROVER_ROLES).toEqual(["admin", "vp"]);
    expect(Object.isFrozen(AUTOMATION_AUTHOR_ROLES)).toBe(true);
    expect(Object.isFrozen(AUTOMATION_APPROVER_ROLES)).toBe(true);
  });
});
