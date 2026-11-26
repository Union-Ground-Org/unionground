// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMigrationName, loadMigrationSql, migrationFiles } from "./helpers/migration.js";
import { sourceTransactionProblem } from "../scripts/hosted-migration-apply-runner.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { sqlStatements } from "../scripts/lib/sql-text.mjs";
import { assertScopedMemberEquivalence } from "./helpers/scoped-member-equivalence.js";

const sql = loadMigrationSql("stewards_require_unit_with_carry_over");
const backfill = sql.split("-- BEGIN MIGRATION-ONLY BACKFILL (retained verbatim for the rollback proof).")[1].split("-- END MIGRATION-ONLY BACKFILL.")[0];
const committeePreflight = sql.match(/do \$committee_preflight\$[\s\S]*?\$committee_preflight\$;/)[0];
const reachReaders = new Set([
  "private.member_has_chapter_role", "private.actor_role_covers_member", "private.staff_actor_can_see_user",
  "private.actor_case_scope_and_identity_allowed", "private.chapter_scoped_role_allows",
  "private.chapter_scoped_member_ids", "public.staff_can_see_user", "private.staff_visible_member_ids",
  "private.chapter_contact_entry_allowed", "private.chapter_staff_member_allowed",
  "private.chapter_records_scope_memo", "private.chapter_record_manageable",
  "public.get_institutional_records_workspace", "public.list_chapter_seniority",
  "private.chapter_seniority_member_allowed",
]);
const withoutLeadingComments = (text) => {
  let next = text.trim(), previous;
  do { previous = next; next = next.replace(/^(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*/, "").trimStart(); } while (next !== previous);
  return next;
};
const functionName = (text) => withoutLeadingComments(text).match(/^create\s+(?:or\s+replace\s+)?function\s+([a-z_.]+)\s*\(/i)?.[1];
let predecessorReaders;
function loadPredecessorReaders() {
  if (predecessorReaders) return predecessorReaders;
  const statements = new Map(); let policy;
  const directory = new URL("../supabase/migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql") && name < findMigrationName("stewards_require_unit_with_carry_over")).sort()) {
    for (const statement of sqlStatements(readFileSync(new URL(name, directory), "utf8"))) {
      const name = functionName(statement);
      if (reachReaders.has(name)) statements.set(name, statement);
      if (/^alter\s+policy\s+chapter_records_select\s+on\s+public\.chapter_records\b/i.test(withoutLeadingComments(statement))) policy = statement;
    }
  }
  if (statements.size !== reachReaders.size || !policy) throw new Error("Historical reach-reader definitions are incomplete");
  predecessorReaders = { statements, policy };
  return predecessorReaders;
}
describe("required steward unit migration contract", () => {
  it("installs the composed authority after the frozen private-conversation repair", () => {
    expect(findMigrationName("stewards_require_unit_with_carry_over") > findMigrationName("unit_scoped_steward_private_conversations")).toBe(true);
  });
  it("passes the real hosted transaction guard", () => { expect(sourceTransactionProblem(sql)).toBeNull(); });
  it("pins all canonical function definitions and retains every replaced predecessor check", () => {
    const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
    const matches = [...sql.matchAll(/(CREATE (?:OR REPLACE )?FUNCTION ([a-z_.]+)\([\s\S]*?\$function\$);/g)];
    // 7:58 PM repair: include the two remaining bounded office readers.
    // (Nov 12): 62, since the  notice-scope helper ships with .
    //  gate round 1: 66, with the SCIM role setter, the two role undos
    // and the open steward invitation unit check; round 2: 67, with the unit
    // reservation check; final: 68, with the reserved-unit chapter check;
    // re-final: 71, with the grievance scope and both request deciders;
    // stage 148: 72, with the organization-steward-unassigned test.
    expect(matches).toHaveLength(72);
    //  (unit_steward_notice_audiences) redefines the two read-count
    // readers after this migration; there this body is the pinned predecessor.
    const notices = loadMigrationSql("unit_steward_notice_audiences");
    //  restates the workspace and save function behind their exact
    // predecessor hashes while narrowing member-contact access by container.
    const contacts = loadMigrationSql("unit_steward_member_contact_records_in_unit");
    //  (per_unit_settings) redefines a function of this migration later,
    // behind a check that the body it replaces is exactly this one.
    const unitSettings = loadMigrationSql("per_unit_settings");
    //  moves readers of this migration to the Eastern day in parts, each
    // a later *_eastern_day migration behind a check that the body it replaces
    // is exactly this one.
    const easternDay = migrationFiles().filter((file) => file.name.endsWith("_eastern_day.sql")).map((file) => file.sql).join("\n");
    //  (referral_over_weekly_cap_waits_for_a_later_week) re-emits the
    // account export aggregator behind the same exact-predecessor check.
    const referralPayouts = loadMigrationSql("referral_over_weekly_cap_waits_for_a_later_week");
    //  (pulse_layout_store) re-emits the same aggregator behind an exact
    // pg_get_functiondef predecessor check.
    const pulseLayout = loadMigrationSql("pulse_layout_store");
    //  extracts invitation expiry behind its exact unit-aware predecessor.
    const systemExpiry = loadMigrationSql("invitation_expiry_system_maintenance");
    const refusalIsolation = loadMigrationSql("request_chapter_coalition_refusal_isolation");
    for (const match of matches) {
      const canonical = match[1].replace(/^CREATE FUNCTION /, "CREATE OR REPLACE FUNCTION ") + "\n";
      const digest = createHash("md5").update(canonical).digest("hex");
      const superseded = [notices, contacts, referralPayouts, systemExpiry, refusalIsolation].some((successor) => successor.includes(`is distinct from '${digest}' then\n    raise exception 'unreviewed predecessor: ${match[2]}'`));
      const body = match[1].slice(match[1].indexOf("$function$") + "$function$".length, -"$function$".length);
      const later = unitSettings.includes(`is distinct from '${createHash("md5").update(body).digest("hex")}' then\n    raise exception 'unreviewed ${match[2]} predecessor'`);
      const layoutExport = match[2] === "private.account_lifecycle_export_additional_domains"
        && pulseLayout.includes("pg_catalog.pg_get_functiondef('private.account_lifecycle_export_additional_domains(uuid)'::regprocedure)")
        && pulseLayout.includes(`<> '${digest}' then\n    raise exception 'unreviewed layout export predecessor'`);
      const eastern = easternDay.includes(`is distinct from '${createHash("md5").update(body).digest("hex")}' then\n    raise exception 'unreviewed predecessor: ${match[2]}'`);
      expect(superseded || later || eastern || layoutExport || contract.functions.some((row) => row.sig.split("(")[0] === match[2] && row.bodyMd5 === digest), match[2]).toBe(true);
      if (match[1].startsWith("CREATE OR REPLACE")) expect(sql).toContain("unreviewed predecessor: " + match[2]);
    }
  });
  it("copies no unit memberships and exposes no runtime carry-over parameter or grant", () => {
    expect(backfill).not.toMatch(/(?:insert\s+into|update|delete\s+from)\s+private\.chapter_unit_members/i);
    expect(sql).not.toMatch(/CREATE (?:OR REPLACE )?FUNCTION [^\n]*\([^\n]*p_legacy/i);
    expect(sql).toContain("before update of legacy_chapter_coverage");
    expect(sql).toContain("carry-over coverage is migration-only and cannot be set or restored");
    expect(sql).not.toMatch(/grant execute on function private\.(?:reject_steward_carry_over_write|clear_steward_carry_over_on_choice)/i);
  });
  it("keeps the one-unit model and the existing nested role setter authority", () => {
    expect(sql).toContain("check(role<>'steward' or (unit_id is not null and committee_id is null))");
    expect(sql).not.toMatch(/drop\s+(?:constraint|index)\s+chapter_role_scopes_pkey/i);
    expect(sql).toContain("p_role in ('secretary','records','treasurer') and private.member_has_chapter_role");
    expect(sql).toContain("admin required for a new steward grant");
  });
  it("names and counts committee-only blockers before any assignment backfill", () => {
    expect(sql).toContain("select count(*) into blocking_grants");
    expect(sql).toContain("unit_id is null and committee_id is not null");
    expect(sql).toContain("steward_unit_migration_blocked: % committee-only steward grants; an administrator must choose a chapter unit for each before this migration");
    expect(sql.indexOf("do $committee_preflight$")).toBeLessThan(sql.indexOf("-- BEGIN MIGRATION-ONLY BACKFILL"));
    expect(sql.indexOf("select private.lock_case_graph(array[]::uuid[],array[]::uuid[])")).toBeLessThan(sql.indexOf("alter table private.chapter_units"));
  });
  //  final (P1 r7s1): ALTER TABLE refuses pending trigger events (55006),
  // so no table DDL may follow row changes until the migration settles them.
  it("settles pending deferred checks before any table DDL that follows row changes", () => {
    let dirty = null;
    const offenders = [];
    for (const statement of sqlStatements(sql)) {
      const body = withoutLeadingComments(statement);
      if (/^set\s+constraints\s+all\s+immediate\b/i.test(body)) { dirty = null; continue; }
      if (/^(?:with\b|insert\s+into|update\s|delete\s+from|select\b)/i.test(body)
        && /\b(?:insert\s+into|update\s+[a-z_.]+\s+(?:[a-z_]+\s+)?set\b|delete\s+from)\b/i.test(body)) { dirty = body.slice(0, 60); continue; }
      if (dirty && /^(?:alter\s+table|create\s+(?:unique\s+)?index|create\s+(?:constraint\s+)?trigger|alter\s+policy|drop\s)/i.test(body)) offenders.push(body.slice(0, 80));
    }
    expect(offenders).toEqual([]);
    expect(sql.indexOf("set constraints all immediate;")).toBeGreaterThan(sql.indexOf("-- END MIGRATION-ONLY BACKFILL."));
  });
  it("ties organization-wide steward readers and policy fallbacks to the chapter assignment", () => {
    expect(sql).toContain("scope.legacy_chapter_coverage or (p_target is not null");
    expect(sql).toContain("grant_row.organization_id=chapter.organization_id");
    expect(backfill).toContain("join public.chapters chapter on chapter.organization_id=grant_row.organization_id");
    expect(backfill).not.toContain("membership.chapter_id");
    for (const name of ["private.staff_visible_member_ids", "private.chapter_records_scope_memo", "private.chapter_contact_entry_allowed", "private.chapter_seniority_member_allowed", "public.get_institutional_records_workspace", "public.save_scoped_institutional_record"]) {
      expect(sql).toContain("unreviewed predecessor: " + name);
    }
    expect(sql).toContain("alter policy chapter_records_select on public.chapter_records");
    expect(sql).toContain("unreviewed predecessor: chapter_records_select");
    expect(sql).toContain("private.chapter_organization_role_allowed(chapter_records.chapter_id");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("required steward units and migration-only carry-over on an owned rollback database", () => {
  let db, f;
  const owner = async () => { await db.query("reset role"); await db.query("select set_config('request.jwt.claims','',true)"); };
  const as = async (name, aal = "aal2") => {
    await owner(); const person = f.people[name];
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: person.id, session_id: person.session, role: "authenticated", aal })]);
    await db.query("set local role authenticated");
  };
  const one = async (query, args = []) => (await db.query(query, args)).rows[0]?.v;
  const denied = async (query, args = [], codes = ["42501", "22023", "23514"]) => {
    await db.query("savepoint unit_denied"); let error;
    try { await db.query(query, args); } catch (caught) { error = caught; }
    await db.query("rollback to savepoint unit_denied"); await db.query("release savepoint unit_denied");
    expect(error, "operation unexpectedly succeeded").toBeTruthy(); expect(codes).toContain(error.code);
    return error;
  };
  const choose = (name, unit, chapter = f.chapter, role = "steward") => one("select public.set_member_access_role($1,$2,$3,true,$4,null) v", [f.people[name].id, chapter, role, unit]);
  const storedMemberships = async () => { await owner(); return (await db.query("select unit_id,chapter_id,user_id from private.chapter_unit_members where chapter_id=$1 order by unit_id,user_id", [f.chapter])).rows; };
  const organizationActor = async (name, role) => {
    await owner(); const id = randomUUID(), session = randomUUID(); f.people[name] = { id, session };
    await db.query("insert into auth.users(id,email) values($1,$2)", [id, id + "@example.invalid"]);
    await db.query("update public.member_profiles set chapter_id=null,full_name=$2 where id=$1", [id, "Fictional " + name]);
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, id]);
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [f.org, id]);
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,$3)", [f.org, id, role]);
  };
  const migrate = async () => {
    await owner();
    // This is fixture preparation in a URL-guarded disposable transaction:
    // execute the actual migration-only data block, then restore the runtime
    // guard before any assertion. No deployed database can be used here.
    await db.query("alter table private.chapter_role_scopes disable trigger a01_reject_carry_over_insert");
    await db.query("alter table private.organization_steward_unit_assignments disable trigger a01_reject_organization_assignment_insert");
    await db.query(backfill);
    await db.query("set constraints all immediate");
    await db.query("alter table private.chapter_role_scopes enable trigger a01_reject_carry_over_insert");
    await db.query("alter table private.organization_steward_unit_assignments enable trigger a01_reject_organization_assignment_insert");
    await db.query("set constraints all deferred");
    f.defaultUnit = (await db.query("select id from private.chapter_units where chapter_id=$1 and is_default", [f.chapter])).rows[0].id;
  };
  const reads = async (name, compareWorkspaceRefusal = false) => {
    await as(name);
    const targets = ["a", "b", "unassigned"];
    const directory = [];
    for (const target of targets) if (await one("select public.staff_can_see_user($1,'steward') v", [f.people[target].id])) directory.push(target);
    let contacts;
    await db.query("savepoint reach_workspace");
    try {
      const workspace = await one("select public.get_institutional_records_workspace() v");
      contacts = targets.filter((target) => workspace.contacts.some((row) => row.id === f.contacts[target]));
    } catch (error) {
      await db.query("rollback to savepoint reach_workspace");
      if (!compareWorkspaceRefusal || error.message !== "organization chapter context required") throw error;
      contacts = { refused: error.code, message: error.message };
    }
    await db.query("release savepoint reach_workspace");
    const visibleCases = (await db.query("select id from public.member_cases where id=any($1::uuid[])", [Object.values(f.cases)])).rows.map((row) => row.id);
    return { directory, contacts, cases: targets.filter((target) => visibleCases.includes(f.cases[target])) };
  };
  const withPredecessorReaders = async (read) => {
    await owner();
    const predecessor = loadPredecessorReaders();
    for (const statement of predecessor.statements.values()) await db.query(withoutLeadingComments(statement).replace(/^create\s+function/i, "CREATE OR REPLACE FUNCTION"));
    await db.query(predecessor.policy);
    for (const match of sql.matchAll(/pg_get_functiondef\(pg_catalog\.to_regprocedure\('([^']+)'\)\)\) is distinct from '([a-f0-9]+)' then raise exception 'unreviewed predecessor: ([^']+)'/g)) {
      if (reachReaders.has(match[3])) expect(await one("select md5(pg_get_functiondef(to_regprocedure($1))) v", [match[1]]), match[3]).toBe(match[2]);
    }
    const result = await read();
    await owner();
    for (const statement of sqlStatements(sql)) {
      if (reachReaders.has(functionName(statement)) || /^alter\s+policy\s+chapter_records_select\s+on\s+public\.chapter_records\b/i.test(withoutLeadingComments(statement))) await db.query(statement);
    }
    return result;
  };
  beforeEach(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "required-steward-unit-rollback-proof" });
    await db.connect(); await db.query("begin"); await db.query("set constraints all deferred");
    f = { org: randomUUID(), unitA: randomUUID(), unitB: randomUUID(), siblingUnit: randomUUID(), people: {}, contacts: {}, cases: {} };
    f.chapter = "unit-required-" + f.org; f.sibling = "unit-sibling-" + f.org;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Fictional Harbor Units')", [f.org]);
    // Model a pre-migration chapter with two existing units and no default.
    await db.query("alter table public.chapters disable trigger chapter_gets_default_unit");
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,'Harbor chapter',$1,$3,9985),($2,'Ridge chapter',$2,$3,9986)", [f.chapter, f.sibling, f.org]);
    await db.query("alter table public.chapters enable trigger chapter_gets_default_unit");
    for (const name of ["admin", "lead", "legacy", "newSteward", "defaultSteward", "a", "b", "unassigned", "siblingSteward"]) {
      const id = randomUUID(), session = randomUUID(), chapter = name === "siblingSteward" ? f.sibling : f.chapter;
      f.people[name] = { id, session };
      await db.query("insert into auth.users(id,email) values($1,$2)", [id, id + "@example.invalid"]);
      await db.query("update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1", [id, chapter, "Fictional " + name]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, id]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [f.org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, chapter]);
      if (["admin", "lead", "legacy"].includes(name)) {
        const role = name === "admin" ? "admin" : name === "lead" ? "vp" : "steward";
        await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [id, role, chapter]);
        await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [id, role, chapter]);
      }
    }
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'admin')", [f.org, f.people.admin.id]);
    await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$3,$4,'Team A'),($2,$3,$4,'Team B'),($5,$3,$6,'Ridge team')", [f.unitA, f.unitB, f.org, f.chapter, f.siblingUnit, f.sibling]);
    await db.query("insert into private.chapter_unit_members(unit_id,chapter_id,user_id) values($1,$3,$4),($2,$3,$5)", [f.unitA, f.unitB, f.chapter, f.people.a.id, f.people.b.id]);
    for (const name of ["a", "b", "unassigned"]) {
      const contact = randomUUID(), caseID = randomUUID(); f.contacts[name] = contact; f.cases[name] = caseID;
      await db.query("insert into public.chapter_contact_log(id,organization_id,chapter_id,subject_user_id,contact_kind,channel,purpose,summary,occurred_at,created_by,updated_by) values($1,$2,$3,$4,'member','phone','Fictional contact','Private contact',now(),$5,$5)", [contact, f.org, f.chapter, f.people[name].id, f.people.admin.id]);
      await db.query("insert into public.member_cases(id,user_id,reference,title,case_type,steward_user_id) values($1::uuid,$2,$1::text,$3,'other',$4)", [caseID, f.people[name].id, "Fictional " + name, f.people.legacy.id]);
    }
  });
  afterEach(async () => { if (db) { await db.query("rollback"); await db.end(); } });

  it("preserves the migrated steward's directory, contacts and case identities across two units", async () => {
    const before = await withPredecessorReaders(() => reads("legacy"));
    expect(before).toEqual({ directory: ["a", "b", "unassigned"], contacts: ["a", "b", "unassigned"], cases: ["a", "b", "unassigned"] });
    await migrate(); expect(await reads("legacy")).toEqual(before);
  });
  it("keeps newly granted stewards in only their chosen unit and refuses a grant without a unit", async () => {
    await migrate(); await as("admin");
    await denied("select public.set_member_access_role($1,$2,'steward',true,null,null)", [f.people.newSteward.id, f.chapter]);
    await denied("select public.set_member_chapter_role($1,$2,'steward',true)", [f.people.newSteward.id, f.chapter]);
    await denied("select public.set_member_organization_role($1,'steward',true)", [f.people.newSteward.id]);
    await choose("newSteward", f.unitA);
    expect(await reads("newSteward")).toEqual({ directory: ["a"], contacts: ["a"], cases: ["a"] });
  });
  it("refuses inserting or restoring a carry-over mark through updates, grants and invitations", async () => {
    await migrate(); await as("lead"); await choose("legacy", f.unitA);
    await denied("update private.chapter_role_scopes set legacy_chapter_coverage=true where user_id=$1 and role='steward'", [f.people.legacy.id]);
    await owner();
    await denied("update private.chapter_role_scopes set legacy_chapter_coverage=true where user_id=$1 and role='steward'", [f.people.legacy.id]);
    await denied("update private.chapter_role_scopes set unit_id=$2,legacy_chapter_coverage=true where user_id=$1 and role='steward'", [f.people.legacy.id, f.defaultUnit]);
    await as("admin");
    await denied("select public.set_member_access_role($1,$2,'steward',true,$3,null,true)", [f.people.legacy.id, f.chapter, f.defaultUnit], ["42883"]);
    await denied("select public.create_member_invitation('fictional@example.invalid','Fictional Person',$1,'steward','en',repeat('a',64),$2,true)", [f.chapter, f.defaultUnit], ["42883"]);
    await denied("select public.create_member_invitation('fictional@example.invalid','Fictional Person',$1,'steward','en',repeat('a',64))", [f.chapter]);
    await owner();
    await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'steward',$2)", [f.people.newSteward.id, f.chapter]);
    await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'steward',$2)", [f.people.newSteward.id, f.chapter]);
    await denied("insert into private.chapter_role_scopes(user_id,chapter_id,role,unit_id,legacy_chapter_coverage) values($1,$2,'steward',$3,true)", [f.people.newSteward.id, f.chapter, f.defaultUnit]);
  });
  it("lets the own chapter lead choose a unit once, audit it once and permanently narrow all three reads", async () => {
    await migrate(); await as("lead");
    expect(await one("select public.get_steward_unit_assignment($1,$2) v", [f.people.legacy.id, f.chapter])).toMatchObject({ legacyChapterCoverage: true });
    await choose("legacy", f.unitA);
    expect(await reads("legacy")).toEqual({ directory: ["a"], contacts: ["a"], cases: ["a"] });
    await owner();
    const audit = (await db.query("select actor,detail from public.member_admin_audit where target_user=$1 and action='role_scope_updated' order by created_at,id", [f.people.legacy.id])).rows;
    expect(audit).toHaveLength(2); expect(audit.filter((row) => row.actor === f.people.lead.id)).toHaveLength(1);
    expect((await db.query("select legacy_chapter_coverage v from private.chapter_role_scopes where user_id=$1 and role='steward'", [f.people.legacy.id])).rows[0].v).toBe(false);
    await as("lead"); await choose("legacy", f.defaultUnit);
    expect(await reads("legacy")).toEqual({ directory: ["unassigned"], contacts: ["unassigned"], cases: ["unassigned"] });
  });
  it("gives an ordinary default-unit steward the members with no physical unit, without copying membership rows", async () => {
    const before = await storedMemberships(); await migrate();
    expect(await storedMemberships()).toEqual(before);
    await as("admin"); await choose("defaultSteward", f.defaultUnit);
    expect(await reads("defaultSteward")).toEqual({ directory: ["unassigned"], contacts: ["unassigned"], cases: ["unassigned"] });
    expect(await storedMemberships()).toEqual(before);
  });
  it("returns UUID members from the scoped reader across carry-over, physical and default-unit arms", async () => {
    const targets = [f.people.a.id, f.people.b.id, f.people.unassigned.id];
    const scoped = async () => {
      // This private definer is an internal path; retain JWT identity while
      // invoking it as its owner, without expanding its client EXECUTE ACL.
      await db.query("reset role");
      expect(await one("select has_function_privilege('authenticated','private.chapter_scoped_member_ids(text)','EXECUTE') v")).toBe(false);
      const result = new Set((await db.query("select member_id from private.chapter_scoped_member_ids('steward') member_id where member_id=any($1::uuid[])", [targets])).rows.map((row) => row.member_id));
      await db.query("set local role authenticated");
      return result;
    };
    await migrate(); await as("legacy");
    expect(await scoped()).toEqual(new Set(targets));
    await as("lead"); await choose("legacy", f.unitA); await as("legacy");
    expect(await scoped()).toEqual(new Set([f.people.a.id]));
    await as("lead"); await choose("legacy", f.defaultUnit); await as("legacy");
    expect(await scoped()).toEqual(new Set([f.people.unassigned.id]));
  });
  it("keeps the complete set equal to the scalar oracle for every caller, role and scope transition", async () => {
    // Nov 12: a set difference stops this repair; the oracle is the
    // original enumeration plus unchanged chapter_scoped_role_allows.
    await organizationActor("orgOnly", "steward");
    await organizationActor("orgCoordinator", "coordinator");
    await migrate(); await as("admin");
    await choose("newSteward", f.unitA);
    await choose("defaultSteward", f.defaultUnit);
    await choose("siblingSteward", f.siblingUnit, f.sibling);
    await owner();
    for (const [person, role, start, end] of [
      ["b", "advisor", -1, null], ["unassigned", "secretary", -10, -1], ["newSteward", "records", 1, 10],
    ]) {
      const committee = randomUUID();
      await db.query("insert into private.chapter_committees(id,chapter_id,name,purpose,starts_on,ends_on) values($1,$2,$3,'Scalar differential',current_date+$4::integer,current_date+$5::integer)", [committee, f.chapter, role, start, end]);
      await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [f.people[person].id, role, f.chapter]);
      await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [f.people[person].id, role, f.chapter]);
      await db.query("insert into private.chapter_role_scopes(user_id,role,chapter_id,committee_id) values($1,$2,$3,$4)", [f.people[person].id, role, f.chapter, committee]);
      for (const target of ["a", "b", "unassigned"]) await db.query("insert into private.chapter_committee_members(committee_id,chapter_id,user_id) values($1,$2,$3)", [committee, f.chapter, f.people[target].id]);
    }
    await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'coordinator',$2)", [f.people.a.id, f.chapter]);
    await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'coordinator',$2)", [f.people.a.id, f.chapter]);
    await db.query("insert into private.chapter_role_scopes(user_id,role,chapter_id,unit_id) values($1,'coordinator',$2,$3)", [f.people.a.id, f.chapter, f.unitA]);

    const foreignOrg = randomUUID(), foreignChapter = "oracle-foreign-" + foreignOrg;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Fictional foreign oracle')", [foreignOrg]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,'Foreign oracle',$1,$2,9991)", [foreignChapter, foreignOrg]);
    await organizationActor("foreign", "coordinator");
    await db.query("delete from public.organization_role_grants where user_id=$1", [f.people.foreign.id]);
    await db.query("delete from public.organization_memberships where user_id=$1", [f.people.foreign.id]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [foreignOrg, f.people.foreign.id]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [f.people.foreign.id, foreignChapter]);
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [f.people.foreign.id, foreignChapter]);
    await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'coordinator',$2)", [f.people.foreign.id, foreignChapter]);
    await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'coordinator',$2)", [f.people.foreign.id, foreignChapter]);
    await db.query("insert into private.chapter_role_scopes(user_id,role,chapter_id,unit_id) select $1,'coordinator',$2,id from private.chapter_units where chapter_id=$2 and is_default", [f.people.foreign.id, foreignChapter]);
    await organizationActor("profileless", "coordinator");
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [f.people.profileless.id, f.chapter]);
    await db.query("insert into private.chapter_unit_members(unit_id,chapter_id,user_id) values($1,$2,$3)", [f.unitA, f.chapter, f.people.profileless.id]);
    await db.query("delete from public.member_profiles where id=$1", [f.people.profileless.id]);
    await organizationActor("noOrganization", "coordinator");
    await db.query("delete from public.organization_role_grants where user_id=$1", [f.people.noOrganization.id]);
    await db.query("delete from public.organization_memberships where user_id=$1", [f.people.noOrganization.id]);
    const matrix = async (phase) => {
      for (const name of Object.keys(f.people)) {
        for (const aal of ["aal2", "aal1"]) {
          await as(name, aal);
          await assertScopedMemberEquivalence(db, `${phase}/${name}/${aal}`);
        }
      }
      await owner();
      await assertScopedMemberEquivalence(db, `${phase}/no-caller`);
    };
    await matrix("carry-over, units, dated committees and foreign chapter");
    await as("lead"); await choose("legacy", f.unitA); await choose("orgOnly", f.unitA);
    await matrix("chapter and organization carry-over cleared");
    await as("lead"); await choose("legacy", f.defaultUnit); await choose("orgOnly", f.defaultUnit);
    await matrix("implicit default unit excludes physical unit members");

    const variants = [
      ["inactive target organization", () => db.query("update public.organization_memberships set status='revoked',revoked_at=now() where organization_id=$1 and user_id=$2", [f.org, f.people.b.id])],
      ["inactive target chapter", () => db.query("update public.member_chapter_memberships set status='revoked',revoked_at=now() where chapter_id=$1 and user_id=$2", [f.chapter, f.people.b.id])],
      ["inactive actor organization", () => db.query("update public.organization_memberships set status='revoked',revoked_at=now() where organization_id=$1 and user_id=$2", [f.org, f.people.newSteward.id])],
      ["inactive actor chapter", () => db.query("update public.member_chapter_memberships set status='revoked',revoked_at=now() where chapter_id=$1 and user_id=$2", [f.chapter, f.people.newSteward.id])],
      ["missing staff factor", () => db.query("delete from auth.mfa_factors where user_id=$1", [f.people.newSteward.id])],
      ["PIN session", () => db.query("insert into private.member_pin_sessions(session_id,user_id) values($1,$2)", [f.people.legacy.session, f.people.legacy.id])],
      ["revoked organization grant", () => db.query("delete from public.organization_role_grants where user_id=$1 and role='steward'", [f.people.orgOnly.id])],
      ["missing target primary chapter", () => db.query("update public.member_profiles set chapter_id=null where id=$1", [f.people.b.id])],
      ["conflicting target organization context", () => db.query("update public.member_profiles set chapter_id=$2 where id=$1", [f.people.b.id, foreignChapter])],
    ];
    for (const [label, change] of variants) {
      await owner(); await db.query("savepoint differential_variant");
      try { await change(); await matrix(label); }
      finally { await db.query("rollback to savepoint differential_variant"); await db.query("release savepoint differential_variant"); }
    }
  }, 120_000);
  it("narrows an organization steward's retained seniority cleanup with the explicit unit choice", async () => {
    await as("legacy");
    const entry = await one("select public.save_chapter_seniority_entry($1,$2,'2019-01-01','Fictional retained seniority',null) v", [f.chapter, f.people.b.id]);
    await organizationActor("organizationSteward", "steward");
    await db.query("update public.member_chapter_memberships set status='revoked',revoked_at=now() where user_id=$1 and chapter_id=$2", [f.people.b.id, f.chapter]);
    await migrate(); await as("organizationSteward");
    expect((await one("select public.list_chapter_seniority($1) v", [f.chapter])).items.map((row) => row.id)).toContain(entry.id);
    await as("lead"); await choose("organizationSteward", f.unitA); await as("organizationSteward");
    expect((await one("select public.list_chapter_seniority($1) v", [f.chapter])).items.map((row) => row.id)).not.toContain(entry.id);
    await denied("select public.delete_chapter_seniority_entry($1)", [entry.id]);
    await denied("select public.answer_chapter_seniority_question($1,'Fictional answer')", [entry.id]);
    await as("legacy");
    expect((await one("select public.delete_chapter_seniority_entry($1) v", [entry.id])).deleted).toBe(true);
  });
  it("clears the mark even when the lead explicitly chooses the same default unit", async () => {
    await migrate(); await as("lead"); await choose("legacy", f.defaultUnit);
    expect(await reads("legacy")).toEqual({ directory: ["unassigned"], contacts: ["unassigned"], cases: ["unassigned"] });
    await as("lead"); expect(await one("select public.get_steward_unit_assignment($1,$2) v", [f.people.legacy.id, f.chapter])).toMatchObject({ legacyChapterCoverage: false });
  });
  it("writes exactly one migration audit row per steward and creates no unnecessary default", async () => {
    await migrate(); await owner();
    expect((await db.query("select count(*)::integer n from public.member_admin_audit where target_user=$1 and detail->>'source'='migration-7663'", [f.people.legacy.id])).rows[0].n).toBe(1);
    expect((await db.query("select name from private.chapter_units where chapter_id=$1 and is_default", [f.chapter])).rows).toEqual([{ name: "Harbor chapter" }]);
    expect((await db.query("select id from private.chapter_units where chapter_id=$1 and is_default", [f.sibling])).rows).toEqual([]);
  });
  it("refuses the lead's foreign-chapter assignment even if that account also leads the other chapter", async () => {
    await migrate(); await owner();
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [f.people.lead.id, f.sibling]);
    await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'vp',$2)", [f.people.lead.id, f.sibling]);
    await as("admin"); await choose("siblingSteward", f.siblingUnit, f.sibling);
    await as("lead"); await denied("select public.set_member_access_role($1,$2,'steward',true,$3,null)", [f.people.siblingSteward.id, f.sibling, f.siblingUnit]);
    await denied("select public.get_steward_unit_assignment($1,$2)", [f.people.siblingSteward.id, f.sibling]);
    await denied("select public.set_member_access_role($1,$2,'steward',true,$3,null)", [f.people.legacy.id, f.chapter, f.siblingUnit]);
  });
  it("refuses wider grants or fresh steward grants through the lead's narrowing-only path", async () => {
    await migrate(); await as("lead");
    for (const role of ["admin", "vp", "coordinator", "advisor"]) await denied("select public.set_member_access_role($1,$2,$3,true,null,null)", [f.people.legacy.id, f.chapter, role]);
    await denied("select public.set_member_access_role($1,$2,'steward',true,$3,null)", [f.people.newSteward.id, f.chapter, f.unitA]);
    await denied("select public.set_member_organization_role($1,'admin',true)", [f.people.legacy.id]);
  });
  it("creates a default for a new tenant chapter and refuses removing its last unit", async () => {
    await migrate(); await owner(); const chapter = "new-unit-" + randomUUID();
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,'New harbor',$1,$2,9987)", [chapter, f.org]);
    expect((await db.query("select name,is_default from private.chapter_units where chapter_id=$1", [chapter])).rows).toEqual([{ name: "New harbor", is_default: true }]);
    await db.query("delete from private.chapter_units where chapter_id=$1", [chapter]);
    await denied("set constraints private.chapter_keeps_one_unit immediate", [], ["23514"]);
  });
  it("keeps MFA and commit-time assignment enforcement in the database", async () => {
    await migrate(); await as("lead", "aal1"); await denied("select public.set_member_access_role($1,$2,'steward',true,$3,null)", [f.people.legacy.id, f.chapter, f.unitA]);
    await owner();
    await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'steward',$2)", [f.people.newSteward.id, f.chapter]);
    await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'steward',$2)", [f.people.newSteward.id, f.chapter]);
    await denied("set constraints steward_grant_requires_unit immediate", [], ["23514"]);
  });
  it("refuses a new raw organization steward grant without its chapter unit assignments at commit", async () => {
    await migrate(); await owner();
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'steward')", [f.org, f.people.newSteward.id]);
    await denied("set constraints organization_steward_requires_units immediate", [], ["23514"]);
  });
  it("preserves a legacy organization steward without a chapter selection, then narrows their seniority and actor authority", async () => {
    await organizationActor("orgSteward", "steward");
    await organizationActor("orgCoordinator", "coordinator");
    for (const name of ["a", "b", "unassigned"]) {
      await db.query("insert into private.chapter_seniority_entries(organization_id,chapter_id,user_id,seniority_date) values($1,$2,$3,'2020-01-01')", [f.org, f.chapter, f.people[name].id]);
    }
    const members = async (name) => {
      await as(name);
      const result = await one("select public.list_chapter_seniority($1) v", [f.chapter]);
      return result.items.map((item) => item.userId).sort();
    };
    const expected = [f.people.a.id, f.people.b.id, f.people.unassigned.id].sort();
    const organizationReach = async () => {
      const reach = await reads("orgSteward", true);
      let contactRows;
      await db.query("savepoint reach_contact_table");
      try {
        const contactIDs = (await db.query("select id from public.chapter_contact_log where id=any($1::uuid[])", [Object.values(f.contacts)])).rows.map((row) => row.id);
        contactRows = ["a", "b", "unassigned"].filter((name) => contactIDs.includes(f.contacts[name]));
      } catch (error) {
        await db.query("rollback to savepoint reach_contact_table");
        if (error.code !== "42501" || error.message !== "permission denied for table chapter_contact_log") throw error;
        contactRows = { refused: error.code };
      }
      await db.query("release savepoint reach_contact_table");
      return { ...reach, contactRows };
    };
    // The untouched coordinator arm is an independent allowed control for
    // organization-wide staff without a selected or personal chapter.
    expect(await members("orgCoordinator")).toEqual(expected);
    const before = await withPredecessorReaders(async () => ({ members: await members("orgSteward"), reach: await organizationReach() }));
    expect(before.members).toEqual(expected);
    expect(before.reach.directory).toEqual([]);
    expect(before.reach.contacts).toEqual({ refused: "42501", message: "organization chapter context required" });
    expect(before.reach.contactRows).toEqual({ refused: "42501" });
    await migrate();
    expect(await members("orgSteward")).toEqual(before.members);
    expect(await organizationReach()).toEqual(before.reach);
    await owner();
    const assigned = (await db.query("select chapter_id,legacy_chapter_coverage from private.organization_steward_unit_assignments where user_id=$1 order by chapter_id", [f.people.orgSteward.id])).rows;
    expect(assigned).toEqual([f.chapter, f.sibling].sort().map((chapter_id) => ({ chapter_id, legacy_chapter_coverage: true })));
    const audits = await db.query("select count(*)::integer n from public.member_admin_audit where target_user=$1 and detail->>'source'='migration-7663'", [f.people.orgSteward.id]);
    expect(audits.rows[0].n).toBe(2);
    await as("lead"); await choose("orgSteward", f.unitA);
    expect(await members("orgSteward")).toEqual([f.people.a.id]);
    const narrowed = await organizationReach();
    expect(narrowed.directory).toEqual(before.reach.directory.filter((name) => name === "a"));
    expect(narrowed.contactRows).toEqual(before.reach.contactRows);
    expect(narrowed.cases).toEqual(before.reach.cases.filter((name) => name === "a"));
    expect(await members("orgCoordinator")).toEqual(expected);
    await owner();
    expect((await db.query("select chapter_id from public.member_chapter_memberships where user_id=$1", [f.people.orgSteward.id])).rows).toEqual([]);
    expect((await db.query("select user_id from public.member_roles where user_id=$1", [f.people.orgSteward.id])).rows).toEqual([]);
    expect((await db.query("select user_id from public.member_role_chapters where user_id=$1", [f.people.orgSteward.id])).rows).toEqual([]);
    for (const name of ["a", "b", "unassigned"]) {
      expect(await one("select private.actor_role_covers_member($1,$2,'steward',$3) v", [f.people.orgSteward.id, f.chapter, f.people[name].id])).toBe(name === "a");
    }
  });
  it("refuses committee-only legacy grants with the exact blocking count and no data movement", async () => {
    await owner(); const committee = randomUUID();
    // Model a supported pre-migration row inside the disposable rollback
    // transaction. The real migration's preflight runs before its constraint.
    await db.query("alter table private.chapter_role_scopes drop constraint steward_scope_requires_unit");
    await db.query("insert into private.chapter_committees(id,chapter_id,name,purpose) values($1,$2,'Fictional legacy committee','Migration refusal fixture')", [committee, f.chapter]);
    for (const name of ["newSteward", "defaultSteward"]) {
      await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'steward',$2)", [f.people[name].id, f.chapter]);
      await db.query("insert into public.member_role_chapters(user_id,chapter_id,role) values($1,$2,'steward')", [f.people[name].id, f.chapter]);
      await db.query("insert into private.chapter_role_scopes(user_id,chapter_id,role,committee_id) values($1,$2,'steward',$3)", [f.people[name].id, f.chapter, committee]);
    }
    const before = await storedMemberships();
    const error = await denied(committeePreflight, [], ["55000"]);
    expect(error.message).toBe("steward_unit_migration_blocked: 2 committee-only steward grants; an administrator must choose a chapter unit for each before this migration");
    expect(await storedMemberships()).toEqual(before);
    expect((await db.query("select id from public.member_admin_audit where target_user=any($1::uuid[]) and detail->>'source'='migration-7663'", [[f.people.newSteward.id, f.people.defaultSteward.id]])).rows).toEqual([]);
  });
  it("keeps organization assignment creation, identities and carry-over migration-only while allowing a lead's bounded choice", async () => {
    await organizationActor("orgOnly", "steward"); await migrate(); await as("lead");
    const workspace = await one("select public.get_chapter_access_workspace($1) v", [f.chapter]);
    expect(workspace.grants.find((grant) => grant.userId === f.people.orgOnly.id)).toMatchObject({ name: "Fictional orgOnly", organizationGrantBacked: true, legacyChapterCoverage: true });
    expect(workspace.members.some((member) => member.id === f.people.orgOnly.id)).toBe(false);
    // Both read models show carry-over until the unit choice.
    expect(await one("select public.get_steward_unit_assignment($1,$2) v", [f.people.orgOnly.id, f.chapter])).toMatchObject({legacyChapterCoverage:true});
    await choose("orgOnly", f.unitA);
    expect(await one("select public.get_steward_unit_assignment($1,$2) v", [f.people.orgOnly.id, f.chapter])).toMatchObject({ legacyChapterCoverage: false, unitId: f.unitA });
    await owner();
    await denied("insert into private.organization_steward_unit_assignments(organization_id,user_id,chapter_id,unit_id) values($1,$2,$3,$4)", [f.org, f.people.orgOnly.id, f.chapter, f.unitA]);
    await denied("update private.organization_steward_unit_assignments set legacy_chapter_coverage=true where user_id=$1", [f.people.orgOnly.id]);
    await denied("update private.organization_steward_unit_assignments set user_id=$2 where user_id=$1", [f.people.orgOnly.id, f.people.newSteward.id]);
    for (const table of ["public.member_roles", "public.member_role_chapters", "public.member_chapter_memberships", "private.chapter_unit_members"]) {
      expect((await db.query("select user_id from " + table + " where user_id=$1", [f.people.orgOnly.id])).rows, table).toEqual([]);
    }
    expect((await db.query("select id from public.member_admin_audit where target_user=$1 and actor=$2 and action='role_scope_updated'", [f.people.orgOnly.id, f.people.lead.id])).rows).toHaveLength(1);
    await as("admin"); await one("select public.set_member_organization_role($1,'steward',false) v", [f.people.orgOnly.id]);
    await owner();
    expect((await db.query("select user_id from private.organization_steward_unit_assignments where user_id=$1", [f.people.orgOnly.id])).rows).toEqual([]);
  });
  it("narrows an organization-grant-only steward's case rows after a unit choice when they already belong to the chapter", async () => {
    // Preserve existing reach until
    // explicit unit choice, then narrow it; create no chapter-role row.
    await organizationActor("orgChapterMember", "steward");
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [f.people.orgChapterMember.id, f.chapter]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [f.people.orgChapterMember.id, f.chapter]);
    const cases = async () => {
      await as("orgChapterMember");
      const ids = (await db.query("select id from public.member_cases where id=any($1::uuid[])", [Object.values(f.cases)])).rows.map((row) => row.id);
      return ["a", "b", "unassigned"].filter((name) => ids.includes(f.cases[name]));
    };
    const before = await withPredecessorReaders(async () => {
      await db.query("update public.member_cases set steward_user_id=$1 where id=any($2::uuid[])", [f.people.orgChapterMember.id, Object.values(f.cases)]);
      return cases();
    });
    expect(before).toEqual(["a", "b", "unassigned"]);
    await migrate();
    expect(await cases()).toEqual(before);
    await as("lead"); await choose("orgChapterMember", f.unitA);
    await owner();
    expect(await one("select private.organization_steward_scope_allows($1,$2,$3) v", [f.people.orgChapterMember.id, f.chapter, f.people.b.id])).toBe(false);
    expect((await db.query("select user_id from public.member_role_chapters where user_id=$1", [f.people.orgChapterMember.id])).rows).toEqual([]);
    expect(await cases()).toEqual(["a"]);
    await owner(); // Explicit-actor private helper has no app-role EXECUTE grant.
    // integration: 's shared private-message helper must honor
    // the permanent organization-backed unit choice as every case reader does.
    for (const name of ["a", "b", "unassigned"]) {
      expect(await one("select private.staff_actor_can_see_user($1,$2) v", [f.people.orgChapterMember.id,f.people[name].id])).toBe(name === "a");
    }
    await as("orgChapterMember");

    expect((await db.query("select case_id from public.search_member_cases('Fictional',50)")).rows.map((row) => row.case_id).filter((id) => Object.values(f.cases).includes(id))).toEqual([f.cases.a]);
    expect((await db.query("select * from public.casework_case_history($1,100,null)", [f.cases.b])).rows).toEqual([]);
    expect((await db.query("select * from public.casework_case_history($1,100,null)", [f.cases.a])).rows.length).toBeGreaterThan(0);

  });

  it.each(["member_profiles", "casework_intake_drafts", "chapter_records", "chapter_contact_log"])("keeps organization-backed %s reads in the chosen unit", async (table) => {
    // and 7:58 PM repair:
    // choosing a unit narrows every member-data reader, with an allowed A
    // control and refused B control, without creating chapter-role rows.
    await organizationActor("orgData", "steward");
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [f.people.orgData.id, f.chapter]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [f.people.orgData.id, f.chapter]);
    if (table === "chapter_records") { await as("admin"); await db.query("reset role"); }
    const ids = {};
    for (const name of ["a", "b"]) {
      const id = randomUUID(); ids[name] = id;
      if (table === "casework_intake_drafts") {
        await db.query("insert into public.casework_intake_drafts(id,organization_id,chapter_id,owner_user_id,member_user_id,payload) values($1,$2,$3,$4,$5,$6::jsonb)", [id,f.org,f.chapter,f.people.orgData.id,f.people[name].id,JSON.stringify({note:"Fictional "+name})]);
      } else if (table === "chapter_records") {
        await db.query("insert into public.chapter_records(id,chapter_id,record_type,title,body,occurred_at,created_by,lifecycle_status,visibility,access_unit_id) values($1,$2,'minutes',$3,'Private member data',now(),$4,'draft','staff',$5)", [id,f.chapter,"Fictional "+name,f.people.admin.id,name==="a"?f.unitA:f.unitB]);
      }
    }
    await migrate(); await as("lead"); await choose("orgData",f.unitA); await as("orgData");
    if (table === "member_profiles") {
      expect((await db.query("select id from public.member_profiles where id=any($1::uuid[])", [[f.people.a.id,f.people.b.id]])).rows.map((row)=>row.id)).toEqual([f.people.a.id]);
    } else if (table === "chapter_contact_log") {
      const workspace=await one("select public.get_institutional_records_workspace() v");
      expect(workspace.contacts.filter((row)=>[f.contacts.a,f.contacts.b].includes(row.id)).map((row)=>row.id)).toEqual([f.contacts.a]);
    } else {
      const rows=(await db.query("select id from public."+table+" where id=any($1::uuid[])", [Object.values(ids)])).rows;
      expect(rows.map((row)=>row.id)).toEqual([ids.a]);
    }
  });

  //  gate round 1 (P0 r3s1): a surviving organization steward grant keeps
  // needing an assignment in each chapter it covers.
  it("refuses removing a chapter steward unit while the person's organization steward grant survives", async () => {
    await owner();
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'steward')", [f.org, f.people.legacy.id]);
    await migrate();
    // The chapter grant carries this chapter; the organization grant's own
    // assignment covers only the sibling chapter.
    await owner();
    expect((await db.query("select chapter_id from private.organization_steward_unit_assignments where user_id=$1", [f.people.legacy.id])).rows).toEqual([{ chapter_id: f.sibling }]);
    await as("lead"); await choose("legacy", f.unitA);
    await as("admin");
    const refused = await denied("select public.set_member_access_role($1,$2,'steward',false,null,null) v", [f.people.legacy.id, f.chapter], ["22023"]);
    expect(refused.message).toBe("revoke the organization steward grant through organization administration");
    await owner();
    await db.query("savepoint raw_scope_delete");
    let raw;
    try {
      await db.query("delete from private.chapter_role_scopes where user_id=$1 and chapter_id=$2 and role='steward'", [f.people.legacy.id, f.chapter]);
      await db.query("delete from public.member_role_chapters where user_id=$1 and chapter_id=$2 and role='steward'", [f.people.legacy.id, f.chapter]);
      await db.query("set constraints all immediate");
    } catch (error) { raw = error; }
    await db.query("rollback to savepoint raw_scope_delete"); await db.query("release savepoint raw_scope_delete");
    await db.query("set constraints all deferred");
    expect(raw).toMatchObject({ code: "23514", message: "organization steward requires a unit in each covered chapter" });
    // With the organization grant revoked first, the chapter steward goes too.
    await as("admin");
    await one("select public.set_member_organization_role($1,'steward',false) v", [f.people.legacy.id]);
    await one("select public.set_member_access_role($1,$2,'steward',false,null,null) v", [f.people.legacy.id, f.chapter]);
    await owner(); await db.query("set constraints all immediate"); await db.query("set constraints all deferred");
    expect((await db.query("select count(*)::int n from private.steward_assignment_scopes($1,null)", [f.people.legacy.id])).rows[0].n).toBe(0);
  });

  //  gate round 1 (P0 r3s2/r4s1): the analytics roster follows the
  // steward's assignments; carry-over and higher roles keep their reach.
  it("limits a narrowed organization steward's named analytics roster to their unit and keeps carry-over and coordinators whole", async () => {
    await organizationActor("orgSteward", "steward");
    await organizationActor("orgCoordinator", "coordinator");
    // The analytics reader needs a selected organization, which comes from a
    // home chapter: both sit in the sibling chapter, outside the one compared.
    for (const name of ["orgSteward", "orgCoordinator"]) {
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [f.people[name].id, f.sibling]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [f.people[name].id, f.sibling]);
    }
    await migrate();
    const roster = async (name) => {
      await as(name);
      const workspace = await one("select public.get_organization_analytics_workspace() v");
      const names = new Map(Object.entries(f.people).map(([key, person]) => [person.id, key]));
      return workspace.members.filter((row) => row.chapterId === f.chapter).map((row) => names.get(row.id.split(":")[0])).filter(Boolean).sort();
    };
    const chapterMembers = ["a", "admin", "b", "defaultSteward", "lead", "legacy", "newSteward", "unassigned"];
    expect(await roster("orgCoordinator")).toEqual(chapterMembers);
    expect(await roster("orgSteward")).toEqual(chapterMembers);
    await as("lead"); await choose("orgSteward", f.unitA);
    expect(await roster("orgSteward")).toEqual(["a"]);
    expect(await roster("orgCoordinator")).toEqual(chapterMembers);
  });

  //  gate round 1 (P2 r3s3/r4s2): organization administration never
  // reports "no change" while a chapter steward grant keeps the access.
  it("refuses an organization-level steward removal that would leave a chapter steward grant in place", async () => {
    await migrate(); await as("admin");
    const refused = await denied("select public.set_member_organization_role($1,'steward',false) v", [f.people.legacy.id], ["22023"]);
    expect(refused.message).toBe("steward access is granted per chapter: remove it under Roles, units and committees");
    expect(await one("select (public.set_member_organization_role($1,'steward',false))->>'changed' v", [f.people.a.id])).toBe("false");
  });

  //  gate round 2 (P0 r5s1/r6s1): a scoped Coordinator or Advisor chapter
  // grant is not whole-chapter roster authority.
  it("keeps a scoped chapter coordinator grant from opening the whole analytics roster to an organization steward", async () => {
    await organizationActor("orgSteward", "steward");
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [f.people.orgSteward.id, f.chapter]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [f.people.orgSteward.id, f.chapter]);
    await migrate();
    const roster = async () => {
      await as("orgSteward");
      const workspace = await one("select public.get_organization_analytics_workspace() v");
      const names = new Map(Object.entries(f.people).map(([key, person]) => [person.id, key]));
      return workspace.members.filter((row) => row.chapterId === f.chapter).map((row) => names.get(row.id.split(":")[0])).filter(Boolean).sort();
    };
    await as("lead"); await choose("orgSteward", f.unitA);
    expect(await roster()).toEqual(["a", "orgSteward"]);
    await as("admin"); await one("select public.set_member_access_role($1,$2,'coordinator',true,$3,null) v", [f.people.orgSteward.id, f.chapter, f.unitA]);
    expect(await roster()).toEqual(["a", "orgSteward"]);
    await as("admin"); await one("select public.set_member_access_role($1,$2,'coordinator',true,null,null) v", [f.people.orgSteward.id, f.chapter]);
    expect(await roster()).toEqual(["a", "admin", "b", "defaultSteward", "lead", "legacy", "newSteward", "orgSteward", "unassigned"]);
  });

  //  gate round 2 (P0 r6s2): the backfill never turns an existing physical
  // unit into the default, even one named after its chapter.
  it("creates a separate default unit when a physical unit already has the chapter's name", async () => {
    await owner();
    const named = randomUUID();
    await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$2,$3,'Harbor chapter')", [named, f.org, f.chapter]);
    await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'steward',$2)", [f.people.newSteward.id, f.chapter]);
    await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'steward',$2)", [f.people.newSteward.id, f.chapter]);
    await db.query("insert into private.chapter_role_scopes(user_id,chapter_id,role,unit_id) values($1,$2,'steward',$3)", [f.people.newSteward.id, f.chapter, named]);
    // Settle this pre-migration scope before the backfill fixture alters the table.
    for (const { name } of (await db.query("select quote_ident(n.nspname)||'.'||quote_ident(c.conname) as name from pg_catalog.pg_constraint c join pg_catalog.pg_namespace n on n.oid=c.connamespace where c.conrelid='private.chapter_role_scopes'::regclass and c.condeferrable")).rows) await db.query("set constraints " + name + " immediate");
    await db.query("set constraints all deferred");
    await migrate();
    expect((await db.query("select id,name,is_default from private.chapter_units where chapter_id=$1 and (is_default or id=$2) order by is_default", [f.chapter, named])).rows)
      .toEqual([{ id: named, name: "Harbor chapter", is_default: false }, { id: f.defaultUnit, name: "Harbor chapter (all members)", is_default: true }]);
    expect((await reads("newSteward")).directory).toEqual([]);
    expect((await reads("legacy")).directory).toEqual(["a", "b", "unassigned"]);
  });

  //  final (P1 r7s1): the mechanism behind the static ordering check.
  it("refuses ALTER TABLE while a backfilled scope row has pending checks, and allows it after the migration's flush", async () => {
    await migrate(); await owner();
    await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'steward',$2)", [f.people.newSteward.id, f.chapter]);
    await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'steward',$2)", [f.people.newSteward.id, f.chapter]);
    await db.query("insert into private.chapter_role_scopes(user_id,chapter_id,role,unit_id) values($1,$2,'steward',$3)", [f.people.newSteward.id, f.chapter, f.unitA]);
    const alter = "alter table private.chapter_role_scopes add constraint c104_pending_probe check(true)";
    await denied(alter, [], ["55006"]);
    await db.query("set constraints all immediate"); await db.query("set constraints all deferred");
    await db.query(alter);
  });

  //  final (P2 r8s1): every default-unit name candidate is checked.
  it("finds an unused default unit name even when the chapter's earlier fallback names exist", async () => {
    await owner();
    const fallback = "Harbor chapter (all members " + createHash("md5").update(f.chapter).digest("hex").slice(0, 8) + ")";
    for (const name of ["Harbor chapter", "Harbor chapter (all members)", fallback]) {
      await db.query("insert into private.chapter_units(organization_id,chapter_id,name) values($1,$2,$3)", [f.org, f.chapter, name]);
    }
    await migrate();
    expect((await db.query("select name from private.chapter_units where chapter_id=$1 and is_default", [f.chapter])).rows).toEqual([{ name: "Harbor chapter (all members 2)" }]);
  });

  //  re-final (P0 r9s1) and its sweep: carry-over and organization
  // steward grants never reach a chapter created after the backfill.
  it("keeps carry-over organization and chapter stewards out of a chapter created after the backfill", async () => {
    await organizationActor("orgSteward", "steward");
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [f.people.orgSteward.id, f.sibling]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [f.people.orgSteward.id, f.sibling]);
    await migrate();
    await owner();
    const later = "unit-later-" + f.org, member = randomUUID(), laterCase = randomUUID();
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,'Later chapter',$1,$2,9989)", [later, f.org]);
    expect((await db.query("select count(*)::int n from private.chapter_units where chapter_id=$1 and is_default", [later])).rows[0].n).toBe(1);
    await db.query("insert into auth.users(id,email) values($1,$2)", [member, member + "@example.invalid"]);
    await db.query("update public.member_profiles set chapter_id=$2,full_name='Fictional later member' where id=$1", [member, later]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [f.org, member]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [member, later]);
    await db.query("insert into public.member_cases(id,user_id,reference,title,case_type) values($1::uuid,$2,$1::text,'Fictional later case','other')", [laterCase, member]);
    expect((await db.query("select chapter_id from public.member_cases where id=$1", [laterCase])).rows).toEqual([{ chapter_id: later }]);
    for (const name of ["orgSteward", "legacy"]) {
      await as(name);
      // Cases: the shared case predicate, the grievance scope, the unassigned list and claiming.
      expect((await db.query("select id from public.member_cases where id=$1", [laterCase])).rows, name).toEqual([]);
      await db.query("savepoint unassigned_list");
      let listed = [];
      try { listed = await one("select public.list_unassigned_chapter_cases() v"); await db.query("release savepoint unassigned_list"); }
      catch (error) { await db.query("rollback to savepoint unassigned_list"); await db.query("release savepoint unassigned_list"); if (error.code !== "42501") throw error; }
      expect(listed.some((row) => row.id === laterCase), name).toBe(false);
      await denied("select public.claim_member_case($1) v", [laterCase], ["42501"]);
      // Members.
      expect(await one("select public.staff_can_see_user($1,'steward') v", [member]), name).toBe(false);
      await owner(); await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.people[name].id, session_id: f.people[name].session, role: "authenticated", aal: "aal2" })]);
      expect(await one("select private.chapter_grievance_steward_scope($1,$2) v", [later, member]), name).toBe(false);
    }
    // Analytics: no named row from the later chapter for the organization steward.
    await as("orgSteward");
    expect((await one("select public.get_organization_analytics_workspace() v")).members.some((row) => row.chapterId === later)).toBe(false);
    // Control: carry-over still reaches the chapters that existed at the backfill.
    expect((await db.query("select id from public.member_cases where id=$1", [f.cases.a])).rows).toEqual([{ id: f.cases.a }]);
    expect(await one("select public.staff_can_see_user($1,'steward') v", [f.people.a.id])).toBe(true);
  });

  //  stage 148: the organization steward grant is never authority by
  // itself in a chapter created after the backfill.
  const laterChapter = async () => {
    await owner();
    const later = "unit-later-" + f.org, member = randomUUID();
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,'Later chapter',$1,$2,9989)", [later, f.org]);
    await db.query("insert into auth.users(id,email) values($1,$2)", [member, member + "@example.invalid"]);
    await db.query("update public.member_profiles set chapter_id=$2,full_name='Fictional later member' where id=$1", [member, later]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [f.org, member]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [member, later]);
    const defaultUnit = (await db.query("select id from private.chapter_units where chapter_id=$1 and is_default", [later])).rows[0].id;
    return { later, member, defaultUnit };
  };
  const carryOverOrganizationSteward = async () => {
    await organizationActor("orgSteward", "steward");
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [f.people.orgSteward.id, f.sibling]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [f.people.orgSteward.id, f.sibling]);
  };
  const joinChapter = async (name, chapter, roles = []) => {
    await owner();
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [f.people[name].id, chapter]);
    for (const role of roles) {
      await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing", [f.people[name].id, role, chapter]);
      await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [f.people[name].id, role, chapter]);
    }
  };

  // P0 r13s1: an office role (Secretary) never counts as case authority.
  it("refuses a retained coordinator case after Coordinator access is revoked, though Secretary and the carry-over organization grant remain", async () => {
    await carryOverOrganizationSteward();
    await migrate();
    const { later, member } = await laterChapter();
    await joinChapter("orgSteward", later, ["coordinator", "secretary"]);
    const laterCase = randomUUID();
    await db.query("insert into public.member_cases(id,user_id,reference,title,case_type,coordinator_user_id) values($1::uuid,$2,$1::text,'Fictional coordinated case','other',$3)", [laterCase, member, f.people.orgSteward.id]);
    const reach = async () => {
      await as("orgSteward");
      const rows = (await db.query("select id from public.member_cases where id=$1", [laterCase])).rows.length;
      const details = (await one("select public.casework_desk_case_details(array[$1]::uuid[]) v", [laterCase])).length;
      return { rows, details };
    };
    // Control: the live Coordinator role reaches the case it coordinates.
    expect(await reach()).toEqual({ rows: 1, details: 1 });
    await owner();
    await db.query("delete from public.member_role_chapters where user_id=$1 and chapter_id=$2 and role='coordinator'", [f.people.orgSteward.id, later]);
    expect(await reach()).toEqual({ rows: 0, details: 0 });
    await owner();
    expect(await one("select private.organization_steward_unassigned($1,$2) v", [f.people.orgSteward.id, later])).toBe(true);
    // Carry-over still reaches the chapters that existed at the backfill.
    expect(await one("select private.organization_steward_unassigned($1,$2) v", [f.people.orgSteward.id, f.chapter])).toBe(false);
  });

  // P0 r13s2: a lead cannot create the first steward assignment in a
  // chapter where the person holds only the organization grant.
  it("refuses a non-Admin lead the first steward assignment in a later chapter for an organization steward", async () => {
    await carryOverOrganizationSteward();
    await migrate();
    const { later, defaultUnit } = await laterChapter();
    await joinChapter("orgSteward", later);
    const lead = randomUUID(), session = randomUUID(); f.people.laterLead = { id: lead, session };
    await db.query("insert into auth.users(id,email) values($1,$2)", [lead, lead + "@example.invalid"]);
    await db.query("update public.member_profiles set chapter_id=$2,full_name='Fictional later lead' where id=$1", [lead, later]);
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, lead]);
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), lead]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [f.org, lead]);
    await joinChapter("laterLead", later, ["vp"]);
    await as("laterLead");
    const refused = await denied("select public.set_member_access_role($1,$2,'steward',true,$3,null) v", [f.people.orgSteward.id, later, defaultUnit], ["42501"]);
    expect(refused.message).toBe("admin required for a new steward grant");
    await owner();
    expect((await db.query("select role from public.member_role_chapters where user_id=$1 and chapter_id=$2", [f.people.orgSteward.id, later])).rows).toEqual([]);
    // Control: an organization Admin may create it.
    await as("admin");
    expect((await one("select public.set_member_access_role($1,$2,'steward',true,$3,null) v", [f.people.orgSteward.id, later, defaultUnit])).updated).toBe(true);
  });

  // Sweep: the unscoped shortcuts of case search and clause counts read a
  // stored steward column; they now give such a chapter to the shared oracle.
  const retainedStewardCase = async () => {
    await carryOverOrganizationSteward();
    await migrate();
    const { later, member } = await laterChapter();
    await joinChapter("orgSteward", later);
    const laterCase = randomUUID(), article = "Article 77-" + f.org.slice(0, 8);
    await db.query("insert into public.contract_clauses(organization_id,article,section,category,title,summary,status) values($1,$2,'1','Proof','Fictional clause','Fictional clause summary','published')", [f.org, article]);
    await db.query("insert into public.member_cases(id,user_id,reference,title,case_type,articles,steward_user_id) values($1::uuid,$2,$1::text,'Fictional quokka grievance','other',$3,$4)", [laterCase, member, article, f.people.orgSteward.id]);
    await as("orgSteward");
    expect((await db.query("select id from public.member_cases where id=$1", [laterCase])).rows).toEqual([]);
    return { laterCase, article };
  };
  it("keeps case search equal to row access for a retained steward case in a later chapter", async () => {
    await retainedStewardCase();
    expect((await db.query("select case_id from public.search_member_cases('quokka',20)")).rows).toEqual([]);
  });
  it("keeps clause grievance counts equal to row access for a retained steward case in a later chapter", async () => {
    const { article } = await retainedStewardCase();
    const counts = await one("select public.list_contract_clause_grievance_counts() v");
    expect(counts.find((row) => row.article.toLowerCase() === article.toLowerCase())?.count ?? 0).toBe(0);
  });

  //  re-final (P1 r10s1): a Steward request is approved into a unit.
  it("approves a Steward request only with a chapter unit, through the unit setter", async () => {
    await migrate(); await owner();
    const request = randomUUID();
    await db.query("insert into public.member_requests(id,organization_id,chapter_id,kind,requester_user_id,requested_role) values($1,$2,$3,'access_request',$4,'steward')", [request, f.org, f.chapter, f.people.newSteward.id]);
    await as("admin");
    const refused = await denied("select public.decide_member_request($1,'approved') v", [request], ["22023"]);
    expect(refused.message).toBe("steward approval requires a chapter unit");
    expect((await one("select public.decide_member_request($1,'approved',$2) v", [request, f.unitA])).status).toBe("approved");
    await owner();
    expect((await db.query("select role,unit_id,committee_id from private.chapter_role_scopes where user_id=$1 and chapter_id=$2", [f.people.newSteward.id, f.chapter])).rows).toEqual([{ role: "steward", unit_id: f.unitA, committee_id: null }]);
    expect((await db.query("select status from public.member_requests where id=$1", [request])).rows).toEqual([{ status: "approved" }]);
  });

});
