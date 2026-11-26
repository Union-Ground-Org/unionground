// @vitest-environment node
//
// Staff-only is a claim about the DATABASE, not about routing. Nothing in the
// app can verify it: the member route is gone, so a regression here is
// invisible until someone finds it with a REST client.
//
// These tests sign in as a role-less member and assert the shape of the
// refusal. They are env-gated the same way the rest of the integration suite
// is: with no service key and no seeded fixtures they skip rather than fail, so
// a contributor without database access still gets a green run.
//
// Fixtures expected (created by the seed helper, not here; env vars carry the
// fixture credentials, nothing is checked in):
//   MEMBER_EMAIL / MEMBER_PASSWORD  — a member of chapter 12 with NO staff role
//   STAFF_EMAIL  / STAFF_PASSWORD   — a coordinator in the same chapter
// Both must have MFA satisfied (mfa_satisfied() gates the RPCs).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const url = process.env.VITE_SUPABASE_URL;
const anon = process.env.VITE_SUPABASE_ANON_KEY;
const MEMBER = "MEMBER";
const STAFF = "STAFF";
const fixtureEmail = (who) => process.env[`${who}_EMAIL`];
const configured = Boolean(url && anon && fixtureEmail(MEMBER) && fixtureEmail(STAFF));
const describeIf = configured ? describe : describe.skip;

async function signedIn(who) {
  const email = fixtureEmail(who);
  const password = process.env[`${who}_PASSWORD`];
  const client = createClient(url, anon, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

describeIf("chapter_tasks — staff-only writes (2026-07-27 decision)", () => {
  let asMember;
  let asStaff;
  let seededTaskId;

  beforeAll(async () => {
    asMember = await signedIn(MEMBER);
    asStaff = await signedIn(STAFF);

    // Staff create through the RPC since 20261103183000 took away direct writes.
    const { data, error } = await asStaff
      .rpc("create_chapter_task", { p_fields: { title: "RLS fixture", workstream: "Contract", status: "backlog" } })
      .single();
    if (error) throw error;
    seededTaskId = data.id;
  });

  it("lets a role-less member READ the chapter board", async () => {
    const { data, error } = await asMember.from("chapter_tasks").select("id,title").limit(5);
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });

  it("refuses INSERT from a role-less member", async () => {
    const { error } = await asMember
      .from("chapter_tasks")
      .insert({ title: "should not exist", workstream: "Contract" });
    expect(error).not.toBeNull();
    expect(error.code).toBe("42501");
  });

  it("refuses UPDATE from a role-less member", async () => {
    const { data, error } = await asMember
      .from("chapter_tasks")
      .update({ title: "hijacked" })
      .eq("id", seededTaskId)
      .select("id");
    // A policy miss is not an error on UPDATE — it matches zero rows. Assert
    // BOTH shapes: a thrown 42501 or an empty result set. Only "one row
    // updated" is a failure.
    expect(error ? error.code === "42501" : data.length === 0).toBe(true);
  });

  it("refuses reassignment from a role-less member", async () => {
    const { data, error } = await asMember
      .from("chapter_tasks")
      .update({ assignee_id: null })
      .eq("id", seededTaskId)
      .select("id");
    expect(error ? error.code === "42501" : data.length === 0).toBe(true);
  });

  it("gives the client no DELETE grant at all", async () => {
    const { error } = await asMember.from("chapter_tasks").delete().eq("id", seededTaskId);
    expect(error).not.toBeNull();
    expect(error.code).toBe("42501");
    const staffDelete = await asStaff.from("chapter_tasks").delete().eq("id", seededTaskId);
    expect(staffDelete.error).not.toBeNull();
  });

  it("refuses the delete RPC to a role-less member and allows it to staff", async () => {
    const denied = await asMember.rpc("soft_delete_chapter_task", { p_task_id: seededTaskId });
    expect(denied.error?.code).toBe("42501");

    const allowed = await asStaff.rpc("soft_delete_chapter_task", { p_task_id: seededTaskId });
    expect(allowed.error).toBeNull();

    // Soft, not hard: the row is hidden from reads, and restorable.
    const afterDelete = await asStaff.from("chapter_tasks").select("id").eq("id", seededTaskId);
    expect(afterDelete.data).toHaveLength(0);

    const restored = await asStaff.rpc("restore_chapter_task", { p_task_id: seededTaskId });
    expect(restored.error).toBeNull();
    const afterRestore = await asStaff.from("chapter_tasks").select("id").eq("id", seededTaskId);
    expect(afterRestore.data).toHaveLength(1);
  });

  it("refuses the report RPC to a role-less member", async () => {
    const { error } = await asMember.rpc("chapter_task_report", { p_from: null, p_to: null });
    expect(error?.code).toBe("42501");
  });

  it("keeps workstreams readable chapter-wide and writable by staff only", async () => {
    const read = await asMember.from("chapter_workstreams").select("name").limit(3);
    expect(read.error).toBeNull();

    const write = await asMember.from("chapter_workstreams").insert({ name: "member-invented" });
    expect(write.error).not.toBeNull();
  });

  it("refuses a task whose workstream is not on the chapter's list", async () => {
    const { error } = await asStaff
      .rpc("create_chapter_task", { p_fields: { title: "bad workstream", workstream: "Not A Real Workstream" } });
    expect(error).not.toBeNull();
    expect(error.code).toBe("22023");
  });

  it("refuses an assignee from another chapter", async () => {
    const outsider = process.env.OTHER_CHAPTER_USER_ID;
    if (!outsider) return;
    const { error } = await asStaff
      .rpc("update_chapter_task_fields", { p_task_id: seededTaskId, p_fields: { assignee_id: outsider } });
    expect(error?.code).toBe("22023");
  });
});

describeIf("chapter_task_dependencies — live behavioural probes", () => {
  let asMember;
  let asStaff;
  let taskA;
  let taskB;

  beforeAll(async () => {
    asMember = await signedIn(MEMBER);
    asStaff = await signedIn(STAFF);
    const created = [];
    for (const title of ["Dependency probe A", "Dependency probe B"]) {
      const { data, error } = await asStaff
        .rpc("create_chapter_task", { p_fields: { title, workstream: "Contract", status: "backlog" } })
        .single();
      if (error) throw error;
      created.push(data.id);
    }
    [taskA, taskB] = created;
  });

  afterAll(async () => {
    if (taskA) await asStaff.rpc("soft_delete_chapter_task", { p_task_id: taskA });
    if (taskB) await asStaff.rpc("soft_delete_chapter_task", { p_task_id: taskB });
  });

  // Staff add and remove edges through their RPCs; the role-less writer
  // below still tries the table directly, which no client role may write.
  const addEdge = (from, to) => asStaff.rpc("add_chapter_task_dependency", { p_task_id: from, p_depends_on_id: to });
  async function clearEdges() {
    const { data } = await asStaff.from("chapter_task_dependencies").select("id").in("task_id", [taskA, taskB]);
    for (const edge of data ?? []) await asStaff.rpc("remove_chapter_task_dependency", { p_dependency_id: edge.id });
  }

  it("refuses a role-less writer", async () => {
    const { error } = await asMember.from("chapter_task_dependencies")
      .insert({ task_id: taskA, depends_on_id: taskB });
    expect(error?.code).toBe("42501");
  });

  it("refuses a cross-chapter endpoint when that fixture is supplied", async () => {
    const outsider = process.env.OTHER_CHAPTER_TASK_ID;
    if (!outsider) return;
    const { error } = await addEdge(taskA, outsider);
    expect(error?.code).toBe("22023");
  });

  it("refuses a duplicate edge", async () => {
    await clearEdges();
    const first = await addEdge(taskA, taskB);
    expect(first.error).toBeNull();
    const duplicate = await addEdge(taskA, taskB);
    expect(duplicate.error?.code).toBe("23505");
    await clearEdges();
  });

  it("refuses a cycle", async () => {
    await clearEdges();
    expect((await addEdge(taskA, taskB)).error).toBeNull();
    const reverse = await addEdge(taskB, taskA);
    expect(reverse.error?.code).toBe("22023");
    await clearEdges();
  });

  it("serializes concurrent reverse inserts so exactly one direction survives", async () => {
    await clearEdges();
    const [forward, reverse] = await Promise.all([
      addEdge(taskA, taskB),
      addEdge(taskB, taskA),
    ]);
    const results = [forward, reverse];
    expect(results.filter((result) => result.error === null)).toHaveLength(1);
    expect(results.filter((result) => result.error?.code === "22023")).toHaveLength(1);
    await clearEdges();
  });
});

describeIf("realtime publication contract", () => {
  // 20260727010153 added chapter_task_messages to supabase_realtime and guarded
  // the publication being INSERT-only. That guard runs once, at migration time.
  // This asserts it is still true, because an UPDATE or DELETE added to the
  // publication would broadcast rows RLS was never asked about at update time.
  it("stays insert-only, with exactly the three expected tables", async () => {
    const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!service) return;
    const admin = createClient(url, service, { auth: { persistSession: false } });
    const { data, error } = await admin.rpc("publication_contract_check");
    expect(error).toBeNull();
    expect(data).toEqual({ insertOnly: true, tables: ["chapter_task_messages", "chapter_thread_posts", "member_notifications"] });
  });
});

// ---------------------------------------------------------------------------
// OFFLINE pins (repo adaptation, not in the package): the assignee-name
// refresh handshake. Everything above needs fixtures; this defect class is
// visible in the migration text and must fail on every commit.
//
// The trap being pinned: private.refresh_task_assignee_names() updates
// chapter_tasks.assignee_name with assignee_id UNCHANGED, and the BEFORE-UPDATE
// prepare trigger's assignee-unchanged branch reverts assignee_name to
// old.assignee_name — so without the sg.refresh_names transaction-local flag
// the refresh is a silent no-op that still churns updated_by / updated_at.
//
// Later migrations re-emit prepare_chapter_task, and production runs the LAST
// emitter in apply order, so the final-emitter pin derives it from the ordered
// migration set rather than naming a filename; the fix introduction keeps its
// own row.
// ---------------------------------------------------------------------------

describe("assignee-name refresh cannot be silently reverted (offline)", () => {
  const maintenanceSql = loadMigrationSql("task_maintenance_rename_and_caps");

  // fnBody cuts from the first declaration-shaped match, so the derived body
  // must begin at a create statement.
  const emitterDeclaration = /create\s+(?:or\s+replace\s+)?function\s+private\.prepare_chapter_task\s*\(/i;
  function finalEmitter() {
    const last = migrationFiles().filter((entry) => emitterDeclaration.test(stripComments(entry.sql))).at(-1);
    if (!last) throw new Error("no migration declares private.prepare_chapter_task");
    const body = fnBody(last.sql, "private.prepare_chapter_task");
    if (!new RegExp(`^${emitterDeclaration.source}`, "i").test(body)) {
      throw new Error(`${last.name}: prepare_chapter_task body does not start at its create statement`);
    }
    return { name: last.name, body: stripComments(body) };
  }

  const squish = (sql) => sql.replace(/\s+/g, " ");

  // The flag branch must be the elsif whose else holds the revert. The middle
  // cannot cross an elsif or end if, so the unrelated revert in the FK-detach
  // branch can neither satisfy nor break the pin.
  const guardedRevert =
    /\belsif\b[^;]*?current_setting\(\s*'sg\.refresh_names'\s*,\s*true\s*\)[^;]*?\bthen\b(?:(?!\belsif\b|\bend\s+if\b)[\s\S])*?\belse\b\s+new\.assignee_name\s*:=\s*old\.assignee_name\s*;/i;

  it("brackets the refresh UPDATE with the transaction-local flag, set then cleared", () => {
    const refresh = stripComments(fnBody(maintenanceSql, "private.refresh_task_assignee_names"));
    const setAt = refresh.indexOf("set_config('sg.refresh_names', '1', true)");
    const updateAt = refresh.indexOf("update public.chapter_tasks");
    const clearAt = refresh.indexOf("set_config('sg.refresh_names', '', true)");
    expect(setAt).toBeGreaterThan(-1);
    expect(updateAt).toBeGreaterThan(setAt);
    expect(clearAt).toBeGreaterThan(updateAt);
    // Live rows only: historical work keeps the name it had.
    expect(refresh).toContain("deleted_at is null");
    expect(refresh).toContain("status <> 'done'");
  });

  it.each([
    ["20260728221340 (fix introduction)", () => stripComments(fnBody(maintenanceSql, "private.prepare_chapter_task"))],
    [`${finalEmitter().name} (final emitter, derived from apply order)`, () => finalEmitter().body],
  ])("%s's prepare_chapter_task honours the flag before the revert branch", (_label, bodyOf) => {
    const body = squish(bodyOf());
    expect(body, "the refresh-flag branch must exist").toMatch(/current_setting\(\s*'sg\.refresh_names'\s*,\s*true\s*\)/i);
    expect(
      body,
      "the direct-write revert must ALSO survive — it is what keeps a client from smuggling a name past the resolver",
    ).toContain("new.assignee_name := old.assignee_name");
    expect(body, "the flag branch must be the elsif guarding that revert's else").toMatch(guardedRevert);
  });
});
