// @vitest-environment node
// BUG-UG-WEB-CATALOG-EXTERNAL-URL-FILES-UNDOWNLOADABLE-20261003:
// external_url knowledge files could be recorded but never served. Controller
// decision, October 5, 2026: refuse them rather than serve unscanned links.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readMigrationFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";
import { offlinePostgres, postgresBin } from "./tamarack-postgres-helper.mjs";
import { setupKnowledgeStorageFixture, assertKnowledgeStorageLifecycle, knowledgeStoragePredecessor } from "./helpers/knowledge-external-storage-fixture.mjs";

const sql = loadMigrationSql("20261008045100_knowledge_external_url_files_refused");
const code = stripComments(sql);
const lifecycleManifest = loadMigrationSql("20260907150000_account_lifecycle_manifest");
const lifecycleInventory = loadMigrationSql("20260929034500_account_lifecycle_trigger_inventory_tokens");
const reviewTable = lifecycleManifest.match(/create table private\.account_lifecycle_trigger_review[\s\S]*?\n\);/)?.[0];
const triggerSurface = lifecycleInventory.match(/create or replace function private\.account_lifecycle_trigger_surface\(\)[\s\S]*?\$function\$;/)?.[0];
const triggerIssues = lifecycleManifest.match(/create function private\.account_lifecycle_referential_action_trigger_issues\(\)[\s\S]*?\$function\$;/)?.[0];
if (!reviewTable || !triggerSurface || !triggerIssues) throw new Error("Lifecycle inventory fixture source missing");
const setupLifecycleReview = [reviewTable, triggerSurface, triggerIssues].join("\n");
const downloadAuthorization = loadMigrationSql("20260906020000_private_upload_workflow_gates")
  .match(/create or replace function private\.mi1_w2_download_knowledge_file\([\s\S]*?\$function\$;/)?.[0];
if (!downloadAuthorization) throw new Error("Knowledge download authorization fixture source missing");

describe("20261008045100 knowledge external_url files refused", () => {
  it("contracts the exact invoker trigger body with no client execute grants", () => {
    const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
    const body = sql.match(/as \$guard\$([\s\S]*?)\$guard\$;/)[1];
    expect(contract.functions.filter((entry) => entry.sig === "private.refuse_external_knowledge_file_write()"))
      .toEqual([expect.objectContaining({ secdef: false, exec: "",
        sourceMd5: createHash("md5").update(body).digest("hex") })]);
  });

  it.runIf(postgresBin)("allows account deletion after applying the actual migration to legacy rows", async () => {
    const db = await offlinePostgres();
    try {
      await db.client.query(setupKnowledgeStorageFixture);
      await db.client.query(setupLifecycleReview);
      await db.client.query(knowledgeStoragePredecessor(sql));
      await db.client.query(sql);
      await db.client.query(assertKnowledgeStorageLifecycle);
      expect((await db.client.query("select * from private.account_lifecycle_referential_action_trigger_issues()")).rows).toEqual([]);
      expect((await db.client.query("select * from private.account_lifecycle_trigger_review")).rows).toHaveLength(2);
      await db.client.query("alter function private.refuse_external_knowledge_file_write() security definer");
      expect((await db.client.query("select * from private.account_lifecycle_referential_action_trigger_issues()")).rows)
        .toEqual([expect.objectContaining({ trigger_name: "refuse_external_knowledge_file_write()" })]);
      await db.client.query("alter table public.organization_knowledge_files disable trigger organization_knowledge_files_refuse_external_write");
      expect((await db.client.query("select * from private.account_lifecycle_referential_action_trigger_issues()")).rows).toHaveLength(2);
    } finally { await db.close(); }
  }, 120000);

  it.runIf(postgresBin)("refuses unrelated unreviewed triggers instead of admitting them", async () => {
    const db = await offlinePostgres();
    try {
      await db.client.query(setupKnowledgeStorageFixture);
      await db.client.query(setupLifecycleReview);
      await db.client.query(knowledgeStoragePredecessor(sql));
      await db.client.query(`create function private.unreviewed_knowledge_trigger() returns trigger
        language plpgsql as $$begin return new; end$$;
        create trigger unreviewed_knowledge_trigger before update on public.organization_knowledge_files
        for each row execute function private.unreviewed_knowledge_trigger()`);
      await expect(db.client.query(sql)).rejects.toThrow("account lifecycle trigger review is incomplete");
      await db.client.query("rollback");
      expect((await db.client.query("select * from private.account_lifecycle_trigger_review")).rows).toEqual([]);
    } finally { await db.close(); }
  }, 120000);

  it.runIf(postgresBin)("preserves authorization refusals for retained external-file handles", async () => {
    const db = await offlinePostgres();
    const file = "00000000-0000-4000-8000-000000000002";
    const handle = "00000000-0000-4000-8000-000000000005";
    const target = (mode) => db.client.query(
      "select public.get_knowledge_file_storage_target($1,$2,$3)", [file, handle, mode]);
    const mode = async (name, value) => db.client.query("select set_config($1,$2,false)", [`test.${name}`, value]);
    try {
      await db.client.query(setupKnowledgeStorageFixture);
      await db.client.query(`
        alter table public.organization_knowledge_files add column published_to_catalog boolean default true;
        alter table public.organization_knowledge_files add column library text default 'catalog';
        update public.organization_knowledge_files set organization_id='00000000-0000-4000-8000-000000000010',
          storage_handle='${handle}', review_status='approved';
        create or replace function auth.uid() returns uuid language sql as $$
          select '00000000-0000-4000-8000-000000000001'::uuid$$;
        create or replace function private.mi1_w2_selected_organization() returns uuid language sql as $$
          select '00000000-0000-4000-8000-000000000010'::uuid$$;
        create or replace function private.has_organization_role(uuid,text[]) returns boolean language sql as $$
          select coalesce(current_setting('test.staff',true),'false')::boolean$$;
        create function private.is_organization_member(uuid) returns boolean language sql as $$
          select coalesce(current_setting('test.member',true),'true')::boolean$$;
        create function private.private_upload_is_current(text,text) returns boolean language sql as $$select true$$;
        create schema extensions;
        create function extensions.gen_random_uuid() returns uuid language sql as $$select pg_catalog.gen_random_uuid()$$;
        create function private.mi1_w2_write_audit(uuid,text,jsonb) returns void language sql as $$select$$;
        drop function private.mi1_w2_download_knowledge_file(uuid,boolean);
      `);
      await db.client.query(downloadAuthorization);
      await db.client.query(setupLifecycleReview);
      await db.client.query(knowledgeStoragePredecessor(sql));
      await db.client.query(sql);

      // An eligible legacy row gets the translated refusal, never coordinates.
      await expect(target("catalog_download")).rejects.toMatchObject({
        code: "22023", detail: "knowledge_file_external_unsupported",
      });
      // Quarantine keeps the old handle. It must answer exactly like absence.
      await db.client.query("update public.organization_knowledge_files set review_status='quarantined'");
      await expect(target("catalog_download")).rejects.toMatchObject({ code: "P0002", message: "not found" });
      await db.client.query("update public.organization_knowledge_files set review_status='approved', published_to_catalog=false");
      await expect(target("catalog_download")).rejects.toMatchObject({ code: "P0002", message: "not found" });
      await db.client.query("update public.organization_knowledge_files set published_to_catalog=true");
      await mode("member", "false");
      await expect(target("catalog_download")).rejects.toMatchObject({ code: "P0002", message: "not found" });
      await expect(target("steward_download")).rejects.toMatchObject({ code: "42501", message: "not authorized" });
      await expect(target("upload")).rejects.toMatchObject({ code: "42501", message: "not authorized" });
      await mode("staff", "true");
      await expect(target("steward_download")).rejects.toMatchObject({
        code: "22023", detail: "knowledge_file_external_unsupported",
      });
      await db.client.query("update public.organization_knowledge_files set review_status='pending_scan'");
      await expect(target("upload")).rejects.toMatchObject({
        code: "22023", detail: "knowledge_file_external_unsupported",
      });
    } finally { await db.close(); }
  }, 120000);

  it("guards external storage writes while retaining legacy account-deletion cleanup", () => {
    expect(code).toContain("before insert or update on public.organization_knowledge_files");
    expect(code).toContain("if tg_op = 'INSERT' then");
    for (const field of ["storage_kind", "storage_path", "storage_handle"]) {
      expect(code).toContain(`new.${field} is distinct from old.${field}`);
    }
    expect(code).not.toContain("new.created_by");
    expect(code).not.toContain("not valid");
    expect(code).toContain("raise notice 'organization_knowledge_files rows not stored in organization storage: %', external_rows;");
  });

  it("refuses an existing external_url row at the storage target with a translatable token", () => {
    expect(code).toContain("if installed is distinct from '3501c0f7158b3adeb27a5ecfa3aa4a8e' then");
    const latest = readMigrationFunctions("supabase/migrations")
      .find((item) => item.name === "public.get_knowledge_file_storage_target").source;
    const refusal = latest.indexOf("raise exception 'file is not stored here' using errcode = '22023', detail = 'knowledge_file_external_unsupported';");
    expect(refusal).toBeGreaterThan(-1);
    // After tenant, handle and mode authorization; before coordinates return.
    expect(refusal).toBeGreaterThan(latest.indexOf("file.storage_handle is distinct from p_storage_handle"));
    expect(refusal).toBeGreaterThan(latest.indexOf("private.mi1_w2_download_knowledge_file(file.id, true)"));
    expect(refusal).toBeLessThan(latest.indexOf("'bucketId', 'organization-knowledge'"));
  });
});
