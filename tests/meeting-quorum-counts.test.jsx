// REQ-UG-MEETING-QUORUM-COUNTS-20261030 (#6629): an optional quorum
// on a meeting, set by staff, and the checked-in count toward it shown to
// staff on the Events desk and to members at the meeting. Aggregate numbers
// only; the live proof of the gate and the counts is
// tests/meeting-quorum-counts-db.test.js.
import { readdirSync, readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectHeldWriteFocus, expectPendingFocus } from "./helpers/busyWriteFocus.js";
import { openPastEvents } from "./helpers/openPastEvents.js";
import { EventAuthoringCard } from "../src/components/EventAuthoringCard.jsx";
import { meetingUnderWay, nextQuorumBoundary, QUORUM_REFRESH_MS, QuorumEditor, QuorumLine, useEventQuorum } from "../src/components/EventQuorum.jsx";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { t } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { loadMemberEventQuorum, setMemberEventQuorum } from "../src/lib/memberApi.js";
import { EventsView } from "../src/views/EventsView.jsx";

const MIGRATION = "supabase/migrations/20261030224500_meeting_quorum_counts.sql";
const STARTS = "2026-07-30T18:00:00Z";
const meeting = {
  id: "member-meeting", title: "Member meeting", startsAt: STARTS, eventKind: "meeting",
  startsLabel: "Jul 30, 2 PM", location: "Union hall", summary: "Updates", checkInCode: "SG-MEET",
  isPublic: false, isPublicAcrossAgencies: false, chapterName: "Cedar Ridge Care Services", rsvpCount: 4, checkinCount: 12,
};
const rally = { ...meeting, id: "rally", title: "Rally", eventKind: "action" };
const cancelled = { ...meeting, id: "cancelled", title: "Cancelled meeting", cancelledAt: "2026-07-29T12:00:00Z" };

afterEach(() => {
  clearDeviceParityState();
  vi.useRealTimers();
});

function inLang(lang, node) {
  return <LanguageProvider lang={lang}>{node}</LanguageProvider>;
}

describe("quorum copy", () => {
  it("reads the count and the reached state in English and Spanish", () => {
    expect(t("en", "eventQuorum.count", { present: 12, quorum: 20 })).toBe("12 of 20 for quorum");
    expect(t("es", "eventQuorum.count", { present: 12, quorum: 20 })).toBe("12 de 20 para el quórum");
    expect(t("en", "eventQuorum.reached", { present: 21, quorum: 20 })).toBe("Quorum reached: 21 of 20");
    expect(t("es", "eventQuorum.reached", { present: 21, quorum: 20 })).toBe("Quórum alcanzado: 21 de 20");
    for (const key of ["label", "help", "save", "saveNamed", "saved", "cleared", "failed", "invalid"]) {
      const english = t("en", `eventQuorum.${key}`, { title: "X" });
      const spanish = t("es", `eventQuorum.${key}`, { title: "X" });
      expect(english).not.toBe(`eventQuorum.${key}`);
      expect(spanish).not.toBe(english);
    }
  });

  it("shows nothing without a quorum and the two numbers with one", () => {
    const { rerender } = render(inLang("en", <QuorumLine status={null} />));
    expect(screen.queryByRole("status")).toBeNull();
    rerender(inLang("en", <QuorumLine status={{ quorum: null, checkedIn: 3 }} />));
    expect(screen.queryByRole("status")).toBeNull();
    rerender(inLang("es", <QuorumLine status={{ quorum: 20, checkedIn: 12 }} />));
    expect(screen.getByRole("status")).toHaveTextContent("12 de 20 para el quórum");
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    rerender(inLang("en", <QuorumLine status={{ quorum: 20, checkedIn: 20 }} />));
    expect(screen.getByRole("status")).toHaveTextContent("Quorum reached: 20 of 20");
  });
});

describe("meeting check-in window", () => {
  it("runs from an hour before the start to four hours after, or the later end", () => {
    const start = Date.parse(STARTS);
    const hour = 60 * 60 * 1000;
    expect(meetingUnderWay(meeting, start - hour - 1)).toBe(false);
    expect(meetingUnderWay(meeting, start - hour)).toBe(true);
    expect(meetingUnderWay(meeting, start + 4 * hour)).toBe(true);
    expect(meetingUnderWay(meeting, start + 4 * hour + 1)).toBe(false);
    expect(meetingUnderWay({ ...meeting, endsAt: new Date(start + 6 * hour).toISOString() }, start + 5 * hour)).toBe(true);
    expect(meetingUnderWay({ ...meeting, startsAt: null }, start)).toBe(false);
  });

  it("names the next moment a window opens or closes", () => {
    const start = Date.parse(STARTS);
    const hour = 60 * 60 * 1000;
    const later = { ...meeting, id: "later", startsAt: new Date(start + 24 * hour).toISOString() };
    expect(nextQuorumBoundary([later, meeting], start - 3 * hour)).toBe(start - hour);
    expect(nextQuorumBoundary([later, meeting], start)).toBe(start + 4 * hour + 1);
    expect(nextQuorumBoundary([later, meeting], start + 5 * hour)).toBe(start + 23 * hour);
    expect(nextQuorumBoundary([meeting, { ...meeting, startsAt: null }], start + 5 * hour)).toBeNull();
    expect(nextQuorumBoundary([], start)).toBeNull();
  });
});

function HookProbe({ load, events }) {
  const { byId } = useEventQuorum(load, events);
  return <QuorumLine status={byId.get(meeting.id)} />;
}

describe("useEventQuorum", () => {
  it.each([
    ["en", "12 of 20 for quorum", "The count may be out of date.", "13 of 20 for quorum"],
    ["es", "12 de 20 para el quórum", "El recuento puede estar desactualizado.", "13 de 20 para el quórum"],
  ])("marks the last count stale after a failed refresh and clears the warning on success in %s", async (lang, previous, stale, updated) => {
    vi.useFakeTimers({ now: Date.parse(STARTS) });
    const load = vi.fn()
      .mockResolvedValueOnce(new Map([[meeting.id, { quorum: 20, checkedIn: 12 }]]))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Map([[meeting.id, { quorum: 20, checkedIn: 13 }]]));
    render(inLang(lang, <HookProbe load={load} events={[meeting, rally]} />));
    await act(async () => {});
    expect(load).toHaveBeenCalledWith([meeting.id]);
    expect(screen.getByRole("status")).toHaveTextContent(previous);
    expect(screen.getByRole("status")).not.toHaveTextContent(stale);
    await act(async () => { await vi.advanceTimersByTimeAsync(QUORUM_REFRESH_MS); });
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent(previous);
    expect(screen.getByRole("status")).toHaveTextContent(stale);
    await act(async () => { await vi.advanceTimersByTimeAsync(QUORUM_REFRESH_MS); });
    expect(screen.getByRole("status")).toHaveTextContent(updated);
    expect(screen.getByRole("status")).not.toHaveTextContent(stale);
  });

  it("starts live re-reads when a window opens on a desk left open, for the live meetings only, and stops when it closes", async () => {
    const start = Date.parse(STARTS);
    const hour = 60 * 60 * 1000;
    vi.useFakeTimers({ now: start - 2 * hour });
    const tomorrow = { ...meeting, id: "tomorrow", startsAt: new Date(start + 24 * hour).toISOString() };
    const load = vi.fn().mockResolvedValue(new Map([[meeting.id, { quorum: 20, checkedIn: 1 }]]));
    render(inLang("en", <HookProbe load={load} events={[meeting, tomorrow]} />));
    await act(async () => {});
    expect(load.mock.calls).toEqual([[[meeting.id, tomorrow.id]]]);
    await act(async () => { await vi.advanceTimersByTimeAsync(hour - 1); });
    expect(load).toHaveBeenCalledTimes(1);
    load.mockResolvedValue(new Map([[meeting.id, { quorum: 20, checkedIn: 7 }]]));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => { await vi.advanceTimersByTimeAsync(QUORUM_REFRESH_MS); });
    expect(load).toHaveBeenLastCalledWith([meeting.id]);
    expect(screen.getByRole("status")).toHaveTextContent("7 of 20 for quorum");
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * hour); });
    await act(async () => {});
    const calls = load.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(QUORUM_REFRESH_MS * 4); });
    expect(load).toHaveBeenCalledTimes(calls);
  });

  it("drops a meeting whose quorum a later read no longer returns", async () => {
    vi.useFakeTimers({ now: Date.parse(STARTS) });
    const load = vi.fn()
      .mockResolvedValueOnce(new Map([[meeting.id, { quorum: 20, checkedIn: 12 }]]))
      .mockResolvedValue(new Map());
    render(inLang("en", <HookProbe load={load} events={[meeting]} />));
    await act(async () => {});
    expect(screen.getByRole("status")).toHaveTextContent("12 of 20 for quorum");
    await act(async () => { await vi.advanceTimersByTimeAsync(QUORUM_REFRESH_MS); });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("reads once when no meeting is under way, and not at all without a loader", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-07-01T12:00:00Z") });
    const load = vi.fn().mockResolvedValue(new Map());
    const { rerender } = render(inLang("en", <HookProbe load={load} events={[meeting]} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(QUORUM_REFRESH_MS * 3); });
    expect(load).toHaveBeenCalledTimes(1);
    rerender(inLang("en", <HookProbe load={null} events={[meeting]} />));
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("drops a read that a newer one overtook", async () => {
    let resolveFirst;
    const load = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(new Map([[meeting.id, { quorum: 20, checkedIn: 15 }]]));
    const { rerender } = render(inLang("en", <HookProbe load={load} events={[meeting]} />));
    rerender(inLang("en", <HookProbe load={load} events={[meeting, { ...meeting, id: "second" }]} />));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("15 of 20 for quorum"));
    await act(async () => { resolveFirst(new Map([[meeting.id, { quorum: 20, checkedIn: 2 }]])); });
    expect(screen.getByRole("status")).toHaveTextContent("15 of 20 for quorum");
  });
});

describe("QuorumEditor", () => {
  it("refuses a non-whole or out-of-range figure, saves a valid one and clears on blank", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(inLang("en", <QuorumEditor event={meeting} quorum={null} onSave={onSave} />));
    const input = screen.getByLabelText("Quorum (workers needed present)");
    const save = screen.getByRole("button", { name: "Save quorum for Member meeting" });
    expect(save).toBeDisabled();
    for (const bad of ["0", "2.5", "100001"]) {
      fireEvent.change(input, { target: { value: bad } });
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByText("Enter a whole number from 1 to 100,000, or leave it blank.")).toBeInTheDocument();
      expect(save).toBeDisabled();
    }
    fireEvent.change(input, { target: { value: "20" } });
    expect(input).not.toHaveAttribute("aria-invalid");
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(meeting.id, 20));
    rerender(inLang("en", <QuorumEditor event={meeting} quorum={20} onSave={onSave} />));
    expect(input).toHaveValue(20);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(meeting.id, null));
  });

  it("says so when the save fails", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("denied"));
    render(inLang("es", <QuorumEditor event={meeting} quorum={null} onSave={onSave} />));
    fireEvent.change(screen.getByLabelText("Quórum (trabajadores que deben estar presentes)"), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar quórum de Member meeting" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo guardar el quórum. Inténtalo de nuevo.");
  });
});

describe("staff Events desk", () => {
  function renderDesk(api) {
    const onNotice = vi.fn();
    render(inLang("en", <EventAuthoringCard events={[meeting, rally, cancelled]} api={api} onNotice={onNotice} reload={vi.fn()} chapterName="Cedar Ridge Care Services" />));
    openPastEvents();
    return onNotice;
  }


  // REQ-UG-LEARNING-PERIOD-EVENTS-20261103: a
  // quorum save bumps the event's version, so an open agenda editor adopts it
  // and the list is re-read; the next save is not refused as changed.

  // Gate round 3 on #7029: after another tab's undo the open forms are
  // stale; a quorum save must not hand them a version that hides that.
  it.each([
    ["agenda", async () => {
      fireEvent.change(screen.getByRole("textbox", { name: "Agenda" }), { target: { value: "1. Roll call" } });
      fireEvent.click(screen.getByRole("button", { name: "Save agenda" }));
    }, "Add agenda"],
    ["edit", async () => {
      fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Member meeting, revised" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    }, "Edit"],
  ])("keeps a stale %s form's own version after an undo in another tab, so its save is refused", async (_label, save, open) => {
    const api = {
      loadEventQuorum: vi.fn().mockResolvedValue(new Map()),
      // Version 8 when the form opened; another tab's undo made it 9; this save made it 10.
      setEventQuorum: vi.fn().mockResolvedValue({ changed: true, version: 10 }),
      setEventAgenda: vi.fn().mockResolvedValue({ updated: true, agenda: "1. Roll call", version: 11 }),
      updateEvent: vi.fn().mockResolvedValue({ updated: true, version: 11 }),
    };
    render(inLang("en", <EventAuthoringCard events={[{ ...meeting, version: 8 }]} api={api} onNotice={vi.fn()} reload={vi.fn()} chapterName="Cedar Ridge Care Services" />));
    openPastEvents();
    fireEvent.click(screen.getByRole("button", { name: open }));
    fireEvent.change(screen.getByLabelText("Quorum (workers needed present)"), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "Save quorum for Member meeting" }));
    await waitFor(() => expect(api.setEventQuorum).toHaveBeenCalled());
    await save();
    if (open === "Edit") await waitFor(() => expect(api.updateEvent).toHaveBeenCalledWith(meeting.id, expect.objectContaining({ expectedVersion: 8 })));
    else await waitFor(() => expect(api.setEventAgenda).toHaveBeenCalledWith(meeting.id, "1. Roll call", 8));
  });



});

describe("member Events view", () => {
  it("shows the aggregate count on the next meeting's check-in card, with no quorum control", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-30T17:30:00Z") });
    const loadEventQuorum = vi.fn().mockResolvedValue(new Map([[meeting.id, { quorum: 20, checkedIn: 12 }]]));
    const data = {
      member: { initials: "PR" },
      events: [{ ...meeting, dateLabel: "Thu, Jul 30", timeLabel: "2:00 PM", rsvpStatus: "going", checkedIn: false, checkInOffered: true }],
      rewardsCatalog: { rules: [] },
    };
    render(inLang("es", <EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} loadEventQuorum={loadEventQuorum} />));
    expect(await screen.findByText("12 de 20 para el quórum")).toBeInTheDocument();
    expect(loadEventQuorum).toHaveBeenCalledWith([meeting.id]);
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  it("keeps the count after the member checks in and asks only about meetings still ahead", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-30T18:30:00Z") });
    const loadEventQuorum = vi.fn().mockResolvedValue(new Map([[meeting.id, { quorum: 20, checkedIn: 13 }]]));
    const past = { ...meeting, id: "last-month", title: "Last month", startsAt: "2026-06-30T18:00:00Z", isPast: true, dateLabel: "Tue, Jun 30", timeLabel: "2:00 PM" };
    const data = {
      member: { initials: "PR" },
      events: [past, { ...meeting, dateLabel: "Thu, Jul 30", timeLabel: "2:00 PM", rsvpStatus: "going", checkedIn: true, checkInOffered: true }],
      rewardsCatalog: { rules: [] },
    };
    render(inLang("en", <EventsView data={data} onRsvp={vi.fn()} onCheckIn={vi.fn()} loadEventQuorum={loadEventQuorum} />));
    expect(await screen.findByText("13 of 20 for quorum")).toBeInTheDocument();
    expect(loadEventQuorum.mock.calls).toEqual([[[meeting.id]]]);
  });
});

describe("quorum client calls", () => {
  it("writes a whole number or null and reads the two numbers per meeting", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { id: meeting.id, quorum: 20, changed: true }, error: null })
      .mockResolvedValueOnce({ data: { id: meeting.id, quorum: null, changed: true }, error: null })
      .mockResolvedValueOnce({ data: [
        { eventId: meeting.id, quorum: 20, checkedIn: 12 },
        { eventId: "bad", quorum: "20", checkedIn: 1 },
      ], error: null });
    await setMemberEventQuorum({ rpc }, meeting.id, 20);
    await setMemberEventQuorum({ rpc }, meeting.id, 2.5);
    const map = await loadMemberEventQuorum({ rpc }, [meeting.id, meeting.id, "", null, "bad"]);
    expect(rpc).toHaveBeenNthCalledWith(1, "set_member_event_quorum", { p_id: meeting.id, p_quorum: 20 });
    expect(rpc).toHaveBeenNthCalledWith(2, "set_member_event_quorum", { p_id: meeting.id, p_quorum: null });
    expect(rpc).toHaveBeenNthCalledWith(3, "get_member_event_quorum", { p_event_ids: [meeting.id, "bad"] });
    expect([...map]).toEqual([[meeting.id, { quorum: 20, checkedIn: 12 }]]);
  });

  it("skips the read without ids, sends more than 200 in batches, and surfaces errors", async () => {
    const rpc = vi.fn(async (_name, { p_event_ids: batch }) => ({
      data: batch.map((eventId) => ({ eventId, quorum: 5, checkedIn: 1 })), error: null,
    }));
    expect((await loadMemberEventQuorum({ rpc }, [])).size).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
    const many = Array.from({ length: 450 }, (_, index) => `e${index}`);
    const map = await loadMemberEventQuorum({ rpc }, many);
    expect(rpc.mock.calls.map(([, args]) => args.p_event_ids.length)).toEqual([200, 200, 50]);
    expect([...map.keys()]).toEqual(many);
    const failing = vi.fn().mockResolvedValue({ data: null, error: { message: "staff role required", code: "42501" } });
    await expect(setMemberEventQuorum({ rpc: failing }, meeting.id, 5)).rejects.toThrow();
    await expect(loadMemberEventQuorum({ rpc: failing }, [meeting.id])).rejects.toThrow();
  });
});

describe("quorum control styles", () => {
  it("gives the quorum field and its Save button the 48px touch target", () => {
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toContain(".xus-quorum-form .xus-input, .xus-quorum-form .xus-btn { min-height: 48px; }");
    expect(css.match(/\.xus-quorum-form[^{]*\{[^}]*\}/g).join("\n")).not.toMatch(/min-height:\s*(?![4-9]\d|\d{3})\d+px/);
  });
});

describe("quorum migration", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  // Admission order, not "sorts last": that holds only until the next
  // migration merges, and then fails every later pull request's merged
  // coverage run. This migration was written to land after
  // 20261030223000; MAIN admits migrations in stamp order.
  it("exists and sorts after the migration it was written against", () => {
    const names = readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).sort();
    const own = MIGRATION.split("/").at(-1);
    expect(names).toContain(own);
    expect(own > "20261030223000").toBe(true);
  });

  it("keeps the column off every client grant and bounds it", () => {
    expect(sql).toMatch(/add column quorum_count integer/);
    expect(sql).toMatch(/check \(quorum_count is null or quorum_count between 1 and 100000\)/);
    expect(sql).not.toMatch(/grant [^;]*\(quorum_count/i);
    expect(sql).not.toMatch(/grant (select|update|insert)[^;]*member_events/i);
  });

  it("gates the write on staff, two-step sign-in and the caller's chapter, and audits it", () => {
    const writer = sql.slice(sql.indexOf("create function public.set_member_event_quorum"), sql.indexOf("create function public.get_member_event_quorum"));
    expect(writer).toMatch(/security definer\s+set search_path = ''/);
    expect(writer).toMatch(/as \$function\$\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);/);
    expect(writer).toContain("private.mfa_satisfied()");
    expect(writer).toContain("private.member_can_manage_events()");
    expect(writer).toContain("where id = p_id and chapter_id = caller_chapter\n  for update");
    expect(writer).toContain("'only a meeting takes a quorum'");
    expect(writer).toMatch(/insert into public\.member_admin_audit \(actor, action, detail\)\s+values \(caller, 'update_event'/);
    expect(writer).toContain("revoke all on function public.set_member_event_quorum(text, integer) from public, anon, authenticated, service_role;");
    expect(writer).toContain("grant execute on function public.set_member_event_quorum(text, integer) to authenticated;");
  });

  it("returns only the quorum and the count for meetings the caller can see", () => {
    const reader = sql.slice(sql.indexOf("create function public.get_member_event_quorum"));
    expect(reader).toMatch(/stable\s+security definer\s+set search_path = ''/);
    expect(reader).toContain("private.mfa_satisfied()");
    expect(reader).toContain("pg_catalog.cardinality(p_event_ids) > 200");
    expect(reader).toContain("event_chapter.organization_id = org");
    expect(reader).toContain("coalesce(e.is_public_across_agencies, false)");
    const shape = reader.slice(reader.indexOf("jsonb_build_object("), reader.indexOf("order by e.id"));
    expect(shape.match(/'[a-zA-Z]+',/g)).toEqual(["'eventId',", "'quorum',", "'checkedIn',"]);
    expect(reader).not.toMatch(/user_id|full_name|display_name/);
    expect(reader).toContain("grant execute on function public.get_member_event_quorum(text[]) to authenticated;");
  });
});

describe("QuorumEditor keeps focus while it saves (record 8435)", () => {
  it("keeps Save quorum focused while the figure is saved, and saves it once", async () => {
    const onSave = vi.fn(async () => undefined);
    render(inLang("en", <QuorumEditor event={meeting} quorum={null} onSave={onSave} />));
    fireEvent.change(screen.getByLabelText("Quorum (workers needed present)"), { target: { value: "20" } });
    await expectHeldWriteFocus(onSave, screen.getByRole("button", { name: "Save quorum for Member meeting" }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("keeps the quorum field focusable while the event card's own write runs", async () => {
    render(inLang("en", <QuorumEditor event={meeting} quorum={20} onSave={vi.fn()} pending />));
    await expectPendingFocus(screen.getByLabelText("Quorum (workers needed present)"));
  });
});
