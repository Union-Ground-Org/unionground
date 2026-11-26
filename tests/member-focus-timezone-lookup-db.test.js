// @vitest-environment node
//
// BUG-UG-PROFILE-FOCUS-TIMEZONE-TRIGGER-COST-20261027
//
// Live proof on a disposable database for
// supabase/migrations/20261027070000_member_focus_timezone_name_lookup.sql:
//   * the private zone copy holds exactly this server's pg_timezone_names;
//   * the trigger accepts and rejects exactly what the old per-row
//     pg_timezone_names scan did, over every zone name plus invalid,
//     wrong-case, offset, abbreviation and null samples;
//   * a zone missing from the copy is still accepted through the fallback;
//   * member_profiles insert and update of quiet_hours_timezone keep the
//     'Unknown IANA timezone: %' / 22023 refusal and still work for the
//     member's own update and Auth's signup insert after the security change.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const MIGRATION = "20261027070000_member_focus_timezone_name_lookup.sql";
const migration = readFileSync(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), "utf8");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

// Names pg_timezone_names does not list, in shapes the old scan refused:
// unknown, wrong case, POSIX offsets and rules, abbreviations, padding, empty.
const INVALID = [
  "Mars/Olympus", "america/new_york", "AMERICA/NEW_YORK", "America/new_york", "utc", "Utc", "europe/london",
  "+05", "-03:30", "UTC+3", "<+05>-5", "XYZ3", "EST5", "PST", "CEST", "Z",
  " UTC", "UTC ", "America/New_York ", "", "America//New_York", "America/New_York/", "../etc/passwd",
];

describe("member focus timezone lookup migration (static)", () => {
  it("is registered in the required database proof lane", () => {
    expect(PROOF_FILES).toContain("tests/member-focus-timezone-lookup-db.test.js");
  });

  it("probes the private copy first and falls back to the catalog view with the same refusal", () => {
    const body = migration.slice(migration.indexOf("create or replace function private.validate_member_focus_timezone()"));
    expect(body).toMatch(/security definer\s+set search_path = ''/);
    const copy = body.indexOf("from private.iana_timezone_names zone");
    const view = body.indexOf("from pg_catalog.pg_timezone_names timezone");
    expect(copy).toBeGreaterThan(-1);
    expect(view).toBeGreaterThan(copy);
    expect(body).toContain("raise exception 'Unknown IANA timezone: %', new.quiet_hours_timezone\n      using errcode = '22023';");
    expect(migration).toContain("revoke all on table private.iana_timezone_names from public, anon, authenticated, service_role;");
    expect(migration).toContain("revoke all on function private.validate_member_focus_timezone() from public, anon, authenticated;");
    expect(migration).toContain("and object_name = 'validate_member_focus_timezone()'");
  });

  it("pins the definer function and the private copy in the database contract", () => {
    expect(contract.functions).toContainEqual(expect.objectContaining({
      sig: "private.validate_member_focus_timezone()", secdef: true, exec: "",
    }));
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(contract.tableGrants).toContainEqual({ table: "private.iana_timezone_names", role, privileges: "" });
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("member focus timezone lookup on a disposable database", () => {
  let db;
  const q = (sql, params) => db.query(sql, params);
  const member = randomUUID();
  const session = randomUUID();

  async function refusal(work) {
    await q("savepoint refusal");
    try {
      await work();
    } catch (error) {
      await q("rollback to savepoint refusal");
      await q("reset role");
      return { code: error.code, message: error.message };
    }
    await q("release savepoint refusal");
    return null;
  }

  async function as(role, work) {
    await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
      sub: member, role, session_id: session, aal: "aal2",
    })]);
    await q(`set local role ${role}`);
    // On failure the caller's savepoint rollback restores the role and claims.
    const result = await work();
    await q("reset role");
    await q("select set_config('request.jwt.claims', '', true)");
    return result;
  }

  const zoneOf = async () => (await q("select quiet_hours_timezone from public.member_profiles where id = $1", [member])).rows[0].quiet_hours_timezone;
  const setZone = (zone) => q("update public.member_profiles set quiet_hours_timezone = $2 where id = $1", [member, zone]);

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "member-focus-timezone-lookup-proof",
    });
    await db.connect();
    await q("begin");
    await q("set local statement_timeout = '120s'");
    await q("set local lock_timeout = '15s'");
    await q("insert into auth.users(id,email) values($1,'focus-timezone-proof@example.invalid')", [member]);
    await q("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, member]);
    await q(`insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
             values(gen_random_uuid(),$1,'focus-timezone-totp','totp','verified',now(),now())`, [member]);
    // The same trigger function on a bare probe table isolates its verdict
    // from every other member_profiles trigger and policy.
    await q("create temp table timezone_probe(quiet_hours_timezone text) on commit drop");
    await q(`create trigger timezone_probe_validate before insert or update on pg_temp.timezone_probe
             for each row execute function private.validate_member_focus_timezone()`);
    await q(`create function pg_temp.timezone_accepted(p_name text) returns boolean language plpgsql as $probe$
             begin
               insert into pg_temp.timezone_probe values (p_name);
               return true;
             exception when sqlstate '22023' then
               return false;
             end;
             $probe$`);
    await q("create temp table timezone_reference on commit drop as select name from pg_catalog.pg_timezone_names");
  }, 120_000);

  afterAll(async () => {
    if (db) {
      await q("rollback").catch(() => {});
      await db.end();
    }
  });

  it("copies exactly this server's pg_timezone_names", async () => {
    const { rows: [counts] } = await q(`
      select (select count(*) from private.iana_timezone_names)::int as copied,
             (select count(distinct name) from pg_temp.timezone_reference)::int as listed,
             (select count(*) from (select name from pg_temp.timezone_reference except select name from private.iana_timezone_names) missing)::int as missing,
             (select count(*) from (select name from private.iana_timezone_names except select name from pg_temp.timezone_reference) extra)::int as extra`);
    expect(counts.listed).toBeGreaterThan(300);
    expect(counts).toEqual({ copied: counts.listed, listed: counts.listed, missing: 0, extra: 0 });
  });

  it("accepts every pg_timezone_names entry and rejects every name it does not list, as the old scan did", async () => {
    const { rows } = await q(`
      select candidate,
             pg_temp.timezone_accepted(candidate) as accepted,
             exists (select 1 from pg_temp.timezone_reference reference where reference.name = candidate) as listed
      from (select name as candidate from pg_temp.timezone_reference
            union select unnest($1::text[])) candidates`, [INVALID]);
    const listed = rows.filter((row) => row.listed);
    expect(listed.length).toBeGreaterThan(300);
    expect(listed.every((row) => row.accepted)).toBe(true);
    const disagreements = rows.filter((row) => row.accepted !== row.listed).map((row) => row.candidate);
    expect(disagreements).toEqual([]);
    // Every invalid sample really is absent from the view, so each one exercised a refusal.
    expect(rows.filter((row) => INVALID.includes(row.candidate) && !row.accepted)).toHaveLength(INVALID.length);
    expect(await q("select pg_temp.timezone_accepted(null) as accepted")).toMatchObject({ rows: [{ accepted: false }] });
  });

  it("still accepts a zone the copy lacks through the catalog fallback", async () => {
    await q("savepoint fallback");
    await q("delete from private.iana_timezone_names where name in ('UTC', 'America/New_York')");
    const { rows } = await q("select pg_temp.timezone_accepted('UTC') as utc, pg_temp.timezone_accepted('America/New_York') as east, pg_temp.timezone_accepted('Mars/Olympus') as mars");
    await q("rollback to savepoint fallback");
    expect(rows[0]).toEqual({ utc: true, east: true, mars: false });
  });

  it("refuses an unknown or wrong-case zone on member_profiles insert and update with the same error", async () => {
    for (const zone of ["Mars/Olympus", "america/new_york", null]) {
      const update = await refusal(() => setZone(zone));
      expect(update, String(zone)).toEqual({ code: "22023", message: `Unknown IANA timezone: ${zone === null ? "<NULL>" : zone}` });
      const insert = await refusal(() => q(
        "insert into public.member_profiles(id, quiet_hours_timezone) values($1, $2) on conflict (id) do nothing",
        [member, zone],
      ));
      expect(insert, String(zone)).toEqual({ code: "22023", message: `Unknown IANA timezone: ${zone === null ? "<NULL>" : zone}` });
    }
    expect(await zoneOf()).toBe("America/New_York");
  });

  it("accepts exact-case zones on member_profiles insert and update", async () => {
    for (const zone of ["UTC", "America/New_York", "Pacific/Chatham"]) {
      await setZone(zone);
      expect(await zoneOf()).toBe(zone);
      await q("insert into public.member_profiles(id, quiet_hours_timezone) values($1, $2) on conflict (id) do nothing", [member, zone]);
    }
  });

  it("keeps the member's own zone change and Auth's signup insert working through the definer check", async () => {
    await as("authenticated", () => setZone("Europe/Lisbon"));
    expect(await zoneOf()).toBe("Europe/Lisbon");
    const refused = await refusal(() => as("authenticated", () => setZone("europe/lisbon")));
    expect(refused).toEqual({ code: "22023", message: "Unknown IANA timezone: europe/lisbon" });
    // A signup's auth.users insert runs private.handle_new_member, which
    // inserts the profile and fires this trigger with the default zone.
    const signup = randomUUID();
    await q("insert into auth.users(id,email) values($1,'focus-timezone-signup@example.invalid')", [signup]);
    const { rows } = await q("select quiet_hours_timezone from public.member_profiles where id = $1", [signup]);
    expect(rows).toEqual([{ quiet_hours_timezone: "America/New_York" }]);
  });

  it("gives no browser or service role the copy or the function", async () => {
    const { rows } = await q(`
      select role,
             has_table_privilege(role, 'private.iana_timezone_names', 'select,insert,update,delete') as table_access,
             has_function_privilege(role, 'private.validate_member_focus_timezone()', 'execute') as execute
      from unnest(array['anon','authenticated','service_role']) role order by role`);
    expect(rows).toEqual([
      { role: "anon", table_access: false, execute: false },
      { role: "authenticated", table_access: false, execute: false },
      { role: "service_role", table_access: false, execute: false },
    ]);
    const { rows: [fn] } = await q(`select prosecdef, proconfig from pg_proc where oid = 'private.validate_member_focus_timezone()'::regprocedure`);
    expect(fn).toEqual({ prosecdef: true, proconfig: ['search_path=""'] });
  });
});
