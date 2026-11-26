import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260830160000_member_operations_completion.sql"),
  "utf8",
).toLowerCase();
const seedSql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260830161000_member_operations_demo_seed.sql"),
  "utf8",
).toLowerCase();

// Cut at this function's own `$function$` closer. The old helper ended at the
// next function's name, and a missing, misspelled, or earlier name made
// indexOf return -1, so slice(start, -1) ran to the end of the file.
const FUNCTION_LEAD = /create\s+(?:or\s+replace\s+)?function\s+/g;
const FUNCTION_OPEN = "$function$";
const FUNCTION_CLOSE = "$function$;";

function sliceFunctionBody(source, name, next = null) {
  const marker = `create function public.${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`function ${name} is not declared in this migration`);
  const lead = new RegExp(FUNCTION_LEAD.source, "g");
  lead.lastIndex = start + marker.length;
  const following = lead.exec(source);
  const limit = following ? following.index : source.length;
  const open = source.indexOf(FUNCTION_OPEN, start);
  const closeAt = open < 0 ? -1 : source.indexOf(FUNCTION_CLOSE, open + FUNCTION_OPEN.length);
  const end = closeAt < 0 ? -1 : closeAt + FUNCTION_CLOSE.length;
  if (open < 0 || open >= limit || end < 0 || end > limit) {
    throw new Error(`function ${name} does not terminate in this migration`);
  }
  if (next != null) {
    const boundary = source.indexOf(`create function public.${next}`, end);
    if (boundary < 0) {
      throw new Error(`function ${name} boundary ${next} was not found after its terminator`);
    }
  }
  return source.slice(start, end);
}

function functionBody(name, next = null) {
  return sliceFunctionBody(sql, name, next);
}

describe("member operations completion migration", () => {
  it("adds every tenant-scoped model with RLS and restrictive MFA", () => {
    for (const table of [
      "weekly_question_selection_policies",
      "organization_member_operational_profiles",
      "organization_welcome_campaigns",
      "organization_welcome_campaign_steps",
      "member_welcome_enrollments",
      "organization_import_batches",
      "organization_import_rows",
    ]) {
      expect(sql).toContain(`create table public.${table}`);
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toContain(`create policy mfa_assurance on public.${table}`);
      expect(sql).toContain(`revoke all on table public.${table} from public, anon, authenticated`);
    }
  });

  it("selects weekly questions deterministically without publishing", () => {
    const body = functionBody("run_weekly_question_selection", "get_member_operations_directory");
    expect(body).toContain("support_score desc");
    expect(body).toContain("created_at asc");
    expect(body).toContain("id asc");
    expect(body).toContain("for update skip locked");
    expect(body).toContain("editorial_state = 'reserved'");
    expect(body).not.toContain("editorial_state = 'published'");
    expect(body).toContain("minimum pool size not met");
    expect(sql).toContain("create function private.run_due_weekly_question_selections");
    expect(sql).toContain("for update skip locked");
    expect(sql).toContain("'weekly-question-selection-tick'");
    expect(sql).toContain("$job$select private.run_due_weekly_question_selections(25);$job$");
    expect(sql).toContain("revoke all on function private.run_due_weekly_question_selections(integer)");
    expect(sql).toContain("create function private.member_reward_effect_enabled_in_organization");
    expect(body).toContain("member_reward_effect_enabled_in_organization(org, support.user_id");
    expect(sql).toContain("member_reward_effect_enabled_in_organization(target.organization_id, support.user_id");
    const policy = functionBody("save_weekly_question_selection_policy", "run_weekly_question_selection");
    expect(policy).toContain("effective_next_run_at := case");
    expect(policy).toContain("pg_catalog.make_interval(days => p_cadence_days)");
  });

  it("keeps member administration explicit, versioned, and allowlisted", () => {
    const save = functionBody("save_member_operational_profile", "bulk_update_member_operational_profiles");
    expect(save).toContain("p_expected_version");
    expect(save).toContain("stale member record");
    expect(save).not.toContain("p_organization_id");
    const bulk = functionBody("bulk_update_member_operational_profiles", "list_member_handoffs_v2");
    expect(bulk).toContain("p_field not in");
    expect(bulk).toContain("pg_catalog.cardinality(p_member_user_ids) > 100");
    expect(bulk).toContain("'fields', pg_catalog.jsonb_build_array(p_field)");
  });

  it("projects a complete handoff history without widening transitions", () => {
    const body = functionBody("list_member_handoffs_v2", "get_welcome_campaign_workspace");
    for (const marker of ["membername", "fromstewardname", "tostewardname", "canacknowledge", "candecline", "cancancel", "note", "nextcursor"]) {
      expect(body).toContain(`'${marker}'`);
    }
    expect(body).toContain("private.mi1_w2_handoff_visible");
    const visibility = sql.slice(
      sql.indexOf("create or replace function private.mi1_w2_handoff_visible"),
      sql.indexOf("create or replace function private.mi1_w2_resolve_handoff"),
    );
    expect(visibility).not.toContain("p_handoff.member_user_id = (select auth.uid())");
    const resolver = sql.slice(
      sql.indexOf("create or replace function private.mi1_w2_resolve_handoff"),
      sql.indexOf("create function public.get_welcome_campaign_workspace"),
    );
    expect(resolver).toContain("where id = p_handoff_id for update");
    expect(resolver).toContain("handoff.to_steward_id is distinct from actor");
    expect(resolver).toContain("private.mi1_w2_handoff_can_oversee(org)");
    const search = functionBody("search_handoff_members", "get_welcome_campaign_workspace");
    expect(search).toContain("pg_catalog.strpos");
    expect(search).toContain("limit 20");
  });

  it("queues welcome steps through the existing lease-bound outbox", () => {
    expect(sql).toContain("delivery_kind in ('broadcast', 'survey_invitation', 'survey_reminder', 'welcome')");
    expect(sql).toContain("source_kind in ('broadcast', 'survey', 'welcome_campaign')");
    const queue = functionBody("queue_due_welcome_messages", "get_member_import_workspace");
    expect(queue).toContain("on conflict (delivery_kind, source_id, recipient_user_id) do nothing");
    expect(queue).toContain("for update skip locked");
    expect(queue).toContain("subject_snapshot, body_snapshot, action_path_snapshot");
    expect(queue).toContain("membership.status = 'active'");
    expect(queue).toContain("pg_catalog.make_interval(days => following_delay)");
    expect(queue).toContain("case when next_step.locale = member_locale then 0 else 1 end");
    expect(queue).toContain("next_step.position > enrollment.next_step_position");
    expect(queue).toContain("set next_step_position = following_position");
    const enroll = functionBody("enroll_member_in_welcome_campaign", "transition_member_welcome_enrollment");
    expect(enroll).toContain("case when step.locale = member_locale then 0 else 1 end");
    expect(enroll).not.toContain("pg_catalog.min(step.delay_days)");
    expect(sql).toContain("engagement_delivery_outbox_welcome_snapshot_complete");
    expect(sql).toContain("select row.subject_snapshot, row.body_snapshot, row.action_path_snapshot");
    expect(sql).toContain("foreign key (organization_id, campaign_id)");
    expect(sql).toContain("references public.organization_welcome_campaigns(organization_id, id)");
    expect(sql).not.toContain("grant select on public.engagement_delivery_outbox to authenticated");
  });

  it("stages bounded imports and commits atomically only after revalidation", () => {
    const upload = functionBody("stage_member_operations_import", "validate_member_operations_import");
    expect(upload).toContain("jsonb_array_length(p_rows) > 500");
    expect(upload).toContain("pg_catalog.octet_length(pg_catalog.convert_to(p_rows::text, 'utf8')) > 2097152");
    expect(upload).toContain("pg_catalog.jsonb_object_keys");
    expect(upload).toContain("key <> all(allowed_fields)");
    expect(upload).toContain("member or grievance");
    const commit = functionBody("commit_member_operations_import");
    expect(commit.endsWith("$function$;")).toBe(true);
    expect(commit).not.toContain("create function public.discard_member_operations_import");
    expect(commit).not.toContain("create function public.get_member_operations_workspace");
    expect(commit).not.toContain("create or replace function public.get_engagement_delivery_payload");
    expect(commit).toContain("for update");
    expect(commit).toContain("batch must be validated");
    expect(commit).toContain("public.validate_member_operations_import(batch.id");
    expect(commit).toContain("'reason', 'revalidation_failed'");
    expect(commit).toContain("row_item.normalized_data ? 'department'");
    expect(commit).toContain("else existing_profile.department end");
    expect(sql).toContain("'code','case_owner_chapter_mismatch'");
    expect(sql).toContain("profile.chapter_id = row_item.normalized_data ->> 'chapter_id'");
    expect(commit).not.toMatch(/exception[\s\S]*commit;/);
    expect(sql).toContain("foreign key (organization_id, batch_id)");
    expect(sql).toContain("references public.organization_import_batches(organization_id, id)");
  });

  it("revokes implicit execute and grants only exact browser RPCs", () => {
    for (const signature of [
      "get_weekly_question_selection_workspace()",
      "list_weekly_question_selection_page(text, timestamptz, uuid, integer)",
      "save_weekly_question_selection_policy(boolean, integer, integer, integer, text, timestamptz)",
      "run_weekly_question_selection(uuid)",
      "get_member_operations_directory(text, text, uuid, integer)",
      "get_member_operational_profile(uuid)",
      "list_member_handoffs_v2(text, text, timestamptz, uuid, integer)",
      "get_welcome_campaign_workspace()",
      "list_welcome_campaign_enrollments(uuid, timestamptz, uuid, integer)",
      "get_member_import_workspace()",
      "list_member_import_batches(timestamptz, uuid, integer)",
    ]) {
      expect(sql).toContain(`revoke all on function public.${signature} from public, anon, authenticated, service_role`);
      expect(sql).toContain(`grant execute on function public.${signature} to authenticated`);
    }
  });

  // The parity ledger (stress/demo-function-parity.json) is a Union Ground
  // operations record Union Ground does not carry; the seed migration itself
  // still names each workflow's function id and evidence key.
  it("adds reversible SAMPLE depth and exact parity evidence for all five workflows", () => {
    for (const [id, evidenceKey] of Object.entries({
      "CR-013": "member-operations-weekly-admin",
      "CR-085": "member-operations-records",
      "CR-096": "member-operations-handoffs",
      "CR-110": "member-operations-welcome",
      "CR-111": "member-operations-imports",
    })) {
      expect(seedSql).toContain(`'${id.toLowerCase()}'`);
      expect(seedSql).toContain(`'${evidenceKey}'`);
    }
    expect(seedSql).toContain("if run.lane not in ('presg','uniondemo')");
    expect(seedSql).toContain("private.presg_demo_authorize");
    expect(seedSql).toContain("private.uniondemo_authorize");
    expect(seedSql).toContain("private.demo_seed_remove_member_operations");
    for (const [surface, pageSize, minimumRows, actualRows = minimumRows] of [
      ["member-operations-records", 25, 50],
      ["member-operations-handoffs", 20, 40],
      ["member-operations-welcome", 10, 20, 40],
      ["member-operations-imports", 10, 20],
    ]) {
      expect(seedSql).toContain(`('${surface}', ${pageSize}, ${minimumRows},`);
      expect(seedSql).toContain(`'${surface}', ${actualRows})`);
    }
    expect(seedSql).toContain("('member-operations-weekly-admin', 26, 52,");
    expect(seedSql).toContain("for i in 1..104 loop");
    expect(seedSql).toContain("select least(");
    expect(seedSql).toContain("question.editorial_state in ('submitted','reserved')");
    expect(seedSql).toContain("question.editorial_state in ('published','archived')");
    expect(seedSql).toContain("'en', 'suppressed', 0, null, 'sample.seed'");
    expect(seedSql).toContain("unsafe_outbound = 0");
    expect(seedSql).not.toMatch(/insert into public\.(organizations|chapters|member_profiles)\b/);
  });

  it("rejects a missing function, an unterminated body, and a boundary that is not after the terminator", () => {
    expect(() => functionBody("not_a_declared_function")).toThrow(/not declared/);
    expect(() => functionBody("commit_member_operations_import", "no_such_boundary")).toThrow(/boundary/);
    expect(() => functionBody("commit_member_operations_import", "stage_member_operations_import")).toThrow(/boundary/);
    const unterminated = [
      "create function public.broken() returns void language sql as $function$",
      "select 1;",
      "create function public.later() returns void language sql as $function$",
      "select 2;",
      "$function$;",
    ].join("\n");
    expect(() => sliceFunctionBody(unterminated, "broken")).toThrow(/does not terminate/);
    expect(() => sliceFunctionBody("create function public.broken() returns void language sql as $function$ select 1;\n", "broken")).toThrow(/does not terminate/);
  });
});
