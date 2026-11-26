// @vitest-environment node
// #7662 option b: prove the existing grants and row boundaries. This PR
// changes presentation only; every fixture mutation is rolled back.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

// #8568: fixture dates are built on the Eastern day, the day the readers count;
// the session's current_date is the UTC day, tomorrow from 7 PM Eastern.

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("chapter lead access on an owned disposable database", () => {
  let db;
  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "chapter-lead-access-proof" });
    await db.connect();
    await db.query("set statement_timeout='15s'");
  });
  afterAll(async () => { await db?.end(); });

  async function owner() {
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claims','',true)");
  }
  async function as(person) {
    await owner();
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: person.id, role: "authenticated", aal: "aal2", session_id: person.session })]);
    await db.query("set local role authenticated");
  }
  const one = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.v;
  async function refused(sql, args) {
    await db.query("savepoint refusal");
    let error;
    try { await db.query(sql, args); } catch (caught) { error = caught; }
    await db.query("rollback to savepoint refusal");
    await db.query("release savepoint refusal");
    expect(error?.code).toBe("42501");
  }
  async function fixtures() {
    const org = randomUUID(), otherOrg = randomUUID();
    const chapter = `lead-main-${org}`, east = `lead-east-${org}`, foreign = `lead-other-${otherOrg}`;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Fictional Juniper'),($2::uuid,$2::text,'Fictional Copperline')", [org, otherOrg]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,'Main',$1,$4,9981),($2,'East',$2,$4,9982),($3,'Other',$3,$5,9983)", [chapter, east, foreign, org, otherOrg]);
    const people = {};
    for (const [name, home, organization, role, organizationRole] of [
      ["admin", chapter, org, "admin", null], ["lead", chapter, org, "steward", null],
      ["first", chapter, org, null, null], ["second", chapter, org, null, null],
      ["east", east, org, null, null], ["eastAdmin", east, org, "admin", null], ["foreign", foreign, otherOrg, null, null],
      ["orgAdmin", chapter, org, null, "admin"], ["foreignAdmin", foreign, otherOrg, null, "admin"],
    ]) {
      const id = randomUUID(), session = randomUUID();
      people[name] = { id, session };
      await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${id}@example.invalid`]);
      await db.query("update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1", [id, home, `Fictional ${name}`]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [organization, id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, home]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, id]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
      if (role) {
        await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [id, role, home]);
        await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [id, role, home]);
      }
      if (organizationRole) await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,$3)", [organization, id, organizationRole]);
    }
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [people.orgAdmin.id, east]);
    const units = [randomUUID(), randomUUID()];
    await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$3,$4,'First unit'),($2,$3,$4,'Second unit')", [...units, org, chapter]);
    await db.query("insert into private.chapter_unit_members(unit_id,chapter_id,user_id) values($1,$3,$4),($2,$3,$5),($1,$3,$6)", [...units, chapter, people.first.id, people.second.id, people.lead.id]);
    await db.query("insert into private.chapter_role_scopes(user_id,chapter_id,role,unit_id) values($1,$2,'steward',$3)", [people.lead.id, chapter, units[0]]);
    const cases = {};
    for (const key of ["first", "second", "east", "foreign"]) {
      cases[key] = randomUUID();
      await db.query("insert into public.member_cases(id,user_id,reference,title,case_type,status,deadline) values($1::uuid,$2,$1::text,$3,'other','active',(now() at time zone 'America/New_York')::date-1)", [cases[key], people[key].id, `Fictional ${key} case`]);
      await as(people[key]);
      await one("select public.set_my_profile_details('they/them',$1,'Fictional site','555-0100','admins','admins') v", [`${key} detail`]);
      await owner();
    }
    const documents = {};
    for (const [key, scope, unit] of [["first", chapter, units[0]], ["second", chapter, units[1]], ["east", east, null]]) {
      // Office writes require the actor's selected chapter even for an
      // organization administrator. Create each fixture in its real context.
      await as(key === "east" ? people.eastAdmin : people.orgAdmin);
      documents[key] = (await one("select public.create_chapter_office_document($1,$2,'Fictional body','Summary',$3,null,true) v", [scope, `${key} document`, unit])).id;
    }
    await as(people.foreignAdmin);
    documents.foreign = (await one("select public.create_chapter_office_document($1,'Foreign document','Fictional body','Summary',null,null,true) v", [foreign])).id;
    await owner();
    return { org, otherOrg, chapter, east, foreign, people, units, cases, documents };
  }
  async function grantLead(f) {
    await as(f.people.admin);
    await one("select public.set_member_chapter_role($1,$2,'vp',true) v", [f.people.lead.id, f.chapter]);
  }

  it("lets a chapter admin add chapter lead to a unit steward and records the grant without removing stewardship", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      await grantLead(f);
      await owner();
      const roles = (await db.query("select role from public.member_role_chapters where user_id=$1 and chapter_id=$2 order by role", [f.people.lead.id, f.chapter])).rows.map((row) => row.role);
      expect(roles).toEqual(["steward", "vp"]);
      const audit = (await db.query("select actor,action,detail from public.member_admin_audit where target_user=$1 and action='grant_role' and detail->>'role'='vp'", [f.people.lead.id])).rows;
      expect(audit).toEqual([{ actor: f.people.admin.id, action: "grant_role", detail: { role: "vp", chapterId: f.chapter } }]);
      if (process.env.CHAPTER_LEAD_AUDIT_EVIDENCE) writeFileSync(process.env.CHAPTER_LEAD_AUDIT_EVIDENCE,
        JSON.stringify({ targetUserId: f.people.lead.id, roles, audit }, null, 2), { mode: 0o600 });
    } finally { await db.query("rollback"); }
  }, 120_000);

  it("reads personal details, leadership case projections and documents of both units, excluding another chapter and organization", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      await grantLead(f);
      await as(f.people.lead);
      const directory = await one("select public.get_admin_member_directory('',null,null,50) v");
      for (const key of ["first", "second"]) expect(directory.items.find((row) => row.userId === f.people[key].id)?.profileDetails.jobTitle).toBe(`${key} detail`);
      for (const key of ["east", "eastAdmin", "foreign", "foreignAdmin"]) expect(directory.items.some((row) => row.userId === f.people[key].id)).toBe(false);
      // The shipped leadership reader exposes case projections. The raw-row
      // RLS contract remains owner/Steward/Coordinator, not an implied grant
      // of casework assignment or mutation rights to chapter leadership.
      const overview = await one("select public.get_vp_overview() v");
      expect(overview.activeGrievances).toBe(2);
      expect(overview.attention.map((row) => row.id).sort()).toEqual([f.cases.first, f.cases.second].sort());
      const visibleCases = (await db.query("select id from public.member_cases where id=any($1::uuid[]) order by id", [Object.values(f.cases)])).rows.map((row) => row.id);
      expect(visibleCases).toEqual([f.cases.first]);
      const docs = await one("select public.list_chapter_office_documents($1,0) v", [f.chapter]);
      expect(docs.map((row) => row.id).sort()).toEqual([f.documents.first, f.documents.second].sort());
      // Query known IDs through the authenticated table grant and RLS, so a
      // wrong-chapter RPC argument cannot substitute for a visibility proof.
      const visibleDocuments = (await db.query("select id from public.chapter_documents where id=any($1::uuid[])", [Object.values(f.documents)])).rows.map((row) => row.id);
      expect(visibleDocuments.sort()).toEqual([f.documents.first, f.documents.second].sort());
      await refused("select public.switch_my_chapter($1) v", [f.east]);
      await refused("select public.switch_my_chapter($1) v", [f.foreign]);
    } finally { await db.query("rollback"); }
  }, 120_000);

  it("keeps organization admin access across its chapters and outside the foreign organization", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      await as(f.people.orgAdmin);
      const directory = await one("select public.get_admin_member_directory('',null,null,50) v");
      for (const key of ["first", "second", "east"]) expect(directory.items.find((row) => row.userId === f.people[key].id)?.profileDetails.jobTitle).toBe(`${key} detail`);
      expect(directory.items.some((row) => row.userId === f.people.foreign.id)).toBe(false);
      const visibleCases = (await db.query("select id from public.member_cases where id=any($1::uuid[])", [Object.values(f.cases)])).rows.map((row) => row.id);
      expect(visibleCases).toEqual([]);
      const overview = await one("select public.get_vp_overview() v");
      expect(overview.activeGrievances).toBe(2);
      expect(overview.attention.map((row) => row.id).sort()).toEqual([f.cases.first, f.cases.second].sort());
      // The office page remains selected-chapter scoped for organization
      // admins too; an explicit authorized chapter switch retains their role.
      const documents = await one("select public.list_chapter_office_documents($1,0) v", [f.chapter]);
      expect(documents.map((row) => row.id).sort()).toEqual([f.documents.first, f.documents.second].sort());
      const foreignDocument = (await db.query("select id from public.chapter_documents where id=$1", [f.documents.foreign])).rows;
      expect(foreignDocument).toEqual([]);
      await one("select public.switch_my_chapter($1) v", [f.east]);
      const eastOverview = await one("select public.get_vp_overview() v");
      expect(eastOverview.activeGrievances).toBe(1);
      expect(eastOverview.attention.map((row) => row.id)).toEqual([f.cases.east]);
      const eastDocuments = await one("select public.list_chapter_office_documents($1,0) v", [f.east]);
      expect(eastDocuments.map((row) => row.id)).toEqual([f.documents.east]);
      await refused("select public.switch_my_chapter($1) v", [f.foreign]);
    } finally { await db.query("rollback"); }
  }, 120_000);
});
