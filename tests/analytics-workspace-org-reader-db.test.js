// @vitest-environment node
//
// BUG-UG-SAMPLE-ANALYTICS-PANELS-TIME-OUT-20261030 (#6607)
//
// The organization analytics desk's Charts, Health tree and data explorer all
// come from public.get_organization_analytics_workspace. At Tamarack scale an
// organization advisor's read spent 810 of its 1,100 ms in one
// private.casework_staff_can_access call per active case. 20261030210000
// reads, once per call, whether the caller holds an organization advisor,
// admin or leader role and in which chapters private.actor_has_chapter_staff_role
// holds; for those callers each case reduces to its chapter being in that
// set. Everyone else keeps the shared per-case predicate.
//
// The offline half pins the migration text. The live half proves that for
// every staff hat the counters still equal exactly what the shared predicate
// admits, that an organization reader makes no per-case predicate call, and
// that a large roster of unassigned cases loads well inside the product's
// own 10 s deadline for an advisor.
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runnerTimeoutMultiplier } from "../scripts/lib/runner-timeout.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const statementTimeout = (seconds) => `${seconds * runnerTimeoutMultiplier()}s`;
const raw = loadMigrationSql("analytics_workspace_case_access_once");
const squash = (text) => text.replace(/\s+/g, " ").trim();
const body = squash(stripComments(fnBody(stripComments(raw), "public.get_organization_analytics_workspace")));

describe("analytics workspace organization-reader migration", () => {
  it("replaces only the pinned predecessor, in one bounded transaction", () => {
    const statements = stripComments(raw);
    expect(statements.trimStart().startsWith("begin;")).toBe(true);
    expect(statements.trimEnd().endsWith("commit;")).toBe(true);
    expect(raw).toContain("set local lock_timeout = '5s';");
    expect(raw).toContain("pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_organization_analytics_workspace()'::regprocedure)) <> 'c0648da6b0c4aaca1540f173668422b9'");
    expect(raw).toContain("grant execute on function public.get_organization_analytics_workspace() to authenticated;");
  });

  it("keeps the gates first and the shared predicate for every caller but an organization reader", () => {
    expect(body).toMatch(/^CREATE OR REPLACE FUNCTION public\.get_organization_analytics_workspace\(\) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS \$function\$ begin perform private\.lock_case_graph_read\(\); perform private\.member_pin_require_full_session\(\); declare/);
    expect(body).toContain("if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then raise exception 'not authorized'");
    expect(body).toContain("org_case_reader := private.has_organization_role(org, array['advisor','admin','vp']);");
    expect(body).toContain("from public.chapters c where c.organization_id = org and private.actor_has_chapter_staff_role(actor, c.id);");
    expect(body).toContain("and case when org_case_reader then cs.chapter_id = any(staff_chapters) else private.casework_staff_can_access(cs.id) end ) cases");
    expect(body.match(/private\.casework_staff_can_access/g)).toHaveLength(1);
    // The hoisted reads come after every authorization gate.
    expect(body.indexOf("org_case_reader :=")).toBeGreaterThan(body.indexOf("raise exception 'not authorized'"));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("analytics workspace for organization readers", () => {
  let client;
  const id = Object.fromEntries([
    "org", "steward", "stewardSession", "coordinator", "coordinatorSession", "advisor", "advisorSession",
    "admin", "adminSession", "memberM", "memberMSession", "memberN", "memberNSession",
  ].map((key) => [key, randomUUID()]));
  const tag = id.org.slice(0, 8);
  const chapterA = `aworg-a-${tag}`;
  const chapterB = `aworg-b-${tag}`;

  const act = async (actor, session) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
  };
  const workspace = async () => (await client.query("select public.get_organization_analytics_workspace() as value")).rows[0].value;

  // The shared predicate's answer for the current caller, per member row.
  // #6682 (20261102005607) counts what its read oracle admits, which adds
  // ordinary unassigned grievances in a steward's default chapters.
  const admitted = async () => {
    await client.query("reset role");
    const rows = (await client.query(
      `select c.user_id::text || ':' || c.chapter_id as key,
         count(*) filter (where c.status = 'active')::integer as active,
         count(*) filter (where c.status = 'active' and c.deadline < private.local_day(c.time_zone, pg_catalog.now()))::integer as overdue
       from public.member_cases c
       where c.organization_id = $1 and private.casework_staff_can_read(c.id)
       group by 1`, [id.org])).rows;
    await client.query("set local role authenticated");
    return new Map(rows.map((row) => [row.key, row]));
  };
  const expectAgreement = async (view) => {
    const want = await admitted();
    for (const entry of view.members) {
      const expected = want.get(entry.id) ?? { active: 0, overdue: 0 };
      expect(entry.activeCases, `${entry.id} active`).toBe(expected.active);
      expect(entry.overdueCases, `${entry.id} overdue`).toBe(expected.overdue);
    }
  };
  // Per-case predicate calls made by one workspace read, from this
  // transaction's own function statistics.
  const predicateCalls = async () => {
    await client.query("reset role");
    const before = (await client.query(
      "select coalesce(sum(calls), 0)::integer as n from pg_stat_xact_user_functions where schemaname = 'private' and funcname = 'casework_staff_can_access'",
    )).rows[0].n;
    return before;
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "analytics-workspace-org-reader-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query(`set local statement_timeout = '${statementTimeout(60)}'`);
    await client.query("set local lock_timeout = '15s'");
    await client.query("set local track_functions = 'all'");

    const people = [
      [id.steward, id.stewardSession, chapterA, "Steward AWOrg"],
      [id.coordinator, id.coordinatorSession, chapterA, "Coordinator AWOrg"],
      [id.advisor, id.advisorSession, chapterA, "Advisor AWOrg"],
      [id.admin, id.adminSession, chapterA, "Admin AWOrg"],
      [id.memberM, id.memberMSession, chapterA, "Member M AWOrg"],
      [id.memberN, id.memberNSession, chapterB, "Member N AWOrg"],
    ];
    for (const [user, session] of people) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic analytics factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [id.org, `aworg-${id.org}`, id.admin]);
    for (const [chapter, order] of [[chapterA, 9951], [chapterB, 9952]]) {
      await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,$3)", [chapter, id.org, order]);
    }
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [id.org]);
    for (const [user, , chapter, fullName] of people) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, user]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
      await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user, chapter, fullName]);
    }
    for (const [user, role] of [[id.steward, "steward"], [id.coordinator, "coordinator"], [id.advisor, "advisor"], [id.admin, "admin"]]) {
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$4)", [id.org, user, role, id.admin]);
    }
    // One assigned, one restricted and one other-chapter case, all overdue.
    for (const [owner, chapter, reference, steward, restricted] of [
      [id.memberM, chapterA, "CASE-AWORG-ASSIGNED", id.steward, false],
      [id.memberM, chapterA, "CASE-AWORG-RESTRICTED", null, true],
      [id.memberN, chapterB, "CASE-AWORG-SIBLING", null, false],
    ]) {
      await client.query(
        `insert into public.member_cases(
           id,user_id,reference,title,case_type,organization_id,chapter_id,step,articles,status,deadline,
           steward_user_id,is_restricted,restriction_reason,restricted_at,restricted_by)
         values($1,$2,$3,$3,'other',$4,$5,'Step 2','Article 5','active',current_date - 3,$6,$7,$8,$9,$10)`,
        [randomUUID(), owner, reference, id.org, chapter, steward, restricted,
          restricted ? "sensitive investigation" : null, restricted ? new Date() : null, restricted ? id.admin : null],
      );
    }

    // This broad-reader fixture is an
    // existing legacy grant; exercise its actual migration carry-over.
    await migrateLegacyStewardFixtures(client);
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("counts for every staff hat exactly what the shared predicate admits", async () => {
    for (const [actor, session] of [[id.steward, id.stewardSession], [id.coordinator, id.coordinatorSession],
      [id.advisor, id.advisorSession], [id.admin, id.adminSession]]) {
      await act(actor, session);
      await expectAgreement(await workspace());
    }
    await act(id.advisor, id.advisorSession);
    const advisorView = await workspace();
    // The advisor reads the restricted case and the other chapter's case too.
    expect(advisorView.members.find((entry) => entry.id === `${id.memberM}:${chapterA}`)).toMatchObject({ activeCases: 2, overdueCases: 2, attention: "urgent" });
    expect(advisorView.members.find((entry) => entry.id === `${id.memberN}:${chapterB}`)).toMatchObject({ activeCases: 1, overdueCases: 1 });
    await act(id.steward, id.stewardSession);
    expect((await workspace()).members.find((entry) => entry.id === `${id.memberM}:${chapterA}`)).toMatchObject({ activeCases: 1 });
  });

  it("makes no per-case predicate call for an organization reader and keeps it for everyone else", async () => {
    for (const [actor, session, perCase] of [[id.advisor, id.advisorSession, false], [id.admin, id.adminSession, false],
      [id.coordinator, id.coordinatorSession, true]]) {
      const before = await predicateCalls();
      await act(actor, session);
      await workspace();
      const calls = (await predicateCalls()) - before;
      if (perCase) expect(calls).toBeGreaterThan(0);
      else expect(calls).toBe(0);
    }
  });

  it("counts a case overdue on the zone it was set in, as the advisor overview does (#9678 final, r3s1)", async () => {
    // Noon UTC on December 1: already December 2 in Kiritimati, still December 1
    // in New York and on a UTC session. Both readers are re-created with that
    // clock, inside a savepoint this test rolls back.
    await client.query("reset role");
    await client.query("savepoint zone_overdue");
    try {
      const instant = "2026-12-01T12:00:00Z";
      for (const signature of ["public.get_organization_analytics_workspace()", "public.get_advisor_overview()"]) {
        const definition = (await client.query("select pg_catalog.pg_get_functiondef($1::regprocedure) as v", [signature])).rows[0].v;
        await client.query(definition.replace(/\b(?:pg_catalog\.)?now\(\)/giu, `('${instant}'::timestamptz)`));
      }
      await client.query("update public.platform_setting_definitions set release_at = null where key = 'features.governance.group_time_zones'");
      await client.query("update public.chapters set time_zone = 'Pacific/Kiritimati' where id = $1", [chapterA]);
      const counts = async () => {
        await act(id.advisor, id.advisorSession);
        const analytics = (await workspace()).members.find((entry) => entry.id === `${id.memberM}:${chapterA}`)?.overdueCases ?? 0;
        const overview = (await client.query("select public.get_advisor_overview() as v")).rows[0].v.atRisk.overdueCases;
        await client.query("reset role");
        return { analytics, overview };
      };
      const before = await counts();
      // A case whose deadline day, December 1, has passed in its own zone.
      const caseId = randomUUID();
      await client.query(
        `insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,step,articles,status,deadline,steward_user_id)
         values($1,$2,'CASE-AWORG-KIRITIMATI','CASE-AWORG-KIRITIMATI','other',$3,$4,'Step 2','Article 5','active','2026-12-01',$5)`,
        [caseId, id.memberM, id.org, chapterA, id.steward],
      );
      expect((await client.query("select time_zone as v from public.member_cases where id = $1", [caseId])).rows[0].v).toBe("Pacific/Kiritimati");
      const after = await counts();
      expect(after.overview - before.overview).toBe(1);
      expect(after.analytics - before.analytics).toBe(1);
    } finally {
      await client.query("reset role");
      await client.query("rollback to savepoint zone_overdue");
      await client.query("release savepoint zone_overdue");
    }
  });

  it("loads a large roster of unassigned cases for an advisor well inside the 10 s deadline", async () => {
    await client.query("reset role");
    await client.query("savepoint org_reader_performance");
    try {
      await client.query(`set local statement_timeout='${statementTimeout(120)}'`);
      await client.query("create temporary table aworg_perf_people as select gen_random_uuid() as id from generate_series(1,1000)");
      await client.query("set constraints all immediate");
      await client.query("alter table public.member_profiles disable trigger member_profiles_validate_focus_timezone");
      await client.query("insert into auth.users(id,email,raw_user_meta_data) select id,id::text || '@example.invalid','{}'::jsonb from aworg_perf_people");
      await client.query("alter table public.member_profiles enable trigger member_profiles_validate_focus_timezone");
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) select $1,id,'active' from aworg_perf_people", [id.org]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) select id,$1,'active' from aworg_perf_people", [chapterA]);
      await client.query("update public.member_profiles p set chapter_id=$1,full_name='Synthetic advisor-scale member' from aworg_perf_people x where p.id=x.id", [chapterA]);
      // Ten times the 51 active cases the Tamarack seed carries.
      await client.query("insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,step,articles,status,deadline) select gen_random_uuid(),p.id,'AWORG-PERF-' || row_number() over (), 'Synthetic case','other',$1,$2,'Step 2','Article 5','active',current_date-3 from (select id from aworg_perf_people limit 500) p", [id.org, chapterA]);
      await client.query("analyze public.member_cases; analyze public.member_chapter_memberships; analyze public.organization_memberships");
      await act(id.advisor, id.advisorSession);
      const started = performance.now();
      const result = await workspace();
      const elapsed = performance.now() - started;
      expect(result.members.length).toBeGreaterThanOrEqual(1006);
      expect(result.members.reduce((sum, entry) => sum + entry.activeCases, 0)).toBe(503);
      // The product's own deadline (src/lib/loadDeadline.js), never scaled;
      // before 20261030210000 this read made 503 per-case predicate calls.
      expect(elapsed).toBeLessThan(10000);
    } finally {
      await client.query("rollback to savepoint org_reader_performance");
      await client.query("reset role");
    }
  }, runnerTimeoutMultiplier() === 1 ? 180000 : 900000);
});
