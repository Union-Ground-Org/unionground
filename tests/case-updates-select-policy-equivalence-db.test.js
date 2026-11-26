// @vitest-environment node
//
// BUG-UG-STEWARD-CASE-LATEST-UPDATES-ROW-POLICY-SLOW-AT-SCALE-20261106 (#7360)
// 20261106226000 reduces member_case_updates_select to its last branch, D (the
// parent case satisfies private.chapter_case_readable). Branches A (own update
// on own case), B (assigned steward) and C (coordinator scope through
// public.staff_can_see_user on every update row) each require the parent case
// in an EXISTS that runs under member_cases' own policies, whose restrictive
// chapter_access_scope is chapter_case_readable, so each already implied D.
//
// Every hat, on a fixture that exercises each branch, restricted and assigned
// cases, a closed chapter policy, an explicit access grant, a private-identity
// case, another organization and a learning-period row:
// 1. every update row that A, B or C admits is also admitted by D;
// 2. the rows each hat reads directly and through list_case_latest_updates are
//    exactly the rows the 20261102005607 policy admitted;
// 3. the table's policies (names, commands, roles, permissive or restrictive)
//    are unchanged and only member_case_updates_select's predicate moved.
// Everything runs in one transaction that is rolled back.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const PREFIX = "f7360000";
const id = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const user = (n) => id(PREFIX, n);
const chapter = (n) => `${PREFIX}-ch-${n}`;

// The four branches of the 20261102005607 predicate, verbatim, over a row `u`.
const BRANCH = {
  a: "((select auth.uid()) = u.user_id and exists (select 1 from public.member_cases c where c.id = u.case_id and c.user_id = (select auth.uid())))",
  b: "(public.member_has_role(array['steward']) and exists (select 1 from public.member_cases c where c.id = u.case_id and c.steward_user_id = (select auth.uid())))",
  c: "(public.staff_can_see_user(u.user_id, 'coordinator') and exists (select 1 from public.member_cases c where c.id = u.case_id))",
  d: "exists (select 1 from public.member_cases c where c.id = u.case_id and private.chapter_case_readable(c.*))",
};
const PREDECESSOR_POLICY = `alter policy member_case_updates_select on public.member_case_updates using (
  (((select auth.uid()) = user_id) and exists (select 1 from public.member_cases c where c.id = member_case_updates.case_id and c.user_id = (select auth.uid())))
  or (public.member_has_role(array['steward']) and exists (select 1 from public.member_cases c where c.id = member_case_updates.case_id and c.steward_user_id = (select auth.uid())))
  or (public.staff_can_see_user(user_id, 'coordinator') and exists (select 1 from public.member_cases c where c.id = member_case_updates.case_id))
  or exists (select 1 from public.member_cases c where c.id = member_case_updates.case_id and private.chapter_case_readable(c.*)))`;
const PREDECESSOR_MD5 = "cfe0e26b58266f5920e5e6b236e9dc64";

live("member_case_updates_select is its readable-parent branch alone (#7360)", () => {
  let db;
  let callers;
  let caseIds;
  let orgId;

  async function as(caller, run, { aal = "aal2" } = {}) {
    await db.query("savepoint call");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: caller.id, role: "authenticated", aal, session_id: caller.session })]);
      await db.query("set local role authenticated");
      return await run();
    } finally {
      await db.query("rollback to savepoint call");
      await db.query("reset role");
    }
  }

  const visibleIds = async () => (await db.query(
    "select id from public.member_case_updates where case_id = any($1::uuid[]) order by id", [caseIds],
  )).rows.map((row) => row.id);
  const listed = async () => (await db.query(
    "select case_id, id, total_count from public.list_case_latest_updates($1::uuid[], 20) order by case_id, id", [caseIds],
  )).rows;
  const branches = async () => (await db.query(
    `select u.id, u.learning_undone_at is null live, ${BRANCH.a} a, ${BRANCH.b} b, ${BRANCH.c} c, ${BRANCH.d} d from l7360_updates u order by u.id`,
  )).rows;
  // Every hat under every reading, so both policies see identical claims.
  async function snapshot() {
    const result = {};
    for (const [who, caller] of Object.entries(callers)) {
      result[who] = await as(caller, async () => ({ direct: await visibleIds(), listed: await listed(), branches: await branches() }));
      result[`${who}Aal1`] = await as(caller, async () => ({ direct: await visibleIds(), listed: await listed() }), { aal: "aal1" });
    }
    return result;
  }
  const policies = async () => (await db.query(
    `select polname, polcmd, polpermissive, polroles::regrole[]::text[] roles from pg_catalog.pg_policy
      where polrelid = 'public.member_case_updates'::regclass order by polname`,
  )).rows;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "case-updates-select-policy-equivalence-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '120s'");
    await db.query("set local track_functions = 'all'");
    await db.query("set local session_replication_role = replica");

    // Members 1-40 in five chapters of one organization (chapter = n mod 5),
    // 41-46 in a sixth chapter of a second organization.
    orgId = id("f7360fff", 1);
    const otherOrg = id("f7360fff", 2);
    await db.query("insert into public.organizations(id,slug,name,status) values ($1,'equiv-7360','equiv-7360','active'),($2,'equiv-7360-other','equiv-7360-other','active')", [orgId, otherOrg]);
    await db.query(`insert into public.chapters(id,name,region,is_default,order_index,organization_id,slug)
      select '${PREFIX}-ch-'||n,'Equivalence chapter '||n,'scale',false,9800+n,case when n <= 5 then $1::uuid else $2::uuid end,'${PREFIX}-ch-'||n
      from generate_series(1, 6) n`, [orgId, otherOrg]);
    const userSql = `('${PREFIX}-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid`;
    const chapterSql = "case when n > 40 then 6 else ((n - 1) % 5) + 1 end";
    await db.query(`insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
      select ${userSql},'authenticated','authenticated','${PREFIX}-'||n||chr(64)||'example.invalid','{"provider":"email","providers":["email"]}','{}',now(),now(),false,false
      from generate_series(1, 46) n`);
    await db.query(`insert into public.member_profiles(id,first_name,full_name,initials,chapter_id,role_line,member_since,language,
        notification_prefs,dnd_enabled,quiet_hours_timezone,urgent_notifications_enabled,shortcut_keys,work_widget_order,created_at,updated_at)
      select ${userSql},'Equivalence','Equivalence member '||lpad(n::text,3,'0'),'EM','${PREFIX}-ch-'||(${chapterSql}),'Member',2020,'en','{}',false,'UTC',true,'{}','{}',now(),now()
      from generate_series(1, 46) n`);
    await db.query(`insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,joined_at)
      select ${userSql},'${PREFIX}-ch-'||(${chapterSql}),'active',true,now() from generate_series(1, 46) n`);
    await db.query(`insert into public.organization_memberships(organization_id,user_id,status)
      select case when n > 40 then $2::uuid else $1::uuid end,${userSql},'active' from generate_series(1, 46) n`, [orgId, otherOrg]);

    // Hats: member n sits in chapter ((n - 1) % 5) + 1.
    const hats = {
      chapterSteward: { n: 1, chapterRole: "steward", chapter: 1 },
      orgSteward: { n: 2, organizationRole: "steward" },
      chapterCoordinator: { n: 3, chapterRole: "coordinator", chapter: 3 },
      orgCoordinator: { n: 4, organizationRole: "coordinator" },
      advisor: { n: 5, organizationRole: "advisor" },
      admin: { n: 7, organizationRole: "admin" },
      vp: { n: 8, organizationRole: "vp" },
      grantedSteward: { n: 28, chapterRole: "steward", chapter: 3 },
      owner: { n: 11 },
      member: { n: 12 },
      foreignCoordinator: { n: 41, chapterRole: "coordinator", chapter: 6, organization: otherOrg },
    };
    callers = {};
    for (const [who, hat] of Object.entries(hats)) {
      const userId = user(hat.n);
      if (hat.organizationRole) {
        await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [hat.organization ?? orgId, userId, hat.organizationRole]);
      }
      if (hat.chapterRole) {
        for (const table of ["member_roles", "member_role_chapters"]) {
          await db.query(`insert into public.${table}(user_id,role,chapter_id,granted_by) values ($1,$2,$3,$1)`, [userId, hat.chapterRole, chapter(hat.chapter)]);
        }
      }
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,secret,created_at,updated_at) values (gen_random_uuid(),$1,'equiv','totp','verified','equiv',now(),now())", [userId]);
      callers[who] = { id: userId, session: id("f7360555", hat.n) };
    }

    // Cases: [n, owner, chapter, fields].
    const cases = [
      [1, 11, 1, {}],
      [2, 16, 1, { steward: 1 }],
      [3, 21, 1, { restricted: true, steward: 1 }],
      [4, 13, 3, { restricted: true, coordinator: 3 }],
      [5, 18, 3, { restricted: true }],
      [6, 23, 3, {}],
      [7, 14, 4, {}],
      [8, 19, 4, { restricted: true }],
      [9, 12, 2, { marked: true }],
      [10, 42, 6, { organization: otherOrg }],
      [11, 15, 5, { steward: 2 }],
      [12, 11, 3, {}],
    ];
    caseIds = [];
    for (const [n, owner, at, fields] of cases) {
      const caseId = id("f7360ca5", n);
      caseIds.push(caseId);
      await db.query(`insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,status,
          is_restricted,restriction_reason,restricted_at,steward_user_id,coordinator_user_id)
        values ($1,$2,$3,'Equivalence case','other',$4,$5,'active',$6,case when $6 then 'Fixture restriction' end,case when $6 then now() end,$7,$8)`,
      [caseId, user(owner), `equiv-7360-${n}`, fields.organization ?? orgId, chapter(at), fields.restricted ?? false,
        fields.steward ? user(fields.steward) : null, fields.coordinator ? user(fields.coordinator) : null]);
      if (fields.marked) await db.query("insert into private.case_identity_privacy(case_id) values ($1)", [caseId]);
    }
    // Stewards may not see grievances in chapter four, so its restricted case
    // reaches only organization hats. A chapter-three steward holds an
    // explicit grant on that chapter's unassigned restricted case.
    await db.query("insert into private.chapter_access_policies(chapter_id,steward_grievances) values ($1,false)", [chapter(4)]);
    await db.query(`insert into public.casework_access_grants(id,case_id,organization_id,chapter_id,grantee_user_id,reason,granted_at)
      values (gen_random_uuid(),$1,$2,$3,$4,'Equivalence grant',now())`, [id("f7360ca5", 5), orgId, chapter(3), callers.grantedSteward.id]);

    // Updates: two by the case owner, one whose user_id is a different member
    // (so A and C are tested on a user_id that is not the owner), and on case
    // one a row undone during a learning period.
    let u = 0;
    for (const [n, owner] of cases) {
      for (const [writer, undone] of [[owner, false], [owner, false], [owner === 11 ? 12 : 11, false], ...(n === 1 ? [[owner, true]] : [])]) {
        u += 1;
        await db.query(`insert into public.member_case_updates(id,case_id,user_id,body,created_at,learning_undone_at)
          values ($1,$2,$3,'Equivalence note',now() - make_interval(mins => $4::integer),$5)`,
        [id("f736000a", u), id("f7360ca5", n), user(writer), u, undone ? new Date() : null]);
      }
    }
    await db.query("create temp table l7360_updates on commit drop as select * from public.member_case_updates where case_id = any($1::uuid[])", [caseIds]);
    await db.query("grant select on l7360_updates to authenticated");

    await db.query("set local session_replication_role = origin");
    for (const caller of Object.values(callers)) {
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),'aal2')", [caller.session, caller.id]);
    }

    // #8589 re-final: committed data gives every steward grant its migration

    // assignments; an organization grant reaches only chapters it has one in.

    await migrateLegacyStewardFixtures(db);
  }, runnerTimeout(120_000));

  afterAll(async () => {
    await db?.query("rollback").catch(() => {});
    await db?.end();
  });

  it("admits through D every row that A, B or C admits, for every hat", async () => {
    const seen = { a: 0, b: 0, c: 0, d: 0 };
    for (const [who, caller] of Object.entries(callers)) {
      const rows = await as(caller, branches);
      expect(rows.length, who).toBe(37);
      for (const row of rows) {
        for (const key of Object.keys(seen)) if (row[key]) seen[key] += 1;
        if (row.a || row.b || row.c) expect(row.d, `${who} ${row.id}`).toBe(true);
      }
    }
    // The fixture exercises each branch, so the implication is not vacuous.
    expect(seen.a).toBeGreaterThan(0);
    expect(seen.b).toBeGreaterThan(0);
    expect(seen.c).toBeGreaterThan(0);
    expect(seen.d).toBeGreaterThan(seen.a);
  }, runnerTimeout(60_000));

  it("gives every hat exactly the rows the 20261102005607 policy gave it, with the same policy set", async () => {
    const installedPolicies = await policies();
    const installed = await snapshot();

    await db.query("savepoint predecessor");
    try {
      await db.query(PREDECESSOR_POLICY);
      await db.query("set local search_path = pg_catalog");
      const { rows: [{ md5 }] } = await db.query(
        "select md5(pg_get_expr(polqual, polrelid)) from pg_policy where polrelid = 'public.member_case_updates'::regclass and polname = 'member_case_updates_select'",
      );
      await db.query("reset search_path");
      // The predecessor exactly as 20261102005607 installed it.
      expect(md5).toBe(PREDECESSOR_MD5);
      expect(await policies()).toEqual(installedPolicies);
      const before = await snapshot();
      for (const who of Object.keys(installed)) {
        expect(installed[who].direct, who).toEqual(before[who].direct);
        expect(installed[who].listed, who).toEqual(before[who].listed);
      }
    } finally {
      await db.query("rollback to savepoint predecessor");
    }

    // Five policies, unchanged in name, command, roles and kind.
    expect(installedPolicies).toEqual([
      { polname: "member_case_updates_insert_own", polcmd: "a", polpermissive: true, roles: ["authenticated"] },
      { polname: "member_case_updates_learning_undone", polcmd: "r", polpermissive: false, roles: ["authenticated"] },
      { polname: "member_case_updates_select", polcmd: "r", polpermissive: true, roles: ["authenticated"] },
      { polname: "member_pin_step_up", polcmd: "*", polpermissive: false, roles: ["authenticated"] },
      { polname: "mfa_assurance", polcmd: "*", polpermissive: false, roles: ["authenticated"] },
    ]);
    // Not vacuous: the owner, the assigned, organization and granted stewards
    // and the coordinators read notes; the other organization's coordinator
    // reads only its own organization's case and nobody else reads that case;
    // every aal1 session reads none; the learning-period row reaches nobody.
    for (const who of ["owner", "chapterSteward", "orgSteward", "chapterCoordinator", "orgCoordinator", "grantedSteward"]) {
      expect(installed[who].direct.length, who).toBeGreaterThan(0);
    }
    const foreignCase = [29, 30, 31].map((n) => id("f736000a", n));
    expect(installed.foreignCoordinator.direct).toEqual(foreignCase);
    for (const who of Object.keys(callers).filter((name) => name !== "foreignCoordinator")) {
      for (const row of foreignCase) expect(installed[who].direct, who).not.toContain(row);
    }
    for (const who of Object.keys(callers)) expect(installed[`${who}Aal1`].direct, who).toEqual([]);
    const undone = id("f736000a", 4);
    for (const who of Object.keys(installed)) expect(installed[who].direct, who).not.toContain(undone);
  }, runnerTimeout(90_000));

  it("no longer runs the coordinator check once per update row", async () => {
    const calls = async () => (await db.query(
      "select coalesce(sum(calls),0)::integer calls from pg_stat_xact_user_functions where schemaname = 'public' and funcname = 'staff_can_see_user'",
    )).rows[0].calls;
    const measure = async () => {
      const before = await calls();
      const rows = await as(callers.chapterSteward, visibleIds);
      return { rows, calls: (await calls()) - before };
    };
    const installed = await measure();
    await db.query("savepoint predecessor_calls");
    try {
      await db.query(PREDECESSOR_POLICY);
      const before = await measure();
      expect(installed.rows).toEqual(before.rows);
      // The predecessor reached branch C, one staff_can_see_user call, for
      // every live row that A and B did not already admit.
      const reachedC = (await as(callers.chapterSteward, branches)).filter((row) => row.live && !row.a && !row.b).length;
      expect(reachedC).toBeGreaterThanOrEqual(25);
      expect(before.calls - installed.calls).toBeGreaterThanOrEqual(reachedC);
    } finally {
      await db.query("rollback to savepoint predecessor_calls");
    }
  }, runnerTimeout(60_000));
});
