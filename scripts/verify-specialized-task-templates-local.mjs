import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";

const { Client } = pg;
const databaseUrl = assertDisposableProofUrl(requireDatabaseUrl("SUPABASE_DB_URL", { aliases: ["DATABASE_URL"] }));

const ids = {
  worAdmin: "50900000-0000-4000-8000-000000000081",
  bosAdmin: "50900000-0000-4000-8000-000000000082",
  worMember: "50900000-0000-4000-8000-000000000083",
  bosMember: "50900000-0000-4000-8000-000000000084",
  foreignScopedAdmin: "50900000-0000-4000-8000-000000000087",
  unenrolledStaff: "50900000-0000-4000-8000-000000000089",
  worSteward: "50900000-0000-4000-8000-000000000090",
  worCoordinator: "50900000-0000-4000-8000-000000000091",
  worVp: "50900000-0000-4000-8000-000000000092",
};
const titlePrefix = "Template rollback proof";
const templates = [
  {
    key: "meeting_event",
    fields: { scheduled_on: "2026-08-20", starts_at: "09:00", ends_at: "10:00", venue_mode: "hybrid" },
    status: "to_do", priority: "medium", first: "planning",
    path: [["confirmed", "to_do"], ["held", "in_progress"], ["follow_up", "needs_review"], ["complete", "done"]],
  },
  {
    key: "review_approval",
    fields: { review_kind: "document", reviewer_id: ids.worAdmin },
    status: "needs_review", priority: "medium", first: "prepare",
    path: [["in_review", "needs_review"], ["changes_requested", "in_progress"], ["approved", "done"]],
  },
  {
    key: "member_follow_up",
    fields: { contact_method: "phone", follow_up_on: "2026-08-21" },
    status: "to_do", priority: "medium", first: "prepare",
    path: [["contact", "in_progress"], ["await_response", "in_progress"], ["resolve", "done"]],
  },
  {
    key: "document_request",
    fields: { record_category: "policy", record_source: "employer" },
    status: "to_do", priority: "medium", first: "prepare",
    path: [["requested", "in_progress"], ["acknowledged", "in_progress"], ["received", "needs_review"], ["complete", "done"]],
  },
  {
    key: "issue_incident",
    fields: { occurred_on: "2026-08-19", incident_severity: "urgent" },
    status: "to_do", priority: "high", first: "triage",
    path: [["act", "in_progress"], ["monitor", "needs_review"], ["resolve", "done"]],
  },
];

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function asRole(client, role, userId = null, aal = "aal2") {
  await client.query("reset role");
  const claims = userId ? { sub: userId, role, aal } : { role };
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
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

async function counts(client) {
  await client.query("reset role");
  const row = (await client.query(`
    select
      (select count(*)::int from public.chapter_tasks where title like $1) tasks,
      (select count(*)::int from public.chapter_task_template_details d
         join public.chapter_tasks t on t.id = d.task_id where t.title like $1) details,
      (select count(*)::int from public.chapter_task_activity a
         join public.chapter_tasks t on t.id = a.task_id where t.title like $1) activity,
      (select count(*)::int from public.member_notifications
         where user_id = any($2::uuid[]) and kind = 'tasks') notices
  `, [`${titlePrefix}%`, Object.values(ids)])).rows[0];
  return JSON.stringify(row);
}

const client = new Client({ connectionString: databaseUrl, application_name: "specialized-task-templates-rollback-proof" });
try {
  await client.connect();
  await client.query("begin");

  for (const [index, id] of Object.values(ids).entries()) {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [id, `template-proof-${index}@example.invalid`]);
  }
  await client.query("update public.member_profiles set chapter_id = 'wor', full_name = case id when $2 then 'Admin Reviewer' when $3 then 'Advisor Reviewer' when $4 then 'Steward Reviewer' when $5 then 'Coordinator Reviewer' when $6 then 'VP Reviewer' else 'Worcester template proof' end where id = any($1::uuid[])", [[ids.worAdmin, ids.worMember, ids.foreignScopedAdmin, ids.unenrolledStaff, ids.worSteward, ids.worCoordinator, ids.worVp], ids.worAdmin, ids.unenrolledStaff, ids.worSteward, ids.worCoordinator, ids.worVp]);
  await client.query("update public.member_profiles set chapter_id = 'bos', full_name = 'Boston template proof' where id = any($1::uuid[])", [[ids.bosAdmin, ids.bosMember]]);
  await client.query(`
    insert into auth.mfa_factors (
      id, user_id, friendly_name, factor_type, status, created_at, updated_at
    ) values
      ('50900000-0000-4000-8000-000000000085', $1, 'Template proof Worcester', 'totp', 'verified', now(), now()),
      ('50900000-0000-4000-8000-000000000086', $2, 'Template proof Boston', 'totp', 'verified', now(), now()),
      ('50900000-0000-4000-8000-000000000088', $3, 'Template proof foreign scope', 'totp', 'verified', now(), now())
  `, [ids.worAdmin, ids.bosAdmin, ids.foreignScopedAdmin]);
  await client.query(`
    insert into public.member_roles (user_id, role, chapter_id)
    values ($1, 'admin', 'wor'), ($2, 'admin', 'bos'), ($3, 'admin', 'bos'),
      ($4, 'advisor', 'wor'), ($5, 'steward', 'wor'), ($6, 'coordinator', 'wor'),
      ($7, 'vp', 'wor')
  `, [ids.worAdmin, ids.bosAdmin, ids.foreignScopedAdmin, ids.unenrolledStaff,
    ids.worSteward, ids.worCoordinator, ids.worVp]);
  await client.query(`
    update public.org_security_policy
    set require_staff_mfa = true, updated_at = now(), updated_by = $1
    where id = true and organization_id is null
  `, [ids.worAdmin]);
  await client.query("insert into public.chapter_workstreams (chapter_id, name) values ('bos', 'Boston only proof')");

  const createSql = "select public.create_chapter_task_from_template($1, $2, $3, $4::jsonb) as value";
  const baseline = await counts(client);

  await asRole(client, "authenticated", ids.worAdmin, "aal1");
  await expectState(client, "aal1_denied", createSql,
    ["member_follow_up", `${titlePrefix} aal1_denied`, "General", JSON.stringify(templates[2].fields)], "42501");

  await asRole(client, "authenticated", ids.worMember);
  await expectState(client, "ordinary_member_catalog_denied",
    "select public.list_chapter_task_templates()", [], "42501");
  await expectState(client, "ordinary_member_reviewers_denied",
    "select public.list_chapter_task_template_reviewers()", [], "42501");
  await expectState(client, "ordinary_member_denied", createSql,
    ["member_follow_up", `${titlePrefix} ordinary_member_denied`, "General", JSON.stringify(templates[2].fields)], "42501");

  await asRole(client, "authenticated", ids.foreignScopedAdmin);
  await expectState(client, "foreign_scoped_catalog_denied",
    "select public.list_chapter_task_templates()", [], "42501");
  await expectState(client, "foreign_scoped_reviewers_denied",
    "select public.list_chapter_task_template_reviewers()", [], "42501");
  await expectState(client, "foreign_scoped_role_create_denied", createSql,
    ["member_follow_up", `${titlePrefix} foreign_scoped_role_create_denied`, "General", JSON.stringify(templates[2].fields)], "42501");

  // This caller has a live, chapter-scoped staff grant and an aal2 claim but
  // deliberately has no verified factor. With the staff policy on, the
  // member_has_role policy gate must deny before any task/detail write.
  await asRole(client, "authenticated", ids.unenrolledStaff);
  await expectState(client, "staff_policy_unenrolled_create_denied", createSql,
    ["member_follow_up", `${titlePrefix} staff_policy_unenrolled_create_denied`, "General", JSON.stringify(templates[2].fields)], "42501");

  await asRole(client, "authenticated", ids.worAdmin);
  await expectState(client, "extra_field_denied", createSql,
    ["member_follow_up", `${titlePrefix} extra_field_denied`, "General", JSON.stringify({ ...templates[2].fields, member_name: "must not persist" })], "22023");
  await expectState(client, "malformed_field_denied", createSql,
    ["meeting_event", `${titlePrefix} malformed_field_denied`, "General", JSON.stringify({ ...templates[0].fields, scheduled_on: "tomorrow" })], "22023");
  await expectState(client, "reviewer_scope_denied", createSql,
    ["review_approval", `${titlePrefix} reviewer_scope_denied`, "General", JSON.stringify({ review_kind: "document", reviewer_id: ids.bosMember })], "22023");
  await expectState(client, "ordinary_reviewer_create_denied", createSql,
    ["review_approval", `${titlePrefix} ordinary_reviewer_create_denied`, "General", JSON.stringify({ review_kind: "document", reviewer_id: ids.worMember })], "22023");
  await expectState(client, "workstream_scope_denied", createSql,
    ["member_follow_up", `${titlePrefix} workstream_scope_denied`, "Boston only proof", JSON.stringify(templates[2].fields)], "22023");
  assert(await counts(client) === baseline, "zero_write_denials: denied creates changed scoped counts");

  const catalog = (await client.query("select public.list_chapter_task_templates() as value")).rows[0].value;
  assert(catalog.length === 5, "catalog must expose five templates");
  for (const template of catalog) {
    assert(templates.some((item) => item.key === template.key), `unexpected catalog key ${template.key}`);
    assert(template.flow.every((step) => Array.isArray(step.predecessorKeys)), "predecessorKeys must be returned for every flow step");
    assert(!Object.hasOwn(template, "notificationCopyKey"), "catalog must not expose notification internals");
  }
  const reviewers = (await client.query("select public.list_chapter_task_template_reviewers() as value")).rows[0].value;
  const reviewerIds = new Set(reviewers.map((reviewer) => reviewer.id));
  for (const id of [ids.worAdmin, ids.unenrolledStaff, ids.worSteward, ids.worCoordinator, ids.worVp]) {
    assert(reviewerIds.has(id), `reviewer_candidates_all_supported_roles: missing ${id}`);
  }
  for (const id of [ids.worMember, ids.foreignScopedAdmin, ids.bosAdmin, ids.bosMember]) {
    assert(!reviewerIds.has(id), `reviewer_candidates_exclude_ordinary_and_foreign_scope: leaked ${id}`);
  }

  const created = [];
  for (const [index, definition] of templates.entries()) {
    const value = (await client.query(createSql, [
      definition.key, `${titlePrefix} ${index}`, "General", JSON.stringify(definition.fields),
    ])).rows[0].value;
    assert(value.task.task_type === definition.key, `${definition.key}: task type default`);
    assert(value.task.status === definition.status, `${definition.key}: status default`);
    assert(value.task.priority === definition.priority, `${definition.key}: priority default`);
    assert(value.task.assignee_id === null, `${definition.key}: task must default unassigned`);
    assert(value.details.flow_step === definition.first, `${definition.key}: initial flow`);
    assert(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/.test(value.task.description), `${definition.key}: checklist leaked contact data`);
    assert((value.task.description.match(/^- \[ \] /gm) || []).length >= 3, `${definition.key}: seeded checklist missing`);
    created.push({ ...definition, id: value.task.id });
  }

  await client.query("select public.set_chapter_task_assignees($1, $2::uuid[])", [created[2].id, [ids.worMember]]);
  const first = created[2];
  const beforeFlow = (await client.query("select status from public.chapter_tasks where id = $1", [first.id])).rows[0].status;
  let value = (await client.query(
    "select public.update_chapter_task_template_details($1, '{}'::jsonb, $2, p_apply_recommended_status => false) as value",
    [first.id, first.path[0][0]],
  )).rows[0].value;
  assert(value.task.status === beforeFlow && value.details.flow_step === first.path[0][0], "flow_only_keeps_status");
  value = (await client.query(
    "select public.update_chapter_task_template_details($1, '{}'::jsonb, $2, p_apply_recommended_status => true) as value",
    [first.id, first.path[1][0]],
  )).rows[0].value;
  assert(value.task.status === first.path[1][1], "confirmed_flow_updates_status");

  for (const item of created) {
    let startAt = item === first ? 2 : 0;
    for (const [step, expectedStatus] of item.path.slice(startAt)) {
      const result = (await client.query(
        "select public.update_chapter_task_template_details($1, '{}'::jsonb, $2, $3) as value",
        [item.id, step, true],
      )).rows[0].value;
      assert(result.details.flow_step === step, `${item.key}: forward flow ${step}`);
      assert(result.task.status === expectedStatus, `${item.key}: catalog-derived status ${step}`);
    }
  }

  await asRole(client, "authenticated", ids.bosAdmin);
  await expectState(client, "foreign_chapter_denied",
    "select public.update_chapter_task_template_details($1, '{}'::jsonb, null, false)", [created[0].id], "22023");

  const updateDenialBaseline = await counts(client);
  const updateStateSql = `
    select jsonb_build_object(
      'task', to_jsonb(t),
      'details', to_jsonb(d),
      'activity', (select count(*)::int from public.chapter_task_activity a where a.task_id = t.id)
    ) as value
    from public.chapter_tasks t
    join public.chapter_task_template_details d on d.task_id = t.id
    where t.id = $1
  `;
  await client.query("reset role");
  const beforeUnenrolledUpdate = JSON.stringify((await client.query(updateStateSql, [created[0].id])).rows[0].value);
  await asRole(client, "authenticated", ids.unenrolledStaff);
  await expectState(client, "staff_policy_unenrolled_update_denied",
    "select public.update_chapter_task_template_details($1, $2::jsonb, null, false)",
    [created[0].id, JSON.stringify({ venue_mode: "phone" })], "42501");
  await client.query("reset role");
  const afterUnenrolledUpdate = JSON.stringify((await client.query(updateStateSql, [created[0].id])).rows[0].value);
  assert(afterUnenrolledUpdate === beforeUnenrolledUpdate,
    "staff_policy_unenrolled_update_denied: denied update changed task, detail, or activity state");
  await asRole(client, "authenticated", ids.foreignScopedAdmin);
  await expectState(client, "foreign_scoped_role_update_denied",
    "select public.update_chapter_task_template_details($1, '{}'::jsonb, null, false)", [created[1].id], "42501");
  await asRole(client, "authenticated", ids.worAdmin);
  await expectState(client, "ordinary_reviewer_update_denied",
    "select public.update_chapter_task_template_details($1, $2::jsonb, null, false)",
    [created[1].id, JSON.stringify({ reviewer_id: ids.worMember })], "22023");
  assert(await counts(client) === updateDenialBaseline, "zero_write_update_denials: denied updates changed scoped counts");

  await client.query("reset role");
  const flowAudit = await client.query(`
    select count(*)::int n from public.chapter_task_activity a
    where a.task_id = any($1::uuid[]) and a.action = 'template_flow_changed'
      and a.from_value is not null and a.to_value is not null
  `, [created.map((item) => item.id)]);
  assert(flowAudit.rows[0].n >= 2, "flow audit must contain stable old/new keys");
  const notices = await client.query(`
    select n.title, n.body from public.member_notifications n
    where n.user_id = $1 and n.kind = 'tasks'
      and n.title in ('A task workflow changed', 'Cambió el flujo de una tarea')
  `, [ids.worMember]);
  assert(notices.rows.length > 0, "generic_notification_copy: assigned audience did not receive a flow notice");
  assert(notices.rows.every((row) => !row.title.includes(titlePrefix) && !row.body.includes(titlePrefix)),
    "generic_notification_copy: provider copy disclosed a task field");

  await client.query("rollback");
  const residue = await client.query("select count(*)::int n from public.chapter_tasks where title like $1", [`${titlePrefix}%`]);
  assert(residue.rows[0].n === 0, "residue: rollback left task fixtures");
  const userResidue = await client.query("select count(*)::int n from auth.users where id = any($1::uuid[])", [Object.values(ids)]);
  assert(userResidue.rows[0].n === 0, "residue: rollback left identity fixtures");
  console.log("PASS: specialized template authorization, fields, defaults, flows, status confirmation, notifications, and rollback residue proved locally.");
} catch (error) {
  await client.query("rollback").catch(() => {});
  throw error;
} finally {
  await client.end().catch(() => {});
}
