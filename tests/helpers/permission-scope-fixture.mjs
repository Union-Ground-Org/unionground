// Seeded identities and target data for the permission-scope matrix
// (TEST-UG-PERMISSION-SCOPE-MATRIX-20261110, tests/permission-scope-matrix-db.test.js).
// Every write happens inside the caller's open transaction, which the caller
// rolls back. All names are fictional.
import { randomUUID } from "node:crypto";

export async function createScopeFixture(q, { privateMarker, nameMarker }) {
  const seed = {};
  const people = {};

  async function become(identity) {
    await q("reset role");
    if (identity === "owner") {
      await q("select set_config('request.jwt.claims', '', true)");
      return;
    }
    if (identity === "signedOut") {
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
      await q("set local role anon");
      return;
    }
    const person = people[identity];
    await q("select set_config('request.jwt.claims', $1, true)",
      [JSON.stringify({ sub: person.id, role: "authenticated", session_id: person.session, aal: "aal2" })]);
    await q("set local role authenticated");
  }

  async function addPerson(name, { organization, chapter, role = null }) {
    const id = randomUUID();
    const session = randomUUID();
    const email = name === "target" ? `${privateMarker}@example.invalid` : `${id}@example.invalid`;
    await q("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [id, email]);
    await q("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1",
      [id, chapter, name === "target" ? `${nameMarker} Target` : `Fictional ${name}`]);
    await q("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, id]);
    await q("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    await q("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [organization, id]);
    await q("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, chapter]);
    if (role) {
      await q("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [id, role, chapter]);
      await q("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [id, role, chapter]);
    }
    people[name] = { id, session };
    return id;
  }

  seed.organization = randomUUID();
  seed.otherOrganization = randomUUID();
  seed.chapter = `scope-${seed.organization}`;
  seed.otherChapter = `scope-${seed.otherOrganization}`;
  await q("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Harbor Workers'),($2::uuid,$2::text,'Ridge Transit')",
    [seed.organization, seed.otherOrganization]);
  await q("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$2,9950),($3,$3,$3,$4,9951)",
    [seed.chapter, seed.organization, seed.otherChapter, seed.otherOrganization]);
  const home = { organization: seed.organization, chapter: seed.chapter };
  await addPerson("admin", { ...home, role: "admin" });
  seed.target = await addPerson("target", home);
  await addPerson("member", home);
  await addPerson("unitSteward", home);
  await addPerson("otherUnitSteward", home);
  await addPerson("chapterLead", { ...home, role: "vp" });
  await addPerson("otherOrganization", { organization: seed.otherOrganization, chapter: seed.otherChapter, role: "admin" });
  seed.unitSteward = people.unitSteward.id;

  seed.unit = randomUUID();
  seed.otherUnit = randomUUID();
  await q("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$3,$4,'Garage A'),($2,$3,$4,'Garage B')",
    [seed.unit, seed.otherUnit, seed.organization, seed.chapter]);
  await become("admin");
  for (const name of ["target", "member"]) {
    await q("select public.set_chapter_access_member($1,$2,$3,null,true)", [seed.chapter, people[name].id, seed.unit]);
  }
  await q("select public.set_member_access_role($1,$2,'steward',true,$3,null)", [people.unitSteward.id, seed.chapter, seed.unit]);
  await q("select public.set_member_access_role($1,$2,'steward',true,$3,null)", [people.otherUnitSteward.id, seed.chapter, seed.otherUnit]);
  await become("owner");

  seed.caseId = randomUUID();
  seed.formId = randomUUID();
  await q("insert into public.member_cases(id,user_id,reference,title,case_type,steward_user_id) values($1::uuid,$2,$1::text,$3,'other',$4)",
    [seed.caseId, seed.target, `Case ${privateMarker}`, seed.unitSteward]);
  await q("insert into public.member_case_updates(case_id,user_id,body) values($1,$2,$3)", [seed.caseId, seed.target, `Note ${privateMarker}`]);
  await q("insert into public.member_forms(id,user_id,template_key,status,answers,step,submitted_at) values($1,$2,'alliance_grievance','submitted',$3::jsonb,1,now())",
    [seed.formId, seed.target, JSON.stringify({ details: `Answer ${privateMarker}` })]);
  return { seed, people, become };
}
