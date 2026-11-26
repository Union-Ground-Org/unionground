// @vitest-environment node
//
// BUG-UG-COORDINATOR-DESK-GRANT-SCOPE-MEDIAN-AND-COMPASS-OUTCOMES-20261022
//
// 20261022053100  widened the coordinator desk's queue, KPIs and
// open-case tiles to a case the caller holds an active grant for while
// staff_can_see_user admits them (the member's chapter moved to the caller's
// organization). The median-days tile and Compass's byOutcome kept the old
// organization-and-chapter bound. This proof covers both readers: the grantee
// sees the case's step change and its recorded outcome; an identically placed
// coordinator without a grant, or the grantee after revocation, sees neither;
// a reader without grants is unchanged.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const SLUG = "coordinator_desk_grant_scope_median_and_compass_outcomes";
const sql = stripComments(loadMigrationSql(SLUG));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const GRANT = "select g.case_id from public.casework_access_grants g where g.grantee_user_id = (select auth.uid()) and g.revoked_at is null";

describe("coordinator desk grant scope for the median tile and Compass outcomes", () => {
  it("sorts after the desk grant migration it extends, inside one bounded transaction", () => {
    // Only the predecessor it depends on: a later migration must not fail this test.
    expect(findMigrationName(SLUG) > "20261022053100_coordinator_desk_cross_organization_grants.sql").toBe(true);
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("set local lock_timeout = '5s';");
    expect(sql).toContain("if installed is distinct from '{0b595f19662ec7e662e3b9e3d82e1e6d,b7db0023bf2af19e9795e92a16b5a284}' then");
  });

  it("adds the grant alternative to both readers and keeps their tenant bound and per-case helper", () => {
    const median = squash(fnBody(sql, "public.casework_dashboard_median_days_per_step"));
    expect(median).toContain("(transition.organization_id = (select private.current_member_organization()) and transition.chapter_id = (select private.current_member_chapter()))");
    expect(median).toContain(`or ( transition.case_id in ( ${GRANT} ) and public.staff_can_see_user((select c.user_id from public.member_cases c where c.id = transition.case_id), 'coordinator') )`);
    expect(median).toContain("where private.casework_staff_can_access(tenant.case_id)");
    expect(median).toContain("interval '90 days'");
    const compass = squash(fnBody(sql, "public.get_compass_staff_data_context"));
    expect(compass).toContain(`where ( (case_row.organization_id = org and case_row.chapter_id = chapter) or ( case_row.id in ( ${GRANT} ) and public.staff_can_see_user(case_row.user_id, 'coordinator') ) ) and private.casework_staff_can_access(case_row.id)`);
    expect(compass).toContain("part := public.get_coordinator_kpis();");
  });

  it("updates the database contract for both readers", () => {
    for (const sig of ["public.casework_dashboard_median_days_per_step()", "public.get_compass_staff_data_context(p_topics text[])"]) {
      const entry = contract.functions.find((candidate) => candidate.sig === sig);
      expect(entry, sig).toBeTruthy();
      expect(entry.bodyContains, sig).toContain("g.grantee_user_id = (select auth.uid())");
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("the median tile and Compass outcomes follow the coordinator desk's grant scope", () => {
  let client;
  const id = Object.fromEntries([
    "member", "memberSession", "caseCoordinator", "caseCoordinatorSession",
    "grantee", "granteeSession", "ungranted", "ungrantedSession",
    "caseOrg", "otherOrg", "restrictedCase",
  ].map((key) => [key, randomUUID()]));
  const caseChapter = `xorg-med-case-${id.caseOrg}`;
  const otherChapter = `xorg-med-moved-${id.otherOrg}`;

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
  const readers = async (actor, session) => {
    await act(actor, session);
    const median = (await client.query("select step, transition_count from public.casework_dashboard_median_days_per_step()")).rows
      .map((row) => [row.step, Number(row.transition_count)]);
    const outcomes = (await client.query("select public.get_compass_staff_data_context(array['outcomes']) as c")).rows[0].c.data.outcomes;
    return { median, byOutcome: outcomes.byOutcome, resolved: outcomes.resolved };
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "coordinator-desk-grant-scope-median-compass-proof",
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
    for (const [org, chapter, order] of [[id.caseOrg, caseChapter, 9931], [id.otherOrg, otherChapter, 9932]]) {
      await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [org, `xorg-med-${org}`, id.caseCoordinator]);
      await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,$3)", [chapter, org, order]);
      await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [org]);
      for (const key of ["features.ai_assistant.enabled", "features.ai_assistant.staff_data_answers"]) {
        await client.query(
          `insert into public.organization_setting_values(organization_id,setting_key,value,updated_by) values($1,$2,'true'::jsonb,$3)
           on conflict (organization_id, setting_key) do update set value = excluded.value`, [org, key, id.caseCoordinator]);
      }
    }
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.caseOrg, id.caseCoordinator]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id.caseCoordinator, caseChapter]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id.caseCoordinator, caseChapter]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)", [id.caseOrg, id.caseCoordinator]);
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'coordinator',$2) on conflict do nothing", [id.caseCoordinator, caseChapter]);
    for (const org of [id.caseOrg, id.otherOrg]) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, id.member]);
    }
    for (const chapter of [caseChapter, otherChapter]) {
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id.member, chapter]);
    }
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id.member, caseChapter]);
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
    // A restricted case with a recent step change and a recorded outcome, opened in the case chapter.
    await client.query(
      `insert into public.member_cases(
         id,user_id,reference,title,case_type,organization_id,chapter_id,coordinator_user_id,
         step,articles,status,is_restricted,restriction_reason,restricted_at,restricted_by)
       values($1,$2,'CASE-XORG-MEDIAN','CASE-XORG-MEDIAN','other',$3,$4,$5,'Step 3','Article 7','active',true,'sensitive witness statements',now(),$5)`,
      [id.restrictedCase, id.member, id.caseOrg, caseChapter, id.caseCoordinator]);
    await client.query(
      `insert into public.casework_step_transitions(case_id,organization_id,chapter_id,from_step,to_step,outcome,transitioned_by,idempotency_key,created_at)
       values($1,$2,$3,'Step 2','Step 3','Advanced after the meeting',$4,$5,now() - interval '5 days')`,
      [id.restrictedCase, id.caseOrg, caseChapter, id.caseCoordinator, randomUUID()]);
    await client.query("update public.member_cases set status = 'resolved' where id = $1", [id.restrictedCase]);
    await client.query("insert into public.member_case_outcomes(case_id,user_id,outcome,summary,recorded_by) values($1,$2,'settled','Settled at step 3',$3)",
      [id.restrictedCase, id.member, id.caseCoordinator]);
    // The member's profile chapter then moved to the other organization.
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id.member, otherChapter]);
    await act(id.caseCoordinator, id.caseCoordinatorSession);
    const granted = await client.query("select (g).grantee_user_id from public.casework_grant_access($1, $2, $3) g",
      [id.restrictedCase, id.grantee, "Covering the member after the chapter move"]);
    expect(granted.rows).toHaveLength(1);
    await client.query("reset role");

    //  re-final: committed data gives every steward grant its migration

    // assignments; an organization grant reaches only chapters it has one in.

    await migrateLegacyStewardFixtures(client);
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("shows the grantee the granted case's step change and recorded outcome beside the KPI totals", async () => {
    const view = await readers(id.grantee, id.granteeSession);
    expect(view.median).toEqual([["Step 2", 1]]);
    expect(view.resolved).toBe(1);
    expect(view.byOutcome).toEqual({ settled: 1 });
  });

  it("shows neither to an identically placed coordinator without a grant", async () => {
    const view = await readers(id.ungranted, id.ungrantedSession);
    expect(view.median).toEqual([]);
    expect(view.resolved).toBe(0);
    expect(view.byOutcome).toEqual({});
  });

  it("drops both once the grant is revoked", async () => {
    await client.query("savepoint revoke_grant");
    try {
      await asOwner("update public.casework_access_grants set revoked_at = now(), revoked_by = $2 where case_id = $1 and grantee_user_id = $3 and revoked_at is null",
        [id.restrictedCase, id.caseCoordinator, id.grantee]);
      const view = await readers(id.grantee, id.granteeSession);
      expect(view.median).toEqual([]);
      expect(view.byOutcome).toEqual({});
    } finally {
      await client.query("rollback to savepoint revoke_grant");
    }
  });

  it("leaves a reader without grants on exactly the old tenant bound", async () => {
    const view = await readers(id.caseCoordinator, id.caseCoordinatorSession);
    // The pre-repair bounds, under the same caller's claims and without RLS, as the definer readers run.
    const oldMedian = (await asOwner(
      `select count(*)::int as n from public.casework_step_transitions t
        where t.created_at >= now() - interval '90 days'
          and t.organization_id = (select private.current_member_organization())
          and t.chapter_id = (select private.current_member_chapter())
          and private.casework_staff_can_access(t.case_id)`))[0].n;
    const oldOutcomes = (await asOwner(
      `select count(*)::int as n from public.member_case_outcomes o join public.member_cases c on c.id = o.case_id
        where c.organization_id = private.member_organization_for((select auth.uid()))
          and c.chapter_id = private.current_member_chapter()
          and private.casework_staff_can_access(c.id)`))[0].n;
    expect(view.median.reduce((sum, [, count]) => sum + count, 0)).toBe(oldMedian);
    expect(Object.values(view.byOutcome).reduce((sum, count) => sum + count, 0)).toBe(oldOutcomes);
  });
});
