// @vitest-environment node
// Q10=A: the account's creation time, not its newer profile, bounds cleanup.
// This suite executes the shipped migration on synthetic rows and rolls back.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql } from "./helpers/migration.js";

const migration = loadMigrationSql("_clear_unreliable_member_since_2023.sql")
  .replace(/^begin;$/m, "")
  .replace(/^commit;$/m, "");
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("owner-authorized member-since cleanup on a disposable database", () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      application_name: "member-since-backfill-rollback-proof",
    });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  it("clears only 2023 for accounts at or after the confirmed cutoff and is idempotent", async () => {
    await client.query("begin");
    try {
      // An explicit offset in the migration must work in any session zone.
      await client.query("set local time zone 'Pacific/Honolulu'");
      const fixtures = [
        { name: "older account", created: "2026-07-20 12:00:00-04", year: 2023, expected: 2023 },
        { name: "just before", created: "2026-07-21 01:04:14.999999-04", year: 2023, expected: 2023 },
        { name: "at cutoff", created: "2026-07-21 01:04:15-04", year: 2023, expected: null },
        { name: "just after", created: "2026-07-21 01:04:15.000001-04", year: 2023, expected: null },
        { name: "later default", created: "2026-10-01 12:00:00-04", year: 2023, expected: null },
        { name: "different year", created: "2026-10-01 12:00:00-04", year: 2005, expected: 2005 },
        { name: "current year", created: "2026-10-01 12:00:00-04", year: 2026, expected: 2026 },
        { name: "already blank", created: "2026-10-01 12:00:00-04", year: null, expected: null },
        { name: "unknown creation", created: null, year: 2023, expected: 2023 },
      ].map((fixture) => ({ ...fixture, id: randomUUID() }));
      for (const fixture of fixtures) {
        await client.query("insert into auth.users(id,email,created_at) values ($1,$2,$3::timestamptz)",
          [fixture.id, `${fixture.id}@example.invalid`, fixture.created]);
        // Every profile is newer than the cutoff, even the old accounts.
        await client.query("update public.member_profiles set member_since=$2, full_name=$3, created_at='2026-10-08 12:00:00-04' where id=$1",
          [fixture.id, fixture.year, fixture.name]);
      }
      const ids = fixtures.map((fixture) => fixture.id);
      const unrelated = () => client.query(
        `select p.id, p.full_name, p.first_name, p.initials, p.created_at, p.chapter_id,
                u.email, u.created_at as auth_created_at
           from public.member_profiles p join auth.users u on u.id=p.id
          where p.id=any($1::uuid[]) order by p.id`, [ids],
      );
      const counts = () => client.query("select (select count(*) from auth.users) as users, (select count(*) from public.member_profiles) as profiles");
      const beforeUnrelated = (await unrelated()).rows;
      const beforeCounts = (await counts()).rows;

      await client.query(migration);
      const rows = (await client.query("select id,member_since from public.member_profiles where id=any($1::uuid[])", [ids])).rows;
      expect(Object.fromEntries(rows.map((row) => [row.id, row.member_since])))
        .toEqual(Object.fromEntries(fixtures.map((fixture) => [fixture.id, fixture.expected])));
      expect((await unrelated()).rows).toEqual(beforeUnrelated);
      expect((await counts()).rows).toEqual(beforeCounts);

      const repeated = await client.query(migration);
      expect((Array.isArray(repeated) ? repeated : [repeated]).find((result) => result.command === "UPDATE")?.rowCount).toBe(0);
    } finally {
      await client.query("rollback");
    }
  });
});
