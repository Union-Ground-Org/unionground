// @vitest-environment node
//
// REQ-UG-LEARNING-PERIOD-TASKS-20261103 (#6941), slice 2 of #6805:
// a staff member's own task changes during the learning period are
// journalled once, in the same transaction, and undone to their earlier
// state; someone else's later change refuses the undo; notices already sent
// stay sent; the task history and the audit trail only grow.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { stripComments } from "./helpers/migration.js";
import { releaseLearningPeriodHold } from "./helpers/learningPeriodHold.js";
import { releaseCalendarHolds } from "./helpers/release-calendar-holds.js";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const FILE = "20261103183000_learning_period_tasks.sql";
const sql = readFileSync(`supabase/migrations/${FILE}`, "utf8");
const code = stripComments(sql);
const WRITERS = {
  "public.create_chapter_task": "task_create",
  "public.update_chapter_task_fields": "task_edit",
  "public.update_chapter_task_content": "task_edit",
  "public.move_chapter_task": "task_move",
  "public.soft_delete_chapter_task": "task_delete",
  "public.restore_chapter_task": "task_restore",
  "public.set_chapter_task_assignees": "task_assign",
};

describe("learning period tasks migration (offline)", () => {
  it("journals every task-row writer after its write, with the graph lock first", () => {
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    const functions = parseFunctions(sql);
    for (const [name, kind] of Object.entries(WRITERS)) {
      const source = functions.find((fn) => fn.name === name).source;
      expect(helperFirst(source), name).toBe(true);
      expect(source, name).toContain(`private.learning_task_journal('${kind}'`);
    }
    for (const name of ["private.learning_task_journal", "private.learning_undo_task"]) {
      expect(helperFirst(functions.find((fn) => fn.name === name).source), name).toBe(true);
    }
  });

  it("takes away the direct client writes on a task row", () => {
    expect(code).toContain("revoke insert, update on public.chapter_tasks from authenticated;");
    expect(code).toMatch(/revoke insert \(title, [^)]*\)\s+on public\.chapter_tasks from authenticated;/);
    expect(code).toMatch(/revoke update \(title, [^)]*\)\s+on public\.chapter_tasks from authenticated;/);
    expect(code).not.toMatch(/grant (insert|update)[^;]* on public\.chapter_tasks/);
  });

  it("dispatches only the task handler and writes no audit row of its own", () => {
    const dispatch = parseFunctions(sql).find((fn) => fn.name === "private.learning_dispatch").source;
    expect(dispatch).toContain("when 'private.learning_undo_task' then return private.learning_undo_task(p_mode, p_entry);");
    expect(code).not.toMatch(/(update|delete from)\s+public\.(organization_audit_ledger|organization_audit_events|chapter_task_activity)/);
    expect(code).not.toMatch(/delete from public\.chapter_tasks/);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("learning period tasks on a disposable database", () => {
  let c;
  let world;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "learning-period-tasks-proof" });
    await c.connect();
  });
  afterAll(async () => { await c?.end(); });

  async function call(text, values = [], user = null) {
    await c.query("savepoint call");
    try {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(user
        ? { role: "authenticated", sub: user.id, session_id: user.session, aal: "aal2" }
        : { role: "anon" })]);
      await c.query(user ? "set local role authenticated" : "set local role anon");
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
  const one = async (...args) => {
    const result = await call(...args);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    return result.rows[0] ? Object.values(result.rows[0])[0] : undefined;
  };
  const row = async (...args) => {
    const result = await call(...args);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    return result.rows[0];
  };

  async function person(org, role) {
    const user = { id: randomUUID(), session: randomUUID() };
    await c.query("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org.id, user.id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, org.chapter]);
    await c.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user.id, org.chapter, `Proof ${role}`]);
    if (role !== "member") {
      await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [org.id, user.id, role === "steward" ? "steward" : "admin"]);
      await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [user.id, role === "steward" ? "steward" : "admin", org.chapter]);
    }
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    return user;
  }

  beforeEach(async () => {
    await c.query("begin");
    await releaseLearningPeriodHold(c);
    await releaseCalendarHolds(c);
    const org = { id: randomUUID(), chapter: `learning-tasks-${randomUUID().slice(0, 8)}` };
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org.id, org.chapter]);
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98316)", [org.chapter, org.id]);
    await c.query("insert into public.chapter_workstreams(chapter_id,name) values ($1,'General') on conflict do nothing", [org.chapter]);
    world = { org, admin: await person(org, "admin"), steward: await person(org, "steward"), other: await person(org, "steward"), member: await person(org, "member") };
    // #9307: represent historical broad steward grants through their actual
    // migration-only carry-over, rather than an impossible unassigned actor.
    await migrateLegacyStewardFixtures(c);
  });
  afterEach(async () => { await c.query("rollback"); });

  const start = () => one("select public.start_organization_learning_period() as r", [], world.admin);
  const create = (user, fields) => row("select * from public.create_chapter_task($1::jsonb)", [JSON.stringify(fields)], user);
  // updated_at as text: a JavaScript Date would drop its microseconds.
  const taskState = async (id) => (await c.query("select title, description, status, priority, workstream, assignee_id, progress, blocked, deleted_at is not null as deleted, updated_at::text as updated_at from public.chapter_tasks where id = $1", [id])).rows[0];
  const version = async (id) => (await taskState(id)).updated_at;
  const entries = async (id) => (await c.query("select id, action_kind, state, version, actor_user_id from private.learning_action_journal where target_table = 'public.chapter_tasks' and target_id = $1 order by created_at, id", [id])).rows;
  const undo = (user, entry, version = 1) => call("select public.undo_my_learning_action($1, $2) as r", [entry, version], user);
  const counts = async (id) => (await c.query(`select (select count(*)::int from public.chapter_task_activity where task_id = $1) as activity,
    (select count(*)::int from public.organization_audit_ledger) as ledger, (select count(*)::int from public.organization_audit_events) as events,
    (select count(*)::int from public.member_notifications where kind = 'tasks') as notices`, [id])).rows[0];

  it("journals a staff member's task creation once and undoes it by hiding the task, never deleting it", async () => {
    await start();
    const task = await create(world.steward, { title: "Practice task", priority: "high" });
    expect(task).toMatchObject({ title: "Practice task", priority: "high", status: "to_do", workstream: "General", chapter_id: world.org.chapter, created_by: world.steward.id });
    const journal = await entries(task.id);
    expect(journal.map((entry) => [entry.action_kind, entry.state, entry.actor_user_id])).toEqual([["task_create", "active", world.steward.id]]);
    expect((await c.query("select flag from private.learning_practice_flags('public.chapter_tasks', array[$1::text])", [task.id])).rows).toEqual([{ flag: "practice" }]);
    const before = await counts(task.id);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [journal[0].id], world.steward)).toMatchObject({ status: "undone", undoneCount: 1 });
    expect(await taskState(task.id)).toMatchObject({ deleted: true, title: "Practice task" });
    const after = await counts(task.id);
    expect(after.activity).toBeGreaterThanOrEqual(before.activity);
    expect(after.ledger).toBe(before.ledger + 1);
    expect(after.events).toBe(before.events);
    expect((await c.query("select count(*)::int as n from public.chapter_tasks where id = $1", [task.id])).rows[0].n).toBe(1);
  });

  it("undoes an edit with your later edits, move and content change on the task, newest first, to the first state", async () => {
    await start();
    const task = await create(world.steward, { title: "Start", priority: "low" });
    const t1 = await taskState(task.id);
    const edited = await row("select * from public.update_chapter_task_fields($1, $2::jsonb, $3::timestamptz)", [task.id, JSON.stringify({ priority: "high", progress: 40 }), t1.updated_at], world.steward);
    expect(edited).toMatchObject({ priority: "high", progress: 40 });
    await row("select * from public.update_chapter_task_content($1, $2::timestamptz, $3, null)", [task.id, await version(task.id), "Renamed"], world.steward);
    await row("select * from public.move_chapter_task($1, 'General', 'in_progress', null, $2::timestamptz)", [task.id, await version(task.id)], world.steward);
    const journal = await entries(task.id);
    expect(journal.map((entry) => entry.action_kind)).toEqual(["task_create", "task_edit", "task_edit", "task_move"]);
    const before = await counts(task.id);
    const result = await one("select public.undo_my_learning_action($1, 1) as r", [journal[1].id], world.steward);
    expect(result).toMatchObject({ status: "undone", undoneCount: 3 });
    expect(await taskState(task.id)).toMatchObject({ title: "Start", priority: "low", progress: 0, status: "to_do", deleted: false });
    expect((await entries(task.id)).map((entry) => entry.state)).toEqual(["active", "undone", "undone", "undone"]);
    const after = await counts(task.id);
    expect(after.activity).toBeGreaterThan(before.activity);
    expect(after.ledger).toBe(before.ledger + 3);
  });

  it("refuses an undo when another staff member changed the task since, and changes nothing", async () => {
    await start();
    const task = await create(world.steward, { title: "Shared" });
    await row("select * from public.update_chapter_task_fields($1, $2::jsonb, null)", [task.id, JSON.stringify({ priority: "high" })], world.steward);
    await row("select * from public.update_chapter_task_fields($1, $2::jsonb, null)", [task.id, JSON.stringify({ blocked: true })], world.other);
    const mine = (await entries(task.id)).find((entry) => entry.action_kind === "task_edit" && entry.actor_user_id === world.steward.id);
    const before = await taskState(task.id);
    expect(await undo(world.steward, mine.id)).toMatchObject({ ok: false, code: "PT409" });
    expect(await taskState(task.id)).toEqual(before);
    expect((await entries(task.id)).every((entry) => entry.state === "active")).toBe(true);
    // Another person's entry is not theirs to undo.
    expect(await undo(world.other, mine.id)).toMatchObject({ ok: false, code: "P0002" });
  });

  it("undoes a delete by restoring the task and a restore by deleting it again", async () => {
    await start();
    const task = await create(world.steward, { title: "Delete me" });
    await one("select public.soft_delete_chapter_task($1) as r", [task.id], world.steward);
    expect(await taskState(task.id)).toMatchObject({ deleted: true });
    let journal = await entries(task.id);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [journal.at(-1).id], world.steward)).toMatchObject({ status: "undone" });
    expect(await taskState(task.id)).toMatchObject({ deleted: false, title: "Delete me" });
    await one("select public.soft_delete_chapter_task($1) as r", [task.id], world.steward);
    await one("select public.restore_chapter_task($1) as r", [task.id], world.steward);
    journal = await entries(task.id);
    expect(journal.at(-1).action_kind).toBe("task_restore");
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [journal.at(-1).id], world.steward)).toMatchObject({ status: "undone" });
    expect(await taskState(task.id)).toMatchObject({ deleted: true });
  });

  it("keeps every co-assignee through an edit that does not touch the assignee, with or without a period", async () => {
    for (const running of [false, true]) {
      if (running) await start();
      const task = await create(world.steward, { title: `Shared ${running}` });
      await one("select public.set_chapter_task_assignees($1, $2::uuid[]) as r", [task.id, [world.other.id, world.member.id]], world.steward);
      // The edit comes in its own request: set_chapter_task_assignees leaves
      // its transaction-local skip set, and a new request starts without it.
      await c.query("select set_config('sg.setting_task_assignees', '', true)");
      await one("select count(*) from public.update_chapter_task_fields($1, $2::jsonb) as r", [task.id, JSON.stringify({ due_date: "2026-12-01" })], world.steward);
      expect((await c.query("select assignee_id from public.chapter_task_assignments where task_id = $1 order by position", [task.id])).rows.map((r) => r.assignee_id)).toEqual([world.other.id, world.member.id]);
      // Naming the assignee still sets the primary, as a direct edit did.
      await one("select count(*) from public.update_chapter_task_fields($1, $2::jsonb) as r", [task.id, JSON.stringify({ assignee_id: world.member.id })], world.steward);
      expect(await taskState(task.id)).toMatchObject({ assignee_id: world.member.id });
    }
  });

  it("tells the assignee when an undo puts a task back or takes it away, so their last notice is true", async () => {
    await start();
    // One test transaction stamps every notice with the same now(), so these
    // compare the notices each step added, not their order.
    const titles = async () => (await c.query("select title from public.member_notifications where kind = 'tasks' and user_id = $1", [world.member.id])).rows.map((notice) => notice.title);
    const added = async (since) => { const now = await titles(); for (const title of since) now.splice(now.indexOf(title), 1); return now.sort(); };
    const task = await create(world.steward, { title: "Owned", assignee_id: world.member.id });
    await one("select public.soft_delete_chapter_task($1) as r", [task.id], world.steward);
    let since = await titles();
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [(await entries(task.id)).at(-1).id], world.steward)).toMatchObject({ status: "undone" });
    expect(await added(since)).toEqual(["A task is back on your list"]);
    await one("select public.soft_delete_chapter_task($1) as r", [task.id], world.steward);
    await one("select public.restore_chapter_task($1) as r", [task.id], world.steward);
    since = await titles();
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [(await entries(task.id)).at(-1).id], world.steward)).toMatchObject({ status: "undone" });
    expect(await taskState(task.id)).toMatchObject({ deleted: true });
    expect(await added(since)).toEqual(["A task was removed"]);
    // Undoing a creation takes the task away from its assignee too.
    const made = await create(world.steward, { title: "Made", assignee_id: world.member.id });
    since = await titles();
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [(await entries(made.id))[0].id], world.steward)).toMatchObject({ status: "undone" });
    expect(await added(since)).toEqual(["A task was removed"]);
    // Your own task tells nobody.
    const mine = await create(world.steward, { title: "Mine", assignee_id: world.steward.id });
    const own = (await c.query("select count(*)::int as n from public.member_notifications where user_id = $1", [world.steward.id])).rows[0].n;
    await one("select public.undo_my_learning_action($1, 1) as r", [(await entries(mine.id))[0].id], world.steward);
    expect((await c.query("select count(*)::int as n from public.member_notifications where user_id = $1", [world.steward.id])).rows[0].n).toBe(own);
  });

  it("undoes an assignee change, keeping what was sent and telling each person once what changed back", async () => {
    await start();
    const noticesOf = async (user) => (await c.query("select id, title from public.member_notifications where kind = 'tasks' and user_id = $1", [user.id])).rows;
    const addedFor = async (user, since) => (await noticesOf(user)).filter((notice) => !since.some((old) => old.id === notice.id)).map((notice) => notice.title).sort();
    // A primary and a co-assignee, then undone: both come off, each told once.
    const task = await create(world.steward, { title: "Assign me" });
    await one("select public.set_chapter_task_assignees($1, $2::uuid[]) as r", [task.id, [world.other.id, world.member.id]], world.steward);
    const sentOther = await noticesOf(world.other);
    const sentMember = await noticesOf(world.member);
    expect(sentOther.length + sentMember.length).toBeGreaterThan(0);
    const journal = await entries(task.id);
    expect(journal.at(-1).action_kind).toBe("task_assign");
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [journal.at(-1).id], world.steward)).toMatchObject({ status: "undone" });
    expect(await taskState(task.id)).toMatchObject({ assignee_id: null });
    expect((await c.query("select count(*)::int as n from public.chapter_task_assignments where task_id = $1", [task.id])).rows[0].n).toBe(0);
    // What went out stays, and the newest notice each holds is true again.
    expect((await noticesOf(world.other)).map((notice) => notice.id)).toEqual(expect.arrayContaining(sentOther.map((notice) => notice.id)));
    expect(await addedFor(world.other, sentOther)).toEqual(["A task moved off your list"]);
    expect(await addedFor(world.member, sentMember)).toEqual(["A task moved off your list"]);
    // Reassigned from one person to another, then undone: each told once.
    const moved = await create(world.steward, { title: "Hand over" });
    await one("select public.set_chapter_task_assignees($1, $2::uuid[]) as r", [moved.id, [world.member.id]], world.steward);
    await one("select public.set_chapter_task_assignees($1, $2::uuid[]) as r", [moved.id, [world.other.id]], world.steward);
    const beforeMember = await noticesOf(world.member);
    const beforeOther = await noticesOf(world.other);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [(await entries(moved.id)).at(-1).id], world.steward)).toMatchObject({ status: "undone" });
    expect(await taskState(moved.id)).toMatchObject({ assignee_id: world.member.id });
    expect(await addedFor(world.member, beforeMember)).toEqual(["Proof steward assigned you a task"]);
    expect(await addedFor(world.other, beforeOther)).toEqual(["A task moved off your list"]);
    // The handler leaves the assignment sync on for whatever runs next.
    expect((await c.query("select coalesce(current_setting('sg.setting_task_assignees', true), '') as v")).rows[0].v).toBe("");
  });

  it("keeps the staff rule: members cannot create or edit, and no client writes a task row directly", async () => {
    await start();
    expect(await call("select * from public.create_chapter_task('{\"title\":\"No\"}'::jsonb)", [], world.member)).toMatchObject({ ok: false, code: "42501" });
    expect(await call("select * from public.create_chapter_task('{\"title\":\"No\",\"chapter_id\":\"x\"}'::jsonb)", [], world.steward)).toMatchObject({ ok: false, code: "22023" });
    const task = await create(world.steward, { title: "Mine" });
    expect(await call("select * from public.update_chapter_task_fields($1, '{\"priority\":\"high\"}'::jsonb, null)", [task.id], world.member)).toMatchObject({ ok: false, code: "42501" });
    for (const statement of [
      `insert into public.chapter_tasks(title) values ('Direct')`,
      `update public.chapter_tasks set title = 'Direct' where id = '${task.id}'`,
    ]) {
      expect(await call(statement, [], world.steward), statement).toMatchObject({ ok: false, code: "42501" });
    }
  });

  const edgeEntries = async (table) => (await c.query("select id, action_kind, state, target_id, parent_entry_id from private.learning_action_journal where target_table = $1 and organization_id = $2 order by created_at, id", [table, world.org.id])).rows;
  const undoNewest = async (table, user = world.steward) => {
    const entry = (await edgeEntries(table)).at(-1);
    return one("select public.undo_my_learning_action($1, 1) as r", [entry.id], user);
  };

  it("undoes adding and removing a link, a dependency and a subtask link, and watching", async () => {
    await start();
    const task = await create(world.steward, { title: "Edges" });
    const other = await create(world.steward, { title: "Other" });
    // A link: added, then removed and put back by undo.
    const link = await one("select public.add_chapter_task_attachment($1, 'Case file', '/m/cases') as r", [task.id], world.steward);
    await one("select public.remove_chapter_task_attachment($1) as r", [link.id], world.steward);
    expect((await c.query("select count(*)::int as n from public.chapter_task_attachments where id = $1", [link.id])).rows[0].n).toBe(0);
    expect(await undoNewest("public.chapter_task_attachments")).toMatchObject({ status: "undone" });
    expect((await c.query("select label, record_url from public.chapter_task_attachments where id = $1", [link.id])).rows).toEqual([{ label: "Case file", record_url: "/m/cases" }]);
    // Undoing the add now removes it: the remove was undone, so the add is the newest active step.
    const added = (await edgeEntries("public.chapter_task_attachments")).find((entry) => entry.action_kind === "task_link_add");
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [added.id], world.steward)).toMatchObject({ status: "undone" });
    expect((await c.query("select count(*)::int as n from public.chapter_task_attachments where id = $1", [link.id])).rows[0].n).toBe(0);
    // A dependency and a subtask link.
    const dependency = await row("select * from public.add_chapter_task_dependency($1, $2)", [task.id, other.id], world.steward);
    expect(await one("select public.remove_chapter_task_dependency($1) as r", [dependency.id], world.steward)).toEqual({ id: dependency.id });
    expect(await one("select public.remove_chapter_task_dependency($1) as r", [dependency.id], world.steward)).toBeNull();
    expect(await undoNewest("public.chapter_task_dependencies")).toMatchObject({ status: "undone" });
    expect((await c.query("select depends_on_id from public.chapter_task_dependencies where id = $1", [dependency.id])).rows).toEqual([{ depends_on_id: other.id }]);
    const subtask = await row("select * from public.add_chapter_task_subtask($1, $2)", [task.id, other.id], world.steward);
    expect(await undoNewest("public.chapter_task_subtasks")).toMatchObject({ status: "undone" });
    expect((await c.query("select count(*)::int as n from public.chapter_task_subtasks where id = $1", [subtask.id])).rows[0].n).toBe(0);
    // Watching is a member's own preference.
    await one("select public.watch_chapter_task($1) as r", [task.id], world.member);
    await one("select public.unwatch_chapter_task($1) as r", [task.id], world.member);
    expect(await undoNewest("public.chapter_task_watchers", world.member)).toMatchObject({ status: "undone" });
    expect((await c.query("select count(*)::int as n from public.chapter_task_watchers where task_id = $1 and user_id = $2", [task.id, world.member.id])).rows[0].n).toBe(1);
    // Members still cannot change edges, and no client writes them directly.
    expect(await call("select * from public.add_chapter_task_dependency($1, $2)", [other.id, task.id], world.member)).toMatchObject({ ok: false, code: "42501" });
    for (const statement of [
      `insert into public.chapter_task_dependencies(task_id, depends_on_id) values ('${other.id}', '${task.id}')`,
      `delete from public.chapter_task_subtasks where parent_task_id = '${task.id}'`,
      `insert into public.chapter_task_watchers(task_id) values ('${other.id}')`,
    ]) expect(await call(statement, [], world.steward), statement).toMatchObject({ ok: false, code: "42501" });
  });

  it("undoes an add together with its later remove, judged on the edge as it stood", async () => {
    await start();
    const task = await create(world.steward, { title: "Chains" });
    const other = await create(world.steward, { title: "Other" });
    const link = await one("select public.add_chapter_task_attachment($1, 'Case file', '/m/cases') as r", [task.id], world.steward);
    await one("select public.remove_chapter_task_attachment($1) as r", [link.id], world.steward);
    const linkAdd = (await edgeEntries("public.chapter_task_attachments")).find((entry) => entry.action_kind === "task_link_add");
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [linkAdd.id], world.steward)).toMatchObject({ status: "undone", undoneCount: 2 });
    expect((await c.query("select count(*)::int as n from public.chapter_task_attachments where id = $1", [link.id])).rows[0].n).toBe(0);
    const dependency = await row("select * from public.add_chapter_task_dependency($1, $2)", [task.id, other.id], world.steward);
    await one("select public.remove_chapter_task_dependency($1) as r", [dependency.id], world.steward);
    const depAdd = (await edgeEntries("public.chapter_task_dependencies")).find((entry) => entry.action_kind === "task_dependency_add");
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [depAdd.id], world.steward)).toMatchObject({ status: "undone", undoneCount: 2 });
    const subtask = await row("select * from public.add_chapter_task_subtask($1, $2)", [task.id, other.id], world.steward);
    await one("select public.remove_chapter_task_subtask($1) as r", [subtask.id], world.steward);
    const subAdd = (await edgeEntries("public.chapter_task_subtasks")).find((entry) => entry.action_kind === "task_subtask_add");
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [subAdd.id], world.steward)).toMatchObject({ status: "undone", undoneCount: 2 });
    await one("select public.watch_chapter_task($1) as r", [task.id], world.member);
    await one("select public.unwatch_chapter_task($1) as r", [task.id], world.member);
    const watched = (await edgeEntries("public.chapter_task_watchers")).find((entry) => entry.action_kind === "task_watch");
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [watched.id], world.member)).toMatchObject({ status: "undone", undoneCount: 2 });
    expect((await c.query("select count(*)::int as n from public.chapter_task_watchers where task_id = $1", [task.id])).rows[0].n).toBe(0);
    // The projected state still carries the task: a member cannot undo a staff edge chain.
    expect(await undo(world.member, linkAdd.id)).toMatchObject({ ok: false });
  });

  it("unwatches only a watch in the caller's selected chapter", async () => {
    const task = await create(world.steward, { title: "Watched" });
    await one("select public.watch_chapter_task($1) as r", [task.id], world.member);
    const elsewhere = `${world.org.chapter}-b`;
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98317)", [elsewhere, world.org.id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [world.member.id, elsewhere]);
    await c.query("update public.member_profiles set chapter_id = $2 where id = $1", [world.member.id, elsewhere]);
    expect(await one("select public.unwatch_chapter_task($1) as r", [task.id], world.member)).toBeNull();
    expect((await c.query("select count(*)::int as n from public.chapter_task_watchers where task_id = $1 and user_id = $2", [task.id, world.member.id])).rows[0].n).toBe(1);
  });

  // Carried from #6979 round 5 into 20261104075000 (#6942, section 0).
  it("keeps co-assignees when an edit repeats the current primary (r5g2)", async () => {
    const task = await create(world.steward, { title: "Repeat primary" });
    await one("select public.set_chapter_task_assignees($1, $2::uuid[]) as r", [task.id, [world.other.id, world.member.id]], world.steward);
    await c.query("select set_config('sg.setting_task_assignees', '', true)");
    await one("select count(*) from public.update_chapter_task_fields($1, $2::jsonb) as r", [task.id, JSON.stringify({ due_date: "2026-12-01", assignee_id: world.other.id })], world.steward);
    expect((await c.query("select assignee_id from public.chapter_task_assignments where task_id = $1 order by position", [task.id])).rows.map((r) => r.assignee_id)).toEqual([world.other.id, world.member.id]);
  });

  it("undoes a source-created task together with its own later deletion (r5s1)", async () => {
    await start();
    const notice = (await c.query("insert into public.member_notifications (user_id, title, body, kind) values ($1, 'Source', 'Body', 'general') returning id", [world.steward.id])).rows[0].id;
    const made = await one("select public.create_chapter_task_from_source('notification', $1) as r", [notice], world.steward);
    const task = made.task.id;
    await one("select public.soft_delete_chapter_task($1) as r", [task], world.steward);
    const creation = (await entries(task)).find((entry) => entry.action_kind === "task_create");
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [creation.id], world.steward)).toMatchObject({ status: "undone", undoneCount: 3 });
    expect(await taskState(task)).toMatchObject({ deleted: true });
    expect((await c.query("select count(*)::int as n from public.chapter_task_attachments where task_id = $1", [task])).rows[0].n).toBe(0);
  });

  it("refuses to undo a task's creation once someone else's check-offs hang off it (r5s2)", async () => {
    await start();
    await c.query("insert into public.organization_setting_values(organization_id, setting_key, value) values ($1, 'features.tasks.coop_checkoff_lists', 'true'::jsonb) on conflict (organization_id, setting_key) do update set value = excluded.value", [world.org.id]);
    const task = await create(world.steward, { title: "Theirs on mine" });
    const listed = await call("select public.create_task_checkoff_list($1, 'shared', $2::uuid[], $3::uuid[], null) as r", [task.id, [world.member.id], [world.other.id]], world.other);
    expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true });
    const creation = (await entries(task.id)).find((entry) => entry.action_kind === "task_create");
    expect(await undo(world.steward, creation.id)).toMatchObject({ ok: false, code: "PT409" });
    expect(await taskState(task.id)).toMatchObject({ deleted: false });
    expect((await c.query("select state from private.learning_action_journal where id = $1", [creation.id])).rows[0].state).toBe("active");
  });

  it("refuses to put back a dependency whose other end was deleted since, and changes nothing (r5g1)", async () => {
    await start();
    const task = await create(world.steward, { title: "X" });
    const other = await create(world.steward, { title: "Y" });
    const dependency = await row("select * from public.add_chapter_task_dependency($1, $2)", [task.id, other.id], world.steward);
    await one("select public.remove_chapter_task_dependency($1) as r", [dependency.id], world.steward);
    await one("select public.soft_delete_chapter_task($1) as r", [other.id], world.other);
    const removed = (await edgeEntries("public.chapter_task_dependencies")).find((entry) => entry.action_kind === "task_dependency_remove");
    expect(await undo(world.steward, removed.id)).toMatchObject({ ok: false, code: "42501" });
    expect((await c.query("select count(*)::int as n from public.chapter_task_dependencies where id = $1", [dependency.id])).rows[0].n).toBe(0);
    expect((await c.query("select state from private.learning_action_journal where id = $1", [removed.id])).rows[0].state).toBe("active");
  });

  it("keeps comments, task messages and file removals as sent, never undoable", async () => {
    await start();
    const task = await create(world.steward, { title: "Talk" });
    await one("select public.add_chapter_task_comment($1, 'Practice comment', '{}'::uuid[]) as r", [task.id], world.steward);
    // A task message goes between its creator and its assignee.
    await one("select public.set_chapter_task_assignees($1, $2::uuid[]) as r", [task.id, [world.other.id]], world.steward);
    await one("select public.send_chapter_task_message($1, 'Practice message') as r", [task.id], world.other);
    for (const [table, author] of [["public.chapter_task_comments", world.steward], ["public.chapter_task_messages", world.other]]) {
      const [entry] = await edgeEntries(table);
      expect(entry, table).toMatchObject({ state: "kept" });
      expect(await undo(author, entry.id), table).toMatchObject({ ok: false, code: "55000" });
      expect((await c.query("select before_image, after_fingerprint from private.learning_action_journal where id = $1", [entry.id])).rows[0]).toEqual({ before_image: null, after_fingerprint: null });
    }
  });

  it("undoes your own upload by requesting its removal for the reconciler", async () => {
    await start();
    const task = await create(world.steward, { title: "Files" });
    const file = randomUUID();
    await c.query(`insert into public.chapter_task_files(id, task_id, chapter_id, bucket_id, object_name, filename, mime_type, size_bytes, uploaded_by, confirmed_at)
      values ($1, $2, $3, 'chapter-task-files', $4, 'notes.pdf', 'application/pdf', 10, $5, now())`, [file, task.id, world.org.chapter, `${world.org.chapter}/${task.id}/${file}.pdf`, world.steward.id]);
    // The confirm path's own journal call, made with the uploader's claims.
    const uploaded = await call(`select private.learning_journal_append('task_file_upload', 'public.chapter_task_files', $1::text, null,
      private.learning_fingerprint(private.learning_task_file_state($1::uuid)), null, '{}'::jsonb) as r`, [file], world.steward);
    expect(uploaded).toMatchObject({ ok: false, code: "42501" });
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: world.steward.id, session_id: world.steward.session, aal: "aal2" })]);
    const entry = (await c.query(`select private.learning_journal_append('task_file_upload', 'public.chapter_task_files', $1::text, null,
      private.learning_fingerprint(private.learning_task_file_state($1::uuid)), null, '{}'::jsonb) as r`, [file])).rows[0].r;
    expect(await undo(world.other, entry)).toMatchObject({ ok: false, code: "P0002" });
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [entry], world.steward)).toMatchObject({ status: "undone" });
    const removal = (await c.query("select removal_id is not null as requested, removal_requested_by from public.chapter_task_files where id = $1", [file])).rows[0];
    expect(removal).toEqual({ requested: true, removal_requested_by: world.steward.id });
    // Removing a file someone else uploaded stays permanent.
    const theirs = randomUUID();
    await c.query(`insert into public.chapter_task_files(id, task_id, chapter_id, bucket_id, object_name, filename, mime_type, size_bytes, uploaded_by, confirmed_at)
      values ($1, $2, $3, 'chapter-task-files', $4, 'minutes.pdf', 'application/pdf', 10, $5, now())`, [theirs, task.id, world.org.chapter, `${world.org.chapter}/${task.id}/${theirs}.pdf`, world.other.id]);
    await one("select public.request_chapter_task_file_removal($1, $2) as r", [theirs, randomUUID()], world.steward);
    const removed = (await edgeEntries("public.chapter_task_files")).find((row) => row.action_kind === "task_file_remove");
    expect(removed).toMatchObject({ state: "kept", target_id: theirs });
    expect(await undo(world.steward, removed.id)).toMatchObject({ ok: false, code: "55000" });
  });

  // Losing every staff role in the chapter, while staying a member.
  const demote = (user) => c.query("delete from public.member_roles where user_id = $1", [user.id])
    .then(() => c.query("delete from public.organization_role_grants where user_id = $1", [user.id]));

  it("refuses to undo your upload once you are no longer chapter staff, as removing it would", async () => {
    await start();
    const task = await create(world.steward, { title: "Files" });
    const file = randomUUID();
    await c.query(`insert into public.chapter_task_files(id, task_id, chapter_id, bucket_id, object_name, filename, mime_type, size_bytes, uploaded_by, confirmed_at)
      values ($1, $2, $3, 'chapter-task-files', $4, 'notes.pdf', 'application/pdf', 10, $5, now())`, [file, task.id, world.org.chapter, `${world.org.chapter}/${task.id}/${file}.pdf`, world.steward.id]);
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: world.steward.id, session_id: world.steward.session, aal: "aal2" })]);
    const entry = (await c.query(`select private.learning_journal_append('task_file_upload', 'public.chapter_task_files', $1::text, null,
      private.learning_fingerprint(private.learning_task_file_state($1::uuid)), null, '{}'::jsonb) as r`, [file])).rows[0].r;
    await demote(world.steward);
    expect(await call("select public.request_chapter_task_file_removal($1, $2) as r", [file, randomUUID()], world.steward)).toMatchObject({ ok: false });
    expect(await undo(world.steward, entry)).toMatchObject({ ok: false, code: "42501" });
    expect((await c.query("select removal_id is null as kept from public.chapter_task_files where id = $1", [file])).rows[0]).toEqual({ kept: true });
    expect((await c.query("select state from private.learning_action_journal where id = $1", [entry])).rows[0].state).toBe("active");
  });

  it("refuses to undo a check-off list you made once you are no longer chapter staff", async () => {
    await start();
    await c.query("insert into public.organization_setting_values(organization_id, setting_key, value) values ($1, 'features.tasks.coop_checkoff_lists', 'true'::jsonb) on conflict (organization_id, setting_key) do update set value = excluded.value", [world.org.id]);
    const task = await create(world.steward, { title: "Calls" });
    const created = await call("select public.create_task_checkoff_list($1, 'shared', $2::uuid[], $3::uuid[], null) as r", [task.id, [world.member.id], [world.steward.id]], world.steward);
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    const [list] = await edgeEntries("private.task_checkoff_lists");
    await demote(world.steward);
    expect(await call("select public.set_task_checkoff_list_status($1, 'closed') as r", [task.id], world.steward)).toMatchObject({ ok: false, code: "42501" });
    expect(await undo(world.steward, list.id)).toMatchObject({ ok: false, code: "42501" });
    expect((await c.query("select status from private.task_checkoff_lists where task_id = $1", [task.id])).rows[0].status).not.toBe("closed");
  });

  it("lets chapter staff undo their own check-off on an unassigned shared-list entry", async () => {
    await start();
    await c.query("insert into public.organization_setting_values(organization_id, setting_key, value) values ($1, 'features.tasks.coop_checkoff_lists', 'true'::jsonb) on conflict (organization_id, setting_key) do update set value = excluded.value", [world.org.id]);
    const task = await create(world.steward, { title: "Shared calls" });
    const created = await call("select public.create_task_checkoff_list($1, 'shared', $2::uuid[], $3::uuid[], null) as r", [task.id, [world.member.id], [world.steward.id]], world.steward);
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    const target = (await edgeEntries("private.task_checkoff_entries"))[0].target_id;
    expect((await c.query("select assigned_steward_id from private.task_checkoff_entries where id = $1", [target])).rows[0].assigned_steward_id).toBeNull();
    // Another steward, neither the list's creator nor an admin, checks it off.
    const set = await call("select public.set_task_checkoff_entry($1, 'done', 'Reached', 'pending') as r", [target], world.other);
    expect(set, JSON.stringify(set)).toMatchObject({ ok: true });
    const mine = (await edgeEntries("private.task_checkoff_entries")).at(-1);
    expect(mine.action_kind).toBe("task_checkoff_entry");
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [mine.id], world.other)).toMatchObject({ status: "undone" });
    expect((await c.query("select status from private.task_checkoff_entries where id = $1", [target])).rows[0].status).toBe("pending");
  });

  it("undoes a check-off list with all its members at once, and a single check-off on its own", async () => {
    await start();
    await c.query("insert into public.organization_setting_values(organization_id, setting_key, value) values ($1, 'features.tasks.coop_checkoff_lists', 'true'::jsonb) on conflict (organization_id, setting_key) do update set value = excluded.value", [world.org.id]);
    const task = await create(world.steward, { title: "Calls" });
    const created = await call("select public.create_task_checkoff_list($1, 'shared', $2::uuid[], $3::uuid[], null) as r", [task.id, [world.member.id, world.other.id], [world.steward.id]], world.steward);
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    const lists = await edgeEntries("private.task_checkoff_lists");
    const members = await edgeEntries("private.task_checkoff_entries");
    expect(lists.map((entry) => entry.action_kind)).toEqual(["task_checkoff_create"]);
    expect(members.map((entry) => [entry.action_kind, entry.parent_entry_id])).toEqual([["task_checkoff_entry_create", lists[0].id], ["task_checkoff_entry_create", lists[0].id]]);
    // One check-off on its own, then undone back to pending.
    const target = members[0].target_id;
    const set = await call("select public.set_task_checkoff_entry($1, 'done', 'Reached', 'pending') as r", [target], world.steward);
    expect(set, JSON.stringify(set)).toMatchObject({ ok: true });
    expect(await undoNewest("private.task_checkoff_entries")).toMatchObject({ status: "undone" });
    expect((await c.query("select status, note from private.task_checkoff_entries where id = $1", [target])).rows[0]).toEqual({ status: "pending", note: "" });
    // The list creation with every member it placed: one undo, all or nothing.
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [lists[0].id], world.steward)).toMatchObject({ status: "undone", undoneCount: 3 });
    expect((await c.query("select status from private.task_checkoff_lists where task_id = $1", [task.id])).rows[0]).toEqual({ status: "closed" });
    expect((await edgeEntries("private.task_checkoff_entries")).filter((entry) => entry.action_kind === "task_checkoff_entry_create").map((entry) => entry.state)).toEqual(["undone", "undone"]);
  });

  it("journals nothing when no learning period runs, and the writes still work", async () => {
    const task = await create(world.steward, { title: "Outside" });
    await row("select * from public.update_chapter_task_fields($1, '{\"priority\":\"high\"}'::jsonb, null)", [task.id], world.steward);
    await one("select public.soft_delete_chapter_task($1) as r", [task.id], world.steward);
    expect(await entries(task.id)).toEqual([]);
  });
});
