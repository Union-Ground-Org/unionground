import { describe, expect, it } from "vitest";
import { zonedDateTimeInputToIso } from "../src/lib/localDateTime.js";

const EASTERN = "America/New_York";

describe("zonedDateTimeInputToIso", () => {
  it("returns null for empty or unparseable input and unknown zones", () => {
    expect(zonedDateTimeInputToIso("", EASTERN)).toBeNull();
    expect(zonedDateTimeInputToIso(null, EASTERN)).toBeNull();
    expect(zonedDateTimeInputToIso("2026-08-29 09:00", EASTERN)).toBeNull();
    expect(zonedDateTimeInputToIso("2026-08-29T09:00", "")).toBeNull();
    expect(zonedDateTimeInputToIso("2026-08-29T09:00", "Not/A_Zone")).toBeNull();
  });

  it("reads Eastern daylight and standard wall time", () => {
    expect(zonedDateTimeInputToIso("2026-08-29T09:00", EASTERN)).toBe("2026-08-29T13:00:00.000Z");
    expect(zonedDateTimeInputToIso("2026-01-15T09:00", EASTERN)).toBe("2026-01-15T14:00:00.000Z");
    expect(zonedDateTimeInputToIso("2026-08-29T09:00:30", EASTERN)).toBe("2026-08-29T13:00:30.000Z");
  });

  it("reads other named zones, including a half-hour offset", () => {
    expect(zonedDateTimeInputToIso("2026-08-29T09:00", "America/Chicago")).toBe("2026-08-29T14:00:00.000Z");
    expect(zonedDateTimeInputToIso("2026-08-29T09:00", "Asia/Kolkata")).toBe("2026-08-29T03:30:00.000Z");
  });

  it.each(["02:00", "02:30", "02:59:59"])("refuses nonexistent Eastern spring-forward time %s", (time) => {
    expect(zonedDateTimeInputToIso(`2026-03-08T${time}`, EASTERN)).toBeNull();
  });

  it.each([
    "2026-02-29T09:00", "2026-02-30T09:00", "2026-04-31T09:00",
    "2026-00-15T09:00", "2026-13-15T09:00", "2026-01-00T09:00", "2026-01-32T09:00",
    "2026-01-15T24:00", "2026-01-15T25:00", "2026-01-15T09:60", "2026-01-15T09:00:60",
    "0000-01-15T09:00",
  ])("refuses impossible civil components in %s", (input) => {
    expect(zonedDateTimeInputToIso(input, EASTERN)).toBeNull();
  });

  it("preserves valid wall times immediately before and after the Eastern gap", () => {
    expect(zonedDateTimeInputToIso("2026-03-08T01:59:59", EASTERN)).toBe("2026-03-08T06:59:59.000Z");
    expect(zonedDateTimeInputToIso("2026-03-08T03:00", EASTERN)).toBe("2026-03-08T07:00:00.000Z");
  });

  it("keeps the existing instant choice for a valid repeated fall-back time", () => {
    expect(zonedDateTimeInputToIso("2026-11-01T01:30", EASTERN)).toBe("2026-11-01T05:30:00.000Z");
  });

  it("handles leap days, midnight, seconds and years below 100 without normalization", () => {
    expect(zonedDateTimeInputToIso("2028-02-29T00:00:30", "Asia/Kolkata")).toBe("2028-02-28T18:30:30.000Z");
    expect(zonedDateTimeInputToIso("0099-02-28T00:00", "UTC")).toBe("0099-02-28T00:00:00.000Z");
  });

  it("refuses a half-hour DST gap and a skipped calendar day", () => {
    expect(zonedDateTimeInputToIso("2026-10-04T02:15", "Australia/Lord_Howe")).toBeNull();
    expect(zonedDateTimeInputToIso("2011-12-30T12:00", "Pacific/Apia")).toBeNull();
    expect(zonedDateTimeInputToIso("2026-10-04T02:30", "Australia/Lord_Howe")).toBe("2026-10-03T15:30:00.000Z");
  });

  it("ignores the process zone", () => {
    const prior = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(zonedDateTimeInputToIso("2026-08-29T09:00", EASTERN)).toBe("2026-08-29T13:00:00.000Z");
      expect(zonedDateTimeInputToIso("2026-01-15T09:00", EASTERN)).toBe("2026-01-15T14:00:00.000Z");
    } finally {
      if (prior === undefined) delete process.env.TZ;
      else process.env.TZ = prior;
    }
  });
});
