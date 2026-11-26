// @vitest-environment node
//
// BUG-UG-COORDINATOR-KPIS-COUNT-RESTRICTED-CASES-20260917
//
// public.get_coordinator_kpis (20260723160000) predates both the casework suite
// and the organization scope foundation. Its `base` CTE was bounded only by
// `caller_chapter is null or p.chapter_id = caller_chapter`, with
// `caller_chapter` read from the LEGACY public.member_roles table, so:
//
//   * a chapter coordinator holding no public.casework_access_grants row still
//     had every restricted case counted in openCases, dueThisWeek,
//     inArbitration, byStep and byArticle; and
//   * for an organization-granted coordinator -- the shipped shape, for which
//     public.member_roles is empty -- the predicate was unconditionally true, so
//     the definer aggregated every member_cases row in the database, across
//     chapters and across tenants.
//
// 20260918200000 rebuilds the CTE as the same two bounds, in the same order,
// that private.casework_dashboard_open_cases uses (20260917142000): TENANT
// first, then private.casework_staff_can_access case by case.
//
// The offline half pins the migration text, the preserved function header, the
// byte-parity of the tenant bound with the PR #2109 aggregate it was copied
// from, and the db-contract needles. The live half is the part that matters: a
// SECURITY DEFINER aggregate's scope is only ever proved by calling it, the
// acceptance is an EQUALITY between two independently computed numbers -- the
// "05 Dashboards" badge and the by-step tile -- and the cost of a non-inlinable
// per-row helper is proved by counting its calls inside the read, which a
// loaded runner cannot move the way it moves a clock.
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";
import { findMigrationName, fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("coordinator_kpis_restriction_gate"));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const flat = squash(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const kpiDefinition = squash(stripComments(fnBody(sql, "public.get_coordinator_kpis")));

// The four predicates the tenant bound is copied FROM, read out of the #2109
// aggregate itself rather than restated here.
const dashboards = squash(stripComments(
  fnBody(loadMigrationSql("case_dashboard_aggregates"), "private.casework_dashboard_open_cases"),
));
const TENANT_BOUND = [
  "c.organization_id is not null",
  "c.chapter_id is not null",
  "c.organization_id = (select private.current_member_organization())",
  "c.chapter_id = (select private.current_member_chapter())",
];

// The cold (first) call against the mean of the two warm calls that follow it.
function coldCallRatio(runs) {
  return runs[0].wallMs / ((runs[1].wallMs + runs[2].wallMs) / 2);
}

// The read's work across ONE call, from the test's own transaction: calls per
// function (pg_stat_xact_user_functions under track_functions = 'all') and
// tuples read per table (pg_stat_xact_all_tables, sequential plus index). The
// counters are keyed "function:schema.name" and "table:schema.name".
//
// Returns every counter that gained half a call or half a tuple, or more, per
// case added to the sibling chapter; the scoped read gains none. The one
// allowance is a single pass over the added rows of public.member_cases: the
// tenant bound is a filter on that scan, so the scan reads the sibling rows it
// then drops before any helper sees them.
function siblingGrowthWork(baseline, grown, addedCases) {
  const grew = [];
  for (const key of new Set([...Object.keys(baseline), ...Object.keys(grown)])) {
    const added = (grown[key] ?? 0) - (baseline[key] ?? 0);
    const over = key === "table:public.member_cases" ? added > addedCases : added >= addedCases / 2;
    if (over) grew.push({ key, baseline: baseline[key] ?? 0, grown: grown[key] ?? 0 });
  }
  return grew;
}

describe("coordinator KPI sibling-growth work counters", () => {
  // Measured on a disposable stack at the committed shape (503 cases in the
  // caller's chapter, 1,500 then 3,000 in the sibling chapter), one call per
  // phase. The head: every per-case helper runs once per case in the caller's
  // chapter, in both phases.
  const head = (siblingRows) => ({
    "function:private.case_scope_and_identity_allowed": 503,
    "function:private.actor_case_scope_and_identity_allowed": 503,
    "function:private.steward_assignment_scopes": 503,
    "function:private.organization_steward_unassigned": 503,
    "function:private.current_member_organization": 8,
    "function:private.mfa_satisfied": 6,
    "table:public.member_cases": 504 + siblingRows,
    "table:public.chapters": 1021,
    "table:public.member_profiles": 16,
  });
  // The tenant CTE without its chapter bound: the same counts come back, but
  // every helper now runs over the whole organization.
  const unbounded = (siblingRows) => ({
    "function:private.case_scope_and_identity_allowed": 504 + siblingRows,
    "function:private.actor_case_scope_and_identity_allowed": 504 + siblingRows,
    "function:private.steward_assignment_scopes": 504 + siblingRows,
    "function:private.organization_steward_unassigned": 504 + siblingRows,
    "function:private.current_member_organization": 8,
    "function:private.mfa_satisfied": 6,
    "table:public.member_cases": 504 + siblingRows,
    "table:public.chapters": 16 + 2 * (504 + siblingRows),
    "table:public.member_profiles": 15,
  });

  it("passes the head, whose only growth is the one scan that drops the sibling rows", () => {
    expect(siblingGrowthWork(head(1500), head(3000), 1500)).toEqual([]);
  });

  it("fails the unbounded-scope mutant on every per-case helper and on the chapter reads", () => {
    const grew = siblingGrowthWork(unbounded(1500), unbounded(3000), 1500).map((row) => row.key);
    expect(grew).toEqual(expect.arrayContaining([
      "function:private.case_scope_and_identity_allowed",
      "function:private.steward_assignment_scopes",
      "table:public.chapters",
    ]));
    expect(grew).not.toContain("table:public.member_cases");
  });

  it("fails a second pass over the sibling rows and a helper that first appears with them", () => {
    const twice = { ...head(3000), "table:public.member_cases": 504 + 2 * 3000 };
    expect(siblingGrowthWork(head(1500), twice, 1500).map((row) => row.key)).toEqual(["table:public.member_cases"]);
    const fresh = { ...head(3000), "function:private.per_sibling_probe": 1500 };
    expect(siblingGrowthWork(head(1500), fresh, 1500).map((row) => row.key)).toEqual(["function:private.per_sibling_probe"]);
  });
});

describe("coordinator KPI cold-call ceiling", () => {
  // Per-call samples of the head on loaded shared runners on Oct 21 2026
  // (jobs 119234848929, 119297806193, 119468106901, 119470853664): the cold
  // call read 0.92-1.04x the warm calls while the absolute times reached
  // 10,121 ms, which is why the ceiling is a ratio and not a wall-clock budget.
  const loaded = [[4882, 5010, 5126], [10121, 9952, 10286], [4476, 4964, 4875], [5691, 5041, 5489]];
  const runs = (walls) => walls.map((wallMs) => ({ wallMs }));

  it("passes the head's own cold calls on slow and fast runners", () => {
    for (const walls of loaded) expect(coldCallRatio(runs(walls))).toBeLessThan(3);
    expect(coldCallRatio(runs([1206, 1340, 1514]))).toBeLessThan(3);
  });

  it("fails a mutant whose first call plans slowly while the warm calls stay fast", () => {
    expect(coldCallRatio(runs([16000, 5000, 5100]))).toBeGreaterThanOrEqual(3);
    expect(coldCallRatio(runs([4800, 1300, 1400]))).toBeGreaterThanOrEqual(3);
  });

  // On slow warm calls the ratio alone lets
  // a 14 s first call through, so the proof also caps it at three budgets.
  it("leaves a slow first call over slow warm calls to the absolute cap", () => {
    const slow = runs([14000, 5000, 5100]);
    expect(coldCallRatio(slow)).toBeLessThan(3);
    expect(slow[0].wallMs).toBeGreaterThanOrEqual(4000 * 3);
    for (const walls of loaded) expect(walls[0]).toBeLessThan(4000 * 3);
  });
});

describe("coordinator KPI restriction gate migration", () => {
  it("sorts after the newest stamp on any open candidate and takes a bounded lock inside one transaction", () => {
    const name = findMigrationName("coordinator_kpis_restriction_gate");
    expect(name > "20260918090000").toBe(true);
    // The helper it names is the casework suite's; the #2109 aggregates it
    // copies its tenant bound from are 20260917142000. Compose after them.
    expect(name > "20260917142000_case_dashboard_aggregates.sql").toBe(true);
    const statements = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    expect(statements.trimStart().startsWith("begin;")).toBe(true);
    expect(statements.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("set local lock_timeout = '5s';");
  });

  it("copies the #2109 tenant bound rather than paraphrasing it, and applies it BEFORE the helper", () => {
    // A paraphrase is exactly how the badge and the tile drifted apart: the KPI
    // bound on the case OWNER's current profile chapter while the tile bounds on
    // the CASE's own frozen chapter_id. Both predicate sets are read from their
    // own migrations, so this pin fails if either side is edited alone.
    for (const predicate of TENANT_BOUND) {
      expect(dashboards, `#2109 no longer states: ${predicate}`).toContain(predicate);
      expect(kpiDefinition, `KPI no longer states: ${predicate}`).toContain(predicate);
    }
    expect(kpiDefinition).toContain("with tenant as materialized (");
    expect(kpiDefinition).toContain("base as materialized ( select t.status, t.step, t.articles, t.deadline from tenant t where private.casework_staff_can_access(t.id) )");
    // Order is a property of the plan, not of a cost estimate: the helper is
    // SECURITY DEFINER and therefore never inlined, so it must run over the
    // tenant-bounded set and not over the table.
    expect(kpiDefinition.indexOf("with tenant as materialized"))
      .toBeLessThan(kpiDefinition.indexOf("private.casework_staff_can_access(t.id)"));
    // The superseded bound and everything it needed are gone; retaining them
    // would reintroduce the badge-vs-tile disagreement.
    expect(kpiDefinition).not.toContain("member_profiles");
    expect(kpiDefinition).not.toContain("member_roles");
    expect(kpiDefinition).not.toContain("caller_chapter");
  });

  it("states no second visibility predicate", () => {
    // The pins are on the DEFINITION, not the file: the COMMENT ON below it
    // names casework_access_grants in prose, which documents the rule the
    // function delegates to rather than restating it.
    expect(kpiDefinition).not.toContain("is_restricted");
    expect(kpiDefinition).not.toContain("casework_access_grants");
    expect(kpiDefinition).not.toContain("private.member_case_visible_to_caller");
    expect(kpiDefinition).not.toContain("private.member_case_restriction_cleared");
  });

  it("preserves the function's security header, its counts and its returned shape", () => {
    const header = kpiDefinition.slice(0, kpiDefinition.indexOf("as $$"));
    expect(header).toContain("create or replace function public.get_coordinator_kpis() returns jsonb");
    expect(header).toContain("language plpgsql");
    expect(header).toContain("security definer");
    expect(header).toContain("stable");
    expect(header).toContain("set search_path = ''");
    expect(kpiDefinition).toContain("not public.member_has_role(array['coordinator'])");
    expect(kpiDefinition).toContain("raise exception 'coordinator role required' using errcode = '42501'");
    for (const key of [
      "'openCases', open_cases", "'dueThisWeek', due_week", "'inArbitration', in_arb",
      "'resolved', resolved_cases", "'byStep', by_step", "'byArticle', by_article",
    ]) expect(kpiDefinition).toContain(key);
    // The due window and the arbitration predicate are mirrored by
    // public.list_coordinator_cases and must not move here. The tenant CTE
    // carries no status filter on purpose: `resolved` and resolutionRate need
    // the resolved half of the same scope.
    expect(kpiDefinition).toContain("b.deadline between current_date and current_date + 6");
    expect(kpiDefinition).toContain("b.step ~* 'arb' or b.step = 'Step 4'");
    expect(kpiDefinition).toContain("pg_catalog.count(*) filter (where b.status = 'resolved')");
  });

  it("issues no ACL, policy, table or index statement, so owner and grants survive the replace", () => {
    expect(flat).not.toMatch(/\bgrant\b/);
    expect(flat).not.toMatch(/\brevoke\b/);
    expect(flat).not.toMatch(/create policy|alter policy|drop policy/i);
    expect(flat).not.toMatch(/create table|alter table/i);
    expect(flat).not.toMatch(/create index|drop function/i);
  });

  it("pins the repaired aggregate in the database contract", () => {
    const entry = contract.functions.find((row) => row.sig === "public.get_coordinator_kpis()");
    // 20261028080000 (#4807) grants EXECUTE to authenticated only; hosted service_role reaches it as a member of authenticated.
    expect(entry).toMatchObject({ secdef: true, exec: "authenticated" });
    expect(entry.bodyContains).toEqual(expect.arrayContaining([
      "member_has_role(array['coordinator'])",
      "private.current_member_organization()",
      "private.current_member_chapter()",
      "private.case_scope_and_identity_allowed(t.case_row)",
      "chapter_scope as materialized",
      "organization_scope as materialized",
    ]));
    // The superseded bound must not come back through a later re-emission.
    expect(entry.bodyForbids).toEqual(expect.arrayContaining(["caller_chapter"]));
    // The entry carried needles but no md5 before this repair, so any later
    // edit to the aggregate could move a count without touching the contract.
    expect(entry.bodyMd5).toMatch(/^[0-9a-f]{32}$/);
    // #7593 composes the same read rule over statement-scoped authority sets;
    // its live proof compares full payloads and case ids with this predecessor.
    expect(entry.bodyForbids).toContain("private.casework_staff_can_read(");
    // The five #2109 aggregates continue using the shared by-id helper.
    const scope = contract.functions.find((row) => row.sig === "private.casework_dashboard_open_cases()");
    expect(scope.bodyContains).toContain("private.casework_staff_can_read(c.id)");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("coordinator KPI counts describe exactly the cases the caller may read", () => {
  let client;
  const id = Object.fromEntries([
    "ownerA", "ownerB", "coordinator", "advisor",
    "ownerASession", "ownerBSession", "coordinatorSession", "advisorSession",
    "org", "openCase", "restrictedCase", "restrictedResolvedCase", "foreignChapterCase",
  ].map((key) => [key, randomUUID()]));
  // TWO chapters on purpose. A single-chapter fixture makes the badge/tile
  // equality true by construction and cannot see the scope half of the defect:
  // private.actor_has_chapter_staff_role admits an organization-level role grant
  // for EVERY chapter in the organization, so before the tenant bound an
  // org-granted coordinator counted the sibling chapter's cases while the tile
  // beside them counted only their own.
  const chapterA = `kpi-gate-a-${id.org}`;
  const chapterB = `kpi-gate-b-${id.org}`;

  const act = async (actor, session) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
  };

  const kpis = async () => (await client.query("select public.get_coordinator_kpis() as k")).rows[0].k;

  // The #2109 counterpart: tile 1 is the only dashboard aggregate that counts
  // the same population as openCases/byStep, and it is the tile the badge sits
  // beside. Returned as a step -> count map plus its total.
  const byStepTile = async () => {
    const result = await client.query("select step, case_count from public.casework_dashboard_open_cases_by_step()");
    const map = Object.fromEntries(result.rows.map((row) => [row.step, Number(row.case_count)]));
    return { map, total: Object.values(map).reduce((sum, n) => sum + n, 0) };
  };

  const stepMap = (kpi) => Object.fromEntries(kpi.byStep.map((row) => [row.step, Number(row.count)]));
  const articleMap = (kpi) => Object.fromEntries(kpi.byArticle.map((row) => [row.articles, Number(row.count)]));

  // The acceptance in one place: the badge equals the tile total, and the two
  // independently computed by-step tallies are the same object. With the
  // sibling chapter present this can fail, so it is a real assertion.
  const assertBadgeMatchesTile = async (kpi) => {
    const tile = await byStepTile();
    expect(kpi.openCases).toBe(tile.total);
    expect(stepMap(kpi)).toEqual(tile.map);
    // The sibling chapter's only case is 'Step 5'; neither surface may show it.
    expect(Object.keys(tile.map)).not.toContain("Step 5");
  };

  const grantAccess = async (grantId, caseId, grantee) => {
    await client.query("reset role");
    await client.query(
      `insert into public.casework_access_grants(id,case_id,organization_id,chapter_id,grantee_user_id,granted_by,reason)
       values($1,$2,$3,$4,$5,$6,'escalation cover for the assigned coordinator')`,
      [grantId, caseId, id.org, chapterA, grantee, id.ownerA],
    );
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "coordinator-kpis-restriction-gate-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '120s'");
    await client.query("set local lock_timeout = '15s'");

    const people = [
      [id.ownerA, id.ownerASession, chapterA],
      [id.ownerB, id.ownerBSession, chapterB],
      [id.coordinator, id.coordinatorSession, chapterA],
      [id.advisor, id.advisorSession, chapterA],
    ];
    for (const [user, session] of people) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic KPI-gate factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [id.org, `kpi-gate-${id.org}`, id.ownerA]);
    for (const [chapter, order] of [[chapterA, 9903], [chapterB, 9904]]) {
      await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,$3)", [chapter, id.org, order]);
    }
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [id.org]);
    for (const [user, , chapter] of people) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, user]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
      await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
    }
    // ORGANIZATION-level grants, which is the shipped shape and the one that
    // leaves public.member_roles empty -- so the superseded `caller_chapter`
    // bound was vacuous for exactly this actor.
    // public.get_coordinator_kpis refuses any caller without the coordinator hat
    // (42501), so the advisor branch of private.casework_staff_can_access is
    // exercised by an organization ADVISOR who also wears that hat and holds no
    // casework_access_grants row -- the only actor shape that can reach the RPC
    // and still take the advisor/admin/vp bypass.
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)", [id.org, id.coordinator]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)", [id.org, id.advisor]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'advisor',$2)", [id.org, id.advisor]);

    // Chapter A: two open cases in distinct steps under distinct articles, both
    // inside the seven-day due window, plus a resolved restricted case so the
    // `resolved` count and resolutionRate are gated observably too. Only the
    // restricted pair carries 'Step 4', which is also the arbitration predicate.
    // Chapter B: one ordinary open case that no chapter-A caller may count.
    for (const [caseId, owner, chapter, reference, step, articles, status, restricted] of [
      [id.openCase, id.ownerA, chapterA, "CASE-KPI-OPEN", "Step 2", "Article 5", "active", false],
      [id.restrictedCase, id.ownerA, chapterA, "CASE-KPI-RESTRICTED", "Step 4", "Article 9", "active", true],
      [id.restrictedResolvedCase, id.ownerA, chapterA, "CASE-KPI-RESTRICTED-RESOLVED", "Step 3", "Article 9", "resolved", true],
      [id.foreignChapterCase, id.ownerB, chapterB, "CASE-KPI-SIBLING-CHAPTER", "Step 5", "Article 7", "active", false],
    ]) {
      await client.query(
        `insert into public.member_cases(
           id,user_id,reference,title,case_type,organization_id,chapter_id,
           step,articles,status,deadline,
           is_restricted,restriction_reason,restricted_at,restricted_by)
         values($1,$2,$3,$3,'other',$4,$5,$6,$7,$8,current_date + 2,$9,$10,$11,$12)`,
        [caseId, owner, reference, id.org, chapter, step, articles, status,
          restricted, restricted ? "sensitive investigation" : null,
          restricted ? new Date() : null, restricted ? id.ownerA : null],
      );
    }
  }, 180000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("omits a restricted case and a sibling chapter's case from every count for a coordinator with no grant", async () => {
    await act(id.coordinator, id.coordinatorSession);
    // Scope preconditions. The coordinator does see the owner; the restricted
    // rows are hidden by the member_cases policies; and the helper ALONE would
    // still admit the sibling chapter's case, because an organization-level role
    // grant makes private.actor_has_chapter_staff_role true for every chapter in
    // the organization. Only the tenant bound excludes it.
    expect((await client.query("select public.staff_can_see_user($1,'coordinator') as ok", [id.ownerA])).rows[0].ok).toBe(true);
    expect((await client.query("select private.casework_staff_can_access($1) as ok", [id.foreignChapterCase])).rows[0].ok).toBe(true);
    const visible = await client.query(
      "select id from public.member_cases where id = any($1::uuid[]) order by reference",
      [[id.openCase, id.restrictedCase, id.restrictedResolvedCase, id.foreignChapterCase]],
    );
    expect(visible.rows.map((row) => row.id).sort()).toEqual([id.openCase, id.foreignChapterCase].sort());

    const kpi = await kpis();
    expect(kpi.openCases).toBe(1);
    expect(kpi.dueThisWeek).toBe(1);
    expect(kpi.inArbitration).toBe(0);
    expect(kpi.resolved).toBe(0);
    expect(stepMap(kpi)).toEqual({ "Step 2": 1 });
    expect(articleMap(kpi)).toEqual({ "Article 5": 1 });
    // The restricted case's step and article are the side channel the record
    // names; the sibling chapter's are the cross-chapter leak the vacuous legacy
    // bound left open. Neither may appear at all.
    expect(Object.keys(stepMap(kpi))).not.toContain("Step 4");
    expect(Object.keys(stepMap(kpi))).not.toContain("Step 5");
    expect(Object.keys(articleMap(kpi))).not.toContain("Article 9");
    expect(Object.keys(articleMap(kpi))).not.toContain("Article 7");
    await assertBadgeMatchesTile(kpi);
  });

  it("restores every count for the same coordinator once an access grant is active", async () => {
    const grants = [randomUUID(), randomUUID()];
    await grantAccess(grants[0], id.restrictedCase, id.coordinator);
    await grantAccess(grants[1], id.restrictedResolvedCase, id.coordinator);

    await act(id.coordinator, id.coordinatorSession);
    const kpi = await kpis();
    expect(kpi.openCases).toBe(2);
    expect(kpi.dueThisWeek).toBe(2);
    expect(kpi.inArbitration).toBe(1);
    expect(kpi.resolved).toBe(1);
    expect(stepMap(kpi)).toEqual({ "Step 2": 1, "Step 4": 1 });
    expect(articleMap(kpi)).toEqual({ "Article 5": 1, "Article 9": 1 });
    expect(Number(kpi.resolutionRate)).toBe(33);
    // A grant reaches one case, never the sibling chapter.
    expect(Object.keys(stepMap(kpi))).not.toContain("Step 5");
    await assertBadgeMatchesTile(kpi);

    // Revoking withdraws them again, so the gate follows the grant rather than
    // a first-read cache.
    await client.query("reset role");
    for (const grant of grants) {
      await client.query("update public.casework_access_grants set revoked_at=now(), revoked_by=$2 where id=$1", [grant, id.ownerA]);
    }
    await act(id.coordinator, id.coordinatorSession);
    const after = await kpis();
    expect(after.openCases).toBe(1);
    expect(after.inArbitration).toBe(0);
    expect(after.resolved).toBe(0);
    expect(stepMap(after)).toEqual({ "Step 2": 1 });
    await assertBadgeMatchesTile(after);
  });

  it("counts restricted cases for an organization advisor holding no grant, and stops when the advisor hat is withdrawn", async () => {
    await act(id.advisor, id.advisorSession);
    const kpi = await kpis();
    expect(kpi.openCases).toBe(2);
    expect(kpi.dueThisWeek).toBe(2);
    expect(kpi.inArbitration).toBe(1);
    expect(kpi.resolved).toBe(1);
    expect(stepMap(kpi)).toEqual({ "Step 2": 1, "Step 4": 1 });
    expect(articleMap(kpi)).toEqual({ "Article 5": 1, "Article 9": 1 });
    // The advisor bypass is a RESTRICTION bypass, never a tenant bypass.
    expect(Object.keys(stepMap(kpi))).not.toContain("Step 5");
    await assertBadgeMatchesTile(kpi);

    // The negative companion. "Present for an advisor" also held before this
    // repair, so on its own it pins nothing: withdraw the advisor grant inside
    // the transaction and the same caller -- now a plain organization
    // coordinator with no casework_access_grants row -- must collapse to exactly
    // the ungranted coordinator's tallies.
    await client.query("reset role");
    await client.query(
      "delete from public.organization_role_grants where organization_id=$1 and user_id=$2 and role='advisor'",
      [id.org, id.advisor],
    );
    await act(id.advisor, id.advisorSession);
    const withdrawn = await kpis();
    expect(withdrawn.openCases).toBe(1);
    expect(withdrawn.dueThisWeek).toBe(1);
    expect(withdrawn.inArbitration).toBe(0);
    expect(withdrawn.resolved).toBe(0);
    expect(stepMap(withdrawn)).toEqual({ "Step 2": 1 });
    expect(articleMap(withdrawn)).toEqual({ "Article 5": 1 });
    await assertBadgeMatchesTile(withdrawn);

    await client.query("reset role");
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'advisor',$2)", [id.org, id.advisor]);
  });

  it("leaves the coordinator hat requirement and the unrestricted caseload untouched", async () => {
    await act(id.ownerA, id.ownerASession);
    await client.query("savepoint kpi_gate");
    await expect(client.query("select public.get_coordinator_kpis()")).rejects.toMatchObject({ code: "42501" });
    await client.query("rollback to savepoint kpi_gate");

    // The repair must not cost an in-scope coordinator a case they could always
    // read: the non-restricted case in their own chapter is still counted
    // everywhere it was before.
    await act(id.coordinator, id.coordinatorSession);
    const kpi = await kpis();
    expect(kpi.openCases).toBe(1);
    expect(kpi.dueThisWeek).toBe(1);
    expect(stepMap(kpi)).toEqual({ "Step 2": 1 });
    expect(articleMap(kpi)).toEqual({ "Article 5": 1 });
  });

  // The cost guard.
  //
  // private.casework_staff_can_access is SECURITY DEFINER and therefore never
  // inlined, so it runs once per surviving row at ~2.6-2.9 ms a row. The tenant
  // bound decides the SIZE of that population: without it the helper ran over
  // every member_cases row the database holds.
  //
  // The population this guard measures deliberately includes RESOLVED history in
  // the caller's own chapter. The tenant CTE carries no status filter -- the
  // #2109 tile filters status = 'active' before the helper, but `resolved` and
  // resolutionRate need the resolved half of the same scope -- so the chapter's
  // lifetime case count, not its working caseload, is what drives this number.
  // A fixture that parked all of its bulk in the sibling chapter would be blind
  // to the only population that never stops growing.
  //
  // Measured on the disposable stack, three samples each, head vs. a mutant with
  // the tenant bound removed:
  //
  //   chapter 200 active +   0 resolved, sibling 1800 :   558 ms | mutant 4994 ms
  //   chapter 200 active + 300 resolved, sibling 1500 :  1206-1514 ms | mutant 4808-5350 ms   <- committed
  //   chapter 200 active + 1300 resolved, sibling 500 :  3808-4270 ms | mutant 5054-5196 ms
  //   chapter 200 active + 1800 resolved, sibling   0 :  5013-5252 ms
  //
  // The 1,300-resolved shape straddles the budget (one run measured 3,808 /
  // 3,842 / 3,939 ms, the next 3,851 / 4,078 / 4,270 ms), so committing it would
  // be a flake generator rather than a guard. The committed shape keeps the same
  // 4,000 ms budget with ~2.6-3.3x headroom on this runner while still paying for
  // 300 resolved rows in the caller's own chapter, so the guard moves 1:1 with
  // the growth axis -- those 300 rows cost ~700 ms of the measured number. The
  // budget breach point (~1,400-1,550 in-chapter cases of ANY status) is
  // disclosed as an operating boundary in the migration header and the PR body
  // instead of being encoded here, because it is a property of the shared helper
  // and belongs to a follow-up record, not to this one.
  //
  // 4,000 ms is the repository's existing desk budget and rationale
  // (tests/steward-desk-scale-latency-db.test.js:155,195): half the production
  // statement-timeout headroom, on a deliberately slow shared runner.
  //
  // TEST-UG-COORDINATOR-KPIS-GROWTH-RATIO-PROOF-TRIPS-ON-RUNNER-NOISE-20261118:
  // #7593 (20261108173812) took this read from about 1.2 s to about 170 ms,
  // after which the old wall-clock growth ratio (grown median over base, at
  // most 1.35) failed unrelated pull requests on runner noise alone: run
  // 44455027022 read 172-175 / 225-258 / 177-181 ms (1.438), and another
  // host read 2.46. On a disposable stack the plan, its buffers and every
  // helper's call count were identical before and after the growth; the only
  // extra work was the tenant filter dropping 1,500 more rows in about 0.2 ms.
  // So the growth guard now counts the read's work instead of timing it.
  const SCALE = { chapterActive: 200, chapterResolved: 300, siblingChapterCases: 1500, budgetMs: runnerTimeout(4000), coldCallRatioLimit: 3 };

  it("stays inside the coordinator desk latency budget over a chapter's whole case history", async () => {
    await client.query("reset role");
    await client.query("savepoint kpi_scale");
    try {
      const seed = async (owner, chapter, count, tag, status) => {
        await client.query(
          `insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,step,articles,status,deadline)
           select extensions.gen_random_uuid(), $1, $2 || g::text, $2 || g::text, 'other', $3, $4,
                  'Step ' || (1 + (g % 3))::text, 'Article ' || (1 + (g % 5))::text, $6,
                  current_date + (g % 30)
           from generate_series(1, $5) g`,
          [owner, tag, id.org, chapter, count, status],
        );
      };
      await seed(id.ownerA, chapterA, SCALE.chapterActive, "SCALE-A-ACTIVE-", "active");
      await seed(id.ownerA, chapterA, SCALE.chapterResolved, "SCALE-A-RESOLVED-", "resolved");
      await seed(id.ownerB, chapterB, SCALE.siblingChapterCases, "SCALE-B-", "active");
      await client.query("analyze public.member_cases");

      // The population the helper is actually paid over: the chapter's whole
      // history, resolved rows included, plus the three base-fixture cases.
      const chapterPopulation = (await client.query(
        "select count(*)::int as n from public.member_cases where chapter_id = $1", [chapterA],
      )).rows[0].n;
      expect(chapterPopulation).toBe(SCALE.chapterActive + SCALE.chapterResolved + 3);

      // Three warm calls, median. The first call after a seed plans cold.
      const measure = async () => {
        await act(id.coordinator, id.coordinatorSession);
        const runs = [];
        for (let run = 0; run < 3; run += 1) {
          const started = process.hrtime.bigint();
          const kpi = (await client.query("select public.get_coordinator_kpis() as k")).rows[0].k;
          runs.push({
            wallMs: Number(process.hrtime.bigint() - started) / 1e6,
            openCases: kpi.openCases,
            resolved: kpi.resolved,
          });
        }
        return { runs, medianWallMs: runs.map((sample) => sample.wallMs).sort((a, b) => a - b)[1] };
      };
      // The work of exactly one call (see siblingGrowthWork). SET LOCAL here
      // is undone by the rollback to kpi_scale below.
      await client.query("reset role");
      await client.query("set local track_functions = 'all'");
      const counters = async () => {
        const functions = await client.query(
          "select schemaname || '.' || funcname as name, calls::text as n from pg_stat_xact_user_functions",
        );
        const tables = await client.query(
          `select schemaname || '.' || relname as name, (coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0))::text as n
           from pg_stat_xact_all_tables where schemaname not in ('pg_catalog', 'information_schema', 'pg_toast')`,
        );
        return Object.fromEntries([
          ...functions.rows.map((row) => [`function:${row.name}`, Number(row.n)]),
          ...tables.rows.map((row) => [`table:${row.name}`, Number(row.n)]),
        ]);
      };
      const work = async () => {
        await client.query("reset role");
        const before = await counters();
        await act(id.coordinator, id.coordinatorSession);
        await client.query("select public.get_coordinator_kpis() as k");
        await client.query("reset role");
        const after = await counters();
        return Object.fromEntries(Object.entries(after)
          .map(([key, n]) => [key, n - (before[key] ?? 0)])
          .filter(([, n]) => n !== 0));
      };
      const base = await measure();
      const baseWork = await work();
      const samples = base.runs;
      const tile = await byStepTile();

      // Scope invariance. The tenant bound makes the caller's cost independent
      // of the sibling chapter; the unbounded-scope mutant pays for every case in
      // the organization. Doubling the sibling chapter (2,004 -> 3,504 cases in
      // scope for the mutant) must add no helper call and no tuple read beyond
      // the one scan that drops the added rows. The base shape is counted again
      // after rolling the growth back, and the grown read is compared with both.
      await client.query("reset role");
      await client.query("savepoint kpi_scale_growth");
      await seed(id.ownerB, chapterB, SCALE.siblingChapterCases, "SCALE-B-MORE-", "active");
      await client.query("analyze public.member_cases");
      const grown = await measure();
      const grownWork = await work();
      await client.query("reset role");
      await client.query("rollback to savepoint kpi_scale_growth");
      await client.query("analyze public.member_cases");
      const rebase = await measure();
      const rebaseWork = await work();
      const growthRatio = grown.medianWallMs / ((base.medianWallMs + rebase.medianWallMs) / 2);
      const context = () => JSON.stringify({
        SCALE, chapterPopulation, samples, grown: grown.runs, rebase: rebase.runs, growthRatio,
        work: { base: baseWork, grown: grownWork, rebase: rebaseWork },
      });
      if (process.env.KPI_TIMING_REPORT) appendFileSync(process.env.KPI_TIMING_REPORT, context()+"\n");

      // The growth guard is the work, never the clock. An absolute wall-clock
      // budget cannot tell head from mutant on a loaded shared runner: on Oct 21
      // 2026 the head's median read 4,876 to 10,121 ms in jobs 119234848929,
      // 119297806193, 119468106901 and 119470853664, inside the mutant's
      // 4,808-5,350 ms range measured on a quiet runner
      // (BUG-UG-COORDINATOR-KPIS-CHAPTER-SCALE-TIMING-PROOF-FLAKE-20261021),
      // and the same-run ratio that replaced it tripped on noise once the read
      // became fast. growthRatio stays in the report for reading, not gating.
      expect(siblingGrowthWork(baseWork, grownWork, SCALE.siblingChapterCases), context()).toEqual([]);
      expect(siblingGrowthWork(rebaseWork, grownWork, SCALE.siblingChapterCases), context()).toEqual([]);
      // Not vacuous: in every phase the per-case helper ran over the chapter's
      // seeded history and over nothing past the chapter's own population (the
      // two restricted base-fixture cases may be decided before it). The
      // unbounded mutant runs it 2,004 times before the growth.
      for (const phaseWork of [baseWork, grownWork, rebaseWork]) {
        const perCase = phaseWork["function:private.case_scope_and_identity_allowed"];
        expect(perCase, context()).toBeGreaterThanOrEqual(SCALE.chapterActive + SCALE.chapterResolved);
        expect(perCase, context()).toBeLessThanOrEqual(chapterPopulation);
      }
      // The absolute ceiling only catches a gross regression.
      expect(base.medianWallMs, context()).toBeLessThan(SCALE.budgetMs * 3);
      // Every measure() follows an ANALYZE, so each phase's first call plans
      // cold, and the median drops that call whenever it is the slowest. Bound
      // it twice in every phase (TEST-UG-COORDINATOR-KPIS-COLD-CALL-
      // CEILING-AND-REGISTRY-NOTE-20261021; gate round 1 on #5638
      // and r1g2): relative to the same phase's two warm calls, so a cold-plan
      // regression fails while the warm calls stay fast, and absolutely at
      // three budgets, so it also fails when the warm calls are slow. The
      // loaded Oct 21 runners' first calls topped out at 10,121 ms.
      for (const phase of [base, grown, rebase]) {
        expect(coldCallRatio(phase.runs), context()).toBeLessThan(SCALE.coldCallRatioLimit);
        expect(phase.runs[0].wallMs, context()).toBeLessThan(SCALE.budgetMs * 3);
      }
      for (const sample of [...grown.runs, ...rebase.runs]) {
        expect(sample.openCases, context()).toBe(tile.total);
        expect(sample.resolved, context()).toBe(SCALE.chapterResolved);
      }
      for (const sample of samples) {
        // The scope, not just the clock: the badge still equals the tile.
        expect(sample.openCases, context()).toBe(tile.total);
        // The seeded resolved history is counted -- it is inside the scope and
        // therefore inside the measured cost. The base fixture's own resolved
        // case is restricted and its grant was revoked two cases above, so it
        // contributes nothing here.
        expect(sample.resolved, context()).toBe(SCALE.chapterResolved);
      }
      // Exact, not a ceiling. +1 is CASE-KPI-OPEN from the base fixture, the only
      // other case in this chapter this caller may read; the sibling chapter's
      // 1,500 cases are neither counted nor visited.
      expect(tile.total).toBe(SCALE.chapterActive + 1);
      expect(Object.keys(tile.map)).not.toContain("Step 5");
    } finally {
      await client.query("reset role");
      await client.query("rollback to savepoint kpi_scale");
    }
  }, 300000);
});
