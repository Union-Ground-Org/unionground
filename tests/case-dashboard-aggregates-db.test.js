// @vitest-environment node
//
// REQ-UG-CASEWORK-CONSOLE-54-CASE-DASHBOARDS-20260917.
//
// Static half: the five aggregates are definers with an empty search_path,
// PUBLIC/anon/service_role execute revoked, and none of them re-implements the
// visibility rule. Live half (REQUIRE_DB_REPAIR_PROOFS=1): the scope itself,
// against a real apply — tenant, restriction, assignee and role boundaries are
// behaviour no text pin can assert.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260917142000_case_dashboard_aggregates.sql",
);
const sql = readFileSync(migrationPath, "utf8");

const aggregates = [
  "casework_dashboard_open_cases_by_step",
  "casework_dashboard_deadlines_due_soon",
  "casework_dashboard_overdue_deadlines",
  "casework_dashboard_open_cases_by_assignee",
  "casework_dashboard_median_days_per_step",
];

describe("case dashboard aggregates", () => {
  it("wraps the whole apply in one transaction", () => {
    // A migration must be one atomic unit; this keeps that contract readable
    // from the suite.
    const statements = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    expect(statements.trimStart().startsWith("begin;")).toBe(true);
    expect(statements.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("ships every aggregate as an empty-search-path definer", () => {
    for (const name of aggregates) {
      const declaration = sql.slice(sql.indexOf(`create or replace function public.${name}(`));
      const header = declaration.slice(0, declaration.indexOf("as $function$"));
      expect(header, name).toMatch(/security definer/);
      expect(header, name).toMatch(/set search_path = ''/);
      expect(header, name).toMatch(/\bstable\b/);
    }
    for (const helper of ["casework_dashboard_require_staff", "casework_dashboard_open_cases"]) {
      const declaration = sql.slice(sql.indexOf(`create or replace function private.${helper}(`));
      const header = declaration.slice(0, declaration.indexOf("as $function$"));
      expect(header, helper).toMatch(/security definer/);
      expect(header, helper).toMatch(/set search_path = ''/);
    }
  });

  it("revokes PUBLIC, anon and service_role, then grants only authenticated", () => {
    for (const name of aggregates) {
      expect(sql).toContain(`revoke all on function public.${name}()\n  from public, anon, service_role;`);
      expect(sql).toContain(`grant execute on function public.${name}() to authenticated;`);
      expect(sql).toContain(`comment on function public.${name}() is`);
    }
    for (const helper of ["casework_dashboard_require_staff", "casework_dashboard_open_cases"]) {
      expect(sql).toContain(
        `revoke all on function private.${helper}()\n  from public, anon, authenticated, service_role;`,
      );
      expect(sql).not.toContain(`grant execute on function private.${helper}() to authenticated`);
    }
  });

  it("reuses the casework suite's own visibility helper instead of restating it", () => {
    // The whole security argument of a definer aggregate is that it narrows.
    // Re-deriving the restriction rule here would let the tiles and the RLS
    // policies drift, which is exactly how a restricted case leaks as a count.
    expect(sql).toContain("private.casework_staff_can_access(");
    expect(sql).not.toMatch(/is_restricted/);
    expect(sql).not.toMatch(/casework_access_grants/);
    // Tenant bound, on the staff gate, the open-case scope and the transition
    // scope alike: a tile that skipped it would count another organization.
    const body = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    expect(body.match(/private\.current_member_organization\(\)/g) ?? []).toHaveLength(3);
    expect(body.match(/private\.current_member_chapter\(\)/g) ?? []).toHaveLength(4);
  });

  it("adds no policy, table, or table grant", () => {
    expect(sql).not.toMatch(/create policy|alter policy|drop policy/i);
    expect(sql).not.toMatch(/create table|alter table/i);
    expect(sql).not.toMatch(/grant\s+(select|insert|update|delete)/i);
  });
});

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;
live("case dashboard aggregate scope (disposable database)", () => {
  it("bounds every tile by tenant, restriction, assignment and staff role", () => {
    const databaseUrl = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    const result = execFileSync(
      process.execPath,
      ["scripts/verify-case-dashboard-aggregates-local.mjs"],
      {
        encoding: "utf8",
        timeout: 180000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, SUPABASE_DB_URL: databaseUrl },
      },
    );
    const report = JSON.parse(result.trim());
    expect(report.status).toBe("passed");
    expect(report.checks).toHaveLength(11);
    expect(report.checks).toContain("the default steward tiles cover ordinary chapter grievances and keep restricted cases private");
  }, 190000);
});
