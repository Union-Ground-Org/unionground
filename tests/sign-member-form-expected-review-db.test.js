// @vitest-environment node
//
// BUG-UG-FORM-SIGNATURE-SIGNS-ANSWERS-THE-SIGNER-NEVER-SAW-20261113 (#8702).
// A form signature covers only what the signer reviewed (gate stage 138 on
// #8700, r3s2; stage 139, r5s2 and r6s1). sign_member_form signed whatever the
// row held when it took the form lock, so a save or an attachment from another
// session between the reviewed save and the signature was signed unseen. It now
// takes an optional p_expected (sealed: dataVersion; ordinary: answers; always
// the confirmed attachment ids shown) and compares it under the form lock.
// save_form_draft takes an optional expected form id (stage 139, r5s1), so a
// retried save never creates a second draft of a filed form. Null keeps the
// previous behaviour for clients that do not send them yet.
//
// Full migrated disposable database only. Fixtures are fictional and committed
// to the owned stack, and removed afterwards.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { sealFormAnswers } from "../api/_lib/sensitiveContent.js";
import { sensitiveKeyring } from "../api/_lib/sensitiveDataCrypto.js";

const STEM = "sign_member_form_expected_review";
// The typed-signature migration (#8701) re-emits sign_member_form with one more
// optional argument and this expected-review block unchanged; the live
// definition is that five-argument function.
const SIG = "public.sign_member_form(p_form_id uuid, p_strokes jsonb, p_consent boolean, p_expected jsonb DEFAULT NULL::jsonb, p_typed_name text DEFAULT NULL::text)";
const TYPED_STEM = "forms_typed_signature";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("sign_member_form compares the reviewed version (static)", () => {
  let migration = "";
  beforeAll(() => { migration = stripComments(loadMigrationSql(STEM)); });

  it("replaces the three-argument function with one whose fourth argument defaults to null, with the same grants", () => {
    expect(findMigrationName(STEM) > "20261113114000").toBe(true);
    expect(migration).toContain("drop function public.sign_member_form(uuid, jsonb, boolean);");
    expect(migration).toContain("p_form_id uuid, p_strokes jsonb, p_consent boolean, p_expected jsonb default null");
    expect(migration).toContain("revoke all on function public.sign_member_form(uuid, jsonb, boolean, jsonb) from public, anon;");
    expect(migration).toContain("grant execute on function public.sign_member_form(uuid, jsonb, boolean, jsonb) to authenticated, service_role;");
  });

  it("keeps the case-graph entry and compares under the form lock before the digest", () => {
    const at = (needle) => {
      const index = migration.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    expect(at("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);")).toBeLessThan(at("private.mfa_satisfied()"));
    expect(at("perform private.lock_member_form(p_form_id);")).toBeLessThan(at("if p_expected is not null then"));
    expect(at("wait for every attachment upload to finish")).toBeLessThan(at("if p_expected is not null then"));
    expect(at("errcode = 'PT409'")).toBeLessThan(at("current_digest := private.form_content_digest(p_form_id);"));
    expect(migration).toContain("detail = 'form_changed_since_review'");
    expect(migration).toContain("(rec.encrypted_content #>> '{answers,dataVersion}')");
    expect(migration).toContain("(p_expected->'answers') is distinct from rec.answers");
    expect(migration).toContain("pg_catalog.jsonb_typeof(p_expected->'attachmentIds') is distinct from 'array'");
    expect(migration).not.toContain("errcode = '40001'");
  });

  it("checks the expected form id of a save under the form lock before anything is created or written", () => {
    const save = migration.slice(migration.indexOf("CREATE FUNCTION public.save_form_draft("));
    const at = (needle) => {
      const index = save.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    expect(migration).toContain("drop function public.save_form_draft(text, jsonb, integer);");
    expect(save).toContain("p_step integer, p_expected_form_id uuid DEFAULT NULL::uuid)");
    expect(at("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);")).toBeLessThan(at("private.mfa_satisfied()"));
    expect(at("perform private.lock_member_form(p_expected_form_id);")).toBeLessThan(at("detail = 'form_not_editable'"));
    expect(at("detail = 'form_not_editable'")).toBeLessThan(at("insert into public.member_forms"));
    expect(save).toContain("raise exception 'sealed form templates save through the sensitive content API' using errcode = '22023';");
    expect(migration).toContain("grant execute on function public.save_form_draft(text, jsonb, integer, uuid) to authenticated, service_role;");
  });

  it("pins the new signature in the database contract and the required proof lane", () => {
    const entry = contract.functions.find((row) => row.sig === "public.sign_member_form(p_form_id uuid, p_strokes jsonb, p_consent boolean, p_expected jsonb, p_typed_name text)");
    expect(entry?.exec).toBe("authenticated,service_role");
    expect(entry.bodyContains).toEqual(expect.arrayContaining(["form_changed_since_review", "private.lock_member_form(p_form_id)", "private.mfa_satisfied()"]));
    const final = stripComments(loadMigrationSql(TYPED_STEM));
    for (const needle of entry.bodyContains) expect(final, needle).toContain(needle);
    // The expected-review block is carried into the final definition verbatim.
    const block = (sql) => sql.slice(sql.indexOf("  if p_expected is not null then"), sql.indexOf("  current_digest := private.form_content_digest(p_form_id);", sql.indexOf("  if p_expected is not null then")));
    expect(block(final)).toBe(block(migration));
    expect(block(migration)).toContain("detail = 'form_changed_since_review'");
    expect(contract.functions.some((row) => row.sig === "public.sign_member_form(p_form_id uuid, p_strokes jsonb, p_consent boolean)")).toBe(false);
    // #8719 re-emits save_form_draft with a fifth argument; the expected form
    // id check this migration added must stay in the pinned successor.
    const save = contract.functions.find((row) => row.sig.startsWith("public.save_form_draft(p_template_key text, p_answers jsonb, p_step integer, p_expected_form_id uuid"));
    expect(save?.exec).toBe("authenticated,service_role");
    for (const needle of ["perform private.lock_member_form(p_expected_form_id);", "detail = 'form_not_editable'"]) {
      expect(save.bodyContains, needle).toContain(needle);
      expect(migration, needle).toContain(needle);
    }
    expect(PROOF_FILES).toContain("tests/sign-member-form-expected-review-db.test.js");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("sign_member_form compares the reviewed version on a disposable database", () => {
  let admin, tab, other;
  const ids = { member: randomUUID(), org: randomUUID(), tabSession: randomUUID(), otherSession: randomUUID() };
  const chapter = `sign-review-${ids.org.slice(0, 8)}`;
  const strokes = JSON.stringify([[{ x: 0, y: 0 }, { x: 1, y: 1 }]]);
  const ring = sensitiveKeyring("saas", { SENSITIVE_DATA_KEYS: JSON.stringify({ v1: randomBytes(32).toString("base64") }), SENSITIVE_DATA_ACTIVE_KEY: "v1" });
  const forms = [];

  // Two sessions of the same member: the tab that reviews and signs, and the
  // other device that saves in between.
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
  const saveOrdinary = async (client, session, answers) => {
    const saved = await call(client, session, "select public.save_form_draft('grievance',$1,0) id", [answers]);
    expect(saved.code, saved.message).toBeUndefined();
    return saved.rows[0].id;
  };
  const saveExpecting = (formId, answers, templateKey = "grievance") =>
    call(tab, ids.tabSession, "select public.save_form_draft($1,$2,0,$3) id", [templateKey, answers, formId]);
  const openForms = async () => (await admin.query("select id from public.member_forms where user_id=$1 and template_key='grievance' and status in ('draft','returned') order by created_at", [ids.member])).rows.map((row) => row.id);
  // Waits (bounded) until the given backend is blocked on a lock.
  const waitingOnLock = async (pid) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await admin.query("select wait_event_type = 'Lock' w from pg_stat_activity where pid=$1", [pid])).rows[0]?.w === true) return true;
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    return false;
  };
  const sign = (formId, expected) => expected === undefined
    ? call(tab, ids.tabSession, "select public.sign_member_form(p_form_id => $1, p_strokes => $2::jsonb, p_consent => true) v", [formId, strokes])
    : call(tab, ids.tabSession, "select public.sign_member_form($1,$2::jsonb,true,$3::jsonb) v", [formId, strokes, JSON.stringify(expected)]);
  const signature = async (formId) => (await admin.query(`select f.filer_signature_digest, f.content_digest,
      (select count(*)::int from private.member_form_signatures s where s.form_id = f.id and s.signer_kind = 'filer') rows
    from public.member_forms f where f.id = $1`, [formId])).rows[0];
  const expectRefused = (result) => {
    expect(result.code, result.message).toBe("PT409");
    expect(result.detail).toBe("form_changed_since_review");
  };
  const discard = async (formId) => {
    await admin.query("delete from public.member_form_files where form_id=$1", [formId]);
    await admin.query("delete from private.private_upload_scans where object_name like $1", [`${formId}/%`]);
    await admin.query("begin; set local session_replication_role=replica");
    await admin.query("delete from storage.objects where bucket_id='member-form-files' and name like $1", [`${formId}/%`]);
    await admin.query("commit");
    await admin.query("delete from public.member_forms where id=$1", [formId]);
  };

  // A confirmed, currently inspected attachment, installed the way the upload
  // pipeline leaves it (as in returned-sealed-form-resign-db.test.js). With
  // hold, the confirmation keeps the form lock, uncommitted, as a website
  // upload confirming in another session does; the caller commits.
  async function attach(formId, objectName, { hold = false } = {}) {
    await admin.query("begin");
    try {
      if (hold) await admin.query("select private.lock_member_form($1)", [formId]);
      const object = (await admin.query(`insert into storage.objects(bucket_id,name,owner,version,metadata)
        values('member-form-files',$1,$2,'proof-version','{"size":1024,"mimetype":"application/pdf"}') returning id`, [objectName, ids.member])).rows[0].id;
      await admin.query(`insert into private.private_upload_scans(bucket_id,object_name,object_id,object_version,status,sha256,engine,signature_version,signature_updated_at,scanned_at,clean_until)
        values('member-form-files',$1,$2,'proof-version','clean',repeat('a',64),'clamav',1,now(),now(),now() + interval '1 day')
        on conflict (bucket_id, object_name) do update set object_id=excluded.object_id, object_version=excluded.object_version, status='clean', sha256=excluded.sha256,
          engine=excluded.engine, signature_version=excluded.signature_version, signature_updated_at=excluded.signature_updated_at, scanned_at=excluded.scanned_at, clean_until=excluded.clean_until, deleted_at=null`, [objectName, object]);
      const file = (await admin.query(`insert into public.member_form_files(form_id,object_name,filename,mime_type,size_bytes,uploaded_by,confirmed_at)
        values($1,$2,'statement.pdf','application/pdf',1024,$3,now()) returning id`, [formId, objectName, ids.member])).rows[0].id;
      if (!hold) await admin.query("commit");
      return file;
    } catch (error) {
      await admin.query("rollback");
      throw error;
    }
  }

  // A sealed FMLA save through the real staged path; returns the stored version.
  async function saveSealed(formId, answers, expectedVersion) {
    const envelope = sealFormAnswers(answers, { id: formId, organization_id: ids.org }, ring);
    const args = { p_form_id: formId, p_step: 1, p_changed: true, p_filled: Object.keys(answers), p_data_version: envelope.dataVersion, p_expected_data_version: expectedVersion };
    await admin.query("begin; set local role service_role");
    const ticket = (await admin.query("select public.stage_sensitive_write($1,'save_sealed_form_draft',$2,$3) as ticket", [ids.member, args, { answers: envelope }])).rows[0].ticket;
    await admin.query("commit");
    const written = await call(other, ids.otherSession, "select public.write_sensitive_content('save_sealed_form_draft',$1,$2,$3) as id", [args, { answers: envelope }, ticket]);
    expect(written.code, written.message).toBeUndefined();
    return envelope.dataVersion;
  }

  beforeAll(async () => {
    const url = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    [admin, tab, other] = [0, 1, 2].map(() => new pg.Client({ connectionString: url }));
    await Promise.all([admin.connect(), tab.connect(), other.connect()]);
    await admin.query("begin");
    await admin.query("insert into auth.users(id,email) values($1,$2)", [ids.member, `${ids.member}@sign-review-proof.invalid`]);
    for (const session of [ids.tabSession, ids.otherSession]) {
      await admin.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, ids.member]);
    }
    await admin.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic factor','totp','verified',now(),now())", [randomUUID(), ids.member]);
    await admin.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$3,$4)", [ids.org, chapter, `Fictional Signing Proof Local ${chapter}`, ids.member]);
    await admin.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9908)", [chapter, ids.org]);
    await admin.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,false)", [ids.org]);
    await admin.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.org, ids.member]);
    await admin.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now())", [ids.member, chapter]);
    await admin.query("update public.member_profiles set chapter_id=$2 where id=$1", [ids.member, chapter]);
    await admin.query("commit");
  });

  afterAll(async () => {
    try {
      const owned = (await admin.query("select id from public.member_forms where user_id=$1", [ids.member])).rows.map((row) => row.id);
      // Best effort: a submitted fixture may hold rows the disposable stack keeps.
      for (const formId of new Set([...forms, ...owned])) await discard(formId).catch(() => {});
    } finally {
      await Promise.all([admin, tab, other].map((client) => client?.end()));
    }
  });

  it("exposes only the current functions (save four arguments, sign five), to authenticated and service_role", async () => {
    const save = (await admin.query(`select to_regprocedure('public.save_form_draft(text,jsonb,integer)') old,
      has_function_privilege('anon','public.save_form_draft(text,jsonb,integer,uuid,jsonb)','execute') anon,
      has_function_privilege('authenticated','public.save_form_draft(text,jsonb,integer,uuid,jsonb)','execute') authed`)).rows[0];
    expect(save).toEqual({ old: null, anon: false, authed: true });
    const row = (await admin.query(`select to_regprocedure('public.sign_member_form(uuid,jsonb,boolean)') old,
      to_regprocedure('public.sign_member_form(uuid,jsonb,boolean,jsonb)') four,
      pg_get_function_arguments('public.sign_member_form(uuid,jsonb,boolean,jsonb,text)'::regprocedure) args,
      has_function_privilege('anon','public.sign_member_form(uuid,jsonb,boolean,jsonb,text)','execute') anon,
      has_function_privilege('authenticated','public.sign_member_form(uuid,jsonb,boolean,jsonb,text)','execute') authed`)).rows[0];
    expect(row.old).toBeNull();
    expect(row.four).toBeNull();
    expect(`public.sign_member_form(${row.args})`).toBe(SIG);
    expect(row.anon).toBe(false);
    expect(row.authed).toBe(true);
  });

  it("signs an ordinary form whose stored answers and attachments are the reviewed ones", async () => {
    const reviewed = { summary: "Fictional overtime rotation skipped", remedy: "Make whole" };
    const formId = await saveOrdinary(tab, ids.tabSession, reviewed);
    forms.push(formId);
    const signed = await sign(formId, { answers: reviewed, attachmentIds: [] });
    expect(signed.code, signed.message).toBeUndefined();
    expect(signed.rows[0].v.contentDigest).toBe((await signature(formId)).content_digest);
    expect((await signature(formId)).rows).toBe(1);
  });

  it("refuses an ordinary form saved by another session after review, and signs nothing", async () => {
    const reviewed = { summary: "Fictional schedule change without notice" };
    const formId = await saveOrdinary(tab, ids.tabSession, reviewed);
    forms.push(formId);
    await saveOrdinary(other, ids.otherSession, { summary: "Fictional schedule change, edited on the phone" });
    expectRefused(await sign(formId, { answers: reviewed, attachmentIds: [] }));
    const after = await signature(formId);
    expect(after.filer_signature_digest).toBeNull();
    expect(after.rows).toBe(0);
    // The stored answers, once reviewed, sign.
    const stored = (await admin.query("select answers from public.member_forms where id=$1", [formId])).rows[0].answers;
    expect((await sign(formId, { answers: stored, attachmentIds: [] })).code).toBeUndefined();
    // Without p_expected the old behaviour stays: the row as it stands is signed
    // (the store builds that do not send it yet keep working).
    await saveOrdinary(other, ids.otherSession, { summary: "Fictional schedule change, third version" });
    const legacy = await sign(formId);
    expect(legacy.code, legacy.message).toBeUndefined();
    expect((await signature(formId)).rows).toBe(1);
    await discard(formId);
  });

  it("refuses when a confirmed attachment differs from the manifest shown, and signs once it is named", async () => {
    const reviewed = { summary: "Fictional missed break" };
    const formId = await saveOrdinary(tab, ids.tabSession, reviewed);
    forms.push(formId);
    const file = await attach(formId, `${formId}/statement.pdf`);
    // A client that shows no attachments (the phone today) sends [] and is refused.
    expectRefused(await sign(formId, { answers: reviewed, attachmentIds: [] }));
    expect((await signature(formId)).rows).toBe(0);
    expectRefused(await sign(formId, { answers: reviewed, attachmentIds: [file, randomUUID()] }));
    // The manifest is required: answers alone do not sign.
    expect((await sign(formId, { answers: reviewed })).code).toBe("22023");
    expect((await sign(formId, { answers: reviewed, attachmentIds: [file.toUpperCase()] })).code).toBeUndefined();
    expect((await signature(formId)).rows).toBe(1);
    await discard(formId);
  });

  it("refuses an attachment confirmed while the signature waited on the form lock", async () => {
    const reviewed = { summary: "Fictional unpaid call-in" };
    const formId = await saveOrdinary(tab, ids.tabSession, reviewed);
    forms.push(formId);
    // The website's upload confirmation holds the form lock, uncommitted.
    await attach(formId, `${formId}/letter.pdf`, { hold: true });
    const tabPid = (await tab.query("select pg_backend_pid() pid")).rows[0].pid;
    const pending = sign(formId, { answers: reviewed, attachmentIds: [] });
    expect(await waitingOnLock(tabPid)).toBe(true);
    await admin.query("commit");
    expectRefused(await pending);
    expect((await signature(formId)).rows).toBe(0);
    await discard(formId);
  });

  it("refuses an expectation that does not name what it needs", async () => {
    const formId = await saveOrdinary(tab, ids.tabSession, { summary: "Fictional shape check" });
    forms.push(formId);
    for (const expected of [[], "answers", { dataVersion: "v1", attachmentIds: [] }, { answers: { summary: "Fictional shape check" } },
      { answers: { summary: "Fictional shape check" }, attachmentIds: "none" }, { answers: { summary: "Fictional shape check" }, attachmentIds: null }]) {
      const refused = await sign(formId, expected);
      expect(refused.code, JSON.stringify(expected)).toBe("22023");
    }
    expect((await signature(formId)).rows).toBe(0);
    await discard(formId);
  });

  it("refuses a sealed FMLA form whose dataVersion moved after review, and signs the reviewed version", async () => {
    const draft = (await call(tab, ids.tabSession, "select public.prepare_sealed_form('fmla_self') as draft")).rows[0].draft;
    const formId = draft.formId;
    forms.push(formId);
    const required = (await admin.query("select private.form_required_keys(f.template_key, f.template_version) k from public.member_forms f where f.id=$1", [formId])).rows[0].k;
    const answers = (value) => Object.fromEntries(required.map((key) => [key, value]));
    const reviewed = await saveSealed(formId, answers("2027-01-01"), null);
    const moved = await saveSealed(formId, answers("2027-02-01"), reviewed);
    expect(moved).not.toBe(reviewed);
    expectRefused(await sign(formId, { dataVersion: reviewed, attachmentIds: [] }));
    expect((await signature(formId)).rows).toBe(0);
    // Answers do not stand in for the version on a sealed form.
    expect((await sign(formId, { answers: { sealed: true }, attachmentIds: [] })).code).toBe("22023");
    // Nor does an unseen attachment pass with the right version.
    const file = await attach(formId, `${formId}/provider.pdf`);
    expectRefused(await sign(formId, { dataVersion: moved, attachmentIds: [] }));
    const signed = await sign(formId, { dataVersion: moved, attachmentIds: [file] });
    expect(signed.code, signed.message).toBeUndefined();
    expect((await signature(formId)).rows).toBe(1);
    await discard(formId);
  });

  it("refuses a signature that waited on the form lock while another session saved", async () => {
    const reviewed = { summary: "Fictional seniority bypass" };
    const formId = await saveOrdinary(tab, ids.tabSession, reviewed);
    forms.push(formId);
    // The other session's save holds the form lock, uncommitted.
    await begin(other, ids.otherSession);
    await other.query("select public.save_form_draft('grievance',$1,0)", [{ summary: "Fictional seniority bypass, edited elsewhere" }]);
    const tabPid = (await tab.query("select pg_backend_pid() pid")).rows[0].pid;
    const pending = sign(formId, { answers: reviewed, attachmentIds: [] });
    expect(await waitingOnLock(tabPid)).toBe(true);
    await other.query("commit");
    expectRefused(await pending);
    expect((await signature(formId)).rows).toBe(0);
    await discard(formId);
  });

  describe("save_form_draft with an expected form id", () => {
    let complete;
    beforeAll(async () => {
      const required = (await admin.query("select private.form_required_keys('grievance', (select max(version) from public.form_templates where key='grievance' and is_platform_seed)) keys")).rows[0].keys;
      complete = Object.fromEntries(required.map((key) => [key, key.includes("date") ? "2026-11-02" : `Fictional ${key}`]));
    });
    const expectNotEditable = (result) => {
      expect(result.code, result.message).toBe("PT409");
      expect(result.detail).toBe("form_not_editable");
    };
    const submitSigned = async (formId) => {
      expect((await sign(formId, { answers: complete, attachmentIds: [] })).code).toBeUndefined();
      const submitted = await call(tab, ids.tabSession, "select public.submit_form($1) v", [formId]);
      expect(submitted.code, submitted.message).toBeUndefined();
    };

    it("updates exactly the named open form and creates nothing", async () => {
      const formId = await saveOrdinary(tab, ids.tabSession, { summary: "Fictional first draft" });
      forms.push(formId);
      const saved = await saveExpecting(formId, { summary: "Fictional first draft, edited" });
      expect(saved.code, saved.message).toBeUndefined();
      expect(saved.rows[0].id).toBe(formId);
      expect(await openForms()).toEqual([formId]);
      expect((await admin.query("select answers from public.member_forms where id=$1", [formId])).rows[0].answers).toEqual({ summary: "Fictional first draft, edited" });
      await discard(formId);
    });

    it("refuses a filed form, another template's form or an unknown id, and writes nothing", async () => {
      const formId = await saveOrdinary(tab, ids.tabSession, complete);
      forms.push(formId);
      await submitSigned(formId);
      expectNotEditable(await saveExpecting(formId, complete));
      expect(await openForms()).toEqual([]);
      expectNotEditable(await saveExpecting(randomUUID(), { summary: "Fictional unknown" }));
      expectNotEditable(await saveExpecting(formId, { summary: "Fictional other template" }, "alliance_grievance"));
      expect(await openForms()).toEqual([]);
      // Without the expected id the old behaviour stays: a new draft carrying
      // the filed answers is created (the duplicate filing r5s1 describes).
      const legacy = await saveOrdinary(tab, ids.tabSession, complete);
      expect(legacy).not.toBe(formId);
      expect(await openForms()).toEqual([legacy]);
      await discard(legacy);
    });

    it("refuses a retried save that waited on a submission of the same form", async () => {
      const formId = await saveOrdinary(tab, ids.tabSession, complete);
      forms.push(formId);
      expect((await sign(formId, { answers: complete, attachmentIds: [] })).code).toBeUndefined();
      // The first submission is still in flight (its reply lost), holding the locks.
      await begin(other, ids.otherSession);
      await other.query("select public.submit_form($1)", [formId]);
      const tabPid = (await tab.query("select pg_backend_pid() pid")).rows[0].pid;
      const retry = saveExpecting(formId, complete);
      expect(await waitingOnLock(tabPid)).toBe(true);
      await other.query("commit");
      expectNotEditable(await retry);
      expect(await openForms()).toEqual([]);
      expect((await admin.query("select status from public.member_forms where id=$1", [formId])).rows[0].status).toBe("submitted");
    });
  });
});
