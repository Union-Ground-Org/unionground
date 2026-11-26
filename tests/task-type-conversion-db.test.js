// @vitest-environment node
//
// BUG-UG-TASK-TYPE-CHANGE-OPENS-TEMPLATE-CHOOSER-20261111 (#8211),
// option A: public.convert_chapter_task_to_template turns one live General task
// into a specialized type, checking the template fields exactly as
// public.create_chapter_task_from_template does, under the same staff and
// chapter rules. Specialized types stay fixed, and the type guard opens only
// for this one write.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { latestFnBody, stripComments } from "./helpers/migration.js";

const FILE = readdirSync("supabase/migrations").find((name) => name.endsWith("_convert_chapter_task_to_template.sql"));
const sql = readFileSync(`supabase/migrations/${FILE}`, "utf8");
const code = stripComments(sql);

function validationBlock(source) {
  const start = source.indexOf("  if pg_catalog.jsonb_typeof(coalesce(p_fields, 'null'::jsonb)) <> 'object'");
  const handler = source.indexOf("    when invalid_text_representation or datetime_field_overflow then", start);
  const end = source.indexOf("  end;\n", handler) + "  end;\n".length;
  expect(start).toBeGreaterThan(-1);
  expect(handler).toBeGreaterThan(start);
  return source.slice(start, end);
}

// The reviewer grant lookup inside the validation block: the converter holds
// the reviewer's effective grant. Template creation holds
// it the same way since #8391, so the whole block is compared below.
const REVIEWER_LOOKUP_START = "        locked_reviewer_role := null;\n";
const REVIEWER_LOOKUP_END = "        if locked_reviewer_role is null then\n          raise exception 'reviewer must belong to this chapter'";
function reviewerLookup(block) {
  const start = block.indexOf(REVIEWER_LOOKUP_START);
  const end = block.indexOf(REVIEWER_LOOKUP_END, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return { lookup: block.slice(start, end), rest: block.slice(0, start) + block.slice(end) };
}

describe("task type conversion migration (offline)", () => {
  const functions = parseFunctions(sql);
  const convert = functions.find((fn) => fn.name === "public.convert_chapter_task_to_template").source;
  const guard = functions.find((fn) => fn.name === "private.guard_chapter_task_template_type").source;

  it("is one transaction that takes the case-graph lock before anything else", () => {
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    expect(helperFirst(convert)).toBe(true);
  });

  it("validates the template fields with the very text template creation uses, reviewer lookup included", () => {
    // The live definition of template creation, whichever migration holds it.
    const create = latestFnBody("public.create_chapter_task_from_template");
    expect(validationBlock(stripComments(convert))).toBe(validationBlock(create));
  });

  // Gate round 4 (r4s2): grantMemberRole writes organization grants only, and
  // member_has_role accepts them, so neither the caller nor the reviewer may
  // need a legacy member_roles row.
  it("holds an organization or chapter grant for the caller and the reviewer, and accepts a reviewer as the offered roster does", () => {
    const caller = convert.slice(convert.indexOf("select p.chapter_id into caller_chapter"), convert.indexOf("raise exception 'staff role required' using errcode = '42501';\n  end if;\n\n  -- One live task"));
    expect(caller.indexOf("from public.organization_role_grants org_role")).toBeGreaterThan(-1);
    expect(caller.indexOf("from public.member_role_chapters chapter_role")).toBeGreaterThan(caller.indexOf("for share of org_role"));
    expect(caller.indexOf("from public.member_roles staff_role")).toBeGreaterThan(caller.indexOf("for share of chapter_role"));
    const { lookup } = reviewerLookup(validationBlock(convert));
    expect(lookup).toContain("private.actor_has_chapter_staff_role(reviewer_value, caller_chapter)");
    expect(lookup).toContain("for share of p;");
    for (const held of ["for share of org_role;", "for share of chapter_role;", "for share of reviewer_role;"]) expect(lookup).toContain(held);
  });

  it("converts only a live General task of the caller's chapter, under a held staff grant", () => {
    expect(convert).toContain("private.mfa_satisfied()");
    expect(convert).toContain("member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])");
    expect(convert).toContain("for share of staff_role");
    expect(convert).toMatch(/t\.chapter_id = caller_chapter\s+and t\.deleted_at is null\s+for update of t;/);
    expect(convert).toContain("if target_task.task_type <> 'general'");
    expect(convert).toContain("insert into public.chapter_task_template_details");
    // Not journalled: an undo could only restore General, which the guard refuses.
    expect(convert).not.toContain("learning_task_journal");
  });

  it("opens the type guard for General -> specialized only, and only while the converter holds the flag", () => {
    expect(guard).toContain("if old.task_type = 'general'\n       and pg_catalog.current_setting('sg.converting_template_task', true) = '1' then");
    expect(guard).toContain("specialized task conversion unavailable");
    expect(guard).toContain("specialized tasks require template creation");
    const on = convert.indexOf("set_config('sg.converting_template_task', '1', true)");
    const update = convert.indexOf("update public.chapter_tasks t");
    const off = convert.indexOf("set_config('sg.converting_template_task', '', true)");
    expect(on).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(on);
    expect(off).toBeGreaterThan(update);
  });

  // Gate round 1 (r2s3): filling each missing date on its own could pair a
  // template date with a kept date on the wrong side of it.
  it("fills a missing date only when it stays ordered against the date the task keeps", () => {
    expect(convert).not.toContain("coalesce(t.start_date, task_start)");
    expect(convert).not.toContain("coalesce(t.due_date, task_due)");
    expect(convert).toContain("when t.due_date is null or task_start <= t.due_date then task_start");
    expect(convert).toContain("when t.start_date is null or task_due >= t.start_date then task_due");
  });

  it("grants execute to signed-in users and the service role only", () => {
    expect(code).toContain("revoke all on function public.convert_chapter_task_to_template(uuid, text, jsonb)\n  from public, anon, authenticated;");
    expect(code).toContain("grant execute on function public.convert_chapter_task_to_template(uuid, text, jsonb)\n  to authenticated;");
    expect(code).toContain("revoke all on function private.guard_chapter_task_template_type()\n  from public, anon, authenticated, service_role;");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("task type conversion on a disposable database", () => {
  let c;
  let world;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "task-type-conversion-proof" });
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
      await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'steward',$2)", [org.id, user.id]);
      // "organization steward": the organization grant alone, as grantMemberRole writes it.
      if (role !== "organization steward") await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'steward',$2) on conflict do nothing", [user.id, org.chapter]);
    }
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    return user;
  }
  async function chapter(suffix) {
    const org = { id: randomUUID(), chapter: `type-convert-${suffix}-${randomUUID().slice(0, 8)}` };
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org.id, org.chapter]);
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98317)", [org.chapter, org.id]);
    await c.query("insert into public.chapter_workstreams(chapter_id,name) values ($1,'General') on conflict do nothing", [org.chapter]);
    return org;
  }

  beforeEach(async () => {
    await c.query("begin");
    const org = await chapter("a");
    const otherOrg = await chapter("b");
    world = { org, steward: await person(org, "steward"), member: await person(org, "member"), outsider: await person(otherOrg, "steward"),
      orgSteward: await person(org, "organization steward") };
  });
  afterEach(async () => { await c.query("rollback"); });

  const general = (user, fields) => row("select * from public.create_chapter_task($1::jsonb)", [JSON.stringify({ title: "Planning", ...fields })], user);
  const convert = (user, taskId, key, fields) => call(
    "select public.convert_chapter_task_to_template($1, $2, $3::jsonb) as r", [taskId, key, JSON.stringify(fields)], user);
  const createFromTemplate = (user, key, fields) => call(
    "select public.create_chapter_task_from_template($1, 'Parity', 'General', $2::jsonb) as r", [key, JSON.stringify(fields)], user);
  const task = async (id) => (await c.query("select task_type, title, description, status, priority, workstream, start_date::text, due_date::text from public.chapter_tasks where id = $1", [id])).rows[0];
  const details = async (id) => (await c.query("select template_key, flow_step, scheduled_on::text, venue_mode from public.chapter_task_template_details where task_id = $1", [id])).rows;

  it("changes a General task to a meeting in place, keeping its title, workstream, status and priority", async () => {
    const created = await general(world.steward, { priority: "high" });
    const result = await convert(world.steward, created.id, "meeting_event", { scheduled_on: "2026-12-01", venue_mode: "video", starts_at: "09:00", ends_at: "10:00" });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.rows[0].r.task).toMatchObject({ id: created.id, task_type: "meeting_event" });
    expect(await task(created.id)).toMatchObject({ task_type: "meeting_event", title: "Planning", priority: "high", status: created.status, workstream: "General", start_date: "2026-12-01", due_date: "2026-12-01" });
    expect((await task(created.id)).description).toMatch(/^- \[ \] /);
    expect(await details(created.id)).toEqual([expect.objectContaining({ template_key: "meeting_event", scheduled_on: "2026-12-01", venue_mode: "video" })]);
    const history = (await c.query("select action, from_value, to_value from public.chapter_task_activity where task_id = $1 and action = 'type_changed'", [created.id])).rows;
    expect(history).toEqual([{ action: "type_changed", from_value: "general", to_value: "meeting_event" }]);
  });

  it("keeps a description and dates the task already has", async () => {
    const created = await general(world.steward, { description: "Agenda draft", start_date: "2026-11-20", due_date: "2026-11-30" });
    expect(await convert(world.steward, created.id, "meeting_event", { scheduled_on: "2026-12-01", venue_mode: "phone" })).toMatchObject({ ok: true });
    expect(await task(created.id)).toMatchObject({ description: "Agenda draft", start_date: "2026-11-20", due_date: "2026-11-30" });
  });

  it("leaves a template date out rather than order it against a kept date the wrong way", async () => {
    const dueEarlier = await general(world.steward, { due_date: "2026-11-30" });
    expect(await convert(world.steward, dueEarlier.id, "meeting_event", { scheduled_on: "2026-12-01", venue_mode: "video" })).toMatchObject({ ok: true });
    expect(await task(dueEarlier.id)).toMatchObject({ task_type: "meeting_event", start_date: null, due_date: "2026-11-30" });
    expect(await details(dueEarlier.id)).toEqual([expect.objectContaining({ scheduled_on: "2026-12-01" })]);

    const startLater = await general(world.steward, { start_date: "2026-12-10" });
    expect(await convert(world.steward, startLater.id, "member_follow_up", { contact_method: "email", follow_up_on: "2026-12-05" })).toMatchObject({ ok: true });
    expect(await task(startLater.id)).toMatchObject({ task_type: "member_follow_up", start_date: "2026-12-10", due_date: null });

    const dueLater = await general(world.steward, { due_date: "2026-12-05" });
    expect(await convert(world.steward, dueLater.id, "meeting_event", { scheduled_on: "2026-12-01", venue_mode: "video" })).toMatchObject({ ok: true });
    expect(await task(dueLater.id)).toMatchObject({ start_date: "2026-12-01", due_date: "2026-12-05" });
  });

  it("accepts and refuses the same field payloads as template creation", async () => {
    const cases = [
      ["meeting_event", { scheduled_on: "2026-12-01", venue_mode: "video" }, true],
      ["meeting_event", { scheduled_on: "12/01/2026", venue_mode: "video" }, false],
      ["meeting_event", { scheduled_on: "2026-12-01", venue_mode: "carrier pigeon" }, false],
      ["meeting_event", { scheduled_on: "2026-12-01", venue_mode: "video", starts_at: "10:00", ends_at: "09:00" }, false],
      ["meeting_event", { venue_mode: "video" }, false],
      ["issue_incident", { occurred_on: "2026-11-02", incident_severity: "high" }, true],
      ["issue_incident", { occurred_on: "2026-11-02", incident_severity: "severe" }, false],
      ["document_request", { record_category: "policy", record_source: "employer" }, true],
      ["document_request", { record_category: "policy", record_source: "employer", member_name: "x" }, false],
      ["member_follow_up", { contact_method: "email", follow_up_on: "2026-12-05" }, true],
      ["review_approval", { review_kind: "decision" }, true],
      ["review_approval", { review_kind: "decision", reviewer_id: randomUUID() }, false],
    ];
    for (const [key, fields, accepted] of cases) {
      const created = await general(world.steward);
      const viaConvert = await convert(world.steward, created.id, key, fields);
      const viaCreate = await createFromTemplate(world.steward, key, fields);
      expect(viaConvert.ok, `${key} ${JSON.stringify(fields)} convert`).toBe(accepted);
      expect(viaCreate.ok, `${key} ${JSON.stringify(fields)} create`).toBe(accepted);
      if (!accepted) expect(viaConvert.message).toBe(viaCreate.message);
      if (!accepted) expect(await task(created.id)).toMatchObject({ task_type: "general" });
    }
  });

  it("lets staff with an organization grant alone convert, and name such staff as reviewer, but never a member or an outsider", async () => {
    expect(await c.query("select 1 from public.member_roles where user_id = $1", [world.orgSteward.id])).toMatchObject({ rowCount: 0 });
    const own = await general(world.steward);
    expect(await convert(world.orgSteward, own.id, "meeting_event", { scheduled_on: "2026-12-01", venue_mode: "video" })).toMatchObject({ ok: true });
    const reviewed = await general(world.steward);
    expect(await convert(world.steward, reviewed.id, "review_approval", { review_kind: "document", reviewer_id: world.orgSteward.id })).toMatchObject({ ok: true });
    expect((await c.query("select reviewer_id from public.chapter_task_template_details where task_id = $1", [reviewed.id])).rows).toEqual([{ reviewer_id: world.orgSteward.id }]);
    for (const reviewer of [world.member, world.outsider]) {
      const refused = await general(world.steward);
      expect(await convert(world.orgSteward, refused.id, "review_approval", { review_kind: "document", reviewer_id: reviewer.id }))
        .toMatchObject({ ok: false, message: "reviewer must belong to this chapter" });
      expect(await task(refused.id)).toMatchObject({ task_type: "general" });
    }
  });

  it("refuses a member, another chapter's staff, a deleted task, an unknown template and a task that is already specialized", async () => {
    const created = await general(world.steward);
    const fields = { scheduled_on: "2026-12-01", venue_mode: "video" };
    expect(await convert(world.member, created.id, "meeting_event", fields)).toMatchObject({ ok: false, code: "42501" });
    expect(await convert(world.outsider, created.id, "meeting_event", fields)).toMatchObject({ ok: false, message: "task unavailable" });
    expect(await convert(null, created.id, "meeting_event", fields)).toMatchObject({ ok: false });
    expect(await convert(world.steward, created.id, "no_such_template", fields)).toMatchObject({ ok: false, message: "template unavailable" });
    expect(await convert(world.steward, created.id, "meeting_event", fields)).toMatchObject({ ok: true });
    expect(await convert(world.steward, created.id, "issue_incident", { occurred_on: "2026-11-02", incident_severity: "high" }))
      .toMatchObject({ ok: false, message: "specialized task conversion unavailable" });
    const removed = await general(world.steward);
    await c.query("update public.chapter_tasks set deleted_at = now() where id = $1", [removed.id]);
    expect(await convert(world.steward, removed.id, "meeting_event", fields)).toMatchObject({ ok: false, message: "task unavailable" });
    expect(await task(created.id)).toMatchObject({ task_type: "meeting_event" });
  });

  it("leaves the guard closed for every other type write, including later in the same transaction", async () => {
    const converted = await general(world.steward);
    const untouched = await general(world.steward);
    expect(await convert(world.steward, converted.id, "meeting_event", { scheduled_on: "2026-12-01", venue_mode: "video" })).toMatchObject({ ok: true });
    async function directTypeWrite(id, type) {
      await c.query("savepoint direct");
      try {
        await c.query("update public.chapter_tasks set task_type = $2 where id = $1", [id, type]);
        await c.query("release savepoint direct");
        return null;
      } catch (error) {
        await c.query("rollback to savepoint direct");
        return error.message;
      }
    }
    expect(await directTypeWrite(untouched.id, "issue_incident")).toBe("specialized task conversion unavailable");
    expect(await directTypeWrite(converted.id, "general")).toBe("specialized task conversion unavailable");
  });
});
