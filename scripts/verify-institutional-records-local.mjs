#!/usr/bin/env node
// Transaction-only local proof for CR-012/077/078/087/112. Every fictional
// organization, identity, record, contact, notification, and export receipt is
// rolled back. The script refuses non-loopback database targets.

import { readFileSync } from "node:fs";
import process from "node:process";
import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";
import { siblingIdentityIn } from "./lib/sibling-deny-list.mjs";

const migration = readFileSync("supabase/migrations/20260830060000_institutional_records_completion.sql", "utf8");
const url = requireDatabaseUrl("INSTITUTIONAL_RECORDS_DB_URL");

function assert(condition, message) { if (!condition) throw new Error(message); }
assertDisposableProofUrl(url);
for (const forbidden of ["supabase.co", ...siblingIdentityIn(url)]) assert(!url.includes(forbidden), `Refusing target containing ${forbidden}`);
for (const required of [
  "create function public.promote_weekly_question",
  "create function public.get_institutional_records_workspace",
  "create function public.save_institutional_record",
  "create function public.save_chapter_contact_log",
  "create function public.request_filtered_organization_export",
  "drop policy if exists chapter_records_staff_create on public.chapter_records",
  "drop policy if exists chapter_records_staff_write on public.chapter_records",
  "limit 10001",
]) assert(migration.includes(required), `Missing migration contract: ${required}`);
assert(!/insert into public\.(organizations|chapters|member_profiles)\b/i.test(migration), "Migration must not invent a tenant, chapter, or identity");

const ids = {
  org: "50977000-0000-4000-8000-000000000001",
  foreignOrg: "50977000-0000-4000-8000-000000000002",
  admin: "50977000-0000-4000-8000-000000000011",
  member: "50977000-0000-4000-8000-000000000012",
  noCredit: "50977000-0000-4000-8000-000000000013",
  foreignAdmin: "50977000-0000-4000-8000-000000000014",
  question: "50977000-0000-4000-8000-000000000021",
  noCreditQuestion: "50977000-0000-4000-8000-000000000022",
};
const client = new pg.Client({ connectionString: url });

async function asUser(userId) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2" })]);
  await client.query("set local role authenticated");
}

async function expectState(label, statement, values, state) {
  const point = `institutional_${label.replace(/[^a-z0-9]/gi, "_")}`;
  await client.query(`savepoint ${point}`);
  try { await client.query(statement, values); throw new Error(`${label}: expected SQLSTATE ${state}`); }
  catch (error) { assert(error.code === state, `${label}: expected ${state}, got ${error.code || error.message}`); }
  finally { await client.query(`rollback to savepoint ${point}`); await client.query(`release savepoint ${point}`); }
}

try {
  await client.connect();
  await client.query("begin");
  await client.query("select pg_catalog.pg_advisory_xact_lock(509, 77000)");
  await client.query(`
    insert into auth.users (id, email) values
      ($1, 'records-admin@example.invalid'), ($2, 'records-member@example.invalid'),
      ($3, 'records-no-credit@example.invalid'), ($4, 'records-foreign@example.invalid')
  `, [ids.admin, ids.member, ids.noCredit, ids.foreignAdmin]);
  await client.query(`
    insert into public.organizations (id, slug, name, created_by) values
      ($1, 'records-proof-a', 'Records Proof A', $3),
      ($2, 'records-proof-b', 'Records Proof B', $4)
  `, [ids.org, ids.foreignOrg, ids.admin, ids.foreignAdmin]);
  await client.query(`
    insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values
      ('records-proof-a', 'Records Proof A', 'records-proof-a', true, 1, $1),
      ('records-proof-b', 'Records Proof B', 'records-proof-b', true, 1, $2)
  `, [ids.org, ids.foreignOrg]);
  await client.query(`
    insert into public.organization_memberships (organization_id, user_id, status) values
      ($1, $3, 'active'), ($1, $4, 'active'), ($1, $5, 'active'), ($2, $6, 'active')
  `, [ids.org, ids.foreignOrg, ids.admin, ids.member, ids.noCredit, ids.foreignAdmin]);
  await client.query(`
    insert into public.member_chapter_memberships (user_id, chapter_id, status) values
      ($1, 'records-proof-a', 'active'), ($2, 'records-proof-a', 'active'),
      ($3, 'records-proof-a', 'active'), ($4, 'records-proof-b', 'active')
  `, [ids.admin, ids.member, ids.noCredit, ids.foreignAdmin]);
  await client.query(`
    update public.member_profiles set chapter_id = case when id = $2 then 'records-proof-b' else 'records-proof-a' end
    where id = any($1::uuid[])
  `, [[ids.admin, ids.member, ids.noCredit, ids.foreignAdmin], ids.foreignAdmin]);
  await client.query(`
    insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values
      ($1, $3, 'admin', $3), ($2, $4, 'admin', $4)
  `, [ids.org, ids.foreignOrg, ids.admin, ids.foreignAdmin]);
  await client.query(`
    insert into public.member_roles (user_id, role, chapter_id, granted_by) values
      ($1, 'admin', 'records-proof-a', $1), ($2, 'admin', 'records-proof-b', $2)
  `, [ids.admin, ids.foreignAdmin]);
  await client.query(`
    insert into public.member_role_chapters (user_id, role, chapter_id, granted_by) values
      ($1, 'admin', 'records-proof-a', $1), ($2, 'admin', 'records-proof-b', $2)
  `, [ids.admin, ids.foreignAdmin]);
  await client.query(`
    insert into public.org_security_policy (id, organization_id, require_staff_mfa) values
      (true, $1, false), (true, $2, false)
  `, [ids.org, ids.foreignOrg]);
  await client.query(`
    insert into public.member_reward_grants (organization_id, user_id, item_key, status, source)
    values ($1, $2, 'priority-wq-slot', 'granted', 'admin_grant'),
      ($1, $3, 'priority-wq-slot', 'claimed', 'member_claim')
  `, [ids.org, ids.member, ids.noCredit]);
  await client.query(`
    insert into public.member_weekly_questions (id, chapter_id, user_id, week_start, body, options) values
      ($1, 'records-proof-a', $3, pg_catalog.date_trunc('week', pg_catalog.now() at time zone 'UTC')::date, 'Which shift issue should be raised?', '["Schedules","Safety"]'),
      ($2, 'records-proof-a', $4, pg_catalog.date_trunc('week', pg_catalog.now() at time zone 'UTC')::date, 'Which training should be next?', '["Safety","Rights"]')
  `, [ids.question, ids.noCreditQuestion, ids.member, ids.noCredit]);

  await asUser(ids.member);
  let pool = (await client.query("select public.list_weekly_questions() result")).rows[0].result;
  assert(pool.find((q) => q.id === ids.question)?.promotionAvailable === true, "unused promotion was not surfaced to its owner");
  const promoted = (await client.query("select public.promote_weekly_question($1) result", [ids.question])).rows[0].result;
  assert(promoted.promoted === true, "promotion entitlement was not consumed");
  pool = (await client.query("select public.list_weekly_questions() result")).rows[0].result;
  assert(pool.find((q) => q.id === ids.question)?.priority === true && pool.find((q) => q.id === ids.question)?.promotionAvailable === false, "promoted ordering or spent state was not projected");
  const replay = (await client.query("select public.promote_weekly_question($1) result", [ids.question])).rows[0].result;
  assert(replay.alreadyPromoted === true, "promotion replay was not idempotent");

  await asUser(ids.noCredit);
  await expectState("no_promotion_credit", "select public.promote_weekly_question($1)", [ids.noCreditQuestion], "22023");
  await client.query("reset role");
  await client.query("delete from public.organization_memberships where organization_id = $1 and user_id = $2", [ids.org, ids.noCredit]);
  await asUser(ids.noCredit);
  const orphanPool = (await client.query("select public.list_weekly_questions() result")).rows[0].result;
  assert(orphanPool.find((q) => q.id === ids.noCreditQuestion)?.promotionAvailable === false, "null-organization member could not read the chapter pool safely");
  await client.query("reset role");
  await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [ids.org, ids.noCredit]);
  await asUser(ids.noCredit);
  await expectState("member_record_write", "select public.save_institutional_record(null,'minutes','Title','Body',now())", [], "42501");

  await asUser(ids.admin);
  const saved = (await client.query(`select public.save_institutional_record(
    null, 'minutes', 'August chapter meeting', 'Approved agenda and decisions.', now(),
    'chapter', 'publish', false, null, null,
    $1::jsonb
  ) result`, [JSON.stringify([{ userId: ids.member, status: "present" }, { userId: ids.noCredit, status: "excused" }])])).rows[0].result;
  assert(saved.version === 1 && saved.lifecycle_status === "published" && saved.delivered === 3, "minutes publication did not version and dispatch to the active chapter roster");
  await expectState("stale_version", `select public.save_institutional_record($1,'minutes','Changed','Body',now(),'chapter','save',false,null,2,'[]')`, [saved.id], "PT409");

  const staffMinutes = (await client.query(`select public.save_institutional_record(
    null, 'minutes', 'Staff planning notes', 'Confidential staff discussion.', now(),
    'staff', 'publish', false, null, null, '[]'
  ) result`)).rows[0].result;
  assert(staffMinutes.delivered === 0, "staff-only minutes triggered member dispatch");
  await client.query("reset role");
  const staffDispatches = Number((await client.query("select count(*) from public.meeting_minutes_dispatches where record_id = $1", [staffMinutes.id])).rows[0].count);
  assert(staffDispatches === 0, "staff-only minutes retained member dispatch evidence");
  await asUser(ids.admin);

  const milestone = (await client.query(`select public.save_institutional_record(
    null, 'milestone', 'First agreement', 'A durable institutional milestone.', now() - interval '200 days',
    'chapter', 'publish', true, 'Earlier organizing history has not been digitized.', null, '[]'
  ) result`)).rows[0].result;
  assert(milestone.pinned_at, "timeline pin was not persisted");
  const contact = (await client.query(`select public.save_chapter_contact_log(
    null,'member','phone','Scheduling follow-up','Discussed advance notice','Member requested a calendar reminder',
    now(), now() + interval '2 days', $1, null, null, false
  ) result`, [ids.member])).rows[0].result;
  assert(contact.organization_id === ids.org && contact.chapter_id === "records-proof-a", "contact scope was not server-owned");
  await expectState("foreign_contact_subject", `select public.save_chapter_contact_log(null,'member','phone','Foreign','Rejected','',now(),null,$1,null,null,false)`, [ids.foreignAdmin], "42501");

  const workspace = (await client.query("select public.get_institutional_records_workspace() result")).rows[0].result;
  assert(workspace.canManage && workspace.canExport && workspace.records.length === 3 && workspace.contacts.length === 1, "staff workspace omitted backed workflow state");
  const exported = (await client.query("select public.request_filtered_organization_export(array['members','minutes','timeline','contacts'],'json') result")).rows[0].result;
  assert(exported.rowCount >= 6 && exported.rows.every((row) => row.values.chapterId === "records-proof-a"), "export crossed scope or omitted selected domains");

  const temporaryMinutes = (await client.query(`select public.save_institutional_record(
    null, 'minutes', 'Attendance cleanup proof', 'Temporary minutes.', now(),
    'staff', 'save', false, null, null,
    $1::jsonb
  ) result`, [JSON.stringify([{ userId: ids.member, status: "present" }])])).rows[0].result;
  await client.query(`select public.save_institutional_record(
    $1, 'milestone', 'Attendance cleanup proof', 'Converted to a milestone.', now(),
    'staff', 'save', false, null, 1, '[]'
  )`, [temporaryMinutes.id]);
  await client.query("reset role");
  const attendanceAfterTypeChange = Number((await client.query("select count(*) from public.meeting_attendance where record_id = $1", [temporaryMinutes.id])).rows[0].count);
  assert(attendanceAfterTypeChange === 0, "minutes attendance survived a record-type change");

  await client.query("delete from public.organization_role_grants where organization_id = $1 and user_id = $2 and role = 'admin'", [ids.org, ids.admin]);
  await asUser(ids.admin);
  const chapterAdminWorkspace = (await client.query("select public.get_institutional_records_workspace() result")).rows[0].result;
  assert(chapterAdminWorkspace.canManage && !chapterAdminWorkspace.canExport && chapterAdminWorkspace.exportRuns.length === 0, "chapter-scoped admin received organization export capability");
  await expectState("chapter_admin_export", "select public.request_filtered_organization_export(array['members'],'csv')", [], "42501");

  await asUser(ids.member);
  const memberWorkspace = (await client.query("select public.get_institutional_records_workspace() result")).rows[0].result;
  assert(!memberWorkspace.canManage && !memberWorkspace.canExport && memberWorkspace.records.length === 2 && memberWorkspace.contacts.length === 0, "member projection exposed staff contact/export state");
  assert(memberWorkspace.records.every((record) => record.versions.length === 0 && record.attendance.length === 0 && record.dispatch.delivered === 0 && record.dispatch.failed === 0), "member projection exposed staff-only versions, attendance, or dispatch evidence");
  await expectState("member_export", "select public.request_filtered_organization_export(array['members'],'csv')", [], "42501");
  await expectState("direct_record_insert", "insert into public.chapter_records(record_type,title,body,occurred_at) values ('minutes','Bypass','Bypass',now())", [], "42501");
  await expectState("legacy_mutation", "select public.update_chapter_record_content($1,'minutes','Bypass','Bypass',now(),false)", [saved.id], "42501");

  await asUser(ids.foreignAdmin);
  await expectState("cross_org_record", `select public.save_institutional_record($1,'minutes','Foreign','Body',now(),'chapter','save',false,null,1,'[]')`, [saved.id], "P0002");
  const foreignWorkspace = (await client.query("select public.get_institutional_records_workspace() result")).rows[0].result;
  assert(foreignWorkspace.records.length === 0 && foreignWorkspace.contacts.length === 0, "foreign workspace crossed organization scope");

  await client.query("reset role");
  await client.query("rollback");
  process.stdout.write("Institutional records and promotion behavior proof passed; all fixtures rolled back.\n");
} catch (error) {
  try { await client.query("reset role"); await client.query("rollback"); } catch { /* best effort */ }
  throw error;
} finally {
  await client.end().catch(() => {});
}
