// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";

const NAME = "20260907112000_knowledge_conversion_account_lifecycle";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);

describe("knowledge conversion account-lifecycle migration", () => {
  it("is a later atomic repair that detaches both retained attribution edges", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    expect(migrationNames().indexOf(`${NAME}.sql`)).toBeGreaterThan(
      migrationNames().indexOf("20260907111000_knowledge_workflow_conversion_provenance.sql"),
    );
    expect(code).toContain("drop constraint organization_knowledge_conversions_conversion_reviewed_by_fkey");
    expect(code).toContain("drop constraint organization_knowledge_conversions_corrected_by_fkey");
    expect(code).not.toMatch(/add constraint[^;]+(conversion_reviewed_by|corrected_by)[^;]+references auth\.users/i);
  });

  it("documents pseudonymous retention for both reviewer and corrector IDs", () => {
    expect(sql).toContain("conversion_reviewed_by is\n  'Pseudonymous Auth UUID");
    expect(sql).toContain("corrected_by is\n  'Pseudonymous Auth UUID");
  });
});
