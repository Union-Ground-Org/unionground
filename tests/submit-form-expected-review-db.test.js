// @vitest-environment node
//
// BUG-UG-FORM-SUBMIT-FILES-CONTENT-THE-SUBMITTER-NEVER-SAW-20261114 (#8705).
// Submitting a form files only what the submitter reviewed (gate stage 146 on
// #8700, finding r8s1). submit_form filed the row as it stood with whatever
// filer signature was current, so another session that replaced the answers
// or attachments and signed the replacement after this device's last check
// had its content filed by this device's Submit. It now takes an optional
// p_expected, the object sign_member_form takes, and compares it under the
// form lock before the signature check and filing. Null keeps the previous
// behaviour for clients that do not send it yet.
//
// Full migrated disposable database only. Fixtures are fictional and committed
// to the owned stack, and removed afterwards (best effort for filed forms).
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { sealFormAnswers } from "../api/_lib/sensitiveContent.js";
import { sensitiveKeyring } from "../api/_lib/sensitiveDataCrypto.js";

const STEM = "submit_form_expected_review";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("submit_form compares the reviewed content (static)", () => {
  let migration = "";
  beforeAll(() => { migration = stripComments(loadMigrationSql(STEM)); });

  it("replaces the one-argument function with one whose second argument defaults to null, with the same grants", () => {
    expect(findMigrationName(STEM) > "20261113115000").toBe(true);
    expect(migration).toContain("drop function public.submit_form(uuid);");
    expect(migration).toContain("create function public.submit_form(p_form_id uuid, p_expected jsonb default null)");
    expect(migration).toContain("revoke all on function public.submit_form(uuid, jsonb) from public, anon;");
    expect(migration).toContain("grant execute on function public.submit_form(uuid, jsonb) to authenticated, service_role;");
  });

  it("keeps the case-graph entry and compares under the form lock, after the attachment waits and before the signature check and filing", () => {
    const at = (needle) => {
      const index = migration.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    expect(at("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);")).toBeLessThan(at("private.mfa_satisfied()"));
    expect(at("perform private.lock_member_form(p_form_id);")).toBeLessThan(at("if p_expected is not null then"));
    expect(at("wait for every attachment inspection to finish")).toBeLessThan(at("if p_expected is not null then"));
    expect(at("detail = 'form_changed_since_review'")).toBeLessThan(at("signature.content_digest <> current_digest"));
    expect(at("detail = 'form_changed_since_review'")).toBeLessThan(at("update public.member_forms set status='submitted'"));
    expect(migration).toContain("(rec.encrypted_content #>> '{answers,dataVersion}')");
    expect(migration).not.toContain("errcode = '40001'");
  });

  it("pins the new signature in the database contract and the required proof lane", () => {
    const entry = contract.functions.find((row) => row.sig === "public.submit_form(p_form_id uuid, p_expected jsonb)");
    expect(entry?.exec).toBe("authenticated,service_role");
    for (const needle of entry.bodyContains) expect(migration, needle).toContain(needle);
    expect(contract.functions.some((row) => row.sig === "public.submit_form(p_form_id uuid)")).toBe(false);
    expect(contract.functionsAbsent.some((row) => row.sig === "public.submit_form(p_form_id uuid)")).toBe(true);
    expect(PROOF_FILES).toContain("tests/submit-form-expected-review-db.test.js");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("submit_form compares the reviewed content on a disposable database", () => {
  let admin, tab, other, required;
  const ids = { member: randomUUID(), org: randomUUID(), tabSession: randomUUID(), otherSession: randomUUID() };
  const chapter = `submit-review-${ids.org.slice(0, 8)}`;
  const strokes = JSON.stringify([[{ x: 0, y: 0 }, { x: 1, y: 1 }]]);
  const ring = sensitiveKeyring("saas", { SENSITIVE_DATA_KEYS: JSON.stringify({ v1: randomBytes(32).toString("base64") }), SENSITIVE_DATA_ACTIVE_KEY: "v1" });
  const forms = [];

  // Two sessions of the same member: the tab that reviews and submits, and the
  // other device that replaces and re-signs in between.
  const begin = async (client, session) => {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: ids.member, role: "authenticated", session_id: session, aal: "aal2" })]);
    await client.query("set local role authenticated");
  };
  const call = async (client, session, sql, values = []) => {
    await begin(client, session);
    try {
      const result = await client.query(sql, values);
      await client.query("commit");
      return { rows: result.rows };
    } catch (error) {
      await client.query("rollback");
      return { code: error.code, message: error.message, detail: error.detail };
    }
  };
  const session = (client) => (client === tab ? ids.tabSession : ids.otherSession);
  const save = async (client, answers) => {
    const saved = await call(client, session(client), "select public.save_form_draft('grievance',$1,0) id", [answers]);
    expect(saved.code, saved.message).toBeUndefined();
    return saved.rows[0].id;
  };
  const sign = async (client, formId) => {
    const signed = await call(client, session(client), "select public.sign_member_form($1,$2::jsonb,true) v", [formId, strokes]);
    expect(signed.code, signed.message).toBeUndefined();
  };
  const submit = (formId, expected) => expected === undefined
    ? call(tab, ids.tabSession, "select public.submit_form($1) v", [formId])
    : call(tab, ids.tabSession, "select public.submit_form($1,$2::jsonb) v", [formId, JSON.stringify(expected)]);
  const status = async (formId) => (await admin.query("select status from public.member_forms where id=$1", [formId])).rows[0].status;
  const expectRefused = (result) => {
    expect(result.code, result.message).toBe("PT409");
    expect(result.detail).toBe("form_changed_since_review");
  };
  const answers = (summary) => ({ ...Object.fromEntries(required.map((key) => [key, key.includes("date") ? "2026-11-02" : `Fictional ${key}`])), summary });
  const discard = async (formId) => {
    await admin.query("delete from public.member_form_files where form_id=$1", [formId]);
    await admin.query("delete from private.private_upload_scans where object_name like $1", [`${formId}/%`]);
    await admin.query("begin; set local session_replication_role=replica");
    await admin.query("delete from storage.objects where bucket_id='member-form-files' and name like $1", [`${formId}/%`]);
    await admin.query("delete from public.member_forms where id=$1", [formId]);
    await admin.query("commit");
  };
  const waitingOnLock = async (pid) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await admin.query("select wait_event_type = 'Lock' w from pg_stat_activity where pid=$1", [pid])).rows[0]?.w === true) return true;
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    return false;
  };

  // A confirmed, currently inspected attachment, installed the way the upload
  // pipeline leaves it (as in sign-member-form-expected-review-db.test.js).
  async function attach(formId, objectName) {
    await admin.query("begin");
    try {
      const object = (await admin.query(`insert into storage.objects(bucket_id,name,owner,version,metadata)
        values('member-form-files',$1,$2,'proof-version','{"size":1024,"mimetype":"application/pdf"}') returning id`, [objectName, ids.member])).rows[0].id;
      await admin.query(`insert into private.private_upload_scans(bucket_id,object_name,object_id,object_version,status,sha256,engine,signature_version,signature_updated_at,scanned_at,clean_until)
        values('member-form-files',$1,$2,'proof-version','clean',repeat('a',64),'clamav',1,now(),now(),now() + interval '1 day')
        on conflict (bucket_id, object_name) do update set object_id=excluded.object_id, object_version=excluded.object_version, status='clean', sha256=excluded.sha256,
          engine=excluded.engine, signature_version=excluded.signature_version, signature_updated_at=excluded.signature_updated_at, scanned_at=excluded.scanned_at, clean_until=excluded.clean_until, deleted_at=null`, [objectName, object]);
      const file = (await admin.query(`insert into public.member_form_files(form_id,object_name,filename,mime_type,size_bytes,uploaded_by,confirmed_at)
        values($1,$2,'statement.pdf','application/pdf',1024,$3,now()) returning id`, [formId, objectName, ids.member])).rows[0].id;
      await admin.query("commit");
      return file;
    } catch (error) {
      await admin.query("rollback");
      throw error;
    }
  }

  // A sealed FMLA save through the real staged path; returns the stored version.
  async function saveSealed(client, formId, values, expectedVersion) {
    const envelope = sealFormAnswers(values, { id: formId, organization_id: ids.org }, ring);
    const args = { p_form_id: formId, p_step: 1, p_changed: true, p_filled: Object.keys(values), p_data_version: envelope.dataVersion, p_expected_data_version: expectedVersion };
    await admin.query("begin; set local role service_role");
    const ticket = (await admin.query("select public.stage_sensitive_write($1,'save_sealed_form_draft',$2,$3) as ticket", [ids.member, args, { answers: envelope }])).rows[0].ticket;
    await admin.query("commit");
    const written = await call(client, session(client), "select public.write_sensitive_content('save_sealed_form_draft',$1,$2,$3) as id", [args, { answers: envelope }, ticket]);
    expect(written.code, written.message).toBeUndefined();
    return envelope.dataVersion;
  }

  beforeAll(async () => {
    const url = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    [admin, tab, other] = [0, 1, 2].map(() => new pg.Client({ connectionString: url }));
    await Promise.all([admin.connect(), tab.connect(), other.connect()]);
    await admin.query("begin");
    await admin.query("insert into auth.users(id,email) values($1,$2)", [ids.member, `${ids.member}@submit-review-proof.invalid`]);
    for (const id of [ids.tabSession, ids.otherSession]) {
      await admin.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [id, ids.member]);
    }
    await admin.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic factor','totp','verified',now(),now())", [randomUUID(), ids.member]);
    await admin.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$3,$4)", [ids.org, chapter, `Fictional Submit Proof Local ${chapter}`, ids.member]);
    await admin.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9909)", [chapter, ids.org]);
    await admin.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,false)", [ids.org]);
    await admin.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.org, ids.member]);
    await admin.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now())", [ids.member, chapter]);
    await admin.query("update public.member_profiles set chapter_id=$2 where id=$1", [ids.member, chapter]);
    await admin.query("commit");
    required = (await admin.query("select private.form_required_keys('grievance', (select max(version) from public.form_templates where key='grievance' and is_platform_seed)) keys")).rows[0].keys;
  });

  afterAll(async () => {
    try {
      const owned = (await admin.query("select id from public.member_forms where user_id=$1", [ids.member])).rows.map((row) => row.id);
      for (const formId of new Set([...forms, ...owned])) await discard(formId).catch(() => admin.query("rollback").catch(() => {}));
    } finally {
      await Promise.all([admin, tab, other].map((client) => client?.end()));
    }
  });

  it("exposes only the two-argument function, to authenticated and service_role", async () => {
    const row = (await admin.query(`select to_regprocedure('public.submit_form(uuid)') old,
      has_function_privilege('anon','public.submit_form(uuid,jsonb)','execute') anon,
      has_function_privilege('authenticated','public.submit_form(uuid,jsonb)','execute') authed`)).rows[0];
    expect(row).toEqual({ old: null, anon: false, authed: true });
  });

  it("files a form whose stored answers and attachments are the reviewed ones", async () => {
    const reviewed = answers("Fictional overtime rotation skipped");
    const formId = await save(tab, reviewed);
    forms.push(formId);
    await sign(tab, formId);
    const filed = await submit(formId, { answers: reviewed, attachmentIds: [] });
    expect(filed.code, filed.message).toBeUndefined();
    expect(await status(formId)).toBe("submitted");
  });

  it("refuses content another session replaced and re-signed after review, and files nothing", async () => {
    const reviewed = answers("Fictional schedule change, as reviewed");
    const formId = await save(tab, reviewed);
    forms.push(formId);
    await sign(tab, formId);
    // The other device replaces the answers and signs the replacement.
    await save(other, answers("Fictional schedule change, replaced on the phone"));
    await sign(other, formId);
    expectRefused(await submit(formId, { answers: reviewed, attachmentIds: [] }));
    expect(await status(formId)).toBe("draft");
    // Without p_expected the old behaviour stays: the replacement is filed
    // (the store builds that do not send it yet keep working).
    const legacy = await submit(formId);
    expect(legacy.code, legacy.message).toBeUndefined();
    expect(await status(formId)).toBe("submitted");
  });

  it("refuses an attachment confirmed after review, and files once it is named", async () => {
    const reviewed = answers("Fictional missed break");
    const formId = await save(tab, reviewed);
    forms.push(formId);
    const file = await attach(formId, `${formId}/statement.pdf`);
    await sign(other, formId);
    expectRefused(await submit(formId, { answers: reviewed, attachmentIds: [] }));
    expect(await status(formId)).toBe("draft");
    expect((await submit(formId, { answers: reviewed, attachmentIds: [file.toUpperCase()] })).code).toBeUndefined();
    expect(await status(formId)).toBe("submitted");
  });

  it("refuses an expectation that does not name what it needs, and files nothing", async () => {
    const reviewed = answers("Fictional shape check");
    const formId = await save(tab, reviewed);
    forms.push(formId);
    await sign(tab, formId);
    for (const expected of [[], "answers", { dataVersion: "v1", attachmentIds: [] }, { answers: reviewed }, { answers: reviewed, attachmentIds: "none" }]) {
      expect((await submit(formId, expected)).code, JSON.stringify(expected)).toBe("22023");
    }
    expect(await status(formId)).toBe("draft");
  });

  it("refuses a sealed FMLA form whose version moved and was re-signed after review, and files the reviewed version", async () => {
    const draft = (await call(tab, ids.tabSession, "select public.prepare_sealed_form('fmla_self') as draft")).rows[0].draft;
    const formId = draft.formId;
    forms.push(formId);
    const sealedKeys = (await admin.query("select private.form_required_keys(f.template_key, f.template_version) k from public.member_forms f where f.id=$1", [formId])).rows[0].k;
    const values = (value) => Object.fromEntries(sealedKeys.map((key) => [key, value]));
    const reviewed = await saveSealed(tab, formId, values("2027-01-01"), null);
    await sign(tab, formId);
    const moved = await saveSealed(other, formId, values("2027-02-01"), reviewed);
    await sign(other, formId);
    expectRefused(await submit(formId, { dataVersion: reviewed, attachmentIds: [] }));
    expect(await status(formId)).toBe("draft");
    // Answers do not stand in for the version on a sealed form.
    expect((await submit(formId, { answers: { sealed: true }, attachmentIds: [] })).code).toBe("22023");
    const filed = await submit(formId, { dataVersion: moved, attachmentIds: [] });
    expect(filed.code, filed.message).toBeUndefined();
    expect(await status(formId)).toBe("submitted");
  });

  it("refuses a submission that waited on the form lock while another session replaced and re-signed", async () => {
    const reviewed = answers("Fictional seniority bypass, as reviewed");
    const formId = await save(tab, reviewed);
    forms.push(formId);
    await sign(tab, formId);
    // The other device's replace-and-sign holds the form lock, uncommitted.
    await begin(other, ids.otherSession);
    await other.query("select public.save_form_draft('grievance',$1,0)", [answers("Fictional seniority bypass, replaced elsewhere")]);
    await other.query("select public.sign_member_form($1,$2::jsonb,true)", [formId, strokes]);
    const tabPid = (await tab.query("select pg_backend_pid() pid")).rows[0].pid;
    const pending = submit(formId, { answers: reviewed, attachmentIds: [] });
    expect(await waitingOnLock(tabPid)).toBe(true);
    await other.query("commit");
    expectRefused(await pending);
    expect(await status(formId)).toBe("draft");
  });
});
