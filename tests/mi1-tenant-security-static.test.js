// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("20260822010000_mi1_organization_scope_foundation");
const code = stripComments(sql);
const adapter = readFileSync(new URL("../src/features/tenancy/organizationScope.js", import.meta.url), "utf8");
const verifier = readFileSync(new URL("../scripts/verify-mi1-organization-scope.mjs", import.meta.url), "utf8");

describe("MI1 tenancy security static contract", () => {
  it("pins every new definer to an empty search_path and revokes PUBLIC execute", () => {
    const definers = [
      "private.current_member_organization",
      "private.staff_mfa_required(p_organization_id uuid)",
      "private.is_organization_member",
      "private.has_organization_role",
      "private.can_read_member_broadcast",
      "private.assign_member_admin_audit_organization",
      "public.bootstrap_first_organization",
      "public.member_has_role",
      "public.staff_can_see_user",
      "public.get_staff_mfa_policy",
      "public.set_staff_mfa_policy",
      "public.get_staff_mfa_standing",
      "public.get_admin_audit",
      "public.set_member_organization_role",
      "private.staff_actor_can_see_user",
      "private.actor_has_chapter_staff_role",
      "public.publish_member_broadcast",
    ];
    for (const name of definers) {
      const body = stripComments(fnBody(sql, name));
      expect(body, name).toMatch(/set search_path = ''/i);
      expect(body, name).toMatch(/security definer/i);
    }
    expect(code).toMatch(/revoke all on function public\.bootstrap_first_organization\([\s\S]*?from public, anon, authenticated/);
    expect(code).toMatch(/revoke all on function private\.is_organization_member\(uuid\)\s+from public, anon, authenticated, service_role/);
  });

  it("refuses guessed org-backed metadata but preserves a claimed invitation's tenant enrollment", () => {
    const newest = stripComments(fnBody(sql, "private.handle_new_member"));
    expect(newest).toContain("insert into public.member_profiles");
    expect(newest).toContain("insert into public.member_chapter_memberships");
    expect(newest).toContain("not exists (select 1 from public.chapters");
    expect(newest).toContain("c.organization_id is not null");
    expect(newest).toContain("union_base_invitation_id");
    expect(newest).toContain("i.status = 'accepting'");
    expect(newest).toContain("i.normalized_email = pg_catalog.lower(new.email)");
    expect(newest).toContain("o.status = 'active'");
    expect(newest).toContain("insert into public.organization_memberships");
    for (const table of ["member_cases", "member_messages", "member_notifications", "member_rights_progress", "member_action_log"]) {
      expect(newest).not.toContain(table);
    }
  });

  it("keeps organization history while allowing the bootstrap creator to delete their account", () => {
    expect(code).toContain("created_by uuid references auth.users(id) on delete set null");
    expect(code).not.toContain("created_by uuid not null references auth.users(id) on delete restrict");
  });

  it("does not ship service-role material in the tenancy adapter", () => {
    expect(adapter).not.toMatch(/service_role/i);
    expect(adapter).not.toMatch(/eyJ/);
    expect(adapter).not.toContain("SUPABASE_SERVICE_ROLE");
    expect(adapter).toContain("bootstrap_first_organization");
  });

  it("uses one parameterized statement per live-proof query", () => {
    expect(verifier).toContain(
      '"insert into public.member_roles (user_id, role, chapter_id) values ($1, \'steward\', \'mi1-a\')"',
    );
    expect(verifier).toContain(
      '"insert into public.member_role_chapters (user_id, role, chapter_id) values ($1, \'steward\', \'mi1-a\')"',
    );
    expect(verifier).not.toMatch(/client\.query\(`[^`]*;[^`]*`,\s*\[/s);
  });
});
