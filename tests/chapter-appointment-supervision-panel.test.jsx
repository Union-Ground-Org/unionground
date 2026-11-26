import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChapterAppointmentsPanel } from "../src/components/ChapterAppointmentsPanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MemberApiError } from "../src/lib/memberApi.js";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

const future = {
  id: "appointment-future",
  memberName: "Darnell Foster",
  appointmentType: "office_hours",
  durationMinutes: 30,
  startsAt: "2026-08-20T14:00:00Z",
  endsAt: "2026-08-20T14:30:00Z",
  status: "confirmed",
  stewardId: "steward-1",
  stewardName: "Maria Santos",
  reasonCategory: "Private grievance details",
  place: "https://private.example/meeting",
  email: "private@example.org",
  phone: "555-0100",
};

const settled = {
  ...future,
  id: "appointment-settled",
  memberName: "Jordan Lee",
  appointmentType: "onboarding",
  startsAt: "2026-08-10T14:00:00Z",
  endsAt: "2026-08-10T14:30:00Z",
  status: "completed",
};

function renderPanel(api, { lang = "en", onNotice = vi.fn() } = {}) {
  return {
    onNotice,
    ...render(
      <LanguageProvider lang={lang}>
        <ChapterAppointmentsPanel api={api} onNotice={onNotice} />
      </LanguageProvider>,
    ),
  };
}

describe("chapter appointment supervision panel", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-12T12:00:00Z"));
  });

  afterEach(() => vi.useRealTimers());

  it("renders only localized report-safe fields, the timezone, and true count", async () => {
    const api = {
      loadChapterAppointments: vi.fn().mockResolvedValue({ rows: [future, settled], nextCursor: null, total: 3 }),
      loadChapterAppointmentCandidates: vi.fn(),
      reassignChapterAppointment: vi.fn(),
    };
    renderPanel(api);

    expect(await screen.findByRole("heading", { name: "Campaign one-on-ones" })).toBeInTheDocument();
    expect(await screen.findByText("Darnell Foster")).toBeInTheDocument();
    expect(screen.getByText("Office hours")).toBeInTheDocument();
    expect(screen.getAllByText("30 min")).toHaveLength(2);
    expect(screen.getByText("Thu, Aug 20, 2026, 10:00 AM ET – Thu, Aug 20, 2026, 10:30 AM ET")).toBeInTheDocument();
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
    expect(screen.getAllByText("Maria Santos").length).toBeGreaterThan(0);
    expect(screen.getByText("Eastern — New York (ET)")).toBeInTheDocument();
    expect(screen.getByText("Showing 2 of 3")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Reassign" })).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/Private grievance|private\.example|private@example|555-0100/);
  });

  it("appends keyset pages and retires Load more at the end", async () => {
    const third = { ...future, id: "appointment-third", memberName: "Nia Owens" };
    const api = {
      loadChapterAppointments: vi.fn()
        .mockResolvedValueOnce({ rows: [future, settled], nextCursor: { startsAt: settled.startsAt, id: settled.id }, total: 3 })
        .mockResolvedValueOnce({ rows: [third], nextCursor: null, total: 3 }),
      loadChapterAppointmentCandidates: vi.fn(),
      reassignChapterAppointment: vi.fn(),
    };
    renderPanel(api);

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Nia Owens")).toBeInTheDocument();
    expect(screen.getByText("Darnell Foster")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(api.loadChapterAppointments).toHaveBeenLastCalledWith({
      cursor: { startsAt: settled.startsAt, id: settled.id },
    });
  });

  it("does not offer an empty fetch when an exact full page already equals the total", async () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      ...future,
      id: `appointment-${index}`,
      memberName: `Member ${index}`,
    }));
    const api = {
      loadChapterAppointments: vi.fn().mockResolvedValue({
        rows,
        nextCursor: { startsAt: rows[49].startsAt, id: rows[49].id },
        total: 50,
      }),
      loadChapterAppointmentCandidates: vi.fn(),
      reassignChapterAppointment: vi.fn(),
    };
    renderPanel(api);

    expect(await screen.findByText("Showing 50 of 50")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("moves focus into reassignment and restores it to the row trigger on cancel", async () => {
    const api = {
      loadChapterAppointments: vi.fn().mockResolvedValue({ rows: [future], nextCursor: null, total: 1 }),
      loadChapterAppointmentCandidates: vi.fn().mockResolvedValue([{ id: "steward-2", name: "Nia Owens" }]),
      reassignChapterAppointment: vi.fn(),
    };
    renderPanel(api);

    const trigger = await screen.findByRole("button", { name: "Reassign" });
    trigger.focus();
    fireEvent.click(trigger);
    const form = await screen.findByRole("form", { name: "Reassign one-on-one for Darnell Foster" });
    expect(form).toHaveFocus();

    fireEvent.click(within(form).getByRole("button", { name: "Cancel reassignment" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Reassign" })).toHaveFocus());
  });


  it("requires a candidate and explicit confirmation, deduplicates submit, and reloads on success", async () => {
    let finishWrite;
    const write = new Promise((resolve) => { finishWrite = resolve; });
    const api = {
      loadChapterAppointments: vi.fn().mockResolvedValue({ rows: [future], nextCursor: null, total: 1 }),
      loadChapterAppointmentCandidates: vi.fn().mockResolvedValue([{ id: "steward-2", name: "Nia Owens" }]),
      reassignChapterAppointment: vi.fn().mockReturnValue(write),
    };
    const { onNotice } = renderPanel(api);

    fireEvent.click(await screen.findByRole("button", { name: "Reassign" }));
    expect(await screen.findByRole("option", { name: "Nia Owens" })).toBeInTheDocument();
    const form = screen.getByRole("form", { name: "Reassign one-on-one for Darnell Foster" });
    const save = within(form).getByRole("button", { name: "Save reassignment" });
    expect(save).toBeDisabled();

    fireEvent.change(within(form).getByRole("combobox", { name: "New committee member" }), { target: { value: "steward-2" } });
    expect(save).toBeDisabled();
    fireEvent.click(within(form).getByRole("checkbox", { name: /I confirm/ }));
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(api.reassignChapterAppointment).toHaveBeenCalledTimes(1);
    expect(api.reassignChapterAppointment).toHaveBeenCalledWith("appointment-future", "steward-2");

    finishWrite({});
    await waitFor(() => expect(api.loadChapterAppointments).toHaveBeenCalledTimes(2));
    expect(onNotice).toHaveBeenCalledWith("One-on-one reassigned");
    await waitFor(() => expect(screen.getByRole("button", { name: "Reassign" })).toHaveFocus());
  });

  it("keeps the form operable after candidate and write failures", async () => {
    const api = {
      loadChapterAppointments: vi.fn().mockResolvedValue({ rows: [future], nextCursor: null, total: 1 }),
      loadChapterAppointmentCandidates: vi.fn()
        .mockRejectedValueOnce(new Error("candidate outage"))
        .mockResolvedValueOnce([{ id: "steward-2", name: "Nia Owens" }]),
      reassignChapterAppointment: vi.fn().mockRejectedValue(new Error("write refused")),
    };
    renderPanel(api);

    fireEvent.click(await screen.findByRole("button", { name: "Reassign" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Eligible committee members could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Try candidates again" }));
    const select = await screen.findByRole("combobox", { name: "New committee member" });
    fireEvent.change(select, { target: { value: "steward-2" } });
    const confirm = screen.getByRole("checkbox", { name: /I confirm/ });
    fireEvent.click(confirm);
    fireEvent.submit(screen.getByRole("form", { name: "Reassign one-on-one for Darnell Foster" }));

    expect(await screen.findByText("The one-on-one could not be reassigned.")).toBeInTheDocument();
    expect(select).toHaveValue("steward-2");
    expect(confirm).toBeChecked();
    expect(screen.getByRole("button", { name: "Cancel reassignment" })).toBeEnabled();
  });

  it("offers an honest retry after an initial load failure", async () => {
    const api = {
      loadChapterAppointments: vi.fn()
        .mockRejectedValueOnce(new Error("report outage"))
        .mockResolvedValueOnce({ rows: [], nextCursor: null, total: 0 }),
      loadChapterAppointmentCandidates: vi.fn(),
      reassignChapterAppointment: vi.fn(),
    };
    renderPanel(api, { lang: "es" });

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudieron cargar las reuniones individuales de la campaña.");
    fireEvent.click(screen.getByRole("button", { name: "Intentar de nuevo" }));
    expect(await screen.findByText("No hay reuniones individuales en la campaña.")).toBeInTheDocument();
  });
});

// BUG-UG-CASEWORK-PANELS-RAW-DRIVER-ERROR-TEXT-20260920. A refused read or
// write used to render the raw PostgREST/driver sentence. Both a MemberApiError
// refusal and a bare Error must now show only the catalogue copy, in English
// and Spanish.
describe("appointment failure notices never render raw driver text", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-12T12:00:00Z"));
  });

  afterEach(() => vi.useRealTimers());

  const DRIVER_REFUSAL = () => new MemberApiError("Reassign appointment", {
    message: 'new row violates row-level security policy for table "member_appointments"',
    code: "42501",
    details: null,
  });
  const BARE_REFUSAL = () => new Error('duplicate key value violates unique constraint "member_appointments_pkey"');
  const FORBIDDEN = /policy|relation|violates|constraint/i;

  it.each([["en", "Campaign one-on-ones could not be loaded."], ["es", "No se pudieron cargar las reuniones individuales de la campaña."]])(
    "shows only catalogue copy when the list read refuses (%s)",
    async (lang, expected) => {
      for (const makeRefusal of [DRIVER_REFUSAL, BARE_REFUSAL]) {
        const api = {
          loadChapterAppointments: vi.fn().mockRejectedValue(makeRefusal()),
          loadChapterAppointmentCandidates: vi.fn(),
          reassignChapterAppointment: vi.fn(),
        };
        const { unmount } = renderPanel(api, { lang });
        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent(expected);
        expect(alert.textContent).not.toMatch(FORBIDDEN);
        unmount();
      }
    },
  );

  it("re-translates a stored failure notice when the profile language changes in place", async () => {
    const api = {
      loadChapterAppointments: vi.fn().mockResolvedValue({ rows: [future], nextCursor: null, total: 1 }),
      loadChapterAppointmentCandidates: vi.fn().mockResolvedValue([{ id: "steward-2", name: "Nia Owens" }]),
      reassignChapterAppointment: vi.fn().mockRejectedValue(new Error("write refused")),
    };
    const view = render(
      <LanguageProvider lang="en">
        <ChapterAppointmentsPanel api={api} />
      </LanguageProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Reassign" }));
    const form = await screen.findByRole("form", { name: "Reassign one-on-one for Darnell Foster" });
    fireEvent.change(await within(form).findByRole("combobox"), { target: { value: "steward-2" } });
    fireEvent.click(within(form).getByRole("checkbox"));
    fireEvent.submit(form);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The one-on-one could not be reassigned.");

    // In-place language switch: the panel re-renders in Spanish and the
    // stored refusal must follow, not keep the language it failed under.
    view.rerender(
      <LanguageProvider lang="es">
        <ChapterAppointmentsPanel api={api} />
      </LanguageProvider>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("No se pudo reasignar la reunión individual.");
  });

  it.each([["en", "The one-on-one could not be reassigned."], ["es", "No se pudo reasignar la reunión individual."]])(
    "shows only catalogue copy when the reassignment write refuses (%s)",
    async (lang, expected) => {
      for (const makeRefusal of [DRIVER_REFUSAL, BARE_REFUSAL]) {
        const api = {
          loadChapterAppointments: vi.fn().mockResolvedValue({ rows: [future], nextCursor: null, total: 1 }),
          // The form mounts before candidate loading settles. Keep that
          // ordering observable even on an otherwise idle test runner.
          loadChapterAppointmentCandidates: vi.fn(() => new Promise((resolve) => {
            setTimeout(() => resolve([{ id: "steward-2", name: "Nia Owens" }]), 25);
          })),
          reassignChapterAppointment: vi.fn().mockRejectedValue(makeRefusal()),
        };
        const { unmount } = renderPanel(api, { lang });
        fireEvent.click(await screen.findByRole("button", { name: lang === "en" ? "Reassign" : "Reasignar" }));
        const form = await screen.findByRole("form", { name: lang === "en" ? "Reassign one-on-one for Darnell Foster" : "Reasignar reunión individual para Darnell Foster" });
        fireEvent.change(await within(form).findByRole("combobox"), { target: { value: "steward-2" } });
        fireEvent.click(within(form).getByRole("checkbox"));
        fireEvent.submit(form);
        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent(expected);
        expect(alert.textContent).not.toMatch(FORBIDDEN);
        unmount();
      }
    },
  );
});
