// REQ-UG-TIME-ZONES-PER-GROUP-20261122 (#9446), part 2: on a
// disposable migrated database, a group's time zone is stored as a region
// Postgres knows, is read only through private.group_time_zone (the unit's,
// else the chapter's, else the organization's), answers New York's zone for
// everyone while the switch is held, never crosses an organization, and a
// day and its start are worked out in any zone exactly as src/lib/zoneTime.js
// does. Everything runs in one transaction that rolls back.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { zoneDay, zoneMidnight } from "../src/lib/zoneTime.js";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const SWITCH = "features.governance.group_time_zones";
const UNSET = "America/New_York";
// The test grid of the contract, with the regions whose midnight is skipped
// or repeated (Havana) and that move by two hours (Troll) or half an hour
// (Lord Howe).
const GRID = [
  "America/Los_Angeles", "America/Phoenix", "America/New_York", "Europe/Berlin", "Asia/Kolkata", "Asia/Kathmandu",
  "Asia/Tokyo", "Australia/Sydney", "Australia/Lord_Howe", "Pacific/Chatham", "America/Havana", "America/Santiago",
  "Antarctica/Troll", "Pacific/Kiritimati",
];

live("group time zones on a migrated database", () => {
  let db;
  const f = {
    org: randomUUID(), otherOrg: randomUUID(), unit: randomUUID(), plainUnit: randomUUID(), otherUnit: randomUUID(),
    chapter: `tz-a-${randomUUID()}`, plainChapter: `tz-b-${randomUUID()}`, otherChapter: `tz-c-${randomUUID()}`,
  };
  const value = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.v ?? null;
  const zone = (org, chapter = null, unit = null) => value("select private.group_time_zone($1::uuid, $2::text, $3::uuid) as v", [org, chapter, unit]);
  const refused = async (sql, args = []) => {
    await db.query("savepoint cell");
    try {
      await db.query(sql, args);
      await db.query("release savepoint cell");
      return null;
    } catch (error) {
      await db.query("rollback to savepoint cell");
      return error.code;
    }
  };
  const release = (held) => db.query("update public.platform_setting_definitions set release_at = $2 where key = $1", [SWITCH, held ? "infinity" : null]);

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "group-time-zones-proof" });
    await db.connect();
    await db.query("set statement_timeout = '60s'");
    await db.query("begin");
    await db.query("insert into public.organizations(id,slug,name) values ($1::uuid,$1::text,'Fictional Zone Local'),($2::uuid,$2::text,'Fictional Other Local')", [f.org, f.otherOrg]);
    await db.query(
      "insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,'Zone chapter',$1,$4,9971),($2,'Plain chapter',$2,$4,9972),($3,'Other chapter',$3,$5,9973)",
      [f.chapter, f.plainChapter, f.otherChapter, f.org, f.otherOrg],
    );
    await db.query(
      "insert into private.chapter_units(id,organization_id,chapter_id,name) values ($1,$4,$5,'Zone worksite'),($2,$4,$5,'Plain unit'),($3,$6,$7,'Other unit')",
      [f.unit, f.plainUnit, f.otherUnit, f.org, f.chapter, f.otherOrg, f.otherChapter],
    );
    // Stores one zone on one row through the table's own check and says whether it was kept;
    // made in this transaction and rolled back with it.
    await db.query(`
      create function private.group_time_zone_probe_store(p_table text, p_id text, p_zone text) returns boolean
      language plpgsql set search_path = '' as $probe$
      declare kept text;
      begin
        execute pg_catalog.format('update %s set time_zone = $1 where id::text = $2 returning time_zone', p_table::regclass)
          into kept using p_zone, p_id;
        return kept is not distinct from p_zone;
      exception when others then
        return false;
      end $probe$`);
  }, 120_000);

  afterAll(async () => {
    await db?.query("rollback").catch(() => {});
    await db?.end();
  });

  it("stores a zone on each level and accepts only a region Postgres knows", async () => {
    expect(await value("select time_zone as v from public.organizations where id = $1", [f.org])).toBe(UNSET);
    expect(await value("select time_zone as v from public.chapters where id = $1", [f.chapter])).toBeNull();
    expect(await value("select time_zone as v from private.chapter_units where id = $1", [f.unit])).toBeNull();
    for (const [table, key, id] of [["public.organizations", "id", f.org], ["public.chapters", "id", f.chapter], ["private.chapter_units", "id", f.unit]]) {
      // A region the server's time zone data does not know: Postgres itself refuses it.
      expect(await refused(`update ${table} set time_zone = 'Mars/Olympus_Mons' where ${key} = $1`, [id]), table).toBe("22023");
      // Not a region name: an abbreviation, an offset, a POSIX rule, a bare word, a lower-case area.
      for (const notRegion of ["EST", "-05:00", "EST5EDT", "UTC", "america/chicago", "America/", "", " America/Chicago"]) {
        expect(await refused(`update ${table} set time_zone = $2 where ${key} = $1`, [id, notRegion]), `${table} ${notRegion}`).toBe("23514");
      }
    }
    expect(await refused("update public.organizations set time_zone = null where id = $1", [f.org])).toBe("23502");
    expect(await refused("update public.organizations set time_zone = 'Europe/Berlin' where id = $1", [f.org])).toBeNull();
    expect(await refused("update public.chapters set time_zone = 'America/Los_Angeles' where id = $1", [f.chapter])).toBeNull();
    expect(await refused("update private.chapter_units set time_zone = 'Asia/Kathmandu' where id = $1", [f.unit])).toBeNull();
    // Every region name the server knows is really stored, through each table's own check
    // (gate stage 527: a pattern query alone proves the shape, not the check).
    const regions = (await db.query("select name from pg_catalog.pg_timezone_names where name ~ '/' order by name")).rows.map((row) => row.name);
    expect(regions.length).toBeGreaterThan(300);
    for (const [table, id] of [["public.organizations", f.otherOrg], ["public.chapters", f.otherChapter], ["private.chapter_units", f.otherUnit]]) {
      const stored = await value(`
        with tried as (
          select n.name, private.group_time_zone_probe_store('${table}', $1, n.name) as kept
            from pg_catalog.unnest($2::text[]) n(name)
        ) select count(*) filter (where kept)::int as v from tried`, [id, regions]);
      expect(stored, table).toBe(regions.length);
    }
    await db.query("update public.organizations set time_zone = 'America/New_York' where id = $1", [f.otherOrg]);
    await db.query("update public.chapters set time_zone = null where id = $1", [f.otherChapter]);
    await db.query("update private.chapter_units set time_zone = null where id = $1", [f.otherUnit]);
    // The check is the floor: every region of the list passes it, on every level.
    expect(await value(`
      select count(*)::int as v from private.iana_timezone_names n
       where n.name ~ '/' and not (n.name ~ '^[A-Z][A-Za-z_]*(/[A-Za-z0-9_+-]+)+$')`)).toBe(0);
    // No foreign key joins these tables to the list (the list may lack a region the server has).
    expect(await value(`
      select count(*)::int as v from pg_catalog.pg_constraint k
       where k.contype = 'f' and k.confrelid = 'private.iana_timezone_names'::regclass`)).toBe(0);
  });

  it("is created held, and while held every group reads New York's zone whatever is stored", async () => {
    const row = (await db.query("select value_kind, default_value, member_visible, organization_editable, release_at::text as held from public.platform_setting_definitions where key = $1", [SWITCH])).rows[0];
    expect(row).toEqual({ value_kind: "boolean", default_value: true, member_visible: false, organization_editable: false, held: "infinity" });
    expect(await value("select private.group_time_zones_released($1) as v", [f.org])).toBe(false);
    expect(await value("select private.group_time_zones_released(null) as v")).toBe(false);
    expect(await zone(f.org)).toBe(UNSET);
    expect(await zone(f.org, f.chapter)).toBe(UNSET);
    expect(await zone(f.org, f.chapter, f.unit)).toBe(UNSET);
    // Held, a lookup still refuses a group that is not there.
    expect(await refused("select private.group_time_zone($1::uuid, $2::text)", [f.org, f.otherChapter])).toBe("22023");
  });

  it("released, answers the unit's zone, else the chapter's, else the organization's", async () => {
    await release(false);
    expect(await value("select private.group_time_zones_released($1) as v", [f.org])).toBe(true);
    expect(await zone(f.org)).toBe("Europe/Berlin");
    expect(await zone(f.org, f.chapter)).toBe("America/Los_Angeles");
    expect(await zone(f.org, f.chapter, f.unit)).toBe("Asia/Kathmandu");
    expect(await zone(f.org, f.chapter, f.plainUnit)).toBe("America/Los_Angeles");
    expect(await zone(f.org, f.plainChapter)).toBe("Europe/Berlin");
    expect(await zone(f.otherOrg, f.otherChapter, f.otherUnit)).toBe(UNSET);
    // A chapter that drops its own zone goes back to the organization's.
    await db.query("update public.chapters set time_zone = null where id = $1", [f.chapter]);
    expect(await zone(f.org, f.chapter)).toBe("Europe/Berlin");
    expect(await zone(f.org, f.chapter, f.unit)).toBe("Asia/Kathmandu");
    await db.query("update public.chapters set time_zone = 'America/Los_Angeles' where id = $1", [f.chapter]);
  });

  it("refuses a group that is unknown or belongs to another organization, held or released", async () => {
    for (const held of [false, true]) {
      await release(held);
      const cases = [
        [randomUUID(), null, null],
        [null, null, null],
        [f.org, f.otherChapter, null],
        [f.org, "no-such-chapter", null],
        [f.org, f.chapter, f.otherUnit],
        [f.org, f.plainChapter, f.unit],
        [f.org, null, f.unit],
        [f.otherOrg, f.chapter, f.unit],
        [f.org, f.chapter, randomUUID()],
      ];
      for (const args of cases) {
        expect(await refused("select private.group_time_zone($1::uuid, $2::text, $3::uuid)", args), `${held} ${JSON.stringify(args)}`).toBe("22023");
      }
    }
    await release(false);
  });

  it("gives no API role the helpers", async () => {
    const rows = (await db.query(`
      select p.oid::regprocedure::text as name, r.rolname as role
        from pg_catalog.pg_proc p
        cross join pg_catalog.pg_roles r
       where p.oid in ('private.group_time_zone(uuid,text,uuid)'::regprocedure, 'private.group_time_zones_released(uuid)'::regprocedure,
                       'private.local_day(text,timestamptz)'::regprocedure, 'private.local_day_start(text,date)'::regprocedure)
         and r.rolname in ('anon', 'authenticated', 'service_role', 'public')
         and pg_catalog.has_function_privilege(r.rolname, p.oid, 'execute')`)).rows;
    expect(rows).toEqual([]);
    expect(await value("select pg_catalog.has_function_privilege('public', 'private.group_time_zone(uuid,text,uuid)'::regprocedure, 'execute') as v")).toBe(false);
    const definer = (await db.query(`
      select p.proname, p.prosecdef, p.proconfig as config
        from pg_catalog.pg_proc p where p.pronamespace = 'private'::regnamespace
         and p.proname in ('group_time_zone', 'group_time_zones_released', 'local_day', 'local_day_start') order by p.proname`)).rows;
    expect(definer).toEqual([
      { proname: "group_time_zone", prosecdef: true, config: ['search_path=""'] },
      { proname: "group_time_zones_released", prosecdef: true, config: ['search_path=""'] },
      { proname: "local_day", prosecdef: false, config: ['search_path=""'] },
      { proname: "local_day_start", prosecdef: false, config: ['search_path=""'] },
    ]);
  });

  it("counts a day in each zone as the shared module does, at an Eastern evening and across the year", async () => {
    const { rows } = await db.query(`
      select z as zone, to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at, private.local_day(z, at)::text as day
        from unnest($1::text[]) z
        cross join generate_series('2026-01-01T00:17:00Z'::timestamptz, '2027-12-31T23:17:00Z'::timestamptz, interval '7 hours 13 minutes') at`, [GRID]);
    expect(rows.length).toBeGreaterThan(30_000);
    const wrong = rows.filter((row) => zoneDay(row.at, row.zone) !== row.day).slice(0, 5);
    expect(wrong).toEqual([]);
    expect(await value("select private.local_day('America/Los_Angeles', '2026-11-13T00:30:00Z')::text as v")).toBe("2026-11-12");
    expect(await value("select private.local_day('Asia/Kathmandu', '2026-11-13T00:30:00Z')::text as v")).toBe("2026-11-13");
    expect(await value("select (private.local_day('Pacific/Kiritimati') - private.local_day('Etc/GMT+12')) as v")).toBeGreaterThanOrEqual(1);
  });

  it("starts a day at the first instant that has its date, exactly as the shared module does", async () => {
    const { rows } = await db.query(`
      select z as zone, d::date::text as day,
             to_char(private.local_day_start(z, d::date) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as start
        from unnest($1::text[]) z
        cross join generate_series('2026-01-01'::date, '2027-12-31'::date, interval '1 day') d`, [GRID]);
    expect(rows.length).toBe(GRID.length * 730);
    const wrong = rows.filter((row) => zoneMidnight(row.day, row.zone).toISOString() !== row.start).slice(0, 5);
    expect(wrong).toEqual([]);
    // Havana: midnight is skipped on Sun Mar 8, 2026 and comes twice on Sun Nov 1, 2026.
    const start = (zoneName, day) => value("select to_char(private.local_day_start($1, $2::date) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') as v", [zoneName, day]);
    expect(await start("America/Havana", "2026-03-08")).toBe("2026-03-08T05:00:00Z");
    expect(await start("America/Havana", "2026-11-01")).toBe("2026-11-01T04:00:00Z");
    expect(await start("Europe/Berlin", "2026-11-13")).toBe("2026-11-12T23:00:00Z");
    // Casey station moved its clock back three hours on March 5, 2010: the date began twice
    // and the day starts at the first (gate stage 527). Every day of 2009 to 2012 agrees with
    // the shared module.
    expect(await start("Antarctica/Casey", "2010-03-05")).toBe("2010-03-04T13:00:00Z");
    expect(await start("Antarctica/Casey", "2010-03-06")).toBe("2010-03-05T16:00:00Z");
    const casey = await db.query(`
      select d::date::text as day,
             to_char(private.local_day_start('Antarctica/Casey', d::date) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as start
        from generate_series('2009-01-01'::date, '2012-12-31'::date, interval '1 day') d`);
    expect(casey.rows.length).toBe(1461);
    expect(casey.rows.filter((row) => zoneMidnight(row.day, "Antarctica/Casey")?.toISOString() !== row.start).slice(0, 5)).toEqual([]);
    expect(await value("select private.local_day_start('Europe/Berlin', null) is null as v")).toBe(true);
    expect(await refused("select private.local_day_start('Mars/Olympus_Mons', '2026-01-01')")).toBe("22023");
    // A date the zone never had has no start, here and in the shared module.
    expect(await start("Pacific/Apia", "2011-12-30")).toBeNull();
    expect(zoneMidnight("2011-12-30", "Pacific/Apia")).toBeNull();
    expect(await start("Pacific/Apia", "2011-12-31")).toBe("2011-12-30T10:00:00Z");
    // A day is its start up to the next day's start, 23 to 25 hours long.
    const lengths = await db.query(`
      select distinct extract(epoch from private.local_day_start(z, (d + interval '1 day')::date) - private.local_day_start(z, d::date)) / 3600 as hours
        from unnest($1::text[]) z cross join generate_series('2026-01-01'::date, '2027-12-30'::date, interval '1 day') d order by 1`, [GRID]);
    expect(lengths.rows.map((row) => Number(row.hours))).toEqual([22, 23, 23.5, 24, 24.5, 25, 26]);
  });
});
