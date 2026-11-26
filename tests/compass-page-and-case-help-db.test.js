// @vitest-environment node
//
// REQ-UG-COMPASS-PAGE-AND-CASE-AWARE-HELP-20261001. A live apply proves
// get_compass_case_context re-reads a case only through the caller's own
// casework authorization inside the Compass organization, refuses while the
// switches are off, returns day offsets and closed vocabularies only, and adds
// the title and notes only when the organization opted in.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";

const MIGRATION = "supabase/migrations/20261003056000_compass_page_and_case_help.sql";
const migration = readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8");
const CASE_HELP = "features.ai_assistant.case_help";
const NARRATIVE = "features.ai_assistant.case_context_includes_narrative";

describe("page and case help migration (static)", () => {
  it("registers three OFF switches and locks the case graph before reading", () => {
    const code = stripComments(migration);
    for (const key of ["features.ai_assistant.page_aware_help", CASE_HELP, NARRATIVE]) {
      expect(code).toMatch(new RegExp(`\\('${key.replaceAll(".", "\\.")}', 'boolean',[\\s\\S]*?'false', null, null, null, \\d+, 'ai_assistant', true\\)`));
    }
    expect(code).toMatch(/security definer\nset search_path = ''\nas \$function\$\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n {2}perform private\.member_pin_require_full_session\(\);\ndeclare/);
    expect(code).toContain("and private.casework_can_read(c.id);");
    expect(code).toContain("revoke all on function public.get_compass_case_context(uuid) from public, anon, authenticated, service_role;");
  });
});

const ID = {
  org: "51002410-0000-4000-8000-000000000001",
  otherOrg: "51002410-0000-4000-8000-000000000002",
  member: "51002410-0000-4000-8000-000000000101",
  neighbor: "51002410-0000-4000-8000-000000000102",
  outsider: "51002410-0000-4000-8000-000000000103",
  memberSession: "51002410-0000-4000-8000-000000000201",
  neighborSession: "51002410-0000-4000-8000-000000000202",
  memberCase: "51002410-0000-4000-8000-000000000301",
  otherCase: "51002410-0000-4000-8000-000000000302",
};
const CHAPTER = "compass-case-help-chapter";
const OTHER_CHAPTER = "compass-case-help-other";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("case help context on a disposable database", () => {
  let db;

  async function as(userId, sessionId, sql, values = []) {
    await db.query("savepoint compass_case_help");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", session_id: sessionId, aal: "aal2" })]);
      await db.query("set local role authenticated");
      const result = await db.query(sql, values);
      await db.query("reset role");
      await db.query("release savepoint compass_case_help");
      return result.rows[0];
    } catch (error) {
      await db.query("rollback to savepoint compass_case_help");
      await db.query("reset role").catch(() => {});
      throw error;
    }
  }

  const context = (userId, sessionId, caseId) => as(userId, sessionId, "select public.get_compass_case_context($1::uuid) c", [caseId]).then((row) => row.c);

  async function setSwitch(key, value) {
    await db.query(
      `insert into public.organization_setting_values(organization_id,setting_key,value,updated_by) values($1,$2,$3::jsonb,$4)
       on conflict (organization_id, setting_key) do update set value = excluded.value`,
      [ID.org, key, JSON.stringify(value), ID.member],
    );
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "compass-case-help-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '30s'");
    await db.query("set local lock_timeout = '15s'");
    await db.query(
      "insert into auth.users (id,email) values ($1,'cch-member@example.invalid'),($2,'cch-neighbor@example.invalid'),($3,'cch-outsider@example.invalid')",
      [ID.member, ID.neighbor, ID.outsider],
    );
    await db.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,'cch-org','Case help org',$3),($2,'cch-other','Other org',$4)",
      [ID.org, ID.otherOrg, ID.member, ID.outsider],
    );
    await db.query(
      "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$3,false,92411),($2,$2,$2,$4,false,92412)",
      [CHAPTER, OTHER_CHAPTER, ID.org, ID.otherOrg],
    );
    for (const [userId, org, chapter] of [[ID.member, ID.org, CHAPTER], [ID.neighbor, ID.org, CHAPTER], [ID.outsider, ID.otherOrg, OTHER_CHAPTER]]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, userId]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [userId, chapter]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [userId, chapter]);
    }
    await db.query(
      "insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now()),($3,$4,'aal2',now(),now())",
      [ID.memberSession, ID.member, ID.neighborSession, ID.neighbor],
    );
    await db.query(
      `insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
       values (gen_random_uuid(),$1,'m','totp','verified',now(),now()),(gen_random_uuid(),$2,'n','totp','verified',now(),now())`,
      [ID.member, ID.neighbor],
    );
    // #8568 part B: Compass counts the deadline from today's Eastern date, so the
    // fixture's deadline is five Eastern days out (current_date is the UTC day,
    // tomorrow from 7 PM Eastern).
    await db.query(
      `insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,step,articles,status,deadline)
       values ($1,$2,'CCH-1','Jane Doe disciplined by Mark Smith','grievance',$3,$4,'Step 2','Article 12','active',(now() at time zone 'America/New_York')::date + 5),
              ($5,$6,'CCH-2','Other organization case','grievance',$7,$8,'Intake','','active',null)`,
      [ID.memberCase, ID.member, ID.org, CHAPTER, ID.otherCase, ID.outsider, ID.otherOrg, OTHER_CHAPTER],
    );
    await db.query("insert into public.member_case_updates(case_id,user_id,body) values ($1,$2,'Mark Smith yelled at me on Tuesday.')", [ID.memberCase, ID.member]);
    await db.query(
      "insert into public.casework_deadlines(case_id,organization_id,chapter_id,kind,label,due_at,created_by) values ($1,$2,$3,'response','Response from Mark Smith',now() + interval '3 days',$4)",
      [ID.memberCase, ID.org, CHAPTER, ID.member],
    );
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("registers the three switches OFF and member-visible", async () => {
    const rows = (await db.query(
      "select key, default_value, category, member_visible from public.platform_setting_definitions where key in ('features.ai_assistant.page_aware_help', $1, $2) order by sort_order",
      [CASE_HELP, NARRATIVE],
    )).rows;
    expect(rows).toEqual([
      { key: "features.ai_assistant.page_aware_help", default_value: false, category: "ai_assistant", member_visible: true },
      { key: CASE_HELP, default_value: false, category: "ai_assistant", member_visible: true },
      { key: NARRATIVE, default_value: false, category: "ai_assistant", member_visible: true },
    ]);
  });

  it("refuses while case help is off", async () => {
    await expect(context(ID.member, ID.memberSession, ID.memberCase)).rejects.toMatchObject({ code: "55000" });
  });

  it("returns the member's own case as status, step, day offsets and closed vocabularies only", async () => {
    await setSwitch(CASE_HELP, true);
    const result = await context(ID.member, ID.memberSession, ID.memberCase);
    expect(result.organization_id).toBe(ID.org);
    expect(result.includesNarrative).toBe(false);
    expect(result.data).toMatchObject({
      status: "active", step: "Step 2", caseDeadlineInDays: 5,
      deadlines: [{ kind: "response", status: "active", dueInDays: expect.any(Number) }],
      timeline: [{ type: "case_note", daysAgo: 0 }],
    });
    expect(JSON.stringify(result)).not.toMatch(/Jane|Mark|Smith|Tuesday|CCH-1|Article 12/);
  });

  it("returns the nearest active deadlines, including overdue work, before distant deadlines", async () => {
    await setSwitch(CASE_HELP, true);
    await db.query('savepoint deadline_order');
    try {
      for (const [days,status] of [[-2,'active'],[1,'active'],[-3,'met'],...Array.from({length:12},(_,i)=>[40+i,'active'])]) {
        await db.query("insert into public.casework_deadlines(case_id,organization_id,chapter_id,kind,label,due_at,status,created_by) values($1,$2,$3,'response','Deadline',now()+$4::interval,$5,$6)",
          [ID.memberCase,ID.org,CHAPTER,`${days} days`,status,ID.member]);
      }
      const result = await context(ID.member,ID.memberSession,ID.memberCase);
      expect(result.data.deadlines).toHaveLength(10);
      expect(result.data.deadlines[0]).toMatchObject({ status:'active', dueInDays:-2 });
      expect(result.data.deadlines[1]).toMatchObject({ status:'active', dueInDays:1 });
      expect(result.data.deadlines.every(deadline=>deadline.status==='active')).toBe(true);
      expect(result.data.deadlines.some(deadline=>deadline.dueInDays===51)).toBe(false);
    } finally { await db.query('rollback to savepoint deadline_order'); }
  });

  it("adds the title and notes only when the organization opts in", async () => {
    await setSwitch(CASE_HELP, true);
    await setSwitch(NARRATIVE, true);
    const result = await context(ID.member, ID.memberSession, ID.memberCase);
    expect(result.includesNarrative).toBe(true);
    expect(result.data).toMatchObject({ title: "Jane Doe disciplined by Mark Smith", notes: ["Mark Smith yelled at me on Tuesday."] });
    await setSwitch(NARRATIVE, false);
  });

  it("gives another member and another organization's case the same flat refusal", async () => {
    await setSwitch(CASE_HELP, true);
    await expect(context(ID.neighbor, ID.neighborSession, ID.memberCase)).rejects.toMatchObject({ code: "P0002" });
    await expect(context(ID.member, ID.memberSession, ID.otherCase)).rejects.toMatchObject({ code: "P0002" });
    await expect(context(ID.member, ID.memberSession, "51002410-0000-4000-8000-000000000399")).rejects.toMatchObject({ code: "P0002" });
  });

  it("refuses when the organization turned Compass off", async () => {
    await setSwitch(CASE_HELP, true);
    await setSwitch("features.ai_assistant.enabled", false);
    await expect(context(ID.member, ID.memberSession, ID.memberCase)).rejects.toMatchObject({ code: "55000" });
    await setSwitch("features.ai_assistant.enabled", true);
  });
  it("refuses case facts in a restricted PIN session and restores the full-session result after step-up", async () => {
    await setSwitch(CASE_HELP, true);
    const full = await context(ID.member, ID.memberSession, ID.memberCase);
    expect(full.data.status).toBe("active");
    await db.query("insert into private.member_pin_sessions(session_id,user_id) values($1,$2)", [ID.memberSession, ID.member]);
    try {
      await expect(context(ID.member, ID.memberSession, ID.memberCase)).rejects.toMatchObject({ code: "42501", message: "step-up required" });
      await expect(context(ID.member, ID.memberSession, ID.otherCase)).rejects.toMatchObject({ code: "42501", message: "step-up required" });
    } finally {
      await db.query("delete from private.member_pin_sessions where session_id=$1", [ID.memberSession]);
    }
    expect(await context(ID.member, ID.memberSession, ID.memberCase)).toEqual(full);
  });

});
