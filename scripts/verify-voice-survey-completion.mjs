#!/usr/bin/env node
// Transaction-only local proof for MI1 Voice CR-003/004/005/009/011.
// The migration and every fictional fixture are rolled back, including errors.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";
import { siblingIdentityIn } from "./lib/sibling-deny-list.mjs";

const migration = readFileSync(resolve("supabase/migrations/20260828220000_mi1_voice_survey_completion.sql"), "utf8");
const url = requireDatabaseUrl("VOICE_SURVEY_DB_URL");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assertDisposableProofUrl(url);
for (const forbidden of ["supabase.co", ...siblingIdentityIn(url)]) {
  assert(!url.includes(forbidden), `Refusing non-local target containing ${forbidden}`);
}

const ids = {
  organization: "50945000-0000-4000-8000-000000000001",
  foreignOrganization: "50945000-0000-4000-8000-000000000002",
  admin: "50945000-0000-4000-8000-000000000011",
  memberOne: "50945000-0000-4000-8000-000000000021",
  memberTwo: "50945000-0000-4000-8000-000000000022",
  memberThree: "50945000-0000-4000-8000-000000000023",
  foreignMember: "50945000-0000-4000-8000-000000000024",
};

const client = new pg.Client({ connectionString: url });

async function asUser(userId) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2" })]);
  await client.query("set local role authenticated");
}

async function expectState(label, statement, values, state) {
  const savepoint = `voice_${label.replace(/[^a-z0-9]/gi, "_")}`;
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
  await client.query("select pg_catalog.pg_advisory_xact_lock(509, 45000)");
  await client.query(migration);

  await client.query(`
    insert into auth.users (id, email) values
      ($1, 'voice-proof-admin@example.invalid'),
      ($2, 'voice-proof-one@example.invalid'),
      ($3, 'voice-proof-two@example.invalid'),
      ($4, 'voice-proof-three@example.invalid'),
      ($5, 'voice-proof-foreign@example.invalid')
  `, [ids.admin, ids.memberOne, ids.memberTwo, ids.memberThree, ids.foreignMember]);
  await client.query(`
    insert into public.organizations (id, slug, name, created_by) values
      ($1, 'voice-proof-a', 'Voice Proof A', $3),
      ($2, 'voice-proof-b', 'Voice Proof B', $3)
  `, [ids.organization, ids.foreignOrganization, ids.admin]);
  await client.query(`
    insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values
      ('voice-proof-a', 'Voice Proof A', 'voice-proof-a', true, 1, $1),
      ('voice-proof-b', 'Voice Proof B', 'voice-proof-b', true, 1, $2)
  `, [ids.organization, ids.foreignOrganization]);
  await client.query(`
    insert into public.organization_memberships (organization_id, user_id, status) values
      ($1, $3, 'active'), ($1, $4, 'active'), ($1, $5, 'active'), ($1, $6, 'active'),
      ($2, $7, 'active')
  `, [ids.organization, ids.foreignOrganization, ids.admin, ids.memberOne, ids.memberTwo, ids.memberThree, ids.foreignMember]);
  await client.query(`
    insert into public.member_chapter_memberships (user_id, chapter_id, status) values
      ($1, 'voice-proof-a', 'active'), ($2, 'voice-proof-a', 'active'),
      ($3, 'voice-proof-a', 'active'), ($4, 'voice-proof-a', 'active'),
      ($5, 'voice-proof-b', 'active')
  `, [ids.admin, ids.memberOne, ids.memberTwo, ids.memberThree, ids.foreignMember]);
  await client.query(`
    update public.member_profiles
    set chapter_id = case when id = $2 then 'voice-proof-b' else 'voice-proof-a' end
    where id = any($1::uuid[])
  `, [[ids.admin, ids.memberOne, ids.memberTwo, ids.memberThree, ids.foreignMember], ids.foreignMember]);
  await client.query(`
    insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
    values ($1, $2, 'admin', $2)
  `, [ids.organization, ids.admin]);
  await client.query(`
    insert into public.org_security_policy (id, organization_id, require_staff_mfa)
    values (true, $1, false)
  `, [ids.organization]);

  await asUser(ids.admin);
  const draft = {
    title: "Workplace priorities",
    description: "A transaction-only fictional acceptance instrument.",
    privacyMinResponses: 3,
    questions: [
      { clientKey: "issue", type: "radio", label: "Which issue matters most?", required: true, options: ["Scheduling", "Safety"], sectionKey: "priority", sectionTitle: "Priority" },
      { clientKey: "detail", type: "paragraph", label: "What scheduling change would help?", required: true, options: [], sectionKey: "follow-up", sectionTitle: "Follow-up", branchParentKey: "issue", branchValue: "Scheduling" },
      { clientKey: "tools", type: "checkbox", label: "Which tools would help?", required: false, options: ["Calendar", "Reminders", "Chat"], maxSelections: 2, sectionKey: "follow-up", sectionTitle: "Follow-up" },
      { clientKey: "confidence", type: "scale", label: "How confident are you?", required: true, options: [], sectionKey: "follow-up", sectionTitle: "Follow-up" },
    ],
  };
  const saved = (await client.query("select public.save_organization_survey_draft($1::jsonb) result", [draft])).rows[0].result;
  assert(saved.questions.length === 4, "multi-question draft did not preserve ordered questions");
  assert(saved.questions[1].branchParentKey === "issue", "branch key did not resolve to the earlier question");
  const published = (await client.query(
    "select public.publish_organization_survey_with_operations($1::jsonb, $2::jsonb) result",
    [{ ...draft, id: saved.id }, { cadence: "one_off", operationsState: "ready" }],
  )).rows[0].result;
  const byKey = Object.fromEntries(published.questions.map((question) => [question.clientKey, question]));

  await asUser(ids.foreignMember);
  await expectState(
    "cross_org_response",
    "select public.save_organization_survey_session($1, '{}'::jsonb)",
    [published.id],
    "P0002",
  );

  await asUser(ids.memberOne);
  await expectState(
    "invalid_option",
    "select public.save_organization_survey_session($1, jsonb_build_object($2::text, to_jsonb($3::text)))",
    [published.id, byKey.issue.id, "Unknown"],
    "22023",
  );
  await expectState(
    "duplicate_checkbox_option",
    "select public.save_organization_survey_session($1, jsonb_build_object($2::text, jsonb_build_array($3::text, $3::text)))",
    [published.id, byKey.tools.id, "Calendar"],
    "22023",
  );
  await client.query(
    "select public.submit_organization_survey_session($1, jsonb_build_object($2::text, to_jsonb($3::text), $4::text, to_jsonb(3)))",
    [published.id, byKey.issue.id, "Safety", byKey.confidence.id],
  );

  await asUser(ids.memberTwo);
  await client.query(
    "select public.submit_organization_survey_session($1, jsonb_build_object($2::text, to_jsonb($3::text), $4::text, to_jsonb($5::text), $6::text, to_jsonb(4)))",
    [published.id, byKey.issue.id, "Scheduling", byKey.detail.id, "More advance notice", byKey.confidence.id],
  );

  await asUser(ids.admin);
  const withheld = (await client.query("select public.get_organization_survey_report($1) result", [published.id])).rows[0].result;
  assert(withheld.available === false && withheld.responseCount === 2, "survey results were not withheld below the floor");
  const withheldExport = (await client.query("select public.export_organization_survey_results($1) result", [published.id])).rows[0].result;
  assert(withheldExport.responses.length === 0, "raw export bypassed the privacy floor");

  await asUser(ids.memberThree);
  await client.query(
    "select public.submit_organization_survey_session($1, jsonb_build_object($2::text, to_jsonb($3::text), $4::text, to_jsonb($5::text), $6::text, to_jsonb(5)))",
    [published.id, byKey.issue.id, "Scheduling", byKey.detail.id, "Stable shifts", byKey.confidence.id],
  );
  await asUser(ids.admin);
  const ready = (await client.query("select public.get_organization_survey_report($1) result", [published.id])).rows[0].result;
  assert(ready.available === true && ready.responseCount === 3, "survey report did not unlock at the configured floor");

  await asUser(ids.memberOne);
  await expectState(
    "canonical_duplicate_options",
    "select public.submit_weekly_poll_question($1, $2::jsonb)",
    ["Which meeting time works best?", JSON.stringify(["Morning", " Morning "])],
    "22023",
  );
  const weekly = (await client.query(
    "select public.submit_weekly_poll_question($1, $2::jsonb) result",
    ["Which meeting time\nworks best?", JSON.stringify([" Morning\n", " Evening "])],
  )).rows[0].result;
  assert(weekly.created === true, "weekly question was not created");

  await client.query("reset role");
  await client.query(`
    insert into auth.users (id, email)
    select pg_catalog.md5('voice-order-' || ordinal::text)::uuid,
      'voice-order-' || ordinal::text || '@example.invalid'
    from pg_catalog.generate_series(1, 24) ordinal
  `);
  await client.query(`
    insert into public.member_weekly_questions (chapter_id, user_id, week_start, body, options)
    select 'voice-proof-a', pg_catalog.md5('voice-order-' || ordinal::text)::uuid,
      pg_catalog.date_trunc('week', pg_catalog.now() at time zone 'UTC')::date,
      'Fictional ordering question ' || ordinal::text, '["First", "Second"]'::jsonb
    from pg_catalog.generate_series(1, 24) ordinal
  `);
  const rankedTarget = "50945000-0000-4000-8000-000000000040";
  await client.query(`
    insert into public.member_weekly_questions (id, chapter_id, user_id, week_start, body, options)
    values ($1, 'voice-proof-a', $2, pg_catalog.date_trunc('week', pg_catalog.now() at time zone 'UTC')::date,
      'Highest supported fictional ordering question', '["First", "Second"]'::jsonb)
  `, [rankedTarget, ids.memberTwo]);
  await client.query(
    "insert into public.member_weekly_question_supports (question_id, user_id) values ($1, $2)",
    [rankedTarget, ids.memberThree],
  );
  await asUser(ids.memberThree);
  const ranked = (await client.query("select public.list_weekly_questions() result")).rows[0].result;
  assert(ranked.length === 25, "weekly question list did not keep its bounded size");
  assert(ranked.some((item) => item.id === rankedTarget && item.score === 1), "ranking applied its limit before the deterministic score order");

  await asUser(ids.admin);
  const editorial = (await client.query("select public.list_weekly_question_editorial() result")).rows[0].result;
  assert(editorial.some((item) => item.id === weekly.id
    && item.body === "Which meeting time works best?"
    && JSON.stringify(item.options) === JSON.stringify(["Morning", "Evening"])),
  "weekly question did not enter the editorial pool with canonical publishable text");
  await client.query("select public.review_weekly_poll_question($1, 'reserved', 'Ready')", [weekly.id]);
  const weeklyPublished = (await client.query("select public.publish_weekly_poll_question($1, 3) result", [weekly.id])).rows[0].result;
  assert(weeklyPublished.state === "published" && weeklyPublished.surveyId, "weekly question did not publish into the survey lane");

  await client.query("reset role");
  await client.query("rollback");
  process.stdout.write("Voice survey completion behavior proof passed; all fixtures and schema changes rolled back.\n");
} catch (error) {
  try { await client.query("reset role"); await client.query("rollback"); } catch { /* best effort */ }
  throw error;
} finally {
  await client.end().catch(() => {});
}
