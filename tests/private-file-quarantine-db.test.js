// @vitest-environment node
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const databaseIt = process.env.RUN_PRIVATE_FILE_STORAGE_DB_TESTS === "1" ? it : it.skip;
const BUCKETS = ["case-files", "chapter-task-files", "member-form-files", "organization-knowledge"];

databaseIt("enforces quarantine, server-only attestations and single-use stored paths in every private bucket", async () => {
  const connectionString = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  const status = JSON.parse(readFileSync(process.env.PRIVATE_FILE_STORAGE_STATUS_FILE, "utf8"));
  const api = new URL(status.API_URL);
  expect(["127.0.0.1", "localhost"]).toContain(api.hostname);
  expect(Number(api.port)).toBe(Number(new URL(connectionString).port) - 1);
  const sql = new pg.Client({ connectionString });
  await sql.connect();
  const prefix = `upload_boundary_${randomBytes(6).toString("hex")}`;
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, options);
  const caller = createClient(status.API_URL, status.ANON_KEY, options);
  const foreignCaller = createClient(status.API_URL, status.ANON_KEY, options);
  const bytes = Buffer.from("Synthetic database boundary fixture; not a scanner proof.");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const path = `${prefix}/synthetic.txt`;
  let userId;
  let foreignUserId;
  let policies = false;
  try {
    const signature = "text,text,uuid,text,text,text,text,bigint,timestamp with time zone,timestamp with time zone";
    // The path-addressed PostgREST wrapper was dropped by
    // 20260906010000_private_upload_write_path_hardening: a service-role key
    // alone must no longer be able to write a verdict for an arbitrary path.
    // The private implementation is still the ledger's only writer, reached
    // through finish_private_upload_inspection's lease in production and
    // directly (as service_role) by this isolated boundary proof.
    expect((await sql.query(`select to_regprocedure('public.record_private_upload_scan(${signature})') as fn`)).rows[0].fn).toBeNull();
    expect((await sql.query(`select to_regprocedure('private.record_private_upload_scan(${signature})') as fn`)).rows[0].fn).not.toBeNull();
    // claim is the JWT role the ledger writer authorizes against; dbRole, when
    // given, is the Postgres role the statement runs as. Splitting the two is
    // what lets this proof assert both guards: the writer's own
    // auth.role() <> 'service_role' refusal, and the fact that service_role has
    // no USAGE on the private schema now that the public wrapper is gone.
    const recordScan = async (values, claim = "service_role", dbRole = null) => {
      await sql.query("begin");
      try {
        await sql.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: claim })]);
        if (dbRole) await sql.query(`set local role ${dbRole}`);
        await sql.query(
          "select private.record_private_upload_scan($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [values.p_bucket_id, values.p_object_name, values.p_object_id, values.p_object_version,
            values.p_verdict, values.p_sha256, values.p_engine, values.p_signature_version,
            values.p_signature_updated_at, values.p_scanned_at],
        );
        await sql.query("commit");
        return { error: null };
      } catch (error) {
        await sql.query("rollback");
        return { error };
      } finally {
        await sql.query("reset role");
      }
    };
    const password = `Synthetic!${randomBytes(24).toString("base64url")}`;
    const email = `${prefix}@example.invalid`;
    const user = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (user.error) throw user.error;
    userId = user.data.user.id;
    const session = await caller.auth.signInWithPassword({ email, password });
    if (session.error) throw session.error;
    const foreignEmail = `${prefix}_foreign@example.invalid`;
    const foreignUser = await admin.auth.admin.createUser({ email: foreignEmail, password, email_confirm: true });
    if (foreignUser.error) throw foreignUser.error;
    foreignUserId = foreignUser.data.user.id;
    const foreignSession = await foreignCaller.auth.signInWithPassword({ email: foreignEmail, password });
    if (foreignSession.error) throw foreignSession.error;
    // This isolated boundary proof deliberately supplies a narrow permissive
    // authorization policy for owned fixtures. The production restrictive gate
    // must constrain it too. Feature-specific tenancy is a separate proof.
    await sql.query(`create policy ${prefix}_select on storage.objects for select to authenticated
      using (name = '${path}' and (select auth.uid()) = '${userId}'::uuid);
      create policy ${prefix}_insert on storage.objects for insert to authenticated
      with check (name = '${path}' and (select auth.uid()) = '${userId}'::uuid);
      create policy ${prefix}_delete on storage.objects for delete to authenticated
      using (name = '${path}' and (select auth.uid()) = '${userId}'::uuid);`);
    policies = true;
    for (const bucket of BUCKETS) {
      const files = caller.storage.from(bucket);
      if (bucket === "case-files") {
        expect((await files.upload(path, bytes, { contentType: "text/plain", upsert: false })).error).toBeTruthy();
        // This is a Storage quarantine proof, not a content/scanner proof.
        // Only the trusted server may now place case-file bytes.
        expect((await admin.storage.from(bucket).upload(path, bytes, { contentType: "text/plain", upsert: false })).error).toBeNull();
      } else expect((await files.upload(path, bytes, { contentType: "text/plain", upsert: false })).error).toBeNull();
      expect((await files.download(path)).error).toBeTruthy();
      expect((await files.info(path)).error).toBeTruthy();
      expect((await files.createSignedUrl(path, 3600)).error).toBeTruthy();
      const object = (await sql.query("select id, version from storage.objects where bucket_id=$1 and name=$2", [bucket, path])).rows[0];
      const args = {
        p_bucket_id: bucket, p_object_name: path, p_object_id: object.id, p_object_version: object.version,
        p_verdict: "clean", p_sha256: digest, p_engine: "ClamAV 1.5.4", p_signature_version: 28113,
        p_signature_updated_at: new Date().toISOString(), p_scanned_at: new Date().toISOString(),
      };
      expect((await recordScan(args, "authenticated")).error).toBeTruthy();
      expect((await recordScan(args, "service_role", "service_role")).error).toBeTruthy();
      expect((await recordScan(args, "service_role", "authenticated")).error).toBeTruthy();
      expect((await recordScan({ ...args, p_object_version: "wrong-version" })).error).toBeTruthy();
      expect((await recordScan({ ...args, p_signature_updated_at: new Date(Date.now() - 49 * 3600000).toISOString() })).error).toBeTruthy();
      const recorded = await recordScan(args);
      if (recorded.error) throw recorded.error;
      const download = await files.download(path);
      expect(download.error).toBeNull();
      expect(Buffer.from(await download.data.arrayBuffer())).toEqual(bytes);
      // Storage metadata authorization uses get_authenticated_info.
      // A clean verdict must admit that real endpoint as well as the bytes.
      const info = await files.info(path);
      expect(info.error).toBeNull();
      expect(info.data.size).toBe(bytes.length);
      expect((await foreignCaller.storage.from(bucket).info(path)).error).toBeTruthy();
      expect((await foreignCaller.storage.from(bucket).download(path)).error).toBeTruthy();
      const anonymous = createClient(status.API_URL, status.ANON_KEY, options);
      expect((await anonymous.storage.from(bucket).info(path)).error).toBeTruthy();
      // All caller-created signed URLs remain denied, even after scanning,
      // because they cannot re-evaluate revocation or verdict expiry.
      expect((await files.createSignedUrl(path, 3600)).error).toBeTruthy();
      expect((await files.update(path, Buffer.from("replacement"), { contentType: "text/plain" })).error).toBeTruthy();
      await sql.query("update private.private_upload_scans set scanned_at=now()-interval '2 seconds', clean_until=now()-interval '1 second' where bucket_id=$1 and object_name=$2", [bucket, path]);
      expect((await files.download(path)).error).toBeTruthy();
      expect((await files.info(path)).error).toBeTruthy();
      // A structural refusal carries no scanner provenance at all; a verdict
      // that claims only part of it is still refused.
      expect((await recordScan({ ...args, p_verdict: "blocked", p_engine: null })).error).toBeTruthy();
      expect((await recordScan({
        ...args, p_verdict: "blocked", p_sha256: null, p_engine: null,
        p_signature_version: null, p_signature_updated_at: null, p_scanned_at: null,
      })).error).toBeNull();
      expect((await files.download(path)).error).toBeTruthy();
      expect((await files.info(path)).error).toBeTruthy();
      const removed = await files.remove([path]);
      expect(removed.error).toBeNull();
      expect(removed.data).toHaveLength(1);
      expect((await sql.query("select id from storage.objects where bucket_id=$1 and name=$2", [bucket, path])).rowCount).toBe(0);
      expect((await files.upload(path, bytes, { contentType: "text/plain", upsert: false })).error).toBeTruthy();
      expect((await recordScan(args)).error).toBeTruthy();
    }
  } finally {
    const failures = [];
    const cleanup = async (operation, label) => {
      try { const result = await operation(); if (result?.error) throw result.error; }
      catch { failures.push(new Error(`Owned upload boundary cleanup failed: ${label}`)); }
    };
    for (const bucket of BUCKETS) {
      await cleanup(() => admin.storage.from(bucket).remove([path]), `bucket ${bucket}`);
    }
    if (policies) {
      for (const suffix of ["select", "insert", "delete"]) {
        await cleanup(() => sql.query(`drop policy ${prefix}_${suffix} on storage.objects`), `policy ${suffix}`);
      }
    }
    if (userId) await cleanup(() => admin.auth.admin.deleteUser(userId), "identity");
    if (foreignUserId) await cleanup(() => admin.auth.admin.deleteUser(foreignUserId), "foreign identity");
    await cleanup(() => sql.end(), "connection");
    // eslint-disable-next-line no-unsafe-finally -- cleanup failures must fail the proof even after its assertions ran
    if (failures.length) throw new AggregateError(failures, "Upload boundary cleanup incomplete");
  }
}, 90000);
