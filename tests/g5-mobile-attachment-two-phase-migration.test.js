// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("g5_mobile_attachment_two_phase");
const code = stripComments(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

const functionContract = (sig) => contract.functions.find((entry) => entry.sig === sig);

describe("G5 mobile attachment two-phase schema", () => {
  it("backfills legacy rows but leaves caller-minted begin rows pending", () => {
    expect(code).toMatch(/alter table public\.member_case_files\s+add column if not exists confirmed_at timestamptz/i);
    expect(code).toMatch(/alter table public\.chapter_task_files\s+add column if not exists confirmed_at timestamptz/i);
    expect(code).toMatch(/update public\.member_case_files set confirmed_at = created_at where confirmed_at is null/i);
    expect(code).toMatch(/update public\.chapter_task_files set confirmed_at = created_at where confirmed_at is null/i);
    expect(fnBody(sql, "public.begin_member_case_file_upload")).toContain("p_file_id");
    expect(fnBody(sql, "public.begin_chapter_task_file_upload")).toContain("p_file_id");
    expect(fnBody(sql, "public.begin_member_case_file_upload")).toContain("confirmed_at");
    expect(fnBody(sql, "public.begin_chapter_task_file_upload")).toContain("confirmed_at");
  });

  it("tombstones confirmed removals under a caller-owned idempotency key", () => {
    for (const column of ["removal_id uuid", "removal_requested_at timestamptz", "removal_requested_by uuid"]) {
      expect(code).toContain(column);
    }
    for (const name of [
      "public.request_member_case_file_removal",
      "public.request_chapter_task_file_removal",
      "public.finalize_member_case_file_removal",
      "public.finalize_chapter_task_file_removal",
    ]) {
      expect(code).toContain(`function ${name}`);
      if (!code.includes(`function ${name}`)) continue;
      const body = stripComments(fnBody(sql, name));
      expect(body).toContain("p_removal_id");
      expect(body).toContain("private.mfa_satisfied()");
      expect(body).not.toMatch(/delete\s+from\s+storage\.objects/i);
    }

    for (const name of [
      "public.request_member_case_file_removal",
      "public.request_chapter_task_file_removal",
    ]) {
      if (!code.includes(`function ${name}`)) continue;
      const body = stripComments(fnBody(sql, name));
      expect(body).toContain("for update");
      expect(body).toContain("removal_id = p_removal_id");
      expect(body).toContain("removal_requested_at = now()");
      expect(body).toContain("removal_requested_by = caller");
    }

    for (const name of [
      "public.finalize_member_case_file_removal",
      "public.finalize_chapter_task_file_removal",
    ]) {
      if (!code.includes(`function ${name}`)) continue;
      const body = stripComments(fnBody(sql, name));
      expect(body).toContain("removal_id = p_removal_id");
      expect(body).toContain("storage.objects");
      expect(body).toContain("'absent', true");
      expect(body).toContain("'removalId', p_removal_id");
    }
  });

  it("returns absence only from an exact caller-bound removal receipt", () => {
    expect(code).toContain("create table private.attachment_removal_receipts");
    expect(code).toContain("primary key (file_kind, file_id, removal_id, requested_by)");
    expect(code).toContain("check (file_kind in ('member_case', 'chapter_task'))");
    expect(code).toContain("attachment_removal_receipts_deleted_at_idx");
    expect(code).toContain("revoke all on private.attachment_removal_receipts");
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(contract.tableGrants).toContainEqual(expect.objectContaining({
        table: "private.attachment_removal_receipts",
        role,
        privileges: "",
      }));
    }
    expect(contract.constraints).toContainEqual(expect.objectContaining({
      table: "private.attachment_removal_receipts",
      name: "attachment_removal_receipts_pkey",
    }));
    expect(contract.constraints).toContainEqual(expect.objectContaining({
      table: "private.attachment_removal_receipts",
      name: "attachment_removal_receipts_file_kind_check",
    }));
    expect(contract.indexes).toContainEqual(expect.objectContaining({
      table: "private.attachment_removal_receipts",
      name: "attachment_removal_receipts_deleted_at_idx",
    }));

    const expectations = [
      ["public.request_member_case_file_removal", "member_case", "public.member_case_files"],
      ["public.finalize_member_case_file_removal", "member_case", "public.member_case_files"],
      ["public.request_chapter_task_file_removal", "chapter_task", "public.chapter_task_files"],
      ["public.finalize_chapter_task_file_removal", "chapter_task", "public.chapter_task_files"],
    ];
    for (const [name, kind, sourceTable] of expectations) {
      const body = stripComments(fnBody(sql, name));
      expect(body).toContain("private.attachment_removal_receipts");
      expect(body).toContain(`file_kind = '${kind}'`);
      expect(body).toContain("file_id = p_file_id");
      expect(body).toContain("removal_id = p_removal_id");
      expect(body).toContain("requested_by = caller");
      expect(body).toContain("raise exception 'file unavailable'");
      expect(body).not.toContain(`if exists (select 1 from ${sourceTable} f where f.id = p_file_id)`);
    }

    for (const name of [
      "public.finalize_member_case_file_removal",
      "public.finalize_chapter_task_file_removal",
    ]) {
      const body = stripComments(fnBody(sql, name));
      expect(body).toContain("insert into private.attachment_removal_receipts");
      expect(body).toContain("on conflict (file_kind, file_id, removal_id, requested_by) do update");
      expect(body.indexOf("insert into private.attachment_removal_receipts"))
        .toBeLessThan(body.indexOf("delete from public."));
    }
  });

  it("confirms only an exact stored object under fresh MFA and target authorization", () => {
    for (const name of ["public.confirm_member_case_file_upload", "public.confirm_chapter_task_file_upload"]) {
      const body = stripComments(fnBody(sql, name));
      expect(body).toContain("private.mfa_satisfied()");
      expect(body).toContain("storage.objects");
      expect(body).toContain("o.bucket_id = file_row.bucket_id");
      expect(body).toContain("o.name = file_row.object_name");
      expect(body).toContain("o.metadata ->> 'mimetype'");
      expect(body).toContain("o.metadata ->> 'size'");
      expect(body).toContain("confirmed_at = coalesce(confirmed_at, now())");
    }
    const taskConfirm = stripComments(fnBody(sql, "public.confirm_chapter_task_file_upload"));
    expect(taskConfirm).toContain("'file_added'");
    expect(taskConfirm).toContain("if file_row.confirmed_at is null then");
  });

  it("retires an absent pending row or queues its exact object for service-owned cleanup", () => {
    for (const [name, sourceTable] of [
      ["public.abort_member_case_file_upload", "public.member_case_files"],
      ["public.abort_chapter_task_file_upload", "public.chapter_task_files"],
    ]) {
      const body = stripComments(fnBody(sql, name));
      expect(body).toContain("uploaded_by = caller");
      expect(body).toContain("confirmed_at is null");
      expect(body).toContain("not exists");
      expect(body).toContain("storage.objects");
      expect(body).toContain("cleanup_requested_at = coalesce(cleanup_requested_at, now())");
      expect(body).toContain("'cleanupQueued', true");
      expect(body).toContain("'cleanupRequestedAt', file_row.cleanup_requested_at");
      expect(body).toContain("'deleted', false, 'absent', true, 'id', p_file_id");
      expect(body).not.toContain(`if exists (select 1 from ${sourceTable} f where f.id = p_file_id)`);
      expect(body).not.toMatch(/delete\s+from\s+storage\.objects/i);
    }
  });

  it("hides pending rows and bytes", () => {
    expect(code).toContain("chapter_task_files.confirmed_at is not null");
    expect(code).toContain("member_case_files.confirmed_at is not null");
    expect(stripComments(fnBody(sql, "private.can_read_chapter_task_object"))).toContain("f.confirmed_at is not null");
    expect(stripComments(fnBody(sql, "private.can_read_member_case_object"))).toContain("f.confirmed_at is not null");

    const taskPolicy = contract.policies.find((entry) => (
      entry.table === "chapter_task_files" && entry.name === "chapter_task_files_select_board"
    ));
    const commentPolicy = contract.policies.find((entry) => (
      entry.table === "chapter_task_comments" && entry.name === "chapter_task_comments_select_board"
    ));
    expect(taskPolicy?.qualContains).toContain("confirmed_at IS NOT NULL");
    expect(commentPolicy?.qualContains).not.toContain("confirmed_at IS NOT NULL");
  });

  it("hides tombstoned metadata and bytes from list and open paths", () => {
    expect(code).toContain("member_case_files.removal_requested_at is null");
    expect(code).toContain("chapter_task_files.removal_requested_at is null");
    expect(stripComments(fnBody(sql, "private.can_read_member_case_object")))
      .toContain("f.removal_requested_at is null");
    expect(stripComments(fnBody(sql, "private.can_read_chapter_task_object")))
      .toContain("f.removal_requested_at is null");
  });

  it("keeps authenticated Storage deletion on readable legacy rows only", () => {
    const taskInsert = stripComments(fnBody(sql, "private.can_write_chapter_task_object"));
    const taskDelete = stripComments(fnBody(sql, "private.can_delete_chapter_task_object"));
    const caseInsert = stripComments(fnBody(sql, "private.can_write_member_case_object"));
    const caseDelete = stripComments(fnBody(sql, "private.can_delete_member_case_object"));

    expect(taskInsert).toContain("f.uploaded_by = (select auth.uid())");
    expect(taskInsert).toContain("t.deleted_at is null");
    expect(taskInsert).toContain("t.chapter_id = f.chapter_id");
    expect(taskInsert).toContain("member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])");
    expect(caseInsert).toContain("public.staff_can_see_user");
    expect(caseInsert).toContain("f.user_id = (select auth.uid())");

    expect(taskDelete).toContain("f.confirmed_at is not null");
    expect(taskDelete).toContain("f.removal_requested_at is null");
    expect(taskDelete).toContain("p.chapter_id = t.chapter_id");
    expect(taskDelete).toContain("chapter_tasks");
    expect(taskDelete).not.toContain("f.uploaded_by = (select auth.uid())");
    expect(taskDelete).not.toContain("f.removal_id is not null");
    expect(caseDelete).toContain("f.confirmed_at is not null");
    expect(caseDelete).toContain("f.removal_requested_at is null");
    expect(caseDelete).not.toContain("f.uploaded_by = (select auth.uid())");
    expect(caseDelete).not.toContain("f.removal_id is not null");
    expect(code).toContain("private.can_delete_chapter_task_object(bucket_id, name)");
    expect(code).toContain("private.can_delete_member_case_object(bucket_id, name)");
  });

  it("keeps immediately-confirmed legacy rows uploadable only through fresh live authorization", () => {
    const legacyTask = stripComments(fnBody(sql, "public.register_chapter_task_file"));
    const legacyCase = stripComments(fnBody(sql, "public.register_member_case_file"));
    expect(legacyTask).toContain("caller, now()");
    expect(legacyCase).toContain("caller, now()");
    expect(stripComments(fnBody(sql, "private.can_write_chapter_task_object"))).toContain("f.confirmed_at is not null");
    expect(stripComments(fnBody(sql, "private.can_write_member_case_object"))).toContain("f.confirmed_at is not null");
  });

  it("refuses metadata removal while the exact Storage object still exists", () => {
    for (const name of ["public.remove_member_case_file", "public.remove_chapter_task_file"]) {
      const body = stripComments(fnBody(sql, name));
      expect(body).toContain("storage.objects");
      expect(body).toContain("o.bucket_id = file_row.bucket_id");
      expect(body).toContain("o.name = file_row.object_name");
      expect(body).toContain("uploaded object still exists");
      expect(body).not.toMatch(/delete\s+from\s+storage\.objects/i);
    }
  });
});

describe("G5 attachment reconciliation", () => {
  const body = stripComments(fnBody(sql, "public.reconcile_chapter_task_files"));

  it("covers pending and orphan objects in both private buckets without SQL byte deletion", () => {
    expect(body).toContain("public.member_case_files");
    expect(body).toContain("public.chapter_task_files");
    expect(body).toContain("'case-files'");
    expect(body).toContain("'chapter-task-files'");
    expect(body).toContain("interval '24 hours'");
    expect(body).toContain("'objectDeletes'");
    expect(body).not.toMatch(/delete\s+from\s+storage\.objects/i);
  });

  it("atomically claims stale pending metadata before returning its exact object", () => {
    expect(body).toContain("claimed_case_pending");
    expect(body).toContain("claimed_task_pending");
    expect(body).toContain("update public.member_case_files f");
    expect(body).toContain("update public.chapter_task_files f");
    expect(body).toContain("cleanup_requested_at = coalesce(f.cleanup_requested_at, now())");
    expect(body).toContain("f.confirmed_at is null");
    expect(body).toContain("o.created_at < now() - interval '1 hour'");
    expect(body.indexOf("claimed_case_pending")).toBeLessThan(body.indexOf("'objectDeletes'"));
    expect(body).toContain("f.cleanup_requested_at is not null");
  });

  it("retires service-cleaned pending rows immediately instead of waiting for the 24-hour orphan grace", () => {
    expect(body).toMatch(/where f\.removal_requested_at is null\s+and \(\s*f\.cleanup_requested_at is not null\s+or f\.created_at < now\(\) - interval '24 hours'\s*\)\s+and not exists/);
  });

  it("reports which exact post-delete targets still exist", () => {
    expect(body).toContain("p_expected_deleted_objects jsonb default '[]'::jsonb");
    expect(body).toContain("jsonb_array_elements(expected_deleted_objects)");
    expect(body).toContain("coalesce(target.value ->> 'bucketId', '') not in");
    expect(body).toContain("expected_objects_remaining");
    expect(body).toContain("o.bucket_id = expected.bucket_id");
    expect(body).toContain("o.name = expected.object_name");
    expect(body).toContain("'expectedObjectsRemaining'");
  });

  it("bounds tombstone completion for both buckets through exact Storage targets", () => {
    expect(body).toContain("f.removal_requested_at is not null");
    expect(body).toContain("interval '15 minutes'");
    expect(body).toContain("removalRowsRetired");
    expect(body).toContain("removalObjectTotal");
    expect(body).toContain("removal_requested_by");
    expect(body.match(/f\.removal_id is not null/g)).toHaveLength(2);
    expect(body).toContain("'file_removed'");
    expect(body).toContain("limit object_cap");
    expect(body).toContain("retired_case_removal_candidates");
    expect(body).toContain("retired_task_removal_candidates");
    expect(body).toContain("limit 500");
  });

  it("records caller-bound receipts before the service retires removal rows", () => {
    expect(body).toContain("insert into private.attachment_removal_receipts");
    expect(body).toContain("'member_case', candidate.id, candidate.removal_id, candidate.removal_requested_by");
    expect(body).toContain("'chapter_task', candidate.id, candidate.removal_id, candidate.removal_requested_by");
    expect(body).toContain("recorded_case_removal_receipts");
    expect(body).toContain("recorded_task_removal_receipts");
    expect(body.match(/on conflict \(file_kind, file_id, removal_id, requested_by\) do update/g)).toHaveLength(2);
    expect(body).toContain("receipt.file_id = candidate.id");
    expect(body).toContain("deleted_at < now() - interval '30 days'");
  });

  it("contracts every new client RPC and keeps reconciliation service-only", () => {
    for (const sig of [
      "public.begin_member_case_file_upload(p_file_id uuid, p_case_id uuid, p_filename text, p_mime_type text, p_size_bytes bigint)",
      "public.confirm_member_case_file_upload(p_file_id uuid)",
      "public.abort_member_case_file_upload(p_file_id uuid)",
      "public.begin_chapter_task_file_upload(p_file_id uuid, p_task_id uuid, p_filename text, p_mime_type text, p_size_bytes bigint)",
      "public.confirm_chapter_task_file_upload(p_file_id uuid)",
      "public.abort_chapter_task_file_upload(p_file_id uuid)",
      "public.request_member_case_file_removal(p_file_id uuid, p_removal_id uuid)",
      "public.finalize_member_case_file_removal(p_file_id uuid, p_removal_id uuid)",
      "public.request_chapter_task_file_removal(p_file_id uuid, p_removal_id uuid)",
      "public.finalize_chapter_task_file_removal(p_file_id uuid, p_removal_id uuid)",
    ]) {
      expect(functionContract(sig)?.exec).toBe("authenticated");
    }
    expect(functionContract("public.reconcile_chapter_task_files(p_max_orphan_objects integer, p_expected_deleted_objects jsonb)")?.exec).toBe("service_role");
    expect(functionContract("private.can_delete_member_case_object(p_bucket text, p_name text)")?.exec).toBe("authenticated");
    expect(functionContract("private.can_delete_chapter_task_object(p_bucket text, p_name text)")?.exec).toBe("authenticated");
  });
});
