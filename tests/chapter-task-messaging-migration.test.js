import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles } from "./helpers/migration.js";

// 20260727010153 created the task-messaging objects, and this file used to read
// it for everything. That is only sound for facts whose creation is the
// subject. public.send_chapter_task_message has been redefined three times
// since it was born there -- staff-only notices, notify_member, then the tasks
// topic -- so the first declaration stopped describing the body Postgres
// actually ends up with, and the send/notification pins below were quietly
// guarding dead SQL: they still asserted an `insert into
// public.member_notifications ... 'general'` that the live definition replaced
// with private.notify_member on the 'tasks' topic.
//
// So the send assertions resolve the LAST declaration rather than naming a
// file, and only the genuinely historical facts -- the column add, the column
// grants, the table creation, the publication, and the one RPC that is still
// declared exactly once -- are read from the origin migration.
const originName = "20260727010153_task_card_messaging_and_my_work";
const originSql = loadMigrationSql(originName).toLowerCase();

const declaresSendMessage = /create\s+(or\s+replace\s+)?function\s+public\.send_chapter_task_message\s*\(/i;
const sendMessageMigrations = migrationFiles().filter(({ sql }) => declaresSendMessage.test(sql));
const liveSendMessage = sendMessageMigrations.at(-1);
const liveSendMessageSql = liveSendMessage.sql.toLowerCase();
const liveSendMessageBody = fnBody(liveSendMessage.sql, "public.send_chapter_task_message").toLowerCase();

describe("task identity and private messaging migration", () => {
  it("resolves the send RPC's live body from the last migration that declares it", () => {
    // Exhaustive, in apply order: a new declaration anywhere in the chain has
    // to be reviewed against the pins below rather than silently inherited.
    expect(sendMessageMigrations.map(({ name }) => name)).toEqual([
      "20260727010153_task_card_messaging_and_my_work.sql",
      "20260728221042_tasks_staff_only_notices_and_locale.sql",
      "20260728221135_tasks_use_notify_member.sql",
      "20260728221658_tasks_notification_topic.sql",
      // REQ-UG-LEARNING-PERIOD-TASKS-20261103: same body, plus its journal call.
      "20261103183000_learning_period_tasks.sql",
    ]);
    // The pins run against whichever file ends the chain, not against the name
    // above, so they keep following the function when it moves again.
    expect(liveSendMessageBody).toContain("create or replace function public.send_chapter_task_message");
  });

  it("documents the origin migration's same-chapter identity and server-side display copy (historical)", () => {
    expect(originSql).toContain("add column assignee_id uuid references auth.users(id)");
    expect(originSql).toContain("p.id = new.assignee_id");
    expect(originSql).toContain("p.chapter_id = caller_chapter");
    expect(originSql).toContain("new.assignee_name := btrim(resolved_assignee_name)");
    expect(originSql).toContain("new.assignee_id is distinct from old.assignee_id");
    expect(originSql).toContain("new.assignee_name := old.assignee_name");
    expect(originSql).toContain("revoke insert (assignee_name)");
    expect(originSql).toContain("grant insert (assignee_id)");
  });

  it("exposes only the caller's chapter roster through a guarded RPC", () => {
    // The origin migration declared list_chapter_task_assignees; #8337 re-emits
    // it with the unit-scope filter. The last declaration is the function
    // Postgres has.
    const declarations = migrationFiles().filter(({ sql }) =>
      /create\s+(or\s+replace\s+)?function\s+public\.list_chapter_task_assignees\s*\(/i.test(sql));
    expect(declarations.map(({ name }) => name)).toEqual([`${originName}.sql`, "20261112073000_first_run_leak_findings.sql"]);

    const latest = declarations.at(-1).sql;
    const body = fnBody(latest, "public.list_chapter_task_assignees").toLowerCase();
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("not private.mfa_satisfied()");
    expect(body).toContain("where p.chapter_id = caller_chapter");
    expect(body).toContain("unit_limited := private.caller_unit_limited_in_chapter(caller_chapter)");
    expect(body).toContain("and (not unit_limited or private.caller_may_see_member(p.id))");
    expect(latest).toContain("revoke all on function public.list_chapter_task_assignees() from public, anon, authenticated");
    expect(latest).toContain("grant execute on function public.list_chapter_task_assignees() to authenticated");
  });

  it("created task messages as immutable and participant-only in the origin migration (historical)", () => {
    expect(originSql).toContain("create table public.chapter_task_messages");
    expect(originSql).toContain("sender_id <> recipient_id");
    expect(originSql).toContain("char_length(btrim(body)) between 1 and 2000");
    expect(originSql).toContain("sender_id = (select auth.uid())");
    expect(originSql).toContain("recipient_id = (select auth.uid())");
    expect(originSql).toContain("create policy mfa_assurance");
    expect(originSql).toContain("grant select on table public.chapter_task_messages to authenticated");
    expect(originSql).not.toContain("grant insert on table public.chapter_task_messages");
    expect(originSql).not.toContain("grant update on table public.chapter_task_messages");
    expect(originSql).not.toContain("grant delete on table public.chapter_task_messages");
  });

  it("selects the other task participant inside the guarded send RPC", () => {
    expect(liveSendMessageBody).toContain("security definer");
    expect(liveSendMessageBody).toContain("set search_path = ''");
    expect(liveSendMessageBody).toContain("not private.mfa_satisfied()");
    expect(liveSendMessageBody).toContain("for update of t");
    expect(liveSendMessageBody).toContain("caller is distinct from task_row.created_by");
    expect(liveSendMessageBody).toContain("caller is distinct from task_row.assignee_id");
    expect(liveSendMessageBody).toContain("recipient := task_row.created_by");
    expect(liveSendMessageBody).toContain("recipient := task_row.assignee_id");
    expect(liveSendMessageBody).toContain("recipient_profile.chapter_id = task_row.chapter_id");
    // The grant sits outside the body, next to the declaration that ends the chain.
    expect(liveSendMessageSql).toContain("grant execute on function public.send_chapter_task_message(uuid, text)");
  });

  it("notifies the recipient on the tasks topic in the live body; the origin migration published insert-only task messages (historical)", () => {
    // notify_member is the single enforcement point, and 'tasks' is the topic
    // that lets the notice leave the app; 'general' would make it in-app only.
    expect(liveSendMessageBody).toContain("private.notify_member(");
    expect(liveSendMessageBody).toContain("'task.message'");
    expect(liveSendMessageBody).toContain("'tasks')");
    expect(liveSendMessageBody).not.toContain("insert into public.member_notifications");

    expect(originSql).toContain("pubdelete or pubupdate or pubtruncate");
    expect(originSql).toContain("alter publication supabase_realtime add table public.chapter_task_messages");
  });
});
