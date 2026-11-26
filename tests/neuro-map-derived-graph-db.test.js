// @vitest-environment node
// REQ-UG-NEURO-MAP-DERIVED-GRAPH-20261001 on an owned disposable database.
// Fixture rows are written by the table owner inside one rolled-back
// transaction; every product read runs as `authenticated` with a JWT claim set.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { releaseCalendarHolds } from "./helpers/release-calendar-holds.js";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("Neuro Map derived graph on an owned disposable database", () => {
  let db;
  const ids = Object.fromEntries(["org", "otherOrg", "admin", "adminSession", "steward", "stewardSession", "member", "memberSession", "otherSteward"].map((key) => [key, randomUUID()]));
  const prefix = `neuro-${ids.org.slice(0, 8)}`;
  const chapter = `${prefix}-a`;
  const foreign = `${prefix}-b`;
  const people = [];
  let lesson;

  async function as(user, session, sql, params = []) {
    await db.query("savepoint neuro_call");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated", session_id: session, aal: "aal2" })]);
      await db.query("set local role authenticated");
      const result = await db.query(sql, params);
      await db.query("reset role");
      await db.query("release savepoint neuro_call");
      return { code: "", data: result.rows[0]?.data };
    } catch (error) {
      await db.query("rollback to savepoint neuro_call");
      await db.query("release savepoint neuro_call");
      return { code: error.code, message: error.message };
    }
  }
  const setting = (key, value) => db.query(
    "insert into public.organization_setting_values(organization_id, setting_key, value) values ($1,$2,$3::jsonb) on conflict (organization_id, setting_key) do update set value = excluded.value",
    [ids.org, key, JSON.stringify(value)],
  );
  const graph = (hat = "admin", user = ids.admin, session = ids.adminSession) => as(user, session, "select public.get_organization_derived_graph($1) data", [hat]);

  async function account(id, { session = null, org = ids.org, chapterId = chapter, roles = [] } = {}) {
    await db.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org, id]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [id, chapterId]);
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapterId]);
    if (session) await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),'aal2')", [session, id]);
    if (roles.length) {
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values ($1,$2,'Neuro proof','totp','verified',now(),now())", [randomUUID(), id]);
      for (const role of roles) await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [org, id, role]);
    }
  }
  async function memberCase(owner, steward, { caseType = "Discipline", articles = "", restricted = false } = {}) {
    await db.query(
      `insert into public.member_cases(user_id,reference,title,case_type,articles,organization_id,chapter_id,steward_user_id,status,is_restricted,restriction_reason,restricted_at,restricted_by)
       values ($1,$2,'Narrative',$3,$4,$5,$6,$7,'active',$8,$9,$10,$11)`,
      [owner, `${prefix}-${randomUUID().slice(0, 8)}`, caseType, articles, ids.org, chapter, steward, restricted, restricted ? "Sensitive proof" : null, restricted ? new Date() : null, restricted ? steward : null],
    );
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "neuro-map-derived-proof" });
    await db.connect();
    await db.query("begin");
    await releaseCalendarHolds(db);
    await db.query("set local statement_timeout='120s'");
    await db.query("set local lock_timeout='15s'");
    const creator = randomUUID();
    await db.query("insert into auth.users(id,email) values ($1,$2)", [creator, `${creator}@example.invalid`]);
    await db.query("insert into public.organizations(id,slug,name,created_by) values ($1,$3,$3,$5),($2,$4,$4,$5)", [ids.org, ids.otherOrg, `${prefix}-org`, `${prefix}-other`, creator]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values ($1,$1,$1,$3,false,9951),($2,$2,$2,$4,false,9952)", [chapter, foreign, ids.org, ids.otherOrg]);
    await account(ids.admin, { session: ids.adminSession, roles: ["admin"] });
    await account(ids.steward, { session: ids.stewardSession, roles: ["steward"] });
    await account(ids.member, { session: ids.memberSession });
    await account(ids.otherSteward, { roles: ["steward"] });
    for (let i = 0; i < 6; i += 1) {
      const id = randomUUID();
      await account(id);
      people.push(id);
    }
    // Three of the steward's members cite Article 12; one case is another
    // steward's restricted case.
    await memberCase(people[0], ids.steward, { articles: "Article 12; Article 7" });
    await memberCase(people[1], ids.steward, { articles: "article 12" });
    await memberCase(people[2], ids.steward, { caseType: "Pay", articles: "Article 12" });
    await memberCase(people[3], ids.otherSteward, { caseType: "Safety", restricted: true });
    lesson = `${prefix}-lesson`;
    await db.query("insert into public.member_rights_lessons(id,label,title,description,steps,script,order_index,title_es,description_es,steps_es,script_es) values ($1,$1,'Proof lesson','Proof','[\"a\",\"b\"]','Proof',99951,'Prueba','Prueba','[\"a\",\"b\"]','Prueba')", [lesson]);
    for (const [index, id] of people.entries()) {
      await db.query("insert into public.member_rights_progress(lesson_id,user_id,completed_steps) values ($1,$2,$3)", [lesson, id, index < 2 ? [0, 1] : index < 4 ? [0] : []]);
    }
  }, 120000);
  beforeEach(async () => { await db.query("savepoint neuro_test"); });
  afterEach(async () => { await db.query("rollback to savepoint neuro_test"); });
  afterAll(async () => { await db?.query("rollback").catch(() => {}); await db?.end(); });

  it("refuses anon, members and hats the caller does not hold", async () => {
    const grant = await db.query("select has_function_privilege('anon','public.get_organization_derived_graph(text)','execute') a");
    expect(grant.rows[0].a).toBe(false);
    expect((await graph("member", ids.member, ids.memberSession)).code).toBe("42501");
    expect((await graph("admin", ids.steward, ids.stewardSession)).code).toBe("42501");
  });

  it("stays off by default", async () => {
    const result = await graph();
    expect(result, result.message).toMatchObject({ code: "", data: { derivedEnabled: false, autoProgressEnabled: false, edges: [], topicReadiness: [] } });
  });

  it("derives represents and shared-issue connections from cases the caller may open", async () => {
    await setting("features.intelligence.neuro_map_derived_graph", true);
    const admin = await graph();
    const edges = admin.data.edges.map((edge) => `${edge.kind}:${edge.sourceId}:${edge.targetId}`);
    for (const member of people.slice(0, 3)) expect(edges).toContain(`represents:${ids.steward}:${member}`);
    // Admin may open the restricted case, so its steward appears too.
    expect(edges).toContain(`represents:${ids.otherSteward}:${people[3]}`);
    const shares = admin.data.edges.filter((edge) => edge.kind === "shares_issue");
    expect(shares.length).toBe(3);
    expect(JSON.stringify(admin.data)).not.toMatch(/Narrative|example\.invalid/);
    // The steward sees only their own cases' connections.
    const steward = await graph("steward", ids.steward, ids.stewardSession);
    expect(steward.data.edges.some((edge) => edge.sourceId === ids.otherSteward || edge.targetId === people[3])).toBe(false);
  });

  it("reports topic readiness as counts only, above the privacy floor", async () => {
    await setting("features.intelligence.neuro_map_auto_progress", true);
    const result = await graph();
    const row = result.data.topicReadiness.find((item) => item.topicLabel === lesson);
    expect(row).toMatchObject({ members: 6, ready: 2, developing: 2, introduced: 2 });
    expect(Object.keys(row).sort()).toEqual(["developing", "introduced", "members", "ready", "topicKey", "topicLabel"]);
    await setting("limits.intelligence.neuro_map_topic_min_members", 7);
    expect((await graph()).data.topicReadiness.find((item) => item.topicLabel === lesson)).toBeUndefined();
    // A stored value below 5 never lowers the floor.
    await setting("limits.intelligence.neuro_map_topic_min_members", 1);
    await db.query("delete from public.member_rights_progress where lesson_id = $1 and user_id = any($2)", [lesson, people.slice(0, 2)]);
    expect((await graph()).data.topicReadiness.find((item) => item.topicLabel === lesson)).toBeUndefined();
  });

  it("leaves manual relationships and topic progress untouched", async () => {
    await setting("features.intelligence.neuro_map_derived_graph", true);
    await setting("features.intelligence.neuro_map_auto_progress", true);
    const before = (await db.query("select (select count(*) from public.organization_relationships where organization_id=$1) r, (select count(*) from public.organization_topic_progress where organization_id=$1) t", [ids.org])).rows[0];
    await graph();
    const after = (await db.query("select (select count(*) from public.organization_relationships where organization_id=$1) r, (select count(*) from public.organization_topic_progress where organization_id=$1) t", [ids.org])).rows[0];
    expect(after).toEqual(before);
  });
});
