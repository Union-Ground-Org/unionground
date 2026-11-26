// @vitest-environment node
//
// PERF-UG-RLS-MULTIPLE-PERMISSIVE-POLICIES-MERGE-20261028 (#6361)
//
// 20261028210000 replaces the two or three permissive SELECT policies on
// eleven tables with one policy whose predicate is the OR of the former ones.
// This proof, on the complete schema:
//   - finds no table, role and command left with more than one permissive
//     policy (the Supabase advisor's multiple_permissive_policies rule), and
//     no policy anywhere that calls auth.uid() bare (once per row) instead of
//     as (select auth.uid()) (once per statement);
//   - rebuilds the former policies from the migration's own OR branches inside
//     a rolled-back transaction, checks each against the md5 the migration's
//     guard pinned, and shows a member, a second member, a steward, a
//     coordinator and an outsider see the same rows on every merged table
//     under both shapes;
//   - runs EXPLAIN ANALYZE of five cold-Home reads as the member under both
//     shapes, checks no InitPlan (auth.uid() and the session checks) ran more
//     than once, and prints the timings.
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const MIGRATION = "20261028210000_rls_merge_multiple_permissive_select_policies";
const migration = readFileSync(new URL(`../supabase/migrations/${MIGRATION}.sql`, import.meta.url), "utf8");
const runner = readFileSync(new URL("../scripts/run-required-db-proofs.mjs", import.meta.url), "utf8");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

// The migration header names each merged policy's predecessors in OR order;
// the guard pins each predecessor's md5; the body holds the OR branches.
const formerNames = Object.fromEntries([...migration.matchAll(/^-- {3}(\w+)_select: ([\w, ]+)$/gmu)]
  .map(([, table, names]) => [table, names.split(", ")]));
const guard = JSON.parse(/expected constant jsonb := '(\{.*\})';/u.exec(migration)[1]);
const branches = Object.fromEntries([...migration.matchAll(/^create policy (\w+)_select on public\.\1 for select to authenticated using \(\n {2}([\s\S]*?)\n\);$/gmu)]
  .map(([, table, body]) => [table, body.split("\n  or ").map((branch) => branch.slice(1, -1))]));
const TABLES = Object.keys(formerNames).sort();

// The advisor's rule: a table, role and SELECT/INSERT/UPDATE/DELETE action
// decided by more than one permissive policy.
const MULTIPLE_PERMISSIVE = `
  select n.nspname || '.' || c.relname || ' ' || r.rolname || ' ' || act as finding
  from pg_catalog.pg_policy p
  join pg_catalog.pg_class c on c.oid = p.polrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_roles r on p.polroles @> array[r.oid] or p.polroles = array[0::oid]
  cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) act
  where p.polpermissive and n.nspname = 'public'
    and r.rolname in ('anon', 'authenticated', 'authenticator', 'dashboard_user')
    and (p.polcmd = '*' or p.polcmd = case act when 'SELECT' then 'r' when 'INSERT' then 'a' when 'UPDATE' then 'w' else 'd' end)
  group by n.nspname, c.relname, r.rolname, act having count(*) > 1
  order by 1`;
const BARE_AUTH_UID = `
  select schemaname || '.' || tablename || '.' || policyname as policy
  from pg_catalog.pg_policies
  where pg_catalog.regexp_count(coalesce(qual, '') || coalesce(with_check, ''), 'auth\\.uid\\(\\)')
      > pg_catalog.regexp_count(coalesce(qual, '') || coalesce(with_check, ''), 'SELECT auth\\.uid\\(\\) AS uid')
  order by 1`;
const HOME_READS = ["member_cases", "member_case_updates", "member_profiles", "member_forms", "member_conversations"];

describe("RLS permissive-policy merge (static)", () => {
  it("names, pins and rebuilds the same predecessors for all eleven tables", () => {
    expect(TABLES).toHaveLength(11);
    for (const table of TABLES) {
      expect(Object.keys(guard[table]).sort(), table).toEqual([...formerNames[table]].sort());
      expect(branches[table], table).toHaveLength(formerNames[table].length);
      for (const name of formerNames[table]) expect(migration).toContain(`drop policy ${name} on public.${table};`);
      expect(migration).toContain(`comment on policy ${table}_select on public.${table} is '`);
    }
  });

  it("is in the required DB proof lane and the contract pins the merged policies", () => {
    expect(PROOF_FILES).toContain("tests/rls-home-policy-cost-db.test.js");
    expect(runner).toContain('RUN_RLS_HOME_POLICY_COST_DB_TESTS: "1"');
    for (const table of TABLES) {
      expect(contract.policies.filter((entry) => entry.table === table && entry.cmd === "r" && entry.permissive !== false).map((entry) => entry.name), table)
        .toEqual([`${table}_select`]);
      for (const name of formerNames[table]) {
        expect(contract.policies.some((entry) => entry.table === table && entry.name === name), name).toBe(false);
      }
    }
  });
});

const live = process.env.RUN_RLS_HOME_POLICY_COST_DB_TESTS === "1" ? describe : describe.skip;

async function seed(db) {
  const ids = Object.fromEntries(["org", "otherOrg", "member", "peer", "steward", "coordinator", "outsider"].map((key) => [key, randomUUID()]));
  ids.chapter = `rls-merge-${ids.org}`;
  ids.otherChapter = `rls-merge-${ids.otherOrg}`;
  const people = ["member", "peer", "steward", "coordinator", "outsider"];
  for (const key of people) {
    await db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [ids[key], `rls-merge-${key}-${ids[key]}@example.invalid`]);
    await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [ids[`${key}Session`] = randomUUID(), ids[key]]);
    await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'RLS merge factor','totp','verified',now(),now())", [randomUUID(), ids[key]]);
  }
  for (const [org, chapter, owner] of [[ids.org, ids.chapter, ids.coordinator], [ids.otherOrg, ids.otherChapter, ids.outsider]]) {
    await db.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [org, `rls-merge-${org}`, owner]);
    await db.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [org]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,'RLS merge chapter',$1,$2,false,9970)", [chapter, org]);
    // Compare policy consolidation under the original assigned-only steward
    // setting. Default-on grievance coverage has its own scoped-access proof.
    await db.query("insert into private.chapter_access_policies(chapter_id,steward_grievances) values($1,false)", [chapter]);
  }
  for (const key of people) {
    const [org, chapter] = key === "outsider" ? [ids.otherOrg, ids.otherChapter] : [ids.org, ids.chapter];
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, ids[key]]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [ids[key], chapter]);
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [ids[key], chapter]);
  }
  for (const role of ["steward", "coordinator"]) {
    await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [ids[role], role, ids.chapter]);
    await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [ids[role], role, ids.chapter]);
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$4)", [ids.org, ids[role], role, ids.coordinator]);
  }
  // The member's case is assigned to the steward; the peer's is not; the
  // outsider's sits in another organization.
  for (const [key, org, chapter, steward] of [["member", ids.org, ids.chapter, ids.steward], ["peer", ids.org, ids.chapter, null], ["outsider", ids.otherOrg, ids.otherChapter, null]]) {
    const caseId = ids[`${key}Case`] = randomUUID();
    await db.query(`insert into public.member_cases(id,user_id,organization_id,chapter_id,reference,title,case_type,step,status,steward_user_id)
      values($1,$2,$3,$4,$5,'RLS merge case','Grievance','intake','active',$6)`, [caseId, ids[key], org, chapter, `RLSM-${key}-${caseId.slice(0, 8)}`, steward]);
    await db.query("insert into public.member_case_updates(case_id,user_id,body) values($1,$2,'RLS merge update')", [caseId, ids[key]]);
    await db.query("insert into public.casework_deadlines(case_id,organization_id,chapter_id,kind,label,due_at) values($1,$2,$3,'filing','RLS merge deadline',now()+interval '9 days')", [caseId, org, chapter]);
    const conversation = (await db.query("insert into public.member_conversations(user_id,title) values($1,'RLS merge thread') returning id", [ids[key]])).rows[0].id;
    await db.query("insert into public.member_messages(conversation_id,user_id,sender_kind,sender_name,body) values($1,$2,'member','Member','RLS merge message')", [conversation, ids[key]]);
    await db.query("insert into public.member_steward_requests(user_id,status) values($1,'requested')", [ids[key]]);
    await db.query("insert into public.member_forms(user_id,template_key,template_version,status) values($1,'grievance',1,'submitted'),($1,'grievance',1,'draft')", [ids[key]]);
  }
  return { ids, people };
}

async function as(db, ids, key) {
  await db.query("reset role");
  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "authenticated", sub: ids[key], session_id: ids[`${key}Session`], aal: "aal2" })]);
  await db.query("set local role authenticated");
}

// Rows compare by primary key: column grants keep some columns from the
// member role, so a whole-row read would be refused.
async function primaryKeys(db) {
  const { rows } = await db.query(`select c.relname, string_agg(pg_catalog.quote_ident(a.attname), ', ' order by k.ord) as columns
    from pg_catalog.pg_index i
    join pg_catalog.pg_class c on c.oid = i.indrelid
    cross join unnest(i.indkey) with ordinality k(attnum, ord)
    join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
    where i.indisprimary and c.oid = any($1::regclass[]) group by c.relname`, [TABLES.map((table) => `public.${table}`)]);
  const keys = Object.fromEntries(rows.map((row) => [row.relname, row.columns]));
  expect(Object.keys(keys).sort()).toEqual(TABLES);
  return keys;
}

async function visibleRows(db, ids, people) {
  const keys = await primaryKeys(db);
  const result = {};
  for (const key of people) {
    await as(db, ids, key);
    for (const table of TABLES) {
      const { rows } = await db.query(`select coalesce(array_agg(row(${keys[table]})::text order by row(${keys[table]})::text), '{}') as rows from public.${table}`);
      result[`${key} ${table}`] = rows[0].rows;
    }
  }
  await db.query("reset role");
  return result;
}

function planNodes(node, out = []) {
  out.push(node);
  for (const child of node.Plans ?? []) planNodes(child, out);
  return out;
}

async function homeReadPlans(db, ids) {
  await as(db, ids, "member");
  const result = {};
  for (const table of HOME_READS) {
    const { rows } = await db.query(`explain (analyze, format json) select * from public.${table}`);
    const [plan] = rows[0]["QUERY PLAN"];
    const initPlans = planNodes(plan.Plan).filter((node) => String(node["Subplan Name"] ?? "").startsWith("InitPlan"));
    result[table] = { planning: plan["Planning Time"], execution: plan["Execution Time"], initPlanLoops: initPlans.map((node) => node["Actual Loops"]) };
  }
  await db.query("reset role");
  return result;
}

// Swap each merged policy for its predecessors, built from the branches.
async function restorePredecessors(db) {
  await db.query("select pg_catalog.set_config('search_path', '', true)");
  for (const table of TABLES) {
    await db.query(`drop policy ${table}_select on public.${table}`);
    for (const [index, name] of formerNames[table].entries()) {
      await db.query(`create policy ${name} on public.${table} for select to authenticated using (${branches[table][index]})`);
    }
    const { rows } = await db.query(`select polname, pg_catalog.md5(pg_catalog.pg_get_expr(polqual, polrelid)) as md5
      from pg_catalog.pg_policy where polrelid = $1::regclass and polpermissive and polcmd = 'r'`, [`public.${table}`]);
    expect(Object.fromEntries(rows.map((row) => [row.polname, row.md5])), table).toEqual(guard[table]);
  }
  await db.query("select pg_catalog.set_config('search_path', 'public', true)");
}

live("RLS permissive-policy merge on the complete schema", () => {
  it("leaves no multiple-permissive finding and no bare auth.uid() in any policy", async () => {
    const db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "rls-home-policy-cost-proof" });
    await db.connect();
    try {
      expect((await db.query(MULTIPLE_PERMISSIVE)).rows).toEqual([]);
      expect((await db.query(BARE_AUTH_UID)).rows).toEqual([]);
      const merged = await db.query(`select tablename, policyname, roles::text, cmd from pg_catalog.pg_policies
        where schemaname = 'public' and permissive = 'PERMISSIVE' and cmd in ('SELECT', 'ALL') and tablename = any($1) order by 1`, [TABLES]);
      expect(merged.rows).toEqual(TABLES.map((table) => ({ tablename: table, policyname: `${table}_select`, roles: "{authenticated}", cmd: "SELECT" })));
    } finally {
      await db.end();
    }
  }, 30000);

  it("shows every persona the same rows under the merged and the former policies, and evaluates auth.uid() once per Home read", async () => {
    const db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "rls-home-policy-cost-proof" });
    await db.connect();
    await db.query("begin");
    try {
      await db.query("set local statement_timeout = '60s'");
      const { ids, people } = await seed(db);
      const after = await visibleRows(db, ids, people);
      // The seed is not vacuous: each persona sees its own case, the steward
      // also the assigned case, the coordinator the whole chapter.
      expect(after[`member member_cases`]).toHaveLength(1);
      expect(after[`steward member_cases`]).toHaveLength(1);
      expect(after[`coordinator member_cases`].length).toBeGreaterThanOrEqual(2);
      expect(after[`outsider member_messages`]).toHaveLength(1);
      expect(after[`steward member_profiles`].length).toBeGreaterThan(1);
      const afterPlans = await homeReadPlans(db, ids);

      await restorePredecessors(db);
      const before = await visibleRows(db, ids, people);
      const beforePlans = await homeReadPlans(db, ids);
      expect(after).toEqual(before);
      for (const table of HOME_READS) {
        for (const plans of [beforePlans, afterPlans]) {
          // An InitPlan in an OR branch the planner never reaches reports 0
          // loops; none may run more than once.
          expect(plans[table].initPlanLoops.filter((loops) => loops === 1).length, table).toBeGreaterThan(0);
          expect(plans[table].initPlanLoops.every((loops) => loops <= 1), `${table} ${plans[table].initPlanLoops}`).toBe(true);
        }
      }
      const timings = `[rls-home-policy-cost] EXPLAIN ANALYZE as a member, ms (planning / execution), former -> merged:\n${HOME_READS.map((table) =>
        `  ${table}: ${beforePlans[table].planning.toFixed(3)} / ${beforePlans[table].execution.toFixed(3)} -> ${afterPlans[table].planning.toFixed(3)} / ${afterPlans[table].execution.toFixed(3)}`).join("\n")}\n`;
      // The suite setup quiets the console; RLS_HOME_POLICY_COST_REPORT names a file for the PR's timings.
      if (process.env.RLS_HOME_POLICY_COST_REPORT) appendFileSync(process.env.RLS_HOME_POLICY_COST_REPORT, timings);
      else console.log(timings);
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 90000);
});
