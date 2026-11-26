import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { easternDay as calendarDay, nextEasternMidnight as calendarMidnight } from "../src/lib/easternCalendar.js";
import {
  EASTERN_TIME_ZONE,
  addEasternDays,
  easternDay,
  easternMidnight,
  easternZoneLabel,
  formatEasternInstant,
  nextEasternMidnight,
} from "../src/lib/easternTime.js";
import { formatEasternTimestamp } from "../src/lib/easternTimestamp.js";
import {
  checkEasternTime,
  countUnlabelledTimes,
  easternTimeFindings,
  sessionDayReads,
} from "../scripts/lib/eastern-time-scan.mjs";
import { EASTERN_DAY_CASES, EASTERN_INSTANTS, atEasternInstant, inDeviceZone } from "./helpers/easternClock.js";

const { evening, daylightEvening, lastMinute, springForward, fallBack } = EASTERN_INSTANTS;
const HOUR = 3_600_000;

describe("the shared Eastern-time module", () => {
  it("counts the Eastern day, not the UTC day, in the evening", () => {
    for (const [at, day] of EASTERN_DAY_CASES) expect(easternDay(at)).toBe(day);
    expect(easternDay(evening.at)).not.toBe(evening.utcDay);
    expect(easternDay(daylightEvening.at)).not.toBe(daylightEvening.utcDay);
    expect(easternDay(new Date(lastMinute.at))).toBe("2026-11-12");
    expect(easternDay("not a date")).toBeNull();
    expect(easternDay(undefined)).toBeNull();
  });

  it("labels an Eastern instant EST or EDT", () => {
    expect(easternZoneLabel(evening.at)).toBe("EST");
    expect(easternZoneLabel(daylightEvening.at)).toBe("EDT");
    expect(easternZoneLabel(springForward.before)).toBe("EST");
    expect(easternZoneLabel(springForward.after)).toBe("EDT");
    expect(easternZoneLabel(fallBack.before)).toBe("EDT");
    expect(easternZoneLabel(fallBack.after)).toBe("EST");
    expect(easternZoneLabel("")).toBeNull();
  });

  it("formats an instant with its zone in both languages", () => {
    expect(formatEasternInstant(evening.at)).toBe("Nov 12, 2026, 7:30 PM EST");
    expect(formatEasternInstant(daylightEvening.at)).toBe("Jul 14, 2026, 8:30 PM EDT");
    expect(formatEasternInstant(evening.at, "es")).toMatch(/12 nov 2026.*7:30.*p\.\s?m\. EST$/u);
    expect(formatEasternInstant("nope")).toBeNull();
  });

  it("moves calendar days across both daylight changes", () => {
    expect(addEasternDays("2027-03-13", 1)).toBe(springForward.day);
    expect(addEasternDays("2026-10-31", 1)).toBe(fallBack.day);
    expect(addEasternDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addEasternDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addEasternDays("2026-3-1", 1)).toBeNull();
    expect(addEasternDays("2026-03-01", 1.5)).toBeNull();
    for (const change of [springForward, fallBack]) {
      const start = easternMidnight(change.day);
      const next = easternMidnight(addEasternDays(change.day, 1));
      expect((next - start) / HOUR).toBe(change.hours);
      expect(nextEasternMidnight(change.before)).toEqual(next);
    }
    expect(easternMidnight("2026-11-12")?.toISOString()).toBe("2026-11-12T05:00:00.000Z");
    expect(easternMidnight("Nov 12")).toBeNull();
    expect(nextEasternMidnight(evening.at).toISOString()).toBe("2026-11-13T05:00:00.000Z");
    expect(Number.isNaN(nextEasternMidnight("never").getTime())).toBe(true);
    expect(EASTERN_TIME_ZONE).toBe("America/New_York");
  });

  it("keeps the folded helpers on the same answers", () => {
    expect(calendarDay(evening.at)).toBe(easternDay(evening.at));
    expect(calendarMidnight(evening.at)).toEqual(nextEasternMidnight(evening.at));
    expect(formatEasternTimestamp(evening.at, "en", { daylightName: true }).text).toBe("Nov 12, 2026, 7:30 PM EST");
    expect(formatEasternTimestamp(daylightEvening.at, "en").text).toBe("Jul 14, 2026, 8:30 PM ET");
  });
});

describe("the Eastern clock test kit", () => {
  it("pins the clock to the Eastern evening", async () => {
    const day = await atEasternInstant(vi, evening.at, () => easternDay(new Date()));
    expect(day).toBe(evening.easternDay);
    expect(Date.now()).toBeGreaterThan(Date.parse("2026-11-13T12:00:00Z"));
  });

  it("runs as a device in another zone without moving the Eastern day", async () => {
    const before = process.env.TZ;
    const seen = await inDeviceZone("Asia/Tokyo", () => [new Date(evening.at).getDate(), easternDay(evening.at)]);
    expect(seen).toEqual([13, evening.easternDay]);
    expect(process.env.TZ).toBe(before);
    process.env.TZ = "UTC";
    try {
      await inDeviceZone("America/Los_Angeles", () => undefined);
      expect(process.env.TZ).toBe("UTC");
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});

describe("Eastern time scan", () => {
  it("finds session-day reads outside comments and without a utc-day reason", () => {
    expect(sessionDayReads([
      "select current_date;",
      "-- current_date in a comment",
      "where due < now()::date",
      "where due < now() :: date -- utc-day: retention cut-off",
      "select private.eastern_day();",
      "select CURRENT_DATE + 1;",
    ].join("\n"))).toEqual([1, 3, 6]);
  });

  it("counts time formatters that print no zone", () => {
    expect(countUnlabelledTimes([
      "fmt({ hour: \"numeric\", minute: \"2-digit\" });",
      "fmt({ timeStyle: \"short\" });",
      "date.toLocaleTimeString(locale);",
      "fmt({ hour: \"numeric\", timeZoneName: \"short\" });",
      "fmt({ hour: '2-digit' }); // zone-labelled",
      "fmt({ month: \"short\" });",
    ].join("\n"))).toBe(3);
  });

  it("fails new migration reads, new or grown files, and stale known counts", () => {
    expect(easternTimeFindings({ migrations: {}, counts: { "src/a.js": 1 }, known: { "src/a.js": 1 } })).toEqual([]);
    const failures = easternTimeFindings({
      migrations: { "supabase/migrations/20261114000000_x.sql": [4] },
      counts: { "src/a.js": 2, "src/b.js": 1 },
      known: { "src/a.js": 1, "src/c.js": 2 },
    });
    expect(failures).toEqual([
      expect.stringContaining("20261114000000_x.sql:4: reads the session's (UTC) day"),
      expect.stringContaining("src/a.js: 2 time formatter(s) without a zone label (known 1)"),
      expect.stringContaining("src/b.js: 1 time formatter(s) without a zone label (known 0)"),
      expect.stringContaining("src/c.js now has 0 unlabelled time formatter(s); lower its known count from 2 to 0"),
    ]);
  });

  it("holds the repository to its known list exactly", () => {
    const failures = [];
    const { migrations, counts } = checkEasternTime(process.cwd(), (message) => failures.push(message));
    expect(failures).toEqual([]);
    expect(migrations).toEqual({});
    expect(Object.keys(counts).length).toBeGreaterThan(0);
  });

  it("fails closed outside a git checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "eastern-time-scan-"));
    try {
      const failures = [];
      expect(checkEasternTime(root, (message) => failures.push(message))).toEqual({ migrations: {}, counts: {} });
      expect(failures).toEqual([expect.stringContaining("cannot list tracked files")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
