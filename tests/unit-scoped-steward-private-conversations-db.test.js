// @vitest-environment node
//
// SEC-UG-UNIT-SCOPED-STEWARD-READS-OTHER-UNIT-PRIVATE-CONVERSATIONS-20261111 (#8308)
//
// Row-level security hides another unit's private conversations from a
// steward limited to one unit (private.staff_visible_member_ids), but the
// SECURITY DEFINER message functions decided through
// private.can_actor_send_private_message -> private.staff_actor_can_see_user,
// which ignored unit and committee scopes. With a conversation or message id,
// the unit-limited steward read contact notes and the member's words, replied
// and scheduled messages. The helper now applies the scopes, so every caller
// follows the boundary row-level security already draws.
//
// Fixture: one chapter with two units. Steward A is limited to unit A (set
// through the product's own set_member_access_role); steward B is a chapter
// steward with no scope and is the unit-B member's own steward. Every probe
// runs as steward A on the unit-B member's conversation (refused, or nothing
// returned and nothing written) and on the unit-A member's conversation
// (allowed), and the four leaking functions also as the conversation's own
// steward (allowed). Everything runs in one transaction that is rolled back.
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";

const STEM = "unit_scoped_steward_private_conversations";

describe("unit-scoped stewards and private conversations (static)", () => {
  let migration = "";
  beforeAll(() => { migration = stripComments(loadMigrationSql(STEM)); });

  it("sorts after the migration line waiting at registration and repairs the shared helper", () => {
    expect(findMigrationName(STEM) > "20261112004329").toBe(true);
    expect(migration).toContain("set local search_path = pg_catalog;");
    expect(migration).toMatch(/create or replace function private\.staff_actor_can_see_user\(/i);
    expect(migration).toContain("private.actor_role_covers_member(p_actor, target_chapter.id, 'steward', p_target)");
    const entry = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8")).functions
      .find((row) => row.sig === "private.staff_actor_can_see_user(p_actor uuid, p_target uuid)");
    // : #7663 re-emits this helper after #8382; validate the composed source.
    const combined = loadMigrationSql("stewards_require_unit_with_carry_over");
    for (const pinned of entry.bodyContains) expect(combined, pinned).toContain(pinned);
    expect(entry.bodyContains).toContain("private.steward_assignment_scopes(p_actor,target_chapter.id)");
  });

  it("is registered in the required database proof lane", () => {
    expect(PROOF_FILES).toContain("tests/unit-scoped-steward-private-conversations-db.test.js");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("unit-scoped stewards and private conversations on a disposable database", () => {
  let db;
  const f = { org: randomUUID(), unitA: randomUUID(), unitB: randomUUID(), people: {}, conv: {}, msg: {} };
  f.chapter = `unit-private-${f.org}`;
  const B_SECRETS = ["Private words of memberB", "Contact note about memberB"];

  async function as(name) {
    await db.query("reset role");
    const person = f.people[name];
    await db.query("select set_config('request.jwt.claims', $1, true)",
      [JSON.stringify({ sub: person.id, session_id: person.session, role: "authenticated", aal: "aal2" })]);
    await db.query("set local role authenticated");
  }
  const owner = async () => { await db.query("reset role"); await db.query("select set_config('request.jwt.claims', '', true)"); };
  // One call as a person, rolled back: { ok, value } or { ok: false, code, message }.
  async function attempt(name, sql, args = []) {
    await db.query("savepoint attempt");
    try {
      await as(name);
      const value = (await db.query(sql, args)).rows[0]?.v;
      await owner();
      await db.query("rollback to savepoint attempt");
      return { ok: true, value };
    } catch (error) {
      await db.query("rollback to savepoint attempt");
      await owner();
      return { ok: false, code: error.code, message: error.message };
    }
  }
  // Refused, or answered with nothing of the unit-B member's conversation.
  const refusedOrEmpty = (name, result, hidden) => {
    if (!result.ok) {
      expect(["42501", "22023", "P0002"], `${name}: ${result.message}`).toContain(result.code);
      return;
    }
    const text = JSON.stringify(result.value ?? null);
    for (const secret of hidden) expect(text, `${name} answered with ${secret}`).not.toContain(secret);
  };
  const allowed = (name, result) => expect(result.ok, `${name}: ${result.message}`).toBe(true);

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "unit-scoped-steward-private-conversations-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Fictional Harbor Local')", [f.org]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,'Harbor Main',$1,$2,9991)", [f.chapter, f.org]);
    for (const name of ["admin", "stewardA", "stewardB", "eventAdmin", "memberA", "memberB"]) {
      const id = randomUUID(), session = randomUUID();
      f.people[name] = { id, session };
      await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${id}@example.invalid`]);
      await db.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id, f.chapter, `Fictional ${name}`]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, id]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [f.org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, f.chapter]);
      for (const role of name.startsWith("steward") || name === "eventAdmin" ? ["steward"] : []) {
        await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [id, role, f.chapter]);
        await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [id, role, f.chapter]);
      }
    }
    // The event admin is a chapter admin whose steward role is limited to unit A.
    await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'admin',$2)", [f.people.eventAdmin.id, f.chapter]);
    await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'admin',$2)", [f.people.eventAdmin.id, f.chapter]);
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'admin')", [f.org, f.people.admin.id]);
    await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$3,$4,'Shared Living'),($2,$3,$4,'Group Homes')", [f.unitA, f.unitB, f.org, f.chapter]);
    // B's pre-existing broad steward
    // control is represented by the actual migration, never a runtime bypass.
    await migrateLegacyStewardFixtures(db);
    await as("admin");
    for (const [name, unit] of [["memberA", f.unitA], ["stewardA", f.unitA], ["eventAdmin", f.unitA], ["memberB", f.unitB], ["stewardB", f.unitB]]) {
      await db.query("select public.set_chapter_access_member($1,$2,$3,null,true)", [f.chapter, f.people[name].id, unit]);
    }
    for (const name of ["stewardA", "eventAdmin"]) {
      await db.query("select public.set_member_access_role($1,$2,'steward',true,$3,null)", [f.people[name].id, f.chapter, f.unitA]);
    }
    await owner();
    // Each member's private conversation with their own steward: one message and one contact note.
    for (const [member, steward] of [["memberA", "stewardA"], ["memberB", "stewardB"]]) {
      f.conv[member] = (await db.query("insert into public.member_conversations(user_id,title,steward_user_id,organization_id) values($1,'Fictional thread',$2,$3) returning id",
        [f.people[member].id, f.people[steward].id, f.org])).rows[0].id;
      f.msg[member] = (await db.query("insert into public.member_messages(conversation_id,user_id,sender_kind,sender_name,body,sender_id) values($1,$2,'member','Fictional member','Private words of '||$3,$2) returning id",
        [f.conv[member], f.people[member].id, member])).rows[0].id;
      await db.query("insert into public.member_contact_notes(conversation_id,member_user_id,chapter_id,author_id,note) values($1,$2,$3,$4,'Contact note about '||$5)",
        [f.conv[member], f.people[member].id, f.chapter, f.people[steward].id, member]);
    }
    // A published chapter document both members and both stewards can read. Its
    // trigger takes the chapter and author from the signed-in admin.
    await as("admin");
    await db.query("reset role");
    f.document = (await db.query("insert into public.chapter_documents(chapter_id,title,document_type,status,visibility,published_at,created_by) values($1,'Fictional handbook','policy','published','chapter',now(),$2) returning id",
      [f.chapter, f.people.admin.id])).rows[0].id;
    await owner();
    // A pulse chart steward A owns.
    await as("stewardA");
    f.chart = (await db.query("select public.save_pulse_chart(null,'Fictional sign-ups',$1::jsonb,'chapter',false,false,'steward') v",
      [JSON.stringify({ version: 1, measure: "published_actions", breakdown: "month", period: "12m", form: "bars" })])).rows[0].v;
    await owner();
    // An event steward A organizes; each member said going and opted in to contact,
    // and each has one contact message linked from their own conversation.
    f.event = `unit-private-event-${f.org}`;
    await db.query("insert into public.member_events(id,title,starts_at,location,summary,order_index,chapter_id,organizer_id) values($1,'Fictional meeting',now()+interval '3 days','Hall','Meeting',(select coalesce(max(order_index),0)+1 from public.member_events),$2,$3)",
      [f.event, f.chapter, f.people.stewardA.id]);
    for (const member of ["memberA", "memberB"]) {
      await db.query("insert into public.member_event_rsvps(event_id,user_id,status) values($1,$2,'going')", [f.event, f.people[member].id]);
      await db.query("insert into private.member_event_contact_opt_ins(event_id,user_id,organizer_id) values($1,$2,$3)", [f.event, f.people[member].id, f.people.stewardA.id]);
      await db.query("insert into private.member_event_contact_links(message_id,event_id,organizer_id,participant_id,sender_role) values($1,$2,$3,$4,'participant')",
        [f.msg[member], f.event, f.people.stewardA.id, f.people[member].id]);
    }
  }, 60_000);
  beforeEach(async () => { await db.query("savepoint proof_case"); });
  afterEach(async () => { await db.query("rollback to savepoint proof_case"); });
  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  const writes = async () => (await db.query(
    `select (select count(*) from public.member_messages where conversation_id = $1)::int messages,
            (select count(*) from public.member_scheduled_messages where conversation_id = $1)::int scheduled,
            (select count(*) from public.member_contact_notes where conversation_id = $1)::int notes`,
    [f.conv.memberB])).rows[0];

  it("keeps row-level security hiding the other unit's conversation from the unit steward", async () => {
    const seen = await attempt("stewardA", "select jsonb_build_object('conversations',(select count(*) from public.member_conversations where id=$1),'messages',(select count(*) from public.member_messages where conversation_id=$1)) v", [f.conv.memberB]);
    expect(seen.value).toEqual({ conversations: 0, messages: 0 });
  });

  // The four functions the audit saw leaking.
  const LEAKING = [
    ["list_member_contact_notes", "select public.list_member_contact_notes($1) v", (m) => [f.conv[m]]],
    ["get_member_message_replies", "select public.get_member_message_replies('private',$1,$2,null,null,20) v", (m) => [f.msg[m], f.conv[m]]],
    ["reply_to_member_message", "select public.reply_to_member_message('private',$1,'Fictional probe reply') v", (m) => [f.msg[m]]],
    ["schedule_member_message", "select public.schedule_member_message($1,'Fictional probe',now()+interval '2 days') v", (m) => [f.conv[m]]],
  ];

  it("refuses the four leaking functions for another unit's member, and writes nothing there", async () => {
    const before = await writes();
    for (const [name, sql, args] of LEAKING) refusedOrEmpty(name, await attempt("stewardA", sql, args("memberB")), [...B_SECRETS, f.msg.memberB]);
    for (const [name, sql, args] of LEAKING.filter(([name]) => name === "reply_to_member_message" || name === "schedule_member_message")) {
      const result = await attempt("stewardA", sql, args("memberB"));
      expect(result.ok, `${name} wrote into the other unit's conversation`).toBe(false);
    }
    expect(await writes()).toEqual(before);
  });

  it("still allows the unit steward on their own unit's member, and the conversation's own steward", async () => {
    for (const [name, sql, args] of LEAKING) {
      allowed(`${name} as the unit steward on unit A`, await attempt("stewardA", sql, args("memberA")));
      allowed(`${name} as the conversation's own steward`, await attempt("stewardB", sql, args("memberB")));
    }
    const notes = await attempt("stewardB", "select public.list_member_contact_notes($1) v", [f.conv.memberB]);
    expect(JSON.stringify(notes.value)).toContain("Contact note about memberB");
  });

  it("refuses redacting another unit's private message with 42501", async () => {
    const result = await attempt("stewardA", "select public.redact_member_message($1) v", [f.msg.memberB]);
    expect(result).toMatchObject({ ok: false, code: "42501" });
    expect((await db.query("select body,redacted_at from public.member_messages where id=$1", [f.msg.memberB])).rows)
      .toEqual([{ body: "Private words of memberB", redacted_at: null }]);
  });

  it("still redacts the unit steward's own unit's private message", async () => {
    const result = await attempt("stewardA", "select public.redact_member_message($1) v", [f.msg.memberA]);
    allowed("redaction inside the steward's unit", result);
    expect(result.value).toMatchObject({ redacted: true, reasonCode: "staff_removed", message: { body: "" } });
    expect(result.value.message.redacted_at).toBeTruthy();
  });

  it("preserves member-own removal and existing admin and coordinator moderation", async () => {
    const own = await attempt("memberA", "select public.redact_member_message($1) v", [f.msg.memberA]);
    allowed("member removes their own message", own);
    expect(own.value).toMatchObject({ redacted: true, reasonCode: "sender_removed" });
    const admin = await attempt("admin", "select public.redact_member_message($1) v", [f.msg.memberB]);
    allowed("organization admin moderates in the chapter", admin);
    expect(admin.value).toMatchObject({ redacted: true, reasonCode: "staff_removed" });
    await owner();
    await db.query("delete from public.organization_role_grants where user_id=$1 and role='admin'", [f.people.admin.id]);
    await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'coordinator',$2)", [f.people.admin.id, f.chapter]);
    await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'coordinator',$2)", [f.people.admin.id, f.chapter]);
    const coordinator = await attempt("admin", "select public.redact_member_message($1) v", [f.msg.memberB]);
    allowed("chapter coordinator moderates in the chapter", coordinator);
    expect(coordinator.value).toMatchObject({ redacted: true, reasonCode: "staff_removed" });
  });

  it("keeps legacy no-organization staff moderation within its existing reader coverage", async () => {
    await owner();
    const chapter = `legacy-private-${randomUUID()}`;
    // Stage one historical chapter, as the other legacy fixtures do. New
    // ownerless chapters stay prohibited; restore the exact guard before
    // creating callers or exercising any authenticated behavior.
    await db.query("alter table public.chapters disable trigger chapters_forbid_ownerless_write");
    await db.query("insert into public.chapters(id,name,slug,order_index) values($1,'Fictional legacy chapter',$1,(select coalesce(max(order_index),0)+1 from public.chapters))", [chapter]);
    await db.query("alter table public.chapters enable trigger chapters_forbid_ownerless_write");
    expect((await db.query("select tgenabled from pg_catalog.pg_trigger where tgrelid='public.chapters'::regclass and tgname='chapters_forbid_ownerless_write'")).rows)
      .toEqual([{ tgenabled: "O" }]);
    for (const name of ["legacySteward", "legacyMember"]) {
      const id = randomUUID(), session = randomUUID(); f.people[name] = { id, session };
      await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${id}@example.invalid`]);
      await db.query("update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1", [id, chapter, `Fictional ${name}`]);
      await db.query("delete from public.organization_memberships where user_id=$1", [id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, chapter]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, id]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    }
    await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'steward',$2)", [f.people.legacySteward.id, chapter]);
    await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'steward',$2)", [f.people.legacySteward.id, chapter]);
    const conversation = (await db.query("insert into public.member_conversations(user_id,title,steward_user_id) values($1,'Fictional legacy private thread',$2) returning id", [f.people.legacyMember.id, f.people.legacySteward.id])).rows[0].id;
    const message = (await db.query("insert into public.member_messages(conversation_id,user_id,sender_kind,sender_name,body,sender_id) values($1,$2,'member','Fictional legacy member','Fictional legacy body',$2) returning id", [conversation, f.people.legacyMember.id])).rows[0].id;
    const result = await attempt("legacySteward", "select public.redact_member_message($1) v", [message]);
    allowed("legacy steward moderates within existing read coverage", result);
    expect(result.value).toMatchObject({ redacted: true, reasonCode: "staff_removed" });
  });

  // The eleven other callers of the same helper.
  const OTHERS = [
    ["get_member_message_actions", "select public.get_member_message_actions('private',$1) v", (m) => [f.msg[m]], "stewardA"],
    ["get_member_message_reply_counts", "select public.get_member_message_reply_counts('private',array[$1]::uuid[]) v", (m) => [f.msg[m]], "stewardA"],
    ["toggle_member_message_reaction", "select public.toggle_member_message_reaction('private',$1,'like') v", (m) => [f.msg[m]], "stewardA"],
    ["toggle_member_saved_message", "select public.toggle_member_saved_message('private',$1) v", (m) => [f.msg[m]], "stewardA"],
    ["create_member_message_reminder", "select public.create_member_message_reminder('private',$1,now()+interval '1 day','Fictional reminder') v", (m) => [f.msg[m]], "stewardA"],
    ["send_steward_resource", "select public.send_steward_resource($1,$2,'Fictional resource') v", (m) => [f.conv[m], f.document], "stewardA"],
    ["send_member_resource", "select public.send_member_resource($1,$2,'Fictional resource') v", (m) => [f.conv[m], f.document], "stewardA"],
    ["share_pulse_chart", "select public.share_pulse_chart($1,'steward','message',$2) v", (m) => [f.chart, f.conv[m]], "stewardA"],
    ["create_event_from_member_message", "select public.create_event_from_member_message($1,$2,'Fictional event',now()+interval '4 days','Hall','Fictional','SG-UNITPROBE') v", (m) => [f.msg[m], `unit-probe-${randomUUID()}`], "eventAdmin"],
    ["get_connected_workflow_context", "select public.get_connected_workflow_context('private_message',$1::text,null,null) v", (m) => [f.msg[m]], "stewardA"],
    ["list_member_event_contact_messages", "select public.list_member_event_contact_messages($1,$2,null,20) v", (m) => [f.event, f.people[m].id], "stewardA"],
  ];

  // The callers that write (a reaction, a saved message, a reminder, a message,
  // an event). Each is rolled back by attempt(), so a write is proven absent by
  // the call itself being refused, not by counting rows afterwards
  // .
  const MUTATING = new Set([
    "toggle_member_message_reaction", "toggle_member_saved_message", "create_member_message_reminder",
    "send_steward_resource", "send_member_resource", "share_pulse_chart", "create_event_from_member_message",
  ]);

  it("runs the eleven other callers: each refuses or returns nothing from the other unit, and every write is refused", async () => {
    const before = await writes();
    for (const [name, sql, args, actor] of OTHERS) {
      const result = await attempt(actor, sql, args("memberB"));
      refusedOrEmpty(name, result, [...B_SECRETS, f.msg.memberB]);
      if (MUTATING.has(name)) expect(result.ok, `${name} acted on the other unit's member`).toBe(false);
    }
    expect(await writes()).toEqual(before);
  });

  it("lets the same callers act on the unit steward's own unit, except the member-only resource send", async () => {
    for (const [name, sql, args, actor] of OTHERS) {
      const result = await attempt(actor, sql, args("memberA"));
      if (name === "send_member_resource") {
        // A member sends a resource into their own conversation; a steward never can.
        expect(result.ok).toBe(false);
        allowed(`${name} as the member`, await attempt("memberA", sql, args("memberA")));
      } else {
        allowed(`${name} on unit A`, result);
      }
      if (name === "list_member_event_contact_messages") expect(JSON.stringify(result.value)).toContain("Private words of memberA");
    }
  });

  // #7665: stewards of a chapter keep their staff channels and the chapter
  // steward list whatever their unit; this repair does not touch either.
  it("keeps chapter staff channels and the chapter steward list for every steward of the chapter", async () => {
    for (const name of ["stewardA", "stewardB", "eventAdmin"]) {
      const { rows } = await db.query("select private.actor_has_chapter_staff_role($1,$2) ok", [f.people[name].id, f.chapter]);
      expect(rows[0].ok, `${name} staff channels`).toBe(true);
    }
    const stewards = (await db.query("select steward_id from private.member_stewards_for_chapter($1)", [f.chapter])).rows.map((row) => row.steward_id);
    for (const name of ["stewardA", "stewardB", "eventAdmin"]) expect(stewards, `${name} on the steward list`).toContain(f.people[name].id);
  });
});
