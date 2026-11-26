// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("20260829043000_mi1_knowledge_library_completion");
const code = stripComments(sql);
// The knowledge RPCs below were re-issued with private-upload gates in
// 20260906020000. The pins in this file describe the ORIGINAL statements, which
// are frozen by the forward-only rule; the gate pins live with the migration
// that added them so the two cannot drift apart silently.
const gatesSql = loadMigrationSql("20260906020000_private_upload_workflow_gates");
const projectionSql = loadMigrationSql("20260906022000_retire_scan_status_projection");
const api = readFileSync(new URL("../api/google-drive.js", import.meta.url), "utf8");
const ingestApi = readFileSync(new URL("../api/knowledge-ingest.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));

function body(name) {
  return stripComments(fnBody(sql, name));
}

describe("MI1 CR-071 through CR-075 knowledge completion migration", () => {
  it("adds reusable collections without adding tenants or direct write grants", () => {
    expect(code).toContain("create table public.knowledge_collections");
    expect(code).toContain("create table public.knowledge_collection_items");
    expect(code).toContain("alter table public.knowledge_collections force row level security");
    expect(code).toContain("revoke all on table public.knowledge_collections from public, anon, authenticated, service_role");
    expect(code).not.toMatch(/insert into public\.organizations\b/i);
    expect(code).not.toMatch(/insert into auth\.users\b/i);
    for (const functionName of [
      "public.save_knowledge_collection",
      "public.set_knowledge_collection_item",
      "public.delete_knowledge_collection",
    ]) {
      const collectionWrite = body(functionName);
      expect(collectionWrite).toContain("is distinct from chapter");
      expect(collectionWrite).toContain("private.has_organization_role(org, array['advisor', 'admin', 'vp'])");
    }
    expect(body("public.set_knowledge_collection_item")).toContain("file.organization_id = org");
    expect(body("public.delete_knowledge_collection")).toContain("collection.organization_id = org");
  });

  it("restores a selected revision as a new idempotent, audited version", () => {
    const restore = body("public.restore_chapter_kb_revision");
    expect(restore).toContain("pg_advisory_xact_lock");
    expect(restore).toContain("receipt.operation = 'restore_chapter_kb_revision'");
    expect(restore).toContain("version = article.version + 1");
    expect(restore).toContain("then 'published' else 'draft'");
    expect(restore).toContain("knowledge_revision_restored");
    expect(code).toContain("'restoredFromVersion', 'newVersion'");
  });

  it("authorizes protected bytes through opaque handles and private storage", () => {
    expect(code).toContain("values ('organization-knowledge', 'organization-knowledge', false, 10485760)");
    expect(code).toContain("create policy organization_knowledge_objects_insert");
    expect(code).toContain("create policy organization_knowledge_objects_read");
    expect(code).toContain("create policy organization_knowledge_objects_delete");
    const target = body("public.get_knowledge_file_storage_target");
    expect(target).toContain("file.storage_handle is distinct from p_storage_handle");
    expect(target).toContain("private.mi1_w2_download_knowledge_file(file.id, true)");
    expect(target).toContain("private.mi1_w2_selected_organization()");
    expect(body("public.cancel_steward_library_upload")).toContain("file.created_by = (select auth.uid())");
  });

  it("runs extraction through a service-only, tenant-checked chunk replacement", () => {
    const authorize = body("public.authorize_knowledge_ingest");
    const replace = body("public.replace_knowledge_source_chunks");
    expect(authorize).toContain("row.organization_id = org");
    expect(authorize).toContain("file.created_by = actor");
    expect(authorize).toContain("pg_advisory_xact_lock");
    expect(authorize).toContain("event.event_type = 'knowledge_ingest_authorized'");
    expect(authorize).toContain("'rateLimited', true");
    expect(authorize).toContain("'rateLimited', false");
    expect(replace).toContain("auth.role()) <> 'service_role'");
    expect(replace).toContain("row.organization_id = p_organization_id");
    expect(replace).toContain("jsonb_array_length(coalesce(p_chunks, '[]'::jsonb)) > 500");
    expect(replace).toContain("insert into public.organization_knowledge_chunks");
    expect(replace).toContain("role.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')");
    expect(code).toContain("grant execute on function public.replace_knowledge_source_chunks(uuid, uuid, uuid, jsonb, text) to service_role");
    expect(code).not.toContain("grant execute on function public.replace_knowledge_source_chunks(uuid, uuid, uuid, jsonb, text) to authenticated");
    expect(ingestApi).toContain("knowledge-storage-digest-mismatch");
    expect(ingestApi).toContain("extractKnowledgeText");
  });

  it("is superseded by the workflow-gate migration for scan verdicts and ingest authorization", () => {
    const gate = (name) => stripComments(fnBody(gatesSql, name));
    const ingest = gate("public.authorize_knowledge_ingest");
    expect(ingest).toContain("private.private_upload_is_current('organization-knowledge', file.storage_path)");
    // The uploader's self-service branch keys on the ingest lifecycle column,
    // not on the retired malware flag.
    expect(ingest).toContain("file.review_status = 'pending_scan' and file.index_status = 'pending'");
    expect(ingest).not.toContain("scan_status");
    // The unconditional knowledge clean/blocked writes are gone: successful
    // text extraction is not a malware verdict in either direction.
    const replace = gate("public.replace_knowledge_source_chunks");
    expect(replace).not.toContain("scan_status");
    expect(replace).toContain("set index_status = 'chunked'");
    expect(replace).toContain("set index_status = 'failed'");
    expect(gate("public.complete_steward_library_upload"))
      .toContain("private.private_upload_is_current('organization-knowledge', file.storage_path)");
    // The pre-scan write path must stay reachable, or nothing can ever be
    // uploaded for scanning in the first place.
    expect(gatesSql).not.toContain("create or replace function private.can_insert_organization_knowledge_object");
    expect(gatesSql).not.toContain("create or replace function private.can_delete_organization_knowledge_object");
    expect(gatesSql).not.toContain("create or replace function public.get_knowledge_file_storage_target");
    expect(gatesSql).not.toContain("create or replace function public.search_member_kb");
  });

  it("stops shipping the retired scan flag to the client in the shared file projection", () => {
    // private.mi1_w2_project_knowledge_file shapes every steward-library
    // payload — list, upload completion, review, publish. It was the last
    // client-visible trace of organization_knowledge_files.scan_status, which
    // 20260906020000 pinned at 'pending' for a row's whole life. A field that
    // reads like a malware verdict and can never say 'clean' is an invitation
    // to invent a client-side gate that denies everything, so the pair is gone.
    const projection = stripComments(fnBody(projectionSql, "private.mi1_w2_project_knowledge_file"));
    expect(projection).toContain("create or replace function private.mi1_w2_project_knowledge_file");
    expect(projection).not.toContain("scan_status");
    expect(projection).not.toContain("scanStatus");
    // The lifecycle fields the panel actually reads must survive the edit.
    expect(projection).toContain("'reviewStatus', f.review_status");
    expect(projection).toContain("'indexStatus', f.index_status");
    expect(projection).toContain("'publishedToCatalog', f.published_to_catalog");
    expect(projection).toContain("security definer");
    expect(projection).toContain("set search_path = ''");
    // Internal helper: replacing a function keeps its ACL, and the migration
    // restates the revoke so this cannot become a new authenticated surface.
    expect(stripComments(projectionSql)).toContain(
      "revoke all on function private.mi1_w2_project_knowledge_file(uuid)\n  from public, anon, authenticated, service_role",
    );
    // The contract guard is what stops the pair coming back.
    const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
    const entry = contract.functions.find((candidate) => (
      candidate.sig === "private.mi1_w2_project_knowledge_file(p_file_id uuid)"
    ));
    expect(entry?.bodyForbids).toContain("scan_status");
    expect(entry?.bodyContains).toContain("'indexStatus', f.index_status");
    expect(entry?.bodyMd5).toBeTruthy();
  });

  it("keeps Drive OAuth PKCE state private and refresh tokens in Vault", () => {
    expect(code).toContain("create table private.google_drive_oauth_states");
    expect(code).toContain("revoke all on table private.google_drive_oauth_states from public, anon, authenticated, service_role");
    expect(body("public.begin_google_drive_oauth")).toContain("private.mi1_require_integration_admin()");
    expect(body("public.begin_google_drive_oauth")).toContain("private.mfa_satisfied()");
    expect(body("public.claim_google_drive_oauth_state")).toContain("auth.role()) <> 'service_role'");
    const complete = body("public.complete_google_drive_oauth");
    expect(complete).toContain("vault.create_secret");
    expect(complete).toContain("extensions.gen_random_uuid()::text");
    expect(complete).toContain("role.role in ('admin', 'vp')");
    const authorize = body("public.authorize_google_drive_operation");
    expect(authorize).toContain("pg_advisory_xact_lock");
    expect(authorize).toContain("event.event_type = 'google_drive_operation_authorized'");
    expect(authorize).toContain("'rateLimited', true");
    expect(authorize).toContain("'rateLimited', false");
    expect(body("public.read_google_drive_refresh_token")).toContain("vault.decrypted_secrets");
    expect(code).toContain("grant execute on function public.read_google_drive_refresh_token(uuid) to service_role");
    expect(code).not.toContain("grant execute on function public.read_google_drive_refresh_token(uuid) to authenticated");
  });

  it("gives the composite Drive handler enough deployment time", () => {
    expect(vercel.functions["api/google-drive.js"]).toEqual({ maxDuration: 60 });
  });

  it("pins the callback to the configured redirect and never returns provider errors or tokens", () => {
    expect(api).toContain("claimed.redirectUri !== redirectUri");
    expect(api).toContain("new URL(redirectUri).origin");
    expect(api).not.toContain("x-forwarded-host");
    expect(api).not.toMatch(/json\(response,\s*\d+,\s*\{\s*(?:refreshToken|accessToken)\s*:/);
    expect(api).toContain("google drive request failed");
    expect(api).toContain("status === 413");
    expect(api).toContain("status === 429");
    expect(api).toContain("rootFolderId,");
    expect(api).toContain('action !== "callback" && request.method !== "POST"');
    expect(ingestApi).toContain("target?.rateLimited");
    expect(ingestApi).toContain("429");
  });

  it("uses semantic field surfaces and boundaries", () => {
    expect(styles).toContain("border: 1px solid var(--border)");
    expect(styles).toContain("background: var(--input)");
  });

  it("stacks the workspace from its available content width", () => {
    expect(styles).toMatch(/\.knowledge-workspace\s*\{[^}]*container-type:\s*inline-size/s);
    expect(styles).toContain("@container knowledge-workspace (max-width: 700px)");
    expect(styles).toMatch(/\.knowledge-workspace__card\s*\{[^}]*container-type:\s*inline-size/s);
    expect(styles).toContain("@container knowledge-card (max-width: 430px)");
  });
});
