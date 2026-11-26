// @vitest-environment node
//
// BUG-UG-TEMPLATE-TASK-CREATION-REFUSES-ORGANIZATION-GRANT-STAFF-20261111
// (#8391), with a review note. Creating a task from a template, and
// editing a template task's fields, held the caller's and the reviewer's staff
// grant from legacy member_roles rows only. Role grants are written as
// organization grants now, so a steward granted that way passed the staff
// check and was then refused, and could not be named as reviewer although the
// reviewer roster offers them. Both functions now hold the effective grant the
// way the task-to-template converter (#8306) does.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { stripComments } from "./helpers/migration.js";

const FILE = readdirSync("supabase/migrations").find((name) => name.endsWith("_template_tasks_hold_organization_grant_staff.sql"));
const sql = readFileSync(`supabase/migrations/${FILE}`, "utf8");
const code = stripComments(sql);
const PREVIOUS = "20261103183000_learning_period_tasks.sql";
const previousSql = readFileSync(`supabase/migrations/${PREVIOUS}`, "utf8");
const CREATE = "public.create_chapter_task_from_template";
const UPDATE = "public.update_chapter_task_template_details";
const STAFF = "array['steward', 'coordinator', 'advisor', 'admin', 'vp']";

// The caller's grant lookup: from the profile hold (create) or the task lock
// (update) to the staff refusal.
function callerLookup(source) {
  const start = source.indexOf("  select org_role.role into locked_caller_role");
  const end = source.indexOf("raise exception 'staff role required'", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}
// The reviewer's grant lookup, from the reset to the refusal.
function reviewerLookup(source) {
  const start = source.indexOf("        locked_reviewer_role := null;\n");
  const end = source.indexOf("raise exception 'reviewer must belong to this chapter'", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("template task staff grant migration (offline)", () => {
  const functions = parseFunctions(sql);
  const fn = (name) => functions.find((entry) => entry.name === name).source;
  const previous = parseFunctions(previousSql);
  const before = (name) => previous.find((entry) => entry.name === name).source;

  it("is one transaction that redefines only the two template task writers, each taking the case-graph lock first", () => {
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    expect(functions.map((entry) => entry.name).sort()).toEqual([CREATE, UPDATE]);
    for (const name of [CREATE, UPDATE]) expect(helperFirst(fn(name)), name).toBe(true);
    expect(FILE > PREVIOUS).toBe(true);
  });

  it("holds the caller's organization grant, then a chapter grant, then a legacy row, each for share", () => {
    for (const name of [CREATE, UPDATE]) {
      const lookup = callerLookup(fn(name));
      const org = lookup.indexOf("from public.organization_role_grants org_role");
      const chapter = lookup.indexOf("from public.member_role_chapters chapter_role");
      const legacy = lookup.indexOf("from public.member_roles staff_role");
      expect(org, name).toBeGreaterThan(-1);
      expect(chapter, name).toBeGreaterThan(lookup.indexOf("for share of org_role;"));
      expect(legacy, name).toBeGreaterThan(lookup.indexOf("for share of chapter_role;"));
      expect(lookup, name).toContain("for share of staff_role;");
      expect(lookup, name).toContain(`org_role.role = any(${STAFF})`);
    }
    // The policy check still runs first in both.
    for (const name of [CREATE, UPDATE]) expect(fn(name), name).toContain(`member_has_role(${STAFF})`);
  });

  it("accepts a reviewer exactly as the roster offers one, with one rule in both writers", () => {
    const create = reviewerLookup(fn(CREATE));
    expect(create).toContain("private.actor_has_chapter_staff_role(reviewer_value, caller_chapter)");
    for (const held of ["for share of p;", "for share of org_role;", "for share of chapter_role;", "for share of reviewer_role;"]) expect(create).toContain(held);
    // The updater lets a null reviewer clear the field; the eligibility rule
    // inside is the same text, two columns deeper.
    const update = reviewerLookup(fn(UPDATE));
    const shift = (text) => text.split("\n").map((line) => (line ? `  ${line}` : line)).join("\n");
    const rule = create.slice(create.indexOf("        -- The reviewer is eligible"), create.lastIndexOf("        end if;") + "        end if;\n".length);
    expect(update).toContain(shift(rule));
    expect(update).toContain("if reviewer_value is not null then");
  });

  it("changes nothing else in either body", () => {
    // Cut each grant lookup (caller, then reviewer) out of the new and the
    // previous body; what is left must be the same code.
    const cut = (source, start, end) => {
      const from = source.indexOf(start);
      const to = source.indexOf(end, from);
      expect(from).toBeGreaterThan(-1);
      expect(to).toBeGreaterThan(from);
      return source.slice(0, from) + source.slice(to);
    };
    const rest = (source, callerStart) => {
      const withoutCaller = cut(source, callerStart, "raise exception 'staff role required'");
      const withoutReviewer = cut(withoutCaller, "        locked_reviewer_role := null;\n", "raise exception 'reviewer must belong to this chapter'");
      return stripComments(withoutReviewer).replace(/\s+/g, " ");
    };
    for (const name of [CREATE, UPDATE]) {
      expect(rest(fn(name), "  select org_role.role into locked_caller_role"), name)
        .toBe(rest(before(name), "  select staff_role.role into locked_caller_role"));
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("template task staff grants on a disposable database", () => {
  let c;
  let world;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "template-task-grant-proof" });
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

  // kind: "member", "organization steward" (the organization grant alone, as
  // role grants are written now), "chapter steward" (a chapter grant, which
  // rests on its member_roles row) or "legacy steward" (a chapter-wide legacy
  // member_roles row in a chapter with no organization).
  //
  // New ownerless chapters and ownerless role rows are refused by triggers, so
  // the legacy fixture is written the way such rows exist today: as rows that
  // predate those triggers (replica mode, this disposable database only).
  const asExistingRow = async (text, values) => {
    await c.query("set local session_replication_role = replica");
    try { await c.query(text, values); } finally { await c.query("set local session_replication_role = origin"); }
  };
  async function person(org, kind) {
    const user = { id: randomUUID(), session: randomUUID() };
    await c.query("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
    if (org.id) await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org.id, user.id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, org.chapter]);
    await c.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user.id, org.chapter, `Proof ${kind}`]);
    if (kind === "organization steward") {
      await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'steward',$2)", [org.id, user.id]);
    }
    if (kind === "chapter steward") {
      await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'steward',$2)", [user.id, org.chapter]);
      await c.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'steward',$2)", [user.id, org.chapter]);
    }
    if (kind === "legacy steward") {
      await asExistingRow("insert into public.member_roles(user_id,role,chapter_id) values ($1,'steward',null)", [user.id]);
    }
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    return user;
  }
  async function chapter(suffix, { organization = true } = {}) {
    const org = { id: organization ? randomUUID() : null, chapter: `template-grant-${suffix}-${randomUUID().slice(0, 8)}` };
    if (organization) await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org.id, org.chapter]);
    const insertChapter = ["insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98318)", [org.chapter, org.id]];
    if (organization) await c.query(...insertChapter);
    else await asExistingRow(...insertChapter);
    await c.query("insert into public.chapter_workstreams(chapter_id,name) values ($1,'General') on conflict do nothing", [org.chapter]);
    return org;
  }

  beforeEach(async () => {
    await c.query("begin");
    const org = await chapter("a");
    const otherOrg = await chapter("b");
    const legacyChapter = await chapter("legacy", { organization: false });
    world = {
      org,
      orgSteward: await person(org, "organization steward"),
      secondOrgSteward: await person(org, "organization steward"),
      chapterSteward: await person(org, "chapter steward"),
      legacySteward: await person(legacyChapter, "legacy steward"),
      member: await person(org, "member"),
      outsider: await person(otherOrg, "organization steward"),
    };
  });
  afterEach(async () => { await c.query("rollback"); });

  const FIELDS = {
    meeting_event: { scheduled_on: "2026-12-01", venue_mode: "video" },
    review_approval: { review_kind: "document" },
    member_follow_up: { contact_method: "email", follow_up_on: "2026-12-05" },
    document_request: { record_category: "policy", record_source: "employer" },
    issue_incident: { occurred_on: "2026-11-02", incident_severity: "high" },
  };
  const create = (user, key, fields) => call(
    `select ${CREATE}($1, 'Grant proof', 'General', $2::jsonb) as r`, [key, JSON.stringify(fields)], user);
  const update = (user, taskId, fields) => call(
    `select ${UPDATE}($1, $2::jsonb, null, false) as r`, [taskId, JSON.stringify(fields)], user);
  const hasRole = async (user) => (await call(`select public.member_has_role(${STAFF}) as ok`, [], user)).rows?.[0]?.ok;
  const reviewerOf = async (taskId) => (await c.query("select reviewer_id from public.chapter_task_template_details where task_id = $1", [taskId])).rows[0]?.reviewer_id;

  it("lets staff whose only grant is an organization grant create a task from every template", async () => {
    expect((await c.query("select 1 from public.member_roles where user_id = $1", [world.orgSteward.id])).rowCount).toBe(0);
    expect((await c.query("select 1 from public.member_role_chapters where user_id = $1", [world.orgSteward.id])).rowCount).toBe(0);
    expect(await hasRole(world.orgSteward)).toBe(true);
    const keys = (await c.query("select template_key from private.chapter_task_template_catalog where active order by template_key")).rows.map((entry) => entry.template_key);
    expect(keys.sort()).toEqual(Object.keys(FIELDS).sort());
    for (const key of keys) {
      const result = await create(world.orgSteward, key, FIELDS[key]);
      expect(result, `${key} ${JSON.stringify(result)}`).toMatchObject({ ok: true });
      expect(result.rows[0].r.task, key).toMatchObject({ task_type: key });
    }
  });

  it("names staff with an organization grant alone as reviewer, on creation and on a later edit", async () => {
    const created = await create(world.orgSteward, "review_approval", { review_kind: "decision", reviewer_id: world.secondOrgSteward.id });
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    const taskId = created.rows[0].r.task.id;
    expect(await reviewerOf(taskId)).toBe(world.secondOrgSteward.id);
    // The edit path accepts the same reviewer the create path does.
    const blank = await create(world.orgSteward, "review_approval", { review_kind: "decision" });
    const blankId = blank.rows[0].r.task.id;
    expect(await update(world.orgSteward, blankId, { reviewer_id: world.secondOrgSteward.id })).toMatchObject({ ok: true });
    expect(await reviewerOf(blankId)).toBe(world.secondOrgSteward.id);
    expect(await update(world.orgSteward, blankId, { reviewer_id: null })).toMatchObject({ ok: true });
    expect(await reviewerOf(blankId)).toBeNull();
  });

  it("offers and accepts the same reviewers: never a member or another chapter's staff", async () => {
    const offered = await call("select public.list_chapter_task_template_reviewers() as r", [], world.orgSteward);
    expect(offered, JSON.stringify(offered)).toMatchObject({ ok: true });
    const ids = offered.rows[0].r.map((entry) => entry.id);
    expect(ids).toContain(world.secondOrgSteward.id);
    expect(ids).not.toContain(world.member.id);
    expect(ids).not.toContain(world.outsider.id);
    const blank = await create(world.orgSteward, "review_approval", { review_kind: "decision" });
    const blankId = blank.rows[0].r.task.id;
    for (const reviewer of [world.member, world.outsider]) {
      expect(await create(world.orgSteward, "review_approval", { review_kind: "decision", reviewer_id: reviewer.id }))
        .toMatchObject({ ok: false, code: "22023", message: "reviewer must belong to this chapter" });
      expect(await update(world.orgSteward, blankId, { reviewer_id: reviewer.id }))
        .toMatchObject({ ok: false, code: "22023", message: "reviewer must belong to this chapter" });
    }
    expect(await reviewerOf(blankId)).toBeNull();
  });

  it("still refuses a member and another chapter's staff as the caller", async () => {
    expect(await create(world.member, "meeting_event", FIELDS.meeting_event)).toMatchObject({ ok: false, code: "42501" });
    const created = await create(world.orgSteward, "meeting_event", FIELDS.meeting_event);
    const taskId = created.rows[0].r.task.id;
    expect(await update(world.member, taskId, { venue_mode: "phone" })).toMatchObject({ ok: false, code: "42501" });
    expect(await update(world.outsider, taskId, { venue_mode: "phone" })).toMatchObject({ ok: false, message: "task unavailable" });
    expect(await update(world.orgSteward, taskId, { venue_mode: "phone" })).toMatchObject({ ok: true });
  });

  it("still accepts a chapter-grant steward as caller and as reviewer", async () => {
    expect(await hasRole(world.chapterSteward)).toBe(true);
    const created = await create(world.chapterSteward, "review_approval", { review_kind: "document", reviewer_id: world.orgSteward.id });
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    const named = await create(world.orgSteward, "review_approval", { review_kind: "document", reviewer_id: world.chapterSteward.id });
    expect(named, JSON.stringify(named)).toMatchObject({ ok: true });
  });

  it("still accepts a legacy member_roles steward where the staff check accepts them, on creation and on an edit", async () => {
    expect((await c.query("select 1 from public.organization_role_grants where user_id = $1", [world.legacySteward.id])).rowCount).toBe(0);
    expect(await hasRole(world.legacySteward)).toBe(true);
    const result = await create(world.legacySteward, "review_approval", { review_kind: "document" });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const taskId = result.rows[0].r.task.id;
    expect(await update(world.legacySteward, taskId, { review_kind: "decision" })).toMatchObject({ ok: true });
  });
});

// On committed rows: a revoke of the caller's organization grant that is
// under way still serializes the template write. The write waits, and once
// the revoke commits it is refused and leaves nothing behind. (The revoke's
// own triggers take the account case-graph lock as well, so this guards the
// race as a whole rather than the row hold alone; the hold is pinned above.)
live("template task staff grant races on a disposable database", () => {
  const clients = {};
  const org = { id: randomUUID(), chapter: `template-grant-race-${randomUUID().slice(0, 8)}` };
  const steward = { id: randomUUID(), session: randomUUID() };
  const title = `Grant race proof ${org.chapter}`;

  async function cleanup() {
    const admin = clients.admin;
    await admin.query("delete from public.chapter_tasks where chapter_id = $1", [org.chapter]);
    await admin.query("delete from public.organization_role_grants where user_id = $1", [steward.id]);
    await admin.query("delete from public.dues_member_subjects where organization_id = $1", [org.id]);
    await admin.query("delete from public.organization_memberships where organization_id = $1", [org.id]);
    await admin.query("delete from public.member_chapter_memberships where chapter_id = $1", [org.chapter]);
    await admin.query("delete from auth.users where id = $1", [steward.id]);
    await admin.query("delete from public.chapter_workstreams where chapter_id = $1", [org.chapter]);
    await admin.query("delete from public.chapters where id = $1", [org.chapter]);
    await admin.query("delete from public.organizations where id = $1", [org.id]);
  }

  beforeAll(async () => {
    const url = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    for (const name of ["admin", "actor", "blocker"]) {
      clients[name] = new pg.Client({ connectionString: url, application_name: `template-grant-race-${name}` });
      await clients[name].connect();
    }
    const admin = clients.admin;
    await admin.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org.id, org.chapter]);
    await admin.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98319)", [org.chapter, org.id]);
    await admin.query("insert into public.chapter_workstreams(chapter_id,name) values ($1,'General') on conflict do nothing", [org.chapter]);
    await admin.query("insert into auth.users(id,email) values ($1,$2)", [steward.id, `${steward.id}@example.invalid`]);
    await admin.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org.id, steward.id]);
    await admin.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [steward.id, org.chapter]);
    await admin.query("update public.member_profiles set chapter_id=$2, full_name='Proof race steward' where id=$1", [steward.id, org.chapter]);
    // A committed steward grant needs a unit in every chapter (#7663), so this
    // race, which only needs a staff grant held at the organization, uses Coordinator.
    await admin.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'coordinator',$2)", [org.id, steward.id]);
    await admin.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), steward.id]);
    await admin.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [steward.session, steward.id]);
  });
  afterAll(async () => {
    for (const name of ["actor", "blocker"]) await clients[name]?.query("rollback").catch(() => {});
    if (clients.admin) await cleanup();
    await Promise.all(Object.values(clients).map((client) => client.end()));
  });

  it("serializes the write behind a revoke under way, then refuses it once the revoke commits", async () => {
    const { actor, admin, blocker } = clients;
    await blocker.query("begin");
    await blocker.query("delete from public.organization_role_grants where user_id = $1", [steward.id]);

    await actor.query("begin");
    await actor.query("set local statement_timeout = '10s'");
    await actor.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: steward.id, session_id: steward.session, aal: "aal2" })]);
    await actor.query("set local role authenticated");
    const write = actor.query(
      "select public.create_chapter_task_from_template('meeting_event', $1, 'General', $2::jsonb) as r",
      [title, JSON.stringify({ scheduled_on: "2026-12-01", venue_mode: "video" })],
    ).then((result) => ({ ok: true, result }), (error) => ({ ok: false, code: error.code, message: error.message }));

    // The write reaches the held grant row and waits on the revoke's row lock.
    let waiting = false;
    for (let tries = 0; tries < 150 && !waiting; tries += 1) {
      const row = (await admin.query("select wait_event_type from pg_catalog.pg_stat_activity where pid = $1", [actor.processID])).rows[0];
      waiting = row?.wait_event_type === "Lock";
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await blocker.query("commit");
    const outcome = await write;
    await actor.query("rollback");
    expect(waiting, "the template write never waited on the caller's organization grant").toBe(true);
    expect(outcome).toMatchObject({ ok: false, code: "42501", message: "staff role required" });
    expect((await admin.query("select 1 from public.chapter_tasks where title = $1", [title])).rowCount).toBe(0);
  });
});
