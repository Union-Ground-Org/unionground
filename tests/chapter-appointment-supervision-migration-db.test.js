// @vitest-environment node
//
// BUG-UG-CHAPTER-APPOINTMENT-SUPERVISION-IS-HALF-MIGRATED-LIST-CHAPTER-APPOINTMENTS-USES-THE-ORG-20260921
// SEC-UG-APPOINTMENT-AUTHORIZATION-IGNORES-ORGANIZATION-LEVEL-STEWARD-GRANTS-20260921
//
// An organization-wide coordinator grant must load reassignment candidates and
// reassign. Chapter-granted callers keep in-chapter authority. Revoked and
// non-supervisor callers stay refused with the original 42501 message. An
// organization-granted steward is an eligible candidate only while the grant
// sits inside an active membership of the appointment chapter's active
// organization.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const MIGRATION = "20260925030000_appointment_authorization_consolidation.sql";
const sql = stripComments(loadMigrationSql("20260925030000_appointment_authorization_consolidation")).toLowerCase();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const migrations = migrationFiles();

function latestBody(name) {
  const migration = [...migrations].reverse().find(({ sql: text }) => (
    stripComments(text).toLowerCase().includes(`function public.${name.toLowerCase()}(`)
  ));
  expect(migration?.name, `missing latest ${name}`).toBe(MIGRATION);
  return stripComments(fnBody(migration.sql, name)).toLowerCase();
}

describe("chapter appointment supervision org-grant repair (static)", () => {
  it("redefines both RPCs onto member_has_chapter_role and drops the caller member_roles gate", () => {
    expect(sql).toContain("create or replace function public.list_chapter_appointment_reassignment_candidates");
    expect(sql).toContain("create or replace function public.reassign_chapter_appointment");
    for (const name of [
      "list_chapter_appointment_reassignment_candidates",
      "reassign_chapter_appointment",
    ]) {
      const body = latestBody(name);
      expect(body).toContain("private.member_has_chapter_role(caller_chapter, array['coordinator','advisor','admin'])");
      expect(body).toContain("caller_chapter text := private.current_member_chapter()");
      expect(body).not.toContain("public.member_has_role");
      expect(body).not.toMatch(/from public\.member_roles r\s+where r\.user_id = caller/);
    }
  });

  it("pins the org-era caller gate in the database contract", () => {
    for (const sig of [
      "public.list_chapter_appointment_reassignment_candidates(p_appointment_id uuid)",
      "public.reassign_chapter_appointment(p_appointment_id uuid, p_steward_id uuid)",
    ]) {
      const entry = contract.functions.find((candidate) => candidate.sig === sig);
      expect(entry?.bodyContains).toContain("private.member_has_chapter_role(caller_chapter, array['coordinator','advisor','admin'])");
      expect(entry?.bodyContains).toContain("caller_chapter text := private.current_member_chapter()");
      expect(entry?.bodyForbids).toEqual([
        "member_has_role(array['coordinator', 'advisor', 'admin'])",
        "r.chapter_id is null or r.chapter_id = caller_chapter",
        "r.role = 'steward'",
      ]);
    }
  });
});

const ID = {
  org: "50902100-0000-4000-8000-000000000001",
  orgCoord: "50902100-0000-4000-8000-000000000101",
  chapterCoord: "50902100-0000-4000-8000-000000000102",
  member: "50902100-0000-4000-8000-000000000103",
  steward1: "50902100-0000-4000-8000-000000000104",
  steward2: "50902100-0000-4000-8000-000000000105",
  grantSteward: "50902100-0000-4000-8000-000000000106",
  foreignSteward: "50902100-0000-4000-8000-000000000107",
  foreignOrg: "50902100-0000-4000-8000-000000000002",
  orgSession: "50902100-0000-4000-8000-000000000201",
  chapterSession: "50902100-0000-4000-8000-000000000202",
  memberSession: "50902100-0000-4000-8000-000000000203",
  apptA: "50902100-0000-4000-8000-000000000301",
  apptB: "50902100-0000-4000-8000-000000000302",
};
const CHAPTER_A = "appt-sup-org-a";
const CHAPTER_B = "appt-sup-org-b";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("chapter appointment supervision org-grant repair on a disposable database", () => {
  let db;

  async function as(userId, sessionId, statement, values = []) {
    const savepoint = `appt_as_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await db.query(`savepoint ${savepoint}`);
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: userId,
        role: "authenticated",
        session_id: sessionId,
        aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const result = await db.query(statement, values);
      await db.query("reset role");
      await db.query(`release savepoint ${savepoint}`);
      return { code: "", rows: result.rows, message: "" };
    } catch (error) {
      await db.query(`rollback to savepoint ${savepoint}`);
      await db.query(`release savepoint ${savepoint}`);
      return { code: error.code || "?", rows: [], message: error.message || "" };
    }
  }

  async function seedSchedule(stewardId) {
    await db.query(
      `insert into public.member_appointment_schedules
         (steward_id, timezone, min_notice_minutes, buffer_before_minutes, buffer_after_minutes, max_per_day, accepting)
       values ($1, 'UTC', 0, 0, 0, 24, true)`,
      [stewardId],
    );
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      await db.query(
        "insert into public.member_appointment_windows (steward_id, weekday, start_minute, end_minute) values ($1, $2, 840, 1020)",
        [stewardId, weekday],
      );
    }
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "chapter-appointment-supervision-org-grant-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '30s'");
    await db.query("set local lock_timeout = '15s'");

    const users = [
      [ID.orgCoord, "appt-sup-org-coord@example.invalid"],
      [ID.chapterCoord, "appt-sup-chapter-coord@example.invalid"],
      [ID.member, "appt-sup-member@example.invalid"],
      [ID.steward1, "appt-sup-steward-1@example.invalid"],
      [ID.steward2, "appt-sup-steward-2@example.invalid"],
    ];
    for (const [id, email] of users) {
      await db.query("insert into auth.users(id, email) values ($1, $2)", [id, email]);
    }
    await db.query(
      "insert into public.organizations(id, slug, name, created_by) values ($1, 'appt-sup-org-grant', 'Appointment supervision org grant', $2)",
      [ID.org, ID.orgCoord],
    );
    await db.query(
      `insert into public.chapters(id, name, slug, organization_id, is_default, order_index)
       values ($1, 'Appointment supervision A', $1, $3, false, 9210),
              ($2, 'Appointment supervision B', $2, $3, false, 9211)`,
      [CHAPTER_A, CHAPTER_B, ID.org],
    );
    await db.query(
      "insert into public.org_security_policy(id, organization_id, require_staff_mfa) values (true, $1, true)",
      [ID.org],
    );

    const everyone = [ID.orgCoord, ID.chapterCoord, ID.member, ID.steward1, ID.steward2];
    for (const userId of everyone) {
      await db.query(
        "insert into public.organization_memberships(organization_id, user_id, status) values ($1, $2, 'active')",
        [ID.org, userId],
      );
      await db.query(
        "insert into public.member_chapter_memberships(user_id, chapter_id, status) values ($1, $2, 'active'), ($1, $3, 'active')",
        [userId, CHAPTER_A, CHAPTER_B],
      );
    }
    await db.query(
      `update public.member_profiles
         set chapter_id = $1,
             full_name = case id
               when $2 then 'Org Coordinator'
               when $3 then 'Chapter Coordinator'
               when $4 then 'Member Proof'
               when $5 then 'Steward One'
               else 'Steward Two'
             end
       where id = any($6::uuid[])`,
      [CHAPTER_A, ID.orgCoord, ID.chapterCoord, ID.member, ID.steward1, everyone],
    );

    await db.query(
      "insert into public.organization_role_grants(organization_id, user_id, role, granted_by) values ($1, $2, 'coordinator', $2)",
      [ID.org, ID.orgCoord],
    );
    expect((await db.query(
      "select count(*)::int as n from public.member_roles where user_id = $1",
      [ID.orgCoord],
    )).rows[0].n).toBe(0);

    await db.query(
      "insert into public.member_roles(user_id, role, chapter_id) values ($1, 'coordinator', $2)",
      [ID.chapterCoord, CHAPTER_A],
    );
    await db.query(
      "insert into public.member_role_chapters(user_id, role, chapter_id) values ($1, 'coordinator', $2)",
      [ID.chapterCoord, CHAPTER_A],
    );
    await db.query(
      "insert into public.member_roles(user_id, role, chapter_id) values ($1, 'steward', $3), ($2, 'steward', $3)",
      [ID.steward1, ID.steward2, CHAPTER_A],
    );
    await db.query(
      "insert into public.member_role_chapters(user_id, role, chapter_id) values ($1, 'steward', $3), ($2, 'steward', $3)",
      [ID.steward1, ID.steward2, CHAPTER_A],
    );

    await seedSchedule(ID.steward1);
    await seedSchedule(ID.steward2);

    const startsAt = (await db.query(`
      select ((date_trunc('day', timezone('UTC', now())) + interval '2 days' + interval '15 hours') at time zone 'UTC') as starts_at
    `)).rows[0].starts_at;
    await db.query(
      `insert into public.member_appointments(
         id, user_id, steward_id, chapter_id, appointment_type, duration_minutes,
         starts_at, ends_at, status, routed_via, reason_category
       ) values
         ($1, $3, $4, $5, 'office_hours', 30, $7::timestamptz, $7::timestamptz + interval '30 minutes', 'confirmed', 'steward', 'general'),
         ($2, $3, $4, $6, 'office_hours', 30, $7::timestamptz + interval '1 hour', $7::timestamptz + interval '90 minutes', 'confirmed', 'steward', 'general')`,
      [ID.apptA, ID.apptB, ID.member, ID.steward1, CHAPTER_A, CHAPTER_B, startsAt],
    );

    await db.query(
      `insert into auth.sessions(id, user_id, aal, created_at, updated_at) values
         ($1, $4, 'aal2', now(), now()),
         ($2, $5, 'aal2', now(), now()),
         ($3, $6, 'aal2', now(), now())`,
      [ID.orgSession, ID.chapterSession, ID.memberSession, ID.orgCoord, ID.chapterCoord, ID.member],
    );
    for (const userId of [ID.orgCoord, ID.chapterCoord]) {
      await db.query(
        `insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, created_at, updated_at)
         values (gen_random_uuid(), $1, 'appt-sup-totp', 'totp', 'verified', now(), now())`,
        [userId],
      );
    }
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("lets an org-wide-granted coordinator load candidates and reassign with no member_roles row", async () => {
    await db.query("savepoint org_grant_reassign");
    try {
      const leftover = await db.query("select count(*)::int as n from public.member_roles where user_id = $1", [ID.orgCoord]);
      expect(leftover.rows[0].n).toBe(0);
      const candidates = await as(
        ID.orgCoord,
        ID.orgSession,
        "select steward_id from public.list_chapter_appointment_reassignment_candidates($1)",
        [ID.apptA],
      );
      expect(candidates, candidates.message).toMatchObject({ code: "" });
      expect(candidates.rows.map((row) => row.steward_id)).toEqual([ID.steward2]);
      const reassigned = await as(
        ID.orgCoord,
        ID.orgSession,
        "select public.reassign_chapter_appointment($1, $2) as value",
        [ID.apptA, ID.steward2],
      );
      expect(reassigned, reassigned.message).toMatchObject({ code: "" });
      expect(reassigned.rows[0].value).toMatchObject({
        id: ID.apptA,
        stewardId: ID.steward2,
        stewardName: "Steward Two",
      });
    } finally {
      await db.query("rollback to savepoint org_grant_reassign");
      await db.query("release savepoint org_grant_reassign");
    }
  });

  async function seedGrantSteward() {
    await db.query("insert into auth.users(id, email) values ($1, 'appt-sup-grant-steward@example.invalid')", [ID.grantSteward]);
    await db.query(
      "insert into public.organization_memberships(organization_id, user_id, status) values ($1, $2, 'active')",
      [ID.org, ID.grantSteward],
    );
    await db.query(
      "insert into public.member_chapter_memberships(user_id, chapter_id, status) values ($1, $2, 'active')",
      [ID.grantSteward, CHAPTER_A],
    );
    await db.query("update public.member_profiles set chapter_id = $2, full_name = 'Steward Three' where id = $1", [ID.grantSteward, CHAPTER_A]);
    await db.query(
      "insert into public.organization_role_grants(organization_id, user_id, role, granted_by) values ($1, $2, 'steward', $3)",
      [ID.org, ID.grantSteward, ID.orgCoord],
    );
    await seedSchedule(ID.grantSteward);
  }

  it("admits an organization-granted steward with no member_roles row until the membership is revoked", async () => {
    await db.query("savepoint org_grant_steward");
    try {
      await seedGrantSteward();
      expect((await db.query("select count(*)::int as n from public.member_roles where user_id = $1", [ID.grantSteward])).rows[0].n).toBe(0);
      const candidates = await as(
        ID.orgCoord,
        ID.orgSession,
        "select steward_id from public.list_chapter_appointment_reassignment_candidates($1)",
        [ID.apptA],
      );
      expect(candidates, candidates.message).toMatchObject({ code: "" });
      expect(candidates.rows.map((row) => row.steward_id)).toEqual([ID.grantSteward, ID.steward2]);

      await db.query("savepoint org_grant_steward_reassign");
      const reassigned = await as(
        ID.orgCoord,
        ID.orgSession,
        "select public.reassign_chapter_appointment($1, $2) as value",
        [ID.apptA, ID.grantSteward],
      );
      expect(reassigned, reassigned.message).toMatchObject({ code: "" });
      expect(reassigned.rows[0].value.stewardId).toBe(ID.grantSteward);
      await db.query("rollback to savepoint org_grant_steward_reassign");
      await db.query("release savepoint org_grant_steward_reassign");

      await db.query(
        "update public.organization_memberships set status = 'revoked', revoked_at = now() where organization_id = $1 and user_id = $2",
        [ID.org, ID.grantSteward],
      );
      const after = await as(
        ID.orgCoord,
        ID.orgSession,
        "select steward_id from public.list_chapter_appointment_reassignment_candidates($1)",
        [ID.apptA],
      );
      expect(after, after.message).toMatchObject({ code: "" });
      expect(after.rows.map((row) => row.steward_id)).toEqual([ID.steward2]);
      const refused = await as(
        ID.orgCoord,
        ID.orgSession,
        "select public.reassign_chapter_appointment($1, $2) as value",
        [ID.apptA, ID.grantSteward],
      );
      expect(refused).toMatchObject({ code: "22023" });
      expect(refused.message).toMatch(/appointment unavailable/i);
    } finally {
      await db.query("rollback to savepoint org_grant_steward");
      await db.query("release savepoint org_grant_steward");
    }
  });

  it("keeps organization steward grants inside their own active organization", async () => {
    await db.query("savepoint org_grant_boundary");
    try {
      await seedGrantSteward();
      await db.query(
        "insert into public.organizations(id, slug, name, created_by) values ($1, 'appt-sup-foreign-org', 'Appointment supervision foreign org', $2)",
        [ID.foreignOrg, ID.orgCoord],
      );
      await db.query("insert into auth.users(id, email) values ($1, 'appt-sup-foreign-steward@example.invalid')", [ID.foreignSteward]);
      await db.query(
        "insert into public.organization_memberships(organization_id, user_id, status) values ($1, $2, 'active')",
        [ID.foreignOrg, ID.foreignSteward],
      );
      await db.query(
        "insert into public.organization_role_grants(organization_id, user_id, role, granted_by) values ($1, $2, 'steward', $2)",
        [ID.foreignOrg, ID.foreignSteward],
      );
      await seedSchedule(ID.foreignSteward);

      const resolved = async () => (await db.query(
        "select steward_id from private.appointment_stewards_for_chapter($1) order by steward_id",
        [CHAPTER_A],
      )).rows.map((row) => row.steward_id);
      expect(await resolved()).toEqual([ID.steward1, ID.steward2, ID.grantSteward].sort());

      await db.query("update public.organizations set status = 'suspended' where id = $1", [ID.org]);
      // A suspended tenant keeps no canonical-grant steward; legacy rows are
      // bounded by membership, as the 20260923020000 boundary defines them.
      expect(await resolved()).toEqual([ID.steward1, ID.steward2].sort());
    } finally {
      await db.query("rollback to savepoint org_grant_boundary");
      await db.query("release savepoint org_grant_boundary");
    }
  });

  it("lets a chapter-granted coordinator load candidates and reassign inside their chapter", async () => {
    await db.query("savepoint chapter_grant_reassign");
    try {
      const candidates = await as(
        ID.chapterCoord,
        ID.chapterSession,
        "select steward_id from public.list_chapter_appointment_reassignment_candidates($1)",
        [ID.apptA],
      );
      expect(candidates, candidates.message).toMatchObject({ code: "" });
      expect(candidates.rows.map((row) => row.steward_id)).toEqual([ID.steward2]);
      const reassigned = await as(
        ID.chapterCoord,
        ID.chapterSession,
        "select public.reassign_chapter_appointment($1, $2) as value",
        [ID.apptA, ID.steward2],
      );
      expect(reassigned, reassigned.message).toMatchObject({ code: "" });
      expect(reassigned.rows[0].value.stewardId).toBe(ID.steward2);
    } finally {
      await db.query("rollback to savepoint chapter_grant_reassign");
      await db.query("release savepoint chapter_grant_reassign");
    }
  });

  it("refuses a chapter-granted coordinator for another chapter's appointment", async () => {
    const otherAppointment = await as(
      ID.chapterCoord,
      ID.chapterSession,
      "select steward_id from public.list_chapter_appointment_reassignment_candidates($1)",
      [ID.apptB],
    );
    expect(otherAppointment.code, otherAppointment.message).toBe("22023");
    expect(otherAppointment.message).toMatch(/appointment unavailable/i);

    await db.query("savepoint other_chapter_current");
    try {
      await db.query("update public.member_profiles set chapter_id = $2 where id = $1", [ID.chapterCoord, CHAPTER_B]);
      const switched = await as(
        ID.chapterCoord,
        ID.chapterSession,
        "select steward_id from public.list_chapter_appointment_reassignment_candidates($1)",
        [ID.apptB],
      );
      expect(switched.code, switched.message).toBe("42501");
      expect(switched.message).toMatch(/appointment supervision unavailable/);
      const reassign = await as(
        ID.chapterCoord,
        ID.chapterSession,
        "select public.reassign_chapter_appointment($1, $2)",
        [ID.apptB, ID.steward2],
      );
      expect(reassign.code, reassign.message).toBe("42501");
      expect(reassign.message).toMatch(/appointment supervision unavailable/);
    } finally {
      await db.query("rollback to savepoint other_chapter_current");
      await db.query("release savepoint other_chapter_current");
    }
  });

  it("refuses a revoked-role caller with the unchanged 42501 message", async () => {
    await db.query("savepoint revoke_org_grant");
    try {
      await db.query("delete from public.organization_role_grants where user_id = $1", [ID.orgCoord]);
      const candidates = await as(
        ID.orgCoord,
        ID.orgSession,
        "select steward_id from public.list_chapter_appointment_reassignment_candidates($1)",
        [ID.apptA],
      );
      expect(candidates.code, candidates.message).toBe("42501");
      expect(candidates.message).toBe("appointment supervision unavailable");
      const reassign = await as(
        ID.orgCoord,
        ID.orgSession,
        "select public.reassign_chapter_appointment($1, $2)",
        [ID.apptA, ID.steward2],
      );
      expect(reassign.code, reassign.message).toBe("42501");
      expect(reassign.message).toBe("appointment supervision unavailable");
    } finally {
      await db.query("rollback to savepoint revoke_org_grant");
      await db.query("release savepoint revoke_org_grant");
    }
  });

  it("refuses a non-supervisor member with the unchanged 42501 message", async () => {
    const candidates = await as(
      ID.member,
      ID.memberSession,
      "select steward_id from public.list_chapter_appointment_reassignment_candidates($1)",
      [ID.apptA],
    );
    expect(candidates.code, candidates.message).toBe("42501");
    expect(candidates.message).toBe("appointment supervision unavailable");
    const reassign = await as(
      ID.member,
      ID.memberSession,
      "select public.reassign_chapter_appointment($1, $2)",
      [ID.apptA, ID.steward2],
    );
    expect(reassign.code, reassign.message).toBe("42501");
    expect(reassign.message).toBe("appointment supervision unavailable");
  });
});
