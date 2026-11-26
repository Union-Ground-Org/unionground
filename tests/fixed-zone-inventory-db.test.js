// REQ-UG-TIME-ZONES-PER-GROUP-20261122 (#9446): on a disposable
// migrated database, the catalog reader behind the database half of
// config/fixed-zone-inventory.json finds each kind of object that works on a
// fixed zone, and leaves out one that takes its zone as an argument. The
// probe objects are made in one transaction that rolls back.
//
// This proves the reader. It does not compare the saved list with the
// catalog: the list is a snapshot that each part of the record refreshes
// (node scripts/fixed-zone-inventory.mjs reports what has moved since).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { collectFixedZoneDatabase } from "../scripts/lib/fixed-zone-db.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("the fixed-zone catalog reader on a migrated database", () => {
  let client;
  let found;
  const named = (group, name) => found[group].find((row) => row.name === name);

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "fixed-zone-inventory-proof" });
    await client.connect();
    await client.query("set statement_timeout = '60s'");
    await client.query("begin");
    await client.query(`
      create table private.fixed_zone_probe (
        id integer primary key,
        seen_at timestamptz not null default pg_catalog.now(),
        seen_on date not null default current_date,
        utc_on date not null default (pg_catalog.now() at time zone 'UTC')::date,
        due_on date,
        constraint fixed_zone_probe_due_not_past check (due_on is null or due_on >= (seen_at at time zone 'America/New_York')::date)
      )`);
    await client.query("alter table private.fixed_zone_probe enable row level security");
    await client.query("create policy fixed_zone_probe_today on private.fixed_zone_probe for select using (due_on >= current_date)");
    await client.query("create index fixed_zone_probe_eastern_day on private.fixed_zone_probe (((seen_at at time zone 'America/New_York')::date))");
    await client.query("create view private.fixed_zone_probe_view as select id, (seen_at at time zone 'UTC')::date as utc_day from private.fixed_zone_probe");
    await client.query(`
      create function private.fixed_zone_probe_eastern() returns date language sql stable set search_path = '' as
      $$ select private.eastern_day() $$`);
    await client.query(`
      create function private.fixed_zone_probe_session() returns boolean language plpgsql stable set search_path = '' as
      $$ begin
        -- current_date in a comment is not a read
        return exists (select 1 from private.fixed_zone_probe p where p.due_on < pg_catalog.now()::date);
      end $$`);
    await client.query(`
      create function private.fixed_zone_probe_group(p_zone text, p_at timestamptz) returns date language sql stable set search_path = '' as
      $$ select (p_at at time zone p_zone)::date $$`);
    await client.query(`
      create function private.fixed_zone_probe_guard() returns trigger language plpgsql set search_path = '' as
      $$ begin return new; end $$`);
    await client.query(`
      create trigger fixed_zone_probe_guard before update on private.fixed_zone_probe
      for each row when (new.due_on < current_date) execute function private.fixed_zone_probe_guard()`);
    found = await collectFixedZoneDatabase(client);
  }, 120_000);

  afterAll(async () => {
    await client?.query("rollback").catch(() => {});
    await client?.end();
  });

  it("lists each kind of probe object with what it does", () => {
    expect(named("functions", "private.fixed_zone_probe_eastern()")?.kinds).toEqual(["fixed"]);
    expect(named("functions", "private.fixed_zone_probe_session()")?.kinds).toEqual(["sessionDay"]);
    expect(named("columnDefaults", "private.fixed_zone_probe.seen_on")?.kinds).toEqual(["sessionDay"]);
    expect(named("columnDefaults", "private.fixed_zone_probe.utc_on")?.kinds).toEqual(["utc"]);
    expect(named("constraints", "private.fixed_zone_probe fixed_zone_probe_due_not_past")?.kinds).toEqual(["fixed"]);
    expect(named("policies", "private.fixed_zone_probe fixed_zone_probe_today")?.kinds).toEqual(["sessionDay"]);
    expect(named("indexes", "private.fixed_zone_probe_eastern_day")?.kinds).toEqual(["fixed"]);
    expect(named("views", "private.fixed_zone_probe_view")?.kinds).toEqual(["utc"]);
    expect(named("triggers", "private.fixed_zone_probe fixed_zone_probe_guard")?.kinds).toEqual(["sessionDay"]);
  });

  it("leaves out what takes its zone as an argument or only stores an instant", () => {
    expect(named("functions", "private.fixed_zone_probe_group(text,timestamp with time zone)")).toBeUndefined();
    expect(named("functions", "private.fixed_zone_probe_guard()")).toBeUndefined();
    expect(named("columnDefaults", "private.fixed_zone_probe.seen_at")).toBeUndefined();
  });

  it("finds the product's own Eastern helper and the daily deadline notice job", () => {
    expect(named("functions", "private.eastern_day(timestamp with time zone)")?.kinds).toEqual(["fixed"]);
    const notices = named("scheduledJobs", "deadline-notices-tick");
    expect(notices?.kinds).toContain("fixedHour");
    expect(notices?.schedule).toMatch(/^\d+ \d+ \* \* \*$/u);
    for (const rows of Object.values(found)) expect(rows.map((row) => row.name)).toEqual(rows.map((row) => row.name).toSorted());
  });
});
