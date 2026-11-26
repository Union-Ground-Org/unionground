// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

// UX-UG-NEW-MEMBER-ROLE-LINE-LEGACY-TENANT-BRAND-20260921
//
// A member who signs up without choosing a role line reads whatever
// public.member_profiles.role_line defaults to, because
// private.handle_new_member() inserts the profile without that column. The
// default therefore has to stay tenant-neutral: the first migration's
// single-agency literal showed one employer's brand to every account created
// in any organization. These pins are derived from the applied migration
// history rather than from one file, so a later migration that reintroduces a
// branded default fails here too. The live half creates an identity on the
// applied schema and reads the profile the new-member trigger wrote.

const migrationsDir = path.resolve("supabase/migrations");
const migrations = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
const read = (name) => readFileSync(path.join(migrationsDir, name), "utf8");

function effectiveRoleLineDefault() {
  let current = null;
  for (const name of migrations) {
    const sql = read(name);
    const created = sql.match(/create table public\.member_profiles\s*\(([\s\S]*?)\n\);/i);
    if (created) {
      const column = created[1].split("\n").find((line) => /^\s*role_line\s/i.test(line));
      current = column?.match(/default\s+'((?:[^']|'')*)'/i)?.[1] ?? null;
    }
    for (const [, action, literal] of sql.matchAll(
      /alter\s+table\s+(?:only\s+)?public\.member_profiles\s+alter\s+column\s+role_line\s+(set\s+default\s+'((?:[^']|'')*)'|drop\s+default)/gi,
    )) {
      current = action.startsWith("drop") ? null : literal;
    }
  }
  return current;
}

function newMemberProfileInsertColumns() {
  const defining = migrations.filter((name) => /function private\.handle_new_member\(\)/.test(read(name)));
  const body = read(defining.at(-1));
  const insert = body.match(/insert into public\.member_profiles\s*\(([^)]*)\)/i);
  return insert[1].split(",").map((column) => column.trim());
}

describe("member_profiles.role_line default", () => {
  it("is tenant-neutral, so a new account never inherits another organization's brand", () => {
    const value = effectiveRoleLineDefault();
    expect(value).toBe("Member");
    expect(value).not.toMatch(/MassAbility|·/);
  });

  it("is what signup actually applies, because the new-member trigger omits the column", () => {
    const columns = newMemberProfileInsertColumns();
    expect(columns).not.toContain("role_line");
    expect(columns).toContain("first_name");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("a new identity's profile role line on the applied schema", () => {
  let client;
  const user = randomUUID();

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "member-profile-role-line-default-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");
    await client.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{}')", [user, `${user}@example.invalid`]);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("keeps the new-member trigger on auth.users", async () => {
    const { rows } = await client.query(`
      select tgfoid::regprocedure::text as fn from pg_catalog.pg_trigger
       where tgrelid = 'auth.users'::regclass and tgname = 'on_auth_user_created_member_app' and tgenabled <> 'D'
    `);
    expect(rows).toEqual([{ fn: "private.handle_new_member()" }]);
  });

  it("gives the profile handle_new_member created the tenant-neutral role line", async () => {
    const { rows } = await client.query("select role_line from public.member_profiles where id = $1", [user]);
    expect(rows).toHaveLength(1);
    expect(rows[0].role_line).toBe("Member");
    expect(rows[0].role_line).not.toMatch(/MassAbility/);
  });

  it("applies a column default that names no organization", async () => {
    const { rows } = await client.query(`
      select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'member_profiles' and column_name = 'role_line'
    `);
    expect(rows[0].column_default).toBe("'Member'::text");
  });
});
