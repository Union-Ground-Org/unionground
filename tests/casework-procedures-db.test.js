// @vitest-environment node
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';

const live = Boolean(process.env.SUPABASE_DB_URL);
const ids = Object.fromEntries(['staff','member','foreign','chapterHat','org','orgB','case','caseB','session','memberSession','foreignSession','chapterHatSession','factor','chapterHatFactor'].map(k => [k, randomUUID()]));
const noDeadline = { kind: 'none', count: 0, from: 'step_entry' };
const steps = (rule = noDeadline) => [
  { key: 'intake', label: 'Intake', deadline_rule: noDeadline },
  { key: 'review', label: 'Review', deadline_rule: rule },
  { key: 'finish', label: 'Finish', deadline_rule: noDeadline, terminal: true },
];

describe.skipIf(!live)('organization procedures on disposable PostgreSQL', () => {
  let db;
  const query = async (sql, values = []) => (await db.query(sql, values)).rows;
  async function actor(user = ids.staff, aal = 'aal2') {
    await query('reset role');
    await query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({sub:user, role:'authenticated', aal, session_id:user === ids.member ? ids.memberSession : user === ids.foreign ? ids.foreignSession : user === ids.chapterHat ? ids.chapterHatSession : ids.session})]);
    await query('set local role authenticated');
  }
  async function fails(sql, values, code = '22023') {
    await query('savepoint refusal');
    try { await expect(db.query(sql, values)).rejects.toMatchObject({code}); }
    finally { await query('rollback to savepoint refusal'); }
  }
  async function save(list = steps(), chapter = null, type = null, existing = null) {
    return (await query('select public.casework_save_procedure($1,$2,$3,$4,$5,$6) result',
      [existing?.id || null, chapter, type, 'Organization procedure', JSON.stringify(list), existing?.version ?? null]))[0].result;
  }
  async function advance(from, next, key = randomUUID()) {
    return (await query("select (public.casework_advance_step($1,$2,$3,'Reviewed outcome',$4)).*", [ids.case,from,next,key]))[0];
  }
  beforeAll(async () => {
    db = new pg.Client({connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name:'lane51-procedure-rollback-proof'});
    await db.connect(); await query('begin');
    await query("insert into auth.users(id,email,raw_user_meta_data) values ($1,'procedure-staff@example.invalid','{}'),($2,'procedure-member@example.invalid','{}'),($3,'procedure-foreign@example.invalid','{}'),($4,'procedure-chapter-hat@example.invalid','{}')", [ids.staff,ids.member,ids.foreign,ids.chapterHat]);
    await query("insert into public.organizations(id,slug,name,created_by) values ($1,'lane51-proof','Procedure proof',$3),($2,'lane51-proof-b','Foreign proof',$3)",[ids.org,ids.orgB,ids.staff]);
    await query("insert into public.chapters(id,name,slug,region,is_default,order_index,organization_id) values ('lane51-a','Proof A','lane51-a','proof',false,9901,$1),('lane51-b','Proof B','lane51-b','proof',false,9902,$2)",[ids.org,ids.orgB]);
    await query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$3,'active'),($1,$4,'active'),($2,$5,'active')",[ids.org,ids.orgB,ids.staff,ids.member,ids.foreign]);
    await query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,'lane51-a','active'),($2,'lane51-a','active'),($3,'lane51-b','active')",[ids.staff,ids.member,ids.foreign]);
    await query("update public.member_profiles set chapter_id=case when id=$2 then 'lane51-b' else 'lane51-a' end where id=any($1::uuid[])",[[ids.staff,ids.member,ids.foreign],ids.foreign]);
    await query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'coordinator','lane51-a')",[ids.staff]);
    await query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'coordinator')",[ids.org,ids.staff]);
    await query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'coordinator','lane51-a')",[ids.staff]);
    await query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')",[ids.session,ids.staff]);
    await query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal1'),($3,$4,now(),now(),'aal1')",[ids.memberSession,ids.member,ids.foreignSession,ids.foreign]);
    await query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Procedure proof','totp','verified',now(),now())",[ids.factor,ids.staff]);
    // A chapter-hat coordinator: member_role_chapters and member_roles, a
    // verified second factor, and no organization_role_grants row.
    await query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')",[ids.org,ids.chapterHat]);
    await query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,'lane51-a','active')",[ids.chapterHat]);
    await query("update public.member_profiles set chapter_id='lane51-a' where id=$1",[ids.chapterHat]);
    await query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'coordinator','lane51-a')",[ids.chapterHat]);
    await query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'coordinator','lane51-a')",[ids.chapterHat]);
    await query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')",[ids.chapterHatSession,ids.chapterHat]);
    await query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Chapter hat proof','totp','verified',now(),now())",[ids.chapterHatFactor,ids.chapterHat]);
    await query("insert into public.member_cases(id,user_id,organization_id,chapter_id,reference,title,case_type,step,coordinator_user_id,created_at) values ($1,$2,$3,'lane51-a','PROOF-1','Procedure proof','Grievance','intake',$4,'2026-09-18 14:00+00'),($5,$6,$7,'lane51-b','PROOF-2','Foreign proof','Grievance','intake',null,now())",[ids.case,ids.member,ids.org,ids.staff,ids.caseB,ids.foreign,ids.orgB]);
  },30000);
  afterAll(async()=>{if(db){await db.query('rollback');await db.end();}});
  beforeEach(async()=>{await query('savepoint test_case');await actor();});
  afterEach(async()=>{await query('rollback to savepoint test_case');});

  it('starts empty and resolves all four scope priorities', async()=>{
    expect((await query('select public.casework_get_case_procedure($1) result',[ids.case]))[0].result).toBeNull();
    const general=await save(); const type=await save(steps(),null,'Grievance');
    const chapter=await save(steps(),'lane51-a'); const exact=await save(steps(),'lane51-a','Grievance');
    for(const expected of [exact,chapter,type,general]) {
      expect((await query('select public.casework_get_case_procedure($1) result',[ids.case]))[0].result.id).toBe(expected.id);
      await query('reset role');await query('update public.casework_procedures set active=false where id=$1',[expected.id]);await actor();
    }
    expect((await query('select public.casework_get_case_procedure($1) result',[ids.case]))[0].result).toBeNull();
  });
  it('uses optimistic versions and refuses a disappearing current key without a mapping',async()=>{
    const original=await save();
    await fails('select public.casework_save_procedure($1,null,null,$2,$3,0)',[original.id,'Stale',JSON.stringify(steps())],'PT409');
    const changed=steps(); changed[0]={...changed[0],key:'new_intake'};
    await fails('select public.casework_save_procedure($1,null,null,$2,$3,1)',[original.id,'Renamed',JSON.stringify(changed)]);
    changed[0].migrate_from=['intake']; const updated=await save(changed,null,null,original);
    expect(updated.version).toBe(2);expect(updated.steps[0].key).toBe('new_intake');
    expect((await query('select step from public.member_cases where id=$1',[ids.case]))[0].step).toBe('new_intake');
  });
  it('skips weekends and organization holidays on the Eastern calendar, due at the end of the Eastern day, refusing negatives',async()=>{
    await query('select public.casework_set_holidays($1)',[JSON.stringify([{holiday_date:'2026-09-21',label:'Organization holiday'}])]);
    await query('reset role');
    const result=await query("select private.casework_add_business_days('2026-09-18 14:30+00',1,$1,'America/New_York') next,private.casework_add_business_days('2026-09-18 14:30+00',0,$1,'America/New_York') zero,private.casework_add_business_days('2026-09-18 14:30+00',1,$2,'America/New_York') foreign_day,private.casework_add_business_days('2026-09-18 14:30+00',1,$1,'Asia/Tokyo') tokyo",[ids.org,ids.orgB]);
    expect(result[0].next.toISOString()).toBe('2026-09-23T03:59:59.000Z');expect(result[0].zero.toISOString()).toBe('2026-09-19T03:59:59.000Z');expect(result[0].foreign_day.toISOString()).toBe('2026-09-22T03:59:59.000Z');
    // Counted on the zone the deadline is set in (#9446): 11:30 PM Friday in Tokyo, one business day past the Monday holiday, ends Tuesday night in Tokyo.
    expect(result[0].tokyo.toISOString()).toBe('2026-09-22T14:59:59.000Z');
    await fails("select private.casework_add_business_days(now(),1,$1,null)",[ids.org]);
    await fails("select private.casework_add_business_days(now(),-1,$1,'America/New_York')",[ids.org]);
  });
  // #7198: deadlines count America/New_York dates and fall due at the end of
  // the Eastern day, never at midnight UTC (7 or 8 PM Eastern the day before).
  it('counts incident, filing and step-entry deadlines on Eastern dates, due at the end of the Eastern due day',async()=>{
    const incident=async(date)=>{await query('reset role');await query("insert into public.member_forms(user_id,template_key,status,answers,case_id) values($1,'grievance','submitted',jsonb_build_object('incident_date',$2::text),$3)",[ids.member,date,ids.case]);await actor();};
    const dueAt=async()=>(await query('select due_at from public.casework_deadlines where case_id=$1',[ids.case]))[0].due_at.toISOString();
    await incident('2026-11-02');
    await save(steps({kind:'business_days',count:10,from:'incident'}));await advance('intake','review');
    expect(await dueAt()).toBe('2026-11-17T04:59:59.000Z');
    await query('rollback to savepoint test_case');await query('savepoint test_case');await actor();
    await incident('2026-11-02');
    await save(steps({kind:'calendar_days',count:14,from:'incident'}));await advance('intake','review');
    expect(await dueAt()).toBe('2026-11-17T04:59:59.000Z');
    await query('rollback to savepoint test_case');await query('savepoint test_case');await actor();
    // Filed Friday 9 PM Eastern (Saturday 02:00 UTC): the count starts Friday.
    await query('reset role');await query("update public.member_cases set created_at='2026-11-07 02:00+00' where id=$1",[ids.case]);await actor();
    await save(steps({kind:'business_days',count:5,from:'filing'}));await advance('intake','review');
    expect(await dueAt()).toBe('2026-11-14T04:59:59.000Z');
    await query('rollback to savepoint test_case');await query('savepoint test_case');await actor();
    await save(steps({kind:'calendar_days',count:3,from:'step_entry'}));await advance('intake','review');
    const [entry]=await query("select ((((now() at time zone 'America/New_York')::date + 3) + time '23:59:59') at time zone 'America/New_York') expected");
    expect(await dueAt()).toBe(entry.expected.toISOString());
    await query('reset role');
    const [direct]=await query("select private.casework_add_business_days('2026-11-07 02:00+00',5,$1,'America/New_York') friday_evening,private.casework_add_business_days('2026-11-02 05:00+00',10,$1,'America/New_York') incident",[ids.org]);
    expect(direct.friday_evening.toISOString()).toBe('2026-11-14T04:59:59.000Z');expect(direct.incident.toISOString()).toBe('2026-11-17T04:59:59.000Z');
  });
  it('lets the default missed sweep (grace 0) wait for the end of the Eastern due day',async()=>{
    const eastern=async(offset)=>(await query("select ((now() at time zone 'America/New_York')::date + $1::int)::text due_day",[offset]))[0].due_day;
    await query('reset role');
    await query("update public.casework_deadlines set status='met' where status in ('active','extended') and due_at < now() + interval '30 days'");
    await query("insert into public.member_forms(user_id,template_key,status,answers,case_id) values($1,'grievance','submitted',jsonb_build_object('incident_date',$2::text),$3)",[ids.member,await eastern(-1),ids.case]);
    await actor();
    await save(steps({kind:'calendar_days',count:1,from:'incident'}));await advance('intake','review');
    await query('reset role');
    const [today]=await query("select id,status,(due_at at time zone 'America/New_York')::date::text due_day,(due_at at time zone 'America/New_York')::time::text at_time from public.casework_deadlines where case_id=$1",[ids.case]);
    expect(today).toMatchObject({status:'active',due_day:await eastern(0),at_time:'23:59:59'});
    await query('select private.casework_sweep_deadline_reminders(200)');
    expect((await query('select status from public.casework_deadlines where id=$1',[today.id]))[0].status).toBe('active');
    await query("update public.casework_deadlines set due_at=due_at - interval '1 day' where id=$1",[today.id]);
    await query('select private.casework_sweep_deadline_reminders(200)');
    expect((await query('select status from public.casework_deadlines where id=$1',[today.id]))[0].status).toBe('missed');
  });
  it('refuses skips, creates an entered-step deadline/checklist once, and stops at terminal',async()=>{
    await save(steps({kind:'business_days',count:1,from:'filing'}));
    await query('select public.casework_set_holidays($1)',[JSON.stringify([{holiday_date:'2026-09-21',label:'Organization holiday'}])]);
    await query("select public.casework_create_checklist_template('lane51-a','Grievance','review','Evidence checklist','[{\"label\":\"Review evidence\",\"required\":true}]')");
    await fails("select public.casework_advance_step($1,'intake','finish','Skipped',$2)",[ids.case,randomUUID()]);
    const key=randomUUID();const transition=await advance('intake','review',key);expect((await advance('intake','review',key)).id).toBe(transition.id);
    const deadlines=await query('select kind,label,due_at from public.casework_deadlines where case_id=$1',[ids.case]);
    expect(deadlines).toHaveLength(1);expect(deadlines[0]).toMatchObject({kind:'procedure',label:'Review'});expect(deadlines[0].due_at.toISOString()).toBe('2026-09-23T03:59:59.000Z');
    expect(await query('select id from public.casework_checklists where case_id=$1',[ids.case])).toHaveLength(1);
    await advance('review','finish');await fails("select public.casework_advance_step($1,'finish','review','Backwards',$2)",[ids.case,randomUUID()]);
    expect(await query('select id from public.casework_deadlines where case_id=$1',[ids.case])).toHaveLength(1);
  });
  it('exposes the allowed successors per case and permits a terminal exit only where the step allows it',async()=>{
    const list=steps();list[0].allow_terminal_exit=true;list.splice(2,0,{key:'hearing',label:'Hearing',deadline_rule:noDeadline});
    await save(list);
    const resolved=(await query('select public.casework_get_case_procedure($1) result',[ids.case]))[0].result;
    expect(resolved.case_step).toBe('intake');expect(resolved.allowed_next_steps).toEqual(['review','finish']);
    expect(resolved.steps.map((step)=>step.allow_terminal_exit)).toEqual([true,false,false,false]);
    await fails("select public.casework_advance_step($1,'intake','hearing','Skipped',$2)",[ids.case,randomUUID()]);
    await advance('intake','review');
    expect((await query('select public.casework_get_case_procedure($1) result',[ids.case]))[0].result.allowed_next_steps).toEqual(['hearing']);
    await fails("select public.casework_advance_step($1,'review','finish','No exit here',$2)",[ids.case,randomUUID()]);
    await advance('review','hearing');await advance('hearing','finish');
    expect((await query('select public.casework_get_case_procedure($1) result',[ids.case]))[0].result.allowed_next_steps).toEqual([]);
    await query('rollback to savepoint test_case');await query('savepoint test_case');await actor();
    await save(list);await advance('intake','finish');
    expect((await query('select step from public.member_cases where id=$1',[ids.case]))[0].step).toBe('finish');
  });
  it('requires configured checklist completion and a real incident anchor',async()=>{
    const list=steps();list[0].requires_checklist=true;list[1].deadline_rule={kind:'calendar_days',count:2,from:'incident'};
    const saved=await save(list);
    await fails("select public.casework_advance_step($1,'intake','review','Outcome',$2)",[ids.case,randomUUID()]);
    list[0].requires_checklist=false;await save(list,null,null,saved);
    await fails("select public.casework_advance_step($1,'intake','review','Outcome',$2)",[ids.case,randomUUID()]);
    expect((await query('select step from public.member_cases where id=$1',[ids.case]))[0].step).toBe('intake');
  });
  it('refuses cross-organization configuration, low assurance, members writing, and direct step bypass',async()=>{
    await save();
    await fails("select public.casework_save_procedure(null,'lane51-b',null,'Foreign',$1,null)",[JSON.stringify(steps())],'P0002');
    await actor(ids.member,'aal1');
    await fails("update public.member_cases set step='finish' where id=$1",[ids.case],'42501');
    await actor(ids.staff,'aal1');await fails('select public.casework_list_procedures()',[],'42501');
    await actor(ids.member,'aal1');await fails('select public.casework_set_holidays($1)', ['[]'],'42501');
    await fails('select public.casework_get_case_procedure($1)',[ids.caseB],'P0002');
  });
  it('refuses a chapter-hat coordinator without an organization role grant with a distinct 42501, not an MFA refusal',async()=>{
    await actor(ids.chapterHat);
    for(const [sql,values] of [['select public.casework_list_procedures()',[]],['select public.casework_set_holidays($1)',['[]']],
      ['select public.casework_save_procedure(null,null,null,$1,$2,null)',['Chapter hat',JSON.stringify(steps())]]]) {
      await query('savepoint refusal');
      try { await expect(db.query(sql,values)).rejects.toMatchObject({code:'42501',message:'organization not found'}); }
      finally { await query('rollback to savepoint refusal'); }
    }
    await actor();
    expect((await query('select public.casework_list_procedures() result'))[0].result).toMatchObject({procedures:[],holidays:[]});
  });
  it('preserves free text when unconfigured and prevents coordinator raw step writes',async()=>{
    await advance('intake','Custom legacy stage');
    await query("select public.coordinator_update_case($1,'active',null,null,'Status unchanged')",[ids.case]);
    expect((await query('select step from public.member_cases where id=$1',[ids.case]))[0].step).toBe('Custom legacy stage');
    await fails("select public.coordinator_update_case($1,'active','Raw bypass',null,'Invalid change')",[ids.case]);
  });
  it('allows exactly own-member progress reads with no staff alerts or peer progress',async()=>{
    await save(steps({kind:'calendar_days',count:2,from:'filing'}));await advance('intake','review');
    await actor(ids.member,'aal1');
    expect(await query('select id from public.casework_deadlines where case_id=$1',[ids.case])).toHaveLength(1);
    expect(await query('select id from public.casework_step_transitions where case_id=$1',[ids.case])).toHaveLength(1);
    expect(await query('select id from public.casework_deadlines where case_id=$1',[ids.caseB])).toHaveLength(0);
    await fails("insert into public.casework_step_transitions(case_id) values($1)",[ids.case],'42501');
  });
  it('has retired W2 objects, current manifest, RLS, and exact RPC grants',async()=>{
    await query('reset role');
    for(const table of ['case_deadline_changes','case_deadline_audit','case_checklist_progress','case_step_transitions','case_generated_work','case_restrictions','case_restriction_access','case_alerts','case_alert_acknowledgements','case_reminders']) {
      expect((await query('select to_regclass($1) relation',['public.'+table]))[0].relation).toBeNull();
      expect(await query('select 1 from private.account_lifecycle_manifest where table_name=$1',[table])).toHaveLength(0);
    }
    expect((await query("select count(*)::int n from pg_class where relname=any($1) and relrowsecurity",[['casework_procedures','casework_procedure_steps','organization_holidays']]))[0].n).toBe(3);
    expect(await query("select delete_disposition from private.account_lifecycle_manifest where schema_name='public' and table_name='casework_procedures' and user_column='created_by'")).toEqual([{delete_disposition:'pseudonymize'}]);
    expect((await query("select to_regprocedure('public.advance_case_step(uuid,text)') fn"))[0].fn).toBeNull();
    for(const signature of ['casework_save_procedure(uuid,text,text,text,jsonb,integer)','casework_list_procedures()','casework_get_case_procedure(uuid)','casework_set_holidays(jsonb)']) {
      const row=(await query("select has_function_privilege('anon',$1,'EXECUTE') anon,has_function_privilege('authenticated',$1,'EXECUTE') authenticated,has_function_privilege('service_role',$1,'EXECUTE') service",['public.'+signature]))[0];
      expect(row).toEqual({anon:false,authenticated:true,service:false});
    }
  });
});
