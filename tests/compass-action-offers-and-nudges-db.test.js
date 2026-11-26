// @vitest-environment node
//
// REQ-UG-COMPASS-ACTION-OFFERS-20261001 and
// REQ-UG-COMPASS-CONTEXTUAL-NUDGES-20261001. A live apply proves pinning
// is the owner's own saved answer only, switch gated and bounded, and that the
// nudge read returns switch-gated counts in each caller's own scope.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";

const MIGRATION = "supabase/migrations/20261003057000_compass_action_offers_and_nudges.sql";
const migration = readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8");
const OFFERS = "features.ai_assistant.action_offers";
const NUDGES = "features.ai_assistant.contextual_nudges";

describe("action offers and nudges migration (static)", () => {
  it("registers both switches OFF and locks the case graph first in every new RPC", () => {
    const code = stripComments(migration);
    for (const key of [OFFERS, NUDGES]) {
      expect(code).toMatch(new RegExp(`\\('${key.replaceAll(".", "\\.")}', 'boolean',[\\s\\S]*?'false', null, null, null, \\d+, 'ai_assistant', true\\)`));
    }
    for (const name of ["set_compass_answer_pinned", "list_compass_pinned_answers", "get_compass_nudges"]) {
      expect(code).toMatch(new RegExp(`create function public\\.${name}\\([^)]*\\)\\nreturns jsonb\\nlanguage plpgsql\\nsecurity definer\\nset search_path = ''\\nas \\$function\\$\\nbegin\\n  perform private\\.lock_case_graph`));
      expect(code).toContain(`grant execute on function public.${name}(`);
    }
    expect(code).toContain("alter table public.member_guide_messages\n  add column pinned_at timestamptz;");
  });
});

const ID = {
  org: "51002510-0000-4000-8000-000000000001",
  member: "51002510-0000-4000-8000-000000000101",
  staff: "51002510-0000-4000-8000-000000000102",
  memberSession: "51002510-0000-4000-8000-000000000201",
  staffSession: "51002510-0000-4000-8000-000000000202",
  thread: "51002510-0000-4000-8000-000000000301",
  staffThread: "51002510-0000-4000-8000-000000000302",
  question: "51002510-0000-4000-8000-000000000401",
  answer: "51002510-0000-4000-8000-000000000402",
  staffAnswer: "51002510-0000-4000-8000-000000000403",
  case: "51002510-0000-4000-8000-000000000501",
};
const CHAPTER = "compass-offers-chapter";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("action offers and nudges on a disposable database", () => {
  let db;

  async function as(userId, sessionId, sql, values = []) {
    await db.query("savepoint compass_offers");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", session_id: sessionId, aal: "aal2" })]);
      await db.query("set local role authenticated");
      const result = await db.query(sql, values);
      await db.query("reset role");
      await db.query("release savepoint compass_offers");
      return result.rows[0];
    } catch (error) {
      await db.query("rollback to savepoint compass_offers");
      await db.query("reset role").catch(() => {});
      throw error;
    }
  }

  const pin = (userId, sessionId, messageId, pinned) => as(userId, sessionId, "select public.set_compass_answer_pinned($1::uuid, $2) r", [messageId, pinned]).then((row) => row.r);
  const pins = (userId, sessionId) => as(userId, sessionId, "select public.list_compass_pinned_answers() r").then((row) => row.r);
  const nudges = (userId, sessionId) => as(userId, sessionId, "select public.get_compass_nudges() r").then((row) => row.r);

  async function setSwitch(key, value) {
    await db.query(
      `insert into public.organization_setting_values(organization_id,setting_key,value,updated_by) values($1,$2,$3::jsonb,$4)
       on conflict (organization_id, setting_key) do update set value = excluded.value`,
      [ID.org, key, JSON.stringify(value), ID.staff],
    );
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "compass-offers-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '30s'");
    await db.query("set local lock_timeout = '15s'");
    await db.query("insert into auth.users (id,email) values ($1,'co-member@example.invalid'),($2,'co-staff@example.invalid')", [ID.member, ID.staff]);
    await db.query("insert into public.organizations(id,slug,name,created_by) values($1,'co-org','Compass offers org',$2)", [ID.org, ID.staff]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,92511)", [CHAPTER, ID.org]);
    for (const userId of [ID.member, ID.staff]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ID.org, userId]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [userId, CHAPTER]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [userId, CHAPTER]);
    }
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)", [ID.org, ID.staff]);
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now()),($3,$4,'aal2',now(),now())", [ID.memberSession, ID.member, ID.staffSession, ID.staff]);
    await db.query(
      `insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
       values (gen_random_uuid(),$1,'m','totp','verified',now(),now()),(gen_random_uuid(),$2,'s','totp','verified',now(),now())`,
      [ID.member, ID.staff],
    );
    await db.query("insert into public.member_guide_threads(id,user_id,title) values ($1,$2,'Grievance'),($3,$4,'Staff')", [ID.thread, ID.member, ID.staffThread, ID.staff]);
    await db.query(
      `insert into public.member_guide_messages(id,thread_id,user_id,role,body,created_at) values
        ($1,$2,$3,'user','How do I file a grievance?',now() - interval '2 minutes'),
        ($4,$2,$3,'assistant','File within 14 days and ask your steward.',now() - interval '1 minute'),
        ($5,$6,$7,'assistant','Staff answer.',now())`,
      [ID.question, ID.thread, ID.member, ID.answer, ID.staffAnswer, ID.staffThread, ID.staff],
    );
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("registers both switches OFF and member-visible", async () => {
    const rows = (await db.query("select key, default_value, member_visible from public.platform_setting_definitions where key = any($1) order by sort_order", [[OFFERS, NUDGES]])).rows;
    expect(rows).toEqual([{ key: OFFERS, default_value: false, member_visible: true }, { key: NUDGES, default_value: false, member_visible: true }]);
  });

  it("refuses pinning and lists nothing while action offers are off", async () => {
    await expect(pin(ID.member, ID.memberSession, ID.answer, true)).rejects.toMatchObject({ code: "55000" });
    expect(await pins(ID.member, ID.memberSession)).toEqual([]);
  });

  it("pins only the owner's own saved answer and lists it with its question", async () => {
    await setSwitch(OFFERS, true);
    expect((await pin(ID.member, ID.memberSession, ID.answer, true)).pinnedAt).toEqual(expect.any(String));
    await expect(pin(ID.member, ID.memberSession, ID.question, true)).rejects.toMatchObject({ code: "P0002" });
    await expect(pin(ID.member, ID.memberSession, ID.staffAnswer, true)).rejects.toMatchObject({ code: "P0002" });
    expect(await pins(ID.member, ID.memberSession)).toEqual([
      expect.objectContaining({ id: ID.answer, threadId: ID.thread, question: "How do I file a grievance?", answer: "File within 14 days and ask your steward." }),
    ]);
    expect(await pins(ID.staff, ID.staffSession)).toEqual([]);
    expect((await pin(ID.member, ID.memberSession, ID.answer, false)).pinnedAt).toBeNull();
    expect(await pins(ID.member, ID.memberSession)).toEqual([]);
  });

  it("holds the Home pin limit at six", async () => {
    await setSwitch(OFFERS, true);
    await db.query("savepoint pin_limit");
    try {
      await db.query(
        `insert into public.member_guide_messages(thread_id,user_id,role,body,pinned_at)
         select $1,$2,'assistant','Pinned answer ' || n, now() - n * interval '1 minute' from generate_series(1, 6) n`,
        [ID.thread, ID.member],
      );
      await expect(pin(ID.member, ID.memberSession, ID.answer, true)).rejects.toMatchObject({ code: "54000" });
      expect(await pins(ID.member, ID.memberSession)).toHaveLength(6);
    } finally {
      await db.query("rollback to savepoint pin_limit");
    }
  });

  it("returns nudges disabled while the switch is off, and the staff overdue count in scope when on", async () => {
    expect(await nudges(ID.staff, ID.staffSession)).toEqual({ enabled: false, staff: [], member: [] });
    await setSwitch(NUDGES, true);
    await db.query(
      `insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,step,articles,status,coordinator_user_id)
       values ($1,$2,'CO-1','Overdue proof','grievance',$3,$4,'Step 1','','active',$5)`,
      [ID.case, ID.member, ID.org, CHAPTER, ID.staff],
    );
    await db.query(
      "insert into public.casework_deadlines(case_id,organization_id,chapter_id,kind,label,due_at,created_by) values ($1,$2,$3,'filing','Filing',now() - interval '2 days',$4)",
      [ID.case, ID.org, CHAPTER, ID.staff],
    );
    const staff = await nudges(ID.staff, ID.staffSession);
    expect(staff.enabled).toBe(true);
    expect(staff.staff).toEqual([{ id: "overdue-cases", count: 1, urgent: false }]);
    expect(staff.member).toEqual([]);
    expect(JSON.stringify(staff)).not.toMatch(/CO-1|Overdue proof/);
    const member = await nudges(ID.member, ID.memberSession);
    expect(member).toEqual({ enabled: true, staff: [], member: [] });
  });

  it("counts the member's own open retaliation reports and nobody else's", async () => {
    await setSwitch(NUDGES, true);
    await db.query("savepoint own_reports");
    try {
      // Fixture only: the table's triggers require the encrypted write path,
      // which is not under test here; the nudge reads status and reporter.
      await db.query("set local session_replication_role = replica");
      await db.query(
        `insert into public.casework_retaliation_reports(organization_id,chapter_id,reporter_user_id,incident_at,management_person,protected_activity,adverse_action,idempotency_key)
         values ($1,$2,$3,now() - interval '1 day','A manager','Filed a grievance last month','Schedule cut after filing',gen_random_uuid())`,
        [ID.org, CHAPTER, ID.member],
      );
      await db.query("set local session_replication_role = origin");
      expect((await nudges(ID.member, ID.memberSession)).member).toEqual([{ id: "retaliation-flag", count: 1, urgent: true }]);
      expect((await nudges(ID.staff, ID.staffSession)).member).toEqual([]);
      await db.query("set local session_replication_role = replica");
      await db.query("update public.casework_retaliation_reports set status = 'closed' where reporter_user_id = $1", [ID.member]);
      await db.query("set local session_replication_role = origin");
      expect((await nudges(ID.member, ID.memberSession)).member).toEqual([]);
    } finally {
      await db.query("rollback to savepoint own_reports");
    }
  });
  it("hides and refuses changing an existing pinned answer until full-session step-up", async () => {
    await setSwitch(OFFERS, true);
    await pin(ID.member, ID.memberSession, ID.answer, true);
    const full = await pins(ID.member, ID.memberSession);
    expect(full).toHaveLength(1);
    await db.query("insert into private.member_pin_sessions(session_id,user_id) values($1,$2)", [ID.memberSession, ID.member]);
    try {
      await expect(pins(ID.member, ID.memberSession)).rejects.toMatchObject({ code: "42501", message: "step-up required" });
      await expect(pin(ID.member, ID.memberSession, ID.answer, false)).rejects.toMatchObject({ code: "42501", message: "step-up required" });
    } finally {
      await db.query("delete from private.member_pin_sessions where session_id=$1", [ID.memberSession]);
    }
    expect(await pins(ID.member, ID.memberSession)).toEqual(full);
    await pin(ID.member, ID.memberSession, ID.answer, false);
  });

  it.each(["member", "staff"])("refuses %s nudges in a restricted session and preserves the full-session counts", async (actor) => {
    await setSwitch(NUDGES, true);
    const user = ID[actor];
    const session = ID[actor + "Session"];
    const full = await nudges(user, session);
    expect(full.enabled).toBe(true);
    if (actor === "staff") expect(full.staff).toEqual([{ id: "overdue-cases", count: 1, urgent: false }]);
    await db.query("insert into private.member_pin_sessions(session_id,user_id) values($1,$2)", [session,user]);
    try {
      await expect(nudges(user, session)).rejects.toMatchObject({ code: "42501", message: "step-up required" });
    } finally {
      await db.query("delete from private.member_pin_sessions where session_id=$1", [session]);
    }
    expect(await nudges(user, session)).toEqual(full);
  });

});
