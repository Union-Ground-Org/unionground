import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { VotingView } from "../src/views/VotingView.jsx";
import { NumbersView } from "../src/views/NumbersView.jsx";
import { WORKLOAD_CATEGORY_KEYS } from "../src/lib/workloadCategories.js";
import { CollectiveActionsView } from "../src/views/CollectiveActionsView.jsx";
import { Countdown, countdownText } from "../src/alt/takepart/Countdown.jsx";
import { stripDays } from "../src/alt/takepart/CampaignPage.jsx";
import { altTakePartCatalogue } from "../src/lib/i18n/altTakePart.js";
import { t } from "../src/lib/i18n.js";
import { ORGANIZATION_INTELLIGENCE_PREVIEW_ORGANIZATION } from "./fixtures/retired-pre-bot/src/features/organizationIntelligence/preview.js";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

// REQ-UG-ALT-PORT-MEMBER-PAGES-20261030: the alternate shell's Votes,
// Statistics and Campaign pages are the prototype's pages (pages/votes.js,
// stats.js, campaign.js) drawn on the member's live data and the views' own
// handlers, with honest empty states where no record backs a surface.

const DAY = 86_400_000;
const en = (key, vars) => t("en", key, vars);
const es = (key, vars) => t("es", key, vars);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.history.replaceState({}, "", "/");
});

// ── Votes ────────────────────────────────────────────────────────────────

function ballots() {
  const closesAt = new Date(Date.now() + 2 * DAY + 3 * 3_600_000).toISOString();
  return [
    { id: "b1", kind: "ballot", title: "Ratify the agreement", meta: "Closes Fri", closesAt, body: "A three-year deal.", options: [{ id: "y", label: "Yes, ratify" }, { id: "n", label: "No" }], receiptCode: "", quorum: { totalVotes: 60, quorumTarget: 150 } },
    { id: "b2", kind: "ballot", title: "Chapter officer", meta: "Closes Nov 9", options: [{ id: "a", label: "Candidate A" }, { id: "b", label: "Candidate B" }], receiptCode: "" },
    { id: "b3", kind: "ballot", title: "Bylaws change", meta: "Closes Nov 12", options: [{ id: "k", label: "Keep" }], receiptCode: "SG-AAAA-BBBB" },
    { id: "b4", kind: "ballot", title: "Show of support", meta: "Closes Nov 14", options: [], receiptCode: "" },
    { id: "p1", kind: "pulse", title: "Which support helps?", meta: "2-min pulse", body: "Pick one.", options: [{ id: "m", label: "A mentor" }], selectedOption: "" },
    { id: "p2", kind: "pulse", title: "Answered survey", meta: "Closes Sep 4", options: [{ id: "x", label: "Office hours" }], selectedOption: "x" },
    { id: "p3", kind: "pulse", title: "Closed survey", meta: "Closed", closed: true, options: [], selectedOption: "" },
    { id: "b9", kind: "ballot", title: "Contract action plan", meta: "Closed Jun 26", closed: true, receiptCode: "SG-CCCC-DDDD", quorum: { totalVotes: 213, quorumTarget: 300 }, results: [{ optionId: "y", label: "Yes", votes: 154 }, { optionId: "n", label: "No", votes: 59 }] },
    { id: "b10", kind: "ballot", title: "Tied vote", meta: "Closed Jun 1", closed: true, receiptCode: "", results: [{ optionId: "y", label: "Yes", votes: 5 }, { optionId: "n", label: "No", votes: 5 }] },
  ];
}

function showVotes({ lang = "en", planItems = ballots(), ...props } = {}) {
  const handlers = { onPlanAction: vi.fn(), onMessageSteward: vi.fn(), onSuggestPoll: vi.fn().mockResolvedValue(undefined), onOpenHome: vi.fn(), ...props };
  render(<LanguageProvider lang={lang}><VotingView alt desktop data={{ planItems }} {...handlers} /></LanguageProvider>);
  return handlers;
}

describe("the alternate shell's Votes page", () => {
  it("draws the prototype's hero and open ballot card on the member's ballots and casts through onPlanAction", () => {
    const handlers = showVotes();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Vote from anywhere");
    expect(document.querySelector(".ug-page-hero h1 .ug-accent")).toHaveTextContent("anywhere");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", { name: "Now" }));
    expect(handlers.onOpenHome).toHaveBeenCalled();

    const card = screen.getByRole("heading", { name: "Ratify the agreement" }).closest("article");
    expect(card).toHaveClass("ug-vote-card");
    expect(within(card).getByText("40%")).toHaveClass("ug-count-big");
    expect(within(card).getByText("60 of 150 votes needed for quorum")).toBeInTheDocument();
    expect(within(card).getByText("Quorum not reached yet")).toBeInTheDocument();
    expect(card.querySelector(".ug-progress i")).toHaveStyle({ width: "40%" });
    expect(card.querySelector(".ug-ta-countdown").textContent).toMatch(/^2d (2h 59m|3h 00m)$/);
    expect(within(card).getByText(/Polls close/)).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "Cast my vote" }));
    expect(handlers.onPlanAction).toHaveBeenCalledWith(expect.objectContaining({ id: "b1" }));
    fireEvent.click(within(card).getByRole("button", { name: en("voting.readSummary") }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("dialog").closest(".ug-legacy")).not.toBeNull();
  });

  it("opens the quorum explainer from the card", () => {
    showVotes();
    fireEvent.click(screen.getByRole("button", { name: en("voting.quorumTitle") }));
    expect(screen.getByRole("dialog")).toHaveTextContent(en("voting.quorumExplain"));
  });

  it("casts and closes from the production detail dialogs", async () => {
    const handlers = showVotes();
    const card = screen.getByRole("heading", { name: "Ratify the agreement" }).closest("article");
    fireEvent.click(within(card).getByRole("button", { name: en("voting.readSummary") }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: en("voting.detailVote") }));
    expect(handlers.onPlanAction).toHaveBeenCalledWith(expect.objectContaining({ id: "b1" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: en("voting.quorumTitle") }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: en("voting.castVote") }));
    expect(handlers.onPlanAction).toHaveBeenCalledTimes(2);
    fireEvent.click(within(card).getByRole("button", { name: en("voting.readSummary") }));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".sg-detail-layer")).toBeNull());
    fireEvent.click(within(card).getByRole("button", { name: en("voting.quorumTitle") }));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".sg-detail-layer")).toBeNull());
  });

  it("scrolls a linked survey into view and routes a question to a steward without a poll backend", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 0; });
    try {
      window.history.replaceState({}, "", "/m/voting?survey=p1");
      const handlers = showVotes({ onSuggestPoll: undefined });
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
      fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "Can we vote online?" } });
      fireEvent.click(screen.getByRole("button", { name: "Send for review" }));
      expect(handlers.onMessageSteward).toHaveBeenCalledWith("Can we vote online?");
    } finally {
      raf.mockRestore();
      delete Element.prototype.scrollIntoView;
    }
  });

  it("asks for a pick on an official ballot, then hands the pick to the confirmation dialog", () => {
    const handlers = showVotes();
    const panel = screen.getByRole("heading", { name: "Chapter officer" }).closest("article");
    fireEvent.click(within(panel).getByRole("button", { name: "Submit ballot" }));
    expect(within(panel).getByRole("alert")).toHaveTextContent("Pick an option first.");
    expect(handlers.onPlanAction).not.toHaveBeenCalled();
    const candidate = within(panel).getByRole("radio", { name: "Candidate B" });
    fireEvent.click(candidate);
    expect(candidate).toHaveAttribute("aria-checked", "true");
    expect(within(panel).queryByRole("alert")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Submit ballot" }));
    expect(handlers.onPlanAction).toHaveBeenCalledWith(expect.objectContaining({ id: "b2", selectedOption: "b" }));
    // A ballot without options submits straight to the dialog.
    const support = screen.getByRole("heading", { name: "Show of support" }).closest("article");
    fireEvent.click(within(support).getByRole("button", { name: "Submit ballot" }));
    expect(handlers.onPlanAction).toHaveBeenLastCalledWith(expect.objectContaining({ id: "b4" }));
    // A voted official ballot shows its receipt and never echoes the choice.
    const voted = screen.getByRole("heading", { name: "Bylaws change" }).closest("article");
    expect(within(voted).getByText("SG-AAAA-BBBB")).toHaveClass("ug-mono");
    expect(within(voted).queryByRole("radio")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: en("voting.readSummary") }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Candidate B");
  });

  it("puts surveys in the ballot column with their recorded and closed states", () => {
    const handlers = showVotes();
    const survey = screen.getByRole("heading", { name: "Which support helps?" }).closest("article");
    fireEvent.click(within(survey).getByRole("button", { name: "A mentor" }));
    expect(handlers.onPlanAction).toHaveBeenCalledWith(expect.objectContaining({ id: "p1", selectedOption: "m" }));
    expect(screen.getByRole("heading", { name: "Answered survey" }).closest("article")).toHaveTextContent("\"Office hours\" recorded");
    expect(screen.getByRole("heading", { name: "Closed survey" }).closest("article")).toHaveTextContent("Closed");
  });

  it("keeps the live show of hands and the review queue as honest empty states", () => {
    showVotes();
    const live = screen.getByRole("heading", { name: "No show of hands is open" }).closest("article");
    expect(live).toHaveClass("ug-script");
    expect(live).toHaveTextContent("A show of hands is not secret.");
    expect(screen.getByText("Nothing to show here yet")).toBeInTheDocument();
  });

  it("sends a poll question through onSuggestPoll with its audience and offers another", async () => {
    const handlers = showVotes();
    const box = screen.getByRole("textbox", { name: "Your question" });
    expect(screen.getByRole("button", { name: "Send for review" })).toBeDisabled();
    fireEvent.change(box, { target: { value: "Should we meet on Fridays?" } });
    fireEvent.click(screen.getByRole("radio", { name: "Whole local" }));
    fireEvent.click(screen.getByRole("button", { name: "Send for review" }));
    await waitFor(() => expect(handlers.onSuggestPoll).toHaveBeenCalledWith("Should we meet on Fridays?", "local"));
    fireEvent.click(await screen.findByRole("button", { name: en("voting.suggestAnother") }));
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: en("voting.messageSteward") }));
    expect(handlers.onMessageSteward).toHaveBeenCalled();
  });

  it("lists past votes with their published leader and opens the read-only detail", () => {
    showVotes();
    const past = document.getElementById("ug-votes-past");
    const rows = within(past).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Contract action plan");
    expect(rows[0]).toHaveTextContent("213 of 300 votes needed for quorum");
    expect(within(rows[0]).getByText("Yes 72%")).toHaveClass("ug-t-win");
    expect(within(rows[1]).getByText("Closed")).toHaveClass("ug-t-vote");
    fireEvent.click(within(rows[0]).getByRole("button", { name: "Contract action plan" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("154 votes · 72%");
  });

  it("checks a receipt with verify_ballot_receipt and reports every outcome", async () => {
    const verifyReceipt = vi.fn()
      .mockResolvedValueOnce({ found: true, counted: true, ballotTitle: "Contract action plan", issuedAt: "2026-06-20T15:00:00Z" })
      .mockResolvedValueOnce({ found: true, counted: false, ballotTitle: "Contract action plan" })
      .mockResolvedValueOnce({ found: false })
      .mockRejectedValueOnce(new Error("offline"));
    showVotes({ verifyReceipt });
    const form = document.getElementById("ug-votes-verify");
    const submit = within(form).getByRole("button", { name: "Check receipt" });
    fireEvent.click(submit);
    expect(within(form).getByText("Enter the code from your receipt.")).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText(en("verify.codeLabel")), { target: { value: " sg-cccc-dddd " } });
    fireEvent.click(submit);
    await within(form).findByText(/Contract action plan · Issued/);
    expect(verifyReceipt).toHaveBeenCalledWith("sg-cccc-dddd");
    fireEvent.click(submit);
    await within(form).findByText(/Receipt found — not marked counted/);
    fireEvent.click(submit);
    await within(form).findByText(en("verify.notFoundBody"));
    fireEvent.click(submit);
    await within(form).findByText(en("verify.lookupFailed"));
    expect(within(form).getAllByRole("listitem")).toHaveLength(4);
  });

  // #9914 (carved from #8435): Check receipt was natively disabled while its
  // lookup ran, so a keyboard user who pressed it lost focus to the page.
  it("keeps focus on Check receipt while the lookup runs, and a second press looks nothing up", async () => {
    const verifyReceipt = vi.fn().mockResolvedValue({ found: false });
    showVotes({ verifyReceipt });
    const form = document.getElementById("ug-votes-verify");
    fireEvent.change(within(form).getByLabelText(en("verify.codeLabel")), { target: { value: "SG-1111-2222" } });
    await expectHeldWriteFocus(verifyReceipt, within(form).getByRole("button", { name: "Check receipt" }));
    await within(form).findByText(en("verify.notFoundBody"));
  });

  it("says verification is not connected when the app has no live backend", () => {
    showVotes();
    const form = document.getElementById("ug-votes-verify");
    fireEvent.change(within(form).getByLabelText(en("verify.codeLabel")), { target: { value: "SG-1111-2222" } });
    fireEvent.click(within(form).getByRole("button", { name: "Check receipt" }));
    expect(within(form).getByText(en("verify.notConnected"))).toBeInTheDocument();
  });

  it("shows the member's own receipt with a copy button once they have voted", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      const items = ballots();
      items[0] = { ...items[0], receiptCode: "SG-7F2K-0630", quorum: { totalVotes: 150, quorumTarget: 150 }, closesAt: null };
      showVotes({ planItems: items });
      const card = screen.getByRole("heading", { name: "Ratify the agreement" }).closest("article");
      expect(within(card).getByText("Your ballot is in.")).toBeInTheDocument();
      expect(within(card).getByText("Quorum reached")).toBeInTheDocument();
      expect(within(card).getByText("Closes Fri")).toHaveClass("ug-tag");
      expect(within(card).queryByRole("button", { name: "Cast my vote" })).toBeNull();
      fireEvent.click(within(card).getByRole("button", { name: "Copy" }));
      await within(card).findByRole("button", { name: "Copied" });
      expect(writeText).toHaveBeenCalledWith("SG-7F2K-0630");
    } finally {
      delete navigator.clipboard;
    }
  });

  // #9463 (W2-11): a refused clipboard said nothing. The wording is pinned
  // as literal text so a catalogue edit cannot pass unread.
  const COPY_TEXT = {
    en: { copy: "Copy", copied: "Copied", failed: "Could not copy. Select the code and copy it." },
    es: { copy: "Copiar", copied: "Copiado", failed: "No se pudo copiar. Selecciona el código y cópialo." },
  };
  const receiptCard = (lang = "en") => {
    const items = ballots();
    items[0] = { ...items[0], receiptCode: "SG-7F2K-0630" };
    showVotes({ lang, planItems: items });
    return document.querySelector(".ug-ta-vote");
  };
  const withClipboard = async (writeText, body) => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      await body();
    } finally {
      delete navigator.clipboard;
    }
  };

  it.each(["en", "es"])("says a refused copy beside the receipt code (%s)", (lang) =>
    withClipboard(vi.fn().mockRejectedValue(new Error("denied")), async () => {
      const card = receiptCard(lang);
      fireEvent.click(within(card).getByRole("button", { name: COPY_TEXT[lang].copy }));
      expect(await within(card).findByRole("alert")).toHaveTextContent(COPY_TEXT[lang].failed);
      expect(within(card).getByRole("button", { name: COPY_TEXT[lang].copy })).toBeInTheDocument();
    }));

  it("says a copy that throws at once the same way (#9463)", () =>
    withClipboard(vi.fn(() => { throw new Error("not allowed"); }), async () => {
      const card = receiptCard();
      fireEvent.click(within(card).getByRole("button", { name: "Copy" }));
      expect(await within(card).findByRole("alert")).toHaveTextContent(COPY_TEXT.en.failed);
    }));

  it("clears the refused-copy line when the next copy of the same code works (#9463)", () =>
    withClipboard(vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValueOnce(undefined), async () => {
      const card = receiptCard();
      fireEvent.click(within(card).getByRole("button", { name: "Copy" }));
      await within(card).findByRole("alert");
      fireEvent.click(within(card).getByRole("button", { name: "Copy" }));
      await within(card).findByRole("button", { name: "Copied" });
      expect(within(card).queryByRole("alert")).toBeNull();
      expect(within(card).queryByText(COPY_TEXT.en.failed)).toBeNull();
    }));

  it("lets only the latest copy set the line when an older refusal settles late (#9463)", () => {
    let failFirst;
    const writeText = vi.fn().mockReturnValueOnce(new Promise((_, reject) => { failFirst = reject; })).mockResolvedValueOnce(undefined);
    return withClipboard(writeText, async () => {
      const card = receiptCard();
      fireEvent.click(within(card).getByRole("button", { name: "Copy" }));
      fireEvent.click(within(card).getByRole("button", { name: "Copy" }));
      await within(card).findByRole("button", { name: "Copied" });
      await act(async () => { failFirst(new Error("denied")); });
      expect(within(card).queryByRole("alert")).toBeNull();
      expect(within(card).getByRole("button", { name: "Copied" })).toBeInTheDocument();
    });
  });

  it("keeps a newer refusal when an older copy succeeds late (#9463)", () => {
    let passFirst;
    const writeText = vi.fn().mockReturnValueOnce(new Promise((resolve) => { passFirst = resolve; })).mockRejectedValueOnce(new Error("denied"));
    return withClipboard(writeText, async () => {
      const card = receiptCard();
      fireEvent.click(within(card).getByRole("button", { name: "Copy" }));
      fireEvent.click(within(card).getByRole("button", { name: "Copy" }));
      expect(await within(card).findByRole("alert")).toHaveTextContent(COPY_TEXT.en.failed);
      await act(async () => { passFirst(); });
      expect(within(card).getByRole("alert")).toHaveTextContent(COPY_TEXT.en.failed);
      expect(within(card).getByRole("button", { name: "Copy" })).toBeInTheDocument();
      expect(within(card).queryByRole("button", { name: "Copied" })).toBeNull();
    });
  });

  it("labels demo receipts as previews and offers no verification form", () => {
    const items = ballots();
    items[0] = { ...items[0], receiptCode: "K7TQ2MRX", quorum: null };
    showVotes({ planItems: items, demo: true });
    const card = screen.getByRole("heading", { name: "Ratify the agreement" }).closest("article");
    expect(card).toHaveTextContent("Preview receipt K7TQ2MRX");
    expect(within(card).getByText("Turnout for this ballot isn't available yet.")).toBeInTheDocument();
    expect(document.getElementById("ug-votes-verify")).toHaveTextContent(en("voting.sampleReceipt"));
    expect(screen.queryByRole("button", { name: "Check receipt" })).toBeNull();
  });

  it("says when nothing is open or past, and hides the question box without a handler", () => {
    showVotes({ planItems: [], onSuggestPoll: undefined, onMessageSteward: undefined });
    expect(screen.getByRole("heading", { name: en("voting.noOpenTitle") })).toBeInTheDocument();
    expect(screen.getByText(en("voting.pastEmpty"))).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Your question" })).toBeNull();
    expect(screen.queryByRole("button", { name: en("voting.messageSteward") })).toBeNull();
  });

  it("brings Past votes into view on the routed past page", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      window.history.replaceState({}, "", "/m/voting/past");
      render(
        <LanguageProvider lang="en">
          <WorkspacePages view="voting" hat="member" location={window.location.href} navigate={vi.fn()}>
            <VotingView alt data={{ planItems: ballots() }} onPlanAction={vi.fn()} />
          </WorkspacePages>
        </LanguageProvider>,
      );
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    } finally {
      delete Element.prototype.scrollIntoView;
    }
  });

  it("speaks Spanish", () => {
    showVotes({ lang: "es" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Vota desde cualquier lugar");
    expect(screen.getByRole("heading", { name: es("altTakePart.liveNoneTitle") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar a revisión" })).toBeInTheDocument();
  });

  it("keeps the classic page when alt is off", () => {
    render(<LanguageProvider lang="en"><VotingView desktop data={{ planItems: ballots() }} onPlanAction={vi.fn()} /></LanguageProvider>);
    expect(document.querySelector(".voting-ph__title")).toHaveTextContent(en("voting.desktopTitle"));
    expect(document.querySelector(".ug-page-hero")).toBeNull();
  });
});

describe("the ballot countdown", () => {
  it("formats like the prototype's fmt.countdown", () => {
    expect(countdownText(0)).toBe("0:00");
    expect(countdownText(Number.NaN)).toBe("0:00");
    expect(countdownText(65_000)).toBe("1:05");
    expect(countdownText(3 * 3_600_000 + 5 * 60_000)).toBe("3h 05m");
    expect(countdownText(2 * DAY + 4 * 3_600_000)).toBe("2d 4h 00m");
  });

  it("ticks every second and stops at the close", () => {
    vi.useFakeTimers();
    render(<Countdown target={Date.now() + 2_000} />);
    expect(document.querySelector(".ug-ta-countdown")).toHaveTextContent("0:02");
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(document.querySelector(".ug-ta-countdown")).toHaveTextContent("0:01");
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(document.querySelector(".ug-ta-countdown")).toHaveTextContent("0:00");
  });

  it("does not tick under reduced motion", () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    try {
      vi.useFakeTimers();
      render(<Countdown target={Date.now() + 65_000} />);
      act(() => { vi.advanceTimersByTime(5_000); });
      expect(document.querySelector(".ug-ta-countdown")).toHaveTextContent("1:05");
    } finally {
      window.matchMedia = original;
    }
  });
});

// ── Statistics ───────────────────────────────────────────────────────────

function reportsData(extra = {}) {
  const zeroCounts = Object.fromEntries(WORKLOAD_CATEGORY_KEYS.map(key => [key, 0]));
  return {
    member: { id: "member-1" },
    rewards: { totalPoints: 340, tierNumber: 1, pointsToGo: 160, nextTierName: "Organizer", weekStreak: 3, actionsYtd: 12 },
    rewardsCatalog: { tiers: [{ tier: 1, name: "Member", minPoints: 0 }, { tier: 2, name: "Organizer", minPoints: 500 }] },
    weekly: { goal: 3, done: 2 },
    weekDays: [{ label: "Mon", active: true }, { label: "Tue", active: false }, { label: "Wed", active: true }],
    planItems: [
      { id: "b1", kind: "ballot", title: "Ratify the agreement", receiptCode: "SG-1", quorum: { totalVotes: 60, quorumTarget: 150 } },
      { id: "b9", kind: "ballot", title: "Contract action plan", closed: true, receiptCode: "", quorum: { totalVotes: 213, quorumTarget: 300 } },
      { id: "p1", kind: "pulse", title: "Pulse", selectedOption: "" },
    ],
    metrics: { tasksDone: 4, caseTypes: [{ label: "Discipline", value: 2 }], openCases: 1, resolvedCases: 2, casesHandled: 3 },
    workload: { entries: [{ createdAt: "2026-10-20T13:00:00Z", dateLabel: "Oct 20", counts: { ...zeroCounts, priority: 3, pending: 2 } }, { createdAt: "2026-10-13T13:00:00Z", dateLabel: "Oct 13", counts: { ...zeroCounts, priority: 4 } }] },
    rights: { lessonRecords: [{ label: "Weingarten", steps: [1, 2], completedSteps: [1] }] },
    ...extra,
  };
}

function showReports({ lang = "en", data = reportsData(), ...props } = {}) {
  const handlers = { onSavePreferences: vi.fn().mockResolvedValue(undefined), onExport: vi.fn(), onOpenHome: vi.fn(), ...props };
  render(<LanguageProvider lang={lang}><NumbersView alt data={data} {...handlers} /></LanguageProvider>);
  return handlers;
}

const panelOf = (name) => screen.getAllByRole("heading", { level: 2, name })[0].closest(".ug-panel");

describe("the alternate shell's Statistics page", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps unknown workload out of the chart, table and export", () => {
    const data = reportsData();
    data.workload.entries.unshift({ dateLabel: "Unknown", counts: Object.fromEntries(WORKLOAD_CATEGORY_KEYS.map(key => [key, null])) });
    const handlers = showReports({ data });
    const workload = panelOf(en("reports.workloadTitle"));
    fireEvent.click(within(workload).getByRole("button", { name: "Show table" }));
    expect(within(workload).queryByText("Unknown")).toBeNull();
    expect(within(workload).getByRole("row", { name: /Oct 20 5/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export reports" }));
    expect(handlers.onExport).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ key: "hours", value: "4.5" })]));
  });

  it("draws the hero, figures row and one chart panel per report card on the member's record", () => {
    const handlers = showReports();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("What your record adds up to");
    fireEvent.click(screen.getByRole("link", { name: "Now" }));
    expect(handlers.onOpenHome).toHaveBeenCalled();
    expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByText(en("reports.title"))).toHaveAttribute("aria-current", "page");
    const kpis = document.querySelector(".ug-alt-page-kpis");
    expect(kpis).toHaveTextContent(`${en("altShell.kpi_cases")}3`);

    // No points card: this edition retired the points economy.
    expect(screen.queryByRole("heading", { name: en("reports.pointsTitle") })).toBeNull();
    const weekly = panelOf(en("reports.weeklyTitle"));
    expect(within(weekly).getByRole("group", { name: en("reports.weeklyTitle") })).toHaveClass("ug-chart");
    expect(within(weekly).getByRole("img", { name: "Mon: ✓" })).toHaveAttribute("data-tip", "Mon");
    // The ✓/— series has no numeric axis.
    expect(weekly.querySelectorAll('text[text-anchor="end"]')).toHaveLength(0);
    const workload = panelOf(en("reports.workloadTitle"));
    expect(workload.querySelectorAll('text[text-anchor="end"]').length).toBeGreaterThan(0);
    expect(workload.querySelector(".ug-note")).toHaveTextContent(en("reports.workloadFoot"));
    expect(document.querySelector(".ug-legacy .mi1-report-card")).not.toBeNull();
  });

  it("switches every chart to its table view", () => {
    showReports();
    const workload = panelOf(en("reports.workloadTitle"));
    const toggle = within(workload).getByRole("button", { name: "Show table" });
    const table = document.getElementById(toggle.getAttribute("aria-controls"));
    expect(table).not.toBeVisible();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("Hide table");
    expect(within(table).getByRole("columnheader", { name: "Item" })).toBeInTheDocument();
    expect(within(table).getByRole("row", { name: /Oct 20 5/ })).toBeInTheDocument();
  });

  it("binds vote turnout to the member's ballots against quorum, with a table", () => {
    showReports();
    const turnout = panelOf("Vote turnout");
    expect(turnout.querySelectorAll(".ug-ta-hbar")).toHaveLength(2);
    expect(turnout).toHaveTextContent("40%");
    expect(turnout).toHaveTextContent("71%");
    fireEvent.click(within(turnout).getByRole("button", { name: "Show table" }));
    expect(within(turnout).getByRole("row", { name: /Contract action plan 71% 213 of 300 votes needed for quorum/ })).toBeInTheDocument();
  });




  it("says so when there is nothing to chart", () => {
    showReports({ data: { member: { id: "member-2" } } });
    expect(screen.getByText("Every card is hidden")).toBeInTheDocument();
    expect(panelOf("Vote turnout").querySelector(".ug-empty")).toHaveTextContent("Turnout shows here once a ballot");
    expect(screen.queryByRole("heading", { name: en("reports.buildTitle") })).toBeNull();
  });

  it("speaks Spanish", () => {
    showReports({ lang: "es" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Lo que suma tu historial");
    expect(screen.getAllByRole("button", { name: "Ver tabla" }).length).toBeGreaterThan(0);
  });

  it("keeps the classic page when alt is off", () => {
    render(<LanguageProvider lang="en"><NumbersView data={reportsData()} /></LanguageProvider>);
    expect(document.querySelector(".reports-lead__title")).toHaveTextContent(en("reports.title"));
    expect(document.querySelector(".ug-page-hero")).toBeNull();
  });
});

// ── Campaign ─────────────────────────────────────────────────────────────

function staff(overrides = {}) {
  return { userId: "staff-1", organizationId: ORGANIZATION_INTELLIGENCE_PREVIEW_ORGANIZATION, selectedHat: "member", organizationRoles: [], membershipStatus: "active", organizationStatus: "active", mfaSatisfied: true, ...overrides };
}

function actionsClient({ actions, nextOffset = null, roles = [], more = [] }) {
  const rpc = vi.fn(async (name, args) => {
    if (name === "get_collective_actions") {
      const page = (args.p_offset ?? 0) === 0 ? { actions, nextOffset } : { actions: more, nextOffset: null };
      return { data: { organizationId: ORGANIZATION_INTELLIGENCE_PREVIEW_ORGANIZATION, generatedAt: "2026-10-30T12:00:00Z", ...page }, error: null };
    }
    if (name === "get_my_chapter_memberships") {
      return { data: [{ selected: true, organizationId: ORGANIZATION_INTELLIGENCE_PREVIEW_ORGANIZATION, organizationRoles: roles, chapterRoles: [] }], error: null };
    }
    return { data: null, error: null };
  });
  return { rpc };
}

const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();
const action = (id, title, extra = {}) => ({ id, kind: "petition", status: "published", title, summary: `${title} summary.`, targetCount: 10, participantCount: 3, viewerParticipation: null, viewerCanEdit: false, startsAt: iso(-2), endsAt: iso(3), ...extra });

function showCampaign({ lang = "en", actor = staff(), client, ...props } = {}) {
  const onOpenHome = vi.fn();
  render(<LanguageProvider lang={lang}><CollectiveActionsView alt onOpenHome={onOpenHome} actor={actor} client={client} lang={lang} {...props} /></LanguageProvider>);
  return { onOpenHome };
}

describe("the alternate shell's Campaign page", () => {
  it("draws the hero, figures, day strip and your part on the live actions", async () => {
    const client = actionsClient({ actions: [
      action("a1", "Staffing petition"),
      action("a2", "Rally at the capitol", { kind: "rally", viewerParticipation: "attendee", participantCount: null }),
      action("a3", "Future picket", { kind: "picket", startsAt: iso(5), endsAt: iso(9) }),
      action("a4", "Old meeting", { kind: "meeting", startsAt: iso(-9), endsAt: iso(-8), viewerParticipation: "attendee" }),
      action("a5", "Undated", { startsAt: null, endsAt: null, strengthPercent: 30 }),
    ] });
    const { onOpenHome } = showCampaign({ client });
    await screen.findByRole("heading", { name: "Staffing petition" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Digital picket line");
    fireEvent.click(screen.getByRole("link", { name: "Now" }));
    expect(onOpenHome).toHaveBeenCalled();
    expect(document.querySelector(".ug-ta-campaign")).toHaveAttribute("data-mi1-surface", "collective-actions");

    const figures = screen.getByRole("region", { name: "Collective action figures" }).querySelector(".ug-kpis");
    const kpi = (label) => within(figures).getByText(label).closest(".ug-kpi");
    expect(kpi("Campaign day")).toHaveTextContent("—No campaign calendar is published");
    expect(kpi("Open now")).toHaveTextContent("3of 5 published");
    expect(kpi("You joined")).toHaveTextContent("21 of 3 open now");
    expect(kpi("People joined")).toHaveTextContent("12across 4 actions");

    const strip = screen.getByRole("group", { name: "Day by day" });
    const days = within(strip).getAllByRole("button");
    expect(days).toHaveLength(30);
    const today = days.find((day) => day.getAttribute("aria-pressed") === "true");
    expect(today).toHaveClass("ug-d30", "ug-today");
    expect(today.getAttribute("aria-label")).toMatch(/· today: /);
    expect(today.getAttribute("aria-label")).toContain("Staffing petition");
    expect(today.getAttribute("aria-label")).toContain("Rally at the capitol");
    const dayPanel = document.querySelector(".ug-ta-day");
    expect(within(dayPanel).getAllByRole("listitem")).toHaveLength(2);
    const opening = days.find((day) => /Future picket/.test(day.getAttribute("aria-label")) && /opens this day/.test(day.getAttribute("aria-label")));
    expect(opening).toHaveClass("ug-future");
    fireEvent.click(opening);
    expect(opening).toHaveAttribute("aria-pressed", "true");
    expect(dayPanel).toHaveTextContent("Future picketopens this day");
    const empty = days[days.length - 1];
    fireEvent.click(empty);
    expect(dayPanel).toHaveTextContent("No actions are scheduled this day.");

    const petition = screen.getByRole("heading", { name: "Staffing petition" }).closest("article");
    expect(within(petition).getByRole("checkbox")).toHaveAttribute("aria-checked", "false");
    const rally = screen.getByRole("heading", { name: "Rally at the capitol" }).closest("article");
    expect(rally).toHaveTextContent(/participation withheld/);
    expect(within(rally).getByRole("checkbox")).toHaveAttribute("aria-checked", "true");
    expect(within(rally).getByRole("checkbox")).toHaveClass("ug-done");
    expect(screen.getByRole("heading", { name: "Future picket" }).closest("article")).toHaveTextContent(/Opens /);
    expect(screen.getByRole("heading", { name: "Old meeting" }).closest("article")).toHaveTextContent(/Participation closed/);
    expect(screen.getByRole("heading", { name: "Old meeting" }).closest("article")).toHaveTextContent(/You joined this action\. · Attendee/);
    expect(screen.getByRole("heading", { name: "Undated" }).closest("article").querySelector("[role=progressbar]")).toHaveAttribute("aria-valuenow", "30");
    expect(screen.getByText("You joined 1 of 3 open actions")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "The demand" }).closest("aside")).toHaveTextContent("No campaign demand is published here yet.");
    expect(screen.queryByRole("heading", { name: "Create action" })).toBeNull();

    fireEvent.click(within(petition).getByRole("checkbox"));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("toggle_digital_action_participation", { p_action_id: "a1", p_participation_kind: "signature", p_joined: true }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
  });

  it("gives managers edit, export, load more and the create form", async () => {
    const actor = staff({ selectedHat: "admin", organizationRoles: ["admin"] });
    const client = actionsClient({ roles: ["admin"], nextOffset: 1, actions: [action("a1", "Staffing petition", { viewerCanEdit: true })], more: [action("a9", "Second page petition")] });
    showCampaign({ actor, client });
    const petition = (await screen.findByRole("heading", { name: "Staffing petition" })).closest("article");
    const form = screen.getByRole("heading", { name: "Create action" }).closest("form");
    expect(form.closest(".ug-legacy")).not.toBeNull();
    fireEvent.click(within(petition).getByRole("button", { name: "Save action" }));
    expect(within(form).getByLabelText("Title")).toHaveValue("Staffing petition");
    fireEvent.click(within(petition).getByText("Export participant list"));
    fireEvent.click(within(petition).getByRole("button", { name: "Signature" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("request_digital_action_participant_export", expect.objectContaining({ p_action_id: "a1", p_participation_kind: "signature" })));
    fireEvent.click(await screen.findByRole("button", { name: "Load more actions" }));
    expect(await screen.findByRole("heading", { name: "Second page petition" })).toBeInTheDocument();
  });

  it("keeps the actions and says a failed Load more on the Campaign page (#9463)", async () => {
    const client = actionsClient({ roles: ["admin"], nextOffset: 1, actions: [action("a1", "Staffing petition")] });
    const served = client.rpc.getMockImplementation();
    client.rpc.mockImplementation(async (name, args) => (name === "get_collective_actions" && args.p_offset ? { data: null, error: { message: "down" } } : served(name, args)));
    showCampaign({ actor: staff({ selectedHat: "admin", organizationRoles: ["admin"] }), client });
    fireEvent.click(await screen.findByRole("button", { name: "Load more actions" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("More actions could not be loaded. Try again.");
    expect(screen.getByRole("heading", { name: "Staffing petition" })).toBeInTheDocument();
  });

  it("tells a manager without export rights why, and an empty organization what comes next", async () => {
    const actor = staff({ selectedHat: "advisor", organizationRoles: ["advisor"] });
    showCampaign({ actor, client: actionsClient({ roles: ["advisor"], actions: [action("a1", "Staffing petition")] }) });
    const petition = (await screen.findByRole("heading", { name: "Staffing petition" })).closest("article");
    expect(petition).toHaveTextContent(/two-step sign-in is required/);
    cleanup();
    showCampaign({ client: actionsClient({ actions: [] }) });
    expect(await screen.findByText("No active actions yet.")).toBeInTheDocument();
    expect(screen.getByText("When your organization publishes an action, you can join it here.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Collective action figures" })).toHaveTextContent("—counts are withheld");
  });

  it("shows the loading and unavailable states with a retry", async () => {
    showCampaign({ client: null });
    expect(screen.getByText("Loading actions…")).toBeInTheDocument();
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(retry.closest(".ug-empty")).not.toBeNull();
    fireEvent.click(retry);
    expect(screen.getByRole("region", { name: "Collective action figures" })).toHaveTextContent("Open now—");
  });

  it("speaks Spanish", async () => {
    showCampaign({ lang: "es", client: actionsClient({ actions: [action("a1", "Petición")] }) });
    await screen.findByRole("heading", { name: "Petición" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Línea de piquete digital");
    expect(screen.getByRole("heading", { name: "Tu parte" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Unirse/ })).toBeInTheDocument();
  });

  it("keeps the classic page when alt is off", async () => {
    render(<CollectiveActionsView actor={staff()} client={actionsClient({ actions: [action("a1", "Staffing petition")] })} />);
    await screen.findByRole("heading", { name: "Staffing petition" });
    expect(document.querySelector(".oi-shell")).toHaveAttribute("aria-label", "Collective actions workspace");
    expect(screen.getByRole("button", { name: "Join action" })).toHaveClass("oi-button");
    expect(document.querySelector(".ug-page-hero")).toBeNull();
  });

  it("lays only dated actions on the strip", () => {
    const now = new Date(2026, 9, 30, 12);
    const days = stripDays([
      action("a1", "Dated", { startsAt: new Date(2026, 9, 30, 9).toISOString(), endsAt: new Date(2026, 10, 2, 9).toISOString() }),
      action("a2", "Undated", { startsAt: null, endsAt: null }),
      action("a3", "Draft", { status: "draft" }),
      action("a4", "Open-ended", { startsAt: null, endsAt: new Date(2026, 9, 31, 9).toISOString(), status: "closed" }),
    ], now);
    expect(days).toHaveLength(30);
    expect(days[7].today).toBe(true);
    expect(days[7].opens.map((item) => item.id)).toEqual(["a1"]);
    expect(days[7].running.map((item) => item.id)).toEqual(["a1", "a4"]);
    expect(days[8].closes.map((item) => item.id)).toEqual(["a4"]);
    expect(days[0].running.map((item) => item.id)).toEqual(["a4"]);
  });
});

// ── strings and styles ───────────────────────────────────────────────────

describe("take part strings and styles", () => {
  it("declares every altTakePart key in English and Spanish", () => {
    const keys = Object.keys(altTakePartCatalogue.en);
    expect(keys.length).toBeGreaterThan(80);
    expect(Object.keys(altTakePartCatalogue.es).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(key.startsWith("altTakePart."), key).toBe(true);
      expect(altTakePartCatalogue.es[key], key).toBeTruthy();
    }
  });

  it("scopes every rule under the alternate shell and adds no entrance motion", () => {
    const css = readFileSync("src/alt/styles/pages-takepart.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/animation|@keyframes|transition/);
    // Selector lists split on top-level commas only (not inside :is()).
    const selectors = (rule) => rule.split(/,(?![^(]*\))/).map((part) => part.trim());
    for (const rule of css.split("}").map((part) => part.split("{")[0].trim()).filter((selector) => selector && !selector.startsWith("@"))) {
      for (const selector of selectors(rule)) expect(selector, rule).toMatch(/^\.ugalt /);
    }
  });
});

// Send for review keeps focus while the poll question is sent, and
// a second activation in the same tick sends nothing more.
describe("poll suggestion while it is sent", () => {
  // The classic Votes page owns this composer (the alternate page draws its own).
  const ready = (onSuggestPoll) => {
    render(<LanguageProvider lang="en"><VotingView desktop data={{ planItems: ballots() }} onPlanAction={vi.fn()} onMessageSteward={vi.fn()} onSuggestPoll={onSuggestPoll} /></LanguageProvider>);
    fireEvent.change(screen.getByRole("textbox", { name: "Suggest a poll" }), { target: { value: "Should we meet on Fridays?" } });
    return screen.getByRole("button", { name: "Submit for review" });
  };

  it("keeps Send for review focused while it sends, and sends once", async () => {
    const onSuggestPoll = vi.fn(async () => undefined);
    await expectHeldWriteFocus(onSuggestPoll, ready(onSuggestPoll));
    expect(onSuggestPoll).toHaveBeenCalledTimes(1);
  });

  it("sends one poll question when Send for review is activated twice in one tick", async () => {
    const onSuggestPoll = vi.fn(async () => undefined);
    const send = ready(onSuggestPoll);
    await expectOneWriteFromOneTick(onSuggestPoll, [() => fireEvent.click(send), () => fireEvent.click(send)]);
  });

  it("keeps the alternate page's Send for review focused while it sends, and sends once", async () => {
    const handlers = showVotes();
    fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), { target: { value: "Should we meet on Fridays?" } });
    await expectHeldWriteFocus(handlers.onSuggestPoll, screen.getByRole("button", { name: "Send for review" }));
    expect(handlers.onSuggestPoll).toHaveBeenCalledTimes(1);
  });
});
