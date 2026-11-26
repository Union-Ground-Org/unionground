import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";
import { verifyConnectedAutomationClient } from "./lib/connected-automation-client-proof.mjs";
import { createAutomationApi } from "../src/lib/mi1AutomationWiring.js";

const { Client } = pg;
// The automation windows count the Eastern day (private.eastern_day(),
// 20261117121800), and the disposable and hosted databases run in UTC, so from
// 7 PM Eastern (8 PM in daylight time) to midnight the session's current_date
// is already tomorrow. Fixture dates are built on the Eastern day, the same
// expression as the helper's body (the proof's roles cannot call private.*).
const EASTERN_DAY = "(pg_catalog.now() at time zone 'America/New_York')::date";
const databaseUrl = assertDisposableProofUrl(requireDatabaseUrl("SUPABASE_DB_URL", { aliases: ["DATABASE_URL"] }));

const ids = {
  admin: "50900000-0000-4000-8000-000000000108",
  outsider: "50900000-0000-4000-8000-000000000109",
  recipient: "50900000-0000-4000-8000-000000000119",
  foreignOrg: "50900000-0000-4000-8000-000000000110",
  bootstrapKey: "50900000-0000-4000-8000-000000000111",
  sourceA: "50900000-0000-4000-8000-000000000112",
  sourceB: "50900000-0000-4000-8000-000000000113",
  sourceC: "50900000-0000-4000-8000-000000000114",
  foreignDefinition: "50900000-0000-4000-8000-000000000115",
};

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function asRole(client, role, userId = null, aal = "aal2") {
  await client.query("reset role");
  const claims = userId ? { sub: userId, role, aal, session_id: userId } : { role };
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
  await client.query(`set local role ${role}`);
}

async function expectSqlstate(client, label, sql, values, state) {
  const savepoint = `sp_${label.replace(/[^a-z0-9]/gi, "_")}`;
  await client.query(`savepoint ${savepoint}`);
  try {
    await client.query(sql, values);
    throw new Error(`${label}: expected SQLSTATE ${state}`);
  } catch (error) {
    assert(error.code === state, `${label}: expected SQLSTATE ${state}, got ${error.code || error.message}`);
  } finally {
    await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
  }
}

const client = new Client({
  connectionString: databaseUrl,
  application_name: "connected-automation-v2-proof",
});

try {
  await client.connect();
  const launchState = (await client.query(`
    select
      (select count(*)::int from public.organizations) as organizations,
      (select count(*)::int from public.organization_automation_definitions) as definitions,
      (select count(*)::int from auth.users) as users
  `)).rows[0];
  assert(launchState.organizations === 0, "local reset must preserve the zero-organization launch state");
  assert(launchState.definitions === 0, "local reset must not seed automation definitions");
  assert(launchState.users === 0, "local reset must not seed real or fictional Auth identities");

  await client.query("begin");
  await client.query(`
    insert into auth.users (id, email) values
      ($1, 'cr108-admin@example.invalid'),
      ($2, 'cr108-outsider@example.invalid')
  `, [ids.admin, ids.outsider]);

  await asRole(client, "service_role");
  const bootstrap = (await client.query(`
    select public.bootstrap_first_organization(
      'CR-108 local proof', 'cr108-local-proof', $1,
      'cr108', 'CR-108 local chapter', 'cr108', $2
    ) as value
  `, [ids.admin, ids.bootstrapKey])).rows[0].value;
  const organizationId = bootstrap.organizationId;
  assert(organizationId && bootstrap.chapterId === "cr108", "service bootstrap must create the explicit local proof tenant");

  await client.query("reset role");
  await client.query("insert into auth.users(id,email) values($1,'automation-recipient@example.invalid')",[ids.recipient]);
  await client.query("insert into public.organization_memberships(organization_id,user_id) values($1,$2)",[organizationId,ids.recipient]);
  await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,'cr108','active')",[ids.recipient]);
  await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$3)",[organizationId,ids.recipient,ids.admin]);
  await client.query("update public.member_profiles set chapter_id='cr108',notification_prefs='{}'::jsonb where id=$1",[ids.recipient]);
  await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values(extensions.gen_random_uuid(),$1,'totp','verified',now(),now())",[ids.recipient]);
  // The current MFA boundary requires a live session, not an AAL claim alone.
  await client.query(`
    insert into auth.sessions (id, user_id, aal, created_at)
    values ($1, $1, 'aal2', now()), ($2, $2, 'aal2', now())
  `, [ids.admin, ids.outsider]);
  await client.query(`
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
    values ($1, $1, 'totp', now(), now()), ($2, $2, 'totp', now(), now())
  `, [ids.admin, ids.outsider]);
  await client.query(`
    insert into auth.mfa_factors
      (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    values
      (extensions.gen_random_uuid(), $1, 'cr108-proof', 'totp', 'verified', now(), now()),
      (extensions.gen_random_uuid(), $2, 'cr108-proof', 'totp', 'verified', now(), now())
  `, [ids.admin, ids.outsider]);
  await client.query(`
    insert into public.chapter_workstreams (chapter_id, name, created_by)
    values ('cr108', 'General', $1)
  `, [ids.admin]);

  await client.query(`
    insert into public.organizations (id, slug, name, status, created_by)
    values ($1, 'cr108-foreign', 'CR-108 foreign proof', 'active', $2)
  `, [ids.foreignOrg, ids.outsider]);
  await client.query(`
    insert into public.org_security_policy (id, organization_id, require_staff_mfa, updated_by)
    values (true, $1, true, $2)
  `, [ids.foreignOrg, ids.outsider]);
  await client.query(`
    insert into public.chapters (id, name, is_default, order_index, organization_id, slug)
    values ('cr108-foreign', 'CR-108 foreign chapter', true, 1, $1, 'cr108-foreign')
  `, [ids.foreignOrg]);
  await client.query(`
    insert into public.organization_memberships (organization_id, user_id)
    values ($1, $2)
  `, [ids.foreignOrg, ids.outsider]);
  await client.query(`
    insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
    values ($1, $2, 'admin', $2)
  `, [ids.foreignOrg, ids.outsider]);
  await client.query(`
    insert into public.member_chapter_memberships (user_id, chapter_id, status, last_selected_at)
    values ($1, 'cr108-foreign', 'active', now())
  `, [ids.outsider]);
  await client.query("update public.member_profiles set chapter_id = 'cr108-foreign' where id = $1", [ids.outsider]);
  await client.query(`
    insert into public.organization_automation_definitions (
      id, organization_id, name, trigger_kind, threshold_days, cadence,
      task_priority, status, version, created_by, updated_by
    ) values ($1, $2, 'Foreign automation', 'overdue_task', 0, 'daily',
      'medium', 'active', 1, $3, $3)
  `, [ids.foreignDefinition, ids.foreignOrg, ids.outsider]);


  const checks = [];
  const query = async (sql, values=[]) => (await client.query(sql, values)).rows[0]?.value;
  const rpc = async (name, values=[]) => query(`select public.${name}(${values.map((_,i)=>"$"+(i+1)).join(",")}) as value`, values);
  // Task edits go through the field-edit RPC like every client since
  // 20261103183000; days moves the due date from the Eastern day (or from
  // another day expression, such as the session's current_date).
  const editTask = async (id, fields={}, days, day=EASTERN_DAY) => query(`select public.update_chapter_task_fields($1::uuid,
    $2::jsonb || case when $3::integer is null then '{}'::jsonb else pg_catalog.jsonb_build_object('due_date', ${day} + $3::integer) end) as value`,
    [id, JSON.stringify(fields), days ?? null]);
  const loadClientControl=async (userId)=>{
    const api=createAutomationApi({rpc:async (name)=>{
      assert(["get_organization_automation_control_room","mi1_get_automation_workspace"].includes(name),"control-room client proof is read-only");
      return {data:await rpc(name),error:null};
    }});
    const loaded=await api.load({authenticated:true,mfaSatisfied:true,role:"admin",userId,
      selectedOrganizationId:organizationId,selectedHat:"admin",organizationRoles:["admin"],
      membershipStatus:"active",organizationStatus:"active"});
    assert(loaded.state==="ready","real client-retained control-room data normalizes");
    return loaded.control;
  };
  let sequence = 0;
  const spec = (triggerKind, extra={}) => ({
    schemaVersion:2,name:`Connected proof ${++sequence}`,triggerKind,thresholdDays:
      ["unassigned_case","blocked_task","unassigned_task","incomplete_case_checklist"].includes(triggerKind)?0:7,
    taskPriority:"medium",cadence:"daily",conditions:{},actionKind:"create_standard_task",actionConfig:{},...extra
  });
  const save = (value) => rpc("mi1_save_automation_definition_v2",[value]);
  // V3 governance binds activation to an exact-version approval. The admin
  // fixture submits and self-reviews explicitly so the engine proofs below keep
  // exercising the same activation path a real approver uses.
  const activate = async (d) => {
    await rpc("mi1_submit_automation_definition",[d.id,d.version]);
    await rpc("mi1_review_automation_definition",[d.id,d.version,"approve",null]);
    return rpc("set_organization_automation_definition_status",[d.id,"active",d.version]);
  };
  const execute = async (d) => {
    await activate(d);
    const p=await rpc("preview_organization_automation_run",[d.id]);
    const result=await rpc("execute_organization_automation_run",[p.id,p.confirmationPhrase]);
    return {preview:p,result};
  };
  await asRole(client,"authenticated",ids.admin);
  await client.query("reset role"); // Fixture IDs are not a client-writable task column.
  await client.query(`insert into public.chapter_tasks(id,title,status,priority,due_date,blocked) values
    ($1,'Overdue source','to_do','low',${EASTERN_DAY}-10,false),
    ($2,'Upcoming source','to_do','low',${EASTERN_DAY}+2,true),
    ($3,'Review source','needs_review','low',${EASTERN_DAY}+1,false)`,[ids.sourceA,ids.sourceB,ids.sourceC]);
  await client.query("reset role");
  const caseId = "50900000-0000-4000-8000-000000000130";
  const deadlineId = "50900000-0000-4000-8000-000000000131";
  const checklistId = "50900000-0000-4000-8000-000000000132";
  await client.query(`insert into public.member_cases(id,user_id,reference,title,case_type,deadline,chapter_id,organization_id)
    values($1,$2,'V2-PROOF','Private source content','grievance',${EASTERN_DAY}+2,'cr108',$3)`,[caseId,ids.admin,organizationId]);
  await client.query(`insert into public.casework_deadlines(id,case_id,organization_id,chapter_id,kind,label,due_at,created_by)
    values($1,$2,$3,'cr108','filing','Do not copy private label',now()+interval '2 days',$4)`,[deadlineId,caseId,organizationId,ids.admin]);
  await client.query(`insert into public.casework_checklists(id,case_id,organization_id,chapter_id,step,title,created_by)
    values($1,$2,$3,'cr108','Intake','Do not copy checklist',$4)`,[checklistId,caseId,organizationId,ids.admin]);
  await client.query(`insert into public.casework_checklist_items(checklist_id,organization_id,label,position,required)
    values($1,$2,'Private checklist label',0,true)`,[checklistId,organizationId]);
  await client.query(`insert into public.member_appointments(user_id,steward_id,chapter_id,appointment_type,duration_minutes,starts_at,ends_at,status,routed_via)
    values($1,$1,'cr108','office_hours',30,now()+interval '2 days',now()+interval '2 days 30 minutes','confirmed','steward'),
    ($1,$1,'cr108','office_hours',30,now()-interval '2 days',now()-interval '2 days'+interval '30 minutes','completed','steward')`,[ids.admin]);
  await client.query(`insert into public.member_events(id,chapter_id,title,starts_at,location,summary,check_in_code,order_index)
    values('v2-upcoming','cr108','Private event',now()+interval '2 days','Private location','Private summary','SG-V2UP',0),
    ('v2-followup','cr108','Private event',now()-interval '2 days','Private location','Private summary','SG-V2PAST',1)`);
  await asRole(client,"authenticated",ids.admin);
  const room=await rpc("get_organization_automation_control_room");
  await client.query("savepoint control_room_other_operator");
  const privateCaseDefinition=await save(spec("casework_deadline",{conditions:{sourceId:caseId}}));
  const ownerControl=await loadClientControl(ids.admin);
  assert(ownerControl.definitions.some(row=>row.id===privateCaseDefinition.id&&row.conditions.sourceId===caseId),"source owner retains an authorized control-room reference");
  await client.query("reset role");
  await client.query("update public.member_cases set is_restricted=true,restricted_by=$2,restricted_at=now(),restriction_reason='Local control-room proof' where id=$1",[caseId,ids.admin]);
  await client.query("insert into auth.sessions(id,user_id,aal,created_at) values($1,$1,'aal2',now())",[ids.recipient]);
  await asRole(client,"authenticated",ids.recipient);
  assert((await client.query("select count(*)::int n from public.member_cases where id=$1",[caseId])).rows[0].n===0,"second operator cannot read the source owner's restricted case");
  await expectSqlstate(client,"other_operator_restricted_context","select public.mi1_get_automation_source_context('case',$1)",[caseId],"42501");
  const otherOperatorControl=await loadClientControl(ids.recipient);
  assert(otherOperatorControl.definitions.some(row=>row.id===privateCaseDefinition.id),"second operator still sees the redacted definition rather than a missing page row");
  assert(!JSON.stringify(otherOperatorControl).includes(caseId)&&otherOperatorControl.definitions.find(row=>row.id===privateCaseDefinition.id).sourceFilterAvailable===false,"client-retained control room redacts another operator's inaccessible case");
  assert(!JSON.stringify(await rpc("get_organization_automation_control_room")).includes(caseId),"raw control room redacts another operator's inaccessible case");
  await client.query("rollback to savepoint control_room_other_operator");
  await client.query("release savepoint control_room_other_operator");
  await asRole(client,"authenticated",ids.admin);
  checks.push("control-room wire and shipped client preserve another operator's restricted-case privacy");
  await client.query("savepoint canonical_source_visibility");
  await client.query("reset role");
  await client.query("update public.member_cases set user_id=$1,is_restricted=true,restricted_by=$3,restricted_at=now(),restriction_reason='Local proof' where id=$2",[ids.recipient,caseId,ids.admin]);
  await asRole(client,"authenticated",ids.admin);
  assert((await client.query("select count(*)::int n from public.member_cases where id=$1",[caseId])).rows[0].n===0,"admin without coordinator grant cannot read another restricted member case");
  await expectSqlstate(client,"restricted_case_context","select public.mi1_get_automation_source_context('case',$1)",[caseId],"42501");
  await expectSqlstate(client,"restricted_case_child","select public.mi1_save_automation_definition_v2($1)",[spec("casework_deadline",{conditions:{sourceId:caseId}})],"42501");
  await client.query("reset role");
  await client.query("update public.member_appointments set user_id=$1,steward_id=$1",[ids.recipient]);
  const otherAppointment=(await client.query("select id from public.member_appointments limit 1")).rows[0].id;
  await client.query("update public.organization_role_grants set role='vp' where user_id=$1 and organization_id=$2 and role='admin'",[ids.admin,organizationId]);
  await asRole(client,"authenticated",ids.admin);
  await expectSqlstate(client,"vp_no_appointment_supervision","select public.list_chapter_appointments()",[],"42501");
  await expectSqlstate(client,"vp_no_appointment_context","select public.mi1_get_automation_source_context('appointment',$1)",[otherAppointment],"42501");
  await client.query("rollback to savepoint canonical_source_visibility");
  await client.query("release savepoint canonical_source_visibility");
  checks.push("canonical case RLS and selected-chapter appointment supervisor permission boundaries");
  assert(room.capabilities.schemaVersion===2 && room.capabilities.triggers.length===14,"server advertises exact v2 contract");
  assert(!room.settings.enabled,"migration never enables master");
  const bads=[
    {...spec("overdue_task"),name:1234},
    {...spec("overdue_task"),actionKind:"raise_task_priority",actionConfig:{priority:null}},
    {...spec("unassigned_task"),conditions:{assignment:"assigned"}},
    {...spec("event_upcoming"),conditions:{priority:"high"}},
    {...spec("unknown")},
    {...spec("overdue_task"),conditions:{expression:"true"}},
    {...spec("overdue_task"),conditions:{boardId:"fictional"}},
    {...spec("casework_deadline"),conditions:{deadlineKind:"invented"}},
    {...spec("event_upcoming"),conditions:{status:"completed"}},
    {...spec("review_task"),conditions:{status:"to_do"}},
    {...spec("unassigned_task"),thresholdDays:1},
    {...spec("event_upcoming"),actionKind:"raise_task_priority",actionConfig:{priority:"high"}},
    {...spec("overdue_task"),actionKind:"raise_task_priority",actionConfig:{priority:"low"}},
  ];
  for(const [i,b] of bads.entries()) await expectSqlstate(client,"bad_contract_"+i,"select public.mi1_save_automation_definition_v2($1)",[b],"22023");
  await expectSqlstate(client,"foreign_chapter","select public.mi1_save_automation_definition_v2($1)",[spec("overdue_task",{conditions:{chapterId:"cr108-foreign"}})],"42501");
  await expectSqlstate(client,"foreign_recipient","select public.mi1_save_automation_definition_v2($1)",[spec("overdue_task",{actionKind:"notify_in_app",actionConfig:{recipientId:ids.outsider}})],"42501");
  await expectSqlstate(client,"unknown_source","select public.mi1_get_automation_source_context('task',$1)",[ids.foreignDefinition],"42501");
  await asRole(client,"authenticated",ids.admin,"aal1");
  await expectSqlstate(client,"v2_mfa","select public.mi1_get_automation_definitions()",[],"42501");
  await asRole(client,"anon");
  await expectSqlstate(client,"v2_anon","select public.mi1_get_automation_definitions()",[],"42501");
  await asRole(client,"authenticated",ids.admin);
  checks.push("unknown capabilities, typed conditions, MFA, anon, cross-tenant references");
  const all = ["overdue_task","case_deadline","unassigned_case","task_due","blocked_task","unassigned_task","stale_task","review_task","casework_deadline","incomplete_case_checklist","appointment_upcoming","appointment_followup","event_upcoming","event_followup"];
  const runsByTrigger = new Map();
  await rpc("set_organization_automation_enabled",[true,"ENABLE AUTOMATION"]);
  for(const trigger of all){
    const d=await save(spec(trigger,["stale_task","review_task"].includes(trigger)?{thresholdDays:0}:{}));
    const {preview,result}=await execute(d);
    runsByTrigger.set(trigger,result.id);
    assert(preview.candidatesCount>0,`${trigger}: genuine source predicate must select fixture`);
    assert(result.effectsCreated>0 && result.effectsFailed===0,`${trigger}: action must actually execute: ${JSON.stringify(result)}`);
    const detail=await rpc("mi1_get_automation_run",[result.id,1,1]);
    assert(detail.effects.rows.length===1 && detail.effects.total===result.effectsCreated,`${trigger}: bounded detail`);
    assert(detail.effects.rows[0].sourceAvailable && detail.effects.rows[0].effectAvailable,`${trigger}: authorized source and outcome`);
    assert(!JSON.stringify(detail).includes("Private source content") && !JSON.stringify(detail).includes("Do not copy"),"no sensitive copied content");
    const p=await rpc("preview_organization_automation_run",[d.id]);
    assert(p.candidatesCount===0,`${trigger}: successful effects deduplicate`);
  }
  checks.push("14 distinct trigger queries execute, generic outputs, bounded details, repeat deduplication");
  for (const trigger of ["casework_deadline","incomplete_case_checklist"]) {
    const scopedCase=await save(spec(trigger,{conditions:{sourceId:caseId,chapterId:"cr108"}}));
    const scopedRun=await execute(scopedCase);
    assert(scopedRun.result.effectsCreated===1,"parent case context selects the actual deadline/checklist child");
    const detail=await rpc("mi1_get_automation_run",[scopedRun.result.id]);
    assert(detail.effects.rows[0].caseId===caseId && detail.effects.rows[0].sourceId!==caseId,"trace keeps distinct child and parent references");
  }
  checks.push("parent-case context remains scoped through deadline and checklist adapters");
  const priorityFiltered=await save(spec("task_due",{conditions:{priority:"low",assignment:"unassigned"}}));
  assert((await rpc("preview_organization_automation_run",[priorityFiltered.id])).candidatesCount===2,"priority and assignment-presence predicates match real task state");
  const nullDate=await save(spec("task_due",{conditions:{sourceId:ids.sourceB}}));
  await editTask(ids.sourceB,{due_date:null});
  assert((await rpc("preview_organization_automation_run",[nullDate.id])).candidatesCount===0,"null task due date is excluded");
  await editTask(ids.sourceB,{},7);
  assert((await rpc("preview_organization_automation_run",[nullDate.id])).candidatesCount===1,"exact Eastern date boundary is included");
  await editTask(ids.sourceB,{},8);
  assert((await rpc("preview_organization_automation_run",[nullDate.id])).candidatesCount===0,"outside task date boundary is excluded");
  // Both sides of the session-day/Eastern-day split: a session zone whose day
  // runs ahead of Eastern (UTC+14, from 5 AM Eastern, 6 AM in daylight time)
  // and one whose day runs behind it (UTC-12, until 7 AM Eastern, 8 AM in
  // daylight time), so at every hour at least one of them is split. The window
  // follows the Eastern day in both, and a due date built from the session's
  // own day lands where the Eastern day says.
  const splits=[];
  for (const zone of ["Etc/GMT-14","Etc/GMT+12"]) {
    await client.query(`set local timezone to '${zone}'`);
    const sessionOffset=Number(await query(`select (current_date - ${EASTERN_DAY}) as value`));
    splits.push(`${zone} ${sessionOffset>0?"+":""}${sessionOffset}`);
    for (const [day,days,label] of [[EASTERN_DAY,0,"Eastern today"],[EASTERN_DAY,7,"Eastern day + 7"],[EASTERN_DAY,8,"Eastern day + 8"],[EASTERN_DAY,-1,"Eastern yesterday"],["current_date",0,"session today"],["current_date",7,"session day + 7"]]) {
      await editTask(ids.sourceB,{},days,day);
      const eastern=days+(day==="current_date"?sessionOffset:0);
      const counted=(await rpc("preview_organization_automation_run",[nullDate.id])).candidatesCount;
      assert(counted===(eastern>=0&&eastern<=7?1:0),`${zone}: ${label} (Eastern day ${eastern>=0?"+":""}${eastern}) follows the Eastern window, counted ${counted}`);
    }
  }
  await client.query("set local timezone to default");
  checks.push(`task window follows the Eastern day in sessions on both sides of the split (session minus Eastern day: ${splits.join(", ")})`);
  await editTask(ids.sourceB,{status:"done"},2);
  assert((await rpc("preview_organization_automation_run",[nullDate.id])).candidatesCount===0,"terminal task is excluded");
  await editTask(ids.sourceB,{status:"to_do",progress:0});
  const appointmentDef=await save(spec("appointment_upcoming"));
  await client.query("reset role");
  await client.query("update public.member_appointments set status='cancelled' where status='confirmed'");
  await asRole(client,"authenticated",ids.admin);
  assert((await rpc("preview_organization_automation_run",[appointmentDef.id])).candidatesCount===0,"cancelled appointment is excluded");
  await client.query("reset role");
  await client.query("update public.member_appointments set status='confirmed',starts_at=now()+interval '8 days',ends_at=now()+interval '8 days 30 minutes' where status='cancelled'");
  await asRole(client,"authenticated",ids.admin);
  assert((await rpc("preview_organization_automation_run",[appointmentDef.id])).candidatesCount===0,"rescheduled appointment outside window is excluded");
  await client.query("reset role");
  await client.query("update public.member_appointments set starts_at=now()+interval '7 days',ends_at=now()+interval '7 days 30 minutes' where status='confirmed'");
  await asRole(client,"authenticated",ids.admin);
  assert((await rpc("preview_organization_automation_run",[appointmentDef.id])).candidatesCount===1,"exact appointment window boundary is included");
  const utcCount=(await rpc("preview_organization_automation_run",[appointmentDef.id])).candidatesCount;
  await client.query("set local timezone='America/New_York'");
  assert((await rpc("preview_organization_automation_run",[appointmentDef.id])).candidatesCount===utcCount,"UTC-duration window is independent of session DST zone");
  await client.query("set local timezone='UTC'");
  const dst=(await client.query("select ('2026-11-01 01:30:00-04'::timestamptz + 24*interval '1 hour') = '2026-11-02 00:30:00-05'::timestamptz valid")).rows[0];
  assert(dst.valid,"lookback/lookahead duration is 24 hours across fallback, not local calendar-day arithmetic");
  checks.push("task null/boundary/terminal filters, typed priority and assignment, appointment cancellation/reschedule and DST-duration semantics");
  // Controlled transactional fault: a real task trigger fails exactly one
  // source. This proves subtransaction rollback and retry of only that source.
  await client.query("reset role");
  await client.query(`create function pg_temp.connected_proof_failure() returns trigger language plpgsql security definer set search_path='' as $$ begin
    if exists(select 1 from public.organization_automation_effects e where e.planned_task_id=new.id and e.source_id='50900000-0000-4000-8000-000000000113' and e.status='pending') then
      raise exception 'controlled local action failure' using errcode='23514'; end if; return new; end; $$`);
  await client.query("create trigger zzzz_connected_proof_failure before insert on public.chapter_tasks for each row execute function pg_temp.connected_proof_failure()");
  await asRole(client,"authenticated",ids.admin);
  const retryDef=await save(spec("task_due"));
  const partial=await execute(retryDef);
  assert(partial.result.status==="partial" && partial.result.effectsFailed===1 && partial.result.effectsCreated===1,"one action fails without rolling back successful effect");
  const partialDetail=await rpc("mi1_get_automation_run",[partial.result.id]);
  assert(partialDetail.effects.rows.some(e=>e.status==="failed" && e.reasonCode==="action_failed"),"failed source retains a generic retry receipt");
  await client.query("reset role");
  await client.query("drop trigger zzzz_connected_proof_failure on public.chapter_tasks");
  await asRole(client,"authenticated",ids.admin);
  const retryPreview=await rpc("preview_organization_automation_run",[retryDef.id]);
  assert(retryPreview.candidatesCount===1,"retry selects only failed eligible source");
  const retried=await rpc("execute_organization_automation_run",[retryPreview.id,retryPreview.confirmationPhrase]);
  assert(retried.effectsCreated===1 && retried.effectsFailed===0 && retried.deduplicatedCount===1,"retry preserves prior successful effect");
  checks.push("partial failure receipt and eligible-only retry without replay");
  const competing = new Client({connectionString:databaseUrl,application_name:"connected-automation-competing-lease-proof"});
  try {
    await competing.connect();
    const lease=(await competing.query("select pg_try_advisory_xact_lock(hashtextextended('organization-automation:' || $1::text,0)) acquired",[organizationId])).rows[0];
    assert(lease.acquired===false,"a concurrent connection cannot enter the product-held tenant execution lease");
  } finally { await competing.end(); }
  checks.push("real second connection denied the product-held conflicting execution lease");
  const priorityDef=await save(spec("blocked_task",{conditions:{sourceId:ids.sourceB},actionKind:"raise_task_priority",actionConfig:{priority:"high"}}));
  await client.query("reset role");
  await client.query("update private.notification_controls set outbound_enabled=true where id");
  await asRole(client,"postgres",ids.recipient);
  await client.query("insert into public.chapter_task_watchers(task_id,user_id) values($1,$3),($2,$3)",[ids.sourceB,ids.sourceC,ids.recipient]);
  await asRole(client,"authenticated",ids.admin);
  const priorityRun=await execute(priorityDef);
  assert(priorityRun.result.effectsCreated===1 && priorityRun.result.effectsFailed===0,"raise priority actual outcome");
  const rb=await rpc("rollback_organization_automation_run",[priorityRun.result.id,"ROLL BACK "+priorityRun.result.id.slice(0,8).toUpperCase()]);
  assert(rb.effectsRolledBack===1,"priority rollback restores previous value");
  const assignDef=await save(spec("unassigned_task",{conditions:{sourceId:ids.sourceC},actionKind:"assign_task",actionConfig:{assigneeId:ids.recipient}}));
  const assignRun=await execute(assignDef);
  assert(assignRun.result.effectsCreated===1 && assignRun.result.effectsFailed===0,"assignment actual outcome");
  const undoAssignDef=await save(spec("unassigned_task",{conditions:{sourceId:ids.sourceA},actionKind:"assign_task",actionConfig:{assigneeId:ids.recipient}}));
  const undoAssignRun=await execute(undoAssignDef);
  const assignmentUndo=await rpc("rollback_organization_automation_run",[undoAssignRun.result.id,"ROLL BACK "+undoAssignRun.result.id.slice(0,8).toUpperCase()]);
  assert(assignmentUndo.effectsRolledBack===1,"untouched assignment is reversibly restored");
  const createdRunId=runsByTrigger.get("event_followup");
  const createdUndo=await rpc("rollback_organization_automation_run",[createdRunId,"ROLL BACK "+createdRunId.slice(0,8).toUpperCase()]);
  assert(createdUndo.effectsRolledBack===1,"untouched v2 generated task uses conservative create-task undo");
  await client.query("reset role");
  assert((await client.query("select count(*)::int n from public.member_notifications where user_id=$1 and kind='tasks'",[ids.recipient])).rows[0].n>0,"automation preserves ordinary in-app assignment notifications");
  assert((await client.query("select count(*)::int n from public.member_notification_deliveries")).rows[0].n===0,"opted-in task assignee and watcher actions plus undo never enqueue externally");
  const staleReceipt=(await client.query("select id from public.organization_automation_effects where run_id=$1 and status='created'",[assignRun.result.id])).rows[0].id;
  await asRole(client,"authenticated",ids.admin);
  await client.query("select set_config('app.automation_task_receipt',$1,true)",[staleReceipt]);
  await editTask(ids.sourceC,{title:"Human retained edit"});
  await editTask(ids.sourceB,{status:"in_progress"});
  await client.query("select set_config('app.automation_task_receipt','',true)");
  const conflict=await rpc("rollback_organization_automation_run",[assignRun.result.id,"ROLL BACK "+assignRun.result.id.slice(0,8).toUpperCase()]);
  assert(conflict.rollbackSkipped===1 && conflict.effectsRolledBack===0,"human changes prevent rollback");
  const notifyDef=await save(spec("event_upcoming",{conditions:{sourceId:"v2-upcoming"},actionKind:"notify_in_app",actionConfig:{recipientId:ids.admin}}));
  const notifyRun=await execute(notifyDef);
  assert(notifyRun.result.effectsCreated===1 && notifyRun.result.effectsFailed===0,"in-app notification actual outcome");
  const notifyRollback=await rpc("rollback_organization_automation_run",[notifyRun.result.id,"ROLL BACK "+notifyRun.result.id.slice(0,8).toUpperCase()]);
  assert(notifyRollback.effectsRolledBack===0 && notifyRollback.rollbackSkipped===1,"notification is never falsely recalled");
  checks.push("assign, raise priority, in-app notify, conflict-safe undo and irreversible receipt");
  await client.query("reset role");
  const humanDeliveries=(await client.query("select count(*)::int n from public.member_notification_deliveries")).rows[0].n;
  assert(humanDeliveries>0,"ordinary human task edit still enqueues opted-in watcher notification despite caller-spoofed completed receipt GUC");
  await client.query("update private.notification_controls set outbound_enabled=false where id");
  await asRole(client,"authenticated",ids.admin);
  const revokedDef=await save(spec("event_upcoming",{actionKind:"notify_in_app",actionConfig:{recipientId:ids.recipient}}));
  await activate(revokedDef);
  const revokedPreview=await rpc("preview_organization_automation_run",[revokedDef.id]);
  await client.query("reset role");
  await client.query("update public.organization_memberships set status='revoked',revoked_at=now() where organization_id=$1 and user_id=$2",[organizationId,ids.recipient]);
  await asRole(client,"authenticated",ids.admin);
  const revokedRun=await rpc("execute_organization_automation_run",[revokedPreview.id,revokedPreview.confirmationPhrase]);
  const revokedDetail=await rpc("mi1_get_automation_run",[revokedRun.id]);
  assert(revokedRun.effectsFailed===1 && revokedDetail.effects.rows[0].reasonCode==='permission_lost',"revoked recipient has distinct generic permission-loss receipt");
  checks.push("opted-in task transport suppression, preserved human notifications, and recipient permission-loss receipt");
  const page=await rpc("mi1_get_automation_definitions",[1,2,"Connected",null]);
  assert(page.rows.length===2 && page.total>2,"server definition pagination");
  const scopes=await rpc("mi1_get_automation_scope_options",["task","cr108","",1,2]);
  assert(scopes.chapters.rows.some(x=>x.id==="cr108") && scopes.assignees.rows.some(x=>x.id===ids.admin),"real authorized scope options");
  const context=await rpc("mi1_get_automation_source_context",["event","v2-upcoming"]);
  assert(context.chapterId==="cr108","source context resolves canonical chapter");
  const staleSpec=spec("event_upcoming",{conditions:{sourceId:"v2-upcoming"}});
  const staleDef=await save(staleSpec);
  const activeStale=await activate(staleDef);
  const stalePreview=await rpc("preview_organization_automation_run",[staleDef.id]);
  await save({...staleSpec,id:staleDef.id,expectedVersion:activeStale.version,name:"Changed after preview"});
  await expectSqlstate(client,"stale_version","select public.execute_organization_automation_run($1,$2)",[stalePreview.id,stalePreview.confirmationPhrase],"PT409");
  const cancelDef=await save(spec("event_upcoming",{conditions:{sourceId:"v2-upcoming"}}));
  await activate(cancelDef);
  const cancelPreview=await rpc("preview_organization_automation_run",[cancelDef.id]);
  await client.query("reset role");
  await client.query("update public.member_events set starts_at=now()+interval '60 days' where id='v2-upcoming'");
  await asRole(client,"authenticated",ids.admin);
  const moved=await rpc("execute_organization_automation_run",[cancelPreview.id,cancelPreview.confirmationPhrase]);
  assert(moved.effectsCreated===0 && moved.status==='no_op',"execution rechecks event reschedule outside threshold");
  await client.query("reset role");
  await client.query("update public.member_events set starts_at=now()+interval '2 days' where id='v2-upcoming'");
  await asRole(client,"authenticated",ids.admin);
  const cancellationPreview=await rpc("preview_organization_automation_run",[cancelDef.id]);
  await client.query("reset role");
  await client.query("update public.member_events set cancelled_at=now() where id='v2-upcoming'");
  await asRole(client,"authenticated",ids.admin);
  const cancelled=await rpc("execute_organization_automation_run",[cancellationPreview.id,cancellationPreview.confirmationPhrase]);
  assert(cancelled.effectsCreated===0 && cancelled.status==="no_op","execution rechecks event cancellation");
  checks.push("stale preview versions and changed source eligibility fail safely");
  const scopedRedactionDef=await save(spec("overdue_task",{conditions:{sourceId:ids.sourceA}}));
  const scopedRedactionRun=await execute(scopedRedactionDef);
  for (const [table,key,value] of [["organization_automation_definitions","id",scopedRedactionDef.id],["organization_automation_runs","id",scopedRedactionRun.result.id],["organization_automation_effects","run_id",scopedRedactionRun.result.id]]) {
    assert((await client.query(`select count(*)::int n from public.${table} where ${key}=$1`,[value])).rows[0].n===1,"authorized raw reference remains readable before deletion");
  }
  const visibleControl=await loadClientControl(ids.admin);
  assert(visibleControl.definitions.some(row=>row.id===scopedRedactionDef.id&&row.conditions.sourceId===ids.sourceA),"client control room includes the authorized source before deletion");
  await rpc("soft_delete_chapter_task",[ids.sourceA]);
  const redacted=await rpc("mi1_get_automation_run",[runsByTrigger.get("overdue_task")]);
  assert(redacted.effects.rows[0].sourceAvailable===false && redacted.effects.rows[0].sourceId===null && redacted.effects.rows[0].effectAvailable===true,
    "deleted source is redacted independently from still-authorized generated outcome");
  await expectSqlstate(client,"deleted_context","select public.mi1_get_automation_source_context('task',$1)",[ids.sourceA],"42501");
  const scopedRedaction=await rpc("mi1_get_automation_run",[scopedRedactionRun.result.id]);
  assert(!JSON.stringify(scopedRedaction).includes(ids.sourceA),"run definition snapshot does not leak a now-unavailable source filter");
  checks.push("deleted source redaction with independent outcome authorization");
  const hiddenDefinition=await rpc("mi1_get_automation_definition",[scopedRedactionDef.id]);
  const hiddenList=await rpc("mi1_get_automation_definitions",[1,50,scopedRedactionDef.name,null]);
  assert(hiddenDefinition.definition.sourceFilterAvailable===false && !JSON.stringify(hiddenDefinition).includes(ids.sourceA),"definition detail redacts unavailable source without broadening saved scope");
  assert(!JSON.stringify(hiddenList).includes(ids.sourceA),"definition list redacts unavailable source");
  const hiddenClientControl=await loadClientControl(ids.admin);
  assert(hiddenClientControl.definitions.some(row=>row.id===scopedRedactionDef.id&&row.sourceFilterAvailable===false)&&!JSON.stringify(hiddenClientControl).includes(ids.sourceA),"client-retained control room redacts the deleted task source");
  const hiddenControlRoom=await rpc("get_organization_automation_control_room");
  const hiddenControlDefinition=hiddenControlRoom.definitions.find(row=>row.id===scopedRedactionDef.id);
  assert(hiddenControlDefinition,"redacted control-room definition remains in the bounded result page");
  assert(hiddenControlDefinition?.sourceFilterAvailable===false && !JSON.stringify(hiddenControlRoom).includes(ids.sourceA),"control room redacts unavailable source without broadening saved scope");
  for (const [table,key,value] of [["organization_automation_definitions","id",scopedRedactionDef.id],["organization_automation_runs","id",scopedRedactionRun.result.id],["organization_automation_effects","run_id",scopedRedactionRun.result.id]]) {
    assert((await client.query(`select count(*)::int n from public.${table} where ${key}=$1`,[value])).rows[0].n===0,"raw table API cannot bypass source redaction");
  }
  checks.push("control room, definition detail/list and raw table API preserve unavailable source privacy");
  const clientProof = await verifyConnectedAutomationClient(client, {
    session: {
      authenticated: true, mfaSatisfied: true, role: "admin", userId: ids.admin,
      selectedOrganizationId: organizationId, selectedHat: "admin", organizationRoles: ["admin"],
      membershipStatus: "active", organizationStatus: "active",
    },
    runIds: [...runsByTrigger.values(), notifyRun.result.id, scopedRedactionRun.result.id],
    sourceReferences: [
      { sourceKind: "task", sourceId: ids.sourceB },
      { sourceKind: "case", sourceId: caseId },
      { sourceKind: "appointment", sourceId: otherAppointment },
      { sourceKind: "event", sourceId: "v2-followup" },
    ],
  });
  checks.push(`shipped client: ${clientProof.recipes} real recipe draft saves, ${clientProof.calls} RPCs, ${clientProof.runs} evaluated run snapshots, ${clientProof.sourceReferences} source contexts`);
  await expectSqlstate(client,"oversized_page","select public.mi1_get_automation_runs(1,51)",[],"22023");
  const paused=await save(spec("task_due"));
  await activate(paused);
  const pausedPreview=await rpc("preview_organization_automation_run",[paused.id]);
  await rpc("set_organization_automation_enabled",[false,"PAUSE AUTOMATION"]);
  await expectSqlstate(client,"paused_execution","select public.execute_organization_automation_run($1,$2)",[pausedPreview.id,pausedPreview.confirmationPhrase],"22023");
  await client.query("reset role");
  assert((await client.query("select count(*)::int n from public.member_notification_deliveries")).rows[0].n===humanDeliveries,"only the deliberate human positive control queued external notification delivery");
  await client.query("rollback");
  const restoredLaunchState = (await client.query(`
    select
      (select count(*)::int from public.organizations) as organizations,
      (select count(*)::int from public.organization_automation_definitions) as definitions,
      (select count(*)::int from auth.users) as users
  `)).rows[0];
  assert(JSON.stringify(restoredLaunchState) === JSON.stringify(launchState),
    "proof rollback must restore the zero-organization launch state");
  console.log(JSON.stringify({status:"passed",checks,fixtureBoundary:"isolated local transaction rolled back"}));
} finally {
  await client.query("rollback").catch(()=>{});
  await client.end();
}
