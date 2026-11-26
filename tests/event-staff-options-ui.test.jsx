// REQ-UG-EVENTS-RSVP-CHECK-IN-AND-VISIBILITY-20261030 (findings 32,
// 40, 55, 56 and 102 of the October 29-30 role-play run): required marks, the
// time zone and past-date warning, a generated and labelled door code with a
// door display, staff-only drafts, and the RSVP switch.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_EVENT,
  EventAuthoringCard,
  draftFieldsFromForm,
  formFromDraft,
  generateCheckInCode,
} from "../src/components/EventAuthoringCard.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
import { openPastEvents } from "./helpers/openPastEvents.js";
import { eventScheduleInPast, eventTimeZoneLabel, eventModelLabels } from "../src/lib/eventModel.js";

const CODE = /^SG-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

function localInput(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function staffApi(overrides = {}) {
  return {
    createEvent: vi.fn().mockResolvedValue({ id: "general-meeting", created: true }),
    updateEvent: vi.fn().mockResolvedValue({ updated: true }),
    setEventRsvpOpen: vi.fn().mockResolvedValue({ updated: true }),
    listEventDrafts: vi.fn().mockResolvedValue([]),
    saveEventDraft: vi.fn().mockResolvedValue({ id: "draft-1" }),
    deleteEventDraft: vi.fn().mockResolvedValue({ deleted: true }),
    ...overrides,
  };
}

function renderCard({ api = staffApi(), events = [], lang = "en" } = {}) {
  const onNotice = vi.fn();
  const reload = vi.fn();
  const view = render(
    <LanguageProvider lang={lang}>
      <EventAuthoringCard events={events} api={api} onNotice={onNotice} reload={reload} chapterName="Harrow Bay" />
    </LanguageProvider>,
  );
  openPastEvents();
  return { api, onNotice, reload, view };
}

function fillMeeting(startsAt = localInput(Date.now() + 3 * 86400000)) {
  for (const [label, value] of [
    ["Web name", "general-meeting"], ["Title", "General meeting"],
    ["Starts", startsAt], ["Location", "Union hall"], ["Summary", "Monthly meeting"],
  ]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

const savedMeeting = {
  id: "general-meeting", title: "General meeting", startsAt: new Date(Date.now() + 86400000).toISOString(),
  startsLabel: "Sat, Oct 31 · 6:00 PM", location: "Union hall", summary: "Monthly meeting",
  checkInCode: "SG-DOOR42", rsvpCount: 7, checkinCount: 2, rsvpOpen: true,
};

describe("event form marks, time zone and past dates", () => {
  it("marks every required field before any save and says what the mark means", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
    expect(screen.getByText("Fields marked * are required.")).toBeInTheDocument();
    for (const label of ["Web name", "Title", "Starts", "Location", "Summary", "Monthly dates (including the first)"]) {
      const input = screen.getByLabelText(label);
      expect(input).toBeRequired();
      expect(input.closest("label")).toHaveClass("xus-field--required");
    }
    expect(screen.getByLabelText("Ends (optional)").closest("label")).not.toHaveClass("xus-field--required");
    expect(screen.getByLabelText("Check-in code (SG-…)").closest("label")).not.toHaveClass("xus-field--required");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the time zone the times are entered in, with its short name", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(screen.getByText(new RegExp(`^Times are in ${zone.replace(/[/+]/g, "\\$&")}`))).toBeInTheDocument();
  });

  it("warns before saving a start that has already passed, and still lets it save", async () => {
    const { api } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
    fillMeeting(localInput(Date.now() + 2 * 86400000));
    expect(screen.queryByText(/This date has already passed/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Starts"), { target: { value: localInput(Date.now() - 2 * 86400000) } });
    expect(screen.getByRole("status")).toHaveTextContent("This date has already passed. Check it before you save: workers will see the meeting as past.");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledOnce());
  });

  it("warns for a calendar date before today", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
    fireEvent.change(screen.getByLabelText("Meeting type"), { target: { value: "deadline" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2020-01-02" } });
    expect(screen.getByText(/This date has already passed/)).toBeInTheDocument();
  });


  it("uses Spanish for the marks, zone and warning", () => {
    renderCard({ lang: "es" });
    fireEvent.click(screen.getByRole("button", { name: "Nueva reunión" }));
    expect(screen.getByText("Los campos marcados con * son obligatorios.")).toBeInTheDocument();
    expect(screen.getByText(/^Las horas están en /)).toBeInTheDocument();
  });
});

describe("door check-in code", () => {
  it("fills a new meeting with a readable code and can make another", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
    const code = screen.getByLabelText("Check-in code (SG-…)");
    expect(code.value).toMatch(CODE);
    expect(code).toHaveAccessibleDescription(/One was made for you/);
    const first = code.value;
    let next = first;
    for (let attempt = 0; attempt < 5 && next === first; attempt += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Make a new code" }));
      next = screen.getByLabelText("Check-in code (SG-…)").value;
    }
    expect(next).toMatch(CODE);
    expect(next).not.toBe(first);
  });

  it("sends the generated code with the new meeting", async () => {
    const { api } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
    const code = screen.getByLabelText("Check-in code (SG-…)").value;
    fillMeeting();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledWith(expect.objectContaining({ checkInCode: code })));
  });

  it("generates only from the unambiguous alphabet", () => {
    expect(generateCheckInCode((bytes) => bytes.fill(0))).toBe("SG-AAAAAA");
    expect(generateCheckInCode((bytes) => bytes.fill(31))).toBe("SG-999999");
    expect(generateCheckInCode((bytes) => bytes.fill(32))).toBe("SG-AAAAAA");
  });

  it("labels the saved code on the list and opens a door display without member data", () => {
    renderCard({ events: [savedMeeting] });
    const line = screen.getByText("Door check-in code").closest("p");
    expect(within(line).getByText("SG-DOOR42")).toBeInTheDocument();
    const open = within(line).getByRole("button", { name: "Show door display" });
    fireEvent.click(open);
    const door = screen.getByRole("dialog", { name: "Door display for General meeting" });
    expect(door).toHaveAttribute("aria-modal", "true");
    expect(within(door).getByText("SG-DOOR42")).toBeInTheDocument();
    expect(within(door).getByText("General meeting")).toBeInTheDocument();
    expect(within(door).getByText("Open Meetings in Union Ground and enter this code to check in.")).toBeInTheDocument();
    expect(door).not.toHaveTextContent("going");
    expect(door).not.toHaveTextContent("checked in");
    const close = within(door).getByRole("button", { name: "Close door display" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.click(close);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(open).toHaveFocus();
  });

  it("closes the door display with Escape and offers none for a cancelled or code-less event", () => {
    renderCard({ events: [savedMeeting, { ...savedMeeting, id: "old", title: "Old", cancelledAt: "2026-10-01T00:00:00Z" }, { ...savedMeeting, id: "deadline", title: "Deadline", checkInCode: null }] });
    expect(screen.getAllByRole("button", { name: "Show door display" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Show door display" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("puts the zone on the listed time", () => {
    renderCard({ events: [savedMeeting] });
    expect(screen.getByText(`${eventModelLabels(savedMeeting).startsLabel} · Union hall`)).toBeInTheDocument();
  });
});

describe("RSVP switch", () => {
  it("is on by default and leaves RSVPs alone when kept on", async () => {
    const { api } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
    expect(screen.getByRole("checkbox", { name: "Collect RSVPs" })).toBeChecked();
    fillMeeting();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledWith(expect.objectContaining({ rsvpOpen: true })));
    expect(api.setEventRsvpOpen).not.toHaveBeenCalled();
  });

  it("creates the event with RSVPs off in the same request when unticked", async () => {
    // Gate round 1 on #6610: a separate switch call left the new event open
    // for RSVPs until it ran.
    const { api, onNotice } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
    fillMeeting();
    fireEvent.click(screen.getByRole("checkbox", { name: "Collect RSVPs" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledWith(expect.objectContaining({ id: "general-meeting", rsvpOpen: false })));
    expect(api.setEventRsvpOpen).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith("Meeting created");
  });

  it("never asks to close RSVPs on a deadline", async () => {
    const { api } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
    fillMeeting();
    fireEvent.click(screen.getByRole("checkbox", { name: "Collect RSVPs" }));
    fireEvent.change(screen.getByLabelText("Meeting type"), { target: { value: "deadline" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: localInput(Date.now() + 86400000).slice(0, 10) } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledWith(expect.objectContaining({ eventKind: "deadline", rsvpOpen: true })));
  });

  // Gate finding r4s1 on #7029: the switch sends the version the field
  // update left, so an undo landing between the two requests refuses it.
  it("saves a changed switch on edit after the field update, at the version that update left", async () => {
    const { api, onNotice } = renderCard({ events: [savedMeeting], api: staffApi({ updateEvent: vi.fn().mockResolvedValue({ updated: false, version: 4 }) }) });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const box = screen.getByRole("checkbox", { name: "Collect RSVPs" });
    expect(box).toBeChecked();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.setEventRsvpOpen).toHaveBeenCalledWith("general-meeting", false, 4));
    expect(api.updateEvent.mock.invocationCallOrder[0]).toBeLessThan(api.setEventRsvpOpen.mock.invocationCallOrder[0]);
    expect(onNotice).toHaveBeenCalledWith("Meeting updated");
  });

  // Gate round 1 on #7029: the field update bumps the event's version, so a
  // retry after the switch fails sends the new version, not the opened one.
  it("retries a partial save with the version the field update left", async () => {
    const api = staffApi({
      updateEvent: vi.fn().mockResolvedValueOnce({ updated: true, version: 6 }).mockResolvedValue({ updated: false, version: 6 }),
      setEventRsvpOpen: vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue({ updated: true }),
    });
    renderCard({ events: [{ ...savedMeeting, version: 5 }], api });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Collect RSVPs" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.setEventRsvpOpen).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.setEventRsvpOpen).toHaveBeenCalledTimes(2));
    expect(api.updateEvent.mock.calls.map(([, fields]) => fields.expectedVersion)).toEqual([5, 6]);
    expect(api.setEventRsvpOpen.mock.calls.map(([, , version]) => version)).toEqual([6, 6]);
  });

  it("shows staff the closed state instead of a count, and hides the switch without the function", () => {
    renderCard({ events: [{ ...savedMeeting, rsvpOpen: false }], api: { createEvent: vi.fn(), updateEvent: vi.fn() } });
    expect(screen.getByText("Not collecting RSVPs · 2 checked in")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("checkbox", { name: "Collect RSVPs" })).not.toBeInTheDocument();
  });

  it("shows the going count when RSVPs are collected", () => {
    renderCard({ events: [savedMeeting] });
    expect(screen.getByText("7 going · 2 checked in")).toBeInTheDocument();
  });
});

describe("staff-only drafts", () => {
  // #9985: a restored draft brings its own web name, so editing its title
  // does not replace it.
  it("keeps a restored draft's own web name when its title changes", async () => {
    const startsAt = new Date(Date.now() + 5 * 86400000).toISOString();
    const draft = { id: "draft-9", fields: { id: "harrow-bay-huddle", title: "Steward huddle", startsAt, location: "Back room", summary: "Plan" }, updatedAt: "2026-10-30T20:00:00Z" };
    const api = staffApi({ listEventDrafts: vi.fn().mockResolvedValue([draft]) });
    renderCard({ api });
    const section = (await screen.findByText("Staff-only drafts")).closest(".xus-event-drafts");
    fireEvent.click(within(section).getByRole("button", { name: "Review and publish" }));
    expect(screen.getByLabelText("Web name")).toHaveValue("harrow-bay-huddle");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Steward huddle, evening" } });
    expect(screen.getByLabelText("Web name")).toHaveValue("harrow-bay-huddle");
  });

  it("saves the form as a staff-only draft without publishing it", async () => {
    const { api, onNotice } = renderCard();
    await waitFor(() => expect(api.listEventDrafts).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Steward huddle" } });
    const startsAt = localInput(Date.now() + 86400000);
    fireEvent.change(screen.getByLabelText("Starts"), { target: { value: startsAt } });
    fireEvent.click(screen.getByRole("button", { name: "Save as staff-only draft" }));
    await waitFor(() => expect(api.saveEventDraft).toHaveBeenCalledOnce());
    const [draftId, fields] = api.saveEventDraft.mock.calls[0];
    expect(draftId).toBeNull();
    expect(fields).toMatchObject({ title: "Steward huddle", startsAt: new Date(startsAt).toISOString(), rsvpOpen: true, eventKind: "meeting" });
    expect(fields.checkInCode).toMatch(CODE);
    // #9985: the web name follows the title, so the draft keeps it.
    expect(fields).toHaveProperty("id", "steward-huddle");
    expect(api.createEvent).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith("Draft saved. Only staff can see it until you publish it.");
    await waitFor(() => expect(api.listEventDrafts).toHaveBeenCalledTimes(2));
  });

  it("asks for a title before saving a draft", () => {
    const { api, onNotice } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
    fireEvent.click(screen.getByRole("button", { name: "Save as staff-only draft" }));
    expect(onNotice).toHaveBeenCalledWith("Give the draft a title first.");
    expect(api.saveEventDraft).not.toHaveBeenCalled();
  });

  it("lists drafts, publishes one through the ordinary create and then deletes it", async () => {
    const startsAt = new Date(Date.now() + 5 * 86400000).toISOString();
    const draft = { id: "draft-7", fields: { title: "Steward huddle", startsAt, location: "Back room", summary: "Plan", checkInCode: "SG-HUDDLE", rsvpOpen: false, isPublic: true }, updatedAt: "2026-10-30T20:00:00Z" };
    const api = staffApi({ listEventDrafts: vi.fn().mockResolvedValue([draft]) });
    const { onNotice } = renderCard({ api });
    const section = (await screen.findByText("Staff-only drafts")).closest(".xus-event-drafts");
    expect(within(section).getByText("Workers cannot see these. Review one and publish it to share it.")).toBeInTheDocument();
    expect(within(section).getByText("Steward huddle")).toBeInTheDocument();
    expect(within(section).getByText("Draft")).toBeInTheDocument();
    fireEvent.click(within(section).getByRole("button", { name: "Review and publish" }));
    expect(screen.getByLabelText("Title")).toHaveValue("Steward huddle");
    expect(screen.getByLabelText("Starts")).toHaveValue(localInput(Date.parse(startsAt)));
    expect(screen.getByLabelText("Check-in code (SG-…)")).toHaveValue("SG-HUDDLE");
    expect(screen.getByRole("checkbox", { name: "Collect RSVPs" })).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("Web name"), { target: { value: "steward-huddle" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(api.deleteEventDraft).toHaveBeenCalledWith("draft-7"));
    expect(api.createEvent).toHaveBeenCalledWith(expect.objectContaining({ id: "steward-huddle", title: "Steward huddle", isPublic: true, checkInCode: "SG-HUDDLE", rsvpOpen: false }));
    expect(api.setEventRsvpOpen).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith("Meeting created");
    await waitFor(() => expect(api.listEventDrafts).toHaveBeenCalledTimes(2));
  });

  it("reports a failed draft clean-up without losing the published event", async () => {
    const draft = { id: "draft-9", fields: { title: "Huddle", startsAt: new Date(Date.now() + 86400000).toISOString(), location: "Room", summary: "Plan" } };
    const api = staffApi({ listEventDrafts: vi.fn().mockResolvedValue([draft]), deleteEventDraft: vi.fn().mockRejectedValue(new Error("delete refused")) });
    const { onNotice } = renderCard({ api });
    fireEvent.click(await screen.findByRole("button", { name: "Review and publish" }));
    fireEvent.change(screen.getByLabelText("Web name"), { target: { value: "huddle" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("delete refused"));
    expect(onNotice).toHaveBeenCalledWith("Meeting created");
    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
  });

  it("lists a draft with an unreadable date as unscheduled and keeps its controls", async () => {
    // Gate round 1 on #6610: a bad saved value threw while formatting.
    const api = staffApi({ listEventDrafts: vi.fn().mockResolvedValue([
      { id: "bad-start", fields: { title: "Bad start", startsAt: "TBD", endsAt: "later" } },
      { id: "bad-date", fields: { title: "Bad date", eventKind: "deadline", eventDate: "2026-13-45" } },
    ]) });
    renderCard({ api });
    const section = (await screen.findByText("Staff-only drafts")).closest(".xus-event-drafts");
    expect(within(section).getAllByText("No date yet")).toHaveLength(2);
    expect(within(section).getAllByRole("button", { name: "Delete draft" })).toHaveLength(2);
    fireEvent.click(within(section).getAllByRole("button", { name: "Review and publish" })[0]);
    expect(screen.getByLabelText("Starts")).toHaveValue("");
  });

  it("names this browser's zone for a reopened draft, never one it carried", async () => {
    const api = staffApi({ listEventDrafts: vi.fn().mockResolvedValue([{ id: "z", fields: { title: "Zoned", timezone: "Pacific/Kiritimati" } }]) });
    renderCard({ api });
    fireEvent.click(await screen.findByRole("button", { name: "Review and publish" }));
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(screen.getByText(new RegExp(`^Times are in ${zone.replace(/[/+]/g, "\\$&")}`))).toBeInTheDocument();
    expect(screen.queryByText(/Kiritimati/)).not.toBeInTheDocument();
  });

  it("re-saves an opened draft in place and deletes a draft from the list", async () => {
    const draft = { id: "draft-8", fields: { title: "Unscheduled", eventKind: "deadline" } };
    const api = staffApi({ listEventDrafts: vi.fn().mockResolvedValue([draft]) });
    const { onNotice } = renderCard({ api });
    const section = (await screen.findByText("Staff-only drafts")).closest(".xus-event-drafts");
    expect(within(section).getByText("No date yet")).toBeInTheDocument();
    fireEvent.click(within(section).getByRole("button", { name: "Review and publish" }));
    fireEvent.click(screen.getByRole("button", { name: "Save as staff-only draft" }));
    await waitFor(() => expect(api.saveEventDraft).toHaveBeenCalledWith("draft-8", expect.objectContaining({ title: "Unscheduled", eventKind: "deadline" })));
    await act(async () => {});
    fireEvent.click(within(screen.getByText("Staff-only drafts").closest(".xus-event-drafts")).getByRole("button", { name: "Delete draft" }));
    await waitFor(() => expect(api.deleteEventDraft).toHaveBeenCalledWith("draft-8"));
    expect(onNotice).toHaveBeenCalledWith("Draft deleted.");
  });

  it("keeps listing events when the drafts read fails, and offers no draft button without the functions", async () => {
    const api = staffApi({ listEventDrafts: vi.fn().mockRejectedValue(new Error("missing")) });
    const { view } = renderCard({ api, events: [savedMeeting] });
    await waitFor(() => expect(api.listEventDrafts).toHaveBeenCalled());
    expect(screen.getByText("General meeting")).toBeInTheDocument();
    expect(screen.queryByText("Staff-only drafts")).not.toBeInTheDocument();
    view.unmount();
    renderCard({ api: { createEvent: vi.fn(), updateEvent: vi.fn() } });
    fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
    expect(screen.queryByRole("button", { name: "Save as staff-only draft" })).not.toBeInTheDocument();
  });

  it("round-trips the form through draft fields", () => {
    const form = { ...EMPTY_EVENT, id: "x-meeting", title: "T", startsAt: "2026-11-05T18:30", location: "", rsvpOpen: false, isPublicAcrossAgencies: true, isPublic: true, occurrences: "2" };
    const fields = draftFieldsFromForm(form);
    expect(fields).not.toHaveProperty("location");
    expect(fields).not.toHaveProperty("timezone");
    const back = formFromDraft({ id: "d", fields });
    expect(back).toMatchObject({ draftId: "d", id: "x-meeting", title: "T", startsAt: "2026-11-05T18:30", rsvpOpen: false, isPublic: true, isPublicAcrossAgencies: true, occurrences: "2", location: "" });
    expect(formFromDraft({ id: "e", fields: null })).toMatchObject({ draftId: "e", title: "", rsvpOpen: true });
    expect(formFromDraft({ id: "f", fields: { isPublicAcrossAgencies: true } }).isPublic).toBe(true);
  });
});

describe("event schedule helpers", () => {
  it("tells a past schedule from a future one", () => {
    const now = Date.parse("2026-10-30T16:00:00");
    expect(eventScheduleInPast({ startsAt: "2026-10-30T15:59" }, now)).toBe(true);
    expect(eventScheduleInPast({ startsAt: "2026-10-30T16:01" }, now)).toBe(false);
    expect(eventScheduleInPast({ startsAt: "" }, now)).toBe(false);
    expect(eventScheduleInPast({ eventKind: "deadline", eventDate: "2026-10-29" }, now)).toBe(true);
    expect(eventScheduleInPast({ eventKind: "date_only", eventDate: "2026-10-30" }, now)).toBe(false);
    expect(eventScheduleInPast({ eventKind: "deadline", eventDate: "" }, now)).toBe(false);
  });

  it("names the short zone, or nothing for an invalid time", () => {
    expect(eventTimeZoneLabel("2026-07-01T12:00:00Z", "en", "America/New_York")).toBe("EDT");
    expect(eventTimeZoneLabel("2026-12-01T12:00:00Z", "en", "America/Chicago")).toBe("CST");
    expect(eventTimeZoneLabel("not a date")).toBe("");
  });
});

describe("event saves keep focus while they run (record 8435)", () => {
  it("keeps Save focused while the event is created, and creates it once", async () => {
    const { api } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
    fillMeeting();
    await expectHeldWriteFocus(api.createEvent, screen.getByRole("button", { name: "Save" }));
    expect(api.createEvent).toHaveBeenCalledTimes(1);
  });
});
