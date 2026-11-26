// @vitest-environment node
import { expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const migration = loadMigrationSql("20260901162845");

it("moves the three SAMPLE staff reads onto the canonical tenant-aware chapter-role boundary", () => {
  for (const name of [
    "public.list_chapter_task_templates",
    "public.list_chapter_task_template_reviewers",
    "public.get_steward_workload_intelligence",
  ]) {
    const body = stripComments(fnBody(migration, name)).toLowerCase().replace(/\s+/g, " ");
    expect(body).toMatch(/private\.member_has_chapter_role\(\s*caller_chapter,\s*array\['steward', 'coordinator', 'advisor', 'admin', 'vp'\]\s*\)/);
    expect(body).not.toContain("from public.member_roles staff_role");
  }

  const reviewers = stripComments(fnBody(migration, "public.list_chapter_task_template_reviewers"))
    .toLowerCase().replace(/\s+/g, " ");
  expect(reviewers).toContain("private.actor_has_chapter_staff_role(reviewer_profile.id, caller_chapter)");
  expect(reviewers).not.toContain("join public.member_roles reviewer_role");

  const balancing = stripComments(fnBody(migration, "private.workload_rebalancing"))
    .toLowerCase().replace(/\s+/g, " ");
  expect(balancing).toMatch(/private\.organization_member_roles\(\s*p\.id,\s*chapter_scope\.organization_id,\s*p_chapter\s*\) \? 'steward'/);
  expect(balancing).toContain("chapter_scope.organization_id is null");
  expect(balancing).toContain("from public.member_roles legacy_role");
});

it("keeps all repaired RPCs definer-pinned and client ACLs fail closed", () => {
  const sql = stripComments(migration).toLowerCase().replace(/\s+/g, " ");
  for (const signature of [
    "public.list_chapter_task_templates()",
    "public.list_chapter_task_template_reviewers()",
    "public.get_steward_workload_intelligence(integer)",
  ]) {
    expect(sql).toContain(`revoke all on function ${signature} from public, anon`);
    expect(sql).toContain(`grant execute on function ${signature} to authenticated`);
  }
  expect(sql).not.toMatch(/grant execute on function public\.(list_chapter_task_templates|list_chapter_task_template_reviewers|get_steward_workload_intelligence)[^;]*to anon/);
});
