// @vitest-environment node
//
// REQ-UG-CONNECTED-WORKFLOW-SHORTCUTS-20260928 (server slice).
// Executes the connected-workflow RPCs on a disposable catalog: uniform refusal,
// staff-only idempotent task links, reminders (scheduled/snooze/complete/cancel and
// delivery), the explicit event organizer + attendee opt-in contact (delivered ONLY
// through the existing private-message writers into member_messages), replay
// binding, cancellation, membership loss, redaction, legal hold and account
// deletion. Every fixture lives in one transaction that is rolled back, except the
// concurrency proof, which needs two sessions and therefore commits its own
// uniquely named, synthetic tenant on the disposable stack.
import { scopeFixtureSteward } from "./helpers/steward-unit-fixtures.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const FUTURE = (days) => new Date(Date.now() + days * 86400000).toISOString();

async function expectRefusal(promise, { code = null, detail = null } = {}) {
  let failure = null;
  try { await promise; } catch (error) { failure = error; }
  expect(failure, "the call must be refused").not.toBeNull();
  if (code) expect(failure.code).toBe(code);
  if (detail) expect(String(failure.detail ?? "")).toBe(detail);
  return failure;
}

live("connected workflow shortcuts over a disposable database", () => {
  let client;
  const world = {};
  let savepointCounter = 0;

  const q = (sql, params) => client.query(sql, params);

  async function person(label, { chapter = world.chapter, org = world.org, name = null } = {}) {
    const id = randomUUID();
    const session = randomUUID();
    await q("insert into auth.users(id,email) values ($1,$2)", [id, `${id}-${label}@example.invalid`]);
    await q("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, id]);
    await q("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id, chapter, name ?? label]);
    await q("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, chapter]);
    await q("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [org, id]);
    await q("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    return { id, session, label };
  }

  async function grant(user, role, chapter = world.chapter) {
    await q("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3)", [user.id, role, chapter]);
    await q("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [user.id, role, chapter]);
  }

  // One authenticated call inside a savepoint, so an expected refusal does not
  // poison the shared fixture transaction.
  async function asUser(user, work) {
    const name = `cw_${++savepointCounter}`;
    await q(`savepoint ${name}`);
    try {
      await q("reset role");
      await q("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
        sub: user.id, role: "authenticated", aal: "aal2", session_id: user.session,
      })]);
      await q("set local role authenticated");
      const result = await work();
      await q("reset role");
      await q(`release savepoint ${name}`);
      return result;
    } catch (error) {
      await q(`rollback to savepoint ${name}`);
      await q("reset role");
      throw error;
    }
  }
  const call = (user, sql, params = []) => asUser(user, async () => (await q(`select ${sql} as value`, params)).rows[0].value);

  const context = (user, kind, id, chapter = null, org = null) =>
    call(user, "public.get_connected_workflow_context($1,$2,$3,$4::uuid)", [kind, id, chapter, org]);
  const recipients = (user, kind, id, cursor = null) =>
    call(user, "public.list_connected_workflow_recipients($1,$2,$3,25,null,null::uuid)", [kind, id, cursor]);
  const createTask = (user, kind, id, chapter = null) =>
    call(user, "public.create_connected_workflow_task($1,$2,$3,null::uuid)", [kind, id, chapter]);
  const saveReminder = (user, kind, id, at, note = "") =>
    call(user, "public.save_connected_workflow_reminder($1,$2,$3::timestamptz,$4,null,null::uuid)", [kind, id, at, note]);
  const listReminders = (user, status = "open", cursor = null, limit = 25) =>
    call(user, "public.list_connected_workflow_reminders($1,$2,$3)", [cursor, limit, status]);
  const actOnReminder = (user, id, action, at = null) =>
    call(user, "public.act_on_connected_workflow_reminder($1::uuid,$2,$3::timestamptz)", [id, action, at]);
  const send = (user, kind, id, ids, body, request) =>
    call(user, "public.send_connected_workflow_message($1,$2,$3::uuid[],$4,$5::uuid,null,null::uuid)", [kind, id, ids, body, request]);
  const setOrganizer = (user, eventId, organizer) =>
    call(user, "public.set_member_event_organizer($1,$2::uuid)", [eventId, organizer]);
  const candidates = (user, eventId, cursor = null) =>
    call(user, "public.list_member_event_organizer_candidates($1,$2,25)", [eventId, cursor]);
  // Like the client, enabling states the organizer the attendee was shown; by default that is
  // the event's current organizer. Pass `expected` (or null) to model a stale or missing one.
  const optIn = async (user, eventId, value, expected = undefined) => {
    const shown = value && expected === undefined
      ? ((await q("select organizer_id from public.member_events where id=$1", [eventId])).rows[0]?.organizer_id ?? null)
      : (expected ?? null);
    return call(user, "public.set_member_event_contact_opt_in($1,$2::boolean,$3::uuid)", [eventId, value, shown]);
  };
  const thread = (user, eventId, participant = null, cursor = null) =>
    call(user, "public.list_member_event_contact_messages($1,$2::uuid,$3,50)", [eventId, participant, cursor]);

  async function bodyHolders(needle) {
    const { rows } = await q("select * from pg_temp.cw_body_holders($1)", [needle]);
    return rows.map((row) => row.holder).sort();
  }

  async function newEvent(id, { chapter = world.chapter, cancelled = false, across = false, order = 1 } = {}) {
    await q(
      `insert into public.member_events(id,title,starts_at,location,summary,check_in_code,order_index,chapter_id,is_public,is_public_across_agencies,cancelled_at)
       values ($1,'Contract rally',$2,'Hall','Bring your badge','SG-CW${order}',$3,$4,false,$5,$6)`,
      [id, FUTURE(7), order, chapter, across, cancelled ? new Date().toISOString() : null]);
  }
  async function rsvp(eventId, user, status = "going") {
    await q("insert into public.member_event_rsvps(event_id,user_id,status) values ($1,$2,$3) on conflict (event_id,user_id) do update set status=excluded.status", [eventId, user.id, status]);
  }
  async function conversation(user, { steward = null } = {}) {
    const id = randomUUID();
    await q("insert into public.member_conversations(id,user_id,title,initials,steward_user_id) values ($1,$2,'Chapter steward','CS',$3)", [id, user.id, steward?.id ?? null]);
    return id;
  }
  async function memberMessage(conversationId, user, body = "Hello stewards") {
    const id = randomUUID();
    await q("insert into public.member_messages(id,conversation_id,user_id,sender_kind,sender_name,body) values ($1,$2,$3,'member','Member',$4)", [id, conversationId, user.id, body]);
    return id;
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      application_name: "connected-workflow-shortcuts-proof",
    });
    await client.connect();
    await q("begin");
    // Sized to the runner (scripts/lib/runner-timeout.mjs): on GitHub's 2-vCPU
    // ubuntu-24.04 runner the lifecycle inventory scans passed a fixed 60 s
    // (#8351, run 43151196191). The 20 s lock limit stays.
    await q(`set local statement_timeout = '${runnerTimeout(60_000)}ms'`);
    await q("set local lock_timeout = '20s'");

    await q(`create function pg_temp.cw_body_holders(needle text) returns table(holder text) language plpgsql as $$
      declare rel record; hits bigint;
      begin
        for rel in select n.nspname as s, c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where c.relkind = 'r' and n.nspname in ('public','private') loop
          execute format('select count(*) from %I.%I x where x::text like %L', rel.s, rel.t, '%' || needle || '%') into hits;
          if hits > 0 then holder := rel.s || '.' || rel.t; return next; end if;
        end loop;
      end $$`);

    world.org = randomUUID();
    world.chapter = `cw-${world.org.slice(0, 8)}`;
    world.chapter2 = `cx-${world.org.slice(0, 8)}`;
    world.orgB = randomUUID();
    world.chapterB = `cb-${world.orgB.slice(0, 8)}`;
    await q("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [world.org, world.chapter]);
    await q("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [world.orgB, world.chapterB]);
    await q("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,97601)", [world.chapter, world.org]);
    await q("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,97602)", [world.chapter2, world.org]);
    await q("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'other',$2,97603)", [world.chapterB, world.orgB]);
    for (const chapter of [world.chapter, world.chapter2]) {
      await q("insert into public.chapter_workstreams(chapter_id,name) values ($1,'General')", [chapter]);
    }

    world.steward = await person("steward", { name: "Sam Steward" });
    world.steward2 = await person("steward2", { name: "Sky Steward" });
    world.coordinator = await person("coordinator", { name: "Casey Coordinator" });
    world.alice = await person("alice", { name: "Alice Attendee" });
    world.bob = await person("bob", { name: "Bob Attendee" });
    world.carol = await person("carol", { name: "Carol Attendee" });
    world.erin = await person("erin", { chapter: world.chapter2, name: "Erin Elsewhere" });
    world.dave = await person("dave", { chapter: world.chapterB, org: world.orgB, name: "Dave Other" });
    await grant(world.steward, "steward");
    await grant(world.steward2, "steward");
    await grant(world.coordinator, "coordinator");
    await grant(world.erin, "steward", world.chapter2);

    world.aliceConversation = await conversation(world.alice);
    world.aliceMessage = await memberMessage(world.aliceConversation, world.alice, "Can someone review my schedule?");
    world.bobConversation = await conversation(world.bob, { steward: world.steward });
    await memberMessage(world.bobConversation, world.bob, "Question about overtime");
    // carol deliberately has no conversation at all.

    world.event = "cw-rally-2026";
    await newEvent(world.event, { order: 1 });
    for (const attendee of [world.alice, world.bob, world.carol]) await rsvp(world.event, attendee);
    world.cancelled = "cw-rally-cancelled";
    await newEvent(world.cancelled, { cancelled: true, order: 2 });
    await rsvp(world.cancelled, world.alice);
    world.remote = "cw-rally-remote";
    await newEvent(world.remote, { chapter: world.chapter2, across: true, order: 1 });
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("answers uniformly for a missing, foreign-tenant or unauthorized source", async () => {
    const stranger = await context(world.dave, "private_message", world.aliceMessage);
    const missing = await context(world.steward, "private_message", randomUUID());
    const malformed = await context(world.steward, "event", "NOT AN EVENT");
    for (const answer of [stranger, missing, malformed]) {
      expect(answer).toMatchObject({
        available: false, reason: "source_unavailable", canMessage: false, canRemind: false, canCreateTask: false,
        linkedTask: null, discussionHref: null, organizer: null, contactOptIn: false,
        canManageOrganizer: false, canContactOptIn: false,
      });
    }
    expect(stranger).toEqual({ ...missing, kind: "private_message" });
    await expectRefusal(context(world.steward, "unknown_kind", "x"), { code: "22023", detail: "cw:invalid_input:kind" });
    // A peer member in the same chapter cannot read someone else's private message either.
    expect((await context(world.carol, "private_message", world.aliceMessage)).available).toBe(false);
  });

  it("offers a staff-only, generic, idempotent task link for one exact message", async () => {
    const asStaff = await context(world.steward, "private_message", world.aliceMessage);
    expect(asStaff).toMatchObject({ available: true, state: "available", canCreateTask: true, canRemind: true, canMessage: false });
    expect(asStaff.href).toBe(`/m/steward?thread=${world.aliceConversation}&message=${world.aliceMessage}`);
    const asOwner = await context(world.alice, "private_message", world.aliceMessage);
    expect(asOwner).toMatchObject({ available: true, canCreateTask: false, canRemind: true });
    expect(asOwner.reasons.task).toBe("staff_grant_required");
    await expectRefusal(createTask(world.alice, "private_message", world.aliceMessage), { code: "42501", detail: "cw:not_authorized:staff_grant_required" });

    const first = await createTask(world.steward, "private_message", world.aliceMessage);
    expect(first.created).toBe(true);
    expect(first.task.title).toBe("Follow up on member message");
    expect(first.task.description).toBe("");
    expect(first.href).toBe(`/m/tasks?task=${first.task.id}`);
    expect(first.taskKey).toMatch(/^cw-[a-z0-9]+-\d+$/);
    expect(first.attachment).toMatchObject({ source_kind: "message", source_id: world.aliceMessage, label: "Authorized member message" });
    expect(JSON.stringify(first)).not.toContain("review my schedule");
    const again = await createTask(world.steward, "private_message", world.aliceMessage);
    expect(again.created).toBe(false);
    expect(again.task.id).toBe(first.task.id);
    const count = (await q("select count(*)::int as n from public.chapter_task_attachments where source_id=$1", [world.aliceMessage])).rows[0].n;
    expect(count).toBe(1);

    const afterward = await context(world.steward, "private_message", world.aliceMessage);
    expect(afterward.linkedTask).toMatchObject({ id: first.task.id, href: `/m/tasks?task=${first.task.id}` });
    world.linkedTask = first.task.id;
    // The linked task can be opened from its own context, and lists its source only while it stays authorized.
    const taskContext = await context(world.steward, "task", first.task.id);
    expect(taskContext.sourceLinks).toEqual([{
      reference: { kind: "private_message", id: world.aliceMessage, organizationId: world.org, chapterId: world.chapter },
      label: "Linked message",
    }]);
    const memberTaskContext = await context(world.alice, "task", first.task.id);
    expect(memberTaskContext.href).toBeNull();
    // A staff member of another tenant cannot reach it at all.
    await expectRefusal(createTask(world.dave, "private_message", world.aliceMessage), { code: "42501" });
  });

  it("keeps a task link inside the caller's current chapter (stale reference is refused)", async () => {
    const before = (await q("select count(*)::int as n from public.chapter_tasks")).rows[0].n;
    const remote = await context(world.steward, "event", world.remote);
    expect(remote).toMatchObject({ available: true, canCreateTask: false });
    expect(remote.reasons.task).toBe("chapter_mismatch");
    await expectRefusal(createTask(world.steward, "event", world.remote), { code: "22023", detail: "cw:scope_changed:chapter_mismatch" });
    expect((await q("select count(*)::int as n from public.chapter_tasks")).rows[0].n).toBe(before);
    // A reference that asserts a chapter neither the source nor the caller is in is stale.
    expect((await context(world.steward, "event", world.event, world.chapter2)).reason).toBe("scope_changed");
    expect((await context(world.steward, "event", world.event, world.chapter)).available).toBe(true);
    expect((await context(world.steward, "event", world.event, null, randomUUID())).reason).toBe("scope_changed");
    // A follow-up task for an event of the caller's own chapter is created generically.
    const made = await createTask(world.steward, "event", world.event);
    expect(made).toMatchObject({ created: true });
    expect(made.task.title).toBe("Follow up on event");
    expect(made.attachment.source_kind).toBe("event");
  });

  it("delivers task messages only through existing boundaries, with replay bound to the exact payload", async () => {
    await call(world.steward, "public.set_chapter_task_assignees($1::uuid,$2::uuid[])", [world.linkedTask, [world.alice.id]]);
    const audience = await recipients(world.steward, "task", world.linkedTask);
    expect(audience).toMatchObject({ status: "available", items: [{ id: world.alice.id, label: "Alice Attendee" }], nextCursor: null });
    // Bob is not a task participant; nobody is offered for a source kind without a message action.
    expect((await recipients(world.steward, "private_message", world.aliceMessage)).reason).toBe("not_offered");
    expect((await context(world.steward, "task", world.linkedTask)).canMessage).toBe(true);

    const request = randomUUID();
    const sent = await send(world.steward, "task", world.linkedTask, [world.alice.id], "Please look at the schedule", request);
    expect(sent).toMatchObject({ sent: 1, replayed: false, results: [{ recipientId: world.alice.id, via: "task_thread", replayed: false }] });
    const rows = (await q("select body from public.chapter_task_messages where task_id=$1", [world.linkedTask])).rows;
    expect(rows).toEqual([{ body: "Please look at the schedule" }]);
    world.taskMessage = sent.results[0].messageId;
    const ledger = (await q("select metadata, entity_id, actor_user_id from public.organization_audit_ledger where entity_id=$1", [sent.results[0].messageId])).rows;
    expect(ledger).toHaveLength(1);
    expect(JSON.stringify(ledger[0].metadata)).not.toContain("schedule");
    expect(ledger[0].metadata).toMatchObject({ sourceKind: "task", sourceId: world.linkedTask, userId: world.alice.id, entityType: "task_thread" });
    expect(ledger[0].metadata.payloadDigest).toMatch(/^[0-9a-f]{64}$/);

    // Same request, same payload: replayed from the ledger, nothing new written.
    const replay = await send(world.steward, "task", world.linkedTask, [world.alice.id], "Please look at the schedule", request);
    expect(replay).toMatchObject({ sent: 0, replayed: true });
    expect(replay.results[0]).toMatchObject({ messageId: sent.results[0].messageId, replayed: true });
    expect((await q("select count(*)::int as n from public.chapter_task_messages where task_id=$1", [world.linkedTask])).rows[0].n).toBe(1);
    // Same request id with different text, or a different source, is a reused id, not the earlier message.
    await expectRefusal(send(world.steward, "task", world.linkedTask, [world.alice.id], "Changed my mind", request), { code: "23505", detail: "cw:idempotency_conflict:request_reused" });
    const otherTask = (await createTask(world.steward, "event", world.event)).task.id;
    await expectRefusal(send(world.steward, "task", otherTask, [world.alice.id], "Please look at the schedule", request), { code: "23505", detail: "cw:idempotency_conflict:request_reused" });
    expect((await q("select count(*)::int as n from public.chapter_task_messages where task_id=$1", [world.linkedTask])).rows[0].n).toBe(1);
    // A recipient outside the current eligible set rejects the whole send and writes nothing.
    const stray = await expectRefusal(send(world.steward, "task", world.linkedTask, [world.alice.id, world.bob.id], "Group note", randomUUID()), { code: "22023", detail: "cw:recipient_unavailable:recipient_unavailable" });
    expect(stray.message).toContain("not available");
    expect((await q("select count(*)::int as n from public.chapter_task_messages where task_id=$1", [world.linkedTask])).rows[0].n).toBe(1);
    // Someone who is not a participant of the task cannot enumerate or contact anyone.
    expect((await recipients(world.carol, "task", world.linkedTask)).items).toEqual([]);
  });

  it("delivers task messages through a steward reply, a roster steward and an accepted peer contact, each only through its own writer", async () => {
    // Bob joins alice as an assignee: alice stays the primary (task thread), bob is reached some other way.
    await call(world.steward, "public.set_chapter_task_assignees($1::uuid,$2::uuid[])", [world.linkedTask, [world.alice.id, world.bob.id]]);
    const count = async (table, where, params) => (await q(`select count(*)::int as n from ${table} where ${where}`, params)).rows[0].n;
    const ledgerFor = async (id) => (await q("select metadata from public.organization_audit_ledger where entity_id=$1", [id])).rows[0].metadata;
    const tag = randomUUID().replaceAll("-", "");

    // Steward -> bob: the steward's own reply path into bob's existing conversation (never a new right).
    const reply = await send(world.steward, "task", world.linkedTask, [world.bob.id], `Schedule note zr${tag}`, randomUUID());
    expect(reply.results[0]).toMatchObject({ recipientId: world.bob.id, via: "steward_reply", replayed: false });
    expect((await q("select conversation_id, sender_kind, sender_name, sender_id, user_id from public.member_messages where id=$1", [reply.results[0].messageId])).rows[0])
      .toEqual({ conversation_id: world.bobConversation, sender_kind: "steward", sender_name: "Chapter steward", sender_id: world.steward.id, user_id: world.bob.id });
    expect(await bodyHolders(`zr${tag}`)).toEqual(["public.member_messages"]);
    expect(await ledgerFor(reply.results[0].messageId)).toMatchObject({ entityType: "steward_reply", userId: world.bob.id, sourceKind: "task", sourceId: world.linkedTask });

    // Bob -> the creator: the creator is on bob's chapter roster, so the ordinary member -> steward writer applies.
    expect((await recipients(world.bob, "task", world.linkedTask)).items).toEqual([{ id: world.steward.id, label: "Sam Steward" }]);
    const conversationsBefore = await count("public.member_conversations", "user_id=$1", [world.bob.id]);
    const start = await send(world.bob, "task", world.linkedTask, [world.steward.id], `Member note zs${tag}`, randomUUID());
    expect(start.results[0]).toMatchObject({ recipientId: world.steward.id, via: "steward_start" });
    expect((await q("select conversation_id, sender_kind, sender_id, user_id from public.member_messages where id=$1", [start.results[0].messageId])).rows[0])
      .toEqual({ conversation_id: world.bobConversation, sender_kind: "member", sender_id: world.bob.id, user_id: world.bob.id });
    expect(await count("public.member_conversations", "user_id=$1", [world.bob.id])).toBe(conversationsBefore); // reused, not multiplied
    expect(await bodyHolders(`zs${tag}`)).toEqual(["public.member_messages"]);

    // An accepted peer contact wins over the other routes and is delivered by the peer writer alone.
    const request = randomUUID();
    await q("insert into public.member_peer_contact_requests(id,requester_id,recipient_id,chapter_id,status,responded_at) values ($1,$2,$3,$4,'accepted',now())", [request, world.steward.id, world.bob.id, world.chapter]);
    const [low, high] = [world.steward.id, world.bob.id].sort();
    await q("insert into public.member_peer_conversations(chapter_id,user_low,user_high,created_from_request) values ($1,$2,$3,$4)", [world.chapter, low, high, request]);
    const peer = await send(world.steward, "task", world.linkedTask, [world.bob.id], `Peer hello zp${tag}`, randomUUID());
    expect(peer.results[0]).toMatchObject({ recipientId: world.bob.id, via: "peer" });
    expect((await q("select sender_id, body from public.member_peer_messages where id=$1", [peer.results[0].messageId])).rows)
      .toEqual([{ sender_id: world.steward.id, body: `Peer hello zp${tag}` }]);
    expect(await bodyHolders(`zp${tag}`)).toEqual(["public.member_peer_messages"]);
    expect((await send(world.bob, "task", world.linkedTask, [world.steward.id], `Peer reply zq${tag}`, randomUUID())).results[0].via).toBe("peer");
    // The task thread stays alice's route, and only participants are ever offered.
    expect((await send(world.steward, "task", world.linkedTask, [world.alice.id], `Thread note zt${tag}`, randomUUID())).results[0].via).toBe("task_thread");
    expect((await recipients(world.steward, "task", world.linkedTask)).items.map((item) => item.id).sort()).toEqual([world.alice.id, world.bob.id].sort());
    expect((await recipients(world.carol, "task", world.linkedTask)).items).toEqual([]);
    await expectRefusal(send(world.carol, "task", world.linkedTask, [world.steward.id], "Not my task", randomUUID()), { code: "22023", detail: "cw:recipient_unavailable:recipient_unavailable" });
    // A replay of a peer send writes nothing new (the peer writer would otherwise count against its own rate limit).
    const request2 = randomUUID();
    const first = await send(world.steward, "task", world.linkedTask, [world.bob.id], `Peer twice zu${tag}`, request2);
    const again = await send(world.steward, "task", world.linkedTask, [world.bob.id], `Peer twice zu${tag}`, request2);
    expect(again).toMatchObject({ sent: 0, replayed: true });
    expect(again.results[0].messageId).toBe(first.results[0].messageId);
    expect(await count("public.member_peer_messages", "body=$1", [`Peer twice zu${tag}`])).toBe(1);

    // #9189: when the steward blocks bob, route peer is withheld both ways and
    // the steward routes are offered instead, so bob keeps a route to the union.
    const pair = (await q("select id from public.member_peer_conversations where user_low=$1 and user_high=$2", [low, high])).rows[0].id;
    expect((await call(world.steward, "public.set_peer_conversation_block($1::uuid,true)", [pair])).state).toBe("blocked_by_viewer");
    const peerBefore = await count("public.member_peer_messages", "conversation_id=$1", [pair]);
    const toSteward = await send(world.bob, "task", world.linkedTask, [world.steward.id], `Blocked member note zb${tag}`, randomUUID());
    expect(toSteward.results[0]).toMatchObject({ recipientId: world.steward.id, via: "steward_start" });
    expect((await send(world.steward, "task", world.linkedTask, [world.bob.id], `Steward note zc${tag}`, randomUUID())).results[0].via).toBe("steward_reply");
    expect(await count("public.member_peer_messages", "conversation_id=$1", [pair])).toBe(peerBefore);
    expect(await bodyHolders(`zb${tag}`)).toEqual(["public.member_messages"]);
    // Unblocked, the open conversation wins again.
    expect((await call(world.steward, "public.set_peer_conversation_block($1::uuid,false)", [pair])).state).toBe("open");
    expect((await send(world.bob, "task", world.linkedTask, [world.steward.id], `Peer again zd${tag}`, randomUUID())).results[0].via).toBe("peer");
  });

  it("stores and lists reminders with coalescing, snooze, completion and cancellation", async () => {
    const at = FUTURE(2);
    const first = await saveReminder(world.steward, "task", world.linkedTask, at, "check in");
    expect(first).toMatchObject({ created: true, coalesced: false });
    expect(first.reminder).toMatchObject({ kind: "task", status: "scheduled", available: true, note: "check in", snoozeCount: 0 });
    expect(first.reminder.title).toBe("Follow up on member message");
    expect(first.reminder.href).toBe(`/m/tasks?task=${world.linkedTask}`);
    const dup = await saveReminder(world.steward, "task", world.linkedTask, at);
    expect(dup).toMatchObject({ created: false, coalesced: true });
    expect(dup.reminder.id).toBe(first.reminder.id);

    const legacy = await saveReminder(world.alice, "private_message", world.aliceMessage, FUTURE(3));
    expect(legacy.reminder).toMatchObject({ kind: "private_message", status: "scheduled", title: null });
    const stored = (await q("select source_kind, status, private_message_id from public.member_message_reminders where id=$1", [legacy.reminder.id])).rows[0];
    expect(stored).toMatchObject({ source_kind: "private", status: "pending", private_message_id: world.aliceMessage });

    const listed = await listReminders(world.steward);
    expect(listed.items.map((item) => item.id)).toEqual([first.reminder.id]);
    expect((await listReminders(world.alice)).items.map((item) => item.id)).toEqual([legacy.reminder.id]);
    // Paging is keyset: a page of one hands out a cursor and the next page continues after it.
    await saveReminder(world.steward, "task", world.linkedTask, FUTURE(4));
    const page1 = await listReminders(world.steward, "open", null, 1);
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = await listReminders(world.steward, "open", page1.nextCursor, 1);
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].id).not.toBe(page1.items[0].id);
    expect(page2.nextCursor).toBeNull();

    const opened = await actOnReminder(world.steward, first.reminder.id, "open");
    expect(opened).toMatchObject({ available: true, replayed: false, href: `/m/tasks?task=${world.linkedTask}` });
    const snoozed = await actOnReminder(world.steward, first.reminder.id, "snooze", FUTURE(5));
    expect(snoozed.reminder).toMatchObject({ status: "scheduled", snoozeCount: 1 });
    await expectRefusal(actOnReminder(world.steward, first.reminder.id, "snooze", FUTURE(-1)), { code: "22023", detail: "cw:invalid_input:remind_at" });
    const done = await actOnReminder(world.steward, first.reminder.id, "complete");
    expect(done.reminder.status).toBe("completed");
    expect((await actOnReminder(world.steward, first.reminder.id, "complete")).replayed).toBe(true);
    await expectRefusal(actOnReminder(world.steward, first.reminder.id, "cancel"), { code: "22023", detail: "cw:capability_unavailable:reminder_closed" });
    expect((await listReminders(world.steward, "completed")).items.map((item) => item.id)).toEqual([first.reminder.id]);
    // Only the owner can act on a reminder.
    await expectRefusal(actOnReminder(world.bob, legacy.reminder.id, "cancel"), { code: "22023" });
    const cancelled = await actOnReminder(world.alice, legacy.reminder.id, "cancel");
    expect(cancelled.reminder.status).toBe("cancelled");
    // Limits: a note is bounded and the time must lie in the future.
    await expectRefusal(saveReminder(world.steward, "task", world.linkedTask, FUTURE(2), "x".repeat(501)), { code: "22023", detail: "cw:invalid_input:note" });
    await expectRefusal(saveReminder(world.steward, "task", world.linkedTask, FUTURE(-1)), { code: "22023", detail: "cw:invalid_input:remind_at" });
  });

  it("delivers due work reminders generically, isolates the legacy dispatcher, and fails closed when the source is gone", async () => {
    const soon = await saveReminder(world.steward, "task", world.linkedTask, FUTURE(1), "private note");
    const gone = await saveReminder(world.steward, "event", world.event, FUTURE(1));
    await q("update public.member_message_reminders set remind_at = now() - interval '1 minute' where id = any($1::uuid[])", [[soon.reminder.id, gone.reminder.id]]);
    const legacyRun = (await q("select private.dispatch_due_member_messaging(50) as value")).rows[0].value;
    expect(legacyRun.reminders).toBe(0);
    expect((await q("select status from public.member_message_reminders where id=$1", [soon.reminder.id])).rows[0].status).toBe("scheduled");
    // The event disappears from the reader's scope before delivery (membership change).
    await q("update public.member_profiles set chapter_id=$2 where id=$1", [world.steward.id, world.chapter2]);
    await q("update public.member_profiles set chapter_id=$2 where id=$1", [world.steward.id, world.chapter]);
    const run = (await q("select private.dispatch_due_workflow_reminders(50) as value")).rows[0].value;
    expect(run).toMatchObject({ delivered: 2, error: false });
    const notes = (await q("select title, body from public.member_notifications where message_reminder_id = any($1::uuid[])", [[soon.reminder.id, gone.reminder.id]])).rows;
    expect(notes).toHaveLength(2);
    for (const note of notes) {
      expect(note.title).toBe("Reminder");
      expect(note.body).toBe("Open your reminders to review it.");
    }
    expect(JSON.stringify(notes)).not.toContain("private note");
    const delivered = await listReminders(world.steward, "delivered");
    expect(delivered.items.map((item) => item.id).sort()).toEqual([soon.reminder.id, gone.reminder.id].sort());
    // Snoozing a delivered reminder frees its notification slot so it can notify again.
    const again = await actOnReminder(world.steward, soon.reminder.id, "snooze", FUTURE(1));
    expect(again.reminder.status).toBe("scheduled");
    expect((await q("select count(*)::int as n from public.member_notifications where message_reminder_id=$1", [soon.reminder.id])).rows[0].n).toBe(0);

    // Membership loss: the source is no longer readable, so the reminder is opaque and fails at delivery.
    await q("update public.member_message_reminders set remind_at = now() - interval '1 minute' where id=$1", [soon.reminder.id]);
    await q("update public.chapter_tasks set deleted_at = now(), deleted_by = $2 where id=$1", [world.linkedTask, world.steward.id]);
    const opaque = (await listReminders(world.steward, "scheduled")).items.find((item) => item.id === soon.reminder.id);
    expect(opaque).toMatchObject({ available: false, sourceId: null, href: null, title: null, sourceState: "unavailable" });
    await q("select private.dispatch_due_workflow_reminders(50)");
    expect((await q("select status from public.member_message_reminders where id=$1", [soon.reminder.id])).rows[0].status).toBe("failed");
    await q("update public.chapter_tasks set deleted_at = null, deleted_by = null where id=$1", [world.linkedTask]);
    await expectRefusal(actOnReminder(world.steward, soon.reminder.id, "snooze", FUTURE(2)), { code: "22023", detail: "cw:capability_unavailable:reminder_closed" });
  });

  it("does not deliver a reminder when the event was cancelled after scheduling", async () => {
    await q("savepoint cancelled_dispatch_proof");
    try {
      const saved = await saveReminder(world.alice, "event", world.event, FUTURE(4));
      await q("update public.member_message_reminders set remind_at=now()-interval '1 minute' where id=$1", [saved.reminder.id]);
      await q("update public.member_events set cancelled_at=now() where id=$1", [world.event]);
      const result = (await q("select private.dispatch_due_workflow_reminders(50) as value")).rows[0].value;
      expect(result).toMatchObject({ delivered: 0, failed: 1, error: false });
      expect((await q("select status from public.member_message_reminders where id=$1", [saved.reminder.id])).rows[0].status).toBe("failed");
      expect((await q("select count(*)::int as n from public.member_notifications where message_reminder_id=$1", [saved.reminder.id])).rows[0].n).toBe(0);
    } finally { await q("rollback to savepoint cancelled_dispatch_proof"); }
  });

  it("isolates a broken notification row and delivers both earlier and later reminders", async () => {
    await q("savepoint isolated_dispatch_proof");
    try {
      const ids = [];
      for (let i = 1; i <= 3; i++) {
        const saved = await saveReminder(world.alice, "event", world.event, FUTURE(i));
        ids.push(saved.reminder.id);
        await q("update public.member_message_reminders set remind_at=now()-($2 * interval '1 minute') where id=$1", [saved.reminder.id, 4 - i]);
      }
      await q(`create function pg_temp.cw_poison_notification() returns trigger language plpgsql as $$
        begin if new.message_reminder_id = '${ids[1]}'::uuid then raise exception 'fixture delivery failure'; end if; return new; end $$`);
      await q("create trigger cw_poison_notification before insert on public.member_notifications for each row execute function pg_temp.cw_poison_notification()");
      const result = (await q("select private.dispatch_due_workflow_reminders(50) as value")).rows[0].value;
      expect(result).toMatchObject({ delivered: 2, failed: 1, error: true });
      const states = Object.fromEntries((await q("select id,status from public.member_message_reminders where id=any($1::uuid[])", [ids])).rows.map(row => [row.id, row.status]));
      expect(ids.map(id => states[id])).toEqual(["delivered", "failed", "delivered"]);
      const delivered = (await q("select message_reminder_id from public.member_notifications where message_reminder_id=any($1::uuid[])", [ids])).rows.map(row => row.message_reminder_id);
      expect(delivered.sort()).toEqual([ids[0], ids[2]].sort());
    } finally { await q("rollback to savepoint isolated_dispatch_proof"); }
  });

  it("refuses reminders, consent, listing and sends for a cancelled event", async () => {
    const view = await context(world.alice, "event", world.cancelled);
    expect(view).toMatchObject({ available: true, state: "cancelled", cancelled: true, canRemind: false, canContactOptIn: false, canMessage: false });
    expect(view.reasons.remind).toBe("event_cancelled");
    await expectRefusal(saveReminder(world.alice, "event", world.cancelled, FUTURE(1)), { code: "22023", detail: "cw:event_cancelled:event_cancelled" });
    await expectRefusal(optIn(world.alice, world.cancelled, true, randomUUID()), { code: "22023", detail: "cw:event_cancelled:event_cancelled" });
    expect((await recipients(world.steward, "event", world.cancelled)).reason).toBe("event_cancelled");
    await expectRefusal(send(world.steward, "event", world.cancelled, [world.alice.id], "Hello", randomUUID()), { code: "22023", detail: "cw:event_cancelled:event_cancelled" });
    // A follow-up task is still allowed for a cancelled event of the caller's chapter.
    const canTask = await context(world.steward, "event", world.cancelled);
    expect(canTask).toMatchObject({ canCreateTask: true, cancelled: true });
  });

  it("assigns and clears an organizer only through event staff, and only a steward who could contact members", async () => {
    await expectRefusal(setOrganizer(world.alice, world.event, world.steward.id), { code: "42501", detail: "cw:not_authorized:staff_grant_required" });
    await expectRefusal(candidates(world.alice, world.event), { code: "42501" });
    const listed = await candidates(world.coordinator, world.event);
    expect(listed.items.map((item) => item.id).sort()).toEqual([world.steward.id, world.steward2.id].sort());
    expect(listed.items.find((item) => item.id === world.steward.id).label).toBe("Sam Steward");
    // The coordinator can manage the event but is not offered as organizer (no private-message right).
    await expectRefusal(setOrganizer(world.coordinator, world.event, world.coordinator.id), { code: "22023", detail: "cw:invalid_input:organizer_unavailable" });
    await expectRefusal(setOrganizer(world.coordinator, world.event, world.alice.id), { code: "22023", detail: "cw:invalid_input:organizer_unavailable" });
    // Staff of another chapter cannot manage this event.
    await expectRefusal(candidates(world.erin, world.event), { code: "22023" });

    expect((await context(world.alice, "event", world.event)).organizer).toBeNull();
    await expectRefusal(optIn(world.alice, world.event, true, randomUUID()), { code: "22023", detail: "cw:organizer_required:organizer_required" });
    const assigned = await setOrganizer(world.coordinator, world.event, world.steward.id);
    // The version it leaves (REQ-UG-LEARNING-PERIOD-EVENTS-20261103).
    expect(assigned).toEqual({ eventId: world.event, organizer: { id: world.steward.id, label: "Sam Steward" }, changed: true, version: 2 });
    expect((await setOrganizer(world.coordinator, world.event, world.steward.id)).changed).toBe(false);
    expect((await q("select action, detail from public.member_admin_audit where actor=$1 and detail->>'eventId'=$2 order by created_at desc limit 1", [world.coordinator.id, world.event])).rows[0])
      .toMatchObject({ action: "update_event", detail: { eventId: world.event, fields: ["organizer"] } });

    const asMember = await context(world.alice, "event", world.event);
    expect(asMember).toMatchObject({ organizer: { id: world.steward.id, label: "Sam Steward" }, canManageOrganizer: false, canContactOptIn: true, contactOptIn: false, contactRole: null });
    expect(asMember.timezone).toEqual({ basis: "instant", startsAt: expect.any(String), eventZone: null });
    const asManager = await context(world.coordinator, "event", world.event);
    expect(asManager.canManageOrganizer).toBe(true);
    expect((await context(world.steward, "event", world.event)).contactRole).toBe("organizer");
    // A steward of another chapter neither sees management nor a participant list.
    expect((await context(world.erin, "event", world.event)).available).toBe(false);
  });

  it("records attendee consent only for an attending member, and lets them withdraw at any time", async () => {
    const notGoing = await person("late", { name: "Late Attendee" });
    await rsvp(world.event, notGoing, "not_going");
    await expectRefusal(optIn(notGoing, world.event, true), { code: "22023", detail: "cw:opt_in_required:not_attending" });
    await expectRefusal(optIn(world.steward, world.event, true), { code: "22023", detail: "cw:capability_unavailable:organizer_cannot_opt_in" });
    expect(await optIn(world.alice, world.event, true)).toEqual({ eventId: world.event, contactOptIn: true, changed: true, organizerId: world.steward.id });
    expect((await optIn(world.alice, world.event, true)).changed).toBe(false);
    expect(await optIn(world.bob, world.event, true)).toMatchObject({ contactOptIn: true });
    expect(await optIn(world.carol, world.event, true)).toMatchObject({ contactOptIn: true });
    expect((await context(world.alice, "event", world.event)).contactOptIn).toBe(true);
    expect((await optIn(world.bob, world.event, false)).changed).toBe(true);
    expect((await optIn(world.bob, world.event, false)).changed).toBe(false);
    expect(await optIn(world.bob, world.event, true)).toMatchObject({ changed: true });
    // Nobody but the attendee can read or change this row.
    expect((await q("select count(*)::int as n from private.member_event_contact_opt_ins where event_id=$1", [world.event])).rows[0].n).toBe(3);
    await expectRefusal(asUser(world.alice, () => q("select * from private.member_event_contact_opt_ins")), { code: "42501" });
  });

  it("binds consent to the organizer the attendee was shown, so a stale form cannot grant a new organizer", async () => {
    const staleEvent = "cw-rally-stale";
    await newEvent(staleEvent, { order: 5 });
    await rsvp(staleEvent, world.alice);
    await setOrganizer(world.coordinator, staleEvent, world.steward.id); // organizer A
    const shown = (await context(world.alice, "event", staleEvent)).organizer.id; // captured when the control rendered
    expect(shown).toBe(world.steward.id);
    await setOrganizer(world.coordinator, staleEvent, world.steward2.id); // staff changes it to B
    await expectRefusal(optIn(world.alice, staleEvent, true, shown), { code: "22023", detail: "cw:organizer_changed:organizer_changed" });
    const rows = () => q("select user_id, organizer_id from private.member_event_contact_opt_ins where event_id=$1", [staleEvent]).then((r) => r.rows);
    expect(await rows()).toEqual([]); // no consent was recorded for B
    expect(await context(world.alice, "event", staleEvent)).toMatchObject({ organizer: { id: world.steward2.id }, contactOptIn: false, canContactOptIn: true });
    // Enabling without naming the organizer is refused too; only an explicit confirmation of B is accepted.
    await expectRefusal(optIn(world.alice, staleEvent, true, null), { code: "22023", detail: "cw:invalid_input:expected_organizer" });
    expect(await optIn(world.alice, staleEvent, true, world.steward2.id)).toEqual({ eventId: staleEvent, contactOptIn: true, changed: true, organizerId: world.steward2.id });
    expect(await rows()).toEqual([{ user_id: world.alice.id, organizer_id: world.steward2.id }]);
    expect((await optIn(world.alice, staleEvent, true, world.steward2.id)).changed).toBe(false);
    // Changing the organizer again removes that consent: it never carries over to another person.
    await setOrganizer(world.coordinator, staleEvent, world.steward.id);
    expect(await rows()).toEqual([]);
    expect((await context(world.alice, "event", staleEvent)).contactOptIn).toBe(false);
    // Belt and braces: a consent row that names another organizer stays dormant even if it were written around the RPC.
    await q("insert into private.member_event_contact_opt_ins(event_id,user_id,organizer_id) values ($1,$2,$3)", [staleEvent, world.alice.id, world.steward2.id]);
    expect((await context(world.alice, "event", staleEvent)).contactOptIn).toBe(false);
    expect((await recipients(world.steward, "event", staleEvent)).items).toEqual([]);
    expect(await thread(world.steward, staleEvent, world.alice.id)).toMatchObject({ available: false });
    await expectRefusal(send(world.steward, "event", staleEvent, [world.alice.id], "Hello", randomUUID()), { code: "22023", detail: "cw:recipient_unavailable:recipient_unavailable" });
    // Withdrawing needs no organizer id and clears the dormant row as well.
    expect(await optIn(world.alice, staleEvent, false)).toMatchObject({ contactOptIn: false, changed: true });
    expect(await rows()).toEqual([]);
  });

  it("delivers organizer contact through canonical private conversations with explicit consent", async () => {
    // Alice, Bob and Carol consented; Carol has no conversation yet;
    // a non-consenting attendee and an unrelated member are never offered.
    const audience = await recipients(world.steward, "event", world.event);
    expect(audience.status).toBe("available");
    expect(audience.items).toEqual([
      { id: world.alice.id, label: "Alice Attendee" },
      { id: world.bob.id, label: "Bob Attendee" },
      { id: world.carol.id, label: "Carol Attendee" },
    ]);
    const others = await recipients(world.steward2, "event", world.event);
    expect(others).toMatchObject({ status: "unavailable", reason: "no_authorized_audience", items: [] });
    // A consenting attendee may start a conversation with the organizer (the ordinary roster writer).
    expect((await recipients(world.alice, "event", world.event))).toMatchObject({ status: "available", items: [{ id: world.steward.id, label: "Sam Steward" }] });
    expect((await context(world.steward, "event", world.event)).canMessage).toBe(true);
    await expectRefusal(send(world.steward2, "event", world.event, [world.alice.id], "Hi Alice", randomUUID()), { code: "22023", detail: "cw:recipient_unavailable:recipient_unavailable" });
    await expectRefusal(send(world.steward, "event", world.event, [world.erin.id], "Hi Erin", randomUUID()), { code: "22023" });

    const needle = `zq${randomUUID().replaceAll("-", "")}`;
    const body = `Rally logistics ${needle}`;
    const request = randomUUID();
    const sent = await send(world.steward, "event", world.event, [world.alice.id, world.bob.id], body, request);
    expect(sent.sent).toBe(2);
    expect(sent.results.map((r) => r.via)).toEqual(["event_organizer", "event_organizer"]);
    world.contactMessages = Object.fromEntries(sent.results.map((r) => [r.recipientId, r.messageId]));

    // The words exist exactly once per delivery, in the canonical private-message rows.
    const stored = (await q("select id, conversation_id, user_id, sender_kind, sender_name, sender_id, body from public.member_messages where body like $1 order by conversation_id", [`%${needle}%`])).rows;
    expect(stored).toHaveLength(2);
    expect(stored.map((row) => row.conversation_id).sort()).toEqual([world.aliceConversation, world.bobConversation].sort());
    for (const row of stored) {
      expect(row).toMatchObject({ sender_kind: "steward", sender_name: "Chapter steward", sender_id: world.steward.id, body });
    }
    expect(await bodyHolders(needle)).toEqual(["public.member_messages"]);
    const links = (await q("select message_id, event_id, organizer_id, participant_id, sender_role from private.member_event_contact_links order by participant_id")).rows;
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.message_id).sort()).toEqual(stored.map((r) => r.id).sort());
    for (const link of links) expect(link).toMatchObject({ event_id: world.event, organizer_id: world.steward.id, sender_role: "organizer" });
    expect(JSON.stringify((await q("select * from private.member_event_contact_links")).rows)).not.toContain(needle);
    const ledger = (await q("select metadata from public.organization_audit_ledger where entity_id = any($1::text[])", [Object.values(world.contactMessages)])).rows;
    expect(JSON.stringify(ledger)).not.toContain(needle);

    // Replay converges: same request, same payload writes nothing more; a changed payload is a conflict.
    const replay = await send(world.steward, "event", world.event, [world.alice.id, world.bob.id], body, request);
    expect(replay).toMatchObject({ sent: 0, replayed: true });
    await expectRefusal(send(world.steward, "event", world.event, [world.alice.id, world.bob.id], `${body} edited`, request), { code: "23505" });
    expect((await q("select count(*)::int as n from public.member_messages where body like $1", [`%${needle}%`])).rows[0].n).toBe(2);
    world.needle = needle;
    world.body = body;

    // The organizer and the participant each read the thread from the canonical row.
    const asOrganizer = await thread(world.steward, world.event, world.alice.id);
    expect(asOrganizer).toMatchObject({ available: true, nextCursor: null });
    expect(asOrganizer.items).toEqual([{
      id: world.contactMessages[world.alice.id], mine: true, senderRole: "organizer", body, redacted: false, createdAt: expect.any(String),
    }]);
    const asParticipant = await thread(world.alice, world.event);
    expect(asParticipant.items).toEqual([{ ...asOrganizer.items[0], mine: false }]);
    // Bob's thread is not Alice's, another steward is not the organizer, and a stranger has nothing.
    expect((await thread(world.steward, world.event, world.bob.id)).items.map((i) => i.id)).toEqual([world.contactMessages[world.bob.id]]);
    expect(await thread(world.steward, world.event, null)).toMatchObject({ available: false, items: [] });
    // Carol consented but was never contacted: an available, empty thread, never someone else's messages.
    expect(await thread(world.steward, world.event, world.carol.id)).toMatchObject({ available: true, items: [] });
    // Another steward is not the organizer, so naming a participant gets nothing.
    expect(await thread(world.steward2, world.event, world.alice.id)).toMatchObject({ available: false, items: [] });
    expect(await thread(world.dave, world.event)).toMatchObject({ available: false, items: [] });
    expect((await context(world.alice, "event", world.event)).discussionHref).toBe(`/m/events?event=${world.event}&discussion=1`);
    expect((await context(world.steward, "event", world.event)).discussionHref).toBe(`/m/events?event=${world.event}&discussion=1`);
    expect((await context(world.carol, "event", world.event)).discussionHref).toBeNull();
    expect((await context(world.steward2, "event", world.event)).discussionHref).toBeNull();
  });

  it("creates a canonical conversation only when the organizer explicitly sends to a consenting attendee", async () => {
    const eventId = `cw-first-${randomUUID()}`;
    await newEvent(eventId, { order: 40 });
    const attendee = await person("First contact");
    await rsvp(eventId, attendee);
    await setOrganizer(world.coordinator, eventId, world.steward.id);
    const count = () => q("select count(*)::int as n from public.member_conversations where user_id=$1", [attendee.id]).then(r => r.rows[0].n);
    await expectRefusal(send(world.steward, "event", eventId, [attendee.id], "Event follow-up", randomUUID()));
    expect(await count()).toBe(0);
    await optIn(attendee, eventId, true);
    expect((await recipients(world.steward, "event", eventId)).items).toEqual([{ id: attendee.id, label: "First contact" }]);
    expect(await count()).toBe(0); // Reading the audience and opening a draft creates nothing.
    const request = randomUUID();
    const result = await send(world.steward, "event", eventId, [attendee.id], "Event follow-up", request);
    expect(result.sent).toBe(1);
    expect(await count()).toBe(1);
    expect(await send(world.steward, "event", eventId, [attendee.id], "Event follow-up", request)).toMatchObject({ sent: 0, replayed: true });
    const saved = (await q("select c.title,c.steward_user_id,m.body from public.member_conversations c join public.member_messages m on m.conversation_id=c.id where c.user_id=$1", [attendee.id])).rows;
    expect(saved).toEqual([{ title: "Chapter steward", steward_user_id: world.steward.id, body: "Event follow-up" }]);
    await optIn(attendee, eventId, false);
    await expectRefusal(send(world.steward, "event", eventId, [attendee.id], "Second follow-up", randomUUID()));
    expect(await count()).toBe(1);
  });

  it("lets a participant reply only to the organizer, only in the thread the organizer started", async () => {
    // Alice and Bob were contacted and may reply in that thread; Carol consented but was not contacted,
    // so she is offered the organizer only as a conversation to START (asserted in its own case).
    const mine = await recipients(world.alice, "event", world.event);
    expect(mine).toMatchObject({ status: "available", items: [{ id: world.steward.id, label: "Sam Steward" }] });
    expect((await recipients(world.carol, "event", world.event)).items).toEqual([{ id: world.steward.id, label: "Sam Steward" }]);
    await expectRefusal(send(world.alice, "event", world.event, [world.steward2.id], "Wrong person", randomUUID()), { code: "22023" });
    const reply = await send(world.alice, "event", world.event, [world.steward.id], "Yes, I will be there", randomUUID());
    expect(reply.results[0]).toMatchObject({ recipientId: world.steward.id, via: "event_participant", replayed: false });
    const row = (await q("select user_id, sender_kind, sender_id, conversation_id from public.member_messages where id=$1", [reply.results[0].messageId])).rows[0];
    expect(row).toMatchObject({ user_id: world.alice.id, sender_kind: "member", sender_id: world.alice.id, conversation_id: world.aliceConversation });
    // Both rows share this fixture transaction's timestamp, so assert the set, not the order.
    const seen = await thread(world.steward, world.event, world.alice.id);
    expect(seen.items.map((item) => [item.senderRole, item.mine]).sort()).toEqual([["organizer", true], ["participant", false]]);
    expect(seen.items.find((item) => item.senderRole === "participant").body).toBe("Yes, I will be there");
  });

  it("pages recipients, organizer candidates and the event thread by keyset, and refuses a malformed cursor", async () => {
    // One item per page, so every page boundary is exercised.
    const audiencePage = (cursor) => call(world.steward, "public.list_connected_workflow_recipients($1,$2,$3,1,null,null::uuid)", ["event", world.event, cursor]);
    const first = await audiencePage(null);
    expect(first).toMatchObject({ status: "available", items: [{ id: world.alice.id, label: "Alice Attendee" }] });
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await audiencePage(first.nextCursor);
    expect(second).toMatchObject({ status: "available", items: [{ id: world.bob.id, label: "Bob Attendee" }], nextCursor: expect.any(String) });
    expect(await audiencePage(second.nextCursor)).toMatchObject({ status: "available", items: [{ id: world.carol.id, label: "Carol Attendee" }], nextCursor: null });
    // Past the last item is an empty page of a still-available list, not the "no audience" answer.
    expect(await audiencePage(JSON.stringify(["carol attendee", world.carol.id]))).toEqual({ status: "available", reason: null, items: [], nextCursor: null });
    const sized = (limit) => call(world.steward, "public.list_connected_workflow_recipients($1,$2,null,$3,null,null::uuid)", ["event", world.event, limit]);
    expect((await sized(0)).items).toHaveLength(1);
    expect((await sized(1000)).items).toHaveLength(3);

    const candidatePage = (cursor) => call(world.coordinator, "public.list_member_event_organizer_candidates($1,$2,1)", [world.event, cursor]);
    const firstCandidate = await candidatePage(null);
    expect(firstCandidate.items).toEqual([{ id: world.steward.id, label: "Sam Steward" }]);
    expect(await candidatePage(firstCandidate.nextCursor)).toEqual({ items: [{ id: world.steward2.id, label: "Sky Steward" }], nextCursor: null });

    // Alice's two messages share this fixture transaction's timestamp, so the id tiebreaker alone must split them.
    const whole = (await thread(world.steward, world.event, world.alice.id)).items.map((item) => item.id);
    expect(whole).toHaveLength(2);
    const threadPage = (reader, participant, cursor) => call(reader, "public.list_member_event_contact_messages($1,$2::uuid,$3,1)", [world.event, participant, cursor]);
    for (const [reader, participant] of [[world.steward, world.alice.id], [world.alice, null]]) {
      const newer = await threadPage(reader, participant, null);
      expect(newer).toMatchObject({ available: true, nextCursor: expect.any(String) });
      const older = await threadPage(reader, participant, newer.nextCursor);
      expect(older).toMatchObject({ available: true, nextCursor: null });
      expect([...newer.items, ...older.items].map((item) => item.id)).toEqual(whole);
    }

    // A cursor is only a position in an already authorized list; anything else is refused before any read.
    for (const bad of ["not json", "{}", "[]", '["only-one"]', `[null,"${randomUUID()}"]`, '["x","not-a-uuid"]']) {
      const invalidCursor = { code: "22023", detail: "cw:invalid_input:cursor" };
      await expectRefusal(audiencePage(bad), invalidCursor);
      await expectRefusal(candidatePage(bad), invalidCursor);
      await expectRefusal(threadPage(world.steward, world.alice.id, bad), invalidCursor);
      await expectRefusal(listReminders(world.steward, "open", bad), invalidCursor);
    }
  });

  it("reads bodies from the canonical row: redaction removes the event-thread body and no duplicate survives", async () => {
    const messageId = world.contactMessages[world.bob.id];
    const removed = await call(world.steward, "public.redact_member_message($1::uuid)", [messageId]);
    expect(removed).toMatchObject({ redacted: true });
    const canonical = (await q("select body, redacted_at, redaction_reason, body_sha256 from public.member_messages where id=$1", [messageId])).rows[0];
    expect(canonical.body).toBe("");
    expect(canonical.redacted_at).not.toBeNull();
    expect(canonical.body_sha256).toMatch(/^[0-9a-f]{64}$/);
    const asOrganizer = await thread(world.steward, world.event, world.bob.id);
    expect(asOrganizer.items).toEqual([expect.objectContaining({ id: messageId, body: "", redacted: true })]);
    expect((await thread(world.bob, world.event)).items).toEqual([expect.objectContaining({ id: messageId, body: "", redacted: true })]);
    // Alice's copy is untouched, and the words survive in exactly one place: her canonical message.
    expect(await bodyHolders(world.needle)).toEqual(["public.member_messages"]);
    expect((await q("select count(*)::int as n from public.member_messages where body like $1", [`%${world.needle}%`])).rows[0].n).toBe(1);
    // The link keeps only metadata; the tombstone is a redacted canonical row, never a second copy.
    expect((await q("select count(*)::int as n from private.member_event_contact_links where message_id=$1", [messageId])).rows[0].n).toBe(1);
    // A redacted organizer message is no longer a reply anchor; Bob's consent still lets him START one.
    expect((await recipients(world.bob, "event", world.event)).items).toEqual([{ id: world.steward.id, label: "Sam Steward" }]);
  });

  it("stops contact when consent, attendance, membership or the organizer's grant is lost", async () => {
    const before = (await q("select count(*)::int as n from public.member_messages")).rows[0].n;
    const audienceIds = async () => (await recipients(world.steward, "event", world.event)).items.map((item) => item.id);
    // Alice withdraws: she stays readable to herself, but the organizer no longer sees or reaches her.
    await optIn(world.alice, world.event, false);
    expect(await audienceIds()).toEqual([world.bob.id, world.carol.id]);
    await expectRefusal(send(world.steward, "event", world.event, [world.alice.id], "Still there?", randomUUID()), { code: "22023" });
    expect(await thread(world.steward, world.event, world.alice.id)).toMatchObject({ available: false, items: [] });
    expect((await thread(world.alice, world.event)).items.length).toBe(2);
    expect((await context(world.steward, "event", world.event)).discussionHref).toBe(`/m/events?event=${world.event}&discussion=1`);
    expect((await context(world.alice, "event", world.event)).discussionHref).toBe(`/m/events?event=${world.event}&discussion=1`);
    await optIn(world.alice, world.event, true);
    expect(await audienceIds()).toEqual([world.alice.id, world.bob.id, world.carol.id]);
    // Attendance lost: the participant drops out of the audience although the consent row remains.
    await rsvp(world.event, world.alice, "not_going");
    expect(await audienceIds()).toEqual([world.bob.id, world.carol.id]);
    await rsvp(world.event, world.alice, "going");
    expect(await audienceIds()).toEqual([world.alice.id, world.bob.id, world.carol.id]);
    // Membership lost: Alice leaves the tenant scope, so neither side can read the thread any more.
    await q("update public.member_profiles set chapter_id=$2 where id=$1", [world.alice.id, world.chapter2]);
    expect(await audienceIds()).toEqual([world.bob.id, world.carol.id]);
    expect(await thread(world.alice, world.event)).toMatchObject({ available: false, items: [] });
    expect((await context(world.alice, "event", world.event)).available).toBe(false);
    await q("update public.member_profiles set chapter_id=$2 where id=$1", [world.alice.id, world.chapter]);
    expect((await thread(world.alice, world.event)).available).toBe(true);
    // A remaining coordinator grant cannot substitute for the lost steward grant.
    await grant(world.steward, "coordinator");
    await q("delete from public.member_role_chapters where user_id=$1 and role='steward'", [world.steward.id]);
    expect(await audienceIds()).toEqual([]);
    expect(await thread(world.steward, world.event, world.alice.id)).toMatchObject({ available: false });
    await expectRefusal(send(world.steward, "event", world.event, [world.alice.id], "Hello?", randomUUID()), { code: "22023" });
    expect((await context(world.alice, "event", world.event)).organizer).toBeNull();
    await expectRefusal(optIn(world.alice, world.event, true), { code: "22023", detail: "cw:organizer_required:organizer_required" });
    await q("delete from public.member_role_chapters where user_id=$1 and role='coordinator'", [world.steward.id]);
    await q("delete from public.member_roles where user_id=$1 and role='coordinator'", [world.steward.id]);
    await q("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'steward',$2)", [world.steward.id, world.chapter]);
    expect((await q("select count(*)::int as n from public.member_messages")).rows[0].n).toBe(before);
    // A different organizer starts from no consent and cannot read the previous organizer's threads.
    await setOrganizer(world.coordinator, world.event, world.steward2.id);
    expect((await q("select count(*)::int as n from private.member_event_contact_opt_ins where event_id=$1", [world.event])).rows[0].n).toBe(0);
    expect(await thread(world.steward, world.event, world.alice.id)).toMatchObject({ available: false });
    expect((await thread(world.steward2, world.event, world.alice.id)).available).toBe(false);
    await setOrganizer(world.coordinator, world.event, null);
    expect((await context(world.alice, "event", world.event)).organizer).toBeNull();
  });

  it("keeps hold-protected bodies through account deletion and destroys unheld ones, never through the link", async () => {
    await setOrganizer(world.coordinator, world.event, world.steward.id);
    const heldUser = await person("held", { name: "Held Attendee" });
    const looseUser = await person("loose", { name: "Loose Attendee" });
    const heldConversation = await conversation(heldUser);
    const looseConversation = await conversation(looseUser);
    await memberMessage(heldConversation, heldUser, "opening question");
    await memberMessage(looseConversation, looseUser, "opening question");
    for (const user of [heldUser, looseUser]) {
      await rsvp(world.event, user);
      await optIn(user, world.event, true);
    }
    const needle = `hz${randomUUID().replaceAll("-", "")}`;
    const sent = await send(world.steward, "event", world.event, [heldUser.id, looseUser.id], `Held and loose ${needle}`, randomUUID());
    const byRecipient = Object.fromEntries(sent.results.map((r) => [r.recipientId, r.messageId]));
    await q("insert into public.member_message_legal_holds(conversation_id,organization_id,reason_code) values ($1,$2,'litigation')", [heldConversation, world.org]);

    await q("delete from auth.users where id=$1", [heldUser.id]);
    const held = (await q("select body, user_id, redacted_at from public.member_messages where id=$1", [byRecipient[heldUser.id]])).rows[0];
    expect(held.body).toBe(`Held and loose ${needle}`);
    expect(held.redacted_at).toBeNull();
    expect(held.user_id).toBeNull();
    const heldLink = (await q("select participant_id, organizer_id, event_id from private.member_event_contact_links where message_id=$1", [byRecipient[heldUser.id]])).rows[0];
    expect(heldLink).toEqual({ participant_id: null, organizer_id: world.steward.id, event_id: world.event });
    // The organizer can no longer read a departed participant's thread through the event.
    expect(await thread(world.steward, world.event, heldUser.id)).toMatchObject({ available: false, items: [] });
    // Deletion of the row itself stays refused under the preservation order; the link cannot cascade around it.
    await q("savepoint held_delete");
    await expectRefusal(q("delete from public.member_messages where id=$1", [byRecipient[heldUser.id]]), { code: "42501" });
    await q("rollback to savepoint held_delete");
    expect((await q("select count(*)::int as n from private.member_event_contact_links where message_id=$1", [byRecipient[heldUser.id]])).rows[0].n).toBe(1);

    // Unheld: the lifecycle tombstones the body and then removes the conversation with the account.
    // The metadata link leaves with the canonical row; nothing else ever held the words.
    await q("delete from auth.users where id=$1", [looseUser.id]);
    expect((await q("select count(*)::int as n from public.member_messages where id=$1", [byRecipient[looseUser.id]])).rows[0].n).toBe(0);
    expect((await q("select count(*)::int as n from private.member_event_contact_links where message_id=$1", [byRecipient[looseUser.id]])).rows[0].n).toBe(0);
    expect(await bodyHolders(needle)).toEqual(["public.member_messages"]);
    expect((await q("select count(*)::int as n from public.member_messages where body like $1", [`%${needle}%`])).rows[0].n).toBe(1);
  });

  it("lets a consenting attendee start a conversation with the organizer through the ordinary roster writer", async () => {
    world.startEvent = "cw-rally-start";
    await newEvent(world.startEvent, { order: 3 });
    const frank = await person("frank", { name: "Frank Attendee" });
    const dana = await person("dana", { name: "Dana Attendee" });
    world.frank = frank;
    world.dana = dana;
    for (const attendee of [frank, dana]) await rsvp(world.startEvent, attendee);
    await setOrganizer(world.coordinator, world.startEvent, world.steward.id);

    // No contact before consent: Dana attends but has not opted in.
    expect(await recipients(dana, "event", world.startEvent)).toMatchObject({ status: "unavailable", items: [] });
    await expectRefusal(send(dana, "event", world.startEvent, [world.steward.id], "Hello organizer", randomUUID()), { code: "22023", detail: "cw:recipient_unavailable:recipient_unavailable" });
    expect((await context(dana, "event", world.startEvent)).canMessage).toBe(false);
    await optIn(frank, world.startEvent, true);

    // Frank has no conversation and nobody has written to him, yet he may start one with the organizer
    // because the organizer is on his own chapter's steward roster (the writer's exact predicate).
    expect((await q("select count(*)::int as n from public.member_conversations where user_id=$1", [frank.id])).rows[0].n).toBe(0);
    expect(await recipients(frank, "event", world.startEvent)).toMatchObject({ status: "available", items: [{ id: world.steward.id, label: "Sam Steward" }] });
    expect((await context(frank, "event", world.startEvent)).canMessage).toBe(true);
    // Explicit consent also allows organizer-initiated first contact; reading the audience creates no thread.
    expect((await recipients(world.steward, "event", world.startEvent)).items).toEqual([{ id: frank.id, label: "Frank Attendee" }]);
    expect((await q("select count(*)::int as n from public.member_conversations where user_id=$1", [frank.id])).rows[0].n).toBe(0);

    const needle = `st${randomUUID().replaceAll("-", "")}`;
    const body = `Can I bring a guest? ${needle}`;
    const request = randomUUID();
    const started = await send(frank, "event", world.startEvent, [world.steward.id], body, request);
    expect(started).toMatchObject({ sent: 1, replayed: false });
    expect(started.results[0]).toMatchObject({ recipientId: world.steward.id, via: "event_participant_start", replayed: false });
    const conversations = (await q("select id, steward_user_id from public.member_conversations where user_id=$1", [frank.id])).rows;
    expect(conversations).toEqual([{ id: expect.any(String), steward_user_id: world.steward.id }]);
    const stored = (await q("select conversation_id, user_id, sender_kind, sender_id, body from public.member_messages where id=$1", [started.results[0].messageId])).rows[0];
    expect(stored).toMatchObject({ conversation_id: conversations[0].id, user_id: frank.id, sender_kind: "member", sender_id: frank.id, body });
    expect(await bodyHolders(needle)).toEqual(["public.member_messages"]);
    expect((await q("select event_id, organizer_id, participant_id, sender_role from private.member_event_contact_links where message_id=$1", [started.results[0].messageId])).rows)
      .toEqual([{ event_id: world.startEvent, organizer_id: world.steward.id, participant_id: frank.id, sender_role: "participant" }]);
    expect(JSON.stringify((await q("select metadata from public.organization_audit_ledger where entity_id=$1", [started.results[0].messageId])).rows)).not.toContain(needle);

    // A repeat of the same request replays; a different text under the same id is a conflict; nothing is written twice.
    expect(await send(frank, "event", world.startEvent, [world.steward.id], body, request)).toMatchObject({ sent: 0, replayed: true });
    await expectRefusal(send(frank, "event", world.startEvent, [world.steward.id], `${body}!`, request), { code: "23505" });
    // The organizer reads it as an event thread, and now that the conversation exists can answer inside it.
    const asOrganizer = await thread(world.steward, world.startEvent, frank.id);
    expect(asOrganizer.items).toEqual([expect.objectContaining({ id: started.results[0].messageId, senderRole: "participant", mine: false, body, redacted: false })]);
    expect((await recipients(world.steward, "event", world.startEvent)).items).toEqual([{ id: frank.id, label: "Frank Attendee" }]);
    const answer = await send(world.steward, "event", world.startEvent, [frank.id], "Yes, one guest is welcome", randomUUID());
    expect(answer.results[0]).toMatchObject({ via: "event_organizer" });
    expect((await q("select conversation_id from public.member_messages where id=$1", [answer.results[0].messageId])).rows[0].conversation_id).toBe(conversations[0].id);
    // Further messages keep using that one conversation; from here a reply anchor exists and is preferred.
    const again = await send(frank, "event", world.startEvent, [world.steward.id], "Thank you", randomUUID());
    expect(again.results[0].via).toBe("event_participant");
    expect((await q("select count(*)::int as n from public.member_conversations where user_id=$1", [frank.id])).rows[0].n).toBe(1);
    expect((await thread(frank, world.startEvent)).items).toHaveLength(3);
  });

  it("denies initiation when consent, attendance, membership, cancellation, roster or the organizer's grant is lost", async () => {
    const gus = await person("gus", { name: "Gus Attendee" });
    await rsvp(world.startEvent, gus);
    await optIn(gus, world.startEvent, true);
    const reachable = async (user) => (await recipients(user, "event", world.startEvent)).items.map((item) => item.id);
    const refusedSend = (user) => send(user, "event", world.startEvent, [world.steward.id], "Hello organizer", randomUUID());
    const before = (await q("select count(*)::int as n from public.member_messages where conversation_id in (select id from public.member_conversations where user_id=$1)", [gus.id])).rows[0].n;
    expect(await reachable(gus)).toEqual([world.steward.id]);

    await optIn(gus, world.startEvent, false);
    expect(await reachable(gus)).toEqual([]);
    await expectRefusal(refusedSend(gus), { code: "22023", detail: "cw:recipient_unavailable:recipient_unavailable" });
    await optIn(gus, world.startEvent, true);
    await rsvp(world.startEvent, gus, "not_going");
    expect(await reachable(gus)).toEqual([]);
    await expectRefusal(refusedSend(gus), { code: "22023" });
    await rsvp(world.startEvent, gus, "going");
    expect(await reachable(gus)).toEqual([world.steward.id]);

    await q("update public.member_events set cancelled_at = now() where id=$1", [world.startEvent]);
    expect(await reachable(gus)).toEqual([]);
    await expectRefusal(refusedSend(gus), { code: "22023", detail: "cw:event_cancelled:event_cancelled" });
    await q("update public.member_events set cancelled_at = null where id=$1", [world.startEvent]);

    await q("update public.member_profiles set chapter_id=$2 where id=$1", [gus.id, world.chapter2]);
    expect(await reachable(gus)).toEqual([]);
    // No active membership in the new chapter: the caller is no longer a member of any tenant here.
    await expectRefusal(refusedSend(gus), { code: "42501", detail: "cw:not_authorized" });
    await q("update public.member_profiles set chapter_id=$2 where id=$1", [gus.id, world.chapter]);
    expect(await reachable(gus)).toEqual([world.steward.id]);

    await q("delete from public.member_role_chapters where user_id=$1 and role='steward'", [world.steward.id]);
    expect(await reachable(gus)).toEqual([]);
    await expectRefusal(refusedSend(gus), { code: "22023" });
    expect((await context(gus, "event", world.startEvent)).organizer).toBeNull();
    await q("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'steward',$2)", [world.steward.id, world.chapter]);
    expect(await reachable(gus)).toEqual([world.steward.id]);

    // The organizer is on the roster of the attendee's OWN chapter only: an attendee of another chapter,
    // who can read a cross-agency event and consent to it, is not offered someone the writer would refuse.
    world.openEvent = "cw-rally-open";
    await newEvent(world.openEvent, { order: 4, across: true });
    await setOrganizer(world.coordinator, world.openEvent, world.steward.id);
    await rsvp(world.openEvent, world.erin);
    await optIn(world.erin, world.openEvent, true);
    const away = await context(world.erin, "event", world.openEvent);
    expect(away).toMatchObject({ available: true, contactOptIn: true, canMessage: false });
    expect(away.reasons.message).toBe("organizer_not_reachable");
    expect((await recipients(world.erin, "event", world.openEvent)).items).toEqual([]);
    await expectRefusal(send(world.erin, "event", world.openEvent, [world.steward.id], "Hello from elsewhere", randomUUID()), { code: "22023", detail: "cw:recipient_unavailable:recipient_unavailable" });
    const writerRefusal = await expectRefusal(call(world.erin, "public.start_member_steward_conversation($1::uuid,$2)", [world.steward.id, "direct"]), { code: "42501" });
    expect(writerRefusal.message).toContain("not authorized");
    expect((await q("select count(*)::int as n from public.member_messages where conversation_id in (select id from public.member_conversations where user_id=$1)", [gus.id])).rows[0].n).toBe(before);
  });

  it("keeps initiation messages inside the message body lifecycle: redaction, hold and account deletion", async () => {
    const needle = `lc${randomUUID().replaceAll("-", "")}`;
    const heldUser = await person("held-start", { name: "Held Starter" });
    const looseUser = await person("loose-start", { name: "Loose Starter" });
    const removeUser = await person("remove-start", { name: "Remove Starter" });
    for (const attendee of [heldUser, looseUser, removeUser]) {
      await rsvp(world.startEvent, attendee);
      await optIn(attendee, world.startEvent, true);
    }
    const sent = {};
    for (const attendee of [heldUser, looseUser, removeUser]) {
      const result = await send(attendee, "event", world.startEvent, [world.steward.id], `Question ${attendee.label} ${needle}`, randomUUID());
      expect(result.results[0].via).toBe("event_participant_start");
      sent[attendee.label] = result.results[0].messageId;
    }
    expect(await bodyHolders(needle)).toEqual(["public.member_messages"]);
    expect((await q("select count(*)::int as n from public.member_messages where body like $1", [`%${needle}%`])).rows[0].n).toBe(3);

    // The sender removes their own words through the message lifecycle: one tombstone, no second copy.
    const removed = await call(removeUser, "public.redact_member_message($1::uuid)", [sent["remove-start"]]);
    expect(removed).toMatchObject({ redacted: true });
    expect((await thread(world.steward, world.startEvent, removeUser.id)).items).toEqual([expect.objectContaining({ id: sent["remove-start"], body: "", redacted: true })]);
    expect((await thread(removeUser, world.startEvent)).items).toEqual([expect.objectContaining({ id: sent["remove-start"], body: "", redacted: true })]);
    expect((await q("select count(*)::int as n from public.member_messages where body like $1", [`%${needle}%`])).rows[0].n).toBe(2);
    expect(await bodyHolders(needle)).toEqual(["public.member_messages"]);

    // The ledger row of each send names its sender, and the ledger's append-only trigger also refuses the
    // ON DELETE SET NULL detach of a deleted actor (reproduced at baseline with a message.react row, so it is
    // not something this slice introduced or can change). This rolled-back transaction lifts that one guard so
    // the assertions below still exercise the message body lifecycle itself.
    await q("alter table public.organization_audit_ledger disable trigger organization_audit_ledger_append_only");
    // A preservation order beats deletion of the account; without one the words are destroyed with it.
    const heldConversation = (await q("select id from public.member_conversations where user_id=$1", [heldUser.id])).rows[0].id;
    await q("insert into public.member_message_legal_holds(conversation_id,organization_id,reason_code) values ($1,$2,'litigation')", [heldConversation, world.org]);
    await q("delete from auth.users where id=$1", [heldUser.id]);
    const held = (await q("select body, user_id, redacted_at from public.member_messages where id=$1", [sent["held-start"]])).rows[0];
    expect(held).toEqual({ body: `Question held-start ${needle}`, user_id: null, redacted_at: null });
    expect((await q("select participant_id, organizer_id from private.member_event_contact_links where message_id=$1", [sent["held-start"]])).rows)
      .toEqual([{ participant_id: null, organizer_id: world.steward.id }]);
    expect(await thread(world.steward, world.startEvent, heldUser.id)).toMatchObject({ available: false, items: [] });
    await q("delete from auth.users where id=$1", [looseUser.id]);
    expect((await q("select count(*)::int as n from public.member_messages where id=$1", [sent["loose-start"]])).rows[0].n).toBe(0);
    expect((await q("select count(*)::int as n from private.member_event_contact_links where message_id=$1", [sent["loose-start"]])).rows[0].n).toBe(0);
    expect(await bodyHolders(needle)).toEqual(["public.member_messages"]);
    expect((await q("select count(*)::int as n from public.member_messages where body like $1", [`%${needle}%`])).rows[0].n).toBe(1);
    // Restore the guard so later cases in this shared transaction see the catalog as installed.
    await q("alter table public.organization_audit_ledger enable trigger organization_audit_ledger_append_only");
  });

  it("offers a task message its existing source task to current-chapter staff, never a second task", async () => {
    const tasksBefore = (await q("select count(*)::int as n from public.chapter_tasks where chapter_id=$1", [world.chapter])).rows[0].n;
    const linksBefore = (await q("select count(*)::int as n from public.chapter_task_attachments where chapter_id=$1", [world.chapter])).rows[0].n;
    const staff = await context(world.steward, "task_message", world.taskMessage);
    expect(staff).toMatchObject({ available: true, canCreateTask: true, canRemind: true, canMessage: false });
    expect(staff.linkedTask).toMatchObject({ id: world.linkedTask, href: `/m/tasks?task=${world.linkedTask}`, taskKey: expect.stringMatching(/^cw-/) });
    expect(staff.href).toBe(`/m/messages?taskThread=${world.linkedTask}&message=${world.taskMessage}`);
    const opened = await createTask(world.steward, "task_message", world.taskMessage);
    expect(opened).toMatchObject({ created: false, attachment: null, href: `/m/tasks?task=${world.linkedTask}` });
    expect(opened.task.id).toBe(world.linkedTask);
    expect((await q("select count(*)::int as n from public.chapter_tasks where chapter_id=$1", [world.chapter])).rows[0].n).toBe(tasksBefore);
    expect((await q("select count(*)::int as n from public.chapter_task_attachments where chapter_id=$1", [world.chapter])).rows[0].n).toBe(linksBefore);

    // A member who took part in the thread gets no personal task capability.
    const member = await context(world.alice, "task_message", world.taskMessage);
    expect(member).toMatchObject({ available: true, canCreateTask: false, linkedTask: null, canRemind: true });
    expect(member.reasons.task).toBe("staff_grant_required");
    await expectRefusal(createTask(world.alice, "task_message", world.taskMessage), { code: "42501", detail: "cw:not_authorized:staff_grant_required" });
    // Staff of another chapter cannot see the message, and a soft-deleted task takes the message with it.
    expect((await context(world.erin, "task_message", world.taskMessage)).available).toBe(false);
    await q("update public.chapter_tasks set deleted_at = now(), deleted_by = $2 where id=$1", [world.linkedTask, world.steward.id]);
    expect((await context(world.steward, "task_message", world.taskMessage)).available).toBe(false);
    await expectRefusal(createTask(world.steward, "task_message", world.taskMessage), { code: "22023", detail: "cw:source_unavailable" });
    await q("update public.chapter_tasks set deleted_at = null, deleted_by = null where id=$1", [world.linkedTask]);
    // A chapter switch after the reference was taken leaves nothing to open.
    await q("update public.member_profiles set chapter_id=$2 where id=$1", [world.steward.id, world.chapter2]);
    expect((await context(world.steward, "task_message", world.taskMessage)).available).toBe(false);
    await q("update public.member_profiles set chapter_id=$2 where id=$1", [world.steward.id, world.chapter]);
  });

  it("exports the new rows and keeps the lifecycle inventories clean", async () => {
    await setOrganizer(world.coordinator, world.event, world.steward.id);
    await optIn(world.alice, world.event, true);
    const exported = (await q("select private.account_lifecycle_export_additional_domains($1) as value", [world.alice.id])).rows[0].value;
    expect(exported.member_event_contact_opt_ins).toEqual([expect.objectContaining({ event_id: world.event, user_id: world.alice.id })]);
    expect(exported.member_event_contact_links.length).toBeGreaterThanOrEqual(1);
    expect(exported.member_event_contact_links[0]).toEqual({
      message_id: expect.any(String), event_id: world.event, organizer_id: world.steward.id,
      participant_id: world.alice.id, sender_role: expect.any(String), created_at: expect.any(String),
    });
    expect(JSON.stringify(exported.member_event_contact_links)).not.toContain(world.needle);
    const reminder = await saveReminder(world.alice, "event", world.event, FUTURE(9), "bring badge");
    const reminders = (await q("select private.account_lifecycle_export_member_message_reminders($1) as value", [world.alice.id])).rows[0].value;
    expect(reminders.find((row) => row.id === reminder.reminder.id)).toMatchObject({ source_kind: "event", source_ref: world.event, snooze_count: 0, note: "bring badge" });
    for (const fn of ["account_lifecycle_referential_action_trigger_issues", "account_lifecycle_unmanaged_restrictive_fks", "account_lifecycle_unmanaged_export_fks"]) {
      expect((await q(`select count(*)::int as n from private.${fn}()`)).rows[0].n, fn).toBe(0);
    }
    const manifest = (await q(
      `select table_name, user_column, delete_disposition, export_disposition from private.account_lifecycle_manifest
       where (schema_name, table_name) in (('private','member_event_contact_links'),('private','member_event_contact_opt_ins'),('public','member_events'))
         and user_column in ('organizer_id','participant_id','user_id') order by table_name, user_column`)).rows;
    expect(manifest).toEqual([
      { table_name: "member_event_contact_links", user_column: "organizer_id", delete_disposition: "pseudonymize", export_disposition: "excluded_with_reason" },
      { table_name: "member_event_contact_links", user_column: "participant_id", delete_disposition: "pseudonymize", export_disposition: "included" },
      { table_name: "member_event_contact_opt_ins", user_column: "user_id", delete_disposition: "cascade", export_disposition: "included" },
      { table_name: "member_events", user_column: "organizer_id", delete_disposition: "pseudonymize", export_disposition: "excluded_with_reason" },
    ]);
    // No body-bearing column exists outside the canonical message table for this feature.
    const bodyColumns = (await q(
      `select table_name, column_name from information_schema.columns
       where table_schema='private' and table_name like 'member_event_%' and column_name in ('body','preview','message','text')`)).rows;
    expect(bodyColumns).toEqual([]);
    // Clients hold no privilege on the private tables or the organizer column.
    for (const table of ["private.member_event_contact_links", "private.member_event_contact_opt_ins"]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect((await q("select has_table_privilege($1,$2,'select,insert,update,delete') as ok", [role, table])).rows[0].ok).toBe(false);
      }
    }
    expect((await q("select has_column_privilege('authenticated','public.member_events','organizer_id','select') as ok")).rows[0].ok).toBe(false);
  }, runnerTimeout(180_000));
});

// The concurrency proof needs two sessions, so it commits a uniquely named synthetic
// tenant (same convention as the required real-scanner proof: the disposable stack is
// destroyed after the lane, which is the reset).
live("connected workflow sends converge under concurrency", () => {
  let one; let two; let three;
  const ids = {};

  async function connect() {
    const conn = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      application_name: "connected-workflow-concurrency-proof",
    });
    await conn.connect();
    await conn.query("set statement_timeout = '30s'");
    return conn;
  }
  async function as(conn, user) {
    await conn.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      sub: user.id, role: "authenticated", aal: "aal2", session_id: user.session })]);
    await conn.query("set local role authenticated");
  }

  beforeAll(async () => {
    one = await connect(); two = await connect(); three = await connect();
    const tag = randomUUID();
    ids.org = randomUUID();
    ids.chapter = `cc-${tag.slice(0, 8)}`;
    await three.query("begin");
    await three.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [ids.org, ids.chapter]);
    await three.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,97611)", [ids.chapter, ids.org]);
    await three.query("insert into public.chapter_workstreams(chapter_id,name) values ($1,'General')", [ids.chapter]);
    for (const label of ["boss", "worker"]) {
      const id = randomUUID(); const session = randomUUID();
      await three.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}-${label}@example.invalid`]);
      await three.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, id]);
      await three.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id, ids.chapter, label]);
      await three.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, ids.chapter]);
      await three.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [ids.org, id]);
      await three.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
      ids[label] = { id, session };
    }
    await three.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'coordinator',$2)", [ids.boss.id, ids.chapter]);
    await three.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'coordinator',$2)", [ids.boss.id, ids.chapter]);
    await three.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: ids.boss.id, role: "authenticated", aal: "aal2", session_id: ids.boss.session })]);
    await three.query("set local role authenticated");
    const message = randomUUID();
    await three.query("reset role");
    const conversation = randomUUID();
    await three.query("insert into public.member_conversations(id,user_id,title) values ($1,$2,'Chapter steward')", [conversation, ids.worker.id]);
    await three.query("insert into public.member_messages(id,conversation_id,user_id,sender_kind,sender_name,body) values ($1,$2,$3,'member','Member','hello')", [message, conversation, ids.worker.id]);
    await three.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'steward',$2)", [ids.boss.id, ids.chapter]);
    await three.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'steward',$2)", [ids.boss.id, ids.chapter]);
    // A second steward (a candidate to replace the organizer), an event, and the worker attending it.
    const otherId = randomUUID(); const otherSession = randomUUID();
    await three.query("insert into auth.users(id,email) values ($1,$2)", [otherId, `${otherId}-other@example.invalid`]);
    await three.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [otherSession, otherId]);
    await three.query("update public.member_profiles set chapter_id=$2, full_name='other' where id=$1", [otherId, ids.chapter]);
    await three.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [otherId, ids.chapter]);
    await three.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [ids.org, otherId]);
    await three.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), otherId]);
    await three.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'steward',$2)", [otherId, ids.chapter]);
    await three.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'steward',$2)", [otherId, ids.chapter]);
    // Both committed stewards select the real unit.
    await scopeFixtureSteward(three,ids.boss.id,ids.chapter);
    await scopeFixtureSteward(three,otherId,ids.chapter);
    ids.other = { id: otherId, session: otherSession };
    ids.event = `cc-rally-${tag.slice(0, 8)}`;
    await three.query(
      `insert into public.member_events(id,title,starts_at,location,summary,check_in_code,order_index,chapter_id,is_public,is_public_across_agencies)
       values ($1,'Concurrent rally',now() + interval '7 days','Hall','Bring badge','SG-CC1',1,$2,false,false)`, [ids.event, ids.chapter]);
    await three.query("insert into public.member_event_rsvps(event_id,user_id,status) values ($1,$2,'going')", [ids.event, ids.worker.id]);
    await three.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: ids.boss.id, role: "authenticated", aal: "aal2", session_id: ids.boss.session })]);
    await three.query("set local role authenticated");
    const made = (await three.query("select public.create_connected_workflow_task('private_message',$1,null,null::uuid) as value", [message])).rows[0].value;
    await three.query("select public.set_chapter_task_assignees($1::uuid,$2::uuid[])", [made.task.id, [ids.worker.id]]);
    await three.query("select public.set_member_event_organizer($1,$2::uuid)", [ids.event, ids.boss.id]); // organizer A
    await three.query("reset role");
    await three.query("commit");
    ids.task = made.task.id;
  });

  afterAll(async () => {
    for (const conn of [one, two, three]) await conn?.end().catch(() => {});
  });

  it("serializes identical concurrent requests: one message, one notification path, one replay", async () => {
    ids.notesBefore = (await three.query("select count(*)::int as n from public.member_notifications where user_id=$1", [ids.worker.id])).rows[0].n;
    const request = randomUUID();
    const body = `Concurrent hello ${request}`;
    const args = ["task", ids.task, [ids.worker.id], body, request];
    const sql = "select public.send_connected_workflow_message($1,$2,$3::uuid[],$4,$5::uuid,null,null::uuid) as value";
    await one.query("begin"); await as(one, ids.boss);
    await two.query("begin"); await as(two, ids.boss);
    const first = await one.query(sql, args);
    // The second session blocks on the per-request lock until the first commits, then replays.
    const blocked = two.query(sql, args);
    const settled = await Promise.race([blocked.then(() => "done", () => "failed"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 700))]);
    expect(settled).toBe("waiting");
    await one.query("commit");
    const second = await blocked;
    await two.query("commit");
    expect(first.rows[0].value).toMatchObject({ sent: 1, replayed: false });
    expect(second.rows[0].value).toMatchObject({ sent: 0, replayed: true });
    expect(second.rows[0].value.results[0].messageId).toBe(first.rows[0].value.results[0].messageId);
    const verify = await three.query("select (select count(*) from public.chapter_task_messages where task_id=$1 and body=$2)::int as messages, (select count(*) from public.organization_audit_ledger where entity_id=$3)::int as ledger, (select count(*) from public.member_notifications where user_id=$4)::int as notes",
      [ids.task, body, first.rows[0].value.results[0].messageId, ids.worker.id]);
    expect(verify.rows[0]).toMatchObject({ messages: 1, ledger: 1 });
    // The one real send produced the writer's one notice; the replay produced none.
    expect(verify.rows[0].notes - ids.notesBefore).toBe(1);
  });

  it("creates one linked task when two authorized staff race on the same event", async () => {
    const sql = "select public.create_connected_workflow_task('event',$1,null,null::uuid) as value";
    await one.query("begin"); await as(one, ids.boss);
    await two.query("begin"); await as(two, ids.other);
    const first = await one.query(sql, [ids.event]);
    const waiting = two.query(sql, [ids.event]);
    const settled = await Promise.race([waiting.then(() => "done", () => "failed"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 500))]);
    expect(settled).toBe("waiting");
    await one.query("commit");
    const second = await waiting;
    await two.query("commit");
    expect(first.rows[0].value.created).toBe(true);
    expect(second.rows[0].value.created).toBe(false);
    expect(second.rows[0].value.task.id).toBe(first.rows[0].value.task.id);
    const linked = await three.query("select count(*)::int as n from public.chapter_task_attachments where chapter_id=$1 and source_kind='event' and source_id=$2", [ids.chapter, ids.event]);
    expect(linked.rows[0].n).toBe(1);
    expect(first.rows[0].value.task.title).toBe("Follow up on event");
    expect(first.rows[0].value.task.description).toBe("");
  });

  it("refuses a stale consent that raced an organizer change, and leaves no consent for the new organizer", async () => {
    const consent = () => three.query("select organizer_id from private.member_event_contact_opt_ins where event_id=$1 and user_id=$2", [ids.event, ids.worker.id]).then((r) => r.rows);
    // Session one changes the organizer from boss (A) to other (B) and has not committed.
    await one.query("begin"); await as(one, ids.boss);
    await one.query("select public.set_member_event_organizer($1,$2::uuid)", [ids.event, ids.other.id]);
    // Session two: the attendee confirms the organizer they were shown (A).
    await two.query("begin"); await as(two, ids.worker);
    const stale = two.query("select public.set_member_event_contact_opt_in($1,true,$2::uuid) as value", [ids.event, ids.boss.id]);
    const settled = await Promise.race([stale.then(() => "done", () => "failed"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 700))]);
    expect(settled).toBe("waiting");
    await one.query("commit");
    await expect(stale).rejects.toMatchObject({ code: "22023", detail: "cw:organizer_changed:organizer_changed" });
    await two.query("rollback");
    expect(await consent()).toEqual([]);
    // The attendee can then knowingly consent to B; the opposite race (consent first, change second) removes it.
    await two.query("begin"); await as(two, ids.worker);
    const granted = await two.query("select public.set_member_event_contact_opt_in($1,true,$2::uuid) as value", [ids.event, ids.other.id]);
    await two.query("commit");
    expect(granted.rows[0].value).toMatchObject({ contactOptIn: true, changed: true, organizerId: ids.other.id });
    expect(await consent()).toEqual([{ organizer_id: ids.other.id }]);
    await one.query("begin"); await as(one, ids.boss);
    await one.query("select public.set_member_event_organizer($1,$2::uuid)", [ids.event, ids.boss.id]);
    await one.query("commit");
    expect(await consent()).toEqual([]);
  });
});
