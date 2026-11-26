// @vitest-environment node
//
// BUG-UG-CASEWORK-SAFETY-RETALIATION-30-DAY-DEADLINE-20261022
//
// A member punished for a workplace safety or health complaint or refusal has
// 30 days to file a retaliation complaint (OSH Act s.11(c), 29 U.S.C.
// 660(c)(2); Massachusetts public employees: DLS under 454 CMR 25.07), and a
// pending grievance does not pause it (29 CFR 1977.15(d)(3)). A retaliation
// flag now records the protected activity category; the safety category
// stores safety_deadline = incident_on + 30 next to the ULP deadline, and the
// read routines name the filing route from the organization's employer sector
// and ULP jurisdiction. Flags without a category read exactly as before.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, latestFnBody, loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

// #8568: fixture dates are built on the Eastern day, the day the readers count;
// the session's current_date is the UTC day, tomorrow from 7 PM Eastern.

const FILE = "20261027100000_casework_safety_retaliation_deadline";
const sql = loadMigrationSql(FILE);
const code = stripComments(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("safety retaliation deadline migration (static)", () => {
  // After every migration on Main when it was written; never pinned as the
  // newest, so a later migration does not break this file.
  it("sorts after every migration that existed when it was written", () => {
    const names = migrationNames();
    expect(names).toContain(`${FILE}.sql`);
    expect(`${FILE}.sql` > "20261022053100_coordinator_desk_cross_organization_grants.sql").toBe(true);
    expect(names.filter((name) => name < "20261022053101").every((name) => name < `${FILE}.sql`)).toBe(true);
  });

  it("adds the category and the deadline as nullable columns with no default, so no row is rewritten", () => {
    expect(code).toMatch(/alter table public\.casework_retaliation_flags\s+add column protected_activity_category text,\s+add column safety_deadline date;/);
    expect(code).not.toMatch(/add column (protected_activity_category|safety_deadline)[^,;]*(default|not null|generated)/i);
    expect(code).not.toMatch(/update\s+public\.casework_retaliation_flags/i);
    // The shape CHECK ties a stored safety deadline to incident_on + 30 and to
    // the safety category only; it is validated after a NOT VALID add. It is a
    // CASE so SQL NULL cannot slip through either side: safety_health needs a
    // non-null deadline, and every other category, null included, needs none.
    expect(code).toContain("check (protected_activity_category is null or protected_activity_category in ('safety_health', 'other')) not valid");
    expect(code).toMatch(/check \(\s+case when protected_activity_category = 'safety_health'\s+then safety_deadline is not null and safety_deadline = incident_on \+ 30\s+else safety_deadline is null\s+end\s+\) not valid;/);
    expect(code).not.toContain("is distinct from 'safety_health' and safety_deadline is null");
    expect(code).toContain("validate constraint casework_retaliation_flags_protected_activity_category_check;");
    expect(code).toContain("validate constraint casework_retaliation_flags_safety_deadline_shape;");
  });

  it("stamps the 30-day deadline in the create routine and replaces the three-argument signature", () => {
    expect(code).toContain("drop function public.casework_flag_retaliation_incident(uuid, date, text);");
    const body = fnBody(sql, "public.casework_flag_retaliation_incident");
    expect(sql).toMatch(/p_note text default null,\s+p_protected_activity_category text default null\s+\)/);
    expect(body).toContain("perform private.lock_case_graph(array[auth.uid()], array[p_case_id]);");
    expect(body).toContain("(v_category is not null and v_category not in ('safety_health', 'other'))");
    expect(body).toContain("case when v_category = 'safety_health' then p_incident_on + 30 end");
    expect(body).toContain("and f.protected_activity_category is not distinct from v_category");
    expect(code).toContain("revoke all on function public.casework_flag_retaliation_incident(uuid, date, text, text) from public, anon, authenticated, service_role;");
    expect(code).toContain("grant execute on function public.casework_flag_retaliation_incident(uuid, date, text, text) to authenticated;");
    expect(latestFnBody("public.casework_flag_retaliation_incident")).toContain("case when v_category = 'safety_health' then p_incident_on + 30 end");
  });

  it("routes by sector and jurisdiction, naming both routes when it cannot tell", () => {
    expect(code).toMatch(/\('limits\.casework\.employer_sector', 'text',[\s\S]*?'"unknown"', null, null, array\['unknown', 'private', 'public'\], 1406, 'casework', false\)/);
    const route = fnBody(sql, "private.casework_safety_retaliation_route");
    expect(route).toContain("when s.sector = 'private' then 'osha_11c'");
    expect(route).toContain("when s.sector = 'public' and s.jurisdiction = 'MA' then 'ma_dls'");
    expect(route).toContain("else 'unknown'");
    expect(code).toContain("revoke all on function private.casework_safety_retaliation_route(uuid) from public, anon, authenticated, service_role;");
    expect(code).not.toMatch(/grant execute on function private\.casework_safety_retaliation_route/);
  });

  it("keeps every earlier key of the read routines and adds the safety fields", () => {
    const flagJson = latestFnBody("private.casework_retaliation_flag_json");
    for (const key of ["id", "caseId", "source", "incidentOn", "ulpDeadline", "daysLeft", "windowDays", "status", "note", "reviewedAt", "warningSentAt", "urgentSentAt", "createdAt", "adverseKind", "protectedActivityOn", "daysBetween", "confidence", "priorDisciplineCount", "staffNotifiedAt", "windowBasis", "windowSource", "protectedActivityCategory", "safetyDeadline", "safetyDaysLeft"]) {
      expect(flagJson).toContain(`'${key}', `);
    }
    expect(flagJson).toContain("'safetyDeadline', case when p_enabled then p_flag.safety_deadline end");
    const list = latestFnBody("public.casework_list_case_retaliation_flags");
    for (const key of ["enabled", "windowDays", "jurisdiction", "safetyRoute", "warningDays", "criticalDays", "flags"]) expect(list).toContain(`'${key}', `);
    const deadlines = latestFnBody("public.casework_list_ulp_deadlines");
    for (const key of ["flagId", "caseId", "reference", "title", "source", "status", "incidentOn", "ulpDeadline", "daysLeft", "warningDays", "criticalDays", "protectedActivityCategory", "safetyDeadline", "safetyRoute"]) {
      expect(deadlines).toContain(`'${key}', `);
    }
    expect(deadlines).toContain("'safetyRoute', private.casework_safety_retaliation_route(f.organization_id)");
    const summary = latestFnBody("public.get_my_case_ulp_summary");
    expect(summary).toMatch(/as \$function\$\s*begin\s+perform private\.member_pin_require_full_session\(\);/i);
    for (const key of ["caseId", "ulpDeadline", "retaliationFlagged", "stewardNotified", "ulpWarningDays", "ulpCriticalDays", "ulpSource", "safetyDeadline", "safetyRoute"]) {
      expect(summary).toContain(`'${key}', `);
    }
    // A case without a safety flag gets an empty object appended: its row is unchanged.
    expect(summary).toMatch(/\|\| case when s\.enabled and s\.safety_deadline is not null[\s\S]*?else '\{\}'::jsonb end/);
  });

  it("is pinned in the database contract and the required proof lane", () => {
    const sigs = contract.functions.map((entry) => entry.sig);
    expect(sigs).toEqual(expect.arrayContaining([
      "public.casework_flag_retaliation_incident(p_case_id uuid, p_incident_on date, p_note text, p_protected_activity_category text)",
      "private.casework_safety_retaliation_route(p_organization_id uuid)",
    ]));
    expect(sigs).not.toContain("public.casework_flag_retaliation_incident(p_case_id uuid, p_incident_on date, p_note text)");
    expect(contract.functionsAbsent).toContainEqual(expect.objectContaining({
      sig: "public.casework_flag_retaliation_incident(p_case_id uuid, p_incident_on date, p_note text)",
      droppedBy: FILE,
    }));
    expect(contract.constraints.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      "casework_retaliation_flags_protected_activity_category_check", "casework_retaliation_flags_safety_deadline_shape",
    ]));
    expect(PROOF_FILES).toContain("tests/casework-safety-retaliation-deadline-db.test.js");
  });
});

const ID = {
  org: "50902230-0000-4000-8000-000000000001",
  steward: "50902230-0000-4000-8000-000000000101",
  member: "50902230-0000-4000-8000-000000000102",
  session: "50902230-0000-4000-8000-000000000201",
  memberSession: "50902230-0000-4000-8000-000000000202",
  safetyCase: "50902230-0000-4000-8000-000000000301",
  plainCase: "50902230-0000-4000-8000-000000000302",
};
const CHAPTER = "safety-retaliation-proof";
const REFERENCE = "SAFETY-RETALIATION-PROOF";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("safety retaliation deadline on a disposable database", () => {
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

  const rpc = (userId, text, params = []) => as(userId, async () => (await db.query(text, params)).rows);
  const daysFromToday = async (days) => (await db.query("select ((now() at time zone 'America/New_York')::date + $1::integer)::text d", [days])).rows[0].d;
  const setSetting = (key, value) => db.query(
    `insert into public.organization_setting_values(organization_id, setting_key, value) values ($1, $2, $3::jsonb)
     on conflict (organization_id, setting_key) do update set value = excluded.value`,
    [ID.org, key, JSON.stringify(value)],
  );
  const clearSetting = (key) => db.query(
    "delete from public.organization_setting_values where organization_id = $1 and setting_key = $2", [ID.org, key],
  );
  const caseFlags = async (caseId) => (await rpc(ID.steward,
    "select public.casework_list_case_retaliation_flags($1) data", [caseId]))[0].data;
  const summaryRow = async (caseId) => (await rpc(ID.member, "select public.get_my_case_ulp_summary() summary"))[0]
    .summary.find((row) => row.caseId === caseId);

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "casework-safety-retaliation-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    for (const [id, name, session] of [[ID.steward, "safety-steward", ID.session], [ID.member, "safety-member", ID.memberSession]]) {
      await db.query("insert into auth.users(id, email) values ($1, $2)", [id, `${name}@example.invalid`]);
      await db.query("insert into auth.sessions(id, user_id, aal, created_at, updated_at) values ($1, $2, 'aal2', now(), now())", [session, id]);
      await db.query(
        `insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, created_at, updated_at)
         values (gen_random_uuid(), $1, 'safety-proof-totp', 'totp', 'verified', now(), now())`,
        [id],
      );
      sessions[id] = session;
    }
    await db.query(
      "insert into public.organizations(id, slug, name, created_by) values ($1, 'safety-retaliation-proof-org', 'Safety retaliation proof', $2)",
      [ID.org, ID.steward],
    );
    await db.query(
      "insert into public.chapters(id, name, slug, organization_id, is_default, order_index) values ($1, $1, $1, $2, false, 9924)",
      [CHAPTER, ID.org],
    );
    for (const id of [ID.steward, ID.member]) {
      await db.query("insert into public.organization_memberships(organization_id, user_id, status) values ($1, $2, 'active')", [ID.org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id, chapter_id, status) values ($1, $2, 'active')", [id, CHAPTER]);
      await db.query("update public.member_profiles set chapter_id = $2 where id = $1", [id, CHAPTER]);
    }
    await db.query(
      "insert into public.organization_role_grants(organization_id, user_id, role, granted_by) values ($1, $2, 'steward', $2)",
      [ID.org, ID.steward],
    );
    for (const [caseId, suffix] of [[ID.safetyCase, "S"], [ID.plainCase, "P"]]) {
      await db.query(
        `insert into public.member_cases(id, user_id, reference, title, case_type, step, status, steward_user_id)
         values ($1, $2, $3, $4, 'other', 'Intake', 'active', $5)`,
        [caseId, ID.member, `${REFERENCE}-${suffix}`, `Safety retaliation proof ${suffix}`, ID.steward],
      );
    }

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

  it("installs one definer flag routine, a private route helper and the unknown-sector default", async () => {
    const rows = (await db.query(
      `select p.oid::regprocedure::text signature, p.prosecdef,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') authenticated,
         has_function_privilege('anon', p.oid, 'EXECUTE') anon
       from pg_catalog.pg_proc p where p.oid = any($1::regprocedure[]) order by 1`,
      [["public.casework_flag_retaliation_incident(uuid,date,text,text)", "private.casework_safety_retaliation_route(uuid)"]],
    )).rows;
    expect(rows).toEqual([
      { signature: "casework_flag_retaliation_incident(uuid,date,text,text)", prosecdef: true, authenticated: true, anon: false },
      { signature: "private.casework_safety_retaliation_route(uuid)", prosecdef: true, authenticated: false, anon: false },
    ]);
    const overloads = (await db.query(
      "select count(*)::int n from pg_catalog.pg_proc where proname = 'casework_flag_retaliation_incident' and pronamespace = 'public'::regnamespace",
    )).rows[0].n;
    expect(overloads).toBe(1);
    const setting = (await db.query(
      "select default_value, allowed_values, category, member_visible from public.platform_setting_definitions where key = 'limits.casework.employer_sector'",
    )).rows[0];
    expect(setting).toEqual({ default_value: "unknown", allowed_values: ["unknown", "private", "public"], category: "casework", member_visible: false });
    const columns = (await db.query(
      `select column_name, is_nullable, column_default, is_generated from information_schema.columns
       where table_schema = 'public' and table_name = 'casework_retaliation_flags'
         and column_name in ('protected_activity_category', 'safety_deadline') order by 1`,
    )).rows;
    expect(columns).toEqual([
      { column_name: "protected_activity_category", is_nullable: "YES", column_default: null, is_generated: "NEVER" },
      { column_name: "safety_deadline", is_nullable: "YES", column_default: null, is_generated: "NEVER" },
    ]);
  });

  it("stores the safety category with a 30-day deadline next to the 180-day ULP deadline, audited", async () => {
    const incident = await daysFromToday(-4);
    const [{ flag }] = await rpc(ID.steward,
      "select public.casework_flag_retaliation_incident($1, $2::date, null, 'safety_health') flag", [ID.safetyCase, incident]);
    expect(flag).toMatchObject({
      incidentOn: incident,
      protectedActivityCategory: "safety_health",
      safetyDeadline: await daysFromToday(26),
      safetyDaysLeft: 26,
      ulpDeadline: await daysFromToday(176),
      daysLeft: 176,
    });
    const [{ again }] = await rpc(ID.steward,
      "select public.casework_flag_retaliation_incident($1, $2::date, null, 'safety_health') again", [ID.safetyCase, incident]);
    expect(again.id).toBe(flag.id);
    const audit = (await db.query("select metadata from public.casework_audit_events where entity_id = $1", [flag.id])).rows;
    expect(audit).toEqual([{ metadata: { source: "staff", ulpWindowDays: 180, protectedActivityCategory: "safety_health" } }]);
    const stored = (await db.query(
      "select protected_activity_category, (safety_deadline - incident_on)::int span from public.casework_retaliation_flags where id = $1", [flag.id],
    )).rows[0];
    expect(stored).toEqual({ protected_activity_category: "safety_health", span: 30 });
  });

  it("keeps other and uncategorized flags on the ULP deadline alone and refuses an unknown category", async () => {
    const [{ other }] = await rpc(ID.steward,
      "select public.casework_flag_retaliation_incident($1, (now() at time zone 'America/New_York')::date - 2, null, 'other') other", [ID.plainCase]);
    expect(other).toMatchObject({ protectedActivityCategory: "other", safetyDeadline: null, safetyDaysLeft: null });
    const [{ legacy }] = await rpc(ID.steward,
      "select public.casework_flag_retaliation_incident($1, (now() at time zone 'America/New_York')::date - 2, null) legacy", [ID.plainCase]);
    expect(legacy.id).not.toBe(other.id);
    expect(legacy).toMatchObject({ protectedActivityCategory: null, safetyDeadline: null, ulpDeadline: await daysFromToday(178) });
    await expect(rpc(ID.steward,
      "select public.casework_flag_retaliation_incident($1, (now() at time zone 'America/New_York')::date, null, 'union_activity')", [ID.plainCase]))
      .rejects.toMatchObject({ code: "22023" });
  });

  it.each([
    ["a safety deadline that is not the incident date plus 30", "'safety_health'", "(now() at time zone 'America/New_York')::date + 31"],
    ["a safety deadline on another category", "'other'", "(now() at time zone 'America/New_York')::date + 30"],
    // Round-1 review: SQL NULL on either side of the shape.
    ["the safety category without a deadline", "'safety_health'", "null"],
    ["a safety deadline on a flag with no category", "null", "(now() at time zone 'America/New_York')::date + 30"],
  ])("refuses %s", async (_label, category, deadline) => {
    await db.query("savepoint shape");
    try {
      await expect(db.query(
        `insert into public.casework_retaliation_flags (case_id, organization_id, chapter_id, source, incident_on, ulp_window_days,
           protected_activity_category, safety_deadline)
         values ($1, $2, $3, 'staff', (now() at time zone 'America/New_York')::date, 180, ${category}, ${deadline})`,
        [ID.plainCase, ID.org, CHAPTER],
      )).rejects.toMatchObject({ code: "23514" });
    } finally {
      await db.query("rollback to savepoint shape");
    }
  });

  it("adds safetyDeadline and safetyRoute to the member summary only for the safety case", async () => {
    const safety = await summaryRow(ID.safetyCase);
    expect(safety).toMatchObject({ ulpDeadline: await daysFromToday(176), safetyDeadline: await daysFromToday(26), safetyRoute: "unknown" });
    const plain = await summaryRow(ID.plainCase);
    expect(Object.keys(plain).sort()).toEqual(["caseId", "retaliationFlagged", "stewardNotified", "ulpCriticalDays", "ulpDeadline", "ulpSource", "ulpWarningDays"]);
  });

  it("routes private employers to OSHA 11(c), Massachusetts public employers to DLS, and anything else to both", async () => {
    expect((await caseFlags(ID.safetyCase)).safetyRoute).toBe("unknown");
    await setSetting("limits.casework.employer_sector", "private");
    expect((await caseFlags(ID.safetyCase)).safetyRoute).toBe("osha_11c");
    expect((await summaryRow(ID.safetyCase)).safetyRoute).toBe("osha_11c");
    await setSetting("limits.casework.employer_sector", "public");
    expect((await caseFlags(ID.safetyCase)).safetyRoute).toBe("unknown");
    await setSetting("limits.casework.ulp_jurisdiction", "MA");
    expect((await caseFlags(ID.safetyCase)).safetyRoute).toBe("ma_dls");
    expect((await summaryRow(ID.safetyCase)).safetyRoute).toBe("ma_dls");
    await clearSetting("limits.casework.ulp_jurisdiction");
    await clearSetting("limits.casework.employer_sector");
  });

  it("orders the staff deadline view by a safety deadline still ahead and withholds it while tracking is off", async () => {
    const [{ rows }] = await rpc(ID.steward, "select public.casework_list_ulp_deadlines(50) rows");
    const proof = rows.filter((row) => row.reference.startsWith(REFERENCE));
    expect(proof[0]).toMatchObject({ caseId: ID.safetyCase, protectedActivityCategory: "safety_health", safetyDeadline: await daysFromToday(26), safetyRoute: "unknown" });
    await setSetting("features.casework.ulp_deadline", false);
    const flags = (await caseFlags(ID.safetyCase)).flags;
    expect(flags[0]).toMatchObject({ protectedActivityCategory: "safety_health", safetyDeadline: null, ulpDeadline: null });
    const off = await summaryRow(ID.safetyCase);
    expect(off.ulpDeadline).toBeNull();
    expect(off).not.toHaveProperty("safetyDeadline");
    await clearSetting("features.casework.ulp_deadline");
  });
});
