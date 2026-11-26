import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EventsView } from "../src/views/EventsView.jsx";
import {
  applyDeviceParitySnapshot,
  applyDeviceParityState,
  deviceParitySnapshot,
  subscribeDeviceParityChanges,
  useDeviceParityState,
} from "../src/lib/deviceParity.js";

function Harness({ name }) {
  const [open, setOpen] = useDeviceParityState("test.sharedOpen", false);
  return <button type="button" onClick={() => setOpen((value) => !value)}>{name}:{open ? "open" : "closed"}</button>;
}

const eventData = {
  events: [{
    id: "evt-parity",
    title: "Parity calendar meeting",
    startsAt: "2026-08-12T18:00:00Z",
    dateLabel: "Wed, Aug 12",
    timeLabel: "2:00 PM",
    location: "Chapter hall",
    summary: "Shared event details.",
    rsvpStatus: null,
    checkedIn: false,
  }],
  rewardsCatalog: { rules: [] },
};

describe("device state parity", () => {
  it("updates every local consumer, emits local changes once, and applies remote state without echo", () => {
    const changes = vi.fn();
    const stop = subscribeDeviceParityChanges(changes);
    render(<><Harness name="desktop" /><Harness name="phone" /></>);

    fireEvent.click(screen.getByRole("button", { name: "desktop:closed" }));
    expect(screen.getByRole("button", { name: "desktop:open" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "phone:open" })).toBeInTheDocument();
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenLastCalledWith({ key: "test.sharedOpen", value: true });

    act(() => applyDeviceParityState("test.sharedOpen", false));
    expect(screen.getByRole("button", { name: "desktop:closed" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "phone:closed" })).toBeInTheDocument();
    expect(changes).toHaveBeenCalledTimes(1);
    stop();
  });

  it("hydrates late-mounted state from the bridge snapshot", () => {
    act(() => applyDeviceParitySnapshot([{ key: "test.sharedOpen", value: true }]));
    expect(deviceParitySnapshot()).toContainEqual({ key: "test.sharedOpen", value: true });
    render(<Harness name="late phone" />);
    expect(screen.getByRole("button", { name: "late phone:open" })).toBeInTheDocument();
  });

  it("opens and closes the same calendar event from mirrored state", () => {
    const changes = vi.fn();
    const stop = subscribeDeviceParityChanges(changes);
    render(<EventsView data={eventData} onRsvp={vi.fn()} onCheckIn={vi.fn()} />);

    // The next-event hero shows the same summary as its own paragraph, so
    // count only the row's details panel.
    const rowSummaries = () => screen.queryAllByText("Shared event details.").filter((node) => !node.closest(".mevents-hero"));
    act(() => applyDeviceParityState("events.evt-parity.details", true));
    expect(rowSummaries()).toHaveLength(1);
    const details = screen.getByRole("button", { name: "Details — Parity calendar meeting" });
    expect(details).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(details);
    expect(rowSummaries()).toHaveLength(0);
    expect(changes).toHaveBeenLastCalledWith({ key: "events.evt-parity.details", value: false });
    stop();
  });
});
