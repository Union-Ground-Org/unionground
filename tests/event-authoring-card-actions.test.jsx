import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventAuthoringCard } from "../src/components/EventAuthoringCard.jsx";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { t } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { declaredFor, mountStylesheets } from "./helpers/appStylesheet.js";
import { openPastEvents } from "./helpers/openPastEvents.js";

const active = {
  id: "member-meeting", title: "Member meeting", startsAt: "2026-08-14T16:00:00Z",
  startsLabel: "Aug 14, noon", location: "Union hall", summary: "Updates",
  checkInCode: "SG-MEET", isPublic: false, isPublicAcrossAgencies: false,
  chapterName: "Harborview Care United", rsvpCount: 2, checkinCount: 1,
};
const cancelled = {
  ...active, id: "cancelled-meeting", title: "Cancelled meeting", cancelledAt: "2026-08-12T12:00:00Z",
  cancelledReason: "Weather", isPublic: true,
};

function setup(overrides = {}) {
  const api = {
    createEvent: vi.fn().mockResolvedValue({ created: true }),
    updateEvent: vi.fn().mockResolvedValue({ updated: true }),
    cancelEvent: vi.fn().mockResolvedValue({ changed: true }),
    restoreEvent: vi.fn().mockResolvedValue({ changed: true }),
    deleteEvent: vi.fn().mockResolvedValue({ deleted: true }),
    ...overrides,
  };
  const onNotice = vi.fn();
  const reload = vi.fn();
  render(
    <LanguageProvider lang="en">
      <EventAuthoringCard events={[active, cancelled]} api={api} onNotice={onNotice} reload={reload} chapterName="Harborview Care United" />
    </LanguageProvider>,
  );
  openPastEvents();
  return { api, onNotice, reload };
}

afterEach(() => clearDeviceParityState());

describe("event check-in lockout notice", () => {
  // Staff see "N check-in lockouts in the last 24 h"
  // on the event; an event without lockouts shows nothing.
  it("shows the 24-hour lockout count only on events that have one", () => {
    render(
      <LanguageProvider lang="en">
        <EventAuthoringCard
          events={[{ ...active, checkinLockouts24h: 3 }, { ...cancelled, checkinLockouts24h: 0 }]}
          api={{}} onNotice={vi.fn()} reload={vi.fn()} chapterName="Harborview Care United"
        />
      </LanguageProvider>,
    );
    openPastEvents();
    expect(screen.getByRole("status")).toHaveTextContent("3 check-in lockouts in the last 24 h");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(t("es", "admin.checkinLockouts", { count: 3 })).toBe("3 bloqueos de registro en las últimas 24 h");
  });
});

describe("event authoring lifecycle", () => {
  it.each(["success", "refusal"])("ignores a retired editor's late %s without clearing the new draft", async outcome => {
    let finish;
    const pending = new Promise((resolve, reject) => { finish = outcome === "success" ? resolve : reject; });
    const onNotice = vi.fn();
    const reload = vi.fn();
    const api = { createEvent: vi.fn(() => pending) };
    const editor = key => <LanguageProvider lang="en">
      <EventAuthoringCard key={key} events={[]} api={api} onNotice={onNotice} reload={reload} />
    </LanguageProvider>;
    const { rerender } = render(editor("a"));
    fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
    fireEvent.change(screen.getByLabelText("Web name"), { target: { value: "original-event" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Original event" } });
    fireEvent.change(screen.getByLabelText("Starts"), { target: { value: "2026-10-20T12:30" } });
    fireEvent.change(screen.getByLabelText("Location"), { target: { value: "Hall" } });
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Original event agenda" } });
    fireEvent.change(screen.getByLabelText("Check-in code (SG-…)"), { target: { value: "SG-ORIGINAL" } });
    fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form"));
    expect(api.createEvent).toHaveBeenCalledTimes(1);
    rerender(editor("b"));
    if (!screen.queryByLabelText("Title")) fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "New chapter draft" } });
    await act(async () => { finish(outcome === "success" ? { created: true } : new Error("refused")); });
    expect(screen.getByLabelText("Title")).toHaveValue("New chapter draft");
    expect(onNotice).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("creates, edits, cancels, restores, and deletes through the narrow API", async () => {
    const { api, reload } = setup();

    const activeRow = document.querySelector('[data-automation-source-id="member-meeting"]');
    const eventMenu = activeRow.querySelector("details");
    expect(eventMenu).toHaveClass("xus-action-menu");
    expect(eventMenu.querySelector(":scope > .xus-btnrow")).toBeInTheDocument();
    expect(eventMenu).not.toHaveAttribute("open");
    fireEvent.click(eventMenu.querySelector("summary"));
    expect(eventMenu).toHaveAttribute("open");
    expect(within(activeRow).getByRole("button", { name: "Delete meeting" })).toHaveClass("xus-btn--danger");

    fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
    fireEvent.change(screen.getByLabelText("Web name"), { target: { value: "new-event" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "New event" } });
    fireEvent.change(screen.getByLabelText("Starts"), { target: { value: "2026-08-20T12:30" } });
    fireEvent.change(screen.getByLabelText("Location"), { target: { value: "Hall" } });
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Agenda" } });
    fireEvent.change(screen.getByLabelText("Check-in code (SG-…)"), { target: { value: "SG-NEW" } });
    fireEvent.click(screen.getByLabelText("Share with every campaign in this agency"));
    fireEvent.click(screen.getByLabelText("Share across all agencies in this organization"));
    fireEvent.click(screen.getByRole("button", { name: "Yes, share across all agencies" }));
    fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form"));
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      id: "new-event", isPublic: true, isPublicAcrossAgencies: true,
      startsAt: new Date("2026-08-20T12:30").toISOString(),
    })));

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(eventMenu).not.toHaveAttribute("open");
    fireEvent.change(screen.getByLabelText("Location"), { target: { value: " New hall " } });
    fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form"));
    await waitFor(() => expect(api.updateEvent).toHaveBeenCalledWith("member-meeting", expect.objectContaining({
      location: "New hall", startsAt: null, isPublic: null, isPublicAcrossAgencies: null,
    })));

    fireEvent.click(eventMenu.querySelector("summary"));
    expect(eventMenu).toHaveAttribute("open");
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel meeting" })[0]);
    expect(eventMenu).not.toHaveAttribute("open");
    fireEvent.change(screen.getByLabelText("Why is it cancelled? (optional)"), { target: { value: "Storm" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel this meeting" }));
    await waitFor(() => expect(api.cancelEvent).toHaveBeenCalledWith("member-meeting", "Storm"));

    const cancelledMenu = document.querySelector('[data-automation-source-id="cancelled-meeting"] details');
    fireEvent.click(cancelledMenu.querySelector("summary"));
    fireEvent.click(screen.getByRole("button", { name: "Restore meeting" }));
    expect(cancelledMenu).not.toHaveAttribute("open");
    await waitFor(() => expect(api.restoreEvent).toHaveBeenCalledWith("cancelled-meeting"));

    fireEvent.click(eventMenu.querySelector("summary"));
    fireEvent.click(within(activeRow).getByRole("button", { name: "Delete meeting" }));
    expect(eventMenu).not.toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "Delete permanently" })).toHaveClass("xus-btn--danger");
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(api.deleteEvent).toHaveBeenCalledWith("member-meeting"));
    expect(reload).toHaveBeenCalledTimes(5);
  });

  it("reports translated failures and supports no-change lifecycle results", async () => {
    const onNotice = vi.fn();
    const api = {
      createEvent: vi.fn(), updateEvent: vi.fn(),
      cancelEvent: vi.fn().mockResolvedValue({ changed: false }),
      restoreEvent: vi.fn().mockResolvedValue({ changed: false }),
      deleteEvent: vi.fn().mockRejectedValue({ details: "event_has_attendance" }),
    };
    render(
      <LanguageProvider lang="en">
        <EventAuthoringCard events={[active, cancelled]} api={api} onNotice={onNotice} reload={vi.fn()} />
      </LanguageProvider>,
    );
    openPastEvents();
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel meeting" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel this meeting" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Nothing changed."));
    fireEvent.click(screen.getByRole("button", { name: "Restore meeting" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getAllByRole("button", { name: "Delete meeting" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    const attendanceGuidance = t("en", "rpcError.event_has_attendance");
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(attendanceGuidance));
    expect(attendanceGuidance).not.toBe("rpcError.event_has_attendance");
    expect(onNotice).not.toHaveBeenCalledWith("rpcError.event_has_attendance");
    expect(onNotice).not.toHaveBeenCalledWith("event_has_attendance");
  });

  it("suppresses the empty copy while loading and restores it after", () => {
    const { rerender } = render(
      <LanguageProvider lang="en">
        <EventAuthoringCard events={[]} api={{}} onNotice={vi.fn()} reload={vi.fn()} emptyKey="eventsDesk.empty" loading />
      </LanguageProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading meetings");
    expect(screen.queryByText("No campaign meetings yet.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New meeting" })).toBeInTheDocument();
    rerender(
      <LanguageProvider lang="en">
        <EventAuthoringCard events={[]} api={{}} onNotice={vi.fn()} reload={vi.fn()} emptyKey="eventsDesk.empty" loading={false} />
      </LanguageProvider>,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("No campaign meetings yet.")).toBeInTheDocument();
  });
});

// BUG-UG-WEB-EVENTS-MANAGE-BUTTON-FAR-FROM-TITLE-20261002 (the
// owner's September example 1): the event text block grew to fill the row
// (.xus-emain flex 1 1 220px) and the row spread its children apart, so
// "Manage meeting" sat at the far edge of the card on /m/events-desk and
// /m/admin/events. The text block now takes only the width its lines need,
// capped, and the action follows it.
describe("event row action placement", () => {
  it("puts Manage event right after the event's text block in the same row group", () => {
    const unmountStyles = mountStylesheets();
    try {
      setup();
      for (const summary of screen.getAllByText("Manage meeting")) {
        const menu = summary.closest("details");
        const row = menu.parentElement;
        expect(row).toHaveClass("xus-etop", "xus-etop--event");
        const main = menu.previousElementSibling;
        expect(main).toHaveClass("xus-emain");
        expect(main.querySelector(".xus-etitle")).not.toBeNull();
        expect(row.children).toHaveLength(2);
        // The row no longer spreads its children to the two edges...
        expect(getComputedStyle(row).justifyContent).not.toBe("space-between");
        // ...and the text block does not grow to push the action away.
        expect(getComputedStyle(main).flexGrow).toBe("0");
        // jsdom 31 resolves the declared 30rem against the default 16px root.
        expect(getComputedStyle(main).maxWidth).toBe("480px");
      }
      expect(declaredFor(".xus-etop")).not.toMatch(/space-between/);
    } finally {
      unmountStyles();
    }
  });
});
