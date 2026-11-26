// @vitest-environment node
//
// BUG-UG-LEGACY-CASE-UNCHANGED-CHAPTER-UPDATE-20261014. A legacy case
// (organization_id null) that already carries a chapter_id takes an unrelated
// update, and the ON DELETE SET NULL update a foreign key makes, because
// private.mi1_bind_case_owner() now refuses an UPDATE only when organization_id
// or chapter_id actually changes. Assigning, replacing or clearing legacy
// ownership, any change to organization-backed ownership, and the INSERT
// derivation rules still refuse as before.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readMigrationFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";

const MIGRATION = "20261017153000_legacy_case_unchanged_owner_update.sql";
const read = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
const migration = read(MIGRATION);
const md5 = (value) => createHash("md5").update(value).digest("hex");
const bodyOf = (sql) => sql.split("create function private.mi1_bind_case_owner()").at(-1)
  .split("create or replace function private.mi1_bind_case_owner()").at(-1)
  .split("as $function$")[1].split("$function$")[0];
const body = bodyOf(migration);
// Since BUG record #8784 the current definition is in the casework refusal
// migration: an owner whose chapter has no organization is refused (23514).
const CURRENT = "20261113142500_casework_refusals_equal_for_missing_and_foreign.sql";
const currentBody = bodyOf(read(CURRENT));
const original = bodyOf(read("20260822020000_mi1_w1_feature_persistence.sql"));
// The pre-repair definition exactly as production ran it, from the frozen
// residue-window relock capture (sha256 a0ca1edb...).
const relock = read("20261012010003_production_residue_window_relock.sql");
const preRepair = relock.match(/CREATE OR REPLACE FUNCTION private\.mi1_bind_case_owner\(\)[\s\S]*?\$function\$\n[\s\S]*?\$function\$\n/)[0];

describe("legacy case owner update migration (static)", () => {
  it("is the current definition of the case owner trigger function and the contract pins its body", () => {
    const latest = new Map(readMigrationFunctions("supabase/migrations").map((fn) => [fn.name, fn]));
    expect(latest.get("private.mi1_bind_case_owner")?.file).toBe(CURRENT);
    const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
    expect(contract.functions.find((row) => row.sig === "private.mi1_bind_case_owner()"))
      .toMatchObject({ secdef: true, exec: "", sourceMd5: md5(currentBody) });
  });

  it("keeps this repair's UPDATE branch in the current definition and refuses a chapter with no organization (#8784)", () => {
    const updateBranch = (text) => text.split("  select ch.organization_id, ch.id")[0];
    expect(updateBranch(currentBody)).toBe(updateBranch(body));
    expect(currentBody).toContain("if owner_chapter is null or owner_organization is null then\n    raise exception 'case owner requires a current organization chapter' using errcode = '23514';");
    expect(currentBody).not.toContain("legacy case ownership cannot be supplied by the caller");
  });

  it("changes only the UPDATE branch and keeps the INSERT derivation byte for byte", () => {
    const insertBranch = (text) => text.slice(text.indexOf("  select ch.organization_id, ch.id"));
    expect(insertBranch(body)).toBe(insertBranch(original));
    expect(body.split("  select ch.organization_id, ch.id")[0]).toBe(`
declare
  owner_organization uuid;
  owner_chapter text;
begin
  if tg_op = 'UPDATE' then
    if new.organization_id is distinct from old.organization_id
       or new.chapter_id is distinct from old.chapter_id then
      if old.organization_id is null then
        raise exception 'legacy case ownership requires an explicit backfill' using errcode = '42501';
      end if;
      raise exception 'case organization and chapter are immutable' using errcode = '42501';
    end if;
    return new;
  end if;

`);
    const code = stripComments(migration);
    expect(code).toMatch(/create or replace function private\.mi1_bind_case_owner\(\)\nreturns trigger\nlanguage plpgsql\nsecurity definer\nset search_path = ''/);
    expect(code).toContain("revoke all on function private.mi1_bind_case_owner() from public, anon, authenticated, service_role;");
    expect(code).toContain("private.account_lifecycle_referential_action_trigger_issues()");
    // No backfill, no trigger, table or grant change.
    expect(code).not.toMatch(/create trigger|drop trigger|alter table|update public\.member_cases|grant /i);
  });

  it("leaves the frozen residue-window substitution and relock capture untouched", () => {
    const sha = (text) => createHash("sha256").update(text).digest("hex");
    expect(sha(preRepair)).toBe("a0ca1edb107a57c44c488f3de3218a3d6c186314531e94283f46b8e3ab2e0933");
    // The repair is not the window's T7 body, so the relock's restore guard
    // preserves it with a warning instead of reinstating the pre-repair body.
    const f2 = read("20261012010001_production_residue_seed_lanes_unlock.sql");
    const t7 = f2.match(/CREATE OR REPLACE FUNCTION private\.mi1_bind_case_owner\(\)[\s\S]*?\$function\$\n[\s\S]*?\$function\$\n/)[0];
    expect(sha(t7)).toBe("af617c6391d5a4476a2f173e8e3e6a7bb97cb249bb31e2f5890bba8e0f615070");
    expect(t7.split("AS $function$")[1].split("$function$")[0]).not.toBe(body);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("legacy case owner updates on a disposable database", () => {
  let c;
  let w;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "legacy-case-owner-update-proof" });
    await c.connect();
  });
  afterAll(async () => { await c?.end(); });

  async function refuses(sql, values, message, code = "42501") {
    await c.query("savepoint refused");
    await expect(c.query(sql, values)).rejects.toMatchObject({ code, message });
    await c.query("rollback to savepoint refused");
  }
  async function account(label) {
    const id = randomUUID();
    await c.query("insert into auth.users(id,email) values ($1,$2)", [id, `${label}-${id}@example.invalid`]);
    return id;
  }
  async function member(label, chapter) {
    const id = await account(label);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [w.org, id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [id, chapter]);
    await c.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapter]);
    return id;
  }
  // A case written before organizations existed: no organization, and either
  // a chapter or none. It cannot be created through the trigger today, so the
  // fixture writes it with only that trigger disabled, inside the transaction.
  async function legacyCase(chapter, coordinator = null) {
    const id = randomUUID();
    await c.query("alter table public.member_cases disable trigger member_cases_bind_organization");
    await c.query(
      `insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,coordinator_user_id)
       values ($1,$2,$3,'Legacy grievance','grievance',null,$4,$5)`,
      [id, w.member, `LEGACY-${id.slice(0, 8)}`, chapter, coordinator]);
    await c.query("alter table public.member_cases enable trigger member_cases_bind_organization");
    return id;
  }
  const owner = async (id) => (await c.query("select organization_id, chapter_id, coordinator_user_id, title from public.member_cases where id=$1", [id])).rows[0];

  beforeEach(async () => {
    await c.query("begin");
    w = { org: randomUUID() };
    w.chapter = `legacy-case-${w.org.slice(0, 8)}`;
    w.other = `legacy-case-other-${w.org.slice(0, 8)}`;
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [w.org, w.chapter]);
    for (const chapter of [w.chapter, w.other]) {
      await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98276)", [chapter, w.org]);
    }
    w.member = await member("member", w.chapter);
  });
  afterEach(async () => { await c.query("rollback"); });

  it("refused an unrelated update and the FK SET NULL update before the repair", async () => {
    const coordinator = await account("coordinator");
    const id = await legacyCase(w.chapter, coordinator);
    await c.query(preRepair);
    await refuses("update public.member_cases set title='Edited' where id=$1", [id], "legacy case ownership requires an explicit backfill");
    await refuses("delete from auth.users where id=$1", [coordinator], "legacy case ownership requires an explicit backfill");
  });

  it("lets a legacy case with a chapter take an unrelated update", async () => {
    const id = await legacyCase(w.chapter);
    await c.query("update public.member_cases set title='Edited', step='Step 2' where id=$1", [id]);
    // Writing the same ownership values back is not a change.
    await c.query("update public.member_cases set organization_id=null, chapter_id=$2 where id=$1", [id, w.chapter]);
    expect(await owner(id)).toEqual({ organization_id: null, chapter_id: w.chapter, coordinator_user_id: null, title: "Edited" });
  });

  it("lets a real ON DELETE SET NULL foreign key update a legacy case with a chapter", async () => {
    const coordinator = await account("coordinator");
    const id = await legacyCase(w.chapter, coordinator);
    await c.query("delete from auth.users where id=$1", [coordinator]);
    expect(await owner(id)).toEqual({ organization_id: null, chapter_id: w.chapter, coordinator_user_id: null, title: "Legacy grievance" });
  });

  it("still refuses assigning, replacing or clearing legacy ownership", async () => {
    const chaptered = await legacyCase(w.chapter);
    const message = "legacy case ownership requires an explicit backfill";
    await refuses("update public.member_cases set organization_id=$2 where id=$1", [chaptered, w.org], message);
    await refuses("update public.member_cases set chapter_id=$2 where id=$1", [chaptered, w.other], message);
    await refuses("update public.member_cases set chapter_id=null where id=$1", [chaptered], message);
    await refuses("update public.member_cases set organization_id=$2, chapter_id=$3, title='Edited' where id=$1", [chaptered, w.org, w.chapter], message);
    // Since #8784 no case can be stored without a chapter, even with the
    // binding trigger off: member_cases_chapter_present refuses it.
    await c.query("savepoint chapterless_legacy");
    await expect(legacyCase(null)).rejects.toMatchObject({ code: "23514", constraint: "member_cases_chapter_present" });
    await c.query("rollback to savepoint chapterless_legacy");
    expect(await owner(chaptered)).toMatchObject({ organization_id: null, chapter_id: w.chapter });
  });

  it("keeps an organization-backed case's ownership immutable and its unrelated updates working", async () => {
    const id = (await c.query(
      "insert into public.member_cases(user_id,reference,title,case_type) values ($1,'OWNED-1','Owned grievance','grievance') returning id",
      [w.member])).rows[0].id;
    expect(await owner(id)).toMatchObject({ organization_id: w.org, chapter_id: w.chapter });
    await c.query("update public.member_cases set title='Edited' where id=$1", [id]);
    const message = "case organization and chapter are immutable";
    await refuses("update public.member_cases set chapter_id=$2 where id=$1", [id, w.other], message);
    await refuses("update public.member_cases set chapter_id=null where id=$1", [id], message);
    await refuses("update public.member_cases set organization_id=null where id=$1", [id], message);
    await refuses("update public.member_cases set organization_id=$2 where id=$1", [id, randomUUID()], message);
    expect(await owner(id)).toMatchObject({ organization_id: w.org, chapter_id: w.chapter, title: "Edited" });
  });

  it("keeps the INSERT derivation and its refusals", async () => {
    const insert = "insert into public.member_cases(user_id,reference,title,case_type,organization_id,chapter_id) values ($1,$2,'New','grievance',$3,$4) returning organization_id, chapter_id";
    expect((await c.query(insert, [w.member, "NEW-1", null, null])).rows[0]).toEqual({ organization_id: w.org, chapter_id: w.chapter });
    expect((await c.query(insert, [w.member, "NEW-2", w.org, w.chapter])).rows[0]).toEqual({ organization_id: w.org, chapter_id: w.chapter });
    await refuses(insert, [w.member, "NEW-3", randomUUID(), null], "case organization is derived from the member chapter");
    await refuses(insert, [w.member, "NEW-4", null, w.other], "case chapter is derived from the member profile");
    const chapterless = await account("chapterless");
    await refuses(insert, [chapterless, "NEW-5", null, null], "case owner requires a current organization chapter", "23514");
  });

  // BUG record #8784: an owner whose chapter has no organization used to get a
  // case stored with no chapter, which the advisor overview never counted.
  it("refuses a case for an owner whose chapter has no organization, and the advisor overview count does not move (#8784)", async () => {
    const orphan = `legacy-orphan-${w.org.slice(0, 8)}`;
    // A retained chapter with no organization: current writers refuse to make
    // one, so the fixture writes it in replica mode and restores it at once.
    const stranded = await account("stranded");
    await c.query("set local session_replication_role = replica");
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,null,98277)", [orphan]);
    await c.query("update public.member_profiles set chapter_id=$2 where id=$1", [stranded, orphan]);
    await c.query("set local session_replication_role = origin");
    const counts = async () => (await c.query(`select pg_catalog.count(*)::integer as all_cases,
        pg_catalog.count(*) filter (where chapter_id is null or pg_catalog.btrim(chapter_id) = '')::integer as chapterless
      from public.member_cases`)).rows[0];
    // The chapter's advisor reads the advisor overview (an MFA session).
    const advisor = await member("advisor", w.chapter);
    const session = randomUUID();
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, advisor]);
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), advisor]);
    await c.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'advisor',$2)", [advisor, w.chapter]);
    await c.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'advisor',$2)", [advisor, w.chapter]);
    const overview = async () => {
      await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: advisor, session_id: session, aal: "aal2", role: "authenticated" })]);
      await c.query("set local role authenticated");
      try {
        return (await c.query("select public.get_advisor_overview() as value")).rows[0].value;
      } finally {
        await c.query("reset role");
        await c.query("select set_config('request.jwt.claims','',true)");
      }
    };
    const before = await counts();
    const seen = await overview();
    const insert = "insert into public.member_cases(user_id,reference,title,case_type,organization_id,chapter_id) values ($1,$2,'Stranded','grievance',$3,$4)";
    await refuses(insert, [stranded, "ORPHAN-1", null, null], "case owner requires a current organization chapter", "23514");
    await refuses(insert, [stranded, "ORPHAN-2", null, orphan], "case owner requires a current organization chapter", "23514");
    expect(await counts()).toEqual(before);
    expect(before.chapterless).toBe(0);
    expect(typeof seen.openGrievances).toBe("number");
    expect(await overview()).toEqual(seen);
    // A case for the chapter's own member still lands, with its chapter.
    const landed = (await c.query(`${insert} returning organization_id, chapter_id`, [w.member, "ORPHAN-3", null, null])).rows[0];
    expect(landed).toEqual({ organization_id: w.org, chapter_id: w.chapter });
  });

  it("stays a non-executable SECURITY DEFINER trigger function with an empty search_path and a reviewed lifecycle surface", async () => {
    const fn = (await c.query(`select p.prosecdef, p.proconfig, md5(p.prosrc) as source_md5,
        pg_catalog.has_function_privilege('anon', p.oid, 'execute') as anon,
        pg_catalog.has_function_privilege('authenticated', p.oid, 'execute') as authed,
        pg_catalog.has_function_privilege('service_role', p.oid, 'execute') as service
      from pg_catalog.pg_proc p where p.oid = 'private.mi1_bind_case_owner()'::regprocedure`)).rows[0];
    expect(fn).toEqual({ prosecdef: true, proconfig: ['search_path=""'], source_md5: md5(currentBody), anon: false, authed: false, service: false });
    const trigger = (await c.query(`select t.tgname, t.tgenabled from pg_catalog.pg_trigger t
      where t.tgrelid = 'public.member_cases'::regclass and t.tgfoid = 'private.mi1_bind_case_owner()'::regprocedure`)).rows;
    expect(trigger).toEqual([{ tgname: "member_cases_bind_organization", tgenabled: "O" }]);
    expect((await c.query("select * from private.account_lifecycle_referential_action_trigger_issues()")).rows).toEqual([]);
  }, 120000);
});
