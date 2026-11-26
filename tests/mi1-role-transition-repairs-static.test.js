// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

const sql = loadMigrationSql("20260826158000_mi1_role_transition_and_contract_repairs");

describe("MI1 organization-role transition repairs", () => {
  it("backfills only historical organization-wide roles into active tenants", () => {
    expect(sql).toContain("insert into public.organization_role_grants");
    expect(sql).toContain("where legacy.chapter_id is null");
    expect(sql).toContain("membership.status = 'active'");
    expect(sql).toContain("organization.status = 'active'");
    expect(sql).not.toMatch(/where\s+legacy\.chapter_id\s+is\s+not\s+null/i);
  });

  it("does not fabricate an audit actor for unattributed historical grants", () => {
    expect(sql).toContain("where migrated.granted_by is not null");
    expect(sql).not.toContain("coalesce(migrated.granted_by, migrated.user_id)");
  });

  it("lets explicit organization grants activate legacy staff surfaces", () => {
    const memberHasRole = fnBody(sql, "public.member_has_role");
    expect(memberHasRole).toContain("public.organization_role_grants organization_role");
    expect(memberHasRole).toContain("organization_role.organization_id = selected.organization_id");
    expect(memberHasRole).toContain("organization_role.role = any(p_roles)");
    expect(memberHasRole).toContain("public.member_role_chapters chapter_role");
    expect(memberHasRole).toContain("chapter_role.chapter_id = selected.id");
    expect(memberHasRole).toContain("private.staff_mfa_required()");
  });
});
