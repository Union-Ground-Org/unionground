#!/usr/bin/env node
// Transaction-only local proof for CR-013/085/096/110/111. Every fictional
// tenant, identity, member record, handoff, campaign, delivery, and import is
// rolled back. The target is restricted to a loopback database.

import process from "node:process";
import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";
import { siblingIdentityIn } from "./lib/sibling-deny-list.mjs";

const url = requireDatabaseUrl("MEMBER_OPERATIONS_DB_URL");

function assert(condition, message) { if (!condition) throw new Error(message); }
assertDisposableProofUrl(url);
for (const forbidden of ["supabase.co", ...siblingIdentityIn(url)]) {
  assert(!url.includes(forbidden), `Refusing target containing ${forbidden}`);
}

const ids = {
  org: "50985000-0000-4000-8000-000000000001",
  foreignOrg: "50985000-0000-4000-8000-000000000002",
  admin: "50985000-0000-4000-8000-000000000011",
  stewardA: "50985000-0000-4000-8000-000000000012",
  stewardB: "50985000-0000-4000-8000-000000000013",
  memberA: "50985000-0000-4000-8000-000000000021",
  memberB: "50985000-0000-4000-8000-000000000022",
  memberC: "50985000-0000-4000-8000-000000000023",
  foreignAdmin: "50985000-0000-4000-8000-000000000031",
  weeklyA: "50985000-0000-4000-8000-000000000041",
  weeklyB: "50985000-0000-4000-8000-000000000042",
  weeklyC: "50985000-0000-4000-8000-000000000043",
  weeklyKey: "50985000-0000-4000-8000-000000000051",
  profileKey: "50985000-0000-4000-8000-000000000052",
  campaignKey: "50985000-0000-4000-8000-000000000053",
  stepKey: "50985000-0000-4000-8000-000000000054",
  enrollKey: "50985000-0000-4000-8000-000000000055",
  queueKey: "50985000-0000-4000-8000-000000000056",
  handoffKey: "50985000-0000-4000-8000-000000000057",
  stageMemberKey: "50985000-0000-4000-8000-000000000058",
  validateMemberKey: "50985000-0000-4000-8000-000000000059",
  commitMemberKey: "50985000-0000-4000-8000-000000000060",
  stageCaseKey: "50985000-0000-4000-8000-000000000061",
  validateCaseKey: "50985000-0000-4000-8000-000000000062",
  commitCaseKey: "50985000-0000-4000-8000-000000000063",
  leaseKey: "50985000-0000-4000-8000-000000000064",
};

const client = new pg.Client({ connectionString: url });

async function asUser(userId, aal = "aal2") {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", aal })]);
  await client.query("set local role authenticated");
}

async function expectState(label, statement, values, state) {
  const point = `member_ops_${label.replace(/[^a-z0-9]/gi, "_")}`;
  await client.query(`savepoint ${point}`);
  try {
    await client.query(statement, values);
    throw new Error(`${label}: expected SQLSTATE ${state}`);
  } catch (error) {
    assert(error.code === state, `${label}: expected ${state}, got ${error.code || error.message}`);
  } finally {
    await client.query(`rollback to savepoint ${point}`);
    await client.query(`release savepoint ${point}`);
  }
}

try {
  await client.connect();
  await client.query("begin");
  await client.query("select pg_catalog.pg_advisory_xact_lock(509, 85000)");
  await client.query(`
    insert into auth.users (id, email) values
      ($1, 'operations-admin@example.invalid'), ($2, 'operations-steward-a@example.invalid'),
      ($3, 'operations-steward-b@example.invalid'), ($4, 'operations-member-a@example.invalid'),
      ($5, 'operations-member-b@example.invalid'), ($6, 'operations-member-c@example.invalid'),
      ($7, 'operations-foreign@example.invalid')
  `, [ids.admin, ids.stewardA, ids.stewardB, ids.memberA, ids.memberB, ids.memberC, ids.foreignAdmin]);
  await client.query(`
    insert into public.organizations (id, slug, name, created_by) values
      ($1, 'member-operations-proof-a', 'Member Operations Proof A', $3),
      ($2, 'member-operations-proof-b', 'Member Operations Proof B', $4)
  `, [ids.org, ids.foreignOrg, ids.admin, ids.foreignAdmin]);
  await client.query(`
    insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values
      ('member-operations-proof-a', 'Operations Chapter A', 'member-operations-proof-a', true, 1, $1),
      ('member-operations-proof-a-secondary', 'Operations Chapter A Secondary', 'member-operations-proof-a-secondary', false, 2, $1),
      ('member-operations-proof-b', 'Operations Chapter B', 'member-operations-proof-b', true, 1, $2)
  `, [ids.org, ids.foreignOrg]);
  await client.query(`
    insert into public.organization_memberships (organization_id, user_id, status) values
      ($1,$3,'active'), ($1,$4,'active'), ($1,$5,'active'), ($1,$6,'active'),
      ($1,$7,'active'), ($1,$8,'active'), ($2,$9,'active')
  `, [ids.org, ids.foreignOrg, ids.admin, ids.stewardA, ids.stewardB, ids.memberA, ids.memberB, ids.memberC, ids.foreignAdmin]);
  await client.query(`
    insert into public.member_chapter_memberships (user_id, chapter_id, status) values
      ($1,'member-operations-proof-a','active'), ($2,'member-operations-proof-a','active'),
      ($3,'member-operations-proof-a','active'), ($4,'member-operations-proof-a','active'),
      ($5,'member-operations-proof-a','active'), ($6,'member-operations-proof-a','active'),
      ($5,'member-operations-proof-a-secondary','active'),
      ($7,'member-operations-proof-b','active')
  `, [ids.admin, ids.stewardA, ids.stewardB, ids.memberA, ids.memberB, ids.memberC, ids.foreignAdmin]);
  await client.query(`
    update public.member_profiles
    set chapter_id = case when id = $2 then 'member-operations-proof-b' else 'member-operations-proof-a' end
    where id = any($1::uuid[])
  `, [[ids.admin, ids.stewardA, ids.stewardB, ids.memberA, ids.memberB, ids.memberC, ids.foreignAdmin], ids.foreignAdmin]);
  await client.query(`
    insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values
      ($1,$3,'admin',$3), ($1,$4,'steward',$3), ($1,$5,'steward',$3), ($2,$6,'admin',$6)
  `, [ids.org, ids.foreignOrg, ids.admin, ids.stewardA, ids.stewardB, ids.foreignAdmin]);
  await client.query(`
    insert into public.member_roles (user_id, role, chapter_id, granted_by) values
      ($1,'admin','member-operations-proof-a',$1), ($2,'steward','member-operations-proof-a',$1),
      ($3,'steward','member-operations-proof-a',$1), ($4,'admin','member-operations-proof-b',$4)
  `, [ids.admin, ids.stewardA, ids.stewardB, ids.foreignAdmin]);
  await client.query(`
    insert into public.member_role_chapters (user_id, role, chapter_id, granted_by) values
      ($1,'admin','member-operations-proof-a',$1), ($2,'steward','member-operations-proof-a',$1),
      ($3,'steward','member-operations-proof-a',$1), ($4,'admin','member-operations-proof-b',$4)
  `, [ids.admin, ids.stewardA, ids.stewardB, ids.foreignAdmin]);
  await client.query(`
    insert into public.org_security_policy (id, organization_id, require_staff_mfa) values
      (true,$1,true), (true,$2,true)
  `, [ids.org, ids.foreignOrg]);
  await client.query(`
    insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at, secret) values
      (extensions.gen_random_uuid(),$1,'totp','verified',now(),now(),'proof-admin'),
      (extensions.gen_random_uuid(),$2,'totp','verified',now(),now(),'proof-steward-a'),
      (extensions.gen_random_uuid(),$3,'totp','verified',now(),now(),'proof-steward-b'),
      (extensions.gen_random_uuid(),$4,'totp','verified',now(),now(),'proof-foreign')
  `, [ids.admin, ids.stewardA, ids.stewardB, ids.foreignAdmin]);
  await client.query(`
    insert into public.member_steward_relationships (organization_id, chapter_id, member_user_id, steward_user_id)
    values ($1,'member-operations-proof-a',$2,$3)
  `, [ids.org, ids.memberA, ids.stewardA]);
  await client.query(`
    insert into public.member_weekly_questions (id, chapter_id, user_id, week_start, body, options, editorial_state, created_at) values
      ($1,'member-operations-proof-a',$4,current_date - 21,'First weekly question','["A","B"]','submitted',now() - interval '21 days'),
      ($2,'member-operations-proof-a',$5,current_date - 14,'Second weekly question','["A","B"]','submitted',now() - interval '14 days'),
      ($3,'member-operations-proof-a',$6,current_date - 7,'Third weekly question','["A","B"]','submitted',now() - interval '7 days')
  `, [ids.weeklyA, ids.weeklyB, ids.weeklyC, ids.memberA, ids.memberB, ids.memberC]);
  await client.query(`insert into public.member_weekly_question_supports(question_id,user_id) values ($1,$2),($1,$3)`, [ids.weeklyC, ids.memberA, ids.memberB]);

  await asUser(ids.admin, "aal1");
  await expectState("mfa_gate", "select public.get_member_operations_workspace()", [], "42501");
  await asUser(ids.memberA);
  await expectState("admin_gate", "select public.get_member_operations_workspace()", [], "42501");
  await expectState("direct_profile_table", "select * from public.organization_member_operational_profiles", [], "42501");
  await expectState("member_handoff_notes", "select public.list_member_handoffs_v2(null,null,null,null,20)", [], "42501");

  await asUser(ids.admin);
  const directory = (await client.query("select public.get_member_operations_directory(null,null,null,3) result")).rows[0].result;
  assert(directory.items.length === 3 && directory.nextCursor, "member directory did not page deterministically");
  const saved = (await client.query(
    "select public.save_member_operational_profile($1,0,$2::jsonb,$3) result",
    [ids.memberA, JSON.stringify({ memberNumber: "OPS-100", department: "Field services", preferredLanguage: "en" }), ids.profileKey],
  )).rows[0].result;
  const savedReplay = (await client.query(
    "select public.save_member_operational_profile($1,0,$2::jsonb,$3) result",
    [ids.memberA, JSON.stringify({ memberNumber: "OPS-100", department: "Field services", preferredLanguage: "en" }), ids.profileKey],
  )).rows[0].result;
  assert(saved.version === 1 && JSON.stringify(savedReplay) === JSON.stringify(saved), "member profile replay changed the record");
  await expectState("profile_key_mismatch", "select public.save_member_operational_profile($1,0,$2::jsonb,$3)", [ids.memberA, JSON.stringify({ department: "Different" }), ids.profileKey], "22023");
  await client.query(
    "select public.save_member_operational_profile($1,0,$2::jsonb,extensions.gen_random_uuid())",
    [ids.memberB, JSON.stringify({ jobTitle: "Existing title", administrativeNotes: "Keep this note", preferredLanguage: "es" })],
  );
  const bulkUpdate = (await client.query(
    "select public.bulk_update_member_operational_profiles(array[$1,$2]::uuid[],'workLocation','Hybrid',extensions.gen_random_uuid()) result",
    [ids.memberA, ids.memberB],
  )).rows[0].result;
  assert(bulkUpdate.updatedCount === 2, "bulk profile update did not satisfy the audit metadata contract");

  await client.query("select public.save_weekly_question_selection_policy(true,7,3,1,'support_then_oldest',null)");
  await client.query("reset role");
  const initializedPolicy = (await client.query(
    "select next_run_at > now() + interval '6 days' and next_run_at <= now() + interval '8 days' initialized from public.weekly_question_selection_policies where organization_id=$1 and chapter_id='member-operations-proof-a'",
    [ids.org],
  )).rows[0];
  assert(initializedPolicy.initialized, "enabled weekly policy did not initialize its next run from cadence");
  await asUser(ids.admin);
  await client.query("select public.save_weekly_question_selection_policy(true,7,3,1,'support_then_oldest',now())");
  const weekly = (await client.query("select public.run_weekly_question_selection($1) result", [ids.weeklyKey])).rows[0].result;
  const weeklyReplay = (await client.query("select public.run_weekly_question_selection($1) result", [ids.weeklyKey])).rows[0].result;
  assert(weekly.selectedIds[0] === ids.weeklyC && JSON.stringify(weeklyReplay) === JSON.stringify(weekly), "weekly selection was not deterministic and replay-safe");
  const weeklyWorkspace = (await client.query("select public.get_weekly_question_selection_workspace() result")).rows[0].result;
  assert(weeklyWorkspace.items.length === 3 && weeklyWorkspace.items.some((item) => item.editorialState === "reserved"), "weekly archive omitted pool history");
  await client.query("reset role");
  const scheduled = (await client.query("select private.run_due_weekly_question_selections(25) result")).rows[0].result;
  assert(scheduled.processed === 0, "weekly scheduler ran a policy before its next due time");
  const cron = (await client.query("select schedule, command from cron.job where jobname='weekly-question-selection-tick'")).rows[0];
  assert(cron?.schedule === "18 * * * *" && cron.command === "select private.run_due_weekly_question_selections(25);", "weekly scheduler contract is missing");
  await asUser(ids.admin);

  const campaign = (await client.query("select public.save_welcome_campaign(null,'New member orientation','active',$1) result", [ids.campaignKey])).rows[0].result;
  const firstStep = (await client.query("select public.save_welcome_campaign_step($1,null,0,0,'en','Welcome to Union Ground','Your orientation is ready.',true,$2) result", [campaign.id, ids.stepKey])).rows[0].result;
  await client.query("select public.save_welcome_campaign_step($1,null,0,2,'es','Bienvenida a Union Ground','Tu orientación está lista.',true,extensions.gen_random_uuid())", [campaign.id]);
  const secondStep = (await client.query("select public.save_welcome_campaign_step($1,null,5,10,'en','Your next guide','Continue your orientation.',true,extensions.gen_random_uuid()) result", [campaign.id])).rows[0].result;
  const spanishSecondStep = (await client.query("select public.save_welcome_campaign_step($1,null,5,20,'es','Tu próxima guía','Continúa tu orientación.',true,extensions.gen_random_uuid()) result", [campaign.id])).rows[0].result;
  const enrollment = (await client.query("select public.enroll_member_in_welcome_campaign($1,$2,$3) result", [campaign.id, ids.memberA, ids.enrollKey])).rows[0].result;
  const spanishEnrollment = (await client.query("select public.enroll_member_in_welcome_campaign($1,$2,extensions.gen_random_uuid()) result", [campaign.id, ids.memberB])).rows[0].result;
  await client.query("reset role");
  const spanishInitial = (await client.query("select next_due_at::date - enrolled_at::date due_days from public.member_welcome_enrollments where id=$1", [spanishEnrollment.id])).rows[0];
  assert(spanishInitial.due_days === 2, "welcome enrollment did not use the member locale delay");
  await asUser(ids.admin);
  const queued = (await client.query("select public.queue_due_welcome_messages($1) result", [ids.queueKey])).rows[0].result;
  const queuedReplay = (await client.query("select public.queue_due_welcome_messages($1) result", [ids.queueKey])).rows[0].result;
  assert(enrollment.state === "active" && queued.queuedCount === 1 && queuedReplay.queuedCount === 1, "welcome queue was not sequenced and replay-safe");
  await client.query("reset role");
  const scheduledEnrollment = (await client.query("select next_step_position, next_due_at::date - enrolled_at::date due_days from public.member_welcome_enrollments where id=$1", [enrollment.id])).rows[0];
  assert(scheduledEnrollment.next_step_position === 5 && scheduledEnrollment.due_days === 10, "welcome sequence did not preserve sparse absolute day ordering");
  await client.query("update public.member_welcome_enrollments set next_due_at=now() where id=$1", [spanishEnrollment.id]);
  await asUser(ids.admin);
  await client.query("select public.queue_due_welcome_messages(extensions.gen_random_uuid())");
  await client.query("reset role");
  const spanishScheduled = (await client.query("select next_step_position, next_due_at::date - enrolled_at::date due_days from public.member_welcome_enrollments where id=$1", [spanishEnrollment.id])).rows[0];
  const spanishDelivery = (await client.query("select locale from public.engagement_delivery_outbox where recipient_user_id=$1 and source_kind='welcome_campaign' order by created_at desc limit 1", [ids.memberB])).rows[0];
  assert(spanishScheduled.next_step_position === 5 && spanishScheduled.due_days === 20 && spanishDelivery.locale === "es", "welcome queue mixed locale content and timing");
  await asUser(ids.admin);
  await client.query("select public.save_welcome_campaign_step($1,null,9,30,'en','Your final guide','Finish your orientation.',true,extensions.gen_random_uuid())", [campaign.id]);
  await client.query("select public.save_welcome_campaign_step($1,$2,5,10,'en','Your next guide','Continue your orientation.',false,extensions.gen_random_uuid())", [campaign.id, secondStep.id]);
  await client.query("select public.save_welcome_campaign_step($1,$2,5,20,'es','Tu próxima guía','Continúa tu orientación.',false,extensions.gen_random_uuid())", [campaign.id, spanishSecondStep.id]);
  await client.query("reset role");
  await client.query("update public.member_welcome_enrollments set next_due_at=now() where id=$1", [enrollment.id]);
  await asUser(ids.admin);
  await client.query("select public.queue_due_welcome_messages(extensions.gen_random_uuid())");
  await client.query("reset role");
  const skippedInactive = (await client.query("select state, next_step_position, next_due_at::date - enrolled_at::date due_days from public.member_welcome_enrollments where id=$1", [enrollment.id])).rows[0];
  assert(skippedInactive.state === "active" && skippedInactive.next_step_position === 9 && skippedInactive.due_days === 30, "welcome queue completed instead of skipping an inactive current step");
  await asUser(ids.admin);
  await client.query("select public.save_welcome_campaign_step($1,$2,0,0,'en','Changed after queue','Changed after queue.',true,extensions.gen_random_uuid())", [campaign.id, firstStep.id]);
  await client.query("reset role");
  await expectState(
    "welcome_tenant_parent",
    "insert into public.organization_welcome_campaign_steps (organization_id,campaign_id,position,delay_days,locale,subject,body) values ($1,$2,49,0,'en','Mismatch','Mismatch')",
    [ids.foreignOrg, campaign.id], "23503",
  );
  await client.query("set local role service_role");
  const claimed = (await client.query("select public.claim_engagement_delivery_batch($1,100,120) result", [ids.leaseKey])).rows[0].result;
  const welcomeDelivery = claimed.find((item) => item.deliveryKind === "welcome" && item.recipientUserId === ids.memberA);
  assert(welcomeDelivery, "welcome delivery was not visible to the trusted worker lease");
  const payload = (await client.query("select public.get_engagement_delivery_payload($1,$2) result", [welcomeDelivery.id, ids.leaseKey])).rows[0].result;
  assert(payload.available && payload.email === "operations-member-a@example.invalid" && payload.subject === "Welcome to Union Ground", "queued welcome content was not immutable");
  await client.query("reset role");
  await client.query("update public.organization_memberships set status='revoked', revoked_at=now() where organization_id=$1 and user_id=$2", [ids.org, ids.memberA]);
  await client.query("set local role service_role");
  const revokedPayload = (await client.query("select public.get_engagement_delivery_payload($1,$2) result", [welcomeDelivery.id, ids.leaseKey])).rows[0].result;
  assert(revokedPayload.available === false, "revoked member retained a welcome-email payload");
  await client.query("reset role");
  await client.query("update public.organization_memberships set status='active', revoked_at=null where organization_id=$1 and user_id=$2", [ids.org, ids.memberA]);

  await asUser(ids.admin);
  const memberMapping = { member_id: "member_id", member_number: "member_number", department: "department" };
  const memberRows = [{ member_id: ids.memberB, member_number: "OPS-200", department: "Operations" }];
  const memberBatch = (await client.query(
    "select public.stage_member_operations_import('member','members.csv',$1::jsonb,$2::jsonb,$3) result",
    [JSON.stringify(memberMapping), JSON.stringify(memberRows), ids.stageMemberKey],
  )).rows[0].result;
  const memberValidation = (await client.query("select public.validate_member_operations_import($1,$2) result", [memberBatch.id, ids.validateMemberKey])).rows[0].result;
  const memberCommit = (await client.query("select public.commit_member_operations_import($1,$2) result", [memberBatch.id, ids.commitMemberKey])).rows[0].result;
  const memberCommitReplay = (await client.query("select public.commit_member_operations_import($1,$2) result", [memberBatch.id, ids.commitMemberKey])).rows[0].result;
  assert(memberValidation.errorCount === 0 && memberCommit.importedCount === 1 && JSON.stringify(memberCommitReplay) === JSON.stringify(memberCommit), "member import did not validate and commit atomically");
  await client.query("reset role");
  const preservedProfile = (await client.query("select department, job_title, administrative_notes, preferred_language from public.organization_member_operational_profiles where organization_id=$1 and member_user_id=$2", [ids.org, ids.memberB])).rows[0];
  assert(preservedProfile.department === "Operations" && preservedProfile.job_title === "Existing title" && preservedProfile.administrative_notes === "Keep this note" && preservedProfile.preferred_language === "es", "partial member import erased omitted operational fields");
  await asUser(ids.admin);

  const caseMapping = { member_id: "member_id", chapter_id: "chapter_id", reference: "reference", title: "title" };
  const caseRows = [{ member_id: ids.memberB, chapter_id: "member-operations-proof-a", reference: "OPS-GR-001", title: "Scheduling review" }];
  const caseBatch = (await client.query(
    "select public.stage_member_operations_import('grievance','grievances.csv',$1::jsonb,$2::jsonb,$3) result",
    [JSON.stringify(caseMapping), JSON.stringify(caseRows), ids.stageCaseKey],
  )).rows[0].result;
  const caseValidation = (await client.query("select public.validate_member_operations_import($1,$2) result", [caseBatch.id, ids.validateCaseKey])).rows[0].result;
  const caseCommit = (await client.query("select public.commit_member_operations_import($1,$2) result", [caseBatch.id, ids.commitCaseKey])).rows[0].result;
  assert(caseValidation.errorCount === 0 && caseCommit.importedCount === 1, "grievance import did not validate and commit atomically");
  const mismatchedCaseRows = [{ member_id: ids.memberB, chapter_id: "member-operations-proof-a-secondary", reference: "OPS-GR-002", title: "Secondary chapter mismatch" }];
  const mismatchedCaseBatch = (await client.query(
    "select public.stage_member_operations_import('grievance','grievances-mismatch.csv',$1::jsonb,$2::jsonb,extensions.gen_random_uuid()) result",
    [JSON.stringify(caseMapping), JSON.stringify(mismatchedCaseRows)],
  )).rows[0].result;
  const mismatchedCaseValidation = (await client.query("select public.validate_member_operations_import($1,extensions.gen_random_uuid()) result", [mismatchedCaseBatch.id])).rows[0].result;
  assert(mismatchedCaseValidation.errorCount === 1, "grievance import accepted a non-case-owning secondary chapter");
  await expectState(
    "duplicate_mapping",
    "select public.stage_member_operations_import('member','bad.csv',$1::jsonb,$2::jsonb,extensions.gen_random_uuid())",
    [JSON.stringify({ first: "member_id", second: "member_id" }), JSON.stringify([{ member_id: ids.memberA }])],
    "22023",
  );
  await expectState(
    "oversized_import",
    "select public.stage_member_operations_import('member','oversized.csv',$1::jsonb,jsonb_build_array(jsonb_build_object('email','operations-member-a@example.invalid','department',repeat('x',2097153))),extensions.gen_random_uuid())",
    [JSON.stringify({ email: "email", department: "department" })], "22023",
  );
  await expectState(
    "unknown_import_field",
    "select public.stage_member_operations_import('member','unknown.csv',$1::jsonb,$2::jsonb,extensions.gen_random_uuid())",
    [JSON.stringify({ email: "email" }), JSON.stringify([{ email: "operations-member-a@example.invalid", secret_note: "must not persist" }])], "22023",
  );

  const staleRows = [{ member_id: ids.memberC, department: "Must not commit after revocation" }];
  const staleBatch = (await client.query(
    "select public.stage_member_operations_import('member','stale.csv',$1::jsonb,$2::jsonb,extensions.gen_random_uuid()) result",
    [JSON.stringify({ member_id: "member_id", department: "department" }), JSON.stringify(staleRows)],
  )).rows[0].result;
  await client.query("select public.validate_member_operations_import($1,extensions.gen_random_uuid())", [staleBatch.id]);
  await client.query("reset role");
  await client.query("update public.organization_memberships set status='revoked', revoked_at=now() where organization_id=$1 and user_id=$2", [ids.org, ids.memberC]);
  await asUser(ids.admin);
  const staleCommit = (await client.query("select public.commit_member_operations_import($1,extensions.gen_random_uuid()) result", [staleBatch.id])).rows[0].result;
  assert(staleCommit.committed === false && staleCommit.errorCount === 1, "commit did not revalidate revoked membership");
  await client.query("reset role");
  assert(!(await client.query("select 1 from public.organization_member_operational_profiles where organization_id=$1 and member_user_id=$2 and department='Must not commit after revocation'", [ids.org, ids.memberC])).rowCount, "stale import wrote a revoked member record");
  await client.query("update public.organization_memberships set status='active', revoked_at=null where organization_id=$1 and user_id=$2", [ids.org, ids.memberC]);

  const handoff = (await client.query("select public.initiate_member_handoff($1,$2,'Transfer current context',$3) result", [ids.memberA, ids.stewardB, ids.handoffKey])).rows[0].result;
  await asUser(ids.stewardB);
  const acknowledged = (await client.query("select public.acknowledge_member_handoff($1) result", [handoff.id])).rows[0].result;
  const handoffHistory = (await client.query("select public.list_member_handoffs_v2(null,'acknowledged',null,null,20) result")).rows[0].result;
  assert(acknowledged.status === "acknowledged" && handoffHistory.items.some((item) => item.id === handoff.id), "two-sided handoff acknowledgement or history failed");
  await client.query("reset role");
  const relationship = (await client.query("select steward_user_id from public.member_steward_relationships where organization_id=$1 and member_user_id=$2", [ids.org, ids.memberA])).rows[0];
  assert(relationship.steward_user_id === ids.stewardB, "handoff acknowledgement did not transfer responsibility");

  await asUser(ids.stewardA);
  const supervised = (await client.query("select public.initiate_member_handoff($1,$2,'Supervisor cancellation proof',extensions.gen_random_uuid()) result", [ids.memberB, ids.stewardB])).rows[0].result;
  await asUser(ids.admin);
  const cancelled = (await client.query("select public.cancel_member_handoff($1) result", [supervised.id])).rows[0].result;
  assert(cancelled.status === "cancelled", "authorized supervisor could not cancel a pending handoff");
  const literalWildcard = (await client.query("select public.search_handoff_members('%%') result")).rows[0].result;
  assert(literalWildcard.length === 0, "handoff member search treated wildcard input as an enumeration");

  await asUser(ids.foreignAdmin);
  const foreignDirectory = (await client.query("select public.get_member_operations_directory(null,null,null,25) result")).rows[0].result;
  assert(foreignDirectory.items.length === 1 && foreignDirectory.items[0].userId === ids.foreignAdmin, "member directory crossed organization scope");
  await expectState("foreign_batch", "select public.commit_member_operations_import($1,extensions.gen_random_uuid())", [memberBatch.id], "55000");

  await client.query("reset role");
  await client.query("rollback");
  process.stdout.write("Member operations behavior proof passed; all fixtures rolled back.\n");
} catch (error) {
  try { await client.query("reset role"); await client.query("rollback"); } catch { /* best effort */ }
  throw error;
} finally {
  await client.end().catch(() => {});
}
