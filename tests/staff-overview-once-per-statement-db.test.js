// @vitest-environment node
//
// BUG-UG-STAFF-OVERVIEW-RESIDUAL-READ-LATENCY-20261108 (#7577)
//
// 20261106221000 made the profile scans set-wise. The case scans still called
// the staff and leadership wrappers once per case, and the VP overview still
// called the event-scope wrapper once per event. This migration hoists the
// caller-constant gates. The installed answers must match those predecessor
// bodies, and the per-case wrappers must stay at zero calls. The predecessor
// itself is run in a savepoint so a regression that puts the wrapper back
// fails this file.

import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";
import { fnBody, latestFnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = loadMigrationSql("staff_overview_readable_cases_once");
const PREDECESSOR_FILE = readFileSync(new URL("../supabase/migrations/20261106221000_staff_desk_overviews_setwise_access_and_cached_helper_plans.sql", import.meta.url), "utf8");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const squash = (text) => text.replace(/\s+/g, " ").trim();

function predecessor(name) {
  const matches = PREDECESSOR_FILE.match(/^CREATE OR REPLACE FUNCTION [\s\S]*?\n\$function\$\n;/gm) || [];
  const found = matches.find((statement) => statement.startsWith(`CREATE OR REPLACE FUNCTION ${name}(`));
  if (!found) throw new Error(`missing predecessor ${name}`);
  return found;
}

const prefix = "c7577e00";
const id = (n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const orgA = id(901);
const orgB = id(902);
const orgP = id(903);
const ch1 = "c7577eq-ch-1";
const ch2 = "c7577eq-ch-2";
const chB = "c7577eq-ch-b";
const chP = "c7577eq-ch-p";
const chL = "c7577eq-ch-l";

const callers = {
  orgVp: 20,
  orgAdvisor: 21,
  orgAdmin: 22,
  chapterVp: 23,
  chapterAdvisor: 24,
  chapterAdmin: 25,
  unitAdvisor: 26,
  committeeAdvisor: 27,
  legacyAdvisor: 28,
  platformAdvisor: 29,
  member: 30,
};

function stable(value) {
  if (!value || typeof value !== "object") return value;
  const copy = structuredClone(value);
  for (const key of ["attention", "upcomingEvents"]) {
    if (!Array.isArray(copy[key])) continue;
    copy[key].sort((left, right) => String(left.deadline ?? left.startsAt ?? "").localeCompare(String(right.deadline ?? right.startsAt ?? ""))
      || String(left.id).localeCompare(String(right.id)));
  }
  return copy;
}

describe("staff overview once-per-statement migration", () => {
  const sql = stripComments(MIGRATION);
  const advisor = squash(stripComments(fnBody(MIGRATION, "public.get_advisor_overview")));
  const vp = squash(stripComments(fnBody(MIGRATION, "public.get_vp_overview")));

  it("replaces only the two reviewed overview bodies in one bounded transaction", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("set local lock_timeout = '5s';");
    expect(sql).toContain("888fe487f43eb79b36b942ca0721843c");
    expect(sql).toContain("1144090482bf80f2dce63dded2d59019");
    expect(squash(sql)).not.toMatch(/\b(grant|revoke|create policy|alter table|create index)\b/);
  });

  it("keeps the profile scans set-wise and does not call the per-case wrappers", () => {
    for (const body of [advisor, vp]) {
      expect(body).toContain("private.staff_visible_member_ids(readable_role)");
      expect(body).not.toContain("private.chapter_member_readable(");
    }
    expect(advisor).not.toContain("private.chapter_case_staff_readable(");
    expect(advisor).not.toContain("private.casework_staff_can_access(");
    expect(advisor).toContain("private.actor_case_scope_and_identity_allowed(caller, c)");
    expect(advisor).toContain("private.staff_visible_member_ids('coordinator')");
    expect(vp).not.toContain("private.chapter_case_leadership_readable(");
    expect(vp).not.toContain("private.member_can_access_event_scope(");
    expect(vp).toContain("private.member_event_scope_allows(");
    expect(vp).toContain("(select private.member_event_caller_scope())");
    expect(squash(latestFnBody("public.get_advisor_overview"))).toContain("elevated_org");
    expect(squash(latestFnBody("public.get_vp_overview"))).toContain("leadership_open");
  });

  it("pins the hoist in the database contract", () => {
    const advisorEntry = contract.functions.find((row) => row.sig === "public.get_advisor_overview()");
    const vpEntry = contract.functions.find((row) => row.sig === "public.get_vp_overview()");
    expect(advisorEntry.bodyForbids).toEqual(expect.arrayContaining([
      "private.chapter_case_staff_readable(",
      "private.casework_staff_can_access(",
    ]));
    expect(vpEntry.bodyForbids).toEqual(expect.arrayContaining([
      "private.chapter_case_leadership_readable(",
      "private.member_can_access_event_scope(",
    ]));
    expect(vpEntry.bodyContains).toEqual(expect.arrayContaining([
      "private.member_event_scope_allows(",
      "(select private.member_event_caller_scope())",
      "and c.chapter_id = caller_chapter;",
    ]));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("overview optimization preserves its predecessor and installed reads avoid per-case wrappers", () => {
  let db;

  async function act(userNumber, aal = "aal2") {
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      sub: id(userNumber),
      role: "authenticated",
      aal,
      session_id: id(800 + userNumber),
    })]);
    await db.query("set local role authenticated");
  }

  async function counts() {
    const { rows } = await db.query(`select funcname, coalesce(sum(calls), 0)::int as calls
      from pg_stat_xact_user_functions
      where funcname in (
        'chapter_case_staff_readable','casework_staff_can_access','casework_staff_can_read',
        'chapter_case_leadership_readable','member_can_access_event_scope'
      )
      group by funcname`);
    return Object.fromEntries(rows.map((row) => [row.funcname, row.calls]));
  }

  function diffCounts(before, after) {
    const diff = {};
    for (const name of ["chapter_case_staff_readable", "casework_staff_can_access", "casework_staff_can_read", "chapter_case_leadership_readable", "member_can_access_event_scope"]) {
      diff[name] = (after[name] ?? 0) - (before[name] ?? 0);
    }
    return diff;
  }

  async function readOverview(userNumber, which, aal = "aal2") {
    await db.query("savepoint overview_read");
    const before = await counts();
    try {
      await act(userNumber, aal);
      const { rows } = await db.query(`select public.${which}() as value`);
      await db.query("reset role");
      return { ok: true, value: rows[0].value, diff: diffCounts(before, await counts()) };
    } catch (error) {
      // A raised refusal aborts the subtransaction. Roll back before reading
      // the call counters, which survive the savepoint.
      await db.query("rollback to savepoint overview_read");
      await db.query("reset role");
      return {
        ok: false,
        code: error.code,
        message: error.message,
        diff: diffCounts(before, await counts()),
      };
    } finally {
      await db.query("rollback to savepoint overview_read");
      await db.query("reset role");
    }
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      application_name: "staff-overview-once-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '120s'");
    await db.query("set local track_functions = 'all'");
    await db.query("set local session_replication_role = replica");

    await db.query(`insert into public.organizations(id, slug, name, status, kind) values
      ($1, 'c7577eq-a', 'Fixture A', 'active', 'union'),
      ($2, 'c7577eq-b', 'Fixture B', 'active', 'union'),
      ($3, 'c7577eq-p', 'Fixture P', 'active', 'platform')`, [orgA, orgB, orgP]);
    await db.query(`insert into public.chapters(id, name, region, is_default, order_index, organization_id, slug) values
      ($1, 'Fixture chapter 1', 'east', false, 9711, $6, $1),
      ($2, 'Fixture chapter 2', 'east', false, 9712, $6, $2),
      ($3, 'Fixture chapter B', 'east', false, 9713, $7, $3),
      ($4, 'Fixture chapter P', 'east', false, 9714, $8, $4),
      ($5, 'Fixture chapter L', 'east', false, 9715, null, $5)`, [ch1, ch2, chB, chP, chL, orgA, orgB, orgP]);

    const people = [
      ...Array.from({ length: 10 }, (_, index) => ({ n: index + 1, chapter: ch1, org: orgA })),
      { n: 11, chapter: ch2, org: orgA },
      { n: 12, chapter: chB, org: orgB },
      { n: 31, chapter: chL, org: null },
      { n: 32, chapter: chP, org: orgP },
      ...Object.values(callers).map((n) => ({
        n,
        chapter: n === callers.legacyAdvisor ? chL : n === callers.platformAdvisor ? chP : ch1,
        org: n === callers.legacyAdvisor ? null : n === callers.platformAdvisor ? orgP : orgA,
      })),
    ];
    for (const person of people) {
      await db.query(`insert into auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous)
        values ($1, 'authenticated', 'authenticated', $2, '{"provider":"email","providers":["email"]}', '{}', now(), now(), false, false)`,
      [id(person.n), `${prefix}-${person.n}@example.invalid`]);
      await db.query(`insert into public.member_profiles(id, first_name, full_name, initials, chapter_id, role_line, member_since, language,
          notification_prefs, dnd_enabled, quiet_hours_timezone, urgent_notifications_enabled, shortcut_keys, work_widget_order, created_at, updated_at)
        values ($1, 'Fixture', $2, 'FX', $3, 'Member', 2020, 'en', '{}', false, 'UTC', true, '{}', '{}', now(), now())`,
      [id(person.n), `Fixture member ${person.n}`, person.chapter]);
      if (person.org) {
        await db.query("insert into public.organization_memberships(organization_id, user_id, status) values ($1, $2, 'active')", [person.org, id(person.n)]);
      }
      await db.query("insert into public.member_chapter_memberships(user_id, chapter_id, status, pinned, joined_at) values ($1, $2, 'active', true, now())", [id(person.n), person.chapter]);
    }

    await db.query(`insert into public.member_cases(id, user_id, reference, title, case_type, organization_id, chapter_id, step, articles, status, deadline, steward_user_id, is_restricted, created_at, updated_at)
      select ('c7577c00-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
        ('${prefix}-0000-4000-8000-' || lpad((((n - 1) % 10) + 1)::text, 12, '0'))::uuid,
        'c7577eq-' || n, 'Fixture case ' || n, 'grievance', $1, $2, 'Step 2', 'Article 5',
        case when n % 5 = 0 then 'resolved' else 'active' end,
        case when n % 4 = 0 then current_date - n else current_date + n end,
        $3, false, now(), now()
      from generate_series(1, 30) n`, [orgA, ch1, id(1)]);
    await db.query(`update public.member_cases set steward_user_id = $1
      where user_id in ($2, $3) and reference like 'c7577eq-%'`, [id(callers.unitAdvisor), id(1), id(2)]);
    await db.query(`update public.member_cases set steward_user_id = $1
      where user_id = $2 and reference like 'c7577eq-%'`, [id(callers.committeeAdvisor), id(3)]);
    await db.query(`insert into public.member_cases(id, user_id, reference, title, case_type, organization_id, chapter_id, step, articles, status, deadline, is_restricted, created_at, updated_at)
      values
        ($1, $2, 'c7577eq-ch2', 'Fixture chapter 2 case', 'grievance', $5, $6, 'Step 2', 'Article 5', 'active', current_date - 3, false, now(), now()),
        ($3, $4, 'c7577eq-foreign', 'Fixture foreign case', 'grievance', $7, $8, 'Step 2', 'Article 5', 'active', current_date - 4, false, now(), now())`,
    [id(1101), id(11), id(1102), id(12), orgA, ch2, orgB, chB]);
    await db.query(`insert into public.member_cases(id, user_id, reference, title, case_type, organization_id, chapter_id, step, articles, status, deadline, is_restricted, created_at, updated_at)
      values ($1, $2, 'c7577eq-ownerless', 'Fixture ownerless case', 'other', null, $3, 'Step 1', 'Article 5', 'active', current_date - 1, false, now(), now())`,
    [id(1103), id(31), chL]);
    await db.query(`insert into public.member_cases(id, user_id, reference, title, case_type, organization_id, chapter_id, step, articles, status, deadline, is_restricted, restriction_reason, restricted_at, created_at, updated_at)
      values ($1, $2, 'c7577eq-private', 'Fixture private case', 'grievance', $3, $4, 'Step 2', 'Article 5', 'active', current_date - 2, true, 'Fixture restriction', now(), now(), now())`,
    [id(1104), id(4), orgA, ch1]);
    await db.query("insert into private.case_identity_privacy(case_id) values ($1)", [id(1104)]);
    await db.query(`update public.member_cases set learning_undone_at = now() where reference = 'c7577eq-10'`);

    const unit = id(1201);
    const committee = id(1202);
    await db.query(`insert into private.chapter_units(id, organization_id, chapter_id, name, kind)
      values ($1, $2, $3, 'Fixture unit', 'unit')`, [unit, orgA, ch1]);
    await db.query(`insert into private.chapter_committees(id, chapter_id, name, purpose, grievance_access)
      values ($1, $2, 'Fixture committee', 'Fixture purpose', true)`, [committee, ch1]);
    await db.query(`insert into private.chapter_unit_members(unit_id, chapter_id, user_id) values ($1, $2, $3), ($1, $2, $4)`,
      [unit, ch1, id(1), id(2)]);
    await db.query(`insert into private.chapter_committee_members(committee_id, chapter_id, user_id) values ($1, $2, $3)`,
      [committee, ch1, id(3)]);

    const roleRows = [
      [callers.chapterVp, "vp", ch1],
      [callers.chapterAdvisor, "advisor", ch1],
      [callers.chapterAdmin, "admin", ch1],
      [callers.unitAdvisor, "advisor", ch1],
      [callers.committeeAdvisor, "advisor", ch1],
      [callers.legacyAdvisor, "advisor", chL],
      [1, "steward", ch1],
    ];
    for (const [user, role, chapter] of roleRows) {
      for (const table of ["member_roles", "member_role_chapters"]) {
        await db.query(`insert into public.${table}(user_id, role, chapter_id, granted_by) values ($1, $2, $3, $1) on conflict do nothing`,
          [id(user), role, chapter]);
      }
    }
    await db.query(`insert into private.chapter_role_scopes(user_id, chapter_id, role, unit_id) values ($1, $2, 'advisor', $3)`,
      [id(callers.unitAdvisor), ch1, unit]);
    await db.query(`insert into private.chapter_role_scopes(user_id, chapter_id, role, committee_id) values ($1, $2, 'advisor', $3)`,
      [id(callers.committeeAdvisor), ch1, committee]);
    for (const [user, role, org] of [
      [callers.orgVp, "vp", orgA],
      [callers.orgAdvisor, "advisor", orgA],
      [callers.orgAdmin, "admin", orgA],
      [callers.platformAdvisor, "advisor", orgP],
    ]) {
      await db.query("insert into public.organization_role_grants(organization_id, user_id, role, granted_by) values ($1, $2, $3, $2)",
        [org, id(user), role]);
    }

    await db.query(`insert into public.member_events
        (id, title, starts_at, location, summary, check_in_code, order_index, chapter_id, is_public, is_public_across_agencies, cancelled_at)
      select 'c7577eq-ev-' || n, 'Fixture event ' || n, now() + (n || ' minutes')::interval, 'Room', 'Fixture',
        'SG-C7E' || lpad(n::text, 2, '0'), 860000 + n, $1, false, false, null
      from generate_series(1, 15) n`, [ch1]);
    await db.query(`insert into public.member_events
        (id, title, starts_at, location, summary, check_in_code, order_index, chapter_id, is_public, is_public_across_agencies, cancelled_at)
      values
        ('c7577eq-ev-cancel', 'Fixture cancelled event', now() + interval '1 hour', 'Room', 'Fixture', 'SG-C7EX1', 860030, $1, false, false, now()),
        ('c7577eq-ev-foreign', 'Fixture foreign event', now() + interval '2 minutes', 'Room', 'Fixture', 'SG-C7EX2', 860031, $2, true, true, null),
        ('c7577eq-ev-public', 'Fixture public chapter 2 event', now() + interval '3 minutes', 'Room', 'Fixture', 'SG-C7EX3', 860032, $3, true, false, null),
        ('c7577eq-ev-past', 'Fixture past event', now() - interval '1 day', 'Room', 'Fixture', 'SG-C7EX4', 860033, $1, false, false, null)`,
    [ch1, chB, ch2]);
    await db.query(`insert into public.member_ballots(id, title, closes_at, active, order_index, chapter_id, campaign_state, quorum_target, organization_id)
      values ('c7577eq-ballot', 'Fixture union ballot', now() + interval '30 years', false, 860040, $1, 'closed', 10, $2)`, [ch1, orgA]);
    await db.query(`insert into public.member_ballots(id, title, closes_at, active, order_index, chapter_id, campaign_state, quorum_target, organization_id)
      values ('c7577eq-platform-ballot', 'Fixture platform ballot', now() + interval '40 years', false, 860041, $1, 'closed', 10, $2)`, [chP, orgP]);

    await db.query("set local session_replication_role = origin");
    for (const user of Object.values(callers)) {
      await db.query("insert into auth.sessions(id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal2')", [id(800 + user), id(user)]);
      await db.query("insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at) values ($1, $2, 'fixture', 'totp', 'verified', 'fixture', now(), now())", [id(700 + user), id(user)]);
    }
  }, runnerTimeout(120_000));

  afterAll(async () => {
    await db?.query("rollback").catch(() => {});
    await db?.end();
  });

  async function both(userNumber, which, aal = "aal2") {
    // Compare the performance migration's own two versions. #8205 deliberately
    // removes cross-tenant aggregates from today's Advisor, so its new answers
    // must not be pinned to the historically unscoped predecessor.
    await db.query("savepoint optimized_body");
    let installed;
    try {
      await db.query(fnBody(MIGRATION, `public.${which}`));
      installed = await readOverview(userNumber, which, aal);
    } finally {
      await db.query("rollback to savepoint optimized_body");
    }
    await db.query("savepoint predecessor_body");
    let previous;
    try {
      await db.query(predecessor(`public.${which}`));
      previous = await readOverview(userNumber, which, aal);
    } finally {
      await db.query("rollback to savepoint predecessor_body");
      await db.query("reset role");
    }
    return { installed, previous };
  }

  it("matches fields, rows, order, refusals and aggregates for every accepted caller", async () => {
    const reads = [
      [callers.orgVp, "get_vp_overview"],
      [callers.orgAdmin, "get_vp_overview"],
      [callers.chapterVp, "get_vp_overview"],
      [callers.chapterAdmin, "get_vp_overview"],
      [callers.orgAdvisor, "get_advisor_overview"],
      [callers.orgAdmin, "get_advisor_overview"],
      [callers.chapterAdvisor, "get_advisor_overview"],
      [callers.chapterAdmin, "get_advisor_overview"],
      [callers.unitAdvisor, "get_advisor_overview"],
      [callers.committeeAdvisor, "get_advisor_overview"],
      [callers.legacyAdvisor, "get_advisor_overview"],
      [callers.member, "get_vp_overview"],
      [callers.member, "get_advisor_overview"],
      [callers.platformAdvisor, "get_advisor_overview"],
      [callers.orgAdvisor, "get_advisor_overview", "aal1"],
      [callers.orgVp, "get_vp_overview", "aal1"],
    ];
    for (const [user, which, aal] of reads) {
      const { installed, previous } = await both(user, which, aal);
      expect(installed.ok, `${which} ${user} ${aal ?? "aal2"}`).toBe(previous.ok);
      if (!installed.ok) {
        expect(installed.code).toBe(previous.code);
      } else {
        expect(stable(installed.value)).toEqual(stable(previous.value));
      }
    }

    const orgAdvisor = await readOverview(callers.orgAdvisor, "get_advisor_overview");
    const unitAdvisor = await readOverview(callers.unitAdvisor, "get_advisor_overview");
    const committeeAdvisor = await readOverview(callers.committeeAdvisor, "get_advisor_overview");
    expect(orgAdvisor.ok && unitAdvisor.ok && committeeAdvisor.ok).toBe(true);
    expect(unitAdvisor.value.openGrievances).toBeGreaterThan(0);
    expect(committeeAdvisor.value.openGrievances).toBeGreaterThan(0);
    expect(unitAdvisor.value.openGrievances).toBeLessThan(orgAdvisor.value.openGrievances);
    expect(committeeAdvisor.value.openGrievances).toBeLessThan(orgAdvisor.value.openGrievances);
    expect(unitAdvisor.value.openGrievances).not.toBe(committeeAdvisor.value.openGrievances);
    expect(JSON.stringify(orgAdvisor.value)).not.toContain("Fixture foreign case");
    expect(JSON.stringify(orgAdvisor.value)).not.toContain("Fixture platform ballot");
    expect(orgAdvisor.value.turnout.title).toBe("Fixture union ballot");

    const vp = await readOverview(callers.orgVp, "get_vp_overview");
    expect(vp.ok).toBe(true);
    expect(vp.value.upcomingEvents.map((event) => event.startsAt)).toEqual(
      [...vp.value.upcomingEvents.map((event) => event.startsAt)].sort(),
    );
    expect(JSON.stringify(vp.value)).not.toContain("Fixture foreign event");
    expect(JSON.stringify(vp.value)).not.toContain("Fixture cancelled event");
    expect(JSON.stringify(vp.value)).not.toContain("Fixture past event");
    expect(vp.value.attention.map((row) => row.deadline)).toEqual(
      [...vp.value.attention.map((row) => row.deadline)].sort(),
    );
  }, runnerTimeout(120_000));

  it("fails when the predecessor per-case wrappers are restored", async () => {
    const advisorNow = await readOverview(callers.orgAdvisor, "get_advisor_overview");
    const vpNow = await readOverview(callers.orgVp, "get_vp_overview");
    expect(advisorNow.diff.chapter_case_staff_readable).toBe(0);
    expect(advisorNow.diff.casework_staff_can_access).toBe(0);
    expect(advisorNow.diff.casework_staff_can_read).toBe(0);
    expect(vpNow.diff.chapter_case_leadership_readable).toBe(0);
    expect(vpNow.diff.member_can_access_event_scope).toBe(0);

    await db.query("savepoint predecessor_counts");
    try {
      await db.query(predecessor("public.get_advisor_overview"));
      await db.query(predecessor("public.get_vp_overview"));
      const advisorThen = await readOverview(callers.orgAdvisor, "get_advisor_overview");
      const vpThen = await readOverview(callers.orgVp, "get_vp_overview");
      expect(advisorThen.diff.chapter_case_staff_readable).toBeGreaterThanOrEqual(30);
      expect(advisorThen.diff.casework_staff_can_access).toBeGreaterThanOrEqual(30);
      expect(vpThen.diff.chapter_case_leadership_readable).toBeGreaterThanOrEqual(30);
      // ORDER BY starts_at LIMIT 5 can stop an ordered index scan early.
      // The predecessor must call the wrapper; its exact visit count is not guaranteed.
      expect(vpThen.diff.member_can_access_event_scope).toBeGreaterThan(0);
    } finally {
      await db.query("rollback to savepoint predecessor_counts");
      await db.query("reset role");
    }
  }, runnerTimeout(120_000));
});
