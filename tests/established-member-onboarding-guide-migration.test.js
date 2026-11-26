// @vitest-environment node
// BUG-UG-ESTABLISHED-MEMBER-BADGED-NEW-MEMBER-20261106 (#7279): a
// member since 2020 with no onboarding plan was badged New Member with 0 of 7
// steps, a guide card on every page and the trimmed menu. The guide now leaves
// out a member who joined before the program was switched on and has not
// chosen the guide. The live behaviour is in tests/member-onboarding-guide-db.test.js.
import { describe, expect, it } from "vitest";
import { fnBody, latestFnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261107192600_established_member_not_onboarding_guide";
const SIGNATURE = "public.get_member_onboarding_guide()";
const NUDGES = "public.get_member_home_nudges()";
const CHOSE = "p.assigned_by is not null or p.status <> 'not_started' or exists (select 1 from public.member_support_events e where e.organization_id = org and e.entity_type = 'onboarding_plan' and e.entity_id = p.id and e.event_type = 'started')";

const raw = loadMigrationSql(MIGRATION);
const sql = stripComments(raw);
const body = fnBody(sql, SIGNATURE);
const previous = fnBody(stripComments(loadMigrationSql("20261002120000_member_onboarding_guide")), SIGNATURE);
const nudges = fnBody(sql, NUDGES);
const previousNudges = fnBody(stripComments(loadMigrationSql("20261002134000_member_home_nudges")), NUDGES);
const squash = (text) => text.replace(/\s+/g, " ");

describe("established members are not onboarding-guide members", () => {
  it("is the live definition of the guide read", () => {
    expect(latestFnBody(SIGNATURE)).toBe(body);
  });

  it("keeps the function's boundaries: definer, empty search_path, session organization, read-only, authenticated only", () => {
    expect(sql).toMatch(/create or replace function public\.get_member_onboarding_guide\(\)\s+returns jsonb\s+language plpgsql\s+stable\s+security definer\s+set search_path = ''/);
    expect(body).toContain("org := private.member_support_selected_organization();");
    expect(body).toContain("member_only := not private.member_support_is_staff(org);");
    expect(body).not.toMatch(/\b(insert|update|delete)\b/i);
    expect(sql).toContain("revoke all on function public.get_member_onboarding_guide() from public, anon, authenticated, service_role;");
    expect(sql).toContain("grant execute on function public.get_member_onboarding_guide() to authenticated;");
  });

  it("reads the program start from every step ever written, active or not, and the member's own membership and member-since year", () => {
    const flat = squash(body);
    // Turning a step off or on never moves the start (G6 r1s2/r2s2).
    expect(flat).toContain("select pg_catalog.min(s.created_at) into program_started_at from public.organization_onboarding_steps s where s.organization_id = org;");
    expect(flat).not.toMatch(/min\(s\.created_at\)[^;]*s\.active/);
    expect(flat).toContain("from public.organization_memberships m where m.organization_id = org and m.user_id = caller;");
    expect(flat).toContain("from public.member_profiles p where p.id = caller;");
    expect(flat).toContain("established := coalesce(membership_created_at < program_started_at, false) or coalesce(member_since_year < pg_catalog.date_part('year', program_started_at)::integer, false);");
  });

  it("counts a plan as the member's choice when they or staff assigned or started it, or it has progress", () => {
    const flat = squash(body);
    // An explicit start of an existing automatic plan records 'started' (G6 r1s3/r2s3).
    expect(flat).toContain(CHOSE);
    expect(flat).toContain("if program_configured and not chose_guide then");
  });

  it("turns the whole guide off for an established member and reports it", () => {
    expect(squash(body)).toContain("applies := member_only and program_configured and any_switch and not established;");
    expect(squash(previous)).toContain("applies := member_only and program_configured and any_switch;");
    expect(body).toContain("'establishedMember', established,");
    // Every guide surface still hangs off applies.
    for (const surface of [
      "'progressiveDisclosureActive', applies and progressive and not complete,",
      "'featureDrip', applies and feature_drip,",
      "'showHud', applies and (hud_tooltips or badges),",
      "when not (applies and spotlight) then null",
      "when not (applies and badges) then null",
    ]) expect(body).toContain(surface);
  });

  it("changes nothing else in the 20261002120000 definition", () => {
    const strip = (text) => squash(text)
      .replace("create or replace function", "create function")
      .replace(/ chose_guide boolean;| program_started_at timestamptz;| membership_created_at timestamptz;| member_since_year integer;| established boolean := false;/g, "")
      .replace(/ if program_configured and not chose_guide then .*? end if;/, "")
      .replace(`select p.status, p.completed_step_ids, ${CHOSE} into plan_status, plan_completed_ids, chose_guide`, "select p.status, p.completed_step_ids into plan_status, plan_completed_ids")
      .replace(" chose_guide := coalesce(chose_guide, false);", "")
      .replace(" and not established;", ";")
      .replace(" 'establishedMember', established,", "");
    expect(strip(body)).toBe(squash(previous));
  });

  // G6 r1s1/r2s1: the Home onboarding reminder follows the same rule.
  it("offers no Home onboarding reminder to the guide's established member and changes nothing else in the reminder", () => {
    expect(latestFnBody(NUDGES)).toBe(nudges);
    const flat = squash(nudges);
    expect(flat).toContain("established := coalesce((guide->>'establishedMember')::boolean, false);");
    expect(flat).toContain("if not established and private.organization_feature_enabled(org, 'features.home.onboarding_nudge') then");
    expect(flat.indexOf("established := coalesce")).toBeGreaterThan(flat.indexOf("if guided then"));
    expect(flat.indexOf("established := coalesce")).toBeLessThan(flat.indexOf("passkey_allowed :="));
    expect(sql).toContain("revoke all on function public.get_member_home_nudges() from public, anon, authenticated, service_role;");
    expect(sql).toContain("grant execute on function public.get_member_home_nudges() to authenticated;");
    const strip = (text) => squash(text)
      .replace("create or replace function", "create function")
      .replace(" established boolean;", "")
      .replace(" established := coalesce((guide->>'establishedMember')::boolean, false);", "")
      .replace("if not established and private.organization_feature_enabled", "if private.organization_feature_enabled");
    expect(strip(nudges)).toBe(squash(previousNudges));
  });
});
