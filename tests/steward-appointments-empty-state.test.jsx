import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StewardAppointmentsPanel } from "../src/components/StewardAppointmentsPanel.jsx";
import { StewardSharedAccessPanel } from "../src/features/chapterAccess/StewardSharedAccessPanel.jsx";
import { createChapterAccessApi } from "../src/lib/chapterAccessApi.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

// REQ-UG-APPOINTMENTS-EMPTY-STATE-20261102: with no weekly hours the
// appointments desk showed a small Availability button at one edge and "No
// hours set yet" at the other, under an empty "Drafts shared with you" section
// that led every steward page. Setting hours is now the obvious first task, and
// the shared section appears only when something is shared.

afterEach(cleanup);

const desk = {
  schedule: null,
  windows: [],
  blackouts: [], connections: [],
  upcoming: [], recent: [],
  stats: { noShows30d: 0, completed30d: 0 },
};
const booking = { id: "sa-1", memberName: "Jordan Mills", type: "office_hours", durationMinutes: 30, startsAt: "2036-08-06T13:30:00Z", endsAt: "2036-08-06T14:00:00Z", status: "confirmed", reasonCategory: "pay", routedVia: "committee member" };

function api(first = desk, overrides = {}) {
  const withHours = { ...first, schedule: { timezone: "America/New_York", minNoticeMinutes: 240, bufferBeforeMinutes: 10, bufferAfterMinutes: 10, maxPerDay: 6, accepting: true }, windows: [{ id: "w1", weekday: 4, startMinute: 780, endMinute: 840 }] };
  return {
    loadAppointments: vi.fn().mockResolvedValueOnce(JSON.parse(JSON.stringify(first))).mockResolvedValue(withHours),
    markOutcome: vi.fn(), cancelAppointment: vi.fn(), slots: vi.fn(), rescheduleAppointment: vi.fn(),
    setSchedule: vi.fn().mockResolvedValue({}), setWindows: vi.fn().mockResolvedValue({}),
    addBlackout: vi.fn(), removeBlackout: vi.fn(), requestConnection: vi.fn(), removeConnection: vi.fn(),
    ...overrides,
  };
}

const show = (stub, lang = "en") => render(<LanguageProvider lang={lang}><StewardAppointmentsPanel api={stub} onNotice={vi.fn()} /></LanguageProvider>);

describe("appointments with no weekly hours", () => {
  it("puts the status, what hours do and Set availability together as the first task", async () => {
    show(api());
    const setup = await screen.findByRole("group", { name: "No hours set yet" });
    expect(setup).toHaveAccessibleDescription("Nothing booked. Workers see your open times as soon as you set weekly hours.");
    expect(within(setup).getByRole("button", { name: "Set availability" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Availability" })).toBeNull();
    expect(screen.getAllByText("Nothing booked. Workers see your open times as soon as you set weekly hours.")).toHaveLength(1);
  });

  it("opens the editor, saves hours and returns to the updated status", async () => {
    const stub = api();
    show(stub);
    fireEvent.click(await screen.findByRole("button", { name: "Set availability" }));
    const thursday = within(screen.getByRole("group", { name: "Thursday" }));
    fireEvent.click(thursday.getByRole("button", { name: "Add hours" }));
    fireEvent.change(thursday.getByLabelText("Start"), { target: { value: "13:00" } });
    fireEvent.change(thursday.getByLabelText("End"), { target: { value: "14:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(stub.setWindows).toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "No hours set yet" })).toBeNull();
    // The first save replaced the opener; focus lands on its successor, not the body.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Availability" })));
    expect(screen.getByText("Taking bookings")).toBeInTheDocument();
    expect(screen.getByText("Nothing booked yet. Workers can book your open weekly hours.")).toBeInTheDocument();
  });

  it("does not say nothing is booked while bookings remain", async () => {
    show(api({ ...desk, upcoming: [booking] }));
    const setup = await screen.findByRole("group", { name: "No hours set yet" });
    expect(setup).toHaveAccessibleDescription("Workers can book you only during the weekly hours you publish here.");
    expect(screen.getByText("Jordan Mills")).toBeInTheDocument();
  });

  it("names the action in Spanish", async () => {
    show(api(), "es");
    expect(await screen.findByRole("button", { name: "Fijar disponibilidad" })).toBeInTheDocument();
  });
});

describe("drafts shared with the steward", () => {
  const wrap = (stub) => render(<LanguageProvider lang="en"><StewardSharedAccessPanel api={stub} /></LanguageProvider>);

  it("stays out of the way while loading and when nothing is shared", async () => {
    let finish;
    const stub = { sharedDrafts: vi.fn(() => new Promise((resolve) => { finish = resolve; })), privateGrievances: vi.fn(async () => []) };
    const view = wrap(stub);
    expect(view.container).toBeEmptyDOMElement();
    await act(async () => finish([]));
    expect(view.container).toBeEmptyDOMElement();
    expect(screen.queryByText("Drafts shared with you")).toBeNull();
  });

  it("still shows what is shared and a failed read", async () => {
    const draft = { id: "f", answers: { answer: "Shared answer" }, template: { key: "custom", version: 1, label_en: "Shared form", label_es: "Formulario compartido", field_schema: { steps: [{ fields: [{ key: "answer", type: "text", label: { en: "Question", es: "Pregunta" } }] }] } } };
    wrap({ sharedDrafts: vi.fn(async () => [draft]), privateGrievances: vi.fn(async () => []) });
    expect(await screen.findByRole("region", { name: "Drafts shared with you" })).toHaveTextContent("Shared form");
    cleanup();
    wrap({ sharedDrafts: vi.fn(async () => { throw new Error("offline"); }), privateGrievances: vi.fn(async () => []) });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  // BUG-UG-STEWARD-SHARED-ACCESS-PANEL-TIMEOUT-AT-SCALE-20261106 (#7209):
  // a private-grievance read that fails (statement timeout) is an error with a
  // retry, never an empty "nothing shared" panel.
  it("shows a timed-out private-grievance read as an error, not as nothing shared", async () => {
    const rpc = vi.fn(async (name) => name === "list_private_grievance_summaries"
      ? { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }
      : { data: [], error: null });
    const view = wrap(createChapterAccessApi({ rpc }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Access could not be loaded");
    expect(view.container).not.toBeEmptyDOMElement();
    expect(rpc).toHaveBeenCalledWith("list_private_grievance_summaries", undefined);
  });
});
