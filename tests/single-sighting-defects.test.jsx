import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChannelOperations } from "../src/features/engagement/StaffEngagement.jsx";
import { createInMemoryQaStore, createQaStoreAdapter } from "../src/features/qa/index.js";
import { t } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { buildQaActor } from "../src/lib/mi1QaWiring.js";
import { MEMBER_HOME_SLICE_ABSENT_KEYS, MEMBER_HOME_SLICE_VALUE_KEYS, memberHomeSliceFromProjection } from "../src/lib/memberHomeSlice.js";
import { rewardProgress } from "../src/lib/rewardProgress.js";
import { MemberQaView } from "../src/views/MemberQaView.jsx";

// REQ-UG-SINGLE-SIGHTING-DEFECTS-20261030: the single sightings that
// reproduce from the code (findings 71, 79 and 83). Finding 112 is pinned in
// tests/evidence-upload.test.jsx; finding 78 and the email activation half of
// 79 are closed with reasons in the pull request body.

const wrap = (ui, lang = "en") => render(<LanguageProvider lang={lang}>{ui}</LanguageProvider>);

describe("finding 71: Home tier card after a reload", () => {
  it("keeps the reward summary out of the saved Home copy instead of saving an empty Tier 0", () => {
    const projection = {
      member: { id: "m1", firstName: "Ada" },
      rewards: { totalPoints: 120, tierNumber: 1, tierName: "Worker", nextTierName: "Organizer", pointsToGo: 30, isMaxTier: false, weekStreak: 2, actionsYtd: 4 },
      weekly: { done: 2, goal: 5, streakDays: 2 },
    };
    const { projection: slice } = memberHomeSliceFromProjection(projection);
    expect(slice.rewards).toBeNull();
    expect(MEMBER_HOME_SLICE_ABSENT_KEYS).toContain("rewards");
    expect(MEMBER_HOME_SLICE_VALUE_KEYS).not.toContain("rewards");
    // Home reads rewards through rewardProgress and renders the tier card only
    // when it is present, so a null summary shows no "Tier 0 ·" card.
    expect(rewardProgress(slice.rewards, []).rewards).toBeNull();
  });
});

describe("finding 79: Engagement studio Channels tab", () => {
  it("explains an empty Channels tab instead of rendering nothing", () => {
    wrap(<ChannelOperations channels={[]} client={null} onUpdated={() => {}} onNotice={() => {}} />);
    expect(screen.getByText(t("en", "engagement.channelsEmpty"))).toBeInTheDocument();
  });

  it("says it in Spanish too", () => {
    wrap(<ChannelOperations channels={[]} client={null} onUpdated={() => {}} onNotice={() => {}} />, "es");
    expect(screen.getByText(t("es", "engagement.channelsEmpty"))).toBeInTheDocument();
    expect(t("es", "engagement.channelsEmpty")).not.toBe(t("en", "engagement.channelsEmpty"));
  });
});

describe("finding 83: a Q&A post that looks failed after it saved", () => {
  it("keeps the list and says the question saved when only the refresh after posting fails", async () => {
    const actor = buildQaActor({ userId: "member-a", organizationId: "org-a", chapterId: "ch-a", mfaSatisfied: true });
    const store = createInMemoryQaStore();
    const base = createQaStoreAdapter(store, actor);
    let failReads = false;
    const api = {
      ...base,
      list: (query) => (failReads ? Promise.resolve({ ok: false, error: { code: "network" } }) : base.list(query)),
      get: (id) => (failReads ? Promise.resolve({ ok: false, error: { code: "network" } }) : base.get(id)),
      ask: async (input) => {
        const result = await base.ask(input);
        failReads = true;
        return result;
      },
    };
    wrap(<MemberQaView actor={actor} client={null} api={api} />);
    expect(await screen.findByText("No questions yet. Ask the first one for this campaign.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ask a question" }));
    fireEvent.change(screen.getByLabelText("Question title"), { target: { value: "When is the next chapter meeting?" } });
    fireEvent.change(screen.getByLabelText("Details"), { target: { value: "I want to confirm the date and location for the next meeting." } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Post question" })); });
    await waitFor(() => expect(screen.getByText(t("en", "qa.savedRefreshFailed"))).toBeInTheDocument());
    // The saved question is in the store once, and nothing was asked twice.
    failReads = false;
    const listed = await base.list({});
    const rows = Array.isArray(listed.value) ? listed.value : listed.value?.questions || [];
    expect(rows.filter((row) => row.title === "When is the next chapter meeting?")).toHaveLength(1);
  });

  it("keeps the page and says the save landed when only the question's own refresh fails", async () => {
    const actor = buildQaActor({ userId: "member-b", organizationId: "org-a", chapterId: "ch-a", mfaSatisfied: true });
    const base = createQaStoreAdapter(createInMemoryQaStore(), actor);
    let failDetail = false;
    const api = {
      ...base,
      get: (id) => (failDetail ? Promise.resolve({ ok: false, error: { code: "network" } }) : base.get(id)),
      ask: async (input) => {
        const result = await base.ask(input);
        failDetail = true;
        return result;
      },
    };
    wrap(<MemberQaView actor={actor} client={null} api={api} />);
    expect(await screen.findByText("No questions yet. Ask the first one for this campaign.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ask a question" }));
    fireEvent.change(screen.getByLabelText("Question title"), { target: { value: "Where do we meet in November?" } });
    fireEvent.change(screen.getByLabelText("Details"), { target: { value: "The room changed last month; is it the same now?" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Post question" })); });
    await waitFor(() => expect(screen.getByText(t("en", "qa.savedRefreshFailed"))).toBeInTheDocument());
  });
});
