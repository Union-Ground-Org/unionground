import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";

const { Client } = pg;
const databaseUrl = assertDisposableProofUrl(requireDatabaseUrl("SUPABASE_DB_URL", { aliases: ["DATABASE_URL"] }));

const ids = {
  member: "50900000-0000-4000-8000-000000000091",
  outsider: "50900000-0000-4000-8000-000000000092",
  steward: "50900000-0000-4000-8000-000000000093",
  conversation: "50900000-0000-4000-8000-000000000094",
  message: "50900000-0000-4000-8000-000000000095",
  document: "50900000-0000-4000-8000-000000000096",
  staffDocument: "50900000-0000-4000-8000-000000000097",
  channelPost: "50900000-0000-4000-8000-000000000098",
  taskMessage: "50900000-0000-4000-8000-000000000099",
  organization: "50900000-0000-4000-8000-00000000009a",
};
// The legacy seed chapters (wor, bos) were retired by
// 20261018060300_retire_legacy_agency_chapters, and chapters now need an
// owning organization. The proof creates its own inside the rolled-back
// transaction: the member and steward share `chapter`, the outsider is in
// `otherChapter`.
const chapter = "messaging-proof";
const otherChapter = "messaging-proof-other";
const eventId = "messaging-local-proof";
const hiddenNote = "LOCAL-HIDDEN-CONTACT-NOTE-509";
const emailBody = "LOCAL-EXTERNAL-EMAIL-BODY-509";
const emailAddress = "messaging-proof@example.invalid";
const digest = "5".repeat(64);

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function asRole(client, role, userId = null) {
  await client.query("reset role");
  // Each fixture user's session id is its user id; see the auth.sessions seed.
  const claims = userId ? { sub: userId, role, aal: "aal2", session_id: userId } : { role };
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
  await client.query(`set local role ${role}`);
}

// Organization chapters read staff hats from member_role_chapters; member_roles
// keeps the legacy role list. Grant and revoke both together.
async function grantChapterRole(client, userId, role, chapterId) {
  await client.query("insert into public.member_roles(user_id, role, chapter_id) values ($1, $2, $3)", [userId, role, chapterId]);
  await client.query("insert into public.member_role_chapters(user_id, role, chapter_id) values ($1, $2, $3)", [userId, role, chapterId]);
}

async function revokeChapterRole(client, userId, role) {
  await client.query("delete from public.member_roles where user_id = $1 and role = $2", [userId, role]);
  await client.query("delete from public.member_role_chapters where user_id = $1 and role = $2", [userId, role]);
}

async function expectState(client, label, sql, values, state) {
  const savepoint = `sp_${label.replace(/[^a-z0-9]/gi, "_")}`;
  await client.query(`savepoint ${savepoint}`);
  try {
    await client.query(sql, values);
    throw new Error(`${label}: expected SQLSTATE ${state}`);
  } catch (error) {
    assert(error.code === state, `${label}: expected SQLSTATE ${state}, got ${error.code || error.message}`);
  } finally {
    await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
  }
}

const client = new Client({ connectionString: databaseUrl, application_name: "unified-messaging-rollback-proof" });
try {
  await client.connect();
  await client.query("begin");
  await client.query(
    "insert into public.organizations(id, slug, name) values ($1, 'messaging-proof', 'Messaging local proof')",
    [ids.organization],
  );
  await client.query(`
    insert into public.chapters(id, name, region, order_index, organization_id, slug) values
      ($1, 'Messaging local proof', 'Proof', 9990, $3, $1),
      ($2, 'Messaging local proof (other)', 'Proof', 9991, $3, $2)
  `, [chapter, otherChapter, ids.organization]);
  await client.query(`
    insert into auth.users(id, email) values
      ($1, 'messaging-member@example.invalid'),
      ($2, 'messaging-outsider@example.invalid'),
      ($3, 'messaging-steward@example.invalid')
  `, [ids.member, ids.outsider, ids.steward]);
  await client.query(`
    insert into public.organization_memberships(organization_id, user_id, status) values
      ($1, $2, 'active'), ($1, $3, 'active'), ($1, $4, 'active')
  `, [ids.organization, ids.member, ids.outsider, ids.steward]);
  // The member holds both chapters so moving its profile changes only the
  // selected chapter, not its organization membership.
  await client.query(`
    insert into public.member_chapter_memberships(user_id, chapter_id, status) values
      ($1, $4, 'active'), ($1, $5, 'active'), ($2, $5, 'active'), ($3, $4, 'active')
  `, [ids.member, ids.outsider, ids.steward, chapter, otherChapter]);
  await client.query("update public.member_profiles set chapter_id = $1 where id in ($2, $3)", [chapter, ids.member, ids.steward]);
  await client.query("update public.member_profiles set chapter_id = $1 where id = $2", [otherChapter, ids.outsider]);
  await grantChapterRole(client, ids.steward, "steward", chapter);
  await grantChapterRole(client, ids.steward, "admin", chapter);
  await client.query(`
    insert into public.org_security_policy(id, organization_id, require_staff_mfa) values (true, $1, true)
  `, [ids.organization]);
  await client.query(
    "insert into public.chapter_workstreams(chapter_id, name, created_by) values ($1, 'General', $2)",
    [chapter, ids.steward],
  );
  // Staff MFA is enabled by default in the final integrated schema. A JWT
  // claiming aal2 is not an enrolled factor, and the MFA boundary needs a live
  // session: seed both, so the staff fixtures are actually authorized
  // publishers/reviewers and the outsider's denials are not MFA denials.
  await client.query(`
    insert into auth.mfa_factors
      (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    values
      (extensions.gen_random_uuid(), $1, 'messaging-proof', 'totp', 'verified', now(), now()),
      (extensions.gen_random_uuid(), $2, 'messaging-proof', 'totp', 'verified', now(), now())
  `, [ids.steward, ids.outsider]);
  await client.query(`
    insert into auth.sessions(id, user_id, aal, created_at)
    values ($1, $1, 'aal2', now()), ($2, $2, 'aal2', now()), ($3, $3, 'aal2', now())
  `, [ids.member, ids.outsider, ids.steward]);
  await client.query(`
    insert into auth.mfa_amr_claims(id, session_id, authentication_method, created_at, updated_at)
    values ($1, $1, 'totp', now(), now()), ($2, $2, 'totp', now(), now()), ($3, $3, 'totp', now(), now())
  `, [ids.member, ids.outsider, ids.steward]);
  await client.query(`
    insert into public.member_conversations(id, user_id, title, initials)
    values ($1, $2, 'Messaging rollback proof', 'MP')
  `, [ids.conversation, ids.member]);
  await client.query(`
    insert into public.member_messages(id, conversation_id, user_id, sender_kind, sender_name, body)
    values ($1, $2, $3, 'member', 'Messaging member', 'PRIVATE-SOURCE-BODY-509')
  `, [ids.message, ids.conversation, ids.member]);
  await asRole(client, "authenticated", ids.steward);
  ids.document = (await client.query(`
    insert into public.chapter_documents(title, document_type, summary, body, visibility, status, published_at)
    values ('Local verified resource', 'policy', 'Local proof', 'RESOURCE-BODY-509', 'chapter', 'published', now())
    returning id
  `)).rows[0].id;
  ids.staffDocument = (await client.query(`
    insert into public.chapter_documents(title, document_type, summary, body, visibility, status, published_at)
    values ('Staff-only local resource', 'policy', 'Staff-only proof', 'STAFF-RESOURCE-BODY-509', 'staff', 'published', now())
    returning id
  `)).rows[0].id;
  const spaceId = (await client.query(`
    insert into public.chapter_spaces(name, description, visibility)
    values ('Messaging local proof', 'Rollback-only channel', 'chapter') returning id
  `)).rows[0].id;
  const threadId = (await client.query(`
    insert into public.chapter_threads(space_id, title, kind)
    values ($1, 'Messaging local proof', 'topic') returning id
  `, [spaceId])).rows[0].id;
  ids.channelPost = (await client.query(`
    insert into public.chapter_thread_posts(thread_id, body)
    values ($1, 'CHANNEL-SOURCE-BODY-509') returning id
  `, [threadId])).rows[0].id;
  // Tasks are created through create_chapter_task, the only client insert
  // path since 20261103183000.
  const taskId = (await client.query(`
    select id from public.create_chapter_task(pg_catalog.jsonb_build_object(
      'title', 'Messaging local task', 'description', '', 'status', 'backlog', 'priority', 'medium',
      'workstream', (select name from public.chapter_workstreams where chapter_id = $2 order by name limit 1),
      'assignee_id', $1::uuid))
  `, [ids.member, chapter])).rows[0].id;
  ids.taskMessage = (await client.query(
    "select (public.send_chapter_task_message($1, 'TASK-SOURCE-BODY-509')->>'id')::uuid as id", [taskId],
  )).rows[0].id;

  await asRole(client, "authenticated", ids.member);
  const reaction = (await client.query(
    "select public.toggle_member_message_reaction('private', $1, 'support') as value", [ids.message],
  )).rows[0].value;
  assert(reaction.reacted === true, "member must be able to react to a readable private message");
  const saved = (await client.query(
    "select public.toggle_member_saved_message('private', $1) as value", [ids.message],
  )).rows[0].value;
  assert(saved.saved === true, "member must be able to save a readable private message");
  await client.query("select public.toggle_member_message_reaction('channel', $1, 'like')", [ids.channelPost]);
  await client.query("select public.toggle_member_saved_message('channel', $1)", [ids.channelPost]);
  await client.query("select public.create_member_message_reminder('channel', $1, now() + interval '1 day', '')", [ids.channelPost]);
  await client.query("select public.toggle_member_message_reaction('task', $1, 'celebrate')", [ids.taskMessage]);
  await client.query("select public.toggle_member_saved_message('task', $1)", [ids.taskMessage]);
  const activity = (await client.query("select public.list_member_message_activity() as value")).rows[0].value;
  assert(activity.saved.some((item) => item.sourceKind === "channel" && item.available)
    && activity.saved.some((item) => item.sourceKind === "task" && item.available)
    && activity.reminders.some((item) => item.sourceKind === "channel" && item.available),
  "saved/reminder aggregation must resolve authorized channel and task sources");
  assert(activity.saved.some((item) => item.sourceKind === "private" && item.targetId === ids.conversation)
    && activity.saved.some((item) => item.sourceKind === "channel" && item.targetId === threadId)
    && activity.saved.some((item) => item.sourceKind === "task" && item.targetId === taskId),
  "server resolver must return authorized private, channel, and task navigation targets independent of browser windows");
  await client.query("reset role");
  await client.query("update public.member_profiles set chapter_id = $1 where id = $2", [otherChapter, ids.member]);
  await asRole(client, "authenticated", ids.member);
  const movedActivity = (await client.query("select public.list_member_message_activity() as value")).rows[0].value;
  const unavailableChannel = movedActivity.saved.find((item) => item.sourceKind === "channel");
  assert(unavailableChannel?.available === false && unavailableChannel.messageId === null && unavailableChannel.targetId === null
    && !JSON.stringify(unavailableChannel).includes("CHANNEL-SOURCE-BODY-509"),
  "lost channel access must become a content-free unavailable saved row");
  await client.query("reset role");
  await client.query("update public.member_profiles set chapter_id = $1 where id = $2", [chapter, ids.member]);
  await asRole(client, "authenticated", ids.member);
  await expectState(client, "direct_metadata_insert", `
    insert into public.member_saved_messages(owner_id, source_kind, private_message_id)
    values ($1, 'private', $2)
  `, [ids.member, ids.message], "42501");

  const reminder = (await client.query(
    "select public.create_member_message_reminder('private', $1, now() + interval '1 day', 'PRIVATE-REMINDER-NOTE-509') as value",
    [ids.message],
  )).rows[0].value;
  const scheduled = (await client.query(
    "select public.schedule_member_message($1, 'Scheduled member proof', now() + interval '1 day') as value",
    [ids.conversation],
  )).rows[0].value;
  const resource = (await client.query(
    "select public.send_member_resource($1, $2, null) as value", [ids.conversation, ids.document],
  )).rows[0].value;
  assert(resource.documentId === ids.document, "resource send must bind the authorized document");
  const memberResourceBody = (await client.query(
    "select body from public.member_messages where id = $1", [resource.messageId],
  )).rows[0]?.body;
  assert(memberResourceBody === "Shared resource" && !memberResourceBody.includes("Local verified resource"),
    "member resource messages must keep document titles behind the resource renderer's RLS check");

  await client.query("reset role");
  await grantChapterRole(client, ids.outsider, "steward", otherChapter);
  await asRole(client, "authenticated", ids.outsider);
  assert((await client.query(
    "select count(*)::int as n from public.member_message_resources where message_id = $1", [resource.messageId],
  )).rows[0].n === 0, "a cross-chapter staff viewer must not resolve a member resource drop");
  assert((await client.query(
    "select count(*)::int as n from public.member_messages where id = $1", [resource.messageId],
  )).rows[0].n === 0, "a cross-chapter staff viewer must not read the containing private message");
  await expectState(
    client,
    "cross_chapter_reaction",
    "select public.toggle_member_message_reaction('private', $1, 'like')",
    [ids.message],
    "22023",
  );

  await client.query("reset role");
  await client.query("update public.member_message_reminders set remind_at = now() - interval '1 minute' where id = $1", [reminder.id]);
  await client.query("update public.member_scheduled_messages set scheduled_for = now() - interval '1 minute' where id = $1", [scheduled.id]);
  const dispatch = (await client.query("select private.dispatch_due_member_messaging() as value")).rows[0].value;
  assert(dispatch.sent === 1 && dispatch.reminders === 1, "due member send and reminder must dispatch once");
  const notice = (await client.query("select body from public.member_notifications where message_reminder_id = $1", [reminder.id])).rows[0];
  assert(notice?.body === "Open Messages to review your reminder.", "reminder delivery must contain no private note or source body");

  await asRole(client, "authenticated", ids.steward);
  const revokedSchedule = (await client.query(
    "select public.schedule_member_message($1, 'Must fail after role revocation', now() + interval '1 day') as value",
    [ids.conversation],
  )).rows[0].value;
  await client.query("reset role");
  await revokeChapterRole(client, ids.steward, "steward");
  await client.query("update public.member_scheduled_messages set scheduled_for = now() - interval '1 minute' where id = $1", [revokedSchedule.id]);
  await client.query("select private.dispatch_due_member_messaging()");
  const failedSchedule = (await client.query("select status, failure_reason from public.member_scheduled_messages where id = $1", [revokedSchedule.id])).rows[0];
  assert(failedSchedule.status === "failed" && failedSchedule.failure_reason === "authorization-revoked",
    "scheduled staff send must fail closed after role revocation");

  await grantChapterRole(client, ids.steward, "steward", chapter);
  await asRole(client, "authenticated", ids.steward);
  await expectState(
    client,
    "staff_only_resource_to_member",
    "select public.send_steward_resource($1, $2, null)",
    [ids.conversation, ids.staffDocument],
    "22023",
  );
  assert((await client.query(
    "select count(*)::int as n from public.member_messages where conversation_id = $1 and body like 'Shared resource: Staff-only%'",
    [ids.conversation],
  )).rows[0].n === 0, "rejected staff-only resource must not leak its title into the member conversation");
  const stewardResource = (await client.query(
    "select public.send_steward_resource($1, $2, 'Steward resource handoff') as value",
    [ids.conversation, ids.document],
  )).rows[0].value;
  await client.query("select public.create_member_contact_note($1, $2, $3)", [ids.conversation, hiddenNote, ids.message]);
  const notes = (await client.query("select public.list_member_contact_notes($1) as value", [ids.conversation])).rows[0].value;
  assert(notes.length === 1 && notes[0].note === hiddenNote, "in-scope steward must read the hidden note through its RPC");
  const createdEvent = (await client.query(`
    select public.create_event_from_member_message(
      $1, $2, 'Explicit event title', now() + interval '2 days',
      'Local hall', 'EXPLICIT-EVENT-SUMMARY-509', 'SG-MSG509') as value
  `, [ids.message, eventId])).rows[0].value;
  assert(createdEvent.created === true, "admin steward must create an explicit-field event");
  const event = (await client.query("select summary from public.member_events where id = $1", [eventId])).rows[0];
  assert(event.summary === "EXPLICIT-EVENT-SUMMARY-509", "event must use explicit summary, not source message body");

  await asRole(client, "authenticated", ids.member);
  await expectState(client, "member_contact_note_read", "select * from public.member_contact_notes", [], "42501");
  await expectState(client, "member_contact_note_rpc", "select public.list_member_contact_notes($1)", [ids.conversation], "22023");
  const exported = (await client.query("select public.get_member_data_export() as value")).rows[0].value;
  assert(!JSON.stringify(exported).includes(hiddenNote), "member export must exclude staff-only contact notes");

  await asRole(client, "service_role");
  const ingested = (await client.query(`
    select public.ingest_steward_email($1, $4, $2, 'Local subject', $3, now()) as value
  `, [digest, emailAddress, emailBody, chapter])).rows[0].value;
  const duplicate = (await client.query(`
    select public.ingest_steward_email($1, $4, $2, 'Local subject', $3, now()) as value
  `, [digest, emailAddress, emailBody, chapter])).rows[0].value;
  assert(ingested.accepted === true && ingested.duplicate === false && duplicate.duplicate === true,
    "service ingestion must be accepted and replay-idempotent");

  await asRole(client, "authenticated", ids.member);
  await expectState(client, "browser_email_ingest", `
    select public.ingest_steward_email($1, $4, $2, 'Local subject', $3, now())
  `, ["6".repeat(64), emailAddress, emailBody, chapter], "42501");
  await expectState(client, "browser_email_table", "select * from public.steward_email_intakes", [], "42501");

  await asRole(client, "authenticated", ids.steward);
  const inbox = (await client.query("select public.list_steward_email_intakes() as value")).rows[0].value;
  assert(inbox.length === 1 && inbox[0].text === emailBody, "MFA chapter steward must review its chapter intake");
  await client.query("select public.review_steward_email_intake($1, 'claim')", [inbox[0].id]);
  await client.query("select public.review_steward_email_intake($1, 'accept')", [inbox[0].id]);
  await client.query("reset role");
  const auditText = JSON.stringify((await client.query(
    "select detail from public.member_admin_audit where action = 'review_email_intake'",
  )).rows);
  assert(!auditText.includes(emailBody) && !auditText.includes(emailAddress), "email review audit must contain no body or address");

  // HUB-02 cross-feature proof: authored support records must survive a staff
  // account deletion without blocking it or taking the member's conversation
  // with it. Attribution detaches to NULL, including reviewed email intake.
  await client.query("delete from auth.users where id = $1", [ids.steward]);
  assert((await client.query("select count(*)::int as n from auth.users where id = $1", [ids.steward])).rows[0].n === 0,
    "staff identity deletion must not be blocked by messaging attribution");
  assert((await client.query("select count(*)::int as n from public.member_conversations where id = $1", [ids.conversation])).rows[0].n === 1,
    "staff deletion must not remove another member's conversation");
  assert((await client.query("select author_id from public.member_contact_notes where note = $1", [hiddenNote])).rows[0]?.author_id === null,
    "contact note must survive with detached author attribution");
  assert((await client.query("select added_by from public.member_message_resources where message_id = $1", [stewardResource.messageId])).rows[0]?.added_by === null,
    "resource handoff must survive with detached staff attribution");
  assert((await client.query("select reviewed_by from public.steward_email_intakes where provider_message_digest = $1", [digest])).rows[0]?.reviewed_by === null,
    "reviewed intake must survive with detached reviewer attribution");
  const preservedTask = (await client.query("select created_by, updated_by from public.chapter_tasks where id = $1", [taskId])).rows[0];
  assert(preservedTask?.created_by === null && preservedTask?.updated_by === null,
    "task-source records must survive with detached creator and updater attribution");
  assert((await client.query("select count(*)::int as n from auth.users where id = $1", [ids.member])).rows[0].n === 1,
    "staff deletion must not remove the member account");

  await client.query("rollback");
  const residue = await client.query("select count(*)::int as n from auth.users where id = any($1::uuid[])", [[ids.member, ids.outsider, ids.steward]]);
  assert(residue.rows[0].n === 0, "rollback-only proof must remove all messaging identities");
  assert((await client.query("select count(*)::int as n from public.member_events where id = $1", [eventId])).rows[0].n === 0,
    "rollback-only proof must remove the event fixture");
  assert((await client.query("select count(*)::int as n from public.organizations where id = $1", [ids.organization])).rows[0].n === 0,
    "rollback-only proof must remove the organization and chapter fixtures");
  console.log("PASS: unified messaging authorization, dispatch recheck, hidden notes, explicit events, signed-intake review, safe staff deletion, and rollback residue proved locally.");
} catch (error) {
  await client.query("rollback").catch(() => {});
  throw error;
} finally {
  await client.end().catch(() => {});
}
