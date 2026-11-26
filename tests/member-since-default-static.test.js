// @vitest-environment node
// BUG-UG-MEMBER-SINCE-WRONG-FOR-NEW-ACCOUNTS-20261003: offline pin for
// 20261003066000_member_since_defaults_to_join_year.sql. The live default is
// proved by tests/member-since-default-db.test.js.
import { describe, expect, it } from "vitest";
import { foreignKeyRelevance } from "../scripts/account-case-graph-inventory.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

describe("member_since default migration (static)", () => {
  const sql = loadMigrationSql("_member_since_defaults_to_join_year.sql");
  const code = stripComments(sql);

  it("only changes the column default, in one short transaction", () => {
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    expect(code).toContain("set local lock_timeout = '5s';");
    expect(code).toContain("set default (pg_catalog.date_part('year', pg_catalog.now()))::integer;");
    expect(code).not.toMatch(/\bupdate\s+public\.member_profiles\b/i);
    expect(code).not.toContain("2023");
    expect(foreignKeyRelevance(sql)).toBeNull();
  });

  it("uses the same year as the staff overview's new-this-year count", () => {
    const overview = stripComments(loadMigrationSql("_vp_overview_tenant_scope.sql"));
    expect(overview).toContain("p.member_since = pg_catalog.date_part('year', pg_catalog.now())::int");
    expect(code).not.toContain("timezone(");
  });
});
