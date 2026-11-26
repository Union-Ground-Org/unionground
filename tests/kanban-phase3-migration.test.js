// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const migration = readFileSync(
  resolve(root, "supabase/migrations/20260802041359_kanban_phase3_subtasks_watchers.sql"),
  "utf8",
).toLowerCase();
const indexMigration = readFileSync(
  resolve(root, "supabase/migrations/20260802041915_kanban_phase3_subtasks_created_by_index.sql"),
  "utf8",
).toLowerCase();

describe("kanban Phase 3 migration", () => {
  it("creates immutable, chapter-scoped full-task subtask links", () => {
    expect(migration).toContain("create table public.chapter_task_subtasks");
    expect(migration).toContain("constraint chapter_task_subtasks_one_parent unique (subtask_id)");
    expect(migration).toContain("constraint chapter_task_subtasks_no_self");
    expect(migration).toContain("hashtextextended('chapter_task_subtasks:' || caller_chapter, 0)");
    expect(migration).toContain("with recursive descendants");
    expect(migration).toContain("subtask link would create a cycle");
    expect(migration).toContain("create trigger chapter_task_subtasks_broadcast");
    expect(migration).toContain("grant insert (parent_task_id, subtask_id)");
    expect(migration).not.toMatch(/grant update[^;]*chapter_task_subtasks/);
  });

  it("keeps watch state private to the current user", () => {
    expect(migration).toContain("create table public.chapter_task_watchers");
    expect(migration).toContain("new.user_id := caller");
    expect(migration).toContain("new.chapter_id := caller_chapter");
    expect(migration).toContain("chapter_task_watchers_select_own");
    expect(migration).toContain("user_id = (select auth.uid())");
    expect(migration).toContain("grant select (task_id)");
    expect(migration).toContain("grant insert (task_id)");
    expect(migration).not.toMatch(/grant select \([^)]*user_id/);
    expect(migration).not.toMatch(/chapter_task_watchers_broadcast/);
    expect(migration).not.toMatch(/publication[^;]*chapter_task_watchers/);
    expect(migration).not.toMatch(/notify_member\s*\(/);
    expect(migration).not.toMatch(/grant update[^;]*chapter_task_watchers/);
  });

  it("requires MFA on both new tables", () => {
    expect(migration.match(/create policy mfa_assurance/g)).toHaveLength(2);
    expect(migration.match(/private\.mfa_satisfied\(\)/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("covers the subtask creator foreign key", () => {
    expect(indexMigration).toContain("create index chapter_task_subtasks_created_by_idx");
    expect(indexMigration).toContain("on public.chapter_task_subtasks (created_by)");
  });
});
