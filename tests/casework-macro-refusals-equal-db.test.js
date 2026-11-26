// @vitest-environment node
// C289: refused macro operations must reveal neither a chapter nor a macro.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.RUN_CASEWORK_MACRO_AUDIENCE_DB_TESTS === "1" && process.env.SUPABASE_DB_URL ? describe : describe.skip;
const ROLES = ["member", "steward", "advisor", "coordinator", "admin", "vp", "chapterOnly"];
const SAVE = "select public.casework_save_macro($1,$2,'Fictional macro',$3::jsonb,$4) value";
const APPLY = "select public.casework_apply_macro($1,$2::uuid[],$3) value";
const ACTIONS = JSON.stringify([{ kind: "set_status", status: "resolved" }]);
const AUTHORSHIP = { ok: false, code: "42501", message: "macro authorship requires the scope write role and the staff role that reads the macro", hint: "casework_macro_audience", detail: null };
const MISSING = { ok: false, code: "P0002", message: "macro not found", hint: null, detail: null };

live("casework macro refusals hide inaccessible scopes", () => {
  let db;
  const f = { org: randomUUID(), foreignOrg: randomUUID(), people: {}, macros: {} };
  const owner = async () => {
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claims','',true)");
  };
  const as = async (name) => {
    await owner();
    const person = f.people[name];
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: person.id, session_id: person.session, role: "authenticated", aal: "aal2" })]);
    await db.query("set local role authenticated");
  };
  const attempt = async (sql, args) => {
    await db.query("savepoint macro_refusal");
    try {
      return { ok: true, value: (await db.query(sql, args)).rows[0].value };
    } catch (error) {
      return { ok: false, code: error.code, message: error.message, hint: error.hint ?? null, detail: error.detail ?? null };
    } finally {
      await db.query("rollback to savepoint macro_refusal");
      await db.query("release savepoint macro_refusal");
    }
  };
  const save = (id, chapter, active = true) => attempt(
    id === null ? SAVE.replace("'Fictional macro'", "'Fictional new macro'") : SAVE,
    [id, chapter, ACTIONS, active],
  );
  const apply = (id) => attempt(APPLY, [id, [f.caseId], randomUUID()]);

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "casework-macro-refusals-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    f.chapter = `macro-refusal-${f.org}`;
    f.sibling = `macro-refusal-sibling-${f.org}`;
    f.foreign = `macro-refusal-${f.foreignOrg}`;
    f.missingChapter = `macro-refusal-missing-${randomUUID()}`;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Harbor Fictional Organization'),($2::uuid,$2::text,'Ridge Fictional Organization')", [f.org, f.foreignOrg]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$2,9980),($3,$3,$3,$2,9981),($4,$4,$4,$5,9982)", [f.chapter, f.org, f.sibling, f.foreign, f.foreignOrg]);
    for (const name of [...ROLES, "foreignAdmin"]) {
      const id = randomUUID();
      const session = randomUUID();
      f.people[name] = { id, session };
      const org = name === "foreignAdmin" ? f.foreignOrg : f.org;
      const chapter = name === "foreignAdmin" ? f.foreign : f.chapter;
      const role = name === "foreignAdmin" ? "admin" : name === "chapterOnly" ? "coordinator" : name;
      await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${id}@example.invalid`]);
      await db.query("update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1", [id, chapter, `Fictional ${name}`]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, id]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, chapter]);
      if (role !== "member") {
        await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [id, role, chapter]);
        await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [id, role, chapter]);
        if (name !== "chapterOnly") await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,$3)", [org, id, role]);
      }
    }
    // The admin has rights to both chapters; other actors have only the home
    // chapter. This distinguishes a legitimate scope-change refusal from a
    // refusal that would expose an inaccessible macro.
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [f.people.admin.id, f.sibling]);
    const create = async (side, actor, chapter) => {
      await as(actor);
      f.macros[side] = (await db.query(SAVE, [null, chapter, ACTIONS, true])).rows[0].value.id;
    };
    await create("home", "admin", f.chapter);
    await create("organization", "admin", null);
    await create("sibling", "admin", f.sibling);
    await create("foreign", "foreignAdmin", f.foreign);
    await owner();
    f.caseId = randomUUID();
    await db.query("insert into public.member_cases(id,user_id,reference,title,case_type,status) values($1::uuid,$2,$1::text,'Fictional macro case','other','active')", [f.caseId, f.people.member.id]);
  });

  afterAll(async () => {
    if (db) {
      await db.query("rollback");
      await db.end();
    }
  });

  it.each(ROLES)("save: %s cannot distinguish a foreign chapter from a missing chapter", async (name) => {
    await as(name);
    for (const macroId of [null, f.macros.foreign, randomUUID()]) {
      const missing = await save(macroId, f.missingChapter);
      expect(await save(macroId, f.foreign)).toEqual(missing);
      expect(missing).toEqual(AUTHORSHIP);
    }
  });

  it.each(ROLES.filter((name) => name !== "admin"))("save: %s cannot distinguish another chapter without its grant from a missing chapter", async (name) => {
    await as(name);
    expect(await save(null, f.sibling)).toEqual(await save(null, f.missingChapter));
    expect(await save(null, f.sibling)).toEqual(AUTHORSHIP);
  });

  it.each(["member", "steward", "advisor", "chapterOnly"])("save: %s keeps the authorship refusal on its own chapter and organization", async (name) => {
    await as(name);
    expect(await save(null, f.chapter)).toEqual(AUTHORSHIP);
    expect(await save(null, null)).toEqual(AUTHORSHIP);
  });

  it.each(["coordinator", "admin", "vp"])("save: %s cannot distinguish a foreign macro from a missing macro in an authorized target scope", async (name) => {
    await as(name);
    const missing = await save(randomUUID(), f.chapter);
    expect(missing).toEqual(MISSING);
    expect(await save(f.macros.foreign, f.chapter)).toEqual(missing);
  });

  it.each(ROLES)("apply: %s cannot distinguish an active foreign macro from a missing macro", async (name) => {
    await as(name);
    const missing = await apply(randomUUID());
    expect(missing).toEqual(MISSING);
    expect(await apply(f.macros.foreign)).toEqual(missing);
  });

  it("apply: coordinator cannot distinguish an unreadable sibling-chapter macro from a missing macro", async () => {
    await as("coordinator");
    const listed = (await db.query("select public.casework_list_macros() value")).rows[0].value;
    expect(listed.some((macro) => macro.id === f.macros.sibling)).toBe(false);
    const missing = await apply(randomUUID());
    expect(missing).toEqual(MISSING);
    expect(await apply(f.macros.sibling)).toEqual(missing);
  });

  it("save: coordinator cannot distinguish an unreadable sibling source macro from a missing macro", async () => {
    await as("coordinator");
    for (const active of [true, false]) {
      const missing = await save(randomUUID(), f.chapter, active);
      expect(missing).toEqual(MISSING);
      expect(await save(f.macros.sibling, f.chapter, active)).toEqual(missing);
    }
  });

  it.each(["coordinator", "admin", "vp"])("apply: %s still applies a readable organization-wide macro", async (name) => {
    await as(name);
    expect(await apply(f.macros.organization)).toMatchObject({
      ok: true, value: { macroId: f.macros.organization, actionsApplied: 1, actionsSkipped: 0 },
    });
  });

  it("apply: admin keeps the scope refusal for a readable sibling macro and home case", async () => {
    await as("admin");
    const listed = (await db.query("select public.casework_list_macros() value")).rows[0].value;
    expect(listed.some((macro) => macro.id === f.macros.sibling)).toBe(true);
    expect(await apply(f.macros.sibling)).toEqual({
      ok: false, code: "42501", message: "macro is scoped to another chapter", hint: null, detail: null,
    });
  });

  it.each(["member", "steward", "advisor", "chapterOnly"])("apply: %s cannot use a local macro without the application role", async (name) => {
    await as(name);
    expect(await apply(f.macros.home)).toEqual(await apply(randomUUID()));
    expect(await apply(f.macros.home)).toEqual(MISSING);
  });

  it("does no foreign macro before-image work while refusing an update", async () => {
    await owner();
    await db.query("savepoint macro_work_guard");
    try {
      // A trap at the private content boundary makes an extra before-image
      // read observable without relying on noisy wall-clock measurements.
      await db.query("create or replace function private.learning_casework_macro_state(p_macro_id uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$ begin raise exception 'foreign macro content was read'; end; $$");
      await as("admin");
      expect(await save(f.macros.foreign, f.chapter)).toEqual(MISSING);
      expect(await save(randomUUID(), f.chapter)).toEqual(MISSING);
    } finally {
      await owner();
      await db.query("rollback to savepoint macro_work_guard");
      await db.query("release savepoint macro_work_guard");
    }
  });

  it.each(["coordinator", "admin", "vp"])("%s still creates, updates, deactivates, lists and applies an authorized chapter macro", async (name) => {
    await as(name);
    expect(await save(null, f.chapter)).toMatchObject({ ok: true });
    expect(await save(f.macros.home, f.chapter)).toMatchObject({ ok: true });
    const deactivated = await save(f.macros.home, f.chapter, false);
    expect(deactivated.ok).toBe(true);
    expect(deactivated.value.active).toBe(false);
    const listed = (await db.query("select public.casework_list_macros() value")).rows[0].value;
    expect(listed.some((macro) => macro.id === f.macros.home)).toBe(true);
    const applied = await apply(f.macros.home);
    expect(applied.ok, JSON.stringify(applied)).toBe(true);
    expect(applied.value.actionsApplied).toBe(1);
  });

  it("keeps an authorized scope-change refusal and missing/invalid answers", async () => {
    await as("admin");
    expect(await save(f.macros.sibling, f.chapter)).toEqual({ ok: false, code: "42501", message: "macro scope cannot change", hint: null, detail: null });
    expect(await save(randomUUID(), f.chapter)).toEqual(MISSING);
    expect(await save(null, null)).toMatchObject({ ok: true });
    expect(await attempt(SAVE.replace("'Fictional macro'", "'x'"), [null, f.chapter, ACTIONS, true])).toEqual({ ok: false, code: "22023", message: "macro name must be 2-120 characters", hint: null, detail: null });
  });

  it("keeps both definer search paths and the exact client execute boundary", async () => {
    await owner();
    for (const signature of ["public.casework_save_macro(uuid,text,text,jsonb,boolean)", "public.casework_apply_macro(uuid,uuid[],uuid)"]) {
      const row = (await db.query(`select prosecdef, proconfig,
        has_function_privilege('anon', oid, 'execute') anon,
        has_function_privilege('authenticated', oid, 'execute') authenticated,
        has_function_privilege('service_role', oid, 'execute') service_role
        from pg_catalog.pg_proc where oid=$1::regprocedure`, [signature])).rows[0];
      expect(row).toEqual({ prosecdef: true, proconfig: ['search_path=""'], anon: false, authenticated: true, service_role: false });
    }
  });
});
