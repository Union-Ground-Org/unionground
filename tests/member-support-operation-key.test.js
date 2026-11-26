import { describe, expect, it, vi } from "vitest";

import { createMemberSupportAdapter } from "../src/features/memberSupport/adapter.js";
import { createEffectLedger, deliverTwice, retryAfterLostResponse } from "./helpers/operationReplay.js";

// The snapshot read goes through /api/sensitive-content; here it reaches the
// test client directly, as in tests/member-support-contract.test.js.
vi.mock("../src/lib/sensitiveContentApi.js", () => ({ sensitiveContentRpc: (client, name, args) => client.rpc(name, args) }));

// The member-support functions keep one row per key (an HR contact is a
// member_hr_contacts row whose id is the key). The adapter is shared by web
// (MemberSupportView) and native (MemberSupportScreen). The emergency steward
// alert keeps no key: the server already merges a repeat into the open alert,
// and a kept key could make a later real alert a no-op (review of #8648).
const member = {
  userId: "11111111-1111-4111-8111-111111111111",
  selectedOrganizationId: "22222222-2222-4222-8222-222222222222",
  membershipStatus: "active",
  selectedHat: "member",
};

function ledgerClient(ledger) {
  return {
    async rpc(name, args) {
      const { p_idempotency_key: key, ...fields } = args;
      try {
        return { data: await ledger.perform(key, { name, ...fields }), error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  };
}

function uuids() {
  let next = 0;
  return () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++next).padStart(12, "0")}`;
}

describe("member support writes keep their operation key across retries", () => {
  const alert = { scenario: "disciplinary_meeting", completedSteps: [0], notes: "Meeting at 3" };
  const contact = { channel: "email", purpose: "Question", disposition: "planned", occurredAt: "2026-11-13T15:00:00.000Z" };

  it("records one HR contact when the first response is lost", async () => {
    const ledger = createEffectLedger();
    const adapter = createMemberSupportAdapter(ledgerClient(ledger), { randomUUID: uuids() });
    await retryAfterLostResponse(ledger, () => adapter.recordHrContact(member, contact));
    expect(ledger.effects).toHaveLength(1);
    expect(new Set(ledger.keys).size).toBe(1);
  });

  // a review note P3-1 (#9042): only a reversal that succeeded retires a
  // kept key, and only the write it reversed. The client routes reads and the
  // keyless handoff decisions past the ledger, which stands in for the
  // keyed writes.
  function sequenceClient(ledger, handoffs = []) {
    const keyed = ledgerClient(ledger);
    return {
      async rpc(name, args) {
        if (name === "get_member_support_workspace") return { data: { state: "ready", organizationId: member.selectedOrganizationId, staff: true, handoffs: { items: handoffs, nextCursor: null } }, error: null };
        if (name === "cancel_member_handoff" || name === "decline_member_handoff") return { data: { id: args.p_handoff_id }, error: null };
        return keyed.rpc(name, args);
      },
    };
  }
  const staff = { ...member, selectedHat: "admin", roles: ["admin"], organizationRoles: ["admin"], mfaSatisfied: true };

  it("keeps a lost HR contact's key across an unrelated save and load, so the retry files one contact", async () => {
    const ledger = createEffectLedger();
    const adapter = createMemberSupportAdapter(sequenceClient(ledger), { randomUUID: uuids() });
    ledger.loseNextResponses(1);
    await expect(adapter.recordHrContact(member, contact)).rejects.toThrow();
    await adapter.saveHrDirectory(staff, { name: "Fictional HR desk", email: "hr@example.org" });
    await adapter.load(member);
    await adapter.recordHrContact(member, contact);
    expect(ledger.effects.filter(({ payload }) => payload.name === "record_member_hr_contact")).toHaveLength(1);
  });

  it("sends a redo after a confirmed plan reset as a new write", async () => {
    const ledger = createEffectLedger();
    const adapter = createMemberSupportAdapter(sequenceClient(ledger), { randomUUID: uuids() });
    const complete = { planId: "plan-1", action: "complete", stepId: "step-1" };
    ledger.loseNextResponses(1);
    await expect(adapter.updateMemberOnboarding(staff, complete)).rejects.toThrow();
    await adapter.updateMemberOnboarding(staff, { planId: "plan-1", action: "reset" });
    await adapter.updateMemberOnboarding(staff, complete);
    const completes = ledger.effects.filter(({ payload }) => payload.p_action === "complete").map(({ key }) => key);
    expect(completes).toHaveLength(2);
    expect(completes[0]).not.toBe(completes[1]);
  });

  it("keeps a lost complete's key when another plan is reset", async () => {
    const ledger = createEffectLedger();
    const adapter = createMemberSupportAdapter(sequenceClient(ledger), { randomUUID: uuids() });
    const complete = { planId: "plan-1", action: "complete", stepId: "step-1" };
    ledger.loseNextResponses(1);
    await expect(adapter.updateMemberOnboarding(staff, complete)).rejects.toThrow();
    await adapter.updateMemberOnboarding(staff, { planId: "plan-2", action: "reset" });
    await adapter.updateMemberOnboarding(staff, complete);
    expect(ledger.effects.filter(({ payload }) => payload.p_action === "complete")).toHaveLength(1);
  });

  it("sends a new handoff after the lost one was cancelled, and keeps another member's", async () => {
    const ledger = createEffectLedger();
    const lost = { memberUserId: "member-a", toStewardId: "steward-b", note: "" };
    const other = { memberUserId: "member-c", toStewardId: "steward-b", note: "" };
    const adapter = createMemberSupportAdapter(sequenceClient(ledger, [{ id: "handoff-1", memberId: "member-a", toStewardId: "steward-b", status: "pending" }]), { randomUUID: uuids() });
    ledger.loseNextResponses(2);
    await expect(adapter.initiateHandoff(staff, lost)).rejects.toThrow();
    await expect(adapter.initiateHandoff(staff, other)).rejects.toThrow();
    await adapter.load(staff);
    await adapter.cancelHandoff(staff, "handoff-1");
    await adapter.initiateHandoff(staff, lost);
    await adapter.initiateHandoff(staff, other);
    const keysFor = (id) => ledger.effects.filter(({ payload }) => payload.name === "initiate_member_handoff" && payload.p_member_user_id === id).map(({ key }) => key);
    expect(keysFor("member-a")).toHaveLength(2);
    expect(keysFor("member-c")).toHaveLength(1);
  });

  it("records one HR contact for a double submission", async () => {
    const ledger = createEffectLedger();
    const adapter = createMemberSupportAdapter(ledgerClient(ledger), { randomUUID: uuids() });
    await deliverTwice(() => adapter.recordHrContact(member, contact));
    expect(ledger.effects).toHaveLength(1);
  });

  it("sends a new alert after the first is resolved, even when its response was lost", async () => {
    const ledger = createEffectLedger();
    const adapter = createMemberSupportAdapter(ledgerClient(ledger), { randomUUID: uuids() });
    ledger.loseNextResponses(1);
    await expect(adapter.alertEmergencySteward(member, alert)).rejects.toThrow();
    await adapter.resolveEmergencyChecklist(member, "checklist-1");
    await adapter.alertEmergencySteward(member, alert);
    const alertKeys = ledger.effects.filter(({ payload }) => payload.name === "alert_member_emergency_steward").map(({ key }) => key);
    expect(alertKeys).toHaveLength(2);
    expect(alertKeys[0]).not.toBe(alertKeys[1]);
  });

  it("does not carry a kept key into another organization or to another person", async () => {
    const ledger = createEffectLedger();
    const adapter = createMemberSupportAdapter(ledgerClient(ledger), { randomUUID: uuids() });
    ledger.loseNextResponses(1);
    await expect(adapter.recordHrContact(member, contact)).rejects.toThrow();
    await adapter.recordHrContact({ ...member, selectedOrganizationId: "33333333-3333-4333-8333-333333333333" }, contact);
    await adapter.recordHrContact({ ...member, userId: "44444444-4444-4444-8444-444444444444" }, contact);
    await adapter.recordHrContact(member, contact);
    expect(ledger.keys).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
      "aaaaaaaa-aaaa-4aaa-8aaa-000000000002",
      "aaaaaaaa-aaaa-4aaa-8aaa-000000000003",
      "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
    ]);
  });

  it("sends no write when the device has no secure UUID source", async () => {
    const ledger = createEffectLedger();
    const saved = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
      await expect(createMemberSupportAdapter(ledgerClient(ledger)).alertEmergencySteward(member, alert))
        .rejects.toMatchObject({ code: "UUID_UNAVAILABLE" });
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: saved, configurable: true });
    }
    expect(ledger.keys).toEqual([]);
  });

  it("treats changed fields and a new submission after success as new writes", async () => {
    const ledger = createEffectLedger();
    const adapter = createMemberSupportAdapter(ledgerClient(ledger), { randomUUID: uuids() });
    ledger.loseNextResponses(1);
    await expect(adapter.recordHrContact(member, contact)).rejects.toThrow();
    await adapter.recordHrContact(member, { ...contact, purpose: "Follow up" });
    await adapter.recordHrContact(member, contact);
    await adapter.recordHrContact(member, contact);
    expect(ledger.effects.map(({ key }) => key)).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
      "aaaaaaaa-aaaa-4aaa-8aaa-000000000002",
      "aaaaaaaa-aaaa-4aaa-8aaa-000000000003",
    ]);
    expect(ledger.keys.at(-2)).toBe("aaaaaaaa-aaaa-4aaa-8aaa-000000000001");
  });
});
