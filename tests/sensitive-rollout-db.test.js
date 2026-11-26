// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createSensitiveStorage } from "../api/_lib/sensitiveStorage.js";
import pg from "pg";
import { expect, it } from "vitest";
import { assertDisposableProofUrl, assertDisposableStorageStatus } from "../scripts/run-required-db-proofs.mjs";
import { closeSensitiveWindow, applySensitiveMigration, runSensitiveMaintenance, openSensitiveWindow } from "../scripts/sensitive-data-rollout.mjs";
import { sensitiveKeyring } from "../api/_lib/sensitiveDataCrypto.js";
import { revealRow } from "../api/_lib/sensitiveContent.js";
import { maintainSensitiveFields } from "../scripts/sensitive-data-maintenance.mjs";
import { decryptCaseDocument } from "../api/_lib/sensitiveCaseDocuments.js";
import { createSensitiveProofStack, preStartedSensitiveProofStack, repositoryMigrationVersions, SENSITIVE_PROOF_LIMITS } from "./helpers/sensitive-rollout-stack.mjs";

const databaseIt = process.env.RUN_SENSITIVE_CONTENT_DB_TESTS === "1" ? it : it.skip;
databaseIt("rehearses real migration, encrypted backfill, key recovery and fail-closed Storage compatibility", async () => {
  // Never reconstruct a tail in the shared proof stack: other required proofs
  // can commit fixtures. This one owns a separate empty disposable project.
  assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  const supabase = resolve("node_modules/.bin/supabase");
  // CI hands over this proof's own empty project, already replayed from zero
  // alongside the shared stack. Without one, prepare and start it here.
  const prestarted = preStartedSensitiveProofStack();
  let root = null, workdir, rawUrl;
  if (prestarted) ({ workdir, url: rawUrl } = prestarted);
  else {
    // Keep the full migration copy on the explicitly provided scratch disk.
    root = mkdtempSync(join(process.env.CI_DB_TEMP_ROOT || tmpdir(),"enc-lifecycle-"));
    const envFile = join(root,"db.env");
    const prepared = spawnSync(process.execPath,["scripts/prepare-ci-disposable-db.mjs"],{
      encoding:"utf8", timeout:SENSITIVE_PROOF_LIMITS.prepareMs,
      env:{...process.env,CI_DB_TEMP_ROOT:root,CI_DB_RUN_KEY:randomUUID(),GITHUB_ENV:envFile,CI_DB_SENSITIVE_PROOF_TARGET:""},
    });
    if (prepared.status !== 0) throw new Error("sensitive-proof-stack-prepare-failed");
    const env = Object.fromEntries(readFileSync(envFile,"utf8").trim().split("\n").map((line) => { const at=line.indexOf("="); return [line.slice(0,at),line.slice(at+1)]; }));
    workdir = env.CI_DB_WORKDIR;
    rawUrl = env.SUPABASE_DB_URL;
  }
  // The same full replay ran in the parent CI stack. Exclude its unused
  // services and share one window, sized from that measured replay, across at
  // most two starts; retry cleanup consumes that window too. Status/stop
  // remain short operations.
  const { command: stack, start } = createSensitiveProofStack(supabase, workdir);
  if (!prestarted) {
    const { result: started, attempts } = start();
    if (started.status !== 0) { rmSync(root,{recursive:true,force:true}); throw new Error(`sensitive-proof-stack-start-failed (attempts ${JSON.stringify(attempts)}): ${String(started.stderr || "").slice(-400)}`); }
  }
  const url = assertDisposableProofUrl(rawUrl);
  const status = assertDisposableStorageStatus(JSON.parse(stack("status","-o","json").stdout),url);
  const client = new pg.Client({ connectionString: url });
  const storage = createSensitiveStorage(status.API_URL,status.SERVICE_ROLE_KEY);
  const formStorage = createSensitiveStorage(status.API_URL,status.SERVICE_ROLE_KEY,{ bucket: "member-form-files" });
  const org = randomUUID(), user = randomUUID(), caseId = randomUUID(), file = randomUUID(), accommodation = randomUUID();
  const chapter = `enc-rollout-${randomUUID()}`;
  const oldName = `${user}/${caseId}/${file}-synthetic.txt`;
  const plaintext = Buffer.alloc(10 * 1024 * 1024,97);
  const keyring = (version) => sensitiveKeyring("saas",{ SENSITIVE_DATA_KEYS:JSON.stringify({[version]:randomBytes(32).toString("base64")}), SENSITIVE_DATA_ACTIVE_KEY:version });
  const ring = keyring("v1"), next = keyring("v2");
  await client.connect();
  try {
  // A full from-zero replay of exactly this head's history, never a partial
  // or reused database.
  expect((await client.query("select version from supabase_migrations.schema_migrations order by version")).rows.map(({ version }) => version))
    .toEqual(repositoryMigrationVersions());
  // Probe the actual pinned service. The existing transport accepts typed
  // NoSuchKey on HTTP 404 or the complete hosted HTTP-400 semantic-404 tuple;
  // a legacy untyped 400 must still leave retirement pending.
  const absentName = `synthetic-never-uploaded-${randomUUID()}`;
  const absentResponse = await fetch(`${status.API_URL}/storage/v1/object/case-files/${absentName}`, {
    headers: { apikey: status.SERVICE_ROLE_KEY, Authorization: `Bearer ${status.SERVICE_ROLE_KEY}` },
    redirect: "error", signal: AbortSignal.timeout(10000),
  });
  const absentBody = await absentResponse.json();
  const supportsAbsence = absentBody.code === "NoSuchKey" && absentBody.message === "Object not found"
    && (absentResponse.status === 404 || (absentResponse.status === 400
      && absentBody.error === "not_found" && [404, "404"].includes(absentBody.statusCode)));
  expect((await storage.download(absentName)).failure).toBe(supportsAbsence ? "absent" : "unavailable");
  if (!supportsAbsence) {
    expect(absentResponse.status).toBe(400);
    // The legacy body without typed NoSuchKey remains unsupported.
    expect(absentBody).toMatchObject({ statusCode: "404", error: "not_found", message: "Object not found" });
  }
    // This owned stack is destroyed after proofs. Reconstruct just the unmerged
    // ENC tail's predecessor, then execute the actual operator apply command.
    await closeSensitiveWindow(client);
    await client.query(`
      drop trigger sensitive_envelopes on public.member_accommodation_requests;
      drop trigger sensitive_envelopes on public.casework_retaliation_reports;
      drop trigger sensitive_envelopes on public.casework_retaliation_patterns;
      drop function public.write_sensitive_content(text,jsonb,jsonb,uuid);
      drop function if exists public.sensitive_demo_seed_plan(text,uuid);
      drop function public.stage_sensitive_write(uuid,text,jsonb,jsonb);
      drop function public.sensitive_data_organization();
      drop function public.sensitive_case_upload_target(uuid);
      drop function public.sensitive_case_read_current(uuid);
      drop function public.sensitive_case_inspection_metadata(uuid,uuid);
      drop function public.set_sensitive_case_envelope(uuid,jsonb);
      drop function public.sensitive_pattern_source(text,uuid);
      drop function private.require_sensitive_envelopes();
      drop table private.sensitive_write_tickets;
      drop table private.sensitive_retired_objects;
      drop table public.sensitive_case_chunks;
      drop policy sensitive_case_server_upload on storage.objects;
      drop policy sensitive_case_server_update on storage.objects;
      alter table public.member_accommodation_requests drop column encrypted_content;
      alter table public.casework_retaliation_reports drop column encrypted_content;
      alter table public.casework_retaliation_patterns drop column encrypted_content;
      alter table public.member_case_files drop column encrypted_content;
      delete from supabase_migrations.schema_migrations where version='20260906190000';
      do $undo$ declare d text; begin
        select pg_get_functiondef('public.casework_submit_retaliation_report(uuid,timestamptz,text,text,text,text,uuid)'::regprocedure) into d;
        d := replace(d,'insert into public.casework_retaliation_reports(id, organization_id','insert into public.casework_retaliation_reports(organization_id');
        d := replace(d,'values (p_idempotency_key, v_case.organization_id','values (v_case.organization_id');
        execute d;
      end $undo$;`);
    for (const [migration,name] of [["20260829030000_member_support_programs.sql","demo_seed_apply_member_support"],["20260830050000_demo_seed_casework_completion.sql","demo_seed_apply_casework"]]) {
      const source = readFileSync(new URL(`../supabase/migrations/${migration}`,import.meta.url),"utf8");
      const start = source.indexOf(`create function private.${name}(`);
      const end = source.indexOf("$function$;",start) + "$function$;".length;
      await client.query(source.slice(start,end).replace("create function","create or replace function"));
    }
    await client.query("insert into auth.users(id,email) values($1,$2)",[user,`${user}@example.invalid`]);
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,'Synthetic ENC rollout',$3)",[org,`enc-${org}`,user]);
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,'Synthetic ENC rollout',$1,$2,false,9903)",[chapter,org]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')",[org,user]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now())",[user,chapter]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1",[user,chapter]);
    await client.query("insert into public.member_cases(id,user_id,reference,title,case_type) values($1,$2,$3,'Synthetic legacy case','other')",[caseId,user,`enc-${caseId}`]);
    await client.query("insert into public.member_accommodation_requests(id,organization_id,member_user_id,request_type,description) values($1,$2,$3,'schedule','Synthetic legacy confidential detail')",[accommodation,org,user]);
    await client.query("insert into public.member_case_files(id,case_id,user_id,object_name,filename,mime_type,size_bytes,uploaded_by) values($1,$2,$3,$4,'synthetic.txt','text/plain',$5,$3)",[file,caseId,user,oldName,plaintext.length]);
    expect((await storage.upload(oldName,plaintext,{ contentType:"text/plain" })).error).toBeNull();
    expect((await client.query("select has_schema_privilege('authenticated','public','USAGE') allowed")).rows[0].allowed).toBe(false);
    // Ordinary migration tools must refuse populated targets outside the window.
    await client.query("begin; delete from private.sensitive_rollout_window; grant usage on schema public to authenticated;");
    await expect(client.query(readFileSync(new URL("../supabase/migrations/20260906190000_sensitive_content_envelopes.sql", import.meta.url), "utf8")))
      .rejects.toThrow("sensitive-maintenance-window-required");
    await client.query("rollback");
    await applySensitiveMigration(client);
    // Opening early fails; the namespace stays closed, even with valid keys.
    await expect(openSensitiveWindow(client,storage,{formStorage,ring})).rejects.toThrow();
    await maintainSensitiveFields(client, { ring });
    for (const failure of [503, 401, 403, "timeout", "malformed"]) {
      const unavailableStorage = { download: async () => {
        if (failure === "timeout") throw new Error("synthetic timeout");
        return failure === "malformed" ? {} : { data: null, error: { status: failure } };
      } };
      await expect(openSensitiveWindow(client, unavailableStorage, { ring, formStorage })).rejects.toThrow("sensitive-document-storage-unavailable");
      expect((await client.query("select has_schema_privilege('authenticated','public','USAGE') allowed")).rows[0].allowed).toBe(false);
      expect((await client.query("select encrypted_content from public.member_case_files where id=$1", [file])).rows[0].encrypted_content).toBeNull();
    }
    expect(Buffer.from(await (await storage.download(oldName)).data.arrayBuffer()).equals(plaintext)).toBe(true);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const backfill = runSensitiveMaintenance(client,storage,{ring,mode:"backfill",formStorage});
      if (supportsAbsence) await backfill;
      else {
        await expect(backfill).rejects.toThrow("sensitive-document-storage-unavailable");
        expect((await client.query("select object_name from private.sensitive_retired_objects")).rows).toEqual([{ object_name: oldName }]);
        expect((await client.query("select has_schema_privilege('authenticated','public','USAGE') allowed")).rows[0].allowed).toBe(false);
        await expect(openSensitiveWindow(client,storage,{formStorage,ring})).rejects.toThrow("sensitive-document-retirement-pending");
      }
    }
    const row = (await client.query("select f.*,c.organization_id from public.member_case_files f join public.member_cases c on c.id=f.case_id where f.id=$1",[file])).rows[0];
    const stored = Buffer.from(await (await storage.download(row.object_name)).data.arrayBuffer());
    expect(stored.equals(plaintext)).toBe(false);
    expect(decryptCaseDocument(stored,row,ring).equals(plaintext)).toBe(true);
    expect((await storage.download(oldName)).error).toBeTruthy();
    const field = (await client.query("select * from public.member_accommodation_requests where id=$1",[accommodation])).rows[0];
    expect(field.description).toBe("[encrypted]");
    expect(revealRow("member_accommodation_requests",field,ring).description).toBe("Synthetic legacy confidential detail");
    await runSensitiveMaintenance(client,storage,{ring:next,oldRing:ring,mode:"rewrap",formStorage});
    const moved = (await client.query("select f.*,c.organization_id from public.member_case_files f join public.member_cases c on c.id=f.case_id where f.id=$1",[file])).rows[0];
    expect(moved.encrypted_content.payload).toEqual(row.encrypted_content.payload);
    expect(decryptCaseDocument(stored,moved,next).equals(plaintext)).toBe(true);
    expect(() => decryptCaseDocument(stored,moved,ring)).toThrow();
    const backupRow = JSON.parse(JSON.stringify(moved)), backupBytes = Buffer.from(stored);
    const revoked = {...next,revoked:new Set([org])};
    expect(() => decryptCaseDocument(backupBytes,backupRow,revoked)).toThrow();
    await expect(openSensitiveWindow(client,storage,{formStorage,ring:revoked})).rejects.toThrow();
    expect((await client.query("select has_schema_privilege('authenticated','public','USAGE') allowed")).rows[0].allowed).toBe(false);
    // Restore matching metadata AND bytes with separately retained keys; the
    // independent revocation check above remains authoritative after restore.
    const restoredName = `${moved.object_name}.restore-${randomUUID()}`;
    expect((await storage.upload(restoredName,backupBytes,{contentType:"text/plain"})).error).toBeNull();
    await client.query("update public.member_case_files set object_name=$1,encrypted_content=$2 where id=$3",[restoredName,backupRow.encrypted_content,file]);
    expect(decryptCaseDocument(backupBytes,backupRow,next).equals(plaintext)).toBe(true);
    if (supportsAbsence) await openSensitiveWindow(client,storage,{formStorage,ring:next});
    else {
      await expect(openSensitiveWindow(client,storage,{formStorage,ring:next})).rejects.toThrow("sensitive-document-retirement-pending");
      expect((await client.query("select object_name from private.sensitive_retired_objects")).rows).toEqual([{ object_name: oldName }]);
    }
    expect((await client.query("select has_schema_privilege('authenticated','public','USAGE') allowed")).rows[0].allowed).toBe(supportsAbsence);
    expect((await storage.remove([moved.object_name,restoredName])).error).toBeNull();
    await client.query("delete from public.member_case_files where id=$1",[file]);
    await client.query("delete from public.member_accommodation_requests where id=$1",[accommodation]);
  } finally {
    plaintext.fill(0);
    await client.end();
    const stopped = stack("stop","--no-backup");
    // eslint-disable-next-line no-unsafe-finally -- cleanup failures must fail the proof even after its assertions ran
    if (stopped.status !== 0) throw new Error("sensitive-proof-stack-cleanup-failed");
    // CI's teardown step removes a pre-started stack's runner-owned workdir.
    if (root) rmSync(root,{recursive:true,force:true});
  }
// Forty minutes covers one minute of preparation, the shared 25-minute start
// window, short status/cleanup operations and ten minutes of unchanged proofs.
},SENSITIVE_PROOF_LIMITS.testMs);
