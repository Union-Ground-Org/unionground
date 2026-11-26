// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";
const migration = loadMigrationSql("20261009003000_chapter_officer_budgets");
const sql = stripComments(migration);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("chapter officer budget contract", () => {
  it("keeps budgets behind RPCs and adds no user foreign key or title-derived privilege", () => {
    expect(sql).toContain("alter table private.chapter_budgets force row level security;");
    expect(sql).toContain("revoke all on private.chapter_budgets from public, anon, authenticated, service_role;");
    expect(sql).not.toMatch(/references auth.users/);
    expect(sql).not.toMatch(/display_title\s*(?:=|in|is not null)/i);
    expect(sql).toContain("private.member_pin_require_full_session()");
    expect(sql).toContain("chapter is distinct from p_expected_chapter");
    expect(sql).toContain("org is distinct from p_expected_org");
  });
  it("pins the routines, table ACLs and membership office bounds", () => {
    expect(contract.functions.filter((row) => /chapter_budget/.test(row.sig)).length).toBe(5);
    expect(contract.tableGrants.filter((row) => row.table === "private.chapter_budgets").map((row) => row.privileges)).toEqual(["", "", ""]);
    expect(contract.constraints.some((row) => row.name === "membership_budget_office_check")).toBe(true);
    // prosrc hashes use the literal dollar-quoted body, including whitespace.
    const bodies = [...migration.matchAll(/create or replace function [\w.]+\([^)]*\)\s*.*?as (\$function\$|\$\$)(.*?)\1;/gs)];
    expect(bodies).toHaveLength(7);
    for (const [, , body] of bodies) expect(sql).toContain(createHash("md5").update(body).digest("hex"));
  });
});
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

async function fixture(run) {
  const db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "chapter-officer-budget-rollback-proof" });
  await db.connect(); await db.query("begin");
  try {
    await db.query("set local statement_timeout = '60s'");
    const org = randomUUID(), otherOrg = randomUUID();
    const chapter = `budget-${org}`, sibling = `budget-sibling-${org}`, foreign = `budget-${otherOrg}`;
    await db.query("insert into public.organizations(id,slug,name) values ($1::uuid,$1::text,'Harbor Workers'),($2::uuid,$2::text,'Ridge Transit')", [org, otherOrg]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$4,9940),($2,$2,$2,$4,9941),($3,$3,$3,$5,9942)", [chapter,sibling,foreign,org,otherOrg]);
    const people = {};
    for (const [name,role,title = null] of [["admin","admin"],["president","vp"],["officer",null],["member",null],["memberNoFactor",null],
      ["titleTreasurer",null,"Treasurer"],["titleSecretary",null,"Secretary"]]) {
      const id = randomUUID(), session = randomUUID(); people[name] = {id,session};
      await db.query("insert into auth.users(id,email) values ($1,$2)", [id,`${id}@example.invalid`]);
      await db.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id,chapter,`Budget ${name}`]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,$3,now(),now())", [session,id,name === "memberNoFactor" ? "aal1" : "aal2"]);
      if (name !== "memberNoFactor") await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(),id]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org,id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,display_title) values ($1,$2,'active',$4),($1,$3,'active',null)", [id,chapter,sibling,title]);
      if (role) {
        await db.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3)", [id,role,chapter]);
        await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [id,role,chapter]);
      }
    }
    const owner = async () => { await db.query("reset role"); await db.query("select set_config('request.jwt.claims','',true)"); };
    const as = async (name,aal="aal2") => {
      await owner(); const user=people[name];
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({sub:user.id,role:"authenticated",session_id:user.session,aal})]);
      await db.query("set local role authenticated");
    };
    const one = async (query,args=[]) => (await db.query(query,args)).rows[0]?.v;
    const refused = async (query,args=[]) => {
      await db.query("savepoint negative"); let error;
      try { await db.query(query,args); } catch (failure) { error=failure; }
      await db.query("rollback to savepoint negative"); await db.query("release savepoint negative");
      expect(error,"negative control was unexpectedly allowed").toBeDefined(); return error;
    };
    const assign = (office) => one("select public.set_chapter_budget_office($1,$2,$3,$4) v",[org,chapter,people.officer.id,office]);
    const list = (expectedOrg=org, expectedChapter=chapter) => one("select public.list_chapter_budgets($1,$2,0) v",[expectedOrg,expectedChapter]);
    const save = (id=null,revision=0,items=[{name:"Meeting room",planned:125.25,actual:99.50}]) => one("select public.save_chapter_budget($1,$2,$3,$4,'October budget','2026-10-01','2026-10-31','Chapter notes',$5::jsonb) v",[org,chapter,id,revision,JSON.stringify(items)]);
    await run({db,org,otherOrg,chapter,sibling,foreign,people,owner,as,one,refused,assign,list,save});
  } finally { await db.query("rollback").catch(()=>{}); await db.end(); }
}
live("officer budgets on a disposable database", () => {
  it("reapplies unchanged budgets, or refuses a downgrade after Treasurer adoption", async () => {
    const db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "chapter-budget-reapply-proof" });
    await db.connect();
    await db.query("begin");
    try {
      // #4132 pattern: remove only the outer transaction, so both applications
      // and the negative definition control are discarded at rollback.
      const reapply = migration.replace(/^begin;$/m, "").replace(/^commit;$/m, "");
      const snapshot = async () => {
        const queries = [
          `select n.nspname, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
             c.relacl::text, pg_catalog.pg_get_userbyid(c.relowner) as owner
           from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where c.oid in ('public.member_chapter_memberships'::regclass, 'private.chapter_budgets'::regclass)
           order by n.nspname, c.relname`,
          `select a.attrelid::regclass::text as relation, a.attname, a.atttypid::regtype::text as type,
             a.atttypmod, a.attnotnull, a.attidentity, a.attgenerated, a.attacl::text,
             pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_expression
           from pg_catalog.pg_attribute a left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
           where a.attrelid in ('public.member_chapter_memberships'::regclass, 'private.chapter_budgets'::regclass)
             and a.attnum > 0 and not a.attisdropped order by relation, a.attnum`,
          `select conrelid::regclass::text as relation, conname, convalidated, pg_catalog.pg_get_constraintdef(oid) as definition
           from pg_catalog.pg_constraint where conrelid in ('public.member_chapter_memberships'::regclass, 'private.chapter_budgets'::regclass)
           order by relation, conname`,
          `select p.oid::regprocedure::text as signature, pg_catalog.md5(p.prosrc) as body_md5,
             pg_catalog.pg_get_functiondef(p.oid) as definition, p.proacl::text, pg_catalog.pg_get_userbyid(p.proowner) as owner
           from pg_catalog.pg_proc p where p.oid = any(array[
             'private.clear_inactive_budget_office()'::regprocedure,
             'private.chapter_budget_context(uuid,text)'::regprocedure,
             'public.get_chapter_budget_access(uuid,text,integer)'::regprocedure,
             'public.set_chapter_budget_office(uuid,text,uuid,text)'::regprocedure,
             'public.list_chapter_budgets(uuid,text,integer)'::regprocedure,
             'public.save_chapter_budget(uuid,text,uuid,integer,text,date,date,text,jsonb)'::regprocedure,
             'private.account_lifecycle_export_member_chapter_memberships(uuid)'::regprocedure]) order by signature`,
          `select tgenabled, pg_catalog.pg_get_triggerdef(oid) as definition from pg_catalog.pg_trigger
           where tgrelid = 'public.member_chapter_memberships'::regclass and tgname = 'b15_clear_budget_office'`,
          `select i.indisvalid, i.indisready, pg_catalog.pg_get_indexdef(i.indexrelid) as definition from pg_catalog.pg_index i
           where i.indrelid = 'private.chapter_budgets'::regclass order by definition`,
          `select * from private.account_lifecycle_trigger_review
           where (kind = 'trigger' and schema_name = 'public' and table_name = 'member_chapter_memberships' and object_name = 'b15_clear_budget_office')
             or (kind = 'function' and schema_name = 'private' and object_name = 'clear_inactive_budget_office()') order by kind`,
          `select export_columns from private.account_lifecycle_manifest
           where schema_name = 'public' and table_name = 'member_chapter_memberships' and user_column = 'user_id'`,
        ];
        const result = [];
        for (const query of queries) result.push((await db.query(query)).rows);
        return result;
      };
      const before = await snapshot(); // Stack migration replay installed the reviewed definition already.
      const currentDefinition = before[3].find((row) => row.signature.endsWith("get_chapter_budget_access(uuid,text,integer)")).definition;
      const currentContract = contract.functions.find((row) => row.sig.startsWith("public.get_chapter_budget_access("));
      expect(createHash("md5").update(currentDefinition).digest("hex")).toBe(currentContract.bodyMd5);
      if (contract.functions.some(row => row.sig.startsWith("public.get_chapter_finance_workspace("))) {
        // The new reviewed owner intentionally changes two budget functions.
        // The older migration must refuse to erase Treasurer access and must
        // leave every definition, ACL, receipt and export column untouched.
        await db.query("savepoint refused_downgrade");
        await expect(db.query(reapply)).rejects.toMatchObject({ code: "55000" });
        await db.query("rollback to savepoint refused_downgrade");
        expect(await snapshot()).toEqual(before);
        return;
      }
      await expect(db.query(reapply)).resolves.toBeDefined();
      const first = await snapshot();
      expect(first).toEqual(before);
      const probeDefinition = first[3].find((row) => row.signature.endsWith("get_chapter_budget_access(uuid,text,integer)")).definition;
      const probeContract = contract.functions.find((row) => row.sig.startsWith("public.get_chapter_budget_access("));
      expect(createHash("md5").update(probeDefinition).digest("hex")).toBe(probeContract.bodyMd5);
      await expect(db.query(reapply)).resolves.toBeDefined();
      expect(await snapshot()).toEqual(first);
      expect(first[6]).toHaveLength(2);
      expect(first[7]).toEqual([{ export_columns: ["user_id", "chapter_id", "status", "pinned", "last_selected_at", "joined_at", "revoked_at",
        "compass_unit_keys", "compass_scope_verification", "display_title", "budget_office"] }]);
      // Same name is insufficient: an unreviewed installed body must be refused.
      await db.query("savepoint changed_definition");
      await db.query("create or replace function private.clear_inactive_budget_office() returns trigger language plpgsql set search_path = '' as 'begin return new; end;'");
      await expect(db.query(reapply)).rejects.toMatchObject({ code: "55000" });
      await db.query("rollback to savepoint changed_definition");
      expect(await snapshot()).toEqual(first);
      // Matching names must not let a stale lifecycle receipt be overwritten.
      await db.query("savepoint changed_receipt");
      await db.query("update private.account_lifecycle_trigger_review set definition_hash=repeat('0',32) where kind='trigger' and schema_name='public' and table_name='member_chapter_memberships' and object_name='b15_clear_budget_office'");
      await expect(db.query(reapply)).rejects.toMatchObject({ code: "55000" });
      await db.query("rollback to savepoint changed_receipt");
      expect(await snapshot()).toEqual(first);
    } finally { await db.query("rollback").catch(() => {}); await db.end(); }
  }, 240_000);
  it("returns no budget access for an ordinary member without a second factor", async () => {
    await fixture(async ({as,one,org,chapter,people,refused}) => {
      expect(await one("select private.staff_mfa_required($1) v", [org])).toBe(true);
      expect(await one("select private.has_second_factor($1) v", [people.memberNoFactor.id])).toBe(false);
      await as("memberNoFactor", "aal1");
      expect(await one("select public.get_chapter_budget_access($1,$2,0) v", [org,chapter]))
        .toEqual({canRead:false,canAssign:false,members:[]});
      expect((await refused("select public.list_chapter_budgets($1,$2,0)", [org,chapter])).code).toBe("42501");
      expect((await refused("select public.save_chapter_budget($1,$2,null,0,'Private','2026-10-01','2026-10-31','', '[]')", [org,chapter])).code).toBe("42501");
      expect((await refused("select public.set_chapter_budget_office($1,$2,$3,'treasurer')", [org,chapter,people.memberNoFactor.id])).code).toBe("42501");
    });
  });
  it("still refuses the access probe for privileged callers without a second factor", async () => {
    await fixture(async ({db,as,org,chapter,people,refused,assign,owner}) => {
      await as("admin"); await assign("treasurer"); await owner();
      await db.query("delete from auth.mfa_factors where user_id = any($1::uuid[])", [[people.admin.id, people.president.id, people.officer.id]]);
      for (const name of ["admin", "president", "officer"]) {
        await as(name);
        expect((await refused("select public.get_chapter_budget_access($1,$2,0)", [org,chapter])).code).toBe("42501");
      }
    });
  });
  it("returns no budget access for a PIN member but still requires step-up for privileged callers", async () => {
    await fixture(async ({db,as,org,chapter,people,one,refused,assign,owner}) => {
      await as("admin"); await assign("treasurer"); await owner();
      await db.query("create or replace function private.member_pin_session_restricted() returns boolean language sql stable security definer set search_path='' as 'select true'");
      await as("member");
      expect(await one("select public.get_chapter_budget_access($1,$2,0) v", [org,chapter]))
        .toEqual({canRead:false,canAssign:false,members:[]});
      for (const name of ["member", "president", "admin", "officer"]) {
        await as(name);
        if (name !== "member") expect((await refused("select public.get_chapter_budget_access($1,$2,0)", [org,chapter])).message).toBe("step-up required");
        expect((await refused("select public.list_chapter_budgets($1,$2,0)", [org,chapter])).message).toBe("step-up required");
        expect((await refused("select public.save_chapter_budget($1,$2,null,0,'Private','2026-10-01','2026-10-31','', '[]')", [org,chapter])).message).toBe("step-up required");
        expect((await refused("select public.set_chapter_budget_office($1,$2,$3,'treasurer')", [org,chapter,people.officer.id])).message).toBe("step-up required");
      }
    });
  });
  it("refuses Treasurer and Secretary display titles without an explicit budget office", async () => {
    await fixture(async ({db,as,owner,org,chapter,people,one,refused,save}) => {
      await as("president"); const existing = await save();
      for (const [name,title] of [["titleTreasurer","Treasurer"],["titleSecretary","Secretary"]]) {
        await owner();
        expect((await db.query("select display_title, budget_office from public.member_chapter_memberships where user_id=$1 and chapter_id=$2", [people[name].id,chapter])).rows)
          .toEqual([{display_title:title,budget_office:null}]);
        await as(name);
        expect(await one("select public.get_chapter_budget_access($1,$2,0) v", [org,chapter]))
          .toEqual({canRead:false,canAssign:false,members:[]});
        expect((await refused("select public.list_chapter_budgets($1,$2,0)", [org,chapter])).code).toBe("42501");
        const write = "select public.save_chapter_budget($1,$2,$3,$4,'Title-only budget','2026-10-01','2026-10-31','', $5::jsonb)";
        for (const [id,revision] of [[null,0],[existing.id,existing.revision]]) {
          expect((await refused(write, [org,chapter,id,revision,JSON.stringify(existing.items)])).code).toBe("42501");
        }
      }
      await as("president");
      expect(await one("select public.list_chapter_budgets($1,$2,0) v", [org,chapter])).toEqual([existing]);
    });
  });

  it("lets each explicitly assigned office and this chapter's President read and write", async () => {
    await fixture(async ({as,assign,list,save}) => {
      await as("president"); const first=await save(); expect(first.revision).toBe(1);
      for (const office of ["treasurer","secretary_treasurer","secretary"]) {
        await as("admin"); await assign(office); await as("officer");
        expect((await list()).some((row) => row.id === first.id)).toBe(true); const saved=await save(); expect(saved.items[0].planned).toBe(125.25);
      }
    });
  });
  it("refuses ordinary members and direct table access while retaining Admin oversight", async () => {
    await fixture(async ({as,one,org,chapter,people,refused,save}) => {
      await as("president"); await save();
      for (const role of ["member"]) {
        await as(role); expect((await refused("select public.list_chapter_budgets($1,$2,0)",[org,chapter])).code).toBe("42501");
        expect((await refused("select public.save_chapter_budget($1,$2,null,0,'Private','2026-10-01','2026-10-31','', '[]')",[org,chapter])).code).toBe("42501");
        expect((await refused("select * from private.chapter_budgets")).code).toBe("42501");
      }
      await as("admin");
      expect((await one("select public.list_chapter_budgets($1,$2,0) v",[org,chapter])).length).toBe(1);
      expect((await save()).revision).toBe(1);
      expect((await refused("select * from private.chapter_budgets")).code).toBe("42501");
      await as("member"); expect((await refused("update public.member_chapter_memberships set budget_office='treasurer' where user_id=$1",[people.member.id])).code).toBe("42501");
      const access=await one("select public.get_chapter_budget_access($1,$2,0) v",[org,chapter]);
      expect(access).toEqual({canRead:false,canAssign:false,members:[]});
    });
  });
  it("binds reads and writes to the exact chapter and organization, excluding organization-wide role grants", async () => {
    await fixture(async ({db,as,owner,org,otherOrg,chapter,sibling,foreign,people,refused,save,list}) => {
      await as("president"); const budget=await save();
      expect((await refused("select public.list_chapter_budgets($1,$2,0)",[otherOrg,foreign])).code).toBe("42501");
      expect((await refused("select public.set_chapter_budget_office($1,$2,$3,'treasurer')",[org,sibling,people.officer.id])).code).toBe("42501");
      await owner(); await db.query("update public.member_profiles set chapter_id=$2 where id=$1",[people.president.id,sibling]);
      await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'vp',$2)",[org,people.president.id]);
      await as("president"); expect((await refused("select public.list_chapter_budgets($1,$2,0)",[org,sibling])).code).toBe("42501");
      await owner(); await db.query("update public.member_profiles set chapter_id=$2 where id=$1",[people.president.id,chapter]);
      await as("president"); expect((await list())[0].id).toBe(budget.id);
      await owner(); const foreignBudget=randomUUID();
      await db.query("insert into private.chapter_budgets(id,organization_id,chapter_id,title,period_start,period_end,items) values ($1,$2,$3,'Foreign financial contents','2026-10-01','2026-10-31',$4::jsonb)",[foreignBudget,otherOrg,foreign,JSON.stringify(budget.items)]);
      await as("president");
      expect((await refused("select public.save_chapter_budget($1,$2,$3,1,'Wrong budget','2026-10-01','2026-10-31','', $4::jsonb)",[org,chapter,foreignBudget,JSON.stringify(budget.items)])).code).toBe("PT409");
      expect((await refused("select public.save_chapter_budget($1,$2,$3,1,'Cross scope','2026-10-01','2026-10-31','', $4::jsonb)",[otherOrg,foreign,budget.id,JSON.stringify([{name:'Rent',planned:1,actual:1}])])).code).toBe("42501");
    });
  });
  it("refuses revoked offices, ended memberships, aal1 and PIN-restricted sessions", async () => {
    await fixture(async ({db,as,owner,org,chapter,people,refused,assign,save}) => {
      await as("admin"); await assign("treasurer"); await as("officer"); await save();
      await as("officer","aal1"); expect((await refused("select public.list_chapter_budgets($1,$2,0)",[org,chapter])).code).toBe("42501");
      await as("admin"); await assign(null); await as("officer");
      expect((await refused("select public.list_chapter_budgets($1,$2,0)",[org,chapter])).code).toBe("42501");
      await as("admin"); await assign("treasurer"); await owner();
      await db.query("update public.member_chapter_memberships set status='revoked', revoked_at=now() where user_id=$1 and chapter_id=$2",[people.officer.id,chapter]);
      await as("officer"); expect((await refused("select public.list_chapter_budgets($1,$2,0)",[org,chapter])).code).toBe("42501");
      await owner(); await db.query("update public.member_chapter_memberships set status='active', revoked_at=null where user_id=$1 and chapter_id=$2",[people.officer.id,chapter]);
      await as("officer"); expect((await refused("select public.list_chapter_budgets($1,$2,0)",[org,chapter])).code).toBe("42501");
      await owner();
      // The restricted-session predicate is replaced only inside this rollback
      // transaction; it proves every entry refuses before returning financial data.
      await db.query("create or replace function private.member_pin_session_restricted() returns boolean language sql stable security definer set search_path='' as 'select true'");
      await as("president"); expect((await refused("select public.list_chapter_budgets($1,$2,0)",[org,chapter])).message).toBe("step-up required");
    });
  });
  it("rejects stale writes and malformed amounts without changing the document or leaking financial audit data", async () => {
    await fixture(async ({as,save,org,chapter,one,refused}) => {
      await as("president"); const budget=await save(); await save(budget.id,1);
      const write="select public.save_chapter_budget($1,$2,$3,$4,'Test','2026-10-01','2026-10-31','', $5::jsonb)";
      expect((await refused(write,[org,chapter,budget.id,1,JSON.stringify(budget.items)])).code).toBe("PT409");
      for (const items of [[],[{name:"Bad",planned:1.001,actual:1}],[{name:"Bad",planned:"1",actual:1}],[{name:"Bad",planned:1,actual:1,extra:"private"}]]) {
        expect((await refused(write,[org,chapter,budget.id,2,JSON.stringify(items)])).code).toBe("22023");
      }
      expect((await one("select public.list_chapter_budgets($1,$2,0) v",[org,chapter]))[0].revision).toBe(2);
    });
  });
  it("caps lists at twenty plus a sentinel and pins RLS and content-free audit rows on the installed schema", async () => {
    await fixture(async ({db,as,owner,org,chapter,one,save}) => {
      await as("president"); for (let i=0;i<22;i+=1) await save();
      expect((await one("select public.list_chapter_budgets($1,$2,0) v",[org,chapter])).length).toBe(21);
      expect((await one("select public.list_chapter_budgets($1,$2,1) v",[org,chapter])).length).toBe(2);
      await owner();
      const relation=(await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='private.chapter_budgets'::regclass")).rows[0];
      expect(relation).toEqual({relrowsecurity:true,relforcerowsecurity:true});
      expect((await db.query("select * from private.account_lifecycle_referential_action_trigger_issues()")).rows).toEqual([]);
      const rows=(await db.query("select metadata from public.organization_audit_ledger where organization_id=$1 and event_type='chapter_budget_saved'",[org])).rows;
      expect(rows).toHaveLength(22); for (const row of rows) expect(row.metadata).toEqual({chapterId:chapter});
    });
  }, 90_000); // Catalog review is bounded by the fixture's 60s statement limit.
});
