// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const source = loadMigrationSql("steward_desk_setwise_visibility");
const sql = stripComments(source).replace(/\s+/g, " ").trim().toLowerCase();
const helper = fnBody(source, "private.staff_visible_member_ids");
const contract = JSON.parse(
  readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"),
);

const POLICY_TABLES = [
  "member_steward_requests",
  "member_conversations",
  "member_messages",
  "member_profiles",
  "member_forms",
];

describe("steward desk set-wise visibility migration", () => {
  it("keeps the helper outside the exposed RPC schema and adds no schema grant", () => {
    expect(helper).toContain("create or replace function private.staff_visible_member_ids");
    expect(helper).toContain("stable");
    expect(helper).toContain("security definer");
    expect(helper).toContain("set search_path = ''");
    expect(sql).toContain(
      "revoke all on function private.staff_visible_member_ids(text) from public, anon, authenticated, service_role",
    );
    expect(sql).toContain(
      "grant execute on function private.staff_visible_member_ids(text) to authenticated, service_role",
    );
    expect(sql).not.toContain("grant usage on schema private");
    expect(sql).not.toContain("function public.staff_visible_member_ids");
  });

  it("mirrors both organization and legacy authorization branches, including active membership and both MFA gates", () => {
    for (const needle of [
      "(select private.current_member_organization())",
      "(select private.mfa_satisfied())",
      "chapter.organization_id = caller.organization_id",
      "private.has_organization_role(",
      "private.member_has_chapter_role(",
      "chapter.organization_id is null",
      "(select private.staff_mfa_required())",
      "(select private.has_second_factor(caller.uid))",
      "from public.member_roles role_grant",
      "from public.member_role_chapters role_chapter",
      "join public.member_chapter_memberships membership",
      "membership.status = 'active'",
      "visible_chapters.id = profile.chapter_id",
    ]) {
      expect(helper.toLowerCase(), needle).toContain(needle);
    }
  });

  it("changes only the five steward SELECT policies used by the desk to the private set, preserving the forms status allow-list", () => {
    expect(sql.match(/create policy [a-z0-9_]+_select_steward/g)).toHaveLength(5);
    for (const table of POLICY_TABLES) {
      expect(sql).toContain(
        `create policy ${table}_select_steward on public.${table} for select to authenticated`,
      );
    }
    expect(sql.match(/select private\.staff_visible_member_ids\('steward'\)/g)).toHaveLength(5);
    expect(sql).toContain(
      "create policy member_profiles_select_coordinator on public.member_profiles for select to authenticated",
    );
    expect(sql.match(/select private\.staff_visible_member_ids\('coordinator'\)/g)).toHaveLength(1);

    const policySection = sql.slice(sql.indexOf("drop policy member_steward_requests_select_steward"));
    expect(policySection).not.toContain("staff_can_see_user(");
    expect(policySection).toContain(
      "status in ('submitted', 'in_review') and user_id in ( select private.staff_visible_member_ids('steward') )",
    );
    expect(policySection).not.toContain("'draft'");
    expect(policySection).not.toContain("'returned'");
    expect(policySection).not.toContain("'approved'");
  });

  it("pins the private helper and all five replacement policy predicates in db-contract.json", () => {
    const helperContract = contract.functions.find(
      (entry) => entry.sig === "private.staff_visible_member_ids(p_role text)",
    );
    expect(helperContract).toMatchObject({
      secdef: true,
      exec: "authenticated,service_role",
    });
    expect(helperContract.bodyContains).toContain("membership.status = 'active'");

    for (const table of POLICY_TABLES) {
      const policy = contract.policies.find(
        // One OR branch of the merged policy since 20261028210000.
        (entry) => entry.table === table && entry.name === `${table}_select`,
      );
      expect(policy?.roles).toBe("authenticated");
      expect(policy?.qual).toContain(
        "private.staff_visible_member_ids('steward'::text)",
      );
      expect(policy?.qual).not.toContain("staff_can_see_user");
      expect(policy?.qualContains).toBeUndefined();
    }

    const coordinatorProfilePolicy = contract.policies.find(
      (entry) => entry.table === "member_profiles"
        && entry.name === "member_profiles_select", // merged in 20261028210000
    );
    expect(coordinatorProfilePolicy?.qual).toContain(
      "private.staff_visible_member_ids('coordinator'::text)",
    );
    expect(coordinatorProfilePolicy?.qual).not.toContain("staff_can_see_user");
  });
});
