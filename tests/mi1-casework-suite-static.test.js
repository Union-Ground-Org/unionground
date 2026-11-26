// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { forbiddenSupabaseRefsIn } from "../scripts/lib/sibling-deny-list.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION = "20260828210000_mi1_casework_suite.sql";
const sql = readFileSync(join(ROOT, "supabase", "migrations", MIGRATION), "utf8");

const CASEWORK_TABLES = [
  "casework_access_grants",
  "casework_strength_analyses",
  "casework_bargaining_workspaces",
  "casework_bargaining_proposals",
  "casework_bargaining_events",
  "casework_deadlines",
  "casework_deadline_extensions",
  "casework_checklist_templates",
  "casework_checklists",
  "casework_checklist_items",
  "casework_step_transitions",
  "casework_alerts",
  "casework_alert_acknowledgements",
  "casework_management_people",
  "casework_management_entries",
  "casework_management_addenda",
  "casework_retaliation_reports",
  "casework_retaliation_patterns",
  "casework_retaliation_pattern_reports",
  "casework_retaliation_pattern_notes",
  "casework_intake_drafts",
  "casework_entity_links",
  "casework_reminders",
  "casework_audit_events",
];

describe("MI1 casework suite persistence", () => {
  it("uses one centrally named additive migration", () => {
    const matches = readdirSync(join(ROOT, "supabase", "migrations"))
      .filter((name) => name.includes("mi1_casework_suite"));
    expect(matches).toEqual([MIGRATION]);
    expect(sql).toContain("set local lock_timeout = '5s'");
  });

  it("implements the complete CR-020 through CR-034 persistence family", () => {
    for (const table of CASEWORK_TABLES) {
      expect(sql).toContain(`create table public.${table}`);
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toContain(`'${table}'`);
    }
    expect(sql).toContain("create policy mfa_assurance on public.%I as restrictive for all to authenticated");
    expect(sql).toContain("revoke all on table public.%I from public, anon, authenticated");
    expect(sql).not.toMatch(/grant [^;]* on sequence public\.casework_/i);
    for (const rpc of [
      "casework_score_case",
      "casework_request_deadline_extension",
      "casework_decide_deadline_extension",
      "casework_advance_step",
      "casework_acknowledge_alert",
      "casework_set_restriction",
      "casework_save_intake_draft",
      "casework_submit_retaliation_report",
      "casework_withdraw_retaliation_report",
      "casework_bulk_update_cases",
      "casework_create_checklist_template",
      "casework_set_checklist_item",
      "casework_grant_access",
      "casework_revoke_access",
      "casework_create_bargaining_workspace",
      "casework_add_bargaining_proposal",
      "casework_transition_bargaining_proposal",
      "casework_add_bargaining_event",
      "casework_set_bargaining_status",
      "casework_log_management_behavior",
      "casework_add_management_addendum",
      "casework_link_cases",
      "casework_set_reminder_status",
      "casework_scan_retaliation_patterns",
      "casework_review_retaliation_pattern",
    ]) {
      expect(sql).toContain(`function public.${rpc}(`);
      expect(sql).toMatch(new RegExp(`function public\\.${rpc}\\([\\s\\S]*?security definer set search_path = ''`, "i"));
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${rpc}\\(`, "i"));
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${rpc}\\(`, "i"));
      const start = sql.indexOf(`function public.${rpc}(`);
      const bodyStart = sql.indexOf("$function$", start) + "$function$".length;
      const bodyEnd = sql.indexOf("$function$;", bodyStart);
      expect(sql.slice(bodyStart, bodyEnd), `${rpc} must pass through the shared MFA gate`)
        .toContain("perform private.casework_require_mfa();");
    }
  });

  it("runs overdue alert escalation inside Postgres without external credentials", () => {
    expect(sql).toContain("function private.casework_escalate_due_alerts(");
    expect(sql).toContain("casework-alert-escalation-tick");
    expect(sql).toContain("status = 'escalated'");
    expect(sql).toContain("'alert_escalated'");
    expect(sql).toMatch(/revoke all on function private\.casework_escalate_due_alerts\(integer\) from public, anon, authenticated/i);
  });

  it("binds every case child to the server-stamped organization and chapter", () => {
    expect(sql).toContain("member_cases_casework_scope_key unique (id, organization_id, chapter_id)");
    expect(sql.match(/foreign key \(case_id, organization_id, chapter_id\)/g)?.length).toBeGreaterThanOrEqual(10);
    expect(sql).toContain("private.casework_scope_matches(case_id, organization_id, chapter_id)");
    expect(sql).not.toMatch(/branch_id\s+is\s+null/i);
    expect(sql).not.toMatch(/function public\.casework_[^(]+\([^)]*p_organization_id/i);
    for (const qualifiedOuter of [
      "casework_access_grants.organization_id",
      "casework_bargaining_proposals.organization_id",
      "casework_bargaining_events.organization_id",
      "casework_deadline_extensions.organization_id",
      "casework_checklist_items.organization_id",
      "casework_alert_acknowledgements.organization_id",
      "casework_management_addenda.organization_id",
      "casework_retaliation_pattern_reports.organization_id",
      "casework_retaliation_pattern_notes.organization_id",
    ]) expect(sql).toContain(qualifiedOuter);
    expect(sql).toContain("foreign key (workspace_id, organization_id)");
    expect(sql).toContain("foreign key (deadline_id, organization_id)");
    expect(sql).toContain("foreign key (checklist_id, organization_id)");
    expect(sql).toContain("foreign key (alert_id, organization_id)");
    expect(sql).toContain("foreign key (pattern_id, organization_id)");
  });

  it("keeps restricted cases participant-aware and cross-organization fail closed", () => {
    const helper = sql.slice(
      sql.indexOf("create or replace function private.casework_staff_can_access"),
      sql.indexOf("create or replace function private.casework_can_read"),
    );
    expect(helper).toContain("private.actor_has_chapter_staff_role");
    expect(helper).toContain("c.steward_user_id = (select auth.uid())");
    expect(helper).toContain("c.coordinator_user_id = (select auth.uid())");
    expect(helper).toContain("casework_access_grants");
    expect(helper).toContain("private.has_organization_role(c.organization_id");
    expect(helper).not.toMatch(/role\s*=\s*'steward'\s*\)/);
  });

  it("preserves immutable evidence and atomic transitions", () => {
    expect(sql).toContain("Immutable evidence tables have no UPDATE/DELETE policy or grant");
    expect(sql).not.toMatch(/grant [^;]*update[^;]*casework_strength_analyses/i);
    expect(sql).not.toMatch(/grant [^;]*update[^;]*casework_deadline_extensions/i);
    expect(sql).not.toMatch(/grant [^;]*update[^;]*casework_step_transitions/i);
    expect(sql).not.toMatch(/grant [^;]*update[^;]*casework_management_entries/i);
    expect(sql).not.toMatch(/grant [^;]*update[^;]*casework_management_addenda/i);
    expect(sql).not.toMatch(/grant [^;]*update[^;]*casework_audit_events/i);
    expect(sql).not.toMatch(/delete\s+from\s+public\.casework_deadline_extensions/i);
    expect(sql).toContain("where id = p_case_id for update");
    expect(sql).toContain("case step changed");
    expect(sql).toContain("select 1 to 100 cases");
  });

  it("does not import blocked donor architecture, credentials, or data", () => {
    expect(sql).toContain("Donor SHA donor-baseline-20260721 is behavior-only");
    expect(sql).not.toMatch(/service_role/i);
    expect(sql).not.toMatch(/supabase_url|supabase_key|project_ref/i);
    expect(forbiddenSupabaseRefsIn(sql)).toEqual([]);
    expect(sql).not.toMatch(/insert\s+into\s+public\.(organizations|chapters|member_profiles)/i);
    expect(sql).not.toMatch(/seiu|local 509/i);
    expect(sql).not.toMatch(/revoke all on all tables in schema public/i);
  });

  // BUG-UG-CASEWORK-PANELS-RAW-DRIVER-ERROR-TEXT-20260920: these four
  // panels route every failure notice through rpcErrorTextStrict, so a
  // refused write can only ever show translated catalogue copy. A direct
  // error.message / cause.message render would leak raw database policy,
  // table, or constraint text to the member.
  it("never renders raw driver error text into casework panel notices", () => {
    for (const file of [
      "CaseworkOperationsPanel.jsx",
      "CaseworkHubPanel.jsx",
      "ChapterAppointmentsPanel.jsx",
      "CaseMacroEditor.jsx",
    ]) {
      const source = readFileSync(join(ROOT, "src", "components", file), "utf8");
      expect(source, file).not.toMatch(/\b(error|cause)\??\.message/);
    }
  });
});
