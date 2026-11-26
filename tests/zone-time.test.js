import { describe, expect, it, vi } from "vitest";

import { easternDay, easternMidnight, easternZoneLabel, formatEasternInstant, nextEasternMidnight } from "../src/lib/easternTime.js";
import {
  UNKNOWN_TIME_ZONE,
  UNSET_GROUP_TIME_ZONE,
  addDays,
  formatZoneInstant,
  groupTimeZone,
  isTimeZone,
  nextZoneMidnight,
  zoneDay,
  zoneLabel,
  zoneMidnight,
} from "../src/lib/zoneTime.js";
import { EASTERN_INSTANTS, atEasternInstant, inDeviceZone } from "./helpers/easternClock.js";

// 7:30 PM EST on Thu Nov 12, 2026 (00:30 UTC on Nov 13), read in each zone.
const EVENING = EASTERN_INSTANTS.evening.at;
const SAME_INSTANT = [
  ["America/Los_Angeles", "2026-11-12", "Nov 12, 2026, 4:30 PM PST"],
  ["America/Phoenix", "2026-11-12", "Nov 12, 2026, 5:30 PM MST"],
  ["America/New_York", "2026-11-12", "Nov 12, 2026, 7:30 PM EST"],
  ["Europe/Berlin", "2026-11-13", "Nov 13, 2026, 1:30 AM GMT+1"],
  ["Asia/Kolkata", "2026-11-13", "Nov 13, 2026, 6:00 AM GMT+5:30"],
  ["Asia/Kathmandu", "2026-11-13", "Nov 13, 2026, 6:15 AM GMT+5:45"],
  ["Asia/Tokyo", "2026-11-13", "Nov 13, 2026, 9:30 AM GMT+9"],
  ["Australia/Sydney", "2026-11-13", "Nov 13, 2026, 11:30 AM GMT+11"],
  ["Australia/Lord_Howe", "2026-11-13", "Nov 13, 2026, 11:30 AM GMT+11"],
  ["Pacific/Chatham", "2026-11-13", "Nov 13, 2026, 2:15 PM GMT+13:45"],
];

describe("the shared time-zone module", () => {
  it("reads one instant as each zone's own day and clock, with the zone named", () => {
    for (const [zone, day, text] of SAME_INSTANT) {
      expect(zoneDay(EVENING, zone), zone).toBe(day);
      expect(formatZoneInstant(EVENING, "en", zone), zone).toBe(text);
    }
    expect(zoneDay("not a date", "Europe/Berlin")).toBeNull();
    expect(formatZoneInstant(undefined, "en", "Europe/Berlin")).toBeNull();
    expect(zoneLabel("", "Europe/Berlin")).toBeNull();
  });

  it("never follows the device: a phone in Tokyo reads a Los Angeles chapter's day", async () => {
    for (const device of ["Asia/Tokyo", "Europe/Berlin", "America/New_York", "Pacific/Kiritimati"]) {
      const read = await inDeviceZone(device, () => atEasternInstant(vi, EVENING, () => [
        zoneDay(new Date(), "America/Los_Angeles"),
        formatZoneInstant(new Date(), "en", "America/Los_Angeles"),
        nextZoneMidnight(new Date(), "America/Los_Angeles").toISOString(),
      ]));
      expect(read, device).toEqual(["2026-11-12", "Nov 12, 2026, 4:30 PM PST", "2026-11-13T08:00:00.000Z"]);
    }
  });

  it("applies each region's own daylight dates", () => {
    // Sun Mar 22, 2026: the United States has changed (Mar 8), Europe has not (Mar 29).
    expect(zoneLabel("2026-03-22T12:00:00Z", "America/New_York")).toBe("EDT");
    expect(zoneLabel("2026-03-22T12:00:00Z", "Europe/Berlin")).toBe("GMT+1");
    expect(zoneLabel("2026-03-30T12:00:00Z", "Europe/Berlin")).toBe("GMT+2");
    // The southern summer is the northern winter.
    expect(zoneLabel("2026-01-15T00:00:00Z", "Australia/Sydney")).toBe("GMT+11");
    expect(zoneLabel("2026-07-15T00:00:00Z", "Australia/Sydney")).toBe("GMT+10");
    // Lord Howe moves by half an hour; Phoenix and Kolkata never move.
    expect(zoneLabel("2026-01-15T00:00:00Z", "Australia/Lord_Howe")).toBe("GMT+11");
    expect(zoneLabel("2026-07-15T00:00:00Z", "Australia/Lord_Howe")).toBe("GMT+10:30");
    expect(zoneLabel("2026-01-15T00:00:00Z", "America/Phoenix")).toBe(zoneLabel("2026-07-15T00:00:00Z", "America/Phoenix"));
    expect(zoneLabel("2026-01-15T00:00:00Z", "Asia/Kolkata")).toBe(zoneLabel("2026-07-15T00:00:00Z", "Asia/Kolkata"));
  });

  it("begins a day at the first instant that has that date, across short and long days", () => {
    const hours = (day, zone) => (zoneMidnight(addDays(day, 1), zone) - zoneMidnight(day, zone)) / 3_600_000;
    expect(zoneMidnight("2026-11-13", "Europe/Berlin").toISOString()).toBe("2026-11-12T23:00:00.000Z");
    expect(zoneMidnight("2026-11-13", "Asia/Kathmandu").toISOString()).toBe("2026-11-12T18:15:00.000Z");
    expect(hours("2026-03-29", "Europe/Berlin")).toBe(23);
    expect(hours("2026-10-25", "Europe/Berlin")).toBe(25);
    expect(hours("2026-10-04", "Australia/Sydney")).toBe(23);
    expect(hours("2026-04-05", "Australia/Sydney")).toBe(25);
    expect(hours("2026-10-04", "Australia/Lord_Howe")).toBe(23.5);
    expect(hours("2026-04-05", "Australia/Lord_Howe")).toBe(24.5);
    expect(hours("2026-07-01", "America/Phoenix")).toBe(24);
    // Havana's clocks skip midnight itself on Sun Mar 8, 2026: the day begins at 1:00 AM.
    const havana = zoneMidnight("2026-03-08", "America/Havana");
    expect(havana.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(zoneDay(havana, "America/Havana")).toBe("2026-03-08");
    expect(zoneDay(havana.getTime() - 1, "America/Havana")).toBe("2026-03-07");
    for (const [zone] of SAME_INSTANT) {
      const start = zoneMidnight("2026-11-13", zone);
      expect(zoneDay(start, zone), zone).toBe("2026-11-13");
      expect(zoneDay(start.getTime() - 1, zone), zone).toBe("2026-11-12");
    }
    expect(zoneMidnight("2026-02-30", "UTC")).toBeNull();
    expect(zoneMidnight("13 Nov 2026", "UTC")).toBeNull();
    expect(Number.isNaN(nextZoneMidnight("nope", "UTC").getTime())).toBe(true);
  });

  it("finds the first start of a day whatever the size of the clock change", () => {
    // Casey station moved its clock back three hours at 2:00 AM on March 5, 2010, so that
    // date began twice; the day starts at the first (gate stage 527).
    expect(zoneMidnight("2010-03-05", "Antarctica/Casey").toISOString()).toBe("2010-03-04T13:00:00.000Z");
    expect(zoneDay("2010-03-04T13:00:00Z", "Antarctica/Casey")).toBe("2010-03-05");
    expect(zoneDay("2010-03-04T12:59:59Z", "Antarctica/Casey")).toBe("2010-03-04");
    expect(zoneDay("2010-03-04T15:30:00Z", "Antarctica/Casey")).toBe("2010-03-04");
    expect(zoneMidnight("2010-03-06", "Antarctica/Casey").toISOString()).toBe("2010-03-05T16:00:00.000Z");
    expect(nextZoneMidnight("2010-03-04T15:30:00Z", "Antarctica/Casey").toISOString()).toBe("2010-03-04T13:00:00.000Z");
    // Toronto's clock jumped from 11:30 PM on March 30, 1919 to 12:30 AM on March 31: the day
    // begins at the jump, which no offset calls midnight (final round of #9475).
    expect(zoneMidnight("1919-03-31", "America/Toronto").toISOString()).toBe("1919-03-31T04:30:00.000Z");
    expect(zoneDay("1919-03-31T04:29:59Z", "America/Toronto")).toBe("1919-03-30");
    expect(zoneDay("1919-03-31T04:30:00Z", "America/Toronto")).toBe("1919-03-31");
    expect(nextZoneMidnight("1919-03-31T03:00:00Z", "America/Toronto").toISOString()).toBe("1919-03-31T04:30:00.000Z");
    // Troll station moves by two hours.
    expect(zoneMidnight("2026-03-30", "Antarctica/Troll").toISOString()).toBe("2026-03-29T22:00:00.000Z");
  });

  it("has no start for a date a zone never had, and passes over it to the next day", () => {
    // Apia went from Thursday December 29, 2011 straight to Saturday December 31.
    expect(zoneMidnight("2011-12-30", "Pacific/Apia")).toBeNull();
    expect(zoneMidnight("2011-12-31", "Pacific/Apia").toISOString()).toBe("2011-12-30T10:00:00.000Z");
    expect(zoneDay("2011-12-30T09:59:59Z", "Pacific/Apia")).toBe("2011-12-29");
    expect(nextZoneMidnight("2011-12-30T09:30:00Z", "Pacific/Apia").toISOString()).toBe("2011-12-30T10:00:00.000Z");
    // Kiritimati had no December 31, 1994.
    expect(zoneMidnight("1994-12-31", "Pacific/Kiritimati")).toBeNull();
    expect(nextZoneMidnight("1994-12-31T09:00:00Z", "Pacific/Kiritimati").toISOString()).toBe("1994-12-31T10:00:00.000Z");
    expect(zoneDay("1994-12-31T10:00:00Z", "Pacific/Kiritimati")).toBe("1995-01-01");
  });

  it("answers the Eastern start of a day as the module before it did, at any year", () => {
    // Taken from src/lib/easternTime.js on Main 044ec57097, before it called this module.
    const BEFORE = {
      "0099-12-31": "0099-12-31T04:56:02.000Z",
      "0100-01-01": "0100-01-01T04:56:02.000Z",
      "1883-11-18": "1883-11-18T04:56:02.000Z",
      "1883-11-19": "1883-11-19T05:00:00.000Z",
      "2026-11-02": "2026-11-02T05:00:00.000Z",
      "2027-03-14": "2027-03-14T05:00:00.000Z",
      "2027-03-15": "2027-03-15T04:00:00.000Z",
      "9999-12-31": "9999-12-31T05:00:00.000Z",
    };
    for (const [day, start] of Object.entries(BEFORE)) expect(easternMidnight(day)?.toISOString(), day).toBe(start);
    for (const none of ["0000-01-01", "2026-02-30", "2026-13-01", "2026-3-1", "", null, undefined]) expect(easternMidnight(none), String(none)).toBeNull();
  });

  it("moves calendar days by date, never by 24 hours", () => {
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-3-1", 1)).toBeNull();
    expect(addDays("2026-03-01", 1.5)).toBeNull();
  });

  it("keeps the English zone label in Spanish", () => {
    expect(formatZoneInstant(EVENING, "es", "America/Los_Angeles")).toMatch(/12 nov 2026.*4:30.*p\.\s?m\. PST$/u);
    expect(formatZoneInstant(EVENING, "es", "Europe/Berlin")).toMatch(/13 nov 2026.*1:30.*a\.\s?m\. GMT\+1$/u);
  });

  it("answers a group's zone, the unset value before one is delivered, and UTC for a zone this engine lacks", () => {
    expect(groupTimeZone({ timeZone: "Europe/Berlin" })).toBe("Europe/Berlin");
    expect(groupTimeZone("Asia/Kathmandu")).toBe("Asia/Kathmandu");
    for (const none of [undefined, null, "", {}, { timeZone: null }, { timeZone: "" }]) expect(groupTimeZone(none)).toBe(UNSET_GROUP_TIME_ZONE);
    expect(groupTimeZone({ timeZone: "Mars/Olympus_Mons" })).toBe(UNKNOWN_TIME_ZONE);
    expect(groupTimeZone({ timeZone: 5 })).toBe(UNKNOWN_TIME_ZONE);
    expect(isTimeZone("Pacific/Chatham")).toBe(true);
    expect(isTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(formatZoneInstant(EVENING, "en", groupTimeZone({ timeZone: "Mars/Olympus_Mons" }))).toBe("Nov 13, 2026, 12:30 AM UTC");
  });

  it("is what the Eastern names call", () => {
    const { daylightEvening, fallBack, springForward } = EASTERN_INSTANTS;
    for (const at of [EVENING, daylightEvening.at, fallBack.before, fallBack.after, springForward.before, springForward.after]) {
      expect(easternDay(at)).toBe(zoneDay(at, "America/New_York"));
      expect(easternZoneLabel(at)).toBe(zoneLabel(at, "America/New_York"));
      expect(formatEasternInstant(at, "es")).toBe(formatZoneInstant(at, "es", "America/New_York"));
      expect(nextEasternMidnight(at).toISOString()).toBe(nextZoneMidnight(at, "America/New_York").toISOString());
    }
    expect(easternMidnight("2026-11-02").toISOString()).toBe(zoneMidnight("2026-11-02", "America/New_York").toISOString());
  });
});
