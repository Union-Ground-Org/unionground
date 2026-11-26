// @vitest-environment node
//
// BUG-UG-ROLE-SCOPE-EDGES-IN-ROSTER-AWARDS-GLOW-AND-ADVISOR-COUNTS-20261117
// (#9043): one class of role and scope edges. Static pins on the migration
// text, then live proofs on an owned disposable database, each inside one
// rolled-back transaction. Ledger 3 (a retained bid's award) already holds on
// Main and is proved in tests/unit-stewards-member-data-gates-db.test.js;
// ledger 38 (legacy cases with no chapter) holds on Main through #8851, which
// refuses such a case and validates member_cases_chapter_present.
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const migrationName = readdirSync("supabase/migrations").find((name) => name.endsWith("_role_scope_edges.sql"));
const sql = readFileSync(`supabase/migrations/${migrationName}`, "utf8");

describe("role scope edges migration (static)", () => {
  it("is one atomic migration that pins all three predecessors", () => {
    expect(sql).toMatch(/^begin;$/mu);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    for (const name of ["private.workload_rebalancing", "public.set_chapter_notice_glow", "public.get_chapter_notice_glow"]) {
      expect(sql).toContain(`raise exception 'unreviewed predecessor: ${name}' using errcode = '55000';`);
    }
  });

  it("uses the chapter-wide notice test for the glow colour and no longer the steward chapter role", () => {
    expect(sql).not.toContain("private.member_has_chapter_role(clean_chapter, array['steward', 'admin', 'vp'])");
    expect(sql.match(/private\.chapter_notice_scope_allowed\(clean_chapter, null, null\)/gu)).toHaveLength(2);
  });

  it("adds no grant and leaves the advisor overview alone (ledger 38 holds on Main through #8851)", () => {
    expect(sql).not.toMatch(/^\s*grant /imu);
    expect(sql).not.toContain("get_advisor_overview");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("role scope edges on an owned disposable database", () => {
  let db;
  const sessions = new Map();
  const owner = async () => { await db.query("reset role"); await db.query("select set_config('request.jwt.claims','',true)"); };
  async function as(userId, query, params = [], aal = "aal2") {
    await owner();
    await db.query("savepoint edge_call");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: userId, session_id: sessions.get(userId), aal, role: "authenticated" })]);
      await db.query("set local role authenticated");
      const result = await db.query(query, params);
      await db.query("release savepoint edge_call");
      return { code: "", rows: result.rows, value: result.rows[0]?.value };
    } catch (error) {
      await db.query("rollback to savepoint edge_call");
      return { code: error.code, message: error.message };
    } finally {
      await owner();
    }
  }

  async function organization(label) {
    const org = randomUUID();
    const chapter = `edge-${label}-${org.slice(0, 8)}`;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,$2)", [org, `Fictional ${label}`]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$2,$1,$3,9961)", [chapter, `Fictional ${label} chapter`, org]);
    return { org, chapter };
  }

  async function person(t, label, { orgRoles = [], chapterRoles = [] } = {}) {
    const id = randomUUID();
    await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${id}@role-scope-edges.invalid`]);
    await db.query("update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1", [id, t.chapter, `Fictional ${label}`]);
    await db.query("insert into public.organization_memberships(user_id,organization_id,status) values($1,$2,'active')", [id, t.org]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, t.chapter]);
    const session = randomUUID();
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, id]);
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    sessions.set(id, session);
    for (const role of orgRoles) await db.query("insert into public.organization_role_grants(user_id,organization_id,role) values($1,$2,$3)", [id, t.org, role]);
    for (const role of chapterRoles) await chapterGrant(t, id, role);
    return id;
  }
  async function chapterGrant(t, id, role) {
    await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing", [id, role, t.chapter]);
    await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [id, role, t.chapter]);
  }
  async function unit(t, label) {
    const id = randomUUID();
    await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$2,$3,$4)", [id, t.org, t.chapter, `Fictional ${label}`]);
    return id;
  }
  const joinUnit = (t, unitId, user) => db.query("insert into private.chapter_unit_members(unit_id,chapter_id,user_id) values($1,$2,$3)", [unitId, t.chapter, user]);
  const scope = (t, unitId, user, role = "steward") => db.query("insert into private.chapter_role_scopes(user_id,chapter_id,role,unit_id) values($1,$2,$3,$4)", [user, t.chapter, role, unitId]);

  beforeEach(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "role-scope-edges-rollback" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout='120s'");
    await db.query("set local lock_timeout='15s'");
  }, 60000);
  afterEach(async () => { if (db) { await db.query("rollback").catch(() => {}); await db.end(); } });

  describe("ledger 115: the workload roster", () => {
    async function chapterWithUnits() {
      const t = await organization("roster");
      const [one, two] = [await unit(t, "Unit One"), await unit(t, "Unit Two")];
      const people = {
        stewardOne: await person(t, "Unit One Steward", { chapterRoles: ["steward"] }),
        stewardTwo: await person(t, "Unit Two Steward", { chapterRoles: ["steward"] }),
      };
      await joinUnit(t, one, people.stewardOne);
      await joinUnit(t, two, people.stewardTwo);
      await scope(t, one, people.stewardOne);
      await scope(t, two, people.stewardTwo);
      return { t, one, two, people };
    }
    const roster = async (user) => {
      const answer = await as(user, "select public.get_steward_workload_intelligence(12) -> 'rebalancing' -> 'stewards' as value");
      expect(answer.code, answer.message).toBe("");
      return new Set((answer.value ?? []).map((row) => row.userId));
    };

    it("lists a unit steward who also holds a chapter-wide coordinator grant to a steward of another unit", async () => {
      const { t, people } = await chapterWithUnits();
      expect((await roster(people.stewardOne)).has(people.stewardTwo)).toBe(false);
      // The role setter allows a chapter-wide coordinator grant beside a kept unit steward scope.
      await chapterGrant(t, people.stewardTwo, "coordinator");
      const seen = await roster(people.stewardOne);
      expect(seen.has(people.stewardTwo)).toBe(true);
      expect(seen.has(people.stewardOne)).toBe(true);
    });

    it("keeps a coordinator grant that is itself limited to a unit out of other units' rosters", async () => {
      const { t, two, people } = await chapterWithUnits();
      await chapterGrant(t, people.stewardTwo, "coordinator");
      await scope(t, two, people.stewardTwo, "coordinator");
      expect((await roster(people.stewardOne)).has(people.stewardTwo)).toBe(false);
    });

    it("does not count a chapter-wide grant whose chapter membership has ended", async () => {
      const { t, people } = await chapterWithUnits();
      await chapterGrant(t, people.stewardTwo, "coordinator");
      await db.query("update public.member_chapter_memberships set status='revoked',revoked_at=now() where user_id=$1 and chapter_id=$2", [people.stewardTwo, t.chapter]);
      expect((await roster(people.stewardOne)).has(people.stewardTwo)).toBe(false);
    });
  });

  describe("ledger 205: the chapter notice glow colour", () => {
    const setGlow = (user, chapter, colour) => as(user, "select public.set_chapter_notice_glow($1,$2) value", [chapter, colour]);
    const getGlow = (user, chapter) => as(user, "select public.get_chapter_notice_glow($1) value", [chapter]);
    const stored = async (chapter) => (await db.query("select notice_glow from public.chapters where id=$1", [chapter])).rows[0].notice_glow;

    // Since #7663 every steward grant has a unit. The steward kinds Main's
    // setter still admitted were the carry-over steward (its unit mark keeps
    // chapter-wide reads) and an organization steward grant; fixtures follow
    // tests/unit-steward-notice-audiences-db.test.js.
    async function carryOverSteward(t, unitId) {
      const id = await person(t, "Carry-over Steward", { chapterRoles: ["steward"] });
      await joinUnit(t, unitId, id);
      await scope(t, unitId, id);
      await db.query("set constraints all immediate");
      await db.query("alter table private.chapter_role_scopes disable trigger a01_reject_carry_over_update");
      await db.query("update private.chapter_role_scopes set legacy_chapter_coverage=true where user_id=$1 and chapter_id=$2 and role='steward'", [id, t.chapter]);
      await db.query("alter table private.chapter_role_scopes enable trigger a01_reject_carry_over_update");
      await db.query("set constraints all deferred");
      return id;
    }
    async function organizationSteward(t, unitId, carried) {
      const id = await person(t, `Organization Steward ${carried ? "carried" : "narrowed"}`);
      await db.query("set constraints all immediate");
      await db.query("alter table private.organization_steward_unit_assignments disable trigger a01_reject_organization_assignment_insert");
      await db.query("set constraints all deferred");
      await db.query("insert into public.organization_role_grants(user_id,organization_id,role) values($1,$2,'steward')", [id, t.org]);
      await db.query("insert into private.organization_steward_unit_assignments(organization_id,user_id,chapter_id,unit_id,legacy_chapter_coverage) values($1,$2,$3,$4,$5)", [t.org, id, t.chapter, unitId, carried]);
      await db.query("set constraints all immediate");
      await db.query("alter table private.organization_steward_unit_assignments enable trigger a01_reject_organization_assignment_insert");
      await db.query("set constraints all deferred");
      return id;
    }

    it("refuses every steward who may not send a chapter-wide notice and does not offer it the control", async () => {
      const t = await organization("glow");
      const unitOne = await unit(t, "Glow Unit");
      const unitSteward = await person(t, "Unit Steward", { chapterRoles: ["steward"] });
      await joinUnit(t, unitOne, unitSteward);
      await scope(t, unitOne, unitSteward);
      const carried = await carryOverSteward(t, unitOne);
      const narrowedOrganization = await organizationSteward(t, unitOne, false);
      const carriedOrganization = await organizationSteward(t, unitOne, true);
      for (const user of [unitSteward, carried, narrowedOrganization, carriedOrganization]) {
        const notice = await as(user, "select private.chapter_notice_scope_allowed($1, null, null) value", [t.chapter]);
        // The rule Main applies to chapter-wide notices (#7664).
        expect(notice.code === "42501" || notice.value === false, notice.message).toBe(true);
        expect(await getGlow(user, t.chapter)).toMatchObject({ code: "", value: { chapterId: t.chapter, glow: "green", canChange: false } });
        expect(await setGlow(user, t.chapter, "gold")).toMatchObject({ code: "42501", message: "chapter notice role required" });
      }
      expect(await stored(t.chapter)).toBe("green");
    });

    it("keeps the colour for chapter leadership, an organization admin and an office that posts notices", async () => {
      const t = await organization("glow-lead");
      const chapterAdmin = await person(t, "Chapter Admin", { chapterRoles: ["admin"] });
      const chapterVp = await person(t, "Chapter VP", { chapterRoles: ["vp"] });
      const organizationAdmin = await person(t, "Organization Admin", { orgRoles: ["admin"] });
      const secretary = await person(t, "Secretary", { chapterRoles: ["secretary"] });
      for (const [user, colour] of [[chapterAdmin, "blue"], [chapterVp, "gold"], [organizationAdmin, "violet"], [secretary, "green"]]) {
        expect(await getGlow(user, t.chapter)).toMatchObject({ code: "", value: { canChange: true } });
        const saved = await setGlow(user, t.chapter, colour);
        expect(saved.code, saved.message).toBe("");
        expect(await stored(t.chapter)).toBe(colour);
      }
    });
  });
});
