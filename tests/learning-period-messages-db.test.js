// @vitest-environment node
//
// REQ-UG-LEARNING-PERIOD-MESSAGES-NOTICES-INVITES-EXPORTS-20261103
// (#6945), slice 6 of #6805: during the learning period, what went out is
// journalled metadata-only and stays sent; removing your own message is
// held (hidden from every reader, its body in its own row only), undone in
// the period, or redacted by the period's close; a legal hold suspends that
// redaction; retention and account closure redact at once; scheduled
// messages, reactions, saves, reminders and invitation revokes undo;
// automations switched on during the period only preview.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { learningKinds } from "../scripts/lib/learning-period-parity.mjs";
import { stripComments } from "./helpers/migration.js";
import { releaseLearningPeriodHold } from "./helpers/learningPeriodHold.js";

const FILE = "20261104111500_learning_period_messages_notices_invites_exports.sql";
const sql = readFileSync(`supabase/migrations/${FILE}`, "utf8");
const code = stripComments(sql);
const JOURNALLING = {
  "public.redact_member_message": ["message_remove_own", "message_remove"],
  "public.edit_member_message": ["message_edit"],
  "public.schedule_member_message": ["scheduled_message_create"],
  "public.cancel_scheduled_member_message": ["scheduled_message_cancel"],
  "public.toggle_member_message_reaction": ["message_react", "message_unreact"],
  "public.toggle_member_saved_message": ["message_save", "message_unsave"],
  "public.create_member_message_reminder": ["message_reminder_set"],
  "public.cancel_member_message_reminder": ["message_reminder_change"],
  "public.create_channel_here_reminder": ["message_reminder_set"],
  "public.save_connected_workflow_reminder": ["message_reminder_set"],
  "public.save_personal_reminder": ["message_reminder_set", "message_reminder_change"],
  "public.cancel_personal_reminder": ["message_reminder_change"],
  "public.act_on_connected_workflow_reminder": ["message_reminder_change"],
  "public.create_member_invitation": ["invitation_send"],
  "public.create_former_member_invitation": ["invitation_send"],
  "public.create_roster_member_invitation": ["invitation_send"],
  "public.resend_member_invitation": ["invitation_send"],
  "public.revoke_member_invitation": ["invitation_revoke"],
  "public.set_organization_automation_definition_status": ["automation_activate"],
  "public.set_organization_automation_enabled": ["automation_switch"],
  "public.set_organization_automation_safety_cap": ["automation_switch"],
  "public.save_organization_automation_definition": ["automation_definition_save"],
  "public.mi1_save_automation_definition_v2": ["automation_definition_save"],
  "public.mi1_submit_automation_definition": ["automation_definition_save"],
  "public.mi1_review_automation_definition": ["automation_definition_save"],
};

function latestDefinitions() {
  const latest = new Map();
  for (const file of readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).sort()) {
    for (const fn of parseFunctions(readFileSync(`supabase/migrations/${file}`, "utf8"))) latest.set(fn.name, fn.source);
  }
  return latest;
}

describe("learning period messages migration (offline)", () => {
  const functions = parseFunctions(sql);
  const source = (name) => functions.find((fn) => fn.name === name)?.source;

  it("is one atomic migration whose journalling writers take the case-graph gate first", () => {
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    for (const [name, kinds] of Object.entries(JOURNALLING)) {
      expect(source(name), name).toBeTruthy();
      expect(helperFirst(source(name)), name).toBe(true);
      for (const kind of kinds) expect(source(name), `${name} ${kind}`).toMatch(new RegExp(`private\\.learning_(?:journal_append|reminder_journal)\\(\\s*'${kind}'`));
    }
  });

  it("never lets a before-image, the ledger or the journal carry message text", () => {
    const kinds = learningKinds([sql]);
    expect(kinds.length).toBeGreaterThan(25);
    expect(code).not.toMatch(/before_image_columns[^;]*'(body|body_text|content|text|message|recipients|token_hash)'/);
    // The held path never copies the body: no assignment from it anywhere.
    const remove = source("public.redact_member_message");
    expect(remove).not.toMatch(/message_row\.body|m\.body\b/);
    expect(remove).toContain("learning_removal_held_at = held_at");
    for (const fn of functions) {
      if (!fn.name.startsWith("private.learning_")) continue;
      expect(fn.source, fn.name).not.toMatch(/\bbody\b(?!_sha256)/);
    }
    expect(code).not.toMatch(/(update|delete from)\s+public\.(organization_audit_ledger|organization_audit_events|member_invitation_audit|member_notification_deliveries|engagement_delivery_outbox)\b/);
    // The one notification write is the reminder snooze's existing unlinking
    // of its own slot, carried over unchanged.
    expect(functions.filter((fn) => /(update|delete from)\s+public\.member_notifications\b/.test(fn.source)).map((fn) => fn.name))
      .toEqual(["public.act_on_connected_workflow_reminder"]);
  });

  it("destroys a held body only through private.redact_member_message_row", () => {
    const destroyers = functions.filter((fn) => /set\s+body\s*=\s*''/.test(fn.source)).map((fn) => fn.name);
    expect(destroyers).toEqual(["private.redact_member_message_row", "public.redact_member_message"]);
    // The held path destroys only the dispatched scheduled copy, never the
    // delivered row's body.
    expect([...source("public.redact_member_message").matchAll(/update\s+public\.([a-z_]+)\s+\w+\s+set\s+body\s*=\s*''/g)].map((m) => m[1]))
      .toEqual(["member_scheduled_messages"]);
    expect(source("private.redact_member_message_row")).toContain("learning_removal_held_at = null");
    expect(source("private.learning_finish_held_message_removal")).toContain("private.redact_member_message_row(p_message_id, 'sender_removed', p_actor)");
    expect(source("private.learning_finish_held_message_removal")).toContain("private.member_message_under_legal_hold(conversation)");
  });

  it("hands every handler it does not own to the dispatcher and close step it moved aside", () => {
    expect(code).toContain("alter function private.learning_dispatch(text, text, jsonb) rename to learning_dispatch_before_messages;");
    expect(code).toContain("alter function private.close_learning_period(uuid) rename to close_learning_period_before_messages;");
    expect(source("private.learning_dispatch")).toContain("else return private.learning_dispatch_before_messages(p_handler, p_mode, p_entry);");
    expect(source("private.close_learning_period")).toMatch(/closed := private\.close_learning_period_before_messages\(p_period_id\);\s+return closed \|\| private\.learning_finish_held_messages\(p_period_id\);/);
  });

  it("keeps the older-account exception for reactivation invitations only (20261106121000)", () => {
    const name = "private.learning_undo_invitation_revoke";
    const latest = latestDefinitions().get(name);
    const guard = "and (invitation_row.kind = 'provision' or u.created_at >= invitation_row.created_at)";
    expect(latest).toContain(guard);
    // Otherwise the body 20261104111500 installed.
    const strip = (text) => stripComments(text).replace(/^create (or replace )?function/, "").replace(/\s+/g, " ");
    // 20261106220000 moved its refusals from 40001 to PT409 (PostgREST 14 retries 40001).
    expect(strip(latest).replace(strip(guard), "and u.created_at >= invitation_row.created_at").replaceAll("errcode = 'PT409'", "errcode = '40001'"))
      .toBe(strip(source(name)));
  });

  it("hides a held removal from the client and from every definer reader it re-emits", () => {
    expect(code).toMatch(/create policy learning_removal_hold on public\.member_messages\s+as restrictive for select to authenticated\s+using \(learning_removal_held_at is null\);/);
    for (const name of ["private.can_read_message_source", "private.validate_message_reply_parent", "public.get_member_message_replies",
      "public.get_member_message_reply_counts", "public.get_message_briefing_context", "public.list_steward_thread_messages",
      "public.list_steward_conversations", "public.get_steward_desk_kpis", "public.get_member_home_takeover",
      "public.list_member_event_contact_messages", "private.cw_event_recipients", "private.member_data_export_without_peer_contact",
      "private.issue_intelligence_family_signal", "public.propose_compass_workspace_action", "public.get_case_queue_next_actions",
      "public.create_chapter_task_from_source", "public.create_member_contact_note"]) {
      expect(source(name), name).toMatch(/\.learning_removal_held_at is null/);
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("learning period messages on a disposable database", () => {
  let c;
  let world;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "learning-period-messages-proof" });
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
  const q = async (text, values = []) => (await c.query(text, values)).rows;
  // A worker's call: the service role's claims, as the scheduler sends them.
  const asService = async (text, values = []) => {
    await c.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
    return q(text, values);
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
    const org = { id: randomUUID(), chapter: `learning-msgs-${randomUUID().slice(0, 8)}` };
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org.id, org.chapter]);
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98317)", [org.chapter, org.id]);
    world = { org, admin: await person(org, "admin"), steward: await person(org, "steward"), member: await person(org, "member") };
    // 20261112-0032, an owner decision:
    // retain the old broad-grant positive controls through the real backfill.
    await migrateLegacyStewardFixtures(c);
    world.conversation = (await q(`insert into public.member_conversations(user_id, title, steward_user_id, organization_id)
      values ($1, 'Proof conversation', $2, $3) returning id`, [world.member.id, world.steward.id, org.id]))[0].id;
  });
  afterEach(async () => { await c.query("rollback"); });

  const start = () => one("select public.start_organization_learning_period() as r", [], world.admin);
  const send = async (user, body) => one("select public.send_member_message($1, $2) as r", [world.conversation, body], user);
  const sentId = async (body) => (await q("select id from public.member_messages where conversation_id = $1 and body = $2", [world.conversation, body]))[0].id;
  const entries = async (table, id) => q("select id, action_kind, state, version, actor_user_id, after_fingerprint, before_image from private.learning_action_journal where target_table = $1 and target_id = $2 order by created_at, id", [table, id]);
  const undo = (user, entry, version = 1) => call("select public.undo_my_learning_action($1, $2) as r", [entry, version], user);
  const visibleTo = async (user, id) => (await call("select id from public.member_messages where id = $1", [id], user)).rows.length;
  const endEarly = () => one("select public.end_organization_learning_period_early() as r", [], world.admin);
  // The body must exist nowhere but its own row: not in the journal, the
  // ledger, a scheduled copy or any other learning state.
  const bodyCopies = async (marker) => (await q(`select
      (select count(*)::int from private.learning_action_journal j where j::text like '%' || $1 || '%') as journal,
      (select count(*)::int from public.organization_audit_ledger l where l::text like '%' || $1 || '%') as ledger,
      (select count(*)::int from public.organization_audit_events e where e::text like '%' || $1 || '%') as events,
      (select count(*)::int from public.member_messages m where m.body like '%' || $1 || '%') as rows`, [marker]))[0];

  it("journals a sent message metadata-only, kept from the start and never undoable", async () => {
    await start();
    await send(world.member, "First practice message");
    await send(world.member, "Second practice message");
    const first = await sentId("First practice message");
    const second = await sentId("Second practice message");
    const [opened] = await entries("public.member_messages", first);
    const [sent] = await entries("public.member_messages", second);
    expect(opened).toMatchObject({ action_kind: "conversation_start", state: "kept", actor_user_id: world.member.id, after_fingerprint: null, before_image: null });
    expect(sent).toMatchObject({ action_kind: "message_send", state: "kept", after_fingerprint: null, before_image: null });
    expect(await undo(world.member, sent.id)).toMatchObject({ ok: false, code: "55000" });
    expect((await bodyCopies("Second practice message"))).toMatchObject({ journal: 0, ledger: 0, events: 0, rows: 1 });
  });

  it("holds your own removal: hidden from every reader at once, body in its own row only, undone in the period", async () => {
    await start();
    await send(world.member, "Remove me marker-7c1");
    const id = await sentId("Remove me marker-7c1");
    expect(await visibleTo(world.member, id)).toBe(1);
    const removed = await one("select public.redact_member_message($1) as r", [id], world.member);
    expect(removed).toMatchObject({ redacted: false, held: true, reasonCode: "sender_removed", message: { id, body: "" } });
    const [row] = await q("select body, redacted_at, body_sha256, learning_removal_held_at is not null as held from public.member_messages where id = $1", [id]);
    expect(row).toMatchObject({ body: "Remove me marker-7c1", redacted_at: null, body_sha256: null, held: true });
    expect(await visibleTo(world.member, id)).toBe(0);
    expect(await visibleTo(world.steward, id)).toBe(0);
    const thread = await call("select * from public.list_steward_thread_messages($1, 50, null)", [world.conversation], world.steward);
    if (thread.ok) expect(thread.rows.map((r) => r.id)).not.toContain(id);
    expect((await q("select private.can_read_message_source($1, 'private', $2, null, null) as r", [world.member.id, id]))[0].r).toBe(false);
    expect(await call("select public.toggle_member_message_reaction('private', $1, 'like') as r", [id], world.member)).toMatchObject({ ok: false });
    expect(await call("select public.edit_member_message($1, 'Changed') as r", [id], world.member)).toMatchObject({ ok: false });
    expect(await bodyCopies("marker-7c1")).toMatchObject({ journal: 0, ledger: 0, events: 0, rows: 1 });
    const [entry] = (await entries("public.member_messages", id)).filter((e) => e.action_kind === "message_remove_own");
    expect(entry).toMatchObject({ state: "active", before_image: { held: false, redacted: false } });
    expect(await undo(world.member, entry.id)).toMatchObject({ ok: true });
    expect(await visibleTo(world.member, id)).toBe(1);
    expect((await q("select body, learning_removal_held_at from public.member_messages where id = $1", [id]))[0]).toEqual({ body: "Remove me marker-7c1", learning_removal_held_at: null });
    expect(await undo(world.member, entry.id, 2)).toMatchObject({ ok: true, rows: [{ r: { status: "already_undone" } }] });
  });

  it("redacts a held removal through private.redact_member_message_row when the period is ended early and by the end job", async () => {
    await start();
    await send(world.member, "Early end marker-a11");
    await send(world.member, "End job marker-b22");
    const early = await sentId("Early end marker-a11");
    await one("select public.redact_member_message($1) as r", [early], world.member);
    const ledgerBefore = (await q("select count(*)::int as n from public.organization_audit_ledger"))[0].n;
    await endEarly();
    expect((await q("select body, redaction_reason, redacted_by, learning_removal_held_at, body_sha256 is not null as digest from public.member_messages where id = $1", [early]))[0])
      .toEqual({ body: "", redaction_reason: "sender_removed", redacted_by: world.member.id, learning_removal_held_at: null, digest: true });
    expect((await q("select count(*)::int as n from public.organization_audit_ledger"))[0].n).toBeGreaterThan(ledgerBefore);
    expect(await bodyCopies("marker-a11")).toMatchObject({ journal: 0, ledger: 0, events: 0, rows: 0 });
    const [entry] = (await entries("public.member_messages", early)).filter((e) => e.action_kind === "message_remove_own");
    expect(entry.state).toBe("kept");
    expect(await undo(world.member, entry.id, 2)).toMatchObject({ ok: false, code: "55000" });
  });

  it("finishes held removals from the hourly end job too, and a rerun changes nothing", async () => {
    await start();
    await send(world.member, "End job marker-b22");
    const id = await sentId("End job marker-b22");
    await one("select public.redact_member_message($1) as r", [id], world.member);
    await c.query("alter table private.organization_learning_periods disable trigger b10_learning_period_guard");
    await c.query("update private.organization_learning_periods p set starts_at = t.at - interval '337 hours', ends_at = t.at - interval '1 hour' from (select clock_timestamp() as at) t where p.organization_id = $1", [world.org.id]);
    await c.query("alter table private.organization_learning_periods enable trigger b10_learning_period_guard");
    expect((await asService("select public.run_learning_period_end_job() as r"))[0].r).toMatchObject({ finished: 1 });
    expect((await q("select body, redaction_reason, learning_removal_held_at from public.member_messages where id = $1", [id]))[0])
      .toEqual({ body: "", redaction_reason: "sender_removed", learning_removal_held_at: null });
    expect((await asService("select public.run_learning_period_end_job() as r"))[0].r).toMatchObject({ finished: 0 });
  });

  it("suspends the close's redaction under a legal hold and finishes it when the hold is released", async () => {
    await start();
    await send(world.member, "Held under order marker-c33");
    const id = await sentId("Held under order marker-c33");
    await one("select public.redact_member_message($1) as r", [id], world.member);
    await one("select public.place_member_message_legal_hold($1, 'litigation') as r", [world.conversation], world.admin);
    await endEarly();
    expect((await q("select body, redacted_at, learning_removal_held_at is not null as held from public.member_messages where id = $1", [id]))[0])
      .toEqual({ body: "Held under order marker-c33", redacted_at: null, held: true });
    expect(await visibleTo(world.member, id)).toBe(0);
    expect(await visibleTo(world.steward, id)).toBe(0);
    await one("select public.release_member_message_legal_hold($1) as r", [world.conversation], world.admin);
    expect((await q("select body, redaction_reason, learning_removal_held_at from public.member_messages where id = $1", [id]))[0])
      .toEqual({ body: "", redaction_reason: "sender_removed", learning_removal_held_at: null });
  });

  it("refuses a removal under a preservation order exactly as before", async () => {
    await start();
    await send(world.member, "Order first marker-d44");
    const id = await sentId("Order first marker-d44");
    await one("select public.place_member_message_legal_hold($1, 'litigation') as r", [world.conversation], world.admin);
    expect(await call("select public.redact_member_message($1) as r", [id], world.member)).toMatchObject({ ok: false, code: "42501" });
    expect((await q("select learning_removal_held_at from public.member_messages where id = $1", [id]))[0].learning_removal_held_at).toBeNull();
  });

  it("redacts a held row at once on retention expiry and on account closure", async () => {
    await start();
    await send(world.member, "Retention marker-e55");
    await send(world.member, "Closure marker-f66");
    const retained = await sentId("Retention marker-e55");
    const closed = await sentId("Closure marker-f66");
    await one("select public.redact_member_message($1) as r", [retained], world.member);
    await one("select public.redact_member_message($1) as r", [closed], world.member);
    expect((await q("select private.redact_member_message_row($1, 'retention_expired', null) as r", [retained]))[0].r).toBe(true);
    expect((await q("select body, redaction_reason, learning_removal_held_at from public.member_messages where id = $1", [retained]))[0])
      .toEqual({ body: "", redaction_reason: "retention_expired", learning_removal_held_at: null });
    await c.query("delete from auth.users where id = $1", [world.member.id]);
    expect(await bodyCopies("marker-f66")).toMatchObject({ journal: 0, ledger: 0, events: 0, rows: 0 });
    const left = await q("select redaction_reason from public.member_messages where id = $1", [closed]);
    if (left.length) expect(left[0].redaction_reason).toBe("account_closed");
  });

  it("removes a message outside a period, and staff removal during it, at once", async () => {
    await send(world.member, "No period marker-g77");
    const id = await sentId("No period marker-g77");
    expect(await one("select public.redact_member_message($1) as r", [id], world.member)).toMatchObject({ redacted: true });
    await start();
    await send(world.member, "Staff removes marker-h88");
    const staffTarget = await sentId("Staff removes marker-h88");
    expect(await one("select public.redact_member_message($1) as r", [staffTarget], world.steward)).toMatchObject({ redacted: true, reasonCode: "staff_removed" });
    expect((await q("select body, learning_removal_held_at from public.member_messages where id = $1", [staffTarget]))[0]).toEqual({ body: "", learning_removal_held_at: null });
    const [entry] = await entries("public.member_messages", staffTarget).then((rows) => rows.filter((e) => e.action_kind === "message_remove"));
    expect(entry).toMatchObject({ state: "kept", actor_user_id: world.steward.id, before_image: null });
  });

  it("never alters a delivery row: notices of a sent message stay as sent through removal and undo", async () => {
    await start();
    const deliveries = async () => q(`select n.id, n.title, n.body, n.read_at from public.member_notifications n where n.user_id = $1 order by n.id`, [world.steward.id]);
    await send(world.member, "Delivered marker-i99");
    const id = await sentId("Delivered marker-i99");
    const before = await deliveries();
    await one("select public.redact_member_message($1) as r", [id], world.member);
    const [entry] = (await entries("public.member_messages", id)).filter((e) => e.action_kind === "message_remove_own");
    await undo(world.member, entry.id);
    expect(await deliveries()).toEqual(before);
  });

  it("undoes scheduling a message by cancelling it while pending, and a cancel by putting it back", async () => {
    await start();
    const scheduled = await one("select public.schedule_member_message($1, 'Later marker-j10', now() + interval '2 days') as r", [world.conversation], world.member);
    const [create] = await entries("public.member_scheduled_messages", scheduled.id);
    expect(create).toMatchObject({ action_kind: "scheduled_message_create", state: "active" });
    expect(create.before_image).toEqual({});
    expect(await undo(world.member, create.id)).toMatchObject({ ok: true });
    expect((await q("select status from public.member_scheduled_messages where id = $1", [scheduled.id]))[0].status).toBe("cancelled");
    const again = await one("select public.schedule_member_message($1, 'Later marker-k11', now() + interval '2 days') as r", [world.conversation], world.member);
    await one("select public.cancel_scheduled_member_message($1) as r", [again.id], world.member);
    const cancel = (await entries("public.member_scheduled_messages", again.id)).find((e) => e.action_kind === "scheduled_message_cancel");
    expect(await undo(world.member, cancel.id)).toMatchObject({ ok: true });
    expect((await q("select status from public.member_scheduled_messages where id = $1", [again.id]))[0].status).toBe("pending");
    expect(await bodyCopies("marker-k11")).toMatchObject({ journal: 0, ledger: 0 });
  });

  it("undoes reactions and saves, both ways", async () => {
    await start();
    await send(world.member, "React to me");
    const id = await sentId("React to me");
    const reacted = await one("select public.toggle_member_message_reaction('private', $1, 'support') as r", [id], world.steward);
    const [react] = await entries("public.member_message_reactions", reacted.id);
    expect(await undo(world.steward, react.id)).toMatchObject({ ok: true });
    expect(await q("select id from public.member_message_reactions where id = $1", [reacted.id])).toEqual([]);
    const saved = await one("select public.toggle_member_saved_message('private', $1) as r", [id], world.member);
    await one("select public.toggle_member_saved_message('private', $1) as r", [id], world.member);
    const unsave = (await entries("public.member_saved_messages", saved.id)).find((e) => e.action_kind === "message_unsave");
    expect(await undo(world.member, unsave.id)).toMatchObject({ ok: true });
    expect((await q("select owner_id from public.member_saved_messages where id = $1", [saved.id]))[0].owner_id).toBe(world.member.id);
  });

  it("undoes a reminder you set, and a reminder change", async () => {
    await start();
    await send(world.member, "Remind me");
    const id = await sentId("Remind me");
    const reminder = await one("select public.create_member_message_reminder('private', $1, now() + interval '1 day', 'Check') as r", [id], world.member);
    await one("select public.cancel_member_message_reminder($1) as r", [reminder.id], world.member);
    const [set, cancelled] = await entries("public.member_message_reminders", reminder.id);
    expect([set.action_kind, cancelled.action_kind]).toEqual(["message_reminder_set", "message_reminder_change"]);
    expect(await undo(world.member, cancelled.id)).toMatchObject({ ok: true });
    expect((await q("select status from public.member_message_reminders where id = $1", [reminder.id]))[0].status).toBe("pending");
    expect(await undo(world.member, set.id)).toMatchObject({ ok: true });
    expect((await q("select status from public.member_message_reminders where id = $1", [reminder.id]))[0].status).toBe("cancelled");
  });

  it("journals an invitation as sent, and undoes a revoke by reopening the same link with no new email", async () => {
    await start();
    const hash = "a".repeat(63) + "1";
    const created = await one("select public.create_member_invitation($1, 'Practice Invitee', $2, null, 'en', $3) as r",
      [`invitee-${randomUUID().slice(0, 8)}@example.invalid`, world.org.chapter, hash], world.admin);
    const invitationId = created.invitationId ?? created.id ?? (await q("select id from public.member_invitations where token_hash = $1", [hash]))[0].id;
    expect((await entries("public.member_invitations", invitationId))[0]).toMatchObject({ action_kind: "invitation_send", state: "kept" });
    const audits = async () => (await q("select count(*)::int as n from public.member_invitation_audit where invitation_id = $1", [invitationId]))[0].n;
    await one("select public.revoke_member_invitation($1) as r", [invitationId], world.admin);
    expect((await q("select status, token_hash, learning_revoke_held_at is not null as held from public.member_invitations where id = $1", [invitationId]))[0])
      .toEqual({ status: "revoked", token_hash: hash, held: true });
    expect((await asService("select public.claim_member_invitation($1) as r", [hash]))[0].r).toEqual({ available: false });
    const revoke = (await entries("public.member_invitations", invitationId)).find((e) => e.action_kind === "invitation_revoke");
    const auditCount = await audits();
    expect(await undo(world.admin, revoke.id)).toMatchObject({ ok: true });
    expect((await q("select status, token_hash, revoked_at, learning_revoke_held_at from public.member_invitations where id = $1", [invitationId]))[0])
      .toEqual({ status: "pending", token_hash: hash, revoked_at: null, learning_revoke_held_at: null });
    expect(await audits()).toBe(auditCount + 1);
    // A revoke left at the close loses its token for good.
    await one("select public.revoke_member_invitation($1) as r", [invitationId], world.admin);
    await endEarly();
    expect((await q("select status, token_hash, learning_revoke_held_at from public.member_invitations where id = $1", [invitationId]))[0])
      .toEqual({ status: "revoked", token_hash: null, learning_revoke_held_at: null });
  });

  it("runs an automation switched on during the period as a practice preview that acts on nothing", async () => {
    await start();
    const [definition] = await q(`insert into public.organization_automation_definitions
      (organization_id, name, trigger_kind, cadence, status, version, review_status, review_version, created_by, updated_by)
      values ($1, 'Practice overdue tasks', 'overdue_task', 'daily', 'paused', 1, 'approved', 1, $2, $2) returning id`, [world.org.id, world.admin.id]);
    await c.query("insert into public.organization_automation_settings(organization_id, enabled) values ($1, true) on conflict (organization_id) do update set enabled = true", [world.org.id]);
    const activated = await call("select public.set_organization_automation_definition_status($1, 'active', 1) as r", [definition.id], world.admin);
    expect(activated, JSON.stringify(activated)).toMatchObject({ ok: true });
    expect((await entries("public.organization_automation_definitions", definition.id))[0]).toMatchObject({ action_kind: "automation_activate", state: "active" });
    const effectsBefore = (await q("select count(*)::int as n from public.organization_automation_effects where organization_id = $1", [world.org.id]))[0].n;
    const tasksBefore = (await q("select count(*)::int as n from public.chapter_tasks where chapter_id = $1", [world.org.chapter]))[0].n;
    const ran = (await q("select private.run_due_organization_automations(50) as r"))[0].r;
    expect(ran.previewed).toBeGreaterThanOrEqual(1);
    const runs = await q("select mode, status, learning_practice, confirmation_phrase from public.organization_automation_runs where definition_id = $1", [definition.id]);
    expect(runs).toEqual([{ mode: "preview", status: "previewed", learning_practice: true, confirmation_phrase: null }]);
    expect((await q("select count(*)::int as n from public.organization_automation_effects where organization_id = $1", [world.org.id]))[0].n).toBe(effectsBefore);
    expect((await q("select count(*)::int as n from public.chapter_tasks where chapter_id = $1", [world.org.chapter]))[0].n).toBe(tasksBefore);
    expect((await q("select next_run_at > now() as moved from public.organization_automation_definitions where id = $1", [definition.id]))[0].moved).toBe(true);
    const [run] = await q("select id from public.organization_automation_runs where definition_id = $1", [definition.id]);
    expect(await call("select public.execute_organization_automation_run($1, null) as r", [run.id], world.admin)).toMatchObject({ ok: false, code: "55000" });
  });

  // Each fails before the repair.
  it("invalidates persisted briefings and action titles built from a conversation when a message in it is held", async () => {
    await start();
    await send(world.member, "Briefed marker-l12");
    const id = await sentId("Briefed marker-l12");
    await c.query(`insert into public.compass_message_briefings(organization_id, requested_by, source_kind, target_id, summary)
      values ($1, $2, 'private', $3, 'Summary that quotes Briefed marker-l12')`, [world.org.id, world.steward.id, world.conversation]);
    await c.query(`insert into public.compass_workspace_actions(organization_id, actor_user_id, action_kind, source_kind, source_id, title)
      values ($1, $2, 'create_task', 'message', $3, 'Follow up: Briefed marker-l12')`, [world.org.id, world.steward.id, id]);
    await one("select public.redact_member_message($1) as r", [id], world.member);
    expect(await q("select id from public.compass_message_briefings where target_id = $1", [world.conversation])).toEqual([]);
    expect((await q("select title from public.compass_workspace_actions where source_id = $1", [id]))[0].title).toBe("Follow up on member message");
    expect(await bodyCopies("marker-l12")).toMatchObject({ rows: 1 });
    expect((await q("select count(*)::int as n from public.compass_workspace_actions a where a::text like '%marker-l12%'"))[0].n).toBe(0);
  });

  it("destroys the dispatched scheduled copy when the delivered message is held, and undo recreates no copy", async () => {
    await start();
    const scheduled = await one("select public.schedule_member_message($1, 'Scheduled copy marker-m13', now() + interval '1 day') as r", [world.conversation], world.member);
    await c.query("update public.member_scheduled_messages set scheduled_for = now() - interval '1 minute' where id = $1", [scheduled.id]);
    await asService("select private.dispatch_due_member_messaging(500) as r");
    const [copy] = await q("select sent_message_id, status from public.member_scheduled_messages where id = $1", [scheduled.id]);
    expect(copy.status).toBe("sent");
    await one("select public.redact_member_message($1) as r", [copy.sent_message_id], world.member);
    expect((await q("select body, redacted_at is not null as cleared from public.member_scheduled_messages where id = $1", [scheduled.id]))[0]).toEqual({ body: "", cleared: true });
    expect((await call("select body from public.member_scheduled_messages where id = $1", [scheduled.id], world.member)).rows.map((r) => r.body)).not.toContain("Scheduled copy marker-m13");
    expect(await bodyCopies("marker-m13")).toMatchObject({ journal: 0, ledger: 0, rows: 1 });
    const [entry] = (await entries("public.member_messages", copy.sent_message_id)).filter((e) => e.action_kind === "message_remove_own");
    expect(await undo(world.member, entry.id)).toMatchObject({ ok: true });
    expect(await visibleTo(world.member, copy.sent_message_id)).toBe(1);
    expect((await q("select body from public.member_scheduled_messages where id = $1", [scheduled.id]))[0].body).toBe("");
  });

  it("never answers a repeated reply with a held one", async () => {
    await start();
    await send(world.member, "Parent for replies");
    const parent = await sentId("Parent for replies");
    const first = await one("select public.reply_to_member_message('private', $1, 'Same reply marker-n14') as r", [parent], world.member);
    await one("select public.redact_member_message($1) as r", [first.id], world.member);
    const second = await one("select public.reply_to_member_message('private', $1, 'Same reply marker-n14') as r", [parent], world.member);
    expect(second.id).not.toBe(first.id);
    expect(await visibleTo(world.member, second.id)).toBe(1);
    expect(await visibleTo(world.member, first.id)).toBe(0);
  });

  it("runs an automation switched on before the period as a practice preview too", async () => {
    const [definition] = await q(`insert into public.organization_automation_definitions
      (organization_id, name, trigger_kind, cadence, status, version, review_status, review_version, next_run_at, created_by, updated_by)
      values ($1, 'Standing overdue tasks', 'overdue_task', 'daily', 'active', 1, 'approved', 1, now() - interval '1 minute', $2, $2) returning id`, [world.org.id, world.admin.id]);
    await c.query("insert into public.organization_automation_settings(organization_id, enabled) values ($1, true) on conflict (organization_id) do update set enabled = true", [world.org.id]);
    await start();
    expect(await entries("public.organization_automation_definitions", definition.id)).toEqual([]);
    const effectsBefore = (await q("select count(*)::int as n from public.organization_automation_effects where organization_id = $1", [world.org.id]))[0].n;
    expect((await q("select private.run_due_organization_automations(50) as r"))[0].r.previewed).toBeGreaterThanOrEqual(1);
    expect(await q("select mode, status, learning_practice from public.organization_automation_runs where definition_id = $1", [definition.id]))
      .toEqual([{ mode: "preview", status: "previewed", learning_practice: true }]);
    expect((await q("select count(*)::int as n from public.organization_automation_effects where organization_id = $1", [world.org.id]))[0].n).toBe(effectsBefore);
  });

  it("refuses to reopen a revoked invitation once its person has an account or an accepted invitation", async () => {
    await start();
    const email = `joined-${randomUUID().slice(0, 8)}@example.invalid`;
    const hash = "b".repeat(63) + "2";
    await one("select public.create_member_invitation($1, 'Joined Invitee', $2, null, 'en', $3) as r", [email, world.org.chapter, hash], world.admin);
    const [{ id }] = await q("select id from public.member_invitations where token_hash = $1", [hash]);
    await one("select public.revoke_member_invitation($1) as r", [id], world.admin);
    // GoTrue stamps created_at when it creates the account.
    await c.query("insert into auth.users(id, email, created_at) values ($1, $2, now())", [randomUUID(), email]);
    const revoke = (await entries("public.member_invitations", id)).find((e) => e.action_kind === "invitation_revoke");
    expect(await undo(world.admin, revoke.id)).toMatchObject({ ok: false, code: "PT409" });
    expect((await q("select status from public.member_invitations where id = $1", [id]))[0].status).toBe("revoked");
  });

  // Gate rounds 2 and 4 on #7031, fixed by 20261106121000.
  it("refuses to reopen a revoked provision invitation once sign-in recovery moves an older account onto its address", async () => {
    const older = randomUUID();
    await c.query("insert into auth.users(id, email, created_at) values ($1, $2, now() - interval '30 days')", [older, `older-${older}@example.invalid`]);
    await start();
    const email = `recovered-${randomUUID().slice(0, 8)}@example.invalid`;
    const hash = "c".repeat(63) + "3";
    await one("select public.create_member_invitation($1, 'Recovered Invitee', $2, null, 'en', $3) as r", [email, world.org.chapter, hash], world.admin);
    const [{ id }] = await q("select id from public.member_invitations where token_hash = $1", [hash]);
    await one("select public.revoke_member_invitation($1) as r", [id], world.admin);
    // Sign-in recovery changes the account's address and keeps its creation time.
    await c.query("update auth.users set email = $2 where id = $1", [older, email]);
    const revoke = (await entries("public.member_invitations", id)).find((e) => e.action_kind === "invitation_revoke");
    expect(await undo(world.admin, revoke.id)).toMatchObject({ ok: false, code: "PT409" });
    expect((await q("select status from public.member_invitations where id = $1", [id]))[0].status).toBe("revoked");
    expect((await asService("select public.claim_member_invitation($1) as r", [hash]))[0].r).toEqual({ available: false });
  });
});
