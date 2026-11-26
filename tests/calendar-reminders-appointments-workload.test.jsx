// REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030 (#6577).
//
// The October 29-30, 2026 role-play run (findings 43, 45, 46, 51, 52, 54 and
// 65): no private dates or own reminders, booking hours without a title,
// place, audience or start date, a free-text IANA time zone box, no notes on
// a booking, a workload log with no worked day or hours and locked behind the
// survey, and ?tab=reminders opening Submit.
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { personalDateEvents } from "../api/calendar.js";
import { StewardAppointmentsPanel } from "../src/components/StewardAppointmentsPanel.jsx";
import { PersonalReminders } from "../src/features/personalReminders/PersonalReminders.jsx";
import { BOOKING_TIME_ZONES, loadAppointmentNotes, loadScheduleDetails, saveAppointmentNote, saveScheduleDetails } from "../src/lib/appointmentDetailsApi.js";
import { buildIcsCalendar } from "../src/lib/ics.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";
import { t } from "../src/lib/i18n.js";
import { AppointmentsView } from "../src/views/AppointmentsView.jsx";
import { WorkloadView, futureWorkedOn, workedDetails } from "../src/views/WorkloadView.jsx";
// The shared rpc mock carries reads too (a reload that
// lands inside the tick); only writes count toward the one-write rule.
const isRpcWrite = (name) => !/^(get|list|load|search)_/.test(String(name));

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.replaceState({}, "", "/"); });

const wrap = (ui, lang = "en") => render(<LanguageProvider lang={lang}>{ui}</LanguageProvider>);

function rpcClient(handlers) {
  return {
    rpc: vi.fn(async (name, args) => {
      const handler = handlers[name];
      if (!handler) return { data: null, error: { code: "PGRST202", message: `no ${name}` } };
      try { return { data: await handler(args), error: null }; }
      catch (error) { return { data: null, error: { code: error.code || "P0001", message: error.message } }; }
    }),
  };
}

const reminder = (id, title, remindAt, repeat = "none", note = "") => ({ id, title, note, remindAt, repeat });

describe("personal reminders and private dates", () => {
  it("lists, adds a repeating reminder, cancels one and pages", async () => {
    const pages = [
      { items: [reminder("r1", "Friday mandate tally", "2099-11-06T14:00:00Z", "weekly")], nextCursor: { remindAt: "2099-11-06T14:00:00Z", id: "r1" } },
      { items: [reminder("r2", "Grading load check", "2099-12-07T14:00:00Z", "none", "CS 210 final")], nextCursor: null },
    ];
    const client = rpcClient({
      list_personal_reminders: (args) => (args.p_after_id ? pages[1] : pages[0]),
      save_personal_reminder: () => ({ id: "r3" }),
      cancel_personal_reminder: () => ({ id: "r1", status: "cancelled" }),
    });
    wrap(<PersonalReminders client={client} />);
    expect(await screen.findByText("Friday mandate tally")).toBeInTheDocument();
    expect(screen.getByText(/Every week/, { selector: ".prm__when" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show more reminders" }));
    expect(await screen.findByText("Grading load check")).toBeInTheDocument();
    expect(client.rpc).toHaveBeenCalledWith("list_personal_reminders", { p_after_remind_at: "2099-11-06T14:00:00Z", p_after_id: "r1", p_limit: 20 });

    fireEvent.change(screen.getByLabelText("What to remember"), { target: { value: "  Shift log  " } });
    fireEvent.change(screen.getByLabelText("When"), { target: { value: "2099-11-04T09:00" } });
    fireEvent.change(screen.getByLabelText("Repeat"), { target: { value: "monthly" } });
    fireEvent.click(screen.getByRole("button", { name: "Add reminder" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_personal_reminder", {
      p_id: null, p_title: "Shift log", p_note: "", p_remind_at: new Date("2099-11-04T09:00").toISOString(), p_repeat: "monthly",
      p_time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }));
    expect(await screen.findByText("Reminder saved.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel the reminder Friday mandate tally" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("cancel_personal_reminder", { p_id: "r1" }));
  });

  it("r2s3: a cancel that finds the row already fired reloads the list and names why", async () => {
    let fired = false;
    const client = rpcClient({
      list_personal_reminders: () => ({ items: [fired
        ? reminder("r9", "Friday mandate tally", "2099-11-13T14:00:00Z", "weekly")
        : reminder("r1", "Friday mandate tally", "2099-11-06T14:00:00Z", "weekly")], nextCursor: null }),
      cancel_personal_reminder: () => { fired = true; throw Object.assign(new Error("reminder not found"), { code: "P0002" }); },
    });
    wrap(<PersonalReminders client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel the reminder Friday mandate tally" }));
    expect(await screen.findByText(/already went off or was cancelled/)).toBeInTheDocument();
    await waitFor(() => expect(client.rpc.mock.calls.filter(([name]) => name === "list_personal_reminders")).toHaveLength(2));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel the reminder Friday mandate tally" }));
    await waitFor(() => expect(client.rpc).toHaveBeenLastCalledWith("list_personal_reminders", expect.anything()));
    expect(client.rpc).toHaveBeenCalledWith("cancel_personal_reminder", { p_id: "r9" });
  });

  it("r2s3: reloads a minute after the soonest reminder comes due", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const soon = new Date(Date.now() + 5000).toISOString();
      const client = rpcClient({ list_personal_reminders: () => ({ items: [reminder("r1", "Shift log", soon)], nextCursor: null }) });
      wrap(<PersonalReminders client={client} />);
      expect(await screen.findByText("Shift log")).toBeInTheDocument();
      const reads = () => client.rpc.mock.calls.filter(([name]) => name === "list_personal_reminders").length;
      expect(reads()).toBe(1);
      await vi.advanceTimersByTimeAsync(64000);
      await waitFor(() => expect(reads()).toBe(2));
    } finally { vi.useRealTimers(); }
  });

  it("refuses a past time before sending, and names the limit", async () => {
    const client = rpcClient({
      list_personal_reminders: () => ({ items: [], nextCursor: null }),
      save_personal_reminder: () => { throw Object.assign(new Error("limit"), { code: "54000" }); },
    });
    wrap(<PersonalReminders client={client} />);
    expect(await screen.findByText("No reminders yet.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("What to remember"), { target: { value: "Old" } });
    fireEvent.change(screen.getByLabelText("When"), { target: { value: "2001-01-01T09:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add reminder" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a time that has not passed yet.");
    expect(client.rpc).not.toHaveBeenCalledWith("save_personal_reminder", expect.anything());
    fireEvent.change(screen.getByLabelText("When"), { target: { value: "2099-01-01T09:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add reminder" }));
    expect(await screen.findByText(t("en", "personalReminders.limit"))).toBeInTheDocument();
  });

  it("puts the owner's private dates in their calendar feed", () => {
    const events = personalDateEvents([
      { id: "p1", title: "HR meeting", note: "Steward present", startsAt: "2099-10-08T18:00:00Z" },
      { id: "", title: "dropped", startsAt: "2099-10-08T18:00:00Z" },
    ]);
    expect(events).toEqual([{ id: "personal-p1", title: "HR meeting", startsAt: "2099-10-08T18:00:00Z", location: "", summary: "Steward present", durationHours: 0.5 }]);
    const ics = buildIcsCalendar(events);
    expect(ics).toContain("SUMMARY:HR meeting");
    expect(ics).toContain("DTEND:20991008T183000Z");
    expect(personalDateEvents(undefined)).toEqual([]);
    expect(readFileSync("api/calendar.js", "utf8")).toContain("...personalDateEvents(resolved.personalDates)");
  });

  it("is offered in Messages > Reminders, Settings > Calendar and Workload > Reminders", () => {
    const app = readFileSync("src/App.jsx", "utf8");
    expect(app).toContain("<MessagesView {...shared} personalReminders={personalRemindersNode}");
    expect(app).toContain("<SettingsView {...altPageProps} {...shared} personalReminders={personalRemindersNode}");
    expect(app).toContain("personalReminders={personalRemindersNode} statsGate={quarterlySurveyGate}");
    expect(readFileSync("src/views/MessagesView.jsx", "utf8")).toContain('{selectedFilter === "reminder" && !lowered ? personalReminders : null}');
  });
});

const workloadData = { workload: { entries: [
  { id: "w1", receipt: "21cf1060", counts: {}, meta: "", note: "Call-back", dateLabel: "Oct 3", workedOn: "2026-10-03", hoursWorked: 2.5 },
], stats: null, reminders: {} } };

describe("workload: worked day and hours, tabs and the survey gate", () => {
  it("validates the worked day and hours", () => {
    const now = new Date("2026-10-30T12:00:00");
    expect(workedDetails("2026-10-03", "2.5", now)).toEqual({ workedOn: "2026-10-03", hoursWorked: 2.5 });
    expect(workedDetails("2026-11-30", "", now)).toEqual({});
    expect(workedDetails("", "25", now)).toEqual({});
    expect(workedDetails("", "1.1", now)).toEqual({});
    expect(workedDetails("", "0", now)).toEqual({ hoursWorked: 0 });
  });

  it("opens Reminders from ?tab=reminders with the member's own reminders there", async () => {
    window.history.replaceState({}, "", "/m/workload?tab=reminders");
    wrap(<WorkloadView data={workloadData} onLogWork={vi.fn()} onSaveReminder={vi.fn()} personalReminders={<p>My own reminders</p>} />);
    expect(await screen.findByText("My own reminders")).toBeInTheDocument();
  });

  it("gates only the Stats tab, and shows the worked day and hours in History", async () => {
    const statsGate = vi.fn((content) => <div data-testid="gated">{content}</div>);
    wrap(<WorkloadView data={workloadData} onLogWork={vi.fn()} onSaveReminder={vi.fn()} statsGate={statsGate} />);
    expect(statsGate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(await screen.findByText("Worked 2026-10-03 · 2.5 h")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stats" }));
    expect(await screen.findByTestId("gated")).toBeInTheDocument();
    expect(statsGate).toHaveBeenCalled();
  });

  it("sends the worked day and hours with the entry, and refuses bad hours", async () => {
    const onLogWork = vi.fn().mockResolvedValue({ receiptCode: "abc123", remainingToday: 2 });
    wrap(<WorkloadView data={workloadData} onLogWork={onLogWork} onSaveReminder={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Day worked"), { target: { value: "2026-10-03" } });
    fireEvent.change(screen.getByLabelText("Hours worked"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: t("en", "workload.submitCta") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(t("en", "workload.hoursInvalid"));
    expect(onLogWork).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Hours worked"), { target: { value: "7.5" } });
    fireEvent.click(screen.getByRole("button", { name: t("en", "workload.submitCta") }));
    await waitFor(() => expect(onLogWork).toHaveBeenCalled());
    expect(onLogWork.mock.calls[0][0].subDetails).toEqual({ workedOn: "2026-10-03", hoursWorked: 7.5 });
  });

  it("refuses a Day worked after today with a reason instead of dropping it, and keeps the entry (#9469)", async () => {
    const onLogWork = vi.fn().mockResolvedValue({ receiptCode: "abc123", remainingToday: 2 });
    wrap(<WorkloadView data={workloadData} onLogWork={onLogWork} onSaveReminder={vi.fn()} />, "es");
    fireEvent.change(screen.getByLabelText(t("es", "workload.workedOn")), { target: { value: "2999-01-01" } });
    fireEvent.change(screen.getByLabelText(t("es", "workload.hoursWorked")), { target: { value: "7.5" } });
    fireEvent.click(screen.getByRole("button", { name: t("es", "workload.submitCta") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(t("es", "workload.workedOnFuture"));
    expect(onLogWork).not.toHaveBeenCalled();
    expect(screen.getByLabelText(t("es", "workload.hoursWorked"))).toHaveValue(7.5);
    expect(t("en", "workload.workedOnFuture")).toBe("Day worked can't be after today.");
  });

  it("names only a real date after today as a future Day worked (#9469)", () => {
    const now = new Date("2026-10-30T12:00:00");
    expect(futureWorkedOn("2026-10-31", now)).toBe(true);
    expect(futureWorkedOn("2026-10-30", now)).toBe(false);
    expect(futureWorkedOn("2026-02-31", now)).toBe(false);
    expect(futureWorkedOn("2999-02-31", now)).toBe(false);
    expect(futureWorkedOn("not a date", now)).toBe(false);
    expect(futureWorkedOn("", now)).toBe(false);
  });

  it("r1s8: exports the worked day and hours in the History CSV", async () => {
    const blobs = [];
    Object.assign(URL, { createObjectURL: vi.fn((blob) => { blobs.push(blob); return "blob:x"; }), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    wrap(<WorkloadView data={workloadData} onLogWork={vi.fn()} onSaveReminder={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(await screen.findByRole("button", { name: t("en", "workload.downloadCsv") }));
    await waitFor(() => expect(blobs).toHaveLength(1));
    const text = await blobs[0].text();
    expect(text).toMatch(/worked_on.*hours_worked/);
    expect(text).toMatch(/2026-10-03/);
    expect(text).toMatch(/2\.5/);
  });

  it("re-reads after a failed submit and says a failure does not count", () => {
    const app = readFileSync("src/App.jsx", "utf8");
    expect(app).toContain('if (!demoActive) await refresh(sessionRef.current, memberMutationResources("submitWorkloadLog")).catch(() => {});');
    expect(t("en", "workload.submitFailed")).toMatch(/does not count toward today's limit/);
  });
});

const desk = {
  schedule: { timezone: "Europe/Lisbon", minNoticeMinutes: 240, bufferBeforeMinutes: 10, bufferAfterMinutes: 10, maxPerDay: 6, accepting: true },
  windows: [{ id: "w1", weekday: 3, startMinute: 960, endMinute: 1020 }],
  blackouts: [], connections: [],
  upcoming: [{ id: "sa-1", memberName: "Jordan Mills", type: "office_hours", durationMinutes: 30, startsAt: "2036-08-06T13:30:00Z", endsAt: "2036-08-06T14:00:00Z", status: "confirmed", reasonCategory: "pay", routedVia: "committee member" }],
  recent: [], stats: { noShows30d: 0, completed30d: 0 },
};

function stewardApi(overrides = {}) {
  return {
    loadAppointments: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(desk))),
    markOutcome: vi.fn(), cancelAppointment: vi.fn(), slots: vi.fn(), rescheduleAppointment: vi.fn(),
    setSchedule: vi.fn().mockResolvedValue({}), setWindows: vi.fn().mockResolvedValue({}),
    addBlackout: vi.fn(), removeBlackout: vi.fn(), requestConnection: vi.fn(), removeConnection: vi.fn(),
    loadScheduleDetails: vi.fn().mockResolvedValue({ title: "Office hours", location: "Halden Hall lounge", audience: "Computer Science TAs", startsOn: "2026-11-04" }),
    setScheduleDetails: vi.fn().mockResolvedValue({}),
    loadNotes: vi.fn().mockResolvedValue(new Map([["sa-1", "Discussed overtime list"]])),
    setNote: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

describe("booking hours and booking notes", () => {
  it("picks the time zone from a list, keeping a saved zone, and saves title, place, audience and first day", async () => {
    const api = stewardApi();
    wrap(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    const zone = await screen.findByLabelText("Time zone");
    expect(zone.tagName).toBe("SELECT");
    expect(zone).toHaveValue("Europe/Lisbon");
    expect(within(zone).getByRole("option", { name: t("en", "settings.zoneChicago") })).toHaveValue("America/Chicago");
    expect(await screen.findByLabelText("Location")).toHaveValue("Halden Hall lounge");
    fireEvent.change(screen.getByLabelText("Who they are for"), { target: { value: "CS 210 TAs" } });
    fireEvent.change(zone, { target: { value: "America/New_York" } });
    fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
    await waitFor(() => expect(api.setScheduleDetails).toHaveBeenCalledWith({ title: "Office hours", location: "Halden Hall lounge", audience: "CS 210 TAs", startsOn: "2026-11-04" }));
    expect(api.setSchedule).toHaveBeenCalledWith(expect.objectContaining({ timezone: "America/New_York" }));
    expect(BOOKING_TIME_ZONES.map(([zoneId]) => zoneId)).toContain("Pacific/Honolulu");
  });

  it("r1s1: never writes details it could not read, and offers a retry", async () => {
    const loadScheduleDetails = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ title: "Office hours", startsOn: "2026-11-04" });
    const api = stewardApi({ loadScheduleDetails });
    wrap(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    expect(await screen.findByText(/could not be loaded, so saving now leaves them as they are/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
    await waitFor(() => expect(api.setWindows).toHaveBeenCalled());
    expect(api.setScheduleDetails).not.toHaveBeenCalled();
  });

  it("r1s1: a retry reads the details again before any write", async () => {
    const loadScheduleDetails = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ title: "Office hours", startsOn: "2026-11-04" });
    const api = stewardApi({ loadScheduleDetails });
    wrap(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("First day")).toHaveValue("2026-11-04");
    expect(loadScheduleDetails).toHaveBeenCalledTimes(2);
  });

  it("r1s2: a failed details write keeps the committed schedule", async () => {
    const api = stewardApi({ setScheduleDetails: vi.fn().mockRejectedValue(new Error("refused")) });
    wrap(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Availability" }));
    await screen.findByLabelText("Location");
    fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
    expect(await screen.findByText(t("en", "appt.availabilityPartiallySaved"))).toBeInTheDocument();
    expect(api.loadAppointments.mock.calls.length).toBeGreaterThan(1);
  });

  it("keeps a private note on a booking", async () => {
    const api = stewardApi();
    wrap(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Private note for the booking with Jordan Mills" }));
    const box = await screen.findByLabelText("How it went");
    await waitFor(() => expect(box).toHaveValue("Discussed overtime list"));
    fireEvent.change(box, { target: { value: "Filed the grievance" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(api.setNote).toHaveBeenCalledWith("sa-1", "Filed the grievance"));
    expect(await screen.findByText("Note saved.")).toBeInTheDocument();
  });

  it("r2s1: never saves a note it could not read, and a retry reads it again", async () => {
    const loadNotes = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(new Map([["sa-1", "Discussed overtime list"]]));
    const api = stewardApi({ loadNotes });
    wrap(<StewardAppointmentsPanel api={api} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Private note for the booking with Jordan Mills" }));
    expect(await screen.findByText(/could not be loaded, so it cannot be edited or saved/)).toBeInTheDocument();
    expect(screen.getByLabelText("How it went")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save note" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(api.setNote).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByLabelText("How it went")).toHaveValue("Discussed overtime list"));
    expect(screen.getByRole("button", { name: "Save note" })).toBeEnabled();
    expect(loadNotes).toHaveBeenCalledTimes(2);
  });

  it("shows members the chosen steward's title, place, audience and first day", async () => {
    const api = {
      stewards: vi.fn().mockResolvedValue([{ id: "st-1", name: "Sam Okafor" }]),
      slots: vi.fn().mockResolvedValue({ slots: [] }),
      stewardDetails: vi.fn().mockResolvedValue([{ stewardId: "st-1", title: "Office hours", location: "Linen room", audience: "Housekeeping", startsOn: "2026-11-04" }]),
    };
    wrap(<AppointmentsView data={{ member: { initials: "PR" }, appointments: [] }} api={api} onBook={vi.fn()} onCancel={vi.fn()} onReschedule={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Request a one-on-one" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sam Okafor" }));
    expect(await screen.findByText("Office hours · at Linen room · for Housekeeping · from 2026-11-04")).toBeInTheDocument();
    expect(api.stewardDetails).toHaveBeenCalledWith(["st-1"]);
  });

  it("shows only the details a steward set, and none when the read fails or there is nothing to show", async () => {
    const view = (api) => wrap(<AppointmentsView data={{ member: { initials: "PR" }, appointments: [] }} api={api} onBook={vi.fn()} onCancel={vi.fn()} onReschedule={vi.fn()} />);
    const base = () => ({ stewards: vi.fn().mockResolvedValue([{ id: "st-1", name: "Sam Okafor" }, { id: "st-2", name: "Ana Diaz" }]), slots: vi.fn().mockResolvedValue({ slots: [] }) });

    const titleOnly = { ...base(), stewardDetails: vi.fn().mockResolvedValue([{ stewardId: "st-1", title: "Office hours" }, { stewardId: "st-2" }]) };
    view(titleOnly);
    fireEvent.click(screen.getByRole("button", { name: "Request a one-on-one" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sam Okafor" }));
    await waitFor(() => expect(document.querySelector("[data-booking-details]")?.textContent).toBe("Office hours"));
    expect(titleOnly.stewardDetails).toHaveBeenCalledWith(["st-1", "st-2"]);
    fireEvent.click(screen.getByRole("button", { name: "Ana Diaz" }));
    await waitFor(() => expect(document.querySelector("[data-booking-details]")).toBeNull());
    cleanup();

    const failing = { ...base(), stewardDetails: vi.fn().mockRejectedValue(new Error("offline")) };
    view(failing);
    fireEvent.click(screen.getByRole("button", { name: "Request a one-on-one" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sam Okafor" }));
    await waitFor(() => expect(failing.stewardDetails).toHaveBeenCalled());
    expect(document.querySelector("[data-booking-details]")).toBeNull();
    cleanup();

    const noDetailsApi = base();
    view(noDetailsApi);
    fireEvent.click(screen.getByRole("button", { name: "Request a one-on-one" }));
    expect(await screen.findByRole("button", { name: "Sam Okafor" })).toBeInTheDocument();
    expect(document.querySelector("[data-booking-details]")).toBeNull();
    cleanup();

    const noStewards = { stewards: vi.fn().mockResolvedValue(null), slots: vi.fn().mockResolvedValue({ slots: [] }), stewardDetails: vi.fn() };
    view(noStewards);
    fireEvent.click(screen.getByRole("button", { name: "Request a one-on-one" }));
    await waitFor(() => expect(noStewards.stewards).toHaveBeenCalled());
    expect(noStewards.stewardDetails).not.toHaveBeenCalled();
  });

  it("asks for no booking details once the request dialog has closed", async () => {
    let release;
    const api = {
      stewards: vi.fn(() => new Promise((resolve) => { release = resolve; })),
      slots: vi.fn().mockResolvedValue({ slots: [] }),
      stewardDetails: vi.fn().mockResolvedValue([]),
    };
    const { unmount } = wrap(<AppointmentsView data={{ member: { initials: "PR" }, appointments: [] }} api={api} onBook={vi.fn()} onCancel={vi.fn()} onReschedule={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Request a one-on-one" }));
    await waitFor(() => expect(api.stewards).toHaveBeenCalled());
    unmount();
    release([{ id: "st-1", name: "Sam Okafor" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.stewardDetails).not.toHaveBeenCalled();
  });

  it("sends blanks as nulls and reads notes as a map", async () => {
    const client = rpcClient({
      set_appointment_schedule_details: () => ({}),
      get_appointment_notes: () => [{ appointmentId: "a1", note: "ok" }],
    });
    await saveScheduleDetails(client, { title: "  ", location: "Hall", audience: "", startsOn: "" });
    expect(client.rpc).toHaveBeenCalledWith("set_appointment_schedule_details", { p_title: null, p_location: "Hall", p_audience: null, p_starts_on: null });
    expect((await loadAppointmentNotes(client, ["a1"])).get("a1")).toBe("ok");
    expect((await loadAppointmentNotes(client, [])).size).toBe(0);
  });

  it("reads own or listed details, clears a blank note, and surfaces refusals with their code", async () => {
    const client = rpcClient({
      get_appointment_schedule_details: (args) => (args.p_steward_ids ? [{ stewardId: "st-1" }] : null),
      set_appointment_note: () => { throw Object.assign(new Error("appointment not found"), { code: "P0002" }); },
    });
    expect(await loadScheduleDetails(client, ["st-1"])).toEqual([{ stewardId: "st-1" }]);
    expect(await loadScheduleDetails(client)).toEqual([]);
    expect(client.rpc).toHaveBeenCalledWith("get_appointment_schedule_details", { p_steward_ids: null });
    await expect(saveAppointmentNote(client, "a1", "   ")).rejects.toMatchObject({ code: "P0002" });
    expect(client.rpc).toHaveBeenCalledWith("set_appointment_note", { p_appointment_id: "a1", p_note: null });
  });
});

describe("the migration", () => {
  const sql = readFileSync("supabase/migrations/20261030234501_personal_reminders_booking_details_and_notes.sql", "utf8");

  it("keeps personal reminders owner-only, bounded and delivered by the existing dispatcher", () => {
    expect(sql).toContain("r.owner_id = caller and r.source_kind = 'personal' and r.status = 'scheduled'");
    expect(sql).toContain("personal reminder limit reached");
    expect(sql).toContain("and pending.source_kind in ('task_item', 'event', 'personal')");
    expect(sql).toContain("private.next_personal_reminder_at(reminder.remind_at, reminder.repeat_rule, reminder.time_zone)");
    expect(sql).toContain("where r.owner_id = target and r.source_kind = 'personal' and r.status in ('scheduled', 'delivered')");
  });

  it("r1: repeats keep local time, dates stay on the feed after firing, and personal rows stay out of the workflow list", () => {
    expect(sql).toContain("when 'daily' then ((p_at at time zone p_zone) + interval '1 day') at time zone p_zone");
    expect(sql).toContain("not exists (select 1 from private.iana_timezone_names zone where zone.name = p_time_zone)");
    expect(sql).toContain("r.status in ('scheduled', 'delivered')");
    expect(sql).toContain("and r.remind_at >= pg_catalog.now() - interval '30 days'");
    expect(sql.match(/and r\.source_kind <> 'personal'/g)).toHaveLength(2);
    expect(sql).toContain("create policy mfa_assurance on public.member_appointment_notes");
    const contract = JSON.parse(readFileSync("scripts/db-contract.json", "utf8"));
    expect(contract.functions.find((entry) => entry.sig === "public.get_calendar_feed_events(p_token text)").bodyMd5).toBe("b3750f1b03df276bf4acd879212790d6");
    expect(contract.tableGrants.filter((entry) => entry.table === "public.member_appointment_notes").map((entry) => entry.role)).toEqual(["anon", "authenticated", "service_role"]);
  });

});

// Add reminder and a reminder's Cancel keep focus while their write
// runs, and the reminders' one lock refuses a second write in the same tick.
describe("personal reminder writes while one runs", () => {
  const client = () => rpcClient({
    list_personal_reminders: () => ({ items: [reminder("r1", "Friday mandate tally", "2099-11-06T14:00:00Z", "weekly")], nextCursor: null }),
    save_personal_reminder: () => ({ id: "r3" }),
    cancel_personal_reminder: () => ({ id: "r1", status: "cancelled" }),
  });
  const addButton = async () => {
    await screen.findByRole("button", { name: "Cancel the reminder Friday mandate tally" });
    fireEvent.change(screen.getByLabelText("What to remember"), { target: { value: "Shift log" } });
    fireEvent.change(screen.getByLabelText("When"), { target: { value: "2099-11-04T09:00" } });
    return screen.getByRole("button", { name: "Add reminder" });
  };

  it("keeps Add reminder focused while it saves, and saves once", async () => {
    const rpc = client();
    wrap(<PersonalReminders client={rpc} />);
    await expectHeldWriteFocus(rpc.rpc, await addButton());
    expect(rpc.rpc.mock.calls.filter(([name]) => name === "save_personal_reminder")).toHaveLength(1);
  });

  it("starts one reminder write when Add reminder and Cancel are activated in one tick", async () => {
    const rpc = client();
    wrap(<PersonalReminders client={rpc} />);
    const add = await addButton();
    const cancel = screen.getByRole("button", { name: "Cancel the reminder Friday mandate tally" });
    await expectOneWriteFromOneTick(rpc.rpc, [() => fireEvent.click(add), () => fireEvent.click(add), () => fireEvent.click(cancel)], { isWrite: isRpcWrite });
  });

  it("keeps a reminder's Cancel focused while it cancels, and cancels once", async () => {
    const rpc = client();
    wrap(<PersonalReminders client={rpc} />);
    await expectHeldWriteFocus(rpc.rpc, await screen.findByRole("button", { name: "Cancel the reminder Friday mandate tally" }));
    expect(rpc.rpc.mock.calls.filter(([name]) => name === "cancel_personal_reminder")).toHaveLength(1);
  });
});
