// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./helpers/migration.js";

const root = resolve(import.meta.dirname, "..");
const source = readFileSync(
  resolve(root, "supabase/migrations/20260802190831_standard_task_contract.sql"),
  "utf8",
).toLowerCase();
const sql = stripComments(source).replace(/\s+/g, " ");
const indexSql = stripComments(readFileSync(
  resolve(root, "supabase/migrations/20260802190959_standard_task_fk_indexes.sql"),
  "utf8",
).toLowerCase()).replace(/\s+/g, " ");

describe("Standard Task database contract", () => {
  it("sets the title-only quick-create defaults and five-stage workflow", () => {
    expect(sql).toContain("alter column status set default 'to_do'");
    expect(sql).toContain("alter column start_date drop default");
    expect(sql).toContain("alter column start_date drop not null");
    expect(sql).toContain("alter column due_date drop default");
    expect(sql).toContain("alter column due_date drop not null");
    expect(sql).toContain("add column task_type text not null default 'general'");
    for (const status of ["backlog", "to_do", "in_progress", "needs_review", "done"]) {
      expect(sql).toContain(`'${status}'`);
    }
    for (const type of ["general", "meeting_event", "review_approval", "member_follow_up", "document_request", "issue_incident"]) {
      expect(sql).toContain(`'${type}'`);
    }
  });

  it("keeps comments chapter-scoped, staff-written and mention-aware", () => {
    expect(sql).toContain("create table public.chapter_task_comments");
    expect(sql).toContain("create policy chapter_task_comments_select_board");
    expect(sql).toContain("grant select on table public.chapter_task_comments to authenticated");
    expect(sql).not.toMatch(/grant\s+(insert|update|delete)[^;]*chapter_task_comments/);
    expect(sql).toContain("add_chapter_task_comment");
    expect(sql).toContain("if caller is null or not private.mfa_satisfied() then");
    expect(sql).toContain("member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])");
    expect(sql).toContain("mentioned member must belong to this chapter");
    expect(sql).toContain("select task_row.created_by as user_id");
    expect(sql).toContain("union all select task_row.assignee_id");
    expect(sql).toContain("union all select unnest(clean_mentions)");
    expect(sql).toContain("perform private.notify_member(");
    expect(sql).toContain("select t.* into task_row");
    expect(sql).toContain("select p.full_name into caller_name");
    expect(sql).not.toContain("into task_row, caller_name");
  });

  it("stores authorized in-app record links, not copied protected records", () => {
    expect(sql).toContain("create table public.chapter_task_attachments");
    expect(sql).toContain("record_url ~ '^/m(/|$)'");
    expect(sql).toContain("record_url !~ '[[:space:]]'");
    expect(sql).toContain("attachment must be an authorized in-app record link");
    expect(sql).toContain("grant select on table public.chapter_task_attachments to authenticated");
    expect(sql).not.toMatch(/grant\s+(insert|update|delete)[^;]*chapter_task_attachments/);
  });

  it("records assignment, workflow and permission-sensitive changes", () => {
    expect(sql).toContain("create table public.chapter_task_activity");
    expect(sql).toContain("create trigger chapter_tasks_audit");
    for (const action of [
      "created", "status_changed", "assignee_changed", "type_changed", "blocked",
      "unblocked", "board_changed", "deleted", "restored", "attachment_added", "attachment_removed",
    ]) {
      expect(sql).toContain(`'${action}'`);
    }
    expect(sql).toContain("grant select on table public.chapter_task_activity to authenticated");
    expect(sql).not.toMatch(/grant\s+(insert|update|delete)[^;]*chapter_task_activity/);
  });

  it("inherits the board boundary and preserves the approved realtime publication", () => {
    expect(sql).not.toMatch(/add column (visibility|permission|acl)/);
    expect(sql).not.toMatch(/create table public\.chapter_task_(permissions|members|acl)/);
    expect(sql).not.toContain("alter publication");
    expect(source.match(/create policy mfa_assurance/g)).toHaveLength(3);
  });

  it("covers each new foreign key that is not led by a query index", () => {
    for (const index of [
      "chapter_task_comments_author_idx",
      "chapter_task_attachments_chapter_idx",
      "chapter_task_attachments_created_by_idx",
      "chapter_task_activity_chapter_idx",
      "chapter_task_activity_actor_idx",
    ]) {
      expect(indexSql).toContain(`create index ${index}`);
    }
  });
});
