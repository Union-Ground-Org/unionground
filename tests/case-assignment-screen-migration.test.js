// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

const sql = loadMigrationSql("20260810210000_case_assignment_screen.sql");

describe("UB-CASE-03 assignment boundary", () => {
  const assign = fnBody(sql, "assign_member_case");
  const candidates = fnBody(sql, "list_member_case_assignment_candidates");

  it("requires MFA, coordinator authority, locked case scope, and scoped assignee roles", () => {
    for (const body of [assign, candidates]) {
      expect(body).toContain("private.mfa_satisfied()");
      expect(body).toContain("member_has_role(array['coordinator', 'admin'])");
      expect(body).toContain("staff_can_see_user");
    }
    expect(assign).toContain("for update");
    expect(assign).toContain("r.chapter_id is null or r.chapter_id = case_chapter");
  });

  it("returns only bounded steward/coordinator candidates", () => {
    expect(candidates).toContain("r.role in ('steward', 'coordinator')");
    expect(candidates).toContain("limit 200");
    expect(candidates).not.toContain("email");
  });

  it("records immutable before/after evidence while direct writes stay revoked", () => {
    expect(sql).toContain("create table public.member_case_assignment_audit");
    expect(assign).toContain("before_assignment, after_assignment");
    expect(assign).toContain("if before_value = after_value then return; end if");
    expect(sql).toContain("revoke all on table public.member_case_assignment_audit from public, anon, authenticated");
    expect(sql).toContain("grant select on table public.member_case_assignment_audit to authenticated");
    expect(sql).not.toMatch(/grant (insert|update|delete)[^;]*member_case_assignment_audit/i);
    expect(sql).toContain("create trigger member_case_assignment_audit_immutable");
    expect(fnBody(sql, "private.prevent_case_assignment_audit_mutation")).toContain("case assignment audit is immutable");
  });

  it("exposes only the two authenticated RPCs", () => {
    expect(sql).toContain("grant execute on function public.assign_member_case(uuid, uuid, uuid) to authenticated");
    expect(sql).toContain("grant execute on function public.list_member_case_assignment_candidates(uuid) to authenticated");
  });
});
