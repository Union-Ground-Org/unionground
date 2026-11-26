import pg from "pg";

import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";
import { createAutomationApi } from "../src/lib/mi1AutomationWiring.js";

const { Client } = pg;
const databaseUrl = assertDisposableProofUrl(
  requireDatabaseUrl("SUPABASE_DB_URL", { aliases: ["DATABASE_URL"] }),
);

const ids = {
  org: "50930000-0000-4000-8000-000000000001",
  admin: "50930000-0000-4000-8000-000000000002",
  steward: "50930000-0000-4000-8000-000000000003",
  advisor: "50930000-0000-4000-8000-000000000004",
  noMfa: "50930000-0000-4000-8000-000000000005",
  member: "50930000-0000-4000-8000-000000000006",
  visibleTask: "50930000-0000-4000-8000-000000000007",
  hiddenTask: "50930000-0000-4000-8000-000000000008",
  otherOrg: "50930000-0000-4000-8000-000000000009",
  otherAdmin: "50930000-0000-4000-8000-00000000000a",
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

const client = new Client({
  connectionString: databaseUrl,
  application_name: "automation-shared-intelligence-v3-proof",
});

try {
  await client.connect();
  // This proof runs in the shared-fixtures phase beside proofs that commit
  // their own organizations, so it must not demand a zero-state database.
  // It owns fixed fixture ids and proves only that none of them exist before
  // or after its rolled-back transaction.
  const fixtureResidue = async () => (await client.query(`
    select
      (select count(*)::int from public.organizations where id = any($1::uuid[])) as organizations,
      (select count(*)::int from public.organization_automation_definitions where organization_id = any($1::uuid[])) as definitions,
      (select count(*)::int from auth.users where id = any($2::uuid[])) as users
  `, [[ids.org, ids.otherOrg], [ids.admin, ids.steward, ids.advisor, ids.noMfa, ids.member, ids.otherAdmin]])).rows[0];
  const launchState = await fixtureResidue();
  assert(launchState.organizations === 0 && launchState.definitions === 0 && launchState.users === 0,
    "proof fixture identities must not pre-exist in the disposable database");

  await client.query("begin");
  await client.query(`
    insert into auth.users (id, email) values
      ($1, 'automation-v3-admin@example.invalid'),
      ($2, 'automation-v3-steward@example.invalid'),
      ($3, 'automation-v3-advisor@example.invalid'),
      ($4, 'automation-v3-no-mfa@example.invalid'),
      ($5, 'automation-v3-member@example.invalid')
  `, [ids.admin, ids.steward, ids.advisor, ids.noMfa, ids.member]);
  await client.query(`
    insert into public.organizations (id, slug, name, status, created_by)
    values ($1, 'automation-v3-proof', 'Automation v3 proof', 'active', $2)
  `, [ids.org, ids.admin]);
  await client.query(`
    insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values
      ('automation-v3-visible', 'Visible chapter', 'automation-v3-visible', true, 1, $1),
      ('automation-v3-hidden', 'Hidden chapter', 'automation-v3-hidden', false, 2, $1)
  `, [ids.org]);
  await client.query(`
    insert into public.organization_memberships (organization_id, user_id, status) values
      ($1,$2,'active'), ($1,$3,'active'), ($1,$4,'active'), ($1,$5,'active'), ($1,$6,'active')
  `, [ids.org, ids.admin, ids.steward, ids.advisor, ids.noMfa, ids.member]);
  await client.query(`
    insert into public.member_chapter_memberships (user_id, chapter_id, status, last_selected_at) values
      ($1,'automation-v3-visible','active',now()),
      ($2,'automation-v3-visible','active',now()),
      ($3,'automation-v3-visible','active',now()),
      ($4,'automation-v3-visible','active',now()),
      ($5,'automation-v3-visible','active',now())
  `, [ids.admin, ids.steward, ids.advisor, ids.noMfa, ids.member]);
  await client.query(`
    update public.member_profiles set chapter_id = 'automation-v3-visible'
    where id = any($1::uuid[])
  `, [[ids.admin, ids.steward, ids.advisor, ids.noMfa, ids.member]]);
  await client.query(`
    insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values
      ($1,$2,'admin',$2), ($1,$3,'advisor',$2), ($1,$4,'advisor',$2)
  `, [ids.org, ids.admin, ids.advisor, ids.noMfa]);
  await client.query(`
    insert into public.member_roles (user_id, role, chapter_id, granted_by)
    values ($1,'steward','automation-v3-visible',$2)
  `, [ids.steward, ids.admin]);
  await client.query(`
    insert into public.member_role_chapters (user_id, role, chapter_id, granted_by)
    values ($1,'steward','automation-v3-visible',$2)
  `, [ids.steward, ids.admin]);
  await client.query(`
    insert into public.org_security_policy (id, organization_id, require_staff_mfa, updated_by)
    values (true, $1, true, $2)
  `, [ids.org, ids.admin]);
  await client.query(`
    insert into auth.sessions (id, user_id, aal, created_at) values
      ($1,$1,'aal2',now()), ($2,$2,'aal2',now()), ($3,$3,'aal2',now()),
      ($4,$4,'aal1',now()), ($5,$5,'aal2',now())
  `, [ids.admin, ids.steward, ids.advisor, ids.noMfa, ids.member]);
  await client.query(`
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at) values
      ($1,$1,'totp',now(),now()), ($2,$2,'totp',now(),now()),
      ($3,$3,'totp',now(),now()), ($4,$4,'totp',now(),now())
  `, [ids.admin, ids.steward, ids.advisor, ids.member]);
  await client.query(`
    insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values
      (extensions.gen_random_uuid(),$1,'totp','verified',now(),now()),
      (extensions.gen_random_uuid(),$2,'totp','verified',now(),now()),
      (extensions.gen_random_uuid(),$3,'totp','verified',now(),now()),
      (extensions.gen_random_uuid(),$4,'totp','verified',now(),now())
  `, [ids.admin, ids.steward, ids.advisor, ids.member]);
  await asRole(client, "authenticated", ids.admin);
  await client.query("reset role");
  await client.query(`
    insert into public.chapter_workstreams (chapter_id, name, created_by) values
      ('automation-v3-visible','General',$1), ('automation-v3-hidden','General',$1)
  `, [ids.admin]);
  await client.query(`
    insert into public.chapter_tasks
      (id, chapter_id, title, status, priority, start_date, due_date, created_by, updated_by)
    values ($1,'automation-v3-visible','Visible overdue task','in_progress','medium',current_date-10,current_date-2,$2,$2)
  `, [ids.visibleTask, ids.admin]);
  await client.query("update public.member_profiles set chapter_id='automation-v3-hidden' where id=$1", [ids.admin]);
  await client.query(`
    insert into public.chapter_tasks
      (id, chapter_id, title, status, priority, start_date, due_date, created_by, updated_by)
    values ($1,'automation-v3-hidden','Hidden overdue task','in_progress','medium',current_date-10,current_date-2,$2,$2)
  `, [ids.hiddenTask, ids.admin]);
  await client.query("update public.member_profiles set chapter_id='automation-v3-visible' where id=$1", [ids.admin]);

  const checks = [];
  const rpc = async (name, values = []) => (await client.query(
    `select public.${name}(${values.map((_, index) => `$${index + 1}`).join(",")}) value`,
    values,
  )).rows[0]?.value;
  // The shipped client rejects any workspace whose capability flags are not
  // exact booleans, so every projection must survive nullable columns.
  const loadWorkspace = async (userId, role) => {
    const api = createAutomationApi({ rpc: async (name) => {
      assert(name === "mi1_get_automation_workspace", "workspace client proof is read-only");
      return { data: await rpc(name), error: null };
    } });
    const loaded = await api.getWorkspace({ authenticated: true, mfaSatisfied: true, role, userId,
      selectedOrganizationId: ids.org, selectedHat: role, organizationRoles: [role],
      membershipStatus: "active", organizationStatus: "active" });
    assert(loaded.state === "ready", `shipped client normalizes the ${role} workspace (got ${loaded.state})`);
    return loaded.control;
  };
  const spec = (name, extra = {}) => ({
    schemaVersion: 2,
    name,
    triggerKind: "overdue_task",
    thresholdDays: 1,
    taskPriority: "medium",
    cadence: "daily",
    conditions: { chapterId: "automation-v3-visible" },
    actionKind: "create_standard_task",
    actionConfig: {},
    ...extra,
  });

  await asRole(client, "authenticated", ids.steward);
  const stewardScopes = await rpc("mi1_get_automation_scope_options", ["task", null, "", 1, 6]);
  const stewardChapterIds = (stewardScopes.chapters?.rows || []).map((row) => row.id);
  assert(stewardScopes.chapters?.total === 1 && stewardChapterIds.length === 1 && stewardChapterIds[0] === "automation-v3-visible",
    `steward unscoped picker returns only the staffed chapter: ${JSON.stringify(stewardScopes.chapters)}`);
  assert(!JSON.stringify(stewardScopes).includes("automation-v3-hidden"),
    "steward unscoped picker omits the unstaffed chapter id and label");
  await expectSqlstate(client, "steward_unstaffed_chapter",
    "select public.mi1_get_automation_scope_options($1,$2,$3,$4,$5)",
    ["task", "automation-v3-hidden", "", 1, 6], "42501");
  checks.push("steward scope picker returns staffed chapter A and refuses unstaffed chapter B");

  const opportunity = await rpc("mi1_get_automation_opportunities");
  const overdue = opportunity.rows.find((row) => row.triggerKind === "overdue_task");
  assert(overdue?.candidateCount === 1 && overdue.scope === "chapter", `chapter staff sees aggregate-only opportunities in its visible chapter: ${JSON.stringify(opportunity)}`);
  assert(!JSON.stringify(opportunity).includes(ids.visibleTask) && !JSON.stringify(opportunity).includes("Visible overdue task"), "opportunities omit record identity and content");
  // UX-UG-DISCOVER-LABELS-OPPORTUNITY-SCOPE-CHAPTER-NON-APPROVER-ORG-LEVEL-20260921:
  // the scope label names the population that was counted, never the caller's
  // approval authority. The steward staffs one of the two chapters, so the call
  // is chapter-scoped and names that chapter for the draft to bind. The advisor
  // is equally not an approver but holds an organization-level grant, so the
  // same call counts both chapters and must say so.
  assert(opportunity.scopeChapterId === "automation-v3-visible",
    `a single counted chapter is named so a staff draft can bind it: ${JSON.stringify(opportunity)}`);
  await asRole(client, "authenticated", ids.advisor);
  const orgWide = await rpc("mi1_get_automation_opportunities");
  const orgWideOverdue = orgWide.rows.find((row) => row.triggerKind === "overdue_task");
  assert(orgWideOverdue?.candidateCount === 2 && orgWideOverdue.scope === "organization" && orgWide.scopeChapterId === null,
    `an organization-level grant counting every chapter is labelled organization scope: ${JSON.stringify(orgWide)}`);
  await asRole(client, "authenticated", ids.steward);
  checks.push("opportunity scope names the counted population rather than approval authority");
  const draft = await rpc("mi1_save_automation_definition_v2", [spec("Steward overdue follow-up")]);
  assert(draft.reviewStatus === "draft" && draft.canSubmit === true, "steward creates an inert scoped draft");
  const stewardDraft = (await loadWorkspace(ids.steward, "steward")).definitions.find((row) => row.id === draft.id);
  assert(stewardDraft && stewardDraft.submittedBySelf === false && stewardDraft.canEdit === true && stewardDraft.canSubmit === true
    && stewardDraft.canPreview === true && stewardDraft.canReview === false && stewardDraft.canActivate === false,
    "a never-submitted draft reaches the shipped client with exact boolean capability flags");
  const preview = await rpc("mi1_preview_automation_definition", [draft.id]);
  assert(preview.candidatesCount === 1 && /^RUN [0-9A-F]{8}$/.test(preview.confirmationPhrase), "staff preview is deterministic and explicitly confirmable");
  await expectSqlstate(client, "steward_execute", "select public.execute_organization_automation_run($1,$2)", [preview.id, preview.confirmationPhrase], "42501");
  const submitted = await rpc("mi1_submit_automation_definition", [draft.id, draft.version]);
  assert(submitted.reviewStatus === "submitted", "creator submits the exact draft version");
  await expectSqlstate(client, "steward_review", "select public.mi1_review_automation_definition($1,$2,'approve',null)", [draft.id, draft.version], "42501");
  checks.push("chapter-scoped staff discovery, draft, preview, and submit without execution authority");

  // The paged list and detail reads answer a non-approver author with the
  // same rows the workspace does: own and shared-visible definitions, and
  // only the runs the steward started.
  await asRole(client, "authenticated", ids.admin);
  const hiddenDraft = await rpc("mi1_save_automation_definition_v2", [spec("Hidden chapter admin draft", {
    conditions: { chapterId: "automation-v3-hidden" },
  })]);
  const adminHiddenPreview = await rpc("mi1_preview_automation_definition", [hiddenDraft.id]);
  await asRole(client, "authenticated", ids.steward);
  const stewardList = await rpc("mi1_get_automation_definitions", [1, 20, "", null]);
  const stewardListIds = stewardList.rows.map((row) => row.id);
  assert(stewardList.total === 1 && stewardListIds.length === 1 && stewardListIds[0] === draft.id,
    `steward definition list returns only the steward's own draft: ${JSON.stringify(stewardListIds)}`);
  const stewardDetail = await rpc("mi1_get_automation_definition", [draft.id]);
  assert(stewardDetail.definition.id === draft.id && stewardDetail.definition.reviewStatus === "submitted"
    && stewardDetail.definition.submittedBySelf === true && stewardDetail.definition.canReview === false,
  `steward definition detail carries the review projection: ${JSON.stringify(stewardDetail.definition)}`);
  await expectSqlstate(client, "steward_hidden_definition", "select public.mi1_get_automation_definition($1)", [hiddenDraft.id], "42501");
  const stewardRuns = await rpc("mi1_get_automation_runs", [1, 20, null, null, null, null]);
  assert(stewardRuns.total === 1 && stewardRuns.rows.length === 1 && stewardRuns.rows[0].id === preview.id,
    `steward run list returns only the steward's own preview: ${JSON.stringify(stewardRuns.rows.map((row) => row.id))}`);
  const stewardRun = await rpc("mi1_get_automation_run", [preview.id, 1, 6]);
  assert(stewardRun.run.id === preview.id, "steward opens its own run detail");
  await expectSqlstate(client, "steward_other_run", "select public.mi1_get_automation_run($1,1,6)", [adminHiddenPreview.id], "42501");
  await expectSqlstate(client, "steward_hidden_definition_runs", "select public.mi1_get_automation_runs(1,20,$1,null,null,null)", [hiddenDraft.id], "42501");
  await asRole(client, "authenticated", ids.admin);
  const adminList = await rpc("mi1_get_automation_definitions", [1, 20, "", null]);
  assert(adminList.total === 2 && [draft.id, hiddenDraft.id].every((id) => adminList.rows.some((row) => row.id === id)),
    "an approver still lists every definition in the organization");
  const adminRuns = await rpc("mi1_get_automation_runs", [1, 20, null, null, null, null]);
  assert(adminRuns.total === 2 && [preview.id, adminHiddenPreview.id].every((id) => adminRuns.rows.some((row) => row.id === id)),
    "an approver still lists every run in the organization");
  const adminStewardRun = await rpc("mi1_get_automation_run", [preview.id, 1, 6]);
  assert(adminStewardRun.run.id === preview.id, "an approver opens a steward-started run");
  await asRole(client, "authenticated", ids.member);
  await expectSqlstate(client, "member_definitions", "select public.mi1_get_automation_definitions()", [], "42501");
  await expectSqlstate(client, "member_runs", "select public.mi1_get_automation_runs()", [], "42501");
  checks.push("list and detail reads answer a steward with its own definitions and runs while an approver still sees the organization");

  await asRole(client, "authenticated", ids.admin);
  const approved = await rpc("mi1_review_automation_definition", [draft.id, draft.version, "approve", null]);
  assert(approved.reviewStatus === "approved" && approved.reviewVersion === draft.version, "admin approval binds the exact submitted version");
  const active = await rpc("set_organization_automation_definition_status", [draft.id, "active", draft.version]);
  assert(active.status === "active" && active.version === draft.version, "only an approved current version activates");
  await rpc("set_organization_automation_enabled", [true, "ENABLE AUTOMATION"]);
  const adminPreview = await rpc("mi1_preview_automation_definition", [draft.id]);
  const executed = await rpc("execute_organization_automation_run", [adminPreview.id, adminPreview.confirmationPhrase]);
  assert(["succeeded", "partial", "no_op"].includes(executed.status), "approver can execute only from an explicit current preview");
  checks.push("exact-version approval, activation, and explicitly confirmed deterministic execution");

  const edited = await rpc("mi1_save_automation_definition_v2", [spec("Steward overdue follow-up revised", {
    id: draft.id,
    expectedVersion: draft.version,
  })]);
  assert(edited.version === draft.version + 1 && edited.reviewStatus === "draft" && edited.reviewVersion === null, "editing invalidates prior approval");
  const adminEdited = (await loadWorkspace(ids.admin, "admin")).definitions.find((row) => row.id === draft.id);
  assert(adminEdited && adminEdited.reviewStatus === "draft" && adminEdited.canActivate === false && adminEdited.canReview === false,
    "the approver's workspace normalizes an edited definition with its approval invalidated");
  await expectSqlstate(client, "stale_approval", "select public.set_organization_automation_definition_status($1,'active',$2)", [draft.id, edited.version], "PT409");
  checks.push("content edits invalidate approval and block stale activation");

  const selfDraft = await rpc("mi1_save_automation_definition_v2", [spec("Admin self-reviewed automation")]);
  await rpc("mi1_submit_automation_definition", [selfDraft.id, selfDraft.version]);
  const selfApproved = await rpc("mi1_review_automation_definition", [selfDraft.id, selfDraft.version, "approve", "Reviewed against current capacity"]);
  assert(selfApproved.reviewStatus === "approved", "admin self-review remains explicit rather than implicit");
  await client.query("reset role");
  const reviewRows = (await client.query(`
    select action, actor_id, definition_version, snapshot_digest
    from public.organization_automation_definition_reviews
    where definition_id = $1 order by created_at, id
  `, [selfDraft.id])).rows;
  assert(reviewRows.length === 2
    && reviewRows.filter((row) => row.action === "submitted").length === 1
    && reviewRows.filter((row) => row.action === "approved").length === 1,
  "review history records explicit submission and approval");
  assert(reviewRows.every((row) => row.actor_id === ids.admin && row.definition_version === selfDraft.version && /^[0-9a-f]{64}$/.test(row.snapshot_digest)), "self-review is actor, version, and digest bound");
  await expectSqlstate(client, "review_update", "update public.organization_automation_definition_reviews set note='rewrite' where definition_id=$1", [selfDraft.id], "55000");
  await expectSqlstate(client, "review_delete", "delete from public.organization_automation_definition_reviews where definition_id=$1", [selfDraft.id], "55000");
  checks.push("explicit self-review is fully attributable and review history is append-only");

  await client.query("update public.organization_automation_definitions set created_by = null where id = $1", [selfDraft.id]);
  await asRole(client, "authenticated", ids.steward);
  const orphaned = (await loadWorkspace(ids.steward, "steward")).definitions.find((row) => row.id === selfDraft.id);
  assert(orphaned && orphaned.canEdit === false && orphaned.canSubmit === false && orphaned.submittedBySelf === false
    && orphaned.canPreview === true, "a definition whose author account was deleted still normalizes with false, not null, flags");
  checks.push("nullable author and submitter columns never leak SQL null into client capability flags");

  await asRole(client, "authenticated", ids.advisor);
  const advisorWorkspace = await rpc("mi1_get_automation_workspace");
  assert(advisorWorkspace.access.canAuthor === true && advisorWorkspace.access.canApprove === false, "advisor gets shared authoring without operator authority");
  await asRole(client, "authenticated", ids.noMfa, "aal1");
  await expectSqlstate(client, "no_mfa", "select public.mi1_get_automation_ai_authorization()", [], "42501");
  await asRole(client, "authenticated", ids.member);
  await expectSqlstate(client, "member_workspace", "select public.mi1_get_automation_workspace()", [], "42501");
  checks.push("active staff, selected organization, and MFA gate shared authoring while members remain excluded");

  // PERF-UG-MI1-GET-AUTOMATION-WORKSPACE-SCANS-ORGANIZATION-AUTOMATION-20260921.
  // 20260911070000:452 selected the workspace definitions page with the
  // visibility function as its ONLY predicate, so the tenant bound was hidden
  // inside a SECURITY DEFINER call the planner treats as opaque: every other
  // organization's definition row was read and cost one visibility call, which
  // in turn derived the approver through a six-table author EXISTS.
  // 20260924181000 puts `d.organization_id = org` beside it. Counting the
  // per-row definer calls is the direct measurement of that: the page's cost
  // must not move when a foreign tenant grows.
  //
  // TEST-UG-SHARED-INTELLIGENCE-WORKSPACE-READ-PLAN-CHECK-FLAKES-IN-SHARED-FIXTURES-20260925.
  // This proof shares one stack with every other shared-fixtures proof, so the
  // planner's picture of organization_automation_definitions is whatever the
  // earlier proofs and autovacuum left. A VACUUM that meets another proof's
  // open transaction skips truncation and records relpages > 0 with
  // reltuples = 0; the planner then costs the table as one row at any size and
  // may seq-scan it in both readings. The second reading is also the
  // function's sixth call in this session, the first a generic plan may serve.
  // A count of sequentially read rows under free planning therefore measured
  // the stack's history, not this SQL. Every check below holds whatever those
  // statistics are:
  // - the per-row definer calls stay an equality: in any plan the cheap tenant
  //   equality is tested before the costly call;
  // - sequential scans are priced out (enable_seqscan = off asks whether an
  //   index path EXISTS, which is the fact that regressed) and every call is
  //   planned for its own values, so the whole RPC must read the table
  //   sequentially zero times in both readings;
  // - the installed function's own definitions-page statement, planned as a
  //   custom and as a generic plan, must reach the table only through an
  //   organization_id index condition and examine the same rows before and
  //   after the foreign tenant grows. Any organization-leading index proves the
  //   bound; which one wins (review_idx or org_id_key) is again a statistics
  //   decision.
  await client.query("reset role");
  await client.query("set local track_functions = 'all'");
  await client.query("set local enable_seqscan = off");
  await client.query("set local plan_cache_mode = force_custom_plan");
  const definerCalls = async () => {
    const row = (await client.query(`
      select
        pg_stat_get_xact_function_calls(
          'private.automation_v3_definition_visible(public.organization_automation_definitions,uuid,uuid,boolean)'::regprocedure
        ) as visible,
        pg_stat_get_xact_function_calls(
          'private.automation_v3_actor_is_author(uuid,uuid)'::regprocedure
        ) as author,
        pg_stat_get_xact_tuples_returned(
          'public.organization_automation_definitions'::regclass
        ) as sequential_rows
    `)).rows[0];
    return {
      visible: Number(row.visible),
      author: Number(row.author),
      sequentialRows: Number(row.sequential_rows),
    };
  };
  const workspaceCost = async () => {
    await asRole(client, "authenticated", ids.steward);
    const opened = await definerCalls();
    const workspace = await rpc("mi1_get_automation_workspace");
    const closed = await definerCalls();
    await client.query("reset role");
    return {
      definitions: workspace.definitions.map((row) => row.id).sort(),
      visible: closed.visible - opened.visible,
      author: closed.author - opened.author,
      sequentialRows: closed.sequentialRows - opened.sequentialRows,
    };
  };
  // The definitions page exactly as the installed function runs it, with its
  // plpgsql variables bound as parameters.
  const installedWorkspace = (await client.query(
    "select prosrc from pg_catalog.pg_proc where oid = 'public.mi1_get_automation_workspace()'::regprocedure",
  )).rows[0].prosrc;
  const pageStart = installedWorkspace.indexOf("select * from public.organization_automation_definitions d");
  const pageEnd = installedWorkspace.indexOf("limit 100", pageStart);
  assert(pageStart >= 0 && pageEnd > pageStart,
    "the installed workspace function still selects its definitions page from organization_automation_definitions");
  const pageStatement = installedWorkspace.slice(pageStart, pageEnd + "limit 100".length)
    .replace(/\borg\b/g, () => "$1::uuid")
    .replace(/\bactor\b/g, () => "$2::uuid")
    .replace(/\bapprover\b/g, () => "$3::boolean");
  const definitionNodes = (plan) => {
    const nodes = [];
    const walk = (node) => {
      if (node["Relation Name"] === "organization_automation_definitions"
        || String(node["Index Name"] ?? "").startsWith("organization_automation_definitions_")) nodes.push(node);
      (node.Plans || []).forEach(walk);
    };
    walk(plan[0].Plan);
    return nodes;
  };
  const tenantBounded = (plan) => {
    const nodes = definitionNodes(plan);
    const indexNodes = nodes.filter((node) => ["Index Scan", "Index Only Scan", "Bitmap Index Scan"].includes(node["Node Type"]));
    return indexNodes.length > 0
      && nodes.every((node) => node["Node Type"] !== "Seq Scan")
      && indexNodes.every((node) => String(node["Index Cond"] ?? "").startsWith("(organization_id = "));
  };
  const pagePlan = async () => {
    const custom = (await client.query(
      `explain (analyze, costs off, timing off, summary off, format json) ${pageStatement}`,
      [ids.org, ids.steward, false],
    )).rows[0]["QUERY PLAN"];
    const generic = (await client.query(`explain (generic_plan, costs off, format json) ${pageStatement}`)).rows[0]["QUERY PLAN"];
    const examined = definitionNodes(custom)
      .filter((node) => ["Seq Scan", "Index Scan", "Index Only Scan", "Bitmap Heap Scan"].includes(node["Node Type"]))
      .reduce((sum, node) => sum + (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)
        + (node["Rows Removed by Index Recheck"] ?? 0)) * node["Actual Loops"], 0);
    return {
      bounded: tenantBounded(custom) && tenantBounded(generic),
      examined,
      indexes: [...new Set([custom, generic].flatMap(definitionNodes).map((node) => node["Index Name"]).filter(Boolean))],
      plans: { custom, generic },
    };
  };
  const beforeGrowth = await workspaceCost();
  const pageBefore = await pagePlan();
  assert(beforeGrowth.visible > 0 && beforeGrowth.author > 0,
    `the per-transaction definer call counters must be live (got ${JSON.stringify(beforeGrowth)})`);
  await client.query("insert into auth.users (id, email) values ($1, 'automation-v3-other-tenant@example.invalid')", [ids.otherAdmin]);
  await client.query(`
    insert into public.organizations (id, slug, name, status, created_by)
    values ($1, 'automation-v3-other-tenant', 'Automation v3 other tenant', 'active', $2)
  `, [ids.otherOrg, ids.otherAdmin]);
  await client.query(`
    insert into public.organization_automation_definitions
      (organization_id, name, trigger_kind, threshold_days, action_kind, task_priority, cadence, status, review_status, created_by, updated_by)
    select $1, 'Other tenant automation ' || g, 'overdue_task', 1, 'create_standard_task', 'medium', 'daily', 'draft', 'draft', $2, $2
    from pg_catalog.generate_series(1, 200) g
  `, [ids.otherOrg, ids.otherAdmin]);
  // The definer-call and author-probe deltas must be EQUAL: those are the
  // per-row costs the missing predicate multiplied. With sequential scans
  // priced out, a statement reads the table sequentially only when no index
  // path exists at all, so any such read fails.
  const afterGrowth = await workspaceCost();
  const pageAfter = await pagePlan();
  assert(JSON.stringify(afterGrowth.definitions) === JSON.stringify(beforeGrowth.definitions),
    "the workspace page still returns exactly the caller's own tenant definitions");
  assert(afterGrowth.visible === beforeGrowth.visible
    && afterGrowth.author === beforeGrowth.author
    && beforeGrowth.sequentialRows === 0
    && afterGrowth.sequentialRows === 0,
  `the workspace read must not scale with another tenant's definitions: ${JSON.stringify(beforeGrowth)} -> ${JSON.stringify(afterGrowth)}`);
  // The explicit equality is what makes an organization-leading index
  // reachable at all.
  assert(pageBefore.bounded && pageAfter.bounded,
    `the installed definitions page must reach organization_automation_definitions only by an organization_id index condition, as a custom and as a generic plan: ${JSON.stringify({ before: pageBefore.plans, after: pageAfter.plans })}`);
  assert(pageBefore.examined > 0 && pageAfter.examined === pageBefore.examined,
    `the installed definitions page must examine the same rows when another tenant grows: ${pageBefore.examined} -> ${pageAfter.examined}`);
  // The zeros above are evidence only if the counter is live: with every index
  // path priced out, a plain count must register exactly the rows it read.
  for (const setting of ["enable_indexscan", "enable_indexonlyscan", "enable_bitmapscan"]) {
    await client.query(`set local ${setting} = off`);
  }
  await client.query("set local enable_seqscan = on");
  await client.query("set local max_parallel_workers_per_gather = 0");
  const probeOpened = await definerCalls();
  const probeRows = Number((await client.query("select count(*) as n from public.organization_automation_definitions")).rows[0].n);
  const probeClosed = await definerCalls();
  assert(probeRows >= 203 && probeClosed.sequentialRows - probeOpened.sequentialRows === probeRows,
    `the sequential-row counter must be live (counted ${probeRows}, registered ${probeClosed.sequentialRows - probeOpened.sequentialRows})`);
  checks.push(`the workspace definitions page is tenant-bounded before the per-row visibility call: ${beforeGrowth.visible} definer calls, 0 sequentially read rows and ${pageBefore.examined} examined page rows with 200 foreign definitions added, through ${pageAfter.indexes.join(", ")} as a custom and a generic plan`);

  await client.query("rollback");
  const restored = await fixtureResidue();
  assert(restored.organizations === 0 && restored.definitions === 0 && restored.users === 0,
    "proof transaction must leave no fixture identities behind");
  console.log(JSON.stringify({ status: "passed", checks, fixtureBoundary: "isolated local transaction rolled back" }));
} finally {
  await client.query("rollback").catch(() => {});
  await client.end();
}
