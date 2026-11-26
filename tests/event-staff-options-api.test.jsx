// REQ-UG-EVENTS-RSVP-CHECK-IN-AND-VISIBILITY-20261030: the staff RSVP
// switch and draft functions, the member read of rsvp_open with its
// pre-migration fallback, the member RSVP control, and the refusal token.
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEMBER_EVENT_COLUMNS,
  createAdminEvent,
  deleteAdminEventDraft,
  fetchMemberEventsForChapter,
  listAdminEventDrafts,
  loadAuthorizedCalendarEvent,
  saveAdminEventDraft,
  setAdminEventRsvpOpen,
} from "../src/lib/memberApi.js";
import { rpcErrorText } from "../src/lib/rpcErrorText.js";
import { EventsView } from "../src/views/EventsView.jsx";

function eventsBackend({ missing = null, rsvpOpen } = {}) {
  const calls = [];
  const client = { from(table) {
    const call = { table, columns: null };
    calls.push(call);
    const query = {
      select(columns) { call.columns = columns; return query; },
      eq() { return query; }, neq() { return query; }, gte() { return query; }, or() { return query; },
      order() { return query; }, range() { return query; }, limit() { return query; },
      maybeSingle() { call.single = true; return query; },
      then(resolve) {
        const columns = String(call.columns || "").split(",");
        const error = table === "member_events" && missing && columns.includes(missing)
          ? { code: "42703", message: `column member_events.${missing} does not exist` } : null;
        const row = { id: "meeting", title: "Meeting", chapter_id: "chapter", starts_at: "2026-11-05T22:00:00Z", event_kind: "meeting",
          ...(columns.includes("rsvp_open") && rsvpOpen !== undefined ? { rsvp_open: rsvpOpen } : {}) };
        const data = error ? null : table !== "member_events" ? null : call.single ? row : [row];
        return Promise.resolve({ error, data }).then(resolve);
      },
    };
    return query;
  } };
  return { client, calls };
}

describe("staff RSVP switch and drafts API", () => {
  it("calls the four functions with their exact arguments", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true }, error: null });
    await setAdminEventRsvpOpen({ rpc }, "meeting", false);
    await setAdminEventRsvpOpen({ rpc }, "meeting", "yes");
    await listAdminEventDrafts({ rpc });
    await saveAdminEventDraft({ rpc }, "", { title: "T" });
    await saveAdminEventDraft({ rpc }, "draft-1", { title: "T" });
    await deleteAdminEventDraft({ rpc }, "draft-1");
    expect(rpc.mock.calls).toEqual([
      ["set_member_event_rsvp_open", { p_id: "meeting", p_open: false }],
      ["set_member_event_rsvp_open", { p_id: "meeting", p_open: false }],
      ["list_member_event_drafts"],
      ["save_member_event_draft", { p_draft_id: null, p_fields: { title: "T" } }],
      ["save_member_event_draft", { p_draft_id: "draft-1", p_fields: { title: "T" } }],
      ["delete_member_event_draft", { p_draft_id: "draft-1" }],
    ]);
  });

  // Gate finding r4s1 on #7029: the switch carries an expected version, and
  // until 20261106120000 is applied the same switch goes once without it.
  it("sends the switch's expected version, and never resends it without the version (#8960)", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { updated: true, version: 4 }, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "missing" } })
      // What hosted answers since 20261106220000: HTTP 409, PT409, never retried.
      .mockResolvedValueOnce({ data: null, error: { code: "PT409", message: "this event changed; reload it before saving", details: "event_changed" }, status: 409 })
      .mockResolvedValue({ data: { updated: true }, error: null });
    await expect(setAdminEventRsvpOpen({ rpc }, "meeting", false, 3)).resolves.toMatchObject({ version: 4 });
    await expect(setAdminEventRsvpOpen({ rpc }, "meeting", true, 5)).rejects.toMatchObject({ code: "PGRST202" });
    await expect(setAdminEventRsvpOpen({ rpc }, "meeting", true, 6)).rejects.toMatchObject({ code: "PT409", details: "event_changed" });
    expect(rpc.mock.calls).toEqual([
      ["set_member_event_rsvp_open", { p_id: "meeting", p_open: false, p_expected_version: 3 }],
      ["set_member_event_rsvp_open", { p_id: "meeting", p_open: true, p_expected_version: 5 }],
      ["set_member_event_rsvp_open", { p_id: "meeting", p_open: true, p_expected_version: 6 }],
    ]);
  });

  it("creates an event with RSVPs off through the one-transaction function", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "meeting", created: true }, error: null });
    const base = { id: "meeting", title: "Meeting", startsAt: "2026-11-05T22:00:00Z", location: "Hall", summary: "Agenda" };
    await createAdminEvent({ rpc }, { ...base, rsvpOpen: false });
    await createAdminEvent({ rpc }, { ...base, rsvpOpen: true });
    expect(rpc.mock.calls[0][0]).toBe("create_member_event_with_rsvp");
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_id: "meeting", p_kind: "meeting", p_occurrences: 1, p_rsvp_open: false });
    expect(rpc.mock.calls[1][0]).toBe("create_member_event");
    expect(rpc.mock.calls[1][1]).not.toHaveProperty("p_rsvp_open");
  });

  it("explains a missing one-transaction function instead of creating an open event", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202", message: "missing" } });
    await expect(createAdminEvent({ rpc }, { id: "meeting", title: "Meeting", startsAt: "2026-11-05T22:00:00Z", location: "Hall", summary: "Agenda", rsvpOpen: false }))
      .rejects.toThrow("This feature needs the database update");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("surfaces a refused write", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "42501", message: "staff role required" } });
    await expect(setAdminEventRsvpOpen({ rpc }, "meeting", true)).rejects.toThrow();
    await expect(listAdminEventDrafts({ rpc })).rejects.toThrow();
  });

  it("translates the rsvp_closed refusal", () => {
    const t = (key) => key;
    expect(rpcErrorText(t, { details: "rsvp_closed", message: "this event is not collecting RSVPs" })).toBe("rpcError.rsvp_closed");
  });
});

describe("member read of the RSVP switch", () => {
  it("reads rsvp_open and maps a closed event", async () => {
    expect(MEMBER_EVENT_COLUMNS.split(",")).toContain("rsvp_open");
    const { client } = eventsBackend({ rsvpOpen: false });
    const event = await loadAuthorizedCalendarEvent(client, "meeting", "user-1");
    expect(event.rsvpOpen).toBe(false);
  });

  it("retries once without rsvp_open before the migration and treats the event as open", async () => {
    const { client, calls } = eventsBackend({ missing: "rsvp_open" });
    const event = await loadAuthorizedCalendarEvent(client, "meeting", "user-1");
    expect(event.rsvpOpen).toBe(true);
    const reads = calls.filter((call) => call.table === "member_events").map((call) => call.columns.split(","));
    expect(reads).toHaveLength(2);
    expect(reads[0]).toContain("rsvp_open");
    expect(reads[1]).not.toContain("rsvp_open");
    expect(reads[1]).toContain("check_in_offered");
  });

  it("drops both new columns when check_in_offered is missing", async () => {
    const { client } = eventsBackend({ missing: "check_in_offered" });
    const result = await fetchMemberEventsForChapter(client, "chapter");
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(1);
  });
});

describe("member RSVP control", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-30T12:00:00Z") }));
  afterEach(() => vi.useRealTimers());
  const base = { id: "evt-1", title: "Chapter meeting", startsAt: "2026-07-30T18:00:00Z", dateLabel: "Thu, Jul 30", timeLabel: "6:00 PM", location: "Hall", summary: "Update.", chapterName: "Cedar Ridge Care Services", rsvpStatus: null, checkedIn: false, checkInOffered: true };

  it("says RSVPs are off instead of offering the button", () => {
    render(<EventsView data={{ member: { initials: "PR" }, events: [{ ...base, rsvpOpen: false }] }} onRsvp={vi.fn()} onCheckIn={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^RSVP/ })).toBeNull();
    expect(screen.getAllByText("Not collecting RSVPs").length).toBeGreaterThan(0);
  });

  it("still lets a member who said yes withdraw", () => {
    render(<EventsView data={{ member: { initials: "PR" }, events: [{ ...base, rsvpOpen: false, rsvpStatus: "going" }] }} onRsvp={vi.fn()} onCheckIn={vi.fn()} />);
    expect(screen.getAllByRole("button", { name: "Going ✓" }).length).toBeGreaterThan(0);
  });
});
