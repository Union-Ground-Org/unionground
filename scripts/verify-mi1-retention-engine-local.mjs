import { readFile } from "node:fs/promises";
import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";

import {
  RETENTION_SCHEMA_RESET_SQL,
  classifyRetentionSchemaState,
  recordedMigrationMatches,
} from "./lib/retention-schema-mode.mjs";

const { Client } = pg;
const databaseUrl = assertDisposableProofUrl(requireDatabaseUrl("SUPABASE_DB_URL", { aliases: ["DATABASE_URL"] }));

const migration = await readFile(
  new URL("../supabase/migrations/20260830180000_mi1_retention_engine.sql", import.meta.url),
  "utf8",
);
const migrationVersion = "20260830180000";
const migrationName = "mi1_retention_engine";
const ids = {
  admin: "50910400-0000-4000-8000-000000000001",
  foreignAdmin: "50910400-0000-4000-8000-000000000002",
  organization: "50910400-0000-4000-8000-000000000101",
  foreignOrganization: "50910400-0000-4000-8000-000000000102",
  // private.mfa_satisfied() has required a live auth.sessions row bound to the
  // JWT's session_id since 20260901153738_mfa_reset_session_boundary.sql, which
  // landed after this proof was last touched. Without one the admin fixture can
  // never satisfy private.assert_retention_admin.
  adminSession: "50910400-0000-4000-8000-000000000201",
  foreignAdminSession: "50910400-0000-4000-8000-000000000202",
};
const sessions = {
  "50910400-0000-4000-8000-000000000001": "50910400-0000-4000-8000-000000000201",
  "50910400-0000-4000-8000-000000000002": "50910400-0000-4000-8000-000000000202",
};

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function asUser(client, userId, aal = "aal2") {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
    sub: userId,
    role: "authenticated",
    aal,
    session_id: sessions[userId],
  })]);
  await client.query("set local role authenticated");
}

async function expectCode(client, label, code, work) {
  await client.query(`savepoint ${label}`);
  try {
    await work();
    throw new Error(`${label} unexpectedly succeeded`);
  } catch (error) {
    if (error.code !== code) throw error;
  } finally {
    await client.query(`rollback to savepoint ${label}`);
  }
}

// BUG-UG-AI-RETENTION-CASCADE-BATCH-COUNT-20261010. The AI
// conversation class arrived in 20261003050000, and prepareRetentionSchema()
// below rebuilds the 20260830180000 generation of the engine — five classes,
// no assistant history — so the five-class proof can never reach this one.
// This phase therefore runs first, against the worker the migration history
// actually left in place, and rolls itself back to a savepoint before the
// rebuild starts.
//
// The defect: the branch deleted up to 5,000 expired messages, then up to
// 5,000 expired threads "with no RECENT message". A conversation whose expired
// messages did not all fit in the message statement still qualified as a
// thread candidate, and public.member_guide_messages.thread_id is
// `on delete cascade` (20260721000709), so the leftovers were destroyed past
// the 5,000-row bound and outside the number the run reports as deletedCount.
const AI_CLASS = "ai_assistant_conversations";
const AI_DAYS = 90;
const AI_BUDGET = 5000;
const AI_BIG_THREAD_MESSAGES = 6000;
const aiIds = {
  admin: "50910401-0000-4000-8000-000000000001",
  foreignAdmin: "50910401-0000-4000-8000-000000000002",
  organization: "50910401-0000-4000-8000-000000000101",
  foreignOrganization: "50910401-0000-4000-8000-000000000102",
  adminSession: "50910401-0000-4000-8000-000000000201",
  foreignAdminSession: "50910401-0000-4000-8000-000000000202",
  bigThread: "50910401-0000-4000-8000-000000000301",
  emptyThread: "50910401-0000-4000-8000-000000000302",
  recentThread: "50910401-0000-4000-8000-000000000303",
  foreignThread: "50910401-0000-4000-8000-000000000304",
};
sessions[aiIds.admin] = aiIds.adminSession;
sessions[aiIds.foreignAdmin] = aiIds.foreignAdminSession;

// Physical rows, counted directly rather than inferred from what the run
// reported — the whole defect was a gap between the two.
//
// Counted with the role reset, never as the admin the run is executed as. The
// first draft of this phase counted as that admin and the second
// organization's rows read 0 through member_guide_threads_select_own and
// guide_history_organization_scope: an isolation assertion that passes because
// RLS hid the rows it was supposed to find alive. The caller's session is
// restored before returning so the surrounding typed-gate calls keep working.
async function aiPhysicalCounts(client, restoreUser = null) {
  await client.query("reset role");
  const counts = (await client.query(`
    select
      (select pg_catalog.count(*) from public.member_guide_messages where organization_id = $1)::integer as messages,
      (select pg_catalog.count(*) from public.member_guide_threads where organization_id = $1)::integer as threads,
      (select pg_catalog.count(*) from public.member_guide_messages where organization_id = $2)::integer as foreign_messages,
      (select pg_catalog.count(*) from public.member_guide_threads where organization_id = $2)::integer as foreign_threads
  `, [aiIds.organization, aiIds.foreignOrganization])).rows[0];
  if (restoreUser) await asUser(client, restoreUser);
  return counts;
}

async function executeAiRun(client, label) {
  const before = await aiPhysicalCounts(client, aiIds.admin);
  const preview = (await client.query(
    "select public.preview_organization_retention_run($1) as value", [AI_CLASS],
  )).rows[0].value;
  await client.query(
    "select public.authorize_organization_retention_run($1, $2)",
    [preview.id, `AUTHORIZE ${AI_CLASS}`],
  );
  const run = (await client.query(
    "select public.execute_organization_retention_run($1) as value", [preview.id],
  )).rows[0].value;
  assert(run.status === "completed", `${label}: run did not complete (${run.status}/${run.failureCode})`);
  const after = await aiPhysicalCounts(client, aiIds.admin);
  const physical = (before.messages - after.messages) + (before.threads - after.threads);
  // The bound is on the execution, not on one statement inside it.
  assert(physical <= AI_BUDGET,
    `${label}: one execution physically deleted ${physical} rows, past the ${AI_BUDGET}-row budget`);
  // deletedCount is what the admin history and the audit ledger report.
  assert(run.deletedCount === physical,
    `${label}: reported deletedCount ${run.deletedCount} but physically deleted ${physical}`);
  // eligible = deleted + remaining, or the continuation cannot be trusted.
  assert(preview.eligibleCount === run.deletedCount + run.remainingCount,
    `${label}: eligible ${preview.eligibleCount} <> deleted ${run.deletedCount} + remaining ${run.remainingCount}`);
  return { preview, run, before, after, physical };
}

async function proveAiConversationRetention(client) {
  await client.query("savepoint ai_conversation_retention");
  try {
    await client.query(`
      insert into auth.users (id, email) values
        ($1, 'ai-retention-admin@example.invalid'),
        ($2, 'ai-retention-foreign-admin@example.invalid')
    `, [aiIds.admin, aiIds.foreignAdmin]);
    await client.query(`
      insert into public.organizations (id, slug, name, created_by) values
        ($1, 'ai-retention-proof-a', 'AI Retention Proof A', $3),
        ($2, 'ai-retention-proof-b', 'AI Retention Proof B', $4)
    `, [aiIds.organization, aiIds.foreignOrganization, aiIds.admin, aiIds.foreignAdmin]);
    await client.query(`
      insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values
        ('ai-retention-proof-a', 'AI Retention Proof A', 'ai-retention-proof-a', true, 1, $1),
        ('ai-retention-proof-b', 'AI Retention Proof B', 'ai-retention-proof-b', true, 1, $2)
    `, [aiIds.organization, aiIds.foreignOrganization]);
    await client.query(`
      insert into public.organization_memberships (organization_id, user_id, status) values
        ($1, $2, 'active'), ($3, $4, 'active')
    `, [aiIds.organization, aiIds.admin, aiIds.foreignOrganization, aiIds.foreignAdmin]);
    await client.query(`
      insert into public.member_chapter_memberships (user_id, chapter_id, status) values
        ($1, 'ai-retention-proof-a', 'active'),
        ($2, 'ai-retention-proof-b', 'active')
    `, [aiIds.admin, aiIds.foreignAdmin]);
    await client.query(`
      update public.member_profiles
      set chapter_id = case id when $1::uuid then 'ai-retention-proof-a' else 'ai-retention-proof-b' end
      where id = any($2::uuid[])
    `, [aiIds.admin, [aiIds.admin, aiIds.foreignAdmin]]);
    await client.query(`
      insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values
        ($1, $2, 'admin', $2), ($3, $4, 'admin', $4)
    `, [aiIds.organization, aiIds.admin, aiIds.foreignOrganization, aiIds.foreignAdmin]);
    await client.query(`
      insert into auth.sessions (id, user_id, aal, created_at) values
        ($1, $2, 'aal2', now()), ($3, $4, 'aal2', now())
    `, [aiIds.adminSession, aiIds.admin, aiIds.foreignAdminSession, aiIds.foreignAdmin]);
    await client.query(`
      insert into auth.mfa_factors
        (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
      select extensions.gen_random_uuid(), id, 'ai-retention-proof', 'totp', 'verified', now(), now()
      from auth.users where id = any($1::uuid[])
    `, [[aiIds.admin, aiIds.foreignAdmin]]);

    // updated_at is written at INSERT: private.touch_updated_at fires BEFORE
    // UPDATE on this table and would stamp now() over any later correction.
    // All four threads are older than the window; what separates them is what
    // they hold.
    await client.query(`
      insert into public.member_guide_threads (id, user_id, title, created_at, updated_at) values
        ($1, $5, 'Expired conversation larger than one batch',
           pg_catalog.now() - interval '300 days', pg_catalog.now() - interval '300 days'),
        ($2, $5, 'Expired conversation with no messages left',
           pg_catalog.now() - interval '300 days', pg_catalog.now() - interval '300 days'),
        ($3, $5, 'Expired conversation still being used',
           pg_catalog.now() - interval '300 days', pg_catalog.now() - interval '300 days'),
        ($4, $6, 'Another organization''s expired conversation',
           pg_catalog.now() - interval '300 days', pg_catalog.now() - interval '300 days')
    `, [aiIds.bigThread, aiIds.emptyThread, aiIds.recentThread, aiIds.foreignThread,
      aiIds.admin, aiIds.foreignAdmin]);
    // More expired messages than one batch can take, and the oldest in the
    // tenant, so the first execution spends its whole budget inside this one
    // thread and leaves the rest of it behind.
    await client.query(`
      insert into public.member_guide_messages (thread_id, user_id, role, body, created_at)
      select $1, $2,
        case when series % 2 = 0 then 'assistant' else 'user' end,
        'expired turn ' || series::text,
        pg_catalog.now() - interval '300 days' + (series * interval '1 second')
      from pg_catalog.generate_series(1, $3::integer) series
    `, [aiIds.bigThread, aiIds.admin, AI_BIG_THREAD_MESSAGES]);
    // Expired messages in a thread that is still in use, plus the recent turn
    // that has to keep the thread row alive.
    await client.query(`
      insert into public.member_guide_messages (thread_id, user_id, role, body, created_at) values
        ($1, $2, 'user', 'expired question in a live conversation', pg_catalog.now() - interval '120 days'),
        ($1, $2, 'assistant', 'expired answer in a live conversation', pg_catalog.now() - interval '120 days'),
        ($1, $2, 'user', 'asked yesterday', pg_catalog.now() - interval '1 day')
    `, [aiIds.recentThread, aiIds.admin]);
    await client.query(`
      insert into public.member_guide_messages (thread_id, user_id, role, body, created_at) values
        ($1, $2, 'user', 'another organization''s expired question', pg_catalog.now() - interval '300 days'),
        ($1, $2, 'assistant', 'another organization''s expired answer', pg_catalog.now() - interval '300 days')
    `, [aiIds.foreignThread, aiIds.foreignAdmin]);

    const seeded = await aiPhysicalCounts(client);
    assert(seeded.messages === AI_BIG_THREAD_MESSAGES + 3 && seeded.threads === 3,
      `fixture did not land in the proof tenant: ${JSON.stringify(seeded)}`);
    assert(seeded.foreign_messages === 2 && seeded.foreign_threads === 1,
      `fixture did not land in the second organization: ${JSON.stringify(seeded)}`);

    await asUser(client, aiIds.admin);
    await client.query(
      "select public.upsert_organization_retention_policy($1, $2, true, $3)",
      [AI_CLASS, AI_DAYS, `ENABLE ${AI_CLASS}`],
    );

    // 6,002 expired messages, plus the two threads that will be empty once
    // they are gone. The thread still holding a recent turn is not eligible.
    const expiredMessages = AI_BIG_THREAD_MESSAGES + 2;
    const eligibleThreads = 2;
    const first = await executeAiRun(client, "first AI conversation execution");
    assert(first.preview.eligibleCount === expiredMessages + eligibleThreads,
      `preview counted ${first.preview.eligibleCount}, expected ${expiredMessages + eligibleThreads}`);
    assert(first.physical === AI_BUDGET,
      `first execution deleted ${first.physical} rows, expected the full ${AI_BUDGET}-row budget`);
    assert(first.after.foreign_messages === 2 && first.after.foreign_threads === 1,
      `first execution crossed the tenant boundary: ${JSON.stringify(first.after)}`);
    // The budget went entirely to messages, so no thread was touched. Under
    // the defect the oversized thread was deleted here instead and cascaded
    // its remaining 1,000 expired messages: 6,002 physical deletions reported
    // as 5,002, with remaining_count 0.
    assert(first.after.threads === 3,
      `first execution removed a thread that still held messages (${first.after.threads} of 3 left)`);
    assert(first.run.remainingCount === expiredMessages + eligibleThreads - AI_BUDGET,
      `first execution left remainingCount ${first.run.remainingCount}, expected ${expiredMessages + eligibleThreads - AI_BUDGET}`);

    const second = await executeAiRun(client, "continuation AI conversation execution");
    assert(second.run.remainingCount === 0,
      `continuation left ${second.run.remainingCount} eligible rows instead of finishing`);
    assert(second.after.threads === 1 && second.after.messages === 1,
      `continuation left ${second.after.threads} threads and ${second.after.messages} messages, expected 1 and 1`);
    // The survivor is the thread with the recent turn, and its recent turn.
    await client.query("reset role");
    const survivors = (await client.query(`
      select
        (select pg_catalog.count(*) from public.member_guide_threads
          where organization_id = $1 and id = $2)::integer as recent_thread,
        (select pg_catalog.count(*) from public.member_guide_messages
          where organization_id = $1
            and created_at >= pg_catalog.now() - pg_catalog.make_interval(days => $3::integer))::integer as recent_messages
    `, [aiIds.organization, aiIds.recentThread, AI_DAYS])).rows[0];
    assert(survivors.recent_thread === 1 && survivors.recent_messages === 1,
      `retention crossed the window boundary: ${JSON.stringify(survivors)}`);
    assert(second.after.foreign_messages === 2 && second.after.foreign_threads === 1,
      `retention crossed the tenant boundary: ${JSON.stringify(second.after)}`);

    const totals = {
      firstDeleted: first.run.deletedCount,
      firstRemaining: first.run.remainingCount,
      continuationDeleted: second.run.deletedCount,
    };
    console.log(`PASS: AI conversation retention stayed inside one ${AI_BUDGET}-row budget and counted every deleted row ${JSON.stringify(totals)}.`);
  } finally {
    await client.query("rollback to savepoint ai_conversation_retention");
  }
}

async function prepareRetentionSchema(client) {
  const state = (await client.query(`
    select
      to_regclass('public.organization_retention_policies') is not null as policies,
      to_regclass('public.organization_retention_runs') is not null as runs,
      to_regprocedure('public.get_organization_retention_engine()') is not null as reader,
      to_regprocedure('public.upsert_organization_retention_policy(text,integer,boolean,text)') is not null as upsert_policy,
      to_regprocedure('public.preview_organization_retention_run(text)') is not null as preview_run,
      to_regprocedure('public.authorize_organization_retention_run(uuid,text)') is not null as authorize_run,
      to_regprocedure('public.execute_organization_retention_run(uuid)') is not null as execute_run,
      to_regprocedure('private.run_due_organization_retention_jobs(integer)') is not null as scheduled_run,
      exists (
        select 1
        from supabase_migrations.schema_migrations
        where version = $1
      ) as migration_recorded,
      (
        select name
        from supabase_migrations.schema_migrations
        where version = $1
      ) as migration_name,
      (
        select statements
        from supabase_migrations.schema_migrations
        where version = $1
      ) as migration_statements
  `, [migrationVersion])).rows[0];
  state.migration_matches = recordedMigrationMatches({
    expectedName: migrationName,
    expectedSql: migration,
    recordedName: state.migration_name,
    recordedStatements: state.migration_statements,
  });
  const classification = classifyRetentionSchemaState(state);
  if (classification.resetExisting) {
    await client.query(RETENTION_SCHEMA_RESET_SQL);
  }
  if (classification.applyMigration) {
    await client.query(migration);
  }
  return classification.mode;
}

const client = new Client({ connectionString: databaseUrl, application_name: "retention-engine-proof" });
let open = false;
try {
  await client.connect();
  await client.query("begin");
  open = true;
  await proveAiConversationRetention(client);
  const schemaMode = await prepareRetentionSchema(client);

  await client.query(`
    insert into auth.users (id, email) values
      ($1, 'retention-admin@example.invalid'),
      ($2, 'retention-foreign-admin@example.invalid')
  `, [ids.admin, ids.foreignAdmin]);
  await client.query(`
    insert into public.organizations (id, slug, name, created_by) values
      ($1, 'retention-proof-a', 'Retention Proof A', $3),
      ($2, 'retention-proof-b', 'Retention Proof B', $4)
  `, [ids.organization, ids.foreignOrganization, ids.admin, ids.foreignAdmin]);
  await client.query(`
    insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values
      ('retention-proof-a', 'Retention Proof A', 'retention-proof-a', true, 1, $1),
      ('retention-proof-b', 'Retention Proof B', 'retention-proof-b', true, 1, $2)
  `, [ids.organization, ids.foreignOrganization]);
  await client.query(`
    insert into public.organization_memberships (organization_id, user_id, status) values
      ($1, $2, 'active'), ($3, $4, 'active')
  `, [ids.organization, ids.admin, ids.foreignOrganization, ids.foreignAdmin]);
  await client.query(`
    insert into public.member_chapter_memberships (user_id, chapter_id, status) values
      ($1, 'retention-proof-a', 'active'),
      ($2, 'retention-proof-b', 'active')
  `, [ids.admin, ids.foreignAdmin]);
  await client.query(`
    update public.member_profiles
    set chapter_id = case id when $1::uuid then 'retention-proof-a' else 'retention-proof-b' end
    where id = any($2::uuid[])
  `, [ids.admin, [ids.admin, ids.foreignAdmin]]);
  await client.query(`
    insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values
      ($1, $2, 'admin', $2), ($3, $4, 'admin', $4)
  `, [ids.organization, ids.admin, ids.foreignOrganization, ids.foreignAdmin]);
  await client.query(`
    insert into auth.sessions (id, user_id, aal, created_at) values
      ($1, $2, 'aal2', now()), ($3, $4, 'aal2', now())
  `, [ids.adminSession, ids.admin, ids.foreignAdminSession, ids.foreignAdmin]);
  await client.query(`
    insert into auth.mfa_factors
      (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    select extensions.gen_random_uuid(), id, 'retention-proof', 'totp', 'verified', now(), now()
    from auth.users where id = any($1::uuid[])
  `, [[ids.admin, ids.foreignAdmin]]);
  await client.query(`
    insert into public.organization_page_views (organization_id, path, hat, day, view_count) values
      ($1, '/target-old', 'admin', current_date - 200, 4),
      ($1, '/target-recent', 'admin', current_date - 2, 7),
      ($2, '/foreign-old', 'admin', current_date - 200, 9)
  `, [ids.organization, ids.foreignOrganization]);

  await asUser(client, ids.admin, "aal1");
  await expectCode(client, "mfa_denied", "42501", () => (
    client.query("select public.get_organization_retention_engine()")
  ));

  await asUser(client, ids.admin);
  const initial = (await client.query("select public.get_organization_retention_engine() as value")).rows[0].value;
  assert(initial.organizationId === ids.organization, "reader returned the wrong organization");
  assert(initial.policies.length === 5 && initial.policies.every((row) => row.configured === false),
    "empty organization should receive five unconfigured definitions, not seeded policies");
  await expectCode(client, "direct_write_denied", "42501", () => client.query(`
    insert into public.organization_retention_policies
      (organization_id, data_class, retention_days)
    values ($1, 'organization_page_views', 180)
  `, [ids.organization]));
  await expectCode(client, "enable_phrase_denied", "22023", () => client.query(
    "select public.upsert_organization_retention_policy('organization_page_views', 180, true, 'enable')",
  ));

  await client.query(
    "select public.upsert_organization_retention_policy('organization_page_views', 180, false, null)",
  );
  const dryRun = (await client.query(
    "select public.preview_organization_retention_run('organization_page_views') as value",
  )).rows[0].value;
  assert(dryRun.status === "previewed" && dryRun.eligibleCount === 1,
    "dry run must count only old rows in the caller organization");
  await expectCode(client, "disabled_authorization", "42501", () => client.query(
    "select public.authorize_organization_retention_run($1, 'AUTHORIZE organization_page_views')",
    [dryRun.id],
  ));

  await client.query(
    "select public.upsert_organization_retention_policy('organization_page_views', 180, true, 'ENABLE organization_page_views')",
  );
  const authorizedPreview = (await client.query(
    "select public.preview_organization_retention_run('organization_page_views') as value",
  )).rows[0].value;
  await expectCode(client, "authorize_phrase_denied", "22023", () => client.query(
    "select public.authorize_organization_retention_run($1, 'authorize organization_page_views')",
    [authorizedPreview.id],
  ));
  await client.query(
    "select public.authorize_organization_retention_run($1, 'AUTHORIZE organization_page_views')",
    [authorizedPreview.id],
  );

  await asUser(client, ids.foreignAdmin);
  const foreignPolicies = await client.query("select * from public.organization_retention_policies");
  assert(foreignPolicies.rowCount === 0, "RLS exposed another organization's policy");
  await expectCode(client, "foreign_execute_denied", "42501", () => client.query(
    "select public.execute_organization_retention_run($1)", [authorizedPreview.id],
  ));

  await asUser(client, ids.admin);
  const firstRun = (await client.query(
    "select public.execute_organization_retention_run($1) as value", [authorizedPreview.id],
  )).rows[0].value;
  assert(firstRun.status === "completed" && firstRun.deletedCount === 1 && firstRun.remainingCount === 0,
    "manual execution did not delete exactly the previewed old tenant row");

  await client.query("reset role");
  await client.query(`
    insert into public.organization_page_views (organization_id, path, hat, day, view_count)
    select $1, '/retention-proof/' || series::text, 'admin', current_date - 200, 1
    from pg_catalog.generate_series(1, 5001) series
  `, [ids.organization]);
  await asUser(client, ids.admin);
  const batchPreview = (await client.query(
    "select public.preview_organization_retention_run('organization_page_views') as value",
  )).rows[0].value;
  assert(batchPreview.eligibleCount === 5001, "batch preview did not count all eligible tenant rows");
  await client.query(
    "select public.authorize_organization_retention_run($1, 'AUTHORIZE organization_page_views')",
    [batchPreview.id],
  );
  const batchRun = (await client.query(
    "select public.execute_organization_retention_run($1) as value", [batchPreview.id],
  )).rows[0].value;
  assert(batchRun.deletedCount === 5000 && batchRun.remainingCount === 1,
    "manual execution did not enforce the 5,000-row batch cap");

  await client.query("reset role");
  const tenantCounts = (await client.query(`
    select
      count(*) filter (where organization_id = $1 and day < current_date - 180)::integer as target_old,
      count(*) filter (where organization_id = $1 and day >= current_date - 180)::integer as target_recent,
      count(*) filter (where organization_id = $2)::integer as foreign_total
    from public.organization_page_views
    where organization_id in ($1, $2)
  `, [ids.organization, ids.foreignOrganization])).rows[0];
  assert(tenantCounts.target_old === 1 && tenantCounts.target_recent === 1 && tenantCounts.foreign_total === 1,
    "bounded execution crossed tenant or retention-window boundaries");

  const scheduled = (await client.query(
    "select private.run_due_organization_retention_jobs(1) as value",
  )).rows[0].value;
  assert(scheduled.processed === 1, "scheduler did not claim the explicitly enabled policy");
  const remainingOld = Number((await client.query(`
    select count(*) from public.organization_page_views
    where organization_id = $1 and day < current_date - 180
  `, [ids.organization])).rows[0].count);
  assert(remainingOld === 0, "scheduled continuation did not remove the remaining eligible row");

  await asUser(client, ids.admin);
  const finalEngine = (await client.query(
    "select public.get_organization_retention_engine() as value",
  )).rows[0].value;
  const serialized = JSON.stringify(finalEngine);
  assert(finalEngine.runs.some((run) => run.mode === "scheduled" && run.status === "completed"),
    "count-only history omitted the scheduled terminal run");
  assert(!serialized.includes("/target-") && !serialized.includes("/retention-proof/"),
    "run history retained deleted row content");

  console.log(`PASS: MFA/admin authorization, typed gates, tenant RLS, dry run, 5,000-row cap, scheduled continuation, and count-only history proved locally against ${schemaMode}.`);
} finally {
  if (open) await client.query("rollback").catch(() => {});
  await client.end().catch(() => {});
}
