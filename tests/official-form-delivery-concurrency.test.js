// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("form_filing_concurrency");
const code = stripComments(sql).replace(/\s+/g, " ");
const body = (name) => stripComments(fnBody(sql, name)).replace(/\s+/g, " ");

describe("official form concurrency repair", () => {
  it.each(["invite_cosigner", "respond_to_cosign", "withdraw_cosign", "approve_form"])(
    "serializes %s on the one canonical form lock before reading status",
    (name) => {
      const source = body(name);
      const lockAt = source.indexOf("private.lock_member_form(p_form_id)");
      const statusAt = source.search(/from public\.member_forms|join public\.member_forms/);
      expect(lockAt).toBeGreaterThan(-1);
      expect(statusAt).toBeGreaterThan(lockAt);
    },
  );

  it("prevents every filing child from changing after approval", () => {
    expect(code).toContain("create trigger member_form_cosigners_parent_mutable");
    expect(code).toContain("create trigger member_form_signatures_parent_mutable");
    expect(code).toContain("create trigger member_form_files_parent_mutable");
    const guard = body("private.enforce_member_form_child_mutability");
    expect(guard).toContain("private.lock_member_form(form_id)");
    expect(guard).toContain("old.form_id <> new.form_id");
    expect(guard).toContain("filing children cannot move between forms");
    expect(guard).toContain("status = 'approved'");
    expect(guard).toContain("approved filing children are immutable");
  });

  it("uses a server-authorized deletion tombstone before Storage API deletion", () => {
    expect(code).toContain("deletion_requested_at timestamptz");
    expect(code).toContain("deletion_requested_by uuid");
    const request = body("request_member_form_file_removal");
    expect(request).toContain("private.lock_member_form(form_id)");
    expect(request).toContain("set deletion_requested_at = now()");
    expect(request).toContain("deletion_requested_by = caller");
    const finalize = body("finalize_member_form_file_removal");
    expect(finalize).toContain("deletion_requested_by = caller");
    expect(finalize).toContain("from storage.objects");
    expect(finalize).toContain("attachment bytes still exist");
    expect(finalize).toContain("delete from public.member_form_files");
    expect(code).toMatch(/create policy member_form_files_storage_insert[^;]+not private\.can_delete_member_form_object/);
    expect(code).toContain("create policy member_form_files_storage_delete");
    expect(code).toContain("private.can_delete_member_form_object(bucket_id, name)");
  });

  it.each(["sign_member_form", "submit_form", "approve_form"])(
    "%s rejects a pending attachment deletion",
    (name) => expect(body(name)).toContain("deletion_requested_at is not null"),
  );

  it("retires the unsafe one-phase metadata deletion RPC", () => {
    expect(code).toContain("drop function if exists public.remove_member_form_file(uuid)");
    expect(code).toContain("revoke all on function public.request_member_form_file_removal(uuid) from public, anon");
    expect(code).toContain("revoke all on function public.finalize_member_form_file_removal(uuid) from public, anon");
  });
});
