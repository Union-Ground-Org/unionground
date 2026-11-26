// REQ-UG-CASEWORK-CONSOLE-54-CASE-DASHBOARDS-20260917
//
// Behavioural proof for the five case-dashboard aggregates in
// supabase/migrations/20260917142000_case_dashboard_aggregates.sql.
//
// Text pins can show that a function says `security definer` and names
// private.casework_staff_can_access. They cannot show that the aggregate it
// returns actually EXCLUDES another tenant's chapter, a restricted case the
// caller holds no grant for, or the cases a steward was never assigned — and
// those three are the whole reason the tiles are computed server-side. So the
// scope is proved against a real apply, per caller, per tile.
import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";

const { Client } = pg;
const databaseUrl = assertDisposableProofUrl(
  requireDatabaseUrl("SUPABASE_DB_URL", { aliases: ["DATABASE_URL"] }),
);

const ids = {
  admin: "50954000-0000-4000-8000-000000000001",
  coordinator: "50954000-0000-4000-8000-000000000002",
  steward: "50954000-0000-4000-8000-000000000003",
  plainMember: "50954000-0000-4000-8000-000000000004",
  outsider: "50954000-0000-4000-8000-000000000005",
  memberA: "50954000-0000-4000-8000-000000000011",
  memberB: "50954000-0000-4000-8000-000000000012",
  memberC: "50954000-0000-4000-8000-000000000013",
  memberD: "50954000-0000-4000-8000-000000000014",
  foreignOrg: "50954000-0000-4000-8000-0000000000f1",
  bootstrapKey: "50954000-0000-4000-8000-0000000000b1",
  caseOpenA: "50954000-0000-4000-8000-0000000000c1",
  caseOpenB: "50954000-0000-4000-8000-0000000000c2",
  caseOpenC: "50954000-0000-4000-8000-0000000000c3",
  caseRestricted: "50954000-0000-4000-8000-0000000000c4",
  caseResolved: "50954000-0000-4000-8000-0000000000c5",
  caseForeign: "50954000-0000-4000-8000-0000000000c6",
};

const CHAPTER = "p554";
const FOREIGN_CHAPTER = "p554-foreign";
const checks = [];

function assert(value, message) {
  if (!value) throw new Error(message);
}

function record(message) {
  checks.push(message);
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
    throw new Error(`${label}: expected SQLSTATE ${state}, the call succeeded`);
  } catch (error) {
    assert(
      error.code === state,
      `${label}: expected SQLSTATE ${state}, got ${error.code || error.message}`,
    );
  } finally {
    await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
  }
}

const client = new Client({
  connectionString: databaseUrl,
  application_name: "case-dashboard-aggregates-proof",
});

async function rows(sql, values = []) {
  return (await client.query(sql, values)).rows;
}

async function verifiedIdentity(userId, email) {
  await client.query("insert into auth.users (id, email) values ($1, $2)", [userId, email]);
  await client.query(
    "insert into auth.sessions (id, user_id, aal, created_at) values ($1, $1, 'aal2', now())",
    [userId],
  );
  await client.query(
    `insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
     values ($1, $1, 'totp', now(), now())`,
    [userId],
  );
  await client.query(
    `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
     values (extensions.gen_random_uuid(), $1, 'p554-proof', 'totp', 'verified', now(), now())`,
    [userId],
  );
}

try {
  await client.connect();
  await client.query("begin");

  // ---------------------------------------------------------------------
  // Tenant A: the chapter whose dashboards are under proof.
  // ---------------------------------------------------------------------
  await verifiedIdentity(ids.admin, "p554-admin@example.invalid");
  await asRole(client, "service_role");
  const bootstrap = (await rows(
    `select public.bootstrap_first_organization(
       'Lane 5.4 dashboards proof', 'p554-dashboards', $1,
       $2, 'Lane 5.4 proof chapter', $2, $3
     ) as value`,
    [ids.admin, CHAPTER, ids.bootstrapKey],
  ))[0].value;
  const organizationId = bootstrap.organizationId;
  assert(organizationId && bootstrap.chapterId === CHAPTER, "bootstrap must create the proof tenant");

  await client.query("reset role");
  for (const [userId, email] of [
    [ids.coordinator, "p554-coordinator@example.invalid"],
    [ids.steward, "p554-steward@example.invalid"],
    [ids.plainMember, "p554-member@example.invalid"],
    [ids.memberA, "p554-a@example.invalid"],
    [ids.memberB, "p554-b@example.invalid"],
    [ids.memberC, "p554-c@example.invalid"],
    [ids.memberD, "p554-d@example.invalid"],
  ]) await verifiedIdentity(userId, email);

  for (const userId of [
    ids.coordinator, ids.steward, ids.plainMember,
    ids.memberA, ids.memberB, ids.memberC, ids.memberD,
  ]) {
    await client.query(
      "insert into public.organization_memberships(organization_id,user_id) values($1,$2)",
      [organizationId, userId],
    );
    await client.query(
      "insert into public.member_chapter_memberships(user_id,chapter_id,status,last_selected_at) values($1,$2,'active',now())",
      [userId, CHAPTER],
    );
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [userId, CHAPTER]);
  }
  await client.query(
    `insert into public.member_roles(user_id, role, chapter_id)
     values ($1,'coordinator',$2), ($3,'steward',$2), ($4,'admin',$2)`,
    [ids.coordinator, CHAPTER, ids.steward, ids.admin],
  );
  // member_has_role and actor_has_chapter_staff_role both resolve a staff hat
  // through member_role_chapters (20260821010000), not through member_roles
  // alone; a fixture that seeds only the latter proves nothing about a real
  // staff session.
  await client.query(
    `insert into public.member_role_chapters(user_id, role, chapter_id, granted_by)
     values ($1,'coordinator',$2,$5), ($3,'steward',$2,$5), ($4,'admin',$2,$5)`,
    [ids.coordinator, CHAPTER, ids.steward, ids.admin, ids.admin],
  );

  // ---------------------------------------------------------------------
  // Tenant B: a second organization whose casework must never be counted.
  // ---------------------------------------------------------------------
  await verifiedIdentity(ids.outsider, "p554-outsider@example.invalid");
  await client.query(
    `insert into public.organizations (id, slug, name, status, created_by)
     values ($1, 'p554-foreign', 'Lane 5.4 foreign tenant', 'active', $2)`,
    [ids.foreignOrg, ids.outsider],
  );
  await client.query(
    `insert into public.chapters (id, name, is_default, order_index, organization_id, slug)
     values ($1, 'Lane 5.4 foreign chapter', true, 1, $2, $1)`,
    [FOREIGN_CHAPTER, ids.foreignOrg],
  );
  await client.query(
    "insert into public.organization_memberships (organization_id, user_id) values ($1,$2)",
    [ids.foreignOrg, ids.outsider],
  );
  await client.query(
    "insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1,$2,'admin',$2)",
    [ids.foreignOrg, ids.outsider],
  );
  await client.query(
    "insert into public.member_chapter_memberships (user_id, chapter_id, status, last_selected_at) values ($1,$2,'active',now())",
    [ids.outsider, FOREIGN_CHAPTER],
  );
  await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [ids.outsider, FOREIGN_CHAPTER]);
  await client.query(
    "insert into public.member_roles(user_id, role, chapter_id) values ($1,'coordinator',$2)",
    [ids.outsider, FOREIGN_CHAPTER],
  );
  await client.query(
    "insert into public.member_role_chapters(user_id, role, chapter_id, granted_by) values ($1,'coordinator',$2,$1)",
    [ids.outsider, FOREIGN_CHAPTER],
  );

  // ---------------------------------------------------------------------
  // Casework fixtures.
  // ---------------------------------------------------------------------
  const seedCase = async (id, ownerId, reference, step, status, chapterId, orgId) => {
    await client.query(
      `insert into public.member_cases(id,user_id,reference,title,case_type,step,status,chapter_id,organization_id,created_at)
       values($1,$2,$3,'Lane 5.4 proof case','grievance',$4,$5,$6,$7, now() - interval '40 days')`,
      [id, ownerId, reference, step, status, chapterId, orgId],
    );
  };
  await seedCase(ids.caseOpenA, ids.memberA, "P554-1", "Step 1", "active", CHAPTER, organizationId);
  await seedCase(ids.caseOpenB, ids.memberB, "P554-2", "Step 2", "active", CHAPTER, organizationId);
  await seedCase(ids.caseOpenC, ids.memberC, "P554-3", "Step 2", "active", CHAPTER, organizationId);
  await seedCase(ids.caseResolved, ids.memberD, "P554-4", "Step 3", "resolved", CHAPTER, organizationId);
  await seedCase(ids.caseForeign, ids.outsider, "P554-F", "Step 1", "active", FOREIGN_CHAPTER, ids.foreignOrg);

  // The restricted case: owned by a member the coordinator can otherwise see,
  // restricted with no access grant for either staff caller.
  await seedCase(ids.caseRestricted, ids.memberD, "P554-5", "Step 4", "active", CHAPTER, organizationId);
  // Restriction is set the way the product sets it — through the suite's own
  // definer RPC as an authorized organization admin — so the fixture cannot
  // accidentally prove a state the application could never reach.
  await asRole(client, "authenticated", ids.admin);
  await client.query(
    "select public.casework_set_restriction($1, true, 'Lane 5.4 dashboard scope proof')",
    [ids.caseRestricted],
  );
  await client.query("reset role");

  // The steward is assigned exactly one open case; the coordinator is assigned
  // a different one. Neither is assigned the restricted case.
  await client.query(
    "update public.member_cases set steward_user_id=$2, steward_name='Proof Steward' where id=$1",
    [ids.caseOpenA, ids.steward],
  );
  await client.query(
    "update public.member_cases set coordinator_user_id=$2, coordinator_name='Proof Coordinator' where id=$1",
    [ids.caseOpenB, ids.coordinator],
  );

  // Deadlines: two inside the seven-day window, one just outside it, two
  // already missed, and one belonging to the other tenant.
  const seedDeadline = async (caseId, orgId, chapterId, kind, interval, status = "active") => {
    await client.query(
      `insert into public.casework_deadlines(case_id,organization_id,chapter_id,kind,label,due_at,status,created_by)
       values($1,$2,$3,$4,'Lane 5.4 proof deadline', now() + $5::interval, $6, $7)`,
      [caseId, orgId, chapterId, kind, interval, status, ids.admin],
    );
  };
  await seedDeadline(ids.caseOpenA, organizationId, CHAPTER, "filing", "2 days");
  await seedDeadline(ids.caseOpenB, organizationId, CHAPTER, "response", "6 days");
  await seedDeadline(ids.caseOpenC, organizationId, CHAPTER, "hearing", "9 days");
  await seedDeadline(ids.caseOpenA, organizationId, CHAPTER, "filing", "-3 days");
  await seedDeadline(ids.caseOpenC, organizationId, CHAPTER, "appeal", "-10 days");
  await seedDeadline(ids.caseRestricted, organizationId, CHAPTER, "filing", "-1 days");
  await seedDeadline(ids.caseForeign, ids.foreignOrg, FOREIGN_CHAPTER, "filing", "1 days");
  await seedDeadline(ids.caseForeign, ids.foreignOrg, FOREIGN_CHAPTER, "appeal", "-5 days");

  // Step transitions: two in-window hops on one case plus an out-of-window hop
  // whose timestamp is what the second in-window hop must measure from, and a
  // foreign-tenant hop that must never reach the median.
  const seedTransition = async (caseId, orgId, chapterId, fromStep, toStep, ageDays) => {
    await client.query(
      `insert into public.casework_step_transitions(case_id,organization_id,chapter_id,from_step,to_step,outcome,transitioned_by,idempotency_key,created_at)
       values($1,$2,$3,$4,$5,'Lane 5.4 proof transition',$6,extensions.gen_random_uuid(), now() - ($7::text || ' days')::interval)`,
      [caseId, orgId, chapterId, fromStep, toStep, ids.admin, ageDays],
    );
  };
  // Case A: entered Step 1 at case creation (40 days ago), left it 30 days ago
  // -> 10 days in Step 1; then left Step 2 20 days ago -> 10 days in Step 2.
  await seedTransition(ids.caseOpenA, organizationId, CHAPTER, "Step 1", "Step 2", 30);
  await seedTransition(ids.caseOpenA, organizationId, CHAPTER, "Step 2", "Step 3", 20);
  // Case B: left Step 1 four days ago, having entered it at creation.
  await seedTransition(ids.caseOpenB, organizationId, CHAPTER, "Step 1", "Step 2", 4);
  // Out of the 90-day window entirely.
  await seedTransition(ids.caseOpenC, organizationId, CHAPTER, "Step 1", "Step 2", 200);
  await seedTransition(ids.caseForeign, ids.foreignOrg, FOREIGN_CHAPTER, "Step 1", "Step 2", 5);

  const byStep = "select * from public.casework_dashboard_open_cases_by_step()";
  const dueSoon = "select * from public.casework_dashboard_deadlines_due_soon()";
  const overdue = "select * from public.casework_dashboard_overdue_deadlines()";
  const byAssignee = "select * from public.casework_dashboard_open_cases_by_assignee()";
  const medians = "select * from public.casework_dashboard_median_days_per_step()";

  // ---------------------------------------------------------------------
  // 1. The coordinator's five tiles.
  // ---------------------------------------------------------------------
  await asRole(client, "authenticated", ids.coordinator);
  const steps = await rows(byStep);
  const stepCounts = Object.fromEntries(steps.map((row) => [row.step, Number(row.case_count)]));
  assert(stepCounts["Step 1"] === 1 && stepCounts["Step 2"] === 2,
    `coordinator step counts wrong: ${JSON.stringify(stepCounts)}`);
  assert(!("Step 3" in stepCounts), "a resolved case must not appear in the open-case step tile");
  assert(!("Step 4" in stepCounts), "a restricted case without a grant must not appear in the step tile");
  record("open cases by step counts only the caller's chapter, only active cases, and excludes ungranted restricted cases");

  const soon = await rows(dueSoon);
  const soonBuckets = soon.map((row) => Number(row.days_out)).sort((a, b) => a - b);
  assert(soonBuckets.length === 2 && soonBuckets[0] === 2 && soonBuckets[1] === 6,
    `due-soon buckets wrong: ${JSON.stringify(soon)}`);
  assert(soon.every((row) => Number(row.deadline_count) === 1 && Number(row.case_count) === 1),
    "each due-soon bucket holds exactly its own deadline");
  record("deadlines due soon covers exactly the next seven days and drops the ninth-day deadline and the other tenant's");

  const missed = await rows(overdue);
  const missedKinds = Object.fromEntries(missed.map((row) => [row.kind, Number(row.deadline_count)]));
  assert(missedKinds.filing === 1 && missedKinds.appeal === 1 && Object.keys(missedKinds).length === 2,
    `overdue kinds wrong: ${JSON.stringify(missedKinds)}`);
  assert(missed.every((row) => row.oldest_due_at instanceof Date), "overdue rows carry their oldest due date");
  record("overdue deadlines counts the caller's missed deadlines only, and never the restricted case's or the foreign tenant's");

  const assignees = await rows(byAssignee);
  const assigneeKey = (row) => `${row.assignee_role}:${row.assignee_name || "-"}`;
  const assigneeCounts = Object.fromEntries(assignees.map((row) => [assigneeKey(row), Number(row.case_count)]));
  assert(assigneeCounts["steward:Proof Steward"] === 1, `steward assignment count wrong: ${JSON.stringify(assigneeCounts)}`);
  assert(assigneeCounts["coordinator:Proof Coordinator"] === 1, `coordinator assignment count wrong: ${JSON.stringify(assigneeCounts)}`);
  assert(assigneeCounts["unassigned:-"] === 1, `unassigned bucket wrong: ${JSON.stringify(assigneeCounts)}`);
  assert(assignees.find((row) => row.assignee_role === "steward").assignee_user_id === ids.steward,
    "the assignee tile returns the assignment's own user id for the deep link");
  record("open cases per assignee counts steward and coordinator assignments separately and names the unassigned remainder");

  const median = await rows(medians);
  const medianByStep = Object.fromEntries(median.map((row) => [row.step, Number(row.median_days)]));
  const countByStep = Object.fromEntries(median.map((row) => [row.step, Number(row.transition_count)]));
  assert(countByStep["Step 1"] === 2 && countByStep["Step 2"] === 1,
    `median transition counts wrong: ${JSON.stringify(countByStep)}`);
  assert(Math.abs(medianByStep["Step 1"] - 23) < 0.05,
    `Step 1 median should be the midpoint of 10 and 36 days, got ${medianByStep["Step 1"]}`);
  assert(Math.abs(medianByStep["Step 2"] - 10) < 0.05,
    `Step 2 must be measured from the transition that entered it, got ${medianByStep["Step 2"]}`);
  record("median days per step measures from the entering transition, honours the 90-day window, and excludes the other tenant");

  // ---------------------------------------------------------------------
  // 2. Leadership controls steward visibility. The October 31 ruling makes
  // all ordinary grievances in scope the default; switching it off restores
  // the earlier assignment-only view without exposing restricted cases.
  // ---------------------------------------------------------------------
  await asRole(client, "authenticated", ids.steward);
  const defaultStewardSteps = await rows(byStep);
  assert(defaultStewardSteps.reduce((total, row) => total + Number(row.case_count), 0) === 3
    && !defaultStewardSteps.some((row) => row.step === "Step 4"),
    `default steward scope covers ordinary chapter cases only, got ${JSON.stringify(defaultStewardSteps)}`);
  record("the default steward tiles cover ordinary chapter grievances and keep restricted cases private");
  await asRole(client, "authenticated", ids.admin);
  await client.query("select public.set_chapter_access_policy($1,false,'chapter')", [CHAPTER]);
  await asRole(client, "authenticated", ids.steward);
  const stewardSteps = await rows(byStep);
  assert(stewardSteps.length === 1 && stewardSteps[0].step === "Step 1" && Number(stewardSteps[0].case_count) === 1,
    `a steward must see only assigned cases, got ${JSON.stringify(stewardSteps)}`);
  const stewardAssignees = await rows(byAssignee);
  assert(stewardAssignees.length === 1 && stewardAssignees[0].assignee_role === "steward",
    `a steward's assignee tile must not enumerate the chapter, got ${JSON.stringify(stewardAssignees)}`);
  const stewardOverdue = await rows(overdue);
  assert(stewardOverdue.length === 1 && stewardOverdue[0].kind === "filing",
    `a steward's overdue tile must stay assignee-scoped, got ${JSON.stringify(stewardOverdue)}`);
  record("the steward's tiles stay assignee-scoped rather than widening to the chapter");
  await asRole(client, "authenticated", ids.admin);
  await client.query("select public.set_chapter_access_policy($1,true,'chapter')", [CHAPTER]);

  // ---------------------------------------------------------------------
  // 3. Non-staff callers and the other tenant.
  // ---------------------------------------------------------------------
  await asRole(client, "authenticated", ids.plainMember);
  for (const [label, sql] of [
    ["member_by_step", byStep], ["member_due_soon", dueSoon], ["member_overdue", overdue],
    ["member_by_assignee", byAssignee], ["member_medians", medians],
  ]) await expectSqlstate(client, label, sql, [], "42501");
  record("a member without a chapter staff role is refused every dashboard aggregate with 42501");

  await asRole(client, "authenticated", ids.outsider);
  const foreignSteps = await rows(byStep);
  assert(foreignSteps.length === 1 && Number(foreignSteps[0].case_count) === 1,
    `the other tenant must see only its own chapter, got ${JSON.stringify(foreignSteps)}`);
  const foreignMedian = await rows(medians);
  assert(foreignMedian.length === 1 && Number(foreignMedian[0].transition_count) === 1,
    `the other tenant's median must contain only its own transition, got ${JSON.stringify(foreignMedian)}`);
  record("a coordinator in a second organization reads that organization's casework and nothing of the first's");

  await asRole(client, "anon");
  for (const [label, sql] of [
    ["anon_by_step", byStep], ["anon_due_soon", dueSoon], ["anon_overdue", overdue],
    ["anon_by_assignee", byAssignee], ["anon_medians", medians],
  ]) await expectSqlstate(client, label, sql, [], "42501");
  record("anon holds no execute privilege on any of the five aggregates");

  // ---------------------------------------------------------------------
  // 4. A restricted case returns to the tile when a grant is issued.
  // ---------------------------------------------------------------------
  await client.query("reset role");
  await client.query(
    `insert into public.casework_access_grants(case_id, organization_id, chapter_id, grantee_user_id, granted_by, reason)
     values ($1, $2, $3, $4, $5, 'Lane 5.4 dashboard grant proof')`,
    [ids.caseRestricted, organizationId, CHAPTER, ids.coordinator, ids.admin],
  );
  await asRole(client, "authenticated", ids.coordinator);
  const grantedSteps = await rows(byStep);
  assert(grantedSteps.some((row) => row.step === "Step 4" && Number(row.case_count) === 1),
    `a granted restricted case must re-enter the tile, got ${JSON.stringify(grantedSteps)}`);
  record("an explicit casework access grant is what returns a restricted case to the dashboards, not the dashboards' own scope");

  await client.query("reset role");
  await client.query("rollback");
  console.log(JSON.stringify({ status: "passed", checks }, null, 2));
} catch (error) {
  try { await client.query("rollback"); } catch { /* the failure above is the report */ }
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
