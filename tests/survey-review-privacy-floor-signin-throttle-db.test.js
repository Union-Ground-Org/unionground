// @vitest-environment node
//
// SEC-UG-SURVEY-REVIEW-PRIVACY-FLOOR-20261001
// SEC-UG-PASSWORD-SIGNIN-THROTTLE-20261001
//
// Live proof on a disposable database for 20261002015000:
//   * below a survey's privacy floor the review detail, the staff snapshot's
//     review lane, review triage, the report and the export reveal no single
//     response (no answers, no per-response rows or times); at the floor the
//     lane works; another organization's staff are refused. The survey's own
//     floor is 3, but the readers hold 25
//     (REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104);
//   * the durable password sign-in throttle trips at the per-address and
//     per-network limits, resets after the window, answers a real and an
//     unknown address identically, stores no raw address, and is reachable
//     only by the service role.
// Everything runs in one transaction that is rolled back.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("survey review privacy floor and password sign-in throttle", () => {
  let client;
  const ids = {
    orgA: randomUUID(), orgB: randomUUID(), adminA: randomUUID(), adminB: randomUUID(),
    survey: randomUUID(), choice: randomUUID(), text: randomUUID(),
    members: Array.from({ length: 26 }, () => randomUUID()),
  };
  ids.chapterA = `floor-a-${ids.orgA}`;
  ids.chapterB = `floor-b-${ids.orgB}`;
  const sessions = new Map();
  const SECRET_ANSWER = "only-this-respondent-wrote-this";

  async function as(role, claims, sql, args = []) {
    await client.query("savepoint proof");
    try {
      await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
      await client.query(`set local role ${role}`);
      const { rows } = await client.query(sql, args);
      await client.query("release savepoint proof");
      return { value: rows[0]?.value };
    } catch (error) {
      await client.query("rollback to savepoint proof");
      return { code: error.code, message: error.message };
    } finally {
      await client.query("reset role");
    }
  }

  const staff = (user) => ({ sub: user, role: "authenticated", aal: "aal2", session_id: sessions.get(user) });
  const service = { role: "service_role" };

  async function person(user, org, chapter) {
    const session = randomUUID();
    sessions.set(user, session);
    await client.query("insert into auth.users(id,email) values ($1,$2)", [user, `${user}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
    await client.query(
      "insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing",
      [org, user],
    );
    await client.query(
      "insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing",
      [user, chapter],
    );
    await client.query(
      "insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())",
      [randomUUID(), user],
    );
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, user]);
  }

  // A real submission: the session is saved in progress, answered, then
  // flipped to submitted so the engagement trigger files its review row.
  async function submit(member, choice, text, status = "submitted") {
    const { rows: [{ id }] } = await client.query(
      "insert into public.organization_survey_sessions(organization_id,survey_id,respondent_user_id) values ($1,$2,$3) returning id",
      [ids.orgA, ids.survey, member],
    );
    await client.query(
      "insert into public.organization_survey_answers(organization_id,session_id,question_id,value) values ($1,$2,$3,$4),($1,$2,$5,$6)",
      [ids.orgA, id, ids.choice, JSON.stringify(choice), ids.text, JSON.stringify(text)],
    );
    if (status === "submitted") {
      await client.query("update public.organization_survey_sessions set status='submitted', submitted_at=now() where id=$1", [id]);
    }
    return id;
  }

  async function reviewFor(sessionId) {
    const { rows: [row] } = await client.query("select id from public.organization_survey_reviews where session_id=$1", [sessionId]);
    return row?.id;
  }

  const snapshotSurvey = async (user) => {
    const { value } = await as("authenticated", staff(user), "select public.get_staff_engagement_snapshot() as value");
    return value.surveys.find((survey) => survey.id === ids.survey);
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      application_name: "survey-review-floor-signin-throttle-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '15s'");
    for (const [org, chapter, order] of [[ids.orgA, ids.chapterA, 9950], [ids.orgB, ids.chapterB, 9951]]) {
      await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org, chapter]);
      await client.query(
        "insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,$3)",
        [chapter, org, order],
      );
    }
    await person(ids.adminA, ids.orgA, ids.chapterA);
    await person(ids.adminB, ids.orgB, ids.chapterB);
    for (const member of ids.members) await person(member, ids.orgA, ids.chapterA);
    for (const [org, user] of [[ids.orgA, ids.adminA], [ids.orgB, ids.adminB]]) {
      await client.query(
        "insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin') on conflict do nothing",
        [org, user],
      );
    }
    await client.query(
      "insert into public.organization_surveys(id,organization_id,chapter_id,title,status,privacy_min_responses,created_by) values ($1,$2,$3,'Privacy floor proof','open',3,$4)",
      [ids.survey, ids.orgA, ids.chapterA, ids.adminA],
    );
    await client.query(
      `insert into public.organization_survey_questions(id,organization_id,survey_id,sort_index,question_type,label,options)
       values ($1,$3,$4,0,'radio','Pick one','["a","b"]'::jsonb), ($2,$3,$4,1,'paragraph','Tell us more','[]'::jsonb)`,
      [ids.choice, ids.text, ids.orgA, ids.survey],
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  describe("survey review below the privacy floor", () => {
    let first;
    let inProgress;

    beforeAll(async () => {
      first = await submit(ids.members[0], "a", SECRET_ANSWER);
      inProgress = await submit(ids.members[3], "b", "not submitted yet", "in_progress");
    });

    it("returns the collecting state and no answers from the detail read", async () => {
      const { value } = await as("authenticated", staff(ids.adminA),
        "select public.get_organization_survey_review_detail($1) as value", [first]);
      expect(value).toMatchObject({
        sessionId: first, surveyId: ids.survey, available: false, state: "collecting",
        responseCount: 1, privacyMinResponses: 25, answers: [],
      });
      expect(JSON.stringify(value)).not.toContain(SECRET_ANSWER);
    });

    it("lists no review rows, state counts or response times on the staff snapshot", async () => {
      const survey = await snapshotSurvey(ids.adminA);
      expect(survey.reviewLane).toEqual({ state: "collecting", responseCount: 1, privacyMinResponses: 25 });
      expect(survey.reviews).toEqual([]);
      expect(survey.reviewCounts).toEqual({});
      expect(JSON.stringify(survey)).not.toContain(first);
      // The review row itself still exists; it is only withheld.
      expect(await reviewFor(first)).toBeTruthy();
    });

    it("refuses triage, and the report and export stay withheld", async () => {
      const review = await reviewFor(first);
      expect((await as("authenticated", staff(ids.adminA),
        "select public.update_organization_survey_review($1, 'follow_up') as value", [review])).code).toBe("55000");
      const report = await as("authenticated", staff(ids.adminA), "select public.get_organization_survey_report($1) as value", [ids.survey]);
      expect(report.value).toMatchObject({ available: false, responseCount: 1, questions: [] });
      const exported = await as("authenticated", staff(ids.adminA), "select public.export_organization_survey_results($1) as value", [ids.survey]);
      expect(exported.value.responses).toEqual([]);
      expect(JSON.stringify(exported.value)).not.toContain(SECRET_ANSWER);
    });

    it("never reads an unsubmitted session", async () => {
      expect((await as("authenticated", staff(ids.adminA),
        "select public.get_organization_survey_review_detail($1) as value", [inProgress])).code).toBe("P0002");
    });

    it("refuses another organization's staff without revealing the response exists", async () => {
      const review = await reviewFor(first);
      expect((await as("authenticated", staff(ids.adminB),
        "select public.get_organization_survey_review_detail($1) as value", [first])).code).toBe("P0002");
      expect((await as("authenticated", staff(ids.adminB),
        "select public.update_organization_survey_review($1, 'resolved') as value", [review])).code).toBe("P0002");
      const other = await as("authenticated", staff(ids.adminB), "select public.get_staff_engagement_snapshot() as value");
      expect(JSON.stringify(other.value)).not.toContain(ids.survey);
    });

    it("refuses a member who holds no staff role", async () => {
      expect((await as("authenticated", staff(ids.members[1]),
        "select public.get_organization_survey_review_detail($1) as value", [first])).code).toBe("42501");
    });
  });

  describe("survey review at the privacy floor", () => {
    let first;
    let review;

    beforeAll(async () => {
      first = (await client.query(
        "select id from public.organization_survey_sessions where survey_id=$1 and respondent_user_id=$2", [ids.survey, ids.members[0]],
      )).rows[0].id;
      await submit(ids.members[1], "b", "second");
      await submit(ids.members[2], "a", "third");
      // members[3] holds the in-progress session; 22 more reach 25 submitted.
      for (const member of ids.members.slice(4)) await submit(member, "a", "more");
      review = await reviewFor(first);
    });

    it("opens the detail read with the answers", async () => {
      const { value } = await as("authenticated", staff(ids.adminA),
        "select public.get_organization_survey_review_detail($1) as value", [first]);
      expect(value).toMatchObject({ available: true, state: "ready", responseCount: 25, privacyMinResponses: 25 });
      expect(value.answers.map((answer) => answer.value)).toEqual(["a", SECRET_ANSWER]);
    });

    it("lists the review lane on the staff snapshot", async () => {
      const survey = await snapshotSurvey(ids.adminA);
      expect(survey.reviewLane).toEqual({ state: "ready", responseCount: 25, privacyMinResponses: 25 });
      expect(survey.reviews).toHaveLength(25);
      expect(survey.reviewCounts).toEqual({ unreviewed: 25 });
    });

    it("lets staff triage and audits it, and the report and export open", async () => {
      const updated = await as("authenticated", staff(ids.adminA),
        "select public.update_organization_survey_review($1, 'follow_up', $2, 'Call back') as value", [review, ids.adminA]);
      expect(updated.value).toMatchObject({ id: review, state: "follow_up" });
      const { rows } = await client.query(
        "select event_type from public.organization_audit_events where organization_id=$1 and metadata->>'reviewId'=$2",
        [ids.orgA, review],
      );
      expect(rows.map((row) => row.event_type)).toEqual(["survey_response_review_updated"]);
      const report = await as("authenticated", staff(ids.adminA), "select public.get_organization_survey_report($1) as value", [ids.survey]);
      expect(report.value).toMatchObject({ available: true, responseCount: 25 });
      const exported = await as("authenticated", staff(ids.adminA), "select public.export_organization_survey_results($1) as value", [ids.survey]);
      expect(exported.value.responses).toHaveLength(25);
    });

    it("returns to collecting when staff raise the floor above the count", async () => {
      expect((await as("authenticated", staff(ids.adminA),
        "select public.set_organization_survey_privacy_floor($1, 30) as value", [ids.survey])).code).toBeUndefined();
      const { value } = await as("authenticated", staff(ids.adminA),
        "select public.get_organization_survey_review_detail($1) as value", [first]);
      expect(value).toMatchObject({ state: "collecting", responseCount: 25, privacyMinResponses: 30, answers: [] });
      const survey = await snapshotSurvey(ids.adminA);
      expect(survey.reviews).toEqual([]);
      expect(survey.reviewCounts).toEqual({});
    });
  });

  describe("password sign-in throttle", () => {
    const attempt = (email, network) => as("service_role", service,
      "select public.consume_password_signin_attempt($1, $2) as value", [email, network]);
    const unique = () => `${randomUUID().slice(0, 8)}@example.invalid`;
    let networkSeed = 0;
    const network = () => { networkSeed += 1; return `ipv4:198.51.${Math.floor(networkSeed / 250)}.${networkSeed % 250}`; };

    async function untilRefused(email, nextNetwork, cap = 40) {
      const answers = [];
      for (let index = 0; index < cap; index += 1) {
        const { value, code } = await attempt(email(), nextNetwork());
        expect(code).toBeUndefined();
        answers.push(value);
        if (value === false) break;
      }
      return answers;
    }

    it("allows five attempts per address an hour across networks, then refuses", async () => {
      const email = unique();
      const answers = await untilRefused(() => email, network);
      expect(answers).toEqual([true, true, true, true, true, false]);
      // Case and padding do not open a second bucket.
      expect((await attempt(`  ${email.toUpperCase()} `, network())).value).toBe(false);
    });

    it("allows twenty attempts per network an hour across addresses, then refuses", async () => {
      const shared = network();
      const answers = await untilRefused(unique, () => shared);
      expect(answers).toHaveLength(21);
      expect(answers.slice(0, 20).every(Boolean)).toBe(true);
      expect(answers[20]).toBe(false);
      // A refused network does not spend a fresh address's budget.
      const fresh = unique();
      expect((await attempt(fresh, shared)).value).toBe(false);
      expect((await untilRefused(() => fresh, network))).toHaveLength(6);
    });

    it("answers a real account's address and an unknown address identically", async () => {
      const real = `${ids.members[0]}@example.invalid`;
      const unknown = unique();
      const realAnswers = await untilRefused(() => real, network);
      const unknownAnswers = await untilRefused(() => unknown, network);
      expect(realAnswers).toEqual(unknownAnswers);
    });

    it("opens a new window once the hour has passed", async () => {
      const email = unique();
      await untilRefused(() => email, network);
      await client.query("update private.auth_attempt_throttle set window_started_at = window_started_at - interval '61 minutes' where scope = 'password-signin-email'");
      expect((await attempt(email, network())).value).toBe(true);
    });

    it("reads the limit from the platform setting definition", async () => {
      await client.query("savepoint lowered");
      await client.query("update public.platform_setting_definitions set default_value = '2' where key = 'limits.security.signin_attempts_per_email_hour'");
      const email = unique();
      expect(await untilRefused(() => email, network)).toEqual([true, true, false]);
      await client.query("rollback to savepoint lowered");
    });

    it("stores only keyed digests, never the address or the network", async () => {
      const email = unique();
      const shared = network();
      await attempt(email, shared);
      const { rows } = await client.query("select scope, key_hash from private.auth_attempt_throttle");
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(email);
      expect(dump).not.toContain(shared);
    });

    it("is reachable only through the service role", async () => {
      expect((await as("authenticated", staff(ids.adminA),
        "select public.consume_password_signin_attempt('x@example.invalid', 'unknown') as value")).code).toBe("42501");
      expect((await as("anon", { role: "anon" },
        "select public.consume_password_signin_attempt('x@example.invalid', 'unknown') as value")).code).toBe("42501");
      expect((await as("service_role", service,
        "select private.auth_attempt_check('password-signin-email', 'x', 5, interval '1 hour') as value")).code).toBe("42501");
      expect((await attempt("not-an-address", "unknown")).code).toBe("22023");
      expect((await attempt("x@example.invalid", "10.0.0.1")).code).toBe("22023");
    });

    it("refuses invalid generic throttle input", async () => {
      for (const sql of [
        "select private.auth_attempt_check('Bad Scope', 'k', 5, interval '1 hour') as value",
        "select private.auth_attempt_check('pin-signin', '', 5, interval '1 hour') as value",
        "select private.auth_attempt_check('pin-signin', 'k', 0, interval '1 hour') as value",
        "select private.auth_attempt_check('pin-signin', 'k', 5, interval '2 days') as value",
      ]) {
        expect((await as("postgres", {}, sql)).code).toBe("22023");
      }
      expect((await as("postgres", {}, "select private.auth_attempt_check('pin-signin', 'member-1', 1, interval '15 minutes') as value")).value).toBe(true);
      expect((await as("postgres", {}, "select private.auth_attempt_check('pin-signin', 'member-1', 1, interval '15 minutes') as value")).value).toBe(false);
    });

    it("keeps the sign-in limits platform-wide: an organization value is refused", async () => {
      const refused = await as("authenticated", staff(ids.adminA),
        "select public.update_organization_setting('limits.security.signin_attempts_per_email_hour', '50'::jsonb) as value");
      // The feature-switches inventory (20261002022000) marks these definitions
      // organization_editable = false, so the writer refuses them up front with
      // 42501 before the stored-value constraint (23514) is ever reached.
      expect(refused.code).toBe("42501");
      const config = await as("authenticated", staff(ids.adminA), "select public.get_admin_organization_configuration() as value");
      const listed = config.value.settings.filter((item) => item.key.startsWith("limits.security.signin_attempts_"));
      expect(listed.map((item) => [item.key, item.value, item.minimum, item.maximum])).toEqual([
        ["limits.security.signin_attempts_per_email_hour", 5, 1, 100],
        ["limits.security.signin_attempts_per_ip_hour", 20, 1, 1000],
      ]);
      expect((await as("postgres", {}, "select private.urgent_b_setting_limit(null, 'limits.security.nope') as value")).code).toBe("22023");
      expect((await as("postgres", {}, `select private.urgent_b_setting_limit('${ids.orgA}', 'security.failed_login_alert_threshold') as value`)).value).toBe(5);
    });
  });
});
