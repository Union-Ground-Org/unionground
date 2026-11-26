// @vitest-environment node
//
// REQ-UG-DORMANT-67-CATALOG-HANDOFF-READS-20260917 — retire-by-default.
//
// Four authenticated read RPCs shipped with no caller. This file is the
// durable half of the disposition in
// 20260917051000_retire_dormant_catalog_handoff_reads.sql: it proves the
// reverse dependencies are gone, and it fails if any later migration, client,
// API or script reintroduces a retired reader.
//
// Lane 6.1 is separately creating tests/retired-capabilities-sweep.test.js.
// This file follows tests/messaging-retired-channel-controls.test.js so the
// two can be folded later without losing the catalog/handoff pins.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { migrationFiles, stripComments } from "./helpers/migration.js";

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), "utf8");
const migrations = migrationFiles();
const entry = migrations.find((file) => file.name === "20260917051000_retire_dormant_catalog_handoff_reads.sql");
const sql = stripComments(entry.sql).toLowerCase();

const RETIRED_FUNCTIONS = [
  ["public.list_resource_catalog", "text, text"],
  ["public.get_resource_catalog_item", "uuid"],
  ["public.get_steward_library_file", "uuid"],
  ["public.get_member_steward_relationship", "uuid"],
];

const RETIRED_NAMES = RETIRED_FUNCTIONS.map(([name]) => name.slice("public.".length));

function walk(directory, extensions) {
  const results = [];
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name === ".expo" || name === "dist" || name === "coverage") continue;
    const path = join(directory, name);
    const stats = statSync(path);
    if (stats.isDirectory()) results.push(...walk(path, extensions));
    else if (extensions.some((extension) => name.endsWith(extension))) results.push(path);
  }
  return results;
}

describe("the catalog and member-handoff read retirement", () => {
  it("exists as a forward-only transaction with a written disposition", () => {
    expect(entry, "retirement migration is present").toBeTruthy();
    expect(entry.sql).toMatch(/^\s*begin;/);
    expect(entry.sql).toMatch(/commit;\s*$/);
    expect(entry.sql).toContain("REQ-UG-DORMANT-67-CATALOG-HANDOFF-READS-20260917");
    expect(entry.sql).toContain("BINDING DISPOSITION");
    for (const name of RETIRED_NAMES) {
      expect(entry.sql, `${name} is named in the disposition`).toContain(name);
      expect(entry.sql.toLowerCase(), `${name} is marked retired`).toMatch(new RegExp(`${name}[\\s\\S]{0,80}retired`, "i"));
    }
  });

  it("withdraws EXECUTE before dropping each function", () => {
    for (const [name, args] of RETIRED_FUNCTIONS) {
      const revoke = sql.indexOf(`revoke all on function ${name}(${args})`);
      const drop = sql.indexOf(`drop function ${name}(${args});`);
      expect(revoke, `${name} revoke`).toBeGreaterThan(-1);
      expect(drop, `${name} drop`).toBeGreaterThan(-1);
      expect(drop, `${name} drop follows revoke`).toBeGreaterThan(revoke);
    }
  });

  it("does not recreate, grant, or replace the retired readers", () => {
    expect(sql).not.toMatch(/create(?:\s+or\s+replace)?\s+function public\.(list_resource_catalog|get_resource_catalog_item|get_steward_library_file|get_member_steward_relationship)\s*\(/);
    expect(sql).not.toMatch(/grant\s+execute\s+on\s+function public\.(list_resource_catalog|get_resource_catalog_item|get_steward_library_file|get_member_steward_relationship)\s*\(/);
  });

  it("leaves the guarded twins in place", () => {
    expect(sql).not.toContain("drop function public.list_resource_catalog_page");
    expect(sql).not.toContain("drop function public.download_resource_catalog_item");
    expect(sql).not.toContain("drop function public.list_steward_library_files_page");
    expect(sql).not.toContain("drop function public.download_steward_library_file");
    expect(sql).not.toContain("drop function public.list_member_handoffs_v2");
  });
});

describe("reverse-dependency proof", () => {
  function assertFutureMigration(file) {
    const code = stripComments(file.sql).toLowerCase();
    for (const [name, args] of RETIRED_FUNCTIONS) {
      expect(code, `${file.name} recreates ${name}`).not.toMatch(
        new RegExp(`create(?:\\s+or\\s+replace)?\\s+function ${name.replace(".", "\\.")}\\s*\\(`),
      );
      expect(code, `${file.name} re-grants ${name}`).not.toContain(`grant execute on function ${name}(${args})`);
    }
  }

  it("no subsequent migration restores the retired readers", () => {
    for (const file of migrations.filter((candidate) => candidate.name > entry.name)) assertFutureMigration(file);
  });

  const restorations = RETIRED_FUNCTIONS.flatMap(([name, args]) => [
    `create function ${name}(${args}) returns jsonb language sql as 'select';`,
    `grant execute on function ${name}(${args}) to authenticated;`,
  ]);
  it.each(restorations)("rejects a future migration restoring %s", (statement) => {
    expect(() => assertFutureMigration({ name: "20260918000000_restore_catalog_handoff_reads.sql", sql: statement })).toThrow();
  });

  // Union Ground ships no Cloudflare workers/ tree.
  it("no client, API or script calls the retired readers", () => {
    const sources = [
      ...walk(resolve(root, "src"), [".js", ".jsx"]),
      ...walk(resolve(root, "api"), [".js"]),
      ...walk(resolve(root, "apps/mobile/src"), [".ts", ".tsx"]),
      ...walk(resolve(root, "apps/mobile/app"), [".ts", ".tsx"]),
      ...walk(resolve(root, "scripts"), [".mjs"]),
    ];
    expect(sources.length).toBeGreaterThan(200);
    const offenders = [];
    for (const path of sources) {
      const source = readFileSync(path, "utf8");
      for (const name of RETIRED_NAMES) {
        // Word-boundary so list_resource_catalog_page is not a hit on the
        // retired unpaged list_resource_catalog reader.
        if (new RegExp(`\\b${name}\\b`).test(source)) offenders.push(`${path}: ${name}`);
      }
    }
    expect(offenders, "retired catalog/handoff readers have reappeared").toEqual([]);
  });

  it("records the drops in the database contract and removes the live pins", () => {
    const contract = JSON.parse(read("scripts/db-contract.json"));
    const live = new Set(contract.functions.map((item) => item.sig));
    const absent = new Map(contract.functionsAbsent.map((item) => [item.sig, item]));
    for (const sig of [
      "public.list_resource_catalog(p_query text, p_category text)",
      "public.get_resource_catalog_item(p_file_id uuid)",
      "public.get_steward_library_file(p_file_id uuid)",
      "public.get_member_steward_relationship(p_member_user_id uuid)",
    ]) {
      expect(live.has(sig), `${sig} must leave functions[]`).toBe(false);
      expect(absent.get(sig)?.droppedBy).toBe("20260917051000_retire_dormant_catalog_handoff_reads");
      expect(absent.get(sig)?.note.length).toBeGreaterThan(30);
    }
    const page = contract.functions.find((item) => item.sig.startsWith("public.list_resource_catalog_page("));
    expect(page?.bodyContains).toContain("private.private_upload_is_current('organization-knowledge', source.storage_path)");
    expect(page?.bodyForbids).toContain("scan_status");
    expect(page?.note).not.toMatch(/list_resource_catalog is/);
  });
});
