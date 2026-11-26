import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TodayView, WEEK_ACTIONS_CLOSED_ROWS, weekActionRows } from "../src/views/TodayView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

// The weekly row cap still applies to other history. Closed ballot data
// stays in the plan for the receipt card and Voting history.
afterEach(cleanup);

const ballot = (id, { closed = false, closesAt = "2026-11-20T17:00:00Z" } = {}) => ({
  id, kind: "ballot", title: `Ballot ${id}`, meta: "meta", action: closed ? "Voted" : "Vote", closed, closesAt,
});

const NOW = Date.parse("2026-11-07T17:00:00Z");

describe("weekActionRows", () => {
  // BUG-UG-HOME-WEEK-ACTIONS-SHOWS-LAST-YEARS-CLOSED-VOTES-20261107: the
  // live demo led "This week's actions" with officer elections closed Dec 5, 2025.
  it("leads with open items and shows a closed one only if it closed this week, newest first", () => {
    const plan = [
      ballot("closed-2025", { closed: true, closesAt: "2025-12-05T17:00:00Z" }),
      ballot("closed-3-days", { closed: true, closesAt: "2026-11-04T17:00:00Z" }),
      ballot("open-1"),
      ballot("closed-yesterday", { closed: true, closesAt: "2026-11-06T17:00:00Z" }),
      ballot("closed-10-days", { closed: true, closesAt: "2026-10-28T17:00:00Z" }),
      ballot("open-2"),
    ];
    expect(WEEK_ACTIONS_CLOSED_ROWS).toBe(3);
    expect(weekActionRows(plan, NOW).map((item) => item.id)).toEqual(["open-1", "open-2", "closed-yesterday", "closed-3-days"]);
  });

  it("caps this week's closed rows at the limit", () => {
    const plan = [1, 2, 3, 4, 5].map((day) => ballot(`closed-${day}`, { closed: true, closesAt: `2026-11-0${day + 1}T17:00:00Z` }));
    expect(weekActionRows(plan, NOW).map((item) => item.id)).toEqual(["closed-5", "closed-4", "closed-3"]);
  });

  it("falls back to the most recently closed few when nothing is open or closed this week, so the card is never empty", () => {
    const plan = [
      ballot("closed-2023", { closed: true, closesAt: "2023-03-01T17:00:00Z" }),
      ballot("closed-2025", { closed: true, closesAt: "2025-12-05T17:00:00Z" }),
      ballot("closed-2024", { closed: true, closesAt: "2024-06-01T17:00:00Z" }),
      ballot("closed-2022", { closed: true, closesAt: "2022-01-01T17:00:00Z" }),
    ];
    expect(weekActionRows(plan, NOW).map((item) => item.id)).toEqual(["closed-2025", "closed-2024", "closed-2023"]);
  });

  it("keeps plan order between closed items that closed at the same moment", () => {
    const plan = [ballot("b", { closed: true, closesAt: "2026-11-05T17:00:00Z" }), ballot("a", { closed: true, closesAt: "2026-11-05T17:00:00Z" })];
    expect(weekActionRows(plan, NOW).map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("never treats a future or undated close as this week's", () => {
    const plan = [ballot("open-1"), ballot("future", { closed: true, closesAt: "2026-12-01T17:00:00Z" }), ballot("undated", { closed: true, closesAt: null })];
    expect(weekActionRows(plan, NOW).map((item) => item.id)).toEqual(["open-1"]);
  });
});

describe("Home This week's actions", () => {
  function renderHome(planItems) {
    return render(<LanguageProvider lang="en"><TodayView data={{ ...fallbackData, planItems }} desktop onRewards={() => {}} /></LanguageProvider>);
  }

  it.each(["en", "es"])("omits the empty card and restores it when actions arrive (%s)", (lang) => {
    const home = (planItems) => (
      <LanguageProvider lang={lang}>
        <TodayView data={{ ...fallbackData, planItems }} desktop />
      </LanguageProvider>
    );
    const name = catalogue[lang]["today.weekActions"];
    const { rerender } = render(home([]));
    expect(screen.queryByRole("region", { name })).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: catalogue[lang]["today.comingUp"] })).toBeInTheDocument();

    rerender(home([ballot("open-1")]));
    expect(within(screen.getByRole("region", { name })).getByText("Ballot open-1")).toBeInTheDocument();

    rerender(home([]));
    expect(screen.queryByRole("region", { name })).not.toBeInTheDocument();
  });

  it("hides old closed lessons and shows them in place on request", () => {
    const planItems = [ballot("open-1"), ...[1, 2, 3, 4, 5, 6].map((n) => ({ ...ballot(`closed-${n}`, { closed: true, closesAt: `2025-0${n}-01T17:00:00Z` }), kind: "lesson" }))];
    const closedVote = { ...ballot("past-vote", { closed: true }), receiptCode: "SG-PAST" };
    renderHome([...planItems, closedVote]);
    const card = screen.getByRole("region", { name: catalogue.en["today.weekActions"] });
    expect(within(card).getAllByRole("article")).toHaveLength(1);
    expect(within(card).queryByText("Ballot closed-1")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: catalogue.en["today.feedShowAll"].replace("{count}", "7") }));
    expect(within(card).getAllByRole("article")).toHaveLength(7);
    expect(within(card).getByText("Ballot closed-1")).toBeInTheDocument();
    expect(within(card).queryByText(closedVote.title)).not.toBeInTheDocument();
    const receipt = screen.getByText("Closed ballot receipt").closest("article");
    expect(receipt).toHaveTextContent(closedVote.title);
    expect(receipt).toHaveTextContent(closedVote.receiptCode);
    expect(within(card).queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it.each(["en", "es"])("keeps a recently closed ballot out of weekly actions (%s)", (lang) => {
    const closed = ballot("closed-recently", { closed: true, closesAt: new Date(Date.now() - 60_000).toISOString() });
    render(<LanguageProvider lang={lang}><TodayView desktop data={{ ...fallbackData, planItems: [closed, ballot("open-1")] }} /></LanguageProvider>);
    const card = screen.getByRole("region", { name: catalogue[lang]["today.weekActions"] });
    expect(within(card).getByText("Ballot open-1")).toBeVisible();
    expect(within(card).queryByText(closed.title)).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: catalogue[lang]["today.feedShowAll"].replace("{count}", "2") })).not.toBeInTheDocument();
  });

  it.each(["en", "es"])("names the receipt's ballot and overrides a stale vote action (%s)", (lang) => {
    const voted = { ...ballot("already-voted"), receiptCode: "SG-FIXTURE", action: catalogue[lang]["today.castVote"] };
    const open = ballot("available");
    const onPlanAction = vi.fn();
    render(<LanguageProvider lang={lang}><TodayView desktop data={{ ...fallbackData, planItems: [voted, open] }} onPlanAction={onPlanAction} /></LanguageProvider>);
    const card = screen.getByRole("region", { name: catalogue[lang]["today.weekActions"] });
    const row = within(card).getByText(voted.title).closest("article");
    expect(within(row).queryByRole("button", { name: `${voted.action} ›` })).not.toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: `${catalogue[lang]["data.voted"]} ›` }));
    expect(onPlanAction).toHaveBeenLastCalledWith(voted);
    const receipt = screen.getByText(catalogue[lang]["today.ballotIn"]).closest("article");
    expect(within(receipt).getByText(voted.title)).toBeVisible();
    expect(receipt).toHaveTextContent(voted.receiptCode);
    const openVote = screen.getByRole("region", { name: catalogue[lang]["today.openVote"] });
    expect(within(openVote).getByRole("heading", { name: open.title })).toBeVisible();
    fireEvent.click(within(openVote).getByRole("button", { name: catalogue[lang]["today.castVote"] }));
    expect(onPlanAction).toHaveBeenLastCalledWith(open);
  });

  it("labels another voted ballot and leaves closed ballots out of phone web quick actions", () => {
    const first = { ...ballot("first"), receiptCode: "SG-FIRST" };
    const second = { ...ballot("second"), receiptCode: "SG-SECOND" };
    const closed = ballot("past", { closed: true });
    render(<LanguageProvider lang="en"><TodayView data={{ ...fallbackData, planItems: [first, second, closed] }} /></LanguageProvider>);
    const quickActions = screen.getByRole("region", { name: catalogue.en["today.nextTwo"] });
    expect(within(quickActions).getByRole("button", { name: `${second.title} Voted` })).toBeVisible();
    expect(quickActions).not.toHaveTextContent(closed.title);
  });

  it.each([
    ["en", true, "Closed ballot receipt", "results after close"],
    ["es", true, "Comprobante de votación cerrada", "resultados al cierre"],
    ["en", false, "Closed ballot receipt", "results after close"],
    ["es", false, "Comprobante de votación cerrada", "resultados al cierre"],
  ])("labels a closed receipt without the open-results hint (%s, desktop %s)", (lang, desktop, closedHeading, hint) => {
    const closed = {
      ...ballot("closed receipt", { closed: true }),
      receiptCode: "SG-FIXTURE",
      results: [{ optionId: "yes", votes: 32 }],
    };
    const home = (item) => (
      <LanguageProvider lang={lang}>
        <TodayView desktop={desktop} data={{ ...fallbackData, planItems: [item] }} />
      </LanguageProvider>
    );
    const { rerender } = render(home(closed));
    const receipt = screen.getByText(closedHeading).closest("article");
    expect(receipt).toHaveTextContent(closed.title);
    expect(receipt).toHaveTextContent(closed.receiptCode);
    expect(within(receipt).getByRole("link", { name: catalogue[lang]["today.verifyIt"] })).toHaveAttribute("href", "/verify");
    expect(receipt).not.toHaveTextContent(hint);

    rerender(home({ ...closed, closed: false, results: null }));
    const openReceipt = screen.getByText(catalogue[lang]["today.ballotIn"]).closest("article");
    expect(openReceipt).toHaveTextContent(hint);
    expect(screen.queryByText(closedHeading)).not.toBeInTheDocument();
  });

  it("leaves closed pulses out of the expanded weekly actions", () => {
    const open = { ...ballot("open pulse"), kind: "pulse" };
    const finished = [
      { ...ballot("old pulse", { closed: true, closesAt: "2025-08-09T17:00:00Z" }), kind: "pulse", selectedOption: "fixture" },
      { ...ballot("recent pulse", { closed: true, closesAt: new Date(Date.now() - 60_000).toISOString() }), kind: "pulse" },
    ];
    const pastLesson = { ...ballot("old lesson", { closed: true, closesAt: "2025-08-09T17:00:00Z" }), kind: "lesson" };
    renderHome([open, ...finished, pastLesson]);
    const card = within(screen.getByRole("region", { name: catalogue.en["today.weekActions"] }));
    fireEvent.click(card.getByRole("button", { name: "Show all (2)" }));
    expect(card.getByText(open.title)).toBeVisible();
    expect(card.getByText(pastLesson.title)).toBeVisible();
    for (const item of finished) expect(card.queryByText(item.title)).not.toBeInTheDocument();
  });

  it("shows no Show all control when nothing is hidden", () => {
    renderHome([ballot("open-1")]);
    const card = screen.getByRole("region", { name: catalogue.en["today.weekActions"] });
    expect(within(card).queryByRole("button", { name: /Show all/ })).toBeNull();
  });
});
