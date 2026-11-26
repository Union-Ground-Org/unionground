// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, latestFnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const originalSql = loadMigrationSql("20260812230000_admin_command_center.sql");
const originalLive = stripComments(originalSql).toLowerCase();
const liveBody = (name) => stripComments(latestFnBody(name)).toLowerCase();

describe("UB-DESK-03 admin command center migration", () => {
  it("resolves live bodies from the last defining migration", () => {
    // latestFnBody cuts from executable text, so the expectation is the
    // comment-stripped declaration, not the raw file slice.
    const definedIn = (file, name) => fnBody(stripComments(loadMigrationSql(file)), name);
    // Union Ground D2 (2026-10-15) re-emits the single-pass structure with
    // an Organizer role count; nothing else in the body changes.
    const live = latestFnBody("get_admin_org_structure");
    expect(live).toBe(
      definedIn("20261015110000_unionground_staff_roster_organizer.sql", "get_admin_org_structure"),
    );
    const withoutOrganizer = live.split("\n").filter((line) => !line.includes("organizer")).join("\n");
    expect(withoutOrganizer).toBe(
      definedIn("20260918070000_admin_org_structure_single_pass.sql", "get_admin_org_structure"),
    );
    // REQ-UG-SCOPED-ROLES-AND-OFFICER-ACCESS-20261030 (#6560)
    // re-emitted it so the creator joins the chapter it creates.
    expect(latestFnBody("create_admin_chapter")).toBe(
      definedIn("20261031103908_chapter_creator_membership.sql", "create_admin_chapter"),
    );
    // BUG-UG-INVITE-STARTING-ACCESS-NO-OFFICER-TITLES-20261003 re-emitted
    // the directory with the located membership's display title, and
    // REQ-UG-PROFILE-WORKPLACE-JOB-PHONE-AND-PRONOUNS-20261006 with the
    // profile details a member shared with administrators;
    // REQ-UG-OFFICER-MEMBER-ROSTER-AND-EXPORT-20261030 admits chapter
    // Presidents and Secretary-Treasurers through their office.
    expect(latestFnBody("get_admin_member_directory")).toBe(
      definedIn("20261031020000_officer_member_directory_and_export.sql", "get_admin_member_directory"),
    );
  });

  it("asserts retired role-grant RPCs are absent from the final catalogue", () => {
    expect(() => latestFnBody("grant_member_role")).toThrow(
      /dropped without recreation in 20260917050000_retire_superseded_role_grant_rpcs\.sql/,
    );
    expect(() => latestFnBody("revoke_member_role")).toThrow(
      /dropped without recreation in 20260917050000_retire_superseded_role_grant_rpcs\.sql/,
    );
  });

  it("adds only role-gated, search-path-pinned RPC surfaces", () => {
    const signatures = [
      ["get_admin_member_directory", "text, text, uuid, integer"],
      ["get_admin_org_structure", ""],
      ["create_admin_chapter", "text, text, text, integer"],
      ["update_admin_chapter", "text, text, text, integer"],
    ];
    for (const [name, args] of signatures) {
      const body = liveBody(name);
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = ''");
      expect(body).toContain("errcode = '42501'");
      expect(body).toMatch(/has_organization_role|member_has_chapter_role/);
      expect(originalLive).toContain(`revoke all on function public.${name}(${args}) from public, anon, authenticated`);
      expect(originalLive).toContain(`grant execute on function public.${name}(${args}) to authenticated`);
    }
  });

  it("returns a name-optional, privacy-minimal keyset member directory", () => {
    const body = liveBody("get_admin_member_directory");
    expect(body).toContain("p_after_name is null and p_after_id is not null");
    expect(body).toContain("(p.full_name, p.id) > (p_after_name, p_after_id)");
    expect(body).toContain("limit cap + 1");
    expect(body).toContain("om.organization_id = caller_org");
    expect(body).toContain("c.organization_id = caller_org");
    expect(body).toContain("org_admin or c.id = caller_chapter");
    expect(body).toContain("'nextcursor'");
    expect(body).toContain("'chapterid'");
    expect(body).toContain("'membersince'");
    expect(body).toContain("p.member_since::integer as member_since_year");
    expect(body).toContain("'membersince', s.member_since_year");
    expect(body).not.toContain("'membersince', s.member_since,");
    // Privacy-minimal: no email or address, no case, form or message data. A
    // phone appears only when the member chose to show it to administrators
    // (member_profile_details.phone_visibility = 'admins'): the conditional read
    // and its output key are the only two places the body names a phone.
    expect(body).not.toMatch(/\b(email|address)\b|member_(cases|forms|messages)/);
    expect(body.match(/\bphone\b/g)).toEqual(["phone", "phone"]);
    expect(body).toContain("'phone', s.shared_phone");
    expect(body).toContain("case when d.phone_visibility = 'admins' then d.phone end as shared_phone");
    expect(body).toContain("left join public.member_profile_details d on d.user_id = p.id");
    for (const field of ["pronouns", "job_title", "worksite"]) {
      expect(body).toContain(`case when d.details_visibility = 'admins' then d.${field} end as shared_${field}`);
    }
  });

  it("derives organization counts from current chapter, profile, and role rows", () => {
    const body = liveBody("get_admin_org_structure");
    expect(body).toContain("or not (org_admin or private.member_has_chapter_role(caller_chapter, array['admin']))");
    expect(body).toContain("private.has_organization_role(caller_org, array['admin'])");
    expect(body).toContain("c.organization_id = caller_org");
    expect(body).toContain("org_admin or c.id = caller_chapter");
    expect(body).toContain("from public.chapters c");
    expect(body).toContain("from public.member_chapter_memberships cm");
    expect(body).toContain("join public.organization_memberships om");
    expect(body).toContain("'membercount'");
    expect(body).toContain("'staffcount'");
    expect(body).toContain("'rolecounts'");
    for (const role of ["steward", "coordinator", "advisor", "admin", "vp"]) {
      expect(body).toContain(`'${role}'`);
      expect(body).toContain(`mr.role = '${role}'`);
    }
    expect(body).toContain("'cancreatechapter', org_admin");
  });

  it("allows org-wide create and scope-matching update without delete/default transfer", () => {
    const create = liveBody("create_admin_chapter");
    const update = liveBody("update_admin_chapter");
    expect(create).toContain("not private.has_organization_role(org_id, array['admin'])");
    expect(create).toContain("insert into public.chapters");
    expect(create).toContain("false");
    expect(create).toContain("pg_advisory_xact_lock");
    expect(create).toContain("'create_chapter'");
    expect(update).toContain("where c.id = p_chapter_id and c.organization_id = org_id");
    expect(update).toContain("org_admin or (c.id = private.current_member_chapter()");
    expect(update.indexOf("c.organization_id = org_id")).toBeLessThan(update.indexOf("for update"));
    expect(update).toContain("clean_region is distinct from chapter_row.region");
    expect(update).toContain("clean_order is distinct from chapter_row.order_index");
    expect(update).toContain("organization admin required for chapter structure");
    expect(update).toContain("for update");
    expect(update).toContain("is distinct from");
    expect(update).toContain("'update_chapter'");
    expect(originalLive).not.toMatch(/create\s+(or\s+replace\s+)?function\s+public\.(delete|transfer_default)_admin_chapter/);
    expect(update).not.toMatch(/\bis_default\s*=/);
  });

  it("hardens legacy search, roster, and MFA status to admin scope", () => {
    const search = liveBody("admin_search_members");
    const roster = liveBody("get_staff_roster");
    const mfa = liveBody("get_admin_mfa_status");
    for (const body of [search, roster, mfa]) {
      expect(body).toContain("private.current_member_organization()");
      expect(body).toContain("c.organization_id = caller_org");
    }
    expect(search).toContain("org_admin or c.id = caller_chapter");
    // 20261124175100 (#9533): the organization-wide list is read only when the
    // caller holds it and did not ask for the open chapter alone.
    expect(roster).toContain("org_wide_view boolean := caller_org_wide and not coalesce(p_chapter_only, false)");
    expect(roster).toContain("org_wide_view or c.id = caller_chapter");
    expect(mfa).toContain("org_admin or c.id = caller_chapter");
  });

  it("holds the exact caller admin grant throughout every definer write", () => {
    const create = liveBody("create_admin_chapter");
    const update = liveBody("update_admin_chapter");
    expect(create).toContain("private.has_organization_role(org_id, array['admin'])");
    expect(create).toContain("private.has_organization_role(locked_org, array['admin'])");
    expect(create).toContain("admin role required");
    expect(update).toContain("private.has_organization_role(org_id, array['admin'])");
    expect(update).toContain("private.member_has_chapter_role(c.id, array['admin'])");
    expect(update).toContain("for update");
    expect(update).toContain("admin role required");
  });

  it("keeps chapter mutations audited with a closed vocabulary and no direct writes", () => {
    expect(originalLive).toContain("'create_chapter'");
    expect(originalLive).toContain("'update_chapter'");
    expect(originalLive).toContain("add constraint member_admin_audit_action_check");
    expect(originalLive).not.toMatch(/grant\s+(insert|update|delete|all)[^;]*on\s+(table\s+)?public\.chapters[^;]*to\s+(authenticated|anon)/);
    expect(originalLive).not.toMatch(/grant\s+(insert|update|delete|all)[^;]*on\s+(table\s+)?public\.member_roles[^;]*to\s+(authenticated|anon)/);
  });

  it("keeps original grant/revoke ACL text on the introducing migration", () => {
    expect(originalLive).toContain("revoke all on function public.grant_member_role(uuid, text, text) from public, anon");
    expect(originalLive).toContain("grant execute on function public.grant_member_role(uuid, text, text) to authenticated");
    expect(originalLive).toContain("revoke all on function public.revoke_member_role(uuid, text) from public, anon");
    expect(originalLive).toContain("grant execute on function public.revoke_member_role(uuid, text) to authenticated");
  });
});
