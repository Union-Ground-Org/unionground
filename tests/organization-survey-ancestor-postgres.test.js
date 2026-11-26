// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readMigrationFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { offlinePostgres, postgresBin } from "./tamarack-postgres-helper.mjs";

const directory = fileURLToPath(new URL("../supabase/migrations", import.meta.url));
const definitions = readMigrationFunctions(directory);
function definition(name, arity) {
  const entry = definitions.find((fn) => fn.name === name && fn.arity === arity);
  if (!entry) throw new Error(`Missing ${name}/${arity}`);
  const tail = readFileSync(join(directory, entry.file), "utf8").slice(entry.offset);
  const opening = /\bas\s+(\$[\w]*\$)/i.exec(tail);
  const end = tail.indexOf(opening[1], opening.index + opening[0].length) + opening[1].length;
  return { file: entry.file, sql: tail.slice(0, end).replace(/^(\s*create)\s+function/i, "$1 or replace function") + ";" };
}
const current = definition("private.mi1_w2_upsert_survey_session", 3);
const organization = "10000000-0000-4000-8000-000000000001";
const otherOrganization = "10000000-0000-4000-8000-000000000002";
const survey = "20000000-0000-4000-8000-000000000001";
const user = "30000000-0000-4000-8000-000000000001";
const methods = ["save", "submit"];

// Real question constraints, authoring and public save/submit RPCs on an owned
// offline PostgreSQL. Unrelated identity/lock/audit helpers are controlled
// doubles; the refusal cases verify these entry checks, not end-to-end RLS.
describe.skipIf(!postgresBin)("survey ancestor visibility on offline PostgreSQL", () => {
  let db;
  beforeAll(async () => {
    db = await offlinePostgres({ durable: false });
    await db.client.query(`
      create schema auth; create schema private; create schema extensions;
      create role anon; create role authenticated; create role service_role;
      create function extensions.gen_random_uuid() returns uuid language sql
        as $$ select pg_catalog.gen_random_uuid() $$;
      create table auth.users(id uuid primary key);
      create table public.organizations(id uuid primary key);
      create table public.chapters(id text primary key);
      create function auth.uid() returns uuid language sql stable
        as $$ select current_setting('test.user')::uuid $$;
      create function private.lock_case_graph(uuid[],uuid[]) returns void language sql as $$ select $$;
      create function private.mi1_w2_write_audit(uuid,text,jsonb) returns void language sql as $$ select $$;
      create function private.mfa_satisfied() returns boolean language sql stable
        as $$ select current_setting('test.mfa')::boolean $$;
      create function private.is_organization_member(uuid) returns boolean language sql stable
        as $$ select current_setting('test.member')::boolean $$;
      create function private.mi1_w2_selected_organization() returns uuid language sql stable
        as $$ select current_setting('test.organization')::uuid $$;
      create function private.current_member_chapter() returns text language sql stable
        as $$ select current_setting('test.chapter') $$;
      grant usage on schema auth to authenticated;
    `);
    const base = readFileSync(join(directory, "20260826151000_mi1_w2_feature_persistence.sql"), "utf8");
    await db.client.query(base.slice(base.indexOf("create table public.organization_surveys ("), base.indexOf("create table public.case_deadline_changes (")));
    const voice = readFileSync(join(directory, "20260828220000_mi1_voice_survey_completion.sql"), "utf8");
    await db.client.query(voice.slice(voice.indexOf("alter table public.organization_survey_questions"), voice.indexOf("create or replace function private.mi1_w2_replace_survey_questions")));
    await db.client.query(`
      alter table public.organization_surveys add column opens_at timestamptz, add column closes_at timestamptz;
      insert into public.organizations values ('${organization}'), ('${otherOrganization}');
      insert into public.chapters values ('chapter-a'), ('chapter-b');
      insert into auth.users values ('${user}');
    `);
    await db.client.query(definition("private.mi1_w2_replace_survey_questions", 3).sql);
    // Both the existing write-window migration and its successor replace only
    // this helper. Apply the whole active migration, including its ACLs.
    await db.client.query(readFileSync(join(directory, current.file), "utf8"));
    for (const method of methods) {
      await db.client.query(definition(`public.${method}_organization_survey_session`, 2).sql);
      await db.client.query(`revoke all on function public.${method}_organization_survey_session(uuid,jsonb) from public;
        grant execute on function public.${method}_organization_survey_session(uuid,jsonb) to authenticated;`);
    }
  }, 120_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await db.client.query(`truncate public.organization_survey_answers, public.organization_survey_sessions,
      public.organization_survey_questions, public.organization_surveys cascade`);
    await db.client.query(`select set_config('test.user',$1,false), set_config('test.organization',$2,false),
      set_config('test.chapter','chapter-a',false), set_config('test.mfa','true',false), set_config('test.member','true',false)`, [user, organization]);
    await db.client.query(`insert into public.organization_surveys(id,organization_id,title,status)
      values ($1,$2,'Nested branch regression','open')`, [survey, organization]);
  });

  async function tree(parentType = "yes_no") {
    const questions = [
      { clientKey: "root", type: "yes_no", label: "Show follow-up?", required: true },
      { clientKey: "parent", type: parentType, label: "Show detail?", branchParentKey: "root", branchValue: "yes",
        ...(parentType === "checkbox" ? { options: ["detail", "other"] } : {}) },
      { clientKey: "detail", type: "text", label: "Required detail", required: true,
        branchParentKey: "parent", branchValue: parentType === "checkbox" ? "detail" : "yes" },
    ];
    await db.client.query("select private.mi1_w2_replace_survey_questions($1,$2,$3)", [organization, survey, JSON.stringify(questions)]);
    const rows = (await db.client.query("select client_key,id from public.organization_survey_questions order by sort_index")).rows;
    const ids = Object.fromEntries(rows.map((row) => [row.client_key, row.id]));
    return { ids, matched: parentType === "checkbox" ? ["detail"] : "yes" };
  }
  async function rpc(method, answers) {
    await db.client.query("set role authenticated");
    try {
      return (await db.client.query(`select public.${method}_organization_survey_session($1,$2) result`, [survey, JSON.stringify(answers)])).rows[0].result;
    } finally { await db.client.query("reset role"); }
  }
  async function answers() {
    return (await db.client.query(`select q.client_key, a.value from public.organization_survey_answers a
      join public.organization_survey_questions q on q.id=a.question_id order by q.sort_index`)).rows;
  }

  describe.each(["yes_no", "checkbox"])("%s branch parent", (parentType) => {
    it.each(methods)("%s deletes stale answers for all hidden descendants", async (method) => {
      const { ids, matched } = await tree(parentType);
      await rpc("save", { [ids.root]: "yes", [ids.parent]: matched, [ids.detail]: "PREVIOUS" });
      const result = await rpc(method, { [ids.root]: "no", [ids.parent]: matched, [ids.detail]: "HIDDEN-SENTINEL" });
      expect(result.status).toBe(method === "submit" ? "submitted" : "in_progress");
      expect(await answers()).toEqual([{ client_key: "root", value: "no" }]);
    });

    it("does not require an omitted descendant hidden by an ancestor", async () => {
      const { ids, matched } = await tree(parentType);
      expect((await rpc("submit", { [ids.root]: "no", [ids.parent]: matched })).status).toBe("submitted");
      expect(await answers()).toEqual([{ client_key: "root", value: "no" }]);
    });

    it("retains the full visible branch when answered", async () => {
      const { ids, matched } = await tree(parentType);
      expect((await rpc("submit", { [ids.root]: "yes", [ids.parent]: matched, [ids.detail]: "VISIBLE-CONTROL" })).status).toBe("submitted");
      expect(await answers()).toEqual([
        { client_key: "root", value: "yes" }, { client_key: "parent", value: matched },
        { client_key: "detail", value: "VISIBLE-CONTROL" },
      ]);
    });

    it("still requires a visible descendant and rolls a rejected submit back", async () => {
      const { ids, matched } = await tree(parentType);
      await rpc("save", { [ids.root]: "yes", [ids.parent]: matched, [ids.detail]: "DRAFT" });
      const saved = await answers();
      await expect(rpc("submit", { [ids.root]: "yes", [ids.parent]: matched })).rejects.toMatchObject({ code: "22023" });
      expect(await answers()).toEqual(saved);
      expect((await db.client.query("select status from public.organization_survey_sessions")).rows).toEqual([{ status: "in_progress" }]);
    });
  });

  it.each(methods)("%s accepts already-pruned input", async (method) => {
    const { ids } = await tree();
    await rpc(method, { [ids.root]: "no" });
    expect(await answers()).toEqual([{ client_key: "root", value: "no" }]);
  });

  it.each(methods)("%s never validates an invalid answer inside a hidden branch", async (method) => {
    const { ids } = await tree();
    await rpc(method, { [ids.root]: "no", [ids.parent]: "yes", [ids.detail]: { invalid: true } });
    expect(await answers()).toEqual([{ client_key: "root", value: "no" }]);
  });

  it.each([
    ["MFA", "select set_config('test.mfa','false',false)", "42501"],
    ["membership", "select set_config('test.member','false',false)", "42501"],
    ["tenant", `select set_config('test.organization','${otherOrganization}',false)`, "P0002"],
    ["chapter", "update public.organization_surveys set chapter_id='chapter-b'", "P0002"],
    ["opening time", "update public.organization_surveys set opens_at=now()+interval '1 hour'", "P0002"],
    ["closing time", "update public.organization_surveys set closes_at=now()-interval '1 hour'", "P0002"],
  ])("preserves the %s refusal before creating any session or answer", async (_label, configure, code) => {
    const { ids } = await tree();
    await db.client.query(configure);
    for (const method of methods) await expect(rpc(method, { [ids.root]: "no" })).rejects.toMatchObject({ code });
    expect((await db.client.query("select count(*)::int total from public.organization_survey_sessions")).rows[0].total).toBe(0);
    expect(await answers()).toEqual([]);
  });

  it.each(methods)("%s refuses changes to an already submitted session", async (method) => {
    const { ids } = await tree();
    await rpc("submit", { [ids.root]: "no" });
    await expect(rpc(method, { [ids.root]: "yes" })).rejects.toMatchObject({ code: "P0001" });
    expect(await answers()).toEqual([{ client_key: "root", value: "no" }]);
  });

  it("keeps the installed helper private, security-definer and on an empty search_path", async () => {
    const { rows: [row] } = await db.client.query(`select p.prosecdef, p.proconfig,
      array(select role from unnest(array['anon','authenticated','service_role']) role
        where has_function_privilege(role,p.oid,'EXECUTE')) grantees,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where a.grantee=0 and a.privilege_type='EXECUTE') public_execute
      from pg_proc p where p.oid='private.mi1_w2_upsert_survey_session(uuid,jsonb,boolean)'::regprocedure`);
    expect(row.prosecdef).toBe(true);
    expect(row.proconfig).toEqual(['search_path=""']);
    expect(row.grantees).toEqual([]);
    expect(row.public_execute).toBe(false);
  });
});
