// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { codeOnly, helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { stripComments } from "./helpers/migration.js";

const FILE = "20261001020000_connected_workflow_shortcuts.sql";
const raw = readFileSync(`supabase/migrations/${FILE}`, "utf8");
const sql = stripComments(raw);
const flat = sql.replace(/\s+/g, " ");
const functions = parseFunctions(raw, FILE);
const byName = (name) => functions.find((fn) => fn.name === name);

const PUBLIC_RPCS = [
  "public.get_connected_workflow_context",
  "public.list_connected_workflow_recipients",
  "public.create_connected_workflow_task",
  "public.save_connected_workflow_reminder",
  "public.list_connected_workflow_reminders",
  "public.act_on_connected_workflow_reminder",
  "public.send_connected_workflow_message",
  "public.set_member_event_organizer",
  "public.list_member_event_organizer_candidates",
  "public.set_member_event_contact_opt_in",
  "public.list_member_event_contact_messages",
];
const WRITERS = [
  "public.create_connected_workflow_task", "public.save_connected_workflow_reminder",
  "public.act_on_connected_workflow_reminder", "public.send_connected_workflow_message",
  "public.set_member_event_organizer", "public.set_member_event_contact_opt_in",
  "private.dispatch_due_workflow_reminders",
];
const READERS = PUBLIC_RPCS.filter((name) => !WRITERS.includes(name));

function tableBlock(name) {
  const start = sql.indexOf(`create table ${name} (`);
  expect(start, `${name} is created`).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf("\n);", start) + 3);
}

describe("connected workflow shortcuts migration (offline pins)", () => {
  it("is a new, uniquely versioned migration", () => {
    const version = FILE.split("_")[0];
    const same = readdirSync("supabase/migrations").filter((name) => name.startsWith(`${version}_`));
    expect(same).toEqual([FILE]);
    expect(raw.startsWith("-- REQ-UG-CONNECTED-WORKFLOW-SHORTCUTS-20260928")).toBe(true);
    expect(sql).toMatch(/^\s*begin;/);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("gives every public RPC an MFA-assured, definer-safe, authenticated-only surface", () => {
    for (const name of PUBLIC_RPCS) {
      const fn = byName(name);
      expect(fn, name).toBeDefined();
      const declaration = new RegExp(`create function ${name.replace(".", "\\.")}\\(.*?as \\$function\\$`).exec(flat);
      expect(declaration, `${name} declaration`).not.toBeNull();
      expect(declaration[0], name).toContain("security definer");
      expect(declaration[0], name).toContain("set search_path = ''");
      expect(fn.source, name).toContain("private.mfa_satisfied()");
      expect(flat, name).toMatch(new RegExp(`revoke all on function ${name.replace(".", "\\.")}\\([^)]*\\) from public, anon, authenticated, service_role;`));
      expect(flat, name).toMatch(new RegExp(`grant execute on function ${name.replace(".", "\\.")}\\([^)]*\\) to authenticated;`));
      expect(flat, name).not.toMatch(new RegExp(`grant execute on function ${name.replace(".", "\\.")}\\([^)]*\\) to [^;]*(anon|service_role|public)`));
    }
    for (const fn of functions.filter((candidate) => candidate.name.startsWith("private."))) {
      expect(flat, fn.name).toMatch(new RegExp(`revoke all on function ${fn.name.replace(".", "\\.")}\\([^)]*\\) from public, anon, authenticated, service_role;`));
    }
  });

  it("enters the case graph gate first in every writer and writes nothing in a reader", () => {
    for (const name of WRITERS) expect(helperFirst(byName(name).source), name).toBe(true);
    for (const name of READERS) {
      const code = codeOnly(byName(name).source);
      expect(code, name).not.toMatch(/\b(insert\s+into|delete\s+from|update\s+[\w.]+\s+set|pg_advisory|for\s+update)\b/);
    }
    for (const name of ["private.cw_resolve_source", "private.cw_recipients", "private.cw_event_recipients", "private.cw_task_recipients", "private.cw_reminder_json"]) {
      expect(codeOnly(byName(name).source), name).not.toMatch(/\b(insert\s+into|delete\s+from|update\s+[\w.]+\s+set)\b/);
    }
  });

  it("keeps message words only in the canonical private-message rows", () => {
    // Bodies live in public.member_messages, written by the existing conversation writers.
    const link = tableBlock("private.member_event_contact_links");
    expect(link).toContain("references public.member_messages(id) on delete cascade");
    expect(link).toMatch(/organizer_id uuid\s+references auth\.users\(id\) on delete set null/);
    expect(link).toMatch(/participant_id uuid\s+references auth\.users\(id\) on delete set null/);
    expect(link).not.toMatch(/\b(body|preview|text)\b\s+text|\bbody\b/i);
    expect(tableBlock("private.member_event_contact_opt_ins")).not.toMatch(/\bbody\b/i);
    expect(flat).not.toContain("create table private.member_event_messages");
    for (const table of ["private.member_event_contact_links", "private.member_event_contact_opt_ins"]) {
      expect(flat).toContain(`alter table ${table} enable row level security; alter table ${table} force row level security; revoke all on table ${table} from public, anon, authenticated, service_role;`);
    }

    const send = byName("public.send_connected_workflow_message").source;
    for (const writer of ["public.send_chapter_task_message(", "public.send_reward_peer_message(", "public.send_steward_reply(", "public.send_member_message(", "public.start_member_steward_conversation("]) {
      expect(send, writer).toContain(writer);
    }
    const sendCode = codeOnly(send);
    expect(sendCode).not.toMatch(/insert\s+into\s+public\.member_messages/);
    expect(sendCode).not.toMatch(/insert\s+into\s+public\.member_notifications/);
    expect(sendCode).not.toMatch(/insert\s+into\s+private\.member_event_messages/);
    // The ledger row carries ids and a salted digest, never the words.
    const ledger = sendCode.slice(sendCode.indexOf("insert into public.organization_audit_ledger"));
    expect(ledger).toContain("'payloaddigest', digest");
    expect(ledger.slice(0, ledger.indexOf(");"))).not.toContain("clean_body");
    // The event thread is read from the canonical row after the read predicate.
    const reader = byName("public.list_member_event_contact_messages").source;
    expect(reader).toContain("join public.member_messages m on m.id = l.message_id");
    expect(reader).toContain("private.can_read_message_source(caller, 'private', m.id, null, null)");
    expect(reader.indexOf("private.cw_resolve_source(caller, 'event', p_event_id)")).toBeLessThan(reader.indexOf("member_event_contact_links l"));
  });

  it("registers every new auth.users identity in the account lifecycle manifest", () => {
    for (const row of [
      "('public', 'member_events', 'organizer_id', 'pseudonymize', 'excluded_with_reason'",
      "('private', 'member_event_contact_opt_ins', 'user_id', 'cascade', 'included'",
      "('private', 'member_event_contact_links', 'participant_id', 'pseudonymize', 'included'",
      "('private', 'member_event_contact_links', 'organizer_id', 'pseudonymize', 'excluded_with_reason'",
    ]) expect(sql, row).toContain(row);
    expect(sql).toContain("private.account_lifecycle_referential_action_trigger_issues()");
    expect(sql).toContain("private.account_lifecycle_unmanaged_export_fks()");
    for (const table of ["private.member_event_contact_links", "private.member_event_contact_opt_ins"]) {
      expect(sql).toContain(`create trigger a00_case_graph_lock before insert or update or delete on ${table}`);
      expect(sql).toContain(`create trigger z99_case_graph_keys before insert or update or delete on ${table}`);
    }
    expect(sql).toContain("drop trigger z99_case_graph_keys on public.member_events;");
    expect(sql).toContain("lock_case_graph_row_keys('{organizer_id}', '')");
    expect(sql).toContain("'member_event_contact_links', private.account_lifecycle_export_member_event_contact_links(p_caller)");
    expect(sql).toContain("'member_event_contact_opt_ins', private.account_lifecycle_export_member_event_contact_opt_ins(p_caller)");
    // The export of the caller's reminders names every new column.
    const exporter = byName("private.account_lifecycle_export_member_message_reminders").source;
    for (const column of ["source_ref", "snooze_count", "completed_at", "updated_at"]) expect(exporter).toContain(`t.${column}`);
  });

  it("binds consent to the organizer shown, and lets an attendee start a conversation only through the roster writer", () => {
    const optIn = byName("public.set_member_event_contact_opt_in").source;
    expect(flat).toContain("create function public.set_member_event_contact_opt_in( p_event_id text, p_opt_in boolean, p_expected_organizer_id uuid default null )");
    expect(optIn).toContain("p_expected_organizer_id is null");
    expect(optIn).toContain("ev.organizer_id is distinct from p_expected_organizer_id");
    expect(optIn).toContain("'organizer_changed'");
    expect(optIn).toContain("for share;");
    expect(optIn.indexOf("if not p_opt_in then")).toBeLessThan(optIn.indexOf("p_expected_organizer_id is null"));
    expect(tableBlock("private.member_event_contact_opt_ins")).toMatch(/organizer_id uuid not null/);
    expect(byName("private.cw_event_contact_ready").source).toContain("o.organizer_id = e.organizer_id");
    expect(byName("public.set_member_event_organizer").source).toContain("delete from private.member_event_contact_opt_ins where event_id = ev.id");
    // Initiation reuses the ordinary member -> roster steward writer and mirrors its exact predicate.
    const recipients = byName("private.cw_event_recipients").source;
    expect(recipients).toContain("private.member_roster_stewards_for_chapter(actor_chapter)");
    expect(recipients).toContain("'event_participant_start'");
    const send = byName("public.send_connected_workflow_message").source;
    expect(send).toContain("public.start_member_steward_conversation(rcpt, clean_body)");
    expect(send).toContain("candidate.rvia = 'event_participant_start'");
  });

  it("offers a task message its existing task and never creates another", () => {
    const create = byName("public.create_connected_workflow_task").source;
    expect(create).toContain("p_kind not in ('private_message', 'channel_post', 'event', 'task_message')");
    const branch = create.slice(create.indexOf("if p_kind = 'task_message' then"), create.indexOf("src_id := src ->> 'id';"));
    expect(branch).toContain("private.cw_task_readable(caller, task_row.id)");
    expect(branch).toContain("'created', false");
    expect(branch).not.toMatch(/insert\s+into/);
    const context = byName("public.get_connected_workflow_context").source;
    expect(context.slice(context.indexOf("if p_kind = 'task_message' then"))).toContain("private.cw_task_readable(caller, t.id)");
  });

  it("keeps legacy message reminders and dispatch untouched", () => {
    expect(flat).toContain("case when source_kind in ('task_item', 'event') then status <> 'pending' else status <> 'scheduled' end");
    const dispatcher = byName("private.dispatch_due_workflow_reminders").source;
    expect(dispatcher).toContain("pending.source_kind in ('task_item', 'event')");
    expect(dispatcher).toContain("pending.status = 'scheduled'");
    expect(dispatcher).toContain("for update skip locked");
    expect(dispatcher).toContain("exception when others then");
    expect(dispatcher).toContain("'Open your reminders to review it.'");
    // No legacy function, table policy or dispatcher is re-emitted or dropped here.
    for (const name of ["private.dispatch_due_member_messaging", "public.create_member_message_reminder", "public.create_chapter_task_from_source", "public.list_member_message_activity", "public.get_member_message_actions"]) {
      expect(functions.some((fn) => fn.name === name), name).toBe(false);
    }
    expect(flat).not.toMatch(/drop function|drop policy|drop table/);
    // Delivery rides the existing, already-mirrored minute job; no new cron job is scheduled.
    expect(flat).not.toContain("cron.schedule(");
    expect(flat).toContain("perform cron.alter_job( j.jobid, command := 'select private.dispatch_due_member_messaging(); select private.dispatch_due_workflow_reminders(200);') from cron.job j where j.jobname = 'member-messaging-dispatch';");
  });

  it("uses exact task ids in routes, refuses stale chapters, and copies no source text into titles", () => {
    expect(flat).not.toMatch(/'href', '\/m\/tasks\?task=' \|\| pg_catalog\.lower/);
    expect(flat.match(/'\/m\/tasks\?task=' \|\| [a-z_.]*id(::text)?/g)?.length).toBeGreaterThanOrEqual(4);
    const create = byName("public.create_connected_workflow_task").source;
    expect(create).toContain("src ->> 'chapterId' is distinct from caller_chapter");
    expect(create).toContain("'chapter_mismatch'");
    expect(create).toContain("private.member_has_chapter_role(");
    for (const title of ["Follow up on member message", "Follow up on message", "Follow up on channel post", "Follow up on event"]) expect(create).toContain(`'${title}'`);
    expect(codeOnly(create)).not.toMatch(/\b(msg|post_row|tmsg)\.body\b/);
    expect(flat).toContain("source_kind in ('message', 'broadcast', 'notification', 'survey', 'case', 'channel_post', 'event')");
  });

  it("binds a replay to source, recipient and payload, and serializes identical requests", () => {
    const send = byName("public.send_connected_workflow_message").source;
    expect(send).toContain("pg_catalog.hashtextextended('cw-send:' || caller::text || ':' || p_request_id::text, 509)");
    expect(send.indexOf("cw-send:")).toBeLessThan(send.indexOf("insert into public.organization_audit_ledger"));
    for (const field of ["'sourceKind'", "'sourceId'", "'userId'", "'payloadDigest'"]) expect(send).toContain(field);
    expect(send).toContain("'idempotency_conflict', '23505'");
    const digest = byName("private.cw_send_digest").source;
    for (const part of ["p_request::text", "p_kind", "p_source", "p_recipient::text", "p_body", "pg_catalog.sha256("]) expect(digest).toContain(part);
    expect(flat).toContain("'payloadDigest', 'sourceId', 'sourceKind']::text[]");
  });
});
