// @vitest-environment node
// Full migrated disposable database only; the stack is destroyed afterwards.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { SIGNATURE_OPTIONAL_TEMPLATE_KEYS, templateRequiresSignature, FORM_TEMPLATES } from "../src/lib/formTemplates.js";
import { scopeFixtureSteward } from "./helpers/steward-unit-fixtures.js";

// REQ-UG-FORMS-SIGNATURE-ONLY-ON-SIGNED-STATEMENTS-20261115 (#8957).
const migration = readFileSync(new URL("../supabase/migrations/20261113149500_forms_signature_only_on_signed_statements.sql", import.meta.url), "utf8");
const runner = readFileSync(new URL("../scripts/run-required-db-proofs.mjs", import.meta.url), "utf8");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("template-driven filer signature (static)", () => {
  it("names one rule on the server and in the app: only service_request is not a signed statement", () => {
    expect(migration).toContain("select p_template_key is distinct from 'service_request';");
    expect([...SIGNATURE_OPTIONAL_TEMPLATE_KEYS]).toEqual(["service_request"]);
    const settings = Object.fromEntries(FORM_TEMPLATES.map((template) => [template.key, templateRequiresSignature(template.key)]));
    expect(settings).toEqual({
      grievance: true, alliance_grievance: true, non_selection: true,
      fmla_self: true, fmla_family: true, alt_work: true, service_request: false,
    });
    // An organization-made template is not on the list, so it stays required.
    expect(templateRequiresSignature("org_custom_intake")).toBe(true);
  });

  it("applies the rule in all four functions and guards each predecessor", () => {
    for (const fn of ["submit_form(uuid,jsonb)", "approve_form(uuid,text,jsonb)", "get_form_filing_status(uuid)", "get_form_filing_payload(uuid,uuid)"]) {
      expect(migration).toContain(`'public.${fn}'::regprocedure)) <>`);
    }
    expect(migration).toContain("if private.form_template_requires_signature(rec.template_key) then\n    select content_digest, signature_digest, strokes into signature");
    expect(migration).toContain("    signature.signature_digest := null;");
    expect(migration).toContain("'signatureRequired', private.form_template_requires_signature(rec.template_key),");
    expect(migration).toContain("or (filer_digest is null and private.form_template_requires_signature(rec.template_key)) then");
  });

  it("touches no save or discard function and never recreates the two-argument approve_form", () => {
    const sql = migration.replace(/--[^\n]*/g, "");
    expect(sql).not.toMatch(/function\s+public\.(save_form_draft|save_unit_form_draft|discard_form_draft)\b/i);
    expect(sql).not.toMatch(/function\s+public\.approve_form\s*\(\s*p_form_id\s+uuid\s*,\s*p_note\s+text(?:\s+DEFAULT\s+NULL::text)?\s*\)/i);
    expect(sql.match(/detail = 'form_changed_since_review'/g)).toHaveLength(2);
  });

  it("is in the proof lane and the contract", () => {
    expect(PROOF_FILES).toContain("tests/forms-template-signature-db.test.js");
    expect(runner).toContain('RUN_FORMS_TEMPLATE_SIGNATURE_DB_TESTS: "1"');
    expect(contract.functions.find((fn) => fn.sig === "private.form_template_requires_signature(p_template_key text)")).toBeDefined();
    expect(contract.functions.find((fn) => fn.sig === "public.get_form_filing_status(p_form_id uuid)").bodyContains)
      .toContain("'signatureRequired', private.form_template_requires_signature(rec.template_key)");
  });
});

const live = process.env.RUN_FORMS_TEMPLATE_SIGNATURE_DB_TESTS === "1" ? describe : describe.skip;

live("template-driven filer signature (live)", () => {
  let admin, member, other, steward;
  const ids = {
    member: randomUUID(), other: randomUUID(), steward: randomUUID(), org: randomUUID(),
    memberSession: randomUUID(), otherSession: randomUUID(), stewardSession: randomUUID(),
  };
  const chapter = `fdts-${ids.org.slice(0, 8)}`;
  const strokes = JSON.stringify([[{ x: 0, y: 0 }, { x: 1, y: 1 }]]);
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
      return { code: error.code, message: error.message, hint: error.hint ?? null };
    }
  };
  async function authUser(user, session) {
    await admin.query("insert into auth.users(id,email) values($1,$2)", [user, `${user}@forms-signature-proof.invalid`]);
    await admin.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
    await admin.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic factor','totp','verified',now(),now())", [randomUUID(), user]);
  }
  async function enroll(user, role) {
    await admin.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.org, user]);
    await admin.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now())", [user, chapter]);
    await admin.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
    if (role) {
      await admin.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [user, role, chapter]);
      await admin.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [user, role, chapter]);
      // Every steward has a unit (20261113115000); the grant commits with it.
      if (role === "steward") await scopeFixtureSteward(admin, user, chapter);
    }
  }
  // A complete draft of `templateKey` saved through save_form_draft.
  async function completeDraft(client, user, session, templateKey) {
    const keys = (await admin.query(
      "select private.form_required_keys(t.key, t.version) k from public.form_templates t where t.key=$1 and t.active order by t.version desc limit 1",
      [templateKey],
    )).rows[0].k;
    const answers = Object.fromEntries(keys.map((key) => [key, "proof answer"]));
    const saved = await call(client, user, session, "select public.save_form_draft($1,$2::jsonb,0) as id", [templateKey, JSON.stringify(answers)]);
    expect(saved.code, saved.message).toBeUndefined();
    return saved.rows[0].id;
  }
  const row = async (formId) => (await admin.query("select status from public.member_forms where id=$1", [formId])).rows[0] ?? null;
  const filingStatus = async (formId) => (await call(member, ids.member, ids.memberSession, "select public.get_form_filing_status($1) s", [formId])).rows?.[0]?.s;

  beforeAll(async () => {
    const url = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    [admin, member, other, steward] = [0, 1, 2, 3].map(() => new pg.Client({ connectionString: url }));
    await Promise.all([admin, member, other, steward].map((client) => client.connect()));
    await admin.query("begin");
    await authUser(ids.member, ids.memberSession);
    await admin.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [ids.org, chapter, ids.member]);
    await admin.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9908)", [chapter, ids.org]);
    await admin.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,false)", [ids.org]);
    await enroll(ids.member, null);
    await authUser(ids.other, ids.otherSession);
    await enroll(ids.other, null);
    await authUser(ids.steward, ids.stewardSession);
    await enroll(ids.steward, "steward");
    await admin.query("commit");
  });
  afterAll(async () => {
    try {
      await admin.query("delete from public.member_forms where user_id = any($1::uuid[])", [[ids.member, ids.other]]);
    } finally {
      await Promise.all([admin, member, other, steward].map((client) => client?.end()));
    }
  });

  it("submits, approves and files a service request without a drawn signature", async () => {
    const formId = await completeDraft(member, ids.member, ids.memberSession, "service_request");
    expect((await filingStatus(formId))?.signatureRequired).toBe(false);
    const answers = (await admin.query("select answers from public.member_forms where id=$1", [formId])).rows[0].answers;
    const submitted = await call(member, ids.member, ids.memberSession, "select public.submit_form($1,$2::jsonb)",
      [formId, JSON.stringify({ answers, attachmentIds: [] })]);
    expect(submitted.code, submitted.message).toBeUndefined();
    expect(await row(formId)).toEqual({ status: "submitted" });

    // The steward's reviewed content is still compared first (#8707).
    const unseen = await call(steward, ids.steward, ids.stewardSession, "select public.approve_form($1, null, $2::jsonb)",
      [formId, JSON.stringify({ answers: { ...answers, extra: "x" }, attachmentIds: [], cosignerIds: [] })]);
    expect(unseen.code).toBe("PT409");
    expect(await row(formId)).toEqual({ status: "submitted" });
    const approved = await call(steward, ids.steward, ids.stewardSession, "select public.approve_form($1, null, $2::jsonb)",
      [formId, JSON.stringify({ answers, attachmentIds: [], cosignerIds: [] })]);
    expect(approved.code, approved.message).toBeUndefined();
    expect(await row(formId)).toEqual({ status: "approved" });

    await admin.query("begin");
    await admin.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "service_role" })]);
    await admin.query("set local role service_role");
    const payload = (await admin.query("select public.get_form_filing_payload($1,$2) p", [formId, ids.member])).rows[0].p;
    await admin.query("commit");
    expect(payload).not.toBeNull();
    expect(payload.filerSignature ?? null).toBeNull();
  });

  it("still requires the drawn signature for a grievance, on submit and in its filing status", async () => {
    const formId = await completeDraft(member, ids.member, ids.memberSession, "grievance");
    expect((await filingStatus(formId))?.signatureRequired).toBe(true);
    const unsigned = await call(member, ids.member, ids.memberSession, "select public.submit_form($1)", [formId]);
    expect(unsigned.code).toBe("22023");
    expect(unsigned.message).toContain("draw and save a current signature");
    expect((await call(member, ids.member, ids.memberSession, "select public.sign_member_form($1,$2::jsonb,true)", [formId, strokes])).code).toBeUndefined();
    const signed = await call(member, ids.member, ids.memberSession, "select public.submit_form($1)", [formId]);
    expect(signed.code, signed.message).toBeUndefined();
  });

  it("accepts a typed signature for a grievance wherever a drawn one counts", async () => {
    const formId = await completeDraft(member, ids.member, ids.memberSession, "grievance");
    const typed = await call(member, ids.member, ids.memberSession, "select public.sign_member_form($1,null,true,null,'Proof Member')", [formId]);
    expect(typed.code, typed.message).toBeUndefined();
    const status = await filingStatus(formId);
    expect([status?.signatureRequired, status?.filerSigned, status?.filerSignatureKind]).toEqual([true, true, "typed"]);
    const submitted = await call(member, ids.member, ids.memberSession, "select public.submit_form($1)", [formId]);
    expect(submitted.code, submitted.message).toBeUndefined();
    const approved = await call(steward, ids.steward, ids.stewardSession, "select public.approve_form($1, null)", [formId]);
    expect(approved.code, approved.message).toBeUndefined();
  });
});
