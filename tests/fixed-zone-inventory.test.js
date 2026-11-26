// REQ-UG-TIME-ZONES-PER-GROUP-20261122 (#9446): the list of what
// still works on one fixed time zone only shrinks, and the scan and the
// catalog reader that build it classify text as the contract says.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { nextSourceInventory } from "../scripts/fixed-zone-inventory.mjs";
import { classifyDatabaseText, databaseInventoryDifferences, firesAtStatedHours } from "../scripts/lib/fixed-zone-db.mjs";
import {
  FOUNDATION_MIGRATION,
  INVENTORY_PATH,
  KINDS,
  baseSourceInventory,
  checkFixedZones,
  countFixedZoneLines,
  fixedZoneFindings,
  inventoryGrowth,
  sourceTotals,
  withoutComments,
  fixedZoneMigrationFindings,
  fixedZoneMigrationLines,
  readFixedZoneInventory,
  scanFixedZoneMigrations,
  sqlWithoutComments,
  scanFixedZones,
} from "../scripts/lib/fixed-zone-scan.mjs";

const root = resolve(import.meta.dirname, "..");

describe("the fixed-zone source scan", () => {
  it("counts lines that name Eastern time, read the device zone or take the UTC day", () => {
    expect(countFixedZoneLines([
      'const when = format(value, { timeZone: "America/New_York" });',
      "return `${clock} ET`;",
      "import { easternDay } from './easternTime';",
      'const label = daylight ? "EDT" : "EST";',
      "const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;",
      "date.setMinutes(date.getMinutes() - date.getTimezoneOffset());",
      "const today = new Date().toISOString().slice(0, 10);",
    ].join("\n"))).toEqual({ fixed: 4, device: 2, utcDay: 1 });
  });

  it("ignores comments, words that only contain the letters, and marked lines", () => {
    expect(countFixedZoneLines([
      "// Updated October 16, 2026.",
      "/*",
      " * Eastern day, see the contract.",
      "   a line of the block with no star, shown in ET",
      " */",
      "const a = 1; // counted in ET until the group zone lands",
      "{/* the Eastern label",
      "    over two lines, EST or EDT */}",
      'const tag = "<meta name=\\"budget\\">"; const set = "PRESET"; const word = "Western";',
      'export const UNSET = "America/New_York"; // fixed-zone: the value before a group\'s zone is delivered',
      "const zone = Intl.DateTimeFormat().resolvedOptions().timeZone; // device-zone: a suggestion on the creation form",
      "const key = new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10); // utc-day: a date built at UTC midnight",
    ].join("\n"))).toEqual({});
    // A marker needs a reason, and a marker of one kind does not excuse another.
    expect(countFixedZoneLines('const z = "America/New_York"; // fixed-zone:')).toEqual({ fixed: 1 });
    expect(countFixedZoneLines('const z = "America/New_York"; // utc-day: no')).toEqual({ fixed: 1 });
  });

  it("knows a string, a template and a regular expression from a comment", () => {
    // Two slashes inside a string start nothing, so the code after them still counts.
    expect(countFixedZoneLines('const hint = "See // help"; const zone = "America/New_York";')).toEqual({ fixed: 1 });
    expect(countFixedZoneLines('const url = "https://example.invalid/a"; const label = "ET";')).toEqual({ fixed: 1 });
    expect(countFixedZoneLines("const text = `at ${hour /* ET */} // still the template, ET`;")).toEqual({ fixed: 1 });
    expect(countFixedZoneLines("const found = /\\/\\/ET/.test(line); // ET in the note")).toEqual({ fixed: 1 });
    expect(countFixedZoneLines("const half = total / 2; // ET\nconst rate = a / b; const label = 'EST';")).toEqual({ fixed: 1 });
    expect(withoutComments("a(); // note\n/* two\nlines */ b();")).toBe("a();        \n      \n         b();");
    // An unfinished block comment runs to the end of the file.
    expect(countFixedZoneLines("const a = 1; /* ET\nconst zone = 'America/New_York';")).toEqual({});
  });

  it("takes a reason from a comment on the line above, and knows a place from a clock", () => {
    // A trailing comment inside a template would be text, so the reason sits above the line.
    expect(countFixedZoneLines("// fixed-zone: ET here is the PDF end-text operator, not a time zone\npage.push(`BT /F1 8 Tf (${text}) Tj ET`);")).toEqual({});
    expect(countFixedZoneLines("  {/* fixed-zone: the operator's own screen stays Eastern */}\n  <p>{clock} ET</p>")).toEqual({});
    // The line above must be a comment, and its reason reaches one line only.
    expect(countFixedZoneLines('const why = "fixed-zone: not a comment";\nconst label = "ET";')).toEqual({ fixed: 1 });
    expect(countFixedZoneLines('// fixed-zone: the first label only\nconst a = "ET";\nconst b = "EST";')).toEqual({ fixed: 1 });
    expect(countFixedZoneLines("// utc-day: a civil date\nconst a = \"ET\";")).toEqual({ fixed: 1 });
    expect(countFixedZoneLines('{ "note": "Stored in Eastern North America (ENAM)." }')).toEqual({});
    expect(countFixedZoneLines('{ "note": "All times are Eastern." }')).toEqual({ fixed: 1 });
    const { source } = readFixedZoneInventory(root);
    expect(source["api/_lib/filingShaper.js"]).toBeUndefined();
    expect(source["src/data/subprocessors.json"]).toBeUndefined();
    expect(source["src/components/AuthScreen.jsx"]).toBeUndefined();
    expect(source["src/lib/formFilingPdf.js"]).toEqual({ fixed: 2 });
  });

  it("blanks a comment by the string's own offsets, so an emoji before it hides nothing", () => {
    const emoji = "\u{1F600}";
    // Gate stage 527: spreading the text made one entry of an emoji, and every blank after it landed too far right.
    expect(countFixedZoneLines(`const s = "${emoji.repeat(32)}"; // ${"x".repeat(40)}\nconst zone = "America/New_York";`)).toEqual({ fixed: 1 });
    expect(countFixedZoneLines(`const s = "${emoji.repeat(3)}"; /* note */ const zone = "America/New_York";`)).toEqual({ fixed: 1 });
    const source = `const s = "${emoji}"; // a note\nconst after = 1;`;
    expect(withoutComments(source)).toHaveLength(source.length);
    expect(withoutComments(source)).toBe(`const s = "${emoji}";          \nconst after = 1;`);
  });

  it("counts a match that runs over a line break once, where it starts", () => {
    expect(countFixedZoneLines("const day = date.toISOString()\n  .slice(0, 10);")).toEqual({ utcDay: 1 });
    expect(countFixedZoneLines("const zone = Intl.DateTimeFormat().resolvedOptions()\n  .timeZone;")).toEqual({ device: 1 });
    expect(countFixedZoneLines("const day = date.toISOString()\n  .slice(0, 10); // utc-day: a civil date")).toEqual({});
    expect(countFixedZoneLines('const a = "ET"; const b = "EST";\nconst c = "EDT";')).toEqual({ fixed: 2 });
  });

  it("refuses a new file or a higher count, and asks for a lower one when lines go", () => {
    const known = { "src/a.js": { fixed: 2 }, "src/gone.js": { device: 1 }, "src/b.js": { fixed: 1, utcDay: 3 } };
    expect(fixedZoneFindings({ counts: { "src/a.js": { fixed: 2 }, "src/gone.js": { device: 1 }, "src/b.js": { fixed: 1, utcDay: 3 } }, known })).toEqual([]);
    const failures = fixedZoneFindings({
      counts: { "src/a.js": { fixed: 3 }, "src/new.js": { device: 1 }, "src/b.js": { utcDay: 1 } },
      known,
    });
    expect(failures).toEqual([
      expect.stringMatching(/^src\/a\.js: 3 line\(s\) that name New York's zone or Eastern time \(known 2\); take the zone from the item's group .*"fixed-zone: <why>" at the end of the line or in a comment on the line above$/u),
      expect.stringMatching(/^src\/new\.js: 1 line\(s\) that read the device's time zone \(known 0\)/u),
      `${INVENTORY_PATH}: src/gone.js no longer has a line that would read the device's time zone; remove its "device" entry`,
      `${INVENTORY_PATH}: src/b.js no longer has a line that would name New York's zone or Eastern time; remove its "fixed" entry`,
      `${INVENTORY_PATH}: src/b.js now has 1 line(s) that take the UTC day of an instant as a date; lower its "utcDay" count from 3 to 1`,
    ]);
    expect(fixedZoneFindings({ counts: {}, known: { "src/a.js": { sideways: 1 } } })).toEqual([`${INVENTORY_PATH}: src/a.js has an unknown kind "sideways"`]);
  });

  it("matches the saved list for this repository, which names real files and no test", () => {
    const inventory = readFixedZoneInventory(root);
    const counts = scanFixedZones(root);
    expect(fixedZoneFindings({ counts, known: inventory.source })).toEqual([]);
    expect(Object.keys(inventory.source)).toEqual(Object.keys(inventory.source).toSorted());
    for (const [path, kinds] of Object.entries(inventory.source)) {
      expect(path).toMatch(/^(?:src|apps\/mobile\/src|api)\//u);
      expect(path).not.toMatch(/\.test\./u);
      for (const [kind, count] of Object.entries(kinds)) {
        expect(Object.keys(KINDS)).toContain(kind);
        expect(Number.isInteger(count) && count > 0, `${path} ${kind}`).toBe(true);
      }
    }
    // The zone module itself carries its two constants with their reasons.
    expect(inventory.source["src/lib/zoneTime.js"]).toBeUndefined();
  });

  it("refuses a list whose totals rose against the list on main, and lets a file be renamed or split", () => {
    const base = { "src/a.js": { fixed: 3, utcDay: 1 }, "src/b.js": { fixed: 1 } };
    expect(sourceTotals(base)).toEqual({ fixed: 4, utcDay: 1 });
    expect(inventoryGrowth(base, base)).toEqual([]);
    expect(inventoryGrowth(base, { "src/a.js": { fixed: 2 }, "src/moved.js": { fixed: 2, utcDay: 1 } })).toEqual([]);
    expect(inventoryGrowth(base, { "src/a.js": { fixed: 1 } })).toEqual([]);
    // The bypass: one more line in the code and one more in the list.
    expect(inventoryGrowth(base, { "src/a.js": { fixed: 4, utcDay: 1 }, "src/b.js": { fixed: 1 }, "src/new.js": { device: 1 } })).toEqual([
      expect.stringMatching(/^config\/fixed-zone-inventory\.json: its lines that name New York's zone or Eastern time rose from 4 on main to 5; the list only shrinks/u),
      expect.stringMatching(/^config\/fixed-zone-inventory\.json: its lines that read the device's time zone rose from 0 on main to 1; the list only shrinks/u),
    ]);
    // No list on main yet, or a base that cannot be read: nothing to compare.
    expect(inventoryGrowth(null, { "src/a.js": { fixed: 9 } })).toEqual([]);
    expect(inventoryGrowth(undefined, { "src/a.js": { fixed: 9 } })).toEqual([]);
  });

  it("reads the list at the merge base from git, and refuses a raised list in a real checkout", () => {
    const repo = mkdtempSync(join(tmpdir(), "fixed-zone-base-"));
    const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const write = (path, body) => { mkdirSync(join(repo, path, ".."), { recursive: true }); writeFileSync(join(repo, path), body); };
    // The run's own base (CI names one) must not reach this checkout.
    const env = { ...process.env, CI_BASE_SHA: "", WORKLIST_BASE_REF: "" };
    const check = () => { const failures = []; checkFixedZones(repo, (message) => failures.push(message), env); return failures; };
    try {
      expect(baseSourceInventory(repo, env)).toBeUndefined();
      git("init", "-q", "-b", "main");
      write("src/a.js", 'export const label = "ET";\n');
      git("add", "-A"); git("commit", "-q", "-m", "base without a list");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      expect(baseSourceInventory(repo, env)).toBeNull();
      // The first list may be any size.
      write(INVENTORY_PATH, JSON.stringify({ source: { "src/a.js": { fixed: 1 } } }));
      git("add", "-A");
      expect(check()).toEqual([]);
      git("commit", "-q", "-m", "the first list");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      expect(baseSourceInventory(repo, env)).toEqual({ "src/a.js": { fixed: 1 } });
      // One more line beside one more in the list.
      git("checkout", "-q", "-b", "lane");
      write("src/a.js", 'export const label = "ET";\nexport const other = "EST";\n');
      write(INVENTORY_PATH, JSON.stringify({ source: { "src/a.js": { fixed: 2 } } }));
      git("add", "-A");
      expect(check()).toEqual([expect.stringContaining("rose from 1 on main to 2")]);
      git("commit", "-q", "-m", "raised");
      expect(check()).toEqual([expect.stringContaining("rose from 1 on main to 2")]);
      // Moving the line to a new file is not growth.
      write("src/a.js", "export const none = 1;\n");
      write("src/b.js", 'export const label = "ET";\n');
      write(INVENTORY_PATH, JSON.stringify({ source: { "src/b.js": { fixed: 1 } } }));
      git("add", "-A");
      expect(check()).toEqual([]);
      // The base named by CI wins over origin/main.
      expect(baseSourceInventory(repo, { ...env, CI_BASE_SHA: git("rev-parse", "main~1").trim() })).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("writes a list that only shrinks", () => {
    expect(nextSourceInventory(undefined, { "src/b.js": { fixed: 1 }, "src/a.js": { utcDay: 2, fixed: 1 } }))
      .toEqual({ source: { "src/a.js": { fixed: 1, utcDay: 2 }, "src/b.js": { fixed: 1 } }, refused: [] });
    expect(nextSourceInventory({ "src/a.js": { fixed: 4 }, "src/gone.js": { device: 1 } }, { "src/a.js": { fixed: 2 } }))
      .toEqual({ source: { "src/a.js": { fixed: 2 } }, refused: [] });
    expect(nextSourceInventory({ "src/a.js": { fixed: 1 } }, { "src/a.js": { fixed: 2 }, "src/new.js": { device: 1 } }).refused)
      .toEqual(["src/a.js: fixed would rise from 1 to 2", "src/new.js: device would rise from 0 to 1"]);
  });
});

describe("the fixed-zone migration rule", () => {
  it("finds New York's zone and the Eastern day helper in SQL, not in comments or marked lines", () => {
    expect(fixedZoneMigrationLines([
      "-- was (now() at time zone 'America/New_York')::date before the group helper",
      "  v_today := private.eastern_day();",
      "  v_day := (p_at AT TIME ZONE 'America/New_York')::date;",
      "  v_day := private.local_day(private.group_time_zone(v_org, v_chapter));",
      "  return 'America/New_York'; -- fixed-zone: what every group reads until the switch is released",
      "  select private.eastern_day(p_at); -- fixed-zone:",
      "  select eastern_day_count from totals;",
    ].join("\n"))).toEqual([2, 3, 6]);
    expect(fixedZoneMigrationFindings({ "supabase/migrations/20270101000000_x.sql": [4] })).toEqual([
      expect.stringMatching(/^supabase\/migrations\/20270101000000_x\.sql:4: names New York's zone or calls private\.eastern_day; take the zone from the item's group with private\.group_time_zone\(organization, chapter, unit\).*"-- fixed-zone:" comment on that line or the line above$/u),
    ]);
  });

  it("reads SQL as SQL: across a line break, past hyphens in a string, and not inside a block comment", () => {
    // Gate stage 527: the rule read one line at a time.
    expect(fixedZoneMigrationLines("select private.eastern_day\n  ();")).toEqual([1]);
    expect(fixedZoneMigrationLines("select private . eastern_day (\n  p_at);")).toEqual([1]);
    expect(fixedZoneMigrationLines("select 'a -- b', 'America/New_York';")).toEqual([1]);
    expect(fixedZoneMigrationLines("select \"odd -- name\", (p_at at time zone 'America/New_York')::date;")).toEqual([1]);
    expect(fixedZoneMigrationLines("select E'it\\'s -- not a comment', private.eastern_day();")).toEqual([1]);
    expect(fixedZoneMigrationLines("select 'it''s -- not a comment', private.eastern_day();")).toEqual([1]);
    expect(fixedZoneMigrationLines("/* was America/New_York\n /* nested */ and private.eastern_day() */\nselect 1;")).toEqual([]);
    expect(fixedZoneMigrationLines("/* history */ select private.eastern_day(); /* America/New_York */")).toEqual([1]);
    // A dollar-quoted block that is not a routine's body is a string: its hyphens and
    // slashes are content and hide nothing after it (final round of #9475).
    expect(fixedZoneMigrationLines("select $note$--$note$, (now() at time zone 'America/New_York')::date;")).toEqual([1]);
    expect(fixedZoneMigrationLines("select $$--$$, 'America/New_York';")).toEqual([1]);
    expect(fixedZoneMigrationLines("do $block$\nbegin\n  perform $text$/*$text$;\n  perform private.eastern_day();\nend $block$;")).toEqual([4]);
    expect(fixedZoneMigrationLines("create function f() returns date language sql AS $f$\n  -- was private.eastern_day()\n  select 1;\n$f$;\nselect private.eastern_day();")).toEqual([5]);
    expect(fixedZoneMigrationLines("select pg_catalog.format($sql$select $1 -- a note$sql$), private.eastern_day();")).toEqual([1]);
    // The helper's name written as a quoted name is still the helper; a longer name is not.
    expect(fixedZoneMigrationLines('select private."eastern_day"();')).toEqual([1]);
    expect(fixedZoneMigrationLines('select "private"."eastern_day" (p_at);')).toEqual([1]);
    expect(fixedZoneMigrationLines("select private.far_eastern_day(), my_eastern_day_count from totals;")).toEqual([]);
    // A dollar-quoted body is code.
    expect(fixedZoneMigrationLines("create function f() returns date language sql as $body$\n  select private.eastern_day();\n$body$;")).toEqual([2]);
    // So is a DO block's, with or without its language named, and its comments stay comments.
    expect(fixedZoneMigrationLines("do language plpgsql $body$\nbegin\n  -- was America/New_York before part 3\n  perform 1;\nend;\n$body$;")).toEqual([]);
    expect(fixedZoneMigrationLines("DO LANGUAGE plpgsql $body$\nbegin\n  perform private.eastern_day();\nend;\n$body$;")).toEqual([3]);
    expect(fixedZoneMigrationLines("do $body$\nbegin\n  -- was America/New_York\n  perform private.eastern_day();\nend;\n$body$;")).toEqual([4]);
    // A quoted language name is still the language.
    for (const name of ['"plpgsql"', "'plpgsql'"]) {
      expect(fixedZoneMigrationLines(`do language ${name} $body$\nbegin\n  -- was America/New_York\n  perform 1;\nend;\n$body$;`), name).toEqual([]);
      expect(fixedZoneMigrationLines(`DO LANGUAGE ${name} $body$\nbegin\n  perform private.eastern_day();\nend;\n$body$;`), name).toEqual([3]);
    }
    // A tag may carry digits after its first character, and hides nothing.
    expect(fixedZoneMigrationLines("select $tag1$--$tag1$, private.eastern_day();")).toEqual([1]);
    expect(fixedZoneMigrationLines("select $t_2x$ America/New_York $t_2x$;")).toEqual([1]);
    expect(fixedZoneMigrationLines("create function f() returns date language sql as $fn2$\n  select private.eastern_day();\n$fn2$;")).toEqual([2]);
    // The reason: on a line the match covers, or in a comment line directly above.
    expect(fixedZoneMigrationLines("-- fixed-zone: report periods stay on New York's zone until part 5\nselect private.eastern_day();")).toEqual([]);
    expect(fixedZoneMigrationLines("select private.eastern_day\n  (); -- fixed-zone: report periods stay")).toEqual([]);
    expect(fixedZoneMigrationLines("select 1; -- fixed-zone: not a comment line\nselect private.eastern_day();")).toEqual([2]);
    expect(fixedZoneMigrationLines("-- fixed-zone: the first only\nselect private.eastern_day();\nselect private.eastern_day();")).toEqual([3]);
    expect(sqlWithoutComments("select 1; -- note\n/* a /* b */ c */ select 2;")).toBe("select 1;        \n                  select 2;");
  });

  it("holds every migration from the foundation on, whatever stamp the foundation ends with", () => {
    const paths = execFileSync("git", ["-C", root, "ls-files", "supabase/migrations"], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
    const foundation = paths.filter((path) => FOUNDATION_MIGRATION.test(path));
    expect(foundation).toHaveLength(1);
    expect(scanFixedZoneMigrations(root)).toEqual({});
    // The foundation names the zone twice, each time with its reason.
    const sql = readFileSync(join(root, foundation[0]), "utf8");
    expect(sql.split("\n").filter((line) => /America\/New_York/u.test(line.replace(/--.*$/u, "")) && /--\s*fixed-zone:\s*\S/u.test(line))).toHaveLength(2);
    // An older migration is history and is not read.
    expect(fixedZoneMigrationLines(readFileSync(join(root, "supabase/migrations/20261113122500_eastern_day_helper.sql"), "utf8")).length).toBeGreaterThan(0);
    expect(scanFixedZoneMigrations(root, ["supabase/migrations/20261113122500_eastern_day_helper.sql"])).toEqual({});
    expect(Object.keys(scanFixedZoneMigrations(root, ["supabase/migrations/20261113122400_group_time_zones_foundation.sql", "supabase/migrations/20261113122500_eastern_day_helper.sql"])))
      .toEqual(["supabase/migrations/20261113122500_eastern_day_helper.sql"]);
  });
});

describe("the fixed-zone catalog reader", () => {
  it("classifies database text by what it does with the clock", () => {
    expect(classifyDatabaseText("select (p_at at time zone 'America/New_York')::date")).toEqual(["fixed"]);
    expect(classifyDatabaseText("v_today := private.eastern_day();")).toEqual(["fixed"]);
    expect(classifyDatabaseText("CURRENT_DATE")).toEqual(["sessionDay"]);
    expect(classifyDatabaseText("where due_on < (pg_catalog.now())::date")).toEqual(["sessionDay"]);
    expect(classifyDatabaseText("select date_trunc('week', pg_catalog.now())")).toEqual(["sessionDay"]);
    expect(classifyDatabaseText("select date_trunc('day'::text, now())")).toEqual(["sessionDay"]);
    expect(classifyDatabaseText("(now() AT TIME ZONE 'UTC'::text)")).toEqual(["utc"]);
    expect(classifyDatabaseText("select timezone('UTC', created_at)::date, current_date, private.eastern_day(created_at)")).toEqual(["fixed", "sessionDay", "utc"]);
    // A group's own zone, a plain instant and a comment are not listed.
    expect(classifyDatabaseText("select (p_at at time zone p_zone)::date")).toEqual([]);
    expect(classifyDatabaseText("select pg_catalog.now() - interval '3 days'")).toEqual([]);
    expect(classifyDatabaseText("-- was current_date before 20261113\n/* America/New_York */ select 1")).toEqual([]);
    expect(classifyDatabaseText(null)).toEqual([]);
  });

  it("knows a schedule that fires at stated hours from one that runs all day", () => {
    for (const schedule of ["5 13 * * *", "7-47/20 13-23 * * *", "8-58/10 13-23 * * 1", "23 10 * * *", "10 3 * * 1", "0 0,12 * * *"]) expect(firesAtStatedHours(schedule), schedule).toBe(true);
    for (const schedule of ["* * * * *", "*/5 * * * *", "41 * * * *", "17 */2 * * *", "30 seconds", ""]) expect(firesAtStatedHours(schedule), schedule).toBe(false);
  });

  it("says what differs between the saved list and the catalog", () => {
    const saved = {
      functions: [{ name: "private.a()", kinds: ["fixed"] }, { name: "private.gone()", kinds: ["utc"] }, { name: "private.same()", kinds: ["fixed", "utc"] }],
      scheduledJobs: [{ name: "digest", schedule: "5 13 * * *", kinds: ["fixedHour"] }],
    };
    const live = {
      functions: [{ name: "private.a()", kinds: ["fixed", "sessionDay"] }, { name: "private.new()", kinds: ["sessionDay"] }, { name: "private.same()", kinds: ["fixed", "utc"] }],
      scheduledJobs: [{ name: "digest", schedule: "5 * * * *", kinds: [] }],
      views: [{ name: "public.v", kinds: ["utc"] }],
    };
    expect(databaseInventoryDifferences(saved, live)).toEqual([
      "functions: private.a() is listed as fixed and is now fixed,sessionDay",
      "functions: private.gone() is listed and no longer uses a fixed zone or no longer exists; remove it",
      "functions: private.new() is not listed (sessionDay); take its zone from the group, or add it with its kinds",
      "scheduledJobs: digest is listed as fixedHour 5 13 * * * and is now 5 * * * *",
      "views: public.v is not listed (utc); take its zone from the group, or add it with its kinds",
    ]);
    expect(databaseInventoryDifferences(saved, saved)).toEqual([]);
  });

  it("keeps a database list whose rows are sorted and carry known kinds", () => {
    const { readFrom, ...groups } = readFixedZoneInventory(root).database;
    expect(readFrom.newestMigration).toMatch(/^\d{14}$/u);
    expect(Object.keys(groups).toSorted()).toEqual(["columnDefaults", "constraints", "functions", "indexes", "policies", "scheduledJobs", "triggers", "views"]);
    for (const [group, rows] of Object.entries(groups)) {
      expect(rows.map((row) => row.name), group).toEqual(rows.map((row) => row.name).toSorted());
      for (const row of rows) {
        expect(row.kinds.length, `${group} ${row.name}`).toBeGreaterThan(0);
        for (const kind of row.kinds) expect(["fixed", "sessionDay", "utc", "fixedHour"]).toContain(kind);
      }
    }
    expect(groups.functions.find((row) => row.name === "private.eastern_day(timestamp with time zone)")?.kinds).toEqual(["fixed"]);
  });
});
