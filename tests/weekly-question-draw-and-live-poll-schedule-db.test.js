// @vitest-environment node
//
// REQ-UG-WEEKLY-QUESTION-PRIORITY-AND-WEIGHTED-DRAW-20261001 (CR-012/CR-013)
// REQ-UG-LIVE-POLL-SCHEDULED-OPEN-CLOSE-20261001 (CR-015)
//
// On a disposable database: a promoted question takes the priority slot ahead
// of the draw; the weighted draw is reproducible from its recorded seed and
// honors support weight; the priority switch refuses promotion and is ignored
// by the draw when off; the live-poll scheduler opens and closes polls on
// time, recalculates after-close results, audits, and respects its switch.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";

const MIGRATION = "supabase/migrations/20261002101000_weekly_question_draw_and_live_poll_schedule.sql";
const migration = readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8");
const PRIORITY = "features.engagement_voice.weekly_question_priority_slot";
const AUTO = "features.engagement_voice.live_poll_auto_open_close";

describe("weekly draw and live poll schedule (static)", () => {
  it("registers both switches ON, gates every writer and schedules the minute sweep", () => {
    expect(migration).toMatch(/\nbegin;\n/);
    expect(migration.trimEnd()).toMatch(/\ncommit;$/);
    for (const key of [PRIORITY, AUTO]) expect(migration).toContain(`('${key}', 'boolean'`);
    expect(migration.match(/'true', null, null, null, \d+, 'engagement_voice', true\)/g)).toHaveLength(2);
    for (const name of [
      "private.reserve_weekly_questions", "public.promote_weekly_question",
      "public.save_weekly_question_selection_policy", "public.run_weekly_question_selection",
      "private.run_due_weekly_question_selections", "private.run_due_live_poll_transitions",
    ]) {
      const fn = parseFunctions(migration, MIGRATION).find((entry) => entry.name === name);
      expect(fn, name).toBeTruthy();
      expect(helperFirst(fn.source), name).toBe(true);
    }
    expect(stripComments(migration)).toContain("'live-poll-schedule-tick',\n      '* * * * *',\n      $job$select private.run_due_live_poll_transitions(200);$job$");
    expect(stripComments(migration)).toMatch(/revoke all on function private\.run_due_live_poll_transitions\(integer\)\s+from public, anon, authenticated, service_role;/);
  });
});

const ID = {
  org: "51002101-0000-4000-8000-000000000001",
  staff: "51002101-0000-4000-8000-000000000101",
  member: "51002101-0000-4000-8000-000000000102",
  other: "51002101-0000-4000-8000-000000000103",
  staffSession: "51002101-0000-4000-8000-000000000201",
  memberSession: "51002101-0000-4000-8000-000000000202",
  otherSession: "51002101-0000-4000-8000-000000000203",
  grant: "51002101-0000-4000-8000-000000000301",
};
const CHAPTER = "weekly-draw-chapter";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("weekly draw and live poll schedule on a disposable database", () => {
  let db;
  let week;

  async function as(userId, sessionId, statement, values = []) {
    await db.query("savepoint l1_polls");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: userId, role: "authenticated", session_id: sessionId, aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const result = await db.query(statement, values);
      await db.query("reset role");
      await db.query("release savepoint l1_polls");
      return { code: "", rows: result.rows, message: "" };
    } catch (error) {
      await db.query("rollback to savepoint l1_polls");
      await db.query("reset role").catch(() => {});
      return { code: error.code || "?", rows: [], message: error.message || "" };
    }
  }

  async function scoped(work) {
    await db.query("savepoint l1_scope");
    try { return await work(); } finally { await db.query("rollback to savepoint l1_scope"); }
  }

  let authorCount = 0;
  async function author() {
    authorCount += 1;
    return (await db.query("insert into auth.users(id,email) values (gen_random_uuid(), $1) returning id", [`weekly-draw-author-${authorCount}@example.invalid`])).rows[0].id;
  }

  // One question per author per week (unique user_id, week_start).
  async function question(body, userId, createdAt) {
    return (await db.query(
      `insert into public.member_weekly_questions(user_id, chapter_id, body, week_start, options, editorial_state, created_at)
       values ($1,$2,$3,$4,'["Yes","No"]'::jsonb,'submitted',$5) returning id`,
      [userId ?? await author(), CHAPTER, body, week, createdAt],
    )).rows[0].id;
  }

  async function grantPriority() {
    await db.query(
      `insert into public.member_reward_grants(id, organization_id, user_id, item_key, status, source, granted_by)
       values ($1,$2,$3,'priority-wq-slot','granted','admin_grant',$4)`,
      [ID.grant, ID.org, ID.member, ID.staff],
    );
  }

  async function support(questionId, count) {
    for (let index = 0; index < count; index += 1) {
      const userId = (await db.query("insert into auth.users(id,email) values (gen_random_uuid(), $1) returning id", [`weekly-draw-supporter-${questionId}-${index}@example.invalid`])).rows[0].id;
      await db.query("insert into public.member_weekly_question_supports(question_id, user_id) values ($1,$2)", [questionId, userId]);
    }
  }

  async function policy(rule, count = 1) {
    await db.query(
      `insert into public.weekly_question_selection_policies(organization_id, chapter_id, enabled, cadence_days, minimum_pool_size, selection_count, priority_rule, next_run_at, updated_by)
       values ($1,$2,true,7,$3,$3,$4,now() - interval '1 minute',$5)
       on conflict (organization_id, chapter_id) do update set priority_rule = excluded.priority_rule, selection_count = excluded.selection_count,
         minimum_pool_size = excluded.minimum_pool_size, next_run_at = excluded.next_run_at, enabled = true`,
      [ID.org, CHAPTER, count, rule, ID.staff],
    );
  }

  const reserved = async () => (await db.query(
    "select id from public.member_weekly_questions where chapter_id = $1 and editorial_state = 'reserved' order by id",
    [CHAPTER],
  )).rows.map((row) => row.id);

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "weekly-draw-live-poll-schedule-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    // The current week is the Eastern week since #8876, as the weekly question
    // functions read it.
    week = (await db.query("select pg_catalog.date_trunc('week', private.eastern_day()::timestamp)::date::text as week")).rows[0].week;
    await db.query(
      `insert into auth.users (id,email) values ($1,'weekly-draw-staff@example.invalid'),
        ($2,'weekly-draw-member@example.invalid'),($3,'weekly-draw-other@example.invalid')`,
      [ID.staff, ID.member, ID.other],
    );
    await db.query("insert into public.organizations(id,slug,name,created_by) values($1,'weekly-draw-org','Weekly draw proof org',$2)", [ID.org, ID.staff]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,92111)", [CHAPTER, ID.org]);
    for (const userId of [ID.staff, ID.member, ID.other]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ID.org, userId]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [userId, CHAPTER]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [userId, CHAPTER]);
    }
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$2)", [ID.org, ID.staff]);
    await db.query(
      `insert into auth.sessions(id,user_id,aal,created_at,updated_at) values
        ($1,$2,'aal2',now(),now()),($3,$4,'aal2',now(),now()),($5,$6,'aal2',now(),now())`,
      [ID.staffSession, ID.staff, ID.memberSession, ID.member, ID.otherSession, ID.other],
    );
    await db.query(
      `insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
       values (gen_random_uuid(),$1,'s','totp','verified',now(),now()),(gen_random_uuid(),$2,'m','totp','verified',now(),now()),
              (gen_random_uuid(),$3,'o','totp','verified',now(),now())`,
      [ID.staff, ID.member, ID.other],
    );
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("registers both switches ON for the engagement category", async () => {
    const rows = (await db.query(
      "select key, default_value, category, member_visible from public.platform_setting_definitions where key = any($1) order by key",
      [[PRIORITY, AUTO]],
    )).rows;
    expect(rows).toEqual([
      { key: AUTO, default_value: true, category: "engagement_voice", member_visible: true },
      { key: PRIORITY, default_value: true, category: "engagement_voice", member_visible: true },
    ]);
    expect((await db.query("select column_default from information_schema.columns where table_schema='public' and table_name='weekly_question_selection_policies' and column_name='priority_rule'")).rows[0].column_default).toContain("weighted_random");
  });

  it("the weighted draw is reproducible from its seed and support adds weight", async () => {
    const seed = "51002101-aaaa-4000-8000-000000000001";
    const keys = (await db.query(
      `select private.weekly_question_draw_key($1, $2, 1) as light, private.weekly_question_draw_key($1, $2, 9) as heavy,
              private.weekly_question_draw_key($1, $2, 1) as again`,
      [seed, ID.grant],
    )).rows[0];
    expect(keys.light).toBe(keys.again);
    expect(keys.light).toBeLessThan(0);
    // ln(u)/w moves toward zero as w grows, so heavier questions sort first.
    expect(keys.heavy).toBeGreaterThan(keys.light);
    // Over many seeds a 9x-weighted question wins most two-way draws.
    const share = (await db.query(
      `select avg(case when private.weekly_question_draw_key(s, $1, 10) > private.weekly_question_draw_key(s, $2, 1) then 1 else 0 end)::float as share
       from (select gen_random_uuid() s from generate_series(1, 400)) seeds`,
      [ID.grant, ID.org],
    )).rows[0].share;
    expect(share).toBeGreaterThan(0.75);
  });

  it("a promoted question takes the priority slot ahead of a heavily supported one", async () => {
    await scoped(async () => {
      const promoted = await question("Promoted question", ID.member, "2026-01-02T00:00:00Z");
      const popular = await question("Popular question", null, "2026-01-01T00:00:00Z");
      await support(popular, 6);
      await grantPriority();
      const promote = await as(ID.member, ID.memberSession, "select public.promote_weekly_question($1) result", [promoted]);
      expect(promote, promote.message).toMatchObject({ code: "" });
      expect(promote.rows[0].result).toMatchObject({ promoted: true });
      await policy("support_then_oldest", 1);
      const run = await as(ID.staff, ID.staffSession, "select public.run_weekly_question_selection(gen_random_uuid()) result");
      expect(run, run.message).toMatchObject({ code: "" });
      expect(run.rows[0].result).toMatchObject({ selectedCount: 1, priorityIds: [promoted], rule: "support_then_oldest" });
      expect(await reserved()).toEqual([promoted]);
      const audit = (await db.query(
        "select metadata from public.organization_audit_events where organization_id = $1 and event_type = 'weekly_question_selection_run' order by created_at desc limit 1",
        [ID.org],
      )).rows[0].metadata;
      expect(audit).toMatchObject({ reasonCode: "manual", kind: "support_then_oldest", runId: run.rows[0].result.seed });
    });
  });

  it("with the priority slot off, promotion is refused before a reward is spent and the draw ignores promotions", async () => {
    await scoped(async () => {
      const mine = await question("My question", ID.member, "2026-01-02T00:00:00Z");
      const popular = await question("Popular question", null, "2026-01-01T00:00:00Z");
      await support(popular, 3);
      await db.query("insert into public.organization_setting_values(organization_id, setting_key, value, updated_by) values ($1,$2,'false'::jsonb,$3)", [ID.org, PRIORITY, ID.staff]);
      const refused = await as(ID.member, ID.memberSession, "select public.promote_weekly_question($1) result", [mine]);
      expect(refused.code).toBe("55000");
      const listed = await as(ID.member, ID.memberSession, "select public.list_weekly_questions() result");
      expect(listed, listed.message).toMatchObject({ code: "" });
      expect(listed.rows[0].result.every((item) => item.promotionAvailable === false)).toBe(true);
      // A promotion recorded before the switch was turned off no longer wins.
      await grantPriority();
      await db.query("insert into public.member_weekly_question_promotions(question_id, reward_grant_id, organization_id, chapter_id, user_id) values ($1,$2,$3,$4,$5)", [mine, ID.grant, ID.org, CHAPTER, ID.member]);
      await policy("support_then_oldest", 1);
      const run = await as(ID.staff, ID.staffSession, "select public.run_weekly_question_selection(gen_random_uuid()) result");
      expect(run, run.message).toMatchObject({ code: "" });
      expect(run.rows[0].result).toMatchObject({ priorityIds: [], prioritySlot: false });
      expect(await reserved()).toEqual([popular]);
    });
  });

  it("the scheduled run draws by weighted random with a recorded seed that reproduces the order", async () => {
    await scoped(async () => {
      const ids = [];
      for (let index = 0; index < 5; index += 1) {
        const id = await question(`Pool question number ${index}`, null, `2026-01-0${index + 1}T00:00:00Z`);
        await support(id, index);
        ids.push(id);
      }
      await policy("weighted_random", 2);
      const tick = (await db.query("select private.run_due_weekly_question_selections(25) result")).rows[0].result;
      expect(tick).toMatchObject({ processed: 1, reserved: 2 });
      const last = (await db.query("select last_result from public.weekly_question_selection_policies where organization_id = $1 and chapter_id = $2", [ID.org, CHAPTER])).rows[0].last_result;
      expect(last).toMatchObject({ rule: "weighted_random", mode: "scheduled", selectedCount: 2 });
      const expected = (await db.query(
        `select q.id from public.member_weekly_questions q
         where q.id = any($2::uuid[])
         order by private.weekly_question_draw_key($1, q.id, 1 + (select count(*)::integer from public.member_weekly_question_supports s where s.question_id = q.id)) desc, q.id
         limit 2`,
        [last.seed, ids],
      )).rows.map((row) => row.id).sort();
      expect(await reserved()).toEqual(expected);
      const policyRefusal = await as(ID.staff, ID.staffSession, "select public.save_weekly_question_selection_policy(true, 7, 3, 1, 'most_recent', null)");
      expect(policyRefusal.code).toBe("22023");
      const saved = await as(ID.staff, ID.staffSession, "select public.save_weekly_question_selection_policy(true, 7, 3, 1, 'weighted_random', null) result");
      expect(saved, saved.message).toMatchObject({ code: "" });
      expect(saved.rows[0].result.policy).toMatchObject({ priority_rule: "weighted_random" });
    });
  });

  describe("live poll schedule", () => {
    async function poll(state, opensAt, closesAt, visibility = "after_close") {
      const id = (await db.query(
        `insert into public.organization_live_polls(organization_id, title, state, eligibility, results_visibility, opens_at, closes_at, created_by)
         values ($1,'Scheduled vote',$2,'organization',$3,$4,$5,$6) returning id`,
        [ID.org, state, visibility, opensAt, closesAt, ID.staff],
      )).rows[0].id;
      await db.query("insert into public.organization_live_poll_options(organization_id, poll_id, label, sort_index) values ($1,$2,'Yes',0),($1,$2,'No',1)", [ID.org, id]);
      return id;
    }
    const stateOf = async (id) => (await db.query("select state, closed_at is not null as closed, opens_at, result_cache from public.organization_live_polls where id = $1", [id])).rows[0];

    it("opens a due scheduled poll, closes an expired open poll, and leaves future polls alone", async () => {
      await scoped(async () => {
        const due = await poll("scheduled", new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString());
        const future = await poll("scheduled", new Date(Date.now() + 3_600_000).toISOString(), new Date(Date.now() + 7_200_000).toISOString());
        const expired = await poll("open", new Date(Date.now() - 7_200_000).toISOString(), new Date(Date.now() - 60_000).toISOString());
        const missed = await poll("scheduled", new Date(Date.now() - 7_200_000).toISOString(), new Date(Date.now() - 3_600_000).toISOString());
        const optionId = (await db.query("select id from public.organization_live_poll_options where poll_id = $1 and sort_index = 0", [expired])).rows[0].id;
        await db.query("insert into public.organization_live_poll_votes(organization_id, poll_id, option_id, voter_user_id) values ($1,$2,$3,$4)", [ID.org, expired, optionId, ID.member]);
        const tick = (await db.query("select private.run_due_live_poll_transitions(200) result")).rows[0].result;
        expect(tick).toEqual({ opened: 1, closed: 2 });
        expect(await stateOf(due)).toMatchObject({ state: "open", closed: false });
        expect(await stateOf(future)).toMatchObject({ state: "scheduled" });
        const closed = await stateOf(expired);
        expect(closed).toMatchObject({ state: "closed", closed: true });
        // after_close results publish once the scheduler closes the poll.
        expect(closed.result_cache).toEqual([expect.objectContaining({ label: "Yes", votes: 1 }), expect.objectContaining({ label: "No", votes: 0 })]);
        expect(await stateOf(missed)).toMatchObject({ state: "closed", closed: true });
        const audits = (await db.query(
          "select metadata ->> 'action' as action, metadata ->> 'reasonCode' as reason from public.organization_audit_events where organization_id = $1 and event_type = 'live_poll_transitioned' order by created_at",
          [ID.org],
        )).rows;
        expect(audits.filter((row) => row.reason === "scheduled")).toHaveLength(3);
        expect((await db.query("select private.run_due_live_poll_transitions(200) result")).rows[0].result).toEqual({ opened: 0, closed: 0 });
      });
    });

    it("leaves polls for manual control when the organization switch is off", async () => {
      await scoped(async () => {
        await db.query("insert into public.organization_setting_values(organization_id, setting_key, value, updated_by) values ($1,$2,'false'::jsonb,$3)", [ID.org, AUTO, ID.staff]);
        const due = await poll("scheduled", new Date(Date.now() - 60_000).toISOString(), null);
        expect((await db.query("select private.run_due_live_poll_transitions(200) result")).rows[0].result).toEqual({ opened: 0, closed: 0 });
        expect(await stateOf(due)).toMatchObject({ state: "scheduled" });
      });
    });

    it("dispatches the minute task through the shared backend", async () => {
      const job = (await db.query("select schedule, command, active from cron.job where jobname = 'live-poll-schedule-tick'")).rows;
      expect(job).toEqual([{ schedule: "* * * * *", command: "select private.run_due_live_poll_transitions(200);", active: false }]);
      const dispatcher = (await db.query("select active, command from cron.job where jobname = 'mi1-job-health-sync'")).rows[0];
      expect(dispatcher.active).toBe(true);
      expect(dispatcher.command).toContain("select private.run_minute_cron_task('live-poll-schedule-tick'); commit;");
    });
  });
});
