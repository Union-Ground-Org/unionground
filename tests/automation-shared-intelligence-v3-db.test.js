// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const migrationPath = "supabase/migrations/20260911070000_automation_shared_intelligence_v3.sql";
const proofPath = "scripts/verify-automation-shared-intelligence-v3-local.mjs";
const tenantPredicatePath = "supabase/migrations/20260924181000_automation_workspace_tenant_predicate.sql";

describe("shared automation intelligence v3 database contract", () => {
  it("ships the additive migration and executable behavioral proof", () => {
    expect(existsSync(migrationPath)).toBe(true);
    expect(existsSync(proofPath)).toBe(true);
  });

  it("separates exact-version review state from execution state", () => {
    const sql = readFileSync(migrationPath, "utf8").toLowerCase();
    expect(sql).toContain("review_status text not null default 'draft'");
    expect(sql).toContain("review_version integer");
    expect(sql).toContain("organization_automation_review_status_check");
    expect(sql).toContain("organization_automation_definition_reviews");
    expect(sql).toContain("automation_definition_reviews_append_only");
    expect(sql).toContain("account_lifecycle_trigger_review");
    expect(sql.match(/review_status\s*=\s*'draft'/g)?.length).toBeGreaterThanOrEqual(2);
    expect(sql).toContain("review_version is null");
    expect(sql.match(/review_status\s*=\s*'approved'/g)?.length).toBeGreaterThanOrEqual(4);
    expect(sql.match(/review_version\s*=\s*d\.version/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("defines author and approver guards plus the complete shared RPC surface", () => {
    const sql = readFileSync(migrationPath, "utf8").toLowerCase();
    expect(sql).toContain("private.automation_v3_require_author()");
    expect(sql).toContain("private.automation_v3_require_approver()");
    for (const rpc of [
      "mi1_get_automation_workspace",
      "mi1_get_automation_opportunities",
      "mi1_get_automation_ai_authorization",
      "mi1_submit_automation_definition",
      "mi1_review_automation_definition",
      "mi1_preview_automation_definition",
    ]) {
      expect(sql).toContain(`public.${rpc}`);
      expect(sql).toContain(`grant execute on function public.${rpc}`);
    }
    expect(sql).not.toMatch(/grant execute on function public\.mi1_(?:get_automation_workspace|get_automation_opportunities|get_automation_ai_authorization|submit_automation_definition|review_automation_definition|preview_automation_definition)[^;]*\s+to\s+(?:public|anon)\s*;/);
  });

  it("renders shared definitions without re-entering the operator-only v2 read guard", () => {
    const sql = readFileSync(migrationPath, "utf8").toLowerCase();
    const definitionJson = sql.slice(
      sql.indexOf("create or replace function private.automation_v3_definition_json"),
      sql.indexOf("create or replace function public.mi1_save_automation_definition_v2"),
    );
    expect(definitionJson).toContain("private.automation_v2_definition_json(d)");
    expect(definitionJson).toContain("private.automation_v3_source_visible");
    expect(definitionJson).not.toContain("private.automation_v2_definition_read");
  });

  it("projects every capability flag as an exact boolean even from nullable columns", () => {
    const sql = readFileSync(migrationPath, "utf8").toLowerCase();
    const definitionJson = sql.slice(
      sql.indexOf("create or replace function private.automation_v3_definition_json"),
      sql.indexOf("create or replace function public.mi1_save_automation_definition_v2"),
    );
    expect(definitionJson).toContain("'submittedbyself', coalesce(d.submitted_by = p_actor, false)");
    for (const flag of ["'canedit'", "'cansubmit'", "'canreview'", "'canactivate'", "'canpreview'"]) {
      expect(definitionJson).toMatch(new RegExp(`${flag}, coalesce\\(`));
    }
  });

  it("keeps the v2 selected-chapter appointment supervisor route when widening sources to authors", () => {
    const sql = readFileSync(migrationPath, "utf8").toLowerCase();
    const sourceVisible = sql.slice(
      sql.indexOf("create or replace function private.automation_v3_source_visible"),
      sql.indexOf("create or replace function private.automation_v2_source_visible"),
    );
    expect(sourceVisible).toContain("private.automation_v3_actor_is_author(p_actor, p_org)");
    expect(sourceVisible).toContain("m.user_id = a.steward_id and m.status = 'active'");
    expect(sourceVisible).toContain("p.id = p_actor and p.chapter_id = a.chapter_id");
    expect(sourceVisible).toContain("a.user_id = p_actor");
    expect(sourceVisible).toContain("g.chapter_id = a.chapter_id and g.role = 'steward'");
    expect(sourceVisible).toContain("g.role in ('coordinator', 'advisor', 'admin')");
  });

  it("enters every case-graph writer through the canonical lock call and pins its lifecycle trigger review", () => {
    const sql = readFileSync(migrationPath, "utf8").toLowerCase();
    expect(sql).not.toContain("lock_case_graph(array[(select auth.uid())]");
    expect(sql.match(/lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\)/g)?.length).toBe(7);
    expect(sql).toContain("insert into private.account_lifecycle_trigger_review");
    expect(sql).toContain("'automation_definition_reviews_append_only', 'd90332c6f879c51b1261db552dab0689'");
    expect(sql).toContain("select 1 from private.account_lifecycle_referential_action_trigger_issues()");
  });

  it("keeps opportunities aggregate-only and bounds both selection passes", () => {
    const sql = readFileSync(migrationPath, "utf8").toLowerCase();
    expect(sql).toContain("'candidatecount'");
    expect(sql).toContain("'thresholddays'");
    expect(sql).toContain("'scope'");
    expect(sql).toContain("'covered'");
    expect(sql).toContain("limit 8");
    for (const forbidden of ["'title'", "'description'", "'message'", "'note'", "'sourceid'", "'recipientid'"]) {
      const opportunities = sql.slice(sql.indexOf("create or replace function public.mi1_get_automation_opportunities"), sql.indexOf("create or replace function public.mi1_get_automation_ai_authorization"));
      expect(opportunities).not.toContain(forbidden);
    }
  });

  it("requires approved current versions in activation, manual execution, and both scheduler selections", () => {
    const sql = readFileSync(migrationPath, "utf8").toLowerCase();
    const status = sql.slice(sql.indexOf("create or replace function public.set_organization_automation_definition_status"), sql.indexOf("create or replace function public.execute_organization_automation_run"));
    const execute = sql.slice(sql.indexOf("create or replace function public.execute_organization_automation_run"), sql.indexOf("create or replace function private.run_due_organization_automations"));
    const scheduler = sql.slice(sql.indexOf("create or replace function private.run_due_organization_automations"));
    expect(status).toContain("review_status = 'approved'");
    expect(status).toContain("review_version = d.version");
    expect(execute).toContain("review_status = 'approved'");
    expect(execute).toContain("review_version = d.version");
    expect(scheduler.match(/review_status\s*=\s*'approved'/g)?.length).toBeGreaterThanOrEqual(2);
    expect(scheduler.match(/review_version\s*=\s*d\.version/g)?.length).toBeGreaterThanOrEqual(2);
  });

  // PERF-UG-MI1-GET-AUTOMATION-WORKSPACE-SCANS-ORGANIZATION-AUTOMATION-20260921
  it("bounds the workspace definitions page by an explicit tenant predicate the planner can use", () => {
    const sql = readFileSync(tenantPredicatePath, "utf8").toLowerCase();
    const workspace = sql.slice(sql.indexOf("create or replace function public.mi1_get_automation_workspace"));
    const definitionsPage = workspace.slice(
      workspace.indexOf("select * from public.organization_automation_definitions d"),
      workspace.indexOf("limit 100"),
    );
    expect(definitionsPage).toContain("where d.organization_id = org");
    expect(definitionsPage).toContain("and private.automation_v3_definition_visible(d, actor, org, approver)");
    // The tenant equality must stand on its own: a predicate that only reaches
    // the definer call is exactly the shape this record was opened against.
    expect(definitionsPage).not.toMatch(/where\s+private\.automation_v3_definition_visible/);
    expect(workspace).toContain("private.automation_v3_definition_json(d, actor, org, approver)");
    // The approver decision is derived once, in the declare block, and handed
    // to the predicate, the projection and the runs page.
    expect(workspace.match(/private\.automation_v3_actor_is_approver\(/g)?.length).toBe(1);
  });

  it("hands the projection the approver decision instead of re-deriving it per field", () => {
    const sql = readFileSync(tenantPredicatePath, "utf8").toLowerCase();
    const projection = sql.slice(
      sql.indexOf("create or replace function private.automation_v3_definition_json(\n  d public.organization_automation_definitions,\n  p_actor uuid,\n  p_org uuid,\n  p_approver boolean\n)"),
      sql.indexOf("-- unchanged contract for the single-row callers (save, submit, review)"),
    );
    expect(projection.length).toBeGreaterThan(0);
    expect(projection).not.toContain("private.automation_v3_actor_is_approver");
    expect(projection).toContain("approver boolean := coalesce(p_approver, false)");
    expect(projection).toContain("'canpreview', coalesce(private.automation_v3_definition_visible(d, p_actor, p_org, approver), false)");
    for (const flag of ["'canedit'", "'cansubmit'", "'canreview'", "'canactivate'", "'canpreview'"]) {
      expect(projection).toMatch(new RegExp(`${flag}, coalesce\\(`));
    }
  });

  it("keeps the visibility rule's own tenant check so every other caller stays bounded", () => {
    const sql = readFileSync(tenantPredicatePath, "utf8").toLowerCase();
    const visible = sql.slice(
      sql.indexOf("create or replace function private.automation_v3_definition_visible"),
      sql.indexOf("create or replace function private.automation_v3_definition_json"),
    );
    expect(visible).toContain("select d.organization_id = p_org");
    expect(visible).toContain("coalesce(p_approver, false)");
    // The three-argument form every single-row caller still uses resolves the
    // approver once and delegates to the four-argument rule.
    expect(visible).toContain("select private.automation_v3_definition_visible(\n    d, p_actor, p_org, private.automation_v3_actor_is_approver(p_actor, p_org)\n  );");
    expect(visible).toContain("security definer");
    expect(visible).toContain("set search_path = ''");
  });

  it("keeps staff previews inert while issuing an explicit phrase for an approver execution", () => {
    const sql = readFileSync(migrationPath, "utf8").toLowerCase();
    const preview = sql.slice(
      sql.indexOf("create or replace function public.mi1_preview_automation_definition"),
      sql.indexOf("create or replace function public.set_organization_automation_definition_status"),
    );
    expect(preview).toContain("'preview', 'previewed'");
    expect(preview).toContain("confirmation_phrase");
    expect(preview).toContain("'confirmationphrase'");
  });
});

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;
live("shared automation intelligence v3 database behavior", () => {
  it("proves authoring, MFA, review invalidation, execution, and scoped aggregates", () => {
    const databaseUrl = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    const result = execFileSync(process.execPath, [proofPath], {
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, SUPABASE_DB_URL: databaseUrl },
    });
    const outcome = JSON.parse(result.trim());
    expect(outcome).toMatchObject({ status: "passed" });
    // PERF-UG-MI1-GET-AUTOMATION-WORKSPACE-SCANS-ORGANIZATION-AUTOMATION-20260921:
    // the two-tenant scale case must have executed, not merely not failed.
    expect(outcome.checks.some((entry) => entry.startsWith("the workspace definitions page is tenant-bounded"))).toBe(true);
  }, 190000);
});
