// @vitest-environment node
//
// REQ-UG-DORMANT-61-RETIRE-SWEEP-20260917 — retire-by-default.
//
// The two legacy role-grant RPCs were superseded by selected-tenant role
// commands. This guard makes that disposition durable: historical migrations
// describe why the old routines existed, but no later migration or runnable
// application/tooling source may bring either capability back.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { migrationFiles, stripComments } from "./helpers/migration.js";

const root = process.cwd();
const retirement = "20260917050000_retire_superseded_role_grant_rpcs.sql";
const retiredNames = ["grant_member_role", "revoke_member_role"];
const read = (path) => readFileSync(path, "utf8");

function walk(directory, extensions) {
  const results = [];
  for (const name of readdirSync(directory)) {
    if (["node_modules", ".expo", "dist", "coverage"].includes(name)) continue;
    const path = join(directory, name);
    const stats = statSync(path);
    if (stats.isDirectory()) results.push(...walk(path, extensions));
    else if (extensions.some((extension) => name.endsWith(extension))) results.push(path);
  }
  return results;
}

function assertNoRetiredRoleRpc(source, label) {
  for (const name of retiredNames) {
    expect(source, `${label} reintroduces retired capability ${name}`)
      .not.toMatch(new RegExp(`\\b${name}\\b`, "i"));
  }
}

describe("superseded role-grant RPC retirement", () => {
  it("drops both exact legacy signatures", () => {
    const migration = migrationFiles().find((entry) => entry.name === retirement);
    expect(migration, "retirement migration is present").toBeDefined();
    const sql = stripComments(migration.sql).toLowerCase();
    expect(sql).toContain("drop function public.grant_member_role(uuid, text, text);");
    expect(sql).toContain("drop function public.revoke_member_role(uuid, text);");
  });

  it("rejects any later migration that restores either RPC", () => {
    const migrations = migrationFiles();
    const at = migrations.findIndex((entry) => entry.name === retirement);
    expect(at, "retirement migration ordering").toBeGreaterThan(-1);
    for (const migration of migrations.slice(at + 1)) {
      assertNoRetiredRoleRpc(stripComments(migration.sql), migration.name);
    }
  });

  it.each([
    "create function public.grant_member_role(uuid, text, text) returns jsonb language sql as 'select null';",
    "grant execute on function public.revoke_member_role(uuid, text) to authenticated;",
  ])("rejects a future migration restoring %s", (sql) => {
    expect(() => assertNoRetiredRoleRpc(stripComments(sql), "future migration")).toThrow();
  });

  // Union Ground ships no Cloudflare workers/ tree, so the scan covers the
  // application, API, mobile and script sources it does ship.
  it("has no runnable application, API, mobile, or script caller", () => {
    const sources = [
      ...walk(resolve(root, "src"), [".js", ".jsx"]),
      ...walk(resolve(root, "api"), [".js"]),
      ...walk(resolve(root, "apps"), [".js", ".jsx", ".ts", ".tsx"]),
      ...walk(resolve(root, "scripts"), [".js", ".mjs"]),
    ];
    expect(sources.length).toBeGreaterThan(200);
    for (const path of sources) assertNoRetiredRoleRpc(read(path), path);
  });

  it("records the disposition for future maintainers", () => {
    const agents = read(resolve(root, "docs/contracts/superseded-role-grant-rpcs.md"));
    expect(agents).toContain("Superseded role-grant RPCs disposition");
    for (const name of retiredNames) expect(agents).toContain(name);
  });
});
