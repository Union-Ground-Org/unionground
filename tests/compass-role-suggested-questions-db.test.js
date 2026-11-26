// @vitest-environment node
//
// REQ-UG-COMPASS-ROLE-SUGGESTED-QUESTIONS-20261001. A live apply proves the
// four definitions satisfy the registry's default-validity CHECK, reach members
// through get_member_organization_configuration().switches, and that an admin's
// edited list is bounded by the registry's text_list rules.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";

const MIGRATION = "supabase/migrations/20261003054000_compass_role_suggested_questions.sql";
const migration = readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8");
const SWITCH = "features.ai_assistant.suggested_questions";
const LISTS = {
  member: "lists.ai_assistant.suggested_questions_member",
  steward: "lists.ai_assistant.suggested_questions_steward",
  admin: "lists.ai_assistant.suggested_questions_admin",
};

describe("role suggested questions migration (static)", () => {
  it("only registers definitions, idempotently", () => {
    expect(migration).toMatch(/\nbegin;\n/);
    expect(migration.trimEnd()).toMatch(/\ncommit;$/);
    expect(migration).toMatch(/\non conflict \(key\) do nothing;/);
    const code = stripComments(migration);
    expect(code).not.toMatch(/\b(grant|revoke|create|alter|drop|update|delete)\b/i);
  });
});

const ID = {
  org: "51002200-0000-4000-8000-000000000001",
  member: "51002200-0000-4000-8000-000000000101",
  admin: "51002200-0000-4000-8000-000000000102",
  memberSession: "51002200-0000-4000-8000-000000000201",
  adminSession: "51002200-0000-4000-8000-000000000202",
};
const CHAPTER = "compass-suggested-chapter";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("role suggested questions on a disposable database", () => {
  let db;

  async function as(userId, sessionId, sql, values = []) {
    await db.query("savepoint compass_suggested");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: userId, role: "authenticated", session_id: sessionId, aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const result = await db.query(sql, values);
      await db.query("reset role");
      await db.query("release savepoint compass_suggested");
      return result.rows[0];
    } catch (error) {
      await db.query("rollback to savepoint compass_suggested");
      await db.query("reset role").catch(() => {});
      throw error;
    }
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "compass-suggested-questions-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '30s'");
    await db.query("set local lock_timeout = '15s'");
    await db.query(
      "insert into auth.users (id,email) values ($1,'compass-suggested-member@example.invalid'),($2,'compass-suggested-admin@example.invalid')",
      [ID.member, ID.admin],
    );
    await db.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,'compass-suggested-org','Compass suggestions proof org',$2)",
      [ID.org, ID.admin],
    );
    await db.query(
      "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,92201)",
      [CHAPTER, ID.org],
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

  it("registers the switch and three bounded role lists in the AI category for members to read", async () => {
    const rows = (await db.query(
      "select key, value_kind, default_value, minimum, maximum, category, member_visible from public.platform_setting_definitions where key = any($1) order by sort_order",
      [[SWITCH, ...Object.values(LISTS)]],
    )).rows;
    expect(rows.map((row) => row.key)).toEqual([SWITCH, LISTS.member, LISTS.steward, LISTS.admin]);
    expect(rows[0]).toMatchObject({ value_kind: "boolean", default_value: true, category: "ai_assistant", member_visible: true });
    for (const row of rows.slice(1)) {
      expect(row).toMatchObject({ value_kind: "text_list", minimum: 0, maximum: 8, category: "ai_assistant", member_visible: true });
    }
    expect(rows[1].default_value).toHaveLength(6);
    expect(rows[2].default_value[0]).toBe("How many issues are open and how many are resolved?");
  });

  it("hands members the organization's effective lists", async () => {
    const before = await as(ID.member, ID.memberSession, "select public.get_member_organization_configuration() c");
    expect(before.c.switches[SWITCH]).toBe(true);
    expect(before.c.switches[LISTS.member]).toHaveLength(6);
    await as(ID.admin, ID.adminSession, "select public.update_organization_setting($1, $2::jsonb) r", [LISTS.member, JSON.stringify(["Who is my steward?"])]);
    const after = await as(ID.member, ID.memberSession, "select public.get_member_organization_configuration() c");
    expect(after.c.switches[LISTS.member]).toEqual(["Who is my steward?"]);
  });

  it("refuses a list over eight questions or a question longer than 80 characters", async () => {
    const tooMany = Array.from({ length: 9 }, (_, index) => `Question ${index + 1}?`);
    await expect(as(ID.admin, ID.adminSession, "select public.update_organization_setting($1, $2::jsonb) r", [LISTS.steward, JSON.stringify(tooMany)]))
      .rejects.toMatchObject({ code: "22023" });
    await expect(as(ID.admin, ID.adminSession, "select public.update_organization_setting($1, $2::jsonb) r", [LISTS.admin, JSON.stringify([`${"x".repeat(80)}?`])]))
      .rejects.toMatchObject({ code: "22023" });
  });

  it("lets only an admin edit the lists", async () => {
    await expect(as(ID.member, ID.memberSession, "select public.update_organization_setting($1, $2::jsonb) r", [LISTS.member, JSON.stringify(["Mine?"])]))
      .rejects.toMatchObject({ code: "42501" });
  });
});
