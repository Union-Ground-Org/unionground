// @vitest-environment node
//
// REQ-UG-ULP-FILING-DEADLINE-20261001
//
// A flagged retaliation incident carries an unfair labor practice charge filing
// deadline (incident date + organization window, old default 180 days). The
// member sees it on their own case summary (get_my_case_ulp_summary, pinned
// fields ulpDeadline / retaliationFlagged for), staff see it on the case
// and in the deadline view, and an hourly sweep warns both once at the first
// threshold (30 days) and once more at the urgent one (7 days).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

//: fixture dates are built on the Eastern day, the day the readers count;
// the session's current_date is the UTC day, tomorrow from 7 PM Eastern.

const migration = readFileSync(
  new URL("../supabase/migrations/20261002140000_casework_ulp_filing_deadline.sql", import.meta.url),
  "utf8",
);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("ULP filing deadline (static)", () => {
  it("registers the switch and limits with the old app's defaults and cites them", () => {
    expect(migration).toMatch(/\('features\.casework\.ulp_deadline', 'boolean',[\s\S]*?'true', null, null, null, 1400, 'casework', true\)/);
    expect(migration).toMatch(/\('limits\.casework\.ulp_window_days', 'integer',[\s\S]*?'180', 30, 365, null, 1410, 'casework', false\)/);
    expect(migration).toMatch(/\('limits\.casework\.ulp_warning_days', 'integer',[\s\S]*?'30', 1, 120, null, 1420, 'casework', true\)/);
    expect(migration).toMatch(/\('limits\.casework\.ulp_critical_days', 'integer',[\s\S]*?'7', 1, 60, null, 1430, 'casework', true\)/);
    expect(migration).toContain("on conflict (key) do nothing;");
    for (const citation of ["0022_features_all.sql:454", "retaliation-detection.ts:101", "load-member-home.ts:354", "0024_tier1_polish.sql:40"]) {
      expect(migration).toContain(citation);
    }
  });

  it("schedules the hourly sweep and pins it in the database contract", () => {
    expect(migration).toContain(
      "perform cron.schedule('casework-ulp-deadline-tick', '41 * * * *', 'select private.casework_sweep_ulp_deadlines(200)')",
    );
    expect(contract.cron).toContainEqual(expect.objectContaining({
      jobname: "casework-ulp-deadline-tick",
      schedule: "41 * * * *",
      commandContains: ["private.casework_sweep_ulp_deadlines(200)"],
    }));
    const signatures = contract.functions.map((entry) => entry.sig);
    expect(signatures).toEqual(expect.arrayContaining([
      "public.get_my_case_ulp_summary()",
      // BUG-UG-CASEWORK-SAFETY-RETALIATION-30-DAY-DEADLINE-20261022 adds
      // the trailing protected activity category (default null).
      "public.casework_flag_retaliation_incident(p_case_id uuid, p_incident_on date, p_note text, p_protected_activity_category text)",
      "public.casework_review_retaliation_flag(p_flag_id uuid, p_status text, p_note text)",
      "public.casework_list_case_retaliation_flags(p_case_id uuid)",
      "public.casework_list_ulp_deadlines(p_limit integer)",
      "private.casework_sweep_ulp_deadlines(p_limit integer)",
    ]));
  });

  it("keeps every notice free of case detail and gives the flags table no client grant", () => {
    const code = migration.replace(/--[^\n]*/g, "");
    expect(code).toContain("revoke all on table public.casework_retaliation_flags from public, anon, authenticated;");
    expect(code).not.toMatch(/grant [a-z, ]+ on (table )?public\.casework_retaliation_flags/i);
    expect(code).toContain("private.notify_member(v_case.user_id, 'casework.ulp.member_' || v_level, '{}'::jsonb, 'deadlines')");
    expect(code).toContain("private.notify_member(v_staff, 'casework.ulp.staff_' || v_level, '{}'::jsonb, 'deadlines')");
  });

  it("is registered in the required database proof lane", () => {
    expect(PROOF_FILES).toContain("tests/casework-ulp-deadline-db.test.js");
  });
});

const ID = {
  org: "50902214-0000-4000-8000-000000000001",
  steward: "50902214-0000-4000-8000-000000000101",
  member: "50902214-0000-4000-8000-000000000102",
  other: "50902214-0000-4000-8000-000000000103",
  outsider: "50902214-0000-4000-8000-000000000104",
  session: "50902214-0000-4000-8000-000000000201",
  memberSession: "50902214-0000-4000-8000-000000000202",
  otherSession: "50902214-0000-4000-8000-000000000203",
  outsiderSession: "50902214-0000-4000-8000-000000000204",
  case: "50902214-0000-4000-8000-000000000301",
  secondCase: "50902214-0000-4000-8000-000000000302",
  otherCase: "50902214-0000-4000-8000-000000000303",
};
const CHAPTER = "ulp-deadline-proof";
const CASE_REFERENCE = "ULP-DEADLINE-PROOF";
const CASE_TITLE = "ULP deadline proof case";
const COPY = {
  memberWarning: "A legal filing deadline on your case is approaching",
  memberUrgent: "A legal filing deadline on your case is days away",
  staffWarning: "An unfair labor practice filing window is closing",
  staffUrgent: "An unfair labor practice filing deadline is days away",
};
const COPY_ES = [
  "Se acerca un plazo legal de presentación en tu caso",
  "Faltan pocos días para un plazo legal en tu caso",
  "Se está cerrando un plazo para presentar un cargo por práctica laboral injusta",
  "Faltan pocos días para presentar un cargo por práctica laboral injusta",
];
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("ULP filing deadline on a disposable database", () => {
  let db;
  const sessions = {};

  async function as(userId, work) {
    await db.query("savepoint as_user");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: userId, role: "authenticated", session_id: sessions[userId], aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const result = await work();
      await db.query("reset role");
      await db.query("select set_config('request.jwt.claims', '', true)");
      await db.query("release savepoint as_user");
      return result;
    } catch (error) {
      await db.query("rollback to savepoint as_user");
      await db.query("reset role");
      await db.query("select set_config('request.jwt.claims', '', true)");
      throw error;
    }
  }

  const rpc = (userId, sql, params = []) => as(userId, async () => (await db.query(sql, params)).rows);
  const today = async () => (await db.query("select (now() at time zone 'America/New_York')::date::text d")).rows[0].d;
  const daysFromToday = async (days) => (await db.query("select ((now() at time zone 'America/New_York')::date + $1::integer)::text d", [days])).rows[0].d;
  // The sweep dates a member report's incident on the Eastern calendar:
  // the Eastern date of the incident instant, plus the given days.
  const easternDayOf = async (instant, days) => (await db.query(
    `select (((${instant}) at time zone 'America/New_York')::date + $1::integer)::text d`, [days])).rows[0].d;
  // Every notice in this proof shares one transaction timestamp, so "new since"
  // is a set difference on ids, never a slice of an ordered list.
  const notices = async (userId) => (await db.query(
    "select id, title, body, kind from public.member_notifications where user_id = $1 and title = any($2::text[])",
    [userId, [...Object.values(COPY), ...COPY_ES]],
  )).rows;
  const since = async (userId, before) => {
    const seen = new Set(before.map((row) => row.id));
    return (await notices(userId)).filter((row) => !seen.has(row.id));
  };
  const sweep = async () => (await db.query("select private.casework_sweep_ulp_deadlines(200) n")).rows[0].n;
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
      application_name: "casework-ulp-deadline-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    // Only this proof's flags are swept inside the transaction.
    await db.query("update public.casework_retaliation_flags set status = 'dismissed', note = 'outside proof scope' where status in ('open','confirmed')");
    const users = [
      [ID.steward, "ulp-steward", ID.session],
      [ID.member, "ulp-member", ID.memberSession],
      [ID.other, "ulp-other", ID.otherSession],
      [ID.outsider, "ulp-outsider", ID.outsiderSession],
    ];
    for (const [id, name, session] of users) {
      await db.query("insert into auth.users(id, email) values ($1, $2)", [id, `${name}@example.invalid`]);
      await db.query("insert into auth.sessions(id, user_id, aal, created_at, updated_at) values ($1, $2, 'aal2', now(), now())", [session, id]);
      await db.query(
        `insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, created_at, updated_at)
         values (gen_random_uuid(), $1, 'ulp-proof-totp', 'totp', 'verified', now(), now())`,
        [id],
      );
      sessions[id] = session;
    }
    await db.query(
      "insert into public.organizations(id, slug, name, created_by) values ($1, 'ulp-deadline-proof-org', 'ULP deadline proof', $2)",
      [ID.org, ID.steward],
    );
    await db.query(
      "insert into public.chapters(id, name, slug, organization_id, is_default, order_index) values ($1, $1, $1, $2, false, 9923)",
      [CHAPTER, ID.org],
    );
    // These access-refusal controls exercise the optional assigned-only mode.
    await db.query("insert into private.chapter_access_policies(chapter_id,steward_grievances) values($1,false)", [CHAPTER]);
    for (const [id] of users) {
      await db.query("insert into public.organization_memberships(organization_id, user_id, status) values ($1, $2, 'active')", [ID.org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id, chapter_id, status) values ($1, $2, 'active')", [id, CHAPTER]);
      await db.query("update public.member_profiles set chapter_id = $2 where id = $1", [id, CHAPTER]);
    }
    await db.query("update public.member_profiles set language = 'es' where id = $1", [ID.other]);
    for (const id of [ID.steward, ID.outsider]) {
      await db.query(
        "insert into public.organization_role_grants(organization_id, user_id, role, granted_by) values ($1, $2, 'steward', $2)",
        [ID.org, id],
      );
    }
    for (const [caseId, owner, suffix] of [[ID.case, ID.member, "A"], [ID.secondCase, ID.member, "B"], [ID.otherCase, ID.other, "C"]]) {
      await db.query(
        `insert into public.member_cases(id, user_id, reference, title, case_type, step, status, steward_user_id)
         values ($1, $2, $3, $4, 'other', 'Intake', 'active', $5)`,
        [caseId, owner, `${CASE_REFERENCE}-${suffix}`, `${CASE_TITLE} ${suffix}`, ID.steward],
      );
    }

    //  re-final: committed data gives every steward grant its migration

    // assignments; an organization grant reaches only chapters it has one in.

    await migrateLegacyStewardFixtures(db);
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("keeps the routines SECURITY DEFINER with the narrow grants the contract pins", async () => {
    const rows = (await db.query(
      `select p.oid::regprocedure::text signature, p.prosecdef,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') authenticated,
         has_function_privilege('anon', p.oid, 'EXECUTE') anon
       from pg_catalog.pg_proc p where p.oid = any($1::regprocedure[]) order by 1`,
      [[
        "public.get_my_case_ulp_summary()",
        "public.casework_flag_retaliation_incident(uuid,date,text,text)",
        "public.casework_review_retaliation_flag(uuid,text,text)",
        "public.casework_list_case_retaliation_flags(uuid)",
        "public.casework_list_ulp_deadlines(integer)",
        "private.casework_sweep_ulp_deadlines(integer)",
      ]],
    )).rows;
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.prosecdef).toBe(true);
      expect(row.anon).toBe(false);
      expect(row.authenticated).toBe(!row.signature.startsWith("private."));
    }
    const table = (await db.query(
      `select has_table_privilege('authenticated', 'public.casework_retaliation_flags', 'SELECT') sel,
              has_table_privilege('authenticated', 'public.casework_retaliation_flags', 'INSERT') ins,
              has_table_privilege('anon', 'public.casework_retaliation_flags', 'SELECT') anon`,
    )).rows[0];
    expect(table).toEqual({ sel: false, ins: false, anon: false });
    const defaults = (await db.query(
      `select key, default_value, minimum, maximum, category, member_visible from public.platform_setting_definitions
       where key like '%.casework.ulp_%' order by key`,
    )).rows;
    expect(defaults).toEqual([
      { key: "features.casework.ulp_deadline", default_value: true, minimum: null, maximum: null, category: "casework", member_visible: true },
      { key: "limits.casework.ulp_critical_days", default_value: 7, minimum: 1, maximum: 60, category: "casework", member_visible: true },
      // REQ-UG-RIGHTS-LAW-LIBRARY-20261012: none keeps the day window.
      { key: "limits.casework.ulp_jurisdiction", default_value: "none", minimum: null, maximum: null, category: "casework", member_visible: false },
      { key: "limits.casework.ulp_warning_days", default_value: 30, minimum: 1, maximum: 120, category: "casework", member_visible: true },
      { key: "limits.casework.ulp_window_days", default_value: 180, minimum: 30, maximum: 365, category: "casework", member_visible: false },
    ]);
  });

  it("lets the assigned steward flag an incident with a 180-day deadline, idempotently and audited", async () => {
    const incident = await daysFromToday(-10);
    const [{ flag }] = await rpc(ID.steward,
      "select public.casework_flag_retaliation_incident($1, $2::date, 'Written warning after the grievance') flag",
      [ID.case, incident]);
    expect(flag).toMatchObject({ caseId: ID.case, source: "staff", incidentOn: incident, status: "open", windowDays: 180 });
    expect(flag.ulpDeadline).toBe(await daysFromToday(170));
    expect(flag.daysLeft).toBe(170);
    const [{ again }] = await rpc(ID.steward,
      "select public.casework_flag_retaliation_incident($1, $2::date, null) again", [ID.case, incident]);
    expect(again.id).toBe(flag.id);
    const audit = (await db.query(
      "select event_type, entity_type, actor_user_id, metadata from public.casework_audit_events where entity_id = $1",
      [flag.id],
    )).rows;
    expect(audit).toEqual([{
      event_type: "pattern_detected", entity_type: "retaliation_flag", actor_user_id: ID.steward,
      metadata: { source: "staff", ulpWindowDays: 180 },
    }]);
  });

  it("refuses staff without case access, a future incident, and direct table reads", async () => {
    await expect(rpc(ID.outsider, "select public.casework_flag_retaliation_incident($1, (now() at time zone 'America/New_York')::date, null)", [ID.case]))
      .rejects.toMatchObject({ code: "P0002" });
    await expect(rpc(ID.member, "select public.casework_flag_retaliation_incident($1, (now() at time zone 'America/New_York')::date, null)", [ID.case]))
      .rejects.toMatchObject({ code: "P0002" });
    await expect(rpc(ID.steward, "select public.casework_flag_retaliation_incident($1, (now() at time zone 'America/New_York')::date + 1, null)", [ID.case]))
      .rejects.toMatchObject({ code: "22023" });
    await expect(rpc(ID.steward, "select count(*) from public.casework_retaliation_flags"))
      .rejects.toMatchObject({ code: "42501" });
    await expect(rpc(ID.outsider, "select public.casework_list_case_retaliation_flags($1)", [ID.case]))
      .rejects.toMatchObject({ code: "P0002" });
  });

  it("puts ulpDeadline and retaliationFlagged on the member's own case summary only", async () => {
    const [{ summary }] = await rpc(ID.member, "select public.get_my_case_ulp_summary() summary");
    expect(summary).toEqual([{
      caseId: ID.case,
      ulpDeadline: await daysFromToday(170),
      retaliationFlagged: true,
      stewardNotified: false,
      ulpWarningDays: 30,
      ulpCriticalDays: 7,
      ulpSource: null,
    }]);
    const [{ other }] = await rpc(ID.other, "select public.get_my_case_ulp_summary() other");
    expect(other).toEqual([]);
    await expect(as(null, () => db.query("select public.get_my_case_ulp_summary()"))).rejects.toMatchObject({ code: "42501" });
  });

  it("shows the nearest open deadline, then the latest passed one", async () => {
    await rpc(ID.steward, "select public.casework_flag_retaliation_incident($1, (now() at time zone 'America/New_York')::date - 200, null)", [ID.secondCase]);
    let [{ summary }] = await rpc(ID.member, "select public.get_my_case_ulp_summary() summary");
    expect(summary.find((row) => row.caseId === ID.secondCase).ulpDeadline).toBe(await daysFromToday(-20));
    await rpc(ID.steward, "select public.casework_flag_retaliation_incident($1, (now() at time zone 'America/New_York')::date - 100, null)", [ID.secondCase]);
    [{ summary }] = await rpc(ID.member, "select public.get_my_case_ulp_summary() summary");
    expect(summary.find((row) => row.caseId === ID.secondCase).ulpDeadline).toBe(await daysFromToday(80));
  });

  it("applies a changed window to new flags only and lists open deadlines for staff, soonest first", async () => {
    await setSetting("limits.casework.ulp_window_days", 90);
    const [{ flag }] = await rpc(ID.steward,
      "select public.casework_flag_retaliation_incident($1, (now() at time zone 'America/New_York')::date - 5, null) flag", [ID.otherCase]);
    expect(flag.windowDays).toBe(90);
    expect(flag.ulpDeadline).toBe(await daysFromToday(85));
    const [{ caseFlags }] = await rpc(ID.steward, "select public.casework_list_case_retaliation_flags($1) \"caseFlags\"", [ID.case]);
    expect(caseFlags).toMatchObject({ enabled: true, windowDays: 90, warningDays: 30, criticalDays: 7 });
    expect(caseFlags.flags[0].windowDays).toBe(180);
    await clearSetting("limits.casework.ulp_window_days");
    const [{ rows }] = await rpc(ID.steward, "select public.casework_list_ulp_deadlines(50) rows");
    const proofRows = rows.filter((row) => row.reference.startsWith(CASE_REFERENCE));
    expect(proofRows.map((row) => row.ulpDeadline)).toEqual([...proofRows.map((row) => row.ulpDeadline)].sort());
    expect(proofRows.map((row) => row.reference)).toEqual(expect.arrayContaining([`${CASE_REFERENCE}-A`, `${CASE_REFERENCE}-C`]));
    const [{ outsiderRows }] = await rpc(ID.outsider, "select public.casework_list_ulp_deadlines(50) \"outsiderRows\"");
    expect(outsiderRows.filter((row) => row.reference.startsWith(CASE_REFERENCE))).toEqual([]);
  });

  it("lists only the selected organization for a staff member with two organization roles", async () => {
    await db.query("savepoint second_ulp_org");
    try {
      const otherOrg = randomUUID();
      const otherChapter = `ulp-other-${otherOrg.slice(0, 8)}`;
      const otherCase = randomUUID();
      await db.query("insert into public.organizations(id,slug,name,created_by) values ($1,$2,'Other ULP proof',$3)", [otherOrg, otherChapter, ID.steward]);
      await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values ($1,$2,$2,$3,false,9924)", [otherChapter, otherChapter, otherOrg]);
      for (const user of [ID.steward, ID.member]) {
        await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [otherOrg, user]);
        await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user, otherChapter]);
      }
      await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'steward',$2)", [otherOrg, ID.steward]);
      await db.query("update public.member_profiles set chapter_id = $2 where id = $1", [ID.member, otherChapter]);
      await db.query(`insert into public.member_cases(id,user_id,organization_id,chapter_id,reference,title,case_type,step,status,steward_user_id)
        values ($1,$2,$3,$4,'ULP-FOREIGN','Foreign case','other','Intake','active',$5)`, [otherCase, ID.member, otherOrg, otherChapter, ID.steward]);
      await db.query("update public.member_profiles set chapter_id = $2 where id = $1", [ID.member, CHAPTER]);
      await db.query(`insert into public.casework_retaliation_flags(case_id,organization_id,chapter_id,source,incident_on,ulp_window_days)
        values ($1,$2,$3,'staff',(now() at time zone 'America/New_York')::date - 5,180)`, [otherCase, otherOrg, otherChapter]);
      const [{ rows }] = await rpc(ID.steward, "select public.casework_list_ulp_deadlines(50) rows");
      expect(rows.map((row) => row.reference)).not.toContain("ULP-FOREIGN");
    } finally {
      await db.query("rollback to savepoint second_ulp_org");
    }
  });

  it("enforces the organization switch on the server", async () => {
    await setSetting("features.casework.ulp_deadline", false);
    await expect(rpc(ID.steward, "select public.casework_flag_retaliation_incident($1, (now() at time zone 'America/New_York')::date - 1, null)", [ID.case]))
      .rejects.toMatchObject({ code: "55000" });
    const [{ summary }] = await rpc(ID.member, "select public.get_my_case_ulp_summary() summary");
    expect(summary.find((row) => row.caseId === ID.case)).toMatchObject({ ulpDeadline: null, retaliationFlagged: true });
    const [{ rows }] = await rpc(ID.steward, "select public.casework_list_ulp_deadlines(50) rows");
    expect(rows.filter((row) => row.reference.startsWith(CASE_REFERENCE))).toEqual([]);
    const [{ caseFlags }] = await rpc(ID.steward, "select public.casework_list_case_retaliation_flags($1) \"caseFlags\"", [ID.case]);
    expect(caseFlags.enabled).toBe(false);
    expect(caseFlags.flags[0].ulpDeadline).toBeNull();
    await clearSetting("features.casework.ulp_deadline");
  });

  it("requires a note to dismiss, and a dismissed flag leaves the member summary", async () => {
    const [{ caseFlags }] = await rpc(ID.steward, "select public.casework_list_case_retaliation_flags($1) \"caseFlags\"", [ID.case]);
    const flagId = caseFlags.flags[0].id;
    await expect(rpc(ID.steward, "select public.casework_review_retaliation_flag($1, 'dismissed', null)", [flagId]))
      .rejects.toMatchObject({ code: "22023" });
    const [{ reviewed }] = await rpc(ID.steward,
      "select public.casework_review_retaliation_flag($1, 'dismissed', 'Scheduled action predates the grievance') reviewed", [flagId]);
    expect(reviewed).toMatchObject({ status: "dismissed", note: "Scheduled action predates the grievance" });
    const [{ summary }] = await rpc(ID.member, "select public.get_my_case_ulp_summary() summary");
    expect(summary.map((row) => row.caseId)).not.toContain(ID.case);
    const [{ reopened }] = await rpc(ID.steward, "select public.casework_review_retaliation_flag($1, 'open', null) reopened", [flagId]);
    expect(reopened.status).toBe("open");
    const audit = (await db.query(
      "select metadata from public.casework_audit_events where entity_id = $1 and event_type = 'pattern_reviewed' order by id",
      [flagId],
    )).rows.map((row) => row.metadata);
    expect(audit).toEqual([{ status: "dismissed" }, { status: "open" }]);
  });

  it("turns the member's own retaliation report on a case into a flag and follows its withdrawal", async () => {
    const reportId = randomUUID();
    await db.query("alter table public.casework_retaliation_reports disable trigger sensitive_envelopes");
    await db.query(
      `insert into public.casework_retaliation_reports(id, organization_id, chapter_id, reporter_user_id, case_id, incident_at,
         management_person, protected_activity, adverse_action, idempotency_key)
       values ($1, $2, $3, $4, $5, now() - interval '3 days', '[encrypted]', '[encrypted]', '[encrypted]', gen_random_uuid())`,
      [reportId, ID.org, CHAPTER, ID.other, ID.otherCase],
    );
    await db.query("alter table public.casework_retaliation_reports enable trigger sensitive_envelopes");
    await sweep();
    const flag = (await db.query(
      "select source, status, incident_on::text, ulp_deadline::text, created_by from public.casework_retaliation_flags where source_id = $1",
      [reportId],
    )).rows[0];
    expect(flag).toEqual({
      source: "member_report", status: "open", incident_on: await easternDayOf("now() - interval '3 days'", 0),
      ulp_deadline: await easternDayOf("now() - interval '3 days'", 180), created_by: null,
    });
    await sweep();
    expect((await db.query("select count(*)::int n from public.casework_retaliation_flags where source_id = $1", [reportId])).rows[0].n).toBe(1);
    await db.query("alter table public.casework_retaliation_reports disable trigger sensitive_envelopes");
    await db.query(
      "update public.casework_retaliation_reports set status = 'withdrawn', withdrawn_at = now(), withdrawal_reason = '[encrypted]' where id = $1",
      [reportId],
    );
    await db.query("alter table public.casework_retaliation_reports enable trigger sensitive_envelopes");
    await sweep();
    expect((await db.query("select status from public.casework_retaliation_flags where source_id = $1", [reportId])).rows[0].status)
      .toBe("withdrawn");
  });

  it("warns the member and the assigned steward once at 30 days and once more at 7, without case detail", async () => {
    // Case A's open flag: deadline 20 days out -> first warning only.
    await db.query(
      "update public.casework_retaliation_flags set incident_on = (now() at time zone 'America/New_York')::date - 160, warning_sent_at = null, urgent_sent_at = null where case_id = $1 and status = 'open'",
      [ID.case],
    );
    const memberBefore = await notices(ID.member);
    const stewardBefore = await notices(ID.steward);
    await sweep();
    const memberNotices = await since(ID.member, memberBefore);
    expect(memberNotices).toContainEqual(expect.objectContaining({ title: COPY.memberWarning, kind: "deadlines" }));
    expect(memberNotices.map((row) => row.title)).not.toContain(COPY.memberUrgent);
    const stewardNotices = await since(ID.steward, stewardBefore);
    expect(stewardNotices).toContainEqual(expect.objectContaining({ title: COPY.staffWarning, kind: "deadlines" }));
    for (const row of [...memberNotices, ...stewardNotices]) {
      for (const text of [row.title, row.body]) {
        expect(text).not.toContain(CASE_REFERENCE);
        expect(text).not.toContain(CASE_TITLE);
        expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      }
    }
    const afterFirst = await notices(ID.member);
    await sweep();
    expect(await since(ID.member, afterFirst)).toEqual([]);
    // Five days out -> the urgent notice, exactly once.
    await db.query(
      "update public.casework_retaliation_flags set incident_on = (now() at time zone 'America/New_York')::date - 175 where case_id = $1 and status = 'open'",
      [ID.case],
    );
    await sweep();
    expect((await since(ID.member, afterFirst)).map((row) => row.title)).toEqual([COPY.memberUrgent]);
    const afterUrgent = await notices(ID.member);
    await sweep();
    expect(await since(ID.member, afterUrgent)).toEqual([]);
    expect(await today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("skips staff who lost access by send time and sends nothing while the switch is off", async () => {
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    await db.query("update public.member_cases set steward_user_id = $2 where id = $1", [ID.otherCase, ID.outsider]);
    await db.query("select set_config('request.jwt.claims', '', true)");
    await db.query("delete from public.organization_role_grants where organization_id = $1 and user_id = $2", [ID.org, ID.outsider]);
    await db.query(
      "update public.casework_retaliation_flags set incident_on = (now() at time zone 'America/New_York')::date - 70, warning_sent_at = null, urgent_sent_at = null where case_id = $1 and source = 'staff'",
      [ID.otherCase],
    );
    await setSetting("features.casework.ulp_deadline", false);
    const otherBefore = await notices(ID.other);
    await sweep();
    expect(await since(ID.other, otherBefore)).toEqual([]);
    await clearSetting("features.casework.ulp_deadline");
    await sweep();
    // 90-day window, incident 70 days ago -> 20 days left: the member's warning
    // arrives in their language (Spanish), the outsider who lost access gets nothing.
    const spanish = (await db.query(
      "select title from public.member_notifications where user_id = $1 and title = 'Se acerca un plazo legal de presentación en tu caso'",
      [ID.other],
    )).rows;
    expect(spanish).toHaveLength(1);
    expect(await notices(ID.outsider)).toEqual([]);
  });

  // REQ-UG-RIGHTS-LAW-LIBRARY-20261012: an organization on
  // Massachusetts law gets six calendar months (456 CMR 15.04), not 180 days,
  // on flags created after the choice; none keeps the day window, and neither
  // a later setting change nor a review moves a stored deadline.
  it("sets a Massachusetts flag's window by the six-month law and never moves an existing flag", async () => {
    await db.query("savepoint ulp_jurisdiction");
    try {
      const maCase = randomUUID();
      await db.query(
        `insert into public.member_cases(id, user_id, reference, title, case_type, step, status, steward_user_id)
         values ($1, $2, $3, $4, 'other', 'Intake', 'active', $5)`,
        [maCase, ID.member, `${CASE_REFERENCE}-MA`, `${CASE_TITLE} MA`, ID.steward],
      );
      const flagOn = async (date) => (await rpc(ID.steward,
        "select public.casework_flag_retaliation_incident($1, $2::date, null) flag", [maCase, date]))[0].flag;
      await setSetting("limits.casework.ulp_jurisdiction", "MA");
      const late = await flagOn("2026-08-31");
      expect(late).toMatchObject({ incidentOn: "2026-08-31", ulpDeadline: "2027-02-28", windowDays: 181, windowBasis: "jurisdiction:MA" });
      expect(late.windowSource).toMatchObject({
        provenance_id: expect.stringMatching(/^prov-[0-9a-f]{64}$/),
        source: { url: "https://www.mass.gov/info-details/a-unfair-labor-practice-procedures" },
      });
      const mid = await flagOn("2026-03-14");
      expect(mid).toMatchObject({ ulpDeadline: "2026-09-14", windowDays: 184, windowBasis: "jurisdiction:MA" });

      const [{ caseFlags }] = await rpc(ID.steward, "select public.casework_list_case_retaliation_flags($1) \"caseFlags\"", [maCase]);
      expect(caseFlags).toMatchObject({ windowDays: 180, jurisdiction: { code: "MA", name: "Massachusetts", periodValue: 6, periodUnit: "month", pinpoint: "456 CMR 15.04" } });
      expect(caseFlags.jurisdiction.provenance).toEqual(late.windowSource);
      const [{ summary }] = await rpc(ID.member, "select public.get_my_case_ulp_summary() summary");
      const row = summary.find((item) => item.caseId === maCase);
      expect(row.ulpDeadline).toBe("2027-02-28");
      expect(row.ulpSource).toEqual(late.windowSource);

      await clearSetting("limits.casework.ulp_jurisdiction");
      const plain = await flagOn(await daysFromToday(-3));
      expect(plain).toMatchObject({ windowDays: 180, windowBasis: "organization_limit", windowSource: null, ulpDeadline: await daysFromToday(177) });
      const [{ plainFlags }] = await rpc(ID.steward, "select public.casework_list_case_retaliation_flags($1) \"plainFlags\"", [maCase]);
      expect(plainFlags.jurisdiction).toBeNull();
      const [{ reviewed }] = await rpc(ID.steward, "select public.casework_review_retaliation_flag($1, 'confirmed', null) reviewed", [late.id]);
      expect(reviewed).toMatchObject({ ulpDeadline: "2027-02-28", windowDays: 181, windowBasis: "jurisdiction:MA" });
      const stored = (await db.query("select ulp_window_days, ulp_deadline::text, ulp_window_basis from public.casework_retaliation_flags where id = $1", [late.id])).rows[0];
      expect(stored).toEqual({ ulp_window_days: 181, ulp_deadline: "2027-02-28", ulp_window_basis: "jurisdiction:MA" });
      await expect(rpc(ID.steward, "select count(*) from private.reference_ulp_limitation_periods")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.query("rollback to savepoint ulp_jurisdiction");
    }
  });
});
