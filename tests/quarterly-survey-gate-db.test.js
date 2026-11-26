// @vitest-environment node
//
// REQ-UG-QUARTERLY-SURVEY-GATE-ENFORCED-20261001 (CR-002, "give to view").
//
// public.get_quarterly_survey_gate() is the one authority the web and native
// soft gates read. On a disposable database this proves that it locks a member
// who has not submitted the current quarter's open survey, and fails open for
// an organization admin, with the organization switch off, after submission,
// and whenever the member cannot answer the survey (other chapter, outside its
// window, closed, or none at all).
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";

const MIGRATION = "supabase/migrations/20261002100000_quarterly_survey_gate_enforced.sql";
const migration = readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8");
const SWITCH = "features.engagement_voice.quarterly_survey_gate";

describe("quarterly survey gate (static)", () => {
  it("registers the switch ON by the old default and keeps the RPC read-only", () => {
    expect(migration).toMatch(/\nbegin;\n/);
    expect(migration.trimEnd()).toMatch(/\ncommit;$/);
    expect(migration).toContain(`('${SWITCH}', 'boolean'`);
    expect(migration).toMatch(/'true', null, null, null, \d+, 'engagement_voice', true\)\non conflict \(key\) do nothing;/);
    expect(migration).toContain("create or replace function public.get_quarterly_survey_gate()");
    expect(migration).toMatch(/returns jsonb\nlanguage plpgsql\nstable\nsecurity definer\nset search_path = ''/);
    expect(stripComments(migration)).not.toMatch(/\b(grant|revoke)\b/i);
  });
});

const ID = {
  org: "51002100-0000-4000-8000-000000000001",
  member: "51002100-0000-4000-8000-000000000101",
  admin: "51002100-0000-4000-8000-000000000102",
  memberSession: "51002100-0000-4000-8000-000000000201",
  adminSession: "51002100-0000-4000-8000-000000000202",
  survey: "51002100-0000-4000-8000-000000000301",
};
const CHAPTER = "quarterly-gate-chapter";
const OTHER_CHAPTER = "quarterly-gate-other-chapter";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("quarterly survey gate on a disposable database", () => {
  let db;
  let period;

  async function gateFor(userId, sessionId) {
    await db.query("savepoint quarterly_gate");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: userId, role: "authenticated", session_id: sessionId, aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const result = await db.query("select public.get_quarterly_survey_gate() gate");
      await db.query("reset role");
      await db.query("release savepoint quarterly_gate");
      return result.rows[0].gate;
    } catch (error) {
      await db.query("rollback to savepoint quarterly_gate");
      await db.query("reset role").catch(() => {});
      throw error;
    }
  }

  const memberGate = () => gateFor(ID.member, ID.memberSession);
  const adminGate = () => gateFor(ID.admin, ID.adminSession);

  async function withChange(sql, values, check) {
    await db.query("savepoint quarterly_gate_change");
    try {
      await db.query(sql, values);
      await check();
    } finally {
      await db.query("rollback to savepoint quarterly_gate_change");
    }
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "quarterly-survey-gate-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '30s'");
    await db.query("set local lock_timeout = '15s'");
    period = (await db.query(
      "select pg_catalog.to_char(current_date, 'YYYY') || '-Q' || pg_catalog.date_part('quarter', current_date)::integer as period",
    )).rows[0].period;
    await db.query(
      "insert into auth.users (id,email) values ($1,'quarterly-gate-member@example.invalid'),($2,'quarterly-gate-admin@example.invalid')",
      [ID.member, ID.admin],
    );
    await db.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,'quarterly-gate-org','Quarterly gate proof org',$2)",
      [ID.org, ID.admin],
    );
    await db.query(
      "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$3,false,92101),($2,$2,$2,$3,false,92102)",
      [CHAPTER, OTHER_CHAPTER, ID.org],
    );
    for (const userId of [ID.member, ID.admin]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ID.org, userId]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [userId, CHAPTER]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [userId, CHAPTER]);
    }
    await db.query(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)",
      [ID.org, ID.admin],
    );
    await db.query(
      "insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now()),($3,$4,'aal2',now(),now())",
      [ID.memberSession, ID.member, ID.adminSession, ID.admin],
    );
    await db.query(
      `insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
       values (gen_random_uuid(),$1,'member-totp','totp','verified',now(),now()),
              (gen_random_uuid(),$2,'admin-totp','totp','verified',now(),now())`,
      [ID.member, ID.admin],
    );
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("the switch is registered ON for the engagement category and shown to members", async () => {
    const definition = (await db.query(
      "select value_kind, default_value, category, member_visible from public.platform_setting_definitions where key = $1",
      [SWITCH],
    )).rows[0];
    expect(definition).toEqual({ value_kind: "boolean", default_value: true, category: "engagement_voice", member_visible: true });
  });

  it("fails open when the quarter has no quarterly survey", async () => {
    expect(await memberGate()).toMatchObject({ periodKey: period, surveyId: null, required: false, unlocked: true, reason: "no_survey", gateEnabled: true });
  });

  describe("with the current quarter's survey open", () => {
    beforeAll(async () => {
      await db.query(
        `insert into public.organization_surveys(id,organization_id,title,status,cadence,period_key,created_by)
         values ($1,$2,'Quarterly check-in','open','quarterly',$3,$4)`,
        [ID.survey, ID.org, period, ID.admin],
      );
    });

    it("locks a member who has not submitted it", async () => {
      expect(await memberGate()).toMatchObject({
        surveyId: ID.survey, title: "Quarterly check-in", required: true, completed: false,
        unlocked: false, reason: "incomplete", status: "not_started", gateEnabled: true,
      });
    });

    it("keeps a member with only a saved draft locked", async () => {
      await withChange(
        "insert into public.organization_survey_sessions(organization_id,survey_id,respondent_user_id,status) values($1,$2,$3,'in_progress')",
        [ID.org, ID.survey, ID.member],
        async () => expect(await memberGate()).toMatchObject({ unlocked: false, reason: "incomplete", status: "in_progress" }),
      );
    });

    it("unlocks once the member submits", async () => {
      await withChange(
        "insert into public.organization_survey_sessions(organization_id,survey_id,respondent_user_id,status,submitted_at) values($1,$2,$3,'submitted',now())",
        [ID.org, ID.survey, ID.member],
        async () => expect(await memberGate()).toMatchObject({ completed: true, unlocked: true, reason: "completed" }),
      );
    });

    it("always lets an organization admin through", async () => {
      expect(await adminGate()).toMatchObject({ surveyId: ID.survey, unlocked: true, reason: "admin" });
    });

    it("turns off for the whole organization with the switch", async () => {
      await withChange(
        "insert into public.organization_setting_values(organization_id,setting_key,value,updated_by) values($1,$2,'false'::jsonb,$3)",
        [ID.org, SWITCH, ID.admin],
        async () => expect(await memberGate()).toMatchObject({ unlocked: true, reason: "disabled", gateEnabled: false, required: true }),
      );
    });

    it.each([
      ["scoped to another chapter", "update public.organization_surveys set chapter_id = $2 where id = $1", [OTHER_CHAPTER]],
      ["not open yet", "update public.organization_surveys set opens_at = now() + interval '1 day' where id = $1", []],
      ["past its close", "update public.organization_surveys set opens_at = now() - interval '2 days', closes_at = now() - interval '1 day' where id = $1", []],
      ["closed", "update public.organization_surveys set status = 'closed' where id = $1", []],
    ])("fails open while the survey is %s", async (_label, sql, extra) => {
      await withChange(sql, [ID.survey, ...extra], async () => {
        expect(await memberGate()).toMatchObject({ required: false, unlocked: true, reason: "unavailable" });
      });
    });

    it("still locks when the survey is scoped to the member's own chapter", async () => {
      await withChange(
        "update public.organization_surveys set chapter_id = $2 where id = $1",
        [ID.survey, CHAPTER],
        async () => expect(await memberGate()).toMatchObject({ required: true, unlocked: false, reason: "incomplete" }),
      );
    });

    it("embeds the same gate in the member engagement snapshot", async () => {
      await db.query("savepoint quarterly_gate_snapshot");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: ID.member, role: "authenticated", session_id: ID.memberSession, aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const snapshot = (await db.query("select public.get_member_engagement_snapshot() snapshot")).rows[0].snapshot;
      await db.query("reset role");
      await db.query("release savepoint quarterly_gate_snapshot");
      expect(snapshot.quarterlyGate).toMatchObject({ surveyId: ID.survey, unlocked: false, reason: "incomplete" });
    });
  });
});
