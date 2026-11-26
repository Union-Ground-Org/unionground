// @vitest-environment node
// REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104 (#7018): the
// generic organization survey readers hold their floor at greatest(25, the
// organization anonymity floor, the survey's own floor). A survey published
// with a floor of 3 is proved at 24 and at 25 submitted responses for the
// report and its export, the date-window report and its export, the admin
// worksite split and the per-response review, as a staff member and as an
// unrelated member of the same organization. A higher organization floor or
// survey floor still wins, and no survey row is rewritten.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const MIGRATION = "supabase/migrations/20261104095000_survey_report_floor_25_server_side.sql";
const migration = readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8");
const FLOOR = "greatest(25, coalesce(private.organization_limit(org, 'limits.analytics.anonymity_floor'), 25), survey.privacy_min_responses)";

describe("survey report floor 25 migration (static)", () => {
  it("is one transaction with a top-level search_path that rewrites no survey row", () => {
    expect(migration).toMatch(/\nbegin;\n/);
    expect(migration.trimEnd()).toMatch(/\ncommit;$/);
    expect(migration).toContain("\nset local search_path = pg_catalog;\n");
    expect(migration).not.toMatch(/set_config\(\s*'search_path'/);
    expect(migration).not.toMatch(/\b(update|insert into|delete from)\s+public\.organization_surveys\b/i);
    expect(migration).toContain("Existing surveys are not rewritten");
  });

  it("holds the floor in each re-emitted reader and leaves no bare survey floor comparison", () => {
    const bodies = migration.split(/\nCREATE OR REPLACE FUNCTION /).slice(1);
    expect(bodies.map((body) => body.slice(0, body.indexOf("("))))
      .toEqual(["public.get_organization_survey_report", "public.get_organization_survey_report_window", "public.get_organization_survey_worksites", "private.organization_survey_review_lane", "private.survey_operations_state"]);
    for (const body of bodies.slice(0, 2)) expect(body).toContain("select pg_catalog.jsonb_agg(case when counted.answered < floor_size then pg_catalog.jsonb_build_object(");
    for (const name of ["export_organization_survey_results", "export_organization_survey_window"]) {
      const body = migration.slice(migration.indexOf(`create or replace function public.${name}(`));
      expect(body.slice(0, body.indexOf("$function$;"))).toContain("answer.question_id <> all(withheld)");
    }
    for (const body of bodies.slice(0, 3)) {
      expect(body).toContain(`floor_size := ${FLOOR};`);
      expect(body.split("survey.privacy_min_responses")).toHaveLength(2);
    }
    expect(bodies[3]).toContain("when counted.responses >= floored.floor_size then 'ready'");
    expect(bodies[3]).toContain("coalesce(private.organization_limit(p_organization_id, 'limits.analytics.anonymity_floor'), 25)");
    expect(bodies[4]).toContain("review_ready := responses >= greatest(25,\n    coalesce(private.organization_limit(survey.organization_id, 'limits.analytics.anonymity_floor'), 25),\n    survey.privacy_min_responses);");
    expect(bodies[4].split("survey.privacy_min_responses")).toHaveLength(2);
  });
});

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;

live("survey report floor 25 on an owned disposable database", () => {
  let db, org, chapter, admin, unrelated, survey, question;
  const sessions = new Map();
  const respondents = [];
  const responseIds = [];
  const SECRET = "only-the-respondents-wrote-this";

  async function as(user, sql, values = []) {
    await db.query("savepoint request");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: "authenticated", aal: "aal2", session_id: sessions.get(user) })]);
      await db.query("set local role authenticated");
      const result = await db.query(sql, values);
      await db.query("reset role");
      await db.query("release savepoint request");
      return { code: "", value: result.rows[0]?.v };
    } catch (error) {
      await db.query("rollback to savepoint request");
      if (error.code === "42703" || error.code === "42883") throw error;
      return { code: error.code, message: error.message };
    }
  }
  async function submit(user, submittedAt = "now()") {
    const { rows: [{ id }] } = await db.query(
      `insert into public.organization_survey_sessions(organization_id,survey_id,respondent_user_id,status,submitted_at)
       values ($1,$2,$3,'submitted',${submittedAt}) returning id`,
      [org, survey, user],
    );
    await db.query("insert into public.organization_survey_answers(organization_id,session_id,question_id,value) values ($1,$2,$3,$4::jsonb)", [org, id, question, JSON.stringify(SECRET)]);
    return id;
  }
  const store = (key, value) => db.query(
    `insert into public.organization_setting_values(organization_id, setting_key, value, updated_by)
     values($1,$2,$3::jsonb,$4)
     on conflict (organization_id, setting_key) do update set value = excluded.value`,
    [org, key, JSON.stringify(value), admin],
  );
  const reads = {
    report: (user) => as(user, "select public.get_organization_survey_report($1) v", [survey]),
    exported: (user) => as(user, "select public.export_organization_survey_results($1) v", [survey]),
    window: (user, from = null) => as(user, "select public.get_organization_survey_report_window($1,$2,null) v", [survey, from]),
    windowExport: (user, from = null) => as(user, "select public.export_organization_survey_window($1,$2,null,'json') v", [survey, from]),
    worksites: (user) => as(user, "select public.get_organization_survey_worksites($1) v", [survey]),
    review: (user) => as(user, "select public.get_organization_survey_review_detail($1) v", [responseIds[0]]),
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "survey-report-floor-25-rollback-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    org = randomUUID(); chapter = `survey-floor25-${org.slice(0, 8)}`; survey = randomUUID(); question = randomUUID();
    // The admin, an unrelated member and 25 respondents, all active members.
    const users = Array.from({ length: 27 }, () => randomUUID());
    [admin, unrelated] = users;
    respondents.push(...users.slice(2));
    await db.query("insert into auth.users(id,email) select id,id::text || '@example.invalid' from unnest($1::uuid[]) id", [users]);
    await db.query("insert into public.organizations(id,slug,name) values ($1,$2,'Survey floor proof')", [org, chapter]);
    await db.query("insert into public.chapters(id,name,slug,order_index,organization_id) values ($1,'Survey floor chapter',$1,180711,$2)", [chapter, org]);
    await db.query("update public.member_profiles set chapter_id=$2 where id = any($1::uuid[])", [users, chapter]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) select $2,id,'active' from unnest($1::uuid[]) id on conflict do nothing", [users, org]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) select id,$2,'active' from unnest($1::uuid[]) id on conflict do nothing", [users, chapter]);
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'admin',$2)", [org, admin]);
    for (const user of [admin, unrelated]) {
      const session = randomUUID(); sessions.set(user, session);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, user]);
    }
    // Every respondent shares one worksite with organization admins.
    await db.query("insert into public.member_profile_details(user_id,worksite,details_visibility) select id,'Main','admins' from unnest($1::uuid[]) id", [respondents]);
    await db.query("insert into public.organization_surveys(id,organization_id,chapter_id,title,status,privacy_min_responses,created_by) values ($1,$2,$3,'Survey floor proof','closed',3,$4)", [survey, org, chapter, admin]);
    await db.query("insert into public.organization_survey_questions(id,organization_id,survey_id,sort_index,question_type,label) values ($1,$2,$3,0,'yes_no','Enough staff?')", [question, org, survey]);
    // Twenty-four responses from ten days ago; the 25th arrives in a case.
    for (const user of respondents.slice(0, 24)) responseIds.push(await submit(user, "now() - interval '10 days'"));
  }, 60000);
  beforeEach(async () => { await db.query("savepoint scenario"); });
  // Each case's 25th response is rolled back with its savepoint.
  afterEach(async () => { responseIds.length = 24; await db.query("reset role"); await db.query("rollback to savepoint scenario"); });
  afterAll(async () => { if (db) { await db.query("rollback").catch(() => {}); await db.end(); } });

  it("withholds every reader at 24 responses although the survey floor is 3", async () => {
    expect((await reads.report(admin)).value).toEqual({ surveyId: survey, responseCount: 24, privacyMinResponses: 25, available: false, questions: [] });
    const exported = (await reads.exported(admin)).value;
    expect(exported).toMatchObject({ available: false, responseCount: 24, privacyMinResponses: 25, responses: [] });
    expect((await reads.window(admin)).value).toMatchObject({ available: false, responseCount: 24, privacyMinResponses: 25, questions: [] });
    expect(await reads.windowExport(admin)).toMatchObject({ code: "22023" });
    expect((await reads.worksites(admin)).value).toEqual({ privacyMinResponses: 25, withheld: true, groups: [] });
    expect((await reads.review(admin)).value).toMatchObject({ available: false, state: "collecting", responseCount: 24, privacyMinResponses: 25, answers: [] });
    const lane = (await db.query("select private.organization_survey_review_lane($1,$2) v", [org, survey])).rows[0].v;
    expect(lane).toEqual({ state: "collecting", responseCount: 24, privacyMinResponses: 25 });
    expect((await db.query("select private.survey_operations_state($1) v", [survey])).rows[0].v).toMatchObject({ reviewReady: false });
    expect(JSON.stringify(exported)).not.toContain(SECRET);
    const { rows } = await db.query("select privacy_min_responses from public.organization_surveys where id=$1", [survey]);
    expect(rows).toEqual([{ privacy_min_responses: 3 }]);
  });

  it("releases every reader at 25 responses", async () => {
    responseIds.push(await submit(respondents[24]));
    const report = (await reads.report(admin)).value;
    expect(report).toMatchObject({ available: true, responseCount: 25, privacyMinResponses: 25 });
    expect(report.questions[0]).toMatchObject({ id: question, answered: 25 });
    const exported = (await reads.exported(admin)).value;
    expect(exported).toMatchObject({ available: true, responseCount: 25 });
    expect(exported.responses).toHaveLength(25);
    expect((await reads.window(admin)).value).toMatchObject({ available: true, responseCount: 25, privacyMinResponses: 25 });
    const windowed = (await reads.windowExport(admin)).value;
    expect(windowed).toMatchObject({ available: true, responseCount: 25, format: "json" });
    expect(windowed.responses).toHaveLength(25);
    const worksites = (await reads.worksites(admin)).value;
    expect(worksites).toMatchObject({ privacyMinResponses: 25, withheld: false });
    expect(worksites.groups.map((group) => [group.worksite, group.responseCount])).toEqual([["Main", 25]]);
    expect((await reads.review(admin)).value).toMatchObject({ available: true, state: "ready", responseCount: 25, privacyMinResponses: 25 });
    expect((await db.query("select private.survey_operations_state($1) v", [survey])).rows[0].v).toMatchObject({ reviewReady: true });
  });

  it("holds the window floor on the responses inside the window", async () => {
    responseIds.push(await submit(respondents[24]));
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    expect((await reads.window(admin, recent)).value).toMatchObject({ available: false, responseCount: 1, privacyMinResponses: 25, questions: [] });
    expect(await reads.windowExport(admin, recent)).toMatchObject({ code: "22023" });
  });

  // Gate round 2 (r2g2): with 25 responses, a question answered by fewer than
  // 25 people is withheld in both reports and left out of both exports.
  it("withholds each question answered by fewer than the floor, in both reports and both exports", async () => {
    responseIds.push(await submit(respondents[24]));
    const optional = randomUUID(), partial = randomUUID();
    const RARE = "only-three-people-answered-this";
    await db.query(`insert into public.organization_survey_questions(id,organization_id,survey_id,sort_index,question_type,label,options,required)
      values ($1,$3,$4,1,'radio','Optional pick','["x","y"]'::jsonb,false), ($2,$3,$4,2,'paragraph','Optional note','[]'::jsonb,false)`, [optional, partial, org, survey]);
    for (const [index, session] of responseIds.entries()) {
      if (index < 3) await db.query("insert into public.organization_survey_answers(organization_id,session_id,question_id,value) values ($1,$2,$3,'\"x\"'::jsonb)", [org, session, optional]);
      if (index < 24) await db.query("insert into public.organization_survey_answers(organization_id,session_id,question_id,value) values ($1,$2,$3,$4::jsonb)", [org, session, partial, JSON.stringify(RARE)]);
    }
    const shapes = (payload) => payload.questions.map((item) => [item.id, item.withheld, item.answered, item.distribution.length]);
    const expected = [[question, false, 25, 1], [optional, true, null, 0], [partial, true, null, 0]];
    const report = (await reads.report(admin)).value;
    expect(report).toMatchObject({ available: true, responseCount: 25 });
    expect(shapes(report)).toEqual(expected);
    const window = (await reads.window(admin)).value;
    expect(shapes(window)).toEqual(expected);
    const exported = (await reads.exported(admin)).value;
    const csv = (await as(admin, "select public.export_organization_survey_window($1,null,null,'csv') v", [survey])).value;
    expect(csv).toMatchObject({ format: "csv", available: true });
    for (const payload of [exported, csv]) {
      expect(shapes(payload)).toEqual(expected);
      expect(payload.responses).toHaveLength(25);
      expect(payload.responses.every((row) => Object.keys(row.answers).join() === question)).toBe(true);
      expect(JSON.stringify(payload)).not.toContain(RARE);
    }
    // At 25 answers the question is released again.
    await db.query("insert into public.organization_survey_answers(organization_id,session_id,question_id,value) values ($1,$2,$3,$4::jsonb)", [org, responseIds[24], partial, JSON.stringify(RARE)]);
    expect(shapes((await reads.report(admin)).value)[2]).toEqual([partial, false, 25, 0]);
    const released = (await reads.windowExport(admin)).value;
    expect(released.responses.every((row) => Object.keys(row.answers).sort().join() === [question, partial].sort().join())).toBe(true);
  });

  // Gate round 3 (r3s1): a blank optional answer is stored as an empty value.
  // Three real answers and 22 blanks are 3 answers, not 25.
  it("counts no blank answer toward a question's floor", async () => {
    responseIds.push(await submit(respondents[24]));
    const optional = randomUUID();
    const REAL = "one-of-three-real-answers";
    await db.query(`insert into public.organization_survey_questions(id,organization_id,survey_id,sort_index,question_type,label,required)
      values ($1,$2,$3,1,'text','Optional comment',false)`, [optional, org, survey]);
    const blanks = ["", "   ", null, []];
    for (const [index, session] of responseIds.entries()) {
      const value = index < 3 ? REAL : blanks[index % blanks.length];
      await db.query("insert into public.organization_survey_answers(organization_id,session_id,question_id,value) values ($1,$2,$3,$4::jsonb)", [org, session, optional, JSON.stringify(value)]);
    }
    const shape = (payload) => payload.questions.find((item) => item.id === optional);
    const csv = () => as(admin, "select public.export_organization_survey_window($1,null,null,'csv') v", [survey]);
    for (const payload of [(await reads.report(admin)).value, (await reads.window(admin)).value, (await reads.exported(admin)).value, (await csv()).value]) {
      expect(payload).toMatchObject({ available: true, responseCount: 25 });
      expect(shape(payload)).toMatchObject({ withheld: true, answered: null, distribution: [] });
      expect(JSON.stringify(payload)).not.toContain(REAL);
      if (payload.responses) expect(payload.responses.some((row) => optional in row.answers)).toBe(false);
    }
    // Twenty-five real answers release the question everywhere.
    await db.query("update public.organization_survey_answers set value = $2::jsonb where question_id = $1", [optional, JSON.stringify(REAL)]);
    for (const payload of [(await reads.report(admin)).value, (await reads.window(admin)).value, (await reads.exported(admin)).value, (await csv()).value]) {
      expect(shape(payload)).toMatchObject({ withheld: false, answered: 25 });
      if (payload.responses) expect(payload.responses.filter((row) => row.answers[optional] === REAL)).toHaveLength(25);
    }
  });

  // Gate round 4 preflight: the member submission path stores an optional
  // text answer verbatim, so tab-only, newline-only and CRLF-only strings
  // reach the table and must not count either.
  it("counts no whitespace-only answer submitted through the member path", async () => {
    const open = randomUUID(), required = randomUUID(), optional = randomUUID();
    const REAL = "one-of-three-submitted-answers";
    await db.query("insert into public.organization_surveys(id,organization_id,title,status,privacy_min_responses,created_by) values ($1,$2,'Member path floor proof','open',3,$3)", [open, org, admin]);
    await db.query(`insert into public.organization_survey_questions(id,organization_id,survey_id,sort_index,question_type,label,required)
      values ($1,$3,$4,0,'yes_no','Enough staff?',true), ($2,$3,$4,1,'text','Optional comment',false)`, [required, optional, org, open]);
    // None of these is empty after trimming spaces alone, so all 22 would
    // count (3 + 22 = 25) if only spaces were trimmed.
    const blanks = ["\t", "\n", "\r\n", " \t\r\n ", "\t\t"];
    for (const [index, user] of respondents.entries()) {
      const session = randomUUID(); sessions.set(user, session);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, user]);
      const answers = { [required]: "yes", [optional]: index < 3 ? REAL : blanks[index % blanks.length] };
      expect(await as(user, "select public.submit_organization_survey_session($1,$2::jsonb) v", [open, JSON.stringify(answers)])).toMatchObject({ code: "" });
    }
    const stored = (await db.query("select value #>> '{}' as v, pg_catalog.count(*)::int as n from public.organization_survey_answers where question_id=$1 group by 1 order by 1", [optional])).rows;
    expect(stored.map((row) => row.v).sort()).toEqual([...blanks, REAL].sort());
    expect(stored.reduce((sum, row) => sum + row.n, 0)).toBe(25);
    await db.query("update public.organization_surveys set status='closed' where id=$1", [open]);
    // One request at a time: each read opens and releases its own savepoint.
    const readers = [
      "select public.get_organization_survey_report($1) v",
      "select public.get_organization_survey_report_window($1,null,null) v",
      "select public.export_organization_survey_results($1) v",
      "select public.export_organization_survey_window($1,null,null,'csv') v",
    ];
    for (const sql of readers) {
      const payload = (await as(admin, sql, [open])).value;
      expect(payload).toMatchObject({ available: true, responseCount: 25 });
      expect(payload.questions.map((item) => [item.id, item.withheld, item.answered])).toEqual([[required, false, 25], [optional, true, null]]);
      expect(JSON.stringify(payload)).not.toContain(REAL);
      if (payload.responses) expect(payload.responses.some((row) => optional in row.answers)).toBe(false);
    }
  });

  it.each([24, 25])("refuses an unrelated member at %i responses", async (count) => {
    if (count === 25) responseIds.push(await submit(respondents[24]));
    for (const read of Object.values(reads)) {
      expect(await read(unrelated)).toMatchObject({ code: "42501" });
    }
  });

  it("keeps a higher organization floor or survey floor", async () => {
    responseIds.push(await submit(respondents[24]));
    await store("limits.analytics.anonymity_floor", 30);
    expect((await reads.report(admin)).value).toMatchObject({ available: false, responseCount: 25, privacyMinResponses: 30 });
    expect((await reads.exported(admin)).value).toMatchObject({ available: false, responses: [] });
    expect((await reads.review(admin)).value).toMatchObject({ state: "collecting", privacyMinResponses: 30 });
    expect((await db.query("select private.survey_operations_state($1) v", [survey])).rows[0].v).toMatchObject({ reviewReady: false });
    await store("limits.analytics.anonymity_floor", 25);
    expect((await as(admin, "select public.set_organization_survey_privacy_floor($1, 40) v", [survey])).code).toBe("");
    expect((await reads.window(admin)).value).toMatchObject({ available: false, responseCount: 25, privacyMinResponses: 40 });
    expect(await reads.windowExport(admin)).toMatchObject({ code: "22023" });
    expect((await reads.worksites(admin)).value).toEqual({ privacyMinResponses: 40, withheld: true, groups: [] });
  });
});
