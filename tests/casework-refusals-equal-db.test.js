// @vitest-environment node
// SEC-UG-CASEWORK-REFUSALS-REVEAL-ANOTHER-ORGANIZATIONS-ROW-20261115 (#8795).
// Four casework actions must refuse a live row the caller may not reach
// exactly as they refuse an id that does not exist (same SQLSTATE and
// message), so a refusal never reveals that the row exists. Three pairs, as
// the non-interference sweep (#8359) draws them: another organization's row
// for every member role, another chapter's row of the same organization for
// every chapter-scoped role (and a President whose stale role row names that
// chapter), and another unit's row of the same chapter for a unit-scoped
// steward. Every row is fictional and every write rolls back on the
// runner-owned database.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql } from "./helpers/migration.js";

describe("casework refusal migration", () => {
  it("guards every predecessor body and reads no row with INTO STRICT before its access check", () => {
    const SQL = loadMigrationSql("casework_refusals_equal_for_missing_and_foreign");
    for (const name of ["casework_acknowledge_alert", "casework_add_management_addendum", "casework_request_deadline_extension", "casework_review_retaliation_pattern"]) {
      expect(SQL).toContain(`unreviewed predecessor: public.${name}`);
      expect(SQL).toContain(`CREATE OR REPLACE FUNCTION public.${name}(`);
    }
    expect(SQL).not.toMatch(/into\s+strict/i);
  });

  it("sets its own search path before the guards, so the hosted runner's empty path reads the same definitions", () => {
    const SQL = loadMigrationSql("casework_refusals_equal_for_missing_and_foreign");
    const setPath = SQL.indexOf("set local search_path = pg_catalog, public;");
    expect(setPath).toBeGreaterThan(SQL.indexOf("begin;"));
    expect(setPath).toBeLessThan(SQL.indexOf("$predecessors$"));
    for (const type of ["casework_alerts", "casework_management_addenda", "casework_deadline_extensions", "casework_retaliation_patterns"]) {
      expect(SQL).toContain(` RETURNS public.${type}\n`);
    }
    expect(SQL.match(/SET search_path TO ''/g)).toHaveLength(4);
  });
});

// Each action, the argument list after its id, and the role that may use it
// on its own organization's row (the control that the action still works).
const ACTIONS = Object.freeze({
  acknowledge: { sql: "select public.casework_acknowledge_alert($1, 'Fictional note')", extra: () => [], allowed: "steward" },
  addendum: { sql: "select public.casework_add_management_addendum($1, 'Fictional correction')", extra: () => [], allowed: "steward" },
  extension: { sql: "select public.casework_request_deadline_extension($1, now() + interval '30 days', 'Fictional records request', $2)", extra: () => [randomUUID()], allowed: "steward" },
  pattern: { sql: "select public.casework_review_retaliation_pattern($1, 'investigating', 'Fictional review', null)", extra: () => [], allowed: "coordinator" },
});
// Every member role in the caller's own organization, chapter scope, plus an
// organization-wide administrator.
const ROLES = Object.freeze(["member", "steward", "coordinator", "advisor", "admin", "vp", "orgAdmin"]);
// The chapter pair: every role limited to the caller's own chapter, and a
// President of that chapter whose legacy role row still names the other
// chapter (#8311). The organization administrator reaches every chapter.
const CHAPTER_CALLERS = Object.freeze(["member", "steward", "coordinator", "advisor", "admin", "vp", "stalePresident"]);
// The three actions a steward may take on its own unit's row. A retaliation
// pattern belongs to a chapter, not a unit, and no steward may review one.
const UNIT_ACTIONS = Object.freeze(["acknowledge", "addendum", "extension"]);

// The required DB proof lane opens this casework gate (run-required-db-proofs.mjs).
const live = process.env.RUN_CASEWORK_RLS_ACL_DB_TESTS === "1" && process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("casework refusals are the same for a missing id and another organization's, chapter's or unit's row (#8795)", () => {
  let db;
  const f = { org: randomUUID(), foreignOrg: randomUUID(), unitA: randomUUID(), unitB: randomUUID(), people: {},
    rows: { home: {}, foreign: {}, chapter: {}, ownUnit: {}, unit: {} } };
  const owner = async () => {
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claims','',true)");
  };
  const as = async (name) => {
    await owner();
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.people[name].id, session_id: f.people[name].session, role: "authenticated", aal: "aal2" })]);
    await db.query("set local role authenticated");
  };
  const attempt = async (query, args) => {
    await db.query("savepoint casework_refusal");
    try {
      await db.query(query, args);
      return { ok: true };
    } catch (error) {
      return { ok: false, code: error.code, message: error.message };
    } finally {
      await db.query("rollback to savepoint casework_refusal");
      await db.query("release savepoint casework_refusal");
    }
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "casework-refusals-equal-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    f.chapter = `refusal-${f.org}`;
    f.foreign = `refusal-${f.foreignOrg}`;
    f.second = `refusal-second-${f.org}`;
    f.unitChapter = `refusal-units-${f.org}`;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Harbor Fictional Union'),($2::uuid,$2::text,'Ridge Fictional Union')", [f.org, f.foreignOrg]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$2,9980),($3,$3,$3,$4,9981),($5,$5,$5,$2,9982),($6,$6,$6,$2,9983)",
      [f.chapter, f.org, f.foreign, f.foreignOrg, f.second, f.unitChapter]);
    // Units live in their own chapter, so the home chapter's controls run
    // without unit scope.
    await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$3,$4,'Fictional Unit One'),($2,$3,$4,'Fictional Unit Two')",
      [f.unitA, f.unitB, f.org, f.unitChapter]);
    const person = async (name, chapter, organization, role, unit) => {
      const id = randomUUID();
      const session = randomUUID();
      f.people[name] = { id, session };
      await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${id}@example.invalid`]);
      await db.query("update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1", [id, chapter, `Fictional ${name}`]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, id]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [organization, id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, chapter]);
      if (role) {
        await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [id, role, chapter]);
        await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [id, role, chapter]);
      }
      if (unit) {
        await db.query("insert into private.chapter_unit_members(unit_id,chapter_id,user_id) values($1,$2,$3)", [unit, chapter, id]);
        if (role) await db.query("insert into private.chapter_role_scopes(user_id,chapter_id,role,unit_id) values($1,$2,$3,$4)", [id, chapter, role, unit]);
      }
    };
    for (const name of ROLES) {
      await person(name, f.chapter, f.org, { steward: "steward", coordinator: "coordinator", advisor: "advisor", admin: "admin", vp: "vp" }[name]);
    }
    await person("foreignMember", f.foreign, f.foreignOrg);
    await person("foreignSteward", f.foreign, f.foreignOrg, "steward");
    await person("secondMember", f.second, f.org);
    await person("secondSteward", f.second, f.org, "steward");
    await person("unitMember", f.unitChapter, f.org, null, f.unitA);
    await person("unitSteward", f.unitChapter, f.org, "steward", f.unitA);
    await person("unitTwoMember", f.unitChapter, f.org, null, f.unitB);
    await person("unitTwoSteward", f.unitChapter, f.org, "steward", f.unitB);
    // President of the home chapter whose legacy role row still names the
    // second chapter, where the role was removed (#8311).
    await person("stalePresident", f.chapter, f.org);
    await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'vp',$2)", [f.people.stalePresident.id, f.second]);
    await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'vp',$2)", [f.people.stalePresident.id, f.chapter]);
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'admin')", [f.org, f.people.orgAdmin.id]);
    // One case of each side's member, assigned to its steward, with an alert,
    // a management entry, a deadline and a retaliation pattern.
    const sides = {
      home: [f.org, f.chapter, "member", "steward"],
      foreign: [f.foreignOrg, f.foreign, "foreignMember", "foreignSteward"],
      chapter: [f.org, f.second, "secondMember", "secondSteward"],
      ownUnit: [f.org, f.unitChapter, "unitMember", "unitSteward"],
      unit: [f.org, f.unitChapter, "unitTwoMember", "unitTwoSteward"],
    };
    for (const [side, [org, chapter, memberName, stewardName]] of Object.entries(sides)) {
      const member = f.people[memberName].id;
      const steward = f.people[stewardName].id;
      const caseId = randomUUID();
      await db.query("insert into public.member_cases(id,user_id,reference,title,case_type,steward_user_id) values($1::uuid,$2,$1::text,'Fictional case','other',$3)", [caseId, member, steward]);
      const rows = f.rows[side];
      rows.acknowledge = (await db.query("insert into public.casework_alerts(case_id,organization_id,chapter_id,kind,severity,message,created_by) values($1,$2,$3,'custom','info','Fictional alert',$4) returning id", [caseId, org, chapter, steward])).rows[0].id;
      const manager = (await db.query("insert into public.casework_management_people(organization_id,chapter_id,display_name,created_by) values($1,$2,'Fictional manager',$3) returning id", [org, chapter, steward])).rows[0].id;
      rows.addendum = (await db.query("insert into public.casework_management_entries(management_person_id,case_id,organization_id,chapter_id,occurred_at,category,summary,created_by) values($1,$2,$3,$4,now(),'other','Fictional management interaction',$5) returning id", [manager, caseId, org, chapter, steward])).rows[0].id;
      rows.extension = (await db.query("insert into public.casework_deadlines(case_id,organization_id,chapter_id,kind,label,due_at,created_by) values($1,$2,$3,'filing','Fictional filing',now() + interval '10 days',$4) returning id", [caseId, org, chapter, steward])).rows[0].id;
      // Only the scanner may insert a pattern (its subject label is an
      // encrypted field); the fixture writes one with triggers off.
      await db.query("set local session_replication_role = replica");
      rows.pattern = (await db.query("insert into public.casework_retaliation_patterns(organization_id,chapter_id,fingerprint,subject_label,report_count) values($1,$2,$3,'Fictional pattern',2) returning id", [org, chapter, `fixture-${randomUUID()}`])).rows[0].id;
      await db.query("set local session_replication_role = origin");
    }
  });
  afterAll(async () => {
    if (db) {
      await db.query("rollback");
      await db.end();
    }
  });

  it.each(Object.keys(ACTIONS))("%s: every member role gets the same refusal for a missing id and another organization's live row", async (action) => {
    const { sql, extra } = ACTIONS[action];
    for (const role of ROLES) {
      await as(role);
      const missing = await attempt(sql, [randomUUID(), ...extra()]);
      const foreign = await attempt(sql, [f.rows.foreign[action], ...extra()]);
      expect(missing.ok, `${action} ${role} missing`).toBe(false);
      expect(foreign, `${action} ${role}`).toEqual(missing);
      expect(missing.code, `${action} ${role}`).toBe("P0002");
    }
  });

  it.each(Object.keys(ACTIONS))("%s: a role that may act still acts on its own organization's row", async (action) => {
    const { sql, extra, allowed } = ACTIONS[action];
    await as(allowed);
    expect(await attempt(sql, [f.rows.home[action], ...extra()]), `${action} ${allowed}`).toEqual({ ok: true });
    await owner();
  });

  it.each(Object.keys(ACTIONS))("%s: every chapter-scoped role gets the same refusal for a missing id and another chapter's live row", async (action) => {
    const { sql, extra } = ACTIONS[action];
    for (const role of CHAPTER_CALLERS) {
      await as(role);
      const missing = await attempt(sql, [randomUUID(), ...extra()]);
      const sibling = await attempt(sql, [f.rows.chapter[action], ...extra()]);
      expect(missing.ok, `${action} ${role} missing`).toBe(false);
      expect(sibling, `${action} ${role} chapter`).toEqual(missing);
      expect(missing.code, `${action} ${role}`).toBe("P0002");
    }
  });

  it.each(Object.keys(ACTIONS))("%s: a unit steward gets the same refusal for a missing id and another unit's live row", async (action) => {
    const { sql, extra } = ACTIONS[action];
    await as("unitSteward");
    const missing = await attempt(sql, [randomUUID(), ...extra()]);
    const neighbour = await attempt(sql, [f.rows.unit[action], ...extra()]);
    expect(missing.ok, `${action} missing`).toBe(false);
    expect(neighbour, `${action} unit`).toEqual(missing);
    expect(missing.code, action).toBe("P0002");
  });

  it.each(UNIT_ACTIONS)("%s: a unit steward still acts on its own unit's row", async (action) => {
    const { sql, extra } = ACTIONS[action];
    await as("unitSteward");
    expect(await attempt(sql, [f.rows.ownUnit[action], ...extra()]), action).toEqual({ ok: true });
    await owner();
  });
});
