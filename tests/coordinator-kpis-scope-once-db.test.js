// @vitest-environment node
// #7593: compare the complete predecessor result and candidate case ids, then
// bound repeated authorization work independently of wall-clock noise.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, latestFnBody, loadMigrationSql } from "./helpers/migration.js";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

const predecessor = fnBody(loadMigrationSql("20261102005607"), "public.get_coordinator_kpis");
const P = "a7593000";
const id = (kind, n) => `${P.slice(0, 7)}${kind}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const user = n => id("0", n);
const chapter = n => `${P}-ch-${n}`;
const organization = n => id("f", n);
const caseId = n => id("c", n);
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

// Expose only the ids from each function's actual base CTE, retaining every
// predicate. The public JSON remains the field/aggregate/ordering oracle.
function rowOracle(definition, name) {
  const start = definition.search(/with (?:tenant|coordinator_members) as materialized/);
  const end = definition.indexOf("\n  select\n    pg_catalog.count", start);
  if (start < 0 || end < 0) throw new Error("KPI base CTE not found");
  const ctes = definition.slice(start, end).replace("select t.status, t.step, t.articles, t.deadline", "select t.id, t.status, t.step, t.articles, t.deadline");
  return `create function pg_temp.${name}() returns uuid[] language plpgsql stable security definer set search_path='' as $proof$
    declare caller uuid := (select auth.uid());
    begin return (${ctes} select coalesce(array_agg(id order by id),'{}'::uuid[]) from base); end; $proof$;`;
}

live("coordinator KPI statement scope (#7593)", () => {
  let db;
  const actors = new Map();
  const as = async (n, run, { aal = "aal2", role = "authenticated", anonymous = false } = {}) => {
    await db.query("savepoint actor_call");
    try {
      const actor = actors.get(n);
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role, sub: anonymous ? undefined : user(n), session_id: actor?.session, aal })]);
      await db.query(`set local role ${role}`);
      return await run();
    } finally {
      await db.query("rollback to savepoint actor_call");
      await db.query("release savepoint actor_call");
    }
  };
  const result = async (sql) => {
    await db.query("savepoint result_call");
    try { return { payload: (await db.query(sql)).rows[0].payload }; }
    catch (error) { return { code: error.code, message: error.message }; }
    finally {
      await db.query("rollback to savepoint result_call");
      await db.query("release savepoint result_call");
    }
  };
  const kpis = "select public.get_coordinator_kpis() payload";

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "coordinator-kpi-once-proof" });
    await db.connect();
    await db.query("begin");
    // #8568: the predecessor reads the session day and the current reader the
    // Eastern day; compare them on one day, the Eastern one.
    await db.query("set local timezone to 'America/New_York'");
    await db.query("set local statement_timeout='120s'");
    await db.query("set local track_functions='all'");
    // Synthetic fixture only; resume normal triggers before any proof call.
    await db.query("set local session_replication_role=replica");
    await db.query(`insert into public.organizations(id,slug,name,status,kind) values
      ($1,'k7593-union','Fictional KPI union','active','union'),
      ($2,'k7593-other','Fictional other union','active','union'),
      ($3,'k7593-platform','Internal platform proof','active','platform')`, [organization(1), organization(2), organization(3)]);
    await db.query(`insert into public.chapters(id,name,slug,organization_id,is_default,order_index)
      select '${P}-ch-'||n,'Proof chapter '||n,'${P}-ch-'||n,
        case when n<=6 then $1::uuid when n=7 then $2::uuid else $3::uuid end,false,9590+n
      from generate_series(1,8) n`, [organization(1), organization(2), organization(3)]);
    // 1,000 accounts. Actors 1..16 live in chapter one; 17,19,20 in
    // another organization, 18 in the platform; other members span six chapters.
    const home = "case when n=18 then 8 when n in (17,19,20) or n>900 then 7 when n<=20 then 1 else ((n-21)%6)+1 end";
    const uid = `('${P}-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid`;
    await db.query(`insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
      select ${uid},'authenticated','authenticated','${P}-'||n||chr(64)||'example.invalid','{}','{}',now(),now(),false,false from generate_series(1,1000) n`);
    await db.query(`insert into public.member_profiles(id,first_name,full_name,initials,chapter_id,role_line,member_since,language,
        notification_prefs,dnd_enabled,quiet_hours_timezone,urgent_notifications_enabled,shortcut_keys,work_widget_order,created_at,updated_at)
      select ${uid},'Proof','KPI member '||n,'PM','${P}-ch-'||(${home}),'Member',2020,'en','{}',false,'UTC',true,'{}','{}',now(),now() from generate_series(1,1000) n`);
    await db.query(`insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,joined_at)
      select ${uid},'${P}-ch-'||(${home}),'active',true,now() from generate_series(1,1000) n`);
    await db.query(`insert into public.organization_memberships(organization_id,user_id,status)
      select case when (${home})<=6 then $1::uuid when (${home})=7 then $2::uuid else $3::uuid end,${uid},'active' from generate_series(1,1000) n`, [organization(1), organization(2), organization(3)]);
    await db.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true),(true,$2,true),(true,$3,true)", [organization(1), organization(2), organization(3)]);
    const roles = [[2,"steward"],[3,"coordinator"],[4,"advisor"],[5,"admin"],[6,"vp"],[8,"coordinator"],[8,"advisor"],[9,"coordinator"],[9,"admin"],[10,"coordinator"],[10,"vp"],
      [11,"coordinator"],[12,"coordinator"],[13,"coordinator"],[14,"coordinator"],[15,"coordinator"],[16,"coordinator"],[17,"coordinator"],[18,"coordinator"]];
    for (const [n, role] of roles) {
      for (const table of ["member_roles", "member_role_chapters"]) {
        await db.query(`insert into public.${table}(user_id,role,chapter_id,granted_by) values($1,$2,$3,$1)`, [user(n), role, chapter(n === 17 ? 7 : n === 18 ? 8 : 1)]);
      }
    }
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)", [organization(1), user(7)]);
    for (const n of [19,20]) {
      for (const org of [1,2]) {
        await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active') on conflict do nothing", [organization(org), user(n)]);
        await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)", [organization(org), user(n)]);
      }
    }
    await db.query("update public.organization_memberships set status='revoked',revoked_at=now() where user_id=$1", [user(13)]);
    await db.query("update public.member_chapter_memberships set status='revoked',revoked_at=now() where user_id=$1", [user(14)]);
    await db.query("update public.member_profiles set chapter_id=null where id=$1", [user(16)]);
    await db.query("insert into private.chapter_units(id,chapter_id,organization_id,name) values($1,$2,$3,'Proof unit')", [id("d",1),chapter(1),organization(1)]);
    await db.query("insert into private.chapter_committees(id,chapter_id,name,purpose,starts_on,grievance_access) values($1,$2,'Proof committee','Fictional scope proof',current_date-1,false)", [id("e",1),chapter(1)]);
    await db.query(`insert into private.chapter_unit_members(unit_id,chapter_id,user_id) select $1,$2,id from public.member_profiles where chapter_id=$2 and id::text like '${P}%' and id::text > $3`, [id("d",1),chapter(1),user(400)]);
    await db.query(`insert into private.chapter_committee_members(committee_id,chapter_id,user_id) select $1,$2,id from public.member_profiles where chapter_id=$2 and id::text like '${P}%' and id::text < $3`, [id("e",1),chapter(1),user(400)]);
    await db.query("insert into private.chapter_role_scopes(user_id,chapter_id,role,unit_id,committee_id) values($1,$3,'coordinator',$4,null),($2,$3,'coordinator',null,$5)", [user(11),user(12),chapter(1),id("d",1),id("e",1)]);
    // Histories have ties in both sorted arrays, boundary deadlines,
    // resolved/closed rows, assignments, restricted and private identities.
    await db.query(`insert into public.member_cases(id,user_id,organization_id,chapter_id,reference,title,case_type,status,step,articles,deadline,is_restricted,restriction_reason,restricted_at,restricted_by,steward_user_id,coordinator_user_id)
      select ('${P.slice(0,7)}c-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,p.id,
        case when n<=600 then $1::uuid else $2::uuid end,p.chapter_id,'K7593-'||n,'Fictional KPI case','other',
        case when n%4=0 then 'resolved' else 'active' end,
        (array['Step 1','Step 2','Step 4','Arbitration','Step 3'])[1+n%5],
        (array['','Article A','Article B','Article C'])[1+n%4],current_date+(array[-1,0,6,7])[1+n%4],n%7=0,
        case when n%7=0 then 'Fictional restriction' end,case when n%7=0 then now() end,case when n%7=0 then $4::uuid end,
        case when n%3=0 then $3::uuid end,case when n%5=0 then $4::uuid end
      from generate_series(1,660) n join public.member_profiles p on p.id=(
        '${P}-0000-4000-8000-'||lpad((case when n<=600 then 101+((n-1)%600) else 901+(n-601) end)::text,12,'0'))::uuid`, [organization(1),organization(2),user(2),user(3)]);
    await db.query("insert into private.case_identity_privacy(case_id) select id from public.member_cases where reference like 'K7593-%' and substring(reference from 7)::integer%11=0");
    await db.query("update public.member_cases set learning_undone_at=now() where reference like 'K7593-%' and substring(reference from 7)::integer%17=0");
    // Move a member's profile while retaining the original case scope, the
    // established cross-organization explicit-grant path.
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [user(101),chapter(7)]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [organization(2),user(101)]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user(101),chapter(7)]);
    await db.query("insert into public.casework_access_grants(id,case_id,organization_id,chapter_id,grantee_user_id,granted_by,reason) values($1,$2,$3,$4,$5,$6,'Fictional cross-organization proof')", [id("a",1),caseId(1),organization(1),chapter(3),user(19),user(3)]);
    for (let n=1;n<=20;n++) {
      const session=randomUUID(); actors.set(n,{session});
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session,user(n)]);
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,secret,created_at,updated_at) values($1,$2,'proof','totp','verified','proof',now(),now())", [randomUUID(),user(n)]);
    }
    await db.query("set local session_replication_role=origin");
    await db.query("analyze public.member_cases, public.member_profiles, public.member_roles, public.member_role_chapters, public.organization_role_grants, public.member_chapter_memberships, public.organization_memberships, public.chapters, public.organizations");
    await db.query(predecessor.replace("public.get_coordinator_kpis", "pg_temp.predecessor_kpis"));
    await db.query(rowOracle(predecessor,"predecessor_ids"));
    await db.query(rowOracle(latestFnBody("public.get_coordinator_kpis"),"candidate_ids"));
  },120_000);

  afterAll(async () => { if(db) {try {await db.query("rollback");} finally {await db.end();}} });

  it("preserves all fields, ordered arrays, aggregates, exact case rows and refusals across roles", async () => {
    for(let n=1;n<=20;n++) {
      await as(n,async()=>{
        const old=await result("select pg_temp.predecessor_kpis() payload");
        const current=await result(kpis);
        expect(current,`actor ${n}`).toEqual(old);
        if(current.code) { expect(current.code).toBe("42501"); return; }
        const rows=(await db.query("select pg_temp.predecessor_ids() old,pg_temp.candidate_ids() current")).rows[0];
        expect(rows.current,`actor ${n} case ids`).toEqual(rows.old);
        if(n===3||n===7) expect(current.payload.openCases).toBeGreaterThan(0);
      });
    }
    for(const n of [1,2,4,5,6,18]) {
      await as(n,async()=>expect((await result(kpis)).code).toBe("42501"));
    }
    for(const options of [{aal:"aal1"},{anonymous:true},{role:"anon",anonymous:true}]) {
      await as(15,async()=>{
        const old=await result("select pg_temp.predecessor_kpis() payload");
        const current=await result(kpis);
        expect(current.code).toBe("42501");
        // anon fails EXECUTE on the public RPC, while the temporary oracle's
        // default ACL differs; assert the real boundary independently.
        if(options.role!=="anon") expect(current).toEqual(old);
      },options);
    }
  },120_000);

  it("preserves committee grievance toggles, expired committees, revocation and grant changes", async()=>{
    for(const grievance of [true,false]) {
      await db.query("update private.chapter_committees set grievance_access=$1 where id=$2",[grievance,id("e",1)]);
      await as(12,async()=>{
        expect(await result(kpis)).toEqual(await result("select pg_temp.predecessor_kpis() payload"));
        const rows=(await db.query("select pg_temp.predecessor_ids() old,pg_temp.candidate_ids() current")).rows[0];
        expect(rows.current).toEqual(rows.old);
      });
    }
    await db.query("update private.chapter_committees set ends_on=current_date-1 where id=$1",[id("e",1)]);
    await as(12,async()=>expect(await result(kpis)).toEqual(await result("select pg_temp.predecessor_kpis() payload")));
    const granted=await as(19,async()=>(await db.query("select pg_temp.candidate_ids() payload")).rows[0].payload);
    const ungranted=await as(20,async()=>(await db.query("select pg_temp.candidate_ids() payload")).rows[0].payload);
    expect(granted).toContain(caseId(1)); expect(ungranted).not.toContain(caseId(1));
    await db.query("update public.casework_access_grants set revoked_at=now(),revoked_by=$2 where id=$1",[id("a",1),user(3)]);
    await as(19,async()=>{
      expect(await result(kpis)).toEqual(await result("select pg_temp.predecessor_kpis() payload"));
      expect((await db.query("select pg_temp.candidate_ids() payload")).rows[0].payload).not.toContain(caseId(1));
    });
  },120_000);

  it("resolves chapter and coordinator-member authority once rather than per case at 1,000 accounts", async()=>{
    const population=(await db.query(`select count(*)::int n from auth.users where id::text like '${P}%'`)).rows[0].n;
    expect(population).toBe(1000);
    const stats=async()=>(await db.query("select funcname,calls from pg_stat_xact_user_functions where schemaname='private'")).rows;
    await as(7,async()=>{
      for(let n=0;n<5;n++) {
        const before=await stats(),started=performance.now();
        const payload=(await db.query(kpis)).rows[0].payload;
        const ms=performance.now()-started,after=await stats();
        const calls=name=>Number(after.find(r=>r.funcname===name)?.calls??0)-Number(before.find(r=>r.funcname===name)?.calls??0);
        expect(payload.openCases).toBeGreaterThan(0);
        expect(calls("casework_staff_can_read")).toBe(0);
        expect(calls("casework_staff_can_access")).toBe(0);
        expect(calls("actor_has_chapter_staff_role")).toBeLessThanOrEqual(1);
        expect(calls("staff_visible_member_ids")).toBe(1);
        expect(ms).toBeLessThan(runnerTimeout(1000));
      }
    });
  },120_000);
});
