import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";

const { Client } = pg;
const databaseUrl = assertDisposableProofUrl(requireDatabaseUrl("SUPABASE_DB_URL", { aliases: ["DATABASE_URL"] }));

const ids = {
  actor: "50900000-0000-4000-8000-000000000091",
  controller: "50900000-0000-4000-8000-000000000092",
  reviewer: "50900000-0000-4000-8000-000000000093",
};
const userIds = Object.values(ids);
const titlePrefix = "Template concurrency proof";
const clients = {
  admin: new Client({ connectionString: databaseUrl, application_name: "template-concurrency-admin" }),
  actor: new Client({ connectionString: databaseUrl, application_name: "template-concurrency-actor" }),
  blocker: new Client({ connectionString: databaseUrl, application_name: "template-concurrency-blocker" }),
};

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function beginAs(client, userId) {
  await client.query("begin");
  await client.query("set local statement_timeout = '5s'");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
    sub: userId,
    role: "authenticated",
    aal: "aal2",
  })]);
  await client.query("set local role authenticated");
}

async function callAs(client, userId, sql, values) {
  await beginAs(client, userId);
  try {
    const result = await client.query(sql, values);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

function observe(promise) {
  let settled = false;
  const outcome = promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  ).finally(() => { settled = true; });
  return { outcome, settled: () => settled };
}

async function waitForRowLock(label, operation) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const row = (await clients.admin.query(
      "select wait_event_type from pg_catalog.pg_stat_activity where pid = $1",
      [clients.actor.processID],
    )).rows[0];
    if (row?.wait_event_type === "Lock") return;
    if (operation.settled()) throw new Error(`${label}: mutation completed before the authorization lock`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label}: mutation never waited on the authorization row lock`);
}

async function releaseBlockerAndObserve(label, operation) {
  try {
    await waitForRowLock(label, operation);
  } catch (error) {
    await clients.blocker.query("commit").catch(() => {});
    await operation.outcome;
    throw error;
  }
  await clients.blocker.query("commit");
  return operation.outcome;
}

async function cleanup() {
  await clients.admin.query("begin");
  try {
    await clients.admin.query("delete from public.chapter_tasks where title like $1", [`${titlePrefix}%`]);
    await clients.admin.query("delete from public.member_admin_audit where actor = any($1::uuid[]) or target_user = any($1::uuid[])", [userIds]);
    await clients.admin.query("delete from public.member_notifications where user_id = any($1::uuid[])", [userIds]);
    await clients.admin.query("delete from auth.mfa_factors where user_id = any($1::uuid[])", [userIds]);
    await clients.admin.query("delete from public.member_roles where user_id = any($1::uuid[])", [userIds]);
    await clients.admin.query("delete from auth.users where id = any($1::uuid[])", [userIds]);
    await clients.admin.query("commit");
  } catch (error) {
    await clients.admin.query("rollback").catch(() => {});
    throw error;
  }
}

async function restoreRole(userId, role, chapterId) {
  await clients.admin.query(
    "insert into public.member_roles (user_id, role, chapter_id) values ($1, $2, $3) on conflict (user_id, role) do update set chapter_id = excluded.chapter_id",
    [userId, role, chapterId],
  );
}

async function beginRevoke(userId, role) {
  await beginAs(clients.blocker, ids.controller);
  // The legacy role command was retired. Keep the direct competing delete so
  // this proof continues to exercise the writer's role-row reauthorization.
  await clients.blocker.query("reset role");
  await clients.blocker.query("delete from public.member_roles where user_id = $1 and role = $2", [userId, role]);
}

function expectDenied(outcome, state, label) {
  assert(!outcome.ok, `${label}: mutation succeeded after authorization was revoked`);
  assert(outcome.error?.code === state, `${label}: expected SQLSTATE ${state}, got ${outcome.error?.code || outcome.error?.message}`);
}

try {
  await Promise.all(Object.values(clients).map((client) => client.connect()));
  await cleanup();

  await clients.admin.query("begin");
  for (const [index, userId] of userIds.entries()) {
    await clients.admin.query("insert into auth.users (id, email) values ($1, $2)", [userId, `template-concurrency-${index}@example.invalid`]);
  }
  await clients.admin.query("update public.member_profiles set chapter_id = 'wor', full_name = 'Template concurrency proof' where id = any($1::uuid[])", [[ids.actor, ids.reviewer]]);
  await clients.admin.query("update public.member_profiles set chapter_id = 'bos', full_name = 'Template concurrency controller' where id = $1", [ids.controller]);
  await clients.admin.query(`
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    values
      ('50900000-0000-4000-8000-000000000094', $1, 'Template concurrency actor', 'totp', 'verified', now(), now()),
      ('50900000-0000-4000-8000-000000000095', $2, 'Template concurrency controller', 'totp', 'verified', now(), now())
  `, [ids.actor, ids.controller]);
  await clients.admin.query(`
    insert into public.member_roles (user_id, role, chapter_id)
    values ($1, 'admin', 'wor'), ($2, 'admin', 'bos'), ($3, 'steward', 'wor')
  `, [ids.actor, ids.controller, ids.reviewer]);
  await clients.admin.query("commit");

  const createSql = "select public.create_chapter_task_from_template($1, $2, $3, $4::jsonb) as value";
  const updateSql = "select public.update_chapter_task_template_details($1, '{}'::jsonb, $2, false) as value";
  const baseline = (await callAs(clients.actor, ids.actor, createSql, [
    "member_follow_up",
    `${titlePrefix} update baseline`,
    "General",
    JSON.stringify({ contact_method: "phone", follow_up_on: "2026-08-21" }),
  ])).rows[0].value;

  await beginRevoke(ids.actor, "admin");
  let operation = observe(callAs(clients.actor, ids.actor, createSql, [
    "member_follow_up",
    `${titlePrefix} caller_create_revoke_wins`,
    "General",
    JSON.stringify({ contact_method: "phone", follow_up_on: "2026-08-22" }),
  ]));
  let outcome = await releaseBlockerAndObserve("caller_create_revoke_wins", operation);
  expectDenied(outcome, "42501", "caller_create_revoke_wins");
  assert(Number((await clients.admin.query("select count(*) n from public.chapter_tasks where title = $1", [`${titlePrefix} caller_create_revoke_wins`])).rows[0].n) === 0,
    "caller_create_revoke_wins: unauthorized task survived");
  await restoreRole(ids.actor, "admin", "wor");

  const beforeUpdate = (await clients.admin.query(
    "select d.flow_step, (select count(*) from public.chapter_task_activity a where a.task_id = d.task_id and a.action = 'template_flow_changed') activity from public.chapter_task_template_details d where d.task_id = $1",
    [baseline.task.id],
  )).rows[0];
  await beginRevoke(ids.actor, "admin");
  operation = observe(callAs(clients.actor, ids.actor, updateSql, [baseline.task.id, "contact"]));
  outcome = await releaseBlockerAndObserve("caller_update_revoke_wins", operation);
  expectDenied(outcome, "42501", "caller_update_revoke_wins");
  const afterUpdate = (await clients.admin.query(
    "select d.flow_step, (select count(*) from public.chapter_task_activity a where a.task_id = d.task_id and a.action = 'template_flow_changed') activity from public.chapter_task_template_details d where d.task_id = $1",
    [baseline.task.id],
  )).rows[0];
  assert(afterUpdate.flow_step === beforeUpdate.flow_step && afterUpdate.activity === beforeUpdate.activity,
    "caller_update_revoke_wins: unauthorized detail/activity mutation survived");
  await restoreRole(ids.actor, "admin", "wor");

  await beginRevoke(ids.reviewer, "steward");
  operation = observe(callAs(clients.actor, ids.actor, createSql, [
    "review_approval",
    `${titlePrefix} reviewer_role_revoke_wins`,
    "General",
    JSON.stringify({ review_kind: "document", reviewer_id: ids.reviewer }),
  ]));
  outcome = await releaseBlockerAndObserve("reviewer_role_revoke_wins", operation);
  expectDenied(outcome, "22023", "reviewer_role_revoke_wins");
  await restoreRole(ids.reviewer, "steward", "wor");

  await clients.blocker.query("begin");
  await clients.blocker.query("update public.member_profiles set chapter_id = 'bos' where id = $1", [ids.reviewer]);
  operation = observe(callAs(clients.actor, ids.actor, createSql, [
    "review_approval",
    `${titlePrefix} reviewer_profile_move_wins`,
    "General",
    JSON.stringify({ review_kind: "document", reviewer_id: ids.reviewer }),
  ]));
  outcome = await releaseBlockerAndObserve("reviewer_profile_move_wins", operation);
  expectDenied(outcome, "22023", "reviewer_profile_move_wins");
  assert(Number((await clients.admin.query("select count(*) n from public.chapter_tasks where title in ($1, $2)", [
    `${titlePrefix} reviewer_role_revoke_wins`, `${titlePrefix} reviewer_profile_move_wins`,
  ])).rows[0].n) === 0, "reviewer races left unauthorized tasks");

  await cleanup();
  const residue = (await clients.admin.query(`
    select
      (select count(*) from public.chapter_tasks where title like $1)
      + (select count(*) from auth.users where id = any($2::uuid[]))
      + (select count(*) from public.member_roles where user_id = any($2::uuid[])) as n
  `, [`${titlePrefix}%`, userIds])).rows[0].n;
  assert(Number(residue) === 0, "zero_concurrency_residue: concurrency proof left fixtures");
  console.log("PASS: caller and reviewer revoke/profile races serialize before specialized task create/update with zero concurrency residue.");
} catch (error) {
  await Promise.all(Object.values(clients).map((client) => client.query("rollback").catch(() => {})));
  await cleanup().catch(() => {});
  throw error;
} finally {
  await Promise.all(Object.values(clients).map((client) => client.end().catch(() => {})));
}
