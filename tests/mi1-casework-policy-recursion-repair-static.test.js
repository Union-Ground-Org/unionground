// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("mi1_casework_policy_recursion_repair"));

function policy(name) {
  const start = sql.indexOf(`create policy ${name}`);
  expect(start, `${name} policy must exist`).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf(";", start));
}

describe("MI1 casework RLS recursion repair", () => {
  it("checks active grants through a private SECURITY DEFINER helper", () => {
    const helper = fnBody(sql, "private.casework_actor_has_active_grant");
    expect(helper).toContain("security definer");
    expect(helper).toContain("set search_path = ''");
    expect(helper).toContain("from public.casework_access_grants g");
    expect(helper).toContain("g.case_id = p_case_id");
    expect(helper).toContain("g.grantee_user_id = (select auth.uid())");
    expect(helper).toContain("g.revoked_at is null");
  });

  it("grants only the execution privilege required by the authenticated policy", () => {
    expect(sql).toMatch(
      /revoke all on function private\.casework_actor_has_active_grant\(uuid\)\s+from public, anon, authenticated, service_role;/,
    );
    expect(sql).toMatch(
      /grant execute on function private\.casework_actor_has_active_grant\(uuid\)\s+to authenticated;/,
    );
    expect(sql).not.toMatch(
      /grant execute on function private\.casework_actor_has_active_grant\(uuid\)\s+to (?:public|anon|service_role)/,
    );
  });

  it("removes the cross-table subquery from the member_cases policy", () => {
    const coordinatorPolicy = policy("member_cases_select_coordinator");
    expect(coordinatorPolicy).toContain("private.casework_actor_has_active_grant(id)");
    expect(coordinatorPolicy).not.toContain("casework_access_grants");
    expect(coordinatorPolicy).toContain("public.staff_can_see_user(user_id, 'coordinator')");
    expect(coordinatorPolicy).toContain("not is_restricted");
    expect(coordinatorPolicy).toContain("coordinator_user_id = (select auth.uid())");
    expect(coordinatorPolicy).toContain("private.has_organization_role(organization_id, array['advisor','admin','vp'])");
  });
});
