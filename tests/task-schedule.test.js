// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  addLocalDays,
  calendarMonthGrid,
  calendarWeekGrid,
  weekStartOnOrBefore,
  classifyDeadline,
  clipTaskDateSpan,
  daysBetweenLocalDates,
  localDateKey,
  monthDateWindow,
  parseLocalDateKey,
  shiftTaskDateSpan,
  taskDateSpan,
} from "../src/lib/taskSchedule.js";

// Pure local-date schedule contracts for the desktop Work views. Every
// user-facing day classification must use local civil dates — never UTC
// serialization — so the whole suite must produce identical results under
// TZ=America/New_York and TZ=America/Los_Angeles.

const task = (overrides) => ({ id: "t", status: "in_progress", startDate: null, dueDate: null, ...overrides });

describe("localDateKey / parseLocalDateKey", () => {
  it("round-trips a local civil date without UTC rollover", () => {
    // 23:30 local on Jan 1 is already Jan 2 in UTC for western timezones; the
    // local key must stay Jan 1 regardless of TZ.
    expect(localDateKey(new Date(2026, 0, 1, 23, 30))).toBe("2026-01-01");
    expect(localDateKey(new Date(2026, 11, 31, 0, 10))).toBe("2026-12-31");
    expect(localDateKey(parseLocalDateKey("2026-08-16"))).toBe("2026-08-16");
  });

  it("parses to local noon", () => {
    const parsed = parseLocalDateKey("2026-03-08");
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(2);
    expect(parsed.getDate()).toBe(8);
    expect(parsed.getHours()).toBe(12);
  });

  it("throws RangeError for malformed keys", () => {
    for (const bad of ["", "2026-8-16", "08/16/2026", "2026-08-16T00:00:00Z", "20260816", "2026-08", null, undefined, 20260816, "abcd-ef-gh"]) {
      expect(() => parseLocalDateKey(bad), String(bad)).toThrow(RangeError);
    }
  });

  it("throws RangeError for impossible dates instead of rolling over", () => {
    for (const impossible of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31", "2025-02-29"]) {
      expect(() => parseLocalDateKey(impossible), impossible).toThrow(RangeError);
    }
    // 2028 is a leap year; 2026 is not.
    expect(() => parseLocalDateKey("2028-02-29")).not.toThrow();
    expect(() => parseLocalDateKey("2026-02-29")).toThrow(RangeError);
  });
});

describe("addLocalDays / daysBetweenLocalDates", () => {
  it("adds civil days across month, year, and leap boundaries", () => {
    expect(addLocalDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addLocalDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addLocalDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addLocalDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addLocalDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addLocalDays("2026-08-16", 0)).toBe("2026-08-16");
  });

  it("crosses both New York DST transitions as exact one-day steps", () => {
    // Spring forward: 2026-03-08 (23-hour local day).
    expect(addLocalDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addLocalDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addLocalDays("2026-03-09", 1)).toBe("2026-03-10");
    expect(addLocalDays("2026-03-07", 3)).toBe("2026-03-10");
    // Fall back: 2026-11-01 (25-hour local day).
    expect(addLocalDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addLocalDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(addLocalDays("2026-10-31", 2)).toBe("2026-11-02");
  });

  it("measures inclusive-exclusive day distance via calendar ordinals, not elapsed milliseconds", () => {
    expect(daysBetweenLocalDates("2026-03-07", "2026-03-10")).toBe(3);
    expect(daysBetweenLocalDates("2026-10-31", "2026-11-02")).toBe(2);
    expect(daysBetweenLocalDates("2026-08-16", "2026-08-16")).toBe(0);
    expect(daysBetweenLocalDates("2026-08-17", "2026-08-16")).toBe(-1);
    expect(daysBetweenLocalDates("2025-12-31", "2026-01-01")).toBe(1);
  });

  it("stays strict for malformed inputs", () => {
    expect(() => addLocalDays("2026-02-30", 1)).toThrow(RangeError);
    expect(() => addLocalDays("2026-08-16", 1.5)).toThrow(RangeError);
    expect(() => addLocalDays("2026-08-16", Number.NaN)).toThrow(RangeError);
    expect(() => daysBetweenLocalDates("2026-08-16", "not-a-date")).toThrow(RangeError);
  });

  it("throws instead of leaving the round-trippable year range", () => {
    // padStart(4) would mangle negative years and five-digit years never
    // re-parse, so arithmetic past either bound must throw — and the
    // task-facing shift must fail closed to null, not write a corrupt patch.
    expect(() => addLocalDays("9999-12-31", 1)).toThrow(RangeError);
    expect(() => addLocalDays("0100-01-01", -1)).toThrow(RangeError);
    expect(() => addLocalDays("0100-01-01", -40000)).toThrow(RangeError);
    expect(addLocalDays("9999-12-30", 1)).toBe("9999-12-31");
    expect(shiftTaskDateSpan(task({ dueDate: "9999-12-31" }), 1)).toBeNull();
  });
});

describe("taskDateSpan", () => {
  it("returns null for undated tasks", () => {
    expect(taskDateSpan(task())).toBeNull();
  });

  it("returns an inclusive two-date span", () => {
    expect(taskDateSpan(task({ startDate: "2026-07-21", dueDate: "2026-07-25" })))
      .toEqual({ startDate: "2026-07-21", endDate: "2026-07-25", halfDated: false });
  });

  it("treats a single-day task as a one-day span", () => {
    expect(taskDateSpan(task({ startDate: "2026-07-22", dueDate: "2026-07-22" })))
      .toEqual({ startDate: "2026-07-22", endDate: "2026-07-22", halfDated: false });
  });

  it("normalizes half-dated tasks to one-day halfDated spans", () => {
    expect(taskDateSpan(task({ startDate: "2026-07-22" })))
      .toEqual({ startDate: "2026-07-22", endDate: "2026-07-22", halfDated: true });
    expect(taskDateSpan(task({ dueDate: "2026-07-25" })))
      .toEqual({ startDate: "2026-07-25", endDate: "2026-07-25", halfDated: true });
  });

  it("fails closed to null for inverted spans and malformed legacy values", () => {
    expect(taskDateSpan(task({ startDate: "2026-07-25", dueDate: "2026-07-21" }))).toBeNull();
    expect(taskDateSpan(task({ startDate: "2026-02-30", dueDate: "2026-03-02" }))).toBeNull();
    expect(taskDateSpan(task({ startDate: "07/21/2026" }))).toBeNull();
    expect(taskDateSpan(task({ dueDate: "2026-07-25T00:00:00Z" }))).toBeNull();
    expect(taskDateSpan(task({ startDate: 20260721, dueDate: "2026-07-25" }))).toBeNull();
  });
});

describe("shiftTaskDateSpan", () => {
  it("preserves a two-date interval exactly", () => {
    expect(shiftTaskDateSpan(task({ startDate: "2026-07-21", dueDate: "2026-07-25" }), 1))
      .toEqual({ startDate: "2026-07-22", dueDate: "2026-07-26" });
    expect(shiftTaskDateSpan(task({ startDate: "2026-07-21", dueDate: "2026-07-25" }), -1))
      .toEqual({ startDate: "2026-07-20", dueDate: "2026-07-24" });
  });

  it("preserves the interval across a DST boundary", () => {
    expect(shiftTaskDateSpan(task({ startDate: "2026-03-06", dueDate: "2026-03-09" }), 1))
      .toEqual({ startDate: "2026-03-07", dueDate: "2026-03-10" });
    expect(shiftTaskDateSpan(task({ startDate: "2026-10-30", dueDate: "2026-11-01" }), 1))
      .toEqual({ startDate: "2026-10-31", dueDate: "2026-11-02" });
  });

  it("normalizes a half-dated task to an equal one-day start/due pair", () => {
    expect(shiftTaskDateSpan(task({ dueDate: "2026-07-25" }), 1))
      .toEqual({ startDate: "2026-07-26", dueDate: "2026-07-26" });
    expect(shiftTaskDateSpan(task({ startDate: "2026-07-22" }), -1))
      .toEqual({ startDate: "2026-07-21", dueDate: "2026-07-21" });
  });

  it("fails closed to null for undated, inverted, malformed, or bad shift amounts", () => {
    expect(shiftTaskDateSpan(task(), 1)).toBeNull();
    expect(shiftTaskDateSpan(task({ startDate: "2026-07-25", dueDate: "2026-07-21" }), 1)).toBeNull();
    expect(shiftTaskDateSpan(task({ startDate: "2026-02-30" }), 1)).toBeNull();
    expect(shiftTaskDateSpan(task({ startDate: "2026-07-21", dueDate: "2026-07-25" }), 0.5)).toBeNull();
    expect(shiftTaskDateSpan(task({ startDate: "2026-07-21", dueDate: "2026-07-25" }), Number.NaN)).toBeNull();
  });
});

describe("monthDateWindow", () => {
  it("returns the exact shape with no first/last aliases", () => {
    const window = monthDateWindow("2026-08-16");
    expect(Object.keys(window).sort()).toEqual(["dates", "dayCount", "endDate", "startDate"]);
    expect(window.startDate).toBe("2026-08-01");
    expect(window.endDate).toBe("2026-08-31");
    expect(window.dayCount).toBe(31);
    expect(window.dates).toHaveLength(31);
    expect(window.dates[0]).toBe("2026-08-01");
    expect(window.dates[30]).toBe("2026-08-31");
    expect(window).not.toHaveProperty("first");
    expect(window).not.toHaveProperty("last");
  });

  it("covers February in leap and non-leap years", () => {
    expect(monthDateWindow("2026-02-10").dayCount).toBe(28);
    expect(monthDateWindow("2028-02-10").dayCount).toBe(29);
  });

  it("covers the DST months without duplicating or dropping a day", () => {
    const march = monthDateWindow("2026-03-08");
    expect(march.dayCount).toBe(31);
    expect(new Set(march.dates).size).toBe(31);
    const november = monthDateWindow("2026-11-01");
    expect(november.dayCount).toBe(30);
    expect(new Set(november.dates).size).toBe(30);
  });

  it("returns fresh arrays without mutating shared state", () => {
    const first = monthDateWindow("2026-08-16");
    const second = monthDateWindow("2026-08-16");
    expect(first.dates).not.toBe(second.dates);
    expect(Object.isFrozen(first.dates)).toBe(false);
    first.dates.push("tampered");
    expect(monthDateWindow("2026-08-16").dates).toHaveLength(31);
  });

  it("is strict about its anchor", () => {
    expect(() => monthDateWindow("2026-02-30")).toThrow(RangeError);
    expect(() => monthDateWindow("August 2026")).toThrow(RangeError);
  });
});

describe("calendarMonthGrid / calendarWeekGrid", () => {
  it("month grid is exactly 42 Monday-first keys including leading/trailing dates", () => {
    const grid = calendarMonthGrid("2026-08-16");
    expect(grid).toHaveLength(42);
    // 2026-08-01 is a Saturday, so the grid opens on Monday 2026-07-27.
    expect(grid[0]).toBe("2026-07-27");
    expect(grid[41]).toBe("2026-09-06");
    expect(parseLocalDateKey(grid[0]).getDay()).toBe(1);
    expect(grid[0]).toBe(weekStartOnOrBefore("2026-08-01"));
    expect(new Set(grid).size).toBe(42);
    expect(grid).toContain("2026-08-01");
    expect(grid).toContain("2026-08-31");
  });

  it("month grid stays 42 unique consecutive days across the DST months", () => {
    for (const anchor of ["2026-03-08", "2026-11-01"]) {
      const grid = calendarMonthGrid(anchor);
      expect(grid).toHaveLength(42);
      expect(new Set(grid).size).toBe(42);
      for (let index = 1; index < grid.length; index += 1) {
        expect(daysBetweenLocalDates(grid[index - 1], grid[index]), `${anchor} @ ${index}`).toBe(1);
      }
      expect(parseLocalDateKey(grid[0]).getDay()).toBe(1);
    }
  });

  it("week grid is exactly seven Monday-first keys containing its anchor", () => {
    const week = calendarWeekGrid("2026-08-16");
    // 2026-08-16 is a Sunday, so its week opens on Monday 2026-08-10.
    expect(week).toEqual([
      "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16",
    ]);
    expect(week[0]).toBe(weekStartOnOrBefore("2026-08-16"));
    const midWeek = calendarWeekGrid("2026-08-19");
    expect(midWeek).toHaveLength(7);
    expect(midWeek[0]).toBe("2026-08-17");
    expect(midWeek).toContain("2026-08-19");
    expect(parseLocalDateKey(midWeek[0]).getDay()).toBe(1);
  });

  it("week grid crosses fall-back week without duplication", () => {
    const week = calendarWeekGrid("2026-11-01");
    expect(week[0]).toBe("2026-10-26");
    expect(week).toHaveLength(7);
    expect(new Set(week).size).toBe(7);
    expect(week[6]).toBe("2026-11-01");
  });

  it("both grids are strict about their anchors", () => {
    expect(() => calendarMonthGrid("2026-13-01")).toThrow(RangeError);
    expect(() => calendarWeekGrid("")).toThrow(RangeError);
  });
});

describe("clipTaskDateSpan", () => {
  const windowStart = "2026-08-01";
  const windowEnd = "2026-08-31";

  it("returns the full shape for an interior span", () => {
    expect(clipTaskDateSpan(task({ startDate: "2026-08-10", dueDate: "2026-08-12" }), windowStart, windowEnd)).toEqual({
      startDate: "2026-08-10",
      endDate: "2026-08-12",
      visibleStartDate: "2026-08-10",
      visibleEndDate: "2026-08-12",
      startOffsetDays: 9,
      visibleDayCount: 3,
      totalDayCount: 3,
      clippedStart: false,
      clippedEnd: false,
      halfDated: false,
    });
  });

  it("clips a span crossing the leading window edge", () => {
    expect(clipTaskDateSpan(task({ startDate: "2026-07-28", dueDate: "2026-08-03" }), windowStart, windowEnd)).toEqual({
      startDate: "2026-07-28",
      endDate: "2026-08-03",
      visibleStartDate: "2026-08-01",
      visibleEndDate: "2026-08-03",
      startOffsetDays: 0,
      visibleDayCount: 3,
      totalDayCount: 7,
      clippedStart: true,
      clippedEnd: false,
      halfDated: false,
    });
  });

  it("clips a span crossing the trailing window edge", () => {
    expect(clipTaskDateSpan(task({ startDate: "2026-08-30", dueDate: "2026-09-02" }), windowStart, windowEnd)).toEqual({
      startDate: "2026-08-30",
      endDate: "2026-09-02",
      visibleStartDate: "2026-08-30",
      visibleEndDate: "2026-08-31",
      startOffsetDays: 29,
      visibleDayCount: 2,
      totalDayCount: 4,
      clippedStart: false,
      clippedEnd: true,
      halfDated: false,
    });
  });

  it("clips a span spanning the whole window on both sides", () => {
    const clipped = clipTaskDateSpan(task({ startDate: "2026-07-01", dueDate: "2026-09-30" }), windowStart, windowEnd);
    expect(clipped.visibleStartDate).toBe(windowStart);
    expect(clipped.visibleEndDate).toBe(windowEnd);
    expect(clipped.visibleDayCount).toBe(31);
    expect(clipped.totalDayCount).toBe(92);
    expect(clipped.clippedStart).toBe(true);
    expect(clipped.clippedEnd).toBe(true);
  });

  it("returns null for wholly-outside, undated, inverted, or malformed spans", () => {
    expect(clipTaskDateSpan(task({ startDate: "2026-07-01", dueDate: "2026-07-31" }), windowStart, windowEnd)).toBeNull();
    expect(clipTaskDateSpan(task({ startDate: "2026-09-01", dueDate: "2026-09-05" }), windowStart, windowEnd)).toBeNull();
    expect(clipTaskDateSpan(task(), windowStart, windowEnd)).toBeNull();
    expect(clipTaskDateSpan(task({ startDate: "2026-08-12", dueDate: "2026-08-10" }), windowStart, windowEnd)).toBeNull();
    expect(clipTaskDateSpan(task({ startDate: "2026-02-30", dueDate: "2026-08-10" }), windowStart, windowEnd)).toBeNull();
    expect(clipTaskDateSpan(task({ startDate: "2026-08-10", dueDate: "2026-08-12" }), "bogus", windowEnd)).toBeNull();
    expect(clipTaskDateSpan(task({ startDate: "2026-08-10", dueDate: "2026-08-12" }), windowEnd, windowStart)).toBeNull();
  });

  it("keeps halfDated through clipping", () => {
    expect(clipTaskDateSpan(task({ dueDate: "2026-08-05" }), windowStart, windowEnd)).toMatchObject({
      halfDated: true,
      visibleStartDate: "2026-08-05",
      visibleEndDate: "2026-08-05",
      visibleDayCount: 1,
      totalDayCount: 1,
    });
  });
});

describe("classifyDeadline", () => {
  const today = "2026-07-27";

  it("classifies the urgency boundaries inclusively", () => {
    expect(classifyDeadline(task({ dueDate: "2026-07-25" }), today)).toBe("overdue");
    expect(classifyDeadline(task({ dueDate: "2026-07-26" }), today)).toBe("overdue");
    expect(classifyDeadline(task({ dueDate: "2026-07-27" }), today)).toBe("today");
    expect(classifyDeadline(task({ dueDate: "2026-07-28" }), today)).toBe("next-seven-days");
    expect(classifyDeadline(task({ dueDate: "2026-08-03" }), today)).toBe("next-seven-days");
    expect(classifyDeadline(task({ dueDate: "2026-08-04" }), today)).toBe("later");
  });

  it("spans DST boundaries without shifting a bucket", () => {
    expect(classifyDeadline(task({ dueDate: "2026-03-08" }), "2026-03-07")).toBe("next-seven-days");
    expect(classifyDeadline(task({ dueDate: "2026-03-14" }), "2026-03-07")).toBe("next-seven-days");
    expect(classifyDeadline(task({ dueDate: "2026-03-15" }), "2026-03-07")).toBe("later");
    expect(classifyDeadline(task({ dueDate: "2026-11-01" }), "2026-10-31")).toBe("next-seven-days");
    expect(classifyDeadline(task({ dueDate: "2026-11-07" }), "2026-10-31")).toBe("next-seven-days");
    expect(classifyDeadline(task({ dueDate: "2026-11-08" }), "2026-10-31")).toBe("later");
  });

  it("a Done task with a valid due key is completed, never urgent", () => {
    expect(classifyDeadline(task({ status: "done", dueDate: "2026-07-22" }), today)).toBe("completed");
    expect(classifyDeadline(task({ status: "done", dueDate: today }), today)).toBe("completed");
    expect(classifyDeadline(task({ status: "done", dueDate: "2026-08-30" }), today)).toBe("completed");
  });

  it("returns undated when no valid due key exists — including a Done task with an invalid one", () => {
    expect(classifyDeadline(task(), today)).toBe("undated");
    expect(classifyDeadline(task({ dueDate: "2026-02-30" }), today)).toBe("undated");
    expect(classifyDeadline(task({ dueDate: "07/25/2026" }), today)).toBe("undated");
    expect(classifyDeadline(task({ status: "done", dueDate: "2026-02-30" }), today)).toBe("undated");
    expect(classifyDeadline(task({ status: "done" }), today)).toBe("undated");
  });

  it("fails closed for a malformed today key instead of crashing a view", () => {
    expect(classifyDeadline(task({ dueDate: "2026-07-25" }), "not-a-day")).toBe("undated");
  });
});
