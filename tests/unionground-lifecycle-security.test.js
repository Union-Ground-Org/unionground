import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrations = join(root, "supabase", "migrations");
const sql = readFileSync(join(migrations, "20261014001000_unionground_union_lifecycle.sql"), "utf8");
const ugMigration = (name) => readFileSync(join(migrations, name), "utf8");

function body(start, end) {
  return sql.slice(sql.indexOf(start), end ? sql.indexOf(end, sql.indexOf(start)) : sql.length);
}

const lifecycleTables = [
  "union_employers",
  "union_worksites",
  "organizing_campaigns",
  "organizing_campaign_assignments",
  "organizing_stage_events",
  "organizing_work_areas",
  "organizing_workers",
  "organizing_contact_events",
  "organizing_resistance_incidents",
  "organizing_resistance_evidence",
  "organizing_bargaining_cycles",
  "organizing_bargaining_proposals",
  "organizing_bargaining_sessions",
  "member_membership_periods",
  "member_onboarding_steps",
  "member_participation_events",
  "coalition_partners",
  "coalition_handshakes",
  "coalition_commitments",
  "union_lifecycle_audit_events",
];

describe("Union Ground lifecycle security", () => {
  it("enables RLS on every lifecycle table and exposes no browser DML", () => {
    for (const table of lifecycleTables) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toContain(`public.${table}`);
      expect(sql).not.toMatch(new RegExp(`grant\\s+[^;]*(insert|update|delete)[^;]*on(?:\\s+table)?\\s+public\\.${table}[^;]*to\\s+(anon|authenticated)`, "i"));
      expect(sql).toMatch(new RegExp(`'public\\.${table}'::regclass`, "i"));
    }
    expect(sql).toContain("revoke all on table");
    expect(sql).toContain("from public, anon, authenticated");
  });

  it("leaves Union Ground's chapter-to-chapter handshakes alone", () => {
    // public.chapter_handshakes is Union Ground's data-sharing agreement; the
    // coalition-partner handshake is a different object with its own name.
    const code = sql.replace(/^\s*--.*$/gm, "");
    expect(code).not.toMatch(/\bchapter_handshakes\b/);
    expect(sql).toContain("create table public.coalition_handshakes (");
    expect(sql).toContain("coalition_handshakes_partner_scope_fkey");
    expect(sql).toContain("handshake_id uuid not null references public.coalition_handshakes(id) on delete cascade");
  });

  it("keeps member lifecycle reads own-row only", () => {
    for (const table of ["member_membership_periods", "member_onboarding_steps", "member_participation_events"]) {
      expect(sql).toMatch(new RegExp(`create policy ${table}_select_own[\\s\\S]*?auth\\.uid\\(\\)\\) = user_id`, "i"));
    }
  });

  it("reuses Union Ground's tenant-scoped staff RPCs instead of redefining them", () => {
    const code = sql.replace(/^\s*--.*$/gm, "");
    for (const fn of [
      "grant_member_role",
      "revoke_member_role",
      "admin_search_members",
      "get_staff_roster",
      "get_admin_audit",
      "authorize_mfa_reset",
      "record_mfa_reset",
    ]) {
      expect(code).not.toMatch(new RegExp(`function\\s+public\\.${fn}\\b`));
    }
    // No structural rewrite of Union Ground's identity or audit tables.
    expect(code).not.toMatch(/alter table public\.member_profiles/);
    expect(code).not.toMatch(/alter table public\.member_admin_audit/);
    expect(code).not.toMatch(/member_profiles\(id, chapter_id\)/);
    expect(code).not.toMatch(/function private\.handle_new_member/);
    // The retired chapter-role RPCs stay retired upstream.
    const retired = ugMigration("20260917050000_retire_superseded_role_grant_rpcs.sql");
    expect(retired).toContain("drop function public.grant_member_role(uuid, text, text);");
    expect(retired).toContain("drop function public.revoke_member_role(uuid, text);");
  });

  it("scopes role grants to the target's active chapter membership and rechecks after lock waits", () => {
    // set_member_chapter_role is the role writer Union
    // Ground relies on; pin the properties the July grant/revoke bodies had.
    const foundation = ugMigration("20260822010000_mi1_organization_scope_foundation.sql");
    const writer = foundation.slice(
      foundation.indexOf("create or replace function public.set_member_chapter_role("),
      foundation.indexOf("$function$;", foundation.indexOf("create or replace function public.set_member_chapter_role(")),
    );
    expect(writer).toContain("pg_advisory_xact_lock");
    expect(writer).toContain("All authoritative authorization and target-membership checks occur after");
    expect(writer.indexOf("org_admin := private.has_organization_role(target_org, array['admin']);", writer.indexOf("pg_advisory_xact_lock")))
      .toBeGreaterThan(writer.indexOf("pg_advisory_xact_lock"));
    expect(writer).toContain("active chapter membership required");
    expect(writer).toContain("chapter outside admin scope");
    expect(writer).toContain("using errcode = '42501'");
    expect(writer).toContain("insert into public.member_admin_audit");
  });

  it("adds the Organizer hat to Union Ground's chapter role model additively", () => {
    for (const table of ["member_roles", "member_role_chapters"]) {
      expect(sql).toContain(`alter table public.${table} drop constraint ${table}_role_check;`);
      expect(sql).toContain(
        `add constraint ${table}_role_check\n  check (role in ('steward', 'organizer', 'coordinator', 'advisor', 'admin', 'vp'));`,
      );
    }
    expect(sql).toContain("'public.set_member_chapter_role(uuid, text, text, boolean)'::regprocedure");
    expect(sql).toContain("p_role not in (''steward'', ''organizer'', ''coordinator'', ''advisor'', ''admin'', ''vp'')");
    expect(sql).toContain("set_member_chapter_role role list changed upstream");
    expect(sql).not.toMatch(/organization_role_grants_role_check/);
  });

  it("allows campaign writes only to chapter coordinators or assigned organizers", () => {
    const permission = body("create function private.lifecycle_can_operate_campaign", "-- 9. Bounded campaign write RPCs");
    expect(permission).toContain("r.role = 'coordinator'");
    expect(permission).toContain("a.assignment_role in ('lead_organizer', 'organizer')");
    expect(permission).toContain("a.status = 'active'");
    expect(permission).toContain("private.mfa_satisfied()");
    // Authority is Union Ground's chapter grant, held only with an active
    // membership and Union Ground's own role predicate in agreement.
    expect(permission).not.toContain("public.member_roles");
    expect(permission.match(/from public\.member_role_chapters r|join public\.member_role_chapters r/g)).toHaveLength(2);
    expect(permission.match(/m\.status = 'active'/g)).toHaveLength(1);
    const scope = body("create function private.lifecycle_scope_chapter", "create function private.lifecycle_can_operate_campaign");
    expect(scope).toContain("select 1 from public.member_role_chapters r");
    expect(scope).toContain("r.chapter_id = p.chapter_id");
    expect(scope).toContain("and m.status = 'active'");
    expect(scope).toContain("private.member_has_chapter_role(p.chapter_id, p_roles)");
    expect(scope).toContain("private.mfa_satisfied()");
    expect(permission).toContain("private.member_has_chapter_role(c.chapter_id, array['coordinator'])");
    expect(permission).toContain("private.member_has_chapter_role(c.chapter_id, array['organizer'])");
    const code = sql.replace(/^\s*--.*$/gm, "");
    expect(code).not.toMatch(/public\.member_roles r\b/);
  });

  it("pins optimistic concurrency, explicit transitions, and transactional audit", () => {
    const transition = body("create function public.transition_organizing_campaign", "create function public.record_resistance_incident");
    expect(sql).toMatch(
      /check \(stage in \('lead', 'committee', 'cards', 'petition', 'election', 'recognition', 'certification', 'bargaining', 'first_contract', 'established'\)\)/,
    );
    expect(transition).toContain("for update");
    expect(transition).toContain("p_expected_revision is null");
    expect(transition).toContain("p_expected_revision <= 0");
    expect(transition).toContain("invalid campaign transition");
    expect(transition).toContain("bargaining cycle required");
    expect(transition).toContain("ratification milestone required");
    expect(transition).toContain("signed first contract required");
    expect(transition).toContain("first_contract_signed_on is not null");
    expect(transition).toContain("campaign.stage_changed");
    expect(transition).toContain("union_lifecycle_audit_events");
  });

  it("keeps audit immutable and chapter-bound", () => {
    expect(sql).toContain("union_lifecycle_audit_campaign_scope_fkey");
    expect(sql).toMatch(/references public\.organizing_campaigns\(id, chapter_id\)\s+on delete restrict/i);
    expect(sql).toContain("union_lifecycle_audit_append_only");
    expect(sql).toContain("lifecycle audit is append-only");
  });

  it("suppresses parent aggregates when child totals expose a small residual", () => {
    const workspace = body("create function public.get_union_lifecycle_workspace", "-- 14. Explicit ACLs");
    expect(workspace).toContain(
      "coalesce(pg_catalog.sum(a.eligible_estimate), 0)::integer as work_area_eligible_count",
    );
    expect(workspace.match(/c\.eligible_estimate - coverage\.work_area_eligible_count = 0/g)).toHaveLength(3);
    expect(workspace.match(/c\.eligible_estimate - coverage\.work_area_eligible_count >= 5/g)).toHaveLength(3);
  });

  it("redacts record-level projections for aggregate-only roles", () => {
    const workspace = body(
      "create function public.get_union_lifecycle_workspace",
      "-- 11. Clean new-member bootstrap",
    );
    expect(workspace).toContain("if aggregate_view then");
    for (const key of ["campaigns", "worksites", "workAreas", "resistanceEvents", "bargaining", "coalitions"]) {
      expect(workspace).toContain(`'${key}', '[]'::jsonb`);
    }
    expect(workspace).toContain("return workspace");
  });

  it("does not present absent historical backfill as a measured zero", () => {
    const workspace = body(
      "create function public.get_union_lifecycle_workspace",
      "-- 11. Clean new-member bootstrap",
    );
    expect(workspace).toContain(
      "'memberCount', case when member_total >= 25 then member_total else null end",
    );
    expect(workspace).toContain(
      "'joined', case when y.joined >= 25 then y.joined else null end",
    );
    expect(workspace).toContain(
      "'left', case when y.left_count >= 25 then y.left_count else null end",
    );
  });

  it("validates shared employer input against the tightest destination column", () => {
    const create = body(
      "create function public.create_organizing_campaign",
      "create function public.transition_organizing_campaign",
    );
    expect(create).toContain("not between 2 and 120");
    expect(create).not.toContain("not between 2 and 180");
  });

  it("makes campaign creation idempotent before creating employer or worksite rows", () => {
    const create = body(
      "create function public.create_organizing_campaign",
      "create function public.transition_organizing_campaign",
    );
    expect(sql).toContain("create_request_id uuid not null");
    expect(sql).toContain("unique (created_by, chapter_id, create_request_id)");
    expect(sql).toContain("eligible_estimate between 0 and 10000000");
    expect(create).toContain("p_request_id uuid");
    expect(create).toContain("pg_advisory_xact_lock");
    expect(create).toContain("for share of p, r");
    expect(create).toContain("where c.created_by = caller");
    expect(create).toContain("and c.chapter_id = scope_chapter");
    expect(create).toContain("and c.create_request_id = p_request_id");
    expect(create).toContain("request id already used for a different campaign");
    expect(create.indexOf("if found then")).toBeLessThan(
      create.indexOf("insert into public.union_employers"),
    );
    expect(create).toContain("'changed', false");
    expect(sql).toContain(
      "public.create_organizing_campaign(text, text, text, text, uuid, text, integer)",
    );
  });

  it("returns explicit campaign creation and operation capabilities", () => {
    const workspace = body(
      "create function public.get_union_lifecycle_workspace",
      "-- 11. Clean new-member bootstrap",
    );
    expect(workspace).toContain("'canCreateCampaign'");
    expect(workspace).toContain("'canOperate', private.lifecycle_can_operate_campaign(c.id)");
  });

  it("boots new accounts from verified chapter binding without fabricated history", () => {
    const signup = body("create function private.unionground_start_member_lifecycle", "-- 12. RLS, grants");
    // The chapter is the one Union Ground's handle_new_member bound through a
    // matching invitation, read back from stored rows, never from metadata.
    expect(signup).toContain("from public.member_profiles p");
    expect(signup).toContain("join public.member_chapter_memberships m");
    expect(signup).toContain("and m.status = 'active'");
    expect(signup).not.toContain("raw_user_meta_data");
    expect(signup).toContain("'pending', 'portal_signup'");
    expect(signup).not.toContain("member_cases");
    expect(signup).not.toContain("member_messages");
    expect(signup).not.toContain("member_action_log");
    expect(signup).toContain("member_notifications (user_id, title, body, kind)");
    expect(signup).toContain("'general'");
    expect(signup).toContain("security definer");
    expect(signup).toContain("set search_path = ''");
    expect(signup).toContain(
      "create trigger on_auth_user_created_unionground_lifecycle\n  after insert on auth.users",
    );
    // Same event, later name: runs after Union Ground's profile bootstrap.
    expect("on_auth_user_created_unionground_lifecycle" > "on_auth_user_created_member_app").toBe(true);
    expect(sql).toContain(
      "revoke all on function private.unionground_start_member_lifecycle() from public, anon, authenticated;",
    );
    const bootstrap = ugMigration("20260925965000_member_recovery_and_chapter_grant_tenant_check.sql");
    expect(bootstrap).toContain("i.status = 'accepting'");
    expect(bootstrap).toContain("i.normalized_email = pg_catalog.lower(new.email)");
  });

  it("keeps all caller-invocable definer paths behind MFA", () => {
    for (const fn of [
      "create_organizing_campaign",
      "transition_organizing_campaign",
      "set_organizing_campaign_status",
      "record_resistance_incident",
      "get_union_lifecycle_workspace",
    ]) {
      const fnBody = body(`function public.${fn}`, "$$;");
      expect(fnBody).toMatch(/private\.mfa_satisfied\(\)|private\.lifecycle_scope_chapter\(|private\.lifecycle_can_operate_campaign\(/);
    }
    expect(body("function private.lifecycle_scope_chapter", "$$;")).toContain("private.mfa_satisfied()");
    expect(body("function private.lifecycle_can_operate_campaign", "$$;")).toContain("private.mfa_satisfied()");
    expect(sql.match(/create policy mfa_assurance on %s as restrictive/g)).toHaveLength(1);
  });

  it("keeps definer RPCs on an empty search path with explicit ACLs", () => {
    for (const fn of ["create_organizing_campaign", "transition_organizing_campaign", "set_organizing_campaign_status", "record_resistance_incident", "get_union_lifecycle_workspace"]) {
      const fnBody = body(`function public.${fn}`, "$$;");
      expect(fnBody).toContain("set search_path = ''");
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\(`, "i"));
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\(`, "i"));
    }
  });
});
