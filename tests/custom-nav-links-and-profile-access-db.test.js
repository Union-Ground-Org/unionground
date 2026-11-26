// @vitest-environment node
//
// REQ-UG-CUSTOM-NAV-LINKS-20261001 and
// REQ-UG-ACCESS-HISTORY-PROFILE-VIEWS-20261001 (CR-086).
//
// On a disposable database this proves that the four custom-link settings
// accept only an https:// address and a short label from every writer, reach
// members through the member-safe configuration, and that staff reads and
// updates of a member's profile now produce viewed_profile / updated_profile
// access events, never for the member's own access and never across tenants.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";

const MIGRATION = "supabase/migrations/20261003052000_custom_nav_links_and_profile_access_history.sql";
const migration = readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8");
const URL_1 = "text.navigation.custom_link_1_url";
const LABEL_1 = "text.navigation.custom_link_1_label";

describe("custom links and profile access history (static)", () => {
  it("registers four empty member-visible text settings and no access-history switch", () => {
    expect(migration).toMatch(/\nbegin;\n/);
    expect(migration.trimEnd()).toMatch(/\ncommit;$/);
    for (const key of [LABEL_1, URL_1, "text.navigation.custom_link_2_label", "text.navigation.custom_link_2_url"]) {
      expect(migration).toContain(`('${key}', 'text'`);
    }
    expect(migration).toMatch(/0036_custom_links_config\.sql/);
    const code = stripComments(migration);
    expect(code).toContain("add constraint organization_setting_values_custom_nav_links");
    expect(code).not.toMatch(/features\.[a-z_]*access_history/);
    expect(code).toMatch(/create or replace function public\.get_member_operational_profile\(p_member_user_id uuid\)\nreturns jsonb\nlanguage plpgsql\nvolatile/);
  });
});

const ID = {
  org: "51801820-0000-4000-8000-000000000001",
  otherOrg: "51801820-0000-4000-8000-000000000002",
  admin: "51801820-0000-4000-8000-000000000101",
  member: "51801820-0000-4000-8000-000000000102",
  outsider: "51801820-0000-4000-8000-000000000103",
  adminSession: "51801820-0000-4000-8000-000000000201",
  memberSession: "51801820-0000-4000-8000-000000000202",
  outsiderSession: "51801820-0000-4000-8000-000000000203",
};
const CHAPTER = "profile-access-chapter";
const OUTSIDE_CHAPTER = "profile-access-outside";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("custom links and profile access history on a disposable database", () => {
  let db;

  async function as(userId, sessionId, sql, values = []) {
    await db.query("savepoint access_call");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: userId, role: "authenticated", session_id: sessionId, aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const result = await db.query(sql, values);
      await db.query("reset role");
      await db.query("release savepoint access_call");
      return result.rows[0] ? Object.values(result.rows[0])[0] : null;
    } catch (error) {
      await db.query("rollback to savepoint access_call");
      await db.query("reset role").catch(() => {});
      throw error;
    }
  }

  async function failure(promise) {
    try {
      await promise;
    } catch (error) {
      return { code: error.code, message: error.message };
    }
    throw new Error("expected the call to fail");
  }

  async function rawFailure(sql, values = []) {
    await db.query("savepoint access_raw");
    try {
      await db.query(sql, values);
    } catch (error) {
      await db.query("rollback to savepoint access_raw");
      return { code: error.code, message: error.message };
    }
    await db.query("release savepoint access_raw");
    throw new Error("expected the statement to fail");
  }

  async function withChange(check) {
    await db.query("savepoint access_change");
    try {
      await check();
    } finally {
      await db.query("rollback to savepoint access_change");
    }
  }

  const events = async (subject = ID.member) => (await db.query(
    "select actor_user_id, actor_role, action, entity_type from public.member_access_events where subject_user_id = $1 order by occurred_at, action",
    [subject],
  )).rows;
  const setLink = (key, value) => as(ID.admin, ID.adminSession,
    "select public.update_organization_setting($1, $2::jsonb) r", [key, JSON.stringify(value)]);

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "custom-links-profile-access-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    await db.query(
      `insert into auth.users (id, email) values
        ($1,'profile-access-admin@example.invalid'), ($2,'profile-access-member@example.invalid'), ($3,'profile-access-outsider@example.invalid')`,
      [ID.admin, ID.member, ID.outsider],
    );
    await db.query(
      `insert into public.organizations(id, slug, name, created_by) values
        ($1, 'profile-access-org', 'Profile access proof org', $3), ($2, 'profile-access-other', 'Profile access other org', $4)`,
      [ID.org, ID.otherOrg, ID.admin, ID.outsider],
    );
    await db.query(
      `insert into public.chapters(id, name, slug, organization_id, is_default, order_index) values
        ($1, 'Profile Access Chapter', $1, $3, false, 91821), ($2, 'Profile Access Outside', $2, $4, false, 91822)`,
      [CHAPTER, OUTSIDE_CHAPTER, ID.org, ID.otherOrg],
    );
    for (const [userId, orgId, chapterId] of [[ID.admin, ID.org, CHAPTER], [ID.member, ID.org, CHAPTER], [ID.outsider, ID.otherOrg, OUTSIDE_CHAPTER]]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [orgId, userId]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [userId, chapterId]);
      await db.query("update public.member_profiles set chapter_id = $2 where id = $1", [userId, chapterId]);
    }
    await db.query(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2),($3,$4,'admin',$4)",
      [ID.org, ID.admin, ID.otherOrg, ID.outsider],
    );
    await db.query(
      `insert into auth.sessions(id,user_id,aal,created_at,updated_at) values
        ($1,$2,'aal2',now(),now()), ($3,$4,'aal2',now(),now()), ($5,$6,'aal2',now(),now())`,
      [ID.adminSession, ID.admin, ID.memberSession, ID.member, ID.outsiderSession, ID.outsider],
    );
    await db.query(
      `insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
       select gen_random_uuid(), u, 'proof-totp', 'totp', 'verified', now(), now() from unnest($1::uuid[]) u`,
      [[ID.admin, ID.member, ID.outsider]],
    );
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  describe("custom navigation links", () => {
    it("registers four empty member-visible general settings", async () => {
      const rows = (await db.query(
        "select key, value_kind, default_value, category, member_visible from public.platform_setting_definitions where key like 'text.navigation.custom_link_%' order by key",
      )).rows;
      expect(rows).toHaveLength(4);
      for (const row of rows) expect(row).toMatchObject({ value_kind: "text", default_value: "", category: "general", member_visible: true });
    });

    it("stores an https link and shows it to members", async () => {
      await withChange(async () => {
        await setLink(LABEL_1, "Contract library");
        await setLink(URL_1, "https://example.org/contracts?year=2026#article-12");
        const configuration = await as(ID.member, ID.memberSession, "select public.get_member_organization_configuration() r");
        expect(configuration.switches).toMatchObject({ [LABEL_1]: "Contract library", [URL_1]: "https://example.org/contracts?year=2026#article-12" });
        await setLink(URL_1, "");
        expect((await as(ID.member, ID.memberSession, "select public.get_member_organization_configuration() r")).switches[URL_1]).toBe("");
      });
    });

    it.each([
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html,<b>hi</b>",
      "http://example.org/",
      "https://user:secret@example.org/",
      "https://example.org/a b",
      "https://example.org/\"onmouseover=x",
      "//example.org/",
      "example.org",
    ])("refuses %s as a link address from every writer", async (address) => {
      expect((await failure(setLink(URL_1, address))).code).toBe("23514");
      expect((await rawFailure(
        "insert into public.organization_setting_values(organization_id, setting_key, value, updated_by) values ($1, $2, $3::jsonb, $4)",
        [ID.org, URL_1, JSON.stringify(address), ID.admin],
      )).code).toBe("23514");
    });

    it("refuses a long or unsafe label", async () => {
      expect((await failure(setLink(LABEL_1, "x".repeat(41)))).code).toBe("23514");
      expect((await failure(setLink(LABEL_1, "<b>Library</b>"))).code).toBe("23514");
      expect((await failure(setLink(LABEL_1, " padded"))).code).toBe("23514");
    });
  });

  describe("staff profile access history", () => {
    it("records an admin's profile view once within ten minutes, never the member's own", async () => {
      await withChange(async () => {
        const profile = await as(ID.admin, ID.adminSession, "select public.get_member_operational_profile($1) r", [ID.member]);
        expect(profile).toMatchObject({ userId: ID.member });
        await as(ID.admin, ID.adminSession, "select public.get_member_operational_profile($1) r", [ID.member]);
        expect(await events()).toEqual([{ actor_user_id: ID.admin, actor_role: "admin", action: "viewed_profile", entity_type: "member" }]);
        await as(ID.admin, ID.adminSession, "select public.get_member_operational_profile($1) r", [ID.admin]);
        expect(await events(ID.admin)).toEqual([]);
      });
    });

    it("records a staff save as one update, not an extra view", async () => {
      await withChange(async () => {
        await as(ID.admin, ID.adminSession,
          "select public.save_member_operational_profile($1, 0, '{\"jobTitle\":\"Analyst\"}'::jsonb, gen_random_uuid()) r", [ID.member]);
        expect(await events()).toEqual([{ actor_user_id: ID.admin, actor_role: "admin", action: "updated_profile", entity_type: "member" }]);
      });
    });

    it("records a bulk update for each member it changes", async () => {
      await withChange(async () => {
        await as(ID.admin, ID.adminSession,
          "select public.bulk_update_member_operational_profiles(array[$1::uuid], 'department', 'Claims', gen_random_uuid()) r", [ID.member]);
        expect((await events()).map((row) => row.action)).toEqual(["updated_profile"]);
      });
    });

    it("shows the events in the member's own access history", async () => {
      await withChange(async () => {
        await as(ID.admin, ID.adminSession, "select public.get_member_operational_profile($1) r", [ID.member]);
        await as(ID.admin, ID.adminSession,
          "select public.save_member_operational_profile($1, 0, '{\"department\":\"Claims\"}'::jsonb, gen_random_uuid()) r", [ID.member]);
        const history = await as(ID.member, ID.memberSession, "select public.list_my_access_history(30) r");
        expect(history.map((item) => item.action).sort()).toEqual(["updated_profile", "viewed_profile"]);
        expect(history.every((item) => item.entityType === "member" && item.organizationId === ID.org)).toBe(true);
      });
    });

    it("never records across tenants or for account-deletion attribution changes", async () => {
      await withChange(async () => {
        expect((await failure(as(ID.outsider, ID.outsiderSession, "select public.get_member_operational_profile($1) r", [ID.member]))).code)
          .toBe("P0002");
        expect(await events()).toEqual([]);
        await as(ID.admin, ID.adminSession,
          "select public.save_member_operational_profile($1, 0, '{\"jobTitle\":\"Analyst\"}'::jsonb, gen_random_uuid()) r", [ID.member]);
        await db.query("delete from public.member_access_events where subject_user_id = $1", [ID.member]);
        await db.query("update public.organization_member_operational_profiles set updated_by = null where member_user_id = $1", [ID.member]);
        expect(await events()).toEqual([]);
      });
    });
  });
});
