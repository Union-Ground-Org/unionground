// @vitest-environment node
// Full migrated disposable database only; the stack is destroyed afterwards.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { scopeFixtureSteward } from "./helpers/steward-unit-fixtures.js";

// REQ-UG-FORMS-DISCARD-DRAFT-AND-TEMPLATE-SIGNATURE-20261111 (#8281): discard only.
const migration = readFileSync(new URL("../supabase/migrations/20261120020852_forms_discard_draft.sql", import.meta.url), "utf8");
const runner = readFileSync(new URL("../scripts/run-required-db-proofs.mjs", import.meta.url), "utf8");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("discarding a saved form draft (static)", () => {
  it("lets a member delete only their own never-submitted draft", () => {
    expect(migration).toContain("if not found or rec.user_id <> caller or rec.status <> 'draft'\n     or rec.submitted_at is not null or rec.case_id is not null then\n    raise exception 'form not found' using errcode = '22023';");
    expect(migration).toContain("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);");
    expect(migration).toContain("revoke all on function public.discard_form_draft(uuid) from public, anon, service_role;");
    expect(migration).toContain("grant execute on function public.discard_form_draft(uuid) to authenticated;");
  });

  // Rebuilt on the newest bodies (stamp 20261113135000): each replaced
  // function keeps the reviewed-content check its newer migration added, the
  // dropped two-argument approve_form is not recreated, and save_form_draft is
  // left to 20261113114500, whose save naming its form is refused once that
  // form is no longer the caller's open draft.
  it("is in the proof lane and the contract", () => {
    expect(PROOF_FILES).toContain("tests/forms-discard-draft-db.test.js");
    expect(runner).toContain('RUN_FORMS_DISCARD_DB_TESTS: "1"');
    expect(contract.functions.find((fn) => fn.sig === "public.discard_form_draft(p_form_id uuid)")?.exec).toBe("authenticated");
  });
});

const live = process.env.RUN_FORMS_DISCARD_DB_TESTS === "1" ? describe : describe.skip;

live("discarding a saved form draft (live)", () => {
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
    await admin.query("insert into auth.users(id,email) values($1,$2)", [user, `${user}@forms-discard-proof.invalid`]);
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

  it("discards the member's own draft with its signature, and refuses anyone else's the same way as a missing one", async () => {
    const formId = await completeDraft(member, ids.member, ids.memberSession, "grievance");
    expect((await call(member, ids.member, ids.memberSession, "select public.sign_member_form($1,$2::jsonb,true)", [formId, strokes])).code).toBeUndefined();
    const foreign = await call(other, ids.other, ids.otherSession, "select public.discard_form_draft($1)", [formId]);
    expect(foreign.code).toBe("22023");
    expect(foreign.message).toContain("form not found");
    const missing = await call(other, ids.other, ids.otherSession, "select public.discard_form_draft($1)", [randomUUID()]);
    expect([missing.code, missing.message]).toEqual([foreign.code, foreign.message]);
    expect(await row(formId)).toEqual({ status: "draft" });

    const own = await call(member, ids.member, ids.memberSession, "select public.discard_form_draft($1) r", [formId]);
    expect(own.code, own.message).toBeUndefined();
    expect(own.rows[0].r).toEqual({ formId, discarded: true });
    expect(await row(formId)).toBeNull();
    expect((await admin.query("select count(*)::int n from private.member_form_signatures where form_id=$1", [formId])).rows[0].n).toBe(0);
  });

  it("never discards a form once it was submitted", async () => {
    const formId = await completeDraft(member, ids.member, ids.memberSession, "grievance");
    expect((await call(member, ids.member, ids.memberSession, "select public.sign_member_form($1,$2::jsonb,true)", [formId, strokes])).code).toBeUndefined();
    const submitted = await call(member, ids.member, ids.memberSession, "select public.submit_form($1)", [formId]);
    expect(submitted.code, submitted.message).toBeUndefined();
    const late = await call(member, ids.member, ids.memberSession, "select public.discard_form_draft($1)", [formId]);
    expect([late.code, late.message]).toEqual(["22023", "form not found"]);
    expect(await row(formId)).toEqual({ status: "submitted" });
  });

  it("refuses a save naming a discarded draft, while an unbound save still starts a new one", async () => {
    const bound = (formId, answers, client = member, user = ids.member, session = ids.memberSession, templateKey = "grievance") =>
      call(client, user, session, "select public.save_form_draft($1,$2::jsonb,1,$3) as id", [templateKey, JSON.stringify(answers), formId]);
    const inProgress = async () => (await admin.query(
      "select id from public.member_forms where user_id=$1 and template_key='grievance' and status in ('draft','returned')", [ids.member])).rows.map((r) => r.id);
    const formId = await completeDraft(member, ids.member, ids.memberSession, "grievance");

    const kept = await bound(formId, { narrative: "Edited in tab A" });
    expect(kept.code, kept.message).toBeUndefined();
    expect(kept.rows[0].id).toBe(formId);
    expect((await admin.query("select answers->>'narrative' n from public.member_forms where id=$1", [formId])).rows[0].n).toBe("Edited in tab A");

    // Tab B discards it; tab A's pending autosave arrives afterwards.
    expect((await call(member, ids.member, ids.memberSession, "select public.discard_form_draft($1)", [formId])).code).toBeUndefined();
    const late = await bound(formId, { narrative: "Discarded answers" });
    expect([late.code, late.message]).toEqual(["PT409", "form no longer editable"]);
    expect(await inProgress()).toEqual([]);

    // A new, unbound draft still saves, and is not anyone else's to write.
    const fresh = await call(member, ids.member, ids.memberSession, "select public.save_form_draft('grievance','{}'::jsonb,0) as id");
    expect(fresh.code, fresh.message).toBeUndefined();
    expect(fresh.rows[0].id).not.toBe(formId);
    expect(await inProgress()).toEqual([fresh.rows[0].id]);
    const foreign = await bound(fresh.rows[0].id, { narrative: "Not mine" }, other, ids.other, ids.otherSession);
    // Someone else's form reads exactly like a discarded one.
    expect([foreign.code, foreign.message]).toEqual(["PT409", "form no longer editable"]);
    const wrongTemplate = await bound(fresh.rows[0].id, {}, member, ids.member, ids.memberSession, "service_request");
    expect(wrongTemplate.code).toBe("PT409");
    expect((await admin.query("select answers from public.member_forms where id=$1", [fresh.rows[0].id])).rows[0].answers).toEqual({});
  });
});
