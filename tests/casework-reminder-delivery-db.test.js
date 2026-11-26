// @vitest-environment node
//
// BUG-UG-CASEWORK-REMINDERS-NEVER-FIRE-20260920
//
// Casework reminders stored remind_at and a recurrence that nothing read. The
// minute sweep private.casework_fire_due_reminders now notifies each due
// occurrence once, re-checks case access for the owner at fire time, carries
// no case detail in the notice, and never touches rows that predate it.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const migration = readFileSync(
  new URL("../supabase/migrations/20260924190100_casework_reminder_delivery.sql", import.meta.url),
  "utf8",
);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

const COPY = {
  en: { title: "A casework reminder is due", body: "Open Casework to review your reminders." },
  es: { title: "Tienes un recordatorio de caso pendiente", body: "Abre Casos para revisar tus recordatorios." },
};

describe("casework reminder delivery (static)", () => {
  it("schedules a bounded minute sweep and pins it in the database contract", () => {
    expect(migration).toContain(
      "perform cron.schedule('casework-reminder-delivery-tick', '* * * * *', 'select private.casework_fire_due_reminders(200)')",
    );
    expect(contract.cron).toContainEqual(expect.objectContaining({
      jobname: "casework-reminder-delivery-tick",
      schedule: "* * * * *",
      active: false,
      commandContains: ["private.casework_fire_due_reminders(200)"],
    }));
    expect(contract.cron.find((job) => job.jobname === "mi1-job-health-sync").commandContains)
      .toContain("select private.run_minute_cron_task('casework-reminder-delivery-tick'); commit;");
    const signatures = contract.functions.map((entry) => entry.sig);
    expect(signatures).toEqual(expect.arrayContaining([
      "private.casework_fire_due_reminders(p_limit integer)",
      "private.casework_reminder_owner_can_read(p_owner uuid, p_case_id uuid)",
      "private.casework_reminder_next_occurrence(p_remind_at timestamp with time zone, p_recurrence text, p_now timestamp with time zone)",
    ]));
    expect(contract.indexes.map((entry) => entry.name)).toContain("casework_reminders_fire_due_idx");
  });

  it("keeps the notice free of case detail in English and Spanish", () => {
    for (const [lang, copy] of Object.entries(COPY)) {
      expect(migration).toContain(`('casework.reminder.due', '${lang}', '${copy.title}', '${copy.body}')`);
    }
    expect(migration).toContain("private.notify_member(v_reminder.owner_user_id, 'casework.reminder.due', '{}'::jsonb, 'cases')");
  });

  it("never backfills or rewrites existing reminder rows", () => {
    const code = migration.replace(/--[^\n]*/g, "");
    // Top-level statements start at column 0; the sweep body is indented.
    expect(code).not.toMatch(/^update\s+public\.casework_reminders/im);
    expect(code).toContain("r.created_at >= (select e.delivers_from from private.casework_reminder_delivery_epoch e)");
  });

  it("is registered in the required database proof lane", () => {
    expect(PROOF_FILES).toContain("tests/casework-reminder-delivery-db.test.js");
  });
});

const ID = {
  org: "50902213-0000-4000-8000-000000000001",
  owner: "50902213-0000-4000-8000-000000000101",
  member: "50902213-0000-4000-8000-000000000102",
  steward2: "50902213-0000-4000-8000-000000000103",
  session: "50902213-0000-4000-8000-000000000201",
  case: "50902213-0000-4000-8000-000000000301",
  restrictedKept: "50902213-0000-4000-8000-000000000302",
  restrictedLost: "50902213-0000-4000-8000-000000000303",
};
const CHAPTER = "reminder-delivery-proof";
const CASE_REFERENCE = "REMINDER-DELIVERY-PROOF";
const CASE_TITLE = "Reminder delivery proof case";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("casework reminder delivery on a disposable database", () => {
  let db;

  async function sweep() {
    return (await db.query("select private.casework_fire_due_reminders(200) fired")).rows[0].fired;
  }

  async function notices(userId) {
    return (await db.query(
      "select title,body,kind from public.member_notifications where user_id=$1 and title = any($2::text[]) order by created_at,id",
      [userId, [COPY.en.title, COPY.es.title]],
    )).rows;
  }

  async function reminder(id) {
    return (await db.query(
      "select remind_at,recurrence,status,last_fired_at,updated_at from public.casework_reminders where id=$1",
      [id],
    )).rows[0];
  }

  async function insertReminder({ caseId = ID.case, owner = ID.owner, remindAt, recurrence = "none", title = "Call the member" }) {
    const id = randomUUID();
    await db.query(
      `insert into public.casework_reminders(id,case_id,organization_id,chapter_id,owner_user_id,title,remind_at,recurrence)
       values($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, caseId, ID.org, CHAPTER, owner, title, remindAt, recurrence],
    );
    return id;
  }

  const now = async () => (await db.query("select now() t")).rows[0].t;

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "casework-reminder-delivery-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '30s'");
    await db.query("set local lock_timeout = '15s'");
    // Only this proof's reminders are due inside the transaction.
    await db.query("update public.casework_reminders set status='dismissed' where status in ('scheduled','snoozed')");
    await db.query(
      `insert into auth.users(id,email) values
         ($1,'reminder-delivery-owner@example.invalid'),
         ($2,'reminder-delivery-member@example.invalid'),
         ($3,'reminder-delivery-steward2@example.invalid')`,
      [ID.owner, ID.member, ID.steward2],
    );
    await db.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,'reminder-delivery-proof-org','Reminder delivery proof',$2)",
      [ID.org, ID.owner],
    );
    await db.query(
      "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9922)",
      [CHAPTER, ID.org],
    );
    for (const userId of [ID.owner, ID.member, ID.steward2]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ID.org, userId]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [userId, CHAPTER]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [userId, CHAPTER]);
    }
    await db.query("update public.member_profiles set language='es' where id=$1", [ID.steward2]);
    for (const userId of [ID.owner, ID.steward2]) {
      await db.query(
        "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$2)",
        [ID.org, userId],
      );
    }
    await db.query(
      "insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())",
      [ID.session, ID.owner],
    );
    for (const userId of [ID.owner, ID.steward2]) {
      await db.query(
        `insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
         values(gen_random_uuid(),$1,'reminder-delivery-totp','totp','verified',now(),now())`,
        [userId],
      );
    }
    await db.query(
      `insert into public.member_cases(id,user_id,reference,title,case_type,step,status,steward_user_id)
       values($1,$2,$3,$4,'other','Intake','active',$5)`,
      [ID.case, ID.member, CASE_REFERENCE, CASE_TITLE, ID.owner],
    );
    // The restriction columns are seeded at INSERT; the restricted-field guard
    // only admits later changes from authorized staff.
    for (const [caseId, suffix] of [[ID.restrictedKept, "KEPT"], [ID.restrictedLost, "LOST"]]) {
      await db.query(
        `insert into public.member_cases(
           id,user_id,reference,title,case_type,step,status,steward_user_id,
           is_restricted,restriction_reason,restricted_at,restricted_by)
         values($1,$2,$3,$4,'other','Intake','active',$5,true,'Restricted reminder delivery proof',now(),$5)`,
        [caseId, ID.member, `${CASE_REFERENCE}-${suffix}`, `${CASE_TITLE} ${suffix}`, ID.steward2],
      );
    }

    // #8589 re-final: committed data gives every steward grant its migration

    // assignments; an organization grant reaches only chapters it has one in.

    await migrateLegacyStewardFixtures(db);
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("keeps the sweep and its access helper SECURITY DEFINER, postgres-owned and unreachable from clients", async () => {
    const rows = (await db.query(
      `select p.oid::regprocedure::text signature,p.prosecdef,r.rolname owner,
         has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
         has_function_privilege('anon',p.oid,'EXECUTE') anon
       from pg_catalog.pg_proc p join pg_catalog.pg_roles r on r.oid=p.proowner
       where p.oid=any($1::regprocedure[]) order by 1`,
      [["private.casework_fire_due_reminders(integer)", "private.casework_reminder_owner_can_read(uuid,uuid)"]],
    )).rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ prosecdef: true, owner: "postgres", authenticated: false, anon: false });
  });

  it("notifies the owner of a due one-off reminder exactly once, in their language, with no case detail", async () => {
    await db.query("savepoint owner_insert");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
      sub: ID.owner, role: "authenticated", session_id: ID.session, aal: "aal2",
    })]);
    await db.query("set local role authenticated");
    // The owner creates it through the journalled RPC (20261104123000).
    const { id } = (await db.query(
      "select (public.create_my_case_reminder($1,$2,now()-interval '5 minutes','none')).id",
      [ID.case, `Call ${CASE_REFERENCE} about the grievance`],
    )).rows[0];
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claims', '', true)");
    await db.query("release savepoint owner_insert");
    const before = await reminder(id);
    expect(before.last_fired_at).toBeNull();

    expect(await sweep()).toBe(1);
    const fired = await reminder(id);
    expect(fired.last_fired_at).toEqual(await now());
    expect(fired.remind_at).toEqual(before.remind_at);
    expect(fired.status).toBe("scheduled");
    const delivered = await notices(ID.owner);
    expect(delivered).toEqual([{ ...COPY.en, kind: "cases" }]);
    for (const text of [delivered[0].title, delivered[0].body]) {
      expect(text).not.toContain(CASE_REFERENCE);
      expect(text).not.toContain(CASE_TITLE);
      expect(text).not.toContain("grievance");
    }

    expect(await sweep()).toBe(0);
    expect(await notices(ID.owner)).toHaveLength(1);
    expect(await reminder(id)).toEqual(fired);
  });

  it("fires a due daily reminder once and schedules its next occurrence in the future", async () => {
    const id = await insertReminder({ remindAt: new Date(Date.now() - 60 * 60 * 1000), recurrence: "daily" });
    const before = await reminder(id);
    const baseline = (await notices(ID.owner)).length;
    expect(await sweep()).toBe(1);
    const after = await reminder(id);
    expect(after.last_fired_at).toEqual(await now());
    expect(after.remind_at.getTime()).toBe(before.remind_at.getTime() + 24 * 60 * 60 * 1000);
    expect(after.status).toBe("scheduled");
    expect(await sweep()).toBe(0);
    expect(await notices(ID.owner)).toHaveLength(baseline + 1);
  });

  it("collapses many missed weekly and monthly intervals into one notice and a future occurrence", async () => {
    const tick = await now();
    const weekly = await insertReminder({ remindAt: new Date(tick.getTime() - 400 * 24 * 60 * 60 * 1000), recurrence: "weekly" });
    // 10 AM Eastern, one set in winter (EST) and one in summer (EDT). Since
    // #8876 a monthly reminder steps on the Eastern wall clock, so each keeps
    // 10 AM Eastern whatever season its next occurrence falls in.
    const monthly = await insertReminder({ remindAt: new Date("2024-01-31T15:00:00Z"), recurrence: "monthly" });
    const monthlySummer = await insertReminder({ remindAt: new Date("2024-07-31T14:00:00Z"), recurrence: "monthly" });
    const baseline = (await notices(ID.owner)).length;
    const weeklyBefore = await reminder(weekly);

    expect(await sweep()).toBe(3);
    expect(await notices(ID.owner)).toHaveLength(baseline + 3);

    const weeklyAfter = await reminder(weekly);
    const week = 7 * 24 * 60 * 60 * 1000;
    expect(weeklyAfter.remind_at.getTime()).toBeGreaterThan(tick.getTime());
    expect(weeklyAfter.remind_at.getTime()).toBeLessThanOrEqual(tick.getTime() + week);
    expect((weeklyAfter.remind_at.getTime() - weeklyBefore.remind_at.getTime()) % week).toBe(0);

    for (const id of [monthly, monthlySummer]) {
      const monthlyAfter = await reminder(id);
      const { previous, hour } = (await db.query(
        `select ($1::timestamptz - interval '1 month') <= $2::timestamptz as previous,
                pg_catalog.date_part('hour', $1::timestamptz at time zone 'America/New_York')::int as hour`,
        [monthlyAfter.remind_at, tick],
      )).rows[0];
      expect(monthlyAfter.remind_at.getTime()).toBeGreaterThan(tick.getTime());
      expect(previous).toBe(true);
      expect(hour).toBe(10);
    }

    expect(await sweep()).toBe(0);
    expect(await notices(ID.owner)).toHaveLength(baseline + 3);
  });

  it("re-evaluates restricted-case access at fire time and notifies an owner who lost access of nothing", async () => {
    const due = new Date(Date.now() - 10 * 60 * 1000);
    const kept = await insertReminder({ caseId: ID.restrictedKept, owner: ID.steward2, remindAt: due });
    const lost = await insertReminder({ caseId: ID.restrictedLost, owner: ID.steward2, remindAt: due, recurrence: "weekly" });
    // Reassigned after the reminder was created: steward2 no longer reads the restricted case.
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    await db.query("update public.member_cases set steward_user_id=$2 where id=$1", [ID.restrictedLost, ID.owner]);
    await db.query("select set_config('request.jwt.claims', '', true)");
    const access = (await db.query(
      "select private.casework_reminder_owner_can_read($1,$2) kept, private.casework_reminder_owner_can_read($1,$3) lost",
      [ID.steward2, ID.restrictedKept, ID.restrictedLost],
    )).rows[0];
    expect(access).toEqual({ kept: true, lost: false });

    expect(await sweep()).toBe(1);
    expect(await notices(ID.steward2)).toEqual([{ ...COPY.es, kind: "cases" }]);
    expect((await reminder(kept)).last_fired_at).toEqual(await now());
    const consumed = await reminder(lost);
    expect(consumed.last_fired_at).toEqual(await now());
    expect(consumed.remind_at.getTime()).toBeGreaterThan((await now()).getTime());

    expect(await sweep()).toBe(0);
    expect(await notices(ID.steward2)).toHaveLength(1);
  });

  it("never fires, backfills or rewrites a reminder created before delivery existed", async () => {
    const id = randomUUID();
    await db.query(
      `insert into public.casework_reminders(id,case_id,organization_id,chapter_id,owner_user_id,title,remind_at,recurrence,created_at,updated_at)
       values($1,$2,$3,$4,$5,'Legacy reminder',now()-interval '3 days','daily',
         (select delivers_from - interval '1 day' from private.casework_reminder_delivery_epoch),
         (select delivers_from - interval '1 day' from private.casework_reminder_delivery_epoch))`,
      [id, ID.case, ID.org, CHAPTER, ID.owner],
    );
    const before = await reminder(id);
    const baseline = (await notices(ID.owner)).length;
    expect(await sweep()).toBe(0);
    expect(await reminder(id)).toEqual(before);
    expect(await notices(ID.owner)).toHaveLength(baseline);
  });
});
