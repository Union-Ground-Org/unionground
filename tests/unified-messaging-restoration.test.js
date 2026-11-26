// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

const sql = loadMigrationSql("20260812200000_unified_messaging_restoration.sql");
const deletionSql = loadMigrationSql("20260812202000_messaging_deletion_integrity.sql");

describe("unified messaging restoration migration", () => {
  it("preserves task-source records during an actor FK identity detach", () => {
    const body = fnBody(deletionSql, "private.prepare_chapter_task");
    expect(body).toContain("caller is null");
    expect(body).toContain("pg_catalog.pg_trigger_depth() > 1");
    expect(body).toContain("pg_catalog.to_jsonb(new) - array[");
    expect(body).toContain("new.created_by is null or new.created_by is not distinct from old.created_by");
    expect(body).toContain("new.assignee_name := ''");
    expect(body).toContain("raise exception 'authentication required'");
  });

  it("uses reference-only polymorphic reactions and saves with underlying-access RLS", () => {
    for (const table of ["member_message_reactions", "member_saved_messages"]) {
      expect(sql).toContain(`create table public.${table}`);
      expect(sql).toContain(`alter table public.${table} enable row level security`);
    }
    expect(sql).toContain("source_kind in ('private','channel','task')");
    expect(sql).toContain("reaction in ('like','support','celebrate')");
    expect(sql).not.toContain("'agree','thanks','question'");
    expect(sql).toContain("private.current_actor_can_read_message_source(source_kind");
    expect(sql).toContain("grant execute on function private.current_actor_can_read_message_source(text, uuid, uuid, uuid) to authenticated");
    expect(sql).not.toContain("grant execute on function private.can_read_message_source(uuid, text, uuid, uuid, uuid) to authenticated");
    const savedTable = sql.match(/create table public\.member_saved_messages\s*\(([\s\S]*?)\n\);/i)?.[1] || "";
    expect(savedTable).not.toMatch(/\bbody\s+text/i);
    expect(savedTable).not.toMatch(/\bsummary\s+text/i);
  });

  it("keeps contact notes staff-only and out of the explicit member export", () => {
    expect(sql).toContain("create table public.member_contact_notes");
    expect(sql).toContain("create policy member_contact_notes_steward_read");
    expect(sql).toContain("member_has_role(array['steward'])");
    expect(sql).not.toMatch(/grant\s+select[^;]*member_contact_notes\s+to\s+authenticated/i);
    expect(sql).toContain("grant execute on function public.list_member_contact_notes(uuid) to authenticated");
    const exportBody = fnBody(loadMigrationSql("20260812180000_member_account_lifecycle.sql"), "public.get_member_data_export()");
    expect(exportBody).not.toContain("member_contact_notes");
    expect(sql).toContain("author_id uuid references auth.users(id) on delete set null");
    expect(sql).toContain("added_by uuid references auth.users(id) on delete set null");
  });

  it("rechecks actor, recipient, conversation, chapter, role, and staff MFA when scheduled sends dispatch", () => {
    const body = fnBody(sql, "private.dispatch_due_member_messaging(p_limit integer default 100)");
    expect(body).toContain("for update skip locked");
    expect(body).toContain("private.can_actor_send_private_message(job.actor_id, job.conversation_id, job.sender_kind)");
    expect(body).toContain("status = 'failed'");
    expect(body).toContain("authorization-revoked");
    expect(body).toContain("on conflict (scheduled_message_id) do nothing");
    expect(sql).toContain("cron.schedule('member-messaging-dispatch'");
  });

  it("delivers content-free reminders only after rechecking source visibility", () => {
    const body = fnBody(sql, "private.dispatch_due_member_messaging(p_limit integer default 100)");
    expect(body).toContain("private.can_read_message_source(reminder.owner_id, reminder.source_kind");
    expect(body).toContain("'Open Messages to review your reminder.'");
    expect(body).not.toContain("reminder.note,");
  });

  it("creates resource drops atomically against currently readable chapter documents", () => {
    const body = fnBody(sql, "public.send_member_resource(p_conversation_id uuid, p_document_id uuid, p_body text default null)");
    expect(body).toContain("private.can_actor_send_private_message(caller, p_conversation_id, 'member')");
    expect(body).toContain("chapter_documents");
    expect(body).toContain("status = 'published'");
    expect(body).toContain("insert into public.member_message_resources");
    expect(body).toContain("'Shared resource'");
    expect(body).not.toContain("'Shared resource: ' || document_title");
  });

  it("requires both the steward sender and member recipient to read a dropped resource", () => {
    const body = fnBody(sql, "public.send_steward_resource");
    expect(body).toContain("private.actor_can_read_document(caller, id)");
    expect(body).toContain("private.actor_can_read_document(conversation.user_id, id)");
    expect(body).toContain("'Shared resource'");
    expect(body).not.toContain("'Shared resource: ' || document_title");
  });

  it("keeps message-to-event admin-only, explicit-field, and body-free", () => {
    const body = fnBody(sql, "public.create_event_from_member_message(p_message_id uuid, p_event_id text, p_title text, p_starts_at timestamptz, p_location text, p_summary text, p_check_in_code text)");
    expect(body).toContain("member_has_role(array['admin'])");
    expect(body).toContain("private.can_read_message_source(caller, 'private'");
    expect(body).toContain("public.create_member_event");
    expect(body).not.toContain("source_message.body");
    expect(body).not.toContain("select body");
  });

  it("resolves saved/reminder aggregation without exposing inaccessible ids or content", () => {
    const body = fnBody(sql, "public.list_member_message_activity");
    const resolver = fnBody(sql, "private.message_source_target");
    expect(body).toContain("candidate.owner_id = caller");
    expect(body).toContain("candidate.status = 'pending'");
    expect(resolver).toContain("private.can_read_message_source");
    expect(resolver).toContain("message.conversation_id");
    expect(resolver).toContain("post.thread_id");
    expect(resolver).toContain("message.task_id");
    expect(body).toContain("private.message_source_target");
    expect(body).toContain("'targetId'");
    expect(body).toContain("target_id is not null");
    expect(body).toContain("else null end");
    expect(body.match(/limit 100/g)).toHaveLength(2);
    expect(body).not.toContain(".body");
  });

  it("enriches the bounded steward private-thread pager for shared message actions", () => {
    const body = fnBody(sql, "public.list_steward_thread_messages");
    expect(body).toContain("least(greatest(coalesce(p_limit, 50), 1), 200)");
    expect(body).toContain("public.member_message_reactions");
    expect(body).toContain("public.member_saved_messages");
    expect(body).toContain("public.member_message_reminders");
    expect(body).toContain("public.member_message_resources");
  });

  it("revokes direct mutation and exposes only bounded RPCs", () => {
    for (const table of [
      "member_message_reactions",
      "member_saved_messages",
      "member_scheduled_messages",
      "member_message_reminders",
      "member_message_resources",
      "member_contact_notes",
    ]) {
      expect(sql).toContain(`revoke all on public.${table} from public, anon, authenticated`);
    }
    expect(sql).not.toMatch(/grant\s+(insert|update|delete|all)[^;]*member_(message_reactions|saved_messages|scheduled_messages|message_reminders|message_resources|contact_notes)\s+to\s+authenticated/i);
  });
});
