// @vitest-environment node
//
// BUG-UG-FORM-APPROVAL-APPROVES-CONTENT-THE-STEWARD-NEVER-SAW-20261114 (#8707).
// A steward's approval approves only what the steward reviewed. approve_form
// (and approve_and_open_case, which calls it) approved and froze the filing as
// it stood when it ran, so a return and resubmission by another steward and
// the member, or a co-signer accepting or withdrawing while the form was in
// review, was approved unseen. Both now take an optional p_expected (the
// signature's fields plus the accepted co-signers shown) and compare it under
// the form lock. Null keeps the previous behaviour.
//
// Full migrated disposable database only. Fixtures are fictional and committed
// to the owned stack, and removed afterwards (best effort for approved forms).
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { scopeFixtureSteward } from "./helpers/steward-unit-fixtures.js";
import { sealFormAnswers } from "../api/_lib/sensitiveContent.js";
import { sensitiveKeyring } from "../api/_lib/sensitiveDataCrypto.js";

const STEM = "approve_form_expected_review";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("approve_form compares what the steward reviewed (static)", () => {
  let migration = "";
  beforeAll(() => { migration = stripComments(loadMigrationSql(STEM)); });

  it("replaces both approval entry points with ones whose last argument defaults to null, with the same grants", () => {
    expect(findMigrationName(STEM) > "20261113122500").toBe(true);
    expect(migration).toContain("drop function public.approve_form(uuid, text);");
    expect(migration).toContain("drop function public.approve_and_open_case(uuid, text);");
    expect(migration).toContain("create function public.approve_form(p_form_id uuid, p_note text DEFAULT NULL::text, p_expected jsonb DEFAULT NULL::jsonb)");
    expect(migration).toContain("perform public.approve_form(p_form_id, p_note, p_expected);");
    for (const sig of ["approve_form(uuid, text, jsonb)", "approve_and_open_case(uuid, text, jsonb)"]) {
      expect(migration).toContain(`revoke all on function public.${sig} from public, anon;`);
      expect(migration).toContain(`grant execute on function public.${sig} to authenticated, service_role;`);
    }
  });

  it("compares under the form lock, after the attachment checks and before the signature checks and the approval", () => {
    const approve = migration.slice(migration.indexOf("create function public.approve_form("), migration.indexOf("CREATE FUNCTION public.approve_and_open_case("));
    const at = (needle) => {
      const index = approve.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    expect(at("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);")).toBeLessThan(at("member_has_role(array['steward'])"));
    expect(at("perform private.lock_member_form(p_form_id);")).toBeLessThan(at("if p_expected is not null then"));
    expect(at("form has an attachment without a current inspection")).toBeLessThan(at("if p_expected is not null then"));
    expect(at("detail = 'form_changed_since_review'")).toBeLessThan(at("signature.content_digest <> current_digest"));
    expect(at("detail = 'form_changed_since_review'")).toBeLessThan(at("status = 'approved', review_note = clean_note"));
    expect(approve).toContain("where c.form_id = p_form_id and c.status = 'accepted'");
    expect(approve).toContain("(rec.encrypted_content #>> '{answers,dataVersion}')");
  });

  it("pins both new signatures in the database contract and the required proof lane", () => {
    for (const sig of ["public.approve_form(p_form_id uuid, p_note text, p_expected jsonb)", "public.approve_and_open_case(p_form_id uuid, p_note text, p_expected jsonb)"]) {
      const entry = contract.functions.find((row) => row.sig === sig);
      expect(entry?.exec, sig).toBe("authenticated,service_role");
      for (const needle of entry.bodyContains) expect(migration, needle).toContain(needle);
    }
    for (const sig of ["public.approve_form(p_form_id uuid, p_note text)", "public.approve_and_open_case(p_form_id uuid, p_note text)"]) {
      expect(contract.functions.some((row) => row.sig === sig)).toBe(false);
      expect(contract.functionsAbsent.some((row) => row.sig === sig)).toBe(true);
    }
    expect(PROOF_FILES).toContain("tests/approve-form-expected-review-db.test.js");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("approve_form compares what the steward reviewed on a disposable database", () => {
  let admin, member, stewardA, stewardB, cosigner;
  const ids = { member: randomUUID(), stewardA: randomUUID(), stewardB: randomUUID(), cosigner: randomUUID(), org: randomUUID() };
  const sessions = Object.fromEntries(Object.keys(ids).map((key) => [key, randomUUID()]));
  const email = (key) => `${ids[key]}@approve-review-proof.invalid`;
  const chapter = `approve-review-${ids.org.slice(0, 8)}`;
  const strokes = JSON.stringify([[{ x: 0, y: 0 }, { x: 1, y: 1 }]]);
  const ring = sensitiveKeyring("saas", { SENSITIVE_DATA_KEYS: JSON.stringify({ v1: randomBytes(32).toString("base64") }), SENSITIVE_DATA_ACTIVE_KEY: "v1" });
  let grievanceKeys, allianceKeys;

  const begin = async (client, key) => {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: ids[key], email: email(key), role: "authenticated", session_id: sessions[key], aal: "aal2" })]);
    await client.query("set local role authenticated");
  };
  const call = async (client, key, sql, values = []) => {
    await begin(client, key);
    try {
      const result = await client.query(sql, values);
      await client.query("commit");
      return { rows: result.rows };
    } catch (error) {
      await client.query("rollback");
      return { code: error.code, message: error.message, detail: error.detail };
    }
  };
  const ok = (result) => {
    expect(result.code, result.message).toBeUndefined();
    return result.rows[0];
  };
  const values = (keys, label) => Object.fromEntries(keys.map((key) => [key, key.includes("date") ? "2026-11-02" : `Fictional ${key} ${label}`]));
  const status = async (formId) => (await admin.query("select status from public.member_forms where id=$1", [formId])).rows[0].status;
  const fileOrdinary = async (templateKey, answers) => {
    const formId = ok(await call(member, "member", "select public.save_form_draft($1,$2,0) id", [templateKey, answers])).id;
    ok(await call(member, "member", "select public.sign_member_form($1,$2::jsonb,true)", [formId, strokes]));
    ok(await call(member, "member", "select public.submit_form($1)", [formId]));
    return formId;
  };
  const approve = (formId, expected, steward = stewardA, key = "stewardA") => expected === undefined
    ? call(steward, key, "select public.approve_form($1, null) v", [formId])
    : call(steward, key, "select public.approve_form($1, null, $2::jsonb) v", [formId, JSON.stringify(expected)]);
  const expectRefused = (result) => {
    expect(result.code, result.message).toBe("PT409");
    expect(result.detail).toBe("form_changed_since_review");
  };
  const waitingOnLock = async (pid) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await admin.query("select wait_event_type = 'Lock' w from pg_stat_activity where pid=$1", [pid])).rows[0]?.w === true) return true;
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    return false;
  };

  async function authUser(key) {
    await admin.query("insert into auth.users(id,email) values($1,$2)", [ids[key], email(key)]);
    await admin.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [sessions[key], ids[key]]);
    await admin.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic factor','totp','verified',now(),now())", [randomUUID(), ids[key]]);
  }
  async function enroll(key, role) {
    await admin.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.org, ids[key]]);
    await admin.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now())", [ids[key], chapter]);
    await admin.query("update public.member_profiles set chapter_id=$2 where id=$1", [ids[key], chapter]);
    if (role) {
      await admin.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [ids[key], role, chapter]);
      await admin.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [ids[key], role, chapter]);
      // Every steward has a unit (20261113115000); the grant commits with it.
      if (role === "steward") await scopeFixtureSteward(admin, ids[key], chapter);
    }
  }

  beforeAll(async () => {
    const url = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    [admin, member, stewardA, stewardB, cosigner] = [0, 1, 2, 3, 4].map(() => new pg.Client({ connectionString: url }));
    await Promise.all([admin, member, stewardA, stewardB, cosigner].map((client) => client.connect()));
    await admin.query("begin");
    await authUser("member");
    await admin.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$3,$4)", [ids.org, chapter, `Fictional Approval Proof Local ${chapter}`, ids.member]);
    await admin.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9910)", [chapter, ids.org]);
    await admin.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,false)", [ids.org]);
    await enroll("member", null);
    for (const key of ["stewardA", "stewardB"]) { await authUser(key); await enroll(key, "steward"); }
    await authUser("cosigner");
    await enroll("cosigner", null);
    await admin.query("commit");
    const keysOf = async (key) => (await admin.query("select private.form_required_keys($1, (select max(version) from public.form_templates where key=$1 and is_platform_seed)) k", [key])).rows[0].k;
    grievanceKeys = await keysOf("grievance");
    allianceKeys = await keysOf("alliance_grievance");
  });

  afterAll(async () => {
    try {
      const owned = (await admin.query("select id from public.member_forms where user_id=$1", [ids.member])).rows.map((row) => row.id);
      for (const formId of owned) {
        await admin.query("begin; set local session_replication_role=replica").catch(() => {});
        await admin.query("delete from public.member_forms where id=$1", [formId]).catch(() => {});
        await admin.query("commit").catch(() => admin.query("rollback").catch(() => {}));
      }
    } finally {
      await Promise.all([admin, member, stewardA, stewardB, cosigner].map((client) => client?.end()));
    }
  });

  it("exposes only the new signatures, to authenticated and service_role", async () => {
    const row = (await admin.query(`select to_regprocedure('public.approve_form(uuid,text)') old_approve,
      to_regprocedure('public.approve_and_open_case(uuid,text)') old_case,
      has_function_privilege('anon','public.approve_form(uuid,text,jsonb)','execute') anon,
      has_function_privilege('authenticated','public.approve_and_open_case(uuid,text,jsonb)','execute') authed`)).rows[0];
    expect(row).toEqual({ old_approve: null, old_case: null, anon: false, authed: true });
  });

  it("refuses answers resubmitted after another steward's return, approves nothing, and approves once they are named", async () => {
    const read = values(grievanceKeys, "as first filed");
    const formId = await fileOrdinary("grievance", read);
    // Steward A has the filing open. Steward B returns it; the member edits,
    // re-signs and resubmits.
    ok(await call(stewardB, "stewardB", "select public.return_form($1,'Fictional: add the shift date.')", [formId]));
    const resubmitted = values(grievanceKeys, "as resubmitted");
    ok(await call(member, "member", "select public.save_form_draft('grievance',$1,0,$2)", [resubmitted, formId]));
    ok(await call(member, "member", "select public.sign_member_form($1,$2::jsonb,true)", [formId, strokes]));
    ok(await call(member, "member", "select public.submit_form($1)", [formId]));
    expectRefused(await approve(formId, { answers: read, attachmentIds: [], cosignerIds: [] }));
    expect(await status(formId)).toBe("submitted");
    ok(await approve(formId, { answers: resubmitted, attachmentIds: [], cosignerIds: [] }));
    expect(await status(formId)).toBe("approved");
  });

  it("keeps the old behaviour without an expectation", async () => {
    const formId = await fileOrdinary("grievance", values(grievanceKeys, "legacy"));
    ok(await approve(formId));
    expect(await status(formId)).toBe("approved");
  });

  it("refuses a co-signer who accepted after the steward's read, and approves once the co-signer is named", async () => {
    const answers = values(allianceKeys, "alliance");
    const formId = await fileOrdinary("alliance_grievance", answers);
    ok(await call(member, "member", "select public.invite_cosigner($1,$2)", [formId, email("cosigner")]));
    ok(await call(cosigner, "cosigner", "select public.respond_to_cosign($1,true,$2::jsonb,true)", [formId, strokes]));
    const cosignerRow = (await admin.query("select id from public.member_form_cosigners where form_id=$1 and status='accepted'", [formId])).rows[0].id;
    expectRefused(await approve(formId, { answers, attachmentIds: [], cosignerIds: [] }));
    expect(await status(formId)).toBe("submitted");
    // approve_and_open_case refuses the same way and opens no case.
    const viaCase = await call(stewardA, "stewardA", "select public.approve_and_open_case($1, null, $2::jsonb) v", [formId, JSON.stringify({ answers, attachmentIds: [], cosignerIds: [] })]);
    expectRefused(viaCase);
    expect(await status(formId)).toBe("submitted");
    ok(await approve(formId, { answers, attachmentIds: [], cosignerIds: [cosignerRow.toUpperCase()] }));
    expect(await status(formId)).toBe("approved");
  });

  it("refuses a co-signer's withdrawal that commits while the approval waits on the form lock", async () => {
    const answers = values(allianceKeys, "alliance withdrawn");
    const formId = await fileOrdinary("alliance_grievance", answers);
    ok(await call(member, "member", "select public.invite_cosigner($1,$2)", [formId, email("cosigner")]));
    ok(await call(cosigner, "cosigner", "select public.respond_to_cosign($1,true,$2::jsonb,true)", [formId, strokes]));
    const cosignerRow = (await admin.query("select id from public.member_form_cosigners where form_id=$1 and status='accepted'", [formId])).rows[0].id;
    // The co-signer's withdrawal holds the form lock, uncommitted.
    await begin(cosigner, "cosigner");
    await cosigner.query("select public.withdraw_cosign($1)", [formId]);
    const pid = (await stewardA.query("select pg_backend_pid() pid")).rows[0].pid;
    const pending = approve(formId, { answers, attachmentIds: [], cosignerIds: [cosignerRow] });
    expect(await waitingOnLock(pid)).toBe(true);
    await cosigner.query("commit");
    expectRefused(await pending);
    expect(await status(formId)).toBe("submitted");
  });

  it("refuses a sealed form whose stored version differs from the one reviewed", async () => {
    const draft = ok(await call(member, "member", "select public.prepare_sealed_form('fmla_self') as draft")).draft;
    const formId = draft.formId;
    const sealedKeys = (await admin.query("select private.form_required_keys(f.template_key, f.template_version) k from public.member_forms f where f.id=$1", [formId])).rows[0].k;
    const envelope = sealFormAnswers(Object.fromEntries(sealedKeys.map((key) => [key, "2027-01-01"])), { id: formId, organization_id: ids.org }, ring);
    const args = { p_form_id: formId, p_step: 1, p_changed: true, p_filled: sealedKeys, p_data_version: envelope.dataVersion, p_expected_data_version: null };
    await admin.query("begin; set local role service_role");
    const ticket = (await admin.query("select public.stage_sensitive_write($1,'save_sealed_form_draft',$2,$3) as ticket", [ids.member, args, { answers: envelope }])).rows[0].ticket;
    await admin.query("commit");
    ok(await call(member, "member", "select public.write_sensitive_content('save_sealed_form_draft',$1,$2,$3) as id", [args, { answers: envelope }, ticket]));
    ok(await call(member, "member", "select public.sign_member_form($1,$2::jsonb,true)", [formId, strokes]));
    ok(await call(member, "member", "select public.submit_form($1)", [formId]));
    expectRefused(await approve(formId, { dataVersion: "not-the-stored-version", attachmentIds: [], cosignerIds: [] }));
    expect((await approve(formId, { answers: { sealed: true }, attachmentIds: [], cosignerIds: [] })).code).toBe("22023");
    expect(await status(formId)).toBe("submitted");
    ok(await approve(formId, { dataVersion: envelope.dataVersion, attachmentIds: [], cosignerIds: [] }));
    expect(await status(formId)).toBe("approved");
  });

  it("refuses an expectation that does not name what it needs, and approves nothing", async () => {
    const answers = values(grievanceKeys, "shape");
    const formId = await fileOrdinary("grievance", answers);
    for (const expected of [[], { answers, attachmentIds: [] }, { answers, cosignerIds: [] }, { dataVersion: "v", attachmentIds: [], cosignerIds: [] }]) {
      expect((await approve(formId, expected)).code, JSON.stringify(expected)).toBe("22023");
    }
    expect(await status(formId)).toBe("submitted");
  });
});
