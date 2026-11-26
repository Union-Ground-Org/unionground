import { randomUUID } from "node:crypto";

// Two report reads must not turn an otherwise safe aggregate into a named
// person's answer. Run the real RPC, with real profile and membership writes.
// Groups hold 25 people each: the split never goes below 25 whatever the
// survey's own floor (REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104).
export async function proveWorkplaceReleasePrivacy({ client, tenants, person, actAs, asOwner, capture, expect }) {
  const tenant = await tenants();
  const admin = await person(tenant, tenant.library, { role: "admin" });
  await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'admin',$2)", [tenant.orgA, admin]);
  const members = [];
  for (let i = 0; i < 50; i += 1) members.push(await person(tenant, tenant.library));
  const survey = randomUUID();
  const question = randomUUID();
  await client.query("insert into public.organization_surveys(id,organization_id,title,status,privacy_min_responses) values ($1,$2,'Two-release privacy proof','closed',3)", [survey, tenant.orgA]);
  await client.query("insert into public.organization_survey_questions(id,organization_id,survey_id,sort_index,question_type,label) values ($1,$2,$3,0,'yes_no','Enough staff?')", [question, tenant.orgA, survey]);
  for (let i = 0; i < members.length; i += 1) {
    const session = randomUUID();
    await client.query("insert into public.member_profile_details(user_id,worksite,details_visibility) values($1,$2,'admins')", [members[i], i < 25 ? "A" : "B"]);
    await client.query("insert into public.organization_survey_sessions(id,organization_id,survey_id,respondent_user_id,status,submitted_at) values($1,$2,$3,$4,'submitted',now())", [session, tenant.orgA, survey, members[i]]);
    await client.query("insert into public.organization_survey_answers(organization_id,session_id,question_id,value) values($1,$2,$3,$4::jsonb)", [tenant.orgA, session, question, JSON.stringify(i < 25 ? "yes" : "no")]);
  }
  const report = async () => {
    await actAs(admin);
    const result = await capture("select public.get_organization_survey_worksites($1) as v", [survey]);
    await asOwner();
    expect(result.ok, result.message).toBe(true);
    return result.value;
  };
  const initial = await report();
  expect(initial.groups.map((g) => [g.worksite, g.responseCount])).toEqual([["A", 25], ["B", 25]]);
  expect(initial.groups.every((g) => g.questions[0].available)).toBe(true);
  expect(await report()).toEqual(initial);
  const changes = [
    ["worksite move", async () => {
      await actAs(members[0]);
      const saved = await capture("select public.set_my_profile_details_v2($1) as v", [{ worksite: "B", detailsVisibility: "admins", phoneVisibility: "only_me" }]);
      await asOwner();
      expect(saved.ok, saved.message).toBe(true);
    }],
    ["sharing withdrawal", async () => {
      await actAs(members[0]);
      expect((await capture("select public.set_my_profile_details_v2($1) as v", [{ worksite: "A", detailsVisibility: "only_me", phoneVisibility: "only_me" }])).ok).toBe(true);
      await asOwner();
    }],
    ["organization membership revoked", () => client.query("update public.organization_memberships set status='revoked',revoked_at=now() where user_id=$1 and organization_id=$2", [members[0], tenant.orgA])],
    ["chapter membership revoked", () => client.query("update public.member_chapter_memberships set status='revoked',revoked_at=now() where user_id=$1 and chapter_id=$2", [members[0], tenant.library])],
    ["answer changed", () => client.query("update public.organization_survey_answers a set value='\"no\"'::jsonb from public.organization_survey_sessions s where s.id=a.session_id and s.respondent_user_id=$1 and a.question_id=$2", [members[0], question])],
  ];
  for (const [label, change] of changes) {
    await client.query("savepoint change_case");
    await change();
    const changed = await report();
    expect(changed, label).toMatchObject({ withheld: true, releaseChanged: true, groups: [] });
    // Restoring the inputs must not re-arm a previously invalidated release.
    await client.query("update public.member_profile_details set worksite='A',details_visibility='admins' where user_id=$1", [members[0]]);
    expect(await report(), label).toMatchObject({ releaseChanged: true, groups: [] });
    await client.query("rollback to savepoint change_case");
    expect(await report()).toEqual(initial);
  }
  await actAs(admin);
  expect(await capture("select * from private.organization_survey_worksite_releases")).toMatchObject({ ok: false, code: "42501" });
  await asOwner();
}

// Extends the registered profile-details DB proof (same transaction and
// disposable-target assertion), so required CI runs these behavioral cases.
export async function proveWorkplaceRoster({ client, tenants, person, actAs, asOwner, capture, expect }) {
  const tenant = await tenants();
  const admin = await person(tenant, tenant.library, { role: "admin" });
  const steward = await person(tenant, tenant.library, { role: "steward" });
  const foreignAdmin = await person(tenant, tenant.other, { organization: tenant.orgB, role: "admin" });
  await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'admin',$2),($1,$3,'steward',$2),($4,$5,'admin',$5) on conflict do nothing", [tenant.orgA, admin, steward, tenant.orgB, foreignAdmin]);
  await client.query("insert into public.organization_setting_values(organization_id,setting_key,value,updated_by) values ($1,'lists.organizing.worksites','[\"Main\",\"East\"]'::jsonb,$2)", [tenant.orgA, admin]);
  // Each worksite holds 25 "yes" and 25 "no" answers, so both cells clear the
  // server minimum of 25.
  const members = [];
  for (let i = 0; i < 100; i += 1) members.push(await person(tenant, tenant.library));
  const fields = { worksite: "Main", shift: "Nights", classification: "Clerk II", detailsVisibility: "admins", phoneVisibility: "only_me" };
  await actAs(members[0]);
  const saved = await capture("select public.set_my_profile_details_v2($1) as v", [fields]);
  expect(saved.ok, saved.message).toBe(true);
  expect(saved.value).toMatchObject(fields);
  expect(saved.value.workplaceOptions.worksite).toEqual(["Main", "East"]);
  const invalid = await capture("select public.set_my_profile_details_v2($1) as v", [{ ...fields, shift: "x".repeat(121) }]);
  expect(invalid).toMatchObject({ ok: false, code: "22023" });
  const target = await capture("select public.set_my_profile_details_v2($1) as v", [{ ...fields, userId: members[1] }]);
  expect(target).toMatchObject({ ok: false, code: "22023" });
  const direct = await capture("select * from public.member_profile_details");
  expect(direct).toMatchObject({ ok: false, code: "42501" });
  const old = await capture("select public.set_my_profile_details(null,null,'Main',null,'admins','only_me') as v");
  expect(old.value).toMatchObject({ shift: "Nights", classification: "Clerk II" });
  await asOwner();
  const exported = (await client.query("select private.account_lifecycle_export_member_profile_details($1) as v", [members[0]])).rows[0].v;
  expect(exported[0]).toMatchObject({ shift: "Nights", classification: "Clerk II" });
  await actAs(admin);
  // Search by name: the roster is larger than one directory page.
  const directory = await capture("select public.get_admin_member_directory($1, null, null, 50) as v", [`Proof ${members[0].slice(0, 8)}`]);
  expect(directory.value.items.find((row) => row.userId === members[0]).profileDetails).toMatchObject({ worksite: "Main", shift: "Nights", classification: "Clerk II" });
  await asOwner();

  const survey = randomUUID();
  const question = randomUUID();
  await client.query("insert into public.organization_surveys(id,organization_id,title,status,privacy_min_responses) values ($1,$2,'Workplace proof','open',3)", [survey, tenant.orgA]);
  await client.query("insert into public.organization_survey_questions(id,organization_id,survey_id,sort_index,question_type,label) values ($1,$2,$3,0,'yes_no','Enough staff?')", [question, tenant.orgA, survey]);
  for (let i = 0; i < members.length; i += 1) {
    const session = randomUUID();
    await client.query("insert into public.member_profile_details(user_id,worksite,details_visibility) values($1,$2,'admins') on conflict(user_id) do update set worksite=excluded.worksite,details_visibility='admins'", [members[i], i < 50 ? "Main" : "East"]);
    await client.query("insert into public.organization_survey_sessions(id,organization_id,survey_id,respondent_user_id,status,submitted_at) values($1,$2,$3,$4,'submitted',now())", [session, tenant.orgA, survey, members[i]]);
    await client.query("insert into public.organization_survey_answers(organization_id,session_id,question_id,value) values($1,$2,$3,$4::jsonb)", [tenant.orgA, session, question, JSON.stringify(i % 50 < 25 ? "yes" : "no")]);
  }
  async function report(user = admin, id = survey) {
    await actAs(user);
    const result = await capture("select public.get_organization_survey_worksites($1) as v", [id]);
    await asOwner();
    return result;
  }
  await client.query("savepoint before_release");
  let result = await report();
  expect(result.ok, result.message).toBe(true);
  expect(result.value.groups.map((group) => [group.worksite, group.responseCount])).toEqual([["East", 50], ["Main", 50]]);
  expect(result.value.groups.every((group) => group.questions[0].available)).toBe(true);
  expect(result.value.groups[0].questions[0].distribution).toHaveLength(2);
  expect(await report(steward)).toMatchObject({ ok: false, code: "42501" });
  expect(await report(foreignAdmin)).toMatchObject({ ok: false, code: "P0002" });
  expect(await report(members[0])).toMatchObject({ ok: false, code: "42501" });

  // One hidden respondent must not be reconstructed from the overall total.
  await client.query("update public.member_profile_details set details_visibility='only_me',worksite='Never disclose this' where user_id=$1", [members[0]]);
  result = await report();
  expect(result.value).toMatchObject({ withheld: true, releaseChanged: true, groups: [] });
  expect(JSON.stringify(result.value)).not.toContain("Never disclose");
  await client.query("rollback to savepoint before_release");

  // A former member's current workplace is never exposed to their old tenant.
  await client.query("update public.member_profile_details set details_visibility='admins',worksite='New employer' where user_id=$1", [members[0]]);
  await client.query("update public.organization_memberships set status='revoked',revoked_at=now() where user_id=$1 and organization_id=$2", [members[0], tenant.orgA]);
  result = await report();
  expect(JSON.stringify(result.value)).not.toContain("New employer");
  await client.query("rollback to savepoint before_release");

  // Restore both groups and create a rare answer: suppress it everywhere,
  // including the safe group's counterpart that the overall report exposes.
  await client.query("update public.member_profile_details set details_visibility='admins',worksite='Main' where user_id=$1", [members[0]]);
  await client.query("update public.organization_survey_answers a set value='\"rare\"'::jsonb from public.organization_survey_sessions s where s.id=a.session_id and s.respondent_user_id=$1 and a.question_id=$2", [members[0], question]);
  result = await report();
  expect(result.value.groups).toHaveLength(2);
  expect(result.value.groups.every((group) => !group.questions[0].available && group.questions[0].distribution.length === 0)).toBe(true);
  await client.query("rollback to savepoint before_release");
  // A survey floor above the server minimum still wins.
  await client.query("update public.organization_surveys set privacy_min_responses=51 where id=$1", [survey]);
  expect((await report()).value).toEqual({ privacyMinResponses: 51, withheld: true, groups: [] });
}
