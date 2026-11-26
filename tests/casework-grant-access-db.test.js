// @vitest-environment node
//
// BUG-UG-WEB-CASE-GRANT-ACCESS-ALWAYS-FAILS-20261003
//
// public.casework_access_grants.reason is required (8 to 500 characters after
// trimming), but public.casework_grant_access(p_case_id, p_grantee_user_id)
// never supplied it, so every Grant access on a restricted case failed with a
// NOT NULL violation and nobody could be let into one. The repair replaces it
// with casework_grant_access(p_case_id, p_grantee_user_id, p_reason), which
// refuses a missing or out-of-range reason with 22023 and the translated
// detail token, and saves the trimmed reason on the grant row. A grant only
// lets in staff who reach the member through the coordinator hat, so a grantee
// without the coordinator role (a plain steward) is refused with 22023 and
// casework_grantee_cannot_use_grant instead of receiving a grant that never
// opens the case.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { TRANSLATED_RPC_TOKENS } from "../src/lib/rpcErrorText.js";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const GRANT = "public.casework_grant_access(p_case_id uuid, p_grantee_user_id uuid, p_reason text)";
// REQ-UG-LEARNING-PERIOD-CASE-ACCESS-ASSIGNMENT-20261103 (20261104120000) moved the grantee
// rule, unchanged, into this helper so the learning-period undo of a revoke rechecks the same rule.
const GRANTEE_RULE = "private.casework_require_case_access_grantee(p_case_id uuid, p_grantee_user_id uuid)";
const OLD_GRANT = "public.casework_grant_access(p_case_id uuid, p_grantee_user_id uuid)";
const TOKEN = "casework_grant_reason_invalid";
const GRANTEE_TOKEN = "casework_grantee_cannot_use_grant";
const sql = stripComments(loadMigrationSql("casework_grant_access_reason"));
// BUG-UG-GRANTING-RESTRICTED-CASE-ACCESS-COORDINATOR-CHOSEN-CHAPTER-SAVES-20261013
const REACH_TOKEN = "casework_grantee_outside_case_organization";
const reachSql = stripComments(loadMigrationSql("casework_grant_access_grantee_reach"));

describe("casework grant access reason contract", () => {
  it("replaces the two-argument grant with one that takes and checks the reason", () => {
    expect(findMigrationName("casework_grant_access_reason") > findMigrationName("20260907151000_account_deletion_finalization_reconciliation")).toBe(true);
    expect(sql).toContain("drop function public.casework_grant_access(uuid, uuid);");
    expect(sql).toContain("create function public.casework_grant_access(p_case_id uuid, p_grantee_user_id uuid, p_reason text)");
    expect(sql).toMatch(/char_length\(pg_catalog\.btrim\(coalesce\(p_reason, ''\)\)\) not between 8 and 500/);
    expect(sql).toContain(`using errcode = '22023', detail = '${TOKEN}'`);
    expect(sql).toContain(`using errcode = '22023', detail = '${GRANTEE_TOKEN}'`);
    expect(sql).toMatch(/insert into public\.casework_access_grants\(case_id, organization_id, chapter_id, grantee_user_id, granted_by, reason\)/);
    // The grant takes the case-graph gate before anything else, like the
    // reviewed writer it replaces.
    expect(sql).toContain("perform private.lock_case_graph(");
    expect(TRANSLATED_RPC_TOKENS.has(TOKEN)).toBe(true);
    expect(TRANSLATED_RPC_TOKENS.has(GRANTEE_TOKEN)).toBe(true);
  });

  it("refuses grantees the restricted-case read rule cannot admit, before anything is written", () => {
    expect(findMigrationName("casework_grant_access_grantee_reach") > findMigrationName("casework_grant_access_reason")).toBe(true);
    expect(reachSql).toContain("where p.oid = 'public.casework_grant_access(uuid, uuid, text)'::regprocedure;");
    expect(reachSql).toContain("create or replace function public.casework_grant_access(p_case_id uuid, p_grantee_user_id uuid, p_reason text)");
    expect(reachSql).toContain("private.member_organization_for(p_grantee_user_id) is distinct from v_member_org");
    expect(reachSql).toContain("where g.organization_id = v_member_org and g.user_id = p_grantee_user_id and g.role = 'coordinator'");
    // The read rule never compares either organization with the case's.
    expect(reachSql).not.toMatch(/is distinct from v_case\.organization_id/);
    expect(reachSql).toContain(`using errcode = '22023', detail = '${REACH_TOKEN}'`);
    // The refusal comes before the idempotent return and every write.
    const refusal = reachSql.indexOf(`detail = '${REACH_TOKEN}'`);
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(reachSql.indexOf("if found then return v_row; end if;"));
    expect(refusal).toBeLessThan(reachSql.indexOf("insert into public.casework_access_grants"));
    expect(reachSql).toContain("grant execute on function public.casework_grant_access(uuid, uuid, text) to authenticated;");
    expect(TRANSLATED_RPC_TOKENS.has(REACH_TOKEN)).toBe(true);
    const entry = contract.functions.find((fn) => fn.sig === GRANTEE_RULE);
    expect(entry.bodyContains).toEqual(expect.arrayContaining([`detail = '${REACH_TOKEN}'`, "private.member_organization_for(p_grantee_user_id)"]));
    expect(contract.functions.find((fn) => fn.sig === GRANT).bodyContains).toContain("perform private.casework_require_case_access_grantee(v_case.id, p_grantee_user_id);");
  });

  it("pins the new signature in the database contract and drops the old one", () => {
    const entry = contract.functions.find((fn) => fn.sig === GRANT);
    expect(entry).toBeDefined();
    expect(entry.secdef).toBe(true);
    expect(entry.exec).toBe("authenticated");
    expect(entry.bodyContains).toEqual(expect.arrayContaining(["private.casework_require_mfa()", `detail = '${TOKEN}'`, "'access_granted'"]));
    expect(contract.functions.find((fn) => fn.sig === GRANTEE_RULE).bodyContains).toContain(`detail = '${GRANTEE_TOKEN}'`);
    expect(entry.bodyMd5).toMatch(/^[0-9a-f]{32}$/);
    expect(contract.functions.find((fn) => fn.sig === OLD_GRANT)).toBeUndefined();
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("granting explicit access to a restricted case (disposable database)", () => {
  let client;
  const id = Object.fromEntries([
    "member", "coordinator", "colleague", "outsider", "steward", "memberSession", "coordinatorSession", "colleagueSession", "outsiderSession", "stewardSession",
    "org", "restrictedCase",
  ].map((key) => [key, randomUUID()]));
  const chapter = `case-grant-${id.org}`;

  const act = async (actor, session) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
  };

  const attempt = async (text, params = []) => {
    await client.query("savepoint grant_attempt");
    try {
      const result = await client.query(text, params);
      await client.query("release savepoint grant_attempt");
      return { ok: true, rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint grant_attempt");
      return { ok: false, code: error.code, detail: error.detail, message: error.message };
    }
  };

  const asOwner = async (text, params = []) => {
    await client.query("reset role");
    return (await client.query(text, params)).rows;
  };

  const grantsFor = (grantee) => asOwner(
    "select reason, granted_by from public.casework_access_grants where case_id = $1 and grantee_user_id = $2 and revoked_at is null",
    [id.restrictedCase, grantee],
  );

  const visibleCases = async (actor, session) => {
    await act(actor, session);
    return (await client.query("select count(*)::int as n from public.member_cases where id = $1", [id.restrictedCase])).rows[0].n;
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "casework-grant-access-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    const people = [
      [id.member, id.memberSession, "Grant Proof Member"],
      [id.coordinator, id.coordinatorSession, "Grant Proof Coordinator"],
      [id.colleague, id.colleagueSession, "Grant Proof Colleague"],
      [id.outsider, id.outsiderSession, "Grant Proof Outsider"],
      [id.steward, id.stewardSession, "Grant Proof Steward"],
    ];
    for (const [user, session] of people) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic grant factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [id.org, `case-grant-${id.org}`, id.coordinator]);
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9904)", [chapter, id.org]);
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [id.org]);
    for (const [user, , name] of people) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, user]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
      await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user, chapter, name]);
    }
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)", [id.org, id.coordinator]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$3)", [id.org, id.colleague, id.coordinator]);
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'coordinator',$2) on conflict do nothing", [id.coordinator, chapter]);
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'coordinator',$2) on conflict do nothing", [id.colleague, chapter]);
    // A plain chapter steward, not assigned to the case: active chapter staff,
    // but the restricted-case rule never admits her through a grant.
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$3)", [id.org, id.steward, id.coordinator]);
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'steward',$2) on conflict do nothing", [id.steward, chapter]);
    // The restricted case is assigned to the coordinator only. The colleague is
    // a chapter coordinator with no assignment and no grant: the coordinator
    // hat reaches the member, and the restriction is what keeps her out until
    // she is granted access.
    await client.query(
      `insert into public.member_cases(
         id,user_id,reference,title,case_type,organization_id,chapter_id,coordinator_user_id,
         is_restricted,restriction_reason,restricted_at,restricted_by)
       values($1,$2,'CASE-GRANT-RESTRICTED','CASE-GRANT-RESTRICTED','other',$3,$4,$5,true,'sensitive witness statements',now(),$5)`,
      [id.restrictedCase, id.member, id.org, chapter, id.coordinator],
    );

    //  re-final: committed data gives every steward grant its migration

    // assignments; an organization grant reaches only chapters it has one in.

    await migrateLegacyStewardFixtures(client);
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("leaves only the three-argument grant, callable by signed-in staff and not by anon", async () => {
    const rows = await asOwner(
      `select to_regprocedure('public.casework_grant_access(uuid,uuid)') is null as old_gone,
              has_function_privilege('authenticated', 'public.casework_grant_access(uuid,uuid,text)', 'execute') as staff,
              has_function_privilege('anon', 'public.casework_grant_access(uuid,uuid,text)', 'execute') as anon`,
    );
    expect(rows[0]).toEqual({ old_gone: true, staff: true, anon: false });
  });

  it("refuses a missing, short or overlong reason with 22023 and the translated token, never a NOT NULL error", async () => {
    expect(await visibleCases(id.colleague, id.colleagueSession)).toBe(0);
    expect((await client.query("select private.casework_can_read($1) as ok", [id.restrictedCase])).rows[0].ok).toBe(false);
    await act(id.coordinator, id.coordinatorSession);
    for (const reason of [null, "", "   ", "  Brief  ", "Seven c", "x".repeat(501)]) {
      const refused = await attempt("select public.casework_grant_access($1, $2, $3)", [id.restrictedCase, id.colleague, reason]);
      expect(refused, JSON.stringify(reason)).toMatchObject({ ok: false, code: "22023", detail: TOKEN });
    }
    expect(await grantsFor(id.colleague)).toEqual([]);
    expect(await visibleCases(id.colleague, id.colleagueSession)).toBe(0);
  });

  it("saves the trimmed reason, audits the grant without the free text and lets the grantee open the case", async () => {
    await act(id.coordinator, id.coordinatorSession);
    const granted = await attempt(
      "select (g).grantee_user_id, (g).reason from public.casework_grant_access($1, $2, $3) g",
      [id.restrictedCase, id.colleague, "  Preparing the step 2 meeting with the member  "],
    );
    expect(granted.ok, granted.message).toBe(true);
    expect(granted.rows[0]).toEqual({ grantee_user_id: id.colleague, reason: "Preparing the step 2 meeting with the member" });
    expect(await grantsFor(id.colleague)).toEqual([{ reason: "Preparing the step 2 meeting with the member", granted_by: id.coordinator }]);
    const audit = await asOwner(
      "select metadata from public.casework_audit_events where case_id = $1 and event_type = 'access_granted'",
      [id.restrictedCase],
    );
    expect(audit).toEqual([{ metadata: { granteeUserId: id.colleague } }]);
    expect(await visibleCases(id.colleague, id.colleagueSession)).toBe(1);
    expect((await client.query("select private.casework_can_read($1) as ok", [id.restrictedCase])).rows[0].ok).toBe(true);

    // A repeated grant returns the active row instead of adding another.
    await act(id.coordinator, id.coordinatorSession);
    const repeated = await attempt("select (g).reason from public.casework_grant_access($1, $2, $3) g", [id.restrictedCase, id.colleague, "A different, later reason"]);
    expect(repeated).toMatchObject({ ok: true, rows: [{ reason: "Preparing the step 2 meeting with the member" }] });
    expect(await grantsFor(id.colleague)).toHaveLength(1);
  });

  it("keeps refusing callers who may not manage the case and grantees who are not chapter staff", async () => {
    await act(id.outsider, id.outsiderSession);
    expect(await attempt("select public.casework_grant_access($1, $2, $3)", [id.restrictedCase, id.colleague, "An outsider trying to grant"]))
      .toMatchObject({ ok: false, code: "P0002" });
    await act(id.coordinator, id.coordinatorSession);
    expect(await attempt("select public.casework_grant_access($1, $2, $3)", [id.restrictedCase, id.member, "The member is not chapter staff"]))
      .toMatchObject({ ok: false, code: "22023" });
    expect(await grantsFor(id.member)).toEqual([]);
  });

  it("refuses a grant to a plain steward, whom the restricted-case rule would never let in", async () => {
    expect(await visibleCases(id.steward, id.stewardSession)).toBe(0);
    await act(id.coordinator, id.coordinatorSession);
    expect(await attempt("select public.casework_grant_access($1, $2, $3)", [id.restrictedCase, id.steward, "Covering the step 1 meeting"]))
      .toMatchObject({ ok: false, code: "22023", detail: GRANTEE_TOKEN });
    expect(await grantsFor(id.steward)).toEqual([]);
    expect(await asOwner("select count(*)::int as n from public.casework_audit_events where case_id = $1 and metadata->>'granteeUserId' = $2", [id.restrictedCase, id.steward]))
      .toEqual([{ n: 0 }]);
  });

  // An organization coordinator with no selected active
  // chapter is chapter staff through the organization grant, but
  // staff_can_see_user needs an active organization, so the grant opened nothing.
  it("refuses an organization coordinator with no selected active chapter", async () => {
    const chapterless = randomUUID();
    const chapterlessSession = randomUUID();
    await asOwner("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [chapterless, `${chapterless}@example.invalid`]);
    await asOwner("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [chapterlessSession, chapterless]);
    // The organization requires staff MFA, so without a verified factor the
    // grantee would already fail the chapter-staff check this case is not about.
    await asOwner("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic grant factor','totp','verified',now(),now())", [randomUUID(), chapterless]);
    await asOwner("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, chapterless]);
    await asOwner("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$3)", [id.org, chapterless, id.coordinator]);
    // Whatever chapter the profile trigger gives a new user, none is an active chapter of this organization.
    expect(await asOwner("select private.member_organization_for($1) is distinct from $2 as outside", [chapterless, id.org])).toEqual([{ outside: true }]);
    expect(await visibleCases(chapterless, chapterlessSession)).toBe(0);
    await act(id.coordinator, id.coordinatorSession);
    expect(await attempt("select public.casework_grant_access($1, $2, $3)", [id.restrictedCase, chapterless, "Covering the step 2 meeting"]))
      .toMatchObject({ ok: false, code: "22023", detail: REACH_TOKEN });
    expect(await grantsFor(chapterless)).toEqual([]);
  });

  // When the case member's profile chapter belongs to
  // another organization, a grantee active only in the case organization
  // cannot reach the member.
  it("refuses a grant when the grantee is not active in the organization of the member's profile chapter", async () => {
    const otherOrg = randomUUID();
    const otherChapter = `case-grant-other-${otherOrg}`;
    await asOwner("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [otherOrg, `case-grant-other-${otherOrg}`, id.coordinator]);
    await asOwner("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9905)", [otherChapter, otherOrg]);
    const grantsBefore = await grantsFor(id.colleague);
    await asOwner("update public.member_profiles set chapter_id = $2 where id = $1", [id.member, otherChapter]);
    try {
      await act(id.coordinator, id.coordinatorSession);
      expect(await attempt("select public.casework_grant_access($1, $2, $3)", [id.restrictedCase, id.colleague, "Preparing the step 3 meeting"]))
        .toMatchObject({ ok: false, code: "22023", detail: REACH_TOKEN });
      expect(await grantsFor(id.colleague)).toEqual(grantsBefore);
    } finally {
      await asOwner("update public.member_profiles set chapter_id = $2 where id = $1", [id.member, chapter]);
    }
  });

  // Staff_can_see_user compares the member's profile
  // chapter organization with the grantee's active organization, never with
  // the case organization. A coordinator active in the member's new
  // organization reaches the member, so the grant saves and opens the case.
  it("saves a grant for a coordinator active in the member's new organization and lets them open the case", async () => {
    const otherOrg = randomUUID();
    const otherChapter = `case-grant-moved-${otherOrg}`;
    const mover = randomUUID();
    const moverSession = randomUUID();
    await asOwner("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [otherOrg, `case-grant-moved-${otherOrg}`, id.coordinator]);
    await asOwner("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9906)", [otherChapter, otherOrg]);
    await asOwner("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [mover, `${mover}@example.invalid`]);
    await asOwner("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [moverSession, mover]);
    await asOwner("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic grant factor','totp','verified',now(),now())", [randomUUID(), mover]);
    for (const org of [id.org, otherOrg]) {
      await asOwner("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, mover]);
    }
    for (const ch of [chapter, otherChapter]) {
      await asOwner("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [mover, ch]);
    }
    // Staff on the case chapter, coordinator of the member's new chapter, and
    // working in the new organization.
    await asOwner("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$3)", [id.org, mover, id.coordinator]);
    await asOwner("insert into public.member_roles(user_id,role,chapter_id) values($1,'steward',$2) on conflict do nothing", [mover, chapter]);
    await asOwner("insert into public.member_roles(user_id,role,chapter_id) values($1,'coordinator',$2) on conflict do nothing", [mover, otherChapter]);
    // The chapter coordinator role lives in member_role_chapters; member_roles
    // alone does not make a chapter coordinator.
    await asOwner("insert into public.member_role_chapters(user_id,role,chapter_id,granted_by) values($1,'coordinator',$2,$3)", [mover, otherChapter, id.coordinator]);
    await asOwner("update public.member_profiles set chapter_id = $2, full_name = 'Grant Proof Mover' where id = $1", [mover, otherChapter]);
    await asOwner("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [otherOrg, id.member]);
    await asOwner("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id.member, otherChapter]);
    await asOwner("update public.member_profiles set chapter_id = $2 where id = $1", [id.member, otherChapter]);
    try {
      expect(await asOwner("select private.member_organization_for($1) = $2 as active_there", [mover, otherOrg])).toEqual([{ active_there: true }]);
      expect(await visibleCases(mover, moverSession)).toBe(0);
      await act(id.coordinator, id.coordinatorSession);
      const granted = await attempt("select (g).grantee_user_id from public.casework_grant_access($1, $2, $3) g", [id.restrictedCase, mover, "Covering the member after the chapter move"]);
      expect(granted.ok, granted.message).toBe(true);
      expect(await grantsFor(mover)).toEqual([{ reason: "Covering the member after the chapter move", granted_by: id.coordinator }]);
      expect(await visibleCases(mover, moverSession)).toBe(1);
    } finally {
      await asOwner("update public.member_profiles set chapter_id = $2 where id = $1", [id.member, chapter]);
    }
  });
});
