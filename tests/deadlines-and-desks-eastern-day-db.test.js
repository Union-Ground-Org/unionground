// @vitest-environment node
//
// BUG-UG-FUNCTIONS-AND-DATE-DEFAULTS-READ-THE-UTC-DAY-20261112 (#8568), part B:
// casework deadlines and the staff desks count days on the Eastern day,
// whatever the session time zone. The hosted projects run in UTC, so from
// 7 PM Eastern the UTC day is already tomorrow. A test cannot move now(), so
// it pins the session time zone instead, as the #8563 proof does: the zone it
// picks always sits on a different date from Eastern at the moment the test
// runs (UTC+14 when its date is already tomorrow, otherwise UTC-12, which is
// still yesterday). A reader of the session day then gets days left one off,
// and a desk counts a case due today as overdue (UTC+14) or leaves a case due
// in six days out of its due-soon week (UTC-12).
//
// BUG-UG-ULP-DEADLINE-FROM-AN-EVENING-MEMBER-REPORT-LANDS-A-DAY-LATE-20261115 (#8868), in
// this part: a retaliation incident at 9:30 PM Eastern is 01:30 or 02:30 UTC the next day, so the
// sweep and the timing detector, which dated it on the UTC day, gave it tomorrow's date and a ULP
// filing deadline one day late. These cases fail on the UTC day in every session zone. Flags
// already stored that way are corrected by the migration itself (#9003).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { connectLocal } from "./helpers/local-lifecycle-contention.mjs";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

// The migration's stored-flag correction (#9003: member reports and the timing
// detector), run again here on fixture rows dated the old way.
const migration = loadMigrationSql("deadlines_and_desks_eastern_day");
const between = (start, end) => migration.slice(migration.indexOf(start), migration.indexOf(end, migration.indexOf(start)) + end.length);
const CORRECTION = between("do $flag_correction$", "$flag_correction$;");

const ID = {
  org: "50908568-0000-4000-8000-000000000b01",
  steward: "50908568-0000-4000-8000-000000000b11",
  member: "50908568-0000-4000-8000-000000000b12",
  dueToday: "50908568-0000-4000-8000-000000000b21",
  dueInSix: "50908568-0000-4000-8000-000000000b22",
  dueYesterday: "50908568-0000-4000-8000-000000000b23",
  grievance: "50908568-0000-4000-8000-000000000b31",
  discipline: "50908568-0000-4000-8000-000000000b32",
};
// 9:30 PM Eastern on Tuesday, November 3, 2026 (02:30 UTC on November 4), and
// a grievance filed at 9 PM Eastern ten days before it.
const EVENING_INCIDENT = "2026-11-03 21:30:00 America/New_York";
const EVENING_GRIEVANCE = "2026-10-24 21:00:00 America/New_York";
const CHAPTER = "casework-deadlines-eastern-day";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("casework deadlines and the desks read the Eastern day on a disposable database", () => {
  let db;
  let easternToday;
  let offZone;

  // Runs one statement in a session pinned to timeZone.
  async function inZone(statement, values = [], timeZone = "UTC") {
    await db.query("savepoint casework_deadlines_eastern_day");
    try {
      await db.query("select set_config('TimeZone', $1, true)", [timeZone]);
      const result = await db.query(statement, values);
      return { code: "", rows: result.rows, message: "" };
    } catch (error) {
      return { code: error.code || "?", rows: [], message: error.message || "" };
    } finally {
      await db.query("rollback to savepoint casework_deadlines_eastern_day");
      await db.query("release savepoint casework_deadlines_eastern_day");
    }
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "casework-deadlines-eastern-day-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '30s'");
    await db.query("set local lock_timeout = '15s'");
    const { rows: [clock] } = await db.query(
      `select (now() at time zone 'America/New_York')::date::text as today,
              case when (now() at time zone 'Etc/GMT-14')::date <> (now() at time zone 'America/New_York')::date
                   then 'Etc/GMT-14' else 'Etc/GMT+12' end as off_zone`,
    );
    easternToday = clock.today;
    offZone = clock.off_zone;
    for (const [user, email] of [[ID.steward, "casework-deadlines-steward@example.invalid"], [ID.member, "casework-deadlines-member@example.invalid"]]) {
      await db.query("insert into auth.users(id,email) values($1,$2)", [user, email]);
    }
    await db.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,'casework-deadlines-eastern-org','Casework deadlines Eastern day',$2)",
      [ID.org, ID.steward],
    );
    await db.query(
      "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9924)",
      [CHAPTER, ID.org],
    );
    for (const [user, name] of [[ID.steward, "Deadline Steward"], [ID.member, "Deadline Member"]]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ID.org, user]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, CHAPTER]);
      await db.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user, CHAPTER, name]);
    }
    await db.query(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$2)",
      [ID.org, ID.steward],
    );
    // Due today, due in six days (the last day of the due-soon week) and due
    // yesterday, all on the Eastern calendar.
    for (const [id, days, reference] of [[ID.dueToday, 0, "EASTERN-DUE-TODAY"], [ID.dueInSix, 6, "EASTERN-DUE-SIX"], [ID.dueYesterday, -1, "EASTERN-DUE-YESTERDAY"]]) {
      await db.query(
        `insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,step,articles,status,deadline,steward_user_id)
         values($1,$2,$3,$3,'other',$4,$5,'Step 2','Article 5','active',$6::date + $7::integer,$8)`,
        [id, ID.member, reference, ID.org, CHAPTER, easternToday, days, ID.steward],
      );
    }
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  // Runs work() inside a savepoint in a session pinned to timeZone, then rolls it back.
  async function rolledBack(work, timeZone = "UTC") {
    await db.query("savepoint deadlines_eastern_work");
    try {
      await db.query("select set_config('TimeZone', $1, true)", [timeZone]);
      return await work();
    } finally {
      await db.query("rollback to savepoint deadlines_eastern_work");
      await db.query("release savepoint deadlines_eastern_work");
    }
  }

  it("picks a session time zone that sits on another date from Eastern right now", async () => {
    const { rows: [zone] } = await db.query("select (now() at time zone $1)::date::text as there", [offZone]);
    expect(zone.there).not.toBe(easternToday);
  });

  it("counts a retaliation flag's days left from today's Eastern date, in every session time zone", async () => {
    for (const timeZone of ["UTC", offZone, "America/New_York"]) {
      const result = await inZone(
        `select private.casework_retaliation_flag_json(
           pg_catalog.jsonb_populate_record(null::public.casework_retaliation_flags,
             pg_catalog.jsonb_build_object('ulp_deadline', $1::date + 10, 'safety_deadline', $1::date)),
           true) as flag`,
        [easternToday], timeZone,
      );
      expect(result.code, `${timeZone}: ${result.message}`).toBe("");
      expect(result.rows[0].flag.daysLeft, timeZone).toBe(10);
      expect(result.rows[0].flag.safetyDaysLeft, timeZone).toBe(0);
    }
  });

  it("dates a member's 9:30 PM Eastern retaliation report on that Eastern day, with the ULP deadline exactly the window later (#8868)", async () => {
    for (const timeZone of ["UTC", offZone, "America/New_York"]) {
      const flag = await rolledBack(async () => {
        const report = randomUUID();
        await db.query("alter table public.casework_retaliation_reports disable trigger sensitive_envelopes");
        await db.query(
          `insert into public.casework_retaliation_reports(id, organization_id, chapter_id, reporter_user_id, case_id, incident_at,
             management_person, protected_activity, adverse_action, idempotency_key)
           values ($1, $2, $3, $4, $5, $6::timestamptz, '[encrypted]', '[encrypted]', '[encrypted]', gen_random_uuid())`,
          [report, ID.org, CHAPTER, ID.member, ID.dueToday, EVENING_INCIDENT],
        );
        await db.query("alter table public.casework_retaliation_reports enable trigger sensitive_envelopes");
        await db.query("select private.casework_sweep_ulp_deadlines(200)");
        return (await db.query(
          `select incident_on::text, ulp_window_days, ulp_deadline::text, (incident_on + ulp_window_days)::text as expected
           from public.casework_retaliation_flags where source = 'member_report' and source_id = $1`, [report],
        )).rows[0];
      }, timeZone);
      expect(flag, timeZone).toBeTruthy();
      expect(flag.incident_on, timeZone).toBe("2026-11-03");
      expect(flag.ulp_deadline, timeZone).toBe(flag.expected);
      if (flag.ulp_window_days === 180) expect(flag.ulp_deadline, timeZone).toBe("2027-05-02");
    }
  });

  it("dates an evening discipline case and an evening grievance on their Eastern days in the timing detector (#8868)", async () => {
    for (const timeZone of ["UTC", offZone, "America/New_York"]) {
      const flag = await rolledBack(async () => {
        for (const [id, suffix, title, type, at] of [
          [ID.grievance, "G", "Evening scheduling grievance", "Scheduling", EVENING_GRIEVANCE],
          [ID.discipline, "D", "Evening suspension", "Discipline", EVENING_INCIDENT],
        ]) {
          await db.query(
            `insert into public.member_cases(id, user_id, reference, title, case_type, organization_id, chapter_id, step, status, steward_user_id, created_at)
             values ($1, $2, $3, $4, $5, $6, $7, 'Intake', 'active', $8, $9::timestamptz)`,
            [id, ID.member, `EASTERN-${suffix}`, title, type, ID.org, CHAPTER, ID.steward, at],
          );
        }
        const adverse = (await db.query(
          "select adverse_on::text from private.casework_retaliation_adverse_events('2026-10-01') where adverse_id = $1", [ID.discipline],
        )).rows[0];
        await db.query("select private.casework_detect_retaliation_timing($1, $2, 200)", [ID.org, CHAPTER]);
        const stored = (await db.query(
          `select incident_on::text, protected_activity_on::text, days_between, ulp_deadline::text, (incident_on + ulp_window_days)::text as expected
           from public.casework_retaliation_flags where source = 'timing_detector' and case_id = $1 and source_id = $2`,
          [ID.grievance, ID.discipline],
        )).rows[0];
        return { adverse, stored };
      }, timeZone);
      expect(flag.adverse, timeZone).toEqual({ adverse_on: "2026-11-03" });
      expect(flag.stored, timeZone).toMatchObject({ incident_on: "2026-11-03", protected_activity_on: "2026-10-24", days_between: 10 });
      expect(flag.stored.ulp_deadline, timeZone).toBe(flag.stored.expected);
    }
  });

  // #9003: the migration corrects stored flags dated on the UTC day instead of refusing on them.
  // Each case runs the migration's own correction block on fixture rows stored the old way. The
  // block runs once first, so a flag another proof left behind cannot change the counts.
  async function correction() {
    const notices = [];
    const listen = (notice) => notices.push(notice.message);
    db.on("notice", listen);
    try {
      await db.query(CORRECTION);
    } finally {
      db.off("notice", listen);
    }
    return notices.filter((message) => message.startsWith("#8868 stored flags corrected"));
  }
  const counts = (memberReport, managementEntry, disciplineCase) => [
    `#8868 stored flags corrected: member_report ${memberReport}, timing_detector management_entry ${managementEntry}, timing_detector discipline_case ${disciplineCase}`,
  ];
  async function report(at) {
    const id = randomUUID();
    await db.query("alter table public.casework_retaliation_reports disable trigger sensitive_envelopes");
    await db.query(
      `insert into public.casework_retaliation_reports(id, organization_id, chapter_id, reporter_user_id, case_id, incident_at,
         management_person, protected_activity, adverse_action, idempotency_key)
       values ($1, $2, $3, $4, $5, $6::timestamptz, '[encrypted]', '[encrypted]', '[encrypted]', gen_random_uuid())`,
      [id, ID.org, CHAPTER, ID.member, ID.dueToday, at],
    );
    await db.query("alter table public.casework_retaliation_reports enable trigger sensitive_envelopes");
    return id;
  }
  async function memberCase(type, title, at) {
    const id = randomUUID();
    await db.query(
      `insert into public.member_cases(id, user_id, reference, title, case_type, organization_id, chapter_id, step, status, steward_user_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'Intake', 'active', $8, $9::timestamptz)`,
      [id, ID.member, `EASTERN-FIX-${id.slice(0, 8)}`, title, type, ID.org, CHAPTER, ID.steward, at],
    );
    return id;
  }
  // A timing-detector flag as the old detector stored it.
  async function timingFlag(grievance, source, kind, incidentOn, protectedOn, days, confidence, prior) {
    return (await db.query(
      `insert into public.casework_retaliation_flags(case_id, organization_id, chapter_id, source, source_id, incident_on, ulp_window_days,
         adverse_kind, protected_activity_on, days_between, confidence, prior_discipline_count)
       values ($1, $2, $3, 'timing_detector', $4, $5, 180, $6, $7, $8, $9, $10) returning id`,
      [grievance, ID.org, CHAPTER, source, incidentOn, kind, protectedOn, days, confidence, prior],
    )).rows[0].id;
  }
  const FLAG = `select incident_on::text, ulp_window_days, ulp_deadline::text, safety_deadline::text, ulp_window_basis,
      protected_activity_category, status, note, reviewed_by, reviewed_at::text, warning_sent_at::text, urgent_sent_at::text,
      staff_notified_at::text, protected_activity_on::text, days_between, confidence, prior_discipline_count, updated_at::text
    from public.casework_retaliation_flags where id = $1`;
  const flag = async (id) => (await db.query(FLAG, [id])).rows[0];
  const audits = async (id) => (await db.query(
    `select actor_user_id, event_type, metadata from public.casework_audit_events
     where entity_type = 'retaliation_flag' and entity_id = $1 and event_type = 'bulk_updated' order by created_at, id`, [id],
  )).rows;

  it("puts the correction after every function replacement, takes the case-graph gate first, and refuses nowhere (#9003)", () => {
    expect(CORRECTION.startsWith("do $flag_correction$")).toBe(true);
    expect(migration.lastIndexOf("CREATE OR REPLACE FUNCTION")).toBeLessThan(migration.indexOf("do $flag_correction$"));
    expect(migration.lastIndexOf("create or replace function")).toBeLessThan(migration.indexOf("do $flag_correction$"));
    expect(CORRECTION.indexOf("perform private.lock_case_graph(")).toBeLessThan(CORRECTION.indexOf("for v_flag in"));
    expect(migration).not.toMatch(/\$member_report_guard\$|\$timing_guard\$/u);
    expect(CORRECTION).not.toMatch(/delete from|status\s*=/iu);
  });

  it("moves a member-report flag to its Eastern date with its deadlines, keeps every review field, audits it once, and changes nothing on a second run (#9003)", async () => {
    const result = await rolledBack(async () => {
      await correction();
      const evening = await report(EVENING_INCIDENT);
      const noon = await report("2026-11-03 12:00:00 America/New_York");
      // The date the sweep stored before #8868: the UTC day of 02:30 UTC. This one was also
      // reviewed, warned about, and is a safety-and-health flag with its 30-day deadline.
      const misdated = (await db.query(
        `insert into public.casework_retaliation_flags(case_id, organization_id, chapter_id, source, source_id, incident_on, ulp_window_days,
           status, note, reviewed_by, reviewed_at, warning_sent_at, protected_activity_category, safety_deadline)
         values ($1, $2, $3, 'member_report', $4, '2026-11-04', 180, 'confirmed', 'Confirmed with the member.', $5,
           '2026-11-05 15:00:00+00', '2026-11-06 15:00:00+00', 'safety_health', '2026-12-04') returning id`,
        [ID.dueToday, ID.org, CHAPTER, evening, ID.steward],
      )).rows[0].id;
      const dayTime = (await db.query(
        `insert into public.casework_retaliation_flags(case_id, organization_id, chapter_id, source, source_id, incident_on, ulp_window_days)
         values ($1, $2, $3, 'member_report', $4, '2026-11-03', 180) returning id`,
        [ID.dueToday, ID.org, CHAPTER, noon],
      )).rows[0].id;
      const before = { misdated: await flag(misdated), dayTime: await flag(dayTime) };
      const first = await correction();
      const after = { misdated: await flag(misdated), dayTime: await flag(dayTime) };
      const audited = await audits(misdated);
      const second = await correction();
      return { before, first, after, audited, second, again: await flag(misdated), auditedAgain: await audits(misdated), dayAudits: await audits(dayTime) };
    });
    expect(result.first).toEqual(counts(1, 0, 0));
    const { updated_at: _changed, ...kept } = result.before.misdated;
    expect(result.after.misdated).toEqual({
      ...kept,
      incident_on: "2026-11-03",
      ulp_deadline: "2027-05-02",
      safety_deadline: "2026-12-03",
      updated_at: result.after.misdated.updated_at,
    });
    expect(result.after.misdated).toMatchObject({ status: "confirmed", note: "Confirmed with the member.", reviewed_by: ID.steward, ulp_window_basis: "organization_limit", ulp_window_days: 180 });
    expect(result.after.dayTime).toEqual(result.before.dayTime);
    expect(result.audited).toHaveLength(1);
    expect(result.audited[0]).toMatchObject({ actor_user_id: null, event_type: "bulk_updated" });
    expect(result.audited[0].metadata).toMatchObject({
      change: "incident date moved to the Eastern calendar (#8868)", source: "member_report",
      previousIncidentOn: "2026-11-04", incidentOn: "2026-11-03", previousUlpWindowDays: 180, ulpWindowDays: 180,
      previousUlpDeadline: "2027-05-03", ulpDeadline: "2027-05-02", previousSafetyDeadline: "2026-12-04", safetyDeadline: "2026-12-03",
    });
    expect(result.second).toEqual(counts(0, 0, 0));
    expect(result.again).toEqual(result.after.misdated);
    expect(result.auditedAgain).toHaveLength(1);
    expect(result.dayAudits).toHaveLength(0);
  });

  it("recounts a jurisdiction's month window from the Eastern date, as the insert trigger does (#9003)", async () => {
    const result = await rolledBack(async () => {
      await correction();
      const period = (await db.query(
        "select period_value, period_unit from private.reference_ulp_limitation_periods where jurisdiction = 'MA'",
      )).rows[0];
      // 9:30 PM Eastern on Sunday, August 30, 2026 is 01:30 UTC on August 31. Six months from
      // August 31 is 181 days (to February 28); from August 30 it is 182 days, to the same day.
      const id = await report("2026-08-30 21:30:00 America/New_York");
      await db.query("alter table public.casework_retaliation_flags disable trigger m10_ulp_jurisdiction_window");
      const misdated = (await db.query(
        `insert into public.casework_retaliation_flags(case_id, organization_id, chapter_id, source, source_id, incident_on, ulp_window_days, ulp_window_basis)
         values ($1, $2, $3, 'member_report', $4, '2026-08-31', 181, 'jurisdiction:MA') returning id`,
        [ID.dueToday, ID.org, CHAPTER, id],
      )).rows[0].id;
      await db.query("alter table public.casework_retaliation_flags enable trigger m10_ulp_jurisdiction_window");
      const before = await flag(misdated);
      return { period, before, counted: await correction(), after: await flag(misdated) };
    });
    expect(result.period).toEqual({ period_value: 6, period_unit: "month" });
    expect(result.before).toMatchObject({ incident_on: "2026-08-31", ulp_window_days: 181, ulp_deadline: "2027-02-28" });
    expect(result.counted).toEqual(counts(1, 0, 0));
    // Moving the date alone would keep 181 days and give February 27.
    expect(result.after).toMatchObject({ incident_on: "2026-08-30", ulp_window_days: 182, ulp_deadline: "2027-02-28", ulp_window_basis: "jurisdiction:MA" });
  });

  it("moves timing-detector flags from a management entry and a discipline case to their Eastern dates and recomputes their day counts and confidence (#9003)", async () => {
    const result = await rolledBack(async () => {
      await correction();
      // A grievance filed at noon on October 5 (the same day in UTC and Eastern) and a written
      // warning logged at 9:30 PM Eastern on November 3: the UTC day made it 30 days (medium),
      // the Eastern day makes it 29 (high).
      const noonGrievance = await memberCase("Scheduling", "Noon scheduling grievance", "2026-10-05 12:00:00 America/New_York");
      const person = (await db.query(
        "insert into public.casework_management_people(organization_id, chapter_id, display_name, created_by) values ($1, $2, 'Supervisor Eastern Fix', $3) returning id",
        [ID.org, CHAPTER, ID.steward],
      )).rows[0].id;
      const entry = (await db.query(
        `insert into public.casework_management_entries(management_person_id, case_id, organization_id, chapter_id, occurred_at, category, summary, created_by)
         values ($1, $2, $3, $4, $5::timestamptz, 'retaliation', 'Written warning after the grievance', $6) returning id`,
        [person, noonGrievance, ID.org, CHAPTER, EVENING_INCIDENT, ID.steward],
      )).rows[0].id;
      const fromEntry = await timingFlag(noonGrievance, entry, "management_entry", "2026-11-04", "2026-10-05", 30, "medium", 0);
      // An evening grievance (October 24 Eastern, October 25 UTC) and an evening suspension:
      // both dates move back a day, so the count stays 10.
      const eveningGrievance = await memberCase("Scheduling", "Evening scheduling grievance", EVENING_GRIEVANCE);
      const suspension = await memberCase("Discipline", "Evening suspension", EVENING_INCIDENT);
      const fromCase = await timingFlag(eveningGrievance, suspension, "discipline_case", "2026-11-04", "2026-10-25", 10, "high", 2);
      // A daytime suspension (the same date in UTC and Eastern) stays as stored.
      const daytime = await memberCase("Discipline", "Daytime suspension", "2026-11-03 12:00:00 America/New_York");
      const fromDaytime = await timingFlag(eveningGrievance, daytime, "discipline_case", "2026-11-03", "2026-10-25", 9, "high", 0);
      const daytimeBefore = await flag(fromDaytime);
      const counted = await correction();
      const corrected = { fromEntry: await flag(fromEntry), fromCase: await flag(fromCase) };
      return {
        counted, ...corrected,
        entryAudit: (await audits(fromEntry))[0]?.metadata, caseAudit: (await audits(fromCase))[0]?.metadata,
        daytimeBefore, daytimeAfter: await flag(fromDaytime), daytimeAudits: await audits(fromDaytime),
        again: await correction(), corrected,
        afterAgain: { fromEntry: await flag(fromEntry), fromCase: await flag(fromCase) },
        auditsAgain: [(await audits(fromEntry)).length, (await audits(fromCase)).length],
      };
    });
    expect(result.counted).toEqual(counts(0, 1, 1));
    expect(result.daytimeAfter).toEqual(result.daytimeBefore);
    expect(result.daytimeAudits).toHaveLength(0);
    expect(result.again).toEqual(counts(0, 0, 0));
    expect(result.afterAgain).toEqual(result.corrected);
    expect(result.auditsAgain).toEqual([1, 1]);
    expect(result.fromEntry).toMatchObject({ incident_on: "2026-11-03", protected_activity_on: "2026-10-05", days_between: 29, confidence: "high", ulp_deadline: "2027-05-02", prior_discipline_count: 0, status: "open" });
    expect(result.fromCase).toMatchObject({ incident_on: "2026-11-03", protected_activity_on: "2026-10-24", days_between: 10, confidence: "high", ulp_deadline: "2027-05-02", prior_discipline_count: 2, status: "open" });
    expect(result.entryAudit).toMatchObject({ source: "timing_detector", adverseKind: "management_entry", previousDaysBetween: 30, daysBetween: 29, previousConfidence: "medium", confidence: "high", previousProtectedActivityOn: "2026-10-05", protectedActivityOn: "2026-10-05" });
    expect(result.caseAudit).toMatchObject({ source: "timing_detector", adverseKind: "discipline_case", previousIncidentOn: "2026-11-04", incidentOn: "2026-11-03", previousProtectedActivityOn: "2026-10-25", protectedActivityOn: "2026-10-24", daysBetween: 10 });
  });

  // The discipline cases' one-year bound is taken on the Eastern calendar before the
  // conversion. Daylight time ended on November 2 in 2025 and November 1 in 2026, so midnight
  // Eastern on November 2 is 05:00 UTC in 2026 and 04:00 UTC in 2025. Subtracting the year after
  // the conversion kept 05:00 UTC in a UTC session and left out a case opened at 12:30 AM.
  it("keeps a discipline case from the first hour of the day a year back, across a daylight-time change, in every session time zone (ledger 428)", async () => {
    for (const timeZone of ["UTC", offZone, "America/New_York"]) {
      const found = await rolledBack(async () => {
        const id = await memberCase("Discipline", "Early morning suspension", "2025-11-02 00:30:00 America/New_York");
        return (await db.query(
          "select adverse_on::text from private.casework_retaliation_adverse_events('2026-11-02') where adverse_id = $1", [id],
        )).rows;
      }, timeZone);
      expect(found, timeZone).toEqual([{ adverse_on: "2025-11-02" }]);
    }
  });

  it("stops for a person when a corrected timing flag would come before its protected activity, and deletes nothing (#9003)", async () => {
    const result = await rolledBack(async () => {
      await correction();
      // A grievance at 1 AM Eastern on November 4 and a suspension at 9:30 PM Eastern on
      // November 3: the same UTC day (0 days), but on the Eastern calendar the suspension came first.
      const grievance = await memberCase("Scheduling", "Early morning grievance", "2026-11-04 01:00:00 America/New_York");
      const suspension = await memberCase("Discipline", "Evening suspension", EVENING_INCIDENT);
      const id = await timingFlag(grievance, suspension, "discipline_case", "2026-11-04", "2026-11-04", 0, "high", 0);
      await db.query("savepoint flag_correction_refusal");
      let outcome;
      try {
        await correction();
        outcome = { code: "" };
      } catch (error) {
        outcome = { code: error.code, message: error.message };
      } finally {
        await db.query("rollback to savepoint flag_correction_refusal");
      }
      return { outcome, kept: await flag(id) };
    });
    expect(result.outcome).toEqual({ code: "55000", message: "#8868: a stored timing-detector flag would come before its protected activity on the Eastern calendar; a person must decide it" });
    expect(result.kept).toMatchObject({ incident_on: "2026-11-04", protected_activity_on: "2026-11-04", days_between: 0, status: "open" });
  });

  it("puts a case due today and one due in six days in the steward's due-soon week and only yesterday's in overdue, in every session time zone", async () => {
    for (const timeZone of ["UTC", offZone, "America/New_York"]) {
      const result = await inZone("select private.workload_rebalancing($1) as value", [CHAPTER], timeZone);
      expect(result.code, `${timeZone}: ${result.message}`).toBe("");
      const steward = result.rows[0].value.stewards.find((row) => row.userId === ID.steward);
      expect(steward, timeZone).toBeTruthy();
      expect({ active: steward.activeCases, dueSoon: steward.dueSoon, overdue: steward.overdue }, timeZone)
        .toEqual({ active: 3, dueSoon: 2, overdue: 1 });
    }
  });
});

// The correction takes the
// case-graph gate before it reads a flag, so a producer that calls in later waits and then runs
// the new body. A sweep that had already started on the OLD body when the migration took the gate
// waits too, and after the gate is released it still runs the old body: it stores one member
// report on the UTC day, and later sweeps skip that report because it now has a flag. The cover
// is operational (dispatch away from the sweep's minute, count again after the apply and after
// the next run, correct what the count finds); this proves the late flag is exactly what the
// count's selection and a second run of the correction catch. The old body runs as a session
// copy (pg_temp), as a call already executing keeps the body it started with. Its fixtures go in
// with triggers off, so it holds no gate before its call, and both connections roll back:
// nothing here is committed.
live("a sweep already running the old body while the stored-flag correction holds the gate (ledger 442)", () => {
  const OLD_SWEEP = fnBody(loadMigrationSql("learning_period_case_records"), "private.casework_sweep_ulp_deadlines")
    .replace("private.casework_sweep_ulp_deadlines(", "pg_temp.casework_sweep_ulp_deadlines_before_8868(");

  // The gate's first lock (message lifecycle) waits at most 3 s, then fails with 55P03. The
  // observer and the holder's release must both land inside that window, so an attempt in which
  // scheduling let the waiting sweep time out is rolled back on both connections and run again
  // with new uncommitted fixtures, up to MAX_ATTEMPTS. Only that timeout is retried: a 55P03 whose
  // PL/pgSQL context is exactly the old sweep's first statement, calling lock_case_graph, calling
  // lock_message_lifecycle at its blocking advisory-lock statement. A 55P03 from anywhere else
  // (the flag insert, a later nested call, an unknown context) and every other error fail at once,
  // and running out of attempts fails with what each attempt saw. The product's 3 s bound is unchanged.
  const MAX_ATTEMPTS = 4;
  const LOCK_TIMEOUT = { code: "55P03", message: "canceling statement due to lock timeout" };
  // The 1-based PL/pgSQL line of a statement in a function body, as error contexts number them.
  const lineOf = (source, statement) => {
    const lines = source.split("\n").map((line, index) => (line.includes(statement) ? index + 1 : 0)).filter(Boolean);
    if (lines.length !== 1) throw new Error(`expected one line with ${statement}, found ${lines.length}`);
    return lines[0];
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const BLOCKED_ON_GATE = `select $2::int = any(pg_catalog.pg_blocking_pids($1::int)) as blocked,
      exists (select 1 from pg_locks l where l.pid = $1::int and l.locktype = 'advisory' and not l.granted) as gate_wait,
      (select pg_catalog.jsonb_build_object('state', a.state, 'waitEventType', a.wait_event_type, 'waitEvent', a.wait_event)
         from pg_stat_activity a where a.pid = $1::int) as activity`;
  const FLAG_OF_REPORT = `select incident_on::text, ulp_window_days, ulp_deadline::text from public.casework_retaliation_flags
    where source = 'member_report' and source_id = $1`;

  it("stores one UTC-dated flag after the gate is released, the new sweep skips it, and the correction run again moves it to the Eastern date", async () => {
    expect(OLD_SWEEP).toMatch(/^create or replace function pg_temp\.casework_sweep_ulp_deadlines_before_8868\(/u);
    expect(OLD_SWEEP.indexOf("perform private.lock_case_graph(")).toBeLessThan(OLD_SWEEP.indexOf("for v_report in"));
    expect(OLD_SWEEP).toContain("(v_report.incident_at at time zone 'UTC')::date");
    const url = process.env.SUPABASE_DB_URL;
    const owner = await connectLocal(url, "flag-correction-race-owner");
    const correcting = await connectLocal(url, "flag-correction-race-correction");
    const sweeping = await connectLocal(url, "flag-correction-race-old-sweep");
    const sweepPid = (await sweeping.query("select pg_backend_pid() pid")).rows[0].pid;
    const correctionPid = (await correcting.query("select pg_backend_pid() pid")).rows[0].pid;
    const source = async (signature) => (await owner.query("select prosrc from pg_catalog.pg_proc where oid = $1::regprocedure", [signature])).rows[0].prosrc;
    const sweepSource = OLD_SWEEP.slice(OLD_SWEEP.indexOf("$function$") + "$function$".length, OLD_SWEEP.lastIndexOf("$function$"));
    const GATE_ENTRY = [
      `PL/pgSQL function private.lock_message_lifecycle() line ${lineOf(await source("private.lock_message_lifecycle()"),
        "perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('message-lifecycle-global', 0));")} at PERFORM`,
      `PL/pgSQL function private.lock_case_graph(uuid[],uuid[]) line ${lineOf(await source("private.lock_case_graph(uuid[],uuid[])"),
        "perform private.lock_message_lifecycle();")} at PERFORM`,
      new RegExp(`^PL/pgSQL function pg_temp_\\d+\\.casework_sweep_ulp_deadlines_before_8868\\(integer\\) line ${lineOf(sweepSource,
        "perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);")} at PERFORM$`, "u"),
    ];
    // True only for the gate-entry lock timeout; the frames are the PL/pgSQL lines of error.where.
    const gateEntryTimeout = (error) => {
      if (error?.code !== LOCK_TIMEOUT.code || error.message !== LOCK_TIMEOUT.message) return false;
      const frames = String(error.where ?? "").split("\n").filter((line) => line.startsWith("PL/pgSQL function "));
      return frames.length === 3 && frames[0] === GATE_ENTRY[0] && frames[1] === GATE_ENTRY[1] && GATE_ENTRY[2].test(frames[2]);
    };

    // One attempt: the sweep's uncommitted fixtures, the correction holding the gate, the old sweep
    // waiting on it, the release. Returns { retry } when the sweep's gate wait timed out.
    async function contend(attempt) {
      const org = randomUUID();
      const chapter = `flag-race-${org}`;
      const member = randomUUID();
      const memberCase = randomUUID();
      const report = randomUUID();
      await sweeping.query("begin");
      await sweeping.query(OLD_SWEEP);
      await sweeping.query("set local session_replication_role = replica");
      await sweeping.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org, chapter]);
      await sweeping.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9925)", [chapter, org]);
      await sweeping.query("insert into auth.users(id,email) values ($1,$2)", [member, `${member}@example.invalid`]);
      await sweeping.query(
        `insert into public.member_cases(id, user_id, reference, title, case_type, organization_id, chapter_id, step, status, created_at)
         values ($1, $2, $3, 'Evening retaliation', 'other', $4, $5, 'Intake', 'active', $6::timestamptz)`,
        [memberCase, member, `FLAG-RACE-${memberCase.slice(0, 8)}`, org, chapter, EVENING_INCIDENT],
      );
      await sweeping.query(
        `insert into public.casework_retaliation_reports(id, organization_id, chapter_id, reporter_user_id, case_id, incident_at,
           management_person, protected_activity, adverse_action, idempotency_key)
         values ($1, $2, $3, $4, $5, $6::timestamptz, '[encrypted]', '[encrypted]', '[encrypted]', gen_random_uuid())`,
        [report, org, chapter, member, memberCase, EVENING_INCIDENT],
      );
      await sweeping.query("set local session_replication_role = origin");
      const held = (await owner.query("select count(*)::int n from pg_locks where pid = $1::int and locktype = 'advisory'", [sweepPid])).rows[0].n;
      if (held !== 0) throw new Error(`attempt ${attempt}: the old sweep held ${held} advisory locks before its call`);

      // The correction takes the gate; the old sweep that starts now waits on it. Its outcome is
      // captured at once, so an early failure is examined here, not left as an unhandled rejection.
      await correcting.query("begin");
      await correcting.query(CORRECTION);
      let settled = null;
      const oldSweep = sweeping.query("select pg_temp.casework_sweep_ulp_deadlines_before_8868(1000) as stored")
        .then((result) => { settled = { stored: result.rows[0].stored }; return settled; },
          (error) => { settled = { error: { code: error.code, message: error.message, where: error.where } }; return settled; });
      // Wait for the real blocking edge, not a fixed delay: the correction's backend blocks the
      // sweep's backend on an advisory lock of the gate (the message-lifecycle lock, then 509/700;
      // the correction holds no other advisory lock).
      const deadline = Date.now() + 5000;
      let observed = (await owner.query(BLOCKED_ON_GATE, [sweepPid, correctionPid])).rows[0];
      while (!(observed.blocked && observed.gate_wait) && !settled && Date.now() < deadline) {
        await sleep(20);
        observed = (await owner.query(BLOCKED_ON_GATE, [sweepPid, correctionPid])).rows[0];
      }
      if (!(observed.blocked && observed.gate_wait)) {
        await correcting.query("rollback");
        const swept = await oldSweep;
        if (gateEntryTimeout(swept.error)) return { retry: true, seen: { attempt, stage: "observe", swept, observed } };
        throw new Error(`attempt ${attempt}: the old sweep never waited on the correction's gate: ${JSON.stringify({ observed, swept })}`);
      }
      expect(observed.activity, `attempt ${attempt}`).toMatchObject({ waitEventType: "Lock", waitEvent: "advisory" });
      // The gate is released when the correction's transaction ends, commit or rollback alike.
      // It rolls back here so it changes no other proof's rows.
      await correcting.query("rollback");
      const swept = await oldSweep;
      if (gateEntryTimeout(swept.error)) return { retry: true, seen: { attempt, stage: "release", swept } };
      if (swept.error) throw new Error(`attempt ${attempt}: the old sweep failed after the release: ${JSON.stringify(swept.error)}`);
      expect(swept.stored, `attempt ${attempt}`).toBeGreaterThanOrEqual(1);
      return { retry: false, report, seen: { attempt, stage: "crossed" } };
    }

    try {
      const seen = [];
      let crossed = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !crossed; attempt += 1) {
        const outcome = await contend(attempt);
        seen.push(outcome.seen);
        if (outcome.retry) {
          await correcting.query("rollback").catch(() => {});
          await sweeping.query("rollback").catch(() => {});
        } else {
          crossed = outcome;
        }
      }
      expect(crossed, `no attempt crossed the gate in ${MAX_ATTEMPTS}: ${JSON.stringify(seen)}`).toBeTruthy();

      // The attempt that crossed the observed gate: its sweep ran the old body after the release.
      const late = (await sweeping.query(FLAG_OF_REPORT, [crossed.report])).rows;
      await sweeping.query("select private.casework_sweep_ulp_deadlines(1000)");
      const afterNewSweep = (await sweeping.query(FLAG_OF_REPORT, [crossed.report])).rows;
      const notices = [];
      const listen = (notice) => notices.push(notice.message);
      sweeping.on("notice", listen);
      try {
        await sweeping.query(CORRECTION);
      } finally {
        sweeping.off("notice", listen);
      }
      const corrected = (await sweeping.query(FLAG_OF_REPORT, [crossed.report])).rows;
      await sweeping.query("rollback");

      expect(late).toEqual([{ incident_on: "2026-11-04", ulp_window_days: 180, ulp_deadline: "2027-05-03" }]);
      expect(afterNewSweep).toEqual(late);
      expect(notices.filter((message) => message.startsWith("#8868 stored flags corrected"))).toEqual([
        "#8868 stored flags corrected: member_report 1, timing_detector management_entry 0, timing_detector discipline_case 0",
      ]);
      expect(corrected).toEqual([{ incident_on: "2026-11-03", ulp_window_days: 180, ulp_deadline: "2027-05-02" }]);
    } finally {
      await correcting.query("rollback").catch(() => {});
      await sweeping.query("rollback").catch(() => {});
      await Promise.allSettled([owner.end(), correcting.end(), sweeping.end()]);
    }
  }, 60_000);
});
