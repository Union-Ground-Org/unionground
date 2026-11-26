import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export async function runFinanceProof(db) {
  const org=randomUUID(),otherOrg=randomUUID(),chapter="finance-"+org,otherChapter="finance-"+otherOrg;
  let passed=0;
  const people={};
  await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Fictional Harbor'),($2::uuid,$2::text,'Fictional Ridge')",[org,otherOrg]);
  await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$2,9950),($3,$3,$3,$4,9951)",[chapter,org,otherChapter,otherOrg]);
  for(const [name,role,c,o] of [["admin","admin",chapter,org],["orgadmin",null,chapter,org],["president","vp",chapter,org],["treasurer",null,chapter,org],["secretary","secretary",chapter,org],["member",null,chapter,org],["peer",null,chapter,org],["outsider","admin",otherChapter,otherOrg]]) {
    const id=randomUUID(),session=randomUUID();people[name]={id,session};
    await db.query("insert into auth.users(id,email) values($1,$2)",[id,id+"@example.invalid"]);
    await db.query("update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1",[id,c,"Fictional "+name]);
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())",[session,id]);
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())",[randomUUID(),id]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')",[o,id]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",[id,c]);
    if(role) {
      await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)",[id,role,c]);
      await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)",[id,role,c]);
    }
  }
  await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'admin')",[org,people.orgadmin.id]);
  const owner=async()=>{await db.query("reset role");await db.query("select set_config('request.jwt.claims','',true)");};
  const as=async(name,aal="aal2")=>{
    await owner();await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:people[name].id,role:"authenticated",session_id:people[name].session,aal})]);await db.query("set local role authenticated");
  };
  const one=async(sql,args=[])=> (await db.query(sql,args)).rows[0]?.v;
  const eq=(actual,expected)=>{assert.deepEqual(actual,expected);passed++;};
  const denied=async(sql,args=[],code="42501")=>{
    await db.query("savepoint denied");let failure;
    try{await db.query(sql,args);}catch(error){failure=error;}
    await db.query("rollback to savepoint denied");await db.query("release savepoint denied");assert.ok(failure,"negative control was allowed");eq(failure.code,code);
  };
  const workspace=(authoring=true)=>one("select public.get_chapter_finance_workspace($1,$2,0,0,$3) v",[org,chapter,authoring]);
  const save=async({id=null,revision=0,kind="financial_report",title="Quarterly report",body="Chapter financial activity",status="draft",budget=null}={})=>one("select public.save_chapter_financial_document($1,$2,$3,$4,$5,$6,$7,$8,$9) v",[org,chapter,id,revision,kind,title,body,status,budget]);
  const capability=async(name,enabled)=>{await as("admin");await one("select public.set_chapter_role_capability($1,'treasurer',$2,$3) v",[chapter,name,enabled]);};
  const caseId=randomUUID(),formId=randomUUID();
  await db.query("insert into public.member_cases(id,user_id,reference,title,case_type) values($1::uuid,$2,$1::text,'Fictional confidential grievance','other')",[caseId,people.member.id]);
  await db.query("insert into public.member_forms(id,user_id,template_key,answers,status,step) values($1,$2,'alliance_grievance','{}'::jsonb,'draft',1)",[formId,people.member.id]);
  const conversation=randomUUID();
  await db.query("insert into public.member_conversations(id,user_id,title,organization_id) values($1,$2,'Fictional confidential message',$3)",[conversation,people.member.id,org]);
  await db.query("insert into public.member_messages(conversation_id,user_id,sender_kind,sender_name,body) values($1,$2,'member','Fictional member','Private message')",[conversation,people.member.id]);
  await as("member");eq((await workspace()).canRecords,false);
  await denied("select public.set_member_access_role($1,$2,'treasurer',true) v",[people.treasurer.id,chapter]);
  await as("president");
  await denied("select public.set_member_access_role($1,$2,'treasurer',true,$3,null) v",[people.treasurer.id,chapter,randomUUID()],"22023");
  await one("select public.set_member_access_role($1,$2,'treasurer',true) v",[people.treasurer.id,chapter]);
  await as("treasurer");
  const access=await workspace();for(const flag of ["canRecords","canDocuments","canPublish","canRoster"])eq(access[flag],true);
  eq((await one("select public.get_chapter_leadership() v")).people.find(person=>person.id===people.treasurer.id)?.treasurer,true);
  const roster=await one("select public.list_chapter_finance_members($1,$2) v",[org,chapter]);
  eq(roster.some(member=>member.id===people.member.id),true);eq(roster.some(member=>member.id===people.outsider.id),false);
  for(const member of roster)eq(Object.keys(member).sort(),["id","name"]);
  eq(await one("select public.staff_can_see_user($1,'treasurer') v",[people.member.id]),false);
  eq(await one("select count(*)::integer v from public.member_cases where id=$1",[caseId]),0);
  eq(await one("select count(*)::integer v from public.member_forms where id=$1",[formId]),0);
  eq(await one("select count(*)::integer v from public.member_messages where conversation_id=$1",[conversation]),0);
  eq(await one("select count(*)::integer v from public.member_conversations where id=$1",[conversation]),0);
  await denied("select * from public.member_profile_details where user_id=$1",[people.member.id]);
  await denied("select public.get_admin_member_directory() v");
  await denied("select public.get_case_queue_next_actions('steward') v");
  await denied("select public.get_admin_events() v");
  await db.query("reset role");eq(await one("select count(*)::integer v from private.staff_visible_member_ids('treasurer')"),0);
  await as("treasurer");await denied("select * from private.chapter_financial_documents");await denied("select * from private.chapter_financial_requests");
  await denied("select public.create_member_invitation('finance@example.invalid','Fictional Invitee',$1,'treasurer','en',$2) v",[chapter,"71".repeat(32)]);
  await denied("select public.publish_chapter_office_notice($1,'Ordinary notice','Not financial') v",[chapter]);
  eq((await one("select public.get_institutional_records_workspace() v")).canManage,false);
  const draft=await save();eq(draft.status,"draft");
  eq((await workspace(false)).documents,[]);eq((await workspace(false)).canDocuments,false);
  await as("member");eq((await workspace()).documents,[]);
  await as("secretary");eq((await workspace()).documents,[]);eq((await workspace()).canDocuments,false);
  await denied("select public.save_chapter_financial_document($1,$2,null,0,'financial_report','No','No','draft',null) v",[org,chapter]);
  await as("treasurer");
  const published=await save({...draft,status:"published"});eq(published.status,"published");
  await as("member");eq((await workspace()).documents.map(d=>d.id),[draft.id]);
  await owner();await db.query("savepoint finance_pin_reader");
  await db.query("insert into private.member_pin_sessions(session_id,user_id) values($1,$2)",[people.member.session,people.member.id]);
  await as("member");const pinFinance=await workspace(false);eq(pinFinance.documents.map(d=>d.id),[draft.id]);eq(pinFinance.canSubmit,false);eq(pinFinance.requests,[]);
  await denied("select public.submit_chapter_financial_request($1,$2,$3,'expense','No PIN write','Details',10) v",[org,chapter,people.member.id]);
  await owner();await db.query("rollback to savepoint finance_pin_reader");await db.query("release savepoint finance_pin_reader");
  await owner();await db.query("savepoint member_without_factor");
  await db.query("delete from auth.mfa_factors where user_id=$1",[people.member.id]);
  await db.query("update auth.sessions set aal='aal1' where id=$1",[people.member.session]);
  await as("member","aal1");eq((await workspace()).documents.map(d=>d.id),[draft.id]);
  await owner();await db.query("rollback to savepoint member_without_factor");await db.query("release savepoint member_without_factor");
  await as("outsider");await denied("select public.get_chapter_finance_workspace($1,$2) v",[org,chapter]);
  await as("treasurer","aal1");await denied("select public.get_chapter_finance_workspace($1,$2) v",[org,chapter]);
  await as("treasurer");
  const budget=await one("select public.save_chapter_budget($1,$2,null,0,'Operating budget',current_date,current_date+30,'Reviewed plan','[{\"name\":\"Supplies\",\"planned\":100,\"actual\":25}]'::jsonb) v",[org,chapter]);
  eq(budget.title,"Operating budget");eq((await one("select public.get_chapter_budget_access($1,$2) v",[org,chapter])).canRead,true);
  const budgetReport=await save({kind:"budget",title:"Published budget",budget:budget.id,status:"published"});
  eq(budgetReport.budget_snapshot.items[0].actual,25);
  const draftBudget=await save({kind:"budget",title:"Draft budget",budget:budget.id});
  await as("member");await denied("select public.list_chapter_budgets($1,$2) v",[org,chapter]);eq((await workspace()).documents.some(d=>d.id===budgetReport.id),true);
  const request=await one("select public.submit_chapter_financial_request($1,$2,$3,'reimbursement','Supplies','Fictional receipt',12.25) v",[org,chapter,people.member.id]);
  eq(request.status,"pending");
  await as("peer");eq((await workspace()).requests,[]);
  await denied("select public.submit_chapter_financial_request($1,$2,$3,'expense','Wrong member','Details',12) v",[org,chapter,people.member.id]);
  await as("treasurer");eq((await workspace()).requests.map(r=>r.id),[request.id]);
  eq((await workspace()).requests[0].subject_name,"Fictional member");
  await one("select public.submit_chapter_financial_request($1,$2,$3,'expense','Attributed expense','Fictional details',9.25) v",[org,chapter,people.peer.id]);
  const decision=await one("select public.decide_chapter_financial_request($1,$2,$3,$4,'approved','Receipt checked') v",[org,chapter,request.id,request.revision]);
  eq(decision.status,"approved");
  await denied("select public.decide_chapter_financial_request($1,$2,$3,$4,'declined','Second decision') v",[org,chapter,request.id,request.revision],"PT409");
  await as("member");eq((await workspace()).requests[0].decision_note,"Receipt checked");
  const exported=await one("select public.get_member_data_export() v");
  eq(exported.additionalDomains.chapter_financial_requests.map(row=>row.id),[request.id]);
  eq(exported.additionalDomains.chapter_financial_requests[0].subject_id,people.member.id);
  await denied("select public.decide_chapter_financial_request($1,$2,$3,2,'approved','No authority') v",[org,chapter,request.id]);
  for(const cap of ["finance_records","finance_documents","finance_publish","finance_roster"]) {
    await capability(cap,false);await as("treasurer");eq((await workspace())[({finance_records:"canRecords",finance_documents:"canDocuments",finance_publish:"canPublish",finance_roster:"canRoster"})[cap]],false);
    if(cap==="finance_roster")await denied("select public.list_chapter_finance_members($1,$2) v",[org,chapter]);
    if(cap==="finance_records") {
      eq((await workspace()).requests.length,0);await denied("select public.list_chapter_budgets($1,$2) v",[org,chapter]);
      for(const target of [draftBudget,budgetReport]) {
        await denied("select public.save_chapter_financial_document($1,$2,$3,$4,'financial_report','Retyped','Retyped',$5,null) v",[org,chapter,target.id,target.revision,target.status]);
        const retained=(await workspace()).documents.find(document=>document.id===target.id);
        eq(retained.kind,"budget");eq(retained.revision,target.revision);eq(retained.budget_snapshot,target.budget_snapshot);
      }
      // Non-budget documents still honor their separate documents permission.
      const ordinary=await save({title:"Ordinary report remains editable"});eq(ordinary.kind,"financial_report");
    }
    if(cap==="finance_documents") {
      eq((await workspace()).documents.every(d=>d.status==="published"),true);
      await denied("select public.save_chapter_financial_document($1,$2,null,0,'financial_report','No','No','draft',null) v",[org,chapter]);
    }
    if(cap==="finance_publish") await denied("select public.save_chapter_financial_document($1,$2,$3,$4,'financial_report','Changed','Changed','published',null) v",[org,chapter,published.id,published.revision]);
    await capability(cap,true);
  }
  await as("admin");await one("select public.set_member_access_role($1,$2,'vp',true) v",[people.treasurer.id,chapter]);
  for(const [cap,flag] of Object.entries({finance_records:"canRecords",finance_documents:"canDocuments",finance_publish:"canPublish",finance_roster:"canRoster"})) {
    await capability(cap,false);await as("treasurer");eq((await workspace())[flag],false);
    if(cap==="finance_records") {
      eq((await workspace()).requests,[]);
      await denied("select public.submit_chapter_financial_request($1,$2,$3,'expense','No inherited finance power','Details',1) v",[org,chapter,people.peer.id]);
    }
    if(cap==="finance_roster")await denied("select public.list_chapter_finance_members($1,$2) v",[org,chapter]);
    if(cap==="finance_documents")await denied("select public.save_chapter_financial_document($1,$2,null,0,'financial_report','No','No','draft',null) v",[org,chapter]);
    if(cap==="finance_publish")await denied("select public.save_chapter_financial_document($1,$2,null,0,'financial_report','No','No','published',null) v",[org,chapter]);
    await as("admin");eq((await workspace())[flag],true);
    await as("orgadmin");eq((await workspace())[flag],true);
    await capability(cap,true);
  }
  await as("admin");await one("select public.set_member_access_role($1,$2,'vp',false) v",[people.treasurer.id,chapter]);
  await as("admin");eq((await workspace()).canRecords,true);eq((await one("select public.get_chapter_budget_access($1,$2) v",[org,chapter])).canRead,true);
  await as("orgadmin");eq((await workspace()).canRecords,true);eq((await one("select public.get_chapter_budget_access($1,$2) v",[org,chapter])).canRead,true);
  eq((await one("select public.list_chapter_budgets($1,$2) v",[org,chapter])).some(row=>row.id===budget.id),true);
  await as("orgadmin","aal1");await denied("select public.get_chapter_budget_access($1,$2) v",[org,chapter]);
  await as("president");eq((await one("select public.get_chapter_budget_access($1,$2) v",[org,chapter])).canRead,true);
  await as("admin");await one("select public.set_member_access_role($1,$2,'treasurer',false) v",[people.treasurer.id,chapter]);
  await as("treasurer");eq((await workspace()).canRecords,false);eq((await workspace()).requests,[]);eq((await workspace()).documents.every(d=>d.status==="published"),true);
  eq((await one("select public.get_chapter_leadership() v")).people.some(person=>person.id===people.treasurer.id),false);
  await as("admin","aal1");await denied("select public.create_member_invitation('finance@example.invalid','Fictional Invitee',$1,'treasurer','en',$2) v",[chapter,"72".repeat(32)]);
  await as("admin");
  const email=randomUUID()+"@example.invalid",hash="73".repeat(32);
  const invitation=await one("select public.create_member_invitation($1,'Fictional Invitee',$2,'treasurer','es',$3) v",[email,chapter,hash]);
  await owner();await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:"service_role"})]);
  await one("select public.claim_member_invitation($1) v",[hash]);
  const invited=randomUUID();await db.query("insert into auth.users(id,email,banned_until,raw_user_meta_data,raw_app_meta_data) values($1,$2,now()+interval '1 day',$3::jsonb,'{\"union_ground_provisioning\":\"pending\"}'::jsonb)",[invited,email,JSON.stringify({chapter_id:chapter,union_base_invitation_id:invitation.invitationId,full_name:"Fictional Invitee"})]);
  eq(await one("select count(*)::integer v from public.member_role_chapters where user_id=$1",[invited]),0);
  await one("select public.finalize_member_invitation($1,$2) v",[invitation.invitationId,invited]);
  await db.query("update auth.users set banned_until=null,raw_app_meta_data='{\"union_ground_provisioning\":\"active\"}'::jsonb where id=$1",[invited]);
  await one("select public.complete_member_invitation_activation($1,$2) v",[invitation.invitationId,invited]);
  eq(await one("select count(*)::integer v from public.member_role_chapters where user_id=$1 and role='treasurer' and chapter_id=$2",[invited,chapter]),1);
  await owner();eq((await db.query("select * from private.account_lifecycle_referential_action_trigger_issues()")).rows,[]);
  return passed;
}
