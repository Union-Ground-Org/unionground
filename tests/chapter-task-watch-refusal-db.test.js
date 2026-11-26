// @vitest-environment node
//
// BUG-UG-CHAPTER-TASK-WATCH-REFUSAL-REVEALS-ANOTHER-CHAPTERS-TASK-20261112
// (#8508): public.watch_chapter_task refuses another chapter's live task
// exactly as it refuses an id with no task, for every member role, so the
// refusal does not tell that the other chapter's task exists.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";

const FILE = "20261113114100_chapter_task_watch_refusal_same_for_other_chapters.sql";
const code = stripComments(readFileSync(`supabase/migrations/${FILE}`, "utf8"));

describe("chapter task watch refusal migration (offline)", () => {
  it("refuses another chapter's task with the missing-task refusal and keeps the trigger function private", () => {
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    expect(code).toContain("create or replace function private.prepare_chapter_task_watcher()");
    expect(code).toContain("if task_chapter is null or task_chapter <> caller_chapter then\n    raise exception 'watch target must be a live task' using errcode = '22023';");
    expect(code).not.toContain("task must belong to your chapter");
    expect(code).toContain("revoke all on function private.prepare_chapter_task_watcher() from public, anon, authenticated;");
    expect(code).not.toMatch(/\bgrant\b/);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("chapter task watch refusal on a disposable database", () => {
  let c;
  let world;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "chapter-task-watch-refusal-proof" });
    await c.connect();
  });
  afterAll(async () => { await c?.end(); });

  async function call(text, values, user) {
    await c.query("savepoint call");
    try {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: user.id, session_id: user.session, aal: "aal2" })]);
      await c.query("set local role authenticated");
      const rows = (await c.query(text, values)).rows;
      await c.query("reset role");
      await c.query("release savepoint call");
      return { ok: true, rows };
    } catch (error) {
      await c.query("rollback to savepoint call");
      await c.query("release savepoint call");
      return { ok: false, code: error.code, message: error.message };
    }
  }

  async function chapter(org, name) {
    const id = `watch-refusal-${name}-${randomUUID().slice(0, 8)}`;
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98508)", [id, org]);
    await c.query("insert into public.chapter_workstreams(chapter_id,name) values ($1,'General') on conflict do nothing", [id]);
    return id;
  }

  async function person(org, chapterId, role) {
    const user = { id: randomUUID(), session: randomUUID() };
    await c.query("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org, user.id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, chapterId]);
    await c.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user.id, chapterId, `Proof ${role}`]);
    if (role === "steward" || role === "admin") {
      await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [org, user.id, role]);
      await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [user.id, role, chapterId]);
    }
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    return user;
  }

  beforeEach(async () => {
    await c.query("begin");
    const org = randomUUID();
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org, `watch-refusal-${org.slice(0, 8)}`]);
    const own = await chapter(org, "own");
    const other = await chapter(org, "other");
    const people = {
      member: await person(org, own, "member"),
      steward: await person(org, own, "steward"),
      admin: await person(org, own, "admin"),
      // A President whose role was removed from the other chapter but whose
      // stale role row still names it.
      stalePresident: await person(org, own, "member"),
    };
    await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'vp',$2) on conflict do nothing", [people.stalePresident.id, other]);
    const create = async (user, title) => {
      const result = await call("select id from public.create_chapter_task($1::jsonb)", [JSON.stringify({ title })], user);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      return result.rows[0].id;
    };
    const otherTask = await create(await person(org, other, "steward"), "Other chapter task");
    const ownTask = await create(people.steward, "Own chapter task");
    world = { people, otherTask, ownTask };
  });
  afterEach(async () => { await c.query("rollback"); });

  it("refuses another chapter's live task exactly as a task that does not exist, for every member role", async () => {
    for (const [role, user] of Object.entries(world.people)) {
      const missing = await call("select public.watch_chapter_task($1) as r", [randomUUID()], user);
      const elsewhere = await call("select public.watch_chapter_task($1) as r", [world.otherTask], user);
      expect(missing, role).toEqual({ ok: false, code: "22023", message: "watch target must be a live task" });
      expect(elsewhere, role).toEqual(missing);
    }
    expect((await c.query("select count(*)::int as n from public.chapter_task_watchers where task_id = $1", [world.otherTask])).rows[0].n).toBe(0);
  });

  it("leaves no unreviewed account lifecycle trigger behind", async () => {
    expect((await c.query("select * from private.account_lifecycle_referential_action_trigger_issues()")).rows).toEqual([]);
  }, 90_000);

  it("still lets a member watch a live task of their own chapter", async () => {
    const watched = await call("select public.watch_chapter_task($1) as r", [world.ownTask], world.people.member);
    expect(watched).toMatchObject({ ok: true, rows: [{ r: { task_id: world.ownTask } }] });
  });
});
