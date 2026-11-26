// @vitest-environment node
//
// BUG-UG-SURVEY-PUBLISH-NON-ATOMIC-20260920 (and the draft validator case for
// BUG-UG-SURVEY-CHOICE-QUESTIONS-NOT-SAVED-20261030 at the end) — live proof in an owned
// disposable database (RUN_SURVEY_PUBLISH_ATOMICITY_DB_TESTS=1 plus a loopback
// SUPABASE_DB_URL in the 55000-59999 disposable port block).
//
// Text pins cannot show that a second quarterly publish for a held period is
// refused before any row changes state, or that the atomic publish commits the
// status transition, the operating configuration, and the readiness task in
// one unit. Each case runs inside one transaction and rolls back; nothing here
// touches a hosted database.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect, it } from "vitest";

const live = process.env.RUN_SURVEY_PUBLISH_ATOMICITY_DB_TESTS === "1" ? it : it.skip;

async function connect() {
  const url = new URL(process.env.SUPABASE_DB_URL);
  expect(["localhost", "127.0.0.1"]).toContain(url.hostname);
  expect(Number(url.port)).toBeGreaterThanOrEqual(55000);
  expect(Number(url.port)).toBeLessThanOrEqual(59999);
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  await client.query("set statement_timeout = '10s'");
  return client;
}

async function tenant(c) {
  const f = { org: randomUUID() };
  f.chapter = `proof-${f.org}`;
  await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [f.org, f.chapter]);
  await c.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9900)", [f.chapter, f.org]);
  return f;
}

async function person(c, t) {
  const id = randomUUID();
  await c.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
  await c.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, t.chapter]);
  await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [t.org, id]);
  await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, t.chapter]);
  return id;
}

async function staff(c, t, userId, role) {
  await c.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,$3) on conflict do nothing", [t.org, userId, role]);
  await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), userId]);
}

async function actAs(c, userId) {
  const session = randomUUID();
  await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, userId]);
  await c.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: session })]);
}

function draft(title) {
  return JSON.stringify({
    title,
    privacyMinResponses: 3,
    questions: [{ type: "paragraph", label: "How are we doing?", required: true }],
  });
}

const QUARTERLY_READY = JSON.stringify({ cadence: "quarterly", periodKey: "2026-Q3", operationsState: "ready" });

// An expected refusal aborts the surrounding transaction; pin it inside a
// savepoint so the zero-new-row assertions below still run in the same txn.
async function refuses(c, sql, args, code) {
  await c.query("savepoint refuse");
  await expect(c.query(sql, args)).rejects.toMatchObject({ code });
  await c.query("rollback to refuse");
}

live("a quarterly publish commits status, configuration, and readiness task together, and a second publish for the same period changes nothing", async () => {
  const c = await connect();
  await c.query("begin");
  try {
    const t = await tenant(c);
    const steward = await person(c, t);
    await staff(c, t, steward, "steward");
    await actAs(c, steward);

    const first = await c.query("select public.publish_organization_survey_with_operations($1,$2) as r", [draft("Quarterly voice"), QUARTERLY_READY]);
    const surveyId = first.rows[0].r.id;
    const published = await c.query(
      "select status, operations_state, cadence, period_key from public.organization_surveys where id = $1",
      [surveyId],
    );
    expect(published.rows[0]).toEqual({ status: "open", operations_state: "ready", cadence: "quarterly", period_key: "2026-Q3" });
    const tasks = await c.query("select reason, status from public.organization_survey_tasks where survey_id = $1", [surveyId]);
    expect(tasks.rows).toEqual([{ reason: "readiness", status: "done" }]);

    // A second publish for a period the organization already holds is refused
    // with the distinguishable 23505 before any row changes state.
    await refuses(c, "select public.publish_organization_survey_with_operations($1,$2)", [draft("Duplicate quarter"), QUARTERLY_READY], "23505");

    const surveys = await c.query("select count(*)::int as n from public.organization_surveys where organization_id = $1", [t.org]);
    expect(surveys.rows[0].n).toBe(1);
    const allTasks = await c.query("select count(*)::int as n from public.organization_survey_tasks where organization_id = $1", [t.org]);
    expect(allTasks.rows[0].n).toBe(1);
    const stranded = await c.query(
      "select count(*)::int as n from public.organization_surveys where organization_id = $1 and status = 'open' and operations_state = 'draft'",
      [t.org],
    );
    expect(stranded.rows[0].n).toBe(0);

    // A different period still publishes atomically afterwards.
    const other = await c.query(
      "select public.publish_organization_survey_with_operations($1,$2) as r",
      [draft("Next quarter"), JSON.stringify({ cadence: "quarterly", periodKey: "2026-Q4", operationsState: "ready" })],
    );
    expect(other.rows[0].r.periodKey).toBe("2026-Q4");
    const finalSurveys = await c.query("select count(*)::int as n from public.organization_surveys where organization_id = $1 and status = 'open'", [t.org]);
    expect(finalSurveys.rows[0].n).toBe(2);
  } finally {
    await c.query("rollback");
    await c.end();
  }
});

live("publish refuses operations_state draft and leaves no live survey", async () => {
  const c = await connect();
  await c.query("begin");
  try {
    const t = await tenant(c);
    const steward = await person(c, t);
    await staff(c, t, steward, "steward");
    await actAs(c, steward);

    const draftOps = JSON.stringify({ cadence: "one_off", operationsState: "draft" });
    await refuses(c, "select public.publish_organization_survey_with_operations($1,$2)", [draft("Draft ops"), draftOps], "22023");
    const surveys = await c.query("select count(*)::int as n from public.organization_surveys where organization_id = $1", [t.org]);
    expect(surveys.rows[0].n).toBe(0);
    const tasks = await c.query("select count(*)::int as n from public.organization_survey_tasks where organization_id = $1", [t.org]);
    expect(tasks.rows[0].n).toBe(0);
  } finally {
    await c.query("rollback");
    await c.end();
  }
});

live("the retired non-atomic publisher cannot open a survey", async () => {
  const c = await connect();
  await c.query("begin");
  try {
    const t = await tenant(c);
    const steward = await person(c, t);
    await staff(c, t, steward, "steward");
    await actAs(c, steward);

    await refuses(c, "select public.publish_organization_survey($1)", [draft("Legacy")], "42501");
    const surveys = await c.query("select count(*)::int as n from public.organization_surveys where organization_id = $1", [t.org]);
    expect(surveys.rows[0].n).toBe(0);
    const tasks = await c.query("select count(*)::int as n from public.organization_survey_tasks where organization_id = $1", [t.org]);
    expect(tasks.rows[0].n).toBe(0);
  } finally {
    await c.query("rollback");
    await c.end();
  }
});

live("a transient failure after the status transition rolls the whole publish back", async () => {
  const c = await connect();
  await c.query("begin");
  try {
    const t = await tenant(c);
    const steward = await person(c, t);
    await staff(c, t, steward, "steward");
    await actAs(c, steward);

    // closes_at before opens_at violates organization_surveys_window_order.
    // The failure lands AFTER the status transition inside the one function
    // transaction, so no survey may survive at status 'open'.
    const badWindow = JSON.stringify({ cadence: "one_off", operationsState: "ready", opensAt: "2026-10-02T00:00:00Z", closesAt: "2026-10-01T00:00:00Z" });
    await refuses(c, "select public.publish_organization_survey_with_operations($1,$2)", [draft("Broken window"), badWindow], "23514");
    const surveys = await c.query("select count(*)::int as n from public.organization_surveys where organization_id = $1", [t.org]);
    expect(surveys.rows[0].n).toBe(0);
    const tasks = await c.query("select count(*)::int as n from public.organization_survey_tasks where organization_id = $1", [t.org]);
    expect(tasks.rows[0].n).toBe(0);
  } finally {
    await c.query("rollback");
    await c.end();
  }
});

// BUG-UG-SURVEY-CHOICE-QUESTIONS-NOT-SAVED-20261030 (#6552): the
// server validator behind save_organization_survey_draft. A one-choice,
// multiple-choice and dropdown question each with the three options the
// builder now sends ("Not sure" keeps its space) saves and reads back intact;
// the single run-together option the old options box produced is refused
// with the 22023 the builder names, and the refused draft leaves no survey.
live("a draft with every choice type and three options saves, and a one-option choice question is refused", async () => {
  const c = await connect();
  await c.query("begin");
  try {
    const t = await tenant(c);
    const steward = await person(c, t);
    await staff(c, t, steward, "steward");
    await actAs(c, steward);

    const options = ["Yes", "No", "Not sure"];
    const choiceDraft = JSON.stringify({
      title: "Shift bid survey",
      privacyMinResponses: 3,
      questions: ["radio", "checkbox", "dropdown"].map((type, at) => ({
        clientKey: `question-${at}`, type, label: `Choice ${type}`, required: false, options,
        ...(type === "checkbox" ? { maxSelections: 2 } : {}),
      })),
    });
    const saved = await c.query("select public.save_organization_survey_draft($1) as r", [choiceDraft]);
    expect(saved.rows[0].r.questions.map(({ type, options: stored }) => ({ type, options: stored }))).toEqual([
      { type: "radio", options },
      { type: "checkbox", options },
      { type: "dropdown", options },
    ]);
    const stored = await c.query(
      "select question_type, options from public.organization_survey_questions where survey_id = $1 order by sort_index",
      [saved.rows[0].r.id],
    );
    expect(stored.rows).toEqual([
      { question_type: "radio", options },
      { question_type: "checkbox", options },
      { question_type: "dropdown", options },
    ]);

    for (const type of ["radio", "checkbox", "dropdown"]) {
      const runTogether = JSON.stringify({
        title: "Run-together options",
        privacyMinResponses: 3,
        questions: [{ clientKey: "question-0", type, label: "Which shift?", options: ["YesNoNotsure"] }],
      });
      await c.query("savepoint refuse");
      await expect(c.query("select public.save_organization_survey_draft($1)", [runTogether]))
        .rejects.toMatchObject({ code: "22023", message: "choice questions require 2 to 20 options" });
      await c.query("rollback to refuse");
    }
    const surveys = await c.query("select count(*)::int as n from public.organization_surveys where organization_id = $1", [t.org]);
    expect(surveys.rows[0].n).toBe(1);
  } finally {
    await c.query("rollback");
    await c.end();
  }
});
