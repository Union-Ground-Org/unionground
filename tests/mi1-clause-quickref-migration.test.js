// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("20260827180000_mi1_contract_clause_quickref"));

describe("CR-068 clause persistence", () => {
  it("creates an organization-scoped empty table with RPC-only writes", () => {
    expect(sql).toContain("create table public.contract_clauses");
    expect(sql).toContain("organization_id uuid not null");
    expect(sql).toContain("revoke all on public.contract_clauses from public, anon, authenticated");
    expect(sql).toContain("grant select on public.contract_clauses to authenticated");
    expect(sql).not.toMatch(/insert into public\.contract_clauses\s+values/i);
    expect(sql).not.toContain("generated-contract-clauses.json");
  });

  it("derives tenant from the session and requires the expected-organization token on writes", () => {
    expect(sql).toContain("private.mi1_require_selected_organization()");
    expect(sql).toContain("private.mi1_require_expected_selected_organization(p_expected_organization_id)");
    expect(sql).toContain("create function public.list_contract_clauses()");
    expect(sql).toContain("create function public.list_contract_clause_grievance_counts()");
    expect(sql).toContain("create function public.create_contract_clause(");
    expect(sql).toContain("create function public.update_contract_clause(");
    expect(sql).toContain("create function public.set_contract_clause_status(");
    expect(sql).toMatch(/grant execute on function public\.list_contract_clauses\(\) to authenticated/);
  });

  it("keeps grievance counts aggregated and audit events bounded", () => {
    expect(sql).toContain("contract_clause_created");
    expect(sql).toContain("clauseId");
    expect(sql).not.toContain("select cs.title");
    expect(sql).not.toContain("user_id");
    expect(sql).toContain("'article', counts.article");
    expect(sql).toContain("'count', counts.n");
  });
});
