// @vitest-environment node
// #8205: an organization grant has no legacy chapter row. It must never
// turn the Advisor desk into a database-wide count or latest-ballot reader.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { latestFnBody } from "./helpers/migration.js";

// #8568: fixture dates are built on the Eastern day, the day the readers count;
// the session's current_date is the UTC day, tomorrow from 7 PM Eastern.

it("counts active chapter and organization memberships for owned chapters", () => {
  const body = latestFnBody("public.get_advisor_overview");
  expect(body).toMatch(/from public\.member_chapter_memberships membership\s+join public\.organization_memberships organization_membership/);
  expect(body).toContain("organization_membership.status = 'active'");
  expect(body).toContain("and membership.status = 'active'");
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("Advisor overview tenant boundary", () => {
  let db, f;
  const owner = async () => { await db.query("reset role"); await db.query("select set_config('request.jwt.claims','',true)"); };
  const as = async (person = f.advisor, aal = "aal2") => {
    await owner();
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: person.id, session_id: person.session, aal, role: "authenticated" })]);
    await db.query("set local role authenticated");
  };
  const overview = async () => (await db.query("select public.get_advisor_overview() value")).rows[0].value;
  const canSeeProfile = async (member) => {
    // Keep the test caller's JWT while allowing the assertion to call the
    // private predicate. Run the public overview as authenticated afterwards.
    await db.query("reset role");
    const { rows: [row] } = await db.query(`select $1::uuid in (
      select private.staff_visible_member_ids(readable_role)
      from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role
    ) as visible`, [member.id]);
    await db.query("set local role authenticated");
    return row.visible;
  };
  const person = async (chapter, org, role = null, organizationGrant = false) => {
    const value = { id: randomUUID(), session: randomUUID() };
    await db.query("insert into auth.users(id,email) values($1,$2)", [value.id, `${value.id}@advisor-boundary.invalid`]);
    await db.query("update public.member_profiles set chapter_id=$2,full_name='Fictional boundary member' where id=$1", [value.id, chapter]);
    await db.query("insert into public.organization_memberships(user_id,organization_id,status) values($1,$2,'active')", [value.id, org]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [value.id, chapter]);
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [value.session, value.id]);
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), value.id]);
    if (role) {
      if (organizationGrant) await db.query("insert into public.organization_role_grants(user_id,organization_id,role) values($1,$2,$3)", [value.id, org, role]);
      else {
        await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [value.id, role, chapter]);
        await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [value.id, role, chapter]);
      }
    }
    return value;
  };
  const ballot = async (org, chapter, title, age, votes = 0) => {
    const id = randomUUID(), option = randomUUID();
    await db.query(`insert into public.member_ballots(id,title,organization_id,chapter_id,active,campaign_state,closes_at,quorum_target,order_index)
      values($1,$2,$3,$4,false,'closed',now()-($5::int*interval '1 minute'),7,$6)`, [id,title,org,chapter,age,++f.ballotOrder]);
    await db.query("insert into public.member_ballot_options(id,ballot_id,label,label_es,order_index) values($1,$2,'Yes','Sí',0)", [option,id]);
    for (let n = 0; n < votes; n += 1) await db.query("insert into public.member_ballot_choices(ballot_id,option_id) values($1,$2)", [id,option]);
    return id;
  };
  const refused = async () => {
    await db.query("savepoint refusal");
    await expect(overview()).rejects.toMatchObject({ code: "42501" });
    await db.query("rollback to savepoint refusal");
  };
  beforeEach(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "advisor-tenant-boundary-rollback" });
    await db.connect(); await db.query("begin");
    f = { a: randomUUID(), b: randomUUID(), ballotOrder: 820500 };
    f.ca = `advisor-a-${f.a}`; f.cb = `advisor-b-${f.b}`; f.other = `advisor-other-${f.b}`;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Fictional Cedar'),($2::uuid,$2::text,'Fictional Harbor')", [f.a,f.b]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,'Cedar chapter',$1,$4,9986),($2,'Harbor chapter',$2,$5,9987),($3,'Other Harbor chapter',$3,$5,9988)", [f.ca,f.cb,f.other,f.a,f.b]);
    f.advisor = await person(f.cb,f.b,'advisor',true);
    f.member = await person(f.cb,f.b);
    for (let n = 0; n < 3; n += 1) await person(f.ca,f.a,'steward');
    f.foreign = await ballot(f.a,f.ca,'Foreign fragrance-free vote',1,3);
    await as();
  }, 60000);
  afterEach(async () => { if (db) { await db.query("rollback"); await db.end(); } });

  it("shows no foreign stewards or ballot for a fresh organization beside a populated one", async () => {
    const result = await overview();
    expect({ stewards: result.stewardCount, turnout: result.turnout, unstaffed: result.atRisk.unstaffed }, JSON.stringify(result))
      .toEqual({ stewards: 0, turnout: null, unstaffed: true });
    expect(JSON.stringify(result)).not.toContain("Foreign fragrance-free vote");
  });
  it.each([true, false])("matches Admin's active roster and uses it for coverage (organization Advisor: %s)", async (organizationAdvisor) => {
    await owner();
    if (!organizationAdvisor) {
      await db.query("delete from public.organization_role_grants where user_id=$1 and organization_id=$2 and role='advisor'", [f.advisor.id,f.b]);
      for (const table of ["member_roles", "member_role_chapters"]) {
        await db.query(`insert into public.${table}(user_id,role,chapter_id) values($1,'advisor',$2)`, [f.advisor.id,f.cb]);
      }
    }
    const formerChapterMember = await person(f.cb,f.b);
    const formerOrgMember = await person(f.cb,f.b);
    const secondary = await person(f.ca,f.a);
    await db.query("insert into public.organization_memberships(user_id,organization_id,status) values($1,$2,'active')", [secondary.id,f.b]);
    await person(f.other,f.b,'steward',true);
    await db.query("update public.member_chapter_memberships set status='revoked',revoked_at=now() where user_id=$1 and chapter_id=$2", [formerChapterMember.id,f.cb]);
    await db.query("update public.organization_memberships set status='revoked',revoked_at=now() where user_id=$1 and organization_id=$2", [formerOrgMember.id,f.b]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [secondary.id,f.cb]);
    await as();
    // The caller can count this active membership through chapter-wide
    // authority even though the profile is outside the visibility predicate.
    expect(await canSeeProfile(secondary)).toBe(false);
    const result = await overview();

    await owner();
    await db.query("insert into public.organization_role_grants(user_id,organization_id,role) values($1,$2,'admin')", [f.member.id,f.b]);
    await as(f.member);
    const { chapters } = (await db.query("select public.get_admin_org_structure() value")).rows[0].value;
    expect(chapters.find(({ id }) => id === f.cb).memberCount).toBe(3);
    expect(result).toMatchObject({ membersCovered: 3, stewardCount: 1, coverageRatio: 3 });
  });

  it("keeps the active coverage count within a unit Advisor's visibility", async () => {
    await owner();
    const scopedAdvisor = await person(f.cb,f.b,'advisor');
    const outsideUnit = await person(f.cb,f.b);
    const unit = randomUUID();
    await db.query(`insert into private.chapter_units(id,organization_id,chapter_id,name,kind)
      values($1,$2,$3,'Fictional coverage unit','unit')`, [unit,f.b,f.cb]);
    await db.query("insert into private.chapter_unit_members(unit_id,chapter_id,user_id) values($1,$2,$3)", [unit,f.cb,f.member.id]);
    await db.query("insert into private.chapter_role_scopes(user_id,chapter_id,role,unit_id) values($1,$2,'advisor',$3)", [scopedAdvisor.id,f.cb,unit]);

    await as(scopedAdvisor);
    expect(await canSeeProfile(f.member)).toBe(true);
    expect(await canSeeProfile(outsideUnit)).toBe(false);
    expect((await overview()).membersCovered).toBe(2);
  });

  it("keeps own-chapter stewards and anonymous ballot totals, excluding newer foreign and other-chapter rows", async () => {
    await owner(); await person(f.cb,f.b,'steward'); await person(f.other,f.b,'steward');
    await ballot(f.b,f.cb,'Own Harbor vote',5,2);
    await ballot(f.b,f.other,'Other Harbor vote',2,4);
    await as(); const result = await overview();
    expect(result.stewardCount).toBe(1);
    expect(result.turnout).toEqual({ title: "Own Harbor vote", totalVotes: 2, quorumTarget: 7 });
    expect(result.atRisk.unstaffed).toBe(false);
  });
  it("keeps a completed organization-wide ballot of the selected organization visible", async () => {
    await owner(); await ballot(f.b,null,'Harbor organization vote',3,2);
    await as(); expect((await overview()).turnout).toEqual({ title: "Harbor organization vote", totalVotes: 2, quorumTarget: 7 });
  });
  it("counts an active steward grant in the selected organization without a legacy role row", async () => {
    await owner(); await person(f.other,f.b,'steward',true);
    await as(); expect((await overview()).stewardCount).toBe(1);
  });
  it("does not publish a newer draft or accept an advisor grant from a previous selected organization", async () => {
    await owner(); const draft = await ballot(f.b,f.cb,'Unpublished draft',1);
    await db.query("update public.member_ballots set campaign_state='draft' where id=$1", [draft]);
    await as(); expect((await overview()).turnout).toBeNull();
    await owner();
    await db.query("insert into public.organization_memberships(user_id,organization_id,status) values($1,$2,'active')", [f.advisor.id,f.a]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [f.advisor.id,f.ca]);
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [f.advisor.id,f.ca]);
    await as(); await refused();
  });
  it("does not transfer an organization steward grant through membership in a second organization", async () => {
    await owner(); const dual = await person(f.ca,f.a,'steward',true);
    await db.query("insert into public.organization_memberships(user_id,organization_id,status) values($1,$2,'active')", [dual.id,f.b]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [dual.id,f.cb]);
    await as(); expect((await overview()).stewardCount).toBe(0);
  });
  it("does not count a chapter steward after live organization membership is revoked", async () => {
    await owner(); const steward = await person(f.cb,f.b,'steward');
    await as(); expect((await overview()).stewardCount).toBe(1);
    await owner(); await db.query("update public.organization_memberships set status='revoked',revoked_at=now() where user_id=$1 and organization_id=$2", [steward.id,f.b]);
    await as(); expect((await overview()).stewardCount).toBe(0);
  });
  it("retains role, live membership and two-step boundaries", async () => {
    await as(f.member); await refused();
    await as(f.advisor,"aal1"); await refused();
    await owner(); await db.query("update public.organization_memberships set status='revoked',revoked_at=now() where user_id=$1 and organization_id=$2", [f.advisor.id,f.b]);
    await as(); await refused();
  });
  it("keeps a switched member's overdue case in its owning chapter and out of the new workspace", async () => {
    await owner();
    for (const actor of [f.member, f.advisor]) {
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [actor.id,f.other]);
    }
    const caseId = randomUUID();
    // The real ownership trigger derives the original organization/chapter.
    await db.query(`insert into public.member_cases(id,user_id,reference,title,case_type,status,deadline)
      values($1,$2,$3,'Fictional overdue case','grievance','active',(now() at time zone 'America/New_York')::date-1)`, [caseId,f.member.id,`SWITCH-${caseId}`]);
    await as();
    const counts = (value) => ({ open: value.openGrievances, overdue: value.atRisk.overdueCases });
    expect(counts(await overview())).toEqual({ open: 1, overdue: 1 });

    await as(f.member);
    const switched = (await db.query("select public.switch_my_chapter($1) value", [f.other])).rows[0].value;
    expect(switched.chapterId).toBe(f.other);
    await owner();
    expect((await db.query("select chapter_id,organization_id from public.member_cases where id=$1", [caseId])).rows)
      .toEqual([{ chapter_id: f.cb, organization_id: f.b }]);
    expect((await db.query("select chapter_id from public.member_profiles where id=$1", [f.member.id])).rows[0].chapter_id)
      .toBe(f.other);
    await as();
    expect(counts(await overview())).toEqual({ open: 1, overdue: 1 });

    await db.query("select public.switch_my_chapter($1)", [f.other]);
    expect(counts(await overview())).toEqual({ open: 0, overdue: 0 });
    await db.query("select public.switch_my_chapter($1)", [f.cb]);
    expect(counts(await overview())).toEqual({ open: 1, overdue: 1 });
  });
  it("keeps the leadership, coordinator and chapter-health siblings inside their existing scope", async () => {
    await owner();
    for (const role of ['admin','vp','coordinator']) {
      await db.query("insert into public.organization_role_grants(user_id,organization_id,role) values($1,$2,$3)", [f.advisor.id,f.b,role]);
    }
    await as();
    const vp = (await db.query("select public.get_vp_overview() value")).rows[0].value;
    expect(vp.turnout).toBeNull();
    const health = (await db.query("select public.get_chapter_health_portfolio() value")).rows[0].value;
    expect(health.map((row) => row.chapterId).sort()).toEqual([f.cb,f.other].sort());
    const leadership = (await db.query("select public.get_chapter_leadership() value")).rows[0].value;
    expect(leadership.chapterId).toBe(f.cb);
    const coordinator = (await db.query("select public.get_coordinator_kpis() value")).rows[0].value;
    expect(coordinator).toMatchObject({ openCases: 0, resolved: 0, byStep: [], byArticle: [] });
  });
  it("isolates an explicitly selected ownerless legacy chapter and refuses an unresolved scope", async () => {
    await owner();
    const legacy = `advisor-legacy-${f.b}`;
    // Model retained historical rows, not a newly authorized tenant setup.
    // Replication mode is fixture-only and is restored before every RPC.
    await db.query("set local session_replication_role=replica");
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,'Legacy chapter',$1,null,9989)", [legacy]);
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [f.advisor.id,legacy]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [f.advisor.id,legacy]);
    await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'advisor',$2)", [f.advisor.id,legacy]);
    await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'advisor',$2)", [f.advisor.id,legacy]);
    await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'steward',$2)", [f.member.id,legacy]);
    await ballot(null,legacy,'Legacy chapter vote',5,1);
    await db.query("set local session_replication_role=origin");
    await as(); const result = await overview();
    expect(result.membersCovered).toBe(1);
    expect(result.stewardCount).toBe(1);
    expect(result.turnout).toEqual({ title: "Legacy chapter vote", totalVotes: 1, quorumTarget: 7 });
    await owner(); await db.query("set local session_replication_role=replica");
    await db.query("update public.member_profiles set chapter_id=null where id=$1", [f.advisor.id]);
    await db.query("set local session_replication_role=origin");
    await as(); await refused();
  });
});
