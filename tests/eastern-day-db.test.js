// @vitest-environment node
// SYS-UG-SHARED-EASTERN-TIME-GUARD-20261113 (#8625): the database's
// one Eastern-day helper answers the Eastern day at the instants where the UTC
// day differs, in a UTC session and in a session set to another zone.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { EASTERN_DAY_CASES, EASTERN_INSTANTS } from "./helpers/easternClock.js";

const FILE = "20261113122500_eastern_day_helper.sql";
const migration = readFileSync(`supabase/migrations/${FILE}`, "utf8");

describe("Eastern day helper migration", () => {
  it("defines one stable helper that no API role can call", () => {
    expect(FILE > "20261112215500_email_retry_through_mail_outage.sql").toBe(true);
    expect(migration).toContain("create or replace function private.eastern_day(p_at timestamptz default pg_catalog.now())");
    expect(migration).toContain("(p_at at time zone 'America/New_York')::date");
    expect(migration).toMatch(/^stable$/mu);
    expect(migration).toContain("set search_path = ''");
    expect(migration).toContain("revoke all on function private.eastern_day(timestamptz) from public, anon, authenticated, service_role;");
    expect(migration).not.toMatch(/security definer/iu);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("private.eastern_day on a live database", () => {
  let db;
  const q = (text, values = []) => db.query(text, values);

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "eastern-day-proof" });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });

  it.each(["UTC", "Asia/Tokyo", "America/Los_Angeles"])("answers the Eastern day in a %s session", async (zone) => {
    await q("begin");
    try {
      await q(`set local timezone = '${zone}'`);
      for (const [at, day] of EASTERN_DAY_CASES) {
        const { rows } = await q("select private.eastern_day($1::timestamptz)::text as day", [at]);
        expect(rows[0].day, `${at} in ${zone}`).toBe(day);
      }
    } finally {
      await q("rollback");
    }
  });

  it("differs from the UTC session day in the Eastern evening", async () => {
    const { evening } = EASTERN_INSTANTS;
    const { rows } = await q("select private.eastern_day($1::timestamptz)::text as eastern, ($1::timestamptz at time zone 'UTC')::date::text as utc", [evening.at]);
    expect(rows[0]).toEqual({ eastern: evening.easternDay, utc: evening.utcDay });
  });

  it("defaults to the current instant", async () => {
    const { rows } = await q("select private.eastern_day() = (now() at time zone 'America/New_York')::date as same");
    expect(rows[0].same).toBe(true);
  });

  it("is not executable by any API role", async () => {
    const { rows } = await q(`select role, has_function_privilege(role, 'private.eastern_day(timestamptz)', 'EXECUTE') as can
      from unnest(array['anon', 'authenticated', 'service_role']) role order by role`);
    expect(rows).toEqual([
      { role: "anon", can: false },
      { role: "authenticated", can: false },
      { role: "service_role", can: false },
    ]);
  });
});
