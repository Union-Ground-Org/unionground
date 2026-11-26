// @vitest-environment node
//
// SEC-UG-CLIENT-DEFAULT-TABLE-PRIVILEGES-REVOKE-20261114
//
// After 20260725220000 (TRUNCATE) and 20260726010000 (REFERENCES, TRIGGER,
// MAINTAIN), new tables in public were still born with SELECT, INSERT, UPDATE
// and DELETE for anon and authenticated. 20261125120300 removes the rest of
// that default, for future tables only, so row security is never the only
// thing between a forgotten table and the public key.
import { describe, expect, it } from "vitest";
import { findMigrationName, loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";

const MIGRATION = "client_default_table_privileges_revoke";
const statements = stripComments(loadMigrationSql(MIGRATION));

describe("client default table privileges", () => {
  it("follows the two earlier default-ACL repairs and every table created before it", () => {
    const name = findMigrationName(MIGRATION);
    expect(name).toBe("20261125120300_client_default_table_privileges_revoke.sql");
    expect(name > "20260726010000_reftrigger_maintain_revoke_client_tables.sql").toBe(true);
    const tableMigrations = migrationNames().filter((other) => other < name
      && /create\s+table\s+(if\s+not\s+exists\s+)?public\./i.test(stripComments(loadMigrationSql(other.replace(/\.sql$/, "")))));
    expect(tableMigrations.length).toBeGreaterThan(0);
  });

  it("revokes the remaining DML default from both client roles, for role postgres in public", () => {
    expect(statements.trimStart().startsWith("begin;")).toBe(true);
    expect(statements.trimEnd().endsWith("commit;")).toBe(true);
    expect(statements).toContain(
      "alter default privileges for role postgres in schema public\n  revoke select, insert, update, delete on tables from anon, authenticated;",
    );
  });

  it("changes only the default: no table, sequence, function or policy is touched", () => {
    const withoutDefault = statements.replace(/alter\s+default\s+privileges\b[^;]*;/gi, "");
    expect(withoutDefault).not.toMatch(/\b(grant|revoke)\b/i);
    expect(statements).not.toMatch(/on\s+(sequences|functions|routines|types|schemas)\b/i);
    expect(statements).not.toMatch(/create\s+(table|policy|function)|drop\s+|alter\s+table/i);
    expect(statements, "service_role keeps its full default set").not.toMatch(/from[^;]*service_role/i);
  });
});
