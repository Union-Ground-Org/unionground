import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AltNowPage from "../src/alt/AltNowPage.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { AltShellContext } from "../src/alt/altShellContext.js";

const NOW = new Date("2026-10-16T12:00:00-04:00");
const chapters = [{ id: "one", name: "Chapter One" }, { id: "two", name: "Chapter Two" }];
const ballot = (id, rest = {}) => ({ id, kind: "ballot", title: `Ballot ${id}`, ...rest });
function snapshot(overrides = {}) {
  return {
    member: { id: "m1", fullName: "Alex Member", chapterId: "one", chapterName: "Chapter One" },
    events: [], planItems: [], broadcasts: [], tasks: [], notifications: [], conversations: [], cases: [],
    metrics: { openCases: 0 }, rights: { lessons: [] },
    rewards: { totalPoints: 1200, tierNumber: 2, tierName: "Builder", actionsYtd: 42 },
    rewardsCatalog: { tiers: [] }, weekly: { done: 3, goal: 5 },
    ...overrides,
  };
}
function open(data, props = {}, shell = {}, lang = "en") {
  return render(<LanguageProvider lang={lang}><AltShellContext.Provider value={shell}>
    <AltNowPage data={data} chapters={chapters} selectedChapterId="one" {...props} />
  </AltShellContext.Provider></LanguageProvider>);
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("alternate Now parity", () => {
  it.each([
    ["en", null, "There’s no campaign yet. Create a campaign before assigning a committee member."],
    ["es", "one", "Todavía no hay un miembro del comité asignado. En Admin, abre Roles, unidades y comités para asignar a uno."],
  ])("gives an admin the right empty-roster guidance (%s, chapter %s)", (lang, chapterId, guidance) => {
    const data = snapshot({ roles: ["admin"], chapterStewards: [] });
    data.member.chapterId = chapterId;
    open(data, chapterId ? {} : { chapters: [], selectedChapterId: null }, {}, lang);
    expect(screen.getByText(guidance)).toBeInTheDocument();
  });

  it("opens Past votes from the calendar, timeline and record strip for a closed ballot", () => {
    const onNavigate = vi.fn(), onPlanAction = vi.fn();
    const closed = ballot("Closed fixture", { closed: true, closesAt: NOW.toISOString() });
    const openBallot = ballot("Open fixture", { closesAt: "2026-10-17T12:00:00-04:00" });
    open(snapshot({ planItems: [closed, openBallot] }), { onNavigate, onPlanAction });
    for (const surface of [".ug-day-panel", ".ug-tl", ".ug-marquee"]) {
      fireEvent.click(within(document.querySelector(surface)).getByRole("button", { name: /Closed fixture/ }));
    }
    expect(onNavigate.mock.calls.map(([view, path]) => [view, path])).toEqual([
      ["voting", "/m/voting/past"], ["voting", "/m/voting/past"], ["voting", "/m/voting/past"],
    ]);
    expect(onPlanAction).not.toHaveBeenCalled();
    fireEvent.click(within(document.querySelector(".ug-marquee")).getByRole("button", { name: /Open fixture/ }));
    expect(onPlanAction).toHaveBeenCalledExactlyOnceWith(openBallot);
    expect(onNavigate).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["en", "Calendar", "No dated meetings to download"],
    ["es", "Calendario", "No hay reuniones con fecha para descargar"],
  ])("explains the unavailable Calendar download in %s", (lang, calendar, reason) => {
    open(snapshot({ events: [{ id: "undated", title: "Undated fixture" }] }), {}, {}, lang);
    expect(screen.getByText(reason, { selector: ".ug-chan span" }).closest(".ug-chan")).toHaveTextContent(calendar);
    expect(screen.getByRole("status", { name: calendar })).toHaveTextContent(reason);
    expect(screen.queryByRole("button", { name: new RegExp(`^${calendar}.*${lang === "en" ? "Download" : "Descargar"}`) })).not.toBeInTheDocument();
    expect(screen.getByText("Undated fixture")).toBeInTheDocument();
  });

  it("updates the same Calendar status region as dated events disappear and return", () => {
    const scheduled = snapshot({ events: [{ id: "scheduled", title: "Dated fixture", startsAt: "2026-10-17T12:00:00-04:00" }] });
    const page = (data) => <LanguageProvider lang="en"><AltNowPage data={data} /></LanguageProvider>;
    const view = render(page(scheduled));
    const status = screen.getByRole("status", { name: "Calendar" });
    expect(status).toBeEmptyDOMElement();
    expect(screen.getByRole("button", { name: /^Calendar.*Download/ })).toBeEnabled();

    view.rerender(page(snapshot()));
    expect(screen.getByRole("status", { name: "Calendar" })).toBe(status);
    expect(status).toHaveTextContent("No dated meetings to download");

    view.rerender(page(scheduled));
    expect(screen.getByRole("status", { name: "Calendar" })).toBe(status);
    expect(status).toBeEmptyDOMElement();
  });

  it("uses actual future instants and does not copy a chapter's event onto other chapters", () => {
    open(snapshot({ events: [
      { id: "stale", chapterId: "one", title: "Expired meeting", startsAt: "2026-09-06T14:00:00-04:00", isPast: false },
      { id: "next", chapterId: "one", title: "Next meeting", startsAt: "2026-10-25T14:00:00-04:00" },
      { id: "legacy", title: "Unscoped event", startsAt: "2026-10-20T14:00:00-04:00" },
    ] }));
    const panel = document.querySelector(".ug-now-list");
    expect(panel).not.toHaveTextContent("Today");
    expect(within(panel).getByRole("button", { name: /^Chapter Two:/ })).toHaveTextContent("—");
    expect(document.querySelector(".ug-band-grey")).not.toHaveTextContent("Expired meeting");
  });

  it("gives every ballot a direct action, including receipts beyond the card cap", () => {
    const planItems = Array.from({ length: 9 }, (_, n) => ballot(String(n)));
    planItems.push(ballot("receipt", { receiptCode: "R-9" }));
    const onPlanAction = vi.fn();
    open(snapshot({ planItems }), { onPlanAction, onNavigate: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "Vote: Ballot 8", exact: true }));
    expect(onPlanAction).toHaveBeenLastCalledWith(planItems[8]);
    fireEvent.click(screen.getByRole("button", { name: "Voted: Ballot receipt", exact: true }));
    expect(onPlanAction).toHaveBeenLastCalledWith(planItems[9]);
    fireEvent.click(screen.getByRole("button", { name: "Cast vote", exact: true }));
    expect(onPlanAction).toHaveBeenLastCalledWith(planItems[0]);
    fireEvent.click(screen.getByRole("button", { name: "Read summary", exact: true }));
    expect(onPlanAction).toHaveBeenLastCalledWith(planItems[0]);
  });

  it.each(["en", "es"])("shows a voted receipt without the stale Cast vote label (%s)", (lang) => {
    const copy = catalogue[lang];
    const voted = ballot("voted", { action: copy["today.castVote"], receiptCode: "SG-FIXTURE" });
    const available = ballot("available");
    const onPlanAction = vi.fn();
    open(snapshot({ planItems: [voted, available] }), { onPlanAction }, {}, lang);
    const row = screen.getByRole("button", { name: `${copy["data.voted"]}: ${voted.title}` });
    expect(row).not.toHaveTextContent(voted.action);
    fireEvent.click(row);
    expect(onPlanAction).toHaveBeenLastCalledWith(voted);
    fireEvent.click(screen.getByRole("button", { name: copy["today.castVote"], exact: true }));
    expect(onPlanAction).toHaveBeenLastCalledWith(available);
  });

  it.each(["en", "es"])("keeps the closed ballot receipt card, leaves the ballot out of the action list and links to Past votes (%s)", (lang) => {
    const copy = catalogue[lang];
    const closed = ballot("closed", { action: copy["data.closed"], closed: true, receiptCode: "SG-CLOSED", closesAt: NOW.toISOString() });
    const available = ballot("available");
    const onNavigate = vi.fn();
    open(snapshot({ planItems: [closed, available] }), { onNavigate }, {}, lang);
    const section = screen.getByRole("region", { name: `${copy["altShell.takePartLead"]} ${copy["altShell.takePartAccent"]}` });
    const actions = within(section).getByRole("group", { name: copy["altShell.ballotList"] });
    expect(within(actions).getByText(available.title)).toBeVisible();
    expect(actions).not.toHaveTextContent(closed.title);
    const receiptCard = within(section).getByRole("heading", { name: closed.title }).parentElement;
    expect(within(receiptCard).getByText(copy["altShell.receipt"].replace("{code}", closed.receiptCode))).toBeVisible();
    expect(within(receiptCard).getByRole("link", { name: copy["altShell.verify"] })).toHaveAttribute("href", "/verify");
    fireEvent.click(within(section).getByRole("button", { name: copy["voting.pastTitle"] }));
    expect(onNavigate).toHaveBeenLastCalledWith("voting", "/m/voting/past", "");
  });

  it("omits closed pulses after Take part expands and can still open a live pulse", () => {
    const active = { id: "active", kind: "pulse", title: "Open consultation", action: "Answer" };
    const answered = { id: "answered", kind: "pulse", title: "Answered open consultation", closed: false, selectedOption: "fixture" };
    const tasks = Array.from({ length: 6 }, (_, index) => ({ id: `task-${index}`, kind: "task", title: `Open task ${index}` }));
    const finished = [
      { id: "old", kind: "pulse", title: "Old consultation", closed: true, selectedOption: "fixture" },
      { id: "recent", kind: "pulse", title: "Recent consultation", closed: true },
    ];
    const onPlanAction = vi.fn();
    open(snapshot({ planItems: [active, ...tasks, answered, ...finished] }), { onPlanAction });
    const section = within(screen.getByRole("region", { name: "Take part" }));
    fireEvent.click(section.getByRole("button", { name: /^Show all/ }));
    for (const item of finished) expect(section.queryByText(item.title)).not.toBeInTheDocument();
    const answeredCard = section.getByRole("button", { name: /Answered open consultation/ });
    expect(answeredCard).toBeEnabled();
    expect(answeredCard).toHaveTextContent(catalogue.en["altShell.voted"]);
    fireEvent.click(section.getByRole("button", { name: /Open consultation/ }));
    expect(onPlanAction).toHaveBeenCalledExactlyOnceWith(active);
  });

  it("opens the selected event and keeps attendance and named briefing history", () => {
    const event = { id: "upcoming", chapterId: "one", title: "Next meeting", startsAt: "2026-10-25T14:00:00-04:00" };
    const held = { id: "attended", title: "Summer meeting", startsAt: "2026-07-30T14:00:00-04:00", isPast: true, checkedIn: true };
    const broadcast = { id: "briefing", title: "Member briefing 1", publishedAt: "2026-10-01T12:00:00-04:00" };
    const onOpenEvents = vi.fn(), onOpenBroadcast = vi.fn();
    open(snapshot({ events: [event, held], broadcasts: [broadcast] }), { onOpenEvents, onOpenBroadcast });
    const openEvent = screen.getByRole("button", { name: "Open meeting: Next meeting" });
    // The visible words are inside the accessible name (label in name).
    expect(openEvent).toHaveTextContent(/^Open meeting$/);
    fireEvent.click(openEvent);
    expect(onOpenEvents).toHaveBeenLastCalledWith(event);
    expect(screen.getByRole("button", { name: /Summer meeting.*Attended/ })).toBeEnabled();
    fireEvent.click(within(screen.getByRole("region", { name: "Campaign activity" })).getByRole("button", { name: /Member briefing 1/ }));
    expect(onOpenBroadcast).toHaveBeenLastCalledWith(broadcast);
  });

  it("names the contact, greets the member, shows actual stats and opens the existing directory", () => {
    const steward = { id: "s1", name: "Sam Steward", contact: { email: "sam@example.org" } };
    const onContactSteward = vi.fn(), openMenu = vi.fn();
    open(snapshot({ chapterStewards: [steward] }), { onContactSteward }, { openMenu });
    expect(screen.getByText(/Alex Member/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Contact Sam Steward", exact: true }));
    expect(onContactSteward).toHaveBeenCalledWith(steward);
    expect(screen.getByRole("link", { name: "Email Sam Steward" })).toHaveAttribute("href", "mailto:sam@example.org");
    expect(screen.getByText("Actions YTD")).toBeInTheDocument();
    expect(screen.getByText("This week's actions")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All features", exact: true }));
    expect(openMenu).toHaveBeenCalledOnce();
  });

  it("omits closed action rows and hides contacts and case previews for a restricted session", () => {
    const onPlanAction = vi.fn();
    open(snapshot({ planItems: [ballot("closed", { closed: true })], chapterStewards: [{ id: "s1", name: "Secret Steward" }], cases: [{ id: "c", status: "active", title: "Private case" }] }), { sessionRestricted: true, onPlanAction });
    expect(screen.queryByRole("button", { name: "Vote: Ballot closed", exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("Secret Steward")).toBeNull();
    expect(screen.queryByText("Private case")).toBeNull();
  });

  it("keeps today's date-only item and a meeting still running on the calendar, as eventIsPast does", () => {
    vi.setSystemTime(new Date("2026-10-16T15:00:00-04:00"));
    open(snapshot({ events: [
      { id: "deadline", chapterId: "one", title: "Dues deadline", eventKind: "deadline", eventDate: "2026-10-16", startsAt: null },
      { id: "huddle", chapterId: "one", title: "Lunch huddle", startsAt: "2026-10-16T14:00:00-04:00", endsAt: "2026-10-16T16:00:00-04:00" },
    ] }), { onOpenEvents: vi.fn() });
    expect(screen.getByRole("button", { name: /^Open meeting: Dues deadline/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Open meeting: Lunch huddle/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Campaign activity" })).toBeNull();
  });

  it("prints a second open ballot receipt that the card does not show on its row", () => {
    open(snapshot({ planItems: [ballot("first", { receiptCode: "R-1" }), ballot("held", { receiptCode: "K7TQ2MRX" })] }), { onPlanAction: vi.fn() });
    const row = screen.getByRole("button", { name: "Voted: Ballot held", exact: true });
    expect(row).toBeEnabled();
    expect(row).toHaveTextContent("Receipt K7TQ2MRX");
    expect(screen.getAllByText("Receipt R-1")).toHaveLength(1);
  });

  // BUG-UG-HOME-FIND-MY-STEWARD-CARD-NAMES-PAUSED-STEWARD-20261103 (#6971).
  it("names no steward when nobody could receive a steward message, and sends Talk to steward to Messages", () => {
    const onContactSteward = vi.fn(), onOpenMessages = vi.fn();
    open(snapshot({ chapterStewards: [{ id: "s1", name: "Sam Steward", contact: { email: "sam@example.org" } }] }), { stewardMessageAvailable: false, onContactSteward, onOpenMessages });
    expect(screen.queryByText("Sam Steward")).toBeNull();
    expect(screen.queryByRole("link", { name: "Email Sam Steward" })).toBeNull();
    expect(screen.getByText("No committee member in your campaign can receive messages right now. To reach someone now, contact your campaign's officers, such as the campaign lead or Admin.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Talk to your committee member" }));
    expect(onContactSteward).not.toHaveBeenCalled();
    expect(onOpenMessages).toHaveBeenCalledOnce();
  });

  it("labels the steward phone link with the visible words its name carries", () => {
    open(snapshot({ chapterStewards: [{ id: "s1", name: "Sam Steward", contact: { phone: "+15035550100" } }] }));
    const call = screen.getByRole("link", { name: "Call Sam Steward" });
    expect(call).toHaveAttribute("href", "tel:+15035550100");
    expect(call).toHaveTextContent(/^Call$/);
  });

  it("retains plan filters and offers every upcoming event beyond the initial six", () => {
    const events = Array.from({ length: 8 }, (_, n) => ({ id: `event-${n}`, title: `Event ${n}`, startsAt: `2026-10-${20 + n}T14:00:00-04:00` }));
    open(snapshot({ events, planItems: [ballot("one"), { id: "lesson", kind: "lesson", title: "Read rights" }] }), { onOpenEvents: vi.fn() });
    expect(screen.getAllByRole("button", { name: /^Open meeting:/ })).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Show all 8" }));
    expect(screen.getAllByRole("button", { name: /^Open meeting:/ })).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "Lesson 1", exact: true }));
    expect(screen.queryByRole("button", { name: "Vote: Ballot one", exact: true })).toBeNull();
  });
});

// REQ-UG-MEMBER-REFERRAL-ATTRIBUTION-20261110 (#8152, Sol G6-8176-5):
// the alternate Home shows the members-recruited count only when the server
// returned it, as classic Home does.
describe("alternate Now members recruited", () => {
  it("shows the backed recruited count beside actions this year", () => {
    open(snapshot({ rewards: { totalPoints: 1200, tierNumber: 2, tierName: "Builder", actionsYtd: 42, recruitedYtd: 4 } }));
    const stats = document.querySelector(".ug-now-stats");
    const row = within(stats).getByText("Recruited YTD").closest("div");
    expect(row).toHaveTextContent("Recruited YTD4");
  });

  it("shows no recruited count without a server value", () => {
    open(snapshot());
    expect(screen.queryByText("Recruited YTD")).toBeNull();
  });
});
