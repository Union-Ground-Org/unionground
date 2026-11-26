import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/20260812092000_intake_triage_conversion.sql");
const contract = JSON.parse(read("scripts/db-contract.json"));
const squash = (value) => value.replace(/\s+/g, " ");

describe("intake triage and conversion", () => {
  it("removes direct lifecycle writes and exposes only guarded RPCs", () => {
    expect(squash(migration)).toContain("revoke update (status, assigned_to, thread_id, case_id) on public.member_intake_reports from authenticated");
    for (const signature of [
      "public.list_intake_triage_owners()",
      "public.triage_member_intake_report(p_report_id uuid, p_status text, p_assigned_to uuid)",
      "public.convert_member_intake_report(p_report_id uuid, p_target text, p_space_id uuid)",
    ]) {
      const entry = contract.functions.find((item) => item.sig === signature);
      expect(entry?.secdef, signature).toBe(true);
      expect(entry?.exec, signature).toContain("authenticated");
    }
    expect(migration).toContain("not private.mfa_satisfied()");
    expect(migration).toContain("member_has_role(array['steward', 'coordinator'])");
  });

  it("keeps owners and reports inside the caller's chapter", () => {
    expect(migration).toContain("owner_profile.chapter_id = report_row.chapter_id");
    expect(migration).toContain("caller_profile.chapter_id = r.chapter_id");
    expect(migration).toContain("intake owner must be same-chapter staff");
  });

  it("limits intake access and ownership to the roles that can carry the converted case", () => {
    expect(migration).toContain("member_has_role(array['steward', 'coordinator'])");
    expect(migration).toContain("owner_role.role = any(array['steward', 'coordinator'])");
    expect(migration).not.toContain("'steward', 'coordinator', 'admin'");
    expect(squash(migration)).toContain(
      "alter policy member_intake_reports_read on public.member_intake_reports using ( reporter_id = (select auth.uid()) or ( chapter_id = private.current_member_chapter() and public.member_has_role(array['steward', 'coordinator']) ) )",
    );
    expect(squash(migration)).toContain(
      "alter policy member_intake_reports_staff_update on public.member_intake_reports using ( chapter_id = private.current_member_chapter() and public.member_has_role(array['steward', 'coordinator']) ) with check ( chapter_id = private.current_member_chapter() and public.member_has_role(array['steward', 'coordinator']) )",
    );
    for (const name of ["member_intake_reports_read", "member_intake_reports_staff_update"]) {
      const policy = contract.policies.find((item) => item.table === "member_intake_reports" && item.name === name);
      expect(policy?.qualContains, name).toContain("member_has_role(ARRAY['steward'::text, 'coordinator'::text])");
      expect(policy?.qualExcludes, name).toContain("'admin'::text");
    }
    for (const signature of [
      "public.list_intake_triage_owners()",
      "public.triage_member_intake_report(p_report_id uuid, p_status text, p_assigned_to uuid)",
      "public.convert_member_intake_report(p_report_id uuid, p_target text, p_space_id uuid)",
    ]) {
      const entry = contract.functions.find((item) => item.sig === signature);
      expect(entry?.bodyContains.join(" "), signature).not.toContain("admin");
    }
  });

  it("creates one idempotent outcome and refuses target switching", () => {
    expect(migration).toContain("member_intake_reports_single_outcome");
    expect(migration).toContain("num_nonnulls(thread_id, case_id, task_id) <= 1");
    expect(migration).toContain("intake report already converted to another target");
    expect(migration).toContain("'targetId', target_id");
    expect(migration.indexOf("if pg_catalog.num_nonnulls(report_row.case_id"))
      .toBeLessThan(migration.indexOf("if report_row.status = 'closed'"));
  });

  it("uses Standard Task defaults and links instead of copying sensitive text", () => {
    expect(squash(migration)).toContain("select w.name into task_workstream from public.chapter_workstreams w");
    expect(migration).toContain("w.chapter_id = report_row.chapter_id");
    expect(squash(migration)).toContain("order by (w.name = 'General') desc, w.name, w.id");
    expect(squash(migration)).toContain("'Follow up on intake report', '', 'to_do', 'medium', 'general', task_workstream");
    expect(squash(migration)).not.toContain("'Follow up on intake report', '', 'to_do', 'medium', 'general', 'General'");
    expect(migration).toContain("'Authorized intake report'");
    expect(migration).toContain("'/m/organize?intake='");
    expect(migration).not.toContain("report_row.details,");
    expect(migration).toContain("'attachment_added'");
  });

  it("validates a selected space and creates reporter-owned cases", () => {
    expect(migration).toContain("private.can_read_chapter_space(s)");
    expect(migration).toContain("report_row.reporter_id");
    expect(migration).toContain("private.member_case_suffix()");
    expect(migration).toContain("steward_user_id, steward_name, coordinator_user_id, coordinator_name, assigned_at");
    expect(migration).toContain("outcome_owner := coalesce(report_row.assigned_to, caller)");
  });
});
