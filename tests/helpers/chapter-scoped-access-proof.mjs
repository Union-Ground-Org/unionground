import {migrateLegacyStewardFixtures} from "./steward-unit-fixtures.js";
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// #8568: fixture dates are built on the Eastern day, the day the readers count;
// the session's current_date is the UTC day, tomorrow from 7 PM Eastern.

export async function runPreparedProofMatrix(db) {
  const org=randomUUID(),foreignOrg=randomUUID();
  const chapter='g1-'+org,foreign='g1-'+foreignOrg;
  const people={}; let passed=0;
  await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Harbor Workers'),($2::uuid,$2::text,'Ridge Transit')",[org,foreignOrg]);
  await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$2,9940),($3,$3,$3,$4,9941)",[chapter,org,foreign,foreignOrg]);
  for(const [name,role,ownChapter,ownOrg] of [
    ['admin','admin',chapter,org],['president','vp',chapter,org],['steward','steward',chapter,org],
    ['scoped',null,chapter,org],['secretary',null,chapter,org],['memberA',null,chapter,org],['memberB',null,chapter,org],['foreign',null,foreign,foreignOrg]
  ]) {
    const id=randomUUID(),session=randomUUID();people[name]={id,session};
    await db.query('insert into auth.users(id,email) values($1,$2)',[id,id+'@example.invalid']);
    await db.query('update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1',[id,ownChapter,'Fictional '+name]);
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())",[session,id]);
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())",[randomUUID(),id]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')",[ownOrg,id]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",[id,ownChapter]);
    if(role) {
      await db.query('insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)',[id,role,ownChapter]);
      await db.query('insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)',[id,role,ownChapter]);
    }
  }
  const owner=async()=>{await db.query('reset role');await db.query("select set_config('request.jwt.claims','',true)");};
  const as=async(name,aal='aal2')=>{
    await owner();await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:people[name].id,role:'authenticated',session_id:people[name].session,aal})]);await db.query('set local role authenticated');
  };
  const one=async(sql,args=[])=> (await db.query(sql,args)).rows[0]?.v;
  const refused=async(sql,args=[],code='42501')=>{
    await db.query('savepoint negative');let failure;
    try{await db.query(sql,args);}catch(error){failure=error;}
    await db.query('rollback to savepoint negative');await db.query('release savepoint negative');
    assert.ok(failure,'negative control was allowed');assert.equal(failure.code,code);passed++;
  };
  const unitA=randomUUID(),unitB=randomUUID();
  await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$3,$4,'Garage A'),($2,$3,$4,'Garage B')",[unitA,unitB,org,chapter]);
  await as('admin');
  await one('select public.set_chapter_access_member($1,$2,$3,null,true) v',[chapter,people.memberA.id,unitA]);
  await one('select public.set_chapter_access_member($1,$2,$3,null,true) v',[chapter,people.memberB.id,unitB]);
  await one("select public.set_member_access_role($1,$2,'steward',true,$3,null) v",[people.scoped.id,chapter,unitA]);
  // Retain only the pre-existing broad controls.
  await owner(); await migrateLegacyStewardFixtures(db);
  await as('scoped');
  assert.equal(await one("select public.staff_can_see_user($1,'steward') v",[people.memberA.id]),true);passed++;
  assert.equal(await one("select public.staff_can_see_user($1,'steward') v",[people.memberB.id]),false);passed++;
  assert.equal(await one("select public.staff_can_see_user($1,'steward') v",[people.foreign.id]),false);passed++;
  await db.query('reset role');
  assert.equal(await one("select private.member_has_chapter_role($1,array['steward']) v",[chapter]),false);passed++;
  await as('president');
  await one("select public.set_member_access_role($1,$2,'secretary',true) v",[people.secretary.id,chapter]);
  await refused("select public.set_member_access_role($1,$2,'admin',true) v",[people.memberA.id,chapter]);
  await as('secretary');
  const workspace=await one('select public.get_institutional_records_workspace() v');
  assert.equal(workspace.canManage,true);assert.equal(workspace.canContacts,false);assert.deepEqual(workspace.contacts,[]);passed++;
  assert.equal(await one("select public.staff_can_see_user($1,'secretary') v",[people.memberA.id]),false);passed++;
  await db.query('reset role');
  assert.equal(await one("select count(*)::integer v from private.staff_visible_member_ids('secretary')"),0);passed++;
  await as('secretary');
  await refused("select public.create_member_invitation('example@example.invalid','Example Person',$1,'admin','en',$2) v",[chapter,'aa'.repeat(32)]);
  await as('admin');
  await one("select public.set_chapter_role_capability($1,'secretary','records',false) v",[chapter]);
  await as('secretary');
  assert.equal((await one('select public.get_institutional_records_workspace() v')).canManage,false);passed++;
  await as('admin');
  const committee=await one("select public.save_chapter_committee(null,$1,'Safety','Workplace safety',(now() at time zone 'America/New_York')::date,null,false) v",[chapter]);
  await one('select public.set_chapter_access_member($1,$2,null,$3,true) v',[chapter,people.memberA.id,committee.id]);
  // Committee-only stewards are refused.
  // Preserve all out-of-scope refusals with a valid empty-unit assignment.
  await refused("select public.set_member_access_role($1,$2,'steward',true,null,$3) v",[people.scoped.id,chapter,committee.id],'22023');passed++;
  await owner(); const emptyUnit=randomUUID();
  await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$2,$3,'Fictional empty unit')",[emptyUnit,org,chapter]);
  await as('admin'); await one("select public.set_member_access_role($1,$2,'steward',true,$3,null) v",[people.scoped.id,chapter,emptyUnit]);
  await owner();
  const caseA=randomUUID(),caseB=randomUUID();
  await db.query("insert into public.member_cases(id,user_id,reference,title,case_type,steward_user_id) values($1::uuid,$2,$1::text,'Private identity A','other',$5),($3::uuid,$4,$3::text,'Private identity B','other',$5)",[caseA,people.memberA.id,caseB,people.memberB.id,people.steward.id]);
  await db.query("update public.member_cases set articles='Scoped Article' where id=any($1::uuid[])",[[caseA,caseB]]);
  await db.query("insert into public.contract_clauses(organization_id,article,category,title,summary,status) values($1,'Scoped Article','Proof','Scoped counts','Fictional scope proof','published')",[org]);
  const caseObject=people.memberA.id+'/'+caseA+'/'+randomUUID()+'/case.pdf';
  await db.query("insert into public.member_case_files(case_id,user_id,object_name,filename,mime_type,size_bytes,uploaded_by,confirmed_at) values($1,$2,$3,'case.pdf','application/pdf',128,$2,now())",[caseA,people.memberA.id,caseObject]);
  const pendingObject=people.memberA.id+'/'+caseA+'/'+randomUUID()+'/pending.pdf';
  const removedObject=people.memberA.id+'/'+caseA+'/'+randomUUID()+'/removed.pdf';
  await db.query("insert into public.member_case_files(case_id,user_id,object_name,filename,mime_type,size_bytes,uploaded_by,confirmed_at,removal_requested_at) values($1,$2,$3,'pending.pdf','application/pdf',128,$2,null,null),($1,$2,$4,'removed.pdf','application/pdf',128,$2,now(),now())",[caseA,people.memberA.id,pendingObject,removedObject]);
  const submittedNoCase=randomUUID();
  await db.query("insert into public.member_forms(id,user_id,template_key,status,answers,step,submitted_at) values($1,$2,'alliance_grievance','submitted','{}'::jsonb,1,now())",[submittedNoCase,people.memberA.id]);
  await db.query("insert into public.member_case_updates(case_id,user_id,body) values($1,$2,'Private identifying note scopenoteproof')",[caseA,people.memberA.id]);
  const waitingA=randomUUID(),waitingB=randomUUID(),privateWaiting=randomUUID();
  await db.query("insert into public.member_cases(id,user_id,reference,title,case_type) values($1::uuid,$3,$1::text,'Waiting in A','other'),($2::uuid,$4,$2::text,'Waiting in B','other'),($5::uuid,$3,$5::text,'Private waiting case','other')",[waitingA,waitingB,people.memberA.id,people.memberB.id,privateWaiting]);
  await db.query('insert into private.case_identity_privacy(case_id) values($1)',[privateWaiting]);
  await as('scoped');
  assert.equal(await one('select count(*)::integer v from public.member_forms where id=$1',[submittedNoCase]),0);passed++;
  assert.equal(await one("select count(*)::integer v from public.list_steward_forms() where id=$1",[submittedNoCase]),0);passed++;
  await refused('select public.steward_start_review($1) v',[submittedNoCase],'22023');
  assert.equal(await one('select count(*)::integer v from public.member_cases where id=$1',[caseA]),0);passed++;
  assert.equal(await one('select count(*)::integer v from public.member_case_updates where case_id=$1',[caseA]),0);passed++;
  assert.equal(await one("select private.can_read_member_case_object('case-files',$1) v",[caseObject]),false);passed++;
  assert.equal(await one("select count(*)::integer v from public.search_member_cases('identity',50) where case_id=$1",[caseA]),0);passed++;
  assert.deepEqual(await one('select public.list_contract_clause_grievance_counts() v'),[]);passed++;
  assert.deepEqual(await one('select public.list_unassigned_chapter_cases() v'),[]);passed++;
  assert.deepEqual(await one("select public.list_case_member_candidates('Fictional member') v"),[]);passed++;
  await refused("select public.open_member_case($1,'Committee cannot open this case','Other','',null,'Description',(now() at time zone 'America/New_York')::date,'Correct schedule','informal',true) v",[people.memberA.id]);
  await refused('select public.claim_member_case($1) v',[waitingA]);
  await as('admin');
  // Explicitly choosing Unit A restores only A.
  await one("select public.set_member_access_role($1,$2,'steward',true,$3,null) v",[people.scoped.id,chapter,unitA]);
  await as('scoped');
  assert.equal(await one('select count(*)::integer v from public.member_forms where id=$1',[submittedNoCase]),1);passed++;
  assert.equal(await one('select count(*)::integer v from public.member_case_files where object_name in ($1,$2)',[pendingObject,removedObject]),0);passed++;
  assert.equal(await one('select count(*)::integer v from public.member_cases where id=$1',[caseA]),1);passed++;
  assert.equal(await one('select count(*)::integer v from public.member_cases where id=$1',[caseB]),0);passed++;
  assert.deepEqual(await one('select public.list_contract_clause_grievance_counts() v'),[{article:'scoped article',count:1}]);passed++;
  assert.equal(await one('select count(*)::integer v from public.member_case_updates where case_id=$1',[caseA]),1);passed++;
  assert.equal(await one('select count(*)::integer v from public.member_case_files where case_id=$1',[caseA]),1);passed++;
  assert.equal(await one("select private.can_read_member_case_object('case-files',$1) v",[caseObject]),true);passed++;
  assert.equal(await one("select count(*)::integer v from public.search_member_cases('scopenoteproof',50) where case_id=$1",[caseA]),1);passed++;
  const waiting=await one('select public.list_unassigned_chapter_cases() v');
  assert.equal(waiting.some(row=>row.id===waitingA),true);passed++;
  assert.equal(waiting.some(row=>row.id===waitingB||row.id===privateWaiting),false);passed++;
  assert.deepEqual((await one("select public.list_case_member_candidates('Fictional member') v")).map(row=>row.userId),[people.memberA.id]);passed++;
  await refused('select public.claim_member_case($1) v',[waitingB]);
  await refused('select public.claim_member_case($1) v',[privateWaiting]);
  assert.equal((await one('select public.claim_member_case($1) v',[waitingA])).assigned,true);passed++;
  const opened=await one("select public.open_member_case($1,'Scoped steward intake','Other','',null,'Description',(now() at time zone 'America/New_York')::date,'Correct schedule','informal',true) v",[people.memberA.id]);
  assert.equal(opened.assigned,true);passed++;
  assert.equal(await one('select count(*)::integer v from public.member_cases where id=$1 and user_id=$2 and steward_user_id=$3',[opened.caseId,people.memberA.id,people.scoped.id]),1);passed++;
  await refused("select public.open_member_case($1,'Outside scope intake','Other','',null,'Description',(now() at time zone 'America/New_York')::date,'Correct schedule','informal',true) v",[people.memberB.id]);
  assert.equal(await one('select private.casework_staff_can_read($1) v',[caseA]),true);passed++;
  assert.equal(await one('select private.casework_staff_can_access($1) v',[caseA]),false);passed++;
  await refused("select public.casework_rename_case($1,'A reader cannot rename this case','correct_error') v",[caseA],'P0002');
  // Read-all stewardship does not grant deadline-extension write authority.
  const extensionDeadline = randomUUID();
  await owner();
  await db.query("insert into public.casework_deadlines(id,case_id,organization_id,chapter_id,kind,label,due_at,created_by) values($1,$2,$3,$4,'filing','Scoped extension proof',now()+interval '2 days',$5)",[extensionDeadline,caseA,org,chapter,people.steward.id]);
  await as('scoped');
  await refused("select public.casework_request_deadline_extension($1,now()+interval '4 days','Unassigned read is insufficient',$2) v",[extensionDeadline,randomUUID()],'P0002');
  await owner();
  assert.equal(await one('select count(*)::integer v from public.casework_deadline_extensions where deadline_id=$1',[extensionDeadline]),0);passed++;
  assert.equal(await one("select count(*)::integer v from public.casework_audit_events where case_id=$1 and event_type='deadline_requested'",[caseA]),0);passed++;
  await as('steward');
  const assignedExtension=await one("select to_jsonb(public.casework_request_deadline_extension($1,now()+interval '4 days','Assigned steward can request',$2)) v",[extensionDeadline,randomUUID()]);
  assert.equal(assignedExtension.requested_by,people.steward.id);passed++;
  await as('memberA');
  const ownedExtension=await one("select to_jsonb(public.casework_request_deadline_extension($1,now()+interval '4 days','Case owner can still request',$2)) v",[extensionDeadline,randomUUID()]);
  assert.equal(ownedExtension.requested_by,people.memberA.id);passed++;
  await as('admin'); await one("select public.set_chapter_access_policy($1,false,'chapter') v",[chapter]);
  await as('scoped');
  assert.equal(await one('select count(*)::integer v from public.member_cases where id=$1',[caseA]),0);passed++;
  assert.equal(await one('select count(*)::integer v from public.member_case_updates where case_id=$1',[caseA]),0);passed++;
  assert.equal(await one('select count(*)::integer v from public.member_case_files where case_id=$1',[caseA]),0);passed++;
  assert.equal(await one("select private.can_read_member_case_object('case-files',$1) v",[caseObject]),false);passed++;
  assert.equal(await one("select count(*)::integer v from public.search_member_cases('scopenoteproof',50) where case_id=$1",[caseA]),0);passed++;
  await as('admin'); await one("select public.set_chapter_access_policy($1,true,'chapter') v",[chapter]);
  await as('admin');
  await one("select public.set_member_access_role($1,$2,'coordinator',true,$3,null) v",[people.scoped.id,chapter,unitA]);
  await owner();
  await db.query('savepoint missing_staff_factor');
  await db.query('delete from auth.mfa_factors where user_id=$1',[people.scoped.id]);
  await as('scoped','aal1');
  assert.equal(await one('select private.casework_staff_can_access($1) v',[caseA]),false);passed++;
  assert.equal(await one('select count(*)::integer v from public.member_cases where id=$1',[caseA]),0);passed++;
  await owner();await db.query('rollback to savepoint missing_staff_factor');await db.query('release savepoint missing_staff_factor');
  await as('scoped');
  const scopedKpis=await one('select public.get_coordinator_kpis() v');
  const scopedVisible=await one("select count(*)::integer v from public.member_cases where status='active'");
  assert.ok(scopedVisible>0);assert.equal(scopedKpis.openCases,scopedVisible);passed++;
  assert.equal(await one('select count(*)::integer v from public.member_cases where id in ($1,$2)',[caseB,privateWaiting]),0);passed++;
  await owner();
  // A member's new placement never carries an old tenant's case into the
  // scoped coordinator's reach, even when the member is now in their unit.
  const retainedForeign=randomUUID();
  await db.query("insert into public.member_cases(id,user_id,reference,title,case_type) values($1::uuid,$2,$1::text,'Old tenant case','other')",[retainedForeign,people.foreign.id]);
  await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')",[org,people.foreign.id]);
  await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",[people.foreign.id,chapter]);
  await db.query('update public.member_profiles set chapter_id=$2 where id=$1',[people.foreign.id,chapter]);
  await as('admin');await one('select public.set_chapter_access_member($1,$2,$3,null,true) v',[chapter,people.foreign.id,unitA]);
  await as('scoped');
  assert.equal(await one("select public.staff_can_see_user($1,'coordinator') v",[people.foreign.id]),true);passed++;
  assert.equal(await one('select private.casework_staff_can_read($1) v',[retainedForeign]),false);passed++;
  assert.equal(await one('select count(*)::integer v from public.member_cases where id=$1',[retainedForeign]),0);passed++;
  assert.equal((await one('select public.get_coordinator_kpis() v')).openCases,scopedKpis.openCases);passed++;
  await as('admin');await one('select public.set_chapter_access_member($1,$2,$3,null,false) v',[chapter,people.foreign.id,unitA]);
  await owner();await db.query('update public.member_profiles set chapter_id=$2 where id=$1',[people.foreign.id,foreign]);
  await db.query('delete from public.member_chapter_memberships where user_id=$1 and chapter_id=$2',[people.foreign.id,chapter]);
  await db.query('delete from public.organization_memberships where user_id=$1 and organization_id=$2',[people.foreign.id,org]);
  assert.equal(await one('select private.automation_v2_case_visible($1,$2,$3) v',[people.scoped.id,org,caseA]),true);passed++;
  assert.equal(await one('select private.automation_v2_case_visible($1,$2,$3) v',[people.scoped.id,org,caseB]),false);passed++;
  await as('admin'); await one("select public.set_member_access_role($1,$2,'coordinator',false) v",[people.scoped.id,chapter]);
  await as('scoped');await refused('select public.get_coordinator_kpis() v');
  await owner();await db.query("update public.member_cases set deadline=(now() at time zone 'America/New_York')::date-1 where id=$1",[waitingB]);
  await as('president');
  const presidentOverview=await one('select public.get_vp_overview() v');
  assert.equal(presidentOverview.activeGrievances,6);passed++;
  assert.equal(presidentOverview.attention.some(entry=>entry.id===waitingB),true);passed++;
  await owner();await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'steward')",[org,people.steward.id]);
  await as('steward');
  const analytics=await one('select public.get_organization_analytics_workspace() v');
  const memberAnalytics=analytics.members.find(row=>row.id===people.memberB.id+':'+chapter);
  assert.equal(memberAnalytics.activeCases,2);passed++;
  assert.equal(memberAnalytics.overdueCases,1);passed++;
  assert.equal(memberAnalytics.attention,'urgent');passed++;
  await as('steward');
  await one('select public.set_grievance_identity_private($1,true) v',[caseA]);
  await as('scoped');
  assert.equal(await one('select count(*)::integer v from public.member_cases where id=$1',[caseA]),0);passed++;
  assert.deepEqual(await one('select public.list_contract_clause_grievance_counts() v'),[]);passed++;
  const summaries=await one('select public.list_private_grievance_summaries() v');
  assert.deepEqual(summaries.find(item=>item.id===caseA),{id:caseA,status:'active'});passed++;
  assert.equal(await one('select count(*)::integer v from public.member_case_updates where case_id=$1',[caseA]),0);passed++;
  assert.equal(await one("select private.can_read_member_case_object('case-files',$1) v",[caseObject]),false);passed++;
  await as('memberA');
  assert.equal(await one('select count(*)::integer v from public.member_cases where id=$1',[caseA]),1);passed++;
  assert.equal(await one("select private.can_read_member_case_object('case-files',$1) v",[caseObject]),true);passed++;
  await as('admin'); await one("select public.set_member_access_role($1,$2,'coordinator',true) v",[people.scoped.id,chapter]);
  await as('scoped'); assert.equal(await one('select count(*)::integer v from public.member_cases where id=$1',[caseB]),1);passed++;
  await as('admin'); await one("select public.set_member_access_role($1,$2,'coordinator',false) v",[people.scoped.id,chapter]);
  await as('scoped'); assert.equal(await one('select count(*)::integer v from public.member_cases where id=$1',[caseA]),0);passed++;
  await owner();
  const form=randomUUID();
  await db.query("insert into public.member_forms(id,user_id,template_key,status,answers,step) values($1,$2,'alliance_grievance','draft','{}'::jsonb,1)",[form,people.memberA.id]);
  const formFile=randomUUID(),formObject=people.memberA.id+'/'+form+'/'+formFile+'/form.pdf';
  await db.query("insert into public.member_form_files(id,form_id,object_name,filename,mime_type,size_bytes,uploaded_by,confirmed_at) values($1,$2,$3,'form.pdf','application/pdf',128,$4,now())",[formFile,form,formObject,people.memberA.id]);
  await as('scoped');
  assert.equal(await one('select count(*)::integer v from public.member_forms where id=$1',[form]),0);passed++;
  await as('memberA');
  await one('select public.set_member_draft_steward_share($1,$2,true) v',[form,people.scoped.id]);
  await as('scoped');
  assert.equal(await one('select count(*)::integer v from public.member_forms where id=$1',[form]),1);passed++;
  assert.equal(await one('select count(*)::integer v from public.member_form_files where id=$1',[formFile]),1);passed++;
  assert.equal(await one("select private.can_read_member_form_object('member-form-files',$1) v",[formObject]),true);passed++;
  assert.equal((await one('select public.list_shared_member_drafts() v')).some(item=>item.id===form),true);passed++;
  await as('secretary');
  assert.equal(await one('select count(*)::integer v from public.member_forms where id=$1',[form]),0);passed++;
  assert.equal(await one('select count(*)::integer v from public.member_form_files where id=$1',[formFile]),0);passed++;
  assert.equal(await one("select private.can_read_member_form_object('member-form-files',$1) v",[formObject]),false);passed++;
  await owner(); const filedForm=randomUUID();
  await db.query("insert into public.member_forms(id,user_id,template_key,status,answers,step,case_id,submitted_at) values($1,$2,'alliance_grievance','submitted','{}'::jsonb,1,$3,now())",[filedForm,people.memberA.id,caseA]);
  await as('scoped'); assert.equal(await one('select count(*)::integer v from public.member_forms where id=$1',[filedForm]),0);passed++;
  assert.equal(await one('select public.form_owner_in_steward_scope($1) v',[filedForm]),false);passed++;
  await refused('select public.steward_start_review($1) v',[filedForm],'22023');
  await as('steward'); assert.equal(await one('select count(*)::integer v from public.member_forms where id=$1',[filedForm]),1);passed++;
  await one('select public.steward_start_review($1) v',[filedForm]);
  await as('memberA'); assert.equal(await one('select count(*)::integer v from public.member_forms where id=$1',[filedForm]),1);passed++;
  await refused('select public.set_member_draft_steward_share($1,$2,true) v',[form,people.secretary.id]);
  await as('memberA');
  await one('select public.set_member_draft_steward_share($1,$2,false) v',[form,people.scoped.id]);
  await as('scoped');
  assert.equal(await one('select count(*)::integer v from public.member_forms where id=$1',[form]),0);passed++;
  // A same-organization secondary chapter is a valid target. A profile whose
  // active context is another organization must never leak through the roster.
  await owner(); const sibling='g1-sibling-'+org;
  await db.query('insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$2,9942)',[sibling,org]);
  await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",[people.memberA.id,sibling]);
  await db.query('update public.member_profiles set chapter_id=$2 where id=$1',[people.memberA.id,sibling]);
  await as('scoped'); assert.equal(await one("select public.staff_can_see_user($1,'steward') v",[people.memberA.id]),true);passed++;
  await owner();
  await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')",[foreignOrg,people.memberA.id]);
  await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",[people.memberA.id,foreign]);
  await db.query('update public.member_profiles set chapter_id=$2 where id=$1',[people.memberA.id,foreign]);
  await as('scoped'); assert.equal(await one("select public.staff_can_see_user($1,'steward') v",[people.memberA.id]),false);passed++;
  await owner(); await db.query('update public.member_profiles set chapter_id=$2 where id=$1',[people.memberA.id,chapter]);
  // Committee expiry is still a refusal for
  // a supported committee coordinator. A unit steward is governed by its unit.
  // Roll back the independent role so no later refusal gains another authority.
  await owner(); await db.query('savepoint committee_expiry_control');
  await as('admin');
  await one("select public.set_member_access_role($1,$2,'coordinator',true,null,$3) v",[people.scoped.id,chapter,committee.id]);
  await as('scoped'); assert.equal(await one("select public.staff_can_see_user($1,'coordinator') v",[people.memberA.id]),true);passed++;
  await as('admin'); await one("select public.save_chapter_committee($1,$2,'Safety','Workplace safety',(now() at time zone 'America/New_York')::date-2,(now() at time zone 'America/New_York')::date-1,true) v",[committee.id,chapter]);
  await as('scoped'); assert.equal(await one("select public.staff_can_see_user($1,'coordinator') v",[people.memberA.id]),false);passed++;
  await as('admin'); await one("select public.save_chapter_committee($1,$2,'Safety','Workplace safety',(now() at time zone 'America/New_York')::date-2,null,true) v",[committee.id,chapter]);
  await as('scoped'); assert.equal(await one("select public.staff_can_see_user($1,'coordinator') v",[people.memberA.id]),true);passed++;
  await owner(); await db.query('rollback to savepoint committee_expiry_control');
  await db.query('release savepoint committee_expiry_control');
  await as('admin');
  await one("select public.set_member_access_role($1,$2,'steward',true,$3,null) v",[people.scoped.id,chapter,unitA]);
  await as('scoped');
  await refused('select public.set_chapter_access_member($1,$2,$3,null,true) v',[chapter,people.memberB.id,unitA]);
  await refused("select public.set_member_access_role($1,$2,'secretary',true) v",[people.memberB.id,chapter]);
  await as('admin'); await refused("select public.set_member_access_role($1,$2,'steward',true,$3,null) v",[people.foreign.id,foreign,unitA]);
  await as('scoped','aal1'); assert.equal(await one('select count(*)::integer v from public.member_cases where id=$1',[caseB]),0);passed++;
  await refused('select public.get_chapter_access_workspace($1) v',[chapter]);
  // No invitation access-carrying role is granted by a President or without
  // an actual second factor; accepting is a separate service-only lifecycle.
  await as('president'); await refused("select public.create_member_invitation('role@example.invalid','Fictional Role',$1,'secretary','en',$2) v",[chapter,'bb'.repeat(32)]);
  await as('admin','aal1'); await refused("select public.create_member_invitation('role@example.invalid','Fictional Role',$1,'admin','en',$2) v",[chapter,'bc'.repeat(32)]);
  await as('admin');
  await one("select public.set_chapter_role_capability($1,'secretary','records',true) v",[chapter]);
  await one("select public.set_member_access_role($1,$2,'secretary',true,$3,null) v",[people.secretary.id,chapter,unitA]);
  await as('secretary');
  assert.equal((await one('select public.get_chapter_office_access() v')).unscopedRecords,false);passed++;
  const secretaryExport=await one('select public.get_member_data_export() v');
  // Ordinary office grants export the new carry-over field as false.
  assert.deepEqual(secretaryExport.additionalDomains.chapter_role_scopes,[{user_id:people.secretary.id,chapter_id:chapter,role:'secretary',unit_id:unitA,committee_id:null,legacy_chapter_coverage:false}]);passed++;
  await refused("select public.save_institutional_record(null,'minutes','Whole chapter','Minutes',now()) v");
  const scopedRecord=await one("select public.save_scoped_institutional_record(null,'minutes','Garage minutes','Minutes',now(),'chapter','publish',false,null,null,'[]'::jsonb,$1,null) v",[unitA]);
  assert.equal(scopedRecord.access_unit_id,unitA);passed++;
  assert.equal((await one('select public.get_institutional_records_workspace() v')).records.find(row=>row.id===scopedRecord.id).versions.length,1);passed++;
  await refused("select public.save_scoped_institutional_record(null,'minutes','Wrong unit','Minutes',now(),'chapter','save',false,null,null,'[]'::jsonb,$1,null) v",[unitB]);
  await owner();
  const meeting='g1-meeting-'+randomUUID();
  await db.query("insert into public.member_events(id,title,starts_at,location,summary,check_in_code,order_index,chapter_id) values($1,'Fictional meeting',now()+interval '2 hours','Hall','Meeting','SG-G1UNIT',(select coalesce(max(order_index),0)+1 from public.member_events),$2)",[meeting,chapter]);
  await db.query("insert into public.organization_setting_values(organization_id,setting_key,value) values($1,'features.automation.minutes_pre_event_notice','true'::jsonb)",[org]);
  await as('admin');
  const otherMinutes=await one("select public.save_scoped_institutional_record(null,'minutes','Other unit minutes','Minutes',now(),'chapter','publish',false,null,null,'[]'::jsonb,$1,null) v",[unitB]);
  await one('select public.attach_minutes_to_meeting($1,$2) v',[otherMinutes.id,meeting]);
  await one("select public.save_minutes_pre_event_notice($1,$2,'all_members',3) v",[otherMinutes.id,meeting]);
  await as('secretary');
  assert.equal((await one('select public.get_minutes_pre_event_notices() v')).notices.some(notice=>notice.recordId===otherMinutes.id),false);passed++;
  assert.equal((await one('select public.clear_minutes_pre_event_notice($1) v',[otherMinutes.id])).removed,false);passed++;
  await refused('select public.attach_minutes_to_meeting($1,$2) v',[otherMinutes.id,meeting],'22023');
  await refused("select public.save_minutes_pre_event_notice($1,$2,'all_members',3) v",[otherMinutes.id,meeting],'P0002');
  // Minutes approval and meeting check-ins follow the record's unit too: the
  // unit-A secretary cannot approve or read check-ins for unit B's minutes.
  await refused('select public.set_chapter_minutes_approval($1,$2,true) v',[otherMinutes.id,otherMinutes.version],'P0002');
  await refused('select public.get_minutes_meeting_checkins($1) v',[otherMinutes.id],'P0002');
  const ownApproval=await one('select public.set_chapter_minutes_approval($1,$2,true) v',[scopedRecord.id,scopedRecord.version]);
  assert.equal(ownApproval.approvedVersion,scopedRecord.version);passed++;
  assert.deepEqual((await one('select public.get_minutes_meeting_checkins($1) v',[scopedRecord.id])).checkedIn,[]);passed++;
  await one('select public.attach_minutes_to_meeting($1,$2) v',[scopedRecord.id,meeting]);
  // The meeting is the chapter's, so unit B's member may have checked in too;
  // unit A's minutes list only the check-ins of unit A's members.
  await owner();
  await db.query('insert into public.member_event_checkins(event_id,user_id) values($1,$2),($1,$3)',[meeting,people.memberA.id,people.memberB.id]);
  await as('secretary');
  assert.deepEqual((await one('select public.get_minutes_meeting_checkins($1) v',[scopedRecord.id])).checkedIn,[people.memberA.id]);passed++;
  await one("select public.save_minutes_pre_event_notice($1,$2,'all_members',3) v",[scopedRecord.id,meeting]);
  await as('scoped');
  const scopedEvent=(await one('select public.get_admin_events() v')).find(event=>event.id===meeting);
  assert.deepEqual(scopedEvent.minutes,[{id:scopedRecord.id,title:'Garage minutes'}]);passed++;
  await as('admin');
  const oversightEvent=(await one('select public.get_admin_events() v')).find(event=>event.id===meeting);
  assert.deepEqual(oversightEvent.minutes.map(record=>record.id).sort(),[scopedRecord.id,otherMinutes.id].sort());passed++;
  const draftMinutes=await one("select public.save_scoped_institutional_record(null,'minutes','Private draft minutes','Draft',now(),'chapter','save',false,null,null,'[]'::jsonb,$1,null) v",[unitB]);
  const staffMinutes=await one("select public.save_scoped_institutional_record(null,'minutes','Staff-only minutes','Staff',now(),'staff','publish',false,null,null,'[]'::jsonb,$1,null) v",[unitB]);
  for (const record of [draftMinutes,staffMinutes]) await one('select public.attach_minutes_to_meeting($1,$2) v',[record.id,meeting]);
  await one('select public.set_chapter_access_member($1,$2,$3,null,true) v',[chapter,people.scoped.id,unitB]);
  await as('scoped');
  const memberOnlyEvent=(await one('select public.get_admin_events() v')).find(event=>event.id===meeting);
  assert.deepEqual(memberOnlyEvent.minutes.map(record=>record.id).sort(),[scopedRecord.id,otherMinutes.id].sort());passed++;
  await as('admin');
  const allMinutes=(await one('select public.get_admin_events() v')).find(event=>event.id===meeting).minutes;
  assert.deepEqual(allMinutes.map(record=>record.id).sort(),[scopedRecord.id,otherMinutes.id,draftMinutes.id,staffMinutes.id].sort());passed++;
  await one('select public.set_chapter_access_member($1,$2,$3,null,false) v',[chapter,people.scoped.id,unitB]);
  await as('memberA');await refused('select public.get_admin_events() v');
  await owner();
  await one('select private.dispatch_minutes_pre_event_notices(50) v');
  for(const [recordTitle,allowed,denied] of [['Garage minutes',people.memberA.id,people.memberB.id],['Other unit minutes',people.memberB.id,people.memberA.id]]){
    assert.equal(await one("select count(*)::integer v from public.member_notifications where title='Meeting materials are ready' and body like '%'||$1||'%' and user_id=$2",[recordTitle,allowed]),1);passed++;
    assert.equal(await one("select count(*)::integer v from public.member_notifications where title='Meeting materials are ready' and body like '%'||$1||'%' and user_id=$2",[recordTitle,denied]),0);passed++;
  }
  await as('secretary');
  await refused("select public.save_scoped_institutional_record(null,'member_contact','Contact','Sensitive',now(),'chapter','save',false,null,null,'[]'::jsonb,$1,null) v",[unitA]);
  const docA=await one("select public.create_chapter_office_document($1,'Garage document','Text','Summary',$2,null,true) v",[chapter,unitA]);
  assert.equal(docA.access_unit_id,unitA);passed++;
  await refused("select public.create_chapter_office_document($1,'Other unit','Text','Summary',$2,null,true) v",[chapter,unitB]);
  await refused("select public.create_chapter_office_document($1,'Whole chapter','Text','Summary') v",[chapter]);
  await refused("select public.publish_chapter_office_notice($1,'Notice','Text') v",[chapter]);
  const scopedNotice=await one("select public.publish_chapter_office_notice($1,'Garage notice','Garage meeting','en',$2,null) v",[chapter,unitA]);
  assert.equal((await one('select public.get_member_notice_receipts($1) v',[scopedNotice.broadcastId])).audienceCount,1);passed++;
  await refused("select public.publish_chapter_office_notice($1,'Wrong unit','Text','en',$2,null) v",[chapter,unitB]);
  await as('memberA'); assert.equal(await one('select count(*)::integer v from public.chapter_records where id=$1',[scopedRecord.id]),1);passed++;
  assert.equal(await one('select count(*)::integer v from public.chapter_documents where id=$1',[docA.id]),1);passed++;
  assert.equal(await one('select count(*)::integer v from public.member_broadcasts where id=$1',[scopedNotice.broadcastId]),1);passed++;
  await as('memberB'); assert.equal(await one('select count(*)::integer v from public.chapter_records where id=$1',[scopedRecord.id]),0);passed++;
  assert.equal(await one('select count(*)::integer v from public.chapter_documents where id=$1',[docA.id]),0);passed++;
  assert.equal(await one('select count(*)::integer v from public.member_broadcasts where id=$1',[scopedNotice.broadcastId]),0);passed++;
  assert.equal(await one('select count(*)::integer v from private.visible_member_broadcast_ids() id where id=$1',[scopedNotice.broadcastId]),0);passed++;
  // Restricted PIN sessions keep member publication reads, without invoking
  // the full-session office metadata endpoint or acquiring authoring access.
  await owner();await db.query('savepoint pin_records_read');
  await db.query('insert into private.member_pin_sessions(session_id,user_id) values($1,$2)',[people.memberA.session,people.memberA.id]);
  await as('memberA');
  assert.equal(await one('select private.member_pin_session_restricted() v'),true);passed++;
  const pinRecords=await one('select public.get_institutional_records_workspace() v');
  assert.equal(pinRecords.records.some(record=>record.id===scopedRecord.id),true);passed++;
  assert.equal(pinRecords.canManage,false);passed++;
  assert.deepEqual(pinRecords.recordScopes,[]);passed++;
  assert.deepEqual(pinRecords.contacts,[]);passed++;
  assert.deepEqual(pinRecords.roster,[]);passed++;
  await refused('select public.get_chapter_office_access() v');
  await refused("select public.save_institutional_record(null,'minutes','PIN write','Denied',now()) v");
  await owner();await db.query('rollback to savepoint pin_records_read');await db.query('release savepoint pin_records_read');
  await owner(); assert.equal(await one("select count(*)::integer v from public.engagement_delivery_outbox where source_id=$1 and recipient_user_id=$2",[scopedNotice.broadcastId,people.memberB.id]),0);passed++;
  assert.equal(await one("select private.engagement_delivery_recipient_eligible($1,$2,'broadcast',$3) v",[org,people.memberA.id,scopedNotice.broadcastId]),true);passed++;
  assert.equal(await one("select private.engagement_delivery_recipient_eligible($1,$2,'broadcast',$3) v",[org,people.memberB.id,scopedNotice.broadcastId]),false);passed++;
  await as('admin');
  await one("select public.set_member_access_role($1,$2,'secretary',true) v",[people.secretary.id,chapter]);
  await as('secretary');
  const notice=await one("select public.publish_chapter_office_notice($1,'Chapter notice','Meeting is scheduled.','en') v",[chapter]);
  assert.ok(notice.broadcastId);passed++;
  assert.equal((await one('select public.list_my_member_notices() v')).notices.length,2);passed++;
  await refused("select public.publish_member_broadcast('Local notice','Text','en','organization') v");
  // Removing one capability does not add any private member privileges.
  await as('admin'); await one("select public.set_chapter_role_capability($1,'secretary','notices',false) v",[chapter]);
  await as('secretary'); await refused('select public.get_member_notice_receipts($1) v',[notice.broadcastId]);
  await refused("select public.publish_chapter_office_notice($1,'Notice','Text') v",[chapter]);
  assert.equal(await one('select count(*)::integer v from public.member_cases where id=$1',[caseA]),0);passed++;
  // Explicit draft shares lose authority when the live recipient role goes.
  await as('memberA'); await one('select public.set_member_draft_steward_share($1,$2,true) v',[form,people.scoped.id]);
  await as('scoped'); assert.equal(await one('select count(*)::integer v from public.member_forms where id=$1',[form]),1);passed++;
  await as('admin'); await one("select public.set_member_access_role($1,$2,'steward',false) v",[people.scoped.id,chapter]);
  await as('scoped'); assert.equal(await one('select count(*)::integer v from public.member_forms where id=$1',[form]),0);passed++;
  assert.equal(await one("select public.staff_can_see_user($1,'steward') v",[people.memberA.id]),false);passed++;
  // Exercise the real invitation claim/finalize/activation boundary. Creating
  // or resending a link grants nothing; only the exact accepting identity can
  // receive the chapter office and the durable invitation unit.
  for(const [index,role] of ['admin','secretary','records'].entries()){
    await as('admin'); const email=randomUUID()+'@example.invalid';
    const hash=(index+12).toString(16).padStart(2,'0').repeat(32);
    const invitation=await one("select public.create_member_invitation($1,'Fictional Invitee',$2,$3,'en',$4) v",[email,chapter,role,hash]);
    await one('select public.set_member_invitation_unit($1,$2) v',[invitation.invitationId,unitA]);
    const replacement=await one('select public.resend_member_invitation($1,$2) v',[invitation.invitationId,(index+22).toString(16).padStart(2,'0').repeat(32)]);
    const inviteId=replacement.invitationId;
    await owner(); await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:'service_role'})]);
    await one('select public.claim_member_invitation($1) v',[(index+22).toString(16).padStart(2,'0').repeat(32)]);
    const id=randomUUID();
    await db.query("insert into auth.users(id,email,banned_until,raw_user_meta_data,raw_app_meta_data) values($1,$2,now()+interval '1 day',$3::jsonb,'{\"union_ground_provisioning\":\"pending\"}'::jsonb)",[id,email,JSON.stringify({chapter_id:chapter,union_base_invitation_id:inviteId,full_name:'Fictional Invitee'})]);
    assert.equal(await one('select count(*)::integer v from public.member_role_chapters where user_id=$1',[id]),0);passed++;
    await one('select public.finalize_member_invitation($1,$2) v',[inviteId,id]);
    await db.query("update auth.users set banned_until=null,raw_app_meta_data='{\"union_ground_provisioning\":\"active\"}'::jsonb where id=$1",[id]);
    await one('select public.complete_member_invitation_activation($1,$2) v',[inviteId,id]);
    assert.equal(await one('select count(*)::integer v from public.member_role_chapters where user_id=$1 and chapter_id=$2 and role=$3',[id,chapter,role]),1);passed++;
    assert.equal(await one('select count(*)::integer v from public.organization_role_grants where user_id=$1',[id]),0);passed++;
    assert.equal(await one('select count(*)::integer v from private.chapter_unit_members where user_id=$1 and unit_id=$2',[id,unitA]),1);passed++;
  }
  await as('memberA'); const memberExport=await one('select public.get_member_data_export() v');
  assert.deepEqual(memberExport.additionalDomains.chapter_unit_members,[{user_id:people.memberA.id,chapter_id:chapter,unit_id:unitA}]);passed++;
  assert.deepEqual(memberExport.additionalDomains.chapter_committee_members,[{user_id:people.memberA.id,chapter_id:chapter,committee_id:committee.id}]);passed++;
  await owner();
  await db.query("insert into private.member_pin_credentials(user_id,pin_hash) values($1,'$2a$12$'||repeat('A',53))",[people.memberA.id]);
  await db.query('insert into private.member_pin_sessions(session_id,user_id) values($1,$2)',[people.memberA.session,people.memberA.id]);
  await as('admin'); await one("select public.set_member_access_role($1,$2,'records',true) v",[people.memberA.id,chapter]);
  await owner();
  assert.equal(await one('select count(*)::integer v from private.member_pin_credentials where user_id=$1',[people.memberA.id]),0);passed++;
  assert.equal(await one('select count(*)::integer v from auth.sessions where id=$1',[people.memberA.session]),0);passed++;
  await owner();
  assert.deepEqual((await db.query('select * from private.account_lifecycle_referential_action_trigger_issues()')).rows,[]);passed++;
  return passed;
}
