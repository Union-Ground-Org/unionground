// #9595 unit 4 (D2-20): with no steward named for the reader, One-on-ones
// invited "Request one and pick a time" and opened a booking dialog that only
// said at its foot "No stewards are taking appointments right now", with Next
// disabled. The page now says it itself, offers no Request and does not open
// the dialog from Messages' arrival; named, paused and unknown keep Main.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { AppointmentsView } from "../src/views/AppointmentsView.jsx";

const NO_STEWARD = ["none", "no-chapter", "only-self"];
const KEEPS_MAIN = ["named", "paused", "unknown"];
const api = () => ({ stewards: vi.fn().mockResolvedValue([]), slots: vi.fn().mockResolvedValue({ slots: [] }) });

function renderAppointments(presence, { lang = "en", focus = null } = {}) {
  clearDeviceParityState();
  return render(
    <LanguageProvider lang={lang}>
      <AppointmentsView data={{ member: { initials: "IC" }, appointments: [] }} api={api()} stewardPresence={presence} focus={focus} onBook={vi.fn()} onCancel={vi.fn()} onReschedule={vi.fn()} />
    </LanguageProvider>,
  );
}

describe("One-on-ones with no steward named (#9595 D2-20)", () => {
  it.each(NO_STEWARD)("says so on the page and offers no Request (%s)", (presence) => {
    renderAppointments(presence);
    expect(screen.queryByRole("button", { name: "Request a one-on-one" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Request one and pick a time/)).not.toBeInTheDocument();
    expect(screen.getByText("No one-on-ones booked.")).toBeInTheDocument();
    expect(screen.getByText(/can name (a|another) committee member\./)).toBeInTheDocument();
    expect(screen.getByText("One-on-ones can be booked once a committee member is named and sets weekly hours.")).toBeInTheDocument();
  });

  it.each(NO_STEWARD)("does not open the dead-end dialog when Messages sends the member here (%s)", (presence) => {
    renderAppointments(presence, { focus: { view: "appointments", request: true } });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(/right now/)).not.toBeInTheDocument();
  });

  it("says it in Spanish", () => {
    renderAppointments("none", { lang: "es" });
    expect(screen.getByText("Todavía no hay un miembro del comité nombrado para tu campaña.")).toBeInTheDocument();
    expect(screen.getByText("Podrás reservar reuniones individuales cuando se nombre un miembro del comité y fije su horario semanal.")).toBeInTheDocument();
    expect(screen.getByText("No tienes reuniones individuales reservadas.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pedir una reunión individual" })).not.toBeInTheDocument();
  });

  it.each(KEEPS_MAIN)("keeps Request, Main's empty line and the arrival dialog when %s", (presence) => {
    const view = renderAppointments(presence);
    expect(screen.getByRole("button", { name: "Request a one-on-one" })).toBeInTheDocument();
    expect(screen.getByText(/Request one and pick a time/)).toBeInTheDocument();
    expect(screen.queryByText(/sets weekly hours/)).not.toBeInTheDocument();
    view.unmount();
    renderAppointments(presence, { focus: { view: "appointments", request: true } });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  // Sol read of a1d70a8e, P2: the dialog never opens or comes back by itself
  // when the answer changes.
  it("keeps the dialog closed when the answer goes from none to named until a fresh request", () => {
    clearDeviceParityState();
    const arrival = { view: "appointments", request: true };
    const page = (presence, focus) => (
      <LanguageProvider lang="en">
        <AppointmentsView data={{ member: { initials: "IC" }, appointments: [] }} api={api()} stewardPresence={presence} focus={focus} onBook={vi.fn()} onCancel={vi.fn()} onReschedule={vi.fn()} />
      </LanguageProvider>
    );
    const view = render(page("none", arrival));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.rerender(page("named", arrival));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.rerender(page("named", { view: "appointments", request: true }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes an open dialog when the answer becomes none, and does not reopen it when a steward is named", () => {
    clearDeviceParityState();
    const page = (presence) => (
      <LanguageProvider lang="en">
        <AppointmentsView data={{ member: { initials: "IC" }, appointments: [] }} api={api()} stewardPresence={presence} onBook={vi.fn()} onCancel={vi.fn()} onReschedule={vi.fn()} />
      </LanguageProvider>
    );
    const view = render(page("unknown"));
    fireEvent.click(screen.getByRole("button", { name: "Request a one-on-one" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    view.rerender(page("none"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.rerender(page("named"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("gives the no-steward section no name borrowed from the removed button", () => {
    renderAppointments("none");
    expect(screen.queryByRole("region", { name: "Request a one-on-one" })).not.toBeInTheDocument();
    expect(document.querySelector('section[aria-label="Request a one-on-one"]')).toBeNull();
  });
});
