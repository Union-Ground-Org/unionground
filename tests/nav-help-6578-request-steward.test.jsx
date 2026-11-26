// REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030, finding 64: Messages'
// "Request a committee contact" opens a real steward request (the appointment request),
// not the mid-meeting alert button on Organizing rights.
import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { AppointmentsView } from "../src/views/AppointmentsView.jsx";
import { MessagesView } from "../src/views/MessagesView.jsx";

vi.mock("../src/lib/ics.js", () => ({ downloadEventIcs: vi.fn() }));

const emptyInbox = { conversations: [], broadcasts: [], product: { spaces: [] } };
const noAppointments = { member: { initials: "PR" }, appointments: [] };

function api() {
  return {
    stewards: vi.fn().mockResolvedValue([{ id: "st-1", name: "Sam Okafor" }]),
    slots: vi.fn().mockResolvedValue({ slots: [] }),
  };
}

function renderMessages(props) {
  return render(
    <LanguageProvider lang="en">
      <MessagesView data={emptyInbox} onSendMessage={vi.fn()} onStartConversation={vi.fn()} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} onOpenCases={vi.fn()} {...props} />
    </LanguageProvider>,
  );
}

describe("Request a committee contact from Messages", () => {
  it("calls the steward-request handler, and is absent without one", () => {
    const onRequestSteward = vi.fn();
    const view = renderMessages({ onRequestSteward });
    fireEvent.click(screen.getByRole("button", { name: "Request a committee contact" }));
    expect(onRequestSteward).toHaveBeenCalledOnce();
    view.unmount();
    // The old Organizing rights door is gone: a rights handler alone no longer
    // draws the button.
    renderMessages({ onOpenRights: vi.fn() });
    expect(screen.queryByRole("button", { name: "Request a committee contact" })).not.toBeInTheDocument();
  });

  it("routes the shell to the appointment request, never to /m/rights", () => {
    const app = readFileSync("src/App.jsx", "utf8");
    const messagesLine = app.split("\n").find((line) => line.includes("messages: <><MessagesView"));
    expect(messagesLine).toContain('onRequestSteward={() => navigate("appointments", "/m/appointments", { view: "appointments", request: true })}');
    expect(messagesLine).not.toContain("onOpenRights");
    expect(app).toContain('focus={searchFocus?.view === "appointments" ? searchFocus : null}');
  });
});

describe("One-on-ones opened for a steward request", () => {
  it("opens the request dialog straight away when it arrives with request: true", async () => {
    render(<LanguageProvider lang="en"><AppointmentsView data={noAppointments} api={api()} onBook={vi.fn()} onCancel={vi.fn()} onReschedule={vi.fn()} focus={{ view: "appointments", request: true }} /></LanguageProvider>);
    expect(await screen.findByRole("dialog", { name: /Request a one-on-one with a committee member/ })).toBeInTheDocument();
  });

  it("stays closed on an ordinary visit and after the member closes it", async () => {
    const focus = { view: "appointments", request: true };
    const { rerender } = render(<LanguageProvider lang="en"><AppointmentsView data={noAppointments} api={api()} onBook={vi.fn()} onCancel={vi.fn()} onReschedule={vi.fn()} focus={focus} /></LanguageProvider>);
    const dialog = await screen.findByRole("dialog", { name: /Request a one-on-one with a committee member/ });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Request a one-on-one with a committee member/ })).not.toBeInTheDocument());
    // A re-render with the same arrival does not reopen it.
    rerender(<LanguageProvider lang="en"><AppointmentsView data={{ ...noAppointments }} api={api()} onBook={vi.fn()} onCancel={vi.fn()} onReschedule={vi.fn()} focus={focus} /></LanguageProvider>);
    expect(screen.queryByRole("dialog", { name: /Request a one-on-one with a committee member/ })).not.toBeInTheDocument();
  });

  it("does not open for a visit without the request flag", () => {
    render(<LanguageProvider lang="en"><AppointmentsView data={noAppointments} api={api()} onBook={vi.fn()} onCancel={vi.fn()} onReschedule={vi.fn()} focus={{ view: "appointments" }} /></LanguageProvider>);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
