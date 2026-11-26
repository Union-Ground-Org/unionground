// @vitest-environment node
//
// SEC-UG-CHAPTER-TASK-LINK-REFUSALS-REVEAL-ANOTHER-CHAPTERS-TASK-20261112
// (#8523): public.add_chapter_task_dependency and
// public.add_chapter_task_subtask refuse another chapter's live task exactly
// as they refuse an id with no task, in either position and for every staff
// role, so the refusal does not tell that the other chapter's task exists.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { stripComments } from "./helpers/migration.js";

const FILE = "20261113114200_chapter_task_link_refusals_same_for_other_chapters.sql";
const sql = readFileSync(`supabase/migrations/${FILE}`, "utf8");
const code = stripComments(sql);
const STAFF = ["steward", "coordinator", "advisor", "admin", "vp"];
const LINKS = {
  dependency: { call: "select * from public.add_chapter_task_dependency($1, $2)", refusal: "dependency endpoints must be live tasks" },
  subtask: { call: "select * from public.add_chapter_task_subtask($1, $2)", refusal: "subtask endpoints must be live tasks" },
};

describe("chapter task link refusals migration (offline)", () => {
  it("refuses another chapter's endpoint with the missing-task refusal and keeps the case-graph lock first", () => {
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    const functions = parseFunctions(sql);
    for (const name of ["private.prepare_chapter_task_dependency", "private.prepare_chapter_task_subtask"]) {
      const source = functions.find((fn) => fn.name === name)?.source;
      expect(source, name).toBeTruthy();
      expect(helperFirst(source), name).toBe(true);
    }
    expect(code).toContain("or task_chapter <> caller_chapter or dep_chapter <> caller_chapter then\n    raise exception 'dependency endpoints must be live tasks'");
    expect(code).toContain("or parent_chapter <> caller_chapter or child_chapter <> caller_chapter then\n    raise exception 'subtask endpoints must be live tasks'");
    expect(code).not.toContain("must belong to your chapter");
    expect(code).toContain("revoke all on function private.prepare_chapter_task_dependency() from public, anon, authenticated;");
    expect(code).toContain("revoke all on function private.prepare_chapter_task_subtask() from public, anon, authenticated;");
    expect(code).not.toMatch(/\bgrant\b/i);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("chapter task link refusals on a disposable database", () => {
  let c;
  let world;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "chapter-task-link-refusals-proof" });
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
    const id = `link-refusal-${name}-${randomUUID().slice(0, 8)}`;
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98523)", [id, org]);
    await c.query("insert into public.chapter_workstreams(chapter_id,name) values ($1,'General') on conflict do nothing", [id]);
    return id;
  }

  async function staff(org, chapterId, role) {
    const user = { id: randomUUID(), session: randomUUID() };
    await c.query("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org, user.id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, chapterId]);
    await c.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user.id, chapterId, `Proof ${role}`]);
    await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [org, user.id, role]);
    await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [user.id, role, chapterId]);
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    return user;
  }

  beforeEach(async () => {
    await c.query("begin");
    const org = randomUUID();
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org, `link-refusal-${org.slice(0, 8)}`]);
    const own = await chapter(org, "own");
    const other = await chapter(org, "other");
    const people = {};
    for (const role of STAFF) people[role] = await staff(org, own, role);
    const create = async (user, title) => {
      const result = await call("select id from public.create_chapter_task($1::jsonb)", [JSON.stringify({ title })], user);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      return result.rows[0].id;
    };
    const otherTask = await create(await staff(org, other, "steward"), "Other chapter task");
    const ownTask = await create(people.steward, "Own chapter task");
    const ownSecond = await create(people.steward, "Second own chapter task");
    world = { people, otherTask, ownTask, ownSecond };
  });
  afterEach(async () => { await c.query("rollback"); });

  it("leaves no unreviewed account lifecycle trigger behind", async () => {
    expect((await c.query("select * from private.account_lifecycle_referential_action_trigger_issues()")).rows).toEqual([]);
  }, 90_000);

  for (const [kind, link] of Object.entries(LINKS)) {
    it(`refuses another chapter's task as a ${kind} endpoint exactly as a task that does not exist, for every staff role`, async () => {
      for (const [role, user] of Object.entries(world.people)) {
        for (const [position, pair] of Object.entries({
          first: (id) => [id, world.ownTask],
          second: (id) => [world.ownTask, id],
        })) {
          const missing = await call(link.call, pair(randomUUID()), user);
          const elsewhere = await call(link.call, pair(world.otherTask), user);
          expect(missing, `${role} ${position}`).toEqual({ ok: false, code: "22023", message: link.refusal });
          expect(elsewhere, `${role} ${position}`).toEqual(missing);
        }
      }
    });

    it(`still links two live tasks of the caller's chapter as a ${kind}`, async () => {
      const linked = await call(link.call, [world.ownTask, world.ownSecond], world.people.steward);
      expect(linked, JSON.stringify(linked)).toMatchObject({ ok: true });
      expect(linked.rows).toHaveLength(1);
    });
  }
});
