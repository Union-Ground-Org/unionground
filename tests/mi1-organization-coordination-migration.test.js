// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { forbiddenSupabaseRefsIn } from "../scripts/lib/sibling-deny-list.mjs";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const raw = loadMigrationSql("20260828231000_mi1_organization_coordination");
const sql = stripComments(raw);
const workflowRaw = loadMigrationSql("20260828232000_mi1_organization_coordination_workflows");
const workflowSql = stripComments(workflowRaw);
const callerCompletionRaw = loadMigrationSql("20260921221000_organization_coordination_caller_completion_projection");
const callerCompletionSql = stripComments(callerCompletionRaw);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

function body(name) {
  return fnBody(`${sql}\n${workflowSql}`, name);
}

function latestBody(name) {
  const latest = [...migrationFiles()].reverse().find(({ sql: source }) => (
    source.toLowerCase().includes(`function ${name.toLowerCase()}(`)
  ));
  expect(latest, `${name} must have a latest migration generation`).toBeTruthy();
  return stripComments(fnBody(latest.sql, name));
}

describe("MI1 organization coordination persistence", () => {
  it("creates the shared typed records and protected operational ledgers", () => {
    for (const table of [
      "organization_coordination_records",
      "organization_coordination_organization_participants",
      "organization_coordination_user_participants",
      "organization_coordination_events",
      "organization_coordination_messages",
      "organization_coordination_resources",
      "organization_coordination_export_runs",
      "organization_coordination_outreach_events",
      "organization_merge_remap_events",
    ]) {
      expect(sql).toContain(`create table public.${table}`);
      expect(sql).toContain(`alter table public.${table} enable row level security`);
    }
    for (const kind of [
      "mission", "mission_objective", "network_link", "network_conversation",
      "network_request", "network_export_schedule", "handshake_workspace_item",
      "coalition", "coalition_campaign", "coalition_work_item", "merger_plan",
      "microsite_page", "coverage_schedule", "coverage_override", "committee",
      "mobilization_campaign", "mobilization_cohort",
    ]) expect(sql).toContain(`'${kind}'`);
  });

  it("derives organization scope from the authenticated session", () => {
    for (const name of [
      "create_organization_coordination_record",
      "join_organization_coordination_record",
      "transition_organization_coordination_record",
      "respond_organization_coordination_invitation",
      "send_organization_coordination_message",
      "share_organization_coordination_resource",
      "run_organization_coordination_export",
      "record_organization_coordination_outreach",
      "get_organization_coordination_snapshot",
    ]) {
      const source = body(name);
      expect(source).toContain("private.current_member_organization()");
      expect(source).not.toMatch(/p_organization_id\b/);
    }
  });

  it("keeps direct writes closed and grants only bounded RPC execution", () => {
    expect(sql).toMatch(/revoke all on public\.%I from public, anon, authenticated/i);
    expect(sql).toMatch(/grant select on public\.%I to authenticated/i);
    expect(sql).not.toMatch(/grant\s+(insert|update|delete|all)[^;]+to authenticated/i);
    expect(sql).not.toMatch(/grant execute[^;]+to service_role/i);
    expect(sql).not.toMatch(/service_role_key|createServiceClient/i);
    expect(forbiddenSupabaseRefsIn(sql)).toEqual([]);
  });

  it("requires explicit cross-organization participation and participant messages", () => {
    const readable = body("private.organization_coordination_can_read");
    expect(readable).toContain("organization_coordination_organization_participants");
    expect(readable).toContain("organization_coordination_user_participants");
    expect(readable).toContain("p.status = 'active'");
    const send = body("send_organization_coordination_message");
    expect(send).toContain("conversation participation required");
    expect(send).toContain("network_conversation");
    expect(send).toContain("coalition_campaign");
  });

  it("links protected resources instead of copying document content", () => {
    const share = body("share_organization_coordination_resource");
    expect(share).toContain("public.chapter_documents");
    expect(share).toContain("public.chapters");
    expect(share).toContain("c.organization_id = organization");
    expect(share).not.toMatch(/select\s+d\.(body|content|storage_path)/i);
  });

  it("projects anonymous mission rankings and an honest empty launch state", () => {
    const snapshot = body("get_organization_coordination_snapshot");
    expect(snapshot).toContain("'state', 'empty'");
    expect(snapshot).toContain("privacy_alias");
    expect(snapshot).not.toContain("ranked.user_id");
    expect(body("run_organization_coordination_export")).toContain("'internal_download'");
  });

  it("projects caller-specific objective completion in snapshots and record pages", () => {
    expect(callerCompletionSql).toMatch(/^\s*begin;/);
    expect(callerCompletionSql).toMatch(/commit;\s*$/);
    expect(callerCompletionSql).toContain("set local lock_timeout = '5s'");

    for (const name of [
      "public.get_organization_coordination_snapshot",
      "public.list_organization_coordination_records",
    ]) {
      const source = latestBody(name);
      expect(source).toContain("'completedByCaller'");
      expect(source).toContain("from public.organization_coordination_events event");
      expect(source).toContain("event.actor_user_id = caller");
      expect(source).toContain("event.event_type = 'complete_objective'");
    }

    for (const signature of [
      "public.get_organization_coordination_snapshot()",
      "public.list_organization_coordination_records(p_before_updated_at timestamp with time zone, p_before_id uuid, p_limit integer)",
    ]) {
      const entry = contract.functions.find((candidate) => candidate.sig === signature);
      expect(entry, `${signature} must remain contracted`).toBeTruthy();
      expect(entry.bodyContains).toEqual(expect.arrayContaining([
        "'completedByCaller'",
        "event.actor_user_id = caller",
        "event.event_type = 'complete_objective'",
      ]));
    }
  });

  it("keeps outreach targets inside the selected organization", () => {
    const outreach = body("record_organization_coordination_outreach");
    expect(outreach).toContain("public.organization_memberships");
    expect(outreach).toContain("m.organization_id = organization");
    expect(outreach).toContain("m.status = 'active'");
    expect(outreach).toContain("organization outreach role required");
  });

  it("records donor provenance and the caller-selected tenant boundary in the migration", () => {
    expect(raw).toContain("donor-baseline-20260721");
    expect(raw).toContain("caller-selected tenant ids");
  });

  it("adds workflow-specific ledgers without direct client writes", () => {
    for (const table of [
      "organization_network_directory_profiles",
      "organization_network_permission_grants",
      "organization_network_access_events",
      "organization_mission_badges",
      "organization_merge_match_reviews",
      "organization_merge_jobs",
      "organization_coordination_page_attachments",
    ]) {
      expect(workflowSql).toContain(`create table public.${table}`);
      expect(workflowSql).toContain(`alter table public.${table} enable row level security`);
    }
    expect(workflowSql).toMatch(/revoke all on public\.%I from public, anon, authenticated/i);
    expect(workflowSql).not.toMatch(/grant\s+(insert|update|delete|all)[^;]+to authenticated/i);
  });

  it("gates cross-organization messaging and resources on accepted-link permissions", () => {
    const shape = body("private.validate_organization_coordination_record_shape");
    expect(shape).toContain("private.organization_network_has_permission");
    expect(shape).toContain("network work requires an active network link");
    const resource = body("private.validate_organization_coordination_resource_permission");
    expect(resource).toContain("resource_share");
    expect(resource).toContain("resource_request");
  });

  it("implements badges, coalition invitations, committee selection, and campaign progress", () => {
    expect(body("private.award_organization_mission_badges")).toContain("'bronze'::text, 25");
    expect(body("invite_organization_coordination_participant")).toContain("organization_invited");
    expect(body("assign_organization_coordination_participant")).toContain("committee");
    expect(body("get_organization_coordination_extensions")).toContain("'mobilizationProgress'");
  });

  it("executes only an exact accepted merger mapping plan and appends remap evidence", () => {
    const execute = body("execute_organization_merge_plan");
    expect(execute).toContain("p_expected_source_organization_id");
    expect(execute).toContain("p_expected_target_organization_id");
    expect(execute).toContain("organization merger plan changed");
    expect(execute).toContain("public.organization_merge_remap_events");
    expect(execute).not.toMatch(/delete\s+from\s+public\.organizations/i);
  });

  it("backs page attachments, coverage recommendation, and scheduled export runs", () => {
    expect(body("attach_organization_coordination_page_document")).toContain("d.chapter_id = page.chapter_id");
    expect(body("take_over_organization_coordination_page")).toContain("page_taken_over");
    expect(body("recommend_organization_coverage")).toContain("coverage_override");
    const due = body("run_due_organization_coordination_exports");
    expect(due).toContain("for update skip locked");
    expect(workflowSql).toMatch(/grant execute on function public\.run_due_organization_coordination_exports\([\s\S]*?\) to service_role/i);
    expect(workflowSql).not.toMatch(/grant execute on function public\.run_due_organization_coordination_exports\([\s\S]*?\) to authenticated/i);
  });
});
