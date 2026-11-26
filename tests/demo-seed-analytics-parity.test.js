import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fnBody, migrationFiles } from "./helpers/migration.js";

const root = path.resolve(import.meta.dirname, "..");
// Seed, layout, and health pins below describe this migration only.
const analyticsCompletionName = "20260830070000_demo_seed_analytics_completion.sql";
const migrationPath = path.join(root, "supabase/migrations", analyticsCompletionName);

function migration() {
  return fs.readFileSync(migrationPath, "utf8");
}

// migrationFiles() is filename-sorted, which is the order Postgres applies
// migrations in, so the last declaration is the live one. Reading the analytics
// completion file stays green after a later create-or-replace moves the body.
function latestParityStatus(name) {
  const declaring = migrationFiles().filter((entry) => new RegExp(`create(?: or replace)? function ${name.replace(".", "\\.")}\\(`, "i").test(entry.sql));
  expect(declaring.length, name).toBeGreaterThan(0);
  expect(declaring.map((entry) => entry.name), name).toContain(analyticsCompletionName);
  const latest = declaring.at(-1);
  expect(latest.name.localeCompare(analyticsCompletionName), name).toBeGreaterThan(0);
  return fnBody(latest.sql, name);
}

describe("analytics SAMPLE seed completion", () => {
  it("promotes only CR-040 through CR-044 with explicit evidence keys", () => {
    const sql = migration();
    for (const [id, key] of [
      ["CR-040", "analytics-member-report-card"],
      ["CR-041", "analytics-organization-health"],
      ["CR-042", "analytics-explorer-datasets"],
      ["CR-043", "analytics-layout-studio"],
      ["CR-044", "analytics-chapter-charts"],
    ]) {
      expect(sql).toContain(`('${id}', '${key}')`);
    }
    expect(sql).toMatch(/set coverage = 'seeded'[\s\S]*gate_relation = null/);
  });

  it("adds a two-page layout contract and deterministic reversible ownership", () => {
    const sql = migration();
    expect(sql).toContain("('analyticsMemberExplorer', 25, 50, 'organization'");
    expect(sql).toContain("('analyticsOrganizationLayouts', 15, 30, 'organization'");
    expect(sql).toContain("('analyticsChapterLayouts', 15, 30, 'featured-chapter'");
    expect(sql).toContain("create table private.demo_seed_analytics_runs");
    expect(sql).toContain("private.member_stress_uuid(p_run_id::text || ':analytics:layout:' || i)");
    expect(sql).toMatch(/delete from public\.organization_analytics_layouts[\s\S]*demo_seed_analytics_runs/);
    expect(sql).toMatch(/delete from public\.organization_engagement_events[\s\S]*source_id like run\.source_prefix/);
    expect(sql).toContain("delete from private.demo_seed_page_evidence");
  });

  it("verifies the exact profile-sized event cohort and fails the transaction on drift", () => {
    const sql = migration();
    expect(sql).toContain("'expectedReportCardEvents'");
    expect(sql).toMatch(/selected_members[\s\S]*pg_catalog\.count\(\*\) \* 6/);
    expect(sql).not.toContain("pg_catalog.count(*) >= 600");
    expect(sql).toContain("raise exception 'analytics seed verification failed'");
  });

  it("remeasures analytics rows on the live public parity status check", () => {
    for (const [lane, functionName] of [
      ["presg", "public.presg_demo_function_parity_status"],
      ["uniondemo", "public.uniondemo_function_parity_status"],
    ]) {
      const body = latestParityStatus(functionName);
      expect(body).toContain(`create or replace function ${functionName}`);
      expect(body).toContain(`analytics_result := private.demo_seed_analytics_status('${lane}', p_run_id)`);
      expect(body).toContain(`auth_result := private.demo_seed_auth_operations_status('${lane}', p_run_id)`);
      expect(body).toContain("retention jsonb");
      expect(body).toContain(`retention := private.demo_seed_retention_status('${lane}', p_run_id)`);
      expect(body).toContain("'analytics', analytics_result");
      expect(body).toContain("'retentionEngine', retention");
      expect(body).toContain("coalesce((analytics_result ->> 'ok')::boolean, false)");
      expect(body).toContain("coalesce((retention ->> 'ok')::boolean, false)");
    }
  });

  it("seeds and removes a rolling 36-month health history for every lane chapter", () => {
    const sql = migration();
    expect(sql).toContain("create table private.demo_seed_analytics_health_rows");
    expect(sql).toContain("public.chapter_health_snapshots");
    expect(sql).toContain("pg_catalog.generate_series(0, 35)");
    expect(sql).toContain("'expectedHealthSnapshots'");
    expect(sql).toMatch(/delete from public\.chapter_health_snapshots[\s\S]*demo_seed_analytics_health_rows/);
    expect(sql).toContain("create function private.demo_seed_refresh_analytics_health(text, uuid)");
    expect(sql).toContain("create function private.demo_seed_rotate_analytics_health()");
    expect(sql).toMatch(/delete from public\.chapter_health_snapshots snapshot[\s\S]*owned\.measured_on < rolling_start/);
    expect(sql).toContain("cron.schedule('demo-seed-analytics-health-rotate'");
    expect(sql).toContain("select private.demo_seed_rotate_analytics_health()");
  });

  it("remeasures Explorer depth and exact layout scope, tenant, chapter, and spec", () => {
    const sql = migration();
    const status = sql.slice(
      sql.indexOf("create function private.demo_seed_analytics_status"),
      sql.indexOf("-- The public seed drivers"),
    );
    expect(sql).toContain("'explorerMembers'");
    expect(sql).toContain("'organizationLayouts'");
    expect(sql).toContain("'chapterLayouts'");
    expect(status).toMatch(/layout\.organization_id = run\.organization_id[\s\S]*layout\.scope = 'organization'[\s\S]*layout\.chapter_id is null[\s\S]*layout\.spec = pg_catalog\.jsonb_build_object\([\s\S]*'datasetId', 'organization:chapter-health'/);
    expect(status).toMatch(/layout\.organization_id = run\.organization_id[\s\S]*layout\.scope = 'chapter'[\s\S]*layout\.chapter_id = run\.chapter_id[\s\S]*layout\.spec = pg_catalog\.jsonb_build_object\([\s\S]*'datasetId', 'chapter:' \|\| run\.chapter_id \|\| ':health-trend'/);
    expect(sql).toContain("'analyticsMemberExplorer'");
  });

  it("seeds primary SAMPLE personas before load-test members and composes automatically", () => {
    const sql = migration();
    expect(sql).toContain("create table private.demo_seed_analytics_persona_links");
    expect(sql).toContain("raw_app_meta_data ->> 'sample_persona'");
    expect(sql).toContain("update public.member_profiles profile");
    expect(sql).toContain("previous_profile_chapter_id text,");
    expect(sql).not.toContain("previous_profile_chapter_id text not null");
    expect(sql).toContain("previous_profile_updated_at");
    expect(sql).toContain("'visibleSamplePersonas'");
    expect(sql).toMatch(/not exists \([\s\S]*demo_seed_ledger[\s\S]*\) desc/);
    expect(sql).toContain("create trigger demo_seed_analytics_after_page_evidence_insert");
    expect(sql).toContain("referencing new table as inserted_page_evidence");
    expect(sql).toContain("pg_catalog.pg_trigger_depth() > 1");
    expect(sql).toContain("create trigger demo_seed_analytics_after_evidence_delete");
    expect(sql).toContain("referencing old table as deleted_function_evidence");
  });

  it("requires exactly six distinct canonical SAMPLE hats for Union Demo", () => {
    const sql = migration();
    expect(sql).toContain("users.raw_app_meta_data ->> 'sample_persona' as hat");
    expect(sql).toContain("pg_catalog.count(distinct persona.hat) as distinct_hats");
    expect(sql).toContain("expected = 6 and distinct_hats = 6");
  });

  it("keeps helpers private and service-role-only", () => {
    const sql = migration();
    expect(sql).toMatch(/if \(select auth\.role\(\)\) <> 'service_role'/g);
    expect(sql).toContain("revoke all on private.demo_seed_analytics_runs");
    expect(sql).toContain("revoke all on function private.demo_seed_apply_analytics(text, uuid)");
    expect(sql).toContain("revoke all on function private.demo_seed_remove_analytics(text, uuid)");
    expect(sql).not.toMatch(/grant execute[\s\S]*authenticated/);
  });

  it("archives only the deterministic SAMPLE tenant when teardown begins", () => {
    const sql = migration();
    expect(sql).toContain("create function private.demo_seed_archive_organization_on_remove()");
    expect(sql).toContain("new.state = 'removing'");
    expect(sql).toContain("old.state is distinct from 'removing'");
    expect(sql).toContain("tg_table_name = 'presg_demo_runs'");
    expect(sql).toContain("set status = 'archived'");
    expect(sql).toContain("after update of state on private.presg_demo_runs");
    expect(sql).toContain("after update of state on private.uniondemo_runs");
  });
});
