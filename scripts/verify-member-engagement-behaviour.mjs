#!/usr/bin/env node
// Repeatable contract and optional transaction-only behavior proof for the
// member-engagement completion migration. Live mode is loopback-only and
// refuses the shared Supabase ports unless reached through an explicit,
// session-owned disposable endpoint. Every fixture is rolled back.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import pg from "pg";
import { forbiddenProjectRefIn } from "./lib/assert-exact-target.mjs";
import { requireRlsTables } from "./lib/db-contract-tables.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const migration = readFileSync(join(ROOT, "supabase/migrations/20260828034122_member_engagement_completion.sql"), "utf8");
const emptyTenantMigration = readFileSync(join(ROOT, "supabase/migrations/20260829020000_member_engagement_empty_tenant_boundary.sql"), "utf8");
const contract = JSON.parse(readFileSync(join(HERE, "db-contract.json"), "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const needle of [
  "create table public.organization_survey_tasks",
  "create table public.organization_live_poll_votes",
  "create table public.engagement_delivery_outbox",
  "create table public.compass_message_briefings",
  "create function public.get_member_engagement_snapshot",
  "create function public.get_staff_engagement_snapshot",
  "create function public.decide_compass_workspace_action",
  "create policy mfa_assurance",
  "results_visibility = 'after_close' and state = 'closed'",
  "revoke all on function public.get_message_briefing_context",
]) assert(migration.includes(needle), `missing migration contract: ${needle}`);

assert(!/\binsert into public\.organizations\b/i.test(migration), "migration must not create an organization");
assert(!/\binsert into\b/i.test(emptyTenantMigration), "empty-tenant boundary must not invent data");
for (const needle of [
  "private.current_member_organization()",
  "return null;",
  "'status', 'unavailable'",
  "'surveys', '[]'::jsonb",
  "private.is_organization_member(org)",
]) assert(emptyTenantMigration.includes(needle), `missing empty-tenant contract: ${needle}`);
assert(contract.policyCoverage.everyPublicTableHasRls, "db contract must require RLS on every public table");
requireRlsTables(contract, ["organization_survey_tasks", "organization_live_poll_votes", "engagement_delivery_outbox", "compass_message_briefings"]);
assert(contract.publication.tables.some((entry) => entry.table === "organization_live_polls"), "aggregate live-poll publication is not contracted");

const live = process.argv.includes("--live") || Boolean(process.env.ENGAGEMENT_EXCLUSIVE_DB_URL);
if (!live) {
  process.stdout.write("Member engagement static verification passed. Transaction-only live proof skipped.\n");
  process.exit(0);
}

if (process.env.ENGAGEMENT_EXCLUSIVE_DB_CONFIRM !== "member-engagement-disposable") {
  throw new Error("Refusing live mode without ENGAGEMENT_EXCLUSIVE_DB_CONFIRM=member-engagement-disposable");
}
const url = process.env.ENGAGEMENT_EXCLUSIVE_DB_URL;
assert(url, "ENGAGEMENT_EXCLUSIVE_DB_URL is required for live proof");
const parsed = new URL(url);
assert(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname), "live proof is loopback-only");
assert(!["54322", "54422"].includes(parsed.port), `refusing shared local Supabase port ${parsed.port}`);
const targetText = `${url}|${parsed.hostname}|${decodeURIComponent(parsed.username || "")}`;
for (const forbidden of [contract.target.projectRef, forbiddenProjectRefIn(contract.target, targetText)].filter(Boolean)) {
  assert(!targetText.includes(forbidden), `refusing forbidden project ${forbidden}`);
}

const ids = {
  organization: "50930000-0000-4000-8000-000000000001",
  foreignOrganization: "50930000-0000-4000-8000-000000000002",
  admin: "50930000-0000-4000-8000-000000000011",
  emptyMember: "50930000-0000-4000-8000-000000000012",
  member: "50930000-0000-4000-8000-000000000021",
  foreignMember: "50930000-0000-4000-8000-000000000022",
  survey: "50930000-0000-4000-8000-000000000031",
  foreignSurvey: "50930000-0000-4000-8000-000000000032",
  question: "50930000-0000-4000-8000-000000000041",
  delayedPoll: "50930000-0000-4000-8000-000000000051",
  delayedOption: "50930000-0000-4000-8000-000000000052",
  livePoll: "50930000-0000-4000-8000-000000000053",
  liveOption: "50930000-0000-4000-8000-000000000054",
  lease: "50930000-0000-4000-8000-000000000061",
};
const quarter = `${new Date().getUTCFullYear()}-Q${Math.floor(new Date().getUTCMonth() / 3) + 1}`;
const client = new pg.Client({ connectionString: url });

async function asAuthenticated(userId) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2" })]);
  await client.query("set local role authenticated");
}

async function expectState(label, statement, values, state) {
  const savepoint = `engagement_${label.replace(/[^a-z0-9]/gi, "_")}`;
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
  await client.query(`
    insert into auth.users (id, email) values
      ($1, 'engagement-admin@example.invalid'),
      ($2, 'engagement-empty@example.invalid'),
      ($3, 'engagement-member@example.invalid'),
      ($4, 'engagement-foreign@example.invalid')
  `, [ids.admin, ids.emptyMember, ids.member, ids.foreignMember]);

  await asAuthenticated(ids.emptyMember);
  const emptySnapshot = (await client.query("select public.get_member_engagement_snapshot() snapshot")).rows[0].snapshot;
  assert(emptySnapshot.quarterlyGate.required === false && emptySnapshot.quarterlyGate.unlocked === true, "empty account received a false quarterly gate");
  for (const key of ["surveys", "pulsePrompts", "livePolls", "actions", "briefings"]) {
    assert(Array.isArray(emptySnapshot[key]) && emptySnapshot[key].length === 0, `empty account received non-empty ${key}`);
  }
  const emptyPulse = (await client.query("select public.evaluate_contextual_pulse('signed-in', 'empty-account') result")).rows[0].result;
  assert(emptyPulse === null, "empty account received a contextual pulse");
  const emptyPresence = (await client.query("select public.heartbeat_member_presence('online') result")).rows[0].result;
  assert(emptyPresence.status === "unavailable" && emptyPresence.lastSeenAt === null, "empty account received fictional presence state");
  await client.query("reset role");
  const emptyWrites = (await client.query(`
    select
      (select count(*)::integer from public.member_presence where user_id = $1) presence_count,
      (select count(*)::integer from public.organization_pulse_events where user_id = $1) pulse_count
  `, [ids.emptyMember])).rows[0];
  assert(emptyWrites.presence_count === 0 && emptyWrites.pulse_count === 0, "empty-account RPCs persisted fictional engagement state");

  await client.query(`
    insert into public.organizations (id, slug, name, created_by) values
      ($1, 'engagement-proof-a', 'Engagement Proof A', $3),
      ($2, 'engagement-proof-b', 'Engagement Proof B', $3)
  `, [ids.organization, ids.foreignOrganization, ids.admin]);
  await client.query(`
    insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values
      ('engagement-proof-a', 'Engagement Proof A', 'engagement-proof-a', true, 1, $1),
      ('engagement-proof-b', 'Engagement Proof B', 'engagement-proof-b', true, 1, $2)
  `, [ids.organization, ids.foreignOrganization]);
  await client.query(`
    insert into public.chapter_workstreams (chapter_id, name, created_by)
    values ('engagement-proof-a', 'General', $1)
  `, [ids.admin]);
  await client.query(`
    insert into public.organization_memberships (organization_id, user_id, status) values
      ($1, $2, 'active'), ($1, $3, 'active'), ($4, $5, 'active')
  `, [ids.organization, ids.admin, ids.member, ids.foreignOrganization, ids.foreignMember]);
  await client.query(`
    insert into public.member_chapter_memberships (user_id, chapter_id, status) values
      ($1, 'engagement-proof-a', 'active'),
      ($2, 'engagement-proof-a', 'active'),
      ($3, 'engagement-proof-b', 'active')
  `, [ids.admin, ids.member, ids.foreignMember]);
  await client.query(`
    update public.member_profiles
    set chapter_id = case when id = $2 then 'engagement-proof-b' else 'engagement-proof-a' end
    where id = any($1::uuid[])
  `, [[ids.admin, ids.member, ids.foreignMember], ids.foreignMember]);
  await client.query(`
    insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
    values ($1, $2, 'admin', $2)
  `, [ids.organization, ids.admin]);
  await client.query(`
    insert into public.org_security_policy (id, organization_id, require_staff_mfa)
    values (true, $1, false)
  `, [ids.organization]);
  await client.query(`
    insert into public.member_roles (user_id, role, chapter_id, granted_by)
    values ($1, 'admin', 'engagement-proof-a', $1)
  `, [ids.admin]);
  await client.query(`
    insert into public.member_role_chapters (user_id, role, chapter_id, granted_by)
    values ($1, 'admin', 'engagement-proof-a', $1)
  `, [ids.admin]);
  await client.query(`
    insert into public.organization_surveys
      (id, organization_id, title, status, cadence, period_key, owner_user_id, created_by, operations_state)
    values
      ($1, $3, 'Quarterly experience', 'open', 'quarterly', $5, $4, $4, 'ready'),
      ($2, $6, 'Foreign survey', 'open', 'one_off', null, $7, $7, 'ready')
  `, [ids.survey, ids.foreignSurvey, ids.organization, ids.admin, quarter, ids.foreignOrganization, ids.foreignMember]);
  await client.query(`
    insert into public.organization_survey_questions
      (id, organization_id, survey_id, sort_index, question_type, label, required)
    values ($1, $2, $3, 0, 'text', 'What should improve?', true)
  `, [ids.question, ids.organization, ids.survey]);
  await client.query(`
    insert into public.organization_live_polls
      (id, organization_id, chapter_id, title, state, results_visibility, result_cache, vote_count, created_by)
    values
      ($1, $3, 'engagement-proof-a', 'Delayed results', 'open', 'after_close', '[{"label":"Hidden","votes":9}]', 9, $4),
      ($2, $3, 'engagement-proof-a', 'Live results', 'open', 'live', '[{"label":"Visible","votes":2}]', 2, $4)
  `, [ids.delayedPoll, ids.livePoll, ids.organization, ids.admin]);
  await client.query(`
    insert into public.organization_live_poll_options (id, organization_id, poll_id, label, sort_index) values
      ($1, $3, $4, 'Delayed option', 0),
      ($2, $3, $5, 'Live option', 0)
  `, [ids.delayedOption, ids.liveOption, ids.organization, ids.delayedPoll, ids.livePoll]);
  await client.query(`
    insert into public.member_broadcasts
      (id, sender, title, body, published_at, order_index, created_by, locale, organization_id, chapter_id, audience_scope)
    values ('engagement-proof-broadcast', 'Chapter office', 'Meeting update', 'The agenda is available.', now(), 509300, $1, 'en', $2, 'engagement-proof-a', 'organization')
  `, [ids.admin, ids.organization]);

  await asAuthenticated(ids.member);
  const memberSnapshot = (await client.query("select public.get_member_engagement_snapshot() snapshot")).rows[0].snapshot;
  assert(memberSnapshot.surveys.length === 1 && memberSnapshot.surveys[0].id === ids.survey, "member snapshot crossed organization scope");
  assert(memberSnapshot.quarterlyGate.required && !memberSnapshot.quarterlyGate.unlocked, "quarterly completion gate did not lock before submission");
  const delayed = memberSnapshot.livePolls.find((poll) => poll.id === ids.delayedPoll);
  assert(Array.isArray(delayed.results) && delayed.results.length === 0, "delayed poll results leaked through the member snapshot");
  const directPolls = await client.query("select id from public.organization_live_polls order by id");
  assert(directPolls.rows.length === 1 && directPolls.rows[0].id === ids.livePoll, "Realtime base-row RLS exposed delayed or foreign results");
  await expectState("per_voter_read", "select * from public.organization_live_poll_votes", [], "42501");
  await expectState("member_action_proposal", "select public.propose_compass_workspace_action('broadcast', 'engagement-proof-broadcast', 'Follow up')", [], "42501");
  const submitted = (await client.query(
    "select public.submit_organization_survey_session($1, jsonb_build_object($2::text, to_jsonb($3::text))) result",
    [ids.survey, ids.question, "More notice"],
  )).rows[0].result;
  assert(submitted.status === "submitted", "survey submission did not complete");
  const gate = (await client.query("select public.get_quarterly_survey_gate() gate")).rows[0].gate;
  assert(gate.completed && gate.unlocked, "quarterly completion gate did not unlock after submission");
  await client.query("select public.cast_organization_live_poll_vote($1, $2)", [ids.delayedPoll, ids.delayedOption]);
  await client.query("reset role");
  const pollState = (await client.query("select vote_count, result_cache from public.organization_live_polls where id = $1", [ids.delayedPoll])).rows[0];
  assert(pollState.vote_count === 1 && pollState.result_cache.length === 0, "delayed tally cache became visible while the poll was open");

  await asAuthenticated(ids.admin);
  const staffSnapshot = (await client.query("select public.get_staff_engagement_snapshot() snapshot")).rows[0].snapshot;
  assert(staffSnapshot.surveys.length === 1 && staffSnapshot.surveys[0].id === ids.survey, "staff snapshot crossed organization scope");
  const proposed = (await client.query(
    "select public.propose_compass_workspace_action('broadcast', 'engagement-proof-broadcast', 'Follow up on the meeting') result",
  )).rows[0].result;
  const confirmed = (await client.query("select public.decide_compass_workspace_action($1, 'confirm') result", [proposed.id])).rows[0].result;
  assert(confirmed.state === "confirmed" && confirmed.taskId, "approved Compass action did not create an authorized linked task");

  await client.query("reset role");
  const queued = Number((await client.query("select count(*) count from public.engagement_delivery_outbox where source_id = 'engagement-proof-broadcast'")).rows[0].count);
  assert(queued === 2, `broadcast outbox expected 2 recipient rows, got ${queued}`);
  await client.query("set local role service_role");
  const claims = (await client.query("select public.claim_engagement_delivery_batch($1, 10, 120) claims", [ids.lease])).rows[0].claims;
  const claim = claims.find((item) => item.sourceId === "engagement-proof-broadcast");
  assert(claim, "service worker did not lease the broadcast delivery");
  const payload = (await client.query("select public.get_engagement_delivery_payload($1, $2) payload", [claim.id, ids.lease])).rows[0].payload;
  assert(payload.available && payload.subject === "Meeting update" && payload.body === "The agenda is available.", "just-in-time delivery payload was incomplete");
  const completed = (await client.query("select public.complete_engagement_delivery($1, $2, true, null, 300) result", [claim.id, ids.lease])).rows[0].result;
  assert(completed.state === "sent", "delivery completion did not persist its terminal state");

  await client.query("reset role");
  await client.query("rollback");
  process.stdout.write("Member engagement transaction-only behavior proof passed and rolled back.\n");
} catch (error) {
  try { await client.query("reset role"); await client.query("rollback"); } catch { /* best effort */ }
  throw error;
} finally {
  await client.end().catch(() => {});
}
