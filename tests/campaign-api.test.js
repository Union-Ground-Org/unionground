// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { CAMPAIGN_PUBLISH_CLOCK_ALLOWANCE_MS, campaignCloseDatePassed, campaignPublishWithdrawn, isCampaignCloseDateRefusal } from "../src/lib/campaignPublish.js";
import {
  CAMPAIGN_PAGE_SIZE,
  closeCampaign,
  loadCampaigns,
  publishCampaign,
  saveCampaignDraft,
} from "../src/lib/campaignApi.js";

function clientReturning(data = {}, error = null) {
  const calls = [];
  return {
    calls,
    rpc(name, args) {
      calls.push([name, args]);
      return Promise.resolve({ data, error });
    },
    from(table) {
      throw new Error(`direct campaign DML forbidden: ${table}`);
    },
  };
}

describe("campaign API", () => {
  it("loads through the scoped registry RPC only", async () => {
    const client = clientReturning({ campaigns: [], canManageUnion: false, chapterId: "wor", nextCursor: null });
    await expect(loadCampaigns(client)).resolves.toEqual({ campaigns: [], canManageUnion: false, chapterId: "wor", nextCursor: null });
    expect(client.calls).toEqual([["get_staff_vote_campaigns", { p_state: null, p_limit: 50, p_cursor: null }]]);
  });

  // BUG-UG-WEB-STAFF-CAMPAIGNS-REGISTRY-UNBOUNDED-READ-20261002: each
  // request carries one bounded page and the next request passes its cursor.
  it("reads the registry one bounded page at a time and pages through the rest", async () => {
    const counts = { all: 3, draft: 1, open: 1, closed: 1 };
    const cursor = { rank: 1, closesAt: "2026-10-09T00:00:00Z", kind: "pulse", id: "p1" };
    const pages = [
      { campaigns: [{ id: "b1" }, { id: "p1" }], canManageUnion: true, chapterId: "wor", counts, nextCursor: cursor },
      { campaigns: [{ id: "b2" }], canManageUnion: true, chapterId: "wor", counts, nextCursor: null },
    ];
    const calls = [];
    const client = { rpc: async (name, args) => { calls.push([name, args]); return { data: pages[calls.length - 1], error: null }; } };
    await expect(loadCampaigns(client)).resolves.toEqual({
      campaigns: [{ id: "b1" }, { id: "p1" }, { id: "b2" }], canManageUnion: true, chapterId: "wor", counts, nextCursor: null,
    });
    expect(calls).toEqual([
      ["get_staff_vote_campaigns", { p_state: null, p_limit: CAMPAIGN_PAGE_SIZE, p_cursor: null }],
      ["get_staff_vote_campaigns", { p_state: null, p_limit: CAMPAIGN_PAGE_SIZE, p_cursor: cursor }],
    ]);
    expect(CAMPAIGN_PAGE_SIZE).toBeLessThanOrEqual(100);
  });

  it("uses the latest projection once when a returned draft is published between pages", async () => {
    const drafts = Array.from({ length: 51 }, (_, index) => ({
      id: `draft-${String(index).padStart(2, "0")}`, kind: "ballot", state: "draft",
      closesAt: "2026-10-09T00:00:00Z", active: false,
    }));
    const open = { id: "existing-open", kind: "ballot", state: "open", closesAt: drafts[0].closesAt, active: true };
    const cursor = { rank: 0, closesAt: drafts[49].closesAt, kind: "ballot", id: drafts[49].id };
    const calls = [];
    const client = { rpc: async (name, args) => {
      calls.push([name, args]);
      if (calls.length === 1) return { data: {
        campaigns: drafts.slice(0, 50), counts: { all: 52, draft: 51, open: 1, closed: 0 }, nextCursor: cursor,
      }, error: null };
      // Publishing the first draft moves it past the rank-0 cursor into the
      // open section of the SQL keyset, so it is returned a second time.
      return { data: {
        campaigns: [drafts[50], { ...drafts[0], state: "open", active: true }, open],
        counts: { all: 52, draft: 50, open: 2, closed: 0 }, nextCursor: null,
      }, error: null };
    } };

    const registry = await loadCampaigns(client);
    expect(registry.campaigns).toHaveLength(52);
    expect(registry.campaigns.filter((campaign) => campaign.state === "draft")).toHaveLength(50);
    expect(registry.campaigns.filter((campaign) => campaign.state === "open")).toHaveLength(2);
    expect(registry.campaigns.filter((campaign) => campaign.id === drafts[0].id)).toEqual([{ ...drafts[0], state: "open", active: true }]);
    expect(registry.counts).toEqual({ all: 52, draft: 50, open: 2, closed: 0 });
    expect(calls).toEqual([
      ["get_staff_vote_campaigns", { p_state: null, p_limit: CAMPAIGN_PAGE_SIZE, p_cursor: null }],
      ["get_staff_vote_campaigns", { p_state: null, p_limit: CAMPAIGN_PAGE_SIZE, p_cursor: cursor }],
    ]);
  });

  it("keeps a ballot and pulse with the same id distinct when merging campaign pages", async () => {
    const cursor = { rank: 0, closesAt: "2026-10-09T00:00:00Z", kind: "ballot", id: "shared-id" };
    const ballot = { id: "shared-id", kind: "ballot", state: "draft" };
    const pulse = { id: "shared-id", kind: "pulse", state: "open" };
    const pages = [
      { campaigns: [ballot], nextCursor: cursor },
      { campaigns: [pulse, { ...ballot, state: "open" }], nextCursor: null },
    ];
    const client = { rpc: async () => ({ data: pages.shift(), error: null }) };
    const registry = await loadCampaigns(client);
    expect(registry.campaigns).toHaveLength(2);
    expect(registry.campaigns).toEqual(expect.arrayContaining([pulse, { ...ballot, state: "open" }]));
  });

  it("falls back to the parameterless read on a database without the paged signature", async () => {
    const calls = [];
    const legacy = { campaigns: [{ id: "b1" }], canManageUnion: false, chapterId: "wor" };
    const client = {
      rpc: async (name, args) => {
        calls.push([name, args]);
        return args ? { data: null, error: { code: "PGRST202", message: "Could not find the function" } } : { data: legacy, error: null };
      },
    };
    await expect(loadCampaigns(client)).resolves.toEqual(legacy);
    expect(calls).toEqual([
      ["get_staff_vote_campaigns", { p_state: null, p_limit: 50, p_cursor: null }],
      ["get_staff_vote_campaigns", undefined],
    ]);
  });

  it("fails instead of returning a short registry when a later page fails or the cursor stalls", async () => {
    const cursor = { rank: 0, closesAt: "2026-10-09T00:00:00Z", kind: "ballot", id: "b1" };
    let call = 0;
    const failing = { rpc: async () => (++call === 1 ? { data: { campaigns: [{ id: "b1" }], nextCursor: cursor }, error: null } : { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }) };
    await expect(loadCampaigns(failing)).rejects.toThrow("statement timeout");
    const stalled = { rpc: async () => ({ data: { campaigns: [{ id: "b1" }], nextCursor: cursor }, error: null }) };
    await expect(loadCampaigns(stalled)).rejects.toThrow("did not finish paging");
  });

  it("saves normalized bilingual drafts through one RPC", async () => {
    const client = clientReturning({ id: "ballot-1", kind: "ballot", state: "draft" });
    await saveCampaignDraft(client, {
      id: "", kind: "ballot", scope: "chapter", titleEn: " Contract vote ",
      titleEs: " Votación del contrato ", bodyEn: " Details ", bodyEs: " Detalles ",
      closesAt: "2026-09-01T16:00:00.000Z", quorumTarget: 125,
      options: [{ labelEn: " Yes ", labelEs: " Sí " }, { labelEn: " No ", labelEs: " No " }],
    });
    expect(client.calls).toEqual([["save_vote_campaign_draft", {
      p_kind: "ballot", p_campaign_id: null, p_scope: "chapter",
      p_title_en: "Contract vote", p_title_es: "Votación del contrato",
      p_closes_at: "2026-09-01T16:00:00.000Z", p_quorum_target: 125,
      p_body_en: "Details", p_body_es: "Detalles",
      p_options: [{ labelEn: "Yes", labelEs: "Sí" }, { labelEn: "No", labelEs: "No" }],
    }]]);
  });

  it("publishes and closes through explicit transition RPCs", async () => {
    const client = clientReturning();
    await publishCampaign(client, "pulse", "pulse-1");
    await closeCampaign(client, "pulse", "pulse-1");
    expect(client.calls).toEqual([
      ["publish_vote_campaign", { p_kind: "pulse", p_campaign_id: "pulse-1" }],
      ["close_vote_campaign", { p_kind: "pulse", p_campaign_id: "pulse-1" }],
    ]);
  });

  // BUG-UG-CAMPAIGN-COMMAND-TESTS-ACCEPT-REFUSALS-20261020: a successful
  // registry read does not prove a refused command rejects. The view relies on
  // rejection to keep a refused change out of its saved/published/closed path.
  it.each([
    {
      operation: "save", label: "Save campaign draft", rpc: "save_vote_campaign_draft",
      invoke: (client) => saveCampaignDraft(client, {
        id: "pulse-1", kind: "pulse", scope: "chapter", titleEn: "Member pulse", titleEs: "Pulso",
        bodyEn: "Choose one", bodyEs: "Elige una", closesAt: "2026-10-25T16:00:00.000Z",
        options: [{ labelEn: "Yes", labelEs: "Sí" }, { labelEn: "No", labelEs: "No" }],
      }),
      args: {
        p_kind: "pulse", p_campaign_id: "pulse-1", p_scope: "chapter",
        p_title_en: "Member pulse", p_title_es: "Pulso", p_body_en: "Choose one", p_body_es: "Elige una",
        p_closes_at: "2026-10-25T16:00:00.000Z", p_quorum_target: null,
        p_options: [{ labelEn: "Yes", labelEs: "Sí" }, { labelEn: "No", labelEs: "No" }],
      },
    },
    {
      operation: "publish", label: "Publish campaign", rpc: "publish_vote_campaign",
      invoke: (client) => publishCampaign(client, "pulse", "pulse-1"),
      args: { p_kind: "pulse", p_campaign_id: "pulse-1" },
    },
    {
      operation: "close", label: "Close campaign", rpc: "close_vote_campaign",
      invoke: (client) => closeCampaign(client, "pulse", "pulse-1"),
      args: { p_kind: "pulse", p_campaign_id: "pulse-1" },
    },
  ])("rejects a refused $operation with its operation context and server metadata", async ({ label, rpc, invoke, args }) => {
    const refusal = {
      code: "22023", message: "campaign transition unavailable",
      details: "campaign_state_conflict", hint: "Reload the campaign",
    };
    const client = clientReturning(null, refusal);

    await expect(invoke(client)).rejects.toMatchObject({
      name: "MemberApiError", label, message: `${label}: ${refusal.message}`,
      code: refusal.code, details: refusal.details, hint: refusal.hint,
    });
    expect(client.calls).toEqual([[rpc, args]]);
  });

  it("throws the server message without a table fallback", async () => {
    const client = { rpc: async () => ({ data: null, error: { message: "campaign scope unavailable" } }) };
    await expect(loadCampaigns(client)).rejects.toThrow("campaign scope unavailable");
  });
});

describe("campaign publish refusal", () => {
  it("requires a passed date and the exact server refusal, with either transport", () => {
    const now = Date.parse("2030-01-01T12:00:00Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const past = new Date(now - 1).toISOString();
      const future = new Date(now + 1).toISOString();
      const refusal = { code: "22023", message: "campaign is not ready to publish" };
      expect(campaignCloseDatePassed(new Date(now).toISOString())).toBe(true);
      expect(campaignCloseDatePassed("not a date")).toBe(false);
      expect(CAMPAIGN_PUBLISH_CLOCK_ALLOWANCE_MS).toBe(5 * 60000);
      expect(campaignPublishWithdrawn(new Date(now - 2 * 60000).toISOString())).toBe(false);
      expect(campaignPublishWithdrawn(new Date(now - 6 * 60000).toISOString())).toBe(true);
      expect(campaignPublishWithdrawn(new Date(now + 2 * 60000).toISOString())).toBe(false);
      expect(campaignPublishWithdrawn(new Date(now - 5 * 60000).toISOString())).toBe(false);
      expect(campaignPublishWithdrawn(new Date(now - 5 * 60000 - 1).toISOString())).toBe(true);
      for (const missing of [null, undefined, "", "not a date"]) {
        expect(campaignCloseDatePassed(missing)).toBe(false);
        expect(campaignPublishWithdrawn(missing)).toBe(false);
        expect(isCampaignCloseDateRefusal(refusal, missing)).toBe(false);
      }
      expect(isCampaignCloseDateRefusal(refusal, past)).toBe(true);
      expect(isCampaignCloseDateRefusal({ ...refusal, message: `Publish campaign: ${refusal.message}` }, past)).toBe(true);
      expect(isCampaignCloseDateRefusal(refusal, future)).toBe(false);
      expect(isCampaignCloseDateRefusal(refusal, "not a date")).toBe(false);
      for (const error of [null, undefined, "campaign is not ready to publish", {}, { ...refusal, code: "42501" }, { ...refusal, message: "campaign not found" }]) {
        expect(isCampaignCloseDateRefusal(error, past)).toBe(false);
      }
    } finally { clock.mockRestore(); }
  });
});
