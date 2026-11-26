// @vitest-environment node
// Full migrated disposable database only. Every statement is a read except the
// ACL transition, which runs inside a transaction that is always rolled back.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const REVOKED = ["DELETE", "INSERT", "UPDATE"];
const PRESERVED = ["MAINTAIN", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE"];
const corrective = readFileSync(new URL("../supabase/migrations/20261027002000_organizations_service_role_write_revoke.sql", import.meta.url), "utf8");

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

// BUG-UG-ORGANIZATIONS-HOSTED-SERVICE-ROLE-ACL-DRIFT-20261026: the fresh
// replay never lets service_role write public.organizations, so the revoke that
// reconciles Production is a no-op here and the exact contract stays the pin.
live("organizations service_role privileges", () => {
  let db;
  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
    await db.connect();
  });
  afterAll(async () => { await db.end(); });

  it("leaves service_role without INSERT, UPDATE or DELETE on public.organizations after the revoke", async () => {
    const { rows } = await db.query(`select privilege, pg_catalog.has_table_privilege('service_role', 'public.organizations', privilege) held
      from pg_catalog.unnest(array['INSERT','UPDATE','DELETE','SELECT','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) privilege order by privilege`);
    const held = Object.fromEntries(rows.map((row) => [row.privilege, row.held]));
    console.log("fresh replay service_role privileges on public.organizations:", rows.filter((row) => row.held).map((row) => row.privilege).join(", ") || "none");
    expect(held.INSERT).toBe(false);
    expect(held.UPDATE).toBe(false);
    expect(held.DELETE).toBe(false);
    // BUG-UG-ORGANIZATIONS-SERVICE-ROLE-ACL-TRANSITION-PROOF-COVERAGE-20261026:
    // the revoke must leave every other service_role privilege in place.
    for (const privilege of PRESERVED) expect(held[privilege], privilege).toBe(true);
  });

  // Production carried service_role=arwdDxtm/postgres (the hosted default ACL).
  // Recreate that pre-migration state, apply the corrective migration's exact
  // statements, and read both sides of the transition; then roll it all back.
  it("revokes only the three writes when applied to the hosted service_role=arwdDxtm grant", async () => {
    const lines = corrective.trimEnd().split("\n");
    expect(lines.filter((line) => /^(begin|commit);$/u.test(line))).toEqual(["begin;", "commit;"]);
    expect(corrective).toContain("revoke insert, update, delete on table public.organizations from service_role;");
    const body = lines.filter((line) => !/^(begin|commit);$/u.test(line)).join("\n");
    const read = async () => Object.fromEntries((await db.query(`select privilege, pg_catalog.has_table_privilege('service_role', 'public.organizations', privilege) held
      from pg_catalog.unnest($1::text[]) privilege`, [[...REVOKED, ...PRESERVED]])).rows.map((row) => [row.privilege, row.held]));
    await db.query("begin");
    try {
      await db.query("grant all on table public.organizations to service_role");
      expect(await read()).toEqual(Object.fromEntries([...REVOKED, ...PRESERVED].map((privilege) => [privilege, true])));
      await db.query(body);
      const after = await read();
      for (const privilege of REVOKED) expect(after[privilege], privilege).toBe(false);
      for (const privilege of PRESERVED) expect(after[privilege], privilege).toBe(true);
    } finally { await db.query("rollback"); }
  });

  it("keeps the client roles exactly as the foundation left them", async () => {
    const { rows } = await db.query(`select grantee, string_agg(privilege_type, ',' order by privilege_type) privileges
      from information_schema.role_table_grants where table_schema='public' and table_name='organizations' and grantee in ('anon','authenticated') group by grantee order by grantee`);
    expect(rows).toEqual([{ grantee: "authenticated", privileges: "SELECT" }]);
  });
});
