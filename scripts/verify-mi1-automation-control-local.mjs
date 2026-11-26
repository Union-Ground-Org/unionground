import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";

const { Client } = pg;
const databaseUrl = assertDisposableProofUrl(requireDatabaseUrl("SUPABASE_DB_URL", { aliases: ["DATABASE_URL"] }));

const ids = {
  admin: "50900000-0000-4000-8000-000000000108",
  outsider: "50900000-0000-4000-8000-000000000109",
  foreignOrg: "50900000-0000-4000-8000-000000000110",
  bootstrapKey: "50900000-0000-4000-8000-000000000111",
  sourceA: "50900000-0000-4000-8000-000000000112",
  sourceB: "50900000-0000-4000-8000-000000000113",
  sourceC: "50900000-0000-4000-8000-000000000114",
  foreignDefinition: "50900000-0000-4000-8000-000000000115",
};

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function asRole(client, role, userId = null, aal = "aal2") {
  await client.query("reset role");
  const claims = userId ? { sub: userId, role, aal, session_id: userId } : { role };
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
  await client.query(`set local role ${role}`);
}

async function expectSqlstate(client, label, sql, values, state) {
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

// The admin fixture is both author and approver; the review RPCs record the
// self-review in the audit metadata.
async function approveDefinition(client, definitionId, version) {
  await client.query("select public.mi1_submit_automation_definition($1, $2)", [definitionId, version]);
  await client.query("select public.mi1_review_automation_definition($1, $2, 'approve')", [definitionId, version]);
}

const client = new Client({
  connectionString: databaseUrl,
  application_name: "cr108-automation-rollback-proof",
});

try {
  await client.connect();
  const launchState = (await client.query(`
    select
      (select count(*)::int from public.organizations) as organizations,
      (select count(*)::int from public.organization_automation_definitions) as definitions,
      (select count(*)::int from auth.users) as users
  `)).rows[0];
  assert(launchState.organizations === 0, "local reset must preserve the zero-organization launch state");
  assert(launchState.definitions === 0, "local reset must not seed automation definitions");
  assert(launchState.users === 0, "local reset must not seed real or fictional Auth identities");

  await client.query("begin");
  await client.query(`
    insert into auth.users (id, email) values
      ($1, 'cr108-admin@example.invalid'),
      ($2, 'cr108-outsider@example.invalid')
  `, [ids.admin, ids.outsider]);

  await asRole(client, "service_role");
  const bootstrap = (await client.query(`
    select public.bootstrap_first_organization(
      'CR-108 local proof', 'cr108-local-proof', $1,
      'cr108', 'CR-108 local chapter', 'cr108', $2
    ) as value
  `, [ids.admin, ids.bootstrapKey])).rows[0].value;
  const organizationId = bootstrap.organizationId;
  assert(organizationId && bootstrap.chapterId === "cr108", "service bootstrap must create the explicit local proof tenant");

  await client.query("reset role");
  // The current MFA boundary requires a live session, not an AAL claim alone.
  await client.query(`
    insert into auth.sessions (id, user_id, aal, created_at)
    values ($1, $1, 'aal2', now()), ($2, $2, 'aal2', now())
  `, [ids.admin, ids.outsider]);
  await client.query(`
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
    values ($1, $1, 'totp', now(), now()), ($2, $2, 'totp', now(), now())
  `, [ids.admin, ids.outsider]);
  await client.query(`
    insert into auth.mfa_factors
      (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    values
      (extensions.gen_random_uuid(), $1, 'cr108-proof', 'totp', 'verified', now(), now()),
      (extensions.gen_random_uuid(), $2, 'cr108-proof', 'totp', 'verified', now(), now())
  `, [ids.admin, ids.outsider]);
  await client.query(`
    insert into public.chapter_workstreams (chapter_id, name, created_by)
    values ('cr108', 'General', $1)
  `, [ids.admin]);

  await client.query(`
    insert into public.organizations (id, slug, name, status, created_by)
    values ($1, 'cr108-foreign', 'CR-108 foreign proof', 'active', $2)
  `, [ids.foreignOrg, ids.outsider]);
  await client.query(`
    insert into public.org_security_policy (id, organization_id, require_staff_mfa, updated_by)
    values (true, $1, true, $2)
  `, [ids.foreignOrg, ids.outsider]);
  await client.query(`
    insert into public.chapters (id, name, is_default, order_index, organization_id, slug)
    values ('cr108-foreign', 'CR-108 foreign chapter', true, 1, $1, 'cr108-foreign')
  `, [ids.foreignOrg]);
  await client.query(`
    insert into public.organization_memberships (organization_id, user_id)
    values ($1, $2)
  `, [ids.foreignOrg, ids.outsider]);
  await client.query(`
    insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
    values ($1, $2, 'admin', $2)
  `, [ids.foreignOrg, ids.outsider]);
  await client.query(`
    insert into public.member_chapter_memberships (user_id, chapter_id, status, last_selected_at)
    values ($1, 'cr108-foreign', 'active', now())
  `, [ids.outsider]);
  await client.query("update public.member_profiles set chapter_id = 'cr108-foreign' where id = $1", [ids.outsider]);
  await client.query(`
    insert into public.organization_automation_definitions (
      id, organization_id, name, trigger_kind, threshold_days, cadence,
      task_priority, status, version, created_by, updated_by
    ) values ($1, $2, 'Foreign automation', 'overdue_task', 0, 'daily',
      'medium', 'active', 1, $3, $3)
  `, [ids.foreignDefinition, ids.foreignOrg, ids.outsider]);

  await asRole(client, "authenticated", ids.admin, "aal1");
  await expectSqlstate(
    client,
    "aal1_operator",
    "select public.get_organization_automation_control_room()",
    [],
    "42501",
  );

  await asRole(client, "authenticated", ids.outsider);
  const outsiderRoom = (await client.query(
    "select public.get_organization_automation_control_room() as value",
  )).rows[0].value;
  assert(outsiderRoom.organizationId === ids.foreignOrg, "operator scope must follow the explicitly selected organization");
  assert(outsiderRoom.definitions.length === 1 && outsiderRoom.definitions[0].id === ids.foreignDefinition,
    "foreign operator must see only the foreign tenant definition");

  await asRole(client, "authenticated", ids.admin);
  const initial = (await client.query(
    "select public.get_organization_automation_control_room() as value",
  )).rows[0].value;
  assert(initial.organizationId === organizationId, "control room must bind to the caller's active organization");
  assert(initial.settings.enabled === false && initial.settings.maxEffectsPerRun === 20,
    "missing settings must fail closed to paused with the documented cap");
  assert(initial.definitions.length === 0 && initial.runs.length === 0,
    "new organizations must start with no automation definitions or history");
  assert(initial.schedulerConfigured === true, "the bounded hourly scheduler must be installed");
  assert((await client.query(
    "select count(*)::int as n from public.organization_automation_definitions where id = $1",
    [ids.foreignDefinition],
  )).rows[0].n === 0, "RLS must hide cross-organization automation definitions");
  await expectSqlstate(
    client,
    "cross_org_preview",
    "select public.preview_organization_automation_run($1)",
    [ids.foreignDefinition],
    "22023",
  );
  await expectSqlstate(
    client,
    "direct_definition_write",
    `insert into public.organization_automation_definitions
      (organization_id, name, trigger_kind, threshold_days, cadence, task_priority)
      values ($1, 'Bypass', 'overdue_task', 0, 'daily', 'medium')`,
    [organizationId],
    "42501",
  );

  const saved = (await client.query(`
    select public.save_organization_automation_definition(
      null, 'Overdue review queue', 'overdue_task', 0, 'daily', 'high', null
    ) as value
  `)).rows[0].value;
  assert(saved.status === "draft" && saved.version === 1, "new definitions must remain draft until explicitly activated");
  const definitionId = saved.id;
  // Since 20260911070000 activation needs an approved review of the current
  // version; status changes no longer advance the version.
  await expectSqlstate(
    client,
    "unapproved_activation",
    "select public.set_organization_automation_definition_status($1, 'active', 1)",
    [definitionId],
    "PT409",
  );
  await approveDefinition(client, definitionId, 1);
  const activated = (await client.query(
    "select public.set_organization_automation_definition_status($1, 'active', 1) as value",
    [definitionId],
  )).rows[0].value;
  assert(activated.status === "active" && activated.version === 1, "approved activation must keep the reviewed version");
  await expectSqlstate(
    client,
    "stale_definition",
    "select public.set_organization_automation_definition_status($1, 'paused', 0)",
    [definitionId],
    "PT409",
  );
  await expectSqlstate(
    client,
    "wrong_enable_phrase",
    "select public.set_organization_automation_enabled(true, 'enable')",
    [],
    "22023",
  );
  const enabled = (await client.query(
    "select public.set_organization_automation_enabled(true, 'ENABLE AUTOMATION') as value",
  )).rows[0].value;
  assert(enabled.enabled === true, "the exact typed phrase must enable tenant automation");
  const capped = (await client.query(
    "select public.set_organization_automation_safety_cap(2) as value",
  )).rows[0].value;
  assert(capped.maxEffectsPerRun === 2, "the per-run safety cap must persist");

  // Source rows are fixture setup, not a proof of the browser's column-level
  // task grants. Keep the admin JWT claims so the real task trigger stamps the
  // selected chapter and actor, while postgres supplies deterministic IDs.
  await client.query("reset role");
  await client.query(`
    insert into public.chapter_tasks (
      id, title, description, status, priority, workstream,
      assignee_id, start_date, due_date, progress, blocked, milestone, task_type
    ) values
      ($1, 'PRIVATE-SOURCE-A-509', '', 'to_do', 'medium', 'General', null, null, current_date - 3, 0, false, false, 'general'),
      ($2, 'PRIVATE-SOURCE-B-509', '', 'to_do', 'medium', 'General', null, null, current_date - 2, 0, false, false, 'general'),
      ($3, 'PRIVATE-SOURCE-C-509', '', 'to_do', 'medium', 'General', null, null, current_date - 1, 0, false, false, 'general')
  `, [ids.sourceA, ids.sourceB, ids.sourceC]);

  await asRole(client, "authenticated", ids.admin);
  const preview = (await client.query(
    "select public.preview_organization_automation_run($1) as value",
    [definitionId],
  )).rows[0].value;
  assert(preview.candidatesCount === 3 && preview.willCreate === 2 && preview.effectsSkipped === 1,
    "preview must disclose the candidate count and the hard cap before execution");
  await expectSqlstate(
    client,
    "wrong_run_phrase",
    "select public.execute_organization_automation_run($1, 'RUN WRONG')",
    [preview.id],
    "22023",
  );
  const run = (await client.query(
    "select public.execute_organization_automation_run($1, $2) as value",
    [preview.id, preview.confirmationPhrase],
  )).rows[0].value;
  assert(run.status === "succeeded" && run.candidatesCount === 3
    && run.effectsCreated === 2 && run.effectsSkipped === 1 && run.effectsFailed === 0,
  "confirmed manual execution must create only capped, successful effects");

  const generated = (await client.query(`
    select t.id, t.title, t.description, t.status, t.priority, t.workstream,
           t.assignee_id, t.start_date, t.due_date, t.created_by,
           (select count(*)::int from public.chapter_task_activity a where a.task_id = t.id) as activity_count
    from public.organization_automation_effects e
    join public.chapter_tasks t on t.id = e.task_id
    where e.run_id = $1
    order by e.created_at, e.id
  `, [run.id])).rows;
  assert(generated.length === 2, "each successful effect must point to one generated Standard Task");
  assert(generated.every((task) => task.title === "Review overdue work"
    && task.description === "" && task.status === "to_do" && task.priority === "high"
    && task.workstream === "General" && task.assignee_id === null
    && task.start_date === null && task.due_date === null && task.created_by === ids.admin
    && task.activity_count === 1),
  "generated tasks must keep the fixed privacy-safe Standard Task shape");
  assert(!JSON.stringify(generated).includes("PRIVATE-SOURCE"), "generated task output must not copy source titles");

  // A human edit goes through the field-edit RPC like every client since
  // 20261103183000.
  await client.query(
    "select id from public.update_chapter_task_fields($1, '{\"title\": \"Operator-retained follow-up\"}'::jsonb)",
    [generated[0].id],
  );
  const rollbackPhrase = `ROLL BACK ${String(run.id).slice(0, 8).toUpperCase()}`;
  await expectSqlstate(
    client,
    "wrong_rollback_phrase",
    "select public.rollback_organization_automation_run($1, 'ROLL BACK WRONG')",
    [run.id],
    "22023",
  );
  const rolledBack = (await client.query(
    "select public.rollback_organization_automation_run($1, $2) as value",
    [run.id, rollbackPhrase],
  )).rows[0].value;
  assert(rolledBack.status === "rollback_partial" && rolledBack.effectsRolledBack === 1 && rolledBack.rollbackSkipped === 1,
    `rollback must compensate untouched effects and preserve human-modified tasks: ${JSON.stringify(rolledBack)}`);
  await client.query("reset role");
  const postRollback = (await client.query(`
    select id, title, status, deleted_at from public.chapter_tasks where id = any($1::uuid[]) order by id
  `, [generated.map((task) => task.id)])).rows;
  assert(postRollback.some((task) => task.title === "Operator-retained follow-up"
    && task.status === "to_do" && task.deleted_at === null),
  "an immediate fixed-field edit must remain active even inside the five-second timestamp tolerance");
  const compensatedTask = postRollback.find((task) => task.title === "Review overdue work" && task.deleted_at !== null);
  assert(compensatedTask,
    "untouched generated work must be soft-deleted by compensation");
  await client.query(
    "update public.chapter_tasks set deleted_at = pg_catalog.now() - interval '91 days' where id = $1",
    [compensatedTask.id],
  );
  const purgedCount = (await client.query(
    "select private.purge_deleted_chapter_tasks() as value",
  )).rows[0].value;
  assert(purgedCount >= 1, "the shared 90-day maintenance function must purge an aged automation task");
  const purgedEffect = (await client.query(`
    select task_id, planned_task_id from public.organization_automation_effects
    where run_id = $1 and planned_task_id = $2
  `, [run.id, compensatedTask.id])).rows[0];
  assert(purgedEffect?.task_id === null && purgedEffect.planned_task_id === compensatedTask.id,
    "task purge must clear only the live FK while preserving content-free automation provenance");

  await asRole(client, "authenticated", ids.admin);
  const scheduledDefinition = (await client.query(`
    select public.save_organization_automation_definition(
      null, 'Unassigned case queue', 'unassigned_case', 0, 'hourly', 'medium', null
    ) as value
  `)).rows[0].value;
  await approveDefinition(client, scheduledDefinition.id, 1);
  await client.query(
    "select public.set_organization_automation_definition_status($1, 'active', 1)",
    [scheduledDefinition.id],
  );
  await client.query("reset role");
  const scheduled = (await client.query(
    "select private.run_due_organization_automations(25) as value",
  )).rows[0].value;
  assert(scheduled.processed >= 1 && scheduled.failed === 0,
    "the private scheduler must process due active definitions without credentials or a provider");
  const noOp = (await client.query(`
    select status, mode, initiated_by from public.organization_automation_runs
    where definition_id = $1 and mode = 'scheduled'
    order by created_at desc limit 1
  `, [scheduledDefinition.id])).rows[0];
  assert(noOp?.status === "no_op" && noOp.initiated_by === null,
    "a due zero-candidate definition must record a bounded scheduled no-op");
  assert((await client.query(`
    select next_run_at > now() as advanced
    from public.organization_automation_definitions where id = $1
  `, [scheduledDefinition.id])).rows[0].advanced === true, "scheduled execution must advance the next due time");
  const cron = (await client.query(`
    select schedule, active, command from cron.job where jobname = 'organization-automation-tick'
  `)).rows[0];
  assert(cron?.schedule === "11 * * * *" && cron.active === true
    && cron.command === "select private.run_due_organization_automations(25);",
  "the installed cron job must use the exact bounded private dispatcher");

  const audits = (await client.query(`
    select event_type, action, entity_type, metadata
    from public.organization_audit_ledger
    where organization_id = $1 and domain = 'operations'
      and event_type like 'automation_%'
  `, [organizationId])).rows;
  assert(audits.some((event) => event.event_type === "automation_run_completed")
    && audits.some((event) => event.event_type === "automation_run_rolled_back")
    && audits.every((event) => !JSON.stringify(event).includes("PRIVATE-SOURCE")),
  "automation controls and effects must leave bounded, content-free tenant audit evidence");

  await client.query("rollback");
  const residue = (await client.query(`
    select
      (select count(*)::int from public.organizations) as organizations,
      (select count(*)::int from public.organization_automation_definitions) as definitions,
      (select count(*)::int from auth.users) as users
  `)).rows[0];
  assert(residue.organizations === 0 && residue.definitions === 0 && residue.users === 0,
    "rollback-only verification must leave the local launch state unchanged");

  console.log("PASS: CR-108 tenant isolation, MFA, direct-write denial, typed controls, cap, privacy-safe effects, human-preserving rollback, scheduler, audit, and zero-residue launch state proved locally.");
} finally {
  await client.query("rollback").catch(() => {});
  await client.end().catch(() => {});
}
