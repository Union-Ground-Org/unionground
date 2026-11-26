// @vitest-environment node
//
// REQ-UG-LEARNING-PERIOD-CASE-RECORDS-20261103 (#6942), part 1 of 2:
// a person's own case, note, outcome and file actions during the learning
// period are journalled in the same transaction and undone without losing
// case history: an undone case or note is a tombstone, hidden everywhere and
// never deleted; someone else's later work refuses the undo; a removed file
// stays removed; no client writes a case or note row directly.
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";
import { releaseLearningPeriodHold } from "./helpers/learningPeriodHold.js";

const FILE = "20261104075000_learning_period_case_records.sql";
const code = stripComments(readFileSync(`supabase/migrations/${FILE}`, "utf8"));

describe("learning period case records migration (offline)", () => {
  it("registers every case kind with its disposition and takes away the direct client writes", () => {
    for (const [kind, disposition] of [["case_create", "reverse"], ["case_edit", "reverse"], ["case_bulk_update", "simulate"],
      ["case_outcome", "reverse"], ["case_note_add", "reverse"], ["case_file_upload", "reverse"], ["case_file_remove", "permanent"]]) {
      expect(code).toContain(`('${kind}', 'cases', '${disposition}'`);
    }
    expect(code).toContain("revoke update on public.member_cases from authenticated;");
    expect(code).toContain("revoke insert, update, delete on public.member_case_updates from authenticated;");
    expect(code).toContain("select p_case.learning_undone_at is null\n    and private.actor_case_scope_and_identity_allowed((select auth.uid()),p_case);");
    expect(readFileSync("src/lib/memberApi.js", "utf8")).not.toMatch(/from\("member_cases"\)\.update|from\("member_case_updates"\)\.insert/);
  });

  it("never deletes a case or a note to undo it", () => {
    for (const handler of ["learning_undo_case", "learning_undo_case_note"]) {
      const body = code.slice(code.indexOf(`create function private.${handler}(`), code.indexOf("$function$;", code.indexOf(`create function private.${handler}(`)));
      expect(body).not.toMatch(/delete\s+from\s+public\.member_case(s|_updates)\b/i);
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("learning period case records on a disposable database", () => {
  let c;
  let world;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "learning-period-case-records-proof" });
    await c.connect();
  });
  afterAll(async () => { await c?.end(); });

  // asOwner keeps the owning role with the person's claims, as a definer
  // function sees them; otherwise the call runs as the client role.
  async function call(text, values = [], user = null, asOwner = false) {
    await c.query("savepoint call");
    try {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(user
        ? { role: "authenticated", sub: user.id, session_id: user.session, aal: "aal2" }
        : { role: "anon" })]);
      if (!asOwner) await c.query(user ? "set local role authenticated" : "set local role anon");
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
    // Retain this historical broad fixture grant.
    if (role === "steward") await migrateLegacyStewardFixtures(c);
    return user;
  }
  const demote = async (user) => {
    await c.query("delete from public.member_roles where user_id = $1", [user.id]);
    await c.query("delete from public.organization_role_grants where user_id = $1", [user.id]);
  };

  beforeEach(async () => {
    await c.query("begin");
    await releaseLearningPeriodHold(c);
    const org = { id: randomUUID(), chapter: `learning-cases-${randomUUID().slice(0, 8)}` };
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org.id, org.chapter]);
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98318)", [org.chapter, org.id]);
    world = { org, admin: await person(org, "admin"), coordinator: await person(org, "coordinator"),
      member: await person(org, "member"), other: await person(org, "member") };
  });
  afterEach(async () => { await c.query("rollback"); });

  const start = () => one("select public.start_organization_learning_period() as r", [], world.admin);
  const openCase = async (user, title = "Shift swap") => (await one("select public.create_member_case($1, null, 'Scheduling', '') as r", [title], user)).caseId;
  const entries = async (table, id) => (await c.query("select id, action_kind, state, parent_entry_id from private.learning_action_journal where target_table = $1 and target_id = $2 order by created_at, id", [table, id])).rows;
  const caseEntries = (id) => entries("public.member_cases", id);
  const undo = (user, entry, version = 1) => call("select public.undo_my_learning_action($1, $2) as r", [entry, version], user);
  const caseRow = async (id) => (await c.query("select status, deadline::text as deadline, title, learning_undone_at is not null as undone from public.member_cases where id = $1", [id])).rows[0];
  const seen = async (user, id) => (await one("select count(*)::int as n from public.member_cases where id = $1", [id], user));

  it("undoes a member's own case as a tombstone hidden from every reader and kept in history", async () => {
    await start();
    const id = await openCase(world.member);
    const [created] = await caseEntries(id);
    expect(created).toMatchObject({ action_kind: "case_create", state: "active" });
    expect(await seen(world.member, id)).toBe(1);
    expect(await undo(world.other, created.id)).toMatchObject({ ok: false, code: "P0002" });
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [created.id], world.member)).toMatchObject({ status: "undone", undoneCount: 1 });
    expect(await caseRow(id)).toMatchObject({ undone: true, title: "Shift swap" });
    expect(await seen(world.member, id)).toBe(0);
    expect(await seen(world.admin, id)).toBe(0);
    // Behind and outside the visibility gate alike.
    expect(await one("select private.casework_staff_can_access($1) as r", [id], world.admin, true)).toBe(false);
    expect(await one("select private.casework_member_owns($1) as r", [id], world.member, true)).toBe(false);
    expect(await one("select private.automation_v2_case_visible($1, $2, $3) as r", [world.member.id, world.org.id, id], world.member, true)).toBe(false);
    // Nothing was deleted: the history keeps every version.
    expect((await c.query("select count(*)::int as n from private.casework_record_versions where record_table = 'member_cases' and record_id = $1", [id])).rows[0].n).toBeGreaterThan(1);
  });

  it("keeps an undone case out of search for its owner and for staff (G2-P1-1)", async () => {
    await start();
    const word = `Zebrafinch${randomUUID().slice(0, 6)}`;
    const id = await openCase(world.member, `Unsafe ${word} ladder`);
    const found = async (user) => (await one("select count(*)::int as n from public.search_member_cases($1, 20) where case_id = $2", [word, id], user));
    expect(await found(world.member)).toBe(1);
    expect(await found(world.coordinator)).toBe(1);
    // The owner's own note on it (so the undo stays allowed) is searchable by its words.
    const noteWord = `Kestrel${randomUUID().slice(0, 6)}`;
    await one("select public.add_my_case_update($1, $2) as r", [id, `Called about ${noteWord}`], world.member);
    const byNote = async (user) => (await one("select count(*)::int as n from public.search_member_cases($1, 20) where case_id = $2", [noteWord, id], user));
    expect(await byNote(world.member)).toBe(1);
    const [created] = await caseEntries(id);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [created.id], world.member)).toMatchObject({ status: "undone" });
    expect(await found(world.member)).toBe(0);
    expect(await found(world.coordinator)).toBe(0);
    // Its note's words do not bring it back either.
    expect(await byNote(world.member)).toBe(0);
    expect(await byNote(world.coordinator)).toBe(0);
  });

  // #7000 round 1 (r1g1, r1s1, r1s2, r1g2/r1s4, r1s5, r1g3/r1s6, r1s7).
  it("leaves an undone case and an undone note out of the member's own export and the staff helper", async () => {
    await start();
    const id = await openCase(world.member, "Exported practice");
    const note = await one("select public.add_my_case_update($1, 'Practice note') as r", [id], world.member);
    const exported = async () => (await one("select public.get_member_data_export() as r", [], world.member)).cases ?? [];
    expect((await exported()).find((item) => item.id === id).updates.map((u) => u.id)).toContain(note.id);
    const [noteEntry] = await entries("public.member_case_updates", note.id);
    await one("select public.undo_my_learning_action($1, 1) as r", [noteEntry.id], world.member);
    expect((await exported()).find((item) => item.id === id).updates.map((u) => u.id)).not.toContain(note.id);
    const [created] = await caseEntries(id);
    await one("select public.undo_my_learning_action($1, 1) as r", [created.id], world.member);
    expect((await exported()).map((item) => item.id)).not.toContain(id);
    expect(await one("select private.chapter_case_staff_readable(c) as r from public.member_cases c where c.id = $1", [id], world.member, true)).toBe(false);
  });

  it("refuses to undo a case once a coordinator logged a contact on it", async () => {
    await start();
    const id = await openCase(world.member);
    const [created] = await caseEntries(id);
    expect(await call("select public.coordinator_log_case_contact($1, 'phone', 'outbound', 'Called the member', now()) as r", [id], world.coordinator)).toMatchObject({ ok: true });
    expect(await undo(world.member, created.id)).toMatchObject({ ok: false, code: "PT409" });
    expect(await caseRow(id)).toMatchObject({ undone: false });
  });

  it("lets a steward who opened an unassigned case at intake undo it", async () => {
    const steward = await person(world.org, "steward");
    await start();
    const made = await one("select public.open_member_case($1, 'Intake practice', 'Safety', '', null, null, null, null, null, false) as r", [world.member.id], steward);
    expect(made).toMatchObject({ assigned: false });
    const [created] = await caseEntries(made.caseId);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [created.id], steward)).toMatchObject({ status: "undone" });
    expect(await caseRow(made.caseId)).toMatchObject({ undone: true });
  });

  it("sends no deadline notice for an undone case", async () => {
    await start();
    const id = (await one("select public.create_member_case('Due today', current_date, 'Pay', '') as r", [], world.member)).caseId;
    const [created] = await caseEntries(id);
    await one("select public.undo_my_learning_action($1, 1) as r", [created.id], world.member);
    await c.query("select set_config('request.jwt.claims', '', true)");
    await c.query("select private.case_deadline_notice_sweep()");
    expect((await c.query("select deadline_notice_1_sent_at is null as unsent from public.member_cases where id = $1", [id])).rows[0].unsent).toBe(true);
    expect((await c.query("select count(*)::int as n from public.member_notifications where user_id = $1 and kind = 'deadlines'", [world.member.id])).rows[0].n).toBe(0);
  });

  it("hides an undone case's attachments from their owner, in the table and in Storage", async () => {
    await start();
    const id = await openCase(world.member);
    const file = randomUUID();
    const object = `${id}/${file}.txt`;
    await c.query(`insert into public.member_case_files(id,case_id,user_id,bucket_id,object_name,filename,mime_type,size_bytes,uploaded_by,confirmed_at)
      values ($1,$2,$3,'case-files',$4,'own.txt','text/plain',9,$3,now())`, [file, id, world.member.id, object]);
    const files = () => one("select count(*)::int as n from public.member_case_files where id = $1", [file], world.member);
    const storage = () => one("select private.can_read_member_case_object('case-files', $1) as r", [object], world.member, true);
    expect([await files(), await storage()]).toEqual([1, true]);
    const [created] = await caseEntries(id);
    await one("select public.undo_my_learning_action($1, 1) as r", [created.id], world.member);
    expect([await files(), await storage()]).toEqual([0, false]);
  });

  it("leaves members no UPDATE or DELETE on case notes", async () => {
    expect(code).toContain("revoke insert, update, delete on public.member_case_updates from authenticated;");
    for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
      expect((await c.query("select has_table_privilege('authenticated', 'public.member_case_updates', $1) as r", [privilege])).rows[0].r, privilege).toBe(false);
    }
  });

  // #7000 round 2 (r2s1, r2s2, r2g1, r2s3).
  it("sends no ULP notice about an undone case", async () => {
    await start();
    await c.query("insert into public.organization_setting_values(organization_id, setting_key, value) values ($1, 'features.casework.ulp_deadline', 'true'::jsonb) on conflict (organization_id, setting_key) do update set value = excluded.value", [world.org.id]);
    const id = await openCase(world.member, "ULP practice");
    await c.query("select set_config('request.jwt.claims', '', true)");
    await c.query("insert into public.casework_retaliation_flags(case_id, organization_id, chapter_id, source, incident_on, ulp_window_days) values ($1, $2, $3, 'staff', current_date - 29, 30)", [id, world.org.id, world.org.chapter]);
    const [created] = await caseEntries(id);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [created.id], world.member)).toMatchObject({ status: "undone" });
    await c.query("select set_config('request.jwt.claims', '', true)");
    await c.query("select private.casework_sweep_ulp_deadlines(200)");
    expect((await c.query("select count(*)::int as n from public.member_notifications where user_id = $1 and kind = 'deadlines'", [world.member.id])).rows[0].n).toBe(0);
  });

  // #7000 round 3 (r3s1/r3g2, r3s2, r3s3).
  it("never lets undone cases fill the ULP batch: a live case still gets its notice", async () => {
    await start();
    await c.query("insert into public.organization_setting_values(organization_id, setting_key, value) values ($1, 'features.casework.ulp_deadline', 'true'::jsonb) on conflict (organization_id, setting_key) do update set value = excluded.value", [world.org.id]);
    const flag = (caseId, daysAgo) => c.query("insert into public.casework_retaliation_flags(case_id, organization_id, chapter_id, source, incident_on, ulp_window_days) values ($1, $2, $3, 'staff', current_date - $4::integer, 30)", [caseId, world.org.id, world.org.chapter, daysAgo]);
    // Three undone cases whose flags sort first (earlier deadline), then one live case.
    for (let n = 0; n < 3; n += 1) {
      const undone = await openCase(world.other, `Undone ${n}`);
      await c.query("select set_config('request.jwt.claims', '', true)");
      await flag(undone, 30);
      const [created] = await caseEntries(undone);
      await one("select public.undo_my_learning_action($1, 1) as r", [created.id], world.other);
    }
    const live = await openCase(world.member, "Live ULP case");
    await c.query("select set_config('request.jwt.claims', '', true)");
    await flag(live, 29);
    // A batch of two: the undone flags outnumber it.
    await c.query("select set_config('request.jwt.claims', '', true)");
    await c.query("select private.casework_sweep_ulp_deadlines(2)");
    expect((await c.query("select count(*)::int as n from public.member_notifications where user_id = $1 and kind = 'deadlines'", [world.member.id])).rows[0].n).toBe(1);
    expect((await c.query("select count(*)::int as n from public.member_notifications where user_id = $1 and kind = 'deadlines'", [world.other.id])).rows[0].n).toBe(0);
  });

  it("leaves an undone case out of the evidence desk's case targets and count", async () => {
    await start();
    const id = await openCase(world.member, "Evidence practice");
    const targets = async () => ((await one("select public.get_administrative_evidence_desk(0, '') as r", [], world.admin)).actionTargets ?? [])
      .filter((target) => target.targetKind === "member_case").map((target) => target.id);
    expect(await targets()).toContain(id);
    const [created] = await caseEntries(id);
    await one("select public.undo_my_learning_action($1, 1) as r", [created.id], world.member);
    expect(await targets()).not.toContain(id);
  });

  it("refuses to undo a case once an administrator recorded an Action Lab review on it", async () => {
    await start();
    const id = await openCase(world.member);
    const [created] = await caseEntries(id);
    expect(await call("select public.execute_administrative_object_action('member_case', $1, 'case_record_review', 'Reviewed') as r", [id], world.admin)).toMatchObject({ ok: true });
    expect(await undo(world.member, created.id)).toMatchObject({ ok: false, code: "PT409" });
    expect(await caseRow(id)).toMatchObject({ undone: false });
  });

  it("refuses to undo a case once a President reviewed it", async () => {
    const president = await person(world.org, "vp");
    await start();
    const id = (await one("select public.create_member_case('Overdue practice', current_date - 3, 'Pay', '') as r", [], world.member)).caseId;
    const [created] = await caseEntries(id);
    expect(await call("select public.mark_vp_case_reviewed($1) as r", [id], president)).toMatchObject({ ok: true });
    expect(await undo(world.member, created.id)).toMatchObject({ ok: false, code: "PT409" });
    expect(await caseRow(id)).toMatchObject({ undone: false });
  });

  it("refuses to undo a case once its assigned steward set its identity privacy", async () => {
    const steward = await person(world.org, "steward");
    await start();
    const id = await openCase(world.coordinator, "Coordinator's own case");
    const [created] = await caseEntries(id);
    // The creator assigns the steward; that is the creator's own history, so only the steward's privacy decision is someone else's work.
    expect(await call("select public.assign_member_case($1, $2, null) as r", [id, steward.id], world.coordinator)).toMatchObject({ ok: true });
    expect(await call("select public.set_grievance_identity_private($1, true) as r", [id], steward)).toMatchObject({ ok: true });
    expect(await undo(world.coordinator, created.id)).toMatchObject({ ok: false, code: "PT409" });
    expect(await caseRow(id)).toMatchObject({ undone: false });
  });

  it("keeps an outcome whose earlier summary is too large for a before-image, and never fails the write", async () => {
    const id = await openCase(world.member);
    // 3,998 control characters each serialise as six JSON bytes: well past the 16,384-byte bound.
    const wide = `A${"\u0001".repeat(3998)}A`;
    expect(await call("select public.coordinator_record_case_outcome($1, 'other', $2) as r", [id, wide], world.coordinator)).toMatchObject({ ok: true });
    await start();
    expect(await call("select public.coordinator_record_case_outcome($1, 'settled', 'Paid back') as r", [id], world.coordinator)).toMatchObject({ ok: true });
    const kinds = (await entries("public.member_case_outcomes", id)).map((entry) => entry.action_kind);
    expect(kinds).toEqual(["case_outcome_kept"]);
    const kept = (await entries("public.member_case_outcomes", id))[0];
    expect(kept.state).toBe("kept");
    expect(await undo(world.coordinator, kept.id)).toMatchObject({ ok: false, code: "55000" });
  });

  it("undoes a case opened with details together with them, newest first", async () => {
    await start();
    const made = await one("select public.open_member_case(null, 'Unsafe ladder', 'Safety', '', null, 'Rung broken', null, null, null, false) as r", [], world.member);
    const journal = await caseEntries(made.caseId);
    expect(journal.map((entry) => entry.action_kind)).toEqual(["case_create", "case_edit"]);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [journal[0].id], world.member)).toMatchObject({ status: "undone", undoneCount: 2 });
    expect(await caseRow(made.caseId)).toMatchObject({ undone: true });
  });

  it("refuses to undo a case once someone else has worked on it, and changes nothing", async () => {
    await start();
    const id = await openCase(world.member);
    const [created] = await caseEntries(id);
    // A coordinator's note on it, written with the coordinator's claims.
    expect(await call("select public.coordinator_add_case_note($1, 'Called HR') as r", [id], world.coordinator)).toMatchObject({ ok: true });
    expect(await undo(world.member, created.id)).toMatchObject({ ok: false, code: "PT409" });
    expect(await caseRow(id)).toMatchObject({ undone: false });
    expect((await caseEntries(id))[0].state).toBe("active");
  });

  it("undoes the owner's own edit back to the earlier fields, and refuses after someone else's change", async () => {
    const id = await openCase(world.member);
    await start();
    await one("select public.update_my_member_case($1, 'resolved', '2026-12-01') as r", [id], world.member);
    // Repeating the same values changes nothing and journals nothing.
    await one("select public.update_my_member_case($1, 'resolved', '2026-12-01') as r", [id], world.member);
    const edits = await caseEntries(id);
    expect(edits.map((entry) => entry.action_kind)).toEqual(["case_edit"]);
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [edits[0].id], world.member)).toMatchObject({ status: "undone" });
    expect(await caseRow(id)).toMatchObject({ status: "active", deadline: null });
    await one("select public.update_my_member_case($1, 'resolved', null) as r", [id], world.member);
    // A change nobody journalled (another person, a worker): the fingerprint no longer matches.
    await c.query("update public.member_cases set title = 'Renamed by someone' where id = $1", [id]);
    const again = (await caseEntries(id)).at(-1);
    expect(await undo(world.member, again.id)).toMatchObject({ ok: false, code: "PT409" });
    expect(await caseRow(id)).toMatchObject({ status: "resolved" });
  });

  it("undoes a coordinator's outcome together with the status it set, back to no outcome", async () => {
    const id = await openCase(world.member);
    await start();
    expect(await call("select public.coordinator_record_case_outcome($1, 'settled', 'Paid back') as r", [id], world.coordinator)).toMatchObject({ ok: true });
    expect(await caseRow(id)).toMatchObject({ status: "resolved" });
    const [outcome] = await entries("public.member_case_outcomes", id);
    expect(outcome).toMatchObject({ action_kind: "case_outcome" });
    expect(outcome.parent_entry_id).toBe((await caseEntries(id))[0].id);
    // Undoing the child brings its parent: one action, all or nothing.
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [outcome.id], world.coordinator)).toMatchObject({ status: "undone", undoneCount: 2 });
    expect(await caseRow(id)).toMatchObject({ status: "active" });
    expect((await c.query("select count(*)::int as n from public.member_case_outcomes where case_id = $1", [id])).rows[0].n).toBe(0);
  });

  it("undoes a bulk update of cases all or nothing", async () => {
    const first = await openCase(world.member, "One");
    const second = await openCase(world.other, "Two");
    await start();
    expect(await call("select public.casework_bulk_update_cases($1::uuid[], 'active', 'resolved', null, $2) as r", [[first, second], randomUUID()], world.admin)).toMatchObject({ ok: true });
    const [child] = await caseEntries(first);
    expect(child.parent_entry_id).toBeTruthy();
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [child.id], world.admin)).toMatchObject({ status: "undone", undoneCount: 3 });
    expect([(await caseRow(first)).status, (await caseRow(second)).status]).toEqual(["active", "active"]);
    // A second bulk update, then someone else changes one case: nothing is undone.
    expect(await call("select public.casework_bulk_update_cases($1::uuid[], 'active', 'resolved', null, $2) as r", [[first, second], randomUUID()], world.admin)).toMatchObject({ ok: true });
    await c.query("update public.member_cases set title = 'Changed since' where id = $1", [second]);
    const next = (await caseEntries(first)).at(-1);
    expect(await undo(world.admin, next.id)).toMatchObject({ ok: false, code: "PT409" });
    expect([(await caseRow(first)).status, (await caseRow(second)).status]).toEqual(["resolved", "resolved"]);
  });

  it("undoes your own note as a tombstone hidden from reads, and only yours", async () => {
    const id = await openCase(world.member);
    await start();
    const note = await one("select public.add_my_case_update($1, ' Called HR ', '2026-10-05') as r", [id], world.member);
    expect(note).toMatchObject({ body: "Called HR", occurredOn: "2026-10-05" });
    // An undated note takes the column default, the Eastern day, as the direct insert did.
    const undated = await one("select public.add_my_case_update($1, 'Undated') as r", [id], world.member);
    expect(undated.occurredOn).toBe((await c.query("select ((now() at time zone 'America/New_York')::date)::text as d")).rows[0].d);
    const [added] = await entries("public.member_case_updates", note.id);
    expect(await undo(world.other, added.id)).toMatchObject({ ok: false, code: "P0002" });
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [added.id], world.member)).toMatchObject({ status: "undone" });
    expect(await one("select count(*)::int as n from public.member_case_updates where id = $1", [note.id], world.member)).toBe(0);
    expect((await c.query("select learning_undone_at is not null as undone from public.member_case_updates where id = $1", [note.id])).rows[0].undone).toBe(true);
  });

  it("undoes your own upload by requesting removal, refuses once you could no longer remove it, and keeps removals permanent", async () => {
    const id = await openCase(world.member);
    await start();
    const upload = async (user, name) => {
      const file = randomUUID();
      await c.query(`insert into public.member_case_files(id,case_id,user_id,bucket_id,object_name,filename,mime_type,size_bytes,uploaded_by,confirmed_at)
        values ($1,$2,$3,'case-files',$4,$5,'text/plain',9,$6,now())`, [file, id, world.member.id, `${id}/${file}.txt`, name, user.id]);
      // The confirm path's own journal call, with the uploader's claims.
      const entry = await one(`select private.learning_journal_append('case_file_upload', 'public.member_case_files', $1::text, null,
        private.learning_fingerprint(private.learning_case_file_state($1::uuid)), null, '{}'::jsonb) as r`, [file], user, true);
      return { file, entry };
    };
    const mine = await upload(world.member, "mine.txt");
    expect(await one("select public.undo_my_learning_action($1, 1) as r", [mine.entry], world.member)).toMatchObject({ status: "undone" });
    expect((await c.query("select removal_id is not null as requested, removal_requested_by from public.member_case_files where id = $1", [mine.file])).rows[0]).toEqual({ requested: true, removal_requested_by: world.member.id });
    // A coordinator's upload on the member's case, then the coordinator loses the role.
    const theirs = await upload(world.coordinator, "theirs.txt");
    await demote(world.coordinator);
    expect(await undo(world.coordinator, theirs.entry)).toMatchObject({ ok: false, code: "42501" });
    expect((await c.query("select removal_id is null as kept from public.member_case_files where id = $1", [theirs.file])).rows[0]).toEqual({ kept: true });
    // Removing a file is permanent.
    await one("select public.request_member_case_file_removal($1, $2) as r", [theirs.file, randomUUID()], world.member);
    const [removed] = (await entries("public.member_case_files", theirs.file)).filter((entry) => entry.action_kind === "case_file_remove");
    expect(removed).toMatchObject({ state: "kept" });
    expect(await undo(world.member, removed.id)).toMatchObject({ ok: false, code: "55000" });
  });

  it("takes away the direct client writes, and the RPCs keep the owner rule with no period", async () => {
    const id = await openCase(world.member);
    expect(await call("update public.member_cases set status = 'resolved' where id = $1", [id], world.member)).toMatchObject({ ok: false, code: "42501" });
    expect(await call("insert into public.member_case_updates(case_id, user_id, body) values ($1, $2, 'x')", [id, world.member.id], world.member)).toMatchObject({ ok: false, code: "42501" });
    expect(await call("select public.update_my_member_case($1, 'resolved', null) as r", [id], world.other)).toMatchObject({ ok: false, code: "42501" });
    expect(await call("select public.add_my_case_update($1, 'x') as r", [id], world.other)).toMatchObject({ ok: false, code: "42501" });
    expect(await call("select public.add_my_case_update($1, '   ') as r", [id], world.member)).toMatchObject({ ok: false, code: "22023" });
    await one("select public.update_my_member_case($1, 'resolved', null) as r", [id], world.member);
    expect(await caseRow(id)).toMatchObject({ status: "resolved" });
    expect(await caseEntries(id)).toEqual([]);
  });
});
