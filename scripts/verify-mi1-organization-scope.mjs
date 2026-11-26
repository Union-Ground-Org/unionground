#!/usr/bin/env node
// Static verifier for the MI1 organization-scope foundation.
//
// Default: parse the reserved migration and db-contract offline. This is the
// only mode this worktree may run — the local Supabase stack is shared and
// must not be reset or mutated.
//
// Exclusive disposable database (root later):
//   MI1_EXCLUSIVE_DB_URL=postgresql://... \
//   MI1_EXCLUSIVE_DB_CONFIRM=organization-scope-disposable \
//   node scripts/verify-mi1-organization-scope.mjs --live
//
// Refuse production project refs, SAMPLE refs listed in db-contract.json, and
// shared local ports 54322 and 54422.
// Live mode must use a transaction that rolls back. Commands for the exclusive
// stack are in docs/mi1/w1/x-db/exclusive-db-proof.md.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import pg from "pg";
import { forbiddenProjectRefIn } from "./lib/assert-exact-target.mjs";
import { requireRlsTables } from "./lib/db-contract-tables.mjs";
import {
  deleteOrganizationDependents, memberClaims, prepareRaceSessions, raceClaims, runMi1XdbSecurityExtensions,
} from "./verify-mi1-xdb-security-extensions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const migrationPath = join(ROOT, "supabase/migrations/20260822010000_mi1_organization_scope_foundation.sql");
const contractPath = join(HERE, "db-contract.json");
const sql = readFileSync(migrationPath, "utf8");
const contract = JSON.parse(readFileSync(contractPath, "utf8"));

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function requireNeedle(haystack, needle, label) {
  if (!haystack.includes(needle)) fail(`missing ${label}: ${needle}`);
}

function stripSqlComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ");
}

requireNeedle(sql, "create table public.organizations", "organizations table");
requireNeedle(sql, "create table public.organization_memberships", "memberships table");
requireNeedle(sql, "create table public.organization_role_grants", "role grants table");
requireNeedle(sql, "create table public.organization_audit_events", "audit table");
requireNeedle(sql, "public.bootstrap_first_organization", "bootstrap rpc");
requireNeedle(sql, "ownerless chapter writes are prohibited", "ownerless chapter guard");
requireNeedle(sql, "foreign chapter switching denied", "foreign switch guard");
requireNeedle(sql, "private.can_read_member_broadcast", "broadcast visibility helper");
requireNeedle(sql, "chapter_records_read_contacts", "contact-record policy");
requireNeedle(sql, "drop function if exists public.publish_member_broadcast(text, text, text)", "publish signature replacement");
requireNeedle(sql, "public.member_chapter_memberships cm", "active selected-chapter derivation");
requireNeedle(sql, "public.organization_memberships om", "active selected-organization derivation");
requireNeedle(sql, "o.status = 'active'", "active organization lifecycle gate");
requireNeedle(sql, "private.staff_mfa_required(p_organization_id uuid)", "tenant-keyed MFA resolver");
requireNeedle(sql, "org_security_policy_organization_key", "tenant-keyed MFA uniqueness");
requireNeedle(sql, "org_security_policy_legacy_singleton_key", "legacy MFA quarantine");
requireNeedle(sql, "organization-wide steward role required", "organization broadcast role gate");
requireNeedle(sql, "private.staff_actor_can_see_user", "tenant-keyed explicit actor helper");
const explicitActorVisibility = sql.match(/create or replace function private\.staff_actor_can_see_user[\s\S]*?\$function\$;/)?.[0] || "";
for (const needle of [
  "actor_chapter.organization_id = target_chapter.organization_id",
  "actor_membership.user_id = actor_profile.id",
  "actor_membership.status = 'active'",
]) requireNeedle(explicitActorVisibility, needle, "selected-tenant explicit actor visibility");
requireNeedle(sql, "member_admin_audit_assign_organization", "tenant-keyed admin-audit trigger");
requireNeedle(sql, "m.organization_id is not null", "fail-closed admin-audit scope");
requireNeedle(sql, "m.organization_id = audit_org", "tenant-keyed admin-audit reader");
requireNeedle(sql, "public.set_member_organization_role", "organization role management RPC");
requireNeedle(sql, "cannot remove the last organization admin", "last organization admin guard");
requireNeedle(sql, "private.staff_mfa_required(c.organization_id)", "chapter-role tenant MFA enrollment gate");
requireNeedle(sql, "organization-role:' || target_org::text", "chapter-revocation organization-role lock");
requireNeedle(sql, "organization-role:' || locked_org::text", "organization-role authorization lock");
requireNeedle(sql, "member-broadcast-publish:' || caller::text", "publisher rate-limit lock");
requireNeedle(sql, "s.chapter_id = caller_chapter", "survey task chapter ownership");
requireNeedle(sql, "member-chapter:' || caller::text", "source-task chapter-switch lock");
requireNeedle(sql, "union_base_invitation_id", "claimed invitation enrollment bridge");
requireNeedle(sql, "created_by uuid references auth.users(id) on delete set null", "deletable organization creator attribution");
requireNeedle(sql, "raw_app_meta_data", "signed SAMPLE role metadata guard");
requireNeedle(sql, "private.assert_member_account_deletion_allowed", "final-admin account deletion guard");
requireNeedle(sql, "auth_users_preserve_final_organization_admin", "authoritative Auth deletion trigger");
requireNeedle(sql, "member_account_deletions_preserve_final_organization_admin", "deletion-request preflight trigger");
requireNeedle(sql, "private.require_member_invitation_admin_chapter", "locked invitation authorization helper");
requireNeedle(sql, "private.organization_member_roles", "tenant-bound legacy role projection");
requireNeedle(sql, "member_reward_grants_owned_live_uniq", "tenant-owned reward uniqueness");
requireNeedle(sql, "legacy reward grants are quarantined", "legacy reward quarantine");
requireNeedle(sql, "g.organization_id = private.current_member_organization()", "tenant-bound reward effect");

const sampleRoleGuard = sql.match(/create function private\.forbid_new_ownerless_member_roles[\s\S]*?\$function\$;/)?.[0] || "";
for (const needle of ["new.role in ('admin', 'vp')", "auth.jwt() ->> 'role'", "raw_app_meta_data"]) {
  requireNeedle(sampleRoleGuard, needle, "narrow SAMPLE role guard");
}
if (sampleRoleGuard.includes("raw_user_meta_data")) fail("SAMPLE role guard must not trust user metadata");

const accountDeleteGuard = sql.match(/create function private\.assert_member_account_deletion_allowed[\s\S]*?\$function\$;/)?.[0] || "";
requireNeedle(accountDeleteGuard, "select distinct m.organization_id", "all-membership account-deletion lock discovery");
requireNeedle(accountDeleteGuard, "order by m.organization_id", "sorted account-deletion locks");
requireNeedle(accountDeleteGuard, "m.user_id = p_user_id", "target account-deletion memberships");
requireNeedle(accountDeleteGuard, "backup.user_id <> p_user_id", "backup organization admin recheck");

const chapterMemberships = sql.match(/create or replace function public\.get_my_chapter_memberships[\s\S]*?\$function\$;/)?.[0] || "";
for (const needle of [
  "private.current_member_organization() is null",
  "om.organization_id = c.organization_id",
  "o.status = 'active'",
]) requireNeedle(chapterMemberships, needle, "NULL-selected chapter recovery projection");

const chapterSwitch = sql.match(/create or replace function public\.switch_my_chapter[\s\S]*?\$function\$;/)?.[0] || "";
for (const needle of [
  "om.organization_id = target_org",
  "om.user_id = caller",
  "o.status = 'active'",
  "current_org is not null and current_org is distinct from target_org",
]) requireNeedle(chapterSwitch, needle, "direct active-membership chapter recovery");
if (chapterSwitch.includes("private.is_organization_member(target_org)")) {
  fail("chapter recovery must not require an already-selected organization");
}

const invitationGuard = sql.match(/create function private\.require_member_invitation_admin_chapter[\s\S]*?\$function\$;/)?.[0] || "";
const invitationOrganizationLock = invitationGuard.indexOf("organization-role:");
const invitationMemberLock = invitationGuard.indexOf("member-chapter:");
if (invitationOrganizationLock < 0 || invitationMemberLock < 0 || invitationOrganizationLock >= invitationMemberLock) {
  fail("invitation authorization must lock organization before caller membership");
}

const rewardGuard = sql.match(/create function private\.forbid_ownerless_reward_grant_write[\s\S]*?\$function\$;/)?.[0] || "";
for (const needle of [
  "ownerless reward grant writes are prohibited",
  "legacy reward grants are quarantined",
  "reward grant organization is immutable",
]) requireNeedle(rewardGuard, needle, "reward ownership guard");

const genericRole = sql.match(/create or replace function public\.member_has_role[\s\S]*?\$function\$;/)?.[0] || "";
if (genericRole.includes("public.organization_role_grants")) {
  fail("generic legacy role helper must not admit organization-wide grants into deferred NULL-sentinel RPCs");
}

const softDeleteTask = sql.match(/create or replace function public\.soft_delete_chapter_task[\s\S]*?\$function\$;/)?.[0] || "";
const restoreTask = sql.match(/create or replace function public\.restore_chapter_task[\s\S]*?\$function\$;/)?.[0] || "";
for (const needle of [
  "'member-chapter:' || caller::text",
  "private.member_has_chapter_role(",
  "t.chapter_id = caller_chapter",
]) {
  requireNeedle(softDeleteTask, needle, "chapter-switch-safe task deletion");
  requireNeedle(restoreTask, needle, "chapter-switch-safe task restoration");
}

if (/\binsert into public\.organizations\b/i.test(sql) && !sql.includes("insert into public.organizations (slug, name, status, created_by)")) {
  fail("unexpected organizations insert outside bootstrap");
}

const bootstrapGrant = /grant execute on function public\.bootstrap_first_organization\([^)]*\)\s+to service_role/.test(sql);
if (!bootstrapGrant) fail("bootstrap must grant execute only to service_role");
if (/grant execute on function public\.bootstrap_first_organization\([^)]*\)\s+to authenticated/.test(sql)) {
  fail("bootstrap must not be executable by authenticated");
}

requireRlsTables(contract, ["organizations", "organization_memberships", "organization_role_grants", "organization_audit_events"]);

const featureSql = readFileSync(
  join(ROOT, "supabase/migrations/20260822020000_mi1_w1_feature_persistence.sql"),
  "utf8",
);
const featureCode = stripSqlComments(featureSql);
if (!/\b(create|alter|drop|grant|revoke)\b/i.test(featureCode)) {
  fail("MI1 feature persistence migration has no executable DDL");
}
for (const [needle, label] of [
  ["create table public.member_qa_questions", "QA questions table"],
  ["create table public.pay_scale_grades", "pay grades table"],
  ["create table public.organization_integrations", "integrations table"],
  ["create table public.organization_audit_ledger", "audit ledger table"],
  ["create table public.public_event_rsvps", "public RSVP table"],
  ["SCIM stays disabled until the enterprise-later gate", "SCIM disabled"],
  ["grant execute on function public.submit_public_event_rsvp(text, text, text, text, text, text, text, text) to service_role", "service-role RSVP"],
  ["grant execute on function public.record_organization_audit_event(uuid, text, text, text, text, text, uuid, jsonb) to service_role", "service-role audit writer"],
  ["jsonb_build_object('accepted', true)", "uniform RSVP acceptance"],
  ["create trigger member_cases_bind_organization", "immutable case owner trigger"],
  ["unique nulls not distinct (job_name, run_id, organization_id)", "platform job idempotency"],
  ["e.organization_id = r.organization_id", "same-tenant microsite event pairing"],
  ["on conflict (idempotency_key) do nothing", "append-only audit replay"],
  ["privacy_threshold integer := 5", "analytics privacy threshold"],
]) {
  requireNeedle(featureCode, needle, label);
}

const payScopeGuardSql = stripSqlComments(readFileSync(
  join(ROOT, "supabase/migrations/20260826002000_pay_scale_expected_organization_guard.sql"),
  "utf8",
));
for (const [needle, label] of [
  ["private.mi1_require_expected_selected_organization(p_expected_organization_id)", "Pay expected-organization comparison"],
  ["p_expected_organization_id is distinct from org", "Pay stale-scope rejection"],
  ["drop function if exists public.upsert_pay_scale_grade(text, text, text, integer, text)", "unguarded Pay grade writer removal"],
  ["drop function if exists public.upsert_pay_scale_step(text, date, integer, integer)", "unguarded Pay step writer removal"],
  ["grant execute on function public.upsert_pay_scale_grade(uuid, text, text, text, integer, text) to authenticated", "guarded Pay grade writer grant"],
  ["grant execute on function public.upsert_pay_scale_step(uuid, text, date, integer, integer) to authenticated", "guarded Pay step writer grant"],
]) {
  requireNeedle(payScopeGuardSql, needle, label);
}
if (/grant execute on function public\.submit_public_event_rsvp\([^)]*\) to (anon|authenticated)/.test(featureCode)) {
  fail("public RSVP must not be executable by anon or authenticated");
}
if (contract.policyCoverage.unconditionalPolicyAllowlist.includes("chapters.chapters_select_all")) {
  fail("chapters_select_all must leave the unconditional allowlist");
}

const liveRequested = process.argv.includes("--live") || process.env.MI1_EXCLUSIVE_DB_URL;
if (!liveRequested) {
  process.stdout.write("MI1 organization-scope static verification passed. Exclusive-DB proof skipped.\n");
  process.exit(0);
}

if (process.env.MI1_EXCLUSIVE_DB_CONFIRM !== "organization-scope-disposable") {
  fail("Refusing live mode without MI1_EXCLUSIVE_DB_CONFIRM=organization-scope-disposable");
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
if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
  fail("MI1_EXCLUSIVE_DB_URL must use postgres:// or postgresql://");
}

const { Client } = pg;
const client = new Client({ connectionString: url });
const ids = {
  actor: "50910000-0000-4000-8000-000000000001",
  memberA: "50910000-0000-4000-8000-000000000002",
  memberB: "50910000-0000-4000-8000-000000000003",
  orgA: "50910000-0000-4000-8000-000000000011",
  orgB: "50910000-0000-4000-8000-000000000012",
  invited: "50910000-0000-4000-8000-000000000004",
  invitation: "50910000-0000-4000-8000-000000000021",
  creator: "50910000-0000-4000-8000-000000000005",
  orgCreatorProof: "50910000-0000-4000-8000-000000000013",
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function asRole(role, userId = null, aal = "aal1") {
  await client.query("reset role");
  const claims = userId ? await memberClaims(client, userId, role, aal) : { role };
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
  await client.query(`set local role ${role}`);
}

async function expectSqlState(label, statement, values, state) {
  const savepoint = `mi1_${label.replace(/[^a-z0-9]/gi, "_")}`;
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

async function authenticateClient(target, userId, aal = "aal2") {
  await target.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify(raceClaims(userId, aal)),
  ]);
  await target.query("set local role authenticated");
}

async function waitForAdvisoryWait(observer, applicationName) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await observer.query(`
      select 1
      from pg_catalog.pg_stat_activity
      where application_name = $1
        and wait_event_type = 'Lock'
        and wait_event = 'advisory'
    `, [applicationName]);
    if (waiting.rowCount === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${applicationName} did not reach the advisory-lock wait`);
}

async function runConcurrentGuards(observer) {
  const race = {
    actor: "50910000-0000-4000-8000-000000000101",
    backupAdmin: "50910000-0000-4000-8000-000000000102",
    member: "50910000-0000-4000-8000-000000000103",
    org: "50910000-0000-4000-8000-000000000111",
    chapter: "mi1-race",
    chapterB: "mi1-race-b",
    notification: "50910000-0000-4000-8000-000000000121",
    deleteTask: "50910000-0000-4000-8000-000000000122",
  };
  const peers = {
    locker: new Client({ connectionString: url, application_name: "mi1-lock-holder" }),
    grantRequest: new Client({ connectionString: url, application_name: "mi1-membership-grant-request" }),
    revokeRequest: new Client({ connectionString: url, application_name: "mi1-membership-revoke-request" }),
    ordinaryRequest: new Client({ connectionString: url, application_name: "mi1-ordinary-request" }),
    switchRequest: new Client({ connectionString: url, application_name: "mi1-switch-request" }),
    taskRequest: new Client({ connectionString: url, application_name: "mi1-task-request" }),
    deleteRequest: new Client({ connectionString: url, application_name: "mi1-delete-request" }),
    restoreRequest: new Client({ connectionString: url, application_name: "mi1-restore-request" }),
    orgRequest: new Client({ connectionString: url, application_name: "mi1-org-role-request" }),
    chapterRequest: new Client({ connectionString: url, application_name: "mi1-chapter-role-request" }),
    createChapterRequest: new Client({ connectionString: url, application_name: "mi1-create-chapter-request" }),
    publishA: new Client({ connectionString: url, application_name: "mi1-publish-a" }),
    publishB: new Client({ connectionString: url, application_name: "mi1-publish-b" }),
  };

  for (const peer of Object.values(peers)) await peer.connect();
  try {
    await observer.query("reset role");
    await observer.query("begin");
    await observer.query(
      "insert into auth.users (id, email) values ($1, 'mi1-race-actor@example.invalid'), ($2, 'mi1-race-backup@example.invalid'), ($3, 'mi1-race-member@example.invalid')",
      [race.actor, race.backupAdmin, race.member],
    );
    await observer.query(
      "insert into public.organizations (id, slug, name, created_by) values ($1, 'mi1-race-org', 'MI1 Race Organization', $2)",
      [race.org, race.actor],
    );
    await observer.query(
      `insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values
        ($1, 'MI1 Race Chapter', 'mi1-race', true, 1, $3),
        ($2, 'MI1 Race Chapter B', 'mi1-race-b', false, 2, $3)`,
      [race.chapter, race.chapterB, race.org],
    );
    // The member already belongs to the organization: a chapter grant adds a
    // chapter inside it and never admits someone from outside
    // (SEC-UG-MEMBER-RECOVERY-AND-CHAPTER-GRANT-TENANT-CHECK-20260925).
    await observer.query(`
      insert into public.organization_memberships (organization_id, user_id, status) values
        ($1, $2, 'active'), ($1, $3, 'active'), ($1, $4, 'active')
    `, [race.org, race.actor, race.backupAdmin, race.member]);
    await observer.query(
      "insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active'), ($1, $3, 'active')",
      [race.actor, race.chapter, race.chapterB],
    );
    await observer.query("update public.member_profiles set chapter_id = $2 where id = $1", [race.actor, race.chapter]);
    await observer.query(`
      insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values
        ($1, $2, 'admin', $3), ($1, $3, 'admin', $3)
    `, [race.org, race.actor, race.backupAdmin]);
    await observer.query(`
      insert into public.member_roles (user_id, role, chapter_id, granted_by) values
        ($1, 'admin', $2, $1), ($1, 'steward', $2, $1)
    `, [race.actor, race.chapter]);
    await observer.query(`
      insert into public.member_role_chapters (user_id, role, chapter_id, granted_by) values
        ($1, 'admin', $2, $1), ($1, 'steward', $2, $1)
    `, [race.actor, race.chapter]);
    await observer.query(
      "insert into public.org_security_policy (id, organization_id, require_staff_mfa) values (true, $1, false)",
      [race.org],
    );
    await observer.query(
      "insert into public.chapter_workstreams (chapter_id, name, created_by) values ($1, 'General', $3), ($2, 'General', $3)",
      [race.chapter, race.chapterB, race.actor],
    );
    await observer.query("select set_config('request.jwt.claims', $1, false)", [
      JSON.stringify({ sub: race.actor, role: "authenticated", aal: "aal2" }),
    ]);
    await observer.query(`
      insert into public.chapter_tasks (id, chapter_id, title, task_number, created_by)
      values ($1, $2, 'Delete race proof', 990001, $3)
    `, [race.deleteTask, race.chapter, race.actor]);
    await observer.query("select set_config('request.jwt.claims', '{}', false)");
    await observer.query(
      "insert into public.member_notifications (id, user_id, title, body, kind) values ($1, $2, 'Race source', 'Race source', 'general')",
      [race.notification, race.member],
    );
    await observer.query(`
      insert into public.member_broadcasts
        (id, sender, title, body, published_at, order_index, created_by, locale, organization_id, chapter_id, audience_scope)
      select 'mi1-race-broadcast-' || n, 'Proof', 'Existing ' || n, 'Existing',
             now(), 600000 + n, $1, 'en', $2, $3, 'chapter'
      from pg_catalog.generate_series(1, 4) n
    `, [race.actor, race.org, race.chapter]);
    await prepareRaceSessions(observer, [race.actor, race.member]);
    await observer.query("commit");

    // Queue grant before revoke behind a third-party tenant lock. Both RPCs
    // must acquire organization→member in the same order, complete without a
    // deadlock, and leave the later revocation as the deterministic state.
    await peers.locker.query("begin");
    await peers.locker.query(
      "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:' || $1::text, 509))",
      [race.org],
    );
    await peers.grantRequest.query("begin");
    await authenticateClient(peers.grantRequest, race.actor);
    const membershipGrant = peers.grantRequest
      .query("select public.grant_member_chapter_membership($1, $2)", [race.member, race.chapter])
      .then(() => ({ code: "" }))
      .catch((error) => ({ code: error.code || error.message }));
    await waitForAdvisoryWait(observer, "mi1-membership-grant-request");
    await peers.revokeRequest.query("begin");
    await authenticateClient(peers.revokeRequest, race.actor);
    const membershipRevoke = peers.revokeRequest
      .query("select public.revoke_member_chapter_membership($1, $2)", [race.member, race.chapter])
      .then(() => ({ code: "" }))
      .catch((error) => ({ code: error.code || error.message }));
    await waitForAdvisoryWait(observer, "mi1-membership-revoke-request");
    await peers.locker.query("commit");
    const grantOutcome = await membershipGrant;
    await peers.grantRequest.query(grantOutcome.code === "" ? "commit" : "rollback");
    const revokeOutcome = await membershipRevoke;
    await peers.revokeRequest.query(revokeOutcome.code === "" ? "commit" : "rollback");
    assert(
      grantOutcome.code === "" && revokeOutcome.code === "",
      `queued grant/revoke returned ${grantOutcome.code || "success"}/${revokeOutcome.code || "success"}`,
    );
    let result = await observer.query(`
      select
        (select status from public.member_chapter_memberships where user_id = $1 and chapter_id = $2) chapter_status,
        (select status from public.organization_memberships where user_id = $1 and organization_id = $3) organization_status
    `, [race.member, race.chapter, race.org]);
    assert(
      result.rows[0].chapter_status === "revoked" && result.rows[0].organization_status === "revoked",
      "queued grant/revoke did not finish in deterministic revoked state",
    );

    await observer.query(
      "update public.organization_memberships set status = 'active', revoked_at = null where organization_id = $1 and user_id = $2",
      [race.org, race.member],
    );
    await observer.query(
      "update public.member_chapter_memberships set status = 'active', revoked_at = null where chapter_id = $1 and user_id = $2",
      [race.chapter, race.member],
    );
    await observer.query("update public.member_profiles set chapter_id = $2 where id = $1", [race.member, race.chapter]);

    await peers.locker.query("begin");
    await peers.locker.query(
      "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:' || $1::text, 509))",
      [race.org],
    );
    const ordinaryCalls = [
      ["grant", "select public.grant_member_chapter_membership($1, $2)", [race.member, race.chapter]],
      ["revoke", "select public.revoke_member_chapter_membership($1, $2)", [race.member, race.chapter]],
      ["chapter role", "select public.set_member_chapter_role($1, $2, 'steward', true)", [race.member, race.chapter]],
      ["organization role", "select public.set_member_organization_role($1, 'steward', true)", [race.member]],
    ];
    for (const [label, statement, values] of ordinaryCalls) {
      await peers.ordinaryRequest.query("begin");
      await authenticateClient(peers.ordinaryRequest, race.member);
      await peers.ordinaryRequest.query("set local statement_timeout = '250ms'");
      let code = "";
      try {
        await peers.ordinaryRequest.query(statement, values);
      } catch (error) {
        code = error.code || error.message;
      }
      await peers.ordinaryRequest.query("rollback");
      assert(code === "42501", `ordinary ${label} call returned ${code || "success"} instead of immediate 42501`);
    }
    await peers.locker.query("commit");

    // A chapter create queued behind the tenant authorization lock must use
    // the post-lock organization-admin state, not the stale precheck. The
    // revoker takes the case graph first, as every writer has since
    // 20260907150000 (create_admin_chapter enters through it too); holding
    // only the tenant lock would deadlock the revocation against the queued
    // create's entry gate instead.
    await peers.locker.query("begin");
    await peers.locker.query("select private.lock_case_graph(array[$1]::uuid[], array[]::uuid[])", [race.actor]);
    await peers.locker.query(
      "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:' || $1::text, 509))",
      [race.org],
    );
    await peers.createChapterRequest.query("begin");
    await authenticateClient(peers.createChapterRequest, race.actor);
    const createChapterRequest = peers.createChapterRequest
      .query("select public.create_admin_chapter('mi1-race-stale','Stale chapter',null,null)")
      .then(() => ({ code: "" }))
      .catch((error) => ({ code: error.code || error.message }));
    await waitForAdvisoryWait(observer, "mi1-create-chapter-request");
    await peers.locker.query(
      "delete from public.organization_role_grants where organization_id=$1 and user_id=$2 and role='admin'",
      [race.org, race.actor],
    );
    await peers.locker.query("commit");
    const createChapterOutcome = await createChapterRequest;
    await peers.createChapterRequest.query("rollback");
    assert(
      createChapterOutcome.code === "42501",
      `queued chapter create returned ${createChapterOutcome.code || "success"}`,
    );
    result = await observer.query("select count(*)::int count from public.chapters where id='mi1-race-stale'");
    assert(result.rows[0].count === 0, "queued chapter create left a row after admin revocation");
    await observer.query(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'admin',$3)",
      [race.org, race.actor, race.backupAdmin],
    );

    await observer.query(
      "insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')",
      [race.member, race.chapterB],
    );
    await observer.query(
      "insert into public.member_roles (user_id, role, chapter_id, granted_by) values ($1, 'steward', $2, $3)",
      [race.member, race.chapter, race.actor],
    );
    await observer.query(
      "insert into public.member_role_chapters (user_id, role, chapter_id, granted_by) values ($1, 'steward', $2, $3)",
      [race.member, race.chapter, race.actor],
    );

    await peers.locker.query("begin");
    await peers.locker.query(
      "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-chapter:' || $1::text, 0))",
      [race.member],
    );
    await peers.switchRequest.query("begin");
    await authenticateClient(peers.switchRequest, race.member);
    const switchRequest = peers.switchRequest
      .query("select public.switch_my_chapter($1)", [race.chapterB])
      .then(() => ({ code: "" }))
      .catch((error) => ({ code: error.code || error.message }));
    await waitForAdvisoryWait(observer, "mi1-switch-request");
    await peers.taskRequest.query("begin");
    await authenticateClient(peers.taskRequest, race.member);
    const taskRequest = peers.taskRequest
      .query("select public.create_chapter_task_from_source('notification', $1)", [race.notification])
      .then(() => ({ code: "" }))
      .catch((error) => ({ code: error.code || error.message }));
    await waitForAdvisoryWait(observer, "mi1-task-request");
    await peers.locker.query("commit");
    const switchOutcome = await switchRequest;
    await peers.switchRequest.query(switchOutcome.code === "" ? "commit" : "rollback");
    const taskOutcome = await taskRequest;
    await peers.taskRequest.query("rollback");
    assert(switchOutcome.code === "", `queued chapter switch returned ${switchOutcome.code}`);
    assert(taskOutcome.code === "42501", `post-switch task call returned ${taskOutcome.code || "success"}`);
    result = await observer.query("select chapter_id from public.member_profiles where id = $1", [race.member]);
    assert(result.rows[0].chapter_id === race.chapterB, "queued switch did not select chapter B before task authorization");
    result = await observer.query(`
      select
        (select count(*)::int from public.chapter_tasks where chapter_id = $1) task_count,
        (select count(*)::int from public.chapter_task_attachments where chapter_id = $1) attachment_count,
        (select count(*)::int from public.chapter_task_activity a join public.chapter_tasks t on t.id = a.task_id where t.chapter_id = $1) activity_count
    `, [race.chapterB]);
    assert(
      result.rows[0].task_count === 0
        && result.rows[0].attachment_count === 0
        && result.rows[0].activity_count === 0,
      "post-switch task denial left chapter B side effects",
    );
    await observer.query("update public.member_profiles set chapter_id = $2 where id = $1", [race.member, race.chapter]);

    // A chapter switch queued ahead of deletion must determine the exact
    // post-lock authorization scope. The stale chapter-A role cannot delete a
    // chapter-A task after the profile has moved to chapter B.
    await peers.locker.query("begin");
    await peers.locker.query(
      "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-chapter:' || $1::text, 0))",
      [race.member],
    );
    await peers.switchRequest.query("begin");
    await authenticateClient(peers.switchRequest, race.member);
    const deleteRaceSwitch = peers.switchRequest
      .query("select public.switch_my_chapter($1)", [race.chapterB])
      .then(() => ({ code: "" }))
      .catch((error) => ({ code: error.code || error.message }));
    await waitForAdvisoryWait(observer, "mi1-switch-request");
    await peers.deleteRequest.query("begin");
    await authenticateClient(peers.deleteRequest, race.member);
    const deleteRequest = peers.deleteRequest
      .query("select public.soft_delete_chapter_task($1)", [race.deleteTask])
      .then(() => ({ code: "" }))
      .catch((error) => ({ code: error.code || error.message }));
    await waitForAdvisoryWait(observer, "mi1-delete-request");
    await peers.locker.query("commit");
    const deleteSwitchOutcome = await deleteRaceSwitch;
    await peers.switchRequest.query(deleteSwitchOutcome.code === "" ? "commit" : "rollback");
    const deleteOutcome = await deleteRequest;
    await peers.deleteRequest.query("rollback");
    assert(deleteSwitchOutcome.code === "", `queued delete-race chapter switch returned ${deleteSwitchOutcome.code}`);
    assert(deleteOutcome.code === "42501", `post-switch task deletion returned ${deleteOutcome.code || "success"}`);
    result = await observer.query("select deleted_at, deleted_by from public.chapter_tasks where id = $1", [race.deleteTask]);
    assert(
      result.rows[0].deleted_at === null && result.rows[0].deleted_by === null,
      "post-switch task deletion mutated the chapter-A task",
    );
    await observer.query("update public.member_profiles set chapter_id = $2 where id = $1", [race.member, race.chapter]);

    // Establish a real deleted row through the guarded positive path, then
    // prove a switch queued ahead of restore cannot reuse stale chapter-A
    // authority. The denial must leave the deletion audit state unchanged.
    await peers.deleteRequest.query("begin");
    await authenticateClient(peers.deleteRequest, race.member);
    await peers.deleteRequest.query("select public.soft_delete_chapter_task($1)", [race.deleteTask]);
    await peers.deleteRequest.query("commit");
    result = await observer.query("select deleted_at, deleted_by from public.chapter_tasks where id = $1", [race.deleteTask]);
    assert(
      result.rows[0].deleted_at !== null && result.rows[0].deleted_by === race.member,
      "positive task deletion did not stamp its audit state",
    );

    await peers.locker.query("begin");
    await peers.locker.query(
      "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-chapter:' || $1::text, 0))",
      [race.member],
    );
    await peers.switchRequest.query("begin");
    await authenticateClient(peers.switchRequest, race.member);
    const restoreRaceSwitch = peers.switchRequest
      .query("select public.switch_my_chapter($1)", [race.chapterB])
      .then(() => ({ code: "" }))
      .catch((error) => ({ code: error.code || error.message }));
    await waitForAdvisoryWait(observer, "mi1-switch-request");
    await peers.restoreRequest.query("begin");
    await authenticateClient(peers.restoreRequest, race.member);
    const restoreRequest = peers.restoreRequest
      .query("select public.restore_chapter_task($1)", [race.deleteTask])
      .then(() => ({ code: "" }))
      .catch((error) => ({ code: error.code || error.message }));
    await waitForAdvisoryWait(observer, "mi1-restore-request");
    await peers.locker.query("commit");
    const restoreSwitchOutcome = await restoreRaceSwitch;
    await peers.switchRequest.query(restoreSwitchOutcome.code === "" ? "commit" : "rollback");
    const restoreOutcome = await restoreRequest;
    await peers.restoreRequest.query("rollback");
    assert(restoreSwitchOutcome.code === "", `queued restore-race chapter switch returned ${restoreSwitchOutcome.code}`);
    assert(restoreOutcome.code === "42501", `post-switch task restoration returned ${restoreOutcome.code || "success"}`);
    result = await observer.query("select deleted_at, deleted_by from public.chapter_tasks where id = $1", [race.deleteTask]);
    assert(
      result.rows[0].deleted_at !== null && result.rows[0].deleted_by === race.member,
      "post-switch task restoration changed the chapter-A deletion audit state",
    );

    await observer.query("update public.member_profiles set chapter_id = $2 where id = $1", [race.member, race.chapter]);
    await peers.restoreRequest.query("begin");
    await authenticateClient(peers.restoreRequest, race.member);
    await peers.restoreRequest.query("select public.restore_chapter_task($1)", [race.deleteTask]);
    await peers.restoreRequest.query("commit");
    result = await observer.query("select deleted_at, deleted_by from public.chapter_tasks where id = $1", [race.deleteTask]);
    assert(
      result.rows[0].deleted_at === null && result.rows[0].deleted_by === null,
      "positive task restoration did not clear its audit state",
    );

    await peers.locker.query("begin");
    // The revoker enters through the case graph first, as the chapter create
    // race above explains.
    await peers.locker.query("select private.lock_case_graph(array[$1]::uuid[], array[]::uuid[])", [race.actor]);
    await peers.locker.query(
      "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:' || $1::text, 509))",
      [race.org],
    );
    await peers.orgRequest.query("begin");
    await authenticateClient(peers.orgRequest, race.actor);
    const orgRequest = peers.orgRequest
      .query("select public.set_member_organization_role($1, 'vp', true)", [race.actor])
      .then(() => ({ code: "" }))
      .catch((error) => ({ code: error.code || error.message }));
    await waitForAdvisoryWait(observer, "mi1-org-role-request");
    await peers.locker.query(
      "delete from public.organization_role_grants where organization_id = $1 and user_id = $2 and role = 'admin'",
      [race.org, race.actor],
    );
    await peers.locker.query("commit");
    const orgOutcome = await orgRequest;
    await peers.orgRequest.query("rollback");
    assert(orgOutcome.code === "42501", `queued organization self-regrant returned ${orgOutcome.code || "success"}`);
    result = await observer.query(
      "select count(*)::int count from public.organization_role_grants where organization_id = $1 and user_id = $2 and role = 'vp'",
      [race.org, race.actor],
    );
    assert(result.rows[0].count === 0, "queued organization self-regrant created a role");

    await peers.locker.query("begin");
    // The revoker enters through the case graph first, as the chapter create
    // race above explains.
    await peers.locker.query("select private.lock_case_graph(array[$1]::uuid[], array[]::uuid[])", [race.actor]);
    await peers.locker.query(
      "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:' || $1::text, 509))",
      [race.org],
    );
    await peers.chapterRequest.query("begin");
    await authenticateClient(peers.chapterRequest, race.actor);
    const chapterRequest = peers.chapterRequest
      .query("select public.set_member_chapter_role($1, $2, 'admin', true)", [race.actor, race.chapter])
      .then(() => ({ code: "" }))
      .catch((error) => ({ code: error.code || error.message }));
    await waitForAdvisoryWait(observer, "mi1-chapter-role-request");
    await peers.locker.query(
      "delete from public.member_role_chapters where user_id = $1 and chapter_id = $2 and role = 'admin'",
      [race.actor, race.chapter],
    );
    await peers.locker.query(
      "delete from public.member_roles where user_id = $1 and chapter_id = $2 and role = 'admin'",
      [race.actor, race.chapter],
    );
    await peers.locker.query("commit");
    const chapterOutcome = await chapterRequest;
    await peers.chapterRequest.query("rollback");
    assert(chapterOutcome.code === "42501", `queued chapter self-restoration returned ${chapterOutcome.code || "success"}`);
    result = await observer.query(
      "select count(*)::int count from public.member_role_chapters where user_id = $1 and chapter_id = $2 and role = 'admin'",
      [race.actor, race.chapter],
    );
    assert(result.rows[0].count === 0, "queued chapter self-restoration recreated the admin role");

    for (const peer of [peers.publishA, peers.publishB]) {
      await peer.query("begin");
      await authenticateClient(peer, race.actor);
    }
    const publish = async (peer, suffix) => {
      try {
        await peer.query(
          "select public.publish_member_broadcast($1, 'Concurrent proof', 'en', 'chapter')",
          [`Concurrent ${suffix}`],
        );
        await peer.query("commit");
        return "success";
      } catch (error) {
        await peer.query("rollback");
        return error.code || error.message;
      }
    };
    const publishOutcomes = await Promise.all([
      publish(peers.publishA, "A"),
      publish(peers.publishB, "B"),
    ]);
    assert(
      publishOutcomes.filter((outcome) => outcome === "success").length === 1
        && publishOutcomes.filter((outcome) => outcome === "54000").length === 1,
      `publish race expected one success and one 54000, got ${publishOutcomes.join(", ")}`,
    );
    result = await observer.query(
      "select count(*)::int count from public.member_broadcasts where created_by = $1",
      [race.actor],
    );
    assert(result.rows[0].count === 5, "publish race did not finish at exactly five broadcasts");
  } finally {
    for (const peer of Object.values(peers)) {
      await peer.query("rollback").catch(() => {});
      await peer.end().catch(() => {});
    }
    await observer.query("reset role").catch(() => {});
    await observer.query("rollback").catch(() => {});
    await observer.query("begin");
    await observer.query("delete from public.member_broadcasts where created_by = $1", [race.actor]);
    await observer.query("delete from public.member_notifications where id = $1", [race.notification]);
    await observer.query("delete from public.chapter_tasks where id = $1", [race.deleteTask]);
    await observer.query("delete from private.chapter_task_number_counters where chapter_id in ($1, $2)", [race.chapter, race.chapterB]);
    await observer.query(
      "delete from public.member_admin_audit where actor = $1 or target_user in ($1, $2)",
      [race.actor, race.member],
    );
    await observer.query("delete from public.member_role_chapters where user_id in ($1, $2)", [race.actor, race.member]);
    await observer.query("delete from public.member_roles where user_id in ($1, $2)", [race.actor, race.member]);
    await observer.query("update public.member_profiles set chapter_id = null where id in ($1, $2)", [race.actor, race.member]);
    await observer.query("delete from public.member_chapter_memberships where user_id in ($1, $2)", [race.actor, race.member]);
    await observer.query("delete from public.organization_role_grants where organization_id = $1", [race.org]);
    await observer.query("delete from public.organization_memberships where organization_id = $1", [race.org]);
    await observer.query("delete from public.org_security_policy where organization_id = $1", [race.org]);
    await observer.query("delete from public.chapter_workstreams where chapter_id in ($1, $2)", [race.chapter, race.chapterB]);
    await observer.query("delete from public.chapters where id in ($1, $2)", [race.chapter, race.chapterB]);
    await deleteOrganizationDependents(observer, [race.org]);
    await observer.query("delete from public.organizations where id = $1", [race.org]);
    await observer.query("delete from auth.users where id in ($1, $2, $3)", [race.actor, race.backupAdmin, race.member]);
    await observer.query("commit");
  }
}

try {
  await client.connect();
  await client.query("begin");
  const initial = await client.query("select count(*)::int count from public.organizations");
  assert(initial.rows[0].count === 0, "exclusive proof requires a fresh reset with zero organizations");

  await client.query(`
    insert into auth.users (id, email) values
      ($1, 'mi1-actor@example.invalid'),
      ($2, 'mi1-member-a@example.invalid'),
      ($3, 'mi1-member-b@example.invalid')
  `, [ids.actor, ids.memberA, ids.memberB]);
  await client.query(`
    insert into public.organizations (id, slug, name, created_by) values
      ($1, 'mi1-org-a', 'MI1 Organization A', $3),
      ($2, 'mi1-org-b', 'MI1 Organization B', $3)
  `, [ids.orgA, ids.orgB, ids.actor]);
  await client.query(`
    insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values
      ('mi1-a', 'Shared chapter', 'shared', true, 1, $1),
      ('mi1-b', 'Shared chapter', 'shared', true, 1, $2)
  `, [ids.orgA, ids.orgB]);
  await client.query(`
    insert into public.member_invitations (
      id, normalized_email, full_name, first_name, initials, chapter_id,
      token_hash, status, invited_by, expires_at, accepting_at
    ) values (
      $1, 'mi1-invited@example.invalid', 'Invited Member', 'Invited', 'IM',
      'mi1-a', repeat('a', 64), 'accepting', $2, now() + interval '1 hour', now()
    )
  `, [ids.invitation, ids.actor]);
  await client.query(`
    insert into auth.users (id, email, raw_user_meta_data) values (
      $1,
      'mi1-invited@example.invalid',
      jsonb_build_object(
        'full_name', 'Invited Member',
        'first_name', 'Invited',
        'initials', 'IM',
        'chapter_id', 'mi1-a',
        'union_base_invitation_id', $2::text
      )
    )
  `, [ids.invited, ids.invitation]);
  let result = await client.query(`
    select
      p.chapter_id,
      exists (
        select 1 from public.organization_memberships om
        where om.organization_id = $2 and om.user_id = $1 and om.status = 'active'
      ) organization_member,
      exists (
        select 1 from public.member_chapter_memberships cm
        where cm.chapter_id = 'mi1-a' and cm.user_id = $1 and cm.status = 'active'
      ) chapter_member
    from public.member_profiles p
    where p.id = $1
  `, [ids.invited, ids.orgA]);
  assert(
    result.rows[0]?.chapter_id === 'mi1-a'
      && result.rows[0].organization_member
      && result.rows[0].chapter_member,
    "accepting invitation did not atomically enroll the organization-backed user",
  );

  await client.query("insert into auth.users (id, email) values ($1, 'mi1-creator@example.invalid')", [ids.creator]);
  await client.query(`
    insert into public.organizations (id, slug, name, created_by)
    values ($1, 'mi1-creator-proof', 'MI1 Creator Proof', $2)
  `, [ids.orgCreatorProof, ids.creator]);
  await client.query("delete from auth.users where id = $1", [ids.creator]);
  result = await client.query(
    "select created_by from public.organizations where id = $1",
    [ids.orgCreatorProof],
  );
  assert(result.rows.length === 1 && result.rows[0].created_by === null, "organization creator deletion did not preserve tenant history");
  await client.query(`
    insert into public.organization_memberships (organization_id, user_id) values
      ($1, $3), ($2, $3), ($1, $4), ($2, $5)
  `, [ids.orgA, ids.orgB, ids.actor, ids.memberA, ids.memberB]);
  await client.query(`
    insert into public.member_chapter_memberships (user_id, chapter_id, status) values
      ($1, 'mi1-a', 'active'), ($1, 'mi1-b', 'active'),
      ($2, 'mi1-a', 'active'), ($3, 'mi1-b', 'active')
  `, [ids.actor, ids.memberA, ids.memberB]);
  await client.query(`
    update public.member_profiles
    set chapter_id = case id when $1 then 'mi1-a' when $2 then 'mi1-a' else 'mi1-b' end
    where id = any($3::uuid[])
  `, [ids.actor, ids.memberA, [ids.actor, ids.memberA, ids.memberB]]);
  await client.query(`
    insert into public.org_security_policy (id, organization_id, require_staff_mfa) values
      (true, $1, false), (true, $2, true)
  `, [ids.orgA, ids.orgB]);
  result = await client.query(
    "select organization_id, require_staff_mfa from public.org_security_policy where organization_id in ($1, $2)",
    [ids.orgA, ids.orgB],
  );
  const initialPolicies = new Map(result.rows.map((row) => [row.organization_id, row.require_staff_mfa]));
  assert(
    initialPolicies.get(ids.orgA) === false && initialPolicies.get(ids.orgB) === true,
    "opposite tenant MFA policy sentinels were not preserved",
  );
  await client.query(
    "insert into public.member_roles (user_id, role, chapter_id) values ($1, 'steward', 'mi1-a')",
    [ids.actor],
  );
  await client.query(`
    insert into public.member_roles (user_id, role, chapter_id) values
      ($1, 'admin', 'mi1-b'), ($2, 'admin', 'mi1-a')
  `, [ids.actor, ids.memberA]);
  await client.query(
    "insert into public.member_role_chapters (user_id, role, chapter_id) values ($1, 'steward', 'mi1-a')",
    [ids.actor],
  );
  await client.query(`
    insert into public.member_role_chapters (user_id, role, chapter_id) values
      ($1, 'admin', 'mi1-b'), ($2, 'admin', 'mi1-a')
  `, [ids.actor, ids.memberA]);

  // Remove the MFA confounder before proving that an otherwise authorized
  // foreign admin cannot use or select another tenant's chapter.
  await client.query(
    "update public.org_security_policy set require_staff_mfa = false where organization_id = $1",
    [ids.orgB],
  );
  await asRole("authenticated", ids.actor, "aal2");
  result = await client.query("select private.member_has_chapter_role('mi1-b', array['admin']) allowed");
  assert(!result.rows[0].allowed, "foreign chapter admin crossed the selected tenant without an MFA confounder");
  await expectSqlState(
    "foreign_chapter_switch",
    "select public.switch_my_chapter('mi1-b')",
    [],
    "42501",
  );
  await asRole("postgres");
  result = await client.query("select chapter_id from public.member_profiles where id = $1", [ids.actor]);
  assert(result.rows[0].chapter_id === "mi1-a", "foreign chapter denial changed the selected chapter");
  await client.query(
    "update public.org_security_policy set require_staff_mfa = true where organization_id = $1",
    [ids.orgB],
  );

  await asRole("authenticated", ids.actor, "aal1");
  result = await client.query("select private.current_member_organization() org, public.member_has_role(array['steward']) allowed");
  assert(result.rows[0].org === ids.orgA && result.rows[0].allowed, "Org A chapter steward positive control failed");
  result = await client.query("select private.member_has_chapter_role('mi1-b', array['steward']) allowed");
  assert(!result.rows[0].allowed, "selected Org A role authorized an Org B chapter");
  await asRole("postgres");
  await client.query("update public.organizations set status = 'suspended' where id = $1", [ids.orgA]);
  await asRole("authenticated", ids.actor, "aal1");
  result = await client.query("select private.current_member_organization() org, public.member_has_role(array['steward']) allowed");
  assert(result.rows[0].org === null && !result.rows[0].allowed, "suspended organization retained staff authority");
  await asRole("postgres");
  await client.query("update public.organizations set status = 'active' where id = $1", [ids.orgA]);
  await asRole("authenticated", ids.actor, "aal1");
  result = await client.query("select public.staff_can_see_user($1, 'steward') same_org, public.staff_can_see_user($2, 'steward') foreign_org", [ids.memberA, ids.memberB]);
  assert(result.rows[0].same_org && !result.rows[0].foreign_org, "staff visibility crossed the selected tenant");
  await client.query("select public.publish_member_broadcast('Chapter proof', 'Allowed', 'en', 'chapter')");
  await expectSqlState(
    "chapter_steward_org_broadcast",
    "select public.publish_member_broadcast('Org proof denied', 'Denied', 'en', 'organization')",
    [],
    "42501",
  );

  await asRole("postgres");
  await client.query(
    "insert into public.chapter_workstreams (chapter_id, name, created_by) values ('mi1-a', 'General', $1)",
    [ids.actor],
  );
  await client.query(`
    insert into public.member_surveys
      (id, title, closes_at, active, order_index, campaign_state, chapter_id, created_by)
    values
      ('mi1-survey-foreign', 'Foreign survey', now() + interval '1 day', true, 509101, 'open', 'mi1-b', $1),
      ('mi1-survey-global', 'Global survey', now() + interval '1 day', true, 509102, 'open', null, $1)
  `, [ids.actor]);
  result = await client.query("select count(*)::int count from public.chapter_tasks where chapter_id = 'mi1-a'");
  const taskCountBeforeSurveyDenials = result.rows[0].count;
  await asRole("authenticated", ids.actor, "aal2");
  await expectSqlState(
    "foreign_survey_task",
    "select public.create_chapter_task_from_source('survey', 'mi1-survey-foreign')",
    [],
    "22023",
  );
  await expectSqlState(
    "global_survey_task",
    "select public.create_chapter_task_from_source('survey', 'mi1-survey-global')",
    [],
    "22023",
  );
  await asRole("postgres");
  result = await client.query("select count(*)::int count from public.chapter_tasks where chapter_id = 'mi1-a'");
  assert(
    result.rows[0].count === taskCountBeforeSurveyDenials,
    "foreign/global survey denial created a chapter task side effect",
  );
  result = await client.query(
    "select count(*)::int count from public.chapter_task_attachments where source_id in ('mi1-survey-foreign', 'mi1-survey-global')",
  );
  assert(result.rows[0].count === 0, "foreign/global survey denial created an attachment side effect");

  await asRole("postgres");
  await client.query(
    "insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, 'admin', $2)",
    [ids.orgA, ids.actor],
  );
  await asRole("authenticated", ids.memberA, "aal1");
  await expectSqlState(
    "chapter_admin_remove_last_org_admin",
    "select public.revoke_member_chapter_membership($1, 'mi1-a')",
    [ids.actor],
    "22023",
  );
  await asRole("postgres");
  result = await client.query(
    "select status from public.member_chapter_memberships where user_id = $1 and chapter_id = 'mi1-a'",
    [ids.actor],
  );
  assert(result.rows[0].status === "active", "last-admin denial changed chapter membership");
  await client.query(
    "insert into public.member_admin_audit (actor, action, detail) values ($1, 'grant_role', $2::jsonb)",
    [ids.actor, JSON.stringify({ marker: "org-a" })],
  );
  await asRole("authenticated", ids.actor, "aal1");
  await client.query("select public.set_member_organization_role($1, 'steward', true)", [ids.actor]);
  const published = await client.query("select public.publish_member_broadcast('Org proof', 'Allowed', 'en', 'organization') value");
  const broadcastId = published.rows[0].value.broadcastId;
  result = await client.query("select public.get_admin_audit(20) value");
  assert(
    result.rows[0].value.length === 1
      && result.rows[0].value[0].detail.marker === "org-a",
    "Org A admin audit positive control failed",
  );
  result = await client.query("select pg_catalog.jsonb_agg(detail order by created_at) value from public.member_admin_audit");
  assert(
    result.rows[0].value.length === 1
      && result.rows[0].value[0].marker === "org-a",
    "Org A direct audit RLS scope failed",
  );

  await asRole("postgres");
  await client.query("update public.member_profiles set chapter_id = 'mi1-b' where id = $1", [ids.actor]);
  await asRole("authenticated", ids.actor, "aal1");
  result = await client.query("select private.current_member_organization() org, public.member_has_role(array['steward']) allowed, private.can_read_member_broadcast($1) can_read", [broadcastId]);
  assert(result.rows[0].org === ids.orgB && !result.rows[0].allowed && !result.rows[0].can_read, "Org B selection inherited Org A authorization");

  await asRole("postgres");
  await client.query("insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, 'admin', $2)", [ids.orgB, ids.actor]);
  await client.query(
    "insert into public.member_admin_audit (actor, action, detail) values ($1, 'grant_role', $2::jsonb)",
    [ids.actor, JSON.stringify({ marker: "org-b" })],
  );
  await asRole("authenticated", ids.actor, "aal2");
  result = await client.query(
    "select private.member_has_chapter_role('mi1-b', array['admin']) allowed",
  );
  assert(!result.rows[0].allowed, "Org B MFA policy admitted chapter staff without an enrolled factor");
  await asRole("postgres");
  await client.query(`insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    values ('50910000-0000-4000-8000-000000000099', $1, 'MI1 proof', 'totp', 'verified', now(), now())`, [ids.actor]);
  await asRole("authenticated", ids.actor, "aal2");
  result = await client.query(
    "select private.member_has_chapter_role('mi1-b', array['admin']) allowed",
  );
  assert(result.rows[0].allowed, "Org B enrolled admin positive control failed");
  result = await client.query("select public.get_admin_audit(20) value");
  assert(
    result.rows[0].value.length === 1
      && result.rows[0].value[0].detail.marker === "org-b",
    "Org B admin audit exposed another tenant",
  );
  result = await client.query("select pg_catalog.jsonb_agg(detail order by created_at) value from public.member_admin_audit");
  assert(
    result.rows[0].value.length === 1
      && result.rows[0].value[0].marker === "org-b",
    "Org B direct audit RLS exposed another tenant",
  );
  // Staff two-step can no longer be turned off by an admin (by design since
  // 20261030201100_two_step_and_session_controls), so the tenant targeting of
  // the policy write is proved with the write that is allowed: Org A carries
  // the opposite sentinel, Org B's admin turns two-step on, and only Org B's
  // row changes. The refused disable changes neither row.
  const policies = async () => {
    const rows = (await client.query("select organization_id, require_staff_mfa from public.org_security_policy where organization_id in ($1, $2)", [ids.orgA, ids.orgB])).rows;
    const byOrg = new Map(rows.map((row) => [row.organization_id, row.require_staff_mfa]));
    return { orgA: byOrg.get(ids.orgA), orgB: byOrg.get(ids.orgB) };
  };
  await asRole("postgres");
  await client.query("update public.org_security_policy set require_staff_mfa = false where organization_id in ($1, $2)", [ids.orgA, ids.orgB]);
  await asRole("authenticated", ids.actor, "aal2");
  await expectSqlState("staff_two_step_disable_refused", "select public.set_staff_mfa_policy(false)", [], "22023");
  await asRole("postgres");
  let policy = await policies();
  assert(policy.orgA === false && policy.orgB === false, "the refused staff two-step disable changed a policy row");
  await asRole("authenticated", ids.actor, "aal2");
  await client.query("select public.set_staff_mfa_policy(true)");
  await asRole("postgres");
  policy = await policies();
  assert(policy.orgA === false && policy.orgB === true, "tenant policy write changed the wrong row");
  await client.query(
    "update public.org_security_policy set require_staff_mfa = true where organization_id = $1",
    [ids.orgA],
  );
  policy = await policies();
  assert(policy.orgA === true && policy.orgB === true, "restoring the Org A sentinel changed Org B's policy");

  await client.query("update public.organization_memberships set status = 'revoked', revoked_at = now() where organization_id = $1 and user_id = $2", [ids.orgB, ids.actor]);
  await asRole("authenticated", ids.actor, "aal2");
  result = await client.query("select private.current_member_organization() org, private.can_read_member_broadcast($1) can_read", [broadcastId]);
  assert(result.rows[0].org === null && !result.rows[0].can_read, "organization revocation did not fail closed on the next statement");
  await expectSqlState("null_scope_admin_audit", "select public.get_admin_audit(20)", [], "42501");
  result = await client.query("select count(*)::int count from public.member_admin_audit");
  assert(result.rows[0].count === 0, "direct admin-audit RLS exposed rows under NULL tenant scope");
  await asRole("postgres");
  result = await client.query("select status from public.member_chapter_memberships where user_id = $1 and chapter_id = 'mi1-b'", [ids.actor]);
  assert(result.rows[0].status === "active", "proof unexpectedly cascaded chapter membership state");

  await client.query("rollback");
  await runConcurrentGuards(client);
  await runMi1XdbSecurityExtensions(url, client);
  process.stdout.write("MI1 organization-scope live verification passed; transactional scenarios rolled back and concurrency fixtures removed.\n");
} catch (error) {
  try { await client.query("rollback"); } catch { /* connection/transaction may not exist */ }
  fail(`MI1 exclusive live verification failed: ${error.message}`);
} finally {
  await client.end().catch(() => {});
}
