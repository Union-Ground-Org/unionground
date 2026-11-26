// @vitest-environment node
//
// BUG-UG-SAMPLE-ORGANIZATION-ANALYTICS-ALWAYS-TIMES-OUT-20261122 (#9556)
//
// On the demo the organization analytics snapshot ran 16 to 19 s because
// private.chapter_case_staff_readable ran once per case row in each of its
// three case reads. 20261123061000 reads the caller's cases once through
// private.organization_analytics_readable_cases. This file proves:
// 1. Row for row, the helper returns exactly the cases the wrapper admits, for
//    every kind of caller: organization admin, vp, advisor, coordinator, a
//    steward with a unit assignment, an unassigned organization steward,
//    chapter stewards and coordinators with and without a unit or committee
//    scope, a local-breadth steward, a chapter whose policy closes steward
//    grievances, a grantee, a plain member, another organization's admin and
//    a caller without the second step.
// 2. The installed snapshot answers exactly as its predecessor (rebuilt from
//    20261102005607 in a savepoint), refusals included, and never calls the
//    per-case wrappers; the predecessor does, so restoring it fails here.
// 3. At demo scale (1,000 members, six chapters, 700 cases in the window) the
//    snapshot answers well inside the page's 10 s limit as an admin and as a
//    unit-assigned steward.
// Everything runs in one transaction that is rolled back.

import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";
import { loadScaledBudget, pairedFastest, reportPaired } from "./helpers/db-load-budget.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = loadMigrationSql("organization_analytics_snapshot_reads_cases_once");
const PREDECESSOR_FILE = readFileSync(new URL("../supabase/migrations/20261102005607_unit_committee_scoped_access.sql", import.meta.url), "utf8");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const admission = JSON.parse(readFileSync(new URL("../scripts/lifecycle-read-admission-review.json", import.meta.url), "utf8"));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const HELPER = "private.organization_analytics_readable_cases";
const PER_CASE = ["chapter_case_staff_readable", "casework_staff_can_read", "casework_staff_can_access"];

function predecessorSnapshot() {
  const matches = PREDECESSOR_FILE.match(/^CREATE OR REPLACE FUNCTION [\s\S]*?\n\$function\$\n/gm) || [];
  const found = matches.filter((statement) => statement.startsWith("CREATE OR REPLACE FUNCTION public.get_organization_analytics_snapshot("));
  if (found.length !== 1) throw new Error("missing predecessor snapshot");
  return found[0];
}

describe("organization analytics snapshot reads its cases once (#9556)", () => {
  const sql = stripComments(MIGRATION);
  const snapshot = squash(stripComments(fnBody(MIGRATION, "public.get_organization_analytics_snapshot")));
  const helper = squash(stripComments(fnBody(MIGRATION, HELPER)));

  it("replaces only the reviewed snapshot and adds one private helper in one bounded transaction", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("set local lock_timeout = '5s';");
    expect(sql).toContain("265984a532d255eb610f54066a7f43ba");
    expect(squash(sql)).toContain(`revoke all on function ${HELPER}(uuid, timestamp with time zone, timestamp with time zone) from public, anon, authenticated, service_role;`);
    expect(squash(sql)).not.toMatch(/\b(grant |create policy|alter table|create index|drop )/);
  });

  it("reads the case set once and never calls the per-case wrapper", () => {
    expect(snapshot).toContain(`with readable as materialized ( select r.* from ${HELPER}(org, period_start, period_end) r )`);
    expect(snapshot.match(/from readable cs/g)).toHaveLength(4);
    expect(snapshot).not.toContain("private.chapter_case_staff_readable(");
    expect(snapshot).not.toContain("access_row");
    expect(helper).toContain("STABLE SECURITY DEFINER");
    for (const name of PER_CASE) expect(helper).not.toContain(`private.${name}(`);
    expect(helper).toContain("else private.actor_case_scope_and_identity_allowed(caller, c)");
    expect(helper).toContain("when coordinator_capable then public.staff_can_see_user(c.user_id, 'coordinator')");
  });

  it("pins the new body in the database contract and the read admission review", () => {
    const entry = contract.functions.find((row) => row.sig === "public.get_organization_analytics_snapshot()");
    expect(entry.bodyContains).toEqual(expect.arrayContaining([`${HELPER}(org, period_start, period_end)`]));
    expect(entry.bodyForbids).toEqual(expect.arrayContaining(["private.chapter_case_staff_readable("]));
    const helperEntry = contract.functions.find((row) => row.sig.startsWith(`${HELPER}(`));
    expect(helperEntry).toMatchObject({ secdef: true, exec: "" });
    expect(admission["public.get_organization_analytics_snapshot"].source_sha256)
      .toBe("ec4b980014f64a3418341d755a372ca16dc0756145b266a4a4a93d00bff7e61a");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

const prefix = "c9556e00";
const id = (n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const orgA = id(9001);
const orgB = id(9002);
const [a1, a2, a3, b1] = ["c9556-a1", "c9556-a2", "c9556-a3", "c9556-b1"];
const unit = id(9101);
const committee = id(9102);

const callers = {
  orgAdmin: 100,
  orgVp: 101,
  orgAdvisor: 102,
  orgCoordinator: 103,
  orgStewardAssigned: 104,
  orgStewardUnassigned: 105,
  chapterSteward: 106,
  chapterStewardUnit: 107,
  chapterCoordinator: 108,
  chapterCoordinatorCommittee: 109,
  localSteward: 110,
  grantee: 111,
  member: 112,
  otherAdmin: 113,
  closedChapterSteward: 114,
  localStewardOrgGrant: 115,
  scopedStewardCoordinator: 116,
};

live("the readable-case helper and the snapshot keep their predecessor's answers (#9556)", () => {
  let db;

  async function act(userNumber, { aal = "aal2", role = true } = {}) {
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      sub: id(userNumber), role: "authenticated", aal, session_id: id(800 + userNumber),
    })]);
    if (role) await db.query("set local role authenticated");
  }

  async function counts() {
    const { rows } = await db.query(`select funcname, coalesce(sum(calls), 0)::int as calls
      from pg_stat_xact_user_functions where funcname = any($1::text[]) group by funcname`, [PER_CASE]);
    return Object.fromEntries(rows.map((row) => [row.funcname, row.calls]));
  }

  async function readSnapshot(userNumber, aal = "aal2") {
    await db.query("savepoint snapshot_read");
    const before = await counts();
    try {
      await act(userNumber, { aal });
      const { rows } = await db.query("select public.get_organization_analytics_snapshot() - 'snapshotId' as value");
      await db.query("reset role");
      const after = await counts();
      return { ok: true, value: rows[0].value, calls: PER_CASE.reduce((sum, name) => sum + (after[name] ?? 0) - (before[name] ?? 0), 0) };
    } catch (error) {
      await db.query("rollback to savepoint snapshot_read");
      await db.query("reset role");
      return { ok: false, code: error.code };
    } finally {
      await db.query("rollback to savepoint snapshot_read");
      await db.query("reset role");
    }
  }

  // As the function owner with the caller's claims: the helper and the
  // wrapper are both private.
  async function readableIds(userNumber, org, aal = "aal2") {
    await db.query("savepoint readable_ids");
    try {
      await act(userNumber, { aal, role: false });
      const window = "c.created_at >= date_trunc('month', now()) - interval '6 months' and c.created_at < date_trunc('month', now())";
      const helperRows = (await db.query(`select c.id from ${HELPER}($1, date_trunc('month', now()) - interval '6 months', date_trunc('month', now())) c order by c.id`, [org])).rows.map((row) => row.id);
      const wrapperRows = (await db.query(`select c.id from public.member_cases c
        where c.organization_id = $1 and c.chapter_id is not null and ${window}
          and private.chapter_case_staff_readable(c) order by c.id`, [org])).rows.map((row) => row.id);
      return { helperRows, wrapperRows };
    } finally {
      await db.query("rollback to savepoint readable_ids");
    }
  }

  async function person(n, chapter, org, { orgStatus = "active", chapterStatus = "active" } = {}) {
    await db.query(`insert into auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous)
      values ($1, 'authenticated', 'authenticated', $2, '{"provider":"email","providers":["email"]}', '{}', now(), now(), false, false)`,
    [id(n), `${prefix}-${n}@example.invalid`]);
    await db.query(`insert into public.member_profiles(id, first_name, full_name, initials, chapter_id, role_line, member_since, language,
        notification_prefs, dnd_enabled, quiet_hours_timezone, urgent_notifications_enabled, shortcut_keys, work_widget_order, created_at, updated_at)
      values ($1, 'Fixture', $2, 'FX', $3, 'Member', 2020, 'en', '{}', false, 'UTC', true, '{}', '{}', now(), now())`,
    [id(n), `Fixture member ${n}`, chapter]);
    await db.query(`insert into public.organization_memberships(organization_id, user_id, status, revoked_at)
      values ($1, $2, $3, case when $3 = 'revoked' then now() end)`, [org, id(n), orgStatus]);
    await db.query(`insert into public.member_chapter_memberships(user_id, chapter_id, status, pinned, joined_at, revoked_at)
      values ($1, $2, $3, true, now(), case when $3 = 'revoked' then now() end)`, [id(n), chapter, chapterStatus]);
  }

  async function chapterRole(n, role, chapter) {
    for (const table of ["member_roles", "member_role_chapters"]) {
      await db.query(`insert into public.${table}(user_id, role, chapter_id, granted_by) values ($1, $2, $3, $1) on conflict do nothing`, [id(n), role, chapter]);
    }
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "analytics-snapshot-cases-once-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '120s'");
    await db.query("set local track_functions = 'all'");
    await db.query("set local session_replication_role = replica");

    await db.query(`insert into public.organizations(id, slug, name, status, kind) values
      ($1, 'c9556-a', 'Fixture A', 'active', 'union'), ($2, 'c9556-b', 'Fixture B', 'active', 'union')`, [orgA, orgB]);
    await db.query(`insert into public.chapters(id, name, region, is_default, order_index, organization_id, slug) values
      ($1, 'Fixture A1', 'east', false, 9561, $5, $1), ($2, 'Fixture A2', 'east', false, 9562, $5, $2),
      ($3, 'Fixture A3', 'east', false, 9563, $5, $3), ($4, 'Fixture B1', 'east', false, 9564, $6, $4)`, [a1, a2, a3, b1, orgA, orgB]);

    // Members 1-60 in A1, 61-80 in A2, 81-90 in A3, 91-95 in B1. Member 89's
    // organization membership and member 88's chapter membership are revoked.
    for (let n = 1; n <= 95; n += 1) {
      const chapter = n <= 60 ? a1 : n <= 80 ? a2 : n <= 90 ? a3 : b1;
      await person(n, chapter, n <= 90 ? orgA : orgB, { orgStatus: n === 89 ? "revoked" : "active", chapterStatus: n === 88 ? "revoked" : "active" });
    }
    const homes = {
      [callers.chapterCoordinator]: a2, [callers.chapterCoordinatorCommittee]: a2, [callers.localSteward]: a3,
      [callers.closedChapterSteward]: a2, [callers.otherAdmin]: b1, [callers.localStewardOrgGrant]: a3,
    };
    for (const n of Object.values(callers)) await person(n, homes[n] ?? a1, n === callers.otherAdmin ? orgB : orgA);

    // One case per member, inside the six-month window; mixed status, step,
    // type, assignment, restriction and identity privacy.
    await db.query(`insert into public.member_cases(id, user_id, reference, title, case_type, organization_id, chapter_id, step, articles, status, deadline,
        steward_user_id, coordinator_user_id, is_restricted, restriction_reason, restricted_at, created_at, updated_at)
      select ('c9556c00-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
        ('${prefix}-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
        'c9556-' || n, 'Fixture case ' || n, case when n % 3 = 0 then 'other' else 'grievance' end,
        case when n <= 90 then $1::uuid else $2::uuid end,
        case when n <= 60 then $3 when n <= 80 then $4 when n <= 90 then $5 else $6 end,
        case when n % 7 = 0 then 'Intake' else 'Step 2' end, 'Article 5',
        case when n % 5 = 0 then 'resolved' else 'active' end, current_date + 10,
        case when n between 21 and 30 then $7::uuid end,
        case when n between 61 and 70 then $8::uuid end,
        n in (5, 25, 62, 84), case when n in (5, 25, 62, 84) then 'Fixture restriction' end, case when n in (5, 25, 62, 84) then now() end,
        date_trunc('month', now()) - interval '20 days' - (n || ' hours')::interval, now()
      from generate_series(1, 95) n`, [orgA, orgB, a1, a2, a3, b1, id(callers.chapterSteward), id(callers.chapterCoordinator)]);
    // Member 96 is at home in A1 and also belongs to A2, with a case in A2:
    // a coordinator of A2 reaches it through the case's chapter only
    // (casework_staff_can_access, second branch).
    await person(96, a1, orgA);
    await db.query("insert into public.member_chapter_memberships(user_id, chapter_id, status, pinned, joined_at) values ($1, $2, 'active', false, now())", [id(96), a2]);
    await db.query(`insert into public.member_cases(id, user_id, reference, title, case_type, organization_id, chapter_id, step, articles, status, deadline, is_restricted, created_at, updated_at)
      values ($1, $2, 'c9556-cross', 'Fixture cross-chapter case', 'grievance', $3, $4, 'Step 2', 'Article 5', 'active', current_date + 3, false, date_trunc('month', now()) - interval '12 days', now())`,
    [id(1204), id(96), orgA, a2]);
    // Member 97 belongs to A1 only but has a case in A3: a steward who reaches
    // A3 still needs the member in A3 (chapter_grievance_steward_scope).
    await person(97, a1, orgA);
    await db.query(`insert into public.member_cases(id, user_id, reference, title, case_type, organization_id, chapter_id, step, articles, status, deadline, is_restricted, created_at, updated_at)
      values ($1, $2, 'c9556-elsewhere', 'Fixture case outside the member chapter', 'grievance', $3, $4, 'Step 2', 'Article 5', 'active', current_date + 3, false, date_trunc('month', now()) - interval '13 days', now())`,
    [id(1205), id(97), orgA, a3]);
    // The caller member's own case and a case outside the window (a case
    // always has a chapter: member_cases_chapter_present).
    await db.query(`insert into public.member_cases(id, user_id, reference, title, case_type, organization_id, chapter_id, step, articles, status, deadline, is_restricted, created_at, updated_at)
      values ($1, $2, 'c9556-own', 'Fixture own case', 'grievance', $5, $6, 'Step 2', 'Article 5', 'active', current_date + 3, false, date_trunc('month', now()) - interval '10 days', now()),
        ($3, $4, 'c9556-old', 'Fixture old case', 'grievance', $5, $6, 'Step 2', 'Article 5', 'active', current_date + 3, false, now() - interval '400 days', now())`,
    [id(1201), id(callers.member), id(1202), id(2), orgA, a1]);
    await db.query("update public.member_cases set learning_undone_at = now() where reference = 'c9556-9'");
    await db.query("insert into private.case_identity_privacy(case_id) select id from public.member_cases where reference in ('c9556-7', 'c9556-63', 'c9556-84')");
    await db.query(`insert into public.casework_access_grants(case_id, organization_id, chapter_id, grantee_user_id, granted_by, reason)
      select c.id, c.organization_id, c.chapter_id, $1, $2, 'Fixture access grant' from public.member_cases c where c.reference = 'c9556-25'`,
    [id(callers.grantee), id(callers.orgAdmin)]);
    await db.query(`insert into public.casework_access_grants(case_id, organization_id, chapter_id, grantee_user_id, granted_by, reason)
      select c.id, c.organization_id, c.chapter_id, $1, $2, 'Fixture access grant' from public.member_cases c where c.reference = 'c9556-12'`,
    [id(callers.orgStewardUnassigned), id(callers.orgAdmin)]);

    // A unit of members 1-20 in A1 and a grievance committee of 61-65 in A2.
    await db.query("insert into private.chapter_units(id, organization_id, chapter_id, name, kind) values ($1, $2, $3, 'Fixture unit', 'unit')", [unit, orgA, a1]);
    await db.query("insert into private.chapter_unit_members(unit_id, chapter_id, user_id) select $1, $2, ('" + prefix + "-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid from generate_series(1, 20) n", [unit, a1]);
    await db.query("insert into private.chapter_committees(id, chapter_id, name, purpose, grievance_access) values ($1, $2, 'Fixture committee', 'Fixture purpose', true)", [committee, a2]);
    await db.query("insert into private.chapter_committee_members(committee_id, chapter_id, user_id) select $1, $2, ('" + prefix + "-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid from generate_series(61, 65) n", [committee, a2]);

    for (const [n, role] of [
      [callers.orgAdmin, "admin"], [callers.orgVp, "vp"], [callers.orgAdvisor, "advisor"], [callers.orgCoordinator, "coordinator"],
      [callers.orgStewardAssigned, "steward"], [callers.orgStewardUnassigned, "steward"],
      // A local-breadth steward of A3 who also holds an organization steward
      // grant with no assignment: unassigned in A1 and A2, so refused there.
      [callers.localStewardOrgGrant, "steward"],
    ]) {
      await db.query("insert into public.organization_role_grants(organization_id, user_id, role, granted_by) values ($1, $2, $3, $2)", [orgA, id(n), role]);
    }
    await db.query("insert into public.organization_role_grants(organization_id, user_id, role, granted_by) values ($1, $2, 'admin', $2)", [orgB, id(callers.otherAdmin)]);
    await db.query(`insert into private.organization_steward_unit_assignments(organization_id, user_id, role, chapter_id, unit_id)
      values ($1, $2, 'steward', $3, $4)`, [orgA, id(callers.orgStewardAssigned), a1, unit]);
    await chapterRole(callers.chapterSteward, "steward", a1);
    await chapterRole(callers.chapterStewardUnit, "steward", a1);
    await chapterRole(callers.chapterCoordinator, "coordinator", a2);
    await chapterRole(callers.chapterCoordinatorCommittee, "coordinator", a2);
    await chapterRole(callers.localSteward, "steward", a3);
    await chapterRole(callers.localStewardOrgGrant, "steward", a3);
    // A unit-scoped steward of A1 who is also a chapter-wide coordinator of
    // A3 (and a member there): the scope test admits A3 through the
    // chapter-wide coverage even for a target it cannot name.
    await db.query("insert into public.member_chapter_memberships(user_id, chapter_id, status, pinned, joined_at) values ($1, $2, 'active', false, now())", [id(callers.scopedStewardCoordinator), a3]);
    await chapterRole(callers.scopedStewardCoordinator, "steward", a1);
    await chapterRole(callers.scopedStewardCoordinator, "coordinator", a3);
    await chapterRole(callers.closedChapterSteward, "steward", a2);
    await db.query("insert into private.chapter_role_scopes(user_id, chapter_id, role, unit_id) values ($1, $2, 'steward', $3)", [id(callers.chapterStewardUnit), a1, unit]);
    await db.query("insert into private.chapter_role_scopes(user_id, chapter_id, role, unit_id) values ($1, $2, 'steward', $3)", [id(callers.scopedStewardCoordinator), a1, unit]);
    await db.query("insert into private.chapter_role_scopes(user_id, chapter_id, role, committee_id) values ($1, $2, 'coordinator', $3)", [id(callers.chapterCoordinatorCommittee), a2, committee]);
    await db.query(`insert into private.chapter_access_policies(chapter_id, steward_grievances, steward_breadth) values ($1, true, 'local'), ($2, false, 'chapter')
      on conflict (chapter_id) do update set steward_grievances = excluded.steward_grievances, steward_breadth = excluded.steward_breadth`, [a3, a2]);

    await db.query("set local session_replication_role = origin");
    for (const n of Object.values(callers)) {
      await db.query("insert into auth.sessions(id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal2')", [id(800 + n), id(n)]);
      await db.query("insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at) values ($1, $2, 'fixture', 'totp', 'verified', 'fixture', now(), now())", [id(700 + n), id(n)]);
    }
    await db.query("analyze public.member_cases, public.member_chapter_memberships, public.organization_memberships, public.organization_role_grants, public.member_role_chapters");
  }, runnerTimeout(120_000));

  afterAll(async () => {
    await db?.query("rollback").catch(() => {});
    await db?.end();
  });

  it("returns exactly the cases the per-case wrapper admits, for every caller", async () => {
    const seen = {};
    for (const [name, n] of Object.entries(callers)) {
      for (const org of [orgA, orgB]) {
        const { helperRows, wrapperRows } = await readableIds(n, org);
        expect(helperRows, `${name} ${org === orgA ? "A" : "B"}`).toEqual(wrapperRows);
        if (org === orgA) seen[name] = helperRows.length;
      }
    }
    console.info("Readable cases per caller", JSON.stringify(seen));
    const withoutStep = await readableIds(callers.orgAdmin, orgA, "aal1");
    expect(withoutStep.helperRows).toEqual(withoutStep.wrapperRows);
    expect(withoutStep.helperRows).toHaveLength(0);
    // The fixture reaches different branches: callers see different sets.
    expect(seen.orgAdmin).toBeGreaterThan(80);
    expect(seen.member).toBe(1);
    expect(seen.otherAdmin).toBe(0);
    expect(new Set(Object.values(seen)).size).toBeGreaterThan(6);
  }, runnerTimeout(120_000));

  it("answers as the predecessor snapshot does, refusals included, without a per-case wrapper call", async () => {
    for (const [name, n, aal] of [
      ["orgAdmin", callers.orgAdmin], ["orgVp", callers.orgVp], ["orgCoordinator", callers.orgCoordinator],
      ["orgStewardAssigned", callers.orgStewardAssigned], ["orgStewardUnassigned", callers.orgStewardUnassigned],
      ["chapterSteward", callers.chapterSteward], ["member", callers.member], ["orgAdmin aal1", callers.orgAdmin, "aal1"],
    ]) {
      const installed = await readSnapshot(n, aal);
      await db.query("savepoint predecessor_body");
      let previous;
      try {
        await db.query(predecessorSnapshot());
        previous = await readSnapshot(n, aal);
      } finally {
        await db.query("rollback to savepoint predecessor_body");
      }
      expect(installed.ok, name).toBe(previous.ok);
      if (!installed.ok) {
        expect(installed.code, name).toBe(previous.code);
        continue;
      }
      expect(installed.value, name).toEqual(previous.value);
      expect(installed.calls, `${name} per-case wrapper calls`).toBe(0);
      expect(previous.calls, `${name} predecessor per-case wrapper calls`).toBeGreaterThan(0);
    }
    const admin = await readSnapshot(callers.orgAdmin);
    expect(admin.value.cases.length).toBeGreaterThan(0);
  }, runnerTimeout(120_000));
});

live("the snapshot at demo scale (#9556)", () => {
  let db;
  const scale = "c9556500";
  const sid = (n) => `${scale}-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const org = sid(90001);
  const chapters = Array.from({ length: 6 }, (_, index) => `c9556s-ch-${index + 1}`);
  const admin = 1001;
  const steward = 1002;

  async function call(n) {
    await db.query("savepoint scale_call");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: sid(n), role: "authenticated", aal: "aal2", session_id: sid(5000 + n) })]);
      await db.query("set local role authenticated");
      const started = performance.now();
      const { rows } = await db.query("select public.get_organization_analytics_snapshot() - 'snapshotId' as value");
      return { ms: performance.now() - started, value: rows[0].value };
    } catch (error) {
      return { error: error.code, message: error.message };
    } finally {
      await db.query("rollback to savepoint scale_call");
      await db.query("reset role");
    }
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "analytics-snapshot-scale-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '120s'");
    await db.query("set local session_replication_role = replica");
    const user = (expr) => `('${scale}-0000-4000-8000-'||lpad((${expr})::text,12,'0'))::uuid`;
    const chapterOf = `'c9556s-ch-'||(((n - 1) % 6) + 1)`;
    await db.query("insert into public.organizations(id, slug, name, status, kind) values ($1, 'c9556-scale', 'Fixture scale', 'active', 'union')", [org]);
    await db.query(`insert into public.chapters(id, name, region, is_default, order_index, organization_id, slug)
      select 'c9556s-ch-'||n, 'Scale chapter '||n, 'scale', false, 9580+n, $1, 'c9556s-ch-'||n from generate_series(1, 6) n`, [org]);
    await db.query(`insert into auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous)
      select ${user("n")}, 'authenticated', 'authenticated', '${scale}-'||n||chr(64)||'example.invalid', '{"provider":"email","providers":["email"]}', '{}', now(), now(), false, false
      from generate_series(1, 1002) n`);
    await db.query(`insert into public.member_profiles(id, first_name, full_name, initials, chapter_id, role_line, member_since, language,
        notification_prefs, dnd_enabled, quiet_hours_timezone, urgent_notifications_enabled, shortcut_keys, work_widget_order, created_at, updated_at)
      select ${user("n")}, 'Scale', 'Scale member '||n, 'SM', ${chapterOf}, 'Member', 2020, 'en', '{}', false, 'UTC', true, '{}', '{}', now(), now()
      from generate_series(1, 1002) n`);
    await db.query(`insert into public.organization_memberships(organization_id, user_id, status) select $1, ${user("n")}, 'active' from generate_series(1, 1002) n`, [org]);
    await db.query(`insert into public.member_chapter_memberships(user_id, chapter_id, status, pinned, joined_at)
      select ${user("n")}, ${chapterOf}, 'active', true, now() from generate_series(1, 1002) n`);
    // 700 cases in the window and 250 before it, as on the demo.
    await db.query(`insert into public.member_cases(id, user_id, reference, title, case_type, organization_id, chapter_id, step, articles, status, deadline,
        steward_user_id, is_restricted, restriction_reason, restricted_at, created_at, updated_at)
      select gen_random_uuid(), ${user("((n - 1) % 1000) + 1")}, 'c9556s-'||n, 'Scale case '||n, (array['grievance','discipline','other'])[1 + n % 3], $1,
        'c9556s-ch-'||(((n - 1) % 6) + 1), case when n % 4 = 0 then 'Intake' else 'Step 2' end, 'Article 5',
        case when n % 3 = 0 then 'resolved' else 'active' end, current_date + (n % 30), null, n % 50 = 0,
        case when n % 50 = 0 then 'Fixture restriction' end, case when n % 50 = 0 then now() end,
        case when n <= 700 then date_trunc('month', now()) - interval '1 day' - ((n % 170) || ' days')::interval
          else now() - interval '300 days' end, now()
      from generate_series(1, 950) n`, [org]);
    await db.query("insert into private.chapter_units(id, organization_id, chapter_id, name, kind) values ($1, $2, $3, 'Scale unit', 'unit')", [sid(91001), org, chapters[0]]);
    await db.query(`insert into private.chapter_unit_members(unit_id, chapter_id, user_id) select $1, $2, ${user("n")} from generate_series(1, 600, 6) n`, [sid(91001), chapters[0]]);
    await db.query("insert into public.organization_role_grants(organization_id, user_id, role, granted_by) values ($1, $2, 'admin', $2), ($1, $3, 'steward', $3)", [org, sid(admin), sid(steward)]);
    await db.query("insert into private.organization_steward_unit_assignments(organization_id, user_id, role, chapter_id, unit_id) values ($1, $2, 'steward', $3, $4)", [org, sid(steward), chapters[0], sid(91001)]);
    await db.query("set local session_replication_role = origin");
    for (const n of [admin, steward]) {
      await db.query("insert into auth.sessions(id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal2')", [sid(5000 + n), sid(n)]);
      await db.query("insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at) values (gen_random_uuid(), $1, 'scale', 'totp', 'verified', 'scale', now(), now())", [sid(n)]);
    }
    await db.query("analyze public.member_cases, public.member_profiles, public.member_chapter_memberships, public.organization_memberships, public.chapters");
  }, runnerTimeout(120_000));

  afterAll(async () => {
    await db?.query("rollback").catch(() => {});
    await db?.end();
  });

  it("answers as an admin and as a unit-assigned steward well inside the page's 10 s limit", async () => {
    // The page aborts at 10 s; SAMPLE's 1 GB instance is several times slower
    // than a runner, so a runner holds it to 2 s (load-scaled, ledgers 254 and 319).
    const { budget, calibrationMs } = await loadScaledBudget(db, 2_000, { label: "organization analytics snapshot" });
    console.info("Organization analytics snapshot budget", JSON.stringify({ calibrationMs, budget }));
    for (const [who, n] of [["admin", admin], ["steward", steward]]) {
      await call(n);
      const first = await call(n);
      expect(first.error, `${who} ${first.message}`).toBeUndefined();
      expect(first.value.cases.length, who).toBeGreaterThan(0);
      const judged = await pairedFastest(db, first.ms, () => call(n), { baseMs: 2_000, budget });
      reportPaired(`organization analytics snapshot, ${who}`, judged.runs);
      expect(judged.best.ms, `${who} ${JSON.stringify(judged.runs)}`).toBeLessThan(judged.best.bound);
    }
  }, runnerTimeout(180_000));
});
