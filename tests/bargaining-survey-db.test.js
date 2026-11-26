// @vitest-environment node
//
// REQ-UG-BARGAINING-SURVEY-20261012: public.get_bargaining_survey_results()
// is staff-only, organization-scoped and limited to bargaining-template
// surveys; it returns nothing but the response count below
// greatest(25, limits.analytics.anonymity_floor, the survey floor), withholds
// any question answered by fewer than that, never returns written answer
// text, and counts only submitted sessions of that survey.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";
import { releaseCalendarHolds } from "./helpers/release-calendar-holds.js";

const MIGRATION = "supabase/migrations/20261015142500_bargaining_survey_results.sql";
const migration = readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8");
const code = stripComments(migration);

describe("bargaining survey results migration (static)", () => {
  it("is one transaction that adds one read-only, staff-checked, switch-gated function and grants it to signed-in users only", () => {
    expect(migration).toMatch(/\nbegin;\n/);
    expect(migration.trimEnd()).toMatch(/\ncommit;$/);
    expect(code.match(/create (or replace )?function/g)).toEqual(["create function", "create function", "create or replace function", "create or replace function", "create or replace function", "create or replace function", "create or replace function"]);
    // The only rows the migration writes are the switch's platform
    // definition, default off, and the account lifecycle review of the floor
    // trigger; the other writes sit unchanged inside the redefined worksite
    // split and follow-up task opener.
    expect(code.match(/\b(insert|update|delete)\s+(into\s+)?(public|private)\.\w+/gi)).toEqual(["insert into public.platform_setting_definitions", "update private.organization_survey_worksite_releases", "insert into private.organization_survey_worksite_releases", "insert into public.organization_survey_tasks", "insert into public.organization_audit_events", "insert into private.account_lifecycle_trigger_review"]);
    expect(code).toContain("('features.engagement_voice.bargaining_survey_template', 'boolean',");
    expect(code).toMatch(/'false', null, null, null, 130, 'engagement_voice', true\)\non conflict \(key\) do nothing;/);
    expect(code).toMatch(/returns jsonb\nlanguage plpgsql\nstable\nsecurity definer\nset search_path = ''/);
    const body = code.slice(code.indexOf("begin\n  perform"));
    expect(body.startsWith("begin\n  perform private.engagement_require_staff(org);\n  if not private.organization_feature_enabled(org, 'features.engagement_voice.bargaining_survey_template') then\n    raise exception 'bargaining survey template is off for this organization' using errcode = '42501';")).toBe(true);
    expect(code).toContain("revoke all on function public.get_bargaining_survey_results(uuid)\n  from public, anon, authenticated, service_role;");
    expect(code).toContain("grant execute on function public.get_bargaining_survey_results(uuid)\n  to authenticated;");
  });

  it("keeps every bargaining survey's own floor at 25 or more, checked at commit on both tables", () => {
    expect(code).toContain("survey.id = target and survey.privacy_min_responses < 25");
    expect(code).toContain("raise exception 'a bargaining survey keeps a privacy floor of at least 25' using errcode = '22023';");
    expect(code).toContain("revoke all on function private.enforce_bargaining_survey_floor()\n  from public, anon, authenticated, service_role;");
    expect(code).toContain("create constraint trigger organization_surveys_bargaining_floor\n  after insert or update of privacy_min_responses on public.organization_surveys\n  deferrable initially deferred");
    expect(code).toContain("create constraint trigger organization_survey_questions_bargaining_floor\n  after insert or update of section_key on public.organization_survey_questions\n  deferrable initially deferred");
  });

  it("never lets the floor drop below 25 and withholds per question at the same floor", () => {
    expect(code).toContain("floor_size := greatest(\n    25,\n    coalesce(private.organization_limit(org, 'limits.analytics.anonymity_floor'), 25),\n    survey.privacy_min_responses\n  );");
    expect(code).toContain("if responses < floor_size then\n    return base || pg_catalog.jsonb_build_object('available', false, 'questions', '[]'::jsonb);");
    expect(code).toContain("case when counted.answered < floor_size then");
    expect(code).toContain("when counted.question_type in ('text', 'paragraph') then '[]'::jsonb");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("bargaining survey results on a disposable database", () => {
  let db;
  let ids;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "bargaining-survey-proof" });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });

  async function user(label, org, chapter) {
    const id = randomUUID();
    await db.query("insert into auth.users (id, email) values ($1, $2)", [id, `${label}-${id}@example.invalid`]);
    await db.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [org, id]);
    await db.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [id, chapter]);
    await db.query("update public.member_profiles set chapter_id = $1 where id = $2", [chapter, id]);
    const session = randomUUID();
    await db.query("insert into auth.sessions (id, user_id, aal, created_at, updated_at) values ($1, $2, 'aal2', now(), now())", [session, id]);
    await db.query("insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values ($1, $2, 'totp', 'verified', now(), now())", [randomUUID(), id]);
    ids.sessions[id] = session;
    return id;
  }

  async function organization(label) {
    const org = randomUUID();
    const chapter = `${label}-${randomUUID()}`;
    const bootstrap = randomUUID();
    await db.query("insert into auth.users (id, email) values ($1, $2)", [bootstrap, `bootstrap-${bootstrap}@example.invalid`]);
    await db.query("insert into public.organizations (id, slug, name, created_by) values ($1, $2, $3, $4)", [org, chapter, `Bargaining proof ${label}`, bootstrap]);
    await db.query("insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values ($1, $1, $1, true, 1, $2)", [chapter, org]);
    return { org, chapter };
  }

  async function surveyWith(org, owner, questions, floor = 25) {
    const id = randomUUID();
    await db.query(
      `insert into public.organization_surveys (id, organization_id, title, status, cadence, owner_user_id, privacy_min_responses, created_by, operations_state)
       values ($1, $2, 'Bargaining survey', 'open', 'one_off', $3, $4, $3, 'distributing')`,
      [id, org, owner, floor],
    );
    const questionIds = {};
    for (const [index, [key, section, type, options]] of questions.entries()) {
      questionIds[key] = (await db.query(
        `insert into public.organization_survey_questions (organization_id, survey_id, sort_index, client_key, section_key, question_type, label, options)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) returning id`,
        [org, id, index, key, section, type, `Question ${key}`, JSON.stringify(options)],
      )).rows[0].id;
    }
    return { id, questions: questionIds };
  }

  async function respond(survey, member, answers, status = "submitted") {
    const session = (await db.query(
      `insert into public.organization_survey_sessions (organization_id, survey_id, respondent_user_id, status, submitted_at)
       values ($1, $2, $3, $4, case when $4 = 'submitted' then now() else null end) returning id`,
      [ids.org, survey.id, member, status],
    )).rows[0].id;
    for (const [key, value] of Object.entries(answers)) {
      await db.query("insert into public.organization_survey_answers (organization_id, session_id, question_id, value) values ($1, $2, $3, $4::jsonb)", [ids.org, session, survey.questions[key], JSON.stringify(value)]);
    }
  }

  const SWITCH = "features.engagement_voice.bargaining_survey_template";
  const QUESTIONS = [
    ["bargaining-v1:priorities", "bargaining-v1:priorities", "checkbox", ["Article 12: Salary Rates", "Article 20: Safety and Health", "Article 8: Leave"]],
    ["bargaining-v1:readiness", "bargaining-v1:action", "scale", []],
    ["bargaining-v1:change", "bargaining-v1:open", "paragraph", []],
    ["bargaining-v1:other", "bargaining-v1:open", "paragraph", []],
  ];

  beforeEach(async () => {
    await db.query("begin");
    await releaseCalendarHolds(db);
    await db.query("set local statement_timeout = '60s'");
    ids = { sessions: {}, members: [] };
    Object.assign(ids, await organization("home"));
    ids.admin = await user("admin", ids.org, ids.chapter);
    await db.query("insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, 'admin', $2)", [ids.org, ids.admin]);
    await db.query("insert into public.member_roles (user_id, role, chapter_id, granted_by) values ($1, 'admin', $2, $1)", [ids.admin, ids.chapter]);
    await db.query("insert into public.member_role_chapters (user_id, role, chapter_id, granted_by) values ($1, 'admin', $2, $1)", [ids.admin, ids.chapter]);
    for (let index = 0; index < 27; index += 1) ids.members.push(await user(`member${index}`, ids.org, ids.chapter));
    ids.survey = await surveyWith(ids.org, ids.admin, QUESTIONS);
    await setting(SWITCH, true);
  });
  afterEach(async () => { await db.query("rollback"); });

  async function as(userId, sql, values = []) {
    await db.query("savepoint caller");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: ids.sessions[userId] })]);
      await db.query("set local role authenticated");
      const result = await db.query(sql, values);
      await db.query("reset role");
      await db.query("release savepoint caller");
      return { code: "", rows: result.rows };
    } catch (error) {
      await db.query("rollback to savepoint caller");
      await db.query("reset role").catch(() => {});
      return { code: error.code || "?", rows: [], message: error.message };
    }
  }
  const results = async (userId, surveyId = ids.survey.id) => {
    const answer = await as(userId, "select public.get_bargaining_survey_results($1) r", [surveyId]);
    return answer.code ? answer : answer.rows[0].r;
  };
  const setting = (key, value) => db.query(
    "insert into public.organization_setting_values (organization_id, setting_key, value, updated_by) values ($1, $2, $3::jsonb, $4) on conflict (organization_id, setting_key) do update set value = excluded.value",
    [ids.org, key, JSON.stringify(value), ids.admin],
  );
  const answer = (index) => ({
    "bargaining-v1:priorities": index % 3 === 0 ? ["Article 12: Salary Rates", "Article 20: Safety and Health"] : ["Article 12: Salary Rates"],
    "bargaining-v1:readiness": index % 2 ? 5 : 4,
    "bargaining-v1:change": `Private written answer ${index}`,
    ...(index < 3 ? { "bargaining-v1:other": `Another private answer ${index}` } : {}),
  });

  it("refuses members, other organizations' and non-template surveys, and anonymous callers", async () => {
    expect((await results(ids.members[0])).code).toBe("42501");
    const elsewhere = await organization("away");
    const theirs = await surveyWith(elsewhere.org, ids.admin, QUESTIONS);
    expect((await results(ids.admin, theirs.id)).code).toBe("P0002");
    const plain = await surveyWith(ids.org, ids.admin, [["question-0", "section-1", "radio", ["Pay", "Safety"]]]);
    expect(await results(ids.admin, plain.id)).toMatchObject({ code: "P0002", message: "not a bargaining survey" });
    await db.query("savepoint anon");
    await db.query("set local role anon");
    await expect(db.query("select public.get_bargaining_survey_results($1)", [ids.survey.id])).rejects.toMatchObject({ code: "42501" });
    await db.query("rollback to savepoint anon");
    // The template quotes one agreement: staff of an organization that has not
    // turned it on (the default) or turned it off get nothing.
    await setting(SWITCH, false);
    expect(await results(ids.admin)).toMatchObject({ code: "42501", message: "bargaining survey template is off for this organization" });
    await db.query("delete from public.organization_setting_values where organization_id = $1 and setting_key = $2", [ids.org, SWITCH]);
    expect((await results(ids.admin)).code).toBe("42501");
    await setting(SWITCH, true);
    expect(await results(ids.admin)).toMatchObject({ available: false });
  });

  it("returns only the count below 25, even when the organization or survey asks for less", async () => {
    for (let index = 0; index < 24; index += 1) await respond(ids.survey, ids.members[index], answer(index));
    await respond(ids.survey, ids.members[24], answer(24), "in_progress");
    // An organization can no longer store a floor under 25 (#7010), so only
    // the survey asks for less here.
    await db.query("update public.organization_surveys set privacy_min_responses = 3 where id = $1", [ids.survey.id]);
    const withheld = await results(ids.admin);
    expect(withheld).toMatchObject({ available: false, responseCount: 24, minimumResponses: 25, questions: [], organizationName: "Bargaining proof home" });
    expect(withheld).not.toHaveProperty("firstSubmittedAt");
    expect(JSON.stringify(withheld)).not.toContain("Article 12");
  });

  it("releases totals at the floor, withholds a small question, never returns written text and counts only submitted sessions of this survey", async () => {
    for (let index = 0; index < 26; index += 1) await respond(ids.survey, ids.members[index], answer(index));
    await respond(ids.survey, ids.members[26], { "bargaining-v1:priorities": ["Article 8: Leave"] }, "in_progress");
    const released = await results(ids.admin);
    expect(released).toMatchObject({ available: true, responseCount: 26, minimumResponses: 25 });
    expect(released.firstSubmittedAt).toBeTruthy();
    const byKey = Object.fromEntries(released.questions.map((question) => [question.clientKey, question]));
    expect(byKey["bargaining-v1:priorities"]).toMatchObject({ withheld: false, answered: 26 });
    expect(byKey["bargaining-v1:priorities"].distribution).toEqual(expect.arrayContaining([
      { value: "Article 12: Salary Rates", count: 26 },
      { value: "Article 20: Safety and Health", count: 9 },
    ]));
    expect(byKey["bargaining-v1:priorities"].distribution.some((bucket) => bucket.value === "Article 8: Leave")).toBe(false);
    expect(byKey["bargaining-v1:readiness"].distribution).toEqual([{ value: 4, count: 13 }, { value: 5, count: 13 }]);
    expect(byKey["bargaining-v1:change"]).toMatchObject({ withheld: false, answered: 26, distribution: [] });
    expect(byKey["bargaining-v1:other"]).toMatchObject({ withheld: true, answered: null, distribution: [] });
    expect(JSON.stringify(released)).not.toContain("private");
  });

  it("refuses a floor under 25 on a survey with template questions, by any path, at commit", async () => {
    const check = async (sql, values) => {
      await db.query("savepoint floor");
      try {
        await db.query(sql, values);
        await db.query("set constraints all immediate");
        await db.query("set constraints all deferred");
        await db.query("release savepoint floor");
        return "";
      } catch (error) {
        await db.query("rollback to savepoint floor");
        return error.code;
      }
    };
    // Lowering the floor of a bargaining survey.
    expect(await check("update public.organization_surveys set privacy_min_responses = 10 where id = $1", [ids.survey.id])).toBe("22023");
    // Adding a template question to a survey that keeps a lower floor.
    const plain = await surveyWith(ids.org, ids.admin, [["question-0", "section-1", "radio", ["Pay", "Safety"]]], 3);
    expect(await check("update public.organization_survey_questions set section_key = 'bargaining-v1:priorities' where survey_id = $1", [plain.id])).toBe("22023");
    // A plain survey keeps its own lower floor, and a bargaining survey may raise its own.
    expect(await check("update public.organization_surveys set privacy_min_responses = 3 where id = $1", [plain.id])).toBe("");
    expect(await check("update public.organization_surveys set privacy_min_responses = 30 where id = $1", [ids.survey.id])).toBe("");
  });

  it("keeps the generic reports, both exports and the review detail away from a bargaining survey, and not from a plain one", async () => {
    for (let index = 0; index < 26; index += 1) await respond(ids.survey, ids.members[index], answer(index));
    await setting("features.engagement_voice.survey_report_exports", true);
    const refused = async (sql) => (await as(ids.admin, sql, [ids.survey.id])).code;
    expect(await refused("select public.get_organization_survey_report($1) r")).toBe("42501");
    expect(await refused("select public.get_organization_survey_report_window($1) r")).toBe("42501");
    expect(await refused("select public.export_organization_survey_results($1) r")).toBe("42501");
    expect(await refused("select public.export_organization_survey_window($1, null, null, 'json') r")).toBe("42501");
    // The sweep's task opener opens no response review for it, and still opens other tasks.
    const opened = async (reason) => (await db.query("select private.open_survey_follow_up_task(s, $2, null) o from public.organization_surveys s where s.id = $1", [ids.survey.id, reason])).rows[0].o;
    expect(await opened("response_review")).toBe(false);
    expect(await opened("closeout")).toBe(true);
    // The admin worksite split reaches the same refusal past its admin and full-session checks.
    expect((await as(ids.admin, "select public.get_organization_survey_worksites($1) r", [ids.survey.id])).message).toBe("a bargaining survey reports totals only");
    const session = (await db.query("select id from public.organization_survey_sessions where survey_id = $1 and status = 'submitted' limit 1", [ids.survey.id])).rows[0].id;
    const detail = await as(ids.admin, "select public.get_organization_survey_review_detail($1) r", [session]);
    expect(detail.code).toBe("");
    expect(detail.rows[0].r).toMatchObject({ available: false, answers: [] });
    expect(JSON.stringify(detail.rows[0].r)).not.toContain("Private written answer");

    const plain = await surveyWith(ids.org, ids.admin, [["question-0", "section-1", "radio", ["Pay", "Safety"]]], 3);
    // A plain survey's own floor of 3 still reports only at 25
    // (REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104).
    for (let index = 0; index < 25; index += 1) await respond(plain, ids.members[index], { "question-0": "Pay" });
    const report = await as(ids.admin, "select public.get_organization_survey_report($1) r", [plain.id]);
    expect(report.rows[0].r).toMatchObject({ available: true, responseCount: 25, privacyMinResponses: 25 });
  });

  it("follows a higher organization or survey floor", async () => {
    for (let index = 0; index < 26; index += 1) await respond(ids.survey, ids.members[index], answer(index));
    await setting("limits.analytics.anonymity_floor", 30);
    expect(await results(ids.admin)).toMatchObject({ available: false, minimumResponses: 30 });
    await setting("limits.analytics.anonymity_floor", 25);
    await db.query("update public.organization_surveys set privacy_min_responses = 40 where id = $1", [ids.survey.id]);
    expect(await results(ids.admin)).toMatchObject({ available: false, minimumResponses: 40 });
  });
});
