// @vitest-environment node
// REQ-UG-ISSUE-INTELLIGENCE-WEEKLY-DIGEST-20261001 on an owned disposable
// database: Monday 9 AM ET generation, idempotency, switches, privacy floor,
// staff-only reads and the guarded Compass summary write. Fixture rows are
// written by the table owner inside one rolled-back transaction.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { releaseCalendarHolds } from "./helpers/release-calendar-holds.js";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
// Monday 2026-09-28 13:05 UTC = 9:05 AM EDT; the completed week is 09-21..09-27.
const MONDAY_9AM = "2026-09-28T13:05:00Z";
// Later on the same Monday (3:40 PM ET): a continuation batch.
const MONDAY_AFTERNOON = "2026-09-28T19:40:00Z";
// Monday 8:50 AM ET: before the digest window opens.
const MONDAY_EARLY = "2026-09-28T12:50:00Z";
const MONDAY_8AM = "2026-09-28T12:05:00Z";
const IN_WEEK = "2026-09-24T15:00:00Z";

live("weekly issue digest on an owned disposable database", () => {
  let db;
  const ids = Object.fromEntries(["org", "otherOrg", "admin", "adminSession", "member", "memberSession"].map((key) => [key, randomUUID()]));
  const prefix = `digest-${ids.org.slice(0, 8)}`;
  const chapter = `${prefix}-a`;
  const foreign = `${prefix}-b`;

  async function as(user, session, sql, params = []) {
    await db.query("savepoint digest_call");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated", session_id: session, aal: "aal2" })]);
      await db.query("set local role authenticated");
      const result = await db.query(sql, params);
      await db.query("reset role");
      await db.query("release savepoint digest_call");
      return { code: "", data: result.rows[0]?.data };
    } catch (error) {
      await db.query("rollback to savepoint digest_call");
      await db.query("release savepoint digest_call");
      return { code: error.code, message: error.message };
    }
  }
  const setting = (key, value, org = ids.org) => db.query(
    "insert into public.organization_setting_values(organization_id, setting_key, value) values ($1,$2,$3::jsonb) on conflict (organization_id, setting_key) do update set value = excluded.value",
    [org, key, JSON.stringify(value)],
  );
  const generate = (now = MONDAY_9AM, force = false) => db.query("select private.generate_issue_intelligence_weekly_digests($1::timestamptz, 200, $2) n", [now, force]).then((result) => result.rows[0].n);
  const readDigests = (hat = "admin") => as(ids.admin, ids.adminSession, "select public.get_issue_intelligence_weekly_digests($1) data", [hat]);

  async function signedIn(user, session, org, chapterId, roles = []) {
    await db.query("insert into auth.users(id,email) values ($1,$2)", [user, `${user}@example.invalid`]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org, user]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user, chapterId]);
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapterId]);
    await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),'aal2')", [session, user]);
    if (roles.length) {
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values ($1,$2,'Digest proof','totp','verified',now(),now())", [randomUUID(), user]);
      for (const role of roles) await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [org, user, role]);
    }
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "issue-intelligence-digest-proof" });
    await db.connect();
    await db.query("begin");
    await releaseCalendarHolds(db);
    await db.query("set local statement_timeout='120s'");
    await db.query("set local lock_timeout='15s'");
    const creator = randomUUID();
    await db.query("insert into auth.users(id,email) values ($1,$2)", [creator, `${creator}@example.invalid`]);
    await db.query("insert into public.organizations(id,slug,name,created_by) values ($1,$3,$3,$5),($2,$4,$4,$5)", [ids.org, ids.otherOrg, `${prefix}-org`, `${prefix}-other`, creator]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values ($1,$1,$1,$3,false,9921),($2,$2,$2,$4,false,9922)", [chapter, foreign, ids.org, ids.otherOrg]);
    await signedIn(ids.admin, ids.adminSession, ids.org, chapter, ["admin"]);
    await signedIn(ids.member, ids.memberSession, ids.org, chapter);
    // Sixteen people ask about contract rights during the completed week and
    // eight of their cases cite contract articles.
    for (let i = 0; i < 16; i += 1) {
      const id = randomUUID();
      await db.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [ids.org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [id, chapter]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapter]);
      await db.query("insert into public.member_qa_questions(organization_id,chapter_id,author_user_id,title,body,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,$6)",
        [ids.org, chapter, id, `What are my contract rights number ${i + 1}?`, "Can someone explain the overtime article please?", IN_WEEK]);
      if (i < 8) {
        await db.query("insert into public.member_cases(user_id,reference,title,case_type,articles,organization_id,chapter_id,created_at) values ($1,$2,'Narrative','Other','Article 12',$3,$4,$5)",
          [id, `${prefix}-${i}`, ids.org, chapter, IN_WEEK]);
      }
    }
  }, 120000);
  beforeEach(async () => { await db.query("savepoint digest_test"); });
  afterEach(async () => { await db.query("rollback to savepoint digest_test"); });
  afterAll(async () => { await db?.query("rollback").catch(() => {}); await db?.end(); });

  it("stays off by default and outside Monday 9 AM Eastern", async () => {
    expect(await generate()).toBe(0);
    await setting("features.intelligence.weekly_digest", true);
    expect(await generate(MONDAY_8AM)).toBe(0);
    expect((await readDigests()).data).toEqual({ enabled: true, digests: [] });
  });

  it("stores one banded digest per week and family, idempotently", async () => {
    await setting("features.intelligence.weekly_digest", true);
    expect(await generate()).toBe(1);
    expect(await generate()).toBe(0);
    const rows = (await db.query("select * from private.issue_intelligence_weekly_digests where organization_id=$1", [ids.org])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ thread_family: "contract_rights_confusion", confidence_label: "low", trend: "rising", ai_status: "not_requested" });
    expect(rows[0].window_start.toISOString().slice(0, 10)).toBe("2026-09-21");
    expect(rows[0].window_end.toISOString().slice(0, 10)).toBe("2026-09-27");
    expect(rows[0].evidence).toEqual({ evidenceFamilies: ["qa", "cases"], qa: "many", cases: "several" });
    expect(rows[0].recommendations).toEqual(["publish_explainer", "brief_stewards"]);
    const read = await readDigests("admin");
    expect(read, read.message).toMatchObject({ code: "", data: { enabled: true } });
    expect(read.data.digests[0]).toMatchObject({ family: "contract_rights_confusion", confidence: "low", ai: { status: "off" } });
    expect(JSON.stringify(read.data)).not.toMatch(/example\.invalid|Narrative|overtime/);
  });

  it("visits every eligible organization in bounded continuation batches, digest or not", async () => {
    await db.query("update public.organizations set status = 'active' where id = any($1::uuid[])", [[ids.org, ids.otherOrg]]);
    await setting("features.intelligence.weekly_digest", true);
    await setting("features.intelligence.weekly_digest", true, ids.otherOrg);
    const batch = (now) => db.query("select private.generate_issue_intelligence_weekly_digests($1::timestamptz, 1, false) n", [now]).then((result) => result.rows[0].n);
    const visits = () => db.query("select organization_id from private.issue_intelligence_digest_visits where window_start = date '2026-09-21'")
      .then((result) => result.rows.map((row) => row.organization_id));
    expect(await batch(MONDAY_EARLY)).toBe(0);
    expect(await visits()).toEqual([]);
    let inserted = 0;
    for (let round = 0; round < 50; round += 1) {
      const before = (await visits()).length;
      inserted += await batch(MONDAY_AFTERNOON);
      const after = (await visits()).length;
      // A batch of one visits at most one organization, and an organization
      // without a qualifying signal is still recorded, so the next batch moves on.
      expect(after - before).toBeLessThanOrEqual(1);
      if (after === before) break;
    }
    expect(await visits()).toEqual(expect.arrayContaining([ids.org, ids.otherOrg]));
    expect(inserted).toBe(1);
    expect((await db.query("select count(*)::int n from private.issue_intelligence_weekly_digests where organization_id = any($1::uuid[])", [[ids.org, ids.otherOrg]])).rows[0].n).toBe(1);
    expect(await batch(MONDAY_AFTERNOON)).toBe(0);
    const grants = await db.query("select has_table_privilege('authenticated','private.issue_intelligence_digest_visits','select') a, has_table_privilege('service_role','private.issue_intelligence_digest_visits','select') s");
    expect(grants.rows[0]).toEqual({ a: false, s: false });
  });

  it("caps recommendations and skips a family below the privacy floor", async () => {
    await setting("features.intelligence.weekly_digest", true);
    await setting("limits.intelligence.digest_max_recommendations", 1);
    expect(await generate()).toBe(1);
    expect((await db.query("select recommendations from private.issue_intelligence_weekly_digests where organization_id=$1", [ids.org])).rows[0].recommendations).toEqual(["publish_explainer"]);
    await db.query("delete from private.issue_intelligence_weekly_digests where organization_id=$1", [ids.org]);
    await db.query("delete from private.issue_intelligence_digest_visits where organization_id=$1", [ids.org]);
    await setting("limits.intelligence.issue_signal_min_segment", 17);
    expect(await generate()).toBe(0);
  });

  it("is staff-only and tenant-local", async () => {
    await setting("features.intelligence.weekly_digest", true);
    await generate();
    expect((await as(ids.member, ids.memberSession, "select public.get_issue_intelligence_weekly_digests('admin') data")).code).toBe("42501");
    expect((await as(ids.member, ids.memberSession, "select public.get_issue_intelligence_weekly_digests('member') data")).code).toBe("42501");
    const grants = await db.query("select has_table_privilege('authenticated','private.issue_intelligence_weekly_digests','select') t, has_function_privilege('anon','public.get_issue_intelligence_weekly_digests(text)','execute') anon");
    expect(grants.rows[0]).toEqual({ t: false, anon: false });
    // Another organization never sees this tenant's digest.
    const other = randomUUID(), otherSession = randomUUID();
    await signedIn(other, otherSession, ids.otherOrg, foreign, ["admin"]);
    await setting("features.intelligence.weekly_digest", true, ids.otherOrg);
    const foreignRead = await as(other, otherSession, "select public.get_issue_intelligence_weekly_digests('admin') data");
    expect(foreignRead, foreignRead.message).toMatchObject({ code: "", data: { enabled: true, digests: [] } });
  });

  it("guards the Compass summary behind both AI switches and saves it once", async () => {
    await setting("features.intelligence.weekly_digest", true);
    await setting("features.intelligence.weekly_digest_ai", true);
    await generate();
    const digestId = (await db.query("select id from private.issue_intelligence_weekly_digests where organization_id=$1", [ids.org])).rows[0].id;
    const authorize = () => as(ids.admin, ids.adminSession, "select public.authorize_issue_intelligence_digest_ai('admin', $1) data", [digestId]);
    // Until the organization AI switch definition exists the summary is off,
    // never an error.
    const aiKnown = (await db.query("select exists(select 1 from public.platform_setting_definitions where key='features.ai_assistant.enabled') k")).rows[0].k;
    if (!aiKnown) {
      expect((await authorize()).code).toBe("42501");
      // Stand in for REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001's
      // definition inside this rolled-back test.
      await db.query("insert into public.platform_setting_definitions(key,value_kind,label,description,default_value,sort_order,category,member_visible) values ('features.ai_assistant.enabled','boolean','AI assistant','Organization AI switch stand-in.','false',10,'ai_assistant',true)");
    }
    await setting("features.ai_assistant.enabled", false);
    expect((await authorize()).code).toBe("42501");
    const offRead = await readDigests();
    expect(offRead.data.digests[0].ai.status).toBe("off");
    await setting("features.ai_assistant.enabled", true);
    expect((await readDigests()).data.digests[0].ai.status).toBe("available");
    const payload = await authorize();
    expect(payload, payload.message).toMatchObject({ code: "", data: { digestId, family: "contract_rights_confusion", confidence: "low" } });
    expect(Object.keys(payload.data).sort()).toEqual(["confidence", "digestId", "evidence", "family", "organizationId", "recommendations", "trend", "windowEnd", "windowStart"]);
    // api/guide.js binds the governed dispatch to this organization.
    expect(payload.data.organizationId).toBe(ids.org);
    const save = (summary) => as(ids.admin, ids.adminSession, "select public.save_issue_intelligence_digest_ai('admin', $1, $2, array['Publish a short explainer'], null, 'union-ground/compass-mesh:v1') data", [digestId, summary]);
    expect((await save("short")).code).toBe("22023");
    const saved = await save("Contract-rights questions rose across Q&A and cases last week.");
    expect(saved, saved.message).toMatchObject({ code: "", data: { ai: { status: "enriched" } } });
    expect((await save("Contract-rights questions rose across Q&A and cases last week.")).code).toBe("22023");
    expect((await authorize()).code).toBe("22023");
  });
});
