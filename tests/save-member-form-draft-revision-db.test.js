// @vitest-environment node
//
// BUG-UG-ORDINARY-FORM-SAVES-HAVE-NO-PER-WRITE-REVISION-20261118 (#9092).
// An ordinary form draft gets a number that names one write. Equal answers
// cannot order two writes ("A loaded before B landed" and "A saved back after
// B" look the same), so member_forms.revision is owned by a trigger (1 on
// insert, one more each time the answers change, unchanged otherwise) and
// save_member_form_draft refuses PT409 form_saved_elsewhere, writing nothing,
// unless the stored revision is the one the save was based on. The existing
// save_form_draft and save_unit_form_draft stay for the phone app and for
// outbox saves queued before the website change.
//
// Full migrated disposable database only. Fixtures are fictional and committed
// to the owned stack, and removed afterwards.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";

const STEM = "member_form_draft_revision";
const SAVE_SIG = "public.save_member_form_draft(p_template_key text, p_answers jsonb, p_step integer, p_expected_form_id uuid, p_base_revision bigint)";
const UNIT_SIG = "public.save_unit_member_form_draft(p_template_key text, p_answers jsonb, p_step integer, p_unit uuid, p_actor uuid, p_chapter text, p_organization uuid, p_expected_form_id uuid, p_base_revision bigint)";
const OLD_SAVE_SIG = "public.save_form_draft(p_template_key text, p_answers jsonb, p_step integer, p_expected_form_id uuid, p_base_answers jsonb)";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("ordinary form saves name one write (static)", () => {
  let migration = "";
  beforeAll(() => { migration = stripComments(loadMigrationSql(STEM)); });
  const at = (needle) => {
    const index = migration.indexOf(needle);
    expect(index, needle).toBeGreaterThan(-1);
    return index;
  };

  it("adds a trigger-owned revision and leaves the existing saves in place", () => {
    expect(findMigrationName(STEM) > "20261113134400").toBe(true);
    expect(migration).toContain("alter table public.member_forms add column revision bigint not null default 1;");
    expect(migration).toContain("before insert or update on public.member_forms");
    expect(migration).toContain("for each row execute function private.member_form_revision();");
    expect(migration).toContain("revoke all on function private.member_form_revision() from public, anon, authenticated, service_role;");
    expect(migration).not.toMatch(/drop function public\.save_(unit_)?form_draft/u);
    expect(migration).not.toMatch(/create (or replace )?function public\.save_(unit_)?form_draft/iu);
  });

  it("compares the revision under both locks before anything is written", () => {
    expect(at("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);")).toBeLessThan(at("private.mfa_satisfied()"));
    expect(at("private.mfa_satisfied()")).toBeLessThan(at("hashtextextended('member-form-' || caller::text || '-' || p_template_key, 509)"));
    expect(at("if p_base_revision > 0 and p_expected_form_id is null then")).toBeLessThan(at("hashtextextended('member-form-' || caller::text || '-' || p_template_key, 509)"));
    expect(at("perform private.lock_member_form(p_expected_form_id);")).toBeLessThan(at("if coalesce(stored, 0) <> p_base_revision then"));
    expect(at("perform private.lock_member_form(existing);")).toBeLessThan(at("if coalesce(stored, 0) <> p_base_revision then"));
    expect(at("detail = 'form_saved_elsewhere'")).toBeLessThan(at("saved := public.save_form_draft(p_template_key, clean, p_step, existing, null::jsonb);"));
  });

  it("grants the save to authenticated and service_role and the unit save to authenticated only", () => {
    expect(migration).toContain("revoke all on function public.save_member_form_draft(text, jsonb, integer, uuid, bigint) from public, anon;");
    expect(migration).toContain("grant execute on function public.save_member_form_draft(text, jsonb, integer, uuid, bigint) to authenticated, service_role;");
    expect(migration).toContain("revoke all on function public.save_unit_member_form_draft(text,jsonb,integer,uuid,uuid,text,uuid,uuid,bigint) from public,anon,authenticated,service_role;");
    expect(migration).toContain("grant execute on function public.save_unit_member_form_draft(text,jsonb,integer,uuid,uuid,text,uuid,uuid,bigint) to authenticated;");
  });

  it("pins every new object in the database contract, keeps the old save pinned, and runs in the required proof lane", () => {
    const save = contract.functions.find((row) => row.sig === SAVE_SIG);
    expect(save?.exec).toBe("authenticated,service_role");
    expect(contract.functions.find((row) => row.sig === UNIT_SIG)?.exec).toBe("authenticated");
    for (const entry of [save, contract.functions.find((row) => row.sig === UNIT_SIG), contract.functions.find((row) => row.sig === "private.member_form_revision()")]) {
      for (const needle of entry.bodyContains) expect(migration, needle).toContain(needle);
    }
    expect(contract.functions.some((row) => row.sig === OLD_SAVE_SIG)).toBe(true);
    expect(contract.triggers.find((row) => row.table === "member_forms" && row.name === "member_forms_revision")).toMatchObject({
      function: "private.member_form_revision", timing: "BEFORE", events: "INSERT,UPDATE", forEachRow: true,
    });
    expect(PROOF_FILES).toContain("tests/save-member-form-draft-revision-db.test.js");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("ordinary form saves name one write, on a disposable database", () => {
  let admin, phone, web;
  const ids = { member: randomUUID(), org: randomUUID(), phoneSession: randomUUID(), webSession: randomUUID() };
  const chapter = `save-rev-${ids.org.slice(0, 8)}`;
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
  const save = async (client, answers, { formId = null, base, step = 1 } = {}) => {
    // JSON text, so an array reaches the database as a jsonb array (node-pg
    // would send a JS array as a Postgres array literal).
    const result = await call(client, "select public.save_member_form_draft('grievance',$1::jsonb,$2,$3,$4) v",
      [JSON.stringify(answers), step, formId, base]);
    return result.rows ? { value: result.rows[0].v } : result;
  };
  const saved = async (client, answers, options) => {
    const result = await save(client, answers, options);
    expect(result.code, result.message).toBeUndefined();
    return result.value;
  };
  const sign = async (client, formId) => {
    const signed = await call(client, "select public.sign_member_form($1,$2::jsonb,true) v", [formId, strokes]);
    expect(signed.code, signed.message).toBeUndefined();
  };
  const stored = async (formId) => (await admin.query(`select f.answers, f.step, f.revision::int revision, f.updated_at, f.filer_signature_digest,
      (select count(*)::int from private.member_form_signatures s where s.form_id = f.id) signatures,
      (select count(*)::int from public.member_forms o where o.user_id = f.user_id and o.template_key = 'grievance' and o.status in ('draft','returned')) open_forms
    from public.member_forms f where f.id = $1`, [formId])).rows[0];
  const expectRefused = (result, detail = "form_saved_elsewhere") => {
    expect(result.code, result.message).toBe("PT409");
    expect(result.detail).toBe(detail);
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
    await admin.query("insert into auth.users(id,email) values($1,$2)", [ids.member, `${ids.member}@save-revision-proof.invalid`]);
    for (const id of [ids.phoneSession, ids.webSession]) {
      await admin.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [id, ids.member]);
    }
    await admin.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic factor','totp','verified',now(),now())", [randomUUID(), ids.member]);
    await admin.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$3,$4)", [ids.org, chapter, `Fictional Revision Proof Local ${chapter}`, ids.member]);
    await admin.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9912)", [chapter, ids.org]);
    await admin.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,false)", [ids.org]);
    await admin.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.org, ids.member]);
    await admin.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now())", [ids.member, chapter]);
    await admin.query("update public.member_profiles set chapter_id=$2 where id=$1", [ids.member, chapter]);
    await admin.query("commit");
  });

  afterAll(async () => {
    try { await discard(); } finally { await Promise.all([admin, phone, web].map((client) => client?.end())); }
  });

  it("exposes the new saves to their roles only, and keeps the existing saves", async () => {
    const row = (await admin.query(`select
      has_function_privilege('anon','public.save_member_form_draft(text,jsonb,integer,uuid,bigint)','execute') anon,
      has_function_privilege('authenticated','public.save_member_form_draft(text,jsonb,integer,uuid,bigint)','execute') authed,
      has_function_privilege('service_role','public.save_member_form_draft(text,jsonb,integer,uuid,bigint)','execute') service,
      has_function_privilege('anon','public.save_unit_member_form_draft(text,jsonb,integer,uuid,uuid,text,uuid,uuid,bigint)','execute') unit_anon,
      has_function_privilege('authenticated','public.save_unit_member_form_draft(text,jsonb,integer,uuid,uuid,text,uuid,uuid,bigint)','execute') unit_authed,
      has_function_privilege('service_role','public.save_unit_member_form_draft(text,jsonb,integer,uuid,uuid,text,uuid,uuid,bigint)','execute') unit_service,
      to_regprocedure('public.save_form_draft(text,jsonb,integer,uuid,jsonb)') is not null old_save,
      to_regprocedure('public.save_unit_form_draft(text,jsonb,integer,uuid,uuid,text,uuid,uuid,jsonb)') is not null old_unit,
      has_column_privilege('authenticated','public.member_forms','revision','select') readable`)).rows[0];
    expect(row).toEqual({ anon: false, authed: true, service: true, unit_anon: false, unit_authed: true, unit_service: false, old_save: true, old_unit: true, readable: true });
  });

  it("numbers each write of the answers, and a step-only save keeps the number", async () => {
    await discard();
    const first = await saved(phone, { summary: "Fictional first" }, { base: 0 });
    expect(first.revision).toBe(1);
    const second = await saved(phone, { summary: "Fictional second" }, { formId: first.formId, base: 1 });
    expect(second).toEqual({ formId: first.formId, revision: 2 });
    const stepped = await saved(phone, { summary: "Fictional second" }, { formId: first.formId, base: 2, step: 3 });
    expect(stepped.revision).toBe(2);
    expect(await stored(first.formId)).toMatchObject({ step: 3, revision: 2, answers: { summary: "Fictional second" } });
  });

  it("refuses a late replay based on an older write, keeping the newer answers and signature (the #8949 sequences)", async () => {
    await discard();
    const a = { summary: "Fictional overtime skipped" };
    const created = await saved(phone, a, { base: 0 });
    // The website saves B over revision 1 and signs it.
    const b = { ...a, witnesses: "A. Reyes" };
    expect((await saved(web, b, { formId: created.formId, base: 1 })).revision).toBe(2);
    await sign(web, created.formId);
    const before = await stored(created.formId);
    // The phone's replay of a save based on revision 1, whatever its answers.
    for (const answers of [a, b, { ...a, remedy: "Stale" }]) {
      expectRefused(await save(phone, answers, { formId: created.formId, base: 1 }));
    }
    const after = await stored(created.formId);
    expect(after).toEqual(before);
    expect(after.signatures).toBe(1);
    // Based on the stored write, it goes through.
    expect((await saved(phone, { ...b, remedy: "Fictional make whole" }, { formId: created.formId, base: 2 })).revision).toBe(3);
  });

  it("gives a write of A back over B a new number, so A loaded earlier and A saved later differ", async () => {
    await discard();
    const a = { summary: "Fictional A" };
    const created = await saved(phone, a, { base: 0 });
    await saved(web, { summary: "Fictional B" }, { formId: created.formId, base: 1 });
    const back = await saved(web, a, { formId: created.formId, base: 2 });
    expect(back.revision).toBe(3);
    // The phone loaded A at revision 1; its save is refused although the answers match.
    expectRefused(await save(phone, a, { formId: created.formId, base: 1 }));
    expect((await stored(created.formId)).revision).toBe(3);
  });

  it("takes an unnamed save at base 0 only: refused when an open draft exists, and a base above 0 must name its form", async () => {
    await discard();
    const signedElsewhere = { summary: "Fictional filed from the website" };
    const created = await saved(web, signedElsewhere, { base: 0 });
    await sign(web, created.formId);
    const before = await stored(created.formId);
    expectRefused(await save(phone, { summary: "Fictional phone first save" }, { base: 0 }));
    for (const base of [1, 2]) {
      expect((await save(phone, { summary: "Fictional phone save" }, { base })).code, String(base)).toBe("22023");
    }
    expect(await stored(created.formId)).toEqual(before);
    expect(before.open_forms).toBe(1);
    expect((await saved(phone, { summary: "Fictional phone save" }, { formId: created.formId, base: 1 })).formId).toBe(created.formId);
  });

  it("refuses a late save against a submitted draft, keeping the replacement draft's answers (both start at revision 1)", async () => {
    await discard();
    const keys = (await admin.query("select private.form_required_keys('grievance', (select max(version) from public.form_templates where key='grievance' and is_platform_seed)) k")).rows[0].k;
    const first = Object.fromEntries(keys.map((key) => [key, key.includes("date") ? "2026-11-02" : `Fictional ${key} first`]));
    const filed = await saved(web, first, { base: 0 });
    await sign(web, filed.formId);
    const submitted = await call(web, "select public.submit_form($1)", [filed.formId]);
    expect(submitted.code, submitted.message).toBeUndefined();
    const replacement = await saved(web, { summary: "Fictional replacement grievance" }, { base: 0 });
    expect(replacement.formId).not.toBe(filed.formId);
    expect(replacement.revision).toBe(1);
    const before = await stored(replacement.formId);
    // The phone's save was made against the first draft at revision 1 and arrives late.
    const late = { ...first, remedy: "Fictional stale remedy" };
    expect((await save(phone, late, { base: 1 })).code).toBe("22023");
    expectRefused(await save(phone, late, { formId: filed.formId, base: 1 }), "form_not_editable");
    expect(await stored(replacement.formId)).toEqual(before);
    expect((await admin.query("select status from public.member_forms where id=$1", [filed.formId])).rows[0].status).not.toMatch(/^(draft|returned)$/u);
  });

  it("refuses a base that names a write without its form, and a closed or unknown form", async () => {
    await discard();
    expect((await save(phone, { summary: "Fictional" }, { base: 4 })).code).toBe("22023");
    expect((await admin.query("select count(*)::int n from public.member_forms where user_id=$1", [ids.member])).rows[0].n).toBe(0);
    expectRefused(await save(phone, { summary: "Fictional" }, { formId: randomUUID(), base: 1 }), "form_not_editable");
  });

  it("refuses a missing or negative base and answers that are not an object", async () => {
    await discard();
    const created = await saved(phone, { summary: "Fictional shape" }, { base: 0 });
    for (const base of [null, -1]) {
      expect((await save(phone, { summary: "x" }, { formId: created.formId, base })).code, String(base)).toBe("22023");
    }
    expect((await save(phone, [], { formId: created.formId, base: 1 })).code).toBe("22023");
    expect((await stored(created.formId)).revision).toBe(1);
  });

  it("refuses a save that waited on the form lock while another session saved", async () => {
    await discard();
    const created = await saved(phone, { summary: "Fictional as loaded" }, { base: 0 });
    // The website's save holds the form lock, uncommitted.
    await begin(web, ids.webSession);
    await web.query("select public.save_member_form_draft('grievance',$1,1,$2,1)", [{ summary: "Fictional website save" }, created.formId]);
    const pid = (await phone.query("select pg_backend_pid() pid")).rows[0].pid;
    const pending = save(phone, { summary: "Fictional phone save" }, { formId: created.formId, base: 1 });
    expect(await waitingOnLock(pid)).toBe(true);
    await web.query("commit");
    expectRefused(await pending);
    expect(await stored(created.formId)).toMatchObject({ revision: 2, answers: { summary: "Fictional website save" } });
  });

  it("numbers the existing save's writes too, so a phone save moves the revision the website compares", async () => {
    await discard();
    const created = await saved(web, { summary: "Fictional website" }, { base: 0 });
    const old = await call(phone, "select public.save_form_draft('grievance',$1,1,$2) id", [{ summary: "Fictional phone" }, created.formId]);
    expect(old.code, old.message).toBeUndefined();
    expect((await stored(created.formId)).revision).toBe(2);
    expectRefused(await save(web, { summary: "Fictional website again" }, { formId: created.formId, base: 1 }));
  });

  it("owns the number in the trigger: no insert or update sets it, and other columns leave it alone", async () => {
    await discard();
    const created = await saved(phone, { summary: "Fictional owned" }, { base: 0 });
    await admin.query("update public.member_forms set revision = 99, step = 4 where id = $1", [created.formId]);
    expect((await stored(created.formId)).revision).toBe(1);
    await admin.query("update public.member_forms set revision = 0, answers = $2 where id = $1", [created.formId, { summary: "Fictional changed" }]);
    expect((await stored(created.formId)).revision).toBe(2);
    await discard();
    const inserted = (await admin.query(`insert into public.member_forms(user_id, template_key, template_version, answers, step, revision)
      select $1, 'grievance', version, '{}'::jsonb, 0, 50 from public.form_templates where key = 'grievance' and is_platform_seed order by version desc limit 1
      returning revision::int`, [ids.member])).rows[0];
    expect(inserted.revision).toBe(1);
  });

  it("refuses a unit save based on an older write too, and writes nothing", async () => {
    await discard();
    const unitSave = async (client, answers, formId, base) => {
      const result = await call(client, "select public.save_unit_member_form_draft('grievance',$1,1,null,$2,$3,$4,$5,$6) v",
        [answers, ids.member, chapter, ids.org, formId, base]);
      return result.rows ? { value: result.rows[0].v } : result;
    };
    const first = { summary: "Fictional unit grievance" };
    const created = await unitSave(phone, first, null, 0);
    expect(created.code, created.message).toBeUndefined();
    const formId = created.value.formId;
    const newer = { ...first, witnesses: "B. Okafor" };
    expect((await unitSave(web, newer, formId, 1)).value).toEqual({ formId, revision: 2 });
    expectRefused(await unitSave(phone, { ...first, remedy: "Stale" }, formId, 1));
    expect((await stored(formId)).answers).toEqual(newer);
    expect((await unitSave(phone, { ...newer, remedy: "Fictional make whole" }, formId, 2)).value).toEqual({ formId, revision: 3 });
  });
});
