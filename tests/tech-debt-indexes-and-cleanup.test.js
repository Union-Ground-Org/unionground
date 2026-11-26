// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";

// These are text pins, and text pins are a tripwire, not a proof: they assert
// what the migration SAYS, not what the database ENDS UP with. Whether the
// seven indexes are actually present and actually chosen by the planner, and
// whether exactly one save_member_guide_exchange overload survives in the
// catalog, can only be answered by pg_indexes / pg_proc against the live
// database after apply — that output is the evidence. What lives here is the
// cheap half: it catches an edit that widens a drop signature into the live
// 4-arg Compass write path, or that quietly loses an index, and it runs on
// every commit.
const allMigrations = migrationNames();
const sql = loadMigrationSql("tech_debt_indexes_and_cleanup");

// Comments are prose and legitimately name signatures the statements must NOT
// touch, so every "does not contain" pin runs against executable SQL only.
const statements = stripComments(sql).replace(/\s+/g, " ").trim();

describe("tech-debt migration: covering indexes", () => {
  it("is ordered after every migration it depends on", () => {
    const name = allMigrations.find((entry) => entry.includes("tech_debt_indexes_and_cleanup"));
    expect(name).toMatch(/^\d{14}_tech_debt_indexes_and_cleanup\.sql$/);
    // This used to assert the file sorted LAST overall, which was only ever a
    // proxy for "after its dependencies" — true at the time because nothing
    // followed it. 20260725000000_atomic_member_write_rpcs.sql now does, so the
    // proxy is retired for the real condition: every object this migration
    // indexes or drops must already exist when it runs. Anything added after it
    // is none of this test's business.
    const dependencies = [
      "fresh_member_workflows", // member_ballot_votes, member_survey_responses, member_broadcasts, member_case_updates, member_guide_messages
      "admin_role_management", // member_admin_audit and both of its on-delete-set-null FKs
      "steward_forms_review", // private.form_required_keys(text) / form_template_label(text)
      "form_templates_lookup_rewrite", // the versioned overloads that must survive
    ];
    for (const fragment of dependencies) {
      const dependency = allMigrations.find((entry) => entry.includes(fragment));
      expect(dependency, `dependency migration "${fragment}"`).toBeDefined();
      expect(name.localeCompare(dependency), `${name} must sort after ${dependency}`).toBeGreaterThan(0);
    }
  });

  it("carries the reference tag", () => {
    expect(sql).toContain("REQ-UG-TECH-DEBT-20260724");
  });

  it.each([
    ["member_ballot_votes_user_id_idx", "member_ballot_votes", "user_id"],
    ["member_survey_responses_user_id_idx", "member_survey_responses", "user_id"],
    ["member_broadcasts_created_by_idx", "member_broadcasts", "created_by"],
    ["member_case_updates_user_id_idx", "member_case_updates", "user_id"],
    ["member_guide_messages_user_id_idx", "member_guide_messages", "user_id"],
    ["member_admin_audit_actor_idx", "member_admin_audit", "actor"],
    ["member_admin_audit_target_user_idx", "member_admin_audit", "target_user"],
  ])("creates %s idempotently and schema-qualified", (index, table, column) => {
    expect(statements).toContain(
      `create index if not exists ${index} on public.${table}(${column});`,
    );
  });

  it("creates exactly those seven indexes and every one is re-runnable", () => {
    const created = statements.match(/create index[^;]*;/g) ?? [];
    expect(created).toHaveLength(7);
    for (const stmt of created) {
      expect(stmt, "index creation must be idempotent").toContain("if not exists");
    }
  });
});

describe("tech-debt migration: dead function cleanup", () => {
  it("drops the orphaned 3-arg private guide helper by exact signature", () => {
    expect(statements).toContain(
      "drop function if exists private.save_member_guide_exchange(uuid, text, text);",
    );
    expect(statements).toContain(
      "revoke all on function private.save_member_guide_exchange(uuid, text, text) from public, anon, authenticated;",
    );
  });

  it("never touches the live 4-arg save_member_guide_exchange", () => {
    // public.save_member_guide_exchange(uuid, text, text, jsonb) is the Compass
    // persistence path used by src/lib/memberApi.js. Nothing executable in this
    // migration may name it, in any schema, under any verb.
    expect(statements).not.toContain("jsonb");
    expect(statements).not.toMatch(/public\.save_member_guide_exchange/);
    const guideStatements = statements.match(/[a-z][^;]*save_member_guide_exchange[^;]*;/g) ?? [];
    expect(guideStatements).toHaveLength(2);
    for (const stmt of guideStatements) {
      expect(stmt).toContain("private.save_member_guide_exchange(uuid, text, text)");
    }
  });

  it("drops only the unversioned form helpers, leaving the versioned overloads", () => {
    expect(statements).toContain("drop function if exists private.form_required_keys(text);");
    expect(statements).toContain("drop function if exists private.form_template_label(text);");
    expect(statements).not.toContain("form_required_keys(text, integer)");
    expect(statements).not.toContain("form_template_label_localized");
    // form_points has no versioned replacement and submit_form still uses it.
    expect(statements).not.toContain("form_points");
  });

  it("stays additive: no table, policy, column, or grant is removed", () => {
    const drops = statements.match(/drop [a-z ]+/g) ?? [];
    expect(drops.every((d) => d.startsWith("drop function if exists"))).toBe(true);
    expect(statements).not.toMatch(/alter table/);
    expect(statements).not.toMatch(/drop policy|drop table|drop column|drop trigger/);
    expect(statements, "no new client reachability").not.toMatch(/grant /);
  });
});
