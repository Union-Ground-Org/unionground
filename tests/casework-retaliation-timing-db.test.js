// @vitest-environment node
//
// REQ-UG-RETALIATION-TIMING-DETECTOR-20261001
//
// Discipline, or a retaliation entry linked to the case, that follows a
// member's case inside the organization window becomes a timing_detector
// retaliation flag beside the report-count pattern scan: the old confidence
// formula, the prior-discipline count for the reviewer, the ULP deadline, a
// case-free staff notice and then a member notice that the steward was told.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const migration = readFileSync(
  new URL("../supabase/migrations/20261002141000_casework_retaliation_timing_detector.sql", import.meta.url),
  "utf8",
);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("retaliation timing detector (static)", () => {
  it("registers the switch and limits with the old defaults, cited", () => {
    expect(migration).toMatch(/\('features\.casework\.retaliation_timing_detector', 'boolean',[\s\S]*?'true', null, null, null, 1440, 'casework', true\)/);
    expect(migration).toMatch(/\('limits\.casework\.retaliation_window_days', 'integer',[\s\S]*?'180', 7, 365, null, 1450, 'casework', false\)/);
    expect(migration).toMatch(/\('limits\.casework\.retaliation_prior_discipline_months', 'integer',[\s\S]*?'12', 1, 60, null, 1460, 'casework', false\)/);
    for (const citation of ["0024_tier1_polish.sql:40", "retaliation-detection.ts:91-96", "0029_fix_settings_constraints_and_seed.sql:43"]) {
      expect(migration).toContain(citation);
    }
  });

  it("schedules the hourly detector and pins it in the database contract", () => {
    expect(migration).toContain(
      "perform cron.schedule('casework-retaliation-timing-tick', '23 * * * *', 'select private.casework_detect_retaliation_timing(null, null, 200)')",
    );
    expect(contract.cron).toContainEqual(expect.objectContaining({
      jobname: "casework-retaliation-timing-tick",
      commandContains: ["private.casework_detect_retaliation_timing(null, null, 200)"],
    }));
    expect(contract.functions.map((entry) => entry.sig)).toEqual(expect.arrayContaining([
      "public.casework_scan_retaliation_timing(p_chapter_id text)",
      "private.casework_detect_retaliation_timing(p_organization_id uuid, p_chapter_id text, p_limit integer)",
    ]));
  });

  it("is registered in the required database proof lane", () => {
    expect(PROOF_FILES).toContain("tests/casework-retaliation-timing-db.test.js");
  });
});

const ID = {
  org: "50902215-0000-4000-8000-000000000001",
  coordinator: "50902215-0000-4000-8000-000000000101",
  steward: "50902215-0000-4000-8000-000000000102",
  member: "50902215-0000-4000-8000-000000000103",
  unassignedMember: "50902215-0000-4000-8000-000000000104",
  grievance: "50902215-0000-4000-8000-000000000301",
  otherCase: "50902215-0000-4000-8000-000000000302",
  disciplineCase: "50902215-0000-4000-8000-000000000303",
  unassignedCase: "50902215-0000-4000-8000-000000000304",
};
const SESSION = {
  [ID.coordinator]: "50902215-0000-4000-8000-000000000201",
  [ID.steward]: "50902215-0000-4000-8000-000000000202",
  [ID.member]: "50902215-0000-4000-8000-000000000203",
  [ID.unassignedMember]: "50902215-0000-4000-8000-000000000204",
};
const CHAPTER = "retaliation-timing-proof";
const REFERENCE = "RETALIATION-TIMING-PROOF";
const TITLES = [
  "A possible retaliation pattern was flagged",
  "Your steward has been notified",
  "Se señaló un posible patrón de represalia",
  "Se avisó a tu representante",
];
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("retaliation timing detector on a disposable database", () => {
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
  const detect = async () => (await db.query("select private.casework_detect_retaliation_timing(null, null, 200) n")).rows[0].n;
  const flags = async (caseId) => (await db.query(
    `select source, adverse_kind, incident_on::text, protected_activity_on::text, days_between, confidence,
       prior_discipline_count, status, ulp_deadline::text, staff_notified_at is not null notified
     from public.casework_retaliation_flags where case_id = $1 and source = 'timing_detector' order by incident_on, id`,
    [caseId],
  )).rows;
  const notices = async (userId) => (await db.query(
    "select id, title, body, kind from public.member_notifications where user_id = $1 and title = any($2::text[])",
    [userId, TITLES],
  )).rows;
  const day = async (offset) => (await db.query("select (current_date + $1::integer)::text d", [offset])).rows[0].d;
  const entry = (caseId, daysAgo, category, summary) => db.query(
    `insert into public.casework_management_entries
       (management_person_id, case_id, organization_id, chapter_id, occurred_at, category, summary, created_by)
     values ($1, $2, $3, $4, now() - make_interval(days => $5), $6, $7, $8)`,
    [ID.person, caseId, ID.org, CHAPTER, daysAgo, category, summary, ID.steward],
  );

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "casework-retaliation-timing-proof",
    });
    await db.connect();
    await db.query("begin");
    // #8568 part B and #8868: the detector dates grievances and adverse events
    // on the Eastern calendar. In an Eastern session current_date is that day,
    // and now() minus whole days keeps the Eastern wall time across a
    // daylight-time change, so the fixture's dates are exact at any hour.
    await db.query("set local timezone to 'America/New_York'");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    const users = [ID.coordinator, ID.steward, ID.member, ID.unassignedMember];
    for (const id of users) {
      await db.query("insert into auth.users(id, email) values ($1, $2)", [id, `timing-${id.slice(-3)}@example.invalid`]);
      await db.query("insert into auth.sessions(id, user_id, aal, created_at, updated_at) values ($1, $2, 'aal2', now(), now())", [SESSION[id], id]);
      await db.query(
        `insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, created_at, updated_at)
         values (gen_random_uuid(), $1, 'timing-proof-totp', 'totp', 'verified', now(), now())`,
        [id],
      );
    }
    await db.query(
      "insert into public.organizations(id, slug, name, created_by) values ($1, 'retaliation-timing-proof-org', 'Retaliation timing proof', $2)",
      [ID.org, ID.coordinator],
    );
    await db.query(
      "insert into public.chapters(id, name, slug, organization_id, is_default, order_index) values ($1, $1, $1, $2, false, 9924)",
      [CHAPTER, ID.org],
    );
    for (const id of users) {
      await db.query("insert into public.organization_memberships(organization_id, user_id, status) values ($1, $2, 'active')", [ID.org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id, chapter_id, status) values ($1, $2, 'active')", [id, CHAPTER]);
      await db.query("update public.member_profiles set chapter_id = $2 where id = $1", [id, CHAPTER]);
    }
    await db.query(
      "insert into public.organization_role_grants(organization_id, user_id, role, granted_by) values ($1, $2, 'coordinator', $2), ($1, $3, 'steward', $2)",
      [ID.org, ID.coordinator, ID.steward],
    );
    // Cases filed 100 days ago (grievance), 40 days ago (another case) and a
    // Discipline case opened 20 days ago (its filing form carries no incident
    // date, so the opening day is the adverse date); the unassigned member's
    // case has no steward.
    const cases = [
      [ID.grievance, ID.member, "A", "Scheduling grievance", "Scheduling", 100, ID.steward],
      [ID.otherCase, ID.member, "B", "Overtime grievance", "Pay", 40, ID.steward],
      [ID.disciplineCase, ID.member, "C", "Suspended three days", "Discipline", 20, ID.steward],
      [ID.unassignedCase, ID.unassignedMember, "D", "Safety complaint", "Safety", 50, null],
    ];
    for (const [id, owner, suffix, title, type, daysAgo, steward] of cases) {
      await db.query(
        `insert into public.member_cases(id, user_id, reference, title, case_type, step, status, steward_user_id, created_at)
         values ($1, $2, $3, $4, $5, 'Intake', 'active', $6, now() - make_interval(days => $7))`,
        [id, owner, `${REFERENCE}-${suffix}`, title, type, steward, daysAgo],
      );
    }
    ID.person = (await db.query(
      `insert into public.casework_management_people(organization_id, chapter_id, display_name, created_by)
       values ($1, $2, 'Supervisor Proof', $3) returning id`,
      [ID.org, CHAPTER, ID.steward],
    )).rows[0].id;
    // Written warning 80 days ago on the grievance (20 days after filing), a
    // discipline entry before any case (prior discipline), a retaliation entry
    // linked to the unassigned member's case 10 days after it opened.
    await entry(ID.grievance, 80, "discipline", "Written warning issued after the grievance meeting");
    await entry(ID.grievance, 150, "discipline", "Verbal counselling before any case was filed");
    await entry(ID.unassignedCase, 40, "retaliation", "Shift moved after the safety complaint");

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

  it("keeps the detector internal and the coordinator scan narrowly granted", async () => {
    const rows = (await db.query(
      `select p.oid::regprocedure::text signature, p.prosecdef,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') authenticated,
         has_function_privilege('anon', p.oid, 'EXECUTE') anon
       from pg_catalog.pg_proc p where p.oid = any($1::regprocedure[]) order by 1`,
      [["private.casework_detect_retaliation_timing(uuid,text,integer)", "public.casework_scan_retaliation_timing(text)"]],
    )).rows;
    expect(rows).toEqual([
      { signature: "casework_scan_retaliation_timing(text)", prosecdef: true, authenticated: true, anon: false },
      { signature: "private.casework_detect_retaliation_timing(uuid,text,integer)", prosecdef: true, authenticated: false, anon: false },
    ]);
  });

  it("scores the old confidence formula without letting prior discipline lower it", async () => {
    const rows = (await db.query(`select
      private.casework_retaliation_confidence(10, private.casework_retaliation_severity('Termination letter')) a,
      private.casework_retaliation_confidence(10, private.casework_retaliation_severity('Verbal note')) b,
      private.casework_retaliation_confidence(60, private.casework_retaliation_severity('Suspended')) c,
      private.casework_retaliation_confidence(200, private.casework_retaliation_severity('Written warning')) d`)).rows[0];
    expect(rows).toEqual({ a: "high", b: "medium", c: "medium", d: "low" });
  });

  it("flags discipline and a linked retaliation entry inside the window, with prior discipline counted", async () => {
    const memberBefore = await notices(ID.member);
    const stewardBefore = await notices(ID.steward);
    expect(await detect()).toBe(4);
    const grievanceFlags = await flags(ID.grievance);
    expect(grievanceFlags).toContainEqual({
      source: "timing_detector", adverse_kind: "management_entry", incident_on: await day(-80),
      protected_activity_on: await day(-100), days_between: 20, confidence: "high",
      prior_discipline_count: 1, status: "open", ulp_deadline: await day(100), notified: true,
    });
    // The Discipline case (opened 20 days ago) follows both earlier cases.
    const disciplineOnGrievance = grievanceFlags.filter((row) => row.adverse_kind === "discipline_case");
    expect(disciplineOnGrievance).toMatchObject([{ days_between: 80, confidence: "medium", prior_discipline_count: 1 }]);
    expect(await flags(ID.otherCase)).toMatchObject([{ adverse_kind: "discipline_case", days_between: 20, confidence: "high", prior_discipline_count: 2 }]);
    // A case is never its own protected activity, and a discipline entry before
    // the other case opened does not flag it.
    expect(await flags(ID.disciplineCase)).toEqual([]);
    // The retaliation entry is linked to the unassigned member's case.
    expect(await flags(ID.unassignedCase)).toMatchObject([{ adverse_kind: "management_entry", notified: false }]);

    const staff = (await notices(ID.steward)).filter((row) => !stewardBefore.some((old) => old.id === row.id));
    expect(staff.length).toBeGreaterThanOrEqual(1);
    const member = (await notices(ID.member)).filter((row) => !memberBefore.some((old) => old.id === row.id));
    expect(member.map((row) => row.title)).toContain("Your steward has been notified");
    for (const row of [...staff, ...member]) {
      for (const text of [row.title, row.body]) {
        expect(text).not.toContain(REFERENCE);
        expect(text).not.toContain("Supervisor Proof");
        expect(text).not.toMatch(/high|medium|low|warning|suspend/i);
      }
    }
    // Nobody was assigned, so the member is not told a steward was notified.
    expect(await notices(ID.unassignedMember)).toEqual([]);
    expect(await detect()).toBe(0);
  });

  it("tells the member their steward was notified on the case summary", async () => {
    const [{ summary }] = await as(ID.member, "select public.get_my_case_ulp_summary() summary");
    expect(summary.find((row) => row.caseId === ID.grievance)).toMatchObject({ retaliationFlagged: true, stewardNotified: true });
    const [{ other }] = await as(ID.unassignedMember, "select public.get_my_case_ulp_summary() other");
    expect(other).toMatchObject([{ caseId: ID.unassignedCase, retaliationFlagged: true, stewardNotified: false }]);
  });

  it("lets staff review the detector flag with the existing disposition flow", async () => {
    const [{ view }] = await as(ID.steward, "select public.casework_list_case_retaliation_flags($1) view", [ID.grievance]);
    const flag = view.flags.find((row) => row.adverseKind === "management_entry");
    expect(flag).toMatchObject({ source: "timing_detector", confidence: "high", daysBetween: 20, priorDisciplineCount: 1 });
    await as(ID.steward, "select public.casework_review_retaliation_flag($1, 'dismissed', 'Warning was scheduled before the grievance')", [flag.id]);
    expect(await detect()).toBe(0);
  });

  it("honors the switch and the window, and refuses the scan to non-coordinators", async () => {
    await db.query(
      `insert into public.organization_setting_values(organization_id, setting_key, value)
       values ($1, 'features.casework.retaliation_timing_detector', 'false'::jsonb)`,
      [ID.org],
    );
    await entry(ID.grievance, 30, "discipline", "Final written warning");
    expect(await detect()).toBe(0);
    await expect(as(ID.coordinator, "select public.casework_scan_retaliation_timing($1)", [CHAPTER]))
      .rejects.toMatchObject({ code: "55000" });
    await db.query(
      "delete from public.organization_setting_values where organization_id = $1 and setting_key = 'features.casework.retaliation_timing_detector'",
      [ID.org],
    );
    await expect(as(ID.steward, "select public.casework_scan_retaliation_timing($1)", [CHAPTER]))
      .rejects.toMatchObject({ code: "P0002" });
    await db.query(
      `insert into public.organization_setting_values(organization_id, setting_key, value)
       values ($1, 'limits.casework.retaliation_window_days', '60'::jsonb)`,
      [ID.org],
    );
    // 70 days after the grievance: outside a 60-day window; inside for the other case.
    const [{ n }] = await as(ID.coordinator, "select public.casework_scan_retaliation_timing($1) n", [CHAPTER]);
    expect(n).toBe(1);
    expect((await flags(ID.grievance)).map((row) => row.incident_on)).not.toContain(await day(-30));
    expect((await flags(ID.otherCase)).map((row) => row.adverse_kind)).toEqual(["management_entry", "discipline_case"]);
  });
});
