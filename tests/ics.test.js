// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildIcsCalendar, formatIcsEvent } from "../src/lib/ics.js";

const event = {
  id: "evt-2026-chapter-meeting",
  title: "Chapter meeting; vote, then Q&A",
  startsAt: "2026-07-30T18:00:00Z",
  location: "Boston office hall + Zoom",
  summary: "Line 1\nLine 2, with a comma; and a semicolon",
};

const fixedNow = new Date("2026-07-23T12:00:00Z");

describe("ics formatting", () => {
  it("formats the start without inventing an end", () => {
    const vevent = formatIcsEvent(event, { now: fixedNow });
    expect(vevent).toContain("DTSTART:20260730T180000Z");
    expect(vevent).not.toContain("DTEND");
    expect(vevent).toContain("DTSTAMP:20260723T120000Z");
    expect(vevent).toContain("UID:evt-2026-chapter-meeting@unionground.invalid");
  });

  it("emits a LOCATION line from the event's location through the real formatter", () => {
    // The view-level ICS tests mock downloadEventIcs, so only this suite
    // proves the writer itself still carries the meeting place end to end.
    const vevent = formatIcsEvent(event, { now: fixedNow });
    expect(vevent).toContain("LOCATION:Boston office hall + Zoom");
  });

  it("escapes semicolons, commas, and newlines in text fields", () => {
    const vevent = formatIcsEvent(event, { now: fixedNow });
    expect(vevent).toContain("SUMMARY:Chapter meeting\\; vote\\, then Q&A");
    expect(vevent).toContain("DESCRIPTION:Line 1\\nLine 2\\, with a comma\\; and a semicolon");
  });

  it("wraps N events in exactly one VCALENDAR with CRLF line endings", () => {
    const ics = buildIcsCalendar([event, { ...event, id: "evt-2" }], { now: fixedNow });
    expect(ics.match(/BEGIN:VCALENDAR/g)).toHaveLength(1);
    expect(ics.match(/END:VCALENDAR/g)).toHaveLength(1);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0")).toBe(true);
    expect(ics).toContain("PRODID:-//UnionGround//Union Workspace//EN");
    expect(ics.includes("\r\n")).toBe(true);
    // No bare \n outside the escaped literals: every line break is CRLF.
    expect(ics.replace(/\r\n/g, "").includes("\n")).toBe(false);
  });

  it("escapes a lone carriage return like any other line break", () => {
    const vevent = formatIcsEvent({ ...event, title: "foo\rbar", summary: "a\r\nb\rc\nd" }, { now: fixedNow });
    expect(vevent).toContain("SUMMARY:foo\\nbar");
    expect(vevent).toContain("DESCRIPTION:a\\nb\\nc\\nd");
    // No raw CR survives outside CRLF line breaks — a strict parser would
    // treat it as a line boundary and split the value.
    expect(vevent.replace(/\r\n/g, "").includes("\r")).toBe(false);
  });

  it("folds content lines longer than 75 octets and stays reconstructible", () => {
    const chunk = "Union Ground quarterly all-campaign méeting agenda — ";
    const vevent = formatIcsEvent({ ...event, summary: chunk.repeat(8) }, { now: fixedNow });
    const utf8 = new TextEncoder();
    for (const line of vevent.split("\r\n")) {
      // Octets, not chars: the multi-byte é/— force a char-counting fold to
      // overflow 75 octets, so this pins the encoder-based measurement.
      expect(utf8.encode(line).length).toBeLessThanOrEqual(75);
    }
    // Unfolding (strip CRLF + space) restores the value byte-for-byte.
    expect(vevent.replace(/\r\n /g, "")).toContain(`DESCRIPTION:${chunk.repeat(8)}`);
  });

  it("accepts snake_case rows from the feed RPC (starts_at)", () => {
    const vevent = formatIcsEvent({ ...event, startsAt: undefined, starts_at: "2026-07-30T18:00:00Z" }, { now: fixedNow });
    expect(vevent).toContain("DTSTART:20260730T180000Z");
  });
});

it('exports the recorded end and represents deadlines as DATE values', () => {
  expect(formatIcsEvent({ ...event, endsAt: '2026-07-30T19:15:00Z' }, { now: fixedNow })).toContain('DTEND:20260730T191500Z');
  const deadline = formatIcsEvent({ ...event, startsAt: null, eventKind: 'deadline', eventDate: '2026-07-30' }, { now: fixedNow });
  expect(deadline).toContain('DTSTART;VALUE=DATE:20260730');
  expect(deadline).not.toContain('DTEND');
});
