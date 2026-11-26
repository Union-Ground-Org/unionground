import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MEMBER_PATH_VIEWS, SPA_ROUTE_PATHS } from "../src/lib/appRoutes.js";
import { STAFF_TOOLS } from "../src/lib/staffPlanes.js";
import { createWiredOrganizationIntelligenceAdapter } from "../src/lib/organizationIntelligenceWiring.js";
import {
  applyPreviewCollectiveActionJoin,
  DIGITAL_ACTION_KINDS,
  participationKindForAction,
} from "../apps/mobile/src/lib/mi1OrganizationShared.ts";

const actor = {
  userId: "user-1", organizationId: "org-1", selectedHat: "advisor",
  organizationRoles: ["advisor"], membershipStatus: "active", mfaSatisfied: true,
};

describe("organization intelligence web and native wiring", () => {
  it("registers member actions and keeps the organization map staff-only", () => {
    expect(MEMBER_PATH_VIEWS["/m/actions"]).toBe("actions");
    expect(MEMBER_PATH_VIEWS["/m/organization-map"]).toBeUndefined();
    expect(STAFF_TOOLS).toContainEqual(expect.objectContaining({ view: "organizationMap", path: "/m/organization-map" }));
    expect(SPA_ROUTE_PATHS).toEqual(expect.arrayContaining(["/m/actions", "/m/organization-map"]));
  });

  it("sends the explicit selected hat but never a client tenant id", async () => {
    const rpc = vi.fn(async (name) => ({ data: name === "get_collective_actions"
      ? { organizationId: "org-1", actions: [] }
      : { organizationId: "org-1", chartNodes: [], relationshipNodes: [], relationships: [], topicProgress: [], timeline: [] }, error: null }));
    const adapter = createWiredOrganizationIntelligenceAdapter({ rpc });
    await adapter.loadIntelligence({ actor });
    await adapter.loadActions({ actor, limit: 25, offset: 25 });
    await adapter.saveChartNode({ actor, chartKind: "agency", nodeKind: "organization", label: "Agency" });
    for (const [, args] of rpc.mock.calls) {
      expect(args).toMatchObject({ p_selected_hat: "advisor" });
      expect(args).not.toHaveProperty("p_organization_id");
    }
    expect(rpc).toHaveBeenCalledWith("get_collective_actions", expect.objectContaining({ p_limit: 25, p_offset: 25 }));
  });

  it("maps every write and export field to the exact RPC contract", async () => {
    const rpc = vi.fn(async (name, args) => ({ data: { name, args }, error: null }));
    const adapter = createWiredOrganizationIntelligenceAdapter({ rpc });
    await adapter.saveRelationship({ actor, sourceId: "one", targetId: "two", kind: "mentors", strength: 0 });
    await adapter.saveTopicProgress({ actor, memberId: "one", topicKey: "rights", topicLabel: "Rights", state: "ready", progress: 0 });
    await adapter.saveTimelineEvent({ actor, kind: "payroll_snapshot", title: "Payroll", effectiveOn: "2026-01-01", amountCents: 0 });
    await adapter.saveAction({ actor, kind: "petition", title: "Staffing", summary: "Summary", status: "published", targetCount: 0 });
    await adapter.toggleParticipation({ actionId: "action", participationKind: "signature", joined: 1 });
    await adapter.exportParticipants({ actor, actionId: "action", participationKind: "volunteer" });

    expect(rpc).toHaveBeenCalledWith("save_organization_relationship", expect.objectContaining({ p_selected_hat: "advisor", p_source_user_id: "one", p_target_user_id: "two", p_strength: 1 }));
    expect(rpc).toHaveBeenCalledWith("save_organization_topic_progress", expect.objectContaining({ p_progress: 0 }));
    expect(rpc).toHaveBeenCalledWith("save_organization_timeline_event", expect.objectContaining({ p_amount_cents: 0, p_ended_on: null }));
    expect(rpc).toHaveBeenCalledWith("save_digital_action", expect.objectContaining({ p_target_count: 1, p_starts_at: null }));
    expect(rpc).toHaveBeenCalledWith("toggle_digital_action_participation", { p_action_id: "action", p_participation_kind: "signature", p_joined: true });
    expect(rpc).toHaveBeenCalledWith("request_digital_action_participant_export", expect.objectContaining({ p_action_id: "action", p_participation_kind: "volunteer" }));
  });

  it("fails closed when the client is missing or an RPC returns an error", async () => {
    const missing = createWiredOrganizationIntelligenceAdapter(null);
    await expect(missing.saveAction({ actor, title: "No client" })).rejects.toThrow("organization intelligence is unavailable");
    const denied = createWiredOrganizationIntelligenceAdapter({ rpc: vi.fn(async () => ({ data: null, error: new Error("denied") })) });
    await expect(denied.exportParticipants({ actor, actionId: "action", participationKind: "signature" })).rejects.toThrow("denied");
  });

  it("wires both native destinations to live RPCs", () => {
    const catalog = readFileSync("apps/mobile/src/lib/featureCatalog.ts", "utf8");
    const feature = readFileSync("apps/mobile/src/features/FeatureScreen.tsx", "utf8");
    const service = readFileSync("apps/mobile/src/services/supabase.ts", "utf8");
    const nativeScreens = readFileSync("apps/mobile/src/features/mi1/OrganizationIntelligenceScreens.tsx", "utf8");
    const sharedContract = readFileSync("src/features/organizationIntelligence/contract.js", "utf8");
    expect(catalog).toContain("'organization-map'");
    expect(catalog).toContain("'actions'");
    expect(feature).toContain("<OrganizationIntelligenceScreen />");
    expect(feature).toContain("<CollectiveActionsScreen />");
    expect(service).toContain("get_organization_intelligence_snapshot");
    expect(service).toContain("request_digital_action_participant_export");
    expect(nativeScreens).toContain("DIGITAL_ACTION_PARTICIPATION_KINDS.map");
    expect(nativeScreens).toContain("ORGANIZATION_INTELLIGENCE_STAFF_HATS.includes(role)");
    expect(sharedContract).toContain("export const ORGANIZATION_INTELLIGENCE_STAFF_HATS");
    for (const role of ['steward', 'coordinator', 'advisor', 'admin', 'vp']) {
      expect(sharedContract).toContain(`"${role}"`);
    }
    expect(nativeScreens).toContain("useOrganizationActor('intelligence')");
    expect(nativeScreens).toContain("useOrganizationActor('actions')");
    // UX-UG-THE-NATIVE-ORGANIZATION-MAP-RELATIONSHIP-TOPIC-WRITE-FORM-ASKS-FOR-RAW-MEMBER-20260921:
    // the write card must pick members from model.relationships.nodes, never
    // from free-text raw member id fields that no native screen exposes.
    expect(nativeScreens).not.toContain('Source member ID');
    expect(nativeScreens).not.toContain('Target member ID');
    expect(nativeScreens).toContain('<OptionPicker label="Source worker"');
    expect(nativeScreens).toContain('<OptionPicker label="Target worker"');
    expect(nativeScreens).not.toContain('Source worker ID');
    // Codex round 1/3: options come from the mapped memberOptions list, with
    // collision-safe role/chapter/ordinal detail from the pure helper.
    expect(nativeScreens).toContain('options={memberOptions}');
    expect(nativeScreens).toContain('const relationshipNodes: RelationshipMemberNode[] = model?.relationships?.nodes ?? [];');
    expect(nativeScreens).toContain('buildMemberPickerOptions(relationshipNodes, chapterNameById)');
    expect(nativeScreens).toContain('p_source_user_id: source');
    expect(nativeScreens).toContain('p_target_user_id: target');
    const nativeUi = readFileSync("apps/mobile/src/components/ui.tsx", "utf8");
    const nativePicker = readFileSync("apps/mobile/src/components/optionPicker.tsx", "utf8");
    const nativePickerFilter = readFileSync("apps/mobile/src/components/optionPickerFilter.ts", "utf8");
    expect(nativeUi).toContain("export { OptionPicker } from './optionPicker'");
    expect(nativePicker).toContain('export function OptionPicker');
    expect(nativePicker).toContain('accessibilityState={{ selected }}');
    expect(nativePicker).toContain('role="group"');
    // Codex round 1 P1: searchable, hard-capped option lists so a 5,000-node
    // roster never mounts 10,000 controls inside the non-virtualized ScrollView.
    expect(nativePicker).toContain('filterOptionPickerOptions');
    expect(nativePicker).toContain('OPTION_PICKER_MAX_VISIBLE');
    expect(nativePicker).toContain('`Search ${label}`');
    expect(nativePicker).toContain('keep typing to narrow');
    expect(nativePicker).toContain('option.detail');
    expect(nativePicker).toContain('optionPickerSearchNeedle');
    expect(nativePicker).toContain("if (!searchable) setQuery('')");
    expect(nativePickerFilter).toContain('selectedMatchIndex >= OPTION_PICKER_MAX_VISIBLE');
    expect(nativePickerFilter).toContain('buildMemberPickerOptions');
    expect(nativeScreens).not.toContain("action.id, 'signature'");
    expect(nativeScreens).toContain("applyPreviewCollectiveActionJoin");
    expect(nativeScreens).toContain("participationKindForAction");
    expect(nativeScreens).toContain("applyPreviewCollectiveActionJoin(current.actions as any[], action.id)");
    expect(nativeScreens).toContain("participationKind: action.viewerParticipation ?? participationKindForAction(action.kind)");
    expect(nativeScreens).not.toContain("null : 'signature'");
    expect(nativeScreens).not.toContain("?? 'signature'");
  });

  it("records rally joins as attendee and petition joins as signature", () => {
    expect(participationKindForAction("rally")).toBe("attendee");
    expect(participationKindForAction("petition")).toBe("signature");
    expect(participationKindForAction("picket")).toBe("attendee");
    expect(participationKindForAction("meeting")).toBe("attendee");
    expect(participationKindForAction("other")).toBe("volunteer");
    expect(DIGITAL_ACTION_KINDS).toEqual(["petition", "rally", "picket", "meeting", "other"]);
    for (const kind of DIGITAL_ACTION_KINDS) {
      expect(["signature", "attendee", "volunteer"]).toContain(participationKindForAction(kind));
    }

    const actions = [
      { id: "a1", kind: "petition", viewerParticipation: null, participantCount: 168 },
      { id: "a2", kind: "rally", viewerParticipation: null, participantCount: 74 },
      { id: "a3", kind: "picket", viewerParticipation: null, participantCount: 91 },
    ];
    expect(applyPreviewCollectiveActionJoin(actions, "a2")).toEqual([
      { id: "a1", kind: "petition", viewerParticipation: null, participantCount: 168 },
      { id: "a2", kind: "rally", viewerParticipation: "attendee", participantCount: 75 },
      { id: "a3", kind: "picket", viewerParticipation: null, participantCount: 91 },
    ]);
    expect(applyPreviewCollectiveActionJoin(actions, "a1")[0].viewerParticipation).toBe("signature");
    const joined = applyPreviewCollectiveActionJoin(actions, "a2");
    expect(applyPreviewCollectiveActionJoin(joined, "a2")[1]).toMatchObject({
      viewerParticipation: null,
      participantCount: 74,
    });
  });
});
