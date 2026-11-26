import { canonicaliseSql } from "./sql-text.mjs";

export const RETENTION_SCHEMA_OBJECT_KEYS = Object.freeze([
  "policies",
  "runs",
  "reader",
  "upsert_policy",
  "preview_run",
  "authorize_run",
  "execute_run",
  "scheduled_run",
]);

export const RETENTION_SCHEMA_RESET_SQL = `
drop function if exists private.demo_seed_remove_retention_engine(text, uuid) cascade;
drop function if exists private.demo_seed_retention_status(text, uuid) cascade;
drop function if exists private.demo_seed_retention_engine(text, uuid, text, text) cascade;
drop function if exists private.run_due_organization_retention_jobs(integer) cascade;
drop function if exists public.execute_organization_retention_run(uuid) cascade;
drop function if exists private.perform_organization_retention_run(uuid) cascade;
drop function if exists public.authorize_organization_retention_run(uuid, text) cascade;
drop function if exists public.preview_organization_retention_run(text) cascade;
drop function if exists public.upsert_organization_retention_policy(text, integer, boolean, text) cascade;
drop function if exists public.get_organization_retention_engine() cascade;
drop function if exists private.assert_retention_admin(uuid) cascade;
drop function if exists private.retention_scheduler_configured() cascade;
drop function if exists private.retention_eligible_count(uuid, text, integer) cascade;
drop function if exists private.retention_data_class_config(text) cascade;
drop table if exists public.organization_retention_runs cascade;
drop table if exists public.organization_retention_policies cascade;
drop index if exists public.organization_page_views_retention_idx;
drop index if exists public.organization_engagement_events_retention_idx;
drop index if exists public.integration_jobs_retention_idx;
drop index if exists public.public_event_rsvps_retention_idx;
drop index if exists public.chapter_tasks_retention_idx;
`;

export function recordedMigrationMatches({
  expectedName,
  expectedSql,
  recordedName,
  recordedStatements,
}) {
  return recordedName === expectedName
    && typeof expectedSql === "string"
    && canonicaliseSql(expectedSql) !== ""
    && Array.isArray(recordedStatements)
    && recordedStatements.length > 0
    && recordedStatements.every((statement) => typeof statement === "string")
    && canonicaliseSql(recordedStatements.join("\n")) === canonicaliseSql(expectedSql);
}

export function classifyRetentionSchemaState(state) {
  const presentCount = RETENTION_SCHEMA_OBJECT_KEYS.filter((key) => state[key] === true).length;

  if (presentCount === 0 && state.migration_recorded === false) {
    return Object.freeze({ applyMigration: true, resetExisting: false, mode: "fresh migration" });
  }
  if (presentCount === RETENTION_SCHEMA_OBJECT_KEYS.length && state.migration_recorded === true) {
    if (state.migration_matches === true) {
      return Object.freeze({
        applyMigration: true,
        resetExisting: true,
        mode: "rebuilt exact recorded migration",
      });
    }
    throw new Error("Refusing retention proof: recorded migration does not match checked-in SQL");
  }

  const missing = RETENTION_SCHEMA_OBJECT_KEYS.filter((key) => state[key] !== true);
  throw new Error(
    `Refusing retention proof against partial or unrecorded schema: migrationRecorded=${state.migration_recorded}; missing=${missing.join(",") || "none"}`,
  );
}
