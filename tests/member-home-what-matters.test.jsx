// REQ-UG-MEMBER-WHAT-MATTERS-NOW-20261001: the web "What matters for you
// now" card on member Home.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WhatMattersNowCard, whatMattersInputs } from "../src/features/memberHome/WhatMattersNowCard.jsx";
import { TodayView } from "../src/views/TodayView.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { catalogue } from "../src/lib/i18n.js";

const SWITCH = "features.home.what_matters_now";
const NOW = new Date(2026, 9, 1, 12, 0, 0);
const day = (offset) => {
  const date = new Date(2026, 9, 1 + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const at = (offsetDays) => new Date(NOW.getTime() + offsetDays * 86_400_000).toISOString();

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

function renderCard(props) {
  return render(<LanguageProvider><WhatMattersNowCard {...props} /></LanguageProvider>);
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe("WhatMattersNowCard", () => {
  it("leads with an urgent filing deadline and opens that case", () => {
    const onOpenCase = vi.fn();
    renderCard({
      data: data({ cases: [
        { id: "c-quiet", reference: "GR-1", status: "active", step: "Step 1", deadlineValue: day(20) },
        { id: "c-urgent", reference: "GR-2", status: "active", step: "Step 2", deadlineValue: day(1) },
      ] }),
      onOpenCase,
    });
    const card = screen.getByRole("region", { name: "What matters for you now" });
    expect(within(card).getByText("Issue follow-up coming up")).toBeTruthy();
    expect(within(card).getByText("A follow-up is due tomorrow on GR-2.")).toBeTruthy();
    // Union Ground issues carry no grievance step: the meta line is the
    // deadline alone.
    expect(within(card).queryByText(/Step 2/)).toBeNull();
    expect(card.textContent).not.toContain("Step");
    expect(card.textContent).not.toMatch(/\bcase\b|Filing deadline|grievance/i);
    fireEvent.click(within(card).getByRole("button", { name: "Review issue" }));
    expect(onOpenCase).toHaveBeenCalledWith("c-urgent");
  });

  // BUG-UG-MEMBER-HOME-PASSED-FILING-DEADLINE-READS-COMING-UP-20261107



  // Union Ground has no unfair labor practice deadline and no staff
  // retaliation flag (owner decision, 2026-10-13). Even if an issue summary
  // still carried those fields, the card ranks the issue itself and never
  // shows ULP copy or a message-the-steward action.
  it("never shows a ULP deadline, earliest ULP date or retaliation flag", () => {
    const onMessageSteward = vi.fn();
    const onOpenCase = vi.fn();
    for (const ulp of [{ ulpDeadline: day(1) }, { ulpDeadline: day(5) }, { ulpDeadline: day(-3), ulpSource: { provenance_id: "prov-x" } }, { ulpDeadline: day(20), ulpSource: { provenance_id: "prov-x" } }]) {
      const { unmount } = renderCard({
        data: data({ cases: [{ id: "c1", reference: "GR-1", status: "active", step: "Step 2", deadlineValue: day(20), retaliationFlagged: true, ...ulp }] }),
        onMessageSteward, onOpenCase,
      });
      const card = screen.getByRole("region", { name: "What matters for you now" });
      expect(within(card).getByText("Issue in progress")).toBeTruthy();
      expect(card.textContent).not.toMatch(/ULP|must be filed within|as few as|Earliest|Step 2/);
      expect(within(card).queryByRole("button", { name: "Message my committee contact" })).toBeNull();
      expect(card.getAttribute("class")).not.toContain("what-matters--critical");
      fireEvent.click(within(card).getByRole("button", { name: "Review issue" }));
      unmount();
    }
    expect(onOpenCase).toHaveBeenCalledTimes(4);
    expect(onOpenCase).toHaveBeenCalledWith("c1");
    expect(onMessageSteward).not.toHaveBeenCalled();
  });

  it("does not surface a retaliation flag on an issue that is not active", () => {
    renderCard({ data: data({ cases: [{ id: "c-flag", reference: "GR-9", status: "pending", retaliationFlagged: true, ulpDeadline: day(2) }] }), onMessageSteward: vi.fn() });
    expect(screen.getByText("You're caught up")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers the member's open, uncast vote with the plan item the vote dialog needs", () => {
    const onVote = vi.fn();
    const ballot = { id: "b1", kind: "ballot", title: "Ratify the agreement", closed: false, closesAt: at(2) };
    renderCard({ data: data({ planItems: [ballot, { id: "b2", kind: "ballot", title: "Voted", closed: false, receiptCode: "SG-1", closesAt: at(1) }] }), onVote });
    expect(screen.getByText("Ratify the agreement")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cast my vote" }));
    expect(onVote).toHaveBeenCalledWith(ballot);
  });

  it("offers this week's unanswered chapter event", () => {
    const onOpenEvents = vi.fn();
    renderCard({
      data: data({ events: [
        { id: "e-other", title: "Other chapter", startsAt: at(1), chapterId: "ch-9" },
        { id: "e1", title: "Chapter meeting", startsAt: at(2), chapterId: "ch-1", rsvpStatus: null },
      ] }),
      onOpenEvents,
    });
    expect(screen.getByText("Chapter meeting")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "See meeting and RSVP" }));
    expect(onOpenEvents).toHaveBeenCalledWith("e1");
  });

  it("says the member is caught up and offers no dead control", () => {
    renderCard({ data: data() });
    expect(screen.getByText("You're caught up")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders no action button when the handler for it is missing", () => {
    renderCard({ data: data({ cases: [{ id: "c1", reference: "GR-1", status: "active" }] }) });
    expect(screen.getByText("Issue in progress")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing when the organization switch is off", () => {
    const { container } = renderCard({ data: data({ organizationConfiguration: { switches: { [SWITCH]: false } }, cases: [{ id: "c1", status: "active" }] }) });
    expect(container.firstChild).toBeNull();
  });

  it("maps the snapshot into ranking inputs without leaking past events", () => {
    const inputs = whatMattersInputs(data({
      planItems: [{ id: "b", kind: "ballot", title: "B", closed: true, receiptCode: null, closesAt: at(1) }, { id: "p", kind: "pulse" }],
      events: [{ id: "past", title: "Past", startsAt: at(-3), isPast: true }, { id: "next", title: "Next", startsAt: at(1), cancelledAt: at(0), rsvpStatus: "going" }],
    }), NOW);
    expect(inputs.ballots).toEqual([expect.objectContaining({ id: "b", closed: true, voted: false })]);
    expect(inputs.events).toEqual([{ id: "next", title: "Next", startsAt: at(1), cancelled: true, responded: true }]);
  });

  it("has Spanish copy for every English key", () => {
    const keys = Object.keys(catalogue.en).filter((key) => key.startsWith("whatMatters.") || key.startsWith(`settings.def.${SWITCH}.`));
    expect(keys.length).toBeGreaterThanOrEqual(30);
    for (const key of keys) expect(catalogue.es[key], key).toBeTruthy();
  });
});

describe("TodayView with What matters for you now", () => {
  it("shows the ranked card on desktop and phone Home and opens the exact case", () => {
    const onOpenCases = vi.fn();
    const home = {
      ...fallbackData,
      organizationConfiguration: { switches: { [SWITCH]: true } },
      cases: [{ id: "case-77", reference: "GR-77", title: "Discipline", status: "active", step: "Step 1", deadlineValue: day(2) }],
    };
    for (const desktop of [true, false]) {
      const { unmount } = render(<LanguageProvider><TodayView data={home} desktop={desktop} onPlanAction={() => {}} onOpenCases={onOpenCases} /></LanguageProvider>);
      const card = screen.getByRole("region", { name: "What matters for you now" });
      fireEvent.click(within(card).getByRole("button", { name: "Review issue" }));
      unmount();
    }
    expect(onOpenCases).toHaveBeenCalledTimes(2);
    expect(onOpenCases).toHaveBeenCalledWith("case-77");
  });

  it("opens the Steward desk from the steward queue line by putting the Steward role on", () => {
    // UX-UG-GIVE-HOME-STEWARD-REQUESTS-WAITING-LINE-BUTTON-OPENS-20261013
    const onSwitchHat = vi.fn();
    const home = {
      ...fallbackData,
      organizationConfiguration: { switches: { [SWITCH]: true } },
      cases: [],
      planItems: [],
      events: [],
      // The member's own unread notices and assigned tasks rank above the
      // steward queue.
      broadcasts: [],
      tasks: [],
      stewardBadges: { openRequests: 2, formsInbox: 1 },
    };
    for (const desktop of [true, false]) {
      const { unmount } = render(<LanguageProvider><TodayView data={home} desktop={desktop} onPlanAction={() => {}} onSwitchHat={onSwitchHat} /></LanguageProvider>);
      const card = screen.getByRole("region", { name: "What matters for you now" });
      expect(card.getAttribute("data-kind")).toBe("steward_queue");
      fireEvent.click(within(card).getByRole("button", { name: "Open the Committee desk" }));
      unmount();
    }
    expect(onSwitchHat).toHaveBeenCalledTimes(2);
    expect(onSwitchHat).toHaveBeenCalledWith("steward");
    render(<LanguageProvider><TodayView data={home} onPlanAction={() => {}} /></LanguageProvider>);
    expect(within(screen.getByRole("region", { name: "What matters for you now" })).queryByRole("button")).toBeNull();
  });
});
