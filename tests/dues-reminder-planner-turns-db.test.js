// @vitest-environment node
//
// BUG-UG-DUES-REMINDERS-STOP-AFTER-THE-500-OLDEST-DEBTS-20261122 (#9548).
// The daily dues reminder planner took the 500 oldest past-due obligations
// across every organization and only then dropped the ones already planned
// this month, so past 500 the same rows filled every run: newer debts and
// other organizations behind them were never planned. Here one organization
// owes 595 old obligations and a second owes 5 newer ones (600 in all). Two
// runs on one day at the cron's limit of 500 plan 500 and then 100; the first
// run already reaches the second organization; a third run, or a run on a
// later day of the month, plans nothing more and no obligation is planned
// twice; an obligation already reminded this month is skipped and takes no
// place in the limit; next month every obligation is due its reminder again.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const ID = {
  creator: "50909548-0000-4000-8000-000000000001",
  orgOld: "50909548-0000-4000-8000-0000000000a1",
  orgNew: "50909548-0000-4000-8000-0000000000b1",
  batchOld: "50909548-0000-4000-8000-0000000000a2",
  batchNew: "50909548-0000-4000-8000-0000000000b2",
};
const OLD_COUNT = 595;
const NEW_COUNT = 5;
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("the dues reminder planner reaches every past-due obligation, in turns across organizations", () => {
  let db;
  let today;
  let window;

  // One planner run as the cron calls it: the service role, the limit of 500.
  async function plan(day = today) {
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    await db.query("set local role service_role");
    const { rows: [row] } = await db.query("select public.plan_dues_reminder_attempts(500, $1::date) as n", [day]);
    // On an error the savepoint rollback also undoes the role.
    await db.query("reset role");
    return Number(row.n);
  }

  async function planned(organization, policyWindow = window) {
    const { rows: [row] } = await db.query(
      `select count(*)::integer as n, count(distinct obligation_id)::integer as distinct_n
       from public.dues_reminder_attempts
       where organization_id = $1 and policy_window = $2::date and channel = 'in_app'`,
      [organization, policyWindow],
    );
    return row;
  }

  async function rolledBack(body) {
    await db.query("savepoint dues_reminder_planner_turns");
    try {
      return await body();
    } finally {
      await db.query("rollback to savepoint dues_reminder_planner_turns");
      await db.query("release savepoint dues_reminder_planner_turns");
    }
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "dues-reminder-planner-turns-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    const { rows: [clock] } = await db.query(
      `select (now() at time zone 'America/New_York')::date::text as today,
              date_trunc('month', (now() at time zone 'America/New_York')::date)::date::text as month`,
    );
    today = clock.today;
    window = clock.month;
    // Whatever the database already holds that is due a reminder this month is
    // planned first, inside this rolled-back transaction, so every count below
    // is this proof's own obligations. Bounded: a planner that re-reads planned
    // rows returns 0 on its second run.
    for (let run = 0; run < 100 && (await plan()) > 0; run += 1);

    await db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,'dues-planner-turns@example.invalid','{}')", [ID.creator]);
    for (const [org, slug, name] of [
      [ID.orgOld, "dues-planner-turns-old", "Planner turns, long backlog"],
      [ID.orgNew, "dues-planner-turns-new", "Planner turns, newer debts"],
    ]) {
      await db.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$3,$4)", [org, slug, name, ID.creator]);
    }
    // The first organization's obligations are 61 to 90 days past due, every
    // one older than the second organization's, which are 5 days past due.
    for (const [org, batch, count, oldestDays, key] of [
      [ID.orgOld, ID.batchOld, OLD_COUNT, 90, "dues-planner-turns-batch-old"],
      [ID.orgNew, ID.batchNew, NEW_COUNT, 5, "dues-planner-turns-batch-new"],
    ]) {
      await db.query(`
        insert into public.dues_assessment_batches(id,organization_id,title,scope_kind,amount_cents,due_on,eligibility_fingerprint,idempotency_key,created_by)
        values ($1,$2,'Planner turns dues','organization',2500,$3::date - $4::integer,$5,$6,$7)
      `, [batch, org, today, oldestDays, "d".repeat(64), key, ID.creator]);
      await db.query(`
        with subjects as (
          insert into public.dues_member_subjects(organization_id)
          select $1 from generate_series(1, $3::integer)
          returning id
        ), numbered as (
          select id, row_number() over (order by id) as n from subjects
        )
        insert into public.dues_obligations(organization_id,batch_id,member_subject_id,issued_cents,due_on)
        select $1, $2, id, 2500, $4::date - $5::integer + ((n - 1) % 30)::integer
        from numbered
      `, [org, batch, count, today, oldestDays]);
    }
    const { rows: [seeded] } = await db.query(
      "select count(*)::integer as n from public.dues_obligations where organization_id = any($1::uuid[])",
      [[ID.orgOld, ID.orgNew]],
    );
    expect(seeded.n).toBe(OLD_COUNT + NEW_COUNT);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await db.query("rollback");
    await db.end();
  });

  it("plans 500 and then the other 100 of 600 on one day, reaching the second organization on the first run", async () => {
    const result = await rolledBack(async () => {
      const first = await plan();
      const afterFirst = { old: await planned(ID.orgOld), recent: await planned(ID.orgNew) };
      const second = await plan();
      const afterSecond = { old: await planned(ID.orgOld), recent: await planned(ID.orgNew) };
      return { first, afterFirst, second, afterSecond };
    });
    expect(result.first).toBe(500);
    // Each organization's oldest come first, in turns: all 5 newer debts make
    // the first run although 595 older ones belong to the other organization.
    expect(result.afterFirst.recent).toEqual({ n: NEW_COUNT, distinct_n: NEW_COUNT });
    expect(result.afterFirst.old).toEqual({ n: 500 - NEW_COUNT, distinct_n: 500 - NEW_COUNT });
    expect(result.second).toBe(100);
    expect(result.afterSecond.old).toEqual({ n: OLD_COUNT, distinct_n: OLD_COUNT });
    expect(result.afterSecond.recent).toEqual({ n: NEW_COUNT, distinct_n: NEW_COUNT });
  });

  it("plans nothing twice: a third run, and a run later in the month, add no attempt", async () => {
    const result = await rolledBack(async () => {
      const runs = [await plan(), await plan(), await plan()];
      const { rows: [later] } = await db.query(
        `select least($1::date + 1, (date_trunc('month', $1::date) + interval '1 month - 1 day')::date)::text as day`,
        [today],
      );
      // A later day can make other rows of the database due, so this run is
      // read only through this proof's two organizations below.
      await plan(later.day);
      const { rows: [repeats] } = await db.query(
        `select count(*)::integer as n from (
           select obligation_id from public.dues_reminder_attempts
           where organization_id = any($1::uuid[]) and policy_window = $2::date
           group by obligation_id having count(*) > 1
         ) twice`,
        [[ID.orgOld, ID.orgNew], window],
      );
      return { runs, repeats: repeats.n, old: await planned(ID.orgOld), recent: await planned(ID.orgNew) };
    });
    expect(result.runs).toEqual([500, 100, 0]);
    expect(result.repeats).toBe(0);
    expect(result.old).toEqual({ n: OLD_COUNT, distinct_n: OLD_COUNT });
    expect(result.recent).toEqual({ n: NEW_COUNT, distinct_n: NEW_COUNT });
  });

  it("skips an obligation already reminded this month without spending a place in the limit", async () => {
    const result = await rolledBack(async () => {
      const { rows: [oldest] } = await db.query(
        `select id from public.dues_obligations where organization_id = $1 order by due_on, id limit 1`,
        [ID.orgOld],
      );
      await db.query(
        `insert into public.dues_reminder_attempts(organization_id,obligation_id,policy_window,channel,state)
         values ($1,$2,$3::date,'in_app','sent')`,
        [ID.orgOld, oldest.id, window],
      );
      const first = await plan();
      const second = await plan();
      const { rows: attempts } = await db.query(
        `select state from public.dues_reminder_attempts
         where organization_id = $1 and obligation_id = $2 and policy_window = $3::date`,
        [ID.orgOld, oldest.id, window],
      );
      return { first, second, attempts, old: await planned(ID.orgOld) };
    });
    expect(result.first).toBe(500);
    expect(result.second).toBe(OLD_COUNT + NEW_COUNT - 1 - 500);
    expect(result.attempts).toEqual([{ state: "sent" }]);
    expect(result.old).toEqual({ n: OLD_COUNT, distinct_n: OLD_COUNT });
  });

  it("starts every obligation over next month, the second organization's in the first run", async () => {
    const result = await rolledBack(async () => {
      await plan();
      await plan();
      const { rows: [next] } = await db.query(
        "select (date_trunc('month', $1::date) + interval '1 month')::date::text as day",
        [today],
      );
      // Whatever else the database holds is due again next month too, so this
      // reads only the two organizations of this proof.
      await plan(next.day);
      return { recent: await planned(ID.orgNew, next.day), old: await planned(ID.orgOld, next.day) };
    });
    expect(result.recent).toEqual({ n: NEW_COUNT, distinct_n: NEW_COUNT });
    expect(result.old.n).toBeGreaterThan(0);
    expect(result.old.n).toBe(result.old.distinct_n);
  });
});
