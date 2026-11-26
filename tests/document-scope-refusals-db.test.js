// @vitest-environment node
// #9277: another unit/committee's document is indistinguishable from missing.
import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("chapter document scope refusals (#9277)", () => {
  let db;
  const org = uuid(), steward = uuid(), admin = uuid();
  const chapter = "c300-document-refusal";
  const units = [uuid(), uuid()], committees = [uuid(), uuid()];
  const sessions = new Map([[steward, uuid()], [admin, uuid()]]);
  const q = async (sql, args = []) => (await db.query(sql, args)).rows;
  const one = async (sql, args = []) => (await q(sql, args))[0];
  const documentState = () => q("select to_jsonb(d) as row from public.chapter_documents d where chapter_id=$1 order by id", [chapter]);
  async function document(scope, id = uuid()) {
    await q("set local session_replication_role=replica");
    try {
      return await one(`insert into public.chapter_documents(id,chapter_id,title,document_type,body,summary,visibility,status,created_by,access_unit_id,access_committee_id)
        values($1,$2,'Fictional document','other','Fictional contents','','chapter','draft',$3,$4,$5) returning *`, [id, chapter, admin, scope.unit ?? null, scope.committee ?? null]);
    } finally { await q("set local session_replication_role=origin"); }
  }
  async function act(actor, id) {
    await q("savepoint document_call");
    try {
      await q("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor, role: "authenticated", aal: "aal2", session_id: sessions.get(actor) })]);
      await q("set local role authenticated");
      const value = (await one("select public.update_chapter_document_content($1,'Fictional revised document','other','','Fictional revision','chapter','save') as value", [id])).value;
      await q("reset role");
      const persisted = await one("select title,body from public.chapter_documents where id=$1", [id]);
      assert.deepEqual(persisted, { title: "Fictional revised document", body: "Fictional revision" });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, code: error.code, message: error.message, detail: error.detail ?? null, hint: error.hint ?? null };
    } finally { await q("rollback to savepoint document_call"); }
  }
  function success(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; }
  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false,
      application_name: "c300-document-scope-refusals" });
    await db.connect(); await q("begin"); await q("set local statement_timeout='30s'");
    await q("insert into public.organizations(id,slug,name) values($1,'c300-document-refusal','Fictional document organization')", [org]);
    await q("insert into public.chapters(id,slug,name,organization_id,order_index) values($1,$1,'Fictional document chapter',$2,9961)", [chapter, org]);
    for (const [index, unit] of units.entries()) await q("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$2,$3,$4)", [unit, org, chapter, `Fictional unit ${index + 1}`]);
    for (const [index, committee] of committees.entries()) await q("insert into private.chapter_committees(id,chapter_id,name,purpose,starts_on) values($1,$2,$3,'Fictional document review',date '2020-01-01')", [committee, chapter, `Fictional committee ${index + 1}`]);
    for (const actor of [steward, admin]) {
      await q("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [actor, `${actor}@example.invalid`]);
      await q("update public.member_profiles set chapter_id=$2 where id=$1", [actor, chapter]);
      await q("insert into public.organization_memberships(user_id,organization_id,status) values($1,$2,'active') on conflict do nothing", [actor, org]);
      await q("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned) values($1,$2,'active',true) on conflict do nothing", [actor, chapter]);
      const role = actor === steward ? "steward" : "admin";
      await q("insert into public.member_roles(user_id,chapter_id,role) values($1,$2,$3)", [actor, chapter, role]);
      await q("insert into public.member_role_chapters(user_id,chapter_id,role) values($1,$2,$3)", [actor, chapter, role]);
      await q("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [sessions.get(actor), actor]);
      await q("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [uuid(), actor]);
    }
    await q("insert into public.organization_role_grants(user_id,organization_id,role) values($1,$2,'admin')", [admin, org]);
    await q("insert into private.chapter_unit_members(unit_id,chapter_id,user_id) values($1,$2,$3)", [units[0], chapter, steward]);
    await q("insert into private.chapter_role_scopes(user_id,chapter_id,role,unit_id) values($1,$2,'steward',$3)", [steward, chapter, units[0]]);
    await q("insert into private.chapter_committee_members(committee_id,chapter_id,user_id) values($1,$2,$3)", [committees[0], chapter, steward]);
  }, 60_000);
  afterAll(async () => { await db?.query("rollback"); await db?.end(); });

  for (const kind of ["unit", "committee"]) it(`keeps an authorized ${kind}-one update and matches ${kind}-two with missing, without writes`, async () => {
    await q("savepoint document_scenario");
    try {
      const scopes = kind === "unit" ? units.map(unit => ({ unit })) : committees.map(committee => ({ committee }));
      const own = await document(scopes[0]); const foreign = await document(scopes[1]);
      assert.equal(success(await act(steward, own.id)).id, own.id);
      assert.equal(success(await act(admin, foreign.id)).id, foreign.id, "organization administration remains authorized");
      // Being in the document's own container does not confer a publishing role.
      await q("savepoint own_document_without_role");
      await q("delete from public.member_role_chapters where user_id=$1", [steward]);
      await q("delete from public.member_roles where user_id=$1", [steward]);
      const ownBefore = await documentState();
      assert.deepEqual(await act(steward, own.id), { ok: false, code: "42501", message: "document outside access scope", detail: null, hint: null });
      assert.deepEqual(await documentState(), ownBefore, "own-container role refusal changed a document");
      await q("rollback to savepoint own_document_without_role");
      const before = await documentState();
      const present = await act(steward, foreign.id);
      assert.deepEqual(await documentState(), before, "out-of-scope request changed a document");
      await q("savepoint missing_document");
      await q("set local session_replication_role=replica");
      await q("delete from public.chapter_documents where id=$1", [foreign.id]);
      await q("set local session_replication_role=origin");
      const beforeMissing = await documentState();
      const missing = await act(steward, foreign.id);
      assert.deepEqual(await documentState(), beforeMissing, "missing request changed a document");
      await q("rollback to savepoint missing_document");
      assert.deepEqual(missing, { ok: false, code: "22023", message: "document unavailable", detail: null, hint: null });
      assert.deepEqual(present, missing, `${kind}-two document differs from missing`);
    } finally { await q("rollback to savepoint document_scenario"); }
  });
});
