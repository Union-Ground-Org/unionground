// @vitest-environment node
// #7087: fixed-clock proofs of the installed sweeps, with every DDL and data
// change rolled back. No production clock override or new callable is added.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody } from "./helpers/migration.js";

const FILE = "20261105191200_deadline_notice_clock_reconciliation.sql";
const migration = readFileSync(`supabase/migrations/${FILE}`, "utf8");
// Replay inside the proof transaction, so the migration's transaction envelope
// cannot commit synthetic fixtures or the clock-instrumented functions.
const replay = migration.replace(/^begin;$/m, "").replace(/^commit;$/m, "")
  .replace("(pg_catalog.clock_timestamp() at time zone 'America/New_York')::date", "date '2026-11-10'");

describe("deadline sweep Eastern migration", () => {
  it("sorts after the migration stamp it was written against", () => {
    expect(findMigrationName("deadline_sweep_eastern_day") > "20261104123000_learning_period_case_workflow.sql").toBe(true);
    expect(FILE > "20261105191000_case_article_write_intent_and_audit_scope.sql").toBe(true);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("deadline sweeps on fixed Eastern dates", () => {
  let db;
  let world;
  let definitions;
  const q = (text, values = []) => db.query(text, values);

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "deadline-eastern-proof" });
    await db.connect();
    definitions = (await q(`select pg_get_functiondef(signature::regprocedure) definition
      from unnest(array['private.case_deadline_notice_sweep()', 'private.staff_deadline_notice_sweep()']) signature`)).rows.map((row) => row.definition);
  });
  afterAll(async () => { await db?.end(); });

  async function person(staff = false) {
    const id = randomUUID();
    const session = randomUUID();
    await q("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await q("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, id]);
    world.sessions.set(id, session);
    await q("update public.member_profiles set chapter_id=$2,language='en' where id=$1", [id, world.chapter]);
    await q("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, world.chapter]);
    await q("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [world.org, id]);
    if (staff) {
      await q("insert into public.member_roles(user_id,role,chapter_id) values ($1,'steward',$2)", [id, world.chapter]);
      await q("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'steward',$2)", [id, world.chapter]);
      await q("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'steward',$2)", [world.org, id]);
      await q("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    }
    return id;
  }

  beforeEach(async () => {
    await q("begin");
    await q("set local timezone = 'UTC'");
    await q("set local statement_timeout = '60s'");
    world = { org: randomUUID(), chapter: `eastern-${randomUUID()}`, sessions: new Map() };
    await q("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [world.org, world.chapter]);
    await q("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,987087)", [world.chapter, world.org]);
    world.member = await person();
    world.steward = await person(true);
  });
  afterEach(async () => { await q("rollback"); });

  // Only clock primitives change; the installed selection, timezone conversion,
  // stamps, notifications and staff calls execute unchanged. CURRENT_DATE is
  // instrumented too so the same proof fails against the old UTC-session body.
  async function clock(instant, bodies = definitions) {
    const literal = (await q("select quote_literal($1::timestamptz) literal", [instant])).rows[0].literal + "::timestamptz";
    for (const definition of bodies) {
      const fixed = definition.replace(/\b(?:pg_catalog\.)?now\(\)/gi, `(${literal})`)
        .replace(/\bcurrent_date\b/gi, `((${literal}) at time zone current_setting('TimeZone'))::date`);
      await q(fixed);
    }
  }

  async function caseRow(dueOn, assigned = false) {
    const id = randomUUID();
    await q(`insert into public.member_cases(id,user_id,reference,title,case_type,step,deadline,steward_user_id)
      values ($1,$2,$3,'Fictional schedule question','Other','Intake',$4::date,$5)`,
    [id, world.member, `E-${id.slice(0, 8)}`, dueOn, assigned ? world.steward : null]);
    return id;
  }

  async function deadline(caseId, dueAt) {
    const id = randomUUID();
    await q(`insert into public.casework_deadlines(id,case_id,organization_id,chapter_id,kind,label,due_at,created_by)
      values ($1,$2,$3,$4,'response','Fictional response',$5::timestamptz,$6)`,
    [id, caseId, world.org, world.chapter, dueAt, world.steward]);
    return id;
  }
  const notices = async (who) => (await q("select title,body from public.member_notifications where user_id=$1 and kind='deadlines' order by created_at,id", [who])).rows;

  async function hasEasternMarker() {
    return (await q("select exists(select 1 from pg_attribute where attrelid='private.staff_deadline_notice_marks'::regclass and attname='eastern_day' and not attisdropped) present")).rows[0].present;
  }

  async function legacyMark(id, dueOn, stage) {
    const marked = await hasEasternMarker();
    await q(`insert into private.staff_deadline_notice_marks(source,deadline_id,due_on,stage,clock_reconciled${marked ? ",eastern_day" : ""})
      values ('casework_deadline',$1,$2::date,$3,false${marked ? ",false" : ""})`, [id, dueOn, stage]);
  }

  async function extend(id, dueAt) {
    await q("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: world.steward, role: "authenticated", aal: "aal2", session_id: world.sessions.get(world.steward) })]);
    await q("set local role authenticated");
    const extension = (await q("select (public.casework_request_deadline_extension($1,$2::timestamptz,'Fictional extension request',$3)).id", [id, dueAt, randomUUID()])).rows[0].id;
    await q("select public.casework_decide_deadline_extension($1,'approved',null)", [extension]);
    await q("reset role");
    await q("select set_config('request.jwt.claims','',true)");
  }

  it("installs wall-clock stamps and marks future writes as reconciled", async () => {
    const id = await deadline(await caseRow(null, true), "2026-11-10T22:00:00-05:00");
    const row = (await q(`insert into private.staff_deadline_notice_marks(source,deadline_id,due_on,stage)
      values ('casework_deadline',$1,'2026-11-10',3)
      returning marked_at > transaction_timestamp() as wall_clock, eastern_day, clock_reconciled`, [id])).rows[0];
    expect(row).toEqual({ wall_clock: true, eastern_day: true, clock_reconciled: true });
  });

  for (const extendedDueAt of ["2026-11-11T22:00:00-05:00", "2026-11-11T01:00:00-05:00"]) {
    it(`announces a pre-migration extension to ${extendedDueAt} exactly once on the new Eastern due day`, async () => {
      const caseId = await caseRow(null, true);
      const id = await deadline(caseId, "2026-11-10T22:00:00-05:00");
      // Recreate the deployed, pre-conversion writer and its row trigger. The
      // optional marker is fixture metadata only; legacy writers did not set it.
      if (await hasEasternMarker()) await q("alter table private.staff_deadline_notice_marks alter column eastern_day set default false");
      await q("alter table private.staff_deadline_notice_marks alter column clock_reconciled set default false");
      await q(fnBody(readFileSync("supabase/migrations/20260917143000_casework_case_history.sql", "utf8"), "private.capture_casework_record_version").replace("create function", "create or replace function"));
      const oldStaff = fnBody(readFileSync("supabase/migrations/20261002135600_restore_review_hotfixes.sql", "utf8"), "private.staff_deadline_notice_sweep");
      await clock("2026-11-10T20:30:00-05:00", [oldStaff]);
      await q("select private.staff_deadline_notice_sweep()");
      expect(await notices(world.steward)).toHaveLength(1);
      expect((await q("select due_on::text,stage from private.staff_deadline_notice_marks where deadline_id=$1", [id])).rows).toEqual([{ due_on: "2026-11-11", stage: 3 }]);
      // The fixed sweep clock also instruments marked_at. Restore the actual
      // transaction time so it can be compared with the history trigger's
      // clock_timestamp() when the extension is approved next.
      await q("update private.staff_deadline_notice_marks set marked_at=transaction_timestamp() where deadline_id=$1", [id]);
      await extend(id, extendedDueAt);
      await q(replay);
      await clock("2026-11-11T09:00:00-05:00");
      await q("select private.case_deadline_notice_sweep()");
      expect(await notices(world.steward)).toHaveLength(2);
      expect((await notices(world.steward)).map((n) => n.title)).toEqual(["Assigned case deadline today", "Assigned case deadline today"]);
      await q("select private.case_deadline_notice_sweep()");
      expect(await notices(world.steward)).toHaveLength(2);
      expect((await q("select due_on::text,stage from private.staff_deadline_notice_marks where deadline_id=$1", [id])).rows).toEqual([{ due_on: "2026-11-11", stage: 3 }]);
    });
  }

  it("preserves a current legacy mark written after the latest Eastern day change", async () => {
    const id = await deadline(await caseRow(null, true), "2026-11-10T22:00:00-05:00");
    await extend(id, "2026-11-11T01:00:00-05:00");
    await legacyMark(id, "2026-11-11", 3);
    // A later sweep transaction starts after the extension's recorded change.
    await q("update private.staff_deadline_notice_marks set marked_at=clock_timestamp() where deadline_id=$1", [id]);
    await q(replay);
    await clock("2026-11-11T09:00:00-05:00");
    await q("select private.staff_deadline_notice_sweep()");
    expect(await notices(world.steward)).toEqual([]);
    expect((await q("select due_on::text,stage from private.staff_deadline_notice_marks where deadline_id=$1", [id])).rows).toEqual([{ due_on: "2026-11-11", stage: 3 }]);
  });

  it("retires a live extension's old marks and announces the new day once", async () => {
    const id = await deadline(await caseRow(null, true), "2026-11-10T22:00:00-05:00");
    await clock("2026-11-10T09:00:00-05:00");
    await q("select private.case_deadline_notice_sweep()");
    expect(await notices(world.steward)).toHaveLength(1);
    await extend(id, "2026-11-11T22:00:00-05:00");
    expect((await q("select due_on from private.staff_deadline_notice_marks where deadline_id=$1", [id])).rows).toEqual([]);
    await clock("2026-11-11T09:00:00-05:00");
    await q("select private.case_deadline_notice_sweep()");
    await q("select private.case_deadline_notice_sweep()");
    expect(await notices(world.steward)).toHaveLength(2);
    const before = (await q("select * from private.staff_deadline_notice_marks where deadline_id=$1", [id])).rows;
    await q(replay);
    expect((await q("select * from private.staff_deadline_notice_marks where deadline_id=$1", [id])).rows).toEqual(before);
  });

  it("retires direct due-day mutations while same-day timestamp edits keep their mark", async () => {
    const id = await deadline(await caseRow(null, true), "2026-11-10T22:00:00-05:00");
    await clock("2026-11-10T09:00:00-05:00");
    await q("select private.staff_deadline_notice_sweep()");
    const before = (await q("select * from private.staff_deadline_notice_marks where deadline_id=$1", [id])).rows;
    await q("update public.casework_deadlines set due_at='2026-11-10T23:00:00-05:00' where id=$1", [id]);
    await q("select private.staff_deadline_notice_sweep()");
    expect((await q("select * from private.staff_deadline_notice_marks where deadline_id=$1", [id])).rows).toEqual(before);
    expect(await notices(world.steward)).toHaveLength(1);
    await q("update public.casework_deadlines set due_at='2026-11-11T22:00:00-05:00' where id=$1", [id]);
    expect((await q("select due_on from private.staff_deadline_notice_marks where deadline_id=$1", [id])).rows).toEqual([]);
    await clock("2026-11-11T09:00:00-05:00");
    await q("select private.staff_deadline_notice_sweep()");
    await q("select private.staff_deadline_notice_sweep()");
    expect(await notices(world.steward)).toHaveLength(2);
  });

  it("resets both member stamps and staff marks when the member's calendar deadline changes", async () => {
    const id = await caseRow("2026-11-10", true);
    await clock("2026-11-10T09:00:00-05:00");
    await q("select private.case_deadline_notice_sweep()");
    await q("update public.member_cases set deadline='2026-11-11' where id=$1", [id]);
    expect((await q("select deadline_notice_1_sent_at,deadline_notice_3_sent_at,deadline_notice_7_sent_at from public.member_cases where id=$1", [id])).rows).toEqual([{ deadline_notice_1_sent_at: null, deadline_notice_3_sent_at: null, deadline_notice_7_sent_at: null }]);
    expect((await q("select due_on from private.staff_deadline_notice_marks where source='member_case' and deadline_id=$1", [id])).rows).toEqual([]);
    await clock("2026-11-11T09:00:00-05:00");
    await q("select private.case_deadline_notice_sweep()");
    await q("select private.case_deadline_notice_sweep()");
    expect(await notices(world.member)).toHaveLength(2);
    expect(await notices(world.steward)).toHaveLength(2);
  });

  it("keeps the touch utility free of graph locks while its statement gate precedes row updates", async () => {
    const body = (await q("select prosrc from pg_proc where oid='private.touch_member_case_updated_at()'::regprocedure")).rows[0].prosrc;
    expect(body).not.toContain('perform private.lock_case_graph');
    expect(body).toContain('new.deadline is distinct from old.deadline');
    const gate = (await q(`select t.tgenabled, t.tgtype::int kind, p.proname
      from pg_trigger t join pg_proc p on p.oid=t.tgfoid
      where t.tgrelid='public.member_cases'::regclass and t.tgname='a00_case_graph_lock'`)).rows[0];
    expect(gate).toBeDefined();
    expect(['O', 'A']).toContain(gate.tgenabled);
    expect(gate.kind & 1).toBe(0);
    expect(gate.kind & 2).toBe(2);
    expect(gate.kind & 16).toBe(16);
    expect(gate.proname).toBe('lock_case_graph_statement');
  });

  it("keeps instant reminder dispatch once-only while an extension gets its new day notice", async () => {
    const id = await deadline(await caseRow(null, true), "2026-11-10T22:00:00-05:00");
    await q("update public.casework_deadlines set reminder_at='2026-11-10T08:59:00-05:00' where id=$1", [id]);
    const dispatch = (await q("select pg_get_functiondef('private.casework_sweep_deadline_reminders(integer)'::regprocedure) definition")).rows[0].definition;
    await clock("2026-11-10T09:00:00-05:00", [...definitions, dispatch]);
    await q("select private.staff_deadline_notice_sweep()");
    const before = (await q("select * from private.staff_deadline_notice_marks where deadline_id=$1", [id])).rows;
    expect((await q("select private.casework_sweep_deadline_reminders(200) sent")).rows[0].sent).toBe(1);
    expect((await q("select * from private.staff_deadline_notice_marks where deadline_id=$1", [id])).rows).toEqual(before);
    expect((await q("select private.casework_sweep_deadline_reminders(200) sent")).rows[0].sent).toBe(0);
    await extend(id, "2026-11-11T22:00:00-05:00");
    await clock("2026-11-11T09:00:00-05:00", [...definitions, dispatch]);
    await q("select private.staff_deadline_notice_sweep()");
    expect((await q("select private.casework_sweep_deadline_reminders(200) sent")).rows[0].sent).toBe(0);
    const rows = await notices(world.steward);
    expect(rows.filter((n) => n.title === "Assigned case deadline today")).toHaveLength(2);
    expect(rows.filter((n) => n.title === "A case deadline reminder is due")).toHaveLength(1);
  });

  it("replaying the remap leaves converted adjacent Eastern keys exactly unchanged", async () => {
    const id = await deadline(await caseRow(null, true), "2026-11-10T22:00:00-05:00");
    await clock("2026-11-10T09:00:00-05:00");
    await q("select private.staff_deadline_notice_sweep()");
    await q("insert into private.staff_deadline_notice_marks(source,deadline_id,due_on,stage) values ('casework_deadline',$1,'2026-11-11',1)", [id]);
    const before = (await q("select * from private.staff_deadline_notice_marks where deadline_id=$1 order by due_on", [id])).rows;
    await q(replay);
    expect((await q("select * from private.staff_deadline_notice_marks where deadline_id=$1 order by due_on", [id])).rows).toEqual(before);
  });

  it("keeps two days at 11:30 PM ET and advances to tomorrow only after midnight ET", async () => {
    const id = await caseRow("2026-11-12", true);
    await clock("2026-11-10T23:30:00-05:00");
    await q("select private.case_deadline_notice_sweep()");
    expect(await notices(world.member)).toEqual([{ title: "Case deadline approaching", body: "A case deadline is 2 days away. Open Cases for the details." }]);
    expect(await notices(world.steward)).toEqual([{ title: "Assigned case deadline approaching", body: "A deadline on a case assigned to you is 2 days away. Open Casework for the details." }]);
    expect((await q("select deadline_notice_1_sent_at is null pending from public.member_cases where id=$1", [id])).rows[0].pending).toBe(true);
    await clock("2026-11-11T00:30:00-05:00");
    await q("select private.case_deadline_notice_sweep()");
    expect((await notices(world.member)).map((n) => n.title).sort()).toEqual(["Case deadline approaching", "Case deadline tomorrow"].sort());
    expect((await notices(world.steward)).map((n) => n.title).sort()).toEqual(["Assigned case deadline approaching", "Assigned case deadline tomorrow"].sort());
    await q("select private.case_deadline_notice_sweep()");
    expect(await notices(world.member)).toHaveLength(2);
    expect(await notices(world.steward)).toHaveLength(2);
  });

  it("still sends today's notices at 11:30 PM ET", async () => {
    await caseRow("2026-11-10", true);
    await clock("2026-11-10T23:30:00-05:00");
    await q("select private.case_deadline_notice_sweep()");
    expect((await notices(world.member)).map((n) => n.title)).toEqual(["Case deadline today"]);
    expect((await notices(world.steward)).map((n) => n.title)).toEqual(["Assigned case deadline today"]);
  });

  for (const [instant, dueOn] of [
    ["2027-03-14T00:30:00-05:00", "2027-03-16"],
    ["2027-03-14T23:30:00-04:00", "2027-03-16"],
    ["2026-11-01T00:30:00-04:00", "2026-11-03"],
    ["2026-11-01T23:30:00-05:00", "2026-11-03"],
  ]) {
    it(`counts two calendar days across DST at ${instant}`, async () => {
      await caseRow(dueOn, true);
      await clock(instant);
      await q("select private.case_deadline_notice_sweep()");
      expect((await notices(world.member)).map((n) => n.body)).toEqual(["A case deadline is 2 days away. Open Cases for the details."]);
      expect((await notices(world.steward)).map((n) => n.body)).toEqual(["A deadline on a case assigned to you is 2 days away. Open Casework for the details."]);
    });
  }

  it("uses Eastern dates even when the session is a different timezone", async () => {
    await q("set local timezone = 'Pacific/Kiritimati'");
    await caseRow("2026-11-12");
    await clock("2026-11-10T23:30:00-05:00");
    await q("select private.case_deadline_notice_sweep()");
    expect((await notices(world.member)).map((n) => n.title)).toEqual(["Case deadline approaching"]);
    expect((await notices(world.member))[0].body).toContain("2 days");
  });

  it("buckets a late Eastern timestamp on today's date and excludes yesterday after midnight", async () => {
    const caseId = await caseRow(null, true);
    const id = await deadline(caseId, "2026-11-10T22:00:00-05:00");
    await clock("2026-11-10T23:30:00-05:00");
    await q("select private.staff_deadline_notice_sweep()");
    expect((await q("select due_on::text,stage from private.staff_deadline_notice_marks where deadline_id=$1", [id])).rows).toEqual([{ due_on: "2026-11-10", stage: 3 }]);
    expect((await notices(world.steward)).map((n) => n.title)).toEqual(["Assigned case deadline today"]);
    await clock("2026-11-11T00:30:00-05:00");
    await q("delete from private.staff_deadline_notice_marks where deadline_id=$1", [id]);
    await q("select private.staff_deadline_notice_sweep()");
    expect((await q("select stage from private.staff_deadline_notice_marks where deadline_id=$1", [id])).rows).toEqual([]);
    expect(await notices(world.steward)).toHaveLength(1);
  });

  for (const collision of [false, true]) {
    it(`remaps UTC-keyed marks without a second notice${collision ? " when an Eastern key already exists" : ""}`, async () => {
      const caseId = await caseRow(null, true);
      const id = await deadline(caseId, "2026-11-10T22:00:00-05:00");
      await legacyMark(id, "2026-11-11", 3);
      if (collision) await q("insert into private.staff_deadline_notice_marks(source,deadline_id,due_on,stage) values ('casework_deadline',$1,'2026-11-10',1)", [id]);
      const cronBefore = (await q("select * from cron.job order by jobid")).rows;
      const functionsBefore = (await q("select count(*)::int n from pg_proc where pronamespace in ('public'::regnamespace,'private'::regnamespace)")).rows;
      await q(replay);
      await q(replay);
      expect((await q("select * from cron.job order by jobid")).rows).toEqual(cronBefore);
      const cron = cronBefore.find((job) => job.jobname === "deadline-notices-tick");
      expect(cron).toMatchObject({ schedule: "5 13 * * *", active: true });
      expect(cron.command.trim()).toBe("select private.case_deadline_notice_sweep();");
      expect((await q("select count(*)::int n from pg_proc where pronamespace in ('public'::regnamespace,'private'::regnamespace)")).rows).toEqual(functionsBefore);
      expect((await q("select due_on::text,stage from private.staff_deadline_notice_marks where deadline_id=$1", [id])).rows).toEqual([{ due_on: "2026-11-10", stage: 3 }]);
      await clock("2026-11-10T23:30:00-05:00");
      await q("select private.staff_deadline_notice_sweep()");
      expect(await notices(world.steward)).toEqual([]);
    });
  }

  it("retires historical UTC moved-date keys while retaining member-case marks", async () => {
    const caseId = await caseRow("2026-11-12", true);
    const id = await deadline(caseId, "2026-11-10T22:00:00-05:00");
    await legacyMark(id, "2026-11-09", 2);
    await q("insert into private.staff_deadline_notice_marks(source,deadline_id,due_on,stage) values ('member_case',$1,'2026-11-12',1)", [caseId]);
    const before = (await q("select source,deadline_id,due_on::text,stage,marked_at from private.staff_deadline_notice_marks where source='member_case' and deadline_id=$1", [caseId])).rows;
    await q(replay);
    expect((await q("select source,deadline_id,due_on::text,stage,marked_at from private.staff_deadline_notice_marks where deadline_id=any($1::uuid[]) order by source", [[id, caseId]])).rows).toEqual(before);
  });
});
