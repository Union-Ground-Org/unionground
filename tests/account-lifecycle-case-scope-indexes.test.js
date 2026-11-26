// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("account_lifecycle_case_scope_actor_indexes");
const statements = stripComments(sql).toLowerCase().replace(/\s+/g, " ").trim();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const indexes = [
  ["account_lifecycle_case_scope_owner_id_idx", "account_lifecycle_case_scope", "owner_id"],
  ["account_lifecycle_case_scope_steward_user_id_idx", "account_lifecycle_case_scope", "steward_user_id"],
  ["account_lifecycle_case_scope_coordinator_user_id_idx", "account_lifecycle_case_scope", "coordinator_user_id"]
];

// Union Ground's live-apply evidence package (APPLY.sql, VERIFY.sql and
// their SHA256SUMS) is a 509 operations record and is not carried; the
// migration and the catalog contract are the product surface pinned here.
describe("retained case-scope actor lookup indexes", () => {
  it.each(indexes)("keeps %s in the migration and catalog contract", (name, table, column) => {
    expect(statements).toContain(`create index if not exists ${name} on private.${table} (${column});`);
    const entry = contract.indexes.find((row) => row.name === name);
    expect(entry?.table).toBe(`private.${table}`);
    expect(entry?.defContains).toContain(`CREATE INDEX ${name} ON private.${table} USING btree (${column})`);
  });

  it("changes only the three indexes in a single migration transaction", () => {
    const expected = indexes.map(([name, table, column]) => `create index if not exists ${name} on private.${table} (${column});`).join(" ");
    expect(statements).toBe(`begin; set local lock_timeout = '5s'; set local statement_timeout = '120s'; ${expected} commit;`);
    expect(sql).toContain("LIVE APPLY");
    expect(sql).toContain("CONCURRENTLY cannot run inside");
  });
});

describe("retained grants lookup", () => {
  const migration = loadMigrationSql("account_lifecycle_grants_lookup");
  const oldCapture = fnBody(loadMigrationSql("account_lifecycle_manifest"), "private.capture_account_lifecycle_auth_scope()");
  const capture = fnBody(migration, "private.capture_account_lifecycle_auth_scope()");

  it("changes only the lookup predicate in the existing Auth trigger", () => {
    expect(capture).toBe(oldCapture.replace("create function", "create or replace function").replace(
      "exists(select 1 from pg_catalog.jsonb_array_elements(retained.grants) g where (g->>'grantee_user_id')::uuid = old.id)",
      "private.account_lifecycle_grant_lookup(retained.grants)\n      @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('grantee_user_id', old.id::text))"));
  });

  it("indexes the same canonical projection without changing retained JSON", () => {
    expect(migration).toContain("'private.account_lifecycle_grant_lookup(jsonb)'::regprocedure");
    expect(migration).toContain("using gin (private.account_lifecycle_grant_lookup(grants) jsonb_path_ops)");
    expect(migration).toContain("language sql immutable parallel safe set search_path = ''");
    expect(migration).toContain("(g->>'grantee_user_id')::uuid::text");
    expect(migration).toContain("revoke all on function private.account_lifecycle_grant_lookup(jsonb) from public, anon, authenticated, service_role");
    expect(contract.indexes.find(r => r.name === "account_lifecycle_case_scope_grants_lookup_idx")?.table)
      .toBe("private.account_lifecycle_case_scope");
  });
});
