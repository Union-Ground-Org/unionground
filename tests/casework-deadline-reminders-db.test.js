// @vitest-environment node
//
// BUG-UG-CASEWORK-DEADLINE-REMINDER-AT-NEVER-FIRES-20261001 (CR-023)
//
// The Deadline center collected "Reminder (optional)" into
// casework_deadlines.reminder_at and nothing read it, and no passed deadline
// ever became 'missed'. The minute sweep now delivers each reminder once with
// case-free copy to the creator and the assigned staff, consumes a stale one
// silently, marks passed unmet deadlines missed after the organization's grace
// hours with an audit row, and staff can record met / waived / reopen.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const migration = readFileSync(
  new URL("../supabase/migrations/20261002143000_casework_deadline_reminders_missed.sql", import.meta.url),
  "utf8",
);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("casework deadline reminders and missed marking (static)", () => {
  it("registers both switches ON and the grace limit at 0, and never rewrites existing rows at apply", () => {
    expect(migration).toMatch(/\('features\.casework\.deadline_reminders', 'boolean',[\s\S]*?'true', null, null, null, 1500, 'casework', false\)/);
    expect(migration).toMatch(/\('features\.casework\.mark_missed_deadlines', 'boolean',[\s\S]*?'true', null, null, null, 1510, 'casework', true\)/);
    expect(migration).toMatch(/\('limits\.casework\.deadline_missed_grace_hours', 'integer',[\s\S]*?'0', 0, 168, null, 1520, 'casework', false\)/);
    const code = migration.replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(/^update\s+public\.casework_deadlines/im);
  });

  it("schedules the minute sweep and pins it in the database contract", () => {
    expect(migration).toContain(
      "perform cron.schedule('casework-deadline-reminder-tick', '* * * * *', 'select private.casework_sweep_deadline_reminders(200)')",
    );
    expect(contract.cron).toContainEqual(expect.objectContaining({
      jobname: "casework-deadline-reminder-tick",
      commandContains: ["private.casework_sweep_deadline_reminders(200)"],
    }));
    expect(contract.functions.map((entry) => entry.sig)).toEqual(expect.arrayContaining([
      "private.casework_sweep_deadline_reminders(p_limit integer)",
      "public.casework_set_deadline_status(p_deadline_id uuid, p_status text)",
    ]));
  });

  it("is registered in the required database proof lane", () => {
    expect(PROOF_FILES).toContain("tests/casework-deadline-reminders-db.test.js");
  });
});

const ID = {
  org: "50902216-0000-4000-8000-000000000001",
  steward: "50902216-0000-4000-8000-000000000101",
  coordinator: "50902216-0000-4000-8000-000000000102",
  member: "50902216-0000-4000-8000-000000000103",
  case: "50902216-0000-4000-8000-000000000301",
};
const SESSION = {
  [ID.steward]: "50902216-0000-4000-8000-000000000201",
  [ID.coordinator]: "50902216-0000-4000-8000-000000000202",
  [ID.member]: "50902216-0000-4000-8000-000000000203",
};
// Holds no membership, so no case access: a reminder addressed only to them
// has no eligible recipient.
const OUTSIDER = "50902216-0000-4000-8000-000000000204";
const CHAPTER = "deadline-reminder-proof";
const REFERENCE = "DEADLINE-REMINDER-PROOF";
const LABEL = "Step 2 response from the director";
const COPY = {
  en: { title: "A case deadline reminder is due", body: "Open Casework to review the deadline on your case list." },
  es: { title: "Tienes un recordatorio de plazo de caso", body: "Abre Casos para revisar el plazo en tu lista de casos." },
};
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("casework deadline reminders and missed marking on a disposable database", () => {
  let db;

  async function as(userId, sql, params = []) {
    await db.query("savepoint as_user");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: userId, role: "authenticated", session_id: SESSION[userId], aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const rows = (await db.query(sql, params)).rows;
      await db.query("reset role");
      await db.query("select set_config('request.jwt.claims', '', true)");
      await db.query("release savepoint as_user");
      return rows;
    } catch (error) {
      await db.query("rollback to savepoint as_user");
      await db.query("reset role");
      await db.query("select set_config('request.jwt.claims', '', true)");
      throw error;
    }
  }
  const sweep = async () => (await db.query("select private.casework_sweep_deadline_reminders(200) n")).rows[0].n;
  const notices = async (userId) => (await db.query(
    "select id, title, body, kind from public.member_notifications where user_id = $1 and title = any($2::text[])",
    [userId, [COPY.en.title, COPY.es.title]],
  )).rows;
  const deadline = async (id) => (await db.query(
    "select status, reminder_disposition as disposition, reminder_sent_at is not null as sent from public.casework_deadlines where id = $1", [id],
  )).rows[0];
  const insertDeadline = async ({ due, reminder = null, status = "active", createdBy = ID.steward }) => (await db.query(
    `insert into public.casework_deadlines(case_id, organization_id, chapter_id, kind, label, due_at, status, reminder_at, created_by)
     values ($1, $2, $3, 'response', $4, now() + $5::interval, $6, case when $7::text is null then null else now() + $7::interval end, $8)
     returning id`,
    [ID.case, ID.org, CHAPTER, LABEL, due, status, reminder, createdBy],
  )).rows[0].id;
  const setSetting = (key, value) => db.query(
    `insert into public.organization_setting_values(organization_id, setting_key, value) values ($1, $2, $3::jsonb)
     on conflict (organization_id, setting_key) do update set value = excluded.value`,
    [ID.org, key, JSON.stringify(value)],
  );
  const clearSetting = (key) => db.query(
    "delete from public.organization_setting_values where organization_id = $1 and setting_key = $2", [ID.org, key],
  );

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "casework-deadline-reminders-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    // Only this proof's deadlines are due or passed inside the transaction.
    await db.query("update public.casework_deadlines set reminder_disposition = 'expired' where reminder_disposition is null and reminder_at is not null");
    await db.query("update public.casework_deadlines set status = 'met' where status in ('active', 'extended') and due_at < now() + interval '30 days'");
    await db.query("insert into auth.users(id, email) values ($1, 'deadline-outsider@example.invalid')", [OUTSIDER]);
    for (const id of [ID.steward, ID.coordinator, ID.member]) {
      await db.query("insert into auth.users(id, email) values ($1, $2)", [id, `deadline-${id.slice(-3)}@example.invalid`]);
      await db.query("insert into auth.sessions(id, user_id, aal, created_at, updated_at) values ($1, $2, 'aal2', now(), now())", [SESSION[id], id]);
      await db.query(
        `insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, created_at, updated_at)
         values (gen_random_uuid(), $1, 'deadline-proof-totp', 'totp', 'verified', now(), now())`,
        [id],
      );
    }
    await db.query(
      "insert into public.organizations(id, slug, name, created_by) values ($1, 'deadline-reminder-proof-org', 'Deadline reminder proof', $2)",
      [ID.org, ID.steward],
    );
    await db.query(
      "insert into public.chapters(id, name, slug, organization_id, is_default, order_index) values ($1, $1, $1, $2, false, 9925)",
      [CHAPTER, ID.org],
    );
    for (const id of [ID.steward, ID.coordinator, ID.member]) {
      await db.query("insert into public.organization_memberships(organization_id, user_id, status) values ($1, $2, 'active')", [ID.org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id, chapter_id, status) values ($1, $2, 'active')", [id, CHAPTER]);
      await db.query("update public.member_profiles set chapter_id = $2 where id = $1", [id, CHAPTER]);
    }
    await db.query("update public.member_profiles set language = 'es' where id = $1", [ID.coordinator]);
    await db.query(
      "insert into public.organization_role_grants(organization_id, user_id, role, granted_by) values ($1, $2, 'steward', $2), ($1, $3, 'coordinator', $2)",
      [ID.org, ID.steward, ID.coordinator],
    );
    await db.query(
      `insert into public.member_cases(id, user_id, reference, title, case_type, step, status, steward_user_id, coordinator_user_id)
       values ($1, $2, $3, 'Deadline reminder proof case', 'other', 'Intake', 'active', $4, $5)`,
      [ID.case, ID.member, REFERENCE, ID.steward, ID.coordinator],
    );

    // #8589 re-final: committed data gives every steward grant its migration

    // assignments; an organization grant reaches only chapters it has one in.

    await migrateLegacyStewardFixtures(db);
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("keeps the sweep internal and the status routine narrowly granted", async () => {
    const rows = (await db.query(
      `select p.oid::regprocedure::text signature, p.prosecdef,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') authenticated,
         has_function_privilege('anon', p.oid, 'EXECUTE') anon
       from pg_catalog.pg_proc p where p.oid = any($1::regprocedure[]) order by 1`,
      [["private.casework_sweep_deadline_reminders(integer)", "public.casework_set_deadline_status(uuid,text)"]],
    )).rows;
    expect(rows).toEqual([
      { signature: "casework_set_deadline_status(uuid,text)", prosecdef: true, authenticated: true, anon: false },
      { signature: "private.casework_sweep_deadline_reminders(integer)", prosecdef: true, authenticated: false, anon: false },
    ]);
  });

  it("delivers a due reminder once to the creator and the assigned staff, in their language, without case detail", async () => {
    const id = await insertDeadline({ due: "2 days", reminder: "-5 minutes" });
    const stewardBefore = await notices(ID.steward);
    const coordinatorBefore = await notices(ID.coordinator);
    expect(await sweep()).toBe(2);
    const steward = (await notices(ID.steward)).filter((row) => !stewardBefore.some((old) => old.id === row.id));
    const coordinator = (await notices(ID.coordinator)).filter((row) => !coordinatorBefore.some((old) => old.id === row.id));
    expect(steward.map(({ title, body, kind }) => ({ title, body, kind }))).toEqual([{ ...COPY.en, kind: "deadlines" }]);
    expect(coordinator.map(({ title, body, kind }) => ({ title, body, kind }))).toEqual([{ ...COPY.es, kind: "deadlines" }]);
    for (const row of [...steward, ...coordinator]) {
      for (const text of [row.title, row.body]) {
        expect(text).not.toContain(REFERENCE);
        expect(text).not.toContain(LABEL);
      }
    }
    expect(await notices(ID.member)).toEqual([]);
    expect(await deadline(id)).toEqual({ status: "active", disposition: "sent", sent: true });
    expect(await sweep()).toBe(0);
  });

  it("records a stale reminder expired, never sent, and sends no notice", async () => {
    const id = await insertDeadline({ due: "3 days", reminder: "-2 days" });
    const before = (await notices(ID.steward)).length;
    expect(await sweep()).toBe(0);
    expect(await deadline(id)).toEqual({ status: "active", disposition: "expired", sent: false });
    expect((await notices(ID.steward)).length).toBe(before);
  });

  it("records a fresh reminder on an already passed deadline expired, not sent", async () => {
    const id = await insertDeadline({ due: "-1 minute", reminder: "-5 minutes" });
    const before = (await notices(ID.steward)).length;
    await sweep();
    expect(await deadline(id)).toMatchObject({ disposition: "expired", sent: false });
    expect((await notices(ID.steward)).length).toBe(before);
    await db.query("update public.casework_deadlines set status = 'waived' where id = $1", [id]);
  });

  it("records a reminder that went stale while switched off as suppressed, not sent", async () => {
    await setSetting("features.casework.deadline_reminders", false);
    const id = await insertDeadline({ due: "5 days", reminder: "-30 hours" });
    expect(await sweep()).toBe(0);
    expect(await deadline(id)).toEqual({ status: "active", disposition: "suppressed", sent: false });
    await clearSetting("features.casework.deadline_reminders");
  });

  it("records no_recipient when nobody listed can open the case, and sends nothing", async () => {
    await db.query("update public.member_cases set steward_user_id = null, coordinator_user_id = null where id = $1", [ID.case]);
    try {
      const id = await insertDeadline({ due: "6 days", reminder: "-1 minute", createdBy: OUTSIDER });
      expect(await sweep()).toBe(0);
      expect(await deadline(id)).toEqual({ status: "active", disposition: "no_recipient", sent: false });
      expect(await notices(OUTSIDER)).toEqual([]);
    } finally {
      await db.query("update public.member_cases set steward_user_id = $2, coordinator_user_id = $3 where id = $1", [ID.case, ID.steward, ID.coordinator]);
    }
  });

  it("refuses a sent time without a sent disposition", async () => {
    const id = await insertDeadline({ due: "7 days" });
    await db.query("savepoint bad_disposition");
    await expect(db.query("update public.casework_deadlines set reminder_disposition = 'expired', reminder_sent_at = now() where id = $1", [id]))
      .rejects.toMatchObject({ code: "23514" });
    await db.query("rollback to savepoint bad_disposition");
  });

  it("holds a fresh reminder while reminders are switched off and sends it once they are back on", async () => {
    await setSetting("features.casework.deadline_reminders", false);
    const id = await insertDeadline({ due: "4 days", reminder: "-1 minute" });
    expect(await sweep()).toBe(0);
    expect(await deadline(id)).toEqual({ status: "active", disposition: null, sent: false });
    await clearSetting("features.casework.deadline_reminders");
    expect(await sweep()).toBe(2);
    expect(await deadline(id)).toEqual({ status: "active", disposition: "sent", sent: true });
  });

  it("marks a passed unmet deadline missed with one audit row, after the grace hours", async () => {
    await setSetting("limits.casework.deadline_missed_grace_hours", 24);
    const id = await insertDeadline({ due: "-1 hour" });
    await sweep();
    expect((await deadline(id)).status).toBe("active");
    await clearSetting("limits.casework.deadline_missed_grace_hours");
    expect(await sweep()).toBe(1);
    expect((await deadline(id)).status).toBe("missed");
    const audit = (await db.query(
      "select event_type, entity_type, actor_user_id, metadata from public.casework_audit_events where entity_id = $1",
      [id],
    )).rows;
    expect(audit).toEqual([{
      event_type: "deadline_decided", entity_type: "deadline", actor_user_id: null,
      metadata: { decision: "missed", automatic: true, kind: "response" },
    }]);
    expect(await sweep()).toBe(0);
  });

  it("keeps a missed deadline on the overdue tile and in the next-action queue until it is resolved", async () => {
    // Two days overdue, so its due date is before today in every time zone.
    const id = await insertDeadline({ due: "-2 days" });
    await sweep();
    expect((await deadline(id)).status).toBe("missed");
    const { rows: [expected] } = await db.query(
      `select count(*)::int as n, count(*) filter (where status = 'missed')::int as missed
         from public.casework_deadlines
        where case_id = $1 and kind = 'response' and status in ('active', 'extended', 'missed') and due_at < now()`,
      [ID.case],
    );
    expect(expected.missed).toBeGreaterThan(0);
    const tile = await as(ID.steward, "select kind, deadline_count::int as n from public.casework_dashboard_overdue_deadlines()");
    expect(tile).toEqual([{ kind: "response", n: expected.n }]);
    const [{ value: queue }] = await as(ID.steward, "select public.get_case_queue_next_actions('steward', 50) as value");
    const risk = (queue.items ?? []).filter((item) => item.kind === "deadline_risk" && item.caseId === ID.case);
    expect(risk).toHaveLength(1);
    expect(risk[0].days).toBeLessThan(0);
    // Resolving every overdue deadline takes the case off both surfaces.
    await db.query("update public.casework_deadlines set status = 'met' where case_id = $1 and due_at < now() and status in ('active', 'extended', 'missed')", [ID.case]);
    expect(await as(ID.steward, "select kind from public.casework_dashboard_overdue_deadlines()")).toEqual([]);
  });

  it("leaves passed deadlines alone while missed marking is switched off", async () => {
    await setSetting("features.casework.mark_missed_deadlines", false);
    const id = await insertDeadline({ due: "-2 hours" });
    expect(await sweep()).toBe(0);
    expect((await deadline(id)).status).toBe("active");
    await clearSetting("features.casework.mark_missed_deadlines");
    await db.query("update public.casework_deadlines set status = 'waived' where id = $1", [id]);
  });

  it("lets assigned staff record met, waived or reopened, audited, and refuses members and bad values", async () => {
    const id = await insertDeadline({ due: "-3 hours" });
    await sweep();
    expect((await deadline(id)).status).toBe("missed");
    const [{ met }] = await as(ID.steward, "select (public.casework_set_deadline_status($1, 'met')).status met", [id]);
    expect(met).toBe("met");
    const audit = (await db.query(
      "select actor_user_id, metadata from public.casework_audit_events where entity_id = $1 order by id",
      [id],
    )).rows;
    expect(audit.at(-1)).toEqual({ actor_user_id: ID.steward, metadata: { decision: "met", previousStatus: "missed" } });
    await expect(as(ID.steward, "select public.casework_set_deadline_status($1, 'missed')", [id])).rejects.toMatchObject({ code: "22023" });
    await expect(as(ID.member, "select public.casework_set_deadline_status($1, 'waived')", [id])).rejects.toMatchObject({ code: "P0002" });
    const [{ waived }] = await as(ID.coordinator, "select (public.casework_set_deadline_status($1, 'waived')).status waived", [id]);
    expect(waived).toBe("waived");
    // Reopening a passed deadline is honest: the next sweep records it missed again.
    await as(ID.steward, "select public.casework_set_deadline_status($1, 'active')", [id]);
    await sweep();
    expect((await deadline(id)).status).toBe("missed");
  });
});
