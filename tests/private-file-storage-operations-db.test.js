// @vitest-environment node
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const databaseIt = process.env.RUN_PRIVATE_FILE_STORAGE_DB_TESTS === "1" ? it : it.skip;

databaseIt("separates real Storage upload/delete operations from quarantined reads and signing", async () => {
  const connectionString = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  const status = JSON.parse(readFileSync(process.env.PRIVATE_FILE_STORAGE_STATUS_FILE, "utf8"));
  const apiUrl = new URL(status.API_URL);
  const dbUrl = new URL(connectionString);
  expect(["127.0.0.1", "localhost"]).toContain(apiUrl.hostname);
  expect(Number(apiUrl.port)).toBe(Number(dbUrl.port) - 1);
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, options);
  const caller = createClient(status.API_URL, status.ANON_KEY, options);
  const sql = new pg.Client({ connectionString });
  const prefix = `upload_operation_${randomBytes(6).toString("hex")}`;
  const bucket = prefix.replaceAll("_", "-");
  let userId;
  let schemaCreated = false;
  let bucketCreated = false;
  const operations = {};
  let proof;
  await sql.connect();
  try {
    const password = `Synthetic!${randomBytes(24).toString("base64url")}`;
    const email = `${prefix}@example.invalid`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error) throw created.error;
    userId = created.data.user.id;
    const session = await caller.auth.signInWithPassword({ email, password });
    if (session.error) throw session.error;
    const createdBucket = await admin.storage.createBucket(bucket, { public: false, fileSizeLimit: 10485760, allowedMimeTypes: ["text/plain"] });
    if (createdBucket.error) throw createdBucket.error;
    bucketCreated = true;
    // Only this random synthetic bucket is affected. Observe the operation
    // chosen by the real Storage server, not an emulated JWT/SQL session.
    await sql.query(`
      create table private.${prefix} (operation text);
      alter table private.${prefix} enable row level security;
      create function private.${prefix}() returns boolean language plpgsql security definer set search_path = '' as $$
      begin insert into private.${prefix} values (storage.operation()); return true; end $$;
      revoke all on function private.${prefix}() from public, anon, authenticated, service_role;
      grant execute on function private.${prefix}() to authenticated;
      create policy ${prefix}_read on storage.objects for select to authenticated
        using (bucket_id = '${bucket}' and (select auth.uid()) = '${userId}'::uuid and private.${prefix}());
      create policy ${prefix}_write on storage.objects for insert to authenticated
        with check (bucket_id = '${bucket}' and (select auth.uid()) = '${userId}'::uuid);
      create policy ${prefix}_delete on storage.objects for delete to authenticated
        using (bucket_id = '${bucket}' and (select auth.uid()) = '${userId}'::uuid);
    `);
    schemaCreated = true;
    const files = caller.storage.from(bucket);
    const observe = async (name, operation) => {
      await sql.query(`truncate private.${prefix}`);
      const result = await operation();
      if (result.error) throw new Error(`${name}: ${result.error.message}`);
      operations[name] = (await sql.query(`select distinct operation from private.${prefix} order by operation`)).rows.map((row) => row.operation);
      return result;
    };
    await observe("upload", () => files.upload("first.txt", Buffer.from("Synthetic"), { contentType: "text/plain", upsert: false }));
    await observe("download", () => files.download("first.txt"));
    await observe("info", () => files.info("first.txt"));
    await observe("sign", () => files.createSignedUrl("first.txt", 30));
    await observe("list", () => files.list());
    await observe("delete", () => files.remove(["first.txt"]));
    if (process.env.PRIVATE_FILE_STORAGE_PROOF_ARTIFACT) writeFileSync(
      process.env.PRIVATE_FILE_STORAGE_PROOF_ARTIFACT,
      JSON.stringify({ status: "observed; quarantine checks pending", operations }, null, 2) + "\n",
    );

    await sql.query(`drop policy ${prefix}_read on storage.objects;
      create policy ${prefix}_read on storage.objects for select to authenticated
      using (bucket_id = '${bucket}' and (select auth.uid()) = '${userId}'::uuid
        and storage.allow_any_operation(array['object.upload', 'object.delete_many']));`);
    const upload = await files.upload("quarantined.txt", Buffer.from("Synthetic quarantine"), { contentType: "text/plain", upsert: false });
    expect(upload.error).toBeNull();
    expect((await files.download("quarantined.txt")).error).toBeTruthy();
    expect((await files.info("quarantined.txt")).error).toBeTruthy();
    expect((await files.createSignedUrl("quarantined.txt", 30)).error).toBeTruthy();
    expect((await files.list()).data).toEqual([]);
    const spoof = await fetch(`${status.API_URL}/storage/v1/object/authenticated/${bucket}/quarantined.txt`, {
      headers: { apikey: status.ANON_KEY, authorization: `Bearer ${session.data.session.access_token}`,
        "storage.operation": "storage.object.upload", "x-storage-operation": "storage.object.upload" },
    });
    expect(spoof.ok).toBe(false);
    expect((await files.remove(["quarantined.txt"])).error).toBeNull();
    expect((await admin.storage.from(bucket).list()).data).toEqual([]);
    proof = {
        status: "passed", scope: "owned synthetic bucket; real Storage/Auth/DB operation context, not full feature authorization",
        observedAt: new Date().toISOString(), operations,
        proofs: ["pending upload allowed", "pending authenticated download denied", "pending authenticated metadata denied", "pending URL signing denied", "pending listing hidden", "operation headers cannot spoof upload", "quarantine deletion without download succeeds"],
    };
  } finally {
    // Delete bytes via the Storage API before metadata and identity cleanup.
    const failures = [];
    const cleanup = async (operation, label) => {
      try { const result = await operation(); if (result?.error) throw result.error; }
      catch { failures.push(new Error(`Owned Storage proof cleanup failed: ${label}`)); }
    };
    if (bucketCreated) {
      await cleanup(() => admin.storage.emptyBucket(bucket), "empty bucket");
      await cleanup(() => admin.storage.deleteBucket(bucket), "delete bucket");
    }
    if (schemaCreated) {
      for (const suffix of ["read", "write", "delete"]) {
        await cleanup(() => sql.query(`drop policy ${prefix}_${suffix} on storage.objects`), `policy ${suffix}`);
      }
      await cleanup(() => sql.query(`drop function private.${prefix}()`), "function");
      await cleanup(() => sql.query(`drop table private.${prefix}`), "table");
    }
    if (userId) await cleanup(() => admin.auth.admin.deleteUser(userId), "identity");
    await cleanup(() => sql.end(), "connection");
    // eslint-disable-next-line no-unsafe-finally -- cleanup failures must fail the proof even after its assertions ran
    if (failures.length) throw new AggregateError(failures, "Storage proof cleanup incomplete");
  }
  if (proof && process.env.PRIVATE_FILE_STORAGE_PROOF_ARTIFACT) writeFileSync(
    process.env.PRIVATE_FILE_STORAGE_PROOF_ARTIFACT, JSON.stringify({ ...proof, cleanup: "passed" }, null, 2) + "\n",
  );
}, 90000);
