// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("official_form_delivery");
const code = stripComments(sql).replace(/\s+/g, " ");
// submit_form, approve_form and the two filing readers were re-issued with
// private-upload gates in 20260906020000. This file keeps pinning the original
// statements (frozen by the forward-only rule) and pins the gates where they
// were actually added, so a removed gate cannot hide behind a stale pin.
const gatesSql = loadMigrationSql("20260906020000_private_upload_workflow_gates");

describe("official form delivery migration (UB-FORM-02/05)", () => {
  it("keeps signature strokes behind a server-only boundary", () => {
    expect(code).toContain("create table private.member_form_signatures");
    expect(code).toContain("revoke all on table private.member_form_signatures from public, anon, authenticated, service_role");
    expect(code).not.toMatch(/grant select[^;]+member_form_signatures/);
    expect(code).toContain("signature_digest text");
    expect(code).toContain("content_digest text");
    expect(code).toContain("signer_user_id uuid references auth.users(id) on delete set null");
    expect(code).toContain("signer_kind = 'filer' and cosigner_id is null and signer_user_id is not null");
    expect(code).toContain("unique (cosigner_id)");
  });

  it("validates and binds a filer's own signature to current content", () => {
    const body = fnBody(sql, "sign_member_form");
    expect(body).toContain("private.mfa_satisfied()");
    expect(body).toContain("rec.user_id <> caller");
    expect(body).toContain("private.validate_form_signature_strokes(p_strokes)");
    expect(body).toContain("private.form_content_digest(p_form_id)");
    expect(body).toContain("p_consent is distinct from true");
    expect(body).toContain("on conflict (form_id, signer_kind, signer_user_id)");
  });

  it("requires the invitee's explicit signature only when accepting", () => {
    const body = fnBody(sql, "respond_to_cosign");
    expect(body).toContain("private.mfa_satisfied()");
    expect(body).toContain("p_accept and p_consent is distinct from true");
    expect(body).toContain("private.validate_form_signature_strokes(p_strokes)");
    expect(body).toContain("c.cosigner_user_id = caller");
    expect(body).toContain("caller_email <> '' and c.invited_email = caller_email");
    expect(code).toContain("drop function if exists public.respond_to_cosign(uuid, boolean)");
  });

  it("invalidates signatures when answers or the attachment manifest changes", () => {
    const save = fnBody(sql, "save_form_draft");
    expect(save).toContain("delete from private.member_form_signatures where form_id = existing");
    expect(save).toContain("status='reaffirm_needed'");
    for (const name of ["register_member_form_file", "remove_member_form_file"]) {
      const body = fnBody(sql, name);
      expect(body).toContain("private.invalidate_member_form_signatures");
    }
    const invalidate = fnBody(sql, "private.invalidate_member_form_signatures");
    expect(invalidate).toContain("delete from private.member_form_signatures");
    expect(invalidate).toContain("status = 'reaffirm_needed'");
  });

  it("enforces a private register/upload/confirm attachment boundary", () => {
    expect(code).toContain("'member-form-files'");
    expect(code).toContain("false, 10485760");
    expect(code).toContain("create table public.member_form_files");
    expect(code).toMatch(/count\(\*\)[^;]+>= 20/);
    expect(code).toContain("p_size_bytes, 0) not between 1 and 10485760");
    expect(code).toContain("grant select on table public.member_form_files to authenticated");
    expect(code).not.toMatch(/grant\s+(insert|update|delete)[^;]*member_form_files/);
    for (const name of ["can_read_member_form_object", "can_write_member_form_object"]) {
      const body = fnBody(sql, `private.${name}`);
      expect(body).toContain("security definer");
      expect(code).toContain(`revoke all on function private.${name}(text, text) from public, anon, authenticated`);
    }
    expect(code).toMatch(/create policy member_form_files_storage_insert[^;]+private\.can_write_member_form_object/);
    expect(code).toMatch(/create policy member_form_files_storage_read[^;]+private\.can_read_member_form_object/);
  });

  it("refuses unsigned or upload-in-flight submit before mutation", () => {
    const body = fnBody(sql, "submit_form");
    expect(body).toContain("private.mfa_satisfied()");
    expect(body).toContain("confirmed_at is null");
    expect(body).toContain("signer_kind = 'filer'");
    expect(body).toContain("content_digest <> current_digest");
    expect(body.indexOf("confirmed_at is null")).toBeLessThan(body.indexOf("set status='submitted'"));
  });

  it("rechecks steward scope and freezes a revalidated approval artifact", () => {
    const body = fnBody(sql, "approve_form");
    expect(body).toContain("member_has_role(array['steward'])");
    expect(body).toContain("staff_can_see_user(rec.user_id, 'steward')");
    expect(body).toContain("rec.user_id = caller");
    expect(body).toContain("signature.content_digest <> current_digest");
    expect(body).toContain("artifact_digest");
    expect(body).toContain("artifact_approved_at");
    expect(code).toContain("create trigger member_forms_approved_immutable");
  });

  it("is superseded by the workflow-gate migration for unscanned attachments", () => {
    const gate = (name) => fnBody(gatesSql, name);
    const submit = gate("public.submit_form");
    expect(submit).toContain("not private.private_upload_is_current(ff.bucket_id, ff.object_name)");
    expect(submit).toContain("wait for every attachment inspection to finish");
    // The gate must run before the content digest freezes the manifest.
    expect(submit.indexOf("wait for every attachment inspection to finish"))
      .toBeLessThan(submit.indexOf("private.form_content_digest(p_form_id)"));
    const approve = gate("public.approve_form");
    expect(approve).toContain("form has an attachment without a current inspection");
    expect(approve.indexOf("form has an attachment without a current inspection"))
      .toBeLessThan(approve.indexOf("private.form_artifact_digest"));
    expect(gate("public.get_form_filing_status"))
      .toContain("'scanCurrent', private.private_upload_is_current(ff.bucket_id, ff.object_name)");
    const payload = gate("public.get_form_filing_payload");
    expect(payload).toContain("not private.private_upload_is_current(ff.bucket_id, ff.object_name)");
    expect(payload).toContain("and private.private_upload_is_current(ff.bucket_id, ff.object_name)");
    expect(gate("public.confirm_member_form_file"))
      .toContain("private.private_upload_is_current(rec.bucket_id, rec.object_name)");
  });

  it("publishes safe status and a service-only filing payload", () => {
    const status = fnBody(sql, "get_form_filing_status");
    expect(status).toContain("form_is_owned_by_caller(p_form_id)");
    expect(status).toContain("staff_can_see_user");
    expect(status).not.toContain("strokes");

    const authorize = fnBody(sql, "can_access_form_filing");
    expect(authorize).toContain("status = 'approved'");
    expect(authorize).toContain("private.mfa_satisfied()");

    const payload = fnBody(sql, "get_form_filing_payload");
    expect(payload).toContain("auth.role()) <> 'service_role'");
    expect(payload).toContain("member_form_signatures");
    expect(payload).toContain("p_user_id is not null");
    expect(payload).toContain("f.user_id = p_user_id");
    expect(payload).toContain("r.user_id = p_user_id");
    expect(payload).toContain("r.role = 'steward'");
    expect(payload).toContain("r.chapter_id is null");
    expect(payload).toContain("r.chapter_id = p.chapter_id");
    expect(payload).toContain("private.form_content_digest(p_form_id)");
    expect(payload).toContain("private.form_signature_digest");
    expect(payload).toContain("private.form_artifact_digest");
    expect(payload).toContain("s.cosigner_id = c.id");
    expect(payload).toContain("s.signature_digest = c.signature_digest");
    expect(payload).toContain("s.content_digest = current_digest");
    expect(payload).not.toContain("cp.full_name");
    expect(code).toContain("drop function if exists public.get_form_filing_payload(uuid)");
    expect(code).toContain("revoke all on function public.get_form_filing_payload(uuid, uuid) from public, anon, authenticated");
    expect(code).toContain("grant execute on function public.get_form_filing_payload(uuid, uuid) to service_role");
  });
});
