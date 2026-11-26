import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StewardAppointmentsPanel } from "../src/components/StewardAppointmentsPanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { localeFor } from "../src/lib/i18n.js";
import { MemberApiError } from "../src/lib/memberApi.js";
import { loadCalendarOAuthStatus, startCalendarOAuth } from "../src/lib/calendarOAuthClient.js";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

const stateWrites = vi.hoisted(() => ({ active: false, calls: [] }));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal();
  return {
    ...react,
    useState(initial) {
      const [value, setValue] = react.useState(initial);
      const trackedSetValue = react.useCallback((next) => {
        if (stateWrites.active) stateWrites.calls.push(next);
        return setValue(next);
      }, [setValue]);
      return [value, trackedSetValue];
    },
  };
});

// One future booking (cancel is the only offered action) and one that already
// ended (outcome marking unlocks). An ended row in `upcoming` is the REAL
// contract, not a fixture convenience: get_steward_appointments keeps every
// still-confirmed row there — including ended-but-unmarked ones — precisely so
// the desk's completed/no-show buttons are reachable (sol-review HIGH; the
// first cut filtered ended rows into `recent`, where no action existed).
// Far-flung years keep the now() partition stable for a decade of CI.
const desk = {
  schedule: { timezone: "America/New_York", minNoticeMinutes: 240, bufferBeforeMinutes: 10, bufferAfterMinutes: 10, maxPerDay: 6, accepting: true },
  windows: [{ id: "w1", weekday: 2, startMinute: 540, endMinute: 720 }],
  blackouts: [{ id: "b1", startDate: "2036-08-24", endDate: "2036-08-28" }],
  connections: [],
  upcoming: [
    { id: "sa-1", memberName: "Jordan Mills", type: "grievance_followup", durationMinutes: 30, startsAt: "2036-08-06T13:30:00Z", endsAt: "2036-08-06T14:00:00Z", status: "confirmed", reasonCategory: "discipline", routedVia: "committee member" },
    { id: "sa-2", memberName: "Ava Ramos", type: "office_hours", durationMinutes: 20, startsAt: "2020-01-06T15:00:00Z", endsAt: "2020-01-06T15:20:00Z", status: "confirmed", reasonCategory: "scheduling", routedVia: "campaign" },
  ],
  recent: [
    { id: "sa-3", memberName: "Jordan Bell", type: "office_hours", durationMinutes: 30, startsAt: "2026-07-18T16:00:00Z", status: "no_show" },
  ],
  stats: { noShows30d: 1, completed30d: 4 },
};

function fakeApi(overrides = {}) {
  return {
    loadAppointments: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(desk))),
    markOutcome: vi.fn().mockResolvedValue({}),
    cancelAppointment: vi.fn().mockResolvedValue({}),
    slots: vi.fn().mockResolvedValue({ slots: [{ startsAt: "2036-08-20T14:00:00Z" }] }),
    rescheduleAppointment: vi.fn().mockResolvedValue({}),
    setSchedule: vi.fn().mockResolvedValue({}),
    setWindows: vi.fn().mockResolvedValue({}),
    addBlackout: vi.fn().mockResolvedValue({}),
    removeBlackout: vi.fn().mockResolvedValue({}),
    requestConnection: vi.fn().mockResolvedValue({}),
    removeConnection: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function NoticeHarness({ api }) {
  const [notice, setNotice] = useState("");
  return (
    <>
      <StewardAppointmentsPanel api={api} onNotice={setNotice} />
      {notice && <p data-testid="notice" role="alert">{notice}</p>}
    </>
  );
}

describe("steward appointments panel", () => {
  it("keeps the accepting control in the dedicated switch wrapper", async () => {
    render(<StewardAppointmentsPanel api={fakeApi()} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    const accepting = await screen.findByRole("checkbox", { name: "Workers can book time with me" });
    expect(accepting.closest("label")).toHaveClass("mappt-toggle");
  });

  it("renders the desk with outcome actions only on ended appointments", async () => {
    render(<StewardAppointmentsPanel api={fakeApi()} onNotice={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Jordan Mills")).toBeInTheDocument());
    // The 30-day tally makes no-show tracking a visible number, not a hidden flag.
    expect(screen.getByText(/4 completed · 1 no-shows/)).toBeInTheDocument();
    // Future booking: cancel only. Ended booking: completed/no-show only.
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Completed" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "No-show" })).toBeInTheDocument();
    // The recent record carries its outcome chip.
    expect(screen.getByText("Jordan Bell")).toBeInTheDocument();
  });

  it("marks an ended appointment as a no-show", async () => {
    const api = fakeApi();
    const onNotice = vi.fn();
    render(<StewardAppointmentsPanel api={api} onNotice={onNotice} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "No-show" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "No-show" }));
    await waitFor(() => expect(api.markOutcome).toHaveBeenCalledWith("sa-2", "no_show"));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Marked as no-show"));
  });

  it("proposes a new time with the assigned steward, type, and duration", async () => {
    const api = fakeApi();
    const onNotice = vi.fn();
    render(<StewardAppointmentsPanel api={api} onNotice={onNotice} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Propose new time" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Propose new time" }));
    await waitFor(() => expect(api.slots).toHaveBeenCalledWith(expect.objectContaining({
      type: "grievance_followup", duration: 30,
    })));
    fireEvent.click(await screen.findByRole("button", { name: /Aug/ }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm new time" }));
    await waitFor(() => expect(api.rescheduleAppointment).toHaveBeenCalledWith("sa-1", "2036-08-20T14:00:00Z"));
    expect(onNotice).toHaveBeenCalledWith("New time proposed");
  });

  it("saves availability: settings then the whole weekly window set", async () => {
    const api = fakeApi();
    render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Availability" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Availability" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save availability" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
    await waitFor(() => expect(api.setSchedule).toHaveBeenCalled());
    expect(api.setSchedule.mock.calls[0][0]).toMatchObject({ timezone: "America/New_York", accepting: true });
    // The editor submits the full replace-all window list, minutes-since-midnight.
    expect(api.setWindows).toHaveBeenCalledWith([{ weekday: 2, startMinute: 540, endMinute: 720 }]);
  });

  it("rejects overlapping weekly hours before changing the saved settings", async () => {
    const api = fakeApi();
    render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Tuesday" })).getByRole("button", { name: "Add hours" }));
    fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Hours on the same day must not overlap.");
    expect(api.setSchedule).not.toHaveBeenCalled();
    expect(api.setWindows).not.toHaveBeenCalled();
  });

  it("submits edited hours and their actual weekday after removing a different day's hours", async () => {
    const api = fakeApi();
    render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    const tuesday = within(screen.getByRole("group", { name: "Tuesday" }));
    fireEvent.click(tuesday.getByRole("button", { name: "Remove window" }));
    const thursday = within(screen.getByRole("group", { name: "Thursday" }));
    fireEvent.click(thursday.getByRole("button", { name: "Add hours" }));
    fireEvent.change(thursday.getByLabelText("Start"), { target: { value: "13:00" } });
    fireEvent.change(thursday.getByLabelText("End"), { target: { value: "14:00" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Workers can book time with me" }));
    fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
    await waitFor(() => expect(api.setWindows).toHaveBeenCalledWith([{ weekday: 4, startMinute: 780, endMinute: 840 }]));
    expect(api.setSchedule).toHaveBeenCalledWith(expect.objectContaining({ accepting: false }));
  });

  it("validates a newly overlapping end-time edit before either write", async () => {
    const api = fakeApi();
    render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    const tuesday = within(screen.getByRole("group", { name: "Tuesday" }));
    fireEvent.click(tuesday.getByRole("button", { name: "Add hours" }));
    fireEvent.change(tuesday.getAllByLabelText("Start")[1], { target: { value: "13:00" } });
    fireEvent.change(tuesday.getAllByLabelText("End")[1], { target: { value: "14:00" } });
    fireEvent.change(tuesday.getAllByLabelText("End")[0], { target: { value: "13:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Hours on the same day must not overlap.");
    expect(api.setSchedule).not.toHaveBeenCalled();
    expect(api.setWindows).not.toHaveBeenCalled();
  });

  it("reports a partial save when settings succeed but the hours are refused", async () => {
    const api = fakeApi({ setWindows: vi.fn().mockRejectedValue(new MemberApiError("Availability", { code: "42501", message: "private backend detail" })) });
    const onNotice = vi.fn();
    render(<StewardAppointmentsPanel api={api} onNotice={onNotice} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings saved, but weekly hours could not be confirmed.");
    // Focus moves in a passive effect after the alert commits; await it.
    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText(/private backend detail/)).not.toBeInTheDocument();
    expect(onNotice).not.toHaveBeenCalled();
  });

  // The schedule write committed, so the desk must
  // reload to it before the partial outcome, or a later reopen resends the old
  // schedule over the commit. The sheet stays open with the hour edits.
  it("reloads the desk to the committed schedule after a partial save", async () => {
    const api = fakeApi({ setWindows: vi.fn().mockRejectedValue(new MemberApiError("Availability", { code: "42501", message: "private backend detail" })) });
    render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    await waitFor(() => expect(api.loadAppointments).toHaveBeenCalledTimes(1));
    api.loadAppointments.mockResolvedValueOnce({ ...JSON.parse(JSON.stringify(desk)), schedule: { ...desk.schedule, accepting: false } });
    fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings saved, but weekly hours could not be confirmed.");
    expect(api.loadAppointments).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  // When the refresh after a partial save also fails,
  // the committed schedule still lands on the desk, so closing and reopening
  // the editor cannot resubmit the previous schedule over it.
  it("keeps the committed schedule on the desk when the refresh after a partial save fails", async () => {
    const api = fakeApi({ setWindows: vi.fn().mockRejectedValue(new MemberApiError("Availability", { code: "42501", message: "denied" })) });
    render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    expect(await screen.findByText("Taking bookings")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Availability" }));
    await waitFor(() => expect(api.loadAppointments).toHaveBeenCalledTimes(1));
    api.loadAppointments.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Workers can book time with me" }));
    fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveTextContent("Settings saved, but weekly hours could not be confirmed."));
    expect(api.loadAppointments).toHaveBeenCalledTimes(2);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("Paused")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    expect(await screen.findByRole("checkbox", { name: "Workers can book time with me" })).not.toBeChecked();
  });

  // REQ-UG-STALE-OR-CONTRADICTORY-STATE-AFTER-SAVE-20261030: the
  // empty desk stopped saying "set weekly hours" only after a reload.
  it("stops asking for weekly hours as soon as they are saved, even when the refresh fails", async () => {
    const empty = { ...JSON.parse(JSON.stringify(desk)), windows: [], upcoming: [] };
    const api = fakeApi({ loadAppointments: vi.fn().mockResolvedValueOnce(empty).mockRejectedValue(new Error("offline")) });
    render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    expect(await screen.findByText("Nothing booked. Workers see your open times as soon as you set weekly hours.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set availability" }));
    const thursday = within(screen.getByRole("group", { name: "Thursday" }));
    fireEvent.click(thursday.getByRole("button", { name: "Add hours" }));
    fireEvent.change(thursday.getByLabelText("Start"), { target: { value: "13:00" } });
    fireEvent.change(thursday.getByLabelText("End"), { target: { value: "14:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.loadAppointments).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Nothing booked yet. Workers can book your open weekly hours.")).toBeInTheDocument();
    expect(screen.queryByText(/as soon as you set weekly hours/)).toBeNull();
  });

  it("says the hours are set but bookings are paused when the steward is not accepting", async () => {
    const paused = { ...JSON.parse(JSON.stringify(desk)), upcoming: [], schedule: { ...desk.schedule, accepting: false } };
    render(<StewardAppointmentsPanel api={fakeApi({ loadAppointments: vi.fn().mockResolvedValue(paused) })} onNotice={vi.fn()} />);
    expect(await screen.findByText("Nothing booked. Your weekly hours are set, but you are not taking bookings right now.")).toBeInTheDocument();
  });

  it("does not reload the desk when nothing was saved", async () => {
    const api = fakeApi({ setSchedule: vi.fn().mockRejectedValue(new MemberApiError("Availability", { code: "42501", message: "denied" })) });
    render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    await waitFor(() => expect(api.loadAppointments).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(api.loadAppointments).toHaveBeenCalledTimes(1);
  });

  it("keeps a cleared start empty and refuses it before changing settings", async () => {
    const api = fakeApi();
    render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    const start = screen.getByLabelText("Start");
    fireEvent.change(start, { target: { value: "" } });
    expect(start).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("each at least 20 minutes long");
    expect(api.setSchedule).not.toHaveBeenCalled();
  });

  it("does not attempt weekly hours after the server denies settings authorization", async () => {
    const api = fakeApi({ setSchedule: vi.fn().mockRejectedValue(new MemberApiError("Availability", { code: "42501", message: "private backend detail" })) });
    render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your current session cannot change availability.");
    expect(api.setWindows).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("bounds a hung appointment read and ignores a late result", async () => {
    vi.useFakeTimers();
    let resolve;
    const api = fakeApi({ loadAppointments: vi.fn(() => new Promise((done) => { resolve = done; })) });
    try {
      render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load your one-on-ones.");
      expect(screen.queryByText("Loading your schedule…")).not.toBeInTheDocument();
      await act(async () => { resolve(desk); });
      expect(screen.queryByRole("button", { name: "Availability" })).not.toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it("requests a free-busy connection and reports its honest pending state", async () => {
    const api = fakeApi();
    api.loadAppointments
      .mockResolvedValueOnce(JSON.parse(JSON.stringify(desk)))
      .mockResolvedValue({
        ...desk,
        connections: [{ provider: "google", status: "pending" }],
      });
    render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Availability" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Availability" }));
    const googleRow = (await screen.findByText("Google Calendar")).closest(".mappt-windowrow");
    expect(googleRow).toHaveTextContent("Request still records the ask; busy-time sync stays off");
    const requestButtons = screen.getAllByRole("button", { name: "Request" });
    fireEvent.click(requestButtons[0]);
    await waitFor(() => expect(api.requestConnection).toHaveBeenCalledWith("google"));
    expect(await screen.findByText("Requested")).toBeInTheDocument();
  });

  it("shows the last opaque event reconciliation for an active provider", async () => {
    const connectedDesk = {
      ...desk,
      connections: [{ provider: "google", status: "active" }],
    };
    const api = fakeApi({
      loadAppointments: vi.fn().mockResolvedValue(connectedDesk),
      loadImportStatus: vi.fn().mockResolvedValue([{
        provider: "google",
        status: "active",
        eventCount: 3,
        lastImportedAt: "2026-08-30T14:30:00Z",
      }]),
    });
    render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    await waitFor(() => expect(api.loadImportStatus).toHaveBeenCalledOnce());
    expect(await screen.findByText(/3 events reconciled/i)).toBeInTheDocument();
    expect(screen.getByText(/event titles, attendees, and locations are never imported/i)).toBeInTheDocument();
  });

  it("shows a failed event reconciliation with its retry time instead of stale success", async () => {
    const connectedDesk = {
      ...desk,
      connections: [{ provider: "google", status: "active" }],
    };
    const api = fakeApi({
      loadAppointments: vi.fn().mockResolvedValue(connectedDesk),
      loadImportStatus: vi.fn().mockResolvedValue([{
        provider: "google",
        status: "active",
        importStatus: "error",
        eventCount: 3,
        lastImportedAt: "2026-08-29T14:30:00Z",
        lastImportErrorAt: "2026-08-30T14:30:00Z",
      }]),
    });
    render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    expect(await screen.findByText(/event reconciliation failed/i)).toBeInTheDocument();
    expect(screen.getByText(/availability is current; the next scheduled sync will retry/i)).toBeInTheDocument();
    expect(screen.queryByText(/3 events reconciled/i)).not.toBeInTheDocument();
  });

  it("offers direct re-consent for an active legacy Google grant without removing it first", async () => {
    const connectedDesk = {
      ...desk,
      connections: [{ provider: "google", status: "active" }],
    };
    const assignOAuthUrl = vi.fn();
    const api = fakeApi({
      loadAppointments: vi.fn().mockResolvedValue(connectedDesk),
      loadOAuthStatus: vi.fn().mockResolvedValue({
        ok: true,
        providers: { google: { configured: true }, microsoft: { configured: false } },
      }),
      loadImportStatus: vi.fn().mockResolvedValue([{
        provider: "google",
        status: "active",
        importStatus: "pending",
        scopeUpgradeRequired: true,
      }]),
      startOAuth: vi.fn().mockResolvedValue({
        ok: true,
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=chapter",
      }),
      assignOAuthUrl,
    });

    render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));

    expect(await screen.findByText(/needs updated Google Calendar permission/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

    await waitFor(() => expect(api.startOAuth).toHaveBeenCalledWith("google"));
    expect(api.requestConnection).not.toHaveBeenCalled();
    expect(api.removeConnection).not.toHaveBeenCalled();
    expect(assignOAuthUrl).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?client_id=chapter");
  });

  it("starts OAuth after Request only when a provider app is registered", async () => {
    const assignOAuthUrl = vi.fn();
    const api = fakeApi({
      loadOAuthStatus: vi.fn().mockResolvedValue({
        ok: true,
        providers: { google: { configured: true }, microsoft: { configured: false } },
      }),
      startOAuth: vi.fn().mockResolvedValue({
        ok: true,
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=chapter",
      }),
      assignOAuthUrl,
    });
    render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    await waitFor(() => expect(screen.getByText(/Google Calendar is registered for this campaign/i)).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Request" })[0]);
    await waitFor(() => expect(api.requestConnection).toHaveBeenCalledWith("google"));
    await waitFor(() => expect(api.startOAuth).toHaveBeenCalledWith("google"));
    expect(assignOAuthUrl).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?client_id=chapter");
  });

  it("waits for an in-flight provider status before deciding whether Request starts OAuth", async () => {
    let resolveOAuthStatus;
    const pendingOAuthStatus = new Promise((resolve) => { resolveOAuthStatus = resolve; });
    const assignOAuthUrl = vi.fn();
    const api = fakeApi({
      loadOAuthStatus: vi.fn(() => pendingOAuthStatus),
      startOAuth: vi.fn().mockResolvedValue({
        ok: true,
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=chapter",
      }),
      assignOAuthUrl,
    });
    render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));

    fireEvent.click(screen.getAllByRole("button", { name: "Request" })[0]);
    expect(api.startOAuth).not.toHaveBeenCalled();

    resolveOAuthStatus({
      ok: true,
      providers: { google: { configured: true }, microsoft: { configured: false } },
    });

    await waitFor(() => expect(api.requestConnection).toHaveBeenCalledWith("google"));
    await waitFor(() => expect(api.startOAuth).toHaveBeenCalledWith("google"));
    expect(assignOAuthUrl).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?client_id=chapter");
  });

  it("records a pending ask and releases the editor when provider status never settles", async () => {
    vi.useFakeTimers();
    try {
      const api = fakeApi({
        loadAppointments: vi.fn()
          .mockResolvedValueOnce(JSON.parse(JSON.stringify(desk)))
          .mockResolvedValue({
            ...desk,
            connections: [{ provider: "google", status: "pending" }],
          }),
        loadOAuthStatus: vi.fn(() => new Promise(() => {})),
        startOAuth: vi.fn(),
      });
      render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      fireEvent.click(screen.getByRole("button", { name: "Availability" }));
      await act(() => vi.advanceTimersByTimeAsync(0));

      const googleRow = screen.getByText("Google Calendar").closest(".mappt-windowrow");
      fireEvent.click(within(googleRow).getByRole("button", { name: "Request" }));
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(api.requestConnection).toHaveBeenCalledWith("google");
      expect(api.loadOAuthStatus).toHaveBeenCalledTimes(1);
      expect(within(googleRow).getByRole("button", { name: "Request" })).toHaveAttribute("aria-disabled", "true");

      await act(() => vi.advanceTimersByTimeAsync(5_001));

      const pendingRow = screen.getByText("Requested").closest(".mappt-windowrow");
      expect(within(pendingRow).getByRole("button", { name: "Remove" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Save availability" })).toBeEnabled();
      expect(api.startOAuth).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a configured OAuth start failure without reporting request success", async () => {
    const api = fakeApi({
      loadAppointments: vi.fn()
        .mockResolvedValueOnce(JSON.parse(JSON.stringify(desk)))
        .mockResolvedValue({
          ...desk,
          connections: [{ provider: "google", status: "pending" }],
        }),
      loadOAuthStatus: vi.fn().mockResolvedValue({
        ok: true,
        providers: { google: { configured: true }, microsoft: { configured: false } },
      }),
      startOAuth: vi.fn().mockResolvedValue({ ok: false, error: "unauthorized" }),
    });
    render(<NoticeHarness api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    await waitFor(() => expect(screen.getByText(/Google Calendar is registered for this campaign/i)).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Request" })[0]);

    // The sheet stays open, so the outcome lives inside the Dialog, not in the
    // app toast the backdrop hides and useModalIsolation makes inert.
    const failure = await within(screen.getByRole("dialog")).findByRole("alert");
    expect(failure).toHaveTextContent("Calendar authorization could not start");
    expect(screen.queryByTestId("notice")).not.toBeInTheDocument();
    expect(api.requestConnection).toHaveBeenCalledWith("google");
    expect(api.startOAuth).toHaveBeenCalledWith("google");
    await waitFor(() => expect(api.loadAppointments).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Requested")).toBeInTheDocument();
    expect(screen.queryByText("Calendar sync requested")).not.toBeInTheDocument();
  });

  it.each(["Request", "Reconnect"])("routes an actual %s timeout to the authorization failure and releases the editor", async (action) => {
    vi.useFakeTimers();
    try {
      const auth = { auth: { getSession: async () => ({ data: { session: { access_token: "controlled-token" } } }) } };
      const fetcher = vi.fn(() => new Promise(() => {}));
      const pendingDesk = { ...desk, connections: [{ provider: "google", status: "pending" }] };
      const api = fakeApi({
        loadAppointments: vi.fn().mockResolvedValueOnce(action === "Request" ? desk : pendingDesk).mockResolvedValue(pendingDesk),
        loadOAuthStatus: vi.fn().mockResolvedValue({ ok: true, providers: { google: { configured: true } } }),
        startOAuth: vi.fn((provider) => startCalendarOAuth(auth, provider, fetcher)),
        assignOAuthUrl: vi.fn(),
      });
      render(<NoticeHarness api={api} />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      fireEvent.click(screen.getByRole("button", { name: "Availability" }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      const row = screen.getByText("Google Calendar").closest(".mappt-windowrow");
      fireEvent.click(within(row).getByRole("button", { name: action }));
      await act(() => vi.advanceTimersByTimeAsync(10_000));

      expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("Calendar authorization could not start");
      expect(screen.getByRole("button", { name: "Save availability" })).toBeEnabled();
      expect(api.assignOAuthUrl).not.toHaveBeenCalled();
      expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
      if (action === "Request") {
        expect(api.loadAppointments).toHaveBeenCalledTimes(2);
        expect(screen.getByText("Requested")).toBeInTheDocument();
      }
    } finally { vi.useRealTimers(); }
  });

  it("refreshes a shared status that expires during Request's existing five-second wait", async () => {
    vi.useFakeTimers();
    try {
      const auth = { auth: { getSession: async () => ({ data: { session: { access_token: "controlled-token" } } }) } };
      const configured = { ok: true, providers: { google: { configured: true } } };
      const fetcher = vi.fn().mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValue({ ok: true, json: async () => configured });
      const api = fakeApi({
        loadOAuthStatus: vi.fn(() => loadCalendarOAuthStatus(auth, fetcher)),
        startOAuth: vi.fn().mockResolvedValue({ ok: true, authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=chapter" }),
        assignOAuthUrl: vi.fn(),
      });
      render(<NoticeHarness api={api} />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      fireEvent.click(screen.getByRole("button", { name: "Availability" }));
      await act(() => vi.advanceTimersByTimeAsync(7_000));
      const row = screen.getByText("Google Calendar").closest(".mappt-windowrow");
      fireEvent.click(within(row).getByRole("button", { name: "Request" }));
      await act(() => vi.advanceTimersByTimeAsync(3_000));

      expect(api.loadOAuthStatus).toHaveBeenCalledTimes(2);
      expect(api.startOAuth).toHaveBeenCalledWith("google");
      expect(api.assignOAuthUrl).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "Save availability" })).toBeEnabled();
    } finally { vi.useRealTimers(); }
  });

  it("keeps provider configuration that resolves while Request is committing", async () => {
    vi.useFakeTimers();
    try {
      const auth = { auth: { getSession: async () => ({ data: { session: { access_token: "controlled-token" } } }) } };
      const configured = { ok: true, providers: { google: { configured: true } } };
      let resolveStatus;
      let commitRequest;
      const fetcher = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve; }))
        .mockImplementation(() => new Promise(() => {}));
      const pendingDesk = { ...desk, connections: [{ provider: "google", status: "pending" }] };
      const api = fakeApi({
        loadAppointments: vi.fn().mockResolvedValueOnce(desk).mockResolvedValue(pendingDesk),
        requestConnection: vi.fn(() => new Promise((resolve) => { commitRequest = resolve; })),
        loadOAuthStatus: vi.fn(() => loadCalendarOAuthStatus(auth, fetcher)),
        startOAuth: vi.fn().mockResolvedValue({ ok: false, error: "activation_unset", provider: "google" }),
        assignOAuthUrl: vi.fn(),
      });
      render(<NoticeHarness api={api} />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      fireEvent.click(screen.getByRole("button", { name: "Availability" }));
      await act(() => vi.advanceTimersByTimeAsync(400));
      fireEvent.click(within(screen.getByText("Google Calendar").closest(".mappt-windowrow")).getByRole("button", { name: "Request" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
        resolveStatus({ ok: true, json: async () => configured });
      });
      expect(screen.getByText(/Google Calendar is registered for this campaign/i)).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
        commitRequest({});
      });
      await act(() => vi.advanceTimersByTimeAsync(5_000));
      const row = screen.getByText("Google Calendar").closest(".mappt-windowrow");
      expect(within(row).getByRole("button", { name: "Reconnect" })).toBeEnabled();
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(within(row).getByRole("button", { name: "Reconnect" })).toBeEnabled();
      expect(screen.getByText(/Google Calendar is registered for this campaign/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save availability" })).toBeEnabled();
      expect(api.requestConnection).toHaveBeenCalledOnce();
      expect(api.loadOAuthStatus).toHaveBeenCalledOnce();
      expect(api.startOAuth).toHaveBeenCalledWith("google");
      expect(api.assignOAuthUrl).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("publishes a refreshed status after Request's wait so its pending row can reconnect", async () => {
    vi.useFakeTimers();
    try {
      const auth = { auth: { getSession: async () => ({ data: { session: { access_token: "controlled-token" } } }) } };
      const configured = { ok: true, providers: { google: { configured: true } } };
      let resolveRefresh;
      const fetcher = vi.fn().mockImplementationOnce(() => new Promise(() => {}))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
      const pendingDesk = { ...desk, connections: [{ provider: "google", status: "pending" }] };
      const api = fakeApi({
        loadAppointments: vi.fn().mockResolvedValueOnce(desk).mockResolvedValue(pendingDesk),
        loadOAuthStatus: vi.fn(() => loadCalendarOAuthStatus(auth, fetcher)),
        startOAuth: vi.fn().mockResolvedValue({ ok: true, authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=chapter" }),
        assignOAuthUrl: vi.fn(),
      });
      render(<NoticeHarness api={api} />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      fireEvent.click(screen.getByRole("button", { name: "Availability" }));
      await act(() => vi.advanceTimersByTimeAsync(7_000));
      fireEvent.click(within(screen.getByText("Google Calendar").closest(".mappt-windowrow")).getByRole("button", { name: "Request" }));
      await act(() => vi.advanceTimersByTimeAsync(5_000));
      expect(api.loadOAuthStatus).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Requested")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save availability" })).toBeEnabled();
      expect(api.startOAuth).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
        resolveRefresh({ ok: true, json: async () => configured });
      });
      const pendingRow = screen.getByText("Google Calendar").closest(".mappt-windowrow");
      expect(within(pendingRow).getByRole("button", { name: "Reconnect" })).toBeEnabled();
      expect(screen.getByText(/Google Calendar is registered for this campaign/i)).toBeInTheDocument();
      fireEvent.click(within(pendingRow).getByRole("button", { name: "Reconnect" }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(api.requestConnection).toHaveBeenCalledOnce();
      expect(api.startOAuth).toHaveBeenCalledOnce();
      expect(api.assignOAuthUrl).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it.each(["resolve", "reject"])("ignores an old API's status after replacement when it later %s settles", async (settlement) => {
    let resolveOld;
    let rejectOld;
    const oldStatus = new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
    const pendingDesk = { ...desk, connections: [{ provider: "google", status: "pending" }] };
    const oldApi = fakeApi({
      loadAppointments: vi.fn().mockResolvedValue(pendingDesk),
      loadOAuthStatus: vi.fn(() => oldStatus),
    });
    const nextApi = fakeApi({
      loadAppointments: vi.fn().mockResolvedValue(pendingDesk),
      loadOAuthStatus: vi.fn().mockResolvedValue({ ok: true, providers: { google: { configured: true } } }),
      startOAuth: vi.fn(),
    });
    const { rerender } = render(<NoticeHarness api={oldApi} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    await waitFor(() => expect(oldApi.loadOAuthStatus).toHaveBeenCalledOnce());
    rerender(<NoticeHarness api={nextApi} />);
    await screen.findByText(/Google Calendar is registered for this campaign/i);
    await act(async () => {
      if (settlement === "resolve") resolveOld({ ok: true, providers: { google: { configured: false } } });
      else rejectOld(new Error("old status unavailable"));
    });
    expect(screen.getByText(/Google Calendar is registered for this campaign/i)).toBeInTheDocument();
    const row = screen.getByText("Google Calendar").closest(".mappt-windowrow");
    expect(within(row).getByRole("button", { name: "Reconnect" })).toBeEnabled();
  });

  it("does not start authorization when a pending Request commits after the editor unmounts", async () => {
    let commit;
    const api = fakeApi({
      requestConnection: vi.fn(() => new Promise((resolve) => { commit = resolve; })),
      loadOAuthStatus: vi.fn().mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValue({ ok: true, providers: { google: { configured: true } } }),
      startOAuth: vi.fn().mockResolvedValue({ ok: true, authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=chapter" }),
      assignOAuthUrl: vi.fn(),
    });
    const { unmount } = render(<NoticeHarness api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    await waitFor(() => expect(api.loadOAuthStatus).toHaveBeenCalledOnce());
    fireEvent.click(within(screen.getByText("Google Calendar").closest(".mappt-windowrow")).getByRole("button", { name: "Request" }));
    expect(api.requestConnection).toHaveBeenCalledOnce();
    unmount();
    await act(async () => commit({}));
    expect(api.loadOAuthStatus).toHaveBeenCalledOnce();
    expect(api.startOAuth).not.toHaveBeenCalled();
    expect(api.assignOAuthUrl).not.toHaveBeenCalled();
  });

  it.each(["initial read", "timeout refresh"])("retains the pending ask and recovers after a rejected %s during Request", async (failure) => {
    vi.useFakeTimers();
    try {
      const auth = { auth: { getSession: async () => ({ data: { session: { access_token: "controlled-token" } } }) } };
      const configured = { ok: true, providers: { google: { configured: true } } };
      const fetcher = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => {
        if (failure === "initial read") setTimeout(() => reject(new Error("status unavailable")), 8_000);
      }));
      if (failure === "timeout refresh") fetcher.mockRejectedValueOnce(new Error("refresh unavailable"));
      fetcher.mockResolvedValue({ ok: true, json: async () => configured });
      const pendingDesk = { ...desk, connections: [{ provider: "google", status: "pending" }] };
      const api = fakeApi({
        loadAppointments: vi.fn().mockResolvedValueOnce(desk).mockResolvedValue(pendingDesk),
        loadOAuthStatus: vi.fn(() => loadCalendarOAuthStatus(auth, fetcher)),
        startOAuth: vi.fn().mockResolvedValue({ ok: true, authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=chapter" }),
        assignOAuthUrl: vi.fn(),
      });
      render(<NoticeHarness api={api} />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      fireEvent.click(screen.getByRole("button", { name: "Availability" }));
      await act(() => vi.advanceTimersByTimeAsync(7_000));
      const row = screen.getByText("Google Calendar").closest(".mappt-windowrow");
      fireEvent.click(within(row).getByRole("button", { name: "Request" }));
      await act(() => vi.advanceTimersByTimeAsync(4_000));

      expect(api.requestConnection).toHaveBeenCalledOnce();
      expect(api.loadAppointments).toHaveBeenCalledTimes(2);
      expect(api.loadOAuthStatus).toHaveBeenCalledTimes(failure === "initial read" ? 1 : 2);
      expect(screen.getByText("Requested")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save availability" })).toBeEnabled();
      expect(api.startOAuth).not.toHaveBeenCalled();
      expect(api.assignOAuthUrl).not.toHaveBeenCalled();

      // A rejected lookup cannot poison the next editor visit. The registered
      // pending connection becomes reconnectable without requesting it again.
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await act(() => vi.advanceTimersByTimeAsync(500));
      fireEvent.click(screen.getByRole("button", { name: "Availability" }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      const pendingRow = screen.getByText("Google Calendar").closest(".mappt-windowrow");
      fireEvent.click(within(pendingRow).getByRole("button", { name: "Reconnect" }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(api.requestConnection).toHaveBeenCalledOnce();
      expect(api.startOAuth).toHaveBeenCalledWith("google");
      expect(api.assignOAuthUrl).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("keeps the pending outcome when a configured provider's OAuth start resolves activation_unset", async () => {
    const api = fakeApi({
      loadAppointments: vi.fn()
        .mockResolvedValueOnce(JSON.parse(JSON.stringify(desk)))
        .mockResolvedValue({
          ...desk,
          connections: [{ provider: "google", status: "pending" }],
        }),
      loadOAuthStatus: vi.fn().mockResolvedValue({
        ok: true,
        providers: { google: { configured: true }, microsoft: { configured: false } },
      }),
      startOAuth: vi.fn().mockResolvedValue({ ok: false, error: "activation_unset", provider: "google" }),
      assignOAuthUrl: vi.fn(),
    });
    render(<NoticeHarness api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    await waitFor(() => expect(screen.getByText(/Google Calendar is registered for this campaign/i)).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Request" })[0]);

    const confirmation = await within(screen.getByRole("dialog")).findByRole("status");
    expect(confirmation).toHaveTextContent("Calendar sync requested");
    expect(confirmation).not.toHaveTextContent("Calendar authorization could not start");
    expect(screen.queryByTestId("notice")).not.toBeInTheDocument();
    expect(api.requestConnection).toHaveBeenCalledWith("google");
    expect(api.startOAuth).toHaveBeenCalledWith("google");
    expect(api.assignOAuthUrl).not.toHaveBeenCalled();
    await waitFor(() => expect(api.loadAppointments).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Requested")).toBeInTheDocument();
  });

  it("publishes a status resolved at click time so a pending row offers Reconnect after a rejected mount read", async () => {
    const api = fakeApi({
      loadAppointments: vi.fn()
        .mockResolvedValueOnce(JSON.parse(JSON.stringify(desk)))
        .mockResolvedValue({
          ...desk,
          connections: [{ provider: "google", status: "pending" }],
        }),
      loadOAuthStatus: vi.fn()
        .mockRejectedValueOnce(new Error("status unavailable"))
        .mockResolvedValue({
          ok: true,
          providers: { google: { configured: true }, microsoft: { configured: false } },
        }),
      startOAuth: vi.fn().mockResolvedValue({ ok: false, error: "unauthorized" }),
      assignOAuthUrl: vi.fn(),
    });
    render(<NoticeHarness api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    await waitFor(() => expect(api.loadOAuthStatus).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getAllByRole("button", { name: "Request" })[0]);

    const pendingRow = (await screen.findByText("Requested")).closest(".mappt-windowrow");
    // The click-time read learned the provider is registered; the render must agree.
    expect(within(pendingRow).getByRole("button", { name: "Reconnect" })).toBeEnabled();
    expect(screen.getByText(/Google Calendar is registered for this campaign/i)).toBeInTheDocument();
    expect(api.loadOAuthStatus).toHaveBeenCalledTimes(2);
    expect(api.startOAuth).toHaveBeenCalledTimes(1);
  });

  it("retries OAuth in place from a pending configured-provider row", async () => {
    const assignOAuthUrl = vi.fn();
    const api = fakeApi({
      loadAppointments: vi.fn()
        .mockResolvedValueOnce(JSON.parse(JSON.stringify(desk)))
        .mockResolvedValue({
          ...desk,
          connections: [{ provider: "google", status: "pending" }],
        }),
      loadOAuthStatus: vi.fn().mockResolvedValue({
        ok: true,
        providers: { google: { configured: true }, microsoft: { configured: false } },
      }),
      startOAuth: vi.fn()
        .mockResolvedValueOnce({ ok: false, error: "unauthorized" })
        .mockResolvedValue({
          ok: true,
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=chapter",
        }),
      assignOAuthUrl,
    });
    render(<NoticeHarness api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    await waitFor(() => expect(screen.getByText(/Google Calendar is registered for this campaign/i)).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Request" })[0]);

    const pendingRow = (await screen.findByText("Requested")).closest(".mappt-windowrow");
    fireEvent.click(within(pendingRow).getByRole("button", { name: "Reconnect" }));

    await waitFor(() => expect(api.startOAuth).toHaveBeenCalledTimes(2));
    expect(api.startOAuth).toHaveBeenLastCalledWith("google");
    expect(api.requestConnection).toHaveBeenCalledTimes(1);
    expect(api.requestConnection).toHaveBeenCalledWith("google");
    expect(assignOAuthUrl).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?client_id=chapter");
  });

  describe("the authorization URL must be https on a known calendar provider host", () => {
    const configuredGoogle = {
      ok: true,
      providers: { google: { configured: true }, microsoft: { configured: false } },
    };
    const refusedUrls = [
      "https://evil.example/o/oauth2/v2/auth?client_id=chapter",
      "http://accounts.google.com/o/oauth2/v2/auth?client_id=chapter",
      "https://accounts.google.com.evil.example/o/oauth2/v2/auth",
      "javascript:alert(1)",
      "/o/oauth2/v2/auth",
    ];

    it.each(refusedUrls)("Request refuses %s and reports the start failure", async (authorizationUrl) => {
      const assignOAuthUrl = vi.fn();
      const api = fakeApi({
        loadOAuthStatus: vi.fn().mockResolvedValue(configuredGoogle),
        startOAuth: vi.fn().mockResolvedValue({ ok: true, authorizationUrl }),
        assignOAuthUrl,
      });
      render(<NoticeHarness api={api} />);
      fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
      await waitFor(() => expect(screen.getByText(/Google Calendar is registered for this campaign/i)).toBeInTheDocument());
      fireEvent.click(screen.getAllByRole("button", { name: "Request" })[0]);

      const failure = await within(screen.getByRole("dialog")).findByRole("alert");
      expect(failure).toHaveTextContent("Calendar authorization could not start");
      expect(api.startOAuth).toHaveBeenCalledWith("google");
      expect(assignOAuthUrl).not.toHaveBeenCalled();
    });

    it.each(refusedUrls)("Reconnect refuses %s and reports reconnection unavailable", async (authorizationUrl) => {
      const assignOAuthUrl = vi.fn();
      const api = fakeApi({
        loadAppointments: vi.fn().mockResolvedValue({
          ...desk,
          connections: [{ provider: "google", status: "pending" }],
        }),
        loadOAuthStatus: vi.fn().mockResolvedValue(configuredGoogle),
        startOAuth: vi.fn().mockResolvedValue({ ok: true, authorizationUrl }),
        assignOAuthUrl,
      });
      render(<NoticeHarness api={api} />);
      fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
      const pendingRow = (await screen.findByText("Requested")).closest(".mappt-windowrow");
      fireEvent.click(await within(pendingRow).findByRole("button", { name: "Reconnect" }));

      const failure = await within(screen.getByRole("dialog")).findByRole("alert");
      expect(failure).toHaveTextContent("Calendar reconnection is unavailable");
      expect(api.startOAuth).toHaveBeenCalledWith("google");
      expect(assignOAuthUrl).not.toHaveBeenCalled();
    });

    it("Request still navigates to the Microsoft authorization host", async () => {
      const assignOAuthUrl = vi.fn();
      const url = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=chapter";
      const api = fakeApi({
        loadOAuthStatus: vi.fn().mockResolvedValue({
          ok: true,
          providers: { google: { configured: false }, microsoft: { configured: true } },
        }),
        startOAuth: vi.fn().mockResolvedValue({ ok: true, authorizationUrl: url }),
        assignOAuthUrl,
      });
      render(<NoticeHarness api={api} />);
      fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
      await waitFor(() => expect(screen.getByText(/Microsoft Outlook is registered for this campaign/i)).toBeInTheDocument());
      fireEvent.click(screen.getAllByRole("button", { name: "Request" })[1]);

      await waitFor(() => expect(api.startOAuth).toHaveBeenCalledWith("microsoft"));
      expect(assignOAuthUrl).toHaveBeenCalledWith(url);
    });
  });

  it("reports each provider independently while keeping an unset Request available", async () => {
    const api = fakeApi({
      loadOAuthStatus: vi.fn().mockResolvedValue({
        ok: true,
        providers: { google: { configured: true }, microsoft: { configured: false } },
      }),
      startOAuth: vi.fn().mockResolvedValue({ ok: false, error: "activation_unset", provider: "microsoft" }),
    });
    const onNotice = vi.fn();
    render(<StewardAppointmentsPanel api={api} onNotice={onNotice} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));

    const googleRow = (await screen.findByText("Google Calendar")).closest(".mappt-windowrow");
    const microsoftRow = screen.getByText("Microsoft Outlook").closest(".mappt-windowrow");
    expect(googleRow).toHaveTextContent("Google Calendar is registered for this campaign");
    expect(microsoftRow).toHaveTextContent("Microsoft Outlook is unavailable");
    expect(within(microsoftRow).getByRole("button", { name: "Request" })).toBeEnabled();

    fireEvent.click(within(microsoftRow).getByRole("button", { name: "Request" }));
    await waitFor(() => expect(api.requestConnection).toHaveBeenCalledWith("microsoft"));
    expect(api.startOAuth).not.toHaveBeenCalled();
    const confirmation = await within(screen.getByRole("dialog")).findByRole("status");
    expect(confirmation).toHaveTextContent("Calendar sync requested");
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("re-partitions a row into outcome marking when it ends while the panel is open", async () => {
    // sol: the now() partition used to be frozen at render, so a
    // meeting that ended on screen kept offering Cancel until a reload.
    vi.useFakeTimers();
    try {
      const liveDesk = {
        ...desk,
        upcoming: [{
          id: "sa-7", memberName: "Noor Haddad", type: "office_hours", durationMinutes: 20,
          startsAt: new Date(Date.now() - 1_200_000).toISOString(),
          endsAt: new Date(Date.now() + 30_000).toISOString(),
          status: "confirmed", reasonCategory: "general", routedVia: "committee member",
        }],
        recent: [],
      };
      const api = fakeApi({ loadAppointments: vi.fn().mockResolvedValue(liveDesk) });
      render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Completed" })).not.toBeInTheDocument();
      // One tick later the meeting has ended: cancel gives way to outcomes.
      await act(() => vi.advanceTimersByTimeAsync(61_000));
      expect(screen.getByRole("button", { name: "Completed" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // BUG-UG-STEWARD-APPOINTMENTS-STALE-RELOAD-20260920: run() keys busy
  // state per appointment, so two row outcomes can each call reload() at once.
  // Without a generation/unmount guard the last settle wins, including a
  // superseded read that puts a just-closed booking back on the upcoming desk.
  describe("reload generation guard", () => {
    function deferredDeskApi(overrides = {}) {
      const pending = [];
      const api = fakeApi({
        loadAppointments: vi.fn(() => new Promise((resolve, reject) => {
          pending.push({ resolve, reject });
        })),
        ...overrides,
      });
      return { api, pending };
    }

    const closedDesk = {
      ...desk,
      upcoming: [],
      upcomingTotal: 0,
      recent: [
        { id: "sa-1", memberName: "Jordan Mills", type: "grievance_followup", durationMinutes: 30, startsAt: "2036-08-06T13:30:00Z", status: "cancelled" },
        { id: "sa-2", memberName: "Ava Ramos", type: "office_hours", durationMinutes: 20, startsAt: "2020-01-06T15:00:00Z", status: "completed" },
        desk.recent[0],
      ],
      stats: { noShows30d: 1, completed30d: 5 },
    };

    async function settleInitialDesk(pending) {
      await act(async () => {
        pending[0].resolve(JSON.parse(JSON.stringify(desk)));
      });
      await screen.findByText("Jordan Mills");
    }

    async function startOverlappingOutcomeReloads(api, pending) {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      fireEvent.click(screen.getByRole("button", { name: "Completed" }));
      await waitFor(() => expect(api.loadAppointments).toHaveBeenCalledTimes(3));
      expect(pending).toHaveLength(3);
    }

    it("keeps the newest desk when overlapping outcome reloads settle out of order", async () => {
      const { api, pending } = deferredDeskApi();
      render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
      await settleInitialDesk(pending);
      await startOverlappingOutcomeReloads(api, pending);

      await act(async () => { pending[2].resolve(closedDesk); });
      await act(async () => { pending[1].resolve(JSON.parse(JSON.stringify(desk))); });

      expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Completed" })).not.toBeInTheDocument();
      expect(screen.getByText(/Nothing booked/)).toBeInTheDocument();
    });

    it("does not show a superseded read's failure over a newer successful read", async () => {
      const { api, pending } = deferredDeskApi();
      render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
      await settleInitialDesk(pending);
      await startOverlappingOutcomeReloads(api, pending);

      await act(async () => { pending[2].resolve(closedDesk); });
      await act(async () => { pending[1].reject(new Error("stale desk load failed")); });

      expect(screen.queryByText("stale desk load failed")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
      expect(screen.getByText(/Nothing booked/)).toBeInTheDocument();
    });

    it.each(["resolve", "reject"])("does not attempt state writes after unmount when a read %s settles", async outcome => {
      const { api, pending } = deferredDeskApi();
      const { unmount } = render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
      expect(api.loadAppointments).toHaveBeenCalledTimes(1);
      unmount();
      // Record attempted writes even though React discards them after unmount.
      // Every setter still forwards to the real runtime.
      stateWrites.calls = [];
      stateWrites.active = true;
      try {
        await act(async () => {
          if (outcome === "resolve") pending[0].resolve(JSON.parse(JSON.stringify(desk)));
          else pending[0].reject(new Error("late appointments failure"));
        });
        expect(stateWrites.calls).toEqual([]);
      } finally {
        stateWrites.active = false;
      }
    });

    it("ignores the previous API's pending result after the API changes", async () => {
      const previous = deferredDeskApi();
      const current = deferredDeskApi();
      const { rerender } = render(<StewardAppointmentsPanel api={previous.api} onNotice={vi.fn()} />);
      rerender(<StewardAppointmentsPanel api={current.api} onNotice={vi.fn()} />);
      await act(async () => { current.pending[0].resolve(closedDesk); });
      await act(async () => { previous.pending[0].resolve(JSON.parse(JSON.stringify(desk))); });
      expect(screen.getByText(/Nothing booked/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    });
  });

  // sol  F9: the two lists page server-side. The desk payload carries
  // page one plus cursor and TRUE total; loadAppointmentsPage walks the rest.
  describe("paged lists", () => {
    const pagedDesk = {
      ...desk,
      // The last page-one row in ASCENDING walk order is the future booking
      // sa-1, not the array's tail — the cursor is a keyset position.
      upcomingCursor: { startsAt: "2036-08-06T13:30:00Z", id: "sa-1" },
      upcomingTotal: 5,
      recentTotal: 1,
    };

    it("keeps the same early rows and count when both readers agree", async () => {
      vi.useFakeTimers();
      try {
        const pendingDesk = Promise.withResolvers();
        const api = fakeApi({
          loadAppointments: vi.fn().mockReturnValue(pendingDesk.promise),
          loadAppointmentsPage: vi.fn().mockResolvedValue({ rows: pagedDesk.upcoming, total: 5 }),
        });
        render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
        const loading = screen.getByRole("status");
        expect(loading).toHaveTextContent("Loading your schedule…");
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });

        const bookingNames = () => screen.getAllByText(/^(Jordan Mills|Ava Ramos)$/).map((row) => row.textContent);
        const rows = bookingNames();
        expect(rows).toEqual(["Jordan Mills", "Ava Ramos"]);
        expect(screen.getByText("5")).toBeInTheDocument();
        expect(screen.getByRole("status")).toBe(loading);
        expect(loading).toHaveTextContent("Loading your schedule…");
        expect(screen.queryByRole("button", { name: "Availability" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
        expect(api.loadAppointmentsPage).toHaveBeenCalledExactlyOnceWith({ scope: "upcoming", cursor: null });

        await act(async () => { pendingDesk.resolve(pagedDesk); });
        expect(bookingNames()).toEqual(rows);
        expect(screen.getByText("5")).toBeInTheDocument();
        expect(screen.queryByText("Loading your schedule…")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Availability" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();
        expect(api.loadAppointments).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    function mismatchedReads(early, grouped) {
      const firstDesk = Promise.withResolvers();
      const refresh = Promise.withResolvers();
      const api = fakeApi({
        loadAppointments: vi.fn().mockReturnValueOnce(firstDesk.promise).mockReturnValueOnce(refresh.promise),
        loadAppointmentsPage: vi.fn().mockResolvedValue({ rows: early.upcoming, total: early.upcomingTotal }),
      });
      return { api, refresh, showGrouped: () => act(async () => { firstDesk.resolve(grouped); }) };
    }

    const twoBookings = { ...desk, upcomingTotal: 2 };
    const oneBooking = { ...desk, upcoming: [desk.upcoming[1]], upcomingTotal: 1 };
    const differentBookings = {
      ...twoBookings,
      upcoming: [{ ...desk.upcoming[0], id: "sa-4", memberName: "Marisol Vega" }, desk.upcoming[1]],
    };

    it.each([
      ["confirmed", twoBookings, oneBooking, true],
      ["cancelled", oneBooking, twoBookings, false],
      ["replaced with the total unchanged", differentBookings, twoBookings, false],
    ])("quietly reconciles a booking %s between snapshots", async (_, early, grouped, visibleEarly) => {
      vi.useFakeTimers();
      try {
        const { api, refresh, showGrouped } = mismatchedReads(early, grouped);
        render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        expect(Boolean(screen.queryByText("Jordan Mills"))).toBe(visibleEarly);
        expect(screen.getByText(String(early.upcomingTotal))).toBeInTheDocument();
        expect(api.loadAppointments).toHaveBeenCalledTimes(1);

        await showGrouped();
        expect(Boolean(screen.queryByText("Jordan Mills"))).toBe(!visibleEarly);
        expect(screen.getByText(String(grouped.upcomingTotal))).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Availability" })).toBeInTheDocument();
        expect(screen.queryByText("Loading your schedule…")).not.toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(api.loadAppointments).toHaveBeenCalledTimes(2);

        await act(async () => { refresh.resolve(early); });
        expect(Boolean(screen.queryByText("Jordan Mills"))).toBe(visibleEarly);
        expect(screen.getByText(String(early.upcomingTotal))).toBeInTheDocument();
        expect(api.loadAppointments).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("refreshes when only the total differs and keeps the grouped desk if the refresh fails", async () => {
      vi.useFakeTimers();
      try {
        const { api, refresh, showGrouped } = mismatchedReads({ ...pagedDesk, upcomingTotal: 6 }, pagedDesk);
        render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        expect(screen.getByText("6")).toBeInTheDocument();
        await showGrouped();
        expect(api.loadAppointments).toHaveBeenCalledTimes(2);
        await act(async () => { refresh.reject(new Error("Quiet refresh failed")); });
        expect(screen.getByText("5")).toBeInTheDocument();
        expect(screen.getByText("Jordan Mills")).toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
        expect(api.loadAppointments).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the grouped desk visible when the early page omits rows", async () => {
      vi.useFakeTimers();
      try {
        const pendingDesk = Promise.withResolvers();
        const api = fakeApi({
          loadAppointments: vi.fn().mockResolvedValue(pagedDesk).mockReturnValueOnce(pendingDesk.promise),
          loadAppointmentsPage: vi.fn().mockResolvedValue({ total: pagedDesk.upcomingTotal }),
        });
        render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        expect(api.loadAppointmentsPage).toHaveBeenCalledTimes(1);
        await act(async () => { pendingDesk.resolve(pagedDesk); });
        expect(screen.getByText("Jordan Mills")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Availability" })).toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(["unmount", "API change"])("discards a quiet refresh after %s", async (change) => {
      vi.useFakeTimers();
      try {
        const { api, refresh, showGrouped } = mismatchedReads(twoBookings, oneBooking);
        const { rerender, unmount } = render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        await showGrouped();
        expect(api.loadAppointments).toHaveBeenCalledTimes(2);
        if (change === "unmount") unmount();
        else {
          const replacement = fakeApi({ loadAppointments: vi.fn().mockResolvedValue(oneBooking) });
          await act(async () => { rerender(<StewardAppointmentsPanel api={replacement} onNotice={vi.fn()} />); });
        }
        stateWrites.calls = [];
        stateWrites.active = true;
        await act(async () => { refresh.resolve(twoBookings); });
        expect(stateWrites.calls).toEqual([]);
      } finally {
        stateWrites.active = false;
        vi.useRealTimers();
      }
    });

    it("does not start another early read when the effect restarts before grouped success", async () => {
      vi.useFakeTimers();
      try {
        const priorDesk = Promise.withResolvers();
        const nextDesk = Promise.withResolvers();
        const earlyPage = Promise.withResolvers();
        const api = fakeApi({
          loadAppointments: vi.fn().mockReturnValueOnce(priorDesk.promise).mockReturnValueOnce(nextDesk.promise),
          loadAppointmentsPage: vi.fn().mockReturnValue(earlyPage.promise),
        });
        const view = (lang) => <LanguageProvider lang={lang}><StewardAppointmentsPanel api={api} onNotice={vi.fn()} /></LanguageProvider>;
        const { rerender } = render(view("en"));
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        expect(api.loadAppointmentsPage).toHaveBeenCalledTimes(1);
        rerender(view("es"));
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        expect(api.loadAppointments).toHaveBeenCalledTimes(2);
        expect(api.loadAppointmentsPage).toHaveBeenCalledTimes(1);
        await act(async () => {
          nextDesk.resolve(oneBooking);
          priorDesk.resolve(twoBookings);
          earlyPage.resolve({ rows: twoBookings.upcoming, total: 2 });
        });
        expect(screen.getByText("Ava Ramos")).toBeInTheDocument();
        expect(screen.queryByText("Jordan Mills")).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("adopts a grouped success while the early page is still in flight", async () => {
      vi.useFakeTimers();
      try {
        const pendingDesk = Promise.withResolvers();
        const pendingPage = Promise.withResolvers();
        const api = fakeApi({
          loadAppointments: vi.fn().mockReturnValue(pendingDesk.promise),
          loadAppointmentsPage: vi.fn().mockReturnValue(pendingPage.promise),
        });
        render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        expect(api.loadAppointmentsPage).toHaveBeenCalledTimes(1);
        await act(async () => { pendingDesk.resolve(pagedDesk); });
        expect(screen.getByRole("button", { name: "Availability" })).toBeInTheDocument();
        stateWrites.calls = [];
        stateWrites.active = true;
        await act(async () => { pendingPage.resolve({ rows: [], total: 0 }); });
        expect(stateWrites.calls).toEqual([]);
        expect(screen.getByText("Jordan Mills")).toBeInTheDocument();
        expect(screen.getByText("5")).toBeInTheDocument();
        expect(api.loadAppointments).toHaveBeenCalledTimes(1);
      } finally {
        stateWrites.active = false;
        vi.useRealTimers();
      }
    });

    it("skips the extra first-page read when the desk is quick", async () => {
      vi.useFakeTimers();
      try {
        const api = fakeApi({ loadAppointmentsPage: vi.fn() });
        render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        expect(screen.getByText("Jordan Mills")).toBeInTheDocument();
        expect(api.loadAppointmentsPage).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not restore an early booking when the full read has already failed", async () => {
      vi.useFakeTimers();
      try {
        let rejectDesk;
        let resolvePage;
        const api = fakeApi({
          loadAppointments: vi.fn(() => new Promise((_, reject) => { rejectDesk = reject; })),
          loadAppointmentsPage: vi.fn(() => new Promise((resolve) => { resolvePage = resolve; })),
        });
        render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        await act(async () => { rejectDesk(new Error("Desk read failed")); });
        await act(async () => { resolvePage({ rows: [desk.upcoming[0]], total: 1 }); });

        expect(screen.queryByText("Jordan Mills")).not.toBeInTheDocument();
        expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load your one-on-ones.");
        expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("discloses the slice, walks the keyset, and appends — never replaces", async () => {
      const api = fakeApi({
        loadAppointments: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(pagedDesk))),
        loadAppointmentsPage: vi.fn().mockResolvedValue({
          rows: [{ id: "sa-9", memberName: "Marisol Vega", type: "contract_questions", durationMinutes: 45, startsAt: "2036-08-11T17:00:00Z", endsAt: "2036-08-11T17:45:00Z", status: "confirmed", reasonCategory: "pay", routedVia: "campaign" }],
          nextCursor: null,
          total: 5,
        }),
      });
      render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
      const loadMore = await screen.findByRole("button", { name: "Load more" });
      // The header count and the pager line report the TRUE windowed total,
      // not the loaded slice.
      expect(screen.getByText("5")).toBeInTheDocument();
      expect(screen.getByText(/Showing 2 of 5/)).toBeInTheDocument();
      fireEvent.click(loadMore);
      await waitFor(() => expect(screen.getByText("Marisol Vega")).toBeInTheDocument());
      expect(api.loadAppointmentsPage).toHaveBeenCalledWith({
        scope: "upcoming",
        cursor: { startsAt: "2036-08-06T13:30:00Z", id: "sa-1" },
      });
      // Appended: page one is still on screen alongside the new row.
      expect(screen.getByText("Jordan Mills")).toBeInTheDocument();
      expect(screen.getByText("Ava Ramos")).toBeInTheDocument();
      // The walk is spent (nextCursor null, 3 of 5 loaded — the refresh
      // disclosure takes over from the Load more button).
      await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument());
    });

    it("an api double without the pager method degrades to the seeded page", async () => {
      // The pre-paging fixture: no totals, no cursors, no loadAppointmentsPage.
      render(<StewardAppointmentsPanel api={fakeApi()} onNotice={vi.fn()} />);
      await waitFor(() => expect(screen.getByText("Jordan Mills")).toBeInTheDocument());
      expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
      expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
    });
  });
  // BUG-UG-STEWARD-APPOINTMENTS-RAW-BACKEND-ERROR-AS-PAGE-COPY-20260920:
  // the desk's own loader painted MemberApiError.message — "One-on-ones desk:
  // <PostgREST text>" — as page copy, so `err.message || t(...)` never reached
  // the catalogue line. Same repair useDesk.js took for the shared staff planes.
  describe("backend failure text never becomes page copy", () => {
    const deskError = () => new MemberApiError("One-on-ones desk", {
      message: "permission denied for table member_appointments",
    });

    function renderIn(lang, api, onNotice = vi.fn()) {
      return render(
        <LanguageProvider lang={lang}>
          <StewardAppointmentsPanel api={api} onNotice={onNotice} />
        </LanguageProvider>,
      );
    }

    function assertNoBackendText(text) {
      expect(text).not.toMatch(/permission denied/);
      expect(text).not.toMatch(/One-on-ones desk:/);
      expect(text).not.toMatch(/One-on-ones outcome:/);
      expect(text).not.toMatch(/One-on-ones schedule:/);
      expect(text).not.toMatch(/Appointment slots:/);
    }

    it.each([
      ["en", "Couldn't load your one-on-ones."],
      ["es", "No se pudieron cargar tus reuniones individuales."],
    ])("shows the %s catalogue line when the desk load fails", async (lang, expected) => {
      const api = fakeApi({ loadAppointments: vi.fn().mockRejectedValue(deskError()) });
      const { container } = renderIn(lang, api);
      const alert = await waitFor(() => {
        const found = container.querySelector(".cwk-alert");
        expect(found).not.toBeNull();
        return found;
      });
      expect(within(alert).getByText(expected)).toBeInTheDocument();
      assertNoBackendText(alert.textContent);
    });

    it.each([
      ["en", "That committee action could not be saved."],
      ["es", "No se pudo guardar esa acción del comité."],
    ])("announces the %s catalogue line when a row action fails", async (lang, expected) => {
      const onNotice = vi.fn();
      const api = fakeApi({
        markOutcome: vi.fn().mockRejectedValue(new MemberApiError("One-on-ones outcome", {
          message: "permission denied for table member_appointments",
        })),
      });
      renderIn(lang, api, onNotice);
      const noShow = await screen.findByRole("button", { name: lang === "es" ? "No asistió" : "No-show" });
      fireEvent.click(noShow);
      await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expected));
      assertNoBackendText(onNotice.mock.calls.flat().join(" "));
    });

    it.each([
      ["en", "Couldn't save availability."],
      ["es", "No se pudo guardar la disponibilidad."],
    ])("shows the %s catalogue line inside the sheet when the availability save fails", async (lang, expected) => {
      const onNotice = vi.fn();
      const api = fakeApi({
        setSchedule: vi.fn().mockRejectedValue(new MemberApiError("One-on-ones schedule", {
          message: "permission denied for table steward_availability",
        })),
      });
      renderIn(lang, api, onNotice);
      fireEvent.click(await screen.findByRole("button", { name: lang === "es" ? "Disponibilidad" : "Availability" }));
      const dialog = screen.getByRole("dialog");
      fireEvent.click(await screen.findByRole("button", { name: lang === "es" ? "Guardar disponibilidad" : "Save availability" }));
      const alert = await within(dialog).findByRole("alert");
      expect(alert).toHaveTextContent(expected);
      assertNoBackendText(alert.textContent);
      expect(onNotice).not.toHaveBeenCalled();
    });

    it.each([
      ["en", "Couldn't load open times."],
      ["es", "No se pudieron cargar los horarios."],
    ])("shows the %s catalogue line when the reschedule slot load fails", async (lang, expected) => {
      const api = fakeApi({
        slots: vi.fn().mockRejectedValue(new MemberApiError("Appointment slots", {
          message: "permission denied for function get_appointment_slots",
        })),
      });
      renderIn(lang, api);
      fireEvent.click(await screen.findByRole("button", { name: lang === "es" ? "Proponer otro horario" : "Propose new time" }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(expected);
      assertNoBackendText(alert.textContent);
    });
  });

  // UX-UG-STEWARD-APPOINTMENTS-DESK-LOADING-COPY-UNDER-ERROR-20260920: a
  // failed first load never clears the null desk, so the header note kept
  // saying the schedule was loading directly above the failure card, and the
  // card announced through a polite region mounted already populated — the
  // shape a screen reader skips. Same repair the events desk took in
  // BUG-UG-WEB-EVENTS-DESK-SHOWS-EMPTY-STATE-WHILE-LOADING-20260914.
  describe("a failed first load replaces the loading copy with an announced failure", () => {
    it("stops claiming the schedule is loading and exposes the card as an alert", async () => {
      const api = fakeApi({
        loadAppointments: vi.fn().mockRejectedValue(new MemberApiError("One-on-ones desk", {
          message: "permission denied for table member_appointments",
        })),
      });
      render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Couldn't load your one-on-ones.");
      expect(alert).toHaveClass("cwk-alert");
      expect(screen.queryByText("Loading your schedule…")).not.toBeInTheDocument();
    });

    it("keeps Try again reachable and restores the header note once the desk loads", async () => {
      const api = fakeApi({
        loadAppointments: vi.fn()
          .mockRejectedValueOnce(new MemberApiError("One-on-ones desk", { message: "permission denied" }))
          .mockResolvedValue(JSON.parse(JSON.stringify(desk))),
      });
      render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      await waitFor(() => expect(screen.getByText(/4 completed · 1 no-shows/)).toBeInTheDocument());
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText("Loading your schedule…")).not.toBeInTheDocument();
    });

    it("still shows the loading copy while a first load is genuinely in flight", async () => {
      const api = fakeApi({ loadAppointments: vi.fn().mockImplementation(() => new Promise(() => {})) });
      render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
      expect(await screen.findByText("Loading your schedule…")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  // UX-UG-AVAILABILITY-EDITOR-OUTCOMES-UNDER-MODAL-BACKDROP-20260920: the
  // editor sent every outcome to the app toast, a sibling of the modal tree at
  // z-index 70 that the z-index 90 backdrop dims and useModalIsolation marks
  // inert and aria-hidden. Outcomes that leave the sheet open must render
  // inside the Dialog; only the save that closes it may use the toast.
  describe("availability outcomes that keep the sheet open render inside it", () => {
    async function openEditor(api, onNotice) {
      render(<StewardAppointmentsPanel api={api} onNotice={onNotice} />);
      fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
      return screen.getByRole("dialog");
    }

    it("reports a save failure as an in-dialog alert and never through the toast", async () => {
      const onNotice = vi.fn();
      const api = fakeApi({
        setSchedule: vi.fn().mockRejectedValue(new Error("permission denied for table steward_availability")),
      });
      const dialog = await openEditor(api, onNotice);
      fireEvent.click(screen.getByRole("button", { name: "Save availability" }));

      const alert = await within(dialog).findByRole("alert");
      expect(alert).toHaveTextContent("Couldn't save availability.");
      expect(alert.textContent).not.toMatch(/permission denied/);
      expect(onNotice).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("reports a blackout addition as an in-dialog status with the sheet still open", async () => {
      const onNotice = vi.fn();
      const api = fakeApi();
      const dialog = await openEditor(api, onNotice);
      fireEvent.change(within(dialog).getByLabelText("First blocked day"), { target: { value: "2036-09-01" } });
      fireEvent.change(within(dialog).getByLabelText("Last blocked day"), { target: { value: "2036-09-04" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Block dates" }));

      await waitFor(() => expect(api.addBlackout).toHaveBeenCalledWith("2036-09-01", "2036-09-04"));
      const status = await within(screen.getByRole("dialog")).findByRole("status");
      expect(status).toHaveTextContent("Dates blocked");
      expect(onNotice).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("reports a blackout removal failure as an in-dialog alert in catalogue copy", async () => {
      const onNotice = vi.fn();
      const api = fakeApi({
        removeBlackout: vi.fn().mockRejectedValue(new Error("permission denied for table steward_blackouts")),
      });
      const dialog = await openEditor(api, onNotice);
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove blocked dates Aug 24, 2036 – Aug 28, 2036" }));

      const alert = await within(dialog).findByRole("alert");
      expect(alert).toHaveTextContent("Couldn't save availability.");
      expect(alert.textContent).not.toMatch(/permission denied/);
      expect(onNotice).not.toHaveBeenCalled();
    });

    it("clears a stale outcome when the next action starts", async () => {
      const onNotice = vi.fn();
      const api = fakeApi({
        removeBlackout: vi.fn().mockRejectedValue(new Error("permission denied for table steward_blackouts")),
      });
      const dialog = await openEditor(api, onNotice);
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove blocked dates Aug 24, 2036 – Aug 28, 2036" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't save availability.");

      fireEvent.change(within(dialog).getByLabelText("First blocked day"), { target: { value: "2036-09-01" } });
      fireEvent.change(within(dialog).getByLabelText("Last blocked day"), { target: { value: "2036-09-04" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Block dates" }));

      const status = await within(screen.getByRole("dialog")).findByRole("status");
      expect(status).toHaveTextContent("Dates blocked");
      expect(within(screen.getByRole("dialog")).queryByRole("alert")).not.toBeInTheDocument();
    });

    it("keeps the app toast for the save that closes the sheet", async () => {
      const onNotice = vi.fn();
      const api = fakeApi();
      await openEditor(api, onNotice);
      fireEvent.click(screen.getByRole("button", { name: "Save availability" }));

      await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Availability saved"));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });
  });
});

// A11Y-UG-AVAILABILITY-EDITOR-WEEKDAY-AND-BLACKOUT-NAMES-20260920. Seven
// weekday blocks used to share four accessible names — "Add hours", "Start",
// "End", "Remove window" — with the day itself a decorative span, and blackout
// rows painted the Postgres wire date in both languages behind a bare "Remove".
describe("availability editor weekday groups and blackout names", () => {
  function openEditor(lang) {
    render(
      <LanguageProvider lang={lang}>
        <StewardAppointmentsPanel api={fakeApi()} onNotice={vi.fn()} />
      </LanguageProvider>,
    );
    return screen.findByRole("button", { name: lang === "es" ? "Disponibilidad" : "Availability" });
  }

  it("puts each weekday's controls in a group named by that weekday", async () => {
    fireEvent.click(await openEditor("en"));

    // The fixture's single window is on weekday 2, so Tuesday owns the time
    // controls and Monday owns none: the group boundary is what tells a
    // screen reader which day a repeated name belongs to.
    const tuesday = await screen.findByRole("group", { name: "Tuesday" });
    expect(within(tuesday).getByRole("button", { name: "Add hours" })).toBeInTheDocument();
    expect(within(tuesday).getByLabelText("Start")).toHaveValue("09:00");
    expect(within(tuesday).getByLabelText("End")).toHaveValue("12:00");
    expect(within(tuesday).getByRole("button", { name: "Remove window" })).toBeInTheDocument();

    const monday = screen.getByRole("group", { name: "Monday" });
    expect(within(monday).getByRole("button", { name: "Add hours" })).toBeInTheDocument();
    expect(within(monday).queryByLabelText("Start")).toBeNull();
    expect(monday).toHaveTextContent("Not bookable");

    for (const day of ["Sunday", "Wednesday", "Thursday", "Friday", "Saturday"]) {
      expect(screen.getByRole("group", { name: day })).toBeInTheDocument();
    }
  });

  it("names the weekday groups in Spanish", async () => {
    fireEvent.click(await openEditor("es"));

    const martes = await screen.findByRole("group", { name: "martes" });
    expect(within(martes).getByRole("button", { name: "Añadir horas" })).toBeInTheDocument();
    expect(within(martes).getByLabelText("Inicio")).toHaveValue("09:00");
    expect(screen.getByRole("group", { name: "lunes" })).toHaveTextContent("No reservable");
  });

  it("renders a blackout range through the date formatter and names its Remove button", async () => {
    const api = fakeApi();
    render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));

    const range = "Aug 24, 2036 – Aug 28, 2036";
    expect(await screen.findByText(range)).toBeInTheDocument();
    expect(screen.queryByText(/2036-08-24/)).toBeNull();

    const remove = screen.getByRole("button", { name: `Remove blocked dates ${range}` });
    fireEvent.click(remove);
    await waitFor(() => expect(api.removeBlackout).toHaveBeenCalledWith("b1"));
  });

  it("renders the blackout range in Spanish", async () => {
    fireEvent.click(await openEditor("es"));
    await screen.findByRole("group", { name: "martes" });

    const day = (value) => new Intl.DateTimeFormat(localeFor("es"), {
      year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
    }).format(new Date(value));
    const range = `${day("2036-08-24T00:00:00Z")} – ${day("2036-08-28T00:00:00Z")}`;

    expect(range).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(screen.getByText(range)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Quitar los días bloqueados ${range}` })).toBeInTheDocument();
  });

  // A Postgres `date` has no instant in it. Formatted in the viewer's zone,
  // UTC midnight slides a day back for every viewer west of Greenwich, so the
  // label is pinned to UTC on both ends. process.env.TZ does not reach a
  // --pool=threads worker, so each viewer zone is stubbed as the formatter's
  // default instead.
  it.each(["UTC", "America/Los_Angeles", "Pacific/Kiritimati"])(
    "keeps the blackout range on its own calendar days in %s",
    async (timeZone) => {
      const RealDateTimeFormat = Intl.DateTimeFormat;
      const stub = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function ZonedDateTimeFormat(locale, options = {}) {
        return new RealDateTimeFormat(locale, { timeZone, ...options });
      });
      try {
        render(<StewardAppointmentsPanel api={fakeApi()} onNotice={vi.fn()} />);
        fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
        expect(await screen.findByText("Aug 24, 2036 – Aug 28, 2036")).toBeInTheDocument();
      } finally {
        stub.mockRestore();
      }
    },
  );
});

describe("appointment outcomes keep focus while they are saved (record 8435)", () => {
  it("keeps Completed focused while the outcome is saved, and saves it once", async () => {
    const api = fakeApi({ markOutcome: vi.fn(async () => ({})) });
    render(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    await expectHeldWriteFocus(api.markOutcome, await screen.findByRole("button", { name: "Completed" }));
    expect(api.markOutcome).toHaveBeenCalledTimes(1);
  });
});
