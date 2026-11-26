// @vitest-environment node
// The offline half of the public-table grant probe
// (SYS-UG-REQUIRE-EXPLICIT-GRANTS-IN-MIGRATIONS-CREATING-PUBLIC-TABLES-20261022):
// which migrations a change adds or edits, holding the added ones out of the
// disposable workdir and back, and the exact restore of the saved defaults.
// tests/public-table-grants-db.test.js is the live half.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HELD_BACK_DIRECTORY, changedMigrations, holdBackMigrations, releaseMigrations, restoreDefaultTableGrants,
} from "../scripts/lib/public-table-grant-probe.mjs";

function repository() {
  const root = mkdtempSync(join(tmpdir(), "grant-probe-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const put = (name, sql) => { mkdirSync(join(root, "supabase", "migrations"), { recursive: true }); writeFileSync(join(root, "supabase", "migrations", name), sql); };
  git("init", "-q", "-b", "Main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  put("20260901000000_base.sql", "create table public.base_rows (id int);\n");
  git("add", "-A"); git("commit", "-qm", "base");
  return { root, git, put, base: git("rev-parse", "HEAD") };
}

describe("public table grant probe", () => {
  it("lists the migrations a change adds and edits, in version order, and refuses an unknown base", () => {
    const f = repository();
    try {
      f.put("20261022120000_second.sql", "select 1;\n");
      f.put("20261022110000_first.sql", "select 1;\n");
      writeFileSync(join(f.root, "supabase", "migrations", "20260901000000_base.sql"), "create table public.base_rows (id bigint);\n");
      f.git("add", "-A"); f.git("commit", "-qm", "change");
      expect(changedMigrations(f.root, f.base)).toEqual({
        added: ["20261022110000_first.sql", "20261022120000_second.sql"], edited: ["20260901000000_base.sql"],
      });
      expect(changedMigrations(f.root, "HEAD")).toEqual({ added: [], edited: [] });
      expect(changedMigrations(f.root, "0".repeat(40))).toBeNull();
      expect(changedMigrations(f.root, "")).toBeNull();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("holds added migrations out of the workdir copy and puts them back byte for byte", () => {
    const f = repository();
    try {
      const bytes = "begin;\ncreate table public.first_rows (id int);\ncommit;\n";
      f.put("20261022110000_first.sql", bytes);
      holdBackMigrations(f.root, ["20261022110000_first.sql"]);
      expect(existsSync(join(f.root, "supabase", "migrations", "20261022110000_first.sql"))).toBe(false);
      expect(readFileSync(join(f.root, HELD_BACK_DIRECTORY, "20261022110000_first.sql"), "utf8")).toBe(bytes);
      releaseMigrations(f.root, ["20261022110000_first.sql"]);
      expect(readFileSync(join(f.root, "supabase", "migrations", "20261022110000_first.sql"), "utf8")).toBe(bytes);
      expect(() => holdBackMigrations(f.root, ["20261022130000_missing.sql"])).toThrow(/not in the disposable workdir/);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("restores the saved defaults exactly and refuses an unknown role or privilege", async () => {
    const statements = [];
    const client = { query: async (sql) => { statements.push(sql); return { rows: [] }; } };
    await restoreDefaultTableGrants(client, [
      { role: "anon", privileges: ["delete", "insert", "select", "update"] },
      { role: "service_role", privileges: ["delete", "insert", "maintain", "references", "select", "trigger", "truncate", "update"] },
    ]);
    expect(statements).toEqual([
      "alter default privileges for role postgres in schema public grant delete, insert, select, update on tables to anon",
      "alter default privileges for role postgres in schema public grant delete, insert, maintain, references, select, trigger, truncate, update on tables to service_role",
    ]);
    await expect(restoreDefaultTableGrants(client, [{ role: "postgres", privileges: ["select"] }])).rejects.toThrow(/unexpected role/);
    await expect(restoreDefaultTableGrants(client, [{ role: "anon", privileges: ["select; drop table x"] }])).rejects.toThrow(/unknown default privilege/);
  });
});
