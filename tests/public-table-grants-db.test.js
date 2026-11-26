// @vitest-environment node
// SYS-UG-REQUIRE-EXPLICIT-GRANTS-IN-MIGRATIONS-CREATING-PUBLIC-TABLES-20261022:
// every public table a change adds grants each Data API role explicitly,
// checked in the catalog of the disposable stack (docs/conventions/public-table-grants.md).
import pg from "pg";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { readGrantProbeBoundary, REQUIRED_ROLES, tablesMissingGrants } from "../scripts/lib/public-table-grant-probe.mjs";

const databaseIt = process.env.RUN_PUBLIC_TABLE_GRANTS_DB_TESTS === "1" ? it : it.skip;
const baseline = JSON.parse(readFileSync(new URL("../config/migration-conventions-baseline.json", import.meta.url), "utf8"));
const exempt = baseline.publicTableGrantExempt ?? [];
const editedExempt = new Set((baseline.publicTableGrantEditedExempt ?? []).filter((entry) => entry?.reason?.trim().length >= 20).map((entry) => entry.migration));

async function withClient(work) {
  const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  await client.connect();
  try { return await work(client); } finally { await client.end(); }
}

databaseIt("every public table the change adds grants authenticated and service_role", async () => {
  const probe = process.env.CI_DB_GRANT_PROBE;
  // The stack preparation reports what it probed; an unresolved base or a
  // missing report fails closed rather than passing silently.
  expect(probe, "scripts/prepare-ci-disposable-db.mjs did not report CI_DB_GRANT_PROBE").toBeTruthy();
  expect(probe, "the comparison base could not be resolved, so new migrations are unknown").not.toBe("unresolved");
  // An edited existing migration replays inside the history, before any
  // revoke, so its tables cannot be probed: it fails unless documented.
  const edited = (process.env.CI_DB_GRANT_PROBE_EDITED ?? "").split(",").filter(Boolean);
  expect(edited.filter((name) => !editedExempt.has(name)),
    "an edited existing migration cannot be probed; document it in publicTableGrantEditedExempt").toEqual([]);
  await withClient(async (client) => {
    const boundary = await readGrantProbeBoundary(client);
    if (probe === "none") {
      expect(boundary).toBeNull();
      return;
    }
    expect(probe).toBe("applied");
    expect(boundary, "added migrations were held back but the boundary was not recorded").toMatch(/^\d+$/);
    expect(await tablesMissingGrants(client, { boundary, exempt })).toEqual([]);
  });
});

// Sol's four shapes from #5802's final, where parsing SQL credited grants
// that never take effect. The catalog sees what actually happened.
const shapes = [
  ["a grant rolled back to a savepoint", "tm_grant_probe_a", `
    create table public.tm_grant_probe_a (id int);
    savepoint before_grant;
    grant select on public.tm_grant_probe_a to anon, authenticated, service_role;
    rollback to savepoint before_grant;`],
  ["a grant in a branch that never runs", "tm_grant_probe_b", `
    create table public.tm_grant_probe_b (id int);
    do $$ begin if false then grant select on public.tm_grant_probe_b to anon, authenticated, service_role; end if; end $$;`],
  ["a renamed table whose name is reused", "tm_grant_probe_c_old", `
    create table public.tm_grant_probe_c (id int);
    alter table public.tm_grant_probe_c rename to tm_grant_probe_c_old;
    create table public.tm_grant_probe_c (id int);
    grant select on public.tm_grant_probe_c to anon, authenticated, service_role;`],
  ["a routine with SET search_path before its AS body", "tm_grant_probe_d", `
    create function public.tm_grant_probe_make() returns void language plpgsql set search_path = '' as $$
      begin create table public.tm_grant_probe_d (id int); end $$;
    select public.tm_grant_probe_make();`],
];

for (const [label, table, sql] of shapes) databaseIt(`finds ${label} (#5802 final Sol)`, async () => {
  await withClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role");
      const boundary = (await client.query("select max(oid)::bigint::text as value from pg_class")).rows[0].value;
      await client.query(sql);
      const missing = await tablesMissingGrants(client, { boundary });
      expect(missing.find((row) => row.table === table)?.missing).toEqual([...REQUIRED_ROLES]);
    } finally {
      await client.query("rollback");
    }
  });
});

databaseIt("accepts a new public table that grants authenticated and service_role and leaves anon out", async () => {
  await withClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role");
      const boundary = (await client.query("select max(oid)::bigint::text as value from pg_class")).rows[0].value;
      await client.query(`create table public.tm_grant_probe_e (id int);
        revoke all on table public.tm_grant_probe_e from public, anon;
        grant select on public.tm_grant_probe_e to authenticated, service_role;
        create table public.tm_grant_probe_f (id int);
        grant select on public.tm_grant_probe_f to authenticated;`);
      // anon is optional (MAIN 99, 3:42 PM ET); a table missing service_role still fails.
      expect(await tablesMissingGrants(client, { boundary })).toEqual([{ table: "tm_grant_probe_f", missing: ["service_role"] }]);
    } finally {
      await client.query("rollback");
    }
  });
});
