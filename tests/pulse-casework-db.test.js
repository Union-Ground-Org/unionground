// @vitest-environment node
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {sourceTransactionProblem} from '../scripts/hosted-migration-apply-runner.mjs';
import {assertDisposableProofUrl} from '../scripts/run-required-db-proofs.mjs';

const MIGRATION='supabase/migrations/20261123141000_pulse_casework_reads.sql';
const CASEWORK_KEYS=['ready:open-overdue','ready:resolution-rate','ready:days-to-resolve','ready:casework'];

it('can rehearse the complete migration through the hosted transaction parser',()=>{
  expect(sourceTransactionProblem(readFileSync(MIGRATION,'utf8'))).toBeNull();
});

it('reads no mutable clock, temporary table, case content or identity into a payload',()=>{
  const sql=readFileSync(MIGRATION,'utf8');
  const code=sql.replace(/--.*$/gm,'');
  expect(code).not.toMatch(/updated_at|recorded_at\s+from\s+public\.member_case_outcomes|member_case_outcomes/);
  expect(code).not.toMatch(/temporary|temp\s+table/i);
  for(const column of ['title','description','remedy_sought','reference','steward_name','coordinator_name','label'])
    expect(code).not.toMatch(new RegExp(`\\bc\\.${column}\\b|\\bd\\.${column}\\b`));
  // People leave a read only as privacy groups handed to the release guard.
  expect(code).toContain("private.pulse_release_safe(org");
});

const live=process.env.SUPABASE_DB_URL?describe:describe.skip;
live('Pulse Casework charts on an owned rollback database',()=>{
  let db,org,foreignOrg,chapter,foreignChapter,admin,steward,member,foreign,people,outsiders,unitA,unitB,procedure;
  const sessions=new Map();
  let reference=0;
  async function fixture(sql,args=[]){
    await db.query('savepoint fixture_write');
    await db.query('set local session_replication_role=replica');
    try{return await db.query(sql,args);}
    catch(error){await db.query('rollback to savepoint fixture_write');throw error;}
    finally{await db.query('set local session_replication_role=origin');}
  }
  async function as(user,sql,args=[],aal='aal2'){
    await db.query('savepoint request');
    try{
      await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user,role:'authenticated',aal,session_id:sessions.get(user)})]);
      await db.query('set local role authenticated');
      const result=(await db.query(sql,args)).rows[0]?.v;
      await db.query('reset role');await db.query('release savepoint request');return result;
    }catch(error){await db.query('rollback to savepoint request');throw error;}
  }
  // Each read names the chapter its screen shows; the foreign admin's screen shows the foreign chapter.
  const read=(name,user=steward,chapterID=user===foreign?foreignChapter:chapter)=>as(user,`select public.${name}($1) v`,[chapterID]);
  const options=(user)=>as(user,'select public.pulse_ready_chart_options() v');
  // Noon Eastern on a day counted from this Eastern week's Monday.
  async function eastern(day){
    return (await db.query("select (((date_trunc('week', now() at time zone 'America/New_York')::date + $1::int)::timestamp + time '12:00') at time zone 'America/New_York')::text v",[day])).rows[0].v;
  }
  // One case. intake/resolved are Eastern day offsets from this week's Monday;
  // history:false leaves out the INSERT version (a case older than the history).
  async function grievance(owner,{intake=-3,resolved=null,open=resolved===null,overdue=false,dateOnly=null,structured=null,history=true,chapterID=chapter,orgID=org,caseType='Pay'}={}){
    const id=randomUUID();
    await fixture("insert into public.member_cases(id,user_id,reference,title,case_type,status,organization_id,chapter_id,deadline) values($1,$2,$3,'Private case title',$4,$5,$6,$7,$8)",
      [id,owner,`PC-${++reference}`,caseType,open?'active':'resolved',orgID,chapterID,dateOnly??(overdue?'2000-01-03':null)]);
    if(history)await fixture("insert into private.casework_record_versions(case_id,organization_id,chapter_id,record_table,record_id,op,old_row,new_row,at) values($1::uuid,$2,$3,'member_cases',$1::text,'INSERT',null,'{\"status\":\"active\",\"title\":\"Private case title\"}',$4::timestamptz)",[id,orgID,chapterID,await eastern(intake)]);
    if(resolved!==null)await fixture("insert into private.casework_record_versions(case_id,organization_id,chapter_id,record_table,record_id,op,old_row,new_row,at) values($1::uuid,$2,$3,'member_cases',$1::text,'UPDATE','{\"status\":\"active\"}','{\"status\":\"resolved\"}',$4::timestamptz)",[id,orgID,chapterID,await eastern(resolved)]);
    if(structured)await fixture("insert into public.casework_deadlines(case_id,organization_id,chapter_id,kind,label,due_at,status,created_by) values($1,$2,$3,'filing','Private deadline label',now()+($4||' days')::interval,$5,$6)",[id,orgID,chapterID,String(structured.days),structured.status,admin]);
    return id;
  }
  const many=(owners,options)=>Promise.all(owners.map(owner=>grievance(owner,options)));
  // perOwner resolved cases for each owner in one statement (intake and first resolution recorded).
  async function bulk(owners,perOwner,{intake,resolved,tag}){
    await fixture(`with made as (
        insert into public.member_cases(id,user_id,reference,title,case_type,status,organization_id,chapter_id)
        select extensions.gen_random_uuid(),o,'PB-'||$5||'-'||o::text||'-'||n,'Private case title','Pay','resolved',$2,$3
        from unnest($1::uuid[]) o cross join generate_series(1,$4::int) n returning id)
      insert into private.casework_record_versions(case_id,organization_id,chapter_id,record_table,record_id,op,old_row,new_row,at)
      select id,$2,$3,'member_cases',id::text,'INSERT',null,'{"status":"active"}'::jsonb,$6::timestamptz from made
      union all select id,$2,$3,'member_cases',id::text,'UPDATE','{"status":"active"}'::jsonb,'{"status":"resolved"}'::jsonb,$7::timestamptz from made`,
      [owners,org,chapter,perOwner,tag,await eastern(intake),await eastern(resolved)]);
  }
  async function floor(value){
    await fixture("insert into public.organization_setting_values(organization_id,setting_key,value,updated_by) values($1,'limits.analytics.anonymity_floor',$2::jsonb,$3) on conflict(organization_id,setting_key) do update set value=excluded.value",[org,JSON.stringify(value),admin]);
  }
  const unitPeople=()=>people.slice(0,50);
  beforeAll(async()=>{
    db=new pg.Client({connectionString:assertDisposableProofUrl(process.env.SUPABASE_DB_URL),application_name:'pulse-casework-rollback-proof'});
    await db.connect();await db.query('begin');await db.query("set local statement_timeout='60s'");
    org=randomUUID();foreignOrg=randomUUID();chapter='pulse-three-'+org;foreignChapter='pulse-three-'+foreignOrg;
    [admin,steward,member,foreign]=Array.from({length:4},()=>randomUUID());
    people=Array.from({length:100},()=>randomUUID());outsiders=Array.from({length:30},()=>randomUUID());
    const users=[admin,steward,member,foreign,...people,...outsiders];
    const abroad=new Set([foreign,...outsiders]);
    await db.query("insert into auth.users(id,email) select id,id::text||'@example.invalid' from unnest($1::uuid[]) id",[users]);
    await fixture("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Tamarack casework proof'),($2::uuid,$2::text,'Tamarack isolated casework proof')",[org,foreignOrg]);
    await fixture('insert into public.chapters(id,slug,name,organization_id,order_index) values($1,$1,$1,$2,997901),($3,$3,$3,$4,997902)',[chapter,org,foreignChapter,foreignOrg]);
    await fixture('update public.member_profiles set chapter_id=case when id=any($2::uuid[]) then $4 else $3 end where id=any($1::uuid[])',[users,[...abroad],chapter,foreignChapter]);
    await fixture("insert into public.organization_memberships(organization_id,user_id,status) select case when id=any($2::uuid[]) then $4::uuid else $3::uuid end,id,'active' from unnest($1::uuid[]) id on conflict do nothing",[users,[...abroad],org,foreignOrg]);
    await fixture("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) select id,case when id=any($2::uuid[]) then $4 else $3 end,'active',true,now() from unnest($1::uuid[]) id on conflict(user_id,chapter_id) do update set status='active',pinned=true,last_selected_at=now()",[users,[...abroad],chapter,foreignChapter]);
    await fixture("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2),($3,$4,'admin',$4)",[org,admin,foreignOrg,foreign]);
    unitA=randomUUID();unitB=randomUUID();
    await fixture("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$3,$4,'A'),($2,$3,$4,'B')",[unitA,unitB,org,chapter]);
    await fixture('insert into private.chapter_unit_members(unit_id,chapter_id,user_id) select case when n<=50 then $1::uuid else $2::uuid end,$3,u from unnest($4::uuid[]) with ordinality x(u,n)',[unitA,unitB,chapter,people]);
    for(const user of [admin,steward,member,foreign]){
      const session=randomUUID();sessions.set(user,session);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())",[session,user]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())",[randomUUID(),user]);
    }
    await as(admin,"select public.set_member_access_role($1,$2,'steward',true,$3,null) v",[steward,chapter,unitA]);
    procedure=randomUUID();
    await fixture("insert into public.casework_procedures(id,organization_id,chapter_id,case_type,name,created_by) values($1,$2,null,null,'Grievance procedure',$3),($4,$5,null,null,'Grievance procedure',$6)",[procedure,org,admin,randomUUID(),foreignOrg,foreign]);
  },120000);
  beforeEach(async()=>{await db.query('savepoint scenario');});
  afterEach(async()=>{await db.query('reset role');await db.query('rollback to savepoint scenario');});
  afterAll(async()=>{if(db){await db.query('rollback');await db.end();}});

  it('offers the Casework group only to chapter case staff, and refuses members and other organizations alike',async()=>{
    for(const user of [admin,steward]){
      const offered=(await options(user)).filter(o=>o.group==='Casework');
      expect(offered.map(o=>o.key)).toEqual(CASEWORK_KEYS);
      expect(offered.map(o=>o.read)).toEqual(['get_pulse_open_overdue','get_pulse_resolution_rate','get_pulse_days_to_resolve','get_pulse_casework']);
    }
    for(const key of CASEWORK_KEYS)expect((await options(member)).map(o=>o.key)).not.toContain(key);
    await many(unitPeople().slice(0,25));
    for(const name of ['get_pulse_open_overdue','get_pulse_resolution_rate','get_pulse_days_to_resolve','get_pulse_casework']){
      expect(await read(name,member)).toEqual({state:'unavailable'});
      expect(await read(name,foreign)).toEqual(name==='get_pulse_open_overdue'?{state:'no_eligible_records',open:0,overdue:0,resolvedThisMonth:0,monthStart:expect.any(String),inReview:{state:'unavailable',reason:'no_review_stage_mapping'}}:expect.objectContaining({state:'ready'}));
      expect(await as(steward,`select public.${name}($1) v`,[chapter],'aal1')).toEqual({state:'unavailable'});
    }
    // The foreign admin counts nothing of this organization.
    expect((await read('get_pulse_casework',foreign)).weeks.every(w=>w.opened===0)).toBe(true);
  });

  it('puts the Casework keys in a staff layout, never a member layout, and lets staff save them',async()=>{
    const staffLayout=await as(steward,"select public.get_pulse_layout($1,'steward') v",[chapter]);
    expect(staffLayout.options).toEqual(expect.arrayContaining(CASEWORK_KEYS));
    const memberLayout=await as(member,"select public.get_pulse_layout($1,'member') v",[chapter]);
    for(const key of CASEWORK_KEYS)expect(memberLayout.options).not.toContain(key);
    await as(steward,"select public.save_pulse_layout($1,$2::jsonb,'steward') v",[chapter,JSON.stringify([{key:'ready:open-overdue',pinned:true}])]);
    expect((await as(steward,"select public.get_pulse_layout($1,'steward') v",[chapter])).entries).toEqual([{key:'ready:open-overdue',pinned:true}]);
    await expect(as(member,"select public.save_pulse_layout($1,$2::jsonb,'member') v",[chapter,JSON.stringify([{key:'ready:open-overdue',pinned:false}])])).rejects.toMatchObject({code:'42501'});
  });

  it('says a chapter with no grievance procedure is unavailable, never zero, and counts no generic case',async()=>{
    await many(unitPeople().slice(0,25),{overdue:true});
    await fixture('update public.casework_procedures set active=false where id=$1',[procedure]);
    for(const name of ['get_pulse_open_overdue','get_pulse_resolution_rate','get_pulse_days_to_resolve','get_pulse_casework'])
      expect(await read(name)).toEqual({state:'unavailable',reason:'no_grievance_procedure'});
    // A procedure for one case type maps only that type.
    await fixture("insert into public.casework_procedures(organization_id,chapter_id,case_type,name,created_by) values($1,$2,'Safety','Safety grievance procedure',$3)",[org,chapter,admin]);
    expect(await read('get_pulse_open_overdue')).toMatchObject({state:'no_eligible_records',open:0});
  });

  it('withholds open and overdue one person under the floor and shows it at the floor, counting cases for the measure',async()=>{
    const owners=unitPeople().slice(0,24);
    await many(owners,{overdue:true});
    const hidden=await read('get_pulse_open_overdue');
    expect(hidden).toMatchObject({state:'withheld',open:null,overdue:null,resolvedThisMonth:null});
    expect(hidden).not.toHaveProperty('historyComplete');
    await grievance(people[24],{overdue:true});
    const shown=await read('get_pulse_open_overdue');
    expect(shown).toMatchObject({state:'ready',open:25,overdue:25,resolvedThisMonth:0,inReview:{state:'unavailable',reason:'no_review_stage_mapping'}});
    expect(JSON.stringify(shown)).not.toMatch(new RegExp([...owners,steward].join('|')));
    expect(JSON.stringify(shown)).not.toContain('Private');
  });

  it('withholds the related figures together when a remainder would reveal a small group',async()=>{
    await many(unitPeople().slice(0,25),{overdue:true});
    await grievance(people[25]);
    // 26 open, 25 overdue: the one on-time case would be open minus overdue.
    expect(await read('get_pulse_open_overdue')).toMatchObject({state:'withheld',open:null,overdue:null});
  });

  it('counts only the steward unit, never a neighbour unit or a neighbour organization',async()=>{
    await many(people.slice(50,75),{overdue:true});
    await many(outsiders.slice(0,25),{overdue:true,chapterID:foreignChapter,orgID:foreignOrg});
    expect(await read('get_pulse_open_overdue')).toMatchObject({state:'no_eligible_records',open:0,overdue:0});
    await many(unitPeople().slice(0,25),{overdue:true});
    expect(await read('get_pulse_open_overdue')).toMatchObject({state:'ready',open:25,overdue:25});
  });

  it('calls a case overdue from a current structured deadline first, and from a date-only deadline only without one',async()=>{
    const owners=unitPeople();
    await many(owners.slice(0,25),{structured:{days:-1,status:'missed'}});
    await many(owners.slice(25,50),{dateOnly:'2000-01-03',structured:{days:-1,status:'met'}});
    expect(await read('get_pulse_open_overdue')).toMatchObject({state:'ready',open:50,overdue:25});
  });

  it('counts a deadline the sweep marked missed as overdue before its moment, as the steward deadline list does',async()=>{
    await many(unitPeople().slice(0,25),{structured:{days:2,status:'missed'}});
    await many(unitPeople().slice(25,50),{structured:{days:2,status:'active'}});
    expect(await read('get_pulse_open_overdue')).toMatchObject({state:'ready',open:50,overdue:25});
  });

  it('binds each read to the chapter its screen names: another chapter, even one the caller staffs, is refused unless selected',async()=>{
    const second='pulse-three-b-'+org;
    await fixture('insert into public.chapters(id,slug,name,organization_id,order_index) values($1,$1,$1,$2,997903)',[second,org]);
    await fixture("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now()) on conflict(user_id,chapter_id) do update set status='active'",[admin,second]);
    await many(unitPeople().slice(0,25),{overdue:true});
    // The organization admin staffs both chapters; the selection is the first.
    expect((await read('get_pulse_open_overdue',admin,chapter)).state).not.toBe('unavailable');
    for(const name of ['get_pulse_open_overdue','get_pulse_resolution_rate','get_pulse_days_to_resolve','get_pulse_casework']){
      expect(await read(name,admin,second)).toEqual({state:'unavailable'});
      expect(await read(name,steward,foreignChapter)).toEqual({state:'unavailable'});
      expect(await read(name,steward,null)).toEqual({state:'unavailable'});
    }
    // The selection moves to the second chapter: a read still naming the first is refused.
    await fixture('update public.member_profiles set chapter_id=$2 where id=$1',[admin,second]);
    expect(await read('get_pulse_open_overdue',admin,chapter)).toEqual({state:'unavailable'});
    expect(await read('get_pulse_open_overdue',admin,second)).toMatchObject({state:'no_eligible_records',open:0});
  });

  it('keeps resolved this month on a recorded resolution event, and marks cases older than the history',async()=>{
    // Month starts on the 1st; "this week" days 0..6 may straddle it, so resolve today.
    const today=Number((await db.query("select (now() at time zone 'America/New_York')::date - date_trunc('week', now() at time zone 'America/New_York')::date v")).rows[0].v);
    await many(unitPeople().slice(0,25),{intake:today-20,resolved:today});
    await many(unitPeople().slice(25,50).filter((person)=>person!==people[26]),{overdue:true});
    await grievance(people[26],{history:false,overdue:true});
    const result=await read('get_pulse_open_overdue');
    // The old case is not counted as resolved and no flag says it exists.
    expect(result).toMatchObject({state:'ready',open:25,overdue:25,resolvedThisMonth:25});
    expect(result).not.toHaveProperty('historyComplete');
  });

  it('rates resolution within sixty days per completed week, withholding a week one under the floor',async()=>{
    const owners=unitPeople();
    // Sixtieth day of these intakes falls on last week's Monday (week -7).
    await many(owners.slice(0,24),{intake:-67,resolved:-60});
    await many(owners.slice(25,49),{intake:-67});
    // A late resolution (day 61) still counts in the cohort, as not resolved in time.
    await grievance(owners[49],{intake:-67,resolved:-6});
    let rate=await read('get_pulse_resolution_rate');
    expect(rate.weeks).toHaveLength(8);
    expect(rate.weeks[7]).toMatchObject({state:'withheld',cohort:null,resolved:null,percentage:null});
    expect(rate.weeks.slice(0,7).every(w=>w.state==='no_eligible_records'&&w.percentage===null)).toBe(true);
    await grievance(owners[24],{intake:-67,resolved:-62});
    rate=await read('get_pulse_resolution_rate');
    expect(rate.weeks[7]).toMatchObject({state:'ready',cohort:50,resolved:25,percentage:50});
    expect(rate).toMatchObject({state:'ready',days:60});
    expect(rate).not.toHaveProperty('historyComplete');
    expect(rate).not.toHaveProperty('total');
  });

  it('averages days to a first resolution per week, withholding a week one under the floor, with no comparison across gaps',async()=>{
    const owners=unitPeople();
    await many(owners.slice(0,24),{intake:-17,resolved:-7});
    let days=await read('get_pulse_days_to_resolve');
    expect(days.weeks[7]).toMatchObject({state:'withheld',resolved:null,meanDays:null});
    expect(days.comparison).toBeNull();
    await grievance(owners[24],{intake:-17,resolved:-7});
    days=await read('get_pulse_days_to_resolve');
    expect(days.weeks[7]).toMatchObject({state:'ready',resolved:25,meanDays:10});
    expect(days.comparison).toBeNull();
    // Reopened and resolved again: only the first resolution counts.
    const again=await grievance(owners[25],{intake:-27,resolved:-14});
    await fixture("insert into private.casework_record_versions(case_id,organization_id,chapter_id,record_table,record_id,op,old_row,new_row,at) values($1::uuid,$2,$3,'member_cases',$1::text,'UPDATE','{\"status\":\"active\"}','{\"status\":\"resolved\"}',$4::timestamptz)",[again,org,chapter,await eastern(-7)]);
    days=await read('get_pulse_days_to_resolve');
    expect(days.weeks[6]).toMatchObject({state:'withheld'});
    expect(days.weeks[7]).toMatchObject({state:'ready',resolved:25});
  });

  it('withholds a mean when a week loses one case as another arrives for the same person (Grok pre-final, mechanism A)',async()=>{
    const owners=unitPeople().slice(0,25);
    const first=await Promise.all(owners.map(owner=>grievance(owner,{intake:-17,resolved:-7})));
    expect((await read('get_pulse_days_to_resolve')).weeks[7]).toMatchObject({state:'ready',resolved:25,meanDays:10});
    // Same people, same count per person, a different case with another day count.
    await fixture('delete from public.member_cases where id=$1',[first[0]]);
    await grievance(owners[0],{intake:-37,resolved:-7});
    expect((await read('get_pulse_days_to_resolve')).weeks[7]).toMatchObject({state:'withheld',resolved:null,meanDays:null});
  });

  it('withholds a mean when one owner swaps the floor of their cases for others with another day total (final r3s1, r4s1)',async()=>{
    const owners=unitPeople().slice(0,25);
    await bulk(owners,25,{intake:-17,resolved:-7,tag:'a'});
    expect((await read('get_pulse_days_to_resolve')).weeks[7]).toMatchObject({state:'ready',resolved:625,meanDays:10});
    // One owner's 25 cases leave and 25 others arrive: the case count per owner and
    // the number of changed cases both stay at or above the floor, but the mean
    // would move by that one owner's day total.
    await fixture('delete from public.member_cases where user_id=$1 and organization_id=$2',[owners[0],org]);
    await bulk([owners[0]],25,{intake:-27,resolved:-7,tag:'b'});
    expect((await read('get_pulse_days_to_resolve')).weeks[7]).toMatchObject({state:'withheld',resolved:null,meanDays:null});
  });

  it('withholds a first release in which one owner gives a different day total (final r3s1, r4s1)',async()=>{
    await many(unitPeople().slice(0,25),{intake:-17,resolved:-7});
    await grievance(people[25],{intake:-27,resolved:-7});
    expect((await read('get_pulse_days_to_resolve')).weeks[7]).toMatchObject({state:'withheld',meanDays:null});
  });

  it('leaves a case reopened after its first resolution out of the days-to-resolve mean (Grok pre-final P2)',async()=>{
    const owners=unitPeople().slice(0,26);
    await many(owners.slice(0,25),{intake:-17,resolved:-7});
    await grievance(owners[25],{intake:-37,resolved:-7,open:true});
    expect((await read('get_pulse_days_to_resolve')).weeks[7]).toMatchObject({state:'ready',resolved:25,meanDays:10});
  });

  it('compares earlier and later weeks only when every week is released',async()=>{
    const owners=unitPeople().slice(0,25);
    for(let ago=8;ago>=1;ago--)await many(owners,{intake:-7*ago-(ago>4?20:10),resolved:-7*ago});
    const days=await read('get_pulse_days_to_resolve');
    expect(days.weeks.every(w=>w.state==='ready'&&w.resolved===25)).toBe(true);
    expect(days.comparison).toEqual({earlierMeanDays:20,laterMeanDays:10});
  });

  it('releases weekly opened and resolved together, and the cohort status only when no week is withheld',async()=>{
    const owners=unitPeople();
    await many(owners.slice(0,24),{intake:-5});
    let casework=await read('get_pulse_casework');
    expect(casework.weeks[7]).toMatchObject({state:'withheld',opened:null,resolved:null});
    expect(casework.weeks.slice(0,7).every(w=>w.state==='ready'&&w.opened===0&&w.resolved===0)).toBe(true);
    // The cohort total would equal the weeks' sum and reveal the withheld week.
    expect(casework.status).toMatchObject({state:'withheld',open:null,resolved:null});
    expect(casework.tags).toEqual({state:'unavailable',reason:'no_approved_taxonomy'});
    await grievance(owners[24],{intake:-6});
    casework=await read('get_pulse_casework');
    expect(casework.weeks[7]).toMatchObject({state:'ready',opened:25,resolved:0});
    expect(casework.status).toMatchObject({state:'ready',open:25,resolved:0});
    expect(casework).not.toHaveProperty('historyComplete');
  });

  it('withholds what was shown once the organization raises its floor',async()=>{
    await many(unitPeople().slice(0,25),{overdue:true});
    expect((await read('get_pulse_open_overdue')).state).toBe('ready');
    await floor(30);
    expect(await read('get_pulse_open_overdue')).toMatchObject({state:'withheld',open:null});
  });

  it('does not disclose a one-person change on refresh',async()=>{
    await many(unitPeople().slice(0,25),{overdue:true});
    expect((await read('get_pulse_open_overdue')).open).toBe(25);
    await grievance(people[25],{overdue:true});
    expect(await read('get_pulse_open_overdue')).toMatchObject({state:'withheld',open:null});
  });

  it('counts cases for the measure but never releases a change one person made (r1s1, r2s1)',async()=>{
    const owners=unitPeople().slice(0,25);
    await many(owners);
    expect(await read('get_pulse_open_overdue')).toMatchObject({state:'ready',open:25,overdue:0});
    // A second on-time case for a person already counted: 25 -> 26 would show one person's change.
    await grievance(owners[0]);
    expect(await read('get_pulse_open_overdue')).toMatchObject({state:'withheld',open:null,overdue:null});
    // The same for an overdue chart and for a person whose case leaves.
    await fixture('delete from public.member_cases where user_id=$1 and organization_id=$2',[owners[0],org]);
    expect(await read('get_pulse_open_overdue')).toMatchObject({state:'withheld',open:null});
    await many(owners.slice(1));await grievance(owners[0]);await grievance(owners[0]);
    // The floor of people moving together from one case to two is a release.
    expect(await read('get_pulse_open_overdue')).toMatchObject({state:'ready',open:50,overdue:0});
  });

  it('withholds a first release in which one person contributes a different number of cases (r1s1)',async()=>{
    await many(unitPeople().slice(0,25),{overdue:true});await grievance(people[0],{overdue:true});
    expect(await read('get_pulse_open_overdue')).toMatchObject({state:'withheld',open:null,overdue:null});
    await many(unitPeople().slice(0,25),{intake:-5});await grievance(people[0],{intake:-4});
    expect((await read('get_pulse_casework')).weeks[7]).toMatchObject({state:'withheld',opened:null});
  });

  it('admits staff by their grant for the selected chapter, not the legacy role row (r1s2)',async()=>{
    const second='pulse-three-c-'+org,coordinator=randomUUID(),session=randomUUID();
    await db.query("insert into auth.users(id,email) values($1::uuid,$1::text||'@example.invalid')",[coordinator]);
    await fixture('insert into public.chapters(id,slug,name,organization_id,order_index) values($1,$1,$1,$2,997904)',[second,org]);
    await fixture("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active') on conflict do nothing",[org,coordinator]);
    await fixture("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now()),($1,$3,'active',true,now()) on conflict(user_id,chapter_id) do update set status='active'",[coordinator,chapter,second]);
    // The legacy projection keeps the first chapter; the grants name both.
    await fixture("insert into public.member_roles(user_id,role,chapter_id) values($1,'coordinator',$2)",[coordinator,chapter]);
    await fixture("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'coordinator',$2),($1,'coordinator',$3)",[coordinator,chapter,second]);
    await fixture('update public.member_profiles set chapter_id=$2 where id=$1',[coordinator,second]);
    sessions.set(coordinator,session);
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())",[session,coordinator]);
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())",[randomUUID(),coordinator]);
    expect(await read('get_pulse_open_overdue',coordinator,second)).toMatchObject({state:'no_eligible_records',open:0});
    expect((await options(coordinator)).map(o=>o.key)).toEqual(expect.arrayContaining(CASEWORK_KEYS));
    // A chapter with no grant is still refused.
    await fixture('delete from public.member_role_chapters where user_id=$1 and chapter_id=$2',[coordinator,second]);
    expect(await read('get_pulse_open_overdue',coordinator,second)).toEqual({state:'unavailable'});
    // Grok pre-final P1: the grant in the chapter the legacy row still names is
    // revoked while another grant keeps that row; selecting it is refused, not zeros.
    await fixture("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'coordinator',$2)",[coordinator,second]);
    await fixture('delete from public.member_role_chapters where user_id=$1 and chapter_id=$2',[coordinator,chapter]);
    await fixture('update public.member_profiles set chapter_id=$2 where id=$1',[coordinator,chapter]);
    expect((await db.query("select chapter_id from public.member_roles where user_id=$1 and role='coordinator'",[coordinator])).rows[0].chapter_id).toBe(chapter);
    for(const name of ['get_pulse_open_overdue','get_pulse_resolution_rate','get_pulse_days_to_resolve','get_pulse_casework'])
      expect(await read(name,coordinator,chapter)).toEqual({state:'unavailable'});
    expect((await options(coordinator)).map(o=>o.key)).not.toContain('ready:open-overdue');
  });

  it('refuses chapter staff with no second factor where the organization requires staff MFA (r1s3)',async()=>{
    const unenrolled=randomUUID(),session=randomUUID();
    await db.query("insert into auth.users(id,email) values($1::uuid,$1::text||'@example.invalid')",[unenrolled]);
    await fixture("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active') on conflict do nothing",[org,unenrolled]);
    await fixture("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now()) on conflict(user_id,chapter_id) do update set status='active'",[unenrolled,chapter]);
    await fixture("insert into public.member_roles(user_id,role,chapter_id) values($1,'coordinator',$2)",[unenrolled,chapter]);
    await fixture("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'coordinator',$2)",[unenrolled,chapter]);
    await fixture('update public.member_profiles set chapter_id=$2 where id=$1',[unenrolled,chapter]);
    sessions.set(unenrolled,session);
    // An aal1 session with no verified factor passes the member MFA predicate, not the staff requirement.
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal1',now(),now())",[session,unenrolled]);
    await many(unitPeople().slice(0,25),{overdue:true});
    expect(await as(unenrolled,'select private.mfa_satisfied() v',[],'aal1').catch(()=>null)).not.toBe(false);
    for(const name of ['get_pulse_open_overdue','get_pulse_resolution_rate','get_pulse_days_to_resolve','get_pulse_casework'])
      expect(await as(unenrolled,`select public.${name}($1) v`,[chapter],'aal1')).toEqual({state:'unavailable'});
    expect((await as(unenrolled,'select public.pulse_ready_chart_options() v',[],'aal1')).map(o=>o.key)).not.toContain('ready:open-overdue');
    // The layout options either refuse the hat or offer no Casework key.
    const layout=await as(unenrolled,"select public.get_pulse_layout($1,'coordinator') v",[chapter],'aal1').catch(()=>({options:[]}));
    expect(layout.options).not.toContain('ready:open-overdue');
  });

  it('gives a platform organization no Casework option and no figures',async()=>{
    await many(unitPeople().slice(0,25),{overdue:true});
    await fixture("update public.organizations set kind='union' where kind='platform'");
    await fixture("update public.organizations set kind='platform' where id=$1",[org]);
    expect((await options(admin)).map(o=>o.key)).not.toContain('ready:open-overdue');
    expect(await read('get_pulse_open_overdue',admin)).toEqual({state:'unavailable'});
  });

  it('reads its clock from the trigger-captured case history that every case write feeds',async()=>{
    const {rows}=await db.query("select count(*)::int n from pg_trigger where tgrelid='public.member_cases'::regclass and tgname='casework_record_version' and not tgisinternal and tgenabled<>'D'");
    expect(rows[0].n).toBe(1);
    const grants=await db.query("select r,f,has_function_privilege(r,f,'EXECUTE') x from unnest(array['anon','authenticated','service_role']) r cross join unnest(array['private.pulse_casework_rows(uuid,text)','private.pulse_casework_allowed(uuid,text)','private.pulse_casework_procedure(uuid,text)','public.get_pulse_open_overdue(text)','public.get_pulse_resolution_rate(text)','public.get_pulse_days_to_resolve(text)','public.get_pulse_casework(text)']) f");
    for(const row of grants.rows)expect(row.x).toBe(row.r==='authenticated'&&row.f.startsWith('public.'));
  });
});
