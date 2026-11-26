// REQ-UG-TIME-ZONES-PER-GROUP-20261122 (#9446), part 3: on a
// disposable migrated database, an organization admin sets the organization's
// time zone, whoever may manage a chapter's units sets or clears the
// chapter's and a unit's, nobody else can, another organization's groups get
// the same refusal as missing ones, every change is audited and an unchanged
// save is not, the apps' read
// answers each group's own zone and the zone it works on, and all of it is
// refused or silent while the switch is held. The day-start helper finds a
// day that begins at a clock jump. Everything runs in one transaction per
// test that rolls back.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { zoneMidnight } from "../src/lib/zoneTime.js";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const SWITCH = "features.governance.group_time_zones";
const REFUSAL = "time zone role required";

live("setting and reading a group's time zone on a migrated database", () => {
  let db;
  let f;
  const one = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.v;
  const owner = async () => { await db.query("reset role"); await db.query("select set_config('request.jwt.claims','',true)"); };
  const as = async (name, aal = "aal2") => {
    await owner();
    const actor = f.people[name];
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor.id, session_id: actor.session, role: "authenticated", aal })]);
    await db.query("set local role authenticated");
  };
  const refusal = async (sql, args = []) => {
    await db.query("savepoint zone_call");
    try {
      await db.query(sql, args);
      await db.query("release savepoint zone_call");
      return null;
    } catch (error) {
      await db.query("rollback to savepoint zone_call");
      return `${error.code} ${error.message}`;
    }
  };
  const set = (chapter, unit, zone) => one("select public.set_group_time_zone($1,$2,$3) v", [chapter, unit, zone]);
  const refuseSet = (chapter, unit, zone) => refusal("select public.set_group_time_zone($1,$2,$3)", [chapter, unit, zone]);
  const read = () => one("select public.get_group_time_zones() v");
  const release = async (released) => {
    await owner();
    await db.query("update public.platform_setting_definitions set release_at = $2 where key = $1", [SWITCH, released ? null : "infinity"]);
  };
  // A fictional person with an active organization membership, a chapter
  // membership when a chapter is given, and a verified second factor.
  const enrol = async (name, org, chapter) => {
    const id = randomUUID();
    const session = randomUUID();
    f.people[name] = { id, session };
    await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${id}@example.invalid`]);
    await db.query("update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1", [id, chapter, `Fictional ${name}`]);
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, id]);
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, id]);
    if (chapter) await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, chapter]);
    return id;
  };

  beforeEach(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "group-time-zone-settings-proof" });
    await db.connect();
    await db.query("set statement_timeout = '60s'");
    await db.query("begin");
    await db.query("set constraints all deferred");
    f = { org: randomUUID(), otherOrg: randomUUID(), unit: randomUUID(), ridgeUnit: randomUUID(), otherUnit: randomUUID(), people: {} };
    f.chapter = `zone-harbor-${f.org}`;
    f.ridge = `zone-ridge-${f.org}`;
    f.otherChapter = `zone-other-${f.otherOrg}`;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Fictional Zone Local'),($2::uuid,$2::text,'Fictional Other Local')", [f.org, f.otherOrg]);
    await db.query(
      "insert into public.chapters(id,name,slug,organization_id,order_index) values($1,'Harbor chapter',$1,$4,9961),($2,'Ridge chapter',$2,$4,9962),($3,'Other chapter',$3,$5,9963)",
      [f.chapter, f.ridge, f.otherChapter, f.org, f.otherOrg],
    );
    await db.query(
      "insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$4,$5,'Dock worksite'),($2,$4,$6,'Ridge worksite'),($3,$7,$8,'Other worksite')",
      [f.unit, f.ridgeUnit, f.otherUnit, f.org, f.chapter, f.ridge, f.otherOrg, f.otherChapter],
    );
    const admin = await enrol("admin", f.org, f.chapter);
    const chapterAdmin = await enrol("chapterAdmin", f.org, f.chapter);
    await enrol("member", f.org, f.chapter);
    const otherAdmin = await enrol("otherAdmin", f.otherOrg, f.otherChapter);
    for (const [id, chapter] of [[admin, f.chapter], [chapterAdmin, f.chapter], [otherAdmin, f.otherChapter]]) {
      await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'admin',$2)", [id, chapter]);
      await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'admin',$2)", [id, chapter]);
    }
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'admin'),($3,$4,'admin')", [f.org, admin, f.otherOrg, otherAdmin]);
    await release(true);
  }, 120_000);

  afterEach(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("lets an organization admin set the organization's zone once, and records who and when", async () => {
    await as("admin");
    const before = await read();
    expect(before.released).toBe(true);
    expect(before.organization).toMatchObject({ timeZone: "America/New_York", confirmed: false, confirmedAt: null, canChange: true });
    const after = await set(null, null, "Europe/Berlin");
    expect(after.organization).toMatchObject({ timeZone: "Europe/Berlin", confirmed: true, canChange: true });
    expect(after.organization.confirmedAt).toBeTruthy();
    // Every chapter and unit with no zone of its own works on the organization's.
    expect(after.chapters.map((row) => [row.chapterId, row.ownTimeZone, row.timeZone])).toEqual([
      [f.chapter, null, "Europe/Berlin"], [f.ridge, null, "Europe/Berlin"],
    ]);
    expect(after.units.every((row) => row.ownTimeZone === null && row.timeZone === "Europe/Berlin")).toBe(true);
    await owner();
    expect(await one("select private.group_time_zone($1::uuid, $2::text, $3::uuid) v", [f.org, f.chapter, f.unit])).toBe("Europe/Berlin");
    const audit = (await db.query("select actor_user_id, action, item_key, previous_value, new_value from public.organization_configuration_audit where organization_id = $1", [f.org])).rows;
    expect(audit).toEqual([{
      actor_user_id: f.people.admin.id, action: "setting_updated", item_key: "time_zone.organization",
      previous_value: { chapterId: null, unitId: null, timeZone: "America/New_York" },
      new_value: { chapterId: null, unitId: null, timeZone: "Europe/Berlin" },
    }]);
    // An organization always has a zone.
    await as("admin");
    expect(await refuseSet(null, null, null)).toMatch(/^22023 /u);
    expect(await refuseSet(null, null, "  ")).toMatch(/^22023 /u);
  });

  it("lets whoever manages a chapter's units set and clear the chapter's and a unit's own zone", async () => {
    await as("chapterAdmin");
    let payload = await set(f.chapter, null, "America/Los_Angeles");
    expect(payload.organization.canChange).toBe(false);
    expect(payload.chapters.map((row) => [row.chapterId, row.ownTimeZone, row.timeZone, row.canChange])).toEqual([
      [f.chapter, "America/Los_Angeles", "America/Los_Angeles", true], [f.ridge, null, "America/New_York", false],
    ]);
    payload = await set(f.chapter, f.unit, "Asia/Kathmandu");
    expect(payload.units.find((row) => row.unitId === f.unit)).toMatchObject({ chapterId: f.chapter, ownTimeZone: "Asia/Kathmandu", timeZone: "Asia/Kathmandu" });
    expect(payload.units.find((row) => row.unitId === f.ridgeUnit)).toMatchObject({ ownTimeZone: null, timeZone: "America/New_York" });
    // Clearing a unit takes the chapter's again; clearing the chapter takes the organization's.
    payload = await set(f.chapter, f.unit, null);
    expect(payload.units.find((row) => row.unitId === f.unit)).toMatchObject({ ownTimeZone: null, timeZone: "America/Los_Angeles" });
    payload = await set(f.chapter, null, "");
    expect(payload.chapters.find((row) => row.chapterId === f.chapter)).toMatchObject({ ownTimeZone: null, timeZone: "America/New_York" });
    await owner();
    expect((await db.query("select item_key, new_value ->> 'timeZone' as zone from public.organization_configuration_audit where organization_id = $1 order by created_at", [f.org])).rows).toEqual([
      { item_key: "time_zone.chapter", zone: "America/Los_Angeles" }, { item_key: "time_zone.unit", zone: "Asia/Kathmandu" },
      { item_key: "time_zone.unit", zone: null }, { item_key: "time_zone.chapter", zone: null },
    ]);
    // A chapter admin is not an organization admin, and does not manage the other chapter.
    await as("chapterAdmin");
    expect(await refuseSet(null, null, "Europe/Berlin")).toBe(`42501 ${REFUSAL}`);
    expect(await refuseSet(f.ridge, null, "Europe/Berlin")).toBe(`42501 ${REFUSAL}`);
    expect(await refuseSet(f.ridge, f.ridgeUnit, "Europe/Berlin")).toBe(`42501 ${REFUSAL}`);
  });

  it("holds a zone to a region name spelled as the server lists it", async () => {
    await as("admin");
    // A fixed offset under a region-like name keeps no region's clock either.
    for (const zone of ["EST", "UTC", "-05:00", "EST5EDT", "america/chicago", "America/chicago", "Mars/Olympus_Mons", "America/", "New York",
      "Etc/GMT+12", "Etc/GMT-14", "Etc/UTC", "Etc/GMT", "SystemV/EST5"]) {
      expect(await refuseSet(null, null, zone), zone).toMatch(/^22023 time zone must be a region the server knows/u);
      expect(await refuseSet(f.chapter, null, zone), zone).toMatch(/^22023 /u);
      expect(await refuseSet(f.chapter, f.unit, zone), zone).toMatch(/^22023 /u);
    }
    expect((await set(null, null, " Asia/Kolkata ")).organization.timeZone).toBe("Asia/Kolkata");
    expect((await set(f.chapter, null, "Australia/Lord_Howe")).chapters[0].ownTimeZone).toBe("Australia/Lord_Howe");
    expect((await set(f.chapter, f.unit, "Pacific/Kiritimati")).units.find((row) => row.unitId === f.unit).ownTimeZone).toBe("Pacific/Kiritimati");
  });

  it("answers an organization admin who is in no chapter, for the organization and every chapter and unit", async () => {
    const lone = await enrol("chapterlessAdmin", f.org, null);
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'admin')", [f.org, lone]);
    await as("chapterlessAdmin");
    const seen = await read();
    expect(seen.organization).toMatchObject({ timeZone: "America/New_York", canChange: true });
    expect(seen.chapters.map((row) => [row.chapterId, row.canChange])).toEqual([[f.chapter, true], [f.ridge, true]]);
    expect((await set(null, null, "America/Denver")).organization).toMatchObject({ timeZone: "America/Denver", confirmed: true });
    expect((await set(f.ridge, null, "America/Phoenix")).chapters.find((row) => row.chapterId === f.ridge).ownTimeZone).toBe("America/Phoenix");
    expect((await set(f.ridge, f.ridgeUnit, "America/Boise")).units.find((row) => row.unitId === f.ridgeUnit).ownTimeZone).toBe("America/Boise");
    // Still only its own organization.
    expect(await refuseSet(f.otherChapter, null, "Europe/Berlin")).toBe(`42501 ${REFUSAL}`);
    expect(await refuseSet(f.chapter, f.otherUnit, "Europe/Berlin")).toBe(`42501 ${REFUSAL}`);
    await owner();
    expect((await db.query("select actor_user_id, item_key from public.organization_configuration_audit where organization_id = $1 order by created_at", [f.org])).rows).toEqual([
      { actor_user_id: lone, item_key: "time_zone.organization" }, { actor_user_id: lone, item_key: "time_zone.chapter" }, { actor_user_id: lone, item_key: "time_zone.unit" },
    ]);
  });

  it("writes no audit row when a chapter's or a unit's zone does not change", async () => {
    await as("chapterAdmin");
    // Clearing what is already clear, and saving the same zone twice.
    await set(f.chapter, null, null);
    await set(f.chapter, f.unit, "");
    await set(f.chapter, null, "America/Chicago");
    const again = await set(f.chapter, null, " America/Chicago ");
    expect(again.chapters.find((row) => row.chapterId === f.chapter)).toMatchObject({ ownTimeZone: "America/Chicago", canChange: true });
    await set(f.chapter, f.unit, "America/Chicago");
    await set(f.chapter, f.unit, "America/Chicago");
    await owner();
    expect((await db.query("select item_key, previous_value ->> 'timeZone' as was, new_value ->> 'timeZone' as now from public.organization_configuration_audit where organization_id = $1 order by created_at", [f.org])).rows).toEqual([
      { item_key: "time_zone.chapter", was: null, now: "America/Chicago" }, { item_key: "time_zone.unit", was: null, now: "America/Chicago" },
    ]);
  });

  it("gives a member, another organization and a missing group one and the same refusal", async () => {
    await as("member");
    for (const [chapter, unit] of [[null, null], [f.chapter, null], [f.chapter, f.unit]]) {
      expect(await refuseSet(chapter, unit, "Europe/Berlin")).toBe(`42501 ${REFUSAL}`);
    }
    // A member still reads the zones their organization works on, and cannot change any.
    const seen = await read();
    expect(seen.organization.canChange).toBe(false);
    expect(seen.chapters.every((row) => row.canChange === false)).toBe(true);
    expect(seen.chapters.map((row) => row.chapterId)).toEqual([f.chapter, f.ridge]);
    await as("admin");
    const foreignAndMissing = [
      [f.otherChapter, null], [f.otherChapter, f.otherUnit], [f.chapter, f.otherUnit], [f.chapter, f.ridgeUnit],
      [f.chapter, randomUUID()], ["no-such-chapter", null], [null, f.unit], [null, f.otherUnit],
    ];
    for (const [chapter, unit] of foreignAndMissing) {
      expect(await refuseSet(chapter, unit, "Europe/Berlin"), `${chapter} ${unit}`).toBe(`42501 ${REFUSAL}`);
    }
    // Nothing of the other organization is read or written.
    const mine = await read();
    expect(JSON.stringify(mine)).not.toContain(f.otherChapter);
    expect(JSON.stringify(mine)).not.toContain(f.otherUnit);
    await as("otherAdmin");
    expect((await set(null, null, "Asia/Tokyo")).organization.timeZone).toBe("Asia/Tokyo");
    await as("admin");
    expect((await read()).organization.timeZone).toBe("America/New_York");
    await owner();
    expect(await one("select count(*)::int v from public.organization_configuration_audit where organization_id = $1", [f.org])).toBe(0);
    // No first factor, or no second: refused before anything is read.
    await as("admin", "aal1");
    expect(await refuseSet(null, null, "Europe/Berlin")).toBe(`42501 ${REFUSAL}`);
    expect(await refusal("select public.get_group_time_zones()")).toBe("42501 authentication required");
    await owner();
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "anon" })]);
    await db.query("set local role anon");
    expect(await refusal("select public.get_group_time_zones()")).toMatch(/^42501 /u);
    expect(await refusal("select public.set_group_time_zone(null, null, 'Europe/Berlin')")).toMatch(/^42501 /u);
  });

  it("is refused or silent for everyone while the switch is held, and keeps what was stored", async () => {
    await as("admin");
    await set(null, null, "Europe/Berlin");
    await set(f.chapter, null, "America/Los_Angeles");
    await release(false);
    await as("admin");
    expect(await read()).toEqual({ released: false });
    expect(await refuseSet(null, null, "Asia/Tokyo")).toBe(`42501 ${REFUSAL}`);
    expect(await refuseSet(f.chapter, null, null)).toBe(`42501 ${REFUSAL}`);
    await owner();
    expect(await one("select private.group_time_zone($1::uuid, $2::text) v", [f.org, f.chapter])).toBe("America/New_York");
    expect((await db.query("select o.time_zone as org, c.time_zone as chapter from public.organizations o join public.chapters c on c.organization_id = o.id where c.id = $1", [f.chapter])).rows)
      .toEqual([{ org: "Europe/Berlin", chapter: "America/Los_Angeles" }]);
    await release(true);
    await as("admin");
    expect((await read()).chapters[0]).toMatchObject({ ownTimeZone: "America/Los_Angeles", timeZone: "America/Los_Angeles" });
  });

  it("gives the two functions to signed-in callers only, and the helpers to nobody", async () => {
    await owner();
    const granted = (await db.query(`
      select p.oid::regprocedure::text as name, pg_catalog.array_agg(r.rolname::text order by r.rolname) as roles
        from pg_catalog.pg_proc p cross join pg_catalog.pg_roles r
       where p.oid in ('public.get_group_time_zones()'::regprocedure, 'public.set_group_time_zone(text,uuid,text)'::regprocedure,
                       'private.group_time_zones_payload(uuid)'::regprocedure, 'private.time_zone_region_known(text)'::regprocedure)
         and r.rolname in ('anon', 'authenticated', 'service_role')
         and pg_catalog.has_function_privilege(r.rolname, p.oid, 'execute')
       group by 1 order by 1`)).rows;
    expect(granted).toEqual([
      { name: "get_group_time_zones()", roles: ["authenticated"] },
      { name: "set_group_time_zone(text,uuid,text)", roles: ["authenticated"] },
    ]);
    expect(await one("select count(*)::int v from pg_catalog.pg_proc p where p.proname in ('get_group_time_zones','set_group_time_zone','group_time_zones_payload','time_zone_region_known') and (not p.prosecdef or p.proconfig is distinct from array['search_path=\"\"'])")).toBe(0);
  });

  it("finds a day that begins at a clock jump, as the shared module does", async () => {
    await owner();
    const start = (zone, day) => one("select to_char(private.local_day_start($1, $2::date) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') v", [zone, day]);
    // Toronto's clock went from 11:30 PM on March 30, 1919 to 12:30 AM on March 31.
    expect(await start("America/Toronto", "1919-03-31")).toBe("1919-03-31T04:30:00.000Z");
    expect(await start("Antarctica/Casey", "2010-03-05")).toBe("2010-03-04T13:00:00.000Z");
    expect(await start("America/Havana", "2026-03-08")).toBe("2026-03-08T05:00:00.000Z");
    expect(await start("America/Havana", "2026-11-01")).toBe("2026-11-01T04:00:00.000Z");
    expect(await start("Pacific/Apia", "2011-12-30")).toBeNull();
    expect(await start("Europe/Berlin", null)).toBeNull();
    expect(await start(null, "2026-01-01")).toBeNull();
    expect(await refusal("select private.local_day_start('Mars/Olympus_Mons', '2026-01-01')")).toMatch(/^22023 /u);
    const grid = [
      ["America/Toronto", "1918-01-01", "1920-12-31"], ["Antarctica/Casey", "2009-01-01", "2012-12-31"],
      ["America/Havana", "2026-01-01", "2027-12-31"], ["Australia/Lord_Howe", "2026-01-01", "2027-12-31"],
      ["Pacific/Apia", "2011-01-01", "2012-12-31"], ["Asia/Kathmandu", "2026-01-01", "2026-12-31"],
      ["Antarctica/Troll", "2026-01-01", "2027-12-31"], ["Pacific/Chatham", "2026-01-01", "2027-12-31"],
    ];
    for (const [zone, from, to] of grid) {
      const { rows } = await db.query(`
        select d::date::text as day,
               to_char(private.local_day_start($1, d::date) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as start
          from generate_series($2::date, $3::date, interval '1 day') d`, [zone, from, to]);
      const wrong = rows.filter((row) => (zoneMidnight(row.day, zone)?.toISOString() ?? null) !== row.start).slice(0, 3);
      expect(wrong, zone).toEqual([]);
    }
  });
});
