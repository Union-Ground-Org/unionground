// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  normalizeProviderEvents,
  providerSupportsEventImport,
} from "../src/features/calendarFreeBusy/imports.js";

describe("opaque calendar imports", () => {
  it("requires an explicitly consented event-read scope", () => {
    expect(providerSupportsEventImport("google", "https://www.googleapis.com/auth/calendar.freebusy")).toBe(false);
    expect(providerSupportsEventImport("google", "https://www.googleapis.com/auth/calendar.readonly")).toBe(true);
    expect(providerSupportsEventImport("microsoft", "offline_access Calendars.ReadBasic")).toBe(true);
    expect(providerSupportsEventImport("unknown", "Calendars.Read")).toBe(false);
  });

  it("normalizes Google events without retaining protected provider content", () => {
    const events = normalizeProviderEvents("google", {
      items: [{
        id: "provider-event-id",
        summary: "Private appointment title",
        attendees: [{ email: "person@example.org" }],
        location: "Private office",
        start: { dateTime: "2026-09-01T13:00:00-04:00" },
        end: { dateTime: "2026-09-01T14:00:00-04:00" },
        updated: "2026-08-30T12:00:00Z",
      }],
    }, () => "a".repeat(64));
    expect(events).toEqual([{
      eventKey: "a".repeat(64),
      startsAt: "2026-09-01T17:00:00.000Z",
      endsAt: "2026-09-01T18:00:00.000Z",
      allDay: false,
      sourceUpdatedAt: "2026-08-30T12:00:00.000Z",
    }]);
    expect(JSON.stringify(events)).not.toMatch(/Private|person@example|location|summary|attendees/i);
  });

  it("normalizes Microsoft UTC and all-day values and rejects malformed ranges", () => {
    expect(normalizeProviderEvents("microsoft", { value: [{
      id: "event-2",
      start: { dateTime: "2026-09-02T00:00:00" },
      end: { dateTime: "2026-09-03T00:00:00" },
      isAllDay: true,
    }] }, () => "b".repeat(64))).toEqual([
      expect.objectContaining({
        startsAt: "2026-09-02T00:00:00.000Z",
        endsAt: "2026-09-03T00:00:00.000Z",
        allDay: true,
      }),
    ]);
    expect(() => normalizeProviderEvents("google", { items: [{
      id: "bad", start: { dateTime: "2026-09-02T02:00:00Z" },
      end: { dateTime: "2026-09-02T01:00:00Z" },
    }] }, () => "c".repeat(64))).toThrow("calendar_import_parse_failed");
  });
});
