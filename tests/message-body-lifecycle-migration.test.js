// @vitest-environment node
//
// SEC-UG-MESSAGE-BODY-LIFECYCLE-20260904 (P0, repair-before-release).
//
// The record's verification is "assert body content disappears from reads,
// realtime, notifications, search, export, cache, and derived summaries". The
// design makes that assertable offline: the body is DESTROYED in the database
// rather than hidden behind a flag, so the property to prove is that there is
// exactly one destruction path, that every duplicate copy is swept by it, and
// that no projection can serve text that no longer exists.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { migrationFiles, stripComments } from "./helpers/migration.js";
import { MESSAGE_BODY_RETENTION, MESSAGE_REDACTION_REASONS } from "../src/features/messaging/index.js";

const read = (path) => readFileSync(resolve(process.cwd(), path), "utf8");
const migrations = migrationFiles();
const entry = migrations.find((file) => file.name === "20260907121000_member_message_body_lifecycle.sql");
const sql = stripComments(entry.sql).toLowerCase();

describe("member_messages gains a real body lifecycle", () => {
  it("adds the tombstone columns the record enumerates", () => {
    for (const column of ["redacted_at", "redacted_by", "redaction_reason", "body_sha256", "original_length"]) {
      expect(sql, `${column} missing`).toContain(`add column ${column}`);
    }
  });

  it("bounds the redaction reasons and exports the same list to the clients", () => {
    for (const reason of MESSAGE_REDACTION_REASONS) {
      expect(sql, `${reason} is not in the CHECK constraint`).toContain(`'${reason}'`);
    }
    expect(MESSAGE_REDACTION_REASONS).toContain("account_closed");
    expect(MESSAGE_REDACTION_REASONS).toContain("retention_expired");
  });

  it("makes the redacted state total: empty body plus complete tombstone, or neither", () => {
    // Without this there is a third state — a row that says redacted but still
    // carries text — and every reader would have to remember to check.
    expect(sql).toContain("add constraint member_messages_body_lifecycle");
    expect(sql).toContain("and body = ''");
    expect(sql).toContain("redacted_at is null");
    expect(sql).toContain("drop constraint member_messages_body_check");
  });

  it("retains a digest of the removed text and never the text", () => {
    expect(sql).toContain("body_sha256 = pg_catalog.encode(");
    expect(sql).toContain("extensions.digest(message_row.body, 'sha256')");
    // The removed body must not be copied into any audit value.
    expect(sql).not.toMatch(/'body',\s*message_row\.body/);
    expect(sql).not.toMatch(/metadata[^;]*message_row\.body/);
  });
});

describe("one destruction path, and it sweeps every duplicate", () => {
  it("puts the destruction in a single non-executable worker", () => {
    expect(sql).toContain("create function private.redact_member_message_row(");
    expect(sql).toContain("revoke all on function private.redact_member_message_row(uuid, text, uuid)");
  });

  it("sweeps the scheduled-message copy of the same body", () => {
    // member_scheduled_messages.body is a second durable plaintext copy that
    // survives dispatch next to sent_message_id. Redacting only the delivered
    // row would leave the text selectable by its sender.
    expect(sql).toContain("update public.member_scheduled_messages s");
    expect(sql).toContain("s.sent_message_id = message_row.id");
    expect(sql).toContain("add constraint member_scheduled_messages_body_lifecycle");
  });

  it("covers the draft that was never delivered, which no message redaction reaches", () => {
    // The sweep above keys on sent_message_id, so a pending, cancelled, failed
    // or orphaned draft has no delivered row to be redacted with. Without a
    // second path its plaintext body would survive any retention window.
    expect(sql).toContain("create function private.redact_member_scheduled_message_row(p_scheduled_id uuid)");
    expect(sql).toContain("revoke all on function private.redact_member_scheduled_message_row(uuid)");
    const worker = sql.slice(sql.indexOf("create function private.redact_member_scheduled_message_row("));
    // It refuses a dispatched draft, so the two paths can never both destroy
    // one body, and it refuses under a preservation order like every other path.
    expect(worker).toContain("if scheduled_row.sent_message_id is not null then");
    expect(worker).toContain("if private.member_message_under_legal_hold(scheduled_row.conversation_id) then");
    expect(worker).toContain("if scheduled_row.redacted_at is not null then");
  });

  it("refuses under a preservation order, from every caller", () => {
    expect(sql).toContain("create function private.member_message_under_legal_hold(");
    expect(sql).toContain("if private.member_message_under_legal_hold(message_row.conversation_id) then");
    expect(sql).toContain("conversation is under a preservation order");
  });

  it("is idempotent — a second redaction is a no-op, not a second digest", () => {
    expect(sql).toContain("if message_row.redacted_at is not null then");
    expect(sql).toContain("return false;");
  });
});

describe("who may remove what", () => {
  it("lets a member remove only messages the member sent", () => {
    expect(sql).toContain("if message_row.user_id = caller and message_row.sender_kind = 'member' then");
    expect(sql).toContain("reason := 'sender_removed';");
  });

  it("lets chapter staff remove content authored inside their own chapter", () => {
    expect(sql).toContain("public.member_has_role(array['steward', 'coordinator', 'admin'])");
    expect(sql).toContain("c.id = private.current_member_chapter()");
    expect(sql).toContain("reason := 'staff_removed';");
  });

  it("denies flatly, so an unauthorized caller cannot probe for message ids", () => {
    const body = sql.slice(sql.indexOf("create function public.redact_member_message("));
    expect(body).toContain("raise exception 'not permitted' using errcode = '42501'");
    expect(body).not.toContain("message not found");
  });

  it("requires an MFA-assured session", () => {
    expect(sql).toContain("if caller is null or not private.mfa_satisfied() then");
  });

  it("records the removal in the append-only tenant ledger without the body", () => {
    expect(sql).toContain("'message.redacted', 'delete'");
    expect(sql).toContain("pg_catalog.jsonb_build_object('reasoncode', reason, 'operation', 'redact', 'count', 1)");
  });
});

describe("legal hold", () => {
  it("is organization-admin only, MFA gated, and tenant scoped", () => {
    expect(sql).toContain("create table public.member_message_legal_holds");
    expect(sql).toContain("create function public.place_member_message_legal_hold(");
    expect(sql).toContain("create function public.release_member_message_legal_hold(");
    expect(sql).toContain("public.member_has_role(array['admin'])");
    expect(sql).toContain("conversation_org is distinct from org");
  });

  it("is read-only from the browser — writes go through the RPCs", () => {
    expect(sql).toContain("revoke all on table public.member_message_legal_holds");
    expect(sql).toContain("grant select on table public.member_message_legal_holds to authenticated");
    expect(sql).not.toMatch(/grant\s+(insert|update|delete)[^;]*member_message_legal_holds/);
  });

  it("carries a reason code and never message content", () => {
    expect(sql).toContain("reason_code text not null check (reason_code in (");
    expect(sql).not.toMatch(/member_message_legal_holds[^;]*body/);
  });

  it("ledgers both placement and release", () => {
    expect(sql).toContain("'message.legal_hold_placed'");
    expect(sql).toContain("'message.legal_hold_released'");
  });
});

describe("the retention engine classifies member_messages", () => {
  it("adds the class to both data_class vocabularies", () => {
    const occurrences = sql.split("'member_message_bodies'").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(6);
    expect(sql).toContain("drop constraint organization_retention_policies_data_class_check");
    expect(sql).toContain("drop constraint organization_retention_runs_data_class_check");
  });

  it("uses the recorded default window and bounds", () => {
    // The owner input, chosen under the best-practice mandate and recorded in
    expect(MESSAGE_BODY_RETENTION.defaultDays).toBe(1095);
    expect(MESSAGE_BODY_RETENTION.minimumDays).toBe(365);
    expect(MESSAGE_BODY_RETENTION.maximumDays).toBe(2555);
    expect(MESSAGE_BODY_RETENTION.operation).toBe("redact");
    expect(sql).toContain("'minimumdays', 365, 'maximumdays', 2555, 'defaultdays', 1095");
  });

  it("redacts through the shared worker instead of deleting message rows", () => {
    expect(sql).toContain("private.redact_member_message_row(candidate_id, 'retention_expired', run_row.authorized_by)");
    expect(sql).not.toMatch(/delete from public\.member_messages/);
  });

  it("never treats a held conversation as eligible, in the count or the run", () => {
    const eligible = sql.slice(sql.indexOf("create or replace function private.retention_eligible_count"));
    expect(eligible).toContain("not private.member_message_under_legal_hold(m.conversation_id)");
    const worker = sql.slice(sql.indexOf("create or replace function private.perform_organization_retention_run"));
    expect(worker).toContain("not private.member_message_under_legal_hold(m.conversation_id)");
  });

  it("keeps the batch cap and the organization scope the other classes have", () => {
    const worker = sql.slice(sql.indexOf("when 'member_message_bodies' then"));
    expect(worker).toContain("c.organization_id = run_row.organization_id");
    expect(worker).toContain("limit 5000");
  });

  it("sweeps undelivered drafts too, and counts exactly what it sweeps", () => {
    // A retention class that leaves one durable copy of the body behind is not
    // a retention class. The count and the run must agree, or 'remaining' would
    // never reach zero (count > sweep) or would claim a sweep that did not
    // happen (count < sweep).
    const worker = sql.slice(sql.indexOf("create or replace function private.perform_organization_retention_run"));
    expect(worker).toContain("private.redact_member_scheduled_message_row(candidate_id)");
    expect(worker).toContain("and s.sent_message_id is null");
    expect(worker).toContain("not private.member_message_under_legal_hold(s.conversation_id)");
    const eligible = sql.slice(
      sql.indexOf("create or replace function private.retention_eligible_count"),
      sql.indexOf("create or replace function private.perform_organization_retention_run"),
    );
    expect(eligible).toContain("from public.member_scheduled_messages s");
    expect(eligible).toContain("and s.sent_message_id is null");
    expect(eligible).toContain("not private.member_message_under_legal_hold(s.conversation_id)");
    // Both loops are bounded the same way.
    const branch = worker.slice(worker.indexOf("when 'member_message_bodies' then"));
    expect(branch.split("limit 5000").length - 1).toBe(2);
    // And the partial index that makes the draft scan cheap exists.
    expect(sql).toContain("create index member_scheduled_messages_retention_idx");
  });

  it("still records counts only, never removed content", () => {
    expect(sql).toContain("'deletedcount', removed");
    expect(sql).toContain("'operation', private.retention_data_class_config(run_row.data_class) ->> 'operation'");
  });
});

describe("every projection of a removed body", () => {
  const memberApi = read("src/lib/memberApi.js");
  const messagesView = read("src/views/MessagesView.jsx");
  const mobileSupabase = read("apps/mobile/src/services/supabase.ts");
  const conversationScreen = read("apps/mobile/app/conversation/[id].tsx");
  const notificationsDispatch = read("api/notifications-dispatch.js");

  it("reads: both clients render the tombstone, never the row's text", () => {
    expect(messagesView).toContain("projectMessageBody(message)");
    expect(messagesView).toContain("inbox-msg__redacted");
    expect(conversationScreen).toContain("isRedactedMessage({ redacted_at: message.redactedAt");
    expect(mobileSupabase).toContain("projectMessageBody(row)");
  });

  it("derived summaries: the conversation summary preview follows the redaction", () => {
    // public.member_conversation_summaries selects the latest body, so with the
    // text destroyed the view is correct by construction; the client still must
    // not fall back to a cached preview.
    expect(mobileSupabase).toContain("projectMessagePreview(latest).preview");
  });

  it("saved messages and reminders: previews come from the projection", () => {
    expect(memberApi).toContain("projectMessagePreview(row)");
    expect(memberApi).toContain("redacted: projected.redacted");
  });

  it("export: the member data export carries the tombstone, not the text", () => {
    const retirement = migrations.find((file) => file.name === "20260907122000_retire_dormant_channel_controls.sql");
    const exportSql = stripComments(retirement.sql).toLowerCase();
    expect(exportSql).toContain("create or replace function private.member_data_export_without_peer_contact()");
    expect(exportSql).toContain("'redactedat', m.redacted_at");
    expect(exportSql).toContain("'bodysha256', m.body_sha256");
  });

  it("realtime: member_messages is not published, so no payload can replay a body", () => {
    // The publication is INSERT-only and carries three tables, none of which is
    // member_messages. A redaction is an UPDATE and could not be broadcast even
    // if it were published.
    const publication = JSON.parse(read("scripts/db-contract.json")).publication;
    const tables = publication.tables.map((table) => table.table);
    expect(tables).not.toContain("member_messages");
    for (const table of publication.tables) {
      expect(table.update, `${table.table} publishes UPDATE`).toBe(false);
      expect(table.delete, `${table.table} publishes DELETE`).toBe(false);
    }
  });

  it("notifications: no notification row ever embeds a direct-message body", () => {
    const notificationInserts = migrations
      .flatMap((file) => stripComments(file.sql)
        .split(/insert into public\.member_notifications/i)
        .slice(1)
        .map((chunk) => ({ name: file.name, chunk: chunk.slice(0, 400) })));
    expect(notificationInserts.length).toBeGreaterThan(10);
    for (const { name, chunk } of notificationInserts) {
      expect(chunk, `${name} copies a member_messages body into a notification`)
        .not.toMatch(/\bm\.body\b|\bmessage_row\.body\b/);
    }
    // The dispatcher sends member_notifications rows and nothing else.
    expect(notificationsDispatch).not.toContain("member_messages");
  });

  it("search: the inbox filter searches only projected fields", () => {
    // Web search is client-side over the rows already rendered, so a redacted
    // row contributes an empty preview and cannot be found by its old text.
    expect(messagesView).toContain("`${item.title} ${item.preview} ${item.meta}`.toLowerCase().includes(lowered)");
  });

  it("cache: the client keeps no separate copy of a message body", () => {
    for (const path of ["public/sw.js", "src/lib/exactSessionStorage.js"]) {
      expect(read(path), `${path} caches message bodies`).not.toContain("member_messages");
    }
  });
});

describe("the message-body disposition contract", () => {
  // DECISION 2026-09-06: this stays a separate, messaging-scoped function and is
  // deliberately not a second account-lifecycle manifest.
  // BUG-UG-ACCOUNT-LIFECYCLE-REGRESSION owns private.account_lifecycle_manifest
  // and already registers both of these tables' deletion and export dispositions.
  // What this function adds is the part that table's columns cannot express and
  // that is meaningless outside messaging. These assertions are what stop it from
  // drifting back into a duplicate of that manifest.
  const contract = sql.slice(sql.indexOf("create function private.member_message_body_disposition()"));
  const body = contract.slice(0, contract.indexOf("$function$;", contract.indexOf("as $function$")));

  it("records only the messaging-specific facts, for exactly the two messaging tables", () => {
    expect(sql).toContain("create function private.member_message_body_disposition()");
    expect(body).toContain("'table', 'public.member_messages'");
    expect(body).toContain("'table', 'public.member_scheduled_messages'");
    expect(body).toContain("'retentiondataclass', 'member_message_bodies'");
    expect(body).toContain("'redactionfunction', 'private.redact_member_message_row'");
    expect(body).toContain("'redactionfunction', 'private.redact_member_scheduled_message_row'");
    expect(body).toContain("'legalholdtable', 'public.member_message_legal_holds'");
    expect(body.split("'table',").length - 1).toBe(2);
  });

  it("carries no deletion or export disposition, because another record owns those", () => {
    for (const key of ["onaccountdeletion", "cascadevia", "exportedby", "exportdisposition"]) {
      expect(body, `${key} duplicates private.account_lifecycle_manifest`).not.toContain(key);
    }
    // And it must never define a manifest of its own.
    expect(sql).not.toContain("create table private.account_lifecycle_manifest");
  });
});

describe("outer lifecycle entries retain the original behavior after taking the gate", () => {
  const raw = entry.sql;
  for (const [file, name] of [
    ["20260812200000_unified_messaging_restoration.sql", "private.dispatch_due_member_messaging"],
    ["20260830180000_mi1_retention_engine.sql", "private.run_due_organization_retention_jobs"],
    ["20260830180000_mi1_retention_engine.sql", "private.assert_retention_admin"],
    ["20260828034122_member_engagement_completion.sql", "public.decide_compass_workspace_action"],
  ]) it(name, () => {
    function definition(source, prefix) {
      const tail = source.slice(source.indexOf(`${prefix}${name}(`));
      const begin = tail.indexOf("\nbegin\n");
      const delimiter = tail.slice(0, begin).includes("as $function$") ? "$function$" : "$$";
      return tail.slice(0, tail.indexOf(`\n${delimiter};`, begin) + delimiter.length + 2);
    }
    const original = definition(read(`supabase/migrations/${file}`), "create function ");
    const expected = original.replace("create function ", "create or replace function ")
      .replace("\nbegin\n", "\nbegin\n  perform private.lock_message_lifecycle();\n");
    expect(definition(raw, "create or replace function ")).toBe(expected);
  });
});
