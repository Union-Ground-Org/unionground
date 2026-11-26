// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stripComments } from "./helpers/migration.js";

const migration = readFileSync(
  new URL("../supabase/migrations/20260803214829_chapter_task_multi_assignees.sql", import.meta.url),
  "utf8",
);
const sql = stripComments(migration).replace(/\s+/g, " ").toLowerCase();

describe("task multi-assignee migration", () => {
  it("stores an ordered, bounded, same-task member set and backfills the primary", () => {
    expect(sql).toContain("create table public.chapter_task_assignments");
    expect(sql).toContain("constraint chapter_task_assignments_position_bounded check (position between 0 and 11)");
    expect(sql).toContain("constraint chapter_task_assignments_task_member_key unique (task_id, assignee_id)");
    expect(sql).toContain("constraint chapter_task_assignments_task_position_key unique (task_id, position)");
    expect(sql).toContain("select t.id, t.chapter_id, t.assignee_id, 0");
  });

  it("keeps table writes behind one MFA and staff-gated atomic RPC", () => {
    expect(sql).toContain("alter table public.chapter_task_assignments enable row level security");
    expect(sql).toContain("create policy chapter_task_assignments_select_board");
    expect(sql).toContain("create policy mfa_assurance on public.chapter_task_assignments as restrictive");
    expect(sql).toContain("grant select on table public.chapter_task_assignments to authenticated");
    expect(sql).not.toMatch(/grant (insert|update|delete)[^;]*chapter_task_assignments/);
    expect(sql).toContain("create or replace function public.set_chapter_task_assignees");
    expect(sql).toContain("create or replace function private.sync_chapter_task_primary_assignment");
    expect(sql).toContain("current_setting('sg.setting_task_assignees', true)");
    expect(sql).toContain("create trigger chapter_tasks_sync_primary_assignment");
    expect(sql).toContain("set_config('sg.setting_task_assignees', '1', true)");
    expect(sql).toContain("if caller is null or not private.mfa_satisfied() then");
    expect(sql).toContain("if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then");
    expect(sql).toContain("assignee must be a member of your chapter");
    expect(sql).toContain("set assignee_id = clean_ids[1]");
  });

  it("broadcasts assignment changes on the existing private board topic", () => {
    expect(sql).toContain("create trigger chapter_task_assignments_broadcast after insert or update or delete on public.chapter_task_assignments");
    expect(sql).toContain("execute function private.broadcast_chapter_task_change()");
  });
});
