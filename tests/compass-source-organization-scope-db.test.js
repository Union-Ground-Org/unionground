// @vitest-environment node
//
// SEC-UG-COMPASS-SOURCE-ORGANIZATION-SCOPE-20261012 (P14-1). The Compass
// context envelope and briefing persistence keep a source in the organization
// it belongs to: a member of A and B with B selected cannot brief their own A
// conversation or draft from an active A campaign under B's label, and cannot
// save an A-derived briefing as a B row. A-selected controls still work.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readMigrationFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";

const MIGRATION = "20261013040000_compass_source_organization_scope.sql";
const CONFLICT_MIGRATION = "20261106220000_conflict_refusals_not_retried.sql";
const migration = readFileSync(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), "utf8");

describe("source organization scope migration (static)", () => {
  const latest = new Map(readMigrationFunctions("supabase/migrations").map((fn) => [fn.name, fn]));

  it("is the current definition of the context wrapper and briefing persistence", () => {
    // 20261106220000 re-declares the persistence verbatim with its stale
    // refusal on PT409 instead of 40001 (PostgREST 14 retries 40001).
    const persist = latest.get("public.persist_compass_message_briefing");
    expect(persist?.file).toBe(CONFLICT_MIGRATION);
    const original = readMigrationFunctions("supabase/migrations").historical
      .find((fn) => fn.name === "public.persist_compass_message_briefing" && fn.file === MIGRATION);
    expect(persist.source).toBe(original.source.replace("errcode = '40001'", "errcode = 'PT409'"));
    for (const name of ["public.get_compass_ai_context", "private.compass_source_in_organization"]) {
      expect(latest.get(name)?.file, name).toBe(MIGRATION);
    }
  });

  it("checks the source organization before reading or saving, and keeps the existing guards", () => {
    const code = stripComments(migration);
    const context = code.split("create or replace function public.get_compass_ai_context")[1].split("$$;")[0];
    const briefing = context.split("elsif p_kind = 'briefing' then")[1].split("elsif p_kind = 'civic' then")[0];
    expect(briefing.indexOf("private.compass_source_in_organization(")).toBeGreaterThan(-1);
    expect(briefing.indexOf("private.compass_source_in_organization(")).toBeLessThan(briefing.indexOf("public.get_message_briefing_context("));
    expect(context.split("elsif p_kind = 'civic' then")[1]).toContain("and private.compass_source_in_organization('civic', c.id, org);");
    const persist = code.split("create or replace function public.persist_compass_message_briefing")[1].split("$function$;")[0];
    expect(persist).toMatch(/perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n {2}org := private\.engagement_selected_organization\(\);/);
    expect(persist).toContain("or not private.compass_source_in_organization(p_source_kind, p_target_id, org) then");
    for (const guard of ["private.mfa_satisfied()", "private.is_organization_member(org)", "private.engagement_can_read_message_target(p_source_kind, p_target_id)", "private.lock_message_lifecycle()", "->>'sourceRevision'", "'40001'"]) {
      expect(persist).toContain(guard);
    }
    expect(persist.indexOf("compass_source_in_organization")).toBeLessThan(persist.indexOf("insert into public.compass_message_briefings"));
    expect(code).toContain("revoke all on function private.compass_source_in_organization(text, uuid, uuid) from public, anon, authenticated, service_role;");
    expect(code).toContain("grant execute on function private.compass_source_in_organization(text, uuid, uuid) to authenticated;");
    expect(code).not.toMatch(/create trigger|create table|\bdelete from\b|\bupdate public\./i);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("source organization scope on a disposable database", () => {
  let c;
  let w;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "compass-source-scope-proof" });
    await c.connect();
  });
  afterAll(async () => { await c?.end(); });

  async function rpc(sql, values = []) {
    await c.query("savepoint rpc_call");
    try {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: w.member, session_id: w.session, aal: "aal2" })]);
      await c.query("set local role authenticated");
      const value = (await c.query(`select ${sql} as value`, values)).rows[0].value;
      await c.query("reset role");
      await c.query("select set_config('request.jwt.claims', '', true)");
      await c.query("release savepoint rpc_call");
      return value;
    } catch (error) {
      await c.query("rollback to savepoint rpc_call");
      await c.query("release savepoint rpc_call");
      throw error;
    }
  }
  const select = (chapter) => c.query("update public.member_profiles set chapter_id=$2 where id=$1", [w.member, chapter]);
  const setAi = (org, value) => c.query(
    `insert into public.organization_setting_values(organization_id,setting_key,value,updated_by) values ($1,'features.ai_assistant.enabled',$2::jsonb,$3)
     on conflict (organization_id, setting_key) do update set value = excluded.value`, [org, JSON.stringify(value), w.member]);
  const context = (kind, args) => rpc("public.get_compass_ai_context($1,$2)", [kind, JSON.stringify(args)]);
  const briefing = (target) => context("briefing", { p_source_kind: "private", p_target_id: target });
  const civic = () => context("civic", { campaignId: w.campaign, officialKey: "bioguide:F000466" });
  const persist = (target, revision) => rpc("public.persist_compass_message_briefing('private',$1,'Summary of the thread','[]',$2)", [target, revision]);
  const briefingRows = async () => (await c.query(
    "select organization_id, target_id from public.compass_message_briefings where requested_by=$1 order by created_at", [w.member])).rows;

  beforeEach(async () => {
    await c.query("begin");
    w = { member: randomUUID(), other: randomUUID(), session: randomUUID(), conversation: randomUUID(), unscoped: randomUUID(), campaign: randomUUID(), task: randomUUID(), thread: randomUUID() };
    for (const id of [w.member, w.other]) await c.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    for (const label of ["a", "b"]) {
      const org = randomUUID();
      const chapter = `source-scope-${label}-${org.slice(0, 8)}`;
      w[label] = { org, chapter };
      await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org, chapter]);
      await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98274)", [chapter, org]);
      await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org, w.member]);
      await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [w.member, chapter]);
      await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'admin',$2)", [org, w.member]);
    }
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), w.member]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [w.session, w.member]);
    // The member's own conversation, opened in A; and one from before
    // conversations recorded an organization.
    for (const [id, org] of [[w.conversation, w.a.org], [w.unscoped, null]]) {
      await c.query("insert into public.member_conversations(id,user_id,organization_id,title) values ($1,$2,$3,'Source scope proof')", [id, w.member, org]);
      await c.query("insert into public.member_messages(id,conversation_id,user_id,sender_kind,sender_name,body) values ($1,$2,$3,'member','Proof','Organization A grievance detail')", [randomUUID(), id, w.member]);
    }
    await c.query("insert into public.civic_campaigns(id,org_id,title,topic,summary,status) values ($1,$2,'A campaign','A staffing','Organization A campaign text','active')", [w.campaign, w.a.chapter]);
    // Tasks, spaces and threads take the writer's selected chapter, as the
    // product stamps them: write them as the member with A selected.
    await select(w.a.chapter);
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: w.member, session_id: w.session, aal: "aal2" })]);
    await c.query("insert into public.chapter_workstreams(chapter_id,name,created_by) values ($1,'General',$2) on conflict do nothing", [w.a.chapter, w.member]);
    await c.query("insert into public.chapter_tasks(id,chapter_id,title,created_by,updated_by) values ($1,$2,'A task',$3,$3)", [w.task, w.a.chapter, w.member]);
    const space = randomUUID();
    await c.query("insert into public.chapter_spaces(id,name) values ($1,'A space')", [space]);
    await c.query("insert into public.chapter_threads(id,space_id,title) values ($1,$2,'A thread')", [w.thread, space]);
    await c.query("insert into public.chapter_thread_posts(thread_id,body) values ($1,'Organization A channel detail')", [w.thread]);
    await c.query("select set_config('request.jwt.claims', '', true)");
    await c.query("insert into public.chapter_task_messages(task_id,chapter_id,sender_id,recipient_id,body) values ($1,$2,$3,$4,'Organization A task detail')", [w.task, w.a.chapter, w.member, w.other]);
    expect((await c.query("select t.chapter_id from public.chapter_threads t join public.chapter_spaces s on s.id = t.space_id and s.chapter_id = t.chapter_id where t.id=$1", [w.thread])).rows).toEqual([{ chapter_id: w.a.chapter }]);
    await setAi(w.a.org, true);
    await setAi(w.b.org, true);
  });
  afterEach(async () => { await c.query("rollback"); });

  it("refuses an A conversation and drops an A campaign while B is selected, even with A's assistant off", async () => {
    await setAi(w.a.org, false);
    await select(w.b.chapter);
    await expect(briefing(w.conversation)).rejects.toMatchObject({ code: "P0002" });
    const civicContext = await civic();
    expect(civicContext.organization_id).toBe(w.b.org);
    expect(civicContext.data.campaign).toBeNull();
    expect(JSON.stringify(civicContext)).not.toContain("Organization A");
    // A direct RPC with the current revision of the readable A thread still
    // cannot save it under B.
    const revision = (await rpc("public.get_message_briefing_context('private',$1)", [w.conversation])).sourceRevision;
    expect(revision).toMatch(/^[0-9a-f]{64}$/);
    await expect(persist(w.conversation, revision)).rejects.toMatchObject({ code: "P0002" });
    expect(await briefingRows()).toEqual([]);
  });

  it("still briefs, drafts from and saves an A source while A is selected", async () => {
    await select(w.a.chapter);
    const context = await briefing(w.conversation);
    expect(context.organization_id).toBe(w.a.org);
    expect(context.data.messages.map((message) => message.body)).toEqual(["Organization A grievance detail"]);
    const civicContext = await civic();
    expect(civicContext).toMatchObject({ organization_id: w.a.org, data: { campaign: { id: w.campaign, summary: "Organization A campaign text" } } });
    expect(await persist(w.conversation, context.data.sourceRevision)).toMatchObject({ sourceKind: "private", targetId: w.conversation });
    expect(await briefingRows()).toEqual([{ organization_id: w.a.org, target_id: w.conversation }]);
    // The revision check is unchanged.
    await expect(persist(w.conversation, "0".repeat(64))).rejects.toMatchObject({ code: "PT409" });
  });

  it("refuses a conversation that never recorded an organization in either organization", async () => {
    for (const chapter of [w.a.chapter, w.b.chapter]) {
      await select(chapter);
      await expect(briefing(w.unscoped)).rejects.toMatchObject({ code: "P0002" });
      const revision = (await rpc("public.get_message_briefing_context('private',$1)", [w.unscoped])).sourceRevision;
      await expect(persist(w.unscoped, revision)).rejects.toMatchObject({ code: "P0002" });
    }
    expect(await briefingRows()).toEqual([]);
  });

  // Channel and task reads were already bound to the selected chapter, so
  // this was refused before the fix too; the source check now refuses first.
  it("refuses A channel and task sources while B is selected, before reading them", async () => {
    await select(w.b.chapter);
    for (const [kind, target] of [["channel", w.thread], ["task", w.task]]) {
      await expect(context("briefing", { p_source_kind: kind, p_target_id: target })).rejects.toMatchObject({ code: "P0002" });
    }
    // An unknown kind keeps its existing invalid-source refusal.
    await expect(context("briefing", { p_source_kind: "broadcast", p_target_id: w.thread })).rejects.toMatchObject({ code: "22023" });
  });

  it("resolves each source kind to its own organization and never matches unknown scope", async () => {
    const match = async (kind, target, org) => (await c.query("select private.compass_source_in_organization($1,$2,$3) as v", [kind, target, org])).rows[0].v;
    for (const [kind, target] of [["private", w.conversation], ["channel", w.thread], ["task", w.task], ["civic", w.campaign]]) {
      expect(await match(kind, target, w.a.org), kind).toBe(true);
      expect(await match(kind, target, w.b.org), kind).toBe(false);
      expect(await match(kind, target, null), kind).toBe(false);
      expect(await match(kind, randomUUID(), w.a.org), kind).toBe(false);
    }
    expect(await match("private", w.unscoped, w.a.org)).toBe(false);
    expect(await match("broadcast", w.thread, w.a.org)).toBe(false);
  });

  it("grants the helper only to signed-in callers", async () => {
    const grants = (await c.query(`select r.rolname from pg_catalog.pg_roles r
      where r.rolname in ('anon','authenticated','service_role')
        and pg_catalog.has_function_privilege(r.oid, 'private.compass_source_in_organization(text,uuid,uuid)', 'execute') order by 1`)).rows;
    expect(grants).toEqual([{ rolname: "authenticated" }]);
    const fn = (await c.query(`select p.prosecdef, p.proconfig from pg_catalog.pg_proc p
      where p.oid = 'private.compass_source_in_organization(text,uuid,uuid)'::regprocedure`)).rows[0];
    expect(fn).toEqual({ prosecdef: true, proconfig: ['search_path=""'] });
  });
});
