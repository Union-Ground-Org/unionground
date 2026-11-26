// BUG-UG-PULSE-THIS-WEEK-CAUGHT-UP-WITH-OPEN-ITEMS-20261103: "caught
// up" only when no survey is waiting for an answer and no notice is unread,
// and a survey past its answer deadline is never one to answer.
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WhatMattersNowCard, whatMattersInputs } from "../src/features/memberHome/WhatMattersNowCard.jsx";
import { rankWhatMattersNow, surveysToAnswer } from "../src/features/memberHome/whatMattersNow.js";

const SWITCH = "features.home.what_matters_now";
const NOW = new Date(2026, 10, 3, 2, 12, 0);
const at = (offsetDays) => new Date(NOW.getTime() + offsetDays * 86_400_000).toISOString();

const survey = { id: "s1", title: "Seasonal check-in", closesAt: at(4), answered: false };
const notice = { id: "n1", title: "Crew meeting moved", unread: true };

describe("surveysToAnswer", () => {
  it("keeps open, unanswered surveys before their deadline, soonest first", () => {
    const later = { id: "s2", title: "Later", closesAt: at(9), answered: false };
    const open = { id: "s3", title: "No deadline", closesAt: null, answered: false };
    expect(surveysToAnswer([open, later, survey], NOW).map((row) => row.id)).toEqual(["s1", "s2", "s3"]);
    expect(surveysToAnswer([survey, open], NOW).map((row) => row.id)).toEqual(["s1", "s3"]);
    expect(surveysToAnswer([open, survey], NOW).map((row) => row.id)).toEqual(["s1", "s3"]);
  });

  it("leaves out past-deadline, closed, answered and malformed rows", () => {
    expect(surveysToAnswer([
      { id: "past", title: "Before October 31", closesAt: at(-3), answered: false },
      { id: "now", title: "Closing now", closesAt: NOW.toISOString(), answered: false },
      { id: "closed", title: "Closed", closesAt: null, closed: true, answered: false },
      { id: "done", title: "Done", closesAt: at(2), answered: true },
      { title: "No id", closesAt: null, answered: false },
      null,
    ], NOW)).toEqual([]);
    expect(surveysToAnswer(null, NOW)).toEqual([]);
    expect(surveysToAnswer([survey])).toEqual([survey]);
  });
});

describe("rankWhatMattersNow with surveys and notices", () => {
  const base = { cases: [], ballots: [], events: [], now: NOW };

  it("ranks an open survey instead of caught up", () => {
    expect(rankWhatMattersNow({ ...base, surveys: [survey] })).toEqual({
      kind: "open_survey", urgency: "info",
      survey: { id: "s1", title: "Seasonal check-in", closesAt: survey.closesAt },
      action: { kind: "answer_survey", surveyId: "s1" },
    });
    expect(rankWhatMattersNow({ ...base, surveys: [{ id: 7 }] })).toMatchObject({ survey: { id: "7", title: "", closesAt: null } });
  });

  it("ranks unread notices instead of caught up, newest first", () => {
    expect(rankWhatMattersNow({ ...base, notices: [{ id: "n0", title: "Read", unread: false }, notice, { id: "n2", unread: true }] })).toEqual({
      kind: "unread_notice", urgency: "info", notice: { id: "n1", title: "Crew meeting moved" }, unread: 2, action: { kind: "open_notices" },
    });
    expect(rankWhatMattersNow({ ...base, notices: [{ id: 3, unread: true }] })).toMatchObject({ notice: { id: "3", title: "" }, unread: 1 });
  });

  it("puts the survey first when both are waiting, and both after a vote", () => {
    expect(rankWhatMattersNow({ ...base, surveys: [survey], notices: [notice] }).kind).toBe("open_survey");
    const ballot = { id: "b1", title: "Ratify", closed: false, voted: false, closesAt: at(2) };
    expect(rankWhatMattersNow({ ...base, ballots: [ballot], surveys: [survey], notices: [notice] }).kind).toBe("open_vote");
  });

  it("is caught up only when neither is waiting", () => {
    expect(rankWhatMattersNow(base).kind).toBe("caught_up");
    expect(rankWhatMattersNow({
      ...base,
      surveys: [{ ...survey, closesAt: at(-3) }, { ...survey, id: "s2", answered: true }],
      notices: [{ ...notice, unread: false }, null, { title: "No id", unread: true }],
    }).kind).toBe("caught_up");
    expect(rankWhatMattersNow({ ...base, surveys: "bad", notices: "bad" }).kind).toBe("caught_up");
  });
});

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

const pulse = { id: "s1", kind: "pulse", title: "Seasonal check-in", closed: false, selectedOption: "" };
const broadcast = { id: "n1", title: "Crew meeting moved", unread: true };

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe("web Home card with an open survey or an unread notice", () => {
  it("maps plan-item surveys and broadcasts into the ranking inputs", () => {
    const inputs = whatMattersInputs(data({ planItems: [{ ...pulse, closesAt: at(2) }, { id: "s2", kind: "pulse", title: "Done", closed: true, selectedOption: "yes" }], broadcasts: [broadcast, { id: "n2", title: "Read", unread: false }] }), NOW);
    expect(inputs.surveys).toEqual([
      expect.objectContaining({ id: "s1", closed: false, answered: false, closesAt: at(2) }),
      expect.objectContaining({ id: "s2", closed: true, answered: true, closesAt: null }),
    ]);
    expect(inputs.notices).toEqual([{ id: "n1", title: "Crew meeting moved", unread: true }, { id: "n2", title: "Read", unread: false }]);
    expect(whatMattersInputs(data({ planItems: undefined }), NOW)).toMatchObject({ surveys: [], notices: [] });
  });


  it("offers no dead survey control without a survey handler", () => {
    card({ data: data({ planItems: [pulse] }) });
    expect(screen.getByText("A survey is waiting for your answer")).toBeTruthy();
    expect(screen.queryByText(/^Closes /)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers an unread notice and opens the notices", () => {
    const onOpenNotices = vi.fn();
    card({ data: data({ broadcasts: [broadcast] }), onOpenNotices });
    expect(screen.queryByText("You're caught up")).toBeNull();
    expect(screen.getByText("You have an unread notice")).toBeTruthy();
    expect(screen.getByText("Crew meeting moved")).toBeTruthy();
    expect(screen.getByRole("region", { name: "What matters for you now" }).getAttribute("data-kind")).toBe("unread_notice");
    fireEvent.click(screen.getByRole("button", { name: "Open notices" }));
    expect(onOpenNotices).toHaveBeenCalledTimes(1);
    // UX-UG-NOTICE-OPENS-MESSAGES-UNSELECTED-AND-READ-UNCLEAR-20261111:
    // the action names the notice to open, so Messages selects it.
    expect(onOpenNotices).toHaveBeenCalledWith("n1");
  });


  it("names the survey first when both wait", () => {
    card({ data: data({ planItems: [pulse], broadcasts: [broadcast] }), onVote: vi.fn(), onOpenNotices: vi.fn() });
    expect(screen.getByText("A survey is waiting for your answer")).toBeTruthy();
    expect(screen.queryByText("You're caught up")).toBeNull();
  });

  it("says caught up when neither waits, a closed survey included", () => {
    card({ data: data({ planItems: [{ ...pulse, closed: true }], broadcasts: [{ ...broadcast, unread: false }] }), onVote: vi.fn(), onOpenNotices: vi.fn() });
    expect(screen.getByText("You're caught up")).toBeTruthy();
    expect(screen.getByText("Nothing needs your attention right now.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
