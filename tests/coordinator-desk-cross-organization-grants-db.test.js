// @vitest-environment node
//
// BUG-UG-COORDINATOR-DESK-OMITS-CROSS-ORGANIZATION-CASE-GRANTS-20261021
//
// casework_grant_access (20261021034151) saves a grant to a coordinator who is
// active in the organization of the member's profile chapter while the case
// belongs to another organization, and that grantee can then read the case.
// The coordinator desk hid it: the pager, the KPIs and the dashboard tiles all
// bounded their set to the caller's current organization AND chapter.
//
// The offline half pins the migration: later KPI privacy guards preserve its scope, it guards the installed
// bodies, adds one identical grant branch to all three readers and keeps their
// tenant bound, and the database contract follows. The live half proves the
// granted coordinator sees the case in the queue, the KPI badge and the tile;
// an equally placed coordinator without a grant sees it in none of them; and a
// same-organization coordinator's desk is unchanged.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, latestFnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const SLUG = "coordinator_desk_cross_organization_grants";
const sql = stripComments(loadMigrationSql(SLUG));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const READERS = {
  "public.list_coordinator_cases": "public.list_coordinator_cases(p_focus text, p_after_deadline date, p_after_id uuid, p_limit integer)",
  "public.get_coordinator_kpis": "public.get_coordinator_kpis()",
  "private.casework_dashboard_open_cases": "private.casework_dashboard_open_cases()",
};
const TENANT = "(c.organization_id = (select private.current_member_organization()) and c.chapter_id = (select private.current_member_chapter()))";
const GRANT_BRANCH = "or ( c.id in ( select g.case_id from public.casework_access_grants g where g.grantee_user_id = (select auth.uid()) and g.revoked_at is null ) and public.staff_can_see_user(c.user_id, 'coordinator') and private.casework_staff_can_access(c.id) )";

describe("coordinator desk cross-organization grant migration", () => {
  // A later, unrelated migration must not fail this test: "newest on Main" held
  // only until the next migration merged (#5732's merge group, run 39775212921).
  // What must hold is that this migration's bodies are the live ones: it runs
  // after the grantee-reach repair and no later migration replaces a function it
  // replaces.
  it("runs after the grantee-reach repair, later KPI privacy guards preserve its scope, inside one bounded transaction", () => {
    const name = findMigrationName(SLUG);
    expect(name > "20261021034151_casework_grant_access_grantee_reach.sql").toBe(true);
    const directory = new URL("../supabase/migrations/", import.meta.url);
    const migrations = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();
    expect(migrations).toContain(name);
    const replaced = [...new Set([...sql.matchAll(/create or replace function ([a-z_]+\.[a-z_]+)\(/giu)].map((match) => match[1].toLowerCase()))];
    expect(replaced.length).toBeGreaterThanOrEqual(3);
    // latestFnBody re-reads every migration, so calling it once per later
    // migration grew with the square of the history and passed the 90 s
    // budget on the instrumented GitHub runner (merge-group run 41291229032,
    // 103 s). The latest body does not depend on the loop; read it once.
    const latestBodies = new Map();
    const latest = (fn) => {
      if (!latestBodies.has(fn)) latestBodies.set(fn, squash(latestFnBody(fn)));
      return latestBodies.get(fn);
    };
    for (const later of migrations.filter((file) => file > name)) {
      const text = stripComments(readFileSync(new URL(later, directory), "utf8")).toLowerCase();
      for (const fn of replaced) {
        if (fn === "public.get_coordinator_kpis") {
          expect(latest(fn)).toContain(TENANT);
          // #7593 absorbs the grant branch's duplicate read check into the
          // final composed read rule, and resolves the identical coordinator
          // visible-member set once. The live proof retains both grant controls.
          expect(latest(fn)).toContain("active_grants as materialized ( select g.case_id from public.casework_access_grants g where g.grantee_user_id = (select auth.uid()) and g.revoked_at is null )");
          expect(latest(fn)).toContain("or (c.id in (select case_id from active_grants) and c.user_id in (select id from coordinator_members))");
          expect(latest(fn)).toContain("select private.staff_visible_member_ids('coordinator') as id");
          expect(latest(fn)).toContain("private.case_scope_and_identity_allowed(t.case_row)");
        } else if (fn === "private.casework_dashboard_open_cases" &&
          (later.endsWith("_platform_organization_boundary.sql") || later.endsWith("_unit_committee_scoped_access.sql"))) {
          // Platform and scoped access retain the explicit grant bound and
          // apply the shared read oracle, including scope/privacy restrictions.
          expect(latest(fn)).toContain(`and ( ${TENANT} ${GRANT_BRANCH.replaceAll("casework_staff_can_access", "casework_staff_can_read")} ) and private.casework_staff_can_read(c.id) and not private.organization_is_platform(c.organization_id);`);
        } else if (fn === "public.list_coordinator_cases" &&
          (later.endsWith("_deadlines_and_desks_eastern_day.sql") || later.endsWith("_case_deadline_time_zones.sql"))) {
          // #8568 part B moves only the pager's due window to the Eastern day,
          // and #9446 part 4a moves it to the case's own zone; the tenant bound
          // and the grant branch stay as they are.
          expect(latest(fn)).toContain(`( ${TENANT} ${GRANT_BRANCH} )`);
        } else expect(text.includes(`function ${fn}(`), `${later} replaces ${fn}`).toBe(false);
      }
    }
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("set local lock_timeout = '5s';");
  });

  it("refuses to replace bodies other than the three reviewed predecessors", () => {
    expect(sql).toContain("if installed is distinct from '{71867b0b3713fa376b6618c807ced0b7,bcf7d38d86877895e3aa0f80ab3ca404,878be72b0a4230a598e703056dce3ef1}' then");
    expect(sql).toContain("using errcode = '55000'");
  });

  it("adds the same grant branch to all three readers and keeps each tenant bound", () => {
    for (const reader of Object.keys(READERS)) {
      const body = squash(fnBody(sql, reader));
      expect(body, reader).toContain("c.organization_id is not null and c.chapter_id is not null");
      expect(body, reader).toContain(`and ( ${TENANT} ${GRANT_BRANCH} )`);
    }
    // KPIs and tiles still filter every row through the per-case helper; the
    // pager stays invoker so RLS still decides what it may return, and calls
    // the helper only inside the grant branch.
    expect(squash(fnBody(sql, "public.get_coordinator_kpis"))).toContain("where private.casework_staff_can_access(t.id)");
    expect(squash(fnBody(sql, "private.casework_dashboard_open_cases"))).toContain("and private.casework_staff_can_access(c.id);");
    expect(squash(fnBody(sql, "public.list_coordinator_cases"))).toContain("security invoker");
  });

  it("updates the database contract needles for the grant branch", () => {
    const functions = contract.functions ?? contract;
    const entries = (Array.isArray(functions) ? functions : Object.values(functions)).flat();
    for (const sig of Object.values(READERS)) {
      const entry = entries.find((candidate) => candidate?.sig === sig);
      expect(entry, sig).toBeTruthy();
      expect(entry.bodyContains, sig).toContain("g.grantee_user_id = (select auth.uid())");
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("the coordinator desk shows a cross-organization case only to its grantee", () => {
  let client;
  const id = Object.fromEntries([
    "member", "memberSession", "caseCoordinator", "caseCoordinatorSession",
    "grantee", "granteeSession", "ungranted", "ungrantedSession",
    "caseOrg", "otherOrg", "restrictedCase", "openCase",
  ].map((key) => [key, randomUUID()]));
  const caseChapter = `xorg-case-${id.caseOrg}`;
  const otherChapter = `xorg-moved-${id.otherOrg}`;

  const act = async (actor, session) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
  };
  const asOwner = async (text, params = []) => {
    await client.query("reset role");
    return (await client.query(text, params)).rows;
  };
  const desk = async (actor, session) => {
    await act(actor, session);
    const queue = (await client.query("select id from public.list_coordinator_cases('all', null, null, 200)")).rows.map((row) => row.id);
    const kpis = (await client.query("select public.get_coordinator_kpis() as k")).rows[0].k;
    const tiles = (await client.query("select step, case_count from public.casework_dashboard_open_cases_by_step()")).rows;
    const tileTotal = tiles.reduce((sum, row) => sum + Number(row.case_count), 0);
    const readable = (await client.query("select id from public.member_cases where id = any($1::uuid[])", [[id.restrictedCase, id.openCase]])).rows.map((row) => row.id);
    return { queue, kpis, tiles, tileTotal, readable };
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "coordinator-desk-cross-organization-grants-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    const people = [
      [id.member, id.memberSession], [id.caseCoordinator, id.caseCoordinatorSession],
      [id.grantee, id.granteeSession], [id.ungranted, id.ungrantedSession],
    ];
    for (const [user, session] of people) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic desk factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    for (const [org, chapter, order] of [[id.caseOrg, caseChapter, 9921], [id.otherOrg, otherChapter, 9922]]) {
      await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [org, `xorg-${org}`, id.caseCoordinator]);
      await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,$3)", [chapter, org, order]);
      await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [org]);
    }
    // The case coordinator works in the case organization and chapter.
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.caseOrg, id.caseCoordinator]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id.caseCoordinator, caseChapter]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id.caseCoordinator, caseChapter]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)", [id.caseOrg, id.caseCoordinator]);
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'coordinator',$2) on conflict do nothing", [id.caseCoordinator, caseChapter]);
    // The member's cases belong to the case organization.
    for (const org of [id.caseOrg, id.otherOrg]) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, id.member]);
    }
    for (const chapter of [caseChapter, otherChapter]) {
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id.member, chapter]);
    }
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id.member, caseChapter]);
    // Two coordinators placed identically: staff on the case chapter,
    // coordinator of the member's new chapter, working in the new organization.
    for (const user of [id.grantee, id.ungranted]) {
      for (const org of [id.caseOrg, id.otherOrg]) {
        await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, user]);
      }
      for (const chapter of [caseChapter, otherChapter]) {
        await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
      }
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$3)", [id.caseOrg, user, id.caseCoordinator]);
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'steward',$2) on conflict do nothing", [user, caseChapter]);
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'coordinator',$2) on conflict do nothing", [user, otherChapter]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id,granted_by) values($1,'coordinator',$2,$3)", [user, otherChapter, id.caseCoordinator]);
      await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, otherChapter]);
    }
    for (const [caseId, reference, step, restricted] of [
      [id.restrictedCase, "CASE-XORG-RESTRICTED", "Step 3", true],
      [id.openCase, "CASE-XORG-OPEN", "Step 2", false],
    ]) {
      await client.query(
        `insert into public.member_cases(
           id,user_id,reference,title,case_type,organization_id,chapter_id,coordinator_user_id,
           step,articles,status,deadline,is_restricted,restriction_reason,restricted_at,restricted_by)
         values($1,$2,$3,$3,'other',$4,$5,$6,$7,'Article 7','active',current_date + 2,$8,$9,$10,$11)`,
        [caseId, id.member, reference, id.caseOrg, caseChapter, id.caseCoordinator, step, restricted,
          restricted ? "sensitive witness statements" : null, restricted ? new Date() : null, restricted ? id.caseCoordinator : null],
      );
    }
    // The cases were opened in the case chapter; the member's profile chapter
    // then moved to the other organization.
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id.member, otherChapter]);
    await act(id.caseCoordinator, id.caseCoordinatorSession);
    const granted = await client.query("select (g).grantee_user_id from public.casework_grant_access($1, $2, $3) g",
      [id.restrictedCase, id.grantee, "Covering the member after the chapter move"]);
    expect(granted.rows).toHaveLength(1);
    await client.query("reset role");

    // #8589 re-final: committed data gives every steward grant its migration

    // assignments; an organization grant reaches only chapters it has one in.

    await migrateLegacyStewardFixtures(client);
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("works in the member's new organization, not the case's, for both coordinators", async () => {
    for (const user of [id.grantee, id.ungranted]) {
      expect(await asOwner("select private.member_organization_for($1) = $2 as there", [user, id.otherOrg])).toEqual([{ there: true }]);
    }
  });

  it("shows the granted restricted case in the grantee's queue, KPI badge and dashboard tile", async () => {
    const view = await desk(id.grantee, id.granteeSession);
    expect(view.readable).toContain(id.restrictedCase);
    expect(view.queue).toEqual([id.restrictedCase]);
    expect(view.kpis.openCases).toBe(1);
    expect(view.kpis.dueThisWeek).toBe(1);
    expect(view.kpis.byStep).toEqual([{ step: "Step 3", count: 1 }]);
    expect(view.tiles.map((row) => [row.step, Number(row.case_count)])).toEqual([["Step 3", 1]]);
    expect(view.queue).toHaveLength(view.tileTotal);
  });

  it("keeps an unrestricted case of the same member off the grantee's desk: only the grant widens it", async () => {
    const view = await desk(id.grantee, id.granteeSession);
    expect(view.readable).toContain(id.openCase);
    expect(view.queue).not.toContain(id.openCase);
  });

  it("shows no cross-organization case to an identically placed coordinator without a grant", async () => {
    const view = await desk(id.ungranted, id.ungrantedSession);
    expect(view.readable).not.toContain(id.restrictedCase);
    expect(view.queue).toEqual([]);
    expect(view.kpis.openCases).toBe(0);
    expect(view.kpis.byStep).toEqual([]);
    expect(view.tileTotal).toBe(0);
  });

  //  on #5728: the grant is checked once, when it is saved. A grantee
  // who later loses staff standing on the case chapter still reaches the
  // member and the unrevoked grant (so RLS still shows the case), but leaves
  // the queue, the badge and the tiles together.
  it("drops the case from the whole desk when the grantee loses staff standing on the case chapter", async () => {
    await client.query("savepoint drop_staff");
    try {
      await asOwner("delete from public.member_roles where user_id = $1 and chapter_id = $2", [id.grantee, caseChapter]);
      await asOwner("delete from public.organization_role_grants where user_id = $1 and organization_id = $2", [id.grantee, id.caseOrg]);
      const view = await desk(id.grantee, id.granteeSession);
      expect(view.readable).toContain(id.restrictedCase);
      expect(view.queue).toEqual([]);
      expect(view.kpis.openCases).toBe(0);
      expect(view.tileTotal).toBe(0);
    } finally {
      await client.query("rollback to savepoint drop_staff");
    }
  });

  it("drops the case from the grantee's desk once the grant is revoked", async () => {
    await client.query("savepoint revoke_grant");
    try {
      await asOwner("update public.casework_access_grants set revoked_at = now(), revoked_by = $2 where case_id = $1 and grantee_user_id = $3 and revoked_at is null",
        [id.restrictedCase, id.caseCoordinator, id.grantee]);
      const view = await desk(id.grantee, id.granteeSession);
      expect(view.queue).toEqual([]);
      expect(view.kpis.openCases).toBe(0);
      expect(view.tileTotal).toBe(0);
    } finally {
      await client.query("rollback to savepoint revoke_grant");
    }
  });

  it("leaves a coordinator without grants on exactly the old tenant-bounded desk", async () => {
    const localMember = randomUUID();
    const localCase = randomUUID();
    await asOwner("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [localMember, `${localMember}@example.invalid`]);
    await asOwner("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.caseOrg, localMember]);
    await asOwner("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [localMember, caseChapter]);
    await asOwner("update public.member_profiles set chapter_id=$2 where id=$1", [localMember, caseChapter]);
    await asOwner(
      `insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,step,articles,status)
       values($1,$2,'CASE-XORG-LOCAL','CASE-XORG-LOCAL','other',$3,$4,'Step 1','Article 2','active')`,
      [localCase, localMember, id.caseOrg, caseChapter]);
    const view = await desk(id.caseCoordinator, id.caseCoordinatorSession);
    // The pre-repair bound: the caller's own organization and chapter, then RLS.
    const old = (await client.query(
      `select c.id from public.member_cases c
        where c.status = 'active' and c.organization_id = (select private.current_member_organization())
          and c.chapter_id = (select private.current_member_chapter())`)).rows.map((row) => row.id);
    expect(old).toContain(localCase);
    expect(view.queue.sort()).toEqual(old.sort());
    // KPIs and tiles are definer: the same old bound without RLS, then the
    // per-case helper, still under the caller's claims.
    const oldCounted = (await asOwner(
      `select count(*)::int as n from public.member_cases c
        where c.status = 'active' and c.organization_id = (select private.current_member_organization())
          and c.chapter_id = (select private.current_member_chapter())
          and private.casework_staff_can_access(c.id)`))[0].n;
    expect(view.tileTotal).toBe(oldCounted);
    expect(view.kpis.openCases).toBe(oldCounted);
  });
});
