// @vitest-environment node
// REQ-UG-FORMS-COMPLETE-A-FORM-WITHOUT-DRAWING-A-SIGNATURE-20261113 (#8701).
// A typed signature (full name plus consent) goes through the same RPCs and
// guards as a drawn one. Full migrated disposable database only; the form
// rows this proof makes are removed afterwards.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl, assertDisposableStorageStatus } from "../scripts/run-required-db-proofs.mjs";
import { sealFormAnswers } from "../api/_lib/sensitiveContent.js";
import { sensitiveKeyring } from "../api/_lib/sensitiveDataCrypto.js";
import { scopeFixtureSteward } from "./helpers/steward-unit-fixtures.js";

const MIGRATION = "20261113120500_forms_typed_signature.sql";
const migration = readFileSync(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), "utf8");
const code = migration.replace(/--[^\n]*/g, "");
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const ACUTE = String.fromCharCode(0x301);

describe("typed signature migration (static)", () => {
  it("is a required DB proof and replaces exactly the two signing RPCs and the filing status", () => {
    expect(PROOF_FILES).toContain("tests/forms-typed-signature-db.test.js");
    expect(code).toContain("drop function public.sign_member_form(uuid, jsonb, boolean, jsonb);");
    expect(code).toContain("drop function public.respond_to_cosign(uuid, boolean, jsonb, boolean);");
    expect(code).toContain("p_form_id uuid, p_strokes jsonb, p_consent boolean, p_expected jsonb default null,\n  p_typed_name text default null");
    // The expected-review check (20261113114500) runs unchanged under the form lock, before the digest.
    const sign = code.slice(code.indexOf("create function public.sign_member_form("), code.indexOf("drop function public.respond_to_cosign("));
    const at = (needle) => { const index = sign.indexOf(needle); expect(index, needle).toBeGreaterThan(-1); return index; };
    expect(at("perform private.lock_case_graph(")).toBeLessThan(at("private.mfa_satisfied()"));
    expect(at("perform private.lock_member_form(p_form_id);")).toBeLessThan(at("if p_expected is not null then"));
    expect(at("detail = 'form_changed_since_review'")).toBeLessThan(at("current_digest := private.form_content_digest(p_form_id);"));
    expect(code).toContain("p_typed_name text default null");
    expect(code).toMatch(/create or replace function public\.get_form_filing_status\(p_form_id uuid\)/i);
    for (const name of ["submit_form", "approve_form", "get_form_filing_payload", "form_signature_digest", "validate_form_signature_strokes"]) {
      expect(code, name).not.toMatch(new RegExp(`function (public|private)\\.${name}\\(`, "i"));
    }
  });

  it("keeps the drawn validator on every drawn signature and grants only what was granted before", () => {
    expect(code.match(/perform private\.validate_form_signature_strokes\(p_strokes\);/g)).toHaveLength(2);
    expect(code.match(/private\.normalize_form_typed_signature\(p_typed_name\)/g)).toHaveLength(2);
    expect(code).toContain("revoke all on function public.sign_member_form(uuid, jsonb, boolean, jsonb, text) from public, anon;");
    expect(code).toContain("grant execute on function public.sign_member_form(uuid, jsonb, boolean, jsonb, text) to authenticated, service_role;");
    expect(code).toContain("revoke all on function public.respond_to_cosign(uuid, boolean, jsonb, boolean, text) from public, anon;");
    expect(code).toContain("grant execute on function public.respond_to_cosign(uuid, boolean, jsonb, boolean, text) to authenticated, service_role;");
    expect(code).toContain("revoke all on function private.normalize_form_typed_signature(text)\n  from public, anon, authenticated, service_role;");
  });

  it("ties the kind, the typed name and the signed material together in one constraint", () => {
    expect(code).toContain("add constraint member_form_signatures_kind_material check (");
    expect(code).toContain("strokes ->> 'name' = typed_name");
    expect(code).toContain("strokes - 'kind' - 'name' = '{}'::jsonb");
    expect(code).toContain("pg_catalog.jsonb_typeof(strokes) = 'array'");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("typed signatures on a migrated database", () => {
  let admin, member, cosigner, steward, outsider;
  const ids = {
    org: randomUUID(), otherOrg: randomUUID(),
    member: randomUUID(), memberSession: randomUUID(),
    cosigner: randomUUID(), cosignerSession: randomUUID(),
    steward: randomUUID(), stewardSession: randomUUID(),
    outsider: randomUUID(), outsiderSession: randomUUID(),
  };
  const chapter = `typed-${ids.org.slice(0, 8)}`;
  const otherChapter = `typed-${ids.otherOrg.slice(0, 8)}`;
  const cosignerEmail = `${ids.cosigner}@typed-signature-proof.invalid`;
  const strokes = [[{ x: 0, y: 0 }, { x: 10, y: 10 }]];
  const forms = [];
  const ring = sensitiveKeyring("saas", { SENSITIVE_DATA_KEYS: JSON.stringify({ v1: randomBytes(32).toString("base64") }), SENSITIVE_DATA_ACTIVE_KEY: "v1" });

  const as = async (client, user, session, aal = "aal2") => {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      sub: user, role: "authenticated", session_id: session, aal,
      email: user === ids.cosigner ? cosignerEmail : `${user}@typed-signature-proof.invalid`,
    })]);
    await client.query("set local role authenticated");
  };
  const call = async (client, user, session, sql, values = [], aal = "aal2") => {
    await as(client, user, session, aal);
    try {
      const result = await client.query(sql, values);
      await client.query("commit");
      return { rows: result.rows, value: result.rows[0]?.value };
    } catch (error) {
      await client.query("rollback");
      return { code: error.code, message: error.message };
    }
  };
  const asMember = (sql, values, aal) => call(member, ids.member, ids.memberSession, sql, values, aal);
  const asCosigner = (sql, values) => call(cosigner, ids.cosigner, ids.cosignerSession, sql, values);
  const asSteward = (sql, values) => call(steward, ids.steward, ids.stewardSession, sql, values);
  const signTyped = (formId, name, consent = true) => asMember(
    "select public.sign_member_form(p_form_id => $1, p_strokes => null, p_consent => $2, p_typed_name => $3) as value", [formId, consent, name]);
  const signatureRow = async (formId, kind = "filer") => (await admin.query(
    "select signature_kind, typed_name, strokes, content_digest, signature_digest, signer_user_id, consented_at from private.member_form_signatures where form_id=$1 and signer_kind=$2",
    [formId, kind])).rows[0];

  async function authUser(user, session) {
    await admin.query("insert into auth.users(id,email) values($1,$2)", [user, user === ids.cosigner ? cosignerEmail : `${user}@typed-signature-proof.invalid`]);
    await admin.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
    await admin.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic factor','totp','verified',now(),now())", [randomUUID(), user]);
  }
  async function enroll(user, org, chapterId, role) {
    await admin.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, user]);
    await admin.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now())", [user, chapterId]);
    await admin.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user, chapterId, role ? "Sam Steward" : "Ana Pérez"]);
    if (role) {
      await admin.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [user, role, chapterId]);
      await admin.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [user, role, chapterId]);
      // Every steward grant carries a unit (20261113115000).
      if (role === "steward") await scopeFixtureSteward(admin, user, chapterId);
    }
  }
  async function organization(org, chapterId, creator, order) {
    await admin.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [org, chapterId, creator]);
    await admin.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,$3)", [chapterId, org, order]);
    await admin.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,false)", [org]);
  }
  async function grievance(summary) {
    const required = (await admin.query("select private.form_required_keys('alliance_grievance', t.version) k from public.form_templates t where t.key='alliance_grievance' and t.active order by t.version desc limit 1")).rows[0]?.k || [];
    const answers = { ...Object.fromEntries(required.map((key) => [key, "Proof answer"])), summary };
    // save_form_draft continues the member's open draft, so the earlier proof
    // forms are moved out of draft first and each case gets its own form.
    await admin.query("update public.member_forms set status='submitted', submitted_at=now() where user_id=$1 and template_key='alliance_grievance' and status in ('draft','returned')", [ids.member]);
    const saved = await asMember("select public.save_form_draft('alliance_grievance',$1::jsonb,1) as value", [JSON.stringify(answers)]);
    expect(saved.code, saved.message).toBeUndefined();
    forms.push(saved.value);
    return { id: saved.value, answers };
  }

  beforeAll(async () => {
    const url = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    [admin, member, cosigner, steward, outsider] = Array.from({ length: 5 }, () => new pg.Client({ connectionString: url, application_name: "forms-typed-signature-proof" }));
    await Promise.all([admin, member, cosigner, steward, outsider].map((client) => client.connect()));
    await admin.query("begin");
    await authUser(ids.member, ids.memberSession);
    await organization(ids.org, chapter, ids.member, 9911);
    await enroll(ids.member, ids.org, chapter, null);
    await authUser(ids.cosigner, ids.cosignerSession);
    await enroll(ids.cosigner, ids.org, chapter, null);
    await authUser(ids.steward, ids.stewardSession);
    await enroll(ids.steward, ids.org, chapter, "steward");
    await authUser(ids.outsider, ids.outsiderSession);
    await organization(ids.otherOrg, otherChapter, ids.outsider, 9912);
    await enroll(ids.outsider, ids.otherOrg, otherChapter, "steward");
    await admin.query("commit");
  });

  afterAll(async () => {
    try {
      if (forms.length) await admin.query("delete from public.member_forms where id = any($1::uuid[])", [forms]);
    } finally {
      await Promise.all([admin, member, cosigner, steward, outsider].map((client) => client?.end()));
    }
  });

  it("stores a typed filer signature with its kind, normalized name, time and member, bound into the digest", async () => {
    const form = await grievance("Typed filer signature");
    const before = Date.now();
    const signed = await signTyped(form.id, `  Ana${ACUTE}   Pérez `);
    expect(signed.code, signed.message).toBeUndefined();
    expect(signed.value).toMatchObject({ formId: form.id, signatureKind: "typed" });
    const row = await signatureRow(form.id);
    expect(row.signature_kind).toBe("typed");
    expect(row.typed_name).toBe("Aná Pérez");
    expect(row.strokes).toEqual({ kind: "typed", name: "Aná Pérez" });
    expect(row.signer_user_id).toBe(ids.member);
    expect(new Date(row.consented_at).getTime()).toBeGreaterThanOrEqual(before - 5000);
    const expected = (await admin.query("select private.form_signature_digest($1,$2,$3::jsonb) d", [row.content_digest, ids.member, JSON.stringify(row.strokes)])).rows[0].d;
    expect(row.signature_digest).toBe(expected);
    const otherName = (await admin.query("select private.form_signature_digest($1,$2,$3::jsonb) d", [row.content_digest, ids.member, JSON.stringify({ kind: "typed", name: "Ana Perez" })])).rows[0].d;
    expect(otherName).not.toBe(row.signature_digest);
  });

  it("refuses what the typed-name rule refuses, both kinds at once and a missing consent, and writes nothing", async () => {
    const form = await grievance("Typed refusals");
    for (const [name, message] of [
      ["", "2-120 characters"], ["   ", "2-120 characters"], ["A", "2-120 characters"], ["a".repeat(121), "2-120 characters"],
      ["12 34", "at least one letter"], [`Ana${RLO}Pérez`, "hidden or control character"],
      [`Ana${ZWSP}Pérez`, "hidden or control character"], ["Ana\tPérez", "hidden or control character"],
    ]) {
      const refused = await signTyped(form.id, name);
      expect(refused.code, JSON.stringify(name)).toBe("22023");
      expect(refused.message).toContain(message);
    }
    const both = await asMember("select public.sign_member_form(p_form_id => $1, p_strokes => $2::jsonb, p_consent => true, p_typed_name => 'Ana Pérez')", [form.id, JSON.stringify(strokes)]);
    expect(both).toMatchObject({ code: "22023", message: "sign by drawing or by typing your name, not both" });
    const neither = await asMember("select public.sign_member_form($1,null,true)", [form.id]);
    expect(neither).toMatchObject({ code: "22023", message: "signature strokes must be an array" });
    expect(await signTyped(form.id, "Ana Pérez", false)).toMatchObject({ code: "22023", message: "signature consent required" });
    expect(await signatureRow(form.id)).toBeUndefined();
  });

  it("compares the expected review for a typed signature exactly as for a drawn one", async () => {
    const form = await grievance("Typed with review");
    const review = { answers: form.answers, attachmentIds: [] };
    const signed = await asMember("select public.sign_member_form($1, null, true, $2::jsonb, 'Ana Pérez') as value", [form.id, JSON.stringify(review)]);
    expect(signed.code, signed.message).toBeUndefined();
    expect(signed.value.signatureKind).toBe("typed");
    // Another session saves after review: nothing is signed, and the earlier signature is cleared by that save.
    const moved = { ...form.answers, summary: "Typed with review, changed elsewhere" };
    expect((await asMember("select public.save_form_draft('alliance_grievance',$1::jsonb,1) as value", [JSON.stringify(moved)])).value).toBe(form.id);
    const refused = await asMember("select public.sign_member_form($1, null, true, $2::jsonb, 'Ana Pérez') as value", [form.id, JSON.stringify(review)]);
    expect(refused).toMatchObject({ code: "PT409", message: "form changed since review" });
    expect(await signatureRow(form.id)).toBeUndefined();
    const shape = await asMember("select public.sign_member_form($1, null, true, '{}'::jsonb, 'Ana Pérez') as value", [form.id]);
    expect(shape).toMatchObject({ code: "22023", message: "expected review must name the reviewed answers and attachments" });
    const fresh = await asMember("select public.sign_member_form($1, null, true, $2::jsonb, 'Ana Pérez') as value", [form.id, JSON.stringify({ answers: moved, attachmentIds: [] })]);
    expect(fresh.code, fresh.message).toBeUndefined();
    expect((await signatureRow(form.id)).typed_name).toBe("Ana Pérez");
  });

  it("keeps the same member, second-step and organization guards as a drawn signature", async () => {
    const form = await grievance("Typed guards");
    const stranger = await call(outsider, ids.outsider, ids.outsiderSession, "select public.sign_member_form(p_form_id => $1, p_strokes => null, p_consent => true, p_typed_name => 'Lee Park')", [form.id]);
    expect(stranger).toMatchObject({ code: "22023", message: "form not found or not signable" });
    const colleague = await call(cosigner, ids.cosigner, ids.cosignerSession, "select public.sign_member_form(p_form_id => $1, p_strokes => null, p_consent => true, p_typed_name => 'Lee Park')", [form.id]);
    expect(colleague).toMatchObject({ code: "22023", message: "form not found or not signable" });
    // A member with a verified second factor on a first-step session is refused before anything else.
    expect(await asMember("select public.sign_member_form(p_form_id => $1, p_strokes => null, p_consent => true, p_typed_name => 'Ana Pérez')", [form.id], "aal1"))
      .toMatchObject({ code: "42501", message: "authentication required" });
    expect(await signatureRow(form.id)).toBeUndefined();
    expect((await signTyped(form.id, "Ana Pérez")).code).toBeUndefined();
    const status = await call(outsider, ids.outsider, ids.outsiderSession, "select public.get_form_filing_status($1) as value", [form.id]);
    expect(status).toMatchObject({ code: "22023", message: "form unavailable" });
  });

  it("refuses a row whose kind, typed name and material disagree, even from the table owner", async () => {
    const form = await grievance("Typed constraint");
    expect((await signTyped(form.id, "Ana Pérez")).code).toBeUndefined();
    for (const change of [
      "typed_name = 'Someone Else'",
      "strokes = '{\"kind\":\"typed\",\"name\":\"Someone Else\"}'::jsonb",
      "signature_kind = 'drawn'",
      "signature_kind = 'drawn', typed_name = null",
      "strokes = '{\"kind\":\"typed\",\"name\":\"Ana Pérez\",\"x\":1}'::jsonb",
      "strokes = '[[{\"x\":0,\"y\":0},{\"x\":1,\"y\":1}]]'::jsonb",
    ]) {
      await admin.query("begin");
      const error = await admin.query(`update private.member_form_signatures set ${change} where form_id=$1`, [form.id]).then(() => null, (failure) => failure);
      await admin.query("rollback");
      expect(error?.code, change).toBe("23514");
    }
  });

  it("refuses to submit a typed signature whose name was changed after signing", async () => {
    const form = await grievance("Typed tamper");
    expect((await signTyped(form.id, "Ana Pérez")).code).toBeUndefined();
    await admin.query("update private.member_form_signatures set typed_name='Mallory', strokes='{\"kind\":\"typed\",\"name\":\"Mallory\"}'::jsonb where form_id=$1", [form.id]);
    const submitted = await asMember("select public.submit_form($1)", [form.id]);
    expect(submitted.code).toBe("22023");
    expect(submitted.message).toContain("current signature");
  });

  it("clears a typed signature when the answers change, like a drawn one", async () => {
    const form = await grievance("Typed then edited");
    expect((await signTyped(form.id, "Ana Pérez")).code).toBeUndefined();
    const edited = await asMember("select public.save_form_draft('alliance_grievance',$1::jsonb,1) as value", [JSON.stringify({ ...form.answers, summary: "Typed then edited, changed" })]);
    expect(edited.code, edited.message).toBeUndefined();
    expect(edited.value).toBe(form.id);
    expect(await signatureRow(form.id)).toBeUndefined();
  });

  it("lets a co-signer accept by typing, shows both kinds to the owner and steward, and approves and files the typed material", async () => {
    const form = await grievance("Typed filer and co-signer");
    const invited = await asMember("select public.invite_cosigner($1,$2) as value", [form.id, cosignerEmail]);
    expect(invited.code, invited.message).toBeUndefined();
    expect(await asCosigner("select public.respond_to_cosign($1,true,$2::jsonb,true,'José Ramos')", [form.id, JSON.stringify(strokes)]))
      .toMatchObject({ code: "22023", message: "sign by drawing or by typing your name, not both" });
    expect(await asCosigner("select public.respond_to_cosign($1,true,null,true,'1')", [form.id])).toMatchObject({ code: "22023" });
    const accepted = await asCosigner("select public.respond_to_cosign($1,true,null,true,' José  A. Ramos ') as value", [form.id]);
    expect(accepted.code, accepted.message).toBeUndefined();
    expect(accepted.value).toMatchObject({ status: "accepted", signatureKind: "typed" });
    const cosignRow = await signatureRow(form.id, "cosigner");
    expect(cosignRow).toMatchObject({ signature_kind: "typed", typed_name: "José A. Ramos", signer_user_id: ids.cosigner });
    expect((await signTyped(form.id, "Ana M. Pérez")).code).toBeUndefined();
    expect((await asMember("select public.submit_form($1)", [form.id])).code).toBeUndefined();

    const owner = (await asMember("select public.get_form_filing_status($1) as value", [form.id])).value;
    expect(owner).toMatchObject({ filerSigned: true, filerSignatureKind: "typed", filerTypedName: "Ana M. Pérez" });
    expect(owner.cosignatures).toEqual([expect.objectContaining({ kind: "typed", typedName: "José A. Ramos" })]);
    expect(JSON.stringify(owner)).not.toContain("strokes");
    const reviewer = (await asSteward("select public.get_form_filing_status($1) as value", [form.id])).value;
    expect(reviewer).toMatchObject({ filerSignatureKind: "typed", filerTypedName: "Ana M. Pérez" });

    const approved = await asSteward("select public.approve_form($1,'Approved with typed signatures.') as value", [form.id]);
    expect(approved.code, approved.message).toBeUndefined();
    await admin.query("begin; set local role service_role");
    const payload = (await admin.query("select public.get_form_filing_payload($1,$2) as value", [form.id, ids.steward])).rows[0].value;
    await admin.query("commit");
    expect(payload.filerSignature.strokes).toEqual({ kind: "typed", name: "Ana M. Pérez" });
    expect(payload.cosigners).toEqual([expect.objectContaining({ status: "accepted", strokes: { kind: "typed", name: "José A. Ramos" } })]);

    await admin.query("begin");
    const frozen = await admin.query("update private.member_form_signatures set consented_at = now() where form_id=$1 and signer_kind='filer'", [form.id]).then(() => null, (failure) => failure);
    await admin.query("rollback");
    expect(frozen?.message).toContain("approved filing children are immutable");
  });

  it("withdraws a typed co-signature like a drawn one", async () => {
    const form = await grievance("Typed co-signature withdrawn");
    expect((await asMember("select public.invite_cosigner($1,$2)", [form.id, cosignerEmail])).code).toBeUndefined();
    expect((await asCosigner("select public.respond_to_cosign($1,true,null,true,'José Ramos')", [form.id])).code).toBeUndefined();
    expect((await asCosigner("select public.withdraw_cosign($1)", [form.id])).code).toBeUndefined();
    expect(await signatureRow(form.id, "cosigner")).toBeUndefined();
  });

  it("still signs and co-signs by drawing through the argument names the shipped apps send", async () => {
    const form = await grievance("Drawn through the old names");
    const drawn = await asMember("select public.sign_member_form(p_form_id => $1, p_strokes => $2::jsonb, p_consent => true) as value", [form.id, JSON.stringify(strokes)]);
    expect(drawn.code, drawn.message).toBeUndefined();
    expect(drawn.value.signatureKind).toBe("drawn");
    expect(await signatureRow(form.id)).toMatchObject({ signature_kind: "drawn", typed_name: null, strokes });
    expect((await asMember("select public.invite_cosigner($1,$2)", [form.id, cosignerEmail])).code).toBeUndefined();
    const cosigned = await asCosigner("select public.respond_to_cosign(p_form_id => $1, p_accept => true, p_strokes => $2::jsonb, p_consent => true) as value", [form.id, JSON.stringify(strokes)]);
    expect(cosigned.code, cosigned.message).toBeUndefined();
    expect(cosigned.value).toMatchObject({ status: "accepted", signatureKind: "drawn" });
    const declined = await asCosigner("select public.respond_to_cosign(p_form_id => $1, p_accept => false, p_strokes => null, p_consent => false) as value", [form.id]);
    expect(declined).toMatchObject({ code: "22023", message: "no pending co-sign invitation for you on this form" });
  });

  it("signs a sealed FMLA form by typing and submits it", async () => {
    const draft = (await asMember("select public.prepare_sealed_form('fmla_self') as value")).value;
    forms.push(draft.formId);
    const required = (await admin.query("select private.form_required_keys(f.template_key, f.template_version) k from public.member_forms f where f.id=$1", [draft.formId])).rows[0].k;
    const envelope = sealFormAnswers(Object.fromEntries(required.map((key) => [key, "proof"])), { id: draft.formId, organization_id: ids.org }, ring);
    const args = { p_form_id: draft.formId, p_step: 1, p_changed: true, p_filled: required, p_data_version: envelope.dataVersion, p_expected_data_version: null };
    await admin.query("begin; set local role service_role");
    const ticket = (await admin.query("select public.stage_sensitive_write($1,'save_sealed_form_draft',$2,$3) as ticket", [ids.member, args, { answers: envelope }])).rows[0].ticket;
    await admin.query("commit");
    const written = await asMember("select public.write_sensitive_content('save_sealed_form_draft',$1,$2,$3) as value", [args, { answers: envelope }, ticket]);
    expect(written.code, written.message).toBeUndefined();
    expect((await signTyped(draft.formId, "Ana Pérez")).code).toBeUndefined();
    expect((await signatureRow(draft.formId)).signature_kind).toBe("typed");
    const submitted = await asMember("select public.submit_form($1)", [draft.formId]);
    expect(submitted.code, submitted.message).toBeUndefined();
  });

  const httpIt = process.env.PRIVATE_FILE_STORAGE_STATUS_FILE ? it : it.skip;
  httpIt("resolves the shipped apps' named calls through PostgREST, and the typed call too", async () => {
    const status = assertDisposableStorageStatus(JSON.parse(readFileSync(process.env.PRIVATE_FILE_STORAGE_STATUS_FILE, "utf8")), process.env.SUPABASE_DB_URL);
    const options = { auth: { persistSession: false, autoRefreshToken: false } };
    const service = createClient(status.API_URL, status.SERVICE_ROLE_KEY, options);
    const caller = createClient(status.API_URL, status.ANON_KEY, options);
    const email = `typed-http-${randomUUID()}@typed-signature-proof.invalid`;
    const password = randomBytes(18).toString("base64url");
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error) throw created.error;
    const userId = created.data.user.id;
    await admin.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.org, userId]);
    await admin.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now())", [userId, chapter]);
    await admin.query("update public.member_profiles set chapter_id=$2 where id=$1", [userId, chapter]);
    const session = await caller.auth.signInWithPassword({ email, password });
    if (session.error) throw session.error;
    const rpc = async (name, args) => {
      const response = await fetch(`${status.API_URL}/rest/v1/rpc/${name}`, {
        method: "POST", signal: AbortSignal.timeout(10000),
        headers: { apikey: status.ANON_KEY, authorization: `Bearer ${session.data.session.access_token}`, "content-type": "application/json" },
        body: JSON.stringify(args),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    try {
      const saved = await rpc("save_form_draft", { p_template_key: "alliance_grievance", p_answers: { summary: "HTTP named calls" }, p_step: 1 });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      forms.push(saved.body);
      // The exact bodies the website and phone sent before #8701.
      const drawn = await rpc("sign_member_form", { p_form_id: saved.body, p_strokes: strokes, p_consent: true });
      expect(drawn.status, JSON.stringify(drawn.body)).toBe(200);
      expect(drawn.body.signatureKind).toBe("drawn");
      const cosign = await rpc("respond_to_cosign", { p_form_id: saved.body, p_accept: true, p_strokes: strokes, p_consent: true });
      expect(cosign.body?.code, JSON.stringify(cosign.body)).toBe("22023");
      expect(cosign.body.message).toBe("no pending co-sign invitation for you on this form");
      const decline = await rpc("respond_to_cosign", { p_form_id: saved.body, p_accept: false, p_strokes: null, p_consent: false });
      expect(decline.body?.code, JSON.stringify(decline.body)).toBe("22023");
      // The body the website sends since 20261113114500, then the new typed body.
      const reviewed = await rpc("sign_member_form", { p_form_id: saved.body, p_strokes: strokes, p_consent: true, p_expected: { answers: { summary: "HTTP named calls" }, attachmentIds: [] } });
      expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
      expect(reviewed.body.signatureKind).toBe("drawn");
      const typed = await rpc("sign_member_form", { p_form_id: saved.body, p_strokes: null, p_consent: true, p_typed_name: "Ana Pérez" });
      expect(typed.status, JSON.stringify(typed.body)).toBe(200);
      expect(typed.body.signatureKind).toBe("typed");
    } finally {
      // Leave no signed-in member behind: the shared proof database also runs
      // the welcome scheduler, which counts recent first sign-ins.
      await admin.query("delete from public.member_chapter_memberships where user_id=$1", [userId]);
      await admin.query("delete from public.organization_memberships where user_id=$1", [userId]);
      await admin.query("update auth.users set last_sign_in_at = null where id=$1", [userId]);
    }
  });

  it("leaves the account lifecycle trigger inventory matching its review", async () => {
    const issues = (await admin.query("select count(*)::int n from private.account_lifecycle_referential_action_trigger_issues()")).rows[0].n;
    expect(issues).toBe(0);
  });
});
