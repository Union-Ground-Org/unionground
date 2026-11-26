import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventAuthoringCard } from "../src/components/EventAuthoringCard.jsx";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

// REQ-UG-EVENTS-CARD-HIERARCHY-20261102: each event stacked its
// metadata, quorum, scope, door code and two unexplained menus down one narrow
// column, and October events read like upcoming ones. An event now reads as a
// summary beside Manage meeting, then named sections for attendance and quorum,
// the door and follow-up; past events sit under their own heading and badge.

const DAY = 24 * 3600 * 1000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();
const upcoming = {
  id: "next", title: "Chapter meeting", startsAt: iso(5), endsAt: iso(5.05), startsLabel: "In five days", location: "Union hall",
  checkInCode: "SG-NEXT", chapterName: "Cedar Ridge Care Services", rsvpCount: 12, checkinCount: 0, eventKind: "meeting",
};
const past = { ...upcoming, id: "done", title: "October general meeting", startsAt: iso(-13), endsAt: iso(-12.95), startsLabel: "Two weeks ago", checkInCode: "SG-DONE", rsvpCount: 30, checkinCount: 21 };

function show({ events = [past, upcoming], lang = "en", api = {}, connected = true } = {}) {
  const stub = {
    updateEvent: vi.fn().mockResolvedValue({ updated: true }), cancelEvent: vi.fn().mockResolvedValue({ changed: true }),
    restoreEvent: vi.fn(), deleteEvent: vi.fn(), createEvent: vi.fn(),
    loadEventQuorum: vi.fn().mockResolvedValue([{ eventId: "next", quorum: null, checkedIn: 0 }, { eventId: "done", quorum: 20, checkedIn: 21 }]),
    setEventQuorum: vi.fn().mockResolvedValue({}),
    ...api,
  };
  const onNotice = vi.fn();
  render(<LanguageProvider lang={lang}>
    <EventAuthoringCard events={events} api={stub} onNotice={onNotice} reload={vi.fn()} chapterName="Cedar Ridge Care Services"
      renderConnectedActions={connected ? (item) => <button type="button">Actions for {item.title}</button> : null} />
  </LanguageProvider>);
  return { stub, onNotice };
}

const row = (title) => screen.getByText(title, { selector: ".xus-etitle" }).closest(".xus-erow");

afterEach(() => { cleanup(); clearDeviceParityState(); });

describe("events desk hierarchy", () => {
  it("lists upcoming events first and past events under their own heading with a badge", () => {
    show();
    const headings = screen.getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["Upcoming", "Past meetings"]);
    // #9560: past events stay folded until asked for.
    fireEvent.click(screen.getByRole("button", { name: "Show 1 past meeting" }));
    const titles = [...document.querySelectorAll(".xus-etitle")].map((title) => title.textContent);
    expect(titles).toEqual(["Chapter meeting", "October general meeting"]);
    expect(within(row("October general meeting")).getByText("Past")).toHaveClass("xus-badge");
    expect(within(row("Chapter meeting")).queryByText("Past")).toBeNull();
  });

  it("adds no group headings when every event is upcoming", () => {
    show({ events: [upcoming] });
    expect(document.querySelector(".xus-event-group__title")).toBeNull();
    expect(screen.getByRole("heading", { level: 4 })).toHaveTextContent("Chapter meeting");
  });


  it("keeps Manage meeting's operations and saves a quorum from the attendance section", async () => {
    const { stub } = show();
    const next = within(row("Chapter meeting"));
    fireEvent.click(next.getByText("Manage meeting"));
    for (const name of ["Edit", "Cancel meeting", "Delete meeting"]) expect(next.getByRole("button", { name })).toBeInTheDocument();
    const attendance = next.getByRole("region", { name: "Attendance and quorum" });
    fireEvent.change(within(attendance).getByRole("spinbutton"), { target: { value: "25" } });
    fireEvent.click(within(attendance).getByRole("button", { name: /Save quorum/ }));
    await waitFor(() => expect(stub.setEventQuorum).toHaveBeenCalledWith("next", 25));
  });

  it("opens the door display from the door section", () => {
    show();
    fireEvent.click(within(within(row("Chapter meeting")).getByRole("region", { name: "Door check-in" })).getByRole("button", { name: "Show door display" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("SG-NEXT");
  });

  it("offers no follow-up section or hint where the desk has no connected actions", () => {
    show({ connected: false });
    expect(screen.queryByRole("region", { name: "Follow up" })).toBeNull();
    expect(screen.queryByText(/Manage meeting changes the event itself/)).toBeNull();
  });

  it("says the same in Spanish", () => {
    show({ lang: "es" });
    expect(screen.getByRole("heading", { level: 4, name: "Reuniones pasadas" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mostrar 1 reunión pasada" }));
    expect(within(row("October general meeting")).getByText("Pasado")).toBeInTheDocument();
    expect(within(row("Chapter meeting")).getByRole("region", { name: "Asistencia y quórum" })).toBeInTheDocument();
  });
});
