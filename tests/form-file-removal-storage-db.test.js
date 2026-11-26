// @vitest-environment node
//
// BUG-UG-FORM-FILE-WITH-UNFINISHED-SAFETY-CHECK-CANNOT-BE-REMOVED-20261112 (#8569)
//
// A form attachment whose safety check never finished stays unconfirmed, and
// row security hides an unconfirmed object from the member's own Storage
// delete: Storage answered without an error, removed nothing, and finalize then
// refused with raw text. api/sensitive-form-files.js "remove" now marks the
// file with the member's own token, deletes the object that call names with the
// service role, and finalizes as the member. This proof runs that route against
// the real Storage server of the owned disposable stack.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { expect, it, vi } from "vitest";
import handler from "../api/sensitive-form-files.js";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const databaseIt = process.env.RUN_PRIVATE_FILE_STORAGE_DB_TESTS === "1" ? it : it.skip;

function response() {
  return { status(code) { this.code = code; return this; }, setHeader() { return this; }, end(body) { this.body = body ? JSON.parse(body) : null; } };
}

databaseIt("removes a member's own unconfirmed form file through the server without ever making it readable", async () => {
  const connectionString = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  const status = JSON.parse(readFileSync(process.env.PRIVATE_FILE_STORAGE_STATUS_FILE, "utf8"));
  const apiUrl = new URL(status.API_URL);
  expect(["127.0.0.1", "localhost"]).toContain(apiUrl.hostname);
  expect(Number(apiUrl.port)).toBe(Number(new URL(connectionString).port) - 1);
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, options);
  const sql = new pg.Client({ connectionString });
  await sql.connect();
  const suffix = randomBytes(5).toString("hex");
  const org = randomUUID();
  const chapter = `form-removal-proof-${suffix}`;
  const users = [];
  const forms = [];
  const bytes = Buffer.from("Synthetic form-removal fixture");
  vi.stubEnv("VITE_SUPABASE_URL", status.API_URL);
  // This edition's provider boundary admits a loopback backend only with the
  // project ref `local` (api/_lib/providerBoundary.js).
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "local");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", status.ANON_KEY);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", status.SERVICE_ROLE_KEY);
  const objectExists = async (row) => (await sql.query("select count(*)::int c from storage.objects where bucket_id=$1 and name=$2", [row.bucketId, row.objectName])).rows[0].c === 1;
  const fileRow = async (row) => (await sql.query("select deletion_requested_at is not null requested from public.member_form_files where id=$1", [row.id])).rows[0] ?? null;
  try {
    await sql.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$3,null)", [org, chapter, `Fictional Tamarack Valley Local ${suffix}`]);
    await sql.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9921)", [chapter, org]);
    const member = async (label) => {
      const email = `form-removal-${label}-${suffix}@example.invalid`;
      const secret = `Synthetic!${randomBytes(24).toString("base64url")}`;
      const created = await admin.auth.admin.createUser({ email, password: secret, email_confirm: true });
      if (created.error) throw created.error;
      const id = created.data.user.id;
      users.push(id);
      await sql.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, id]);
      await sql.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, chapter]);
      await sql.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapter]);
      const caller = createClient(status.API_URL, status.ANON_KEY, options);
      const session = await caller.auth.signInWithPassword({ email, password: secret });
      if (session.error) throw session.error;
      const form = randomUUID();
      forms.push(form);
      await sql.query("insert into public.member_forms(id,user_id,template_key) values($1,$2,'grievance')", [form, id]);
      return { id, caller, form, token: session.data.session.access_token };
    };
    const attach = async (who, name) => {
      const registered = await who.caller.rpc("register_member_form_file", { p_form_id: who.form, p_filename: name, p_mime_type: "text/plain", p_size_bytes: bytes.length });
      if (registered.error) throw registered.error;
      const row = { id: registered.data.id, bucketId: registered.data.bucketId, objectName: registered.data.objectName };
      const upload = await who.caller.storage.from(row.bucketId).upload(row.objectName, bytes, { contentType: "text/plain", upsert: false });
      if (upload.error) throw upload.error;
      return row;
    };
    const remove = async (who, row) => {
      const res = response();
      await handler({ method: "POST", headers: { host: "unionground.net", authorization: `Bearer ${who.token}` }, body: { action: "remove", fileId: row.id } }, res);
      return res;
    };
    const readable = async (who, row) => !(await who.caller.storage.from(row.bucketId).download(row.objectName)).error;
    const alex = await member("alex");
    const blair = await member("blair");

    // 1. Unconfirmed: its scan never finished. Before #8569 this could not be removed.
    const pending = await attach(alex, "pending.txt");
    await sql.query("update public.member_forms set filer_signed_at=now() where id=$1", [alex.form]);
    expect(await readable(alex, pending)).toBe(false);
    const removedPending = await remove(alex, pending);
    expect(removedPending.code).toBe(200);
    expect(removedPending.body).toEqual({ fileId: pending.id, status: "removed", receipt: { deleted: true, id: pending.id } });
    expect(await objectExists(pending)).toBe(false);
    expect(await fileRow(pending)).toBeNull();
    expect((await sql.query("select filer_signed_at from public.member_forms where id=$1", [alex.form])).rows[0].filer_signed_at).toBeNull();

    // 2. Confirmed: a clean verdict and confirmation, the state a finished upload reaches.
    const confirmed = await attach(alex, "confirmed.txt");
    await sql.query(`update private.private_upload_scans set status='clean', sha256=$3, engine='ClamAV 1.5.4', signature_version=28113,
      signature_updated_at=now(), scanned_at=now(), clean_until=now() + interval '1 hour' where bucket_id=$1 and object_name=$2`,
    [confirmed.bucketId, confirmed.objectName, createHash("sha256").update(bytes).digest("hex")]);
    const confirm = await alex.caller.rpc("confirm_member_form_file", { p_file_id: confirmed.id });
    expect(confirm.error).toBeNull();
    expect((await remove(alex, confirmed)).code).toBe(200);
    expect(await objectExists(confirmed)).toBe(false);
    expect(await fileRow(confirmed)).toBeNull();

    // 3. Someone else's file: refused before anything is marked or deleted.
    const othersFile = await attach(alex, "not-blairs.txt");
    const foreign = await remove(blair, othersFile);
    expect(foreign.code).toBe(403);
    expect(await objectExists(othersFile)).toBe(true);
    expect(await fileRow(othersFile)).toEqual({ requested: false });

    // 4. A submitted form: its files are part of the filing and stay.
    const filed = await attach(blair, "filed.txt");
    await sql.query("update public.member_forms set status='submitted', submitted_at=now() where id=$1", [blair.form]);
    expect((await remove(blair, filed)).code).toBe(403);
    expect(await objectExists(filed)).toBe(true);
    expect(await fileRow(filed)).toEqual({ requested: false });

    // 5. Storage refuses the delete: no success, the mark stays, and a retry finishes it.
    const refused = await attach(alex, "refused.txt");
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method === "DELETE" && url.pathname.startsWith("/storage/v1/object/member-form-files")) {
        return Promise.resolve(new Response(JSON.stringify({ statusCode: "503", error: "Service Unavailable", message: "The service is currently unavailable" }), { status: 503, headers: { "content-type": "application/json" } }));
      }
      return realFetch(input, init);
    });
    const failed = await remove(alex, refused);
    vi.unstubAllGlobals();
    expect(failed.code).toBe(503);
    expect(failed.body).toEqual({ error: "form-file-removal-unavailable" });
    expect(await objectExists(refused)).toBe(true);
    expect(await fileRow(refused)).toEqual({ requested: true });
    expect(await readable(alex, refused)).toBe(false);
    expect((await remove(alex, refused)).code).toBe(200);
    expect(await objectExists(refused)).toBe(false);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    // Leave no fixture behind in the shared proof schema.
    const objects = (await sql.query("select bucket_id, name from storage.objects where bucket_id='member-form-files' and name in (select object_name from public.member_form_files where form_id = any($1::uuid[]))", [forms])).rows;
    if (objects.length) await admin.storage.from("member-form-files").remove(objects.map((row) => row.name));
    await sql.query("delete from public.member_form_files where form_id = any($1::uuid[])", [forms]);
    await sql.query("delete from public.member_forms where id = any($1::uuid[])", [forms]);
    await sql.query("delete from public.member_chapter_memberships where chapter_id=$1", [chapter]);
    await sql.query("delete from public.organization_memberships where organization_id=$1", [org]);
    for (const id of users) await admin.auth.admin.deleteUser(id);
    // Each membership mints a dues subject row for the organization.
    await sql.query("delete from public.dues_member_subjects where organization_id=$1", [org]);
    await sql.query("delete from public.chapters where id=$1", [chapter]);
    await sql.query("delete from public.organizations where id=$1", [org]);
    await sql.end();
  }
}, 120_000);
