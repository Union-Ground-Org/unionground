import { describe, expect, it } from "vitest";

import {
  RETENTION_SCHEMA_OBJECT_KEYS,
  RETENTION_SCHEMA_RESET_SQL,
  classifyRetentionSchemaState,
  recordedMigrationMatches,
} from "../scripts/lib/retention-schema-mode.mjs";

function state(value, migrationRecorded, migrationMatches = false) {
  return Object.fromEntries([
    ...RETENTION_SCHEMA_OBJECT_KEYS.map((key) => [key, value]),
    ["migration_recorded", migrationRecorded],
    ["migration_matches", migrationMatches],
  ]);
}

describe("retention proof schema classification", () => {
  it("applies the migration only to a fresh unrecorded schema", () => {
    expect(classifyRetentionSchemaState(state(false, false))).toEqual({
      applyMigration: true,
      resetExisting: false,
      mode: "fresh migration",
    });
  });

  it("rebuilds a complete recorded schema so live definition drift cannot be reused", () => {
    expect(classifyRetentionSchemaState(state(true, true, true))).toEqual({
      applyMigration: true,
      resetExisting: true,
      mode: "rebuilt exact recorded migration",
    });
  });

  it("removes every proof-owned table, function, policy host, and base-table index before replay", () => {
    for (const object of [
      "organization_retention_policies",
      "organization_retention_runs",
      "retention_data_class_config",
      "retention_eligible_count",
      "retention_scheduler_configured",
      "assert_retention_admin",
      "get_organization_retention_engine",
      "upsert_organization_retention_policy",
      "preview_organization_retention_run",
      "authorize_organization_retention_run",
      "perform_organization_retention_run",
      "execute_organization_retention_run",
      "run_due_organization_retention_jobs",
      "demo_seed_retention_engine",
      "demo_seed_retention_status",
      "demo_seed_remove_retention_engine",
      "organization_page_views_retention_idx",
      "organization_engagement_events_retention_idx",
      "integration_jobs_retention_idx",
      "public_event_rsvps_retention_idx",
      "chapter_tasks_retention_idx",
    ]) {
      expect(RETENTION_SCHEMA_RESET_SQL).toContain(object);
    }
    expect(RETENTION_SCHEMA_RESET_SQL).not.toMatch(/drop\s+schema/i);
  });

  it("matches the Supabase CLI statement-array representation", () => {
    expect(recordedMigrationMatches({
      expectedName: "retention_engine",
      expectedSql: "select 1;\nselect 2;",
      recordedName: "retention_engine",
      recordedStatements: ["select 1", "select 2"],
    })).toBe(true);
  });

  it("rejects content drift even when the migration identity still matches", () => {
    const exact = {
      expectedName: "retention_engine",
      expectedSql: "create table public.retention_runs (id uuid);",
      recordedName: "retention_engine",
      recordedStatements: ["create table public.retention_jobs (id uuid)"],
    };
    expect(recordedMigrationMatches(exact)).toBe(false);
    expect(() => classifyRetentionSchemaState(state(true, true, false))).toThrow(
      /recorded migration does not match checked-in SQL/,
    );
  });

  it.each([
    ["wrong name", { recordedName: "other", recordedStatements: ["select 1"] }],
    ["null statements", { recordedName: "retention_engine", recordedStatements: null }],
    ["empty statements", { recordedName: "retention_engine", recordedStatements: [] }],
    ["null statement", { recordedName: "retention_engine", recordedStatements: ["select 1", null] }],
  ])("rejects %s in recorded history", (_label, recorded) => {
    expect(recordedMigrationMatches({
      expectedName: "retention_engine",
      expectedSql: "select 1;",
      ...recorded,
    })).toBe(false);
  });

  it.each([
    ["complete but unrecorded", state(true, false)],
    ["recorded but absent", state(false, true, true)],
    ["partially present", { ...state(true, true, true), execute_run: false }],
  ])("fails closed for %s state", (_label, current) => {
    expect(() => classifyRetentionSchemaState(current)).toThrow(
      /Refusing retention proof against partial or unrecorded schema/,
    );
  });
});
