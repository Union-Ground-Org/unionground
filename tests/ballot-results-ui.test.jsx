// Published ballot results in the member Voice screen (UB-VOTE-02).
// The loader attaches `results` to a closed ballot's plan item; this file
// pins what the member then actually sees: a leader summary on the past-vote
// row, per-option bars in the read-only detail dialog, and the plain
// no-echo option list still intact for ballots without results. Rendering
// uses the demo fallback data, which carries one closed ballot with results
// (154 + 41 + 18 = 213 = its totalVotes).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { VotingView } from "../src/views/VotingView.jsx";

const closedBallot = fallbackData.planItems.find((item) => item.kind === "ballot" && item.closed);

// Closed ballots live on the routed Past page in BOTH layouts now (the phone
// advertises /m/voting/past instead of stacking it under the open ballots), so
// a phone assertion about a past row selects that tab first. Index, not label:
// the same helper serves the Spanish render.
function openPastTab(view) {
  fireEvent.click([...view.container.querySelectorAll(".voting-tab")][1]);
  return view;
}

function renderVoting(lang = "en", extra = {}) {
  return render(
    <LanguageProvider lang={lang}>
      <VotingView
        data={fallbackData}
        demo
        onPlanAction={vi.fn()}
        onMessageSteward={vi.fn()}
        onSuggestPoll={vi.fn()}
        {...extra}
      />
    </LanguageProvider>,
  );
}

describe("fallback demo data invariants", () => {
  it("carries one closed ballot whose result votes sum to its turnout", () => {
    expect(closedBallot).toBeTruthy();
    expect(Array.isArray(closedBallot.results)).toBe(true);
    const cast = closedBallot.results.reduce((sum, option) => sum + option.votes, 0);
    expect(cast).toBe(closedBallot.quorum.totalVotes);
    // Demo may not echo a pick any more than live does: the receipt is the
    // only voted state (UB-VOTE-04 holds in demo too).
    expect(closedBallot.selectedOption).toBe("");
  });
});

describe("past-vote rows summarize the published result", () => {
  it("keeps desktop section headings directly below the page h1", () => {
    const view = renderVoting("en", { desktop: true });
    expect(view.container.querySelector(".voting-ph__title")?.tagName).toBe("H1");
    for (const heading of view.container.querySelectorAll(".voting-pulse__title, .voting-rail__head")) {
      expect(heading.tagName).toBe("H2");
    }
    view.unmount();
  });

  it("shows the leading option and its share on the phone row", () => {
    const view = openPastTab(renderVoting());
    const row = view.container.querySelector(".voting-past-row");
    expect(row).toBeTruthy();
    // 154 of 213 → 72%
    expect(row.textContent).toContain("Yes — approve 72%");
    view.unmount();
  });

  it("shows the same summary behind the desktop Past tab", () => {
    const view = renderVoting("en", { desktop: true });
    const pastTab = [...view.container.querySelectorAll(".voting-tab")].find((tab) => tab.textContent.includes("Past"));
    fireEvent.click(pastTab);
    const row = view.container.querySelector(".voting-past-row");
    expect(row.textContent).toContain("Yes — approve 72%");
    view.unmount();
  });
});

describe("the detail dialog renders per-option bars after close", () => {
  it("lists every option with votes and share, leader tinted success", () => {
    const view = openPastTab(renderVoting());
    fireEvent.click(view.container.querySelector(".voting-past-row"));
    const rows = [...view.container.querySelectorAll(".voting-result-row")];
    expect(rows.map((row) => row.textContent)).toEqual([
      "Yes — approve154 votes · 72%",
      "No — reject41 votes · 19%",
      "Abstain18 votes · 8%",
    ]);
    const fills = [...view.container.querySelectorAll(".voting-result-row .voting-quorum-row__fill")];
    expect(fills[0].className).toContain("voting-quorum-row__fill--success");
    expect(fills[1].className).toContain("voting-quorum-row__fill--hero");
    expect(fills[0].style.width).toBe("72%");
    view.unmount();
  });

  it("keeps the plain no-echo option list for ballots without results", () => {
    const view = renderVoting();
    // The open ballot's docs row opens its detail: options render as the
    // unmarked list, no result rows, no counts.
    fireEvent.click(view.container.querySelector(".voting-hero__docs"));
    expect(view.container.querySelector(".voting-result-row")).toBeNull();
    expect([...view.container.querySelectorAll(".voting-detail .voting-option")].length).toBeGreaterThan(0);
    view.unmount();
  });

  it("renders staff-authored campaign details to eligible members", () => {
    const data = {
      ...fallbackData,
      planItems: fallbackData.planItems.map((item) => item.kind === "ballot" && !item.closed
        ? { ...item, body: "Review the complete tentative agreement before voting." }
        : item.kind === "pulse" ? { ...item, body: "Tell the bargaining team what matters most." } : item),
    };
    const view = renderVoting("en", { data });
    expect(view.container.querySelector(".voting-pulse__body")).toHaveTextContent("Tell the bargaining team");
    fireEvent.click(view.container.querySelector(".voting-hero__docs"));
    expect(view.container.querySelector(".voting-detail__body")).toHaveTextContent("tentative agreement");
    view.unmount();
  });

  it("renders in Spanish", () => {
    const view = openPastTab(renderVoting("es"));
    fireEvent.click(view.container.querySelector(".voting-past-row"));
    const results = view.container.querySelector(".voting-detail__results");
    expect(results.textContent).toContain("154 votos · 72%");
    view.unmount();
  });
});

describe("tied results never crown a single leader", () => {
  it("suppresses the past-row summary on a tie and tints no bar as the winner", () => {
    const tied = {
      ...fallbackData,
      planItems: fallbackData.planItems.map((item) =>
        item.kind === "ballot" && item.closed
          ? {
            ...item,
            quorum: { ...item.quorum, totalVotes: 100 },
            results: [
              { optionId: "t-yes", label: "Yes — ratify", votes: 50 },
              { optionId: "t-no", label: "No — reject", votes: 50 },
            ],
          }
          : item),
    };
    const view = render(
      <LanguageProvider lang="en">
        <VotingView data={tied} demo onPlanAction={vi.fn()} onMessageSteward={vi.fn()} onSuggestPoll={vi.fn()} />
      </LanguageProvider>,
    );
    openPastTab(view);
    const row = view.container.querySelector(".voting-past-row");
    // No "<label> <pct>%" suffix: the tie sends the reader to the dialog.
    expect(row.textContent).not.toContain("50%");
    fireEvent.click(row);
    const fills = [...view.container.querySelectorAll(".voting-result-row .voting-quorum-row__fill")];
    expect(fills).toHaveLength(2);
    // Both tied options render as leading (success tint) — equally, not one.
    for (const fill of fills) expect(fill.className).toContain("voting-quorum-row__fill--success");
    view.unmount();
  });
});

describe("member poll suggestions", () => {
  it("submits a local-wide suggestion and exposes the quorum dialog vote path", async () => {
    const onSuggestPoll = vi.fn().mockResolvedValue({});
    const onPlanAction = vi.fn();
    const view = renderVoting("en", { desktop: true, onSuggestPoll, onPlanAction });
    fireEvent.change(screen.getByRole("textbox", { name: "Suggest a poll" }), { target: { value: "Should we hold a lunch meeting?" } });
    fireEvent.click(screen.getByRole("radio", { name: /whole local/i }));
    fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
    await waitFor(() => expect(onSuggestPoll).toHaveBeenCalledWith("Should we hold a lunch meeting?", "local"));
    expect(await screen.findByText(t("en", "voting.pollSent"))).toBeInTheDocument();

    fireEvent.click(view.container.querySelector(".voting-quorum-row"));
    fireEvent.click(screen.getByRole("button", { name: "Cast my vote" }));
    expect(onPlanAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "ballot" }));
    view.unmount();
  });
});
