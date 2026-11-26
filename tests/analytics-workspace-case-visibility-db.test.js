// @vitest-environment node
//
// SEC-UG-ANALYTICS-WORKSPACE-MEMBER-CASE-COUNTS-UNGATED-20260920
//
// public.get_organization_analytics_workspace is SECURITY DEFINER; its
// public.member_cases lateral produced each named member row's activeCases,
// overdueCases and the derived 'urgent' attention flag behind only a coarse
// organization staff-role test, so is_restricted cases and cases outside the
// caller's casework authority were counted. 20260923231000 counts a case only
// when private.casework_staff_can_access admits it, keeping the case-graph
// lock preamble first.
//
// The offline half pins the migration text and the db-contract needles. The
// live half proves, per staff hat, that the counters equal exactly what the
// shared predicate admits, that issuing and revoking a casework access grant
// moves them in step, and that the roster, the chapter-health floor and the
// analytics_snapshot_read audit row are unchanged.
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseFunctions, readMigrationFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { runnerTimeoutMultiplier } from "../scripts/lib/runner-timeout.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

// Statement budgets fit the runner like every test budget: three times on
// GitHub's standard 2-vCPU runner, as written elsewhere. On run 43131067684
// (pull request #84) the 3,000-member fixture below hit its 120 s
// statement_timeout there (scripts/lib/runner-timeout.mjs).
const statementTimeout = (seconds) => `${seconds * runnerTimeoutMultiplier()}s`;

const name = findMigrationName("analytics_workspace_case_visibility");
const raw = loadMigrationSql("analytics_workspace_case_visibility");
const sql = stripComments(raw);
const squash = (text) => text.replace(/\s+/g, " ").trim();
const body = squash(stripComments(fnBody(sql, "public.get_organization_analytics_workspace")));
const currentBody = squash(stripComments(readMigrationFunctions("supabase/migrations")
  .find((entry) => entry.name === "public.get_organization_analytics_workspace").source));
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("analytics workspace case-visibility migration", () => {
  it("is one bounded transaction in the assigned stamp range with no ACL, policy or table statement", () => {
    expect(name).toBe("20260923231000_analytics_workspace_case_visibility.sql");
    const statements = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    expect(statements.trimStart().startsWith("begin;")).toBe(true);
    expect(statements.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("set local lock_timeout = '5s';");
    expect(squash(sql)).not.toMatch(/\b(grant|revoke|create policy|alter table|create index)\b/);
  });

  it("re-emits the case-graph lock wrapper as the first statement", () => {
    const fn = parseFunctions(raw, name).find((entry) => entry.name === "public.get_organization_analytics_workspace");
    expect(fn.source).toMatch(
      /^\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n\ndeclare\n/,
    );
  });

  it("gates the per-member case lateral through the shared per-case predicate and keeps the rest", () => {
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).toMatch(
      /from public\.member_cases cs where cs\.organization_id = org and cs\.chapter_id = c\.id and cs\.user_id = m\.user_id and cs\.status = 'active' and private\.casework_staff_can_access\(cs\.id\) \) cases/,
    );
    expect(body.match(/private\.casework_staff_can_access/g)).toHaveLength(1);
    expect(body).not.toContain("is_restricted");
    expect(body).not.toContain("casework_access_grants");
    for (const kept of [
      "private.mi1_require_selected_organization()",
      "private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])",
      "privacy_threshold integer := 25",
      "'analytics_snapshot_read'",
      "when cases.overdue_cases > 0 then 'urgent'",
    ]) expect(body).toContain(kept);
  });

  it("pins the gated definition in the database contract", () => {
    const entry = contract.functions.find((row) => row.sig === "public.get_organization_analytics_workspace()");
    expect(entry).toMatchObject({ secdef: true, exec: "authenticated" });
    expect(entry.bodyContains).toEqual(expect.arrayContaining([
      "private.lock_case_graph_read()",
      "private.casework_staff_can_read(cs.id)",
      // 20261030210000's organization-reader shortcut, kept for unscoped
      // actors on cases with no identity privacy.
      "when org_case_reader and not scoped_actor",
    ]));
    for (const needle of entry.bodyContains) expect(currentBody).toContain(squash(needle));
  });
});

describe("analytics workspace candidate prefilter", () => {
  it("adds only a necessary candidate condition to the original authorization-gated body", () => {
    const candidate = squash(stripComments(fnBody(
      loadMigrationSql("analytics_workspace_candidate_prefilter"),
      "public.get_organization_analytics_workspace",
    )));
    const declaration = "actor uuid := (select auth.uid()); may_read_unassigned boolean;";
    const selection = "and (may_read_unassigned or cs.steward_user_id = actor or cs.coordinator_user_id = actor)";
    expect(candidate).toContain(declaration);
    expect(candidate).toContain(selection);
    for (const source of ["organization_role_grants", "member_role_chapters", "member_roles"]) {
      expect(candidate).toContain(`from public.${source} g where g.user_id = actor and g.role = any(array['coordinator','advisor','admin','vp'])`);
    }
    expect(squash(candidate
      .replace(declaration, "")
      .replace(/may_read_unassigned := exists \(.*?; perform private\.mi1_write_tenant_audit/, "perform private.mi1_write_tenant_audit")
      .replace(selection, ""))).toBe(body);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("analytics workspace case counters follow private.casework_staff_can_access", () => {
  let client;
  const id = Object.fromEntries([
    "org", "steward", "stewardSession", "coordinator", "coordinatorSession", "admin", "adminSession", "memberM", "memberMSession",
    "memberN", "memberNSession", "assignedCase", "restrictedCaseM", "restrictedCaseN", "siblingCase",
  ].map((key) => [key, randomUUID()]));
  const tag = id.org.slice(0, 8);
  const chapterA = `awscope-a-${tag}`;
  const chapterB = `awscope-b-${tag}`;

  const act = async (actor, session) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
  };

  const workspace = async () => (await client.query(
    "select public.get_organization_analytics_workspace() as value",
  )).rows[0].value;

  const row = (result, user, chapter) => result.members.find((entry) => entry.id === `${user}:${chapter}`);

  // What the shared predicate admits for the current caller, per member. The
  // predicate reads auth.uid() from the request claims, which survive the role
  // reset; the table read itself must not be narrowed by the caller's RLS.
  const admitted = async (user, chapter) => {
    await client.query("reset role");
    const counts = (await client.query(
    `select
       count(*) filter (where c.status = 'active')::integer as active,
       count(*) filter (where c.status = 'active' and c.deadline < private.local_day(c.time_zone, pg_catalog.now()))::integer as overdue
     from public.member_cases c
     where c.user_id = $1 and c.chapter_id = $2 and c.organization_id = $3
       and private.casework_staff_can_access(c.id)`,
    [user, chapter, id.org],
    )).rows[0];
    await client.query("set local role authenticated");
    return counts;
  };

  const expectAgreement = async (result) => {
    for (const [user, chapter] of [[id.memberM, chapterA], [id.memberN, chapterA], [id.memberM, chapterB]]) {
      const entry = row(result, user, chapter);
      if (!entry) continue;
      const want = await admitted(user, chapter);
      expect(entry.activeCases, `${user}:${chapter} active`).toBe(want.active);
      expect(entry.overdueCases, `${user}:${chapter} overdue`).toBe(want.overdue);
      if (want.overdue > 0) expect(entry.attention).toBe("urgent");
      else expect(entry.attention).not.toBe("urgent");
    }
  };

  const auditCount = async () => {
    await client.query("reset role");
    return (await client.query(
      "select count(*)::integer as n from public.organization_audit_events where organization_id = $1 and event_type = 'analytics_snapshot_read'",
      [id.org],
    )).rows[0].n;
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "analytics-workspace-case-visibility-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query(`set local statement_timeout = '${statementTimeout(60)}'`);
    await client.query("set local lock_timeout = '15s'");

    const people = [
      [id.steward, id.stewardSession, chapterA, "Steward AWScope"],
      [id.coordinator, id.coordinatorSession, chapterA, "Coordinator AWScope"],
      [id.admin, id.adminSession, chapterA, "Admin AWScope"],
      [id.memberM, id.memberMSession, chapterA, "Member M AWScope"],
      [id.memberN, id.memberNSession, chapterA, "Member N AWScope"],
    ];
    for (const [user, session] of people) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic analytics-scope factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [id.org, `awscope-${id.org}`, id.admin]);
    for (const [chapter, order] of [[chapterA, 9941], [chapterB, 9942]]) {
      await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,$3)", [chapter, id.org, order]);
    }
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [id.org]);
    for (const [user, , chapter, fullName] of people) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, user]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
      await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user, chapter, fullName]);
    }
    // Member M also belongs to chapter B, so the multi-chapter roster has a
    // second M row whose case lives in the sibling chapter.
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id.memberM, chapterB]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$3)", [id.org, id.steward, id.admin]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$3)", [id.org, id.coordinator, id.admin]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)", [id.org, id.admin]);
    // #8589 round 1: committed data gives every steward grant its migration carry-over; the analytics roster follows it.
    await migrateLegacyStewardFixtures(client);

    for (const [caseId, owner, chapter, reference, steward, restricted] of [
      [id.assignedCase, id.memberM, chapterA, "CASE-AWSCOPE-ASSIGNED", id.steward, false],
      [id.restrictedCaseM, id.memberM, chapterA, "CASE-AWSCOPE-RESTRICTED-M", null, true],
      [id.restrictedCaseN, id.memberN, chapterA, "CASE-AWSCOPE-RESTRICTED-N", null, true],
      [id.siblingCase, id.memberM, chapterB, "CASE-AWSCOPE-SIBLING", null, true],
    ]) {
      // The case chapter is derived from the owner's profile chapter at
      // insert, so point M's profile at the sibling chapter for that case.
      await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [owner, chapter]);
      await client.query(
        `insert into public.member_cases(
           id,user_id,reference,title,case_type,organization_id,chapter_id,step,articles,status,deadline,
           steward_user_id,is_restricted,restriction_reason,restricted_at,restricted_by)
         values($1,$2,$3,$3,'other',$4,$5,'Step 2','Article 5','active',current_date - 3,$6,$7,$8,$9,$10)`,
        [caseId, owner, reference, id.org, chapter, steward, restricted,
          restricted ? "sensitive investigation" : null, restricted ? new Date() : null, restricted ? id.admin : null],
      );
    }
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id.memberM, chapterA]);
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("counts for every admitted staff hat exactly what the shared predicate admits", async () => {
    await act(id.steward, id.stewardSession);
    const stewardView = await workspace();
    await expectAgreement(stewardView);
    // The steward is not granted the restricted cases: M carries only the
    // assigned case, N carries nothing and is not flagged urgent.
    expect(row(stewardView, id.memberM, chapterA)).toMatchObject({ activeCases: 1, overdueCases: 1, attention: "urgent" });
    expect(row(stewardView, id.memberN, chapterA)).toMatchObject({ activeCases: 0, overdueCases: 0 });
    expect(row(stewardView, id.memberN, chapterA).attention).not.toBe("urgent");
    expect(row(stewardView, id.memberM, chapterB)).toMatchObject({ activeCases: 0, overdueCases: 0 });

    // An organization coordinator reaches every member's unrestricted cases
    // but no restricted case without a grant.
    await act(id.coordinator, id.coordinatorSession);
    const coordinatorView = await workspace();
    await expectAgreement(coordinatorView);
    expect(row(coordinatorView, id.memberM, chapterA)).toMatchObject({ activeCases: 1, overdueCases: 1 });
    expect(row(coordinatorView, id.memberN, chapterA)).toMatchObject({ activeCases: 0, overdueCases: 0 });

    await act(id.admin, id.adminSession);
    const adminView = await workspace();
    await expectAgreement(adminView);
    expect(row(adminView, id.memberM, chapterA)).toMatchObject({ activeCases: 2, overdueCases: 2, attention: "urgent" });
    expect(row(adminView, id.memberN, chapterA)).toMatchObject({ activeCases: 1, overdueCases: 1, attention: "urgent" });
    expect(row(adminView, id.memberM, chapterB)).toMatchObject({ activeCases: 1, overdueCases: 1 });
  });

  it("moves the counters in step with issuing and revoking a casework access grant", async () => {
    await act(id.coordinator, id.coordinatorSession);
    expect(row(await workspace(), id.memberN, chapterA)).toMatchObject({ activeCases: 0, overdueCases: 0 });
    await client.query("reset role");
    const grantId = randomUUID();
    await client.query(
      `insert into public.casework_access_grants(id,case_id,organization_id,chapter_id,grantee_user_id,granted_by,reason)
       values($1,$2,$3,$4,$5,$6,'analytics proof escalation cover')`,
      [grantId, id.restrictedCaseN, id.org, chapterA, id.coordinator, id.admin],
    );
    await act(id.coordinator, id.coordinatorSession);
    const granted = await workspace();
    await expectAgreement(granted);
    expect(row(granted, id.memberN, chapterA)).toMatchObject({ activeCases: 1, overdueCases: 1, attention: "urgent" });

    await client.query("reset role");
    await client.query("update public.casework_access_grants set revoked_at = now(), revoked_by = $2 where id = $1", [grantId, id.admin]);
    await act(id.coordinator, id.coordinatorSession);
    const revoked = await workspace();
    await expectAgreement(revoked);
    expect(row(revoked, id.memberN, chapterA)).toMatchObject({ activeCases: 0, overdueCases: 0 });
  });

  it("leaves the roster, the chapter-health floor and the audit row unchanged when counters narrow", async () => {
    const before = await auditCount();
    await act(id.steward, id.stewardSession);
    const stewardView = await workspace();
    await act(id.admin, id.adminSession);
    const adminView = await workspace();
    expect(await auditCount()).toBe(before + 2);

    const roster = (view) => view.members.map((entry) => [entry.id, entry.name, entry.chapterId]);
    expect(roster(stewardView)).toEqual(roster(adminView));
    expect(roster(stewardView)).toEqual(expect.arrayContaining([
      [`${id.memberM}:${chapterA}`, "Member M AWScope", chapterA],
      [`${id.memberN}:${chapterA}`, "Member N AWScope", chapterA],
      [`${id.memberM}:${chapterB}`, "Member M AWScope", chapterB],
    ]));
    expect(stewardView.chapterHealth).toEqual(adminView.chapterHealth);
    for (const chapter of stewardView.chapterHealth) {
      expect(chapter.protected).toBe(true);
      expect(chapter.score).toBeNull();
    }
    expect(stewardView.privacyThreshold).toBe(25);
  });
  it("keeps chapter coordinator access and rejects a role in an unrelated chapter", async () => {
    await client.query("reset role");
    await client.query("savepoint candidate_role_paths");
    try {
      // Exercise assignment-only visibility explicitly. October 31 makes
      // ordinary chapter grievances visible to stewards by default.
      await client.query("insert into private.chapter_access_policies(chapter_id,steward_grievances) values($1,false)", [chapterA]);
      await client.query("update public.member_cases set steward_user_id=null where id=$1", [id.assignedCase]);
      await act(id.steward, id.stewardSession);
      expect(row(await workspace(), id.memberM, chapterA).activeCases).toBe(0);
      await client.query("reset role");
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id.steward, chapterB]);
      await client.query("insert into public.member_roles(user_id,role,chapter_id,granted_by) values($1,'coordinator',$2,$3)", [id.steward, chapterB, id.admin]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id,granted_by) values($1,'coordinator',$2,$3)", [id.steward, chapterB, id.admin]);
      await act(id.steward, id.stewardSession);
      // A broad candidate match must never itself authorize a case.
      const unscoped = await workspace();
      await expectAgreement(unscoped);
      expect(row(unscoped, id.memberM, chapterA).activeCases).toBe(0);
      await client.query("reset role");
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id,granted_by) values($1,'coordinator',$2,$3)", [id.steward, chapterA, id.admin]);
      await act(id.steward, id.stewardSession);
      const chapterCoordinator = await workspace();
      await expectAgreement(chapterCoordinator);
      expect(row(chapterCoordinator, id.memberM, chapterA).activeCases).toBe(1);
      expect(row(chapterCoordinator, id.memberN, chapterA).activeCases).toBe(0);
    } finally {
      await client.query("rollback to savepoint candidate_role_paths");
      await client.query("reset role");
    }
  });

  it("loads a large roster with unassigned cases within the existing UI deadline", async () => {
    await client.query("reset role");
    await client.query("savepoint candidate_performance");
    try {
      await client.query(`set local statement_timeout='${statementTimeout(120)}'`);
      await client.query("create temporary table analytics_perf_people as select gen_random_uuid() as id from generate_series(1,3000)");
      // Each new account's member_profiles row runs the focus-timezone check,
      // which reads pg_timezone_names from disk (about 19 ms a row, 56 s for
      // this roster). Every synthetic profile takes the column default, so the
      // check is skipped for this insert only; the savepoint restores it.
      // Preserve the legacy analytics control.
      await migrateLegacyStewardFixtures(client);
      await client.query("set constraints all immediate");
      await client.query("alter table public.member_profiles disable trigger member_profiles_validate_focus_timezone");
      await client.query("insert into auth.users(id,email,raw_user_meta_data) select id,id::text || '@example.invalid','{}'::jsonb from analytics_perf_people");
      await client.query("alter table public.member_profiles enable trigger member_profiles_validate_focus_timezone");
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) select $1,id,'active' from analytics_perf_people", [id.org]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) select id,$1,'active' from analytics_perf_people", [chapterA]);
      await client.query("update public.member_profiles p set chapter_id=$1,full_name='Synthetic performance member' from analytics_perf_people x where p.id=x.id", [chapterA]);
      await client.query("insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,step,articles,status,deadline) select gen_random_uuid(),p.id,'PERF-' || row_number() over (), 'Synthetic case','other',$1,$2,'Step 2','Article 5','active',current_date-3 from analytics_perf_people p", [id.org, chapterA]);
      await client.query("analyze public.member_cases; analyze public.member_chapter_memberships; analyze public.organization_memberships");
      await client.query("set local jit=off; set local random_page_cost=1.1; set local work_mem='12MB'");
      const ownFixtures = new Set((await client.query("select id::text from analytics_perf_people")).rows.map((entry) => entry.id));
      await act(id.steward, id.stewardSession);
      const started = performance.now();
      const result = await workspace();
      const elapsed = performance.now() - started;
      expect(result.members).toHaveLength(3006);
      // Default-on stewardship now admits ordinary unassigned grievances.
      // Exercise its result and cost, then the leadership-selected narrow mode.
      const defaultCounts=result.members.filter((entry) => ownFixtures.has(entry.id.split(':')[0]));
      await client.query("reset role");
      await client.query("insert into private.chapter_access_policies(chapter_id,steward_grievances) values($1,false) on conflict(chapter_id) do update set steward_grievances=false",[chapterA]);
      await act(id.steward,id.stewardSession);
      const narrowStarted=performance.now();
      const narrow=await workspace();
      const narrowElapsed=performance.now()-narrowStarted;
      console.info("Analytics 3,006-row deadline proof:",JSON.stringify({defaultReadAllMs:elapsed,assignmentOnlyMs:narrowElapsed}));
      expect(defaultCounts.every((entry) => entry.activeCases === 1 && entry.overdueCases === 1)).toBe(true);
      expect(narrow.members.filter((entry) => ownFixtures.has(entry.id.split(':')[0])).every((entry) => entry.activeCases === 0 && entry.overdueCases === 0)).toBe(true);
      // The product's own 10 s deadline (src/lib/loadDeadline.js) is not a
      // runner budget and is never scaled.
      expect(elapsed).toBeLessThan(10000);
      expect(narrowElapsed).toBeLessThan(10000);
    } finally {
      await client.query("rollback to savepoint candidate_performance");
      await client.query("reset role");
    }
    // On the standard runner each fixture statement may take up to 360 s, so
    // the test gets 15 minutes there; 180 s everywhere else (gate round 1 on
    // #5857, Grok).
  }, runnerTimeoutMultiplier() === 1 ? 180000 : 900000);
});
