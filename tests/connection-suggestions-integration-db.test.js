// @vitest-environment node
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("connection registry integration on an owned disposable database", () => {
  let db;
  const ids = Object.fromEntries(["org", "otherOrg", "admin", "session", "outsider", "survey", "surveyResponse", "pulse", "pulseResponse"].map((key) => [key, randomUUID()]));
  const prefix = `connection-${ids.org.slice(0, 8)}`;
  const chapter = `${prefix}-a`, sibling = `${prefix}-b`, foreign = `${prefix}-c`;
  const profile = { location: { country: "US", state: "MA", metro: "Boston" }, sectorKeys: ["healthcare"], expertiseOffered: ["staffing"], declaredIssueKeys: ["staffing"], shareAnalyzedIssues: true };
  async function call(sql, params = []) {
    await db.query("savepoint connection_call");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids.admin, role: "authenticated", session_id: ids.session, aal: "aal2" })]);
      await db.query("set local role authenticated");
      const result = await db.query(sql, params);
      await db.query("reset role");
      await db.query("release savepoint connection_call");
      return { code: "", data: result.rows[0]?.data };
    } catch (error) {
      await db.query("rollback to savepoint connection_call");
      await db.query("release savepoint connection_call");
      return { code: error.code, message: error.message };
    }
  }
  const list = (source = chapter, token = null, after = null, limit = 250) => call("select public.list_chapter_connection_profiles('admin', $1, $2, $3, $4) data", [after, limit, token, source]);
  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "connection-suggestions-integration-proof" });
    await db.connect(); await db.query("begin");
    await db.query("set local statement_timeout='60s'");
    await db.query("set local lock_timeout='15s'");
    await db.query("insert into auth.users(id,email) values ($1,$3),($2,$4)", [ids.admin, ids.outsider, `${ids.admin}@example.invalid`, `${ids.outsider}@example.invalid`]);
    await db.query("insert into public.organizations(id,slug,name,created_by) values ($1,$3,$3,$5),($2,$4,$4,$5)", [ids.org, ids.otherOrg, `${prefix}-org`, `${prefix}-other`, ids.admin]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values ($1,$1,$1,$4,false,9905),($2,$2,$2,$4,false,9906),($3,$3,$3,$5,false,9907)", [chapter, sibling, foreign, ids.org, ids.otherOrg]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active'),($1,$3,'active')", [ids.org, ids.admin, ids.outsider]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [ids.admin, chapter]);
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [ids.admin, chapter]);
    await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),'aal2')", [ids.session, ids.admin]);
    await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values ($1,$2,'Connection proof','totp','verified',now(),now())", [randomUUID(), ids.admin]);
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'admin',$2)", [ids.org, ids.admin]);
    for (const source of [chapter, sibling]) {
      const saved = await call("select public.save_chapter_connection_profile('admin',$1,$2,true) data", [source, profile]);
      expect(saved, saved.message).toMatchObject({ code: "" });
    }
    // A published peer belongs to an independent organization; fixture seeding
    // uses the table owner, while every tested product operation uses real JWT.
    await db.query(`insert into private.chapter_connection_profiles
      (chapter_id,organization_id,location_country,sector_keys,declared_issue_keys,publication_status,publication_version,published_at,expires_at,consent_version,consent_recorded_at,consent_hat)
      values ($1,$2,'US',array['healthcare'],array['staffing'],'published',1,now(),now()+interval '180 days',1,now(),'admin')`, [foreign, ids.otherOrg]);
    await db.query("insert into public.organization_surveys(id,organization_id,title,status) values ($1,$2,'Connection proof survey','closed')", [ids.survey, ids.org]);
    await db.query("insert into public.organization_survey_sessions(id,organization_id,survey_id,respondent_user_id,status,submitted_at) values ($1,$2,$3,$4,'submitted',now())", [ids.surveyResponse, ids.org, ids.survey, ids.outsider]);
    await db.query("insert into public.organization_pulse_prompts(id,organization_id,event_key,question,options) values ($1,$2,'contract.page','Synthetic?', '[\"yes\",\"no\"]')", [ids.pulse, ids.org]);
    await db.query("insert into public.organization_pulse_events(id,organization_id,prompt_id,user_id,context_key,state,responded_at) values ($1,$2,$3,$4,'connection-proof','responded',now())", [ids.pulseResponse, ids.org, ids.pulse, ids.outsider]);
  }, 60000);
  beforeEach(async () => { await db.query("savepoint connection_test"); });
  afterEach(async () => { await db.query("rollback to savepoint connection_test"); });
  afterAll(async () => { await db?.query("rollback").catch(() => {}); await db?.end(); });

  it("includes consenting sibling chapters and excludes only the source chapter", async () => {
    const result = await list(); expect(result, result.message).toMatchObject({ code: "" });
    const profiles = result.data.rows.map((row) => row.id);
    expect(profiles).toContain(sibling); expect(profiles).toContain(foreign); expect(profiles).not.toContain(chapter);
  });
  it("uses the explicit chapter for eligibility and rejects a token from another source", async () => {
    const first = await list(sibling); expect(first, first.message).toMatchObject({ code: "" });
    expect(first.data.rows.map((row) => row.id)).toContain(chapter);
    expect(first.data.rows.map((row) => row.id)).not.toContain(sibling);
    expect((await list(chapter, first.data.snapshotToken)).code).toBe("22023");
  });
  it("invalidates a scan when a chapter is hidden, including a sibling in the same organization", async () => {
    const first = await list(chapter, null, null, 1); expect(first.code).toBe("");
    const hidden = await call("select public.set_chapter_connection_hidden('admin',$1,$2,true) data", [chapter, sibling]);
    expect(hidden, hidden.message).toMatchObject({ code: "" });
    expect((await list(chapter, first.data.snapshotToken, first.data.nextCursor)).code).toBe("22023");
    expect((await list()).data.rows.map((row) => row.id)).not.toContain(sibling);
  });
  it("invalidates projection changes and never republishes a chapter moved away and back", async () => {
    const first = await list(); expect(first.code).toBe("");
    await db.query("update public.chapters set name='Renamed proof chapter' where id=$1", [foreign]);
    expect((await list(chapter, first.data.snapshotToken)).code).toBe("22023");
    await db.query("savepoint immutable_owner");
    await expect(db.query("update public.chapters set organization_id=$2 where id=$1", [foreign, ids.org])).rejects.toMatchObject({ code: "42501" });
    await db.query("rollback to savepoint immutable_owner");
    // Ordinary reassignment is already forbidden. Exercise the publication
    // guard under synthetic operator maintenance, entirely inside this test's
    // rollback boundary; production ownership protection is unchanged.
    await db.query("alter table public.chapters disable trigger chapters_forbid_ownerless_write");
    await db.query("update public.chapters set organization_id=$2 where id=$1", [foreign, ids.org]);
    expect((await list()).data.rows.map((row) => row.id)).not.toContain(foreign);
    await db.query("update public.chapters set organization_id=$2 where id=$1", [foreign, ids.otherOrg]);
    await db.query("alter table public.chapters enable trigger chapters_forbid_ownerless_write");
    expect((await list()).data.rows.map((row) => row.id)).not.toContain(foreign);
  });
  it.each([["survey", "surveyResponse"], ["feedback", "pulseResponse"]])("rejects organization-wide %s sources from someone outside the target chapter", async (kind, key) => {
    const result = await call("select public.set_chapter_connection_source_tags('admin',$1,$2,$3,array['staffing']) data", [chapter, kind, ids[key]]);
    expect(result.code).toBe("22023");
  });
  it("retains reviewed empty sources in the denominator and freezes safe bands once", async () => {
    const quarter = (await db.query("select * from private.chapter_connection_previous_quarter()" )).rows[0];
    for (let i = 0; i < 50; i += 1) {
      const person = randomUUID(), response = randomUUID();
      await db.query("insert into auth.users(id,email) values ($1,$2)", [person, `${person}@example.invalid`]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [ids.org, person]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [person, chapter]);
      await db.query("insert into public.organization_survey_sessions(id,organization_id,survey_id,respondent_user_id,status,submitted_at) values ($1,$2,$3,$4,'submitted',$5)", [response, ids.org, ids.survey, person, quarter.starts_at]);
      const saved = await call("select public.set_chapter_connection_source_tags('admin',$1,'survey',$2,$3) data", [chapter, response, i < 25 ? ["staffing"] : []]);
      expect(saved, saved.message).toMatchObject({ code: "" });
    }
    const result = await call("select public.freeze_chapter_connection_issue_aggregates('admin',$1) data", [chapter]);
    expect(result, result.message).toMatchObject({ code: "", data: { topics: [{ key: "staffing", band: "many" }] } });
    expect(JSON.stringify(result.data)).not.toMatch(/contributor|sourceId|sourceText/);
    const repeated = await call("select public.freeze_chapter_connection_issue_aggregates('admin',$1) data", [chapter]);
    expect(repeated.data).toEqual({ ...result.data, alreadyFrozen: true });
  }, 60000);
});
