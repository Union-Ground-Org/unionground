import { proveConcurrentActualKeyRotation } from './account-lifecycle-concurrency-proof.mjs';
import { proveLegacyFingerprintUpgrade } from './account-deletion-fingerprint-upgrade-proof.mjs';
// BUG-UG-ACCOUNT-DELETION-FINALIZATION-20260831: proves the independent
// reconciliation path against a real local Postgres. The scenario this
// exists for: Auth admin deletion returns 204, then BOTH post-delete RPCs
// return 503 (or are never reached) -- exactly what api/account-lifecycle.js
// treats as an honest audited:false outcome. This proves a durable
// processing record survives those failures and an independent, token-free
// reconciliation path still reaches a terminal deletion_completed audit
// event, without ever touching the ephemeral plaintext deletion token again.
import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";

const { Client } = pg;
const databaseUrl = assertDisposableProofUrl(requireDatabaseUrl("SUPABASE_DB_URL", { aliases: ["DATABASE_URL"] }));

const ids = {
  deleting: "50900900-0000-4000-8000-000000000001",
  session: "50900900-0000-4000-8000-000000000002",
  amr: "50900900-0000-4000-8000-000000000003",
  living: "50900900-0000-4000-8000-000000000004",
  livingSession: "50900900-0000-4000-8000-000000000005",
  livingAmr: "50900900-0000-4000-8000-000000000006",
  jobRun: "account-deletion-50900900-0000-4000-8000-000000000099",
};

const DRIFTED_SUBJECT_HASH_SQL = `create or replace function private.member_lifecycle_subject_hash(p_user_id uuid)
  returns text language sql stable security definer set search_path = '' as $$
    -- deliberately different prosrc with equivalent behavior
    select pg_catalog.encode(
      extensions.hmac(pg_catalog.convert_to(p_user_id::text, 'UTF8'), secret.secret, 'sha256'),
      'hex')
    from private.member_account_lifecycle_secret secret where secret.id
  $$`;

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function asRole(client, role, claims = {}) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role, ...claims })]);
  await client.query(`set local role ${role}`);
}

const client = new Client({ connectionString: databaseUrl, application_name: "account-deletion-finalization-proof" });
try {
  await client.connect();
  await client.query("begin");

  // Reproduce the former ownerless profile scope with an owned Tamarack
  // fixture. The retired agency IDs remain blocked by their CHECK.
  await client.query("alter table public.chapters disable trigger chapters_forbid_ownerless_write");
  await client.query("insert into public.chapters(id,name,slug,order_index) values ('tamarack-finalization-proof','Tamarack finalization proof','tamarack-finalization-proof',9901)");
  await client.query("alter table public.chapters enable trigger chapters_forbid_ownerless_write");
  await client.query("insert into auth.users (id, email) values ($1, 'finalization-proof@example.invalid')", [ids.deleting]);
  await client.query("insert into auth.users (id, email) values ($1, 'finalization-live-control@example.invalid')", [ids.living]);
  await client.query("update public.member_profiles set chapter_id = 'tamarack-finalization-proof' where id = $1", [ids.deleting]);
  await client.query("insert into auth.sessions (id, user_id, aal, created_at) values ($1, $2, 'aal2', now())", [ids.session, ids.deleting]);
  await client.query("insert into auth.sessions (id, user_id, aal, created_at) values ($1, $2, 'aal2', now())", [ids.livingSession, ids.living]);
  await client.query(`
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
    values ($1, $2, 'totp', now(), now())
  `, [ids.amr, ids.session]);
  await client.query(`
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
    values ($1, $2, 'totp', now(), now())
  `, [ids.livingAmr, ids.livingSession]);
  const claims = { sub: ids.deleting, aal: "aal2", session_id: ids.session };
  const livingClaims = { sub: ids.living, aal: "aal2", session_id: ids.livingSession };

  await expectAuthorizationRefusal(client, claims, "installed subject-hash definition drift", DRIFTED_SUBJECT_HASH_SQL);

  await asRole(client, "authenticated", claims);
  const authorization = (await client.query("select public.authorize_member_account_deletion('DELETE MY ACCOUNT') as value")).rows[0].value;

  await asRole(client, "service_role");
  const claim = (await client.query(
    "select public.claim_member_account_deletion($1, $2, $3) as value",
    [authorization.requestId, ids.deleting, authorization.deletionToken],
  )).rows[0].value;
  assert(claim.claimed === true, "claim must succeed before the simulated Auth deletion");

  // Negative control: an otherwise-identical processing request whose Auth
  // identity remains live. The absence arm must never manufacture completion
  // evidence for this request.
  await asRole(client, "authenticated", livingClaims);
  const liveAuthorization = (await client.query(
    "select public.authorize_member_account_deletion('DELETE MY ACCOUNT') as value",
  )).rows[0].value;
  await asRole(client, "service_role");
  const liveClaim = (await client.query(
    "select public.claim_member_account_deletion($1, $2, $3) as value",
    [liveAuthorization.requestId, ids.living, liveAuthorization.deletionToken],
  )).rows[0].value;
  assert(liveClaim.claimed === true, "live-identity negative-control claim must enter processing");

  // Monitoring is itself a persisted, idempotent contract. A repeated start
  // must not duplicate the row, a terminal completion must win forever, and
  // neither untrusted failure text nor an authenticated caller is admitted.
  await client.query(
    "select public.record_account_deletion_reconcile_job_run($1, 'in_progress', null)",
    [ids.jobRun],
  );
  await client.query(
    "select public.record_account_deletion_reconcile_job_run($1, 'in_progress', null)",
    [ids.jobRun],
  );
  await client.query(
    "select public.record_account_deletion_reconcile_job_run($1, 'completed', null)",
    [ids.jobRun],
  );
  await client.query(
    "select public.record_account_deletion_reconcile_job_run($1, 'failed', 'reconcile_unavailable')",
    [ids.jobRun],
  );
  await expectPermissionDenied(
    client,
    "authenticated cannot record account-deletion reconciliation health",
    "select public.record_account_deletion_reconcile_job_run($1, 'completed', null)",
    [ids.jobRun],
    "authenticated",
  );
  await expectInvalidMonitoringFailureClass(client, ids.jobRun);
  await client.query("reset role");
  const monitoring = (await client.query(
    `select pg_catalog.count(*)::int as row_count,
      pg_catalog.min(status) as status,
      pg_catalog.min(failure_code) as failure_code,
      pg_catalog.min(redacted_summary) as redacted_summary,
      pg_catalog.bool_and(organization_id is null) as platform_scoped
     from public.organization_job_runs
     where job_name = 'account-deletion-reconcile-tick' and run_id = $1`,
    [ids.jobRun],
  )).rows[0];
  assert(monitoring.row_count === 1
      && monitoring.status === "completed"
      && monitoring.failure_code === null
      && monitoring.redacted_summary === "Account deletion reconciliation recorded."
      && monitoring.platform_scoped,
  `monitoring must be idempotent, terminal-first, platform-scoped, and redacted: ${JSON.stringify(monitoring)}`);

  // The irreversible operation: Auth admin deletion succeeds (204). Omit BOTH
  // post-delete calls: neither the marker nor finalize runs, modeling the
  // database becoming unreachable immediately after GoTrue commits.
  await client.query("reset role");
  await client.query("delete from auth.users where id = $1", [ids.deleting]);

  const stuck = (await client.query(
    "select status, auth_deleted_at is not null as auth_deleted, finalized_at from private.member_account_deletions where id = $1",
    [authorization.requestId],
  )).rows[0];
  assert(stuck.status === "processing" && stuck.auth_deleted === false && stuck.finalized_at === null,
    "two failed post-delete RPCs must leave the claimed processing row as a durable indeterminate record");

  // A member re-authenticating (impossible here -- the account is gone) is
  // not how this recovers. Only the independent, token-free reconciliation
  // path can, exactly as required.
  await asRole(client, "service_role");
  await expectPermissionDenied(client, "authenticated cannot call service-only mark_member_account_deletion_auth_completed",
    "select public.mark_member_account_deletion_auth_completed($1)", [authorization.requestId], "authenticated");
  const reconciledCount = (await client.query("select public.reconcile_pending_account_deletions(25) as value")).rows[0].value;
  assert(reconciledCount >= 1, "reconciliation must process the stuck request");

  // private is not USAGE-granted to authenticated/service_role -- only its
  // owning superuser and functions that reach it through SECURITY DEFINER can
  // read it directly, so these assertions run as the connection's own role.
  await client.query("reset role");
  const finalState = (await client.query(
    "select status, finalized_at is not null as finalized, failure_code from private.member_account_deletions where id = $1",
    [authorization.requestId],
  )).rows[0];
  assert(finalState.status === "completed" && finalState.finalized && finalState.failure_code === null,
    "reconciliation must reach a terminal completed state with no failure code");

  const auditEvents = (await client.query(
    `select event_type from private.member_account_lifecycle_audit
     where subject_hash = (select subject_hash from private.member_account_deletions where id = $1)
     order by id`,
    [authorization.requestId],
  )).rows.map((row) => row.event_type);
  assert(auditEvents.includes("deletion_completed"),
    "the durable terminal audit event must exist even though the original finalize RPC never ran");

  await asRole(client, "service_role");
  const terminalAudit = (await client.query(
    "select public.member_account_deletion_has_terminal_audit($1) as value",
    [authorization.requestId],
  )).rows[0].value;
  assert(terminalAudit.audited === true,
    "the request-specific audit proof must remain true after reconciliation wins the finalizer race");
  await expectPermissionDenied(
    client,
    "authenticated cannot inspect terminal account-deletion audit state",
    "select public.member_account_deletion_has_terminal_audit($1)",
    [authorization.requestId],
    "authenticated",
  );
  const unauditedLiveRequest = (await client.query(
    "select public.member_account_deletion_has_terminal_audit($1) as value",
    [liveAuthorization.requestId],
  )).rows[0].value;
  assert(unauditedLiveRequest.audited === false,
    "a nonterminal live-identity request must never be reported as audited");
  await client.query("reset role");

  const liveRequest = (await client.query(
    `select status, auth_deleted_at, finalized_at
       from private.member_account_deletions
      where id = $1`,
    [liveAuthorization.requestId],
  )).rows[0];
  assert(liveRequest.status === "processing"
      && liveRequest.auth_deleted_at === null
      && liveRequest.finalized_at === null,
  "a processing request for a live Auth identity must remain honestly indeterminate");
  const liveCompletedEvents = await client.query(
    `select count(*)::int as n
       from private.member_account_lifecycle_audit
      where subject_hash = (
        select subject_hash from private.member_account_deletions where id = $1
      )
        and event_type = 'deletion_completed'`,
    [liveAuthorization.requestId],
  );
  assert(liveCompletedEvents.rows[0].n === 0,
    "a live Auth identity must have no fictional deletion_completed event");

  // A second reconciliation pass must be a no-op, not a duplicate audit event.
  await asRole(client, "service_role");
  const secondPass = (await client.query("select public.reconcile_pending_account_deletions(25) as value")).rows[0].value;
  assert(secondPass === 0, "reconciliation must not reprocess an already-completed request");

  // Fail-closed controls for both inputs to the HMAC comparison. These mutate
  // only savepoint-local fixture/catalog state and prove that neither a key
  // mismatch nor a same-behavior-but-different installed routine can turn the
  // still-live negative control into a completed deletion.
  // A per-request key-fingerprint mismatch strands exactly one request. It
  // must park that row visibly and let every other request reconcile in the
  // same run; a whole-table abort would disable the record's own recovery
  // path fleet-wide until an operator intervened.
  await proveStrandedRequestIsParkedPerRow(client, liveAuthorization.requestId);
  await expectReconciliationRefusal(
    client,
    "installed subject-hash definition drift",
    DRIFTED_SUBJECT_HASH_SQL,
    [],
  );
  await expectReconciliationRefusal(
    client,
    "missing subject-hash secret",
    "delete from private.member_account_lifecycle_secret",
    [],
  );

  await client.query("rollback");
  const residue = await client.query(
    "select count(*)::int n from auth.users where id = any($1::uuid[])",
    [[ids.deleting, ids.living]],
  );
  assert(residue.rows[0].n === 0, "rollback-only proof must leave no identity fixtures");
  await proveLegacyFingerprintUpgrade(databaseUrl);
  await proveConcurrentActualKeyRotation(client, databaseUrl);
  await proveConcurrentReconciliation(client);
  console.log("PASS: simultaneous marker/finalizer failures leave a durable processing record; authoritative auth.users absence reaches deletion_completed exactly once, while a live-identity processing control remains untouched with no fictional completion event; a request stranded by a lifecycle-key rotation is parked per-row as subject-key-rotated while every other request still reconciles in the same run, and the park marker is withdrawn when the key returns; monitoring is service-only, closed-class, redacted, idempotent, and terminal-first; concurrent reconciliation remains capped, disjoint, retry-safe, and exactly once; fixtures were removed cleanly.");
} catch (error) {
  await client.query("rollback").catch(() => {});
  throw error;
} finally {
  await client.end().catch(() => {});
}

async function expectPermissionDenied(pgClient, label, sql, values, asDifferentRole) {
  const savepoint = "sp_permission_check";
  await pgClient.query(`savepoint ${savepoint}`);
  try {
    await asRole(pgClient, asDifferentRole, {});
    await pgClient.query(sql, values);
    throw new Error(`${label}: expected a permission error`);
  } catch (error) {
    assert(error.code === "42501", `${label}: expected SQLSTATE 42501, got ${error.code || error.message}`);
  } finally {
    await pgClient.query(`rollback to savepoint ${savepoint}`);
    await pgClient.query(`release savepoint ${savepoint}`);
    await asRole(pgClient, "service_role");
  }
}

async function expectAuthorizationRefusal(pgClient, claims, label, mutationSql) {
  const savepoint = "sp_authorization_hash_contract";
  await pgClient.query("reset role");
  await pgClient.query(`savepoint ${savepoint}`);
  let refusal;
  try {
    await pgClient.query(mutationSql);
    await asRole(pgClient, "authenticated", claims);
    await pgClient.query("select public.authorize_member_account_deletion('DELETE MY ACCOUNT')");
  } catch (error) {
    refusal = error;
  }
  await pgClient.query(`rollback to savepoint ${savepoint}`);
  await pgClient.query(`release savepoint ${savepoint}`);
  assert(refusal?.code === "55000",
    `${label}: authorization expected SQLSTATE 55000, got ${refusal?.code || refusal?.message || "no refusal"}`);
}

async function expectReconciliationRefusal(pgClient, label, mutationSql, mutationValues) {
  const savepoint = "sp_subject_hash_contract";
  await pgClient.query("reset role");
  await pgClient.query(`savepoint ${savepoint}`);
  try {
    await pgClient.query(mutationSql, mutationValues);
    await asRole(pgClient, "service_role");
    await pgClient.query("select public.reconcile_pending_account_deletions(25)");
    throw new Error(`${label}: expected reconciliation to fail closed`);
  } catch (error) {
    assert(error.code === "55000", `${label}: expected SQLSTATE 55000, got ${error.code || error.message}`);
  } finally {
    await pgClient.query(`rollback to savepoint ${savepoint}`);
    await pgClient.query(`release savepoint ${savepoint}`);
    await asRole(pgClient, "service_role");
  }
}

async function expectInvalidMonitoringFailureClass(pgClient, runId) {
  const savepoint = "sp_monitoring_failure_class";
  await pgClient.query(`savepoint ${savepoint}`);
  let refusal;
  try {
    await asRole(pgClient, "service_role");
    await pgClient.query(
      "select public.record_account_deletion_reconcile_job_run($1, 'failed', 'member_content')",
      [runId],
    );
  } catch (error) {
    refusal = error;
  }
  await pgClient.query(`rollback to savepoint ${savepoint}`);
  await pgClient.query(`release savepoint ${savepoint}`);
  assert(refusal?.code === "22023",
    `monitoring failure classes must be closed, got ${refusal?.code || refusal?.message || "no refusal"}`);
  await asRole(pgClient, "service_role");
}

async function proveStrandedRequestIsParkedPerRow(pgClient, liveRequestId) {
  const savepoint = "sp_stranded_row_park";
  const healthySubjectUser = "50900902-0000-4000-8000-000000000001";
  await pgClient.query("reset role");
  await pgClient.query(`savepoint ${savepoint}`);
  try {
    // One healthy request that carries the token-independent marker, so its
    // arm never needs the subject hash at all, plus the live-identity control
    // stranded across a simulated lifecycle-secret rotation.
    // private.guard_member_account_deletion_request refuses a direct insert
    // with no authenticated caller. Creating a real MFA session here would
    // re-test authorization rather than this contract, so the disposable local
    // superuser suppresses user triggers for this one fixture insert, exactly
    // as the concurrency fixture below does.
    await pgClient.query("set session_replication_role = replica");
    let healthy;
    try {
      healthy = (await pgClient.query(`
      insert into private.member_account_deletions (
        subject_hash, subject_hash_key_fingerprint, token_hash, status,
        expires_at, claimed_at, auth_deleted_at
      )
      select private.member_lifecycle_subject_hash($1::uuid),
        pg_catalog.encode(extensions.digest(secret.secret, 'sha256'), 'hex'),
        pg_catalog.repeat('b', 64), 'processing',
        pg_catalog.now() + interval '5 minutes', pg_catalog.now(), pg_catalog.now()
      from private.member_account_lifecycle_secret secret
      where secret.id
      returning id, subject_hash
    `, [healthySubjectUser])).rows[0];
    } finally {
      await pgClient.query("set session_replication_role = origin");
    }
    const originalFingerprint = (await pgClient.query(
      "select subject_hash_key_fingerprint as value from private.member_account_deletions where id = $1",
      [liveRequestId],
    )).rows[0].value;
    await pgClient.query(
      "update private.member_account_deletions set subject_hash_key_fingerprint = pg_catalog.repeat('0', 64) where id = $1",
      [liveRequestId],
    );

    await asRole(pgClient, "service_role");
    const reconciled = (await pgClient.query(
      "select public.reconcile_pending_account_deletions(25) as value",
    )).rows[0].value;
    await pgClient.query("reset role");
    assert(reconciled === 1,
      `a stranded request must not abort the run: expected the healthy marker request to reconcile, got ${reconciled}`);

    const healthyState = (await pgClient.query(
      "select status, finalized_at is not null as finalized from private.member_account_deletions where id = $1",
      [healthy.id],
    )).rows[0];
    assert(healthyState.status === "completed" && healthyState.finalized,
      `the healthy request must still reach a terminal state alongside a stranded row: ${JSON.stringify(healthyState)}`);

    const parked = (await pgClient.query(
      `select status, failure_code, finalized_at, auth_deleted_at
         from private.member_account_deletions where id = $1`,
      [liveRequestId],
    )).rows[0];
    assert(parked.status === "processing"
        && parked.failure_code === "subject-key-rotated"
        && parked.finalized_at === null
        && parked.auth_deleted_at === null,
    `the stranded request must be parked visibly in processing, never completed: ${JSON.stringify(parked)}`);
    const parkedCompletions = (await pgClient.query(
      `select count(*)::int as n
         from private.member_account_lifecycle_audit
        where subject_hash = (select subject_hash from private.member_account_deletions where id = $1)
          and event_type = 'deletion_completed'`,
      [liveRequestId],
    )).rows[0].n;
    assert(parkedCompletions === 0, "a parked request must never gain a deletion_completed event");

    // Restoring the original key withdraws the park marker; the still-live
    // identity stays honestly indeterminate rather than being completed.
    await pgClient.query(
      "update private.member_account_deletions set subject_hash_key_fingerprint = $2 where id = $1",
      [liveRequestId, originalFingerprint],
    );
    await asRole(pgClient, "service_role");
    const afterRestore = (await pgClient.query(
      "select public.reconcile_pending_account_deletions(25) as value",
    )).rows[0].value;
    await pgClient.query("reset role");
    assert(afterRestore === 0, "restoring the key must not complete a request whose Auth identity is still live");
    const unparked = (await pgClient.query(
      "select status, failure_code from private.member_account_deletions where id = $1",
      [liveRequestId],
    )).rows[0];
    assert(unparked.status === "processing" && unparked.failure_code === null,
      `restoring the key must withdraw the stale park marker: ${JSON.stringify(unparked)}`);
  } catch (error) {
    // A whole-table abort raises 55000 here and poisons the transaction, so
    // report it as the contract failure it is rather than as the aborted
    // follow-up statement.
    throw new Error(
      `per-row parking proof failed: ${error.code ? `SQLSTATE ${error.code}: ` : ""}${error.message}`,
      { cause: error },
    );
  } finally {
    // Order matters: ROLLBACK TO SAVEPOINT is the only statement an aborted
    // transaction still accepts, so it must precede any role reset.
    await pgClient.query(`rollback to savepoint ${savepoint}`);
    await pgClient.query(`release savepoint ${savepoint}`);
    await pgClient.query("reset role");
    await asRole(pgClient, "service_role");
  }
}

async function proveConcurrentReconciliation(pgClient) {
  const fixtureCount = 40;
  // These rows model already-authorized, already-claimed requests. Creating
  // forty real MFA sessions would test authorization again rather than the
  // concurrency contract, so the disposable local superuser suppresses only
  // user triggers while inserting this rollback-independent fixture batch.
  // The caller already rolled the primary transaction back, so the insert
  // autocommits. The insert and its count assertion stay in the cleanup try:
  // a short batch still reaches the finally that deletes these rows.
  let inserted = [];

  const reconcileWorker = async (applicationName) => {
    const worker = new Client({ connectionString: databaseUrl, application_name: applicationName });
    try {
      await worker.connect();
      await worker.query("begin");
      await asRole(worker, "service_role");
      const count = (await worker.query(
        "select public.reconcile_pending_account_deletions(25) as value",
      )).rows[0].value;
      await worker.query("commit");
      return count;
    } catch (error) {
      await worker.query("rollback").catch(() => {});
      throw error;
    } finally {
      await worker.end().catch(() => {});
    }
  };

  try {
    await pgClient.query("set session_replication_role = replica");
    try {
      inserted = (await pgClient.query(`
        with subjects as (
          select ('50900901-0000-4000-8000-' || pg_catalog.lpad(n::text, 12, '0'))::uuid as user_id
          from pg_catalog.generate_series(1, $1) n
        ), fingerprint as (
          select pg_catalog.encode(extensions.digest(secret.secret, 'sha256'), 'hex') as value
          from private.member_account_lifecycle_secret secret
          where secret.id
        )
        insert into private.member_account_deletions (
          subject_hash, subject_hash_key_fingerprint, token_hash, status,
          expires_at, claimed_at
        )
        select private.member_lifecycle_subject_hash(subjects.user_id),
          fingerprint.value, repeat('a', 64), 'processing',
          pg_catalog.now() + interval '5 minutes', pg_catalog.now()
        from subjects cross join fingerprint
        returning subject_hash
      `, [fixtureCount])).rows.map((row) => row.subject_hash);
    } finally {
      await pgClient.query("set session_replication_role = origin");
    }
    assert(inserted.length === fixtureCount, `concurrent reconciliation fixture expected ${fixtureCount} requests`);

    const counts = await Promise.all([
      reconcileWorker("account-deletion-concurrent-a"),
      reconcileWorker("account-deletion-concurrent-b"),
    ]);
    assert(counts.every((count) => Number.isInteger(count) && count >= 0 && count <= 25),
      `each concurrent reconciliation must honor the 25-row cap: ${JSON.stringify(counts)}`);
    assert(counts.reduce((total, count) => total + count, 0) === fixtureCount,
      `concurrent reconciliation must claim disjoint work: ${JSON.stringify(counts)}`);

    const state = (await pgClient.query(`
      select
        pg_catalog.count(*) filter (where request.status = 'completed')::int as completed,
        pg_catalog.count(audit.id)::int as completion_events,
        pg_catalog.count(distinct audit.subject_hash)::int as distinct_completion_subjects
      from private.member_account_deletions request
      left join private.member_account_lifecycle_audit audit
        on audit.subject_hash = request.subject_hash
       and audit.event_type = 'deletion_completed'
      where request.subject_hash = any($1::text[])
    `, [inserted])).rows[0];
    assert(state.completed === fixtureCount
        && state.completion_events === fixtureCount
        && state.distinct_completion_subjects === fixtureCount,
    `concurrent reconciliation must emit deletion_completed exactly once per request: ${JSON.stringify(state)}`);

    await pgClient.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role: "service_role" })]);
    await pgClient.query("set role service_role");
    const retry = (await pgClient.query(
      "select public.reconcile_pending_account_deletions(25) as value",
    )).rows[0].value;
    await pgClient.query("reset role");
    assert(retry === 0, "concurrent reconciliation retry must be idempotent and empty");
  } finally {
    await pgClient.query("reset role");
    await pgClient.query(
      "delete from private.member_account_lifecycle_audit where subject_hash = any($1::text[])",
      [inserted],
    );
    await pgClient.query(
      "delete from private.member_account_deletions where subject_hash = any($1::text[])",
      [inserted],
    );
  }
}
