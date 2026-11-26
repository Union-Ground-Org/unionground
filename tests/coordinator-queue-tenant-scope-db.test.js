// @vitest-environment node
//
// BUG-UG-COORDINATOR-QUEUE-AND-KPI-SCOPE-DIVERGE-20260918
//
// public.list_coordinator_cases (20260805120000) is SECURITY INVOKER and was
// bounded only by the member_cases SELECT policies. An organization-level
// coordinator grant makes private.actor_has_chapter_staff_role true for every
// chapter in the organization, so a sibling chapter's case appeared in the
// queue. PR #2171 bounds public.get_coordinator_kpis to the caller's tenant
// with the same predicates private.casework_dashboard_open_cases uses, so
// after that sibling lands one loadCoordinatorDesk call yields badge 1,
// queue 2, tile 1.
//
// 20260919011000 re-emits the pager with that SAME tenant bound, applied
// before the RLS-visible read. Visibility stays invoker + RLS: a restricted
// case without a grant is already hidden, and this function must not grow a
// definer-scope audit surface.
//
// The offline half pins the migration text, the byte-parity of the tenant
// bound with the #2109 aggregate it was copied from, and the db-contract
// needles. The live half is the part that matters: queue row count equals
// the #2109 tile total for the same caller; a chapter-level coordinator
// sees only its chapter; an ungranted coordinator sees a restricted case
// in neither; no successful RPC returns a case the caller could not SELECT.
//
// #2171 is NOT in this base. This suite cannot assert the KPI badge. After
// that sibling merges, badge, queue and tile agree for both fixtures.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("coordinator_queue_tenant_scope"));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const flat = squash(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const queueDefinition = squash(stripComments(fnBody(sql, "public.list_coordinator_cases")));

const dashboards = squash(stripComments(
  fnBody(loadMigrationSql("case_dashboard_aggregates"), "private.casework_dashboard_open_cases"),
));
const TENANT_BOUND = [
  "c.organization_id is not null",
  "c.chapter_id is not null",
  "c.organization_id = (select private.current_member_organization())",
  "c.chapter_id = (select private.current_member_chapter())",
];

describe("coordinator queue tenant-scope migration", () => {
  it("sorts after the newest stamp on any open candidate and takes a bounded lock inside one transaction", () => {
    const name = findMigrationName("coordinator_queue_tenant_scope");
    expect(name > "20260918090000").toBe(true);
    expect(name).toBe("20260919011000_coordinator_queue_tenant_scope.sql");
    expect(name > "20260917142000_case_dashboard_aggregates.sql").toBe(true);
    const statements = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    expect(statements.trimStart().startsWith("begin;")).toBe(true);
    expect(statements.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("set local lock_timeout = '5s';");
  });

  it("copies the #2109 tenant bound rather than paraphrasing it, and applies it BEFORE the remaining predicates", () => {
    for (const predicate of TENANT_BOUND) {
      expect(dashboards, `#2109 no longer states: ${predicate}`).toContain(predicate);
      expect(queueDefinition, `queue no longer states: ${predicate}`).toContain(predicate);
    }
    expect(queueDefinition.indexOf("c.status = 'active'"))
      .toBeLessThan(queueDefinition.indexOf("c.organization_id is not null"));
    expect(queueDefinition.indexOf("c.chapter_id = (select private.current_member_chapter())"))
      .toBeLessThan(queueDefinition.indexOf("p_focus <> 'due'"));
    expect(queueDefinition).not.toContain("private.casework_staff_can_access");
    expect(queueDefinition).not.toContain("member_profiles");
    expect(queueDefinition).not.toContain("caller_chapter");
  });

  it("preserves the function's invoker header, focus predicates, keyset, page clamp and grants", () => {
    const header = queueDefinition.slice(0, queueDefinition.indexOf("as $$"));
    expect(header).toContain("create or replace function public.list_coordinator_cases( p_focus text default 'all', p_after_deadline date default null, p_after_id uuid default null, p_limit integer default 200 ) returns setof public.member_cases");
    expect(header).toContain("language plpgsql");
    expect(header).toContain("security invoker");
    expect(header).toContain("stable");
    expect(header).toContain("set search_path = ''");
    expect(queueDefinition).not.toContain("security definer");
    expect(queueDefinition).toContain("not public.member_has_role(array['coordinator'])");
    expect(queueDefinition).toContain("raise exception 'coordinator role required' using errcode = '42501'");
    expect(queueDefinition).toContain("p_focus not in ('all', 'due', 'arbitration')");
    expect(queueDefinition).toContain("c.deadline between current_date and current_date + 6");
    expect(queueDefinition).toContain("c.step ~* 'arb' or c.step = 'Step 4'");
    expect(queueDefinition).toContain("order by c.deadline asc nulls last, c.id asc");
    expect(queueDefinition).toContain("least(greatest(coalesce(p_limit, 200), 1), 200)");
    expect(flat).toContain(
      "revoke all on function public.list_coordinator_cases(text, date, uuid, integer) from public, anon;",
    );
    expect(flat).toContain(
      "grant execute on function public.list_coordinator_cases(text, date, uuid, integer) to authenticated, service_role;",
    );
  });

  it("pins the repaired pager in the database contract", () => {
    const entry = contract.functions.find((row) => (
      row.sig === "public.list_coordinator_cases(p_focus text, p_after_deadline date, p_after_id uuid, p_limit integer)"
    ));
    expect(entry).toMatchObject({ secdef: false, exec: "authenticated,service_role" });
    expect(entry.bodyContains).toEqual(expect.arrayContaining([
      "member_has_role(array['coordinator'])",
      "c.organization_id = (select private.current_member_organization())",
      "c.chapter_id = (select private.current_member_chapter())",
      // #8568 part B: the seven-day due window starts on the Eastern day;
      // #9446 part 4a: on each case's own zone.
      "c.deadline between (pg_catalog.now() at time zone c.time_zone)::date and (pg_catalog.now() at time zone c.time_zone)::date + 6",
      "c.step ~* 'arb' or c.step = 'Step 4'",
      "order by c.deadline asc nulls last, c.id asc",
    ]));
    expect(entry.bodyForbids).toEqual(expect.arrayContaining(["security definer"]));
    // Since 20261022053100 the pager calls private.casework_staff_can_access on
    // its cross-organization grant branch only; its tenant
    // branch is still invoker + RLS.
    expect(entry.bodyForbids).not.toContain("private.casework_staff_can_access");
    expect(entry.bodyContains).toContain("and private.casework_staff_can_access(c.id)");
    expect(entry.bodyMd5).toMatch(/^[0-9a-f]{32}$/);
    const scope = contract.functions.find((row) => row.sig === "private.casework_dashboard_open_cases()");
    expect(scope.bodyContains).toContain("c.organization_id = (select private.current_member_organization())");
    expect(scope.bodyContains).toContain("c.chapter_id = (select private.current_member_chapter())");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("coordinator queue rows describe exactly the caller's tenant-visible cases", () => {
  let client;
  const id = Object.fromEntries([
    "ownerA", "ownerB", "orgCoordinator", "chapterCoordinator",
    "ownerASession", "ownerBSession", "orgCoordinatorSession", "chapterCoordinatorSession",
    "org", "openCaseA", "restrictedCaseA", "openCaseB",
  ].map((key) => [key, randomUUID()]));
  const chapterA = `qscope-a-${id.org}`;
  const chapterB = `qscope-b-${id.org}`;

  const act = async (actor, session) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
  };

  const queue = async (focus = "all") => {
    const result = await client.query(
      "select id, chapter_id, reference, status from public.list_coordinator_cases($1, null, null, 200)",
      [focus],
    );
    return result.rows;
  };

  const readableIds = async (caseIds) => {
    const result = await client.query(
      "select id from public.member_cases where id = any($1::uuid[])",
      [caseIds],
    );
    return result.rows.map((row) => row.id).sort();
  };

  const byStepTile = async () => {
    const result = await client.query(
      "select step, case_count from public.casework_dashboard_open_cases_by_step()",
    );
    const map = Object.fromEntries(result.rows.map((row) => [row.step, Number(row.case_count)]));
    return { map, total: Object.values(map).reduce((sum, n) => sum + n, 0) };
  };

  const attempt = async (sqlText, params = []) => {
    await client.query("savepoint queue_scope");
    try {
      const result = await client.query(sqlText, params);
      await client.query("release savepoint queue_scope");
      return { ok: true, rows: result.rows, rowCount: result.rowCount };
    } catch (error) {
      await client.query("rollback to savepoint queue_scope");
      return { ok: false, code: error.code, message: error.message };
    }
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "coordinator-queue-tenant-scope-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    const people = [
      [id.ownerA, id.ownerASession, chapterA],
      [id.ownerB, id.ownerBSession, chapterB],
      [id.orgCoordinator, id.orgCoordinatorSession, chapterA],
      [id.chapterCoordinator, id.chapterCoordinatorSession, chapterB],
    ];
    for (const [user, session] of people) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic queue-scope factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [id.org, `qscope-${id.org}`, id.ownerA]);
    for (const [chapter, order] of [[chapterA, 9911], [chapterB, 9912]]) {
      await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,$3)", [chapter, id.org, order]);
    }
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [id.org]);
    for (const [user, , chapter] of people) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, user]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
      await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
    }
    await client.query(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)",
      [id.org, id.orgCoordinator],
    );
    await client.query(
      "insert into public.member_roles(user_id,role,granted_by,chapter_id) values($1,'coordinator',$2,$3)",
      [id.chapterCoordinator, id.ownerB, chapterB],
    );
    await client.query(
      "insert into public.member_role_chapters(user_id,role,chapter_id,granted_by) values($1,'coordinator',$2,$3)",
      [id.chapterCoordinator, chapterB, id.ownerB],
    );

    for (const [caseId, owner, chapter, reference, step, restricted] of [
      [id.openCaseA, id.ownerA, chapterA, "CASE-QSCOPE-OPEN-A", "Step 2", false],
      [id.restrictedCaseA, id.ownerA, chapterA, "CASE-QSCOPE-RESTRICTED-A", "Step 4", true],
      [id.openCaseB, id.ownerB, chapterB, "CASE-QSCOPE-OPEN-B", "Step 5", false],
    ]) {
      await client.query(
        `insert into public.member_cases(
           id,user_id,reference,title,case_type,organization_id,chapter_id,
           step,articles,status,deadline,
           is_restricted,restriction_reason,restricted_at,restricted_by)
         values($1,$2,$3,$3,'other',$4,$5,$6,'Article 5','active',current_date + 2,$7,$8,$9,$10)`,
        [caseId, owner, reference, id.org, chapter, step,
          restricted, restricted ? "sensitive investigation" : null,
          restricted ? new Date() : null, restricted ? id.ownerA : null],
      );
    }
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("makes an organization-level coordinator's queue row count equal the #2109 tile total", async () => {
    await act(id.orgCoordinator, id.orgCoordinatorSession);
    // Preconditions: RLS still admits the sibling chapter (the defect this
    // record names) and hides the restricted case. The helper alone would
    // also admit the sibling, because an organization-level role grant makes
    // private.actor_has_chapter_staff_role true for every chapter.
    expect((await client.query(
      "select public.staff_can_see_user($1,'coordinator') as ok",
      [id.ownerA],
    )).rows[0].ok).toBe(true);
    expect((await client.query(
      "select public.staff_can_see_user($1,'coordinator') as ok",
      [id.ownerB],
    )).rows[0].ok).toBe(true);
    expect(await readableIds([id.openCaseA, id.restrictedCaseA, id.openCaseB]))
      .toEqual([id.openCaseA, id.openCaseB].sort());

    const rows = await queue("all");
    const tile = await byStepTile();
    expect(rows.map((row) => row.id)).toEqual([id.openCaseA]);
    expect(rows).toHaveLength(tile.total);
    expect(tile.total).toBe(1);
    expect(Object.keys(tile.map)).not.toContain("Step 5");
    expect(Object.keys(tile.map)).not.toContain("Step 4");
    // #2171 is not in this base: get_coordinator_kpis still counts across
    // chapters for an organization-level grant. Do not assert the badge here.
  });

  it("lets a chapter-level coordinator see only its chapter", async () => {
    await act(id.chapterCoordinator, id.chapterCoordinatorSession);
    expect(await readableIds([id.openCaseA, id.restrictedCaseA, id.openCaseB]))
      .toEqual([id.openCaseB]);
    const rows = await queue("all");
    const tile = await byStepTile();
    expect(rows.map((row) => row.id)).toEqual([id.openCaseB]);
    expect(rows).toHaveLength(tile.total);
    expect(tile.total).toBe(1);
    expect(Object.keys(tile.map)).toEqual(["Step 5"]);
  });

  it("shows a restricted case in neither the queue nor the #2109 tile for an ungranted coordinator", async () => {
    await act(id.orgCoordinator, id.orgCoordinatorSession);
    const rows = await queue("all");
    const tile = await byStepTile();
    expect(rows.map((row) => row.id)).not.toContain(id.restrictedCaseA);
    expect(await readableIds([id.restrictedCaseA])).toEqual([]);
    expect(Object.keys(tile.map)).not.toContain("Step 4");
    expect(tile.total).toBe(1);
  });

  it("returns no successful queue row the caller could not already SELECT", async () => {
    const allCases = [id.openCaseA, id.restrictedCaseA, id.openCaseB];
    const actors = [
      [id.orgCoordinator, id.orgCoordinatorSession, true],
      [id.chapterCoordinator, id.chapterCoordinatorSession, true],
      [id.ownerA, id.ownerASession, false],
    ];
    for (const [actor, session, isCoordinator] of actors) {
      await act(actor, session);
      if (!isCoordinator) {
        const refused = await attempt("select id from public.list_coordinator_cases('all', null, null, 200)");
        expect(refused, actor).toMatchObject({ ok: false, code: "42501" });
        continue;
      }
      const rows = await queue("all");
      const visible = await readableIds(allCases);
      for (const row of rows) {
        expect(visible, `${actor} returned unread case ${row.reference}`).toContain(row.id);
        expect(row.status).toBe("active");
      }
      expect(rows.map((row) => row.id)).not.toContain(id.restrictedCaseA);
    }
  });
});
