import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";

const { Client } = pg;
const databaseUrl = assertDisposableProofUrl(requireDatabaseUrl("SUPABASE_DB_URL", { aliases: ["DATABASE_URL"] }));

const ids = {
  deleting: "50900000-0000-4000-8000-000000000081",
  remaining: "50900000-0000-4000-8000-000000000082",
  session: "50900000-0000-4000-8000-000000000083",
  amr: "50900000-0000-4000-8000-000000000084",
  record: "50900000-0000-4000-8000-000000000085",
  appointment: "50900000-0000-4000-8000-000000000086",
  conversation: "50900000-0000-4000-8000-000000000087",
  otherConversation: "50900000-0000-4000-8000-000000000088",
  form: "50900000-0000-4000-8000-000000000089",
};

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function asRole(client, role, claims = {}) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role, ...claims })]);
  await client.query(`set local role ${role}`);
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

const client = new Client({ connectionString: databaseUrl, application_name: "account-lifecycle-rollback-proof" });
try {
  await client.connect();
  await client.query("begin");
  await client.query("insert into auth.users (id, email) values ($1, 'deleting@example.invalid'), ($2, 'remaining@example.invalid')", [ids.deleting, ids.remaining]);
  await client.query("update public.member_profiles set chapter_id = 'wor' where id in ($1, $2)", [ids.deleting, ids.remaining]);
  await client.query("insert into auth.sessions (id, user_id, aal) values ($1, $2, 'aal2')", [ids.session, ids.deleting]);
  await client.query(`
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
    values ($1, $2, 'totp', now() - interval '11 minutes', now() - interval '11 minutes')
  `, [ids.amr, ids.session]);
  const claims = { sub: ids.deleting, aal: "aal2", session_id: ids.session };
  await client.query("insert into public.member_roles (user_id, role, chapter_id) values ($1, 'steward', 'wor')", [ids.deleting]);
  await asRole(client, "authenticated", claims);
  ids.record = (await client.query(`
    insert into public.chapter_records (record_type, title, body, occurred_at)
    values ('minutes', 'Chapter record survives', 'chapter-authored-body', now())
    returning id
  `)).rows[0].id;
  await client.query("reset role");

  await client.query(`
    insert into public.member_conversations (id, user_id, title) values
      ($1, $2, 'Deleting member private thread'),
      ($3, $4, 'Remaining member private thread')
  `, [ids.conversation, ids.deleting, ids.otherConversation, ids.remaining]);
  await client.query(`
    insert into public.member_messages (conversation_id, user_id, sender_kind, sender_name, body) values
      ($1, $2, 'member', 'Deleting member', 'own-private-body'),
      ($3, $4, 'member', 'Remaining member', 'other-private-body')
  `, [ids.conversation, ids.deleting, ids.otherConversation, ids.remaining]);
  await client.query(`
    insert into public.member_forms (id, user_id, template_key, template_version, answers)
    values ($1, $2, 'alliance_grievance', 1, '{"summary":"own form"}')
  `, [ids.form, ids.deleting]);
  await client.query(`
    insert into public.member_form_cosigners (form_id, invited_email, invited_by)
    values ($1, 'other-member-address@example.invalid', $2)
  `, [ids.form, ids.deleting]);
  await client.query(`
    insert into public.member_push_subscriptions (user_id, endpoint, p256dh, auth_key)
    values ($1, 'https://push.services.mozilla.com/private-proof', 'secret-p256dh', 'secret-auth-key')
  `, [ids.deleting]);
  await client.query(`
    insert into public.member_appointments
      (id, user_id, steward_id, chapter_id, appointment_type, duration_minutes, starts_at, ends_at, routed_via)
    values ($1, $2, $3, 'wor', 'office_hours', 20, now() + interval '2 days', now() + interval '2 days 20 minutes', 'steward')
  `, [ids.appointment, ids.remaining, ids.deleting]);
  await client.query("update public.chapter_records set created_by = null where id = $1", [ids.record]);
  assert((await client.query("select created_by from public.chapter_records where id = $1", [ids.record])).rows[0].created_by === ids.deleting,
    "ordinary updates must not detach immutable chapter authorship");

  await asRole(client, "authenticated", claims);
  await expectState(
    client,
    "stale_aal2",
    "select public.authorize_member_account_deletion('DELETE MY ACCOUNT')",
    [],
    "42501",
  );

  await client.query("reset role");
  await client.query("update auth.mfa_amr_claims set created_at = now(), updated_at = now() where id = $1", [ids.amr]);
  await asRole(client, "authenticated", claims);
  await expectState(
    client,
    "wrong_confirmation",
    "select public.authorize_member_account_deletion('delete my account')",
    [],
    "42501",
  );

  const exported = (await client.query("select public.get_member_data_export() as value")).rows[0].value;
  const exportText = JSON.stringify(exported);
  assert(exported.account.userId === ids.deleting, "export must identify only its caller");
  assert(exportText.includes("own-private-body"), "export must contain caller-owned workflow content");
  assert(!exportText.includes("other-private-body"), "export must exclude another member's workflow content");
  for (const secret of ["other-member-address@example.invalid", "secret-p256dh", "secret-auth-key", "private-proof"]) {
    assert(!exportText.includes(secret), `export leaked excluded secret: ${secret}`);
  }

  const authorization = (await client.query("select public.authorize_member_account_deletion('DELETE MY ACCOUNT') as value")).rows[0].value;
  assert(authorization.userId === ids.deleting, "authorization must derive the JWT subject");
  assert(/^[0-9a-f]{64}$/.test(authorization.deletionToken), "authorization must return a bounded random capability");

  await asRole(client, "service_role");
  const wrongSubject = (await client.query(
    "select public.claim_member_account_deletion($1, $2, $3) as value",
    [authorization.requestId, ids.remaining, authorization.deletionToken],
  )).rows[0].value;
  assert(wrongSubject.claimed === false, "claim must bind the capability to the derived subject");
  const firstClaim = (await client.query(
    "select public.claim_member_account_deletion($1, $2, $3) as value",
    [authorization.requestId, ids.deleting, authorization.deletionToken],
  )).rows[0].value;
  const replayClaim = (await client.query(
    "select public.claim_member_account_deletion($1, $2, $3) as value",
    [authorization.requestId, ids.deleting, authorization.deletionToken],
  )).rows[0].value;
  assert(firstClaim.claimed === true && replayClaim.claimed === false, "one-time claim must reject replay");

  await client.query("reset role");
  await client.query("delete from auth.users where id = $1", [ids.deleting]);
  assert((await client.query("select count(*)::int n from public.member_conversations where user_id = $1", [ids.deleting])).rows[0].n === 0,
    "deleting auth identity must cascade caller-private workflows");
  const retainedRecord = (await client.query("select created_by from public.chapter_records where id = $1", [ids.record])).rows[0];
  assert(retainedRecord && retainedRecord.created_by === null, "chapter-authored record must survive without live attribution");
  const retainedAppointment = (await client.query("select user_id, steward_id from public.member_appointments where id = $1", [ids.appointment])).rows[0];
  assert(retainedAppointment?.user_id === ids.remaining && retainedAppointment.steward_id === null,
    "another member's appointment must survive a steward deletion");
  assert((await client.query("select count(*)::int n from auth.users where id = $1", [ids.remaining])).rows[0].n === 1,
    "deletion must not remove another account");

  await asRole(client, "service_role");
  const finalized = (await client.query(
    "select public.finalize_member_account_deletion($1, $2, true, null) as value",
    [authorization.requestId, authorization.deletionToken],
  )).rows[0].value;
  assert(finalized.recorded === true, "service must finalize a claimed deletion after auth removal");

  await client.query("rollback");
  const residue = await client.query("select count(*)::int n from auth.users where id in ($1, $2)", [ids.deleting, ids.remaining]);
  assert(residue.rows[0].n === 0, "rollback-only proof must leave no identity fixtures");
  console.log("PASS: caller-scoped export, recent-AAL2 authorization, one-time claim, cascades, and no-collateral retention proved locally; fixture transaction rolled back cleanly.");
} catch (error) {
  await client.query("rollback").catch(() => {});
  throw error;
} finally {
  await client.end().catch(() => {});
}
