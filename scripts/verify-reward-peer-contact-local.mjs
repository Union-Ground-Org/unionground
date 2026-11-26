import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";

const { Client } = pg;
const databaseUrl = assertDisposableProofUrl(requireDatabaseUrl("SUPABASE_DB_URL", { aliases: ["DATABASE_URL"] }));

const users = {
  requester: "a1000000-0000-4000-8000-000000000001",
  recipient: "a1000000-0000-4000-8000-000000000002",
  outsider: "a1000000-0000-4000-8000-000000000003",
  noGrant: "a1000000-0000-4000-8000-000000000004",
  rateTarget: "a1000000-0000-4000-8000-000000000005",
  deleteRequester: "a1000000-0000-4000-8000-000000000006",
  deleteRecipient: "a1000000-0000-4000-8000-000000000007",
};
const checks = [];

function check(name, condition, detail = "") {
  checks.push({ name, pass: Boolean(condition), detail });
  if (!condition) throw new Error(`${name}: ${detail}`);
}

async function actor(userId, applicationName) {
  const client = new Client({ connectionString: databaseUrl, application_name: applicationName });
  await client.connect();
  await client.query("begin");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2" })]);
  await client.query("set local role authenticated");
  return client;
}

async function autocommitActor(userId, applicationName, aal = "aal2") {
  const client = new Client({ connectionString: databaseUrl, application_name: applicationName });
  await client.connect();
  await client.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: userId, role: "authenticated", aal })]);
  await client.query("set role authenticated");
  return client;
}

async function payload(client, query, values = []) {
  return (await client.query(query, values)).rows[0].payload;
}

async function waitForDatabaseLock(client, applicationName) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const row = (await client.query(`
      select wait_event_type, wait_event
      from pg_catalog.pg_stat_activity
      where application_name = $1 and state = 'active'
    `, [applicationName])).rows[0];
    if (row?.wait_event_type === "Lock") return row.wait_event;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${applicationName} never blocked on the expected database lock`);
}

async function adminTransaction(applicationName) {
  const client = new Client({ connectionString: databaseUrl, application_name: applicationName });
  await client.connect();
  await client.query("begin");
  return client;
}

const admin = new Client({ connectionString: databaseUrl, application_name: "reward-contact-proof-admin" });
const clients = [];

async function closeActors() {
  while (clients.length > 0) {
    const client = clients.pop();
    try { await client.query("rollback"); } catch { /* autocommit or already committed */ }
    await client.end();
  }
}

async function fixtureResidue() {
  return (await admin.query(`
    select
      (select count(*) from auth.users where id = any($1::uuid[]))::int as users,
      (select count(*) from public.member_profiles where id = any($1::uuid[]))::int as profiles,
      (select count(*) from public.member_peer_contact_keys where user_id = any($1::uuid[]))::int as contact_keys,
      (select count(*) from public.member_peer_contact_requests where requester_id = any($1::uuid[]) or recipient_id = any($1::uuid[]))::int as requests,
      (select count(*) from public.member_peer_conversations where user_low = any($1::uuid[]) or user_high = any($1::uuid[]))::int as conversations,
      (select count(*) from public.member_peer_messages where sender_id = any($1::uuid[]))::int as messages
  `, [Object.values(users)])).rows[0];
}
try {
  await admin.connect();
  await admin.query("delete from auth.users where id = any($1::uuid[])", [Object.values(users)]);
  for (const [index, id] of Object.values(users).entries()) {
    await admin.query("insert into auth.users (id, email) values ($1, $2)", [id, `reward-contact-proof-${index}@example.invalid`]);
  }
  await admin.query("update public.member_profiles set chapter_id = 'wor' where id = any($1::uuid[])", [[users.requester, users.recipient, users.noGrant, users.rateTarget, users.deleteRequester, users.deleteRecipient]]);
  await admin.query("update public.member_profiles set chapter_id = 'bos' where id = $1", [users.outsider]);
  await admin.query(`
    update public.member_profiles set full_name = case id
      when $1 then 'Request Member'
      when $2 then 'Receive Member'
      when $3 then 'Outside Member'
      when $4 then 'No Grant'
      else 'Rate Target'
    end,
    initials = case id when $1 then 'RM' when $2 then 'RC' when $3 then 'OM' when $4 then 'NG' else 'RT' end
    where id = any($5::uuid[])
  `, [users.requester, users.recipient, users.outsider, users.noGrant, Object.values(users)]);
  await admin.query(`
    insert into public.member_reward_grants (user_id, item_key, status, source, reason)
    values ($1, 'im-anyone', 'granted', 'admin_grant', 'local verification'),
           ($1, 'experimental-access', 'granted', 'admin_grant', 'local verification'),
           ($2, 'im-anyone', 'granted', 'admin_grant', 'account deletion verification')
  `, [users.requester, users.deleteRequester]);
  await admin.query(`
    insert into auth.mfa_factors
      (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    values (extensions.gen_random_uuid(), $1, 'reward-contact-proof', 'totp', 'verified', now(), now())
  `, [users.requester]);

  const recipient = await actor(users.recipient, "reward-contact-proof-recipient");
  const requester = await actor(users.requester, "reward-contact-proof-requester");
  const noGrant = await actor(users.noGrant, "reward-contact-proof-no-grant");
  clients.push(recipient, requester, noGrant);

  const own = await payload(recipient, "select public.list_reward_peer_contact() as payload");
  const code = own.code;
  // Never print the share code, even in local verification output.
  check("own code is 80-bit formatted", /^PSG-[0-9A-F]{20}$/.test(code));
  check("recipient has no request entitlement", own.canRequest === false);

  const lowAssurance = await autocommitActor(users.requester, "reward-contact-proof-aal1", "aal1");
  clients.push(lowAssurance);
  let peerMfaDenied = false;
  let labsMfaDenied = false;
  let exportMfaDenied = false;
  try { await payload(lowAssurance, "select public.list_reward_peer_contact() as payload"); }
  catch (error) { peerMfaDenied = error?.code === "42501" && error?.message === "authentication required"; }
  try { await payload(lowAssurance, "select public.list_reward_experimental_content('en') as payload"); }
  catch (error) { labsMfaDenied = error?.code === "42501" && error?.message === "authentication required"; }
  try { await payload(lowAssurance, "select public.get_member_data_export() as payload"); }
  catch (error) { exportMfaDenied = error?.code === "42501" && error?.message === "authentication required"; }
  check("peer contact requires MFA", peerMfaDenied);
  check("experimental content requires MFA", labsMfaDenied);
  check("peer contact export requires MFA", exportMfaDenied);

  const invalidBefore = (await admin.query("select count(*)::int as count from public.member_peer_contact_requests")).rows[0].count;
  const invalid = await payload(requester, "select public.request_reward_peer_contact($1) as payload", ["PSG-00000000000000000000"]);
  const invalidAfter = (await admin.query("select count(*)::int as count from public.member_peer_contact_requests")).rows[0].count;
  check("unknown code is uniform", invalid.reason === "contact request unavailable");
  check("unknown code has no mutation", invalidBefore === invalidAfter);

  const ungranted = await payload(noGrant, "select public.request_reward_peer_contact($1) as payload", [code]);
  check("missing grant is uniform", ungranted.reason === "contact request unavailable");
  const outsiderCode = (await admin.query("select private.member_peer_contact_code($1) as code", [users.outsider])).rows[0].code;
  const crossChapter = await payload(requester, "select public.request_reward_peer_contact($1) as payload", [outsiderCode]);
  check("cross chapter is uniform", crossChapter.reason === "contact request unavailable");

  // Commit and reconnect so real independent transactions can exercise locks.
  await requester.query("commit");
  await requester.end();
  clients.splice(clients.indexOf(requester), 1);

  // A profile move that wins the row lock makes the request wait, then deny
  // from the post-move chapters. No edge or recipient name may appear.
  const requestMover = await adminTransaction("reward-contact-proof-request-mover");
  clients.push(requestMover);
  await requestMover.query("update public.member_profiles set chapter_id = 'bos' where id = $1", [users.recipient]);
  const movedRequester = await autocommitActor(users.requester, "reward-contact-proof-request-behind-move");
  clients.push(movedRequester);
  const requestCountBeforeMove = (await admin.query("select count(*)::int as count from public.member_peer_contact_requests")).rows[0].count;
  const requestBehindMovePromise = payload(movedRequester, "select public.request_reward_peer_contact($1) as payload", [code]);
  const requestWaitEvent = await waitForDatabaseLock(admin, "reward-contact-proof-request-behind-move");
  await requestMover.query("commit");
  const requestBehindMove = await requestBehindMovePromise;
  const requestCountAfterMove = (await admin.query("select count(*)::int as count from public.member_peer_contact_requests")).rows[0].count;
  const recipientAfterMove = await payload(recipient, "select public.list_reward_peer_contact() as payload");
  check("move-vs-request blocks on the profile row", Boolean(requestWaitEvent));
  check("move-vs-request is uniform and no-write", requestBehindMove.reason === "contact request unavailable" && requestCountAfterMove === requestCountBeforeMove);
  check("move-vs-request leaks no recipient name", !JSON.stringify(recipientAfterMove).includes("Request Member"));
  await admin.query("update public.member_profiles set chapter_id = 'wor' where id = $1", [users.recipient]);
  await requestMover.end();
  await movedRequester.end();
  clients.splice(clients.indexOf(requestMover), 1);
  clients.splice(clients.indexOf(movedRequester), 1);

  // Same-caller/pair advisory locks also make two simultaneous exact requests
  // converge on one row.
  const racerOne = await autocommitActor(users.requester, "reward-contact-proof-racer-1");
  const racerTwo = await autocommitActor(users.requester, "reward-contact-proof-racer-2");
  clients.push(racerOne, racerTwo);
  const [first, second] = await Promise.all([
    payload(racerOne, "select public.request_reward_peer_contact($1) as payload", [code]),
    payload(racerTwo, "select public.request_reward_peer_contact($1) as payload", [code]),
  ]);
  check("two-connection request creates exactly one", [first.requested, second.requested].filter(Boolean).length === 1);
  const created = first.requested ? first : second;
  const pairCount = (await admin.query("select count(*)::int as count from public.member_peer_contact_requests where requester_id = $1 and recipient_id = $2", [users.requester, users.recipient])).rows[0].count;
  check("pair row count remains one", pairCount === 1);

  const requesterAfterRace = await autocommitActor(users.requester, "reward-contact-proof-requester-after-race");
  clients.push(requesterAfterRace);
  const requesterBefore = await payload(requesterAfterRace, "select public.list_reward_peer_contact() as payload");
  check("pending output hides recipient identity", !JSON.stringify(requesterBefore.outgoing).match(/receive|recipient|email/i));

  // Complete the daily allowance against three distinct exact codes, then
  // prove a fourth successful-looking target cannot create another edge.
  const noGrantCode = (await admin.query("select private.member_peer_contact_code($1) as code", [users.noGrant])).rows[0].code;
  const rateTargetCode = (await admin.query("select private.member_peer_contact_code($1) as code", [users.rateTarget])).rows[0].code;
  const secondRequest = await payload(requesterAfterRace, "select public.request_reward_peer_contact($1) as payload", [noGrantCode]);
  await admin.query("update public.member_profiles set chapter_id = 'wor' where id = $1", [users.outsider]);
  const thirdRequest = await payload(requesterAfterRace, "select public.request_reward_peer_contact($1) as payload", [outsiderCode]);
  const rateLimited = await payload(requesterAfterRace, "select public.request_reward_peer_contact($1) as payload", [rateTargetCode]);
  const requesterAfterLimit = await payload(requesterAfterRace, "select public.list_reward_peer_contact() as payload");
  const requesterDayCount = requesterAfterLimit.outgoing.filter((request) => [created.id, secondRequest.id, thirdRequest.id].includes(request.id)).length;
  check("daily request allowance accepts three", secondRequest.requested && thirdRequest.requested && requesterDayCount === 3);
  check("fourth daily request is uniform and no-write", rateLimited.reason === "contact request unavailable" && requesterDayCount === 3);

  await recipient.query("commit");
  await recipient.end();
  clients.splice(clients.indexOf(recipient), 1);

  // A requester move that wins the profile row makes acceptance wait, then
  // deny. The pending row stays unchanged internally but its requester label
  // disappears from the recipient projection once the chapters diverge.
  const acceptanceMover = await adminTransaction("reward-contact-proof-accept-mover");
  clients.push(acceptanceMover);
  await acceptanceMover.query("update public.member_profiles set chapter_id = 'bos' where id = $1", [users.requester]);
  const acceptanceActor = await autocommitActor(users.recipient, "reward-contact-proof-accept-behind-move");
  clients.push(acceptanceActor);
  const acceptanceBehindMovePromise = payload(acceptanceActor, "select public.respond_reward_peer_contact($1, true) as payload", [created.id]);
  const acceptanceWaitEvent = await waitForDatabaseLock(admin, "reward-contact-proof-accept-behind-move");
  await acceptanceMover.query("commit");
  const movedAcceptance = await acceptanceBehindMovePromise;
  const movedState = await payload(acceptanceActor, "select public.list_reward_peer_contact() as payload");
  const movedInternal = (await admin.query("select status, responded_at from public.member_peer_contact_requests where id = $1", [created.id])).rows[0];
  const movedConversationCount = (await admin.query("select count(*)::int as count from public.member_peer_conversations where created_from_request = $1", [created.id])).rows[0].count;
  check("move-vs-accept blocks on the profile row", Boolean(acceptanceWaitEvent));
  check("move-vs-accept is uniform and no-write", movedAcceptance.reason === "contact request unavailable" && movedInternal.status === "pending" && movedInternal.responded_at === null && movedConversationCount === 0);
  check("move-vs-accept leaks no requester name", !movedState.incoming.some((request) => request.id === created.id) && !JSON.stringify(movedState).includes("Request Member"));
  await admin.query("update public.member_profiles set chapter_id = 'wor' where id = $1", [users.requester]);
  await acceptanceMover.end();
  await acceptanceActor.end();
  clients.splice(clients.indexOf(acceptanceMover), 1);
  clients.splice(clients.indexOf(acceptanceActor), 1);

  const recipientTransaction = await actor(users.recipient, "reward-contact-proof-recipient-transaction");
  clients.push(recipientTransaction);
  await recipientTransaction.query("savepoint acceptance_rollback_proof");
  const rolledBackAcceptance = await payload(recipientTransaction, "select public.respond_reward_peer_contact($1, true) as payload", [created.id]);
  check("acceptance transaction initially creates a conversation", rolledBackAcceptance.accepted && rolledBackAcceptance.conversation?.id);
  await recipientTransaction.query("rollback to savepoint acceptance_rollback_proof");
  const rollbackState = await payload(recipientTransaction, "select public.list_reward_peer_contact() as payload");
  check("acceptance rollback restores pending request", rollbackState.incoming.some((request) => request.id === created.id)
    && !rollbackState.conversations.some((conversation) => conversation.id === rolledBackAcceptance.conversation.id));
  const accepted = await payload(recipientTransaction, "select public.respond_reward_peer_contact($1, true) as payload", [created.id]);
  await recipientTransaction.query("commit");
  await recipientTransaction.end();
  clients.splice(clients.indexOf(recipientTransaction), 1);
  check("recipient acceptance creates conversation", accepted.accepted && accepted.conversation?.id);

  await admin.query("update public.member_reward_grants set status = 'revoked' where user_id = $1 and item_key = 'im-anyone'", [users.requester]);
  const revokedRequest = await payload(requesterAfterRace, "select public.request_reward_peer_contact($1) as payload", [code]);
  check("revocation blocks new request", revokedRequest.reason === "contact request unavailable");
  const durableSend = await payload(requesterAfterRace, "select public.send_reward_peer_message($1, $2) as payload", [accepted.conversation.id, "Consent persists"]);
  check("accepted conversation survives revocation", durableSend.message?.body === "Consent persists");
  for (let index = 2; index <= 20; index += 1) {
    await payload(requesterAfterRace, "select public.send_reward_peer_message($1, $2) as payload", [accepted.conversation.id, `Bounded message ${index}`]);
  }
  let messageRateDenied = false;
  try {
    await payload(requesterAfterRace, "select public.send_reward_peer_message($1, $2) as payload", [accepted.conversation.id, "Twenty-first message"]);
  } catch (error) {
    messageRateDenied = error?.code === "22023" && error?.message === "message unavailable";
  }
  check("message rate caps at twenty per five minutes", messageRateDenied);

  const exportAuditBefore = (await admin.query(`
    select count(*)::int as count
    from private.member_account_lifecycle_audit
    where subject_hash = private.member_lifecycle_subject_hash($1)
      and event_type = 'export_generated'
  `, [users.requester])).rows[0].count;
  const memberExport = await payload(requesterAfterRace, "select public.get_member_data_export() as payload");
  const exportAuditAfter = (await admin.query(`
    select count(*)::int as count
    from private.member_account_lifecycle_audit
    where subject_hash = private.member_lifecycle_subject_hash($1)
      and event_type = 'export_generated'
  `, [users.requester])).rows[0].count;
  const exportText = JSON.stringify(memberExport);
  check("peer contact export includes caller requests", memberExport.peerContact?.requests?.some((request) => request.id === created.id && request.direction === "sent"));
  check("peer contact export includes accepted messages", memberExport.peerContact?.conversations?.some((conversation) =>
    conversation.id === accepted.conversation.id
      && conversation.messages?.some((message) => message.body === "Consent persists" && message.sentByMe)));
  check("peer contact export is bounded", memberExport.peerContact.requests.length <= 100
    && memberExport.peerContact.conversations.length <= 20
    && memberExport.peerContact.conversations.every((conversation) => conversation.messages.length <= 100));
  check("peer contact export omits peer identity and contact secrets",
    !exportText.includes(users.recipient)
      && !exportText.includes("reward-contact-proof-1@example.invalid")
      && !exportText.includes(code));
  check("peer contact export writes one audit event", exportAuditAfter === exportAuditBefore + 1);
  await requesterAfterRace.end();
  clients.splice(clients.indexOf(requesterAfterRace), 1);

  const outsider = await actor(users.outsider, "reward-contact-proof-outsider");
  clients.push(outsider);
  let outsiderDenied = false;
  try {
    await payload(outsider, "select public.send_reward_peer_message($1, $2) as payload", [accepted.conversation.id, "not a participant"]);
  } catch (error) {
    outsiderDenied = error?.code === "22023" && error?.message === "message unavailable";
    await outsider.query("rollback");
  }
  check("non-participant message denial is uniform", outsiderDenied);
  const persistedMessages = (await admin.query("select count(*)::int as count from public.member_peer_messages where conversation_id = $1", [accepted.conversation.id])).rows[0].count;
  check("non-participant denial has no mutation", persistedMessages === 20);

  const labsActor = await actor(users.requester, "reward-contact-proof-labs");
  clients.push(labsActor);
  const labsGranted = await payload(labsActor, "select public.list_reward_experimental_content('es') as payload");
  check("experimental content is granted and localized", labsGranted?.[0]?.title === "Preparación de reuniones");
  const labsDenied = await payload(noGrant, "select public.list_reward_experimental_content('en') as payload");
  check("experimental content denial is empty", Array.isArray(labsDenied) && labsDenied.length === 0);
  await admin.query("update public.member_reward_grants set status = 'revoked' where user_id = $1 and item_key = 'experimental-access'", [users.requester]);
  const labsRevoked = await payload(labsActor, "select public.list_reward_experimental_content('en') as payload");
  check("experimental revocation is immediate", Array.isArray(labsRevoked) && labsRevoked.length === 0);

  // Accepted edge deletion proof: deleting either participant must never be
  // blocked by the request/conversation relationship. The deleted member's
  // key, request, conversation, and message cascade; the other member and key
  // remain intact (no collateral deletion).
  const deleteRequesterActor = await autocommitActor(users.deleteRequester, "reward-contact-proof-delete-requester");
  const deleteRecipientActor = await autocommitActor(users.deleteRecipient, "reward-contact-proof-delete-recipient");
  clients.push(deleteRequesterActor, deleteRecipientActor);
  const deleteRecipientCode = (await admin.query("select private.member_peer_contact_code($1) as code", [users.deleteRecipient])).rows[0].code;
  const deleteRequest = await payload(deleteRequesterActor, "select public.request_reward_peer_contact($1) as payload", [deleteRecipientCode]);
  const deleteAcceptance = await payload(deleteRecipientActor, "select public.respond_reward_peer_contact($1, true) as payload", [deleteRequest.id]);
  const deleteMessage = await payload(deleteRequesterActor, "select public.send_reward_peer_message($1, $2) as payload", [deleteAcceptance.conversation.id, "Account deletion cascade proof"]);
  check("account deletion fixture has accepted request conversation and message", deleteRequest.requested && deleteAcceptance.accepted && deleteMessage.message?.id);
  await deleteRequesterActor.end();
  await deleteRecipientActor.end();
  clients.splice(clients.indexOf(deleteRequesterActor), 1);
  clients.splice(clients.indexOf(deleteRecipientActor), 1);

  await admin.query("delete from auth.users where id = $1", [users.deleteRequester]);
  const deletionState = (await admin.query(`
    select
      (select count(*) from public.member_peer_contact_keys where user_id = $1)::int as deleted_keys,
      (select count(*) from public.member_peer_contact_requests where id = $2)::int as requests,
      (select count(*) from public.member_peer_conversations where id = $3)::int as conversations,
      (select count(*) from public.member_peer_messages where id = $4)::int as messages,
      (select count(*) from auth.users where id = $5)::int as recipient_users,
      (select count(*) from public.member_peer_contact_keys where user_id = $5)::int as recipient_keys
  `, [users.deleteRequester, deleteRequest.id, deleteAcceptance.conversation.id, deleteMessage.message.id, users.deleteRecipient])).rows[0];
  check("account deletion cascades the complete peer graph", deletionState.deleted_keys === 0 && deletionState.requests === 0 && deletionState.conversations === 0 && deletionState.messages === 0);
  check("account deletion has no collateral recipient deletion", deletionState.recipient_users === 1 && deletionState.recipient_keys === 1);

  await closeActors();
  await admin.query("delete from auth.users where id = any($1::uuid[])", [Object.values(users)]);
  const residue = await fixtureResidue();
  check("fixture cleanup leaves zero peer residue", Object.values(residue).every((count) => count === 0), JSON.stringify(residue));

  for (const item of checks) console.log(`PASS ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
  console.log(`PASS ${checks.length}/${checks.length} reward peer-contact/labs checks`);
} finally {
  await closeActors();
  await admin.query("delete from auth.users where id = any($1::uuid[])", [Object.values(users)]);
  const residue = await fixtureResidue();
  await admin.end();
  if (!Object.values(residue).every((count) => count === 0)) {
    check("fatal cleanup leaves zero peer residue", false, JSON.stringify(residue));
  }
}
