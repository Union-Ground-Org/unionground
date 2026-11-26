#!/usr/bin/env node
// Static verifier for MI1 W2 feature persistence.
//
// Default: parse the reserved migration and db-contract offline.
// Live mode is local-only on an exclusive disposable database. Refuse
// production/SAMPLE project refs and shared ports 54322 / 54422.
//
//   MI1_EXCLUSIVE_DB_URL=postgresql://... \
//   MI1_EXCLUSIVE_DB_CONFIRM=w2-feature-persistence-disposable \
//   node scripts/verify-mi1-w2-feature-persistence.mjs --live

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import pg from "pg";
import { forbiddenProjectRefIn } from "./lib/assert-exact-target.mjs";
import { requireRlsTables } from "./lib/db-contract-tables.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const migrationPath = join(ROOT, "supabase/migrations/20260826151000_mi1_w2_feature_persistence.sql");
const repairMigrationPath = join(ROOT, "supabase/migrations/20260826155000_mi1_append_only_review_repairs.sql");
const contractPath = join(HERE, "db-contract.json");
const sql = readFileSync(migrationPath, "utf8");
const repairSql = readFileSync(repairMigrationPath, "utf8");
const contract = JSON.parse(readFileSync(contractPath, "utf8"));

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function requireNeedle(haystack, needle, label) {
  if (!haystack.includes(needle)) fail(`missing ${label}: ${needle}`);
}

for (const needle of [
  "create table public.organization_surveys",
  "create table public.organization_knowledge_files",
  "create table public.member_handoffs",
  "public.save_organization_survey_draft",
  "public.prepare_steward_library_upload",
  "public.initiate_member_handoff",
  "private.can_read_restricted_case",
  "q.survey_id = saved_survey_id",
  "organization history is append-only",
  "ownerless writes are prohibited",
  "optional_activation_unset",
  "organization-knowledge",
]) {
  requireNeedle(sql, needle, needle);
}

for (const needle of [
  "set local lock_timeout = '5s'",
  "organization_audit_events_org_created_idx",
  "drop function if exists public.list_member_qa_officer_queue()",
  "p_after_created_at timestamptz default null",
  "private.mi1_require_product_job_run",
  "privacy_threshold constant integer := 25",
  "interval '180 days'",
  "private.purge_expired_public_event_rsvps",
  "p_row_count integer",
  "extensions.gen_random_bytes",
]) {
  requireNeedle(repairSql, needle, `append-only repair ${needle}`);
}
if (/\binsert into public\.organizations\b/i.test(repairSql)) {
  fail("unexpected organizations insert in append-only repair");
}
if (sql.includes("pg_catalog.current_date")) {
  fail("CURRENT_DATE is a SQL value expression and must not be schema-qualified");
}

if (/\binsert into public\.organizations\b/i.test(sql)) {
  fail("unexpected organizations insert");
}
if (sql.includes("p_organization_id") && sql.includes("create function public.")) {
  const publicRpcs = sql.split("create function public.");
  for (const chunk of publicRpcs.slice(1)) {
    const name = chunk.slice(0, chunk.indexOf("("));
    const body = chunk.slice(0, chunk.indexOf("$function$;") + 12);
    if (body.includes("p_organization_id")) {
      fail(`public.${name} accepts a caller organization id`);
    }
  }
}
requireRlsTables(contract, ["organization_surveys", "organization_knowledge_files", "member_handoffs"]);

const liveRequested = process.argv.includes("--live") || process.env.MI1_EXCLUSIVE_DB_URL;
if (!liveRequested) {
  process.stdout.write("MI1 W2 feature persistence static verification passed. Exclusive-DB proof skipped.\n");
  process.exit(0);
}

if (process.env.MI1_EXCLUSIVE_DB_CONFIRM !== "w2-feature-persistence-disposable") {
  fail("Refusing live mode without MI1_EXCLUSIVE_DB_CONFIRM=w2-feature-persistence-disposable");
}

const url = process.env.MI1_EXCLUSIVE_DB_URL;
if (!url) fail("MI1_EXCLUSIVE_DB_URL is required for --live");

let parsed;
try {
  parsed = new URL(url);
} catch {
  fail("MI1_EXCLUSIVE_DB_URL is not a valid URL");
}

const haystack = `${parsed.hostname}|${decodeURIComponent(parsed.username || "")}|${url}`;
for (const forbidden of [contract.target.projectRef, forbiddenProjectRefIn(contract.target, haystack)].filter(Boolean)) {
  if (haystack.includes(forbidden)) fail(`Refusing live proof against forbidden project ${forbidden}`);
}
if (["54322", "54422"].includes(parsed.port)) {
  fail(`Refusing a shared local Supabase URL on port ${parsed.port}`);
}
if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
  fail("Live proof is local-only; MI1_EXCLUSIVE_DB_URL must use a loopback hostname");
}

const { Client } = pg;
const client = new Client({ connectionString: url });

const ids = {
  organization: "50920000-0000-4000-8000-000000000001",
  foreignOrganization: "50920000-0000-4000-8000-000000000002",
  steward: "50920000-0000-4000-8000-000000000011",
  coordinator: "50920000-0000-4000-8000-000000000012",
  advisor: "50920000-0000-4000-8000-000000000013",
  admin: "50920000-0000-4000-8000-000000000014",
  memberA: "50920000-0000-4000-8000-000000000021",
  memberB: "50920000-0000-4000-8000-000000000022",
  assignedCase: "50920000-0000-4000-8000-000000000031",
  unassignedCase: "50920000-0000-4000-8000-000000000032",
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// private.mfa_satisfied() (20260905005500) binds the claims to a live
// auth.sessions row, so every actor carries the fixture session it owns.
const sessionFor = (userId) => userId.replace("-8000-", "-9000-");

async function asAuthenticated(userId) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: sessionFor(userId) }),
  ]);
  await client.query("set local role authenticated");
}

async function asDatabaseActor(userId) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: sessionFor(userId) }),
  ]);
}

async function expectSqlState(label, statement, values, state) {
  const savepoint = `mi1_w2_${label.replace(/[^a-z0-9]/gi, "_")}`;
  await client.query(`savepoint ${savepoint}`);
  try {
    await client.query(statement, values);
    throw new Error(`${label}: expected SQLSTATE ${state}`);
  } catch (error) {
    assert(error.code === state, `${label}: expected SQLSTATE ${state}, got ${error.code || error.message}`);
  } finally {
    await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
  }
}

try {
  await client.connect();
  await client.query("begin");
  const tables = await client.query(`
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in (
        'organization_surveys',
        'organization_knowledge_files', 'member_handoffs'
      )
      and c.relrowsecurity
  `);
  assert(tables.rowCount === 3, "expected three remaining W2 root tables with RLS");

  await client.query(`
    insert into auth.users (id, email) values
      ($1, 'mi1-w2-steward@example.invalid'),
      ($2, 'mi1-w2-coordinator@example.invalid'),
      ($3, 'mi1-w2-advisor@example.invalid'),
      ($4, 'mi1-w2-admin@example.invalid'),
      ($5, 'mi1-w2-member-a@example.invalid'),
      ($6, 'mi1-w2-member-b@example.invalid')
  `, [ids.steward, ids.coordinator, ids.advisor, ids.admin, ids.memberA, ids.memberB]);
  await client.query(`
    insert into auth.sessions (id, user_id, created_at, updated_at, aal)
    select $1::uuid, $2::uuid, now(), now(), 'aal2'::auth.aal_level union all
    select $3::uuid, $4::uuid, now(), now(), 'aal2'::auth.aal_level union all
    select $5::uuid, $6::uuid, now(), now(), 'aal2'::auth.aal_level union all
    select $7::uuid, $8::uuid, now(), now(), 'aal2'::auth.aal_level union all
    select $9::uuid, $10::uuid, now(), now(), 'aal2'::auth.aal_level union all
    select $11::uuid, $12::uuid, now(), now(), 'aal2'::auth.aal_level
  `, [ids.steward, ids.coordinator, ids.advisor, ids.admin, ids.memberA, ids.memberB].flatMap((id) => [sessionFor(id), id]));
  await client.query(`
    insert into public.organizations (id, slug, name, created_by)
    values
      ($1, 'mi1-w2-visibility', 'MI1 W2 Visibility Proof', $3),
      ($2, 'mi1-w2-foreign', 'MI1 W2 Foreign Proof', $3)
  `, [ids.organization, ids.foreignOrganization, ids.admin]);
  await client.query(`
    insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values
      ('mi1-w2-a', 'MI1 W2 Chapter A', 'mi1-w2-a', true, 1, $1),
      ('mi1-w2-b', 'MI1 W2 Chapter B', 'mi1-w2-b', false, 2, $1),
      ('mi1-w2-foreign', 'MI1 W2 Foreign Chapter', 'mi1-w2-foreign', false, 3, $2)
  `, [ids.organization, ids.foreignOrganization]);
  await client.query(`
    insert into public.organization_memberships (organization_id, user_id, status) values
      ($1, $2, 'active'), ($1, $3, 'active'), ($1, $4, 'active'),
      ($1, $5, 'active'), ($1, $6, 'active'), ($1, $7, 'active')
  `, [ids.organization, ids.steward, ids.coordinator, ids.advisor, ids.admin, ids.memberA, ids.memberB]);
  await client.query(`
    insert into public.org_security_policy (id, organization_id, require_staff_mfa)
    values (true, $1, false)
  `, [ids.organization]);
  await client.query(`
    insert into public.member_chapter_memberships (user_id, chapter_id, status) values
      ($1, 'mi1-w2-a', 'active'), ($2, 'mi1-w2-a', 'active'),
      ($3, 'mi1-w2-a', 'active'), ($4, 'mi1-w2-a', 'active'),
      ($5, 'mi1-w2-a', 'active'), ($6, 'mi1-w2-b', 'active')
  `, [ids.steward, ids.coordinator, ids.advisor, ids.admin, ids.memberA, ids.memberB]);
  await client.query(`
    update public.member_profiles
    set chapter_id = case when id = $1 then 'mi1-w2-b' else 'mi1-w2-a' end
    where id = any($2::uuid[])
  `, [ids.memberB, [ids.steward, ids.coordinator, ids.advisor, ids.admin, ids.memberA, ids.memberB]]);
  await client.query(`
    insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values
      ($1, $2, 'steward', $5),
      ($1, $3, 'advisor', $5),
      ($1, $4, 'admin', $5)
  `, [ids.organization, ids.steward, ids.advisor, ids.admin, ids.admin]);
  await client.query(`
    insert into public.member_roles (user_id, role, chapter_id, granted_by) values
      ($1, 'coordinator', 'mi1-w2-a', $3),
      ($2, 'advisor', 'mi1-w2-a', $3)
  `, [ids.coordinator, ids.advisor, ids.admin]);
  await client.query(`
    insert into public.member_role_chapters (user_id, role, chapter_id, granted_by) values
      ($1, 'coordinator', 'mi1-w2-a', $3),
      ($2, 'advisor', 'mi1-w2-a', $3)
  `, [ids.coordinator, ids.advisor, ids.admin]);
  await client.query(`
    insert into public.member_cases
      (id, user_id, reference, title, case_type, steward_user_id) values
      ($1, $3, 'MI1-W2-ASSIGNED', 'Assigned case', 'grievance', $5),
      ($2, $4, 'MI1-W2-UNASSIGNED', 'Unassigned case', 'grievance', null)
  `, [ids.assignedCase, ids.unassignedCase, ids.memberA, ids.memberB, ids.steward]);

  await client.query("update public.member_profiles set chapter_id = 'mi1-w2-foreign' where id = $1", [ids.memberA]);
  const immutableCaseTenant = await client.query(`
    select private.mi1_w2_case_organization($1) resolved,
           organization_id stored
    from public.member_cases where id = $1
  `, [ids.assignedCase]);
  assert(immutableCaseTenant.rows[0].resolved === ids.organization
    && immutableCaseTenant.rows[0].stored === ids.organization,
  "a later cross-organization chapter change re-homed an existing case");
  await client.query("update public.member_profiles set chapter_id = 'mi1-w2-a' where id = $1", [ids.memberA]);

  await asDatabaseActor(ids.steward);
  let visibility = await client.query(`
    select private.can_read_restricted_case($1, $2) assigned,
           private.can_read_restricted_case($1, $3) unassigned
  `, [ids.organization, ids.assignedCase, ids.unassignedCase]);
  const stewardDiagnostics = await client.query(`
    select (select auth.uid()) caller,
           private.current_member_organization() current_org,
           private.is_organization_member($1) organization_member,
           private.has_organization_role($1, array['steward']) organization_steward,
           public.member_has_role(array['steward']) chapter_steward,
           (select steward_user_id from public.member_cases where id = $2) assigned_steward
  `, [ids.organization, ids.assignedCase]);
  assert(visibility.rows[0].assigned && !visibility.rows[0].unassigned,
    `steward visibility did not remain assignee-only: ${JSON.stringify({
      visibility: visibility.rows[0], diagnostics: stewardDiagnostics.rows[0],
    })}`);

  await asDatabaseActor(ids.coordinator);
  visibility = await client.query(`
    select private.can_read_restricted_case($1, $2) same_chapter,
           private.can_read_restricted_case($1, $3) foreign_chapter
  `, [ids.organization, ids.assignedCase, ids.unassignedCase]);
  assert(visibility.rows[0].same_chapter && !visibility.rows[0].foreign_chapter,
    "coordinator visibility did not remain chapter-scoped");

  await client.query("reset role");
  await client.query(`
    insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
    values ($1, $2, 'coordinator', $3)
  `, [ids.organization, ids.coordinator, ids.admin]);
  await asDatabaseActor(ids.coordinator);
  visibility = await client.query(`
    select private.can_read_restricted_case($1, $2) chapter_a,
           private.can_read_restricted_case($1, $3) chapter_b
  `, [ids.organization, ids.assignedCase, ids.unassignedCase]);
  assert(visibility.rows[0].chapter_a && visibility.rows[0].chapter_b,
    "explicit organization coordinator positive control failed");

  await asDatabaseActor(ids.advisor);
  visibility = await client.query(
    "select private.can_read_restricted_case($1, $2) allowed",
    [ids.organization, ids.assignedCase],
  );
  assert(!visibility.rows[0].allowed, "aggregate-only advisor received a raw case row");

  await asDatabaseActor(ids.memberA);
  visibility = await client.query(`
    select private.can_read_restricted_case($1, $2) ordinary_member,
           private.can_read_restricted_case('50920000-0000-4000-8000-000000000099', $2) foreign_org,
           private.can_read_restricted_case($1, '50920000-0000-4000-8000-000000000098') unknown_case
  `, [ids.organization, ids.assignedCase]);
  assert(!visibility.rows[0].ordinary_member && !visibility.rows[0].foreign_org && !visibility.rows[0].unknown_case,
    "ordinary, foreign-organization, or unknown-case input crossed the case boundary");

  await asDatabaseActor(ids.admin);
  visibility = await client.query(`
    select private.can_read_restricted_case($1, $2) chapter_a,
           private.can_read_restricted_case($1, $3) chapter_b
  `, [ids.organization, ids.assignedCase, ids.unassignedCase]);
  assert(visibility.rows[0].chapter_a && visibility.rows[0].chapter_b,
    "organization admin positive control failed");

  // W2 restriction, alert and generated-work storage retired in Phase 5.1: the
  // surviving adapter reads the casework restriction model. A restricted case
  // hides from an unassigned chapter coordinator until an access grant exists.
  await client.query("reset role");
  await client.query(`
    update public.member_cases set is_restricted = true, restriction_reason = 'visibility proof',
      restricted_at = now(), restricted_by = $2 where id = $1
  `, [ids.assignedCase, ids.admin]);
  await asDatabaseActor(ids.coordinator);
  visibility = await client.query(
    "select private.can_read_restricted_case($1, $2) allowed",
    [ids.organization, ids.assignedCase],
  );
  assert(!visibility.rows[0].allowed, "restricted case ignored the casework restriction for an unassigned coordinator");
  await asDatabaseActor(ids.steward);
  visibility = await client.query(
    "select private.can_read_restricted_case($1, $2) allowed",
    [ids.organization, ids.assignedCase],
  );
  assert(visibility.rows[0].allowed, "assigned steward lost the restricted case the casework model keeps visible");
  await client.query("reset role");
  await client.query(`
    insert into public.casework_access_grants (case_id, organization_id, chapter_id, grantee_user_id, granted_by, reason)
    values ($1, $2, 'mi1-w2-a', $3, $4, 'visibility proof grant')
  `, [ids.assignedCase, ids.organization, ids.coordinator, ids.admin]);
  await asDatabaseActor(ids.coordinator);
  visibility = await client.query(
    "select private.can_read_restricted_case($1, $2) allowed",
    [ids.organization, ids.assignedCase],
  );
  assert(visibility.rows[0].allowed, "explicit restricted-case access grant positive control failed");
  await asAuthenticated(ids.admin);

  const createdSurvey = await client.query(
    "select public.save_organization_survey_draft($1::jsonb) draft",
    [JSON.stringify({
      title: "Initial survey title",
      questions: [{ type: "text", label: "What should change?", required: true }],
    })],
  );
  assert(createdSurvey.rows[0].draft.title === "Initial survey title", "survey draft create control failed");
  const surveyId = createdSurvey.rows[0].draft.id;
  const updatedSurvey = await client.query(
    "select public.save_organization_survey_draft($1::jsonb) draft",
    [JSON.stringify({
      id: surveyId,
      title: "Updated survey title",
      questions: [{ type: "paragraph", label: "What changed?", required: true }],
    })],
  );
  assert(updatedSurvey.rows[0].draft.title === "Updated survey title", "survey draft update did not persist the renamed title variable");
  const publishedSurvey = await client.query(
    "select public.publish_organization_survey_with_operations($1::jsonb, $2::jsonb) survey",
    [JSON.stringify({
      id: surveyId,
      title: "Published survey title",
      questions: [{ type: "paragraph", label: "What changed?", required: true }],
    }), JSON.stringify({ cadence: "one_off", operationsState: "ready" })],
  );
  assert(publishedSurvey.rows[0].survey.status === "open", "survey publish control failed");

  const preparedFile = await client.query(
    `select public.prepare_steward_library_upload(
      'idempotency-proof.pdf', 1024, repeat('a', 64), 'Idempotency proof',
      'Disposable verification fixture', 'general', $1
    ) value`,
    ["50920000-0000-4000-8000-000000000051"],
  );
  const knowledgeFileId = preparedFile.rows[0].value.fileId;
  // complete_steward_library_upload, review(approved), publish and download are
  // gated on a current private.private_upload_scans verdict for the stored
  // object (20260906020000). Stand the object and its ledger row up the way an
  // inspected upload would; the verdict itself is proved by
  // tests/private-file-workflow-gates-db.test.js, not here.
  const storageTarget = await client.query(
    "select public.get_knowledge_file_storage_target($1, $2, 'upload') value",
    [knowledgeFileId, preparedFile.rows[0].value.storageHandle],
  );
  await client.query("reset role");
  await client.query(
    `insert into storage.objects (bucket_id, name, owner, version, metadata)
     values ($1, $2, $3, 'mi1-w2-proof-version', '{"size":1024,"mimetype":"application/pdf"}'::jsonb)`,
    [storageTarget.rows[0].value.bucketId, storageTarget.rows[0].value.objectName, ids.admin],
  );
  await client.query(
    `update private.private_upload_scans
     set status = 'clean', sha256 = repeat('a', 64), engine = 'ClamAV 1.5.4',
         signature_version = 28113, signature_updated_at = now(), scanned_at = now(),
         clean_until = now() + interval '1 hour'
     where bucket_id = $1 and object_name = $2`,
    [storageTarget.rows[0].value.bucketId, storageTarget.rows[0].value.objectName],
  );
  await asAuthenticated(ids.admin);
  const completeKey = "50920000-0000-4000-8000-000000000052";
  const firstComplete = await client.query(
    "select public.complete_steward_library_upload($1, $2) value",
    [knowledgeFileId, completeKey],
  );
  const replayedComplete = await client.query(
    "select public.complete_steward_library_upload($1, $2) value",
    [knowledgeFileId, completeKey],
  );
  assert(
    JSON.stringify(firstComplete.rows[0].value) === JSON.stringify(replayedComplete.rows[0].value),
    "complete upload idempotency did not replay the stored result",
  );
  await expectSqlState(
    "complete_key_reuse",
    "select public.complete_steward_library_upload($1, $2)",
    ["50920000-0000-4000-8000-000000000099", completeKey],
    "22023",
  );

  await client.query("reset role");
  const knowledgeSource = await client.query(
    "select id from public.organization_knowledge_sources where organization_id=$1 and file_id=$2",
    [ids.organization, knowledgeFileId],
  );
  const knowledgeSourceId = knowledgeSource.rows[0].id;
  await asAuthenticated(ids.admin);
  for (const [statement, key, label] of [
    ["select public.clear_knowledge_ingest_source_chunks($1, $2) value", "50920000-0000-4000-8000-000000000053", "clear chunks"],
    ["select public.retry_knowledge_ingest_source($1, $2) value", "50920000-0000-4000-8000-000000000054", "retry ingest"],
  ]) {
    const first = await client.query(statement, [knowledgeSourceId, key]);
    const replayed = await client.query(statement, [knowledgeSourceId, key]);
    assert(
      JSON.stringify(first.rows[0].value) === JSON.stringify(replayed.rows[0].value),
      `${label} idempotency did not replay the stored result`,
    );
    await expectSqlState(
      `${label}_key_reuse`,
      statement.replace(" value", ""),
      ["50920000-0000-4000-8000-000000000099", key],
      "22023",
    );
  }
  await client.query("select public.review_steward_library_file($1, 'approved')", [knowledgeFileId]);
  const publishKey = "50920000-0000-4000-8000-000000000055";
  const firstPublish = await client.query(
    "select public.publish_steward_file_to_catalog($1, 'general', $2) value",
    [knowledgeFileId, publishKey],
  );
  const replayedPublish = await client.query(
    "select public.publish_steward_file_to_catalog($1, 'general', $2) value",
    [knowledgeFileId, publishKey],
  );
  assert(
    JSON.stringify(firstPublish.rows[0].value) === JSON.stringify(replayedPublish.rows[0].value),
    "catalog publish idempotency did not replay the stored result",
  );
  await expectSqlState(
    "publish_key_reuse",
    "select public.publish_steward_file_to_catalog($1, 'changed-category', $2)",
    [knowledgeFileId, publishKey],
    "22023",
  );
  await client.query("reset role");
  const receiptProof = await client.query(`
    select
      (select count(*)::integer from private.mi1_w2_operation_receipts where organization_id=$1) receipts,
      (select count(*)::integer from public.organization_audit_events
        where organization_id=$1 and event_type in (
          'knowledge_source_retried', 'knowledge_source_chunks_cleared',
          'knowledge_file_published_to_catalog'
        )) mutation_audits
  `, [ids.organization]);
  assert(
    receiptProof.rows[0].receipts === 5 && receiptProof.rows[0].mutation_audits === 3,
    `knowledge mutation replay produced duplicate effects: ${JSON.stringify(receiptProof.rows[0])}`,
  );

  await client.query("rollback");
  process.stdout.write("MI1 W2 feature persistence live visibility, survey publish, and catalog checks passed; fixtures rolled back.\n");
} catch (error) {
  try { await client.query("rollback"); } catch { /* ignore */ }
  fail(error.message);
} finally {
  await client.end();
}
