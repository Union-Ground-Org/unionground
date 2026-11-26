// @vitest-environment node
//
// REQ-UG-CHAPTER-UNITS-WORKSITES-AND-LOCAL-PROFILE-20261030 (#6562):
// what the migration says. The live behaviour (who may read and write which
// organization's units and profile) is exercised by the database proof job.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TERM_LABEL_KEYS } from "../src/lib/LanguageContext.jsx";

const FILE = "20261030201200_chapter_units_and_local_profile.sql";
const sql = readFileSync(`supabase/migrations/${FILE}`, "utf8");

function body(signature) {
  const start = sql.indexOf(`create function ${signature}`) >= 0
    ? sql.indexOf(`create function ${signature}`)
    : sql.indexOf(`create or replace function ${signature}`);
  expect(start, signature).toBeGreaterThanOrEqual(0);
  return sql.slice(start, sql.indexOf("$function$;", start));
}

describe("chapter units and local profile migration", () => {
  it("keeps the three tables private, without grants, under forced RLS and the case-graph triggers", () => {
    for (const table of ["chapter_units", "organization_local_profiles", "member_invitation_units"]) {
      expect(sql).toContain(`create table private.${table} (`);
      expect(sql).toContain(`alter table private.${table} force row level security;`);
      expect(sql).toContain(`revoke all on table private.${table} from public, anon, authenticated, service_role;`);
      expect(sql).toContain(`create policy mfa_assurance on private.${table} as restrictive for all to authenticated`);
      expect(sql).toContain(`create trigger a00_case_graph_lock before insert or update or delete on private.${table}`);
      expect(sql).not.toMatch(new RegExp(`grant [a-z, ]+ on (table )?private\\.${table}`));
    }
    // A unit belongs to one chapter; no user column, so no account-lifecycle row.
    expect(body("private.chapter_unit_rows")).toContain("where u.organization_id = p_organization_id");
    expect(sql).toContain("chapter_id text not null references public.chapters(id)");
    expect(sql).not.toMatch(/references auth\.users/);
  });

  it("checks two-step sign-in and the selected organization in every public function", () => {
    for (const fn of ["public.list_chapter_units()", "public.save_chapter_unit(", "public.delete_chapter_unit(",
      "public.get_organization_local_profile()", "public.save_organization_local_profile(", "public.set_member_invitation_unit("]) {
      const text = body(fn);
      expect(text, fn).toContain("security definer");
      expect(text, fn).toContain("set search_path = ''");
      expect(text, fn).toContain("not private.mfa_satisfied()");
    }
    expect(body("private.chapter_units_context()")).toContain("private.current_member_organization()");
    expect(body("private.chapter_unit_manageable(")).toMatch(/c\.organization_id = private\.chapter_units_context\(\)[\s\S]*has_organization_role\(private\.chapter_units_context\(\), array\['admin'\]\)[\s\S]*member_has_chapter_role\(p_chapter_id, array\['admin'\]\)/);
    expect(body("public.save_organization_local_profile(")).toContain("not private.has_organization_role(org, array['admin'])");
  });

  it("takes the case-graph lock before anything else in every writer", () => {
    for (const fn of ["public.save_chapter_unit(", "public.delete_chapter_unit(", "public.save_organization_local_profile(",
      "public.set_member_invitation_unit(", "private.apply_member_invitation_unit()"]) {
      expect(body(fn), fn).toMatch(/as \$function\$\nbegin\n {2}perform private\.lock_case_graph\(/);
    }
  });

  it("names a unit only on the inviter's own pending invitation, inside its chapter", () => {
    const text = body("public.set_member_invitation_unit(");
    expect(text).toContain("i.invited_by = (select auth.uid()) and i.status = 'pending'");
    expect(text).toContain("private.member_invitation_chapter_administrable(invitation.chapter_id)");
    expect(text).toContain("u.chapter_id = invitation.chapter_id");
    const trigger = body("private.apply_member_invitation_unit()");
    expect(trigger).toContain("where d.worksite is null");
    expect(trigger).toContain("u.chapter_id = new.chapter_id");
    expect(sql).toMatch(/create trigger z60_invitation_unit_on_accept\s+after update of status on public\.member_invitations[\s\S]*when \(new\.status = 'accepted' and old\.status is distinct from 'accepted'\)/);
    expect(sql).toContain("account_lifecycle_referential_action_trigger_issues()");
    // Every trigger the migration creates is reviewed before the assertion runs.
    expect(sql).toMatch(/s\.table_name in \('chapter_units', 'organization_local_profiles', 'member_invitation_units'\)\s+and s\.object_name in \('a00_case_graph_lock', 'z99_case_graph_keys'\)/);
  });

  // The invitation rule stays as 20261004010000 defined it (an admin of a
  // chapter they belong to); tests/invitation-target-chapter-admin-db.test.js,
  // org-admin-reinvite-former-member-db and member-chapter-display-titles-db
  // pin it live. Units only add where an invitation lands.
  it("leaves who may invite where unchanged", () => {
    expect(sql).not.toMatch(/function private\.member_invitation_chapter_administrable/);
    expect(body("public.set_member_invitation_unit(")).toContain("private.member_invitation_chapter_administrable(invitation.chapter_id)");
  });

  it("counts units and worksites inside chapters toward the org-start guide's worksite check", () => {
    const text = body("private.organization_start_milestones(");
    expect(text).toContain("private.organization_setting_text_list(org, 'lists.organizing.worksites')");
    expect(text).toContain("from private.chapter_units u where u.organization_id = org");
    expect(text).toContain("pg_catalog.jsonb_build_object('id', 'worksites', 'done', worksites_n > 0");
    expect(sql).toContain("revoke all on function private.organization_start_milestones(uuid) from public, anon, authenticated, service_role;");
  });

  it("allows exactly the client's term keys in the label table and its writer", () => {
    const keys = TERM_LABEL_KEYS.map((key) => `'${key}'`).join(", ");
    expect(sql.match(new RegExp(keys.replaceAll(".", "\\."), "g"))).toHaveLength(2);
    const label = body("public.update_organization_label(");
    expect(label).toContain("p_key like 'term.%'");
    // The base migrations' case-graph entry gate stays ahead of the organization read.
    expect(label).toMatch(/as \$function\$\nbegin\n(?: {2}--[^\n]*\n)* {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\ndeclare\n {2}org_id uuid := private\.current_member_organization\(\);/);
  });
});
