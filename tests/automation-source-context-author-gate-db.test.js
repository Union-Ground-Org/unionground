// @vitest-environment node
//
// UX-UG-AUTOMATE-THIS-WORKFLOW-IS-RENDERED-FOR-STEWARDS-COORDINATORS-ADVISORS-BUT-THE-SOURCE-20260921
//
// 'Automate this workflow' is rendered for stewards/coordinators/advisors, but
// public.mi1_get_automation_source_context (20260910045839:1329-1339) entered
// through private.cr108_require_operator() — the admin/vp operator gate
// (20260829023000:233). The deep link from a steward's own chapter board
// therefore refused the source context (42501) and ConnectedAutomationPages
// rendered an empty Recipes tab.
//
// 20260924230100 re-emits the read through
// private.automation_v3_require_author() (20260911070000:141) and
// private.automation_v3_source_visible() (:179). The chapter lookup union and
// the 'chapter is null' refusal stay byte-identical: a steward still gets 42501
// for a task outside their chapters, and an admin's behaviour is unchanged.
//
// The offline half pins the migration text and the db-contract re-pin. The
// live half (disposable loopback only) proves a chapter-scoped steward reads
// their own-chapter task context, gets 42501 for the sibling chapter's task,
// and that an admin still reads both.
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("automation_source_context_author_gate"));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const flat = squash(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const definition = squash(stripComments(fnBody(sql, "public.mi1_get_automation_source_context")));

describe("automation source context author-gate migration", () => {
  it("sorts after the v3 helpers and the v2 function it replaces, inside one bounded transaction", () => {
    const name = findMigrationName("automation_source_context_author_gate");
    expect(name).toBe("20260924230100_automation_source_context_author_gate.sql");
    expect(name > "20260911070000_automation_shared_intelligence_v3.sql").toBe(true);
    expect(name > "20260910045839_connected_automation_v2.sql").toBe(true);
    const statements = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    expect(statements.trimStart().startsWith("begin;")).toBe(true);
    expect(statements.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("set local lock_timeout = '5s';");
  });

  it("enters through the author gate and the v3 source-visibility predicate, never the operator gate", () => {
    expect(definition).toContain("declare org uuid:=private.automation_v3_require_author(); chapter text;");
    expect(definition).toContain("if not private.automation_v3_source_visible(auth.uid(),org,p_source,p_source_id) then raise exception 'source unavailable' using errcode='42501'; end if;");
    expect(definition).not.toContain("cr108_require_operator");
    expect(definition).not.toContain("automation_v2_source_visible");
  });

  it("keeps the chapter lookup union and the chapter-is-null refusal byte-identical", () => {
    const union = definition.slice(definition.indexOf("select s.chapter_id into chapter from ("), definition.indexOf("if chapter is null"));
    expect(union).toContain("select id::text id,chapter_id,'task'::text kind from public.chapter_tasks");
    expect(union).toContain("union all select id::text,chapter_id,'case' from public.member_cases");
    expect(union).toContain("union all select id::text,chapter_id,'appointment' from public.member_appointments");
    expect(union).toContain("union all select id,chapter_id,'event' from public.member_events) s where s.id=p_source_id and s.kind=p_source;");
    expect(definition).toContain("if chapter is null then raise exception 'source unavailable' using errcode='42501'; end if;");
    expect(definition).toContain("return jsonb_build_object('organizationId',org,'sourceKind',p_source,'sourceId',p_source_id,'chapterId',chapter); end;");
    const header = definition.slice(0, definition.indexOf("as $$"));
    expect(header).toContain("language plpgsql stable security definer set search_path = ''");
  });

  it("keeps the authenticated-only ACL explicit", () => {
    expect(flat).toContain("revoke all on function public.mi1_get_automation_source_context(text,text) from public,anon,authenticated,service_role;");
    expect(flat).toContain("grant execute on function public.mi1_get_automation_source_context(text,text) to authenticated;");
  });

  it("re-pins the author gate in the database contract so an operator-gate regression fails verify:db", () => {
    const entry = contract.functions.find((row) => row.sig === "public.mi1_get_automation_source_context(p_source text, p_source_id text)");
    expect(entry).toMatchObject({ secdef: true, exec: "authenticated" });
    expect(entry.bodyContains).toEqual(expect.arrayContaining([
      "private.automation_v3_require_author()",
      "private.automation_v3_source_visible(auth.uid(),org,p_source,p_source_id)",
      "raise exception 'source unavailable' using errcode='42501'",
    ]));
    expect(entry.bodyForbids).toEqual(expect.arrayContaining(["cr108_require_operator"]));
    const migration = readFileSync(new URL("../supabase/migrations/20260924230100_automation_source_context_author_gate.sql", import.meta.url), "utf8");
    const start = migration.indexOf("create or replace function public.mi1_get_automation_source_context");
    const bodyStart = migration.indexOf("$$", migration.indexOf("as ", start)) + 2;
    const bodyEnd = migration.indexOf("end; $$;", bodyStart) + "end; ".length;
    const bodyMd5 = createHash("md5").update(migration.slice(bodyStart, bodyEnd), "utf8").digest("hex");
    expect(entry.sourceMd5).toBe(bodyMd5);
    expect(entry.sourceMd5).toMatch(/^[0-9a-f]{32}$/);
    expect(entry.sourceMd5).not.toBe("bab1bda4008966595740d7d45085566f");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("automation source context answers stewards for own-chapter sources only", () => {
  let client;
  const id = Object.fromEntries([
    "ownerA", "ownerB", "steward", "admin",
    "ownerASession", "ownerBSession", "stewardSession", "adminSession",
    "org", "taskA", "taskB",
  ].map((key) => [key, randomUUID()]));
  const chapterA = `asrc-a-${id.org}`;
  const chapterB = `asrc-b-${id.org}`;

  const act = async (actor, session) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
  };

  const sourceContext = async (kind, sourceId) => {
    await client.query("savepoint source_context");
    try {
      const result = await client.query("select public.mi1_get_automation_source_context($1,$2) as context", [kind, sourceId]);
      await client.query("release savepoint source_context");
      return { ok: true, context: result.rows[0].context };
    } catch (error) {
      await client.query("rollback to savepoint source_context");
      return { ok: false, code: error.code, message: error.message };
    }
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "automation-source-context-author-gate-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    const people = [
      [id.ownerA, id.ownerASession, chapterA],
      [id.ownerB, id.ownerBSession, chapterB],
      [id.steward, id.stewardSession, chapterA],
      [id.admin, id.adminSession, chapterA],
    ];
    for (const [user, session] of people) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic source-context factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [id.org, `asrc-${id.org}`, id.ownerA]);
    for (const [chapter, order] of [[chapterA, 9921], [chapterB, 9922]]) {
      await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,$3)", [chapter, id.org, order]);
      await client.query("insert into public.chapter_workstreams(chapter_id,name,created_by) values($1,'General',$2)", [chapter, id.ownerA]);
    }
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [id.org]);
    for (const [user, , chapter] of people) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, user]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
      await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
    }
    await client.query(
      "insert into public.member_roles(user_id,role,granted_by,chapter_id) values($1,'steward',$2,$3)",
      [id.steward, id.ownerA, chapterA],
    );
    await client.query(
      "insert into public.member_role_chapters(user_id,role,chapter_id,granted_by) values($1,'steward',$2,$3)",
      [id.steward, chapterA, id.ownerA],
    );
    await client.query(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)",
      [id.org, id.admin],
    );
    // chapter_tasks BEFORE INSERT stamps the caller's own chapter
    // (private.prepare_chapter_task), so each task is seeded under its
    // owner's session claims: taskA lands in chapter A, taskB in chapter B.
    const seedTask = async (actor, session, taskId, title) => {
      await client.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal: "aal2" }),
      ]);
      await client.query("insert into public.chapter_tasks(id,chapter_id,title,created_by,updated_by,workstream) values($1,$2,$3,$4,$4,'General')", [taskId, actor === id.ownerA ? chapterA : chapterB, title, actor]);
    };
    await seedTask(id.ownerA, id.ownerASession, id.taskA, "Synthetic own-chapter task");
    await seedTask(id.ownerB, id.ownerBSession, id.taskB, "Synthetic sibling-chapter task");
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("answers a chapter-scoped steward for a task on their own chapter", async () => {
    await act(id.steward, id.stewardSession);
    const result = await sourceContext("task", id.taskA);
    expect(result.ok).toBe(true);
    expect(result.context).toMatchObject({
      organizationId: id.org,
      sourceKind: "task",
      sourceId: id.taskA,
      chapterId: chapterA,
    });
  });

  it("raises 42501 for a steward following a task outside their chapters", async () => {
    await act(id.steward, id.stewardSession);
    const result = await sourceContext("task", id.taskB);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("42501");
  });

  it("raises 42501 for a steward probing a source that does not exist", async () => {
    await act(id.steward, id.stewardSession);
    const result = await sourceContext("task", randomUUID());
    expect(result.ok).toBe(false);
    expect(result.code).toBe("42501");
  });

  it("keeps an admin's existing read across both chapters", async () => {
    await act(id.admin, id.adminSession);
    const own = await sourceContext("task", id.taskA);
    expect(own.ok).toBe(true);
    expect(own.context.chapterId).toBe(chapterA);
    const sibling = await sourceContext("task", id.taskB);
    expect(sibling.ok).toBe(true);
    expect(sibling.context.chapterId).toBe(chapterB);
  });
});
