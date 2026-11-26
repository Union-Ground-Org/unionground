import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  HANDOFF_INITIATOR_HATS,
  MEMBER_SUPPORT_RPCS,
  MEMBER_SUPPORT_STAFF_HATS,
  canInitiateMemberHandoff,
  MEMBER_SUPPORT_TABS,
  createMemberSupportAdapter,
  normalizeMemberSupportWorkspace,
} from "../src/features/memberSupport/index.js";

const steward = {
  userId: "11111111-1111-4111-8111-111111111111",
  selectedOrganizationId: "22222222-2222-4222-8222-222222222222",
  chapterId: "chapter-a",
  membershipStatus: "active",
  selectedHat: "steward",
  organizationRoles: ["steward"],
  mfaSatisfied: true,
};

describe("member handoff web contract", () => {
  it("adds a staff-only handoff workflow and complete RPC surface", () => {
    expect(MEMBER_SUPPORT_TABS).toContainEqual({ id: "handoffs", label: "Handoffs", staffOnly: true });
    expect(MEMBER_SUPPORT_RPCS).toMatchObject({
      listHandoffs: "list_member_handoffs_v2",
      searchHandoffMembers: "search_handoff_members",
      searchHandoffStewards: "search_handoff_stewards",
      initiateHandoff: "initiate_member_handoff",
      acknowledgeHandoff: "acknowledge_member_handoff",
      declineHandoff: "decline_member_handoff",
      cancelHandoff: "cancel_member_handoff",
    });
  });

  it("normalizes labels, directions, transition capabilities, notes, and history", () => {
    const result = normalizeMemberSupportWorkspace({
      state: "ready",
      organizationId: steward.selectedOrganizationId,
      staff: true,
      handoffs: { items: [{
        id: "handoff-1", memberId: "member-1", memberName: "Morgan",
        fromStewardName: "Sam", toStewardName: "Taylor", direction: "incoming",
        status: "pending", note: "Please follow up", canAcknowledge: true,
      }] },
    }, steward);
    expect(result.handoffs.items[0]).toMatchObject({
      memberName: "Morgan", direction: "incoming", note: "Please follow up",
      canAcknowledge: true, canDecline: false, canCancel: false,
    });
  });

  it("maps every handoff transition and refuses member-hat calls", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: { ok: true }, error: null }) };
    const adapter = createMemberSupportAdapter(client, { randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    await adapter.listHandoffs(steward, { status: "pending" });
    await adapter.initiateHandoff(steward, { memberUserId: "member-1", toStewardId: "steward-2", note: "Context" });
    await adapter.acknowledgeHandoff(steward, "handoff-1");
    await adapter.declineHandoff(steward, "handoff-2");
    await adapter.cancelHandoff(steward, "handoff-3");
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual([
      "list_member_handoffs_v2", "initiate_member_handoff", "acknowledge_member_handoff",
      "decline_member_handoff", "cancel_member_handoff",
    ]);
    expect(client.rpc.mock.calls.map(([name]) => name)).not.toContain("get_member_steward_relationship");
    await expect(adapter.listHandoffs({ ...steward, selectedHat: "member" }, {})).rejects.toMatchObject({ code: "42501" });
  });
});

describe("handoff initiator parity (BUG-UG-ADVISOR-HANDOFF-DEAD-END-20261003)", () => {
  function sqlInitiatorRoles() {
    // The newest migration that (re)defines the predicate is the one in force.
    const dir = `${process.cwd()}/supabase/migrations`;
    const pattern = /create (?:or replace )?function private\.mi1_w2_handoff_can_initiate\([\s\S]*?\$function\$([\s\S]*?)\$function\$/g;
    let body = null;
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
      for (const match of readFileSync(`${dir}/${file}`, "utf8").matchAll(pattern)) body = match[1];
    }
    expect(body).not.toBeNull();
    const roles = body.match(/has_organization_role\(p_org, array\[([^\]]*)\]\)/);
    expect(roles).not.toBeNull();
    return [...roles[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  }

  function mobileInitiatorRoles() {
    const source = readFileSync(`${process.cwd()}/apps/mobile/src/features/memberSupportHandoffs.ts`, "utf8");
    const list = source.match(/const HANDOFF_INITIATOR_HATS = Object\.freeze\(\[([^\]]*)\]\)/);
    expect(list).not.toBeNull();
    return [...list[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  }

  it("keeps the web initiator list equal to the SQL predicate and the mobile list", () => {
    expect([...HANDOFF_INITIATOR_HATS].sort()).toEqual(sqlInitiatorRoles().sort());
    expect([...HANDOFF_INITIATOR_HATS].sort()).toEqual(mobileInitiatorRoles().sort());
    expect(HANDOFF_INITIATOR_HATS).not.toContain("advisor");
    expect(MEMBER_SUPPORT_STAFF_HATS).toContain("advisor");
  });

  it("lets only an initiator hat the actor holds start a handoff", () => {
    for (const hat of HANDOFF_INITIATOR_HATS) {
      expect(canInitiateMemberHandoff({ ...steward, selectedHat: hat, organizationRoles: [hat] })).toBe(true);
    }
    expect(canInitiateMemberHandoff({ ...steward, selectedHat: "advisor", organizationRoles: ["advisor"] })).toBe(false);
    expect(canInitiateMemberHandoff({ ...steward, selectedHat: "advisor", organizationRoles: ["advisor", "steward"] })).toBe(false);
    expect(canInitiateMemberHandoff({ ...steward, selectedHat: "steward", organizationRoles: [] })).toBe(false);
    expect(canInitiateMemberHandoff({ ...steward, mfaSatisfied: false })).toBe(false);
    expect(canInitiateMemberHandoff({ ...steward, selectedHat: "member" })).toBe(false);
  });
});
