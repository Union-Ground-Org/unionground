// @vitest-environment node
//
// REQ-UG-LEARNING-PERIOD-EVENTS-20261103 (#6944), slice 5 of #6805:
// a person's own event work during the learning period is journalled once
// and undone to its earlier state. A stale edit waiting behind an undo is
// refused; a practised delete keeps its RSVPs for undo and is completed at
// the close; notices already sent stay sent; votes are never journalled.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { stripComments } from "./helpers/migration.js";
import { releaseLearningPeriodHold } from "./helpers/learningPeriodHold.js";

const FILE = "20261104110000_learning_period_events.sql";
const sql = readFileSync(`supabase/migrations/${FILE}`, "utf8");
const code = stripComments(sql);
const WRITERS = {
  "public.create_member_event": "private.learning_event_journal('event_create'",
  "public.create_member_event_model": "private.learning_event_journal('event_create'",
  "public.create_member_event_with_rsvp": "private.learning_event_journal('event_edit'",
  "public.update_member_event": "private.learning_event_journal('event_edit'",
  "public.update_member_event_model": "private.learning_event_journal('event_edit'",
  "public.cancel_member_event": "private.learning_event_journal('event_cancel'",
  "public.restore_member_event": "private.learning_event_journal('event_restore'",
  "public.delete_member_event": "private.learning_event_journal('event_delete'",
  "public.set_member_event_rsvp_open": "private.learning_event_journal('event_edit'",
  "public.set_member_event_quorum": "private.learning_event_journal('event_edit'",
  "public.set_member_event_agenda": "private.learning_event_journal('event_edit'",
  "public.set_member_event_organizer": "private.learning_event_journal('event_edit'",
  "public.rsvp_to_event": "private.learning_attendance_journal('event_rsvp'",
  "public.check_in_to_event": "private.learning_attendance_journal('event_checkin'",
  "public.scan_event_checkin": "private.learning_attendance_journal('event_checkin_scan'",
  "public.save_organization_live_poll": "private.learning_poll_journal('live_poll_create'",
  "public.transition_organization_live_poll": "private.learning_poll_journal('live_poll_transition'",
  "public.set_organization_live_poll_event": "private.learning_poll_journal('live_poll_meeting'",
};

describe("learning period events migration (offline)", () => {
  it("journals every event writer after its write, with the graph lock first", () => {
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    const functions = parseFunctions(sql);
    for (const [name, call] of Object.entries(WRITERS)) {
      const source = functions.find((fn) => fn.name === name)?.source;
      expect(source, name).toContain(call);
      if (name !== "public.create_member_event_with_rsvp") expect(helperFirst(source), name).toBe(true);
    }
    for (const name of ["private.learning_event_journal", "private.learning_undo_event", "private.learning_undo_event_attendance", "private.learning_undo_live_poll", "private.learning_event_hold"]) {
      expect(helperFirst(functions.find((fn) => fn.name === name).source), name).toBe(true);
    }
  });

  it("gives both event updates an expected version and keeps votes out of the journal", () => {
    const functions = parseFunctions(sql);
    for (const name of ["public.update_member_event", "public.update_member_event_model"]) {
      const source = functions.find((fn) => fn.name === name).source;
      expect(source, name).toContain("p_expected_version is not null and ev.version is distinct from p_expected_version");
      expect(source, name).toContain("detail = 'event_changed'");
    }
    expect(code).toMatch(/\('live_poll_vote', 'events', 'excluded', null,/);
    expect(code).toMatch(/\('ballot_vote', 'events', 'excluded', null,/);
    expect(code).toMatch(/\('channel_poll_vote', 'events', 'excluded', null,/);
    expect(code).not.toMatch(/learning_[a-z_]*journal[a-z_]*\(\s*'(live_poll_vote|ballot_vote|channel_poll_vote)'/);
  });

  it("dispatches the event handlers alongside the task ones and never rewrites an audit row", () => {
    const dispatch = parseFunctions(sql).find((fn) => fn.name === "private.learning_dispatch").source;
    for (const handler of ["learning_undo_task", "learning_undo_task_edge", "learning_undo_task_file", "learning_undo_task_checkoff", "learning_undo_event", "learning_undo_event_attendance", "learning_undo_live_poll"]) {
      expect(dispatch).toContain(`when 'private.${handler}' then return private.${handler}(p_mode, p_entry);`);
    }
    expect(code).not.toMatch(/(update|delete from)\s+public\.(organization_audit_ledger|organization_audit_events|member_admin_audit|member_notifications)\b/);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("learning period events on a disposable database", () => {
  let c;
  let world;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "learning-period-events-proof" });
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
      return { ok: false, code: error.code, message: error.message, detail: error.detail };
    }
  }
  const one = async (...args) => {
    const result = await call(...args);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    return result.rows[0] ? Object.values(result.rows[0])[0] : undefined;
  };

  async function person(org, role) {
    const user = { id: randomUUID(), session: randomUUID() };
    await c.query("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org.id, user.id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, org.chapter]);
    await c.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user.id, org.chapter, `Proof ${role}`]);
    if (role !== "member") {
      await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [org.id, user.id, role]);
      await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [user.id, role, org.chapter]);
    }
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    return user;
  }

  beforeEach(async () => {
    await c.query("begin");
    await releaseLearningPeriodHold(c);
    const org = { id: randomUUID(), chapter: `learning-events-${randomUUID().slice(0, 8)}` };
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org.id, org.chapter]);
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98317)", [org.chapter, org.id]);
    world = { org, admin: await person(org, "admin"), steward: await person(org, "steward"), other: await person(org, "steward"), member: await person(org, "member") };
    // 20261112-0032, an owner decision:
    // retain the old broad-grant positive controls through the real backfill.
    await migrateLegacyStewardFixtures(c);
  });
  afterEach(async () => { await c.query("rollback"); });

  const start = () => one("select public.start_organization_learning_period() as r", [], world.admin);
  const eventId = () => `proof-${randomUUID().slice(0, 12)}`;
  const inHours = (hours) => new Date(Date.now() + hours * 3600_000).toISOString();
  const createEvent = (user, id, { code = null, startsAt = inHours(72) } = {}) => one(
    "select public.create_member_event($1, 'Practice meeting', $2::timestamptz, 'Hall B', 'A fictional meeting', $3, false, false) as r",
    [id, startsAt, code], user);
  const update = (user, id, title, version = null) => call(
    "select public.update_member_event(p_id => $1, p_title => $2, p_expected_version => $3) as r", [id, title, version], user);
  const event = async (id) => (await c.query("select title, starts_at::text as starts_at, location, cancelled_at, rsvp_open, version from public.member_events where id = $1", [id])).rows[0];
  const entries = async (table, id) => (await c.query("select id, action_kind, state, version, parent_entry_id from private.learning_action_journal where target_table = $1 and target_id = $2 order by created_at, id", [table, id])).rows;
  const eventEntries = (id) => entries("public.member_events", id);
  const undo = (user, entry, version = 1) => call("select public.undo_my_learning_action($1, $2) as r", [entry, version], user);
  const rsvp = (user, id, status = "going") => one("select public.rsvp_to_event($1, $2) as r", [id, status], user);
  const rsvps = async (id) => (await c.query("select user_id, status, created_at::text from public.member_event_rsvps where event_id = $1 order by user_id", [id])).rows;
  // One transaction stamps every notice with the same time, so compare counts.
  const notices = async (user) => (await c.query("select copy_key from public.member_notifications where user_id = $1 and kind = 'events' order by copy_key", [user.id])).rows.map((row) => row.copy_key);
  const withNotices = (sent, ...added) => [...sent, ...added].sort();
  const audit = async () => Number((await c.query("select count(*) from public.member_admin_audit")).rows[0].count);

  it("journals an event creation once and undoes it by hiding the event, never erasing it", async () => {
    await start();
    const id = eventId();
    await createEvent(world.steward, id);
    const [entry] = await eventEntries(id);
    expect(entry).toMatchObject({ action_kind: "event_create", state: "active" });
    expect((await c.query("select flag from private.learning_practice_flags('public.member_events', array[$1::text])", [id])).rows).toEqual([{ flag: "practice" }]);
    const auditBefore = await audit();
    expect(await undo(world.steward, entry.id)).toMatchObject({ ok: true, rows: [{ r: { status: "undone", undoneCount: 1 } }] });
    expect(await event(id)).toBeUndefined();
    expect((await c.query("select event_row ->> 'title' as title from private.learning_held_member_events where entry_id = $1", [entry.id])).rows).toEqual([{ title: "Practice meeting" }]);
    expect(await audit()).toBe(auditBefore + 1);
    // A hidden creation is never restored, so its id is free again.
    expect(await call("select public.create_member_event($1, 'Again', now() + interval '3 days', 'Hall', 'Again', null, false, false)", [id], world.steward)).toMatchObject({ ok: true });
    // A second undo changes nothing.
    expect(await undo(world.steward, entry.id, 2)).toMatchObject({ ok: true, rows: [{ r: { status: "already_undone" } }] });
  });

  it("refuses to hide a created event once someone else has answered it", async () => {
    await start();
    const id = eventId();
    await createEvent(world.steward, id);
    await rsvp(world.member, id);
    const [entry] = await eventEntries(id);
    expect(await undo(world.steward, entry.id)).toMatchObject({ ok: false, code: "55000" });
    expect(await event(id)).toMatchObject({ title: "Practice meeting" });
    expect((await eventEntries(id))[0]).toMatchObject({ state: "active" });
  });

  it("refuses a stale edit queued behind an undo instead of reapplying the undone value", async () => {
    const id = eventId();
    await createEvent(world.steward, id);
    await start();
    expect(await update(world.steward, id, "Practice title", 1)).toMatchObject({ ok: true });
    // Someone opens the event at version 2, then the undo lands first.
    const seen = (await event(id)).version;
    expect(seen).toBe(2);
    const [edit] = await eventEntries(id);
    expect(edit).toMatchObject({ action_kind: "event_edit", state: "active" });
    expect(await undo(world.steward, edit.id)).toMatchObject({ ok: true });
    expect(await event(id)).toMatchObject({ title: "Practice meeting", version: 3 });
    const stale = await update(world.other, id, "Practice title", seen);
    expect(stale).toMatchObject({ ok: false, code: "PT409", detail: "event_changed" });
    expect(await event(id)).toMatchObject({ title: "Practice meeting", version: 3 });
    // A fresh read saves.
    expect(await update(world.other, id, "Fresh title", 3)).toMatchObject({ ok: true });
  });

  it("refuses a stale agenda queued behind an undo, and returns the version each save leaves (gate round 1)", async () => {
    const id = eventId();
    await createEvent(world.steward, id);
    await start();
    const saved = await one("select public.set_member_event_agenda(p_id => $1, p_agenda => '1. Practice item', p_expected_version => 1) as r", [id], world.steward);
    expect(saved).toMatchObject({ updated: true, version: 2 });
    const [edit] = await eventEntries(id);
    expect(await undo(world.steward, edit.id)).toMatchObject({ ok: true });
    const stale = await call("select public.set_member_event_agenda(p_id => $1, p_agenda => '1. Practice item', p_expected_version => 2) as r", [id], world.other);
    expect(stale).toMatchObject({ ok: false, code: "PT409", detail: "event_changed" });
    expect((await c.query("select agenda, version from public.member_events where id = $1", [id])).rows[0]).toEqual({ agenda: null, version: 3 });
    expect(await update(world.other, id, "Fresh title", 3)).toMatchObject({ ok: true, rows: [{ r: { updated: true, version: 4 } }] });
  });

  it("never turns a meeting with attendance into a deadline by undoing its edit (gate round 1)", async () => {
    const id = eventId();
    await one("select public.create_member_event_model($1, 'Practice deadline', null, 'Hall', 'A fictional deadline', null, false, false, 'deadline', (now() + interval '5 days')::date, null, 1, null) as r", [id], world.steward);
    await start();
    const schedule = { kind: "meeting", startsAt: inHours(72), eventDate: null, endsAt: null };
    expect(await one("select public.update_member_event_model(p_id => $1, p_schedule => $2::jsonb, p_expected_version => 1) as r", [id, JSON.stringify(schedule)], world.steward)).toMatchObject({ updated: true });
    await rsvp(world.member, id);
    const [edit] = await eventEntries(id);
    expect(await undo(world.steward, edit.id)).toMatchObject({ ok: false, code: "22023" });
    expect((await c.query("select event_kind from public.member_events where id = $1", [id])).rows[0].event_kind).toBe("meeting");
    expect(await rsvps(id)).toMatchObject([{ user_id: world.member.id, status: "going" }]);
  });

  it("journals an agenda at its full length in any script without refusing the edit (gate round 1)", async () => {
    const id = eventId();
    await createEvent(world.steward, id);
    await start();
    // 4,000 four-byte characters with line breaks: the largest agenda allowed.
    const agenda = Array.from({ length: 40 }, () => "\u{1F4CB}".repeat(99)).join("\n");
    expect([...agenda].length).toBe(3999);
    const summary = "\u{1F4CB}".repeat(500);
    expect(await one("select public.update_member_event(p_id => $1, p_summary => $2, p_expected_version => 1) as r", [id, summary], world.steward)).toMatchObject({ updated: true });
    expect(await one("select public.set_member_event_agenda(p_id => $1, p_agenda => $2, p_expected_version => 2) as r", [id, agenda], world.steward)).toMatchObject({ updated: true });
    expect(await update(world.steward, id, "Practice title", 3)).toMatchObject({ ok: true });
    const journal = await eventEntries(id);
    expect(journal.map((entry) => entry.action_kind)).toEqual(["event_edit", "event_edit", "event_edit"]);
    expect(Number((await c.query("select octet_length(before_image::text) as n from private.learning_action_journal where id = $1", [journal[2].id])).rows[0].n)).toBeGreaterThan(16384);
    expect(await undo(world.steward, journal[0].id)).toMatchObject({ ok: true, rows: [{ r: { undoneCount: 3 } }] });
    expect((await c.query("select agenda, title, summary from public.member_events where id = $1", [id])).rows[0]).toEqual({ agenda: null, title: "Practice meeting", summary: "A fictional meeting" });
  });

  it("frees a hidden creation's id after the period closes (gate round 1)", async () => {
    const started = await start();
    const id = eventId();
    await createEvent(world.steward, id);
    const [entry] = await eventEntries(id);
    expect(await undo(world.steward, entry.id)).toMatchObject({ ok: true });
    await one("select public.end_organization_learning_period_early() as r", [], world.admin);
    expect((await c.query("select private.close_learning_period($1) as r", [started.periodId])).rows[0].r).toMatchObject({ closed: true });
    expect(await call("select public.create_member_event($1, 'Real meeting', now() + interval '3 days', 'Hall', 'After the period', null, false, false) as r", [id], world.steward)).toMatchObject({ ok: true });
    expect(await event(id)).toMatchObject({ title: "Real meeting" });
  });

  it("refuses a stale organizer queued behind an undo, and shows the version only to event staff (gate round 2)", async () => {
    const id = eventId();
    await createEvent(world.steward, id);
    await start();
    const context = (user) => one("select public.get_connected_workflow_context('event', $1) as r", [id], user);
    expect(await context(world.steward)).toMatchObject({ canManageOrganizer: true, eventVersion: 1 });
    expect((await context(world.member)).eventVersion ?? null).toBeNull();
    const set = (user, version) => call("select public.set_member_event_organizer(p_event_id => $1, p_organizer_id => $2, p_expected_version => $3) as r", [id, world.other.id, version], user);
    expect(await set(world.steward, 1)).toMatchObject({ ok: true, rows: [{ r: { changed: true, version: 2 } }] });
    const [edit] = await eventEntries(id);
    expect(await undo(world.steward, edit.id)).toMatchObject({ ok: true });
    expect(await set(world.other, 2)).toMatchObject({ ok: false, code: "PT409", detail: "event_changed" });
    expect((await c.query("select organizer_id, version from public.member_events where id = $1", [id])).rows[0]).toEqual({ organizer_id: null, version: 3 });
    expect(await context(world.steward)).toMatchObject({ eventVersion: 3 });
  });

  it("returns the version a quorum save leaves, so the next edit saves (gate round 2)", async () => {
    const id = eventId();
    await createEvent(world.steward, id);
    await start();
    expect(await one("select public.set_member_event_quorum($1, 12) as r", [id], world.steward)).toMatchObject({ changed: true, version: 2 });
    expect(await one("select public.set_member_event_quorum($1, 12) as r", [id], world.steward)).toMatchObject({ changed: false, version: 2 });
    expect(await update(world.steward, id, "After quorum", 2)).toMatchObject({ ok: true });
  });

  it("continues the version of a hidden creation when its id is reused (gate round 2)", async () => {
    await start();
    const id = eventId();
    await createEvent(world.steward, id);
    expect(await update(world.steward, id, "Practice title", 1)).toMatchObject({ ok: true });
    const [created] = await eventEntries(id);
    expect(await undo(world.steward, created.id)).toMatchObject({ ok: true, rows: [{ r: { undoneCount: 2 } }] });
    // An editor still holding version 3 of the hidden event cannot save into the new one.
    await createEvent(world.other, id);
    expect((await event(id)).version).toBe(4);
    expect(await update(world.steward, id, "Stale title", 3)).toMatchObject({ ok: false, code: "PT409", detail: "event_changed" });
  });

  it("refuses an undo once someone else has edited the event since", async () => {
    const id = eventId();
    await createEvent(world.steward, id);
    await start();
    expect(await update(world.steward, id, "Practice title", 1)).toMatchObject({ ok: true });
    expect(await update(world.other, id, "Their title", 2)).toMatchObject({ ok: true });
    const [mine] = await eventEntries(id);
    expect(await undo(world.steward, mine.id)).toMatchObject({ ok: false, code: "PT409" });
    expect(await event(id)).toMatchObject({ title: "Their title" });
  });

  it("keeps RSVPs through a practised delete and its undo, and leaves check-ins where delete is refused", async () => {
    const id = eventId();
    await createEvent(world.steward, id);
    await rsvp(world.member, id);
    await rsvp(world.other, id, "not_going");
    const attended = eventId();
    await createEvent(world.steward, attended, { code: "SG-PROOF5", startsAt: inHours(1) });
    expect(await one("select public.check_in_to_event($1, 'SG-PROOF5') as r", [attended], world.member)).toMatchObject({ checkedIn: true });
    await start();
    const before = { event: await event(id), rsvps: await rsvps(id) };

    expect(await one("select public.delete_member_event($1) as r", [id], world.steward)).toMatchObject({ deleted: true });
    expect(await event(id)).toBeUndefined();
    expect(await rsvps(id)).toEqual([]);
    // Its id stays taken while the undo could still put it back.
    expect(await call("select public.create_member_event($1, 'Again', now() + interval '3 days', 'Hall', 'Again', null, false, false)", [id], world.other)).toMatchObject({ ok: false, code: "22023" });
    const [deleted] = await eventEntries(id);
    expect(deleted).toMatchObject({ action_kind: "event_delete", state: "active" });
    expect(Number((await c.query("select count(*) from private.learning_held_member_event_rsvps where entry_id = $1", [deleted.id])).rows[0].count)).toBe(2);

    expect(await undo(world.steward, deleted.id)).toMatchObject({ ok: true });
    expect(await event(id)).toEqual({ ...before.event, version: before.event.version + 1 });
    expect(await rsvps(id)).toEqual(before.rsvps);
    expect(Number((await c.query("select count(*) from private.learning_held_member_events where entry_id = $1", [deleted.id])).rows[0].count)).toBe(0);

    // Deleting an event with check-ins is refused as before, so they stay.
    expect(await call("select public.delete_member_event($1)", [attended], world.steward)).toMatchObject({ ok: false, detail: "event_has_attendance" });
    expect(Number((await c.query("select count(*) from public.member_event_checkins where event_id = $1", [attended])).rows[0].count)).toBe(1);
  });

  it("completes a kept delete at the close as today's hard delete, and a rerun changes nothing", async () => {
    const id = eventId();
    await createEvent(world.steward, id);
    await rsvp(world.member, id);
    const started = await start();
    await one("select public.delete_member_event($1) as r", [id], world.steward);
    const [deleted] = await eventEntries(id);
    // Ending early runs the same close the end job runs.
    await one("select public.end_organization_learning_period_early() as r", [], world.admin);
    expect((await entries("public.member_events", id))[0]).toMatchObject({ state: "kept" });
    const held = async () => (await c.query(`select (select count(*)::int from private.learning_held_member_events where event_id = $1) as events,
      (select count(*)::int from private.learning_held_member_event_rsvps where event_id = $1) as rsvps,
      (select count(*)::int from public.member_events where id = $1) as live,
      (select count(*)::int from public.member_event_rsvps where event_id = $1) as live_rsvps`, [id])).rows[0];
    expect(await held()).toEqual({ events: 0, rsvps: 0, live: 0, live_rsvps: 0 });
    expect((await c.query("select private.close_learning_period($1) as r", [started.periodId])).rows[0].r).toMatchObject({ closed: true, changed: false });
    expect(await held()).toEqual({ events: 0, rsvps: 0, live: 0, live_rsvps: 0 });
    expect(await undo(world.steward, deleted.id, 2)).toMatchObject({ ok: false, code: "55000" });
  });

  it("never recalls a notice already sent: undoing a cancel or a reschedule adds the ordinary notice", async () => {
    const id = eventId();
    await createEvent(world.steward, id);
    await rsvp(world.member, id);
    await start();
    const sent = await notices(world.member);
    await one("select public.cancel_member_event($1, 'Practice') as r", [id], world.steward);
    const [cancelled] = await eventEntries(id);
    expect(await undo(world.steward, cancelled.id)).toMatchObject({ ok: true });
    expect(await event(id)).toMatchObject({ cancelled_at: null });
    expect(await notices(world.member)).toEqual(withNotices(sent, "event.cancelled", "event.restored"));

    expect(await one("select public.update_member_event(p_id => $1, p_starts_at => $2::timestamptz, p_expected_version => 3) as r", [id, inHours(96)], world.steward)).toMatchObject({ updated: true });
    const moved = (await eventEntries(id)).at(-1);
    expect(await undo(world.steward, moved.id)).toMatchObject({ ok: true });
    expect(await notices(world.member)).toEqual(withNotices(sent, "event.cancelled", "event.restored", "event.rescheduled", "event.rescheduled"));
  });

  it("undoes your own RSVP and check-in, leaving points and audit rows", async () => {
    const id = eventId();
    await createEvent(world.steward, id, { code: "SG-PROOF6", startsAt: inHours(1) });
    await rsvp(world.member, id, "not_going");
    await start();
    await rsvp(world.member, id, "going");
    await one("select public.check_in_to_event($1, 'SG-PROOF6') as r", [id], world.member);
    const key = `${id}:${world.member.id}`;
    const [answered] = await entries("public.member_event_rsvps", key);
    const [checked] = await entries("public.member_event_checkins", key);
    expect([answered.action_kind, checked.action_kind]).toEqual(["event_rsvp", "event_checkin"]);
    // Someone else's answer is not yours to undo.
    expect(await undo(world.steward, answered.id)).toMatchObject({ ok: false, code: "P0002" });
    expect(await undo(world.member, checked.id)).toMatchObject({ ok: true });
    expect(await undo(world.member, answered.id)).toMatchObject({ ok: true });
    expect(await rsvps(id)).toMatchObject([{ user_id: world.member.id, status: "not_going" }]);
    expect(Number((await c.query("select count(*) from public.member_event_checkins where event_id = $1", [id])).rows[0].count)).toBe(0);
    expect(Number((await c.query("select count(*) from public.member_action_log where user_id = $1 and action_key = $2", [world.member.id, `checkin-${id}`])).rows[0].count)).toBe(1);
  });

  it("undoes a created series as one action and a create-edit-delete chain newest first", async () => {
    await start();
    const series = eventId();
    const created = await one(
      "select public.create_member_event_model($1, 'Practice series', $2::timestamptz, 'Hall', 'Monthly', null, false, false, 'meeting', null, null, 3, 'America/New_York') as r",
      [series, inHours(72)], world.steward);
    const ids = created.occurrenceIds;
    expect(ids).toHaveLength(3);
    const parent = (await eventEntries(ids[0]))[0];
    expect((await eventEntries(ids[2]))[0]).toMatchObject({ parent_entry_id: parent.id });
    expect(await undo(world.steward, (await eventEntries(ids[2]))[0].id)).toMatchObject({ ok: true, rows: [{ r: { undoneCount: 3 } }] });
    expect(Number((await c.query("select count(*) from public.member_events where id = any($1)", [ids])).rows[0].count)).toBe(0);

    const id = eventId();
    await createEvent(world.steward, id);
    expect(await update(world.steward, id, "Second title", 1)).toMatchObject({ ok: true });
    await one("select public.delete_member_event($1) as r", [id], world.steward);
    const chain = await eventEntries(id);
    expect(chain.map((entry) => entry.action_kind)).toEqual(["event_create", "event_edit", "event_delete"]);
    expect(await undo(world.steward, chain[0].id)).toMatchObject({ ok: true, rows: [{ r: { undoneCount: 3 } }] });
    expect(await event(id)).toBeUndefined();
    expect((await c.query("select entry_id from private.learning_held_member_events where event_id = $1", [id])).rows).toEqual([{ entry_id: chain[0].id }]);
  });

  it("never journals a vote, and undoes a live poll you created only until its first vote", async () => {
    await start();
    const save = (title) => one("select public.save_organization_live_poll($1::jsonb) as r", [JSON.stringify({ title, options: ["Yes", "No"] })], world.steward);
    const voted = await save("Practice poll");
    const quiet = await save("Quiet poll");
    await one("select public.transition_organization_live_poll($1, 'open') as r", [voted.id], world.steward);
    const option = (await c.query("select id from public.organization_live_poll_options where poll_id = $1 order by sort_index limit 1", [voted.id])).rows[0].id;
    const journalBefore = Number((await c.query("select count(*) from private.learning_action_journal where organization_id = $1", [world.org.id])).rows[0].count);
    await one("select public.cast_organization_live_poll_vote($1, $2) as r", [voted.id, option], world.member);
    expect(Number((await c.query("select count(*) from private.learning_action_journal where organization_id = $1", [world.org.id])).rows[0].count)).toBe(journalBefore);
    expect((await c.query("select disposition, target_table from private.learning_action_kinds where action_kind = 'live_poll_vote'")).rows).toEqual([{ disposition: "excluded", target_table: null }]);

    const pollEntries = async (id) => entries("public.organization_live_polls", id);
    expect((await pollEntries(voted.id)).map((entry) => [entry.action_kind, entry.state])).toEqual([["live_poll_create", "active"], ["live_poll_transition", "kept"]]);
    expect(await undo(world.steward, (await pollEntries(voted.id))[0].id)).toMatchObject({ ok: false, code: "55000" });
    expect(await undo(world.steward, (await pollEntries(quiet.id))[0].id)).toMatchObject({ ok: true });
    expect((await c.query("select state from public.organization_live_polls where id = $1", [quiet.id])).rows[0].state).toBe("cancelled");
  });
});
