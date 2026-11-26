// @vitest-environment node
//
// BUG-UG-ORDINARY-FORM-SAVE-OVERWRITES-A-NEWER-EDIT-FROM-ANOTHER-SESSION-20261114 (#8719).
// An ordinary draft save names the answers it was based on. save_form_draft
// wrote what it was given over whatever was stored, so a device that had shown
// older answers (its pre-sign or pre-submit save included) replaced the
// member's newer edit from another session and cleared that session's
// signature. It now takes an optional p_base_answers, compared under the form
// lock; a newer stored draft refuses with PT409 form_saved_elsewhere and
// nothing is written. Null keeps the previous behaviour.
//
// Full migrated disposable database only. Fixtures are fictional and committed
// to the owned stack, and removed afterwards.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";

const STEM = "save_form_draft_base_answers";
const CONTRACT_SIG = "public.save_form_draft(p_template_key text, p_answers jsonb, p_step integer, p_expected_form_id uuid, p_base_answers jsonb)";
const SIG = "public.save_form_draft(p_template_key text, p_answers jsonb, p_step integer, p_expected_form_id uuid DEFAULT NULL::uuid, p_base_answers jsonb DEFAULT NULL::jsonb)";
const UNIT_CONTRACT_SIG = "public.save_unit_form_draft(p_template_key text, p_answers jsonb, p_step integer, p_unit uuid, p_actor uuid, p_chapter text, p_organization uuid, p_expected_form_id uuid, p_base_answers jsonb)";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("save_form_draft compares the answers it was based on (static)", () => {
  let migration = "";
  beforeAll(() => { migration = stripComments(loadMigrationSql(STEM)); });

  it("replaces the four-argument save with one whose base defaults to null, with the same grants", () => {
    expect(findMigrationName(STEM) > "20261113115500").toBe(true);
    expect(migration).toContain("drop function public.save_form_draft(text, jsonb, integer, uuid);");
    expect(migration).toContain("p_expected_form_id uuid DEFAULT NULL::uuid, p_base_answers jsonb DEFAULT NULL::jsonb)");
    expect(migration).toContain("revoke all on function public.save_form_draft(text, jsonb, integer, uuid, jsonb) from public, anon;");
    expect(migration).toContain("grant execute on function public.save_form_draft(text, jsonb, integer, uuid, jsonb) to authenticated, service_role;");
  });

  it("compares under the form lock before anything is written, on both the named and the newest form", () => {
    const at = (needle) => {
      const index = migration.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    expect(at("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);")).toBeLessThan(at("private.mfa_satisfied()"));
    expect(at("perform private.lock_member_form(p_expected_form_id);")).toBeLessThan(at("detail = 'form_saved_elsewhere'"));
    expect(at("perform private.lock_member_form(existing);")).toBeLessThan(at("detail = 'form_saved_elsewhere'"));
    expect(at("detail = 'form_saved_elsewhere'")).toBeLessThan(at("insert into public.member_forms"));
    expect(at("detail = 'form_saved_elsewhere'")).toBeLessThan(at("delete from private.member_form_signatures where form_id = existing;"));
    expect(migration).toContain("raise exception 'sealed form templates save through the sensitive content API' using errcode = '22023';");
  });

  it("gives the unit save (20261113124000) the same base and passes it through", () => {
    expect(migration).toContain("drop function public.save_unit_form_draft(text, jsonb, integer, uuid, uuid, text, uuid, uuid);");
    expect(migration).toContain("p_expected_form_id uuid default null,p_base_answers jsonb default null)");
    expect(migration).toContain("result:=public.save_form_draft(p_template_key,p_answers,p_step,p_expected_form_id,p_base_answers);");
    expect(migration).toContain("grant execute on function public.save_unit_form_draft(text,jsonb,integer,uuid,uuid,text,uuid,uuid,jsonb) to authenticated;");
    expect(contract.functions.find((row) => row.sig === UNIT_CONTRACT_SIG)?.bodyContains)
      .toContain("public.save_form_draft(p_template_key,p_answers,p_step,p_expected_form_id,p_base_answers)");
    expect(contract.functionsAbsent.some((row) => row.sig === UNIT_CONTRACT_SIG.replace(", p_base_answers jsonb)", ")"))).toBe(true);
  });

  it("pins the new signature in the database contract and the required proof lane", () => {
    const entry = contract.functions.find((row) => row.sig === CONTRACT_SIG);
    expect(entry?.exec).toBe("authenticated,service_role");
    for (const needle of entry.bodyContains) expect(migration, needle).toContain(needle);
    expect(contract.functions.some((row) => row.sig === "public.save_form_draft(p_template_key text, p_answers jsonb, p_step integer, p_expected_form_id uuid)")).toBe(false);
    expect(contract.functionsAbsent.some((row) => row.sig === "public.save_form_draft(p_template_key text, p_answers jsonb, p_step integer, p_expected_form_id uuid)")).toBe(true);
    expect(PROOF_FILES).toContain("tests/save-form-draft-base-answers-db.test.js");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("save_form_draft compares the answers it was based on, on a disposable database", () => {
  let admin, phone, web;
  const ids = { member: randomUUID(), org: randomUUID(), phoneSession: randomUUID(), webSession: randomUUID() };
  const chapter = `save-base-${ids.org.slice(0, 8)}`;
  const strokes = JSON.stringify([[{ x: 0, y: 0 }, { x: 1, y: 1 }]]);

  // Two sessions of the same member: the phone and the website.
  const begin = async (client, session) => {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: ids.member, role: "authenticated", session_id: session, aal: "aal2" })]);
    await client.query("set local role authenticated");
  };
  const session = (client) => (client === phone ? ids.phoneSession : ids.webSession);
  const call = async (client, sql, values = []) => {
    await begin(client, session(client));
    try {
      const result = await client.query(sql, values);
      await client.query("commit");
      return { rows: result.rows };
    } catch (error) {
      await client.query("rollback");
      return { code: error.code, message: error.message, detail: error.detail };
    }
  };
  const save = (client, answers, { formId = null, base } = {}) => base === undefined
    ? call(client, "select public.save_form_draft('grievance',$1,1,$2) id", [answers, formId])
    : call(client, "select public.save_form_draft('grievance',$1,1,$2,$3::jsonb) id", [answers, formId, JSON.stringify(base)]);
  const sign = async (client, formId) => {
    const signed = await call(client, "select public.sign_member_form($1,$2::jsonb,true) v", [formId, strokes]);
    expect(signed.code, signed.message).toBeUndefined();
  };
  const stored = async (formId) => (await admin.query(`select f.answers, f.step, f.filer_signature_digest,
      (select count(*)::int from private.member_form_signatures s where s.form_id = f.id) signatures,
      (select count(*)::int from public.member_forms o where o.user_id = f.user_id and o.template_key = 'grievance' and o.status in ('draft','returned')) open_forms
    from public.member_forms f where f.id = $1`, [formId])).rows[0];
  const expectRefused = (result) => {
    expect(result.code, result.message).toBe("PT409");
    expect(result.detail).toBe("form_saved_elsewhere");
  };
  const discard = async () => {
    await admin.query("begin; set local session_replication_role=replica");
    await admin.query("delete from public.member_forms where user_id=$1", [ids.member]);
    await admin.query("commit");
  };
  const waitingOnLock = async (pid) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await admin.query("select wait_event_type = 'Lock' w from pg_stat_activity where pid=$1", [pid])).rows[0]?.w === true) return true;
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    return false;
  };

  beforeAll(async () => {
    const url = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    [admin, phone, web] = [0, 1, 2].map(() => new pg.Client({ connectionString: url }));
    await Promise.all([admin.connect(), phone.connect(), web.connect()]);
    await admin.query("begin");
    await admin.query("insert into auth.users(id,email) values($1,$2)", [ids.member, `${ids.member}@save-base-proof.invalid`]);
    for (const id of [ids.phoneSession, ids.webSession]) {
      await admin.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [id, ids.member]);
    }
    await admin.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic factor','totp','verified',now(),now())", [randomUUID(), ids.member]);
    await admin.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$3,$4)", [ids.org, chapter, `Fictional Save Proof Local ${chapter}`, ids.member]);
    await admin.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9911)", [chapter, ids.org]);
    await admin.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,false)", [ids.org]);
    await admin.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.org, ids.member]);
    await admin.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now())", [ids.member, chapter]);
    await admin.query("update public.member_profiles set chapter_id=$2 where id=$1", [ids.member, chapter]);
    await admin.query("commit");
  });

  afterAll(async () => {
    try { await discard(); } finally { await Promise.all([admin, phone, web].map((client) => client?.end())); }
  });

  it("exposes only the five-argument save, to authenticated and service_role", async () => {
    const row = (await admin.query(`select to_regprocedure('public.save_form_draft(text,jsonb,integer,uuid)') old,
      pg_get_function_arguments('public.save_form_draft(text,jsonb,integer,uuid,jsonb)'::regprocedure) args,
      has_function_privilege('anon','public.save_form_draft(text,jsonb,integer,uuid,jsonb)','execute') anon,
      has_function_privilege('authenticated','public.save_form_draft(text,jsonb,integer,uuid,jsonb)','execute') authed`)).rows[0];
    expect(row.old).toBeNull();
    expect(`public.save_form_draft(${row.args})`).toBe(SIG);
    expect(row.anon).toBe(false);
    expect(row.authed).toBe(true);
  });

  it("refuses a unit save based on older answers too, and writes nothing", async () => {
    await discard();
    const unitSave = (client, answers, formId, base) => call(client,
      "select public.save_unit_form_draft('grievance',$1,1,null,$2,$3,$4,$5,$6::jsonb) id",
      [answers, ids.member, chapter, ids.org, formId, base === null ? null : JSON.stringify(base)]);
    const first = { summary: "Fictional unit grievance" };
    const created = await unitSave(phone, first, null, null);
    expect(created.code, created.message).toBeUndefined();
    const formId = created.rows[0].id;
    const newer = { ...first, witnesses: "B. Okafor" };
    expect((await unitSave(web, newer, formId, first)).code).toBeUndefined();
    expectRefused(await unitSave(phone, { ...first, remedy: "Stale" }, formId, first));
    expect((await stored(formId)).answers).toEqual(newer);
    expect((await unitSave(phone, { ...newer, remedy: "Fictional make whole" }, formId, newer)).code).toBeUndefined();
    expect((await stored(formId)).answers).toEqual({ ...newer, remedy: "Fictional make whole" });
    const old = (await admin.query("select to_regprocedure('public.save_unit_form_draft(text,jsonb,integer,uuid,uuid,text,uuid,uuid)') v")).rows[0].v;
    expect(old).toBeNull();
  });

  // Gate round 1 on #8770: a second session's first save names no form, so
  // the save picks the draft the first session created and signed meanwhile;
  // its base {} (a new form) refuses that overwrite.
  it("refuses a first save based on a new form when another session created and signed the draft meanwhile", async () => {
    await discard();
    const signedElsewhere = { summary: "Fictional filed from the website" };
    const formId = (await save(web, signedElsewhere, { base: {} })).rows[0].id;
    await sign(web, formId);
    const before = await stored(formId);
    expectRefused(await save(phone, { summary: "Fictional phone first save" }, { base: {} }));
    const after = await stored(formId);
    expect(after.answers).toEqual(signedElsewhere);
    expect(after.filer_signature_digest).toBe(before.filer_signature_digest);
    expect(after.signatures).toBe(1);
    expect(after.open_forms).toBe(1);
  });

  it("refuses the phone's save based on older answers, keeping the website's newer answers and signature (the Android run)", async () => {
    await discard();
    const reviewed = { summary: "Fictional overtime skipped", witnesses: "" };
    const formId = (await save(phone, reviewed)).rows[0].id;
    await sign(phone, formId);
    // The website resumes the draft, adds a witness and signs it.
    const newer = { summary: "Fictional overtime skipped", witnesses: "A. Reyes" };
    expect((await save(web, newer, { formId, base: reviewed })).code).toBeUndefined();
    await sign(web, formId);
    const before = await stored(formId);
    // The phone's pre-submit save of the answers it showed.
    expectRefused(await save(phone, reviewed, { formId, base: reviewed }));
    const after = await stored(formId);
    expect(after.answers).toEqual(newer);
    expect(after.filer_signature_digest).toBe(before.filer_signature_digest);
    expect(after.signatures).toBe(1);
    // Based on what is stored now, the save goes through.
    expect((await save(phone, { ...newer, remedy: "Fictional make whole" }, { formId, base: newer })).code).toBeUndefined();
    expect((await stored(formId)).answers).toEqual({ ...newer, remedy: "Fictional make whole" });
  });

  it("compares against the newest open form when no form is named, and writes nothing on a refusal", async () => {
    await discard();
    const first = { summary: "Fictional first version" };
    const formId = (await save(phone, first)).rows[0].id;
    expect((await save(web, { summary: "Fictional website version" })).code).toBeUndefined();
    expectRefused(await save(phone, { summary: "Fictional phone version" }, { base: first }));
    const row = await stored(formId);
    expect(row.answers).toEqual({ summary: "Fictional website version" });
    expect(row.open_forms).toBe(1);
  });

  it("keeps the old behaviour without a base, and a first save has nothing to compare", async () => {
    await discard();
    const created = await save(phone, { summary: "Fictional new draft" }, { base: { summary: "anything" } });
    expect(created.code, created.message).toBeUndefined();
    const formId = created.rows[0].id;
    expect((await save(web, { summary: "Fictional website edit" })).code).toBeUndefined();
    expect((await save(phone, { summary: "Fictional last writer" }, { formId })).code).toBeUndefined();
    expect((await stored(formId)).answers).toEqual({ summary: "Fictional last writer" });
  });

  it("refuses a base that is not an object, and keeps its own token apart from a closed form's", async () => {
    await discard();
    const formId = (await save(phone, { summary: "Fictional shape" })).rows[0].id;
    for (const base of [[], "answers", 3]) {
      expect((await save(phone, { summary: "x" }, { formId, base })).code, JSON.stringify(base)).toBe("22023");
    }
    const closed = await save(phone, { summary: "x" }, { formId: randomUUID(), base: { summary: "Fictional shape" } });
    expect(closed.code).toBe("PT409");
    expect(closed.detail).toBe("form_not_editable");
  });

  it("refuses a save that waited on the form lock while another session saved", async () => {
    await discard();
    const base = { summary: "Fictional as loaded" };
    const formId = (await save(phone, base)).rows[0].id;
    // The website's save holds the form lock, uncommitted.
    await begin(web, ids.webSession);
    await web.query("select public.save_form_draft('grievance',$1,1,$2,$3::jsonb)", [{ summary: "Fictional website save" }, formId, JSON.stringify(base)]);
    const pid = (await phone.query("select pg_backend_pid() pid")).rows[0].pid;
    const pending = save(phone, { summary: "Fictional phone save" }, { formId, base });
    expect(await waitingOnLock(pid)).toBe(true);
    await web.query("commit");
    expectRefused(await pending);
    expect((await stored(formId)).answers).toEqual({ summary: "Fictional website save" });
  });
});
