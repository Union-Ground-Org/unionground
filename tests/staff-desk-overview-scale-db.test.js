// @vitest-environment node
//
// BUG-UG-VP-AND-ADVISOR-DESK-OVERVIEW-TIMEOUT-AT-SCALE-20261106
// 20261106221000 (A) swaps the generated member_profiles access predicate in
// five staff readers for 's set-wise form and (B) runs the same single
// query of eleven caller/visibility helpers from PL/pgSQL so PostgreSQL 17
// caches their plans instead of re-planning every nested per-row call.
//
// 1. The predecessors are rebuilt by reversing the migration text exactly
//    (part A bodies must hash to the migration's own preflight pins). On a
//    small mixed fixture every staff read and every converted helper answers
//    exactly as its predecessor, for every caller, refusals included. The
//    comparison runs before the scale fixture exists and allows each read
//    120 s, so the slower predecessors cannot time out on a loaded runner;
//    a statement timeout fails it by name instead of passing as a value.
// 2. At 1,000 accounts plus 200 in another organization and 600 cases, the
//    VP and advisor overviews and the other load-path readers answer in under
//    2 s (runner-scaled) and never call the per-profile predicate; the
//    predecessors take 10 to 27 s here.
// Everything runs in one transaction that is rolled back.
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";
import { loadScaledBudget, pairedFastest, reportPaired } from "./helpers/db-load-budget.mjs";
import { fnBody } from "./helpers/migration.js";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const MIGRATION = readFileSync(new URL("../supabase/migrations/20261106221000_staff_desk_overviews_setwise_access_and_cached_helper_plans.sql", import.meta.url), "utf8");
const SET_WISE = "where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))";
const PER_ROW = "where (private.chapter_member_readable(access_row.id))";
const CACHED = /AS \$function\$\nbegin\n {2}return \(\n([\s\S]*)\n {2}\);\nend;\n\$function\$$/;

// Every function the migration replaces, rebuilt as it was before it.
function predecessors() {
  const statements = MIGRATION.match(/^CREATE OR REPLACE FUNCTION [\s\S]*?\n\$function\$\n;/gm);
  const pins = new Map([...MIGRATION.matchAll(/pg_get_functiondef\('([^']+)'::regprocedure\)\) <> '([0-9a-f]{32})'/g)].map((m) => [m[1], m[2]]));
  return statements.map((statement) => {
    const definition = statement.slice(0, -2);
    const name = definition.match(/^CREATE OR REPLACE FUNCTION ([\w.]+)\(/)[1];
    if (definition.includes(SET_WISE)) {
      return { name, kind: "reader", sql: definition.split(SET_WISE).join(PER_ROW), pins };
    }
    const query = definition.match(CACHED)?.[1];
    if (!query) throw new Error(`unexpected definition for ${name}`);
    const head = definition.slice(0, definition.indexOf("AS $function$")).replace(" LANGUAGE plpgsql\n", " LANGUAGE sql\n");
    return { name, kind: "helper", sql: `${head}AS $function$\n${query}\n$function$` };
  });
}

const id = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const READS = [
  ["get_vp_overview", "select public.get_vp_overview() value"],
  ["list_vp_case_reviews", "select public.list_vp_case_reviews() value"],
  ["get_advisor_overview", "select public.get_advisor_overview() value"],
  ["get_case_queue_next_actions", "select public.get_case_queue_next_actions('coordinator', 25) value"],
  ["casework_dashboard_median_days_per_step", "select coalesce(pg_catalog.jsonb_agg(t), '[]'::jsonb) value from public.casework_dashboard_median_days_per_step() t"],
  ["list_intake_triage_owners", "select coalesce(pg_catalog.jsonb_agg(t), '[]'::jsonb) value from public.list_intake_triage_owners() t"],
  ["get_organization_analytics_snapshot", "select public.get_organization_analytics_snapshot() - 'snapshotId' value"],
];

live("staff desk overviews and caller helpers at organization scale (#7206)", () => {
  let db;
  let small;
  let scale;

  // The scale proof holds each read to the hosted authenticated role's 30 s
  // limit; the predecessor comparison only needs both answers, so it allows
  // the slower predecessors more on a loaded 2-vCPU runner.
  async function call(user, sql, args = [], timeout = "30s") {
    await db.query("savepoint call");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user.id, role: "authenticated", aal: "aal2", session_id: user.session })]);
      await db.query("set local role authenticated");
      await db.query(`set local statement_timeout = '${timeout}'`);
      const started = performance.now();
      const { rows } = await db.query(sql, args);
      return { ms: performance.now() - started, value: rows[0]?.value };
    } catch (error) {
      return { error: error.code, message: error.message };
    } finally {
      await db.query("rollback to savepoint call");
      await db.query("reset role");
    }
  }

  // As the caller, but as the function owner, for private helpers.
  async function helpers(user, sql, args = []) {
    await db.query("savepoint helpers");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user.id, role: "authenticated", aal: "aal2", session_id: user.session })]);
      return (await db.query(sql, args)).rows;
    } finally {
      await db.query("rollback to savepoint helpers");
    }
  }

  async function perProfileCalls(run) {
    const read = async () => Number((await db.query(
      "select coalesce(sum(calls),0) calls from pg_stat_xact_user_functions where schemaname='private' and funcname='chapter_member_readable'",
    )).rows[0].calls);
    const before = await read();
    const result = await run();
    return { result, calls: (await read()) - before };
  }

  // members in five chapters of one organization (chapter = n mod 5) and
  // `other` in a sixth chapter of a second organization; cases for members
  // from 11 on, each with its chapter's steward.
  async function seed(prefix, members, other, cases, staff) {
    const org = id(`${prefix.slice(0, 7)}a`, 1), otherOrg = id(`${prefix.slice(0, 7)}a`, 2);
    const user = (n) => `('${prefix}-0000-4000-8000-'||lpad((${n})::text,12,'0'))::uuid`;
    const chapter = `case when n > ${members} then 6 else ((n - 1) % 5) + 1 end`;
    await db.query("insert into public.organizations(id,slug,name,status) values ($1,$3,$3,'active'),($2,$4,$4,'active')", [org, otherOrg, `scale-${prefix}`, `scale-${prefix}-other`]);
    await db.query(`insert into public.chapters(id,name,region,is_default,order_index,organization_id,slug)
      select '${prefix}-ch-'||n,'Scale chapter '||n,'scale',false,9700+n,case when n<=5 then $1::uuid else $2::uuid end,'${prefix}-ch-'||n
      from generate_series(1,6) n`, [org, otherOrg]);
    await db.query(`insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
      select ${user("n")},'authenticated','authenticated','${prefix}-'||n||chr(64)||'example.invalid','{"provider":"email","providers":["email"]}','{}',now(),now(),false,false
      from generate_series(1,$1::integer) n`, [members + other]);
    await db.query(`insert into public.member_profiles(id,first_name,full_name,initials,chapter_id,role_line,member_since,language,
        notification_prefs,dnd_enabled,quiet_hours_timezone,urgent_notifications_enabled,shortcut_keys,work_widget_order,created_at,updated_at)
      select ${user("n")},'Scale','Scale member '||lpad(n::text,5,'0'),'SM','${prefix}-ch-'||(${chapter}),'Member',2020,'en','{}',false,'UTC',true,'{}','{}',now(),now()
      from generate_series(1,$1::integer) n`, [members + other]);
    await db.query(`insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,joined_at)
      select ${user("n")},'${prefix}-ch-'||(${chapter}),'active',true,now() from generate_series(1,$1::integer) n`, [members + other]);
    await db.query(`insert into public.organization_memberships(organization_id,user_id,status)
      select case when n > $3::integer then $2::uuid else $1::uuid end,${user("n")},'active' from generate_series(1,$4::integer) n`, [org, otherOrg, members, members + other]);
    // Stewards 1-5 (one per chapter); coordinators 6-10.
    for (const table of ["member_roles", "member_role_chapters"]) {
      await db.query(`insert into public.${table}(user_id,role,chapter_id,granted_by)
        select ${user("n")},case when n<=5 then 'steward' else 'coordinator' end,'${prefix}-ch-'||(((n-1)%5)+1),${user("n")} from generate_series(1,10) n`);
    }
    await db.query(`insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,step,articles,status,deadline,steward_user_id,is_restricted,restriction_reason,restricted_at,created_at,updated_at)
      select gen_random_uuid(),${user("10+n")},'${prefix}-'||n,'Scale case '||n,case when n%3=0 then 'grievance' else 'other' end,$1,'${prefix}-ch-'||(((9+n)%5)+1),
        case when n%4=0 then 'Step 1' else 'Step 2' end,'Article 5',case when n%5=0 then 'resolved' else 'active' end,current_date+(n%30),
        ${user("((9+n)%5)+1")},n%11=0,case when n%11=0 then 'Fixture restriction' end,case when n%11=0 then now() end,now()-(n||' days')::interval,now()-(n||' hours')::interval
      from generate_series(1,$2::integer) n`, [org, cases]);
    const callers = {};
    for (const entry of staff) {
      const userId = id(prefix, entry.n);
      if (entry.org) await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [org, userId, entry.org]);
      if (entry.chapter) {
        for (const table of ["member_roles", "member_role_chapters"]) {
          await db.query(`insert into public.${table}(user_id,role,chapter_id,granted_by) values ($1,$2,$3,$1) on conflict do nothing`, [userId, entry.chapter, `${prefix}-ch-${((entry.n - 1) % 5) + 1}`]);
        }
      }
      if (entry.caller) {
        callers[entry.caller] = { id: userId, session: id(`${prefix.slice(0, 7)}5`, entry.n) };
        await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,secret,created_at,updated_at) values (gen_random_uuid(),$1,'scale','totp','verified','scale',now(),now())", [userId]);
      }
    }
    return { org, otherOrg, callers };
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "staff-desk-overview-scale-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '120s'");
    await db.query("set local track_functions = 'all'");
    // Fixture rows only; triggers resume before sessions and every call.
    await db.query("set local session_replication_role = replica");
    small = await seed("b7206000", 40, 6, 24, [
      { n: 40, org: "admin", caller: "orgAdmin" },
      { n: 39, org: "vp", caller: "orgVp" },
      { n: 38, org: "advisor", caller: "orgAdvisor" },
      { n: 37, org: "steward", caller: "orgSteward" },
      { n: 36, chapter: "advisor", caller: "chapterAdvisor" },
      { n: 35, chapter: "vp", caller: "chapterVp" },
      { n: 6, caller: "chapterCoordinator" },
      { n: 2, caller: "chapterSteward" },
      { n: 20, caller: "member" },
    ]);
    // A member whose profile chapter sits in the other organization.
    await db.query("update public.member_profiles set chapter_id='b7206000-ch-6' where id=$1", [id("b7206000", 12)]);
    await db.query("set local session_replication_role = origin");
    await sessions(small.callers);

    // This broad-reader fixture is an
    // existing legacy grant; exercise its actual migration carry-over.
    await migrateLegacyStewardFixtures(db);
  }, runnerTimeout(60_000));

  async function sessions(callers) {
    for (const caller of Object.values(callers)) {
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),'aal2')", [caller.session, caller.id]);
    }
    await db.query(`analyze public.member_profiles, public.organization_memberships, public.member_chapter_memberships,
      public.member_roles, public.member_role_chapters, public.organization_role_grants, public.chapters, public.member_cases`);
  }

  afterAll(async () => {
    await db?.query("rollback").catch(() => {});
    await db?.end();
  });

  it("answers every staff read and helper exactly as the predecessors did", async () => {
    const someCase = (await db.query("select id from public.member_cases where reference='b7206000-1'")).rows[0].id;
    const reads = [...READS, ["list_member_case_assignment_candidates", "select public.list_member_case_assignment_candidates($1) value", [someCase]]];
    const profiles = (await db.query("select id from public.member_profiles where id::text like 'b7206000-%' order by id")).rows.map((row) => row.id);
    const chapters = ["b7206000-ch-1", "b7206000-ch-2", "b7206000-ch-6"];
    const helperSql = `select
      (select private.current_member_organization()) org, (select private.current_member_chapter()) chapter,
      (select private.current_mobile_staff_organization()) mobile_org, (select private.mfa_satisfied()) mfa,
      (select private.has_second_factor((select auth.uid()))) second_factor,
      (select private.staff_mfa_required(${"$1"}::uuid)) mfa_required,
      (select pg_catalog.jsonb_agg(private.has_organization_role(o, array[r]) order by o, r) from unnest(array[${"$1"}::uuid, ${"$2"}::uuid]) o, unnest(array['steward','coordinator','advisor','admin','vp']) r) org_roles,
      (select pg_catalog.jsonb_agg(private.member_has_chapter_role(c, array[r]) order by c, r) from unnest(${"$3"}::text[]) c, unnest(array['steward','coordinator','advisor','admin','vp']) r) chapter_roles,
      (select pg_catalog.jsonb_agg(private.actor_has_chapter_staff_role((select auth.uid()), c) order by c) from unnest(${"$3"}::text[]) c) staff_role,
      (select pg_catalog.jsonb_agg(public.staff_can_see_user(t, r) order by t, r) from unnest(${"$4"}::uuid[]) t, unnest(array['steward','coordinator','advisor','admin','vp','member']) r) see_user,
      (select pg_catalog.jsonb_agg(private.actor_role_covers_member((select auth.uid()), c, r, t, g) order by c, r, t, g) from unnest(${"$3"}::text[]) c, unnest(array['steward','coordinator']) r, unnest(${"$4"}::uuid[]) t, unnest(array[false, true]) g) covers`;
    const helperArgs = [small.org, small.otherOrg, chapters, profiles];
    const observe = async () => {
      const seen = {};
      for (const [who, caller] of Object.entries(small.callers)) {
        for (const [name, sql, args] of reads) seen[`${who} ${name}`] = await call(caller, sql, args, "120s");
        seen[`${who} helpers`] = await helpers(caller, helperSql, helperArgs);
      }
      for (const value of Object.values(seen)) delete value.ms;
      // A statement timeout is never an answer to compare.
      expect(Object.keys(seen).filter((key) => seen[key]?.error === "57014"), "reads that hit the statement limit").toEqual([]);
      return seen;
    };
    // This comparison proves 's optimization against its own predecessor.
    //  intentionally changes today's Advisor scope, and  the intake
    // owners and President reviews (selected workspace, current roles), and
    //  (20261124123000) the President overview's member count and trend
    // (Admin's population, every join year inside the trend); the scale test
    // below still exercises the current installed readers and their
    // per-profile budget.
    await db.query("savepoint optimized_advisor");
    let installed;
    try {
      for (const name of ["public.get_advisor_overview", "public.list_intake_triage_owners", "public.list_vp_case_reviews", "public.get_vp_overview"]) {
        await db.query(fnBody(MIGRATION, name));
      }
      installed = await observe();
    } finally {
      await db.query("rollback to savepoint optimized_advisor");
    }
    await db.query("savepoint predecessor");
      // Restore the historical pre-backfill scope shape inside this rollback-only before-image.
      await db.query("delete from private.chapter_role_scopes where legacy_chapter_coverage");
    try {
      for (const fn of predecessors()) {
        await db.query(fn.sql);
        if (fn.kind === "reader") {
          const signature = [...fn.pins.keys()].find((key) => key.startsWith(`${fn.name}(`));
          const { rows: [row] } = await db.query("select md5(pg_get_functiondef($1::regprocedure)) hash", [signature]);
          expect(row.hash, `${fn.name} rebuilt predecessor`).toBe(fn.pins.get(signature));
        }
      }
      const previous = await observe();
      // Name every read whose answer moved, with both answers, so a failure
      // says which caller and read differ instead of an 81-key object diff.
      const moved = Object.keys(installed).filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(installed[key]));
      expect(moved.map((key) => ({ key, installed: installed[key], predecessor: previous[key] }))).toEqual([]);
      expect(previous).toEqual(installed);
    } finally {
      await db.query("rollback to savepoint predecessor");
    }
    // The fixture reaches the readers' answers and refusals.
    expect(installed["orgVp get_vp_overview"].error).toBeUndefined();
    expect(installed["orgAdvisor get_advisor_overview"].error).toBeUndefined();
    expect(installed["chapterAdvisor get_advisor_overview"].error).toBeUndefined();
    expect(installed["chapterCoordinator list_intake_triage_owners"].value.length).toBeGreaterThan(0);
    expect(installed["member get_vp_overview"].error).toBe("42501");
    expect(installed["member get_advisor_overview"].error).toBe("42501");
  }, runnerTimeout(120_000));

  it("answers the staff desk reads at 1,000 accounts well inside the 30 s limit", async () => {
    // Seeded only now, so the predecessor comparison above never scans it.
    await db.query("set local session_replication_role = replica");
    scale = await seed("c7206000", 1000, 200, 600, [
      { n: 1000, org: "admin", caller: "orgAdmin" },
      { n: 999, org: "vp", caller: "orgVp" },
      { n: 998, org: "advisor", caller: "orgAdvisor" },
      { n: 997, chapter: "advisor", caller: "chapterAdvisor" },
      { n: 6, caller: "chapterCoordinator" },
    ]);
    await db.query("set local session_replication_role = origin");
    await sessions(scale.callers);
    // Scaled by a calibration query on a
    // loaded machine (2,131 ms against 2,000 at a Spark load of about 60).
    const { budget, calibrationMs } = await loadScaledBudget(db, 2_000, { label: "staff desk overview" });
    console.info("Staff desk overview budget", JSON.stringify({ calibrationMs, budget }));
    const someCase = (await db.query("select id from public.member_cases where reference='c7206000-1'")).rows[0].id;
    const cases = [
      ["orgVp", "get_vp_overview", true], ["orgVp", "list_vp_case_reviews", true],
      ["orgAdvisor", "get_advisor_overview", true], ["chapterAdvisor", "get_advisor_overview", true],
      ["chapterCoordinator", "get_case_queue_next_actions", false], ["chapterCoordinator", "list_intake_triage_owners", true],
      ["orgAdmin", "get_organization_analytics_snapshot", false],
    ];
    for (const [who, name, setWise] of cases) {
      const sql = READS.find(([read]) => read === name)[1];
      await call(scale.callers[who], sql);
      const { result, calls } = await perProfileCalls(() => call(scale.callers[who], sql));
      expect(result.error, `${who} ${name}`).toBeUndefined();
      if (setWise) expect(calls, `${who} ${name} per-profile predicate calls`).toBe(0);
      // The best of three runs, each judged by a calibration taken beside it
      // on this connection (ledgers 254 and 319).
      const judged = await pairedFastest(db, result.ms, () => call(scale.callers[who], sql), { baseMs: 2_000, budget });
      reportPaired(`staff desk overview, ${who} ${name}`, judged.runs);
      expect(judged.best.ms, `${who} ${name} ${JSON.stringify(judged.runs)}`).toBeLessThan(judged.best.bound);
    }
    const candidates = await perProfileCalls(() => call(scale.callers.chapterCoordinator, "select public.list_member_case_assignment_candidates($1) value", [someCase]));
    expect(candidates.result.error).toBeUndefined();
    expect(candidates.calls).toBe(0);
  }, runnerTimeout(120_000));

  it("keeps the converted helpers' exact query, settings and grants", async () => {
    const { rows } = await db.query(`select p.oid::regprocedure::text sig, l.lanname, p.provolatile, p.prosecdef, p.proconfig
      from pg_proc p join pg_language l on l.oid=p.prolang where p.oid = any($1::regprocedure[]) order by 1`,
    [predecessors().filter((fn) => fn.kind === "helper").map((fn) => fn.sql.match(/^CREATE OR REPLACE FUNCTION ([\s\S]*?)\n RETURNS/)[1]
      .replace(/\b(p_\w+) /g, "").replace(/ DEFAULT [^,)]+/g, ""))]);
    expect(rows).toHaveLength(11);
    for (const row of rows) expect(row, row.sig).toMatchObject({ lanname: "plpgsql", provolatile: "s", prosecdef: true, proconfig: ['search_path=""'] });
  });
});
