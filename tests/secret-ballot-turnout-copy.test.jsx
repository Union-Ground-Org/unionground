import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AltNowPage from "../src/alt/AltNowPage.jsx";
import { TodayView } from "../src/views/TodayView.jsx";
import { VotingView } from "../src/views/VotingView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue, loadLanguage } from "../src/lib/i18n.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

// BUG-UG-SECRET-BALLOT-TURNOUT-READS-IMPOSSIBLE-20261106: the Home
// secret-ballot hero and the Votes "ballot in" note filled "{votes} of
// {target} voted" with the quorum target, so a vote past quorum read
// "68 of 40 have voted". Both now name the quorum the way the turnout lines
// do (#7260).
const ballot = (quorum, receiptCode = "") => ({
  id: "b-past-quorum", kind: "ballot", title: "Ratify the agreement", meta: "Closes Fri",
  options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }], receiptCode, quorum,
});

function heroText(lang, quorum) {
  const view = render(<LanguageProvider lang={lang}>
    <TodayView data={{ ...fallbackData, planItems: [ballot(quorum)] }} onPlanAction={vi.fn()} />
  </LanguageProvider>);
  const text = view.container.querySelector(".home-vote-hero__meta")?.textContent;
  view.unmount();
  return text;
}

function votedText(lang, quorum) {
  const view = render(<LanguageProvider lang={lang}>
    <VotingView data={{ planItems: [ballot(quorum, "SG-AAAA-BBBB")] }} onPlanAction={vi.fn()} />
  </LanguageProvider>);
  const text = view.container.querySelector(".voting-voted__meta")?.textContent;
  view.unmount();
  return text;
}

beforeAll(async () => { await loadLanguage("es"); });
afterEach(cleanup);

describe("secret-ballot turnout copy", () => {
  it("says quorum was reached on the Home hero instead of 68 of 40 have voted", () => {
    const text = heroText("en", { totalVotes: 68, quorumTarget: 40 });
    expect(text).toBe("Secret ballot · Quorum reached: 68 votes, 40 needed");
    expect(text).not.toMatch(/68 of 40/);
    expect(heroText("en", { totalVotes: 12, quorumTarget: 40 })).toBe("Secret ballot · 12 of 40 votes needed for quorum");
  });

  it("says quorum was reached in the ballot-in note instead of 68 of 40 voted", () => {
    const text = votedText("en", { totalVotes: 68, quorumTarget: 40 });
    expect(text).toBe("Results publish when voting closes · Quorum reached: 68 votes, 40 needed · we'll notify you the moment they're in");
    expect(text).not.toMatch(/68 of 40/);
    expect(votedText("en", { totalVotes: 12, quorumTarget: 40 })).toContain("· 12 of 40 votes needed for quorum ·");
  });

  it("names the quorum the same way in Spanish", () => {
    expect(heroText("es", { totalVotes: 68, quorumTarget: 40 })).toBe("Voto secreto · Quórum alcanzado: 68 votos, se necesitaban 40");
    expect(votedText("es", { totalVotes: 68, quorumTarget: 40 }))
      .toBe("Los resultados se publican al cerrar la votación · Quórum alcanzado: 68 votos, se necesitaban 40 · te avisaremos en cuanto estén");
    expect(votedText("es", { totalVotes: 12, quorumTarget: 40 })).toContain("· 12 de 40 votos necesarios para el quórum ·");
  });
});

describe.each([
  { shell: "classic", View: TodayView, labelKey: "today.chapterQuorum" },
  { shell: "alternate", View: AltNowPage, labelKey: "altShell.quorumLabel" },
])("$shell Home quorum action", ({ View, labelKey }) => {
  const closed = { ...ballot({ totalVotes: 7, quorumTarget: 10 }), id: "closed", title: "Closed ballot", closed: true };
  const voted = { ...ballot({ totalVotes: 5, quorumTarget: 20 }, "SG-FIXTURE"), id: "voted", title: "Already voted" };
  const withoutQuorum = { ...ballot(null), id: "no-quorum", title: "Open ballot without quorum" };
  const available = { ...ballot({ totalVotes: 3, quorumTarget: 12 }), id: "available", title: "Open ballot with quorum" };

  function renderHome(lang, planItems, onPlanAction) {
    render(<LanguageProvider lang={lang}>
      <View data={{ ...fallbackData, planItems }} onPlanAction={onPlanAction} />
    </LanguageProvider>);
    return new RegExp(`^${catalogue[lang][labelKey]}`);
  }

  it.each(["en", "es"])("opens the first actionable ballot with a quorum target in %s", (lang) => {
    const onPlanAction = vi.fn();
    const label = renderHome(lang, [closed, voted, withoutQuorum, available], onPlanAction);
    const action = screen.getByRole("button", { name: label });
    expect(action).toHaveAccessibleName(expect.stringContaining("3 / 12"));
    fireEvent.click(action);
    expect(onPlanAction).toHaveBeenCalledExactlyOnceWith(available);
  });

  it.each(["en", "es"])("omits the quorum action when no eligible ballot has a target in %s", (lang) => {
    const label = renderHome(lang, [closed, voted, withoutQuorum], vi.fn());
    expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
  });
});
