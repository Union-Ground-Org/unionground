// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fnBody, stripComments } from "./helpers/migration.js";

const root = resolve(import.meta.dirname, "..");
const migrationPath = resolve(root, "supabase/migrations/20260812205000_specialized_task_templates.sql");
const source = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
const sql = stripComments(source).replace(/\s+/g, " ").toLowerCase();
const contract = JSON.parse(readFileSync(resolve(root, "scripts/db-contract.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const proofPath = resolve(root, "scripts/verify-specialized-task-templates-local.mjs");
const proof = existsSync(proofPath) ? readFileSync(proofPath, "utf8") : "";
const concurrencyProofPath = resolve(root, "scripts/verify-specialized-task-template-concurrency-local.mjs");
const concurrencyProof = existsSync(concurrencyProofPath) ? readFileSync(concurrencyProofPath, "utf8") : "";

describe("specialized task template migration", () => {
  it("uses the reserved post-appointment migration version", () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  it("seeds a normalized private catalog for all five real task templates", () => {
    expect(sql).toContain("create table private.chapter_task_template_catalog");
    expect(sql).toContain("create table private.chapter_task_template_fields");
    expect(sql).toContain("create table private.chapter_task_template_flow_steps");
    expect(sql).toContain("create table private.chapter_task_template_checklist_items");
    for (const key of [
      "meeting_event", "review_approval", "member_follow_up", "document_request", "issue_incident",
    ]) expect(sql).toContain(`'${key}'`);
    expect(sql).toContain("constraint chapter_task_template_fields_kind_check");
    expect(sql).toContain("constraint chapter_task_template_flow_status_check");
    expect(sql).toContain("constraint chapter_task_template_checklist_position_key");
    expect(sql).toContain("revoke all on table private.chapter_task_template_catalog from public, anon, authenticated");
    expect(sql).toContain("revoke all on table private.chapter_task_template_fields from public, anon, authenticated");
    for (const key of [
      "scheduled_on", "starts_at", "ends_at", "venue_mode", "review_kind", "reviewer_id",
      "contact_method", "follow_up_on", "record_category", "record_source", "occurred_on", "incident_severity",
    ]) expect(sql).toContain(`'${key}'`);
    expect(sql).not.toMatch(/'(scheduledOn|startsAt|endsAt|venueMode|reviewKind|reviewerId|contactMethod|followUpOn|recordCategory|recordSource|occurredOn|incidentSeverity)'/);
  });

  it("stores one strictly typed inherited-access detail row without a new ACL", () => {
    expect(sql).toContain("create table public.chapter_task_template_details");
    for (const column of [
      "template_key", "flow_step", "scheduled_on", "starts_at", "ends_at", "venue_mode",
      "review_kind", "reviewer_id", "contact_method", "follow_up_on", "record_category",
      "record_source", "occurred_on", "incident_severity",
    ]) expect(sql).toContain(`${column} `);
    expect(sql).toContain("constraint chapter_task_template_details_type_shape check");
    expect(sql).toContain("constraint chapter_task_template_details_time_order check");
    expect(sql).toContain("alter table public.chapter_task_template_details enable row level security");
    expect(sql).toContain("create policy chapter_task_template_details_select_board");
    expect(sql).toContain("t.deleted_at is null");
    expect(sql).toContain("p.chapter_id = chapter_task_template_details.chapter_id");
    expect(sql).toContain("create policy mfa_assurance on public.chapter_task_template_details as restrictive");
    expect(sql).toContain("grant select on table public.chapter_task_template_details to authenticated");
    expect(sql).not.toMatch(/grant (insert|update|delete)[^;]*chapter_task_template_details/);
    expect(sql).not.toMatch(/create table public\.chapter_task_(permissions|members|acl)/);
  });

  it("exposes only MFA and staff-gated RPC writes with fixed search paths", () => {
    for (const signature of [
      "public.list_chapter_task_templates()",
      "public.list_chapter_task_template_reviewers()",
      "public.create_chapter_task_from_template(",
      "public.update_chapter_task_template_details(",
    ]) expect(sql).toContain(`create or replace function ${signature}`);

    for (const name of ["public.list_chapter_task_templates", "public.list_chapter_task_template_reviewers"]) {
      const body = fnBody(source, name).toLowerCase();
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = ''");
      expect(body).toContain("private.mfa_satisfied()");
      expect(body).toContain("public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])");
      expect(body).toContain("from public.member_profiles caller_profile");
      expect(body).toContain("from public.member_roles staff_role");
      expect(body).toContain("staff_role.chapter_id is null or staff_role.chapter_id = caller_chapter");
    }
    for (const [name, chapterExpression] of [
      ["public.create_chapter_task_from_template", "staff_role.chapter_id = caller_chapter"],
      ["public.update_chapter_task_template_details", "staff_role.chapter_id = task_row.chapter_id"],
    ]) {
      const body = fnBody(source, name).toLowerCase().replace(/\s+/g, " ");
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = ''");
      expect(body).toContain("private.mfa_satisfied()");
      expect(body).toContain("public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])");
      expect(body).toContain("from public.member_roles staff_role");
      expect(body).toContain("staff_role.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])");
      expect(body).toContain(`staff_role.chapter_id is null or ${chapterExpression}`);
      expect(body).toContain("order by (staff_role.chapter_id =");
      expect(body).toContain("for share of staff_role");
    }
    expect(fnBody(source, "public.list_chapter_task_templates").toLowerCase()).toContain(
      "from private.chapter_task_template_checklist_items",
    );
    expect(sql).toContain("revoke all on function public.list_chapter_task_templates() from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.list_chapter_task_templates() to authenticated");
    expect(sql).toContain("revoke all on function public.list_chapter_task_template_reviewers() from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.list_chapter_task_template_reviewers() to authenticated");
    const reviewers = fnBody(source, "public.list_chapter_task_template_reviewers").toLowerCase().replace(/\s+/g, " ");
    expect(reviewers).toContain("join public.member_roles reviewer_role");
    expect(reviewers).toContain("reviewer_profile.chapter_id = caller_chapter");
    expect(reviewers).toContain("reviewer_role.chapter_id is null or reviewer_role.chapter_id = caller_chapter");
    expect(reviewers).toContain("'fullname'");
    expect(reviewers).not.toMatch(/(email|phone|initials|role_line)/);
    expect(sql).not.toMatch(/grant execute[^;]+to anon/);
  });

  it("validates create input and writes task, checklist, and details atomically", () => {
    const body = fnBody(source, "public.create_chapter_task_from_template").toLowerCase().replace(/\s+/g, " ");
    expect(body).toContain("jsonb_object_keys");
    expect(body).toContain("template fields invalid");
    expect(body).toContain("template unavailable");
    expect(body).toContain("from public.chapter_workstreams");
    expect(body).toContain("w.chapter_id = caller_chapter");
    expect(body).toContain("reviewer must belong to this chapter");
    expect(body).toContain("join public.member_roles reviewer_role");
    expect(body).toContain("reviewer_role.chapter_id is null or reviewer_role.chapter_id = caller_chapter");
    expect(body).toContain("for share of p, reviewer_role");
    expect(body).toContain("insert into public.chapter_tasks");
    expect(body).toContain("insert into public.chapter_task_template_details");
    expect(body).toContain("string_agg('- [ ] ' || item.label_en");
    expect(body).not.toMatch(/insert into public\.chapter_tasks[\s\S]{0,900}(member_name|incident_narrative|join_link|case_id|source_id)/);
  });

  it("allows flow-only updates and derives a paired canonical status only from the catalog", () => {
    const body = fnBody(source, "public.update_chapter_task_template_details").toLowerCase().replace(/\s+/g, " ");
    expect(body).toContain("for update of t, d");
    expect(body).toContain("target_step.predecessor_keys @> array[detail_row.flow_step]");
    expect(body).toContain("if coalesce(p_apply_recommended_status, false)");
    expect(body).toContain("set status = target_step.recommended_status");
    expect(body).not.toMatch(/p_(status|canonical_status)/);
    expect(body).toContain("'template_flow_changed'");
    expect(body).toContain("detail_row.flow_step");
    expect(body).toContain("target_step.step_key");
    expect(body).toContain("join public.member_roles reviewer_role");
    expect(body).toContain("reviewer_role.chapter_id is null or reviewer_role.chapter_id = task_row.chapter_id");
    expect(body).toContain("for share of p, reviewer_role");
  });

  it("uses generic task-topic notifications without copying task or template field values", () => {
    for (const key of ["task.template.created", "task.template.flow_changed"]) {
      expect(sql).toContain(`'${key}'`);
    }
    const notify = fnBody(source, "private.notify_chapter_task_template_change").toLowerCase();
    expect(notify).toContain("private.notify_member");
    expect(notify).toContain("'tasks'");
    expect(notify).toContain("chapter_task_assignments");
    expect(notify).toContain("chapter_task_watchers");
    expect(notify).toContain("audience.user_id <> p_actor");
    expect(notify).not.toMatch(/(title|workstream|scheduled_on|review_kind|contact_method|record_category|occurred_on|incident_severity)/);
  });

  it("extends immutable task activity with flow keys only", () => {
    expect(sql).toContain("drop constraint chapter_task_activity_action_check");
    expect(sql).toContain("'template_flow_changed'");
    expect(sql).toContain("insert into public.chapter_task_activity");
    expect(sql).not.toMatch(/insert into public\.chapter_task_activity[\s\S]{0,500}(scheduled_on|review_kind|contact_method|record_category|incident_severity)/);
  });

  it("pins the live catalog surface in db-contract", () => {
    for (const sig of [
      "public.list_chapter_task_templates()",
      "public.list_chapter_task_template_reviewers()",
      "public.create_chapter_task_from_template(p_template_key text, p_title text, p_workstream text, p_fields jsonb)",
      "public.update_chapter_task_template_details(p_task_id uuid, p_fields jsonb, p_next_flow_step text, p_apply_recommended_status boolean)",
      "private.notify_chapter_task_template_change(p_task_id uuid, p_actor uuid, p_copy_key text)",
    ]) expect(contract.functions.find((entry) => entry.sig === sig), sig).toBeTruthy();
    for (const sig of [
      "public.list_chapter_task_templates()",
      "public.list_chapter_task_template_reviewers()",
    ]) {
      const entry = contract.functions.find((item) => item.sig === sig);
      // #7665 (20261109060229): unit- and committee-scoped staff also see the catalog.
      expect(entry.bodyContains).toContain("private.member_has_chapter_staff_grant");
      expect(entry.bodyContains).toContain("from public.member_profiles caller_profile");
    }
    // #8391 (20261112163000): both hold the caller's organization grant first,
    // and accept a reviewer exactly as the reviewer roster offers one.
    for (const [sig, scopeNeedle] of [
      ["public.create_chapter_task_from_template(p_template_key text, p_title text, p_workstream text, p_fields jsonb)", "staff_role.chapter_id is null or staff_role.chapter_id = caller_chapter"],
      ["public.update_chapter_task_template_details(p_task_id uuid, p_fields jsonb, p_next_flow_step text, p_apply_recommended_status boolean)", "staff_role.chapter_id is null or staff_role.chapter_id = caller_chapter"],
    ]) {
      const entry = contract.functions.find((item) => item.sig === sig);
      expect(entry.bodyContains).toContain(scopeNeedle);
      expect(entry.bodyContains).toContain("for share of org_role");
      expect(entry.bodyContains).toContain("private.actor_has_chapter_staff_role(reviewer_value, caller_chapter)");
      expect(entry.bodyContains).toContain("member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])");
    }
    expect(contract.tableGrants.find((entry) =>
      entry.table === "public.chapter_task_template_details" && entry.role === "authenticated")?.privileges).toBe("SELECT");
    expect(contract.policies.find((entry) =>
      entry.table === "chapter_task_template_details" && entry.name === "chapter_task_template_details_select_board")).toBeTruthy();
  });

  it("has a rollback-only local behavior proof for authorization, fields, flows, and privacy", () => {
    expect(packageJson.scripts["verify:task-templates:local"]).toBe(
      "node scripts/verify-specialized-task-templates-local.mjs",
    );
    expect(existsSync(proofPath)).toBe(true);
    for (const key of [
      "meeting_event", "review_approval", "member_follow_up", "document_request", "issue_incident",
    ]) expect(proof).toContain(`"${key}"`);
    for (const marker of [
      "aal1_denied", "ordinary_member_denied", "foreign_chapter_denied", "extra_field_denied",
      "malformed_field_denied", "reviewer_scope_denied", "ordinary_reviewer_create_denied",
      "ordinary_reviewer_update_denied", "foreign_scoped_role_create_denied",
      "foreign_scoped_role_update_denied", "workstream_scope_denied",
      "ordinary_member_catalog_denied", "ordinary_member_reviewers_denied",
      "foreign_scoped_catalog_denied", "foreign_scoped_reviewers_denied",
      "reviewer_candidates_all_supported_roles", "reviewer_candidates_exclude_ordinary_and_foreign_scope",
      "staff_policy_unenrolled_create_denied", "staff_policy_unenrolled_update_denied",
      "flow_only_keeps_status", "confirmed_flow_updates_status", "generic_notification_copy",
      "zero_write_denials", "rollback", "residue",
    ]) expect(proof).toContain(marker);
    expect(proof).toContain("predecessorKeys");
    expect(proof).toContain("p_apply_recommended_status");
    expect(proof).toContain("assertDisposableProofUrl(");
  });

  it("has a local lock-race proof for caller and reviewer authorization", () => {
    expect(packageJson.scripts["verify:task-templates:concurrency-local"]).toBe(
      "node scripts/verify-specialized-task-template-concurrency-local.mjs",
    );
    expect(existsSync(concurrencyProofPath)).toBe(true);
    for (const marker of [
      "caller_create_revoke_wins", "caller_update_revoke_wins",
      "reviewer_role_revoke_wins", "reviewer_profile_move_wins",
      "pg_stat_activity", "zero_concurrency_residue",
    ]) expect(concurrencyProof).toContain(marker);
  });
});
