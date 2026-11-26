// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName } from "./helpers/migration.js";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

it("places the reserved article migration after 20261105173000 and replaces the old RPC grant", () => {
  expect(findMigrationName("case_contract_articles") > "20261105173000").toBe(true);
  expect(findMigrationName("case_article_write_intent_and_audit_scope") > findMigrationName("case_contract_articles")).toBe(true);
  const contract = JSON.parse(readFileSync("scripts/db-contract.json", "utf8"));
  const entries = contract.functions.filter((fn) => fn.sig.startsWith("public.coordinator_update_case("));
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ sig: "public.coordinator_update_case(p_case_id uuid, p_status text, p_step text, p_deadline date, p_reason text, p_articles text)", exec: "authenticated" });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("case articles through the existing staff update RPC", () => {
  let client, caseId;
  const id = Object.fromEntries(["org", "foreignOrg", "member", "steward", "coordinator", "outsider", "foreign", "memberSession", "stewardSession", "coordinatorSession", "outsiderSession", "foreignSession"].map((name) => [name, randomUUID()]));
  const chapter = `test-articles-${id.org}`;
  const foreignChapter = `test-articles-${id.foreignOrg}`;
  const act = async (name, aal = "aal2") => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "authenticated", sub: id[name], session_id: id[`${name}Session`], aal })]);
    await client.query("set local role authenticated");
  };
  const attempt = async (sql, params = []) => {
    await client.query("savepoint article_attempt");
    try {
      const result = await client.query(sql, params);
      await client.query("release savepoint article_attempt");
      return { ok: true, rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint article_attempt");
      return { ok: false, code: error.code };
    }
  };
  const update = (articles, status = "active", deadline = "2026-12-01") => attempt("select public.coordinator_update_case($1,$2,null,$3,'Correct contract reference',$4) as result", [caseId, status, deadline, articles]);
  const stored = async () => {
    await client.query("reset role");
    return (await client.query("select articles,status,deadline::text from public.member_cases where id=$1", [caseId])).rows[0];
  };
  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "case-articles-proof" });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout='60s'");
    await client.query("set local lock_timeout='10s'");
    for (const person of ["member", "steward", "coordinator", "outsider", "foreign"]) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [id[person], `${id[person]}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [id[`${person}Session`], id[person]]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic article factor','totp','verified',now(),now())", [randomUUID(), id[person]]);
    }
    for (const [org, ch] of [[id.org, chapter], [id.foreignOrg, foreignChapter]]) {
      await client.query("insert into public.organizations(id,slug,name) values($1,$2,$2)", [org, ch]);
      await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9907)", [ch, org]);
      await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [org]);
    }
    for (const person of ["member", "steward", "coordinator", "outsider", "foreign"]) {
      const org = person === "foreign" ? id.foreignOrg : id.org;
      const ch = person === "foreign" ? foreignChapter : chapter;
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, id[person]]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id[person], ch]);
      await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id[person], ch]);
      if (person !== "member") {
        const role = person === "coordinator" ? "coordinator" : "steward";
        await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$2)", [org, id[person], role]);
        await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing", [id[person], role, ch]);
      }
    }
    // #8589 re-final: committed data gives every steward grant its migration
    // assignments; an organization grant reaches only chapters it has one in.
    await migrateLegacyStewardFixtures(client);
  });
  beforeEach(async () => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims','{}',true)");
    await client.query("savepoint article_test");
    caseId = randomUUID();
    await client.query("insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,steward_user_id,status,deadline,articles) values($1,$2,$3,'Contract review','other',$4,$5,$6,'active','2026-12-01','Article 12')", [caseId, id.member, `TEST-${caseId}`, id.org, chapter, id.steward]);
  });
  afterEach(async () => { await client.query("rollback to savepoint article_test"); await client.query("reset role"); });
  afterAll(async () => { if (client) { await client.query("rollback"); await client.end(); } });

  it("editor sets articles with whitespace trimmed", async () => {
    await act("steward");
    expect(await update("  Article 3 · Article 7  ")).toMatchObject({ ok: true, rows: [{ result: { articles: "Article 3 · Article 7" } }] });
    expect((await stored()).articles).toBe("Article 3 · Article 7");
  });
  it("editor clears all articles with a trimmed empty string", async () => {
    await act("steward");
    expect(await update("   ")).toMatchObject({ ok: true });
    expect((await stored()).articles).toBe("");
  });
  it("editor preserves articles on explicit null", async () => {
    await act("steward");
    expect(await update(null)).toMatchObject({ ok: true });
    expect((await stored()).articles).toBe("Article 12");
  });
  it("keeps omitted articles for old five-argument coordinator callers", async () => {
    await act("coordinator");
    expect(await attempt("select public.coordinator_update_case($1,'active',null,'2026-12-02','Deadline extended')", [caseId])).toMatchObject({ ok: true });
    expect(await stored()).toMatchObject({ articles: "Article 12", deadline: "2026-12-02" });
  });
  it.each([null, "Article 12"])("keeps unrelated coordinator reasons private when articles are %s", async (articles) => {
    await act("coordinator");
    expect(await attempt("select public.coordinator_update_case($1,'active',null,'2026-12-02','Coordinator-only deliberation',$2)", [caseId, articles])).toMatchObject({ ok: true });
    await act("steward");
    expect((await client.query("select reason from public.coordinator_case_audit where case_id=$1", [caseId])).rows).toEqual([]);
    expect((await client.query("select details from public.casework_case_history($1,50,null) where kind='coordinator'", [caseId])).rows).toEqual([]);
    expect((await client.query("select public.list_coordinator_case_audit(p_case_id=>$1) as audit", [caseId])).rows[0].audit).toEqual([]);
  });
  it("does not use an articles key as authority to read legacy unchanged or mixed audits", async () => {
    for (const [oldArticles, newArticles, oldStatus, newStatus] of [["Article 12", "Article 12", "active", "active"], ["Article 12", "Article 3", "active", "resolved"]]) {
      await client.query("insert into public.coordinator_case_audit(case_id,user_id,actor_id,action,before_value,after_value,reason) values($1,$2,$3,'case_updated',$4,$5,'Private coordinator reason')", [caseId, id.member, id.coordinator, { status: oldStatus, step: "Intake", deadline: "2026-12-01", articles: oldArticles }, { status: newStatus, step: "Intake", deadline: "2026-12-01", articles: newArticles }]);
    }
    await act("steward");
    expect((await client.query("select reason from public.coordinator_case_audit where case_id=$1", [caseId])).rows).toEqual([]);
    expect((await client.query("select details from public.casework_case_history($1,50,null) where kind='coordinator'", [caseId])).rows).toEqual([]);
    expect((await client.query("select public.list_coordinator_case_audit(p_case_id=>$1) as audit", [caseId])).rows[0].audit).toEqual([]);
    await act("coordinator");
    expect((await client.query("select reason from public.coordinator_case_audit where case_id=$1", [caseId])).rows).toHaveLength(2);
  });
  it("includes article audit fields only when the stored article value changes", async () => {
    await act("coordinator");
    expect(await update(null)).toMatchObject({ ok: true });
    const audit = (await client.query("select before_value,after_value from public.coordinator_case_audit where case_id=$1", [caseId])).rows[0];
    expect(audit.before_value).not.toHaveProperty("articles");
    expect(audit.after_value).not.toHaveProperty("articles");
  });
  it("partial coordinator status/deadline updates preserve all omitted values", async () => {
    await act("coordinator");
    expect(await attempt("select public.coordinator_update_case(p_case_id=>$1,p_status=>'resolved',p_reason=>'Resolve intentionally')", [caseId])).toMatchObject({ ok: true });
    expect(await stored()).toMatchObject({ status: "resolved", deadline: "2026-12-01", articles: "Article 12" });
    await act("coordinator");
    expect(await attempt("select public.coordinator_update_case(p_case_id=>$1,p_deadline=>'2026-12-03',p_reason=>'Extend intentionally')", [caseId])).toMatchObject({ ok: true });
    expect(await stored()).toMatchObject({ status: "resolved", deadline: "2026-12-03", articles: "Article 12" });
    await act("coordinator");
    expect(await attempt("select public.coordinator_update_case(p_case_id=>$1,p_deadline=>null,p_reason=>'Cannot clear a deadline')", [caseId])).toMatchObject({ ok: false, code: "22023" });
  });
  it.each(["member", "outsider", "foreign"])("refuses non-editor %s without changing the case or audit", async (person) => {
    await act(person);
    expect(await update("Article 3")).toMatchObject({ ok: false, code: "42501" });
    expect((await stored()).articles).toBe("Article 12");
    expect((await client.query("select count(*)::int n from public.coordinator_case_audit where case_id=$1", [caseId])).rows[0].n).toBe(0);
  });
  it("refuses an unassigned steward on a restricted case", async () => {
    await act("coordinator");
    await client.query("reset role");
    await client.query("update public.member_cases set is_restricted=true,restriction_reason='Private case',restricted_by=$2,restricted_at=now() where id=$1", [caseId, id.coordinator]);
    await act("outsider");
    expect(await update("Article 3")).toMatchObject({ ok: false, code: "42501" });
  });
  it("requires MFA and enforces the 500-character bound", async () => {
    await act("steward", "aal1");
    expect(await update("Article 3")).toMatchObject({ ok: false, code: "42501" });
    await act("steward");
    expect(await update("a".repeat(501))).toMatchObject({ ok: false, code: "22023" });
  });
  it("does not let the article branch change status, deadline or step", async () => {
    await act("steward");
    expect(await update("Article 3", "resolved")).toMatchObject({ ok: false, code: "42501" });
    expect(await update("Article 3", "active", "2026-12-02")).toMatchObject({ ok: false, code: "42501" });
    expect(await attempt("select public.coordinator_update_case($1,'active','Step 2','2026-12-01','Incorrect step edit','Article 3')", [caseId])).toMatchObject({ ok: false, code: "42501" });
    expect(await stored()).toMatchObject({ articles: "Article 12", status: "active", deadline: "2026-12-01" });
  });
  it("exposes the before/after article audit through the existing staff history RPC", async () => {
    await act("steward");
    expect(await update("Article 3")).toMatchObject({ ok: true });
    const history = await client.query("select details from public.casework_case_history($1,50,null) where kind='coordinator'", [caseId]);
    expect(history.rows).toEqual(expect.arrayContaining([{ details: expect.objectContaining({ action: "case_updated", before: expect.objectContaining({ articles: "Article 12" }), after: expect.objectContaining({ articles: "Article 3" }) }) }]));
    for (const person of ["member", "outsider", "foreign"]) {
      await act(person);
      expect((await client.query("select id from public.coordinator_case_audit where case_id=$1", [caseId])).rows).toEqual([]);
    }
  });
  it("grants only authenticated execution and removes the obsolete overload", async () => {
    const result = await client.query("select to_regprocedure('public.coordinator_update_case(uuid,text,text,date,text)') old, has_function_privilege('anon','public.coordinator_update_case(uuid,text,text,date,text,text)','execute') anon, has_function_privilege('authenticated','public.coordinator_update_case(uuid,text,text,date,text,text)','execute') authenticated, has_function_privilege('service_role','public.coordinator_update_case(uuid,text,text,date,text,text)','execute') service");
    expect(result.rows[0]).toEqual({ old: null, anon: false, authenticated: true, service: false });
  });
});
