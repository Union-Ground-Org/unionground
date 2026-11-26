// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findMigrationName, loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS,
// not that the three indexes exist in the catalog or that the planner picks
// them. pg_indexes after apply is the evidence, and scripts/db-contract.json
// #indexes is where verify:db asserts it. What lives here is the cheap half —
// it catches an index quietly lost in a rebase, and it runs on every commit.
// REQ-UG-FORMS-FK-INDEXES-20260726.

const allMigrations = migrationNames();
const migrationName = findMigrationName("forms_unindexed_fk_indexes");
const sql = loadMigrationSql("forms_unindexed_fk_indexes");
// The header enumerates FK constraints and index names it deliberately does
// NOT create, so every pin runs against executable SQL only.
const statements = stripComments(sql).replace(/\s+/g, " ").trim();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

// The three foreign keys the 20260724193000 sweep left uncovered, each
// established unindexed by matching the whole migration chain's indexes,
// primary keys and unique constraints against its leading column(s).
const INDEXES = [
  ["member_forms_case_id_idx", "member_forms", "case_id"],
  ["member_forms_template_idx", "member_forms", "template_key, template_version"],
  ["member_form_cosigners_invited_by_idx", "member_form_cosigners", "invited_by"],
];

describe("forms FK index migration", () => {
  it("is ordered after every migration it depends on", () => {
    expect(migrationName).toMatch(/^\d{14}_forms_unindexed_fk_indexes\.sql$/);
    for (const fragment of [
      "member_forms", // the table and its case_id column
      "steward_forms_review", // member_forms_case_id_fkey
      "member_forms_template_registry_fk", // template_version + member_forms_template_fkey
      "forms_alliance_cosigners", // member_form_cosigners.invited_by
    ]) {
      const dependency = allMigrations.find((entry) => entry.includes(fragment));
      expect(dependency, `dependency migration "${fragment}"`).toBeDefined();
      expect(migrationName.localeCompare(dependency), `${migrationName} must sort after ${dependency}`).toBeGreaterThan(0);
    }
  });

  it("carries the reference tag", () => {
    expect(sql).toContain("REQ-UG-FORMS-FK-INDEXES-20260726");
  });

  it.each(INDEXES)("creates %s idempotently and schema-qualified", (index, table, columns) => {
    expect(statements).toContain(`create index if not exists ${index} on public.${table}(${columns});`);
  });

  it("creates exactly those three indexes and every one is re-runnable", () => {
    const created = statements.match(/create index[^;]*;/g) ?? [];
    expect(created).toHaveLength(3);
    for (const stmt of created) {
      expect(stmt, "index creation must be idempotent").toContain("if not exists");
    }
  });

  it("follows the plain-CREATE-INDEX precedent and documents the caveat", () => {
    // CONCURRENTLY cannot run inside a transaction block and this repo applies
    // migrations through the single-transaction path (20260724193000 ~:18).
    // The precedent is only safe while it is stated, so the statement is pinned.
    expect(statements).not.toMatch(/concurrently/i);
    expect(sql).toContain("CONCURRENTLY cannot run inside a transaction block");
  });

  it("stays additive: no grant, policy, constraint, function or row is touched", () => {
    expect(statements).not.toMatch(/grant |revoke /i);
    expect(statements).not.toMatch(/create policy|drop policy|alter policy/i);
    expect(statements).not.toMatch(/alter table|drop index|drop table/i);
    expect(statements).not.toMatch(/create (or replace )?function|create trigger/i);
    expect(statements).not.toMatch(/insert into|update |delete from/i);
  });
});

describe("contract coordination (scripts/db-contract.json)", () => {
  it.each(INDEXES)("records %s so verify:db asserts it against the catalog", (index, table, columns) => {
    const entry = contract.indexes.find((row) => row.name === index);
    expect(entry, "an index the contract does not list is never checked").toBeTruthy();
    expect(entry.table).toBe(table);
    expect(entry.defContains).toContain(`USING btree (${columns})`);
  });
});
