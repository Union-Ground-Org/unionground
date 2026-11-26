import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";

const { Client } = pg;
const databaseUrl = assertDisposableProofUrl(requireDatabaseUrl("SUPABASE_DB_URL", { aliases: ["DATABASE_URL"] }));

const ids = {
  organization: "50908900-0000-4000-8000-000000000101",
  targetA: "50908900-0000-4000-8000-000000000001",
  targetB: "50908900-0000-4000-8000-000000000002",
  ledgerOnlyTarget: "50908900-0000-4000-8000-000000000099",
  historyJob: "50908900-0000-4000-8000-000000000201",
  jobA: "50908900-0000-4000-8000-000000000202",
  jobB: "50908900-0000-4000-8000-000000000203",
  staleJob: "50908900-0000-4000-8000-000000000204",
};
const chapterId = "cr089-rate-proof";
const clients = {
  admin: new Client({ connectionString: databaseUrl, application_name: "cr089-rate-admin" }),
  first: new Client({ connectionString: databaseUrl, application_name: "cr089-rate-first" }),
  second: new Client({ connectionString: databaseUrl, application_name: "cr089-rate-second" }),
};

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function cleanup() {
  await clients.admin.query("reset role");
  await clients.admin.query("begin");
  try {
    await clients.admin.query("delete from public.integration_jobs where organization_id = $1", [ids.organization]);
    await clients.admin.query("delete from private.member_sms_preferences where organization_id = $1", [ids.organization]);
    await clients.admin.query("delete from public.chapter_connection_readiness where chapter_id = $1", [chapterId]);
    await clients.admin.query("delete from public.organization_integrations where organization_id = $1", [ids.organization]);
    await clients.admin.query("delete from public.organization_memberships where organization_id = $1", [ids.organization]);
    await clients.admin.query("delete from auth.users where id = any($1::uuid[])", [[ids.targetA, ids.targetB]]);
    await clients.admin.query("delete from public.chapters where id = $1", [chapterId]);
    await clients.admin.query("delete from public.organizations where id = $1", [ids.organization]);
    await clients.admin.query("commit");
  } catch (error) {
    await clients.admin.query("rollback").catch(() => {});
    throw error;
  }
}

async function setup() {
  await cleanup();
  await clients.admin.query("begin");
  try {
    await clients.admin.query(`
      insert into auth.users (id, email) values
        ($1, 'cr089-rate-a@example.invalid'),
        ($2, 'cr089-rate-b@example.invalid')
    `, [ids.targetA, ids.targetB]);
    await clients.admin.query(`
      insert into public.organizations (id, slug, name, status)
      values ($1, 'cr089-rate-proof', 'CR-089 rate proof', 'active')
    `, [ids.organization]);
    await clients.admin.query(`
      insert into public.chapters (id, name, slug, is_default, order_index, organization_id)
      values ($1, 'CR-089 rate proof', $1, true, 1, $2)
    `, [chapterId, ids.organization]);
    await clients.admin.query(`
      insert into public.organization_memberships (organization_id, user_id, status) values
        ($1, $2, 'active'), ($1, $3, 'active')
    `, [ids.organization, ids.targetA, ids.targetB]);
    await clients.admin.query(`
      insert into public.member_chapter_memberships (user_id, chapter_id, status) values
        ($1, $3, 'active'), ($2, $3, 'active')
    `, [ids.targetA, ids.targetB, chapterId]);
    await clients.admin.query(
      "update public.member_profiles set chapter_id = $1 where id = any($2::uuid[])",
      [chapterId, [ids.targetA, ids.targetB]],
    );
    await clients.admin.query(`
      insert into private.member_sms_preferences (
        organization_id, user_id, phone_e164, consented, consented_at
      ) values
        ($1, $2, '+15085550101', true, now()),
        ($1, $3, '+15085550102', true, now())
    `, [ids.organization, ids.targetA, ids.targetB]);
    await clients.admin.query(`
      insert into public.chapter_connection_readiness (
        chapter_id, capability, status, provider_label, verified_at
      ) values ($1, 'sms', 'active', 'Twilio', now())
    `, [chapterId]);
    await clients.admin.query(`
      insert into public.organization_integrations (
        organization_id, provider, status, default_settings, credential_ref
      ) values (
        $1, 'twilio', 'connected',
        '{"accountSid":"AC11111111111111111111111111111111","fromNumber":"+15085550100"}'::jsonb,
        'local-proof-only'
      )
    `, [ids.organization]);
    await clients.admin.query("commit");
  } catch (error) {
    await clients.admin.query("rollback").catch(() => {});
    throw error;
  }
}

async function clearJobs() {
  await clients.admin.query("delete from public.integration_jobs where organization_id = $1", [ids.organization]);
}

async function insertJob(id, targetUserId, { status = "queued", updatedAt = "now()" } = {}) {
  await clients.admin.query(`
    insert into public.integration_jobs (
      id, organization_id, chapter_id, provider, job_kind, status,
      idempotency_key, request_digest, target_user_id, operation_purpose, updated_at
    ) values (
      $1::uuid, $2, $3, 'twilio', 'sms_send', $4,
      'sms-send:' || ($1::uuid)::text, repeat('a', 64), $5, 'policy_notice', ${updatedAt}
    )
  `, [id, ids.organization, chapterId, status, targetUserId]);
}

async function seedAttempts(count, targetUserId) {
  await insertJob(ids.historyJob, ids.targetA, { status: "success" });
  await clients.admin.query(`
    insert into private.twilio_sms_attempts (
      job_id, organization_id, target_user_id, attempted_at
    )
    select $1, $2, $3, now() - interval '5 minutes'
    from pg_catalog.generate_series(1, $4)
  `, [ids.historyJob, ids.organization, targetUserId, count]);
}

async function claim(client, jobId) {
  await client.query("begin");
  try {
    await client.query("set local statement_timeout = '8s'");
    await client.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
    await client.query("set local role service_role");
    const value = (await client.query(
      "select public.claim_twilio_sms_send($1) as value",
      [jobId],
    )).rows[0].value;
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

async function recordConsent(client, eventType, providerDigest) {
  await client.query("begin");
  try {
    await client.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
    await client.query("set local role service_role");
    await client.query(
      "select public.record_twilio_inbound_consent($1, $2, '+15085550101', $3, $4, $5)",
      [ids.organization, providerDigest, "f".repeat(64), eventType, eventType === "opt_out" ? "STOP" : "START"],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

async function setAuthenticatedConsent(client, consented) {
  await client.query("begin");
  try {
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
      role: "authenticated",
      sub: ids.targetA,
      aal: "aal2",
    })]);
    await client.query("set local role authenticated");
    await client.query(
      "select public.set_my_sms_consent('+15085550101', $1)",
      [consented],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

async function waitForBothClaimsToBlock() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await clients.admin.query(`
      select pid, wait_event_type
      from pg_catalog.pg_stat_activity
      where pid = any($1::integer[])
    `, [[clients.first.processID, clients.second.processID]]);
    if (result.rows.length === 2 && result.rows.every((row) => row.wait_event_type === "Lock")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("concurrent claims did not both wait on the organization advisory lock");
}

async function claimConcurrently(firstJob, secondJob) {
  await clients.admin.query("begin");
  await clients.admin.query(
    "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('twilio_sms_rate_org:' || $1::text, 509))",
    [ids.organization],
  );
  const first = claim(clients.first, firstJob);
  const second = claim(clients.second, secondJob);
  try {
    await waitForBothClaimsToBlock();
  } catch (error) {
    await clients.admin.query("commit").catch(() => {});
    await Promise.allSettled([first, second]);
    throw error;
  }
  await clients.admin.query("commit");
  return Promise.all([first, second]);
}

function assertOneClaimOneLimit(outcomes, scope, label) {
  const claimed = outcomes.filter((value) => value.claimed === true);
  const limited = outcomes.filter((value) => value.claimed === false && value.reason === "rate_limited");
  assert(claimed.length === 1, `${label}: expected exactly one provider-attempt claim`);
  assert(limited.length === 1 && limited[0].scope === scope, `${label}: expected one ${scope} refusal`);
}

try {
  await Promise.all(Object.values(clients).map((client) => client.connect()));
  await setup();

  await seedAttempts(11, ids.targetA);
  await insertJob(ids.jobA, ids.targetA);
  await insertJob(ids.jobB, ids.targetA);
  let outcomes = await claimConcurrently(ids.jobA, ids.jobB);
  assertOneClaimOneLimit(outcomes, "recipient_hour", "recipient N+1 race");
  let count = Number((await clients.admin.query(
    "select count(*) from private.twilio_sms_attempts where organization_id = $1",
    [ids.organization],
  )).rows[0].count);
  assert(count === 12, "recipient N+1 race reserved more than 12 attempts");

  await clearJobs();
  await seedAttempts(19_999, ids.ledgerOnlyTarget);
  await insertJob(ids.jobA, ids.targetA);
  await insertJob(ids.jobB, ids.targetB);
  outcomes = await claimConcurrently(ids.jobA, ids.jobB);
  assertOneClaimOneLimit(outcomes, "organization_day", "organization N+1 race");
  count = Number((await clients.admin.query(
    "select count(*) from private.twilio_sms_attempts where organization_id = $1",
    [ids.organization],
  )).rows[0].count);
  assert(count === 20_000, "organization N+1 race reserved more than 20,000 attempts");

  await clearJobs();
  await seedAttempts(12, ids.targetA);
  await insertJob(ids.staleJob, ids.targetA, { updatedAt: "now() - interval '2 days'" });
  const stale = await claim(clients.first, ids.staleJob);
  assert(stale.claimed === false && stale.reason === "rate_limited" && stale.scope === "recipient_hour",
    "aged queued job bypassed the immutable attempt ledger");
  const staleState = (await clients.admin.query(
    "select status, attempt_count from public.integration_jobs where id = $1",
    [ids.staleJob],
  )).rows[0];
  assert(staleState.status === "queued" && staleState.attempt_count === 0,
    "rate-limited stale job changed state or consumed an attempt");

  await recordConsent(clients.first, "opt_out", "1".repeat(64));
  let consent = (await clients.admin.query(
    "select consented, consented_at, revoked_at from private.member_sms_preferences where organization_id = $1 and user_id = $2",
    [ids.organization, ids.targetA],
  )).rows[0];
  assert(consent.consented === false && consent.consented_at === null && consent.revoked_at,
    "STOP callback did not revoke the exact organization-scoped preference");
  // Simulate START A failing before commit, STOP B succeeding, and the older
  // START A arriving later for its first committed delivery.
  await recordConsent(clients.first, "opt_in", "2".repeat(64));
  consent = (await clients.admin.query(
    "select consented, consented_at, revoked_at from private.member_sms_preferences where organization_id = $1 and user_id = $2",
    [ids.organization, ids.targetA],
  )).rows[0];
  assert(consent.consented === false && consent.consented_at === null && consent.revoked_at,
    "delayed START callback undid a newer STOP without authenticated re-consent");
  const delayedStart = (await clients.admin.query(
    "select status, provider_status, error_code from public.integration_jobs where organization_id = $1 and provider_reference_digest = $2",
    [ids.organization, "2".repeat(64)],
  )).rows[0];
  assert(delayedStart.status === "success" && delayedStart.provider_status === "suppressed"
      && delayedStart.error_code === "authenticated_reconsent_required",
  "delayed START callback was not recorded as requiring authenticated re-consent");

  await setAuthenticatedConsent(clients.first, true);
  consent = (await clients.admin.query(
    "select consented, consented_at, revoked_at from private.member_sms_preferences where organization_id = $1 and user_id = $2",
    [ids.organization, ids.targetA],
  )).rows[0];
  assert(consent.consented === true && consent.consented_at && consent.revoked_at === null,
    "authenticated member action did not restore organization-scoped consent");

  await clients.admin.query("begin");
  await clients.admin.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
  await clients.admin.query("set local role service_role");
  try {
    await clients.admin.query(
      "update private.twilio_sms_attempts set attempted_at = now() - interval '2 days' where organization_id = $1",
      [ids.organization],
    );
    throw new Error("service role rewrote the append-only attempt ledger");
  } catch (error) {
    assert(error.code === "42501", `expected direct ledger update denial, got ${error.code || error.message}`);
  } finally {
    await clients.admin.query("rollback");
  }

  await cleanup();
  console.log("PASS: Twilio claims serialize N+1 limits; delayed START cannot undo STOP; authenticated re-consent succeeds.");
} catch (error) {
  await Promise.all(Object.values(clients).map((client) => client.query("rollback").catch(() => {})));
  await cleanup().catch(() => {});
  throw error;
} finally {
  await Promise.all(Object.values(clients).map((client) => client.end().catch(() => {})));
}
