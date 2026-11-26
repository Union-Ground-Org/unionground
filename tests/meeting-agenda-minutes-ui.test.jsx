// REQ-UG-OFFICER-BUDGET-AND-MEETING-AGENDA-20261006 (partial delivery)
//
// Owner decision, October 8, 2026 (question 8, option A): staff keep a meeting
// agenda on the events desk and attach minutes to the meeting from the
// chapter record. The officer budget is held.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventAuthoringCard } from "../src/components/EventAuthoringCard.jsx";
import { InstitutionalRecordsPanel } from "../src/features/institutionalRecords/InstitutionalRecordsPanel.jsx";
import { act } from "react";
import { applyDeviceParityState, clearDeviceParityState } from "../src/lib/deviceParity.js";
import { t } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";
import { openPastEvents } from "./helpers/openPastEvents.js";
import { setAdminEventAgenda } from "../src/lib/memberApi.js";
// The shared rpc mock carries reads too (a reload that
// lands inside the tick); only writes count toward the one-write rule.
const isRpcWrite = (name) => !/^(get|list|load|search)_/.test(String(name));

const meeting = {
  id: "october-meeting", title: "October membership meeting", startsAt: "2026-10-14T22:00:00Z",
  startsLabel: "Oct 14, 6 PM", location: "Union hall", summary: "Monthly meeting",
  checkInCode: "SG-OCT", isPublic: false, isPublicAcrossAgencies: false, rsvpCount: 0, checkinCount: 0, version: 1,
};

afterEach(() => clearDeviceParityState());

function renderCard(events, api) {
  const onNotice = vi.fn();
  const reload = vi.fn();
  render(
    <LanguageProvider lang="en">
      <EventAuthoringCard events={events} api={api} onNotice={onNotice} reload={reload} chapterName="Harbor Local" />
    </LanguageProvider>,
  );
  openPastEvents();
  return { onNotice, reload };
}

describe("meeting agenda on the events desk", () => {
  it("shows the agenda with its line breaks and the titles of the minutes attached to the meeting", () => {
    renderCard([{ ...meeting, agenda: "1. Call to order\n2. Grievance report", minutes: [{ id: "m1", title: "October minutes" }] }], { setEventAgenda: vi.fn() });
    expect(screen.getByText("Agenda")).toBeInTheDocument();
    const text = screen.getByText(/1\. Call to order/);
    expect(text.textContent).toBe("1. Call to order\n2. Grievance report");
    expect(text).toHaveClass("xus-event-agenda__text");
    expect(screen.getByText("Minutes: October minutes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit agenda" })).toBeInTheDocument();
  });

  it("adds an agenda through the agenda RPC, not the event edit", async () => {
    const api = { updateEvent: vi.fn(), setEventAgenda: vi.fn().mockResolvedValue({ updated: true, agenda: "1. Elections" }) };
    const { onNotice, reload } = renderCard([meeting], api);
    expect(screen.queryByText("Agenda")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add agenda" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Agenda" }), { target: { value: "1. Elections" } });
    fireEvent.click(screen.getByRole("button", { name: "Save agenda" }));
    await waitFor(() => expect(api.setEventAgenda).toHaveBeenCalledWith("october-meeting", "1. Elections", 1));
    expect(api.updateEvent).not.toHaveBeenCalled();
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Agenda saved"));
    expect(reload).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Agenda" })).not.toBeInTheDocument());
  });

  it("prefills the current agenda and reports a removal when it is emptied", async () => {
    const api = { setEventAgenda: vi.fn().mockResolvedValue({ updated: true, agenda: null }) };
    const { onNotice } = renderCard([{ ...meeting, agenda: "Old agenda" }], api);
    fireEvent.click(screen.getByRole("button", { name: "Edit agenda" }));
    const field = screen.getByRole("textbox", { name: "Agenda" });
    expect(field).toHaveValue("Old agenda");
    expect(field).toHaveAttribute("maxLength", "4000");
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save agenda" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Agenda removed"));
  });

  // REQ-UG-LEARNING-PERIOD-EVENTS-20261103:
  // the agenda editor sends the version it opened, so a stale save is refused.

  // Gate finding r4g1 on #7029: the agenda id and draft reach the paired
  // phone, so the version the desktop opened has to travel with them.
  it("saves an agenda opened on the paired device with the version that device opened", async () => {
    const api = { setEventAgenda: vi.fn().mockResolvedValue({ updated: true, agenda: "1. Elections", version: 8 }) };
    renderCard([{ ...meeting, version: 9 }], api);
    act(() => {
      applyDeviceParityState("admin.agendaEventId", "october-meeting");
      applyDeviceParityState("admin.eventAgendaDraft", "1. Elections");
      applyDeviceParityState("admin.eventAgendaVersion", 7);
    });
    fireEvent.click(screen.getByRole("button", { name: "Save agenda" }));
    await waitFor(() => expect(api.setEventAgenda).toHaveBeenCalledWith("october-meeting", "1. Elections", 7));
  });


  it("sends a version when given one, and never resends the agenda without it (#8960)", async () => {
    const client = { rpc: vi.fn()
      .mockResolvedValueOnce({ data: { updated: true }, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "missing" } })
      .mockResolvedValue({ data: { updated: true }, error: null }) };
    await setAdminEventAgenda(client, "e1", "1. Elections", 3);
    await expect(setAdminEventAgenda(client, "e1", "1. Elections", 4)).rejects.toMatchObject({ code: "PGRST202" });
    expect(client.rpc.mock.calls).toEqual([
      ["set_member_event_agenda", { p_id: "e1", p_agenda: "1. Elections", p_expected_version: 3 }],
      ["set_member_event_agenda", { p_id: "e1", p_agenda: "1. Elections", p_expected_version: 4 }],
    ]);
  });

  it("offers no agenda control on a surface whose api cannot set one", () => {
    renderCard([meeting], { updateEvent: vi.fn() });
    expect(screen.queryByRole("button", { name: "Add agenda" })).not.toBeInTheDocument();
  });

  it("sends a trimmed agenda, and null for a blank one", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: { updated: true }, error: null }) };
    await setAdminEventAgenda(client, "e1", "  1. Elections  ");
    await setAdminEventAgenda(client, "e1", "   ");
    expect(client.rpc.mock.calls).toEqual([
      ["set_member_event_agenda", { p_id: "e1", p_agenda: "1. Elections" }],
      ["set_member_event_agenda", { p_id: "e1", p_agenda: null }],
    ]);
  });
});

const minutesRecord = {
  id: "minutes-1", record_type: "minutes", lifecycle_status: "published", title: "October minutes",
  body: "Members approved the agenda.", occurred_at: "2026-10-14T23:00:00.000Z", version: 1, attendance: [], event_id: null,
};

function renderPanel({ record = minutesRecord, meetings = [meeting, { ...meeting, id: "cancelled", title: "Cancelled meeting", cancelledAt: "2026-10-01T00:00:00Z" }], deskFails = false, lang = "en" } = {}) {
  const onNotice = vi.fn();
  const client = {
    rpc: vi.fn(async (name) => {
      if (name === "get_institutional_records_workspace") return { data: { canManage: true, canExport: false, records: [record], contacts: [], roster: [], exportRuns: [] }, error: null };
      if (name === "get_admin_events") return deskFails ? { data: null, error: { message: "staff role required", code: "42501" } } : { data: meetings, error: null };
      if (name === "attach_minutes_to_meeting") return { data: { updated: true }, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    }),
  };
  render(
    <LanguageProvider lang={lang}>
      <InstitutionalRecordsPanel client={client} canStaff onNotice={onNotice} />
    </LanguageProvider>,
  );
  return { client, onNotice };
}

describe("minutes attached to a meeting in the chapter record", () => {
  it("attaches minutes to a meeting, showing that meeting's agenda read-only and leaving cancelled meetings out", async () => {
    const { client, onNotice } = renderPanel({ meetings: [{ ...meeting, agenda: "1. Elections" }, { ...meeting, id: "cancelled", title: "Cancelled meeting", cancelledAt: "2026-10-01T00:00:00Z" }] });
    fireEvent.click(await screen.findByRole("button", { name: "Attach to a meeting" }));
    const dialog = screen.getByRole("dialog");
    const select = within(dialog).getByRole("combobox", { name: /Meeting/ });
    expect(within(select).queryByRole("option", { name: /Cancelled meeting/ })).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: "october-meeting" } });
    expect(within(dialog).getByText("1. Elections")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Detach from meeting" })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Attach minutes" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("attach_minutes_to_meeting", { p_record_id: "minutes-1", p_event_id: "october-meeting" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Minutes attached to the meeting"));
  });

  // The meeting:<record> lock refuses a second attach or a detach
  // started in the same tick, before busy commits.
  it("attaches once when Attach minutes and Detach are activated in one tick", async () => {
    const { client } = renderPanel({ record: { ...minutesRecord, event_id: "october-meeting" } });
    fireEvent.click(await screen.findByRole("button", { name: "Change meeting" }));
    const dialog = screen.getByRole("dialog");
    const attach = within(dialog).getByRole("button", { name: "Attach minutes" });
    const detach = within(dialog).getByRole("button", { name: "Detach from meeting" });
    await expectOneWriteFromOneTick(client.rpc, [() => fireEvent.click(attach), () => fireEvent.click(attach), () => fireEvent.click(detach)], { isWrite: isRpcWrite });
  });

  it("names the attached meeting on the card and can detach the minutes", async () => {
    const { client, onNotice } = renderPanel({ record: { ...minutesRecord, event_id: "october-meeting" } });
    expect(await screen.findByText("Meeting: October membership meeting")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change meeting" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("This meeting has no agenda yet.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Detach from meeting" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("attach_minutes_to_meeting", { p_record_id: "minutes-1", p_event_id: null }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Minutes detached from the meeting"));
  });

  it("shows no meeting control when the meetings cannot be read, and nothing for a meeting that no longer exists", async () => {
    renderPanel({ record: { ...minutesRecord, event_id: "deleted-meeting" }, deskFails: true });
    expect(await screen.findByText("October minutes")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Attach to a meeting" })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Meeting:/)).not.toBeInTheDocument();
  });

  it("treats a meetings read that is not a list as unreadable instead of crashing", async () => {
    renderPanel({ meetings: {} });
    expect(await screen.findByText("October minutes")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Attach to a meeting" })).not.toBeInTheDocument();
  });

  it("has Spanish copy for every new key", () => {
    const keys = [
      "admin.eventAgenda", "admin.addEventAgenda", "admin.editEventAgenda", "admin.eventAgendaHelp", "admin.eventAgendaSubmit",
      "admin.eventAgendaDismiss", "admin.eventAgendaSaved", "admin.eventAgendaCleared", "admin.eventMinutesAttached",
      "records.meeting", "records.attachMeeting", "records.changeMeeting", "records.meetingEyebrow", "records.meetingHelp",
      "records.meetingNoAgenda", "records.saveMeeting", "records.detachMeeting", "records.meetingAttached",
      "records.meetingDetached", "records.meetingFailed",
    ];
    for (const key of keys) {
      expect(t("es", key)).not.toBe(key);
      // "Agenda" is the same word in both languages.
      if (key !== "admin.eventAgenda") expect(t("es", key)).not.toBe(t("en", key));
    }
    expect(t("es", "records.meeting", { event: "Asamblea" })).toBe("Reunión: Asamblea");
  });
});
