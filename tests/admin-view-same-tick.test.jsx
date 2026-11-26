import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, it, vi } from "vitest";
import { AdminView } from "../src/views/AdminView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { expectOneWriteForSameTickDouble } from "./helpers/sameTickActivation.js";

// The admin desk slice of record #8435 (#8746). Two
// activations inside one React update, before the busy state renders, send the
// write once; only AdminView's runBusyWrite locks can refuse the second:
// "admin" for run(), "invitation" for Send invitation and for Resend or Revoke,
// and "holdSearch" for the legal hold search.
const desk = (invitations) => ({ ...JSON.parse(JSON.stringify(fallbackData.adminDesk)), ...(invitations ? { invitations } : {}) });

function renderAdmin(api, data = { member: { initials: "AR", chapterName: "Cedar Ridge Care Services", organizationRoles: ["admin"] }, rewardItems: [] }) {
  render(<LanguageProvider lang="en"><AdminView data={data} api={api} onNotice={vi.fn()} /></LanguageProvider>);
}

describe("admin desk writes, two activations in one React update", () => {

  it("resends an invitation once", async () => {
    const invitation = {
      id: "9c6f596a-e8ae-4a8a-95c7-9f620671047e", normalizedEmail: "rosa@example.org", fullName: "Rosa Delgado",
      initialRole: null, locale: "es", status: "pending", deliveryVersion: 1,
      createdLabel: "Aug 12 · 2:00 PM", expiresLabel: "Aug 12 · 2:15 PM",
    };
    const chapter = { id: "tamarack-north", name: "Tamarack North" };
    const api = {
      loadDesk: vi.fn().mockResolvedValue(desk({ chapter, chapters: [{ ...chapter, grantsAccess: true }], items: [invitation] })),
      loadInvitations: vi.fn().mockResolvedValue({ chapter, items: [invitation] }),
      listChapterUnits: vi.fn().mockResolvedValue([]),
      grantRole: vi.fn(), revokeRole: vi.fn(), searchMembers: vi.fn(),
      inviteMember: vi.fn(), resendInvitation: vi.fn().mockResolvedValue({ accepted: true }), revokeInvitation: vi.fn(),
    };
    renderAdmin(api, { member: { initials: "AR" }, rewardItems: [] });
    const card = (await screen.findByRole("heading", { name: "Invite a worker" })).closest("article");
    const resend = await within(card).findByRole("button", { name: "Resend" });
    await expectOneWriteForSameTickDouble(api.resendInvitation, () => resend.click());
  });

  it("searches held conversations once", async () => {
    const api = {
      loadDesk: vi.fn().mockResolvedValue(desk()),
      grantRole: vi.fn(), revokeRole: vi.fn(), searchMembers: vi.fn().mockResolvedValue([]),
      loadFailedLoginInbox: vi.fn().mockResolvedValue({ items: [], openLast24Hours: 0, attentionThreshold: 5 }),
      listLegalHolds: vi.fn().mockResolvedValue([]),
      loadHoldConversations: vi.fn().mockResolvedValue({ rows: [], nextCursor: null }),
    };
    renderAdmin(api);
    fireEvent.change(await screen.findByLabelText("Find a conversation"), { target: { value: "cole" } });
    const search = screen.getByRole("button", { name: "Search conversations" });
    await expectOneWriteForSameTickDouble(api.loadHoldConversations, () => search.click());
  });
});
