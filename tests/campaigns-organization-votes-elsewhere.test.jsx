// BUG-UG-COUNTS-AND-STATUSES-DISAGREE-BETWEEN-PAGES-20261122 (#9533,
// B-43): a chapter steward's Campaigns page read "Open 0" while members of the
// same chapter had six open ballots on Voting. Those ballots are
// organization-wide, and get_staff_vote_campaigns lists only what the reader
// can manage, so the registry left them out without a word. The page now says
// where organization-wide ballots and pulses are run and where members see
// them, whenever the server answers canManageUnion: false.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CampaignsView } from "../src/views/CampaignsView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

function view(registry, lang = "en") {
  const api = {
    load: vi.fn().mockResolvedValue({ campaigns: [], chapterId: "wor", ...registry }),
    saveDraft: vi.fn(),
    removalDetails: vi.fn().mockResolvedValue({ enabled: false, byId: new Map() }),
  };
  render(<LanguageProvider lang={lang}><CampaignsView api={api} /></LanguageProvider>);
  return api;
}

const note = () => screen.queryByTestId("campaigns-organization-elsewhere");

describe("Campaigns says where organization-wide ballots are run (#9533 B-43)", () => {
  it("tells a chapter steward that organization-wide ballots are not listed here and where members see them", async () => {
    view({ canManageUnion: false, canManageChapter: true });
    expect(await screen.findByTestId("campaigns-organization-elsewhere")).toHaveTextContent(
      "Ballots and pulses for the whole organization are run by an organization-wide Admin or Campaign chair, so they are not listed here. Workers find them under Voting.",
    );
    expect(screen.getByRole("button", { name: "New campaign" })).toBeInTheDocument();
  });

  it("says it in Spanish", async () => {
    view({ canManageUnion: false, canManageChapter: true }, "es");
    expect(await screen.findByTestId("campaigns-organization-elsewhere")).toHaveTextContent(
      "Las votaciones y los sondeos de toda la organización los organiza un Administrador o Presidente de alcance sindical. Por eso no aparecen aquí. Los trabajadores los encuentran en Votaciones.",
    );
  });

  it("sits beside the chapter-leadership line for a unit-limited steward", async () => {
    view({ canManageUnion: false, canManageChapter: false });
    expect(await screen.findByTestId("campaigns-leadership-only")).toBeInTheDocument();
    expect(note()).toBeInTheDocument();
  });

  it("stays away for an organization-wide author, who sees those ballots in the list", async () => {
    const organizationBallot = {
      id: "ballot-org-1", kind: "ballot", scope: "union", state: "open", titleEn: "Relief coverage ballot", titleEs: "Votación sobre cobertura de relevo",
      closesAt: "2026-12-01T17:00:00Z", quorumTarget: 40, options: [{ labelEn: "Yes", labelEs: "Sí" }, { labelEn: "No", labelEs: "No" }],
    };
    view({ canManageUnion: true, canManageChapter: true, campaigns: [organizationBallot] });
    expect(await screen.findByRole("heading", { name: "Relief coverage ballot" })).toBeInTheDocument();
    expect(screen.getByText("All eligible workers in the campaign")).toBeInTheDocument();
    expect(note()).not.toBeInTheDocument();
  });

  it("says nothing while the registry is still loading", async () => {
    const api = { load: vi.fn(() => new Promise(() => {})), saveDraft: vi.fn() };
    render(<LanguageProvider lang="en"><CampaignsView api={api} /></LanguageProvider>);
    expect(await screen.findByText("Loading campaigns…")).toBeInTheDocument();
    expect(note()).not.toBeInTheDocument();
  });

  it("says nothing when the registry could not be read", async () => {
    const api = { load: vi.fn().mockRejectedValue(new Error("offline")), saveDraft: vi.fn() };
    render(<LanguageProvider lang="en"><CampaignsView api={api} /></LanguageProvider>);
    expect(await screen.findByText("Campaigns are unavailable.")).toBeInTheDocument();
    expect(note()).not.toBeInTheDocument();
  });

  it("stays away when the answer does not say", async () => {
    view({});
    expect(await screen.findByRole("button", { name: "New campaign" })).toBeInTheDocument();
    expect(note()).not.toBeInTheDocument();
  });
});
