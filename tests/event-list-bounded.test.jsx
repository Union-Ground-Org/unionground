import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventAuthoringCard } from "../src/components/EventAuthoringCard.jsx";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { eventEndedSince, eventIsPast } from "../src/lib/eventModel.js";

// UX-UG-LONG-PAGES-RENDER-EVERY-ROW-EXPANDED-WITH-NO-PAGING-20261122
// (findings A-3 and B-42): Admin Events and the Events desk drew every event,
// past ones included, with its whole quorum form, door code and follow-up
// block, 41,453 px on the demo's 124 events. Upcoming meetings now come in pages
// of ten; past events page the same way and stay folded unless one ended in
// the last week; an open form is never lost to paging or the fold; and every
// event title is a heading a screen reader can move between.

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();
const event = (id, offsetDays) => ({
  id, title: `Meeting ${id}`, startsAt: iso(offsetDays), endsAt: iso(offsetDays + 0.05), location: "Hall",
  checkInCode: `SG-${id}`, rsvpCount: 1, checkinCount: 0, eventKind: "meeting",
});
const upcomingEvents = Array.from({ length: 12 }, (_, index) => event(`u${String(index + 1).padStart(2, "0")}`, index + 1));
// Every past event here ended more than a week ago, so the fold starts closed.
const pastEvents = Array.from({ length: 23 }, (_, index) => event(`p${String(index + 1).padStart(2, "0")}`, -(index + 8)));

function card(events, { lang = "en", showHeading = true } = {}) {
  const api = {
    updateEvent: vi.fn(), cancelEvent: vi.fn(), restoreEvent: vi.fn(), deleteEvent: vi.fn(), createEvent: vi.fn(),
    loadEventQuorum: vi.fn().mockResolvedValue([]), setEventQuorum: vi.fn(),
  };
  return <LanguageProvider lang={lang}>
    <EventAuthoringCard events={events} api={api} onNotice={vi.fn()} reload={vi.fn()} showHeading={showHeading}
      renderConnectedActions={(item) => <button type="button">Actions for {item.title}</button>} />
  </LanguageProvider>;
}
const show = ({ events = [...pastEvents, ...upcomingEvents], lang = "en", showHeading = true } = {}) => render(card(events, { lang, showHeading }));

const shownTitles = () => [...document.querySelectorAll(".xus-etitle")].map((title) => title.textContent);
const rowOf = (title) => screen.getByText(title, { selector: ".xus-etitle" }).closest(".xus-erow");

afterEach(() => { cleanup(); clearDeviceParityState(); vi.useRealTimers(); });

describe("bounded meetings list", () => {
  it("shows the first ten upcoming meetings and keeps older past meetings folded", () => {
    show();
    expect(shownTitles()).toEqual(upcomingEvents.slice(0, 10).map((item) => item.title));
    expect(screen.getAllByText("Manage meeting")).toHaveLength(10);
    expect(screen.getByRole("button", { name: "Show 23 past meetings" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Meeting p01")).toBeNull();
  });

  it("pages the upcoming meetings", () => {
    show();
    const pager = screen.getByRole("navigation", { name: "Upcoming" });
    expect(pager).toHaveTextContent("Showing 1–10 of 12");
    fireEvent.click(within(pager).getByRole("button", { name: "Next" }));
    expect(shownTitles()).toEqual(["Meeting u11", "Meeting u12"]);
  });

  it("opens past meetings on request, newest first, ten at a time", () => {
    show();
    const toggle = screen.getByRole("button", { name: "Show 23 past meetings" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("Hide past meetings");
    const pastPager = screen.getByRole("navigation", { name: "Past meetings" });
    expect(pastPager).toHaveTextContent("Showing 1–10 of 23");
    expect(shownTitles().slice(10)).toEqual(pastEvents.slice(0, 10).map((item) => item.title));
    fireEvent.click(within(pastPager).getByRole("button", { name: "Page 3" }));
    expect(shownTitles().slice(10)).toEqual(["Meeting p21", "Meeting p22", "Meeting p23"]);
    fireEvent.click(toggle);
    expect(screen.queryByText("Meeting p21")).toBeNull();
  });

  it("starts with past meetings open when one ended in the last week, and keeps the person's choice", () => {
    const yesterday = { ...event("y", -1), checkinCount: 31 };
    const { rerender } = show({ events: [yesterday, ...pastEvents, ...upcomingEvents] });
    const toggle = screen.getByRole("button", { name: "Hide past meetings" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(rowOf("Meeting y")).getByText(/31 checked in/)).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByText("Meeting y")).toBeNull();
    rerender(card([yesterday, ...pastEvents, ...upcomingEvents]));
    expect(screen.getByRole("button", { name: "Show 24 past meetings" })).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps a row whose form is open when its page is left, and when the fold closes", () => {
    show({ events: [{ ...event("y", -1) }, ...upcomingEvents] });
    fireEvent.click(within(rowOf("Meeting u02")).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(rowOf("Meeting u02")).getByLabelText("Title"), { target: { value: "Renamed meeting" } });
    fireEvent.click(within(screen.getByRole("navigation", { name: "Upcoming" })).getByRole("button", { name: "Next" }));
    expect(shownTitles().slice(0, 3)).toEqual(["Meeting u11", "Meeting u12", "Meeting u02"]);
    expect(within(rowOf("Meeting u02")).getByLabelText("Title")).toHaveValue("Renamed meeting");
    fireEvent.click(within(rowOf("Meeting u02")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Meeting u02")).toBeNull();

    fireEvent.click(within(rowOf("Meeting y")).getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide past meetings" }));
    expect(within(rowOf("Meeting y")).getByLabelText("Title")).toBeInTheDocument();
  });

  it("does not say past meetings are hidden while a past row with an open form is in view", () => {
    show({ events: [{ ...event("y", -1) }, ...upcomingEvents] });
    fireEvent.click(within(rowOf("Meeting y")).getByRole("button", { name: "Edit" }));
    const toggle = screen.getByRole("button", { name: "Hide past meetings" });
    fireEvent.click(toggle);
    expect(screen.getByText("Meeting y", { selector: ".xus-etitle" })).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("Hide past meetings");
    fireEvent.click(within(rowOf("Meeting y")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Meeting y")).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("Show 1 past meeting");
  });

  it("moves to a page that still exists when the list shrinks", () => {
    const { rerender } = show({ events: upcomingEvents });
    fireEvent.click(within(screen.getByRole("navigation", { name: "Upcoming" })).getByRole("button", { name: "Next" }));
    expect(shownTitles()).toEqual(["Meeting u11", "Meeting u12"]);
    rerender(card(upcomingEvents.slice(0, 11)));
    expect(shownTitles()).toEqual(["Meeting u11"]);
    rerender(card(upcomingEvents.slice(0, 10)));
    expect(shownTitles()).toEqual(upcomingEvents.slice(0, 10).map((item) => item.title));
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("makes each meeting title a heading under its group", () => {
    show();
    const groups = screen.getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent);
    expect(groups).toEqual(["Upcoming", "Past meetings"]);
    const titles = screen.getAllByRole("heading", { level: 5 }).map((heading) => heading.textContent);
    expect(titles).toEqual(upcomingEvents.slice(0, 10).map((item) => item.title));
  });

  it("puts groups and meetings right under the page's h1 on the Meetings desk", () => {
    show({ showHeading: false });
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Upcoming", "Past meetings"]);
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(upcomingEvents.slice(0, 10).map((item) => item.title));
    expect(screen.queryByRole("heading", { level: 4 })).toBeNull();
    expect(screen.queryByRole("heading", { level: 5 })).toBeNull();
    cleanup();
    show({ events: upcomingEvents.slice(0, 2), showHeading: false });
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Meeting u01", "Meeting u02"]);
  });

  it("puts meeting titles one level under the card when there are no group headings", () => {
    show({ events: upcomingEvents.slice(0, 2) });
    expect(screen.getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent)).toEqual(["Meeting u01", "Meeting u02"]);
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("button", { name: /past event/ })).toBeNull();
  });

  it("says one past meeting in the singular, in English and Spanish", () => {
    show({ events: [pastEvents[0], ...upcomingEvents] });
    expect(screen.getByRole("button", { name: "Show 1 past meeting" })).toBeInTheDocument();
    cleanup();
    show({ events: [pastEvents[0], ...upcomingEvents], lang: "es" });
    expect(screen.getByRole("button", { name: "Mostrar 1 reunión pasada" })).toBeInTheDocument();
  });

});

// eventIsPast reads the browser clock (Date.now()). A timed event is past once
// its end, or its start when it has no end, is more than six hours behind that
// clock; a date-only event is past once its date is before today's Eastern
// calendar date. So nothing that is still to come today, or still under way,
// is folded away.
describe("which meetings count as past", () => {
  const noonEastern = Date.parse("2026-11-23T12:00:00-05:00");

  it("keeps an meeting later today and one under way since this morning upcoming", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(noonEastern);
    const laterToday = { id: "later", title: "Later today", startsAt: "2026-11-23T18:00:00-05:00", endsAt: "2026-11-23T19:00:00-05:00", location: "Hall", eventKind: "meeting" };
    const underWay = { id: "under-way", title: "Under way", startsAt: "2026-11-23T09:00:00-05:00", endsAt: "2026-11-23T15:00:00-05:00", location: "Hall", eventKind: "meeting" };
    const deadlineToday = { id: "deadline", title: "Due today", eventDate: "2026-11-23", eventKind: "deadline", location: "" };
    const endedYesterday = { id: "done", title: "Ended yesterday", startsAt: "2026-11-22T18:00:00-05:00", endsAt: "2026-11-22T19:00:00-05:00", location: "Hall", eventKind: "meeting" };
    for (const item of [laterToday, underWay, deadlineToday]) expect(eventIsPast(item, Date.now())).toBe(false);
    expect(eventIsPast(endedYesterday, Date.now())).toBe(true);
    expect(eventEndedSince(endedYesterday, Date.now() - 7 * DAY)).toBe(true);
    expect(eventEndedSince({ ...endedYesterday, endsAt: "2026-11-15T19:00:00-05:00" }, Date.now() - 7 * DAY)).toBe(false);
    expect(eventEndedSince({ eventDate: "2026-11-16" }, Date.now() - 7 * DAY)).toBe(true);
    expect(eventEndedSince({ eventDate: "2026-11-15" }, Date.now() - 7 * DAY)).toBe(false);

    show({ events: [laterToday, underWay, deadlineToday, endedYesterday] });
    expect(screen.getAllByRole("heading", { level: 5 }).slice(0, 3).map((heading) => heading.textContent))
      .toEqual(["Under way", "Later today", "Due today"]);
    expect(within(rowOf("Ended yesterday")).getByText("Past")).toBeInTheDocument();
  });
});
