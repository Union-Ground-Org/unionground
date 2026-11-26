import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventsView } from "../src/views/EventsView.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

const data = {
  member: { initials: "PR" },
  events: [
    { id: "evt-1", title: "Campaign meeting", startsAt: "2026-07-30T18:00:00Z", dateLabel: "Thu, Jul 30", timeLabel: "6:00 PM", location: "Boston office hall", summary: "Bargaining update.", chapterName: "Harborview Care United", isPublic: false, isPublicAcrossAgencies: false, rsvpStatus: null, checkedIn: false, checkInOffered: true },
    { id: "evt-2", title: "Caseload rally", startsAt: "2026-08-11T16:00:00Z", dateLabel: "Tue, Aug 11", timeLabel: "12:00 PM", location: "State House", summary: "Bring your shirt.", chapterName: "Harborview Care United", isPublic: true, isPublicAcrossAgencies: true, rsvpStatus: "going", checkedIn: false, checkInOffered: true },
  ],
  // Union Ground has no points economy. A stale catalogue that still pays
  // points must not bring a "+N pts" chip or a points variant of RSVP or
  // check-in back: the labels below are plain copy, whatever the rules say.
  rewardsCatalog: {
    rules: [
      { actionKind: "rsvp", label: "RSVP to an event", points: 45, weeklyCap: null },
      { actionKind: "checkin", label: "Check in at an event", points: 55, weeklyCap: null },
    ],
  },
};

// One hour before "Campaign meeting" starts: inside the 2-hours-before to
// 4-hours-after window in which the server issues and accepts check-in codes.
const IN_CHECKIN_WINDOW = new Date("2026-07-30T17:00:00Z");
const readInactiveCalendarFeed = async () => false;

describe("events view", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: IN_CHECKIN_WINDOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('orders local days with dated items last and promotes only meetings', () => {
    const meeting = { ...data.events[0], id: 'late', title: 'Late Oct 12 meeting', startsAt: '2026-10-12T20:30:00', eventKind: 'meeting' };
    const deadline = { ...data.events[0], id: 'deadline', title: 'Oct 13 deadline', startsAt: null, eventKind: 'deadline', eventDate: '2026-10-13' };
    const sameDay = { ...deadline, id: 'same-day', title: 'Oct 12 deadline', eventDate: '2026-10-12' };
    render(<EventsView data={{ ...data, events: [deadline, sameDay, meeting] }} onRsvp={vi.fn()} onCheckIn={vi.fn()} />);
    expect(within(screen.getByRole('region', { name: "Next meeting" })).getByRole('heading', { name: meeting.title })).toBeInTheDocument();
    const titles = Array.from(screen.getByRole('region', { name: "Upcoming meetings" }).querySelectorAll('.mevents-row__title')).map((node) => node.textContent);
    expect(titles).toEqual([meeting.title, sameDay.title, deadline.title]);
  });

  it.each([true, false])("hides code-free check-in even with window enforcement %s", (checkinWindowEnforced) => {
    const onCheckIn = vi.fn();
    const onRequestCheckinCode = vi.fn();
    render(<EventsView data={{ ...data, events: [{ ...data.events[0], checkInOffered: false }] }} onRsvp={vi.fn()} onCheckIn={onCheckIn} onRequestCheckinCode={onRequestCheckinCode} checkinWindowEnforced={checkinWindowEnforced} />);
    fireEvent.click(screen.getByRole("button", { name: "Details — Campaign meeting" }));
    expect(screen.getAllByText("No check-in")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Check in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "My check-in code" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Add to calendar" }).length).toBeGreaterThan(0);
    // The next-up hero and the event's row each offer a plain RSVP.
    expect(screen.getAllByRole("button", { name: "RSVP" })).toHaveLength(2);
    expect(within(screen.getByRole("region", { name: "Next meeting" })).getByRole("button", { name: "RSVP" })).toBeInTheDocument();
    expect(onCheckIn).not.toHaveBeenCalled();
    expect(onRequestCheckinCode).not.toHaveBeenCalled();
  });

  it("retires open forms and minted codes when check-in is removed", async () => {
    const onRequestCheckinCode = vi.fn().mockResolvedValue({ token: "ABC1234", expiresAt: new Date(Date.now() + 90000).toISOString(), ttlSeconds: 90 });
    const props = { onRsvp: vi.fn(), onCheckIn: vi.fn(), onRequestCheckinCode };
    const view = render(<EventsView data={data} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Check in" }));
    expect(await screen.findByLabelText("Meeting check-in code")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "My check-in code" }));
    expect(await screen.findByText("ABC1234")).toBeInTheDocument();
    view.rerender(<EventsView data={{ ...data, events: [{ ...data.events[0], checkInOffered: false }] }} {...props} />);
    expect(screen.queryByLabelText("Meeting check-in code")).toBeNull();
    expect(screen.queryByText("ABC1234")).toBeNull();
    expect(screen.queryByRole("button", { name: "My check-in code" })).toBeNull();
    expect(onRequestCheckinCode).toHaveBeenCalledTimes(1);
  });

  it("renders the next-up hero and the event list", () => {
    render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Meetings" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Upcoming meetings" })).toBeInTheDocument();
    // The soonest event is promoted to the NEXT UP hero and still keeps its
    // list row, so it renders in exactly two places.
    const hero = screen.getByRole("region", { name: "Next meeting" });
    expect(within(hero).getByText("NEXT UP")).toBeInTheDocument();
    expect(within(hero).getByRole("heading", { name: "Campaign meeting" })).toBeInTheDocument();
    expect(screen.getAllByText("Campaign meeting")).toHaveLength(2);
    // The RSVP'd event surfaces in the Your RSVPs card with its date.
    expect(screen.getByText("Your RSVPs")).toBeInTheDocument();
    expect(screen.getByText("Caseload rally · Tue, Aug 11")).toBeInTheDocument();
    expect(screen.getAllByText("Harborview Care United campaign").length).toBeGreaterThan(0);
    // Union Ground has no public events: even a row still flagged public
    // across agencies reads as its own campaign's meeting.
    expect(screen.queryByText("All agencies")).toBeNull();
    expect(screen.queryByText("Same agency")).toBeNull();
  });

  it("shows no points figure whatever the rules pay", () => {
    for (const points of [0, 45]) {
      const catalogue = { ...data, rewardsCatalog: { rules: data.rewardsCatalog.rules.map((rule) => ({ ...rule, points })) } };
      const view = render(<EventsView data={catalogue} onRsvp={vi.fn()} onCheckIn={vi.fn()} onRequestCheckinCode={vi.fn()} />);
      expect(screen.queryByText(/pts/)).toBeNull();
      expect(screen.queryByText(/\+\d+/)).toBeNull();
      expect(screen.queryByRole("button", { name: /pts/ })).toBeNull();
      expect(view.container.querySelector(".mevents-chip--green")).toBeNull();
      expect(screen.getAllByRole("button", { name: "RSVP" }).length).toBeGreaterThan(0);
      view.unmount();
    }
  });

  it("confirms a check-in in plain copy, without a points figure", () => {
    const checkedIn = { ...data, events: [{ ...data.events[0], checkedIn: true }, data.events[1]] };
    render(<EventsView data={checkedIn} onRsvp={vi.fn()} onCheckIn={vi.fn()} />);
    expect(screen.getAllByText("Checked in").length).toBeGreaterThan(0);
    expect(screen.queryByText(/pts|points/i)).toBeNull();
  });

  it("renders the next event's location and summary as separate paragraphs", () => {
    // BUG-UG-EVENT-LOCATION-AND-SUMMARY-READ-AS-ONE-STRING-20261006:
    // one paragraph split by a <br> read as "Boston office hallBargaining update."
    render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} />);
    const hero = screen.getByRole("region", { name: "Next meeting" });
    const location = within(hero).getByText("Boston office hall");
    const summary = within(hero).getByText("Bargaining update.");
    expect(location.tagName).toBe("P");
    expect(summary.tagName).toBe("P");
    expect(location).not.toBe(summary);
  });

  it("omits an empty location or summary paragraph from the next-event hero", () => {
    const noSummary = { ...data, events: [{ ...data.events[0], summary: "" }, data.events[1]] };
    render(<EventsView data={noSummary} onRsvp={vi.fn()} onCheckIn={vi.fn()} />);
    const hero = screen.getByRole("region", { name: "Next meeting" });
    expect(hero.querySelectorAll("p.mevents-hero__body")).toHaveLength(1);
    expect(within(hero).getByText("Boston office hall").tagName).toBe("P");
  });

  it("keeps authorized regional events in the full directory", () => {
    const regional = {
      ...data,
      events: [
        ...data.events,
        { id: "evt-regional", title: "Neighbor chapter training", startsAt: "2026-08-12T16:00:00Z", dateLabel: "Wed, Aug 12", timeLabel: "12:00 PM", location: "Regional hall", summary: "Open regional training.", chapterName: "Neighbor chapter", isPublic: true, isPublicAcrossAgencies: false, rsvpStatus: null, checkedIn: false },
      ],
    };
    render(<EventsView data={regional} onRsvp={vi.fn()} onCheckIn={vi.fn()} />);
    expect(screen.getAllByText("Neighbor chapter training").length).toBeGreaterThan(0);
  });

  it("RSVPs to the next event as going", () => {
    const onRsvp = vi.fn();
    render(<EventsView data={data} onRsvp={onRsvp} onCheckIn={vi.fn()} />);
    const hero = screen.getByRole("region", { name: "Next meeting" });
    fireEvent.click(within(hero).getByRole("button", { name: "RSVP" }));
    expect(onRsvp).toHaveBeenCalledWith("evt-1", "going");
  });

  // Regression (N06): the RSVP button had no busy state at all, so on a slow
  // link a tap gave zero feedback until the whole mutate -> refresh cycle
  // finished and an impatient second tap fired a duplicate rsvp_to_event.
  it("disables the RSVP button while the write is in flight", async () => {
    let settle;
    const onRsvp = vi.fn(() => new Promise((resolve) => { settle = resolve; }));
    render(<EventsView data={data} onRsvp={onRsvp} onCheckIn={vi.fn()} />);
    const rsvp = within(screen.getByRole("region", { name: "Next meeting" })).getByRole("button", { name: "RSVP" });
    fireEvent.click(rsvp);
    // Pending, not natively disabled (record 8435): it keeps focus and refuses.
    await waitFor(() => expect(rsvp).toHaveAttribute("aria-disabled", "true"));
    // A second tap while pending must not reach the RPC.
    fireEvent.click(rsvp);
    expect(onRsvp).toHaveBeenCalledTimes(1);
    settle({});
    await waitFor(() => expect(rsvp).not.toHaveAttribute("aria-disabled"));
  });

  // Regression (WL-21): App's mutate() toasts the failure and then re-throws.
  // Wired straight to onClick that rejection had nowhere to go and surfaced as
  // an unhandled promise rejection — which makes the team's "zero console
  // errors" browser gate impossible to assert honestly.
  it("settles a rejected RSVP instead of leaking an unhandled rejection", async () => {
    const unhandled = [];
    const onUnhandled = (event) => { unhandled.push(event); event.preventDefault(); };
    window.addEventListener("unhandledrejection", onUnhandled);
    try {
      const onRsvp = vi.fn().mockRejectedValue(new Error("network down"));
      render(<EventsView data={data} onRsvp={onRsvp} onCheckIn={vi.fn()} />);
      const rsvp = within(screen.getByRole("region", { name: "Next meeting" })).getByRole("button", { name: "RSVP" });
      fireEvent.click(rsvp);
      await waitFor(() => expect(rsvp).not.toBeDisabled());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toHaveLength(0);
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled);
    }
  });

  it("reveals the check-in form and submits the entered code", async () => {
    const onCheckIn = vi.fn().mockResolvedValue({});
    render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={onCheckIn} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Check in" })[0]);
    const input = await screen.findByLabelText("Meeting check-in code");
    fireEvent.change(input, { target: { value: "SG-CHAPTER" } });
    const form = input.closest("form");
    expect(within(form).queryByText(/pts/)).toBeNull();
    fireEvent.click(within(form).getByRole("button", { name: "Check in" }));
    await waitFor(() => expect(onCheckIn).toHaveBeenCalledWith("evt-1", "SG-CHAPTER"));
  });

  it("shows an empty state when there are no events", () => {
    render(<EventsView data={{ member: { initials: "PR" }, events: [] }} onRsvp={vi.fn()} onCheckIn={vi.fn()} />);
    expect(screen.getByText("No upcoming meetings right now — new campaign meetings will appear here.")).toBeInTheDocument();
  });

  it("shows past events as non-actionable attendance history", () => {
    const historyData = {
      ...data,
      events: [
        { id: "past-attended", title: "Spring meeting", startsAt: "2026-04-10T18:00:00Z", dateLabel: "Fri, Apr 10", timeLabel: "2:00 PM", location: "Union hall", isPast: true, checkedIn: true },
        { id: "past-unrecorded", title: "Winter training", startsAt: "2026-01-10T18:00:00Z", dateLabel: "Sat, Jan 10", timeLabel: "1:00 PM", location: "Online", isPast: true, checkedIn: false },
      ],
    };
    render(<EventsView data={historyData} onRsvp={vi.fn()} onCheckIn={vi.fn()} onRequestCheckinCode={vi.fn()} />);
    const history = screen.getByRole("region", { name: "Past meetings and attendance" });
    expect(within(history).getByText("Spring meeting")).toBeInTheDocument();
    expect(within(history).getByText("Attended")).toBeInTheDocument();
    expect(within(history).getByText("No check-in recorded")).toBeInTheDocument();
    expect(within(history).queryByRole("button")).not.toBeInTheDocument();
  });

  it("puts the attendance history behind a disclosure the single-column layout can collapse", () => {
    // The single-column (phone/tablet) layout runs under the shell's fixed
    // home orb, so the archive opens on demand there: CSS hides the toggle and
    // shows the history once the two-column layout has room. The control lives
    // OUTSIDE the history region so the region itself stays free of controls.
    const historyData = {
      ...data,
      events: [{ id: "past-attended", title: "Spring meeting", startsAt: "2026-04-10T18:00:00Z", dateLabel: "Fri, Apr 10", timeLabel: "2:00 PM", location: "Union hall", isPast: true, checkedIn: true }],
    };
    const { container } = render(<EventsView data={historyData} onRsvp={vi.fn()} onCheckIn={vi.fn()} onRequestCheckinCode={vi.fn()} />);
    const toggle = screen.getByRole("button", { name: /Past meetings and attendance/ });
    const history = screen.getByRole("region", { name: "Past meetings and attendance" });
    expect(toggle.getAttribute("aria-controls")).toBe(history.id);
    expect(history.contains(toggle)).toBe(false);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".mevents-historywrap--open")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".mevents-historywrap--open")).not.toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("mints and renders the signed check-in code with a live countdown", async () => {
    const onRequestCheckinCode = vi.fn().mockResolvedValue({
      token: "ABC1234",
      expiresAt: new Date(Date.now() + 90000).toISOString(),
      ttlSeconds: 90,
    });
    render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} onRequestCheckinCode={onRequestCheckinCode} />);
    fireEvent.click(screen.getAllByRole("button", { name: "My check-in code" })[0]);
    expect(await screen.findByText("ABC1234")).toBeInTheDocument();
    expect(onRequestCheckinCode).toHaveBeenCalledWith("evt-1");
    expect(screen.getByText(/Expires in \d+s/)).toBeInTheDocument();
    expect(screen.getByText("Show this code to the committee member at the door.")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "QR code for this check-in code" })).toBeInTheDocument();
  });

  it("does not re-mint the live code when the parent re-renders with a fresh callback identity", async () => {
    const first = vi.fn().mockResolvedValue({ token: "ABC1234", expiresAt: new Date(Date.now() + 90000).toISOString(), ttlSeconds: 90 });
    const { rerender } = render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} onRequestCheckinCode={first} />);
    fireEvent.click(screen.getAllByRole("button", { name: "My check-in code" })[0]);
    expect(await screen.findByText("ABC1234")).toBeInTheDocument();
    // App rebuilds its handlers on every render (a toast dismissing is
    // enough); the live code must survive that — every server mint deletes
    // the previous token, which would invalidate the code mid-scan.
    const second = vi.fn().mockResolvedValue({ token: "DEF5678", expiresAt: new Date(Date.now() + 90000).toISOString(), ttlSeconds: 90 });
    rerender(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} onRequestCheckinCode={second} />);
    expect(screen.getByText("ABC1234")).toBeInTheDocument();
    expect(second).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledTimes(1);
  });

  // Regression (BUG-UG-EVENTS-DOUBLE-CHECKIN-CODE-MINT-20260920): the
  // soonest event renders a CheckinCodeTile in BOTH the aside check-in card
  // and its list row, and every server mint DELETES the previous unconsumed
  // token for the event. With per-tile mint guards, opening both surfaces
  // minted twice — and the second mint invalidated the code the first tile
  // was still showing the steward.
  it("shares one live code between the aside and list-row tiles instead of minting twice", async () => {
    const onRequestCheckinCode = vi.fn()
      .mockResolvedValueOnce({ token: "ABC1234", expiresAt: new Date(Date.now() + 90000).toISOString(), ttlSeconds: 90 })
      .mockResolvedValue({ token: "DEF5678", expiresAt: new Date(Date.now() + 90000).toISOString(), ttlSeconds: 90 });
    render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} onRequestCheckinCode={onRequestCheckinCode} />);
    // Only the aside's "My check-in code" exists until a row is expanded.
    fireEvent.click(screen.getAllByRole("button", { name: "My check-in code" })[0]);
    expect(await screen.findByText("ABC1234")).toBeInTheDocument();
    expect(onRequestCheckinCode).toHaveBeenCalledTimes(1);
    // Now reveal the same event's tile in the list row: it must reuse the
    // live token, not mint a second one (which would kill the first code).
    fireEvent.click(screen.getByRole("button", { name: "Details — Campaign meeting" }));
    fireEvent.click(screen.getAllByRole("button", { name: "My check-in code" })[0]);
    expect(screen.getAllByText("ABC1234")).toHaveLength(2);
    expect(onRequestCheckinCode).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("DEF5678")).not.toBeInTheDocument();
  });

  it("does not double-mint when both tiles mount before the first mint resolves", async () => {
    let settle;
    const onRequestCheckinCode = vi.fn(() => new Promise((resolve) => { settle = resolve; }));
    render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} onRequestCheckinCode={onRequestCheckinCode} />);
    // Aside tile starts the mint but the RPC stays in flight…
    fireEvent.click(screen.getAllByRole("button", { name: "My check-in code" })[0]);
    // …and the row tile mounts for the same event mid-flight.
    fireEvent.click(screen.getByRole("button", { name: "Details — Campaign meeting" }));
    fireEvent.click(screen.getAllByRole("button", { name: "My check-in code" })[0]);
    expect(onRequestCheckinCode).toHaveBeenCalledTimes(1);
    settle({ token: "ABC1234", expiresAt: new Date(Date.now() + 90000).toISOString(), ttlSeconds: 90 });
    // Both tiles land on the same single-minted token.
    expect(await screen.findAllByText("ABC1234")).toHaveLength(2);
    expect(onRequestCheckinCode).toHaveBeenCalledTimes(1);
  });

  it("re-mints once from 'Get a new code' and updates every tile for the event", async () => {
    const onRequestCheckinCode = vi.fn()
      .mockResolvedValueOnce({ token: "ABC1234", expiresAt: new Date(Date.now() + 1000).toISOString(), ttlSeconds: 1 })
      .mockResolvedValue({ token: "DEF5678", expiresAt: new Date(Date.now() + 90000).toISOString(), ttlSeconds: 90 });
    render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} onRequestCheckinCode={onRequestCheckinCode} />);
    fireEvent.click(screen.getAllByRole("button", { name: "My check-in code" })[0]);
    expect(await screen.findByText("ABC1234")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Details — Campaign meeting" }));
    fireEvent.click(screen.getAllByRole("button", { name: "My check-in code" })[0]);
    expect(screen.getAllByText("ABC1234")).toHaveLength(2);
    // The one-second token runs out: both tiles fall to the expired state.
    expect(await screen.findAllByText("Code expired")).toHaveLength(2);
    const renewButtons = screen.getAllByRole("button", { name: "Get a new code" });
    expect(renewButtons).toHaveLength(2);
    fireEvent.click(renewButtons[0]);
    // One re-mint updates both tiles; the stale token disappears everywhere.
    await waitFor(() => expect(screen.getAllByText("DEF5678")).toHaveLength(2));
    expect(screen.queryByText("ABC1234")).not.toBeInTheDocument();
    expect(onRequestCheckinCode).toHaveBeenCalledTimes(2);
  });

  // Regression (A11Y-UG-CHECKIN-CODE-TILE-ANNOUNCES-EVERY-SECOND-20260920):
  // wrapping the QR, token, instructions, and per-second countdown in
  // role=status made every tick a new atomic live-region mutation. The region
  // must exist before the mint resolves, announce ready once (with the token)
  // and expiry once, and leave the visible countdown outside that region.
  it("announces the check-in code once when it is ready and once when it expires, not on countdown ticks", async () => {
    vi.useFakeTimers({ now: IN_CHECKIN_WINDOW });
    try {
      let settle;
      const minted = new Promise((resolve) => { settle = resolve; });
      const onRequestCheckinCode = vi.fn(() => minted);
      render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} onRequestCheckinCode={onRequestCheckinCode} />);
      fireEvent.click(screen.getAllByRole("button", { name: "My check-in code" })[0]);
      const tile = document.querySelector(".mevents-code-tile");
      expect(tile).not.toBeNull();
      const live = within(tile).getByRole("status");
      expect(live).toHaveClass("visually-hidden");
      expect(live.textContent).toBe("");

      await act(async () => {
        settle({
          token: "ABC1234",
          expiresAt: new Date(Date.now() + 10_000).toISOString(),
          ttlSeconds: 10,
        });
        await minted;
      });

      expect(screen.getByText("ABC1234")).toBeInTheDocument();
      const readyText = live.textContent;
      expect(readyText).toContain("ABC1234");
      expect(readyText).toBe("Check-in code ABC1234 is ready.");
      const countdown = screen.getByText(/Expires in \d+s/);
      expect(live.contains(countdown)).toBe(false);
      const countdownBefore = countdown.textContent;

      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      const countdownAfter = screen.getByText(/Expires in \d+s/).textContent;
      expect(countdownAfter).not.toBe(countdownBefore);
      expect(live.textContent).toBe(readyText);
      expect(live.contains(screen.getByText(/Expires in \d+s/))).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      const expiredText = live.textContent;
      expect(expiredText).toBe("The check-in code has expired.");
      expect(expiredText).not.toBe(readyText);
      expect(screen.getByText("Code expired")).toBeInTheDocument();
      expect(live.contains(screen.getByText("Code expired"))).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(3_000);
      });
      expect(live.textContent).toBe(expiredText);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the honor-code check-in path alongside the signed one", () => {
    render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} onRequestCheckinCode={vi.fn()} />);
    // Both affordances coexist per event: the on-site code form and the
    // member's own signed code — retiring either is a regression.
    expect(screen.getAllByRole("button", { name: "Check in" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "My check-in code" }).length).toBeGreaterThan(0);
  });

  it("distinguishes the upcoming-events snapshot from the live RSVP feed", async () => {
    const rotate = vi.fn().mockResolvedValue({ token: "live-token" });
    const revoke = vi.fn().mockResolvedValue({ revoked: true });
    render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} loadCalendarFeedStatus={readInactiveCalendarFeed} onCalendarRotate={rotate} onCalendarRevoke={revoke} />);
    // Presence only — jsdom has no createObjectURL. The hero always carries
    // one for the next event…
    expect(screen.getAllByRole("button", { name: "Add to calendar" })).toHaveLength(1);
    // …and every list row keeps its own behind the disclosure panel.
    for (const event of data.events) {
      fireEvent.click(screen.getByRole("button", { name: `Details — ${event.title}` }));
    }
    expect(screen.getAllByRole("button", { name: "Add to calendar" })).toHaveLength(1 + data.events.length);
    // The snapshot and subscription are separate, truthfully labelled paths.
    expect(screen.getByRole("button", { name: "Download upcoming-meetings snapshot" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Get live calendar link" }));
    const feedInput = await screen.findByDisplayValue(`${window.location.origin}/api/calendar?token=live-token`);
    expect(feedInput).toBeInTheDocument();
    expect(rotate).toHaveBeenCalledTimes(1);
    // The one-time link is read-only and auto-selects on focus so a member
    // can copy it in a single keystroke instead of hand-selecting the text.
    const selectSpy = vi.spyOn(feedInput, "select");
    fireEvent.focus(feedInput);
    expect(selectSpy).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Turn off calendar link" }));
    expect(await screen.findByRole("button", { name: "Get live calendar link" })).toBeInTheDocument();
    expect(revoke).toHaveBeenCalledTimes(1);
    // Revoking clears the once-shown link — it does not linger as stale UI.
    expect(screen.queryByDisplayValue(`${window.location.origin}/api/calendar?token=live-token`)).not.toBeInTheDocument();
  });

  it("keeps the calendar subscription copy in the responsive calendar grid", async () => {
    render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} loadCalendarFeedStatus={readInactiveCalendarFeed} onCalendarRotate={vi.fn()} />);
    await screen.findByRole("button", { name: "Get live calendar link" });
    const title = screen.getByText("Campaign meetings calendar");
    const card = title.closest(".mevents-card");
    const row = card?.querySelector(".mevents-card__row");

    expect(card).toHaveClass("mevents-calendar-card");
    expect(row?.querySelector(".mevents-cardtext")).toContainElement(title);
    expect(row?.querySelector(".mevents-calendar-actions")).toBeInTheDocument();
  });

  it("keeps the snapshot-only path when no live calendar feed is wired", () => {
    render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} />);
    // Callers that have not wired the feed endpoints (or lack the feature)
    // must not see the share warning or the mint/revoke affordances at all.
    expect(screen.queryByText(/Anyone with this link can see the events/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Get live calendar link" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn off calendar link" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download upcoming-meetings snapshot" })).toBeInTheDocument();
  });

  it("leaves the mint button usable and reveals no link when rotate fails", async () => {
    const rotate = vi.fn().mockRejectedValue(new Error("network down"));
    render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} loadCalendarFeedStatus={readInactiveCalendarFeed} onCalendarRotate={rotate} onCalendarRevoke={vi.fn()} />);
    const mintButton = await screen.findByRole("button", { name: "Get live calendar link" });
    fireEvent.click(mintButton);
    await waitFor(() => expect(mintButton).not.toBeDisabled());
    expect(rotate).toHaveBeenCalledTimes(1);
    // A failed mint must not fabricate a feed link for the member to copy.
    expect(screen.queryByLabelText("Live RSVP calendar link")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get live calendar link" })).toBeInTheDocument();
  });

  // Regression (SOL-20260813-08): the bearer-link warning rendered after the
  // mint button with no programmatic association, so a screen reader
  // announced neither the risk nor — once the mint button unmounted on
  // success — anything at all. The warning must be reachable from the
  // button, and a successful mint must move focus to the revealed one-time
  // link and announce it via a polite live region.
  it("associates the bearer-link warning with the mint button via aria-describedby", async () => {
    const rotate = vi.fn().mockResolvedValue({ token: "live-token" });
    render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} loadCalendarFeedStatus={readInactiveCalendarFeed} onCalendarRotate={rotate} />);
    const mintButton = await screen.findByRole("button", { name: "Get live calendar link" });
    const describedById = mintButton.getAttribute("aria-describedby");
    expect(describedById).toBeTruthy();
    const warning = document.getElementById(describedById);
    expect(warning).toHaveTextContent(
      "Anyone with this link can see the meetings you RSVP'd to. Don't share it — you can turn it off or get a new one here anytime.",
    );
  });

  it("moves focus to the revealed link input and announces the mint via a live region", async () => {
    const rotate = vi.fn().mockResolvedValue({ token: "live-token" });
    render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} loadCalendarFeedStatus={readInactiveCalendarFeed} onCalendarRotate={rotate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Get live calendar link" }));
    const link = await screen.findByDisplayValue(`${window.location.origin}/api/calendar?token=live-token`);
    await waitFor(() => expect(link).toHaveFocus());
    const announcement = screen.getByText("Live calendar link created. Copy it now — it won't be shown again.");
    expect(announcement.closest('[aria-live="polite"]')).toHaveAttribute("role", "status");
  });

  it("announces revocation through the same live region", async () => {
    const rotate = vi.fn().mockResolvedValue({ token: "live-token" });
    const revoke = vi.fn().mockResolvedValue({ revoked: true });
    render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} loadCalendarFeedStatus={readInactiveCalendarFeed} onCalendarRotate={rotate} onCalendarRevoke={revoke} />);
    fireEvent.click(await screen.findByRole("button", { name: "Get live calendar link" }));
    await screen.findByRole("button", { name: "Turn off calendar link" });
    fireEvent.click(screen.getByRole("button", { name: "Turn off calendar link" }));
    await screen.findByRole("button", { name: "Get live calendar link" });
    const announcement = screen.getByText("Live calendar link turned off.");
    expect(announcement.closest('[aria-live="polite"]')).toHaveAttribute("role", "status");
  });

  // Regression (BUG-UG-WEB-MEMBER-EVENT-PROJECTION-OMITS-CANCELLATION-
  // COLUMNS): the member event projection omitted cancelled_at/cancelled_reason,
  // so a cancelled upcoming event rendered exactly like a live one — badge-less,
  // with RSVP/check-in controls that the server guards then refused.
  const cancelledFirstData = {
    ...data,
    events: [
      { id: "evt-0", title: "Storm-cancelled forum", startsAt: "2026-07-25T18:00:00Z", dateLabel: "Sat, Jul 25", timeLabel: "6:00 PM", location: "Boston office hall", summary: "Parking lot update.", chapterName: "Harborview Care United", isPublic: false, isPublicAcrossAgencies: false, rsvpStatus: "going", checkedIn: false, cancelledAt: "2026-07-24T12:00:00Z", cancelledReason: "Weather" },
      ...data.events,
    ],
  };

  it("marks a cancelled event with a badge and reason and removes its action controls", () => {
    render(<EventsView data={cancelledFirstData} onRsvp={vi.fn()} onCheckIn={vi.fn()} onRequestCheckinCode={vi.fn()} />);
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByText("Reason: Weather")).toBeInTheDocument();
    const row = screen.getByText("Storm-cancelled forum").closest("article");
    expect(row).not.toBeNull();
    // The row offers no RSVP, check-in, or signed-code control for a cancelled
    // event — those writes fail server-side, so a live button is a false promise.
    expect(within(row).queryByRole("button", { name: "RSVP" })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Details — Storm-cancelled forum" }));
    expect(within(row).queryByRole("button", { name: "Check in" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "My check-in code" })).toBeNull();
  });

  it("never promotes a cancelled event to the next-event hero with an active RSVP", () => {
    render(<EventsView data={cancelledFirstData} onRsvp={vi.fn()} onCheckIn={vi.fn()} onRequestCheckinCode={vi.fn()} />);
    const hero = screen.getByRole("region", { name: "Next meeting" });
    // The soonest NON-cancelled event takes the hero…
    expect(within(hero).getByRole("heading", { name: "Campaign meeting" })).toBeInTheDocument();
    expect(within(hero).queryByText("Storm-cancelled forum")).toBeNull();
    // …with its RSVP still live, while the cancelled event appears only in the list.
    expect(within(hero).getByRole("button", { name: "RSVP" })).toBeInTheDocument();
    expect(screen.getAllByText("Storm-cancelled forum")).toHaveLength(1);
  });

  it("excludes a cancelled event from Your RSVPs even when a going RSVP remains", () => {
    render(<EventsView data={cancelledFirstData} onRsvp={vi.fn()} onCheckIn={vi.fn()} onRequestCheckinCode={vi.fn()} />);
    // cancel_member_event retains status='going'; the live Caseload rally stays
    // in the card, the cancelled forum must not appear with a green check.
    expect(screen.getByText("Your RSVPs")).toBeInTheDocument();
    expect(screen.getByText("Caseload rally · Tue, Aug 11")).toBeInTheDocument();
    expect(screen.queryByText("Storm-cancelled forum · Sat, Jul 25")).toBeNull();
    expect(screen.getAllByText("Storm-cancelled forum")).toHaveLength(1);
  });

  it("renders no hero or check-in card at all when every upcoming event is cancelled", () => {
    const allCancelled = {
      ...data,
      events: data.events.map((event) => ({ ...event, cancelledAt: "2026-07-20T12:00:00Z", cancelledReason: "Venue lost" })),
    };
    render(<EventsView data={allCancelled} onRsvp={vi.fn()} onCheckIn={vi.fn()} onRequestCheckinCode={vi.fn()} />);
    expect(screen.queryByRole("region", { name: "Next meeting" })).toBeNull();
    expect(screen.queryByText("At the meeting? Check in")).toBeNull();
    expect(screen.getAllByText("Cancelled").length).toBe(data.events.length);
  });

  // BUG-UG-WEB-CHECKIN-CODE-OFFERED-BEFORE-WINDOW-20261003: the code
  // and check-in controls were offered days ahead, and pressing them earned the
  // server's "only available around the event start time" refusal.
  it("offers check-in only from 2 hours before to 4 hours after the start, and says when it opens", () => {
    const onRequestCheckinCode = vi.fn();
    vi.setSystemTime(new Date("2026-07-28T12:00:00Z"));
    const { unmount } = render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} onRequestCheckinCode={onRequestCheckinCode} />);
    expect(screen.queryByRole("button", { name: "My check-in code" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check in" })).toBeNull();
    expect(screen.getByText(/^Check-in opens .*, 2 hours before the start\.$/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Details — Campaign meeting" }));
    expect(screen.queryByRole("button", { name: "My check-in code" })).toBeNull();
    unmount();

    // Two hours before the start the window is open.
    vi.setSystemTime(new Date("2026-07-30T16:00:00Z"));
    const second = render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} onRequestCheckinCode={onRequestCheckinCode} />);
    expect(screen.getAllByRole("button", { name: "My check-in code" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Check in" }).length).toBeGreaterThan(0);
    second.unmount();

    // More than 4 hours after the start it has closed.
    vi.setSystemTime(new Date("2026-07-30T22:01:00Z"));
    render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} onRequestCheckinCode={onRequestCheckinCode} />);
    expect(screen.queryByRole("button", { name: "My check-in code" })).toBeNull();
    expect(screen.getByText("Check-in for this meeting has closed.")).toBeVisible();
    expect(onRequestCheckinCode).not.toHaveBeenCalled();
  });

  it("opens and closes check-in on screen as the window boundaries pass, without a remount", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-07-30T15:59:00Z"));
    render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} onRequestCheckinCode={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "My check-in code" })).toBeNull();
    // 16:00Z is two hours before Campaign meeting starts.
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(screen.getAllByRole("button", { name: "My check-in code" }).length).toBeGreaterThan(0);
    // Four hours after the start it closes again.
    await act(async () => { await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000); });
    expect(screen.queryByRole("button", { name: "My check-in code" })).toBeNull();
    expect(screen.getByText("Check-in for this meeting has closed.")).toBeVisible();
  });

  it("leaves check-in available in the demo, whose events sit days ahead", () => {
    vi.setSystemTime(new Date("2026-07-20T12:00:00Z"));
    render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} onRequestCheckinCode={vi.fn()} checkinWindowEnforced={false} />);
    expect(screen.getAllByRole("button", { name: "My check-in code" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Check in" }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Check-in opens/)).toBeNull();
  });
});


describe('event types and ranges', () => {
  it('names a deadline without a clock or attendance controls', () => {
    render(<EventsView data={{ ...data, events: [{ ...data.events[0], eventKind: 'deadline', eventDate: '2026-11-01', startsAt: null, checkInOffered: false }] }} onRsvp={vi.fn()} onCheckIn={vi.fn()} />);
    expect(screen.getAllByText(/Deadline/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^RSVP/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Check in/ })).toBeNull();
    expect(screen.queryByText(/6:00 PM/)).toBeNull();
  });
  it('shows both start and end on the next event and list row', () => {
    render(<EventsView data={{ ...data, events: [{ ...data.events[0], endsAt: '2026-07-30T20:00:00Z' }] }} onRsvp={vi.fn()} onCheckIn={vi.fn()} />);
    const ranges = screen.getAllByText(/ – /);
    expect(ranges.length).toBeGreaterThanOrEqual(2);
  });
});

// RSVP, the live calendar link and check-in keep focus while their
// write runs, and a second activation in the same tick sends nothing more.
describe("event writes while one runs", () => {
  // Only the Date is faked, inside the check-in window, as in "events view".
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: IN_CHECKIN_WINDOW }); });
  afterEach(() => { vi.useRealTimers(); });



  it("keeps Get live calendar link focused while the link is made, and makes one in one tick", async () => {
    const rotate = vi.fn(async () => ({ token: "live-token" }));
    render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} loadCalendarFeedStatus={readInactiveCalendarFeed} onCalendarRotate={rotate} onCalendarRevoke={vi.fn().mockResolvedValue({ revoked: true })} />);
    const mint = await screen.findByRole("button", { name: "Get live calendar link" });
    await expectOneWriteFromOneTick(rotate, [() => fireEvent.click(mint), () => fireEvent.click(mint)]);
    fireEvent.click(await screen.findByRole("button", { name: "Turn off calendar link" }));
    const again = await screen.findByRole("button", { name: "Get live calendar link" });
    await waitFor(() => expect(again).not.toHaveAttribute("aria-disabled"));
    await expectHeldWriteFocus(rotate, again);
    expect(rotate).toHaveBeenCalledTimes(2);
  });

  it("turns the calendar link off once when Turn off is activated twice in one tick", async () => {
    const revoke = vi.fn(async () => ({ revoked: true }));
    render(<EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} loadCalendarFeedStatus={readInactiveCalendarFeed} onCalendarRotate={vi.fn(async () => ({ token: "live-token" }))} onCalendarRevoke={revoke} />);
    fireEvent.click(await screen.findByRole("button", { name: "Get live calendar link" }));
    const off = await screen.findByRole("button", { name: "Turn off calendar link" });
    await waitFor(() => expect(off).not.toHaveAttribute("aria-disabled"));
    await expectOneWriteFromOneTick(revoke, [() => fireEvent.click(off), () => fireEvent.click(off)]);
  });

  const openCheckIn = async () => {
    fireEvent.click(screen.getAllByRole("button", { name: "Check in" })[0]);
    fireEvent.change(await screen.findByLabelText("Event check-in code"), { target: { value: "SG-CHAPTER" } });
    return screen.getByRole("button", { name: "Check in · +55 pts" });
  };


});

