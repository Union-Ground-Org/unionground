// BUG-UG-ATTENTION-COUNTS-CONTRADICT-THE-PAGES-THEY-OPEN-20261006:
// a number beside a navigation label must not read as work waiting when it is
// a count of pages, and Home must not say "nothing needs your attention" while
// the steward rail badge or an unanswered survey says otherwise.
import { readFileSync } from "node:fs";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WhatMattersNowCard } from "../src/features/memberHome/WhatMattersNowCard.jsx";
import { WorkspaceOverview, WorkspacePages } from "../src/components/WorkspacePages.jsx";

const SWITCH = "features.home.what_matters_now";

function data(overrides = {}) {
  return {
    organizationConfiguration: { switches: { [SWITCH]: true } },
    member: { chapterId: "ch-1" },
    cases: [],
    planItems: [],
    events: [],
    ...overrides,
  };
}

function card(props, lang = "en") {
  return render(<LanguageProvider lang={lang}><WhatMattersNowCard {...props} /></LanguageProvider>);
}

afterEach(() => { window.history.replaceState({}, "", "/"); });

describe("Home agrees with the attention badges", () => {
  it("names the steward queue the rail badge counts instead of saying caught up", () => {
    card({ data: data({ stewardBadges: { openRequests: 1, formsInbox: 1 } }) });
    const region = screen.getByRole("region", { name: "What matters for you now" });
    expect(within(region).queryByText("You're caught up")).toBeNull();
    expect(within(region).queryByText("Nothing needs your attention right now.")).toBeNull();
    expect(within(region).getByText("2 committee requests and forms are waiting on your Committee desk. Your own items are done.")).toBeTruthy();
    // Not the calm caught-up state: no green done check.
    expect(region.getAttribute("data-kind")).toBe("steward_queue");
    expect(region.className).toContain("what-matters--info");
  });

  it("gives the steward queue line a button that opens the Steward desk", () => {
    // UX-UG-GIVE-HOME-STEWARD-REQUESTS-WAITING-LINE-BUTTON-OPENS-20261013
    const onOpenStewardDesk = vi.fn();
    const { unmount } = card({ data: data({ stewardBadges: { openRequests: 1, formsInbox: 1 } }), onOpenStewardDesk });
    const region = screen.getByRole("region", { name: "What matters for you now" });
    const buttons = within(region).getAllByRole("button");
    expect(buttons).toHaveLength(1);
    fireEvent.click(within(region).getByRole("button", { name: "Open the Committee desk" }));
    expect(onOpenStewardDesk).toHaveBeenCalledTimes(1);
    unmount();
    // Without a way onto the desk the line stays, with no dead control.
    card({ data: data({ stewardBadges: { openRequests: 1, formsInbox: 0 } }) });
    expect(screen.queryByRole("button")).toBeNull();
    unmount();
    card({ data: data({ stewardBadges: { openRequests: 2, formsInbox: 0 } }), onOpenStewardDesk }, "es");
    expect(screen.getByRole("button", { name: "Abrir el escritorio del comité" })).toBeTruthy();
  });

  it("uses the singular for one steward item and Spanish copy", () => {
    const { unmount } = card({ data: data({ stewardBadges: { openRequests: 1, formsInbox: 0 } }) });
    expect(screen.getByText("1 committee request or form is waiting on your Committee desk. Your own items are done.")).toBeTruthy();
    unmount();
    card({ data: data({ stewardBadges: { openRequests: 2, formsInbox: 1 } }) }, "es");
    expect(screen.getByText("3 solicitudes y formularios del comité esperan en tu escritorio del comité. Tus propios asuntos están al día.")).toBeTruthy();
  });

  it("offers an unanswered open survey and opens it", () => {
    const survey = { id: "s1", kind: "pulse", title: "Bargaining survey", closed: false, selectedOption: "" };
    const onVote = vi.fn();
    card({ data: data({ planItems: [survey] }), onVote });
    expect(screen.queryByText("You're caught up")).toBeNull();
    expect(screen.getByText("A survey is waiting for your answer")).toBeTruthy();
    expect(screen.getByText("Bargaining survey")).toBeTruthy();
    expect(screen.getByRole("region", { name: "What matters for you now" }).getAttribute("data-kind")).toBe("open_survey");
    fireEvent.click(screen.getByRole("button", { name: "Answer the survey" }));
    expect(onVote).toHaveBeenCalledWith(survey);
  });

  it("still says caught up when the survey is answered and the steward queue is empty or unknown", () => {
    for (const stewardBadges of [null, { openRequests: 0, formsInbox: 0 }]) {
      const { unmount } = card({ data: data({
        stewardBadges,
        planItems: [
          { id: "s1", kind: "pulse", title: "Answered", closed: false, selectedOption: "opt-1" },
          { id: "s2", kind: "pulse", title: "Closed", closed: true, selectedOption: "" },
        ],
      }) });
      expect(screen.getByText("You're caught up")).toBeTruthy();
      expect(screen.queryByRole("button")).toBeNull();
      unmount();
    }
  });
});

// UB-UG-WORKSPACE-OVERVIEW-COUNTS-AND-PAGE-MENU-20261106: the
// directory's group headings once carried page counts ("(6 pages)"), which a
// viewer could mistake for items waiting and which read as a site map. They now
// carry only the group's name; opening the group lists its pages.
describe("workspace directory groups carry no counts", () => {
  for (const plane of ["vp", "admin", "steward", "settings"]) {
    it(`names every ${plane} group without a count`, () => {
      window.history.replaceState({}, "", `/m/${plane}`);
      const { container } = render(
        <LanguageProvider>
          <WorkspacePages view={plane} hat={plane} location={window.location.href} navigate={vi.fn()}>
            <WorkspaceOverview />
          </WorkspacePages>
        </LanguageProvider>,
      );
      const summaries = [...container.querySelectorAll(".workspace-directory summary")];
      expect(summaries.length).toBeGreaterThan(0);
      for (const summary of summaries) {
        expect(summary.querySelector("span")).toBeNull();
        expect(summary.textContent).not.toMatch(/\(\d+ pages?\)|páginas?\)/);
        expect(summary.parentElement.querySelectorAll("a").length).toBeGreaterThan(0);
      }
    });
  }

  // UX-UG-MAKE-HOME-STEWARD-QUEUE-STATE-READ-COUNT-FIRST-20261013
  it("reads the queue count before the own-items-done statement, in both languages", () => {
    for (const [lang, own] of [["en", "Your own items are done"], ["es", "Tus propios asuntos están al día"]]) {
      const { unmount } = card({ data: data({ stewardBadges: { openRequests: 2, formsInbox: 1 } }) }, lang);
      const region = screen.getByRole("region");
      const line = region.querySelector(".what-matters__line").textContent;
      expect(line.startsWith("3 ")).toBe(true);
      expect(line.indexOf(own)).toBeGreaterThan(line.indexOf("3"));
      // The reason that is read first no longer opens with the own-items claim.
      expect(region.querySelector(".what-matters__reason").textContent).not.toContain(own);
      unmount();
    }
  });

  it("sums requests and forms with 'and' in both languages", () => {
    const { unmount } = card({ data: data({ stewardBadges: { openRequests: 2, formsInbox: 1 } }) });
    expect(screen.getByText(/3 committee requests and forms are waiting/)).toBeTruthy();
    unmount();
    card({ data: data({ stewardBadges: { openRequests: 2, formsInbox: 1 } }) }, "es");
    expect(screen.getByText(/3 solicitudes y formularios del comité esperan/)).toBeTruthy();
  });

  it("gives the info state an edge unlike calm, with the audited information blue", async () => {
    const css = readFileSync("src/features/memberHome/whatMattersNow.css", "utf8");
    const edge = (selector) => css.match(new RegExp(`${selector.replace(/[.\[\]="-]/g, "\\$&")}\\s*\\{\\s*border-left-color:\\s*([^;]+);`))?.[1].trim();
    const calm = edge(".what-matters--calm");
    const info = edge(".what-matters--info");
    expect(info).toBe("var(--sg-light-info)");
    expect(info).not.toBe(calm);
    const { pairs } = await import("../scripts/contrast-audit.mjs");
    const measured = (card, ink) => pairs.find((row) => row[0] === card && row[1] === ink);
    expect(measured("--sg-light-card", "--sg-light-info")?.[2]).toBeGreaterThanOrEqual(3);
  });
});

