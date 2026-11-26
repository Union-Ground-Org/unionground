// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("20260822010000_mi1_organization_scope_foundation");
const code = stripComments(sql);
const body = (name) => stripComments(fnBody(sql, name));

describe("MI1 tenant-keyed staff MFA policy", () => {
  it("preserves the historical singleton only as a quarantined orphan policy", () => {
    expect(code).toContain("add column organization_id uuid");
    expect(code).toContain("add constraint org_security_policy_pkey primary key (policy_id)");
    expect(code).toMatch(/org_security_policy_organization_key[\s\S]*organization_id is not null/);
    expect(code).toMatch(/org_security_policy_legacy_singleton_key[\s\S]*organization_id is null/);
  });

  it("resolves organization policy by an exact key and fails closed when absent", () => {
    const keyed = body("private.staff_mfa_required(p_organization_id uuid)");
    expect(keyed).toContain("p.organization_id = p_organization_id");
    expect(keyed).not.toContain("limit 1");
    expect(keyed).not.toMatch(/where p\.id\b/);
    expect(keyed).toContain("when p_organization_id is null then true");

    const compatibility = body("private.staff_mfa_required()");
    expect(compatibility).toContain("private.current_member_organization()");
    expect(compatibility).toContain("private.staff_mfa_required(private.current_member_organization())");
    expect(compatibility).toContain("p.organization_id is null and p.id");
  });

  it("derives admin policy scope server-side and locks only that tenant row", () => {
    const getter = body("public.get_staff_mfa_policy()");
    const setter = body("public.set_staff_mfa_policy(p_required boolean)");
    for (const rpc of [getter, setter]) {
      expect(rpc).toContain("policy_org uuid := private.current_member_organization()");
      expect(rpc).toContain("private.has_organization_role(policy_org, array['admin'])");
      expect(rpc).not.toContain("p_organization_id");
      expect(rpc).not.toContain("limit 1");
    }
    expect(setter).toContain("on conflict (organization_id) where organization_id is not null do nothing");
    expect(setter).toMatch(/where p\.organization_id = policy_org\s+for update/);
    expect(setter).toContain("'staff_mfa_policy_changed'");
    expect(setter).not.toContain("'set_staff_mfa_policy'");
  });

  it("keeps standing self-scoped while reporting organization roles without an authorization loop", () => {
    const standing = body("public.get_staff_mfa_standing()");
    expect(standing).toContain("private.staff_mfa_required(policy_org)");
    expect(standing).toContain("public.organization_role_grants");
    expect(standing).toContain("public.member_role_chapters");
    expect(standing).not.toContain("member_has_role(");
  });

  it("keys explicit-actor background authorization to the target tenant", () => {
    const see = body("private.staff_actor_can_see_user");
    const chapter = body("private.actor_has_chapter_staff_role");
    for (const helper of [see, chapter]) {
      expect(helper).toContain("public.organizations o");
      expect(helper).toContain("o.status = 'active'");
      expect(helper).toContain("public.organization_memberships");
      expect(helper).toContain("public.organization_role_grants");
      expect(helper).toContain("public.member_role_chapters");
      expect(helper).toMatch(/private\.staff_mfa_required\([^)]*organization_id\)/);
      expect(helper).toContain("private.has_second_factor(p_actor)");
    }
  });
});
