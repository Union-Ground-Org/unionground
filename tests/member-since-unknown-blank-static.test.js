// @vitest-environment node
// BUG-UG-MEMBER-SINCE-WRONG-FOR-NEW-ACCOUNTS-20261003: offline pin for
// 20261004030000_member_since_unknown_is_blank.sql. The live behavior is proved
// by tests/member-since-default-db.test.js.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { foreignKeyRelevance } from "../scripts/account-case-graph-inventory.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

describe("member_since unknown-is-blank migration (static)", () => {
  const sql = loadMigrationSql("_member_since_unknown_is_blank.sql");
  const code = stripComments(sql);

  it("drops only the default and NOT NULL, in one short transaction, and rewrites no row", () => {
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    expect(code).toContain("set local lock_timeout = '5s';");
    expect(code).toContain("alter column member_since drop default,\n  alter column member_since drop not null;");
    expect(code).not.toMatch(/\bupdate\s+public\.member_profiles\b/i);
    expect(code).not.toMatch(/set default/i);
    expect(code).not.toContain("date_part");
    expect(code).toContain("null when unknown. Not the year the account was created.");
    expect(foreignKeyRelevance(sql)).toBeNull();
  });

  it("is the last migration to change the member_since column", () => {
    const changers = readdirSync("supabase/migrations")
      .sort()
      .filter((name) => /alter\s+column\s+member_since/i.test(stripComments(readFileSync(`supabase/migrations/${name}`, "utf8"))));
    expect(changers.at(-1)).toBe("20261004030000_member_since_unknown_is_blank.sql");
  });
});
