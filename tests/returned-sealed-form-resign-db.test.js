// @vitest-environment node
// Full migrated disposable database only. Fixtures are committed to this owned
// stack like the other sealed-form proofs; the stack is destroyed afterwards.
import { scopeFixtureSteward } from "./helpers/steward-unit-fixtures.js";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { sealFormAnswers } from "../api/_lib/sensitiveContent.js";
import { sensitiveKeyring } from "../api/_lib/sensitiveDataCrypto.js";

const migration = readFileSync(new URL("../supabase/migrations/20261028211500_returned_sealed_form_resign.sql", import.meta.url), "utf8");
const runner = readFileSync(new URL("../scripts/run-required-db-proofs.mjs", import.meta.url), "utf8");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("returned sealed form re-sign (static)", () => {
  it("keeps the frozen digest only for a frozen status with its own digest, and is in the proof lane and the contract", () => {
    expect(migration).toContain("and f.status in ('submitted', 'in_review', 'approved')\n    and f.content_digest = f.answers->>'legacyDigest' then f.answers->>'legacyDigest'");
    // #6363's conditions stay: only a sealed template's stored envelope makes the marker authoritative.
    expect(migration).toContain("select case when private.form_template_is_sealed(f.template_key) and f.encrypted_content ? 'answers'");
    expect(PROOF_FILES).toContain("tests/returned-sealed-form-resign-db.test.js");
    expect(runner).toContain('RUN_RETURNED_SEALED_FORM_RESIGN_DB_TESTS: "1"');
    const entry = contract.functions.find((fn) => fn.sig === "private.form_content_digest(p_form_id uuid)");
    expect(entry.bodyContains).toEqual(expect.arrayContaining([
      "f.status in ('submitted', 'in_review', 'approved')", "f.content_digest = f.answers->>'legacyDigest'"]));
  });
});

const live = process.env.RUN_RETURNED_SEALED_FORM_RESIGN_DB_TESTS === "1" ? describe : describe.skip;

// BUG-UG-RETURNED-SEALED-FORM-ATTACHMENTS-RESIGN-20261026: a backfilled
// sealed filing keeps its frozen digest only while frozen; once a steward
// returns it, attachment changes invalidate the old signatures.
live("returned sealed form attachments", () => {
  let admin, member, steward;
  const ids = { member: randomUUID(), steward: randomUUID(), org: randomUUID(), memberSession: randomUUID(), stewardSession: randomUUID() };
  const chapter = `resign-${ids.org.slice(0, 8)}`;
  const strokes = JSON.stringify([[{ x: 0, y: 0 }, { x: 1, y: 1 }]]);
  const ring = sensitiveKeyring("saas", { SENSITIVE_DATA_KEYS: JSON.stringify({ v1: randomBytes(32).toString("base64") }), SENSITIVE_DATA_ACTIVE_KEY: "v1" });
  let formId;
  const asUser = async (client, user, session) => {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: "authenticated", session_id: session, aal: "aal2" })]);
    await client.query("set local role authenticated");
  };
  const call = async (client, user, session, sql, values = []) => {
    await asUser(client, user, session);
    try {
      const result = await client.query(sql, values);
      await client.query("commit");
      return { rows: result.rows };
    } catch (error) {
      await client.query("rollback");
      return { code: error.code, message: error.message };
    }
  };
  const digest = async () => (await admin.query("select private.form_content_digest($1) d", [formId])).rows[0].d;
  const status = async () => (await admin.query("select status, content_digest from public.member_forms where id=$1", [formId])).rows[0];
  const sign = () => call(member, ids.member, ids.memberSession, "select public.sign_member_form($1,$2::jsonb,true)", [formId, strokes]);
  const submit = () => call(member, ids.member, ids.memberSession, "select public.submit_form($1)", [formId]);
  const returned = () => call(steward, ids.steward, ids.stewardSession, "select public.return_form($1,'Attach the certification and sign again.')", [formId]);
  async function authUser(user, session) {
    await admin.query("insert into auth.users(id,email) values($1,$2)", [user, `${user}@resign-proof.invalid`]);
    await admin.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
    await admin.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic factor','totp','verified',now(),now())", [randomUUID(), user]);
  }
  async function enroll(user, role) {
    await admin.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.org, user]);
    await admin.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now())", [user, chapter]);
    await admin.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
    if (role) {
      // Commit each grant with its actual unit.
      await admin.query("begin");
      await admin.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [user, role, chapter]);
      await admin.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [user, role, chapter]);
      if (role === "steward") await scopeFixtureSteward(admin,user,chapter);
      await admin.query("commit");
    }
  }

  // A confirmed, currently inspected attachment: the storage object, its clean
  // scan verdict and the file row, installed the way the upload pipeline leaves them.
  async function attach(objectName) {
    await admin.query("begin");
    const object = (await admin.query(`insert into storage.objects(bucket_id,name,owner,version,metadata)
      values('member-form-files',$1,$2,'proof-version','{"size":1024,"mimetype":"application/pdf"}') returning id`, [objectName, ids.member])).rows[0].id;
    await admin.query(`insert into private.private_upload_scans(bucket_id,object_name,object_id,object_version,status,sha256,engine,signature_version,signature_updated_at,scanned_at,clean_until)
      values('member-form-files',$1,$2,'proof-version','clean',repeat('a',64),'clamav',1,now(),now(),now() + interval '1 day')
      on conflict (bucket_id, object_name) do update set object_id=excluded.object_id, object_version=excluded.object_version, status='clean', sha256=excluded.sha256,
        engine=excluded.engine, signature_version=excluded.signature_version, signature_updated_at=excluded.signature_updated_at, scanned_at=excluded.scanned_at, clean_until=excluded.clean_until, deleted_at=null`, [objectName, object]);
    await admin.query(`insert into public.member_form_files(form_id,object_name,filename,mime_type,size_bytes,uploaded_by,confirmed_at,encrypted_content)
      values($1,$2,'certification.pdf','application/pdf',1024,$3,now(),'{"answers":{"proof":"attachment"}}'::jsonb)`, [formId, objectName, ids.member]);
    await admin.query("commit");
  }

  beforeAll(async () => {
    const url = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    admin = new pg.Client({ connectionString: url }); member = new pg.Client({ connectionString: url }); steward = new pg.Client({ connectionString: url });
    await Promise.all([admin.connect(), member.connect(), steward.connect()]);
    await admin.query("begin");
    await authUser(ids.member, ids.memberSession);
    await admin.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [ids.org, chapter, ids.member]);
    await admin.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9907)", [chapter, ids.org]);
    await admin.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,false)", [ids.org]);
    await enroll(ids.member, null);
    await authUser(ids.steward, ids.stewardSession);
    await enroll(ids.steward, "steward");
    await admin.query("commit");
    // A sealed FMLA draft written through the real staged path, then signed and submitted.
    const draft = (await call(member, ids.member, ids.memberSession, "select public.prepare_sealed_form('fmla_self') as draft")).rows[0].draft;
    formId = draft.formId;
    const required = (await admin.query("select private.form_required_keys(f.template_key, f.template_version) k from public.member_forms f where f.id=$1", [formId])).rows[0].k;
    const envelope = sealFormAnswers(Object.fromEntries(required.map((key) => [key, "proof"])), { id: formId, organization_id: ids.org }, ring);
    const args = { p_form_id: formId, p_step: 1, p_changed: true, p_filled: required, p_data_version: envelope.dataVersion, p_expected_data_version: null };
    await admin.query("begin; set local role service_role");
    const ticket = (await admin.query("select public.stage_sensitive_write($1,'save_sealed_form_draft',$2,$3) as ticket", [ids.member, args, { answers: envelope }])).rows[0].ticket;
    await admin.query("commit");
    const written = await call(member, ids.member, ids.memberSession, "select public.write_sensitive_content('save_sealed_form_draft',$1,$2,$3) as id", [args, { answers: envelope }, ticket]);
    expect(written.code, written.message).toBeUndefined();
    expect((await sign()).code).toBeUndefined();
    const submitted = await submit();
    expect(submitted.code, submitted.message).toBeUndefined();
    expect((await status()).status).toBe("submitted");
    // Freeze it exactly as scripts/sensitive-form-maintenance.mjs does for a filing backfilled after submission.
    await admin.query("begin");
    await admin.query("select set_config('app.sensitive_maintenance','on',true)");
    await admin.query("select set_config('app.sensitive_envelopes',(select encrypted_content::text from public.member_forms where id=$1),true)", [formId]);
    await admin.query("update public.member_forms set answers = answers || jsonb_build_object('legacyDigest', private.form_content_digest(id)) where id=$1", [formId]);
    await admin.query("commit");
  });
  afterAll(async () => {
    // Leave no sealed-form rows behind for the maintenance proofs that share this stack.
    try {
      await admin.query("delete from public.member_form_files where form_id=$1", [formId]);
      await admin.query("delete from private.private_upload_scans where object_name like $1", [`${formId}/%`]);
      await admin.query("begin; set local session_replication_role=replica");
      await admin.query("delete from storage.objects where bucket_id='member-form-files' and name like $1", [`${formId}/%`]);
      await admin.query("commit");
      await admin.query("delete from public.member_forms where id=$1", [formId]);
    } finally {
      await Promise.all([admin, member, steward].map((client) => client?.end()));
    }
  });

  it("keeps the frozen digest while the filing stays submitted", async () => {
    const row = await status();
    const legacy = (await admin.query("select answers->>'legacyDigest' d from public.member_forms where id=$1", [formId])).rows[0].d;
    expect(legacy).toBe(row.content_digest);
    expect(await digest()).toBe(legacy);
  });

  it("requires a fresh signature after a return that adds an attachment, then accepts the resubmission", async () => {
    const back = await returned();
    expect(back.code, back.message).toBeUndefined();
    expect((await status()).status).toBe("returned");
    const legacy = (await admin.query("select answers->>'legacyDigest' d from public.member_forms where id=$1", [formId])).rows[0].d;
    await attach(`${formId}/certification.pdf`);
    expect(await digest()).not.toBe(legacy);
    const stale = await submit();
    expect(stale.code).toBe("22023");
    expect(stale.message).toContain("draw and save a current signature");
    expect((await sign()).code).toBeUndefined();
    const fresh = await submit();
    expect(fresh.code, fresh.message).toBeUndefined();
    const row = await status();
    expect(row.status).toBe("submitted");
    expect(row.content_digest).not.toBe(legacy);
    expect(await digest()).toBe(row.content_digest);
  });

  it("requires a fresh signature again after a return that removes the attachment", async () => {
    const back = await returned();
    expect(back.code, back.message).toBeUndefined();
    const before = (await status()).content_digest;
    await admin.query("delete from public.member_form_files where form_id=$1", [formId]);
    expect(await digest()).not.toBe(before);
    const stale = await submit();
    expect(stale.code).toBe("22023");
    expect((await sign()).code).toBeUndefined();
    const fresh = await submit();
    expect(fresh.code, fresh.message).toBeUndefined();
    expect((await status()).status).toBe("submitted");
  });
});
