// @vitest-environment node
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const enabled = process.env.RUN_CASE_HISTORY_DB_TESTS === "1";
describe.skipIf(!enabled)("case history on a disposable database", () => {
  let db;
  const ids = Object.fromEntries(["org", "member", "steward", "coordinator", "advisor", "outsider", "case", "deadline", "checklist", "item", "extension", "retainedDeadline", "intakeDraft", "retentionRun"].map((key) => [key, randomUUID()]));
  const sessions = {};
  // Display names: a staff caller reads these from member_profiles under its
  // own RLS; a member never can, and falls back to the case assignee labels.
  const names = { member: "Dana Ruiz", steward: "Sam Okafor", coordinator: "Jordan Patel", advisor: "Avery Lind", outsider: "Outside Account" };
  async function as(user, sql, params = []) {
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated", aal: "aal2", session_id: sessions[user] })]);
    await db.query("set local role authenticated");
    try { return await db.query(sql, params); } finally { await db.query("reset role"); }
  }
  const history = async (user, limit = 100, before = null) => (await as(user, "select * from public.casework_case_history($1,$2,$3)", [ids.case, limit, before])).rows;
  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false });
    await db.connect();
    await db.query("begin");
    await db.query("insert into public.organizations(id,slug,name) values ($1,'p55-proof','History proof')", [ids.org]);
    await db.query("insert into public.chapters(id,name,region,order_index,organization_id,slug) values ('p55-chapter','Proof','Local',509,$1,'p55-proof')", [ids.org]);
    // "advisor" is an organization-wide grant with no coordinator grant and no
    // steward hat: private.casework_staff_can_access admits it to the case,
    // public.member_cases does not admit it to the case ROW, and
    // public.staff_visible_member_ids is empty for it.
    for (const role of ["member", "steward", "coordinator", "advisor", "outsider"]) {
      await db.query("insert into auth.users(id,email) values ($1,$2)", [ids[role], `p55-${role}@example.invalid`]);
      sessions[ids[role]] = randomUUID();
      await db.query("insert into auth.sessions(id,user_id,aal,created_at) values ($1,$2,'aal2',now())", [sessions[ids[role]],ids[role]]);
      if (role === "outsider") continue;
      await db.query("update public.member_profiles set chapter_id='p55-chapter', full_name=$2 where id=$1", [ids[role], names[role]]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [ids.org, ids[role]]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,'p55-chapter','active') on conflict do nothing", [ids[role]]);
      if (role !== "member") await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [ids.org, ids[role], role]);
    }
    await db.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa,updated_by) values (true,$1,false,$2)", [ids.org, ids.coordinator]);
    await db.query("insert into public.member_cases(id,user_id,reference,title,case_type,steward_user_id,coordinator_user_id,steward_name,coordinator_name) values ($1,$2,'P55-PROOF','History proof','grievance',$3,$4,'Assigned steward label','Assigned coordinator label')", [ids.case, ids.member, ids.steward, ids.coordinator]);

    // This broad-reader fixture is an
    // existing legacy grant; exercise its actual migration carry-over.
    await migrateLegacyStewardFixtures(db);
  }, 30000);
  afterAll(async () => { if (db) { await db.query("rollback"); await db.end(); } });

  it("installs one trigger on every original suite table and protects raw snapshots", async () => {
    const source = readFileSync(new URL("../supabase/migrations/20260828210000_mi1_casework_suite.sql", import.meta.url), "utf8");
    const expected = ["member_cases", ...[...source.matchAll(/create table public\.(casework_\w+)/g)].map((m) => m[1])].sort();
    const { rows } = await db.query("select c.relname from pg_trigger t join pg_class c on c.oid=t.tgrelid where t.tgname='casework_record_version' order by 1");
    expect(rows.map((r) => r.relname)).toEqual(expected);
    expect((await db.query("select has_table_privilege('authenticated','private.casework_record_versions','select') allowed")).rows[0].allowed).toBe(false);
    expect((await db.query("select has_function_privilege('anon','public.casework_case_history(uuid,integer,timestamptz)','execute') allowed")).rows[0].allowed).toBe(false);
  });

  it("captures insert/update/delete and actor, excludes timestamp-only updates, resolves child cases", async () => {
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: ids.steward, aal: "aal2" })]);
    await db.query("insert into public.casework_deadlines(id,case_id,organization_id,chapter_id,kind,label,due_at,created_by) values ($1,$2,$3,'p55-chapter','filing','Filing deadline',now()+interval '1 day',$4)", [ids.deadline, ids.case, ids.org, ids.steward]);
    await db.query("update public.casework_deadlines set updated_at=now()+interval '1 minute' where id=$1", [ids.deadline]);
    await db.query("update public.casework_deadlines set label='Extended filing deadline' where id=$1", [ids.deadline]);
    await db.query("delete from public.casework_deadlines where id=$1", [ids.deadline]);
    const versions = (await db.query("select * from private.casework_record_versions where record_id=$1 order by id", [ids.deadline])).rows;
    expect(versions.map((r) => r.op)).toEqual(["INSERT", "UPDATE", "DELETE"]);
    expect(versions.every((r) => r.case_id === ids.case && r.actor === ids.steward)).toBe(true);
    expect(versions[1].old_row.label).toBe("Filing deadline");
    expect(versions[1].new_row.label).toBe("Extended filing deadline");
    await db.query("insert into public.casework_checklists(id,case_id,organization_id,chapter_id,step,title,created_by) values ($1,$2,$3,'p55-chapter','Intake','Proof checklist',$4)", [ids.checklist, ids.case, ids.org, ids.steward]);
    await db.query("insert into public.casework_checklist_items(id,checklist_id,organization_id,label,position) values ($1,$2,$3,'Proof item',0)", [ids.item, ids.checklist, ids.org]);
    expect((await db.query("select case_id from private.casework_record_versions where record_id=$1", [ids.item])).rows[0].case_id).toBe(ids.case);
  });

  it("merges all six sources and applies each role's existing visibility", async () => {
    await db.query("insert into public.member_case_updates(case_id,user_id,body) values ($1,$2,'Public case note')", [ids.case, ids.member]);
    await db.query("insert into public.casework_step_transitions(case_id,organization_id,chapter_id,from_step,to_step,outcome,transitioned_by,idempotency_key) values ($1,$2,'p55-chapter','Intake','Step 1','Filed for review',$3,$4)", [ids.case, ids.org, ids.steward, randomUUID()]);
    await db.query("insert into public.member_case_assignment_audit(case_id,actor_id,actor_name,before_assignment,after_assignment) values ($1,$2,'Proof staff','{}','{}')", [ids.case, ids.coordinator]);
    await db.query("insert into public.coordinator_case_audit(case_id,user_id,actor_id,action,after_value) values ($1,$2,$3,'case_updated','{}')", [ids.case, ids.member, ids.coordinator]);
    await db.query("insert into public.casework_audit_events(organization_id,chapter_id,case_id,actor_user_id,event_type,entity_type,entity_id) values ($1,'p55-chapter',$2,$3,'strength_scored','case',$2)", [ids.org, ids.case, ids.steward]);
    const coordinator = await history(ids.coordinator);
    expect(new Set(coordinator.map((e) => e.kind))).toEqual(new Set(["note", "transition", "assignment", "coordinator", "audit", "fields"]));
    expect(coordinator.map((e) => e.at.getTime())).toEqual(coordinator.map((e) => e.at.getTime()).sort((a,b) => b-a));
    const steward = await history(ids.steward);
    expect(steward.some((e) => e.kind === "fields")).toBe(true);
    expect(steward.some((e) => ["assignment", "coordinator"].includes(e.kind))).toBe(false);
    // Staff-only member_cases columns must never reach the member through the field-diff projection.
    await db.query("update public.member_cases set title='Staff-only retitle', articles='Staff-only articles', steward_name='Reassigned steward label' where id=$1", [ids.case]);
    const member = await history(ids.member);
    expect(new Set(member.map((e) => e.kind))).toEqual(new Set(["note", "transition", "fields"]));
    for (const secret of ["Staff-only retitle", "Staff-only articles", "Proof staff", "case_updated", "strength_scored"]) expect(JSON.stringify(member)).not.toContain(secret);
    // steward_name is the assignee label the member's own case detail already
    // renders, so it may name an actor; it must still never arrive as a diff.
    expect(JSON.stringify(member.map((e) => e.details))).not.toContain("Reassigned steward label");
    expect(JSON.stringify(await history(ids.steward))).toContain("Staff-only retitle");
    expect(member.filter((e) => e.kind === "fields").every((e) => Object.keys(e.details.changes).every((key) => ["deadline","label","kind","due_at","status"].includes(key)))).toBe(true);
    expect(await history(ids.outsider)).toEqual([]);

    // WHO did each thing, resolved under the caller's own visibility only.
    const byActor = (rows, actor) => rows.filter((e) => e.actor_user_id === actor);
    // A staff caller already reads member_profiles for its own chapter, so the
    // real display name shows.
    const coordinatorRows = await history(ids.coordinator);
    expect(byActor(coordinatorRows, ids.steward).length).toBeGreaterThan(0);
    expect(byActor(coordinatorRows, ids.steward).every((e) => e.actor_name === "Sam Okafor" && e.actor_role === "steward")).toBe(true);
    expect(byActor(coordinatorRows, ids.member).every((e) => e.actor_name === "Dana Ruiz" && e.actor_role === "member")).toBe(true);
    // The member cannot read any staff profile: their own steward arrives as
    // the case's assignee label, their own note as their own name, and no
    // event carries a name the member could not already see.
    expect(byActor(member, ids.steward).length).toBeGreaterThan(0);
    expect(byActor(member, ids.steward).every((e) => e.actor_name === "Reassigned steward label" && e.actor_role === "steward")).toBe(true);
    expect(byActor(member, ids.member).every((e) => e.actor_name === "Dana Ruiz" && e.actor_role === "member")).toBe(true);
    expect(JSON.stringify(member)).not.toContain("Sam Okafor");
    // The same coordinator-authored event names the profile to a staff caller
    // and the case's own coordinator label to the member, so both branches of
    // the resolution are exercised by one row.
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: ids.coordinator, aal: "aal2" })]);
    await db.query("insert into public.casework_deadlines(id,case_id,organization_id,chapter_id,kind,label,due_at,created_by) values ($1,$2,$3,'p55-chapter','filing','Coordinator-authored deadline',now()+interval '2 days',$4)", [randomUUID(), ids.case, ids.org, ids.coordinator]);
    const byCoordinator = byActor(await history(ids.member), ids.coordinator);
    expect(byCoordinator.length).toBeGreaterThan(0);
    expect(byCoordinator.every((e) => e.actor_name === "Assigned coordinator label" && e.actor_role === "coordinator")).toBe(true);
    expect(byActor(await history(ids.steward), ids.coordinator).every((e) => e.actor_name === "Jordan Patel" && e.actor_role === "coordinator")).toBe(true);
    // A staff account the caller may not name keeps a role label, never a uuid.
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: ids.outsider, aal: "aal2" })]);
    await db.query("insert into public.casework_deadlines(id,case_id,organization_id,chapter_id,kind,label,due_at,created_by) values ($1,$2,$3,'p55-chapter','filing','Outside-authored deadline',now()+interval '3 days',$4)", [randomUUID(), ids.case, ids.org, ids.steward]);
    const memberFinal = await history(ids.member);
    const unnamed = byActor(memberFinal, ids.outsider);
    expect(unnamed.length).toBeGreaterThan(0);
    expect(unnamed.every((e) => e.actor_name === null && e.actor_role === "staff")).toBe(true);
    // Nothing the member receives is a name they could not already read. The
    // allow-list is exhaustive, so a uuid can never arrive as a display value.
    expect(memberFinal.some((e) => e.actor_user_id !== null)).toBe(true);
    expect(memberFinal.every((e) => e.actor_name === null || ["Reassigned steward label", "Assigned coordinator label", "Dana Ruiz"].includes(e.actor_name))).toBe(true);
    // Attribution detaches with the account; the projection stays null-safe.
    await db.query("update private.casework_record_versions set actor=null where record_table='casework_checklists' and case_id=$1", [ids.case]);
    const detached = (await history(ids.steward)).filter((e) => e.details?.table === "casework_checklists");
    expect(detached.length).toBeGreaterThan(0);
    expect(detached.every((e) => e.actor_user_id === null && e.actor_name === null && e.actor_role === null)).toBe(true);
  });

  it("labels roles for an organization advisor who cannot read the case row, and names nobody new", async () => {
    // The whole finding: private.casework_staff_can_access admits this caller
    // through private.has_organization_role, while member_cases_select_coordinator
    // demands public.staff_can_see_user(user_id, 'coordinator'), which it does not
    // hold. Zero member_cases rows is the precondition the repair has to survive.
    expect((await as(ids.advisor, "select count(*)::int n from public.member_cases where id=$1", [ids.case])).rows[0].n).toBe(0);
    // A member-authored event this caller CAN read. member_case_updates admits
    // only the author, a steward on the case and a coordinator who can see the
    // member, so an advisor's feed carries no note rows at all; that boundary is
    // unchanged here and widening it is exactly what this repair refuses. The
    // member's own change to the case row is the event that used to arrive
    // labelled 'staff'.
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: ids.member, aal: "aal2" })]);
    await db.query("update public.member_cases set deadline=now()+interval '5 days' where id=$1", [ids.case]);
    const advisor = await history(ids.advisor);
    expect(advisor.length).toBeGreaterThan(0);
    expect(advisor.every((e) => e.kind !== "note")).toBe(true);

    const byActor = (rows, actor) => rows.filter((e) => e.actor_user_id === actor);
    // Roles are correct even though the invoker read is empty. Before the
    // repair every one of these was 'staff' or null.
    expect(byActor(advisor, ids.member).length).toBeGreaterThan(0);
    expect(byActor(advisor, ids.member).every((e) => e.actor_role === "member")).toBe(true);
    expect(advisor.some((e) => e.kind === "fields" && e.actor_user_id === ids.member && e.actor_role === "member")).toBe(true);
    expect(byActor(advisor, ids.steward).length).toBeGreaterThan(0);
    expect(byActor(advisor, ids.steward).every((e) => e.actor_role === "steward")).toBe(true);
    expect(byActor(advisor, ids.coordinator).length).toBeGreaterThan(0);
    expect(byActor(advisor, ids.coordinator).every((e) => e.actor_role === "coordinator")).toBe(true);
    expect(byActor(advisor, ids.outsider).every((e) => e.actor_role === "staff")).toBe(true);
    expect(advisor.every((e) => e.actor_user_id === null || e.actor_role !== null)).toBe(true);

    // NAMES ARE UNCHANGED. The caller reads no member_profiles row but its own
    // and no member_cases row at all, so every actor stays unnamed, and no
    // display value is ever a uuid.
    expect(advisor.every((e) => e.actor_name === null)).toBe(true);
    for (const name of Object.values(names)) expect(JSON.stringify(advisor.map((e) => e.actor_name))).not.toContain(name);
    for (const id of [ids.member, ids.steward, ids.coordinator, ids.outsider]) {
      expect(advisor.every((e) => e.actor_name !== id)).toBe(true);
    }

    // Nobody else's attribution moved. Same actors, same names, same roles.
    const coordinatorRows = await history(ids.coordinator);
    expect(byActor(coordinatorRows, ids.steward).every((e) => e.actor_name === "Sam Okafor" && e.actor_role === "steward")).toBe(true);
    expect(byActor(coordinatorRows, ids.member).every((e) => e.actor_name === "Dana Ruiz" && e.actor_role === "member")).toBe(true);
    expect(byActor(coordinatorRows, ids.coordinator).every((e) => e.actor_name === "Jordan Patel" && e.actor_role === "coordinator")).toBe(true);
    const stewardRows = await history(ids.steward);
    expect(byActor(stewardRows, ids.coordinator).every((e) => e.actor_name === "Jordan Patel" && e.actor_role === "coordinator")).toBe(true);
    const memberRows = await history(ids.member);
    expect(byActor(memberRows, ids.steward).every((e) => e.actor_name === "Reassigned steward label" && e.actor_role === "steward")).toBe(true);
    expect(byActor(memberRows, ids.member).every((e) => e.actor_name === "Dana Ruiz" && e.actor_role === "member")).toBe(true);
    expect(byActor(memberRows, ids.outsider).every((e) => e.actor_name === null && e.actor_role === "staff")).toBe(true);
    // No caller gained a name it could not read before: the member's allow-list
    // is still exactly the two assignee labels plus its own profile name.
    expect(memberRows.every((e) => e.actor_name === null || ["Reassigned steward label", "Assigned coordinator label", "Dana Ruiz"].includes(e.actor_name))).toBe(true);
    expect(JSON.stringify(memberRows)).not.toContain("Sam Okafor");
    // The definer helper is bound to private.casework_can_read, not to the hat:
    // a caller with no read on the case gets no labels from it either.
    expect((await as(ids.outsider, "select count(*)::int n from private.casework_case_actor_roles($1,$2::uuid[])", [ids.case, [ids.member, ids.steward]])).rows[0].n).toBe(0);
    expect((await as(ids.advisor, "select count(*)::int n from private.casework_case_actor_roles($1,$2::uuid[])", [ids.case, [ids.member, ids.steward]])).rows[0].n).toBe(2);
  });

  it("bounds the caller-chosen actor-id array on the definer role helper", async () => {
    // The array is chosen by the caller, not derived from the page, so the
    // helper is a bounded same-case assignee oracle. These pins and refusals
    // are what keeps it from being sweepable in one statement.
    const migration = readFileSync(new URL("../supabase/migrations/20260918203000_casework_case_history_actor_roles.sql", import.meta.url), "utf8");
    expect(migration).toContain("if pg_catalog.array_length(p_actor_user_ids, 1) > 100 then");
    expect(migration).toContain("pg_catalog.array_position(p_actor_user_ids, null) is not null");
    // The reader can never trip its own guard: `rows with ties` may exceed the
    // clamped page size, so the distinct actor list is capped at the same 100.
    expect(migration).toContain("where page.actor_user_id is not null limit 100");

    const probe = async (candidates, message) => {
      await db.query("savepoint actor_role_guard");
      let failure = null;
      try {
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids.advisor, role: "authenticated", aal: "aal2", session_id: sessions[ids.advisor] })]);
        await db.query("set local role authenticated");
        await db.query("select * from private.casework_case_actor_roles($1,$2::uuid[])", [ids.case, candidates]);
      } catch (error) { failure = error; }
      await db.query("rollback to savepoint actor_role_guard");
      await db.query("reset role");
      expect(failure?.code).toBe("22023");
      expect(failure?.message).toContain(message);
    };
    await probe(Array.from({ length: 101 }, () => randomUUID()), "too many case actor ids");
    await probe([ids.member, null], "must not contain null");

    // The boundary itself is accepted, and the page cap is the boundary.
    const atCap = [ids.member, ...Array.from({ length: 99 }, () => randomUUID())];
    const accepted = (await as(ids.advisor, "select * from private.casework_case_actor_roles($1,$2::uuid[])", [ids.case, atCap])).rows;
    expect(accepted).toHaveLength(100);
    expect(accepted.filter((row) => row.actor_user_id === ids.member)).toEqual([{ actor_user_id: ids.member, actor_role: "member" }]);
    expect(accepted.filter((row) => row.actor_role !== "member").every((row) => row.actor_role === "staff")).toBe(true);
    // An empty or null array is a question with no ids, not an error.
    expect((await as(ids.advisor, "select count(*)::int n from private.casework_case_actor_roles($1,$2::uuid[])", [ids.case, []])).rows[0].n).toBe(0);
    expect((await as(ids.advisor, "select count(*)::int n from private.casework_case_actor_roles($1,null)", [ids.case])).rows[0].n).toBe(0);
  });

  // BUG-UG-CASE-HISTORY-STAFF-NOTES-ATTRIBUTED-TO-THE-MEMBER-20260920:
  // both staff note writers store the case member in user_id; the feed must
  // still name the staff author, with the author's role, for every reader.
  it("attributes staff-written notes to their author and member notes to the member", async () => {
    await db.query("reset role");
    // Both note writers are coordinator writers behind a staff second factor.
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), ids.coordinator]);
    const quickNote = (await as(ids.coordinator, "select public.coordinator_add_case_note($1,'Coordinator quick note') v", [ids.case])).rows[0].v.id;
    const deskNote = (await as(ids.coordinator, "select public.casework_add_case_note($1,'Coordinator desk note','{}'::uuid[]) v", [ids.case])).rows[0].v;
    const deskNoteId = deskNote.id ?? deskNote.noteId ?? deskNote.updateId;
    expect(deskNoteId).toBeTruthy();
    // A member cannot choose an author: the column is stamped from the session.
    // The member's own note goes through add_my_case_update since 20261104075000
    // (REQ-UG-LEARNING-PERIOD-CASE-RECORDS-20261103); a direct insert,
    // forged author or not, is refused.
    const memberNote = (await as(ids.member, "select (public.add_my_case_update($1, 'Member-written note')) ->> 'id' as id", [ids.case])).rows[0].id;
    await db.query("savepoint forged");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids.member, role: "authenticated", aal: "aal2", session_id: sessions[ids.member] })]);
    await db.query("set local role authenticated");
    const forged = await db.query("insert into public.member_case_updates(case_id,user_id,body,author_user_id) values ($1,$2,'Forged',$3)", [ids.case, ids.member, ids.steward]).then(() => null, (error) => error.code);
    await db.query("rollback to savepoint forged");
    expect(forged).toBe("42501");
    const stored = (await db.query("select id, user_id, author_user_id from public.member_case_updates where id = any($1::uuid[])", [[quickNote, deskNoteId, memberNote]])).rows;
    expect(stored).toHaveLength(3);
    expect(stored.every((row) => row.user_id === ids.member)).toBe(true);
    expect(Object.fromEntries(stored.map((row) => [row.id, row.author_user_id]))).toEqual({ [quickNote]: ids.coordinator, [deskNoteId]: ids.coordinator, [memberNote]: ids.member });

    const note = (rows, id) => rows.find((e) => e.event_id === `note:${id}`);
    const member = await history(ids.member);
    for (const id of [quickNote, deskNoteId]) {
      expect(note(member, id)).toMatchObject({ actor_user_id: ids.coordinator, actor_name: "Assigned coordinator label", actor_role: "coordinator" });
    }
    expect(note(member, memberNote)).toMatchObject({ actor_user_id: ids.member, actor_name: "Dana Ruiz", actor_role: "member" });
    expect(JSON.stringify(member)).not.toContain("Jordan Patel");
    const steward = await history(ids.steward);
    for (const id of [quickNote, deskNoteId]) {
      expect(note(steward, id)).toMatchObject({ actor_user_id: ids.coordinator, actor_name: "Jordan Patel", actor_role: "coordinator" });
    }
    expect(note(steward, memberNote)).toMatchObject({ actor_user_id: ids.member, actor_name: "Dana Ruiz", actor_role: "member" });

    // The author is immutable except for account deletion's SET NULL, after
    // which the note falls back to the case member attribution.
    await db.query("update public.member_case_updates set author_user_id=$2 where id=$1", [quickNote, ids.outsider]);
    expect((await db.query("select author_user_id from public.member_case_updates where id=$1", [quickNote])).rows[0].author_user_id).toBe(ids.coordinator);
    await db.query("update public.member_case_updates set author_user_id=null where id=$1", [quickNote]);
    expect(note(await history(ids.member), quickNote)).toMatchObject({ actor_user_id: ids.member, actor_role: "member" });
    expect((await db.query("select delete_disposition from private.account_lifecycle_manifest where table_name='member_case_updates' and user_column='author_user_id'")).rows).toEqual([{ delete_disposition: "pseudonymize" }]);
  });

  it("paginates timestamp ties without loss or duplicates", async () => {
    // pg's default Date parser loses microseconds; request text for cursor proof.
    const all = (await as(ids.coordinator, "select event_id,at::text from public.casework_case_history($1,100,null)", [ids.case])).rows;
    const seen = [];
    let before = null;
    do {
      const page = (await as(ids.coordinator, "select event_id,at::text from public.casework_case_history($1,1,$2)", [ids.case, before])).rows;
      if (!page.length) break;
      seen.push(...page.map((e) => e.event_id));
      before = page.at(-1).at;
    } while (seen.length <= all.length);
    expect(seen).toEqual(all.map((e) => e.event_id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("honors private reminder ownership, restrictions and live revocation", async () => {
    const reminder = randomUUID();
    await db.query("insert into public.casework_reminders(id,case_id,organization_id,chapter_id,owner_user_id,title,remind_at) values ($1,$2,$3,'p55-chapter',$4,'Private staff reminder',now())", [reminder, ids.case, ids.org, ids.coordinator]);
    expect(JSON.stringify(await history(ids.steward))).not.toContain("Private staff reminder");
    expect(JSON.stringify(await history(ids.coordinator))).toContain("Private staff reminder");
    await db.query("update public.member_cases set is_restricted=true,restriction_reason='Sensitive private case',restricted_at=now(),restricted_by=$2,coordinator_user_id=null where id=$1", [ids.case, ids.steward]);
    expect(await history(ids.coordinator)).toEqual([]);
    const restrictedMember = await history(ids.member);
    expect(restrictedMember.length).toBeGreaterThan(0);
    expect(JSON.stringify(restrictedMember)).not.toMatch(/Sensitive private case|is_restricted|restricted_by|coordinator_user_id/);
  });

  it("keeps detached deadline-extension history case-bound and filters private reasons", async () => {
    // SEC-UG-CASEWORK-DEADLINES-ALERTS-INSERT-MISSING-EVENT-ROW-20260920
    // retired the direct authenticated INSERT; the audited definer routine is
    // the staff creation route and mints the id.
    ids.retainedDeadline = (await as(ids.steward, "select id from public.casework_create_deadline($1,'filing','Remaining deadline',now()+interval '1 day',null)", [ids.case])).rows[0].id;
    await db.query("insert into public.casework_deadline_extensions(id,deadline_id,organization_id,requested_by,previous_due_at,requested_due_at,reason,idempotency_key) values ($1,$2,$3,$4,now(),now()+interval '2 days','Private extension reason',$5)", [ids.extension, ids.retainedDeadline, ids.org, ids.steward, randomUUID()]);
    const memberRows = await history(ids.member);
    expect(memberRows.some((r) => r.details.table === "casework_deadline_extensions")).toBe(true);
    expect(JSON.stringify(memberRows)).not.toContain("Private extension reason");
    expect(JSON.stringify(await history(ids.steward))).toContain("Private extension reason");
    // Keep the deadline until case deletion, which retains/detaches extensions.
    // Also simulate children created before auditing was installed.
    await db.query("delete from private.casework_record_versions where record_id=any($1::text[])", [[ids.checklist, ids.item]]);
  });

  it("honors the MFA boundary on the RPC and private projection", async () => {
    await db.query("update public.org_security_policy set require_staff_mfa=true where organization_id=$1", [ids.org]);
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: ids.steward, role: "authenticated", aal: "aal1", session_id: sessions[ids.steward] })]);
    await db.query("set local role authenticated");
    expect((await db.query("select * from public.casework_case_history($1,100,null)", [ids.case])).rows).toEqual([]);
    expect((await db.query("select * from private.casework_history_versions($1)", [ids.case])).rows).toEqual([]);
    await db.query("reset role");
    await db.query("update public.org_security_policy set require_staff_mfa=false where organization_id=$1", [ids.org]);
  });

  it("makes organization-scoped versions retention-eligible and deletes them while case-scoped versions stay", async () => {
    await db.query("reset role");
    const eligible = async (days) => (await db.query("select private.retention_eligible_count($1,'casework_record_versions',$2) n", [ids.org, days])).rows[0].n;
    const caseScoped = async () => (await db.query("select count(*)::int n from private.casework_record_versions where case_id=$1", [ids.case])).rows[0].n;
    // Nothing else in this organization is organization-scoped and past a
    // 180-day window, so the count below is attributable to the draft alone.
    expect(await eligible(180)).toBe(0);
    const before = await caseScoped();
    expect(before).toBeGreaterThan(0);

    // An intake draft written before a case exists is the record's own example:
    // the version carries organization_id and no case_id, so nothing but the
    // organization's own deletion ever reached it.
    await db.query("insert into public.casework_intake_drafts(id,organization_id,chapter_id,owner_user_id,payload) values ($1,$2,'p55-chapter',$3,'{\"summary\":\"draft\"}'::jsonb)", [ids.intakeDraft, ids.org, ids.coordinator]);
    const orgScoped = (await db.query("select id, case_id, organization_id from private.casework_record_versions where record_table='casework_intake_drafts' and record_id=$1", [ids.intakeDraft])).rows;
    expect(orgScoped).toHaveLength(1);
    expect(orgScoped[0].case_id).toBe(null);
    expect(orgScoped[0].organization_id).toBe(ids.org);

    // Fresh rows are not eligible; the window is the whole disposition.
    expect(await eligible(180)).toBe(0);
    await db.query("update private.casework_record_versions set at = now() - interval '400 days' where id=$1", [orgScoped[0].id]);
    expect(await eligible(180)).toBe(1);
    expect(await eligible(3650)).toBe(0);
    // Ageing every case-scoped version changes nothing: case_id is null is the
    // branch, not age.
    await db.query("update private.casework_record_versions set at = now() - interval '400 days' where case_id=$1", [ids.case]);
    expect(await eligible(180)).toBe(1);

    await db.query("insert into public.organization_retention_policies(organization_id,data_class,retention_days,execution_enabled,updated_by) values ($1,'casework_record_versions',180,true,$2)", [ids.org, ids.coordinator]);
    await db.query("insert into public.organization_retention_runs(id,organization_id,data_class,retention_days,mode,status,eligible_count,requested_by,authorized_by,authorized_at,authorization_expires_at) values ($1,$2,'casework_record_versions',180,'manual','authorized',1,$3,$3,now(),now()+interval '15 minutes')", [ids.retentionRun, ids.org, ids.coordinator]);
    const result = (await db.query("select private.perform_organization_retention_run($1) r", [ids.retentionRun])).rows[0].r;
    expect(result.status).toBe("completed");
    expect(result.deletedCount).toBe(1);
    expect(result.remainingCount).toBe(0);

    expect((await db.query("select count(*)::int n from private.casework_record_versions where record_id=$1", [ids.intakeDraft])).rows[0].n).toBe(0);
    expect(await caseScoped()).toBe(before);
    const run = (await db.query("select status, deleted_count, remaining_count from public.organization_retention_runs where id=$1", [ids.retentionRun])).rows[0];
    expect(run).toEqual({ status: "completed", deleted_count: 1, remaining_count: 0 });
    expect((await db.query("select count(*)::int n from public.organization_audit_ledger where entity_id=$1 and event_type='retention.completed' and metadata->>'dataClass'='casework_record_versions' and metadata->>'operation'='delete'", [ids.retentionRun])).rows[0].n).toBe(1);
    // The disposition is readable from the deletion inventory, not only here.
    expect((await db.query("select note from private.account_lifecycle_manifest where table_name='casework_record_versions'")).rows[0].note).toContain("casework_record_versions data class");
  });

  it("cascades versions with the case and records the lifecycle dispositions", async () => {
    await db.query("reset role");
    await db.query("delete from public.member_cases where id=$1", [ids.case]);
    expect((await db.query("select count(*)::int n from private.casework_record_versions where case_id=$1 or record_id=any($2::text[])", [ids.case, [ids.case, ids.checklist, ids.item, ids.extension, ids.retainedDeadline]])).rows[0].n).toBe(0);
    expect((await db.query("select delete_disposition from private.account_lifecycle_manifest where table_name='casework_record_versions'")).rows).toEqual([{ delete_disposition: "pseudonymize" }]);
    expect((await db.query("select * from private.account_lifecycle_unmanaged_restrictive_fks()")).rows).toEqual([]);
  });
});
