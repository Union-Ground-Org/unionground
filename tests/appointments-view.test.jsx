import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppointmentsView } from "../src/views/AppointmentsView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { downloadEventIcs } from "../src/lib/ics.js";

// jsdom has no createObjectURL, so the download itself is out of scope here —
// this suite pins what the VIEW hands to the ICS builder, not the file write.
vi.mock("../src/lib/ics.js", () => ({ downloadEventIcs: vi.fn() }));

// Fixture rows in get_my_appointments' shape + the loader's labels. One live
// booking (far future so the "upcoming" partition is stable), one settled.
const data = {
  member: { initials: "PR" },
  appointments: [
    { id: "appt-1", place: "Union Hall · Room 204", stewardId: "st-1", stewardName: "Sam Okafor", type: "contract_questions", durationMinutes: 30, startsAt: "2036-08-12T14:00:00Z", endsAt: "2036-08-12T14:30:00Z", status: "confirmed", reasonCategory: "pay", routedVia: "steward", dateLabel: "Wed, Aug 12", timeLabel: "10:00 AM", endTimeLabel: "10:30 AM" },
    { id: "appt-2", stewardId: "st-2", stewardName: "Priya Chandran", type: "onboarding", durationMinutes: 20, startsAt: "2026-07-14T15:00:00Z", endsAt: "2026-07-14T15:20:00Z", status: "completed", reasonCategory: "general", routedVia: "chapter", dateLabel: "Tue, Jul 14", timeLabel: "11:00 AM", endTimeLabel: "11:20 AM" },
  ],
};

// A single deterministic slot: assertions bind to the ISO instant handed back
// to onBook, never to a rendered time label, so the suite is timezone-proof.
const SLOT = "2036-08-20T14:00:00Z";

function fakeApi(overrides = {}) {
  return {
    stewards: vi.fn().mockResolvedValue([{ id: "st-1", name: "Sam Okafor" }, { id: "st-2", name: "Priya Chandran" }]),
    slots: vi.fn().mockResolvedValue({ slots: [{ startsAt: SLOT, stewardCount: 2 }] }),
    ...overrides,
  };
}

describe("appointments view", () => {
  it("formats appointment chrome in Spanish when that locale is active", () => {
    render(
      <LanguageProvider lang="es">
        <AppointmentsView data={data} api={fakeApi()} onBook={vi.fn()} onCancel={vi.fn()} onReschedule={vi.fn()} />
      </LanguageProvider>,
    );
    expect(screen.getByRole("heading", { name: "Reuniones individuales" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pedir una reunión individual" })).toBeInTheDocument();
  });

  it("renders the upcoming booking and the past record", () => {
    render(<AppointmentsView data={data} api={fakeApi()} onBook={vi.fn()} onCancel={vi.fn()} onReschedule={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "One-on-ones" })).toBeInTheDocument();
    expect(screen.getByText("Workplace policy questions")).toBeInTheDocument();
    expect(screen.queryByText("Contract questions")).not.toBeInTheDocument();
    expect(screen.getByText(/with Sam Okafor/)).toBeInTheDocument();
    // The settled row lands in Past with its outcome chip.
    expect(screen.getByText("Onboarding")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  it("books through the wizard: type, duration, steward, slot, reason", async () => {
    const api = fakeApi();
    const onBook = vi.fn().mockResolvedValue({ id: "new" });
    const { container } = render(<AppointmentsView data={data} api={api} onBook={onBook} onCancel={vi.fn()} onReschedule={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Request a one-on-one" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Office hours/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Issue follow-up/ }));
    fireEvent.click(screen.getByRole("button", { name: "45 min" }));
    fireEvent.click(screen.getByRole("button", { name: "Sam Okafor" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    // The slot request carries exactly what was picked.
    await waitFor(() => expect(api.slots).toHaveBeenCalled());
    expect(api.slots.mock.calls[0][0]).toMatchObject({ type: "grievance_followup", duration: 45, stewardId: "st-1" });

    // One day chip, one time chip — pick both, then confirm with a category.
    await waitFor(() => expect(container.querySelector(".mappt-times button")).toBeTruthy());
    fireEvent.click(container.querySelector(".mappt-days button"));
    fireEvent.click(container.querySelector(".mappt-times button"));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.change(screen.getByLabelText(/Reason \(category only\)/), { target: { value: "discipline" } });
    fireEvent.change(screen.getByLabelText(/Location, room, or meeting link/), { target: { value: "  Union Hall · Room 204  " } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm booking" }));

    await waitFor(() => expect(onBook).toHaveBeenCalledWith({
      type: "grievance_followup",
      duration: 45,
      startsAt: SLOT,
      place: "Union Hall · Room 204",
      stewardId: "st-1",
      reason: "discipline",
    }));
  });

  it("cancels only after the inline confirm tap", async () => {
    const onCancel = vi.fn().mockResolvedValue({});
    render(<AppointmentsView data={data} api={fakeApi()} onBook={vi.fn()} onCancel={onCancel} onReschedule={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // First tap arms the confirm; nothing has been cancelled yet.
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancel" }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledWith("appt-1"));
  });

  it("reschedules against the SAME steward's slots", async () => {
    const api = fakeApi();
    const onReschedule = vi.fn().mockResolvedValue({});
    const { container } = render(<AppointmentsView data={data} api={api} onBook={vi.fn()} onCancel={vi.fn()} onReschedule={onReschedule} />);
    fireEvent.click(screen.getByRole("button", { name: "Reschedule" }));
    // The picker must ask for the booked steward, type and length — a
    // steward change on reschedule is refused server-side, so the UI must not
    // offer other stewards' slots.
    await waitFor(() => expect(api.slots).toHaveBeenCalled());
    expect(api.slots.mock.calls[0][0]).toMatchObject({ type: "contract_questions", duration: 30, stewardId: "st-1" });
    await waitFor(() => expect(container.querySelector(".mappt-times button")).toBeTruthy());
    fireEvent.click(container.querySelector(".mappt-times button"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm new time" }));
    await waitFor(() => expect(onReschedule).toHaveBeenCalledWith("appt-1", SLOT));
  });

  it("flags a missing place honestly and carries the recorded place into the ICS download", async () => {
    // appt-1 has a place; this second upcoming row deliberately has none —
    // a real gap the loader can hand back (e.g. a legacy booking made before
    // the place field existed).
    const mixed = {
      member: { initials: "PR" },
      appointments: [
        data.appointments[0],
        {
          id: "appt-3", stewardId: "st-2", stewardName: "Priya Chandran", type: "onboarding",
          durationMinutes: 20, startsAt: "2036-09-01T15:00:00Z", endsAt: "2036-09-01T15:20:00Z",
          status: "confirmed", reasonCategory: "general", routedVia: "chapter",
          dateLabel: "Tue, Sep 1", timeLabel: "11:00 AM", endTimeLabel: "11:20 AM",
        },
      ],
    };
    render(<AppointmentsView data={mixed} api={fakeApi()} onBook={vi.fn()} onCancel={vi.fn()} onReschedule={vi.fn()} />);

    // The row with no place says so instead of rendering a blank line.
    expect(screen.getByText("Place not recorded")).toBeInTheDocument();
    expect(screen.getByText("Union Hall · Room 204")).toBeInTheDocument();

    const downloadButtons = screen.getAllByRole("button", { name: "Add to calendar" });
    expect(downloadButtons).toHaveLength(2);
    fireEvent.click(downloadButtons[0]);
    fireEvent.click(downloadButtons[1]);

    // Each download carries that row's OWN place — never the other row's,
    // and never a placeholder string — as the ICS event location.
    expect(downloadEventIcs).toHaveBeenCalledWith(expect.objectContaining({ id: "appt-1", location: "Union Hall · Room 204" }));
    expect(downloadEventIcs).toHaveBeenCalledWith(expect.objectContaining({ id: "appt-3", location: "" }));
  });

  it("shows the honest empty state when no slots exist", async () => {
    const api = fakeApi({ slots: vi.fn().mockResolvedValue({ slots: [] }) });
    render(<AppointmentsView data={data} api={api} onBook={vi.fn()} onCancel={vi.fn()} onReschedule={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Request a one-on-one" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Office hours/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Office hours/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText(/No open times in the next two weeks/)).toBeInTheDocument());
  });
});
