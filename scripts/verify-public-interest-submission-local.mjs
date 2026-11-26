import { readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import process from "node:process";
import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";

const { Client } = pg;
const databaseUrl = assertDisposableProofUrl(requireDatabaseUrl("SUPABASE_DB_URL", { aliases: ["DATABASE_URL"] }));
const sourceUrl = new URL(databaseUrl);

const original = readFileSync(
  "supabase/migrations/20260812130000_public_site_content_and_interest.sql",
  "utf8",
);
const guard = readFileSync(
  "supabase/migrations/20260813202500_public_interest_submission_guard.sql",
  "utf8",
);
const guardFollowup = readFileSync(
  "supabase/migrations/20260813210000_public_interest_submission_guard_followup.sql",
  "utf8",
);
const contractDrop = readFileSync(
  "supabase/migrations/20260817000245_public_interest_compat_contract_drop.sql",
  "utf8",
);
const suppression = readFileSync(
  "supabase/migrations/20260831105356_public_interest_suppression.sql",
  "utf8",
);
const scratchName = `public_interest_verify_${process.pid}`;
if (!/^public_interest_verify_\d+$/.test(scratchName)) throw new Error("unsafe scratch database name");
const scratchUrl = new URL(sourceUrl);
scratchUrl.pathname = `/${scratchName}`;

const bootstrap = `
  create schema auth;
  create schema extensions;
  create schema private;
  create extension pgcrypto with schema extensions;
  create schema vault;
  create table vault.secrets (
    id uuid primary key default extensions.gen_random_uuid(),
    name text unique,
    description text,
    secret text not null
  );
  create view vault.decrypted_secrets as
    select id, name, description, secret as decrypted_secret
    from vault.secrets;
  create function vault.create_secret(
    new_secret text,
    new_name text default null,
    new_description text default null
  ) returns uuid
  language plpgsql
  as $$
  declare created_id uuid;
  begin
    insert into vault.secrets (name, description, secret)
    values (new_name, new_description, new_secret)
    returning id into created_id;
    return created_id;
  end;
  $$;
  create table auth.users (id uuid primary key);
  create function auth.jwt() returns jsonb language sql stable set search_path = '' as $$
    select coalesce(nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
  $$;
  create function auth.uid() returns uuid language sql stable set search_path = '' as $$
    select nullif(auth.jwt() ->> 'sub', '')::uuid
  $$;
  create function private.mfa_satisfied() returns boolean language sql stable security definer set search_path = '' as $$
    select auth.jwt() ->> 'aal' = 'aal2'
  $$;
  create function public.member_has_role(text[]) returns boolean
  language sql stable security definer set search_path = '' as $$ select false $$;
`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function scope(value) {
  return value.repeat(64).slice(0, 64);
}

function emailScope(email, interest = "chapter_updates") {
  return createHmac("sha256", "local-public-interest-proof-secret")
    .update(`public-interest-email-v1:${email.trim().toLowerCase()}\u001f${interest}`)
    .digest("hex");
}

function stopEmailScope(email) {
  return createHmac("sha256", "local-public-interest-proof-secret")
    .update(`public-interest-stop-email-v1:${email.trim().toLowerCase()}`)
    .digest("hex");
}

function suppressionScope(email, secret) {
  return createHmac("sha256", secret)
    .update(`public-interest-suppression-v1:${email.trim().toLowerCase()}`)
    .digest("hex");
}

async function call(client, values) {
  const result = await client.query(`
    select public.submit_public_interest($1, $2, $3, $4, $5, $6, $7, $8) as payload
  `, [
    values.email,
    values.name ?? "Proof Member",
    values.interest === undefined ? "chapter_updates" : values.interest,
    values.locale ?? "en",
    "public-landing",
    values.website ?? "",
    values.scopeHash,
    values.emailScopeHash ?? emailScope(values.email, values.interest),
  ]);
  return result.rows[0].payload;
}

async function stop(client, values) {
  const result = await client.query(`
    select public.stop_public_interest($1, $2, $3, $4, $5, $6) as payload
  `, [
    values.email,
    values.locale ?? "en",
    "public-landing",
    values.website ?? "",
    values.scopeHash,
    values.emailScopeHash ?? stopEmailScope(values.email),
  ]);
  return result.rows[0].payload;
}

async function waitForAdvisoryWait(inspector, applicationName) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await inspector.query(`
      select wait_event
      from pg_catalog.pg_stat_activity
      where application_name = $1
    `, [applicationName]);
    if (result.rows[0]?.wait_event === "advisory") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("concurrent submission did not reach the email advisory lock");
}

async function waitForCompletionOrRowLock(inspector, applicationName, outcome) {
  let completed = false;
  outcome.then(() => { completed = true; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (completed) return "completed";
    const result = await inspector.query(`
      select wait_event_type, wait_event
      from pg_catalog.pg_stat_activity
      where application_name = $1
    `, [applicationName]);
    if (result.rows[0]?.wait_event_type === "Lock"
        && result.rows[0]?.wait_event !== "advisory") return "row-lock";
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("submission neither completed nor reached a row-lock wait");
}

const sourceAdmin = new Client({ connectionString: databaseUrl, application_name: "public-interest-proof-source" });
const connections = [];
let created = false;

try {
  await sourceAdmin.connect();
  await sourceAdmin.query(`create database ${scratchName} template template0`);
  created = true;

  const admin = new Client({ connectionString: scratchUrl.toString(), application_name: "public-interest-proof-admin" });
  const service = new Client({ connectionString: scratchUrl.toString(), application_name: "public-interest-proof-service" });
  const anonymous = new Client({ connectionString: scratchUrl.toString(), application_name: "public-interest-proof-anon" });
  const deadlockHolder = new Client({ connectionString: scratchUrl.toString(), application_name: "public-interest-proof-deadlock-holder" });
  const deadlockSubmitter = new Client({ connectionString: scratchUrl.toString(), application_name: "public-interest-proof-deadlock-submitter" });
  const deadlockHolderTwo = new Client({ connectionString: scratchUrl.toString(), application_name: "public-interest-proof-deadlock-holder-two" });
  const deadlockSubmitterTwo = new Client({ connectionString: scratchUrl.toString(), application_name: "public-interest-proof-deadlock-submitter-two" });
  connections.push(admin, service, anonymous, deadlockHolder, deadlockSubmitter, deadlockHolderTwo, deadlockSubmitterTwo);
  await Promise.all(connections.map((client) => client.connect()));
  await admin.query(bootstrap);
  await admin.query(original);
  await admin.query(guard);
  await admin.query(guardFollowup);
  await admin.query(contractDrop);
  await admin.query(suppression);

  const suppressionSecret = (await admin.query(`
    select decrypted_secret
    from vault.decrypted_secrets
    where name = 'public-interest-suppression-v1'
  `)).rows[0]?.decrypted_secret;
  assert(typeof suppressionSecret === "string" && suppressionSecret.length >= 32,
    "migration did not create a private Vault suppression key");

  await service.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role: "service_role" })]);
  await service.query("set role service_role");
  await anonymous.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role: "anon" })]);
  await anonymous.query("set role anon");
  await deadlockHolder.query("set statement_timeout = '5s'");
  await deadlockHolder.query("set deadlock_timeout = '100ms'");
  await deadlockSubmitter.query("set statement_timeout = '5s'");
  await deadlockSubmitter.query("set deadlock_timeout = '100ms'");
  await deadlockSubmitter.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role: "service_role" })]);
  await deadlockSubmitter.query("set role service_role");
  await deadlockHolderTwo.query("set statement_timeout = '5s'");
  await deadlockHolderTwo.query("set deadlock_timeout = '100ms'");
  await deadlockSubmitterTwo.query("set statement_timeout = '5s'");
  await deadlockSubmitterTwo.query("set deadlock_timeout = '100ms'");
  await deadlockSubmitterTwo.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role: "service_role" })]);
  await deadlockSubmitterTwo.query("set role service_role");

  const servicePrivileges = (await admin.query(`
    select
      has_function_privilege('anon', 'public.submit_public_interest(text,text,text,text,text,text,text,text)', 'execute') as submit_anon,
      has_function_privilege('authenticated', 'public.submit_public_interest(text,text,text,text,text,text,text,text)', 'execute') as submit_authenticated,
      has_function_privilege('service_role', 'public.submit_public_interest(text,text,text,text,text,text,text,text)', 'execute') as submit_service,
      has_function_privilege('anon', 'public.stop_public_interest(text,text,text,text,text,text)', 'execute') as stop_anon,
      has_function_privilege('authenticated', 'public.stop_public_interest(text,text,text,text,text,text)', 'execute') as stop_authenticated,
      has_function_privilege('service_role', 'public.stop_public_interest(text,text,text,text,text,text)', 'execute') as stop_service,
      has_function_privilege('service_role', 'private.public_interest_suppression_scope(text)', 'execute') as scope_service
  `)).rows[0];
  assert(servicePrivileges.submit_anon === false, "anon has execute privilege on the submit service overload");
  assert(servicePrivileges.submit_authenticated === false, "authenticated has execute privilege on the submit service overload");
  assert(servicePrivileges.submit_service === true, "service_role lacks execute privilege on the submit service overload");
  assert(servicePrivileges.stop_anon === false, "anon has execute privilege on the stop RPC");
  assert(servicePrivileges.stop_authenticated === false, "authenticated has execute privilege on the stop RPC");
  assert(servicePrivileges.stop_service === true, "service_role lacks execute privilege on the stop RPC");
  assert(servicePrivileges.scope_service === false, "service_role has direct execute on the private suppression helper");

  const suppressionColumns = (await admin.query(`
    select column_name
    from information_schema.columns
    where table_schema = 'private' and table_name = 'public_interest_suppressions'
    order by ordinal_position
  `)).rows.map((row) => row.column_name);
  assert(suppressionColumns.includes("suppression_scope_hash"), "suppression ledger lacks its digest key");
  assert(!suppressionColumns.includes("email"), "suppression ledger retains raw email");

  const websiteScope = scope("a");
  const website = await call(service, {
    email: "website-trap@example.org",
    website: "bot-site",
    scopeHash: websiteScope,
  });
  assert(website?.accepted === true, "database honeypot response was not uniform");
  const websiteEffects = (await admin.query(`
    select
      (select count(*)::int from public.public_interest_submissions
       where email = 'website-trap@example.org') as submissions,
      (select count(*)::int from private.public_interest_submission_limits
       where scope_hash = $1) as limits
  `, [websiteScope])).rows[0];
  assert(websiteEffects.submissions === 0, "database honeypot created a submission");
  assert(websiteEffects.limits === 0, "database honeypot consumed a limiter bucket");

  const first = await call(service, {
    email: "owner@example.org",
    name: "Original Owner",
    locale: "en",
    scopeHash: scope("1"),
  });
  assert(first?.accepted === true, "first-time submission was not accepted");
  await admin.query(`
    update public.public_interest_submissions
    set name = 'Original Owner', locale = 'en', status = 'contacted',
        consent_at = '2026-08-01T12:00:00Z', last_submitted_at = '2026-08-02T12:00:00Z'
    where email = 'owner@example.org' and interest = 'chapter_updates'
  `);

  const before = (await admin.query(`
    select name, locale, source, status, consent_at, last_submitted_at, created_at
    from public.public_interest_submissions
    where email = 'owner@example.org' and interest = 'chapter_updates'
  `)).rows[0];
  assert(before !== undefined, "first-time submission did not create a row");
  const firstCount = (await admin.query(`
    select count(*)::int as count
    from public.public_interest_submissions
    where email = 'owner@example.org' and interest = 'chapter_updates'
  `)).rows[0].count;
  assert(firstCount === 1, `first-time submission created ${firstCount} rows instead of one`);
  const duplicate = await call(service, {
    email: " OWNER@example.org ",
    name: "Anonymous Rewrite",
    locale: "es",
    scopeHash: scope("1"),
  });
  const after = (await admin.query(`
    select name, locale, source, status, consent_at, last_submitted_at, created_at
    from public.public_interest_submissions
    where email = 'owner@example.org' and interest = 'chapter_updates'
  `)).rows[0];
  assert(duplicate?.accepted === true, "duplicate response differed from first-time response");
  assert(JSON.stringify(after) === JSON.stringify(before), "duplicate submission mutated existing workflow state");

  const stoppedEmail = "durable-stop@example.org";
  await call(service, { email: stoppedEmail, scopeHash: scope("6") });
  const stopped = await stop(service, { email: stoppedEmail, scopeHash: scope("7") });
  assert(stopped?.accepted === true, "valid stop request was not accepted");
  const stoppedSuppressionScope = suppressionScope(stoppedEmail, suppressionSecret);
  const plainStoppedDigest = createHash("sha256")
    .update(`public-interest-suppression-v1:${stoppedEmail}`)
    .digest("hex");
  assert(stoppedSuppressionScope !== plainStoppedDigest,
    "Vault-keyed suppression scope degraded to a predictable plain digest");
  const suppressionRow = (await admin.query(`
    select suppression_scope_hash
    from private.public_interest_suppressions
    where suppression_scope_hash = $1
  `, [stoppedSuppressionScope])).rows[0];
  assert(suppressionRow?.suppression_scope_hash === stoppedSuppressionScope,
    "stop did not persist its Vault-keyed pseudonymous digest");
  await call(service, {
    email: stoppedEmail,
    interest: "union_news",
    scopeHash: scope("0"),
  });
  const stoppedRows = (await admin.query(`
    select count(*)::int as count
    from public.public_interest_submissions
    where email = $1
  `, [stoppedEmail])).rows[0].count;
  assert(stoppedRows === 0, "a later public submit recreated a suppressed address");

  const networkScope = scope("2");
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const result = await call(service, {
      email: `network-${attempt}@example.org`,
      scopeHash: networkScope,
    });
    assert(result?.accepted === true, `network attempt ${attempt} was not uniform`);
  }
  const limited = await call(service, {
    email: "network-21@example.org",
    scopeHash: networkScope,
  });
  assert(limited?.accepted === true, "rate-limit response disclosed exhaustion");
  const limitedRow = (await admin.query(`
    select count(*)::int as count
    from public.public_interest_submissions
    where email = 'network-21@example.org'
  `)).rows[0].count;
  assert(limitedRow === 0, "network limit exhaustion still created a submission");
  const networkCount = (await admin.query(`
    select request_count from private.public_interest_submission_limits
    where scope_hash = $1 and operation = 'network-15m'
  `, [networkScope])).rows[0]?.request_count;
  assert(networkCount === 20, `network limiter advanced past its cap: ${networkCount}`);

  const invalidScope = scope("f");
  const invalidPruneScope = scope("8");
  await admin.query(`
    insert into private.public_interest_submission_limits
      (scope_hash, operation, window_started_at, request_count)
    values ($1, 'network-15m', clock_timestamp() - interval '3 days', 20)
  `, [invalidPruneScope]);
  const invalid = await call(service, { email: "not-an-email", scopeHash: invalidScope });
  assert(invalid?.accepted === true, "invalid input disclosed validation state");
  const invalidCount = (await admin.query(`
    select request_count from private.public_interest_submission_limits
    where scope_hash = $1 and operation = 'network-15m'
  `, [invalidScope])).rows[0]?.request_count;
  assert(invalidCount === 1, "invalid input rolled back its durable network allowance");
  const invalidRow = (await admin.query(`
    select count(*)::int as count from public.public_interest_submissions
    where email = 'not-an-email'
  `)).rows[0].count;
  assert(invalidRow === 0, "invalid input created a submission row");
  const invalidStaleCount = (await admin.query(`
    select count(*)::int as count from private.public_interest_submission_limits
    where scope_hash = $1
  `, [invalidPruneScope])).rows[0].count;
  assert(invalidStaleCount === 0, "invalid input bypassed terminal stale pruning");

  const nullInterestScope = scope("e");
  const nullInterest = await call(service, {
    email: "null-interest@example.org",
    interest: null,
    scopeHash: nullInterestScope,
    emailScopeHash: scope("0"),
  });
  assert(nullInterest?.accepted === true, "null interest response was not uniform");
  const nullInterestEffects = (await admin.query(`
    select
      (select request_count from private.public_interest_submission_limits
       where scope_hash = $1 and operation = 'network-15m') as request_count,
      (select count(*)::int from public.public_interest_submissions
       where email = 'null-interest@example.org') as submissions
  `, [nullInterestScope])).rows[0];
  assert(nullInterestEffects.request_count === 1, "null interest rolled back its network allowance");
  assert(nullInterestEffects.submissions === 0, "null interest created a submission");

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await call(service, {
      email: "email-cap@example.org",
      scopeHash: String(attempt + 3).repeat(64).slice(0, 64),
    });
  }
  const emailCount = (await admin.query(`
    select request_count
    from private.public_interest_submission_limits
    where operation = 'email-interest-day'
      and scope_hash = $1
  `, [emailScope("email-cap@example.org")])).rows[0]?.request_count;
  assert(emailCount === 3, `email-interest limiter advanced past its cap: ${emailCount}`);

  await admin.query(`
    insert into private.public_interest_submission_limits
      (scope_hash, operation, window_started_at, request_count)
    select pg_catalog.lpad(pg_catalog.to_hex(stale), 64, '0'),
           'network-15m', clock_timestamp() - interval '3 days', 20
    from pg_catalog.generate_series(1, 250) as stale
  `);
  await call(service, { email: "retention-proof@example.org", scopeHash: scope("9") });
  const staleCount = (await admin.query(`
    select count(*)::int as count
    from private.public_interest_submission_limits
    where window_started_at < clock_timestamp() - interval '2 days'
  `)).rows[0].count;
  assert(staleCount === 50, `stale limiter pruning was not capped at 200 rows: ${staleCount} remained`);

  const concurrentEmail = "deadlock-proof@example.org";
  const concurrentEmailScope = emailScope(concurrentEmail);
  await admin.query(`
    insert into private.public_interest_submission_limits
      (scope_hash, operation, window_started_at, request_count)
    values ($1, 'email-interest-day', clock_timestamp() - interval '3 days', 1)
  `, [concurrentEmailScope]);
  await deadlockHolder.query("begin");
  try {
    await deadlockHolder.query(`
      select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'public-interest-rate:email-interest-day:' || $1,
          509
        )
      )
    `, [concurrentEmailScope]);
    const concurrentSubmission = call(deadlockSubmitter, {
      email: concurrentEmail,
      scopeHash: scope("d"),
      emailScopeHash: concurrentEmailScope,
    }).then(
      (payload) => ({ payload }),
      (error) => ({ error }),
    );
    await waitForAdvisoryWait(admin, "public-interest-proof-deadlock-submitter");
    const heldScope = await deadlockHolder.query(`
      select private.consume_public_interest_submission_limit(
        $1, 'email-interest-day', 3, interval '1 day'
      ) as allowed
    `, [concurrentEmailScope]);
    assert(heldScope.rows[0]?.allowed === true, "held email scope was not refreshed");
    await deadlockHolder.query("commit");
    const concurrentResult = await concurrentSubmission;
    if (concurrentResult.error) throw concurrentResult.error;
    assert(concurrentResult.payload?.accepted === true, "concurrent submission was not accepted");
  } finally {
    await deadlockHolder.query("rollback").catch(() => {});
  }

  const racingEmail = "atomic-stop@example.org";
  const racingSuppressionScope = suppressionScope(racingEmail, suppressionSecret);
  await deadlockHolder.query("begin");
  try {
    await deadlockHolder.query(`
      select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('public-interest-suppression:' || $1, 509)
      )
    `, [racingSuppressionScope]);
    const racingStop = stop(deadlockSubmitter, {
      email: racingEmail,
      scopeHash: scope("4"),
    }).then((payload) => ({ payload }), (error) => ({ error }));
    await waitForAdvisoryWait(admin, "public-interest-proof-deadlock-submitter");
    const racingSubmit = call(deadlockSubmitterTwo, {
      email: racingEmail,
      scopeHash: scope("5"),
    }).then((payload) => ({ payload }), (error) => ({ error }));
    await waitForAdvisoryWait(admin, "public-interest-proof-deadlock-submitter-two");
    await deadlockHolder.query("commit");
    const [stopResult, submitResult] = await Promise.all([racingStop, racingSubmit]);
    if (stopResult.error) throw stopResult.error;
    if (submitResult.error) throw submitResult.error;
    assert(stopResult.payload?.accepted === true, "racing stop request failed");
    assert(submitResult.payload?.accepted === true, "racing submit response was not uniform");
  } finally {
    await deadlockHolder.query("rollback").catch(() => {});
  }
  const racingState = (await admin.query(`
    select
      (select count(*)::int from public.public_interest_submissions where email = $1) as submissions,
      (select count(*)::int from private.public_interest_suppressions where suppression_scope_hash = $2) as suppressions
  `, [racingEmail, racingSuppressionScope])).rows[0];
  assert(racingState.submissions === 0, "stop/submit contention left a resubscribed row");
  assert(racingState.suppressions === 1, "stop/submit contention lost the suppression record");

  const crossEmailOne = "cross-deadlock-one@example.org";
  const crossEmailTwo = "cross-deadlock-two@example.org";
  const crossScopeOne = emailScope(crossEmailOne);
  const crossScopeTwo = emailScope(crossEmailTwo);
  await admin.query(`
    insert into private.public_interest_submission_limits
      (scope_hash, operation, window_started_at, request_count)
    values
      ($1, 'email-interest-day', clock_timestamp() - interval '3 days', 1),
      ($2, 'email-interest-day', clock_timestamp() - interval '3 days', 1)
  `, [crossScopeOne, crossScopeTwo]);
  await Promise.all([
    deadlockHolder.query("begin"),
    deadlockHolderTwo.query("begin"),
  ]);
  try {
    await Promise.all([
      deadlockHolder.query(`
        select pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(
            'public-interest-rate:email-interest-day:' || $1,
            509
          )
        )
      `, [crossScopeOne]),
      deadlockHolderTwo.query(`
        select pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(
            'public-interest-rate:email-interest-day:' || $1,
            509
          )
        )
      `, [crossScopeTwo]),
    ]);
    const crossSubmissionOne = call(deadlockSubmitter, {
      email: crossEmailOne,
      scopeHash: scope("b"),
      emailScopeHash: crossScopeOne,
    }).then(
      (payload) => ({ payload }),
      (error) => ({ error }),
    );
    const crossSubmissionTwo = call(deadlockSubmitterTwo, {
      email: crossEmailTwo,
      scopeHash: scope("c"),
      emailScopeHash: crossScopeTwo,
    }).then(
      (payload) => ({ payload }),
      (error) => ({ error }),
    );
    await Promise.all([
      waitForAdvisoryWait(admin, "public-interest-proof-deadlock-submitter"),
      waitForAdvisoryWait(admin, "public-interest-proof-deadlock-submitter-two"),
    ]);
    await deadlockHolder.query("commit");
    await waitForCompletionOrRowLock(
      admin,
      "public-interest-proof-deadlock-submitter",
      crossSubmissionOne,
    );
    await deadlockHolderTwo.query("commit");
    const [crossResultOne, crossResultTwo] = await Promise.all([
      crossSubmissionOne,
      crossSubmissionTwo,
    ]);
    if (crossResultOne.error) throw crossResultOne.error;
    if (crossResultTwo.error) throw crossResultTwo.error;
    assert(crossResultOne.payload?.accepted === true, "first cross-scope submission was not accepted");
    assert(crossResultTwo.payload?.accepted === true, "second cross-scope submission was not accepted");
  } finally {
    await Promise.allSettled([
      deadlockHolder.query("rollback"),
      deadlockHolderTwo.query("rollback"),
    ]);
  }

  let anonymousDenied = false;
  try {
    await call(anonymous, {
      email: "anonymous@example.org",
      scopeHash: scope("a"),
    });
  } catch (error) {
    anonymousDenied = error?.code === "42501";
  }
  assert(anonymousDenied, "anon retained direct execute access to the submission RPC");

  let sixArgumentSignatureAbsent = false;
  try {
    await admin.query(`select public.submit_public_interest('', '', '', '', '', '')`);
  } catch (error) {
    sixArgumentSignatureAbsent = error?.code === "42883";
  }
  assert(sixArgumentSignatureAbsent, "the six-argument compatibility RPC signature still resolves");

  let sevenArgumentSignatureAbsent = false;
  try {
    await admin.query(`select public.submit_public_interest('', '', '', '', '', '', '')`);
  } catch (error) {
    sevenArgumentSignatureAbsent = error?.code === "42883";
  }
  assert(sevenArgumentSignatureAbsent, "the unkeyed seven-argument RPC signature still resolves");

  let nineArgumentSignatureAbsent = false;
  try {
    await admin.query(`select public.submit_public_interest('', '', '', '', '', '', '', '', '')`);
  } catch (error) {
    nineArgumentSignatureAbsent = error?.code === "42883";
  }
  assert(nineArgumentSignatureAbsent, "the caller-supplied suppression digest overload still resolves");

  let sevenArgumentStopSignatureAbsent = false;
  try {
    await admin.query(`select public.stop_public_interest('', '', '', '', '', '', '')`);
  } catch (error) {
    sevenArgumentStopSignatureAbsent = error?.code === "42883";
  }
  assert(sevenArgumentStopSignatureAbsent, "the caller-supplied stop suppression digest overload still resolves");

  console.log("PASS: public-interest submit/stop contract (Vault-keyed pseudonymous ledger, service privilege isolation, durable no-resubscribe, atomic stop/submit contention, honeypot no-work, duplicate no-mutation, durable rate caps, bounded pruning, deadlock avoidance, and caller-supplied digest overloads absent)");
} finally {
  await Promise.allSettled(connections.map((client) => client.end()));
  if (created) {
    try { await sourceAdmin.query(`drop database ${scratchName} with (force)`); } catch { /* reported by the main failure */ }
  }
  await sourceAdmin.end().catch(() => {});
}
