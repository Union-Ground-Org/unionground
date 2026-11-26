// @vitest-environment node
//
// REQ-UG-RELEASE-DATE-CONTROL-WITHOUT-MIGRATION-20261112 (#8580):
// scripts/release-calendar.mjs against a fake pair of databases. One command
// reaches Production, then SAMPLE; it previews and asks before saving, refuses a
// change that would leave the sites different, stops before SAMPLE when
// Production refuses, and the list shows a site that differs. Gate round 1
// repairs: sync names a hold only SAMPLE has instead of reporting nothing to
// change, "release now" takes the databases' clock, a shift is refused when the
// holds moved after the preview, and every saved switch must read back as shown.
import { afterEach, describe, expect, it, vi } from "vitest";
import { addWeeks, easternTimeExists, formatEastern, main, parseArgs, sqlText } from "../scripts/release-calendar.mjs";

const NOW = new Date("2026-11-13T04:00:00Z"); // Thu Nov 12, 2026, 11:00 PM ET
const NOW_EASTERN = "2026-11-12 23:00";
const WHO = ["--by", "Alex Rivera", "--reason", "Neuro Map slips a week"];

const easternOf = (iso) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};

// A row is stored as its release_at text and its Eastern wall-clock text.
function row(release) {
  if (release === "infinity") return { release_at: "infinity", eastern: null };
  if (/America\/New_York$/.test(release)) return { release_at: release, eastern: release.replace(" America/New_York", "") };
  return { release_at: release, eastern: easternOf(release) };
}

// Each fake database has its own clock (`now`, default NOW). `beforeWrite`
// runs once, just before the first write, as a concurrent change would;
// `ignoreWrites` answers a write without changing anything.
function fakeSites(initial, { control = { production: true, sample: true }, fail = {}, now = {}, beforeWrite, ignoreWrites = {} } = {}) {
  const db = {};
  for (const site of ["production", "sample"]) db[site] = new Map(Object.entries(initial[site] ?? {}).map(([key, value]) => [key, row(value)]));
  const log = [];
  const clock = (site) => now[site] ?? NOW;
  const held = (site, entry) => entry.release_at === "infinity" || entry.eastern > easternOf(clock(site));
  const moving = (site, day) => [...db[site]].filter(([, entry]) => entry.release_at !== "infinity" && held(site, entry) && entry.eastern.slice(0, 10) >= day);
  let pending = beforeWrite;
  async function query(site, sql, { readOnly }) {
    log.push({ site, kind: /\/\* release-calendar:(\w+) \*\//.exec(sql)[1], readOnly });
    if (sql.includes("release-calendar:state")) {
      const rows = [...db[site]].sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => ({ key, ...entry, held: held(site, entry) }));
      return [{ state: { control: control[site], now: clock(site).toISOString(), rows } }];
    }
    if (pending && !sql.includes("release-calendar:history")) { pending(db); pending = undefined; }
    if (fail[site]) throw new Error(`${site} refused: boom`);
    if (ignoreWrites[site]) return [{ result: {} }];
    if (sql.includes("release-calendar:set")) {
      const [, key, literal] = /set_platform_setting_release\('([^']+)', '([^']+)'::timestamptz/.exec(sql);
      if (!db[site].has(key)) throw new Error("never held");
      db[site].set(key, row(literal));
      return [{ result: { key, updated: true } }];
    }
    if (sql.includes("release-calendar:shift")) {
      const [, day, weeks, previewed] = /shift_platform_setting_releases\('([^']+)'::date, (-?\d+), '([^']*)'::jsonb,/.exec(sql);
      const current = Object.fromEntries(moving(site, day).map(([key, entry]) => [key, entry.release_at]));
      const sorted = (object) => JSON.stringify(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
      if (sorted(current) !== sorted(JSON.parse(previewed))) throw new Error("PT409 the calendar changed since the preview");
      for (const [key, entry] of moving(site, day)) db[site].set(key, row(`${addWeeks(entry.eastern, Number(weeks))} America/New_York`));
      return [{ result: { count: Object.keys(current).length } }];
    }
    if (sql.includes("release-calendar:history")) return [];
    throw new Error(`unexpected query ${sql}`);
  }
  return { db, log, query };
}

async function run(argv, sites, { interactive = false, answer = false } = {}) {
  const lines = [];
  const asked = [];
  const start = sites.log.length;
  const code = await main(argv, {
    out: (line) => lines.push(line),
    interactive,
    confirm: async (question) => { asked.push(question); return answer; },
    query: sites.query,
  });
  return { code, lines, text: lines.join("\n"), asked, writes: sites.log.slice(start).filter((entry) => entry.kind !== "state").map((entry) => entry.site) };
}

const BOTH = (value) => ({ production: { "features.intelligence.neuro_map": value }, sample: { "features.intelligence.neuro_map": value } });

afterEach(() => { vi.useRealTimers(); });

describe("release-calendar arguments and Eastern times", () => {
  it("needs a name and a reason for every write, and a sane key, day and number of weeks", () => {
    expect(() => parseArgs(["hold", "features.civic.watchlist"])).toThrow(/--by NAME/);
    expect(() => parseArgs(["hold", "features.civic.watchlist", "--by", "Alex Rivera"])).toThrow(/--reason/);
    expect(() => parseArgs(["hold", "limits.casework.deadline_red_days", ...WHO])).toThrow(/switch key/);
    expect(() => parseArgs(["shift", "2026-02-30", "--weeks", "1", ...WHO])).toThrow(/day/);
    for (const weeks of ["0", "9", "-9", "1.5", "x"]) expect(() => parseArgs(["shift", "2026-12-07", "--weeks", weeks, ...WHO]), weeks).toThrow(/--weeks/);
    expect(() => parseArgs(["set", "features.civic.watchlist", "next monday", ...WHO])).toThrow(/Eastern time/);
    expect(() => parseArgs(["list", "--site", "staging"])).toThrow(/--site/);
    expect(() => parseArgs(["hold", "features.civic.watchlist", "--by", "Alex Rivera", "--reason", "a\nb"])).toThrow(/control characters/);
    expect(parseArgs(["move", "features.civic.watchlist", "--weeks", "-2", ...WHO])).toMatchObject({ command: "move", weeks: -2, site: "both", yes: false });
    expect(sqlText("Alex's call")).toBe("'Alex''s call'");
  });

  it("moves the date by whole weeks and keeps the Eastern time of day", () => {
    expect(addWeeks("2027-03-08 09:00", 1)).toBe("2027-03-15 09:00");
    expect(addWeeks("2026-12-28 09:00", 1)).toBe("2027-01-04 09:00");
    expect(addWeeks("2027-01-04 09:00", -2)).toBe("2026-12-21 09:00");
    expect(formatEastern("2027-01-04 09:00")).toBe("Mon Jan 4, 2027, 9:00 AM ET");
    expect(formatEastern("2026-12-07 13:30")).toBe("Mon Dec 7, 2026, 1:30 PM ET");
    expect(formatEastern("2026-12-07 00:00")).toBe("Mon Dec 7, 2026, 12:00 AM ET");
  });

  it("knows which Eastern times do not exist: the spring-forward gap, and only it (#8783)", () => {
    for (const text of ["2027-03-14 02:00", "2027-03-14 02:30", "2027-03-14 02:59", "2028-03-12 02:15"]) expect(easternTimeExists(text), text).toBe(false);
    for (const text of ["2027-03-14 01:59", "2027-03-14 03:00", "2027-03-07 02:30", "2027-11-07 01:30", "2027-11-07 02:30", "2026-12-07 09:00", "2027-01-01 00:00"]) {
      expect(easternTimeExists(text), text).toBe(true);
    }
    expect(easternTimeExists("not a time")).toBe(false);
  });
});

describe("release-calendar on both sites", () => {
  it("lists both sites in Eastern time and marks a switch whose time differs", async () => {
    const same = await run(["list"], fakeSites(BOTH("2026-12-07 09:00 America/New_York")));
    expect(same.code).toBe(0);
    expect(same.text).toContain("features.intelligence.neuro_map\n  Production held until Mon Dec 7, 2026, 9:00 AM ET\n  SAMPLE     held until Mon Dec 7, 2026, 9:00 AM ET");
    const differ = await run(["list"], fakeSites({
      production: { "features.intelligence.neuro_map": "2026-12-14 09:00 America/New_York", "features.civic.watchlist": "infinity" },
      sample: { "features.intelligence.neuro_map": "2026-12-07 09:00 America/New_York" },
    }, { control: { production: true, sample: false } }));
    expect(differ.code).toBe(1);
    expect(differ.text).toContain("DIFFERS features.civic.watchlist\n  Production held, no date\n  SAMPLE     not held here");
    expect(differ.text).toContain("DIFFERS features.intelligence.neuro_map");
    expect(differ.text).toContain("SAMPLE: the release control functions are not applied here yet");
    expect(differ.text).toContain("2 switch(es) differ");
  });

  it("previews without saving when there is no terminal and no --yes, and asks once on a terminal", async () => {
    const sites = fakeSites(BOTH("infinity"));
    const preview = await run(["set", "features.intelligence.neuro_map", "2026-12-07", ...WHO], sites);
    expect(preview.code).toBe(0);
    expect(preview.writes).toEqual([]);
    expect(preview.text).toContain("Production features.intelligence.neuro_map: held, no date -> Mon Dec 7, 2026, 9:00 AM ET");
    expect(preview.text).toContain("Preview only: nothing was saved");
    const declined = await run(["set", "features.intelligence.neuro_map", "2026-12-07", ...WHO], sites, { interactive: true, answer: false });
    expect(declined.asked).toHaveLength(1);
    expect(declined.writes).toEqual([]);
    expect(sites.db.production.get("features.intelligence.neuro_map").release_at).toBe("infinity");
  });

  it("saves on Production, then SAMPLE, and reads both back", async () => {
    const sites = fakeSites(BOTH("2026-12-07 09:00 America/New_York"));
    const moved = await run(["move", "features.intelligence.neuro_map", "--weeks", "1", ...WHO, "--yes"], sites);
    expect(moved.code).toBe(0);
    expect(moved.writes).toEqual(["production", "sample"]);
    for (const site of ["production", "sample"]) expect(sites.db[site].get("features.intelligence.neuro_map").eastern).toBe("2026-12-14 09:00");
    expect(moved.text).toContain("Saved. Now:");
    expect(moved.text).not.toContain("DIFFERS");

    const released = await run(["release", "features.intelligence.neuro_map", ...WHO, "--yes"], sites, {});
    expect(released.code).toBe(0);
    expect(sites.db.production.get("features.intelligence.neuro_map").release_at).toBe(NOW.toISOString());
    expect(sites.db.sample.get("features.intelligence.neuro_map").release_at).toBe(NOW.toISOString());
    expect(released.text).toContain("released Thu Nov 12, 2026, 11:00 PM ET");
  });

  it("stops before SAMPLE when Production refuses, and says how to repair when SAMPLE refuses", async () => {
    const production = fakeSites(BOTH("infinity"), { fail: { production: true } });
    const first = await run(["hold", "features.intelligence.neuro_map", ...WHO, "--yes"], production);
    expect(first.code).toBe(1);
    expect(first.writes).toEqual(["production"]);
    expect(first.text).toContain("Nothing was saved on SAMPLE.");

    const sample = fakeSites(BOTH("infinity"), { fail: { sample: true } });
    const second = await run(["set", "features.intelligence.neuro_map", "2026-12-07 13:30", ...WHO, "--yes"], sample);
    expect(second.code).toBe(1);
    expect(sample.db.production.get("features.intelligence.neuro_map").eastern).toBe("2026-12-07 13:30");
    expect(second.text).toContain("run \"release-calendar.mjs sync\"");
  });

  it("refuses a change while the sites differ, acts on one site on request, and sync repairs SAMPLE", async () => {
    const sites = fakeSites(BOTH("2026-12-07 09:00 America/New_York"));
    const one = await run(["move", "features.intelligence.neuro_map", "--weeks", "2", ...WHO, "--yes", "--site", "production"], sites);
    expect(one.writes).toEqual(["production"]);
    expect(one.code).toBe(1);
    expect(one.text).toContain("DIFFERS features.intelligence.neuro_map");

    const refused = await run(["move", "features.intelligence.neuro_map", "--weeks", "1", ...WHO, "--yes"], sites);
    expect(refused.code).toBe(2);
    expect(refused.text).toMatch(/differs between the sites.*run sync first/);
    expect(refused.writes).toEqual([]);

    const synced = await run(["sync", ...WHO, "--yes"], sites);
    expect(synced.code).toBe(0);
    expect(synced.writes).toEqual(["sample"]);
    expect(sites.db.sample.get("features.intelligence.neuro_map").eastern).toBe("2026-12-21 09:00");
  });

  it("refuses a switch never held, and a move of an undated hold", async () => {
    const sites = fakeSites(BOTH("infinity"));
    const never = await run(["hold", "features.civic.watchlist", ...WHO, "--yes"], sites);
    expect(never.code).toBe(2);
    expect(never.text).toContain("was never held: its first hold is a reviewed migration");
    const undated = await run(["move", "features.intelligence.neuro_map", "--weeks", "1", ...WHO, "--yes"], sites);
    expect(undated.code).toBe(2);
    expect(undated.text).toContain("has no future date to move");
    const missing = await run(["hold", "features.intelligence.neuro_map", ...WHO, "--yes"], fakeSites(BOTH("infinity"), { control: { production: true, sample: false } }));
    expect(missing.code).toBe(2);
    expect(missing.text).toContain("SAMPLE does not have the release control functions yet");
  });

  it("shifts every dated hold from a day on, on both sites, and leaves undated and earlier holds alone", async () => {
    const calendar = {
      "features.intelligence.neuro_map": "2026-12-07 09:00 America/New_York",
      "features.automation.default_recipes": "2026-12-14 09:00 America/New_York",
      "features.civic.watchlist": "2026-11-30 09:00 America/New_York",
      "features.security.sso": "infinity",
    };
    const sites = fakeSites({ production: { ...calendar }, sample: { ...calendar } });
    const shifted = await run(["shift", "2026-12-07", "--weeks", "1", ...WHO, "--yes"], sites);
    expect(shifted.code).toBe(0);
    expect(shifted.writes).toEqual(["production", "sample"]);
    expect(shifted.text).toContain("Production features.automation.default_recipes: held until Mon Dec 14, 2026, 9:00 AM ET -> held until Mon Dec 21, 2026, 9:00 AM ET");
    for (const site of ["production", "sample"]) {
      expect(sites.db[site].get("features.intelligence.neuro_map").eastern).toBe("2026-12-14 09:00");
      expect(sites.db[site].get("features.automation.default_recipes").eastern).toBe("2026-12-21 09:00");
      expect(sites.db[site].get("features.civic.watchlist").eastern).toBe("2026-11-30 09:00");
      expect(sites.db[site].get("features.security.sso").release_at).toBe("infinity");
    }
  });

  it("names a hold only SAMPLE has, saves nothing for it, and never reports nothing to change while the sites differ", async () => {
    const only = fakeSites({
      production: { "features.intelligence.neuro_map": "infinity" },
      sample: { "features.intelligence.neuro_map": "infinity", "features.civic.watchlist": "2026-12-07 09:00 America/New_York" },
    });
    const refused = await run(["sync", ...WHO, "--yes"], only);
    expect(refused.code).toBe(2);
    expect(refused.writes).toEqual([]);
    expect(refused.text).toContain("Cannot sync:\n  features.civic.watchlist: held on SAMPLE (held until Mon Dec 7, 2026, 9:00 AM ET) but has no release time on Production");
    expect(refused.text).toContain("Nothing was saved: the sites still differ");
    expect(refused.text).not.toContain("Nothing to change.");

    const mixed = fakeSites({
      production: { "features.intelligence.neuro_map": "2026-12-14 09:00 America/New_York" },
      sample: { "features.intelligence.neuro_map": "2026-12-07 09:00 America/New_York", "features.civic.watchlist": "infinity" },
    });
    const partly = await run(["sync", ...WHO, "--yes"], mixed);
    expect(partly.writes).toEqual(["sample"]);
    expect(mixed.db.sample.get("features.intelligence.neuro_map").eastern).toBe("2026-12-14 09:00");
    expect(partly.text).toContain("features.civic.watchlist: held on SAMPLE (held, no date)");
    expect(partly.text).toContain("DIFFERS features.civic.watchlist");
    expect(partly.code).toBe(1);
  });

  it("releases at the databases' earliest now, whatever the workstation clock says, and checks it is released", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW.getTime() + 3 * 3600_000)); // the workstation runs three hours fast
    const sampleNow = new Date(NOW.getTime() - 60_000);
    const sites = fakeSites(BOTH("infinity"), { now: { production: NOW, sample: sampleNow } });
    const released = await run(["release", "features.intelligence.neuro_map", ...WHO, "--yes"], sites);
    expect(released.code).toBe(0);
    for (const site of ["production", "sample"]) expect(sites.db[site].get("features.intelligence.neuro_map").release_at).toBe(sampleNow.toISOString());
    expect(released.text).not.toContain("NOT AS SHOWN");

    // A write that leaves both sites held (and so equal) is still a failure.
    const stuck = fakeSites(BOTH("infinity"), { ignoreWrites: { production: true, sample: true } });
    const unreleased = await run(["release", "features.intelligence.neuro_map", ...WHO, "--yes"], stuck);
    expect(unreleased.code).toBe(1);
    expect(unreleased.text).not.toContain("DIFFERS");
    expect(unreleased.text).toContain("NOT AS SHOWN: Production features.intelligence.neuro_map is held, no date, expected released now");
  });

  it("refuses a shift, a move or a set onto a time the clocks skip, before calling either site, and still moves across the fall-back hour (#8783)", async () => {
    const calendar = { "features.intelligence.neuro_map": "2027-03-07 02:30 America/New_York", "features.civic.watchlist": "2027-03-08 09:00 America/New_York" };
    const sites = fakeSites({ production: { ...calendar }, sample: { ...calendar } });
    const shifted = await run(["shift", "2027-03-01", "--weeks", "1", ...WHO, "--yes"], sites);
    expect(shifted.code).toBe(2);
    expect(shifted.writes).toEqual([]);
    expect(shifted.text).toContain("Refused: features.intelligence.neuro_map would move to 2027-03-14 02:30, which does not exist in Eastern time");
    const moved = await run(["move", "features.intelligence.neuro_map", "--weeks", "1", ...WHO, "--yes"], sites);
    expect(moved.code).toBe(2);
    expect(moved.writes).toEqual([]);
    const set = await run(["set", "features.civic.watchlist", "2027-03-14 02:30", ...WHO, "--yes"], sites);
    expect(set.code).toBe(2);
    expect(set.writes).toEqual([]);
    for (const site of ["production", "sample"]) expect(sites.db[site].get("features.intelligence.neuro_map").eastern).toBe("2027-03-07 02:30");

    const fall = { "features.intelligence.neuro_map": "2027-10-31 01:30 America/New_York" };
    const autumn = fakeSites({ production: { ...fall }, sample: { ...fall } });
    const across = await run(["shift", "2027-10-30", "--weeks", "1", ...WHO, "--yes"], autumn);
    expect(across.code).toBe(0);
    expect(across.writes).toEqual(["production", "sample"]);
    for (const site of ["production", "sample"]) expect(autumn.db[site].get("features.intelligence.neuro_map").eastern).toBe("2027-11-07 01:30");
  });

  it("refuses a shift when the holds changed after the preview, and saves nothing on either site", async () => {
    const calendar = { "features.intelligence.neuro_map": "2026-12-07 09:00 America/New_York" };
    const sites = fakeSites({ production: { ...calendar }, sample: { ...calendar } }, {
      // Someone dates another hold on Production between the preview and the save.
      beforeWrite: (db) => db.production.set("features.civic.watchlist", row("2026-12-21 09:00 America/New_York")),
    });
    const shifted = await run(["shift", "2026-12-07", "--weeks", "1", ...WHO, "--yes"], sites);
    expect(shifted.code).toBe(1);
    expect(shifted.writes).toEqual(["production"]);
    expect(shifted.text).toContain("Production refused: PT409 the calendar changed since the preview");
    expect(shifted.text).toContain("Nothing was saved on SAMPLE.");
    expect(sites.db.production.get("features.intelligence.neuro_map").eastern).toBe("2026-12-07 09:00");
    expect(sites.db.production.get("features.civic.watchlist").eastern).toBe("2026-12-21 09:00");
    expect(sites.db.sample.get("features.intelligence.neuro_map").eastern).toBe("2026-12-07 09:00");
  });
});
