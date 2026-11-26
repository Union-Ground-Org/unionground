// @vitest-environment node
//
// REQ-UG-COMPASS-STAFF-DATA-ANSWERS-20261001. A live apply proves the
// staff-only, switch-gated aggregate context: members are refused, the
// feature and organization AI switches refuse with 55000, topics are a closed
// set, figures come back as counts without titles or bodies, and another
// organization's rows never enter the totals.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";

const MIGRATION = "supabase/migrations/20261003055000_compass_staff_data_answers.sql";
const migration = readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8");
const SWITCH = "features.ai_assistant.staff_data_answers";

describe("staff data answers migration (static)", () => {
  it("locks the case graph first, then gates role and switches, with EXECUTE for signed-in users only", () => {
    const code = stripComments(migration);
    expect(code).toMatch(/create function public\.get_compass_staff_data_context\(p_topics text\[\]\)\nreturns jsonb\nlanguage plpgsql\nsecurity definer\nset search_path = ''\nas \$function\$\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n {2}perform private\.member_pin_require_full_session\(\);\ndeclare/);
    expect(code).toContain("revoke all on function public.get_compass_staff_data_context(text[]) from public, anon, authenticated, service_role;");
    expect(code).toContain("grant execute on function public.get_compass_staff_data_context(text[]) to authenticated;");
    expect(code).toMatch(/'false', null, null, null, 200, 'ai_assistant', true\)\non conflict \(key\) do nothing;/);
    expect(code).not.toMatch(/proposal\.(title|body)|workspace\.title|outcome_row\.summary|full_name/);
  });
});

const ID = {
  org: "51002310-0000-4000-8000-000000000001",
  otherOrg: "51002310-0000-4000-8000-000000000002",
  member: "51002310-0000-4000-8000-000000000101",
  staff: "51002310-0000-4000-8000-000000000102",
  outsider: "51002310-0000-4000-8000-000000000103",
  memberSession: "51002310-0000-4000-8000-000000000201",
  staffSession: "51002310-0000-4000-8000-000000000202",
  workspace: "51002310-0000-4000-8000-000000000301",
  otherWorkspace: "51002310-0000-4000-8000-000000000302",
};
const CHAPTER = "compass-staff-data-chapter";
const OTHER_CHAPTER = "compass-staff-data-other";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("staff data answers on a disposable database", () => {
  let db;

  async function as(userId, sessionId, sql, values = []) {
    await db.query("savepoint compass_staff_data");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: userId, role: "authenticated", session_id: sessionId, aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const result = await db.query(sql, values);
      await db.query("reset role");
      await db.query("release savepoint compass_staff_data");
      return result.rows[0];
    } catch (error) {
      await db.query("rollback to savepoint compass_staff_data");
      await db.query("reset role").catch(() => {});
      throw error;
    }
  }

  const context = (userId, sessionId, topics) => as(userId, sessionId, "select public.get_compass_staff_data_context($1::text[]) c", [topics]).then((row) => row.c);

  async function setSwitch(key, value) {
    await db.query(
      `insert into public.organization_setting_values(organization_id,setting_key,value,updated_by) values($1,$2,$3::jsonb,$4)
       on conflict (organization_id, setting_key) do update set value = excluded.value`,
      [ID.org, key, JSON.stringify(value), ID.staff],
    );
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "compass-staff-data-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '30s'");
    await db.query("set local lock_timeout = '15s'");
    await db.query(
      "insert into auth.users (id,email) values ($1,'csd-member@example.invalid'),($2,'csd-staff@example.invalid'),($3,'csd-outsider@example.invalid')",
      [ID.member, ID.staff, ID.outsider],
    );
    await db.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,'csd-org','Compass staff data org',$3),($2,'csd-other','Other org',$4)",
      [ID.org, ID.otherOrg, ID.staff, ID.outsider],
    );
    await db.query(
      "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,'Riverside Hospital',$1,$3,false,92311),($2,'Other chapter',$2,$4,false,92312)",
      [CHAPTER, OTHER_CHAPTER, ID.org, ID.otherOrg],
    );
    for (const [userId, org, chapter] of [[ID.member, ID.org, CHAPTER], [ID.staff, ID.org, CHAPTER], [ID.outsider, ID.otherOrg, OTHER_CHAPTER]]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, userId]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [userId, chapter]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [userId, chapter]);
    }
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)", [ID.org, ID.staff]);
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)", [ID.otherOrg, ID.outsider]);
    await db.query(
      "insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now()),($3,$4,'aal2',now(),now())",
      [ID.memberSession, ID.member, ID.staffSession, ID.staff],
    );
    await db.query(
      `insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
       values (gen_random_uuid(),$1,'m','totp','verified',now(),now()),(gen_random_uuid(),$2,'s','totp','verified',now(),now())`,
      [ID.member, ID.staff],
    );
    await db.query(
      `insert into public.casework_bargaining_workspaces(id,organization_id,chapter_id,title,status,created_by)
       values ($1,$2,$3,'Secret strategy table','live',$4),($5,$6,$7,'Other org table','live',$8)`,
      [ID.workspace, ID.org, CHAPTER, ID.staff, ID.otherWorkspace, ID.otherOrg, OTHER_CHAPTER, ID.outsider],
    );
    await db.query(
      `insert into public.casework_bargaining_proposals(workspace_id,organization_id,side,title,body,status,response_due_at,created_by) values
        ($1,$2,'union','Wage proposal','Confidential wage language here','proposed',now() + interval '2 days',$3),
        ($1,$2,'management','Counter','Confidential counter language','countered',now() - interval '1 day',$3),
        ($4,$5,'union','Other','Other organization language','proposed',now() + interval '1 day',$6)`,
      [ID.workspace, ID.org, ID.staff, ID.otherWorkspace, ID.otherOrg, ID.outsider],
    );
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("registers the switch OFF and member-visible in the AI category", async () => {
    const row = (await db.query("select value_kind, default_value, category, member_visible from public.platform_setting_definitions where key = $1", [SWITCH])).rows[0];
    expect(row).toEqual({ value_kind: "boolean", default_value: false, category: "ai_assistant", member_visible: true });
  });

  it("refuses staff while the organization leaves the switch off", async () => {
    await expect(context(ID.staff, ID.staffSession, ["bargaining"])).rejects.toMatchObject({ code: "55000" });
  });

  it("refuses members even with the switch on", async () => {
    await setSwitch(SWITCH, true);
    await expect(context(ID.member, ID.memberSession, ["bargaining"])).rejects.toMatchObject({ code: "42501" });
  });

  it("returns bargaining counts for the caller's organization only, with no titles or bodies", async () => {
    await setSwitch(SWITCH, true);
    const result = await context(ID.staff, ID.staffSession, ["bargaining", "bargaining"]);
    expect(result.organization_id).toBe(ID.org);
    expect(result.topics).toEqual(["bargaining"]);
    expect(result.data.bargaining).toEqual({
      workspacesByStatus: { live: 1 },
      proposalsBySideAndStatus: [
        { side: "management", status: "countered", proposals: 1 },
        { side: "union", status: "proposed", proposals: 1 },
      ],
      responsesDueWithin7Days: 1,
      responsesOverdue: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(/Secret strategy|Confidential|Other org/);
  });

  it("returns membership through the floored analytics snapshot and keeps every topic key", async () => {
    await setSwitch(SWITCH, true);
    const result = await context(ID.staff, ID.staffSession, ["membership", "outcomes", "caseload", "health"]);
    expect(result.topics).toEqual(["caseload", "health", "membership", "outcomes"]);
    expect(result.data.membership.privacyThreshold).toBe(25);
    expect(result.data.membership.chapters).toEqual([
      expect.objectContaining({ id: CHAPTER, label: "Riverside Hospital", memberCount: null, memberCountSuppressed: true }),
    ]);
    expect(result.data.outcomes).toMatchObject({ openCases: 0, resolved: 0, byOutcome: {} });
    expect(Object.keys(result.data.caseload).length).toBeGreaterThan(0);
    expect(result.data.health).toHaveProperty("chapters");
  });

  it("refuses unknown topics and an organization that turned Compass off", async () => {
    await setSwitch(SWITCH, true);
    await expect(context(ID.staff, ID.staffSession, ["payroll"])).rejects.toMatchObject({ code: "22023" });
    await expect(context(ID.staff, ID.staffSession, [])).rejects.toMatchObject({ code: "22023" });
    await setSwitch("features.ai_assistant.enabled", false);
    await expect(context(ID.staff, ID.staffSession, ["bargaining"])).rejects.toMatchObject({ code: "55000" });
    await setSwitch("features.ai_assistant.enabled", true);
  });
});
