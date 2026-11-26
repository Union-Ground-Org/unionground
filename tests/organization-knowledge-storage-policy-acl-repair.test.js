// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("20260901043000_organization_knowledge_storage_policy_acl_repair");
const code = stripComments(sql);
const gatesSql = loadMigrationSql("20260906020000_private_upload_workflow_gates");
const repairSql = loadMigrationSql("20260906021000_private_upload_gate_repairs");

function body(name) {
  return stripComments(fnBody(sql, name)).toLowerCase();
}

const helpers = [
  "can_insert_organization_knowledge_object",
  "can_read_organization_knowledge_object",
  "can_delete_organization_knowledge_object",
];

describe("organization knowledge storage policy ACL repair", () => {
  it("bounds lock acquisition and indexes the load-bearing object lookup", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toContain("set local lock_timeout = '5s'");
    expect(code).toContain("drop index if exists public.organization_knowledge_files_storage_path_key");
    expect(code).toContain("create unique index organization_knowledge_files_storage_path_key\n  on public.organization_knowledge_files (storage_path)\n  where storage_path <> 'pending'");
    expect(code).toMatch(/commit;\s*$/);
  });

  it("moves protected-table reads behind narrow SECURITY DEFINER helpers", () => {
    for (const helper of helpers) {
      const helperBody = body(`private.${helper}`);
      expect(helperBody).toContain("security definer");
      expect(helperBody).toContain("set search_path = ''");
      expect(helperBody).toContain("p_bucket_id is distinct from 'organization-knowledge' then false");
      expect(helperBody).toContain("private.mfa_satisfied()");
      expect(helperBody).toContain("private.current_member_organization() is null then false");
      expect(helperBody).toContain("from public.organization_knowledge_files file");
      expect(code).toContain(`revoke all on function private.${helper}(text, text)\n  from public, anon, authenticated, service_role`);
      expect(code).toContain(`grant execute on function private.${helper}(text, text)\n  to authenticated`);
    }

    const insert = body("private.can_insert_organization_knowledge_object");
    expect(insert).toContain("file.created_by = (select auth.uid())");
    expect(insert).toContain("file.organization_id = private.mi1_w2_selected_organization()");
    expect(insert).toContain("file.review_status = 'pending_scan'");
    expect(body("private.can_read_organization_knowledge_object")).toContain("file.published_to_catalog");
    // This revision's member branch trusted organization_knowledge_files
    // .scan_status, a flag the text-extraction worker wrote unconditionally.
    // 20260906020000 replaces it with the private_upload_scans ledger; the pin
    // for the live shape is in the "supersedes" case below and in db-contract.
    expect(body("private.can_read_organization_knowledge_object")).toContain("file.scan_status = 'clean'");
    const remove = body("private.can_delete_organization_knowledge_object");
    expect(remove).toContain("file.created_by = (select auth.uid())");
    expect(remove).toContain("file.organization_id = private.mi1_w2_selected_organization()");
    expect(remove).toContain("file.review_status = 'pending_scan'");
    expect(remove).toContain("file.scan_status = 'pending'");
  });

  it("is superseded by the workflow-gate migration for the member read branch", () => {
    // 20260906020000 swapped scan_status for the ledger here. 20260906021000
    // then removed the ledger conjunct outright: this helper is ALSO the
    // knowledge-kind ACL inside authorize_private_upload_inspection, so a
    // verdict clause on either branch denies the inspection that renews the
    // verdict — permanently for a plain member, whose clean_until lapses within
    // 24 hours by design. Neither branch may carry one.
    const superseded = stripComments(fnBody(gatesSql, "private.can_read_organization_knowledge_object")).toLowerCase();
    expect(superseded).not.toContain("scan_status");
    const read = stripComments(fnBody(repairSql, "private.can_read_organization_knowledge_object")).toLowerCase();
    expect(read).not.toContain("scan_status");
    expect(read).not.toContain("private_upload_is_current");
    expect(read).toContain("file.published_to_catalog");
    expect(read).toContain("file.review_status = 'approved'");
    // The staff branch has never carried a verdict clause, for the same reason:
    // gating it would make a pending upload permanently un-inspectable. Reads
    // stay bound by the restrictive private_upload_quarantine_read policy,
    // which evaluates private_upload_is_current on every authenticated GET.
    expect(read).toContain("private.has_organization_role(");
    const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
    const entry = contract.functions.find((candidate) => (
      candidate.sig === "private.can_read_organization_knowledge_object(p_bucket_id text, p_name text)"
    ));
    expect(entry?.bodyContains).not.toContain("private.private_upload_is_current('organization-knowledge', file.storage_path)");
    expect(entry?.bodyContains).not.toContain("file.scan_status = 'clean'");
    expect(entry?.bodyForbids).toContain("private_upload_is_current");
    expect(entry?.bodyMd5).toBeTruthy();
  });

  it("keys the uploader's own cleanup window on ingest state once scan_status retires", () => {
    // scan_status = 'pending' is now permanently true, so it bounded nothing.
    // index_status = 'pending' is the same window the old conjunct expressed and
    // closes on both ingest outcomes (chunked / failed).
    const remove = stripComments(fnBody(repairSql, "private.can_delete_organization_knowledge_object")).toLowerCase();
    expect(remove).toContain("file.review_status = 'pending_scan'");
    expect(remove).toContain("file.index_status = 'pending'");
    expect(remove).not.toContain("scan_status");
    expect(remove).not.toContain("private_upload_is_current");
    const cancel = stripComments(fnBody(repairSql, "public.cancel_steward_library_upload")).toLowerCase();
    expect(cancel).toContain("file.review_status = 'pending_scan'");
    expect(cancel).toContain("file.index_status = 'pending'");
    expect(cancel).not.toContain("scan_status");
    const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
    const functions = new Map(contract.functions.map((item) => [item.sig, item]));
    const deleteEntry = functions.get("private.can_delete_organization_knowledge_object(p_bucket_id text, p_name text)");
    expect(deleteEntry?.bodyContains).toContain("file.index_status = 'pending'");
    expect(deleteEntry?.bodyContains).not.toContain("file.scan_status = 'pending'");
    expect(deleteEntry?.bodyMd5).toBeTruthy();
    const cancelEntry = functions.get("public.cancel_steward_library_upload(p_file_id uuid, p_storage_handle uuid)");
    expect(cancelEntry?.bodyContains).toContain("file.index_status = 'pending'");
    expect(cancelEntry?.bodyMd5).toBeTruthy();
  });

  it("moves the paginated member catalog reader onto the ledger with its twin", () => {
    // list_resource_catalog_page is the reader the web client actually calls.
    // The unpaged list_resource_catalog twin is retired
    // (20260917051000_retire_dormant_catalog_handoff_reads).
    const page = stripComments(fnBody(repairSql, "public.list_resource_catalog_page")).toLowerCase();
    expect(page).not.toContain("scan_status");
    expect(page).toContain("source.storage_kind <> 'organization_storage'");
    expect(page).toContain("private.private_upload_is_current('organization-knowledge', source.storage_path)");
    expect(page).toContain("invalid page cursor");
    const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
    const entry = contract.functions.find((candidate) => (
      candidate.sig.startsWith("public.list_resource_catalog_page(")
    ));
    expect(entry?.bodyContains).toContain("private.private_upload_is_current('organization-knowledge', source.storage_path)");
    expect(entry?.bodyForbids).toContain("scan_status");
    expect(entry?.bodyMd5).toBeTruthy();
  });

  it("keeps storage policies free of direct protected-table reads", () => {
    const policyTail = code.slice(code.indexOf("drop policy if exists organization_knowledge_objects_insert"));
    expect(policyTail).not.toContain("from public.organization_knowledge_files");
    expect(policyTail).toContain("with check (\n    bucket_id = 'organization-knowledge'\n    and (select private.mfa_satisfied())\n    and private.can_insert_organization_knowledge_object(bucket_id, name)");
    expect(policyTail).toContain("using (\n    bucket_id = 'organization-knowledge'\n    and (select private.mfa_satisfied())\n    and private.can_read_organization_knowledge_object(bucket_id, name)");
    expect(policyTail).toContain("using (\n    bucket_id = 'organization-knowledge'\n    and (select private.mfa_satisfied())\n    and private.can_delete_organization_knowledge_object(bucket_id, name)");
    expect(code).not.toMatch(/grant\s+(?:select|insert|update|delete)\s+on\s+(?:table\s+)?public\.organization_knowledge_files/i);
  });

  it("records the helper ACLs and delegated policy bodies in the live contract", () => {
    const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
    const functions = new Map(contract.functions.map((entry) => [entry.sig, entry]));
    for (const helper of helpers) {
      const entry = functions.get(`private.${helper}(p_bucket_id text, p_name text)`);
      expect(entry?.secdef).toBe(true);
      expect(entry?.exec).toBe("authenticated");
      expect(entry?.bodyContains).toContain("p_bucket_id IS DISTINCT FROM 'organization-knowledge'");
      expect(entry?.bodyContains).toContain("private.mfa_satisfied()");
      expect(entry?.bodyContains).toContain("private.current_mobile_staff_organization() IS NULL");
    }

    const insertContract = functions.get("private.can_insert_organization_knowledge_object(p_bucket_id text, p_name text)");
    const deleteContract = functions.get("private.can_delete_organization_knowledge_object(p_bucket_id text, p_name text)");
    for (const entry of [insertContract, deleteContract]) {
      expect(entry?.bodyContains).toContain("file.created_by = (");
      expect(entry?.bodyContains).toContain("auth.uid()");
      expect(entry?.bodyContains).toContain("file.organization_id = private.current_mobile_staff_organization()");
      expect(entry?.bodyContains).toContain("file.review_status = 'pending_scan'");
    }

    const policies = new Map(contract.policies.map((entry) => [entry.name, entry]));
    expect(policies.get("organization_knowledge_objects_insert")?.withCheckContains)
      .toEqual([
        "bucket_id = 'organization-knowledge'",
        "(SELECT private.mfa_satisfied() AS mfa_satisfied)",
        "private.can_insert_organization_knowledge_object(bucket_id, name)",
      ]);
    expect(policies.get("organization_knowledge_objects_insert")?.withCheckExcludes)
      .toEqual(["organization_knowledge_files"]);
    expect(policies.get("organization_knowledge_objects_read")?.qualContains)
      .toEqual([
        "bucket_id = 'organization-knowledge'",
        "(SELECT private.mfa_satisfied() AS mfa_satisfied)",
        "private.can_read_organization_knowledge_object(bucket_id, name)",
      ]);
    expect(policies.get("organization_knowledge_objects_read")?.qualExcludes)
      .toEqual(["organization_knowledge_files"]);
    expect(policies.get("organization_knowledge_objects_delete")?.qualContains)
      .toEqual([
        "bucket_id = 'organization-knowledge'",
        "(SELECT private.mfa_satisfied() AS mfa_satisfied)",
        "private.can_delete_organization_knowledge_object(bucket_id, name)",
      ]);
    expect(policies.get("organization_knowledge_objects_delete")?.qualExcludes)
      .toEqual(["organization_knowledge_files"]);

    expect(contract.policyCoverage.protectedRelationPolicyReferences).toEqual({
      table: "storage.objects",
      forbiddenSubstrings: [
        "organization_knowledge_files",
        "member_case_files",
        "chapter_task_files",
        "member_form_files",
      ],
      note: expect.any(String),
    });

    const verifier = readFileSync(new URL("../scripts/verify-db-contract.mjs", import.meta.url), "utf8");
    expect(verifier).toContain("if (protectedPolicyReferences) {");

    const indexes = new Map(contract.indexes.map((entry) => [entry.name, entry]));
    expect(indexes.get("organization_knowledge_files_storage_path_key")).toEqual({
      table: "organization_knowledge_files",
      name: "organization_knowledge_files_storage_path_key",
      defContains: [
        "UNIQUE INDEX",
        "USING btree (storage_path)",
        "WHERE (storage_path <> 'pending'::text)",
      ],
    });
  });
});
